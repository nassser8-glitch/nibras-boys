// اختبار حارس اسم المستخدم في PUT /api/db/:school.
// لماذا: اسم المستخدم فريد في جدول الحسابات (users_username_key)، والتغيير
// يُطبَّق عليه بعد حفظ نسخة القسم. فلو حُفظت النسخة قبل التحقق، لبقيت
// النسخة تحمل اسماً يرفضه الجدول — تناقض صامت بين الأجهزة.
// نتحقق قبل أي كتابة فيُرفض الطلب كاملاً.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

const guard = (() => {
  const a = src.indexOf('// ===== حارس اسم المستخدم =====');
  assert.ok(a !== -1, 'حارس اسم المستخدم غير موجود في الخادم');
  const b = src.indexOf('// ===== نهاية حارس اسم المستخدم =====', a);
  assert.ok(b > a, 'نهاية الحارس غير محددة');
  return src.slice(a, b);
})();

// نسخة من منطق الحارس تُنفَّذ في معزول — نفس الترتيب والشروط كما في الخادم.
// تُغلَّف في دالة غير متزامنة لأن الحارس نفسه داخل (async () => {...}) في الخادم.
async function runGuard(users, prevUsers, session, dbStubs){
  const vm = require('vm');
  const out = { status: null, body: null };
  const res = {
    status(s){ out.status = s; return this; },
    json(b){ out.body = b; return this; },
  };
  const ctx = {
    console, Set, Map, JSON, String, Object, Array,
    req: { session },
    res,
    clean: { users },
    prevUsers,
    db: Object.assign({ userByUsername: async () => null }, dbStubs),
  };
  vm.createContext(ctx);
  await vm.runInContext('(async () => {\n' + guard + '\n})()', ctx);
  return out;
}

const ADMIN = { role: 'ADMIN', user_id: 'A1' };
const TEACHER = { role: 'TEACHER', user_id: 'T1' };

test('اسم المستخدم صحيح ولا يتغير: يُقبل بلا استعلام إضافي', async () => {
  const users = [{ id: 'u1', username: 'bukhait' }];
  const prev = [{ id: 'u1', username: 'bukhait' }];
  const out = await runGuard(users, prev, ADMIN, {});
  assert.strictEqual(out.status, null, 'رُفض طلب لم يتغير فيه شيء: ' + JSON.stringify(out.body));
});

test('تصحيح إملائي صحيح (bukhaith ← bukhait) يُقبل', async () => {
  const users = [{ id: 'u1', username: 'bukhait' }];
  const prev = [{ id: 'u1', username: 'bukhaith' }];
  const out = await runGuard(users, prev, ADMIN, { userByUsername: async () => null });
  assert.strictEqual(out.status, null, 'التصحيح الإملائي رُفض: ' + JSON.stringify(out.body));
});

test('اسم مستخدم محجوز لحساب آخر: 409 username_taken ولا تُكتب النسخة', async () => {
  const users = [{ id: 'u1', username: 'bukhait' }];
  const prev = [{ id: 'u1', username: 'bukhaith' }];
  const out = await runGuard(users, prev, ADMIN, { userByUsername: async () => ({ id: 'other' }) });
  assert.strictEqual(out.status, 409);
  assert.strictEqual(out.body.error, 'username_taken');
  assert.strictEqual(out.body.username, 'bukhait');
});

test('الاسم نفسه المحجوز من حسابه هو: يُقبل (المقارنة بالمعرّف لا بالنص)', async () => {
  const users = [{ id: 'u1', username: 'bukhait' }];
  const prev = [{ id: 'u1', username: 'bukhaith' }];
  const out = await runGuard(users, prev, ADMIN, { userByUsername: async () => ({ id: 'u1' }) });
  assert.strictEqual(out.status, null, 'رُفض اسم المستخدم نفسه: ' + JSON.stringify(out.body));
});

test('اسم بأحرف غير latin أو مسافات: 400 username_invalid', async () => {
  for (const bad of ['بخيت', 'buk hait', 'a', 'x'.repeat(33), 'buk@hait']){
    const out = await runGuard([{ id: 'u1', username: bad }], [{ id: 'u1', username: 'bukhaith' }], ADMIN, {});
    assert.strictEqual(out.status, 400, 'قُبل اسم غير صالح: ' + bad);
    assert.strictEqual(out.body.error, 'username_invalid');
  }
});

test('تكرار داخل نفس النسخة: 409 قبل أي كتابة', async () => {
  const users = [{ id: 'u1', username: 'bukhait' }, { id: 'u2', username: 'BUKHAIT' }];
  const prev = [{ id: 'u1', username: 'bukhaith' }, { id: 'u2', username: 'other' }];
  const out = await runGuard(users, prev, ADMIN, {});
  assert.strictEqual(out.status, 409);
  assert.strictEqual(out.body.error, 'username_taken');
});

test('غير المدير/الوكيل لا يغيّر اسم مستخدم: 403', async () => {
  const users = [{ id: 'u1', username: 'bukhait' }];
  const prev = [{ id: 'u1', username: 'bukhaith' }];
  const out = await runGuard(users, prev, TEACHER, {});
  assert.strictEqual(out.status, 403);
  assert.strictEqual(out.body.error, 'username_change_forbidden');
});

test('فشل فحص الحارس لا يُسقط الخادم: 500 بدل بكاء غير معالَج', async () => {
  const users = [{ id: 'u1', username: 'bukhait' }];
  const prev = [{ id: 'u1', username: 'bukhaith' }];
  const out = await runGuard(users, prev, ADMIN, { userByUsername: async () => { throw new Error('db down'); } });
  assert.strictEqual(out.status, 500);
  assert.strictEqual(out.body.error, 'username_check_failed');
});

test('حارس اسم المستخدم موجود قبل كتابة نسخة القسم فعلاً', async () => {
  const guardAt = src.indexOf('// ===== حارس اسم المستخدم =====');
  const writeAt = src.indexOf('let putRes = await db.setSchoolData', guardAt);
  assert.ok(guardAt !== -1 && writeAt > guardAt, 'الحارس يجب أن يسبق setSchoolData');
});

test('طلب تصحيح اسم المستخدم يُطبَّق على جدول الحسابات قبل فرضه من الجدول', async () => {
  // العلّة التي كانت تمنع التصحيح: سطر يفرض اسم المستخدم من جدول الحسابات على
  // كل حفظ، فيُلغي الطلب قبل أن يصل إلى الجدول ولا يُحفظ أبداً.
  const guardAt = src.indexOf('// ===== حارس اسم المستخدم =====');
  const readAt = src.indexOf('const unameMap0 = await db.usernamesByIds');
  const applyAt = src.indexOf('db.updateUserIdentity(w.id');
  const rereadAt = src.indexOf('wantedNames.length ? await db.usernamesByIds');
  const forceAt = src.indexOf('clean.users.forEach(u => { if (unameMap.has(u.id)) u.username');
  assert.ok(guardAt !== -1 && guardAt < readAt, 'الحارس يجب أن يسبق قراءة الأسماء');
  assert.ok(readAt < applyAt, 'يجب قراءة الاسم الحالي قبل تطبيق الطلب');
  assert.ok(applyAt < rereadAt, 'يجب تطبيق الطلب على جدول الحسابات قبل إعادة القراءة');
  assert.ok(rereadAt < forceAt, 'الفرض من الجدول يجب أن يأتي بعد إعادة القراءة وإلا لغي الطلب');
});
