'use strict';

const fs = require('node:fs');
const { spawn } = require('node:child_process');
const { APP_DIR, withTemporaryRedis } = require('./redis.cjs');

function testTargets() {
  const supplied = process.argv.slice(2);
  // Always name concrete files. Node's directory handling differs between
  // releases, and implicit discovery can include this launcher itself.
  if (supplied.some((argument) => !argument.startsWith('-'))) return supplied;
  const files = [];
  for (const directory of ['test', 'tests']) {
    const root = `${APP_DIR}/${directory}`;
    if (!fs.existsSync(root)) continue;
    for (const name of fs.readdirSync(root)) {
      if (/\.(?:c|m)?js$/.test(name)) files.push(`${directory}/${name}`);
    }
  }
  return [...supplied, ...files];
}

function runTests(env) {
  const targets = testTargets();
  if (targets.length === 0) {
    process.stdout.write('No test files found (looked for test/ and tests/).\n');
    return Promise.resolve({ code: 0, signal: null });
  }
  return new Promise((resolve, reject) => {
    const args = ['--test', ...targets];
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
  const result = await withTemporaryRedis((redis) => runTests({
    ...process.env,
    NODE_ENV: process.env.NODE_ENV || 'test',
    REDIS_URL: redis.url,
  }));
  if (result.code !== 0) {
    process.exitCode = result.code || 1;
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
});
