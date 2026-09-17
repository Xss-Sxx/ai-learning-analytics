@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion
cd /d "%~dp0"
title 停止 AI学情收集系统

echo.
echo   ==========================================
echo      停止 AI学情收集系统
echo   ==========================================
echo.

set PORT=3000
set FOUND=0
set FAILED=0

for /f "tokens=5" %%a in ('netstat -ano ^| findstr /r /c:":%PORT% .*LISTENING"') do (
    set FOUND=1
    echo   正在停止进程 PID %%a ...
    taskkill /F /PID %%a >nul 2>&1
    if errorlevel 1 (
        set FAILED=1
        echo   [失败] 无法停止进程 %%a
    ) else (
        echo   [完成] 进程 %%a 已停止
    )
)

echo.
if "!FOUND!"=="0" (
    echo   端口 %PORT% 上没有运行中的服务。
    goto :done
)

if "!FAILED!"=="1" (
    echo   部分进程停止失败，通常是权限不足。
    echo   请右键以【管理员身份运行】本脚本。
    goto :done
)

REM 二次确认端口是否真的释放
set STILL=
for /f "tokens=5" %%a in ('netstat -ano ^| findstr /r /c:":%PORT% .*LISTENING"') do set STILL=%%a
if defined STILL (
    echo   端口 %PORT% 仍被进程 !STILL! 占用，请以管理员身份重试。
) else (
    echo   服务已停止，端口 %PORT% 已释放。
)

:done
echo.
pause