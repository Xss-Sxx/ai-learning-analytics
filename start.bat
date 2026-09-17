@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion
cd /d "%~dp0"
title AI学情收集系统

echo.
echo   ==========================================
echo      AI学情收集系统 启动程序
echo   ==========================================
echo.

REM ---------- 1. 检查 Node.js ----------
where node >nul 2>&1
if errorlevel 1 (
    echo   [错误] 未检测到 Node.js
    echo.
    echo   请先安装 Node.js 16 或更高版本：
    echo   https://nodejs.org/
    echo.
    pause
    exit /b 1
)

for /f "tokens=2 delims=v." %%a in ('node -v') do set NODE_MAJOR=%%a
if !NODE_MAJOR! LSS 16 (
    echo   [错误] Node.js 版本过低（当前 v!NODE_MAJOR!），需要 16 或更高版本
    echo   下载地址：https://nodejs.org/
    echo.
    pause
    exit /b 1
)
for /f %%a in ('node -v') do echo   [1/4] Node.js 版本 %%a  检查通过

REM ---------- 2. 检查依赖 ----------
if not exist "node_modules\express" (
    echo   [2/4] 首次运行，正在安装依赖，请稍候...
    call npm install --no-audit --no-fund
    if errorlevel 1 (
        echo.
        echo   [错误] 依赖安装失败
        echo   请检查网络连接后重试，或手动执行：npm install
        echo.
        pause
        exit /b 1
    )
    echo   [2/4] 依赖安装完成
) else (
    echo   [2/4] 依赖已就绪
)

REM ---------- 3. 检查并释放端口 ----------
set PORT=3000
set PORT_PID=
for /f "tokens=5" %%a in ('netstat -ano ^| findstr /r /c:":%PORT% .*LISTENING"') do set PORT_PID=%%a

if defined PORT_PID (
    echo   [3/4] 端口 %PORT% 被进程 !PORT_PID! 占用，正在释放...
    taskkill /F /PID !PORT_PID! >nul 2>&1
    if errorlevel 1 (
        echo.
        echo   [错误] 无法自动释放端口 %PORT%
        echo   请右键以【管理员身份运行】本脚本，或手动执行：
        echo     taskkill /F /PID !PORT_PID!
        echo.
        pause
        exit /b 1
    )
    timeout /t 2 /nobreak >nul
    echo   [3/4] 端口 %PORT% 已释放
) else (
    echo   [3/4] 端口 %PORT% 可用
)

REM ---------- 4. 启动服务 ----------
echo   [4/4] 正在启动服务...
echo.
echo   ------------------------------------------
echo     本机访问： http://localhost:%PORT%
for /f "tokens=2 delims=:" %%a in ('ipconfig ^| findstr /c:"IPv4"') do (
    set LANIP=%%a
    set LANIP=!LANIP: =!
    if not "!LANIP!"=="127.0.0.1" echo     局域网访问： http://!LANIP!:%PORT%
)
echo   ------------------------------------------
echo.
echo     数据保存在本机 data 目录，不上传外网
echo     关闭本窗口即可停止服务
echo.

start "" http://localhost:%PORT%

node server.js

echo.
echo   服务已停止。
pause