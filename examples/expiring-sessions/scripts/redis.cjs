'use strict';

const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');

const APP_DIR = path.resolve(__dirname, '..');
const REPO_DIR = path.resolve(APP_DIR, '..', '..');
const DEFAULT_READY_TIMEOUT_MS = 10000;
const REDIS_PING = '*1\r\n$4\r\nPING\r\n';

function isExecutable(file) {
  try {
    fs.accessSync(file, process.platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK);
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

function isReadableFile(file) {
  try {
    fs.accessSync(file, fs.constants.R_OK);
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

function findOnPath(command) {
  if (!command) return null;
  const hasPath = command.includes(path.sep) || (process.platform === 'win32' && command.includes('/'));
  if (hasPath) {
    const candidate = path.resolve(command);
    return isExecutable(candidate) ? candidate : null;
  }

  const pathEntries = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  const extensions = process.platform === 'win32'
    ? ['', ...(process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';')]
    : [''];
  for (const entry of pathEntries) {
    for (const extension of extensions) {
      const candidate = path.join(entry, `${command}${extension}`);
      if (isExecutable(candidate)) return candidate;
    }
  }
  return null;
}

function configuredPath(value) {
  if (!value) return null;
  return path.isAbsolute(value) ? value : path.resolve(APP_DIR, value);
}

function redisServerPath() {
  const configured = process.env.REDIS_SERVER;
  if (configured) {
    const resolved = findOnPath(configured) || configuredPath(configured);
    if (!resolved || !isExecutable(resolved)) {
      throw new Error(`REDIS_SERVER does not point to an executable: ${configured}`);
    }
    return resolved;
  }

  for (const candidate of [
    path.join(REPO_DIR, 'src', 'redis-server'),
    path.join(REPO_DIR, 'redis-server'),
  ]) {
    if (isExecutable(candidate)) return candidate;
  }

  const systemServer = findOnPath('redis-server');
  if (systemServer) return systemServer;
  throw new Error('Could not find redis-server. Build this checkout or set REDIS_SERVER.');
}

function mgetttlModulePath() {
  const configured = process.env.MGETTTL_MODULE || process.env.REDIS_MODULE;
  if (configured) {
    const resolved = configuredPath(configured);
    if (!isReadableFile(resolved)) {
      throw new Error(`MGETTTL_MODULE does not point to a readable module: ${resolved}`);
    }
    return resolved;
  }

  for (const candidate of [
    path.join(REPO_DIR, 'src', 'modules', 'mgetttl.so'),
    path.join(REPO_DIR, 'tests', 'modules', 'mgetttl.so'),
    path.join(APP_DIR, 'mgetttl.so'),
  ]) {
    if (isReadableFile(candidate)) return candidate;
  }
  return null;
}

function ensureMgetttlModule() {
  const existing = mgetttlModulePath();
  if (existing) return existing;

  const make = findOnPath(process.env.MAKE || 'make');
  if (!make) {
    throw new Error('MGETTTL module is missing and make was not found; set MGETTTL_MODULE to a built module.');
  }

  const moduleDir = path.join(REPO_DIR, 'src', 'modules');
  const source = path.join(moduleDir, 'mgetttl.c');
  if (!fs.existsSync(source)) {
    throw new Error(`Cannot build MGETTTL: source file is missing at ${source}`);
  }

  // Do not suppress compiler output: a failed local build should be actionable.
  execFileSync(make, ['-C', moduleDir, 'mgetttl.so'], {
    cwd: REPO_DIR,
    env: process.env,
    stdio: 'inherit',
  });

  const built = mgetttlModulePath();
  if (!built) {
    throw new Error('make completed but src/modules/mgetttl.so was not produced.');
  }
  return built;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const listener = net.createServer();
    listener.once('error', reject);
    listener.listen({ host: '127.0.0.1', port: 0 }, () => {
      const address = listener.address();
      const port = typeof address === 'object' && address ? address.port : null;
      listener.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

function ping(port) {
  return new Promise((resolve) => {
    let settled = false;
    let response = '';
    const socket = net.createConnection({ host: '127.0.0.1', port });
    const timer = setTimeout(() => finish(false), 300);

    function finish(ready) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(ready);
    }

    socket.once('connect', () => socket.write(REDIS_PING));
    socket.on('data', (chunk) => {
      response += chunk.toString();
      if (response.includes('+PONG\r\n')) finish(true);
    });
    socket.on('error', () => finish(false));
    socket.on('close', () => finish(false));
  });
}

async function waitForReady(child, port, output, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`redis-server exited before it was ready${output()}`);
    }
    if (await ping(port)) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for redis-server on port ${port}${output()}`);
}

function stopProcess(child) {
  if (child.exitCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(killTimer);
      resolve();
    };
    const killTimer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
      finish();
    }, 2000);
    child.once('exit', finish);
    try { child.kill('SIGTERM'); } catch { finish(); }
  });
}

async function startTemporaryRedis(options = {}) {
  const modulePath = options.modulePath || ensureMgetttlModule();
  const serverPath = options.serverPath || redisServerPath();
  const configuredPort = options.port ?? process.env.REDIS_PORT;
  const port = configuredPort ? Number(configuredPort) : await freePort();
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid REDIS_PORT: ${configuredPort}`);
  }

  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'expiring-sessions-redis-'));
  const args = [
    '--bind', '127.0.0.1',
    '--port', String(port),
    '--save', '',
    '--appendonly', 'no',
    '--dir', directory,
    '--dbfilename', 'dump.rdb',
    '--loadmodule', modulePath,
    '--loglevel', 'warning',
    '--logfile', '',
  ];
  const child = spawn(serverPath, args, { cwd: APP_DIR, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  const output = () => {
    const details = `${stdout}${stderr}`.trim();
    return details ? `:\n${details}` : '';
  };

  try {
    await waitForReady(child, port, output, options.timeoutMs || DEFAULT_READY_TIMEOUT_MS);
  } catch (error) {
    await stopProcess(child);
    await fs.promises.rm(directory, { recursive: true, force: true });
    throw error;
  }

  let stopped = false;
  return {
    child,
    port,
    url: `redis://127.0.0.1:${port}`,
    modulePath,
    async stop() {
      if (stopped) return;
      stopped = true;
      await stopProcess(child);
      await fs.promises.rm(directory, { recursive: true, force: true });
    },
  };
}

async function withTemporaryRedis(callback) {
  if (process.env.REDIS_URL) {
    return callback({ url: process.env.REDIS_URL, external: true, async stop() {} });
  }

  const redis = await startTemporaryRedis();
  const hadUrl = Object.prototype.hasOwnProperty.call(process.env, 'REDIS_URL');
  const previousUrl = process.env.REDIS_URL;
  process.env.REDIS_URL = redis.url;
  try {
    return await callback(redis);
  } finally {
    if (hadUrl) process.env.REDIS_URL = previousUrl;
    else delete process.env.REDIS_URL;
    await redis.stop();
  }
}

module.exports = {
  APP_DIR,
  REPO_DIR,
  ensureMgetttlModule,
  redisServerPath,
  startTemporaryRedis,
  withTemporaryRedis,
};
