'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const db = require('../db');

function fixture() {
  return {
    users: [],
    schoolData: {
      users: [],
      grades: [{ id: 'g1', name: 'الأول' }],
      classes: [{ id: 'c1', gradeId: 'g1', name: 'أ' }],
      students: [],
      notes: [{ id: 'note-1', studentId: 'old' }],
      points: [{ id: 'point-1', studentId: 'old' }],
    },
  };
}

function installPool(state) {
  const client = {
    async query(sql, params) {
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] };
      if (sql.startsWith('SELECT 1 FROM users WHERE id')) {
        return { rows: state.users.some(user => user.id === params[0]) ? [{}] : [] };
      }
      if (sql.startsWith('SELECT 1 FROM users WHERE lower(username)')) {
        const wanted = String(params[0]).toLowerCase();
        return { rows: state.users.some(user => String(user.username).toLowerCase() === wanted) ? [{}] : [] };
      }
      if (sql.startsWith('INSERT INTO school_data')) return { rows: [] };
      if (sql.startsWith('SELECT data FROM school_data')) return { rows: [{ data: state.schoolData }] };
      if (sql.startsWith('INSERT INTO users')) {
        state.users.push({
          id: params[0], school: params[1], name: params[2], email: params[3], username: params[4],
        });
        return { rows: [] };
      }
      if (sql.startsWith('UPDATE school_data')) {
        state.schoolData = JSON.parse(params[1]);
        return { rows: [] };
      }
      throw new Error('unexpected query: ' + sql);
    },
    release() {},
  };
  db.pool.connect = async () => client;
}

function input(overrides) {
  return Object.assign({
    id: 'student-1',
    school: 'BOYS',
    name: 'طالب جديدة',
    username: 'StudentExact',
    email: 'StudentExact@nibras.school',
    password: 'Password1',
    passwordHash: 'hash',
    student: { fullName: 'طالب جديدة', studentNo: '100', classId: 'c1', active: true },
  }, overrides);
}

test('creates account and student with the same id and preserves notes/points', async () => {
  const state = fixture();
  installPool(state);
  const result = await db.createStudentAccountAndRecord(input());
  assert.equal(result.id, 'student-1');
  assert.equal(state.users[0].id, result.student.id);
  assert.equal(state.schoolData.students[0].id, result.student.id);
  assert.equal(result.username, 'StudentExact');
  assert.deepEqual(state.schoolData.notes, [{ id: 'note-1', studentId: 'old' }]);
  assert.deepEqual(state.schoolData.points, [{ id: 'point-1', studentId: 'old' }]);
});

test('returns username_exists without a partial account or student', async () => {
  const state = fixture();
  state.users.push({ id: 'existing', username: 'StudentExact' });
  installPool(state);
  await assert.rejects(db.createStudentAccountAndRecord(input()), { code: 'username_exists' });
  assert.equal(state.users.length, 1);
  assert.equal(state.schoolData.students.length, 0);
});

test('prevents duplicate student ids before writing', async () => {
  const state = fixture();
  state.schoolData.students.push({ id: 'student-1', fullName: 'قديمة' });
  installPool(state);
  await assert.rejects(db.createStudentAccountAndRecord(input()), { code: 'duplicate_student' });
  assert.equal(state.users.length, 0);
  assert.equal(state.schoolData.students.length, 1);
});

test('rejects duplicate studentNo for an active student without changing existing data', async () => {
  const state = fixture();
  const originalStudent = { id: 'original-student', fullName: 'طالب أصلية', studentNo: '100', active: true };
  state.schoolData.students.push(originalStudent);
  const originalNotes = JSON.parse(JSON.stringify(state.schoolData.notes));
  const originalPoints = JSON.parse(JSON.stringify(state.schoolData.points));
  installPool(state);
  await assert.rejects(
    db.createStudentAccountAndRecord(input({ student: { fullName: 'طالب ثانية', studentNo: '100', active: true } })),
    { code: 'student_number_exists' },
  );
  assert.equal(state.users.length, 0);
  assert.deepEqual(state.schoolData.students, [originalStudent]);
  assert.deepEqual(state.schoolData.notes, originalNotes);
  assert.deepEqual(state.schoolData.points, originalPoints);
});

test('rejects an existing account id', async () => {
  const state = fixture();
  state.users.push({ id: 'student-1', username: 'other' });
  installPool(state);
  await assert.rejects(db.createStudentAccountAndRecord(input()), { code: 'duplicate_student' });
  assert.equal(state.schoolData.students.length, 0);
});

test('keeps exact username and returns grade/class from the student class', async () => {
  const state = fixture();
  installPool(state);
  const result = await db.createStudentAccountAndRecord(input({ username: 'MiXeD_Name' }));
  assert.equal(result.username, 'MiXeD_Name');
  assert.equal(result.grade, 'الأول');
  assert.equal(result.class, 'أ');
  assert.equal(state.users[0].username, 'MiXeD_Name');
});
