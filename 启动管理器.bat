@echo off
chcp 65001 >nul 2>&1
title HTTPS Proxy Manager

set "SCRIPT_DIR=%~dp0"
cd /d "%SCRIPT_DIR%"
set "NO_PAUSE=1"

if not defined HPM_NODE_EXECUTABLE (
  if exist "%SCRIPT_DIR%proxy.bat" (
    call "%SCRIPT_DIR%proxy.bat" start
  )
)

set "PORTABLE_EXE=%SCRIPT_DIR%https-proxy-manager.exe"
set "CARGO_APP_EXE=%SCRIPT_DIR%src-tauri\target\release\app.exe"

if exist "%CARGO_APP_EXE%" (
  powershell -NoProfile -ExecutionPolicy Bypass -Command "$src = '%CARGO_APP_EXE%'; $dst = '%PORTABLE_EXE%'; if (-not (Test-Path $dst) -or ((Get-Item $src).LastWriteTimeUtc -gt (Get-Item $dst).LastWriteTimeUtc)) { try { Copy-Item -Path $src -Destination $dst -Force -ErrorAction Stop } catch {} }" >nul 2>&1
)

if exist "%PORTABLE_EXE%" (
  start "" /D "%SCRIPT_DIR%" "%PORTABLE_EXE%"
  exit /b 0
)

set "RELEASE_EXE=%SCRIPT_DIR%src-tauri\target\release\https-proxy-manager.exe"
if exist "%RELEASE_EXE%" (
  start "" /D "%SCRIPT_DIR%" "%RELEASE_EXE%"
  exit /b 0
)

if exist "%CARGO_APP_EXE%" (
  start "" /D "%SCRIPT_DIR%" "%CARGO_APP_EXE%"
  exit /b 0
)

where npm >nul 2>&1
if errorlevel 1 (
  echo [ERROR] npm not found. Please install Node.js.
  if not defined NO_PAUSE pause
  exit /b 1
)

if not exist "package.json" (
  echo [ERROR] package.json not found in %CD%
  if not defined NO_PAUSE pause
  exit /b 1
)

npm run tauri:dev
exit /b %ERRORLEVEL%
