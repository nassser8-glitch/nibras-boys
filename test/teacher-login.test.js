'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const db = require('../db');

test('finalizeLogin clears first_login and the mirrored firstLogin flag atomically', async () => {
  const originalQuery = db.pool.query;
  let sql = '';
  let params;
  db.pool.query = async (query, values) => {
    sql = query;
    params = values;
    return { rows: [{ created_at: 'created', expires_at: 'expires' }] };
  };
  try {
    const row = await db.finalizeLogin(
      'teacher-1', 'BOYS', 'token-hash', 3600000, '127.0.0.1', 'test-agent',
      { lastLogin: '2026-09-22T00:00:00.000Z', loginCount: 1, loginHistory: ['2026-09-22T00:00:00.000Z'] },
      1, '2026-09-22T00:00:00.000Z', ['2026-09-22T00:00:00.000Z'],
    );
    assert.deepEqual(row, { created_at: 'created', expires_at: 'expires' });
    assert.match(sql, /SET data = \$4::jsonb, first_login = false/);
    assert.match(sql, /'firstLogin', to_jsonb\(false\)/);
    assert.equal(params[0], 'teacher-1');
    assert.equal(params[1], 'BOYS');
  } finally {
    db.pool.query = originalQuery;
  }
});

test('الدخول لا يطرد جلسات المستخدم الأخرى (سقف 12 + حذف المنتهية فقط)', async () => {
  const originalQuery = db.pool.query;
  let sql = '';
  db.pool.query = async (query) => { sql = query; return { rows: [{ created_at: 'created', expires_at: 'expires' }] }; };
  try {
    await db.finalizeLogin(
      'teacher-1', 'BOYS', 'token-hash', 3600000, '127.0.0.1', 'test-agent',
      { loginCount: 1 }, 1, '2026-09-22T00:00:00.000Z', [],
    );
    assert.doesNotMatch(sql, /DELETE FROM sessions WHERE user_id = \$1\s*$/m,
      'لا حذف شامل لكل جلسات المستخدم عند الدخول');
    assert.match(sql, /DELETE FROM sessions\s+WHERE user_id = \$1\s+AND \(expires_at <= now\(\)/,
      'الحذف محصور بالمنتهية');
    assert.match(sql, /ORDER BY created_at DESC OFFSET 12/, 'سقف الجلسات المتزامنة');
    assert.match(sql, /INSERT INTO sessions/, 'الجلسة الجديدة تُنشأ');
  } finally {
    db.pool.query = originalQuery;
  }
});

test('first-login repair selects only teachers with login evidence', async () => {
  const originalQuery = db.pool.query;
  db.pool.query = async () => ({ rows: [{ id: 'teacher-1' }, { id: 'teacher-2' }] });
  try {
    const result = await db.repairTeacherFirstLoginFromEvidence('BOYS', false);
    assert.deepEqual(result, { candidateIds: ['teacher-1', 'teacher-2'], updatedIds: [] });
  } finally {
    db.pool.query = originalQuery;
  }
});
