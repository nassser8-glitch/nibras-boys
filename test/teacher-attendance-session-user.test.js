/* بطاقة المعلم كانت تعرض أصفاراً: كانت تقرأ سجل الجلسة لا سجل قاعدة البيانات
 *
 * الخادم يُبقي حقول absences/markedLate/lateMinutes على جدول الحسابات
 * (USER_ATTENDANCE_FIELDS في server.js) ويحذفها من حمولة الجلسة.
 * و currentUser() في وضع الخادم يعيد __sessionUser أو مرآة الجلسة:
 *   if(__serverEnabled()){ if(__sessionUser) return __sessionUser; ... }
 * ف object الجلسة لا يحمل حقول الحضور إطلاقاً، و teacherStats(user) كانت
 * تقرأ undefined — وتُظهر أيام الغياب والتأخر والدقائق كلها صفراً لمعلم
 * عندها تأخير موثّق في السجلات.
 *
 * الفحص هنا يحاكي الإنتاج: كائن جلسة منزوع الحقول + سجل قاعدة بيانات يحملها.
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const HTML = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');

function sliceBetween(startMarker, endMarker) {
  const a = HTML.indexOf(startMarker);
  assert.ok(a !== -1, 'لم يُعثر على: ' + startMarker);
  const b = HTML.indexOf(endMarker, a);
  assert.ok(b > a, 'لم يُعثر على نهاية: ' + endMarker);
  return HTML.slice(a, b);
}

const SRC = [
  sliceBetween('function teacherSelfRecord(', 'const LATE_TYPE_NAMES'),
  'var __LEGACY_ABS = 1;',
  /* نفس تعريف التطبيق تماماً — لا بديل مُختصر، فلن يطابق نطاق السنة */
  sliceBetween('function localDateKey(d){', '\nfunction '),
  'this.teacherSelfRecord = teacherSelfRecord;',
  'this.teacherStats = teacherStats;',
].join('\n');

function api() {
  const ctx = { console, Set, Map, JSON, Object, Array, Math, Date, Number };
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx);
  return ctx;
}

/* كائن الجلسة كما يعيده الخادم: لا حقول حضور. */
const SESSION_USER = { id: 'T1', name: 'ابتسام', role: 'TEACHER', active: true };

test('كائن الجلسة فعلاً لا يحمل حقول الحضور (هذا هو سبب الأصفار)', () => {
  assert.equal(SESSION_USER.absences, undefined);
  assert.equal(SESSION_USER.markedLate, undefined);
  assert.equal(SESSION_USER.lateMinutes, undefined);
});

test('teacherStats على كائن الجلسة تعطي أصفاراً — وهذا هو العطل', () => {
  const { teacherStats } = api();
  const r = teacherStats(SESSION_USER);
  assert.equal(r.absent, 0);
  assert.equal(r.lateDays, 0);
  assert.equal(r.lateMin, 0);
});

test('teacherSelfRecord يختار سجل قاعدة البيانات لا كائن الجلسة', () => {
  const { teacherSelfRecord } = api();
  const dbUser = { id: 'T1', name: 'ابتسام', absences: ['2026-02-01'], markedLate: ['2026-02-02', '2026-02-03'] };
  const d = { users: [dbUser] };
  const rec = teacherSelfRecord(d, SESSION_USER);
  assert.equal(rec, dbUser, 'يجب أن يعود سجل قاعدة البيانات');
  assert.deepEqual(rec.absences, ['2026-02-01']);
  assert.equal(rec.markedLate.length, 2);
});

test('المعلم التي عندها تأخير: العدّادات تظهر أخيراً', () => {
  const { teacherSelfRecord, teacherStats } = api();
  const now = new Date();
  function localKey(dt){ return dt.getFullYear() + '-' + String(dt.getMonth() + 1).padStart(2, '0') + '-' + String(dt.getDate()).padStart(2, '0'); }
  /* تواريخ داخل السنة الدراسية الجارية (الآن داخل النطاق دائماً) */
  const mk = n => localKey(new Date(now.getFullYear(), now.getMonth(), Math.min(n, 28)));
  const d = { users: [{
    id: 'T1', name: 'ابتسام', role: 'TEACHER', active: true,
    absences: [mk(2)],
    markedLate: [mk(3), mk(4)],
    lateMinutes: { [mk(3)]: 12 },
  }] };
  const r = teacherStats(teacherSelfRecord(d, SESSION_USER));
  assert.equal(r.absent, 1, 'غياب واحد يجب أن يظهر — لا صفر');
  assert.equal(r.lateDays, 2, 'يومان تأخر يجب أن يظهروا — لا صفر');
  assert.equal(r.lateMin, 12, 'دقائق التأخر يجب أن تظهر');
});

test('إن كان سجل قاعدة البيانات غائباً نتراجع إلى كائن الجلسة بلا انهيار', () => {
  const { teacherSelfRecord, teacherStats } = api();
  const rec = teacherSelfRecord({ users: [] }, SESSION_USER);
  assert.equal(rec, SESSION_USER);
  const r = teacherStats(rec);
  assert.equal(r.absent, 0);
  assert.equal(r.lateDays, 0);
  assert.equal(r.lateMin, 0);
});

test('مستخدم بلا id لا يكسر الاختيار', () => {
  const { teacherSelfRecord } = api();
  assert.doesNotThrow(() => teacherSelfRecord({ users: [{ id: 'X' }] }, null));
  assert.doesNotThrow(() => teacherSelfRecord(null, SESSION_USER));
  assert.doesNotThrow(() => teacherSelfRecord({}, undefined));
});

test('لوحة المعلم تستدعي teacherSelfRecord لا كائن الجلسة مباشرة', () => {
  const PANEL = sliceBetween('${isTeacher ? (() => {', '\n    function kpiPill(');
  assert.ok(/teacherStats\(teacherSelfRecord\(d, user\)\)/.test(PANEL),
    'لوحة الالتزام بالدوام يجب أن تقرأ السجل من قاعدة البيانات');
  assert.ok(!/teacherStats\(user\)/.test(PANEL),
    'لا يجوز تمرير كائن الجلسة مباشرة');
});

test('كل نداءات teacherStats في renderDashboard تمرّ بالمساعد', () => {
  /* نداء renderTeacherPage يمرّر سجل قاعدة البيانات مباشرةً عبر userById،
   * وهو صحيح. المطلوب أن نداءَي لوحةَ الداشبورد يمرّان بالمساعد. */
  const calls = HTML.match(/teacherStats\([^)]*\)/g) || [];
  assert.ok(calls.length >= 3, 'نداءات teacherStats موجودة أصلاً: ' + calls.length);
  const selfCalls = calls.filter(c => /teacherSelfRecord/.test(c));
  assert.equal(selfCalls.length, 2,
    'ندعاءا renderDashboard يمرّان بالمساعد — تحقّق من: ' + calls.join(' | '));
  /* ولا يجوز تمرير كائن الجلسة وحده: currentUser() لا يحمل حقول الحضور. */
  const sessionOnly = calls.filter(c => /^\s*teacherStats\(\s*user\s*\)$/.test(c));
  assert.equal(sessionOnly.length, 1,
    'يبقى نداء واحد بلا مساعد — وهو renderTeacherPage ويقرأ من userById');
});