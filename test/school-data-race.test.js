'use strict';
// regression: منع الكتابة القديمة (stale write) على صف school_data
//
// العطل المُبلَّغ: PUT يرسل 172 طالباً، الخادم يكتب 172 بنجاح ويرجع 200،
// ثم GET فوري يعيد 162. السبب: updateSchoolUser / markSchoolUsersActivated /
// appendSchoolUser كانت تقرأ الصف كاملاً (getSchoolData) ثم تعيد كتابة الصف
// كاملاً (setSchoolData) بلقطة قديمة — فيُمحى أي حفظ أحدث تم بينهما.
// هنا نختبر: (أ) النمط الجديد على الصف المقفول يبقي الأحدث، (ب) حارس ts يمنع
// حتى النمط القديم من الكتابة فوق الأحدث.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const PG_PATH = require.resolve('pg');
const DB_PATH = path.join(__dirname, '..', 'db.js');
const SERVER_PATH = path.join(__dirname, '..', 'server.js');

const deep = (o) => JSON.parse(JSON.stringify(o));

/* ---------- واجهة مزيفة faithful لـ Postgres لما نستخدمه من SQL ---------- */
function makeFakePg() {
  const tables = { school_data: new Map() }; // school -> { data, ts }
  const locks = new Map();                  // school -> mutex
  const log = [];

  function acquire(school) {
    const prev = locks.get(school) || Promise.resolve();
    let release;
    const gate = new Promise((r) => { release = r; });
    locks.set(school, prev.then(() => gate));
    return prev.then(() => release);
  }

  function makeClient() {
    let release = null;
    const c = {
      inTx: false,
      async query(sql, params) {
        const s = String(sql);
        log.push(s);
        if (/^\s*BEGIN/i.test(s)) { c.inTx = true; return { rowCount: 0, rows: [] }; }
        if (/^\s*(COMMIT|ROLLBACK)/i.test(s)) {
          c.inTx = false;
          if (release) { release(); release = null; }
          return { rowCount: 0, rows: [] };
        }
        // SELECT data, ts FROM school_data WHERE school = $1 FOR UPDATE
        if (/SELECT/.test(s) && /FOR UPDATE/i.test(s)) {
          release = await acquire(params[0]);
          const row = tables.school_data.get(params[0]);
          if (!row) return { rowCount: 0, rows: [] };
          // نسخة منفصلة تماماً كما يفعل JSONB عند التحويل
          return { rowCount: 1, rows: [{ data: deep(row.data), ts: String(row.ts) }] };
        }
        // SELECT data, ts FROM school_data WHERE school = $1   (بلا قفل — قراءة عادية)
        if (/SELECT/.test(s) && /FROM school_data/i.test(s)) {
          const row = tables.school_data.get(params[0]);
          if (!row) return { rowCount: 0, rows: [] };
          return { rowCount: 1, rows: [{ data: deep(row.data), ts: String(row.ts) }] };
        }
        // UPDATE school_data SET data=$2::jsonb, ts=$3 ... WHERE school=$1 AND ts < $3
        if (/^\s*UPDATE school_data/i.test(s)) {
          const [school, dataJson, nextTs] = params;
          const row = tables.school_data.get(school);
          if (!row) return { rowCount: 0, rows: [] };
          if (!(row.ts < Number(nextTs))) return { rowCount: 0, rows: [] };
          row.data = JSON.parse(dataJson);
          row.ts = Number(nextTs);
          return { rowCount: 1, rows: [] };
        }
        // INSERT ... ON CONFLICT (school) DO UPDATE ... WHERE school_data.ts < EXCLUDED.ts
        if (/INSERT INTO school_data/i.test(s)) {
          const [school, dataJson, nextTs] = params;
          const ts = Number(nextTs);
          const row = tables.school_data.get(school);
          if (!row) { tables.school_data.set(school, { data: JSON.parse(dataJson), ts }); return { rowCount: 1, rows: [] }; }
          if (row.ts < ts) { row.data = JSON.parse(dataJson); row.ts = ts; return { rowCount: 1, rows: [] }; }
          return { rowCount: 0, rows: [] }; // WHERE المرفوض => rowCount 0 (لا استبدال)
        }
        return { rowCount: 0, rows: [] };
      },
      release() { if (release) { release(); release = null; } },
    };
    return c;
  }

  const pool = {
    async query(sql, params) { return makeClient().query(sql, params); },
    async connect() { return makeClient(); },
  };
  return { pool, tables, log };
}

function newDb() {
  const fake = makeFakePg();
  const savedPg = require.cache[PG_PATH];
  require.cache[PG_PATH] = {
    id: PG_PATH, filename: PG_PATH, loaded: true,
    exports: { Pool: class { constructor() { return fake.pool; } } },
  };
  delete require.cache[require.resolve(DB_PATH)];
  let db;
  try { db = require(DB_PATH); } finally {
    if (savedPg) require.cache[PG_PATH] = savedPg; else delete require.cache[PG_PATH];
  }
  const seed = (school, data, ts) => { fake.tables.school_data.set(school, { data: deep(data), ts }); };
  const readRow = (school) => fake.tables.school_data.get(school);
  return { db, fake, seed, readRow };
}

const mkStudents = (n, gradeId) => Array.from({ length: n }, (_, i) => ({
  id: 's' + (i + 1), name: 'طالب ' + (i + 1), classId: 'kg_g0_a', gradeId: gradeId || 'g0', active: true,
}));
const mkData = (nStudents, ts) => ({
  _ts: ts || 0, users: [{ id: 'id_admin_seed', username: 'admin', role: 'ADMIN', firstLogin: true, granted: true }],
  grades: [{ id: 'g0', name: 'أولى' }], classes: [{ id: 'kg_g0_a', name: 'أولى', gradeId: 'g0' }],
  students: mkStudents(nStudents), attendance: [], notes: [],
});

/* ---------- 1) سيناريو العطل المُبلَّغ ---------- */
test('السباق: لقطة 162 ثم حفظ 172 ثم تحديث مستخدم متزامن => تبقى 172', async () => {
  const { db, seed, readRow } = newDb();
  seed('BOYS', mkData(162, 1000), 1000);

  // لقطة قديمة كما كانت db.getSchoolData تعيدها قبل أي تعديل
  const snapshotA = deep((await db.getSchoolData('BOYS')).data);
  assert.equal(snapshotA.students.length, 162, 'اللقطة أ تحتوي 162');

  // PUT أحدث يكتب 172 (nextTs = prev.ts + 1)
  const newer = deep(snapshotA);
  newer.students = mkStudents(172);
  newer._ts = 1001;
  const putRes = await db.setSchoolData('BOYS', newer, 1001);
  assert.equal(putRes.written, true, 'حفظ 172 يجب أن يُقبل');

  // تحديث مستخدم "متزامن" — كُتب مرة على الصف المقفول لا على لقطة قديمة
  const upd = await db.mutateSchoolData('BOYS', (d) => {
    const u = d.users.find((x) => x.id === 'id_admin_seed');
    u.firstLogin = false;
    return { changed: true, value: true };
  });
  assert.equal(upd.written, true);

  const row = readRow('BOYS');
  assert.equal(row.data.students.length, 172, 'يجب أن تبقى 172 ولا تُمحى بلقطة 162');
  assert.equal(row.data.users.find((u) => u.id === 'id_admin_seed').firstLogin, false,
    'وتعديل المستخدم المطلوب طبِّق');
  assert.ok(row.ts > 1001, 'و ts تقدّم (رتيب)');
});

/* ---------- 2) حارس stale على setSchoolData ---------- */
test('setSchoolData: كتابة ts أقدم تُرفض ولا تمسح الأحدث', async () => {
  const { db, seed, readRow } = newDb();
  seed('BOYS', mkData(162, 1000), 1000);
  const snapshotA = deep((await db.getSchoolData('BOYS')).data);

  const newer = deep(snapshotA); newer.students = mkStudents(172); newer._ts = 1001;
  assert.equal((await db.setSchoolData('BOYS', newer, 1001)).written, true);

  // النمط القديم تماماً: لقطة 162 + Date.now() الذي فُرض أن يكون أحدث... لا: نفس 1000
  const staleRes = await db.setSchoolData('BOYS', snapshotA, 1000);
  assert.equal(staleRes.written, false, 'اللقطة الأقدم تُرفض');
  assert.equal(readRow('BOYS').data.students.length, 172, 'الأحدث سليمة');
  assert.equal(readRow('BOYS').ts, 1001, 'ts لم يتراجع');
});

test('setSchoolData: كتابة بطول 162 و ts أقدم لا تُعيد 162 أبداً', async () => {
  const { db, seed, readRow } = newDb();
  seed('BOYS', mkData(172, 5000), 5000);
  const res = await db.setSchoolData('BOYS', mkData(162, 4999), 4999);
  assert.equal(res.written, false);
  assert.equal(readRow('BOYS').data.students.length, 172);
  assert.equal(readRow('BOYS').ts, 5000);
});

test('setSchoolData: حارس ts موجود فعلاً في SQL', () => {
  const src = fs.readFileSync(DB_PATH, 'utf8');
  const fn = src.slice(src.indexOf('async function setSchoolData'), src.indexOf('async function mutateSchoolData'));
  assert.ok(/ON CONFLICT \(school\) DO UPDATE SET/.test(fn), 'UPSERT موجود');
  assert.ok(/WHERE school_data\.ts < EXCLUDED\.ts/.test(fn), 'وحد حارس ts على UPSERT');
});

/* ---------- 3) رتابة ts في mutateSchoolData ---------- */
test('mutateSchoolData: ts لا يتراجع حتى لو كانت ساعة الحائط متأخرة', async () => {
  const { db, seed, readRow } = newDb();
  seed('BOYS', mkData(172, 900000), 900000);
  const realNow = Date.now;
  Date.now = () => 5; // ساعة الحائط انفجرت للخلف
  try {
    const r = await db.mutateSchoolData('BOYS', (d) => { d.students[0].name = 'معدّلة'; return { changed: true, value: true }; });
    assert.equal(r.written, true);
  } finally { Date.now = realNow; }
  assert.equal(readRow('BOYS').ts, 900001, 'ts = storedTs + 1 لا Date.now()');
  assert.equal(readRow('BOYS').data.students[0].name, 'معدّلة');
  assert.equal(readRow('BOYS').data.students.length, 172, 'الطلاب لم يتأثروا');
});

test('mutateSchoolData: يستخدم BEGIN + SELECT..FOR UPDATE + COMMIT', async () => {
  const { db, fake, seed } = newDb();
  seed('BOYS', mkData(172, 10), 10);
  await db.mutateSchoolData('BOYS', () => ({ changed: true, value: 1 }));
  const s = fake.log.join('\n');
  assert.ok(/BEGIN/i.test(s), 'معاملة');
  assert.ok(/SELECT[\s\S]*FOR UPDATE/i.test(s), 'قفل صف');
  assert.ok(/COMMIT/i.test(s), 'إغلاق المعاملة');
  assert.ok(!/ROLLBACK/i.test(s), 'لا تراجع عند النجاح');
});

test('mutateSchoolData: قفل الصف يمنع تداخل معاملتين على نفس القسم', async () => {
  const { db, seed, readRow } = newDb();
  seed('BOYS', mkData(172, 100), 100);
  const seen = [];
  const a = db.mutateSchoolData('BOYS', (d) => {
    seen.push(d.students.length);
    return new Promise((r) => setTimeout(() => r({ changed: true, value: 'A' }), 20));
  });
  const b = db.mutateSchoolData('BOYS', (d) => { seen.push(d.students.length); return { changed: true, value: 'B' }; });
  await Promise.all([a, b]);
  // الثانية تنتظر الأولى (FOR UPDATE) فلا تقرأ لقطة متزامنة
  assert.deepEqual(seen, [172, 172]);
  assert.ok(readRow('BOYS').ts > 100, 'each transaction advances ts');
});

test('mutateSchoolData: لا-change لا يكتب شيئاً', async () => {
  const { db, seed, readRow } = newDb();
  seed('BOYS', mkData(172, 100), 100);
  const r = await db.mutateSchoolData('BOYS', () => ({ changed: false, value: 0 }));
  assert.equal(r.written, false);
  assert.equal(r.reason, 'no_change');
  assert.equal(readRow('BOYS').ts, 100, 'ts لم يتغير');
});

test('mutateSchoolData: ينشئ الصف إن لم يكن موجوداً (سلوك appendSchoolUser الأصلي)', async () => {
  const { db, readRow } = newDb();
  const r = await db.mutateSchoolData('BOYS', (d) => { d.users.push({ id: 'u1' }); return { changed: true, value: true }; });
  assert.equal(r.written, true);
  assert.equal(readRow('BOYS').data.users[0].id, 'u1');
});

test('mutateSchoolData: يدعم mutator غير متزامن (async) — يحتاجه منطق تنظيف الصفوف المعقّد', async () => {
  const { db, seed, readRow } = newDb();
  seed('BOYS', mkData(172, 700), 700);
  const r = await db.mutateSchoolData('BOYS', async (d) => {
    await new Promise((res) => setTimeout(res, 5));
    d.classes = d.classes.filter((c) => !c.deleted);   // شبيه بمنطق تنظيف الصفوف يدوياً
    return { changed: true, value: { kept: d.classes.length } };
  });
  assert.equal(r.written, true, 'لم يُهمَل كـ Promise');
  assert.equal(r.value.kept, 1);
  assert.equal(readRow('BOYS').data.students.length, 172, 'الطلاب سليمو');
  assert.ok(readRow('BOYS').ts > 700);
});

test('mutateSchoolData: async mutator بلا تغيير لا يكتب', async () => {
  const { db, seed, readRow } = newDb();
  seed('BOYS', mkData(172, 700), 700);
  const r = await db.mutateSchoolData('BOYS', async () => {
    await new Promise((res) => setTimeout(res, 1));
    return { changed: false, value: 0 };
  });
  assert.equal(r.written, false);
  assert.equal(readRow('BOYS').ts, 700);
});

/* ---------- 4) الدوال الثلاث في server.js على db حقيقي ---------- */
function extractFn(src, name) {
  const i = src.indexOf('async function ' + name + '(');
  assert.ok(i >= 0, 'موجود: ' + name);
  const start = src.indexOf('{', i);
  let depth = 0;
  for (let k = start; k < src.length; k++) {
    if (src[k] === '{') depth++;
    else if (src[k] === '}') { depth--; if (depth === 0) return src.slice(i, k + 1); }
  }
  throw new Error('أقواس غير متوازنة: ' + name);
}
function loadServerHelpers(db) {
  const src = fs.readFileSync(SERVER_PATH, 'utf8');
  const body = ['updateSchoolUser', 'markSchoolUsersActivated', 'appendSchoolUser']
    .map((n) => extractFn(src, n)).join('\n');
  const factory = new Function('db', 'STRIP_FIELDS', 'console',
    body + '\nreturn { updateSchoolUser, markSchoolUsersActivated, appendSchoolUser };');
  return factory(db, [], { warn() {}, error() {}, log() {} });
}

test('updateSchoolUser: يطبّق التعديل ولا يمحو 172 (بدل لقطة 162)', async () => {
  const { db, seed, readRow } = newDb();
  seed('BOYS', mkData(172, 2000), 2000);
  const h = loadServerHelpers(db);
  const ok = await h.updateSchoolUser('BOYS', 'id_admin_seed', { firstLogin: false, email: 'x@y.z' });
  assert.equal(ok, true);
  const row = readRow('BOYS');
  assert.equal(row.data.students.length, 172, 'الطلاب سليمو');
  const u = row.data.users.find((x) => x.id === 'id_admin_seed');
  assert.equal(u.firstLogin, false);
  assert.equal(u.email, 'x@y.z');
  assert.ok(row.ts > 2000);
});

test('updateSchoolUser: لا يكتب شيئاً لمستخدم غير موجود', async () => {
  const { db, seed, readRow } = newDb();
  seed('BOYS', mkData(172, 2000), 2000);
  const h = loadServerHelpers(db);
  assert.equal(await h.updateSchoolUser('BOYS', 'ghost', { firstLogin: false }), false);
  assert.equal(readRow('BOYS').ts, 2000, 'ts ثابت');
  assert.equal(readRow('BOYS').data.students.length, 172);
});

test('markSchoolUsersActivated: يرجع العدد (عقد الاستدعاء عند 928) ويطبّق بلا فقد طلاب', async () => {
  const { db, seed, readRow } = newDb();
  seed('BOYS', mkData(172, 3000), 3000);
  const h = loadServerHelpers(db);
  const n = await h.markSchoolUsersActivated('BOYS', 'id_admin_seed', null);
  assert.equal(n, 1, 'عدّاد التطابقات يعمل');
  assert.equal(readRow('BOYS').data.students.length, 172);
  assert.equal(readRow('BOYS').data.users[0].firstLogin, false);
  assert.equal(readRow('BOYS').data.users[0].granted, true);
  assert.ok(readRow('BOYS').ts > 3000);
});

test('markSchoolUsersActivated: لامطابقة = 0 ولا كتابة', async () => {
  const { db, seed, readRow } = newDb();
  seed('BOYS', mkData(172, 3000), 3000);
  const h = loadServerHelpers(db);
  assert.equal(await h.markSchoolUsersActivated('BOYS', null, 'لا_يوجد'), 0);
  assert.equal(readRow('BOYS').ts, 3000);
});

test('appendSchoolUser: يضيف المستخدم ويبقي 172', async () => {
  const { db, seed, readRow } = newDb();
  seed('BOYS', mkData(172, 4000), 4000);
  const h = loadServerHelpers(db);
  assert.equal(await h.appendSchoolUser('BOYS', { id: 'u2', name: 'جديد' }), true);
  const row = readRow('BOYS');
  assert.equal(row.data.users.length, 2);
  assert.equal(row.data.students.length, 172, 'الطلاب سليمو');
  assert.ok(row.ts > 4000);
});

test('appendSchoolUser: يستبدل المكرر بالمعرّف نفسه بلا تكرار', async () => {
  const { db, seed, readRow } = newDb();
  seed('BOYS', mkData(172, 4000), 4000);
  const h = loadServerHelpers(db);
  await h.appendSchoolUser('BOYS', { id: 'id_admin_seed', name: 'محدث' });
  const row = readRow('BOYS');
  assert.equal(row.data.users.length, 1);
  assert.equal(row.data.users[0].name, 'محدث');
});

/* ---------- 5) تغطية المسارات ---------- */
test('لا يبقى نمط لقطة-قديمة-كاملة في server.js', () => {
  const src = fs.readFileSync(SERVER_PATH, 'utf8');
  // النمط المكسور: قراءة ثم إعادة كتابة نفس الكائن المأخوذ من getSchoolData
  assert.ok(!/setSchoolData\(\s*school\s*,\s*rec\.data\s*,/.test(src),
    'لا setSchoolData(school, rec.data, ...) — النمط الذي سبّب الضياع');
  assert.ok(!/setSchoolData\(\s*school\s*,\s*d\s*,\s*Date\.now\(\)/.test(src),
    'لا setSchoolData بـ Date.now() بعد قراءة سابقة');
  assert.ok(!/setSchoolData\(\s*'BOYS'\s*,\s*d\s*,\s*Date\.now\(\)/.test(src),
    'لا setSchoolData بلا معاملة');
});

test('كل الكتابات لتعديل المستخدمين تمر بالمعاملة', () => {
  const src = fs.readFileSync(SERVER_PATH, 'utf8');
  assert.ok(src.includes('db.mutateSchoolData'), 'mutateSchoolData مستخدم');
  // Coimbra لا تحذف تعديلات على الصف المقفول
  for (const n of ['updateSchoolUser', 'markSchoolUsersActivated', 'appendSchoolUser']) {
    const body = extractFn(src, n);
    assert.ok(/db\.mutateSchoolData/.test(body), n + ' يستخدم mutateSchoolData');
    assert.ok(!/db\.getSchoolData/.test(body), n + ' لا يقرأ بلا قفل');
    assert.ok(!/db\.setSchoolData/.test(body), n + ' لا يعيد كتابة الصف كاملاً');
  }
});

test('mutateSchoolData مُصدَّر من db.js', () => {
  const src = fs.readFileSync(DB_PATH, 'utf8');
  assert.ok(/getSchoolData,\s*setSchoolData,\s*mutateSchoolData,/.test(src), 'مُصدَّر');
});
