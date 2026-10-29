$ErrorActionPreference='Stop'
try {
    if($args.Count -ne 0){throw 'io_schema_failed'}
    Import-Module (Join-Path $PSScriptRoot 'lib/persistent-io-schema-recording.psm1')
    Invoke-HpmPersistentIoSchemaDiscovery
} catch {
    [Console]::Error.WriteLine('persistent_io_schema_failed')
    exit 1
}
