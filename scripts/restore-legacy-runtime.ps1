$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'lib/legacy-runtime-restore.psm1') -Force
Restore-HpmLegacyRuntime
