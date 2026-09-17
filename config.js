/**
 * config.js —— 系统全局配置文件
 *
 * 作用：把路径、服务器、AI、业务字典、Excel 模板、CORS、日志等所有可调参数集中到一处，
 *      其他模块通过 require('./config') 读取，避免硬编码散落在各个文件里。
 * 约定：
 *  1) 环境变量优先级高于默认值（PORT / HOST / DEEPSEEK_* 等），便于换机部署；
 *  2) 模块加载时即创建必要的数据目录，保证后续读写文件不因目录缺失而失败。
 */

const path = require('path');          // Node 内置路径模块：跨平台拼接、解析路径
const fs = require('fs-extra');        // fs 增强库：提供 ensureDirSync / readJsonSync 等同步便捷方法

// ==================== 数据目录定义与初始化 ====================

const dataDir = path.join(__dirname, 'data');                      // 数据根目录：<项目>/data
const sessionsDir = path.join(dataDir, 'sessions');                // 会话记录目录：每条填报存成一个 json
const reportsDir = path.join(dataDir, 'reports');                  // Excel 报表输出目录

// 启动即确保目录存在（递归创建，已存在则忽略），避免首次运行时写文件失败
fs.ensureDirSync(sessionsDir);
fs.ensureDirSync(reportsDir);

// ==================== 对外导出的完整配置对象 ====================

module.exports = {
  // ---------- 数据文件与目录路径 ----------
  dataDir,                                                      // 数据根目录
  sessionsDir,                                                  // 会话记录目录
  reportsDir,                                                   // 报表目录
  settingsFile: path.join(dataDir, 'settings.json'),            // AI 设置持久化文件（页面可热更新 API Key，无需重启）
  studentDataFile: path.join(__dirname, '..', '初一学生情况汇总表.xlsx'),                        // 模板学生数据（项目上一级目录的原始模板）
  importedStudentDataFile: path.join(dataDir, 'students', '初一学生情况汇总表.xlsx'),            // 教师手动导入的学生数据（数据源优先级最高）
  archiveStudentDataDir: path.join(dataDir, 'students', 'archive'),                            // 学生数据归档目录（内部按 年-月 分子目录）

  // ---------- 服务器配置 ----------
  server: {
    port: parseInt(process.env.PORT, 10) || 3000,   // 监听端口，默认 3000，可用 PORT 环境变量覆盖
    host: process.env.HOST || '0.0.0.0',            // 监听地址，0.0.0.0 表示同局域网内均可访问
    maxUploadSize: '20mb'                           // 请求体上限，需容纳 Base64 编码后的 xlsx 文件
  },

  // ---------- AI（DeepSeek）配置 ----------
  deepseek: {
    apiKey: process.env.DEEPSEEK_API_KEY || 'your-deepseek-api-key-here',   // API Key，占位符表示尚未配置
    baseURL: process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com',   // 接口地址，兼容 OpenAI SDK 协议
    model: process.env.DEEPSEEK_MODEL || 'deepseek-chat',                   // 使用的模型名称
    timeout: 30000,                                                         // 单次请求超时毫秒数
    maxRetries: 2,                                                          // 失败重试次数（预留配置）
    temperature: 0.2,                                                       // 温度值：偏低更稳定，适合结构化信息抽取
    maxTokens: 1000                                                         // 单次回复最大 token 数
  },

  // 是否启用 AI：运行时动态判断；未配置 Key 时上层会自动回退到本地规则提取，保证开箱即用
  ai: {
    enabled: () => {
      const key = process.env.DEEPSEEK_API_KEY || module.exports.deepseek.apiKey;  // 环境变量优先于配置文件
      return !!key && key !== 'your-deepseek-api-key-here';                        // 非空且非占位符才算启用
    }
  },

  // ---------- 系统运行参数 ----------
  system: {
    name: 'AI学情收集助手',               // 系统名称（前端标题、自介绍话术中使用）
    version: '1.0.0',                    // 版本号
    sessionTimeout: 30 * 60 * 1000,      // 会话超时：30 分钟无活动即视为过期
    maxSessions: 100,                    // 内存中最大会话数（预留配置）
    reportRetentionDays: 90              // 报表保留天数，供过期清理逻辑使用
  },

  // ---------- 对话提示词（Prompt） ----------
  prompts: {
    // 学情抽取阶段的系统提示词：强约束模型只输出 JSON，便于程序解析
    system: `你是一个专业的学情收集助手，专门帮助教师整理学生每日学情信息。

你的任务是：
1. 理解教师用自然语言描述的学情信息
2. 提取关键信息并结构化整理
3. 确保数据的完整性和准确性
4. 提供友好的交互体验

学情信息包含以下维度：
- 出勤情况：到课人数、缺勤人数、缺勤原因
- 课堂表现：整体评价、积极参与的学生、需要改进的地方
- 作业情况：完成人数、未完成人数、未完成原因
- 需要关注的学生和事项

你只能输出用户要求的JSON对象，禁止输出JSON以外的任何文字。`,

    // 会话开始时的欢迎语，同时充当使用说明
    welcome: `您好！我是您的学情小助手，很高兴为您服务！

今天的教学情况如何呢？您可以像聊天一样告诉我：
- 今天哪些学生没来上课？为什么？
- 课堂表现怎么样？哪些学生表现突出？
- 作业完成情况如何？有没有没交作业的学生？
- 有什么需要特别关注的学生情况？

我会把您说的内容整理成规范的报表，您只需要像聊天一样告诉我就可以了！

让我们开始吧：`,

    // 多轮收集过程中的追问模板：{summary} 会被替换成已收集信息摘要
    followUp: `感谢您的信息！我来帮您整理一下：

{summary}

需要我补充其他信息吗？或者这样记录就可以？`,

    // 必填信息齐全后请教师确认的模板：{summary} 会被替换成汇总文本
    confirm: `好的，我来确认一下您提供的信息：

{summary}

请确认这些信息是否准确？确认后我会为您生成Excel报表。`,

    // 报表生成成功后的提示语
    generateReport: `信息确认完毕！我已经为您生成了今日学情报表。

报表已保存，您可以随时下载查看。还需要填报其他班级的信息吗？`,

    // 自由聊天模式的系统提示词：与学情抽取共用同一个对话入口，由意图判断分流
    chatSystem: `你是"AI学情收集助手"，既能帮助教师收集每日学情数据，也能像普通AI一样与用户聊天、回答各种问题。
当用户描述学情信息（班级、学科、出勤、作业等）时，引导其继续提供班级、学科、出勤等信息；
当用户提出普通问题时，用自然、简洁、友好的中文正常回答。
回答时不要提到"我是脚本"或系统内部实现细节。`
  },

  // ---------- 学情数据字段定义 ----------
  fields: {
    required: ['date', 'class', 'subject', 'teacher', 'attendance'],   // 判定"收集完成"的必填字段
    optional: ['absent', 'absentReason', 'performance', 'homeworkCompleted', 'homeworkNotCompleted', 'homeworkReason', 'concerns']  // 选填字段
  },

  // 缺勤人数推算基数：为 0 表示不推算，避免教师未说明缺勤时凭空生成数据
  assumeClassSize: 0,

  // ---------- 业务字典：班级 / 学科 / 教师 ----------
  classes: [
    '初一(1)班', '初一(2)班', '初一(3)班', '初一(4)班',
  ],

  subjects: [
    '语文', '数学', '英语', '物理', '化学', '生物',
    '历史', '地理', '政治', '体育', '音乐', '美术'
  ],

  // 教师名单：用于把"胡芳老师"归一化成"胡芳"，并避免把教师姓名误判为学生
  teachers: [
    '胡芳', '杨秀英', '张秀英', '罗静', '赵建军',
    '周芳', '黄娜', '林洋', '陈伟', '郭杰'
  ],

  // ---------- Excel 模板配置 ----------
  excel: {
    filename: '学情汇总_{date}.xlsx',   // 文件名模板，{date} 会被替换成日期
    columns: [                          // 表头定义：header=显示名称，key=对应数据字段，width=列宽
      { header: '日期', key: 'date', width: 15 },
      { header: '班级', key: 'class', width: 12 },
      { header: '学科', key: 'subject', width: 10 },
      { header: '教师', key: 'teacher', width: 10 },
      { header: '出勤人数', key: 'attendance', width: 10 },
      { header: '缺勤人数', key: 'absent', width: 10 },
      { header: '缺勤原因', key: 'absentReason', width: 20 },
      { header: '课堂表现', key: 'performance', width: 30 },
      { header: '作业完成人数', key: 'homeworkCompleted', width: 12 },
      { header: '未完成人数', key: 'homeworkNotCompleted', width: 12 },
      { header: '未完成原因', key: 'homeworkReason', width: 20 },
      { header: '需关注事项', key: 'concerns', width: 30 },
      { header: '提交时间', key: 'submittedAt', width: 18 }
    ]
  },

  // ---------- 自动化提醒配置（预留） ----------
  automation: {
    enabled: true,            // 是否开启自动提醒
    reminderTime: '17:00',    // 每日提醒时间点
    checkInterval: 60000,     // 检查间隔（毫秒）
    maxUnfilledHours: 2       // 超过该时长仍未填报则触发提醒
  },

  // ---------- 局域网访问配置（CORS 白名单） ----------
  network: {
    // 允许本机以任意端口访问（端口可通过 PORT 环境变量调整）
    allowOrigins: [
      'http://localhost:*',
      'http://127.0.0.1:*'
    ],
    // 允许常见私有网段，覆盖 192.168.x.x / 10.x.x.x / 172.16-31.x.x
    allowedRanges: [
      'http://192.168.*.*:*',
      'http://10.*.*.*:*',
      'http://172.16.*.*:*',
      'http://172.17.*.*:*',
      'http://172.18.*.*:*',
      'http://172.19.*.*:*',
      'http://172.2?:*.*:*',
      'http://172.30.*.*:*',
      'http://172.31.*.*:*'
    ]
  },

  // ---------- 日志配置 ----------
  logging: {
    level: 'info',                                        // 日志级别：error, warn, info, debug
    file: path.join(__dirname, 'logs', 'app.log'),        // 日志文件路径
    maxFiles: 7,                                          // 保留的日志文件个数（预留）
    maxSize: '10m'                                        // 单个日志文件大小上限（预留）
  }
};
