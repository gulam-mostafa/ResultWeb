/**
 * Smoke test for the section-aware annual promotion writer.
 *
 * Bundled by `scripts/smoke/run.mjs`, which aliases `firebase/*` to the in-memory
 * stubs in this folder. Asserts the persisted shape in
 * `sessions/{year}/students/{classId}/{sectionId}/{id}` and the merit ordering.
 */
import assert from 'node:assert/strict';
import { promoteClassInYear } from '../../src/services/database/centralSchoolStore.js';
import { distributeByCount, parseMeritCount, parseMeritRange } from '../../src/components/students/AutoPromotionModal.jsx';

const YEAR = '2026';
const BASE = 'divisions/d1/districts/d2/upazilas/u3/schools/s4';
const yearPath = `${BASE}/sessions/${YEAR}`;
const store = () => {
  globalThis.__smokeStore = globalThis.__smokeStore ?? {};
  return globalThis.__smokeStore;
};
const at = (path) => String(path).split('/').filter(Boolean)
  .reduce((cursor, key) => (cursor == null ? undefined : cursor[key]), store());

const location = { divisionId: 'd1', districtId: 'd2', upazilaId: 'u3', schoolId: 's4' };

// Class-3 roster spread over three শাখা: কম roll ≠ ভালো মেধা on purpose.
const roster = [
  { id: 'a1', studentMasterId: 'STU-2026-0001', name: 'রুমি', classId: 'c3', section: 'ক', roll: 1 },
  { id: 'a2', studentMasterId: 'STU-2026-0002', name: 'সজীব', classId: 'c3', section: 'খ', roll: 2 },
  { id: 'a3', studentMasterId: 'STU-2026-0003', name: 'তানিয়া', classId: 'c3', section: 'গ', roll: 3 },
  { id: 'a4', studentMasterId: 'STU-2026-0004', name: 'নাফিস', classId: 'c3', section: 'ক', roll: 4 },
  { id: 'a5', studentMasterId: 'STU-2026-0005', name: 'মেহেদী', classId: 'c3', section: 'খ', roll: 5 },
];

// Published merit: তানিয়া ১st, মেহেদী ২nd, রুমি ৩rd, সজীব ৪th, নাফিস ৫th (ফেল).
const merit = { a1: 3, a2: 4, a3: 1, a4: 5, a5: 2 };

const enrollment = (student) => ({
  studentMasterId: student.studentMasterId,
  legacyId: student.id,
  classId: 'class-3',
  section: student.section,
  roll: student.roll,
  status: 'active',
  year: YEAR,
});

/** Writes a nested value so the stub tree looks like a real RTDB snapshot. */
const seed = (path, value) => {
  const keys = String(path).split('/').filter(Boolean);
  let cursor = globalThis.__smokeStore;
  keys.slice(0, -1).forEach((key) => {
    cursor[key] = cursor[key] ?? {};
    cursor = cursor[key];
  });
  cursor[keys[keys.length - 1]] = value;
};

globalThis.__smokeStore = {};
seed(`${BASE}/studentMaster`, Object.fromEntries(roster.map((student) => [student.studentMasterId, {
  studentMasterId: student.studentMasterId,
  legacyId: student.id,
  name: student.name,
  fatherName: `পিতা ${student.name}`,
  fatherPhone: '01700000000',
  motherName: `মাতা ${student.name}`,
  motherPhone: '01800000000',
}])));
['ক', 'খ', 'গ'].forEach((section) => {
  seed(`${yearPath}/students/class-3/${section}`, Object.fromEntries(
    roster.filter((student) => student.section === section)
      .map((student) => [student.studentMasterId, enrollment(student)]),
  ));
});
seed(`${yearPath}/results/class-3/final`, Object.fromEntries(roster.map((student) => [student.studentMasterId, {
  meritPosition: merit[student.id],
  gpa: 5 - merit[student.id] * 0.4,
  grade: 'A',
  grandTotal: 400 - merit[student.id] * 10,
}])));
seed(`${yearPath}/meta`, { year: YEAR });
seed(`${yearPath}/passedArchive`, {});
seed(`${BASE}/profile`, {
  id: 's4',
  name: 'টেস্ট বিদ্যালয়',
  divisionId: 'd1',
  districtId: 'd2',
  upazilaId: 'u3',
});


// `ক` gets the top 2 by merit; everyone else goes to `খ`; নাফিস stays in class 3.
const decisions = [
  { studentId: 'a3', studentMasterId: 'STU-2026-0003', action: 'promote', section: 'ক' },
  { studentId: 'a5', studentMasterId: 'STU-2026-0005', action: 'promote', section: 'ক' },
  { studentId: 'a1', studentMasterId: 'STU-2026-0001', action: 'promote', section: 'খ' },
  { studentId: 'a2', studentMasterId: 'STU-2026-0002', action: 'promote', section: 'খ' },
  { studentId: 'a4', studentMasterId: 'STU-2026-0004', action: 'retain', section: 'ক' },
];

const result = await promoteClassInYear(location, YEAR, {
  fromClassId: 'c3',
  students: roster,
  decisions,
  targetSections: ['ক', 'খ', 'গ'],
});

assert.equal(result.synced, true, 'promotion should sync');
assert.equal(result.promotedCount, 4);
assert.equal(result.retainedCount, 1);
assert.equal(result.archivedCount, 0);

const class4 = at(`${yearPath}/students/class-4`);
assert.ok(class4, 'class-4 node must exist');
// `class-3/ক` survives only because the retained pupil stayed there.
assert.deepEqual(Object.keys(at(`${yearPath}/students/class-3/ক`) ?? {}), ['STU-2026-0004']);
// Emptied শাখা folders hold no pupil any more (RTDB prunes the empty node itself).
assert.deepEqual(Object.keys(at(`${yearPath}/students/class-3/খ`) ?? {}), []);
assert.deepEqual(Object.keys(at(`${yearPath}/students/class-3/গ`) ?? {}), []);

// Roll ১ inside `ক` is the better-merit pupil (তানিয়া), not the old roll 1 (রুমি).
assert.equal(class4['ক']['STU-2026-0003'].roll, 1, 'merit ১st must get roll ১ in ক');
assert.equal(class4['ক']['STU-2026-0005'].roll, 2, 'merit ২nd must get roll ২ in ক');
assert.equal(class4['খ']['STU-2026-0001'].roll, 1, 'roll ১ in খ');
assert.equal(class4['খ']['STU-2026-0002'].roll, 2, 'roll ২ in খ');

// The retained pupil stays in class 3 under `ক`.
const retained = at(`${yearPath}/students/class-3/ক/STU-2026-0004`);
assert.ok(retained, 'retained pupil must stay in class-3/ক');
assert.equal(retained.classId, 'class-3');

// Section registry keeps the declared শাখা alive.
const registry = at(`${yearPath}/meta/sections`);
assert.ok(registry['class-4']['ক'] && registry['class-4']['খ'], 'class-4 শাখা must be registered');
assert.ok(at(`${yearPath}/meta`).lastPromotionAt, 'year meta must log the promotion');

// studentMaster keeps the identity and records the new class.
const master = at(`${BASE}/studentMaster/STU-2026-0003`);
assert.equal(master.name, 'তানিয়া', 'identity name must survive');
assert.equal(master.currentClassId, 'class-4');
assert.equal(master.fatherPhone, '01700000000');

// ---- Class-5 leavers go to the year-wise archive -----------------------------
globalThis.__smokeStore[`${BASE}/sessions/${YEAR}/students/class-5`] = {
  ক: {
    'STU-2026-0009': { studentMasterId: 'STU-2026-0009', legacyId: 'z9', classId: 'class-5', section: 'ক', roll: 1, status: 'active', year: YEAR },
  },
};
const graduate = await promoteClassInYear(location, YEAR, {
  fromClassId: 'c5',
  students: [{ id: 'z9', studentMasterId: 'STU-2026-0009', name: 'গ্র্যাজুয়েট', classId: 'c5', section: 'ক', roll: 1 }],
  decisions: [{ studentId: 'z9', studentMasterId: 'STU-2026-0009', action: 'promote', section: 'ক' }],
});
assert.equal(graduate.archivedCount, 1);
assert.ok(at(`${yearPath}/passedArchive/STU-2026-0009`), 'flat archive row must exist');
assert.ok(at(`${yearPath}/passedArchive/years/${YEAR}/STU-2026-0009`), 'year-wise archive row must exist');
assert.equal(at(`${yearPath}/passedArchive/years/${YEAR}/STU-2026-0009`).passedYear, YEAR);
assert.ok(!at(`${yearPath}/students/class-5/ক/STU-2026-0009`), 'leaver must leave the roster');

// ---- Count-based ক/খ split (the modal's pure helper) -------------------------
const meritIds = ['m1', 'm2', 'm3', 'm4', 'm5', 'm6'];

// "ক-তে ২ জন যাবে" → top 2 in ক, the remaining 4 in খ.
const topSplit = distributeByCount(meritIds, { count: 2, mode: 'top', targetSection: 'ক', sections: ['ক', 'খ'] });
assert.equal(topSplit.get('m1'), 'ক');
assert.equal(topSplit.get('m2'), 'ক');
assert.equal(topSplit.get('m3'), 'খ');
assert.equal(topSplit.get('m6'), 'খ');

// "ক-তে ৪ জন থাকবে" → the first count is skipped, the rest go to খ.
const restSplit = distributeByCount(meritIds, { count: 4, mode: 'rest', sections: ['ক', 'খ'] });
assert.equal(restSplit.get('m1'), 'ক');
assert.equal(restSplit.get('m4'), 'ক');
assert.equal(restSplit.get('m5'), 'খ');
assert.equal(restSplit.get('m6'), 'খ');

// No count ➔ everyone follows the chosen (custom) শাখা.
const noCount = distributeByCount(meritIds, { count: '', targetSection: 'গ' });
assert.equal(noCount.get('m1'), 'গ');
assert.equal(noCount.get('m6'), 'গ');

// `rest` mode honours the custom second bucket instead of the default `খ`.
const customRest = distributeByCount(meritIds, { count: 2, mode: 'rest', restSection: 'গ' });
assert.equal(customRest.get('m1'), 'ক');
assert.equal(customRest.get('m2'), 'ক');
assert.equal(customRest.get('m3'), 'গ');
assert.equal(customRest.get('m6'), 'গ');
// A blank / `ক` rest label keeps the previous `খ` behaviour.
const defaultRest = distributeByCount(meritIds, { count: 2, mode: 'rest', restSection: 'ক' });
assert.equal(defaultRest.get('m3'), 'খ');

// Merit range "১-৩০" (Bangla digits) ➔ pupils inside the range follow the শাখা.
const banglaRange = distributeByCount(meritIds, { count: '১-৪', targetSection: 'ক', sections: ['ক', 'খ'] });
assert.equal(banglaRange.get('m1'), 'ক');
assert.equal(banglaRange.get('m4'), 'ক');
assert.equal(banglaRange.get('m5'), 'খ');
assert.equal(banglaRange.get('m6'), 'খ');

// A mid-list range "20-30" style ➔ only that window moves, both sides stay elsewhere.
const windowRange = distributeByCount(meritIds, { count: '2-3', targetSection: 'খ', sections: ['ক', 'খ'] });
assert.equal(windowRange.get('m1'), 'ক');
assert.equal(windowRange.get('m2'), 'খ');
assert.equal(windowRange.get('m3'), 'খ');
assert.equal(windowRange.get('m4'), 'ক');
assert.equal(windowRange.get('m6'), 'ক');

// ASCII range and a reversed range normalise to the same window.
assert.deepEqual(parseMeritRange('1-30'), { start: 1, end: 30 });
assert.deepEqual(parseMeritRange('৩০ - ২০'), { start: 20, end: 30 });
assert.deepEqual(parseMeritRange('20–30'), { start: 20, end: 30 });
assert.deepEqual(parseMeritRange('১ থেকে ৩০'), { start: 1, end: 30 });
assert.equal(parseMeritRange('৩০'), null);
assert.equal(parseMeritCount('৩০'), 30);
assert.equal(parseMeritCount(''), null);

// A range always targets the selected (possibly custom) শাখা; the rest go elsewhere.
const customRange = distributeByCount(meritIds, { count: '১-৩', targetSection: 'গ', sections: ['ক', 'খ'] });
assert.equal(customRange.get('m1'), 'গ');
assert.equal(customRange.get('m3'), 'গ');
assert.equal(customRange.get('m4'), 'ক', 'outside the range ➔ the first declared শাখা');
assert.equal(customRange.get('m6'), 'ক');

console.log('PASS — section-aware annual promotion + count split smoke test');

