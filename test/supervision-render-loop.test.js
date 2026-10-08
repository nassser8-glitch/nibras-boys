'use strict';

// يثبت هذا الاختبار أن فشل تحميل بيانات الإشراف اليومي (/api/supervision/today)
// لا يؤدي إلى استدعاء renderApp() بشكل متكرر لا نهائي.
// نستخرج الكود الفعلي لدالة __loadSupervisionToday من public/index.html (وليس نسخة منه)
// حتى يعكس الاختبار السلوك الحقيقي المنشور، ونحاكي حلقة renderApp() نفسها كما هي في الملف.

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const INDEX_HTML_PATH = path.join(__dirname, '..', 'public', 'index.html');

function extractFunctionSource(src, name) {
  const marker = `async function ${name}(`;
  const startIdx = src.indexOf(marker);
  if (startIdx === -1) throw new Error(`function not found in index.html: ${name}`);
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

// يستخرج فقط جسم شرط الإشراف داخل renderApp() (النمط الحقيقي المستخدم لمنع الحلقة)
function extractRenderAppSupervisionTrigger(src) {
  const marker = "if(__serverEnabled() && (user.role === 'TEACHER' || user.role === 'ADMIN' || user.role === 'AGENT' || user.role === 'SCHOOL_AGENT')){";
  const startIdx = src.indexOf(marker);
  if (startIdx === -1) throw new Error('renderApp supervision trigger block not found');
  let depth = 0;
  let end = startIdx + marker.length - 1; // موضع '{' الأول
  for (let i = end; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) { end = i + 1; break; }
    }
  }
  return src.slice(startIdx, end);
}

function buildSandbox(fetchImpl) {
  const src = fs.readFileSync(INDEX_HTML_PATH, 'utf8');
  const loadSupervisionTodaySrc = extractFunctionSource(src, '__loadSupervisionToday');
  const renderAppTriggerSrc = extractRenderAppSupervisionTrigger(src);

  const context = {
    __serverEnabled: () => true,
    __supervisionToday: null,
    __supervisionTodayLoading: false,
    __supervisionTodayFailed: false,
    __supervisionTodayAttempts: 0,
    __supervisionTodayDenied: false,
    SUPERVISION_MAX_ATTEMPTS: 3,
    SUPERVISION_API: '/api/supervision/',
    fetchCallCount: 0,
    renderAppCallCount: 0,
    __testUser: { role: 'TEACHER' },
    fetch: null,
    Intl,
    Date,
    console,
  };
  vm.createContext(context);
  context.fetch = (...args) => { context.fetchCallCount++; return fetchImpl(...args); };

  vm.runInContext(loadSupervisionTodaySrc, context);

  // renderApp مبسّطة: تحاكي فقط الجزء الخاص بمحفّز الإشراف كما في الكود الحقيقي (نفس user المستخدم دائمًا)، مع عدّاد استدعاءات لكشف أي حلقة
  vm.runInContext(`
    function renderApp(){
      renderAppCallCount++;
      const user = __testUser;
      ${renderAppTriggerSrc}
    }
  `, context);

  return context;
}

test('نجاح API: يحدث تحميل طبيعي واحد وتحديث renderApp مرة واحدة', async () => {
  const ctx = buildSandbox(async () => ({ ok: true, json: async () => ({ date: '2026-09-22', assigned: true }) }));
  ctx.renderApp();
  // ننتظر اكتمال الـpromise المُعلّق داخل .then(renderApp)
  await new Promise(r => setTimeout(r, 20));
  assert.equal(ctx.fetchCallCount, 1, 'يجب استدعاء fetch مرة واحدة فقط عند النجاح');
  assert.ok(ctx.__supervisionToday, 'يجب أن تُحمَّل بيانات الإشراف بنجاح');
  assert.equal(ctx.__supervisionTodayFailed, false);
});

for (const scenario of [
  { name: '401', fetchImpl: async () => ({ ok: false, status: 401 }) },
  { name: '403', fetchImpl: async () => ({ ok: false, status: 403 }) },
  { name: 'network error', fetchImpl: async () => { throw new Error('network failure'); } },
]) {
  test(`فشل API (${scenario.name}): لا حلقة renderApp لا نهائية ومحاولات محدودة`, async () => {
    const ctx = buildSandbox(scenario.fetchImpl);

    // نحاكي استدعاءات renderApp متكررة (كما لو أن كل تحديث DOM يستدعيها) للتأكد من عدم الانفلات
    for (let i = 0; i < 10; i++) {
      ctx.renderApp();
      await new Promise(r => setTimeout(r, 5));
    }
    // انتظار إضافي للتأكد من استقرار كل الـpromises المعلّقة
    await new Promise(r => setTimeout(r, 30));

    assert.equal(ctx.__supervisionToday, null, 'يجب أن تبقى بيانات الإشراف فارغة عند الفشل');
    assert.equal(ctx.__supervisionTodayFailed, true, 'يجب تعليم حالة الفشل');
    assert.ok(
      ctx.fetchCallCount <= 3,
      `يجب ألا تتجاوز محاولات fetch الحد الأقصى (كانت ${ctx.fetchCallCount})`
    );
    assert.equal(
      ctx.__supervisionTodayAttempts <= 3,
      true,
      'عدّاد المحاولات يجب ألا يتجاوز SUPERVISION_MAX_ATTEMPTS'
    );
    // 401/403 = رفض صلاحية من الخادم (يجب أن يُعرض سبب واضح لا تعليق «جار تحميل»)، أما خطأ الشبكة فليس رفض صلاحية
    if (scenario.name === '401' || scenario.name === '403') {
      assert.equal(ctx.__supervisionTodayDenied, true, `يجب تعليم حالة الرفض عند ${scenario.name}`);
    } else {
      assert.equal(ctx.__supervisionTodayDenied, false, 'خطأ الشبكة لا يُعد رفض صلاحية');
    }
  });
}
