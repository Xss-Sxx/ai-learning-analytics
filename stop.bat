@echo off
REM 切换到 UTF-8 代码页，避免中文输出乱码
chcp 65001 >nul
REM 启用延迟变量展开：循环中更新 FOUND/FAILED 后需要立即读取新值
setlocal enabledelayedexpansion
REM 切到脚本所在目录
cd /d "%~dp0"
title 停止 AI学情收集系统

echo.
echo   ==========================================
echo      停止 AI学情收集系统
echo   ==========================================
echo.

set PORT=3000
REM FOUND：是否找到占用端口的进程；FAILED：是否有进程停止失败
set FOUND=0
set FAILED=0

REM 逐个结束监听该端口的进程（token 5 为 PID）
for /f "tokens=5" %%a in ('netstat -ano ^| findstr /r /c:":%PORT% .*LISTENING"') do (
    set FOUND=1
    echo   正在停止进程 PID %%a ...
    taskkill /F /PID %%a >nul 2>&1
    REM errorlevel 非 0 说明结束失败，通常是权限不足
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
