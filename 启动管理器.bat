@echo off
chcp 65001 >nul 2>&1
title HTTPS Proxy Manager

set "SCRIPT_DIR=%~dp0"
cd /d "%SCRIPT_DIR%"

set "PORTABLE_EXE=%SCRIPT_DIR%https-proxy-manager.exe"
if exist "%PORTABLE_EXE%" (
  powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process -FilePath '%PORTABLE_EXE%' -WorkingDirectory '%SCRIPT_DIR%'"
  exit /b 0
)

set "RELEASE_EXE=%SCRIPT_DIR%src-tauri\target\release\https-proxy-manager.exe"
if exist "%RELEASE_EXE%" (
  powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process -FilePath '%RELEASE_EXE%' -WorkingDirectory '%SCRIPT_DIR%'"
  exit /b 0
)

set "RELEASE_EXE=%SCRIPT_DIR%src-tauri\target\release\app.exe"
if exist "%RELEASE_EXE%" (
  powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process -FilePath '%RELEASE_EXE%' -WorkingDirectory '%SCRIPT_DIR%'"
  exit /b 0
)

where npm >nul 2>&1
if errorlevel 1 (
  echo 未检测到 npm，请先安装 Node.js。
  echo.
  if not defined NO_PAUSE pause
  exit /b 1
)

if not exist "package.json" (
  echo 未找到 package.json，当前目录不是管理器目录：%CD%
  echo.
  if not defined NO_PAUSE pause
  exit /b 1
)

if exist "%SCRIPT_DIR%启动管理器-开发版.bat" (
  echo 未找到已构建的管理器，将启动开发版。
  echo.
  call "%SCRIPT_DIR%启动管理器-开发版.bat"
  exit /b %ERRORLEVEL%
)

echo 未找到可启动的管理器程序，也未找到 启动管理器-开发版.bat。
echo.
if not defined NO_PAUSE pause
exit /b 1
