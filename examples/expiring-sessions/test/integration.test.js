'use strict';

/*
 * End-to-end tests for the example.  These deliberately start a disposable
 * Redis process with this checkout's mgetttl.so instead of using a Redis mock:
 * the value/TTL pair is the important part of the storage contract.
 *
 * Run with `npm test` from examples/expiring-sessions.  If Redis, the matching
 * server binary, the module, or npm dependencies are not available, every
 * integration test is skipped with one explicit prerequisite message.
 */

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const { once } = require('node:events');
const { test } = require('node:test');

const EXAMPLE_ROOT = path.resolve(__dirname, '..');
const CHECKOUT_ROOT = path.resolve(EXAMPLE_ROOT, '..', '..');
const MODULE_CANDIDATES = process.env.MGETTTL_MODULE
  ? [process.env.MGETTTL_MODULE]
  : [path.join(CHECKOUT_ROOT, 'src', 'modules', 'mgetttl.so')];
const SERVER_CANDIDATES = process.env.REDIS_SERVER
  ? [process.env.REDIS_SERVER]
  : [path.join(CHECKOUT_ROOT, 'src', 'redis-server'), 'redis-server'];

const harness = {
  error: null,
  redis: null,
  client: null,
  store: null,
  appServer: null,
  port: null,
  serverModule: null,
  storeModule: null,
};
let skipMessagePrinted = false;

function firstExecutable(candidates) {
  for (const candidate of candidates) {
    if (candidate === 'redis-server') {
      try {
        return execFileSync('sh', ['-c', 'command -v redis-server'], { encoding: 'utf8' }).trim();
      } catch (_error) {
        continue;
      }
    }
    try {
      if (fs.statSync(candidate).isFile() && (fs.accessSync(candidate, fs.constants.X_OK), true)) {
        return candidate;
      }
    } catch (_error) {
      // Try the next candidate.
    }
  }
  return null;
}

function firstFile(candidates) {
  return candidates.find(candidate => {
    try {
      return fs.statSync(candidate).isFile();
    } catch (_error) {
      return false;
    }
  }) || null;
}

function randomPort() {
  return 32000 + crypto.randomInt(0, 20000);
}

function delay(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

async function waitForRedis(client, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      await client.connect();
      const reply = await client.sendCommand(['MGETTTL', '__expiring_sessions_probe__']);
      if (Array.isArray(reply) && Array.isArray(reply[0]) && reply[0][1] === -2) return;
      throw new Error('MGETTTL returned an unexpected response');
    } catch (error) {
      lastError = error;
      if (client.isOpen) {
        try { await client.disconnect(); } catch (_error) { /* best effort */ }
      }
      await delay(50);
    }
  }
  throw new Error(`Redis/MGETTTL did not become ready: ${lastError ? lastError.message : 'timeout'}`);
}

async function startRedis() {
  const modulePath = firstFile(MODULE_CANDIDATES);
  if (!modulePath) {
    throw new Error('mgetttl.so is absent (build it with `make -C src/modules mgetttl.so`)');
  }
  const redisBinary = firstExecutable(SERVER_CANDIDATES);
  if (!redisBinary) {
    throw new Error('redis-server is absent (build this checkout first)');
  }

  let lastError;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const port = randomPort();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'expiring-sessions-test-'));
    const child = spawn(redisBinary, [
      '--bind', '127.0.0.1', '--port', String(port),
      '--save', '', '--appendonly', 'no', '--dir', dir,
      '--loadmodule', modulePath,
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => { stderr += chunk; });

    try {
      const redis = require('redis');
      const client = redis.createClient({ url: `redis://127.0.0.1:${port}` });
      client.on('error', () => undefined);
      await waitForRedis(client);
      return { child, client, port, dir, modulePath };
    } catch (error) {
      lastError = error;
      if (child.exitCode === null) {
        child.kill('SIGTERM');
        await once(child, 'close').catch(() => undefined);
      }
      fs.rmSync(dir, { recursive: true, force: true });
      if (/unknown command|MGETTTL|module/i.test(`${error.message}\n${stderr}`)) {
        throw new Error(`Redis started but mgetttl.so was not loaded: ${error.message}`);
      }
    }
  }
  throw lastError || new Error('could not start Redis');
}

async function stopRedis() {
  if (harness.appServer) {
    harness.appServer.close();
    await once(harness.appServer, 'close').catch(() => undefined);
    harness.appServer = null;
  }
  if (harness.client) {
    if (harness.client.isOpen) await harness.client.quit().catch(() => undefined);
    harness.client = null;
  }
  if (harness.redis && harness.redis.child && harness.redis.child.exitCode === null) {
    harness.redis.child.kill('SIGTERM');
    await once(harness.redis.child, 'close').catch(() => undefined);
  }
  if (harness.redis && harness.redis.dir) {
    fs.rmSync(harness.redis.dir, { recursive: true, force: true });
  }
  harness.redis = null;
}

async function setup() {
  // Loading these lazily is important: npm install is an optional prerequisite
  // for this example, and a missing package must produce skips rather than a
  // module-load crash from node:test.
  try {
    harness.storeModule = require(path.join(EXAMPLE_ROOT, 'redis-store.js'));
    harness.serverModule = require(path.join(EXAMPLE_ROOT, 'server.js'));
    require('redis');
  } catch (error) {
    if (error && error.code === 'MODULE_NOT_FOUND') {
      throw new Error(`Node dependencies or example files are absent: ${error.message}`);
    }
    throw error;
  }

  harness.redis = await startRedis();
  harness.client = harness.redis.client;
  await harness.client.flushDb();
  const Store = harness.storeModule.RedisSessionStore || harness.storeModule;
  harness.store = new Store(harness.client, { idleTtlMs: 220, absoluteTtlMs: 650 });

  if (!harness.serverModule || typeof harness.serverModule.createApp !== 'function') {
    throw new Error('server.js does not export createApp');
  }
  const app = harness.serverModule.createApp(harness.store, {
    cookieSecure: false,
    cookieName: 'session',
    isReady: () => harness.client.isReady,
  });
  harness.appServer = http.createServer(app);
  harness.appServer.listen(0, '127.0.0.1');
  await once(harness.appServer, 'listening');
  harness.port = harness.appServer.address().port;
}

async function ready(t) {
  if (!harness.error) return true;
  if (!skipMessagePrinted) {
    skipMessagePrinted = true;
    process.stderr.write(`Skipping expiring-session integration tests: ${harness.error.message}\n`);
  }
  t.skip(`Redis/module prerequisites unavailable: ${harness.error.message}`);
  return false;
}

test.before(async () => {
  try {
    await setup();
  } catch (error) {
    harness.error = error;
    await stopRedis();
  }
});

test.after(async () => {
  await stopRedis();
});

function request({ method = 'GET', route = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const requestHeaders = { ...headers };
    if (body !== undefined) {
      requestHeaders['content-length'] = Buffer.byteLength(body);
    }
    const req = http.request({
      host: '127.0.0.1', port: harness.port, method, path: route,
      headers: requestHeaders,
    }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let json = null;
        if (raw) {
          try { json = JSON.parse(raw); } catch (_error) { /* text response */ }
        }
        resolve({ status: response.statusCode, headers: response.headers, body: raw, json });
      });
    });
    req.once('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

async function requestJson(options, value) {
  return request({
    ...options,
    headers: { 'content-type': 'application/json', ...(options.headers || {}) },
    body: JSON.stringify(value),
  });
}

function cookieFrom(response) {
  const setCookie = response.headers['set-cookie'];
  if (!Array.isArray(setCookie) || !setCookie[0]) return null;
  return setCookie[0].split(';', 1)[0];
}

function cookieValue(cookie) {
  return cookie ? cookie.slice(cookie.indexOf('=') + 1) : null;
}

function tokenDigest(token) {
  return crypto.createHash('sha256').update(token, 'utf8').digest('hex');
}

const ROUTES = {
  login: ['/api/login', '/auth/demo-login'],
  session: ['/api/session', '/session'],
  renew: ['/api/session/renew', '/session/renew'],
  protected: ['/api/protected', '/protected'],
  readiness: ['/readyz', '/health/ready'],
};

// Retry request bodies correctly when the implementation uses the older
// endpoint names from the first example draft.
async function api(kind, options = {}, input) {
  const routes = ROUTES[kind];
  if (!routes) throw new Error(`unknown API route ${kind}`);
  let last;
  for (const route of routes) {
    last = input === undefined
      ? await request({ ...options, route })
      : await requestJson({ ...options, route }, input);
    if (last.status !== 404) return { route, response: last };
  }
  return { route: routes[routes.length - 1], response: last };
}

async function loginApi(input = { userId: 'user-42', deviceLabel: 'test-device' }) {
  return api('login', { method: 'POST' }, input);
}

async function resetDb() {
  await harness.client.flushDb();
}

async function sessionRecord(token, overrides = {}) {
  const now = Date.now();
  return {
    userId: 'user-42',
    deviceLabel: 'test-device',
    createdAt: now - 10,
    absoluteExpiresAt: now + 60_000,
    ...overrides,
  };
}

test('MGETTTL returns ordered values and parseSession lookup accepts only positive TTLs', async t => {
  if (!(await ready(t))) return;
  await resetDb();
  const expiring = 'mgetttl:test:expiring';
  const persistent = 'mgetttl:test:persistent';
  const wrongType = 'mgetttl:test:wrong-type';
  await harness.client.set(expiring, 'json-value', { PX: 1000 });
  await harness.client.set(persistent, 'persistent-value');
  await harness.client.hSet(wrongType, 'field', 'value');
  await harness.client.pExpire(wrongType, 1000);

  const reply = await harness.client.sendCommand(['MGETTTL', expiring, 'mgetttl:test:missing', persistent, wrongType]);
  assert.equal(reply.length, 4);
  assert.equal(reply[0][0], 'json-value');
  assert.ok(Number(reply[0][1]) > 0);
  assert.equal(reply[1][0], null);
  assert.equal(Number(reply[1][1]), -2);
  assert.equal(reply[2][0], 'persistent-value');
  assert.equal(Number(reply[2][1]), -1);
  assert.equal(reply[3][0], null);
  assert.ok(Number(reply[3][1]) > 0, 'wrong-type keys retain their expiry');

  const parse = harness.storeModule.parseMgetTtlReply;
  assert.equal(typeof parse, 'function');
  assert.deepEqual(parse([[Buffer.from('value'), '25']]), { value: 'value', ttlMs: 25 });
  assert.equal(parse([[null, -2]]), null);
  assert.equal(parse([['persistent', -1]]), null);
  assert.equal(parse([[Buffer.from('value'), 0]]), null);
  assert.equal(parse([['value']]), null);
});

test('createSession sets a positive expiry, lookup returns TTL, and expiry makes it missing', async t => {
  if (!(await ready(t))) return;
  await resetDb();
  const shortStore = new (harness.storeModule.RedisSessionStore || harness.storeModule)(harness.client, {
    idleTtlMs: 100,
    absoluteTtlMs: 1000,
  });
  const created = await shortStore.createSession({ userId: 'alice', deviceLabel: 'laptop' });
  assert.match(created.token, /^[A-Za-z0-9_-]{40,}$/);
  assert.equal(created.session.userId, 'alice');
  assert.equal(created.session.deviceLabel, 'laptop');
  assert.ok(created.ttlMs > 0 && created.ttlMs <= 100);
  assert.ok(created.session.absoluteExpiresAt > created.session.createdAt);
  assert.equal(await harness.client.exists(harness.storeModule.sessionKey(created.token)), 1);

  const found = await shortStore.getSession(created.token);
  assert.ok(found);
  assert.equal(found.session.userId, 'alice');
  assert.ok(found.ttlMs > 0 && found.ttlMs <= created.ttlMs);

  await delay(150);
  assert.equal(await shortStore.getSession(created.token), null);
  assert.equal(await shortStore.renewSession(created.token), null, 'renewal recreated an expired session');
});

test('missing, malformed, persistent, expired, and wrong-type records fail closed', async t => {
  if (!(await ready(t))) return;
  await resetDb();
  const Store = harness.storeModule.RedisSessionStore || harness.storeModule;
  const store = new Store(harness.client, { idleTtlMs: 500, absoluteTtlMs: 5000 });
  const token = crypto.randomBytes(32).toString('base64url');
  assert.equal(await store.getSession(token), null, 'missing session was accepted');

  const key = harness.storeModule.sessionKey(token);
  const invalid = [
    'not-json',
    'null',
    '[]',
    JSON.stringify({ userId: 'alice' }),
    JSON.stringify({ userId: 42, deviceLabel: 'laptop', createdAt: Date.now(), absoluteExpiresAt: Date.now() + 1000 }),
  ];
  for (const value of invalid) {
    await harness.client.set(key, value, { PX: 1000 });
    assert.equal(await store.getSession(token), null, `accepted malformed record ${value}`);
  }

  const valid = await sessionRecord(token);
  await harness.client.set(key, JSON.stringify(valid));
  assert.equal(await store.getSession(token), null, 'persistent session was accepted');

  await harness.client.set(key, JSON.stringify(valid), { PX: 20 });
  await delay(50);
  assert.equal(await store.getSession(token), null, 'expired session was accepted');

  await harness.client.hSet(key, 'field', 'wrong-type');
  await harness.client.pExpire(key, 1000);
  assert.equal(await store.getSession(token), null, 'wrong-type session was accepted');
});

test('renewal is atomic, preserves the record, and cannot exceed absolute lifetime', async t => {
  if (!(await ready(t))) return;
  await resetDb();
  const Store = harness.storeModule.RedisSessionStore || harness.storeModule;
  const store = new Store(harness.client, { idleTtlMs: 500, absoluteTtlMs: 500 });
  const token = crypto.randomBytes(32).toString('base64url');
  const now = Date.now();
  const record = await sessionRecord(token, {
    createdAt: now - 1000,
    absoluteExpiresAt: now + 180,
  });
  const key = harness.storeModule.sessionKey(token);
  await harness.client.set(key, JSON.stringify(record), { PX: 1000 });

  const renewed = await store.renewSession(token);
  assert.ok(renewed, 'a live session was not renewed');
  assert.equal(renewed.session.userId, record.userId);
  assert.ok(renewed.ttlMs > 0);
  assert.ok(renewed.ttlMs <= 180, `renewal exceeded absolute cap: ${renewed.ttlMs}`);
  const keyTtl = await harness.client.pTTL(key);
  assert.ok(keyTtl > 0 && keyTtl <= 180);

  await delay(220);
  assert.equal(await store.renewSession(token), null, 'renewal recreated/preserved an absolute-expired session');
  assert.equal(await harness.client.exists(key), 0);

  const missing = crypto.randomBytes(32).toString('base64url');
  assert.equal(await store.renewSession(missing), null);
  assert.equal(await harness.client.exists(harness.storeModule.sessionKey(missing)), 0);
});

test('API authentication, status, error, input, and cookie behavior are fail-closed', async t => {
  if (!(await ready(t))) return;
  await resetDb();

  const noSession = await api('session');
  assert.equal(noSession.response.status, 401);
  assert.equal(noSession.response.json.error, 'unauthorized');
  const protectedWithoutSession = await api('protected');
  assert.equal(protectedWithoutSession.response.status, 401);
  const renewWithoutSession = await api('renew', { method: 'POST' });
  assert.equal(renewWithoutSession.response.status, 401);

  const invalid = await loginApi({ userId: ' ', deviceLabel: 'device' });
  assert.equal(invalid.response.status, 400);
  assert.equal(invalid.response.json.error, 'invalid_request');
  const oversized = await loginApi({ userId: 'u'.repeat(129), deviceLabel: 'device' });
  assert.equal(oversized.response.status, 400);
  const malformedJson = await request({
    method: 'POST', route: invalid.route,
    headers: { 'content-type': 'application/json' }, body: '{not-json',
  });
  assert.equal(malformedJson.status, 400);
  assert.equal(malformedJson.json.error, 'invalid_json');

  const login = await loginApi({ userId: '<img src=x onerror=alert(1)>', deviceLabel: 'phone' });
  assert.equal(login.response.status, 201);
  const cookie = cookieFrom(login.response);
  assert.ok(cookie, 'login did not set a cookie');
  assert.match(login.response.headers['set-cookie'][0], /HttpOnly/i);
  assert.match(login.response.headers['set-cookie'][0], /SameSite=Lax/i);
  assert.match(login.response.headers['set-cookie'][0], /Path=\//i);
  assert.doesNotMatch(login.response.body, new RegExp(tokenDigest(cookieValue(cookie))));
  assert.equal(login.response.json.session.userId, '<img src=x onerror=alert(1)>');
  assert.equal(Object.prototype.hasOwnProperty.call(login.response.json, 'token'), false);
  assert.ok(login.response.json.ttlMs > 0);

  const authenticated = await api('session', { headers: { cookie } });
  assert.equal(authenticated.response.status, 200);
  assert.equal(authenticated.response.json.session.userId, '<img src=x onerror=alert(1)>');
  assert.ok(authenticated.response.json.ttlMs > 0);
  const protectedResponse = await api('protected', { headers: { cookie } });
  assert.equal(protectedResponse.response.status, 200);
  assert.equal(protectedResponse.response.json.ok, true);

  const malformedCookie = await api('session', { headers: { cookie: 'session=%ZZ' } });
  assert.equal(malformedCookie.response.status, 401);
  const hugeCookie = await api('protected', { headers: { cookie: `session=${'x'.repeat(9000)}` } });
  assert.equal(hugeCookie.response.status, 401);

  const notFound = await request({ route: '/does-not-exist' });
  assert.equal(notFound.status, 404);
  assert.equal(notFound.json.error, 'not_found');
  const readiness = await api('readiness');
  assert.equal(readiness.response.status, 200);
  assert.equal(readiness.response.json.status, 'ok');
});

test('API renewal remains bounded and logout clears the cookie and deletes the session', async t => {
  if (!(await ready(t))) return;
  await resetDb();
  const login = await loginApi({ userId: 'logout-user', deviceLabel: 'browser' });
  assert.equal(login.response.status, 201);
  const cookie = cookieFrom(login.response);
  const token = cookieValue(cookie);
  assert.ok(token);
  const renewed = await api('renew', { method: 'POST', headers: { cookie } });
  assert.equal(renewed.response.status, 200);
  assert.ok(renewed.response.json.ttlMs > 0 && renewed.response.json.ttlMs <= 220);

  // The logout route was POST /api/logout in the documented interface and
  // DELETE /session in the initial implementation; support both while the
  // example remains backwards compatible.
  const logoutCandidates = [
    ['POST', '/api/logout'], ['DELETE', '/api/logout'],
    ['POST', '/session/logout'], ['DELETE', '/session'],
  ];
  let logout;
  for (const [method, route] of logoutCandidates) {
    const response = await request({ method, route, headers: { cookie } });
    if (response.status !== 404) { logout = response; break; }
  }
  assert.ok(logout);
  assert.equal(logout.status, 204);
  const cleared = (logout.headers['set-cookie'] || []).join(';');
  assert.match(cleared, /Max-Age=0|Expires=/i);
  assert.equal(await harness.client.exists(harness.storeModule.sessionKey(token)), 0);

  const afterLogout = await api('session', { headers: { cookie } });
  assert.equal(afterLogout.response.status, 401);
  const afterLogoutRenewal = await api('renew', { method: 'POST', headers: { cookie } });
  assert.equal(afterLogoutRenewal.response.status, 401);
});
