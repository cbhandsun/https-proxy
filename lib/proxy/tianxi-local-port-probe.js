'use strict';

const childProcess = require('node:child_process');

const CONNECT_TIMEOUT_MS = 500;
const MAX_PORTS = 8;
const EXPECTED_EXECUTABLE =
  'C:\\Program Files\\Lenovo\\AIAgent\\Modules\\AgentServer\\tac-server.exe';

function validPort(value) {
  return Number.isSafeInteger(value) && value > 0 && value <= 65535;
}

function runPortProbe(script, options) {
  if (process.platform !== 'win32' && !options.forceWindows) return '';
  try {
    return (options.execFileSync || childProcess.execFileSync)(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true,
        timeout: 10000,
        maxBuffer: 1024,
      }
    );
  } catch {
    return '';
  }
}

function connectionScript(portExpression) {
  return `$client = New-Object System.Net.Sockets.TcpClient; try { $connected = $client.ConnectAsync('127.0.0.1', ${portExpression}); if ($connected.Wait(${CONNECT_TIMEOUT_MS}) -and $client.Connected) { [Console]::WriteLine(${portExpression}) } } catch {} finally { $client.Dispose() }`;
}

function parseProbePorts(output) {
  if (typeof output !== 'string' || output.length > 1024) return [];
  const lines = output.trim().split(/\r?\n/);
  if (lines.length > MAX_PORTS || lines.some((line) => !/^\d{1,5}$/.test(line))) return [];
  const ports = lines.map(Number);
  if (ports.some((port) => !validPort(port))) return [];
  return [...new Set(ports)];
}

function isLoopbackPortReachable(port, options = {}) {
  if (!validPort(port)) return false;
  const ports = parseProbePorts(runPortProbe(connectionScript(String(port)), options));
  return ports.length === 1 && ports[0] === port;
}

function discoverReachableTianxiCommandPorts(options = {}) {
  // The child emits only reachable numeric ports, never command lines or credentials.
  const script = `$ErrorActionPreference = 'Stop'; Get-CimInstance Win32_Process -Filter "Name='tac-server.exe'" | Where-Object { $_.ExecutablePath -eq '${EXPECTED_EXECUTABLE}' } | Select-Object -First ${MAX_PORTS} | ForEach-Object { $match = [regex]::Match([string]$_.CommandLine, '(?:^|\\s)-port\\s+(\\d{1,5})(?:\\s|$)'); if ($match.Success) { $port = [int]$match.Groups[1].Value; if ($port -gt 0 -and $port -le 65535) { ${connectionScript('$port')} } } }`;
  return parseProbePorts(runPortProbe(script, options));
}

module.exports = { discoverReachableTianxiCommandPorts, isLoopbackPortReachable };
