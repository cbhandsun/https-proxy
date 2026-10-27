'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '../..');
const source = fs.readFileSync(path.join(root, 'scripts/qualify-context-hosted.ps1'), 'utf8');
const start = source.indexOf('    foreach ($file in @($reviewFile, $receiptFile, $execution))');
const end = source.indexOf('    if ((Get-Item -LiteralPath $receiptFile).Length', start);

test('qualification validates all path ancestors before receipt reads, hashing or execution', () => {
  assert.ok(start >= 0 && end > start);
  const before = source.slice(0, end);
  assert.equal(before.includes('ReadAllText'), false);
  assert.equal(before.includes('Get-FileHash'), false);
  assert.equal(before.includes('    . $execution'), false);
  assert.ok(source.indexOf('ReadAllText') > end);
  assert.ok(source.indexOf('Get-FileHash') > end);
  assert.ok(source.indexOf('    . $execution') > end);
});

for (const rejected of [false, true])
  test(
    `qualification path guard ${rejected ? 'rejects reparse before reading' : 'accepts physical ancestors before reading'}`,
    {
      skip: process.platform !== 'win32',
      timeout: 30000,
    },
    () => {
      const script = `
      $ErrorActionPreference = 'Stop'
      $reviewFile = 'C:\\owned\\review.json'
      $receiptFile = 'C:\\owned\\receipt.json'
      $execution = 'C:\\repo\\execution.ps1'
      $script:visited = [Collections.Generic.List[string]]::new()
      function Get-Item {
        param([string]$LiteralPath, [switch]$Force)
        $script:visited.Add($LiteralPath)
        $attributes = [IO.FileAttributes]::Normal
        if (${rejected ? '$true' : '$false'} -and $LiteralPath -eq 'C:\\owned') {
          $attributes = [IO.FileAttributes]::ReparsePoint
        }
        return @{ Attributes = $attributes }
      }
      $read = $false
      $rejected = $false
      try {
        ${source.slice(start, end)}
        $read = $true
      } catch { $rejected = $true }
      @{ read = $read; rejected = $rejected; visited = @($script:visited.ToArray()) } | ConvertTo-Json -Compress
    `;
      const result = spawnSync(
        'C:/Program Files/PowerShell/7/pwsh.exe',
        ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
        { shell: false, windowsHide: true, timeout: 25000, maxBuffer: 8192, encoding: 'utf8' }
      );
      assert.equal(result.error, undefined);
      assert.equal(result.status, 0);
      const observed = JSON.parse(result.stdout);
      assert.equal(observed.rejected, rejected);
      assert.equal(observed.read, !rejected);
      assert.ok(observed.visited.includes('C:\\owned'));
      assert.equal(observed.visited.includes('C:\\repo\\execution.ps1'), !rejected);
    }
  );

test('always summary makes generation conditional on reaching preparation stages', () => {
  const workflow = fs.readFileSync(
    path.join(root, '.github/workflows/windows-context-recovery-hosted.yml'),
    'utf8'
  );
  assert.ok(workflow.includes('if: always()'));
  assert.ok(workflow.includes('When their preparation stages run,'));
  assert.equal(workflow.includes('were generated only'), false);
});

test(
  'always summary reports scenario scope only for the matching successful job',
  {
    timeout: 30000,
  },
  () => {
    const producer = fs.readFileSync(
      path.join(root, 'scripts/context-hosted/n09/owned-entry.js'),
      'utf8'
    );
    const consumer = fs.readFileSync(
      path.join(root, 'scripts/context-hosted/n09/owned-job.ps1'),
      'utf8'
    );
    const produced = [...producer.matchAll(/^\s+cases:\s*(\d+),\s*$/gm)];
    const consumed = [...consumer.matchAll(/GetProperty\('cases'\)\.GetInt32\(\) -ne (\d+)/g)];
    assert.equal(produced.length, 1);
    assert.equal(consumed.length, 1);
    const expectedCases = Number(produced[0][1]);
    assert.equal(Number(consumed[0][1]), expectedCases);
    const workflow = fs
      .readFileSync(
        path.join(root, '.github/workflows/windows-context-recovery-hosted.yml'),
        'utf8'
      )
      .replaceAll('\r\n', '\n');
    const begin = workflow.indexOf(
      '          @(\n',
      workflow.indexOf('- name: Record bounded outcome')
    );
    const end = workflow.indexOf('          ) >> $env:GITHUB_STEP_SUMMARY', begin);
    assert.ok(begin >= 0 && end > begin);
    const expression = workflow.slice(begin, end) + '          )';
    const result = spawnSync(
      process.platform === 'win32' ? 'C:/Program Files/PowerShell/7/pwsh.exe' : 'pwsh',
      [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `
      $ErrorActionPreference = 'Stop'
      $env:GITHUB_SHA = 'synthetic-source'
      $rows = foreach ($case in @(
        @('n09', 'success'), @('n08', 'success'), @('n09', 'failure'),
        @('n09', 'cancelled'), @('n08', 'skipped'), @('', ''),
        @('n09', 'SUCCESS'), @('unrecognized', 'success')
      )) {
        $env:SCENARIO = $case[0]
        $env:JOB_STATUS = $case[1]
        $summary = ${expression}
        @{ scenario = $case[0]; status = $case[1]; summary = @($summary) }
      }
      ConvertTo-Json -Depth 4 -Compress -InputObject @($rows)
    `,
      ],
      { shell: false, windowsHide: true, timeout: 25000, maxBuffer: 32768, encoding: 'utf8' }
    );
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0);
    const rows = JSON.parse(result.stdout);
    assert.equal(rows.length, 8);
    for (const row of rows) {
      const scopes = row.summary.filter((line) => line.startsWith('Passed scope:'));
      const qualified = row.status === 'success' && ['n08', 'n09'].includes(row.scenario);
      assert.equal(scopes.length, qualified ? 1 : 0);
      if (qualified) {
        if (row.scenario === 'n09') {
          const reported = scopes[0].match(/^Passed scope: (\d+) cases:/);
          assert.ok(reported);
          assert.equal(Number(reported[1]), expectedCases);
        }
        assert.ok(
          scopes[0].includes(
            row.scenario === 'n09'
              ? 'cases: committed metadata, clear ACK, save ACK, revoke ACK, same-format backup rollback after revoke, interruption with the upstream public final held, prepared SQLite COMMIT pending forced-kill/positive-release controls, and prepared durable-store-before-host-ACK forced-kill/positive-release controls'
              : 'six mutation/hold cases'
          )
        );
      }
      const prepared = row.scenario === 'n09' && row.status === 'success';
      assert.ok(
        row.summary.some((line) =>
          line.includes(
            prepared
              ? 'Not qualified: other publication COMMIT interiors (sending, transport-finished, uncertain, withdrawn), other daemon durable-ACK interiors (sending, transport-finished, uncertain, withdrawn)'
              : 'Not qualified: commit/publication in progress'
          )
        )
      );
      assert.equal(
        row.summary.some((line) => line.includes('prepared SQLite COMMIT pending')),
        prepared
      );
      assert.equal(
        row.summary.some((line) => line.includes('Not qualified: save/revoke durable ACK')),
        false
      );
    }
  }
);
