'use strict';
/* =============================================================================
 * تفعيل جماعي للمعلمين اعتماداً على قائمة الواجهة «تفعيل كل المعلمين»
 * -----------------------------------------------------------------------------
 * القصة: كانت أسماء المعلمين نحو 48، حذف المدير ما حذف وأبقى قائمة محدّدة لا
 * تزال كلّها «بانتظار أول دخول». وكان التفعيل الفردي قد يصيب اسم معلم محذوفة
 * (تكرار الأسماء) فيبقى اللفظ على الواجهة لمعلم حيّة أو تدخل بقايا محذوفة.
 *
 * القاعدة الجديدة: نسخة القسم (الأسماء الظاهرة أمام المدير) هي الأساس.
 * 1) لكل معلم ظاهرة: يُحلّ حساب دخلها من هوية سجلها (المعرّف ← اسم المستخدم
 *    ← البريد) ويُمحى first_login وتُمنح وتُحذف جلساتها.
 * 2) حسابات المعلمين المحذوفة غير الظاهرة تُعطَّل حتى لا تدخل بقاياها.
 * 3) مسح «بانتظار أول دخول» من سجل القسم نفسه فيختفي اللفظ من الواجهة.
 * ========================================================================== */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SERVER = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const SRC = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');

// --------------------------------------------------------------- الخادم
test('1) المسار موجود بحماية مدير وحدّ معدّل', () => {
  const i = SERVER.indexOf(`app.post('/api/auth/admin/activate-all-from-list'`);
  assert.ok(i >= 0, 'المسار غير موجود');
  const body = SERVER.slice(i, i + 800);
  assert.ok(body.includes("req.session.role !== 'ADMIN'"), 'مدير فقط');
  assert.ok(body.includes("rateLimit('activateall'"), 'بحدّ معدّل');
  assert.ok(body.includes('const result = await activateAllTeachersFromList(school);'), 'يستدعي الدالة الجماعية');
  assert.ok(body.includes('res.json({ ok: true, school, apply: true, ...result });'), 'يردّ بالحصيلة');
});

test('2) الدالة تبني قائمة الواجهة (المعلمين الظاهرة فقط)', () => {
  const i = SERVER.indexOf('async function activateAllTeachersFromList(school)');
  assert.ok(i >= 0, 'الدالة غير موجودة');
  const body = SERVER.slice(i, i + 2000);
  assert.ok(body.includes("const list = (rec && rec.data && Array.isArray(rec.data.users)) ? rec.data.users : [];"),
    'يقرأ نسخة القسم نفسها التي تعرضها الواجهة');
  assert.ok(body.includes("const teachers = list.filter(u => u && u.role === 'TEACHER' && u.active !== false);"),
    'المعلمون النشطون الظاهرون فقط هم الأساس');
});

test('3) لكل معلم حل حساب من هوية سجلها ومسح أول دخول وجلساتها', () => {
  const i = SERVER.indexOf('async function activateAllTeachersFromList(school)');
  const body = SERVER.slice(i, i + 2000);
  assert.ok(body.includes('const bEmail = String(bu.email'), 'يستخرج بريد سجل الواجهة');
  assert.ok(body.includes('const es = await db.usersByEmail(bEmail); if (es.length) target = es[0];'),
    'الربط بالبريد حين يفشل المعرّف والاسم');
  assert.ok(body.includes('await db.grantUserAccess(target.id);'), 'منح');
  assert.ok(body.includes('await db.clearFirstLogin(target.id);'), 'مسح first_login من جدول الحسابات');
  assert.ok(body.includes('await db.deleteUserSessions(target.id);'), 'حذف جلسات');
  assert.ok(body.includes('accountsCleared++'), 'يُحسب المنجز');
  assert.ok(body.includes('unlinked++'), 'يُحسب ما لا يُربط');
});

test('4) تتعطَّل حسابات المعلمين المحذوفة (غير الظاهرة) ولا يُلامَس شيء من قائمة الواجهة', () => {
  const i = SERVER.indexOf('async function activateAllTeachersFromList(school)');
  const body = SERVER.slice(i, i + 3200);
  assert.ok(body.includes('let staleDeactivated = 0;'), 'يُحسب ما عُطّل');
  assert.ok(body.includes("if (!r0 || r0.role !== 'TEACHER' || r0.active !== true) continue;"),
    'يقصُر التعطيل على حسابات معلمين نشطين فقط');
  assert.ok(body.includes('await db.setUserActive(r0.id, false);'), 'تعطيل لا حذف — يُحفظ الأثر');
  assert.ok(body.includes('const wasPending = !!u.firstLogin;'), 'يمسح اللفظ من سجل القسم');
  assert.ok(body.includes('u.firstLogin = false;'), 'نسخة القسم نفسها تصبح مفعّلة');
  assert.ok(body.includes("if ((n && protectNames.has(n)) || (e && protectNames.has(e))) continue;"),
    'لا يُعطَّل حساب معلم حيّة وإن كُتب عليه اسم مكرّر');
});

// --------------------------------------------------------------- الواجهة
test('5) الواجهة: زر جماعي يستدعي المسار ويلصّق الحقيقة بعد تحديث الشاشة', () => {
  assert.ok(SRC.includes('onclick="activateAllTeachersApi()"'), 'الزر موجود في صفحة المعلمين');
  const j = SRC.indexOf('async function activateAllTeachersApi(){');
  assert.ok(j >= 0, 'الدالة غير موجودة');
  const body = SRC.slice(j, j + 2200);
  assert.ok(body.includes("'admin/activate-all-from-list'"), 'ينادي المسار الجماعي');
  assert.ok(body.includes('await __refreshSchool(getActiveSchool());'), 'يسحب أحدث نسخة بعد الطلب');
  assert.ok(body.includes('j.staleDeactivated ?? 0'), 'يعرض عدد المعطلات المحذوفات');
  assert.ok(body.includes('j.unlinked || 0') || body.includes('j.unlinked??0'), 'يكشف المعلمين بلا حساب مرتبط');
});

test('6) تحقق ما بعد التنفيذ وتقرير لكل معلم رُبط حسابها', () => {
  const i = SERVER.indexOf('async function activateAllTeachersFromList(school)');
  const body = SERVER.slice(i, i + 3600);
  assert.ok(body.includes('const clearedIds = [];'), 'يجمع معرّفات ما مُسح');
  assert.ok(body.includes('SELECT count(*)::int AS n FROM users WHERE id = ANY($1) AND first_login = true'),
    'يقرأ بعد التنفيذ كم حسابٍ ما زال بانتظار أول دخول فعلاً');
  assert.ok(body.includes('stillPendingAccounts'), 'يردّ بالتحقق');
  assert.ok(body.includes('report.push({ name: bu.name'), 'تقرير لكل معلم');
});

test('7) نقطة التشخيص تعرض first_login و granted للتحقق من الحالة الفعلية', () => {
  const i = SERVER.indexOf(`app.get('/api/diag/teacher-dup'`);
  assert.ok(i >= 0, 'نقطة التشخيص موجودة');
  const body = SERVER.slice(i, i + 500);
  assert.ok(body.includes('first_login'), 'يُطالع جدول الحسابات بحالته الفعلية');
  assert.ok(body.includes('granted'), 'بمعرفة منح الدخول');
});

test('8) الواجهة: التطبيق الفوري على النسخة المحلية من تقرير الخادم لا من سحب مُتجاهل', () => {
  const j = SRC.indexOf('async function activateAllTeachersApi(){');
  const body = SRC.slice(j, j + 2600);
  assert.ok(body.includes('const names = new Set();'), 'يبني فهرس المعلمين المفعّلة من التقرير');
  assert.ok(body.includes('if(names.has(k)){ u.firstLogin = false; u.granted = true; flipped++; }'),
    'يقلب المحلي مباشرة فلا تبقى «بانتظار أول دخول» أمام المدير');
  assert.ok(body.includes("__origSetItem(dbKey(), JSON.stringify(d))"), 'يكتب بلا دورة رفع على الخادم');
  assert.ok(body.includes('j.stillPendingAccounts || 0'), 'يحذّر إن بقي حساب فعلاً بانتظار أول دخول');
});