#!/bin/bash

# AI学情收集系统启动脚本（Linux / macOS / WSL）
# 作用：启动前完成环境检查，最终前台运行 node server.js

echo "🎓 启动AI学情收集系统..."

# 检查 Node.js 是否可用（command -v 只判断命令是否存在）
if ! command -v node &> /dev/null; then
    echo "❌ 未找到Node.js，请先安装Node.js"
    exit 1
fi

# 检查 npm（通常随 Node 一起安装）
if ! command -v npm &> /dev/null; then
    echo "❌ 未找到npm，请检查Node.js安装"
    exit 1
fi

# 检查配置文件是否存在
if [ ! -f "config.js" ]; then
    echo "❌ 未找到config.js文件"
    exit 1
fi

# 仍含占位符说明尚未配置 Key：直接退出并提示编辑位置
if grep -q "your-deepseek-api-key-here" config.js; then
    echo "⚠️  请先配置API密钥"
    echo "编辑 config.js 文件，将 'your-deepseek-api-key-here' 替换为您的实际API密钥"
    exit 1
fi

# 首次运行（无 node_modules）时自动安装依赖
if [ ! -d "node_modules" ]; then
    echo "📦 正在安装依赖..."
    npm install
    if [ $? -ne 0 ]; then
        echo "❌ 依赖安装失败"
        exit 1
    fi
fi

# 检查端口占用：lsof 有输出说明端口已在监听，提前拦截避免启动失败
PORT=3000
if lsof -Pi :$PORT -sTCP:LISTEN -t >/dev/null ; then
    echo "⚠️  端口 $PORT 已被占用，请先关闭占用该端口的程序"
    exit 1
fi

# 提前建好数据与日志目录，避免首次写入时报错
mkdir -p data/sessions
mkdir -p data/reports
mkdir -p data/backups
mkdir -p logs

echo "🚀 启动服务器..."
echo "访问地址: http://localhost:$PORT"
echo "按 Ctrl+C 停止服务"

# 前台运行服务：关闭终端或按 Ctrl+C 即停止
node server.js
