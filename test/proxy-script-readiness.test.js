'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

test('PowerShell readiness uses bounded authenticated HTTP without a short TCP veto', () => {
  const script = `
$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'
$ast=[System.Management.Automation.Language.Parser]::ParseFile((Join-Path (Get-Location) 'proxy.ps1'),[ref]$null,[ref]$null)
$definition=$ast.Find({param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Get-ProxyHealth'},$true)
Invoke-Expression $definition.Extent.Text
function Get-ManagementPort { return 3543 }
function Get-ManagementToken { return 'synthetic-test-token' }
function Test-LocalTcpPort { throw 'TCP veto must not run' }
function Invoke-RestMethod {
  param($Uri,$Headers,$TimeoutSec,$ErrorAction,[switch]$UseBasicParsing)
  if ($Uri -ne 'http://127.0.0.1:3543/v1/local/health' -or $TimeoutSec -ne 2 -or $Headers['x-mgmt-token'] -ne 'synthetic-test-token') { throw 'Invalid readiness request' }
  if ($script:mode -eq 'error') { throw 'Synthetic HTTP failure' }
  if ($script:mode -eq 'wrong-app') { return @{appId='other';pid=1} }
  return @{appId='https-proxy-manager';pid=123}
}
foreach ($script:mode in @('healthy','wrong-app','error')) {
  $health=Get-ProxyHealth
  if ($script:mode -eq 'healthy') { if ($health.pid -ne 123) { throw 'Healthy service rejected' } }
  elseif ($null -ne $health) { throw 'Unhealthy service accepted' }
}
Write-Output 'READINESS_OK'
`;
  const result = spawnSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-EncodedCommand',
      Buffer.from(script, 'utf16le').toString('base64'),
    ],
    {
      cwd: path.resolve(__dirname, '..'),
      windowsHide: true,
      encoding: 'utf8',
      timeout: 30000,
    }
  );
  assert.equal(result.status, 0, 'PowerShell readiness regression failed');
  assert.ok(result.stdout.includes('READINESS_OK'));
});

test('startup distinguishes a live unready launcher, an exited launcher and delayed health', () => {
  const script = `
$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'
$ast=[System.Management.Automation.Language.Parser]::ParseFile((Join-Path (Get-Location) 'proxy.ps1'),[ref]$null,[ref]$null)
$definition=$ast.Find({param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Start-Proxy'},$true)
Invoke-Expression $definition.Extent.Text
function Test-NodeInstalled { return $true }
function Test-Path { return $true }
function Release-OccupiedPorts { return $true }
function Write-DebugTiming {}
function Reset-LogFileIfBinary {}
function Start-Sleep {}
function Get-ManagementPort { return 3543 }
function Get-AllProxyProcesses { return @() }
function Get-EntryAddresses { return @() }
function Get-Content { return @() }
function Out-File { param($FilePath,$Encoding) $script:writes++ }
function Get-Process { return @{Id=123} }
function Write-Status { param($Icon,$Message) $script:statuses+=@{Icon=$Icon;Message=$Message} }
function Start-ProxyLauncher { return @{Id=123;HasExited=($script:mode -eq 'exited');ExitCode=7} }
function Get-ProxyHealth {
  $script:probes++
  if ($script:mode -eq 'delayed' -and $script:probes -ge 3) { return @{pid=123} }
  return $null
}
$JsFile='synthetic.js'; $ConfigFile='synthetic.json'; $ConfigDir=$env:TEMP; $RuntimeDir=$env:TEMP; $PidFile='synthetic.pid'; $LogFile='synthetic.log'; $ErrLogFile='synthetic.err'; $PortWasSpecified=$false
foreach ($script:mode in @('alive','exited','delayed')) {
  $script:statuses=@(); $script:probes=0; $script:writes=0
  Start-Proxy
  $messages=($script:statuses | ForEach-Object { $_.Message }) -join '|'
  if ($script:mode -eq 'alive') {
    if ($messages -notmatch 'process is running but management health is not ready' -or $messages -match 'Exited immediately|Proxy started' -or $script:writes -ne 1) { throw 'Live launcher misclassified' }
  } elseif ($script:mode -eq 'exited') {
    if ($messages -notmatch 'Exited immediately.*7' -or $script:writes -ne 0) { throw 'Exited launcher misclassified' }
  } elseif ($messages -notmatch 'Proxy started' -or $messages -match 'Exited immediately|health is not ready') { throw 'Delayed readiness rejected' }
}
Write-Output 'STARTUP_OK'
`;
  const result = spawnSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-EncodedCommand',
      Buffer.from(script, 'utf16le').toString('base64'),
    ],
    {
      cwd: path.resolve(__dirname, '..'),
      windowsHide: true,
      encoding: 'utf8',
      timeout: 30000,
    }
  );
  assert.equal(result.status, 0, 'PowerShell startup classification regression failed');
  assert.ok(result.stdout.includes('STARTUP_OK'));
});
