'use strict';

const crypto = require('node:crypto');

const TOKEN_BYTES = 32;
const KEY_PREFIX = 'sess:';
const DEFAULT_IDLE_TTL_MS = 30 * 60 * 1000;
const DEFAULT_ABSOLUTE_TTL_MS = 8 * 60 * 60 * 1000;
const MAX_SET_ATTEMPTS = 4;

/*
 * The value in a session key is deliberately kept as JSON.  Renewal returns
 * the value it read, rather than reading it again after changing the expiry.
 * This makes the session and the TTL in a renewal response one atomic view.
 *
 * Redis TIME is used instead of the application clock here.  In particular,
 * a client whose clock is wrong cannot extend a session past its absolute
 * deadline.
 */
const RENEW_SCRIPT = String.raw`
local ok, raw = pcall(redis.call, 'GET', KEYS[1])
if not ok or type(raw) ~= 'string' then
  return {0}
end

local ttlOk, currentTtl = pcall(redis.call, 'PTTL', KEYS[1])
if not ttlOk or type(currentTtl) ~= 'number' or currentTtl <= 0 then
  return {0}
end

local decodedOk, session = pcall(cjson.decode, raw)
if not decodedOk or type(session) ~= 'table' then
  return {0}
end

if type(session.userId) ~= 'string' or string.len(session.userId) == 0 then
  return {0}
end
if type(session.deviceLabel) ~= 'string' or string.len(session.deviceLabel) == 0 then
  return {0}
end
if type(session.createdAt) ~= 'number' or session.createdAt ~= math.floor(session.createdAt) or session.createdAt <= 0 then
  return {0}
end
if type(session.absoluteExpiresAt) ~= 'number' or session.absoluteExpiresAt ~= math.floor(session.absoluteExpiresAt) or session.absoluteExpiresAt <= session.createdAt then
  return {0}
end

local idleTtl = tonumber(ARGV[1])
if not idleTtl or idleTtl <= 0 or idleTtl ~= math.floor(idleTtl) then
  return {0}
end

local clock = redis.call('TIME')
if type(clock) ~= 'table' or #clock < 2 then
  return {0}
end
local nowMs = (tonumber(clock[1]) * 1000) + math.floor(tonumber(clock[2]) / 1000)
if not nowMs then
  return {0}
end

local absoluteRemaining = session.absoluteExpiresAt - nowMs
if absoluteRemaining <= 0 then
  return {0}
end

local newTtl = math.min(idleTtl, absoluteRemaining)
if newTtl <= 0 or newTtl ~= math.floor(newTtl) then
  return {0}
end
if redis.call('PEXPIRE', KEYS[1], newTtl) ~= 1 then
  return {0}
end

return {1, raw, newTtl}
`;

function isSafePositiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function readTtlOption(options, names, defaultValue) {
  for (const name of names) {
    if (Object.prototype.hasOwnProperty.call(options, name)) {
      const value = options[name];
      if (!isSafePositiveInteger(value)) {
        throw new TypeError(`${name} must be a positive safe integer`);
      }
      return value;
    }
  }
  return defaultValue;
}

function tokenDigest(token) {
  if (typeof token !== 'string' || token.length === 0) return null;
  return crypto.createHash('sha256').update(token, 'utf8').digest('hex');
}

function sessionKey(token) {
  const digest = tokenDigest(token);
  return digest === null ? null : `${KEY_PREFIX}${digest}`;
}

function asUtf8String(value) {
  if (typeof value === 'string') return value;
  if (Buffer.isBuffer(value)) return value.toString('utf8');
  return null;
}

function asSafeInteger(value) {
  if (typeof value === 'bigint') {
    if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) return null;
    return Number(value);
  }
  if (typeof value === 'number') return Number.isSafeInteger(value) ? value : null;
  if (typeof value === 'string' && /^-?\d+$/.test(value)) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : null;
  }
  return null;
}

/**
 * Parse the single-key form of MGETTTL's reply.  MGETTTL replies with
 * [[value, ttlMs]], where -2 means missing and -1 means persistent.
 * Everything other than a present string with a positive integer TTL is
 * considered unusable.
 */
function parseMgetTtlReply(reply) {
  if (!Array.isArray(reply) || reply.length !== 1 || !Array.isArray(reply[0]) || reply[0].length !== 2) {
    return null;
  }

  const value = asUtf8String(reply[0][0]);
  const ttlMs = asSafeInteger(reply[0][1]);
  if (value === null || ttlMs === null || ttlMs <= 0) return null;
  return { value, ttlMs };
}

function parseSessionValue(value) {
  const json = asUtf8String(value);
  if (json === null || json.length === 0) return null;

  let session;
  try {
    session = JSON.parse(json);
  } catch (_error) {
    return null;
  }

  if (session === null || typeof session !== 'object' || Array.isArray(session)) return null;
  if (typeof session.userId !== 'string' || session.userId.length === 0) return null;
  if (typeof session.deviceLabel !== 'string' || session.deviceLabel.length === 0) return null;
  if (!isSafePositiveInteger(session.createdAt)) return null;
  if (!isSafePositiveInteger(session.absoluteExpiresAt) || session.absoluteExpiresAt <= session.createdAt) return null;
  return session;
}

function parseRenewReply(reply) {
  if (!Array.isArray(reply) || reply.length !== 3) return null;
  const status = asSafeInteger(reply[0]);
  const ttlMs = asSafeInteger(reply[2]);
  if (status !== 1 || ttlMs === null || ttlMs <= 0) return null;
  const session = parseSessionValue(reply[1]);
  return session === null ? null : { session, ttlMs };
}

function isClientLike(value) {
  return value !== null && typeof value === 'object' &&
    (typeof value.sendCommand === 'function' || typeof value.eval === 'function' ||
      typeof value.set === 'function' || typeof value.del === 'function');
}

class RedisSessionStore {
  constructor(redis, options = {}) {
    // Accept { client, idleTtlMs, absoluteTtlMs } as a convenience as well as
    // the usual (client, options) form.  This keeps construction easy to test.
    if (!isClientLike(redis) && redis && typeof redis === 'object' &&
        (redis.client || redis.redis || redis.redisClient)) {
      const wrapper = redis;
      redis = wrapper.client || wrapper.redis || wrapper.redisClient;
      options = { ...wrapper, ...options };
    }
    if (!isClientLike(redis)) {
      throw new TypeError('a node-redis client is required');
    }
    if (options === null || typeof options !== 'object') {
      throw new TypeError('options must be an object');
    }

    this.redis = redis;
    // `client` is an intentionally boring alias useful to callers that pass
    // the store through code written against the SessionStore interface.
    this.client = redis;
    this.idleTtlMs = readTtlOption(options, [
      'idleTtlMs', 'idleTTLms', 'idleTtl', 'idleTTL', 'idleTimeoutMs',
    ], DEFAULT_IDLE_TTL_MS);
    this.absoluteTtlMs = readTtlOption(options, [
      'absoluteTtlMs', 'absoluteTTLms', 'absoluteTtl', 'absoluteTTL',
      'absoluteLifetimeMs',
    ], DEFAULT_ABSOLUTE_TTL_MS);
  }

  async createSession({ userId, deviceLabel } = {}) {
    if (typeof userId !== 'string' || userId.length === 0) {
      throw new TypeError('userId must be a non-empty string');
    }
    if (typeof deviceLabel !== 'string' || deviceLabel.length === 0) {
      throw new TypeError('deviceLabel must be a non-empty string');
    }

    const createdAt = Date.now();
    const absoluteExpiresAt = createdAt + this.absoluteTtlMs;
    if (!isSafePositiveInteger(createdAt) || !isSafePositiveInteger(absoluteExpiresAt) || absoluteExpiresAt <= createdAt) {
      throw new RangeError('absolute expiration cannot be represented safely');
    }

    const session = { userId, deviceLabel, createdAt, absoluteExpiresAt };
    const serialized = JSON.stringify(session);
    const ttlMs = Math.min(this.idleTtlMs, absoluteExpiresAt - createdAt);
    if (!isSafePositiveInteger(ttlMs)) throw new RangeError('session TTL must be positive');

    for (let attempt = 0; attempt < MAX_SET_ATTEMPTS; attempt += 1) {
      const token = crypto.randomBytes(TOKEN_BYTES).toString('base64url');
      const key = sessionKey(token);
      const result = await this._setIfAbsent(key, serialized, ttlMs);
      if (result === 'OK' || result === true || result === 1) {
        return { token, session, ttlMs };
      }
    }

    throw new Error('could not allocate a unique session key');
  }

  async isReady() {
    if (this.redis.isReady === false || typeof this.redis.sendCommand !== 'function') return false;
    try {
      const reply = await this.redis.sendCommand(['MGETTTL', '__expiring_session_readiness_probe__']);
      return Array.isArray(reply) && reply.length === 1 &&
        Array.isArray(reply[0]) && reply[0].length === 2 &&
        reply[0][0] === null && asSafeInteger(reply[0][1]) === -2;
    } catch (_error) {
      return false;
    }
  }

  async getSession(token) {
    const key = sessionKey(token);
    if (key === null) return null;

    // Do not replace this with GET/PTTL: MGETTTL provides one value/TTL view.
    // A lookup failure is indistinguishable from an unusable session to an
    // authentication caller, so fail closed instead of exposing Redis errors.
    let reply;
    try {
      reply = await this.redis.sendCommand(['MGETTTL', key]);
    } catch (_error) {
      return null;
    }
    const parsedReply = parseMgetTtlReply(reply);
    if (parsedReply === null) return null;

    const session = parseSessionValue(parsedReply.value);
    if (session === null || session.absoluteExpiresAt <= Date.now()) return null;
    return { session, ttlMs: parsedReply.ttlMs };
  }

  async renewSession(token) {
    const key = sessionKey(token);
    if (key === null) return null;

    let reply;
    try {
      reply = await this._evalRenew(key);
    } catch (_error) {
      return null;
    }
    const parsed = parseRenewReply(reply);
    if (parsed === null || parsed.session.absoluteExpiresAt <= Date.now()) return null;
    return parsed;
  }

  async deleteSession(token) {
    const key = sessionKey(token);
    if (key === null) return false;

    let deleted;
    if (typeof this.redis.del === 'function') {
      deleted = await this.redis.del(key);
    } else {
      deleted = await this.redis.sendCommand(['DEL', key]);
    }
    const count = asSafeInteger(deleted);
    return count === 1;
  }

  async _setIfAbsent(key, value, ttlMs) {
    if (typeof this.redis.set === 'function') {
      return this.redis.set(key, value, { NX: true, PX: ttlMs });
    }
    return this.redis.sendCommand(['SET', key, value, 'PX', String(ttlMs), 'NX']);
  }

  async _evalRenew(key) {
    if (typeof this.redis.eval === 'function') {
      return this.redis.eval(RENEW_SCRIPT, {
        keys: [key],
        arguments: [String(this.idleTtlMs)],
      });
    }
    return this.redis.sendCommand([
      'EVAL', RENEW_SCRIPT, '1', key, String(this.idleTtlMs),
    ]);
  }
}

function createRedisSessionStore(redis, options) {
  return new RedisSessionStore(redis, options);
}

module.exports = RedisSessionStore;
module.exports.RedisSessionStore = RedisSessionStore;
module.exports.createRedisSessionStore = createRedisSessionStore;
module.exports.createSessionStore = createRedisSessionStore;
// Compatibility aliases keep the adapter usable from small example runners
// that conventionally look for createRedisStore/createStore.
module.exports.createRedisStore = createRedisSessionStore;
module.exports.createStore = createRedisSessionStore;
module.exports.SessionStore = RedisSessionStore;
module.exports.RENEW_SCRIPT = RENEW_SCRIPT;
module.exports.TOKEN_BYTES = TOKEN_BYTES;
module.exports.KEY_PREFIX = KEY_PREFIX;
module.exports.DEFAULT_IDLE_TTL_MS = DEFAULT_IDLE_TTL_MS;
module.exports.DEFAULT_ABSOLUTE_TTL_MS = DEFAULT_ABSOLUTE_TTL_MS;
module.exports.tokenDigest = tokenDigest;
module.exports.digestToken = tokenDigest;
module.exports.sessionKey = sessionKey;
module.exports.parseMgetTtlReply = parseMgetTtlReply;
module.exports.parseMGETTTLReply = parseMgetTtlReply;
module.exports.parseSessionValue = parseSessionValue;
module.exports.parseRenewReply = parseRenewReply;
module.exports.isSafePositiveInteger = isSafePositiveInteger;
