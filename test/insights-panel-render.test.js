// اختبار يعرض لوحة «نبراس يرى» فعليًا ببيانات وهمية، ثم يفحص الـHTML الناتج.
// الغرض: التقاط خطأ في التركيب أو في التهريب (escaping) أو في التوازن قبل النشر.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

// كتلة المؤشرات: من الثوابت حتى دالة النافذة
const insightsFns = (() => {
  const a = src.indexOf('const __insightAbsOpts');
  const b = src.indexOf('function __insightModal', a);
  assert.ok(a !== -1 && b > a, 'كتلة دوال المؤشرات غير موجودة');
  return src.slice(a, b);
})();

// كتلة بناء اللوحة: من seesInsights حتى إغلاق IIFE
const panelBuilder = (() => {
  const a = src.indexOf('const seesInsights =');
  assert.ok(a !== -1, 'كتلة بناء اللوحة غير موجودة');
  const b = src.indexOf('})();', a);
  assert.ok(b > a, 'نهاية كتلة اللوحة غير موجودة');
  return src.slice(a, b + 5);
})();

const DAY = 86400000;
const pad2 = (n) => String(n).padStart(2, '0');
const keyOf = (d) => d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());

function renderPanel(db, user){
  const html = [];
  const ctx = {
    console, Date, Math, Set, Map, Object, Array, Number, JSON,
    loadDB: () => db,
    __attIsAbsent: (r) => !!(r && r.status === 'ABSENT'),
    __attEffStatus: (rec) => (rec && rec.deleted) ? 'ABSENT' : (rec && rec.status === 'LATE' ? 'LATE' : (rec && rec.status === 'ABSENT' ? 'ABSENT' : 'PRESENT')),
    classLabel: (c) => (c ? c.name : '?'),
    escapeHtml: (v) => String(v == null ? '' : v).replace(/[&<>"']/g, ch => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[ch])),
    fmtDateOnly: (d) => String(d).slice(0, 10),
    // مؤشر غياب المعلمين يبني مفتاح تاريخ السنة الدراسية بنفس دالّة التطبيق
    localDateKey: (d) => d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()),
    todayStr: () => keyOf(new Date()),
    user,
    // «الأكثر تحويلاً» يعدّ ما تراه هذه المعلم فقط (القاعدة نفسها في الإنتاج)
    transferForMe: (t) => (user && user.role === 'ADMIN')
      || (!!t && !!user && String(t.createdBy) === String(user.id)),
    __cap: html,
    __insightAbsOpts: undefined,
  };
  // نُعرّف الثوابت والدوال ثم نبني اللوحة
  const code = insightsFns + '\n' + panelBuilder + '\n;globalThis.__panel = insightsHTML;';
  const vm = require('vm');
  vm.createContext(ctx);
  vm.runInContext(code, ctx);
  return ctx.__panel;
}

// جدول تواريخ الشهر الحالي
function monthDates(n){
  const now = new Date(), out = [];
  for (let i = 0; i < n; i++) out.push(keyOf(new Date(now.getFullYear(), now.getMonth(), 1 + i)));
  return out;
}
function absentRun(sid, n, step = 1){
  const now = new Date(), out = [];
  for (let i = 0; i < n; i++) out.push({ studentId: sid, date: keyOf(new Date(now.getFullYear(), now.getMonth(), 1 + i * step)), status: 'ABSENT' });
  return out;
}

const ADMIN = { id: 'A1', name: 'مديرة المدرسة', role: 'ADMIN' };
const TEACHER = { id: 'T1', name: 'معلم', role: 'TEACHER' };

function balancedDivs(html){
  const open = (html.match(/<div\b/g) || []).length;
  const close = (html.match(/<\/div>/g) || []).length;
  return { open, close, ok: open === close };
}

test('اللوحة تُبنى للمسؤول وتُحجب عن المعلم', () => {
  const db = { students: [], classes: [], attendance: [], transfers: [], users: [] };
  assert.ok(renderPanel(db, ADMIN).length, 'المسؤول يرى اللوحة');
  assert.equal(renderPanel(db, TEACHER), '', 'المعلم لا ترى اللوحة');
});

test('قاعدة فارغة: اللوحة تعرض حالة «لا شيء يحتاج متابعة»', () => {
  const db = { students: [], classes: [], attendance: [], transfers: [], users: [] };
  const h = renderPanel(db, ADMIN);
  assert.ok(h.includes('نبراس يرى'), 'العنوان');
  assert.ok(!h.includes('nbr-card'), 'لا بطاقات');
  assert.ok(balancedDivs(h).ok, 'div متوازنة');
});

test('بطاقات المؤشرات الأربعة تظهر ببياناتها', () => {
  const students = [
    { id: 'S1', fullName: 'طالب غياب', classId: 'C1', active: true },
    { id: 'S2', fullName: 'طالب تحويلات', classId: 'C1', active: true },
    { id: 'S3', fullName: 'طالب تأخر', classId: 'C1', active: true },
  ];
  const transfers = [1, 2, 3, 4].map(i => ({ id: 'T' + i, studentIds: ['S2'] }));
  const late = monthDates(12).map((d, i) => ({ studentId: 'S3', date: d, status: 'LATE' }));
  const db = {
    students, classes: [{ id: 'C1', name: 'أ' }],
    attendance: [...absentRun('S1', 11), ...late],
    transfers,
    users: [{ id: 'U1', name: 'معلم تأخر', role: 'TEACHER', active: true, markedLate: monthDates(6) }],
  };
  const h = renderPanel(db, ADMIN);
  assert.equal((h.match(/class="nbr-card"/g) || []).length, 4, 'أربع بطاقات');
  for (const label of ['غياب متكرر', 'تحويلات متكررة', 'تأخّر المعلمين', 'تأخّر الطلاب']){
    assert.ok(h.includes(label), 'بطاقة: ' + label);
  }
  assert.ok(balancedDivs(h).ok, 'div متوازنة: ' + JSON.stringify(balancedDivs(h)));
});

test('الأسماء تُهرَّب (لا حقن HTML من بيانات المستخدم)', () => {
  const evil = '<img src=x onerror=alert(1)>';
  const db = {
    students: [{ id: 'S1', fullName: evil, classId: 'C1', active: true }],
    classes: [{ id: 'C1', name: 'أ' }],
    attendance: absentRun('S1', 11), transfers: [], users: [],
  };
  const h = renderPanel(db, ADMIN);
  assert.ok(!h.includes('<img src=x'), 'الوسم الخام لا يظهر');
  assert.ok(h.includes('&lt;img'), 'ظهر مهرَّبًا');
  assert.ok(balancedDivs(h).ok, 'div متوازنة');
});

test('تاريخ اللوحة يأتي من مفتاح تاريخ لا من كائن Date', () => {
  // fmtDateOnly يقصّ أول 10 محارف: لو مرّرنا كائن Date لكان الناتج "Wed Sep 30 ..."
  // فطُبعت تواريخ إنجليزية داخل واجهة عربية. نتحقق أن الاستدعاء يمرّ بمفتاح.
  const srcPanel = src.slice(src.indexOf('const seesInsights ='));
  assert.ok(!/fmtDateOnly\(new Date\(\)\)/.test(srcPanel), 'لا تمرير كائن Date إلى fmtDateOnly');
  assert.ok(/fmtDateOnly\(todayStr\(\)\)/.test(srcPanel), 'يستخدم مفتاح التاريخ');
});

test('ألوان اللوحة تأتي من ثيم المدرسة (لا لون خاص بها)', () => {
  const cssStart = src.indexOf('/* ===== «نبراس يرى»');
  const cssEnd = src.indexOf('.dash-activity-item {', cssStart);
  assert.ok(cssStart !== -1 && cssEnd > cssStart, 'كتلة CSS للوحة غير موجودة');
  const css = src.slice(cssStart, cssEnd);
  const mkStart = src.indexOf('const seesInsights =');
  const mk = src.slice(mkStart, src.indexOf('// الأنشطة القادمة', mkStart));

  // 1) لا ألوان زرقاء قديمة (لون المرحلة السابقة قبل التحويل إلى الثيم الوردي)
  for (const old of ['#0f4678', '#1672c4', '#1e88d6', '#0f4f88', '#1d7fd6']){
    assert.ok(!css.includes(old) && !mk.includes(old), 'لا لون أزرق قديم: ' + old);
  }
  // 2) الهوية الوردية تأتي من المتغيّر لا من قيمة مكتوبة
  for (const v of ['--primary', '--accent']){
    assert.ok(css.includes('var(' + v), 'يستعمل var(' + v + ')');
  }
  // 3) درجة الاستحقاق للرقم من متغيّرات دلالية لا من hex مباشرة
  for (const v of ['--red', '--orange', '--purple']){
    assert.ok(mk.includes('var(' + v), 'الرقم يستعمل var(' + v + ')');
  }
  // 4) ألوان علب الأيقونات مطابقة للوحة «يحتاج إلى متابعتك» القائمة
  const existing = [...new Set([...src.matchAll(/color:'(#[0-9a-f]{6})'/g)].map(x => x[1]))];
  const mine = [...new Set([...mk.matchAll(/bg:'(#[0-9a-f]{6})'/g)].map(x => x[1]))];
  for (const c of mine) assert.ok(existing.includes(c), 'لون علبة الأيقونة مستعمل في اللوحة أصلًا: ' + c);

  // 5) نفس المتغيّر = نفس قيمة الاحتياط (اختلافها يوحي بإهمال حتى لو لم يظهر بصريًا)
  const byToken = {};
  for (const m of mk.matchAll(/var\((--[a-z-]+),(#[0-9a-f]{3,6})\)/g)){
    const [, tok, hex] = m;
    if (byToken[tok]) assert.equal(byToken[tok], hex, tok + ' له قيمتا احتياط مختلفتان');
    byToken[tok] = hex;
  }
});

test('كل بطاقة قابلة للنقر بمسار صحيح', () => {
  const db = {
    students: [{ id: 'S1', fullName: 'x', classId: 'C1', active: true }],
    classes: [{ id: 'C1', name: 'أ' }],
    attendance: absentRun('S1', 11), transfers: [], users: [],
  };
  const h = renderPanel(db, ADMIN);
  const clicks = [...h.matchAll(/onclick="([a-zA-Z]+)\(\)"/g)].map(x => x[1]);
  assert.ok(clicks.length > 0, 'يوجد onclick');
  for (const fn of clicks) assert.ok(new RegExp('function\\s+' + fn + '\\s*\\(').test(src), fn + ' معرَّف');
});

test('الأرقام المعروضة تطابق العدّ الفعلي', () => {
  // S1: 11 يومًا متتاليًا ← يتجاوز شرطي العدد والسلسلة (يظهر)
  // S2: 4 أيام متباعدة (أطول سلسلة 1) ← دون عتبة الـ5 فلا يظهر
  // فالفارق بينه وبين S1 هو العدد نفسه: 11 مقابل 4، والعتبة 5.
  const spread = (sid, offsets) => offsets.map((n, i) => ({
    studentId: sid, date: keyOf(new Date(new Date().getFullYear(), new Date().getMonth(), 1 + n)), status: 'ABSENT', _i: i,
  }));
  const db = {
    students: [
      { id: 'S1', fullName: 'متتالية', classId: 'C1', active: true },
      { id: 'S2', fullName: 'متباعدة', classId: 'C1', active: true },
    ],
    classes: [{ id: 'C1', name: 'أ' }],
    attendance: [...absentRun('S1', 11), ...spread('S2', [0, 3, 7, 11])],
    transfers: [], users: [],
  };
  const h = renderPanel(db, ADMIN);
  const nums = [...h.matchAll(/class="nbr-num"[^>]*>([^<]*)</g)].map(x => x[1]);
  assert.deepEqual(nums, ['1'], 'بطاقة واحدة فقط، والرقم 1');
});
