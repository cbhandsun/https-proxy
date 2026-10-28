'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

test('the actual coverage workflow scopes the native publication proxy selector and preserves every failure gate', () => {
  const workflow = fs
    .readFileSync(path.resolve(__dirname, '../.github/workflows/verify.yml'), 'utf8')
    .replaceAll('\r\n', '\n');
  const coverage = workflow.slice(
    workflow.indexOf('\n  coverage:\n'),
    workflow.indexOf('\n  integration-tests:\n')
  );
  const lines = coverage.split('\n');
  const start = lines.findIndex((line) => line.trim() === 'run: |');
  assert.ok(start >= 0);
  const body = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() && !line.startsWith('          ')) break;
    body.push(line.slice(10));
  }
  const cases = [
    { error: null },
    {
      proxy: 1,
      error: 'Original proxy coverage failed; I/O evidence does not override its failure.',
    },
    { receiptProxy: 1, error: 'Coverage I/O observation was not completed safely.' },
    { proxy: 1, receiptProxy: 1, error: 'Coverage I/O observation was not completed safely.' },
    {
      client: 1,
      error: 'Original client coverage failed; I/O evidence does not override its failure.',
    },
    { receiptClient: 1, error: 'Client coverage I/O observation was not completed safely.' },
    { frontend: 1, error: 'Original frontend coverage failed.' },
  ];
  const script = `$ErrorActionPreference='Stop';$inputData=[Console]::In.ReadToEnd()|ConvertFrom-Json;
function Seen($kind){$script:seen.Add([ordered]@{kind=$kind;stage=$env:HPM_COVERAGE_IO_STAGE;selector=[Environment]::GetEnvironmentVariable('HPM_COVERAGE_IO_PROXY_WINDOW')})}
function npm {if($args.Count -ne 2 -or $args[0] -cne 'run'){throw 'unexpected_npm'};switch -CaseSensitive ($args[1]){'test:coverage'{Seen 'proxy';$global:LASTEXITCODE=[int]$script:row.proxy}'test:client:coverage'{Seen 'client';$global:LASTEXITCODE=[int]$script:row.client}'test:frontend:coverage'{Seen 'frontend';$global:LASTEXITCODE=[int]$script:row.frontend}default{throw 'unexpected_npm'}}}
function node {if($args.Count -ne 1 -or $args[0] -cne 'scripts/check-coverage-io-receipt.cjs'){throw 'unexpected_node'};Seen ('receipt-'+$env:HPM_COVERAGE_IO_STAGE);if($env:HPM_COVERAGE_IO_STAGE -ceq 'proxy'){$global:LASTEXITCODE=[int]$script:row.receiptProxy}elseif($env:HPM_COVERAGE_IO_STAGE -ceq 'client'){$global:LASTEXITCODE=[int]$script:row.receiptClient}else{throw 'unexpected_stage'}}
$results=@(foreach($script:row in $inputData.cases){$script:seen=[Collections.Generic.List[object]]::new();$failure=$null;try{& ([scriptblock]::Create($inputData.code))}catch{$failure=$_.Exception.Message};[ordered]@{error=$failure;commands=@($script:seen)}});ConvertTo-Json -Depth 6 -Compress -InputObject $results`;
  const result = spawnSync(
    'pwsh',
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
    {
      input: JSON.stringify({ code: body.join('\n'), cases }),
      encoding: 'utf8',
      timeout: 5000,
      maxBuffer: 8192,
    }
  );
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0);
  const proxy = (kind) => ({ kind, stage: 'proxy', selector: 'native-publication-interruption' });
  const client = (kind) => ({ kind, stage: 'client', selector: null });
  assert.deepEqual(
    JSON.parse(result.stdout),
    cases.map((row) => {
      const commands = [proxy('proxy'), proxy('receipt-proxy')];
      if (!row.proxy && !row.receiptProxy) {
        commands.push(client('client'), client('receipt-client'));
        if (!row.client && !row.receiptClient) commands.push(client('frontend'));
      }
      return { error: row.error, commands };
    })
  );
  assert.deepEqual(result.stderr.trim().split(/\r?\n/), [
    'coverage_original_stage_failed:stage=proxy',
    'coverage_original_stage_failed:stage=proxy',
    'coverage_original_stage_failed:stage=client',
  ]);
});
