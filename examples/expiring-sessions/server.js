'use strict';

const crypto = require('crypto');
const path = require('path');
const express = require('express');

const DEFAULT_COOKIE_NAME = 'session';
const DEFAULT_REDIS_URL = 'redis://127.0.0.1:6379';
const DEFAULT_PORT = 3000;
const DEFAULT_HOST = '127.0.0.1';
const JSON_LIMIT = '4kb';
const MAX_FIELD_LENGTH = 128;
const MAX_TOKEN_LENGTH = 4096;

/**
 * A small HTTP API around the SessionStore interface.  The store deliberately
 * owns token generation and persistence; the HTTP layer only puts the opaque
 * token in an HttpOnly cookie and never puts it in a response body.
 *
 * @param {object|function} storeOrOptions a SessionStore, or
 *        {store, ...options}
 * @param {object} [options]
 * @returns {import('express').Express}
 */
function createApp(storeOrOptions, options) {
  let store = storeOrOptions;
  let config = options || {};

  // Supporting the object form makes the factory convenient for tests and
  // leaves room for adding configuration without changing the store API.
  if (
    storeOrOptions &&
    typeof storeOrOptions === 'object' &&
    (Object.prototype.hasOwnProperty.call(storeOrOptions, 'store') ||
      Object.prototype.hasOwnProperty.call(storeOrOptions, 'sessionStore'))
  ) {
    config = Object.assign({}, storeOrOptions, options || {});
    store = config.store || config.sessionStore;
  }

  assertStore(store);

  const requestedCookieName = config.cookieName || process.env.COOKIE_NAME ||
    process.env.SESSION_COOKIE_NAME;
  const cookieName = validCookieName(requestedCookieName)
    ? requestedCookieName
    : DEFAULT_COOKIE_NAME;
  const cookieSecure = config.cookieSecure !== undefined
    ? parseBoolean(config.cookieSecure, false)
    : config.secureCookies !== undefined
      ? parseBoolean(config.secureCookies, false)
      : parseBoolean(process.env.COOKIE_SECURE, false);
  const requestedSameSite = config.sameSite !== undefined
    ? config.sameSite
    : process.env.COOKIE_SAME_SITE;
  const sameSite = requestedSameSite !== undefined && requestedSameSite !== null &&
    validSameSite(requestedSameSite)
    ? String(requestedSameSite).toLowerCase()
    : 'lax';
  const publicDirectory = config.publicDirectory || path.join(__dirname, 'public');
  const readinessCheck = config.isReady || config.ready;

  const app = express();
  app.disable('x-powered-by');
  app.set('etag', false);

  // Session data and authentication results are never cacheable.  Set this
  // before static middleware as well: the dashboard may contain user state.
  app.use((req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    next();
  });
  const bodyLimit = config.bodyLimit || config.maxBodyBytes || JSON_LIMIT;
  app.use(express.json({ limit: bodyLimit, strict: true }));

  const cookieOptions = {
    httpOnly: true,
    sameSite,
    secure: cookieSecure,
    path: '/',
  };

  app.post(['/auth/demo-login', '/auth/login', '/api/login', '/login'], asyncHandler(async (req, res) => {
    const input = req.body && typeof req.body === 'object' ? req.body : {};
    const userId = input.userId === undefined ? 'demo-user' : input.userId;
    const deviceLabel = input.deviceLabel === undefined ? 'browser' : input.deviceLabel;

    if (!validField(userId) || !validField(deviceLabel)) {
      return sendError(res, 400, 'invalid_request');
    }

    let created;
    try {
      created = await store.createSession({
        userId: userId.trim(),
        deviceLabel: deviceLabel.trim(),
      });
    } catch (_error) {
      return sendError(res, 503, 'service_unavailable');
    }

    if (!validStoreResult(created, true)) {
      return sendError(res, 503, 'service_unavailable');
    }

    res.cookie(cookieName, created.token, Object.assign({}, cookieOptions, {
      maxAge: cookieMaxAge(created.ttlMs),
    }));
    return res.status(201).json(publicSessionResponse(created));
  }));

  app.get(['/session', '/api/session'], asyncHandler(async (req, res) => {
    const token = readSessionToken(req, cookieName);
    if (!token) {
      clearSessionCookie(res, cookieName, cookieOptions);
      return sendError(res, 401, 'unauthorized');
    }

    let found;
    try {
      found = await store.getSession(token);
    } catch (_error) {
      return sendError(res, 503, 'service_unavailable');
    }
    if (!validStoreResult(found, false)) {
      clearSessionCookie(res, cookieName, cookieOptions);
      return sendError(res, 401, 'unauthorized');
    }
    return res.json(publicSessionResponse(found));
  }));

  app.post(['/session/renew', '/api/session/renew', '/api/renew', '/renew'], asyncHandler(async (req, res) => {
    const token = readSessionToken(req, cookieName);
    if (!token) {
      clearSessionCookie(res, cookieName, cookieOptions);
      return sendError(res, 401, 'unauthorized');
    }

    let renewed;
    try {
      renewed = await store.renewSession(token);
    } catch (_error) {
      return sendError(res, 503, 'service_unavailable');
    }
    if (!validStoreResult(renewed, false)) {
      clearSessionCookie(res, cookieName, cookieOptions);
      return sendError(res, 401, 'unauthorized');
    }

    res.cookie(cookieName, token, Object.assign({}, cookieOptions, {
      maxAge: cookieMaxAge(renewed.ttlMs),
    }));
    return res.json(publicSessionResponse(renewed));
  }));

  app.delete(['/session', '/api/session'], asyncHandler(async (req, res) => {
    const token = readSessionToken(req, cookieName);
    // Clearing the browser cookie is safe and useful even when Redis is down.
    clearSessionCookie(res, cookieName, cookieOptions);
    if (token) {
      try {
        await store.deleteSession(token);
      } catch (_error) {
        return sendError(res, 503, 'service_unavailable');
      }
    }
    return res.status(204).end();
  }));

  app.get(['/protected', '/api/protected', '/me'], asyncHandler(async (req, res) => {
    const token = readSessionToken(req, cookieName);
    if (!token) {
      clearSessionCookie(res, cookieName, cookieOptions);
      return sendError(res, 401, 'unauthorized');
    }

    let found;
    try {
      found = await store.getSession(token);
    } catch (_error) {
      return sendError(res, 503, 'service_unavailable');
    }
    if (!validStoreResult(found, false)) {
      clearSessionCookie(res, cookieName, cookieOptions);
      return sendError(res, 401, 'unauthorized');
    }
    return res.json(Object.assign({ ok: true }, publicSessionResponse(found)));
  }));

  app.get(['/health/ready', '/readyz'], asyncHandler(async (_req, res) => {
    let ready;
    try {
      ready = await checkReady(store, readinessCheck);
    } catch (_error) {
      ready = false;
    }
    if (!ready) {
      return res.status(503).json({ status: 'not_ready' });
    }
    return res.json({ status: 'ok' });
  }));

  // Keep API routes above static content so a future public/session file cannot
  // accidentally shadow authentication endpoints.
  // POST logout is kept as a compatibility alias for the dashboard/API docs;
  // DELETE /session remains the canonical route.
  app.post(['/api/logout', '/logout', '/session/logout'], asyncHandler(async (req, res) => {
    const token = readSessionToken(req, cookieName);
    clearSessionCookie(res, cookieName, cookieOptions);
    if (token) {
      try {
        await store.deleteSession(token);
      } catch (_error) {
        return sendError(res, 503, 'service_unavailable');
      }
    }
    return res.status(204).end();
  }));

  app.use(express.static(publicDirectory, {
    etag: false,
    lastModified: false,
    cacheControl: false,
  }));

  app.use((_req, res) => sendError(res, 404, 'not_found'));
  app.use((error, _req, res, _next) => {
    if (res.headersSent) return undefined;
    if (error && error.type === 'entity.too.large') {
      return sendError(res, 413, 'request_too_large');
    }
    if (error && error.type === 'entity.parse.failed') {
      return sendError(res, 400, 'invalid_json');
    }
    return sendError(res, 500, 'internal_server_error');
  });

  return app;
}

function assertStore(store) {
  if (!store || typeof store.createSession !== 'function' ||
      typeof store.getSession !== 'function' ||
      typeof store.renewSession !== 'function' ||
      typeof store.deleteSession !== 'function') {
    throw new TypeError('A SessionStore implementation is required');
  }
}

function asyncHandler(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

function validField(value) {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= MAX_FIELD_LENGTH;
}

function validCookieName(value) {
  return typeof value === 'string' && /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(value);
}

function validSameSite(value) {
  return value === undefined || /^(strict|lax|none)$/i.test(String(value));
}

function validStoreResult(result, requiresToken) {
  if (!result || typeof result !== 'object' || !result.session || !validTtl(result.ttlMs)) {
    return false;
  }
  if (requiresToken && (typeof result.token !== 'string' ||
      result.token.length === 0 || result.token.length > MAX_TOKEN_LENGTH ||
      /[\s;\r\n]/.test(result.token))) {
    return false;
  }
  return true;
}

function validTtl(value) {
  return Number.isFinite(value) && value > 0 && value <= 0x7fffffff;
}

function readSessionToken(req, cookieName) {
  const header = req.headers.cookie;
  if (typeof header !== 'string' || header.length > 8192) return null;
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0) continue;
    const name = part.slice(0, separator).trim();
    // `sid` is accepted as a legacy/default alias so an already-issued demo
    // cookie remains usable when COOKIE_NAME is changed during development.
    if (name !== cookieName && !(cookieName !== 'sid' && name === 'sid')) continue;
    const raw = part.slice(separator + 1).trim();
    if (!raw || raw.length > MAX_TOKEN_LENGTH) return null;
    try {
      const value = decodeURIComponent(raw);
      if (!value || value.length > MAX_TOKEN_LENGTH || /[\s;\r\n]/.test(value)) return null;
      return value;
    } catch (_error) {
      return null;
    }
  }
  return null;
}

function publicSessionResponse(result) {
  return {
    session: sanitizeSession(result.session),
    ttlMs: result.ttlMs,
  };
}

function sanitizeSession(session) {
  if (!session || typeof session !== 'object' || Array.isArray(session)) return session;
  const safe = {};
  for (const [key, value] of Object.entries(session)) {
    if (key === 'token' || key === 'sessionToken' || key === 'accessToken') continue;
    safe[key] = value;
  }
  return safe;
}

function cookieMaxAge(ttlMs) {
  // Cookie Max-Age is serialized in whole seconds. Never turn a valid
  // sub-second Redis TTL into Max-Age=0; Redis remains authoritative.
  return Math.max(1000, Math.ceil(ttlMs / 1000) * 1000);
}

function clearSessionCookie(res, cookieName, cookieOptions) {
  res.clearCookie(cookieName, cookieOptions);
}

function sendError(res, status, code) {
  return res.status(status).json({ error: code });
}

function parseBoolean(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  return /^(1|true|yes|on)$/i.test(String(value));
}

async function checkReady(store, readinessCheck) {
  if (typeof readinessCheck === 'function') return Boolean(await readinessCheck());
  if (typeof store.isReady === 'function') return Boolean(await store.isReady());
  if (typeof store.isReady === 'boolean') return store.isReady;
  if (typeof store.ready === 'function') return Boolean(await store.ready());
  if (typeof store.ready === 'boolean') return store.ready;
  if (store.client && typeof store.client.isReady === 'boolean') return store.client.isReady;
  return true;
}

/**
 * Start the standalone Redis-backed example.  redis-store.js is intentionally
 * loaded here (rather than at module load time), so tests can use createApp
 * without installing or connecting a Redis client.
 */
async function start(options) {
  const config = options || {};
  const redis = require('redis');
  const redisUrl = config.redisUrl || process.env.REDIS_URL || DEFAULT_REDIS_URL;
  const port = parsePort(config.port || process.env.PORT);
  const client = config.client || redis.createClient({ url: redisUrl });

  if (client && typeof client.on === 'function') {
    // Do not expose connection details or credentials in process logs.
    client.on('error', () => undefined);
  }
  if (!client.isOpen && typeof client.connect === 'function') await client.connect();

  const store = await makeRedisStore(client, config);
  const readinessCheck = config.isReady || (async () => {
    if (client.isReady === false || typeof client.sendCommand !== 'function') return false;
    try {
      const reply = await client.sendCommand(['MGETTTL', '__expiring_session_readiness_probe__']);
      return Array.isArray(reply) && reply.length === 1 &&
        Array.isArray(reply[0]) && reply[0].length === 2 &&
        reply[0][0] === null && Number(reply[0][1]) === -2;
    } catch (_error) {
      return false;
    }
  });
  const app = createApp(store, {
    cookieSecure: config.cookieSecure !== undefined
      ? parseBoolean(config.cookieSecure, false)
      : parseBoolean(process.env.COOKIE_SECURE, false),
    sameSite: config.sameSite !== undefined
      ? config.sameSite
      : process.env.COOKIE_SAME_SITE,
    cookieName: config.cookieName,
    publicDirectory: config.publicDirectory,
    isReady: readinessCheck,
  });
  const host = config.host || process.env.HOST || DEFAULT_HOST;
  return new Promise((resolve, reject) => {
    const server = app.listen(port, host, () => resolve(server));
    server.once('error', reject);
  });
}

async function makeRedisStore(client, config) {
  const storeConfig = { ...config };
  if (storeConfig.idleTtlMs === undefined && process.env.SESSION_IDLE_TTL_MS !== undefined) {
    storeConfig.idleTtlMs = parsePositiveInteger(process.env.SESSION_IDLE_TTL_MS, 'SESSION_IDLE_TTL_MS');
  }
  if (storeConfig.absoluteTtlMs === undefined && process.env.SESSION_ABSOLUTE_TTL_MS !== undefined) {
    storeConfig.absoluteTtlMs = parsePositiveInteger(process.env.SESSION_ABSOLUTE_TTL_MS, 'SESSION_ABSOLUTE_TTL_MS');
  }
  const moduleValue = require('./redis-store');
  if (typeof moduleValue.createRedisStore === 'function') {
    return moduleValue.createRedisStore(client, storeConfig);
  }
  if (typeof moduleValue.createStore === 'function') {
    return moduleValue.createStore(client, storeConfig);
  }
  const Constructor = moduleValue.RedisSessionStore || moduleValue.SessionStore ||
    moduleValue.default || moduleValue;
  if (typeof Constructor !== 'function') {
    throw new TypeError('redis-store.js must export RedisSessionStore or createRedisStore');
  }
  return new Constructor(client, storeConfig);
}

function parsePositiveInteger(value, name) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
  return parsed;
}

function parsePort(value) {
  if (value === undefined || value === '') return DEFAULT_PORT;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new TypeError('PORT must be an integer between 1 and 65535');
  }
  return port;
}

module.exports = {
  createApp,
  createServer: createApp,
  start,
};

if (require.main === module) {
  start().then((server) => {
    // Keep startup output free of URLs, tokens, and connection credentials.
    process.stdout.write(`expiring-session service listening on ${server.address().port}\n`);
  }).catch((error) => {
    process.stderr.write(`expiring-session service failed to start: ${error && error.message ? error.message : 'unknown error'}\n`);
    process.exitCode = 1;
  });
}
