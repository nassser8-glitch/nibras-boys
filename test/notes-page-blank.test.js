'use strict';
/* =============================================================================
 * شاشة الملاحظات كانت تُسقط الصفحة كلها (شاشة بيضاء) إن كان قسم
 * الملاحظات غير موجود في نسخة الجهاز. السبب: d.notes.slice() بلا فحص، فيخرج
 * الاستثناء من renderApp قبل كتابة أي HTML ولا يظهر شيء ولا رسالة.
 * ========================================================================== */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const CLIENT = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');

const EMPTY_ROW = 'لا توجد ملاحظات بعد';

// تُقصّ دالة renderNotes من الملف المنشور نفسه، فلا يمر الاختبار بسبب نسخة منفصلة
const START = CLIENT.indexOf('function renderNotes(){');
const END = CLIENT.indexOf('/* ===== طابور مطالبات', START);
assert.ok(START !== -1 && END > START, 'تعذر قصّ renderNotes من index.html');
const SRC = CLIENT.slice(START, END);

const TEACHER = { id: 'teacher_A', role: 'TEACHER' };
const ADMIN = { id: 'admin_1', role: 'ADMIN' };

function renderNotesWith(doc, user) {
  const ctx = {
    loadDB: () => doc,
    currentUser: () => user,
    NRC_isAdminNotesRole: (u) => !!u && (u.role === 'ADMIN' || u.role === 'AGENT'),
    NRC_canSeeNote: (n) => (user.role === 'ADMIN' || user.role === 'AGENT') || String(n.createdBy || '') === String(user.id),
    NRC_claimableLegacyNotes: () => [],
    NRC_noteHasPendingClaim: () => false,
    NRC_deletableNote: () => false,
    NRC_claimsQueueHtml: () => '',
    studentPointsMap: () => new Map(),
    studentById: () => null,
    userById: () => null,
    notePoints: () => 0,
    escapeHtml: (s) => String(s ?? ''),
    studentNameLink: (s) => String(s || ''),
    getClassesSorted: () => [],
    classLabel: (c) => String((c && c.name) || ''),
    noteCategoriesPositive: ['الانضباط'],
    renderNotebookSection: () => '',
    console,
  };
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx);
  return vm.runInContext('renderNotes()', ctx);
}

test('قسم الملاحظات مفقود كلياً: الصفحة تُبنى ولا ترمي استثناءً', () => {
  const html = renderNotesWith({ users: [], students: [] }, TEACHER);
  assert.equal(typeof html, 'string');
  assert.ok(html.includes(EMPTY_ROW), 'يجب أن يظهر صف الفراغ بدل الشاشة البيضاء');
});

test('قسم الملاحظات فارغ: يُعرض صف الفراغ', () => {
  const html = renderNotesWith({ notes: [] }, TEACHER);
  assert.ok(html.includes(EMPTY_ROW));
});

test('قسم الملاحظات null: الصفحة تُبنى', () => {
  const html = renderNotesWith({ notes: null }, TEACHER);
  assert.ok(html.includes(EMPTY_ROW));
});

test('قسم الملاحظات ليس مصفوفة: الصفحة تُبنى', () => {
  const html = renderNotesWith({ notes: { a: 1 } }, ADMIN);
  assert.ok(html.includes(EMPTY_ROW));
});

test('الطالب بلا بيانات بلا قسم ملاحظات: الصفحة تُبنى', () => {
  const student = { id: 'stu_1', role: 'STUDENT' };
  const html = renderNotesWith({ students: [] }, student);
  assert.ok(html.includes(EMPTY_ROW));
});

test('ملاحظة قائمة: تُعرض في الجدول', () => {
  const doc = { notes: [{ id: 'n1', studentId: 'stu_1', type: 'POSITIVE', category: 'الانضباط', description: 'ملاحظة تجريبية', createdBy: 'teacher_A', createdByName: 'معلم', createdAt: '2026-10-01T08:00:00.000Z', points: 5 }] };
  const html = renderNotesWith(doc, TEACHER);
  assert.ok(html.includes('ملاحظة تجريبية'), 'يجب أن تظهر الملاحظة');
  assert.ok(!html.includes(EMPTY_ROW), 'لا يظهر صف الفراغ مع وجود ملاحظة');
});

test('loadDB يرمّم كل قسم ناقص ومنها الملاحظات', () => {
  assert.ok(
    /if\(!Array\.isArray\(d\[k\]\)\)\{ d\[k\] = \[\]; cleaned = true; \}/.test(CLIENT),
    'ترميم الأقسام الناقصة غير موجود'
  );
  const list = CLIENT.match(/'users','grades','classes','students','attendance','notes','transfers','maintenance','adminMsgs','announcements','suggestions'/);
  assert.ok(list, 'قائمة الأقسام المزرَّمة لا تشمل notes');
});

test('renderApp محاط بحارس يعرض الخطأ بدل الشاشة البيضاء', () => {
  const i = CLIENT.indexOf('function renderApp(){');
  assert.ok(i !== -1, 'renderApp غير موجود');
  const body = CLIENT.slice(i, i + 200);
  assert.ok(body.includes('try{ __renderAppInner(); }'), 'renderApp غير محاط بحارس');
  assert.ok(body.includes('catch(e){ __showRenderError(e); }'), 'لا يوجد عرض للخطأ');
  assert.ok(CLIENT.includes('function __showRenderError(e){'), 'دالة عرض الخطأ غير موجودة');
  assert.ok(CLIENT.includes("window.addEventListener('hashchange', renderApp)"), 'التنقل بالهاش ما زال مربوطاً بالحارس');
});