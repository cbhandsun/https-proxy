'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { discoverTestFiles, selectUnitTestFiles } = require('../../lib/test-discovery');
const { scripts } = require('../../package.json');
const root = path.resolve(__dirname, '../..');
const suites = ['test:coverage', 'test:client:coverage', 'test:frontend:coverage'];

test('client coverage bounds file workers without filtering cases or removing coverage enforcement', () => {
  const command = scripts['test:client:coverage'];
  const concurrency = [...command.matchAll(/--test-concurrency(?:=|\s+)(\S+)/g)];
  assert.equal(concurrency.length, 1);
  assert.equal(concurrency[0][1], '4');
  assert.match(command, /node --test --test-concurrency=4 test\//);
  assert.doesNotMatch(command, /--test-(?:only|skip-pattern|name-pattern)(?:\s|=|$)/);
  assert.equal((command.match(/(?:^|\s)--check-coverage(?:\s|$)/g) || []).length, 1);
  assert.match(command, /--statements 85 --branches 80 --functions 90 --lines 85/);
});

function option(command, flag) {
  const match = command.match(new RegExp('(?:^|\\s)' + flag + '\\s+(\\S+)'));
  assert.ok(match, 'Coverage output directories must be explicit');
  const relative = path.relative(root, path.resolve(root, match[1]));
  assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
  return match[1];
}

test('coverage suites isolate raw data without weakening thresholds or security report discovery', () => {
  const directories = suites.map((suite) => option(scripts[suite], '--temp-directory'));
  assert.equal(new Set(directories).size, suites.length);
  for (const directory of directories) {
    for (const other of directories) {
      if (directory === other) continue;
      const relative = path.relative(directory, other);
      assert.ok(relative.startsWith('..'), 'A suite must not clean a parent of another suite');
    }
  }
  assert.equal(option(scripts['test:coverage'], '--reports-dir'), 'coverage/proxy');
  assert.ok(scripts['test:coverage'].includes('node scripts/run-unit-test-shards.js'));
  assert.ok(scripts['test:coverage'].endsWith('&& node scripts/check-security-coverage.js'));
  for (const [suite, thresholds] of [
    ['test:coverage', '--statements 58 --branches 65 --functions 62 --lines 58'],
    ['test:client:coverage', '--statements 85 --branches 80 --functions 90 --lines 85'],
    ['test:frontend:coverage', '--statements 50 --branches 40 --functions 50 --lines 50'],
  ])
    assert.ok(scripts[suite].includes(thresholds));
  assert.ok(scripts.verify.includes('npm run test:frontend:coverage'));
  assert.ok(scripts.verify.includes('npm run test:coverage'));
});

test('security coverage consumes the current proxy report, never a stale root report', (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'hpm-security-report-path-'));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(temp)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(temp).startsWith('hpm-security-report-path-'));
    fs.rmSync(temp, { recursive: true, force: true });
  });
  for (const relative of ['scripts/check-security-coverage.js', 'lib/coverage-metrics.js']) {
    const destination = path.join(temp, relative);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(path.join(root, relative), destination);
  }
  const report = (count) =>
    Object.fromEntries(
      [
        'logger.js',
        'management-auth.js',
        'management-utils.js',
        'proxy-transport.js',
        'safe-routing-pattern.js',
        'validator.js',
      ].map((name) => [
        path.join(temp, 'lib', 'proxy', name),
        {
          s: { 0: count },
          f: { 0: count },
          b: { 0: [count, count] },
          statementMap: { 0: { start: { line: 1 } } },
        },
      ])
    );
  const run = () =>
    spawnSync(process.execPath, [path.join(temp, 'scripts/check-security-coverage.js')], {
      cwd: temp,
      encoding: 'utf8',
      timeout: 30000,
      windowsHide: true,
    });
  const stale = path.join(temp, 'coverage', 'coverage-final.json');
  const current = path.join(
    temp,
    option(scripts['test:coverage'], '--reports-dir'),
    'coverage-final.json'
  );
  fs.mkdirSync(path.dirname(current), { recursive: true });
  fs.writeFileSync(stale, JSON.stringify(report(1)));
  const missing = run();
  assert.equal(missing.error, undefined);
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /Coverage report is missing/);
  fs.writeFileSync(current, JSON.stringify(report(0)));
  const failed = run();
  assert.equal(failed.error, undefined);
  assert.notEqual(failed.status, 0);
  assert.match(failed.stderr, /Security boundary coverage failed/);
  fs.writeFileSync(stale, JSON.stringify(report(0)));
  fs.writeFileSync(current, JSON.stringify(report(1)));
  const passed = run();
  assert.equal(passed.error, undefined);
  assert.equal(passed.status, 0);
  assert.match(passed.stdout, /coverage-security.*ok/);
});

test('real c8 frontend cleanup preserves proxy and client raw coverage data', (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'hpm-coverage-isolation-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const sentinels = suites.map((suite) => {
    const directory = path.join(temp, option(scripts[suite], '--temp-directory'));
    fs.mkdirSync(directory, { recursive: true });
    const sentinel = path.join(directory, 'existing-data.txt');
    fs.writeFileSync(sentinel, suite);
    return sentinel;
  });
  const c8 = path.join(path.dirname(require.resolve('c8/package.json')), 'bin/c8.js');
  const result = spawnSync(
    process.execPath,
    [
      c8,
      '--clean',
      '--temp-directory',
      path.join(temp, option(scripts['test:frontend:coverage'], '--temp-directory')),
      '--reports-dir',
      path.join(temp, 'reports'),
      '--reporter=json',
      process.execPath,
      '-e',
      'void 0',
    ],
    { cwd: temp, encoding: 'utf8', timeout: 30000, windowsHide: true }
  );
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0);
  assert.equal(fs.existsSync(sentinels[2]), false);
  for (let i = 0; i < 2; i++) assert.equal(fs.readFileSync(sentinels[i], 'utf8'), suites[i]);
});

test('coverage isolation regression is discovered by the unified unit gate', () => {
  assert.ok(
    selectUnitTestFiles(discoverTestFiles(root), { excludedPrefixes: ['test/frontend/'] }).includes(
      'test/governance/coverage-isolation.test.js'
    )
  );
});
