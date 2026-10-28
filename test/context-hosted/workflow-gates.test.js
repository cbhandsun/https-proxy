'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const workflow = fs
  .readFileSync(
    path.join(__dirname, '../../.github/workflows/windows-context-recovery-hosted.yml'),
    'utf8'
  )
  .replaceAll('\r\n', '\n');
const checkout = 'actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd';
const setupNode = 'actions/setup-node@48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e';
const dependencies = [
  'npm ci',
  "if ($LASTEXITCODE -ne 0) { throw 'Source dependencies failed.' }",
  'npm ci --prefix plugins/hpm-local-evidence --ignore-scripts',
  "if ($LASTEXITCODE -ne 0) { throw 'Local evidence build dependencies failed.' }",
  'rustup default stable',
  "if ($LASTEXITCODE -ne 0) { throw 'Native build toolchain failed.' }",
];
const gates = [
  'npm run verify',
  "if ($LASTEXITCODE -ne 0) { throw 'Unified verification failed.' }",
  'npm audit --audit-level=high',
  "if ($LASTEXITCODE -ne 0) { throw 'Dependency audit failed.' }",
];
function job(source, name) {
  const lines = source.split('\n');
  const start = lines.indexOf('  ' + name + ':');
  assert.ok(start >= 0, 'missing job ' + name);
  const next = lines.findIndex((line, index) => index > start && /^ {2}[a-z][a-z-]*:$/.test(line));
  return lines.slice(start, next < 0 ? undefined : next).join('\n');
}
function orderedLines(source, expected) {
  const lines = source.split('\n').map((line) => line.trim());
  let previous = -1;
  for (const line of expected) {
    const index = lines.indexOf(line, previous + 1);
    assert.ok(index > previous, 'missing or reordered literal line: ' + line);
    previous = index;
  }
}
function assertHostedGates(source) {
  const gatesJob = job(source, 'source-gates');
  const runtime = job(source, 'context-recovery');
  for (const current of [gatesJob, runtime]) {
    orderedLines(current, ['runs-on: windows-latest', 'timeout-minutes: 90']);
    orderedLines(current, [
      '- uses: ' + checkout + ' # v6.0.2',
      'ref: ${{ github.sha }}',
      'persist-credentials: false',
      '- uses: ' + setupNode + ' # v6.4.0',
      'node-version: 22',
      'cache: npm',
      ...dependencies,
    ]);
    assert.equal(current.includes('continue-on-error:'), false);
    assert.equal(current.includes('upload-artifact'), false);
    assert.equal(current.includes('download-artifact'), false);
    assert.equal(current.includes('||'), false);
  }
  orderedLines(gatesJob, ["$ErrorActionPreference = 'Stop'", ...gates]);
  assert.equal(gatesJob.includes('if:'), false);
  assert.equal((source.match(/^\s+npm run verify$/gm) || []).length, 1);
  assert.equal((source.match(/^\s+npm audit --audit-level=high$/gm) || []).length, 1);
  orderedLines(runtime, [
    'needs: source-gates',
    'fail-fast: false',
    'scenario: [n08, n09, n09-sending-ack, n09-finished-ack]',
    '- name: Build runner-local payload and fixed review plan',
    "$ErrorActionPreference = 'Stop'",
    'node scripts/prepare-context-hosted-run.js $env:SCENARIO',
    "if ($LASTEXITCODE -ne 0) { throw 'Fixed payload preparation failed.' }",
    '- name: Run fixed scenario under original bounded Job',
    "$ErrorActionPreference = 'Stop'",
    './scripts/qualify-context-hosted.ps1 -Case $env:SCENARIO',
    '- name: Record bounded outcome',
    'if: always()',
    'JOB_STATUS: ${{ job.status }}',
  ]);
  assert.equal(
    runtime.slice(0, runtime.indexOf('- name: Record bounded outcome')).includes('if:'),
    false
  );
  assert.equal((runtime.match(/SCENARIO: \$\{\{ matrix.scenario \}\}/g) || []).length, 3);
  assert.equal(runtime.includes('npm run verify'), false);
  assert.equal(runtime.includes('npm audit'), false);
  assert.ok(source.includes('permissions:\n  contents: read\n'));
}

test('same SHA source gates run once before four isolated runtime scenarios with all original commands', () => {
  assertHostedGates(workflow);
});

for (const mutation of [
  [
    'missing original n09 scenario',
    (source) =>
      source.replace(
        'scenario: [n08, n09, n09-sending-ack, n09-finished-ack]',
        'scenario: [n08, n09-sending-ack, n09-finished-ack]'
      ),
  ],
  [
    'missing sending ACK group',
    (source) =>
      source.replace(
        'scenario: [n08, n09, n09-sending-ack, n09-finished-ack]',
        'scenario: [n08, n09, n09-finished-ack]'
      ),
  ],
  [
    'missing finished ACK group',
    (source) =>
      source.replace(
        'scenario: [n08, n09, n09-sending-ack, n09-finished-ack]',
        'scenario: [n08, n09, n09-sending-ack]'
      ),
  ],
  ['missing dependency edge', (source) => source.replace('    needs: source-gates\n', '')],
  ['missing literal verify', (source) => source.replace('          npm run verify\n', '')],
  [
    'missing literal audit',
    (source) => source.replace('          npm audit --audit-level=high\n', ''),
  ],
  [
    'ignored source failure',
    (source) =>
      source.replace(
        "if ($LASTEXITCODE -ne 0) { throw 'Unified verification failed.' }",
        'Write-Output done'
      ),
  ],
  [
    'ignored runtime preparation failure',
    (source) =>
      source.replace(
        "if ($LASTEXITCODE -ne 0) { throw 'Fixed payload preparation failed.' }",
        'Write-Output done'
      ),
  ],
  [
    'soft runtime failure',
    (source) =>
      source.replace('  context-recovery:\n', '  context-recovery:\n    continue-on-error: true\n'),
  ],
  [
    'unconditional runtime after failed gates',
    (source) =>
      source.replace('    needs: source-gates\n', '    needs: source-gates\n    if: always()\n'),
  ],
  [
    'checkout from another revision',
    (source) => source.replace('ref: ${{ github.sha }}', 'ref: main'),
  ],
  [
    'changed runtime timeout',
    (source) =>
      source.replace(
        '    needs: source-gates\n    runs-on: windows-latest\n    timeout-minutes: 90',
        '    needs: source-gates\n    runs-on: windows-latest\n    timeout-minutes: 120'
      ),
  ],
]) {
  test('workflow governance rejects ' + mutation[0], () => {
    assert.throws(() => assertHostedGates(mutation[1](workflow)));
  });
}
