/**
 * utils/settings.js —— AI 服务设置的持久化与"生效配置"计算
 *
 * 作用：让教师可以在网页上直接填 DeepSeek API Key / 模型 / 接口地址，
 *      设置写入 data/settings.json 后可立即生效（热加载），不必重启服务。
 *
 * 优先级（从高到低）：settings.json > 环境变量 > config.js 默认值
 */

const fs = require('fs-extra');   // fs 增强库：同步读写 JSON、创建目录
const path = require('path');     // 路径处理

/**
 * 读取已保存的设置文件。
 * 读取失败（文件不存在、JSON 损坏）时不抛错，返回空对象，保证系统仍能启动。
 * @param {object} config 全局配置对象
 * @returns {object} 设置内容，如 { apiKey, baseURL, model }
 */
function loadSettings(config) {
  try {
    if (fs.existsSync(config.settingsFile)) {
      return fs.readJsonSync(config.settingsFile);   // 文件存在则直接解析返回
    }
  } catch (error) {
    console.warn('读取设置文件失败:', error.message);  // 仅告警，不中断流程
  }
  return {};
}

/**
 * 保存设置（合并写入，未传的字段保持原值）。
 * @param {object} config 全局配置对象
 * @param {object} payload 待保存字段，仅处理 apiKey / baseURL / model
 * @returns {object} 保存后的完整设置对象
 */
function saveSettings(config, { apiKey, baseURL, model }) {
  fs.ensureDirSync(path.dirname(config.settingsFile));   // 确保 data 目录存在
  const current = loadSettings(config);                  // 先读旧值
  const next = { ...current };                           // 基于旧值做增量修改

  // apiKey 特殊处理：传空字符串表示"清除 Key"，传 undefined/null 表示"不修改"
  if (apiKey !== undefined && apiKey !== null) {
    if (apiKey === '') {
      delete next.apiKey;
    } else {
      next.apiKey = String(apiKey).trim();               // 去空格，避免复制粘贴带入空白字符
    }
  }
  if (baseURL) {
    next.baseURL = String(baseURL).trim();
  }
  if (model) {
    next.model = String(model).trim();
  }

  fs.writeJsonSync(config.settingsFile, next, { spaces: 2 });   // 美化格式写回，方便人工查看
  return next;
}

/**
 * 计算"当前真正生效"的 DeepSeek 配置（供所有调用 AI 的地方统一使用）。
 * @param {object} config 全局配置对象
 * @returns {{apiKey:string, baseURL:string, model:string, enabled:boolean}}
 */
function effectiveDeepseek(config) {
  const settings = loadSettings(config);
  // 页面设置的 Key 优先，但排除占位符这种"假配置"
  const storedKey = settings.apiKey && settings.apiKey !== 'your-deepseek-api-key-here'
    ? settings.apiKey
    : '';
  const apiKey = storedKey || process.env.DEEPSEEK_API_KEY || config.deepseek.apiKey;   // 依次降级取值
  const baseURL = settings.baseURL || process.env.DEEPSEEK_BASE_URL || config.deepseek.baseURL;
  const model = settings.model || config.deepseek.model;

  return {
    apiKey,
    baseURL,
    model,
    // enabled 是判断"走 AI 还是走本地规则"的唯一依据
    enabled: !!apiKey && apiKey !== 'your-deepseek-api-key-here'
  };
}

module.exports = { loadSettings, saveSettings, effectiveDeepseek };
