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
 *     auto: boolean,                       // true when the January auto-run did it
 *     unlockedAt, unlockedBy, unlockedByName, unlockedByEmail,
 *     reopenedAt, reopenedBy, reopenedByName
 *   } },
 *   unlocks: { [classId]: { [unlockId]: { at, by, uid, name, email } } },
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
import { readYearRoster, toAppClassId, toDbClassId } from './studentService.js';

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

/** Normalises a raw promotion node into `{ classes, auto, unlocks }`. */
export function normalizePromotionState(raw) {
  const source = asRecord(raw);
  const classes = {};
  Object.entries(asRecord(source.classes)).forEach(([classId, entry]) => {
    const record = asRecord(entry);
    classes[classId] = {
      completedAt: record.completedAt ?? '',
      completedBy: record.completedBy ?? '',
      completedByName: record.completedByName ?? '',
      completedByEmail: record.completedByEmail ?? '',
      fromYear: normalizeSessionYear(record.fromYear),
      toYear: normalizeSessionYear(record.toYear),
      promoted: Number(record.promoted) || 0,
      retained: Number(record.retained) || 0,
      graduated: Number(record.graduated) || 0,
      moved: asList(record.moved).map(toId).filter(Boolean),
      graduatedIds: asList(record.graduatedIds).map(toId).filter(Boolean),
      destinations: asRecord(record.destinations),
      auto: record.auto === true,
      unlockedAt: record.unlockedAt ?? '',
      unlockedBy: record.unlockedBy ?? '',
      unlockedByName: record.unlockedByName ?? '',
      unlockedByEmail: record.unlockedByEmail ?? '',
    };
  });
  /**
   * Unlock audit trail, newest first per class:
   * `{ [classId]: [{ at, by, uid, name, email }] }`.
   *
   * It lives NEXT TO `classes` on purpose: an unlock deletes the class's
   * completion record, so the audit can never live inside it — otherwise it
   * would be erased by the very action it records.
   */
  const unlocks = {};
  Object.entries(asRecord(source.unlocks)).forEach(([classId, entries]) => {
    const list = Object.values(asRecord(entries))
      .map((entry) => {
        const item = asRecord(entry);
        return {
          at: item.at ?? '',
          by: item.by ?? '',
          uid: item.uid ?? '',
          name: item.name ?? '',
          email: item.email ?? '',
        };
      })
      .filter((item) => Boolean(item.at))
      .sort((a, b) => String(b.at).localeCompare(String(a.at)));
    if (list.length) unlocks[classId] = list;
  });
  return {
    classes,
    unlocks,
    auto: asRecord(source.auto).at ? { at: source.auto.at, by: source.auto.by ?? '' } : null,
  };
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
 * The class the promotion modal opens on: the FIRST class that is not promoted
 * yet, in school order (pre, c1 … c5). When every class is done it falls back to
 * the LAST class, so the dialog always opens on something the teacher can act on.
 *
 * `counts` is optional: without it "not promoted" means "no completion record"
 * (an empty, unpromoted class is still the first one the teacher reaches).
 */
export function defaultPromotionClassId(state, counts = null) {
  const ids = promotionClassIds();
  const hasCounts = counts && typeof counts === 'object';
  const firstPending = ids.find((classId) => {
    if (isClassPromotionComplete(state, classId)) return false;
    if (!hasCounts) return true;
    return (Number(counts[classId]) || 0) > 0;
  });
  return firstPending ?? ids[ids.length - 1];
}

/**
 * One row per class for the modal's status list:
 * `[{ classId, name, complete, pending, students }]`, in school order.
 * A class with pupils but no completion record is `pending`; a class with no
 * pupils counts as done (`complete` is only the RECORDED completion, which is
 * what the UI paints as "সম্পূর্ণ").
 */
export function classPromotionStatuses(state, students = []) {
  const counts = classStudentCounts(students);
  return promotionClassIds().map((classId) => {
    const level = CLASS_LEVELS.find((item) => item.id === classId);
    const complete = isClassPromotionComplete(state, classId);
    return {
      classId,
      name: level?.name ?? classId,
      complete,
      pending: !complete && (Number(counts[classId]) || 0) > 0,
      students: Number(counts[classId]) || 0,
    };
  });
}

/** Unlock audit of one class, newest first (`[]` when it was never unlocked). */
export const unlockHistoryOf = (state, classId) => asList(asRecord(state?.unlocks)[classId]);

/**
 * `true` when this class of the VIEWED year must be edited read-only: the whole
 * year is a past year, or this class's promotion is recorded as complete in that
 * year's log. A promoted class never reopens by itself — only the guarded
 * unlock/undo removes the record.
 */
export function isClassReadOnly({ viewYear, activeYear, state, classId } = {}) {
  if (!classId || classId === 'archive') return false;
  if (isYearReadOnly(viewYear, activeYear)) return true;
  return isClassPromotionComplete(state, classId);
}

/**
 * The year every class of `state` was promoted into (`''` when nothing is
 * recorded). Used to decide that a finished year now moves the school on.
 */
export function promotionTargetYear(state) {
  const targets = completedClassIds(state)
    .map((classId) => normalizeSessionYear(asRecord(state?.classes)[classId]?.toYear))
    .filter(Boolean)
    .sort((a, b) => Number(b) - Number(a));
  return targets[0] ?? '';
}

/**
 * Auto-activation decision after ONE class was promoted — pure, so the rule is
 * testable without a database.
 *
 * - the school's active year may only move when the promoted class belongs to
 *   the ACTIVE year (`promoting a future year early never skips it`);
 * - it moves only when EVERY class of that year is complete or empty;
 * - it moves to the next year the promotion recorded (never a hard-coded year).
 *
 * @param {{sourceYear?:string, activeYear?:string, state?:object,
 *   counts?:object, students?:Array<object>}} args
 *   `counts` ({classId: n}) wins; `students` is accepted for convenience.
 * @returns {{activate:boolean, targetYear:string, reason:string}}
 */
export function activationAfterPromotion({ sourceYear, activeYear, state, counts = null, students = [] } = {}) {
  const source = normalizeSessionYear(sourceYear);
  const active = normalizeSessionYear(activeYear);
  if (!source || !active) return { activate: false, targetYear: '', reason: 'invalid-year' };
  if (source !== active) return { activate: false, targetYear: '', reason: 'not-active-year' };
  const classCounts = counts && typeof counts === 'object' ? counts : classStudentCounts(students);
  if (!isPromotionCompleteForYear(state, classCounts)) {
    return { activate: false, targetYear: '', reason: 'classes-pending' };
  }
  const target = promotionTargetYear(state) || nextSessionYear(source);
  if (!target || target === source) return { activate: false, targetYear: '', reason: 'invalid-target' };
  return { activate: true, targetYear: target, reason: 'year-complete' };
}

/**
 * Locked-view CSS class for a finished year or a finished class.
 * The class itself is only a marker — the monochrome treatment lives in
 * `src/index.css` (`.locked-view`), so a locked year and a locked class look
 * exactly the same: black text, no colour anywhere (নিষ্ক্রিয়).
 */
export const lockedViewClass = (isLocked) => (isLocked ? 'locked-view' : '');

/**
 * `true` only for a PAST year: a viewed year older than the school's active
 * year is locked (read-only). The active year itself and any FUTURE year are
 * open — the next year is where new work continues, so it must never be
 * locked. Years compare as NUMBERS after `normalizeSessionYear` (Bangla
 * digits become ASCII first), never as strings. An unparseable year never
 * locks anything: the safe default is editable.
 */
export function isYearReadOnly(viewYear, activeYear) {
  const viewed = Number(normalizeSessionYear(viewYear));
  const active = Number(normalizeSessionYear(activeYear));
  if (!viewed || !active) return false;
  return viewed < active;
}

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
  completedByEmail = '',
} = {}) {
  const path = promotionMetaPath(schoolId, year);
  if (!path || !classId) return { synced: false };
  const record = cleanForCloud({
    completedAt: new Date().toISOString(),
    completedBy,
    completedByName,
    completedByEmail,
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
  // RTDB `update()` replaces the whole `classes` node with the patch value, so
  // writing `{ classes: { [classId]: record } }` DELETED every other class's
  // completion record — each promotion wiped the earlier "সম্পূর্ণ" badges.
  // The slash-key writes only this class's leaf, so records accumulate.
  return safeUpdate(path, { [`classes/${classId}`]: record });
}

/**
 * Repairs completion records lost by the old write bug: `markClassPromotionComplete`
 * used to write `{ classes: { [classId]: record } }` through `safeUpdate`, and an
 * RTDB `update()` replaces the WHOLE `classes` node with that one class — so every
 * promotion silently deleted the earlier classes' records and their "সম্পূর্ণ"
 * badges flipped back to "বাকি". (The write now uses the slash-key
 * `classes/{classId}`, so new promotions accumulate correctly.)
 *
 * A lost record is rebuilt from the NEXT year's roster: a pupil sitting there with
 * `promotedFromYear === year` and `promotedFromClass === classId` arrived through
 * that class's promotion. Class-5 leavers are rebuilt from the year's
 * `passedArchive` instead (they never enrol next year). Classes that already have
 * a record are never touched, so the repair is idempotent and safe to run after
 * every promotion.
 */
export async function backfillMissingPromotionRecords(schoolId, {
  year = '',
  toYear = '',
  by = null,
} = {}) {
  const fromYear = normalizeSessionYear(year);
  const targetYear = normalizeSessionYear(toYear, fromYear ? nextSessionYear(fromYear) : '');
  if (!schoolId || !fromYear || !targetYear || targetYear === fromYear) {
    return { synced: false, repaired: [] };
  }
  const state = await readPromotionState(schoolId, fromYear);
  const { students: nextYearStudents, archive } = await readYearRoster(schoolId, targetYear);
  const orderOf = (classId) => CLASS_LEVELS.findIndex((level) => level.id === classId);
  // Pupils the source year already moved into the target year, grouped by the
  // class they were promoted FROM (stored as DB keys — normalised to app ids).
  const bySourceClass = new Map();
  asList(nextYearStudents).forEach((student) => {
    if (!student?.promotedAt) return;
    if (normalizeSessionYear(student?.promotedFromYear) !== fromYear) return;
    const sourceClass = toAppClassId(student?.promotedFromClass || student?.previousClassId || '');
    if (!sourceClass) return;
    const list = bySourceClass.get(sourceClass) ?? [];
    list.push(student);
    bySourceClass.set(sourceClass, list);
  });
  // Class-5 leavers: they never enrol next year, they sit in passedArchive.
  const graduatedByClass = new Map();
  asList(archive).forEach((row) => {
    if (normalizeSessionYear(row?.passedYear) !== fromYear) return;
    const sourceClass = toAppClassId(row?.archivedFromClass || '');
    if (!sourceClass) return;
    const list = graduatedByClass.get(sourceClass) ?? [];
    list.push(row);
    graduatedByClass.set(sourceClass, list);
  });
  const repaired = [];
  const classes = new Set([...bySourceClass.keys(), ...graduatedByClass.keys()]);
  for (const classId of classes) {
    if (asRecord(state.classes[classId]).completedAt) continue;
    const movedRows = bySourceClass.get(classId) ?? [];
    const graduatedRows = graduatedByClass.get(classId) ?? [];
    if (movedRows.length === 0 && graduatedRows.length === 0) continue;
    const moved = [];
    const destinations = {};
    let promoted = 0;
    let retained = 0;
    const sourceOrder = orderOf(classId);
    movedRows.forEach((student) => {
      const id = toId(student?.studentMasterId || student?.id);
      const destClass = student?.classId;
      if (!id || !destClass) return;
      moved.push(id);
      destinations[id] = destClass;
      const destOrder = orderOf(destClass);
      if (destOrder === sourceOrder) retained += 1;
      else if (destOrder > sourceOrder) promoted += 1;
      // A demoted pupil (destOrder < sourceOrder) is in `moved` but counts in
      // neither `promoted` nor `retained` — same as the live path.
    });
    const graduatedIds = graduatedRows
      .map((row) => toId(row?.studentMasterId || row?.id))
      .filter(Boolean);
    const result = await markClassPromotionComplete(schoolId, {
      year: fromYear,
      classId,
      toYear: targetYear,
      promoted,
      retained,
      graduated: graduatedIds.length,
      moved,
      graduatedIds,
      destinations,
      auto: false,
      completedBy: by?.uid ?? '',
      completedByName: by?.name ?? '',
      completedByEmail: by?.email ?? '',
    });
    if (result?.synced !== false) repaired.push(classId);
  }
  return { synced: true, repaired };
}


/** RTDB-safe unique key for one audit row (no `.`/`:`/`$`/`#`/`[`/`]`/`/`). */
const auditKey = () => `u${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

/**
 * Records WHO unlocked (= undid) one class's promotion and WHEN.
 *
 * Stored at `sessions/{year}/meta/promotion/unlocks/{classId}/{key}` — a sibling
 * of `classes`, because the undo deletes the class's completion record and an
 * audit living inside it would be erased by the very action it records.
 */
export async function recordPromotionUnlock(schoolId, {
  year = '',
  classId = '',
  actor = null,
  mode = 'unlock',
  message = '',
} = {}) {
  const path = promotionMetaPath(schoolId, year);
  if (!path || !classId) return { synced: false };
  const record = cleanForCloud({
    at: new Date().toISOString(),
    uid: actor?.uid ?? '',
    name: actor?.name ?? '',
    email: actor?.email ?? '',
    by: actor?.role ?? '',
    mode: mode === 'undo' ? 'undo' : 'unlock',
    message: String(message ?? ''),
    classId,
    year: normalizeSessionYear(year),
  });
  // Slash-key, same reason as markClassPromotionComplete: a nested object here
  // would replace the whole `unlocks` node and erase other classes' audit rows.
  const key = auditKey();
  return safeUpdate(`${path}/unlocks`, { [`${classId}/${key}`]: record });
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
 * The undo is ALSO the "আনলক করুন" (unlock) path: same guards, same write. When
 * `actor` is supplied the action is recorded in
 * `sessions/{year}/meta/promotion/unlocks/{classId}` (who: name + email + uid,
 * and when), so every unlock is auditable and the UI can say
 * "আনলক করেছেন: <name> • <date>".
 *
 * @returns {{synced:boolean, reason?:string, message?:string, undone?:object}}
 */
export async function undoClassPromotion(schoolId, {
  year = '',
  nextYear = '',
  classId = '',
  actor = null,
  mode = 'unlock',
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
  /**
   * Record the unlock (who + when) NEXT TO the deleted completion record. A
   * failed audit write is not fatal — the promotion really was undone — but it
   * is reported so the caller can say the class reopened without its audit row.
   */
  let audit = null;
  if (actor) {
    const auditResult = await recordPromotionUnlock(schoolId, {
      year: fromYear,
      classId,
      actor,
      mode,
      message: mode === 'undo' ? 'প্রমোশন ফেরানো হয়েছে' : 'শ্রেণি আনলক করা হয়েছে',
    });
    audit = { synced: auditResult?.synced !== false };
  }
  return {
    synced: true,
    audit,
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
  subscribePromotionState,
  readPromotionState,
  markClassPromotionComplete,
  recordPromotionUnlock,
  markAutoPromotionDone,
  autoPromoteClassDecisions,
  undoClassPromotion,
};
