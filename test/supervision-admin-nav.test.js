'use strict';

// يثبت هذا الاختبار أن رابط "🛡️ الإشراف اليومي" يظهر لحساب ADMIN فقط ولا يظهر لحساب TEACHER
// في قائمة التنقل الجانبية (renderLayout -> groups)، بعد نقله من فرع SCHOOL_AGENT
// إلى فرع ADMIN/AGENT/TEACHER الفعلي.
// نستخرج تعبير `const groups = ...` الحقيقي من public/index.html ليعكس السلوك المنشور فعليًا.

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const INDEX_HTML_PATH = path.join(__dirname, '..', 'public', 'index.html');

function extractGroupsExpression(src) {
  const marker = 'const groups = isStudent ? [';
  const startIdx = src.indexOf(marker);
  if (startIdx === -1) throw new Error('groups expression not found in index.html');
  const exprStart = startIdx + 'const groups = '.length;
  // نبحث عن نهاية التعبير: أول "]);" يغلق قائمة `groups` بعد بداية التعبير
  const endMarker = '\n  ]);';
  const endIdx = src.indexOf(endMarker, exprStart);
  if (endIdx === -1) throw new Error('end of groups expression not found');
  const exprEnd = endIdx + endMarker.length - 1; // يشمل ']'
  return src.slice(exprStart, exprEnd);
}

function computeNavKeysForRole(role) {
  const src = fs.readFileSync(INDEX_HTML_PATH, 'utf8');
  const groupsExpr = extractGroupsExpression(src);

  const context = {
    user: { role },
    isStudent: role === 'STUDENT',
    tl: (s) => s,
    pendingPartRequests: () => 0,
    msgMonitorBadge: () => 0,
  };
  vm.createContext(context);
  const groups = vm.runInContext(groupsExpr, context);
  const keys = [];
  for (const group of groups) {
    for (const item of group.items) {
      if (item) keys.push(item.key);
    }
  }
  return keys;
}

test('ADMIN: يظهر رابط إدارة الإشراف اليومي في قائمة التنقل', () => {
  const keys = computeNavKeysForRole('ADMIN');
  assert.ok(keys.includes('supervision'), 'يجب أن يحتوي على رابط supervision لحساب ADMIN');
});

test('TEACHER: لا يظهر رابط إدارة الإشراف اليومي في قائمة التنقل', () => {
  const keys = computeNavKeysForRole('TEACHER');
  assert.ok(!keys.includes('supervision'), 'يجب ألا يحتوي على رابط supervision لحساب TEACHER');
});

test('SCHOOL_AGENT: يظهر رابط الإشراف اليومي (الوكيل تسجّل من أدى الإشراف ومن لم يؤده)', () => {
  const keys = computeNavKeysForRole('SCHOOL_AGENT');
  assert.ok(keys.includes('supervision'), 'يجب أن يحتوي فرع SCHOOL_AGENT على رابط supervision');
});

test('AGENT (الوكيل): يظهر رابط الإشراف اليومي (الوكيل يسجّل من أدى الإشراف ومن لم يؤده)', () => {
  const keys = computeNavKeysForRole('AGENT');
  assert.ok(keys.includes('supervision'), 'يجب أن يحتوي فرع AGENT على رابط supervision');
});
