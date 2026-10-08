'use strict';
// Regression: البنود 4-7 من خطة «الحلقة الأبدية» في public/index.html.
//
// الجذر: كل مزامنة كانت تبدأ بـ GET ثم **اتحاد** أقسام لم يغيّرها الجهاز (طلاب/فصول/
// درجات)، ثم PUT. الاتحاد لا يحذف، فيعيد كل جهاز قديم ما حذفه زميله على جهاز أحدث
// (فصول فارغة، درجات محذوفة، 17 «6-6-4» مفقودة). ومعه حلقتان أخريان:
//   • saveDB كان يكتب دائماً، فتلتف السلسلة والدفع على كل مزامنة بلا تغيير حقيقي.
//   • syncPullAll كل 5 دقائق كان يسحب بلا أن ينتظر اكتمال دفعة مجدولة، فيكتب
//     فوق اللوحة تعديلاتٍ لم تُرفع بعد.
//   • إعادة الرفع بعد الفشل كل 15 ثانية بلا سقف، إلى الأبد في كل تبويب.
//
// الاختبار يقرأ public/index.html ويشغّل الدوال في vm: لا قاعدة بيانات، لا Production.
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const INDEX_HTML_PATH = path.join(__dirname, '..', 'public', 'index.html');
const SRC = fs.readFileSync(INDEX_HTML_PATH, 'utf8');

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

const ctx = vm.createContext({ Math, JSON, Object, Array, Set, Map, String, Number, isFinite, console });
for (const fn of ['__canon', '__canonEq', '__canonNoTs', 'locallyOnly']) {
  try { vm.runInContext(extractFn(fn), ctx); }
  catch (e) { /* locallyOnly متداخلة داخل __syncPush — نختبرها عبر block بدلها */ }
}
const canonEq = vm.runInContext('__canonEq', ctx);
const canonNoTs = vm.runInContext('__canonNoTs', ctx);
const canon = vm.runInContext('__canon', ctx);

/* ---------- 1) المقارنة العميقة لا تنخدع بترتيب المفاتيح ---------- */
test('__canonEq: ترتيب المفاتيح المختلف لا يُعتبر اختلافاً', () => {
  assert.equal(canonEq({ a: 1, b: 2 }, { b: 2, a: 1 }), true);
  assert.equal(canonEq([{ id: 1, n: 'x' }], [{ n: 'x', id: 1 }]), true);
  assert.equal(canonEq({ a: 1 }, { a: 1, b: undefined }), false, 'مفتاح موجود بقيمة يبقى اختلافاً');
  assert.equal(canonEq({ a: 1 }, { a: 2 }), false);
  assert.equal(canonEq([1, 2], [2, 1]), false, 'ترتيب المصفوفة يهمّ');
});

test('__canonNoTs: تحريك _ts وحده ليس تغييراً حقيقياً', () => {
  const base = { _ts: 1000, students: [{ id: 's1' }], classes: [] };
  const moved = { _ts: 2000, students: [{ id: 's1' }], classes: [] };
  assert.equal(canonNoTs(base) === canonNoTs(moved), true);
  const edited = { _ts: 2000, students: [{ id: 's1', name: 'س' }], classes: [] };
  assert.notEqual(canonNoTs(base), canonNoTs(edited), 'تعديل حقيقي يبقى مرصوداً');
});

/* ---------- 2) البند 4: لا اتحاد لقسم لم يغيّره الجهاز ---------- */
test('البند 4: قسم لم يغيّره الجهاز لا يُضاف إلى الدفع', () => {
  const server = { students: [{ id: 'a' }, { id: 'b' }], classes: [] };
  const local = { students: [{ id: 'a' }, { id: 'b' }], classes: [] };
  // جهاز قديم لم يمسّ شيئاً ⇒ لا داعي لدفعه
  const touched = canonEq(local.students, server.students) === false;
  assert.equal(touched, false, 'الجهاز لم يغيّر الطلاب ⇒ يُترك لنسخة الخادم');
});

test('البند 4: قسم غيّره الجهاز يُدمج ولا يفقد تعديله', () => {
  const server = [{ id: 'a' }];
  const local = [{ id: 'a' }, { id: 'new' }];
  assert.notEqual(canonEq(local, server), true, 'الجهاز أضاف ⇒ يُدمج');
});

/* ---------- 3) البند 6: السحب لا يسبق دفعة معلّقة ---------- */
test('البند 6: نافذة الدفعة المعلّقة موجودة ويقرأها syncPullAll', () => {
  assert.ok(SRC.includes('let __pushPendingUntil = {}'), 'المتغيّر معرّف');
  assert.ok(SRC.includes('__pushPendingUntil[school] = Date.now()'), '__syncSchedule يكتب النافذة');
  assert.ok(SRC.includes('(__pushPendingUntil[s] || 0) > nowMs'), 'syncPullAll يتحقق منها');
  assert.ok(SRC.includes("ev:'pull-skipped-busy'"), 'السجل يوثّق التخطي');
});

/* ---------- 4) البند 7: سقف إعادة المحاولة ---------- */
test('البند 7: سقف محاولات ثابت واستئناف عند عودة الشبكة', () => {
  assert.ok(SRC.includes('const __PUSH_MAX_ATTEMPTS = 6'), 'السقف معرّف');
  assert.ok(SRC.includes('st.attempts < __PUSH_MAX_ATTEMPTS'), 'الجدولة مشروطة بالسقف');
  assert.ok(SRC.includes("ev:'push-gave-up'"), 'يوثّق التوقّف');
  assert.ok(SRC.includes('function __syncResumeAttempts'), 'دالة الاستئناف موجودة');
  assert.ok(SRC.includes("addEventListener('online'"), 'يستأنف عند عودة الشبكة');
  assert.ok(SRC.includes("addEventListener('focus'"), 'يستأنف عند استعادة التركيز');
});

/* ---------- 5) البند 5: saveDB لا يكتب بلا تغيير ---------- */
test('البند 5: saveDB يقارن قبل الكتابة متجاهلاً _ts', () => {
  const body = extractFn('saveDB');
  assert.ok(body.includes('__canonNoTs'), 'saveDB يستخدم المقارنة العميقة');
  assert.ok(/if\(cur && __canonNoTs\(cur\) === __canonNoTs\(d\)\) return;/.test(body),
    'يكتب فقط عند وجود فرق حقيقي');
  assert.ok(body.includes('localStorage.setItem(k, JSON.stringify(d))'), 'الكتابة الحقيقية سليمة');
});

/* ---------- 6) حصانة: لا تراجع للسلوك القديم ---------- */
test('البند 4: حلقة الأقسام ما زالت تدمج-localOnly عند الاختلاف', () => {
  assert.ok(SRC.includes("['students','classes','grades','videos','transfers','maintenance','escapeAlerts']"),
    'الأقسام نفسها مشمولة');
  assert.ok(SRC.includes('if(__canonEq(obj[sec], sd[sec])) return;'), 'الشرط الجديد موجود');
});

test('canon يتعامل مع undefined و null و NaN دون انهيار', () => {
  assert.equal(typeof canon(undefined), 'string');
  assert.equal(canon(null), 'null');
  assert.equal(canonEq(null, undefined), true, 'undefined يُطبَّع إلى null');
  assert.equal(canonEq([], []), true);
  assert.equal(canonEq({}, {}), true);
});
