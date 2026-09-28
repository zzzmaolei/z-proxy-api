@echo off
echo ==============================================
echo   TLS Sidecar: Go uTLS 编译脚本 (Windows)
echo ==============================================
echo.
echo [1/2] 下载 Go 依赖...
cd /d "%~dp0"
go mod tidy
if %ERRORLEVEL% NEQ 0 (
    echo [错误] go mod tidy 失败，请确认已安装 Go 1.20+
    pause
    exit /b 1
)

echo [2/2] 编译 tls-sidecar.exe...
go build -o tls-sidecar.exe -ldflags="-s -w" .
if %ERRORLEVEL% NEQ 0 (
    echo [错误] 编译失败
    pause
    exit /b 1
)

echo.
echo ==============================================
echo   编译成功! tls-sidecar.exe 已生成
echo   启动方式: tls-sidecar.exe
echo   默认端口: 9091
echo   自定义端口: set PORT=9092 ^&^& tls-sidecar.exe
echo ==============================================
pause