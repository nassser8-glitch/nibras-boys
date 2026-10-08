'use strict';
// نبراس — طبقة قاعدة البيانات (PostgreSQL)
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

const DATABASE_URL = process.env.DATABASE_URL;
if(!DATABASE_URL && process.env.NODE_ENV === 'production'){ throw new Error('DATABASE_URL is required: set it in the platform environment'); }

const pool = new Pool({ connectionString: DATABASE_URL, max: 10 });

const SCHOOLS = ['BOYS']; // نبراس البنين: قسم واحد فقط

async function initSchema() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id             TEXT PRIMARY KEY,
        school         TEXT NOT NULL CHECK (school = 'BOYS'),
        name           TEXT NOT NULL,
        email          TEXT NOT NULL,
        username       TEXT,
        password_hash  TEXT NOT NULL,
        plain_password TEXT,
        role           TEXT NOT NULL CHECK (role IN ('ADMIN','AGENT','COUNSELOR','TEACHER','ADMINISTRATIVE','SCHOOL_AGENT','STUDENT')),
        active         BOOLEAN NOT NULL DEFAULT true,
        first_login    BOOLEAN NOT NULL DEFAULT false,
        granted        BOOLEAN NOT NULL DEFAULT false,
        data           JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
      )`);
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS users_username_key ON users(username)`);
    await client.query(`ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check`);
    await client.query(`ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('ADMIN','AGENT','COUNSELOR','TEACHER','ADMINISTRATIVE','SCHOOL_AGENT','STUDENT'))`);
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS plain_password TEXT`);
    await client.query(`
      CREATE TABLE IF NOT EXISTS sessions (
        token_hash TEXT PRIMARY KEY,
        user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        school     TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        expires_at TIMESTAMPTZ NOT NULL,
        ip         TEXT,
        user_agent TEXT
      )`);
    await client.query(`
      CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions(user_id)`);
    // أعلام عامة قابلة للتحكم من القاعدة مباشرة (بدون إعادة نشر):
    // تُستخدم حالياً لتفعيل/إيقاف "وضع الصيانة" فوراً من قاعدة البيانات.
    await client.query(`
      CREATE TABLE IF NOT EXISTS app_flags (
        key        TEXT PRIMARY KEY,
        value      JSONB NOT NULL DEFAULT 'false'::jsonb,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`);
    await client.query(`
      CREATE TABLE IF NOT EXISTS school_data (
        school     TEXT PRIMARY KEY CHECK (school = 'BOYS'),
        data       JSONB NOT NULL DEFAULT '{}'::jsonb,
        ts         BIGINT NOT NULL DEFAULT 0,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`);
    await client.query(`
      CREATE TABLE IF NOT EXISTS app_settings (
        school     TEXT PRIMARY KEY CHECK (school = 'BOYS'),
        data       JSONB NOT NULL DEFAULT '{}'::jsonb,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`);
    // نسخ احتياطية دورية لبيانات الأقسام — تُخزَّن خارج جدول school_data نفسه
    // حتى لا تُمسح حتى لو حدث أي استبدال/حذف للبيانات الأصلية (حماية من فقدان كل شيء)
    await client.query(`
      CREATE TABLE IF NOT EXISTS data_backups (
        id       BIGSERIAL PRIMARY KEY,
        school   TEXT NOT NULL CHECK (school = 'BOYS'),
        ts       BIGINT NOT NULL,
        data     JSONB NOT NULL,
        taken_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`);
    await client.query(`CREATE INDEX IF NOT EXISTS data_backups_school_idx ON data_backups(school, id)`);
    // تدقيق المزامنة: يسجل كل PUT (الزمن، العنوان، المتصفح، الدور، وأعداد التكليفات والشواهد)
    // ليتسنى تشخيص أي خلل في المزامنة/الحذف لاحقاً من قاعدة البيانات نفسها.
    await client.query(`
      CREATE TABLE IF NOT EXISTS sync_audit (
        id          BIGSERIAL PRIMARY KEY,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
        school      TEXT NOT NULL,
        ip          TEXT,
        ua          TEXT,
        user_id     TEXT,
        role        TEXT,
        n_assign    INT,
        n_tomb      INT,
        assign_ids  JSONB,
        data_ts     BIGINT,
        payload     INT
      )`);
    await client.query(`CREATE INDEX IF NOT EXISTS sync_audit_school_idx ON sync_audit(school)`);
    await client.query(`CREATE INDEX IF NOT EXISTS sync_audit_time_idx ON sync_audit(created_at)`);
    await client.query(`
      CREATE TABLE IF NOT EXISTS teacher_supervision_schedule (
        school       TEXT NOT NULL CHECK (school = 'BOYS'),
        day_of_week  SMALLINT NOT NULL CHECK (day_of_week BETWEEN 1 AND 5),
        teacher_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        enabled      BOOLEAN NOT NULL DEFAULT true,
        created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (school, day_of_week, teacher_id)
      )`);
    await client.query(`CREATE INDEX IF NOT EXISTS teacher_supervision_schedule_teacher_idx ON teacher_supervision_schedule(teacher_id)`);
    await client.query(`
      CREATE TABLE IF NOT EXISTS teacher_supervision_checkins (
        school        TEXT NOT NULL CHECK (school = 'BOYS'),
        teacher_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        day_of_week   SMALLINT NOT NULL CHECK (day_of_week BETWEEN 1 AND 5),
        checkin_date  DATE NOT NULL,
        checked_in_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (school, teacher_id, checkin_date)
      )`);
    await client.query(`CREATE INDEX IF NOT EXISTS teacher_supervision_checkins_date_idx ON teacher_supervision_checkins(school, checkin_date)`);
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

/* ===== المستخدمون ===== */
async function userByEmail(email) {
  const r = await pool.query('SELECT * FROM users WHERE email = $1', [String(email || '').toLowerCase().trim()]);
  return r.rows[0] || null;
}
async function usersByEmail(email) {
  const r = await pool.query('SELECT * FROM users WHERE email = $1', [String(email || '').toLowerCase().trim()]);
  return r.rows;
}
async function userByUsername(username) {
  const r = await pool.query('SELECT * FROM users WHERE username = $1', [String(username || '').trim().toLowerCase()]);
  return r.rows[0] || null;
}
async function usernameExists(username) {
  const r = await pool.query('SELECT 1 FROM users WHERE username = $1', [String(username || '').trim().toLowerCase()]);
  return r.rows.length > 0;
}
// تحويل الاسم العربي إلى اسم مستخدم لاتيني بسيط (للحصول على قيمة فريدة تُستخدم للدخول)
const AR2LAT = {
  'ا':'a','أ':'a','إ':'a','آ':'a','ٱ':'a','ب':'b','ت':'t','ث':'th','ج':'j','ح':'h','خ':'kh',
  'د':'d','ذ':'dh','ر':'r','ز':'z','س':'s','ش':'sh','ص':'s','ض':'d','ط':'t','ظ':'z',
  'ع':'a','غ':'gh','ف':'f','ق':'q','ك':'k','ل':'l','م':'m','ن':'n','ه':'h','و':'w','ي':'y',
  'ة':'h','ى':'a','ء':'' , 'ؤ':'w','ئ':'y'
};
function baseUsername(name) {
  let s = String(name || '');
  s = s.replace(/[\u064B-\u0652\u0670\u0640]/g, ''); // التشكيل
  let out = '';
  for (const ch of s) {
    if (AR2LAT[ch]) out += AR2LAT[ch];
    else if (/[a-zA-Z0-9]/.test(ch)) out += ch.toLowerCase();
    // أي حرف آخر (مسافات، رموز) يُتجاهل
  }
  if (!out) out = 'user';
  out = out.replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, '');
  if (!out) out = 'user';
  return out.slice(0, 24);
}
async function generateUsername(name, preferred) {
  const base = baseUsername(preferred && String(preferred).trim() ? preferred : name);
  let candidate = base;
  let i = 1;
  while (await usernameExists(candidate)) { i++; candidate = base + i; }
  return candidate;
}
async function generateUsernameUnique(name, existingUsernames) {
  const base = baseUsername(name);
  let candidate = base;
  let i = 1;
  while ((existingUsernames && existingUsernames.has(candidate)) || await usernameExists(candidate)) { i++; candidate = base + i; }
  return candidate;
}
async function userById(id) {
  const r = await pool.query('SELECT * FROM users WHERE id = $1', [id]);
  return r.rows[0] || null;
}
async function listUsers(school) {
  const r = await pool.query('SELECT * FROM users WHERE school = $1 ORDER BY name', [school]);
  return r.rows;
}
// إحصاءات الدخول الموثوقة من جدول الحسابات (مصدر الحقيقة) لعرضها في لوحة التفعيل حتى لو اختلفت معرّفات نسخة القسم
async function usersForLoginStats(school) {
  const r = await pool.query(
    `SELECT id, username, name, active, first_login, data FROM users WHERE school = $1`,
    [school]);
  return r.rows;
}
async function listAllUsers() {
  const r = await pool.query('SELECT id, school, name, email, username, role, active, first_login FROM users ORDER BY school, role, name');
  return r.rows;
}
async function findDiagnosticUsers(usernames) {
  const names = Array.from(new Set((usernames || [])
    .map(username => String(username || '').trim().toLowerCase())
    .filter(Boolean)));
  if (!names.length) return [];
  const r = await pool.query(
    `SELECT u.id, u.username, u.school, u.role, u.active, u.name,
       EXISTS (
         SELECT 1
           FROM school_data sd
          CROSS JOIN LATERAL jsonb_array_elements(COALESCE(sd.data->'users', '[]'::jsonb)) AS item
          WHERE sd.school = u.school
            AND ((item->>'id') = u.id OR lower(item->>'username') = lower(u.username))
       ) AS school_data_user_exists,
       EXISTS (
         SELECT 1
           FROM school_data sd
          CROSS JOIN LATERAL jsonb_array_elements(COALESCE(sd.data->'students', '[]'::jsonb)) AS item
          WHERE sd.school = u.school
            AND ((item->>'id') = u.id OR lower(item->>'username') = lower(u.username))
       ) AS school_data_student_exists
      FROM users u
     WHERE lower(u.username) = ANY($1::text[])
     ORDER BY lower(u.username), u.school, u.id`,
    [names]);
  return r.rows;
}
async function usernamesByIds(ids) {
  const r = await pool.query('SELECT id, username FROM users WHERE id = ANY($1::text[]) AND username IS NOT NULL', [ids]);
  const m = new Map();
  r.rows.forEach(x => m.set(x.id, x.username));
  return m;
}
async function countAdmins() {
  const r = await pool.query(`SELECT count(*)::int AS n FROM users WHERE role = 'ADMIN'`);
  return r.rows[0] ? r.rows[0].n : 0;
}
async function insertUser(u) {
  assertSupportedSchool(u.school); // يمنع إنشاء حساب BOYS (بلا migration)
  await pool.query(
    `INSERT INTO users (id, school, name, email, username, password_hash, plain_password, role, active, first_login, granted, data)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     ON CONFLICT (id) DO UPDATE SET
       name=EXCLUDED.name, email=EXCLUDED.email, username=EXCLUDED.username,
       password_hash=EXCLUDED.password_hash,
       plain_password=COALESCE(EXCLUDED.plain_password, users.plain_password),
       role=EXCLUDED.role, active=EXCLUDED.active, first_login=EXCLUDED.first_login,
       granted=EXCLUDED.granted, data=EXCLUDED.data`,
    [u.id, u.school, u.name, String(u.email).toLowerCase().trim(), u.username ? String(u.username).trim().toLowerCase() : null,
     u.password_hash, u.plain_password || null, u.role, u.active !== false, !!u.first_login, u.granted === true, JSON.stringify(u.data || {})]);
}

// إنشاء حساب طالب ومرآته وسجلها في معاملة واحدة؛ لا تستخدم هذه العملية
// generateUsername ولا تُجري أي كتابة قبل اكتمال جميع فحوصات التكرار.
async function createStudentAccountAndRecord(input) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const id = String(input.id);
    const username = String(input.username);
    const school = String(input.school);
    assertSupportedSchool(school); // يمنع إنشاء حساب BOYS (بلا migration)
    const existingUser = await client.query('SELECT 1 FROM users WHERE id = $1', [id]);
    if (existingUser.rows.length) {
      const err = new Error('duplicate_student');
      err.code = 'duplicate_student';
      throw err;
    }
    const existingUsername = await client.query(
      'SELECT 1 FROM users WHERE lower(username) = lower($1) LIMIT 1', [username]);
    if (existingUsername.rows.length) {
      const err = new Error('username_exists');
      err.code = 'username_exists';
      throw err;
    }

    await client.query(
      'INSERT INTO school_data (school, data, ts) VALUES ($1, $2::jsonb, $3) ON CONFLICT (school) DO NOTHING',
      [school, JSON.stringify({ users: [], grades: [], classes: [], students: [], notes: [], points: [] }), Date.now()]);
    const schoolRow = await client.query(
      'SELECT data FROM school_data WHERE school = $1 FOR UPDATE', [school]);
    const data = schoolRow.rows[0].data || {};
    const students = Array.isArray(data.students) ? data.students.slice() : [];
    if (students.some(student => student && String(student.id) === id)) {
      const err = new Error('duplicate_student');
      err.code = 'duplicate_student';
      throw err;
    }
    if (input.student.studentNo && students.some(student =>
      student && student.active !== false && String(student.studentNo) === String(input.student.studentNo))) {
      const err = new Error('student_number_exists');
      err.code = 'student_number_exists';
      throw err;
    }

    const student = Object.assign({}, input.student, { id });
    students.push(student);
    const users = Array.isArray(data.users) ? data.users.slice() : [];
    users.push({
      id, school, name: input.name, username, email: input.email, role: 'STUDENT',
      active: true, firstLogin: false, granted: true,
    });
    const nextData = Object.assign({}, data, { users, students });

    await client.query(
      `INSERT INTO users
        (id, school, name, email, username, password_hash, plain_password, role, active, first_login, granted, data)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'STUDENT',true,false,true,'{}'::jsonb)`,
      [id, school, input.name, input.email, username, input.passwordHash, input.password,]);
    await client.query(
      `UPDATE school_data SET data = $2::jsonb, ts = $3, updated_at = now() WHERE school = $1`,
      [school, JSON.stringify(nextData), Date.now()]);
    await client.query('COMMIT');

    const cls = Array.isArray(data.classes)
      ? data.classes.find(item => item && item.id === student.classId)
      : null;
    const grade = cls && Array.isArray(data.grades)
      ? data.grades.find(item => item && item.id === cls.gradeId)
      : null;
    return {
      id, name: input.name, grade: grade ? grade.name : null,
      class: cls ? cls.name : null, username, student,
    };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    if (error && error.code === '23505') {
      if (String(error.constraint || '').indexOf('username') >= 0) error.code = 'username_exists';
      else if (String(error.constraint || '').indexOf('users_pkey') >= 0) error.code = 'duplicate_student';
    }
    throw error;
  } finally {
    client.release();
  }
}
// منح حق الدخول لحساب (بعد تصدير بيانات دخوله أو إنشائه يدويًا من المدير)
async function grantUserAccess(id) {
  await pool.query('UPDATE users SET granted = true WHERE id = $1', [id]);
}
// إنهاء «بانتظار أول دخول» بدون تغيير كلمة المرور — للمدير حين يعتبر المعلم مُفعّلة.
// يضبط أول دخول في جدول الحسابات (مصدر الحقيقة) لا في نسخة القسم فقط.
async function clearFirstLogin(id) {
  await pool.query('UPDATE users SET first_login = false WHERE id = $1', [id]);
}
async function updateUserPasswordHash(id, hash, firstLogin) {
  await pool.query('UPDATE users SET password_hash=$2, first_login=$3 WHERE id=$1',
    [id, hash, firstLogin !== false]);
}
async function updateUserPlainPassword(id, plainPassword) {
  await pool.query('UPDATE users SET plain_password=$2 WHERE id=$1',
    [id, plainPassword || null]);
}
async function updateUserProfile(id, fields) {
  const data = JSON.stringify(fields.data || {});
  await pool.query('UPDATE users SET data=$2::jsonb WHERE id=$1', [id, data]);
}
async function setUserActive(id, active) {
  await pool.query('UPDATE users SET active=$2 WHERE id=$1', [id, active !== false]);
}
async function deactivateUser(id) { await setUserActive(id, false); }
// حارس دفاعي: النظام BOYS فقط. يمنع كتابة أي قسم خارج SCHOOLS بلا تغيير بنية الجداول
// (قيود CHECK التي تذكر BOYS تبقى كما هي عمداً — تغييرها migration).
function assertSupportedSchool(school) {
  if (!SCHOOLS.includes(school)) throw new Error('unsupported_school');
  return school;
}
async function setUserSchool(id, school) {
  assertSupportedSchool(school);
  await pool.query('UPDATE users SET school=$2 WHERE id=$1', [id, school]);
}
async function updateUserIdentity(id, fields) {
  const sets = [];
  const vals = [id];
  if (fields.name !== undefined) { sets.push('name=$' + (vals.length + 1)); vals.push(fields.name); }
  if (fields.email !== undefined) { sets.push('email=$' + (vals.length + 1)); vals.push(String(fields.email).toLowerCase().trim()); }
  if (fields.username !== undefined) { sets.push('username=$' + (vals.length + 1)); vals.push(String(fields.username).trim().toLowerCase()); }
  if (!sets.length) return;
  await pool.query('UPDATE users SET ' + sets.join(', ') + ' WHERE id=$1', vals);
}
async function setUserUsername(id, username) {
  await pool.query('UPDATE users SET username=$2 WHERE id=$1', [id, String(username || '').trim().toLowerCase()]);
}

/* ===== الجلسات ===== */
async function createSession(userId, school, tokenHash, ttlMs, ip, ua) {
  await pool.query(
    `INSERT INTO sessions (token_hash, user_id, school, expires_at, ip, user_agent)
     VALUES ($1,$2,$3, now() + ($4::float/1000 || ' seconds')::interval, $5, $6)`,
    [tokenHash, userId, school, ttlMs, ip, ua]);
}
async function sessionByTokenHash(tokenHash) {
  const r = await pool.query(
    `SELECT s.*, u.name, u.role, u.active, u.first_login, u.data
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = $1 AND s.expires_at > now() AND u.active = true`, [tokenHash]);
  return r.rows[0] || null;
}
// تمديد جلسة نشطة (تجديد زاحف): المستخدم الذي يعمل طول اليوم لا يُطرد في منتصفه.
// يُستدعى فقط عندما يكون المتبقي أقل من نصف المدة، مرة واحدة كل 30 دقيقة.
async function touchSession(tokenHash, ttlMs) {
  const r = await pool.query(
    `UPDATE sessions
        SET expires_at = now() + ($2::float/1000 || ' seconds')::interval
      WHERE token_hash = $1
      RETURNING expires_at`, [tokenHash, ttlMs]);
  return r.rows[0] ? r.rows[0].expires_at : null;
}
async function deleteSession(tokenHash) {
  await pool.query('DELETE FROM sessions WHERE token_hash = $1', [tokenHash]);
}
async function deleteUserSessions(userId) {
  await pool.query('DELETE FROM sessions WHERE user_id = $1', [userId]);
}
// إنهاء الدخول برحلة واحدة: إنشاء الجلسة + تحديث users.data
// + تحديث جزئي لنسخة القسم (school_data.users) — بدل 4 استعلامات متتالية.
//
// عن `cut`: كان هنا `DELETE FROM sessions WHERE user_id = $1` عند كل دخول، أي «جلسة
// واحدة لكل مستخدم». فكل دخول من جهاز آخر (هاتف + حاسوب المدرسة مثلًا) كان يطرد جلسة
// الجهاز الأول بلا سبب ظاهر، ولا تلمسه الواجهة التي تعرض نفسها مسجّلة الدخول من
// sessionStorage بينما كل كتابة على الخادم ترتدّ 401.
// الآن الدخول يُبقي بقية الجلسات، ولا يحذف إلا المنتهية وما تجاوز السقف (12).
// المسارات الأمنية لم تتغيّر: تغيير كلمة المرور وإعادة التعيين وتعطيل/حذف المستخدم
// تستدعي deleteUserSessions فتُبطل كل الجلسات كما هي.
async function finalizeLogin(userId, school, tokenHash, ttlMs, ip, ua, userDataJson, loginCount, lastLoginIso, historyJson) {
  assertSupportedSchool(school); // يمنع الدخول من لمسح school_data الخاص بـ BOYS
  const r = await pool.query(
    `WITH cut AS (
        DELETE FROM sessions
         WHERE user_id = $1
           AND (expires_at <= now()
             OR token_hash IN (SELECT token_hash FROM sessions
                                 WHERE user_id = $1 ORDER BY created_at DESC OFFSET 12))
     ), upd AS (
        UPDATE users
           SET data = $4::jsonb, first_login = false
         WHERE id = $1
     ), sc AS (
        UPDATE school_data
           SET data = jsonb_set(data, '{users}', (
             SELECT COALESCE(jsonb_agg(
               CASE WHEN elem->>'id' = $1
                    THEN elem || jsonb_build_object(
                           'firstLogin', to_jsonb(false),
                           'lastLogin', to_jsonb($5::text),
                           'loginCount', to_jsonb($3::int),
                           'loginHistory', COALESCE($6::jsonb, '[]'::jsonb))
                    ELSE elem END), '[]'::jsonb)
             FROM jsonb_array_elements(data->'users') elem
           ), false)
         WHERE school = $2
     ), ins AS (
        INSERT INTO sessions (token_hash, user_id, school, expires_at, ip, user_agent)
        VALUES ($7, $1, $2, now() + ($8::float/1000 || ' seconds')::interval, $9, $10)
        RETURNING created_at, expires_at
     )
     SELECT created_at, expires_at FROM ins`,
    [userId, school, loginCount, JSON.stringify(userDataJson), lastLoginIso, JSON.stringify(historyJson),
     tokenHash, ttlMs, ip, ua]);
  return r.rows[0] || null;
}
async function repairTeacherFirstLoginFromEvidence(school, apply) {
  const query = `
    SELECT id
      FROM users
     WHERE school = $1
       AND role = 'TEACHER'
       AND active = true
       AND first_login = true
       AND (
         data->>'lastLogin' IS NOT NULL
         OR (jsonb_typeof(data->'loginHistory') = 'array' AND jsonb_array_length(data->'loginHistory') > 0)
         OR (data->>'loginCount') ~ '^[1-9][0-9]*$'
       )
     ORDER BY id`;
  if (!apply) {
    const r = await pool.query(query, [school]);
    return { candidateIds: r.rows.map(row => row.id), updatedIds: [] };
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const candidates = await client.query(query, [school]);
    const ids = candidates.rows.map(row => row.id);
    if (!ids.length) {
      await client.query('COMMIT');
      return { candidateIds: [], updatedIds: [] };
    }
    await client.query('UPDATE users SET first_login = false WHERE id = ANY($1::text[])', [ids]);
    await client.query(
      `UPDATE school_data
          SET data = jsonb_set(data, '{users}', (
            SELECT COALESCE(jsonb_agg(
              CASE WHEN elem->>'id' = ANY($2::text[])
                   THEN elem || jsonb_build_object('firstLogin', false)
                   ELSE elem END), '[]'::jsonb)
            FROM jsonb_array_elements(data->'users') elem
          ), false),
              updated_at = now()
        WHERE school = $1`,
      [school, ids]);
    await client.query('COMMIT');
    return { candidateIds: ids, updatedIds: ids };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw error;
  } finally {
    client.release();
  }
}
async function activateTeachersSafely(school, apply) {
  const query = `
    SELECT id, active, first_login,
           (
             data->>'lastLogin' IS NOT NULL
             OR (jsonb_typeof(data->'loginHistory') = 'array' AND jsonb_array_length(data->'loginHistory') > 0)
             OR (data->>'loginCount') ~ '^[1-9][0-9]*$'
           ) AS has_login_evidence
      FROM users
     WHERE school = $1
       AND role = 'TEACHER'
     ORDER BY id`;
  if (!apply) {
    const r = await pool.query(query, [school]);
    return {
      candidates: r.rows.map(row => ({
        id: row.id,
        activate: row.active !== true,
        clearFirstLogin: row.first_login === true && row.has_login_evidence === true,
      })),
      updated: [],
    };
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const r = await client.query(query + ' FOR UPDATE', [school]);
    const rows = r.rows;
    const activateIds = rows.filter(row => row.active !== true).map(row => row.id);
    const clearFirstLoginIds = rows
      .filter(row => row.first_login === true && row.has_login_evidence === true)
      .map(row => row.id);
    const changedIds = [...new Set([...activateIds, ...clearFirstLoginIds])];
    if (activateIds.length) {
      await client.query('UPDATE users SET active = true WHERE id = ANY($1::text[])', [activateIds]);
    }
    if (clearFirstLoginIds.length) {
      await client.query('UPDATE users SET first_login = false WHERE id = ANY($1::text[])', [clearFirstLoginIds]);
    }
    if (changedIds.length) {
      const schoolUpdate = await client.query(
        `UPDATE school_data
            SET data = jsonb_set(data, '{users}', (
              SELECT COALESCE(jsonb_agg(
                CASE WHEN elem->>'id' = ANY($2::text[])
                     THEN elem
                       || CASE WHEN elem->>'id' = ANY($3::text[])
                               THEN jsonb_build_object('active', true)
                               ELSE '{}'::jsonb END
                       || CASE WHEN elem->>'id' = ANY($4::text[])
                               THEN jsonb_build_object('firstLogin', false)
                               ELSE '{}'::jsonb END
                     ELSE elem END), '[]'::jsonb)
              FROM jsonb_array_elements(data->'users') elem
            ), false),
                updated_at = now()
          WHERE school = $1`,
        [school, changedIds, activateIds, clearFirstLoginIds]);
      if (schoolUpdate.rowCount !== 1) throw new Error('school_data_not_found');
    }
    await client.query('COMMIT');
    return {
      candidates: rows.map(row => ({
        id: row.id,
        activate: row.active !== true,
        clearFirstLogin: row.first_login === true && row.has_login_evidence === true,
      })),
      updated: changedIds.map(id => ({
        id,
        active: activateIds.includes(id),
        ...(clearFirstLoginIds.includes(id) ? { firstLogin: false } : {}),
      })),
    };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw error;
  } finally {
    client.release();
  }
}
async function sweepSessions() {
  await pool.query('DELETE FROM sessions WHERE expires_at <= now()');
}

const SUPERVISION_DAYS = new Set([1, 2, 3, 4, 5]);
const SUPERVISION_VISIBLE_ROLES = new Set(['ADMIN', 'AGENT', 'TEACHER', 'SCHOOL_AGENT']);

// من يملك حق استدعاء /api/supervision/today أصلًا (بقية الأدوار تُرفض فورًا).
function canViewSupervisionToday(role) {
  return SUPERVISION_VISIBLE_ROLES.has(role);
}

// المدير والوكيل والوكيل يريان جميع مشرفات اليوم؛ المعلم ترى تكليفها هي فقط وليس زميلاتها.
// («الوكيل/الوكيل» يدخل بنفسه من أدى الإشراف ومن لم يؤده).
function filterSupervisionAssignments(role, rows, userId) {
  if (role === 'ADMIN' || role === 'AGENT' || role === 'SCHOOL_AGENT') return rows;
  if (role === 'TEACHER') return rows.filter(row => row.teacher_id === userId);
  return [];
}

async function getSupervisionSchedule(school) {
  const r = await pool.query(
    `SELECT s.day_of_week, s.teacher_id, s.enabled, u.name, u.active
       FROM teacher_supervision_schedule s
       JOIN users u ON u.id = s.teacher_id
      WHERE s.school = $1
      ORDER BY s.day_of_week, u.name`,
    [school]);
  return r.rows;
}

async function replaceSupervisionSchedule(school, assignments) {
  if (!Array.isArray(assignments)) throw new Error('invalid_schedule');
  const unique = new Set();
  for (const item of assignments) {
    const day = Number(item && item.dayOfWeek);
    const teacherId = String(item && item.teacherId || '');
    const key = `${day}:${teacherId}`;
    if (!SUPERVISION_DAYS.has(day) || !teacherId || unique.has(key)) throw new Error('invalid_schedule');
    unique.add(key);
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (assignments.length) {
      const ids = [...new Set(assignments.map(item => String(item.teacherId || '')))];
      const valid = await client.query(
        `SELECT id FROM users WHERE school = $1 AND role = 'TEACHER' AND active = true AND id = ANY($2::text[])`,
        [school, ids]);
      if (valid.rows.length !== ids.length) throw new Error('invalid_teacher');
    }
    await client.query('DELETE FROM teacher_supervision_schedule WHERE school = $1', [school]);
    for (const item of assignments) {
      await client.query(
        `INSERT INTO teacher_supervision_schedule (school, day_of_week, teacher_id, enabled)
         VALUES ($1,$2,$3,true)`,
        [school, Number(item.dayOfWeek), String(item.teacherId)]);
    }
    await client.query('COMMIT');
    return getSupervisionSchedule(school);
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw error;
  } finally {
    client.release();
  }
}

async function getSupervisionForDate(school, dayOfWeek, date) {
  if (!SUPERVISION_DAYS.has(Number(dayOfWeek))) return [];
  const r = await pool.query(
    `SELECT s.day_of_week, s.teacher_id, u.name, c.checked_in_at
       FROM teacher_supervision_schedule s
       JOIN users u ON u.id = s.teacher_id AND u.active = true
       LEFT JOIN teacher_supervision_checkins c
         ON c.school = s.school AND c.teacher_id = s.teacher_id AND c.checkin_date = $3::date
      WHERE s.school = $1 AND s.day_of_week = $2 AND s.enabled = true
      ORDER BY u.name`,
    [school, Number(dayOfWeek), date]);
  return r.rows;
}

async function checkInSupervision(school, teacherId, dayOfWeek, date) {
  if (!SUPERVISION_DAYS.has(Number(dayOfWeek))) throw new Error('no_supervision_today');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const assigned = await client.query(
      `SELECT 1 FROM teacher_supervision_schedule
        WHERE school = $1 AND day_of_week = $2 AND teacher_id = $3 AND enabled = true`,
      [school, Number(dayOfWeek), teacherId]);
    if (!assigned.rows.length) throw new Error('not_assigned');
    const result = await client.query(
      `INSERT INTO teacher_supervision_checkins (school, teacher_id, day_of_week, checkin_date)
       VALUES ($1,$2,$3,$4::date)
       ON CONFLICT (school, teacher_id, checkin_date) DO NOTHING
       RETURNING teacher_id, day_of_week, checkin_date, checked_in_at`,
      [school, teacherId, Number(dayOfWeek), date]);
    await client.query('COMMIT');
    return { created: result.rows.length > 0, record: result.rows[0] || null };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw error;
  } finally {
    client.release();
  }
}

// للوكيل/المدير: تسجيل أن المعلم باشرت الإشراف في تاريخ معيّن (checkIn=true)
// أو إلغاء ذلك/تسجّل أنها لم تؤده (checkIn=false). تُقيَّد المعلم وتاريخ اليوم.
async function recordSupervisionCheckIn(school, teacherId, checkinDate, checkIn) {
  const assigned = await pool.query(
    `SELECT 1 FROM teacher_supervision_schedule
      WHERE school = $1 AND day_of_week = (EXTRACT(ISODOW FROM $2::date))::int
        AND teacher_id = $3 AND enabled = true`,
    [school, checkinDate, teacherId]);
  if (!assigned.rows.length) throw new Error('not_assigned');
  const r = await pool.query(
    `INSERT INTO teacher_supervision_checkins (school, teacher_id, day_of_week, checkin_date)
     VALUES ($1,$2,(EXTRACT(ISODOW FROM $3::date))::int,$3::date)
     ON CONFLICT (school, teacher_id, checkin_date)
     DO UPDATE SET checked_in_at = CASE WHEN $4::boolean
       THEN COALESCE(teacher_supervision_checkins.checked_in_at, now())
       ELSE NULL END
     RETURNING teacher_id, checkin_date, checked_in_at`,
    [school, teacherId, checkinDate, checkIn]);
  const record = r.rows[0] || null;
  if (record && !record.checked_in_at && !checkIn) {
    // إذا كانت النتيجة أن لا سجل مباشرة فعلًا، نحذف الصف ليبقى الجدول نظيفًا
    await pool.query(
      `DELETE FROM teacher_supervision_checkins
        WHERE school = $1 AND teacher_id = $2 AND checkin_date = $3::date`,
      [school, teacherId, checkinDate]);
  }
  return { teacherId, checkinDate, checkedInAt: record ? record.checked_in_at : null, cancelled: !checkIn };
}

async function getSupervisionHistory(school, limit) {
  const r = await pool.query(
    `SELECT d::date AS supervision_date, EXTRACT(ISODOW FROM d)::int AS day_of_week,
            s.teacher_id, u.name, c.checked_in_at
       FROM generate_series(current_date - INTERVAL '90 days', current_date, INTERVAL '1 day') d
       JOIN teacher_supervision_schedule s
         ON s.school = $1 AND s.day_of_week = EXTRACT(ISODOW FROM d)::int AND s.enabled = true
       JOIN users u ON u.id = s.teacher_id
       LEFT JOIN teacher_supervision_checkins c
         ON c.school = s.school AND c.teacher_id = s.teacher_id
        AND c.checkin_date = d::date
      WHERE EXTRACT(ISODOW FROM d) BETWEEN 1 AND 5
      ORDER BY supervision_date DESC, day_of_week, u.name
      LIMIT $2`,
    [school, Math.min(Math.max(Number(limit) || 200, 1), 1000)]);
  return r.rows;
}

/* ===== بيانات الأقسام ===== */
async function getSchoolData(school) {
  const r = await pool.query('SELECT data, ts FROM school_data WHERE school = $1', [school]);
  if (!r.rows.length) return { data: null, ts: 0 };
  return { data: r.rows[0].data, ts: Number(r.rows[0].ts) || 0 };
}
// كتابة محمية زمنياً: لا تُستبدل نسخة ذات ts أحدث بنسخة ts أقدم.
// السبب: school_data صف واحد لكل قسم ويحوي النظام كله (users/classes/students...).
// أي كاتب يتأخر带着 لقطة قديمة كان يكتبها فوق أحدث نسخة فيرجع ts للخلف.
// مع ON CONFLICT..WHERE يصبح ts رتيباً دائماً: الأقدم فقط هو الفائز.
// يُرجع { written, storedTs } — written=false تعني رفضَ كتابة قديمة (لا استبدال).
async function setSchoolData(school, data, ts) {
  assertSupportedSchool(school); // يمنع إنشاء/كتابة صف BOYS (بلا migration)
  const nextTs = Number(ts) || 0;
  const r = await pool.query(
    `INSERT INTO school_data (school, data, ts, updated_at)
     VALUES ($1,$2,$3, now())
     ON CONFLICT (school) DO UPDATE SET data=EXCLUDED.data, ts=EXCLUDED.ts, updated_at=now()
     WHERE school_data.ts < EXCLUDED.ts`,
    [school, JSON.stringify(data), nextTs]);
  if (r.rowCount > 0) return { written: true, storedTs: nextTs };
  // رُفضت الكتابة: نقرأ الـts المخزَّن فعلاً (لا المُدخَل) ليعود المتصل برقم صحيح
  // ويعيد المحاولة فوق الأحدث. وقبل هذا كان storedTs يساوي nextTs المُدخَل دائماً،
  // فلا يميّزه المتصل بين «الأحدث على الخادم» و«الذي حاولنا» — في放弃 فوراً.
  const cur = await pool.query('SELECT ts FROM school_data WHERE school = $1', [school]);
  return { written: false, storedTs: (cur.rows[0] && Number(cur.rows[0].ts)) || 0 };
}

// تعديل جزئي داخل معاملة واحدة: BEGIN -> SELECT ... FOR UPDATE -> تعديل المطلوب -> UPDATE -> COMMIT.
// تُغلق نافذة السباق التي كانت تسمح لكاتب قديم بإعادة كتابة لقطة كاملة.
// السبب الجذري: updateSchoolUser/markSchoolUsersActivated/appendSchoolUser كانت
//   (1) تقرأ الصف كاملاً  (2) تعدّل users فقط  (3) تعيد كتابة الصف كاملاً بلقطة قديمة
// فيُلغى أي حفظ أحدث تم بين (1) و(3) — وهو سبب ضياع دفعات الطلاب.
// mutator يستقبل كائن البيانات المعدَّل في مكانه ويُرجع:
//   { changed:boolean, value:any }  أو  true/false  أو  undefined (=لا تغيير)
// يدعم الدوال غير المتزامنة (async) — تُنتظر نتيجتها قبل الحسم.
// ts يُحسب رتيباً: max(Date.now(), storedTs+1) فلا يتراجع أبداً.
const EMPTY_SKELETON = () => ({ users: [], grades: [], classes: [], students: [], attendance: [], notes: [], transfers: [] });
function _normMutatorOut(out) {
  if (out && typeof out === 'object') return { changed: out.changed === true, value: ('value' in out) ? out.value : null };
  if (out === true) return { changed: true, value: true };
  if (out === false || out === undefined || out === null) return { changed: false, value: null };
  return { changed: true, value: out };
}
async function mutateSchoolData(school, mutator) {
  assertSupportedSchool(school);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const sel = await client.query('SELECT data, ts FROM school_data WHERE school = $1 FOR UPDATE', [school]);
    if (!sel.rows.length) {
      // لا صف بعد: لا توجد لقطة أقدم يمكن الكتابة فوقها — ننشئ الصف (نفس سلوك setSchoolData السابق).
      const data = EMPTY_SKELETON();
      const n = _normMutatorOut(await mutator(data));
      if (!n.changed) { await client.query('ROLLBACK'); return { written: false, value: n.value, reason: 'no_change' }; }
      const nextTs = Math.max(Date.now(), 1);
      const ins = await client.query(
        `INSERT INTO school_data (school, data, ts, updated_at) VALUES ($1,$2,$3, now())
         ON CONFLICT (school) DO UPDATE SET data=EXCLUDED.data, ts=EXCLUDED.ts, updated_at=now()
         WHERE school_data.ts < EXCLUDED.ts`,
        [school, JSON.stringify(data), nextTs]);
      if (!ins.rowCount) { await client.query('ROLLBACK'); return { written: false, value: n.value, reason: 'stale' }; }
      await client.query('COMMIT');
      return { written: true, value: n.value, ts: nextTs };
    }
    const data = sel.rows[0].data;
    const storedTs = Number(sel.rows[0].ts) || 0;
    const n = _normMutatorOut(await mutator(data));
    if (!n.changed) { await client.query('ROLLBACK'); return { written: false, value: n.value, reason: 'no_change' }; }
    // ts رتيب: لا نسمح لأي كتابة بأن تُرجع الساعة للخلف مقارنة بالصف المقفول.
    const nextTs = Math.max(Date.now(), storedTs + 1);
    const upd = await client.query(
      `UPDATE school_data SET data = $2::jsonb, ts = $3, updated_at = now()
        WHERE school = $1 AND ts < $3`,
      [school, JSON.stringify(data), nextTs]);
    if (!upd.rowCount) { await client.query('ROLLBACK'); return { written: false, value: n.value, reason: 'stale' }; }
    await client.query('COMMIT');
    return { written: true, value: n.value, ts: nextTs };
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw e;
  } finally {
    client.release();
  }
}
// تحديث إحصاءات الدخول داخل نسخة القسم (school_data.users) بتعديل جزئي على الخادم
// دون نقل ملف البيانات الكامل (348KB) إلى العميل — أسرع بكثير في كل دخول.
async function getSchoolSettings(school) {
  const r = await pool.query('SELECT data FROM app_settings WHERE school = $1', [school]);
  return (r.rows.length && r.rows[0].data) ? r.rows[0].data : {};
}
async function setSchoolSettings(school, data) {
  await pool.query(
    `INSERT INTO app_settings (school, data, updated_at)
     VALUES ($1,$2, now())
     ON CONFLICT (school) DO UPDATE SET data=EXCLUDED.data, updated_at=now()`,
    [school, JSON.stringify(data)]);
}
async function patchSchoolUserStats(school, userId, lastLoginIso, loginCount, historyJsonArray) {
  await pool.query(
    `UPDATE school_data
        SET data = jsonb_set(data, '{users}', (
          SELECT COALESCE(jsonb_agg(
            CASE WHEN elem->>'id' = $1
                 THEN elem || jsonb_build_object(
                        'lastLogin', to_jsonb($2::text),
                        'loginCount', to_jsonb($3::int),
                        'loginHistory', COALESCE($4::jsonb, '[]'::jsonb))
                 ELSE elem END), '[]'::jsonb)
          FROM jsonb_array_elements(data->'users') elem
        ), false)
      WHERE school = $5`,
    [userId, lastLoginIso, loginCount, JSON.stringify(historyJsonArray), school]);
}
// تحديث مكان التواجد (lastSeenAt) في مصدر الحقيقة (جدول users) وفي نسخة القسم
// المُرسلة للعملاء — ليرى المدير من المتواجد/المتواجدة الآن بالضغط على البطاقة.
async function touchUserPresence(school, userId, isoNow) {
  await pool.query(`UPDATE users SET data = data || $2::jsonb WHERE id = $1`, [userId, JSON.stringify({ lastSeenAt: isoNow })]);
  await pool.query(
    `UPDATE school_data
        SET data = jsonb_set(data, '{users}', (
          SELECT COALESCE(jsonb_agg(
            CASE WHEN elem->>'id' = $1
                 THEN elem || jsonb_build_object('lastSeenAt', to_jsonb($2::text))
                 ELSE elem END), '[]'::jsonb)
          FROM jsonb_array_elements(data->'users') elem
        ), false)
      WHERE school = $3`,
    [userId, isoNow, school]);
}

/* ===== النسخ الاحتياطي الدوري ===== */
const BACKUP_KEEP = 30;
async function saveBackup(school, ts, data) {
  await pool.query(
    `INSERT INTO data_backups (school, ts, data) VALUES ($1,$2,$3)`,
    [school, ts, JSON.stringify(data)]);
  // تُبقي آخر 200 نسخة لكل قسم فقط كي لا تكبر القاعدة بلا حدود
  await pool.query(
    `DELETE FROM data_backups WHERE school = $1 AND id NOT IN (
       SELECT id FROM data_backups WHERE school = $1 ORDER BY id DESC LIMIT ${BACKUP_KEEP})`,
    [school]);
}
async function listBackups(school, limit) {
  const r = await pool.query(
    `SELECT id, school, ts, taken_at FROM data_backups WHERE school = $1 ORDER BY id DESC LIMIT $2`,
    [school, limit || 30]);
  return r.rows;
}
async function getBackup(id) {
  const r = await pool.query(`SELECT id, school, ts, data, taken_at FROM data_backups WHERE id = $1`, [Number(id) || 0]);
  return r.rows[0] || null;
}

/* ===== تدقيق المزامنة ===== */
async function auditSync(rec) {
  try {
    await pool.query(
      `INSERT INTO sync_audit (school, ip, ua, user_id, role, n_assign, n_tomb, assign_ids, data_ts, payload)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [rec.school, rec.ip || null, rec.ua || null, rec.user_id || null, rec.role || null,
       rec.n_assign || 0, rec.n_tomb || 0, JSON.stringify(rec.assign_ids || []), rec.data_ts || 0, rec.payload || 0]);
    // إبقاء التدقيق محدوداً: آخر 5000 سطر فقط
    await pool.query(`DELETE FROM sync_audit WHERE id NOT IN (SELECT id FROM sync_audit ORDER BY id DESC LIMIT 5000)`);
  } catch (e) {
    // فشل التدقيق لا يجب أن يكسر الحفظ
    console.error('auditSync failed:', e.message);
  }
}

/* ===== الأعلام العامة ===== */
async function getFlag(key) {
  const r = await pool.query('SELECT value FROM app_flags WHERE key = $1', [key]);
  return r.rows.length ? r.rows[0].value : null;
}
async function setFlag(key, value) {
  await pool.query(
    `INSERT INTO app_flags (key, value, updated_at) VALUES ($1,$2, now())
     ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=now()`,
    [key, JSON.stringify(value)]);
}

module.exports = {
  pool, SCHOOLS,
  initSchema,
  getFlag, setFlag,
  userByEmail, usersByEmail, userByUsername, usernameExists, generateUsername, baseUsername,
  userById, listUsers, listAllUsers, findDiagnosticUsers, usersForLoginStats, usernamesByIds, countAdmins, insertUser,
  createStudentAccountAndRecord,
  updateUserPasswordHash, updateUserPlainPassword, updateUserProfile, grantUserAccess, clearFirstLogin,
  setUserActive, deactivateUser, setUserSchool, updateUserIdentity, setUserUsername,
  createSession, sessionByTokenHash, touchSession, deleteSession, deleteUserSessions, sweepSessions, finalizeLogin,
  repairTeacherFirstLoginFromEvidence,
  activateTeachersSafely,
  getSupervisionSchedule, replaceSupervisionSchedule, getSupervisionForDate,
  checkInSupervision, recordSupervisionCheckIn, getSupervisionHistory,
  canViewSupervisionToday, filterSupervisionAssignments,
  supervisionVisibleRoles: () => [...SUPERVISION_VISIBLE_ROLES],
  getSchoolData, setSchoolData, mutateSchoolData, patchSchoolUserStats, touchUserPresence,
  getSchoolSettings, setSchoolSettings,
  saveBackup, listBackups, getBackup,
  auditSync,
};
