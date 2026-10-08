'use strict';

// allows only SCHOOL_AGENT (وكيل الشؤون المدرسية) to see the teachers list and
// write teacher/admin absence & lateness. Extracted from public/index.html via vm.

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const INDEX_HTML_PATH = path.join(__dirname, '..', 'public', 'index.html');

function extractFn(marker) {
  const src = fs.readFileSync(INDEX_HTML_PATH, 'utf8');
  const startIdx = src.indexOf('function ' + marker + '(');
  if (startIdx === -1) throw new Error('function not found in index.html: ' + marker);
  const openBrace = src.indexOf('{', startIdx);
  let depth = 0, i = openBrace;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) break; }
  }
  return src.slice(startIdx, i + 1);
}

function loadRoleHelpers() {
  const context = { console, JSON, Array, Object, Math };
  vm.createContext(context);
  for (const m of ['isManager', 'isAdminRole', 'canManageTeachers']) {
    vm.runInContext(extractFn(m), context);
  }
  return context;
}

test('وكيل الشؤون المدرسية مسموح لها بإدارة حضور المعلمين', () => {
  const { canManageTeachers } = loadRoleHelpers();
  assert.equal(canManageTeachers({ role: 'SCHOOL_AGENT' }), true);
  assert.equal(canManageTeachers({ role: 'ADMIN' }), true, 'المدير كما كان');
  assert.equal(canManageTeachers({ role: 'AGENT' }), true, 'الوكيل كما كان');
});

test('بقية الأدوار المدرسية تبقى بلا صلاحية حضور المعلمين', () => {
  const { canManageTeachers } = loadRoleHelpers();
  for (const role of ['COUNSELOR', 'ADMINISTRATIVE', 'TEACHER', 'STUDENT']) {
    assert.equal(canManageTeachers({ role }), false, role + ' must not manage teachers');
  }
  assert.ok(!canManageTeachers(null), 'لا مستخدم = لا صلاحية');
});

function loadUserAttMerge() {
  const context = { console, JSON, Array, Object, Map, Set, Date, isFinite };
  vm.createContext(context);
  for (const m of ['__attTsOf', '__attSig', '__attTouch', '__mergeUserAtt', '__mergeUsersAttendanceList']) {
    vm.runInContext(extractFn(m), context);
  }
  return context;
}

test('سحب قائمة المستخدمين: لا يُسقط حساباً جديداً ولا يغيّر الترتيب', () => {
  const { __mergeUsersAttendanceList } = loadUserAttMerge();
  const local = [
    { id: 'u_a', name: 'نهلة', absences: [], markedLate: [] },
    { id: 'u_b', name: 'سارة', absences: ['2026-01-05'], markedLate: [] },
  ];
  const server = [
    { id: 'u_b', name: 'سارة', absences: ['2026-01-05'], markedLate: [], _attTs: 5000 },
    { id: 'u_c', name: 'هند', absences: ['2026-01-04'], markedLate: [], _attTs: 6000 },
  ];
  const out = __mergeUsersAttendanceList(local, server);
  assert.deepEqual(Array.from(out, u => u.id), ['u_a', 'u_b', 'u_c'], 'الترتيب والحسابات كلها كما هي');
  assert.equal(out[2].name, 'هند', 'الحساب الجديد من الخادم أُضيف');
  assert.deepEqual(JSON.parse(JSON.stringify(out[1].absences)), ['2026-01-05'], 'غياب المعلم لم يُمسح');
});

test('سحب قائمة المستخدمين: الإلغاء المحلي الأحدث يبقى', () => {
  const { __mergeUsersAttendanceList } = loadUserAttMerge();
  const local = [{ id: 'u_nahla', absences: [], markedLate: [], _attTs: 9000 }];
  const server = [{ id: 'u_nahla', absences: [], markedLate: ['2026-01-04'], lateType: { '2026-01-04': 'MORNING' }, _attTs: 4000 }];
  const out = __mergeUsersAttendanceList(local, server);
  assert.deepEqual(out[0].markedLate, [], 'التأخر الملغى لا يعود بعد السحب');
  assert.deepEqual(JSON.parse(JSON.stringify(out[0].lateType)), {}, 'نوع التأخر يُمسح');
});

test('سحب الخادم لا يُعيد إحياء تأخراً ألغاه هذا الجهاز (الدمج بالأحدث يفوز)', () => {
  const { __mergeUserAtt } = loadUserAttMerge();
  const server = { id: 'u_nahla', name: 'نهلة', absences: [], markedLate: ['2026-01-04'], lateMinutes: { '2026-01-04': 10 }, lateType: { '2026-01-04': 'MORNING' }, _attTs: 3000 };
  const local = { id: 'u_nahla', name: 'نهلة', absences: [], markedLate: [], lateMinutes: {}, lateType: {}, _attTs: 7000 };
  const merged = __mergeUserAtt(server, local);
  assert.deepEqual(merged.markedLate, [], 'التأخر الملغى يبقى ملغى');
  assert.deepEqual(JSON.parse(JSON.stringify(merged.lateMinutes)), {}, 'دقائق التأخر تُمسح');
  assert.deepEqual(JSON.parse(JSON.stringify(merged.lateType)), {}, 'نوع التأخر يُمسح');
  assert.equal(merged._attTs, 7000);
});

test('جهاز أقدم لا يُعيد إحياء غيابٍ ألغاه جهاز أحدث', () => {
  const { __mergeUserAtt } = loadUserAttMerge();
  const server = { id: 'u_nahla', absences: ['2026-01-04'], markedLate: [], _attTs: 8000 };
  const local = { id: 'u_nahla', absences: [], markedLate: [], _attTs: 2000 };
  const merged = __mergeUserAtt(server, local);
  assert.deepEqual(merged.absences, ['2026-01-04'], 'نسخة الجهاز القديمة لا تفرض غيابها');
});

test('تسجيل جديد على جهاز لم يُرفع بعد يبقى محفوظاً (بدون ختم نستخدم الاتحاد)', () => {
  const { __mergeUserAtt } = loadUserAttMerge();
  const server = { id: 'u_nahla', absences: [], markedLate: [] };
  const local = { id: 'u_nahla', absences: ['2026-01-05'], markedLate: ['2026-01-05'] };
  const merged = __mergeUserAtt(server, local);
  assert.deepEqual(merged.absences, ['2026-01-05']);
  assert.deepEqual(merged.markedLate, ['2026-01-05']);
});

test('جهاز قديم بلا ختم لا يُفرض فوق نسخة الخادم المختمومة', () => {
  const { __mergeUserAtt } = loadUserAttMerge();
  const server = { id: 'u_nahla', absences: [], markedLate: ['2026-01-04'], _attTs: 9000 };
  const local = { id: 'u_nahla', absences: ['2026-01-04'], markedLate: ['2026-01-04'] };
  const merged = __mergeUserAtt(server, local);
  assert.deepEqual(merged.absences, [], 'لا يعود الغياب الملغى من جهاز قديم');
  assert.equal(merged._attTs, 9000);
});

test('ختم الحضور يُحدَّث فقط عند تغيّر فعلي في حقول الحضور', () => {
  const { __attTouch, __attSig } = loadUserAttMerge();
  const u = { id: 'u_nahla', absences: [], markedLate: ['2026-01-04'], lateMinutes: { '2026-01-04': 5 }, lateType: {} };
  const before = __attSig(u);
  assert.equal(u._attTs, undefined, 'لا ختم قبل التعديل');
  __attTouch(u);
  const stamped = u._attTs;
  assert.equal(typeof stamped, 'number', 'الختم رقم');
  assert.equal(__attSig(u), before, 'الختم لا يغيّر توقيع الحضور');
});
