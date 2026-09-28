@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion

REM 1. 切换到项目根目录（纯相对路径，严禁包含任何绝对盘符或用户名）
cd /d "%~dp0.."

echo ===================================================
echo          z.proxy.api 热重启与端口释放工具
echo ===================================================
echo.

REM 2. 从 .env 提取 SERVICE_PORT [默认 8080]
set "PORT=8080"
if exist ".env" (
    for /f "usebackq tokens=1,* delims==" %%A in (".env") do (
        set "KEY=%%A"
        set "VAL=%%B"
        if /i "!KEY!"=="SERVICE_PORT" (
            for /f "tokens=1" %%V in ("!VAL!") do set "PORT=%%V"
        )
    )
)
set "PORT=!PORT:"=!"
set "PORT=!PORT:'=!"
set "PORT=!PORT: =!"
if "!PORT!"=="" set "PORT=8080"

echo [INFO] 目标服务端口: !PORT!

REM 3. 查找占用目标端口且处于 LISTENING 状态的进程 PID 并安全释放
echo [INFO] 正在查找监听端口 !PORT! 的进程...
set "FOUND=0"

for /f "tokens=5" %%a in ('netstat -ano ^| findstr /C:":!PORT! " ^| findstr "LISTENING"') do (
    if not defined _KILLED_%%a (
        set "_KILLED_%%a=1"
        set /a FOUND+=1
        echo [INFO] 发现占用端口的进程 PID: %%a，正在终止...
        taskkill /F /PID %%a >nul 2>&1
        if !errorlevel! equ 0 (
            echo   [SUCCESS] 已成功终止 PID: %%a
        ) else (
            echo   [WARN] 尝试终止 PID %%a 返回码 !errorlevel! [可能权限不足或已退出]
        )
    )
)

if !FOUND! equ 0 (
    echo [INFO] 未发现监听端口 !PORT! 的活动进程，无需清理
) else (
    echo [INFO] 等待端口 !PORT! 完全释放...
    timeout /t 2 /nobreak >nul 2>&1
    netstat -ano | findstr /C:":!PORT! " | findstr "LISTENING" >nul 2>&1
    if !errorlevel! equ 0 (
        echo [WARN] 端口 !PORT! 仍有监听，尝试继续拉起新实例...
    ) else (
        echo [SUCCESS] 端口 !PORT! 已完全释放
    )
)

REM 4. 启动服务 [新窗口异步启动，绝不使用阻塞式 pause 防止 Agent 会话挂起]
echo.
echo [INFO] 正在拉起服务实例...
start "z.proxy.api" /d "%CD%" cmd /k "node src/start.js"

echo [SUCCESS] 服务已在独立窗口拉起 [端口: !PORT!]
exit /b 0