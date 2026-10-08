/* «نبراس يرى» لم يعرض غياب المعلمين الذين تجاوزوا 3 أيام.
 *
 * المؤشرات الأربعة قائمة كلها: غياب الطلاب والتحويلات وتأخر المعلمين
 * وتأخر الطلاب — ولا شيء لغياب المعلمين، فكان متابعُ لوحة التحليلات
 * يرى غياب الطلاب المزدحمًا ولا يرى معلمًا غاب 21 يومًا.
 *
 * الإصلاح مؤشرٌ خامس مستقل: عتبته 3 أيام لا 5 (عتبة الطلاب)، ومعطروه
 * السنة الدراسية لا آخر 30 يومًا لأن teacher.absences سجلٌّ سنويّ. ومصدره
 * teacher.absences نفسه الذي يقرؤه تنبيهُ المعلم، فالرقم واحد للطرفين.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const DAY = 86400000;

function sliceBetween(src, start, end){
  const i = src.indexOf(start);
  assert.ok(i >= 0, 'لم يُعثر على: ' + start);
  const j = end ? src.indexOf(end, i + start.length) : src.length;
  return src.slice(i, j >= 0 ? j : src.length);
}

/* نبني سياقًا حقيقيًا: دوالّ الشيفرة نفسها + loadDB وهمية نملك محتواها.
   لا نُعد كتابة المنطق تحت الاختبار، وإلا اختبرنا نسختنا لا نسخة التطبيق. */
function ctx(d){
  const SRC = [
    'const loadDB = () => __D;',
    'function escapeHtml(s){ return String(s == null ? "" : s).replace(/&/g,"&amp;"); }',
    sliceBetween(HTML, 'function localDateKey(', '\nfunction '),
    sliceBetween(HTML, 'const ABSENT_WARN_DAYS =', ';'),
    sliceBetween(HTML, 'const __insightTeacherAbsThreshold =', ';'),
    sliceBetween(HTML, 'function __insightTeacherAbsence(', '\n/* '),
  ].join('\n');
  return new Function('__D', SRC +
    '\nreturn { __insightTeacherAbsence, ABSENT_WARN_DAYS, __insightTeacherAbsThreshold };')(d);
}

function schoolYearStartKey(){
  const now = new Date();
  const ys = now.getMonth() >= 8 ? new Date(now.getFullYear(), 8, 1) : new Date(now.getFullYear()-1, 8, 1);
  return {
    ldk: (dt) => dt.getFullYear() + '-' + String(dt.getMonth() + 1).padStart(2, '0') + '-' + String(dt.getDate()).padStart(2, '0'),
    ys, now,
  };
}

function teacher(id, absences, over){
  return Object.assign({ id, name:'معلم ' + id, role:'TEACHER', active:true, absences }, over || {});
}

test('العتبة 3 أيام ومشتركة بين التحليلات وتنبيه المعلم', () => {
  const c = ctx({ users: [] });
  assert.equal(c.ABSENT_WARN_DAYS, 3, 'المطلوب: تجاوز 3 أيام');
  assert.equal(c.__insightTeacherAbsThreshold, c.ABSENT_WARN_DAYS,
    'مؤشر المدير وتنبيه المعلم لا يجوز أن يختلفا رقمًا');
});

test('غياب 3 أيام لا يظهر، وغياب 4 يظهر', () => {
  const { ldk, ys, now } = schoolYearStartKey();
  const d4 = []; for(let i = 0; i < 4; i++) d4.push(ldk(new Date(ys.getTime() + i * DAY)));
  const d3 = d4.slice(0, 3);
  const today = ldk(now);
  // السنة الدراسية قد لا يمضِ عليها 4 أيام بعد؛ حينها نتجاوز الدعاء لا نفشل
  if(d4[3] > today){
    return; /* الأسبوع الأول من السنة الدراسية: لا يمكن 4 أيام بعد */
  }
  const c3 = ctx({ users: [teacher('T1', d3)] });
  const c4 = ctx({ users: [teacher('T1', d4)] });
  assert.equal(c3.__insightTeacherAbsence().length, 0,
    '3 أيام لم تتجاوز الحدّ فلا تظهر في المؤشر');
  assert.equal(c4.__insightTeacherAbsence().length, 1,
    '4 أيام تجاوزت الحدّ فتظهر');
  assert.equal(c4.__insightTeacherAbsence()[0].n, 4, 'والعدد 4 لا غير');
});

test('يقرأ من teacher.absences لا من حقل آخر', () => {
  const { ldk, ys, now } = schoolYearStartKey();
  const d4 = []; for(let i = 0; i < 4; i++) d4.push(ldk(new Date(ys.getTime() + i * DAY)));
  if(d4[3] > ldk(now)) return; /* الأسبوع الأول من السنة الدراسية */
  // نفس حقل التنبيه: لو كُتب على كائن الجلسة لأظهر الأصفار
  const c = ctx({ users: [Object.assign(teacher('T1', d4), { absences: undefined })] });
  assert.equal(c.__insightTeacherAbsence().length, 0, 'بدون الحقل لا شيء — لا قيمة مُفترضة');
});

test('الغياب خارج السنة الدراسية لا يُحتسب', () => {
  const { ldk, now } = schoolYearStartKey();
  const lastYear = ldk(new Date(now.getFullYear() - 1, 0, 5)); // 5 يناير الماضي
  const future = ldk(new Date(now.getTime() + 40 * DAY));
  const c = ctx({ users: [teacher('T1', [lastYear, future])] });
  assert.equal(c.__insightTeacherAbsence(1).length, 0,
    'غيابٌ من سنة سابقة أو من مستقبل لا يدخل في سنة الدراسية');
});

test('اليوم المكرر يُحسب مرة واحدة', () => {
  const { ldk, ys, now } = schoolYearStartKey();
  const d4 = []; for(let i = 0; i < 4; i++) d4.push(ldk(new Date(ys.getTime() + i * DAY)));
  if(d4[3] > ldk(now)) return; /* الأسبوع الأول من السنة الدراسية */
  const c = ctx({ users: [teacher('T1', [d4[0], d4[0], d4[1], d4[1], d4[2], d4[3]])] });
  const rows = c.__insightTeacherAbsence();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].n, 4, 'كرّارُ اليوم لا يضخّم العدّ');
});

test('الطلاب والمعلمين غير النشطات والدورات الأخرى خارج النطاق', () => {
  const { ldk, ys, now } = schoolYearStartKey();
  const d4 = []; for(let i = 0; i < 4; i++) d4.push(ldk(new Date(ys.getTime() + i * DAY)));
  if(d4[3] > ldk(now)) return; /* الأسبوع الأول من السنة الدراسية */
  const d = { users: [
    { id:'S1', name:'طالب', role:'STUDENT', active:true, absences:d4 },
    { id:'A1', name:'مديرة', role:'ADMIN', active:true, absences:d4 },
    { id:'T2', name:'معلم موقوفة', role:'TEACHER', active:false, absences:d4 },
    teacher('T1', d4),
  ] };
  const rows = ctx(d).__insightTeacherAbsence();
  assert.equal(rows.length, 1, 'الغير نشطة أو غير معلم لا تدخل');
  assert.equal(rows[0].id, 'T1');
});

test('الترتيب: الأكثر غيابًا أولًا', () => {
  const { ldk, ys, now } = schoolYearStartKey();
  const d = []; for(let i = 0; i < 8; i++) d.push(ldk(new Date(ys.getTime() + i * DAY)));
  if(d[7] > ldk(now)) return; /* الأسبوع الأول من السنة الدراسية */
  const rows = ctx({ users: [teacher('T1', d.slice(0,4)), teacher('T2', d)] })
    .__insightTeacherAbsence();
  assert.deepEqual(rows.map(r => r.id), ['T2', 'T1']);
});

test('اللوحة تعرض بطاقة «غياب المعلمين» متصلة بالمؤشر والنموذج', () => {
  const block = sliceBetween(HTML, '${isTeacher ? (() => {', '${bottom}');
  // بطاقة «نبراس يرى»: نأخذ منطاد التحليلات نفسه لا كتلة المعلم
  const insight = sliceBetween(HTML, 'const insightsHTML = (() => {', '${insightsHTML}');
  assert.ok(insight.includes('const absentTeachers = __insightTeacherAbsence();'),
    'اللوحة تستدعي المؤشر فعلاً');
  assert.ok(insight.includes("name:'غياب المعلمين'"), 'البطاقة موجودة');
  assert.ok(insight.includes("click:'showTeacherAbsence()'"), 'ونقرها يفتح التفاصيل');
  assert.ok(/if\(absentTeachers\.length\)/.test(insight),
    'وتظهر عند وجود معلومات فقط لا كبطاقة فارغة');
  assert.ok(block.length > 0, 'كتلة المعلم موجودة (لا يُكسر النصّ)');
});

test('شريط المؤشرات صار 5 لا 4، ويشير إلى عتبة المعلم', () => {
  const insight = sliceBetween(HTML, 'const insightsHTML = (() => {', '${insightsHTML}');
  assert.ok(/const TOTAL_IND = 5;/.test(insight), 'الحدّ الأقصى 5 مؤشرات');
  assert.ok(!/من 4 مؤشرات/.test(insight), 'لم يبقَ نصٌّ قديم يقول «4 مؤشرات»');
  assert.ok(/غياب معلم \$\{ABSENT_WARN_DAYS \+ 1\}\+/.test(insight),
    'الحاشية تذكر عتبة المعلم كما تذكر عتبات البقية');
});

test('النموذج التفصيلي موجود ويشرح العتبة', () => {
  assert.ok(/function showTeacherAbsence\(\)/.test(HTML), 'الدالة موجودة');
  const src = sliceBetween(HTML, 'function showTeacherAbsence()', 'function showLateStudents()');
  assert.ok(src.includes('__insightTeacherAbsence()'), 'تقرأ المؤشر نفسه لا نسخته');
  assert.ok(src.includes('__insightModal('), 'وتفتح النافذة');
  assert.ok(src.includes('${ABSENT_WARN_DAYS}'), 'وتشرح العتبة بقيمتها لا برقم مكتوب');
  assert.ok(!/[\u0400-\u04FF\u4e00-\u9fff]/.test(src), 'لا حروف غريبة');
});

test('الملف سليم من حروف خارج العربية', () => {
  assert.ok(!/[\u0400-\u04FF\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(HTML), 'لا سيريلية ولا صينية ولا كورية');
  assert.ok(!HTML.includes('\uFFFD'), 'لا محرف تالف');
});
