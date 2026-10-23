Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
# Compile only. Every exercised native operation uses the same-assembly fake.
$source = [IO.File]::ReadAllText((Join-Path $PSScriptRoot '../../scripts/context-hosted/shared/hosted-egress-wfp.cs'))
$fixture = [IO.File]::ReadAllText((Join-Path $PSScriptRoot 'hosted-egress-wfp-mocks.cs'))
Add-Type -TypeDefinition ($source + "`n" + ($fixture -replace '(?m)^using [^;]+;\r?\n', '')) -ErrorAction Stop
[HpmHostedEgressFixture]::Run()
