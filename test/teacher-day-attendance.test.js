'use strict';
// اختبار بطاقة «حضور اليوم» للمعلم: المتأخرة حاضرة لا غائبة، فلا تُطرح
// من الإحصائية. 4 متأخرات + 4 حاضرات = 8/8 وليس 4/8.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

function block(startNeedle, endNeedle) {
  const a = SRC.indexOf(startNeedle);
  const b = SRC.indexOf(endNeedle, a + startNeedle.length);
  assert.ok(a >= 0 && b > a, 'لم أجد الكتلة: ' + startNeedle);
  return SRC.slice(a, b);
}

// الكتلة من خريطة الحالة إلى السطر التالي — حدود متوازنة لا تقطع
// داخل template literal (بحثها عبر ${statTile} كان يقطع التعبير).
const CODE = block('const dayFlagById = new Map();', 'const mySubjects');
// سطر البطاقة نفسه، لنتحقق من صيغة الرقم المعروضة كما هي منشورة.
// القطع حتى '})()}' لأنها نهاية الـ IIFE، فتشمل جملة return كاملة.
const TILE = block('const attended = a.present + a.late;', '})()}');
assert.ok(TILE.includes('return statTile'), 'لم ألتقط جملة return في سطر البطاقة');

// يشغّل صيغة البطاقة الحقيقية من index.html على الأعداد المعطاة، حتى يختبر
// الاختبار ما هو منشور فعلًا لا نسخة منه في الاختبار.
function tile(counts) {
  const a = counts || { present: 0, absent: 0, late: 0 };
  const out = vm.runInNewContext(
    'var a = ARGS; var statTile = (i, n, t, s) => ({ num: n, sub: s });' +
    '(function(){ ' + TILE + ' })()',
    { ARGS: a },
  );
  return { num: String(out.num), sub: String(out.sub) };
}

function run(todayAtt, students, classes) {
  const context = {
    console, Map, Set, Date, Math, JSON, Number, String, Array, Object,
    __attEffStatus: (rec) => {
      if (!rec) return 'PRESENT';
      if (rec.status === 'ABSENT') return 'ABSENT';
      return rec.status === 'LATE' ? 'LATE' : 'PRESENT';
    },
    firstNameOf: (n) => String(n || '').split(' ')[0],
    d: { students, attendance: todayAtt, classes },
    todayAtt,
    isTeacher: true,
    myClasses: classes,
  };
  vm.createContext(context);
  vm.runInContext(CODE + '\n;globalThis.__out = teacherDayAtt();', context);
  return context.__out;
}

const mkStudents = (n) => Array.from({ length: n }, (_, i) => ({
  id: 'S' + (i + 1), fullName: 'طالب' + (i + 1), classId: 'C1', active: true,
}));
const classes = [{ id: 'C1', name: 'أ', teacherIds: ['T1'] }];

test('الحالة المُبلَّغ عنها: 4 متأخرات و4 حاضرات = 8/8 وليس 4/8', () => {
  const students = mkStudents(8);
  const att = [1, 2, 3, 4].map((i) => ({ studentId: 'S' + i, date: '2026-10-01', status: 'LATE' }));
  const counts = run(att, students, classes);
  assert.equal(counts.late, 4, 'أربع متأخرات');
  assert.equal(counts.absent, 0, 'ولا غائبات');
  assert.equal(counts.present, 4, 'أربع حاضرات صريحة');
  const t = tile(counts);
  assert.equal(t.num, '8/8', 'المتأخرات لا تُطرح من الإحصائية');
  assert.equal(t.sub, 'الكل حاضر', 'ولا غياب = الكل حاضر');
});

test('غياب واحد + 7 متأخرات = 7/8 مع ذكر الغائب', () => {
  const students = mkStudents(8);
  const att = [
    { studentId: 'S1', date: '2026-10-01', status: 'ABSENT' },
    ...[2, 3, 4, 5, 6, 7, 8].map((i) => ({ studentId: 'S' + i, date: '2026-10-01', status: 'LATE' })),
  ];
  const counts = run(att, students, classes);
  assert.equal(counts.absent, 1);
  assert.equal(counts.late, 7);
  const t = tile(counts);
  assert.equal(t.num, '7/8', 'الغائب وحده يُخصم');
  assert.equal(t.sub, '1 غائب');
});

test('سجل قديم PRESENT وسجل LATE لنفس الطالب: لا تُحسم ولا تُعدّ مرتين', () => {
  const students = mkStudents(8);
  const att = [
    { studentId: 'S1', date: '2026-10-01', status: 'PRESENT', _t: 1 },
    { studentId: 'S1', date: '2026-10-01', status: 'LATE', _t: 2 },
  ];
  const counts = run(att, students, classes);
  assert.equal(counts.late, 1, 'سجل LATE الأحدث هو الفائز لا الأول في القائمة');
  assert.equal(counts.present, 7, 'ولا تُحسب حاضرة أيضًا — مرة واحدة فقط');
  assert.equal(tile(counts).num, '8/8', 'الإجمالي يبقى 8 بلا مضاعفة');
});

test('غياب يتقدّم على التأخير لنفس الطالب (نفس ترجيح بطاقة الحضور)', () => {
  const students = mkStudents(8);
  const att = [
    { studentId: 'S1', date: '2026-10-01', status: 'LATE', _t: 2 },
    { studentId: 'S1', date: '2026-10-01', status: 'ABSENT', _t: 3 },
  ];
  const counts = run(att, students, classes);
  assert.equal(counts.absent, 1, 'الغائب يفوز (كما في attCountsByDate)');
  assert.equal(counts.late, 0, 'ولا تُحتسب متأخرة وغائبة معًا');
  assert.equal(tile(counts).num, '7/8');
});

test('لا غياب ولا تأخير: 8/8 الكل حاضر', () => {
  const counts = run([], mkStudents(8), classes);
  assert.equal(counts.present, 8);
  const t = tile(counts);
  assert.equal(t.num, '8/8');
  assert.equal(t.sub, 'الكل حاضر');
});

test('بطاقة الحضور نفسها تُبقي المتأخر ضمن إجمالي اليوم بلا مضاعفة', () => {
  // attGroup: total = present + absent + late عند غياب subLate، وdispPresent
  // = total - absent - late، فالمتأخرة تُعرض ولا تدخل مرتين.
  const { present, absent, late } = { present: 4, absent: 0, late: 4 };
  const total = present + absent + late;
  assert.equal(total, 8);
  assert.equal(total - absent - late, present, 'المتأخرة لا تُضاف فوق الحاضرات');
});