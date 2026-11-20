import { cleanForCloud, safeRead, safeSubscribe, safeUpdate } from './dbFallback.js';
import { SUBJECT_IDS, TERM_IDS, resolveTermKey } from '../../utils/constants.js';
import { dbPaths, normalizeSessionYear, resolveSchoolBase } from './dbPaths.js';
import { resolveMasterId, readStudentMasterIndex, toAppClassId, toDbClassId } from './studentService.js';
import { ensureSchoolYear } from './centralSchoolStore.js';

/**
 * resultService — Formative + Summative marks under the year partition.
 *
 * ```text
 * …/sessions/{year}/results/{classId}/{term}/{studentMasterId} = {
 *     subjects: { bangla: { formative, summative, total }, english: { … } },
 *     grandTotal, gpa, grade, meritPosition,
 *     updatedAt,
 * }
 * ```
 *
 * Per-subject writes keep concurrent teachers (different subjects, same class) from
 * clobbering each other, and `meritPosition` is stored once the teacher publishes
 * the merit list so year-end promotion can re-order rolls from it.
 */

const asRecord = (value) => (value && typeof value === 'object' && !Array.isArray(value) ? value : {});
const isObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const nowISO = () => new Date().toISOString();

/** Numeric mark or `null` — an empty cell is stored as `null`, never skipped silently. */
const numberOrNull = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
};

/** Formative + summative ➔ subject total (rounded to 2 decimals). */
export const subjectTotal = (formative, summative) => {
  if (formative === null && summative === null) return null;
  return Math.round(((Number(formative) || 0) + (Number(summative) || 0)) * 100) / 100;
};

/** The persisted canonical term key (`annual` ➔ `final`). */
const termKey = (term) => {
  const key = resolveTermKey(term) || 'annual';
  return key === 'annual' ? 'final' : key;
};

/** Empty mark sheet for one student — the canonical shape used app-wide. */
export function createEmptyMarks() {
  return SUBJECT_IDS.reduce((acc, subjectId) => {
    acc[subjectId] = TERM_IDS.reduce((termAcc, termId) => {
      termAcc[termId] = null;
      return termAcc;
    }, {});
    return acc;
  }, {});
}

/** Empty formative/summative sheet for one student/term. */
export function createEmptySubjectMarks(subjectIds = SUBJECT_IDS) {
  return subjectIds.reduce((acc, subjectId) => {
    acc[subjectId] = { formative: null, summative: null, total: null };
    return acc;
  }, {});
}

/**
 * Normalises one persisted subject entry.
 * Accepts the canonical `{formative, summative, total}`, a bare number, or the
 * legacy `{mark}` / `{value}` shape.
 */
export function normalizeSubjectMark(value, fallback = null) {
  if (isObject(value)) {
    const formative = numberOrNull(value.formative ?? value.formativeMark);
    const summative = numberOrNull(value.summative ?? value.summativeMark);
    const storedTotal = numberOrNull(value.total);
    const total = storedTotal ?? subjectTotal(formative, summative);
    if (formative === null && summative === null) {
      return { formative: fallback, summative: fallback, total: fallback };
    }
    return { formative, summative, total };
  }
  const flat = numberOrNull(value);
  return { formative: flat ?? fallback, summative: flat ?? fallback, total: flat ?? fallback };
}

/** Subject map ➔ `{ subjects: {...}, grandTotal }` for one term row. */
export function buildTermResult(subjects = {}) {
  const normalized = {};
  let grandTotal = 0;
  let counted = 0;
  Object.entries(asRecord(subjects)).forEach(([subjectId, entry]) => {
    const mark = normalizeSubjectMark(entry);
    normalized[subjectId] = mark;
    if (mark.total !== null) {
      grandTotal += mark.total;
      counted += 1;
    }
  });
  return {
    subjects: normalized,
    grandTotal: counted > 0 ? Math.round(grandTotal * 100) / 100 : 0,
  };
}

/**
 * Legacy flat shape (`marks/{subjectId}: number`) ➔ formative/summative subjects.
 * Months of legacy rows stay readable after the migration.
 */
const subjectsFromLegacyRow = (row = {}) => {
  const subjects = {};
  Object.entries(asRecord(row.marks)).forEach(([subjectId, value]) => {
    const numeric = typeof value === 'object' ? value?.mark ?? value?.value : value;
    if (numeric === null || numeric === undefined || numeric === '') return;
    subjects[subjectId] = normalizeSubjectMark(numeric);
  });
  return subjects;
};

/** One stored row ➔ canonical `{ subjects, grandTotal, gpa, grade, meritPosition, ranks }`. */
export function normalizeResultRow(row = {}) {
  const source = asRecord(row);
  const subjects = Object.keys(asRecord(source.subjects)).length
    ? buildTermResult(source.subjects).subjects
    : subjectsFromLegacyRow(source);
  const { grandTotal } = buildTermResult(subjects);
  return {
    ...source,
    subjects,
    grandTotal: numberOrNull(source.grandTotal ?? source.total) ?? grandTotal,
    gpa: numberOrNull(source.gpa),
    grade: source.grade ?? '',
    meritPosition: numberOrNull(source.meritPosition ?? source.rank),
    remark: source.remark ?? '',
    updatedAt: source.updatedAt ?? '',
  };
}
/* ------------------------------------------------------------------ *
 * Paths & active-year resolution
 * ------------------------------------------------------------------ */

/** Absolute path of one student's row inside the year partition. */
const yearResultPath = (schoolId, year, classId, term, studentMasterId) =>
  dbPaths.yearResult(schoolId, year, toDbClassId(classId), term, studentMasterId);

/** Legacy absolute path (`results/{term}/{classId}/{studentId}`). */
const legacyResultPath = (schoolId, term, classId, studentId) =>
  dbPaths.resultStudent(schoolId, term, toDbClassId(classId), studentId);

const activeYearCache = new Map();
const currentCalendarYear = () => String(new Date().getFullYear());

/**
 * The school's active academic year, cached per school.
 * `profile/{academicYear}` is what the topbar's year selector writes; the current
 * calendar year is the app-wide default when a school has not set one yet.
 */
export async function resolveActiveYear(schoolId) {
  if (!schoolId) return '';
  if (activeYearCache.has(schoolId)) return activeYearCache.get(schoolId);
  const profile = asRecord(await safeRead(dbPaths.profile(schoolId), {}));
  const year = normalizeSessionYear(profile.academicYear || profile.session, currentCalendarYear());
  activeYearCache.set(schoolId, year);
  return year;
}

/** Clears the cached active year (call it after the topbar switches years). */
export const forgetActiveYear = (schoolId) => {
  if (schoolId) activeYearCache.delete(schoolId);
  else activeYearCache.clear();
};

/** True when `key` is a term segment rather than a class id. */
const isTermKey = (key) => TERM_IDS.includes(resolveTermKey(key)) || key === 'final' || key === 'annual';

/**
 * Flattens a results tree into the view-model shapes the hooks consume.
 * Both layouts are understood:
 *  - year-partitioned `{ [classId]: { [term]: { [studentMasterId]: row } } }`
 *  - legacy            `{ [term]: { [classId]: { [studentId]: row } } }`
 * `aliasOf` maps a stored pupil key back to the app-facing roster id so marks land
 * on `dataset.marks[student.id]` exactly as before.
 */
function flatten(tree = {}, aliasOf = (id) => id) {
  const marks = {};
  const remarks = {};
  const termRemarks = {};
  const rankings = {};
  const rows = {};

  const writeMark = (appId, subjectId, term, entry) => {
    const mark = normalizeSubjectMark(entry);
    if (mark.total === null) return;
    marks[appId] = marks[appId] ?? {};
    marks[appId][subjectId] = marks[appId][subjectId] ?? {};
    marks[appId][subjectId][term] = mark.total;
  };

  const visit = (classId, term, studentId, row) => {
    if (!isObject(row)) return;
    const normalized = normalizeResultRow(row);
    const appId = aliasOf(normalized.legacyId || studentId) || studentId;

    Object.entries(normalized.subjects ?? {}).forEach(([subjectId, entry]) => {
      writeMark(appId, subjectId, term, entry);
    });

    if (typeof normalized.remark === 'string' && normalized.remark.trim()) {
      termRemarks[appId] = termRemarks[appId] ?? {};
      termRemarks[appId][term] = normalized.remark;
      if (!remarks[appId] || term === 'final') remarks[appId] = normalized.remark;
    }

    if (normalized.meritPosition) {
      rankings[term] = rankings[term] ?? {};
      rankings[term][toAppClassId(classId)] = rankings[term][toAppClassId(classId)] ?? {};
      rankings[term][toAppClassId(classId)][appId] = normalized.meritPosition;
    }

    rows[appId] = rows[appId] ?? {};
    rows[appId][term] = {
      ...normalized,
      classId: toAppClassId(classId),
      term,
      studentMasterId: normalized.studentMasterId || studentId,
    };
  };

  Object.entries(asRecord(tree)).forEach(([outerKey, levelOne]) => {
    if (!isObject(levelOne)) return;
    if (isTermKey(outerKey)) {
      // Legacy layout: term ➔ class ➔ student
      const term = termKey(outerKey);
      Object.entries(levelOne).forEach(([classId, levelTwo]) => {
        if (!isObject(levelTwo)) return;
        Object.entries(levelTwo).forEach(([studentId, row]) => visit(classId, term, studentId, row));
      });
      return;
    }
    // Year-partitioned layout: class ➔ term ➔ studentMasterId
    Object.entries(levelOne).forEach(([termSegment, levelTwo]) => {
      if (!isObject(levelTwo)) return;
      const term = termKey(termSegment);
      Object.entries(levelTwo).forEach(([studentId, row]) => visit(outerKey, term, studentId, row));
    });
  });

  return { tree: tree ?? {}, marks, remarks, termRemarks, rankings, rows };
}
/** Views key terms by the persisted id (`final` ➔ `annual`) so hooks stay unchanged. */
const persistedTermId = (term) => {
  const key = termKey(term);
  return key === 'final' ? 'annual' : key;
};

/** Live subscription to one academic year's results (merged with the legacy root). */
export function subscribeResults(schoolId, callback, onStatus, year = '') {
  if (!schoolId) {
    callback(flatten({}));
    return () => {};
  }

  const requestedYear = normalizeSessionYear(year);
  let legacyTree = {};
  let yearTree = {};
  let aliasOf = (id) => id;

  const emit = () => {
    // Year-partitioned classes win over a same-named legacy node.
    const merged = { ...asRecord(legacyTree), ...asRecord(yearTree) };
    callback(flatten(merged, aliasOf));
  };

  const unsubs = [];
  unsubs.push(safeSubscribe(dbPaths.results(schoolId), (value) => {
    legacyTree = asRecord(value);
    emit();
  }, {}, onStatus));

  const bindYear = (yearKey) => {
    const normalized = normalizeSessionYear(yearKey);
    if (!normalized) return;
    // Stored rows are keyed by `studentMasterId`; the UI addresses pupils by their
    // roster id, so the alias index is loaded once per subscription.
    readStudentMasterIndex(schoolId).then(({ masters }) => {
      if (!Object.keys(masters).length) return;
      aliasOf = (id) => (masters[id]?.legacyId ? masters[id].legacyId : id);
      emit();
    }).catch(() => {});
    unsubs.push(safeSubscribe(dbPaths.yearResults(schoolId, normalized), (value) => {
      yearTree = asRecord(value);
      emit();
    }, {}, onStatus));
  };

  if (requestedYear) bindYear(requestedYear);
  else resolveActiveYear(schoolId).then(bindYear).catch(() => {});

  return () => unsubs.forEach((unsub) => unsub?.());
}

/** One-shot read of a past year's flattened results (cross-year history). */
export async function readSessionResults(schoolId, year = '') {
  if (!schoolId || !year) return flatten({});
  const yearKey = normalizeSessionYear(year);
  const partition = asRecord(await safeRead(dbPaths.yearResults(schoolId, yearKey), {}));
  if (Object.keys(partition).length) return flatten(partition);
  return flatten(asRecord(await safeRead(dbPaths.results(schoolId), {})));
}

/** Live subscription to a single term only (cheaper for the 3-tab grid). */
export function subscribeTermResults(schoolId, termId, callback, onStatus, year = '') {
  if (!schoolId || !TERM_IDS.includes(termId) || typeof callback !== 'function') {
    callback?.({});
    return () => {};
  }

  const term = persistedTermId(termId);
  const requestedYear = normalizeSessionYear(year);
  let legacyTerm = {};
  let yearTerm = {};
  const emit = () => callback({ ...asRecord(legacyTerm), ...asRecord(yearTerm) });

  const unsubs = [safeSubscribe(dbPaths.resultTerm(schoolId, termId), (value) => {
    legacyTerm = asRecord(value);
    emit();
  }, {}, onStatus)];

  const bindYear = (yearKey) => {
    const normalized = normalizeSessionYear(yearKey);
    if (!normalized) return;
    unsubs.push(safeSubscribe(dbPaths.yearResults(schoolId, normalized), (value) => {
      const perClass = {};
      Object.entries(asRecord(value)).forEach(([classId, terms]) => {
        const row = asRecord(terms)[term];
        if (isObject(row)) perClass[classId] = row;
      });
      yearTerm = perClass;
      emit();
    }, {}, onStatus));
  };

  if (requestedYear) bindYear(requestedYear);
  else resolveActiveYear(schoolId).then(bindYear).catch(() => {});

  return () => unsubs.forEach((unsub) => unsub?.());
}
/* ------------------------------------------------------------------ *
 * Writes — one row per student/term inside the year partition
 * ------------------------------------------------------------------ */

/** Current row for a student/term (year partition first, legacy fallback). */
const readResultRow = async (schoolId, year, classId, term, studentMasterId) => {
  const yearKey = normalizeSessionYear(year);
  const partitionRow = yearKey
    ? await safeRead(yearResultPath(schoolId, yearKey, classId, term, studentMasterId), null)
    : null;
  if (isObject(partitionRow)) return partitionRow;
  return asRecord(await safeRead(legacyResultPath(schoolId, term, classId, studentMasterId), {}));
};

/** Canonical absolute target for a student/term row. */
const rowBasePath = (schoolId, year, classId, term) =>
  (year ? `${dbPaths.yearResults(schoolId, year)}/${toDbClassId(classId)}/${termKey(term)}` : dbPaths.results(schoolId));

const rowRelativeKey = (schoolId, year, classId, term, studentMasterId) => (
  year
    ? studentMasterId
    : `${resolveTermKey(term) || 'annual'}/${classId}/${studentMasterId}`
);

/**
 * Auto-save for one subject component (formative or summative).
 * `total` is always recomputed so a document never shows a stale subject total.
 */
export async function saveMark(schoolId, termId, classId, studentId, subjectId, value, year = '', component = 'total') {
  if (!schoolId || !TERM_IDS.includes(termId) || !classId || !studentId || !subjectId) {
    return Promise.resolve({ synced: false });
  }
  const studentMasterId = await resolveMasterId(schoolId, studentId);
  const yearKey = normalizeSessionYear(year);
  const term = termKey(termId);
  const previous = await readResultRow(schoolId, yearKey, classId, term, studentMasterId);
  const priorSubjects = normalizeResultRow(previous).subjects ?? {};
  const current = priorSubjects[subjectId] ?? {};
  const nextInput = component === 'formative' || component === 'summative'
    ? { ...current, [component]: value }
    : { formative: value, summative: value };
  const next = normalizeSubjectMark(nextInput);
  const subjects = { ...priorSubjects, [subjectId]: next };
  // `total` is derived, so it is written last: a component edit must never leave
  // the previous subject total behind.
  return writeResultRow(schoolId, yearKey, classId, term, studentMasterId, {
    ...(isObject(previous) ? previous : {}),
    subjects: {
      ...priorSubjects,
      [subjectId]: { formative: next.formative, summative: next.summative },
    },
  }, { subjects });
}

/** Saves a whole term's subject map at once (paste / import). */
export async function saveStudentTermMarks(schoolId, termId, classId, studentId, marks = {}, year = '') {
  if (!schoolId || !classId || !studentId) return { synced: false };
  const studentMasterId = await resolveMasterId(schoolId, studentId);
  const yearKey = normalizeSessionYear(year);
  const term = termKey(termId);
  const subjects = {};
  Object.entries(asRecord(marks)).forEach(([subjectId, value]) => {
    const mark = normalizeSubjectMark(value);
    if (mark.formative === null && mark.summative === null && mark.total === null) return;
    subjects[subjectId] = mark;
  });
  return writeResultRow(schoolId, yearKey, classId, term, studentMasterId, { subjects });
}

/** Persists the teacher-reviewed remark for one student/term. */
export async function saveRemark(schoolId, termId, classId, studentId, remark, year = '') {
  const yearKey = normalizeSessionYear(year);
  if (!schoolId || !classId || !studentId) return Promise.resolve({ synced: false });
  const studentMasterId = await resolveMasterId(schoolId, studentId);
  const term = termKey(termId);
  if (yearKey) await ensureSchoolYear(schoolId, yearKey);
  const base = rowBasePath(schoolId, yearKey, classId, term);
  const key = rowRelativeKey(schoolId, yearKey, classId, term, studentMasterId);
  return safeUpdate(base, {
    [`${key}/remark`]: String(remark ?? ''),
    [`${key}/updatedAt`]: nowISO(),
  });
}

/**
 * Merges a computed row into the stored one: subjects are normalised, the grand
 * total is recomputed, and arbitrary extras (gpa, grade, meritPosition…) are kept.
 */
async function writeResultRow(schoolId, year, classId, term, studentMasterId, partial = {}, extra = {}) {
  const yearKey = normalizeSessionYear(year);
  const previous = normalizeResultRow(await readResultRow(schoolId, yearKey, classId, term, studentMasterId));
  const subjects = { ...(previous.subjects ?? {}), ...(partial.subjects ?? {}) };
  const { grandTotal } = buildTermResult(subjects);
  const row = cleanForCloud({
    ...previous,
    ...partial,
    ...extra,
    studentMasterId,
    classId: toDbClassId(classId),
    term,
    subjects,
    grandTotal,
    updatedAt: nowISO(),
  });
  const base = rowBasePath(schoolId, yearKey, classId, term);
  const key = rowRelativeKey(schoolId, yearKey, classId, term, studentMasterId);
  // A mark belongs to `sessions/{year}/results/{classId}/{term}`: the year's bucket
  // skeleton (and its class node) is ensured once before the first row of the day.
  if (yearKey) await ensureSchoolYear(schoolId, yearKey);
  return safeUpdate(base, { [key]: row });
}
/**
 * Persists the published merit list for a class/term.
 * `meritPosition` is what year-end promotion re-orders the new rolls from, so it
 * is stored on the same row as the marks (not in a detached rankings node).
 * @param {Array<{studentId?:string, studentMasterId?:string, rank:number, total?:number, gpa?:number}>} rows
 */
export async function saveRankings(schoolId, termId, classId, rows = [], year = '', grades = {}) {
  if (!schoolId || !classId) return { synced: false };
  const yearKey = normalizeSessionYear(year);
  const term = termKey(termId);
  if (yearKey) await ensureSchoolYear(schoolId, yearKey);
  const base = rowBasePath(schoolId, yearKey, classId, term);
  const { byId } = await readStudentMasterIndex(schoolId);
  const patch = {};
  rows.forEach((row) => {
    const studentId = row?.studentId || row?.studentMasterId;
    if (!studentId) return;
    const studentMasterId = byId.get(studentId) || studentId;
    const key = rowRelativeKey(schoolId, yearKey, classId, term, studentMasterId);
    patch[`${key}/meritPosition`] = row.rank ?? null;
    patch[`${key}/grandTotal`] = row.total ?? null;
    patch[`${key}/gpa`] = row.gpa ?? null;
    if (grades?.[studentId]) patch[`${key}/grade`] = grades[studentId];
    patch[`${key}/studentMasterId`] = studentMasterId;
    patch[`${key}/legacyId`] = studentId;
    patch[`${key}/classId`] = toDbClassId(classId);
    patch[`${key}/term`] = term;
    patch[`${key}/updatedAt`] = nowISO();
  });
  if (Object.keys(patch).length === 0) return Promise.resolve({ synced: true });
  return safeUpdate(base, patch);
}

/** Bulk term write — used by demo seeding or a full class import. */
export async function saveTermResults(schoolId, termId, classId, resultMap = {}, year = '') {
  if (!schoolId || !classId) return { synced: false };
  const yearKey = normalizeSessionYear(year);
  const term = termKey(termId);
  if (yearKey) await ensureSchoolYear(schoolId, yearKey);
  const base = rowBasePath(schoolId, yearKey, classId, term);
  const { byId } = await readStudentMasterIndex(schoolId);
  const patch = {};
  Object.entries(asRecord(resultMap)).forEach(([appId, result]) => {
    const studentMasterId = byId.get(appId) || appId;
    const subjects = isObject(result?.subjects) ? result.subjects : subjectsFromLegacyRow(result);
    const normalized = buildTermResult(subjects);
    const key = rowRelativeKey(schoolId, yearKey, classId, term, studentMasterId);
    patch[key] = cleanForCloud({
      ...(isObject(result) ? result : {}),
      studentMasterId,
      legacyId: appId,
      classId: toDbClassId(classId),
      term,
      subjects: normalized.subjects,
      grandTotal: numberOrNull(result?.grandTotal ?? result?.total) ?? normalized.grandTotal,
      updatedAt: nowISO(),
    });
  });
  if (Object.keys(patch).length === 0) return { synced: true };
  return safeUpdate(base, patch);
}
/**
 * Mirrors the context's normalized marks/remarks into the year partition.
 * `marks` keeps the flat `{ [studentId]: { [subjectId]: { [termId]: number } } }`
 * shape the UI works with; a single aggregate value is stored as both evaluated
 * components so the formative/summative structure stays complete.
 */
export async function syncResultTree(schoolId, marks = {}, remarks = {}, students = [], year = '') {
  if (!schoolId) return Promise.resolve({ synced: false });
  const yearKey = normalizeSessionYear(year);
  if (yearKey) await ensureSchoolYear(schoolId, yearKey);
  const studentsById = new Map((students ?? []).map((student) => [student.id, student]));
  const { byId } = await readStudentMasterIndex(schoolId);
  const base = yearKey ? dbPaths.yearResults(schoolId, yearKey) : dbPaths.results(schoolId);
  const patch = {};

  const setSubject = (student, termId, subjectId, mark) => {
    const studentMasterId = byId.get(student.id) || student.id;
    const key = rowRelativeKey(schoolId, yearKey, student.classId, termId, studentMasterId);
    patch[`${key}/studentMasterId`] = studentMasterId;
    patch[`${key}/legacyId`] = student.id;
    patch[`${key}/classId`] = toDbClassId(student.classId);
    patch[`${key}/term`] = termKey(termId);
    patch[`${key}/subjects/${subjectId}/formative`] = mark.formative;
    patch[`${key}/subjects/${subjectId}/summative`] = mark.summative;
    patch[`${key}/subjects/${subjectId}/total`] = mark.total;
    patch[`${key}/updatedAt`] = nowISO();
  };

  Object.entries(asRecord(marks)).forEach(([studentId, subjects]) => {
    const student = studentsById.get(studentId);
    if (!student || student.classId === 'archive') return;
    Object.entries(asRecord(subjects)).forEach(([subjectId, terms]) => {
      const keys = Object.keys(asRecord(terms));
      if (keys.length && !keys.some((key) => TERM_IDS.includes(key))) {
        // Already a component map (`{formative, summative}`): apply to every term.
        const mark = normalizeSubjectMark(terms);
        TERM_IDS.forEach((termId) => setSubject(student, termId, subjectId, mark));
        return;
      }
      Object.entries(asRecord(terms)).forEach(([termId, value]) => {
        if (!TERM_IDS.includes(termId)) return;
        setSubject(student, termId, subjectId, normalizeSubjectMark(value));
      });
    });
  });

  Object.entries(asRecord(remarks)).forEach(([studentId, remark]) => {
    const student = studentsById.get(studentId);
    if (!student || student.classId === 'archive') return;
    const studentMasterId = byId.get(student.id) || student.id;
    const key = rowRelativeKey(schoolId, yearKey, student.classId, 'annual', studentMasterId);
    patch[`${key}/remark`] = String(remark ?? '');
    patch[`${key}/studentMasterId`] = studentMasterId;
    patch[`${key}/legacyId`] = student.id;
    patch[`${key}/classId`] = toDbClassId(student.classId);
    patch[`${key}/term`] = 'final';
    patch[`${key}/updatedAt`] = nowISO();
  });

  if (Object.keys(patch).length === 0) return { synced: true };
  return safeUpdate(base, patch);
}

/** Clears one student's rows for every term (explicit cleanup only). */
export async function deleteStudentResults(schoolId, studentId, classId, year = '') {
  if (!schoolId || !studentId || !classId) return { synced: false };
  const studentMasterId = await resolveMasterId(schoolId, studentId);
  const yearKey = normalizeSessionYear(year);
  if (yearKey) {
    const patch = {};
    TERM_IDS.forEach((termId) => {
      patch[`${toDbClassId(classId)}/${termKey(termId)}/${studentMasterId}`] = null;
    });
    return safeUpdate(dbPaths.yearResults(schoolId, yearKey), patch);
  }
  const patch = {};
  TERM_IDS.forEach((termId) => {
    patch[`${termId}/${toDbClassId(classId)}/${studentMasterId}`] = null;
  });
  return safeUpdate(dbPaths.results(schoolId), patch);
}
/**
 * Case-insensitive lookup for one pupil's enrollment inside one year's roster node.
 * Supports the current `{classId: {sectionId: {studentMasterId: row}}}` layout, the
 * older `{classId: {studentMasterId: row}}` buckets and the legacy flat
 * `{studentId: row}` roster.
 */
function findEnrollment(studentsNode, studentMasterId) {
  const findIn = (map) => {
    const direct = asRecord(map)[studentMasterId];
    if (isObject(direct)) return direct;
    const match = Object.entries(asRecord(map)).find(([, row]) => (
      isObject(row) && (row.studentMasterId === studentMasterId || row.legacyId === studentMasterId)
    ));
    return match ? match[1] : null;
  };

  const flat = findIn(studentsNode);
  if (flat) return flat;

  let found = null;
  Object.values(asRecord(studentsNode)).forEach((child) => {
    if (found || !isObject(child)) return;
    // Legacy class bucket: the pupil row sits directly under it.
    const nested = findIn(child);
    if (nested) {
      found = { ...nested, classId: nested.classId || '' };
      return;
    }
    // Current layout: rows sit one level deeper, inside a শাখা folder.
    Object.entries(asRecord(child)).forEach(([sectionFolder, rows]) => {
      if (found || !isObject(rows)) return;
      const inSection = findIn(rows);
      if (inSection) {
        found = { ...inSection, classId: inSection.classId || '', section: inSection.section || sectionFolder };
      }
    });
  });
  return found;
}

/** Collects one pupil's term rows out of that year's whole results tree. */
function collectTermResults(resultsTree, studentMasterId) {
  const terms = {};
  Object.entries(asRecord(resultsTree)).forEach(([classId, levelOne]) => {
    Object.entries(asRecord(levelOne)).forEach(([termSegment, levelTwo]) => {
      const row = asRecord(levelTwo)[studentMasterId];
      if (isObject(row)) terms[termKey(termSegment)] = normalizeResultRow({ ...row, classId });
    });
  });
  return terms;
}

/** Root `…/sessions` node of a school (hierarchical node, legacy fallback). */
const sessionsRoot = (schoolId) =>
  `${resolveSchoolBase(schoolId) || dbPaths.workspace(schoolId)}/sessions`;

/**
 * Complete cross-year history for one pupil, linked by `studentMasterId`.
 *
 * Scans every year that exists under `sessions/` (registry + actual year nodes) and
 * returns the permanent identity plus, per year: class, roll, section, status and
 * the term/final result rows. Newest year first.
 *
 * @returns {Promise<{studentMasterId:string, studentMaster:object|null, years:Array<object>}>}
 */
export async function getStudentCrossYearHistory(schoolId, studentMasterId) {
  const empty = { studentMasterId: studentMasterId ?? '', studentMaster: null, years: [] };
  if (!schoolId || !studentMasterId) return empty;

  const [studentMaster, sessionIndex, yearNodes] = await Promise.all([
    safeRead(dbPaths.studentMasterEntry(schoolId, studentMasterId), null),
    safeRead(dbPaths.sessions(schoolId), {}),
    safeRead(sessionsRoot(schoolId), {}),
  ]);

  const years = [...new Set([
    ...Object.keys(asRecord(sessionIndex)),
    ...Object.keys(asRecord(yearNodes)),
  ].map((year) => normalizeSessionYear(year)).filter(Boolean))].sort((a, b) => Number(b) - Number(a));

  const history = await Promise.all(years.map(async (year) => {
    const [studentsNode, passedNode, resultsTree] = await Promise.all([
      safeRead(dbPaths.yearStudents(schoolId, year), {}),
      safeRead(dbPaths.yearPassedArchive(schoolId, year), {}),
      safeRead(dbPaths.yearResults(schoolId, year), {}),
    ]);

    const enrollment = findEnrollment(studentsNode, studentMasterId);
    const passed = asRecord(passedNode)[studentMasterId];
    const terms = collectTermResults(resultsTree, studentMasterId);
    if (!enrollment && !passed && Object.keys(terms).length === 0) return null;

    const finalResult = terms.final ?? terms.annual ?? null;
    return {
      year,
      classId: enrollment?.classId || passed?.classId || finalResult?.classId || '',
      roll: enrollment?.roll ?? passed?.roll ?? null,
      section: enrollment?.section ?? '',
      status: passed ? 'passed' : (enrollment?.status ?? ''),
      enrolled: Boolean(enrollment),
      passed: Boolean(passed),
      terms,
      finalResult,
      gpa: finalResult?.gpa ?? null,
      grade: finalResult?.grade ?? '',
      grandTotal: finalResult?.grandTotal ?? null,
      meritPosition: finalResult?.meritPosition ?? null,
    };
  }));

  return {
    studentMasterId,
    studentMaster: isObject(studentMaster) ? studentMaster : null,
    years: history.filter(Boolean),
  };
}

export default {
  createEmptyMarks,
  createEmptySubjectMarks,
  subjectTotal,
  normalizeSubjectMark,
  normalizeResultRow,
  buildTermResult,
  resolveActiveYear,
  forgetActiveYear,
  subscribeResults,
  subscribeTermResults,
  readSessionResults,
  saveMark,
  saveStudentTermMarks,
  saveRemark,
  saveRankings,
  saveTermResults,
  syncResultTree,
  deleteStudentResults,
  getStudentCrossYearHistory,
};







