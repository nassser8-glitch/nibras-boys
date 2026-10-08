/* حارس اسم المستخدم لا يجمّد حفظ المدرسة كلها
 *
 * كان الحارس يتحقق من شكل اسم المستخدم قبل أن يتحقق هل هو نفسه المحفوظ.
 * هل الاسم هو نفسه المحفوظ في الخادم. فحساب قديم اسمُه أقصر من 3 رموز (مثل
 * "fy") — أُنشئ قبل التشديد أو يدوياً — كان يرفض كل دفعة بـ400 إلى الأبد:
 * لا حذف تحويل، ولا حفظ ملاحظة، ولا مزامنة، رغم أن الحساب لم يُمس.
 *
 * المطلوب: الاسم المخالف للشكل يمرّ إن لم يكن مُعدَّلاً، ويفرض على الجديد فقط.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const test = require('node:test');
const assert = require('node:assert');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

function usernameGuardBody() {
  const loopAt = SRC.indexOf('for (const nu of (clean.users || []))');
  assert.ok(loopAt > -1, 'username guard loop not found');
  const end = SRC.indexOf('// ===== نهاية حارس اسم المستخدم =====', loopAt);
  assert.ok(end > loopAt, 'username guard end marker not found');
  /* نبدأ من كتلة try نفسها: الشريحة تبدأ من حلقة for فتبقى catch يتيمة،
   * وتبدأ من try فتصير القطعة سليمة قابلة للتنفيذ وحدها. */
  const tryAt = SRC.lastIndexOf('try {', loopAt);
  assert.ok(tryAt > -1 && tryAt < loopAt, 'the guard try block must precede the loop');
  return SRC.slice(tryAt, end);
}

const BODY = usernameGuardBody();

/* ننفّذ الحارس الحقيقي من server.js داخل معزول، لا نسخةً منه.
 * النسخة اليدوية التي كانت هنا قد انحرفت عن الخادم: لم تكن تفحص صلاحية
 * المستخدم ولا مالك الاسم، فكانت ثمانية اختبارات تمرّ على شيفرة ليست التي
 * تعمل في الإنتاج. عيب كهذا أسوأ من غياب الاختبار: يمنح طمأنينة زائفة. */
async function runGuard(users, prevUsers, session) {
  const out = { status: null, body: null };
  const res = {
    status(s) { out.status = s; return this; },
    json(b) { out.body = b; return this; },
  };
  const ctx = {
    console, Set, Map, JSON, String, Object, Array, RegExp,
    req: { session: session || { role: 'ADMIN', user_id: 'A1' } },
    res,
    clean: { users },
    prevUsers,
    db: { userByUsername: async () => null },
  };
  vm.createContext(ctx);
  await vm.runInContext('(async () => {' + BODY + '})()', ctx);
  /* الرفض يمرّ عبر res.status().json()، والقبول لا يترك أثراً في res. */
  return out.body;
}

test('unchanged legacy short username does not block the whole save', async () => {
  assert.equal(await runGuard([{ id: 'u1', username: 'fy' }], [{ id: 'u1', username: 'fy' }]), null);
});

test('changing a legacy short username to a valid one is accepted', async () => {
  assert.equal(await runGuard([{ id: 'u1', username: 'fatima' }], [{ id: 'u1', username: 'fy' }]), null);
});

test('changing a legacy short username to another invalid short one is rejected', async () => {
  const r = await runGuard([{ id: 'u1', username: 'ab' }], [{ id: 'u1', username: 'fy' }]);
  assert.equal(r && r.error, 'username_invalid');
});

test('a brand new short username is still rejected', async () => {
  const r = await runGuard([{ id: 'u2', username: 'fy' }], [{ id: 'u1', username: 'other' }]);
  assert.equal(r && r.error, 'username_invalid');
});

test('duplicate unchanged names are not reported as taken', async () => {
  assert.equal(await runGuard([{ id: 'u1', username: 'fy' }], [{ id: 'u1', username: 'fy' }]), null);
});

test('two DIFFERENT legacy accounts sharing one name are still flagged', async () => {
  /* بيانات تالفة قد تحوي حسابين على الاسم نفسه. الكاشف كان يرفض هذا قبل
   * الإصلاح، لأن فحص التكرار كان يسبق التجاوز. إن أزلناه لتجاوز الاسم
   * المخالف خسرنا كشف التكرار وجمدنا البيانات التالفة في القاعدة. */
  const r = await runGuard(
    [{ id: 'u1', username: 'fy' }, { id: 'u2', username: 'fy' }],
    [{ id: 'u1', username: 'fy' }, { id: 'u2', username: 'fy' }]
  );
  assert.equal(r && r.error, 'username_taken');
});

test('two changed users colliding is still rejected', async () => {
  const r = await runGuard(
    [{ id: 'u1', username: 'same.name' }, { id: 'u2', username: 'same.name' }],
    [{ id: 'u1', username: 'a' }, { id: 'u2', username: 'b' }]
  );
  assert.equal(r && r.error, 'username_taken');
});

test('accounts without a username are ignored', async () => {
  assert.equal(await runGuard([{ id: 'u1' }, { id: 'u2', username: '' }], []), null);
});

test('guard checks unchanged-before-shape (order is the fix)', () => {
  const unchangedAt = BODY.indexOf('prevMapU.get(nu.id) === uname');
  const shapeAt = BODY.indexOf('/^[a-z0-9._-]{3,32}$/');
  assert.ok(unchangedAt > -1 && shapeAt > -1, 'both branches must exist');
  assert.ok(unchangedAt < shapeAt, 'unchanged check must come BEFORE the shape check');
});
