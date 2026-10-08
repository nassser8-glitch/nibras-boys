'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const db = require('../db');

test('teacher activation preview separates active state from first-login evidence', async () => {
  const originalQuery = db.pool.query;
  db.pool.query = async () => ({
    rows: [
      { id: 'teacher-1', active: false, first_login: true, has_login_evidence: true },
      { id: 'teacher-2', active: false, first_login: true, has_login_evidence: false },
      { id: 'teacher-3', active: true, first_login: false, has_login_evidence: true },
    ],
  });
  try {
    const result = await db.activateTeachersSafely('BOYS', false);
    assert.deepEqual(result.candidates, [
      { id: 'teacher-1', activate: true, clearFirstLogin: true },
      { id: 'teacher-2', activate: true, clearFirstLogin: false },
      { id: 'teacher-3', activate: false, clearFirstLogin: false },
    ]);
    assert.deepEqual(result.updated, []);
  } finally {
    db.pool.query = originalQuery;
  }
});

test('teacher activation apply updates only selected ids in one transaction', async () => {
  const originalConnect = db.pool.connect;
  const calls = [];
  const client = {
    async query(sql, params) {
      calls.push({ sql, params });
      if (sql === 'BEGIN' || sql === 'COMMIT') return { rows: [] };
      if (sql.includes('SELECT id, active, first_login')) {
        return {
          rows: [
            { id: 'teacher-1', active: false, first_login: true, has_login_evidence: true },
            { id: 'teacher-2', active: false, first_login: true, has_login_evidence: false },
          ],
        };
      }
      return { rows: [], rowCount: sql.startsWith('UPDATE school_data') ? 1 : undefined };
    },
    release() {},
  };
  db.pool.connect = async () => client;
  try {
    const result = await db.activateTeachersSafely('BOYS', true);
    assert.deepEqual(result.updated, [
      { id: 'teacher-1', active: true, firstLogin: false },
      { id: 'teacher-2', active: true },
    ]);
    assert.equal(calls[0].sql, 'BEGIN');
    assert.equal(calls.at(-1).sql, 'COMMIT');
    assert.deepEqual(calls[2].params, [['teacher-1', 'teacher-2']]);
    assert.deepEqual(calls[3].params, [['teacher-1']]);
    assert.deepEqual(calls[4].params, ['BOYS', ['teacher-1', 'teacher-2'], ['teacher-1', 'teacher-2'], ['teacher-1']]);
  } finally {
    db.pool.connect = originalConnect;
  }
});

test('teacher activation rolls back if school_data synchronization fails', async () => {
  const originalConnect = db.pool.connect;
  const calls = [];
  const client = {
    async query(sql) {
      calls.push(sql);
      if (sql === 'BEGIN' || sql === 'COMMIT') return { rows: [] };
      if (sql.includes('SELECT id, active, first_login')) {
        return { rows: [{ id: 'teacher-1', active: false, first_login: true, has_login_evidence: true }] };
      }
      if (sql.startsWith('UPDATE school_data')) return { rows: [], rowCount: 0 };
      return { rows: [], rowCount: 1 };
    },
    release() {},
  };
  db.pool.connect = async () => client;
  try {
    await assert.rejects(db.activateTeachersSafely('BOYS', true), { message: 'school_data_not_found' });
    assert.equal(calls[0], 'BEGIN');
    assert.equal(calls.at(-1), 'ROLLBACK');
    assert.equal(calls.includes('COMMIT'), false);
  } finally {
    db.pool.connect = originalConnect;
  }
});
