'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { APP_DIR, withTemporaryRedis } = require('./redis.cjs');

function serviceEntry() {
  const configured = process.env.SESSION_SERVER || 'server.js';
  const entry = path.isAbsolute(configured) ? configured : path.resolve(APP_DIR, configured);
  if (!fs.existsSync(entry)) {
    throw new Error(`Service entrypoint was not found: ${entry}`);
  }
  return entry;
}

function runNode(args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: APP_DIR,
      env,
      stdio: 'inherit',
    });
    let settled = false;
    const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'];
    const forward = (signal) => {
      try { child.kill(signal); } catch { /* the child already exited */ }
    };
    for (const signal of signals) process.once(signal, forward);

    const finish = (error, code, signal) => {
      if (settled) return;
      settled = true;
      for (const name of signals) process.removeListener(name, forward);
      if (error) reject(error);
      else resolve({ code, signal });
    };
    child.once('error', (error) => finish(error));
    child.once('close', (code, signal) => finish(null, code, signal));
  });
}

async function main() {
  const entry = serviceEntry();
  const result = await withTemporaryRedis((redis) => {
    if (redis.external) process.stderr.write(`Using external Redis at ${redis.url}\n`);
    return runNode([entry, ...process.argv.slice(2)], {
      ...process.env,
      REDIS_URL: redis.url,
    });
  });
  if (result.code !== 0) {
    process.exitCode = result.code || 1;
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
});
