'use strict';

// يثبت هذا الاختبار إصلاحَ «إلغاء الغياب الذي سجَّله معلمٌ بالخطأ» (نطاق att_cancel_fix):
// عند دمج سجلّي حضورٍ لنفس الطالب/اليوم، حضورٌ «أحدث زمناً» (تصحيحٌ صريح من صاحب التسجيل
// أو المدير/الوكيل المُخوَّل) يهزم غياباً «معلَّقاً» أقدمَ لم يُؤكَّده معلمٌ ثانٍ بعد — فيُحفَظ
// الإلغاءُ ولا تعود الطالبُ غائبةً بعد إعادة الفتح أو الدمج من جهازٍ آخر.
// نستخرج الدوال الحقيقية من public/index.html ونشغّلها مع vm (كما في باقي الاختبارات).

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const INDEX_HTML_PATH = path.join(__dirname, '..', 'public', 'index.html');

function extractFn(marker) {
  const src = fs.readFileSync(INDEX_HTML_PATH, 'utf8');
  const startIdx = src.indexOf('function ' + marker + '(');
  if (startIdx === -1) throw new Error('function not found in index.html: ' + marker);
  const openBrace = src.indexOf('{', startIdx);
  if (openBrace === -1) throw new Error('no body for: ' + marker);
  // نجد قوس الإغلاق المطابق باحتساب الأقواس المتداخلة داخل الجسم
  let depth = 0, i = openBrace;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) break; }
  }
  return src.slice(startIdx, i + 1);
}

function loadAttHelpers() {
  const src = fs.readFileSync(INDEX_HTML_PATH, 'utf8');
  const context = {
    console,
    Date,
    JSON,
    Array,
    Object,
    Math,
    Set,
    Map,
    __LEGACY_ABS: '_legacy_abs_entry_',
    LEGACY_ABS_SENTINEL: '__legacy_abs__',
  };
  vm.createContext(context);
  // الدوال المساعدة التي يعتمدها __attWinner
  for (const m of ['__attRealClerks', '__attPendingConfirm', '__attIsAbsent']) {
    vm.runInContext(extractFn(m), context);
  }
  const winnerSrc = extractFn('__attWinner');
  vm.runInContext(winnerSrc, context);
  return context;
}

function makeRec(id, status, absClerks, _t) {
  return { id, studentId: id, date: '2026-01-04', status, absClerks, _t };
}

test('حضورٌ أحدث زمناً يهزم غياباً «معلَّقاً» أقدم (إلغاء صريح من صاحب التسجيل)', () => {
  const ctx = loadAttHelpers();
  const pendingAbs = makeRec('s1', 'ABSENT', ['teacher-A'], 100);
  const explicitCancel = makeRec('s1', 'PRESENT', [], 200);
  const win = ctx.__attWinner(pendingAbs, explicitCancel);
  assert.equal(win.status, 'PRESENT', 'الحاضرُ الأحدث يجب أن يهزم الغيابَ المعلَّق الأقدم');
  assert.equal(win.id, 's1');
});

test('غيابٌ مؤكَّد (مؤكِّدان فعليان) يبقى يفوز على الحاضر مهما اختلف الزمن', () => {
  const ctx = loadAttHelpers();
  const confirmedAbs = makeRec('s2', 'ABSENT', ['teacher-A', 'teacher-B'], 500);
  const newerPresent = makeRec('s2', 'PRESENT', [], 900);
  const win = ctx.__attWinner(confirmedAbs, newerPresent);
  assert.equal(win.status, 'ABSENT', 'الغيابُ المؤكَّد لا يمحوه حضورٌ أعلى زمناً من معلمٍ آخر');
});

test('غيابٌ مؤكَّد لا يُلغى حتى بحضورٍ أحدث — الحماية تبقى سليمة', () => {
  const ctx = loadAttHelpers();
  const confirmedAbs = makeRec('s3', 'ABSENT', ['teacher-A', 'teacher-B'], 800);
  const check = ctx.__attPendingConfirm(confirmedAbs);
  assert.equal(check, false, 'الغيابُ المؤكَّد ليس «بانتظار معلم ثانٍ» فلا يُعدُّ قابلاً للإلغاء الصريح');
  const win = ctx.__attWinner(confirmedAbs, makeRec('s3', 'PRESENT', [], 999));
  assert.equal(win.status, 'ABSENT');
});

test('غيابُ معلَّق أقدم بلا حضورٍ أحدث يعود فيفوز الغائب', () => {
  const ctx = loadAttHelpers();
  const pendingAbs = makeRec('s4', 'ABSENT', ['teacher-A'], 300);
  const oldPresent = makeRec('s4', 'PRESENT', [], 100); // أقدم زمناً
  const win = ctx.__attWinner(pendingAbs, oldPresent);
  assert.equal(win.status, 'ABSENT', 'الغيابُ المعلَّق يبقى يفوز إذا لم يأتِ حضورٌ أحدث (إلغاء صريح) بعده');
});
