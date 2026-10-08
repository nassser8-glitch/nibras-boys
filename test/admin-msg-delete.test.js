/* حذف رسائل «رسائل للمعلمين» كان مؤقتًا: تُحذف من الشاشة ثم يعيدها الدمج.
 *
 * السبب: deleteAdminMsg كان يمحو السجل من المصفوفة ثم يرفعها، ودمج الخادم
 * (mergeSection و mergeAdminMsgs) اتحادي حسب id — فالسجلّ الموجود في نسخة
 * الخادم القديمة ويعود دائمًا، فيظهر بعد أي سحب. لاحظت الإدارة ذلك: «عند
 * حذف الرسائل السابقة تعود للظهور».
 *
 * الإصلاح: أسافين الحذف المعهودة في الأقسام (deleted = true) — تُحذف
 * بوضع علامة لا بمحو السجل، فيبقى شاهدًا في القاعدة حتى يحمله الخادم،
 * والفلترة عند القراءة. لذا نختبر: الشاهد لا يُعرض، والدالة الكاتبة لا
 * تمسّه، والدمج لا يعيد إحياءه من جهة قديمة، والشقيقتان المتطابقتان
 * تنهاران إلى محذوفة واحدة إن حُذفت إحداهما.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const HTML = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const SERVER = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');

function extractFn(src, name){
  const i = src.indexOf('function ' + name + '(');
  assert.ok(i >= 0, 'لم يُعثر على دالة ' + name);
  const open = src.indexOf('{', i);
  let depth = 0;
  for(let k = open; k < src.length; k++){
    if(src[k] === '{') depth++;
    else if(src[k] === '}'){ depth--; if(depth === 0) return src.slice(i, k + 1); }
  }
  throw new Error('دالة ' + name + ' بلا نهاية');
}
function sliceBetween(src, start, end){
  const i = src.indexOf(start);
  assert.ok(i >= 0, 'لم يُعثر على: ' + start);
  const j = end ? src.indexOf(end, i + start.length) : src.length;
  return src.slice(i, j >= 0 ? j : src.length);
}

/* ===== شهادات الخادم ===== */
const SRC_SRV = extractFn(SERVER, 'mergeSection') + '\n' + extractFn(SERVER, 'mergeAdminMsgs');

test('الدمج اتحادي: حذفُ قديمٍ أجهلَ (دفتريّ) يعيد الرسالة — هذه جذور العلة لا حللها', () => {
  const mergeAdminMsgs = new Function(SRC_SRV + '; return mergeAdminMsgs;')();
  const X = { id:'x1', teacherId:'ALL', text:'اختبار سحاب', senderRole:'ADMIN', createdAt:'2026-09-01T00:00:00.000Z' };
  // النسخة القديمة كانت ترفع القسم بلا x1 إطلاقًا، فلا يعلم الخادم أنه حذف
  const out = mergeAdminMsgs([X], []);
  assert.equal(out.length, 1, 'الخادم لا يدري بالحذف فيعيد الرسالة');
  assert.equal(out[0].deleted, undefined, 'وهذه هي العلة التي عولجت بواسطة الحذف الأدبي لا المحو');
});

test('الخادم يجعل شاهد الحذف لاصقًا: نسخةُ جهاز قديم بلا الرسالة لا تُحييها', () => {
  const mergeAdminMsgs = new Function(SRC_SRV + '; return mergeAdminMsgs;')();
  const X = { id:'x1', teacherId:'ALL', text:'اختبار سحاب', senderRole:'ADMIN', createdAt:'2026-09-01T00:00:00.000Z', deleted:true };
  const out = mergeAdminMsgs([X], []);
  assert.equal(out.length, 1);
  assert.equal(out[0].deleted, true, 'الأسافين لاصقة: لا تُحيى من جهاز قديم');
});

test('وصول شاهد حذفٍ جديد يثبت ولا يُنافس، ولا تجيء نسخة منافسة حيّة معه', () => {
  const mergeAdminMsgs = new Function(SRC_SRV + '; return mergeAdminMsgs;')();
  const mk = (id, over) => Object.assign({
    id, teacherId:'ALL', text:'مرحبا', senderRole:'ADMIN', senderName:'المدير', senderId:'a1',
    createdAt:'2026-09-01T00:00:00.000Z', read:false, dismissed:false, seenBy:{},
  }, over || {});
  const live = mk('x1');
  const tomb = mk('x1', { deleted:true, deletedAt:'2026-09-02T00:00:00.000Z', deletedBy:'الإدارة' });
  assert.deepEqual(mergeAdminMsgs([live], [tomb]).map(m => m.deleted), [true]);
  assert.deepEqual(mergeAdminMsgs([tomb], [live]).map(m => m.deleted), [true],
    'الأولى دائمًا للشاهد، ولو جاءت النسخة الحيّة لاحقًا في الوصل');
  // والشاهد يبقى في القسم بعد الحفظ — لا يُمحى — حتى تعرفه كل الأجهزة
  assert.equal(mergeAdminMsgs([tomb], [live]).length, 1);
});

test('شقيقتان متطابقتا المصدر تنهاران، وحذف إحداهما يمحو الكتلة كلّها', () => {
  const mergeAdminMsgs = new Function(SRC_SRV + '; return mergeAdminMsgs;')();
  const mk = (id, over) => Object.assign({
    id, teacherId:'ALL', text:'رسالة مكررة من جهازين', senderRole:'AGENT', senderName:'الوكيل', senderId:'a2',
    createdAt:'2026-09-01T00:00:00.000Z', seenBy:{}, dismissed:false, read:false,
  }, over || {});
  const out = mergeAdminMsgs([mk('a'), mk('b')], [mk('b', { deleted:true })]);
  assert.equal(out.length, 1, 'الاخوتان تتحدان نسخةً واحدة كما كان');
  assert.equal(out[0].deleted, true, 'وحذفُ إحداهما يقتل النسخة الموحدة — لا تُبعث أختٌ حيّة');
});

/* ===== شهادات العميل ===== */
const SRC_CLI = [
  extractFn(HTML, 'aliveMsgs'),
  extractFn(HTML, '__mergeMsg'),
].join('\n');

test('aliveMsgs يفلتر شاهد الحذف ويُبقي الحي', () => {
  const aliveMsgs = new Function(SRC_CLI + '; return aliveMsgs;')();
  assert.deepEqual(aliveMsgs([{id:1}, {id:2, deleted:true}, null]).map(m => m.id), [1]);
  assert.deepEqual(aliveMsgs(undefined), []);
});

test('__mergeMsg يجعل deleted لاصقًا في السحب: حسّ ذاكرةِ الجهاز لا يحيي المبعوثة', () => {
  const __mergeMsg = new Function(SRC_CLI + '; return __mergeMsg;')();
  const live = { id:'x', teacherId:'ALL', text:'ت', read:false, dismissed:false };
  const tomb = { id:'x', teacherId:'ALL', text:'ت', deleted:true };
  assert.equal(__mergeMsg(tomb, live).deleted, true, 'يبدِّدها شاهدُ الخادم');
  assert.equal(__mergeMsg(live, tomb).deleted, true, 'ولا يبدِّدها الذاكرةُ المحلية قبل وصول الشاهد للخادم (تزول عابرةً لا دائمة)');
});

test('دالة الحذف تضع علامة ولا تمحو السجل — فلا تفقد الأسافين', () => {
  const del = extractFn(HTML, 'deleteAdminMsg');
  assert.ok(!/arr\.filter\(x => x\.id !== id\)/.test(del), 'لا محو بفلترة المصفوفة');
  assert.ok(/m\.deleted = true/.test(del), 'شاهدٌ دائِم: deleted = true');
  assert.ok(/saveAdminMsgsFor\(school, arr\)/.test(del), 'ويكتب القسمَ بما فيه الشاهد');
  assert.ok(del.includes('deletedBy'), 'ويسجّل من حذف');
});

test('محرك السحب (unionMsgs) يمر عبر __mergeMsg فيبقى الشاهد لاصقًا', () => {
  const unionSrc = sliceBetween(HTML, 'const unionMsgs = (srvArr, locArr, merge) => {', 'const srvMsgs = ');
  const unionMsgs = new Function(SRC_CLI + '\n' + unionSrc + '\n;return unionMsgs;')();
  const live = { id:'x', teacherId:'ALL', text:'ت', read:false, dismissed:false };
  const tomb = { id:'x', teacherId:'ALL', text:'ت', deleted:true };
  assert.equal(unionMsgs([tomb], [live])[0].deleted, true, 'شاهد الخادم يكسب');
  assert.equal(unionMsgs([live], [tomb])[0].deleted, true, 'والمحو المحلي لا يضيع في السحب');
  assert.equal(unionMsgs([live], []).length, 1, 'والخادم بلا شاهد بعد: الرسالة حيّة كما ينبغي');
});

test('مواقع القراءة تفلتر الشاهد، والمواقع الكاتبة تعمل على المصفوفة الكاملة', () => {
  // قراءة
  assert.ok(/return aliveMsgs\(loadAdminMsgs\(\)\)/.test(HTML), 'adminMsgsFor تفلتر');
  assert.ok(/aliveMsgs\(loadAdminMsgs\(\)\)\.filter\(m => \(m\.teacherId === teacherId/.test(HTML), 'صفحة متابعة المعلم تفلتر');
  assert.ok(/aliveMsgs\(loadAdminMsgs\(\)\)\s*\n\s*\.filter\(m => inRange/.test(HTML), 'تصدير التقارير يفلتر');
  assert.ok(/aliveMsgs\(\[?['"BOYS'"]/.test(HTML) || /\.flat\(\)\)\.filter/.test(HTML), 'إشعارات المدير تفلتر');
  // كتابة
  assert.ok(/const arr = loadAdminMsgsFor\(targetSchool\);/.test(HTML), 'إرسالُ جديد يبني من المصفوفة الكاملة');
  assert.ok(/const arr = loadAdminMsgs\(\);\s*\n\s*arr\.push/.test(HTML), 'كل رسالة جديدة تُلحق بالكاملة');
  // دالة الكتابة لا تعبر aliveMsgs إطلاقًا — وإلا ضاع الشاهد وعادت الرسالة
  const send = extractFn(HTML, 'sendAdminMsg');
  assert.ok(!send.includes('aliveMsgs'), 'الكتابة لا تفلتر');
  assert.ok(/loadAdminMsgsFor\(targetSchool\)/.test(send), 'وتقرأ من الخام الكامل قبل إلحاق الجديد');
});

test('الملفان سليمان من حروف خارج العربية', () => {
  for(const [label, s] of [['index', HTML], ['server', SERVER]]){
    assert.ok(!/[\u0400-\u04FF\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(s), label + ' بلا سيريلية/صينية/كورية');
    assert.ok(!s.includes('\uFFFD'), label + ' بلا محرف تالف');
  }
});