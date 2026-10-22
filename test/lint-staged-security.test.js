'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const { runOwnedFixtureCommand, cleanupHookFixture } = require('./helpers/owned-fixture-command');
const { createHookFixtureTools } = require('./helpers/hook-fixture-path');

const root = path.resolve(__dirname, '..');
const packageJson = require('../package.json');

test('certificate and hook security dependency batches are declared and locked without forge', () => {
  const lock = require('../package-lock.json');
  assert.equal(packageJson.dependencies['node-forge'], undefined);
  assert.equal(packageJson.hpm.releaseRuntimeDependencies.includes('node-forge'), false);
  assert.equal(
    Object.keys(lock.packages).some(
      (entry) => entry === 'node_modules/node-forge' || entry.endsWith('/node_modules/node-forge')
    ),
    false
  );
  assert.equal(packageJson.devDependencies['lint-staged'], '^17.6.0');
  assert.equal(lock.packages['node_modules/lint-staged'].dev, true);
  const installed = require('../node_modules/lint-staged/package.json');
  assert.equal(installed.version, lock.packages['node_modules/lint-staged'].version);
});

test('upgraded lint-staged runs the actual ESLint/Prettier hook and rejects invalid code in isolated Git fixture', async (t) => {
  const tools = createHookFixtureTools({
    binDirectory: path.join(root, 'node_modules', '.bin'),
    nodeExecutable: process.execPath,
    environment: { ...process.env },
  });
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hpm-lint-staged-fixture-'));
  const env = {
    ...tools.env,
    HUSKY: '0',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
  };
  // Exercise the real development CLIs, but do not instrument third-party
  // ESLint/Prettier processes. They execute no selected lib/proxy modules;
  // the fixture and every production test retain the parent c8 coverage.
  delete env.NODE_V8_COVERAGE;
  for (const key of Object.keys(env)) {
    if (key.startsWith('GIT_')) delete env[key];
  }
  env.GIT_CONFIG_NOSYSTEM = '1';
  env.GIT_CONFIG_GLOBAL = process.platform === 'win32' ? 'NUL' : '/dev/null';
  // All writes, staging and commits below are confined to this generated fixture.
  function git(...args) {
    const result = spawnSync(tools.gitExecutable, args, {
      cwd: directory,
      env,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 15000,
    });
    assert.equal(
      result.status,
      0,
      `isolated fixture Git ${args[0]} failed (${result.error?.code || result.signal || 'exit'})`
    );
    return result.stdout;
  }
  let cleanupSafe = true;
  async function hook() {
    cleanupSafe = false;
    const result = await runOwnedFixtureCommand(
      process.execPath,
      [path.join(root, 'node_modules/lint-staged/bin/lint-staged.js')],
      { cwd: directory, env, timeoutMs: 30000 }
    );
    cleanupSafe = true;
    return result;
  }
  let primaryFailure;
  let stage = 'setup';
  try {
    git('init', '--quiet');
    git('config', 'user.name', 'Synthetic Hook Fixture');
    git('config', 'user.email', 'fixture@example.invalid');
    git('config', 'core.hooksPath', path.join(directory, 'no-hooks'));
    fs.writeFileSync(
      path.join(directory, 'eslint.config.cjs'),
      `module.exports = require(${JSON.stringify(path.join(root, 'eslint.config.js'))});\n`
    );
    fs.writeFileSync(
      path.join(directory, 'package.json'),
      JSON.stringify({ private: true, 'lint-staged': packageJson['lint-staged'] })
    );
    fs.writeFileSync(path.join(directory, 'fixture.js'), 'module.exports = 1;\n');
    git('add', '.');
    git('commit', '--quiet', '-m', 'synthetic fixture baseline');
    // Use the exact user-facing hook commands, resolving their tools locally.
    fs.writeFileSync(path.join(directory, 'fixture.js'), 'module.exports={value:2}\n');
    git('add', 'fixture.js');
    stage = 'good_run';
    const good = await hook();
    stage = 'good_assert';
    assert.equal(good.failure, null, 'valid hook command failed: ' + good.failure);
    assert.equal(
      good.status,
      0,
      'upgraded hook must execute real ESLint and Prettier successfully'
    );
    assert.equal(
      fs.readFileSync(path.join(directory, 'fixture.js'), 'utf8'),
      'module.exports = { value: 2 };\n'
    );
    assert.equal(git('show', ':fixture.js'), 'module.exports = { value: 2 };\n');
    stage = 'bad_run';
    fs.writeFileSync(
      path.join(directory, 'fixture.js'),
      'module.exports = UNKNOWN_FIXTURE_IDENTIFIER;\n'
    );
    git('add', 'fixture.js');
    const bad = await hook();
    stage = 'bad_assert';
    assert.equal(bad.failure, null, 'invalid hook command failed: ' + bad.failure);
    assert.equal(bad.status, 1, 'upgraded hook must propagate ESLint failure');
    assert.match(bad.stdout + bad.stderr, /no-undef/);
    assert.equal(git('show', ':fixture.js'), 'module.exports = UNKNOWN_FIXTURE_IDENTIFIER;\n');
  } catch (error) {
    t.diagnostic('hook_failure_stage=' + stage);
    primaryFailure = error;
  }
  cleanupHookFixture(directory, primaryFailure, cleanupSafe);
});
