param([switch]$ReceiptsOnly)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
Import-Module (Join-Path $PSScriptRoot '../../scripts/lib/nsis-runtime-boundary.psm1') -Force
$module = Get-Module nsis-runtime-boundary
$checks = @{ failures = 0; children = 0 }
function Refuses([scriptblock]$Action) {
    $failed = $false
    try { & $Action | Out-Null } catch {
        $failed = $true
        if ($_.Exception.Message -cnotin @('Runtime boundary result rejected.', 'Runtime boundary child failed.', 'Installed runtime boundary failed.', 'Runtime boundary payload rejected.')) { throw 'Unsafe fixture failure.' }
    }
    if (-not $failed) { throw ('Expected runtime boundary rejection; check=' + $checks.failures + '; child=' + $checks.children) }
    $checks.failures++
}
$sha = 'a' * 64
$default = [ordered]@{ schemaVersion = 1; caseId = 'defaults-migration'; manifestSha256 = $sha; scope = 'installed_module_api'; complete = $false; dependencyIdentity = 'lock_only'; checks = @('empty_config_directory', 'default_policy_disabled', 'runtime_disabled', 'shutdown_acknowledged') }
$json = $default | ConvertTo-Json -Compress
$safe = ConvertFrom-HpmRuntimeBoundaryResult $json 'defaults-migration' $sha
if ($safe.complete -or $safe.scope -cne 'installed_module_api') { throw 'Incomplete defaults boundary lost.' }
foreach ($text in @('', 'null', '[]', '{}', ($json + '{}'), $json.Replace('"schemaVersion":1', '"schemaVersion":1,"schemaVersion":1'), $json.Replace('"complete":false', '"complete":true'), $json.Replace('"lock_only"', '"PRIVATE_CHILD_SENTINEL"'), $json.Replace('"checks":[', '"checks":["extra",'), $json.Replace('"schemaVersion":1', '"schemaVersion":"1"'))) {
    Refuses { ConvertFrom-HpmRuntimeBoundaryResult $text 'defaults-migration' $sha }
}
Refuses { ConvertFrom-HpmRuntimeBoundaryResult $json 'settings-matrix' $sha }
Refuses { ConvertFrom-HpmRuntimeBoundaryResult $json 'defaults-migration' ('b' * 64) }
Refuses { ConvertFrom-HpmRuntimeBoundaryResult (' ' * 4097 + $json) 'defaults-migration' $sha }
Refuses { ConvertFrom-HpmRuntimeBoundaryResult ('"' + ('界' * 1800) + '"') 'defaults-migration' $sha }
$failureJson = $json.Replace('defaults-migration', 'initialization-failure').Replace('"complete":false', '"complete":true').Replace('empty_config_directory', 'storage_directory_blocked').Replace('default_policy_disabled', 'initialization_failed_closed').Replace('runtime_disabled', 'reenable_rejected').Replace('shutdown_acknowledged', 'shutdown_failure_acknowledged')
$safe = ConvertFrom-HpmRuntimeBoundaryResult $failureJson 'initialization-failure' $sha
if (-not $safe.complete) { throw 'Failure-path completion was lost.' }

$reopen = [ordered]@{ schemaVersion = 1; caseId = 'reopen-clear'; manifestSha256 = $sha; scope = 'installed_module_api'; complete = $true; dependencyIdentity = 'lock_only'; checks = @('persistent_runtime_read', 'principal_revoke_acknowledged', 'principal_reopen_denied', 'clear_acknowledged', 'clear_reopen_denied', 'all_owners_closed') }
$reopenJson = $reopen | ConvertTo-Json -Compress
$safe = ConvertFrom-HpmRuntimeBoundaryResult $reopenJson 'reopen-clear' $sha
if (-not $safe.complete -or $safe.checks.Count -ne 6 -or $safe.scope -cne 'installed_module_api') { throw 'Orderly reopen scope was lost.' }
foreach ($text in @(
    $reopenJson.Replace('"complete":true', '"complete":false'),
    $reopenJson.Replace('"complete":true', '"complete":"true"'),
    $reopenJson.Replace('"complete":true,', ''),
    $reopenJson.Replace('"all_owners_closed"', 'false'),
    $reopenJson.Replace(',"all_owners_closed"', ''),
    $reopenJson.Replace('"checks":[', '"checks":["extra",'),
    $reopenJson.Replace('"persistent_runtime_read","principal_revoke_acknowledged"', '"principal_revoke_acknowledged","persistent_runtime_read"'),
    $reopenJson.Replace('"all_owners_closed"', '"clear_reopen_denied"'),
    $reopenJson.Replace('"schemaVersion":1', '"schemaVersion":1,"schemaVersion":1'),
    $reopenJson.Replace('"scope":"installed_module_api"', '"scope":"installed_crash_qualified"'),
    $reopenJson.Replace('"schemaVersion":1', '"schemaVersion":1,"capacity24hQualified":true')
)) { Refuses { ConvertFrom-HpmRuntimeBoundaryResult $text 'reopen-clear' $sha } }
Refuses { ConvertFrom-HpmRuntimeBoundaryResult $reopenJson 'defaults-migration' $sha }
Refuses { ConvertFrom-HpmRuntimeBoundaryResult $reopenJson 'reopen-clear' ('b' * 64) }
$caseAttributes = @((Get-Command Invoke-HpmInstalledRuntimeBoundary).Parameters['CaseId'].Attributes | Where-Object { $_ -is [Management.Automation.ValidateSetAttribute] })
if ($caseAttributes.Count -ne 1 -or ($caseAttributes[0].ValidValues -join ',') -cne 'defaults-migration,initialization-failure,reopen-clear') { throw 'Runtime case allowlist changed.' }
if ($ReceiptsOnly) {
    Write-Output ('runtimeExpectedFailures=' + $checks.failures + '; safeChildProcesses=0; installerExecutions=0; networkRequests=0')
    return
}

$temporary = Join-Path ([IO.Path]::GetTempPath()) ('hpm-runtime-pwsh-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $temporary -ErrorAction Stop | Out-Null
$pidFile = Join-Path $temporary 'owned-child.pid'
function Invoke-Child {
    param([string]$Code, [int]$TimeoutMilliseconds = 5000)
    $start = [Diagnostics.ProcessStartInfo]::new()
    $start.FileName = $env:HPM_TEST_NODE
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.RedirectStandardInput = $true
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    # Simulate a caller inheriting a UTF-8 console encoding with a BOM. The
    # shared Job boundary owns the exact one-byte grant and must override it.
    $start.StandardInputEncoding = [Text.UTF8Encoding]::new($true)
    $start.Environment.Remove('NODE_OPTIONS') | Out-Null
    $start.Environment.Remove('NODE_PATH') | Out-Null
    $start.Environment['HPM_CHILD_PID_FILE'] = $pidFile
    $start.ArgumentList.Add('-e')
    $start.ArgumentList.Add("let gate='';process.stdin.on('data',b=>gate+=b);process.stdin.on('end',()=>{if(gate!=='1')process.exit(2);" + $Code + '});')
    $checks.children++
    # Use the same exported API as the hosted N08/N09 callers, rather than
    # reaching into module-private scope and hiding a missing export.
    return Invoke-HpmBoundedRuntimeChild $start $TimeoutMilliseconds
}
try {
    $install = Join-Path $temporary 'installed'
    New-Item -ItemType Directory -Path (Join-Path $install 'runtime/node') | Out-Null
    $nodePath = Join-Path $install 'runtime/node/node.exe'
    [IO.File]::WriteAllText($nodePath, 'synthetic-not-executable')
    $nodeSha = (Get-FileHash -LiteralPath $nodePath -Algorithm SHA256).Hash.ToLowerInvariant()
    $manifestPath = Join-Path $install 'release-runtime-manifest.json'
    [IO.File]::WriteAllText($manifestPath, ('{"schemaVersion":2,"nodeSha256":"' + $nodeSha + '"}'))
    $manifestSha = (Get-FileHash -LiteralPath $manifestPath -Algorithm SHA256).Hash.ToLowerInvariant()
    $verified = & $module { param($owned, $installation, $hash) Get-HpmRuntimeBoundaryNode $owned $installation $hash } $temporary $install $manifestSha
    if ($verified -cne $nodePath) { throw 'Executable preflight changed path.' }
    Refuses { Invoke-HpmInstalledRuntimeBoundary $temporary $install ('b' * 64) 'defaults-migration' }
    [IO.File]::AppendAllText($nodePath, 'changed')
    Refuses { Invoke-HpmInstalledRuntimeBoundary $temporary $install $manifestSha 'defaults-migration' }
    if (@(Get-ChildItem -LiteralPath $temporary -Directory).Count -ne 1) { throw 'Rejected executable created a runtime case.' }
    $result = Invoke-Child "process.stdout.write('ok');"
    if ($result -cne 'ok') { throw 'Safe child output changed.' }
    Refuses { Invoke-Child "process.stdout.write('PRIVATE_CHILD_SENTINEL'.repeat(512));setInterval(()=>{},1000);" }
    Refuses { Invoke-Child "process.stderr.write('PRIVATE_CHILD_SENTINEL'.repeat(512));setInterval(()=>{},1000);" }
    Refuses { Invoke-Child "process.stderr.write('PRIVATE_CHILD_SENTINEL');process.exit(3);" }
    foreach ($phaseCode in @(64, 69, 72, 73, 84, 85, 86, 94, 95, 96, 97, 98, 99, 100, 101, 108, 109, 120, 121, 125, 126, 127, 128, 129, 130, 131, 139, 140, 161, 162, 173, 174, 184, 185, 190, 195, 196, 200, 210, 224, 225, 246, 247, 250, 251, 252, 253)) {
        Refuses { Invoke-Child ("process.stderr.write('PRIVATE_CHILD_SENTINEL');process.exit(" + $phaseCode + ');') }
    }
    foreach ($primary in @(80, 97)) {
        Refuses { Invoke-Child ("process.stderr.write('n09_owned_entry_rejected\nn09_primary_phase=" + $primary + "\n');process.exit(98);") }
    }
    & $module {
        foreach ($phase in @(73, 84, 86, 96, 101, 108, 109, 120, 121, 125, 126, 127, 128, 129, 130, 131, 138, 162, 173, 174, 184, 185, 186, 187, 188, 189, 190, 191, 192, 193, 194, 195, 196, 197, 198, 199, 201, 203, 204, 205, 206, 207, 208, 209, 211, 212, 213, 214, 215, 216, 217, 218, 219, 220, 221, 222, 223, 224, 225, 226, 227, 228, 229, 230, 231, 232, 233, 234, 235, 236, 237, 238, 239, 240, 241, 242, 243, 244, 245, 246, 247, 248, 249, 250, 251, 252)) {
            $bytes = [Text.Encoding]::UTF8.GetBytes("n09_owned_entry_rejected`nn09_primary_phase=$phase`n")
            if ((ConvertFrom-HpmOwnedFailurePhase $bytes) -ne $phase) { throw 'Valid phase rejected.' }
        }
        foreach ($text in @('', 'PRIVATE_CHILD_SENTINEL', ('x' * 81),
            "n09_owned_entry_rejected`nn09_primary_phase=85`n",
            "n09_owned_entry_rejected`nn09_primary_phase=97`n",
            "n09_owned_entry_rejected`nn09_primary_phase=100`n",
            "n09_owned_entry_rejected`nn09_primary_phase=139`n",
            "n09_owned_entry_rejected`nn09_primary_phase=200`n",
            "n09_owned_entry_rejected`nn09_primary_phase=210`n",
            "n09_owned_entry_rejected`nn09_primary_phase=202`n",
            "n09_owned_entry_rejected`nn09_primary_phase=253`n",
            "n09_owned_entry_rejected`nn09_primary_phase=80`nPRIVATE_CHILD_SENTINEL",
            "n09_owned_entry_rejected`nn09_primary_phase=80`nn09_primary_phase=81`n")) {
            if ($null -ne (ConvertFrom-HpmOwnedFailurePhase ([Text.Encoding]::UTF8.GetBytes($text)))) { throw 'Invalid phase accepted.' }
        }
        if ($null -ne (ConvertFrom-HpmOwnedFailurePhase ([byte[]]@(255)))) { throw 'Invalid UTF8 accepted.' }
        if ($null -ne (ConvertFrom-HpmOwnedFailurePhase $null)) { throw 'Null phase accepted.' }
    }
    Refuses { Invoke-Child "process.stdout.write(Buffer.from([255]));" }
    Refuses { Invoke-Child "setInterval(()=>{},1000);" 1500 }
    Refuses { Invoke-Child "const child=require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'inherit',windowsHide:true});require('node:fs').writeFileSync(process.env.HPM_CHILD_PID_FILE,String(child.pid));setInterval(()=>{},1000);" 2000 }
    if (-not (Test-Path -LiteralPath $pidFile -PathType Leaf)) { throw 'Descendant proof missing.' }
    $ownedPid = [int][IO.File]::ReadAllText($pidFile)
    $remaining = Get-Process -Id $ownedPid -ErrorAction SilentlyContinue
    if ($null -ne $remaining) { throw 'Owned descendant survived job closure.' }
    Remove-Item -LiteralPath $pidFile
    # A parent may exit with pipes already closed while a detached descendant
    # remains alive. Successful output capture must still terminate that child.
    $result = Invoke-Child "const child=require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',windowsHide:true,detached:true});require('node:fs').writeFileSync(process.env.HPM_CHILD_PID_FILE,String(child.pid));process.exit(0);"
    if ($result -cne '' -or -not (Test-Path -LiteralPath $pidFile -PathType Leaf)) { throw 'Exited-parent proof missing.' }
    $ownedPid = [int][IO.File]::ReadAllText($pidFile)
    $remaining = Get-Process -Id $ownedPid -ErrorAction SilentlyContinue
    if ($null -ne $remaining) { throw 'Exited-parent descendant survived job closure.' }
} finally {
    $resolved = [IO.Path]::GetFullPath($temporary)
    $prefix = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
    if (-not $resolved.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase) -or [IO.Path]::GetFileName($resolved) -notlike 'hpm-runtime-pwsh-*') { throw 'Fixture cleanup refused.' }
    Remove-Item -LiteralPath $resolved -Recurse -Force
}
Write-Output ('runtimeExpectedFailures=' + $checks.failures + '; safeChildProcesses=' + $checks.children + '; installerExecutions=0; networkRequests=0')
