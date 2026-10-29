Set-StrictMode -Version Latest
Import-Module (Join-Path $PSScriptRoot 'persistent-io-capabilities-process.psm1')

function Get-CapabilityHash([string]$Text) {
    return [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($Text))).ToLowerInvariant()
}
function Read-CapabilityProfiles([string]$Text) {
    if ($Text.Length -gt 16384 -or $Text.Contains([char]0)) { throw 'persistent_io_capabilities_failed' }
    $ids = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    foreach ($line in $Text.Split("`n")) {
        if ($line.Length -gt 1024) { throw 'persistent_io_capabilities_failed' }
        if ($line -match '^\s*([A-Za-z][A-Za-z0-9_.-]{0,63})\s+(.+?)\s*$') {
            $id=$Matches[1];$description=$Matches[2]
            if ($id -match 'minifilter' -or $description -match '\bmini[- ]?filter\b') {
                if (-not $ids.Add($id) -or $ids.Count -gt 4) { throw 'persistent_io_capabilities_failed' }
            }
        } elseif ($line -match '(?i)mini[- ]?filter') { throw 'persistent_io_capabilities_failed' }
    }
    return @($ids | Sort-Object)
}
function Get-CapabilityHost {
    if (-not $IsWindows -or $env:GITHUB_ACTIONS -cne 'true' -or $env:RUNNER_ENVIRONMENT -cne 'github-hosted' -or $env:RUNNER_OS -cne 'Windows' -or $env:GITHUB_REPOSITORY -cne 'cbhandsun/https-proxy') { throw 'persistent_io_capabilities_failed' }
    $admin=([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    $path=Join-Path $env:SystemRoot 'System32/wpr.exe'
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { return @{admin=$admin;osVersion=[Environment]::OSVersion.Version.ToString();path=$null;version=$null;hash=$null} }
    $item=Get-Item -LiteralPath $path
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'persistent_io_capabilities_failed' }
    $info=$item.VersionInfo
    $version=('{0}.{1}.{2}.{3}' -f $info.FileMajorPart,$info.FileMinorPart,$info.FileBuildPart,$info.FilePrivatePart)
    if ($version -cnotmatch '\A[0-9]+(?:\.[0-9]+){1,3}\z' -or $version.Length -gt 48) { throw 'persistent_io_capabilities_failed' }
    return @{admin=$admin;osVersion=[Environment]::OSVersion.Version.ToString();path=$path;version=$version;hash=(Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()}
}
function Close-CapabilityLease($Lease) { $Lease.Dispose() }
function Invoke-HpmPersistentIoCapabilities {
    try {
        $hostInfo=Get-CapabilityHost
        $report=[ordered]@{schemaVersion=1;scope='hosted_wpr_read_only_capabilities';metadataHashEncoding='utf8_decoded_text';osVersion=$hostInfo.osVersion;administrator=[bool]$hostInfo.admin;wprAvailable=($null -ne $hostInfo.path);wprVersion=$hostInfo.version;wprSha256=$hostInfo.hash;profilesSha256=$null;minifilterProfiles=@();minifilterProfileAvailable=$false;eventSchemaVerified=$false;metadataUnknown=$true;systemWprOnly=$true;recordingStarted=$false;fiveSecondQualified=$false;installedQualified=$false;realProviderQualified=$false;realModelRequests=0}
        if ($hostInfo.osVersion -cnotmatch '\A[0-9]+(?:\.[0-9]+){1,3}\z') { throw 'persistent_io_capabilities_failed' }
        if ($null -eq $hostInfo.path -or -not $hostInfo.admin) { return $report }
        $lease=[IO.File]::Open($hostInfo.path,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
        try {
            if ((Get-FileHash -LiteralPath $hostInfo.path -Algorithm SHA256).Hash.ToLowerInvariant() -cne $hostInfo.hash) { throw 'persistent_io_capabilities_failed' }
            $profiles=Invoke-HpmCapabilityProcess $hostInfo.path @('-profiles')
            $report.profilesSha256=Get-CapabilityHash $profiles
            $ids=@(Read-CapabilityProfiles $profiles)
            $report.minifilterProfileAvailable=$ids.Count -gt 0
            $rows=@()
            foreach ($id in $ids) {
                $details=Invoke-HpmCapabilityProcess $hostInfo.path @('-profiledetails',$id)
                if ($details.Length -gt 16384 -or $details.Contains([char]0)) { throw 'persistent_io_capabilities_failed' }
                $rows+=@{id=$id;detailsSha256=(Get-CapabilityHash $details);filterIOKeywordPresent=($details -cmatch '\bFilterIO\b');filterIOInitKeywordPresent=($details -cmatch '\bFilterIOInit\b');filterIOFastIOKeywordPresent=($details -cmatch '\bFilterIOFastIO\b');filterIOFailureKeywordPresent=($details -cmatch '\bFilterIOFailure\b')}
            }
            $report.minifilterProfiles=$rows
            if ((Get-FileHash -LiteralPath $hostInfo.path -Algorithm SHA256).Hash.ToLowerInvariant() -cne $hostInfo.hash) { throw 'persistent_io_capabilities_failed' }
        } finally { Close-CapabilityLease $lease }
        return $report
    } catch { throw 'persistent_io_capabilities_failed' }
}
Export-ModuleMember -Function Invoke-HpmPersistentIoCapabilities
