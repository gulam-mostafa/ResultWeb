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
import {
  PROMOTION_ORIGIN,
  PROMOTION_SORT,
  daysSincePromotion,
  isNewlyPromoted,
  isWithinPromotionWindow,
  promotionBadgeOf,
  promotionMonthOptions,
  promotionOriginOf,
  sortPromotionRows,
} from '../../src/utils/promotionMeta.js';

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
// The flat archive row plus BOTH year-wise layouts exist.
assert.ok(at(`${yearPath}/passedArchive/STU-2026-0009`), 'flat archive row must exist');
assert.ok(at(`${yearPath}/passedArchive/years/${YEAR}/STU-2026-0009`), 'years/{year} archive row must exist');
assert.ok(at(`${yearPath}/passedArchive/${YEAR}/STU-2026-0009`), 'year-keyed archive row must exist');
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

// ---- Promotion origin metadata (new vs repeating pupil) ----------------------
// A promoted pupil must carry promotedAt / promotedFromClass / promotedFromYear /
// isNewPromotion so the roster can show the month badge and the "নতুন উত্তীর্ণ" tag.
const promoted = class4['ক']['STU-2026-0003'];
assert.ok(promoted.promotedAt, 'promoted row must carry promotedAt');
assert.equal(promoted.promotedFromClass, 'class-3', 'promotedFromClass must be the source class');
assert.equal(promoted.promotedFromYear, YEAR, 'promotedFromYear must be the source year');
assert.equal(promoted.isNewPromotion, true, 'promoted row must be flagged as a new promotion');
assert.equal(promoted.classId, 'class-4', 'target class must be the next class');

// A retained pupil is NOT a new promotion: any earlier origin marker is cleared.
assert.equal(retained.isNewPromotion, false, 'retained pupil must not be flagged as promoted');
assert.ok(!retained.promotedAt, 'retained pupil must not carry a promotion stamp');
assert.ok(!retained.promotedFromClass, 'retained pupil must not carry a source class');

// The Class-5 leaver keeps its origin metadata in the year-wise archive.
const archived = at(`${yearPath}/passedArchive/years/${YEAR}/STU-2026-0009`);
assert.equal(archived.isNewPromotion, true);
assert.equal(archived.promotedFromClass, 'class-5');
assert.ok(archived.promotedAt, 'archived leaver must carry promotedAt');

// ---- Promotion badge window (3 months ≈ 90 days) + origin classification ----
const NOW = new Date('2026-11-21T12:00:00.000Z');
const fresh = { promotedAt: '2026-11-05T10:00:00.000Z', promotedFromClass: 'c1', classId: 'c2', isNewPromotion: true };
const old = { promotedAt: '2026-07-01T10:00:00.000Z', promotedFromClass: 'c1', classId: 'c2', isNewPromotion: true };
const repeating = { classId: 'c2', section: 'ক', roll: 1 };

assert.equal(promotionBadgeOf(fresh, NOW).label, 'নভেম্বর ২০২৬', 'badge shows the Bengali month + year');
assert.equal(promotionBadgeOf(fresh, NOW).monthKey, '2026-11');
assert.ok(daysSincePromotion(fresh.promotedAt, NOW) <= 90, 'fresh stamp is inside the window');
assert.equal(promotionBadgeOf(old, NOW), null, 'badge must be REMOVED (null) after 90 days');
assert.equal(isWithinPromotionWindow('2026-08-22T10:00:00.000Z', NOW), false, '91 days is outside the window');
assert.equal(isWithinPromotionWindow('2026-08-23T10:00:00.000Z', NOW), true, '90 days is inside the window');

assert.equal(promotionOriginOf(fresh, 'c2'), PROMOTION_ORIGIN.PROMOTED, 'came from class 1 ➔ নতুন উত্তীর্ণ');
assert.equal(isNewlyPromoted(fresh, 'c2'), true);
assert.equal(promotionOriginOf(repeating, 'c2'), PROMOTION_ORIGIN.EXISTING, 'no source class ➔ এই শ্রেণিতেই ছিল');
assert.equal(promotionOriginOf({ ...fresh, promotedFromClass: 'c2' }, 'c2'), PROMOTION_ORIGIN.EXISTING, 'retained in the same class ➔ existing');

// Month options only list stamps inside the badge window, newest first.
const monthOptions = promotionMonthOptions([fresh, old, repeating], NOW);
assert.deepEqual(monthOptions.map((option) => option.key), ['2026-11'], 'only windowed months are listed');

// Display sort: newest promotion first / oldest first; unstamped rows keep merit order.
const sortRows = [{ student: repeating }, { student: fresh }, { student: old }];
assert.deepEqual(
  sortPromotionRows(sortRows, PROMOTION_SORT.NEWEST).map((row) => row.student.promotedAt ?? null),
  [fresh.promotedAt, old.promotedAt, null],
);
assert.deepEqual(
  sortPromotionRows(sortRows, PROMOTION_SORT.OLDEST).map((row) => row.student.promotedAt ?? null),
  [old.promotedAt, fresh.promotedAt, null],
);

console.log('PASS — section-aware annual promotion + origin metadata + badge window smoke test');

/* ------------------------------------------------------------------ *
 * Individual class change (`উত্তীর্ণ` / `এক শ্রেণি নিচে যাবে` / শাখা বদল)
 * of ONE pupil — the profile-edit path (`moveStudentClass`).
 * ------------------------------------------------------------------ */
{
  const { moveStudentClass } = await import('../../src/services/database/studentService.js');
  const { classChangeTarget, nextFreeRoll } = await import('../../src/components/students/AddStudentModal.jsx');
  const { CLASS_CHANGE_MODE, NEXT_CLASS_MAP, PREV_CLASS_MAP } = await import('../../src/utils/constants.js');

  // ---- Class-change decision mapping (pure) --------------------------------
  assert.equal(classChangeTarget('c2', CLASS_CHANGE_MODE.STAY, 'c2'), 'c2', 'stay keeps the class');
  assert.equal(classChangeTarget('c2', CLASS_CHANGE_MODE.STAY, 'c4'), 'c4', 'stay honours an edited class');
  assert.equal(classChangeTarget('c2', CLASS_CHANGE_MODE.PROMOTE), NEXT_CLASS_MAP.c2, 'promote = next class');
  assert.equal(classChangeTarget('c5', CLASS_CHANGE_MODE.PROMOTE), 'archive', 'class-5 promote graduates');
  assert.equal(classChangeTarget('c3', CLASS_CHANGE_MODE.DEMOTE), PREV_CLASS_MAP.c3, 'demote = one class down');
  assert.equal(classChangeTarget('pre', CLASS_CHANGE_MODE.DEMOTE), 'pre', 'pre-primary has no lower class');

  // ---- Destination roll never collides -------------------------------------
  const destinationRoster = [
    { id: 'x1', classId: 'c4', section: 'ক', roll: 1 },
    { id: 'x2', classId: 'c4', section: 'ক', roll: 7 },
    { id: 'x3', classId: 'c4', section: 'খ', roll: 3 },
  ];
  assert.equal(nextFreeRoll(destinationRoster, { classId: 'c4', section: 'ক' }), 8, 'roll continues after the ones already there');
  assert.equal(nextFreeRoll(destinationRoster, { classId: 'c4', section: 'খ' }), 4, 'শাখা খ numbers independently');
  assert.equal(nextFreeRoll(destinationRoster, { classId: 'c4', section: 'ক', ignoreId: 'x2' }), 2, 'own row is ignored');

  // ---- Promote one pupil: c4/ক ➔ c5/খ, old folder cleared ------------------
  seed(`${yearPath}/students/class-4/ক/STU-2026-0004`, {
    studentMasterId: 'STU-2026-0004',
    legacyId: 'a4',
    classId: 'class-4',
    section: 'ক',
    roll: 1,
    status: 'active',
    year: YEAR,
  });
  await moveStudentClass(location, {
    year: YEAR,
    studentMasterId: 'STU-2026-0004',
    legacyId: 'a4',
    prevClassId: 'c4',
    prevSectionId: 'ক',
    nextClassId: 'c5',
    nextSectionId: 'খ',
    roll: 12,
    promotion: {
      promotedAt: '2026-11-21T00:00:00.000Z',
      promotedFromClass: 'class-4',
      promotedFromYear: YEAR,
      isNewPromotion: true,
      previousClassId: 'c4',
    },
  });
  const promotedRow = at(`${yearPath}/students/class-5/খ/STU-2026-0004`);
  assert.equal(promotedRow?.section, 'খ', 'the pupil lands in the destination শাখা');
  assert.equal(promotedRow?.classId, 'class-5', 'the stored class is the canonical key');
  assert.equal(promotedRow?.roll, 12, 'the destination roll is stored');
  assert.equal(promotedRow?.promotedFromClass, 'class-4', 'the promotion stamp is written');
  assert.equal(promotedRow?.isNewPromotion, true);
  assert.equal(at(`${yearPath}/students/class-4/ক/STU-2026-0004`), undefined, 'the old row is removed');
  assert.equal(at(`${BASE}/studentMaster/STU-2026-0004`).currentClassId, 'class-5', 'master follows the move');

  // ---- A শাখা-only move keeps the promotion metadata ----------------------
  seed(`${yearPath}/students/class-5/খ/STU-2026-0004`, at(`${yearPath}/students/class-5/খ/STU-2026-0004`));
  await moveStudentClass(location, {
    year: YEAR,
    studentMasterId: 'STU-2026-0004',
    prevClassId: 'c5',
    prevSectionId: 'খ',
    nextClassId: 'c5',
    nextSectionId: 'গ',
    roll: 12,
  });
  const movedRow = at(`${yearPath}/students/class-5/গ/STU-2026-0004`);
  assert.equal(movedRow?.section, 'গ', 'the শাখা-only move lands in the new folder');
  assert.equal(movedRow?.promotedFromClass, 'class-4', 'a section change never drops the promotion stamp');
  assert.equal(at(`${yearPath}/students/class-5/খ/STU-2026-0004`), undefined, 'the old শাখা folder is cleared');

  // ---- Graduating a Class-5 pupil files them in passedArchive -------------
  seed(`${yearPath}/students/class-5/গ/STU-2026-0004`, at(`${yearPath}/students/class-5/গ/STU-2026-0004`));
  await moveStudentClass(location, {
    year: YEAR,
    studentMasterId: 'STU-2026-0004',
    prevClassId: 'c5',
    prevSectionId: 'গ',
    nextClassId: 'archive',
    nextSectionId: 'গ',
    roll: 12,
    promotion: {
      promotedAt: '2026-11-21T00:00:00.000Z',
      promotedFromClass: 'class-5',
      promotedFromYear: YEAR,
      isNewPromotion: true,
    },
  });
  assert.equal(at(`${yearPath}/students/class-5/গ/STU-2026-0004`), undefined, 'the class row is gone after graduation');
  const archivedRow = at(`${yearPath}/passedArchive/STU-2026-0004`);
  assert.equal(archivedRow?.status, 'passed', 'the leaver is filed in passedArchive');
  assert.ok(at(`${yearPath}/passedArchive/years/${YEAR}/STU-2026-0004`), 'the year-wise archive folder is written');
  assert.equal(at(`${BASE}/studentMaster/STU-2026-0004`).overallStatus, 'graduated', 'master marks the graduate');

  console.log('PASS — individual class change writes class row + master + passedArchive exactly once');
}

/* ------------------------------------------------------------------ *
 * P0-3 / P0-7 — year-scoped promotion (`2026` ➔ `2027`): the new year's roster
 * starts EMPTY (no carried GPA/grade/merit) and the finished year is untouched.
 * ------------------------------------------------------------------ */
{
  const { promoteStudentsToNextYear } = await import('../../src/services/database/centralSchoolStore.js');
  const srcYear = '2026';
  const dstYear = '2027';
  const srcPath = `${BASE}/sessions/${srcYear}`;
  const dstPath = `${BASE}/sessions/${dstYear}`;

  seed(`${srcPath}/students/class-2/ক`, {
    'STU-2026-0001': { studentMasterId: 'STU-2026-0001', legacyId: 'a1', name: 'রুমি', classId: 'class-2', section: 'ক', roll: 1, status: 'active', year: srcYear },
  });
  seed(`${srcPath}/results/class-2/final/STU-2026-0001`, { grandTotal: 400, gpa: 4.5, grade: 'A+', meritPosition: 1 });
  // Snapshot the finished year's DATA so we can prove it is not rewritten.
  const finishedBefore = {
    row: at(`${srcPath}/students/class-2/ক/STU-2026-0001`),
    result: at(`${srcPath}/results/class-2/final/STU-2026-0001`),
  };

  const rollover = await promoteStudentsToNextYear(location, srcYear, dstYear, {
    decisions: [{ studentId: 'a1', studentMasterId: 'STU-2026-0001', action: 'promote' }],
    students: [{ id: 'a1', studentMasterId: 'STU-2026-0001', name: 'রুমি', classId: 'c2', section: 'ক', roll: 1 }],
  });
  assert.equal(rollover.synced, true);

  const nextRow = at(`${dstPath}/students/class-3/ক/STU-2026-0001`);
  assert.ok(nextRow, 'the pupil exists in the new year’s next class');
  assert.equal(nextRow.classId, 'class-3');
  assert.equal(nextRow.year, dstYear, 'the row is stamped with the NEW year');
  // P0-3: the new year starts clean — no last-year GPA / grade / merit stamped on it.
  // (`?? null`: real RTDB deletes a `null` leaf on update, so the key reads back
  // missing — the app treats both as "no value".)
  assert.equal(nextRow.gpa ?? null, null, 'no carried GPA on the new row');
  assert.equal(nextRow.grade, '', 'no carried grade on the new row');
  assert.equal(nextRow.meritPosition ?? null, null, 'no carried merit on the new row');
  assert.equal(nextRow.grandTotal ?? null, null, 'no carried total on the new row');
  assert.equal(nextRow.promotedFromYear, srcYear, 'the source year is recorded');
  // P0-3: the new year has NO result rows at all → the new class's result starts at ০০.
  const noRows = Object.values(at(`${dstPath}/results`) ?? {})
    .flatMap((terms) => Object.values(terms ?? {}))
    .flatMap((rows) => Object.keys(rows ?? {}));
  assert.deepEqual(noRows, [], 'the new year starts with no result rows');

  // The finished year's DATA is frozen: the pupil row and the published result row are
  // byte-identical. (Only empty class-bucket skeletons and the promotion meta timestamp
  // may be refreshed by the idempotent year-bucket setup.)
  assert.deepEqual(
    at(`${srcPath}/students/class-2/ক/STU-2026-0001`),
    finishedBefore.row,
    'the previous year’s roster row is never rewritten',
  );
  assert.deepEqual(
    at(`${srcPath}/results/class-2/final/STU-2026-0001`),
    finishedBefore.result,
    'the previous year’s published result is never rewritten',
  );

  console.log('PASS — year rollover starts the new year at ০০ / no stale stamps and freezes the old year');
}

