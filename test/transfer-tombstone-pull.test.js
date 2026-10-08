'use strict';
/* =============================================================================
 * شاهد حذف التحويل كان يُسقط عند السحب (locallyOnly) فيعود السجل بعد التحديث.
 * الاختبار يستخرج الدالة من public/index.html المنشور نفسه ويختبرها سلوكياً.
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
const mergeTransfersPull = new Function(extractFn(CLIENT, '__mergeTransfersPull') + '; return __mergeTransfersPull;')();

const T = (over = {}) => Object.assign({ id: 'tr_1', target: 'AGENT', status: 'PENDING' }, over);
const dead = (id) => ({ id, deleted: true, deletedAt: '2026-10-01T09:00:00.000Z', deletedBy: 'admin_1' });

test('العلة: شاهد الحذف المحلي يعلو على النسخة الحيّة في الخادم', () => {
  const r = mergeTransfersPull([dead('tr_1')], [T()]);
  assert.equal(r.length, 1);
  assert.equal(r[0].deleted, true);
  assert.equal(r[0].deletedBy, 'admin_1');
});

test('شاهد الخادم لاصق: النسخة المحلية الحيّة لا تُحياه', () => {
  const r = mergeTransfersPull([T()], [dead('tr_1')]);
  assert.equal(r.length, 1);
  assert.equal(r[0].deleted, true);
});

test('سجل محلي جديد لا id له في الخادم: يُحفظ (سلوك previouslyOnly)', () => {
  const r = mergeTransfersPull([T({ id: 'tr_new' })], [T()]);
  assert.equal(r.length, 2);
  assert.ok(r.some(x => x.id === 'tr_new'));
});

test('تحويل حيّ عدّله هذا الجهاز: الخادم يكسب للمعرّف المشترك', () => {
  const r = mergeTransfersPull([T({ reason: 'سبب محلي' })], [T({ reason: 'سبب الخادم' })]);
  assert.equal(r.length, 1);
  assert.equal(r[0].reason, 'سبب الخادم');
});

test('حذف تحويل واحد لا يمس البقية ولا resurrect', () => {
  const r = mergeTransfersPull(
    [T({ id: 'tr_1', deleted: true }), T({ id: 'tr_2' })],
    [T({ id: 'tr_1' }), T({ id: 'tr_2' }), T({ id: 'tr_3' })]
  );
  assert.equal(r.length, 3);
  assert.equal(r.find(x => x.id === 'tr_1').deleted, true);
  assert.equal(r.find(x => x.id === 'tr_2').deleted, undefined);
  assert.ok(r.find(x => x.id === 'tr_3'));
});

test('قائمة فارغة في أحد الطرفين: لا ينهار', () => {
  assert.deepEqual(mergeTransfersPull([], [T()]), [T()]);
  assert.deepEqual(mergeTransfersPull([T()], []), [T()]);
  assert.deepEqual(mergeTransfersPull([], []), []);
  assert.deepEqual(mergeTransfersPull(undefined, [T()]), [T()]);
});

test('معرّف بلا id: لا ينهار', () => {
  const anon = { target: 'AGENT', note: 'بلا id' };
  const r = mergeTransfersPull([anon], [anon]);
  assert.equal(r.length, 1);
});

test('موضعا الدمج يستخدمان الدالة للقسم transfers', () => {
  const pull = CLIENT.indexOf("(sec === 'transfers') ? __mergeTransfersPull(obj[sec], sd[sec])");
  const refresh = CLIENT.indexOf("? __mergeTransfersPull(local[sec], merged[sec])");
  assert.ok(pull !== -1, 'سحب المزامنة لا يستخدم دمج شواهد التحويلات');
  assert.ok(refresh !== -1, 'تحديث المدرسة لا يستخدم دمج شواهد التحويلات');
});