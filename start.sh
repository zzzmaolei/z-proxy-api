#!/usr/bin/env bash
# ==============================================================================
# z.proxy.api 一键部署与启动脚本 (Linux / macOS)
# ==============================================================================

set -eo pipefail

# 切换到脚本所在目录（根目录）
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

# 优雅日志输出函数（带 ANSI 终端色彩）
log_info()    { echo -e "\033[34m[INFO]\033[0m $*"; }
log_warn()    { echo -e "\033[33m[WARN]\033[0m $*"; }
log_error()   { echo -e "\033[31m[ERROR]\033[0m $*" >&2; }
log_success() { echo -e "\033[32m[SUCCESS]\033[0m $*"; }

echo "==================================================="
echo "         z.proxy.api 一键启动与环境初始化"
echo "==================================================="
echo ""

# 1. 检查 Node.js 是否安装及版本是否 >= 18
if ! command -v node >/dev/null 2>&1; then
    log_error "未检测到 Node.js，请先安装 Node.js (推荐 LTS 版本，>= 18.0.0)"
    log_error "下载参考: https://nodejs.org/"
    exit 1
fi

NODE_RAW="$(node -v 2>/dev/null || true)"
NODE_MAJOR="$(echo "$NODE_RAW" | sed 's/^v//' | cut -d. -f1)"

if [ -z "$NODE_MAJOR" ]; then
    log_error "无法获取 Node.js 版本信息"
    exit 1
fi

if [ "$NODE_MAJOR" -lt 18 ]; then
    log_error "当前 Node.js 版本为 ${NODE_RAW}，本项目要求 Node.js >= 18.0.0"
    log_error "请升级 Node.js 后再运行此脚本"
    exit 1
fi
log_info "Node.js 环境检查通过: ${NODE_RAW}"

# 2. 自动检测并创建 data/ 和 logs/ 目录
if [ ! -d "data" ]; then
    log_info "正在创建 data/ 目录..."
    mkdir -p "data"
fi
if [ ! -d "logs" ]; then
    log_info "正在创建 logs/ 目录..."
    mkdir -p "logs"
fi

# 3. 自动检查 .env，若不存在则从 .env.example 复制
if [ ! -f ".env" ]; then
    if [ -f ".env.example" ]; then
        log_info ".env 不存在，正在从 .env.example 初始化..."
        cp ".env.example" ".env"
        log_success "已成功生成 .env，请根据需要修改环境变量配置"
    else
        log_warn "未找到 .env 且不存在 .env.example 模板文件"
    fi
else
    log_info "环境变量文件 .env 已就绪"
fi

# 4. 自动检查 data/config.json，若不存在则从 data/config.example.json 复制
if [ ! -f "data/config.json" ]; then
    if [ -f "data/config.example.json" ]; then
        log_info "data/config.json 不存在，正在从 data/config.example.json 初始化..."
        cp "data/config.example.json" "data/config.json"
        log_success "已成功生成 data/config.json"
    else
        log_warn "未找到 data/config.json 且不存在模板文件，跳过"
    fi
else
    log_info "配置文件 data/config.json 已就绪"
fi

# 5. 自动检查后端依赖 (若 node_modules 不存在则执行 npm install)
if [ ! -d "node_modules" ]; then
    log_info "检测到后端依赖尚未安装 (node_modules 不存在)，正在执行 npm install..."
    npm install
    log_success "后端依赖安装完成"
else
    log_info "后端依赖 (node_modules) 已就绪"
fi

# 6. 自动检查前端产物 (若 public/dist 不存在，则进入 public 执行 npm install && npm run build)
if [ ! -d "public/dist" ]; then
    log_info "检测到前端构建产物 public/dist 不存在，开始自动构建前端..."
    if [ -d "public" ]; then
        (
            cd "public"
            if [ ! -d "node_modules" ]; then
                log_info "正在安装前端依赖..."
                npm install
            fi
            log_info "正在编译前端代码 (npm run build)..."
            npm run build
        )
        log_success "前端构建完成，产物已写入 public/dist"
    else
        log_warn "未找到 public 目录，跳过前端构建"
    fi
else
    log_info "前端静态资源 (public/dist) 已就绪"
fi

# 7. 解析启动参数：常规前台启动 vs --daemon 后台启动
DAEMON_MODE=false
APP_ARGS=()

for arg in "$@"; do
    case "$arg" in
        --daemon|-d)
            DAEMON_MODE=true
            ;;
        *)
            APP_ARGS+=("$arg")
            ;;
    esac
done

echo ""
echo "==================================================="

if [ "$DAEMON_MODE" = true ]; then
    log_info "正在以守护模式 (--daemon) 启动服务..."
    LOG_FILE="logs/server.log"
    PID_FILE="logs/server.pid"

    nohup node src/start.js "${APP_ARGS[@]}" >> "$LOG_FILE" 2>&1 &
    PID=$!
    echo "$PID" > "$PID_FILE"

    log_success "服务已在后台成功启动 (PID: $PID)"
    log_info "进程 PID 文件: $PID_FILE"
    log_info "运行日志文件: $LOG_FILE"
    log_info "查看实时日志请运行: tail -f $LOG_FILE"
else
    log_info "正在启动 z.proxy.api 服务 (前台模式)..."
    echo "==================================================="
    echo ""
    exec node src/start.js "${APP_ARGS[@]}"
fi
