/**
 * Smoke test for the roll/promotion persistence rules.
 *
 * Bundled by `scripts/smoke/run.mjs` (firebase/* → the in-memory stubs), so the
 * writers can be exercised without a network. Asserts:
 *  - `এক শ্রেণি নিচে যাবে` always lands at the very end of the target class + শাখা;
 *  - a class receiving pupils promoted from a lower class never holds two pupils with
 *    the same roll (promoted get ১..n by merit, existing/staying pupils follow);
 *  - a legacy suffix roll (`১-১`) is repaired into a clean single roll;
 *  - an individual class change removes EVERY stale row of that pupil (old class,
 *    old শাখা, archive) and writes exactly one destination row.
 */
import assert from 'node:assert/strict';
import { promoteClassInYear } from '../../src/services/database/centralSchoolStore.js';
import { moveStudentClass } from '../../src/services/database/studentService.js';
import {
  normalizeRoll,
  planPromotionRolls,
  resolveRollAssignment,
} from '../../src/utils/rollAssignment.js';

const YEAR = '2026';
const BASE = 'divisions/d1/districts/d2/upazilas/u3/schools/s4';
const yearPath = `${BASE}/sessions/${YEAR}`;
const location = { divisionId: 'd1', districtId: 'd2', upazilaId: 'u3', schoolId: 's4' };

const store = () => {
  globalThis.__smokeStore = globalThis.__smokeStore ?? {};
  return globalThis.__smokeStore;
};
const at = (path) => String(path).split('/').filter(Boolean)
  .reduce((cursor, key) => (cursor == null ? undefined : cursor[key]), store());
const seed = (path, value) => {
  const keys = String(path).split('/').filter(Boolean);
  let cursor = store();
  keys.slice(0, -1).forEach((key) => {
    cursor[key] = cursor[key] ?? {};
    cursor = cursor[key];
  });
  cursor[keys[keys.length - 1]] = value;
};

/* ------------------------------------------------------------------ *
 * 1. Pure roll helpers
 * ------------------------------------------------------------------ */
{
  // A legacy suffix roll (`১-১`) is NOT an occupied number.
  assert.equal(normalizeRoll('১-১'), 0, 'suffix notation is not a plain roll');
  assert.equal(normalizeRoll('৫'), 5, 'Bangla digits are understood');

  const roster = [
    { id: 'a', classId: 'c4', section: 'ক', roll: 1 },
    { id: 'b', classId: 'c4', section: 'ক', roll: 7 },
    { id: 'c', classId: 'c4', section: 'ক', roll: '2-2' },
    { id: 'd', classId: 'c4', section: 'খ', roll: 3 },
  ];
  // A free roll is kept; an occupied one moves to the end of the list.
  assert.equal(resolveRollAssignment(roster, { classId: 'c4', section: 'ক', roll: 1 }), 8);
  assert.equal(resolveRollAssignment(roster, { classId: 'c4', section: 'ক', roll: 2 }), 2);
  assert.equal(resolveRollAssignment(roster, { classId: 'c4', section: 'খ', roll: 1 }), 1, 'শাখা খ numbers independently');
  // `এক শ্রেণি নিচে যাবে` — always after the highest existing roll.
  assert.equal(
    resolveRollAssignment(roster, { classId: 'c4', section: 'ক', roll: 2, placement: 'end' }),
    8,
    'a demoted pupil always lands at the very end',
  );
  assert.equal(
    resolveRollAssignment(roster, { classId: 'c4', section: 'ক', placement: 'end', ignoreIds: ['b'] }),
    2,
    'the highest-existing roll is computed without the pupil being written',
  );
}

/* ------------------------------------------------------------------ *
 * 2. Batch plan: promoted pupils first, existing/staying pupils after
 * ------------------------------------------------------------------ */
{
  // class-3 pupils are promoted into class-4/ক, which already holds 3 pupils.
  const roster = [
    { id: 'r1', classId: 'c4', section: 'ক', roll: 1 },
    { id: 'r2', classId: 'c4', section: 'ক', roll: 2 },
    { id: 'r3', classId: 'c4', section: 'ক', roll: 3 },
    { id: 's1', classId: 'c4', section: 'ক', roll: 4 },   // retained (`এই শ্রেণিতেই থাকুক`)
    { id: 'p1', classId: 'c3', section: 'ক', roll: 1 },
    { id: 'p2', classId: 'c3', section: 'ক', roll: 2 },
  ];
  const plan = planPromotionRolls({
    entries: [
      { id: 'p1', action: 'promote', targetClassId: 'c4', section: 'ক' },
      { id: 'p2', action: 'promote', targetClassId: 'c4', section: 'ক' },
      { id: 's1', action: 'retain', targetClassId: 'c4', section: 'ক' },
    ],
    roster,
    movingIds: ['p1', 'p2', 's1'],
  });
  // Promoted pupils take clean single rolls in merit order…
  assert.equal(plan.get('p1'), 1, 'first promoted pupil gets roll ১');
  assert.equal(plan.get('p2'), 2, 'second promoted pupil gets roll ২');
  // …and the already-present / staying pupils are placed AFTER them.
  assert.equal(plan.get('s1'), 3, 'the staying pupil follows the promoted ones');
  assert.equal(plan.get('r1'), 4);
  assert.equal(plan.get('r2'), 5);
  assert.equal(plan.get('r3'), 6);
  const rolls = ['p1', 'p2', 's1', 'r1', 'r2', 'r3'].map((id) => plan.get(id));
  assert.equal(new Set(rolls).size, rolls.length, 'no two pupils share a roll');

  // Everyone stays (`এই শ্রেণিতেই থাকুক`) → a free roll is kept, nothing shuffles.
  const stayPlan = planPromotionRolls({
    entries: [
      { id: 'r1', action: 'retain', targetClassId: 'c4', section: 'ক' },
      { id: 'r3', action: 'retain', targetClassId: 'c4', section: 'ক' },
    ],
    roster,
    movingIds: ['r1', 'r3'],
  });
  assert.equal(stayPlan.get('r1'), 1, 'a retaining pupil keeps a free roll');
  assert.equal(stayPlan.get('r3'), 3, 'a retaining pupil keeps a free roll');
  assert.equal(stayPlan.get('r2'), 2, 'an untouched resident keeps its roll');
}

/* ------------------------------------------------------------------ *
 * 2b. New admission: an occupied roll is pushed to the end of the bucket
 * ------------------------------------------------------------------ */
{
  const roster = [
    { id: 'a', classId: 'c2', section: 'ক', roll: 1 },
    { id: 'b', classId: 'c2', section: 'ক', roll: 2 },
    { id: 'c', classId: 'c2', section: 'খ', roll: 1 },
  ];
  // Typing roll ১ into c2/ক (taken) ➔ next free number, never a duplicate.
  assert.equal(resolveRollAssignment(roster, { classId: 'c2', section: 'ক', roll: 1 }), 3);
  // Typing roll ৫ (free) ➔ kept exactly as entered.
  assert.equal(resolveRollAssignment(roster, { classId: 'c2', section: 'ক', roll: 5 }), 5);
  // The same number in another শাখা is always allowed.
  assert.equal(resolveRollAssignment(roster, { classId: 'c2', section: 'খ', roll: 2 }), 2);
  // An empty bucket starts at ১.
  assert.equal(resolveRollAssignment(roster, { classId: 'c3', section: 'ক', roll: 4 }), 4);
}

/* ------------------------------------------------------------------ *
 * 3. Store: class-3 ➔ class-4 with class-4 pupils already there
 * ------------------------------------------------------------------ */
{
  globalThis.__smokeStore = {};
  seed(`${BASE}/profile`, { id: 's4', name: 'টেস্ট বিদ্যালয়', divisionId: 'd1', districtId: 'd2', upazilaId: 'u3' });
  seed(`${BASE}/studentMaster`, {
    'STU-2026-0001': { studentMasterId: 'STU-2026-0001', legacyId: 'p1', name: 'পি১' },
    'STU-2026-0002': { studentMasterId: 'STU-2026-0002', legacyId: 'p2', name: 'পি২' },
    'STU-2026-0011': { studentMasterId: 'STU-2026-0011', legacyId: 'r1', name: 'আর১' },
    'STU-2026-0012': { studentMasterId: 'STU-2026-0012', legacyId: 'r2', name: 'আর২' },
  });
  seed(`${yearPath}/students/class-3/ক`, {
    'STU-2026-0001': { studentMasterId: 'STU-2026-0001', legacyId: 'p1', classId: 'class-3', section: 'ক', roll: 1, status: 'active', year: YEAR },
    'STU-2026-0002': { studentMasterId: 'STU-2026-0002', legacyId: 'p2', classId: 'class-3', section: 'ক', roll: 2, status: 'active', year: YEAR },
  });
  seed(`${yearPath}/students/class-4/ক`, {
    'STU-2026-0011': { studentMasterId: 'STU-2026-0011', legacyId: 'r1', classId: 'class-4', section: 'ক', roll: 1, status: 'active', year: YEAR },
    'STU-2026-0012': { studentMasterId: 'STU-2026-0012', legacyId: 'r2', classId: 'class-4', section: 'ক', roll: '2-2', status: 'active', year: YEAR },
  });
  // পি১ merit ১st, পি২ merit ২nd in class 3.
  seed(`${yearPath}/results/class-3/final`, {
    'STU-2026-0001': { meritPosition: 1, gpa: 5, grade: 'A+' },
    'STU-2026-0002': { meritPosition: 2, gpa: 4.5, grade: 'A' },
  });
  seed(`${yearPath}/meta`, { year: YEAR });
  seed(`${yearPath}/passedArchive`, {});

  const result = await promoteClassInYear(location, YEAR, {
    fromClassId: 'c3',
    students: [
      { id: 'p1', studentMasterId: 'STU-2026-0001', name: 'পি১', classId: 'c3', section: 'ক', roll: 1 },
      { id: 'p2', studentMasterId: 'STU-2026-0002', name: 'পি২', classId: 'c3', section: 'ক', roll: 2 },
    ],
    decisions: [
      { studentId: 'p1', studentMasterId: 'STU-2026-0001', action: 'promote', section: 'ক' },
      { studentId: 'p2', studentMasterId: 'STU-2026-0002', action: 'promote', section: 'ক' },
    ],
    targetSections: ['ক'],
  });
  assert.equal(result.synced, true);

  const class4 = at(`${yearPath}/students/class-4/ক`);
  const numbers = Object.values(class4).map((row) => Number(row.roll));
  assert.equal(new Set(numbers).size, numbers.length, 'no duplicate roll in class-4/ক');
  assert.equal(class4['STU-2026-0001'].roll, 1, 'merit ১st → roll ১');
  assert.equal(class4['STU-2026-0002'].roll, 2, 'merit ২nd → roll ২');
  // The pupils already in class 4 were moved after the newcomers; the suffixed roll
  // `2-2` became a clean single number.
  assert.equal(class4['STU-2026-0011'].roll, 3, 'existing pupil follows the promoted ones');
  assert.equal(class4['STU-2026-0012'].roll, 4, 'a ২-২ suffix becomes a clean roll');
  assert.ok(!at(`${yearPath}/students/class-3/ক/STU-2026-0001`), 'the source row is removed');
  // The store reports the authoritative rolls for the hook to mirror.
  assert.equal(result.assignment['STU-2026-0012'], 4, 'the store reports the renumbered resident');
}


/* ------------------------------------------------------------------ *
 * 4. Individual class change removes every stale row
 * ------------------------------------------------------------------ */
{
  globalThis.__smokeStore = {};
  seed(`${BASE}/profile`, { id: 's4', name: 'টেস্ট বিদ্যালয়', divisionId: 'd1', districtId: 'd2', upazilaId: 'u3' });
  seed(`${BASE}/studentMaster`, {
    'STU-2026-0021': { studentMasterId: 'STU-2026-0021', legacyId: 'm1', name: 'মুভার' },
  });
  // The same pupil sits in TWO folders (a half-applied earlier move) and in the archive.
  seed(`${yearPath}/students/class-3/ক`, {
    'STU-2026-0021': { studentMasterId: 'STU-2026-0021', legacyId: 'm1', classId: 'class-3', section: 'ক', roll: 5, status: 'active', year: YEAR, updatedAt: '2026-01-01T00:00:00.000Z' },
  });
  seed(`${yearPath}/students/class-4/খ`, {
    'STU-2026-0021': { studentMasterId: 'STU-2026-0021', legacyId: 'm1', classId: 'class-4', section: 'খ', roll: 9, status: 'active', year: YEAR, updatedAt: '2026-02-01T00:00:00.000Z' },
  });
  seed(`${yearPath}/passedArchive/STU-2026-0021`, { studentMasterId: 'STU-2026-0021', status: 'passed' });

  await moveStudentClass(location, {
    year: YEAR,
    studentMasterId: 'STU-2026-0021',
    legacyId: 'm1',
    prevClassId: 'c3',
    prevSectionId: 'ক',
    nextClassId: 'c2',
    nextSectionId: 'গ',
    roll: 1,
    personal: { name: 'মুভার' },
  });

  assert.ok(at(`${yearPath}/students/class-2/গ/STU-2026-0021`), 'the destination row exists');
  assert.equal(at(`${yearPath}/students/class-2/গ/STU-2026-0021`).section, 'গ');
  assert.equal(at(`${yearPath}/students/class-3/ক/STU-2026-0021`), undefined, 'the named source row is removed');
  assert.equal(at(`${yearPath}/students/class-4/খ/STU-2026-0021`), undefined, 'a stale second row is removed too');
  assert.equal(at(`${yearPath}/passedArchive/STU-2026-0021`), undefined, 'the archive copy is removed');
  // The permanent identity follows the move.
  assert.equal(at(`${BASE}/studentMaster/STU-2026-0021`).name, 'মুভার');
  assert.equal(at(`${BASE}/studentMaster/STU-2026-0021`).currentClassId, 'class-2');
}

console.log('PASS — roll assignment never duplicates + class change clears every stale row');

/* ------------------------------------------------------------------ *
 * 5. A reload never resurrects the old class (listener merge)
 * ------------------------------------------------------------------ */
{
  const { buildYearRoster } = await import('../../src/services/database/studentService.js');
  const masters = {
    'STU-2026-0031': { studentMasterId: 'STU-2026-0031', legacyId: 'q1', name: 'কью১' },
    'STU-2026-0032': { studentMasterId: 'STU-2026-0032', legacyId: 'q2', name: 'কью২' },
    'STU-2026-0033': { studentMasterId: 'STU-2026-0033', legacyId: 'q3', name: 'কью৩' },
  };
  // The live (current) layout: the pupil sits in class-2/গ.
  const current = {
    'class-2': {
      গ: {
        'STU-2026-0031': {
          studentMasterId: 'STU-2026-0031', legacyId: 'q1', classId: 'class-2',
          section: 'গ', roll: 1, status: 'active', year: YEAR, updatedAt: '2026-05-01T00:00:00.000Z',
        },
      },
    },
  };
  // Two stale copies of the SAME pupil, in an older legacy flat roster...
  const legacy = {
    'STU-2026-0031': {
      studentMasterId: 'STU-2026-0031', legacyId: 'q1', classId: 'class-1',
      section: 'ক', roll: 4, status: 'active', year: YEAR,
    },
  };
  // ...and in a stale class bucket that also carries a real second pupil.
  const staleBucket = {
    'class-1': {
      ক: {
        'STU-2026-0031': {
          studentMasterId: 'STU-2026-0031', legacyId: 'q1', classId: 'class-1',
          section: 'ক', roll: 2, status: 'active', year: YEAR, updatedAt: '2026-01-01T00:00:00.000Z',
        },
        'STU-2026-0032': {
          studentMasterId: 'STU-2026-0032', legacyId: 'q2', classId: 'class-1',
          section: 'ক', roll: 1, status: 'active', year: YEAR, updatedAt: '2026-01-01T00:00:00.000Z',
        },
        'STU-2026-0033': {
          studentMasterId: 'STU-2026-0033', legacyId: 'q3', classId: 'class-1',
          section: 'ক', roll: '১-১', status: 'active', year: YEAR, updatedAt: '2026-01-01T00:00:00.000Z',
        },
      },
    },
  };

  // Exactly how `subscribeStudents` merges them: legacy layouts first, live last.
  const { mergeEnrollmentMaps } = await import('../../src/services/database/studentService.js');
  const roster = buildYearRoster({
    masters,
    enrollments: mergeEnrollmentMaps(legacy, staleBucket, current),
  });
  const mover = roster.students.filter((student) => student.id === 'q1');
  assert.equal(mover.length, 1, 'a pupil is listed exactly once after a reload');
  assert.equal(mover[0].classId, 'c2', 'the live class wins over the stale copies');
  assert.equal(mover[0].section, 'গ', 'the live শাখা wins over the stale copies');
  // The other pupils of the stale bucket are untouched.
  assert.equal(roster.students.filter((student) => student.id === 'q2').length, 1);
  assert.equal(roster.students.filter((student) => student.id === 'q3').length, 1);
}

console.log('PASS — a reload keeps the new class/শাখা and never resurrects the old row');
