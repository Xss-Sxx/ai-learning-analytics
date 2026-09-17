/* 端到端冒烟测试：验证核心填报流程 */
const BASE = process.env.BASE_URL || 'http://localhost:3000';

let passed = 0;
let failed = 0;

function check(name, ok, detail = '') {
  if (ok) {
    passed++;
    console.log(`PASS  ${name}`);
  } else {
    failed++;
    console.log(`FAIL  ${name}  ${detail}`);
  }
}

async function api(path, options = {}) {
  const res = await fetch(BASE + path, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }
  });
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch (_) { body = text; }
  return { status: res.status, body };
}

async function main() {
  const health = await api('/api/health');
  check('健康检查', health.status === 200 && health.body.status === 'healthy', JSON.stringify(health.body));

  const meta = await api('/api/meta');
  check('基础配置接口', meta.status === 200 && meta.body.success && meta.body.data.classes.length > 0, JSON.stringify(meta.body).slice(0, 200));

  const settings = await api('/api/settings');
  check('AI设置状态', settings.status === 200 && settings.body.success && ['offline', 'ai'].includes(settings.body.data.mode), JSON.stringify(settings.body).slice(0, 200));

  const students = await api('/api/students/overview');
  check('学生情况总览', students.status === 200 && students.body.success &&
    students.body.data.categories.length >= 5 && !!students.body.data.summary,
    JSON.stringify(students.body).slice(0, 300));

  const refreshStudents = await api('/api/students/refresh', { method: 'POST', body: '{}' });
  check('学生情况实时刷新', refreshStudents.status === 200 && refreshStudents.body.success, JSON.stringify(refreshStudents.body).slice(0, 200));

  const session = await api('/api/session', { method: 'POST', body: '{}' });
  check('创建会话', session.status === 200 && session.body.success && !!session.body.sessionId, JSON.stringify(session.body));
  const sessionId = session.body.sessionId;

  const msg = '初一(1)班 语文 胡芳老师 今天到课45人，缺勤2人，病假1人事假1人，课堂表现良好，作业完成43人，未完成2人，不会做，张三今天情绪低落';
  const collect = await api('/api/message', {
    method: 'POST',
    body: JSON.stringify({ sessionId, message: msg })
  });
  const data = collect.body.data || {};
  check('AI/规则提取学情', collect.status === 200 && collect.body.success &&
    data.class === '初一(1)班' && data.subject === '语文' && data.teacher === '胡芳' &&
    data.attendance === 45 && data.absent === 2,
    JSON.stringify(collect.body).slice(0, 400));

  const confirm = await api('/api/message', {
    method: 'POST',
    body: JSON.stringify({ sessionId, message: '确认' })
  });
  check('确认并生成Excel', confirm.status === 200 && confirm.body.success && confirm.body.state === 'completed' && confirm.body.action === 'completed',
    JSON.stringify(confirm.body).slice(0, 400));

  // --- 回归用例：历史缺陷防护 ---

  // 1) 闲聊不得写入学情记录（原缺陷：关键词过宽，"今天天气很好"被当成学情）
  const beforeChat = await api('/api/history');
  const beforeCount = (beforeChat.body.data || []).length;
  const chatSession = await api('/api/session', { method: 'POST', body: '{}' });
  const chatRes = await api('/api/message', {
    method: 'POST',
    body: JSON.stringify({ sessionId: chatSession.body.sessionId, message: '今天天气很好，我很开心' })
  });
  const afterChat = await api('/api/history');
  const afterCount = (afterChat.body.data || []).length;
  check('闲聊不写入学情记录', chatRes.status === 200 && afterCount === beforeCount,
    `before=${beforeCount} after=${afterCount}`);

  // 2) 表扬词中的"常好"不得被识别为学生（原缺陷：臆造姓名正则）
  const praiseRes = await api('/api/message', {
    method: 'POST',
    body: JSON.stringify({ sessionId: chatSession.body.sessionId, message: '初一(1)班课堂表现非常好，学生积极参与' })
  });
  const praiseConcerns = String((praiseRes.body.data || {}).concerns || '');
  check('表扬词不产生虚构学生', !praiseConcerns.includes('常好'),
    `concerns=${praiseConcerns}`);

  // 3) 教师姓名不得被记为学生（原缺陷：老师名同时在学生名单中）
  const teacherRes = await api('/api/message', {
    method: 'POST',
    body: JSON.stringify({ sessionId: chatSession.body.sessionId, message: '杨秀英今天表现非常好' })
  });
  const teacherConcerns = String((teacherRes.body.data || {}).concerns || '');
  check('教师姓名不记为需要关注学生', !teacherConcerns.includes('杨秀英'),
    `concerns=${teacherConcerns}`);

  // 4) 未说明缺勤人数时不得凭空推算（原缺陷：硬编码 50 人基数）
  const noAbsentSession = await api('/api/session', { method: 'POST', body: '{}' });
  await api('/api/message', {
    method: 'POST',
    body: JSON.stringify({ sessionId: noAbsentSession.body.sessionId, message: '初一(1)班数学张秀英老师，今天到课45人' })
  });
  const noAbsentRes = await api('/api/message', {
    method: 'POST',
    body: JSON.stringify({ sessionId: noAbsentSession.body.sessionId, message: '确认' })
  });
  const absentVal = (noAbsentRes.body.data || {}).absent;
  check('未说明缺勤时不凭空推算', absentVal === null || absentVal === undefined || absentVal === 0,
    `absent=${JSON.stringify(absentVal)}`);

  const history = await api('/api/history');
  check('历史记录查询', history.status === 200 && history.body.success && history.body.count >= 1, JSON.stringify(history.body).slice(0, 300));

  const todayStr = new Date().toISOString().slice(0, 10);
  const historyFiltered = await api(`/api/history?startDate=${todayStr}&endDate=${todayStr}`);
  check('历史记录日期筛选', historyFiltered.status === 200 && historyFiltered.body.success && historyFiltered.body.count >= 1, JSON.stringify(historyFiltered.body).slice(0, 300));

  const stats = await api('/api/stats');
  check('统计接口', stats.status === 200 && stats.body.success && typeof stats.body.data.totalReports === 'number', JSON.stringify(stats.body).slice(0, 300));

  const today = todayStr;
  const genToday = await api('/api/generate-today', { method: 'POST', body: '{}' });
  check('生成当日汇总Excel', genToday.status === 200 && genToday.body.success, JSON.stringify(genToday.body).slice(0, 300));

  const dl = await fetch(`${BASE}/api/download/${today}`);
  const dlBuf = Buffer.from(await dl.arrayBuffer());
  check('下载当日Excel', dl.status === 200 && dlBuf.length > 0 && dlBuf[0] === 0x50, `status=${dl.status} size=${dlBuf.length}`);

  const recordName = history.body.data[0] && history.body.data[0].fileName;
  if (recordName) {
    const rec = await api(`/api/record/${recordName}`);
    check('查看单条记录', rec.status === 200 && rec.body.success && rec.body.data.class === '初一(1)班', JSON.stringify(rec.body).slice(0, 200));

    const dlRec = await fetch(`${BASE}/api/download-record/${recordName}`);
    check('下载单条记录', dlRec.status === 200 && (await dlRec.arrayBuffer()).byteLength > 0, `status=${dlRec.status}`);
  } else {
    check('查看单条记录', false, '历史列表为空');
    check('下载单条记录', false, '历史列表为空');
  }

  console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(err => {
  console.error('测试执行异常:', err);
  process.exit(1);
});
