# Cleanup script: kill any stale Tauri dev child node.exe that is
# holding src-tauri\target\debug\runtime\node\node.exe open. Without
# this, the next `cargo run` fails with os error 32 ("Another program
# is using this file") when the build script tries to copy the
# runtime into the bundle.
$ErrorActionPreference = 'SilentlyContinue'
$targets = Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.ExecutablePath -and ($_.ExecutablePath -like '*src-tauri\target\debug\runtime\node\node.exe') }
foreach ($t in $targets) {
  Write-Output "killing stale tauri dev child pid=$($t.ProcessId) path=$($t.ExecutablePath)"
  Stop-Process -Id $t.ProcessId -Force
}
