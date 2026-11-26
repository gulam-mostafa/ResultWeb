/**
 * Excel import plan (শিক্ষার্থী আমদানি পরিকল্পনা) — PURE.
 *
 * Turns the rows parsed out of a 6-sheet student workbook into a reviewable plan:
 *
 * ```text
 * group (classId + শাখা)
 *   └── row { line, values, status, resolvedRoll, changes, similarity }
 * ```
 *
 * Rules implemented here (the preview modal and the writer both read THIS plan, so
 * what the teacher sees is exactly what gets written):
 *
 *  1. **80% similarity** — an incoming row that scores ≥80 against a stored pupil is
 *     the SAME pupil: the database roll is kept (never the sheet's roll) and the row
 *     becomes an update. The badge names the score.
 *  2. **Roll uniqueness is scoped to `classId::section`** — the same number in another
 *     class or another শাখা is perfectly legal.
 *  3. **A blank roll** (or one already taken by a DIFFERENT pupil) is placed at the end
 *     of the destination bucket, so a new admission never renumbers existing pupils.
 *  4. A remaining clash is reported as `conflict` — the modal shows Warning #1 and, if
 *     the teacher insists, Warning #2 before anything is written.
 */
import { cleanSectionLabel, normalizeRoll, rollBucketKey } from './rollAssignment.js';
import { findBestMatch, SIMILARITY_THRESHOLD } from './studentSimilarity.js';

export const IMPORT_ROW_STATUS = Object.freeze({
  NEW: 'new',
  UPDATE: 'update',
  MATCH: 'match',
  CONFLICT: 'conflict',
});

export const IMPORT_STATUS_LABELS = Object.freeze({
  [IMPORT_ROW_STATUS.NEW]: 'নতুন ভর্তি',
  [IMPORT_ROW_STATUS.UPDATE]: 'তথ্য হালনাগাদ',
  [IMPORT_ROW_STATUS.MATCH]: 'একই শিক্ষার্থী',
  [IMPORT_ROW_STATUS.CONFLICT]: 'রোল দ্বন্দ্ব',
});

/** Fields compared when an existing pupil is updated (order = preview order). */
const COMPARED_KEYS = Object.freeze([
  'name', 'fatherName', 'motherName', 'gender', 'birthCertificateNo',
  'guardianNid', 'fatherPhone', 'motherPhone', 'admissionYear', 'birthDate', 'address',
]);

const asText = (value) => String(value ?? '').trim();

/** `{key: {from, to}}` of the values that actually change on an existing pupil. */
export function diffOf(values = {}, student = {}) {
  const changes = {};
  COMPARED_KEYS.forEach((key) => {
    const next = asText(values[key]);
    if (!next) return; // a blank Excel cell never wipes a stored value
    const previous = asText(key === 'birthCertificateNo'
      ? (student.birthCertificateNo ?? student.birthRegNo)
      : student[key]);
    if (previous && previous !== next) changes[key] = { from: previous, to: next };
  });
  return changes;
}

/** Stored pupils of one class + শাখা bucket (archived rows excluded). */
const rosterOfBucket = (roster, classId, section) => (Array.isArray(roster) ? roster : []).filter(
  (student) => student
    && student.classId !== 'archive'
    && asText(student.classId) === asText(classId)
    && cleanSectionLabel(student.section) === section,
);

/** Highest roll already present in a bucket (0 when empty). */
const highestRollOf = (rows) => rows.reduce((max, student) => Math.max(max, normalizeRoll(student.roll)), 0);

/**
 * Builds the reviewable import plan.
 *
 * @param {object} options
 * @param {Array<{classId:string, line:number, values:object}>} options.rows
 *   parsed rows, in workbook order; `classId` comes from the SHEET, not a column
 * @param {Array<object>} options.roster every stored pupil of the school
 * @returns {{groups:Array<object>, rows:Array<object>, summary:object}}
 */
export function buildImportPlan({ rows = [], roster = [] } = {}) {
  const stored = (Array.isArray(roster) ? roster : []).filter(
    (student) => student && student.classId !== 'archive',
  );
  /** `classId::section` ➔ rolls already claimed by earlier rows of THIS file. */
  const claimed = new Map();
  /** `classId::section` ➔ next free roll (after the highest stored/claimed one). */
  const nextRoll = new Map();
  const bucketState = (classId, section) => {
    const key = rollBucketKey(classId, section);
    if (!nextRoll.has(key)) {
      const rolls = claimed.get(key) ?? [];
      nextRoll.set(
        key,
        Math.max(highestRollOf(rosterOfBucket(stored, classId, section)), ...rolls, 0) + 1,
      );
      claimed.set(key, [...rolls]);
    }
    return key;
  };
  const takeRoll = (key, roll) => {
    const list = claimed.get(key) ?? [];
    if (!list.includes(roll)) claimed.set(key, [...list, roll]);
    nextRoll.set(key, Math.max(nextRoll.get(key) ?? 1, roll + 1));
  };

  const planned = (Array.isArray(rows) ? rows : []).map((entry) => {
    const classId = asText(entry?.classId);
    const section = cleanSectionLabel(entry?.values?.section);
    const key = bucketState(classId, section);
    const values = { ...(entry?.values ?? {}), section };
    const wantedRoll = normalizeRoll(values.roll);
    const base = { line: Number(entry?.line) || 0, classId, section };

    // 1. Same pupil? (≥80 of 100 ➔ keep the DATABASE roll, never the sheet's)
    const match = findBestMatch(values, stored, { threshold: SIMILARITY_THRESHOLD });
    if (match) {
      const roll = normalizeRoll(match.student.roll) || wantedRoll || nextRoll.get(key);
      takeRoll(key, roll);
      return {
        ...base,
        values: { ...values, roll },
        status: IMPORT_ROW_STATUS.MATCH,
        resolvedRoll: roll,
        existing: match.student,
        similarity: match.score,
        changes: diffOf(values, match.student),
        message: `ডাটাবেস রোল বজায় রাখা হয়েছে (${Math.round(match.score)}% মিল)`,
      };
    }

    // 2. A roll already held by a DIFFERENT pupil of the bucket.
    const holder = wantedRoll
      ? rosterOfBucket(stored, classId, section)
        .find((student) => normalizeRoll(student.roll) === wantedRoll)
      : null;
    if (holder) {
      return {
        ...base,
        values: { ...values, roll: wantedRoll },
        status: IMPORT_ROW_STATUS.CONFLICT,
        resolvedRoll: wantedRoll,
        existing: holder,
        similarity: 0,
        changes: {},
        message: `“${section}” শাখায় ${wantedRoll} রোল ইতিমধ্যে ${holder.name ?? 'অন্য শিক্ষার্থী'} এর নামে আছে — মিল ৮০% এর কম`,
      };
    }

    // 3. …or already claimed by an earlier row of this same file.
    const claimedRolls = claimed.get(key) ?? [];
    if (wantedRoll && claimedRolls.includes(wantedRoll)) {
      return {
        ...base,
        values: { ...values, roll: wantedRoll },
        status: IMPORT_ROW_STATUS.CONFLICT,
        resolvedRoll: wantedRoll,
        existing: null,
        similarity: 0,
        changes: {},
        message: `এই ফাইলেরই আরেকটি সারিতে ${wantedRoll} রোল ব্যবহৃত হয়েছে (“${section}” শাখা)`,
      };
    }

    // 4. A free/blank roll: keep a free number, otherwise take the next one at the end.
    const roll = wantedRoll && !claimedRolls.includes(wantedRoll) ? wantedRoll : nextRoll.get(key);
    takeRoll(key, roll);
    return {
      ...base,
      values: { ...values, roll },
      status: IMPORT_ROW_STATUS.NEW,
      resolvedRoll: roll,
      existing: null,
      similarity: 0,
      changes: {},
      message: wantedRoll ? '' : `রোল ফাঁকা ছিল — ${roll} নম্বর দেওয়া হয়েছে`,
    };
  });

  // Group by class ➔ section so the preview can tab through them.
  const byClass = new Map();
  planned.forEach((row) => {
    if (!byClass.has(row.classId)) byClass.set(row.classId, new Map());
    const sections = byClass.get(row.classId);
    if (!sections.has(row.section)) sections.set(row.section, []);
    sections.get(row.section).push(row);
  });

  const groups = [...byClass.entries()].map(([classId, sections]) => ({
    classId,
    sections: [...sections.entries()].map(([section, sectionRows]) => ({ section, rows: sectionRows })),
    rows: [...sections.values()].flat(),
  }));

  const summary = planned.reduce((acc, row) => {
    acc.total += 1;
    acc[row.status] = (acc[row.status] ?? 0) + 1;
    if (row.status === IMPORT_ROW_STATUS.CONFLICT) acc.hasConflict = true;
    return acc;
  }, {
    total: 0, new: 0, update: 0, match: 0, conflict: 0, hasConflict: false,
  });

  return { groups, rows: planned, summary };
}

export default { IMPORT_ROW_STATUS, IMPORT_STATUS_LABELS, buildImportPlan, diffOf };
