'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const db = require('../db');

const rows = [
  { teacher_id: 'teacher-1', name: 'أمل الشامي', day_of_week: 1, checked_in_at: null },
  { teacher_id: 'teacher-2', name: 'نورة أحمد', day_of_week: 1, checked_in_at: '2026-09-22T05:10:00.000Z' },
];

test('ADMIN can see all of today\'s supervisors', () => {
  assert.equal(db.canViewSupervisionToday('ADMIN'), true);
  const visible = db.filterSupervisionAssignments('ADMIN', rows, 'teacher-1');
  assert.deepEqual(visible, rows);
});

test('SCHOOL_AGENT (الوكيل) can see all of today\'s supervisors and record them', () => {
  assert.equal(db.canViewSupervisionToday('SCHOOL_AGENT'), true);
  const visible = db.filterSupervisionAssignments('SCHOOL_AGENT', rows, 'teacher-1');
  assert.deepEqual(visible, rows);
});

test('AGENT (الوكيل) can see all of today\'s supervisors and record them', () => {
  assert.equal(db.canViewSupervisionToday('AGENT'), true);
  const visible = db.filterSupervisionAssignments('AGENT', rows, 'teacher-1');
  assert.deepEqual(visible, rows);
});

test('TEACHER cannot see other teachers\' supervision assignments', () => {
  const visible = db.filterSupervisionAssignments('TEACHER', rows, 'teacher-1');
  assert.equal(visible.some(row => row.teacher_id === 'teacher-2'), false);
});

test('TEACHER can see her own assignment', () => {
  assert.equal(db.canViewSupervisionToday('TEACHER'), true);
  const visible = db.filterSupervisionAssignments('TEACHER', rows, 'teacher-1');
  assert.deepEqual(visible, [rows[0]]);
});

test('an unauthorized role is rejected before any row is returned', () => {
  for (const role of ['STUDENT', 'COUNSELOR', 'ADMINISTRATIVE']) {
    assert.equal(db.canViewSupervisionToday(role), false);
  }
  // حتى لو استُدعيت دالة الفلترة خطأً لدور غير مصرح له، لا تُعيد أي صف
  assert.deepEqual(db.filterSupervisionAssignments('STUDENT', rows, 'teacher-1'), []);
});
