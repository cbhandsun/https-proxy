'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const assert = require('node:assert/strict');
const { createBenchmarkCases } = require('../scripts/lib/protocol-benchmark-cases');
const {
  parseArguments,
  measureCase,
  sanitizeWorkerResult,
} = require('../scripts/lib/protocol-benchmark-runner');
const BENCHMARK_CLI_TIMEOUT_MS = 180_000;
for (const args of [
  ['--iterations', '0'],
  ['--samples', '10'],
  ['--iterations', '1.5'],
  ['--iterations', '1SECRET'],
  ['--warmup', '-1'],
  ['--output', 'SECRET'],
  ['--output'],
  ['--unknown', 'SECRET'],
  ['--samples', '1', '--samples', '2'],
])
  assert.throws(
    () => parseArguments(args),
    (error) => !error.message.includes('SECRET')
  );
assert.equal(parseArguments(['--warmup', '0', '--iterations', '1', '--samples', '1']).warmup, 0);
assert.throws(() => measureCase('SECRET', 'native', 1, 0));
assert.throws(() => measureCase('responses-claude', 'SECRET', 1, 0));
const cases = createBenchmarkCases();
assert.equal(new Set(cases.map((entry) => entry.id)).size, 21);
for (const entry of cases) {
  const results = entry.variants.map((variant) => entry.run(variant, true));
  if (results.length === 2) assert.equal(results[0].fingerprint, results[1].fingerprint, entry.id);
  const sample = measureCase(entry.id, entry.variants[0], 2, 0);
  assert.equal(sample.parityVerified, true);
  for (const field of [
    'cpuMicrosPerOperation',
    'wallMillisPerOperation',
    'sampledHeapPeakBytes',
    'sampledRssPeakBytes',
    'outputBytes',
  ])
    assert.ok(Number.isFinite(sample[field]) && sample[field] >= 0);
  assert.ok(!JSON.stringify(sample).includes('synthetic'));
  const options = { iterations: 2, warmup: 0 };
  const clean = sanitizeWorkerResult(
    { ...sample, content: 'SECRET', headers: { token: 'SECRET' } },
    entry,
    entry.variants[0],
    options
  );
  assert.ok(!JSON.stringify(clean).includes('SECRET'));
  assert.throws(() =>
    sanitizeWorkerResult(
      { ...sample, cpuMicrosPerOperation: Infinity },
      entry,
      entry.variants[0],
      options
    )
  );
  assert.throws(() =>
    sanitizeWorkerResult({ ...sample, sourceHash: 'SECRET' }, entry, entry.variants[0], options)
  );
}
assert.equal(
  cases.find((entry) => entry.id === 'slow-client-overflow').run('guard').bufferedPayloadPeakBytes,
  2048
);
assert.equal(cases.find((entry) => entry.id === 'slow-client-cancel').run('guard').stopped, true);

// Exercise the actual CLI, then the repository's formatter. Benchmark reports
// must remain compatible with verify after every run, not just manual cleanup.
const root = path.resolve(__dirname, '..');
const parent = path.join(root, 'tmp');
fs.mkdirSync(parent, { recursive: true });
const directory = fs.mkdtempSync(path.join(parent, 'protocol-report-test-'));
const output = path.join(directory, 'report.json');
try {
  const result = spawnSync(
    process.execPath,
    [
      'scripts/benchmark-protocol-conversion.js',
      '--iterations',
      '1',
      '--warmup',
      '0',
      '--samples',
      '1',
      '--output',
      output,
    ],
    { cwd: root, encoding: 'utf8', timeout: BENCHMARK_CLI_TIMEOUT_MS }
  );
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(fs.readFileSync(output, 'utf8'));
  assert.ok(report.samples.length > 0);
  assert.ok(report.samples.every((sample) => sample.parityVerified));
  const check = spawnSync(
    process.execPath,
    [
      require.resolve('prettier/bin/prettier.cjs'),
      '--check',
      output,
      '--ignore-path',
      '.prettierignore',
    ],
    { cwd: root, encoding: 'utf8', timeout: 10000 }
  );
  assert.equal(check.status, 0, check.stdout + check.stderr);
} finally {
  if (fs.existsSync(output)) fs.unlinkSync(output);
  fs.rmdirSync(directory);
}
