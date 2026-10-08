// اختبار لبطاقات إشعارات المدير: «تم الاطلاع» يجب أن يُخفي الإشعار فعلاً.
// العلّة التي عالجها: dismissAdminMsg كان يسجّل clearedBy/read فقط،
// وفرع المدير في combinedMsgs لا يكتفي بـ !m.dismissed — فلا يختفي الإشعار.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

// من بداية دالة loadAdminMsgs إلى نهاية revealAdminMsg
const block = (() => {
  const a = src.indexOf('function loadAdminMsgs()');
  const b = src.indexOf('function revealAdminMsg', a);
  assert.ok(a !== -1 && b > a, 'كتلة رسائل المدير غير موجودة');
  const c = src.indexOf('\n}', src.indexOf('function revealAdminMsg', a));
  assert.ok(c > b, 'نهاية revealAdminMsg غير موجودة');
  return src.slice(a, c + 2);
})();

// دالة العرض نفسه (تعتمد على adminMsgsFor وcombinedMsgs الداخلي)
const renderBlock = (() => {
  const a = src.indexOf('function renderAdminMsgAlerts()');
  const b = src.indexOf('/* ============ لوحة', a);
  assert.ok(a !== -1 && b > a, 'كتلة العرض غير موجودة');
  return src.slice(a, b);
})();

// شرط ظهور إشعار التحويل للمدير (دالة مستقلة في أعلى الملف)
const seesBlock = (() => {
  const a = src.indexOf('function adminSeesTransferMsg(');
  const b = src.indexOf('\n}', a);
  assert.ok(a !== -1 && b > a, 'دالة adminSeesTransferMsg غير موجودة');
  return src.slice(a, b + 2);
})();

const ADMIN = { id: 'A1', name: 'مديرة المدرسة', role: 'ADMIN' };
const AGENT = { id: 'G1', name: 'الوكيل', role: 'AGENT' };
const TEACHER = { id: 'T1', name: 'معلم', role: 'TEACHER' };

function makeEnv(user, db){
  const store = JSON.parse(JSON.stringify(db));
  const saved = [];
  const ctx = {
    console, Date, Math, JSON, Object, Array, Set, Map, Number, String,
    uid: (() => { let n = 0; return () => 'id' + (++n); })(),
    currentUser: () => user,
    getActiveSchool: () => 'BOYS',
    loadSchoolDB: () => store,
    saveDB: () => {},
    localStorage: { getItem: () => null, setItem: () => {} },
    __serverEnabled: () => false,
    __syncSchedule: () => {},
    renderApp: () => {},
    startMsgBeepLoop: () => {},
    tl: (s) => s,
    escapeHtml: (v) => String(v == null ? '' : v).replace(/[&<>"']/g, ch => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[ch])),
    fmtTime: () => 'الآن',
    targetLabels: { COUNSELOR: 'الموجه', AGENT: 'الوكيل' },
    ADMIN_MSGS_KEY: () => 'k',
    __persistMsgs: (school, arr) => { store.adminMsgs = arr; saved.push(arr.length); },
  };
  vm.createContext(ctx);
  ctx.window = ctx;
  vm.runInContext(seesBlock + '\n' + block + '\n' + renderBlock + '\n;globalThis.__render = renderAdminMsgAlerts;', ctx);
  return { ctx, store, saved };
}

function transferMsg(over = {}){
  return Object.assign({
    id: 'srv_t1_' + AGENT.id,
    teacherId: AGENT.id,
    teacherName: AGENT.name,
    text: 'تحويل الطلاب: ملاذ ناصر — إلى: الوكيل — السبب: الغياب المتكرر',
    createdAt: '2026-10-02T20:15:00.000Z',
    read: false, dismissed: false, views: 0,
    senderRole: 'TRANSFER', senderName: 'معلم', senderId: TEACHER.id,
    transferId: 't1', studentName: 'ملاذ ناصر',
  }, over);
}

test('رسالة التحويل تظهر للوكيل قبل الاطلاع (بمحتوى مخفي حتى الكشف)', () => {
  const { ctx } = makeEnv(AGENT, { users: [ADMIN, AGENT, TEACHER], adminMsgs: [transferMsg()], transfers: [] });
  const html = ctx.__render();
  assert.ok(html.includes('إشعار تحويل'), 'عنوان الإشعار غير ظاهر');
  assert.ok(html.includes('محتوى مخفي'), 'بطاقة الإشعار غير موجودة (كان يُفترض أنها مخفية المحتوى)');
});

test('كشف المحتوى يُسقط البطاقة أيضاً (سلوك موجود)', () => {
  const { ctx } = makeEnv(AGENT, { users: [ADMIN, AGENT, TEACHER], adminMsgs: [transferMsg()], transfers: [] });
  assert.ok(ctx.__render().includes('محتوى مخفي'));
  ctx.revealAdminMsg('srv_t1_' + AGENT.id);
  assert.strictEqual(ctx.__render(), '', 'الكشف لم يُسقط البطاقة');
});

test('«تم الاطلاع» يُخفي الإشعار عن الوكالة', () => {
  const { ctx } = makeEnv(AGENT, { users: [ADMIN, AGENT, TEACHER], adminMsgs: [transferMsg()], transfers: [] });
  assert.ok(ctx.__render().includes('إشعار تحويل'));
  ctx.dismissAdminMsg('srv_t1_' + AGENT.id);
  assert.strictEqual(ctx.__render(), '', 'الإشعار بقي معروضاً بعد الاطلاع');
});

test('«تم الاطلاع» يُخفي الإشعار عن المدير أيضاً (العلّة المُصلَحة)', () => {
  const { ctx } = makeEnv(ADMIN, { users: [ADMIN, AGENT, TEACHER], adminMsgs: [transferMsg()], transfers: [] });
  assert.ok(ctx.__render().includes('تحويل الطلاب'), 'الإشعار لم يظهر للمدير أصلاً');
  ctx.dismissAdminMsg('srv_t1_' + AGENT.id);
  assert.strictEqual(ctx.__render(), '', 'الإشعار بقي على شاشة المدير بعد الضغط على «تم الاطلاع»');
});

test('المدير يرى إشعار تحويل موجّهاً للوكيل (لم يعد محجوباً عنه)', () => {
  const msg = transferMsg();
  const { ctx } = makeEnv(ADMIN, { users: [ADMIN, AGENT, TEACHER], adminMsgs: [msg], transfers: [] });
  assert.ok(ctx.__render().includes('إلى: الوكيل'), 'إشعار التحويل إلى الوكيل مخفي عن المدير');
});

test('الإشعار يبقى معروضاً للمدير حتى لو لم يعد التحويل موجوداً في القاعدة', () => {
  const { ctx } = makeEnv(ADMIN, { users: [ADMIN, AGENT, TEACHER], adminMsgs: [transferMsg()], transfers: [] });
  assert.ok(ctx.__render().includes('تحويل الطلاب'), 'اختفى الإشعار لمجرد أن التحويل لم يُوجد');
});

test('نسختان من الإشعار نفس المصدر تختفيان معاً بضغط واحد', () => {
  const local = transferMsg({ id: 'local1', teacherId: AGENT.id });
  const srv = transferMsg({ id: 'srv_t1_' + AGENT.id, teacherId: AGENT.id });
  const { ctx, store } = makeEnv(AGENT, { users: [ADMIN, AGENT, TEACHER], adminMsgs: [local, srv], transfers: [] });
  ctx.dismissAdminMsg('local1');
  assert.strictEqual(ctx.__render(), '', 'بقيت نسخة من الإشعار بعد الاطلاع');
  assert.ok(store.adminMsgs.every(m => m.dismissed === true), 'النسخ لم تُوسم dismissed معاً');
});

test('رسالة عامة للوكيل تُغلق بزر «تم الاطلاع» أيضاً', () => {
  const msg = { id: 'm9', teacherId: AGENT.id, teacherName: AGENT.name, text: 'رسالة عامة', createdAt: '2026-10-02T19:00:00.000Z', read: false, dismissed: false, senderRole: 'AGENT', senderName: 'مديرة', senderId: ADMIN.id };
  const { ctx, store } = makeEnv(AGENT, { users: [ADMIN, AGENT, TEACHER], adminMsgs: [msg], transfers: [] });
  assert.ok(ctx.__render().includes('إشعار تحويل') === false, 'رسالة عامة لا يصح أن تُوسم كإشعار تحويل');
  assert.ok(ctx.__render().length > 0, 'بطاقة الرسالة العامة غير معروضة');
  ctx.dismissAdminMsg('m9');
  assert.strictEqual(ctx.__render(), '', 'الرسالة العامة بقيت بعد الضغط على الزر');
  assert.strictEqual(store.adminMsgs[0].dismissed, true, 'لم تُوسم الرسالة dismissed');
});

test('الشارة لا تكرّر كلمة «تحويل» في العنوان', () => {
  const { ctx } = makeEnv(ADMIN, { users: [ADMIN, AGENT, TEACHER], adminMsgs: [transferMsg()], transfers: [] });
  const html = ctx.__render();
  assert.ok(html.includes('إشعار تحويل'), 'العنوان مفقود');
  assert.ok(!html.includes('تحويل بنين'), 'ما زالت الشارة المكرّرة «تحويل بنين» موجودة');
});