const fs = require('fs-extra');
const path = require('path');

function loadSettings(config) {
  try {
    if (fs.existsSync(config.settingsFile)) {
      return fs.readJsonSync(config.settingsFile);
    }
  } catch (error) {
    console.warn('读取设置文件失败:', error.message);
  }
  return {};
}

function saveSettings(config, { apiKey, baseURL, model }) {
  fs.ensureDirSync(path.dirname(config.settingsFile));
  const current = loadSettings(config);
  const next = { ...current };

  if (apiKey !== undefined && apiKey !== null) {
    if (apiKey === '') {
      delete next.apiKey;
    } else {
      next.apiKey = String(apiKey).trim();
    }
  }
  if (baseURL) {
    next.baseURL = String(baseURL).trim();
  }
  if (model) {
    next.model = String(model).trim();
  }

  fs.writeJsonSync(config.settingsFile, next, { spaces: 2 });
  return next;
}

function effectiveDeepseek(config) {
  const settings = loadSettings(config);
  const storedKey = settings.apiKey && settings.apiKey !== 'your-deepseek-api-key-here'
    ? settings.apiKey
    : '';
  const apiKey = storedKey || process.env.DEEPSEEK_API_KEY || config.deepseek.apiKey;
  const baseURL = settings.baseURL || process.env.DEEPSEEK_BASE_URL || config.deepseek.baseURL;
  const model = settings.model || config.deepseek.model;

  return {
    apiKey,
    baseURL,
    model,
    enabled: !!apiKey && apiKey !== 'your-deepseek-api-key-here'
  };
}

module.exports = { loadSettings, saveSettings, effectiveDeepseek };
