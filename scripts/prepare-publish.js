/* 发布前清理与脱敏：移除开发痕迹、清除 API Key、脱敏学生联系方式
 *
 * 用法：
 *   node scripts/prepare-publish.js           # 预览（不修改任何文件）
 *   node scripts/prepare-publish.js --apply   # 实际执行
 */
const fs = require('fs-extra');
const path = require('path');
const ExcelJS = require('exceljs');

const APPLY = process.argv.includes('--apply');
const PROJECT = path.join(__dirname, '..');
const DEMO = path.join(PROJECT, '..');

const plan = { remove: [], mask: [], secrets: [], skip: [] };
const done = [];

function rel(p) { return path.relative(DEMO, p) || p; }

function drop(p, reason) {
  if (fs.existsSync(p)) plan.remove.push({ target: p, reason });
}

function walkFiles(dir, filter, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkFiles(full, filter, out);
    else if (entry.isFile() && filter(full)) out.push(full);
  }
  return out;
}

// ---------- 1. 需要移除的开发痕迹 ----------
drop(path.join(DEMO, 'session.jsonl'), 'Codex 开发会话记录，含完整需求与调试过程');
drop(path.join(DEMO, '.tmp'), '开发临时目录（补丁脚本与运行日志）');
drop(path.join(PROJECT, 'logs'), '运行日志，含学生姓名与联系方式');
drop(path.join(PROJECT, 'data', 'sessions_backup.json'), '会话备份');

for (const dir of fs.existsSync(path.join(PROJECT, 'data'))
  ? fs.readdirSync(path.join(PROJECT, 'data'))
  : []) {
  if (dir.startsWith('seed-backup-')) {
    drop(path.join(PROJECT, 'data', dir), '演示数据备份目录');
  }
}

// 保留但需人工确认的大文件
for (const item of ['第三组.7z', '第三组']) {
  const p = path.join(DEMO, item);
  if (fs.existsSync(p)) plan.skip.push({ target: p, reason: '微信群聊天截图，发布前请确认是否保留' });
}

// ---------- 2. 需要脱敏的数据文件 ----------
const rosterTargets = [
  path.join(DEMO, '初一学生情况汇总表.xlsx'),
  path.join(DEMO, '初一学生情况汇总表(1).xlsx'),
  path.join(DEMO, '初一学生情况汇总表 测试11111111.xlsx'),
  path.join(DEMO, '学生每日学情汇总表模板.xlsx'),
  path.join(PROJECT, 'data', 'students', '初一学生情况汇总表.xlsx')
].filter(f => fs.existsSync(f));

const archiveRosters = walkFiles(
  path.join(PROJECT, 'data', 'students', 'archive'),
  f => /\.xlsx$/i.test(f)
);

const reportFiles = walkFiles(
  path.join(PROJECT, 'data', 'reports'),
  f => /\.xlsx$/i.test(f)
);

const sessionJson = walkFiles(
  path.join(PROJECT, 'data', 'sessions'),
  f => /\.json$/i.test(f)
);

for (const f of [...rosterTargets, ...archiveRosters, ...reportFiles]) {
  plan.mask.push({ target: f, kind: 'xlsx' });
}
for (const f of sessionJson) {
  plan.mask.push({ target: f, kind: 'json' });
}

// ---------- 3. 需要清除的密钥 ----------
const settingsFile = path.join(PROJECT, 'data', 'settings.json');
if (fs.existsSync(settingsFile)) {
  const content = fs.readJsonSync(settingsFile);
  if (content.apiKey) {
    plan.secrets.push({ target: settingsFile, reason: `发现明文 API Key（${String(content.apiKey).slice(0, 8)}...）` });
  }
}

function clearReadonly(target) {
  if (!fs.existsSync(target)) return;
  const stat = fs.statSync(target);
  if (stat.isDirectory()) {
    for (const entry of fs.readdirSync(target)) clearReadonly(path.join(target, entry));
  } else if (!(stat.mode & 0o200)) {
    try { fs.chmodSync(target, 0o666); } catch (error) { /* 忽略 */ }
  }
}

// ---------- 脱敏实现 ----------
// 处理任意长度 >= 11 的数字串，避免号码嵌在更长数字中时漏脱敏
function maskDigitRuns(text) {
  return String(text).replace(/\d{11,}/g, (run) => {
    if (run.length >= 15) {
      return run.slice(0, 6) + '*'.repeat(run.length - 9) + run.slice(-3);
    }
    return run.slice(0, 3) + '****' + run.slice(-4);
  });
}

function maskPhone(text) {
  return maskDigitRuns(text);
}

function maskId(text) {
  return maskDigitRuns(text);
}

function maskAddress(text) {
  return String(text).replace(/([\u4e00-\u9fa5]{2,8}(?:社区|街道|路|村|小区|巷|号院))(\d+)(号|栋|幢)/g, '$1**$3');
}

function maskText(value) {
  let out = String(value);
  out = maskPhone(out);
  out = maskId(out);
  out = maskAddress(out);
  return out;
}

function ensureWritable(file) {
  try {
    const stat = fs.statSync(file);
    if (!(stat.mode & 0o200)) fs.chmodSync(file, 0o666);
  } catch (error) {
    // 忽略：后续写入会给出更明确的错误
  }
}

async function maskXlsx(file) {
  ensureWritable(file);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(file);
  let touched = 0;

  for (const ws of wb.worksheets) {
    ws.eachRow(row => {
      row.eachCell(cell => {
        const v = cell.value;
        if (typeof v === 'string') {
          const next = maskText(v);
          if (next !== v) { cell.value = next; touched++; }
        } else if (v && typeof v === 'object' && typeof v.text === 'string') {
          const next = maskText(v.text);
          if (next !== v.text) { cell.value = { ...v, text: next }; touched++; }
        }
      });
    });
  }

  if (touched > 0 && APPLY) await wb.xlsx.writeFile(file);
  return touched;
}

async function maskJson(file) {
  ensureWritable(file);
  const raw = await fs.readFile(file, 'utf8');
  const next = maskText(raw);
  if (next !== raw && APPLY) await fs.writeFile(file, next, 'utf8');
  return next !== raw ? 1 : 0;
}

// ---------- 执行 ----------
async function main() {
  console.log(APPLY ? '\n=== 发布前清理与脱敏（执行模式）===' : '\n=== 发布前清理与脱敏（预览模式，未修改文件）===\n');

  console.log('【将移除的开发痕迹】');
  if (plan.remove.length === 0) console.log('  （无）');
  for (const item of plan.remove) console.log(`  - ${rel(item.target)}  ← ${item.reason}`);

  console.log('\n【数据文件脱敏】');
  for (const item of plan.mask) {
    if (item.kind === 'xlsx') {
      const n = await maskXlsx(item.target);
      const verb = APPLY ? '已脱敏' : '待脱敏';
      console.log(`  - ${rel(item.target)}  ${n > 0 ? `${verb} ${n} 处` : '无需改动'}`);
      if (n > 0 && APPLY) done.push(item.target);
    } else {
      const n = await maskJson(item.target);
      if (n > 0) console.log(`  - ${rel(item.target)}  ${APPLY ? '已脱敏' : '待脱敏'}`);
      if (n > 0 && APPLY) done.push(item.target);
    }
  }

  console.log('\n【将清除的密钥】');
  if (plan.secrets.length === 0) console.log('  （无）');
  for (const item of plan.secrets) {
    console.log(`  - ${rel(item.target)}  ← ${item.reason}`);
    if (APPLY) {
      const content = fs.readJsonSync(item.target);
      delete content.apiKey;
      fs.writeJsonSync(item.target, content, { spaces: 2 });
    }
  }

  if (plan.skip.length > 0) {
    console.log('\n【需人工确认】');
    for (const item of plan.skip) console.log(`  - ${rel(item.target)}  ← ${item.reason}`);
  }

  if (APPLY) {
    for (const item of plan.remove) {
      clearReadonly(item.target);
      fs.removeSync(item.target);
    }
    console.log(`\n已删除 ${plan.remove.length} 项开发痕迹，脱敏 ${done.length} 个文件。`);
    console.log('提醒：settings.json 中的 API Key 已移除，建议同时到服务商控制台作废该 Key 并重新签发。');
  } else {
    console.log('\n预览结束。确认无误后加 --apply 执行。');
  }
}

main().catch(err => {
  console.error('执行失败:', err.message);
  process.exit(1);
});
