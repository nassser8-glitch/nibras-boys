'use strict';
/* =============================================================================
 * الحارس: كلمة «بانتظار أول دخول» تُحذف نهائياً من الواجهة
 * -----------------------------------------------------------------------------
 * أُزيلت من قائمتي المعلمين والإدارة، وأُزيل الزر الفردي المرتبط بها، ولم تبقَ
 * في أي رسالة ظاهرة. هذا الحارس يمنع عودتها مستقبلاً.
 * ========================================================================== */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');

test('1) عبارة «بانتظار أول دخول» غائبة نهائياً من الواجهة', () => {
  assert.ok(!SRC.includes('بانتظار أول دخول'), 'لا توجد العبارة في أي نص ظاهر');
  assert.ok(!SRC.includes('بانتظار اول دخول'), 'ولا بنسخة بديلة من التهجي');
  assert.ok(!SRC.includes('⏳ بانتظار أول'), 'ولا بالرمز المصاحب للوباء');
});

test('2) بديلا الحالة: كل حساب يظهر مفعّلاً بلا شرط', () => {
  const a = SRC.indexOf("const authCell = u.role === 'TEACHER'");
  assert.ok(a >= 0, 'خلية بيانات دخول المعلم موجودة');
  const body = SRC.slice(a, a + 500);
  assert.ok(!body.includes('u.firstLogin ?'), 'لا شرط أول دخول في خلية المعلم');
  assert.ok(body.includes('✅ مفعّل'), 'يظهر البديل الثابت');
});

test('3) لا زر فردي «اعتبارها مفعّلة» مبنياً على الحالة', () => {
  assert.ok(!SRC.includes('onclick="markUserActivated('), 'لا زر يُلحق بشرط الحالة');
  assert.ok(SRC.includes("onclick=\"activateAllTeachersApi()\""), 'يبقى التفعيل الجماعي وحده في شاشة الحسابات');
});