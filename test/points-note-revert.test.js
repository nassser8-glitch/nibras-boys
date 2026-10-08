'use strict';
/* =============================================================================
 * علة «النقطة تُحسب ثم يعود الرصيد للقديم فوراً»:
 * المعلم تضيف ملاحظة موجبة (+10) فتصير -7 → +3، ثم تعود مباشرة -7 وكأن الملاحظة
 * لم تُسجَّل، قبل أن يحتسبها الخادم. السبب: أثناء دمج الدفع (__syncPush) تُستبدل
 * النسخة المحلية بنسخة الخادم (obj = sd) فتحلّ لقطة pointsTotals القديمة محل
 * تصحيح الجهاز المحلي (__adjustLocalPoints). الحل: ناقلُ أرصدةٍ محلية غير مرفوعة
 * يمرر التصحيح (adjustedAt) إلى لقطة الخادم لطلابٍ ملاحظاتهم لم تبلغ الخادم.
 * الاختبار يقرأ الوظائف المنشورة من index.html ويمثّل المسار حرفيُّاً.
 * ========================================================================== */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const HTML = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');

function extractFn(src, name) {
  const start = src.indexOf('function ' + name + '(');
  assert.ok(start >= 0, 'لم أجد function ' + name);
  const i = src.indexOf('{', start);
  assert.ok(i >= 0);
  let depth = 1;
  let j = i + 1;
  while (depth > 0 && j < src.length) {
    const c = src[j];
    if (c === '{') depth++;
    else if (c === '}') depth--;
    else if (c === '/' && src[j + 1] === '/') { while (j < src.length && src[j] !== '\n') j++; }
    else if (c === '"' || c === "'" || c === '`') { const q = c; j++; while (j < src.length && src[j] !== q) { if (src[j] === '\\') j++; j++; } }
    j++;
  }
  return src.slice(start, j);
}

const CLIENT = [
  extractFn(HTML, '__pointsUnsyncedStudents'),
  extractFn(HTML, '__carryLocalAdjustedPoints'),
  extractFn(HTML, 'NRC_mergeNotes'),
  'function NRC_noteBelongsToOther(){ return false; }',
].join('\n');
const CLIENT_FNS = new Function(CLIENT + '\n;return { __pointsUnsyncedStudents, __carryLocalAdjustedPoints, NRC_mergeNotes };')();
const { __pointsUnsyncedStudents, __carryLocalAdjustedPoints, NRC_mergeNotes } = CLIENT_FNS;

function note(over) {
  return Object.assign({
    id: 'n1', studentId: 'S1', studentNo: '10', studentName: 'كادي بنت سلمان',
    type: 'NEGATIVE', category: 'قلة الاحترام', points: -7, createdBy: 'T1',
    createdByName: 'أمل الشامي', createdAt: '2026-09-20T08:00:00.000Z',
  }, over || {});
}

test('ناقل المحلي غير المرفوع: ملاحظة جديدة على الجهاز فقط ⇒ طالبتها غير مرسلة', () => {
  const srv = [note()];
  const local = [note(), note({ id: 'n2', type: 'POSITIVE', category: 'تفوق دراسي', points: 10, createdAt: '2026-10-06T08:00:00.000Z' })];
  const unsync = __pointsUnsyncedStudents(srv, local);
  assert.deepEqual(Array.from(unsync), ['S1'], 'كادي لها ملاحظة +10 لم تبلغ الخادم');
});

test('نحن موجودة بالخادم ⇒ تُحتسب عنده، فلا نصوّب فوق حسابه', () => {
  const srv = [note(), note({ id: 'n2', type: 'POSITIVE', category: 'تفوق دراسي', points: 10 }), note({ id: 'n3', studentId: 'S9', points: -5 })];
  const local = srv.slice();
  const unsync = __pointsUnsyncedStudents(srv, local);
  assert.deepEqual(Array.from(unsync), [], 'كل الملاحظات مسجلة بالخادم — لا طالب غير مرسلة');
});

test('حذفٌ ناعم لم يبلغ الخادم بعد: طالبتها غير مرسلة (الخادم ما زال يُحتسبها)', () => {
  const srv = [note()];
  const local = [note({ deleted: true, deletedAt: 'x' })];
  assert.deepEqual(Array.from(__pointsUnsyncedStudents(srv, local)), ['S1']);
});

test('حذفٌ ناعم وصل للخادم: لا حاجة للناقل (نقطة الخادم محسوبة بلا النقطة)', () => {
  const srv = [note({ deleted: true })];
  const local = [note({ deleted: true })];
  assert.deepEqual(Array.from(__pointsUnsyncedStudents(srv, local)), []);
});

test('الناقل يمرر التصحيح المحلي (+3) مكان لقطة الخادم القديمة (-7)', () => {
  const target = { S1: { total: -7, pos: 0, neg: -7 }, S2: { total: 5, pos: 5, neg: 0 } };
  const local = { S1: { total: 3, pos: 10, neg: -7, adjustedAt: 12345 } };
  __carryLocalAdjustedPoints(target, local, new Set(['S1']));
  assert.equal(target.S1.total, 3, 'تصبح +3 لا -7');
  assert.equal(target.S1.pointsTotal, undefined);
  assert.equal(target.S2.total, 5, 'غير المتأثرة بقيمتها من الخادم');
});

test('الناقل لا يطمس قيمة الخادم حين لا تصحيح محلي لطالب (بلا adjustedAt)', () => {
  const target = { S1: { total: -7, pos: 0, neg: -7 } };
  const local = { S1: { total: -7, pos: 0, neg: -7 } };
  __carryLocalAdjustedPoints(target, local, new Set(['S1']));
  assert.equal(target.S1.adjustedAt, undefined);
  assert.equal(target.S1.total, -7);
});

test('من منتصف دمج الدفع حرفياً: نسخة الدمج تحتفظ بالتصحيح بعد obj = sd', () => {
  // ما قبل الإصلاح: obj=sd تستبدل d.pointsTotals بلقطة الخادم فيرتد الرصيد -7.
  // النسخة المدمجة (sd) مع الناقل يجب أن ترى +3 والملاحظة باقية في d.notes.
  const serverNotes = [note()];
  const localNotes = [note(), note({ id: 'n2', type: 'POSITIVE', category: 'تفوق دراسي', points: 10, createdAt: '2026-10-06T08:00:00.000Z' })];
  const serverPT = { S1: { total: -7, pos: 0, neg: -7 } };
  const localPT = JSON.parse(JSON.stringify(serverPT));
  localPT.S1 = { total: 3, pos: 10, neg: -7, adjustedAt: Date.now() };
  // الدمج: sd.notes = NRC_mergeNotes(sd.notes, obj.notes) ثم obj = sd ثم الناقل
  const sd = { notes: NRC_mergeNotes(serverNotes.slice(), localNotes), pointsTotals: JSON.parse(JSON.stringify(serverPT)) };
  sd.pointsTotals.S1 = JSON.parse(JSON.stringify(serverPT.S1));
  const unsync = __pointsUnsyncedStudents(serverNotes, localNotes);
  __carryLocalAdjustedPoints(sd.pointsTotals, localPT, unsync);
  assert.equal(sd.pointsTotals.S1.total, 3, 'الرصيد المدمج +3 لا يرتد إلى -7');
  assert.equal(sd.notes.some(n => n.id === 'n2' && !n.deleted), true, 'والملاحظة باقية في النسخة المدمجة');
});

test('بعد بلوغ الخادم: تبقى نسخته المرجع؛ وإن تغير عند زميلة يبقى هو', () => {
  const serverNotes = [note(), note({ id: 'n2', type: 'POSITIVE', category: 'تفوق دراسي', points: 10 })];
  const localNotes = serverNotes.slice();
  const serverPT = { S1: { total: 5, pos: 10, neg: -5 } };  // أضافت زميلة +2 بعد احتساب النقطة
  const localPT = { S1: { total: 3, pos: 10, neg: -7 } };
  const unsync = __pointsUnsyncedStudents(serverNotes, localNotes);
  assert.deepEqual(Array.from(unsync), []);
  __carryLocalAdjustedPoints(serverPT, localPT, unsync);
  assert.equal(serverPT.S1.total, 5, 'نسخة الخادم (باحتساب الزميلة) هي المرجع');
});

test('الملف سليم من حروف خارج العربية', () => {
  const added = [];
  const lines = HTML.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes('__pointsUnsyncedStudents') || lines[i].includes('__carryLocalAdjustedPoints') || lines[i].includes('adjustedAt')) added.push(lines[i]);
  }
  const words = [...new Set((added.join('\n').match(/[a-zA-Z]{2,}/g) || []))];
  const codeTokens = new Set([
    'adjustedAt', 'unsync', 'unsyncP', 'unsynced', 'locNotesCarry', 'locPTCarry', 'srvNotes', 'localNotes',
    'targetPT', 'localPT', 'pointsTotals', 'pointsUnsyncedStudents', 'carryLocalAdjustedPoints', 'NRC', 'sd', 'mj', 'obj', 'sid', 'lr', 'sr',
    'total', 'pos', 'neg', 'Date', 'now', 'server', 'local', 'merged', 'Array', 'isArray',
    'object', 'number', 'const', 'function', 'typeof', 'continue', 'return', 'if', 'for',
    'new', 'Set', 'JSON', 'parse', 'stringify', 'Object', 'keys', 'true', 'false', 'in',
    'data', 'notes', 'has', 'get', 'some', 'map', 'filter', 'push', 'length', 'slice',
    'join', 'includes', 'String', 'Number', 'Math',
  ]);
  const foreign = words.filter(w => !codeTokens.has(w));
  assert.deepEqual(foreign, [], 'لا كلمات أجنبية متسربة في الأسطر المضاف');
});