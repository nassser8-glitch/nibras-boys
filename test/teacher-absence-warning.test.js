/* تنبيه غياب المعلم: لا يظهر قبل 3 أيام، ويظهر بعدها.
 *
 * المطلوب: تُظهِر نبراس للمعلم تنبيهاً حين يتجاوز غيابها 3 أيام.
 * والطالَب تجاوزٌ حرفياً: غياب 3 أيام لا يُظهر شيئاً، وغياب 4 أيام يُظهر.
 * ولذلك نقيس الحدّ الأدنى والمتوسط والحدّ العلوي بدقة، لا بادعاء «أكثر من
 * صفر» أو «أي شيء كبير» — وإلا ضاع المعنى في اختبار لا يمسّ الشيفرة.
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
  // الثابت انتقل قسم العتبات (أعلى الملف)، والدالة بقيت مكانها — نأخذ الاثنتين على حدة
  const SRC = [
    sliceBetween(HTML, 'const ABSENT_WARN_DAYS =', ';'),
    sliceBetween(HTML, 'function absentWarningHtml(', 'const LATE_TYPE_NAMES'),
  ].join('\n');
  return new Function(SRC + '\nreturn { absentWarningHtml, ABSENT_WARN_DAYS };')();
}

test('الحدّ منظور ثابت: 3 أيام', () => {
  const { ABSENT_WARN_DAYS } = api();
  assert.equal(ABSENT_WARN_DAYS, 3, 'المطلوب: تجاوز 3 أيام');
});

test('غياب 0 أو 1 أو 2 أو 3 لا يظهر تنبيهاً', () => {
  const { absentWarningHtml } = api();
  for(const n of [0, 1, 2, 3, null, undefined, '']){
    assert.equal(absentWarningHtml(n, 'T1', true), '',
      'الغياب ' + n + ' لم يتجاوز الحدّ فلا تنبيه');
  }
});

test('غياب 4 أيام فأكثر يظهر التنبيه', () => {
  const { absentWarningHtml } = api();
  for(const n of [4, 5, 7, 12, 40]){
    const html = absentWarningHtml(n, 'T1', true);
    assert.ok(html.length > 0, 'الغياب ' + n + ' تجاوز الحدّ فيظهر التنبيه');
    assert.ok(html.includes(String(n)), 'والعدد المذكور هو ' + n);
    assert.ok(html.includes('3'), 'ويمدح حدّ 3 أيام المنصوب');
  }
});

test('النصّ لا يُجرِّم المعلم ولا يخاطبها بلغة التذكير', () => {
  /* التطبيق لكل المعلمين والمعلمين، فالنبرة محايدة لا «اضغطي» ولا «أنت» */
  const html = api().absentWarningHtml(5, 'T1', true);
  assert.ok(!/اضغطي|مسجَّلة|غيابكِ/.test(html), 'لا خطاب مؤنث إجباري');
  assert.ok(!/تجاوزتِ|لديكِ/.test(html), 'لا فعل مؤنث إجباري');
  assert.ok(html.includes('5'), 'والعدد يظهر ككائن لا كحكاية');
  assert.ok(html.includes('أيام'), 'وعدد جمع منصوب');
});

test('التنبيه يفتح قائمة أيام الغياب النقر عليها', () => {
  const { absentWarningHtml } = api();
  const on = absentWarningHtml(4, 'T1', true);
  assert.ok(/onclick="openTeacherDetail\('ABSENT','T1'\)"/.test(on),
    'النقر يفتح تفاصيل الغياب');
  const off = absentWarningHtml(4, 'T1', false);
  assert.ok(!off.includes('onclick'), 'إن كُلم clickable:false فلا نقرة');
});

test('التنبيه معطّل قبل الحدّ لا يُبقى وسوماً زائدة', () => {
  const { absentWarningHtml } = api();
  const html = absentWarningHtml(3, 'T1', true);
  assert.strictEqual(html, '', 'سلسلة فارغة صريحة، لا وسوم فارغة');
});

test('التنبيه موصول بلوحة المعلم فقط لا بلوحة الإدارة', () => {
  /* الطلب للمعلم فلن يظهر كاسراً في لوحة متابعة المدير ومثبطاً له */
  const dash = sliceBetween(HTML, '${isTeacher ? (() => {', ')() : \'\'}\n  ${bottom}');
  assert.ok(dash.includes('absentWarningHtml(tst.absent, user.id, true)'),
    'موجود داخل كتلة isTeacher');
  const adminPage = sliceBetween(HTML, 'function renderTeacherPage(', 'function buildTeacherDetail');
  assert.ok(!adminPage.includes('absentWarningHtml'),
    'ليس في لوحة المتابعة — طلبك للمعلم نفسها');
});

test('وضع داخل بطاقة الالتزام بالدوام مباشرة تحت الرأس لا في آخرها', () => {
  const dash = sliceBetween(HTML, '${isTeacher ? (() => {', ')() : \'\'}\n  ${bottom}');
  const iWarn = dash.indexOf('absentWarningHtml(tst.absent');
  const iRing = dash.indexOf('conic-gradient');
  const iKpi  = dash.indexOf("kpiPill('❌','أيام الغياب'");
  assert.ok(iWarn > -1 && iRing > -1 && iKpi > -1, 'الثلاثة موجودة فعلاً');
  assert.ok(iWarn < iRing && iWarn < iKpi,
    'التنبيه أعلى الصفحة لا مطموراً في آخرها');
});

test('يحسب من عدّاد الغياب الحقيقي لا من قيمة مُفترضة', () => {
  const dash = sliceBetween(HTML, '${isTeacher ? (() => {', ')() : \'\'}\n  ${bottom}');
  assert.ok(dash.includes('const tst = teacherStats(teacherSelfRecord(d, user));'),
    'العدّاد يأتي من سجل قاعدة البيانات عبر teacherSelfRecord — وإلا رأيت الأصفار');
});

test('الملف سليم من حروف خارج العربية', () => {
  assert.ok(!/[\u0400-\u04FF\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(HTML),
    'لا سيريلية ولا صينية ولا يابانية ولا كورية');
  assert.ok(!HTML.includes('\uFFFD'), 'لا محرف تالف');
});
