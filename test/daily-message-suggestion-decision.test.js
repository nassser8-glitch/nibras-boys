/* اقتراحات رسالة اليوم: قرار المدير لا يُمحى عند السحب.
 *
 * العطل المُبلَّغ: بعد الاعتماد تنزل الرسالة للأسفل ولا تثبت، وبعد الرفض
 * تعود إلى صندوق «اقتراحات رسالة اليوم الواردة» لِما كانت معروضة سابقاً.
 *
 * السبب: كانت الاقتراحات تُدمج بـ__mergeMsg — دمج رسائل الإدارة، وهو
 * كتابة-أخيرة-تفوز بلا اعتبار للحالة. فيه out = {...b, ...a} وأولاهما
 * نسخة الخادم، فتلغي نسخةُ الخادم القديمة (PENDING) قرارَ المدير. وفحصُ
 * الاتساق (sugChanged) كان يقارن العدد والمعرّفات فقط فلا يكتشف تغيّر الحالة
 * ولا يرفعه، فيثبّت الإحياء الخاطئ.
 *
 * الإصلاح: __mergeSuggestion بقرار رتيب — من انتقل إلى قرار لا يعود إلى
 * PENDING أبداً، وبين قرارين الأحدث وقتاً (decidedAt).
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

function sliceBetween(src, start, end){
  const i = src.indexOf(start);
  assert.ok(i >= 0, 'لم يُعثر على: ' + start);
  const j = end ? src.indexOf(end, i + start.length) : src.length;
  return src.slice(i, j >= 0 ? j : src.length);
}

function api(){
  const SRC = [
    sliceBetween(HTML, 'function __mergeMsg(', 'function mergeClassesLocal('),
    sliceBetween(HTML, 'function __mergeSuggestion(', '// دمج الفصول حقولاً بحقل'),
  ].join('\n');
  return new Function(SRC + '\nreturn { __mergeMsg, __mergeSuggestion };')();
}

function Sug(over){
  return Object.assign({
    id: 's1', authorId: 'T1', authorName: 'ابتسام', authorRole: 'TEACHER',
    text: 'كل عام وأنتم بخير', words: 4, status: 'PENDING', createdAt: '2026-10-05T07:00:00.000Z',
  }, over || {});
}

test('دمج رسائل الإدارة لم يتغيّر: آخر كتابة تفوز كسابق', () => {
  const { __mergeMsg } = api();
  const srv = { id: 'm1', text: 'من الخادم', read: false, createdAt: '2026-10-05T08:00:00.000Z' };
  const loc = { id: 'm1', text: 'من الجهاز', read: true, createdAt: '2026-10-05T08:00:00.000Z' };
  const out = __mergeMsg(srv, loc);
  assert.equal(out.text, 'من الخادم', 'سلوك رسائل الإدارة لم يتغيّر — نسوي Suggestions فقط');
  assert.equal(out.read, true, 'خصائص القراءة تبقى منطقية');
});

test('رفضُ المدير لا يُمحَى بسحب نسخة الخادم القديمة', () => {
  const { __mergeSuggestion } = api();
  /* الخادم ما زال يحمل PENDING لأن الدفع مؤجَّل — هذا هو واقع الإنتاج */
  const srv = Sug({ status: 'PENDING' });
  const loc = Sug({ status: 'REJECTED', rejectedAt: '2026-10-05T10:00:00.000Z', decidedAt: '2026-10-05T10:00:00.000Z' });
  const out = __mergeSuggestion(srv, loc);
  assert.equal(out.status, 'REJECTED', 'قرار الرفض يبقى — لا يعود إلى PENDING (كان يعود فيحيا المقترح)');
  assert.equal(out.rejectedAt, '2026-10-05T10:00:00.000Z');
});

test('اعتمادُ المدير لا ينزلق لأسفل عند سحب نسخة الخادم القديمة', () => {
  const { __mergeSuggestion } = api();
  const srv = Sug({ status: 'PENDING' });
  const loc = Sug({ status: 'APPROVED', approvedAt: '2026-10-05T10:00:00.000Z', decidedAt: '2026-10-05T10:00:00.000Z' });
  const out = __mergeSuggestion(srv, loc);
  assert.equal(out.status, 'APPROVED', 'يبقى معتمداً فلا يهبط إلى صندوق المعلّق');
});

test('الاتجاه المعاكس محميّ أيضاً: سحب خادمٍ فيه قرار لا يُلغي الجهاز', () => {
  const { __mergeSuggestion } = api();
  const srv = Sug({ status: 'APPROVED', decidedAt: '2026-10-05T10:00:00.000Z' });
  const loc = Sug({ status: 'PENDING' });
  assert.equal(__mergeSuggestion(srv, loc).status, 'APPROVED');
});

test('بين قرارين متعارضين يأخذ الأحدث وقتاً', () => {
  const { __mergeSuggestion } = api();
  const srv = Sug({ status: 'REJECTED', decidedAt: '2026-10-05T10:00:00.000Z' });
  const loc = Sug({ status: 'APPROVED', decidedAt: '2026-10-05T10:05:00.000Z' });
  assert.equal(__mergeSuggestion(srv, loc).status, 'APPROVED', 'الاعتماد الأحدث يسبق الرفض الأقدم');
  const loc2 = Sug({ status: 'APPROVED', decidedAt: '2026-10-05T09:55:00.000Z' });
  assert.equal(__mergeSuggestion(srv, loc2).status, 'REJECTED', 'ولا يبتلع الأقدمُ الأحدثَ');
});

test('ما زال معلقاً على الجهتين فيبقى معلقاً', () => {
  const { __mergeSuggestion } = api();
  assert.equal(__mergeSuggestion(Sug(), Sug()).status, 'PENDING');
});

test('دمج الاقتراحات لا يمسّ نصّه: الحالة وحدها تُدمج ترتيبياً', () => {
  const { __mergeSuggestion } = api();
  const out = __mergeSuggestion(Sug({ text: 'النص النهائي' }), Sug({ status: 'REJECTED', decidedAt: '2026-10-05T10:00:00.000Z' }));
  assert.equal(out.text, 'النص النهائي', 'الحالة وحدها هي ما ندمجها ترتيبياً');
  assert.equal(out.authorName, 'ابتسام');
  assert.equal(out.id, 's1');
});

test('لا حالة مفقودة تُخترع', () => {
  const { __mergeSuggestion } = api();
  assert.equal(__mergeSuggestion(Sug(), { id: 's1' }).status, 'PENDING');
  assert.equal(__mergeSuggestion({ id: 's1' }, Sug()).status, 'PENDING');
  assert.equal(__mergeSuggestion({ id: 's1' }, { id: 's1' }).status, undefined);
});

test('الدمجان في السحب يستعملان __mergeSuggestion للقسم suggestions وحده', () => {
  const p1 = 'sd.suggestions = unionMsgs(srvSug, localSug, __mergeSuggestion);';
  const p2 = 'merged.suggestions = unionMsgsP(merged.suggestions, local.suggestions, __mergeSuggestion);';
  assert.ok(HTML.includes(p1), 'مسار السحب الأُوَل يستعمل دالة الاقتراحات');
  assert.ok(HTML.includes(p2), 'مسار السحب الثاني يستعمل دالة الاقتراحات');
  assert.ok(/sd\.adminMsgs = unionMsgs\(srvMsgs, localMsgs\);/.test(HTML),
    'رسائل الإدارة تبقى على __mergeMsg كما هي');
  assert.ok(/merged\.adminMsgs = unionMsgsP\(merged\.adminMsgs, local\.adminMsgs\);/.test(HTML),
    'رسائل الإدارة في المسار الثاني تبقى كما هي');
});

test('الدمجان يقبلان دالة دمج مؤهَّلة بدل تثبيت __mergeMsg', () => {
  const a = sliceBetween(HTML, 'const unionMsgs = (srvArr, locArr, merge)', 'const srvMsgs');
  const b = sliceBetween(HTML, 'const unionMsgsP = (srvArr, locArr, merge)', 'if(Array.isArray(local.adminMsgs))');
  for(const src of [a, b]){
    assert.ok(/merge \|\| __mergeMsg/.test(src), 'يوجد اسم merger مع افتراضي __mergeMsg');
    assert.ok(/\(merge \|\| __mergeMsg\)\(m\.get\(x\.id\), x\)/.test(src), 'والتنفيذ يمرّرها عند التصادم');
  }
});

test('كشفُ الاتساق sugChanged يقارن الحالة لا المعرّف فقط', () => {
  const src = sliceBetween(HTML, 'const sugChanged =', 'sd.adminMsgs =');
  assert.ok(/y\.status !== x\.status/.test(src),
    'تغيّر الحالة وحده يجب أن يُعلَّم تغيّراً — وإلا لم يُرفع وبقيت الحالة الخاطئة');
});

test('الاعتماد والرفض يكتبان decidedAt ليُرتَّب القرار بين الأجهزة', () => {
  const ap = sliceBetween(HTML, 'function approveSuggestion(', 'function rejectSuggestion(');
  const rj = sliceBetween(HTML, 'function rejectSuggestion(', 'function fmtTime(');
  assert.ok(/t\.decidedAt\s*=/.test(ap), 'الاعتماد يسجّل decidedAt');
  assert.ok(/t\.decidedAt\s*=/.test(rj), 'الرفض يسجّل decidedAt');
  assert.ok(/t\.status = 'APPROVED'/.test(ap) && /t\.status = 'REJECTED'/.test(rj));
});

test('كود اقتراحات رسالة اليوم سليم من محارف تالفة', () => {
  const src = HTML.slice(HTML.indexOf('function __mergeSuggestion'), HTML.indexOf('// دمج الفصول حقولاً بحقل'));
  assert.ok(!/[\u4e00-\u9fff]/.test(src), 'لا محارف صينية في التعليق');
  assert.ok(!src.includes('\uFFFD'), 'لا محرف تالف');
});
