/* صفحة «حضوري» كانت تعرض أصفاراً دائماً بينما يرى المدير الغياب في السجلات
 *
 * السبب: سجلات الحضور مخزّنة كسجلّ مسطّح — سجلّ لكل (طالب، يوم):
 *   { studentId, date, status:'ABSENT'|'LATE'|'PRESENT', ... }
 * لكن الصفحة كانت تقرأها كأن كل عنصرٍ يومٌ يحوي قائمة طلاب:
 *   d.attendance.forEach(day => (day.students||[]).find(...))
 * فـ (day.students) غير موجود دائماً، فيجد لا شيئاً، فلا يُحتسب أي يوم —
 * أصفار. وكانت الحالة تُقارن بـ 'present' صغيرة بينما الحقيقية 'PRESENT'
 * كبيرة، فلو صحّ الشكل لبقيت الأصفار. المدير يعرض السجلات بالشكل الصحيح
 * فيرى أن الغياب مسجّل فعلاً.
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const HTML = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');

/* نقتطع الدوال المطلوبة من الصفحة كما هي، لا نسخاً منها. */
function sliceBetween(startMarker, endMarker) {
  const a = HTML.indexOf(startMarker);
  assert.ok(a !== -1, 'لم يُعثر على: ' + startMarker);
  const b = HTML.indexOf(endMarker, a);
  assert.ok(b > a, 'لم يُعثر على نهاية: ' + endMarker);
  return HTML.slice(a, b);
}

const __LEGACY_ABS = '__LEGACY__';

function buildCtx() {
  const src = [
    "var __LEGACY_ABS = '__LEGACY__';",
    sliceBetween('function __attRealClerks(rec){', 'function __attIsAbsent(rec){'),
    sliceBetween('function __attIsAbsent(rec){', 'function __attWinner(a, b){'),
    sliceBetween('function __attWinner(a, b){', 'function attCountsByDate('),
    sliceBetween('function attCountsByDate(', '/* تاريخ طالب واحد'),
    sliceBetween('function attCountsByStudent(', '\n/* اختيار أحدث نسخة'),
    'this.api = { attCountsByStudent, attCountsByDate, __attWinner };',
  ].join('\n');
  const ctx = { console, Map, Set, JSON, Math, Object, Array };
  vm.createContext(ctx);
  vm.runInContext(src, ctx);
  return ctx;
}

test('سجل مسطّح حقيقي: غياب يوم واحد يُحتسب غياباً', () => {
  const { attCountsByStudent } = buildCtx().api;
  const d = { attendance: [
    { id: 'r1', studentId: 'u1', date: '2026-02-01', status: 'ABSENT', absClerks: ['t1'] },
  ] };
  const r = attCountsByStudent(d, 'u1');
  assert.equal(r.absent, 1, 'يجب أن يظهر غياب واحد — لا أصفار');
  assert.equal(r.present, 0);
  assert.equal(r.total, 1);
});

test('يطابق ما يراه المدير: نفس السجل يعطي نفس العدّ في الواجهتين', () => {
  const ctx = buildCtx().api;
  const d = { attendance: [
    { id: 'r1', studentId: 'u1', date: '2026-02-01', status: 'ABSENT', absClerks: ['t1'] },
    { id: 'r2', studentId: 'u2', date: '2026-02-01', status: 'PRESENT' },
  ] };
  const mine = ctx.attCountsByStudent(d, 'u1');
  const admin = ctx.attCountsByDate(d, '2026-02-01', ['u1', 'u2']);
  assert.equal(mine.absent, admin.absent,
    'عدّ الطالب يجب أن يساوي عدّ المدير — وهذا هو الشكوى أصلاً');
  assert.equal(mine.absent, 1);
});

test('متأخر يُحتسب متأخراً لا حاضراً', () => {
  const { attCountsByStudent } = buildCtx().api;
  const d = { attendance: [{ studentId: 'u1', date: '2026-02-01', status: 'LATE' }] };
  const r = attCountsByStudent(d, 'u1');
  assert.equal(r.late, 1);
  assert.equal(r.absent, 0);
  assert.equal(r.present, 0);
});

test('غياب وحضور في أيام مختلفة: كلٌّ في موضعه', () => {
  const { attCountsByStudent } = buildCtx().api;
  const d = { attendance: [
    { studentId: 'u1', date: '2026-02-01', status: 'ABSENT' },
    { studentId: 'u1', date: '2026-02-02', status: 'PRESENT' },
    { studentId: 'u1', date: '2026-02-03', status: 'LATE' },
  ] };
  const r = attCountsByStudent(d, 'u1');
  assert.deepEqual({ p: r.present, a: r.absent, l: r.late }, { p: 1, a: 1, l: 1 });
  assert.equal(r.total, 3);
  assert.equal(r.days, 3);
});

test('سجل محذوف (قبر) لا يُحتسب', () => {
  const { attCountsByStudent } = buildCtx().api;
  const d = { attendance: [{ studentId: 'u1', date: '2026-02-01', status: 'ABSENT', deleted: true }] };
  const r = attCountsByStudent(d, 'u1');
  assert.equal(r.absent, 0, 'سِجل الحذف لا يظهر غياباً');
  assert.equal(r.total, 0);
});

test('غياب ثم تصحيح صريح بالحاضر في اليوم نفسه: الحاضر الأحدث يفوز', () => {
  const { attCountsByStudent } = buildCtx().api;
  const d = { attendance: [
    { studentId: 'u1', date: '2026-02-01', status: 'ABSENT', _t: 100, absClerks: ['t1'] },
    { studentId: 'u1', date: '2026-02-01', status: 'PRESENT', _t: 200 },
  ] };
  const r = attCountsByStudent(d, 'u1');
  assert.equal(r.total, 1, 'يوم واحد لا يومان');
  assert.equal(r.absent, 0, 'التصحيح الصريح يلغي الغياب المعلّق');
});

test('لا تُعدّ سجلات طالب غيري', () => {
  const { attCountsByStudent } = buildCtx().api;
  const d = { attendance: [
    { studentId: 'u2', date: '2026-02-01', status: 'ABSENT' },
    { studentId: 'u3', date: '2026-02-01', status: 'ABSENT' },
  ] };
  const r = attCountsByStudent(d, 'u1');
  assert.equal(r.total, 0, 'لا سجلّ لغيري');
});

test('قائمة حضور فارغة أو غير موجودة لا تكسر الصفحة', () => {
  const { attCountsByStudent } = buildCtx().api;
  for (const d of [{}, { attendance: [] }, { attendance: null }]) {
    const r = attCountsByStudent(d, 'u1');
    assert.equal(r.total, 0);
  }
});

test('الحالة تحترم الأحرف الكبيرة:PRESENT لا present', () => {
  /* القيم الحقيقية كبيرة الحروف. لو قورنت بأحرف صغيرة لَ page_offering صفراً
   * حتى مع الشكل الصحيح — وهو خطأ ثانٍ كان مخفياً خلف الأول. */
  const { attCountsByStudent } = buildCtx().api;
  const d = { attendance: [{ studentId: 'u1', date: '2026-02-01', status: 'PRESENT' }] };
  assert.equal(attCountsByStudent(d, 'u1').present, 1);
});
