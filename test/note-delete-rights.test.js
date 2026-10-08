'use strict';
/* =============================================================================
 * حق حذف الملاحظة على الخادم — مرآة لقاعدة الواجهة:
 * المدير يحذف أي ملاحظة، والمعلم تحذف ملاحظتها هي فقط، وسائر الأدوار
 * لا تحذف. الاختبار يقرأ notes-privacy.js المنشور himself لا نسخة منفصلة.
 * ========================================================================== */
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const np = require(path.join(ROOT, 'notes-privacy.js'));

const A = 'teacher_A';
const B = 'teacher_B';
const ADM = 'admin_1';
const AGENT = 'agent_1';

const sess = (role, id) => ({ role, user_id: id, id });

function note(over = {}) {
  return {
    id: 'n1', studentId: 'stu_1', type: 'POSITIVE', category: 'الانضباط',
    description: 'نص', points: 5, createdBy: A, createdAt: '2026-10-01T08:00:00.000Z',
    ...over,
  };
}
// نسخة الخادم: الملاحظة قائمة وغير محذوفة
const serverNotes = [note()];

test('المدير يحذف ملاحظة أي', () => {
  const incoming = [note({ deleted: true, deletedAt: 'x', deletedBy: ADM })];
  const r = np.enforceNoteDeleteRights(incoming, sess('ADMIN', ADM), serverNotes);
  assert.equal(r.notes[0].deleted, true);
  assert.deepEqual(r.blocked, []);
});

test('المعلم تحذف ملاحظتها هي', () => {
  const incoming = [note({ deleted: true, deletedBy: A })];
  const r = np.enforceNoteDeleteRights(incoming, sess('TEACHER', A), serverNotes);
  assert.equal(r.notes[0].deleted, true);
  assert.deepEqual(r.blocked, []);
});

test('المعلم لا تحذف ملاحظة زميلتها', () => {
  const incoming = [note({ deleted: true, deletedAt: 'x', deletedBy: B })];
  const r = np.enforceNoteDeleteRights(incoming, sess('TEACHER', B), serverNotes);
  assert.equal(r.notes[0].deleted, undefined, 'يجب أن يُلغى عَلَم الحذف');
  assert.equal(r.notes[0].deletedAt, undefined);
  assert.equal(r.notes[0].deletedBy, undefined);
  assert.equal(r.blocked.length, 1);
  assert.equal(r.blocked[0].owner, A);
  assert.equal(r.blocked[0].by, B);
});

test('الوكيل لا تحذف', () => {
  const incoming = [note({ deleted: true })];
  const r = np.enforceNoteDeleteRights(incoming, sess('AGENT', AGENT), serverNotes);
  assert.equal(r.notes[0].deleted, undefined);
  assert.equal(r.blocked.length, 1);
});

test('بلا جلسة لا تحذف أحد', () => {
  const r = np.enforceNoteDeleteRights([note({ deleted: true })], null, serverNotes);
  assert.equal(r.notes[0].deleted, undefined);
  assert.equal(r.blocked.length, 1);
});

test('رفض الحذف لا يمس بقية الملاحظة', () => {
  const incoming = [note({ deleted: true, points: 7, category: 'التعاون', description: 'نص آخر' })];
  const r = np.enforceNoteDeleteRights(incoming, sess('TEACHER', B), serverNotes);
  assert.equal(r.notes[0].points, 7);
  assert.equal(r.notes[0].category, 'التعاون');
  assert.equal(r.notes[0].description, 'نص آخر');
  assert.equal(r.notes[0].id, 'n1');
});

test('ملاحظة غير محذوفة تبقى كما هي', () => {
  const r = np.enforceNoteDeleteRights([note()], sess('TEACHER', B), serverNotes);
  assert.equal(r.notes[0].deleted, undefined);
  assert.deepEqual(r.blocked, []);
});

test('محذوفة عند الخادم أصلا: يبقى الشاهد ولا يُحيى', () => {
  const dead = [note({ deleted: true })];
  const incoming = [note({ deleted: true })];
  const r = np.enforceNoteDeleteRights(incoming, sess('TEACHER', B), dead);
  assert.equal(r.notes[0].deleted, true);
  assert.deepEqual(r.blocked, []);
});

test('حذف سجل واحد لا يمس البقية', () => {
  const incoming = [note({ id: 'n1' }), note({ id: 'n2', deleted: true })];
  const r = np.enforceNoteDeleteRights(incoming, sess('TEACHER', B), [note({ id: 'n1' })]);
  assert.equal(r.notes.length, 2);
  assert.equal(r.notes[0].deleted, undefined);
  assert.equal(r.notes[1].deleted, undefined);
  assert.equal(r.blocked.length, 1);
  assert.equal(r.blocked[0].id, 'n2');
});

test('canDeleteNote بالقواعد نفسها', () => {
  assert.equal(np.canDeleteNote(note(), sess('ADMIN', ADM)), true);
  assert.equal(np.canDeleteNote(note(), sess('TEACHER', A)), true);
  assert.equal(np.canDeleteNote(note(), sess('TEACHER', B)), false);
  assert.equal(np.canDeleteNote(note(), sess('AGENT', AGENT)), false);
  assert.equal(np.canDeleteNote(note({ createdBy: null }), sess('TEACHER', A)), false);
  assert.equal(np.canDeleteNote(note(), null), false);
});

test('الخادم ينادي الحارس بعد فرض المالك', () => {
  const fs = require('fs');
  const src = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  const ownerAt = src.indexOf('notePrivacy.enforceNoteOwners(data.notes, req.session, prevNotes)');
  const delAt = src.indexOf('notePrivacy.enforceNoteDeleteRights(data.notes, req.session, prevNotes)');
  assert.ok(ownerAt !== -1 && delAt !== -1, 'أحد النداءين غير موجود');
  assert.ok(ownerAt < delAt, 'حق الحذف يجب أن يُطبَّق بعد فرض المالك');
});