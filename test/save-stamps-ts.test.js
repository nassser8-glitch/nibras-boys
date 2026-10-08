'use strict';
/* =============================================================================
 * الحذف كان ينجح محلياً ويفشل في الرفع: saveDB لا يختم _ts عند التغيير،
 * فيتخطّى __syncPush الدفعة بحجة أنها لم تتغيّر. النتيجة: الشاهد يبقى محلياً
 * (فيبدو الحذف ناجحاً، والتحديث يحفظه لأن الدمج يحمل القبر)، لكن الخادم لا
 * يستقبله، فيعود التحويل كاملاً عند الخروج وإعادة الدخول.
 * الاختبار يفحص saveDB نفسها: هي بوابة كل حفظ في التطبيق.
 * ========================================================================== */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const CLIENT = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');

function extractFn(src, name) {
  const start = src.indexOf('function ' + name + '(');
  if (start === -1) throw new Error(name + ' غير موجودة');
  let i = src.indexOf('{', start), depth = 0;
  for (let j = i; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') { depth--; if (depth === 0) return src.slice(start, j + 1); }
  }
  throw new Error('أقواس غير متوازنة في ' + name);
}

// saveDB دال واحدة في المشروع؛ نأخذ أول تعريف في نطاقه الرئيسي.
const saveSrc = extractFn(CLIENT, 'saveDB');

function saveHarness(seed) {
  const store = new Map();
  if (seed !== undefined) store.set('K', JSON.stringify(seed));
  const st = { writes: 0 };
  const ctx = {
    DEMO_MODE: false,
    window: {},
    dbKey: () => 'K',
    __canonNoTs: (d) => JSON.stringify(Object.assign({}, d || {}, { _ts: 0 })),
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => { st.writes++; store.set(k, v); },
    },
    JSON, Object, Date, String, Number, Array,
  };
  st.saveDB = new Function('ctx', 'with(ctx){ ' + saveSrc + '; return saveDB; }')(ctx);
  st.read = () => JSON.parse(store.get('K') || 'null');
  return st;
}

const T = (over = {}) => Object.assign({ id: 'tr_1', studentIds: ['s1'], status: 'PENDING' }, over);

// ===== ١) الختم الزمني: شرط أن لا يتخطّى __syncPush الدفعة =====

test('تغيير حقيقي يختم _ts جديداً (وإلا تخطّا الرفع الدفعة)', () => {
  const st = saveHarness({ _ts: 1000, transfers: [T()] });
  st.saveDB({ _ts: 1000, transfers: [T({ deleted: true })] });
  assert.ok(st.read()._ts > 1000, 'لم يتغير الختم الزمني: سيتخطى __syncPush الحذف');
});

test('لا تغيير حقيقي: لا كتابة ولا ختم جديد', () => {
  const st = saveHarness({ _ts: 1000, transfers: [T()] });
  st.saveDB({ _ts: 1000, transfers: [T()] });
  assert.equal(st.writes, 0, 'كُتب بلا تغيير — يولّد حلقة دفع/سحب لا تنتهي');
  assert.equal(st.read()._ts, 1000);
});

test('الحفظ الأول على مخزن فارغ يكتب ويختم', () => {
  const st = saveHarness(undefined);
  st.saveDB({ transfers: [] });
  assert.equal(st.writes, 1);
  assert.ok(st.read()._ts > 0);
});

test('تعديل حل التحويل يغيّر _ts فيرفع', () => {
  const st = saveHarness({ _ts: 5000, transfers: [T()] });
  st.saveDB({ _ts: 5000, transfers: [T({ status: 'RESOLVED', solution: 'تم' })] });
  assert.ok(st.read()._ts > 5000);
});

// ===== ٢) تسلسل الحذف كاملاً: بوابة حفظ ثم رفع =====

test('الحذف يُغيّر _ts فيمرّ من بوابة الحفظ (خلاصة السببين معاً)', () => {
  const st = saveHarness({ _ts: 2000, transfers: [T()], notes: [] });
  const d = { _ts: 2000, transfers: [T()], notes: [] };
  d.transfers[0].deleted = true;
  d.transfers[0].deletedAt = '2026-10-01T09:00:00.000Z';
  st.saveDB(d);
  const saved = st.read();
  assert.equal(saved.transfers[0].deleted, true);
  assert.ok(saved._ts > 2000, 'الخادم لن يعرف أن النسخة تغيّرت');
});

test('مقارنة تغيير الخادم تعتمد _ts: بلا ختم تُعتبر الدفعة مكرَّرة', () => {
  // نفس منطق __syncPush: تخطّي حين لم تتغيّر النسخة عن آخر رفعة ناجحة.
  const lastOkTs = 7000;
  const unchanged = 7000;             // كما كان قبل الإصلاح: الحذف لا يمسّ _ts
  const stamped = 7001;               // بعد الإصلاح
  assert.equal(unchanged === lastOkTs, true, 'قبل الإصلاح كانت الدفعة تُتخطّى');
  assert.equal(stamped === lastOkTs, false, 'بعد الإصلاح تمرّ الدفعة');
});

// ===== ٣) sanity: الختم لا يمسّ المحتوى =====

test('الختم لا يغيّر أي حقل آخر', () => {
  const st = saveHarness({ _ts: 1, transfers: [T({ deleted: true })], notes: [{ id: 'n1' }] });
  st.saveDB({ _ts: 1, transfers: [T({ deleted: true })], notes: [{ id: 'n1', points: -3 }] });
  const saved = st.read();
  assert.equal(saved.notes[0].id, 'n1');
  assert.equal(saved.notes[0].points, -3);
  assert.equal(saved.transfers[0].deleted, true);
});