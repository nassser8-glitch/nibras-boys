'use strict';
/* =============================================================================
 * الطالب ترى ملاحظات نقاطها هي — «نقاطي» لا تُظهر الإيجابيات قبل هذا الإصلاح
 * -----------------------------------------------------------------------------
 * البلاغ: لكادي نقاطٌ إيجابية (منها +10 «تفوق دراسي» لأمل الشامي) تظهر على
 * شاشة معلمتها وعلى شاشة المدير، لكن شاشة الطالب «نقاطي» تُظهر «النقاط
 * الإيجابية +0» ولا تعرض أي ملاحظة. السبب: الفلترة الخصوصية (خادماً وعميلاً)
 * كانت تعتبر الملاحظات «مملوكة لمعلم» فلا تصل الطالبَ منها شيء — لا من
 * استجابة الخادم ولا من دمج التخزين المحلي — بينما رصيدُها (pointsTotals)
 * يحسبه الخادم منها كلها، فاختلفت الشاشات الثلاث وتعارض «الأصل الواحد».
 *
 * الإصلاح المختبر هنا على ثلاث طبقات:
 *   1) الخادم (notes-privacy.js canReadNote): الطالب تقرأ ملاحظاتٍ عنها هي
 *      (studentId = معرّف حسابها) وليس ملاحظات زميلاتها.
 *   2) العميل (NRC_canSeeNote): ترى نص ملاحظاتِها هي، وتُخفي نص غيرها.
 *   3) العميل (NRC_noteBelongsToOther + NRC_mergeNotes): تبقى ملاحظاتُها على
 *      جهازها عبر كل دمج، وتُسقط ملاحظاتُ غيرها.
 * ثم صفحة «نقاطي» كاملة (renderMyPoints) تساوي شاشة معلّمتها/المدير.
 * ========================================================================== */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const NP = require(path.join(ROOT, 'notes-privacy.js'));
const CLIENT_SRC = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');

// ---------------------------------------------------------------- fixtures
const KADI = 'kadi_5037';     // الطالب صاحبة الملاحظات
const OTHER = 's_other_9';    // طالب أخرى
const T_AML = 'teacher_aml';  // معلم كتبت +10 لكادي
const T_SRV = 'teacher_srv';  // معلم أخرى كتبت سالبة خاصة عن كادي

const studentKadi = { role: 'STUDENT', id: KADI, user_id: KADI, school: 'BOYS' };
const teacherAml = { role: 'TEACHER', id: T_AML, user_id: T_AML, school: 'BOYS' };
const teacherOther = { role: 'TEACHER', id: 'teacher_x', user_id: 'teacher_x', school: 'BOYS' };

function note(over = {}) {
  return {
    id: 'n_' + Math.random().toString(36).slice(2, 9),
    studentId: KADI, type: 'POSITIVE', category: 'تفوق دراسي',
    description: 'مميزة خلال هذا الاسبوع', points: 10,
    createdBy: T_AML, createdAt: '2026-10-06T00:00:00.000Z',
    ...over,
  };
}

// ------------------------------------------ 1) الخادم: الطالب تقرأ ملاحظاتها
test('1) الخادم: الطالب تقرأ ملاحظاتِها، ولا ملاحظاتَ زميلاتِها', () => {
  const mine = note({ id: 'a1' });
  const otherStu = note({ id: 'a2', studentId: OTHER, description: 'زميلتها' });

  assert.equal(NP.canReadNote(mine, studentKadi), true, 'ملاحظة عنها تصلها');
  assert.equal(NP.canReadNote(otherStu, studentKadi), false, 'ملاحظة زميلتها لا');

  const all = NP.filterNotesForViewer([mine, otherStu], studentKadi);
  assert.deepEqual(all.map(n => n.id), ['a1'], 'تُفلتر لملاحظاتها فقط');

  // المعلم صاحبة الملاحظة ما زالت تراها مالكاً، وغيرها لا
  assert.equal(NP.canReadNote(mine, teacherAml), true);
  assert.equal(NP.canReadNote(mine, teacherOther), false);
  // الإدارة ترى الكل
  assert.equal(NP.canReadNote(mine, { role: 'ADMIN', user_id: 'adm' }), true);
});

// ------------------------------- 2) الطالب تقرأ حتى السالبة الخاصة عنها
test('2) الطالب ترى ملاحظة «سجلات خاصة» سالبةً وُضعت عليها — رصيدها كاملاً', () => {
  const privateNeg = note({
    id: 'p1', type: 'NEGATIVE', category: 'سجلات خاصة', points: -10,
    createdBy: T_SRV, description: 'ملاحظة خاصة',
  });
  assert.equal(NP.canReadNote(privateNeg, studentKadi), true,
    'نقطة السالبة الخاصّة عن الطالب جزءٌ من سبب رصيدها');
  assert.equal(NP.filterNotesForViewer([privateNeg], studentKadi).length, 1);
});

// ------------------------------- 3) العميل: NRC_canSeeNote للطالب
test('3) العميل: الطالب ترى نصّ ملاحظاتها، وتُخفي نصّ غيرها', () => {
  const A = loadClientFns(() => studentKadi);
  const mine = note({ id: 'c1', description: 'نصي الإيجابي' });
  const other = note({ id: 'c2', studentId: OTHER, description: 'نص زميلتي' });

  assert.equal(A.NRC_canSeeNote(mine), true, 'ترى ملاحظتها');
  assert.equal(A.NRC_canSeeNote(other), false, 'لا ترى ملاحظة زميلتها');

  // المعلمين بلا تغيير: المالك فقط أو الإدارة
  const BT = loadClientFns(() => teacherAml);
  assert.equal(BT.NRC_canSeeNote(mine), true, 'أمل ترى ما كتبتها');
  assert.equal(BT.NRC_canSeeNote(note({ id: 'c3', createdBy: T_SRV })), false,
    'معلم لا ترى ملاحظة زميلتها');
});

// ------------------- 4) العميل: NRC_noteBelongsToOther + دمج الطالب
test('4) دمج جهاز الطالب يُبقي ملاحظاتِها ويُسقط ملاحظاتِ غيرها', () => {
  const A = loadClientFns(() => studentKadi);
  const mine = note({ id: 'd1' });
  const otherStu = note({ id: 'd2', studentId: OTHER, description: 'زميلة' });

  assert.equal(A.NRC_noteBelongsToOther(mine), false, 'ملاحظتها تبقى');
  assert.equal(A.NRC_noteBelongsToOther(otherStu), true, 'ملاحظة غيرها تُسقط');

  // دمج مع نسخة الخادم (بعد إصلاح الفلترة فتُرسل الخادم ملاحظاتِها) تُبقيها
  const kept = A.NRC_mergeNotes([], [mine, otherStu]);
  assert.deepEqual(kept.map(n => n.id), ['d1'], 'لا تصل ملاحظة غيرها للتخزين');

  // جهاز المعلم لم يتغيّر: ملاحظة زميلتها تُسقط، وصاحبتها تُبقي
  const BT = loadClientFns(() => teacherAml);
  assert.equal(BT.NRC_noteBelongsToOther(mine), false, 'أمل تبقي ما كَتبت');
  assert.equal(BT.NRC_noteBelongsToOther(note({ id: 'd3', createdBy: T_SRV })), true,
    'معلم تُسقط ملاحظة زميلتها');
});

// --------------------------- 5) صفحة «نقاطي» كاملة = شاشة المعلم/المدير
test('5) صفحة «نقاطي» تعرض النقاط الإيجابية والسالبة نفس شاشة المدير', () => {
  const db = {
    users: [
      { id: KADI, role: 'STUDENT', name: 'كادي بنت سلمان' },
      { id: T_AML, role: 'TEACHER', name: 'أمل الشامي' },
      { id: T_SRV, role: 'TEACHER', name: 'سلوى عبد' },
    ],
    notes: [
      note({ id: 'e1', category: 'تفوق دراسي', points: 10, createdBy: T_AML, createdAt: '2026-10-06T00:00:00.000Z' }),
      note({ id: 'e2', category: 'إنجاز الواجبات', points: 3, createdBy: T_AML, createdAt: '2026-09-30T00:00:00.000Z' }),
      note({ id: 'e3', category: 'إنجاز الواجبات', points: 3, createdBy: T_AML, createdAt: '2026-09-29T00:00:00.000Z' }),
      note({ id: 'e4', category: 'إنجاز الواجبات', points: 3, createdBy: T_AML, createdAt: '2026-09-16T00:00:00.000Z' }),
      note({ id: 'e5', category: 'سجلات خاصة', type: 'NEGATIVE', points: -10, createdBy: T_SRV, createdAt: '2026-10-01T00:00:00.000Z' }),
      note({ id: 'e6', studentId: OTHER, category: 'الانضباط', type: 'POSITIVE', points: 5, createdBy: T_AML, description: 'زميلة أخرى' }),
    ],
    attendance: [
      { studentId: KADI, date: '2026-10-02', status: 'ABSENT' },
      { studentId: KADI, date: '2026-10-01', status: 'ABSENT' },
      { studentId: KADI, date: '2026-09-29', status: 'LATE', lateMinutes: 10 },
      { studentId: KADI, date: '2026-09-28', status: 'ABSENT' },
      { studentId: KADI, date: '2026-09-25', status: 'ABSENT' },
      { studentId: KADI, date: '2026-09-16', status: 'ABSENT' },
      { studentId: KADI, date: '2026-09-11', status: 'ABSENT' },
      { studentId: KADI, date: '2026-09-09', status: 'ABSENT' },
      { studentId: KADI, date: '2026-09-07', status: 'LATE', lateMinutes: 10 },
    ],
    assignments: [],
    students: [{ id: KADI, active: true, classId: 'C1' }, { id: OTHER, active: true, classId: 'C1' }],
  };
  const A = loadClientFns(() => studentKadi, db);

  const html = A.renderMyPoints();

  // الأرقام مطابقة لشاشة أمل الشامي/المدير: +19 إيجابية / -26 سلبية / -7 صافي
  assert.ok(html.includes('+19'), 'الإيجابيات تُعرض (ملاحظاتٌ معروضة للطالب)');
  assert.ok(html.includes('-26'), 'السالبات تشمل ملاحظة «سجلات خاصة»');
  assert.ok(html.includes('-7'), 'الصافي هو الأصل الواحد نفسه');
  // صفّ +10 تفوق دراسي بأمل الشامي ظاهر
  assert.ok(html.includes('+10'), 'نقطة أمل +10 ظاهرة في الصفوف');
  assert.ok(html.includes('تفوق دراسي'), 'فئة «تفوق دراسي» ظاهرة');
  assert.ok(html.includes('أمل الشامي'), 'اسم المعلم المانحة ظاهر');
  assert.ok(html.includes('مميزة خلال هذا الاسبوع'), 'نصّ الملاحظة ظاهر للطالب');
  // لا تسرّب ملاحظة زميلة أخرى
  assert.ok(!html.includes('نص زميلة أخرى') && !html.includes('زميلة أخرى'),
    'ملاحظة طالب أخرى لا تظهر على صفحة كادي');
  assert.ok(!html.includes('+5'), 'نقطة زميلة أخرى لا تُحسب');
});

// ------------------------------------------------ harness (من note-privacy)
function extractFn(src, name) {
  const start = src.indexOf('function ' + name + '(');
  assert.ok(start >= 0, 'لم أجد ' + name);
  const open = src.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const ch = src[i];
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  throw new Error('لم يُغلق جسم ' + name);
}

const PREAMBLE = [
  `var UNDONE_DEDUCTION = -4;`,
  `var POINTS_START_FROM = '2026-09-07';`,
  `var __schoolSettingsCache = null;`,
  `var notePointsMap = { 'الانضباط':5, 'الاحترام':5, 'التعاون':4, 'المشاركة':3, 'المثابرة':4,
     'تفوق دراسي':10, 'إنجاز الواجبات':3, 'القيادة':6,
     'الغياب':-2, 'التأخر':-1, 'عدم إنجاز الواجبات':-4, 'الإزعاج داخل الفصل':-5,
     'عدم الانضباط':-6, 'قلة الاحترام':-7, 'التنمر':-10, 'عدم المشاركة':-3 };`,
  `function escapeHtml(str){ return String(str ?? '').replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }`,
].join('\n');

function loadClientFns(currentUser, db) {
  const code = PREAMBLE + '\n' + [
    extractFn(CLIENT_SRC, 'NRC_isAdminNotesRole'),
    extractFn(CLIENT_SRC, 'NRC_canSeeNote'),
    extractFn(CLIENT_SRC, 'NRC_noteBelongsToOther'),
    extractFn(CLIENT_SRC, 'NRC_mergeNotes'),
    extractFn(CLIENT_SRC, 'notePoints'),
    extractFn(CLIENT_SRC, 'attendancePoints'),
    extractFn(CLIENT_SRC, '__attIsAbsent'),
    extractFn(CLIENT_SRC, '__attEffStatus'),
    extractFn(CLIENT_SRC, 'pointsCutoffDate'),
    extractFn(CLIENT_SRC, 'todayStr'),
    extractFn(CLIENT_SRC, 'pointItems'),
    extractFn(CLIENT_SRC, 'renderMyPoints'),
  ].join('\n');
  const data = db || {
    users: [], notes: [], attendance: [], assignments: [], students: [],
  };
  const ctx = {
    console, Map, Set, Date, Math, JSON, Number, String, Array, Object, RegExp,
    currentUser: currentUser || (() => ({ role: 'TEACHER', id: 't' })),
    loadDB: () => data,
    userById: (id) => (data.users || []).find(u => u && u.id === id),
    roleLabel: (r) => r,
  };
  vm.createContext(ctx);
  vm.runInContext(code +
    '\n;globalThis.__api = { NRC_canSeeNote, NRC_noteBelongsToOther, NRC_mergeNotes, renderMyPoints };', ctx);
  return ctx.__api;
}