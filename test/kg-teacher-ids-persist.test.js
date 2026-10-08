'use strict';
// regression: إسناد معلم إلى الفصل kg_g0_a يجب أن يبقى محفوظًا بعد الحفظ والمزامنة.
//
// السبب الذي عالجناه: في __syncPush كان قسم classes يمرّ عبر locallyOnly، وهي
//   for(x of lArr){ if(!seen.has(id)) out.push(x) }        // public/index.html
// أي أن نسخة الخادم تبقى كاملةً-Edits يُهمَل كل ما لا يحمل id غائبًا. فإضافة معلم
//   عبر addTeacherToClass  =>  cls.teacherIds.push(teacherId)  =>  saveDB
// كانت تُمحى من الدفعة قبل PUT، وظل teacherIds الخاص بالخادم هو الفائز إلى الأبد.
// والخادم لم يكن السبب: mergeClasses يدمج teacherIds اتحادًا بشكل صحيح، لكنه لا
// يستلم المُدخَل أصلًا لأن العميل أسقطه.
//
// الاختبار يسحب الدوال حرفيًا من كود الإنتاج (لا نسخة مبسّطة) ويمرّر عليها البيانات
// نفسها التي يمرّ بها الإنتاج:  العميل (mergeClassesLocal) ← PUT (mergeClasses) ←
// الحارس (dedupeClasses).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const SERVER = path.join(__dirname, '..', 'server.js');
const INDEX = path.join(__dirname, '..', 'public', 'index.html');
const serverSrc = fs.readFileSync(SERVER, 'utf8');
const indexSrc = fs.readFileSync(INDEX, 'utf8');

const deep = (o) => JSON.parse(JSON.stringify(o));

/* ---------- استخراج دالة من المصدر نصًّا كما هي ---------- */
function extract(src, name) {
  const i = src.search(new RegExp('(async\\s+)?function\\s+' + name + '\\s*\\('));
  assert.ok(i >= 0, 'لم يُعثر على ' + name + ' في المصدر');
  let d = 0, started = false;
  for (let k = src.indexOf('{', i); k < src.length; k++) {
    if (src[k] === '{') { d++; started = true; }
    else if (src[k] === '}') { d--; if (started && d === 0) return src.slice(i, k + 1); }
  }
  throw new Error('نهاية غير متوازنة لـ ' + name);
}

// دوال الخادم: تُعرَّف كدوال حقيقية عبر eval على نطاق معزول
const mergeClasses = new Function(extract(serverSrc, 'mergeClasses') + '; return mergeClasses;')();
const dedupeClasses = new Function(extract(serverSrc, 'dedupeClasses') + '; return dedupeClasses;')();

// دالة العميل: دالة علوية مشتركة بين __syncPush و __syncPull، فنستخرجها بنفس extract
const mergeClassesLocal = new Function(extract(indexSrc, 'mergeClassesLocal') + '; return mergeClassesLocal;')();
assert.ok(mergeClassesLocal(1, 2), 'mergeClassesLocal استُخرج');

/* ---------- أدوات ---------- */
const KG = 'kg_g0_a';
const T1 = 'id_teacher_1';
const T2 = 'id_teacher_2';
const OTHER = 'b_g1_a';

const baseData = () => ({
  grades: [{ id: 'kg_g0', name: 'التمهيدي', order: -1 }, { id: 'b_g1', name: 'الأول الابتدائي', order: 0 }],
  classes: [
    { id: KG, gradeId: 'kg_g0', name: 'أ', campus: 'BOYS', teacherIds: [] },
    { id: OTHER, gradeId: 'b_g1', name: 'أ', campus: 'BOYS', teacherIds: ['id_teacher_9'] },
  ],
  students: [{ id: 's1', classId: KG, active: true }],
});

/* ---------- 1) مس client's alone: the bug itself ---------- */
test('قبل الإصلاح كان locallyOnly يُسقط الإسناد — proof of the bug', () => {
  const server = baseData();
  const local = deep(server);
  local.classes.find(c => c.id === KG).teacherIds.push(T1);   // addTeacherToClass

  // سلوك locallyOnly القديم (نسخة من السلوك، للتوثيق فقط)
  const oldLocallyOnly = (lArr, sArr) => {
    const out = sArr.slice();
    const seen = new Set(out.map(x => (x && x.id != null) ? x.id : JSON.stringify(x)));
    for (const x of lArr) { const k = (x.id != null) ? x.id : JSON.stringify(x); if (!seen.has(k)) { out.push(deep(x)); seen.add(k); } }
    return out;
  };
  const outOld = oldLocallyOnly(local.classes, server.classes);
  assert.ok(!outOld.find(c => c.id === KG).teacherIds.includes(T1),
    'السلوك القديم يفقد الإسناد (وهو ما نصلحه)');
});

/* ---------- 2) العميل بعد الإصلاح: الإسناد ينجو ---------- */
test('mergeClassesLocal: إسناد معلم إلى kg_g0_a ينجو', () => {
  const server = baseData();
  const local = deep(server);
  local.classes.find(c => c.id === KG).teacherIds.push(T1);

  const out = mergeClassesLocal(local.classes, server.classes);
  const kg = out.find(c => c.id === KG);
  assert.ok(kg.teacherIds.includes(T1), 'المعلم الجديدة في قائمة الفصل');
  assert.equal(kg.teacherIds.length, 1, 'لم تُضف نسخة مكررة');
});

/* ---------- 3) الإضافة تضيف ولا تستبدل ---------- */
test('mergeClassesLocal: إضافة معلم ثانية تضيف ولا تستبدل القائمة', () => {
  const server = baseData();
  const after1 = deep(server);
  after1.classes.find(c => c.id === KG).teacherIds.push(T1);

  const local = deep(after1);
  local.classes.find(c => c.id === KG).teacherIds.push(T2);

  const out = mergeClassesLocal(local.classes, after1.classes);
  const kg = out.find(c => c.id === KG);
  assert.ok(kg.teacherIds.includes(T1), 'المعلم الأولى باقية');
  assert.ok(kg.teacherIds.includes(T2), 'المعلم الثانية أُضيفت');
  assert.equal(kg.teacherIds.length, 2);
});

/* ---------- 4) idempotence: لا تكرار عبر دورات متكررة ---------- */
test('mergeClassesLocal: تكرار الدفع لا يضاعف teacherIds', () => {
  const server = baseData();
  let cur = deep(server);
  cur.classes.find(c => c.id === KG).teacherIds.push(T1);
  for (let i = 0; i < 5; i++) cur.classes = mergeClassesLocal(deep(cur.classes), cur.classes);
  assert.equal(cur.classes.find(c => c.id === KG).teacherIds.length, 1);
});

/* ---------- 5) المسار الكامل: عميل ← mergeClasses (PUT) ← dedupeClasses ---------- */
test('المسار الكامل للإنتاج: kg_g0_a يبقى غير محذوف ويحتفظ بالمعلم', () => {
  const serverData = baseData();

  // 1) جهاز المدير: يضيف معلم
  const local = deep(serverData);
  local.classes.find(c => c.id === KG).teacherIds.push(T1);

  // 2) __syncPush (بعد الإصلاح)
  const pushed = deep(serverData);
  pushed.classes = mergeClassesLocal(local.classes, serverData.classes);

  // 3) الخادم: PUT يستدعي mergeClasses ثم dedupeClasses (ترتيب server.js)
  const stored = deep(serverData);
  stored.classes = mergeClasses(stored.classes, pushed.classes);
  dedupeClasses(stored);

  const kg = stored.classes.find(c => c.id === KG);
  assert.ok(kg, 'الفصل موجود');
  assert.notEqual(kg.deleted, true, 'الفصل لم يُدفن');
  assert.ok(kg.teacherIds.includes(T1), 'teacherIds ما زالت تحمل المعلم بعد PUT كامل');
});

/* ---------- 6) لا إحياء لفصل محذوف عمداً ---------- */
test('قبر مقصود على الخادم لا يُحى من جهاز', () => {
  const serverData = baseData();
  serverData.classes.find(c => c.id === KG).deleted = true;   // المدير حذفه عمداً

  const local = deep(serverData);
  delete local.classes.find(c => c.id === KG).deleted;        // جهاز قديم لا يزال يحمله
  local.classes.find(c => c.id === KG).teacherIds.push(T1);

  const pushed = deep(serverData);
  pushed.classes = mergeClassesLocal(local.classes, serverData.classes);
  const stored = deep(serverData);
  stored.classes = mergeClasses(stored.classes, pushed.classes);
  dedupeClasses(stored);

  assert.equal(stored.classes.find(c => c.id === KG).deleted, true, 'يبقى محذوفاً');
});

/* ---------- 7) لا إحياء لفصل محجوب في _blockedClasses ---------- */
test('الفصل المحجوب يبقى محذوفاً من الحِمل (يحاكي server.js:1875)', () => {
  const serverData = baseData();
  serverData._blockedClasses = [KG];
  const incoming = deep(serverData);
  incoming.classes = incoming.classes.filter(c => !serverData._blockedClasses.includes(c.id));
  assert.equal(incoming.classes.some(c => c.id === KG), false, 'أُزيل من الحِمل');
});

/* ---------- 8) الإزالة المقصودة تبقى محترمة ---------- */
test('إزالة معلم عبر removedTeacherIds تُحترم', () => {
  const server = baseData();
  server.classes.find(c => c.id === KG).teacherIds = [T1];
  const local = deep(server);
  local.classes.find(c => c.id === KG).teacherIds = [];
  local.classes.find(c => c.id === KG).removedTeacherIds = [T1];

  const out = mergeClassesLocal(local.classes, server.classes);
  const kg = out.find(c => c.id === KG);
  assert.ok(!kg.teacherIds.includes(T1), 'أُزيلت');
  assert.ok(kg.removedTeacherIds.includes(T1), 'سجل الإزالة باقٍ');
});

/* ---------- 9) إعادة إسناد مقصودة تتغلّب على سجل الإزالة ---------- */
test('إعادة إسناد معلم محذوف تنجح (مطابقة server.js:1324-1326)', () => {
  const server = baseData();
  server.classes.find(c => c.id === KG).teacherIds = [];
  server.classes.find(c => c.id === KG).removedTeacherIds = [T1];
  const local = deep(server);
  local.classes.find(c => c.id === KG).teacherIds = [T1];

  const out = mergeClassesLocal(local.classes, server.classes);
  const kg = out.find(c => c.id === KG);
  assert.ok(kg.teacherIds.includes(T1), 'أُعيد إسناده');
  assert.ok(!kg.removedTeacherIds.includes(T1), 'أُزيل من سجل الإزالة');
});

/* ---------- 10) الفصول الأخرى غير متأثرة ---------- */
test('الفصول الأخرى لم تتأثر', () => {
  const server = baseData();
  const local = deep(server);
  local.classes.find(c => c.id === KG).teacherIds.push(T1);

  const out = mergeClassesLocal(local.classes, server.classes);
  assert.equal(out.length, server.classes.length, 'العدد كما هو');
  const other = out.find(c => c.id === OTHER);
  assert.deepEqual(other, server.classes.find(c => c.id === OTHER), 'الفصل الآخر مطابق حرفياً');
});

/* ---------- 11) نظام الطلاب لم يُمَسّ ---------- */
test('لا مساس بقسم الطلاب', () => {
  const server = baseData();
  const local = deep(server);
  local.classes.find(c => c.id === KG).teacherIds.push(T1);
  const out = mergeClassesLocal(local.classes, server.classes);
  assert.deepEqual(local.students, server.students, 'الطلاب لم يتغيّروا في أي مرحلة');
});

/* ---------- 12) dedupeClasses لم تعد تدفن فصلًا صفّه موجود ---------- */
test('dedupeClasses: لا تدفن فصلًا صفّه محفوظ (تطابق بالمعرّف)', () => {
  const d = baseData();
  dedupeClasses(d);
  assert.notEqual(d.classes.find(c => c.id === KG).deleted, true);
});

test('dedupeClasses: لا تدفن فصلًا صفّه محفوظ بمعرّف مختلف', () => {
  const d = baseData();
  d.grades = d.grades.map(g => (g.id === 'kg_g0' ? { id: 'kg_legacy_77', name: g.name, order: g.order } : g));
  d.classes = d.classes.map(c => (c.id === KG ? Object.assign({}, c, { gradeId: 'kg_legacy_77' }) : c));
  dedupeClasses(d);
  assert.notEqual(d.classes.find(c => c.id === KG).deleted, true,
    'كان يُدفن لأن gradeId لم يطابق أي معرّف في grades');
});

test('dedupeClasses: لا تدفن فصلًا يحمل صفّه في حقل قديم', () => {
  const d = baseData();
  d.classes = d.classes.map(c => (c.id === KG
    ? { id: KG, name: 'أ', campus: 'BOYS', teacherIds: [], stage: 'kg_g0' }   // بلا gradeId
    : c));
  dedupeClasses(d);
  assert.notEqual(d.classes.find(c => c.id === KG).deleted, true, 'قُبل عبر stage القديم');
});

test('dedupeClasses: ما زال يدفن صفًا غير موجود إطلاقًا', () => {
  const d = baseData();
  d.grades = d.grades.filter(g => g.id !== 'kg_g0');
  d.classes = d.classes.map(c => (c.id === KG ? Object.assign({}, c, { gradeId: 'kg_g0' }) : c));
  dedupeClasses(d);
  assert.equal(d.classes.find(c => c.id === KG).deleted, true, 'أُدفن — السلوك الأصلي محفوظ');
});

test('dedupeClasses: ما زال يزيل التكرار', () => {
  const d = baseData();
  d.classes.push({ id: 'dup_1', gradeId: 'kg_g0', name: 'أ', campus: 'BOYS', teacherIds: [] });
  dedupeClasses(d);
  assert.equal(d.classes.find(c => c.id === 'dup_1').deleted, true);
});

/* ---------- 13) renderClasses لا يعيد إنتاج فصل له سجل ---------- */
test('renderClasses: لا يعيد إنتاج فصل له سجل محذوف (يوقف حلقة الإحياء)', () => {
  const gi = indexSrc.indexOf('const hasRecord = d.classes.some(c => c.id === __clsId)');
  assert.ok(gi > 0, 'كود الحارس غير موجود في public/index.html');
  const win = indexSrc.slice(gi, gi + 800);
  assert.ok(/const isBlocked = \(Array\.isArray\(d\._blockedClasses\) \? d\._blockedClasses : \[\]\)\.includes\(__clsId\)/.test(win),
    'يجب أن يفحص _blockedClasses');
  assert.ok(/&&\s*!hasRecord\s*&&\s*!isBlocked\)\{/.test(win),
    'شرط الإنشاء يجب أن يخضع لـ hasRecord و isBlocked');
  assert.ok(!/__blockedNow/.test(indexSrc), 'لا متغيّر جديد خارج سياق extract');
});

test('renderClasses: الإضافة ما زالت تعمل لصفّ بلا سجل', () => {
  const gi = indexSrc.indexOf('const hasRecord = d.classes.some(c => c.id === __clsId)');
  const win = indexSrc.slice(gi, gi + 800);
  const m = win.match(/if\((!d\.classes\.some\(c => c\.gradeId===grade\.id[\s\S]*?)\)\{\s*\n\s*d\.classes\.push/);
  assert.ok(m, 'نمط شرط الإنشاء تغيّر');
  assert.ok(m[1].includes('!c.deleted'), 'يظل يستثني المحذوف');
});
