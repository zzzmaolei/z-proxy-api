@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion

REM 确保工作目录为当前脚本所在目录（无硬编码绝对路径）
cd /d "%~dp0"

echo ===================================================
echo          z.proxy.api 一键启动与环境初始化
echo ===================================================
echo.

REM 1. 检查 Node.js 是否安装
where node >nul 2>&1
if %errorlevel% neq 0 (
    echo [ERROR] 未检测到 Node.js，请先安装 Node.js [推荐 LTS 版本，>= 18.0.0]
    echo 下载地址: https://nodejs.org/
    exit /b 1
)

REM 检查 Node.js 版本 (>= 18)
set "NODE_RAW="
for /f "tokens=1 delims=." %%a in ('node -v 2^>nul') do (
    set "NODE_RAW=%%a"
)
set "NODE_VER=!NODE_RAW:v=!"

if not defined NODE_VER (
    echo [ERROR] 无法获取 Node.js 版本信息
    exit /b 1
)

if !NODE_VER! lss 18 (
    echo [ERROR] 当前 Node.js 版本为 !NODE_RAW!，本项目要求 Node.js >= 18.0.0
    echo 请升级 Node.js 后再运行此脚本
    exit /b 1
)
echo [INFO] Node.js 环境检查通过: !NODE_RAW!

REM 2. 自动检测并创建 data/ 和 logs/ 目录
if not exist "data" (
    echo [INFO] 正在创建 data/ 目录...
    mkdir "data"
)
if not exist "logs" (
    echo [INFO] 正在创建 logs/ 目录...
    mkdir "logs"
)

REM 3. 自动检查 .env，若不存在则从 .env.example 复制
if not exist ".env" (
    if exist ".env.example" (
        echo [INFO] .env 不存在，正在从 .env.example 初始化...
        copy ".env.example" ".env" >nul
        echo [SUCCESS] 已成功生成 .env，请根据需要修改环境变量配置
    ) else (
        echo [WARN] 未找到 .env 且不存在 .env.example 模板文件
    )
) else (
    echo [INFO] 环境变量文件 .env 已就绪
)

REM 4. 自动检查 data/config.json，若不存在则从 data/config.example.json 复制
if not exist "data\config.json" (
    if exist "data\config.example.json" (
        echo [INFO] data\config.json 不存在，正在从 data\config.example.json 初始化...
        copy "data\config.example.json" "data\config.json" >nul
        echo [SUCCESS] 已成功生成 data\config.json
    ) else (
        echo [WARN] 未找到 data\config.json 且不存在模板文件，跳过
    )
) else (
    echo [INFO] 配置文件 data\config.json 已就绪
)

REM 5. 自动检查后端依赖 [若 node_modules 不存在则执行 npm install]
if not exist "node_modules" (
    echo [INFO] 检测到后端依赖尚未安装 [node_modules 不存在]，正在执行 npm install...
    call npm install
    if !errorlevel! neq 0 (
        echo [ERROR] 后端依赖安装失败，请检查网络或 npm 源配置
        exit /b !errorlevel!
    )
    echo [SUCCESS] 后端依赖安装完成
) else (
    echo [INFO] 后端依赖 [node_modules] 已就绪
)

REM 6. 自动检查前端产物 [若 public/dist 不存在，则进入 public 执行 npm install && npm run build]
if not exist "public\dist" (
    echo [INFO] 检测到前端构建产物 public\dist 不存在，开始自动构建前端...
    if exist "public" (
        pushd "public"
        if not exist "node_modules" (
            echo [INFO] 正在安装前端依赖...
            call npm install
            if !errorlevel! neq 0 (
                echo [ERROR] 前端依赖安装失败
                popd
                exit /b !errorlevel!
            )
        )
        echo [INFO] 正在编译前端代码 [npm run build]...
        call npm run build
        set "BUILD_CODE=!errorlevel!"
        popd
        if !BUILD_CODE! neq 0 (
            echo [ERROR] 前端构建失败 [退出码: !BUILD_CODE!]
            exit /b !BUILD_CODE!
        )
        echo [SUCCESS] 前端构建完成，产物已写入 public\dist
    ) else (
        echo [WARN] 未找到 public 目录，跳过前端构建
    )
) else (
    echo [INFO] 前端静态资源 [public\dist] 已就绪
)

REM 7. 启动服务
echo.
echo ===================================================
echo [INFO] 正在启动 z.proxy.api 服务 [node src/start.js]...
echo ===================================================
echo.
node src/start.js