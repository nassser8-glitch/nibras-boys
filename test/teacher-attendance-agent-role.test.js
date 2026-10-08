'use strict';

// يسمح لوكيل الشؤون المدرسية (SCHOOL_AGENT) بتسجيل غياب/تأخر المعلمين والإداريين
// (حقول absences/markedLate على كائن المستخدم)، دون أن تمسّ أي حقل حساس آخر في الحساب
// (الدور/كلمة المرور/الإلغاء/الاسم). يُستخرج الدوال الحقيقية من server.js عبر vm.

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SERVER_PATH = path.join(__dirname, '..', 'server.js');

function extractConst(marker) {
  const src = fs.readFileSync(SERVER_PATH, 'utf8');
  const startIdx = src.indexOf('const ' + marker);
  if (startIdx === -1) throw new Error('const not found in server.js: ' + marker);
  const end = src.indexOf(';', src.indexOf(']', startIdx));
  return src.slice(startIdx, end + 1);
}

function extractFn(marker) {
  const src = fs.readFileSync(SERVER_PATH, 'utf8');
  const startIdx = src.indexOf('function ' + marker + '(');
  if (startIdx === -1) throw new Error('function not found in server.js: ' + marker);
  const openBrace = src.indexOf('{', startIdx);
  let depth = 0, i = openBrace;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) break; }
  }
  return src.slice(startIdx, i + 1);
}

function loadMergeUsersAttendanceOnly() {
  const context = { console, JSON, Array, Object, Map, Set };
  vm.createContext(context);
  vm.runInContext(extractConst('USER_ATTENDANCE_FIELDS') + '; globalThis.__fields = USER_ATTENDANCE_FIELDS;', context);
  vm.runInContext(extractFn('attTsOf'), context);
  vm.runInContext(extractFn('mergeUsersAttendanceOnly'), context);
  vm.runInContext(extractFn('mergeUsersAttendanceNewer'), context);
  return context;
}

function serverUsers() {
  return [
    { id: 'u_teacher', name: 'معلم', role: 'TEACHER', email: 't@nibras.school', active: true, absences: [], markedLate: {} },
    { id: 'u_admin', name: 'وكيل', role: 'SCHOOL_AGENT', email: 'a@nibras.school', active: true, absences: [], markedLate: {} },
  ];
}

test('قبول تسجيل غياب/تأخر المعلم والإدارية (وكيل الشؤون المدرسية)', () => {
  const { mergeUsersAttendanceOnly } = loadMergeUsersAttendanceOnly();
  const incoming = [
    { id: 'u_teacher', absences: ['2026-01-04'], markedLate: {}, lateMinutes: { '2026-01-04': 10 }, lateType: { '2026-01-04': 'MORNING' } },
    { id: 'u_admin', absences: [], markedLate: ['2026-01-04'] },
  ];
  const out = mergeUsersAttendanceOnly(serverUsers(), incoming);
  const t = out.find(u => u.id === 'u_teacher');
  const a = out.find(u => u.id === 'u_admin');
  assert.deepEqual(t.absences, ['2026-01-04'], 'غياب المعلم يُحفظ');
  assert.equal(t.lateMinutes['2026-01-04'], 10, 'دقائق تأخر المعلم تُحفظ');
  assert.equal(t.lateType['2026-01-04'], 'MORNING', 'نوع تأخر المعلم يُحفظ');
  assert.deepEqual(a.markedLate, ['2026-01-04'], 'تأخر الإدارية يُحفظ');
});

test('إلغاء غياب المعلم (قائمة absences فارغة) يُحفظ بدل بقائه', () => {
  const { mergeUsersAttendanceOnly } = loadMergeUsersAttendanceOnly();
  const prev = [{ id: 'u_teacher', role: 'TEACHER', active: true, absences: ['2026-01-04'], markedLate: [] }];
  const out = mergeUsersAttendanceOnly(prev, [{ id: 'u_teacher', absences: [], markedLate: [] }]);
  assert.deepEqual(out[0].absences, [], 'إلغاء الغياب يجب أن يفرّغ القائمة');
});

test('لا تُقبل إضافة حسابات جديدة ولا حذف حسابات قائمة', () => {
  const { mergeUsersAttendanceOnly } = loadMergeUsersAttendanceOnly();
  const prev = serverUsers();
  const out = mergeUsersAttendanceOnly(prev, [{ id: 'u_intruder', role: 'ADMIN', active: true }]);
  assert.equal(out.length, prev.length, 'الحساب الجديد يُتجاهل');
  assert.equal(out.some(u => u.id === 'u_intruder'), false);
});

test('الحقول الحسّاسة تبقى كما على الخادم (الدور/البريد/الاسم/الإلغاء)', () => {
  const { mergeUsersAttendanceOnly } = loadMergeUsersAttendanceOnly();
  const prev = [{ id: 'u_teacher', name: 'معلم', role: 'TEACHER', email: 't@nibras.school', active: true, absences: [] }];
  const hostile = [{
    id: 'u_teacher', name: 'مُختَرَق', role: 'ADMIN', email: 'evil@x.com', active: false,
    password: 'hacked', absences: ['2026-01-04'],
  }];
  const out = mergeUsersAttendanceOnly(prev, hostile);
  assert.equal(out[0].role, 'TEACHER', 'الدور لا يتغير');
  assert.equal(out[0].name, 'معلم', 'الاسم لا يتغير');
  assert.equal(out[0].email, 't@nibras.school', 'البريد لا يتغير');
  assert.equal(out[0].active, true, 'حالة التفعيل لا تتغير');
  assert.equal(out[0].password, undefined, 'لا تُحقن كلمة مرور');
  assert.deepEqual(out[0].absences, ['2026-01-04'], 'لكن حقول الحضور تُحفظ');
});

test('قائمة الحقول المسموح بها هي حقول الحضور فقط', () => {
  const { __fields: USER_ATTENDANCE_FIELDS } = loadMergeUsersAttendanceOnly();
  assert.deepEqual(Array.from(USER_ATTENDANCE_FIELDS), ['absences', 'markedLate', 'lateMinutes', 'lateType']);
});

test('إلغاء التأخر من جهاز أحدث يُحفظ (لا يعود من ختم أقدم)', () => {
  const { mergeUsersAttendanceOnly } = loadMergeUsersAttendanceOnly();
  const prev = [{ id: 'u_teacher', role: 'TEACHER', active: true, absences: [], markedLate: ['2026-01-04'], _attTs: 1000 }];
  const out = mergeUsersAttendanceOnly(prev, [{ id: 'u_teacher', absences: [], markedLate: [], _attTs: 2000 }]);
  assert.deepEqual(out[0].markedLate, [], 'إلغاء التأخر يجب أن يفرّغ القائمة');
  assert.equal(out[0]._attTs, 2000, 'الختم الزمني يتقدّم');
});

test('جهاز أقدم لا يُعيد إحياء غياب/تأخر أُلغي على جهاز أحدث', () => {
  const { mergeUsersAttendanceOnly } = loadMergeUsersAttendanceOnly();
  const prev = [{ id: 'u_teacher', role: 'TEACHER', active: true, absences: [], markedLate: ['2026-01-04'], _attTs: 5000 }];
  const staleDevice = [{ id: 'u_teacher', absences: ['2026-01-04'], markedLate: ['2026-01-04'], _attTs: 1000 }];
  const out = mergeUsersAttendanceOnly(prev, staleDevice);
  assert.deepEqual(out[0].markedLate, ['2026-01-04'], 'الخادم الأحدث يبقى كما هو');
  assert.deepEqual(out[0].absences, [], 'ولا يُعاد إحياء الغياب الملغى');
  assert.equal(out[0]._attTs, 5000);
});

test('جهاز بلا ختم زمني (نسخة قديمة) لا يُعيد إحياء ما أُلغي على الخادم', () => {
  const { mergeUsersAttendanceOnly } = loadMergeUsersAttendanceOnly();
  const prev = [{ id: 'u_teacher', role: 'TEACHER', active: true, absences: [], markedLate: ['2026-01-04'], _attTs: 5000 }];
  const out = mergeUsersAttendanceOnly(prev, [{ id: 'u_teacher', absences: ['2026-01-04'], markedLate: ['2026-01-04'] }]);
  assert.deepEqual(out[0].markedLate, ['2026-01-04'], 'الخادم المختموم يبقى كما هو');
  assert.deepEqual(out[0].absences, [], 'ولا يعود الغياب الملغى');
  assert.equal(out[0]._attTs, 5000, 'الختم على الخادم يبقى');
});

test('جهازان بلا ختم زمني: يبقى الاتحاد كما كان (سلوك قديم محفوظ)', () => {
  const { mergeUsersAttendanceOnly } = loadMergeUsersAttendanceOnly();
  const prev = [{ id: 'u_teacher', role: 'TEACHER', active: true, absences: [], markedLate: ['2026-01-04'] }];
  const out = mergeUsersAttendanceOnly(prev, [{ id: 'u_teacher', absences: ['2026-01-05'], markedLate: [] }]);
  assert.deepEqual(out[0].absences, ['2026-01-05'], 'لا ختم على أي طرف = القواعد القديمة');
  assert.deepEqual(out[0].markedLate, [], 'إلغاء التأخر يُحفظ');
});

test('المدير/الوكيل: تعديلات السجل تُحفظ لكن حضوره الأقدم لا يُعيد الإلغاء', () => {
  const { mergeUsersAttendanceNewer } = loadMergeUsersAttendanceOnly();
  const prev = [{ id: 'u_teacher', name: 'نهلة', role: 'TEACHER', active: true, absences: [], markedLate: ['2026-01-04'], _attTs: 9000 }];
  const adminPush = [{ id: 'u_teacher', name: 'نهلة عبد الله', role: 'TEACHER', active: true, absences: ['2026-01-04'], markedLate: ['2026-01-04'], _attTs: 2000 }];
  const out = mergeUsersAttendanceNewer(prev, adminPush);
  assert.equal(out[0].name, 'نهلة عبد الله', 'تعديل الاسم من المدير يُحفظ');
  assert.deepEqual(out[0].markedLate, ['2026-01-04'], 'التأخر الملغى لا يعود');
  assert.deepEqual(out[0].absences, [], 'الغياب الملغى لا يعود');
  assert.equal(out[0]._attTs, 9000);
});

test('المدير/الوكيل: جهاز أحدث يُطبّق إلغاؤه مع بقاء تعديلات السجل', () => {
  const { mergeUsersAttendanceNewer } = loadMergeUsersAttendanceOnly();
  const prev = [{ id: 'u_teacher', name: 'نهلة', role: 'TEACHER', active: true, absences: ['2026-01-04'], markedLate: ['2026-01-04'], _attTs: 1000 }];
  const adminPush = [{ id: 'u_teacher', name: 'نهلة', role: 'TEACHER', active: false, absences: [], markedLate: [], _attTs: 7000 }];
  const out = mergeUsersAttendanceNewer(prev, adminPush);
  assert.equal(out[0].active, false, 'تعطيل الحساب من المدير يُحفظ');
  assert.deepEqual(out[0].absences, [], 'إلغاء الغياب يُحفظ');
  assert.deepEqual(out[0].markedLate, [], 'إلغاء التأخر يُحفظ');
});
