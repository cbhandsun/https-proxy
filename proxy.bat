@echo off
chcp 65001 >nul
title OpenAI HTTPS Proxy

set "SCRIPT_DIR=%~dp0"
set "COMMAND=%~1"
if "%COMMAND%"=="" set "COMMAND=start"

if /i "%COMMAND%"=="help" goto usage
if /i "%COMMAND%"=="/?" goto usage
if /i "%COMMAND%"=="-h" goto usage
if /i "%COMMAND%"=="--help" goto usage

pwsh -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT_DIR%proxy.ps1" %*
goto end

:usage
echo 用法: proxy.bat [start^|stop^|restart^|status^|logs^|tail^|open^|health^|config^|trust-cert]
echo.
echo   start    后台启动代理
echo   stop     停止代理
echo   restart  重启代理
echo   status   查看状态
echo   logs     查看最近日志
echo   tail     实时查看日志
echo   open     打开日志文件
echo   health   检查代理端口
echo   config   打开代理配置
echo   trust-cert  信任本地代理 CA 证书
echo.
echo   双击 启动管理器.bat 可以打开系统托盘管理器
echo.

:end
if /i "%COMMAND%"=="tail" goto no_pause
if /i "%COMMAND%"=="open" goto no_pause
if defined CLAUDECODE goto no_pause
echo.
pause
:no_pause
