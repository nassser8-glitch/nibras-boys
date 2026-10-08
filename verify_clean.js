'use strict';
/* نبراس البنين — فحص ما قبل النشر: ألا توجد أي بقايا من قسم البنات/بياناتهن.
 * المخرجات على هيئة سطور إنجليزية موجزة كما طُلب في خطة القبول،
 * والخروج بلا صفر (exit 0) فقط إذا كان مجموع البقايا صفراً تماماً.
 */
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;

/* الملفات المنشورة فعلاً — الاختبارات/أدوات الفحص نفسها ليست «بيانات بنات» ولا تُحصى */
const SHIP = ['server.js', 'db.js', 'seed.js', 'package.json', 'README.txt', 'README.md', 'Dockerfile', '.env.example', 'maintenance.html', 'notes-privacy.js', 'transfers-privacy.js'];
function shippingFiles() {
  const out = [];
  const pub = path.join(ROOT, 'public');
  for (const e of fs.readdirSync(pub)) {
    if (/\.(js|html|css|json|txt)$/i.test(e.name)) out.push(path.join(pub, e.name));
  }
  for (const n of SHIP) {
    const p = path.join(ROOT, n);
    if (fs.existsSync(p)) out.push(p);
  }
  return out;
}

function count(files, tokens) {
  let n = 0;
  for (const f of files) {
    const s = fs.readFileSync(f, 'utf8');
    for (const t of tokens) {
      let i = 0;
      while ((i = s.indexOf(t, i)) !== -1) { n++; i += t.length; }
    }
  }
  return n;
}

const files = shippingFiles();

const GIRLS_TOKENS = [
  'GIRLS', 'girls', 'Girls', 'البنات', 'بنات', 'الطالبات', 'الطالبة',
  'المعلمات', 'المعلمة', 'الوكيلة', 'الموجهة', 'مشرفة', 'المديرة',
  'الشيماء سامي محمد العجمي', 'آمال عبدالرحيم', 'تهاني', 'خديجة',
];
const STUDENTS = ['الطالبات', 'الطالبة'];
const TEACHERS = ['المعلمات', 'المعلمة'];
const STAFF = ['الوكيلة', 'الموجهة', 'مشرفة', 'المديرة'];
const ATTENDANCE = ['غياب الطالبات', 'تأخر الطالبات', 'حضور الطالبات', 'حضور البنات', 'تأخر البنات', 'غياب البنات'];
const NOTES = ['الطالبات', 'الطالبة'];
const TRANSFERS = ['تحويل الطالبات', 'تحويل بنات', 'تحويلات الطالبات'];
const POINTS = ['نقاط الطالبات', 'نقاط البنات'];
const STAR = ['نجمة الأسبوع'];

const counts = {
  girlsTotal: count(files, GIRLS_TOKENS),
  students: count(files, STUDENTS),
  teachers: count(files, TEACHERS),
  staff: count(files, STAFF),
  attendance: count(files, ATTENDANCE),
  notes: count(files, NOTES),
  transfers: count(files, TRANSFERS),
  points: count(files, POINTS),
  star: count(files, STAR),
};

// استقلالية قاعدة البيانات/التخزين المحلي
const dbSrc = fs.readFileSync(path.join(ROOT, 'db.js'), 'utf8');
const idx = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const sharedDB = !/const SCHOOLS = \['BOYS'\]/.test(dbSrc) || /GIRLS/.test(dbSrc) || !/CHECK \(school = 'BOYS'\)/.test(dbSrc);
const sharedLS = !/nibras_boys_db_v1/.test(idx) || /nibras_GIRLS|nibras_BOYS_db_v1/.test(idx);

function pad(name, v) {
  console.log(name + ': ' + v);
}

pad('Girls data found', counts.girlsTotal);
pad('Girls students', counts.students);
pad('Girls teachers', counts.teachers);
pad('Girls staff', counts.staff);
pad('Girls attendance records', counts.attendance);
pad('Girls notes', counts.notes);
pad('Girls transfers', counts.transfers);
pad('Girls points', counts.points);
pad('Star of the Week feature', counts.star);
if (sharedDB) console.log('Shared database with girls: YES  <-- غير مقبول');
else console.log('Shared database with girls: NO');
if (sharedLS) console.log('Shared localStorage:         YES  <-- غير مقبول');
else console.log('Shared localStorage:         NO');

const fail = counts.girlsTotal > 0 || counts.star > 0 || sharedDB || sharedLS;
if (fail) {
  console.log('\nVERDICT: FAIL — توجد بقايا قسم البنات.');
  process.exit(1);
}
console.log('\nVERDICT: PASS — نظام نبراس البنين نظيف تماماً من بيانات قسم البنات.');