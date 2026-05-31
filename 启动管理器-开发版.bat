@echo off
chcp 65001 >nul 2>&1
title HTTPS Proxy Manager Dev

set "SCRIPT_DIR=%~dp0"
cd /d "%SCRIPT_DIR%"

where npm >nul 2>&1
if errorlevel 1 (
  echo 未检测到 npm，请先安装 Node.js。
  echo.
  pause
  exit /b 1
)

where node >nul 2>&1
if errorlevel 1 (
  echo 未检测到 node，请先安装 Node.js。
  echo.
  pause
  exit /b 1
)

if not exist "package.json" (
  echo 未找到 package.json，当前目录不是管理器目录：%CD%
  echo.
  pause
  exit /b 1
)

if not exist "tauri-ui\electron-ui.html" (
  echo 未找到 tauri-ui\electron-ui.html。
  echo.
  pause
  exit /b 1
)

if not exist "scripts\dev-static-server.js" (
  echo 未找到 scripts\dev-static-server.js。
  echo.
  pause
  exit /b 1
)

echo 正在启动前端静态服务：http://localhost:1430
powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-NetTCPConnection -LocalPort 1430 -State Listen -ErrorAction SilentlyContinue" >nul 2>&1
if errorlevel 1 (
  start "HTTPS Proxy Dev Static Server" /min cmd /c "cd /d "%SCRIPT_DIR%" && node scripts\dev-static-server.js > .static-server.out.log 2> .static-server.err.log"
  timeout /t 2 /nobreak >nul
)

echo 正在启动开发版管理器...
echo 该模式会加载 tauri-ui\electron-ui.html，适合查看最新 UI 改动。
echo.
npm run tauri:dev

if errorlevel 1 (
  echo.
  echo 开发版管理器启动失败，请查看上方错误信息。
  echo 如果仍提示等待 localhost:1430，请查看 .static-server.err.log。
  pause
)
