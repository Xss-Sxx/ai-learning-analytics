// AI学情收集系统 - 前端JavaScript
class AcademicStatusApp {
    constructor() {
        this.apiBase = window.location.origin;
        this.currentSessionId = null;
        this.connectionStatus = 'connecting';
        
        this.initializeApp();
    }

    // 初始化应用
    initializeApp() {
        this.studentRefreshTimer = null;
        this.studentOverview = null;
        this.currentStudentPanel = null;
        this.currentStudentQuery = '';
        this.currentStudentTabName = '';
        this.historySeq = 0;
        this.studentSeq = 0;
        this.statsSeq = 0;
        this.lastHistoryKey = null;
        this.lastStudentKey = null;
        this.lastStatsKey = null;
        this.sseRefreshTimer = null;
        this.bindEvents();
        this.checkConnection();
        this.loadSystemInfo();
        this.initializeModals();
        this.loadAiMode();
        this.connectEvents();
        this.startPeriodicUpdates();
    }

    // 绑定事件
    bindEvents() {
        // 发送消息
        document.getElementById('send-btn').addEventListener('click', () => this.sendMessage());
        document.getElementById('user-input').addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
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
                this.createNewSession();
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
        
        statusDot.className = `status-dot ${status}`;
        
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
                this.addMessage('system', data.message, null, 'AI');
                
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
        const message = input.value.trim();
        
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
            this.showLoading(false);
        }
    }

    // 添加消息到聊天界面
    addMessage(type, text, data = null, avatar = '') {
        const messagesContainer = document.getElementById('chat-messages');
        
        const messageDiv = document.createElement('div');
        messageDiv.className = `message ${type}`;
        
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
        messagesContainer.scrollTop = messagesContainer.scrollHeight;
    }

    // 更新会话信息
    updateSessionInfo() {
        document.getElementById('session-id').textContent = this.currentSessionId || '未开始';
    }

    // 更新会话状态
    updateSessionState(state) {
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
                downloadLink.click();
                
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
        modal.classList.add('show');
        
        await this.loadHistoryData();
    }

    // 加载历史数据
    async loadHistoryData(filters = {}, silent = false) {
        const seq = ++this.historySeq;
        const historyList = document.getElementById('history-list');

        try {
            let url = `${this.apiBase}/api/history`;
            const params = new URLSearchParams();
            
            if (filters.startDate) params.append('startDate', filters.startDate);
            if (filters.endDate) params.append('endDate', filters.endDate);
            if (filters.class) params.append('class', filters.class);
            if (filters.category) params.append('category', filters.category);
            
            if (params.toString()) {
                url += `?${params.toString()}`;
            }
            
            const response = await fetch(url);
            const data = await response.json();
            if (seq !== this.historySeq) return;

            if (data.success) {
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
        historyList.innerHTML = '';
        
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
                const blob = await response.blob();
                const url = window.URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = fileName;
                a.click();
                window.URL.revokeObjectURL(url);
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
                // 在新窗口中显示记录详情
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
        if (overview && overview.updatedAt) {
            this.lastStudentKey = `${overview.sourceFile}|${overview.updatedAt}|${JSON.stringify(overview.todayConcerns || {})}`;
        }

        const tabsContainer = document.getElementById('student-tabs');
        tabsContainer.innerHTML = '';

        const panels = [];
        if (overview.summary) {
            panels.push({ name: '汇总表', data: overview.summary });
        }
        overview.categories.forEach(category => {
            panels.push({ name: category.name, data: category });
        });

        let activeIndex = 0;
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
                this.currentStudentTabName = panel.name;
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
        wrap.innerHTML = '';

        if (!panel || !panel.headers || panel.headers.length === 0) {
            wrap.innerHTML = '<div class="no-data">暂无数据</div>';
            return;
        }

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
        wrap.appendChild(this.createStudentHScrollBar());
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

        const thead = document.createElement('thead');
        const headRow = document.createElement('tr');
        panel.headers.forEach(header => {
            const th = document.createElement('th');
            th.textContent = header;
            headRow.appendChild(th);
        });
        if (options.hasToday) {
            const th = document.createElement('th');
            th.textContent = '最近动态';
            headRow.appendChild(th);
        }
        thead.appendChild(headRow);
        table.appendChild(thead);

        const tbody = document.createElement('tbody');
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
            this.renderGlobalSearch();
        } else if (this.currentStudentPanel) {
            this.renderStudentTable(this.currentStudentPanel);
        }
    }

    // 跨全部分类搜索学生
    renderGlobalSearch() {
        const wrap = document.getElementById('student-table-wrap');
        wrap.innerHTML = '';

        const query = (this.currentStudentQuery || '').trim().toLowerCase();
        const panels = [];
        this.studentOverview.categories.forEach(category => {
            panels.push({ name: category.name, data: category });
        });

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

        const headers = ['分类', '姓名', '班级', '联系电话'];

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
    setupStudentHScroll() {
        const wrap = document.getElementById('student-table-wrap');
        const bar = wrap && wrap.querySelector('.student-hscroll');
        if (!wrap || !bar) return;

        if (wrap.scrollWidth <= wrap.clientWidth + 1) {
            bar.classList.add('hidden');
            return;
        }
        bar.classList.remove('hidden');

        const maxLeft = wrap.scrollWidth - wrap.clientWidth;
        bar.innerHTML = '';
        const spacer = document.createElement('div');
        spacer.style.width = `${bar.clientWidth + maxLeft}px`;
        spacer.style.height = '1px';
        bar.appendChild(spacer);

        if (this._studentHScrollHandlers) {
            wrap.removeEventListener('scroll', this._studentHScrollHandlers.wrap);
            bar.removeEventListener('scroll', this._studentHScrollHandlers.bar);
        }

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

        if (!/\.xlsx$/i.test(file.name)) {
            this.showToast('请选择xlsx文件', 'warning');
            input.value = '';
            return;
        }

        const reader = new FileReader();
        reader.onload = async () => {
            try {
                const dataBase64 = String(reader.result).split(',')[1] || '';
                const response = await fetch(`${this.apiBase}/api/students/import`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ fileName: file.name, dataBase64 })
                });
                const result = await response.json();
                if (result.success) {
                    this.renderStudentData(result.data);
                    this.showToast('学生情况导入成功', 'success');
                } else {
                    this.showToast(result.message || '导入失败', 'error');
                }
            } catch (error) {
                this.showToast('导入失败', 'error');
            } finally {
                input.value = '';
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
                status.textContent = data.data.mode === 'ai'
                    ? `当前模式：AI对话模式（${data.data.model}）`
                    : '当前模式：本地规则模式（未配置API Key，仍可正常填报）';
                document.getElementById('settings-base-url').value = data.data.baseURL || '';
                document.getElementById('settings-model').value = data.data.model || '';
                document.getElementById('settings-api-key').value = '';
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
                this.updateAiModeStatus('ai');
                this.loadSettingsStatus();
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

    updateAiModeStatus(mode) {
        document.getElementById('ai-mode').textContent = mode === 'ai' ? '已启用' : '本地规则';
    }

    // 关闭模态框
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
    async initializeModals() {
        const classSelect = document.getElementById('history-class');
        const categorySelect = document.getElementById('history-student-category');
        const fallbackClasses = ['初一(1)班', '初一(2)班', '初一(3)班', '初一(4)班'];

        let classes = fallbackClasses;

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
    refreshOpenViews() {
        this.loadStatsData(true);
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
            const source = new EventSource(`${this.apiBase}/api/events`);
            source.addEventListener('data-changed', (event) => this.onDataChanged(event));
            this.eventSource = source;
        } catch (error) {
            console.warn('实时推送连接失败，将使用轮询兜底:', error);
        }
    }

    onDataChanged(event) {
        clearTimeout(this.sseRefreshTimer);
        this.sseRefreshTimer = setTimeout(() => {
            this.refreshOpenViews();
        }, 50);
    }

    // 格式化运行时间
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
        toast.className = `toast ${type}`;
        toast.classList.remove('hidden');
        
        // 3秒后自动隐藏
        setTimeout(() => {
            toast.classList.add('hidden');
        }, 3000);
    }
}

// 初始化应用
const app = new AcademicStatusApp();

// 原生日期格式化工具（替代外部moment.js依赖）
function pad2(value) {
    return String(value).padStart(2, '0');
}

function formatDate(date) {
    const d = new Date(date);
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function formatDateTime(value) {
    const d = new Date(value);
    if (isNaN(d.getTime())) return value || '';
    return `${formatDate(d)} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}
