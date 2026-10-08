'use strict';

// يثبت هذا الاختبار أن أي إجراء على بلاغات الصيانة (اعتماد/رفض/رفع/بدء/إكمال/حذف/إنشاء)
// يُرفع إلى الخادم فورًا، لا أن يُحفظ في التخزين المحلي وحده.
// السبب: الحفظ المحلي وحده يمحوه أول سحب دوري من الخادم، فيعود البلاغ إلى حالته
// السابقة ويبدو للمستخدم أن "الرسالة ثابتة" أي أن الإجراء لم يُنفَّذ.
// نستخرج الدوال الحقيقية من public/index.html ونشغّلها في vm ونراقب نداءات المزامنة.

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const INDEX_HTML_PATH = path.join(__dirname, '..', 'public', 'index.html');

function extractFunctionSource(src, marker) {
  const startIdx = src.indexOf(marker);
  if (startIdx === -1) throw new Error(`function not found in index.html: ${marker}`);
  const braceStart = src.indexOf('{', startIdx);
  let depth = 0;
  let end = braceStart;
  for (; end < src.length; end++) {
    if (src[end] === '{') depth++;
    else if (src[end] === '}') {
      depth--;
      if (depth === 0) { end++; break; }
    }
  }
  return src.slice(startIdx, end);
}

const AGENT = { id: 'u-agent', role: 'AGENT', school: 'BOYS' };

function buildSandbox({ report, user = AGENT, confirmAnswer = true, promptAnswer = '0' }) {
  const src = fs.readFileSync(INDEX_HTML_PATH, 'utf8');
  const maintActionSrc = extractFunctionSource(src, 'function maintAction(id, action){');
  const maintDeleteSrc = extractFunctionSource(src, 'function maintDelete(id){');

  const db = { maintenance: [JSON.parse(JSON.stringify(report))], users: [] };

  const context = {
    loadDB: () => db,
    currentUser: () => user,
    getActiveSchool: () => 'BOYS',
    todayStr: () => '2026-09-30',
    saveDB: null,
    renderApp: null,
    __syncSchedule: null,
    maintCanFollow: null,
    maintCanDecide: null,
    maintCanDelete: null,
    confirm: () => confirmAnswer,
    prompt: () => promptAnswer,
    console,
  };
  vm.createContext(context);

  context.savedCount = 0;
  context.syncCalls = [];
  context.renderAppCallCount = 0;
  context.saveDB = (d) => { context.savedCount++; context.savedDB = d; };
  context.__syncSchedule = (school, ms) => { context.syncCalls.push([school, ms]); };
  context.renderApp = () => { context.renderAppCallCount++; };
  context.maintCanFollow = () => true;
  context.maintCanDecide = () => true;
  context.maintCanDelete = () => true;

  vm.runInContext(maintActionSrc, context);
  vm.runInContext(maintDeleteSrc, context);

  return { ctx: context, db };
}

const BASE_REPORT = {
  id: 'PM-0001', status: 'جديد', priority: 'طارئ', description: 'تسريب مياه',
  createdBy: 'u-1', createdByName: 'معلم', cost: 0,
};

test('maintAction: الاعتماد يغيّر الحالة ويرفعها للخادم فورًا', () => {
  const { ctx, db } = buildSandbox({ report: { ...BASE_REPORT, status: 'بانتظار اعتماد الوكيل' } });
  ctx.maintAction('PM-0001', 'approve');
  assert.equal(db.maintenance[0].status, 'معتمد', 'يجب أن تتغير الحالة إلى معتمد');
  assert.ok(ctx.savedCount > 0, 'يجب الحفظ');
  assert.equal(ctx.syncCalls.length, 1, 'يجب نداء __syncSchedule مرة واحدة (رفع فوري للخادم)');
});

test('maintAction: الرفع للوكيل يرفع الحالة للخادم (وإلا محاها أول سحب)', () => {
  const { ctx, db } = buildSandbox({ report: BASE_REPORT });
  ctx.maintAction('PM-0001', 'forward');
  assert.equal(db.maintenance[0].status, 'بانتظار اعتماد الوكيل');
  assert.equal(ctx.syncCalls.length, 1, 'يجب رفع الحالة للخادم فورًا');
});

test('maintAction: بدء التنفيذ وإكمال الطلب يرفعان الحالة للخادم', () => {
  const approved = buildSandbox({ report: { ...BASE_REPORT, status: 'معتمد' } });
  approved.ctx.maintAction('PM-0001', 'start');
  assert.equal(approved.db.maintenance[0].status, 'قيد التنفيذ');
  assert.equal(approved.ctx.syncCalls.length, 1, 'بدء التنفيذ يجب أن يُرفع فورًا');

  const running = buildSandbox({ report: { ...BASE_REPORT, status: 'قيد التنفيذ' } });
  running.ctx.maintAction('PM-0001', 'complete');
  assert.equal(running.db.maintenance[0].status, 'مكتمل');
  assert.equal(running.ctx.syncCalls.length, 1, 'الإكمال يجب أن يُرفع فورًا');
});

test('maintAction: الرفض يرفع سبب الرفض والحالة للخادم', () => {
  const { ctx, db } = buildSandbox({ report: { ...BASE_REPORT, status: 'بانتظار اعتماد الوكيل' }, promptAnswer: 'لا يوجد سبب' });
  ctx.maintAction('PM-0001', 'reject');
  assert.equal(db.maintenance[0].status, 'مرفوض');
  assert.equal(db.maintenance[0].rejectReason, 'لا يوجد سبب');
  assert.equal(ctx.syncCalls.length, 1, 'الرفض يجب أن يُرفع فورًا');
});

test('maintAction: الإجراء غير المسموح به لا يحفظ ولا يرفع', () => {
  const { ctx, db } = buildSandbox({ report: BASE_REPORT, user: { id: 'u-t', role: 'TEACHER', school: 'BOYS' } });
  ctx.maintCanFollow = () => false;
  ctx.maintCanDecide = () => false;
  ctx.maintAction('PM-0001', 'forward');
  assert.equal(db.maintenance[0].status, 'جديد', 'يجب ألا تتغير الحالة');
  assert.equal(ctx.syncCalls.length, 0, 'لا داعي للرفع إن لم يتغير شيء');
});

test('maintDelete: الحذف يُرفع للخادم فورًا (وإلا عاد البلاغ بعد السحب)', () => {
  const { ctx, db } = buildSandbox({ report: BASE_REPORT, confirmAnswer: true });
  ctx.maintDelete('PM-0001');
  assert.equal(db.maintenance.length, 0, 'يجب حذف البلاغ');
  assert.equal(ctx.syncCalls.length, 1, 'الحذف يجب أن يُرفع فورًا');
});

test('maintDelete: إلغاء التأكيد لا يحذف ولا يرفع', () => {
  const { ctx, db } = buildSandbox({ report: BASE_REPORT, confirmAnswer: false });
  ctx.maintDelete('PM-0001');
  assert.equal(db.maintenance.length, 1, 'يجب بقاء البلاغ');
  assert.equal(ctx.syncCalls.length, 0, 'لا رفع عند الإلغاء');
});

// ===== الدمج عند السحب: لماذا كانت الحالة "تعود" إلى ما قبل الإجراء =====

const src = fs.readFileSync(INDEX_HTML_PATH, 'utf8');

function extractMaintMerge(srcText) {
  const start = srcText.indexOf('const maintTimes = (x) =>');
  if (start === -1) throw new Error('maintTimes merge helper not found in index.html');
  // نلتقط تعريف maintTimes و maintStamp و mergeMaintByIdNewer فقط دون الكتل التالية التي تحتاج obj
  const fnStart = srcText.indexOf('const mergeMaintByIdNewer = (srvArr, locArr) => {', start);
  if (fnStart === -1) throw new Error('mergeMaintByIdNewer not found in index.html');
  let depth = 0;
  let end = srcText.indexOf('{', fnStart);
  for (; end < srcText.length; end++) {
    if (srcText[end] === '{') depth++;
    else if (srcText[end] === '}') {
      depth--;
      if (depth === 0) { end++; break; }
    }
  }
  return srcText.slice(start, end);
}

function buildMergeSandbox() {
  const context = {
    __canonEq: (a, b) => JSON.stringify(a) === JSON.stringify(b),
    console,
  };
  vm.createContext(context);
  vm.runInContext(extractMaintMerge(src) + '\n;globalThis.__merge = mergeMaintByIdNewer;', context);
  return { merge: (...a) => context.__merge(...a) };
}

test('الدمج: بلاغ حُدّث محليًا يتقدّم على نسخته القديمة في الخادم (السبب: "الرسالة ثابتة")', () => {
  const { merge } = buildMergeSandbox();
  const server = [{ id:'PM-0002', status:'قيد التنفيذ', cost:0, createdAt:'2026-09-22T00:00:00.000Z' }];
  // الجهاز نفّذ «إكمال وإدخال التكلفة» فسُجّلت بصمة أحدث
  const local = [{ id:'PM-0002', status:'مكتمل', cost:250, createdAt:'2026-09-22T00:00:00.000Z', updatedAt:'2026-09-30T10:00:00.000Z' }];
  const merged = merge(server, local);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].status, 'مكتمل', 'يجب أن تتقدّم الحالة المحلية المحدثة على الخادم');
  assert.equal(merged[0].cost, 250, 'يجب حفظ التكلفة المُدخلة');
});

test('الدمج: نسخة الخادم الأحدث زمنيًا تفوز (لا ننسف تعديل زميل من جهاز أحدث)', () => {
  const { merge } = buildMergeSandbox();
  const server = [{ id:'PM-0003', status:'معتمد', createdAt:'2026-09-22T00:00:00.000Z', updatedAt:'2026-09-30T12:00:00.000Z' }];
  const local = [{ id:'PM-0003', status:'جديد', createdAt:'2026-09-22T00:00:00.000Z', updatedAt:'2026-09-30T09:00:00.000Z' }];
  const merged = merge(server, local);
  assert.equal(merged[0].status, 'معتمد', 'يجب احترام الأحدث من الخادم');
});

test('الدمج: بلاغ جديد محليًا يُضاف، وبلاغ محذوف من الخادم لا يُعاد إحياؤه بلا سبب', () => {
  const { merge } = buildMergeSandbox();
  const server = [{ id:'PM-0001', status:'جديد', createdAt:'2026-08-31T00:00:00.000Z' }];
  const local = [
    { id:'PM-0002', status:'جديد', createdAt:'2026-09-22T00:00:00.000Z' },
    { id:'PM-0001', status:'معتمد', createdAt:'2026-08-31T00:00:00.000Z', updatedAt:'2026-09-30T10:00:00.000Z' },
  ];
  const merged = merge(server, local);
  assert.equal(merged.length, 2, 'يجب أن يحتوي البلاغين');
  const pm2 = merged.find(x => x.id === 'PM-0002');
  assert.ok(pm2, 'البلاغ الجديد محليًا يجب أن يُحفظ');
  assert.equal(merged.find(x => x.id === 'PM-0001').status, 'معتمد', 'تغيّر الحالة محفوظ');
});

test('maintAction يضبط updatedAt ليُعرف أي نسخة أحدث عند الدمج', () => {
  const { ctx, db } = buildSandbox({ report: { ...BASE_REPORT, status: 'قيد التنفيذ' } });
  ctx.maintAction('PM-0001', 'complete');
  const r = db.maintenance[0];
  assert.equal(r.status, 'مكتمل');
  assert.ok(r.updatedAt, 'يجب تسجيل updatedAt عند تغيّر الحالة');
  assert.ok(!Number.isNaN(Date.parse(r.updatedAt)), 'updatedAt يجب أن يكون تاريخًا صالحًا');
});

// ===== التتابع: اعتمادٌ قديمٌ ثم إكمالٌ اليوم (السبب: البلاغ "يعود كأنه لم يتم عليه إجراء") =====

test('الدمج: إكمالٌ اليوم يتقدّم رغم وجود تاريخ اعتماد أقدم (البلاغ لا يعود لحالته السابقة)', () => {
  const { merge } = buildMergeSandbox();
  // الخادم ما زال يحمل نسخة «معتمد» بتاريخ اعتماد سابق
  const server = [{ id:'PM-0002', status:'معتمد', cost:0, createdAt:'2026-09-22T00:00:00.000Z', approvedAt:'2026-09-23T08:00:00.000Z' }];
  // الجهاز أكمل البلاغ اليوم فسجّل completedAt + updatedAt اليوم
  const local = [{
    id:'PM-0002', status:'مكتمل', cost:15000,
    createdAt:'2026-09-22T00:00:00.000Z', approvedAt:'2026-09-23T08:00:00.000Z',
    startedAt:'2026-09-29T08:00:00.000Z', completedAt:'2026-09-30T10:00:00.000Z',
    updatedAt:'2026-09-30T10:00:00.000Z',
  }];
  const merged = merge(server, local);
  assert.equal(merged[0].status, 'مكتمل', 'يجب أن يكتمل البلاغ ولا يعود إلى معتمد');
  assert.equal(merged[0].cost, 15000, 'يجب حفظ المبلغ المدخل');
});

test('الدمج: بصمة الإجراء الأحدث تنتصر مهما كان ترتيب حقول التاريخ داخل البلاغ', () => {
  const { merge } = buildMergeSandbox();
  const server = [{ id:'PM-0009', status:'معتمد', cost:0, createdAt:'2026-09-01T00:00:00.000Z', approvedAt:'2026-09-20T08:00:00.000Z' }];
  // startedAt أقدم من approvedAt لكن كلاهما أقدم من updatedAt
  const local = [{
    id:'PM-0009', status:'قيد التنفيذ', cost:0,
    createdAt:'2026-09-01T00:00:00.000Z', approvedAt:'2026-09-20T08:00:00.000Z',
    startedAt:'2026-09-19T08:00:00.000Z', updatedAt:'2026-09-30T09:00:00.000Z',
  }];
  const merged = merge(server, local);
  assert.equal(merged[0].status, 'قيد التنفيذ', 'يجب اعتماد الإجراء الأحدث لا الأقدم');
});

test('الدمج: بلاغ بلا أي تاريخ على الإطلاق لا يسقط الخادم (بلا انهيار Date)', () => {
  const { merge } = buildMergeSandbox();
  const server = [{ id:'PM-0010', status:'جديد', cost:0 }];
  const local = [{ id:'PM-0010', status:'معتمد', cost:0 }];
  const merged = merge(server, local);
  assert.equal(merged.length, 1, 'يجب ألا ينهار الدمج على تواريخ مفقودة');
});

