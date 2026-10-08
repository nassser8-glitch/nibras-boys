'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const db = require('../db');

test('findDiagnosticUsers selects only diagnostic fields and normalizes usernames', async () => {
  const originalQuery = db.pool.query;
  let queryText = '';
  let queryParams;
  db.pool.query = async (sql, params) => {
    queryText = sql;
    queryParams = params;
    return {
      rows: [{
        id: 'user-1',
        username: 'noura2',
        school: 'BOYS',
        role: 'STUDENT',
        active: true,
        name: 'نورة',
        school_data_user_exists: true,
        school_data_student_exists: false,
      }],
    };
  };

  try {
    const rows = await db.findDiagnosticUsers([' Noura2 ', 'nwrh', 'noura2']);
    assert.deepEqual(rows[0], {
      id: 'user-1',
      username: 'noura2',
      school: 'BOYS',
      role: 'STUDENT',
      active: true,
      name: 'نورة',
      school_data_user_exists: true,
      school_data_student_exists: false,
    });
    assert.deepEqual(queryParams, [['noura2', 'nwrh']]);
    assert.match(queryText, /SELECT u\.id, u\.username, u\.school, u\.role, u\.active, u\.name/);
    assert.doesNotMatch(queryText, /password/i);
    assert.match(queryText, /school_data_user_exists/);
    assert.match(queryText, /school_data_student_exists/);
  } finally {
    db.pool.query = originalQuery;
  }
});
