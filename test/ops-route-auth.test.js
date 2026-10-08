'use strict';
// نبراس البنين: نظام قسم البنين فقط — لا توجد مسارات /api/ops خاصة بقسم البنات إطلاقاً.
//
// المساران /api/ops/ensure-girls-admin و /api/ops/clean-girls (كانا ينشئان ADMIN بكلمة
// مرور مضمَّنة أو يحذفان فصولاً بلا تحقق) حُذفا نهائياً من نظام البنين:
//   - لا حساب إداري مضمَّن غير المسؤول المتصل عبر قاعدة البيانات (seed).
//   - لا أداة تنظيف مكتوبة يدوياً يمكن استدعاؤها عبر HTTP.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const SERVER_PATH = path.join(__dirname, '..', 'server.js');
const src = fs.readFileSync(SERVER_PATH, 'utf8');

const GONE = ['/api/ops/ensure-girls-admin', '/api/ops/clean-girls'];

test('مسارات /api/ops الخاصة بقسم البنات غير موجودة في الخادم', () => {
  for (const route of GONE) {
    assert.ok(!src.includes("'" + route + "'"), 'لا يجب وجود: ' + route);
    assert.ok(!src.includes('"' + route + '"'), 'لا يجب وجود (تنصيص مزدوج): ' + route);
  }
});

test('لا توجد أي مسارات /api/ops في نظام البنين', () => {
  const re = /app\.(get|post|put|delete)\(\s*['"]\/api\/ops/;
  assert.ok(!re.test(src), 'لا مسارات /api/ops إطلاقاً');
});

test('لا حساب إداري مضمَّن بكلمة مرور في الخادم', () => {
  assert.ok(!/password:\s*['"][^'"]{3,}['"]/.test(src.replace(/["'][^"']*MAIL_PASS[^"']*["']/g, '""')),
    'لا كلمة مرور مضمَّنة في نص الخادم');
  assert.ok(!/key:\s*['"]MAIL_PASS['"],\s*default:\s*['"]/.test(src),
    'MAIL_PASS بلا قيمة افتراضية');
});

test('db.mutateSchoolData سليم كما هو (المعاملة الرتيبة)', () => {
  const dbSrc = fs.readFileSync(path.join(__dirname, '..', 'db.js'), 'utf8');
  assert.ok(/async function mutateSchoolData\(school, mutator\)/.test(dbSrc), 'موجود');
  assert.ok(/Math\.max\(Date\.now\(\), storedTs \+ 1\)/.test(dbSrc), 'ts رتيب كما هو');
  assert.ok(/SELECT data, ts FROM school_data WHERE school = \$1 FOR UPDATE/.test(dbSrc), 'FOR UPDATE كما هو');
});