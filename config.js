const path = require('path');
const fs = require('fs-extra');

// 确保数据目录存在
const dataDir = path.join(__dirname, 'data');
const sessionsDir = path.join(dataDir, 'sessions');
const reportsDir = path.join(dataDir, 'reports');

fs.ensureDirSync(sessionsDir);
fs.ensureDirSync(reportsDir);

module.exports = {
  // 数据目录
  dataDir,
  sessionsDir,
  reportsDir,
  settingsFile: path.join(dataDir, 'settings.json'),
  studentDataFile: path.join(__dirname, '..', '初一学生情况汇总表.xlsx'),
  importedStudentDataFile: path.join(dataDir, 'students', '初一学生情况汇总表.xlsx'),
  archiveStudentDataDir: path.join(dataDir, 'students', 'archive'),

  // 服务器配置
  server: {
    port: parseInt(process.env.PORT, 10) || 3000,
    host: process.env.HOST || '0.0.0.0',
    maxUploadSize: '20mb'
  },

  // AI 配置
  deepseek: {
    apiKey: process.env.DEEPSEEK_API_KEY || 'your-deepseek-api-key-here',
    baseURL: process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com',
    model: process.env.DEEPSEEK_MODEL || 'deepseek-chat',
    timeout: 30000,
    maxRetries: 2,
    temperature: 0.2,
    maxTokens: 1000
  },
  // 是否启用 AI（运行时检查；未配置 Key 时自动回退为本地规则提取）
  ai: {
    enabled: () => {
      const key = process.env.DEEPSEEK_API_KEY || module.exports.deepseek.apiKey;
      return !!key && key !== 'your-deepseek-api-key-here';
    }
  },

  // 系统配置
  system: {
    name: 'AI学情收集助手',
    version: '1.0.0',
    sessionTimeout: 30 * 60 * 1000, // 30分钟会话超时
    maxSessions: 100, // 最大会话数
    reportRetentionDays: 90 // 报告保留天数
  },

  // 对话提示词
  prompts: {
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

    welcome: `您好！我是您的学情小助手，很高兴为您服务！

今天的教学情况如何呢？您可以像聊天一样告诉我：
- 今天哪些学生没来上课？为什么？
- 课堂表现怎么样？哪些学生表现突出？
- 作业完成情况如何？有没有没交作业的学生？
- 有什么需要特别关注的学生情况？

我会把您说的内容整理成规范的报表，您只需要像聊天一样告诉我就可以了！

让我们开始吧：`,

    followUp: `感谢您的信息！我来帮您整理一下：

{summary}

需要我补充其他信息吗？或者这样记录就可以？`,

    confirm: `好的，我来确认一下您提供的信息：

{summary}

请确认这些信息是否准确？确认后我会为您生成Excel报表。`,

    generateReport: `信息确认完毕！我已经为您生成了今日学情报表。

报表已保存，您可以随时下载查看。还需要填报其他班级的信息吗？`,
    chatSystem: `你是"AI学情收集助手"，既能帮助教师收集每日学情数据，也能像普通AI一样与用户聊天、回答各种问题。
当用户描述学情信息（班级、学科、出勤、作业等）时，引导其继续提供班级、学科、出勤等信息；
当用户提出普通问题时，用自然、简洁、友好的中文正常回答。
回答时不要提到"我是脚本"或系统内部实现细节。`
  },

  // 数据字段定义
  fields: {
    required: ['date', 'class', 'subject', 'teacher', 'attendance'],
    optional: ['absent', 'absentReason', 'performance', 'homeworkCompleted', 'homeworkNotCompleted', 'homeworkReason', 'concerns']
  },

  // 缺勤人数推算基数；为 0 表示不推算，避免教师未说明缺勤时凭空生成数据
  assumeClassSize: 0,

  // 班级和学科列表
  classes: [
    '初一(1)班', '初一(2)班', '初一(3)班', '初一(4)班',
  ],

  subjects: [
    '语文', '数学', '英语', '物理', '化学', '生物',
    '历史', '地理', '政治', '体育', '音乐', '美术'
  ],

  teachers: [
    '胡芳', '杨秀英', '张秀英', '罗静', '赵建军',
    '周芳', '黄娜', '林洋', '陈伟', '郭杰'
  ],

  // Excel模板配置
  excel: {
    filename: '学情汇总_{date}.xlsx',
    columns: [
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

  // 自动化提醒配置
  automation: {
    enabled: true,
    reminderTime: '17:00', // 提醒时间
    checkInterval: 60000, // 检查间隔（毫秒）
    maxUnfilledHours: 2 // 最大未填报时间（小时）
  },

  // 局域网访问配置
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

  // 日志配置
  logging: {
    level: 'info', // error, warn, info, debug
    file: path.join(__dirname, 'logs', 'app.log'),
    maxFiles: 7,
    maxSize: '10m'
  }
};
