/**
 * Result calculation engine — config-driven, per school/class.
 *
 * Everything in this module is PURE (no React, no Firebase) so the grid, the Excel
 * export/import and the promotion flow all derive identical numbers from the same
 * inputs:
 *
 *   stored marks (flat map) + class configuration (subjects / full marks / split /
 *   pass mark / annual weights) ➔ per-subject and per-student result objects.
 *
 * Stored marks keep the app-wide flat shape:
 * ```js
 * marks[studentId][subjectId][termId]            = subject TOTAL (legacy + plain)
 * marks[studentId][`${subjectId}:formative`][t]  = গাঠনিক component
 * marks[studentId][`${subjectId}:summative`][t]  = সামষ্টিক component
 * ```
 * A split subject whose components are missing but whose total exists (data written
 * before the split existed) still yields a correct total — the legacy row is never
 * thrown away.
 */

import { GRADE_SCALE, PASS_MARK } from './constants.js';
import {
  RESULT_TERM_IDS,
  configEntryFields,
  entryFieldKey,
  normalizeResultConfig,
  normalizedWeightPercent,
  round2,
} from './resultConfig.js';

/** Numeric mark or `null`; blanks and junk count as "not entered". */
export function toMark(value) {
  if (value === null || value === undefined || value === '') return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.max(0, numeric) : null;
}

/** Grade band of a percentage score (the board's 5.00 scale). */
export function gradeOfPercent(percent) {
  const value = toMark(percent);
  if (value === null) return { grade: '—', point: 0, label: 'মূল্যায়ন হয়নি' };
  const band = GRADE_SCALE.find((item) => value >= item.min) ?? GRADE_SCALE[GRADE_SCALE.length - 1];
  return { grade: band.grade, point: band.point, label: band.label };
}

/** Reads one stored cell (`marks[studentId][key][termId]`). */
const cell = (studentMarks, key, termId) => toMark(studentMarks?.[key]?.[termId]);

/** The stored value of one entry field (`subjectId` or `subjectId:component`). */
export const entryValue = (studentMarks, fieldKey, termId) => cell(studentMarks, fieldKey, termId);

/**
 * One subject's marks inside ONE term.
 * A blank component counts as `0` while the subject stays "entered".
 *
 * `passMark` is expressed out of 100 (the board's convention) and scaled to the
 * subject's own full marks, so a custom ৭০-mark subject still uses the same 33% bar.
 */
export function subjectTermEntry(subject, studentMarks, termId, passMark = PASS_MARK) {
  const fullMarks = Number(subject?.fullMarks) || 100;
  const formative = subject?.split ? cell(studentMarks, entryFieldKey(subject.id, 'formative'), termId) : null;
  const summative = subject?.split ? cell(studentMarks, entryFieldKey(subject.id, 'summative'), termId) : null;
  const plain = cell(studentMarks, entryFieldKey(subject.id, 'total'), termId);

  let total = 0;
  let hasAnyMark = false;
  if (subject?.split) {
    if (formative !== null || summative !== null) {
      total = round2((formative ?? 0) + (summative ?? 0));
      hasAnyMark = true;
    } else if (plain !== null) {
      total = round2(plain);
      hasAnyMark = true;
    }
  } else if (plain !== null) {
    total = round2(plain);
    hasAnyMark = true;
  }

  const percent = hasAnyMark && fullMarks > 0 ? round2((total / fullMarks) * 100) : 0;
  const gradeInfo = gradeOfPercent(hasAnyMark ? percent : null);
  return {
    formative,
    summative,
    total: hasAnyMark ? total : 0,
    hasAnyMark,
    fullMarks,
    percent,
    isPass: hasAnyMark && percent >= Number(passMark),
    grade: hasAnyMark ? gradeInfo.grade : '—',
    point: hasAnyMark ? gradeInfo.point : 0,
    gradeLabel: gradeInfo.label,
  };
}

/**
 * Aggregates subject entries into a whole-student result (GPA + grade + totals).
 *
 * `blankCountsAsZero` (the default, used by every single-term tab) implements the rule
 * that a blank/empty mark input counts as `0`: as soon as ONE mark exists for a pupil,
 * EVERY subject of the class counts and a blank subject fails the pass check.
 *
 * The consolidated বার্ষিক ফলাফল passes `false`: a term that has not been evaluated yet
 * must not drag a pupil down mid-year, so only subjects with at least one entered term
 * are counted there (blank terms still contribute 0 to the weighted percentage).
 */
function assembleStudentResult({ subjects, term, goldenMark = 80, blankCountsAsZero = true, fullMarksFactor = 1 }) {
  const hasAnyMark = subjects.some((subject) => subject.hasAnyMark);
  const counted = blankCountsAsZero ? subjects : subjects.filter((subject) => subject.hasAnyMark);
  const totalMarks = counted.reduce((sum, subject) => sum + (Number(subject.total) || 0), 0);
  // A half-evaluated year is scaled to the weighting that has actually been entered, so
  // the reported percentage (and therefore pass/fail) is never penalised by a missing term.
  const totalFullMarks = counted.reduce((sum, subject) => sum + (Number(subject.fullMarks) || 0), 0)
    * (Number(fullMarksFactor) > 0 ? Number(fullMarksFactor) : 1);
  const failed = hasAnyMark ? counted.filter((subject) => !subject.isPass) : [];
  const percentage = totalFullMarks > 0 ? round2((totalMarks / totalFullMarks) * 100) : 0;
  // Board rule: a single failed subject ⇒ GPA ০.০০ and grade F; the total marks
  // stay EXACTLY as summed (never zeroed).
  const rawGpa = counted.length
    ? counted.reduce((sum, subject) => sum + (Number(subject.point) || 0), 0) / counted.length
    : 0;
  const gradeInfo = failed.length
    ? { grade: 'F', point: 0, label: 'অকৃতকার্য' }
    : gradeOfPercent(hasAnyMark ? percentage : null);
  return {
    term,
    subjects,
    totalMarks: round2(totalMarks),
    totalFullMarks: round2(totalFullMarks),
    percentage,
    gpa: hasAnyMark ? (failed.length ? 0 : round2(rawGpa)) : null,
    grade: hasAnyMark ? gradeInfo.grade : '—',
    gradeLabel: hasAnyMark ? gradeInfo.label : 'মূল্যায়ন হয়নি',
    failedSubjects: failed.map((subject) => subject.name),
    failCount: failed.length,
    passedSubjectCount: counted.length - failed.length,
    enteredSubjectCount: subjects.filter((subject) => subject.hasAnyMark).length,
    subjectCount: subjects.length,
    hasAnyMark,
    isPass: hasAnyMark && failed.length === 0,
    // Golden Badge (গোল্ডেন ব্যাজ): every subject at/above the golden mark.
    isGolden: hasAnyMark && subjects.every((subject) => subject.hasAnyMark && subject.percent >= goldenMark),
  };
}

/**
 * One term's result for one pupil (১ম / ২য় প্রান্তিক / বার্ষিক মূল্যায়ন).
 * The shape matches what the result modal, the marksheet and the promotion modal
 * already consume: `result.subjects[i].mark / .total / .grade`.
 */
export function computeTermResultForConfig(studentMarks = {}, config, termId) {
  const safeConfig = normalizeResultConfig(config, config?.classId);
  const passMark = safeConfig.passMark;
  const subjects = safeConfig.subjects.map((subject) => {
    const entry = subjectTermEntry(subject, studentMarks, termId, passMark);
    return {
      id: subject.id,
      name: subject.name,
      code: subject.id.toUpperCase().slice(0, 3),
      color: subject.color,
      split: subject.split,
      fullMarks: subject.fullMarks,
      formativeFull: subject.formativeFull,
      summativeFull: subject.summativeFull,
      formative: entry.formative,
      summative: entry.summative,
      mark: entry.hasAnyMark ? entry.total : null,
      total: entry.hasAnyMark ? entry.total : null,
      percent: entry.percent,
      grade: entry.grade,
      point: entry.point,
      gradeLabel: entry.gradeLabel,
      isPass: entry.isPass,
      hasAnyMark: entry.hasAnyMark,
      isEnteredFully: entry.hasAnyMark,
      isGolden: entry.hasAnyMark && entry.percent >= safeConfig.goldenMark,
      marks: { [termId]: entry.hasAnyMark ? entry.total : null },
    };
  });
  return {
    ...assembleStudentResult({ subjects, term: termId, goldenMark: safeConfig.goldenMark }),
    passMark,
    goldenMark: safeConfig.goldenMark,
  };
}

/**
 * The annual CONSOLIDATED result (বার্ষিক ফলাফল): every subject is the weighted sum
 * of the three terms, using the school's own percentages (default ১৫% + ১৫% + ৭০%).
 *
 * A term without marks contributes `0` — it is NEVER silently re-normalised, so
 * `১০০` in the ১ম প্রান্তিক at ১৫% is `১৫`, not `১০০`. `isComplete` tells the caller
 * whether all three terms were entered, which is what the UI uses to show
 * "সব প্রান্তিকের নম্বর দেওয়া হয়নি" instead of a harsh F.
 */
export function computeConsolidatedResult(studentMarks = {}, config) {
  const safeConfig = normalizeResultConfig(config, config?.classId);
  const weights = normalizedWeightPercent(safeConfig.weights);
  const passMark = safeConfig.passMark;

  const subjects = safeConfig.subjects.map((subject) => {
    const contributions = RESULT_TERM_IDS.map((termId) => {
      const entry = subjectTermEntry(subject, studentMarks, termId, passMark);
      return { termId, entry, weight: weights[termId] ?? 0 };
    });
    const hasAnyMark = contributions.some((item) => item.entry.hasAnyMark);
    const weightedPercent = contributions.reduce(
      (sum, item) => sum + (item.entry.hasAnyMark ? item.entry.percent * (item.weight / 100) : 0),
      0,
    );
    const percent = hasAnyMark ? round2(weightedPercent) : 0;
    // Weights of the terms that actually hold marks — reported for completeness only.
    const availableWeight = contributions.reduce(
      (sum, item) => sum + (item.entry.hasAnyMark ? item.weight : 0),
      0,
    );
    // No re-normalisation: the weighted percent IS the score, missing terms count 0.
    const scoredPercent = percent;
    const fullMarks = subject.fullMarks;
    const total = hasAnyMark ? round2((percent / 100) * fullMarks) : 0;
    const gradeInfo = gradeOfPercent(hasAnyMark ? scoredPercent : null);
    return {
      id: subject.id,
      name: subject.name,
      code: subject.id.toUpperCase().slice(0, 3),
      color: subject.color,
      split: subject.split,
      fullMarks,
      formativeFull: subject.formativeFull,
      summativeFull: subject.summativeFull,
      mark: hasAnyMark ? total : null,
      total: hasAnyMark ? total : null,
      percent,
      scoredPercent,
      availableWeight,
      grade: hasAnyMark ? gradeInfo.grade : '—',
      point: hasAnyMark ? gradeInfo.point : 0,
      gradeLabel: gradeInfo.label,
      isPass: hasAnyMark && scoredPercent >= passMark,
      hasAnyMark,
      isEnteredFully: contributions.every((item) => item.entry.hasAnyMark),
      isGolden: hasAnyMark && scoredPercent >= safeConfig.goldenMark,
      marks: Object.fromEntries(contributions.map((item) => [
        item.termId,
        item.entry.hasAnyMark ? item.entry.total : null,
      ])),
      contributions: contributions.map((item) => ({
        termId: item.termId,
        weight: item.weight,
        percent: item.entry.percent,
        mark: item.entry.total,
        hasMark: item.entry.hasAnyMark,
        contribution: item.entry.hasAnyMark ? round2(item.entry.percent * (item.weight / 100)) : 0,
      })),
    };
  });

  // Terms that no subject has a mark for — the বার্ষিক ফলাফল screen flags them in Bangla.
  const termHasMarks = RESULT_TERM_IDS.map((termId) => (
    subjects.some((subject) => subject.contributions.some((item) => item.termId === termId && item.hasMark))
  ));
  const missingTerms = RESULT_TERM_IDS.filter((termId, index) => !termHasMarks[index]);
  const evaluatedWeight = subjects.reduce((max, subject) => Math.max(max, subject.availableWeight), 0);
  return {
    ...assembleStudentResult({
      subjects,
      term: 'consolidated',
      goldenMark: safeConfig.goldenMark,
      blankCountsAsZero: false,
      // Missing terms count as 0 — no scaling of the remaining weighting.
      fullMarksFactor: 1,
    }),
    weights,
    passMark,
    goldenMark: safeConfig.goldenMark,
    evaluatedWeight: round2(evaluatedWeight),
    isComplete: missingTerms.length === 0,
    missingTerms,
    goldenCount: subjects.filter((subject) => subject.isGolden).length,
  };
}

/**
 * Merit ranking (মেধাক্রম) of one class.
 *
 * Passing pupils first — total marks desc, then GPA desc, then current roll — and
 * the failed / not-evaluated pupils after them. `newRoll` is only assigned when the
 * caller says the consolidated result is what is being ranked (`assignNewRoll`).
 *
 * @param {Array<{studentId:string, student?:object, result:object}>} rows
 * @param {{assignNewRoll?:boolean}} options
 */
export function rankClassRows(rows = [], { assignNewRoll = false } = {}) {
  const list = (Array.isArray(rows) ? rows : [])
    .filter(Boolean)
    .map((row) => ({
      ...row,
      roll: Number(row?.student?.roll) || 0,
      totalMarks: Number(row?.result?.totalMarks) || 0,
      gpa: Number(row?.result?.gpa) || 0,
      hasAnyMark: row?.result?.hasAnyMark === true,
      isPass: row?.result?.isPass === true,
    }));

  const byMerit = (a, b) => (
    b.totalMarks - a.totalMarks
    || b.gpa - a.gpa
    || (a.roll || Number.MAX_SAFE_INTEGER) - (b.roll || Number.MAX_SAFE_INTEGER)
    || String(a.student?.name ?? '').localeCompare(String(b.student?.name ?? ''), 'bn')
  );

  const evaluated = list.filter((row) => row.hasAnyMark);
  const passing = evaluated.filter((row) => row.isPass).sort(byMerit);
  const failing = evaluated.filter((row) => !row.isPass).sort(byMerit);
  const missing = list
    .filter((row) => !row.hasAnyMark)
    .sort((a, b) => (a.roll || Number.MAX_SAFE_INTEGER) - (b.roll || Number.MAX_SAFE_INTEGER));

  const ordered = [...passing, ...failing, ...missing];
  // Merit positions are SHARED on a tie (`1, 1, 3`), exactly like
  // `gradingCalculator.computeMeritRanking`, so every modal and printed marksheet
  // reports the same figure for the same pupil. নতুন রোল stays unique (১, ২, ৩…) —
  // two pupils may share a merit position but never a roll.
  let lastKey = null;
  let lastPosition = 0;
  let nextRoll = ordered.filter((row) => row.hasAnyMark).length + 1;
  return ordered.map((row, index) => {
    const tieKey = row.hasAnyMark ? `${row.totalMarks}|${row.gpa}` : `missing|${index}`;
    const position = tieKey === lastKey ? lastPosition : index + 1;
    lastKey = tieKey;
    lastPosition = position;
    return {
      ...row,
      position,
      isEvaluated: row.hasAnyMark,
      newRoll: assignNewRoll ? (row.hasAnyMark ? index + 1 : nextRoll++) : null,
    };
  });
}

/** Every entry field of a configuration (the grid + the Excel template read this). */
export const configFields = (config) => configEntryFields(config);

export default {
  toMark,
  gradeOfPercent,
  subjectTermEntry,
  entryValue,
  computeTermResultForConfig,
  computeConsolidatedResult,
  rankClassRows,
  configFields,
};

