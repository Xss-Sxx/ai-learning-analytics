/**
 * scripts/seed-demo-data.js —— 演示数据生成脚本（npm run seed）
 *
 * 用途：一键生成若干天的模拟学情记录（写入 data/sessions/）以及对应的 Excel 报表，
 *      方便在没有真实数据时演示/验收系统。执行前会把现有数据备份到 data/seed-backup-时间戳/，
 *      随后清空 sessions 与 reports 目录，避免新旧数据混杂。
 */

const fs = require('fs-extra');
const path = require('path');
const moment = require('moment');
const config = require('../config');
const ExcelGenerator = require('../utils/excel-generator');

// 要生成的日期范围
const dates = ['2026-08-18', '2026-08-19', '2026-08-20'];
// 参与生成的班级
const classes = ['初一(1)班', '初一(2)班', '初一(3)班', '初一(4)班'];

// 学科及其"班级 → 任课教师"映射，保证生成的数据符合真实任课关系
const subjects = [
  { subject: '语文', teacherMap: { '初一(1)班': '胡芳', '初一(2)班': '胡芳', '初一(3)班': '杨秀英', '初一(4)班': '杨秀英' } },
  { subject: '数学', teacherMap: { '初一(1)班': '张秀英', '初一(2)班': '张秀英', '初一(3)班': '罗静', '初一(4)班': '罗静' } },
  { subject: '英语', teacherMap: { '初一(1)班': '赵建军', '初一(2)班': '赵建军', '初一(3)班': '周芳', '初一(4)班': '周芳' } },
  { subject: '政治', teacherMap: { '初一(1)班': '黄娜', '初一(2)班': '黄娜', '初一(3)班': '林洋', '初一(4)班': '林洋' } },
  { subject: '历史', teacherMap: { '初一(1)班': '陈伟', '初一(2)班': '陈伟', '初一(3)班': '郭杰', '初一(4)班': '郭杰' } }
];

// 课堂表现评语候选池
const performancePool = [
  '课堂氛围良好，多数学生积极发言',
  '整体认真，部分学生需要加强专注',
  '课堂纪律良好，解题思路清晰',
  '互动活跃，学生参与度较高',
  '整体正常，个别学生有走神现象'
];

// 缺勤原因候选池
const absentReasonPool = ['病假1人', '事假1人', '迟到1人', '请假1人', '病假1人事假1人'];
// 作业未完成原因候选池
const homeworkReasonPool = ['忘记带', '不会做', '未完成', '请假缺交'];

// 各班可被记录的学生姓名池（仅用于生成"需关注事项"）
const concernPool = {
  '初一(1)班': ['杨华', '周秀英', '赵娜', '黄杰', '吴娜', '杨艳'],
  '初一(2)班': ['王明', '李伟', '张艳', '周静', '陈芳', '黄娜', '刘伟', '杨磊', '周涛', '李敏', '陈艳', '吴磊'],
  '初一(3)班': ['刘娜', '李静', '李艳', '黄明', '陈敏', '张芳', '李杰', '赵艳', '王娜', '李秀英'],
  '初一(4)班': ['杨静', '张娜', '王杰', '王涛', '吴敏', '刘静', '黄强', '周明', '陈超', '杨伟', '黄洋', '黄静', '刘磊']
};

// 生成 [min, max] 闭区间内的随机整数
function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

// 从数组中随机取一项
function pick(list) {
  return list[randomInt(0, list.length - 1)];
}

// 随机生成一条"姓名（班级）事项"格式的学生动态
function pickConcern(className) {
  const name = pick(concernPool[className]);
  const action = pick(['今天心情低落', '上课走神', '作业未按时完成', '情绪状态需要关注', '课堂表现有进步']);
  return `${name}（${className}）${action}`;
}

// 生成指定长度的随机小写字母数字串，用于构造唯一的文件名
function randomString(length) {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < length; i++) {
    result += chars[randomInt(0, chars.length - 1)];
  }
  return result;
}

// 备份并清空现有的 sessions / reports 数据
// 返回备份目录路径；若原本没有数据则返回 null
async function backupAndClear() {
  const sessionsHasFiles = await fs.pathExists(config.sessionsDir) && (await fs.readdir(config.sessionsDir)).length > 0;
  const reportsHasFiles = await fs.pathExists(config.reportsDir) && (await fs.readdir(config.reportsDir)).length > 0;
  if (!sessionsHasFiles && !reportsHasFiles) {
    return null;   // 无数据可备份
  }

  // 备份目录名带时间戳，多次执行不会互相覆盖
  const backupDir = path.join(config.dataDir, `seed-backup-${moment().format('YYYYMMDD_HHmmss')}`);
  await fs.ensureDir(backupDir);
  if (sessionsHasFiles) {
    await fs.copy(config.sessionsDir, path.join(backupDir, 'sessions'));
  }
  if (reportsHasFiles) {
    await fs.copy(config.reportsDir, path.join(backupDir, 'reports'));
  }
  // 清空原目录，让本次生成的数据成为唯一内容
  await fs.emptyDir(config.sessionsDir);
  await fs.emptyDir(config.reportsDir);
  return backupDir;
}

// 主流程：先备份清空，再按"日期 × 学科 × 班级"三维组合生成记录
async function main() {
  const backupDir = await backupAndClear();

  const records = [];
  let index = 0;   // 用于让提交时间逐条递增，避免时间完全相同
  for (const date of dates) {
    for (const subjectInfo of subjects) {
      for (const className of classes) {
        // 随机生成合理区间内的人数，使数据看起来自然
        const attendance = randomInt(43, 48);
        const absent = randomInt(0, 3);
        const homeworkCompleted = randomInt(Math.max(40, attendance - 3), attendance);
        const homeworkNotCompleted = Math.max(0, attendance - homeworkCompleted);
        // 提交时间从当天 18:00 起每条递增 3 分钟
        const submittedTime = moment(`${date}T18:00:00`).add(index * 3, 'minutes');

        records.push({
          date,
          class: className,
          subject: subjectInfo.subject,
          teacher: subjectInfo.teacherMap[className],
          attendance,
          absent,
          absentReason: absent > 0 ? pick(absentReasonPool) : '',
          performance: pick(performancePool),
          homeworkCompleted,
          homeworkNotCompleted,
          homeworkReason: homeworkNotCompleted > 0 ? pick(homeworkReasonPool) : '',
          concerns: Math.random() < 0.6 ? pickConcern(className) : '',
          submittedAt: submittedTime.format('YYYY-MM-DD HH:mm:ss'),
          // 元数据与真实填报保持一致，便于其它模块（如统计、排序）正常处理
          metadata: {
            id: `academic_data_${date.replace(/-/g, '_')}_${randomString(8)}.json`,
            createdAt: submittedTime.format(),
            modifiedAt: submittedTime.format(),
            version: '1.0'
          }
        });
        index++;
      }
    }
  }

  await fs.ensureDir(config.sessionsDir);
  // 逐条写入 JSON：文件名与 metadata.id 保持一致，便于按 id 精确定位记录
  for (const record of records) {
    const fileName = `academic_data_${record.date.replace(/-/g, '_')}_${randomString(8)}.json`;
    record.metadata.id = fileName;
    await fs.writeJSON(path.join(config.sessionsDir, fileName), record, { spaces: 2 });
  }

  // 为每一天生成当日汇总 Excel（内含汇总/详细/统计/学生情况四类工作表）
  const excelGenerator = new ExcelGenerator(config);
  for (const date of dates) {
    await excelGenerator.generateTodayReport(date);
  }

  // 模拟数据报表同时归档到 data/students/archive/年-月/
  const archiveDir = path.join(config.archiveStudentDataDir, moment().format('YYYY-MM'));
  await fs.ensureDir(archiveDir);
  const archivedReports = [];
  for (const date of dates) {
    const reportName = `学情汇总_${date}.xlsx`;
    await fs.copy(path.join(config.reportsDir, reportName), path.join(archiveDir, reportName));
    archivedReports.push(reportName);
  }

  // 输出汇总信息：备份位置、记录总数、每天的条数、生成的报表清单
  console.log(JSON.stringify({
    backupDir,
    totalRecords: records.length,
    perDay: dates.map(date => ({
      date,
      count: records.filter(record => record.date === date).length
    })),
    reports: dates.map(date => `学情汇总_${date}.xlsx`)
    ,
    archivedReports
  }, null, 2));
}

main().catch(error => {
  console.error('生成模拟数据失败:', error);
  process.exit(1);   // 非 0 退出码便于 CI/脚本判断失败
});
