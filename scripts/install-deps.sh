#!/bin/bash

# AI学情收集系统 - 依赖安装脚本
# 支持Linux、macOS和Windows (WSL)
# 执行流程：检查 Node/npm → 创建数据目录 → 安装依赖 → 校验必要文件
#          → 生成 start.sh / start.bat → 提示配置 API Key

echo "🚀 开始安装AI学情收集系统依赖..."

# 检查Node.js版本
check_nodejs() {
    if command -v node &> /dev/null; then
        # 取主版本号：v20.11.1 → 20
        NODE_VERSION=$(node --version | cut -d'v' -f2 | cut -d'.' -f1)
        if [ "$NODE_VERSION" -ge 16 ]; then
            echo "✅ Node.js版本检查通过: $(node --version)"
            return 0
        else
            echo "❌ Node.js版本过低，需要16.0或更高版本"
            return 1
        fi
    else
        echo "❌ 未安装Node.js，请先安装Node.js 16.0或更高版本"
        echo "下载地址: https://nodejs.org/"
        return 1
    fi
}

# 检查npm
check_npm() {
    if command -v npm &> /dev/null; then
        echo "✅ npm版本检查通过: $(npm --version)"
        return 0
    else
        echo "❌ 未找到npm，请检查Node.js安装"
        return 1
    fi
}

# 创建必要的目录
create_directories() {
    echo "📁 创建必要的目录..."
    
    # -p：递归创建，且目录已存在时不报错
    mkdir -p data/sessions
    mkdir -p data/reports
    mkdir -p data/backups
    mkdir -p logs
    
    echo "✅ 目录创建完成"
}

# 安装npm依赖
install_npm_deps() {
    echo "📦 安装npm依赖..."
    
    if [ -f "package.json" ]; then
        # $? 为上一条命令的退出码，0 表示成功
        npm install
        if [ $? -eq 0 ]; then
            echo "✅ npm依赖安装成功"
            return 0
        else
            echo "❌ npm依赖安装失败"
            return 1
        fi
    else
        echo "❌ 未找到package.json文件"
        return 1
    fi
}

# 配置API密钥
setup_api_key() {
    echo "🔑 配置Deepseek API密钥..."
    
    if [ ! -f "config.js" ]; then
        echo "❌ 未找到config.js文件"
        return 1
    fi
    
    # 仍含占位符说明尚未配置：给出指引并返回失败（提示性质，不阻断安装）
    if grep -q "your-deepseek-api-key-here" config.js; then
        echo "⚠️  请手动配置API密钥"
        echo "编辑 config.js 文件，将 'your-deepseek-api-key-here' 替换为您的实际API密钥"
        echo "获取API密钥: https://platform.deepseek.com/"
        echo ""
        echo "配置完成后，运行以下命令启动系统:"
        echo "  npm start"
        echo ""
        return 1
    else
        echo "✅ API密钥已配置"
        return 0
    fi
}

# 验证安装
verify_installation() {
    echo "🔍 验证安装..."
    
    # 任一必要文件缺失都会导致启动失败，先收集缺失清单再统一提示
    local required_files=(
        "package.json"
        "config.js"
        "server.js"
        "public/index.html"
        "utils/ai-helper.js"
        "utils/excel-generator.js"
        "utils/data-processor.js"
    )
    
    local missing_files=()
    for file in "${required_files[@]}"; do
        if [ ! -f "$file" ]; then
            missing_files+=("$file")
        fi
    done
    
    if [ ${#missing_files[@]} -eq 0 ]; then
        echo "✅ 所有必要文件都存在"
        return 0
    else
        echo "❌ 缺少以下文件:"
        for file in "${missing_files[@]}"; do
            echo "  - $file"
        done
        return 1
    fi
}

# 设置启动脚本
setup_startup_script() {
    echo "🎯 设置启动脚本..."
    
    # heredoc 中 'EOF' 加引号：内容原样写入，不展开变量
    cat > start.sh << 'EOF'
#!/bin/bash

# AI学情收集系统启动脚本

echo "🎓 启动AI学情收集系统..."

# 检查依赖
if [ ! -d "node_modules" ]; then
    echo "📦 正在安装依赖..."
    npm install
fi

# 启动服务器
echo "🚀 启动服务器..."
node server.js
EOF
    
    # 赋予可执行权限，否则 ./start.sh 无法直接运行
    chmod +x start.sh
    
    echo "✅ 启动脚本已创建 (start.sh)"
    echo "您也可以直接运行: npm start"
}

# 设置Windows启动脚本
setup_windows_script() {
    echo "🎯 设置Windows启动脚本..."
    
    # 创建Windows启动脚本
    cat > start.bat << 'EOF'
@echo off
echo 🎓 启动AI学情收集系统...

REM 检查依赖
if not exist "node_modules" (
    echo 📦 正在安装依赖...
    npm install
)

REM 启动服务器
echo 🚀 启动服务器...
node server.js

pause
EOF
    
    echo "✅ Windows启动脚本已创建 (start.bat)"
}

# 主安装流程：按序执行，任一步失败即 exit 1（用 $? 判断上一步返回值）
main() {
    echo "🎯 开始安装AI学情收集系统..."
    echo "==================================="
    
    # 检查环境
    check_nodejs
    if [ $? -ne 0 ]; then
        exit 1
    fi
    
    check_npm
    if [ $? -ne 0 ]; then
        exit 1
    fi
    
    # 创建目录
    create_directories
    
    # 安装依赖
    install_npm_deps
    if [ $? -ne 0 ]; then
        exit 1
    fi
    
    # 验证安装
    verify_installation
    if [ $? -ne 0 ]; then
        exit 1
    fi
    
    # 设置启动脚本
    setup_startup_script
    setup_windows_script
    
    # 配置API密钥
    setup_api_key
    
    echo ""
    echo "🎉 安装完成！"
    echo "==================================="
    echo "📋 下一步操作:"
    echo "1. 配置API密钥: 编辑 config.js 文件"
    echo "2. 启动系统: ./start.sh 或 npm start"
    echo "3. 访问系统: http://localhost:3000"
    echo ""
    echo "📖 更多信息请查看 README.md"
    echo "🔧 技术支持: 查看项目文档或联系开发团队"
}

# 运行主函数
main
