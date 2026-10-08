'use strict';

// صف «التمهيدي» مستقل يظهر قبل «الأول الابتدائي» مباشرة، دون المساس بأي صف
// أو طالب أو فصل قائم. تُستخرج الشيفرة الحقيقية من public/index.html عبر vm.

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const INDEX_HTML_PATH = path.join(__dirname, '..', 'public', 'index.html');
const SRC = fs.readFileSync(INDEX_HTML_PATH, 'utf8');

const KINDERGARTEN = 'التمهيدي';
const FIRST_ELEMENTARY = 'الأول الابتدائي';
const PRE_EXISTING = [
  'الأول الابتدائي', 'الثاني الابتدائي', 'الثالث الابتدائي',
  'الرابع الابتدائي', 'الخامس الابتدائي', 'السادس الابتدائي',
  'الأول المتوسط', 'الثاني المتوسط', 'الثالث المتوسط',
  'الأول الثانوي', 'الثاني الثانوي', 'الثالث الثانوي',
];

function extractFn(marker) {
  const startIdx = SRC.indexOf('function ' + marker + '(');
  if (startIdx === -1) throw new Error('function not found in index.html: ' + marker);
  const openBrace = SRC.indexOf('{', startIdx);
  let depth = 0, i = openBrace;
  for (; i < SRC.length; i++) {
    if (SRC[i] === '{') depth++;
    else if (SRC[i] === '}') { depth--; if (depth === 0) break; }
  }
  return SRC.slice(startIdx, i + 1);
}

function extractBlock(startMarker, endMarker) {
  const start = SRC.indexOf(startMarker);
  if (start === -1) throw new Error('block start not found: ' + startMarker);
  const end = SRC.indexOf(endMarker, start);
  if (end === -1) throw new Error('block end not found: ' + endMarker);
  return SRC.slice(start, end + endMarker.length);
}

function extractAutoRepairBlock() {
  const marker = 'stages.forEach(stage => {';
  let from = 0;
  for (;;) {
    const start = SRC.indexOf(marker, from);
    if (start === -1) throw new Error('auto-repair block not found');
    const open = SRC.indexOf('{', start);
    let depth = 0, i = open;
    for (; i < SRC.length; i++) {
      if (SRC[i] === '{') depth++;
      else if (SRC[i] === '}') { depth--; if (depth === 0) break; }
    }
    const end = SRC.indexOf(';', i);
    const block = SRC.slice(start, end + 1);
    if (block.includes('addedNames')) return block;
    from = end + 1;
  }
}

function loadStages() {
  const context = { console };
  vm.createContext(context);
  const literal = extractBlock('const stages = [', '];');
  vm.runInContext(literal + '\nglobalThis.__stages = stages;', context);
  vm.runInContext(extractFn('__stage') + '\nglobalThis.__stage = __stage;', context);
  vm.runInContext(extractFn('__stageOrder') + '\nglobalThis.__stageOrder = __stageOrder;', context);
  return context;
}

function orderedNames(context) {
  return context.__stages.slice().sort((a, b) => a.order - b.order).map(s => s.name);
}

test('«التمهيدي» صف مستقل موجود في قائمة الصفوف', () => {
  const { __stages } = loadStages();
  const kg = __stages.find(s => s.name === KINDERGARTEN);
  assert.ok(kg, 'التمهيدي موجود في stages');
  assert.equal(typeof kg.order, 'number', 'للتمهيدي قيمة ترتيب رقمية');
  assert.equal(__stages.filter(s => s.name === KINDERGARTEN).length, 1, 'يظهر مرة واحدة فقط');
});

test('«التمهيدي» يظهر قبل «الأول الابتدائي» مباشرة', () => {
  const { __stages } = loadStages();
  const kg = __stages.find(s => s.name === KINDERGARTEN);
  const first = __stages.find(s => s.name === FIRST_ELEMENTARY);
  assert.ok(kg.order < first.order, `ترتيب التمهيدي (${kg.order}) يجب أن يقل عن ترتيب الأول ابتدائي (${first.order})`);
  const names = orderedNames(loadStages());
  assert.equal(names.indexOf(KINDERGARTEN) + 1, names.indexOf(FIRST_ELEMENTARY), 'التمهيدي يسبق الأول ابتدائي بلا فاصل');
});

test('ترتيب بقية الصفوف لم يتغيّر (قيم order الأصلية 0..11 كما هي)', () => {
  const { __stages } = loadStages();
  const byName = new Map(__stages.map(s => [s.name, s.order]));
  PRE_EXISTING.forEach((name, i) => {
    assert.equal(byName.get(name), i, `${name} يجب أن يحتفظ بقيمته الأصلية ${i}`);
  });
  assert.equal(orderedNames(loadStages()).join('|'),
    [KINDERGARTEN].concat(PRE_EXISTING).join('|'), 'الترتيب الكامل: التمهيدي ثم الصفوف الاثنا عشر بترتيبها الأصلي');
});

test('أسماء الصفوف القائمة لم تُعدّل (لا إضافة ولا حذف ولا إعادة تسمية)', () => {
  const { __stages } = loadStages();
  const names = __stages.map(s => s.name);
  PRE_EXISTING.forEach(n => assert.ok(names.includes(n), `${n} ما زال موجودًا باسمه`));
  assert.equal(names.length, PRE_EXISTING.length + 1, 'عدد الصفوف زاد واحدًا فقط');
  const extras = Array.from(names).filter(n => !PRE_EXISTING.includes(n));
  assert.deepEqual(extras, [KINDERGARTEN], 'الصف الجديد الوحيد هو التمهيدي');
});

test('معرّفات الصفوف ثابتة ومتطابقة مع قواعد المدارس (لا uid عشوائي)', () => {
  const { __stages } = loadStages();
  __stages.forEach(s => {
    assert.deepEqual(Object.keys(s).sort(), ['id', 'name', 'order'], 'تعريف الصف: id + name + order فقط');
    assert.equal(typeof s.id, 'string', 'لكل صف معرّف نصي');
    assert.ok(s.id.length > 0 && !/\s/.test(s.id), 'معرّف صالح بلا مسافات: ' + s.id);
  });
  const ids = __stages.map(s => s.id);
  assert.equal(new Set(ids).size, ids.length, 'لا معرّف مكرّر بين الصفوف');
  // الخادم يدمج حسب id، فثبات المعرّف هو ما يمنع تكرار الصفوف بين الأجهزة.
  const again = loadStages().__stages.map(s => s.id);
  assert.deepEqual(Array.from(again), Array.from(ids), 'المعرّفات نفسها في كل تحميل للصفحة');
  const kg = __stages.find(s => s.name === KINDERGARTEN);
  assert.equal(kg.id, 'kg_g0', 'معرّف التمهيدي الثابت');
  PRE_EXISTING.forEach((name, i) => {
    assert.equal(__stages.find(s => s.name === name).id, 'b_g' + (i + 1), name + ' يطابق المعرّف الموجود في قواعد المدارس');
  });
});

test('دالة الترتيب تعطي التمهيدي -1 وتترك الاسم غير المعروف على قيمته القديمة', () => {
  const { __stageOrder } = loadStages();
  assert.equal(__stageOrder(KINDERGARTEN, 99), -1, 'التمهيدي يأخذ ترتيبه الصحيح');
  assert.equal(__stageOrder(FIRST_ELEMENTARY, 99), 0);
  assert.equal(__stageOrder('الثالث الثانوي', 99), 11);
  assert.equal(__stageOrder('صف جديد يدوياً', 7), 7, 'الصف اليدوي غير المعروف يحتفظ بالترتيب القديم');
});

test('الفصول تُرتَّب فيظهر فصل التمهيدي قبل فصل الأول ابتدائي', () => {
  const context = {
    console, JSON, Array, Object, Map, Set, Date, isFinite,
    uid: (() => { let n = 0; return () => 'g' + (++n); })(),
    currentUser: () => ({ id: 'u1', role: 'ADMIN' }),
    seesAllClasses: () => true,
  };
  vm.createContext(context);
  const { __stages } = loadStages();
  const d = {
    grades: [
      { id: 'g6', name: FIRST_ELEMENTARY, order: 0 },
      { id: 'g12', name: 'الثالث الثانوي', order: 11 },
    ],
    classes: [
      { id: 'c_sec', gradeId: 'g12', name: 'أ' },
      { id: 'c_pri', gradeId: 'g6', name: 'ب' },
      { id: 'c_kg', gradeId: 'g0', name: 'أ' },
      { id: 'c_dead', gradeId: 'g6', name: 'ج', deleted: true },
    ],
  };
  d.grades.unshift({ id: 'g0', name: KINDERGARTEN, order: __stages.find(s => s.name === KINDERGARTEN).order });
  context.d = d;
  vm.runInContext('function loadDB(){ return d; }\nglobalThis.__loadDB = loadDB;', context);
  vm.runInContext(extractFn('gradeById'), context);
  vm.runInContext(extractFn('getClassesSorted') + '\nglobalThis.__sorted = getClassesSorted();', context);
  assert.deepEqual(Array.from(context.__sorted, c => c.id), ['c_kg', 'c_pri', 'c_sec'], 'الترتيب: تمهيدي ثم ابتدائي ثم ثانوي');
  assert.equal(Array.from(context.__sorted).some(c => c.id === 'c_dead'), false, 'الفصول المحذوفة لا تظهر (سلوك سابق)');
});

test('الإكمال التلقائي للصفوف يضيف التمهيدي فقط ولا يمس صفاً أو طالباً أو فصلاً قائماً', () => {
  const context = {
    console, JSON, Array, Object, Map, Set, Date, isFinite,
    uid: (() => { let n = 0; return () => 'new' + (++n); })(),
  };
  vm.createContext(context);
  const { __stages } = loadStages();
  const existingGrades = Array.from(__stages).filter(s => s.name !== KINDERGARTEN)
    .map((s, i) => ({ id: 'g' + i, name: s.name, order: s.order }));
  const existingClasses = existingGrades.map((g, i) => ({ id: 'c' + i, gradeId: 'g' + i, name: 'أ', campus: 'BOYS' }));
  const existingStudents = [
    { id: 's1', fullName: 'طالب قائمة', classId: 'c0', active: true },
    { id: 's2', fullName: 'طالب ثانية', classId: 'c5', active: true },
  ];
  const before = JSON.stringify({ grades: existingGrades, classes: existingClasses, students: existingStudents });
  context.d = { grades: existingGrades.slice(), classes: existingClasses.slice(), students: existingStudents.slice() };
  context.stages = Array.from(__stages);
  context.campus = 'BOYS';
  context.added = 0;
  context.addedNames = [];
  vm.runInContext(extractFn('__stageClassId'), context);
  vm.runInContext(extractAutoRepairBlock(), context);

  const kg = context.d.grades.find(g => g.name === KINDERGARTEN);
  assert.ok(kg, 'التمهيدي أُضيف');
  assert.equal(kg.order, -1, 'بقيمته الصحيحة');
  assert.equal(context.d.grades.length, existingGrades.length + 1, 'صف واحد فقط أُضيف');
  assert.equal(context.d.classes.length, existingClasses.length + 1, 'فصل واحد فقط أُضيف');
  assert.equal(context.added, 1, 'رسالة الإضافة تذكر صفًا واحدًا');
  assert.deepEqual(Array.from(context.addedNames), [KINDERGARTEN]);
  assert.equal(context.d.classes.filter(c => c.gradeId === kg.id).length, 1, 'فصل التمهيدي يشير إلى صفه');
  const after = JSON.stringify({
    grades: context.d.grades.filter(g => g.name !== KINDERGARTEN),
    classes: context.d.classes.filter(c => c.gradeId !== kg.id),
    students: context.d.students,
  });
  assert.equal(after, before, 'الصفوف والفصول والطلاب القائمة كلها كما هي بايتًا ببايت');
});

test('الإكمال التلقائي لا يكرر شيئًا عند تشغيله مرة أخرى (idempotent)', () => {
  const context = { console, JSON, Array, Object, Map, Set, Date, isFinite, uid: () => 'x', campus: 'BOYS', added: 0, addedNames: [] };
  vm.createContext(context);
  const { __stages } = loadStages();
  context.d = {
    grades: Array.from(__stages).map((s, i) => ({ id: 'g' + i, name: s.name, order: s.order })),
    classes: [], students: [],
  };
  context.stages = Array.from(__stages);
  const block = extractAutoRepairBlock();
  vm.runInContext(extractFn('__stageClassId'), context);
  vm.runInContext(block, context);
  const gradesAfterFirst = context.d.grades.length;
  const classesAfterFirst = context.d.classes.length;
  context.added = 0;
  context.addedNames = [];
  vm.runInContext(block, context);
  assert.equal(context.d.grades.length, gradesAfterFirst, 'لا صفوف مكررة');
  assert.equal(context.d.classes.length, classesAfterFirst, 'لا فصول مكررة');
  assert.equal(context.added, 0, 'لا رسائل إضافة');
});

// ===== سبب تكرار الصفوف: جهازان ينشآن الصف الناقص في الوقت نفسه =====
// الإنتاج فيه 37 صفًا لـ13 اسمًا (12 اسمًا ×3 نسخ) لأن الت retrofit كان يستعمل uid()
// العشوائي: معرّفان مختلفان لنفس الاسم ⇒ دمج الخادم (بمفتاح id) يبقي الاثنتين.
// هذا الاختبار ينفّذ الإصلاح من زاوية الضجيرة: جهازان مستقلان + دمج على طريقة الخادم.
test('جهازان ينشآن الصف الناقص في وقت واحد: معرّف واحد ⇒ لا تكرار بعد الدمج', () => {
  const { __stages } = loadStages();
  const existing = Array.from(__stages).filter(s => s.name !== KINDERGARTEN)
    .map(s => ({ id: s.id, name: s.name, order: s.order }));

  // جهازان: كلٌّ بنسخة فيها الصفوف الاثني عشر لكن بلا تمهيدي، و uid() مختلف في كل جهاز.
  const makeDevice = () => {
    const ctx = {
      console, JSON, Array, Object, Map, Set, Date, isFinite,
      uid: (() => { let n = 0; return () => 'id_' + (++n) + '_' + Math.random().toString(36).slice(2, 8); })(),
    };
    vm.createContext(ctx);
    ctx.d = { grades: existing.map(g => Object.assign({}, g)), classes: [], students: [] };
    ctx.stages = Array.from(__stages);
    ctx.campus = 'BOYS';
    ctx.added = 0;
    ctx.addedNames = [];
    vm.runInContext(extractFn('__stageClassId'), ctx);
    vm.runInContext(extractAutoRepairBlock(), ctx);
    return ctx;
  };
  const a = makeDevice();
  const b = makeDevice();

  const kgA = a.d.grades.find(g => g.name === KINDERGARTEN);
  const kgB = b.d.grades.find(g => g.name === KINDERGARTEN);
  const clsA = a.d.classes.find(c => c.gradeId === kgA.id);
  const clsB = b.d.classes.find(c => c.gradeId === kgB.id);

  assert.equal(kgA.id, kgB.id, 'الجهازان أعطيا نفس معرّف الصف: ' + kgA.id + ' / ' + kgB.id);
  assert.equal(clsA.id, clsB.id, 'الجهازان أعطيا نفس معرّف الفصل: ' + clsA.id + ' / ' + clsB.id);

  // دمج الخادم: الخريطة بمفتاح id، والواصل يرجّح (server.js mergeSection).
  const mergeById = (prev, incoming) => {
    const map = new Map();
    for (const r of prev) map.set(r.id, r);
    for (const r of incoming) map.set(r.id, r);
    return Array.from(map.values());
  };
  const mergedGrades = mergeById(a.d.grades, b.d.grades);
  const mergedClasses = mergeById(a.d.classes, b.d.classes);

  const kgRows = mergedGrades.filter(g => g.name === KINDERGARTEN);
  const kgClasses = mergedClasses.filter(c => c.gradeId === kgA.id);
  assert.equal(kgRows.length, 1, 'صف تمهيدي واحد بعد الدمج (كان 3 قبل الإصلاح)');
  assert.equal(kgClasses.length, 1, 'فصل «أ» واحد بعد الدمج (كان 3 قبل الإصلاح)');
  assert.equal(mergedGrades.filter(g => g.name === FIRST_ELEMENTARY).length, 1, 'بقية الصفوف لا تتكرر أيضاً');
  assert.deepEqual(
    mergedGrades.map(g => g.name).sort(),
    [KINDERGARTEN].concat(PRE_EXISTING).sort(),
    'الدمج لا يفقد ولا يضيف صفًا'
  );
});

test('نوافذ المراحل في لوحة الأوائل تشمل التمهيدي ضمن الابتدائي', () => {
  const pri = SRC.match(/label:'[^']*ابتدائي[^']*', min:(-?\d+), max:(-?\d+)/g) || [];
  assert.equal(pri.length, 3, 'النوافذ الثلاثة موجودة');
  pri.forEach(line => {
    assert.match(line, /min:-1, max:5/, 'الابتدائي يشمل التمهيدي دون تغيير حدّه الأعلى: ' + line);
  });
  const mid = SRC.match(/label:'[^']*متوسط[^']*', min:(-?\d+), max:(-?\d+)/g) || [];
  const sec = SRC.match(/label:'[^']*ثانوي[^']*', min:(-?\d+), max:(-?\d+)/g) || [];
  mid.forEach(line => assert.match(line, /min:6, max:8/, 'المتوسط لم يتغير: ' + line));
  sec.forEach(line => assert.match(line, /min:9, max:11/, 'الثانوي لم يتغير: ' + line));
});

test('رسائل retrofitting لم تعد تحتوي أرقامًا ثابتة تناقض 13 صفًا', () => {
  assert.equal(SRC.includes('12 فصل'), false, 'لا عدد فصول ثابت');
  assert.equal(SRC.includes('(3 متوسط + 3 ثانوي)'), false, 'لا تفصيل ثابت للصفوف المضافة');
  assert.match(SRC, /\$\{stages\.length\} صف/, 'عدد الصفوف يُحسب من stages');
  assert.match(SRC, /addedNames\.join/, 'أسماء الصفوف المضافة تُحسب من الكود');
});

test('تقرير ملخّص الفصول (class_summary) أُزيل نهائيًا من التقارير', () => {
  assert.equal(SRC.includes("value:'class_summary'"), false, 'لا يوجد خيار تقرير class_summary');
  assert.equal(SRC.includes("type === 'class_summary'"), false, 'لا يوجد فرع معالجة class_summary');
});
