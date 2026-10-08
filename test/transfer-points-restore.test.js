'use strict';
/* =============================================================================
 * حذف التحويل كان يُخفي الطلب ويبقى الخصم التلقائي في رصيد الطالب:
 * الخصم ملاحظات سالبة مرتبطة بـ transferId لا خانة في سجل التحويل.
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

function harness(over = {}) {
  const st = { alert: [], confirm: true, render: 0, schedule: 0, log: [] };
  const ctx = {
    __name: 'deleteTransfer',
    currentUser: () => st.me,
    loadDB: () => st.d,
    saveDB: (d) => { st.saved = d; },
    renderApp: () => { st.render++; },
    alert: (m) => st.alert.push(m),
    confirm: (m) => { st.prompt = m; return st.confirm; },
    studentIdsOf: (t) => t.studentIds || [],
    getActiveSchool: () => 'school-1',
    __syncSchedule: () => { st.schedule++; },
    __syncLogAdd: (e) => st.log.push(e),
    __pointsTotals: () => st.pts,
    Date,
    JSON,
    String,
    Array,
    Object,
    ...over.ctx,
  };
  st.run = new Function('ctx',
    'with(ctx){ ' + extractFn(CLIENT, 'deleteTransfer') + '; return deleteTransfer; }')(ctx);
  return st;
}

const ME = { id: 'admin_1', name: 'المدير', role: 'ADMIN' };
function build() {
  return {
    me: ME,
    pts: { stale: false },
    d: {
      students: [{ id: 's1', fullName: 'طالب' }],
      transfers: [{ id: 'tr_1', studentIds: ['s1'], deductedPoints: -3, status: 'PENDING' }],
      notes: [
        { id: 'n1', studentId: 's1', type: 'NEGATIVE', category: ' misconduct', points: -3, transferId: 'tr_1' },
        { id: 'n2', studentId: 's1', type: 'NEGATIVE', category: 'تأخر', points: -3, transferId: 'tr_1' },
        { id: 'n3', studentId: 's1', type: 'POSITIVE', category: 'تفوق', points: 5, transferId: 'tr_1' },
        { id: 'n4', studentId: 's1', type: 'NEGATIVE', category: 'غياب', points: -2, transferId: 'tr_9' },
      ],
    },
  };
}

test('حذف التحويل يدفن ملاحظات الخصم المرتبطة به فتعود النقاط', () => {
  const st = harness(); Object.assign(st, build());
  st.run('tr_1');
  const n1 = st.d.notes.find(n => n.id === 'n1');
  assert.equal(n1.deleted, true, 'ملاحظة الخصم لم تُدفن');
  assert.equal(n1.deletedWithTransfer, 'tr_1');
  assert.equal(n1.deletedBy, 'admin_1');
  assert.ok(n1.deletedAt);
});

test('لا يمس ملاحظات تحويل آخر ولاPositive', () => {
  const st = harness(); Object.assign(st, build());
  st.run('tr_1');
  assert.equal(st.d.notes.find(n => n.id === 'n3').deleted, undefined, 'ملاحظة إيجابية مرتبطة لا تُمس');
  assert.equal(st.d.notes.find(n => n.id === 'n4').deleted, undefined, 'خصم تحويل آخر لا يُمس');
});

test('يبلّغ عن عدد النقاط التي عادت ويُبطل الأرصدة المخزّنة', () => {
  const st = harness(); Object.assign(st, build());
  st.run('tr_1');
  const ev = st.log.find(e => e.ev === 'transfer-deleted');
  assert.equal(ev.notesRestored, 2, 'عدد الملاحظات المدفونة غير صحيح');
  assert.equal(st.pts.stale, true, 'أرصدة الخادم المخزّنة لم تُعلَّم على أنها قديمة');
});

test('رسالة التأكيد تذكر عودة النقاط', () => {
  const st = harness(); Object.assign(st, build());
  st.run('tr_1');
  assert.ok(/تعود النقاط/.test(st.prompt), 'التأكيد لا يذكر عودة النقاط');
});

test('تحويل بلا خصم: لا أثر له', () => {
  const st = harness(); Object.assign(st, build());
  st.d.transfers[0].deductedPoints = 0;
  st.d.notes = [];
  st.run('tr_1');
  assert.equal(st.log.find(e => e.ev === 'transfer-deleted').notesRestored, 0);
});

test('الرفض بالمconfirm لا يحذف شيئاً', () => {
  const st = harness(); Object.assign(st, build());
  st.confirm = false;
  st.run('tr_1');
  assert.equal(st.d.transfers[0].deleted, undefined);
  assert.equal(st.d.notes.find(n => n.id === 'n1').deleted, undefined);
  assert.equal(st.saved, undefined, 'لا حفظ عند الرفض');
});

test('غير المدير: لا حذف ولا تعديل', () => {
  const st = harness(); Object.assign(st, build());
  st.me = { id: 't1', name: 'معلم', role: 'TEACHER' };
  st.run('tr_1');
  assert.equal(st.d.transfers[0].deleted, undefined);
  assert.equal(st.d.notes.find(n => n.id === 'n1').deleted, undefined);
  assert.ok(st.alert.length);
});

test('محذوف مسبقاً: لا إعادة', () => {
  const st = harness(); Object.assign(st, build());
  st.d.transfers[0].deleted = true;
  st.run('tr_1');
  assert.equal(st.d.notes.find(n => n.id === 'n1').deleted, undefined);
  assert.ok(st.alert.length);
});