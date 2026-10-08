'use strict';
/* =============================================================================
 * إشعار تحويل الطالب — المستلِم من جدول الحسابات لا من ذاكرة الجهاز
 *
 * العطل: تحويل إلى «المدير» يظهر في قائمة التحويلات (لأن التحويلات تُزامَن)
 * ولا يصل إشعار. السبب أن notifyTransferReceivers كان يقرأ قائمة المستخدمين
 * الموجودة على الجهاز، وحساب المدير المُنشأ بالتهيئة يعيش في جدول users ولا
 * تُنسخ نسخته إلى school_data.users إلا عند إنشائه من شاشة المستخدمين — فلم
 * يطابق أحد، ولم يُكتب إشعار واحد.
 *
 * الاختبار يثبّت: (أ) أن الخادم يجد المستلِم من db.listUsers، (ب) أن
 * addTransfer يستدعي المسار، (ج) أن منع التكرار بمعرّف التحويل موجود — مرة
 * واحدة مهما كرّر الجهازان الطلب.
 * ========================================================================== */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const SERVER_SRC = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const CLIENT_SRC = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');

function route(pathname) {
  const i = SERVER_SRC.indexOf("'" + pathname + "'");
  assert.ok(i > 0, 'المسار غير موجود: ' + pathname);
  return SERVER_SRC.slice(i, i + 5000);
}

// ---------------------------------------------- 1) الخادم هو مصدر المستلِم
test('المسار يقرأ المستلِمين من جدول الحسابات (db.listUsers) لا من بيانات المدرسة', () => {
  const src = route('/api/transfer/notify');
  assert.ok(/requireAuth/.test(src), 'يتطلب جلسة');
  assert.ok(/schoolAccess/.test(src), 'يفحص صلاحية المدرسة');
  assert.ok(/db\.listUsers\(school\)/.test(src),
    'المستلِم يجب أن يأتي من جدول users (مصدر الحقيقة)، لا من data.users');
  // لا يجوز أن يعتمد على نسخة الجهاز التي سبّت العطل
  assert.ok(!/data\.users\.filter/.test(src) && !/d\.users\.filter/.test(src),
    'لا يقرأ قائمة المستخدمين من بيانات المدرسة');
  assert.ok(/mutateSchoolData/.test(src), 'يكتب عبر قفل صف داخل معاملة');
});

// ------------------------------------- 2) لا تضاعفة مهما تكرّر الطلب
test('منع التكرار بمعرّف التحويل + المستلِم (جهازان يطلبان ⇒ رسالة واحدة)', () => {
  const src = route('/api/transfer/notify');
  assert.ok(/msgs\.some\(m => m && m\.transferId/.test(src), 'يتحقّق من وجود رسالة لنفس التحويل للمستلِم');
  assert.ok(/changed: false/.test(src), 'ولا يكتب إن لم يُضف شيء');
  // المعرّف المبنيّ ثابت ⇒ نفس الرسالة نفسها لو وصل الطلب مرتين
  assert.ok(/'srv_'\s*\+\s*String\(transferId\)\s*\+\s*'_'\s*\+\s*rcv\.id/.test(src), 'معرّف رسالة مشتق');
});

// ------------------------- 3) الاستهداف بالدور لا بالاسم (لا تخمين)
test('يختار المستلِم بالدور النشط فقط، ويرفض الدفع بلا مستلِم', () => {
  const src = route('/api/transfer/notify');
  assert.ok(/u\.role/.test(src) && /u\.active/.test(src), 'فلترة بالدور وبالنشاط');
  assert.ok(/no_receivers/.test(src), 'يرفض بوضوح إن لم يوجد حساب نشط للدور');
});

// ------------------------------------------ 4) العميل يستدعي المسار
test('addTransfer يستدعي إشعار الخادم، والنسخة المحليةبقى وسيلة عمل', () => {
  const addStart = CLIENT_SRC.indexOf('function addTransfer()');
  assert.ok(addStart > 0);
  const addFn = CLIENT_SRC.slice(addStart, addStart + 2600);
  assert.ok(/NRC_notifyTransferServer\(/.test(addFn), 'المسار يُستدعى عند إنشاء التحويل');
  assert.ok(/notifyTransferReceivers\(/.test(addFn), 'النسخة المحلية تبقى (شبكة مقطوعة/وضع تجريبي)');

  const nStart = CLIENT_SRC.indexOf('async function NRC_notifyTransferServer');
  assert.ok(nStart > 0, 'الدالة موجودة');
  const nFn = CLIENT_SRC.slice(nStart, nStart + 1400);
  assert.ok(/__serverEnabled\(\)/.test(nFn), 'لا تعمل بلا خادم');
  assert.ok(/'\/api\/transfer\/notify'/.test(nFn), 'المسار الصحيح');
  for (const k of ['transferId', 'target', 'reason', 'studentName'])
    assert.ok(new RegExp(k).test(nFn), 'يرسل ' + k);
  // لا يكتب الرسائل بنفسه: صياغة النصّ والكتابة من الخادم وحده (لا سباق بين الأجهزة)
  assert.ok(!/saveAdminMsgs/.test(nFn), 'الكتابة من الخادم وحده (لا سباق بين الأجهزة)');
});

// --------------------------------- 5) دالة combos تُنفَّذ فعلاً من كود الإنتاج
// نُشغّل منطق الإضافة عند المستلِم من server.js على متغيرات حقيقية.
test('منطق إضافة الرسالة: يتخطّى المكرّر ويضيف الجديد', () => {
  const src = route('/api/transfer/notify');
  const start = src.indexOf('const r = await db.mutateSchoolData');
  assert.ok(start > 0);
  const open = src.indexOf('data => {', start);
  assert.ok(open > start, 'وُجد جسم المُدمِج');
  // قوس متوازن: أول '});' داخل الجسم هو نهاية msgs.push لا نهاية المُدمِج
  let depth = 0, end = -1;
  for (let k = src.indexOf('{', open); k < src.length; k++) {
    if (src[k] === '{') depth++;
    else if (src[k] === '}') { depth--; if (depth === 0) { end = k; break; } }
  }
  assert.ok(end > open, 'وُجد نهاية المُدمِج');
  const body = src.slice(src.indexOf('{', open) + 1, end);
const fn = vm.runInNewContext(
    '(function(req, data, transferId, receivers, text, sName){\n' + body + '\n})');

  const existing = { adminMsgs: [{ id: 'old', transferId: 'T1', teacherId: 'adm1' }] };
  const req = { session: { user_id: 't1', name: 'معلم' } };
  const receivers = [{ id: 'adm1', name: 'المدير' }, { id: 'adm2', name: 'وكيل' }];
  // الطلب الثاني على نفس التحويل: adm1 موجود مسبقاً، adm2 جديد فقط
  const out = fn(req, existing, 'T1', receivers, '📨 تحويل', 'ملاذ ناصر');
  assert.equal(out.changed, true, 'يكتب لأن adm2 جديد');
  assert.equal(out.value.added, 1, 'أضاف الرسالة الناقصة فقط');
  const ids = existing.adminMsgs.map(m => m.id);
  assert.equal(ids.length, 2, 'لا تكرار');
  assert.ok(ids.includes('srv_T1_adm2'));
  // الطلب الثالث: كل المستلِمين موجودون ⇒ لا كتابة إطلاقاً
  const again = fn(req, existing, 'T1', receivers, '📨 تحويل', 'ملاذ ناصر');
  assert.equal(again.changed, false, 'لا كتابة إن لم يتغيّر شيء');
  assert.equal(existing.adminMsgs.length, 2);
  // ورسالة المدير تحمل ما يحتاجه العرض: المستلِم والنصّ ومَن أرسل
  const m = existing.adminMsgs.find(x => x.transferId === 'T1' && x.teacherId === 'adm2');
  assert.equal(m.teacherName, 'وكيل');
  assert.equal(m.senderRole, 'TRANSFER');
  assert.equal(m.senderId, 't1');
  assert.equal(m.dismissed, false);
  assert.equal(m.read, false);
});
