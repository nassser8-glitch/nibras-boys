// اختبارات قسم «نبراس يرى»: الغياب المتكرر والتحويلات المتكررة
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const INDEX = path.join(__dirname, '..', 'public', 'index.html');
const src = fs.readFileSync(INDEX, 'utf8');

// ن extract الكود من index.html: الثوابت + الدالتان + دالة longestRun المغلقة
function extractBlock(name, from, to){
  const s = src.indexOf(from);
  const e = src.indexOf(to, s);
  assert.ok(s !== -1, `لم يُعثر على بداية ${name}`);
  assert.ok(e > s, `لم يُعثر على نهاية ${name}`);
  return src.slice(s, e);
}

function extractInsightsCode(){
  // الكتلة كلها من الثوابت حتى دالة النافذة، فتُشمل كل دوال المؤشرات بلا استثناء
  return extractBlock('كتلة المؤشرات', 'const __insightAbsOpts', 'function __insightModal');
}

const DAY = 86400000;
// مفتاح تاريخ بمكوّنات محلية، كما يولّده todayStr في التطبيق.
// نتجنّب toISOString لأنه يحوّل إلى UTC فيُرجع اليوم السابق عند منتصف الليل
// على أجهزة متأخرة عن UTC، فتنكسر حسابات «الأيام المتتالية» بلا سبب حقيقي.
const pad2 = (n) => String(n).padStart(2, '0');
const keyOf = (d) => d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
const iso = (ms) => keyOf(new Date(ms));

function sandbox(db, { role = 'ADMIN', me = 't1' } = {}){
  const __tRole = role, __tMe = me;
  const context = {
    console,
    Date,
    Number,
    Set,
    Map,
    Object,
    Array,
    Math,
    __db: db,
    loadDB: () => db,
    // نسخة مبسّطة من القاعدة الفعلية: الغائب/المتأخر يفوز، وdeleted يُهمَل
    __attIsAbsent: (r) => !!(r && r.status === 'ABSENT'),
    __attEffStatus: (rec) => {
      if(!rec) return 'PRESENT';
      if(rec.deleted) return 'ABSENT';
      return rec.status === 'LATE' ? 'LATE' : (rec.status === 'ABSENT' ? 'ABSENT' : 'PRESENT');
    },
    classLabel: (c) => `${c ? c.name : '?'}`,
    // «الأكثر تحويلاً» يعدّ ما تراه المعلم فقط: RuleMatchesProduction
    // (الإشراف يسم الكل، والمعلم تحويلاتها هي). صفر = لا شيء مرئي.
    __currentUserRole: 'ADMIN',
    transferForMe: (t) => __tRole === 'ADMIN' || (t && String(t.createdBy) === String(__tMe)),
  };
  vm.createContext(context);
  vm.runInContext(extractInsightsCode() + '\n;globalThis.__r = __insightRepeatedAbsence; globalThis.__f = __insightFrequentTransfers; globalThis.__lt = __insightLateTeachers; globalThis.__ls = __insightLateStudents; globalThis.__ms = __insightMonthStart;', context);
  return {
    abs: (...a) => context.__r(...a),
    freq: (...a) => context.__f(...a),
    lateT: (...a) => context.__lt(...a),
    lateS: (...a) => context.__ls(...a),
    monthStart: (...a) => context.__ms(...a),
  };
}

// يبني سجل حضور: studentId -> عدد أيام غياب متتالية ابتداءً من اليوم
function attendanceRun(studentId, count, offsetDays = 0){
  const out = [];
  for(let i = 0; i < count; i++){
    out.push({ id:`A-${studentId}-${i}`, studentId, date: iso(Date.now() - (offsetDays + i) * DAY), status:'ABSENT' });
  }
  return out;
}

function mkStudent(id, name, classId){
  return { id, fullName:name, classId, active:true };
}

// ===== الغياب المتكرر =====

test('غياب 4 أيام متفرقة لا يُعدّ غيابًا متكررًا (تحت العتبة 5)', () => {
  const s1 = mkStudent('S1', 'طالب واحد', 'C1');
  const db = { students:[s1], classes:[{id:'C1', name:'أ'}], attendance: attendanceRun('S1', 4).map((a,i) => ({...a, date: iso(Date.now() - (i*2) * DAY)})), transfers:[] };
  const { abs } = sandbox(db);
  assert.equal(abs().length, 0, '4 أيام متفرقة دون 5 ولا سلسلة 5 — لا يظهر');
});

test('غياب 5 أيام متفرقة في آخر 30 يومًا يُظهر الطالب (العتبة 5 فأكثر)', () => {
  const s1 = mkStudent('S1', 'طالب متكرر', 'C1');
  const db = { students:[s1], classes:[{id:'C1', name:'أ'}], attendance: attendanceRun('S1', 5), transfers:[] };
  const { abs } = sandbox(db);
  const rows = abs();
  assert.equal(rows.length, 1, '5 أيام متفرقة تكفي عند العتبة 5');
  assert.equal(rows[0].total, 5);
  assert.equal(rows[0].run, 5, '5 أيام متتالية = سلسلة 5');
});

test('5 أيام متتالية فقط تكفي (أقل من 10 أيام إجمالًا)', () => {
  const s1 = mkStudent('S1', 'طالب متتالٍ', 'C1');
  const db = { students:[s1], classes:[{id:'C1', name:'أ'}], attendance: attendanceRun('S1', 5), transfers:[] };
  const { abs } = sandbox(db);
  const rows = abs();
  assert.equal(rows.length, 1, 'السلسلة المتتالية 5 أيام تكفي للظهور');
  assert.equal(rows[0].total, 5);
  assert.equal(rows[0].run, 5);
});

test('4 أيام متتالية + 3 متباعدة تظهر بالعتبة الجديدة (7 ≥ 5)', () => {
  const s1 = mkStudent('S1', 'طالب متوسط', 'C1');
  const dates = [0,1,2,3, 10, 20, 21].map(n => iso(Date.now() - n * DAY)); // 4 متتالية + 3 متباعدة = 7
  const db = { students:[s1], classes:[{id:'C1', name:'أ'}],
    attendance: dates.map((dte,i) => ({id:`A${i}`, studentId:'S1', date:dte, status:'ABSENT'})), transfers:[] };
  const { abs } = sandbox(db);
  const rows = abs();
  assert.equal(rows.length, 1, '7 أيام إجمالًا تتجاوز العتبة 5');
  assert.equal(rows[0].total, 7);
  assert.equal(rows[0].run, 4, 'أطول سلسلة 4 فقط — الظهور بسبب العدد لا التسلسل');
});

test('سلسلة متتالية 4 فقط مع 1 غياب متباعد = 5 إجمالًا تظهر بالعتبة 5', () => {
  const s1 = mkStudent('S1', 'طالب خمس', 'C1');
  const dates = [0,1,2,3, 10].map(n => iso(Date.now() - n * DAY)); // 4 متتالية + 1 متباعد = 5
  const db = { students:[s1], classes:[{id:'C1', name:'أ'}],
    attendance: dates.map((dte,i) => ({id:`A${i}`, studentId:'S1', date:dte, status:'ABSENT'})), transfers:[] };
  const { abs } = sandbox(db);
  const rows = abs();
  assert.equal(rows.length, 1, '5 أيام إجمالًا تكفي ولو لم تكن متتالية');
  assert.equal(rows[0].total, 5);
  assert.equal(rows[0].run, 4, 'أطول سلسلة 4 فقط');
});

test('غياب خارج نافذة 30 يومًا لا يُحتسب', () => {
  const s1 = mkStudent('S1', 'طالب قديم', 'C1');
  const old = attendanceRun('S1', 15, 40); // كله أقدم من 40 يومًا
  const db = { students:[s1], classes:[{id:'C1', name:'أ'}], attendance: old, transfers:[] };
  const { abs } = sandbox(db);
  assert.equal(abs().length, 0, 'لا يُحتسب غياب أقدم من 30 يومًا');
});

test('سجلّان لنفس الطالب في نفس اليوم لا يُضاعفان العدّ', () => {
  const s1 = mkStudent('S1', 'مكرر السجل', 'C1');
  const dte = iso(Date.now());
  const db = { students:[s1], classes:[{id:'C1', name:'أ'}],
    attendance: Array.from({length:12}, (_,i) => ({id:`A${i}`, studentId:'S1', date:i%2 ? dte : iso(Date.now() - (Math.floor(i/2)) * DAY), status:'ABSENT'})), transfers:[] };
  const { abs } = sandbox(db);
  const rows = abs();
  assert.equal(rows[0].total, 6, 'اليوم مكرّر مرتين فيجب أن يُحسب مرة واحدة (6 أيام فريدة، لا 12)');
});

test('طالب غير نشط أو غير موجود لا يظهر في الغياب المتكرر', () => {
  const db = { students:[], classes:[],
    attendance: attendanceRun('GONE', 12), transfers:[] };
  const { abs } = sandbox(db);
  assert.equal(abs().length, 0, 'لا يظهر طالب غير مسجّل');
});

test('سجلّ محذوف (deleted) يُتجاهل في عدّ الغياب', () => {
  const s1 = mkStudent('S1', 'طالب', 'C1');
  const att = attendanceRun('S1', 12).map((a,i) => i < 6 ? {...a, deleted:true} : a);
  const db = { students:[s1], classes:[{id:'C1', name:'أ'}], attendance: att, transfers:[] };
  const { abs } = sandbox(db);
  const rows = abs();
  assert.equal(rows[0].total, 6, '6 أيام غير محذوفة فقط');
});

// ===== التحويلات المتكررة =====

test('أكثر من 3 تحويلات لنفس الطالب تظهر (4 تحويلات)', () => {
  const s1 = mkStudent('S1', 'متحوّل كثير', 'C1');
  const transfers = [1,2,3,4].map(n => ({ id:`T${n}`, studentIds:['S1'], target:'COUNSELOR', createdAt: iso(Date.now()) }));
  const db = { students:[s1], classes:[{id:'C1', name:'أ'}], attendance:[], transfers };
  const { freq } = sandbox(db);
  const rows = freq();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].n, 4);
});

test('3 تحويلات بالضبط لا تظهر (العتبة أكثر من 3)', () => {
  const s1 = mkStudent('S1', 'ثلاثة تحويلات', 'C1');
  const transfers = [1,2,3].map(n => ({ id:`T${n}`, studentIds:['S1'], createdAt: iso(Date.now()) }));
  const db = { students:[s1], classes:[{id:'C1', name:'أ'}], attendance:[], transfers };
  const { freq } = sandbox(db);
  assert.equal(freq().length, 0, '3 لا تكفي — العتبة «أكثر من 3»');
});

test('تحويل بحقل studentId القديم (لا studentIds) يُحتسب', () => {
  const s1 = mkStudent('S1', 'قديم الحقل', 'C1');
  const transfers = [1,2,3,4,5].map(n => ({ id:`T${n}`, studentId:'S1', createdAt: iso(Date.now()) }));
  const db = { students:[s1], classes:[{id:'C1', name:'أ'}], attendance:[], transfers };
  const { freq } = sandbox(db);
  assert.equal(freq()[0].n, 5, 'studentId القديم مدعوم');
});

test('تحويل محذوف (deleted) لا يُحتسب', () => {
  const s1 = mkStudent('S1', 'تحويلات محذوفة', 'C1');
  const transfers = [1,2,3,4,5,6].map(n => ({ id:`T${n}`, studentId:'S1', deleted: n<=4, createdAt: iso(Date.now()) }));
  const db = { students:[s1], classes:[{id:'C1', name:'أ'}], attendance:[], transfers };
  const { freq } = sandbox(db);
  assert.equal(freq().length, 0, '6 تحويلات منها 4 محذوفة = 2 فعّالة، لا تظهر');
});

test('تحويل يغطي عدة طلاب يُنسب لكل واحد', () => {
  const s1 = mkStudent('S1', 'طالب أ', 'C1');
  const s2 = mkStudent('S2', 'طالب ب', 'C1');
  const transfers = [1,2,3,4].map(n => ({ id:`T${n}`, studentIds:['S1','S2'], createdAt: iso(Date.now()) }));
  const db = { students:[s1, s2], classes:[{id:'C1', name:'أ'}], attendance:[], transfers };
  const { freq } = sandbox(db);
  assert.equal(freq().length, 2, 'كل طالب عدّ 4 تحويلات');
});

test('الترتيب تنازلي بالأعلى عددًا', () => {
  const s1 = mkStudent('S1', 'قليل', 'C1');
  const s2 = mkStudent('S2', 'كثير جدًا', 'C1');
  const transfers = [
    { id:'T1', studentIds:['S1'] }, { id:'T2', studentIds:['S1'] },
    { id:'T3', studentIds:['S1'] }, { id:'T4', studentIds:['S1'] },
    { id:'T5', studentIds:['S2'] }, { id:'T6', studentIds:['S2'] },
    { id:'T7', studentIds:['S2'] }, { id:'T8', studentIds:['S2'] },
    { id:'T9', studentIds:['S2'] },
  ];
  const db = { students:[s1, s2], classes:[{id:'C1', name:'أ'}], attendance:[], transfers };
  const { freq } = sandbox(db);
  const rows = freq();
  assert.equal(rows.length, 2, 'كلاهما فوق العتبة (4 و5)');
  assert.equal(rows[0].id, 'S2', 'الأكثر تحويلات أولًا');
  assert.equal(rows[0].n, 5);
  assert.equal(rows[1].n, 4);
});

test('بداية الشهر تُحسب بالتقويم المحلي لا بـ UTC (الاختبار يعمل على أي منطقة زمنية)', () => {
  const { monthStart } = sandbox({ students:[], classes:[], attendance:[], transfers:[], users:[] });
  //Tz = UTC+9:Components المحلية لمنتصف ليل اليوم الأول = اليوم الأول محليًا،
  // بينما UTC-9 = اليوم الأول من الشهر السابق. فأي اعتماد على toISOString
  // سيعطي الشهر الخطأ هنا، وهذا ما نتحقق منه.
  assert.equal(monthStart(new Date(2026, 8, 1)), '2026-09-01', '1 سبتمبر');
  assert.equal(monthStart(new Date(2026, 0, 1)), '2026-01-01', 'يناير: شهر من رقم واحد يُ.padStart(2)');
  assert.equal(monthStart(new Date(2026, 11, 31)), '2026-12-01', 'ديسمبر: آخر يوم');
  assert.equal(monthStart(new Date(2027, 0, 1)), '2027-01-01', 'يناير 2027');
  // بلا معامل = الشهر الحالي بصيغة YYYY-MM-01
  assert.match(String(monthStart()), /^\d{4}-\d{2}-01$/, 'بلا معامل يعيد بداية الشهر الحالي');
  assert.equal(monthStart(new Date('nonsense')), null, 'تاريخ فاسد يعيد null');
});

test('قاعدة بيانات فارغة لا تنهار', () => {
  const db = { students:[], classes:[], attendance:[], transfers:[], users:[] };
  const { abs, freq, lateT, lateS } = sandbox(db);
  assert.deepEqual(abs(), []);
  assert.deepEqual(freq(), []);
  assert.deepEqual(lateT(), []);
  assert.deepEqual(lateS(), []);
});

// ===== تأخر المعلمين المتكرر (أكثر من 5 مرات في الشهر) =====

// يبني تواريخ أيام ماضية ضمن الشهر الحالي.
// نبنيها بمكوّنات التاريخ المحلية (كما يفعل todayStr في التطبيق)، لا عبر toISOString:
// فـtoISOString يحوّل إلى UTC فيُرجع اليوم السابق عند منتصف الليل على أجهزة
// متأخرة عن UTC، فتخرج مفاتيح خارج الشهر وتُحذف سهوًا.
function thisMonthDates(n, back = 0){
  const out = [];
  const now = new Date();
  for(let i = 0; i < n; i++){
    out.push(keyOf(new Date(now.getFullYear(), now.getMonth(), 1 + (i - back))));
  }
  return out;
}

function mkUser(id, name, role, markedLate){
  return { id, name, role, active:true, markedLate };
}

test('معلم تأخّرت 5 مرات بالضبط لا تظهر (العتبة أكثر من 5)', () => {
  const u = mkUser('U1', 'معلم خمسة', 'TEACHER', thisMonthDates(5));
  const db = { students:[], classes:[], attendance:[], transfers:[], users:[u] };
  const { lateT } = sandbox(db);
  assert.equal(lateT().length, 0, '5 مرات لا تكفي');
});

test('معلم تأخّرت 6 مرات تظهر', () => {
  const u = mkUser('U1', 'معلم ستة', 'TEACHER', thisMonthDates(6));
  const db = { students:[], classes:[], attendance:[], transfers:[], users:[u] };
  const { lateT } = sandbox(db);
  const rows = lateT();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].n, 6);
  assert.equal(rows[0].name, 'معلم ستة');
});

test('تأخر المعلم من الشهر الماضي لا يُحتسب في الشهر الحالي', () => {
  const now = new Date();
  const lastMonth = [];
  for(let i = 1; i <= 8; i++){
    lastMonth.push(iso(new Date(now.getFullYear(), now.getMonth() - 1, i).getTime()));
  }
  const u = mkUser('U1', 'معلم الشهر الماضي', 'TEACHER', lastMonth);
  const db = { students:[], classes:[], attendance:[], transfers:[], users:[u] };
  const { lateT } = sandbox(db);
  assert.equal(lateT().length, 0, 'تأخر الشهر الماضي لا يدخل عدّ هذا الشهر');
});

test('يوم تكراره في markedLate يُحسب مرة واحدة', () => {
  const dup = [...thisMonthDates(6), ...thisMonthDates(6)];
  const u = mkUser('U1', 'معلم مكررة', 'TEACHER', dup);
  const db = { students:[], classes:[], attendance:[], transfers:[], users:[u] };
  const { lateT } = sandbox(db);
  assert.equal(lateT()[0].n, 6, `6 أيام فريدة فقط (لا ${dup.length})`);
});

test('معلم غير نشطة لا تظهر، ومعلم COUNSELOR تظهر', () => {
  const off = mkUser('U1', 'موقوفة', 'TEACHER', thisMonthDates(9));
  off.active = false;
  const coun = mkUser('U2', 'موجهة', 'COUNSELOR', thisMonthDates(7));
  const db = { students:[], classes:[], attendance:[], transfers:[], users:[off, coun] };
  const { lateT } = sandbox(db);
  const rows = lateT();
  assert.equal(rows.length, 1, 'غير النشطة مستبعدة');
  assert.equal(rows[0].name, 'موجهة');
});

test('مدير/وكيل ليس معلم — لا يظهر ضمن تأخر المعلمين', () => {
  const admin = mkUser('U1', 'مدير', 'ADMIN', thisMonthDates(12));
  const agent = mkUser('U2', 'وكيل', 'AGENT', thisMonthDates(12));
  const db = { students:[], classes:[], attendance:[], transfers:[], users:[admin, agent] };
  const { lateT } = sandbox(db);
  assert.equal(lateT().length, 0, 'الإدارة ليست ضمن الكادر التعليمي');
});

test('معلم بلا markedLate لا تنهار عند غياب الحقل', () => {
  const u = { id:'U1', name:'بلا حقل', role:'TEACHER', active:true };
  const db = { students:[], classes:[], attendance:[], transfers:[], users:[u] };
  const { lateT } = sandbox(db);
  assert.equal(lateT().length, 0);
});

// ===== تأخر الطلاب المتكرر (أكثر من 10 مرات في الشهر) =====

function lateStudentAttendance(studentId, n){
  return thisMonthDates(n).map((dte, i) => ({ id:`L${i}`, studentId, date:dte, status:'LATE' }));
}

test('طالب تأخّرت 4 مرات لا تظهر (دون العتبة 5)', () => {
  const s = mkStudent('S1', 'طالب أربع', 'C1');
  const db = { students:[s], classes:[{id:'C1', name:'أ'}], attendance: lateStudentAttendance('S1', 4), transfers:[], users:[] };
  const { lateS } = sandbox(db);
  assert.equal(lateS().length, 0, '4 مرات دون 5 — لا تظهر');
});

test('طالب تأخّرت 5 مرات بالضبط تظهر (العتبة 5 فأكثر، حدّ مغلق)', () => {
  // هذا هو الحدّ المطلوب: سابقًا كان الشرط n <= lim فيسقط 5 بالضبط لأن العتبة 10.
  const s = mkStudent('S1', 'طالب خمس', 'C1');
  const db = { students:[s], classes:[{id:'C1', name:'أ'}], attendance: lateStudentAttendance('S1', 5), transfers:[], users:[] };
  const { lateS } = sandbox(db);
  const rows = lateS();
  assert.equal(rows.length, 1, '5 مرات بالضبط تكفي للظهور');
  assert.equal(rows[0].n, 5);
});

test('طالب تأخّرت 11 مرة تظهر', () => {
  const s = mkStudent('S1', 'طالب أحد عشر', 'C1');
  const db = { students:[s], classes:[{id:'C1', name:'أ'}], attendance: lateStudentAttendance('S1', 11), transfers:[], users:[] };
  const { lateS } = sandbox(db);
  const rows = lateS();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].n, 11);
});

test('يوم غياب فيه لا يُحتسب تأخّرًا (العدّ على أيام التأخّر وحدها)', () => {
  // في البيانات الحقيقية سجلٌّ واحد لكل طالب/يوم بعد الدمج (__attWinner)،
  // فاليوم إمّا غائب أو متأخر. هنا 5 أيام: الأول غياب، والباقي 4 تأخّرًا فقط.
  const s = mkStudent('S1', 'طالب مختلطة', 'C1');
  const days = thisMonthDates(5);
  const att = days.map((dte, i) => ({ id:`L${i}`, studentId:'S1', date:dte, status: i === 0 ? 'ABSENT' : 'LATE' }));
  const db = { students:[s], classes:[{id:'C1', name:'أ'}], attendance: att, transfers:[], users:[] };
  const { lateS } = sandbox(db);
  assert.equal(lateS().length, 0, '4 أيام تأخّر فقط — دون عتبة 5');
});

test('يوم تأخّر مكرّر لنفس الطالب يُحسب مرة واحدة', () => {
  const s = mkStudent('S1', 'طالب مكررة', 'C1');
  const days = thisMonthDates(11);
  const att = [
    ...days.map((dte, i) => ({ id:`L${i}`, studentId:'S1', date:dte, status:'LATE' })),
    ...days.slice(0, 4).map((dte, i) => ({ id:`D${i}`, studentId:'S1', date:dte, status:'LATE' })), // تكرار
  ];
  const db = { students:[s], classes:[{id:'C1', name:'أ'}], attendance: att, transfers:[], users:[] };
  const { lateS } = sandbox(db);
  const rows = lateS();
  assert.equal(rows.length, 1, '11 يومًا فريدة تتجاوز العتبة');
  assert.equal(rows[0].n, 11, `التكرار لا يُضاعف العدّ: 11 يومًا فريدة من 15 سجلًّا (لا 15)`);
});

test('تأخر من الشهر الماضي لا يدخل عدّ الطلاب', () => {
  const s = mkStudent('S1', 'طالب قديمة', 'C1');
  const now = new Date();
  const att = [];
  for(let i = 1; i <= 15; i++) att.push({ id:`L${i}`, studentId:'S1', date: iso(new Date(now.getFullYear(), now.getMonth()-1, i).getTime()), status:'LATE' });
  const db = { students:[s], classes:[{id:'C1', name:'أ'}], attendance: att, transfers:[], users:[] };
  const { lateS } = sandbox(db);
  assert.equal(lateS().length, 0);
});

test('سجل تأخّر محذوف (deleted) يُستبعد', () => {
  const s = mkStudent('S1', 'طالب محذوفات', 'C1');
  const att = lateStudentAttendance('S1', 8).map((a, i) => i < 4 ? { ...a, deleted:true } : a);
  const db = { students:[s], classes:[{id:'C1', name:'أ'}], attendance: att, transfers:[], users:[] };
  const { lateS } = sandbox(db);
  assert.equal(lateS().length, 0, '8 منها 4 محذوفة = 4 دون العتبة 5');
});

test('طالب غير نشطة لا تظهر في تأخر الطلاب', () => {
  const s = { id:'S1', fullName:'موقوفة', classId:'C1', active:false };
  const db = { students:[s], classes:[{id:'C1', name:'أ'}], attendance: lateStudentAttendance('S1', 15), transfers:[], users:[] };
  const { lateS } = sandbox(db);
  assert.equal(lateS().length, 0);
});

test('الترتيب تنازلي بعدد مرات التأخّر', () => {
  const s1 = mkStudent('S1', 'أقل', 'C1');
  const s2 = mkStudent('S2', 'أكثر', 'C1');
  const db = { students:[s1, s2], classes:[{id:'C1', name:'أ'}],
    attendance: [...lateStudentAttendance('S1', 11), ...lateStudentAttendance('S2', 14)], transfers:[], users:[] };
  const { lateS } = sandbox(db);
  const rows = lateS();
  assert.equal(rows[0].id, 'S2');
  assert.equal(rows[0].n, 14);
  assert.equal(rows[1].n, 11);
});

test('عتبة مخصّصة تُحترم (بديل تجريبي)', () => {
  const s = mkStudent('S1', 'طالب', 'C1');
  const db = { students:[s], classes:[{id:'C1', name:'أ'}], attendance: lateStudentAttendance('S1', 3), transfers:[], users:[] };
  const { lateS } = sandbox(db);
  assert.equal(lateS().length, 0, 'لا تظهر بالعتبة الافتراضية 10');
  assert.equal(lateS(2).length, 1, 'تظهر بعتبة 2');
});

test('المؤشران يعملان معًا ولا يتداخلان', () => {
  const s = mkStudent('S1', 'طالب', 'C1');
  const u = mkUser('U1', 'معلم', 'TEACHER', thisMonthDates(8));
  const db = { students:[s], classes:[{id:'C1', name:'أ'}], attendance: lateStudentAttendance('S1', 12), transfers:[], users:[u] };
  const { lateT, lateS } = sandbox(db);
  assert.equal(lateT().length, 1, 'المعلم تظهر');
  assert.equal(lateS().length, 1, 'الطالب تظهر');
  assert.equal(lateT()[0].id, 'U1');
  assert.equal(lateS()[0].id, 'S1');
});
