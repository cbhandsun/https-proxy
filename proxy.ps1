<#
.SYNOPSIS
  HTTPS proxy management script
.DESCRIPTION
  Manages openai-proxy.js start, stop, status, logs, and health checks.
#>

param(
    [Parameter(Position = 0)][ValidateSet('start','stop','restart','status','logs','tail','open','health','config','trust-cert')][string]$Command = 'start',
    [Alias('p')][int]$Port = 3443,
    [Alias('t')][string]$Target = '',
    [Alias('k')][string]$ApiKey = '',
    [string]$ModelRewriteFrom = '',
    [string]$ModelRewriteTo = ''
)

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$PortWasSpecified = $PSBoundParameters.ContainsKey('Port')
$DataDir = $ScriptDir
if ($env:PROXY_DATA_DIR) { $DataDir = $env:PROXY_DATA_DIR }
New-Item -ItemType Directory -Path $DataDir -Force | Out-Null
$PidFile = Join-Path $DataDir '.proxy.pid'
$LogFile = Join-Path $DataDir 'proxy.log'
$ErrLogFile = Join-Path $DataDir 'proxy.err.log'
$ConfigFile = Join-Path $DataDir 'proxy.config.json'
$JsFile = Join-Path $ScriptDir 'openai-proxy.js'
$BundledNode = Join-Path $ScriptDir 'runtime\node\node.exe'
$NodeExe = (Get-Command 'node' -ErrorAction SilentlyContinue).Source
if (Test-Path $BundledNode) { $NodeExe = $BundledNode }
$BundledOpenSsl = Join-Path $ScriptDir 'runtime\openssl\bin\openssl.exe'
if (-not $env:PROXY_OPENSSL_EXE -and (Test-Path $BundledOpenSsl)) { $env:PROXY_OPENSSL_EXE = $BundledOpenSsl }

function Write-Status {
    param([string]$Icon, [string]$Message)
    Write-Host "$(Get-Date -Format 'HH:mm:ss') $Icon $Message"
}

function Test-NodeInstalled {
    if (-not $NodeExe) { Write-Status 'x' 'Node.js not found'; return $false }
    return $true
}

function Get-ProxyCommandLine {
    param([int]$ProcessId)
    try {
        $escaped = ("ProcessId = {0}" -f $ProcessId)
        $proc = Get-CimInstance Win32_Process -Filter $escaped -ErrorAction Stop
        return [string]$proc.CommandLine
    } catch {
        return ''
    }
}

function Test-IsProxyProcess {
    param($Process)
    if (-not $Process -or $Process.ProcessName -ne 'node') { return $false }
    $commandLine = Get-ProxyCommandLine -ProcessId $Process.Id
    if (-not $commandLine) { return $true }
    return $commandLine -like "*$JsFile*" -or $commandLine -like '*openai-proxy.js*'
}

function Get-ProxyProcess {
    if (-not (Test-Path $PidFile)) { return $null }

    $rawPid = Get-Content $PidFile -Raw -ErrorAction SilentlyContinue
    if ($null -eq $rawPid) {
        Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
        return $null
    }
    $rawPid = $rawPid.Trim()
    if (-not $rawPid -or $rawPid -notmatch '^\d+$') {
        Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
        return $null
    }

    $proc = Get-Process -Id ([int]$rawPid) -ErrorAction SilentlyContinue
    if (Test-IsProxyProcess $proc) { return $proc }

    Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
    return $null
}

function Get-PortProcess {
    try {
        $conn = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction Stop | Select-Object -First 1
        if (-not $conn) { return $null }
        return Get-Process -Id $conn.OwningProcess -ErrorAction SilentlyContinue
    } catch {
        return $null
    }
}

function Get-RunningProxyProcess {
    $proc = Get-ProxyProcess
    if ($proc) { return $proc }

    $portProc = Get-PortProcess
    if (Test-IsProxyProcess $portProc) {
        $portProc.Id | Out-File $PidFile -Encoding ASCII
        return $portProc
    }

    return $null
}

function Get-EntryAddresses {
    try {
        if (-not (Test-Path $ConfigFile)) { return @("https://localhost:$Port/v1") }
        $config = Get-Content $ConfigFile -Raw | ConvertFrom-Json
        if ($config.entryServers -and $config.entryServers.Count -gt 0 -and (-not $PortWasSpecified)) {
            return @($config.entryServers | Where-Object { $_.enabled -ne $false } | ForEach-Object {
                $hostName = 'localhost'
                if ($_.host) { $hostName = $_.host }
                $basePath = '/v1'
                if ($_.basePath) { $basePath = $_.basePath }
                "https://${hostName}:$($_.listenPort)$basePath [$($_.protocol)]"
            })
        }
    } catch {}
    return @("https://localhost:$Port/v1")
}

function Start-Proxy {
    if (-not (Test-NodeInstalled)) { return }
    if (-not (Test-Path $JsFile)) { Write-Status 'x' "Not found: $JsFile"; return }

    $existing = Get-RunningProxyProcess
    if ($existing) { Write-Status '!' "Proxy already running (PID: $($existing.Id))"; return }

    if (-not (Test-Path $ConfigFile)) {
        $bundledConfig = Join-Path $ScriptDir 'proxy.config.json'
        if (Test-Path $bundledConfig) { Copy-Item $bundledConfig $ConfigFile -Force }
    }

    $env:PROXY_DATA_DIR = $DataDir
    if ($PortWasSpecified) { $env:PORT = [string]$Port } else { Remove-Item Env:PORT -ErrorAction SilentlyContinue }
    if ($Target -ne '') { $env:TARGET = $Target }
    if ($ApiKey -ne '') { $env:API_KEY = $ApiKey }
    if ($ModelRewriteFrom -ne '') { $env:MODEL_REWRITE_FROM = $ModelRewriteFrom }
    if ($ModelRewriteTo -ne '') { $env:MODEL_REWRITE_TO = $ModelRewriteTo }

    try {
        $argList = [char]34 + $JsFile + [char]34
        $proc = Start-Process -FilePath $NodeExe -ArgumentList $argList -WorkingDirectory $ScriptDir -WindowStyle Hidden -RedirectStandardOutput $LogFile -RedirectStandardError $ErrLogFile -PassThru
        Start-Sleep -Milliseconds 1200
        if (-not $proc -or $proc.HasExited) {
            $exitCode = 'unknown'
            if ($proc) { $exitCode = $proc.ExitCode }
            Write-Status 'x' "Exited immediately (ExitCode: $exitCode)"
            return
        }

        $proc.Id | Out-File $PidFile -Encoding ASCII
        Write-Status '+' "Proxy started (PID: $($proc.Id))"
        foreach ($address in Get-EntryAddresses) { Write-Status ' ' "Address: $address" }
        Write-Status ' ' "Log: $LogFile"
    } catch {
        Write-Status 'x' "Start failed: $_"
    }
}

function Stop-Proxy {
    $proc = Get-RunningProxyProcess
    if (-not $proc) { Write-Status '!' 'Proxy is not running'; return }

    try {
        Stop-Process -Id $proc.Id -Force -ErrorAction Stop
        $null = $proc.WaitForExit(5000)
        Write-Status '+' "Proxy stopped (PID: $($proc.Id))"
    } catch {
        Write-Status 'x' "Stop failed: $_"
    } finally {
        Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
    }
}

function Get-Status {
    $proc = Get-RunningProxyProcess
    if ($proc) {
        $up = (Get-Date) - $proc.StartTime
        Write-Status '+' "Running (PID: $($proc.Id), uptime $($up.Hours)h $($up.Minutes)m)"
        foreach ($address in Get-EntryAddresses) { Write-Status ' ' "Address: $address" }
    } else {
        Write-Status '!' 'Proxy is not running'
    }
}

function Show-Logs {
    if (-not (Test-Path $LogFile)) { Write-Status '!' 'No log file'; return }
    Write-Host ('-' * 70) -ForegroundColor DarkGray
    Get-Content $LogFile -Tail 80
    Write-Host ('-' * 70) -ForegroundColor DarkGray
}

function Tail-Logs {
    if (-not (Test-Path $LogFile)) { Write-Status '!' 'No log file'; return }
    Write-Status ' ' 'Tailing logs. Press Ctrl+C to exit.'
    Get-Content $LogFile -Tail 80 -Wait
}

function Open-Logs {
    if (Test-Path $LogFile) { Invoke-Item $LogFile; return }
    Invoke-Item $DataDir
}

function Test-Health {
    $proc = Get-RunningProxyProcess
    if (-not $proc) { Write-Status 'x' 'Proxy is not running'; return }

    try {
        $client = [System.Net.Sockets.TcpClient]::new()
        $client.Connect('localhost', $Port)
        $client.Close()
        Write-Status '+' "Port reachable: https://localhost:$Port/v1"
    } catch {
        Write-Status 'x' "Port unreachable: $($_.Exception.Message)"
    }
}

function Open-Config {
    if (Test-Path $ConfigFile) { Invoke-Item $ConfigFile; return }
    Write-Status 'x' "Not found: $ConfigFile"
}

function Trust-Cert {
    if (-not (Test-NodeInstalled)) { return }
    if (-not (Test-Path $JsFile)) { Write-Status 'x' "Not found: $JsFile"; return }

    $env:PROXY_DATA_DIR = $DataDir
    $nodeScript = "const cert=require('./lib/proxy/cert'); cert.ensureCert(); console.log(cert.CA_CERT_FILE);"
    try {
        $output = & $NodeExe -e $nodeScript 2>&1
        if ($LASTEXITCODE -ne 0) {
            Write-Status 'x' "Certificate generation failed: $output"
            return
        }
        $caCert = ($output | Select-Object -Last 1).ToString().Trim()
        if (-not (Test-Path $caCert)) { Write-Status 'x' "CA certificate not found: $caCert"; return }

        Write-Status '!' "About to trust local proxy CA for current user: $caCert"
        $answer = Read-Host 'Import this certificate into CurrentUser\\Root? Type YES to continue'
        if ($answer -ne 'YES') { Write-Status '!' 'Cancelled'; return }

        Import-Certificate -FilePath $caCert -CertStoreLocation Cert:\CurrentUser\Root | Out-Null
        Write-Status '+' 'Local proxy CA imported into CurrentUser\\Root'
    } catch {
        Write-Status 'x' "Trust failed: $_"
    }
}

switch ($Command) {
    'start' { Start-Proxy }
    'stop' { Stop-Proxy }
    'restart' { Stop-Proxy; Start-Sleep -Milliseconds 800; Start-Proxy }
    'status' { Get-Status }
    'logs' { Show-Logs }
    'tail' { Tail-Logs }
    'open' { Open-Logs }
    'health' { Test-Health }
    'config' { Open-Config }
    'trust-cert' { Trust-Cert }
}
