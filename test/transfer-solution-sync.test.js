'use strict';
/* =============================================================================
 * حل التحويل كان يضيع بعد التحديث: حفظ الحل لم يكن يرفعه إطلاقاً،
 * فالسحب الدوري يمحوه. نختبر الرفع ( bonding ) ودمج الحل عبر السحب.
 * ========================================================================== */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const CLIENT = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');

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
function loadMerge() {
  const src = extractFn(CLIENT, '__transferSolveStamp') + '\n' + extractFn(CLIENT, '__mergeTransfersPull');
  return new Function(src + '; return __mergeTransfersPull;')();
}
const merge = loadMerge();

function solveHarness(over = {}) {
  const st = { alerts: [], closed: 0, render: 0, schedule: 0, school: 'school-1', solved: null };
  const ctx = {
    currentUser: () => st.me,
    loadDB: () => st.d,
    saveDB: (d) => { st.saved = d; },
    closeDetails: () => { st.closed++; },
    renderApp: () => { st.render++; },
    alert: (m) => st.alerts.push(m),
    getActiveSchool: () => st.school,
    __syncSchedule: (school, ms) => { st.schedule++; st.scheduledMs = ms; },
    document: { getElementById: () => ({ value: st.text }) },
    Date, JSON, String, Array, Object,
    ...over.ctx,
  };
  st.run = new Function('ctx', 'with(ctx){ ' + extractFn(CLIENT, 'saveTransferSolution') + '; return saveTransferSolution; }')(ctx);
  return st;
}

const ME = { id: 'agent_1', name: 'وكيل', role: 'SCHOOL_AGENT' };
function pending() {
  return {
    me: ME, text: 'تم التواصل مع ولي الأمر',
    d: { transfers: [{ id: 'tr_1', studentIds: ['s1'], status: 'PENDING', createdBy: 'teacher_A' }] },
  };
}

// ===== ١) الرفع: بلا __syncSchedule يضيع الحل =====

test('حفظ الحل يرفعه فوراً إلى الخادم', () => {
  const st = solveHarness(); Object.assign(st, pending());
  st.run('tr_1');
  assert.equal(st.schedule, 1, 'لم يُطلب رفع الحل — سيضيع مع السحب التالي');
  assert.equal(st.scheduledMs, 0, 'الرفع يجب أن يكون فورياً لا مؤجّل 700ms');
});

test('الحل يُحفظ بالحقول الصحيحة (resolvedBy لا solvedBy)', () => {
  const st = solveHarness(); Object.assign(st, pending());
  st.run('tr_1');
  const t = st.d.transfers[0];
  assert.equal(t.status, 'RESOLVED');
  assert.equal(t.solution, 'تم التواصل مع ولي الأمر');
  assert.equal(t.resolvedBy, 'agent_1');
  assert.equal(t.resolvedByName, 'وكيل');
  assert.ok(t.resolvedAt);
  assert.equal(t.solvedBy, undefined, 'اسم حقل خاطئ: solvedBy');
});

test('نص فارغ: لا حفظ ولا رفع', () => {
  const st = solveHarness(); Object.assign(st, pending());
  st.text = '   ';
  st.run('tr_1');
  assert.equal(st.d.transfers[0].status, 'PENDING');
  assert.equal(st.schedule, 0);
  assert.ok(st.alerts.length);
});

test('تحويل غير موجود: لا انهيار', () => {
  const st = solveHarness(); Object.assign(st, pending());
  st.run('tr_999');
  assert.equal(st.schedule, 0);
});

// ===== ٢) الدمج: حلٌّ محلي لم يُرفع لا يُمحى بالسحب =====

const solved = (over = {}) => Object.assign({
  id: 'tr_1', status: 'RESOLVED', solution: 'تم التواصل', resolvedBy: 'agent_1',
  resolvedAt: '2026-10-01T10:00:00.000Z',
}, over);

test('حلٌّ محلي يُحفظ رغم أن نسخة الخادم بلا حل', () => {
  const r = merge([solved()], [{ id: 'tr_1', status: 'PENDING' }]);
  assert.equal(r.length, 1);
  assert.equal(r[0].solution, 'تم التواصل');
  assert.equal(r[0].status, 'RESOLVED');
});

test('حلٌ محلي على تحويل لم يكن موجوداً أصلاً: يُضاف', () => {
  const r = merge([solved({ id: 'tr_new' })], []);
  assert.equal(r.length, 1);
  assert.equal(r[0].solution, 'تم التواصل');
});

test('حل الخادم لا ينزعه حلٌّ محلي فارغ', () => {
  const r = merge([{ id: 'tr_1', status: 'PENDING' }], [solved()]);
  assert.equal(r[0].solution, 'تم التواصل', 'نسخة بلا حل محلياً سحبت الحل المحفوظ على الخادم');
});

test('حلّان: الأحدث زمنياً يكسب', () => {
  const older = solved({ solution: 'حل قديم', resolvedAt: '2026-10-01T09:00:00.000Z' });
  const newer = solved({ solution: 'حل جديد', resolvedAt: '2026-10-02T09:00:00.000Z' });
  assert.equal(merge([newer], [older])[0].solution, 'حل جديد');
  assert.equal(merge([older], [newer])[0].solution, 'حل جديد');
});

test('شاهد حذف في الخادم يعلو على حلٍّ محلي: المحذوف لا يُحيا بحلٍّ', () => {
  const r = merge([solved()], [{ id: 'tr_1', deleted: true }]);
  assert.equal(r.length, 1);
  assert.equal(r[0].deleted, true, 'تحويل محذوف على الخادم أُحيي بحلٍّ محلي');
});

test('حلٌّ محلي على تحويل لم يكن موجوداً أصلاً: يُضاف', () => {
  const r = merge([solved({ id: 'tr_new' })], []);
  assert.equal(r.length, 1);
  assert.equal(r[0].solution, 'تم التواصل');
});

test('شواهد الحذف تبقى لاصقة بعد إضافة قاعدة الحل', () => {
  const r = merge(
    [{ id: 'tr_1', deleted: true }],
    [solved()]
  );
  assert.equal(r.length, 1);
  assert.equal(r[0].deleted, true, 'السحب أحياء التحويل المحذوف');
});

test('السجلات الأخرى لا تتأثر', () => {
  const r = merge([{ id: 'tr_2', reason: 'محلي' }], [solved({ id: 'tr_1' })]);
  assert.equal(r.length, 2);
  assert.equal(r.find(x => x.id === 'tr_1').solution, 'تم التواصل');
});
