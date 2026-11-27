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
  lockedViewClass,
  yearLockBannerText,
  januaryStatus,
  annualPassOf,
  buildAutoDecisions,
  checkUndoSafety,
  UNDO_BLOCK_MESSAGES,
  markClassPromotionComplete,
  readPromotionState,
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
assert.deepEqual(normalizePromotionState(null), { classes: {}, auto: null });
assert.deepEqual(normalizePromotionState({}), { classes: {}, auto: null });

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

console.log('PASS — annual promotion (2031→2032): year-agnostic helpers, January dates, per-class lock, merit rolls + section override, undo safety + undo + re-promotion, কার্যক্রম সম্পূর্ণ label + locked-view treatment');
