'use strict';
/* =============================================================================
 * سلامة أقسام نسخة المدرسة على الخادم:
 * مفتاح ناقص في النسخة يعني أن الواجهة ترمي استثناءً وتظهر شاشة بيضاء.
 * الخادم يملأ الناقص قبل الإرسال وقبل الحفظ، ولا يلمس القائم ولا يحذف شيئاً.
 * ========================================================================== */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const SERVER = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');

const A = SERVER.indexOf('const DATA_SECTION_KEYS =');
const B = SERVER.indexOf('// ===== تطبيع المعلمين المكررة', A);
assert.ok(A !== -1 && B > A, 'تعذر قصّ ensureDataSections من server.js');
const SRC = SERVER.slice(A, B);

function ensure(data, prev) {
  const ctx = { JSON, console };
  vm.createContext(ctx);
  vm.runInContext(SRC + '\n;ensureDataSections;', ctx);
  return vm.runInContext('ensureDataSections', ctx)(data, prev);
}

const SECTIONS = ['users', 'grades', 'classes', 'students', 'attendance', 'notes', 'transfers', 'maintenance', 'adminMsgs', 'announcements', 'suggestions'];

test('مفتاح ناقص يُملأ بقائمة فارغة', () => {
  const d = ensure({ students: [] });
  for (const k of SECTIONS) assert.ok(Array.isArray(d[k]), k + ' يجب أن يكون مصفوفة');
});

test('الملاحظات الناقصة تُملأ من نسخة الخادم السابقة', () => {
  const prevNotes = [{ id: 'n1' }];
  const d = ensure({ notes: undefined }, { notes: prevNotes });
  assert.deepEqual(d.notes, prevNotes);
  assert.notEqual(d.notes, prevNotes, 'يجب أن تكون نسخة مستقلة لا مرجعاً مشتركاً');
});

test('قائمة موجودة لا تُمس', () => {
  const d = ensure({ notes: [{ id: 'keep' }] }, { notes: [{ id: 'other' }] });
  assert.deepEqual(d.notes, [{ id: 'keep' }]);
});

test('قيمة غير مصفوفة تُصحَّح', () => {
  const d = ensure({ notes: { a: 1 }, students: 5 });
  assert.deepEqual(d.notes, []);
  assert.deepEqual(d.students, []);
});

test('مفاتيح ليست أقساماً تبقى كما هي', () => {
  const d = ensure({ timetable: { t1: {} }, pointsTotals: { s1: 5 }, settings: { x: 1 } });
  assert.deepEqual(d.timetable, { t1: {} });
  assert.deepEqual(d.pointsTotals, { s1: 5 });
  assert.deepEqual(d.settings, { x: 1 });
});

test('الإجابة تُملأ قبل الإرسال', () => {
  const i = SERVER.indexOf('res.json({ ts: rec.ts, data: ensureDataSections(rec.data) });');
  assert.ok(i !== -1, 'GET لا يملأ الأقسام قبل الإرسال');
});

test('الحفظ يملأ الأقسام قبل setSchoolData', () => {
  const fill = SERVER.indexOf('ensureDataSections(clean, prev ? prev.data : null)');
  const write = SERVER.indexOf('let putRes = await db.setSchoolData', fill);
  assert.ok(fill !== -1, 'الحفظ لا يملأ الأقسام');
  assert.ok(fill < write, 'الملء يجب أن يسبق الكتابة');
});