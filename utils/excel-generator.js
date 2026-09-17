const ExcelJS = require('exceljs');
const path = require('path');
const fs = require('fs-extra');
const moment = require('moment');
const studentData = require('./student-data');

class ExcelGenerator {
  constructor(config) {
    this.config = config;
    this.reportsDir = config.dataDir ? path.join(config.dataDir, 'reports') : path.join(__dirname, '../data/reports');
    this.ensureDirectories();
  }

  ensureDirectories() {
    fs.ensureDirSync(this.reportsDir);
  }

  // ========== 辅助方法：归一化 / 格式化 / 分类 / 花名册 ==========

  // 归一化班级名为 "初一(N)班" 形式
  normalizeClassName(value) {
    if (value === null || value === undefined) return '';
    const text = String(value).trim();
    if (!text) return '';
    const cnMap = { '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9 };
    if (/^初[一二三四五六七八九]\([1-9]\)班$/.test(text)) return text;
    let m = text.match(/^初[一二三四五六七八九][（(](\d+)[)）]班?$/);
    if (m) return '初' + text[1] + '(' + m[1] + ')班';
    m = text.match(/^初[一二三四五六七八九]\s*(\d+)\s*班?$/);
    if (m) return '初' + text[1] + '(' + m[1] + ')班';
    m = text.match(/^(\d+)\s*班$/);
    if (m) return '初一(' + m[1] + ')班';
    m = text.match(/^([一二三四五六七八九])\s*班$/);
    if (m && cnMap[m[1]]) return '初一(' + cnMap[m[1]] + ')班';
    return text;
  }

  // 把数字字段统一为 number 或 null（null 表示"无数据"，与 0 区分）
  toNum(value) {
    if (value === null || value === undefined || value === '') return null;
    const n = parseInt(value, 10);
    return isNaN(n) ? null : n;
  }

  // 缺失数据显示 "—"
  fmt(value) {
    if (value === null || value === undefined || value === '') return '—';
    return value;
  }

  // 百分比：分母为 0 / null 时返回 "—"
  fmtPct(num, denom) {
    const d = parseInt(denom, 10);
    const n = parseInt(num, 10);
    if (!d || d <= 0 || isNaN(n)) return '—';
    return Math.round((n / d) * 100) + '%';
  }

  // 判断一条记录是否"仅有学生动态"（无任何学情字段）
  isStudentDynamic(record) {
    const empty = (v) => v === null || v === undefined || v === '' || (typeof v === 'number' && isNaN(v));
    const hasAcademic = !empty(record.attendance) || !empty(record.absent) ||
                        !empty(record.homeworkCompleted) || !empty(record.homeworkNotCompleted) ||
                        !empty(record.performance);
    return !hasAcademic && !empty(record.concerns);
  }

  // 从学生花名册构建 "班级 → 人数" 映射，作为应到人数的兜底
  async buildClassRoster() {
    const map = new Map();
    try {
      const overview = await studentData.getOverview(this.config);
      for (const cat of overview.categories || []) {
        const classIdx = cat.headers.findIndex(h => String(h).includes('班级'));
        if (classIdx === -1) continue;
        for (const row of cat.rows) {
          const className = this.normalizeClassName(row[classIdx]);
          if (!className) continue;
          map.set(className, (map.get(className) || 0) + 1);
        }
      }
    } catch (e) {
      console.warn('buildClassRoster 失败（不影响主流程）:', e.message);
    }
    return map;
  }

  // 解析 concerns 中的 "姓名（班级）事项" 结构
  parseConcernParts(concerns) {
    if (!concerns) return [];
    const out = [];
    for (const raw of String(concerns).split(/[；;]/)) {
      const part = raw.trim();
      if (!part) continue;
      const m = part.match(/^(.+?)（(初一\(\d+\)班)）\s*(.+)$/);
      if (m) {
        out.push({ name: m[1], className: m[2], text: m[3] });
      } else {
        out.push({ name: '', className: '', text: part });
      }
    }
    return out;
  }

  // ========== 单条 / 当日 / 月度报表 ==========

  // 生成单个学情记录的Excel
  async generateReport(academicData) {
    try {
      const date = moment(academicData.date || moment().format('YYYY-MM-DD')).format('YYYY-MM-DD');
      const fileName = this.config.excel.filename.replace('{date}', date);
      const filePath = path.join(this.reportsDir, fileName);

      const workbook = new ExcelJS.Workbook();
      const worksheet = workbook.addWorksheet(`${date}学情记录`);
      const headers = this.config.excel.columns;
      worksheet.columns = headers.map(col => ({
        header: col.header,
        key: col.key,
        width: col.width || 15
      }));

      const dataRow = {
        date: academicData.date || moment().format('YYYY-MM-DD'),
        class: this.normalizeClassName(academicData.class),
        subject: academicData.subject || '',
        teacher: academicData.teacher || '',
        attendance: this.fmt(this.toNum(academicData.attendance)),
        absent: this.fmt(this.toNum(academicData.absent)),
        absentReason: academicData.absentReason || '',
        performance: academicData.performance || '',
        homeworkCompleted: this.fmt(this.toNum(academicData.homeworkCompleted)),
        homeworkNotCompleted: this.fmt(this.toNum(academicData.homeworkNotCompleted)),
        homeworkReason: academicData.homeworkReason || '',
        concerns: academicData.concerns || '',
        submittedAt: academicData.submittedAt || moment().format('YYYY-MM-DD HH:mm:ss')
      };
      worksheet.addRow(dataRow);
      this.applyStyles(worksheet);
      await workbook.xlsx.writeFile(filePath);
      console.log('Excel报告已生成: ' + filePath);
      return filePath;
    } catch (error) {
      console.error('生成Excel报告失败:', error);
      throw new Error('Excel报告生成失败: ' + error.message);
    }
  }

  // 生成当日汇总Excel
  async generateTodayReport(date) {
    try {
      const targetDate = moment(date).format('YYYY-MM-DD');
      const sessionDir = path.join(this.config.dataDir, 'sessions');
      const files = await fs.readdir(sessionDir);
      const todayData = [];

      for (const file of files) {
        if (file.endsWith('.json')) {
          const filePath = path.join(sessionDir, file);
          const data = await fs.readJSON(filePath);
          if (moment(data.date).format('YYYY-MM-DD') === targetDate) {
            todayData.push(this.normalizeRecord(data));
          }
        }
      }

      // 按班级和学科排序
      todayData.sort((a, b) => {
        const classA = String(a.class || '');
        const classB = String(b.class || '');
        const subjectA = String(a.subject || '');
        const subjectB = String(b.subject || '');
        if (classA !== classB) return classA.localeCompare(classB);
        return subjectA.localeCompare(subjectB);
      });

      // 加载学生花名册，作为应到人数的兜底
      const classRoster = await this.buildClassRoster();

      // 自动计算班级人数/应到人数，并补齐缺失的缺勤或出勤
      this.computeClassStats(todayData, classRoster);

      const fileName = this.config.excel.filename.replace('{date}', targetDate);
      const filePath = path.join(this.reportsDir, fileName);

      const workbook = new ExcelJS.Workbook();

      // 汇总表（按 班级-学科 聚合 + 学生动态区）
      const summarySheet = workbook.addWorksheet(`${targetDate}汇总`);
      this.createSummarySheet(summarySheet, todayData, classRoster);

      // 详细记录表
      const detailSheet = workbook.addWorksheet(`${targetDate}详细记录`);
      this.createDetailSheet(detailSheet, todayData);

      // 统计分析表
      const analysisSheet = workbook.addWorksheet(`${targetDate}统计分析`);
      await this.createAnalysisSheet(analysisSheet, todayData);

      // 学生情况工作表（格式与《初一学生情况汇总表》一致）
      await this.addStudentSheets(workbook);

      await workbook.xlsx.writeFile(filePath);
      console.log('当日汇总Excel已生成: ' + filePath);
      return filePath;
    } catch (error) {
      console.error('生成当日汇总Excel失败:', error);
      throw new Error('当日汇总Excel生成失败: ' + error.message);
    }
  }

  // 添加学生情况分类工作表（保持原行为，失败不影响主报表）
  async addStudentSheets(workbook) {
    try {
      const overview = await studentData.getOverview(this.config);

      if (overview.summary) {
        const sheet = workbook.addWorksheet('学生情况汇总');
        sheet.columns = overview.summary.headers.map((header, index) => ({
          header,
          key: 'col_' + index,
          width: 14
        }));
        for (const row of overview.summary.rows) {
          const dataRow = {};
          row.forEach((value, index) => { dataRow['col_' + index] = value; });
          sheet.addRow(dataRow);
        }
        this.applyStyles(sheet);
      }

      for (const category of overview.categories) {
        const sheet = workbook.addWorksheet(category.name);
        sheet.columns = category.headers.map((header, index) => ({
          header,
          key: 'col_' + index,
          width: 18
        }));
        for (const row of category.rows) {
          const dataRow = {};
          row.forEach((value, index) => { dataRow['col_' + index] = value; });
          sheet.addRow(dataRow);
        }
        this.applyStyles(sheet);
      }

      return true;
    } catch (error) {
      console.warn('添加学生情况工作表失败（不影响主报表）:', error.message);
      return false;
    }
  }

  // 规范化记录：空值变 null（与 0 区分），班级名归一化
  normalizeRecord(record) {
    const clean = { ...record };
    const numericFields = ['attendance', 'absent', 'homeworkCompleted', 'homeworkNotCompleted'];
    for (const field of numericFields) {
      clean[field] = this.toNum(clean[field]);
    }
    clean.class = this.normalizeClassName(clean.class);
    clean.subject = clean.subject ? String(clean.subject).trim() : '';
    clean.teacher = clean.teacher ? String(clean.teacher).trim() : '';
    return clean;
  }

  // 自动计算班级应到人数，并倒推缺失的缺勤/出勤人数
  // 优先级：实际记录 attendance+absent 最大值 → 花名册人数
  computeClassStats(data, roster) {
    const classShould = {};

    // 第一遍：取每个班级"出勤+缺勤"的最大值作为应到人数
    for (const record of data) {
      const className = record.class;
      if (!className) continue;
      if (record.attendance === null && record.absent === null) continue;
      const total = (record.attendance || 0) + (record.absent || 0);
      if (total > 0) {
        classShould[className] = Math.max(classShould[className] || 0, total);
      }
    }

    // 第二遍：用学生花名册人数兜底
    if (roster) {
      for (const [className, size] of roster.entries()) {
        if (!classShould[className] || size > classShould[className]) {
          classShould[className] = size;
        }
      }
    }

    // 第三遍：按应到人数补齐同班级缺失的缺勤/出勤字段
    for (const record of data) {
      const className = record.class;
      const should = className ? classShould[className] : 0;
      if (!should) continue;
      const att = record.attendance, ab = record.absent;
      if ((att === null || att === 0) && ab && ab > 0 && should > ab) {
        record.attendance = should - ab;
      } else if ((ab === null || ab === 0) && att && att > 0 && should > att) {
        record.absent = should - att;
      }
    }

    return classShould;
  }

  // 创建汇总工作表：按 班级-学科 聚合；纯学生动态另起一区
  createSummarySheet(worksheet, data, classRoster) {
    worksheet.columns = [
      { header: '班级', key: 'class', width: 12 },
      { header: '学科', key: 'subject', width: 10 },
      { header: '教师', key: 'teacher', width: 10 },
      { header: '应到人数', key: 'shouldArrive', width: 10 },
      { header: '实到人数', key: 'actualArrive', width: 10 },
      { header: '缺勤人数', key: 'absent', width: 10 },
      { header: '出勤率', key: 'attendanceRate', width: 10 },
      { header: '作业完成率', key: 'homeworkRate', width: 12 },
      { header: '课堂表现', key: 'performance', width: 24 },
      { header: '需关注事项', key: 'concerns', width: 30 }
    ];

    // 1) 数据分流：纯学生动态 vs 学情记录
    const academicRecords = [];
    const dynamicRecords = [];
    for (const r of data) {
      if (this.isStudentDynamic(r)) {
        dynamicRecords.push(r);
      } else {
        academicRecords.push(r);
      }
    }

    // 2) 学情记录按 (班级-学科) 聚合
    const summaryMap = new Map();
    for (const r of academicRecords) {
      const c = r.class || '';
      const s = r.subject || '';
      const t = r.teacher || '';
      const key = (c || '未分班级') + '||' + (s || '未分学科');
      if (!summaryMap.has(key)) {
        summaryMap.set(key, {
          class: c, subject: s, teacher: t,
          shouldArrive: null, actualArrive: 0, absent: 0,
          hasAttData: false,
          homeworkCompleted: 0, homeworkTotal: 0, hasHwData: false,
          performance: '', concerns: ''
        });
      }
      const agg = summaryMap.get(key);
      if (t) agg.teacher = t;
      if (r.attendance !== null || r.absent !== null) {
        agg.hasAttData = true;
        const total = (r.attendance || 0) + (r.absent || 0);
        agg.shouldArrive = Math.max(agg.shouldArrive || 0, total);
        agg.actualArrive += r.attendance || 0;
        agg.absent += r.absent || 0;
      }
      if (r.homeworkCompleted !== null || r.homeworkNotCompleted !== null) {
        agg.hasHwData = true;
        agg.homeworkCompleted += r.homeworkCompleted || 0;
        agg.homeworkTotal += (r.homeworkCompleted || 0) + (r.homeworkNotCompleted || 0);
      }
      if (r.performance) {
        agg.performance = agg.performance ? (agg.performance + '；' + r.performance) : r.performance;
      }
      if (r.concerns) {
        agg.concerns = agg.concerns ? (agg.concerns + '；' + r.concerns) : r.concerns;
      }
    }

    // 3) 用花名册兜底应到人数
    if (classRoster) {
      for (const agg of summaryMap.values()) {
        if (!agg.shouldArrive && classRoster.has(agg.class)) {
          agg.shouldArrive = classRoster.get(agg.class);
        }
      }
    }

    // 4) 输出学情汇总行 + 累加总计
    let totShould = 0, totActual = 0, totAbsent = 0, totHasAtt = false;
    let totHwComp = 0, totHwTot = 0, totHasHw = false;
    for (const agg of summaryMap.values()) {
      // 若有出勤标记，但实到+缺勤=0（如 attendance=null, absent=0），实际无出勤数据
      const hasRealAtt = agg.hasAttData && (agg.actualArrive + agg.absent) > 0;
      worksheet.addRow({
        class: agg.class || '—',
        subject: agg.subject || '—',
        teacher: agg.teacher || '—',
        shouldArrive: agg.shouldArrive ? agg.shouldArrive : '—',
        actualArrive: hasRealAtt ? agg.actualArrive : '—',
        absent: hasRealAtt ? agg.absent : '—',
        attendanceRate: hasRealAtt ? this.fmtPct(agg.actualArrive, agg.shouldArrive) : '—',
        homeworkRate: agg.hasHwData ? this.fmtPct(agg.homeworkCompleted, agg.homeworkTotal) : '—',
        performance: agg.performance,
        concerns: agg.concerns
      });
      if (agg.shouldArrive) totShould += agg.shouldArrive;
      if (agg.hasAttData) { totHasAtt = true; totActual += agg.actualArrive; totAbsent += agg.absent; }
      if (agg.hasHwData) { totHasHw = true; totHwComp += agg.homeworkCompleted; totHwTot += agg.homeworkTotal; }
    }

    // 5) 总计行
    const totalRow = worksheet.addRow({
      class: '总计',
      subject: '',
      teacher: '',
      shouldArrive: totShould || '—',
      actualArrive: totHasAtt ? totActual : '—',
      absent: totHasAtt ? totAbsent : '—',
      attendanceRate: this.fmtPct(totActual, totShould),
      homeworkRate: totHasHw ? this.fmtPct(totHwComp, totHwTot) : '—',
      performance: '',
      concerns: ''
    });
    totalRow.font = { bold: true };

    // 6) 今日学生动态区
    if (dynamicRecords.length > 0) {
      const sep = worksheet.addRow({
        class: '——— 今日学生动态 ———', subject: '', teacher: '',
        shouldArrive: '', actualArrive: '', absent: '',
        attendanceRate: '', homeworkRate: '',
        performance: '', concerns: ''
      });
      sep.font = { bold: true, color: { argb: '4F81BD' } };
      sep.alignment = { horizontal: 'center' };

      for (const d of dynamicRecords) {
        const parts = this.parseConcernParts(d.concerns);
        if (parts.length === 0) {
          worksheet.addRow({
            class: d.class || '—',
            subject: '', teacher: '',
            shouldArrive: '', actualArrive: '', absent: '',
            attendanceRate: '', homeworkRate: '',
            performance: '',
            concerns: d.concerns || ''
          });
          continue;
        }
        for (const p of parts) {
          worksheet.addRow({
            class: p.className || d.class || '—',
            subject: '', teacher: '',
            shouldArrive: '', actualArrive: '', absent: '',
            attendanceRate: '', homeworkRate: '',
            performance: '',
            concerns: (p.name ? p.name + '：' : '') + p.text
          });
        }
      }
    }

    this.applyStyles(worksheet);
  }

  // 创建详细记录工作表：缺失数据显示 "—"
  createDetailSheet(worksheet, data) {
    worksheet.columns = this.config.excel.columns;
    for (const r of data) {
      worksheet.addRow({
        date: r.date || '',
        class: r.class || '—',
        subject: r.subject || '—',
        teacher: r.teacher || '—',
        attendance: this.fmt(r.attendance),
        absent: this.fmt(r.absent),
        absentReason: r.absentReason || '',
        performance: r.performance || '',
        homeworkCompleted: this.fmt(r.homeworkCompleted),
        homeworkNotCompleted: this.fmt(r.homeworkNotCompleted),
        homeworkReason: r.homeworkReason || '',
        concerns: r.concerns || '',
        submittedAt: r.submittedAt || ''
      });
    }
    this.applyStyles(worksheet);
  }

  // 创建统计分析工作表：仅基于真实学情数据计算；纯学生动态单独计数
  async createAnalysisSheet(worksheet, data) {
    worksheet.columns = [
      { header: '分析维度', key: 'dimension', width: 20 },
      { header: '分析结果', key: 'result', width: 56 },
      { header: '数值', key: 'value', width: 15 }
    ];

    const academicRecords = data.filter(r => !this.isStudentDynamic(r));
    const dynamicCount = data.length - academicRecords.length;

    // 出勤分析
    const attRecs = academicRecords.filter(r => r.attendance !== null || r.absent !== null);
    const totalAttendance = attRecs.reduce((s, r) => s + (r.attendance || 0), 0);
    const totalAbsent = attRecs.reduce((s, r) => s + (r.absent || 0), 0);
    const attendanceRate = (totalAttendance + totalAbsent) > 0
      ? Math.round((totalAttendance / (totalAttendance + totalAbsent)) * 100) : null;
    worksheet.addRow({
      dimension: '整体出勤率',
      result: attRecs.length > 0
        ? '基于 ' + attRecs.length + ' 条学情记录（实到 ' + totalAttendance + ' 人 / 应到 ' + (totalAttendance + totalAbsent) + ' 人）'
        : '今日暂无出勤数据',
      value: attendanceRate === null ? '—' : attendanceRate + '%'
    });

    // 作业完成分析
    const hwRecs = academicRecords.filter(r => r.homeworkCompleted !== null || r.homeworkNotCompleted !== null);
    const totalHw = hwRecs.reduce((s, r) => s + (r.homeworkCompleted || 0) + (r.homeworkNotCompleted || 0), 0);
    const totalCompleted = hwRecs.reduce((s, r) => s + (r.homeworkCompleted || 0), 0);
    const homeworkRate = totalHw > 0 ? Math.round((totalCompleted / totalHw) * 100) : null;
    worksheet.addRow({
      dimension: '作业完成率',
      result: hwRecs.length > 0
        ? '基于 ' + hwRecs.length + ' 条学情记录（完成 ' + totalCompleted + ' 人 / 应交 ' + totalHw + ' 人）'
        : '今日暂无作业数据',
      value: homeworkRate === null ? '—' : homeworkRate + '%'
    });

    // 课堂表现分析
    const perfRecs = academicRecords.filter(r => r.performance);
    const goodPerf = perfRecs.filter(r => /良好|优秀|积极/.test(r.performance)).length;
    const perfRate = perfRecs.length > 0 ? Math.round((goodPerf / perfRecs.length) * 100) : null;
    worksheet.addRow({
      dimension: '课堂表现优秀率',
      result: perfRecs.length > 0
        ? (perfRate >= 80 ? '整体表现优秀' : perfRate >= 60 ? '整体表现良好' : '需要关注') +
          '（' + goodPerf + '/' + perfRecs.length + ' 条记录评价为良好以上）'
        : '今日暂无课堂表现数据',
      value: perfRate === null ? '—' : perfRate + '%'
    });

    // 班级出勤率对比
    const classStats = {};
    for (const r of attRecs) {
      if (!r.class) continue;
      if (!classStats[r.class]) classStats[r.class] = { att: 0, ab: 0 };
      classStats[r.class].att += r.attendance || 0;
      classStats[r.class].ab += r.absent || 0;
    }
    let bestClass = '', bestRate = 0;
    for (const [c, s] of Object.entries(classStats)) {
      const rate = (s.att + s.ab) > 0 ? Math.round((s.att / (s.att + s.ab)) * 100) : 0;
      if (rate > bestRate) { bestRate = rate; bestClass = c; }
    }
    worksheet.addRow({
      dimension: '出勤率最佳班级',
      result: bestClass ? bestClass + ' 出勤情况最佳' : '暂无数据',
      value: bestClass ? bestRate + '%' : '—'
    });

    // 出勤率 < 90% 的班级
    const concernClasses = [];
    for (const [c, s] of Object.entries(classStats)) {
      const rate = (s.att + s.ab) > 0 ? Math.round((s.att / (s.att + s.ab)) * 100) : 0;
      if (rate < 90) concernClasses.push(c + '（' + rate + '%）');
    }
    worksheet.addRow({
      dimension: '需关注的班级',
      result: concernClasses.length > 0 ? concernClasses.join('、') : '所有班级出勤良好',
      value: concernClasses.length > 0 ? concernClasses.length : '0'
    });

    // 学生动态统计
    worksheet.addRow({
      dimension: '今日学生动态',
      result: '今日共记录 ' + dynamicCount + ' 条学生个体事件（已汇总至"今日学生动态"区）',
      value: dynamicCount
    });

    this.applyStyles(worksheet);
  }

  // 应用样式
  applyStyles(worksheet) {
    const headerRow = worksheet.getRow(1);
    headerRow.font = { bold: true, color: { argb: 'FFFFFF' } };
    headerRow.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: '4F81BD' }
    };
    headerRow.alignment = { horizontal: 'center' };

    worksheet.eachRow((row, rowNumber) => {
      if (rowNumber > 1) {
        row.alignment = { vertical: 'top', wrapText: true };
        if (rowNumber % 2 === 0) {
          row.fill = {
            type: 'pattern',
            pattern: 'solid',
            fgColor: { argb: 'F2F2F2' }
          };
        }
      }
    });

    worksheet.columns.forEach(column => {
      if (column.width > 20) column.width = 20;
    });
  }

  // 生成月度汇总报告
  async generateMonthlyReport(year, month) {
    try {
      const sessionDir = path.join(this.config.dataDir, 'sessions');
      const files = await fs.readdir(sessionDir);
      const monthData = [];
      const targetMonth = year + '-' + String(month).padStart(2, '0');

      for (const file of files) {
        if (file.endsWith('.json')) {
          const filePath = path.join(sessionDir, file);
          const data = await fs.readJSON(filePath);
          if (moment(data.date).format('YYYY-MM') === targetMonth) {
            monthData.push(this.normalizeRecord(data));
          }
        }
      }

      if (monthData.length === 0) {
        throw new Error('该月份无数据');
      }

      const fileName = '学情汇总_' + year + '年' + month + '月.xlsx';
      const filePath = path.join(this.reportsDir, fileName);

      const workbook = new ExcelJS.Workbook();
      const summarySheet = workbook.addWorksheet(year + '年' + month + '月汇总');
      await this.createMonthlySummary(summarySheet, monthData, year, month);

      const detailSheet = workbook.addWorksheet(year + '年' + month + '月详细记录');
      this.createMonthlyDetail(detailSheet, monthData);

      const trendSheet = workbook.addWorksheet(year + '年' + month + '月趋势分析');
      await this.createMonthlyTrend(trendSheet, monthData);

      await workbook.xlsx.writeFile(filePath);
      console.log('月度汇总Excel已生成: ' + filePath);
      return filePath;
    } catch (error) {
      console.error('生成月度汇总Excel失败:', error);
      throw new Error('月度汇总Excel生成失败: ' + error.message);
    }
  }

  // 创建月度汇总
  async createMonthlySummary(worksheet, data, year, month) {
    worksheet.columns = [
      { header: '指标', key: 'metric', width: 20 },
      { header: '数值', key: 'value', width: 15 },
      { header: '说明', key: 'description', width: 50 }
    ];

    const totalRecords = data.length;
    const totalClasses = [...new Set(data.map(record => record.class).filter(Boolean))].length;
    const totalSubjects = [...new Set(data.map(record => record.subject).filter(Boolean))].length;

    const attRecs = data.filter(r => r.attendance !== null || r.absent !== null);
    const totalAttendance = attRecs.reduce((s, r) => s + (r.attendance || 0), 0);
    const totalAbsent = attRecs.reduce((s, r) => s + (r.absent || 0), 0);
    const avgAttendanceRate = (totalAttendance + totalAbsent) > 0 ?
      Math.round((totalAttendance / (totalAttendance + totalAbsent)) * 100) : 0;

    worksheet.addRow({ metric: '总记录数', value: totalRecords, description: year + '年' + month + '月学情记录总数' });
    worksheet.addRow({ metric: '覆盖班级', value: totalClasses, description: '共' + totalClasses + '个班级有学情记录' });
    worksheet.addRow({ metric: '覆盖学科', value: totalSubjects, description: '共' + totalSubjects + '个学科有学情记录' });
    worksheet.addRow({ metric: '平均出勤率', value: (totalAttendance + totalAbsent) > 0 ? avgAttendanceRate + '%' : '—',
      description: attRecs.length > 0 ? '基于 ' + attRecs.length + ' 条有出勤数据的记录' : '本月暂无出勤数据' });

    this.applyStyles(worksheet);
  }

  // 月度详细记录：缺失数据显示 "—"
  createMonthlyDetail(worksheet, data) {
    worksheet.columns = this.config.excel.columns;
    for (const r of data) {
      worksheet.addRow({
        date: r.date || '',
        class: r.class || '—',
        subject: r.subject || '—',
        teacher: r.teacher || '—',
        attendance: this.fmt(r.attendance),
        absent: this.fmt(r.absent),
        absentReason: r.absentReason || '',
        performance: r.performance || '',
        homeworkCompleted: this.fmt(r.homeworkCompleted),
        homeworkNotCompleted: this.fmt(r.homeworkNotCompleted),
        homeworkReason: r.homeworkReason || '',
        concerns: r.concerns || '',
        submittedAt: r.submittedAt || ''
      });
    }
    this.applyStyles(worksheet);
  }

  // 月度趋势分析（基于真实数据）
  async createMonthlyTrend(worksheet, data) {
    worksheet.columns = [
      { header: '日期', key: 'date', width: 14 },
      { header: '学情条数', key: 'recordCount', width: 12 },
      { header: '实到/应到', key: 'attendance', width: 14 },
      { header: '出勤率', key: 'rate', width: 10 },
      { header: '作业完成率', key: 'hwRate', width: 12 }
    ];

    const byDate = {};
    for (const r of data) {
      if (!r.date) continue;
      if (!byDate[r.date]) byDate[r.date] = [];
      byDate[r.date].push(r);
    }

    for (const date of Object.keys(byDate).sort()) {
      const recs = byDate[date];
      const academic = recs.filter(r => !this.isStudentDynamic(r));
      const attRecs = academic.filter(r => r.attendance !== null || r.absent !== null);
      const totalAtt = attRecs.reduce((s, r) => s + (r.attendance || 0), 0);
      const totalAb = attRecs.reduce((s, r) => s + (r.absent || 0), 0);
      const hwRecs = academic.filter(r => r.homeworkCompleted !== null || r.homeworkNotCompleted !== null);
      const hwComp = hwRecs.reduce((s, r) => s + (r.homeworkCompleted || 0), 0);
      const hwTot = hwRecs.reduce((s, r) => s + ((r.homeworkCompleted || 0) + (r.homeworkNotCompleted || 0)), 0);
      worksheet.addRow({
        date: date,
        recordCount: academic.length,
        attendance: attRecs.length > 0 ? (totalAtt + ' / ' + (totalAtt + totalAb)) : '—',
        rate: this.fmtPct(totalAtt, totalAtt + totalAb),
        hwRate: this.fmtPct(hwComp, hwTot)
      });
    }

    this.applyStyles(worksheet);
  }

  // 列出所有报告文件
  async listReports() {
    try {
      const files = await fs.readdir(this.reportsDir);
      const reports = files
        .filter(file => file.endsWith('.xlsx'))
        .map(file => ({
          fileName: file,
          filePath: path.join(this.reportsDir, file),
          createdAt: fs.statSync(path.join(this.reportsDir, file)).mtime,
          size: (fs.statSync(path.join(this.reportsDir, file)).size / 1024).toFixed(2) + 'KB'
        }))
        .sort((a, b) => b.createdAt - a.createdAt);

      return { success: true, data: reports };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  // 删除过期报告
  async cleanupExpiredReports() {
    try {
      const files = await fs.readdir(this.reportsDir);
      const now = Date.now();
      const expirationDays = this.config.system.reportRetentionDays;
      const expirationTime = expirationDays * 24 * 60 * 60 * 1000;
      let deletedCount = 0;

      for (const file of files) {
        const filePath = path.join(this.reportsDir, file);
        const stats = await fs.stat(filePath);
        if (now - stats.mtime > expirationTime) {
          await fs.remove(filePath);
          deletedCount++;
          console.log('删除过期报告: ' + file);
        }
      }
      return { success: true, deletedCount, message: '已删除' + deletedCount + '个过期报告' };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }
}

module.exports = ExcelGenerator;
