const ExcelJS = require('exceljs');
const fs = require('fs-extra');
const path = require('path');
const moment = require('moment');

let cache = null;
let cacheMtime = 0;
let cacheFile = '';

function resolveStudentFile(config) {
  if (config.importedStudentDataFile && fs.existsSync(config.importedStudentDataFile)) {
    return config.importedStudentDataFile;
  }
  const newestArchive = findNewestArchiveFile(config);
  if (newestArchive) {
    return newestArchive;
  }
  return config.studentDataFile;
}

function findNewestArchiveFile(config) {
  const root = config.archiveStudentDataDir;
  if (!root || !fs.existsSync(root)) return null;

  let newest = null;
  let newestTime = 0;

  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const filePath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(filePath);
      } else if (entry.isFile() && /\.xlsx$/i.test(entry.name) && entry.name.includes('初一学生情况汇总表')) {
        const stat = fs.statSync(filePath);
        if (stat.mtimeMs > newestTime) {
          newest = filePath;
          newestTime = stat.mtimeMs;
        }
      }
    }
  };

  walk(root);
  return newest;
}

function cleanText(value) {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return moment(value).format('YYYY-MM-DD');
  return String(value).trim().replace(/\s+/g, ' ');
}

function parseSheet(worksheet) {
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
    return { headers: [], rows: [] };
  }

  const headerRow = worksheet.getRow(headerRowIndex);
  const headers = [];
  const columnCount = Math.max(worksheet.columnCount, headerRow.cellCount);
  for (let c = 1; c <= columnCount; c++) {
    headers.push(cleanText(headerRow.getCell(c).value));
  }
  while (headers.length > 0 && headers[headers.length - 1] === '') {
    headers.pop();
  }

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

async function readWorkbook(config) {
  const file = resolveStudentFile(config);
  if (!await fs.pathExists(file)) {
    throw new Error(`未找到学生情况数据文件: ${file}`);
  }

  const stat = await fs.stat(file);
  if (cache && cacheMtime === stat.mtimeMs && cacheFile === file) {
    return cache;
  }

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(file);

  const categories = [];
  let summary = null;

  for (const worksheet of workbook.worksheets) {
    const parsed = parseSheet(worksheet);
    if (parsed.rows.length === 0) continue;

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
    sourceLabel: getSourceLabel(config, file),
    updatedAt: moment().format('YYYY-MM-DD HH:mm:ss')
  };

  cache = data;
  cacheMtime = stat.mtimeMs;
  cacheFile = file;
  return data;
}

function getSourceLabel(config, file) {
  if (config.importedStudentDataFile && file === config.importedStudentDataFile) {
    return '手动导入数据';
  }
  if (config.archiveStudentDataDir && file.startsWith(config.archiveStudentDataDir)) {
    return '最新归档数据';
  }
  return '模板数据';
}

async function getOverview(config) {
  return readWorkbook(config);
}

async function refresh(config) {
  cache = null;
  cacheMtime = 0;
  return readWorkbook(config);
}

async function archiveCurrent(config) {
  const active = resolveStudentFile(config);
  if (!await fs.pathExists(active)) {
    throw new Error(`当前学生数据文件不存在: ${active}`);
  }

  const yearMonth = moment().format('YYYY-MM');
  const archiveDir = path.join(config.archiveStudentDataDir, yearMonth);
  await fs.ensureDir(archiveDir);

  const ext = path.extname(active);
  const templateExt = path.extname(config.studentDataFile);
  const base = path.basename(config.studentDataFile, templateExt);
  const dateLabel = moment().format('M月D日');
  const target = path.join(archiveDir, `(${dateLabel})${base}${ext}`);

  await fs.copy(active, target);

  // 归档完成后移除手动导入文件，使数据源自动切换到最新归档数据
  if (config.importedStudentDataFile && active === config.importedStudentDataFile) {
    await fs.remove(config.importedStudentDataFile);
  }

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
