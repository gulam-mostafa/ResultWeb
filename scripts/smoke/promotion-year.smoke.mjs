/**
 * Smoke test §19 — annual promotion (বার্ষিক উত্তরণ), year-agnostic.
 *
 * Bundled by `scripts/smoke/run.mjs`, which aliases `firebase/*` to the in-memory
 * stubs in this folder. Every year here is 2031 → 2032 on purpose — NEVER
 * 2026/2027 — so the suite proves no year is hard-coded anywhere in the
 * promotion path.
 *
 * Covers:
 *  - pure helpers: class list / destinations / January warning + auto dates /
 *    pass rule / auto decisions (no I/O);
 *  - lock + completion helpers: empty class counts as complete, pending list,
 *    whole-year completion condition;
 *  - "কার্যক্রম সম্পূর্ণ" label + locked-view treatment: a finished year says
 *    কার্যক্রম সম্পূর্ণ (year from the caller, never hard-coded), an
 *    incomplete locked year keeps the plain wording, locked year/class get
 *    the monochrome treatment class, open year/class stay colourful;
 *  - RTDB round-trip: `markClassPromotionComplete` / `readPromotionState` /
 *    `markAutoPromotionDone` under `sessions/2031/meta/promotion`;
 *  - `autoPromoteClassDecisions`: stored annual grade decides (A ⇒ promote,
 *    F ⇒ retain, no row ⇒ retain);
 *  - `promoteSession` (per-class, `advanceProfileYear: false`): teacher's শাখা
 *    override honoured, merit-ordered rolls in the new year, source year
 *    untouched, profile year NOT advanced by one class;
 *  - undo safety: every block reason of `checkUndoSafety`;
 *  - `undoClassPromotion` end-to-end + clean re-promotion afterwards.
 */
import assert from 'node:assert/strict';
import { rememberSchoolLocation } from '../../src/services/database/dbPaths.js';
import {
  promotionClassIds,
  destinationClassOf,
  normalizePromotionState,
  isClassPromotionComplete,
  completedClassIds,
  classStudentCounts,
  pendingPromotionClasses,
  isPromotionCompleteForYear,
  defaultPromotionClassId,
  classPromotionStatuses,
  unlockHistoryOf,
  isClassReadOnly,
  promotionTargetYear,
  activationAfterPromotion,
  lockedViewClass,
  isYearReadOnly,
  yearLockBannerText,
  januaryStatus,
  annualPassOf,
  buildAutoDecisions,
  checkUndoSafety,
  UNDO_BLOCK_MESSAGES,
  markClassPromotionComplete,
  readPromotionState,
  recordPromotionUnlock,
  markAutoPromotionDone,
  autoPromoteClassDecisions,
  undoClassPromotion,
} from '../../src/services/database/promotionService.js';
import { promoteSession } from '../../src/services/database/sessionService.js';
import { readYearRoster } from '../../src/services/database/studentService.js';

const YEAR = '2031';
const NEXT = '2032';
const SCHOOL = 's4';
const BASE = 'divisions/d1/districts/d2/upazilas/u3/schools/s4';
const yearPath = `${BASE}/sessions/${YEAR}`;
const nextPath = `${BASE}/sessions/${NEXT}`;
const store = () => {
  globalThis.__smokeStore = globalThis.__smokeStore ?? {};
  return globalThis.__smokeStore;
};
const at = (path) => String(path).split('/').filter(Boolean)
  .reduce((cursor, key) => (cursor == null ? undefined : cursor[key]), store());

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

rememberSchoolLocation({ divisionId: 'd1', districtId: 'd2', upazilaId: 'u3', schoolId: SCHOOL });

/* ------------------------------------------------------------------ *
 * Seed — 2031: class-3 (3 pupils) + class-5 (2 pupils), with published
 * annual (final) results. Merit order in class-3: সজীব ১st, রুমি ২nd,
 * নাফিস ৩rd (ফেল). In class-5: তানিয়া পাস, মেহেদী ফেল.
 * ------------------------------------------------------------------ */
globalThis.__smokeStore = {};
const c3 = [
  { id: 'a1', studentMasterId: 'STU-2031-0001', name: 'রুমি', classId: 'c3', section: 'ক', roll: 1 },
  { id: 'a2', studentMasterId: 'STU-2031-0002', name: 'সজীব', classId: 'c3', section: 'খ', roll: 2 },
  { id: 'a3', studentMasterId: 'STU-2031-0003', name: 'নাফিস', classId: 'c3', section: 'ক', roll: 3 },
];
const c5 = [
  { id: 'b1', studentMasterId: 'STU-2031-0004', name: 'তানিয়া', classId: 'c5', section: 'ক', roll: 1 },
  { id: 'b2', studentMasterId: 'STU-2031-0005', name: 'মেহেদী', classId: 'c5', section: 'খ', roll: 2 },
];
const allSeeded = [...c3, ...c5];
seed(`${BASE}/studentMaster`, Object.fromEntries(allSeeded.map((student) => [student.studentMasterId, {
  studentMasterId: student.studentMasterId,
  legacyId: student.id,
  name: student.name,
  currentClassId: student.classId,
  academicYear: YEAR,
  overallStatus: 'active',
}])));
const enrollment = (student, dbClass) => ({
  studentMasterId: student.studentMasterId,
  legacyId: student.id,
  classId: dbClass,
  section: student.section,
  roll: student.roll,
  status: 'active',
  year: YEAR,
});
['ক', 'খ'].forEach((section) => {
  seed(`${yearPath}/students/class-3/${section}`, Object.fromEntries(
    c3.filter((student) => student.section === section)
      .map((student) => [student.studentMasterId, enrollment(student, 'class-3')]),
  ));
  seed(`${yearPath}/students/class-5/${section}`, Object.fromEntries(
    c5.filter((student) => student.section === section)
      .map((student) => [student.studentMasterId, enrollment(student, 'class-5')]),
  ));
});
seed(`${yearPath}/results/class-3/final`, {
  'STU-2031-0001': { meritPosition: 2, gpa: 4.6, grade: 'A', grandTotal: 390 },
  'STU-2031-0002': { meritPosition: 1, gpa: 5.0, grade: 'A+', grandTotal: 420 },
  'STU-2031-0003': { meritPosition: 3, gpa: 0.0, grade: 'F', grandTotal: 210 },
});
seed(`${yearPath}/results/class-5/final`, {
  'STU-2031-0004': { meritPosition: 1, gpa: 5.0, grade: 'A+', grandTotal: 430 },
  'STU-2031-0005': { meritPosition: 2, gpa: 0.0, grade: 'F', grandTotal: 190 },
});
seed(`${yearPath}/meta`, { year: YEAR });
seed(`${BASE}/profile`, {
  id: 's4', name: 'টেস্ট বিদ্যালয়', divisionId: 'd1', districtId: 'd2', upazilaId: 'u3', academicYear: YEAR,
});

/* ------------------------------------------------------------------ *
 * §19.1 — pure helpers: no year is hard-coded, dates derive from the year.
 * ------------------------------------------------------------------ */
assert.deepEqual(promotionClassIds(), ['pre', 'c1', 'c2', 'c3', 'c4', 'c5']);
assert.equal(destinationClassOf('pre'), 'c1');
assert.equal(destinationClassOf('c3'), 'c4');
assert.equal(destinationClassOf('c5'), 'archive');
assert.deepEqual(normalizePromotionState(null), { classes: {}, unlocks: {}, auto: null });
assert.deepEqual(normalizePromotionState({}), { classes: {}, unlocks: {}, auto: null });

const jan15 = januaryStatus(YEAR, new Date(2032, 0, 15));
assert.equal(jan15.targetYear, '2032');
assert.equal(jan15.isWarningMonth, true, '15 Jan 2032 warns');
assert.equal(jan15.isAutoDue, false, '15 Jan is not past 31 Jan');
const jan31 = januaryStatus(YEAR, new Date(2032, 0, 31));
assert.equal(jan31.isWarningMonth, true, '31 Jan still warns');
assert.equal(jan31.isAutoDue, false, '31 Jan itself is not past 31 Jan');
const feb1 = januaryStatus(YEAR, new Date(2032, 1, 1));
assert.equal(feb1.isWarningMonth, false, 'February no longer warns');
assert.equal(feb1.isAutoDue, true, '1 Feb is past 31 Jan');
const dec2031 = januaryStatus(YEAR, new Date(2031, 11, 20));
assert.equal(dec2031.isWarningMonth, false, 'December 2031 is not the warning month');
assert.equal(dec2031.isAutoDue, false, 'December 2031 is not past 31 Jan 2032');
const mar2032 = januaryStatus(YEAR, new Date(2032, 2, 5));
assert.equal(mar2032.isAutoDue, true, 'auto stays due until the classes are done');

assert.equal(annualPassOf({ grade: 'A' }), true);
assert.equal(annualPassOf({ grade: 'A+' }), true);
assert.equal(annualPassOf({ grade: 'F' }), false);
assert.equal(annualPassOf({}), false, 'no stored row never auto-promotes');
assert.equal(annualPassOf(null), false);
assert.equal(annualPassOf({ grade: '' }), false);

const autoDecisions = buildAutoDecisions(c3, (student) => student.id !== 'a3');
assert.deepEqual(autoDecisions.map((item) => item.action), ['promote', 'promote', 'retain']);
assert.equal(autoDecisions[0].studentMasterId, 'STU-2031-0001');
assert.equal(autoDecisions[0].section, 'ক', 'own section is kept');

/* ------------------------------------------------------------------ *
 * §19.2 — lock / completion helpers (pure).
 * ------------------------------------------------------------------ */
const emptyState = normalizePromotionState(null);
assert.equal(isClassPromotionComplete(emptyState, 'c3'), false);
assert.equal(isPromotionCompleteForYear(emptyState, {}), true, 'no pupils anywhere ⇒ year complete');
assert.equal(isPromotionCompleteForYear(emptyState, { c3: 3 }), false);
assert.deepEqual(pendingPromotionClasses(emptyState, { c3: 3, c5: 2 }), ['c3', 'c5']);
assert.deepEqual(pendingPromotionClasses(emptyState, { c3: 3 }), ['c3'], 'empty classes never block');
assert.deepEqual(
  classStudentCounts([...c3, ...c5, { id: 'x', classId: 'archive' }]),
  { c3: 3, c5: 2 },
  'archive rows are not counted',
);

/* ------------------------------------------------------------------ *
 * §19.2b — "কার্যক্রম সম্পূর্ণ" label + locked-view treatment (pure).
 * A finished year says "কার্যক্রম সম্পূর্ণ"; a merely locked year keeps
 * the older wording. The treatment class is the single marker the CSS
 * uses — a locked year and a locked class look exactly the same.
 * ------------------------------------------------------------------ */
const allCompleteState = normalizePromotionState({
  classes: Object.fromEntries(
    promotionClassIds().map((id) => [id, { completedAt: '2031-12-01T00:00:00.000Z', fromYear: YEAR, toYear: NEXT }]),
  ),
});
assert.equal(
  isPromotionCompleteForYear(allCompleteState, { pre: 2, c1: 3, c2: 1, c3: 3, c4: 4, c5: 2 }),
  true,
  'every class complete ⇒ the year is complete',
);
assert.equal(
  isPromotionCompleteForYear(allCompleteState, { pre: 2, c1: 3 }),
  true,
  'empty classes still count as complete',
);
const onePendingState = normalizePromotionState({
  classes: Object.fromEntries(
    promotionClassIds()
      .filter((id) => id !== 'c3')
      .map((id) => [id, { completedAt: '2031-12-01T00:00:00.000Z', fromYear: YEAR, toYear: NEXT }]),
  ),
});
assert.equal(
  isPromotionCompleteForYear(onePendingState, { c3: 3, c5: 2 }),
  false,
  'one pending class ⇒ the year is NOT complete (no "কার্যক্রম সম্পূর্ণ")',
);
const completeBanner = yearLockBannerText({ year: YEAR, isComplete: true });
assert.ok(completeBanner.includes('কার্যক্রম সম্পূর্ণ'), 'a finished year says কার্যক্রম সম্পূর্ণ');
assert.ok(completeBanner.includes('২০৩১'), 'the banner year comes from the viewed year, not a hard-coded year');
assert.ok(completeBanner.includes('শুধু দেখা যাবে'), 'a finished year is still view-only');
const lockedBanner = yearLockBannerText({ year: YEAR, isComplete: false });
assert.ok(lockedBanner.includes('লক করা'), 'an incomplete locked year keeps the plain locked wording');
assert.ok(!lockedBanner.includes('কার্যক্রম সম্পূর্ণ'), 'an incomplete year must never claim কার্যক্রম সম্পূর্ণ');
assert.ok(lockedBanner.includes('২০৩১'));
assert.equal(lockedViewClass(true), 'locked-view', 'a locked year/class gets the monochrome treatment');
assert.equal(lockedViewClass(false), '', 'an open year/class stays colourful');
assert.equal(lockedViewClass(undefined), '', 'unknown is never treated as locked');

/* ------------------------------------------------------------------ *
 * §19.2c — promotion modal defaults: the FIRST unpromoted class wins
 * (pre ➔ c1 ➔ … ➔ c5); when everything is done it falls back to the LAST
 * class. The six-row status list paints "সম্পূর্ণ" only for a RECORDED
 * promotion, and an empty class never blocks the year.
 * ------------------------------------------------------------------ */
const partialState = normalizePromotionState({
  classes: {
    pre: { completedAt: '2031-11-01T00:00:00.000Z', fromYear: YEAR, toYear: NEXT },
    c1: { completedAt: '2031-11-02T00:00:00.000Z', fromYear: YEAR, toYear: NEXT },
  },
});
assert.equal(
  defaultPromotionClassId(normalizePromotionState(null), { pre: 2, c1: 3, c2: 1 }),
  'pre',
  'nothing promoted yet ⇒ pre-primary is the default',
);
assert.equal(
  defaultPromotionClassId(partialState, { pre: 2, c1: 3, c2: 1, c4: 5 }),
  'c2',
  'default = the FIRST still-unpromoted class in school order',
);
assert.equal(
  defaultPromotionClassId(allCompleteState, { pre: 2, c1: 3 }),
  'c5',
  'every class promoted ⇒ the LAST class is the fallback',
);
assert.equal(
  defaultPromotionClassId(normalizePromotionState(null), { c3: 2 }),
  'c3',
  'empty classes are skipped by the default selection',
);
assert.equal(
  defaultPromotionClassId(normalizePromotionState(null)),
  'pre',
  'without counts the first class without a record is the default',
);

const statuses = classPromotionStatuses(partialState, [
  { id: 'x1', classId: 'c2' },
  { id: 'x2', classId: 'c2' },
  { id: 'x3', classId: 'c5' },
]);
assert.deepEqual(statuses.map((row) => row.classId), ['pre', 'c1', 'c2', 'c3', 'c4', 'c5'], 'all six classes, in order');
assert.deepEqual(
  statuses.map((row) => row.complete),
  [true, true, false, false, false, false],
  'only the RECORDED promotions are সম্পূর্ণ',
);
assert.deepEqual(
  statuses.map((row) => row.students),
  [0, 0, 2, 0, 0, 1],
  'every row carries its pupil count',
);
assert.equal(statuses.find((row) => row.classId === 'c2').pending, true, 'a class with pupils and no record is pending');
assert.equal(statuses.find((row) => row.classId === 'c3').pending, false, 'an empty class is never pending');
assert.equal(statuses[0].name, 'প্রাক-প্রাথমিক', 'the row carries the Bangla class name');
assert.equal(isPromotionCompleteForYear(partialState, { c2: 2, c5: 1 }), false, 'the year is not complete yet');

/* ------------------------------------------------------------------ *
 * §19.2d — a class is read-only ONLY in a past year or when THAT class is
 * promoted; the destination class of the next year stays open.
 * ------------------------------------------------------------------ */
assert.equal(isClassReadOnly({ viewYear: YEAR, activeYear: YEAR, state: partialState, classId: 'pre' }), true, 'a promoted class is read-only in the active year');
assert.equal(isClassReadOnly({ viewYear: YEAR, activeYear: YEAR, state: partialState, classId: 'c3' }), false, 'an unpromoted class stays editable');
assert.equal(isClassReadOnly({ viewYear: YEAR, activeYear: YEAR, state: partialState, classId: 'archive' }), false, 'the archive pseudo-class is never class-locked');
assert.equal(isClassReadOnly({ viewYear: NEXT, activeYear: YEAR, state: normalizePromotionState(null), classId: 'c4' }), false, 'the next year (destination class) is editable');
assert.equal(isClassReadOnly({ viewYear: '2030', activeYear: YEAR, state: normalizePromotionState(null), classId: 'c4' }), true, 'a past year is read-only for every class');

/* ------------------------------------------------------------------ *
 * §19.2e — auto-activation: ONE class never moves the year; the ACTIVE year
 * moves only when every class is done, into the year the promotion recorded.
 * ------------------------------------------------------------------ */
assert.equal(promotionTargetYear(partialState), NEXT, 'the recorded destination year is read from the log');
assert.deepEqual(
  activationAfterPromotion({ sourceYear: YEAR, activeYear: YEAR, state: partialState, counts: { c2: 2, c5: 1 } }),
  { activate: false, targetYear: '', reason: 'classes-pending' },
  'one pending class ⇒ no activation',
);
assert.equal(
  activationAfterPromotion({ sourceYear: YEAR, activeYear: YEAR, state: partialState, counts: { c2: 2, c5: 1 } }).activate,
  false,
);
assert.deepEqual(
  activationAfterPromotion({ sourceYear: YEAR, activeYear: YEAR, state: allCompleteState, counts: { pre: 2, c5: 2 } }),
  { activate: true, targetYear: NEXT, reason: 'year-complete' },
  'every class done ⇒ the next year becomes active',
);
assert.equal(
  activationAfterPromotion({ sourceYear: NEXT, activeYear: YEAR, state: allCompleteState, counts: {} }).reason,
  'not-active-year',
  'completing a FUTURE year early never skips it as the active year',
);
assert.equal(
  activationAfterPromotion({ sourceYear: YEAR, activeYear: YEAR, state: allCompleteState, counts: {} }).activate,
  true,
  'empty classes count as complete ⇒ the year may advance',
);

/* ------------------------------------------------------------------ *
 * §19.3 — stored-grade auto decisions for class-5 (2031).
 * ------------------------------------------------------------------ */
const c5Auto = await autoPromoteClassDecisions(SCHOOL, YEAR, 'c5');
assert.equal(c5Auto.passed, 1, 'তানিয়া (A+) passes');
assert.equal(c5Auto.retained, 1, 'মেহেদী (F) stays');
assert.deepEqual(
  c5Auto.decisions.map((item) => [item.studentMasterId, item.action]),
  [['STU-2031-0004', 'promote'], ['STU-2031-0005', 'retain']],
);
// A pupil with NO stored final row is retained, never auto-promoted.
const c3Auto = await autoPromoteClassDecisions(SCHOOL, YEAR, 'c3');
assert.equal(c3Auto.passed, 2);
assert.equal(c3Auto.retained, 1);

/* ------------------------------------------------------------------ *
 * §19.4 — per-class promotion 2031 → 2032 (`advanceProfileYear: false`).
 * সজীব (merit ১st, own section খ) is overridden to `ক`; রুমি (merit ২nd)
 * stays in `ক`; নাফিস (F) stays in class-3.
 * ------------------------------------------------------------------ */
const decisions = [
  { studentId: 'a2', studentMasterId: 'STU-2031-0002', action: 'promote', section: 'ক' },
  { studentId: 'a1', studentMasterId: 'STU-2031-0001', action: 'promote', section: 'ক' },
  { studentId: 'a3', studentMasterId: 'STU-2031-0003', action: 'retain', section: 'ক' },
];
const promoted = await promoteSession(SCHOOL, {
  year: YEAR, nextYear: NEXT, decisions, advanceProfileYear: false,
});
assert.equal(promoted.synced, true, 'per-class promotion should sync');
assert.equal(promoted.promoted, 2);
assert.equal(promoted.retained, 1);
assert.equal(promoted.graduated, 0);
assert.equal(promoted.nextYear, NEXT);

// Teacher's শাখা override honoured (সজীব lands in `ক`, not his own `খ`),
// and the new rolls follow MERIT order, not the old rolls.
const class4k = at(`${nextPath}/students/class-4/ক`);
assert.ok(class4k, '2032 class-4/ক must exist');
assert.equal(class4k['STU-2031-0002'].roll, 1, 'merit ১st must get roll ১ in ক');
assert.equal(class4k['STU-2031-0002'].section, 'ক', 'override section wins over own section');
assert.equal(class4k['STU-2031-0001'].roll, 2, 'merit ২nd must get roll ২ in ক');
assert.equal(at(`${nextPath}/students/class-4/খ`), undefined, 'no pupil may land in খ');
const retainedNext = at(`${nextPath}/students/class-3/ক/STU-2031-0003`);
assert.ok(retainedNext, 'retained pupil is enrolled in 2032 class-3');
assert.equal(retainedNext.roll, 1);
assert.equal(retainedNext.classId, 'class-3');

// The source year is NEVER touched by the promotion…
assert.equal(at(`${yearPath}/students/class-3/ক/STU-2031-0001`).roll, 1, '2031 roll unchanged');
assert.equal(at(`${yearPath}/students/class-3/খ/STU-2031-0002`).roll, 2, '2031 section unchanged');
assert.equal(at(`${yearPath}/results/class-3/final/STU-2031-0002`).grade, 'A+', '2031 result unchanged');
// …and ONE class must never flip the school's active year.
assert.equal(at(`${BASE}/profile`).academicYear, YEAR, 'profile year stays 2031 after one class');

/* ------------------------------------------------------------------ *
 * §19.5 — completion record round-trip + lock helpers on live state.
 * ------------------------------------------------------------------ */
const recordResult = await markClassPromotionComplete(SCHOOL, {
  year: YEAR,
  classId: 'c3',
  toYear: NEXT,
  promoted: 2,
  retained: 1,
  graduated: 0,
  moved: ['STU-2031-0001', 'STU-2031-0002', 'STU-2031-0003'],
  graduatedIds: [],
  destinations: {
    'STU-2031-0001': 'c4',
    'STU-2031-0002': 'c4',
    'STU-2031-0003': 'c3',
  },
  auto: false,
  completedBy: 'u1',
  completedByName: 'শিক্ষক',
});
assert.equal(recordResult.synced, true);
const liveState = await readPromotionState(SCHOOL, YEAR);
assert.equal(isClassPromotionComplete(liveState, 'c3'), true);
assert.equal(isClassPromotionComplete(liveState, 'c5'), false);
assert.deepEqual(completedClassIds(liveState), ['c3']);
const record = liveState.classes.c3;
assert.equal(record.fromYear, YEAR);
assert.equal(record.toYear, NEXT);
assert.equal(record.promoted, 2);
assert.equal(record.retained, 1);
assert.equal(record.auto, false);
assert.ok(record.completedAt, 'completion timestamp recorded');
assert.deepEqual(pendingPromotionClasses(liveState, { c3: 3, c5: 2 }), ['c5']);
assert.equal(isPromotionCompleteForYear(liveState, { c3: 3, c5: 2 }), false);
assert.equal(isPromotionCompleteForYear(liveState, { c3: 3 }), true, 'empty c5 counts as complete');

const autoDone = await markAutoPromotionDone(SCHOOL, YEAR, 'system');
assert.equal(autoDone.synced, true);
const withAuto = await readPromotionState(SCHOOL, YEAR);
assert.ok(withAuto.auto?.at, 'auto-run marker recorded');
assert.equal(withAuto.auto.by, 'system');

/* ------------------------------------------------------------------ *
 * §19.5b — a promoted class locks FOREVER (until guarded undo).
 * The c3 record is still there on a fresh re-read (a reload), and the
 * January auto marker never unlocks a class either — the only code path
 * that removes a completion record is the guarded undo (§19.7).
 * ------------------------------------------------------------------ */
const rereadState = await readPromotionState(SCHOOL, YEAR);
assert.equal(isClassPromotionComplete(rereadState, 'c3'), true, 'a fresh re-read (reload) keeps the source class locked');
assert.equal(isClassPromotionComplete(withAuto, 'c3'), true, 'the January auto marker never unlocks a class');

/* ------------------------------------------------------------------ *
 * §19.6 — undo safety: every block reason.
 * ------------------------------------------------------------------ */
const { students: nextYearStudents } = await readYearRoster(SCHOOL, NEXT);
assert.equal(nextYearStudents.length, 3, '2032 roster holds the 3 moved pupils');
const baseSafety = {
  record,
  nextYearStudents,
  nextYearResults: {},
  nextYearAttendance: {},
  promotionState: liveState,
};
assert.deepEqual(checkUndoSafety(baseSafety), { ok: true, reason: '', details: {
  missing: [], relocated: [], editedAfterPromotion: [], newAdmissions: [],
  pupilsWithMarks: [], pupilsWithAttendance: [],
} });
assert.equal(checkUndoSafety({ ...baseSafety, record: {} }).reason, 'not-promoted');

const withNewAdmission = [...nextYearStudents, { id: 'NEW-1', studentMasterId: 'NEW-1', classId: 'c4', section: 'ক' }];
assert.equal(checkUndoSafety({ ...baseSafety, nextYearStudents: withNewAdmission }).reason, 'new-admission');

const withMarks = { c4: { term1: { 'STU-2031-0002': { bangla: 80 } } } };
assert.equal(checkUndoSafety({ ...baseSafety, nextYearResults: withMarks }).reason, 'has-marks');

const withAttendance = { '2032-02-03': { c4: { 'STU-2031-0001': { status: 'present' } } } };
assert.equal(checkUndoSafety({ ...baseSafety, nextYearAttendance: withAttendance }).reason, 'has-attendance');

const missingOne = nextYearStudents.filter((student) => student.studentMasterId !== 'STU-2031-0002');
assert.equal(checkUndoSafety({ ...baseSafety, nextYearStudents: missingOne }).reason, 'pupil-missing');

const relocated = nextYearStudents.map((student) => (
  student.studentMasterId === 'STU-2031-0002' ? { ...student, classId: 'c3' } : student
));
assert.equal(checkUndoSafety({ ...baseSafety, nextYearStudents: relocated }).reason, 'pupil-relocated');

const edited = nextYearStudents.map((student) => {
  if (student.studentMasterId !== 'STU-2031-0002') return student;
  // Explicit stamps: the row was written by the promotion at 00:00 and edited
  // an hour later — well beyond the 60s clock-skew tolerance.
  return {
    ...student,
    promotedAt: '2032-01-15T00:00:00.000Z',
    updatedAt: '2032-01-15T01:00:00.000Z',
  };
});
assert.equal(checkUndoSafety({ ...baseSafety, nextYearStudents: edited }).reason, 'pupil-edited');

// Every block reason has a Bangla message for the UI.
for (const reason of ['not-promoted', 'pupil-missing', 'pupil-relocated', 'pupil-edited', 'new-admission', 'has-marks', 'has-attendance']) {
  assert.ok((UNDO_BLOCK_MESSAGES[reason] ?? '').length > 5, `Bangla message for ${reason}`);
}

/* ------------------------------------------------------------------ *
 * §19.7 — undo end-to-end, then a clean re-promotion.
 * ------------------------------------------------------------------ */
const undone = await undoClassPromotion(SCHOOL, { year: YEAR, nextYear: NEXT, classId: 'c3' });
assert.equal(undone.synced, true, 'undo should sync');
assert.deepEqual(undone.undone, { promoted: 2, retained: 1, graduated: 0 });
assert.equal(at(`${nextPath}/students/class-4/ক/STU-2031-0002`), undefined, 'promoted enrolment deleted');
assert.equal(at(`${nextPath}/students/class-4/ক/STU-2031-0001`), undefined, 'promoted enrolment deleted');
assert.equal(at(`${nextPath}/students/class-3/ক/STU-2031-0003`), undefined, 'retained enrolment deleted');
assert.deepEqual(Object.keys(at(`${nextPath}/students/class-4/ক`) ?? {}), [], 'destination section emptied');
const afterUndo = await readPromotionState(SCHOOL, YEAR);
assert.equal(isClassPromotionComplete(afterUndo, 'c3'), false, 'completion record removed');
assert.equal(afterUndo.auto?.at, withAuto.auto.at, 'auto marker untouched by the undo');
const restoredMaster = at(`${BASE}/studentMaster/STU-2031-0002`);
assert.equal(restoredMaster.currentClassId, 'c3', 'master row points back at the source class');
assert.equal(restoredMaster.academicYear, YEAR, 'master row points back at the source year');
assert.equal(restoredMaster.overallStatus, 'active');
assert.equal(restoredMaster.name, 'সজীব', 'master row keeps the pupil’s identity');

// A class that was undone can be promoted again — the undo left no residue.
const repromoted = await promoteSession(SCHOOL, {
  year: YEAR, nextYear: NEXT, decisions, advanceProfileYear: false,
});
assert.equal(repromoted.synced, true, 're-promotion after undo should sync');
assert.equal(at(`${nextPath}/students/class-4/ক/STU-2031-0002`).roll, 1, 're-promoted rolls match merit order');
assert.equal(at(`${BASE}/profile`).academicYear, YEAR, 'profile year still 2031');

/* ------------------------------------------------------------------ *
 * §19.8 — only PAST years are read-only; the next year stays open.
 * ------------------------------------------------------------------ */
// (a) The read-only rule: past year locked, active + future years open.
assert.equal(isYearReadOnly(NEXT, YEAR), false, 'next year (2032) is NOT read-only while 2031 is active');
assert.equal(isYearReadOnly('2030', YEAR), true, 'past year (2030) is read-only');
assert.equal(isYearReadOnly(YEAR, YEAR), false, 'active year is not read-only');
assert.equal(isYearReadOnly('২০৩২', '২০৩১'), false, 'Bangla digits: next year is open');
assert.equal(isYearReadOnly('২০৩০', '২০৩১'), true, 'Bangla digits: past year is locked');
assert.equal(isYearReadOnly('', YEAR), false, 'unparseable viewed year never locks');
assert.equal(isYearReadOnly(YEAR, ''), false, 'unparseable active year never locks');

// (b) The destination class is OPEN in the next year: the next year's log
// has no completion records at all, so its classes are never locked by the
// source year's promotion.
const nextState = await readPromotionState(SCHOOL, NEXT);
assert.deepEqual(completedClassIds(nextState), [], 'no class is complete in the next year yet');
assert.equal(isClassPromotionComplete(nextState, 'c4'), false, 'destination class (2032 class-4) is open');
assert.equal(isPromotionCompleteForYear(nextState, { c3: 1, c4: 2 }), false, 'the next year is not complete — its work continues');

// (c) The January logic keys off the ACTIVE year only, never the viewed year.
assert.equal(januaryStatus(YEAR, new Date(2032, 1, 1)).isAutoDue, true, 'Jan logic for active 2031: auto due 1 Feb 2032');
assert.equal(januaryStatus(NEXT, new Date(2032, 1, 1)).isAutoDue, false, 'same date is NOT auto-due for 2032 (its target is 2033)');

console.log('PASS — annual promotion (2031→2032): year-agnostic helpers, January dates, per-class lock, merit rolls + section override, undo safety + undo + re-promotion, কার্যক্রম সম্পূর্ণ label + locked-view treatment, past-year-only read-only + forever-locked source class + open next year');

/* ------------------------------------------------------------------ *
 * §19.9 — "আনলক করুন" (unlock) is the same guarded undo + an audit row.
 *
 * The class is promoted again above, then unlocked by a named admin:
 *  - a BLOCKED unlock keeps the class locked and writes no audit row;
 *  - a clean unlock reopens the class and records WHO (name + email + uid +
 *    role) and WHEN in `sessions/{year}/meta/promotion/unlocks/{classId}`;
 *  - the audit survives the next promotion (it is a SIBLING of `classes`);
 *  - the active year never moves on an unlock.
 * ------------------------------------------------------------------ */
const repromotionRecord = await markClassPromotionComplete(SCHOOL, {
  year: YEAR,
  classId: 'c3',
  toYear: NEXT,
  promoted: 2,
  retained: 1,
  graduated: 0,
  moved: ['STU-2031-0001', 'STU-2031-0002', 'STU-2031-0003'],
  graduatedIds: [],
  destinations: {
    'STU-2031-0001': 'c4',
    'STU-2031-0002': 'c4',
    'STU-2031-0003': 'c3',
  },
  auto: false,
  completedBy: 'u1',
  completedByName: 'শিক্ষক',
  completedByEmail: 'teacher@example.com',
});
assert.equal(repromotionRecord.synced, true, 'the class is promoted again before the unlock');
const lockedState = await readPromotionState(SCHOOL, YEAR);
assert.equal(isClassPromotionComplete(lockedState, 'c3'), true, 'a promoted class is locked');
assert.equal(lockedState.classes.c3.completedByEmail, 'teacher@example.com', 'the promoter email is stored');

// (a) A blocked unlock keeps the class locked and records NOTHING.
seed(`${nextPath}/results/class-4/final/STU-2031-0002`, { meritPosition: 1, gpa: 5, grade: 'A+' });
const blockedUnlock = await undoClassPromotion(SCHOOL, {
  year: YEAR,
  nextYear: NEXT,
  classId: 'c3',
  actor: { uid: 'admin-9', name: 'অ্যাডমিন', email: 'admin@example.com', role: 'school_admin' },
});
assert.equal(blockedUnlock.synced, false, 'the unlock is refused while next-year marks exist');
assert.equal(blockedUnlock.blockReason, 'has-marks', 'the block reason is the guarded-undo reason');
assert.equal(typeof blockedUnlock.message, 'string', 'a Bangla block message is returned');
const stillLocked = await readPromotionState(SCHOOL, YEAR);
assert.equal(isClassPromotionComplete(stillLocked, 'c3'), true, 'a blocked unlock never reopens the class');
assert.deepEqual(unlockHistoryOf(stillLocked, 'c3'), [], 'a blocked unlock writes no audit row');

// (b) A clean unlock reopens the class AND records the actor.
delete at(`${nextPath}/results/class-4/final`)['STU-2031-0002'];
const unlock = await undoClassPromotion(SCHOOL, {
  year: YEAR,
  nextYear: NEXT,
  classId: 'c3',
  actor: { uid: 'admin-9', name: 'মোছাঃ সালমা আক্তার', email: 'salma@example.com', role: 'school_admin' },
});
assert.equal(unlock.synced, true, 'the unlock runs when nothing newer exists');
assert.deepEqual(unlock.audit, { synced: true }, 'the audit write is reported');
assert.deepEqual(unlock.undone, { promoted: 2, retained: 1, graduated: 0 });
const unlockedState = await readPromotionState(SCHOOL, YEAR);
assert.equal(isClassPromotionComplete(unlockedState, 'c3'), false, 'the unlocked class is editable again');
const auditRows = unlockHistoryOf(unlockedState, 'c3');
assert.equal(auditRows.length, 1, 'exactly one unlock is recorded');
assert.equal(auditRows[0].name, 'মোছাঃ সালমা আক্তার', 'the audit stores the admin name');
assert.equal(auditRows[0].email, 'salma@example.com', 'the audit stores the admin email');
assert.equal(auditRows[0].uid, 'admin-9', 'the audit stores the admin uid');
assert.equal(auditRows[0].by, 'school_admin', 'the audit stores the admin role');
assert.ok(auditRows[0].at && !Number.isNaN(Date.parse(auditRows[0].at)), 'the audit stores a real timestamp');
assert.equal(at(`${BASE}/profile`).academicYear, YEAR, 'an unlock never changes the active year');
assert.equal(at(`${nextPath}/students/class-4/ক/STU-2031-0002`), undefined, 'the unlock deleted the next-year enrolment');
assert.equal(at(`${BASE}/studentMaster/STU-2031-0002`).currentClassId, 'c3', 'the pupil points back at the source class');
// The unlock audit lives NEXT TO `classes`, so it cannot be wiped by the next promotion.
assert.ok(at(`${yearPath}/meta/promotion/unlocks/c3`), 'the audit node is a sibling of the class records');

// (c) Promote again: the class locks again and the audit still names the unlocker.
await promoteSession(SCHOOL, { year: YEAR, nextYear: NEXT, decisions, advanceProfileYear: false });
await markClassPromotionComplete(SCHOOL, {
  year: YEAR,
  classId: 'c3',
  toYear: NEXT,
  promoted: 2,
  retained: 1,
  moved: ['STU-2031-0001', 'STU-2031-0002', 'STU-2031-0003'],
  destinations: { 'STU-2031-0001': 'c4', 'STU-2031-0002': 'c4', 'STU-2031-0003': 'c3' },
  completedBy: 'u1',
  completedByName: 'শিক্ষক',
});
const afterRepromote = await readPromotionState(SCHOOL, YEAR);
assert.equal(isClassPromotionComplete(afterRepromote, 'c3'), true, 'the class is locked again after the unlock + re-promotion');
assert.equal(unlockHistoryOf(afterRepromote, 'c3')[0].name, 'মোছাঃ সালমা আক্তার', 'the unlock audit survives the next promotion');

// (d) A second unlock is appended (newest first), never overwriting the first.
const secondUnlock = await undoClassPromotion(SCHOOL, {
  year: YEAR,
  nextYear: NEXT,
  classId: 'c3',
  actor: { uid: 'admin-10', name: 'পরিচালক', email: 'director@example.com' },
  mode: 'undo',
});
assert.equal(secondUnlock.synced, true, 'the class can be unlocked again');
const twoUnlocks = unlockHistoryOf(await readPromotionState(SCHOOL, YEAR), 'c3');
assert.equal(twoUnlocks.length, 2, 'both unlocks are kept');
assert.equal(twoUnlocks[0].name, 'পরিচালক', 'the newest unlock is listed first');
assert.equal(twoUnlocks[1].name, 'মোছাঃ সালমা আক্তার', 'the older unlock is still there');

// (e) `recordPromotionUnlock` is the audit writer on its own.
const directAudit = await recordPromotionUnlock(SCHOOL, {
  year: YEAR,
  classId: 'c5',
  actor: { uid: 'admin-11', name: 'নিরীক্ষক', email: 'auditor@example.com' },
});
assert.equal(directAudit.synced, true, 'the audit writer works standalone');
const c5Audit = unlockHistoryOf(await readPromotionState(SCHOOL, YEAR), 'c5');
assert.equal(c5Audit.length, 1);
assert.equal(c5Audit[0].email, 'auditor@example.com');

console.log('PASS — unlock (আনলক করুন): same guarded undo + audit of name/email/uid/time, a blocked unlock writes nothing, the audit survives re-promotion, no year change');
