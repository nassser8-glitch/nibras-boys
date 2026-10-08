'use strict';
/* =============================================================================
 * زر «أعد الرفع الآن» + عدّاد النقاط التي لم ترفع بعد للخادم
 * -----------------------------------------------------------------------------
 * القصة: كانت المعلم تكتشف أن نقطةً كتبتها «اختفت» بعد حين، لأنها لم تصل
 * للخادم قط ولم يكن أمامها أي طريقة لترى أن شيئاً ما محجوزٌ على جهازها.
 * الحل: سجلّ لكل جهاز يحوي معرّفات الملاحظات المحفوظة محلياً ولم يبلغ رفعها
 * الناجحُ الخادمَ بعد — يُملأ عند كل حفظ، ويُفرَّغ عند كل رفع ناجح — وتلويحة
 * أعلى صفحة الملاحظات تعرض العدد والمجموع وزر «أعد الرفع الآن» للرفع الفوري.
 * ========================================================================== */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');

// ------------------------------------------------ 1) وجود كل أجزاء الواجهة
test('1) تلويحة الحالة وزر «أعد الرفع الآن» موجودان في صفحة الملاحظات', () => {
  assert.ok(SRC.includes('id="unpushedBar"'), 'عنصر التلويحة مفقود');
  assert.ok(SRC.includes('id="unpushedRetryBtn"'), 'زر الرفع مفقود');
  assert.ok(SRC.includes('onclick="__forceSyncNow()"'), 'الزر لا يستدعي الرفع الفوري');
  assert.ok(SRC.includes('id="unpushedText"'), 'نص العدّاد مفقود');
  assert.ok(SRC.includes('setTimeout(__refreshUnpushedBar, 0);'),
    'تلويحة الحالة لا تُحدَّث بعد رسم الصفحة');
});

// ------------------------------------------- 2) الحياكة: حفظ يُسجّل، والرفع يفرّغ
test('2) حفظ الملاحظة يسجّلها، والرفع الناجح يفرّغ السجل', () => {
  assert.ok(SRC.includes('__markNotesUnpushed(getActiveSchool(), savedIds);'),
    'الحفظ لا يُسجّل الملاحظة في سجلّ المعلّق');
  assert.ok(SRC.includes('try{ __clearUnpushed(school); }catch(e){}'),
    'الرفع الناجح لا يفرّغ السجل');
  const i = SRC.indexOf('try{ __clearUnpushed(school); }catch(e){}');
  const ctx = SRC.slice(Math.max(0, i - 260), i + 120);
  assert.ok(ctx.includes('localStorage.removeItem(pendKey)'),
    'الفراغ يقع بعد نجاح الرفع (إزالة النسخة المعلّقة) — لا قبلها');
});

// ------------------------------- 3) سلوك السجل: إضافة/تكرار/قراءة/تفريغ (منطق خالص)
test('3) السجل يسجّل ويمنع التكرار ويقرأ ما لم تُرفع ويُفرَّغ عبر الدوال', () => {
  const A = loadFns();
  const store = {};
  const g = (k) => store[k], s = (k, v) => { store[k] = v; }, r = (k) => { delete store[k]; };
  const L = {
    localStorage: {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => { s(k, String(v)); },
      removeItem: (k) => { r(k); }
    },
    Set, Array, JSON
  };
  vm.createContext(L);
  vm.runInContext(A.code + ';globalThis.A={ __unpushedKey, __unpushedIds, __markNotesUnpushed, __clearUnpushed };', L);
  const U = L.A;

  assert.equal(U.__unpushedIds('BOYS').length, 0, 'فارغ في البداية (لا شيء بانتظار الرفع)');
  U.__markNotesUnpushed('BOYS', ['n1', 'n2', 'n1']);
  assert.deepEqual(U.__unpushedIds('BOYS').sort(), ['n1', 'n2'], 'يسجّل ويمنع التكرار');
  U.__markNotesUnpushed('BOYS', ['n3']);
  assert.equal(U.__unpushedIds('BOYS').length, 3, 'يتراكم عبر الحفظات');

  // كل قسم بمفتاحه؛ في نظام البنين لا يوجد سوى BOYS، فمفاتيح غيره تبقى صفراً
  assert.equal(U.__unpushedIds('MIXED').length, 0, 'لا خلط بين مفاتيح الأقسام');

  // قراءة قيم فاسدة = سجل نظيف
  store['nibras_BOYS_unpushed_v1'] = 'not-json';
  assert.deepEqual(U.__unpushedIds('BOYS'), [], 'قيمة فاسدة تُعامل كسجل فارغ');

  // التفريغ عند رفع ناجح
  U.__clearUnpushed('BOYS');
  assert.equal(U.__unpushedIds('BOYS').length, 0, 'التفريغ يمحو المعلّق بعد الرفع الناجح');
});

// -------------------- 4) زر الرفع: رفعٌ فوري ونتيجة صريحة قبل/بعد التأكيد
test('4) الرفع الفوري يدفع مباشرة ويعيد التقييم بالنتيجة (معلّق/مفرَّغ)', () => {
  // حتى لا يعود الزر بلا فائدة إن كان رفعٌ جارٍ: ينتظر انتهاءه قبل الدفع
  assert.ok(SRC.includes('if(!__pushState(school).running) break;'),
    'الزر ينتظر انتهاء الرفع الجاري وليس يلهيه');
  assert.ok(SRC.includes('await __syncPush(school);'),
    'الزر يدفع فوراً');
  assert.ok(SRC.includes("'✅ رُفعت كل نقاطك للخادم بنجاح"),
    'النتيجة الصريحة للمعلم عند النفاد');
  assert.ok(SRC.includes("'⚠️ ما زالت ' + left + ' نقطة تنتظر الرفع"),
    'النتيجة الصريحة عند بقاء معلّق');
});

// --------------------------- 5) تحذير عند فتح التطبيق (على أي صفحة): مرة واحدة
test('5) تحذير الفتح: يُستدعى عند كل رسم، مرةً واحدة، وللمعلم لا للتلميذة', () => {
  assert.ok(SRC.includes('setTimeout(__warnPendingOnOpen, 0);'),
    'التحذير يُجدول عند رسم أي صفحة'); 
  const i = SRC.indexOf('function __warnPendingOnOpen');
  assert.ok(i >= 0, 'الدالة مفقودة');
  const body = SRC.slice(i, i + 1200);
  assert.ok(body.includes("if(__warnedPendingOnOpen) return;"),
    'مرة واحدة لكل فتح صفحة لا إزعاج متكرر');
  assert.ok(body.includes("me.role === 'STUDENT'"),
    'لا يُحذّر التلميذة');
  assert.ok(body.includes("'{+pts}لم تصل لخادم المدرسة بعد")
    || body.includes('لم تصل لخادم المدرسة بعد'),
    'رسالة صريحة بعدد النقاط');
});

// ---------------------------------------------------------------- helper
function extractFns(name) {
  const start = SRC.indexOf('function ' + name + '(');
  assert.ok(start >= 0, 'لم أجد ' + name);
  const open = SRC.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < SRC.length; i++) {
    const ch = SRC[i];
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) return SRC.slice(start, i + 1); }
  }
  throw new Error('لم يُغلق جسم ' + name);
}
function loadFns() {
  const code = [
    extractFns('__unpushedKey'),
    extractFns('__unpushedIds'),
    extractFns('__markNotesUnpushed'),
    extractFns('__clearUnpushed')
  ].join('\n');
  return { code };
}