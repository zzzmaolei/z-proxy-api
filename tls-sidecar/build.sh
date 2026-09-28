#!/bin/bash
echo "=============================================="
echo "  TLS Sidecar: Go uTLS 编译脚本 (Linux/macOS)"
echo "=============================================="
echo ""
echo "[1/2] 下载 Go 依赖..."
cd "$(dirname "$0")"
go mod tidy
if [ $? -ne 0 ]; then
    echo "[错误] go mod tidy 失败，请确认已安装 Go 1.20+"
    exit 1
fi

echo "[2/2] 编译 tls-sidecar..."
go build -o tls-sidecar -ldflags="-s -w" .
if [ $? -ne 0 ]; then
    echo "[错误] 编译失败"
    exit 1
fi

echo ""
echo "=============================================="
echo "  编译成功! tls-sidecar 已生成"
echo "  启动方式: ./tls-sidecar"
echo "  默认端口: 9091"
echo "  自定义端口: PORT=9092 ./tls-sidecar"
echo "=============================================="