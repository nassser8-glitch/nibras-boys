'use strict';
// نبراس — زراعة حساب المدير الأول (لا يوجد في قاعدة بيانات جديدة)
// كلمة مرور عشوائية تُعرض مرة واحدة في سطر الأوامر، وتُجبر على التغيير عند أول دخول.
// لا توجد أي كلمة مرور افتراضية معروفة في كود المتصفح أو الخادم.
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const db = require('./db');

const BCRYPT_ROUNDS = 10;

function genTempPassword(len) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789@#$%^&*';
  const b = crypto.randomBytes(64);
  let p = '';
  for (let i = 0; i < (len || 12); i++) p += chars[b[i] % chars.length];
  return p;
}

// يضمن وجود حساب مدير واحد على الأقل. يعيد كلمة المرور المؤقتة عند الإنشاء فقط.
async function ensureAdminAccount() {
  const existing = await db.userByEmail('admin@nibrasboys.local');
  if (existing) return null; // لا نلمس أي حساب موجود أبدًا
  const n = await db.countAdmins();
  if (n > 0) return null;
  const temp = genTempPassword(12);
  const hash = await bcrypt.hash(temp, BCRYPT_ROUNDS);
  await db.insertUser({
    id: 'id_admin_seed',
    school: 'BOYS',
    name: 'مدير النظام',
    email: 'admin@nibrasboys.local',
    username: 'admin',
    password_hash: hash,
    role: 'ADMIN',
    active: true,
    first_login: true,
    data: {},
  });
  return temp;
}

module.exports = { ensureAdminAccount };
