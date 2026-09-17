const fs = require('fs-extra');
const path = require('path');
const moment = require('moment');

class DataProcessor {
  constructor(config) {
    this.config = config;
    this.sessionDir = path.join(config.dataDir, 'sessions');
    this.reportsDir = path.join(config.dataDir, 'reports');
  }

  // 确保目录存在
  ensureDirectories() {
    fs.ensureDirSync(this.sessionDir);
    fs.ensureDirSync(this.reportsDir);
  }

  // 保存学情数据
  async saveAcademicData(data) {
    try {
      const fileName = `academic_data_${moment().format('YYYY-MM-DD_HH-mm-ss')}_${Math.random().toString(36).substr(2, 9)}.json`;
      const filePath = path.join(this.sessionDir, fileName);
      
      // 添加元数据
      const dataWithMetadata = {
        ...data,
        metadata: {
          id: fileName,
          createdAt: moment().format(),
          modifiedAt: moment().format(),
          version: '1.0'
        }
      };
      
      await fs.writeJSON(filePath, dataWithMetadata, { spaces: 2 });
      
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

  // 获取学情数据列表
  async getAcademicDataList(filters = {}) {
    try {
      const files = await fs.readdir(this.sessionDir);
      const dataList = [];
      
      for (const file of files) {
        if (file.endsWith('.json')) {
          const filePath = path.join(this.sessionDir, file);
          const data = await fs.readJSON(filePath);
          
          // 应用过滤器
          if (this.passesFilters(data, filters)) {
            dataList.push({
              id: file,
              fileName: file,
              filePath,
              data: {
                ...data,
                submittedAt: data.submittedAt || data.metadata?.createdAt
              },
              createdAt: data.metadata?.createdAt || data.date,
              modifiedAt: data.metadata?.modifiedAt || data.date
            });
          }
        }
      }
      
      // 按创建时间排序
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

  // 检查数据是否通过过滤器
  passesFilters(data, filters) {
    // 日期过滤
    if (filters.startDate) {
      const dataDate = moment(data.date || data.metadata?.createdAt);
      if (dataDate.isBefore(moment(filters.startDate).startOf('day'))) {
        return false;
      }
    }
    
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

  // 获取特定记录
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

  // 删除学情数据
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

  // 统计分析
  async getStatistics(filters = {}) {
    try {
      const result = await this.getAcademicDataList(filters);
      if (!result.success) {
        return result;
      }
      
      const dataList = result.data;
      const stats = {
        totalRecords: dataList.length,
        totalClasses: [...new Set(dataList.map(item => item.data.class))].length,
        totalSubjects: [...new Set(dataList.map(item => item.data.subject))].length,
        totalTeachers: [...new Set(dataList.map(item => item.data.teacher))].length,
        
        // 出勤统计
        totalAttendance: dataList.reduce((sum, item) => sum + (item.data.attendance || 0), 0),
        totalAbsent: dataList.reduce((sum, item) => sum + (item.data.absent || 0), 0),
        avgAttendanceRate: 0,
        
        // 作业统计
        totalHomework: dataList.reduce((sum, item) => 
          sum + ((item.data.homeworkCompleted || 0) + (item.data.homeworkNotCompleted || 0)), 0),
        totalHomeworkCompleted: dataList.reduce((sum, item) => sum + (item.data.homeworkCompleted || 0), 0),
        avgHomeworkRate: 0,
        
        // 班级统计
        classStats: {},
        
        // 学科统计
        subjectStats: {},
        
        // 时间统计
        dailyStats: {}
      };
      
      // 计算总体统计
      if (stats.totalAttendance + stats.totalAbsent > 0) {
        stats.avgAttendanceRate = Math.round((stats.totalAttendance / (stats.totalAttendance + stats.totalAbsent)) * 100);
      }
      
      if (stats.totalHomework > 0) {
        stats.avgHomeworkRate = Math.round((stats.totalHomeworkCompleted / stats.totalHomework) * 100);
      }
      
      // 班级统计
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
        
        if (item.data.performance && (item.data.performance.includes('良好') || item.data.performance.includes('优秀'))) {
          classItem.goodPerformance++;
        }
      });
      
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
      
      // 学科统计
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
      
      // 每日统计
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

  // 生成数据备份
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
      
      // 创建备份信息文件
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

  // 数据验证
  validateAcademicData(data) {
    const errors = [];
    
    // 必需字段验证
    const requiredFields = ['class', 'subject', 'teacher', 'attendance'];
    for (const field of requiredFields) {
      if (!data[field]) {
        errors.push(`缺少必需字段: ${field}`);
      }
    }
    
    // 数据类型验证
    if (data.attendance && (typeof data.attendance !== 'number' || data.attendance < 0)) {
      errors.push('出勤人数必须是有效的正数');
    }
    
    if (data.absent && (typeof data.absent !== 'number' || data.absent < 0)) {
      errors.push('缺勤人数必须是有效的正数');
    }
    
    // 逻辑验证
    if (data.attendance !== undefined && data.absent !== undefined) {
      const total = data.attendance + data.absent;
      if (total <= 0 || total > 100) {
        errors.push('出勤和缺勤总数应该在1-100之间');
      }
    }
    
    // 日期验证
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

  // 数据清洗
  cleanAcademicData(data) {
    const cleaned = { ...data };
    
    // 清理字符串字段
    const stringFields = ['class', 'subject', 'teacher', 'absentReason', 'performance', 'homeworkReason', 'concerns'];
    for (const field of stringFields) {
      if (cleaned[field] && typeof cleaned[field] === 'string') {
        cleaned[field] = cleaned[field].trim().replace(/\s+/g, ' ');
      }
    }
    
    // 确保数字字段为数字
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
    
    // 设置默认日期
    if (!cleaned.date) {
      cleaned.date = moment().format('YYYY-MM-DD');
    }
    
    // 设置默认提交时间
    if (!cleaned.submittedAt) {
      cleaned.submittedAt = moment().format('YYYY-MM-DD HH:mm:ss');
    }
    
    return cleaned;
  }

  // 导出数据为JSON
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

  // 获取系统健康状态
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
          totalDiskUsage: sessionDiskUsage + reportDiskUsage,
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

  // 获取目录大小
  async getDirectorySize(dirPath) {
    try {
      let total = 0;
      const files = await fs.readdir(dirPath);
      for (const file of files) {
        const filePath = path.join(dirPath, file);
        const stat = await fs.stat(filePath);
        if (stat.isDirectory()) {
          total += await this.getDirectorySize(filePath);
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
