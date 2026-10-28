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
    'scenario: [n08, n09, n09-sending-ack, n09-finished-ack, n09-withdrawn-ack, n09-uncertain-ack, n09-sending-commit, n09-finished-commit, n09-withdrawn-commit, n09-uncertain-commit]',
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

test('same SHA source gates run once before ten isolated runtime scenarios with all original commands', () => {
  assertHostedGates(workflow);
});

for (const mutation of [
  [
    'missing original n09 scenario',
    (source) =>
      source.replace(
        'scenario: [n08, n09, n09-sending-ack, n09-finished-ack, n09-withdrawn-ack, n09-uncertain-ack, n09-sending-commit, n09-finished-commit, n09-withdrawn-commit, n09-uncertain-commit]',
        'scenario: [n08, n09-sending-ack, n09-finished-ack]'
      ),
  ],
  [
    'missing sending ACK group',
    (source) =>
      source.replace(
        'scenario: [n08, n09, n09-sending-ack, n09-finished-ack, n09-withdrawn-ack, n09-uncertain-ack, n09-sending-commit, n09-finished-commit, n09-withdrawn-commit, n09-uncertain-commit]',
        'scenario: [n08, n09, n09-finished-ack]'
      ),
  ],
  [
    'missing finished ACK group',
    (source) =>
      source.replace(
        'scenario: [n08, n09, n09-sending-ack, n09-finished-ack, n09-withdrawn-ack, n09-uncertain-ack, n09-sending-commit, n09-finished-commit, n09-withdrawn-commit, n09-uncertain-commit]',
        'scenario: [n08, n09, n09-sending-ack]'
      ),
  ],
  ...['withdrawn', 'uncertain'].map((name) => [
    'missing ' + name + ' ACK group',
    (source) =>
      source.replace(
        'scenario: [n08, n09, n09-sending-ack, n09-finished-ack, n09-withdrawn-ack, n09-uncertain-ack, n09-sending-commit, n09-finished-commit, n09-withdrawn-commit, n09-uncertain-commit]',
        'scenario: [n08, n09, n09-sending-ack, n09-finished-ack, n09-withdrawn-ack, n09-uncertain-ack, n09-sending-commit, n09-finished-commit, n09-withdrawn-commit, n09-uncertain-commit]'.replace(
          ', n09-' + name + '-ack',
          ''
        )
      ),
  ]),
  ...['sending', 'finished', 'withdrawn', 'uncertain'].map((name) => [
    'missing ' + name + ' COMMIT group',
    (source) =>
      source.replace(
        'scenario: [n08, n09, n09-sending-ack, n09-finished-ack, n09-withdrawn-ack, n09-uncertain-ack, n09-sending-commit, n09-finished-commit, n09-withdrawn-commit, n09-uncertain-commit]',
        'scenario: [n08, n09, n09-sending-ack, n09-finished-ack, n09-withdrawn-ack, n09-uncertain-ack, n09-sending-commit, n09-finished-commit, n09-withdrawn-commit, n09-uncertain-commit]'.replace(
          ', n09-' + name + '-commit',
          ''
        )
      ),
  ]),
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

test('actual source gate preserves original failure and checks its receipt before audit', () => {
  const { spawnSync } = require('node:child_process');
  const source = job(workflow, 'source-gates');
  const lines = source.split('\n');
  const start = lines.findIndex((line) => line.trim() === '- name: Require unified source gates');
  assert.ok(start >= 0);
  const run = lines.findIndex((line, index) => index > start && line.trim() === 'run: |');
  assert.ok(run > start);
  const body = [];
  for (let index = run + 1; index < lines.length; index++) {
    if (lines[index].trim() && !lines[index].startsWith('          ')) break;
    body.push(lines[index].slice(10));
  }
  const code = body.join('\n');
  assert.ok(source.includes("HPM_COVERAGE_IO_VERIFY_PROXY_ONLY: '1'"));
  assert.ok(source.includes('HPM_COVERAGE_IO: ${{ github.sha }}'));
  assert.ok(code.includes('finally {'));
  const cases = [
    { verify: 0, receipt: 0, audit: 0, error: null, commands: ['verify', 'receipt', 'audit'] },
    {
      verify: 1,
      receipt: 0,
      audit: 0,
      error: 'Unified verification failed.',
      commands: ['verify', 'receipt'],
    },
    {
      verify: 0,
      receipt: 1,
      audit: 0,
      error: 'Source-gate I/O receipt failed.',
      commands: ['verify', 'receipt'],
    },
    {
      verify: 1,
      receipt: 1,
      audit: 0,
      error: 'Unified verification failed.',
      commands: ['verify', 'receipt'],
    },
    {
      verify: 0,
      receipt: 0,
      audit: 1,
      error: 'Dependency audit failed.',
      commands: ['verify', 'receipt', 'audit'],
    },
  ];
  const script = `$ErrorActionPreference='Stop';$inputData=[Console]::In.ReadToEnd()|ConvertFrom-Json;
function npm {if($args.Count -eq 2 -and $args[0] -ceq 'run' -and $args[1] -ceq 'verify'){$script:seen.Add('verify');$global:LASTEXITCODE=$script:row.verify}elseif($args.Count -eq 2 -and $args[0] -ceq 'audit' -and $args[1] -ceq '--audit-level=high'){$script:seen.Add('audit');$global:LASTEXITCODE=$script:row.audit}else{throw 'unexpected_npm'}}
function node {if($args.Count -ne 1 -or $args[0] -cne 'scripts/check-coverage-io-receipt.cjs'){throw 'unexpected_node'};$script:seen.Add('receipt');$global:LASTEXITCODE=$script:row.receipt}
$results=@(foreach($script:row in $inputData.cases){$script:seen=[Collections.Generic.List[string]]::new();$failure=$null;try{& ([scriptblock]::Create($inputData.code))}catch{$failure=$_.Exception.Message};[ordered]@{error=$failure;commands=@($script:seen)}});ConvertTo-Json -Depth 5 -Compress -InputObject $results`;
  const result = spawnSync(
    'pwsh',
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
    { input: JSON.stringify({ code, cases }), encoding: 'utf8', timeout: 5000, maxBuffer: 8192 }
  );
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0);
  assert.deepEqual(
    JSON.parse(result.stdout),
    cases.map(({ error, commands }) => ({ error, commands }))
  );
  assert.equal(
    result.stderr.trim(),
    'Source-gate I/O receipt failed; original verification remains failed.'
  );
});
