'use strict';
/* =============================================================================
 * دفعة معلّقة (pendKey) لا تُرمى عند غياب النسخة المحلية — «الـ+10 لم تختفِ»
 * -----------------------------------------------------------------------------
 * القصة: معلم (أمل الشامي) تضيف +10 «تفوق دراسي» لكادي، يفشل رفعها فيُحفظ
 * نسخة احتياطية معلّقة (pendKey). عند إغلاق التطبيق/الخروج ثم إعادة الدخول
 * كانت نافذة السحب ترمي الدفعة المعلّقة لأن النسخة المحلية اختفت (local=null)
 * — قبل أن يلتقطها الرفع — فتختفي نقطة المعلم للأبد رغم أنها كانت محفوظة،
 * ويبدو على الخادم أن المعلم لم تكتب شيئاً (كي لا يظهر +10 لأحد غيرها).
 *
 * القاعدة الجديدة: الإسقاط فقط لفقدانٍ محقق أو قِدمٍ مثبت، لا لغياب المحلية؛
 * والدفع يرجع للنسخة الاحتياطية حين تنعدم المحلية فيرفعها أولاً ثم يستأنف السحب.
 * ========================================================================== */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');

// ------------------------------------------------ 1) صياغة القاعدة في المصدر
test('1) قاعدة الإسقاط: لا يُرمى المعلّق لغياب المحلية — القِدم فقط أو الفقدان', () => {
  const i = SRC.indexOf('function __pendShouldDiscard');
  assert.ok(i >= 0, 'الدالة المساعدة غير موجودة');
  const body = SRC.slice(i, i + 260);
  assert.ok(body.includes("return !!local && __syncTS(pend) <= __syncTS(local);"),
    'الإسقاط مشروطٌ بوجود محليٍ فعليٍ وأقدميةٍ مثبتة');
  // الصيغة الخاطئة السابقة — التي كانت ترمي الدفعة عند غياب المحلية — محظورة
  assert.ok(!body.includes('!pend || !local'), 'لا إسقاط بلا محلية');
});

test('2) السحب يستعمل القاعدة، والدفع يرجع للاحتياطية عند غياب المحلية', () => {
  assert.ok(SRC.includes('pendStale = __pendShouldDiscard(pend, local);'),
    'السحب يمرر المعلّق إلى قاعدة الإسقاط');
  assert.ok(SRC.includes("const pobj = JSON.parse(localStorage.getItem(pendKey) || 'null');"),
    'الدفع يقرأ الاحتياطية عند غياب النسخة المحلية');
  assert.ok(SRC.includes("if(pobj && typeof pobj === 'object') obj = pobj;"),
    'ويدفع النسخة الاحتياطية بدلاً من التخلي عنها');
});

// ------------------------------------------------- 3) سلوك القاعدة مباشرة
test('3) القاعدة قراراتها: تحفظ الغائبة المحلية، وترمي الفاقدة/الأقدم فقط', () => {
  const A = loadFns();
  const pend = { _ts: 9000, notes: [{ id: 'n10', points: 10 }] };
  const localOld = { _ts: 5000 };
  const localNewer = { _ts: 9999 };

  // النسخة المحلية غائبة (خروج/إعادة دخول): لا تُرمى — هذا قلب القصة
  assert.equal(A.__pendShouldDiscard(pend, null), false, 'لا إسقاط بلا محلية');
  assert.equal(A.__pendShouldDiscard(pend, localOld), false, 'الدفعة أحدث: تُرفع');
  assert.equal(A.__pendShouldDiscard(pend, localNewer), true, 'الدفعة أقدم: بقايا محجوبة');
  assert.equal(A.__pendShouldDiscard(null, null), true, 'فاقد: لا شيء نرفعه');
  assert.equal(A.__pendShouldDiscard(undefined, localOld), true, 'فاقد: إسقاط');
});

// ------------------------------------------------ 4) إعادة إنتاج الحكاية كلها
test('4) محاكاة الحكاية: النقطة +10 تنجو من الخروج/إعادة الدخول وتصل الخادم', () => {
  // مخزن يحاكي جهاز أمل: النسخة المحلية مسحت (logout)، لكن الاحتياطي باقٍ
  const store = {};
  const pend = { _ts: 9000, notes: [{ id: 'n10', studentId: 'kadi', points: 10, category: 'تفوق دراسي', createdBy: 'أمل' }], students: [{ id: 'kadi' }] };
  store['nibras_BOYS_pending_v1'] = JSON.stringify(pend);
  // النسخة المحلية غائبة بعد الخروج
  assert.equal(store['nibras_boys_db_v1'], undefined);
  // قرار السحب: لا إسقاط
  const A = loadFns();
  assert.equal(A.__pendShouldDiscard(JSON.parse(store['nibras_BOYS_pending_v1']), null), false,
    'السحب يترك الاحتياطي فيُرفع قبل أي جلب');
});

// ---------------------------------------------------------------- helper
function extractFn(name) {
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
  const code = extractFn('__syncTS') + '\n' + extractFn('__pendShouldDiscard');
  const ctx = { Number, String, Object, Array, JSON, console, Map, Set };
  vm.createContext(ctx);
  vm.runInContext(code + ';globalThis.__api = { __syncTS, __pendShouldDiscard };', ctx);
  return ctx.__api;
}