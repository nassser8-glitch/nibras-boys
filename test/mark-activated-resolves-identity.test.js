'use strict';
/* =============================================================================
 * «اعتبار المعلم مُفعّلة» لم تعد تزول «بانتظار أول دخول» — آمال عبد
 * -----------------------------------------------------------------------------
 * القصة: بعد تطبيع الأسماء المكررة قد يحمل سجل النسخة معرّفاً يتيماً أو اسماً
 * مختلفاً عن جدول الحسابات. كان admin/mark-activated يكتفي بالبحث عن الحساب
 * بالمعرّف ثم بالاسم، وبفشل الاثنين يبقى first_login=true في جدول الحسابات —
 * ومصدر الحقيقة لِـ firstLogin عند دخول المعلم هو ذلك الجدول — فتظل المعلم
 * «بانتظار أول دخول» رغم أن رسالة التفعيل ظهرت للمدير («لا تزول»).
 *
 * القاعدة الجديدة:
 * 1) الخادم يحفر هوية سجل النسخة نفسه (id ثم username ثم email) لربط حساب
 *    الدخول ومسح first_login منه + حذف جلساته، ويُعلِم بـ accountsCleared.
 * 2) الواجهة تتحقق بعد التحديث: إن بقيت الحالة على جهازها أو فشل الربط
 *    تُظهر الحقيقة بدل رسالة النجاح المسبقة.
 * 3) تراكب /api/db يطابق حساب الدخول بالبريد أيضاً.
 * ========================================================================== */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SERVER = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const SRC = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');

// ----------------------------------------------------------------- الخادم
test('1) الخادم: يحفر سجل النسخة عند فشل المعرّف والاسم لربط حساب الدخول', () => {
  const i = SERVER.indexOf(`app.post('/api/auth/admin/mark-activated'`);
  assert.ok(i >= 0, 'المسار موجود');
  const body = SERVER.slice(i, i + 4200);
  // حفر سجل النسخة: بالمعرّف ثم بالاسم
  assert.ok(body.includes("let blobUser = userId ? list.find(u => u && String(u.id) === String(userId)) : null;"),
    'يبدأ الحفر بمعرّف سجل النسخة نفسه');
  assert.ok(body.includes("if (!blobUser && username) blobUser = list.find(u => u && String(u.username"),
    'يستنفد مطابقة اسم المستخدم من النسخة');
  assert.ok(body.includes("const bEmail = String(blobUser.email || '').trim().toLowerCase();"),
    'يستخرج بريد سجل النسخة');
  assert.ok(body.includes("const es = await db.usersByEmail(bEmail); if (es.length) target = es[0];"),
    'يربط حساب الدخول عبر البريد عندما تُفلت المعرّف والاسم');
});

test('2) الخادم: يمسح first_login + الجلسات من الحساب المربوط ويُعلِم بـ accountsCleared', () => {
  const i = SERVER.indexOf(`app.post('/api/auth/admin/mark-activated'`);
  const body = SERVER.slice(i, i + 4200);
  assert.ok(body.includes('await db.clearFirstLogin(target.id);'), 'يمسح first_login من جدول الحسابات');
  assert.ok(body.includes('accountsCleared = true;'), 'يُثبت نجاح الربط');
  assert.ok(body.includes('res.json({ ok: true, accountsCleared,'), 'يردّ بالحقيقة للواجهة');
  assert.ok(body.includes("if (!target && !updated) return res.status(404).json({ error: 'not_found' });"),
    'لا زيف نجاح: بلا حِسابٍ وبلا تحديثٍ تُرفض');
});

// ----------------------------------------------------------------- تراكب /api/db
test('3) تراكب /api/db يطابق حساب الدخول بالبريد أيضاً', () => {
  const i = SERVER.indexOf(`const stats = await db.usersForLoginStats(school);`);
  assert.ok(i >= 0, 'قسم التراكب موجود');
  const body = SERVER.slice(i, i + 1500);
  assert.ok(body.includes('byEmail'), 'يُبنى فهرس بريد');
  assert.ok(body.includes("|| (u.email ? byEmail.get(String(u.email).toLowerCase()) : null)"),
    'مطابقة التقديم تلجأ للبريد حين يفشل المعرّف والاسم');
});

// ----------------------------------------------------------------- الواجهة
test('4) الواجهة: تتحقق بعد التحديث وتقول الحقيقة لا رسالة النجاح المسبقة', () => {
  const j = SRC.indexOf('async function markUserActivated(');
  assert.ok(j >= 0, 'دالة الواجهة موجودة');
  const body = SRC.slice(j, j + 1900);
  assert.ok(body.includes('const after = userById(id);'), 'يقرأ الحالة بعد السحب');
  assert.ok(body.includes('r.j.accountsCleared === false'), 'يعالج فشل ربط الحساب');
  assert.ok(body.includes('const stillPending = !!(after && after.firstLogin);'), 'يكشف بقاء الحالة بعد السحب');
  assert.ok(body.includes('else if(stillPending){'), 'يحذّر من الشاشة القديمة بدل الوعد الكاذب');
  assert.ok(body.includes('أعد التحميل (Ctrl+Shift+R) مرتين'), 'يوجّه إلى حل الشاشة القديمة');
});