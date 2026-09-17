// AI学情收集系统 - 前端JavaScript（单页应用主逻辑）
// 说明：使用原生 JS + fetch + EventSource，不依赖框架；所有数据视图都带"序号(seq)"防竞态，
//      并配合 SSE 实时推送 + 30 秒轮询兜底，保证多端打开时数据一致。
class AcademicStatusApp {
    constructor() {
        this.apiBase = window.location.origin;   // 接口基地址：与页面同源，支持局域网访问
        this.currentSessionId = null;            // 当前会话 id（后端返回）
        this.connectionStatus = 'connecting';    // 连接状态：connecting / connected / error
        
        this.initializeApp();
    }

    // 初始化应用
    initializeApp() {
        this.studentRefreshTimer = null;         // 学生数据刷新定时器（预留）
        this.studentOverview = null;             // 学生情况总览缓存
        this.currentStudentPanel = null;         // 当前选中的学生分类面板
        this.currentStudentQuery = '';           // 学生搜索关键词
        this.currentStudentTabName = '';         // 当前选中的分类页签名（刷新后保持选中）
        this.historySeq = 0;                     // 历史数据请求序号，用于丢弃过期响应
        this.studentSeq = 0;                     // 学生数据请求序号
        this.statsSeq = 0;                       // 统计请求序号
        this.lastHistoryKey = null;              // 上次历史数据指纹，内容未变则跳过重绘
        this.lastStudentKey = null;              // 上次学生数据指纹
        this.lastStatsKey = null;                // 上次统计数据指纹
        this.sseRefreshTimer = null;             // SSE 触发的防抖刷新定时器
        this.bindEvents();                       // 绑定所有按钮/输入事件
        this.checkConnection();                  // 先探活，成功后再建会话
        this.loadSystemInfo();                   // 侧边栏运行状态
        this.initializeModals();                 // 模态框内的下拉选项
        this.loadAiMode();                       // 侧边栏 AI 模式标识
        this.connectEvents();                    // 建立 SSE 实时通道
        this.startPeriodicUpdates();             // 开启轮询兜底
    }

    // 绑定事件
    // 说明：所有交互都在这里集中注册，便于查找与维护
    bindEvents() {
        // 发送消息
        document.getElementById('send-btn').addEventListener('click', () => this.sendMessage());
        document.getElementById('user-input').addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {   // 回车即发送
                this.sendMessage();
            }
        });

        // 新建会话
        document.getElementById('new-session-btn').addEventListener('click', () => this.createNewSession());

        // 快速操作
        document.getElementById('download-today-btn').addEventListener('click', () => this.downloadTodayReport());
        document.getElementById('view-history-btn').addEventListener('click', () => this.showHistoryModal());
        document.getElementById('view-students-btn').addEventListener('click', () => this.showStudentModal());
        document.getElementById('refresh-students-btn').addEventListener('click', () => this.refreshStudentData());
        // 两处"导入"按钮都触发同一个隐藏的 file input
        document.getElementById('import-students-quick-btn').addEventListener('click', () => {
            document.getElementById('student-import-file').click();
        });
        document.getElementById('import-students-btn').addEventListener('click', () => {
            document.getElementById('student-import-file').click();
        });
        document.getElementById('student-import-file').addEventListener('change', (e) => this.importStudentFile(e.target));
        document.getElementById('student-search').addEventListener('input', (e) => this.applyStudentSearch(e.target.value));
        document.getElementById('settings-btn').addEventListener('click', () => this.showSettingsModal());
        document.getElementById('save-settings-btn').addEventListener('click', () => this.saveSettings());
        document.getElementById('clear-settings-btn').addEventListener('click', () => this.clearApiKey());
        document.getElementById('open-students-btn').addEventListener('click', () => this.showStudentModal());

        // 历史记录筛选
        document.getElementById('apply-filters-btn').addEventListener('click', () => this.applyHistoryFilters());
        // 下拉/日期一旦变化立即重新筛选
        document.getElementById('history-student-category').addEventListener('change', () => this.applyHistoryFilters());
        document.getElementById('history-start-date').addEventListener('change', () => this.applyHistoryFilters());
        document.getElementById('history-end-date').addEventListener('change', () => this.applyHistoryFilters());
        document.getElementById('history-class').addEventListener('change', () => this.applyHistoryFilters());

        // 模态框关闭
        document.querySelectorAll('.modal-close').forEach(btn => {
            btn.addEventListener('click', (e) => this.closeModal(e.target.closest('.modal')));
        });

        // 点击模态框外部关闭
        document.querySelectorAll('.modal').forEach(modal => {
            modal.addEventListener('click', (e) => {
                if (e.target === modal) {
                    this.closeModal(modal);
                }
            });
        });
    }

    // 检查连接状态
    async checkConnection() {
        try {
            const response = await fetch(`${this.apiBase}/api/health`);
            const data = await response.json();
            
            if (data.status === 'healthy') {
                this.setConnectionStatus('connected');
                this.createNewSession();   // 服务正常时才建立会话
            } else {
                this.setConnectionStatus('error');
            }
        } catch (error) {
            this.setConnectionStatus('error');
            this.showToast('无法连接到服务器，请检查网络连接', 'error');
        }
    }

    // 设置连接状态
    setConnectionStatus(status) {
        this.connectionStatus = status;
        const statusDot = document.getElementById('connection-status');
        const statusText = document.getElementById('status-text');
        
        statusDot.className = `status-dot ${status}`;   // 通过 class 切换圆点颜色
        
        switch (status) {
            case 'connected':
                statusText.textContent = '已连接';
                break;
            case 'connecting':
                statusText.textContent = '连接中...';
                break;
            case 'error':
                statusText.textContent = '连接失败';
                break;
        }
    }

    // 创建新会话
    async createNewSession() {
        try {
            const response = await fetch(`${this.apiBase}/api/session`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                }
            });
            
            const data = await response.json();
            
            if (data.success) {
                this.currentSessionId = data.sessionId;
                this.updateSessionInfo();
                this.addMessage('system', data.message, null, 'AI');   // 首条欢迎语
                
                // 清空输入框
                document.getElementById('user-input').value = '';
                document.getElementById('user-input').focus();
            } else {
                this.showToast('创建会话失败', 'error');
            }
        } catch (error) {
            this.showToast('创建会话失败', 'error');
            console.error('Create session error:', error);
        }
    }

    // 发送消息
    async sendMessage() {
        const input = document.getElementById('user-input');
        const message = input.value.trim();   // 空消息不发送
        
        if (!message) return;
        
        // 显示用户消息
        this.addMessage('user', message, null, '我');
        
        // 清空输入框
        input.value = '';
        
        // 显示加载状态
        this.showLoading(true);
        
        try {
            const response = await fetch(`${this.apiBase}/api/message`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    sessionId: this.currentSessionId,
                    message: message
                })
            });
            
            const data = await response.json();
            
            if (data.success) {
                // 显示AI回复
                this.addMessage('ai', data.message, data.data, 'AI');
                // 如果服务端重建了会话，同步最新的会话ID
                if (data.sessionId) {
                    this.currentSessionId = data.sessionId;
                }
                this.updateSessionState(data.state);
                
                // 两种情况都说明后端数据已变更，需要刷新已打开的数据视图
                if (data.action === 'completed') {
                    this.showToast('Excel报表已生成！', 'success');
                    this.refreshOpenViews();
                }
                if (data.action === 'recorded') {
                    this.showToast('已记录到历史学情与今日报表', 'success');
                    this.refreshOpenViews();
                }
            } else {
                this.showToast(data.message || '发送消息失败', 'error');
            }
        } catch (error) {
            this.showToast('发送消息失败', 'error');
            console.error('Send message error:', error);
        } finally {
            this.showLoading(false);   // 无论成功失败都取消加载态
        }
    }

    // 添加消息到聊天界面
    addMessage(type, text, data = null, avatar = '') {
        const messagesContainer = document.getElementById('chat-messages');
        
        const messageDiv = document.createElement('div');
        messageDiv.className = `message ${type}`;
        
        // 仅显示时分，避免消息行过长
        const time = new Date().toLocaleTimeString('zh-CN', { 
            hour: '2-digit', 
            minute: '2-digit' 
        });
        
        const avatarDiv = document.createElement('div');
        avatarDiv.className = 'message-avatar';
        avatarDiv.textContent = avatar;

        const contentDiv = document.createElement('div');
        contentDiv.className = 'message-content';

        const textDiv = document.createElement('div');
        textDiv.className = 'message-text';
        textDiv.textContent = text;
        contentDiv.appendChild(textDiv);

        if (data) {
            // 结构化数据用隐藏节点承载，便于调试时查看原始返回
            const dataDiv = document.createElement('div');
            dataDiv.className = 'message-data';
            dataDiv.style.display = 'none';
            dataDiv.textContent = JSON.stringify(data);
            contentDiv.appendChild(dataDiv);
        }

        const timeDiv = document.createElement('div');
        timeDiv.className = 'message-time';
        timeDiv.textContent = time;
        contentDiv.appendChild(timeDiv);

        messageDiv.appendChild(avatarDiv);
        messageDiv.appendChild(contentDiv);
        
        messagesContainer.appendChild(messageDiv);
        messagesContainer.scrollTop = messagesContainer.scrollHeight;   // 自动滚到底部
    }

    // 更新会话信息
    updateSessionInfo() {
        document.getElementById('session-id').textContent = this.currentSessionId || '未开始';
    }

    // 更新会话状态
    updateSessionState(state) {
        // 后端状态机的中文映射
        const stateText = {
            'welcome': '欢迎开始',
            'collecting': '信息收集中',
            'confirming': '确认信息',
            'completed': '已完成'
        };
        
        document.getElementById('session-state').textContent = stateText[state] || state;
    }

    // 下载今日报表
    async downloadTodayReport() {
        try {
            this.showLoading(true);
            
            // 先让后端生成/刷新当日汇总 Excel，再触发浏览器下载
            const response = await fetch(`${this.apiBase}/api/generate-today`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                }
            });
            
            const data = await response.json();
            
            if (data.success) {
                // 创建下载链接
                const downloadLink = document.createElement('a');
                const today = formatDate(new Date());
                downloadLink.href = `${this.apiBase}/api/download/${today}`;
                downloadLink.download = `学情汇总_${today}.xlsx`;
                downloadLink.click();   // 触发浏览器下载行为
                
                this.showToast('报表下载已开始', 'success');
            } else {
                this.showToast(data.message || '生成报表失败', 'error');
            }
        } catch (error) {
            this.showToast('下载报表失败', 'error');
            console.error('Download report error:', error);
        } finally {
            this.showLoading(false);
        }
    }

    // 显示历史记录模态框
    async showHistoryModal() {
        const modal = document.getElementById('history-modal');
        modal.classList.add('show');   // 通过 class 控制显隐动画
        
        await this.loadHistoryData();
    }

    // 加载历史数据
    async loadHistoryData(filters = {}, silent = false) {
        const seq = ++this.historySeq;   // 请求序号：响应回来时若已过期则丢弃
        const historyList = document.getElementById('history-list');

        try {
            let url = `${this.apiBase}/api/history`;
            const params = new URLSearchParams();
            
            // 只拼接有值的筛选参数，避免传空串给后端
            if (filters.startDate) params.append('startDate', filters.startDate);
            if (filters.endDate) params.append('endDate', filters.endDate);
            if (filters.class) params.append('class', filters.class);
            if (filters.category) params.append('category', filters.category);
            
            if (params.toString()) {
                url += `?${params.toString()}`;
            }
            
            const response = await fetch(url);
            const data = await response.json();
            if (seq !== this.historySeq) return;   // 已有更新的请求发出，放弃本次结果

            if (data.success) {
                // 数据指纹：silent（后台静默刷新）模式下内容未变则不重绘，避免列表闪烁
                const key = `teacher:${JSON.stringify(data.data.map(item => [item.fileName, item.submittedAt, item.concerns]))}`;
                if (silent && key === this.lastHistoryKey) return;
                this.lastHistoryKey = key;
                this.displayHistoryData(data.data);
            } else if (!silent) {
                this.showToast('加载历史数据失败', 'error');
            }
        } catch (error) {
            if (!silent) {
                this.showToast('加载历史数据失败', 'error');
                console.error('Load history error:', error);
            }
        }
    }

    // 显示历史数据
    displayHistoryData(historyData) {
        const historyList = document.getElementById('history-list');
        historyList.innerHTML = '';   // 先清空再整体重建
        
        if (historyData.length === 0) {
            const category = document.getElementById('history-student-category').value;
            historyList.innerHTML = `<div class="no-data">${category ? '该分类暂无近期记录' : '暂无历史记录'}</div>`;
            return;
        }
        
        historyData.forEach(record => {
            const historyItem = document.createElement('div');
            historyItem.className = 'history-item';
            
            const submittedAt = record.submittedAt || record.date;
            const formattedTime = formatDateTime(submittedAt);
            
            // 拼装条目：标题行 + 摘要信息 + 关注事项 + 操作按钮
            historyItem.innerHTML = `
                <div class="history-item-header">
                    <h4>${record.class ? `${record.class} - ` : ''}${record.subject || '关注记录'}</h4>
                    <span class="history-time">${formattedTime}</span>
                </div>
                <div class="history-item-info">
                    ${record.teacher ? `<span>教师: ${record.teacher}</span>` : ''}
                    ${record.attendance ? `<span>出勤: ${record.attendance}人</span>` : ''}
                    ${record.absent ? `<span>缺勤: ${record.absent}人</span>` : ''}
                    ${record.homeworkCompleted !== undefined && record.homeworkCompleted !== null && record.homeworkCompleted !== '' ? `<span>作业: ${record.homeworkCompleted}人</span>` : ''}
                </div>
                ${record.concerns ? `<div class="history-concerns">${record.concerns}</div>` : ''}
                ${record.matchedStudent ? `<div class="history-match">关联学生：${record.matchedStudent}</div>` : ''}
                <div class="history-item-actions">
                    <button class="btn btn-outline" onclick="app.downloadRecord('${record.fileName}')">
                        下载
                    </button>
                    <button class="btn btn-outline" onclick="app.viewRecord('${record.fileName}')">
                        查看
                    </button>
                </div>
            `;
            
            historyList.appendChild(historyItem);
        });
    }

    // 应用历史记录筛选
    applyHistoryFilters() {
        this.loadHistoryData(this.getHistoryFilters(), false);
    }

    // 获取当前历史筛选条件
    getHistoryFilters() {
        return {
            startDate: document.getElementById('history-start-date').value,
            endDate: document.getElementById('history-end-date').value,
            class: document.getElementById('history-class').value,
            category: document.getElementById('history-student-category').value
        };
    }

    // 加载系统状态（侧边栏运行时间、会话数、今日记录）
    async loadStatsData(silent = false) {
        const seq = ++this.statsSeq;
        try {
            const response = await fetch(`${this.apiBase}/api/stats`);
            const data = await response.json();
            if (seq !== this.statsSeq) return;
            
            if (data.success) {
                // 内容未变化时不重绘，减少无意义 DOM 操作
                const key = `${data.data.uptime}|${data.data.sessions}|${data.data.todayReports}`;
                if (silent && key === this.lastStatsKey) return;
                this.lastStatsKey = key;
                document.getElementById('uptime').textContent = this.formatUptime(data.data.uptime);
                document.getElementById('active-sessions').textContent = data.data.sessions;
                document.getElementById('today-records').textContent = data.data.todayReports;
            } else if (!silent) {
                this.showToast('加载统计数据失败', 'error');
            }
        } catch (error) {
            if (!silent) {
                this.showToast('加载统计数据失败', 'error');
                console.error('Load stats error:', error);
            }
        }
    }

    // 下载记录
    async downloadRecord(fileName) {
        try {
            const response = await fetch(`${this.apiBase}/api/download-record/${fileName}`);
            if (response.ok) {
                // 用 Blob + 临时 <a> 的方式下载，可正确携带文件名
                const blob = await response.blob();
                const url = window.URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = fileName;
                a.click();
                window.URL.revokeObjectURL(url);   // 释放内存中的 Blob URL
                this.showToast('下载成功', 'success');
            } else {
                this.showToast('下载失败', 'error');
            }
        } catch (error) {
            this.showToast('下载失败', 'error');
        }
    }

    // 查看记录详情
    async viewRecord(fileName) {
        try {
            const response = await fetch(`${this.apiBase}/api/record/${fileName}`);
            const data = await response.json();
            
            if (data.success) {
                // 在新窗口中直接展示 JSON 详情（轻量、无需额外页面）
                const newWindow = window.open('', '_blank');
                newWindow.document.write(`
                    <html>
                    <head><title>学情记录详情 - ${fileName}</title></head>
                    <body>
                        <h1>学情记录详情</h1>
                        <pre>${JSON.stringify(data.data, null, 2)}</pre>
                    </body>
                    </html>
                `);
            } else {
                this.showToast('加载记录失败', 'error');
            }
        } catch (error) {
            this.showToast('加载记录失败', 'error');
        }
    }

    // 显示学生情况模态框
    async showStudentModal() {
        const modal = document.getElementById('students-modal');
        modal.classList.add('show');
        await this.loadStudentOverview();
    }

    // 加载学生情况总览
    async loadStudentOverview(silent = false) {
        const seq = ++this.studentSeq;
        try {
            const response = await fetch(`${this.apiBase}/api/students/overview`);
            const data = await response.json();
            if (seq !== this.studentSeq) return;

            if (data.success) {
                // 指纹包含数据来源、更新时间与今日动态，任一变化都需重绘
                const key = `${data.data.sourceFile}|${data.data.updatedAt}|${JSON.stringify(data.data.todayConcerns || {})}`;
                if (silent && key === this.lastStudentKey) return;
                this.lastStudentKey = key;
                this.renderStudentData(data.data);
            } else if (!silent) {
                this.showToast(data.message || '加载学生情况失败', 'error');
            }
        } catch (error) {
            if (!silent) {
                this.showToast('加载学生情况失败', 'error');
            }
        }
    }

    // 刷新学生情况数据
    async refreshStudentData() {
        try {
            // 主动让后端重新解析 xlsx（绕过服务端缓存）
            const response = await fetch(`${this.apiBase}/api/students/refresh`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' }
            });
            const data = await response.json();

            if (data.success) {
                this.renderStudentData(data.data);
                this.showToast('学生情况已刷新', 'success');
            } else {
                this.showToast(data.message || '刷新失败', 'error');
            }
        } catch (error) {
            this.showToast('刷新学生情况失败', 'error');
        }
    }

    // 渲染学生情况分类与汇总表
    renderStudentData(overview) {
        this.studentOverview = overview;
        // 同步更新指纹，避免随后的静默刷新重复渲染同一份数据
        if (overview && overview.updatedAt) {
            this.lastStudentKey = `${overview.sourceFile}|${overview.updatedAt}|${JSON.stringify(overview.todayConcerns || {})}`;
        }

        const tabsContainer = document.getElementById('student-tabs');
        tabsContainer.innerHTML = '';

        // 汇总表排在最前，其余分类按 Excel 工作表顺序排列
        const panels = [];
        if (overview.summary) {
            panels.push({ name: '汇总表', data: overview.summary });
        }
        overview.categories.forEach(category => {
            panels.push({ name: category.name, data: category });
        });

        let activeIndex = 0;
        // 保持用户上次选中的页签（刷新数据后不跳回第一个）
        if (this.currentStudentTabName) {
            const savedIndex = panels.findIndex(panel => panel.name === this.currentStudentTabName);
            if (savedIndex !== -1) {
                activeIndex = savedIndex;
            }
        }

        panels.forEach((panel, index) => {
            const button = document.createElement('button');
            button.className = `tab-btn${index === activeIndex ? ' active' : ''}`;
            button.textContent = panel.name;
            button.addEventListener('click', () => {
                this.currentStudentTabName = panel.name;   // 记录选中项
                tabsContainer.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));
                button.classList.add('active');
                this.currentStudentPanel = panel.data;
                this.renderStudentTable(panel.data);
            });
            tabsContainer.appendChild(button);
        });

        if (panels.length > 0) {
            this.currentStudentPanel = panels[activeIndex].data;
            this.renderStudentTable(panels[activeIndex].data);
        }
    }

    // 渲染单个学生分类表格
    renderStudentTable(panel) {
        const wrap = document.getElementById('student-table-wrap');
        wrap.innerHTML = '';   // 清空旧表格

        // 表头为空说明该工作表没有可解析的数据
        if (!panel || !panel.headers || panel.headers.length === 0) {
            wrap.innerHTML = '<div class="no-data">暂无数据</div>';
            return;
        }

        // 前端本地按关键词过滤（任一单元格包含关键词即命中）
        const query = (this.currentStudentQuery || '').trim().toLowerCase();
        const rows = query
            ? panel.rows.filter(row => row.some(cell => String(cell).toLowerCase().includes(query)))
            : panel.rows;

        const meta = document.getElementById('student-meta');
        meta.textContent = `数据来源：${this.studentOverview.sourceLabel || '最新数据'} | 更新时间：${this.studentOverview.updatedAt}`;
        if (query) {
            meta.textContent += ` | 搜索“${this.currentStudentQuery}”共 ${rows.length} 条`;
        }

        if (rows.length === 0) {
            wrap.innerHTML = '<div class="no-data">没有匹配的学生</div>';
            return;
        }

        const hasToday = this.studentOverview && this.studentOverview.todayConcerns &&
            Object.keys(this.studentOverview.todayConcerns).length > 0;
        wrap.appendChild(this.createStudentHScrollBar());   // 顶部横向滚动条
        wrap.appendChild(this.createStudentTable(panel, rows, {
            hasToday,
            todayConcerns: (this.studentOverview && this.studentOverview.todayConcerns) || {}
        }));
        this.setupStudentHScroll();
    }

    // 构建学生表格
    createStudentTable(panel, rows, options = {}) {
        const table = document.createElement('table');
        table.className = 'student-table';

        // 表头：直接沿用 Excel 的列名
        const thead = document.createElement('thead');
        const headRow = document.createElement('tr');
        panel.headers.forEach(header => {
            const th = document.createElement('th');
            th.textContent = header;
            headRow.appendChild(th);
        });
        // 存在"最近7天动态"时额外追加一列
        if (options.hasToday) {
            const th = document.createElement('th');
            th.textContent = '最近动态';
            headRow.appendChild(th);
        }
        thead.appendChild(headRow);
        table.appendChild(thead);

        const tbody = document.createElement('tbody');
        // 定位姓名/班级列，用于拼接"最近动态"的索引键（与后端 buildTodayConcerns 的键一致）
        const nameIndex = panel.headers.findIndex(header => header.includes('姓名'));
        const classIndex = panel.headers.findIndex(header => header.includes('班级'));
        rows.forEach(row => {
            const tr = document.createElement('tr');
            panel.headers.forEach((_, index) => {
                const td = document.createElement('td');
                td.textContent = row[index] !== undefined ? row[index] : '';
                tr.appendChild(td);
            });
            if (options.hasToday && nameIndex !== -1 && classIndex !== -1) {
                const key = `${row[classIndex]}|${row[nameIndex]}`;
                const td = document.createElement('td');
                td.textContent = (options.todayConcerns && options.todayConcerns[key]) || '';
                tr.appendChild(td);
            }
            tbody.appendChild(tr);
        });
        table.appendChild(tbody);

        return table;
    }

    // 学生情况搜索
    applyStudentSearch(query) {
        this.currentStudentQuery = query;
        if (query.trim() && this.studentOverview) {
            this.renderGlobalSearch();   // 有关键词时跨分类搜索
        } else if (this.currentStudentPanel) {
            this.renderStudentTable(this.currentStudentPanel);   // 清空关键词则回到当前分类
        }
    }

    // 跨全部分类搜索学生
    renderGlobalSearch() {
        const wrap = document.getElementById('student-table-wrap');
        wrap.innerHTML = '';

        const query = (this.currentStudentQuery || '').trim().toLowerCase();
        const panels = [];
        // 全局搜索不包含"汇总表"（它是统计表，没有学生明细）
        this.studentOverview.categories.forEach(category => {
            panels.push({ name: category.name, data: category });
        });

        // 在所有分类中收集命中的行，并记住它来自哪个分类
        const matched = [];
        panels.forEach(panel => {
            panel.data.rows.forEach(row => {
                if (row.some(cell => String(cell).toLowerCase().includes(query))) {
                    matched.push({ category: panel.name, row });
                }
            });
        });

        const meta = document.getElementById('student-meta');
        meta.textContent = `数据来源：${this.studentOverview.sourceLabel || '最新数据'} | 更新时间：${this.studentOverview.updatedAt} | 搜索“${this.currentStudentQuery}”共 ${matched.length} 条`;

        if (matched.length === 0) {
            wrap.innerHTML = '<div class="no-data">没有匹配的学生</div>';
            return;
        }

        const headers = ['分类', '姓名', '班级', '联系电话'];   // 搜索结果统一展示这四列

        const table = document.createElement('table');
        table.className = 'student-table';

        const thead = document.createElement('thead');
        const headRow = document.createElement('tr');
        headers.forEach(header => {
            const th = document.createElement('th');
            th.textContent = header;
            headRow.appendChild(th);
        });
        thead.appendChild(headRow);
        table.appendChild(thead);

        const tbody = document.createElement('tbody');
        matched.forEach(item => {
            const panel = panels.find(p => p.name === item.category);
            // 建立列名 → 下标映射，便于按关键词取列（不同工作表列顺序可能不同）
            const headerMap = {};
            panel.data.headers.forEach((header, index) => {
                headerMap[header] = index;
            });
            const pick = (keyword) => {
                const key = Object.keys(headerMap).find(header => header.includes(keyword));
                return key !== undefined && item.row[headerMap[key]] !== undefined ? item.row[headerMap[key]] : '';
            };

            const tr = document.createElement('tr');
            const categoryTd = document.createElement('td');
            categoryTd.textContent = item.category;
            tr.appendChild(categoryTd);
            ['姓名', '班级', '联系电话'].forEach(keyword => {
                const td = document.createElement('td');
                td.textContent = pick(keyword);
                tr.appendChild(td);
            });
            tbody.appendChild(tr);
        });
        table.appendChild(tbody);
        wrap.appendChild(this.createStudentHScrollBar());
        wrap.appendChild(table);
        this.setupStudentHScroll();
    }

    // 创建表格顶部横向滚动条
    createStudentHScrollBar() {
        const bar = document.createElement('div');
        bar.className = 'student-hscroll hidden';
        return bar;
    }

    // 横向滚动条与表格滚动联动，始终显示在顶部
    // 实现思路：在表格上方放一个等宽的占位容器，双向同步 scrollLeft
    setupStudentHScroll() {
        const wrap = document.getElementById('student-table-wrap');
        const bar = wrap && wrap.querySelector('.student-hscroll');
        if (!wrap || !bar) return;

        // 内容未超出宽度时无需滚动条
        if (wrap.scrollWidth <= wrap.clientWidth + 1) {
            bar.classList.add('hidden');
            return;
        }
        bar.classList.remove('hidden');

        const maxLeft = wrap.scrollWidth - wrap.clientWidth;
        bar.innerHTML = '';
        // 撑出一个与表格等宽的占位块，使滚动条长度与内容宽度一致
        const spacer = document.createElement('div');
        spacer.style.width = `${bar.clientWidth + maxLeft}px`;
        spacer.style.height = '1px';
        bar.appendChild(spacer);

        // 重复调用时先解绑旧监听，避免事件堆积
        if (this._studentHScrollHandlers) {
            wrap.removeEventListener('scroll', this._studentHScrollHandlers.wrap);
            bar.removeEventListener('scroll', this._studentHScrollHandlers.bar);
        }

        // syncing 标志防止两侧互相触发的无限循环
        let syncing = false;
        const wrapHandler = () => {
            if (syncing) return;
            syncing = true;
            bar.scrollLeft = wrap.scrollLeft;
            syncing = false;
        };
        const barHandler = () => {
            if (syncing) return;
            syncing = true;
            wrap.scrollLeft = bar.scrollLeft;
            syncing = false;
        };
        this._studentHScrollHandlers = { wrap: wrapHandler, bar: barHandler };
        wrap.addEventListener('scroll', wrapHandler);
        bar.addEventListener('scroll', barHandler);
    }

    // 导入学生情况xlsx
    async importStudentFile(input) {
        const file = input.files && input.files[0];
        if (!file) return;

        // 前端先做一次扩展名校验，减少无效请求
        if (!/\.xlsx$/i.test(file.name)) {
            this.showToast('请选择xlsx文件', 'warning');
            input.value = '';
            return;
        }

        const reader = new FileReader();
        reader.onload = async () => {
            try {
                // readAsDataURL 结果是 "data:...;base64,xxxx"，取逗号后的部分
                const dataBase64 = String(reader.result).split(',')[1] || '';
                const response = await fetch(`${this.apiBase}/api/students/import`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ fileName: file.name, dataBase64 })
                });
                const result = await response.json();
                if (result.success) {
                    this.renderStudentData(result.data);   // 立即用新数据重绘
                    this.showToast('学生情况导入成功', 'success');
                } else {
                    this.showToast(result.message || '导入失败', 'error');
                }
            } catch (error) {
                this.showToast('导入失败', 'error');
            } finally {
                input.value = '';   // 清空 value，保证同一文件可再次选择
            }
        };
        reader.onerror = () => {
            this.showToast('读取文件失败', 'error');
            input.value = '';
        };
        reader.readAsDataURL(file);
    }

    // 显示AI服务设置模态框
    async showSettingsModal() {
        const modal = document.getElementById('settings-modal');
        modal.classList.add('show');
        await this.loadSettingsStatus();
    }

    // 加载AI服务状态
    async loadSettingsStatus() {
        try {
            const response = await fetch(`${this.apiBase}/api/settings`);
            const data = await response.json();

            if (data.success) {
                const status = document.getElementById('settings-status');
                // 明确告诉教师当前是"AI 对话"还是"本地规则"，避免误解为不可用
                status.textContent = data.data.mode === 'ai'
                    ? `当前模式：AI对话模式（${data.data.model}）`
                    : '当前模式：本地规则模式（未配置API Key，仍可正常填报）';
                document.getElementById('settings-base-url').value = data.data.baseURL || '';
                document.getElementById('settings-model').value = data.data.model || '';
                document.getElementById('settings-api-key').value = '';   // 出于安全考虑不回显已保存的 Key
                this.updateAiModeStatus(data.data.mode);
            }
        } catch (error) {
            this.showToast('加载AI设置失败', 'error');
        }
    }

    // 保存AI服务设置
    async saveSettings() {
        const apiKey = document.getElementById('settings-api-key').value.trim();
        const baseURL = document.getElementById('settings-base-url').value.trim();
        const model = document.getElementById('settings-model').value.trim();

        // Key 是必填项：清空 Key 请使用"清除 API Key"按钮
        if (!apiKey) {
            this.showToast('请输入API Key', 'warning');
            return;
        }

        try {
            const response = await fetch(`${this.apiBase}/api/settings`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ apiKey, baseURL, model })
            });
            const data = await response.json();

            if (data.success) {
                this.showToast('API设置已保存，AI对话模式已启用', 'success');
                this.updateAiModeStatus('ai');    // 侧边栏标识同步更新
                this.loadSettingsStatus();        // 回读一次，保证界面与后端一致
            } else {
                this.showToast(data.message || '保存失败', 'error');
            }
        } catch (error) {
            this.showToast('保存设置失败', 'error');
        }
    }

    // 清除API Key
    async clearApiKey() {
        try {
            // 传空字符串即表示清除（后端约定）
            const response = await fetch(`${this.apiBase}/api/settings`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ apiKey: '' })
            });
            const data = await response.json();

            if (data.success) {
                this.showToast('API Key已清除，当前为本地规则模式', 'success');
                this.updateAiModeStatus('offline');
                this.loadSettingsStatus();
            } else {
                this.showToast(data.message || '清除失败', 'error');
            }
        } catch (error) {
            this.showToast('清除失败', 'error');
        }
    }

    // 更新侧边栏AI服务状态
    async loadAiMode() {
        try {
            const response = await fetch(`${this.apiBase}/api/settings`);
            const data = await response.json();
            if (data.success) {
                this.updateAiModeStatus(data.data.mode);
            }
        } catch (error) {
            document.getElementById('ai-mode').textContent = '未知';
        }
    }

    // 侧边栏 AI 模式文案：ai → 已启用，其余 → 本地规则
    updateAiModeStatus(mode) {
        document.getElementById('ai-mode').textContent = mode === 'ai' ? '已启用' : '本地规则';
    }

    // 关闭模态框
    // 关闭时顺带重置筛选条件/搜索词，保证下次打开是干净状态
    closeModal(modal) {
        if (!modal) return;

        if (modal.id === 'students-modal') {
            const search = document.getElementById('student-search');
            if (search) search.value = '';
            this.currentStudentQuery = '';
            if (this.currentStudentPanel) {
                this.renderStudentTable(this.currentStudentPanel);
            }
        }

        if (modal.id === 'history-modal') {
            // 清空日期与下拉筛选
            ['history-start-date', 'history-end-date'].forEach(id => {
                const input = document.getElementById(id);
                if (input) input.value = '';
            });
            const classSelect = document.getElementById('history-class');
            const categorySelect = document.getElementById('history-student-category');
            if (classSelect) classSelect.value = '';
            if (categorySelect) categorySelect.value = '';
        }

        modal.classList.remove('show');
    }

    // 初始化模态框
    // 动态填充"班级"与"学生分类"下拉框；接口失败时用内置班级兜底
    async initializeModals() {
        const classSelect = document.getElementById('history-class');
        const categorySelect = document.getElementById('history-student-category');
        const fallbackClasses = ['初一(1)班', '初一(2)班', '初一(3)班', '初一(4)班'];

        let classes = fallbackClasses;   // 默认值，接口成功后再覆盖

        try {
            const response = await fetch(`${this.apiBase}/api/meta`);
            const data = await response.json();
            if (data.success) {
                classes = data.data.classes;
            }
        } catch (error) {
            console.warn('加载班级/学科配置失败，使用默认值:', error);
        }

        classes.forEach(cls => {
            const option = document.createElement('option');
            option.value = cls;
            option.textContent = cls;
            classSelect.appendChild(option);
        });

        try {
          const response = await fetch(`${this.apiBase}/api/students/overview`);
            const data = await response.json();
            if (data.success) {
                data.data.categories.forEach(category => {
                    const option = document.createElement('option');
                    option.value = category.name;
                    option.textContent = category.name;
                    categorySelect.appendChild(option);
                });
            }
        } catch (error) {
            console.warn('加载学生分类失败:', error);
        }
    }

    // 加载系统信息
    async loadSystemInfo() {
        await this.loadStatsData();
    }

    // 开始定期更新
    startPeriodicUpdates() {
        // 轮询兜底（30秒一次），实时更新由SSE推送驱动
        setInterval(() => {
            this.refreshOpenViews();
        }, 30000);
    }

    // 刷新当前打开的数据视图
    // 只刷新"当前可见"的视图，关闭的模态框不浪费请求
    refreshOpenViews() {
        this.loadStatsData(true);   // 侧边栏统计始终刷新（静默）
        if (document.getElementById('history-modal').classList.contains('show')) {
            this.loadHistoryData(this.getHistoryFilters(), true);
        }
        if (document.getElementById('students-modal').classList.contains('show')) {
            this.loadStudentOverview(true);
        }
    }

    // 服务端实时推送：数据变更后毫秒级刷新
    connectEvents() {
        try {
            // EventSource 自动重连，无需手写重试逻辑
            const source = new EventSource(`${this.apiBase}/api/events`);
            source.addEventListener('data-changed', (event) => this.onDataChanged(event));
            this.eventSource = source;
        } catch (error) {
            // SSE 不可用时仍可由 30 秒轮询兜底
            console.warn('实时推送连接失败，将使用轮询兜底:', error);
        }
    }

    // 收到变更事件后做 50ms 防抖：短时间内的多次变更只触发一次刷新
    onDataChanged(event) {
        clearTimeout(this.sseRefreshTimer);
        this.sseRefreshTimer = setTimeout(() => {
            this.refreshOpenViews();
        }, 50);
    }

    // 格式化运行时间：按天/小时/分钟/秒逐级降级展示
    formatUptime(milliseconds) {
        const seconds = Math.floor(milliseconds / 1000);
        const minutes = Math.floor(seconds / 60);
        const hours = Math.floor(minutes / 60);
        const days = Math.floor(hours / 24);
        
        if (days > 0) {
            return `${days}天 ${hours % 24}小时`;
        } else if (hours > 0) {
            return `${hours}小时 ${minutes % 60}分钟`;
        } else if (minutes > 0) {
            return `${minutes}分钟 ${seconds % 60}秒`;
        } else {
            return `${seconds}秒`;
        }
    }

    // 显示/隐藏加载状态
    // 显示时禁用发送按钮并展示"正在输入"指示器，避免重复提交
    showLoading(show) {
        const typing = document.getElementById('typing-indicator');
        const sendBtn = document.getElementById('send-btn');
        if (show) {
            if (typing) typing.classList.remove('hidden');
            if (sendBtn) sendBtn.disabled = true;
        } else {
            if (typing) typing.classList.add('hidden');
            if (sendBtn) sendBtn.disabled = false;
        }
    }

    // 显示提示消息
    showToast(message, type = 'info') {
        const toast = document.getElementById('toast');
        const toastContent = toast.querySelector('.toast-content');
        
        toastContent.textContent = message;
        toast.className = `toast ${type}`;   // type 决定配色：info/success/error/warning
        toast.classList.remove('hidden');
        
        // 3秒后自动隐藏
        setTimeout(() => {
            toast.classList.add('hidden');
        }, 3000);
    }
}

// 初始化应用
const app = new AcademicStatusApp();   // 全局唯一实例，供 HTML 内联 onclick 调用（如 app.downloadRecord）

// 原生日期格式化工具（替代外部moment.js依赖）
function pad2(value) {
    return String(value).padStart(2, '0');   // 补零到两位
}

// 日期 → YYYY-MM-DD
function formatDate(date) {
    const d = new Date(date);
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

// 日期时间 → YYYY-MM-DD HH:mm（解析失败时原样返回，避免显示 Invalid Date）
function formatDateTime(value) {
    const d = new Date(value);
    if (isNaN(d.getTime())) return value || '';
    return `${formatDate(d)} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}
