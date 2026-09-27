# Expiring Session Service

This example is a small Express application that stores opaque browser sessions in
Redis. It demonstrates three things together:

- fetching the session value and its remaining lifetime with this checkout's
  `MGETTTL` module;
- showing the remaining lifetime in a browser dashboard; and
- renewing an idle session without ever extending it beyond an absolute lifetime.

It is an educational example, not an authentication system or a production-ready
session package. In particular, the demo login accepts a user identifier supplied
by the caller (see [Production hardening](#production-hardening-limitations)).

## Prerequisites

- This Redis source checkout. The module uses the `RedisModule_ReplyWithKeyString`
  API from this checkout, so use the server and module built from the same
  checkout rather than an unrelated system Redis.
- A C compiler and the normal Redis build prerequisites. Follow the top-level
  [build instructions](../../README.md#build-redis-from-source) if Redis has not
  been built yet.
- Node.js 18 or newer and npm.
- `curl` and `redis-cli` are useful for smoke tests. `redis-cli` should be from
  the same Redis build when possible.

The commands below assume the shell's current directory is the root of this Redis
checkout. They produce `src/redis-server` and `src/modules/mgetttl.so`:

```sh
make build redis
make -C src/modules mgetttl.so
```

`mgetttl.so` is not a standalone Redis module for an arbitrary server version. If
the server or module is rebuilt from another checkout, rebuild both together.

## Install and start

Start Redis in one terminal with the module loaded:

```sh
./src/redis-server --loadmodule "$PWD/src/modules/mgetttl.so" --port 6379
```

Check that the module loaded and that the command reports values and TTLs:

```sh
redis-cli MODULE LIST
redis-cli SET expiring-sessions:smoke-test ok PX 60000
redis-cli MGETTTL expiring-sessions:smoke-test expiring-sessions:no-such-key
# 1) 1) "ok"
#    2) (integer) <remaining milliseconds>
# 2) 1) (nil)
#    2) (integer) -2
```

In a second terminal, install and configure the example:

```sh
cd examples/expiring-sessions
cp .env.example .env
# The npm wrappers inherit the shell environment. On shells without automatic
# .env loading, export the example explicitly:
set -a; . ./.env; set +a
npm install
```

The package scripts are:

```sh
npm run dev       # starts server.js with Node's --watch and a temporary Redis by default
npm start         # starts server.js and a temporary Redis by default
npm test          # runs node:test, including real-Redis integration tests
```

When `REDIS_URL` is set, `dev`, `start`, and `test` use that Redis instance. When
it is unset, the wrappers discover/build this checkout's server and module and
start a disposable Redis on a free local port. Do not commit `.env`; it is
ignored in a normal local setup and may contain Redis credentials.

Open <http://localhost:3000/> for the dashboard. The port is configurable with
`PORT`.

## Configuration

`.env.example` is a local-development baseline:

| Variable | Default | Description |
| --- | --- | --- |
| `PORT` | `3000` | HTTP listen port. |
| `REDIS_URL` | *(temporary local Redis)* | Redis connection URL. Set it to `redis://127.0.0.1:6379` for the manually started server, or to a TLS/authenticated `rediss://` deployment. |
| `SESSION_IDLE_TTL_MS` | `1800000` | Idle lifetime (30 minutes) assigned at login and on a successful renewal. Must be positive. |
| `SESSION_ABSOLUTE_TTL_MS` | `28800000` | Maximum lifetime (8 hours) from session creation. Must be positive; renewal remains bounded by this deadline. |
| `COOKIE_NAME` / `SESSION_COOKIE_NAME` | `session` | HTTP-only cookie carrying the opaque session token. Change it when multiple local copies share a browser. `COOKIE_NAME` takes precedence. |
| `COOKIE_SECURE` | `false` | Set to `true` when HTTPS is used. Browsers do not send a Secure cookie over plain HTTP. |
| `COOKIE_SAME_SITE` | `lax` | Cookie SameSite policy (`lax`, `strict`, or `none`). Use the strictest policy compatible with the deployment. |
| `REDIS_SERVER` | *(auto-discovered)* | Optional executable path used by the temporary Redis helper. |
| `MGETTTL_MODULE` | *(auto-discovered)* | Optional module path used by the temporary Redis helper; normally `../../src/modules/mgetttl.so`. |
| `REDIS_PORT` | *(free port)* | Optional temporary Redis port used by the helper. |
| `HOST` | `127.0.0.1` | HTTP bind address. Use a trusted reverse proxy/network boundary before binding beyond localhost. |

Durations are milliseconds, not seconds. The storage adapter validates duration
values and creates no persistent session. The Redis store's built-in defaults are
30 minutes idle and 8 hours absolute. The npm wrappers pass `SESSION_*_TTL_MS` through to the store when they start the
service. Keep the values positive; a renewal can never pass the absolute deadline.
Keep the Redis URL and any password out of source control. For a TLS Redis
deployment, use the client's `rediss://` URL and validate the server certificate
according to the client/deployment configuration. The default HTTP listener binds
to localhost; put it behind a trusted TLS reverse proxy before binding it to a
broader interface with `HOST`.

## HTTP API

All API routes use the cookie set by login. Requests and responses are JSON unless
noted otherwise. The dashboard is served by `GET /`.

| Method and route | Purpose | Success |
| --- | --- | --- |
| `POST /api/login` (also `/auth/demo-login`, `/auth/login`, `/login`) | Demo login. Send `{ "userId": "user-42", "deviceLabel": "laptop" }`; the server creates a new session and sets the HTTP-only cookie. | `201` with the session summary and remaining TTL. |
| `GET /api/session` (also `/session`) | Inspect the current session and its remaining idle TTL. | `200` with session data and `ttlMs`, or `401` when absent/expired/invalid. |
| `GET /api/protected` (also `/protected`, `/me`) | Example protected resource. | `200` for a valid session, otherwise `401`. |
| `POST /api/session/renew` (also `/session/renew`, `/api/renew`, `/renew`) | Explicitly renew the current session. | `200` with the new session summary and bounded `ttlMs`, or `401` if the session no longer exists/cannot be renewed. |
| `POST /api/logout` or `DELETE /session` | Delete the current Redis session and clear the browser cookie. | `204` even when there is no usable session. |
| `GET /health/ready` (also `/readyz`) | Liveness/readiness check for the HTTP process, Redis, and the required `MGETTTL` command. | `200` only when the service can use its Redis dependency; otherwise `503`. |

Example requests, using a cookie jar so that login and subsequent calls share the
same browser session:

```sh
curl -i -c /tmp/expiring-session.cookies \
  -H 'content-type: application/json' \
  -d '{"userId":"user-42","deviceLabel":"curl"}' \
  http://localhost:3000/api/login

curl -i -b /tmp/expiring-session.cookies http://localhost:3000/api/session
curl -i -b /tmp/expiring-session.cookies http://localhost:3000/api/protected
curl -i -X POST -b /tmp/expiring-session.cookies \
  http://localhost:3000/api/session/renew
curl -i -X POST -b /tmp/expiring-session.cookies \
  http://localhost:3000/api/logout
# The equivalent REST-style logout is:
# curl -i -X DELETE -b /tmp/expiring-session.cookies http://localhost:3000/session
```

A client must treat `401` as a logged-out state and discard any cached session
summary. The displayed TTL is advisory; the Redis key's expiry and the server's
session validation are authoritative.

## Cookie and token security model

The login response contains a cryptographically random, opaque bearer token in an
HTTP-only cookie. The browser dashboard never needs to read the token, and the
example does not put it in local storage, a URL, or an API response. The cookie is controlled by `SESSION_COOKIE_NAME` and `COOKIE_SECURE`; this
example uses `HttpOnly`, `SameSite=Lax`, and `Path=/` and does not set a broad
cookie domain.

On the server, the raw token is hashed with SHA-256 and only that digest is used
in a namespaced Redis key. The raw token is not a Redis key and must not be logged.
Anyone who obtains the raw cookie can use the session until it expires or is
logged out, so use HTTPS and protect access to browser and proxy logs. Logout
removes the digest key and clears the cookie; login creates a fresh token rather
than reusing a caller-provided token.

`HttpOnly` prevents page JavaScript from reading the cookie, but it does not stop
all cross-site request forgery. SameSite is a useful browser defense, not a full
CSRF design. Any deployment with cross-site requests or high-value state changes
must add CSRF tokens and/or strict Origin/Referer checks, and should apply
rate-limiting and authentication controls at the edge.

## MGETTTL response semantics

`MGETTTL key [key ...]` returns one two-element array for every requested key, in
request order:

```text
[value, remaining_ttl_ms]
```

The second element is the server's remaining TTL in milliseconds:

- an existing expiring string has its value and a non-negative remaining TTL;
- a missing key is `[null, -2]`;
- an existing key without an expiry reports `-1`;
- a non-string key has a null value but still reports its expiry.

A key can expire between the command and application processing, so a near-zero
TTL is not a promise that a subsequent operation will succeed. Sessions created by
this example always receive a positive PX expiry. The storage adapter rejects a
missing value, malformed JSON, a non-string/wrong-type record, a persistent record,
and a non-positive/invalid TTL rather than treating any of them as a valid session.

Session lookup intentionally uses this one custom command to obtain the value and
its TTL together; it does not replace `MGETTTL` with a separate `GET` plus `PTTL`.
The service must be connected to a Redis server with `mgetttl.so` loaded. A missing
command is a readiness/configuration error, not a reason to silently fall back to a
less strict lookup.

## Renewal and lifetime behavior

Each session JSON record contains the user/device data, its creation time, and an
absolute-expiry timestamp. Redis's key TTL is the idle timeout. Creating a session
sets both the record and a positive PX expiry. Looking up a session reports the
remaining idle TTL; it does not implicitly extend it.

`POST /api/session/renew` (the service implementation also exposes the equivalent
`POST /session/renew` route) runs an atomic server-side renewal operation:

1. read and validate the existing record;
2. use Redis `TIME` to calculate the time remaining before its absolute deadline;
3. if the key still exists, set its new TTL to the smaller of the configured idle
   TTL and the remaining absolute lifetime; and
4. return the record and the resulting TTL.

The operation never recreates a missing or expired key. Consequently, a renewal
racing with logout or expiry fails closed. Once the absolute lifetime is reached,
the session cannot be renewed and the client must log in again. Repeated renewals
can keep an active session alive only up to the absolute cap; they cannot turn the
session into a permanent session. The dashboard's countdown is a convenience for
users and should be refreshed from the server after renewal.

## Local development

Use separate terminals so Redis remains visible while debugging:

```sh
# Terminal 1, from the repository root
make build redis
make -C src/modules mgetttl.so
./src/redis-server --loadmodule "$PWD/src/modules/mgetttl.so" --port 6379

# Terminal 2
cd examples/expiring-sessions
cp .env.example .env       # edit PORT/TTL values as desired
npm install
npm run dev
```

Then browse to <http://localhost:3000/> or use the `curl` commands above. To
inspect only this example's records, use the configured prefix and `SCAN`; avoid
`KEYS` against a shared or production Redis:

```sh
redis-cli --scan --pattern 'sess:*'
redis-cli MGETTTL sess:<sha256-token-digest>
```

For a short expiry demonstration, choose a small positive idle TTL in `.env` and
a larger absolute TTL. Do not use a zero TTL: it intentionally creates no usable
session.

## Production hardening limitations

This example deliberately leaves important production work to the application
owner:

- **Authentication:** `/api/login` is a demo login, not proof of identity. Replace
  it with an existing identity provider or a real credential/WebAuthn flow. Validate
  user and device input server-side and authorize every protected operation.
- **CSRF and browser policy:** add CSRF/origin protections for state-changing
  routes, set a restrictive Content-Security-Policy, and review SameSite/domain
  choices. Keep `COOKIE_SECURE=true` whenever HTTPS is available.
- **Transport and proxy trust:** terminate TLS, use HSTS where appropriate, and
  set `TRUST_PROXY` only for known proxy hops. Do not expose the development HTTP
  listener directly to the internet.
- **Redis security and availability:** use Redis ACLs with least privilege, TLS or
  a private network, connection timeouts, monitoring, backups/replication as
  appropriate, and an eviction policy that cannot silently evict live sessions.
  Load and test the matching `mgetttl.so` on every Redis instance.
- **Abuse controls:** add login/renewal rate limits, account lockout or abuse
  detection, request size limits, audit events that do not contain tokens, and
  structured error handling. Never log cookie values, bearer tokens, or complete
  session records.
- **Deployment:** run multiple stateless service instances behind a health-aware
  proxy, handle graceful shutdown, pin and audit npm dependencies, and set
  resource limits. Test readiness behavior during Redis outages and module
  upgrades.
- **Session policy:** choose idle and absolute lifetimes from the threat model,
  revoke sessions on password/security events, and consider per-user/device
  session management. The sample has no key rotation or revocation list beyond
  deleting the individual Redis key.

Treat this directory as a runnable reference for Redis expiry semantics, not as a
security boundary by itself.
