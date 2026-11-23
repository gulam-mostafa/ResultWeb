/**
 * Grading & result computation engine.
 *
 * Every calculation the platform performs on marks lives here as a pure function.
 * Pure functions keep the React layer thin and make the business rules trivially
 * unit-testable and portable to a future backend / Firebase Cloud Function.
 */

import {
  GRADE_SCALE,
  PASS_MARK,
  SUBJECTS,
  SUBJECT_IDS,
  TERMS,
  TERM_IDS,
  FULL_MARKS_PER_SUBJECT,
} from './constants.js';
import { toEnglishNumber } from './banglaNumberFormatter.js';

/* ------------------------------------------------------------------ *
 * 1. Sanitising
 * ------------------------------------------------------------------ */

/** Coerces any user/AI input into a valid mark between 0 and 100, or null. */
export function sanitizeMark(value) {
  if (value === null || value === undefined || value === '') return null;
  const numeric = Number(toEnglishNumber(value));
  if (!Number.isFinite(numeric)) return null;
  return Math.min(FULL_MARKS_PER_SUBJECT, Math.max(0, numeric));
}

/** Reads a nested mark safely: getMark(marks, 'bangla', 'term1'). */
export function getMark(marks, subjectId, termId) {
  const subject = marks?.[subjectId];
  if (!subject) return null;
  return sanitizeMark(subject[termId]);
}

/* ------------------------------------------------------------------ *
 * 2. Grade lookup
 * ------------------------------------------------------------------ */

/**
 * Maps a weighted score to its board grade.
 * @param {number|null} score
 * @returns {{grade:string, point:number, label:string, min:number, max:number}}
 */
export function gradeForScore(score) {
  const value = sanitizeMark(score);
  if (value === null) {
    return { grade: '—', point: 0, label: 'মূল্যায়ন হয়নি', min: 0, max: 0 };
  }
  // GRADE_SCALE is ordered high ➔ low, so the first band whose lower bound is
  // satisfied is authoritative. Threshold matching (instead of a min/max range
  // check) keeps decimal scores such as 69.70 from falling through the gaps.
  const matched = GRADE_SCALE.find((band) => value >= band.min);
  return matched ?? GRADE_SCALE[GRADE_SCALE.length - 1];
}

export const isPassingMark = (value) => {
  const mark = sanitizeMark(value);
  return mark !== null && mark >= PASS_MARK;
};

export function round(value, decimals = 2) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  const factor = 10 ** decimals;
  return Math.round((numeric + Number.EPSILON) * factor) / factor;
}

/* ------------------------------------------------------------------ *
 * 3. Weighted subject total (১৫% + ১৫% + ৭০%, the default annual weighting)
 * ------------------------------------------------------------------ */

/**
 * Computes the weighted annual total for one subject.
 * Un-entered terms are treated as 0 so partial entry never breaks the UI.
 */
export function computeWeightedSubjectTotal(subjectMarks) {
  const breakdown = TERMS.map((term) => {
    const mark = sanitizeMark(subjectMarks?.[term.id]);
    const contribution = mark === null ? 0 : mark * term.weight;
    return {
      termId: term.id,
      termName: term.name,
      weight: term.weight,
      weightLabel: term.weightLabel,
      mark,
      contribution: round(contribution, 2),
    };
  });

  const hasAnyMark = breakdown.some((entry) => entry.mark !== null);
  const total = round(
    breakdown.reduce((sum, entry) => sum + entry.contribution, 0),
    2,
  );
  const gradeInfo = gradeForScore(hasAnyMark ? total : null);

  return {
    breakdown,
    total: hasAnyMark ? total : null,
    hasAnyMark,
    grade: gradeInfo.grade,
    point: gradeInfo.point,
    gradeLabel: gradeInfo.label,
    isPass: hasAnyMark ? total >= PASS_MARK : false,
    isEnteredFully: breakdown.every((entry) => entry.mark !== null),
  };
}

/* ------------------------------------------------------------------ *
 * 4. Whole-student result
 * ------------------------------------------------------------------ */

/**
 * Builds the complete result object for one student.
 * @param {object} marks  { [subjectId]: { term1, term2, annual } }
 */
export function computeStudentResult(marks = {}) {
  const subjects = SUBJECTS.map((subject) => {
    const computed = computeWeightedSubjectTotal(marks[subject.id]);
    return {
      id: subject.id,
      name: subject.name,
      code: subject.code,
      color: subject.color,
      marks: {
        term1: sanitizeMark(marks?.[subject.id]?.term1),
        term2: sanitizeMark(marks?.[subject.id]?.term2),
        annual: sanitizeMark(marks?.[subject.id]?.annual),
      },
      ...computed,
    };
  });

  const enteredSubjects = subjects.filter((subject) => subject.hasAnyMark);
  const failedSubjects = enteredSubjects.filter((subject) => !subject.isPass);
  const hasAnyMark = enteredSubjects.length > 0;

  const totalMarks = round(
    enteredSubjects.reduce((sum, subject) => sum + subject.total, 0),
    2,
  );
  const totalFullMarks = enteredSubjects.length * FULL_MARKS_PER_SUBJECT;
  const percentage = totalFullMarks > 0 ? round((totalMarks / totalFullMarks) * 100, 2) : 0;

  // Board rule: any failed subject ⇒ GPA 0.00 and grade F.
  const rawGpa = enteredSubjects.length
    ? enteredSubjects.reduce((sum, subject) => sum + subject.point, 0) / enteredSubjects.length
    : 0;
  const gpa = failedSubjects.length > 0 ? 0 : round(rawGpa, 2);
  const gradeInfo =
    failedSubjects.length > 0
      ? { grade: 'F', point: 0, label: 'অকৃতকার্য' }
      : gradeForScore(percentage);

  return {
    subjects,
    totalMarks,
    totalFullMarks,
    percentage,
    gpa: hasAnyMark ? gpa : null,
    grade: hasAnyMark ? gradeInfo.grade : '—',
    gradeLabel: hasAnyMark ? gradeInfo.label : 'মূল্যায়ন হয়নি',
    failedSubjects: failedSubjects.map((subject) => subject.name),
    failCount: failedSubjects.length,
    passedSubjectCount: enteredSubjects.length - failedSubjects.length,
    enteredSubjectCount: enteredSubjects.length,
    hasAnyMark,
    isPass: hasAnyMark && failedSubjects.length === 0,
    subjectCount: SUBJECTS.length,
    termTotals: TERM_IDS.map((termId) => ({
      termId,
      total: round(
        enteredSubjects.reduce((sum, subject) => sum + (subject.marks[termId] ?? 0), 0),
        2,
      ),
      entered: enteredSubjects.filter((subject) => subject.marks[termId] !== null).length,
    })),
  };
}

/* ------------------------------------------------------------------ *
 * 5. Ranking & roll assignment
 * ------------------------------------------------------------------ */

/**
 * Ranks a class by total marks. Ties share the same position (1, 1, 3 ...).
 * @returns {Array} ranked rows: { studentId, totalMarks, gpa, position }
 */
export function computeMeritRanking(rows = []) {
  const safeRows = Array.isArray(rows) ? rows.filter(Boolean) : [];
  const scored = [...safeRows].sort((a, b) => {
    const totalA = Number(a?.totalMarks) || 0;
    const totalB = Number(b?.totalMarks) || 0;
    if (totalB !== totalA) return totalB - totalA;
    return String(a?.studentId ?? '').localeCompare(String(b?.studentId ?? ''));
  });

  let lastTotal = null;
  let lastPosition = 0;

  return scored.map((row, index) => {
    const total = Number(row?.totalMarks) || 0;
    const position = total === lastTotal ? lastPosition : index + 1;
    lastTotal = total;
    lastPosition = position;
    return { ...row, position };
  });
}

/**
 * Produces the "new roll" order for a class (highest total ⇒ roll ১).
 * Students without marks remain at the bottom in their existing order.
 */
export function computeNewRollOrder(rows = []) {
  const ranked = computeMeritRanking(rows);
  return ranked.map((row, index) => ({ ...row, suggestedRoll: index + 1 }));
}

/** Returns per-subject class averages – powers the analytics widgets. */
export function computeSubjectAverages(studentResults = []) {
  return SUBJECTS.map((subject) => {
    const totals = studentResults
      .map((result) => result?.subjects?.find((item) => item.id === subject.id)?.total)
      .filter((value) => typeof value === 'number');

    const average = totals.length
      ? round(totals.reduce((sum, value) => sum + value, 0) / totals.length, 2)
      : 0;

    return {
      id: subject.id,
      name: subject.name,
      color: subject.color,
      average,
      highest: totals.length ? Math.max(...totals) : 0,
      lowest: totals.length ? Math.min(...totals) : 0,
      appeared: totals.length,
    };
  });
}

/**
 * Term-scoped result (১ম / ২য় প্রান্তিক) using RAW marks out of 100 per subject.
 * Weighted totals stay exclusive to the annual/combined view so a term merit list
 * is never distorted by the 20/20/60 weighting.
 * @param {object} marks { [subjectId]: { term1, term2, annual } }
 * @param {'term1'|'term2'|'annual'} termId
 */
export function computeTermResult(marks = {}, termId) {
  const subjects = SUBJECTS.map((subject) => {
    const mark = sanitizeMark(marks?.[subject.id]?.[termId]);
    const info = gradeForScore(mark);
    return {
      id: subject.id,
      name: subject.name,
      code: subject.code,
      color: subject.color,
      marks: { [termId]: mark },
      mark,
      total: mark,
      largest: mark,
      grade: info.grade,
      point: info.point,
      gradeLabel: info.label,
      isPass: mark !== null && mark >= PASS_MARK,
      hasAnyMark: mark !== null,
      isEnteredFully: mark !== null,
    };
  });

  const enteredSubjects = subjects.filter((subject) => subject.hasAnyMark);
  const failedSubjects = enteredSubjects.filter((subject) => !subject.isPass);
  const hasAnyMark = enteredSubjects.length > 0;
  const totalMarks = round(enteredSubjects.reduce((sum, subject) => sum + subject.total, 0), 2);
  const totalFullMarks = enteredSubjects.length * FULL_MARKS_PER_SUBJECT;
  const percentage = totalFullMarks ? round((totalMarks / totalFullMarks) * 100, 2) : 0;
  const rawGpa = enteredSubjects.length
    ? enteredSubjects.reduce((sum, subject) => sum + subject.point, 0) / enteredSubjects.length
    : 0;
  const gpa = failedSubjects.length ? 0 : round(rawGpa, 2);
  const gradeInfo = failedSubjects.length
    ? { grade: 'F', point: 0, label: 'অকৃতকার্য' }
    : gradeForScore(hasAnyMark ? percentage : null);

  return {
    termId,
    subjects,
    totalMarks,
    totalFullMarks,
    percentage,
    gpa: hasAnyMark ? gpa : null,
    grade: hasAnyMark ? gradeInfo.grade : '—',
    gradeLabel: hasAnyMark ? gradeInfo.label : 'মূল্যায়ন হয়নি',
    failedSubjects: failedSubjects.map((subject) => subject.name),
    failCount: failedSubjects.length,
    enteredSubjectCount: enteredSubjects.length,
    subjectCount: SUBJECTS.length,
    hasAnyMark,
    isPass: hasAnyMark && failedSubjects.length === 0,
  };
}

export const isSubjectId = (id) => SUBJECT_IDS.includes(id);

export default {
  sanitizeMark,
  getMark,
  gradeForScore,
  isPassingMark,
  computeWeightedSubjectTotal,
  computeStudentResult,
  computeTermResult,
  computeMeritRanking,
  computeNewRollOrder,
  computeSubjectAverages,
  round,
};


