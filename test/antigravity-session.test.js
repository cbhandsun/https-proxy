'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const {
  createAntigravitySessionLauncher,
  resolveAntigravityExecutable,
} = require('../lib/proxy/antigravity-session');

function executableFs({ exists = true, symbolicLink = false } = {}) {
  return {
    lstatSync() {
      if (!exists) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      return {
        isFile: () => true,
        isSymbolicLink: () => symbolicLink,
        size: 1024,
      };
    },
  };
}

function spawnedChild() {
  const child = new EventEmitter();
  child.unrefCalls = 0;
  child.unref = () => {
    child.unrefCalls += 1;
  };
  return child;
}

async function main() {
  assert.equal(resolveAntigravityExecutable({ platform: 'linux' }), '');
  assert.equal(
    resolveAntigravityExecutable({
      env: { LOCALAPPDATA: 'C:\\Local' },
      fsModule: executableFs({ exists: false }),
      platform: 'win32',
    }),
    ''
  );
  assert.equal(
    resolveAntigravityExecutable({
      env: { LOCALAPPDATA: 'C:\\Local' },
      fsModule: executableFs({ symbolicLink: true }),
      platform: 'win32',
    }),
    ''
  );

  const spawnCalls = [];
  const child = spawnedChild();
  const launch = createAntigravitySessionLauncher({
    env: { LOCALAPPDATA: 'C:\\Local' },
    fsModule: executableFs(),
    getConfig: () => ({ appSettings: { antigravitySessionLaunchCooldownMs: 5000 } }),
    now: () => 100000,
    platform: 'win32',
    spawnProcess: (...args) => {
      spawnCalls.push(args);
      process.nextTick(() => child.emit('spawn'));
      return child;
    },
  });
  const first = launch();
  const concurrent = launch();
  assert.strictEqual(first, concurrent);
  assert.deepEqual(await first, { ok: true, launched: true, reason: 'started' });
  assert.equal(spawnCalls.length, 1);
  assert.equal(spawnCalls[0][0], 'C:\\Local\\Programs\\Antigravity\\Antigravity.exe');
  assert.deepEqual(spawnCalls[0][1], []);
  assert.equal(spawnCalls[0][2].detached, true);
  assert.equal(spawnCalls[0][2].stdio, 'ignore');
  assert.equal(spawnCalls[0][2].windowsHide, true);
  assert.equal(child.unrefCalls, 1);
  assert.deepEqual(await launch(), { ok: true, launched: false, reason: 'cooldown' });
  assert.equal(spawnCalls.length, 1);

  const disabledLaunch = createAntigravitySessionLauncher({
    getConfig: () => ({ appSettings: { antigravitySessionRecoveryEnabled: false } }),
    platform: 'win32',
    spawnProcess: () => {
      throw new Error('must not spawn');
    },
  });
  assert.deepEqual(await disabledLaunch(), { ok: false, reason: 'disabled' });

  const missingLaunch = createAntigravitySessionLauncher({
    env: { LOCALAPPDATA: 'C:\\Missing' },
    fsModule: executableFs({ exists: false }),
    platform: 'win32',
  });
  assert.deepEqual(await missingLaunch(), { ok: false, reason: 'missing_executable' });

  const failedLaunch = createAntigravitySessionLauncher({
    env: { LOCALAPPDATA: 'C:\\Local' },
    fsModule: executableFs(),
    platform: 'win32',
    spawnProcess: () => {
      throw new Error('spawn failed');
    },
  });
  assert.deepEqual(await failedLaunch(), { ok: false, reason: 'spawn_failed' });
}

main()
  .then(() => {
    console.log('[antigravity-session.test] ok');
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
