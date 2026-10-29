param([string]$Repository,[switch]$RawFixture)
$ErrorActionPreference='Stop'
$files=@('native','metadata','path','reader')|ForEach-Object {Join-Path $Repository ('scripts/lib/persistent-io-schema-tdh-'+$_+'.cs')}
$files+=@('native','native-properties','native-selection','raw-reader')|ForEach-Object {Join-Path $Repository ('scripts/lib/persistent-filterio-'+$_+'.cs')}
$files+=Join-Path $PSScriptRoot 'persistent-filterio-native.cs'
Add-Type -Path $files -ErrorAction Stop
if($RawFixture){[Console]::Out.Write([FilterIoNativeTests]::RawFixture());exit 0}
$result=[FilterIoNativeTests]::Run()
[Console]::Out.WriteLine(($result|ConvertTo-Json -Compress))
