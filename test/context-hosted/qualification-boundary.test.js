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
