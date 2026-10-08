'use strict';

// يثبت هذا الاختبار السلوك الفعلي لواجهة إدارة الإشراف اليومي الجديدة (زر "+ إضافة مشرف"
// لكل يوم بدل عرض جميع المعلمين دفعة واحدة، مع القدرة على حذف معلم من اليوم وحفظ الجدول).
// نستخرج الكود الحقيقي من public/index.html (وليس نسخة عنه) ونشغّله في vm مع DOM ووfetch مُحاكيين.

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

function extractArrayLiteral(src, marker) {
  const startIdx = src.indexOf(marker);
  if (startIdx === -1) throw new Error(`array not found in index.html: ${marker}`);
  const bracketStart = src.indexOf('[', startIdx);
  let depth = 0;
  let end = bracketStart;
  for (; end < src.length; end++) {
    if (src[end] === '[') depth++;
    else if (src[end] === ']') {
      depth--;
      if (depth === 0) { end++; break; }
    }
  }
  return src.slice(bracketStart, end);
}

function buildSandbox({ fetchImpl, checkedIdsByDay = {} } = {}) {
  const src = fs.readFileSync(INDEX_HTML_PATH, 'utf8');

  const ensureDraftSrc = extractFunctionSource(src, 'function __ensureSupervisionDraft(){');
  const togglePickerSrc = extractFunctionSource(src, 'function __supervisionToggleAddPicker(dow){');
  const addSelectedSrc = extractFunctionSource(src, 'function __supervisionAddSelected(dow){');
  const removeTeacherSrc = extractFunctionSource(src, 'function __supervisionRemoveTeacher(dow, teacherId){');
  const saveScheduleSrc = extractFunctionSource(src, 'async function __saveSupervisionSchedule(){');
  const supervisionDaysSrc = extractArrayLiteral(src, 'const SUPERVISION_DAYS = [');

  const fakeDocument = {
    querySelectorAll(selector) {
      const m = selector.match(/data-supervision-picker="(\d+)"/);
      const dow = m ? Number(m[1]) : null;
      const ids = checkedIdsByDay[dow] || [];
      return ids.map(id => ({ value: id }));
    },
  };

  const context = {
    __supervisionSchedule: null,
    __supervisionDraftSchedule: null,
    __supervisionAddOpenDay: null,
    renderAppCallCount: 0,
    renderApp: null,
    document: fakeDocument,
    currentUser: () => ({ role: 'ADMIN' }),
    getActiveSchool: () => 'BOYS',
    SUPERVISION_API: '/api/supervision/',
    fetch: null,
    fetchCallCount: 0,
    alert: () => {},
    console,
  };
  vm.createContext(context);
  context.fetch = (...args) => { context.fetchCallCount++; return fetchImpl(...args); };
  context.renderApp = () => { context.renderAppCallCount++; };

  vm.runInContext(`const SUPERVISION_DAYS = ${supervisionDaysSrc};`, context);
  vm.runInContext(ensureDraftSrc, context);
  vm.runInContext(togglePickerSrc, context);
  vm.runInContext(addSelectedSrc, context);
  vm.runInContext(removeTeacherSrc, context);
  vm.runInContext(saveScheduleSrc, context);

  return context;
}

test('إضافة معلم ليوم عبر __supervisionAddSelected تضيفها إلى مسودة ذلك اليوم فقط', () => {
  const ctx = buildSandbox({
    fetchImpl: async () => ({ ok: true, json: async () => ({ schedule: [] }) }),
    checkedIdsByDay: { 1: ['teacher-1', 'teacher-2'] },
  });
  ctx.__supervisionSchedule = { schedule: [] };
  ctx.__supervisionToggleAddPicker(1);
  assert.equal(ctx.__supervisionAddOpenDay, 1, 'يجب فتح قائمة الإضافة لليوم 1');

  ctx.__supervisionAddSelected(1);
  assert.deepEqual([...ctx.__supervisionDraftSchedule[1]].sort(), ['teacher-1', 'teacher-2']);
  assert.equal(ctx.__supervisionDraftSchedule[2].size, 0, 'يجب ألا تتأثر الأيام الأخرى');
  assert.equal(ctx.__supervisionAddOpenDay, null, 'يجب إغلاق قائمة الإضافة بعد الإضافة');
});

test('حذف معلم من يوم عبر __supervisionRemoveTeacher يزيلها من ذلك اليوم فقط', () => {
  const ctx = buildSandbox({ fetchImpl: async () => ({ ok: true, json: async () => ({ schedule: [] }) }) });
  ctx.__supervisionSchedule = {
    schedule: [
      { dayOfWeek: 1, teacherId: 'teacher-1' },
      { dayOfWeek: 1, teacherId: 'teacher-2' },
      { dayOfWeek: 2, teacherId: 'teacher-1' },
    ],
  };
  ctx.__ensureSupervisionDraft();
  ctx.__supervisionRemoveTeacher(1, 'teacher-1');
  assert.deepEqual([...ctx.__supervisionDraftSchedule[1]], ['teacher-2']);
  assert.deepEqual([...ctx.__supervisionDraftSchedule[2]], ['teacher-1'], 'اليوم الثلاثاء يجب ألا يتأثر');
});

test('الحفظ يرسل payload بصيغة {dayOfWeek, teacherId} المتوافقة مع API الحالي فقط', async () => {
  let sentBody = null;
  const ctx = buildSandbox({
    fetchImpl: async (url, opts) => {
      sentBody = JSON.parse(opts.body);
      return { ok: true, json: async () => ({ schedule: sentBody.schedule }) };
    },
  });
  ctx.__supervisionSchedule = {
    schedule: [
      { dayOfWeek: 1, teacherId: 'teacher-1' },
      { dayOfWeek: 3, teacherId: 'teacher-3' },
    ],
  };
  ctx.__ensureSupervisionDraft();
  ctx.__supervisionRemoveTeacher(1, 'teacher-1'); // إزالة قبل الحفظ لإثبات أن المسودة (لا القيمة القديمة) هي المصدر
  await ctx.__saveSupervisionSchedule();

  assert.ok(sentBody, 'يجب إرسال طلب PUT');
  assert.equal(sentBody.school, 'BOYS');
  assert.deepEqual(
    sentBody.schedule.sort((a, b) => a.dayOfWeek - b.dayOfWeek),
    [{ dayOfWeek: 3, teacherId: 'teacher-3' }],
    'يجب أن يعكس الحفظ حالة المسودة الحالية فقط (بعد الحذف) وبنفس صيغة API الحالية'
  );
  assert.equal(ctx.__supervisionDraftSchedule, null, 'يجب تصفير المسودة بعد نجاح الحفظ لإعادة بنائها من نسخة الخادم');
});

test('فشل الحفظ لا يصفّر المسودة (تبقى تعديلات المدير غير المحفوظة ظاهرة)', async () => {
  const ctx = buildSandbox({ fetchImpl: async () => ({ ok: false }) });
  ctx.__supervisionSchedule = { schedule: [{ dayOfWeek: 1, teacherId: 'teacher-1' }] };
  ctx.__ensureSupervisionDraft();
  await ctx.__saveSupervisionSchedule();
  assert.notEqual(ctx.__supervisionDraftSchedule, null, 'يجب الإبقاء على المسودة عند فشل الحفظ');
  assert.deepEqual([...ctx.__supervisionDraftSchedule[1]], ['teacher-1']);
});
