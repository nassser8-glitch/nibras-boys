'use strict';
/* =============================================================================
 * خصوصية تحويلات الطلاب — من يرى التحويل
 *
 * القاعدة المطلوبة: الإشراف (المدير/الوكيل/الموجه) يرى كل تحويلات المدرسة،
 * والمعلم ترى ما أرسلته هي فقط. قبل هذا كانت GET /api/db/:school ترسل
 * القسم كاملاً لكل جهاز، فكل معلم كانت تسحب تحويلات زميلاتها وتقرأ أسماء
 * طلابها وأسباب تحويلهم من تخزين المتصفح.
 * ========================================================================== */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const TP = require(path.join(ROOT, 'transfers-privacy.js'));
const SERVER_SRC = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const CLIENT_SRC = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const DOCKER_SRC = fs.readFileSync(path.join(ROOT, 'Dockerfile'), 'utf8');

const T1 = 'tr_by_A';       // أرسلتها المعلم A
const T2 = 'tr_by_B';       // أرسلتها المعلم B
const T3 = 'tr_legacy';     // بلا createdBy (تحويل قديم)
const A = 'teacher_A';
const B = 'teacher_B';
const ADM = 'admin_1';
const AGENT = 'agent_1';
const COUNS = 'counselor_1';
const STU = 'student_1';

const mk = (id, by, over) => Object.assign({
  id, studentId: STU, studentName: 'طالب', target: 'ADMIN',
  priority: 'MEDIUM', reason: 'تجربة', status: 'PENDING',
  createdAt: '2026-10-01T09:00:00.000Z', deductedPoints: -3,
}, over || {}, by == null ? {} : { createdBy: by });

const V = (role, id) => ({ role, user_id: id });

// ------------------------------------------------------- 1) الإشراف يرى الكل
test('1) المدير والوكيل والموجه يرون كل تحويلات المدرسة', () => {
  const all = [mk(T1, A), mk(T2, B), mk(T3, null)];
  for (const v of [V('ADMIN', ADM), V('AGENT', AGENT), V('COUNSELOR', COUNS)]) {
    assert.deepEqual(TP.filterTransfersForViewer(all, v).map(t => t.id), [T1, T2, T3],
      'دور ' + v.role + ' يرى الكل');
  }
});

// ------------------------------------------- 2) المعلم ترى ما أرسلته فقط
test('2) المعلم ترى تحويلاتها وحدها، لا تحويلات زميلتها', () => {
  const all = [mk(T1, A), mk(T2, B), mk(T3, null)];
  assert.deepEqual(TP.filterTransfersForViewer(all, V('TEACHER', A)).map(t => t.id), [T1]);
  assert.deepEqual(TP.filterTransfersForViewer(all, V('TEACHER', B)).map(t => t.id), [T2]);
});

// --------------------------------------------------- 3) بلا استثناءات مريحة
test('3) لا تفضيل بالاسم، ولا مسار جانبي للطالب', () => {
  const legacy = [mk(T3, null)];
  // بلا createdBy لا يمر لأحد غير الإشراف: لا نخمّن صاحب التحويل
  assert.deepEqual(TP.filterTransfersForViewer(legacy, V('TEACHER', A)), []);
  assert.equal(TP.filterTransfersForViewer(legacy, V('ADMIN', ADM)).length, 1, 'الإشراف يرى القديم');
  // الطالب لا يرى شيئاً
  assert.deepEqual(TP.filterTransfersForViewer([mk(T1, A)], V('STUDENT', STU)), []);
  // ولا «معلم» بلا جلسة ولا مستخدم بلا دور
  assert.deepEqual(TP.filterTransfersForViewer([mk(T1, A)], null), []);
  assert.deepEqual(TP.filterTransfersForViewer([mk(T1, A)], V('TEACHER', null)), []);
  // والقيم الفارغة لا تُعدّ معرّفات
  assert.equal(TP.transferOwnerId({ createdBy: '   ' }), '');
  assert.equal(TP.transferOwnerId({}), '');
  assert.equal(TP.transferOwnerId(null), '');
});

// ------------------------------------- 4) أنواع المعرّفات (رقم/نص) متساوية
test('4) معرّف المالك يُقارن كنص (رقم قديم في البيانات لا نص)', () => {
  const byNum = [mk(T1, 12345)];
  assert.deepEqual(TP.filterTransfersForViewer(byNum, V('TEACHER', '12345')).map(t => t.id), [T1]);
  assert.deepEqual(TP.filterTransfersForViewer([mk(T1, '12345')], V('TEACHER', 12345)).map(t => t.id), [T1]);
  assert.deepEqual(TP.filterTransfersForViewer(byNum, V('TEACHER', '12346')), []);
});

// --------------------------------- 5) الخادم يطبّقها على الاستجابة لا الواجهة
test('5) GET /api/db/:school يصفّي التحويلات بالمشاهد نفسه', () => {
  const start = SERVER_SRC.indexOf("app.get('/api/db/:school'");
  assert.ok(start > 0);
  const block = SERVER_SRC.slice(start, start + 9000);
  assert.ok(/transferPrivacy\.filterTransfersForViewer\(rec\.data\.transfers, viewer\)/.test(block),
    'التصفية على الاستجابة');
  // نفس الـviewer المستعمل للملاحظات: معرّف واحد للجلسة، لا اسم ولا جسم الطلب
  const vLine = block.match(/const viewer = \{[^}]*\}/);
  assert.ok(vLine && /req\.session\.role/.test(vLine[0]) && /req\.session\.user_id/.test(vLine[0]),
    'المشاهد يأتي من الجلسة');
  assert.ok(block.indexOf('transferPrivacy.filterTransfersForViewer') < block.indexOf('res.json({ ts: rec.ts'),
    'قبل الإرسال');
});

// --------------------------------------- 6) عميل transferForMe يطابق القاعدة
test('6) transferForMe في الواجهة يطابق الخادم (خط ثانٍ لا بديل)', () => {
  const code = extractFn(CLIENT_SRC, 'transferForMe');
  const ctx = { console, Set, String };
  vm.createContext(ctx);
  let current = null;
  vm.runInContext(code + '\n;globalThis.transferForMe = transferForMe;', Object.assign(ctx, {
    currentUser: () => current,
  }));
  const f = ctx.transferForMe;
  for (const [role, id] of [['ADMIN', ADM], ['AGENT', AGENT], ['COUNSELOR', COUNS]]) {
    current = { role, id };
    for (const t of [mk(T1, A), mk(T2, B), mk(T3, null)]) assert.equal(f(t), true, role);
  }
  current = { role: 'TEACHER', id: A };
  assert.equal(f(mk(T1, A)), true, 'أرسلتها');
  assert.equal(f(mk(T2, B)), false, 'زميلتها');
  assert.equal(f(mk(T3, null)), false, 'قديم بلا مرسل');
  current = { role: 'STUDENT', id: STU };
  assert.equal(f(mk(T1, A)), false, 'الطالب');
  current = null;
  assert.equal(f(mk(T1, A)), false, 'بلا مستخدم');
});

// ------------------------------ 7) لا مكان آخر يعدّ تحويلات غير مرئية لك
test('7) الإحصاءات والعدّادات تتجاهل تحويلات الآخرين', () => {
  // لوحة الإدارة: عدّاد المعلم يجب أن يخصّها هي
  assert.ok(/pendingTransfers: d\.transfers\.filter\(t => t\.status === 'PENDING' && transferForMe\(t\)\)/.test(CLIENT_SRC),
    'عدّاد المعلم لا يحصي تحويلات زميلاتها');
  // «الطلاب الأكثر تحويلاً» يكشف الأسماء والعدّاد
  const ins = CLIENT_SRC.indexOf('function __insightFrequentTransfers');
  assert.ok(ins > 0);
  const block = CLIENT_SRC.slice(ins, ins + 900);
  assert.ok(/if\(!transferForMe\(t\)\) continue;/.test(block), 'الإحصاء يخطّي ما ليس مرئياً');
});

// ------------------------------------------------ 8) الملف يصل إلى الحاوية
test('8) transfers-privacy.js منسوخة في Dockerfile', () => {
  assert.ok(/COPY[^\n]*transfers-privacy\.js/.test(DOCKER_SRC),
    'وإلا فشل require على Render');
});

// --------------------------------------------------------------- helpers
function extractFn(src, name) {
  const start = src.indexOf('function ' + name + '(');
  assert.ok(start >= 0, 'لم أجد ' + name);
  const open = src.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  throw new Error('لم يُغلق جسم ' + name);
}
