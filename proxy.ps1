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
    [string]$ModelRewriteTo = '',
    [switch]$NoReleaseOccupiedPorts,
    [switch]$ForceReleaseOccupiedPorts
)

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$PortWasSpecified = $PSBoundParameters.ContainsKey('Port')
$LegacyDataDir = $env:PROXY_DATA_DIR
$ConfigDir = $ScriptDir
if ($env:PROXY_CONFIG_DIR) { $ConfigDir = $env:PROXY_CONFIG_DIR }
elseif ($LegacyDataDir) { $ConfigDir = $LegacyDataDir }
$RuntimeDir = Join-Path $ScriptDir '.hpm-runtime'
if ($env:PROXY_RUNTIME_DIR) { $RuntimeDir = $env:PROXY_RUNTIME_DIR }
elseif ($LegacyDataDir) { $RuntimeDir = $LegacyDataDir }
$DataDir = $RuntimeDir
New-Item -ItemType Directory -Path $ConfigDir -Force | Out-Null
New-Item -ItemType Directory -Path $RuntimeDir -Force | Out-Null
$PidFile = Join-Path $RuntimeDir '.proxy.pid'
$LockFile = Join-Path $RuntimeDir '.proxy.lock'
$LogFile = Join-Path $RuntimeDir 'proxy.log'
$ErrLogFile = Join-Path $RuntimeDir 'proxy.err.log'
$ConfigFile = Join-Path $ConfigDir 'proxy.config.json'
$JsFile = Join-Path $ScriptDir 'openai-proxy.js'
$BundledNode = Join-Path $ScriptDir 'runtime\node\node.exe'
$NodeExe = (Get-Command 'node' -ErrorAction SilentlyContinue).Source
if (Test-Path $BundledNode) { $NodeExe = $BundledNode }
$script:ExitCode = 0
$script:CommandLineCache = @{}

function Write-Status {
    param([string]$Icon, [string]$Message)
    if ($Icon -eq 'x') { $script:ExitCode = 1 }
    Write-Host "$(Get-Date -Format 'HH:mm:ss') $Icon $Message"
}

function Write-DebugTiming {
    param([string]$Label, [long]$StartMs)
    if ($env:PROXY_DEBUG_TIMING -eq '1') {
        Write-Status ' ' ("timing {0}: {1}ms" -f $Label, ([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() - $StartMs))
    }
}

function Test-NodeInstalled {
    if (-not $NodeExe) { Write-Status 'x' 'Node.js not found'; return $false }
    return $true
}

function Get-ProxyCommandLine {
    param([int]$ProcessId)
    if ($script:CommandLineCache.ContainsKey($ProcessId)) {
        return $script:CommandLineCache[$ProcessId]
    }
    try {
        $escaped = ("ProcessId = {0}" -f $ProcessId)
        $proc = Get-CimInstance Win32_Process -Filter $escaped -ErrorAction Stop
        $commandLine = [string]$proc.CommandLine
        $script:CommandLineCache[$ProcessId] = $commandLine
        return $commandLine
    } catch {
        $script:CommandLineCache[$ProcessId] = ''
        return ''
    }
}

function Test-IsProxyProcess {
    param($Process)
    if (-not $Process -or $Process.ProcessName -ne 'node') { return $false }
    $commandLine = Get-ProxyCommandLine -ProcessId $Process.Id
    if (-not $commandLine) { return $false }
    return $commandLine -like "*$JsFile*" -or $commandLine -like '*openai-proxy.js*'
}

function Invoke-WithProxyLock {
    param(
        [scriptblock]$Action,
        [int]$TimeoutMs = 10000
    )

    $stream = $null
    $deadline = (Get-Date).AddMilliseconds($TimeoutMs)
    while ($null -eq $stream) {
        try {
            $stream = [System.IO.File]::Open($LockFile, [System.IO.FileMode]::OpenOrCreate, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)
        } catch {
            if ((Get-Date) -ge $deadline) {
                Write-Status 'x' 'Another proxy operation is still running; please retry in a moment.'
                return
            }
            Start-Sleep -Milliseconds 120
        }
    }

    try {
        & $Action
    } finally {
        if ($stream) { $stream.Dispose() }
    }
}

function Get-PortListeners {
    param(
        [int[]]$Ports = $(Get-ConfiguredPorts),
        [switch]$IncludeCommandLine
    )

    $listeners = @()
    $listenPorts = @($Ports | Select-Object -Unique)
    if ($listenPorts.Count -eq 0) { return @() }
    try {
        $connections = @(Get-NetTCPConnection -LocalPort $listenPorts -State Listen -ErrorAction SilentlyContinue)
        foreach ($conn in $connections) {
            $proc = Get-Process -Id $conn.OwningProcess -ErrorAction SilentlyContinue
            $commandLine = ''
            if ($IncludeCommandLine -and $proc -and $proc.ProcessName -eq 'node') { $commandLine = Get-ProxyCommandLine -ProcessId $proc.Id }
            $isProxy = $false
            if ($proc -and $proc.ProcessName -eq 'node' -and $commandLine) {
                $isProxy = $commandLine -like "*$JsFile*" -or $commandLine -like '*openai-proxy.js*'
            }
            $listeners += [pscustomobject]@{
                Port = [int]$conn.LocalPort
                LocalAddress = [string]$conn.LocalAddress
                OwningProcess = [int]$conn.OwningProcess
                ProcessName = if ($proc) { [string]$proc.ProcessName } else { '' }
                Path = if ($proc) { [string]$proc.Path } else { '' }
                CommandLine = $commandLine
                IsProxy = $isProxy
            }
        }
    } catch {}

    return @($listeners)
}

function Format-PortListener {
    param($Listener)
    $name = if ($Listener.ProcessName) { $Listener.ProcessName } else { 'unknown' }
    $path = if ($Listener.Path) { " ($($Listener.Path))" } else { '' }
    return "port $($Listener.Port) -> PID $($Listener.OwningProcess) [$name]$path"
}

function Test-ProtectedPortOwner {
    param($Listener)
    if (-not $Listener -or -not $Listener.OwningProcess) { return $true }
    if ($Listener.OwningProcess -eq $PID) { return $true }
    if ($Listener.OwningProcess -le 4) { return $true }
    return $false
}

function ConvertTo-SingleQuotedPsString {
    param([string]$Value)
    return "'" + ($Value -replace "'", "''") + "'"
}

function Start-ProxyLauncher {
    $argList = [char]34 + $JsFile + [char]34
    Start-Process -FilePath $NodeExe -ArgumentList $argList -WorkingDirectory $ScriptDir -WindowStyle Hidden -PassThru
}

function Reset-LogFileIfBinary {
    param([string]$Path)
    try {
        if (-not (Test-Path $Path)) { return }
        $shouldReset = $false
        $stream = [System.IO.File]::Open($Path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
        try {
            $length = [Math]::Min(512, [int]$stream.Length)
            if ($length -le 0) { return }
            $buffer = New-Object byte[] $length
            $null = $stream.Read($buffer, 0, $length)
            $shouldReset = $buffer -contains 0
        } finally {
            $stream.Dispose()
        }
        if ($shouldReset) { Set-Content -Path $Path -Value '' -Encoding UTF8 }
    } catch {}
}

function Test-AutoReleasePortOwner {
    param($Listener)
    if (-not $Listener) { return $false }
    if ($Listener.IsProxy) { return $true }
    if ($ForceReleaseOccupiedPorts) { return $true }
    if ($Listener.ProcessName -eq 'node') { return $true }
    if ($Listener.CommandLine -and ($Listener.CommandLine -like '*openai-proxy.js*' -or $Listener.CommandLine -like "*$ScriptDir*")) { return $true }
    if ($Listener.Path -and $Listener.Path.StartsWith($ScriptDir, [System.StringComparison]::OrdinalIgnoreCase)) { return $true }
    return $false
}

function Release-OccupiedPorts {
    $configuredPorts = @(Get-ConfiguredPorts)
    $possiblyOccupiedPorts = @($configuredPorts | Where-Object { Test-LocalTcpPort -ListenPort $_ -TimeoutMs 80 })
    if ($possiblyOccupiedPorts.Count -eq 0) { return $true }

    $listeners = @(Get-PortListeners -Ports $possiblyOccupiedPorts)
    if ($listeners.Count -eq 0) { return $true }

    $conflictOwners = @{}
    foreach ($listener in $listeners) {
        if (-not $conflictOwners.ContainsKey($listener.OwningProcess)) {
            $conflictOwners[$listener.OwningProcess] = @()
        }
        $conflictOwners[$listener.OwningProcess] += $listener
    }

    foreach ($ownerId in @($conflictOwners.Keys)) {
        $ownedPorts = @($conflictOwners[$ownerId])
        $sample = $ownedPorts[0]

        if ($sample.IsProxy) {
            Write-Status '!' "Found existing proxy owner on configured ports: $((@($ownedPorts) | ForEach-Object { $_.Port }) -join ', ')"
            continue
        }

        foreach ($listener in $ownedPorts) {
            Write-Status '!' "Port occupied: $(Format-PortListener $listener)"
        }

        if ($NoReleaseOccupiedPorts) {
            Write-Status 'x' 'Port release disabled by -NoReleaseOccupiedPorts'
            return $false
        }

        if (Test-ProtectedPortOwner $sample) {
            Write-Status 'x' "Refusing to stop protected process PID $($sample.OwningProcess)"
            return $false
        }

        if (-not (Test-AutoReleasePortOwner $sample)) {
            Write-Status 'x' "Refusing to auto-release unknown port owner PID $($sample.OwningProcess). Use -ForceReleaseOccupiedPorts if this process should be stopped."
            return $false
        }

        try {
            Write-Status '!' "Auto-releasing occupied proxy port(s) by stopping PID $($sample.OwningProcess)"
            Stop-Process -Id $sample.OwningProcess -Force -ErrorAction Stop
            Start-Sleep -Milliseconds 600
        } catch {
            Write-Status 'x' "Failed to release PID $($sample.OwningProcess): $_"
            return $false
        }
    }

    $remaining = @(Get-PortListeners -Ports $possiblyOccupiedPorts | Where-Object { -not $_.IsProxy })
    if ($remaining.Count -gt 0) {
        foreach ($listener in $remaining) {
            Write-Status 'x' "Still occupied: $(Format-PortListener $listener)"
        }
        return $false
    }

    return $true
}

function Get-ConfiguredPorts {
    $ports = New-Object System.Collections.Generic.List[int]

    if ($PortWasSpecified) {
        $ports.Add($Port)
        $ports.Add($Port + 100)
        return @($ports | Select-Object -Unique)
    }

    try {
        if (Test-Path $ConfigFile) {
            $config = Get-Content $ConfigFile -Raw | ConvertFrom-Json
            if ($config.entryServers) {
                foreach ($entry in $config.entryServers) {
                    if ($entry.enabled -ne $false -and $entry.listenPort) {
                        $ports.Add([int]$entry.listenPort)
                    }
                }
            }
            $basePort = $Port
            if ($config.localServer -and $config.localServer.listenPort) {
                $basePort = [int]$config.localServer.listenPort
            }
            if ($config.localServer -and $config.localServer.managementPort) {
                $ports.Add([int]$config.localServer.managementPort)
            } else {
                $ports.Add($basePort + 100)
            }
        }
    } catch {}

    if ($ports.Count -eq 0) {
        $ports.Add($Port)
        $ports.Add($Port + 100)
    }
    return @($ports | Select-Object -Unique)
}

function Get-ManagementPort {
    if ($PortWasSpecified) { return ($Port + 100) }
    try {
        if (Test-Path $ConfigFile) {
            $config = Get-Content $ConfigFile -Raw | ConvertFrom-Json
            if ($config.localServer -and $config.localServer.managementPort) {
                return [int]$config.localServer.managementPort
            }
            if ($config.localServer -and $config.localServer.listenPort) {
                return ([int]$config.localServer.listenPort + 100)
            }
        }
    } catch {}
    return ($Port + 100)
}

function Get-ManagementToken {
    param([int]$ManagementPort)
    $candidates = @(
        (Join-Path $RuntimeDir ".mgmt-token-$ManagementPort"),
        (Join-Path $RuntimeDir '.mgmt-token')
    )
    foreach ($candidate in $candidates) {
        try {
            if (Test-Path $candidate) {
                $token = (Get-Content $candidate -Raw -ErrorAction Stop).Trim()
                if ($token) { return $token }
            }
        } catch {}
    }
    return ''
}

function Test-LocalTcpPort {
    param(
        [int]$ListenPort,
        [int]$TimeoutMs = 150
    )
    $client = $null
    try {
        $client = [System.Net.Sockets.TcpClient]::new()
        $connect = $client.BeginConnect('127.0.0.1', $ListenPort, $null, $null)
        if (-not $connect.AsyncWaitHandle.WaitOne($TimeoutMs)) { return $false }
        $client.EndConnect($connect)
        return $true
    } catch {
        return $false
    } finally {
        if ($client) { $client.Dispose() }
    }
}

function Get-ProxyHealth {
    $managementPort = Get-ManagementPort
    if (-not (Test-LocalTcpPort -ListenPort $managementPort)) { return $null }
    try {
        $uri = "http://127.0.0.1:$managementPort/v1/local/health"
        $headers = @{}
        $token = Get-ManagementToken -ManagementPort $managementPort
        if ($token) { $headers['x-mgmt-token'] = $token }
        $health = Invoke-RestMethod -UseBasicParsing -Uri $uri -Headers $headers -TimeoutSec 2 -ErrorAction Stop
        if ($health -and $health.appId -eq 'https-proxy-manager') { return $health }
    } catch {}
    return $null
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

function Get-PortProcesses {
    $result = @{}
    foreach ($listener in Get-PortListeners) {
        if (-not $result.ContainsKey($listener.OwningProcess)) {
            $proc = Get-Process -Id $listener.OwningProcess -ErrorAction SilentlyContinue
            if ($proc) { $result[$listener.OwningProcess] = $proc }
        }
    }
    return @($result.Values)
}

function Get-AllProxyProcesses {
    param([switch]$IncludeFullScan)
    $result = @{}

    $health = Get-ProxyHealth
    if ($health -and $health.pid) {
        $proc = Get-Process -Id ([int]$health.pid) -ErrorAction SilentlyContinue
        if ($proc -and -not $result.ContainsKey($proc.Id)) {
            $result[$proc.Id] = $proc
        }
    }

    try {
        if (Test-Path $PidFile) {
            $rawPid = (Get-Content $PidFile -Raw -ErrorAction SilentlyContinue).Trim()
            if ($rawPid -match '^\d+$') {
                $proc = Get-Process -Id ([int]$rawPid) -ErrorAction SilentlyContinue
                if (Test-IsProxyProcess $proc -and -not $result.ContainsKey($proc.Id)) {
                    $result[$proc.Id] = $proc
                }
            }
        }
    } catch {}

    foreach ($proc in Get-PortProcesses) {
        if (Test-IsProxyProcess $proc -and -not $result.ContainsKey($proc.Id)) {
            $result[$proc.Id] = $proc
        }
    }

    if ($IncludeFullScan -and $result.Count -eq 0) {
        foreach ($proc in Get-Process node -ErrorAction SilentlyContinue) {
            if (Test-IsProxyProcess $proc -and -not $result.ContainsKey($proc.Id)) {
                $result[$proc.Id] = $proc
            }
        }
    }

    return @($result.Values | Sort-Object Id)
}

function Get-RunningProxyProcess {
    $procs = @(Get-AllProxyProcesses)
    if ($procs.Count -gt 0) {
        $procs[0].Id | Out-File $PidFile -Encoding ASCII
        return $procs[0]
    }
    Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
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
    $startTick = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    if (-not (Test-NodeInstalled)) { return }
    if (-not (Test-Path $JsFile)) { Write-Status 'x' "Not found: $JsFile"; return }

    $health = Get-ProxyHealth
    Write-DebugTiming 'health-check' $startTick
    if ($health) {
        if ($health.pid) { $health.pid | Out-File $PidFile -Encoding ASCII }
        Write-Status '!' "Proxy already running (PID: $($health.pid))"
        return
    }

    if (-not (Release-OccupiedPorts)) {
        Write-Status 'x' 'Proxy start aborted because configured port(s) are occupied.'
        return
    }
    Write-DebugTiming 'release-check' $startTick

    if (-not (Test-Path $ConfigFile)) {
        $bundledConfig = Join-Path $ScriptDir 'proxy.config.json'
        if (Test-Path $bundledConfig) { Copy-Item $bundledConfig $ConfigFile -Force }
        else {
            $exampleConfig = Join-Path $ScriptDir 'proxy.config.example.json'
            if (Test-Path $exampleConfig) { Copy-Item $exampleConfig $ConfigFile -Force }
        }
    }

    $env:PROXY_CONFIG_DIR = $ConfigDir
    $env:PROXY_RUNTIME_DIR = $RuntimeDir
    $env:NODE_COMPILE_CACHE = Join-Path $RuntimeDir '.node-compile-cache'
    if ($PortWasSpecified) { $env:PORT = [string]$Port } else { Remove-Item Env:PORT -ErrorAction SilentlyContinue }
    if ($Target -ne '') { $env:TARGET = $Target }
    if ($ApiKey -ne '') { $env:API_KEY = $ApiKey }
    if ($ModelRewriteFrom -ne '') { $env:MODEL_REWRITE_FROM = $ModelRewriteFrom }
    if ($ModelRewriteTo -ne '') { $env:MODEL_REWRITE_TO = $ModelRewriteTo }

    try {
        Reset-LogFileIfBinary $LogFile
        Reset-LogFileIfBinary $ErrLogFile
        Write-DebugTiming 'pre-launch' $startTick
        $launcher = Start-ProxyLauncher
        Write-DebugTiming 'launch-process' $startTick
        $health = $null
        $startedProc = $null
        $managementPort = Get-ManagementPort
        for ($i = 0; $i -lt 40; $i++) {
            Start-Sleep -Milliseconds 250
            $health = Get-ProxyHealth
            if ($health -and $health.pid) {
                $startedProc = Get-Process -Id ([int]$health.pid) -ErrorAction SilentlyContinue
                if (-not $startedProc) { $startedProc = $launcher }
                break
            }
            if ($launcher -and $launcher.HasExited -and $i -ge 12) {
                $found = @(Get-AllProxyProcesses)
                if ($found.Count -gt 0) {
                    $startedProc = $found[0]
                    break
                }
            }
        }
        Write-DebugTiming 'ready-wait' $startTick

        if (-not $startedProc) {
            $health = Get-ProxyHealth
            if ($health -and $health.pid) {
                $startedProc = Get-Process -Id ([int]$health.pid) -ErrorAction SilentlyContinue
            }
        }

        if (-not $startedProc) {
            $found = @(Get-AllProxyProcesses)
            if ($found.Count -gt 0) {
                $found[0].Id | Out-File $PidFile -Encoding ASCII
                Write-Status '+' "Proxy started (PID: $($found[0].Id))"
            } else {
                $exitCode = 'unknown'
                if ($launcher -and $launcher.HasExited) { $exitCode = $launcher.ExitCode }
                Write-Status 'x' "Exited immediately (ExitCode: $exitCode)"
                if (Test-Path $ErrLogFile) {
                    $tail = @(Get-Content $ErrLogFile -Tail 8 -ErrorAction SilentlyContinue)
                    foreach ($line in $tail) {
                        if ($line) { Write-Status ' ' $line }
                    }
                }
                return
            }
        } else {
            $startedProc.Id | Out-File $PidFile -Encoding ASCII
            Write-Status '+' "Proxy started (PID: $($startedProc.Id))"
        }
        foreach ($address in Get-EntryAddresses) { Write-Status ' ' "Address: $address" }
        Write-Status ' ' "Log: $LogFile"
        Write-DebugTiming 'done' $startTick
    } catch {
        Write-Status 'x' "Start failed: $_"
    }
}

function Stop-Proxy {
    $health = Get-ProxyHealth
    if ($health -and $health.pid) {
        $proc = Get-Process -Id ([int]$health.pid) -ErrorAction SilentlyContinue
        if ($proc) {
            try {
                Stop-Process -Id $proc.Id -Force -ErrorAction Stop
                $null = $proc.WaitForExit(500)
                Write-Status '+' "Proxy stopped (PID: $($proc.Id))"
                Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
                return
            } catch {
                Write-Status 'x' "Stop failed for PID $($proc.Id): $_"
                return
            }
        }
    }

    $procs = @(Get-AllProxyProcesses)
    if ($procs.Count -eq 0) {
        Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
        Write-Status '!' 'Proxy is not running'
        return
    }

    foreach ($proc in $procs) {
        try {
            Stop-Process -Id $proc.Id -Force -ErrorAction Stop
            $null = $proc.WaitForExit(1200)
            Write-Status '+' "Proxy stopped (PID: $($proc.Id))"
        } catch {
            Write-Status 'x' "Stop failed for PID $($proc.Id): $_"
        }
    }
    Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
}

function Get-Status {
    $health = Get-ProxyHealth
    if ($health) {
        if ($health.pid) { $health.pid | Out-File $PidFile -Encoding ASCII }
        Write-Status '+' "Running (PID: $($health.pid), uptime $([math]::Floor([double]$health.uptimeSec / 3600))h $([math]::Floor(([double]$health.uptimeSec % 3600) / 60))m)"
        if ($health.ports -and $health.ports.entries) {
            foreach ($entry in @($health.ports.entries)) {
                $scheme = if ($entry.tls -eq $false) { 'http' } else { 'https' }
                Write-Status ' ' "Address: ${scheme}://$($entry.host):$($entry.listenPort)$($entry.basePath) [$($entry.protocol)]"
                Write-Status ' ' "Port: port $($entry.listenPort) -> PID $($health.pid) [node]"
            }
        } else {
            foreach ($address in Get-EntryAddresses) { Write-Status ' ' "Address: $address" }
        }
        if ($health.ports -and $health.ports.management) {
            Write-Status ' ' "Port: port $($health.ports.management) -> PID $($health.pid) [node] [management]"
        }
        return
    }

    $procs = @(Get-AllProxyProcesses)
    if ($procs.Count -gt 0) {
        $listeners = @(Get-PortListeners)
        if ($listeners.Count -eq 0) {
            Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
            foreach ($proc in $procs) {
                Write-Status '!' "Proxy process found but no configured ports are listening (PID: $($proc.Id)). Use 'proxy.bat restart' if the UI cannot connect."
            }
            return
        }
        $procs[0].Id | Out-File $PidFile -Encoding ASCII
        foreach ($proc in $procs) {
            $up = (Get-Date) - $proc.StartTime
            Write-Status '+' "Running (PID: $($proc.Id), uptime $($up.Hours)h $($up.Minutes)m)"
        }
        if ($procs.Count -gt 1) {
            Write-Status '!' "Multiple proxy processes detected: $($procs.Count). Use 'proxy.bat restart' to collapse to a single instance."
        }
        foreach ($address in Get-EntryAddresses) { Write-Status ' ' "Address: $address" }
        foreach ($listener in $listeners) {
            Write-Status ' ' "Port: $(Format-PortListener $listener)"
        }
    } else {
        Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
        Write-Status '!' 'Proxy is not running'
        $listeners = @(Get-PortListeners)
        foreach ($listener in $listeners) {
            Write-Status '!' "Port occupied: $(Format-PortListener $listener)"
        }
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

    $env:PROXY_CONFIG_DIR = $ConfigDir
    $env:PROXY_RUNTIME_DIR = $RuntimeDir
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
    'start' { Invoke-WithProxyLock { Start-Proxy } }
    'stop' { Invoke-WithProxyLock { Stop-Proxy } }
    'restart' { Invoke-WithProxyLock { Stop-Proxy; Start-Sleep -Milliseconds 800; Start-Proxy } }
    'status' { Get-Status }
    'logs' { Show-Logs }
    'tail' { Tail-Logs }
    'open' { Open-Logs }
    'health' { Test-Health }
    'config' { Open-Config }
    'trust-cert' { Trust-Cert }
}

exit $script:ExitCode
