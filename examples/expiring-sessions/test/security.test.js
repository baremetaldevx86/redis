'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const { once } = require('node:events');
const { test } = require('node:test');

/*
 * Focused hardening tests for the example.  The small Redis double lets the
 * storage checks run without another Redis process; integration.test.js owns
 * the real-server/module coverage.  HTTP tests use the app's documented
 * SessionStore interface and a deliberately boring in-memory store.
 */

const APP_MODULES = ['../server.js', '../src/app.js', '../src/http.js', '../src/api.js'];
const STORE_MODULES = ['../redis-store.js', '../src/session-store.js', '../src/store.js', '../src/storage.js'];

function loadFirst(candidates) {
  let lastMissing;
  for (const relative of candidates) {
    try {
      return require(relative);
    } catch (error) {
      // A missing candidate is expected while the example is being assembled.
      // Dependency and syntax errors from an existing candidate must surface.
      if (error && error.code === 'MODULE_NOT_FOUND' &&
          error.message.includes(`'${require.resolve ? relative : relative}'`)) {
        lastMissing = error;
        continue;
      }
      // require.resolve gives a more reliable distinction when the missing
      // module is the candidate itself rather than one of its dependencies.
      try {
        require.resolve(relative);
      } catch (_resolveError) {
        lastMissing = error;
        continue;
      }
      throw error;
    }
  }
  throw lastMissing || new Error('no candidate module found');
}

function loadApp(t) {
  try {
    return loadFirst(APP_MODULES);
  } catch (error) {
    if (error && error.code === 'MODULE_NOT_FOUND') {
      t.skip('HTTP application has not been added yet');
      return null;
    }
    throw error;
  }
}

function loadStore(t) {
  try {
    return loadFirst(STORE_MODULES);
  } catch (error) {
    if (error && error.code === 'MODULE_NOT_FOUND') {
      t.skip('Redis session store has not been added yet');
      return null;
    }
    throw error;
  }
}

function exportedFactory(moduleValue, names) {
  for (const name of names) {
    if (typeof moduleValue?.[name] === 'function') return moduleValue[name];
  }
  if (typeof moduleValue === 'function') return moduleValue;
  if (typeof moduleValue?.default === 'function') return moduleValue.default;
  return null;
}

function makeStoreOptions(redis) {
  return {
    client: redis,
    redis,
    redisClient: redis,
    prefix: 'security-test:session:',
  };
}

function makeStore(t, redis) {
  const moduleValue = loadStore(t);
  if (!moduleValue) return null;
  const Constructor = exportedFactory(moduleValue, [
    'createSessionStore', 'createRedisSessionStore', 'createStore',
    'RedisSessionStore', 'SessionStore',
  ]);
  if (!Constructor) {
    t.skip('session store does not expose a supported factory/class');
    return null;
  }
  const options = makeStoreOptions(redis);
  const store = Constructor.prototype?.getSession
    ? new Constructor(redis, options)
    : Constructor(redis, options);
  if (!store || typeof store.getSession !== 'function') {
    t.skip('session store does not implement getSession');
    return null;
  }
  return store;
}

class RedisDouble {
  constructor() {
    this.mgetValue = null;
    this.mgetTtl = -2;
    this.commands = [];
    this.evalCalls = [];
    this.setCalls = [];
    this.deleteCalls = [];
    this.evalReply = null;
    this.throwOnRead = null;
  }

  async sendCommand(command) {
    const args = Array.isArray(command) ? command : command?.args || [];
    this.commands.push(args);
    const name = String(args[0] || '').toUpperCase();
    if (name === 'MGETTTL') {
      if (this.throwOnRead) throw this.throwOnRead;
      return [[this.mgetValue, this.mgetTtl]];
    }
    if (name === 'TIME') return ['1000', '0'];
    return null;
  }

  async set(...args) {
    this.setCalls.push(args);
    return 'OK';
  }

  async del(...args) {
    this.deleteCalls.push(args);
    return 1;
  }

  async eval(script, options, ...rest) {
    this.evalCalls.push({ script: String(script), options, rest });
    return this.evalReply;
  }
}

class RecordingStore {
  constructor() {
    this.token = 'opaque-token-used-only-in-cookie';
    this.calls = [];
    this.deleted = false;
    this.failReads = false;
    this.session = {
      userId: 'alice',
      deviceLabel: 'security-test',
      createdAt: Date.now(),
      absoluteExpiresAt: Date.now() + 60_000,
    };
  }

  async createSession(input) {
    this.calls.push(['createSession', input]);
    return { token: this.token, session: this.session, ttlMs: 60_000 };
  }

  async getSession(token) {
    this.calls.push(['getSession', token]);
    if (this.failReads) throw new Error('simulated Redis outage');
    if (this.deleted || token !== this.token) return null;
    return { session: this.session, ttlMs: 60_000 };
  }

  async renewSession(token) {
    this.calls.push(['renewSession', token]);
    if (this.deleted || token !== this.token) return null;
    return { session: this.session, ttlMs: 30_000 };
  }

  async deleteSession(token) {
    this.calls.push(['deleteSession', token]);
    if (token !== this.token || this.deleted) return false;
    this.deleted = true;
    return true;
  }
}

function makeApp(t, store, options = {}) {
  const moduleValue = loadApp(t);
  if (!moduleValue) return null;
  const factory = exportedFactory(moduleValue, ['createApp', 'buildApp', 'createHttpApp']);
  if (!factory) {
    t.skip('HTTP application does not expose createApp/buildApp');
    return null;
  }
  // Supply both names for compatibility with the shared SessionStore contract.
  return factory({
    ...options,
    store,
    sessionStore: store,
    secureCookies: true,
    cookieSecure: true,
    sameSite: 'strict',
  });
}

async function withServer(app, callback) {
  const server = http.createServer(app);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    return await callback(server.address().port);
  } finally {
    server.close();
    await once(server, 'close');
  }
}

function request(port, { method = 'GET', path = '/', headers = {}, body = '' } = {}) {
  return new Promise((resolve, reject) => {
    const requestObject = http.request({
      host: '127.0.0.1', port, method, path,
      headers: { ...(body ? { 'content-length': Buffer.byteLength(body) } : {}), ...headers },
    }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({
        status: response.statusCode,
        headers: response.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    requestObject.on('error', reject);
    if (body) requestObject.write(body);
    requestObject.end();
  });
}

function requestJson(port, options, value) {
  return request(port, {
    ...options,
    headers: { 'content-type': 'application/json', ...(options?.headers || {}) },
    body: JSON.stringify(value),
  });
}

async function firstExistingRoute(port, routes, options) {
  let response;
  for (const path of routes) {
    response = await request(port, { ...options, path });
    if (response.status !== 404) return { path, response };
  }
  return { path: routes[routes.length - 1], response };
}

async function firstExistingJsonRoute(port, routes, options, value) {
  let response;
  for (const path of routes) {
    response = await requestJson(port, { ...options, path }, value);
    if (response.status !== 404) return { path, response };
  }
  return { path: routes[routes.length - 1], response };
}

function setCookieHeader(response) {
  const value = response.headers['set-cookie'];
  return Array.isArray(value) ? value.join('; ') : String(value || '');
}

function escapedRegExp(value) {
  return new RegExp(String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
}

const LOGIN_ROUTES = ['/auth/demo-login', '/auth/login', '/api/login', '/login'];
const RENEW_ROUTES = ['/session/renew', '/api/session/renew', '/api/renew', '/renew'];
const LOGOUT_ROUTES = ['/api/logout', '/logout', '/session/logout'];
const PROTECTED_ROUTES = ['/protected', '/api/protected', '/me'];

test('security: session cookie has restrictive flags', async t => {
  const app = makeApp(t, new RecordingStore());
  if (!app) return;
  await withServer(app, async port => {
    const { response: login } = await firstExistingJsonRoute(port, LOGIN_ROUTES, { method: 'POST' }, {
      userId: 'alice', username: 'alice', password: 'demo', deviceLabel: 'security-test',
    });
    assert.ok(login.status >= 200 && login.status < 400, `login failed with ${login.status}`);
    const cookie = setCookieHeader(login);
    assert.match(cookie, /HttpOnly/i);
    assert.match(cookie, /Secure/i);
    assert.match(cookie, /SameSite=Strict/i);
    assert.match(cookie, /(?:^|;\s*)Path=\//i);
  });
});

test('security: opaque token is not disclosed in the login representation', async t => {
  const store = new RecordingStore();
  const app = makeApp(t, store);
  if (!app) return;
  await withServer(app, async port => {
    const { response: login } = await firstExistingJsonRoute(port, LOGIN_ROUTES, { method: 'POST' }, {
      userId: 'alice', username: 'alice', password: 'demo', deviceLabel: 'security-test',
    });
    assert.ok(login.status >= 200 && login.status < 400, `login failed with ${login.status}`);
    assert.doesNotMatch(login.body, escapedRegExp(store.token));
    assert.doesNotMatch(login.body, /(?:^|[,{])\s*"?(?:token|accessToken|bearer)"?\s*:/i);
    for (const [name, value] of Object.entries(login.headers)) {
      if (name.toLowerCase() === 'set-cookie') continue;
      assert.doesNotMatch(String(value), escapedRegExp(store.token));
    }
  });
});

test('security: malformed, persistent, expired, and wrong-type Redis records fail closed', async t => {
  const redis = new RedisDouble();
  const store = makeStore(t, redis);
  if (!store) return;
  const token = crypto.randomBytes(32).toString('base64url');
  const malformed = [
    ['invalid JSON', '{not-json'],
    ['JSON null', 'null'],
    ['JSON array', '[]'],
    ['missing required fields', JSON.stringify({ userId: 'alice' })],
    ['wrong field types', JSON.stringify({ userId: 42, createdAt: 'now', absoluteExpiresAt: null })],
  ];
  for (const [label, raw] of malformed) {
    redis.mgetValue = raw;
    redis.mgetTtl = 30_000;
    assert.equal(await store.getSession(token), null, `${label} was accepted`);
  }
  const lookup = redis.commands.find(command => String(command[0]).toUpperCase() === 'MGETTTL');
  assert.ok(lookup, 'session lookup did not use MGETTTL');
  assert.equal(lookup[1], `sess:${crypto.createHash('sha256').update(token).digest('hex')}`);
  assert.notEqual(lookup[1], token, 'raw bearer token was used as the Redis key');
  redis.mgetValue = JSON.stringify({
    userId: 'alice', deviceLabel: 'test', createdAt: Date.now(), absoluteExpiresAt: Date.now() + 60_000,
  });
  for (const ttl of [-1, -2, 0]) {
    redis.mgetTtl = ttl;
    assert.equal(await store.getSession(token), null, `record with TTL ${ttl} was accepted`);
  }
  redis.mgetValue = null;
  redis.mgetTtl = 30_000;
  assert.equal(await store.getSession(token), null, 'wrong-type/null MGETTTL value was accepted');
});

test('security: renewal is atomic and cannot extend beyond absolute expiry', async t => {
  const redis = new RedisDouble();
  const store = makeStore(t, redis);
  if (!store || typeof store.renewSession !== 'function') {
    t.skip('renewSession is not exposed by the session store');
    return;
  }
  const token = crypto.randomBytes(32).toString('base64url');
  assert.equal(await store.renewSession(token), null, 'missing session renewal should fail closed');
  assert.equal(redis.setCalls.length, 0, 'renewal recreated a missing session with SET');
  assert.equal(redis.deleteCalls.length, 0, 'renewal deleted a missing session unexpectedly');
  assert.ok(redis.evalCalls.length > 0, 'renewal was not performed atomically with EVAL');
  const script = redis.evalCalls.map(call => call.script).join('\n');
  assert.match(script, /TIME/i, 'renewal does not use Redis TIME');
  assert.match(script, /PEXPIRE/i, 'renewal does not set an idle expiry atomically');
  assert.match(script, /absolute|expiresAt|createdAt/i, 'renewal script has no absolute-expiry guard');
  assert.match(script, /(?:existing|missing|expired|DEL|EXISTS|GET)/i, 'renewal script does not guard a deleted key');
  for (const call of redis.evalCalls) {
    assert.doesNotMatch(JSON.stringify(call.options) + JSON.stringify(call.rest), escapedRegExp(token));
  }
});

test('security: logout wins over renewal and does not leave a usable cookie', async t => {
  const store = new RecordingStore();
  const app = makeApp(t, store);
  if (!app) return;
  await withServer(app, async port => {
    const cookie = `session=${store.token}`;
    const logout = await firstExistingRoute(port, LOGOUT_ROUTES, { method: 'POST', headers: { cookie } });
    assert.ok(logout.response.status >= 200 && logout.response.status < 400, `logout failed with ${logout.response.status}`);
    assert.equal(store.deleted, true, 'logout did not delete the session');
    const renew = await firstExistingRoute(port, RENEW_ROUTES, { method: 'POST', headers: { cookie } });
    assert.ok([401, 403, 404].includes(renew.response.status), `deleted session renewed with ${renew.response.status}`);
    assert.equal(store.calls.filter(([name]) => name === 'renewSession').length, 1, 'renewal was not checked after logout');
    assert.match(setCookieHeader(logout.response), /Max-Age=0|Expires=/i, 'logout did not clear the cookie');
  });
});

test('security: oversized cookies and request bodies are bounded before storage access', async t => {
  const store = new RecordingStore();
  const app = makeApp(t, store, { maxBodyBytes: 16 * 1024, bodyLimit: '16kb' });
  if (!app) return;
  await withServer(app, async port => {
    const protectedResponse = await firstExistingRoute(port, PROTECTED_ROUTES, {
      method: 'GET', headers: { cookie: `session=${'x'.repeat(32 * 1024)}` },
    });
    assert.ok([400, 401, 403, 413, 431].includes(protectedResponse.response.status));
    assert.equal(store.calls.filter(([name]) => name === 'getSession').length, 0, 'oversized token reached storage');
    const login = await firstExistingRoute(port, LOGIN_ROUTES, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userId: 'alice', password: 'x'.repeat(128 * 1024) }),
    });
    assert.ok([400, 413].includes(login.response.status), `oversized body returned ${login.response.status}`);
    assert.equal(store.calls.filter(([name]) => name === 'createSession').length, 0, 'oversized body reached creation');
  });
});

test('security: Redis failures and malformed sessions produce safe auth failures', async t => {
  const redis = new RedisDouble();
  const store = makeStore(t, redis);
  if (!store) return;
  redis.throwOnRead = new Error('Redis unavailable');
  assert.equal(await store.getSession(crypto.randomBytes(32).toString('base64url')), null);
  const appStore = new RecordingStore();
  appStore.failReads = true;
  const app = makeApp(t, appStore);
  if (!app) return;
  await withServer(app, async port => {
    const response = await firstExistingRoute(port, PROTECTED_ROUTES, {
      method: 'GET', headers: { cookie: `session=${appStore.token}` },
    });
    assert.ok([401, 403, 503].includes(response.response.status), `storage failure leaked as ${response.response.status}`);
    assert.doesNotMatch(response.response.body, /Redis unavailable|simulated Redis outage|stack| at /i);
    assert.doesNotMatch(response.response.body, escapedRegExp(appStore.token));
  });
});
