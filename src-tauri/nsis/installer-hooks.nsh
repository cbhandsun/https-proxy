!define HTTPS_PROXY_INSTALLER_HOOK_DIR "${__FILEDIR__}"

!macro StopInstalledHttpsProxyManager
  InitPluginsDir
  File /oname=$PLUGINSDIR\stop-installed-processes.ps1 "${HTTPS_PROXY_INSTALLER_HOOK_DIR}\stop-installed-processes.ps1"
  DetailPrint "Stopping existing HTTPS Proxy Manager processes..."
  StrCpy $R9 "$INSTDIR"
  StrCpy $R8 "$LOCALAPPDATA\HTTPS Proxy Manager"
  DetailPrint "Process cleanup directory: $R9"
  nsExec::ExecToStack '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\stop-installed-processes.ps1" -InstallDir "$R9" -FallbackInstallDir "$R8"'
  Pop $0
  Pop $1
  ${If} $1 != ""
    DetailPrint "Process cleanup diagnostics: $1"
  ${EndIf}
  ${If} $0 != 0
    DetailPrint "Failed to stop existing HTTPS Proxy Manager processes (exit code $0)."
    Abort "旧版 HTTPS Proxy Manager 仍在运行或文件被占用。安装程序已自动重试，请打开详细信息查看原因后重试。"
  ${EndIf}
!macroend

!macro NSIS_HOOK_PREINSTALL
  !insertmacro StopInstalledHttpsProxyManager
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  !insertmacro StopInstalledHttpsProxyManager
!macroend
