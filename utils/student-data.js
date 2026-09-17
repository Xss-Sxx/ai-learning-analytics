/**
 * utils/student-data.js —— 学生情况 Excel（《初一学生情况汇总表》）的读取与归档
 *
 * 职责：
 *  1. 解析学生数据工作簿：每个工作表视为一个"分类"（留守儿童、特殊生…），"汇总表"单独存放；
 *  2. 数据源优先级：手动导入文件 > 最新归档文件 > 项目模板文件；
 *  3. 带 mtime 缓存，避免每次接口调用都重新解析 xlsx；
 *  4. 提供归档能力（把当前数据复制到 archive/年-月/ 下并切换数据源）。
 */

const ExcelJS = require('exceljs');        // 解析 .xlsx
const fs = require('fs-extra');            // 文件读写与目录操作
const path = require('path');               // 路径处理
const moment = require('moment');           // 日期格式化

// ---------- 内存缓存：减少重复解析 xlsx 的开销 ----------
let cache = null;      // 缓存的工作簿解析结果
let cacheMtime = 0;    // 缓存对应的文件修改时间
let cacheFile = '';    // 缓存对应的文件路径

/**
 * 确定当前应使用的学生数据文件（数据源优先级逻辑）。
 * @param {object} config 全局配置
 * @returns {string} 文件绝对路径
 */
function resolveStudentFile(config) {
  // 1) 教师手动导入的文件优先级最高
  if (config.importedStudentDataFile && fs.existsSync(config.importedStudentDataFile)) {
    return config.importedStudentDataFile;
  }
  // 2) 其次用归档目录里最新的那份（每天 0 点自动归档）
  const newestArchive = findNewestArchiveFile(config);
  if (newestArchive) {
    return newestArchive;
  }
  // 3) 最后回退到项目自带的模板文件
  return config.studentDataFile;
}

/**
 * 递归扫描归档目录，找出最近修改的那个"初一学生情况汇总表"xlsx。
 * @param {object} config 全局配置
 * @returns {string|null} 文件路径，未找到返回 null
 */
function findNewestArchiveFile(config) {
  const root = config.archiveStudentDataDir;
  if (!root || !fs.existsSync(root)) return null;   // 归档目录不存在直接返回

  let newest = null;
  let newestTime = 0;

  // 深度优先遍历目录树
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const filePath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(filePath);                                            // 子目录继续递归
      } else if (entry.isFile() && /\.xlsx$/i.test(entry.name) && entry.name.includes('初一学生情况汇总表')) {
        const stat = fs.statSync(filePath);
        if (stat.mtimeMs > newestTime) {                           // 记录最新修改的文件
          newest = filePath;
          newestTime = stat.mtimeMs;
        }
      }
    }
  };

  walk(root);
  return newest;
}

/**
 * 统一清洗单元格文本：null/undefined → 空串；日期 → YYYY-MM-DD；其余去首尾空白并压缩连续空格。
 * @param {*} value 单元格原始值
 * @returns {string} 清洗后的文本
 */
function cleanText(value) {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return moment(value).format('YYYY-MM-DD');   // Excel 日期类型格式化
  return String(value).trim().replace(/\s+/g, ' ');
}

/**
 * 解析单个工作表：自动定位表头行，返回表头数组与数据行二维数组。
 * 表头行的判定标准：第 1 列文本包含"序号"。
 * @param {import('exceljs').Worksheet} worksheet 工作表对象
 * @returns {{headers:string[], rows:string[][]}}
 */
function parseSheet(worksheet) {
  // 1) 自上而下寻找表头行
  let headerRowIndex = -1;
  worksheet.eachRow((row, rowNumber) => {
    if (headerRowIndex === -1) {
      const first = row.getCell(1).value;
      if (first !== null && first !== undefined && String(first).trim().includes('序号')) {
        headerRowIndex = rowNumber;
      }
    }
  });

  if (headerRowIndex === -1) {
    return { headers: [], rows: [] };   // 没找到表头，视为空表
  }

  // 2) 读取表头（取列数最大值，避免后面的列被漏掉）
  const headerRow = worksheet.getRow(headerRowIndex);
  const headers = [];
  const columnCount = Math.max(worksheet.columnCount, headerRow.cellCount);
  for (let c = 1; c <= columnCount; c++) {
    headers.push(cleanText(headerRow.getCell(c).value));
  }
  // 去掉尾部连续的空表头（Excel 常有多余空列）
  while (headers.length > 0 && headers[headers.length - 1] === '') {
    headers.pop();
  }

  // 3) 读取数据行：整行为空则跳过
  const rows = [];
  for (let r = headerRowIndex + 1; r <= worksheet.rowCount; r++) {
    const row = worksheet.getRow(r);
    const values = [];
    let hasValue = false;
    for (let c = 1; c <= headers.length; c++) {
      const value = cleanText(row.getCell(c).value);
      values.push(value);
      if (value !== '') hasValue = true;
    }
    if (hasValue) rows.push(values);
  }

  return { headers, rows };
}

/**
 * 读取（并缓存）学生数据工作簿。
 * @param {object} config 全局配置
 * @returns {Promise<{categories:Array, summary:object|null, sourceFile:string, sourceLabel:string, updatedAt:string}>}
 */
async function readWorkbook(config) {
  const file = resolveStudentFile(config);
  if (!await fs.pathExists(file)) {
    throw new Error(`未找到学生情况数据文件: ${file}`);
  }

  // 文件未改动且仍是同一文件时，直接命中缓存
  const stat = await fs.stat(file);
  if (cache && cacheMtime === stat.mtimeMs && cacheFile === file) {
    return cache;
  }

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(file);

  const categories = [];   // 除"汇总表"以外的工作表（留守儿童、特殊生等）
  let summary = null;      // "汇总表"工作表

  for (const worksheet of workbook.worksheets) {
    const parsed = parseSheet(worksheet);
    if (parsed.rows.length === 0) continue;          // 跳过空工作表

    if (worksheet.name === '汇总表') {
      summary = { name: worksheet.name, ...parsed };
    } else {
      categories.push({ name: worksheet.name, ...parsed });
    }
  }

  const data = {
    categories,
    summary,
    sourceFile: file,
    sourceLabel: getSourceLabel(config, file),        // 给前端展示数据来源：模板/导入/归档
    updatedAt: moment().format('YYYY-MM-DD HH:mm:ss')
  };

  // 写入缓存
  cache = data;
  cacheMtime = stat.mtimeMs;
  cacheFile = file;
  return data;
}

/**
 * 根据文件路径反推数据来源标签（用于前端提示当前数据来自哪里）。
 * @param {object} config 全局配置
 * @param {string} file 实际使用的文件路径
 * @returns {string} '手动导入数据' | '最新归档数据' | '模板数据'
 */
function getSourceLabel(config, file) {
  if (config.importedStudentDataFile && file === config.importedStudentDataFile) {
    return '手动导入数据';
  }
  if (config.archiveStudentDataDir && file.startsWith(config.archiveStudentDataDir)) {
    return '最新归档数据';
  }
  return '模板数据';
}

/**
 * 获取学生数据总览（对外主入口）。
 * @param {object} config 全局配置
 * @returns {Promise<object>} 见 readWorkbook 返回值
 */
async function getOverview(config) {
  return readWorkbook(config);
}

/**
 * 强制清空缓存并重新读取（用于"导入文件/归档"后立即生效）。
 * @param {object} config 全局配置
 * @returns {Promise<object>} 最新解析结果
 */
async function refresh(config) {
  cache = null;
  cacheMtime = 0;
  return readWorkbook(config);
}

/**
 * 归档当前学生数据：
 * 把当前生效的文件复制到 archive/年-月/(M月D日)原名.ext，
 * 如果是手动导入的文件，归档后删除它，让数据源自动切回"最新归档"。
 * @param {object} config 全局配置
 * @returns {Promise<{file:string, archivedAt:string, sourceFile:string}>}
 */
async function archiveCurrent(config) {
  const active = resolveStudentFile(config);
  if (!await fs.pathExists(active)) {
    throw new Error(`当前学生数据文件不存在: ${active}`);
  }

  const yearMonth = moment().format('YYYY-MM');                              // 归档子目录：2026-09
  const archiveDir = path.join(config.archiveStudentDataDir, yearMonth);
  await fs.ensureDir(archiveDir);

  const ext = path.extname(active);                                          // 保留原扩展名
  const templateExt = path.extname(config.studentDataFile);
  const base = path.basename(config.studentDataFile, templateExt);           // 统一使用模板文件的基名
  const dateLabel = moment().format('M月D日');                                // 归档文件名前缀日期
  const target = path.join(archiveDir, `(${dateLabel})${base}${ext}`);

  await fs.copy(active, target);                                             // 复制而非移动，保证归档过程可回溯

  // 归档完成后移除手动导入文件，使数据源自动切换到最新归档数据
  if (config.importedStudentDataFile && active === config.importedStudentDataFile) {
    await fs.remove(config.importedStudentDataFile);
  }

  // 清空缓存，下一次读取会重新解析
  cache = null;
  cacheMtime = 0;
  cacheFile = '';

  return {
    file: target,
    archivedAt: moment().format('YYYY-MM-DD HH:mm:ss'),
    sourceFile: active
  };
}

module.exports = { getOverview, refresh, parseSheet, archiveCurrent };
