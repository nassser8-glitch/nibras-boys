'use strict';
/* =============================================================================
 * الخادم كان يستبدل قسم التحويلات كاملاً في PUT (بلا mergeSection)، فدفعة
 * من جهاز قديم تُعيد تحويلاً محذوفاً وتُمحى الحلول. نختبر mergeSection نفسها
 * (المستخرجة من server.js) سلوكياً مع الحالة.
 * ========================================================================== */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');

function extractFn(src, name) {
  const start = src.indexOf('function ' + name + '(');
  if (start === -1) throw new Error(name + ' غير موجودة');
  let i = src.indexOf('{', start), depth = 0;
  for (let j = i; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') { depth--; if (depth === 0) return src.slice(start, j + 1); }
  }
  throw new Error('أقواس غير متوازنة في ' + name);
}
const mergeSection = new Function(
  'mergeTimetable', 'mergeClasses',
  extractFn(SRC, 'mergeSection') + '; return mergeSection;'
)(() => ({}), () => ({}));
const mergeTransfers = new Function(
  'mergeTimetable', 'mergeClasses',
  extractFn(SRC, 'mergeSection') + '\n' + extractFn(SRC, 'mergeTransfers') + '\n; return mergeTransfers;'
)(() => ({}), () => ({}));

const T = (over = {}) => Object.assign({ id: 'tr_1', studentIds: ['s1'], status: 'PENDING' }, over);
const dead = (over = {}) => T(Object.assign({ deleted: true, deletedAt: '2026-10-01T09:00:00.000Z', deletedBy: 'admin_1' }, over));

test('شاهد حذف في الخادم لا يُحييه جهاز قديم', () => {
  const r = mergeSection([dead()], [T()]);
  assert.equal(r.length, 1);
  assert.equal(r[0].deleted, true, 'تحويل محذوف عاد بدفعة من جهاز قديم');
});

test('شاهد حذف من الجهاز يُحفظ في الخادم', () => {
  const r = mergeSection([T()], [dead()]);
  assert.equal(r[0].deleted, true, 'دفعة المدير للحذف لم تُحفظ');
});

test('السلوك الخاطئ: الاستبدال الكامل يعيد المحذوف (ما كان يحدث قبل الإصلاح)', () => {
  const incoming = [T()];                       // نسخة قديمة بلا شاهد
  const naivelyReplaced = incoming;             // ما كان يفعله الخادم بلا دمج
  assert.equal(naivelyReplaced.find(x => x.id === 'tr_1').deleted, undefined);
  // ومع الدمج يبقى الشاهد:
  assert.equal(mergeSection([dead()], incoming)[0].deleted, true);
});

test('الحل في الخادم لا يُمحى بدفعة قديمة', () => {
  const solved = T({ status: 'RESOLVED', solution: 'تم الحل', resolvedBy: 'a1', resolvedAt: '2026-10-01T10:00:00.000Z' });
  const r = mergeTransfers([solved], [T()]);
  assert.equal(r.length, 1);
  assert.equal(r[0].solution, 'تم الحل', 'الحل المحفوظ على الخادم مُحي بدفعة قديمة');
  assert.equal(r[0].status, 'RESOLVED');
});

test('mergeSection العام كان يمحو الحل (السلوك قبل الإصلاح)', () => {
  const solved = T({ status: 'RESOLVED', solution: 'تم الحل' });
  assert.equal(mergeSection([solved], [T()])[0].solution, undefined);
  assert.equal(mergeTransfers([solved], [T()])[0].solution, 'تم الحل');
});

test('حلٌّ جديد من الجهاز يُحفظ', () => {
  const solved = T({ status: 'RESOLVED', solution: 'تم الحل', resolvedBy: 'a1', resolvedAt: '2026-10-02T10:00:00.000Z' });
  const r = mergeTransfers([T()], [solved]);
  assert.equal(r[0].solution, 'تم الحل');
});

test('حلّان على جهازين: الأحدث resolvedAt يكسب', () => {
  const older = T({ status: 'RESOLVED', solution: 'قديم', resolvedAt: '2026-10-01T09:00:00.000Z' });
  const newer = T({ status: 'RESOLVED', solution: 'جديد', resolvedAt: '2026-10-02T09:00:00.000Z' });
  assert.equal(mergeTransfers([older], [newer])[0].solution, 'جديد');
  assert.equal(mergeTransfers([newer], [older])[0].solution, 'جديد');
});

test('شاهد الحذف له الأولوية: حلٌّ محلي لا يُحيي محذوفاً', () => {
  const solved = T({ status: 'RESOLVED', solution: 'محلي', resolvedAt: '2026-10-05T09:00:00.000Z' });
  const r = mergeTransfers([dead()], [solved]);
  assert.equal(r[0].deleted, true, 'الحل المحلي أ تحويلاً محذوفاً');
});

test('حذف تحويل لا يمسّ غيره', () => {
  const r = mergeTransfers([T({ id: 'tr_1' }), T({ id: 'tr_2' })], [dead({ id: 'tr_1' }), T({ id: 'tr_2' })]);
  assert.equal(r.length, 2);
  assert.equal(r.find(x => x.id === 'tr_1').deleted, true);
  assert.equal(r.find(x => x.id === 'tr_2').deleted, undefined);
});

test('الترتيب لا يغيّر النتيجة: الشاهد يبقى', () => {
  const r = mergeTransfers([dead()], [T()]);
  assert.equal(r.find(x => x.id === 'tr_1').deleted, true);
});

test('معرّفات مكررة (مدخل تالف): الخادم يختار النسخة الحيّة ولا ينهار', () => {
  const r = mergeTransfers([dead(), T()], [T()]);
  assert.equal(r.length, 1);
  assert.ok(r[0] && r[0].id === 'tr_1');
});

test('إضافة تحويل جديد ما زال يعمل', () => {
  const r = mergeSection([T({ id: 'tr_1' })], [T({ id: 'tr_1' }), T({ id: 'tr_2' })]);
  assert.equal(r.length, 2);
});

test('قائمة فارغة من لا يكسر', () => {
  assert.deepEqual(mergeSection([], [T()]), [T()]);
  assert.deepEqual(mergeSection([T()], []), [T()]);
  assert.deepEqual(mergeSection([], []), []);
});