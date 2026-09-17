/**
 * server.js —— AI 学情收集系统后端服务入口
 *
 * 主要职责：
 *  1) 提供 REST API：会话建立/对话消息/学情历史/报表下载/学生情况/统计与设置等；
 *  2) 承载会话状态机（welcome → collecting → confirming → completed），驱动多轮对话填报；
 *  3) 通过 SSE（/api/events）向所有打开的页面实时推送"数据已变更"事件；
 *  4) 每天 0 点自动归档学生数据，并监听信号做优雅关闭。
 *
 * 技术栈：Express + CORS + 文件系统存储（每条学情一个 JSON 文件）+ ExcelJS 生成报表。
 */

const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs-extra');
const moment = require('moment');
const { v4: uuidv4 } = require('uuid');

// 导入工具模块
const AIHelper = require('./utils/ai-helper');
const ExcelGenerator = require('./utils/excel-generator');
const DataProcessor = require('./utils/data-processor');
const settings = require('./utils/settings');
const studentData = require('./utils/student-data');

// 加载配置
const config = require('./config');

// 实例化工具模块
const aiHelper = new AIHelper(config);
const excelGenerator = new ExcelGenerator(config);
const dataProcessor = new DataProcessor(config);
dataProcessor.ensureDirectories();   // 建好 sessions / reports 目录

// 创建Express应用
const app = express();

// 中间件配置
// 把配置里的通配符白名单编译成正则：先转义正则特殊字符，再把 * 换成 .*
const allowedOriginPatterns = config.network.allowOrigins
  .concat(config.network.allowedRanges)
  .map(pattern => new RegExp('^' + pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$'));

app.use(cors({
  origin: function (origin, callback) {
    // 允许没有 origin 的请求（如移动端 App、Postman、服务端调用）
    if (!origin) return callback(null, true);

    // 命中配置白名单则放行
    if (allowedOriginPatterns.some(regex => regex.test(origin))) {
      return callback(null, true);
    }

    // 兜底：允许本机与私有网段，避免更换端口或路由器网段后接口全部被拦
    try {
      const hostname = new URL(origin).hostname;
      const isLocal = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
      const isPrivate = /^10\./.test(hostname) ||
        /^192\.168\./.test(hostname) ||
        /^172\.(1[6-9]|2\d|3[01])\./.test(hostname);
      if (isLocal || isPrivate) {
        return callback(null, true);
      }
    } catch (error) {
      // 非标准 Origin，按拒绝处理
    }

    console.log('Blocked CORS for origin:', origin);
    return callback(new Error('Not allowed by CORS'));
  },
  credentials: true
}));

app.use(express.json({ limit: config.server.maxUploadSize }));                                   // 解析 JSON 请求体（含 Base64 文件）
app.use(express.urlencoded({ extended: true, limit: config.server.maxUploadSize }));             // 解析表单请求体
app.use(express.static(path.join(__dirname, 'public')));                                         // 托管前端静态资源

// 全局变量
const sessions = new Map();          // 内存会话表：sessionId → 会话对象（服务重启即清空）
const systemStartTime = Date.now();  // 进程启动时间，用于计算运行时长
const sseClients = new Set();        // 已连接的 SSE 客户端集合

// 向所有已连接页面推送数据变更事件
function notifyDataChanged(types) {
  const payload = JSON.stringify({ types, timestamp: Date.now() });
  for (const client of sseClients) {
    try {
      client.res.write(`event: data-changed\ndata: ${payload}\n\n`);
    } catch (error) {
      sseClients.delete(client);   // 推送失败说明连接已断开，直接清理
    }
  }
}

// 实时数据推送接口（Server-Sent Events）
app.get('/api/events', (req, res) => {
  // SSE 需要保持长连接，因此单独设置响应头
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive'
  });
  res.write('retry: 3000\n\n');   // 断线后浏览器 3 秒重连

  const client = { id: uuidv4(), res };
  sseClients.add(client);

  // 心跳：25 秒发一次注释包，防止中间代理/浏览器判定连接空闲而断开
  const heartbeat = setInterval(() => {
    try {
      res.write(': ping\n\n');
    } catch (error) {
      clearInterval(heartbeat);
      sseClients.delete(client);
    }
  }, 25000);

  // 客户端断开时清理心跳与集合，避免内存泄漏
  req.on('close', () => {
    clearInterval(heartbeat);
    sseClients.delete(client);
  });
});

// 监听学生数据文件变化（外部修改也能实时推送）
function watchStudentDataFiles() {
  // 只监听模板文件与手动导入文件；归档目录由归档流程自己触发推送
  const targets = [config.studentDataFile, config.importedStudentDataFile];
  for (const file of targets) {
    if (!fs.existsSync(file)) continue;
    try {
      fs.watch(file, { persistent: false }, () => {
        // 延迟 200ms 再推送：等文件写入完成，避免读到半个文件
        setTimeout(() => notifyDataChanged(['students', 'stats']), 200);
      });
    } catch (error) {
      log('warn', '学生数据文件监听失败', { file, error: error.message });
    }
  }
}
watchStudentDataFiles();


// 日志工具函数
// 统一日志入口：同时输出到控制台与 logs/app.log（每行一个 JSON 对象，便于后续检索）
function log(level, message, data = null) {
  const timestamp = moment().format('YYYY-MM-DD HH:mm:ss');
  const logEntry = {
    timestamp,
    level,
    message,
    data: data ? JSON.stringify(data, null, 2) : null
  };
  
  console.log(`[${level.toUpperCase()}] ${timestamp} - ${message}`);
  if (data) {
    console.log(JSON.stringify(data, null, 2));
  }
  
  // 写入日志文件
  const logDir = path.dirname(config.logging.file);
  fs.ensureDirSync(logDir);
  
  fs.appendFileSync(config.logging.file, 
    JSON.stringify(logEntry) + '\n'
  );
}

// 会话管理
// 创建一个新会话：id 用 uuid，state 表示状态机所处阶段
function createSession(userId = null) {
  const sessionId = uuidv4();
  const session = {
    id: sessionId,
    userId: userId,
    createdAt: Date.now(),
    lastActivity: Date.now(),
    messages: [],          // 对话历史（用户与助手交替）
    currentData: {},       // 本次填报累积的学情数据
    state: 'welcome',      // 状态机：welcome, collecting, confirming, completed
    status: 'active'       // active / expired
  };
  
  sessions.set(sessionId, session);
  log('info', 'New session created', { sessionId, userId });
  
  return session;
}

// 读取会话并做超时校验；已超时返回 null（上层会据此重建会话）
function getSession(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) return null;

  // 检查会话是否超时
  if (Date.now() - session.lastActivity > config.system.sessionTimeout) {
    session.status = 'expired';
    log('warn', 'Session expired', { sessionId });
    return null;
  }

  // 更新最后活动时间
  session.lastActivity = Date.now();
  
  return session;
}

// 清理内存中已过期的会话，防止长期运行导致内存增长
function cleanupExpiredSessions() {
  const now = Date.now();
  let cleanedCount = 0;
  
  for (const [sessionId, session] of sessions) {
    if (now - session.lastActivity > config.system.sessionTimeout) {
      sessions.delete(sessionId);
      cleanedCount++;
    }
  }
  
  if (cleanedCount > 0) {
    log('info', `Cleaned up ${cleanedCount} expired sessions`);
  }
}

// 定时清理过期会话
setInterval(cleanupExpiredSessions, 5 * 60 * 1000); // 每5分钟清理一次

// API路由

// 健康检查
app.get('/api/health', (req, res) => {
  res.json({
    status: 'healthy',
    uptime: Date.now() - systemStartTime,                              // 运行时长（毫秒）
    sessions: sessions.size,                                           // 当前内存会话数
    aiEnabled: settings.effectiveDeepseek(config).enabled,             // 是否已启用 AI
    timestamp: moment().format()
  });
});

// 获取基础配置（班级、学科、教师列表）
app.get('/api/meta', (req, res) => {
  res.json({
    success: true,
    data: {
      // 前端下拉选项与提示语所需的基础字典
      classes: config.classes,
      subjects: config.subjects,
      teachers: config.teachers,
      aiEnabled: settings.effectiveDeepseek(config).enabled,
      systemName: config.system.name,
      version: config.system.version
    }
  });
});

// 获取AI服务设置状态
app.get('/api/settings', (req, res) => {
  const eff = settings.effectiveDeepseek(config);
  res.json({
    success: true,
    data: {
      aiEnabled: eff.enabled,                                                 // 是否可用 AI
      hasKey: !!eff.apiKey && eff.apiKey !== 'your-deepseek-api-key-here',    // 是否已配置过 Key
      model: eff.model,
      baseURL: eff.baseURL,
      mode: eff.enabled ? 'ai' : 'offline'                                    // 前端据此显示"AI / 本地规则"模式
    }
  });
});

// 保存AI服务设置（API Key热加载，无需重启）
app.post('/api/settings', async (req, res) => {
  try {
    const { apiKey, model, baseURL } = req.body || {};
    // 只做类型校验：Key 允许为空字符串（表示清除）
    if (apiKey !== undefined && typeof apiKey !== 'string') {
      return res.status(400).json({ success: false, message: 'API Key格式不正确' });
    }

    await settings.saveSettings(config, { apiKey, model, baseURL });
    const eff = settings.effectiveDeepseek(config);   // 立即重新计算生效配置
    log('info', 'AI settings updated', { mode: eff.enabled ? 'ai' : 'offline' });
    res.json({
      success: true,
      data: {
        aiEnabled: eff.enabled,
        hasKey: eff.enabled,
        model: eff.model,
        baseURL: eff.baseURL,
        mode: eff.enabled ? 'ai' : 'offline'
      }
    });
  } catch (error) {
    log('error', 'Failed to save settings', { error: error.message });
    res.status(500).json({ success: false, message: '保存设置失败', error: error.message });
  }
});

// 获取学生情况总览（留守儿童、特殊生、问题学生、逃学厌学、汇总表）
app.get('/api/students/overview', async (req, res) => {
  try {
    const data = await studentData.getOverview(config);
    data.todayConcerns = await buildTodayConcerns();      // 附带最近 7 天的学生动态索引
    data.todayDate = moment().format('YYYY-MM-DD');       // 供前端标注"今日"
    res.json({ success: true, data });
  } catch (error) {
    log('error', 'Failed to load student overview', { error: error.message });
    res.status(500).json({ success: false, message: '加载学生情况失败', error: error.message });
  }
});

// 重新读取学生情况数据（实时预览最新）
app.post('/api/students/refresh', async (req, res) => {
  try {
    const data = await studentData.refresh(config);
    log('info', 'Student data refreshed', { updatedAt: data.updatedAt });
    notifyDataChanged(['students', 'stats']);   // 广播给其他打开着的页面
    res.json({ success: true, data });
  } catch (error) {
    log('error', 'Failed to refresh student data', { error: error.message });
    res.status(500).json({ success: false, message: '刷新学生情况失败', error: error.message });
  }
});

// 导入学生情况xlsx（以《初一学生情况汇总表》为模板）
app.post('/api/students/import', async (req, res) => {
  try {
    const { fileName, dataBase64 } = req.body || {};
    if (!dataBase64 || typeof dataBase64 !== 'string') {
      return res.status(400).json({ success: false, message: '请选择要导入的xlsx文件' });
    }

    const buffer = Buffer.from(dataBase64, 'base64');
    // xlsx 本质是 zip，合法文件以 PK(0x50 0x4B) 开头，用它做最基本的格式校验
    if (buffer.length < 4 || buffer[0] !== 0x50 || buffer[1] !== 0x4B) {
      return res.status(400).json({ success: false, message: '文件格式不正确，请导入xlsx文件' });
    }

    const target = config.importedStudentDataFile;
    await fs.ensureDir(path.dirname(target));
    await fs.writeFile(target, buffer);

    // 重新解析并广播变更
    const data = await studentData.refresh(config);
    log('info', 'Student xlsx imported', { fileName, size: buffer.length, updatedAt: data.updatedAt });
    notifyDataChanged(['students', 'stats']);
    res.json({ success: true, data });
  } catch (error) {
    log('error', 'Failed to import student data', { error: error.message });
    res.status(500).json({ success: false, message: '导入失败', error: error.message });
  }
});

// 手动归档当前学生数据
app.post('/api/students/archive', async (req, res) => {
  try {
    const archive = await studentData.archiveCurrent(config);   // 复制到 archive/年-月/ 下
    const data = await studentData.refresh(config);
    log('info', 'Student data archived', archive);
    notifyDataChanged(['students', 'stats']);
    res.json({ success: true, archive, data });
  } catch (error) {
    log('error', 'Failed to archive student data', { error: error.message });
    res.status(500).json({ success: false, message: '归档学生数据失败', error: error.message });
  }
});


// 创建新会话
app.post('/api/session', (req, res) => {
  try {
    const session = createSession();
    res.json({
      success: true,
      sessionId: session.id,
      message: config.prompts.welcome   // 首屏欢迎语即引导语
    });
  } catch (error) {
    log('error', 'Failed to create session', { error: error.message });
    res.status(500).json({
      success: false,
      message: '创建会话失败',
      error: error.message
    });
  }
});

// 发送消息
app.post('/api/message', async (req, res) => {
  try {
    const { sessionId, message } = req.body;
    
    // 参数校验：会话 id 与消息内容缺一不可
    if (!sessionId || !message) {
      return res.status(400).json({
        success: false,
        message: '缺少必要参数'
      });
    }
    
    let session = getSession(sessionId);
    if (!session) {
      // 会话不存在或已过期，创建新会话
      session = createSession();
      log('info', 'Session not found, created new session', { sessionId });
    }
    
    // 记录用户消息
    session.messages.push({
      role: 'user',
      content: message,
      timestamp: Date.now()
    });
    
    // 日志只截取前 100 字，避免超长消息把日志撑爆
    log('info', 'Received message', { 
      sessionId, 
      message: message.substring(0, 100) + '...',
      sessionState: session.state 
    });
    
    // 处理消息
    const response = await processMessage(session, message);
    
    // 记录AI回复
    session.messages.push({
      role: 'assistant',
      content: response.message,
      timestamp: Date.now()
    });
    
    // 更新会话状态
    session.lastActivity = Date.now();
    
    res.json({
      success: true,
      message: response.message,
      data: response.data,
      state: session.state,               // 前端据此判断是否进入确认/完成态
      action: response.action || null,    // confirm / completed / restart / recorded
      sessionId: session.id
    });
    
  } catch (error) {
    log('error', 'Failed to process message', { 
      error: error.message, 
      stack: error.stack 
    });
    
    res.status(500).json({
      success: false,
      message: '处理消息失败',
      error: error.message
    });
  }
});

// 处理消息的核心逻辑
// 会话状态机：根据 session.state 决定本轮如何响应，并在必要时推进状态
async function processMessage(session, message) {
  const aiHelperInstance = aiHelper;

  // 通用对话意图（模型、身份、帮助类问题直接回答）
  const generalReply = handleGeneralIntent(message);
  if (generalReply) {
    return generalReply;
  }

  // 非学情录入内容走自由聊天
  if (!(await shouldUseDataFlow(session, message))) {
    // 只带最近 5 条历史（slice(-6,-1) 排除刚入栈的本轮消息）
    const chatResult = await aiHelperInstance.chat(message, session.messages.slice(-6, -1));
    return {
      message: chatResult.reply,
      data: {},
      chat: true,
      offline: chatResult.offline || false
    };
  }
  
  switch (session.state) {
    case 'welcome':
      // 初始欢迎状态，首条消息直接进入收集流程
      session.state = 'collecting';
      session.currentData.date = moment().format('YYYY-MM-DD');   // 默认按今天记录
      // fall through

    case 'collecting':
      // 收集信息状态
      const result = await aiHelperInstance.processAcademicMessage(message, session.currentData);

      // 明确"记录某学生事件"时，立即保存关注记录并刷新今日报表
      // 判定依据：抽取结果里出现了结构化的"姓名（初一(N)班）"关注项
      const hasResolvedStudent = result.data && /（初一\(\d+\)班）/.test(String(result.data.concerns || ''));
      const shouldAutoSave = (isExplicitRecordCommand(message) || hasResolvedStudent) && !result.complete && !result.needsStudentClarification;
      if (shouldAutoSave && result.data && result.data.concerns) {
        session.currentData = result.data;
        const record = {
          ...result.data,
          date: session.currentData.date || moment().format('YYYY-MM-DD'),
          submittedAt: moment().format()
        };
        await saveAcademicData(record);
        try {
          await excelGenerator.generateTodayReport(record.date);   // 顺手刷新当日报表
        } catch (reportError) {
          log('warn', '今日报表刷新失败', { error: reportError.message });
        }
        notifyDataChanged(['history', 'students', 'stats']);
        log('info', 'Explicit record saved', { record });
        return {
          message: `已记录：${result.data.concerns}。已保存到历史学情记录和今日报表。如需继续填报完整学情，请补充学科、教师、出勤等信息。`,
          data: result.data,
          action: 'recorded'
        };
      }
      
      if (result.complete) {
        // 信息收集完成，进入确认状态
        session.state = 'confirming';
        session.currentData = result.data;
        
        const summary = generateSummary(result.data);   // 生成人类可读回执
        return {
          message: config.prompts.confirm.replace('{summary}', summary),
          data: result.data,
          action: 'confirm'
        };
      } else {
        // 继续收集信息
        session.currentData = result.data;
        
        if (result.followUp) {
          return {
            message: result.followUp,
            data: result.data
          };
        } else {
          return {
            message: '我已经记录了这些信息，还有其他需要补充的吗？',
            data: result.data
          };
        }
      }
      
    case 'confirming':
      // 确认状态
      if (message.includes('确认') || message.includes('可以') || message.includes('对的')) {
        // 确认信息，生成报告
        session.state = 'completed';
        session.currentData.submittedAt = moment().format();
        
        // 保存数据
        await saveAcademicData(session.currentData);
        notifyDataChanged(['history', 'students', 'stats']);
        
        // 生成Excel
        const excelPath = await excelGenerator.generateReport(session.currentData);
        
        log('info', 'Report generated', { 
          sessionId: session.id, 
          data: session.currentData,
          excelPath 
        });
        
        return {
          message: config.prompts.generateReport,
          data: {
            ...session.currentData,
            excelPath: excelPath
          },
          action: 'completed'
        };
      } else {
        // 修改信息
        session.state = 'collecting';
        const result = aiHelperInstance.processAcademicMessage(message, session.currentData);   // 注意：此处未 await
        
        session.currentData = result.data;
        
        if (result.complete) {
          session.state = 'confirming';
          const summary = generateSummary(result.data);
          return {
            message: config.prompts.confirm.replace('{summary}', summary),
            data: result.data,
            action: 'confirm'
          };
        } else {
          return {
            message: '好的，我来更新信息。您还需要补充其他内容吗？',
            data: result.data
          };
        }
      }
      
    case 'completed':
      // 已完成状态
      if (message.includes('继续') || message.includes('其他班级')) {
        // 开始新的填报
        session.state = 'welcome';
        session.currentData = {};
        return {
          message: config.prompts.welcome,
          data: {},
          action: 'restart'
        };
      } else {
        return {
          message: '您已经完成今日学情填报。如需填报其他班级，请告诉我"继续"。',
          data: session.currentData,
          action: 'completed'
        };
      }
      
    default:
      return {
        message: '抱歉，我不太理解您的意思。请重新描述一下今天的学情情况。',
        data: session.currentData
      };
  }
}

// 处理非学情类通用问题
// 拦截"你用的是什么模型/你是谁/怎么用"这类问题，直接用本地文案回答，
// 既省一次 AI 调用，也保证未配置 Key 时这些问题仍能正常回复。返回 null 表示不拦截。
function handleGeneralIntent(message) {
  const eff = settings.effectiveDeepseek(config);
  const modeText = eff.enabled ? `AI对话模式（${eff.model}）` : '本地规则模式';

  if (/模型号|模型|model|gpt|deepseek|你是哪个|什么模型|当前模型/.test(message)) {
    return {
      message: `当前使用的是 ${eff.model} 模型，当前为${modeText}。如需填报今日学情，直接告诉我班级、学科、出勤等信息即可。`,
      data: {}
    };
  }

  if (/你是谁|你叫什么|自我介绍|介绍一下你自己|介绍一下你/.test(message)) {
    return {
      message: `我是${config.system.name} v${config.system.version}，用于帮助教师收集和整理每日学情数据。`,
      data: {}
    };
  }

  if (/帮助|怎么用|如何使用|使用说明|操作说明/.test(message)) {
    return {
      message: '使用方法：像聊天一样告诉我今日学情，例如“初一(1)班语文，胡芳老师，到课45人，缺勤2人，作业完成43人”。我会整理成报表，确认后自动生成Excel。',
      data: {}
    };
  }

  return null;   // 未命中任何通用意图
}

// 判断消息是否应进入学情录入流程
// 需要在"什么都当学情记录"与"什么都当闲聊"之间取平衡：
//  - 确认/完成态必须走学情流程；
//  - 明确表达"想聊天/想提问"的走自由聊天；
//  - 提到在册学生姓名且带有事件描述词的，按学情记录处理。
async function shouldUseDataFlow(session, message) {
  if (session.state === 'confirming') {
    return true;   // 等待教师确认，必须继续走学情流程
  }
  if (session.state === 'completed') {
    // 已完成状态下只有明确要求重新填报才回到学情流程
    return /继续|其他班级|填报|录入|新的一天|重新/.test(message);
  }

  // 用户明确要求自由聊天
  if (/聊天|随便聊聊|问个问题|问答|提问|帮我写|解释一下|讲个笑话|翻译一下|写一首|推荐一下/.test(message)) {
    return false;
  }

  // 消息中包含学生名单中的姓名，且不是普通提问时，按学情录入处理
  const rosterNames = await getStudentRosterNames();
  const mentionsStudent = rosterNames.some(name => message.includes(name));
  if (mentionsStudent) {
    // "XX是谁/为什么/帮我查"这类属于提问而非记录
    if (/是谁|是哪个|怎么|为什么|帮我查|介绍一下/.test(message)) {
      return false;
    }
    // 仅提到姓名但没有任何学情/事件信息时，按自由聊天处理，避免把闲聊存成学情记录
    const eventPattern = /班级|学科|教师|老师|出勤|到课|缺勤|请假|迟到|早退|旷课|作业|课堂|表现|关注|情绪|心情|低落|状态|异常|记录|填报|录入|学情|到校|未交|没交|没来|未到|返校|生病|发烧|哭泣|走神|进步|好转|初[一二三四五六七八九十\d]\(\d+\)班/;
    if (!eventPattern.test(message)) {
      return false;
    }
    return true;
  }

  // 学情相关关键词
  const academicPattern = /班级|学科|教师|老师|出勤|到课|缺勤|请假|迟到|早退|旷课|作业|课堂|表现|关注|情绪|心情|低落|状态|异常|记录|填报|录入|学情|到校|未交|没交|没来|未到|完成|初[一二三四五六七八九十\d]\(\d+\)班|(\d+)\s*人/;
  return academicPattern.test(message);
}

// 学生名单姓名缓存
// 学生数据变动不频繁，首次读取后缓存在内存，避免每次对话都解析 xlsx
let rosterNamesCache = null;
async function getStudentRosterNames() {
  if (rosterNamesCache) {
    return rosterNamesCache;
  }
  const overview = await studentData.getOverview(config);
  const names = new Set();
  for (const category of overview.categories) {
    // 只取各分类工作表里的"姓名"列
    const nameIndex = category.headers.findIndex(header => header.includes('姓名'));
    if (nameIndex === -1) continue;
    for (const row of category.rows) {
      const name = row[nameIndex];
      if (name) names.add(String(name).trim());
    }
  }
  rosterNamesCache = [...names].filter(Boolean);
  return rosterNamesCache;
}

// 是否是明确的"记录某学生事件"指令
// 用于判断"这条消息是否应当立即落盘"，而不是等整个填报流程走完
function isExplicitRecordCommand(message) {
  return /记录|记一下|帮我记|记上|录入|已返校|返校|已到校|请假|没来|未到|生病|发烧|心情|低落|哭泣|情绪|状态|好转|进步|异常|迟到|旷课|未交|没交/.test(message);
}

// 生成摘要
// 把结构化数据拼成一段人类可读的回执，用于"请确认"环节展示
function generateSummary(data) {
  const parts = [];
  
  if (data.attendance) {
    parts.push(`出勤：${data.attendance}人`);
    if (data.absent) {
      parts.push(`缺勤：${data.absent}人`);
      if (data.absentReason) {
        parts.push(`原因：${data.absentReason}`);
      }
    }
  }
  
  if (data.performance) {
    parts.push(`课堂表现：${data.performance}`);
  }
  
  if (data.homeworkCompleted !== undefined) {
    parts.push(`作业完成：${data.homeworkCompleted}人`);
    if (data.homeworkNotCompleted) {
      parts.push(`未完成：${data.homeworkNotCompleted}人`);
      if (data.homeworkReason) {
        parts.push(`原因：${data.homeworkReason}`);
      }
    }
  }
  
  if (data.concerns) {
    parts.push(`需关注：${data.concerns}`);
  }
  
  return parts.join('；');
}

// 保存学情数据
// 落盘为独立 JSON 文件，文件名带时间戳与随机串，避免并发写入冲突
async function saveAcademicData(data) {  try {
    const fileName = `academic_data_${moment().format('YYYY-MM-DD_HH-mm-ss')}_${Math.random().toString(36).substr(2, 9)}.json`;
    const filePath = path.join(config.dataDir, 'sessions', fileName);
    
    await fs.writeJSON(filePath, data, { spaces: 2 });
    
    log('info', 'Academic data saved', { 
      fileName, 
      class: data.class, 
      subject: data.subject 
    });
    
    return true;
  } catch (error) {
    log('error', 'Failed to save academic data', { error: error.message });
    return false;
  }
}

// 汇总最近7天已记录的学生动态（按 班级|姓名 索引，取最新一条）
// 返回 { "初一(1)班|张三": "张三（初一(1)班）情绪低落" } 形式，供学生情况页标注最新动态
async function buildTodayConcerns() {
  const since = moment().subtract(6, 'days').startOf('day');
  const map = {};
  try {
    const files = await fs.readdir(config.sessionsDir);
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      const record = await fs.readJSON(path.join(config.sessionsDir, file));
      const recordTime = moment(record.submittedAt || record.date);
      // 跳过无效时间与 7 天之前的旧记录
      if (!record || !recordTime.isValid() || recordTime.isBefore(since) || !record.concerns) continue;
      // concerns 里可能包含多个学生，逐段解析
      for (const part of String(record.concerns).split('；')) {
        const match = part.match(/^(.+?)（(初一\(\d+\)班)）(.+)$/);
        if (match) {
          const key = `${match[2]}|${match[1]}`;
          const timestamp = recordTime.valueOf();
          // 同一学生只保留时间最近的那条动态
          if (!map[key] || timestamp > map[key].timestamp) {
            map[key] = { text: part, timestamp };
          }
        }
      }
    }
    // 输出时只保留文本，去掉内部用于比较的 timestamp
    for (const key of Object.keys(map)) {
      map[key] = map[key].text;
    }
  } catch (error) {
    log('warn', '构建最近学生动态失败', { error: error.message });
  }
  return map;
}

// 在学情记录中查找属于指定分类的学生
// 用于"按学生分类（留守儿童/特殊生…）筛选历史记录"
function findCategoryMatch(record, category, studentIndex) {
  const concerns = String(record.concerns || '');
  const parts = concerns.split('；');

  // 优先匹配结构化格式：姓名（班级）事项
  for (const part of parts) {
    const match = part.match(/^(.+?)（(初一\(\d+\)班)）(.+)$/);
    if (match) {
      const entries = studentIndex.get(match[1]) || [];
      const hit = entries.find(entry => entry.category === category && (!entry.className || entry.className === match[2]));
      if (hit) {
        return { name: match[1], className: match[2] };
      }
    }
  }

  // 兜底：按姓名匹配，且姓名所属班级与记录班级一致
  for (const [name, entries] of studentIndex.entries()) {
    if (!concerns.includes(name)) continue;
    const hit = entries.find(entry => entry.category === category && (!entry.className || entry.className === record.class));
    if (hit) {
      return { name, className: record.class || hit.className };
    }
  }

  return null;
}

// 获取历史数据
app.get('/api/history', async (req, res) => {
  try {
    // 查询参数：日期区间 + 班级/学科/教师 + 学生分类
    const { startDate, endDate, class: className, subject, teacher, category } = req.query;

    // 需要按学生分类筛选时，先构建"姓名 → 所属分类"索引
    let categoryStudentIndex = null;
    if (category) {
      const overview = await studentData.getOverview(config);
      categoryStudentIndex = new Map();
      for (const item of overview.categories) {
        const nameIndex = item.headers.findIndex(header => header.includes('姓名'));
        const classIndex = item.headers.findIndex(header => header.includes('班级'));
        if (nameIndex === -1) continue;
        for (const row of item.rows) {
          const name = row[nameIndex];
          if (!name) continue;
          const className = classIndex !== -1 ? String(row[classIndex] || '').trim() : '';
          if (!categoryStudentIndex.has(name)) categoryStudentIndex.set(name, []);
          categoryStudentIndex.get(name).push({ category: item.name, className });
        }
      }
    }
    
    const sessionDir = path.join(config.dataDir, 'sessions');
    const files = await fs.readdir(sessionDir);
    
    let historyData = [];
    
    // 逐文件读取并应用筛选条件
    for (const file of files) {
      if (file.endsWith('.json')) {
        const filePath = path.join(sessionDir, file);
        const data = await fs.readJSON(filePath);
        
        const fileDate = moment(data.submittedAt || data.date);
        
        // 层层过滤：日期区间 → 班级 → 学科 → 教师 → 学生分类
        if (!startDate || fileDate.isSameOrAfter(moment(startDate).startOf('day'))) {
          if (!endDate || fileDate.isSameOrBefore(moment(endDate).endOf('day'))) {
            if (!className || data.class === className) {
              if (!subject || data.subject === subject) {
                if (!teacher || data.teacher === teacher) {
                  const categoryMatch = category ? findCategoryMatch(data, category, categoryStudentIndex) : null;
                  if (!category || categoryMatch) {
                    historyData.push({
                      ...data,
                      fileName: file,
                      submittedAt: data.submittedAt || data.date,          // 统一提交时间字段
                      // 按分类筛选时告诉前端命中的是哪个学生
                      matchedStudent: categoryMatch ? `${categoryMatch.name}（${categoryMatch.className}）` : undefined,
                      matchedCategory: categoryMatch ? category : undefined
                    });
                  }
                }
              }
            }
          }
        }
      }
    }
    
    // 按提交时间倒序（最新在前）
    historyData.sort((a, b) => {
      return moment(b.submittedAt).diff(moment(a.submittedAt));
    });

    // 分类筛选只展示近期记录
    if (category) {
      historyData = historyData.slice(0, 50);
    }
    
    res.json({
      success: true,
      data: historyData,
      count: historyData.length
    });
    
  } catch (error) {
    log('error', 'Failed to get history', { error: error.message });
    res.status(500).json({
      success: false,
      message: '获取历史数据失败',
      error: error.message
    });
  }
});

// 下载Excel报告
app.get('/api/download/:date', async (req, res) => {
  try {
    const { date } = req.params;
    // 报表命名规则与 excel.filename 保持一致
    const excelPath = path.join(config.reportsDir, `学情汇总_${date}.xlsx`);
    
    if (await fs.pathExists(excelPath)) {
      res.download(excelPath, `学情汇总_${date}.xlsx`);
    } else {
      res.status(404).json({
        success: false,
        message: '未找到指定日期的报告'
      });
    }
  } catch (error) {
    log('error', 'Failed to download report', { error: error.message });
    res.status(500).json({
      success: false,
      message: '下载报告失败',
      error: error.message
    });
  }
});

// 生成当日Excel报告
app.post('/api/generate-today', async (req, res) => {
  try {
    const today = moment().format('YYYY-MM-DD');
    const excelPath = await excelGenerator.generateTodayReport(today);
    
    res.json({
      success: true,
      message: 'Excel报告生成成功',
      excelPath: excelPath,
      downloadUrl: `/api/download/${today}`   // 前端可直接用这个地址触发下载
    });
  } catch (error) {
    log('error', 'Failed to generate today report', { error: error.message });
    res.status(500).json({
      success: false,
      message: '生成报告失败',
      error: error.message
    });
  }
});

// 获取系统统计信息
app.get('/api/stats', async (req, res) => {
  try {
    const sessionDir = path.join(config.dataDir, 'sessions');
    const files = await fs.readdir(sessionDir);
    
    const today = moment().format('YYYY-MM-DD');
    let todayCount = 0;
    const totalCount = files.filter(f => f.endsWith('.json')).length;   // 历史填报总数
    
    // 获取今天的填报数量
    for (const file of files) {
      if (file.endsWith('.json')) {
        const data = await fs.readJSON(path.join(sessionDir, file));
        if (moment(data.date).format('YYYY-MM-DD') === today) {
          todayCount++;
        }
      }
    }

    // 学生情况分类统计
    let studentStats = { categories: [], updatedAt: null };
    try {
      const overview = await studentData.getOverview(config);
      if (overview.summary) {
        // 汇总表包含"类别 / 人数"两列，直接映射成前端表格数据
        const nameIndex = overview.summary.headers.indexOf('类别');
        const countIndex = overview.summary.headers.indexOf('人数');
        studentStats.categories = overview.summary.rows
          .map(row => ({ name: row[nameIndex], count: row[countIndex] }))
          .filter(item => item.name);
        studentStats.updatedAt = overview.updatedAt;
      }
    } catch (error) {
      studentStats.error = error.message;   // 学生数据异常不影响整体统计接口
    }
    
    res.json({
      success: true,
      data: {
        uptime: Date.now() - systemStartTime,                                   // 运行时长
        sessions: sessions.size,                                               // 当前会话数
        totalReports: totalCount,                                              // 历史填报总数
        todayReports: todayCount,                                              // 今日填报数
        serverMemory: Math.round(process.memoryUsage().heapUsed / 1024 / 1024), // 堆内存占用（MB）
        serverTime: moment().format(),
        aiEnabled: settings.effectiveDeepseek(config).enabled,
        studentStats
      }
    });
  } catch (error) {
    log('error', 'Failed to get stats', { error: error.message });
    res.status(500).json({
      success: false,
      message: '获取统计信息失败',
      error: error.message
    });
  }
});

// 查看单条记录详情
app.get('/api/record/:fileName', async (req, res) => {
  try {
    const { fileName } = req.params;
    // path.basename 剥离任何目录成分，防止 ../ 形式的路径穿越
    const filePath = path.join(config.dataDir, 'sessions', path.basename(fileName));

    if (await fs.pathExists(filePath)) {
      const data = await fs.readJSON(filePath);
      res.json({ success: true, data });
    } else {
      res.status(404).json({ success: false, message: '记录不存在' });
    }
  } catch (error) {
    log('error', 'Failed to load record', { error: error.message });
    res.status(500).json({ success: false, message: '加载记录失败', error: error.message });
  }
});

// 下载单条记录
app.get('/api/download-record/:fileName', async (req, res) => {
  try {
    const { fileName } = req.params;
    const safeName = path.basename(fileName);   // 同样做路径穿越防护
    const filePath = path.join(config.dataDir, 'sessions', safeName);

    if (await fs.pathExists(filePath)) {
      res.download(filePath, safeName);
    } else {
      res.status(404).json({ success: false, message: '记录不存在' });
    }
  } catch (error) {
    log('error', 'Failed to download record', { error: error.message });
    res.status(500).json({ success: false, message: '下载记录失败', error: error.message });
  }
});

// 错误处理中间件
// 必须放在所有路由之后；四个参数是 Express 识别错误中间件的标志
app.use((error, req, res, next) => {
  log('error', 'Unhandled error', { error: error.message, stack: error.stack });
  
  // 响应头已发出时无法再改状态码，交回 Express 默认处理
  if (res.headersSent) {
    return next(error);
  }
  
  res.status(500).json({
    success: false,
    message: '服务器内部错误',
    error: process.env.NODE_ENV === 'development' ? error.message : undefined   // 仅开发环境暴露细节
  });
});

// 404处理
app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: '请求的接口不存在'
  });
});


// 每天0点自动归档学生数据，并切换到最新归档数据
function scheduleStudentDataArchive() {
  const now = new Date();
  const nextMidnight = new Date(now);
  nextMidnight.setHours(24, 0, 0, 0);   // 今天的 24:00 即次日 0 点
  const delay = Math.max(1000, nextMidnight.getTime() - now.getTime());   // 距离下次 0 点的毫秒数

  // 先等待到 0 点执行第一次，之后每 24 小时重复一次
  setTimeout(async () => {
    try {
      const result = await studentData.archiveCurrent(config);
      log('info', 'Student data archived at midnight', result);
    } catch (error) {
      log('error', 'Midnight student data archive failed', { error: error.message });
    }

    setInterval(async () => {
      try {
        const result = await studentData.archiveCurrent(config);
        log('info', 'Student data archived at midnight', result);
      } catch (error) {
        log('error', 'Midnight student data archive failed', { error: error.message });
      }
    }, 24 * 60 * 60 * 1000);
  }, delay);
}

scheduleStudentDataArchive();

// 启动服务器
app.listen(config.server.port, config.server.host, () => {
  log('info', `AI学情收集系统启动成功`, {
    port: config.server.port,
    host: config.server.host,
    time: moment().format('YYYY-MM-DD HH:mm:ss')
  });
  
  // 控制台打印访问地址，方便教师直接点击
  console.log(`
┌─────────────────────────────────────┐
│    🎓 AI学情收集系统已启动           │
├─────────────────────────────────────┤
│  📍 访问地址: http://localhost:${config.server.port}     │
│  🌐 局域网访问: http://服务器IP:${config.server.port}  │
│  📝 系统版本: ${config.system.version}                     │
│  ⚡ 状态: 运行中                      │
└─────────────────────────────────────┘
  `);
});

// 优雅关闭
process.on('SIGINT', async () => {
  log('info', 'Received SIGINT, shutting down gracefully...');
  
  // 保存会话数据
  const sessionsData = Array.from(sessions.entries()).map(([id, session]) => ({
    id,
    userId: session.userId,
    createdAt: session.createdAt,
    lastActivity: session.lastActivity,
    state: session.state,
    status: session.status
  }));
  
  // 落盘一份会话快照（用于排查问题，不含对话内容）
  await fs.writeJSON(path.join(config.dataDir, 'sessions_backup.json'), sessionsData);
  
  log('info', 'Sessions saved, exiting...');
  process.exit(0);
});

module.exports = app;   // 导出 app 便于测试脚本直接引用
