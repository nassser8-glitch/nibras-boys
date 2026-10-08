'use strict';
/* =============================================================================
 * اختبارات خصوصية ملاحظات الطلاب — 10 حالات كما طُلبت
 * تختبر notes-privacy.js مباشرة + الكود المنشور داخل server.js (تُقرأ من الملف
 * وتُشغَّل بـ vm) حتى لا يمر الاختبار بسبب نسخة منفصلة عن الإنتاج.
 * ========================================================================== */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const NP = require(path.join(ROOT, 'notes-privacy.js'));
const SERVER_SRC = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const CLIENT_SRC = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');

// ---------------------------------------------------------------- fixtures
const A = 'teacher_A';   // المعلم التي كَتَبت الملاحظة
const B = 'teacher_B';   // معلم أخرى
const C = 'teacher_C';   // معلم ثالثة
const AGENT = 'agent_1';
const ADM = 'admin_1';
const STU = 'student_456';
const NOTE = 'note_789';

// شكلان في المشروع: جلسة الخادم تحمل user_id، وكائن المستخدم في الواجهة يحمل id.
// نضع الاثنين معاً كي يصلح الـfixture لدالة الخادم و لدالة العميل معاً.
const mkUser = (role, id) => ({ role, id, user_id: id });
const teacherA = mkUser('TEACHER', A);
const teacherB = mkUser('TEACHER', B);
const teacherC = mkUser('TEACHER', C);
const agent = mkUser('AGENT', AGENT);
const admin = mkUser('ADMIN', ADM);

function note(over = {}) {
  return {
    id: NOTE, studentId: STU, studentNo: '12', studentName: 'طالب',
    type: 'POSITIVE', category: 'الانضباط', description: 'ملاحظة سرية للمعلم A',
    points: 5, createdBy: A, createdByName: 'معلم أ', createdByRole: 'TEACHER',
    createdAt: '2026-10-01T08:00:00.000Z',
    ...over,
  };
}

// ------------------------------------------------ 1) المعلم A تنشئ ملاحظة
test('1) المعلم A تنشئ ملاحظة للطالب X — والمالك من الجلسة لا من الجسم', () => {
  const n = note();
  assert.equal(n.createdBy, A, 'الملكية معرّفة بالمستخدم');
  assert.equal(n.studentId, STU);
  // الخادم لا يُعدّها ملكاً إلا لمالكها (وكيل يقرأ ≠ مالك)
  assert.equal(NP.noteOwnerId(n), A);
  assert.equal(NP.canReadNote(n, agent), true, 'الوكيل يقرأ');
  assert.equal(NP.noteOwnerId(n), A, 'القراءة لم تغيّر المالك — لا نقل ملكية');
});

// ------------------------------------------------ 2) A تستطيع قراءتها
test('2) المعلم A تستطيع قراءة ملاحظتها', () => {
  assert.equal(NP.canReadNote(note(), teacherA), true);
  assert.deepEqual(
    NP.filterNotesForViewer([note()], teacherA).map(n => n.id),
    [NOTE],
  );
});

// ------------------------------------- 3) B لا تستطيع + 4) C لا تستطيع
test('3) المعلم B لا تستطيع قراءة ملاحظة المعلم A', () => {
  assert.equal(NP.canReadNote(note(), teacherB), false);
  assert.deepEqual(NP.filterNotesForViewer([note()], teacherB), []);
});

test('4) المعلم C لا تستطيع قراءة ملاحظة المعلم A', () => {
  assert.equal(NP.canReadNote(note(), teacherC), false);
  assert.deepEqual(NP.filterNotesForViewer([note()], teacherC), []);
});

// ------------------------------------------------ 5) الوكيل يقرأ
test('5) الوكيل/الوكيل يقرأ وفق صلاحيته الإدارية، وبلا أن يصير مالكاً', () => {
  const n = note();
  assert.equal(NP.canReadNote(n, agent), true);
  assert.equal(NP.noteOwnerId(n), A, 'الوكيل ليس مالكاً لمجرد قدرته على القراءة');
  assert.equal(NP.canReadNote(note({ createdBy: AGENT }), teacherA), false,
    'ملاحظة الوكيل لا تسقط للمعلم A');
});

// ------------------------------------------------ 6) ADMIN يقرأ
test('6) ADMIN يستطيع قراءة جميع الملاحظات', () => {
  assert.equal(NP.canReadNote(note(), admin), true);
  const all = NP.filterNotesForViewer([note(), note({ id: 'n2', createdBy: B })], admin);
  assert.equal(all.length, 2);
});

// ----------------------------------- 7) منع الوصول المباشر بـ noteId
test('7) الوصول المباشر بالمعرّف مرفوض — لا مسار-notes منفصل أصلاً', () => {
  // لا يوجد endpoint للملاحظات منفرداً: القراءة كلها عبر GET /api/db/:school،
  // فلا مَلبَس للتجاوز بـ noteId. نثبت ذلك بفحص المسارات الفعلية في server.js.
  const routes = [...SERVER_SRC.matchAll(/app\.(get|post|put|patch|delete)\(\s*'([^']+)'/g)]
    .map(m => m[2]);
  // المسارات الوحيدة التي تذكر notes هي مسارات المطالب (لا تُرجع نصّاً):
  assert.deepEqual(routes.filter(r => /note/i.test(r)).sort(),
    ['/api/notes/claim', '/api/notes/claim/decide', '/api/notes/claims'],
    'أي مسار notes جديد يجب مراجعته');
  // لا مسار يقرأ ملاحظة بمعرّفها — القراءة كلها عبر GET /api/db/:school المفلتر
  assert.ok(!routes.some(r => /notes?\/:|noteId/.test(r)), 'يوجد مسار يقرأ ملاحظة بمعرّفها');
  assert.ok(routes.includes('/api/db/:school'));
  // الفلترة على مستوى الاستجابة: ملاحظة A غير موجودة أصلاً في رد B
  const payload = { notes: NP.filterNotesForViewer([note()], teacherB) };
  assert.equal(payload.notes.find(n => n.id === NOTE), undefined,
    'لا يمكن استرجاعها حتى بمعرّفها-known');
});

// ------------------------------------- 8) تغيير الاسم لا يغيّر الملكية
test('8) تغيير اسم المعلم لا يغيّر ملكية الملاحظة', () => {
  const renamed = note({ createdByName: 'اسم جديد تماماً', createdByRole: 'TEACHER' });
  assert.equal(NP.noteOwnerId(renamed), A, 'المالك من createdBy لا من الاسم');
  assert.equal(NP.canReadNote(renamed, teacherA), true, 'ما زالت صاحبتها تراها');
  assert.equal(NP.canReadNote(renamed, teacherB), false, 'لا تنتقل لزميلتها');
  // ولا باسم الطلاب ولا بمطابقة الاسم
  const byNameOnly = note({ createdBy: undefined, createdByName: 'معلم أ' });
  assert.equal(NP.noteOwnerId(byNameOnly), null, 'لا مالك من الاسم');
  assert.equal(NP.canReadNote(byNameOnly, teacherA), false, 'لا تُنسب بالاسم');
});

// ------------------------------------- 9) merge/sync لا يغيّر ownerId
test('9) الدمج لا يغيّر المالك ولا ينقله — منفذ الخادم enforcer', () => {
  // الكود المنشور في server.js
  assert.ok(SERVER_SRC.includes('notePrivacy.enforceNoteOwners(data.notes, req.session, prevNotes)'),
    'استدعاءenforceNoteOwners غير موجود في server.js');
  const serverCopy = [note()];
  // محاولة عميل تزوير ملكية ملاحظة قائمة
  const forged = NP.enforceNoteOwners(
    [note({ description: 'مُعدَّل', createdBy: B })],
    teacherB, serverCopy,
  );
  assert.equal(forged[0].createdBy, A, 'ملكية ملاحظة موجودة تبقى لصاحبها');
  assert.equal(NP.noteOwnerId(forged[0]), A);
  // الدمج نفسه (union بالمعرّف) لا يقسّم السجل
  const { NRC_mergeNotes } = loadClientFns();
  const merged = NRC_mergeNotes([note()], [note({ points: 9 })]);
  assert.equal(merged.length, 1, 'سجل واحد لا تكرار');
  assert.equal(NP.noteOwnerId(merged[0]), A, 'المالك ثابت بعد الدمج');
});

// ------------------------- 10) ownerId من الجلسة لا من body يمكن التلاعب به
test('10) الخادم يفرض المالك من الجلسة — body المزوّر بلا أثر', () => {
  const session = teacherB;
  // عميل B ينشئ ملاحظة جديدة لكن يدّعي أنها لزميلته A
  const body = [{ id: 'n_new', studentId: STU, type: 'POSITIVE', category: 'الانضباط', points: 5, createdBy: A }];
  const out = NP.enforceNoteOwners(body, session, [note()]);
  assert.equal(out[0].createdBy, B, 'المالك من sessions.user_id');
  assert.notEqual(out[0].createdBy, A, 'لا انتحال ملكية زميلة');
  // لا جلسة => لا تغيير (ولا تسريب تعديل من عميل مجهول)
  const noSession = NP.enforceNoteOwners(body, null, [note()]);
  assert.equal(noSession[0].createdBy, A, 'بلا جلسة لا يُكتب مالك جديد');
  // بـ ownerId بدل createdBy: الخادم يقرأ createdBy من نسخته ولا يغيره
  const existing = NP.enforceNoteOwners([note({ ownerId: B })], session, [note()]);
  assert.equal(existing[0].createdBy, A, 'لا تسريب عبر ownerId في الطلب');
});

// ------------------------------------------------ إضافات: البيانات القديمة
test('الملاحظات القديمة بلا مالك: غير مملوكة — الإدارة فقط، بلا حذف ولا إسناد', () => {
  const legacy = [
    note({ id: 'l1', createdBy: undefined }),
    note({ id: 'l2', createdBy: null }),
    note({ id: 'l3', createdBy: '   ' }),
  ];
  // لا تُحذف: موجودة في مخزون الخادم كما هي
  assert.equal(legacy.length, 3);
  for(const n of legacy) assert.equal(NP.noteOwnerId(n), null);
  // تراها الإدارة
  assert.equal(NP.filterNotesForViewer(legacy, admin).length, 3);
  assert.equal(NP.filterNotesForViewer(legacy, agent).length, 3);
  // ولا تراها أي معلم — ولا حتى التي قد تكون صاحبتها (لا نعرف)
  assert.deepEqual(NP.filterNotesForViewer(legacy, teacherA), []);
  assert.deepEqual(NP.filterNotesForViewer(legacy, teacherB), []);
  // وغير مملوكة => لا تُكتسب ملكية بالقراءة
  assert.equal(NP.noteOwnerId(NP.filterNotesForViewer(legacy, agent)[0]), null,
    'الوكيل لا يصير مالكاً بقراءتها');
});

// ------------------------------------------------ إضافات: الحساب والأدوار
test('الأدوار غير الإدارية لا ترى ملاحظات غيرها حتى لو كتبت في نفس القسم', () => {
  for(const role of ['COUNSELOR', 'ADMINISTRATIVE', 'SCHOOL_AGENT']) {
    const s = { role, user_id: role + '_1' };
    assert.deepEqual(NP.filterNotesForViewer([note()], s), [], role + ' لا يرى ملاحظة غيره');
    const own = NP.filterNotesForViewer([note({ createdBy: s.user_id })], s);
    assert.equal(own.length, 1, role + ' يرى ملاحظته هو');
  }
});

// ------------------------------------------------ إضافات: نقاط separConcerns
test('أرصدة النقاط تُحسب من كل الملاحظات — محتوى مخفي لا رقم ناقص', () => {
  const data = {
    notes: [note({ points: 5 }), note({ id: 'n2', studentId: 's2', points: -3 })],
    attendance: [], assignments: [], students: [{ id: STU, active: true }, { id: 's2', active: true }],
  };
  const totals = NP.computePointsTotals(data, '2026-09-07');
  assert.equal(totals[STU].total, 5, 'includes notes owned by others');
  assert.equal(totals.s2.total, -3);
  // ناظرةً للباحث: B لا يرى الملاحظة، لكن الرصيد يبقى صحيحاً
  const bView = NP.filterNotesForViewer(data.notes, teacherB);
  assert.deepEqual(bView, []);
  assert.equal(NP.computePointsTotals({ ...data, notes: bView }, '2026-09-07')[STU], undefined);
  // => هذا بالضبط سبب إرسال pointsTotals من الخادم.
});

// ------------------------ 11) نقاط الدرجة تساوي نقاط الخادم (لا نقصان)
// تُثبت أن فصل المحتوى عن المجموع لم يغيّر أي رقم: معرّف المعلم يتغيّر
// واسمها يتغيّر، لكن الرصيد يبقى واحداً على كل الأجهزة.
test('11) الأرصدة متطابقة على كل الأجهزة رغم اختلاف ما يُرسل لكل معلم', () => {
  const { NRC_canSeeNote: canSee } = loadClientFns(() => teacherB);
  const data = {
    notes: [
      note({ id: 'nA', points: 5, category: 'الانضباط', type: 'POSITIVE' }),
      note({ id: 'nB', points: -3, category: 'التأخر', type: 'NEGATIVE', createdBy: B,
             createdByName: 'معلم ب', createdAt: '2026-10-01T09:00:00.000Z' }),
    ],
    attendance: [], assignments: [],
    students: [{ id: STU, active: true, classId: 'C1' }],
  };
  const authoritative = NP.computePointsTotals(data, '2026-09-07')[STU].total;
  assert.equal(authoritative, 2, '5 من A و-3 من B');

  // الخادم يبث لكل معلم فقط ما تملكه
  const forA = { ...data, notes: NP.filterNotesForViewer(data.notes, teacherA) };
  const forB = { ...data, notes: NP.filterNotesForViewer(data.notes, teacherB) };
  assert.equal(forA.notes.length, 1);
  assert.equal(forB.notes.length, 1);
  assert.ok(!forB.notes.some(n => n.id === 'nA'), 'B لا تستقبل نص ملاحظة A');

  // حساب محلي من النسخة المُصفّاة = ناقص (وهذا بالضبط ما يمنع إرسال pointsTotals)
  const localB = NP.computePointsTotals(forB, '2026-09-07')[STU].total;
  assert.equal(localB, -3, 'محلياً: ناقص بمقدار ملاحظة A');
  assert.notEqual(localB, authoritative);

  // الخادم يبث pointsTotals المحسوب من المخزون الكامل ⇒ الرقم صحيح لكل جهاز
  assert.equal(NP.computePointsTotals(data, '2026-09-07')[STU].total, authoritative);
  assert.equal(NP.canReadNote(data.notes[0], teacherB), false, 'والرفض ما زال سارياً');
  assert.ok(canSee(data.notes[0], teacherB) === false, 'العميل يرفض أيضاً');
});

// ------------- 12) الملاحظات القديمة: لا تُحذف ولا تُطهَّر من localStorage
// شرط صريح: لا يجوز أن تؤدي الخصوصية إلى فقدان المعلم وصولها إلى ملاحظة
// قديمة كتبتها. لذلك معيار الإزالة من التخزين المحلي هو «مملوكة **لشخص محدَّد**
// غيري» فقط — والملاحظة غير المملوكة تبقى محفوظة على الجهاز.
test('12) الملاحظات غير المملوكة لا تُحذف من التخزين المحلي — لا فقد وصول', () => {
  const api = loadClientFns(() => teacherA);
  const { NRC_mergeNotes, NRC_noteBelongsToOther } = api;

  const legacy = [
    note({ id: 'l1', createdBy: undefined }),
    note({ id: 'l2', createdBy: null }),
    note({ id: 'l3', createdBy: '  ' }),
  ];
  // لا تُحذف: معيار الإزالة لا يلحق بما لا مالك له
  for(const n of legacy) assert.equal(NRC_noteBelongsToOther(n, teacherA), false);
  // وتبقى محفوظة عبر الدمج على جهاز المعلم
  const kept = NRC_mergeNotes([], legacy);
  assert.equal(kept.length, 3, 'الثلاث باقية في التخزين المحلي');
  assert.deepEqual(kept.map(n => n.id), ['l1', 'l2', 'l3']);

  // وتبقى على جهاز المعلم B أيضاً (لأننا لا نعرف صاحبتها)
  const keptB = loadClientFns(() => teacherB).NRC_mergeNotes([], legacy);
  assert.equal(keptB.length, 3, 'لا تُحذف من جهاز زميلتها أيضاً');

  // وبالمقابل: ما مملوكته زميلة يُسقط فعلاً من جهازي
  const others = note({ id: 'o1', createdBy: B });
  assert.equal(NRC_noteBelongsToOther(others, teacherA), true);
  assert.equal(NRC_mergeNotes([others], []).length, 0, 'نسخة زميلة لا تُعرض');
  // ولا تُسقط من جهاز صاحبتها ولا من جهاز الإدارة
  assert.equal(NRC_noteBelongsToOther(others, teacherB), false);
  assert.equal(NRC_noteBelongsToOther(others, admin), false);
  assert.equal(loadClientFns(() => admin).NRC_mergeNotes([others], []).length, 1);
});

// ------------------- 13) نقاط الخادم تطابق pointItems في الواجهة حرفيةً
// الفارق بين المجموعين ليس في الخصوصية بل في النسخ: بعد إخفاء نصوص الزميلات
// يصبح الحساب المحلي ناقصاً. المصدر الموحّد (pointsTotals) يصحّح ذلك، فلو
// اختلفت قاعدته عن pointItems لظهر الرصيد الخطأ على أجهزة الزميلات.
test('13) قاعة نقاط الخادم تطابق pointItems — الغياب يُحسب سالباً', () => {
  const d = {
    notes: [],
    attendance: [
      { studentId: STU, date: '2026-10-01', status: 'ABSENT' },
      { studentId: STU, date: '2026-10-02', status: 'LATE', lateMinutes: 10 },
    ],
    assignments: [], students: [{ id: STU, active: true, classId: 'C1' }],
  };
  const t = NP.computePointsTotals(d, '2026-09-07')[STU];
  assert.equal(t.total, -3, 'غياب -2 وتأخّر قصير -1');
  assert.equal(t.neg, -3);
  // ABSENT لم يُقرأ PRESENT (كان خطأ النسخة الأولى: فينقص الغياب كله)
  assert.notEqual(t.total, -1, 'الغياب لا يُحتسب حاضراً');
});

// ----------------------- 14) خط بداية النقاط يشمل الحضور والتكليف أيضاً
// pointItems ترشّح كل عنصر سالب بتاريخه بعد بناء القائمة. لو رُشّحت الملاحظات
// وحدها لاختلف الرقم عن شاشة المدير.
test('14) خط بداية النقاط يطبَّق على الحضور والتكليف لا الملاحظات فقط', () => {
  const d = {
    notes: [],
    attendance: [
      { studentId: STU, date: '2026-08-01', status: 'ABSENT' },  // قبل البداية
      { studentId: STU, date: '2026-10-01', status: 'ABSENT' },  // بعد البداية
    ],
    assignments: [{
      id: 'A1', classId: 'C1', date: '2026-08-05', created: '2026-08-01T00:00:00.000Z',
      title: 'تكليف قديم', completedBy: [],
    }],
    students: [{ id: STU, active: true, classId: 'C1', joinedAt: '' }],
  };
  const t = NP.computePointsTotals(d, '2026-09-07')[STU];
  assert.equal(t.total, -2, 'غياب واحد بعد البداية فقط');
  assert.notEqual(t.total, -2 - 4, 'خصم التكليف القديم قبل البداية لا يُحتسب');
});

// -------------------- 15) نقاط مشتقّة من الخادم: لا تُكتب ولا تُدمج من العميل
// pointsTotals ناتج حسابي؛ لو استقبلناه من الجهاز لأمكن كتابة أرقام نقاط،
// ولأن مسار الاستبدال الكامل لا يمرّ بـ applyMerged لكتبت كما وردت.
test('15) pointsTotals يُسقط من الوارد ولا يدخل الدمج', () => {
  assert.ok(/delete data\.pointsTotals;/.test(SERVER_SRC), 'PUT يحذفه عند الاستقبال');
  assert.ok(/SERVER_DERIVED_KEYS\.has\(key\)/.test(SERVER_SRC), 'applyMerged يتجاهله');
  assert.ok(/const SERVER_DERIVED_KEYS = new Set\(\['_ts', 'pointsTotals'\]\)/.test(SERVER_SRC));
});

// ------------- 16) زميلة لا تقدر على تعديل أو حذف ملاحظة ليست hers
// فرض المالك وحده لا يكفي: زميلة تعرف المعرّف ترسل السجل نفسه فينتقل النص أو
// يوضع deleted، والمالك يُستعاد فقط. الآن نعيد نسخة الخادم كاملة.
test('16) تعديل/حذف ملاحظة غير مملوكة يُتجاهل ويُعاد نسخ الخادم', () => {
  const serverNote = note({ id: NOTE, createdBy: A, description: 'نصّ A الأصلي', points: 5 });
  const tampered = note({ id: NOTE, createdBy: A, description: 'نصّ مزوَّر', points: 999, deleted: true });

  const asB = NP.enforceNoteOwners([tampered], teacherB, [serverNote]);
  assert.equal(asB.length, 1);
  assert.equal(asB[0].description, 'نصّ A الأصلي', 'النص لم يتغير');
  assert.equal(asB[0].points, 5, 'النقاط لم تتغير');
  assert.ok(!asB[0].deleted, 'لم يُحذف');
  assert.equal(asB[0].createdBy, A, 'المالك كما هو');

  //Deletion عبر صلاحية زميلة على ملاحظة قديمة بلا مالك: تُعاد كما هي
  const legacy = note({ id: 'L1', createdBy: undefined, description: 'قديمة', points: 3 });
  const asB2 = NP.enforceNoteOwners([{ ...legacy, deleted: true, description: 'محو' }], teacherB, [legacy]);
  assert.equal(asB2[0].deleted, undefined, 'ملاحظة بلا مالك لا تُحذف بغير مالكها');
  assert.equal(asB2[0].description, 'قديمة');

  // صاحبةها تعدّل بحرية، والإدارة تعدّل النص دون نقل الملكية
  const asA = NP.enforceNoteOwners([note({ id: NOTE, createdBy: A, description: 'نصّ معدَّل', points: 6 })], teacherA, [serverNote]);
  assert.equal(asA[0].description, 'نصّ معدَّل');
  assert.equal(asA[0].points, 6);
  const asAdmin = NP.enforceNoteOwners([note({ id: NOTE, createdBy: B, description: 'تدقيق' })], admin, [serverNote]);
  assert.equal(asAdmin[0].description, 'تدقيق');
  assert.equal(asAdmin[0].createdBy, A, 'الإدارة لا تنقل الملكية');
});

// ------------- 17) الأرصدة محسوبة من المخزون الكامل قبل التصفية
// الترتيب في GET مقصود: لو صُفِّرت الملاحظات قبل الحساب لكان المجموع ناقصاً
// بقدر ما كتبته الزميلات — عكس المطلوب.
test('22) GET يحسب الأرصدة قبل التصفية لا بعدها', () => {
  const calc = SERVER_SRC.indexOf('notePrivacy.computePointsTotals(rec.data, cutDate)');
  const filter = SERVER_SRC.indexOf('notePrivacy.filterNotesForViewer(rec.data.notes, viewer)');
  assert.ok(calc > 0 && filter > 0, 'كلاهما موجود');
  assert.ok(calc < filter, 'الحساب يسبق التصفية');
});

// ------------------- 17) استرداد ملكية القديمة: مطالب لا تنقل، وموافقة تنقل
// الملاحظة بلا createdBy لا تُحذف ولا تُنسب، لكن صاحبتها لا تراها. المطالب
// خطوة أولى بلا أثر على الملكية؛ الاعتماد الإداري هو ما يكتب createdBy.
test('17) المطالب تُسجَّل ولا تنقل الملكية؛ الاعتماد الإداري ينقلها', () => {
  const legacy = note({ id: 'L1', createdBy: undefined, description: 'ملاحظتي القديمة', points: 4 });

  // --- 1) المطالب ---
  assert.equal(NP.canClaimNote(legacy, teacherA), true, 'غير المملوكة قابلة للمطالب');
  const r1 = NP.requestNoteClaim([legacy], teacherA, 'L1', '2026-10-02T10:00:00.000Z');
  assert.equal(r1.ok, true);
  assert.equal(NP.noteOwnerId(r1.note), null, 'المطالب لا تكتب createdBy');
  assert.equal(r1.note.ownershipClaims.length, 1);
  assert.equal(r1.note.ownershipClaims[0].requestedBy, A);
  assert.equal(r1.note.ownershipClaims[0].status, 'PENDING');
  assert.equal(r1.note.ownershipClaims[0].decidedBy, undefined, 'لا قرار بعد');
  // ولا صارت مرئية فوراً
  assert.equal(NP.canReadNote(r1.note, teacherA), false, 'المرئية تأتي بالاعتماد لا بالمطالب');

  // --- 2) طلب مفتوح واحد: تكرار من نفس المعلم أو من غيرها يُرفض ---
  assert.equal(NP.requestNoteClaim([r1.note], teacherA, 'L1').ok, false, 'لا تكرار لنفسها');
  const rDup = NP.requestNoteClaim([r1.note], teacherB, 'L1');
  assert.equal(rDup.ok, false, 'لا طلب ثانٍ أثناء وجود طلب مفتوح');
  assert.equal(rDup.reason, 'not_claimable');

  // --- 3) الاعتماد الإداري ---
  const r2 = NP.decideNoteClaim([r1.note], admin, 'L1', true, '2026-10-02T12:00:00.000Z');
  assert.equal(r2.ok, true);
  assert.equal(r2.note.createdBy, A, 'createdBy كُتب من طلب المعلم');
  assert.equal(r2.note.ownershipClaims[0].status, 'APPROVED');
  assert.equal(r2.note.ownershipClaims[0].decidedBy, ADM);
  assert.equal(NP.canReadNote(r2.note, teacherA), true, 'صاحتها صارت تراها');
  assert.equal(NP.canReadNote(r2.note, teacherB), false, 'زميلتها لا');
  assert.equal(NP.canReadNote(r2.note, admin), true, 'الإدارة ترى الكل');
});

test('18) الرفض لا ينقل الملكية، ولا يُقبل إلا من الإدارة', () => {
  const legacy = note({ id: 'L2', createdBy: undefined, description: 'قديمة', points: 2 });
  const claimed = NP.requestNoteClaim([legacy], teacherA, 'L2', '2026-10-02T10:00:00.000Z').note;

  // الرفض: تبقى بلا مالك وقابلة للمطالب من جديد
  const rej = NP.decideNoteClaim([claimed], admin, 'L2', false, '2026-10-02T11:00:00.000Z');
  assert.equal(rej.ok, true);
  assert.equal(rej.note.createdBy, undefined, 'الرفض لا يكتب createdBy');
  assert.equal(rej.note.ownershipClaims[0].status, 'REJECTED');
  assert.equal(NP.canReadNote(rej.note, teacherA), false, 'ما زالت غير مرئية لها');
  assert.equal(NP.canClaimNote(rej.note, teacherA), true, 'يمكن المطالب مجدداً بعد الرفض');

  // زميلة لا تستطيع الاعتماد
  const bad = NP.decideNoteClaim([claimed], teacherB, 'L2', true);
  assert.equal(bad.ok, false);
  assert.equal(bad.reason, 'forbidden');
  assert.equal(bad.changed, undefined, 'لا تعديل ولا notes مبدّلة');
  // المعلم صاحبة الطلب لا تعتمد طلبها بنفسها
  assert.equal(NP.decideNoteClaim([claimed], teacherA, 'L2', true).reason, 'forbidden');

  // ولا يُقبل قرار على ملاحظة مملوكة أصلاً أو بلا طلب مفتوح
  assert.equal(NP.decideNoteClaim([note({ id: 'L3', createdBy: A })], admin, 'L3', true).reason, 'already_owned');
  assert.equal(NP.decideNoteClaim([legacy], admin, 'L2', true).reason, 'no_pending_claim');
  assert.equal(NP.decideNoteClaim([claimed], admin, 'nope', true).reason, 'not_found');
});

test('19) لا يمكن تزوير مطالب أو قرار من PUT — الخادم هو الوحيد الذي يكتبهما', () => {
  // PUT هو آلة الدفع الوحيدة؛ لو مرّرت ownershipClaims منها لنقلت ملكية
  // ملاحظة بتوقيع مزوّر. الخادم ينقل سجل الخادم دائماً.
  const legacy = note({ id: 'L4', createdBy: undefined });
  const forged = { ...legacy, ownershipClaims: [{ requestedBy: B, status: 'APPROVED', decidedBy: 'forged' }] };
  assert.equal(NP.enforceNoteOwners([forged], teacherB, [legacy])[0].ownershipClaims, undefined,
    'سجل المطالبات لا يصل من العميل');
  assert.equal(NP.enforceNoteOwners([{ id: 'NEW1', ownershipClaims: [{ requestedBy: B }] }], teacherB, [])[0].ownershipClaims,
    undefined, 'ولا على ملاحظة جديدة');
  const mine = note({ id: NOTE, createdBy: A });
  const mineForged = { ...mine, ownershipClaims: [{ requestedBy: B, status: 'APPROVED' }] };
  assert.equal(NP.enforceNoteOwners([mineForged], teacherA, [mine])[0].ownershipClaims, undefined,
    'صاحبتها لا تكتب سجلّ مطالبات');
});

test('20) قائمة المطالبات المفتوحة: للإدارة، بلا نصّ الملاحظة', () => {
  const legacy = note({ id: 'L5', createdBy: undefined, studentName: 'طالب', category: 'الانضباط', description: 'نصّ سرّي', points: 5 });
  const claimed = NP.requestNoteClaim([legacy], teacherA, 'L5', '2026-10-02T10:00:00.000Z').note;
  const list = NP.listPendingClaims([claimed]);
  assert.equal(list.length, 1);
  assert.equal(list[0].noteId, 'L5');
  assert.equal(list[0].requestedBy, A);
  assert.equal(list[0].hasText, true);
  assert.equal(list[0].description, undefined, 'النصّ لا يخرج في قائمة الطلبات');
  assert.equal(list[0].expired, false);
  assert.equal(NP.listPendingClaims([note({ id: 'X', createdBy: A })]).length, 0, 'المملوكة لا تظهر');
  const old = NP.requestNoteClaim([legacy], teacherA, 'L5', '2020-01-01T00:00:00.000Z').note;
  assert.equal(NP.listPendingClaims([old])[0].expired, true, 'الطلب المنتهي يُعلَّم');
});

test('21) المسارات الثلاثة محمية: claim للجهة المخوَّلة، decisions للإدارة', () => {
  const grab = (p) => {
    const i = SERVER_SRC.indexOf("'" + p + "'");
    assert.ok(i > 0, 'المسار غير موجود: ' + p);
    return SERVER_SRC.slice(i, i + 4000);
  };
  const claim = grab('/api/notes/claim');
  assert.ok(/requireAuth/.test(claim), 'المطالب تتطلب جلسة');
  assert.ok(/schoolAccess/.test(claim), 'وتفحص صلاحية المدرسة');
  assert.ok(/notePrivacy\.requestNoteClaim/.test(claim));
  const list = grab('/api/notes/claims');
  assert.ok(/requireAuth/.test(list) && /isPrivilegedNotesRole/.test(list), 'القائمة للإدارة');
  const decide = grab('/api/notes/claim/decide');
  assert.ok(/requireAuth/.test(decide) && /isPrivilegedNotesRole/.test(decide), 'القرار للإدارة');
  assert.ok(/notePrivacy\.decideNoteClaim/.test(decide));
  // يكتبان عبر mutateSchoolData: قفل صف داخل معاملة، ولا كتابة إن لم يتغيّر شيء
  assert.ok(/mutateSchoolData/.test(claim) && /mutateSchoolData/.test(decide));
});

// ------------------------------------------------ test helper
// يستخرج دوال العميل الحقيقية من index.html بترميز متوازن (من «function X»
// حتى القوس الذي يغلق جسمها)، فلا نحاكي منطقاً منفصلاً ولا نقطع عند //.
function extractFn(src, name) {
  const start = src.indexOf('function ' + name + '(');
  assert.ok(start >= 0, 'لم أجد ' + name);
  const open = src.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const ch = src[i];
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  throw new Error('لم يُغلق جسم ' + name);
}

function loadClientFns(currentUser) {
  const code = [
    extractFn(CLIENT_SRC, 'NRC_isAdminNotesRole'),
    extractFn(CLIENT_SRC, 'NRC_canSeeNote'),
    extractFn(CLIENT_SRC, 'NRC_noteBelongsToOther'),
    extractFn(CLIENT_SRC, 'NRC_mergeNotes'),
  ].join('\n');
  const ctx = {
    console, Map, Set, Date, Math, JSON, Number, String, Array, Object,
    currentUser: currentUser || (() => teacherA),
  };
  vm.createContext(ctx);
  vm.runInContext(code +
    '\n;globalThis.__api = { NRC_mergeNotes, NRC_canSeeNote, NRC_noteBelongsToOther };', ctx);
  return ctx.__api;
}

test('23) الدمج: نسخة الخادم المملوكة تتقدّم على النسخة المحلية بلا مالك', () => {
  // الاعتماد الإداري يجعل الخادم يحمل createdBy. لو رجّحنا المحلي (بلا مالك)
  // لاختفت الملاحظة عن صاحبتها وظهر «طلبك قيد المراجعة» إلى الأبد.
  const F = loadClientFns(() => teacherA);
  const local = note({ id: 'L1', createdBy: undefined, description: 'نصّي القديم', updatedAt: '2026-10-02T10:00:00.000Z', _v: 9 });
  const server = note({ id: 'L1', createdBy: A, description: 'نصّي القديم', updatedAt: '2026-10-02T10:00:00.000Z', _v: 1 });
  const out = F.NRC_mergeNotes([local], [server]);
  assert.equal(out.length, 1, 'لا تكرار بنفس المعرّف');
  assert.equal(out[0].createdBy, A, 'ملكية الخادم هي المرجع');
  assert.equal(F.NRC_canSeeNote(out[0]), true);
});

test('24) الدمج العادي لم يتغيّر: الأحدث أو النسخة المحذوفة تفوز', () => {
  const F = loadClientFns(() => teacherA);
  const mine = note({ id: 'M1', createdBy: A, updatedAt: '2026-10-02T09:00:00.000Z' });
  const older = note({ id: 'M1', createdBy: A, description: 'قديم', updatedAt: '2026-10-02T08:00:00.000Z' });
  assert.equal(F.NRC_mergeNotes([mine], [older])[0].description, mine.description, 'الأحدث محلياً');
  assert.equal(F.NRC_mergeNotes([older], [mine])[0].description, mine.description, 'الأحدث من الخادم');
  // الحذف يكسب على التعديل (Reverse-delete-wins)
  const del = { ...mine, deleted: true, updatedAt: '2026-10-02T07:00:00.000Z' };
  assert.equal(F.NRC_mergeNotes([mine], [del])[0].deleted, true, 'نسخة الحذف تفوز رغم قِدمها');
  // نسخة مملوكة لزميلة تُسقَط من الدمج ولا تُطمس نسختي المحلية بلا مالك:
  // هذه هي النسخة التي تتركها «ملاحظات قديمة بلا مُدخل» بلا مالك.
  const otherOwned = note({ id: 'M2', createdBy: B, description: 'ملاحظة زميلتي' });
  const unowned = note({ id: 'M2', createdBy: undefined, description: 'نسختي القديمة' });
  const m2 = F.NRC_mergeNotes([unowned], [otherOwned]);
  assert.equal(m2.length, 1);
  assert.equal(m2[0].description, 'نسختي القديمة', 'لا تُستبدل بنسخة الزميلة');
  assert.equal(m2[0].createdBy, undefined, 'وتبقى بلا مالك قابلة للمطالب');
});
