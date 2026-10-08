'use strict';
// regression: مسارا الاستعادة (restore + import) يجب ألا يُرجعا ok:true إذا رُفضت الكتابة.
//
// السياق: بعد إضافة حارس monotonicity على setSchoolData
//   ON CONFLICT .. WHERE school_data.ts < EXCLUDED.ts
// كان المساران يمرّران ts = Date.now(). فإذا كان ts المخزَّن يتقدّم على ساعة
// الخادم (ساعة جهاز عميل متأخرة +5د عبر PUT) تُرفض الكتابة بصمت، ومع ذلك
// يُعاد ok:true — والاستعادة آخر خط إنقاذ، فالتقرير الكاذب خطير.
// الإصلاح: ts = max(Date.now(), prev.ts) + 1  +  فحص نتيجة الكتابة.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const SERVER_PATH = path.join(__dirname, '..', 'server.js');
const src = fs.readFileSync(SERVER_PATH, 'utf8');

const deep = (o) => JSON.parse(JSON.stringify(o));

/* ---------- محاكاة setSchoolData الحقيقية بحارس ts ---------- */
function makeStore(initialTs, data) {
  const row = { data: deep(data), ts: initialTs };
  return {
    row,
    setSchoolData(_school, d, ts) {
      const t = Number(ts) || 0;
      if (t <= row.ts) return { written: false, storedTs: t };
      row.data = deep(d);
      row.ts = t;
      return { written: true, storedTs: t };
    },
  };
}

const backupPayload = (nStudents) => ({
  users: [{ id: 'id_admin_seed', role: 'ADMIN' }],
  students: Array.from({ length: nStudents }, (_, i) => ({ id: 'r' + i })),
  classes: [{ id: 'kg_g0_a' }],
});

/* ---------- 1) المسار المستعاد: ts فوق المخزَّن حتى لو كانت الساعة متأخرة ---------- */
test('restore: ts = max(Date.now(), prev.ts)+1 يتجاوز ساعة متأخرة', () => {
  const storedTs = Date.now() + 5 * 60 * 1000;   // أسوأ حالة: عميل ساعةُه +5د
  const store = makeStore(storedTs, backupPayload(10));

  // ما كان يفعله الكود القديم:
  const oldTs = Date.now();
  const oldRes = store.setSchoolData('BOYS', backupPayload(200), oldTs);
  assert.equal(oldRes.written, false, 'السلوك القديم: كتابة مرفوضة بصمت');

  // ما يفعله الكود الجديد:
  const prevRow = { ts: store.row.ts };
  const ts = Math.max(Date.now(), (prevRow && prevRow.ts) || 0) + 1;
  const res = store.setSchoolData('BOYS', backupPayload(200), ts);

  assert.equal(res.written, true, 'الكود الجديد يُكتب فعلاً');
  assert.ok(ts > storedTs, 'ts يتقدّم على المخزَّن');
  assert.equal(store.row.data.students.length, 200, 'الاستعادة طُبِّقت');
});

/* ---------- 2) لا ok:true عند الرفض ---------- */
test('الكتابة المرفوضة تُبلَّغ بحالة خطأ لا بنجاح', () => {
  const store = makeStore(9_999_999_999, backupPayload(5));
  // محاكاة: لو مرّرنا ts أقدم من المخزَّن
  const w = store.setSchoolData('BOYS', backupPayload(50), 1000);
  assert.equal(w.written, false);

  // هذا ما يفعله المساران الآن:
  const status = w.written ? 200 : 409;
  const body = w.written
    ? { ok: true }
    : { error: 'write_rejected', reason: 'stale_ts', storedTs: store.row.ts };
  assert.equal(status, 409);
  assert.equal(body.ok, undefined, 'لا يوجد ok:true في رد الرفض');
  assert.equal(body.error, 'write_rejected');
  assert.equal(store.row.data.students.length, 5, 'البيانات لم تُمسّ');
});

/* ---------- 3) الكود المكتوب فعلاً في server.js ---------- */
test('كلا المسارين يحسبان ts من الصف المخزَّن لا من Date.now() وحدها', () => {
  const occurrences = src.match(/Math\.max\(Date\.now\(\),\s*\(prevRow\s*&&\s*prevRow\.ts\)\s*\|\|\s*0\)\s*\+\s*1/g) || [];
  assert.equal(occurrences.length, 2, 'مساران: restore + import');
});

test('كلا المسارين يقرآن السطر المخزَّن قبل الحساب', () => {
  assert.equal((src.match(/const prevRow = await db\.getSchoolData\(/g) || []).length, 2);
  const idx = [];
  let i = -1;
  while ((i = src.indexOf('const prevRow = await db.getSchoolData(', i + 1)) !== -1) idx.push(i);
  for (const at of idx) {
    const after = src.slice(at, at + 320);
    assert.ok(/Math\.max\(Date\.now\(\), \(prevRow && prevRow\.ts\) \|\| 0\) \+ 1/.test(after),
      'ts يُحسب مباشرة بعد القراءة');
  }
});

test('كل المسارات تفحص نتيجة setSchoolData وترفض 200 عند الرفض', () => {
  const checks = src.match(/if \(!w\.written\) \{/g) || [];
  assert.equal(checks.length, 2, 'فحصان بصيغة w: restore + import');
  // stale_ts الآن ثلاثة: restore + import + مسار PUT العادي (الذي كان يُرجع 200 كذبًا).
  assert.equal((src.match(/error: 'write_rejected', reason: 'stale_ts'/g) || []).length, 3);
  // write_rejected أربع مرات: الاثنان السابقان + concurrent_change + stale_ts في PUT.
  assert.equal((src.match(/status\(409\)\.json\(\{ error: 'write_rejected'/g) || []).length, 4);
  // لا مسار يستدعي setSchoolData ويتجاهل النتيجة
  const calls = src.match(/await db\.setSchoolData\(/g) || [];
  const assigned = src.match(/(?:const|let) (?:w|putRes) = await db\.setSchoolData\(/g) || [];
  // أربعة نداءات: PUT (أول محاولة) + PUT (إعادة المحاولة) + restore + import.
  // النداء الرابع داخل حلقة المحاولة فالنتيجةُ تُفحص بشرط الحلقة نفسه (while (!putRes.written)).
  assert.equal(calls.length, 4, 'أربعة نداءات');
  assert.equal(assigned.length, 3, 'ثلاثة منها إسناد مُفحص + إعادة المحاولة داخل الحلقة');
  assert.ok(src.includes('while (!putRes.written'), 'إعادة المحاولة نفسها مشروطة بفحص النتيجة');
});

test('حارس تفريغ القسم ما زال يعمل قبل أي كتابة', () => {
  // لا يجوز أن يُسقط الإصلاح حارس wipe_blocked
  assert.ok(/wipe_blocked', reason: 'restore_empty'/.test(src), 'restore_empty محفوظ');
  assert.ok(/wipe_blocked', reason: 'import_empty'/.test(src), 'import_empty محفوظ');
  const rGuard = src.indexOf("reason: 'restore_empty'");
  const rWrite = src.indexOf('if (!w.written) {', src.indexOf('/api/backups/import') - 4000);
  assert.ok(rGuard > 0 && rWrite > 0);
  const iGuard = src.indexOf("reason: 'import_empty'");
  const iWrite = src.lastIndexOf('if (!w.written) {');
  assert.ok(iGuard < iWrite, 'حارس import_empty يسبق فحص الكتابة');
});

test('إصلاح الاستعادة لم يمس حارس monotonicity ولا mutateSchoolData', () => {
  const dbSrc = fs.readFileSync(path.join(__dirname, '..', 'db.js'), 'utf8');
  assert.ok(/WHERE school_data\.ts < EXCLUDED\.ts/.test(dbSrc), 'حارس UPSERT قائم');
  assert.ok(/async function mutateSchoolData\(school, mutator\)/.test(dbSrc), 'mutateSchoolData قائم');
  assert.ok(/Math\.max\(Date\.now\(\), storedTs \+ 1\)/.test(dbSrc), 'ts رتيب في mutateSchoolData');
  // لا تحويل إلى mutateSchoolData في الاستعادة (الاستعادة استبدال كامل مقصود)
  assert.ok(!/mutateSchoolData\(bak\.school/.test(src), 'الاستعادة تبقى setSchoolData (استبدال كامل)');
});
