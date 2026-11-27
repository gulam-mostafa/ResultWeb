/**
 * Annual promotion (বার্ষিক উত্তরণ) — year-scoped state, January rollover and undo.
 *
 * Data layout (per school, under the hierarchical tenant root — never a new
 * top-level node, never `resultHistory`):
 *
 * ```text
 * …/sessions/{year}/meta/promotion
 *   classes: { [classId]: {
 *     completedAt, completedBy, completedByName,
 *     fromYear, toYear,
 *     promoted, retained, graduated,
 *     moved: [studentMasterId…],          // promoted + retained (enrolled next year)
 *     graduatedIds: [studentMasterId…],   // Class-5 leavers (passedArchive)
 *     destinations: { [studentMasterId]: targetClassId },
 *     auto: boolean                        // true when the January auto-run did it
 *   } },
 *   auto: { at, by } | null                // set once the January auto-run finishes
 * ```
 *
 * Rules (user-confirmed 2026-11-27; the years in the examples are only examples —
 * every function here takes the year as an argument, nothing is hard-coded):
 *  - promotion is per class, one class at a time; pass ➔ উত্তীর্ণ (next class),
 *    fail ➔ এই ক্লাসেই থাকুক (same class, next year); the teacher may override
 *    any pupil's decision by hand;
 *  - a class with no active pupils counts as complete;
 *  - the school's active year moves to the next year ONLY when every class is
 *    complete (a single class never flips the year);
 *  - in January of the next year a warning is shown; after 31 January the
 *    remaining classes are promoted automatically with the same pass/fail rule;
 *  - undo removes exactly what the promotion wrote (next-year enrolments +
 *    archive entries + the completion record) and restores the permanent
 *    identity rows; it is BLOCKED (with a Bangla reason) when undoing would
 *    destroy data — a new admission in the destination class, marks or
 *    attendance written for a moved pupil, or a moved pupil no longer sitting
 *    where the promotion put them.
 */
import { CLASS_LEVELS, NEXT_CLASS_MAP } from '../../utils/constants.js';
import { toBanglaNumber } from '../../utils/banglaNumberFormatter.js';
import { dbPaths, normalizeSessionYear } from './dbPaths.js';
import {
  cleanForCloud,
  safeRead,
  safeSubscribe,
  safeUpdate,
  safeMultiPathUpdate,
} from './dbFallback.js';
import { nextSessionYear } from './sessionService.js';
import { readYearRoster, toDbClassId } from './studentService.js';

const asRecord = (value) => (value && typeof value === 'object' && !Array.isArray(value) ? value : {});
const asList = (value) => (Array.isArray(value) ? value.filter(Boolean) : []);
const toId = (value) => String(value ?? '').trim();

/** Class ids in school order (pre-primary ➔ class-5), from CLASS_LEVELS — no hard-coded list. */
export const promotionClassIds = () => CLASS_LEVELS.map((level) => level.id);

/** Destination class of a promoted pupil, or `'archive'` for a Class-5 leaver. */
export const destinationClassOf = (sourceClassId) => NEXT_CLASS_MAP[sourceClassId] ?? 'archive';

/** `…/sessions/{year}/meta/promotion` — the year's promotion log. */
export const promotionMetaPath = (schoolId, year) => {
  const yearKey = normalizeSessionYear(year);
  if (!schoolId || !yearKey) return '';
  return `${dbPaths.yearMeta(schoolId, yearKey)}/promotion`;
};

/* ------------------------------------------------------------------ *
 * Pure state helpers (no I/O — unit-testable, year-agnostic)
 * ------------------------------------------------------------------ */

/** Normalises a raw promotion node into `{ classes, auto }`. */
export function normalizePromotionState(raw) {
  const source = asRecord(raw);
  const classes = {};
  Object.entries(asRecord(source.classes)).forEach(([classId, entry]) => {
    const record = asRecord(entry);
    classes[classId] = {
      completedAt: record.completedAt ?? '',
      completedBy: record.completedBy ?? '',
      completedByName: record.completedByName ?? '',
      fromYear: normalizeSessionYear(record.fromYear),
      toYear: normalizeSessionYear(record.toYear),
      promoted: Number(record.promoted) || 0,
      retained: Number(record.retained) || 0,
      graduated: Number(record.graduated) || 0,
      moved: asList(record.moved).map(toId).filter(Boolean),
      graduatedIds: asList(record.graduatedIds).map(toId).filter(Boolean),
      destinations: asRecord(record.destinations),
      auto: record.auto === true,
    };
  });
  return { classes, auto: asRecord(source.auto).at ? { at: source.auto.at, by: source.auto.by ?? '' } : null };
}

/** `true` when this class's promotion is recorded as complete. */
export const isClassPromotionComplete = (state, classId) => Boolean(
  asRecord(state?.classes)[classId]?.completedAt,
);

/** Class ids with a recorded completion, in school order. */
export function completedClassIds(state) {
  return promotionClassIds().filter((classId) => isClassPromotionComplete(state, classId));
}

/** `{ classId: active-pupil count }` from a roster list (archive rows excluded). */
export function classStudentCounts(students = []) {
  const counts = {};
  asList(students).forEach((student) => {
    if (!student?.classId || student.classId === 'archive') return;
    counts[student.classId] = (counts[student.classId] ?? 0) + 1;
  });
  return counts;
}

/**
 * Classes still waiting for promotion: they have pupils and no completion record.
 * A class with no active pupils counts as complete, so it never blocks the year.
 */
export function pendingPromotionClasses(state, counts = {}) {
  return promotionClassIds().filter((classId) => {
    if (isClassPromotionComplete(state, classId)) return false;
    return (Number(counts[classId]) || 0) > 0;
  });
}

/** `true` when every class is complete or empty — the year may advance. */
export const isPromotionCompleteForYear = (state, counts = {}) =>
  pendingPromotionClasses(state, counts).length === 0;

/**
 * Locked-view CSS class for a finished year or a finished class.
 * The class itself is only a marker — the monochrome treatment lives in
 * `src/index.css` (`.locked-view`), so a locked year and a locked class look
 * exactly the same: black text, no colour anywhere (নিষ্ক্রিয়).
 */
export const lockedViewClass = (isLocked) => (isLocked ? 'locked-view' : '');

/**
 * The read-only banner text for a viewed year. A finished year says
 * "কার্যক্রম সম্পূর্ণ"; a merely locked (not yet complete) year keeps the
 * older wording. The year number comes from the caller (activeYear /
 * viewYear) — never hard-coded.
 */
export function yearLockBannerText({ year, isComplete }) {
  const y = toBanglaNumber(year ?? '');
  return isComplete
    ? `${y} সালের কার্যক্রম সম্পূর্ণ — শুধু দেখা যাবে। কিছুই এডিট করা যাবে না।`
    : `${y} সালের তথ্য দেখছেন — এই সালটি লক করা, শুধু দেখা যাবে। কিছুই এডিট করা যাবে না।`;
}

/**
 * January rollover status for an active year — pure date logic, no hard-coded year.
 *
 * - `targetYear`: the year promotion leads into (`activeYear + 1`);
 * - `isWarningMonth`: today is a January day of the target year — show the
 *   "promote now or it will happen automatically" warning;
 * - `isAutoDue`: today is past 31 January of the target year — the remaining
 *   classes must be promoted automatically (same pass/fail rule).
 */
export function januaryStatus(activeYear, now = new Date()) {
  const base = Number(normalizeSessionYear(activeYear)) || Number(now.getFullYear());
  const targetYear = String(base + 1);
  const target = Number(targetYear);
  const today = now instanceof Date && !Number.isNaN(now.getTime()) ? now : new Date();
  const isWarningMonth = today.getFullYear() === target && today.getMonth() === 0;
  // 1 February 00:00 of the target year is the first moment past 31 January.
  const autoFrom = new Date(target, 1, 1, 0, 0, 0, 0);
  const isAutoDue = today.getTime() >= autoFrom.getTime();
  return { activeYear: String(base), targetYear, isWarningMonth, isAutoDue };
}

/**
 * Pass/fail from a STORED annual result row (`sessions/{year}/results/{class}/final/{id}`).
 * The published grade is the stored truth: a grade other than `F` passes. A missing
 * row (or a row without a grade) never auto-promotes — the pupil is retained, exactly
 * like the promotion modal's "no annual marks ⇒ stay" rule.
 */
export const annualPassOf = (row) => {
  const grade = String(asRecord(row).grade ?? '').trim();
  return grade !== '' && grade !== 'F';
};

/**
 * Builds year-advance decisions for one class from its roster and a pass predicate
 * (the app passes the live `getStudentResult` verdict; the service path passes the
 * stored annual grade). Pass ➔ `promote`, anything else ➔ `retain`.
 */
export function buildAutoDecisions(students = [], isPassOf) {
  return asList(students)
    .filter((student) => student?.classId && student.classId !== 'archive')
    .map((student) => ({
      studentId: student.id,
      studentMasterId: student.studentMasterId || student.id,
      action: isPassOf?.(student) === true ? 'promote' : 'retain',
      section: student.section || '',
    }));
}

/* ------------------------------------------------------------------ *
 * Undo safety (pure — the write only runs when this says OK)
 * ------------------------------------------------------------------ */

/**
 * Checks whether undoing one class's promotion is safe.
 *
 * @param {object} args
 * @param {object} args.record — the class's completion record
 * @param {Array} args.nextYearStudents — the NEXT year's full roster
 * @param {object} args.nextYearResults — `sessions/{nextYear}/results` tree
 * @param {object} args.nextYearAttendance — `sessions/{nextYear}/attendance` tree
 * @param {object} args.promotionState — the source year's whole promotion state
 *   (other classes' moved pupils legitimately share the destination classes)
 * @returns {{ok:boolean, reason:string, details:object}} — `reason` is a
 *   machine-readable code; the caller maps it to a Bangla message.
 */
export function checkUndoSafety({
  record,
  nextYearStudents = [],
  nextYearResults = {},
  nextYearAttendance = {},
  promotionState = null,
} = {}) {
  const empty = { ok: false, reason: '', details: {} };
  const rec = asRecord(record);
  if (!rec.completedAt) return { ...empty, reason: 'not-promoted' };
  const moved = asList(rec.moved).map(toId).filter(Boolean);
  const graduated = asList(rec.graduatedIds).map(toId).filter(Boolean);
  const destinations = asRecord(rec.destinations);
  const allMoved = new Set();
  Object.values(asRecord(promotionState?.classes)).forEach((entry) => {
    asList(asRecord(entry).moved).forEach((id) => allMoved.add(toId(id)));
  });
  moved.forEach((id) => allMoved.add(id));

  const byId = new Map();
  asList(nextYearStudents).forEach((student) => {
    const id = toId(student?.studentMasterId || student?.id);
    if (id) byId.set(id, student);
  });

  // (1) Every moved pupil must still sit where the promotion put them.
  const missing = [];
  const relocated = [];
  const editedAfterPromotion = [];
  const completedAtMs = Date.parse(rec.completedAt) || 0;
  moved.forEach((id) => {
    const row = byId.get(id);
    if (!row) { missing.push(id); return; }
    const expectedClass = destinations[id];
    if (expectedClass && toId(row.classId) !== expectedClass) { relocated.push(id); return; }
    const promotedAtMs = Date.parse(row.promotedAt ?? '') || 0;
    const updatedAtMs = Date.parse(row.updatedAt ?? '') || 0;
    // A row edited after the promotion (beyond a 60s clock-skew tolerance) holds
    // newer data than the promotion wrote — deleting it would destroy that edit.
    if (promotedAtMs > 0 && updatedAtMs - promotedAtMs > 60_000) editedAfterPromotion.push(id);
  });

  // (2) No new admission may have landed in an affected destination class.
  const affectedClasses = new Set(Object.values(destinations).filter(Boolean));
  const newAdmissions = [];
  asList(nextYearStudents).forEach((student) => {
    if (!affectedClasses.has(toId(student?.classId))) return;
    const id = toId(student?.studentMasterId || student?.id);
    if (!id || allMoved.has(id)) return;
    // A pupil placed by ANY promotion carries `promotedAt`; a hand-admitted pupil
    // does not — that is the new admission the undo must not disturb.
    if (!student?.promotedAt) newAdmissions.push(id);
  });

  // (3) No marks / attendance may exist for a moved or graduated pupil next year.
  const idsWithData = new Set([...moved, ...graduated]);
  const pupilsWithMarks = new Set();
  Object.values(asRecord(nextYearResults)).forEach((terms) => {
    Object.values(asRecord(terms)).forEach((rows) => {
      Object.keys(asRecord(rows)).forEach((id) => {
        if (idsWithData.has(toId(id))) pupilsWithMarks.add(toId(id));
      });
    });
  });
  const pupilsWithAttendance = new Set();
  Object.values(asRecord(nextYearAttendance)).forEach((byClass) => {
    Object.values(asRecord(byClass)).forEach((rows) => {
      Object.keys(asRecord(rows)).forEach((id) => {
        if (idsWithData.has(toId(id))) pupilsWithAttendance.add(toId(id));
      });
    });
  });

  const details = {
    missing,
    relocated,
    editedAfterPromotion,
    newAdmissions,
    pupilsWithMarks: [...pupilsWithMarks],
    pupilsWithAttendance: [...pupilsWithAttendance],
  };
  if (missing.length) return { ...empty, reason: 'pupil-missing', details };
  if (relocated.length) return { ...empty, reason: 'pupil-relocated', details };
  if (editedAfterPromotion.length) return { ...empty, reason: 'pupil-edited', details };
  if (newAdmissions.length) return { ...empty, reason: 'new-admission', details };
  if (pupilsWithMarks.size) return { ...empty, reason: 'has-marks', details };
  if (pupilsWithAttendance.size) return { ...empty, reason: 'has-attendance', details };
  return { ok: true, reason: '', details };
}

/** Bangla message for an undo block reason (used by the UI). */
export const UNDO_BLOCK_MESSAGES = Object.freeze({
  'not-promoted': 'এই শ্রেণির প্রমোশন হয়নি, তাই ফেরানোর কিছু নেই।',
  'pupil-missing': 'পরের সাল থেকে কয়েকজন শিক্ষার্থীর তথ্য পাওয়া যাচ্ছে না — প্রমোশন ফেরানো যাবে না।',
  'pupil-relocated': 'পরের সালে কয়েকজন শিক্ষার্থীকে অন্য শ্রেণিতে সরানো হয়েছে — প্রমোশন ফেরানো যাবে না।',
  'pupil-edited': 'পরের সালে কয়েকজন শিক্ষার্থীর তথ্য বদলানো হয়েছে — ফেরালে সেই পরিবর্তন হারিয়ে যাবে, তাই প্রমোশন ফেরানো যাবে না।',
  'new-admission': 'পরের সালে এই শ্রেণিতে নতুন ভর্তি হয়েছে — প্রমোশন ফেরানো যাবে না।',
  'has-marks': 'পরের সালে উত্তীর্ণ শিক্ষার্থীদের নম্বর লেখা হয়ে গেছে — প্রমোশন ফেরানো যাবে না।',
  'has-attendance': 'পরের সালে উত্তীর্ণ শিক্ষার্থীদের উপস্থিতি লেখা হয়ে গেছে — প্রমোশন ফেরানো যাবে না।',
});

/* ------------------------------------------------------------------ *
 * RTDB operations (hierarchical tenant paths only)
 * ------------------------------------------------------------------ */

/** Live subscription to one year's promotion state. */
export function subscribePromotionState(schoolId, year, callback, onStatus) {
  const path = promotionMetaPath(schoolId, year);
  if (!path || typeof callback !== 'function') {
    callback?.(normalizePromotionState(null));
    return () => {};
  }
  return safeSubscribe(path, (value) => callback(normalizePromotionState(value)), {}, onStatus);
}

/** One-shot read of one year's promotion state. */
export async function readPromotionState(schoolId, year) {
  const path = promotionMetaPath(schoolId, year);
  if (!path) return normalizePromotionState(null);
  return normalizePromotionState(await safeRead(path, {}));
}

/**
 * Records one class's promotion as complete. The write is a merge at the
 * promotion node, so other classes' records are never clobbered.
 */
export async function markClassPromotionComplete(schoolId, {
  year = '',
  classId = '',
  toYear = '',
  promoted = 0,
  retained = 0,
  graduated = 0,
  moved = [],
  graduatedIds = [],
  destinations = {},
  auto = false,
  completedBy = '',
  completedByName = '',
} = {}) {
  const path = promotionMetaPath(schoolId, year);
  if (!path || !classId) return { synced: false };
  const record = cleanForCloud({
    completedAt: new Date().toISOString(),
    completedBy,
    completedByName,
    fromYear: normalizeSessionYear(year),
    toYear: normalizeSessionYear(toYear, nextSessionYear(year)),
    promoted: Number(promoted) || 0,
    retained: Number(retained) || 0,
    graduated: Number(graduated) || 0,
    moved: asList(moved).map(toId).filter(Boolean),
    graduatedIds: asList(graduatedIds).map(toId).filter(Boolean),
    destinations: asRecord(destinations),
    auto: auto === true,
  });
  return safeUpdate(path, { classes: { [classId]: record } });
}

/** Marks the January auto-run as done for a year (idempotency across sessions). */
export async function markAutoPromotionDone(schoolId, year, by = 'system') {
  const path = promotionMetaPath(schoolId, year);
  if (!path) return { synced: false };
  return safeUpdate(path, { auto: { at: new Date().toISOString(), by } });
}

/**
 * Builds year-advance decisions for one class from the STORED annual results
 * (published grade: anything but `F` passes; no row/grade ⇒ retain).
 * The app's live path uses `getStudentResult` instead — same rule, live data.
 */
export async function autoPromoteClassDecisions(schoolId, year, classId) {
  const yearKey = normalizeSessionYear(year);
  if (!schoolId || !yearKey || !classId) return { decisions: [], passed: 0, retained: 0 };
  const { students } = await readYearRoster(schoolId, yearKey, classId);
  const resultsTree = asRecord(await safeRead(dbPaths.yearResults(schoolId, yearKey), {}));
  // Results are stored under the DB class key (`class-5`), never the app id (`c5`).
  const classResults = asRecord(resultsTree[toDbClassId(classId)] ?? resultsTree[classId]);
  const finalRows = asRecord(classResults.final ?? classResults.annual ?? {});
  const decisions = buildAutoDecisions(students, (student) => {
    const id = toId(student.studentMasterId || student.id);
    return annualPassOf(finalRows[id]);
  });
  return {
    decisions,
    passed: decisions.filter((item) => item.action === 'promote').length,
    retained: decisions.filter((item) => item.action === 'retain').length,
  };
}

/**
 * Undoes ONE class's promotion — safely, as a single atomic multi-path write.
 *
 * Deletes exactly what the promotion wrote (next-year enrolments + the year's
 * `passedArchive` entries), restores the permanent identity rows to the source
 * year, and removes the completion record. The profile's active year is left
 * exactly as it is, so an undo can never yank the school back a year.
 *
 * @returns {{synced:boolean, reason?:string, message?:string, undone?:object}}
 */
export async function undoClassPromotion(schoolId, {
  year = '',
  nextYear = '',
  classId = '',
} = {}) {
  const fromYear = normalizeSessionYear(year);
  const toYear = normalizeSessionYear(nextYear, fromYear ? nextSessionYear(fromYear) : '');
  const empty = { synced: false, undone: { promoted: 0, retained: 0, graduated: 0 } };
  if (!schoolId || !fromYear || !toYear || toYear === fromYear || !classId) {
    return { ...empty, reason: 'invalid' };
  }
  const state = await readPromotionState(schoolId, fromYear);
  const record = asRecord(state.classes[classId]);
  if (!record.completedAt) return { ...empty, reason: 'not-promoted' };

  const { students: nextYearStudents } = await readYearRoster(schoolId, toYear);
  const nextYearResults = asRecord(await safeRead(dbPaths.yearResults(schoolId, toYear), {}));
  const nextYearAttendance = asRecord(await safeRead(dbPaths.yearAttendance(schoolId, toYear), {}));
  const safety = checkUndoSafety({
    record,
    nextYearStudents,
    nextYearResults,
    nextYearAttendance,
    promotionState: state,
  });
  if (!safety.ok) {
    return {
      ...empty,
      reason: 'undo-blocked',
      blockReason: safety.reason,
      message: UNDO_BLOCK_MESSAGES[safety.reason] ?? 'প্রমোশন ফেরানো যাবে না।',
      details: safety.details,
    };
  }

  const moved = asList(record.moved).map(toId).filter(Boolean);
  const graduatedIds = asList(record.graduatedIds).map(toId).filter(Boolean);
  const destinations = asRecord(record.destinations);
  const byId = new Map();
  asList(nextYearStudents).forEach((student) => {
    const id = toId(student?.studentMasterId || student?.id);
    if (id) byId.set(id, student);
  });

  const toBase = dbPaths.yearStudents(schoolId, toYear).replace(/\/students$/, '');
  const fromBase = dbPaths.yearStudents(schoolId, fromYear).replace(/\/students$/, '');
  const masterBase = dbPaths.studentMaster(schoolId);
  const entries = {};
  let promoted = 0;
  let retained = 0;
  moved.forEach((id) => {
    const row = byId.get(id);
    if (!row) return;
    // Enrolments live under the DB class key (`class-4`), while the merged
    // roster reports the app id (`c4`) — deleting with the app id would
    // silently delete nothing.
    const destClass = toDbClassId(toId(row.classId));
    const section = String(row.section ?? '').trim() || 'ক';
    entries[`${toBase}/students/${destClass}/${section}/${id}`] = null;
    // `destClass` is the DB key (`class-3`); compare in the same vocabulary.
    if (destClass === toDbClassId(classId)) retained += 1;
    else promoted += 1;
    entries[`${masterBase}/${id}`] = cleanForCloud({
      currentClassId: classId,
      academicYear: fromYear,
      overallStatus: 'active',
      graduatedYear: null,
    });
  });
  graduatedIds.forEach((id) => {
    entries[`${fromBase}/passedArchive/${id}`] = null;
    entries[`${fromBase}/passedArchive/years/${fromYear}/${id}`] = null;
    entries[`${masterBase}/${id}`] = cleanForCloud({
      currentClassId: classId,
      academicYear: fromYear,
      overallStatus: 'active',
      graduatedYear: null,
    });
  });
  entries[`${promotionMetaPath(schoolId, fromYear)}/classes/${classId}`] = null;

  const result = await safeMultiPathUpdate(entries);
  if (result?.synced === false) return { ...empty, reason: 'write-failed' };
  return {
    synced: true,
    undone: { promoted, retained, graduated: graduatedIds.length },
  };
}

export default {
  promotionClassIds,
  destinationClassOf,
  promotionMetaPath,
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
  subscribePromotionState,
  readPromotionState,
  markClassPromotionComplete,
  markAutoPromotionDone,
  autoPromoteClassDecisions,
  undoClassPromotion,
};
