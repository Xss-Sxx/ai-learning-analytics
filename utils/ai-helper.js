/**
 * utils/ai-helper.js —— AI 能力封装：学情抽取、自由聊天、趋势分析、教学建议、学生定位
 *
 * 核心设计：
 *  1) 双模式：配置了 API Key 时调用 DeepSeek；未配置或调用失败时自动回退为"本地规则提取"，
 *     保证系统在任何环境下都能完成填报（offline 标记会透传给前端提示用户）。
 *  2) 学情抽取统一返回 { complete, data, followUp, aiResponse, offline }，由 server.js 决定会话流转。
 *  3) 学生姓名一律以《初一学生情况汇总表》真实花名册为准，避免把"常好"这类普通词误识别人名。
 */

const OpenAI = require('openai');
const moment = require('moment');
const { effectiveDeepseek } = require('./settings');
const studentData = require('./student-data');

class AIHelper {
  /**
   * @param {object} config 全局配置对象
   */
  constructor(config) {
    this.config = config;
    // 默认客户端：使用配置文件中的 Key；页面设置生效时会在调用处另行创建客户端
    this.openai = new OpenAI({
      apiKey: config.deepseek.apiKey,
      baseURL: config.deepseek.baseURL,
      timeout: config.deepseek.timeout
    });
  }

  // 获取当前真正生效的 DeepSeek 配置（settings.json > 环境变量 > config.js）
  getEffectiveConfig() {
    return effectiveDeepseek(this.config);
  }

  // 处理学情消息
  async processAcademicMessage(message, currentData = {}) {
    try {
      const eff = this.getEffectiveConfig();

      // 未配置API Key时，使用本地规则提取，保证系统开箱即用
      if (!eff.enabled) {
        console.log('未配置DeepSeek API Key，使用本地规则模式提取学情信息');
        const data = this.cleanAcademicData(this.extractKeywords(message, currentData));
        // 依据真实花名册定位学生；若存在重名则返回追问问题而非直接记录
        const resolved = await this.resolveStudentMentions(message, data);
        if (resolved.ambiguous) {
          return {
            complete: false,
            data,
            followUp: resolved.question,
            aiResponse: null,
            offline: true,
            needsStudentClarification: true
          };
        }
        if (resolved.updated) {
          data.concerns = resolved.data.concerns;   // 采纳识别到的学生关注记录
        }
        return {
          complete: this.checkDataCompleteness(data),
          data,
          followUp: this.generateFollowUp(data),
          aiResponse: null,
          offline: true
        };
      }

      // 构建提示词
      const prompt = this.buildPrompt(message, currentData);
      
      let aiResponse;
      try {
        // 调用Deepseek API
        const client = new OpenAI({
          apiKey: eff.apiKey,
          baseURL: eff.baseURL,
          timeout: this.config.deepseek.timeout
        });
        const response = await client.chat.completions.create({
          model: eff.model,
          messages: [
            {
              role: "system",
              content: this.config.prompts.system   // 系统提示词强约束：只允许输出 JSON
            },
            {
              role: "user",
              content: prompt
            }
          ],
          temperature: this.config.deepseek.temperature,   // 低温度：抽取更稳定、少发散
          max_tokens: this.config.deepseek.maxTokens,
        });

        aiResponse = response.choices[0].message.content;
      } catch (error) {
        // AI服务不可用时自动回退本地规则，保证对话助手始终可用
        console.warn('DeepSeek API调用失败，自动回退本地规则模式:', error.message);
        const fallbackData = this.cleanAcademicData(this.extractKeywords(message, currentData));
        const resolved = await this.resolveStudentMentions(message, fallbackData);
        if (resolved.ambiguous) {
          return {
            complete: false,
            data: fallbackData,
            followUp: resolved.question,
            aiResponse: null,
            offline: true,
            aiError: error.message,
            needsStudentClarification: true
          };
        }
        if (resolved.updated) {
          fallbackData.concerns = resolved.data.concerns;
        }
        return {
          complete: this.checkDataCompleteness(fallbackData),
          data: fallbackData,
          // 明确提示教师：本次结果来自本地规则，而非 AI
          followUp: this.generateFollowUp(fallbackData) + '\n\n（AI服务连接失败，本次已自动使用本地规则提取）',
          aiResponse: null,
          offline: true,
          aiError: error.message
        };
      }

      // 解析AI响应
      const extractedData = this.extractAcademicInfo(aiResponse, currentData, message);
      const aiReply = extractedData.reply || '';   // 取出 AI 生成的自然语言回复
      delete extractedData.reply;                  // reply 不属于数据字段，取出后从数据对象中移除

      // 自动定位学生：无重名直接记录，重名时追问
      const resolved = await this.resolveStudentMentions(message, extractedData);
      if (resolved.ambiguous) {
        return {
          complete: false,
          data: extractedData,
          followUp: resolved.question,
          aiResponse,
          needsStudentClarification: true
        };
      }
      if (resolved.updated) {
        extractedData.concerns = resolved.data.concerns;
      }
      
      // 判断是否收集完成
      const complete = this.checkDataCompleteness(extractedData);
      
      // 生成跟进回复（优先使用AI生成的自然语言回复）
      const followUp = aiReply || this.generateFollowUp(extractedData);
      
      return {
        complete,
        data: extractedData,
        followUp,
        aiResponse
      };

    } catch (error) {
      console.error('AI处理错误:', error);
      throw new Error(`AI处理失败: ${error.message}`);
    }
  }

  // 构建提示词
  buildPrompt(message, currentData) {
    // 逐段拼接抽取提示词：明确要求"只输出 JSON"，并给出字段模板
    let prompt = `请帮我整理以下学情信息：\n\n`;
    prompt += `【重要】请只输出一个JSON对象，不要输出任何JSON以外的文字、解释或标点。\n\n`;
    prompt += `教师说：${message}\n\n`;
    
    // 把已收集到的信息一并交给模型，便于增量补全（多轮对话）
    if (Object.keys(currentData).length > 0) {
      prompt += `已收集的信息：\n`;
      if (currentData.class) prompt += `- 班级：${currentData.class}\n`;
      if (currentData.subject) prompt += `- 学科：${currentData.subject}\n`;
      if (currentData.teacher) prompt += `- 教师：${currentData.teacher}\n`;
      if (currentData.date) prompt += `- 日期：${currentData.date}\n`;
      if (currentData.attendance) prompt += `- 出勤人数：${currentData.attendance}\n`;
      if (currentData.absent) prompt += `- 缺勤人数：${currentData.absent}\n`;
      if (currentData.performance) prompt += `- 课堂表现：${currentData.performance}\n`;
      if (currentData.homeworkCompleted) prompt += `- 作业完成人数：${currentData.homeworkCompleted}\n`;
      if (currentData.concerns) prompt += `- 需关注事项：${currentData.concerns}\n`;
      prompt += `\n`;
    }
    
    prompt += `请从教师的话中提取关键信息，整理成结构化数据。\n`;
    prompt += `如果信息不够完整，把缺失字段写入 "missingInfo" 数组，不要用自然语言提问。\n`;
    prompt += `无论信息是否完整，都请在JSON中返回 "reply" 字段：用自然、友好、简洁的中文给教师一句真实回复。\n`;
    prompt += `信息收集完成后，请在JSON中返回 "complete": true。\n\n`;
    prompt += `请以JSON格式返回数据，格式如下：\n`;
    prompt += `{\n`;
    prompt += `  "class": "班级名称",\n`;
    prompt += `  "subject": "学科名称",\n`;
    prompt += `  "teacher": "教师姓名",\n`;
    prompt += `  "attendance": "到课人数（数字）",\n`;
    prompt += `  "absent": "缺勤人数（数字，可选）",\n`;
    prompt += `  "absentReason": "缺勤原因（可选）",\n`;
    prompt += `  "performance": "课堂表现描述（可选）",\n`;
    prompt += `  "homeworkCompleted": "作业完成人数（数字，可选）",\n`;
    prompt += `  "homeworkNotCompleted": "未完成人数（数字，可选）",\n`;
    prompt += `  "homeworkReason": "未完成原因（可选）",\n`;
    prompt += `  "concerns": "需关注事项（可选）",\n`;
    prompt += `  "missingInfo": ["缺失的信息字段"],\n`;
    prompt += `  "complete": true 或 false,\n`;
    prompt += `  "reply": "给教师的自然语言回复"\n`;
    prompt += `}`;
    
    return prompt;
  }

  // 提取学情信息
  extractAcademicInfo(aiResponse, currentData = {}, originalMessage = '') {
    try {
      // 尝试解析JSON响应
      let parsedData;
      
      // 检查是否包含COLLECT_COMPLETE标志
      if (aiResponse.includes('COLLECT_COMPLETE')) {
        // 响应里混有额外文字时，用正则截取第一个完整 JSON 对象
        const jsonMatch = aiResponse.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          parsedData = JSON.parse(jsonMatch[0]);
        } else {
          throw new Error('无法解析AI响应中的JSON数据');
        }
      } else {
        // 响应本身就是 JSON，直接解析
        parsedData = JSON.parse(aiResponse);
      }
      
      // 合并当前数据和提取的数据（新值覆盖旧值，实现增量更新）
      const mergedData = {
        ...currentData,
        ...parsedData
      };
      
      // 数据清洗和格式化
      const cleanedData = this.cleanAcademicData(mergedData);
      
      return cleanedData;
      
    } catch (error) {
      // JSON 解析失败时降级：基于关键词从原文抽取，保证不丢数据
      console.log('JSON解析失败，使用关键词提取:', error.message);
      return this.extractKeywords(originalMessage || aiResponse, currentData);
    }
  }

  // 基于关键词提取信息
  extractKeywords(message, currentData = {}) {
    const data = { ...currentData };   // 基于已收集数据做增量补充
    
    // 提取班级信息：支持"初一(1)班"与"7年1班"两种写法
    const classMatch = message.match(/初([一二三四五六七八九十\d])\((\d+)\)班|(\d+)年(\d+)班/);
    if (classMatch) {
      const chineseNum = { '一': '1', '二': '2', '三': '3', '四': '4', '五': '5', '六': '6', '七': '7', '八': '8', '九': '9', '十': '10' };
      data.class = classMatch[1] ? `初${classMatch[1]}(${classMatch[2]})班` : `${classMatch[3]}年${classMatch[4]}班`;
    }
    
    // 提取学科信息（命中预设学科词典）
    const subjectMatch = message.match(/(语文|数学|英语|物理|化学|生物|历史|地理|政治|体育|音乐|美术)/);
    if (subjectMatch) {
      data.subject = subjectMatch[0];
    }
    
    // 提取教师姓名（从预设列表中匹配，命中即停）
    for (const teacher of this.config.teachers) {
      if (message.includes(teacher)) {
        data.teacher = teacher;
        break;
      }
    }
    
    // 提取出勤信息：兼容多种口语表达
    const attendanceMatch = message.match(/(\d+)人到课|(\d+)人出席|到课(\d+)人|出勤(\d+)人|到了(\d+)人|应到(\d+)人/);
    if (attendanceMatch) {
      data.attendance = parseInt(attendanceMatch[1] || attendanceMatch[2] || attendanceMatch[3] || attendanceMatch[4] || attendanceMatch[5] || attendanceMatch[6]);
    }
    
    // 提取缺勤信息：兼容"缺勤/没来/请假/迟到"等多种说法
    const absentMatch = message.match(/(\d+)人缺勤|缺勤(\d+)人|(\d+)人没来|请假(\d+)人|没来(\d+)人|迟到(\d+)人/);
    if (absentMatch) {
      data.absent = parseInt(absentMatch[1] || absentMatch[2] || absentMatch[3] || absentMatch[4] || absentMatch[5] || absentMatch[6]);
    }
    
    // 提取缺勤原因（命中多个则用顿号连接）
    const reasons = ['病假', '事假', '迟到', '早退', '旷课', '请假'];
    const foundReasons = [];
    for (const reason of reasons) {
      if (message.includes(reason)) {
        foundReasons.push(reason);
      }
    }
    if (foundReasons.length > 0) {
      data.absentReason = foundReasons.join('、');
    }
    
    // 提取课堂表现：正向/负向关键词二选一，都没有则记为"表现正常"
    const performanceKeywords = {
      positive: ['积极', '活跃', '认真', '专心', '投入', '踊跃', '优秀', '良好'],
      negative: ['沉闷', '不积极', '走神', '不专注', '纪律差']
    };
    
    let performance = '';
    if (performanceKeywords.positive.some(word => message.includes(word))) {
      performance = '表现良好，学生积极参与';
    } else if (performanceKeywords.negative.some(word => message.includes(word))) {
      performance = '表现一般，需要加强管理';
    } else {
      performance = '表现正常';
    }
    
    data.performance = performance;
    
    // 提取作业完成情况（"完成43人""交作业43人"等）
    const homeworkMatch = message.match(/(\d+)人作业|作业(\d+)人|完成(\d+)人|交作业(\d+)人|(\d+)人交作业/);
    if (homeworkMatch) {
      data.homeworkCompleted = parseInt(homeworkMatch[1] || homeworkMatch[2] || homeworkMatch[3] || homeworkMatch[4] || homeworkMatch[5]);
    }
    
    // 提取作业未完成人数
    const incompleteMatch = message.match(/(\d+)人没交|没交(\d+)人|未完成(\d+)人|没交作业(\d+)人/);
    if (incompleteMatch) {
      data.homeworkNotCompleted = parseInt(incompleteMatch[1] || incompleteMatch[2] || incompleteMatch[3] || incompleteMatch[4]);
    }
    
    // 提取未完成原因
    const homeworkReasons = ['忘记带', '不会做', '没时间', '生病', '其他'];
    for (const reason of homeworkReasons) {
      if (message.includes(reason)) {
        data.homeworkReason = reason;
        break;
      }
    }
    
    // 提取需关注事项
    const concerns = [];
    const concernKeywords = ['关注', '注意', '问题', '情况', '状态'];
    
    
    // 具体学生由 resolveStudentMentions 依据真实花名册匹配
    if (['需关注', '需要关注', '需要特别关注', '异常'].some(keyword => message.includes(keyword))) {
      concerns.push('有学生情况需要关注');
    }
    
    if (concerns.length > 0) {
      data.concerns = concerns.join('；');
    }
    
    return data;
  }

  // 清洗学情数据
  cleanAcademicData(data) {
    const cleaned = { ...data };
    
    // 清理字符串字段：去首尾空白 + 压缩连续空白
    for (const key of ['class', 'subject', 'teacher', 'absentReason', 'performance', 'homeworkReason', 'concerns']) {
      if (cleaned[key] && typeof cleaned[key] === 'string') {
        cleaned[key] = cleaned[key].trim().replace(/\s+/g, ' ');
      }
    }

    // 教师字段对齐到内置名单（例如 "胡芳老师" -> "胡芳"）
    if (cleaned.teacher) {
      const matchedTeacher = this.config.teachers.find(teacher => cleaned.teacher.includes(teacher));
      if (matchedTeacher) {
        cleaned.teacher = matchedTeacher;
      }
    }
    
    // 确保数字字段为数字（可解析才转换，否则保留原值）
    const numericFields = ['attendance', 'absent', 'homeworkCompleted', 'homeworkNotCompleted'];
    for (const field of numericFields) {
      if (cleaned[field] !== undefined) {
        const value = parseInt(cleaned[field]);
        if (!isNaN(value)) {
          cleaned[field] = value;
        }
      }
    }
    
    // 如果有出勤人数，计算缺勤人数
    // 注意：assumeClassSize 默认 0，即不推算，避免凭空生成缺勤数据
    const totalStudents = Number(this.config.assumeClassSize) || 0;
    if (totalStudents > 0 && cleaned.attendance && !cleaned.absent) {
      cleaned.absent = Math.max(0, totalStudents - cleaned.attendance);
    }
    
    // 设置默认日期（未提供时按今天）
    if (!cleaned.date) {
      cleaned.date = moment().format('YYYY-MM-DD');
    }
    
    return cleaned;
  }

  // 检查数据完整性
  checkDataCompleteness(data) {
    // 必需字段检查：班级/学科/教师/出勤人数
    const required = ['class', 'subject', 'teacher', 'attendance'];
    const missing = required.filter(field => !data[field]);
    
    // 有缺失字段即未完成，交由上层继续追问
    if (missing.length > 0) {
      return false;
    }
    
    // 模型明确标记 complete 时直接认定完成
    if (data.complete || data.complete === true) {
      return true;
    }
    
    // 无缺失字段即视为完成
    return missing.length === 0;
  }

  // 生成跟进回复：缺信息则追问缺失项，否则回执已记录内容
  generateFollowUp(data) {
    const missing = [];
    
    if (!data.class) missing.push('班级信息');
    if (!data.subject) missing.push('任教学科');
    if (!data.teacher) missing.push('教师姓名');
    if (!data.attendance) missing.push('出勤人数');
    
    if (data.absent && !data.absentReason) {
      missing.push('缺勤原因');
    }
    
    if (data.homeworkNotCompleted && !data.homeworkReason) {
      missing.push('未完成作业原因');
    }
    
    if (missing.length > 0) {
      return `我需要了解以下信息：${missing.join('、')}。请告诉我相关情况。`;
    }
    
    // 根据已有信息生成智能回复
    let reply = '我已经记录了这些信息：\n';
    
    if (data.attendance && data.absent) {
      reply += `✅ 出勤：${data.attendance}人，缺勤${data.absent}人\n`;
    }
    
    if (data.performance) {
      reply += `✅ 课堂表现：${data.performance}\n`;
    }
    
    if (data.homeworkCompleted !== undefined) {
      reply += `✅ 作业完成：${data.homeworkCompleted}人`;
      if (data.homeworkNotCompleted) {
        reply += `，未完成${data.homeworkNotCompleted}人`;
      }
      reply += '\n';
    }
    
    if (data.concerns) {
      reply += `⚠️ 需关注：${data.concerns}\n`;
    }
    
    reply += '\n这样记录可以吗？或者还有什么需要补充的？';
    
    return reply;
  }

  // 分析学情趋势（调用 AI 对历史数据做趋势解读；未配置 Key 时直接返回失败）
  async analyzeTrend(historicalData) {
    try {
      const eff = this.getEffectiveConfig();
      if (!eff.enabled) {
        return {
          success: false,
          offline: true,
          error: '未配置DeepSeek API Key，无法进行AI趋势分析'
        };
      }

      // 构建趋势分析提示词：把历史数据整体塞入，并规定分析维度
      const prompt = `
请分析以下学情历史数据，生成趋势分析报告：

${JSON.stringify(historicalData, null, 2)}

请从以下维度进行分析：
1. 出勤率变化趋势
2. 作业完成率变化趋势
3. 课堂表现变化趋势
4. 需关注学生情况变化
5. 整体学情评价

请以结构化的JSON格式返回分析结果。
`;

      const client = new OpenAI({
        apiKey: eff.apiKey,
        baseURL: eff.baseURL,
        timeout: this.config.deepseek.timeout
      });
      const response = await client.chat.completions.create({
        model: eff.model,
        messages: [
          {
            role: "system",
            content: "你是一个教育数据分析专家，专门分析学情数据的变化趋势。"
          },
          {
            role: "user",
            content: prompt
          }
        ],
        temperature: 0.3,
        max_tokens: 1000,
      });

      const analysis = JSON.parse(response.choices[0].message.content);
      
      return {
        success: true,
        data: analysis
      };
      
    } catch (error) {
      console.error('趋势分析错误:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  // 生成个性化教学建议（基于单条/当日学情数据）
  async generateSuggestions(academicData) {
    try {
      const eff = this.getEffectiveConfig();
      if (!eff.enabled) {
        return {
          success: false,
          offline: true,
          error: '未配置DeepSeek API Key，无法生成AI建议'
        };
      }

      // 规定建议的四个角度，保证输出结构稳定
      const prompt = `
基于以下学情数据，生成教学改进建议：

${JSON.stringify(academicData, null, 2)}

请从以下角度提供建议：
1. 针对缺勤学生的帮扶建议
2. 针对作业完成情况的改进建议
3. 针对课堂表现的提升建议
4. 针对需关注学生的特别建议

请以结构化的JSON格式返回建议内容。
`;

      const client = new OpenAI({
        apiKey: eff.apiKey,
        baseURL: eff.baseURL,
        timeout: this.config.deepseek.timeout
      });
      const response = await client.chat.completions.create({
        model: eff.model,
        messages: [
          {
            role: "system",
            content: "你是一个教学专家，专门根据学情数据提供教学改进建议。"
          },
          {
            role: "user",
            content: prompt
          }
        ],
        temperature: 0.3,
        max_tokens: 1000,
      });

      const suggestions = JSON.parse(response.choices[0].message.content);
      
      return {
        success: true,
        data: suggestions
      };
      
    } catch (error) {
      console.error('生成建议错误:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  // 构建学生名单（来自《初一学生情况汇总表》各分类工作表）
  async buildStudentRoster() {
    try {
      const overview = await studentData.getOverview(this.config);
      const roster = [];
      for (const category of overview.categories) {
        // 定位"姓名/班级"列，逐行抽取成扁平名单
        const nameIndex = category.headers.findIndex(header => header.includes('姓名'));
        const classIndex = category.headers.findIndex(header => header.includes('班级'));
        if (nameIndex === -1) continue;
        for (const row of category.rows) {
          const name = row[nameIndex];
          if (!name) continue;
          roster.push({
            name: String(name).trim(),
            className: classIndex !== -1 ? String(row[classIndex] || '').trim() : '',
            category: category.name   // 记录来源分类（留守儿童/特殊生等）
          });
        }
      }
      return roster;
    } catch (error) {
      // 名单不可用时返回空数组，后续逻辑自动跳过学生定位
      console.warn('加载学生名单失败:', error.message);
      return [];
    }
  }

  // 从消息中提取学生名单中出现的姓名
  extractStudentNames(message, roster) {
    // 按姓名长度倒序，优先匹配长名，避免"张三"命中"张三丰"的子串
    const names = [...new Set(roster.map(item => item.name))].sort((a, b) => b.length - a.length);
    return names.filter(name => name && message.includes(name));
  }

  // 自动定位学生：无重名直接记录，重名时追问
  async resolveStudentMentions(message, data) {
    const roster = await this.buildStudentRoster();
    const names = this.extractStudentNames(message, roster);
    if (names.length === 0) {
      return { updated: false };   // 消息中没有出现任何在册学生
    }

    // 优先使用已抽取到的班级；没有则尝试从消息里解析班级
    let classFromMessage = data.class || '';
    if (!classFromMessage) {
      const classMatch = message.match(/初([一二三四五六七八九十\d])\((\d+)\)班|(\d+)年(\d+)班/);
      if (classMatch) {
        classFromMessage = classMatch[1]
          ? `初${classMatch[1]}(${classMatch[2]})班`
          : `${classMatch[3]}年${classMatch[4]}班`;
      }
    }

    for (const name of names) {
      let candidates = roster.filter(item => item.name === name);
      // 消息中带了班级时，优先在同学班里找人，避免跨班同名误判
      if (classFromMessage) {
        const classCandidates = candidates.filter(item => item.className === classFromMessage);
        if (classCandidates.length > 0) {
          candidates = classCandidates;
        }
      }

      // 姓名后紧跟"老师/教师"或以"老师/教师"开头时，判定为教师本人而非学生
      const teacherMark = new RegExp('^' + name + '(老师|教师)|(老师|教师)' + name);
      if (this.config.teachers.includes(name) && teacherMark.test(message)) {
        continue;
      }

      // 姓名同时存在于教师名单时，仅在明确指向学生事件时才记录，避免把老师当成学生
      if (this.config.teachers.includes(name) &&
          !/学生|同学/.test(message) &&
          !/情绪|心情|低落|哭泣|生病|发烧|请假|缺勤|迟到|旷课|未交|没交|未到|返校|走神|进步|好转|异常|冲突|打架|抽烟|作业/.test(message)) {
        continue;
      }

      // 同名学生在多个班级出现，且消息未指明班级 → 需要教师澄清
      const distinctClasses = [...new Set(candidates.map(item => item.className).filter(Boolean))];
      if (distinctClasses.length > 1) {
        return {
          ambiguous: true,
          name,
          question: `您说的是哪位${name}？${distinctClasses.map(cls => `${cls}的${name}`).join('、')}，请补充班级信息。`
        };
      }

      if (candidates.length > 0) {
        const target = candidates[0];
        // 消息未提班级时，用花名册中的班级补全
        if (!data.class) {
          data.class = target.className;
        }
        const existingConcerns = data.concerns || '';
        // 同一学生同一班级已记录过则不重复追加
        if (existingConcerns.includes(`${name}（${target.className}）`)) {
          return { updated: false };
        }

        // 取姓名之后的一小段文字作为"事项描述"，上限 40 字且不含句子结束符
        const index = message.indexOf(name);
        const afterMatch = index >= 0
          ? message.slice(index + name.length).match(/^[^。；!！？?\n]{1,40}/)
          : null;
        const suffix = afterMatch ? afterMatch[0].trim() : '';
        // 统一记录为 "姓名（班级）事项" 结构，便于后续解析与展示
        const concern = suffix
          ? `${name}（${target.className}）${suffix}`
          : `${name}（${target.className}）需关注`;

        data.concerns = existingConcerns ? `${existingConcerns}；${concern}` : concern;
        return { updated: true, data };
      }
    }

    return { updated: false };
  }

  // 自由聊天问答（非学情录入场景）
  async chat(message, history = []) {
    try {
      const eff = this.getEffectiveConfig();
      // 未配置 Key 时明确告知用户，而不是静默失败
      if (!eff.enabled) {
        return {
          reply: '当前未配置DeepSeek API Key，无法进行自由聊天。您可以继续填报今日学情，或在「API设置」中填入API Key后使用AI对话。',
          offline: true
        };
      }

      const client = new OpenAI({
        apiKey: eff.apiKey,
        baseURL: eff.baseURL,
        timeout: this.config.deepseek.timeout
      });
      // 组装对话上下文：系统提示词 + 最近几轮历史 + 本轮问题
      const messages = [
        {
          role: "system",
          content: this.config.prompts.chatSystem
        }
      ];

      // 只带上有效的历史消息，避免脏数据导致接口报错
      history.forEach(item => {
        if (item && item.role && item.content) {
          messages.push({ role: item.role, content: String(item.content) });
        }
      });
      messages.push({ role: "user", content: String(message) });

      const response = await client.chat.completions.create({
        model: eff.model,
        messages,
        temperature: 0.7,    // 聊天场景温度更高，回答更自然
        max_tokens: 800,
      });

      return {
        reply: response.choices[0].message.content || '',
        offline: false
      };

    } catch (error) {
      // 聊天失败不影响填报主流程，返回友好提示
      console.warn('自由聊天失败，返回提示:', error.message);
      return {
        reply: 'AI服务暂时不可用，请稍后再试。您也可以继续填报今日学情。',
        offline: true
      };
    }
  }
}

module.exports = AIHelper;
