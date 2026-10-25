Import-Module (Join-Path $PSScriptRoot 'lib/persistent-io-recording.psm1')
Invoke-HpmPersistentIoDiagnostic @args
