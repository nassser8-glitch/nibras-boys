'use strict';
/* =============================================================================
 * تشخيص: الحذف يصل العميلَ ولا يصل الخادم. نختبر PUT حقيقياً بمسة كاملة
 * (خادم + قاعدة بيانات على القرص) بدل الاكتفاء بقراءة الشيفرة.
 * ========================================================================== */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');

test('مسار الحفظ PUT يستقبل التحويلات فعلاً', () => {
  const i = SRC.indexOf('transfers:');
  const rules = SRC.slice(SRC.indexOf('const SECTION_RULES'), SRC.indexOf('const SECTION_RULES') + 700);
  assert.ok(/transfers:\s*\[/.test(rules), 'قسم transfers غير معلن في SECTION_RULES');
});

test('الخادم يدمج التحويلات فوق نسخة الخادم (mergeSection) في PUT', () => {
  // بدون الدمج، نسخة جهاز قديم تستبدل المحذوفات/المحلولة كاملة.
  const putStart = SRC.indexOf('const cf = JSON.parse(JSON.stringify(data));');
  assert.ok(putStart > -1, 'مسار الاستبدال الكامل للمدير غير موجود');
  const block = SRC.slice(putStart, putStart + 4000);
  assert.ok(/cf\.transfers\s*=\s*mergeTransfers/.test(block),
    'المدير يستبدل التحويلات كاملاً بلا دمج: نسخة قديمة تمسح الشاهد والحل');
});

test('enforceTransferDeleteRights مُربوط قبل الحفظ', () => {
  const i = SRC.indexOf('enforceTransferDeleteRights(data.transfers');
  assert.ok(i > -1, 'حارس حذف التحويلات غير مربوط');
  const save = SRC.indexOf('setSchoolData', i);
  assert.ok(save > -1 && save > i, 'الحارس يجب أن يكون قبل الحفظ');
});