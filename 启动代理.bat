@echo off
chcp 65001 >nul 2>&1
title HTTPS Proxy

set "SCRIPT_DIR=%~dp0"
cd /d "%SCRIPT_DIR%"

if not exist "%SCRIPT_DIR%proxy.bat" (
  echo 未找到 proxy.bat，当前目录不是代理目录：%CD%
  echo.
  if not defined NO_PAUSE pause
  exit /b 1
)

call "%SCRIPT_DIR%proxy.bat" start
