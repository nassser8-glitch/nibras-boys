'use strict';
// ============================================================
// نبراس — خادم آمن (Express + PostgreSQL + جلسات حقيقية)
// الاستبدال الكامل لخادم JSON + SYNC_KEY القديم
// ============================================================
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const bcrypt = require('bcryptjs');
const nodemailer = require('nodemailer');
const db = require('./db');
// خصوصية الملاحظات + حساب أرصدة النقاط على الخادم (مصدر الحقيقة بعد إخفاء النصوص)
const notePrivacy = require('./notes-privacy');
const transferPrivacy = require('./transfers-privacy');

// قراءة متغير: من Environment أولاً، ثم من ملف سري في /etc/secrets (بديل Render)
function envOrSecret(name, fallback) {
  if (process.env[name]) return process.env[name];
  const p = '/etc/secrets/' + name;
  try {
    if (fs.existsSync(p)) {
      const v = fs.readFileSync(p, 'utf8').trim();
      if (v) return v;
    }
  } catch (_) { /* تجاهل */ }
  return fallback;
}

function staticHasIndex(dir) {
  try { return fs.existsSync(dir) && fs.statSync(dir).isDirectory() && fs.existsSync(path.join(dir, 'index.html')); } catch (_) { return false; }
}
// التفضيل القطعي: public/ (النسخة المطوَّرة النشطة) يتقدَّم دائماً على public-build/
// (القديمة المشفّرة) مهما ضُبطت WEBROOT على public-build في إعدادات الاستضافة.
// لن يُقدَّم public-build إلا في غياب public/index.html تماماً.
function pickRoot() {
  const wanted = [
    path.join(__dirname, 'public'),
    path.resolve(process.cwd(), 'public'),
    path.join(__dirname, 'public-build'),
    path.resolve(process.cwd(), 'public-build'),
  ];
  const fromEnv = process.env.WEBROOT ? path.resolve(__dirname, process.env.WEBROOT) : null;
  if (fromEnv && staticHasIndex(fromEnv) && !/public-build/i.test(fromEnv)) wanted.unshift(fromEnv);
  for (const cand of wanted) {
    if (staticHasIndex(cand)) { console.log('[static] ROOT ->', cand); return cand; }
  }
  return path.join(__dirname, 'public');
}
let ROOT = pickRoot();
console.log('[static] WEBROOT=' + (process.env.WEBROOT || '') + ' ROOT=' + ROOT + ' hasIndex=' + staticHasIndex(ROOT));
console.log('[static] WEBROOT=' + (process.env.WEBROOT || '') + ' ROOT=' + ROOT + ' hasIndex=' + staticHasIndex(ROOT));
const PORT = Number(process.env.PORT) || 8090;
const SESSION_TTL_MS = Number(process.env.SESSION_TTL_MS) || 24 * 60 * 60 * 1000; // 24 ساعة
const SESSION_COOKIE = 'nibras_session';
const MAX_BODY_MB = Number(process.env.MAX_BODY_MB) || 20;
const BCRYPT_ROUNDS = 10;

// حسابات مفعّلة قسرياً: لا يُسمح لأي نسخة قديمة من أي جهازٍ بإعادة تعطيلها
// (على سبيل المثال: المعلم المفوّض يدوياً من المدير — الحماية ضمن حساب واحد)
const FORCE_ACTIVE = new Set([
  'id_81dc0acd1fde3501', // عبد الواسع هارون (abdulwase) — مفعّل يدوياً من المدير
]);

// بريد استعادة الرقم السري (SMTP) — يأتي من متغيرات البيئة (لا يُحفظ في الكود)
const MAIL_HOST = envOrSecret('MAIL_HOST', '');
const MAIL_PORT = Number(envOrSecret('MAIL_PORT', '587'));
const MAIL_SECURE = Number(MAIL_PORT) === 465;
const MAIL_USER = envOrSecret('MAIL_USER', '');
const MAIL_PASS = envOrSecret('MAIL_PASS', '');
const MAIL_FROM = envOrSecret('MAIL_FROM', '') || MAIL_USER;
let mailTransporter = null;
function getMailer() {
  if (!MAIL_HOST || !MAIL_USER || !MAIL_PASS) return null;
  if (!mailTransporter) {
    mailTransporter = nodemailer.createTransport({
      host: MAIL_HOST, port: MAIL_PORT, secure: MAIL_SECURE,
      auth: { user: MAIL_USER, pass: MAIL_PASS },
      connectionTimeout: 10000,
      greetingTimeout: 10000,
      socketTimeout: 20000,
      connectionOptions: { family: 4 },
    });
  }
  return mailTransporter;
}
// إرسال عبر REST API الخاصة بـ Brevo (يعمل من Render لأن منافذ SMTP 587/465 محجوبة
// بينما api.brevo.com:443 متاحة). المفتاح يُقرأ من MAIL_PASS (xkeysib-...) أو MAIL_API_KEY.
async function sendResetEmail(toEmail, code, expiresInMin) {
  const apiKey = envOrSecret('MAIL_API_KEY', '') || (MAIL_PASS && String(MAIL_PASS).indexOf('xkeysib-') === 0 ? MAIL_PASS : '');
  if (!apiKey) return false;
  try {
    const payload = {
      sender: { email: MAIL_FROM, name: 'نظام نبراس' },
      to: [{ email: toEmail }],
      subject: 'نبراس — رمز استعادة الرقم السري',
      textContent: 'نظام نبراس\n\nرمز استعادة الرقم السري الخاص بك هو: ' + code + '\nالرمز صالح لمدة ' + expiresInMin + ' دقائق.\n\nإذا لم تطلب هذا الرمز، تجاهل هذه الرسالة.',
      htmlContent: '<div dir="rtl" style="font-family:Tahoma,Arial,sans-serif;max-width:520px;margin:auto;border:1px solid #e2e8f0;border-radius:12px;padding:24px;color:#1f2937">'
        + '<h2 style="color:#0f766e;margin:0 0 8px">نظام نبراس</h2>'
        + '<p>رمز استعادة الرقم السري الخاص بك هو:</p>'
        + '<div style="font-size:34px;font-weight:800;text-align:center;background:#f1f5f9;border-radius:8px;padding:14px;direction:ltr">' + code.split('').join('&nbsp;') + '</div>'
        + '<p>الرمز صالح لمدة <b>' + expiresInMin + ' دقائق</b>.</p>'
        + '<p style="color:#64748b;font-size:13px">إذا لم تطلب هذا الرمز، تجاهل هذه الرسالة.</p>'
        + '</div>',
    };
    const resp = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: { 'api-key': apiKey, 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15000),
    });
    if (resp.status === 201 || resp.status === 200) return true;
    const detail = await resp.text().catch(() => '');
    console.error('[mail] فشل إرسال البريد عبر API:', resp.status, detail, '| to=', toEmail);
    return false;
  } catch (e) {
    console.error('[mail] فشل إرسال البريد:', e.message, '| to=', toEmail);
    return false;
  }
}

/* إرسال بريد مع مرفق (ملف Excel ببيانات الدخول) عبر Brevo REST API */
async function sendMailAttachment(toEmail, subject, html, filename, base64Content) {
  const apiKey = envOrSecret('MAIL_API_KEY', '') || (MAIL_PASS && String(MAIL_PASS).indexOf('xkeysib-') === 0 ? MAIL_PASS : '');
  if (!apiKey || !base64Content) return false;
  try {
    const mime = String(filename).toLowerCase().endsWith('.xlsx')
      ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      : 'application/octet-stream';
    const payload = {
      sender: { email: MAIL_FROM, name: 'نظام نبراس' },
      to: [{ email: toEmail }],
      subject,
      textContent: 'نظام نبراس\n\nالمرفق يحتوي بيانات دخول المعلمين (أسماء المستخدمين وكلمات المرور المؤقتة).\nأبلغ كل معلم باسم المستخدم وكلمة المرور، وسيُطلب منه تغييرها عند أول دخول.',
      htmlContent: '<div dir="rtl" style="font-family:Tahoma,Arial,sans-serif;max-width:520px;margin:auto;border:1px solid #e2e8f0;border-radius:12px;padding:24px;color:#1f2937">'
        + '<h2 style="color:#0f766e;margin:0 0 8px">نظام نبراس</h2>'
        + '<p>المرفق يحتوي <b>بيانات دخول المعلمين</b> (أسماء المستخدمين وكلمات المرور المؤقتة).</p>'
        + '<p>أبلغ كل معلم باسم المستخدم وكلمة المرور الخاصين به، وسيُطلب منه تغيير كلمة المرور وتعيين بريده الحقيقي عند أول دخول.</p>'
        + '<p style="color:#64748b;font-size:13px">لا تُرَد هذه الرسالة — إن لم تطلبها، تجاهلها وأبلغ مسؤول النظام.</p>'
        + '</div>',
      attachment: [{ name: String(filename).slice(0, 120), content: base64Content, type: mime }],
    };
    const resp = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: { 'api-key': apiKey, 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(20000),
    });
    if (resp.status === 201 || resp.status === 200) return true;
    const detail = await resp.text().catch(() => '');
    console.error('[mail] فشل إرسال البريد مع المرفق:', resp.status, detail, '| to=', toEmail);
    return false;
  } catch (e) {
    console.error('[mail] فشل إرسال البريد مع المرفق:', e.message, '| to=', toEmail);
    return false;
  }
}

const PASSWORD_MIN = 8;
const PASSWORD_RE = /^(?=.*[A-Za-z])[A-Za-z0-9@#$%^&*!._\-+=]{8,}$/;

// أدوار كتابة الأقسام (تطابق صلاحيات الواجهة — تُفرض على الخادم)
const SECTION_RULES = {
  users:       ['ADMIN', 'AGENT'],
  grades:      ['ADMIN', 'AGENT', 'COUNSELOR'],
  classes:     ['ADMIN', 'AGENT', 'COUNSELOR'],
  students:    ['ADMIN', 'AGENT', 'COUNSELOR'],
  attendance:  ['ADMIN', 'AGENT', 'COUNSELOR', 'TEACHER', 'ADMINISTRATIVE', 'SCHOOL_AGENT'],
  notes:       ['ADMIN', 'AGENT', 'COUNSELOR', 'TEACHER', 'ADMINISTRATIVE', 'SCHOOL_AGENT'],
  transfers:   ['ADMIN', 'AGENT', 'COUNSELOR', 'TEACHER', 'ADMINISTRATIVE'],
  activities:  ['ADMIN', 'AGENT', 'COUNSELOR', 'TEACHER', 'ADMINISTRATIVE'],
  timetable:   ['ADMIN', 'AGENT', 'COUNSELOR', 'TEACHER'],
  videos:      ['ADMIN', 'AGENT'],
  assignments: ['ADMIN', 'AGENT', 'COUNSELOR', 'TEACHER', 'STUDENT'],
  maintenance: ['ADMIN', 'AGENT', 'COUNSELOR', 'TEACHER', 'ADMINISTRATIVE'],
  // رسائل «الوكيل/المدير/الموجه → المعلم» وتنبيهاته (هروب/تحويل)، ورسالة اليوم، واقتراحاتها:
  // كانت في localStorage لكل جهاز فلا تصل المعلمين — أصبحت أقساماً تُزامن مع كل الأجهزة.
  adminMsgs:     ['ADMIN', 'AGENT', 'COUNSELOR', 'TEACHER', 'ADMINISTRATIVE'],
  announcements: ['ADMIN'],
  suggestions:   ['ADMIN', 'AGENT', 'COUNSELOR', 'TEACHER', 'ADMINISTRATIVE'],
};
const SECTION_KEYS = ['users','grades','classes','students','attendance','notes','transfers','activities','timetable','videos','assignments','maintenance','adminMsgs','announcements','suggestions'];
// إسناد إداري مثبّت: مسؤولو الأقسام يُسندون لجميع فصول قسمهم ويبقون مثبتين في كل حفظ
// (نسخة جهاز قديمة أو حفظ مدير بجهاز قديم كان يمسح الإسناد — هنا يُعاد فرضه قبل التخزين).
const ALWAYS_TEACHER_IDS = {
  BOYS: [],                                                                   // نبراس البنين: لا إسناد مثبّت مسبقاً — تُبنى الإسنادات عند الإدخال
};
// حقول سرية لا تُخزن/تُعاد أبدًا
const STRIP_FIELDS = ['password','password_hash','secret','initialSecret','resetCode','resetExpires','token_hash'];

const app = express();
app.disable('x-powered-by');
if (process.env.TRUST_PROXY === '1') app.set('trust proxy', 1);
app.use(express.json({ limit: MAX_BODY_MB + 'mb' }));

/* ================= أمان HTTP ================= */
function securityHeaders(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self' https://api.open-meteo.com; frame-src 'self' https://*.sharepoint.com https://www.youtube.com https://www.youtube-nocookie.com https://player.vimeo.com");
  if (req.secure) res.setHeader('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
  next();
}
app.use(securityHeaders);

// فرض HTTPS اختياري (خلف بروكسي وسيط يُنهي TLS)
if (process.env.FORCE_HTTPS === '1') {
  app.use((req, res, next) => {
    if (!req.secure && req.url !== '/api/health') {
      res.redirect('https://' + req.headers.host + req.url);
      return;
    }
    next();
  });
}

/* ================= وضع الصيانة ================= */
// واضح ومباشر: غيّر هذا المتغير إلى false عند الانتهاء.
const isMaintenanceMode = false;
const MAINT_CACHE_MS = 5000;
const MAINT_BYPASS_COOKIE = 'nibras_maint_bypass';
const MAINT_BYPASS_TTL = 6 * 60 * 60 * 1000; // 6 ساعات
let bypassCache = { key: null, at: 0 };
async function maintenanceBypassKey() {
  const now = Date.now();
  if (now - bypassCache.at < MAINT_CACHE_MS) return bypassCache.key;
  try {
    const v = await db.getFlag('maint_bypass');
    const key = (v === true || v === 'true') ? null : (v != null ? String(v) : '');
    bypassCache = { key: key || null, at: now };
    return bypassCache.key;
  } catch (_) { return null; }
}
app.use((req, res, next) => {
  if (!isMaintenanceMode) return next();
  if (req.path === '/maintenance.html' || req.path === '/api/health') return next();
  // العبور المشرف: مفتاح سري أو كوكي ترخيص سارية
  const given = req.query.maint || readCookies(req)[MAINT_BYPASS_COOKIE] || req.headers['x-maint-bypass'];
  return maintenanceBypassKey().then(key => {
    if (key && given && String(given).trim() === key) {
      res.setHeader('Set-Cookie', MAINT_BYPASS_COOKIE + '=' + encodeURIComponent(key) + '; Path=/; HttpOnly; ' + (req.secure ? 'Secure; ' : '') + 'Max-Age=' + Math.floor(MAINT_BYPASS_TTL / 1000));
      return next();
    }
    res.status(530).sendFile(path.join(__dirname, 'maintenance.html'));
  }).catch(() => {
    res.status(530).sendFile(path.join(__dirname, 'maintenance.html'));
  });
});

/* ================= الحد من المعدل ================= */
const rateBuckets = new Map();
function rateLimit(routeKey, limit, windowMs, req) {
  const ip = req.ip || 'unknown';
  const k = routeKey + '|' + ip;
  const now = Date.now();
  let b = rateBuckets.get(k);
  if (!b || b.start + windowMs < now) { b = { start: now, count: 0 }; rateBuckets.set(k, b); }
  b.count++;
  return b.count > limit;
}
setInterval(() => {
  const now = Date.now();
  for (const [k, b] of rateBuckets) if (b.start + 60 * 60 * 1000 < now) rateBuckets.delete(k);
}, 60 * 1000).unref();

/* حد محاولات الدخول: يُحتسب فقط فشل المصادقة (لا يُقفل المستخدمين الشرعيين بتكرار الدخول الناجح) */
const loginFails = new Map();
function loginFailBucket(req) {
  const ip = req.ip || 'unknown';
  const k = 'login|' + ip;
  const now = Date.now();
  let b = loginFails.get(k);
  if (!b || b.start + 15 * 60 * 1000 < now) { b = { start: now, count: 0 }; loginFails.set(k, b); }
  return b;
}
setInterval(() => {
  const now = Date.now();
  for (const [k, b] of loginFails) if (b.start + 60 * 60 * 1000 < now) loginFails.delete(k);
}, 60 * 1000).unref();

/* ================= الجلسة ================= */
function readCookies(req) {
  const raw = req.headers.cookie || '';
  const out = {};
  raw.split(';').forEach(p => {
    const i = p.indexOf('=');
    if (i > 0) { try { out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim()); } catch (e) {} }
  });
  return out;
}
function cookieOpts(req, maxAgeMs) {
  return [
    SESSION_COOKIE + '=' + encodeURIComponent(req._sessionToken),
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    req.secure ? 'Secure' : null,
    'Max-Age=' + Math.floor((maxAgeMs || SESSION_TTL_MS) / 1000),
  ].filter(Boolean).join('; ');
}

function authUser(req) {
  const token = readCookies(req)[SESSION_COOKIE];
  if (!token) { req._authReason = 'no_cookie'; return Promise.resolve(null); }
  const hash = crypto.createHash('sha256').update(token).digest('hex');
  return db.sessionByTokenHash(hash).then(row => {
    if (!row) { req._authReason = 'no_session_row'; return null; }
    req._sessionToken = token;
    req._tokenHash = hash;
    return row;
  });
}
function fail(res) { return e => { console.error('[500]', e); res.status(500).json({ error: 'server' }); }; }

// ===== تجديد زاحف للجلسة =====
// المشكلة: TTL ثابتة (24 ساعة)، فالموظفة التي تعمل طول اليوم تُطرد في منتصف يومها.
// النتيجة في الواجهة: الصفحة تبقى ظاهرة من sessionStorage بينما كل طلب خادم يرتدّ 401 —
// وهذا ما كان يظهر «تعذّر عرض لوحة المعلم» بلا تفسير. الآن نُمدّد الجلسة النشطة
// (نفس المخاطرة TTL، بلا تغيير سلوك الدخول والخروج) ونعيد ضبط كوكي المتصفح.
// خريطة in-memory لتحديد المعدل: لا استعلام لكل طلب.
const SESSION_RENEW_MIN_GAP_MS = 30 * 60 * 1000;
const __renewedAt = new Map();
function renewSessionIfNeeded(req, res, s) {
  if (!req._tokenHash) return;
  const now = Date.now();
  const key = req._tokenHash;
  const last = __renewedAt.get(key) || 0;
  if (now - last < SESSION_RENEW_MIN_GAP_MS) return;
  const remaining = new Date(s.expires_at || 0).getTime() - now;
  if (!(remaining < SESSION_TTL_MS / 2)) return;   // ما زالت جديدة: لا تدخّل
  __renewedAt.set(key, now);
  if (__renewedAt.size > 5000) { const cutoff = now - SESSION_RENEW_MIN_GAP_MS; for (const [k, t] of __renewedAt) if (t < cutoff) __renewedAt.delete(k); }
  db.touchSession(key, SESSION_TTL_MS)
    .then(exp => {
      if (!exp) return;
      s.expires_at = exp;
      try { res.setHeader('Set-Cookie', cookieOpts(req)); } catch (_) { /* رد أُرسل */ }
      console.log('[auth] session renewed', key.slice(0, 8));
    })
    .catch(e => console.warn('[auth] renew failed', e.message));
}
function requireAuth(req, res, next) {
  authUser(req).then(s => {
    // path داخل الرد: عميل واحد يخلط عدّة مسارات، و«غير مصرّح» بلا مسار ولا سبب
    // لا يمكن تشخيصه. المسار فقط (بلا استعلام) ولا شيء من الكوكي/الرمز.
    if (!s) return res.status(401).json({ error: 'unauthorized', reason: req._authReason || 'unauthorized', path: req.path });
    req.session = s;
    renewSessionIfNeeded(req, res, s);
    next();
  }).catch(fail(res));
}
function sendUser(u, sessionRow, viewerRole) {
  const user = { id: u.id, school: u.school, name: u.name, username: u.username, email: u.email, role: u.role, active: u.active, firstLogin: u.first_login, granted: u.granted !== false, ...(u.data || {}) };
  if (viewerRole === 'ADMIN' && u.plain_password) user.plain_password = u.plain_password;
  STRIP_FIELDS.forEach(f => delete user[f]);
  if (sessionRow) user.session = { created: sessionRow.created_at, expires: sessionRow.expires_at };
  return user;
}

// ===== مزامنة بيانات المستخدم في نسخة القسم (school_data.users) مع أي تغيير حسابي =====
// حتى لا تتعارض الجداول (users) مع نسخة البيانات التي تعرضها الواجهة
// ملاحظة حرجة: تُنفَّذ كلها عبر db.mutateSchoolData (BEGIN + SELECT..FOR UPDATE).
// السبب: القراءة في db.getSchoolData ثم إعادة كتابة الصف كاملاً بـ db.setSchoolData
// كانتا تفتحان نافذة سباق: أي حفظ أحدث يجري بينهما يُكتب فوقه بلقطة قديمة —
// وهو ما كان يُمحّي دفعات الطلاب (172 -> 162) من school_data عند كل تسجيل دخول/تفعيل.
// التعديل الآن على الصف المقفول، وts رتيب، فلا تُمحى بيانات أقدم... بل الأحدث.
async function updateSchoolUser(school, userId, fields) {
  const r = await db.mutateSchoolData(school, (d) => {
    if (!d || !Array.isArray(d.users)) return { changed: false, value: false };
    const u = d.users.find(x => x.id === userId);
    if (!u) return { changed: false, value: false };
    Object.assign(u, fields);
    STRIP_FIELDS.forEach(f => delete u[f]);
    return { changed: true, value: true };
  });
  if (!r.written && r.reason === 'stale') console.warn('[updateSchoolUser] رفض كتابة قديمة', school, userId);
  return r.written;
}
// تفعيل نسخ القسم (school_data.users) المطابقة بالمعرّف أو باسم المستخدم — يعالج المعرّف
// اليتيم الناتج عن تطبيع التكرار، حيث يبقى في الواجهة معرّف لا وجود له في جدول الحسابات.
async function markSchoolUsersActivated(school, userId, username) {
  const r = await db.mutateSchoolData(school, (d) => {
    if (!d || !Array.isArray(d.users)) return { changed: false, value: 0 };
    const uid = String(userId || '');
    const uname = String(username || '').trim().toLowerCase();
    let n = 0;
    for (const u of d.users) {
      if (!u) continue;
      const idMatch = uid && String(u.id) === uid;
      const nameMatch = uname && String(u.username || '').trim().toLowerCase() === uname;
      if (idMatch || nameMatch) {
        u.firstLogin = false;
        u.granted = true;
        delete u.password;
        n++;
      }
    }
    return { changed: n > 0, value: n };
  });
  return r.value == null ? 0 : r.value;
}
// تطبيق «مفعّلة» جماعياً انطلاقاً من قائمة المعلمين الظاهرة في واجهة المدير (نسخة القسم هي الأساس).
// لكل معلم: يُحلّ حسابُ دخلها من هوية سجلها (المعرّف ← اسم المستخدم ← البريد) ويُمحى first_login
// وتُمنح وتُحذف جلساتهم. الحسابات المتبقية من معلمين حُذفوا من القائمة تُعطَّل (لا تُحذف) حتى لا تدخل بقاياها.
async function activateAllTeachersFromList(school) {
  const rec = await db.getSchoolData(school);
  const list = (rec && rec.data && Array.isArray(rec.data.users)) ? rec.data.users : [];
  const teachers = list.filter(u => u && u.role === 'TEACHER' && u.active !== false);
  const protectIds = new Set();
  const protectNames = new Set();
  const clearedIds = [];
  const report = [];
  let accountsCleared = 0;
  let unlinked = 0;
  for (const bu of teachers) {
    const bId = bu.id != null ? String(bu.id) : '';
    const bName = String(bu.username || '').trim().toLowerCase();
    const bEmail = String(bu.email || '').trim().toLowerCase();
    if (bName) protectNames.add(bName);
    if (bEmail) protectNames.add(bEmail);
    let target = null;
    if (bId) target = await db.userById(bId);
    if (!target && bName) target = await db.userByUsername(bName);
    if (!target && bEmail) { const es = await db.usersByEmail(bEmail); if (es.length) target = es[0]; }
    if (target) {
      protectIds.add(target.id);
      await db.grantUserAccess(target.id);
      await db.clearFirstLogin(target.id);
      await db.deleteUserSessions(target.id);
      clearedIds.push(target.id);
      accountsCleared++;
    } else {
      unlinked++;
    }
    report.push({ name: bu.name, username: bName, email: bEmail, accountLinked: !!target });
  }
  // تعطيل حسابات المعلمين غير الظاهرة في القائمة (المُحذوفة من الواجهة) — لا حذف صريح، يُحفظ بها أثرُها
  const allRows = await db.listUsers(school);
  let staleDeactivated = 0;
  for (const r0 of allRows) {
    if (!r0 || r0.role !== 'TEACHER' || r0.active !== true) continue;
    if (protectIds.has(r0.id)) continue;
    const n = String(r0.username || '').trim().toLowerCase();
    const e = String(r0.email || '').trim().toLowerCase();
    if ((n && protectNames.has(n)) || (e && protectNames.has(e))) continue; // نسخة مكرّرة من معلم حيّة
    await db.setUserActive(r0.id, false);
    await db.deleteUserSessions(r0.id);
    staleDeactivated++;
  }
  // مسح «بانتظار أول دخول» من سجل القسم نفسه فلا تظهر القائمة اللفظَ
  const r = await db.mutateSchoolData(school, (d) => {
    if (!d || !Array.isArray(d.users)) return { changed: false, value: 0 };
    let n = 0;
    for (const u of d.users) {
      if (!u || u.role !== 'TEACHER' || u.active === false) continue;
      const wasPending = !!u.firstLogin;
      u.firstLogin = false;
      u.granted = true;
      if (wasPending) n++;
    }
    return { changed: n > 0, value: n };
  });
  // تحقق بعد التنفيذ: كم حساباً في جدول الحسابات ما زال first_login=true لمَن وُجّهنا له؟
  let stillPendingAccounts = 0;
  if (clearedIds.length) {
    try {
      const vq = await db.pool.query(
        'SELECT count(*)::int AS n FROM users WHERE id = ANY($1) AND first_login = true', [clearedIds]);
      stillPendingAccounts = vq.rows[0] ? vq.rows[0].n : 0;
    } catch (e) { console.warn('[activateAll] فشل تحقق first_login', e.message); }
  }
  return { teacherCount: teachers.length, accountsCleared, unlinked, listUpdated: r.value || 0,
    staleDeactivated, stillPendingAccounts, report };
}
async function appendSchoolUser(school, userObj) {
  const r = await db.mutateSchoolData(school, (d) => {
    if (!Array.isArray(d.users)) d.users = [];
    const clean = Object.assign({}, userObj);
    STRIP_FIELDS.forEach(f => delete clean[f]);
    const i = d.users.findIndex(x => x.id === clean.id);
    if (i >= 0) d.users[i] = clean; else d.users.push(clean);
    return { changed: true, value: true };
  });
  if (!r.written && r.reason === 'stale') console.warn('[appendSchoolUser] رفض كتابة قديمة', school);
  return r.written;
}

/* ================= /api/auth ================= */
app.post('/api/auth/login', (req, res) => {
  (async () => {
    const fails = loginFailBucket(req);
    if (fails.count >= 10) return res.status(429).json({ error: 'rate_limited' });
    const login = String(req.body && (req.body.login || req.body.email) || '').trim().toLowerCase();
    const password = String(req.body && req.body.password || '');
    if (!login || !password) return res.status(400).json({ error: 'missing' });
    // الدخول يكون باسم المستخدم (username)، مع بقاء دعم البريد الإلكتروني كبديل (يحتوي @)
    let candidates;
    if (login.includes('@')) candidates = await db.usersByEmail(login);
    else { const single = await db.userByUsername(login); candidates = single ? [single] : []; }
    let u = null;
    for (const c of candidates) {
      if (!c.active) continue;
      const ok = await bcrypt.compare(password, c.password_hash);
      if (ok) { u = c; break; }
    }
    if (!u) { fails.count++; return res.status(401).json({ error: 'invalid' }); }
    // القيد الصارم: الدخول مسموح فقط للحسابات المُصدَّرة بيانات دخولها أو المضافة يدويًا من المدير
    if (u.role !== 'ADMIN' && u.granted !== true) {
      fails.count++;
      return res.status(403).json({ error: 'not_granted' });
    }
    fails.count = 0;

    // إنهاء الدخول برحلة واحدة: حذف الجلسات القديمة + إنشاء الجلسة + إحصاءات الدخول
    const token = crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const nowMs = Date.now();
    const lastLoginIso = new Date(nowMs).toISOString();
    const hist = Array.isArray(u.data.loginHistory) ? u.data.loginHistory.slice(-299) : [];
    hist.push(lastLoginIso);
    const loginCount = (u.data.loginCount || 0) + 1;
    const row = await db.finalizeLogin(
      u.id, u.school, tokenHash, SESSION_TTL_MS, req.ip, (req.headers['user-agent'] || '').slice(0, 250),
      Object.assign({}, u.data, { lastLogin: lastLoginIso, loginCount, loginHistory: hist }),
      loginCount, lastLoginIso, hist);

    req._sessionToken = token;
    // finalizeLogin يحفظ first_login=false في users ونسخة school_data ذرياً.
    u.first_login = false;
    res.setHeader('Set-Cookie', cookieOpts(req));
    res.json({ ok: true, user: sendUser(u, row || { created_at: lastLoginIso, expires_at: new Date(nowMs + SESSION_TTL_MS).toISOString() }, u.role) });
  })().catch(fail(res));
});

/* ============ الدخول السريع أُلغي ============ */

app.post('/api/auth/logout', requireAuth, (req, res) => {
  db.deleteSession(req._tokenHash).catch(() => {});
  res.clearCookie(SESSION_COOKIE, { path: '/', httpOnly: true, sameSite: 'strict' });
  res.json({ ok: true });
});

app.get('/api/auth/me', (req, res) => {
  authUser(req).then(async s => {
    if (!s) return res.status(401).json({ error: 'unauthorized' });
    const u = await db.userById(s.user_id);
    if (!u || !u.active) { await db.deleteSession(s.token_hash).catch(() => {}); return res.status(401).json({ error: 'unauthorized' }); }
    res.json({ ok: true, user: sendUser(u, s, u.role) });
  }).catch(fail(res));
});

// نقطة التواجد (من فتح التطبيق الآن): يرسلها العميل كل دقيقة فتحدَّث lastSeenAt في
// مصدر الحقيقة ونسخة القسم — حتى يرى المدير «المتواجدون الآن» ببيانات حقيقية من كل
// الأجهزة (كانت تُكتب محلياً فقط فتُهمَل عند رفع غير المدير وتبقى البطاقة صفراً).
app.post('/api/auth/presence', requireAuth, (req, res) => {
  (async () => {
    if (rateLimit('presence', 120, 60 * 1000, req)) return res.status(429).json({ error: 'rate_limited' });
    const school = req.session.school;
    if (!db.SCHOOLS.includes(school)) return res.status(400).json({ error: 'bad_school' });
    const iso = Date.now();
    await db.touchUserPresence(school, req.session.user_id, new Date(iso).toISOString());
    res.json({ ok: true });
  })().catch(fail(res));
});

// قائمة المتواجدين الآن (من فتحت التطبيق خلال آخر 3 دقائق) — للمدير/الوكيل/الإداري:
// تُقرأ من نسخة القسم اللحظية (لا من localStorage الجهاز) فيرى المدير حضور كل الأجهزة.
app.get('/api/auth/presence', requireAuth, (req, res) => {
  (async () => {
    const school = String(req.query.school || req.session.school || '').toUpperCase();
    if (!db.SCHOOLS.includes(school)) return res.status(400).json({ error: 'bad_school' });
    if (req.session.role !== 'ADMIN' && req.session.role !== 'AGENT')
      return res.status(403).json({ error: 'forbidden' });
    const rec = await db.getSchoolData(school);
    const users = (rec && rec.data && Array.isArray(rec.data.users)) ? rec.data.users : [];
    const out = users
      .filter(u => u && !u.deleted)
      .map(u => ({ id: u.id, name: u.name || u.id, role: u.role, active: u.active !== false, lastSeenAt: u.lastSeenAt || '' }));
    res.json({ ok: true, school, now: Date.now(), users: out });
  })().catch(fail(res));
});

function supervisionToday() {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Karachi', year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short',
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.filter(p => p.type !== 'literal').map(p => [p.type, p.value]));
  const dayOfWeek = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[values.weekday] || 0;
  return { date: `${values.year}-${values.month}-${values.day}`, dayOfWeek };
}

app.get('/api/supervision/today', requireAuth, (req, res) => {
  (async () => {
    const role = req.session.role;
    if (!db.canViewSupervisionToday(role)) return res.status(403).json({ error: 'forbidden' });
    const school = String(req.query.school || req.session.school || '').toUpperCase();
    if (!db.SCHOOLS.includes(school)) return res.status(400).json({ error: 'invalid_school' });
    if (role === 'ADMIN') {
      if (!schoolAccess(req.session, school)) return res.status(403).json({ error: 'forbidden' });
    } else if (school !== req.session.school) {
      return res.status(403).json({ error: 'forbidden' });
    }
    const today = supervisionToday();
    const rows = await db.getSupervisionForDate(school, today.dayOfWeek, today.date);
    const visibleRows = db.filterSupervisionAssignments(role, rows, req.session.user_id);
    res.json({
      ok: true, school, date: today.date, dayOfWeek: today.dayOfWeek,
      assigned: visibleRows.map(row => ({
        teacherId: row.teacher_id, name: row.name, dayOfWeek: row.day_of_week,
        checkedInAt: row.checked_in_at,
      })),
      managerView: role === 'ADMIN' || role === 'AGENT' || role === 'SCHOOL_AGENT',
    });
  })().catch(fail(res));
});

app.get('/api/supervision/schedule', requireAuth, (req, res) => {
  (async () => {
    const school = String(req.query.school || req.session.school || '').toUpperCase();
    if ((req.session.role !== 'ADMIN' && req.session.role !== 'AGENT' && req.session.role !== 'SCHOOL_AGENT') || !db.SCHOOLS.includes(school))
      return res.status(403).json({ error: 'forbidden' });
    if (!(canManageUsers(req.session, school) || (req.session.role === 'SCHOOL_AGENT' && school === req.session.school)))
      return res.status(403).json({ error: 'forbidden' });
    const rows = await db.getSupervisionSchedule(school);
    res.json({ ok: true, school, schedule: rows.map(row => ({
      dayOfWeek: row.day_of_week, teacherId: row.teacher_id, enabled: row.enabled, name: row.name,
    })) });
  })().catch(fail(res));
});

app.put('/api/supervision/schedule', requireAuth, (req, res) => {
  (async () => {
    const school = String(req.body && req.body.school || req.session.school || '').toUpperCase();
    if ((req.session.role !== 'ADMIN' && req.session.role !== 'AGENT' && req.session.role !== 'SCHOOL_AGENT') || !db.SCHOOLS.includes(school))
      return res.status(403).json({ error: 'forbidden' });
    if (!(canManageUsers(req.session, school) || (req.session.role === 'SCHOOL_AGENT' && school === req.session.school)))
      return res.status(403).json({ error: 'forbidden' });
    const rows = await db.replaceSupervisionSchedule(school, req.body && req.body.schedule);
    res.json({ ok: true, school, schedule: rows.map(row => ({
      dayOfWeek: row.day_of_week, teacherId: row.teacher_id, enabled: row.enabled, name: row.name,
    })) });
  })().catch(error => {
    if (error && ['invalid_schedule', 'invalid_teacher'].includes(error.message))
      return res.status(400).json({ error: error.message });
    fail(res)(error);
  });
});

app.post('/api/supervision/check-in', requireAuth, (req, res) => {
  (async () => {
    if (req.session.role !== 'TEACHER') return res.status(403).json({ error: 'forbidden' });
    const today = supervisionToday();
    const result = await db.checkInSupervision(req.session.school, req.session.user_id, today.dayOfWeek, today.date);
    res.json({ ok: true, alreadyCheckedIn: !result.created, checkIn: result.record });
  })().catch(error => {
    if (error && ['no_supervision_today', 'not_assigned'].includes(error.message))
      return res.status(403).json({ error: error.message });
    fail(res)(error);
  });
});

// الوكيل/المدير: تسجيل من أدى الإشراف ومن لم يؤده في تاريخ معيّن (افتراضيًا اليوم).
app.post('/api/supervision/record', requireAuth, (req, res) => {
  (async () => {
    const role = req.session.role;
    if (role !== 'ADMIN' && role !== 'AGENT' && role !== 'SCHOOL_AGENT') return res.status(403).json({ error: 'forbidden' });
    const school = String(req.body && req.body.school || req.session.school || '').toUpperCase();
    if (!db.SCHOOLS.includes(school)) return res.status(400).json({ error: 'invalid_school' });
    if (!(canManageUsers(req.session, school) || (role === 'SCHOOL_AGENT' && school === req.session.school)))
      return res.status(403).json({ error: 'forbidden' });
    const teacherId = String(req.body && req.body.teacherId || '');
    const checkIn = Boolean(req.body && req.body.checkIn);
    const date = String(req.body && req.body.date || '').slice(0, 10);
    if (!teacherId) return res.status(400).json({ error: 'invalid_teacher' });
    if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date))
      return res.status(400).json({ error: 'invalid_date' });
    const target = await db.recordSupervisionCheckIn(school, teacherId, date || (supervisionToday().date), checkIn);
    res.json({ ok: true, recorded: target.checkedInAt ? true : false, cancelled: target.cancelled });
  })().catch(error => {
    if (error && ['not_assigned'].includes(error.message))
      return res.status(403).json({ error: error.message });
    fail(res)(error);
  });
});

app.get('/api/supervision/history', requireAuth, (req, res) => {
  (async () => {
    const school = String(req.query.school || req.session.school || '').toUpperCase();
    if ((req.session.role !== 'ADMIN' && req.session.role !== 'AGENT' && req.session.role !== 'SCHOOL_AGENT') || !db.SCHOOLS.includes(school))
      return res.status(403).json({ error: 'forbidden' });
    if (!(canManageUsers(req.session, school) || (req.session.role === 'SCHOOL_AGENT' && school === req.session.school)))
      return res.status(403).json({ error: 'forbidden' });
    res.json({ ok: true, school, history: await db.getSupervisionHistory(school, req.query.limit) });
  })().catch(fail(res));
});

app.post('/api/auth/change-password', requireAuth, (req, res) => {
  (async () => {
    if (rateLimit('chpwd', 6, 15 * 60 * 1000, req)) return res.status(429).json({ error: 'rate_limited' });
    const pw = String(req.body && req.body.newPassword || '');
    if (pw && !PASSWORD_RE.test(pw)) return res.status(400).json({ error: 'weak_password', min: PASSWORD_MIN });
    const me = await db.userById(req.session.user_id);
    if (!me) return res.status(401).json({ error: 'unauthorized' });
    const email = String(req.body && req.body.email || '').trim().toLowerCase();
    if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: 'bad_email' });
    // كل التحقق نجح — نطبّق التغييرات (كلمة المرور اختيارية ثم البريد)
    if (pw) {
      const hash = await bcrypt.hash(pw, BCRYPT_ROUNDS);
      await db.updateUserPasswordHash(me.id, hash, false);
      await db.updateUserPlainPassword(me.id, pw);
    }
    const after = await db.userById(me.id);
    if (email) {
      await db.insertUser(Object.assign({}, after, { email }));
      await updateSchoolUser(req.session.school, me.id, { email });
    }
    await updateSchoolUser(req.session.school, me.id, { firstLogin: false });
    const u = await db.userById(me.id);
    res.json({ ok: true, user: sendUser(u, req.session, req.session.role) });
  })().catch(fail(res));
});

app.post('/api/auth/update-profile', requireAuth, (req, res) => {
  (async () => {
    if (rateLimit('profile', 12, 15 * 60 * 1000, req)) return res.status(429).json({ error: 'rate_limited' });
    let u = await db.userById(req.session.user_id);
    if (!u) return res.status(401).json({ error: 'unauthorized' });

    const email = String(req.body && req.body.email || '').trim().toLowerCase();
    if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: 'bad_email' });
    const pw = String(req.body && req.body.newPassword || '');
    if (pw) {
      if (!PASSWORD_RE.test(pw)) return res.status(400).json({ error: 'weak_password', min: PASSWORD_MIN });
      const hash = await bcrypt.hash(pw, BCRYPT_ROUNDS);
      await db.updateUserPasswordHash(u.id, hash, false);
      await db.updateUserPlainPassword(u.id, pw);
      await updateSchoolUser(u.school, u.id, { firstLogin: false });
      u = await db.userById(u.id);
    }
    if (email) {
      await db.insertUser(Object.assign({}, u, { email }));
      await updateSchoolUser(u.school, u.id, { email });
    }
    const updated = await db.userById(u.id);
    res.json({ ok: true, user: sendUser(updated, req.session, req.session.role) });
  })().catch(fail(res));
});

/* ============ استعادة كلمة المرور (رمز يظهر على الشاشة — لا خدمة إيميل) ============ */
const RESET_CODE_TTL_MS = 10 * 60 * 1000;
app.post('/api/auth/forgot-password', (req, res) => {
  (async () => {
    if (rateLimit('forgot', 5, 15 * 60 * 1000, req)) return res.status(429).json({ error: 'rate_limited' });
    const login = String(req.body && (req.body.email || req.body.login) || '').trim().toLowerCase();
    if (!login) return res.status(400).json({ error: 'missing' });
    // الدخول بالاسم أو البريد: الاسم فريد فلا لبس في تحديد الحساب المستهدف (البريد قد يتكرر)
    let candidates;
    if (login.includes('@')) candidates = await db.usersByEmail(login);
    else { const single = await db.userByUsername(login); candidates = single ? [single] : []; }
    if (!candidates.length) return res.status(404).json({ error: 'not_found' });
    const active = candidates.filter(c => c.active);
    if (!active.length) return res.status(404).json({ error: 'not_found' });
    const u = active[0];
    const code = String(Math.floor(100000 + Math.random() * 900000));
    for (const c of active) {
      await db.updateUserProfile(c.id, { data: Object.assign({}, c.data, { resetCode: code, resetExpires: Date.now() + RESET_CODE_TTL_MS }) });
    }
    // اسم/أسماء الحسابات المطابقة ليظهر للمستخدم قبل تطبيق الرمز (يتجنب تغيير حساب خاطئ)
    const names = active.map(c => c.name);
    // البريد الافتراضي للأنظمة (مثل @nibras.local أو @school.local) غير قابل للاستلام الفعلي:
    // نعرض الرمز على الشاشة مباشرة بدل محاولة إرسال إلى عنوان غير موجود.
    const FAKE_DOMAINS = /@(nibras|school|local|example|test)(\.|$)/i;
    if (FAKE_DOMAINS.test(u.email)) {
      return res.json({ ok: true, code, expiresInMin: 10, fallback: true, names });
    }
    // إرسال الرمز إلى بريد المستخدم عبر SMTP (nassser8@gmail.com). إن لم يُضبط البريد: نعرضه في الاستجابة (وضع التطوير).
    const sent = await sendResetEmail(u.email, code, Math.round(RESET_CODE_TTL_MS / 60000));
    res.json(sent ? { ok: true, expiresInMin: 10, names } : { ok: true, code, expiresInMin: 10, fallback: true, names });
  })().catch(fail(res));
});

app.post('/api/auth/recover-password', (req, res) => {
  (async () => {
    if (rateLimit('recover', 8, 15 * 60 * 1000, req)) return res.status(429).json({ error: 'rate_limited' });
    const login = String(req.body && (req.body.email || req.body.login) || '').trim().toLowerCase();
    const code = String(req.body && req.body.code || '').trim();
    const pw = String(req.body && req.body.newPassword || '');
    if (!login || !code || !pw) return res.status(400).json({ error: 'missing' });
    let candidates;
    if (login.includes('@')) candidates = await db.usersByEmail(login);
    else { const single = await db.userByUsername(login); candidates = single ? [single] : []; }
    let u = candidates.find(c => c.active && c.data && String(c.data.resetCode) === code);
    if (!u) return res.status(400).json({ error: 'bad_code' });
    const exp = u.data && u.data.resetExpires;
    if (!exp || exp < Date.now()) return res.status(400).json({ error: 'code_expired' });
    if (!PASSWORD_RE.test(pw)) return res.status(400).json({ error: 'weak_password', min: PASSWORD_MIN });
    const hash = await bcrypt.hash(pw, BCRYPT_ROUNDS);
    await db.updateUserPasswordHash(u.id, hash, false);
    await db.updateUserPlainPassword(u.id, pw);
    const cleanData = Object.assign({}, u.data);
    delete cleanData.resetCode;
    delete cleanData.resetExpires;
    await db.updateUserProfile(u.id, { data: cleanData });
    await updateSchoolUser(u.school, u.id, { firstLogin: false });
    await db.deleteUserSessions(u.id);
    res.json({ ok: true });
  })().catch(fail(res));
});

/* =============== إدارة الحسابات (مدير / وكيل) =============== */
function canManageUsers(user, targetSchool) {
  if (user.role === 'ADMIN') return true;
  if (user.role === 'AGENT' && user.school === targetSchool) return true;
  return false;
}
function validRoleFor(actor, role) {
  if (actor.role === 'ADMIN') return ['ADMIN','AGENT','COUNSELOR','TEACHER','ADMINISTRATIVE','SCHOOL_AGENT','STUDENT'].includes(role);
  return ['COUNSELOR','TEACHER'].includes(role);
}

app.post('/api/auth/admin/create-user', requireAuth, (req, res) => {
  (async () => {
    if (rateLimit('create', 60, 15 * 60 * 1000, req)) return res.status(429).json({ error: 'rate_limited' });
    const school = db.SCHOOLS[0]; // نظام BOYS فقط: لا يُقبل أي قسم من جسم الطلب
    if (!canManageUsers(req.session, school)) return res.status(403).json({ error: 'forbidden' });
    const name = String(req.body && req.body.name || '').trim();
    const email = String(req.body && req.body.email || '').trim().toLowerCase();
    const pw = String(req.body && req.body.password || '');
    const role = String(req.body && req.body.role || '').toUpperCase();
    const isStudent = role === 'STUDENT';
    const studentId = req.body && req.body.studentId;
    if (!name || !PASSWORD_RE.test(pw) || !validRoleFor(req.session, role))
      return res.status(400).json({ error: 'invalid', min: PASSWORD_MIN });
    if (!isStudent && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email))
      return res.status(400).json({ error: 'invalid_email' });
    const hash = await bcrypt.hash(pw, BCRYPT_ROUNDS);
    const id = studentId || ('id_' + crypto.randomBytes(6).toString('hex'));
    const preferred = String(req.body && req.body.username || '').trim();
    const username = await db.generateUsername(name, preferred || (isStudent ? name.replace(/\s+/g, '') : email.split('@')[0]));
    const finalEmail = isStudent ? (email || (username + '@nibras.school')) : email;
    await db.insertUser({ id, school, name, email: finalEmail, username, password_hash: hash, plain_password: pw, role, active: true, first_login: !isStudent, granted: true, data: {} });
    const created = await db.userById(id);
    await appendSchoolUser(school, sendUser(created, null, 'ADMIN'));
    res.json({ ok: true, user: sendUser(created, null, 'ADMIN') });
  })().catch(fail(res));
});

// إنشاء طالب وحسابها ومرآتهما في معاملة PostgreSQL واحدة.
app.post('/api/auth/admin/create-student', requireAuth, (req, res) => {
  (async () => {
    if (rateLimit('createStudent', 60, 15 * 60 * 1000, req))
      return res.status(429).json({ error: 'rate_limited' });
    const school = db.SCHOOLS[0]; // نظام BOYS فقط: لا يُقبل أي قسم من جسم الطلب
    if (!canManageUsers(req.session, school)) return res.status(403).json({ error: 'forbidden' });
    const id = String(req.body && req.body.studentId || '').trim();
    const name = String(req.body && req.body.name || '').trim();
    const studentNo = String(req.body && req.body.studentNo || '').trim();
    const username = String(req.body && req.body.username || '').trim();
    const password = String(req.body && req.body.password || '');
    const classId = String(req.body && req.body.classId || '').trim() || null;
    if (!id || !name || !studentNo || !username || !PASSWORD_RE.test(password))
      return res.status(400).json({ error: 'invalid', min: PASSWORD_MIN });
    const hash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    const result = await db.createStudentAccountAndRecord({
      id, school, name, username, password, passwordHash: hash,
      email: username + '@nibras.school',
      student: {
        fullName: name, studentNo, classId, guardianName: '', guardianPhone: '',
        active: true, joinedAt: Date.now(),
      },
    });
    res.status(201).json({
      ok: true, id: result.id, name: result.name, grade: result.grade,
      class: result.class, username: result.username, student: result.student,
    });
  })().catch(error => {
    if (error && error.code === 'username_exists')
      return res.status(409).json({ error: 'username_exists' });
    if (error && error.code === 'duplicate_student')
      return res.status(409).json({ error: 'duplicate_student' });
    if (error && error.code === 'student_number_exists')
      return res.status(409).json({ error: 'student_number_exists' });
    fail(res)(error);
  });
});

// حذف نهائي لطالب: يُعطّل حسابها (لا يمكنها الدخول)، ويحول سجلها إلى شاهد حذف
// deleted ينتشر لكل الأجهزة، ويسجّل معرّفها في _blockedStudents فلا يعود اسمها لأي
// جهاز قديم مهما دفع نسخته (تُسقط/تُفسد أي نسخة قادمة قبل الحفظ).
app.post('/api/auth/admin/delete-student', requireAuth, (req, res) => {
  (async () => {
    if (req.session.role !== 'ADMIN') return res.status(403).json({ error: 'forbidden' });
    if (rateLimit('delStu', 30, 15 * 60 * 1000, req)) return res.status(429).json({ error: 'rate_limited' });
    const id = String(req.body && req.body.studentId || '').trim();
    if (!id) return res.status(400).json({ error: 'missing_studentId' });
    const school = String(req.body && req.body.school || '').toUpperCase();
    if (!db.SCHOOLS.includes(school)) return res.status(400).json({ error: 'bad_school' });
    if (!canManageUsers(req.session, school)) return res.status(403).json({ error: 'forbidden' });
    const target = await db.userById(id);
    if (!target) return res.status(404).json({ error: 'not_found' });
    if (target.role !== 'STUDENT' || target.school !== school)
      return res.status(400).json({ error: 'not_student' });

    // 1) تعطيل الحساب نهائيًا (منع الدخول) مع الإبقاء على الصف في users — وإلا
    //    تفلتره guard_filter_mirror_data فلا يصل شاهدُ الحذف للأجهزة الأخرى فيعود الاسم.
    try { await db.setUserActive(id, false); } catch (e) { console.warn('[del-stu] active', e.message); }
    try { await db.deleteUserSessions(id); } catch (e) { console.warn('[del-stu] sessions', e.message); }

    // 2) تحويل سجل الطالب إلى شاهد حذف + تنقية سجلاتها من المرآة + تسجيل الحظر
    // على الصف المقفول (BEGIN + FOR UPDATE): الحذف يجب أن يُطبَّق على أحدث نسخة،
    // لا أن يمحو أي حفظ جديد بكتابة لقطة قديمة فوقه.
    try {
      await db.mutateSchoolData(school, (d) => {
      if (!d) return { changed: false, value: false };
      const blockSet = new Set(Array.isArray(d._blockedStudents) ? d._blockedStudents.map(String) : []);
      blockSet.add(id);
      d._blockedStudents = [...blockSet];
      if (Array.isArray(d.students)) {
        d.students = d.students.map(s => {
          if (!s) return s;
          if (s.id !== id) return s;
          const t = JSON.parse(JSON.stringify(s));
          t.active = false; t.deleted = true;
          return t;
        });
      }
      if (Array.isArray(d.notes)) d.notes = d.notes.filter(n => n && n.studentId !== id);
      if (Array.isArray(d.attendance)) d.attendance = d.attendance.filter(a => a && a.studentId !== id);
      if (Array.isArray(d.assignments)) {
        d.assignments.forEach(a => {
          if (a && Array.isArray(a.completedBy)) a.completedBy = a.completedBy.filter(x => x !== id);
        });
      }
      if (Array.isArray(d.users)) {
        d.users = d.users.map(u => {
          if (!u) return u;
          if (u.id !== id) return u;
          const c = JSON.parse(JSON.stringify(u));
          c.active = false; c.deleted = true; c.lastLogin = undefined;
          return c;
        });
      }
      return { changed: true, value: true };
      });
    } catch (e) { console.warn('[del-stu] mirror', e.message); }

    res.json({ ok: true, studentId: id, deleted: true });
  })().catch(fail(res));
});

// حذف نهائي جماعي للطلاب (حذف الكل من إدارة الطلاب) — نفس حماية المفرد فوق كل واحد.
app.post('/api/auth/admin/delete-students', requireAuth, (req, res) => {
  (async () => {
    if (req.session.role !== 'ADMIN') return res.status(403).json({ error: 'forbidden' });
    if (rateLimit('delStu', 30, 15 * 60 * 1000, req)) return res.status(429).json({ error: 'rate_limited' });
    const ids = Array.isArray(req.body && req.body.studentIds) ? req.body.studentIds.map(String) : [];
    if (!ids.length) return res.status(400).json({ error: 'missing_studentIds' });
    const school = String(req.body && req.body.school || '').toUpperCase();
    if (!db.SCHOOLS.includes(school)) return res.status(400).json({ error: 'bad_school' });
    if (!canManageUsers(req.session, school)) return res.status(403).json({ error: 'forbidden' });

    const valid = [];
    for (const id of ids) {
      const t = await db.userById(id);
      if (!t || t.role !== 'STUDENT' || t.school !== school) continue;
      valid.push({ id, name: t.name });
    }
    for (const v of valid) {
      try { await db.setUserActive(v.id, false); } catch (e) {}
      try { await db.deleteUserSessions(v.id); } catch (e) {}
    }
    const idSet = new Set(valid.map(v => v.id));
    if (idSet.size) {
      // على الصف المقفول (BEGIN + FOR UPDATE) — نفس حماية الحذف المفرد.
      try {
        await db.mutateSchoolData(school, (d) => {
        if (!d) return { changed: false, value: false };
        const blockSet = new Set(Array.isArray(d._blockedStudents) ? d._blockedStudents.map(String) : []);
        for (const id of idSet) blockSet.add(id);
        d._blockedStudents = [...blockSet];
        if (Array.isArray(d.students)) {
          d.students = d.students.map(s => {
            if (!s || !s.id) return s;
            if (!idSet.has(s.id)) return s;
            const t = JSON.parse(JSON.stringify(s));
            t.active = false; t.deleted = true;
            return t;
          });
        }
        if (Array.isArray(d.notes)) d.notes = d.notes.filter(n => n && n.studentId && !idSet.has(n.studentId));
        if (Array.isArray(d.attendance)) d.attendance = d.attendance.filter(a => a && a.studentId && !idSet.has(a.studentId));
        if (Array.isArray(d.assignments)) {
          d.assignments.forEach(a => {
            if (a && Array.isArray(a.completedBy)) a.completedBy = a.completedBy.filter(x => !idSet.has(x));
          });
        }
        if (Array.isArray(d.users)) {
          d.users = d.users.map(u => {
            if (!u || !u.id) return u;
            if (!idSet.has(u.id)) return u;
            const c = JSON.parse(JSON.stringify(u));
            c.active = false; c.deleted = true; c.lastLogin = undefined;
            return c;
          });
        }
        return { changed: true, value: true };
        });
      } catch (e) { console.warn('[del-stus] mirror', e.message); }
    }

    res.json({ ok: true, count: valid.length, ids: valid.map(v => v.id) });
  })().catch(fail(res));
});

// حارس بقاء الطلاب المحذوفات نهائيًا: أي نسخة قادمة تحملها تُفسد (deleted+غير نشطة)
// قبل الدمج والحفظ، فلا تعود للإحياء أبدًا. يُطبَّق على النسخة الواصلة وعلى النتيجة النهائية.
function applyBlockedStudents(data, keys) {
  try {
    const ids = keys instanceof Set ? keys : new Set(Array.isArray(data && data._blockedStudents) ? data._blockedStudents.map(String) : []);
    if (!ids.size) return false;
    let changed = false;
    if (Array.isArray(data.students)) {
      data.students = data.students.map(s => {
        if (s && ids.has(String(s.id)) && s.active !== false) { changed = true; const t = JSON.parse(JSON.stringify(s)); t.active = false; t.deleted = true; return t; }
        if (s && ids.has(String(s.id)) && !s.deleted) { changed = true; s.deleted = true; }
        return s;
      });
    }
    if (Array.isArray(data.users)) {
      data.users = data.users.map(u => {
        if (u && ids.has(String(u.id)) && u.role === 'STUDENT' && u.active !== false) { changed = true; const t = JSON.parse(JSON.stringify(u)); t.active = false; t.deleted = true; return t; }
        return u;
      });
    }
    return changed;
  } catch (e) { console.warn('[blockedStudents]', e.message); return false; }
}

app.post('/api/auth/admin/reset-password', requireAuth, (req, res) => {
  (async () => {
    if (rateLimit('reset', 15, 15 * 60 * 1000, req)) return res.status(429).json({ error: 'rate_limited' });
    const userId = String(req.body && req.body.userId || '');
    const target = await db.userById(userId);
    if (!target) return res.status(404).json({ error: 'not_found' });
    if (!canManageUsers(req.session, target.school)) return res.status(403).json({ error: 'forbidden' });
    const temp = crypto.randomBytes(6).toString('hex').slice(0, 10); // 10 محارف عشوائية
    const hash = await bcrypt.hash(temp, BCRYPT_ROUNDS);
    await db.updateUserPasswordHash(target.id, hash, true);
    await db.updateUserPlainPassword(target.id, temp);
    await db.grantUserAccess(target.id);
    await updateSchoolUser(target.school, target.id, { firstLogin: true, granted: true });
    await db.deleteUserSessions(target.id); // إنهاء جلسات المستخدم فورًا
    res.json({ ok: true, userId: target.id, name: target.name, tempPassword: temp, firstLogin: true });
  })().catch(fail(res));
});

// اعتبار حساب معلم «مُفعّلاً» بدون تغيير كلمة مرورها — يزيل «بانتظار أول دخول» لمن أنهت أول دخول فعلاً
app.post('/api/auth/admin/mark-activated', requireAuth, (req, res) => {
  (async () => {
    if (rateLimit('markact', 30, 15 * 60 * 1000, req)) return res.status(429).json({ error: 'rate_limited' });
    const userId = String(req.body && req.body.userId || '');
    const username = String(req.body && req.body.username || '').trim();
    const school = String((req.body && req.body.school) || req.session.school || '').toUpperCase();
    if (!school || !db.SCHOOLS.includes(school)) return res.status(400).json({ error: 'bad_school' });
    if (!canManageUsers(req.session, school)) return res.status(403).json({ error: 'forbidden' });
    // بحث بالمعرّف أولاً، ثم باسم المستخدم: بعد تطبيع الأسماء المكررة قد يبقى في الواجهة
    // معرّف يتيم غير موجود في جدول الحسابات، فيفشل db.userById ويبدو التفعيل بلا أثر.
    let target = userId ? await db.userById(userId) : null;
    if (!target && username) target = await db.userByUsername(username);
    if (!target) {
      // ربط حساب الدخول عبر هوية سجل النسخة نفسها: قد يختلف معرّف سجل القسم واسم مستخدمه
      // عن جدول الحسابات (تطبيع الأسماء المكررة) — نحفر من النسخة ثم نطابق البريد/الاسم.
      const rec = await db.getSchoolData(school);
      const list = (rec && rec.data && Array.isArray(rec.data.users)) ? rec.data.users : [];
      let blobUser = userId ? list.find(u => u && String(u.id) === String(userId)) : null;
      if (!blobUser && username) blobUser = list.find(u => u && String(u.username || '').trim().toLowerCase() === username.toLowerCase()) || null;
      if (blobUser) {
        const bId = blobUser.id != null ? String(blobUser.id) : '';
        const bName = String(blobUser.username || '').trim();
        const bEmail = String(blobUser.email || '').trim().toLowerCase();
        if (bId && bId !== String(userId)) target = await db.userById(bId);
        if (!target && bName) target = await db.userByUsername(bName);
        if (!target && bEmail) { const es = await db.usersByEmail(bEmail); if (es.length) target = es[0]; }
      }
    }
    let accountsCleared = false;
    if (target) {
      await db.grantUserAccess(target.id);
      // مصدر الحقيقة لِـ firstLogin هو جدول الحسابات (users.first_login) الذي تُبنى منه
      // /api/db — فبدون ضبطه هنا تبقى «بانتظار أول دخول» رغم التفعيل (خصوصاً لدى المعلم عند الدخول).
      await db.clearFirstLogin(target.id);
      await db.deleteUserSessions(target.id);
      accountsCleared = true;
    }
    // مزامنة نسخ القسم كلها (بالمعرّف أو الاسم) حتى لو كان المعروض معرّفاً يتيماً.
    const updated = await markSchoolUsersActivated(school, target ? target.id : userId, username || (target && target.username));
    if (!target && !updated) return res.status(404).json({ error: 'not_found' });
    res.json({ ok: true, accountsCleared, userId: (target && target.id) || userId, name: (target && target.name) || '', updated });
  })().catch(fail(res));
});

// تفعيل جماعي وفق قائمة المعلمين الظاهرة في الواجهة (نسخة القسم هي الأساس): لكل معلم تُربط
// بحساب دخلها ويُمحى first_login وتسقط «بانتظار أول دخول»؛ وتُعطَّل حسابات المعلمين المحذوفة غير الظاهرة.
app.post('/api/auth/admin/activate-all-from-list', requireAuth, (req, res) => {
  (async () => {
    if (req.session.role !== 'ADMIN') return res.status(403).json({ error: 'forbidden' });
    if (rateLimit('activateall', 10, 60 * 60 * 1000, req)) return res.status(429).json({ error: 'rate_limited' });
    const school = String((req.body && req.body.school) || req.session.school || '').toUpperCase();
    if (!db.SCHOOLS.includes(school) || !canManageUsers(req.session, school))
      return res.status(403).json({ error: 'forbidden' });
    const result = await activateAllTeachersFromList(school);
    res.json({ ok: true, school, apply: true, ...result });
  })().catch(fail(res));
});

// إصلاح محدود للحسابات التي تحمل first_login=true رغم وجود دليل دخول موثوق.
// المعاينة هي الوضع الافتراضي؛ التطبيق يتطلب apply=true ويطابق الحسابات بالمعرّف.
app.post('/api/auth/admin/repair-first-login', requireAuth, (req, res) => {
  (async () => {
    if (req.session.role !== 'ADMIN') return res.status(403).json({ error: 'forbidden' });
    const school = String(req.body && req.body.school || req.session.school || '').toUpperCase();
    if (!db.SCHOOLS.includes(school) || !canManageUsers(req.session, school))
      return res.status(403).json({ error: 'forbidden' });
    const apply = req.body && req.body.apply === true;
    const result = await db.repairTeacherFirstLoginFromEvidence(school, apply);
    res.json({ ok: true, school, apply, candidateIds: result.candidateIds, updatedIds: result.updatedIds });
  })().catch(fail(res));
});

// معاينة/تفعيل المعلمين: active=true للجميع، وfirstLogin=false لمن ثبت دخولهن فقط.
// المعاينة افتراضية؛ التطبيق يتطلب apply=true ويستخدم معرّفات جدول users فقط.
app.post('/api/auth/admin/activate-teachers-safely', requireAuth, (req, res) => {
  (async () => {
    if (req.session.role !== 'ADMIN') return res.status(403).json({ error: 'forbidden' });
    const school = String(req.body && req.body.school || req.session.school || '').toUpperCase();
    if (!db.SCHOOLS.includes(school)) return res.status(400).json({ error: 'bad_school' });
    const apply = req.body && req.body.apply === true;
    const result = await db.activateTeachersSafely(school, apply);
    const activationCandidates = result.candidates.filter(item => item.activate);
    const firstLoginCandidates = result.candidates.filter(item => item.clearFirstLogin);
    res.json({
      ok: true,
      school,
      apply,
      teacherCount: result.candidates.length,
      activationCount: activationCandidates.length,
      firstLoginClearCount: firstLoginCandidates.length,
      activationIds: activationCandidates.map(item => item.id),
      firstLoginClearIds: firstLoginCandidates.map(item => item.id),
      updated: result.updated,
    });
  })().catch(fail(res));
});
// توليد كلمة مرور مؤقتة جديدة لكل معلم وإرجاع قائمة (الاسم، اسم المستخدم، كلمة المرور) ليتسلمها المدير
app.post('/api/auth/admin/export-credentials', requireAuth, (req, res) => {
  (async () => {
    if (req.session.role !== 'ADMIN') return res.status(403).json({ error: 'forbidden' });
    if (rateLimit('export', 10, 60 * 60 * 1000, req)) return res.status(429).json({ error: 'rate_limited' });
    const rows = await db.listAllUsers();
    const teachers = rows.filter(u => u.active !== false && u.role === 'TEACHER');
    const out = [];
    for (const u of teachers) {
      const temp = crypto.randomBytes(6).toString('hex').slice(0, 10);
      const hash = await bcrypt.hash(temp, BCRYPT_ROUNDS);
      await db.updateUserPasswordHash(u.id, hash, true);
      await db.updateUserPlainPassword(u.id, temp);
      await db.grantUserAccess(u.id);
      await updateSchoolUser(u.school, u.id, { firstLogin: true, granted: true });
      await db.deleteUserSessions(u.id);
      out.push({ id: u.id, name: u.name, username: u.username, email: u.email, role: u.role, school: u.school, tempPassword: temp });
    }
    res.json({ ok: true, count: out.length, credentials: out });
  })().catch(fail(res));
});

// عرض الرقم السري الحقيقي لأي حساب (المدير فقط) — يعتمد على plain_password المخزّن نصيًا
app.post('/api/auth/admin/show-password', requireAuth, (req, res) => {
  (async () => {
    if (req.session.role !== 'ADMIN') return res.status(403).json({ error: 'forbidden' });
    if (rateLimit('showpw', 30, 15 * 60 * 1000, req)) return res.status(429).json({ error: 'rate_limited' });
    const userId = String(req.body && req.body.userId || '');
    const target = await db.userById(userId);
    if (!target) return res.status(404).json({ error: 'not_found' });
    if (!canManageUsers(req.session, target.school)) return res.status(403).json({ error: 'forbidden' });
    const hashed = !!(target.password_hash);
    res.json({
      ok: true,
      userId: target.id,
      name: target.name,
      username: target.username,
      email: target.email,
      role: target.role,
      school: target.school,
      plainPassword: target.plain_password || '',
      hashed,
      message: target.plain_password ? '' : (hashed ? 'مشفّرة' : 'لا يوجد رقم سري'),
    });
  })().catch(fail(res));
});

// استلام ملف Excel (base64) من المتصفح وإرساله إلى بريد المدير عبر Brevo
app.post('/api/auth/admin/mail-credentials', requireAuth, (req, res) => {
  (async () => {
    if (req.session.role !== 'ADMIN') return res.status(403).json({ error: 'forbidden' });
    if (rateLimit('mailcreds', 10, 60 * 60 * 1000, req)) return res.status(429).json({ error: 'rate_limited' });
    const filename = String(req.body && req.body.filename || 'بيانات الدخول.xlsx').slice(0, 120);
    const b64 = String(req.body && req.body.file || '');
    if (!b64) return res.status(400).json({ error: 'missing' });
    const me = await db.userById(req.session.user_id);
    const myEmail = (me && me.email) || '';
    const to = /@(nibras|school|local|example|test)/i.test(myEmail)
      ? (process.env.ADMIN_NOTIFY_EMAIL || 'nassser8@gmail.com')
      : myEmail;
    const sent = await sendMailAttachment(to, 'نبراس — بيانات دخول المعلمين',
      '<div dir="rtl" style="font-family:Tahoma,Arial,sans-serif;max-width:520px;margin:auto;border:1px solid #e2e8f0;border-radius:12px;padding:24px;color:#1f2937">'
      + '<h2 style="color:#0f766e;margin:0 0 8px">نظام نبراس</h2>'
      + '<p>المرفق يحتوي <b>بيانات دخول المعلمين</b> (أسماء المستخدمين وكلمات المرور المؤقتة).</p>'
      + '<p>أبلغ كل معلم باسم المستخدم وكلمة المرور الخاصين به، وسيُطلب منه تغيير كلمة المرور وتعيين بريده الحقيقي عند أول دخول.</p>'
      + '<p style="color:#64748b;font-size:13px">إن لم تطلب هذا الملف، تجاهل الرسالة.</p>'
      + '</div>', filename, b64);
    res.json(sent ? { ok: true, emailedTo: to } : { ok: false, error: 'mail_failed', emailedTo: to });
  })().catch(fail(res));
});

/* ================= قائمة الحسابات للدخول (بلا أي كلمات مرور) ================= */
app.get('/api/auth/accounts', (req, res) => {
  db.listAllUsers().then(rows => {
    const accounts = rows
      .filter(u => u.active !== false)
      .map(u => ({ name: u.name, username: u.username, email: u.email, role: u.role, school: u.school }));
    res.json({ ok: true, accounts });
  }).catch(fail(res));
});

/* ================= /api/db (البيانات) ================= */
function schoolAccess(session, school) {
  if (session.role === 'ADMIN') return true;
  // «إداري شامل»: حسابات مخوّلة بإدارة طلاب كلا القسمين (بنين) مثلًا لتسجيل الغياب/التأخر
  if (session.data && session.data.allSchools) return true;
  return session.school === school;
}
function jsonEqual(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
// هل تغيير قسم المستخدمين مسموح لغير المدير/الوكيل؟
// يُستثنى حساب المستخدم نفسه من المقارنة (تحديثات تلقائية كـ lastSeenAt لا تتعارض مع نسخة العميل المتأخرة)
function usersSectionAllowedFor(role, selfId, prevUsers, nextUsers) {
  if (role === 'ADMIN' || role === 'AGENT') return true;
  const srt = arr => (arr || []).filter(u => u.id !== selfId).sort((a, b) => a.id < b.id ? -1 : 1);
  return jsonEqual(srt(prevUsers), srt(nextUsers));
}

// ===== دمج الأقسام عند وصول نسخة "قديمة" (stale) لئلا تُفقد تعديلات المعلمين =====
// المشكلة: النظام يختم القسم كاملاً بزمن واحد (_ts)، لذا إذا سجّل معلم آخر (أو كان ساعة
// الجهاز متأخرة) يُرفض الحفظ كاملاً ويضيع. هنا ندمج بدل رفضه: لكل قسم نمزج السجلات
// حسب المفتاح (id) أو المفتاح المضمّن (timetable) مع إبقاء نسخة الخادم الأحدث وكل
// إضافات الواصل — هكذا لا تضيع لا بيانات الخادم ولا تعديلات من يحفظ.
function mergeSection(prevVal, inVal) {
  // قسم الجدول: كائن متداخل teacherId -> day -> period -> {subject, classId}
  if (prevVal && typeof prevVal === 'object' && !Array.isArray(prevVal) &&
      inVal && typeof inVal === 'object' && !Array.isArray(inVal)) {
    return mergeTimetable(prevVal, inVal);
  }
  // بقية الأقسام مصفوفة تُدمج حسب id (الإضافات تُلحق، والتعارض يرجّح الواصل).
  // السجلات بلا id تُحفظ أيضاً بمفتاح مستقر (محتواها) كي لا تختفي سجلات قديمة.
  if (Array.isArray(prevVal) && Array.isArray(inVal)) {
    const keyOf = r => (r && typeof r === 'object' && r.id) ? r.id : '__anon:' + JSON.stringify(r);
    // قائمة منع دائمة: تكليفات معتمة (مثل «1» و«11» لعبدالله) مُحذوفة نهائياً لا يمكن لأي
    // جهاز قديم إعادة إحيائها مهما دفع نسخته — فلترة مباشرة قبل الدمج.
    const blockedKeys = new Set([
      'id_gmrt4bv0mtjke2qi', 'id_ualtqnkfmtjkhr43',
      // الأول الابتدائي: تكليفات حُذفت بأمر الإدارة (نقاطها السلبية تُحسب تلقائياً) —
      // وسمها deleted في القاعدة وفلترتها هنا يمنع الأجهزة القديمة من إحيائها.
      'id_5d17111nmtttorn5', 'id_wk9ojhlymtv7xr3g',
      'id_srbjht5ymts4tp8s', 'id_92j0tg1amtsejasl'
    ]);
    prevVal = prevVal.filter(r => !(r && typeof r === 'object' && blockedKeys.has(keyOf(r))));
    inVal = inVal.filter(r => !(r && typeof r === 'object' && blockedKeys.has(keyOf(r))));
    const tomb = new Set();
    for (const r of prevVal) { if (r && typeof r === 'object' && r.deleted) tomb.add(keyOf(r)); }
    const map = new Map();
    for (const r of prevVal) { if (r && typeof r === 'object') map.set(keyOf(r), r); }
    for (const r of inVal) {
      if (!r || typeof r !== 'object') continue;
      const k = keyOf(r);
      const localDeleted = !!r.deleted;
      // أسافين الحذف (deleted) تكون لاصقة: لا يُعاد إحياء سجل محذوف من جهاز قديم/منافس
      if (tomb.has(k)) continue;
      // إذا وصلت نسخة محذوفة (من جهاز يريد الحذف) نجعلها لاصقة ونُبقي شاهدها في التخزين
      // حتى يُرسل للعملاء عبر GET (يرى كل جهاز أنه محذوف فيحذفه محلياً) ولا يُعرض إطلاقاً.
      if (localDeleted) { tomb.add(k); map.set(k, r); continue; }
      map.set(k, r);
    }
    return Array.from(map.values());
  }
  // لا دمج ممكن: الأحدث (الواصل) يرجح إن كان من نوع الكائن/أو يرجح الموجودة
  return inVal !== undefined ? inVal : prevVal;
}
// ===== دمج التحويلات: الحذف لاصق والحلّ لا يُمحى =====
// mergeSection عامّ: الواصل يكسب، وهو كافٍ للأقسام التي لا تحمل تاريخاً. أما
// التحويل ففيه مساران لا يجوز أن يمحوهما جهاز قديم:
//   1) شاهد الحذف (deleted) — mergeSection يغطيه فعلاً (tomb لاصق).
//   2) الحلّ (solution + status=RESOLVED) — لا يغطيه mergeSection: نسخة جهاز
//      قدية بلا حل كانت تكتب فوق المحلول فتفقد اجتهاد من عالج الطلب، ويُظهر
//      التحويل «قيد المتابعة» من جديد. الحلّ يُنقل إن كان في الخادم وغاب عن
    // حلّان على جهازين: الأحدث (resolvedAt) يكسب أيّهما كان على الخادم.
//      دائماً فلا يُحيي حلٌّ محليٌّ تحويلاً محذوفاً.
function mergeTransfers(prev, incoming) {
  if (!Array.isArray(prev)) prev = [];
  if (!Array.isArray(incoming)) incoming = [];
  const base = mergeSection(prev, incoming);
  const prevById = new Map();
  for (const t of prev) if (t && t.id != null) prevById.set(String(t.id), t);
  const incById = new Map();
  for (const t of incoming) if (t && t.id != null) incById.set(String(t.id), t);
  const solveStamp = (x) => {
    if (!x) return 0;
    const ts = [x.resolvedAt, x.updatedAt, x.createdAt]
      .map((v) => Date.parse(v || '')).filter(Number.isFinite);
    return ts.length ? Math.max.apply(null, ts) : 0;
  };
  return base.map((t) => {
    if (!t || t.id == null || t.deleted === true) return t;
    const id = String(t.id);
    const p = prevById.get(id), inc = incById.get(id);
    // الحل في الخادم والوارد بلا حل ⇒ نحفظ الحل ولا ننتظر الدفعة التالية.
    if (p && p.solution && !(inc && inc.solution)) {
      return Object.assign({}, t, {
        solution: p.solution, status: p.status || 'RESOLVED',
        resolvedBy: p.resolvedBy, resolvedByName: p.resolvedByName,
        resolvedAt: p.resolvedAt,
      });
    }
    // حلّان على جهازين: الأحدث (resolvedAt) يكسب أيّهما كان على الخادم.
    if (p && p.solution && inc && inc.solution) {
      const newer = solveStamp(inc) > solveStamp(p) ? inc : p;
      return Object.assign({}, t, {
        solution: newer.solution, status: newer.status || 'RESOLVED',
        resolvedBy: newer.resolvedBy, resolvedByName: newer.resolvedByName,
        resolvedAt: newer.resolvedAt,
      });
    }
    return t;
  });
}
// ===== دمج رسائل المدير/الإشعارات (adminMsgs) =====
// دمج حسب id مع «إزالة تكرار المصدر»: تحويل/نشاط كان يُنشئ سابقاً نسختين متطابقتين
// (نفس transferId/partReqId لجهتين مرسلتين) فتبقى بعد دمجها رسالةٌ شقيقة بنفس المحتوى
// وتعاود الظهور بعد الضغط على «تم الاطلاع». نُبقي نسخة واحدة لكل مصدر — وللمراسلة
// العادية تكون بصمةُ المحتوى (المرسل+الهدف+النص) هي المصدر، فتتحد الشقائق المتطابقة.
// عند ضمّ الأخوات نُدمج الاطلاع/الإسقاط اتحاداً (لا نفقد إسقاط معلمٍ ضغطت) بدل
// اختيار الأحدث فقط — وإلا جاءت نسخةٌ شقيقةٌ بلا clearedBy فتعود الرسالة بعد الدخول.
function mergeAdminMsgs(prev, incoming) {
  if (!Array.isArray(prev)) prev = [];
  if (!Array.isArray(incoming)) incoming = [];
  const keyOf = r => (r && typeof r === 'object' && r.id) ? r.id : '__anon:' + JSON.stringify(r);
  const normTxt = (t) => String(t || '').replace(/\s+/g, ' ').trim().toLowerCase();
  const srcKeyOf = r => (r && typeof r === 'object')
    ? ((r.senderRole === 'TRANSFER' && r.transferId) ? 't:' + r.transferId
      : (r.senderRole === 'ACTIVITY' && r.partReqId) ? 'p:' + r.partReqId
      : 'm:' + (r.senderRole || '') + '|' + (r.teacherId || '') + '|' + normTxt(r.text))
    : 'm:' + keyOf(r);
  // ندمج أولاً حسب id ثم نضغط إخوة كل مصدر في نسخة اتحادية واحدة.
  const merged = mergeSection(prev, incoming);
  const bySrc = new Map();
  merged.forEach(m => {
    if (!m || typeof m !== 'object') return;
    const k = srcKeyOf(m);
    const cur = bySrc.get(k);
    if (!cur) { bySrc.set(k, m); return; }
    // الأخوات من نفس المصدر: اتحاد معرفات الاطلاع/الإسقاط + الأعلام لا تتراجع + أطوابع أحدث.
    const out = JSON.parse(JSON.stringify(cur));
    const cA = (cur && cur.clearedBy) || {}, cB = (m && m.clearedBy) || {};
    out.clearedBy = Object.assign({}, cB, cA);
    const sA = (cur && cur.seenBy) || {}, sB = (m && m.seenBy) || {};
    out.seenBy = Object.assign({}, sB, sA);
    for (const f of ['read','revealed','dismissed','deleted']) out[f] = !!(out[f] || m[f]);
    for (const f of ['updatedAt','editedAt','lastViewAt','dismissedAt','revealedAt','firstViewAt','createdAt','deletedAt']) {
      if (out[f] || m[f]) out[f] = String(m[f] || '') >= String(out[f] || '') ? (m[f] || out[f]) : (out[f] || m[f]);
    }
    bySrc.set(k, out);
  });
  return Array.from(bySrc.values());
}
// ===== دمج قسم الحضور: آخر-كتابة-يفوز حسب (studentId, date) على طابع _t =====
// كان الدمج العام حسب id فقط، فإذا دفع معلم/جهاز آخر نسخة قديمة تظهر الطالب (حاضر)
// تُستبدل نسخة الخادم ABSENT بموجب المفتاح id فيختفي الغياب بعد إعادة الفتح.
// هنا نحمي سجلّ الحضور: نُبقي السجلّ الأعلى زمناً (_t) عند تعارض (نفس الطالب/التاريخ)،
// وآخر-كتابة-يفوز عند قيام من يكتب فعلياً. السجلات بلا _t تُعامل كزمن 0.
function mergeAttendance(prev, incoming) {
  if (!Array.isArray(prev)) prev = [];
  if (!Array.isArray(incoming)) incoming = [];
  const keyOf = r => (r && typeof r === 'object' && r.id) ? r.id : '__anon:' + JSON.stringify(r);
  const tOf = r => (r && typeof r === 'object' && typeof r._t === 'number') ? r._t : 0;
  // الغياب/التأخر «معلومات حاسمة» — لا يمحوها تسجيلُ حُضورٍ اعتيادي (افتراضي/خطأ) من معلمٍ آخر
  // في الفصول المشتركة (عدة معلمين يفتحون نفس قائمة الطلاب). PRESENT أقل إفادة من ABSENT/LATE.
  const inf = r => (r && typeof r === 'object' && (r.status === 'ABSENT' || r.status === 'LATE')) ? 1 : 0;
  // الغيابُ «المعلَّق» (سجّله معلم واحد فقط — بانتظار معلمٍ ثانٍ): سجلٌّ افتراضي قابل للتصحيح
  // من صاحبِ التسجيل أو مديرٍ مخوَّل — الحاضرُ الأحدث زمناً (إلغاءٌ صريح) يهزمه، فيُحفَظ
  // الإلغاءُ حتى مع دمج أجهزة/معلمين (لا تُعاد الطالبُ غائبةً بعد محاولة الحذف). أما
  // الغيابُ المؤكَّد (مؤكِّدان فعليان أو سجلٌ قديم بشارة LEADY) فيبقى يفوز على الحاضر دائماً.
  const clerkCount = r => {
    if (!r || typeof r !== 'object') return 0;
    if (!Array.isArray(r.absClerks)) return r.status === 'ABSENT' ? 1 : 0; // قديم بلا قائمة = مؤكد
    return r.absClerks.filter(c => c && c !== LEGACY_ABS).length;
  };
  const __attIsPending = r => !!(r && typeof r === 'object' && r.status === 'ABSENT'
    && Array.isArray(r.absClerks) && r.absClerks.indexOf(LEGACY_ABS) === -1 && clerkCount(r) < 2);
  // اختيار السجل الفائز: الغائب/المتأخر على الحاضر مهما تقدم زمنه، وإلا الأعلى _t
  const better = (a, b) => {
    if (inf(a) !== inf(b)) {
      // استثناء الإلغاء الصريح: حضورٌ أحدث زمناً يهزم غياباً «معلَّقاً» أقدم (معلم واحد فقط)
      const absentSide = inf(a) === 1 ? a : b;
      const presentSide = absentSide === a ? b : a;
      if (__attIsPending(absentSide) && (typeof presentSide._t === 'number') && (typeof absentSide._t === 'number') && presentSide._t > absentSide._t) return presentSide;
      return inf(a) > inf(b) ? a : b;
    }
    return tOf(a) >= tOf(b) ? a : b;
  };
  // اتحاد قوائم مؤكِّدي الغياب: عند تطابق سجلّي غياب لنفس الطالب/اليوم (من معلّمين/أجهزة مختلفة)
  // ندمج absClerks (المجموعات) بدل إبقاء الفائز وحده — فلا تضيع تأكيدات تُجمِّع الغياب.
  const LEGACY_ABS = '__legacy_abs__';
  const unionClerks = (a, b) => {
    const win = better(a, b);
    if (!win || win.status !== 'ABSENT') return win;
    if (!Array.isArray(a.absClerks) && !Array.isArray(b.absClerks)) return win;
    const clerks = [];
    const add = c => { if (c && clerks.indexOf(c) === -1) clerks.push(c); };
    [a, b].forEach(r => {
      if (!r || r.status !== 'ABSENT') return;
      if (Array.isArray(r.absClerks)) r.absClerks.forEach(add);
      else add(LEGACY_ABS); // سجل قديم بلا قائمة = غياب مؤكد سابقاً
    });
    const out = Object.assign({}, win);
    out.absClerks = clerks;
    return out;
  };
  const tomb = new Set();
  for (const r of prev) { if (r && typeof r === 'object' && r.deleted) tomb.add(keyOf(r)); }
  // المرحلة 1: دمج حسب id — الغائب/المتأخر يفوز على الحاضر، وإلا آخر-كتابة-يفوز على _t
  const map = new Map();
  for (const r of prev) { if (r && typeof r === 'object') map.set(keyOf(r), r); }
  for (const r of incoming) {
    if (!r || typeof r !== 'object') continue;
    const k = keyOf(r);
    if (tomb.has(k)) continue;
    const ex = map.get(k);
    if (!ex) { map.set(k, r); continue; }
    // قفل الحذف (تومبستون) ألصق: لا يُعاد إحياء
    if ((r.deleted || ex.deleted)) { if (r.deleted) map.set(k, r); continue; }
    map.set(k, unionClerks(r, ex));
  }
  // المرحلة 2: إزالة التكرار حسب (studentId|date) — نفس قاعدة الاختيار (الغائب يفوز)
  const bySD = new Map();
  const all = Array.from(map.values());
  const result = [];
  for (const r of all) {
    if (!r || typeof r !== 'object') { result.push(r); continue; }
    const sd = (r.studentId || '') + '|' + (r.date || '');
    if (!sd) { result.push(r); continue; }
    const cur = bySD.get(sd);
    if (!cur) { bySD.set(sd, r); result.push(r); continue; }
    const idx = result.indexOf(cur);
    const win = unionClerks(r, cur);
    if (win !== cur) { result[idx] = win; bySD.set(sd, win); }
  }
  return result;
}

// ===== دمج الأنشطة عميقاً: لا تمحو نسخة قديمة من جهازٍ آخر طلباتِ المشاركة المضافة حديثاً =====
// كل نشاط يحتوي requests[] (طلبات مشاركة المعلمين) وparticipants[] (المعتمدون) وeventTime..
// عندما يفتح معلمٌ/جهازٌ قديم يملك نسخة سابقة بلا الطلب الجديد ويدفعها، كان الدمج القديم حسب id
// يستهلك كائن النشاط كاملاً فيُفقد الطلب من قاعدة البيانات. الدمج هنا:
//   - للمصفوفات requests/participants: دمج عناصرها حسب id (الإضافات تُلحق، لا شيء يُحذف).
//   - لبقية الحقول (الحقول النصية/الزمن): آخر-كتابة-يفوز بالـ _v إن وُجد وإلا بالواصل.
function mergeActivities(prevActs, inActs) {
  if (!Array.isArray(prevActs)) prevActs = [];
  if (!Array.isArray(inActs)) inActs = [];
  const keyOf = r => (r && typeof r === 'object' && r.id) ? r.id : '__anon:' + JSON.stringify(r);
  const vOf = r => (r && typeof r === 'object' && typeof r._v === 'number') ? r._v : 0;
  const mergeList = (prev, inc) => {
    if (!Array.isArray(prev)) prev = [];
    if (!Array.isArray(inc)) inc = [];
    const tomb = new Set();
    for (const r of prev) if (r && typeof r === 'object' && r.deleted) tomb.add(keyOf(r));
    const map = new Map();
    for (const r of prev) if (r && typeof r === 'object') map.set(keyOf(r), r);
    for (const r of inc) {
      if (!r || typeof r !== 'object') continue;
      const k = keyOf(r);
      if (tomb.has(k)) continue;
      if (r.deleted) { tomb.add(k); map.set(k, r); continue; }
      map.set(k, r);
    }
    return Array.from(map.values());
  };
  const tomb = new Set();
  for (const a of prevActs) if (a && typeof a === 'object' && a.deleted) tomb.add(keyOf(a));
  const map = new Map();
  for (const a of prevActs) if (a && typeof a === 'object') map.set(keyOf(a), a);
  for (const a of inActs) {
    if (!a || typeof a !== 'object') continue;
    const k = keyOf(a);
    if (tomb.has(k)) continue;
    if (a.deleted) { tomb.add(k); map.set(k, a); continue; }
    const ex = map.get(k);
    if (!ex) { map.set(k, JSON.parse(JSON.stringify(a))); continue; }
    const merged = JSON.parse(JSON.stringify(ex));
    if (a.requests || ex.requests) merged.requests = mergeList(ex.requests, a.requests);
    if (a.participants || ex.participants) merged.participants = mergeList(ex.participants, a.participants);
    for (const key of Object.keys(a)) {
      if (key === 'id' || key === 'requests' || key === 'participants') continue;
      merged[key] = a[key];
    }
    if (typeof a._v === 'number') merged._v = a._v;
    map.set(k, merged);
  }
  return Array.from(map.values());
}

// ===== دمج الفصول بعمق: لا تضيع إسنادَات المعلمين (teacherIds) من نسخة قديمة لجهازٍ آخر =====
// لمحة: ابتداءً من v40 أصبح إسَناد المعلم للفصول عملياً متكرراً (حتى كلاً بعدد معلمين يظهر لكل فصل).
// القائمة teacherIds عناصرها سلاسل (لا كائنات)، لذا بدل دمجٍ حسب id لسلاسل (لا معنى) — ندمج
// كمجموعة: اتحاد عناصر الخادم والواصل يُبقى كل الإسنادات المعروفة (لا يُحذف من نسخة قديمة)،
// وحذفُ الإسناد مقصودٌ يُوجَّه بإزاحة سطر الفصل وإنقاص المجموعة من الجهة الأحدث فحسب —
// الشباك نافذة زمنية ضيقة، والتيار الغالب هو إسنادات تُضاف ولا تُوجد حاجة لنسخة قديمة تُنقِصها.
function mergeClasses(prevCls, inCls) {
  if (!Array.isArray(prevCls)) prevCls = [];
  if (!Array.isArray(inCls)) inCls = [];
  const keyOf = r => (r && typeof r === 'object' && r.id) ? r.id : '__anon:' + JSON.stringify(r);
  const tomb = new Set();
  for (const r of prevCls) { if (r && typeof r === 'object' && r.deleted) tomb.add(keyOf(r)); }
  const map = new Map();
  for (const r of prevCls) { if (r && typeof r === 'object') map.set(keyOf(r), JSON.parse(JSON.stringify(r))); }
  for (const r of inCls) {
    if (!r || typeof r !== 'object') continue;
    const k = keyOf(r);
    if (tomb.has(k)) continue;
    if (r.deleted) { tomb.add(k); map.set(k, JSON.parse(JSON.stringify(r))); continue; }
    const ex = map.get(k);
    if (!ex) { map.set(k, JSON.parse(JSON.stringify(r))); continue; }
    // اتحاد teacherIds: الإسنادات من كلا الطرفين تبقى — لا تُحذف إسناد لأي جهة قديمة/منافِسة
    const merged = JSON.parse(JSON.stringify(r));
    const ids = new Set(Array.isArray(ex.teacherIds) ? ex.teacherIds : []);
    for (const id of (Array.isArray(r.teacherIds) ? r.teacherIds : [])) if (id) ids.add(id);
    // removedTeacherIds (من أي جهة يحملها في نسخته): إزالات مقصودة تُحترم عبر الأقسام،
    // وحقل الفصل نفسه (removedTeacherIds) يبقى في نسخة الخادم حتى لو لَم يحمله الواصل.
    const removed = new Set(Array.isArray(ex.removedTeacherIds) ? ex.removedTeacherIds : []);
    for (const id of (Array.isArray(r.removedTeacherIds) ? r.removedTeacherIds : [])) if (id) removed.add(id);
    for (const id of removed) ids.delete(id);
    // قاعدة الحق في الإعادة: الظهور الصريح/الجديد للمعلم في teacherIds الواصل (من جهاز
    // يريد فعلياً إعادة إسناده — مثل addTeacherToClass) يتغلب على سجل الحذف، ولو كان
    // الحذف مسجلاً لدى الخادم مسبقاً. يعاد إضافته إلى ids ويُزال من removed.
    for (const id of (Array.isArray(r.teacherIds) ? r.teacherIds : [])) {
      if (id && removed.has(id)) { removed.delete(id); ids.add(id); }
    }
    for (const id of removed) ids.delete(id);
    merged.teacherIds = Array.from(ids);
    merged.removedTeacherIds = Array.from(removed);
    // للحقول المتبقية: آخر-كتابة-يفوز على _v (وإلا الواصل) — كالأنشطة
    const vOf = x => (typeof x._v === 'number') ? x._v : 0;
    if ((typeof ex._v === 'number') && vOf(r) < vOf(ex)) {
      for (const [key, val] of Object.entries(ex)) {
        if (key === 'id' || key === 'teacherIds' || key === 'removedTeacherIds') continue;
        if (!(key in merged)) merged[key] = val;
        else if (key === '_v') merged[key] = ex[key];
      }
    }
    if (typeof ex._v === 'number') merged._v = ex._v;
    map.set(k, merged);
  }
  return Array.from(map.values());
}

// حارس الفصول المكررة (يعمل على النتيجة النهائية قبل الحفظ): يحوّل أي صف مكرر إلى شاهد حذف
function dedupeClasses(data){
  const classes = data && data.classes;
  if (!Array.isArray(classes)) return;
  const gradeList = Array.isArray(data.grades) ? data.grades.filter(g => g && g.id) : [];
  const gradeIds = new Set(gradeList.map(g => g.id));
  // A stage may be stored under a different id than stages[].id (older rows, imported
  // snapshots), and older class rows carry the stage in grade/stage/stageId/section
  // instead of gradeId. Resolve the stage by id first, then by those legacy fields,
  // so a class is not buried just because its stage id differs while the stage itself
  // is plainly present under another id.
  const tok = v => String(v == null ? '' : v).replace(/[\u064B-\u0652\u0670\u0640]/g, '').replace(/\s+/g, ' ').trim();
  const gradeTokens = new Set();
  for (const g of gradeList) { gradeTokens.add(tok(g.id)); const n = tok(g.name); if (n) gradeTokens.add(n); }
  const resolves = c => {
    if (c.gradeId && gradeIds.has(c.gradeId)) return true;
    for (const k of ['grade', 'stage', 'stageId', 'section']) {
      const t = tok(c[k]);
      if (t && gradeTokens.has(t)) return true;
    }
    return false;
  };
  const keyOf = c => ((c.gradeId || '') + '|' + (c.name || '') + '|' + (c.campus || ''));
  const seen = new Set();
  for (const c of classes) {
    if (!c || typeof c !== 'object' || c.deleted) continue;
    if (!resolves(c)) { c.deleted = true; continue; }
    const k = keyOf(c);
    if (seen.has(k)) { c.deleted = true; continue; }
    seen.add(k);
  }
}

function mergeTimetable(prev, inb) {
  const out = {};
  const keys = new Set([...Object.keys(prev || {}), ...Object.keys(inb || {})]);
  for (const tid of keys) {
    const a = prev && prev[tid];
    const b = inb && inb[tid];
    if (!a && !b) continue;
    // كائن فارغ {} قد يصل من جهاز قديم/ذرة جديدة — لا يمحو أبداً جدولاً محفوظاً
    if (!a || !Object.keys(a).length) { out[tid] = b || a; continue; }
    if (!b || !Object.keys(b).length) { out[tid] = a; continue; }
    const days = new Set([...Object.keys(a), ...Object.keys(b)]);
    const mergedDays = {};
    for (const day of days) {
      const da = a[day], db = b[day];
      if (!da || !db) { mergedDays[day] = da || db; continue; }
      // يوم فارغ في أي جهة لا يمسح حصص اليوم المحفوظة
      if (!Object.keys(da).length) { mergedDays[day] = db; continue; }
      if (!Object.keys(db).length) { mergedDays[day] = da; continue; }
      const periods = new Set([...Object.keys(da), ...Object.keys(db)]);
      const mergedPeriods = {};
      for (const pp of periods){
        const prevCell = da[pp];
        const inCell = db[pp];
        if (inCell === undefined){ mergedPeriods[pp] = prevCell; continue; }
        // شاهد قبر الحذف {_del} لاصق: الخلية المحذوفة لا تعود حتى من جهاز أقدم،
        // ولا تُعطى إلا برقم إصدار أعلى (إعادة إضافة مقصودة من الجهاز الذي رأى الحذف).
        if (inCell && inCell._del){ mergedPeriods[pp] = inCell; continue; }
        if (prevCell && prevCell._del){
          const pv = (typeof prevCell._v === 'number') ? prevCell._v : 0;
          const iv = (typeof inCell._v === 'number') ? inCell._v : 0;
          mergedPeriods[pp] = (iv > pv) ? inCell : prevCell;
          continue;
        }
        mergedPeriods[pp] = inCell;
      }
      mergedDays[day] = mergedPeriods;
    }
    out[tid] = mergedDays;
  }
  return out;
}

// ===== دمج قسم الطلاب الخاص بالمعلم: يسمح للمعلم بتحديث حصرياً حقول التأخر
// (lateMinutes/lateType) على طلابه عند تسجيل الحضور، دون أن يُرفض حفظه كاملاً
// (كان `saveAttendance` يعدّل students فترفض الواجهة/الخادم الحفظ ب403)،
// ودون أن يمسح أي حقول أخرى يملكها المدير/المرشد لبقية الطلاب. =====
function mergeStudentsLateOnly(prevStudents, inStudents) {
  if (!Array.isArray(prevStudents)) prevStudents = [];
  if (!Array.isArray(inStudents)) inStudents = [];
  const map = new Map((prevStudents || []).map(s => [s && s.id, s]));
  for (const s of inStudents) {
    if (!s || !s.id) continue;
    const p = map.get(s.id);
    if (!p) { map.set(s.id, s); continue; } // طالب جديدة: نُبقيها ونضيفها (بدل إسقاط إضافة المدير حديثاً) // لا ينشئ المعلم طلاباً
    // دمج حقول التأخر فقط
    if (s.lateMinutes && typeof s.lateMinutes === 'object') p.lateMinutes = s.lateMinutes;
    if (s.lateType && typeof s.lateType === 'object') p.lateType = s.lateType;
    map.set(s.id, p);
  }
  return Array.from(map.values());
}

// ===== حقول حضور المعلمين/الإداريين داخل سجلّ المستخدم =====
// غياب/تأخر المعلم والإداري ليسا قسماً مستقلاً، بل حقول على كائن المستخدم
// (absences/markedLate/lateMinutes/lateType). يسمح هذا الدمج لأدوار مدرسية
// (وكيل الشؤون المدرسية) بتسجيل حضور المعلمين/الإداريين فقط، دون أن تمسّ
// أي حقل حساس آخر في الحساب (الدور، كلمة المرور، الإلغاء، الاسم...).
const USER_ATTENDANCE_FIELDS = ['absences', 'markedLate', 'lateMinutes', 'lateType'];
function attTsOf(u) {
  const v = u && u._attTs;
  return (typeof v === 'number' && isFinite(v)) ? v : null;
}
function mergeUsersAttendanceOnly(prevUsers, inUsers) {
  if (!Array.isArray(prevUsers)) prevUsers = [];
  if (!Array.isArray(inUsers)) inUsers = [];
  // نبدأ من نسخة الخادم كما هي: أي حقل لا يُرسل هنا يبقى كما هو على الخادم.
  const map = new Map(prevUsers.map(u => [u && u.id, Object.assign({}, u)]));
  for (const u of inUsers) {
    if (!u || !u.id) continue;
    const p = map.get(u.id);
    // حساب غير موجود على الخادم: يُتجاهل تماماً (لا إضافة ولا حذف حسابات).
    if (!p) continue;
    const inTs = attTsOf(u), prevTs = attTsOf(p);
    if (prevTs !== null && (inTs === null || inTs < prevTs)) continue;
    for (const f of USER_ATTENDANCE_FIELDS) {
      const v = u[f];
      if (Array.isArray(v)) p[f] = v.filter(x => typeof x === 'string');
      else if (v && typeof v === 'object') p[f] = Object.assign({}, v);
      else delete p[f];
    }
    if (inTs !== null) p._attTs = inTs;
  }
  return Array.from(map.values());
}
function mergeUsersAttendanceNewer(prevUsers, inUsers) {
  if (!Array.isArray(prevUsers)) return Array.isArray(inUsers) ? inUsers : [];
  if (!Array.isArray(inUsers)) return prevUsers;
  const map = new Map(prevUsers.map(u => [u && u.id, u]));
  const out = inUsers.map(u => {
    if (!u || !u.id) return u;
    const p = map.get(u.id);
    if (!p) return u;
    const inTs = attTsOf(u), prevTs = attTsOf(p);
    if (prevTs === null || (inTs !== null && inTs >= prevTs)) return u;
    const w = Object.assign({}, u);
    w.absences = Array.isArray(p.absences) ? p.absences.slice() : [];
    w.markedLate = Array.isArray(p.markedLate) ? p.markedLate.slice() : [];
    w.lateMinutes = Object.assign({}, p.lateMinutes || {});
    w.lateType = Object.assign({}, p.lateType || {});
    w._attTs = prevTs;
    return w;
  });
  return out;
}

// نظام BOYS فقط: لا يوجد «قسم آخر» — أُزيل حارس التلوث المتقاطع بين القسمين
// (كان يمنع 409 خلط accounts البنين بالبنين، ولم يعد له معنى بقسم واحد).

// ===== مطابقة جدول المستخدمين (المصادقة) مع نسخة بيانات القسم بعد كتابة قسم users =====
async function reconcileUserTable(school, prevUsers, nextUsers) {
  // تصحيح الفعّل الإجباري قبل أي مقارنة: أي نسخة (من أي جهاز) تحاول تعطيل حساب
  // مُفعّل إجبارياً تُصحَّح فوراً — يحمي الحسابَ دون التأثير في بقية الحسابات.
  if (nextUsers) {
    let forcedChanged = false;
    for (const n of nextUsers) {
      if (n && FORCE_ACTIVE.has(n.id) && n.active === false) { n.active = true; forcedChanged = true; }
    }
    if (forcedChanged && school) {
      // تعديل على الصف المقفول (نفس سبب تحديث المستخدمين أعلاه) — لا لقطة كاملة قديمة.
      await db.mutateSchoolData(school, (d) => {
        if (!d || !Array.isArray(d.users)) return { changed: false, value: false };
        let hit = false;
        for (const u of d.users) {
          if (u && FORCE_ACTIVE.has(u.id) && u.active === false) { u.active = true; hit = true; }
        }
        return { changed: hit, value: hit };
      });
    }
  }
  const nextMap = new Map((nextUsers || []).map(u => [u.id, u]));
  const prevMap = new Map((prevUsers || []).map(u => [u.id, u]));
  for (const p of (prevUsers || [])) {
    const n = nextMap.get(p.id);
    if (!n) {
      // أُزيل من بيانات هذا القسم = محذوف (نظام قسم واحد، لا يوجد نقل إلى قسم آخر)
      await db.deactivateUser(p.id);
      continue;
    }
    const tbl = await db.userById(p.id);
    if (!tbl) continue;
    if ((tbl.active ? true : false) !== (n.active !== false)) await db.setUserActive(p.id, n.active !== false);
    if (n.email && tbl.email !== n.email) await db.updateUserIdentity(p.id, { email: n.email });
    if (n.name && tbl.name !== n.name) await db.updateUserIdentity(p.id, { name: n.name });
    if (n.username && tbl.username !== n.username) await db.updateUserIdentity(p.id, { username: n.username });
  }
  // مستخدم جديد في بيانات هذا القسم (مثلاً منقول إليه): إعادة تفعيل حسابه وتصحيح قسمه
  for (const n of (nextUsers || [])) {
    if (prevMap.has(n.id)) continue;
    const tbl = await db.userById(n.id);
    if (!tbl) continue;
    await db.setUserSchool(n.id, school);
    await db.setUserActive(n.id, n.active !== false);
    if (n.email && tbl.email !== n.email) await db.updateUserIdentity(n.id, { email: n.email });
  }
}

app.get('/api/db/:school', requireAuth, (req, res) => {
  (async () => {
    const school = String(req.params.school).toUpperCase();
    if (!db.SCHOOLS.includes(school)) return res.status(400).json({ error: 'bad_school' });
    if (!schoolAccess(req.session, school)) return res.status(403).json({ error: 'forbidden' });
    const rec = await db.getSchoolData(school);
    if (!rec.data) return res.json({ ts: 0, data: null });
    // احقن إحصاءات الدخول الموثوقة من جدول الحسابات (مصدر الحقيقة) في نسخة القسم،
    // حتى لو اختلفت معرّفات/إحصاءات local storage لدى المتصفحات. المطابقة بالمعرّف ثم باسم المستخدم.
    if (Array.isArray(rec.data.users) && rec.data.users.length) {
      const stats = await db.usersForLoginStats(school);
      const byId = new Map();
      const byLower = new Map();
      const byEmail = new Map();
      for (const t of stats) {
        byId.set(t.id, t);
        if (t.username) byLower.set(String(t.username).toLowerCase(), t);
        if (t.email) byEmail.set(String(t.email).toLowerCase(), t);
      }
      const overlay = (u, t) => {
        const d = t.data || {};
        // حالة «أول دخول» إلزامية من جدول الحسابات (مصدر الحقيقة) حتى لو بقي متصفح قديم
        // يدفع علامة قديمة، فعند أي سحب تظهر الحالة الصحيحة لجهاز المدير.
        u.firstLogin = !!t.first_login;
        // حقن إحصاءات الدخول الفعلية فقط (دخول حقيقي مسجّل)، لا نلمس المعرّف
        if (!d) return;
        const hasLogin = !!d.lastLogin || (d.loginCount || 0) > 0;
        if (!hasLogin) return;
        if (d.lastLogin) u.lastLogin = d.lastLogin;
        if (d.loginCount) u.loginCount = d.loginCount;
        if (Array.isArray(d.loginHistory)) u.loginHistory = d.loginHistory;
      };
      const seen = new Set();
      rec.data.users = rec.data.users.map(u => {
        const t = byId.get(u.id) || (u.username ? byLower.get(String(u.username).toLowerCase()) : null)
          || (u.email ? byEmail.get(String(u.email).toLowerCase()) : null);
        if (t) { seen.add(t.id); overlay(u, t); }
        return u;
      });
    }
    // ===== خصوصية الملاحظات: تُصفّى سطرياً هنا، فلا تُرجَع أصلاً للغير المخوّل =====
    // قبل: كانت data.notes تُرسل كاملةً لكل من له صلاحية المدرسة، فترى كل معلم
    // نصّ ملاحظات زميلاتها. الآن: الإدارة (ADMIN/AGENT) ترى الكل، وكل دور آخر
    // يرى ملاحظاته فقط (createdBy = sessions.user_id). ملاحظة بلا createdBy صالح
    // تبقى «غير مملوكة» حصراً عند الإدارة — لا حذف ولا إسناد بالاسم.
    const viewer = { role: req.session.role, user_id: req.session.user_id };
    // ===== أرصدة النقاط أولاً: من المخزون الكامل قبل أي تصفية =====
    // الترتيب مقصود: نقاط الطالب تُحسب في الواجهة من pointItems() على النسخة
    // الكاملة. فلو فلترنا أولاً لأصبح المجموع ناقصاً بقدر ما كتبته الزميلات، وهو
    // عكس المطلوب تماماً. لذلك نحسب ثم نُصفّي.
    let pointsTotals = null;
    try {
      const stCut = await db.getSchoolSettings(school);
      const cutDate = (stCut.pointsStartFrom || '2026-09-07').slice(0, 10);
      pointsTotals = notePrivacy.computePointsTotals(rec.data, cutDate);
    } catch (e) {
      console.warn('[note-privacy] تعذّر حساب أرصدة النقاط:', e.message);
    }
    if (Array.isArray(rec.data.notes)) {
      const before = rec.data.notes.length;
      rec.data.notes = notePrivacy.filterNotesForViewer(rec.data.notes, viewer);
      if (rec.data.notes.length !== before) {
        console.log('[note-privacy] رُشّحت الملاحظات لـ', school, '| دور:', viewer.role,
          '| من', before, 'إلى', rec.data.notes.length);
      }
    }
    // ===== خصوصية التحويلات: من أرسل التحويل + طبقة الإشراف ترى، وغيرها لا =====
    // التحويلات كانت تُرسَل كاملة لكل جهاز: كل معلم تسحب تحويلات زميلاتها
    // (أسماء طلاب وأسباب تحويل). القاعدة على الاستجابة لا على الواجهة — وإلا
    // بقيت البيانات في تخزين المتصفح قابلة للاستخراج.
    if (Array.isArray(rec.data.transfers)) {
      const tBefore = rec.data.transfers.length;
      rec.data.transfers = transferPrivacy.filterTransfersForViewer(rec.data.transfers, viewer);
      if (rec.data.transfers.length !== tBefore) {
        console.log('[transfer-privacy] رُشّحت التحويلات لـ', school, '| دور:', viewer.role,
          '| من', tBefore, 'إلى', rec.data.transfers.length);
      }
    }
    // الحقل يُرسَل كمصدر موحّد لأرقام النقاط؛ إن فشل الحساب نُرسل null فيقرأ
    // فيعود العميل للحساب المحلي بدل عرض أرقام ناقصة.
    rec.data.pointsTotals = pointsTotals;
    // أسافين الحذف (deleted) تُرسل للعملاء كشواهد حذف: هكذا يعرف كل جهازٍ التكليفات
    // المحذوفة فيحذفها محلياً (لا تُصفّى هنا — التصفية للعرض تتم في loadDB داخل العميل).
    // إرسالها يضمن انتشار الحذف عبر كل الأجهزة مهما احتفظ بعضها بنسخة قديمة.
    res.json({ ts: rec.ts, data: ensureDataSections(rec.data) });
  })().catch(fail(res));
});

// ===== سلامة الأقسام: كل قسم في التطبيق مصفوفة، ولا تُسلَّم نسخة ناقصة =====
// النسخة القديمة الناقصة مفتاحاً كانت تُسلَّم للعميل كما هي، فيرمي بناء الصفحة
// استثناءً وتظهر شاشة بيضاء. الناقص يُؤخذ من نسخة الخادم السابقة إن وُجدت،
// وإلا فقائمة فارغة — لا حذف ولا محو: ما لا وجود له عندنا لا وجود له عند غيرنا.
const DATA_SECTION_KEYS = ['users','grades','classes','students','attendance','notes','transfers','maintenance','adminMsgs','announcements','suggestions'];
function ensureDataSections(data, prev){
  if(!data || typeof data !== 'object' || Array.isArray(data)) return data;
  for(const k of DATA_SECTION_KEYS){
    if(Array.isArray(data[k])) continue;
    data[k] = (prev && Array.isArray(prev[k])) ? JSON.parse(JSON.stringify(prev[k])) : [];
  }
  return data;
}

// ===== تطبيع المعلمين المكررة (مركزي، يُستدعى عند كل حفظ/تنظيف) =====
// مشكلة تكرار معلم واحدة بمعرّفين (نسخة قديمة + جديدة). لكل اسم مستخدم نُبقي المعرّف
// الموجود في جدول users (المصدر الموثوق للمصادقة) ونحوّل الباقي لـ«تومبستون» deleted:true
// لاصق بالمعرّف اليتيم الأصلي (يمنع أي جهاز قديم يعيد إحياءه)، ونعيد توجيه كل مرجعات اليتيم
// (تيميتابل/فصول/حضور/ملاحظات...) نحو الحقيقي كي لا تضيع جداول الواصلة.
async function normalizeTeacherDuplicates(school, data) {
  if (!data || !Array.isArray(data.users)) return { remapped: 0, dropped: 0 };
  const tRows = await db.pool.query(`SELECT id FROM users WHERE school=$1`, [school]);
  const tableIds = new Set(tRows.rows.map(r => r.id));
  const live = data.users.filter(u => u && u.deleted !== true);
  const byName = {};
  for (const u of live) (byName[u.username] = byName[u.username] || []).push(u);
  // (المعرّف في جدول users) -> أول يتيم ضُمّ إليه
  const canonToOrphan = {};
  for (const list of Object.values(byName)) {
    if (list.length <= 1) continue;
    const canonical = list.find(u => tableIds.has(u.id)) || list[0];
    for (const u of list) if (u !== canonical && !canonToOrphan[canonical.id]) canonToOrphan[canonical.id] = u.id;
  }
  // إعادة توجيه المرجعات: canonical id هو المصير، واليتيم يُستبدل به في كامل الـ data
  const remap = {};
  for (const canonicalId of Object.keys(canonToOrphan)) remap[canonToOrphan[canonicalId]] = canonicalId;
  // بناء قائمة المستخدمين النهائية من الـ live (قبل الريماب) حتى تحمل التوابة المعرّف اليتيم
  const out = [];
  const seen = new Set();
  for (const u of live) {
    if (!u) continue;
    const nm = String(u.username || '');
    const canonical = (byName[nm] || []).find(x => x && tableIds.has(x.id)) || (byName[nm] || [])[0];
    const isCanon = canonical && canonical.id === u.id;
    if (!nm || !isCanon || seen.has(nm)) {
      out.push(Object.assign({}, u, { deleted: true }));
      continue;
    }
    seen.add(nm);
    out.push(u);
  }
  const dropped = live.length - out.filter(u => u && u.deleted !== true).length;
  data.users = out;
  const remapped = Object.keys(remap).length ? remapJsonRefs(data, remap) : 0;
  return { remapped, dropped };
}
// إعادة توجيه معرّفات يتيمة في كل أقسام data ما عدا users (التي سبق بناؤها)
function remapJsonRefs(data, remap) {
  const saved = data.users;
  data.users = [];
  let json = JSON.stringify(data);
  for (const [oldId, newId] of Object.entries(remap)) {
    json = json.replace(new RegExp(String(oldId).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), newId);
  }
  const patched = JSON.parse(json);
  for (const k of Object.keys(patched)) data[k] = patched[k];
  data.users = saved;
  return Object.keys(remap).length;
}

app.put('/api/db/:school', requireAuth, (req, res) => {
  (async () => {
    if (rateLimit('dbwrite', 180, 60 * 1000, req)) return res.status(429).json({ error: 'rate_limited' });
    const school = String(req.params.school).toUpperCase();
    if (!db.SCHOOLS.includes(school)) return res.status(400).json({ error: 'bad_school' });
    if (!schoolAccess(req.session, school)) return res.status(403).json({ error: 'forbidden' });
    if (req.session.first_login) return res.status(403).json({ error: 'change_password_first' });

    let data = req.body && req.body.data;
    if (!data || typeof data !== 'object' || Array.isArray(data))
      return res.status(400).json({ error: 'invalid_payload' });
    for (const k of ['users','grades','classes','students','attendance','notes','transfers','maintenance']) {
      if (!Array.isArray(data[k])) return res.status(400).json({ error: 'invalid_section:' + k });
    }
    // أقسام الرسائل/الإعلان/الاقتراحات: أجهزة أقدم لا ترسلها بعد — تُعامَل كفارغة دون رفض الحفظ.
    for (const k of ['adminMsgs','announcements','suggestions']) {
      if (data[k] === undefined) data[k] = [];
      else if (!Array.isArray(data[k])) return res.status(400).json({ error: 'invalid_section:' + k });
    }
    // pointsTotals حقل مشتقّ: الخادم يحسبه ويعرضه، ولا يُكتب من أي جهاز. نُسقطه
    // من الوارد عند الاستقبال لا عند الدمج فقط، لأن مسار الاستبدال الكامل
    // (المدير/الوكيل، نسخة غير قديمة) لا يمرّ بـ applyMerged أصلاً.
    delete data.pointsTotals;
    const ts = Number(req.body.ts) || Date.now();
    // ===== تطبيع المعلمين المكررة عند الحفظ: أي جهاز كان (حتى نسخة قديمة) تمر قائمة
    // users بترتيب يحذف المعرّف اليتيم لصالح المعرّف الحقيقي + إعادة توجيه مرجعاته.
    // ننفذ على النسخة الواصلة قبل كل الحمايات حتى يرى المُدمج قائمة نقية.
    try {
      await normalizeTeacherDuplicates(school, data);
    } catch (e) { console.warn('[normalizeTeacherDuplicates]', e.message); }
    const prev = await db.getSchoolData(school);
    const prevUsers = (prev.data && Array.isArray(prev.data.users)) ? prev.data.users : [];
    // ===== حارس ضد المسح الفارغ (wipe-guard) =====
    // متصفح/جهاز جديد يفتح التطبيق أول مرة يكون تخزينه المحلي فارغاً، ومع خوارزميات
    // الوقت القديمة يُرى «أحدث» فيدفع القسم فارغاً فيمسح قسمَ المدرسة كله (users=students=classes=0).
    // نرفض كتابةً تفرّغ قسماً كان ممتلئاً — لا يجوز رمياً أن يختفي القسم كاملاً بهذه الطريقة.
    const nowUsers = Array.isArray(data.users) ? data.users : [];
    const nowStudents = Array.isArray(data.students) ? data.students : [];
    const nowClasses = Array.isArray(data.classes) ? data.classes : [];
    const wasFull = prevUsers.length > 0
      || ((prev.data) && Array.isArray(prev.data.students) && prev.data.students.length > 0);
    const nowEmptyAll = nowUsers.length === 0 && nowStudents.length === 0 && nowClasses.length === 0;
    if (prevUsers.length > 0 && nowUsers.length === 0) {
      console.warn('[wipe-guard] رفض تفريغ قسم users لـ', school, 'من', req.session && req.session.role || '?', 'ts=', ts);
      return res.status(409).json({ error: 'wipe_blocked', reason: 'users' });
    }
    if (wasFull && nowEmptyAll) {
      console.warn('[wipe-guard] رفض تفريغ قسم كامل لـ', school, 'من', req.session && req.session.role || '?', 'ts=', ts);
      return res.status(409).json({ error: 'wipe_blocked', reason: 'full_section' });
    }
    // "قديمة": وصول نسخة بزمن أقل مما لدى الخادم (حفظ معلم آخر/فرق ساعة الأجهزة).
    // بدلاً من رفضها فتضيع تعديلات من يحفظ، ندمجها لاحقاً (مزج حسب المفتاح) مع بقاء نسخة الخادم سليمة.
    //
    // قاعدة حرجة: الدمج (mergeSection/mergeClasses) اتحادٌ بشواهد حذف فقط —
    // لا حذف صلب. لذلك لا يجوز إطلاقاً اعتبار نسخة متأخرة «طازجة»، وإلا محت
    // دفعاتِ الطلاب كاملةً باستبدالٍ كامل، والعكس يُعيد محذوفاً بلا سبب.
    //
    // نافذة الـ5 دقائق السابقة كانت تسمح لجهاز متأخر **ثانية واحدة فقط** بأن
    // يستبدل 162 فوق 172 — وهي الحادثة الموثّقة. القاعدة الآن:
    //   • عميل جديد يُرسل baseTs = النسخة التي اشتُقّ منها فعلاً بعد GET ثم الدمج:
    //       إن كانت الأحدث  ⇒ استبدال كامل يُحترم (فيستطيع المدير الحذف كالمعتاد).
    //       إن كانت أقدم    ⇒ دمجٌ محافظ (لا يُمحى أحد).
    //   • عميل قديم لا يُرسل baseTs ⇒ نافذة الـ5 دقيقة كما هي (سلوك مطابق للنشر الحالي).
    const declaredBase = Number(req.body && req.body.baseTs) || 0;
    const storedTsNow = (prev && Number(prev.ts)) || 0;
    const behindBy = storedTsNow - ts;
    const stale = !!(prev && prev.data && storedTsNow && (
      declaredBase > 0 ? declaredBase < storedTsNow : behindBy > 5 * 60 * 1000
    ));

    // ===== تحقق الصلاحيات لكل قسم تغيّر =====
    // المدير/الوكيل: يمكنه تعديل قسم المستخدمين، والبقية يحفظون أقسامهم (حضور/غياب...) فقط.
    const canEditUsers = (req.session.role === 'ADMIN' || req.session.role === 'AGENT');
    // وكيل الشؤون المدرسية: يُسجّل حضور المعلمين/الإداريين (حقول الغياب/التأخر) فقط.
    const canEditUserAttendance = (req.session.role === 'SCHOOL_AGENT');
    if (!canEditUsers) {
      if (canEditUserAttendance) {
        // يُقبل تغيّر حقول الحضور على سجلات المستخدمين، ويبقى سائر الحقول نسخة الخادم.
        data.users = mergeUsersAttendanceOnly(prevUsers, data.users);
      } else {
        // لا يحق لهذا الدور تعديل الحسابات: نتجاهل أي تغيير أرسله على قسم users
        // ونُبقي نسخة الخادم الموثوقة سليمة، دون فقدان بقية الأقسام المشروعة (مثل الحضور).
        data.users = JSON.parse(JSON.stringify(prevUsers));
      }
    }
    for (const key of SECTION_KEYS) {
      const a = prev.data ? prev.data[key] : undefined;
      const b = data[key];
      if (jsonEqual(a, b)) continue;
      if (key === 'users' && !usersSectionAllowedFor(req.session.role, req.session.user_id, a, b))
        // لا يُرفض الحفظ كاملاً؛ يُدمج لاحقاً وقسم المستخدمين يبقى نسخة الخادم لغير المدير
        continue;
    }

    // ===== بناء النسخة المدمجة =====
    // قاعدة شاملة: لا يوجد "استبدال كامل" لأي جهة غير المدير/الوكيل، حتى لو وصلت نسختها
    // طازجة الزمن، بل تُدمج تعديلاتها حسب الصلاحيات داخل نسخة الخادم الحالية (مزج حسب المفتاح).
    // هكذا لا يمسح معلم (جدول/حضور/ملاحظات/تكليفات...) بيانات زملائه ولا يمسح أحد القسم ككل،
    // وخلايا الجدول المضافة تبقى محفوظة بعد التحديث/إعادة الدخول.
    const applyMerged = (base, src, role, canEditU, attOnlyU) => {
      const merged = JSON.parse(JSON.stringify(base));
      delete merged._ts;
      const allKeys = new Set([...SECTION_KEYS, ...Object.keys(src || {})]);
      // ===== حقول مشتقّة من الخادم: لا تُكتب من العميل ولا تُدمج =====
      // pointsTotals ناتج حسابي (computePointsTotals) يعيد حسابه الخادم في كل GET.
      // لو ادمجناه لأمكن لعميل أن يكتب أرقام نقاط في نسخته المخزّنة، ولأن handler
      // PUT يمرّ بـ replace كامل (canEditUsers) لكتب السجل كما هو. فنسقطه هنا،
      // والعميل لن يجد فرقاً بين ما يرسله وما يلقاه (jsonEqual) لن يتكرر الحفظ.
      const SERVER_DERIVED_KEYS = new Set(['_ts', 'pointsTotals']);
      for (const key of allKeys) {
        if (SERVER_DERIVED_KEYS.has(key)) continue;
        const a = base[key];
        const b = src[key];
        if (jsonEqual(a, b)) continue;
        if (key === 'users') {
          if (canEditU) merged[key] = mergeUsersAttendanceNewer(prevUsers, mergeSection(a, b));
          else if (attOnlyU) merged[key] = mergeUsersAttendanceOnly(prevUsers, b);
          else merged[key] = JSON.parse(JSON.stringify(prevUsers));
          continue;
        }
        // قسم الحضور يُدمج بمنطق خاص (last-write-wins حسب studentId|date) لكافة الأدوار
        // حتى يبقى الغياب المسجَّل قائماً ولا يختفي بأي نسخة قديمة من أي دور.
        if (key === 'attendance') { merged[key] = mergeAttendance(a, b); continue; }
        if (key === 'activities') { merged[key] = mergeActivities(a, b); continue; }
        if (key === 'adminMsgs') { merged[key] = mergeAdminMsgs(a, b); continue; }
        if (key === 'classes') { merged[key] = mergeClasses(a, b); continue; }
        // التحويلات: شاهد الحذف لاصق والحل لا يُمحى (mergeTransfers)،
        // بخلاف mergeSection العام الذي يترك الواصل يكفي فتفقد الحلول.
        if (key === 'transfers') { merged[key] = mergeTransfers(a, b); continue; }
        if (canEditU) { merged[key] = mergeSection(a, b); continue; }
        // غير المدير: يكتب الأقسام المصرَّح بها فقط، والباقي يبقى نسخة الخادم سليمة
        if (SECTION_RULES[key] && SECTION_RULES[key].includes(role)) merged[key] = mergeSection(a, b);
        // مفاتيح غير معروفة (مثل escapeAlerts): تُدمج عاماً كي لا تُفقد إضافات/تعديلات أي جهة
        else if (!SECTION_RULES[key]) merged[key] = mergeSection(a, b);
      }
      return merged;
    };
    const role = req.session.role;
    // نحتفظ بنسخة الواصل الأصلية لقسم الطلاب (قبل الدمج) لنطبق منها حقول التأخر
    // على بيانات الخادم للمعلم: `saveAttendance` يعدّل students (lateMinutes/lateType)
    // عند تسجيل الحضور، وقديماً كان هذا يرفض الحفظ كاملاً 403 فتضيع التعديلات.
    const incomingStudents = (data && Array.isArray(data.students)) ? data.students : null;
    if (canEditUsers) {
      // المدير/الوكيل: يُبقي الاستبدال الكامل الطازج للأقسام الهيكلية (الفصول/الطلاب/المستخدمون...)
      // ليدير الإضافة والحذف، لكن قسمي الحضور والجدول لا يُستبدلان أبداً ببيانات جهازٍ أقدم:
      // يُدمجان دائماً حتى لا يمسح جهاز إداري حصة/غياباً سجّله المعلمون حديثاً.
      if (prev.data && prev.data.hasOwnProperty) {
        if (stale) {
          data = applyMerged(prev.data, data, role, true, false);
        } else {
          const cf = JSON.parse(JSON.stringify(data));
          // التكليفات/النشاطات (وشواهد الحذف فيها) تُدمج دائماً حتى للمدير/الوكيل:
          // استبدالها كلياً بنسخة جهازٍ قديم يمسح شاهد الحذف فيعود التكليف المحذوف.
          if (!jsonEqual(prev.data.assignments, cf.assignments)) cf.assignments = mergeSection(prev.data.assignments, cf.assignments);
          if (!jsonEqual(prev.data.activities, cf.activities)) cf.activities = mergeActivities(prev.data.activities, cf.activities);
          if (!jsonEqual(prev.data.classes, cf.classes)) cf.classes = mergeClasses(prev.data.classes, cf.classes);
          if (!jsonEqual(prev.data.timetable, cf.timetable)) cf.timetable = mergeTimetable(prev.data.timetable, cf.timetable);
          if (!jsonEqual(prev.data.attendance, cf.attendance)) cf.attendance = mergeAttendance(prev.data.attendance, cf.attendance);
          // الرسائل/الإعلان/الاقتراحات: تُدمج دائماً حتى مع استبدال المدير الكامل،
          // حتى لا يمسح حفظٌ إداري على جهاز قديم رسائلَ وصلت حديثاً للمعلمين من جهات أخرى.
          if (Array.isArray(prev.data.adminMsgs) && !jsonEqual(prev.data.adminMsgs, cf.adminMsgs)) cf.adminMsgs = mergeAdminMsgs(prev.data.adminMsgs, cf.adminMsgs);
          if (Array.isArray(prev.data.announcements) && !jsonEqual(prev.data.announcements, cf.announcements)) cf.announcements = mergeSection(prev.data.announcements, cf.announcements);
          if (Array.isArray(prev.data.suggestions) && !jsonEqual(prev.data.suggestions, cf.suggestions)) cf.suggestions = mergeSection(prev.data.suggestions, cf.suggestions);
          // نقاط المعلمين (notes): تُدمج دائماً حتى مع استبدال المدير الكامل، حتى لا يمسح
          // حفظٌ إداري على جهازٍ قديم ملاحظاتِ معلمين أُضيفوا حديثاً من جهات أخرى.
          if (Array.isArray(prev.data.notes) && !jsonEqual(prev.data.notes, cf.notes)) cf.notes = mergeSection(prev.data.notes, cf.notes);
          // التحويلات: تُدمج دائماً كما يُدمج كل قسم آخر. كان الاستبدال الكامل للمدير
          // يمسحها بلا دمج، فدفعة من جهاز قديم (أو من متصفح نُسخت بياناته قبل الحذف)
          // تُعيد تحويلاً محذوفاً أو محلولاً: الشاهد يُ والحل يختفي — وتظهر
          // العلة للمدير بعد الخروج وإعادة الدخول لأن logout يمسح ذاكرة الجهاز.
          if (Array.isArray(prev.data.transfers) && !jsonEqual(prev.data.transfers, cf.transfers)) {
            cf.transfers = mergeTransfers(prev.data.transfers, cf.transfers);
          }
          if (Array.isArray(prev.data.users) && !jsonEqual(prev.data.users, cf.users)) cf.users = mergeUsersAttendanceNewer(prevUsers, cf.users);
          data = cf;
        }
      }
    } else if (prev.data && prev.data.hasOwnProperty) {
      // كل الباقين: دمج دائماً (لا خسارة لبيانات أحد). قسم الطلاب للمعلم يُدمج
      // بحقول التأخر فقط (lateMinutes/lateType) فلا يُرفض الحفظ ولا يمسح بيانات الطالب.
      data = applyMerged(prev.data, data, role, false, canEditUserAttendance);
    }
    if (!canEditUsers && (role === 'TEACHER' || role === 'ADMINISTRATIVE' || role === 'SCHOOL_AGENT') && incomingStudents) {
      // المعلم والإداري ووكيل الشؤون المدرسية: يُسمح لهم بتعديل حقول التأخر للطلاب (lateMinutes/lateType) فقط
      data.students = mergeStudentsLateOnly(prev.data ? prev.data.students : [], incomingStudents);
    }

    // ===== فرض مالك الملاحظة من الجلسة قبل أي دمج =====
    // يُطبَّق على النسخة *الواردة* قبل الدمج، فتصبح قيمة `createdBy` القادمة من
    // العميل بلا أثر: ملاحظة جديدة تأخذ sessions.user_id، وملاحظة موجودة تأخذ
    // مالك نسخة الخادم. ولا يستطيع حتى المدير نقل ملكية ملاحظة إلى غيره.
    // الملاحظات القديمة بلا createdBy تصل كما هي (غير مملوكة): لا يُحذف شيء ولا
    // يُنسب لأحد — تبقى في المخزون كما هي، ويراها لا أحد غير الإدارة.
    try {
      const prevNotes = prev.data && Array.isArray(prev.data.notes) ? prev.data.notes : [];
      if (Array.isArray(data.notes)) {
        data.notes = notePrivacy.enforceNoteOwners(data.notes, req.session, prevNotes);
        // ===== حق الحذف: الخادم يمنع حذفَ ملاحظة غير مالكها =====
        // الواجهة تُظهر الزر للمدير ولمالكة المعلم لنفسها فقط، لكن أي عميل
        // يستطيع من الـ API أن يرسل deleted:true لملاحظة زميلة. الخادم الآن
        // يلغي العَلَم عند من لا يملك الحق (ويُبقي بقية دفعه سليمة) ويسجّل
        // المحاولة المرفوضة باسم من حاول والمالك الحقيقي.
        const delRights = notePrivacy.enforceNoteDeleteRights(data.notes, req.session, prevNotes);
        data.notes = delRights.notes;
        for (const bad of delRights.blocked) {
          console.warn('[note-delete-rights] حذف مرفوض | ملاحظة:', bad.id,
            '| صاحبها:', bad.owner, '| يحاول:', bad.by, '(' + bad.role + ')');
        }
      }
    } catch (e) { console.warn('[note-privacy] enforceNoteOwners:', e.message); }

    // ===== حق حذف التحويل: المدير وحده =====
    // كما في الملاحظات: الواجهة تُظهر الزر للمدير فقط، لكن أي عميل يستطيع
    // من الـ API أن يرسل deleted:true. الخادم يلغي العَلَم عند من لا يملك
    // الحق (ويُبقي بقية دفعه سليمة) ويسجّل المحاولة المرفوضة.
    try {
      const prevTransfers = prev.data && Array.isArray(prev.data.transfers) ? prev.data.transfers : [];
      if (Array.isArray(data.transfers)) {
        const tDel = transferPrivacy.enforceTransferDeleteRights(data.transfers, req.session, prevTransfers);
        data.transfers = tDel.transfers;
        for (const bad of tDel.blocked) {
          console.warn('[transfer-delete-rights] حذف مرفوض | تحويل:', bad.id,
            '| صاحبه:', bad.owner, '| يحاول:', bad.by, '(' + bad.role + ')');
        }
      }
    } catch (e) { console.warn('[transfer-delete-rights]', e.message); }

    // حماية «بداية النقاط»: أي ملاحظة سلبية (points < 0) بتاريخ قبل بداية العام الدراسي تُحذف
    // حتى لو حملها جهاز قديم لا يزال يحتوي نسخة كاملة — تمنع عودة النقاط السلبية المحذوفة.
    try {
      const stCut = await db.getSchoolSettings(school);
      const cutDate = (stCut.pointsStartFrom || '2026-09-07').slice(0, 10);
      if (Array.isArray(data.notes)) {
        data.notes = data.notes.filter(n => !((typeof n.points === 'number' && n.points < 0) && (n.createdAt || '').slice(0, 10) < cutDate));
      }
    } catch (_) {}

    // حارس الفصول المكررة: أجهزة قديمة تعيد دفع نسخ فيها الفصل نفسه مكرراً (مثلاً 4 مرات، كانت 12
    // فتحولت 48). أي صف مكرر في (المرحلة+الاسم)، أو بلا مرحلة، أو بمرحلة وهمية بلا طلاب فيه،
    // يُحوَّل إلى شاهد حذف (deleted) فيبقى المكرر مخفياً ولا يعود العدد يصعد مع كل حفظ.
    try { dedupeClasses(data); } catch (e) { console.warn('[dedupeClasses]', e.message); }

    // حارس التكليفات المُلغاة: أجهزة قديمة تعيد دفع تكليفات حذفتها الإدارة (نقاطها
    // السلبية تُحتسب تلقائياً على من لم ينجزها) — أي وصول لها يُعاد وسمه deleted:true
    // فيبقى مصدر التحميل منتعشاً ولا تهبط نقاط الطلاب من جديد.
    try {
      const BANNED_ASSIGN = ['id_5d17111nmtttorn5', 'id_wk9ojhlymtv7xr3g', 'id_srbjht5ymts4tp8s', 'id_92j0tg1amtsejasl'];
      if (Array.isArray(data.assignments)) {
        data.assignments.forEach(a => {
          if (a && typeof a === 'object' && BANNED_ASSIGN.includes(a.id)) a.deleted = true;
        });
      }
    } catch (e) { console.warn('[banAssign]', e.message); }

    // حارس الطلاب المحذوفات نهائيًا: أي نسخة قادمة تحمل طالب أُزيل حسابها
    // (من قِبل المدير عبر حذف نهائي) تُسقط سجلها واسمها قبل الحفظ — لا عودة أبدًا.
    try {
      const bset = new Set(Array.isArray(prev.data && prev.data._blockedStudents) ? prev.data._blockedStudents.map(String) : []);
      applyBlockedStudents(data, bset);
    } catch (e) { console.warn('[blockedStudents]', e.message); }

    // تنظيف دفاعي: لا تُخزن أي بيانات اعتماد في نسخة البيانات + حقن أسماء المستخدمين الحالية حتى لا تضيع
    const clean = JSON.parse(JSON.stringify(data));
    // تطبيع ثانٍ بعد الدمج: الدمج (mergeSection/mergeClasses...) قد يعيد مرجعات يتيمة
    // لمعلمين مكررين من نسخة جهاز قديم، فننظف النتيجة النهائية التي ستُخزن.
    try { await normalizeTeacherDuplicates(school, clean); } catch (e) { console.warn('[normalize#2]', e.message); }
    // ===== حارس اسم المستخدم =====
    // اسم المستخدم فريد في جدول الحسابات، ولا يُطبَّق تغييره في ذلك الجدول
    // إلا بعد حفظ نسخة القسم. فلو كُتبت النسخة قبل الفحص لأمكن أن تحمل اسماً
    // لا يقبله الجدول: تناقض صامت بين الأجهزة.
    // وموضع الفحص هنا مقصود: فهناك خطوة لاحقة في هذا المعالج تفرض اسم
    // المستخدم من جدول الحسابات على كل حفظ (حمايةً من النسخ القديمة)، فكانت
    // تُلغي أي طلب تعديل قبل أن يصل إلى جدول الحسابات — فلا يُحفظ أبداً.
    // الشكل المقبول: من 3 إلى 32 رمزاً بحروف لاتينية صغيرة أو أرقام أو
    // . _ - فقط، بلا مسافات.
    try {
      const prevMapU = new Map((prevUsers || []).map(u => [u.id, String(u.username || '').trim().toLowerCase()]));
      const seenLocal = new Set();
      for (const nu of (clean.users || [])) {
        const uname = String((nu && nu.username) || '').trim().toLowerCase();
        if (!uname) continue;
        // حساب قديم اسمُه مخالف للشكل (قصير جداً أو برموز ممنوعة) كان يُرفض
        // هنا فيسقط كل حفظ للمدرسة إلى الأبد: لا حذف تحويل ولا حفظ ولا مزامنة،
        // مع أن الحساب لم يُمس. فنمرّر الاسم المخالف كما هو إن لم يكن مُعدَّلاً،
        // ونفرض الشكل على الاسم المُعدَّل جديداً فقط، فيصحّح المستخدم حسابه بنفسه.
        const unchanged = prevMapU.get(nu.id) === uname;
        if (!unchanged && !/^[a-z0-9._-]{3,32}$/.test(uname))
          return res.status(400).json({ error: 'username_invalid', username: uname });
        // تجاوز شرط الشكل لا يعني تجاوز فحص التكرار: بياناتٌ تالفة فيها
        // حسابان بالاسم نفسه كانت تُرفض قبل هذا الإصلاح، ولو تجاوزنا
        // التجاوزُ كشفَ التكرار لثُبِّت التلف في القاعدة بدل أن يُعلن.
        if (seenLocal.has(uname))
          return res.status(409).json({ error: 'username_taken', username: uname });
        seenLocal.add(uname);
        if (unchanged) continue;
        if (!['ADMIN', 'AGENT'].includes(req.session.role))
          return res.status(403).json({ error: 'username_change_forbidden', username: uname });
        const holder = await db.userByUsername(uname);
        if (holder && String(holder.id) !== String(nu.id))
          return res.status(409).json({ error: 'username_taken', username: uname });
      }
    } catch (e) {
      console.warn('[username-guard]', e.message);
      return res.status(500).json({ error: 'username_check_failed' });
    }
    // ===== نهاية حارس اسم المستخدم =====
    if (Array.isArray(clean.users) && clean.users.length) {
      const uidSet = new Set(clean.users.map(u => u.id));
      const unameMap0 = await db.usernamesByIds([...uidSet]);
      // طلب تغيير اسم المستخدم يصل من زر التصحيح في صفحة الإداريين. كان السطر
      // التالي يفرض اسم المستخدم من جدول الحسابات على النسخة في كل حفظ، فيلغي
      // الطلب قبل أن يصل إلى جدول الحسابات ولا يُحفظ أبداً. لذلك نطبّق الطلب
      // على جدول الحسابات هنا — بعد التحقق الذي سبق — ثم نعيد القراءة فيصير
      // الاسم الجديد هو المرجع الذي تُحقن به النسخة.
      const wantedNames = [];
      for (const u of clean.users) {
        const want = String((u && u.username) || '').trim().toLowerCase();
        const cur = unameMap0.has(u.id) ? String(unameMap0.get(u.id) || '').trim().toLowerCase() : '';
        if (want && want !== cur) wantedNames.push({ id: u.id, username: want });
      }
      for (const w of wantedNames) {
        try {
          await db.updateUserIdentity(w.id, { username: w.username });
          console.log('[username-apply]', school, 'طلب تصحيح اسم مستخدم →', w.username, '|', req.session.user_id);
        } catch (e) {
          console.warn('[username-apply] فشل', w.id, e.message);
          return res.status(409).json({ error: 'username_taken', username: w.username });
        }
      }
      const unameMap = wantedNames.length ? await db.usernamesByIds([...uidSet]) : unameMap0;
      // حالة «أول دخول» إلزامية من جدول الحسابات (مصدر الحقيقة): أي جهاز (حتى مدير بنسخة قديمة)
      // يدفع users بعلامة تقدّم قديمة يُعاد تصحيحها — فلا يمكن لمن دخل فعلاً أن يظهر «بانتظار أول دخول»
      const statusRows = await db.usersForLoginStats(school);
      const statusMap = new Map(statusRows.map(r => [r.id, !!r.first_login]));
      clean.users.forEach(u => { if (unameMap.has(u.id)) u.username = unameMap.get(u.id); if (statusMap.has(u.id)) u.firstLogin = statusMap.get(u.id); });
      clean.users.forEach(u => STRIP_FIELDS.forEach(f => delete u[f]));
    }
    // حماية الحسابات المُفعّلة قسرياً من أي نسخة قديمة: أي جهة تدفع active=false لأحدها
    // تُكتب active=true (تُصلح نسخة القسم)، وَتُفعَّل في جدول الحسابات عند اللزوم.
    if (Array.isArray(clean.users)) {
      clean.users.forEach(u => { if (u && FORCE_ACTIVE.has(u.id) && u.active === false) u.active = true; });
    }
    // زمن الحفظ دائمًا أكبر من نسخة الخادم (حتى لا نُرفض مستقبلًا بزمن متساو/أقل).
    // مع حماية من ساعة متقدمة جدًا: لا نسمح لجهاز بساعة بعيدة عن الواقع أن يرتكز عليه الجميع
    // (يمنع ذلك انتشار الحذف عبر الدمج)، فيُقيّد الزمن بنطاق 5 دقائق حول ساعة الخادم.
    const nowTs = Date.now();
    const saneTs = Math.min(ts, nowTs + 5 * 60 * 1000);
    let nextTs = Math.max(saneTs, (prev && prev.ts) || 0) + 1;
    if (clean && typeof clean === 'object') clean._ts = nextTs;
    // تثبيت الإسناد الإداري: إعادة فرض مسؤولي القسم في كل فصل مهما حمل جهاز الحفظ
    try {
      const keepIds = ALWAYS_TEACHER_IDS[school];
      if (keepIds && Array.isArray(clean.classes)) {
        for (const c of clean.classes) {
          if (!c || (typeof c !== 'object')) continue;
          const t = Array.isArray(c.teacherIds) ? c.teacherIds.filter(x => typeof x === 'string') : [];
          let changed = false;
          for (const id of keepIds) { if (!t.includes(id)) { t.push(id); changed = true; } }
          if (changed) c.teacherIds = t;
        }
      }
    } catch (_) {}
    // ===== حارس الفصول المحظورة (blocked-classes) =====
    // قائمة معرّفات فصول تُعدّ محذوفة نهائياً من القسم (فصول بلا طلاب/مكررة أُزيلت إدارياً).
    // أي جهاز قديم يحملها لاحقاً تحذف فصوله فوراً ولا تُخزن — تمنع عودة التكرار المُزالة أبداً.
    const prevBlocked = new Set(Array.isArray(prev.data && prev.data._blockedClasses) ? prev.data._blockedClasses : []);
    const inBlocked = new Set(Array.isArray(clean._blockedClasses) ? clean._blockedClasses : []);
    for (const id of prevBlocked) inBlocked.add(id);
    if (Array.isArray(clean.classes) && inBlocked.size) {
      clean.classes = clean.classes.filter(c => c && !inBlocked.has(c.id));
    }
    clean._blockedClasses = [...inBlocked];

    // دمج قائمة الطلاب المحذوفة نهائيًا من نسخة الخادم (لو أتى جهاز قديم بلا قائمة)
    // وتطبيق الحارس على النسخة النهائية قبل التخزين — لا يعود اسم محذوفة أبدًا.
    try {
      const pb = new Set(Array.isArray(prev.data && prev.data._blockedStudents) ? prev.data._blockedStudents.map(String) : []);
      const ib = new Set(Array.isArray(clean._blockedStudents) ? clean._blockedStudents.map(String) : []);
      for (const x of pb) ib.add(x);
      clean._blockedStudents = [...ib];
      applyBlockedStudents(clean, ib);
    } catch (e) { console.warn('[blockedStudents#final]', e.message); }

    // ===== حارس تاريخ الانضمام (joinedAt) =====
    // أجهزة قديمة (localStorage بلا joinedAt) تستبدل قسم الطلاب كاملاً للمدير/الوكيل
    // فيُفقد تاريخ انضمام الطلاب الجدد وتعود عقوبات تكليفات أُسندت قبل انضمامهن.
    // نستعيد joinedAt من نسخة الخادم لأي طالب ينقصها في النسخة الواردة قبل التخزين.
    try {
      const prevJoined = new Map();
      if (prev.data && Array.isArray(prev.data.students)) {
        prev.data.students.forEach(s => { if (s && s.id && s.joinedAt) prevJoined.set(s.id, s.joinedAt); });
      }
      if (prevJoined.size && Array.isArray(clean.students)) {
        clean.students.forEach(s => {
          if (s && s.id && !s.joinedAt && prevJoined.has(s.id)) s.joinedAt = prevJoined.get(s.id);
        });
      }
    } catch (e) { console.warn('[joinedAt-preserve]', e.message); }

    // لا تُكتب نسخة بلا قسم: المفتاح الناقص يُملأ من نسخة الخادم السابقة أو
    // بقائمة فارغة، فيتوقف زوال المفتاح من الجذر (كان يُسقط شاشات العميل).
    ensureDataSections(clean, prev ? prev.data : null);

    let putRes = await db.setSchoolData(school, clean, nextTs);
    // nextTs = max(saneTs, prev.ts)+1 فيلزم أن يسبق الصف المخزَّن. إن رُفضت الكتابة
    // فهناك كاتب أحدث سباقنا بين القراءة والكتابة — ولم تُمحَ بيانات أحدث.
    //
    // لماذا إعادة المحاولة لا الإهمال: الجهاز نفسه يرفع كل ~700ms عبر __syncSchedule،
    // فيرفع ts المخزَّن بمقدار 1 في كل مرة، فيرفض حارسُ ts حفظَ المدير الشرعي
    // في كل مرة (سباق ذاتي بين اللوحة وخطّ الرفع الخاص بها) — وكان المسار يُرجع 200
    // فيصدّق العميل أن حفظه نجح ثم يفقد تعديلاته بصمت.
    let putAttempts = 0;
    while (!putRes.written && putAttempts < 3) {
      putAttempts++;
      const cur = await db.getSchoolData(school);
      const curTs = (cur && Number(cur.ts)) || putRes.storedTs || 0;
      // وصل تغيير بنيوي جديد بعد قراءتنا الأولى (طالب/فصل أُضيف أو حُذف من جهاز آخر):
      // لا نطمسه. نُرجع 409 فيقرأ العميل من جديد ويدمج ثم يدفع — وهو سلوك __syncPush أصلاً.
      if (cur && cur.data && prev && prev.data && !jsonEqual(cur.data.students, prev.data.students)) {
        console.warn('[db-put] تغيير بنيوي متزامن لـ', school, '— 409 ليعيد العميل الدمج');
        return res.status(409).json({ error: 'write_rejected', reason: 'concurrent_change', storedTs: curTs });
      }
      nextTs = Math.max(saneTs, curTs) + 1;
      if (clean && typeof clean === 'object') clean._ts = nextTs;
      putRes = await db.setSchoolData(school, clean, nextTs);
    }
    if (!putRes.written) {
      console.warn('[db-put] استُنفدت إعادة المحاولة لـ', school, 'storedTs=', putRes.storedTs);
      return res.status(409).json({ error: 'write_rejected', reason: 'stale_ts', storedTs: putRes.storedTs });
    }
    // مزامنة جدول المصادقة مع أي تغيير في قسم المستخدمين (حذف/نقل/تعطيل)
    if (['ADMIN','AGENT'].includes(req.session.role)) {
      if (!jsonEqual(prevUsers, clean.users)) await reconcileUserTable(school, prevUsers, clean.users);
    }
    // تدقيق المزامنة: تسجيل كل حفظ لمعرفة الجهاز الذي يكتب فعلاً (IP/متصفح) عند التشخيص
    try {
      await db.auditSync({
        school, ip: req.ip,
        ua: req.headers['user-agent'] || '',
        user_id: req.session.user_id, role: req.session.role,
        n_assign: (clean.assignments || []).length,
        n_tomb: (clean.assignments || []).filter(a => a && a.deleted).length,
        assign_ids: (clean.assignments || []).map(a => a && a.id).filter(Boolean),
        data_ts: nextTs,
        payload: req.body ? Buffer.byteLength(JSON.stringify(req.body)) : 0,
      });
    } catch (auditErr) { console.error('audit failed (non-blocking):', auditErr.message); }
    res.json({ ok: true, ts: nextTs });
  })().catch(fail(res));
});

/* ================= إعدادات مشتركة لكل قسم (بداية العام/الأسبوع...) ================= */
// مقروء من أي مستخدم مسجّل الدخول لمدرسته، وقابل للتعديل من المدير فقط.
app.get('/api/settings/:school', requireAuth, (req, res) => {
  (async () => {
    const school = String(req.params.school).toUpperCase();
    if (!db.SCHOOLS.includes(school)) return res.status(400).json({ error: 'bad_school' });
    if (!schoolAccess(req.session, school)) return res.status(403).json({ error: 'forbidden' });
    const data = await db.getSchoolSettings(school);
    res.json({ ok: true, data });
  })().catch(fail(res));
});

app.put('/api/settings/:school', requireAuth, (req, res) => {
  (async () => {
    const school = String(req.params.school).toUpperCase();
    if (!db.SCHOOLS.includes(school)) return res.status(400).json({ error: 'bad_school' });
    if (!schoolAccess(req.session, school)) return res.status(403).json({ error: 'forbidden' });
    if (req.session.role !== 'ADMIN') return res.status(403).json({ error: 'forbidden' });
    const data = req.body && req.body.data;
    if (!data || typeof data !== 'object' || Array.isArray(data)) return res.status(400).json({ error: 'invalid_payload' });
    await db.setSchoolSettings(school, data);
    res.json({ ok: true });
  })().catch(fail(res));
});

/* ===== استرداد ملكية الملاحظات غير المملوكة: مطالب + موافقة =====
   الملاحظات القديمة بلا createdBy لا تُحذف ولا تُنسب بالاسم، لكن صاحبتها
   الشرعية لا تراها. هذا المسار يعالج ذلك في خطوتين:
     1) POST /api/notes/claim  — المعلم تقول «هذه ملاحظتي». لا ينقل الملكية.
     2) POST /api/notes/claim/decide — الإدارة تعتمد أو ترفض. الاعتماد هو
        النمط الوحيد الذي يُكتب فيه createdBy لمملوك سابق.
   لولا خط الموافقة لأمكنت أي معلم أن تسحب ملكية ملاحظة زميلة بمجرد معرّفها،
   وهو ليس سرّاً يُبنى هذا النظام أصلاً على حمايته. */
function _claimsSchool(req) {
  return String(req.body && req.body.school || req.session.school || '').toUpperCase();
}
const _CLAIM_REASON_STATUS = {
  unauthenticated: 401, forbidden: 403, invalid_school: 400, bad_school: 400,
  not_found: 404, not_claimable: 409, already_owned: 409, no_pending_claim: 409,
  claim_expired: 409, too_many_claims: 429,
};
function _failClaim(res, reason) {
  return res.status(_CLAIM_REASON_STATUS[reason] || 400).json({ error: reason });
}

app.post('/api/notes/claim', requireAuth, async (req, res) => {
  const school = _claimsSchool(req);
  if (!db.SCHOOLS.includes(school)) return res.status(400).json({ error: 'bad_school' });
  if (!schoolAccess(req.session, school)) return res.status(403).json({ error: 'forbidden' });
  const noteId = req.body && req.body.noteId;
  if (!noteId) return res.status(400).json({ error: 'missing_note_id' });
  try {
    // mutateSchoolData يقرأ الصف ويقفله داخل معاملة ويكتب إن changed=true فقط،
    // فلا نكتب شيئاً عند رفض الطلب ولا عند تكرار مطالب مفتوحة.
    const r = await db.mutateSchoolData(school, data => {
      const before = Array.isArray(data.notes) ? data.notes : [];
      const out = notePrivacy.requestNoteClaim(before, req.session, noteId);
      if (!out.ok) return { changed: false, value: out.reason };
      data.notes = out.notes;
      return { changed: true, value: out.note };
    });
    // mutateSchoolData يردّ { written, value, reason:'no_change' } عند الرفض،
    // والسبب الدقيق الذي أعادته الدالة هو value لا reason.
    if (!r.written) return _failClaim(res, typeof r.value === 'string' ? r.value : 'no_change');
    res.json({ ok: true, pending: true, noteId: String(noteId) });
  } catch (e) { fail(res)(e); }
});

app.get('/api/notes/claims', requireAuth, async (req, res) => {
  const school = _claimsSchool(req);
  if (!db.SCHOOLS.includes(school)) return res.status(400).json({ error: 'bad_school' });
  if (!schoolAccess(req.session, school)) return res.status(403).json({ error: 'forbidden' });
  // الإدارة فقط: القائمة تكشف من طالب بماذا، فهي بيانات إدارية.
  if (!notePrivacy.isPrivilegedNotesRole(req.session.role)) return res.status(403).json({ error: 'forbidden' });
  try {
    const rec = await db.getSchoolData(school);
    const notes = rec && rec.data && Array.isArray(rec.data.notes) ? rec.data.notes : [];
    res.json({ ok: true, school, claims: notePrivacy.listPendingClaims(notes) });
  } catch (e) { fail(res)(e); }
});

app.post('/api/notes/claim/decide', requireAuth, async (req, res) => {
  const school = _claimsSchool(req);
  if (!db.SCHOOLS.includes(school)) return res.status(400).json({ error: 'bad_school' });
  if (!schoolAccess(req.session, school)) return res.status(403).json({ error: 'forbidden' });
  if (!notePrivacy.isPrivilegedNotesRole(req.session.role)) return res.status(403).json({ error: 'forbidden' });
  const noteId = req.body && req.body.noteId;
  const approve = !!(req.body && req.body.approve);
  if (!noteId) return res.status(400).json({ error: 'missing_note_id' });
  try {
    const r = await db.mutateSchoolData(school, data => {
      const before = Array.isArray(data.notes) ? data.notes : [];
      const out = notePrivacy.decideNoteClaim(before, req.session, noteId, approve);
      if (!out.ok) return { changed: false, value: out.reason };
      data.notes = out.notes;
      return { changed: true, value: { note: out.note, approved: out.approved } };
    });
    if (!r.written) return _failClaim(res, typeof r.value === 'string' ? r.value : 'no_change');
    console.log('[note-claim]', school, 'ملاحظة', noteId, approve ? '=> اعتُمدت' : '=> رُفضت',
      'بواسطة', req.session.user_id);
    res.json({ ok: true, approved: !!r.value && r.value.approved, noteId: String(noteId) });
  } catch (e) { fail(res)(e); }
});

/* ===== إشعار التحويل: المستلِم من جدول الحسابات، لا من نسخة الجهاز =====
   كان الإشعار يُبنى على قائمة المستخدمين الموجودة في ذاكرة الجهاز، فإذا لم
   تكن هناك نسخة من حساب المدير (وهو ما يحدث لحساب التهيئة: يُنشأ في جدول
   users ولا يُنسخ إلى school_data.users إلا عند إنشائه من شاشة المستخدمين)
  خرجت التصفية فارغة ولم يُكتب إشعار واحد — بينما ظهر التحويل نفسه في
   قائمته لأن التحويلات تُزامَن. هنا الخادم هو المرجع: يجد المستلِم من جدول
   الحسابات (مصدر الحقيقة) ويكتب الرسالة بنفسه. */
app.post('/api/transfer/notify', requireAuth, async (req, res) => {
  const school = String(req.body && req.body.school || req.session.school || '').toUpperCase();
  if (!db.SCHOOLS.includes(school)) return res.status(400).json({ error: 'bad_school' });
  if (!schoolAccess(req.session, school)) return res.status(403).json({ error: 'forbidden' });
  const transferId = req.body && req.body.transferId;
  if (!transferId) return res.status(400).json({ error: 'missing_transfer_id' });
  try {
    // 1) من جدول الحسابات (مصدر الحقيقة): من الهدف موجود فعلاً، ومن هو نشط.
    const receivers = (await db.listUsers(school))
      .filter(u => u && u.role && String(u.role) === String((req.body && req.body.target) || '') && u.active)
      .map(u => ({ id: String(u.id), name: String(u.name || '') }));
    if (!receivers.length) return res.status(409).json({ error: 'no_receivers' });

    const studentLabel = school === 'BOYS' ? 'الطلاب' : 'الطلاب';
    const targetLabel = req.body && req.body.targetLabel || receivers[0].name;
    const sName = String(req.body && req.body.studentName || '').trim();
    const reason = String(req.body && req.body.reason || '').trim();
    const text = `📨 تحويل ${studentLabel}: ${sName} — إلى: ${targetLabel} — السبب: ${reason}`;

    // 2) الكتابة: داخل mutateSchoolData (قفل صف + معاملة) ومعها منع التكرار
    //    بمعرّف التحويل والمستلِم، فجهازان يكرّران الطلب لا يضاعفان الرسالة.
    const r = await db.mutateSchoolData(school, data => {
      const msgs = Array.isArray(data.adminMsgs) ? data.adminMsgs.slice() : [];
      const before = msgs.length;
      for (const rcv of receivers) {
        if (msgs.some(m => m && m.transferId === String(transferId) && m.teacherId === rcv.id)) continue;
        msgs.push({
          id: 'srv_' + String(transferId) + '_' + rcv.id,
          teacherId: rcv.id, teacherName: rcv.name, text,
          createdAt: new Date().toISOString(), read: false, dismissed: false, views: 0,
          senderRole: 'TRANSFER', senderName: String(req.session.name || ''), senderId: String(req.session.user_id),
          transferId: String(transferId), studentName: sName,
        });
      }
      const added = msgs.length - before;
      if (!added) return { changed: false, value: { added: 0, total: msgs.length } };
      data.adminMsgs = msgs;
      return { changed: true, value: { added, total: msgs.length } };
    });
    const info = (r.value && typeof r.value === 'object') ? r.value : { added: 0, total: 0 };
    console.log('[transfer-notify]', school, 'تحويل', transferId, '=> مستلِمون:', receivers.length,
      '| رسائل جديدة:', info.added, r.written ? '(كُتبت)' : '(موجودة مسبقاً)');
    res.json({ ok: true, school, receivers: receivers.length, added: info.added });
  } catch (e) { fail(res)(e); }
});

/* ================= النسخ الاحتياطي والاسترجاع ================= */
// لقطة دورية للقسمين تُخزَّن في جدول منفصل (data_backups) فلا تُمسح حتى لو استُبدلت
// بيانات school_data نفسها — حماية من فقدان كل شيء وتكرار حادثة الأمس.
async function takeBackups() {
  try {
    for (const school of db.SCHOOLS) {
      const rec = await db.getSchoolData(school);
      if (rec.data) await db.saveBackup(school, rec.ts, rec.data);
    }
  } catch (e) { console.error('[backup]', e.message); }
}
app.get('/api/backups', requireAuth, (req, res) => {
  (async () => {
    if (req.session.role !== 'ADMIN') return res.status(403).json({ error: 'forbidden' });
    const out = { ok: true, latest: {}, recent: {} };
    for (const school of db.SCHOOLS) {
      const rows = await db.listBackups(school, 10);
      out.recent[school] = rows;
      out.latest[school] = rows[0] || null;
    }
    res.json(out);
  })().catch(fail(res));
});
// استرجاع بيانات قسم (بنين) من نسخة احتياطية قديمة — تجاوز كامل للبيانات الحالية
app.post('/api/backups/restore', requireAuth, (req, res) => {
  (async () => {
    if (req.session.role !== 'ADMIN') return res.status(403).json({ error: 'forbidden' });
    const id = Number(req.body && req.body.id) || 0;
    if (!id) return res.status(400).json({ error: 'missing' });
    const bak = await db.getBackup(id);
    if (!bak) return res.status(404).json({ error: 'not_found' });
    // ts رتيب: الخادم قد يخزّن ts يتقدّم على ساعة الحائط (ساعة جهاز عميل متأخرة
    // +5د). بمجرد إضافة حارس monotonicity على setSchoolData كان ts=Date.now()
    // يُرفض بصمت — والاستعادة تُبلّغ ok:true وهي لم تكتب شيئاً.
    // فنقرأ السطر الحالي ونُhalbه للأعلى، ونتحقق من نتيجة الكتابة.
    const prevRow = await db.getSchoolData(bak.school);
    const ts = Math.max(Date.now(), (prevRow && prevRow.ts) || 0) + 1;
    const data = JSON.parse(JSON.stringify(bak.data));
    if (data && typeof data === 'object') data._ts = ts;
    if (data && Array.isArray(data._blockedClasses) && Array.isArray(data.classes)) {
      const bl = new Set(data._blockedClasses);
      data.classes = data.classes.filter(c => c && !bl.has(c.id));
    }
    // حارس: استرجاع نسخة بلا مستخدمين = تفريغ مقنّع — يُرفض مع تسجيل الفاعل
    if (!data || !Array.isArray(data.users) || data.users.length === 0) {
      console.warn('[restore-guard] رفض استرجاع بلا users لـ', bak.school, 'من', req.session.user_id, 'IP', req.ip);
      return res.status(409).json({ error: 'wipe_blocked', reason: 'restore_empty' });
    }
    const w = await db.setSchoolData(bak.school, data, ts);
    if (!w.written) {
      console.warn('[restore-guard] رفضت الاستعادة كتابة غير متفوقة لـ', bak.school,
                  'ts=', ts, 'المخزَّن=', prevRow && prevRow.ts, 'من', req.session.user_id, 'IP', req.ip);
      return res.status(409).json({ error: 'write_rejected', reason: 'stale_ts', storedTs: (prevRow && prevRow.ts) || 0 });
    }
    res.json({ ok: true, school: bak.school, ts, takenAt: bak.taken_at });
  })().catch(fail(res));
});
// استرجاع من ملف نسخة احتياطية محفوظة على جهازك (غلاف الحماية الأخير):
// حتى لو فقدت نسخ الخادم كلها، يُعاد رفع الملف الموجود على سطح المكتب بضغطة.
app.post('/api/backups/import', requireAuth, (req, res) => {
  (async () => {
    if (req.session.role !== 'ADMIN') return res.status(403).json({ error: 'forbidden' });
    const school = String(req.body && req.body.school || '').toUpperCase();
    if (!db.SCHOOLS.includes(school)) return res.status(400).json({ error: 'bad_school' });
    const data = req.body && req.body.data;
    if (!data || typeof data !== 'object' || Array.isArray(data) || !Array.isArray(data.users))
      return res.status(400).json({ error: 'invalid_payload' });
    // حارس ثانٍ: استيراد قسم بلا مستخدمين إطلاقاً = تفريغ مقنّع — يُرفض (الاستيراد
    // المشروع يحمل دائماً حسابات النظام). مع تسجيل الفاعل في سجل الخادم للتشخيص.
    if (data.users.length === 0) {
      console.warn('[import-guard] رفض استيراد بلا users لـ', school, 'من', req.session.user_id, 'IP', req.ip);
      return res.status(409).json({ error: 'wipe_blocked', reason: 'import_empty' });
    }
    // نفس منطق الاستعادة أعلاه: ts فوق السطر المخزَّن (وإلا رفضه حارس monotonicity
    // بصمت بينما يُرجع ok:true)، مع تحقق من قبول الكتابة.
    const prevRow = await db.getSchoolData(school);
    const ts = Math.max(Date.now(), (prevRow && prevRow.ts) || 0) + 1;
    const clean = JSON.parse(JSON.stringify(data));
    if (clean && typeof clean === 'object') clean._ts = ts;
    if (Array.isArray(clean._blockedClasses) && Array.isArray(clean.classes)) {
      const bl = new Set(clean._blockedClasses);
      clean.classes = clean.classes.filter(c => c && !bl.has(c.id));
    }
    const w = await db.setSchoolData(school, clean, ts);
    if (!w.written) {
      console.warn('[import-guard] رفض الاستيراد كتابة غير متفوقة لـ', school,
                  'ts=', ts, 'المخزَّن=', prevRow && prevRow.ts, 'من', req.session.user_id, 'IP', req.ip);
      return res.status(409).json({ error: 'write_rejected', reason: 'stale_ts', storedTs: (prevRow && prevRow.ts) || 0 });
    }
    res.json({ ok: true, school, ts });
  })().catch(fail(res));
});
// لقطة أولية عند الإقلاع ثم كل 30 دقيقة
setInterval(takeBackups, 6 * 60 * 60 * 1000).unref();

/* ================= صحة وأمان ================= */
const net = require('net');
function tcpTest(host, port, ms) {
  return new Promise((resolve) => {
    const s = net.connect({ host, port, family: 4, timeout: ms });
    const done = (ok, why) => { try { s.destroy(); } catch (_) {} resolve(ok ? 'OK' : 'FAIL ' + why); };
    s.on('connect', () => done(true, ''));
    s.on('timeout', () => done(false, 'timeout'));
    s.on('error', (e) => done(false, e.code || e.message));
  });
}
app.get('/api/health', (req, res) => {
  res.json({
    ok: true, ver: 'nibras-server-v21', schools: db.SCHOOLS, db: 'postgres',
    supervisionRoles: db.supervisionVisibleRoles(),
    mail: {
      host: !!MAIL_HOST,
      user: !!MAIL_USER,
      pass: !!MAIL_PASS,
      passLen: (MAIL_PASS || '').length,
      port: MAIL_PORT,
      from: MAIL_FROM || null,
    },
  });
});

/* =============== مترجم الوسيط (ترجمة اللوحة عبر خادمنا بدل مباشرة المتصفح) ===============
 * المتصفح قد يحجبه الحاجز العام أو ينقطع عن خدمة الترجمة، فتمر الترجمة عبر خادمنا
 * الذي يستشير MyMemory ويعيد النص الناتج إلى اللوحة (نفس الأصل فلا CORS). */
app.get('/api/translate', requireAuth, (req, res) => {
  (async () => {
    const q = String(req.query.q || '').trim().slice(0, 1000);
    const from = String(req.query.from || '').trim().slice(0, 10);
    const to = String(req.query.to || '').trim().slice(0, 10);
    if (!q || !from || !to) return res.status(400).json({ error: 'missing' });
    if (!/^[a-z]{2,5}$/.test(from) || !/^[a-z]{2,5}$/.test(to)) return res.status(400).json({ error: 'bad_langs' });
    const r = await fetch('https://api.mymemory.translated.net/get?q=' + encodeURIComponent(q) + '&langpair=' + encodeURIComponent(from + '|' + to));
    const j = await r.json();
    const t = j && j.responseData && j.responseData.translatedText;
    if (!t || /MYMEMORY WARNING|INVALID/i.test(String(t))) return res.status(502).json({ error: 'no_translation' });
    res.json({ ok: true, text: String(t) });
  })().catch(() => res.status(502).json({ error: 'no_translation' }));
});

/* =============== مواقيت الصلاة عبر خادمنا (يستشير aladhan ويحوّلها لمنطقة موقع المدرسة) =============== */
app.get('/api/prayer', requireAuth, (req, res) => {
  (async () => {
    const lat = parseFloat(req.query.lat);
    const lon = parseFloat(req.query.lon);
    if (!isFinite(lat) || Math.abs(lat) > 90 || !isFinite(lon) || Math.abs(lon) > 180) return res.status(400).json({ error: 'bad_coords' });
    let m = parseInt(req.query.method, 10);
    if (!isFinite(m) || m < 1 || m > 99) m = 4;
    const r = await fetch('https://api.aladhan.com/v1/timings?latitude=' + lat + '&longitude=' + lon + '&method=' + m + '&timezonestring=Asia/Karachi');
    const j = await r.json();
    const timings = j && j.data && j.data.timings;
    if (!timings) return res.status(502).json({ error: 'no_timings' });
    const tz = (j.data && j.data.meta && j.data.meta.timezone) || 'Asia/Karachi';
    let y = 0, mo = 0, da = 0, off = 0;
    if (/^[A-Za-z_/+-]{2,60}$/.test(String(tz))) {
      const now = new Date();
      try {
        const wall = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(now);
        const sp = wall.split(', ');
        const dp = sp[0].split('-'); const tp = sp[1].split(':');
        y = +dp[0]; mo = +dp[1] - 1; da = +dp[2];
        off = Date.UTC(y, mo, da, +tp[0] % 24, +tp[1], +tp[2]) - now.getTime();
      } catch (e) { /* نبقى صفراً */ }
    }
    const day = y ? (y + '-' + String(mo + 1).padStart(2, '0') + '-' + String(da).padStart(2, '0')) : '';
    const out = {};
    Object.keys(timings).forEach(function (k) {
      const p = String(timings[k]).match(/(\d{1,2}):(\d{2})/);
      if (!p) return;
      const hh = +p[1] % 24, mm = +p[2];
      out[k.toLowerCase()] = y ? (Date.UTC(y, mo, da, hh, mm, 0) - off) : (hh + ':' + String(mm).padStart(2, '0'));
    });
    res.json({ ok: true, day: day, tz: tz || null, t: out });
  })().catch(() => res.status(502).json({ error: 'no_timings' }));
});
app.get('/api/diag/smtp', async (req, res) => {  const targets = [
    ['smtp.gmail.com', 587], ['smtp.gmail.com', 465],
    ['smtp.gmail.com', 25], ['142.251.127.108', 587],
    ['smtp-relay.brevo.com', 587], ['smtp-relay.brevo.com', 465], ['smtp-relay.brevo.com', 25],
    ['www.google.com', 443], ['example.com', 80],
    ['api.brevo.com', 443], ['app.brevo.com', 443], ['smtp-relay.brevo.com', 443],
  ];
  const out = [];
  for (const [h, p] of targets) {
    out.push(h + ':' + p + ' => ' + await tcpTest(h, p, 8000));
  }
  res.json({ targets: out });
});
app.get('/api/diag/mail', async (req, res) => {
  try {
    const apiKey = envOrSecret('MAIL_API_KEY', '') || (MAIL_PASS && String(MAIL_PASS).indexOf('xkeysib-') === 0 ? MAIL_PASS : '');
    const sent = await sendResetEmail('nassser8@gmail.com', 'TEST' + Date.now() % 100000, 10);
    res.json({ sent, host: MAIL_HOST, port: MAIL_PORT, user: MAIL_USER, from: MAIL_FROM, passLen: (MAIL_PASS || '').length, apiKeyLen: (apiKey || '').length, apiKeyPrefix: String(apiKey || '').slice(0, 12) });
  } catch (e) {
    res.json({ error: e.message, stack: String(e && e.stack || '').split('\n').slice(0, 6) });
  }
});
app.get('/api/diag/teacher-dup', async (req, res) => {
  try {
    const r = await db.pool.query(`SELECT id, school, username, name, role, active, first_login, granted FROM users WHERE school='BOYS' AND role IN ('TEACHER','ADMIN','AGENT') ORDER BY username`);
    res.json({ total: r.rows.length, rows: r.rows });
  } catch (e) { console.error(e); res.status(500).json({ error: String(e) }); }
});

app.get('/api/diag/db', async (req, res) => {
  try {
    const r = await db.pool.query('SELECT current_database() AS db, current_user AS usr, (SELECT count(*) FROM users) AS users');
    res.json({ ...r.rows[0], webroot: process.env.WEBROOT || '', root: ROOT, cwd: process.cwd(), hasIndex: staticHasIndex(ROOT) });
  } catch (e) {
    res.json({ error: e.message });
  }
});

// نقطة تشخيص مؤقتة للمدير فقط — قراءة محدودة للحسابين المطلوبين دون أسرار.
app.get('/api/diag/orphan-accounts', requireAuth, async (req, res) => {
  if (req.session.role !== 'ADMIN') return res.status(403).json({ error: 'forbidden' });
  if (rateLimit('diag-orphan-accounts', 10, 60 * 1000, req))
    return res.status(429).json({ error: 'rate_limited' });
  try {
    const rows = await db.findDiagnosticUsers(['noura2', 'nwrh']);
    res.json({
      ok: true,
      rows: rows.map(row => ({
        id: row.id,
        username: row.username,
        school: row.school,
        role: row.role,
        active: row.active,
        name: row.name,
        schoolDataUserExists: row.school_data_user_exists === true,
        schoolDataStudentExists: row.school_data_student_exists === true,
      })),
    });
  } catch (e) {
    console.error('[diag-orphan-accounts]', e);
    res.status(500).json({ error: 'db' });
  }
});

app.use((req,res,next)=>{
  const p = (req.path || '').split('?')[0];
  if (p === '/' || p === '/index.html' || p === '/sw.js' || p === '/manifest.webmanifest')
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  next();
});

// نقطة مؤقتة لإصلاح school في جدول users (تُشغّل مرة واحدة ثم تُحذف)
app.post('/api/admin/fix-user-school', requireAuth, (req, res) => {
  if (req.session.role !== 'ADMIN') return res.status(403).json({ error: 'forbidden' });
  const { userId, newSchool } = req.body || {};
  if (!userId || !newSchool) return res.status(400).json({ error: 'missing userId/newSchool' });
  db.pool.query('UPDATE users SET school = $1 WHERE id = $2 RETURNING id, school', [newSchool, userId])
    .then(r => {
      if (!r.rows.length) return res.status(404).json({ error: 'user not found' });
      res.json({ ok: true, user: r.rows[0] });
    })
    .catch(e => { console.error('[fix-user-school]', e); res.status(500).json({ error: 'db' }); });
});

// (حُذف مسارا ops القديمان)
app.use(express.static(ROOT, { index: 'index.html', fallthrough: true, etag: true, maxAge: 0 }));

app.use((req, res) => res.status(404).json({ error: 'not_found' }));

// إبقاء المثيل نشطًا على خطة Render المجانية (ينام بعد 15 دقيقة خمول فيبرد أول دخول)
if (process.env.RENDER && process.env.PING_URL_DISABLED !== '1') {
  const pingUrl = process.env.PING_URL || ''; // نبراس البنين: يُضبط برابط الخدمة المستقل
  setInterval(() => { fetch(pingUrl + '/api/health').catch(() => {}); }, 4 * 60 * 1000).unref();
}

app.listen(PORT, async () => {
  const dbOk = await (async () => {
    try {
      await db.initSchema();
      const seed = require('./seed');
      const temp = await seed.ensureAdminAccount();
      if (temp) {
        console.log('');
        console.log('==============================================================');
        console.log('  أول تشغيل: حُسوب المدير جاهز');
        console.log('  البريد: admin@nibrasboys.local');
        console.log('  كلمة المرور المؤقتة (تُعرض مرة واحدة فقط): ' + temp);
        console.log('  سيُطلب منك تعيين كلمة مرور قوية جديدة عند أول دخول.');
        console.log('==============================================================');
      }
      console.log('PostgreSQL متصل — نبراس يعمل على http://localhost:' + PORT);
      takeBackups();
      return true;
    } catch (e) {
      console.error('تعذر الاتصال بقاعدة البيانات:', e.message);
      return false;
    }
  })();
  if (!dbOk) {
    // وضع التدهور: نبقى شغالين لخدمة الواجهة والملفات الثابتة، ونعيد محاولة
    // الاتصال بالقاعدة في الخلفية حتى تتعافى (أو يُرفع حدّ نقل البيانات في القاعدة).
    console.warn('⚠ القاعدة غير متاحة الآن — الخادم يخدم الواجهة فقط ويعيد المحاولة دوريًا.');
    const tryConn = async () => {
      try {
        await db.initSchema();
        console.log('✅ استعاد الخادم الاتصال بقاعدة البيانات.');
        try { takeBackups(); } catch (e) {}
      } catch (e) {
        setTimeout(tryConn, 30000);
      }
    };
    setTimeout(tryConn, 30000);
  }
});

process.on('SIGINT', () => { db.pool.end().then(() => process.exit(0)); });
