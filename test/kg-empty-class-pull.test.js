'use strict';
// regression: تنقية الفصول بعد السحب (__syncPull) كانت تحذف كل فصل بلا طلاب،
// فيُمحى فصل التمهيدي kg_g0_a من التخزين المحلي عند كل تحديث، ثم يعيد
// renderClasses إنتاجه بـ teacherIds:[] فتختفي أسماء المعلمين (سارة صفي، أروى بشير).
//
// السبب سطران في public/index.html:
//   1) أقسام السحب كانت تمرّ على locallyOnlyP (نفس locallyOnly المرصودة في الدفع):
//      نسخة الخادم تفوز كليًا عند تطابق المعرّف، فتُمحى teacherIds المحلية.
//   2) التنقية اللاحقة: if(!stuCount[c.id]) return false  ⇒ حذف كل فصل فارغ،
//      حتى لو كان الخادم يعرفه ويحمله.
//
// الإصلاح: classes في السحب يمرّ بـ mergeClassesLocal، وقاعدة «بلا طلاب ⇒ تُحذف»
// تخصّ الفصل الشبح المحلي الذي لا يعرفه الخادم فقط (serverClassIds).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const INDEX = path.join(__dirname, '..', 'public', 'index.html');
const indexSrc = fs.readFileSync(INDEX, 'utf8');

const deep = (o) => JSON.parse(JSON.stringify(o));

function extract(src, name) {
  // الشكل 1: function f(...){...}
  const iFn = src.search(new RegExp('(async\\s+)?function\\s+' + name + '\\s*\\('));
  if (iFn >= 0) {
    const iOpen = src.indexOf('{', iFn);
    const body = braceSlice(src, iOpen, name);
    return src.slice(iFn, iOpen + body.length);
  }
  // الشكل 2: const f = (...) => { ... }  (يطابق الأقواس بالأعماق، لا بنمط نصّي)
  const m = src.match(new RegExp('const\\s+' + name + '\\s*=\\s*'));
  assert.ok(m, 'لم يُعثر على ' + name + ' في المصدر');
  const start = m.index + m[0].length;              // بداية تعبير السهم: (params) => {…}
  const iArrow = src.indexOf('{', start);
  assert.ok(iArrow > start, 'لا جسم لـ ' + name);
  const body = braceSlice(src, iArrow, name);      // {…} بالأعماق
  return src.slice(start, iArrow + body.length);    // (params) => {…}
}

function braceSlice(src, iOpen, name) {
  let d = 0;
  for (let k = iOpen; k < src.length; k++) {
    if (src[k] === '{') d++;
    else if (src[k] === '}') { d--; if (d === 0) return src.slice(iOpen, k + 1); }
  }
  throw new Error('نهاية غير متوازنة لـ ' + name);
}

const mergeClassesLocal = new Function(extract(indexSrc, 'mergeClassesLocal') + '; return mergeClassesLocal;')();

/* ---------- إعادة بناء منطق __syncPull مأخوذًا حرفيًا من الإنتاج ---------- */

// نأخذ نصوص الدوال من المصدر حتى لا يبتعد الاختبار عن سلوك الإنتاج.
const locallyOnlyPSrc = extract(indexSrc, 'locallyOnlyP');

/** يحاكي __syncPull من السطر 1427 إلى 1470 كما هو في الإنتاج. */
function pullMerge(local, server) {
  const merged = deep(server);
  const serverClassIds = new Set(
    (Array.isArray(merged.classes) ? merged.classes : []).map(c => c && c.id).filter(id => id != null)
  );
  const locallyOnlyP = new Function('const locallyOnlyP = ' + locallyOnlyPSrc + '; return locallyOnlyP;')();
  ['students', 'classes', 'grades', 'videos', 'transfers', 'maintenance', 'escapeAlerts'].forEach(sec => {
    if (!Array.isArray(local[sec])) return;
    merged[sec] = (sec === 'classes')
      ? mergeClassesLocal(local[sec], merged[sec])
      : locallyOnlyP(local[sec], merged[sec]);
  });
  // التنقية (كما في الإنتاج بعد الإصلاح)
  if (Array.isArray(merged.classes)) {
    const gradeIds = new Set((Array.isArray(merged.grades) ? merged.grades : []).map(g => g && g.id).filter(Boolean));
    const stuCount = {};
    (Array.isArray(merged.students) ? merged.students : []).forEach(s => {
      const cid = s && (s.classId || s.class_id || s.class);
      if (cid) stuCount[cid] = (stuCount[cid] || 0) + 1;
    });
    const seenKeys = new Set();
    merged.classes = merged.classes.filter(c => {
      if (!c || typeof c !== 'object') return false;
      if (c.deleted) return false;
      if (!c.gradeId || !gradeIds.has(c.gradeId)) return false;
      if (!stuCount[c.id] && !serverClassIds.has(c.id)) return false;
      const k = c.gradeId + '|' + (c.name || '');
      if (seenKeys.has(k)) return false;
      seenKeys.add(k);
      return true;
    });
  }
  return merged;
}

/* ---------- بيانات مشتركة ---------- */
const KG = 'kg_g0_a';
const B = 'b_g1_a';
const SARA = 'id_sara_safi';
const ARWA = 'id_arwa_bashir';
const OTHER_T = 'id_other_teacher';

const GRADES = [{ id: 'kg_g0', name: 'التمهيدي' }, { id: 'b_g1', name: 'الأول' }];

const serverFixture = (kgClass, students) => ({
  grades: deep(GRADES),
  classes: [
    Object.assign({ id: KG, gradeId: 'kg_g0', name: 'أ', campus: 'BOYS', teacherIds: [] }, kgClass || {}),
    { id: B, gradeId: 'b_g1', name: 'أ', campus: 'BOYS', teacherIds: [OTHER_T] },
  ],
  students: students || [],
});

/* ---------- الحالة 1: فصل موجود في الخادم وفارغ يبقى موجودًا ---------- */
test('الحالة 1: فصل موجود في الخادم وفارغ يبقى موجودًا (ولو teacherIds فيه)', () => {
  const local = {
    grades: deep(GRADES),
    classes: [
      { id: KG, gradeId: 'kg_g0', name: 'أ', campus: 'BOYS', teacherIds: [SARA, ARWA] },
      { id: B, gradeId: 'b_g1', name: 'أ', campus: 'BOYS', teacherIds: [OTHER_T] },
    ],
    students: [],
  };
  const server = serverFixture({ teacherIds: [] });  // الخادم لم يستلم بعد

  const merged = pullMerge(local, server);
  const kg = merged.classes.find(c => c.id === KG);
  assert.ok(kg, 'فصل التمهيدي باقٍ في النسخة المدمجة');
  assert.notEqual(kg.deleted, true, 'غير محذوف');
  assert.ok(kg.teacherIds.includes(SARA), 'سارة صفي باقية');
  assert.ok(kg.teacherIds.includes(ARWA), 'أروى بشير باقية');
});

test('الحالة 1b: الدفع وصل والخادم يحمل الاسمين ⇒ يبقىان بلا تكرار', () => {
  const local = {
    grades: deep(GRADES),
    classes: [
      { id: KG, gradeId: 'kg_g0', name: 'أ', campus: 'BOYS', teacherIds: [SARA, ARWA] },
      { id: B, gradeId: 'b_g1', name: 'أ', campus: 'BOYS', teacherIds: [OTHER_T] },
    ],
    students: [],
  };
  const server = serverFixture({ teacherIds: [SARA, ARWA] });
  const kg = pullMerge(local, server).classes.find(c => c.id === KG);
  assert.ok(kg, 'باقٍ');
  assert.deepEqual(kg.teacherIds.slice().sort(), [ARWA, SARA].sort());
});

/* ---------- الحالة 2: فصل محذوف في الخادم لا يُحيا من النسخة المحلية ---------- */
test('الحالة 2: فصل محذوف في الخادم (deleted) لا يُحيا محلياً', () => {
  const local = {
    grades: deep(GRADES),
    classes: [
      // الجهاز ما زال يحمله حيّاً مع إسناد
      { id: KG, gradeId: 'kg_g0', name: 'أ', campus: 'BOYS', teacherIds: [SARA] },
      { id: B, gradeId: 'b_g1', name: 'أ', campus: 'BOYS', teacherIds: [OTHER_T] },
    ],
    students: [],
  };
  const server = serverFixture({ deleted: true, teacherIds: [] });  // الخادم دفنه

  const merged = pullMerge(local, server);
  assert.equal(merged.classes.some(c => c.id === KG), false, 'لم يُحَ من النسخة المحلية');
});

/* ---------- الحالة 3: فصل شبح محلي غير موجود في الخادم وبلا طلاب يُحذف ---------- */
test('الحالة 3: فصل شبح محلي غير موجود في الخادم وبلا طلاب يُحذف', () => {
  const local = {
    grades: deep(GRADES),
    classes: [
      { id: KG, gradeId: 'kg_g0', name: 'أ', campus: 'BOYS', teacherIds: [SARA] },
      { id: B, gradeId: 'b_g1', name: 'أ', campus: 'BOYS', teacherIds: [OTHER_T] },
      { id: 'ghost_1', gradeId: 'kg_g0', name: 'ب', campus: 'BOYS', teacherIds: [] }, // شبح محلي فقط
    ],
    students: [],
  };
  const server = serverFixture({ teacherIds: [] });  // الخادم لا يعرف ghost_1

  const merged = pullMerge(local, server);
  assert.equal(merged.classes.some(c => c.id === 'ghost_1'), false, 'الشبح حُذف');
  assert.ok(merged.classes.find(c => c.id === KG), 'لكن kg_g0_a باقٍ لأن الخادم يعرفه');
});

/* ---------- invariants: لم نكسر الأقسام الأخرى ---------- */
test('لا مساس بقسم الطلاب في السحب', () => {
  const local = {
    grades: deep(GRADES),
    classes: [{ id: B, gradeId: 'b_g1', name: 'أ', campus: 'BOYS', teacherIds: [OTHER_T] }],
    students: [{ id: 's_local', name: 'طالب محلي' }],
  };
  const server = { grades: deep(GRADES), classes: [{ id: B, gradeId: 'b_g1', name: 'أ', campus: 'BOYS', teacherIds: [OTHER_T] }], students: [] };
  const merged = pullMerge(local, server);
  assert.ok(merged.students.some(s => s.id === 's_local'), 'الطالب المحلي أُلحق');
});

test('الشبح المحلي يُحذف بينما فصل الخادم الفارغ يُحفظ (فصلان بمعرّفين مختلفين)', () => {
  const local = { grades: deep(GRADES), classes: [{ id: B, gradeId: 'b_g1', name: 'أ', campus: 'BOYS', teacherIds: [] }], students: [] };
  const server = { grades: deep(GRADES), classes: [{ id: B, gradeId: 'b_g1', name: 'أ', campus: 'BOYS', teacherIds: [OTHER_T] }], students: [] };
  const merged = pullMerge(local, server);
  const b = merged.classes.find(c => c.id === B);
  assert.ok(b, 'فصل الخادم الفارغ باقٍ');
  assert.deepEqual(b.teacherIds, [OTHER_T]);
});
