'use strict';
/* نبراس البنين — حراسة النظافة: لا بقايا قسم بنات في الشفرة المصدرية إطلاقاً.
 * يمنع عودة أي (GIRLS/بنات/طالبات/معلمات/وكيلة/موجهة/مشرفة/نجمة الأسبوع)
 * أو أي حساب/اسم حقيقي، أو أي مشاركة قاعدة بيانات أو تخزين محلي مع نظام البنات.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

function read(f) {
  return fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/\r\n/g, '\n');
}
function cnt(s, t) {
  let n = 0, i = 0;
  while ((i = s.indexOf(t, i)) !== -1) { n++; i += t.length; }
  return n;
}

const INDEX = read('public/index.html');
const DB = read('db.js');
const SERVER = read('server.js');
const SEED = read('seed.js');
const TOOLBAR = fs.readFileSync(path.join(ROOT, 'public', 'toolbar.js'), 'utf8');

const GIRLS_TERMS = [
  'GIRLS', 'girls', 'Girls', 'البنات', 'بنات', 'الطالبات', 'الطالبة',
  'المعلمات', 'المعلمة', 'الوكيلة', 'الموجهة', 'مشرفة', 'المديرة',
  'الشيماء سامي محمد العجمي', 'آمال عبدالرحيم', 'تهاني', 'خديجة',
];

test('لا أثر لقسم البنات في الواجهة (مصطلحات، رموز، أسماء) إطلاقاً', () => {
  for (const t of GIRLS_TERMS) assert.equal(cnt(INDEX, t), 0, 'index.html يحتوي: ' + t);
});

test('لا أثر لقسم البنات في الخادم/قاعدة البيانات/البذرة', () => {
  const all = DB + '\n' + SERVER + '\n' + SEED;
  for (const t of GIRLS_TERMS) assert.equal(cnt(all, t), 0, 'server/db/seed يحتوي: ' + t);
});

test('لا نجمة أسبوع في أي ملف', () => {
  for (const [f, s] of [['index.html', INDEX], ['toolbar.js', TOOLBAR], ['server.js', SERVER]]) {
    assert.equal(cnt(s, 'نجمة الأسبوع'), 0, f);
  }
});

test('قسم واحد فقط BOYS في قاعدة البيانات (لا GIRLS)', () => {
  assert.ok(/const SCHOOLS = \['BOYS'\];/.test(DB), 'SCHOOLS = [BOYS]');
  assert.ok(/CHECK \(school = 'BOYS'\)/.test(DB), 'قيود المخطط تقبل BOYS فقط');
  assert.ok(!/GIRLS/.test(DB), 'لا GIRLS في db.js إطلاقاً');
});

test('لا توجد حسابات جاهزة بأسماء حقيقية في الواجهة', () => {
  const defs = INDEX.slice(INDEX.indexOf('const defs = ['));
  assert.ok(/const defs = \[\]; \/\/ نبراس البنين/.test(defs), 'defs فارغة دون أسماء');
  assert.ok(!/name:\s*'[^']+'/.test(INDEX.slice(INDEX.indexOf('const defs = ['), INDEX.indexOf('const defs = [') + 200)),
    'لا اسم داخل defs');
});

test('لا مسارات /api/ops ولا حساب إداري مضمَّن في الخادم', () => {
  assert.ok(!/\/api\/ops/.test(SERVER), 'لا ops routes');
  assert.ok(!/ensure-girls-admin|clean-girls|ensure_boys/.test(SERVER), 'لا مسارات خاصة');
  assert.ok(!/password:\s*['"][^'"]{2,}['"]/.test(SERVER.replace(/process\.env\.[A-Z_]+/g, '""')),
    'لا كلمة مرور مضمَّنة في نص الخادم');
});

test('الوحيدة وعنوان الهوية: قالب ذكوري واسم مدرسة البنين', () => {
  assert.ok(/function getActiveSchool\(\)\{\s*return 'BOYS'; \}/.test(INDEX), 'BOYS نشط');
  assert.ok(/schoolNames\s*=\s*\{\s*BOYS:\s*'قسم البنين'/.test(INDEX), 'قسم البنين');
  assert.ok(INDEX.includes('نبراس البنين'), 'العنوان نبراس البنين');
  assert.ok(!/feminineLabels/.test(INDEX), 'لا جدول تأنيث');
  assert.ok(!/theme-girls|isGirls|badge-girls/.test(INDEX), 'لا أسماء بناتية في الواجهة');
});

test('استقلالية التخزين المحلي: مفتاح nibras_boys_db_v1 فقط', () => {
  assert.ok(/nibras_boys_db_v1/.test(INDEX), 'المفتاح المحلي لنساء البنين');
  assert.ok(!/nibras_GIRLS|nibras_BOYS/.test(INDEX), 'لا مفتاح بنات ولا مفتاح بأحرف كبيرة');
  assert.ok(!/nibir|att_cancel|GIRLS\.json/.test(INDEX), 'لا أثر لمفتاح/ملف النظام القديم');
});

test('لا Service Worker: التحديثات تصل مباشرة ولا كاش قديم', () => {
  assert.ok(!fs.existsSync(path.join(ROOT, 'public', 'sw.js')), 'sw.js محذوف');
  assert.ok(!/serviceWorker\.register/.test(INDEX), 'لا تسجيل حارس');
  assert.ok(!/sw\.js\?v=/.test(INDEX), 'لا إشارة لحارس قديم');
});

test('نقاط العرض تبدأ من تاريخ التشغيل بلا قيمة بناتية', () => {
  assert.ok(/POINTS_START_FROM\s*=\s*''/.test(INDEX), 'لا نقطة بدء مأخوذة من تاريخ البنات');
});

test('البذرة: مسؤول نبراس البنين بالبريد الخاص به', () => {
  assert.ok(/admin@nibrasboys\.local/.test(SEED + SERVER), 'بريد المسؤول الخاص بالبنين');
  assert.ok(!/nasser8@gmail\.com/.test(SERVER), 'لا بريد البنات في الخادم');
});