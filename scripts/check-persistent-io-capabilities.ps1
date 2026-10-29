$ErrorActionPreference='Stop'
try {
    if ($args.Count -ne 0) { throw 'refused' }
    Import-Module (Join-Path $PSScriptRoot 'lib/persistent-io-capabilities.psm1')
    $receipt=Invoke-HpmPersistentIoCapabilities
    [Console]::Out.WriteLine('PERSISTENT_IO_CAPABILITIES='+($receipt|ConvertTo-Json -Depth 6 -Compress))
} catch {
    [Console]::Error.WriteLine('persistent_io_capabilities_failed')
    exit 1
}
