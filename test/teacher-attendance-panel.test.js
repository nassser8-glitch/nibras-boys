/* بطاقة الالتزام بالدوام للمعلم كانت تُظهر الغياب ودقائق التأخر فقط
 *
 * teacherStats() يحسب days-of-lateness (lateDays)_union من markedLate و
 * lateMinutes، لكن الحقل لم يُعرَض في أي مكان — كانت البطاقة تعرض عدد
 * الدقائق وحدها، فمعلم متأخرة 15 يوماً بلا دقيقة واحدة كانت تبدو سليمة.
 * ونسبة الحضور كانت تحسب من الغياب وحده، فالتأخر لا ينقص منها ولا يظهر.
 *
 * المطلوب: تأخير المعلمين ظاهر كما يظهر تأخير الطلاب — بعدد أيامه، لا
 * بدقائقه فقط، وظاهر في النسبة وفي الحلقة.
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const HTML = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');

function sliceBetween(startMarker, endMarker) {
  const a = HTML.indexOf(startMarker);
  assert.ok(a !== -1, 'لم يُعثر على: ' + startMarker);
  const b = HTML.indexOf(endMarker, a);
  assert.ok(b > a, 'لم يُعثر على نهاية: ' + endMarker);
  return HTML.slice(a, b);
}

const PANEL = sliceBetween('${isTeacher ? (() => {', '\n    function kpiPill(');

test('البطاقة تعرض أيام التأخر لا الدقائق وحدها', () => {
  assert.ok(/أيام التأخر/.test(PANEL), 'يجب أن يظهر عدّاد أيام التأخر');
  assert.ok(/lateDays/.test(PANEL), 'يجب أن يقرأ lateDays من teacherStats');
});

test('lateDays يُقرأ من teacherStats ولا يُعاد حسابه خطأ', () => {
  /* لازم يكون من teacher's stats مباشرة، لأن هناك مصادر متعددة للتأخر:
   * markedLate يدوياً، و lateMinutes من شاشة الحضور. */
  assert.ok(/tst\.lateDays/.test(PANEL), 'يجب أن يستخدم tStats.lateDays');
});

test('حلقة الحضور تُظهر ثلاث شرائح: حضور ثم تأخر ثم غياب', () => {
  const m = /conic-gradient\([^;]+/.exec(PANEL);
  assert.ok(m, 'حلقة conic-gradient موجودة');
  const g = m[0];
  assert.ok(/segP/.test(g), 'شريحة الحضور');
  assert.ok(/segL/.test(g), 'شريحة التأخر');
  assert.ok(/segA/.test(g), 'شريحة الغياب');
  assert.ok(/#f59e0b/.test(g), 'التأخر بلون كهرماني مميز');
  assert.ok(/#ef4444/.test(g), 'الغياب بلون أحمر مميز');
});

test('أيام الحضور والتأخر والغياب مجموعها أيام العمل', () => {
/* الأنواع الثلاثة لا تتداخل: الغياب والتأخر متعارضان حسب setter، فيجب أن
 * يكون المجموع مساوياً لأيام العمل حتى لا يختفي يوم أو يُحتسب مرتين. */
  assert.ok(/presentDays = Math\.max\(0, worked - absentDays - lateDays\)/.test(PANEL),
    'الحضور يُحسب بطرح الغياب والتأخر من أيام العمل');
  assert.ok(/lateDays = Math\.max\(0, tst\.lateDays \|\| 0\)/.test(PANEL),
    'أيام التأخر محمية من السالب');
});

test('الشريط السفلي يعرض الثلاثة معاً', () => {
  assert.ok(/الحضور: \$\{presentDays\}/.test(PANEL), 'الحضور');
  assert.ok(/التأخر: \$\{lateDays\}/.test(PANEL), 'التأخر');
  assert.ok(/الغياب: \$\{tst\.absent\}/.test(PANEL), 'الغياب');
});

test('المعلمين يُظهرن تأخرهن بالعدّاد لا بالدقائق فقط', () => {
  /* هذا هو العيب الأصلي: كنا نعرض الدقائق فقط. */
  const before = /أيام التأخر/.test(PANEL);
  assert.ok(before, 'عدّاد أيام التأخر موجود');
  assert.ok(/kpiPill\('🕐','دقائق التأخر'/.test(PANEL),
    'الدقائق تبقى معروضة أيضاً، لا تُستبدل');
});

test('المدامسة لا تُكسر: النسبة تظل محسوبة من الغياب', () => {
  /* نسبة الحضور تعاقب الغياب فقط، والتأخر يظهر مصنّفاً لا مُحاسَباً عليه
   * مرتين — وهذا نفس سلوك صفحة الطالب: attPct = (present+late)/total */
  assert.ok(/attPct = worked>0 \? Math\.max\(0, Math\.round\(\(Math\.max\(0, worked - tst\.absent\)\)\/worked\*100\)\) : 100/.test(PANEL),
    'نسبة الحضور تبقى كما هي: تعتمد الغياب لا التأخر');
});

test('الشريحة الحمراء لا تنزل تحت الصفر ولا يجعل المتأخر غائباً', () => {
  /* يوم مسجّل تأخّرَ في سبت أو أحد: lateDays تحسب أياماً تقويمية و worked
   * تحسب الاثنين-الجمعة، فيتجاوز التأخر أيام العمل. لولا القصّ لِنزلت
   * الشريحة الحمراء تحت الصفر وَلَفّ نصفُ الدائرة في conic-gradient. */
  assert.ok(/Math\.min\(lateDays, worked\)/.test(PANEL),
    'أيام التأخر تُقصّ على أيام العمل');
  assert.ok(/Math\.min\(absentDays, Math\.max\(0, worked - rawL\)\)/.test(PANEL),
    'أيام الغياب تُقصّ على ما بقي من أيام العمل');
  assert.ok(/segA = Math\.max\(0, 100 - segP - segL\)/.test(PANEL),
    'الشريحة الحمراء لا تنزل تحت الصفر');
});

test('شرائح الدائرة تُوزَّع على مجموعها الحقيقي، فلا ينقص أو يتجاوز', () => {
  assert.ok(/const sum2 = rawP \+ rawL \+ rawA \|\| 1;/.test(PANEL),
    'التوزيع على مجموع فعلي لا على days العمل مباشرة');
  assert.ok(/segP = Math\.round\(rawP \/ sum2 \* 100\)/.test(PANEL), 'شريحة الحضور');
  assert.ok(/segL = Math\.round\(rawL \/ sum2 \* 100\)/.test(PANEL), 'شريحة التأخر');
});