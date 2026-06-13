@echo off
chcp 65001 >nul 2>&1
title HTTPS Proxy Manager Dev

set "SCRIPT_DIR=%~dp0"
cd /d "%SCRIPT_DIR%"

where npm >nul 2>&1
if errorlevel 1 (
  echo npm was not found. Please install Node.js first.
  echo.
  pause
  exit /b 1
)

where node >nul 2>&1
if errorlevel 1 (
  echo node was not found. Please install Node.js first.
  echo.
  pause
  exit /b 1
)

if not exist "package.json" (
  echo package.json was not found. Current directory is not the manager root: %CD%
  echo.
  pause
  exit /b 1
)

if not exist "tauri-ui\electron-ui.html" (
  echo tauri-ui\electron-ui.html was not found.
  echo.
  pause
  exit /b 1
)

if not exist "scripts\dev-static-server.js" (
  echo scripts\dev-static-server.js was not found.
  echo.
  pause
  exit /b 1
)

REM Clean up stale Tauri dev child node.exe processes that hold
REM src-tauri\target\debug\runtime\node\node.exe open; otherwise the
REM next `cargo run` fails with os error 32 ("Another program is using
REM this file") when copying the runtime into the bundle.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\kill-stale-tauri-dev.ps1" 2>nul

REM Sync the latest openai-proxy.js into the bundled debug location so the
REM Tauri runtime (which spawns the bundled copy, not the repo-root source)
REM picks up the same code we just edited.
if exist "src-tauri\target\debug\openai-proxy.js" (
  copy /Y "openai-proxy.js" "src-tauri\target\debug\openai-proxy.js" >nul
  if errorlevel 1 (
    echo [warn] failed to sync openai-proxy.js into src-tauri\target\debug\
  )
)

echo Starting frontend static server: http://localhost:1430
node scripts\dev-static-server.js --ensure
if not errorlevel 1 goto launch_manager

echo The frontend static server did not serve this project's UI.
echo Please make sure port 1430 is not occupied by another program, then check .hpm-runtime\.static-server.err.log.
echo.
pause
exit /b 1

:launch_manager

echo Starting dev manager...
echo This mode loads tauri-ui\electron-ui.html for the latest UI changes.
echo.
npm run tauri:dev

if errorlevel 1 (
  echo.
  echo Dev manager failed to start. Please check the error above.
  echo If it still waits for localhost:1430, check .hpm-runtime\.static-server.err.log.
  pause
)
