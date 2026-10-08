'use strict';
/* =============================================================================
 * حق حذف التحويل: المدير وحده، في الواجهة وفي الخادم.
 * الاختبار يقرأ transfers-privacy.js المنشور نفسه لا نسخة منفصلة.
 * ========================================================================== */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const tp = require(path.join(ROOT, 'transfers-privacy.js'));
const CLIENT = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const SERVER = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');

const ADM = 'admin_1';
const AGENT = 'agent_1';
const T1 = 'tr_1';

const sess = (role, id) => ({ role, user_id: id, id });

function transfer(over = {}) {
  return {
    id: T1, studentIds: ['stu_1'], target: 'AGENT', priority: 'MEDIUM',
    reason: 'سبب', status: 'PENDING', createdBy: 'teacher_A',
    createdAt: '2026-10-01T08:00:00.000Z', ...over,
  };
}
const serverTransfers = [transfer()];

test('المدير يحذف أي تحويل', () => {
  const r = tp.enforceTransferDeleteRights([transfer({ deleted: true, deletedBy: ADM })], sess('ADMIN', ADM), serverTransfers);
  assert.equal(r.transfers[0].deleted, true);
  assert.deepEqual(r.blocked, []);
});

test('الوكيل لا يحذف', () => {
  const r = tp.enforceTransferDeleteRights([transfer({ deleted: true })], sess('AGENT', AGENT), serverTransfers);
  assert.equal(r.transfers[0].deleted, undefined);
  assert.equal(r.transfers[0].deletedAt, undefined);
  assert.equal(r.blocked.length, 1);
  assert.equal(r.blocked[0].owner, 'teacher_A');
  assert.equal(r.blocked[0].by, AGENT);
});

test('المعلم لا تحذف—even لو أرسلت deleted', () => {
  const r = tp.enforceTransferDeleteRights([transfer({ deleted: true })], sess('TEACHER', 'teacher_A'), serverTransfers);
  assert.equal(r.transfers[0].deleted, undefined);
  assert.equal(r.blocked.length, 1);
});

test('بلا جلسة لا يحذف أحد', () => {
  const r = tp.enforceTransferDeleteRights([transfer({ deleted: true })], null, serverTransfers);
  assert.equal(r.transfers[0].deleted, undefined);
  assert.equal(r.blocked.length, 1);
});

test('رفض الحذف لا يمس بقية التحويل', () => {
  const r = tp.enforceTransferDeleteRights([transfer({ deleted: true, reason: 'سبب آخر', priority: 'HIGH' })], sess('AGENT', AGENT), serverTransfers);
  assert.equal(r.transfers[0].reason, 'سبب آخر');
  assert.equal(r.transfers[0].priority, 'HIGH');
  assert.equal(r.transfers[0].id, T1);
});

test('محذوف عند الخادم أصلا: يبقى الشاهد ولا يُحيا', () => {
  const dead = [transfer({ deleted: true })];
  const r = tp.enforceTransferDeleteRights([transfer({ deleted: true })], sess('AGENT', AGENT), dead);
  assert.equal(r.transfers[0].deleted, true);
  assert.deepEqual(r.blocked, []);
});

test('حذف واحد لا يمس البقية', () => {
  const incoming = [transfer({ id: 'tr_1' }), transfer({ id: 'tr_2', deleted: true })];
  const r = tp.enforceTransferDeleteRights(incoming, sess('AGENT', AGENT), [transfer({ id: 'tr_1' })]);
  assert.equal(r.transfers.length, 2);
  assert.equal(r.transfers[0].deleted, undefined);
  assert.equal(r.transfers[1].deleted, undefined);
  assert.equal(r.blocked.length, 1);
  assert.equal(r.blocked[0].id, 'tr_2');
});

test('canDeleteTransfer بالقاعدة نفسها', () => {
  assert.equal(tp.canDeleteTransfer(transfer(), sess('ADMIN', ADM)), true);
  assert.equal(tp.canDeleteTransfer(transfer(), sess('AGENT', AGENT)), false);
  assert.equal(tp.canDeleteTransfer(transfer(), sess('TEACHER', 'teacher_A')), false);
  assert.equal(tp.canDeleteTransfer(transfer(), null), false);
});

test('الخادم ينادي حارس التحويلات', () => {
  const i = SERVER.indexOf('transferPrivacy.enforceTransferDeleteRights(data.transfers, req.session, prevTransfers)');
  assert.ok(i !== -1, 'حارس حذف التحويلات غير مربوط في الخادم');
});

test('الواجهة: الزر للمدير فقط ودالة الحذف موجودة', () => {
  const btn = CLIENT.indexOf("onclick=\"deleteTransfer('${t.id}')\"");
  assert.ok(btn !== -1, 'زر حذف التحويل غير موجود');
  const guardAt = CLIENT.indexOf('${isAdmin ? ` <button class="del-btn"');
  assert.ok(guardAt !== -1 && guardAt < btn + 40, 'الزر يجب أن يكون داخل شرط isAdmin');
  const fn = CLIENT.indexOf('function deleteTransfer(id){');
  assert.ok(fn !== -1, 'deleteTransfer غير موجودة');
  const roleCheck = CLIENT.slice(fn, fn + 260);
  assert.ok(roleCheck.includes("me.role !== 'ADMIN'"), 'deleteTransfer لا تتحقق من الدور');
  const end = CLIENT.indexOf('\nfunction ', fn + 10);
  const tomb = CLIENT.slice(fn, end === -1 ? fn + 3000 : end);
  assert.ok(tomb.includes('t.deleted = true'), 'الحذف يجب أن يكون ناعماً بشاهد');
  assert.ok(tomb.includes('__syncSchedule'), 'الحذف يجب أن يُرفع للمزامنة');
  assert.ok(tomb.includes('n.transferId'), 'الحذف يجب أن يدفن ملاحظات الخصم المرتبطة');
});

test('الواجهة: المحذوف لا يظهر في القائمة', () => {
  assert.ok(
    CLIENT.includes('if(t && t.deleted) return; // شاهد القبر'),
    'renderTransfers لا يخفي المحذوف'
  );
});