'use strict';
// regression: مسار PUT العادي (حفظ المدير) كان يُرجع 200 ok:true حتى حين يرفضه
// حارسُ ts، فيصدّق العميل أن حفظه نجح ثم يفقد تعديلاته بصمت.
//
// السبب: اللوحة الواحدة ترفع نفسها كل ~700ms عبر __syncSchedule، فيرتفع ts المخزَّن
// بمقدار 1 في كل مرة. الحفظ الشرعي يقرأ prev ثم يكتب nextTs = prev.ts + 1؛ فإن وصل
// رفعٌ تلقائي بين القراءة والكتابة صار المخزَّن prev.ts + 1 فلم يسبقه nextTs، فرُفضت
// الكتابة… وأُعيد 200. والدليل من الإنتاج: PUT يعيد 200 ثم GET يعيد 162 لا 172.
//
// الإصلاح المطبَّق في server.js:
//   1) db.setSchoolData يُرجع الـts المخزَّن فعلاً عند الرفض (لا المُدخَل).
//   2) حلقة إعادة محاولة: إعادة قراءة + nextTs = max(saneTs, storedTs) + 1.
//   3) عند تعذّر الكتابة ⇒ 409 write_rejected (العميل يعيد المحاولة) لا 200.
//   4) إن وصل تغيير بنيوي (طلاب) من جهاز آخر ⇒ 409 concurrent_change لا طمس.
//   5) نافذة «القديمة» صارت تعتمد baseTs المُعلن من العميل بدل 5 دقائق.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const SERVER_PATH = path.join(__dirname, '..', 'server.js');
const src = fs.readFileSync(SERVER_PATH, 'utf8');
const deep = (o) => JSON.parse(JSON.stringify(o));

/* ---------- محاكاة مخزن بحارس ts + إعادة القراءة كما في db.js ---------- */
function makeStore(initialTs, data) {
  const row = { data: deep(data), ts: initialTs };
  return {
    row,
    getSchoolData() { return { data: deep(row.data), ts: row.ts }; },
    setSchoolData(_school, d, ts) {
      const t = Number(ts) || 0;
      if (t <= row.ts) {
        // الإصلاح (1): نعيد المخزَّن فعلاً، لا المحلول
        return { written: false, storedTs: row.ts };
      }
      row.data = deep(d);
      row.ts = t;
      return { written: true, storedTs: t };
    },
  };
}

const students = (n, tag) =>
  Array.from({ length: n }, (_, i) => ({ id: 's' + i, name: (tag || 'x') + i }));

/* ---------- محاكاة كتلة الكتابة الجديدة من server.js ---------- */
function putWithRetry(store, prev, clean, bodyTs, { saneCap = Infinity } = {}) {
  const saneTs = Math.min(bodyTs, saneCap);
  let nextTs = Math.max(saneTs, (prev && prev.ts) || 0) + 1;
  clean._ts = nextTs;
  let putRes = store.setSchoolData('BOYS', clean, nextTs);
  let putAttempts = 0;
  while (!putRes.written && putAttempts < 3) {
    putAttempts++;
    const cur = store.getSchoolData();
    const curTs = (cur && Number(cur.ts)) || putRes.storedTs || 0;
    if (cur && cur.data && prev && prev.data &&
        JSON.stringify(cur.data.students) !== JSON.stringify(prev.data.students)) {
      return { status: 409, body: { error: 'write_rejected', reason: 'concurrent_change', storedTs: curTs } };
    }
    nextTs = Math.max(saneTs, curTs) + 1;
    clean._ts = nextTs;
    putRes = store.setSchoolData('BOYS', clean, nextTs);
  }
  if (!putRes.written) {
    return { status: 409, body: { error: 'write_rejected', reason: 'stale_ts', storedTs: putRes.storedTs } };
  }
  return { status: 200, body: { ok: true, ts: nextTs } };
}

/* ================= 1)Returned storedTs must be the real one ================= */
test('setSchoolData: عند الرفض يُرجع الـts المخزَّن فعلاً لا المُدخَل', () => {
  const store = makeStore(5000, { students: students(3) });
  const res = store.setSchoolData('BOYS', { students: students(9) }, 1000);
  assert.equal(res.written, false);
  assert.equal(res.storedTs, 5000, 'storedTs = المخزَّن (5000) لا المحلول (1000)');
  assert.notEqual(res.storedTs, 1000);
});

/* ================= 2)Self-race: the admin save now lands ================= */
test('السباق الذاتي بين اللوحة ورفعها التلقائي: الحفظ ينجح الآن بدل الرفض الصامت', () => {
  const T = 1790502841596;
  const store = makeStore(T, { students: students(162, 'old') });
  const prev = store.getSchoolData();
  const clean = { students: students(172, 'new') };

  // رفعٌ تلقائي من اللوحة نفسها وصل بين القراءة والكتابة: يرفع ts بمقدار 1
  store.setSchoolData('BOYS', store.row.data, T + 1);

  const res = putWithRetry(store, prev, clean, T);
  assert.equal(res.status, 200, 'الحفظ الشرعي لم يعد مرفوضاً');
  assert.equal(res.body.ok, true);
  assert.equal(store.row.data.students.length, 172, 'الـ172 وصلت فعلاً');
});

/* ================= 3)No more silent 200 on rejection ================= */
test('لا ok:true عند تعذّر الكتابة — 409 write_rejected', () => {
  // مخزن يرفض كل محاولة (يتقدّم ts في كل محاولة) فنُجبر استنفاد المحاولات
  const store = makeStore(1000, { students: students(162) });
  let n = 0;
  const orig = store.setSchoolData.bind(store);
  store.setSchoolData = (s, d, ts) => {
    n++;
    if (n <= 4) { store.row.ts = store.row.ts + 5; return { written: false, storedTs: store.row.ts }; }
    return orig(s, d, ts);
  };
  const prev = store.getSchoolData();
  const res = putWithRetry(store, prev, { students: students(172) }, 1000);
  assert.equal(res.status, 409);
  assert.equal(res.body.ok, undefined, 'لا ok:true في رد الرفض');
  assert.equal(res.body.error, 'write_rejected');
});

/* ================= 4)Concurrent structural change is not clobbered ================= */
test('تغيير بنيوي من جهاز آخر ⇒ 409 concurrent_change بلا طمس', () => {
  const store = makeStore(2000, { students: students(162) });
  const prev = store.getSchoolData();
  // معلمٌ أضاف طالب من جهاز آخر بعد قراءتنا
  store.setSchoolData('BOYS', { students: students(163) }, 2001);

  const res = putWithRetry(store, prev, { students: students(172) }, 2000);
  assert.equal(res.status, 409);
  assert.equal(res.body.reason, 'concurrent_change');
  assert.equal(store.row.data.students.length, 163, 'بيانات الزميل سليمة، لم تُطمس');
});

/* ================= 5)baseTs-aware stale window ================= */
function isStale({ prevTs, bodyTs, baseTs }) {
  const storedTsNow = prevTs || 0;
  const behindBy = storedTsNow - bodyTs;
  return !!(storedTsNow && (baseTs > 0 ? baseTs < storedTsNow : behindBy > 5 * 60 * 1000));
}

test('عميل تأخّر ثانية واحدة لكنه دمج من الأحدث (baseTs) ⇒ ليس قديماً ⇒ يُحترم حذف المدير', () => {
  // لوحة رفعها التلقائي رفعت المخزَّن بعد أن أخذت العميل نسخته بـ1s
  assert.equal(isStale({ prevTs: 1790502937597, bodyTs: 1790502937588, baseTs: 1790502937597 }), false);
});

test('عميل فعلاً قديم (baseTs أقدم) ⇒ يُدمج محافظاً ولا يُمحى أحد', () => {
  assert.equal(isStale({ prevTs: 1790502937597, bodyTs: 1790502000000, baseTs: 1790501000000 }), true);
});

test('رُقعة السعة: عميل قديم بلا baseTs يبقى على نافذة الـ5 دقائق (سلوك مطابق للنشر الحالي)', () => {
  assert.equal(isStale({ prevTs: 1000 + 60 * 1000, bodyTs: 1000, baseTs: 0 }), false, 'تأخّر دقيقة ⇒ ليس قديماً (سلوك قديم)');
  assert.equal(isStale({ prevTs: 1000 + 6 * 60 * 1000, bodyTs: 1000, baseTs: 0 }), true, 'تأخّر 6 دقائق ⇒ قديم');
});

/* ================= 6)Source-level: the silent path is gone ================= */
test('المصدر: لا يوجد 200 ok يسبق فحصُ نجاح الكتابة', () => {
  const iCheck = src.indexOf('if (!putRes.written) {');
  const i409 = src.indexOf("reason: 'stale_ts'", iCheck);
  const iOk = src.indexOf('res.json({ ok: true, ts: nextTs })');
  assert.ok(iCheck > -1, 'يوجد فحص !putRes.written');
  assert.ok(i409 > iCheck, 'فحص الرفض يسبق رد 409');
  assert.ok(iOk > i409, 'رد ok:true يأتي بعد معالجة الرفض لا قبله');
});

test('المصدر: قاعدة baseTs موجودة في مسار PUT', () => {
  assert.ok(src.includes('declaredBase'), 'يقرأ baseTs من جسم الطلب');
  assert.ok(src.includes("declaredBase > 0 ? declaredBase < storedTsNow"), 'قاعدة baseTs مُطبَّقة');
});
