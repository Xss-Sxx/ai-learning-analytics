#!/bin/bash

# AI学情收集系统启动脚本

echo "🎓 启动AI学情收集系统..."

# 检查Node.js
if ! command -v node &> /dev/null; then
    echo "❌ 未找到Node.js，请先安装Node.js"
    exit 1
fi

# 检查npm
if ! command -v npm &> /dev/null; then
    echo "❌ 未找到npm，请检查Node.js安装"
    exit 1
fi

# 检查API密钥配置
if [ ! -f "config.js" ]; then
    echo "❌ 未找到config.js文件"
    exit 1
fi

if grep -q "your-deepseek-api-key-here" config.js; then
    echo "⚠️  请先配置API密钥"
    echo "编辑 config.js 文件，将 'your-deepseek-api-key-here' 替换为您的实际API密钥"
    exit 1
fi

# 检查依赖
if [ ! -d "node_modules" ]; then
    echo "📦 正在安装依赖..."
    npm install
    if [ $? -ne 0 ]; then
        echo "❌ 依赖安装失败"
        exit 1
    fi
fi

# 检查端口占用
PORT=3000
if lsof -Pi :$PORT -sTCP:LISTEN -t >/dev/null ; then
    echo "⚠️  端口 $PORT 已被占用，请先关闭占用该端口的程序"
    exit 1
fi

# 创建必要的目录
mkdir -p data/sessions
mkdir -p data/reports
mkdir -p data/backups
mkdir -p logs

echo "🚀 启动服务器..."
echo "访问地址: http://localhost:$PORT"
echo "按 Ctrl+C 停止服务"

# 启动服务器
node server.js