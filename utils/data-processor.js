/**
 * utils/data-processor.js —— 学情数据的落盘、查询、统计、校验与备份
 *
 * 说明：每条学情记录以独立 JSON 文件存放在 data/sessions/ 下（文件名即记录 id），
 *      本类把"文件系统"封装成类似数据访问层的能力，供 server.js 复用。
 * 约定：所有方法都不向外抛异常，统一返回 { success, ... } 形式的结果对象，便于接口层直接透传。
 */

const fs = require('fs-extra');     // 文件读写
const path = require('path');        // 路径处理
const moment = require('moment');    // 日期解析与格式化

class DataProcessor {
  /**
   * @param {object} config 全局配置
   */
  constructor(config) {
    this.config = config;
    this.sessionDir = path.join(config.dataDir, 'sessions');   // 学情记录目录
    this.reportsDir = path.join(config.dataDir, 'reports');    // 报表目录
  }

  // 确保目录存在（构造后由外部调用一次；目录缺失时读写会直接报错）
  ensureDirectories() {
    fs.ensureDirSync(this.sessionDir);
    fs.ensureDirSync(this.reportsDir);
  }

  /**
   * 保存一条学情数据为 JSON 文件，并附加元数据。
   * 文件名格式：academic_data_日期_时间_随机串.json（保证同一秒内多条也不冲突）。
   * @param {object} data 学情数据
   * @returns {Promise<{success:boolean, filePath?:string, data?:object, error?:string}>}
   */
  async saveAcademicData(data) {
    try {
      const fileName = `academic_data_${moment().format('YYYY-MM-DD_HH-mm-ss')}_${Math.random().toString(36).substr(2, 9)}.json`;
      const filePath = path.join(this.sessionDir, fileName);
      
      // 添加元数据：记录 id、创建/修改时间、数据结构版本，便于后续迁移与排查
      const dataWithMetadata = {
        ...data,
        metadata: {
          id: fileName,
          createdAt: moment().format(),
          modifiedAt: moment().format(),
          version: '1.0'
        }
      };
      
      await fs.writeJSON(filePath, dataWithMetadata, { spaces: 2 });   // 美化输出，方便人工查看
      
      console.log(`学情数据已保存: ${filePath}`);
      return {
        success: true,
        filePath,
        data: dataWithMetadata
      };
      
    } catch (error) {
      console.error('保存学情数据失败:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * 获取学情数据列表（支持过滤）。
   * @param {object} filters 过滤条件：startDate / endDate / class / subject / teacher
   * @returns {Promise<{success:boolean, data?:Array, total?:number, error?:string}>}
   */
  async getAcademicDataList(filters = {}) {
    try {
      const files = await fs.readdir(this.sessionDir);
      const dataList = [];
      
      for (const file of files) {
        if (file.endsWith('.json')) {                       // 只处理 JSON 记录
          const filePath = path.join(this.sessionDir, file);
          const data = await fs.readJSON(filePath);
          
          // 应用过滤器，不满足条件的直接跳过
          if (this.passesFilters(data, filters)) {
            dataList.push({
              id: file,
              fileName: file,
              filePath,
              data: {
                ...data,
                submittedAt: data.submittedAt || data.metadata?.createdAt   // 统一提交时间字段
              },
              createdAt: data.metadata?.createdAt || data.date,
              modifiedAt: data.metadata?.modifiedAt || data.date
            });
          }
        }
      }
      
      // 按创建时间倒序（最新在前）
      dataList.sort((a, b) => {
        return moment(b.createdAt).diff(moment(a.createdAt));
      });
      
      return {
        success: true,
        data: dataList,
        total: dataList.length
      };
      
    } catch (error) {
      console.error('获取学情数据列表失败:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * 判断一条记录是否满足过滤条件（日期区间 + 班级/学科/教师精确匹配）。
   * @param {object} data 学情记录
   * @param {object} filters 过滤条件
   * @returns {boolean} true 表示通过
   */
  passesFilters(data, filters) {
    // 起始日期：记录的日期早于起点则排除
    if (filters.startDate) {
      const dataDate = moment(data.date || data.metadata?.createdAt);
      if (dataDate.isBefore(moment(filters.startDate).startOf('day'))) {
        return false;
      }
    }
    
    // 结束日期：记录的日期晚于终点则排除（用 endOf('day') 保证当天记录不被漏掉）
    if (filters.endDate) {
      const dataDate = moment(data.date || data.metadata?.createdAt);
      if (dataDate.isAfter(moment(filters.endDate).endOf('day'))) {
        return false;
      }
    }
    
    // 班级过滤
    if (filters.class && data.class !== filters.class) {
      return false;
    }
    
    // 学科过滤
    if (filters.subject && data.subject !== filters.subject) {
      return false;
    }
    
    // 教师过滤
    if (filters.teacher && data.teacher !== filters.teacher) {
      return false;
    }
    
    return true;
  }

  /**
   * 按 id（文件名）读取单条学情记录。
   * @param {string} id 记录文件名
   * @returns {Promise<{success:boolean, data?:object, error?:string}>}
   */
  async getAcademicData(id) {
    try {
      const filePath = path.join(this.sessionDir, id);
      
      if (await fs.pathExists(filePath)) {
        const data = await fs.readJSON(filePath);
        
        return {
          success: true,
          data: {
            ...data,
            submittedAt: data.submittedAt || data.metadata?.createdAt
          }
        };
      } else {
        return {
          success: false,
          error: '记录不存在'
        };
      }
      
    } catch (error) {
      console.error('获取学情数据失败:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * 删除单条学情记录。
   * @param {string} id 记录文件名
   * @returns {Promise<{success:boolean, message?:string, error?:string}>}
   */
  async deleteAcademicData(id) {
    try {
      const filePath = path.join(this.sessionDir, id);
      
      if (await fs.pathExists(filePath)) {
        await fs.remove(filePath);
        
        return {
          success: true,
          message: `记录 ${id} 已删除`
        };
      } else {
        return {
          success: false,
          error: '记录不存在'
        };
      }
      
    } catch (error) {
      console.error('删除学情数据失败:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * 统计分析：总览指标 + 按班级 / 学科 / 日期三个维度的聚合结果。
   * 所有比率在分母为 0 时按 0 处理，避免出现 NaN。
   * @param {object} filters 过滤条件（同 getAcademicDataList）
   * @returns {Promise<{success:boolean, data?:object, error?:string}>}
   */
  async getStatistics(filters = {}) {
    try {
      const result = await this.getAcademicDataList(filters);
      if (!result.success) {
        return result;
      }
      
      const dataList = result.data;
      const stats = {
        totalRecords: dataList.length,                                                     // 记录总条数
        totalClasses: [...new Set(dataList.map(item => item.data.class))].length,           // 覆盖班级数（去重）
        totalSubjects: [...new Set(dataList.map(item => item.data.subject))].length,        // 覆盖学科数（去重）
        totalTeachers: [...new Set(dataList.map(item => item.data.teacher))].length,        // 覆盖教师数（去重）
        
        // 出勤统计
        totalAttendance: dataList.reduce((sum, item) => sum + (item.data.attendance || 0), 0),
        totalAbsent: dataList.reduce((sum, item) => sum + (item.data.absent || 0), 0),
        avgAttendanceRate: 0,
        
        // 作业统计：总量 = 已完成 + 未完成
        totalHomework: dataList.reduce((sum, item) => 
          sum + ((item.data.homeworkCompleted || 0) + (item.data.homeworkNotCompleted || 0)), 0),
        totalHomeworkCompleted: dataList.reduce((sum, item) => sum + (item.data.homeworkCompleted || 0), 0),
        avgHomeworkRate: 0,
        
        classStats: {},      // 按班级聚合
        subjectStats: {},    // 按学科聚合
        dailyStats: {}       // 按日期聚合
      };
      
      // 计算总体平均出勤率
      if (stats.totalAttendance + stats.totalAbsent > 0) {
        stats.avgAttendanceRate = Math.round((stats.totalAttendance / (stats.totalAttendance + stats.totalAbsent)) * 100);
      }
      
      // 计算总体作业完成率
      if (stats.totalHomework > 0) {
        stats.avgHomeworkRate = Math.round((stats.totalHomeworkCompleted / stats.totalHomework) * 100);
      }
      
      // ---------- 按班级聚合 ----------
      const classData = {};
      dataList.forEach(item => {
        const className = item.data.class;
        if (!classData[className]) {
          classData[className] = {
            count: 0,
            attendance: 0,
            absent: 0,
            homeworkCompleted: 0,
            homeworkTotal: 0,
            goodPerformance: 0
          };
        }
        
        const classItem = classData[className];
        classItem.count++;
        classItem.attendance += item.data.attendance || 0;
        classItem.absent += item.data.absent || 0;
        classItem.homeworkCompleted += item.data.homeworkCompleted || 0;
        classItem.homeworkTotal += (item.data.homeworkCompleted || 0) + (item.data.homeworkNotCompleted || 0);
        
        // 课堂表现包含"良好/优秀"视为一次正向表现
        if (item.data.performance && (item.data.performance.includes('良好') || item.data.performance.includes('优秀'))) {
          classItem.goodPerformance++;
        }
      });
      
      // 换算成比率
      for (const [className, data] of Object.entries(classData)) {
        stats.classStats[className] = {
          count: data.count,
          attendanceRate: data.count > 0 ? 
            Math.round((data.attendance / (data.attendance + data.absent)) * 100) : 0,
          homeworkRate: data.homeworkTotal > 0 ? 
            Math.round((data.homeworkCompleted / data.homeworkTotal) * 100) : 0,
          performanceRate: data.count > 0 ? 
            Math.round((data.goodPerformance / data.count) * 100) : 0
        };
      }
      
      // ---------- 按学科聚合（逻辑同班级） ----------
      const subjectData = {};
      dataList.forEach(item => {
        const subjectName = item.data.subject;
        if (!subjectData[subjectName]) {
          subjectData[subjectName] = {
            count: 0,
            attendance: 0,
            absent: 0,
            homeworkCompleted: 0,
            homeworkTotal: 0,
            goodPerformance: 0
          };
        }
        
        const subjectItem = subjectData[subjectName];
        subjectItem.count++;
        subjectItem.attendance += item.data.attendance || 0;
        subjectItem.absent += item.data.absent || 0;
        subjectItem.homeworkCompleted += item.data.homeworkCompleted || 0;
        subjectItem.homeworkTotal += (item.data.homeworkCompleted || 0) + (item.data.homeworkNotCompleted || 0);
        
        if (item.data.performance && (item.data.performance.includes('良好') || item.data.performance.includes('优秀'))) {
          subjectItem.goodPerformance++;
        }
      });
      
      for (const [subjectName, data] of Object.entries(subjectData)) {
        stats.subjectStats[subjectName] = {
          count: data.count,
          attendanceRate: data.count > 0 ? 
            Math.round((data.attendance / (data.attendance + data.absent)) * 100) : 0,
          homeworkRate: data.homeworkTotal > 0 ? 
            Math.round((data.homeworkCompleted / data.homeworkTotal) * 100) : 0,
          performanceRate: data.count > 0 ? 
            Math.round((data.goodPerformance / data.count) * 100) : 0
        };
      }
      
      // ---------- 按日期聚合（用于趋势展示） ----------
      const dailyData = {};
      dataList.forEach(item => {
        const date = moment(item.data.date || item.data.metadata?.createdAt).format('YYYY-MM-DD');
        if (!dailyData[date]) {
          dailyData[date] = {
            count: 0,
            attendance: 0,
            absent: 0,
            homeworkCompleted: 0,
            homeworkTotal: 0
          };
        }
        
        const dailyItem = dailyData[date];
        dailyItem.count++;
        dailyItem.attendance += item.data.attendance || 0;
        dailyItem.absent += item.data.absent || 0;
        dailyItem.homeworkCompleted += item.data.homeworkCompleted || 0;
        dailyItem.homeworkTotal += (item.data.homeworkCompleted || 0) + (item.data.homeworkNotCompleted || 0);
      });
      
      for (const [date, data] of Object.entries(dailyData)) {
        stats.dailyStats[date] = {
          count: data.count,
          attendanceRate: data.count > 0 ? 
            Math.round((data.attendance / (data.attendance + data.absent)) * 100) : 0,
          homeworkRate: data.homeworkTotal > 0 ? 
            Math.round((data.homeworkCompleted / data.homeworkTotal) * 100) : 0
        };
      }
      
      return {
        success: true,
        data: stats
      };
      
    } catch (error) {
      console.error('统计分析失败:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * 生成一次数据备份：把 sessions / reports 目录整体复制到 data/backups/backup_时间戳/。
   * @returns {Promise<{success:boolean, backupFile?:string, backupInfo?:object, error?:string}>}
   */
  async generateBackup() {
    try {
      const timestamp = moment().format('YYYY-MM-DD_HH-mm-ss');
      const backupDir = path.join(this.config.dataDir, 'backups');
      const backupFile = path.join(backupDir, `backup_${timestamp}`);
      
      fs.ensureDirSync(backupDir);
      fs.ensureDirSync(backupFile);
      
      // 复制会话数据目录
      await fs.copy(this.sessionDir, path.join(backupFile, 'sessions'));
      
      // 复制报告数据目录
      await fs.copy(this.reportsDir, path.join(backupFile, 'reports'));
      
      // 生成备份说明文件，记录本次备份包含多少文件，便于还原时核对
      const backupInfo = {
        timestamp,
        dataDir: this.config.dataDir,
        sessions: {
          count: (await fs.readdir(this.sessionDir)).filter(f => f.endsWith('.json')).length,
          dir: this.sessionDir
        },
        reports: {
          count: (await fs.readdir(this.reportsDir)).filter(f => f.endsWith('.xlsx')).length,
          dir: this.reportsDir
        }
      };
      
      await fs.writeJSON(path.join(backupFile, 'backup-info.json'), backupInfo, { spaces: 2 });
      
      return {
        success: true,
        backupFile,
        backupInfo
      };
      
    } catch (error) {
      console.error('生成备份失败:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * 学情数据校验：必填字段、数字类型、人数逻辑、日期格式。
   * @param {object} data 待校验数据
   * @returns {{valid:boolean, errors:string[]}} valid=true 表示无问题
   */
  validateAcademicData(data) {
    const errors = [];
    
    // 必需字段验证
    const requiredFields = ['class', 'subject', 'teacher', 'attendance'];
    for (const field of requiredFields) {
      if (!data[field]) {
        errors.push(`缺少必需字段: ${field}`);
      }
    }
    
    // 数据类型验证：人数必须是非负数字
    if (data.attendance && (typeof data.attendance !== 'number' || data.attendance < 0)) {
      errors.push('出勤人数必须是有效的正数');
    }
    
    if (data.absent && (typeof data.absent !== 'number' || data.absent < 0)) {
      errors.push('缺勤人数必须是有效的正数');
    }
    
    // 逻辑验证：出勤 + 缺勤 应落在合理区间（1-100）
    if (data.attendance !== undefined && data.absent !== undefined) {
      const total = data.attendance + data.absent;
      if (total <= 0 || total > 100) {
        errors.push('出勤和缺勤总数应该在1-100之间');
      }
    }
    
    // 日期验证：严格匹配 YYYY-MM-DD
    if (data.date) {
      if (!moment(data.date, 'YYYY-MM-DD', true).isValid()) {
        errors.push('日期格式应该是YYYY-MM-DD');
      }
    }
    
    return {
      valid: errors.length === 0,
      errors
    };
  }

  /**
   * 数据清洗：字符串去空格、数字字段转 number（非数字置为 undefined）、补默认日期与提交时间。
   * @param {object} data 原始数据
   * @returns {object} 清洗后的新对象（不修改入参）
   */
  cleanAcademicData(data) {
    const cleaned = { ...data };
    
    // 清理字符串字段
    const stringFields = ['class', 'subject', 'teacher', 'absentReason', 'performance', 'homeworkReason', 'concerns'];
    for (const field of stringFields) {
      if (cleaned[field] && typeof cleaned[field] === 'string') {
        cleaned[field] = cleaned[field].trim().replace(/\s+/g, ' ');
      }
    }
    
    // 确保数字字段为数字；无法解析的显式置为 undefined，避免脏数据进入报表
    const numericFields = ['attendance', 'absent', 'homeworkCompleted', 'homeworkNotCompleted'];
    for (const field of numericFields) {
      if (cleaned[field] !== undefined) {
        const value = parseInt(cleaned[field]);
        if (!isNaN(value)) {
          cleaned[field] = value;
        } else {
          cleaned[field] = undefined;
        }
      }
    }
    
    // 设置默认日期（未提供时按今天）
    if (!cleaned.date) {
      cleaned.date = moment().format('YYYY-MM-DD');
    }
    
    // 设置默认提交时间
    if (!cleaned.submittedAt) {
      cleaned.submittedAt = moment().format('YYYY-MM-DD HH:mm:ss');
    }
    
    return cleaned;
  }

  /**
   * 按过滤条件把数据导出成单个 JSON 文件（存放在 data/ 根目录）。
   * @param {object} filters 过滤条件
   * @returns {Promise<{success:boolean, exportFile?:string, recordCount?:number, error?:string}>}
   */
  async exportDataAsJSON(filters = {}) {
    try {
      const result = await this.getAcademicDataList(filters);
      if (!result.success) {
        return result;
      }
      
      const exportData = {
        exportTime: moment().format(),
        totalRecords: result.total,
        data: result.data.map(item => item.data)
      };
      
      const timestamp = moment().format('YYYY-MM-DD_HH-mm-ss');
      const exportFile = path.join(this.config.dataDir, `export_${timestamp}.json`);
      
      await fs.writeJSON(exportFile, exportData, { spaces: 2 });
      
      return {
        success: true,
        exportFile,
        recordCount: result.total
      };
      
    } catch (error) {
      console.error('导出JSON数据失败:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * 系统健康状态：目录是否存在、文件数量、占用空间与最后更新时间。
   * @returns {Promise<{success:boolean, health?:object, error?:string}>}
   */
  async getSystemHealth() {
    try {
      const sessionDirExists = await fs.pathExists(this.sessionDir);
      const reportsDirExists = await fs.pathExists(this.reportsDir);
      
      const sessionFiles = sessionDirExists ? 
        (await fs.readdir(this.sessionDir)).filter(f => f.endsWith('.json')) : [];
      const reportFiles = reportsDirExists ? 
        (await fs.readdir(this.reportsDir)).filter(f => f.endsWith('.xlsx')) : [];
      
      const sessionDiskUsage = sessionDirExists ? 
        await this.getDirectorySize(this.sessionDir) : 0;
      const reportDiskUsage = reportsDirExists ? 
        await this.getDirectorySize(this.reportsDir) : 0;
      
      return {
        success: true,
        health: {
          sessionDir: {
            exists: sessionDirExists,
            fileCount: sessionFiles.length,
            diskUsage: sessionDiskUsage,
            lastUpdate: sessionDirExists ? 
              moment((await fs.stat(this.sessionDir)).mtime).format() : null
          },
          reportsDir: {
            exists: reportsDirExists,
            fileCount: reportFiles.length,
            diskUsage: reportDiskUsage,
            lastUpdate: reportsDirExists ? 
              moment((await fs.stat(this.reportsDir)).mtime).format() : null
          },
          totalDiskUsage: sessionDiskUsage + reportDiskUsage,   // 字节数合计
          timestamp: moment().format()
        }
      };
      
    } catch (error) {
      console.error('获取系统健康状态失败:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * 递归统计目录占用的总字节数。
   * @param {string} dirPath 目录路径
   * @returns {Promise<number>} 字节数（出错时返回 0）
   */
  async getDirectorySize(dirPath) {
    try {
      let total = 0;
      const files = await fs.readdir(dirPath);
      for (const file of files) {
        const filePath = path.join(dirPath, file);
        const stat = await fs.stat(filePath);
        if (stat.isDirectory()) {
          total += await this.getDirectorySize(filePath);   // 子目录递归累加
        } else {
          total += stat.size;
        }
      }
      return total;
    } catch (error) {
      return 0;
    }
  }
}

module.exports = DataProcessor;
