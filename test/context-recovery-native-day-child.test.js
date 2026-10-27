'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { once } = require('node:events');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { requireNativeDayAssignment } = require('../scripts/lib/context-recovery-native-day-start');
const repo = path.resolve(__dirname, '..');
const gate = require.resolve('../scripts/lib/context-recovery-native-day-start');

for (const [name, value, input, expected] of [
  ['optional-direct-cli', undefined, '', 0],
  ['exact-grant', '1', '1', 0],
  ['empty-grant', '1', '', 1],
  ['wrong-byte', '1', '0', 1],
  ['newline-suffix', '1', '1\n', 1],
  ['extra-byte', '1', '11', 1],
  ['bad-environment', 'true', '1', 1],
]) {
  test('native day product imports are gated: ' + name, () => {
    const env = { ...process.env };
    delete env.HPM_NATIVE_DAY_OWNED_JOB;
    if (value !== undefined) env.HPM_NATIVE_DAY_OWNED_JOB = value;
    const code = `try{require(process.argv[1]).requireNativeDayAssignment(process.env.HPM_NATIVE_DAY_OWNED_JOB);process.stdout.write('product_import_allowed')}catch{process.exitCode=1}`;
    const result = spawnSync(process.execPath, ['-e', code, gate], {
      env,
      input,
      encoding: 'utf8',
      timeout: 5000,
      windowsHide: true,
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, expected);
    assert.equal(result.stdout, expected === 0 ? 'product_import_allowed' : '');
  });
}
test('assignment rejects non-string and extreme values before reading stdin', () => {
  for (const value of [null, false, 1, {}, [], '1'.repeat(65536)])
    assert.throws(() => requireNativeDayAssignment(value), /native_day_assignment_failed/);
});

test(
  'Windows owned day tree closes on controller loss and rejects forged leases',
  {
    skip: process.platform !== 'win32',
    timeout: 60000,
  },
  async (t) => {
    const root = fs.mkdtempSync(
      path.join(fs.realpathSync.native(os.tmpdir()), 'hpm-day-child-test-')
    );
    const controllers = [];
    t.after(async () => {
      try {
        for (const controller of controllers) {
          if (controller.exitCode === null && controller.signalCode === null) {
            const closed = once(controller, 'close');
            controller.kill();
            await closed;
          }
        }
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });
    const assembly = path.join(root, 'job.dll');
    const source = path.join(repo, 'scripts/lib/nsis-runtime-boundary-job.cs');
    const quote = (value) => "'" + value.replace(/'/g, "''") + "'";
    const compile = spawnSync(
      'pwsh.exe',
      [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `Add-Type -Path ${quote(source)} -OutputAssembly ${quote(assembly)} -ErrorAction Stop`,
      ],
      {
        encoding: 'utf8',
        timeout: 25000,
        windowsHide: true,
      }
    );
    assert.equal(compile.error, undefined);
    assert.equal(compile.status, 0);
    for (const mode of ['success', 'explicit-close', 'natural-leak', 'controller-kill']) {
      const directory = path.join(root, mode);
      fs.mkdirSync(directory);
      const child = spawn(
        'pwsh.exe',
        [
          '-NoLogo',
          '-NoProfile',
          '-NonInteractive',
          '-File',
          path.join(repo, 'test/fixtures/native-day-owned-controller.ps1'),
          '-Repo',
          repo,
          '-Node',
          process.execPath,
          '-Root',
          directory,
          '-Assembly',
          assembly,
          '-Mode',
          mode,
        ],
        {
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
        }
      );
      controllers.push(child);
      let output = '';
      child.stdout.on('data', (chunk) => {
        output += chunk;
      });
      const closed = once(child, 'close');
      if (mode === 'controller-kill') {
        const readyDeadline = Date.now() + 5000;
        while (!output.includes('owned_controller_ready')) {
          assert.equal(child.exitCode, null);
          assert.ok(Date.now() < readyDeadline, 'owned controller readiness deadline');
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        assert.equal(child.kill(), true);
      }
      const [code] = await closed;
      if (mode !== 'controller-kill') {
        assert.equal(code, 0);
        assert.ok(output.includes('owned_child_cleanup_passed'));
      } else assert.notEqual(code, 0);
      if (mode !== 'success') {
        const tree = JSON.parse(fs.readFileSync(path.join(directory, 'owned-tree.json'), 'utf8'));
        for (const pid of [tree.pid, tree.descendant]) {
          const deadline = Date.now() + 5000;
          for (;;) {
            let alive = true;
            try {
              process.kill(pid, 0);
            } catch (error) {
              assert.equal(error.code, 'ESRCH');
              alive = false;
            }
            if (!alive) break;
            assert.ok(
              Date.now() < deadline,
              'owned process remained alive after controller cleanup'
            );
            await new Promise((resolve) => setTimeout(resolve, 10));
          }
        }
      }
    }
  }
);

test('actual day entry rejects an invalid owned-Job grant before product imports or file creation', async () => {
  const filename = path.join(repo, 'scripts/qualify-context-recovery-native-day.js');
  const original = createRequire(filename);
  let productImports = 0;
  const state = {
    platform: 'win32',
    argv: ['node', filename],
    env: { HPM_NATIVE_DAY_OWNED_JOB: 'invalid' },
  };
  await vm.runInNewContext(
    fs.readFileSync(filename, 'utf8'),
    {
      process: state,
      require(name) {
        if (name === 'node:fs')
          return {
            writeSync() {
              return 0;
            },
          };
        if (
          name === './lib/context-recovery-native-day' ||
          name === './lib/context-recovery-native-day-receipts'
        ) {
          productImports++;
          throw Error('must_not_import_product_before_assignment');
        }
        return original(name);
      },
    },
    { filename }
  );
  assert.equal(productImports, 0);
  assert.equal(state.exitCode, 1);
});
