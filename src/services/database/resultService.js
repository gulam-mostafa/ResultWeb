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

/** Stored/persisted term key (`'final'` | `'term1'` | `'term2'`). */
const termKey = (term) => {
  const key = resolveTermKey(term) || 'annual';
  return key === 'annual' ? 'final' : key;
};

/**
 * App-facing term id (`'annual'` | `'term1'` | `'term2'`).
 *
 * RTDB stores the annual term as `'final'`, but every UI consumer
 * (`gradingCalculator`, `useResults`, `SchoolDataContext`, the grid and the modals)
 * addresses it as `'annual'` (see `TERM_IDS`). Mapping here — on the way IN — is what
 * keeps a saved বার্ষিক মূল্যায়ন mark visible after a reload/tab switch.
 */
const appTermId = (term) => {
  const key = resolveTermKey(term) || '';
  return key === 'final' ? 'annual' : key;
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
 *
 * Accepts the canonical `{formative, summative, total}`, a bare single mark
 * (`{total}` / a number) or the legacy `{mark}` / `{value}` shape.
 *
 * Rules (they must never change, every reader depends on them):
 *  1. An EXPLICIT stored `total` is always authoritative — components are only
 *     carried alongside it.
 *  2. A single-mark row stores `{ total: v }`; it is NEVER expanded into both
 *     components (that is what used to double `30` into `60`).
 *  3. Legacy `{ formative: v, summative: v }` rows (written before `total` existed)
 *     stored the SAME value twice, so the mark is `v` — not `2v`.
 *  4. Only a real component pair is summed into a derived total.
 */
export function normalizeSubjectMark(value, fallback = null) {
  if (isObject(value)) {
    const formative = numberOrNull(value.formative ?? value.formativeMark);
    const summative = numberOrNull(value.summative ?? value.summativeMark);
    const storedTotal = numberOrNull(value.total);
    if (storedTotal !== null) return { formative, summative, total: storedTotal };
    if (formative === null && summative === null) {
      return { formative: fallback, summative: fallback, total: fallback };
    }
    // Legacy aggregate: the same figure in both components is one mark, not two.
    if (formative !== null && summative !== null && formative === summative) {
      return { formative, summative, total: formative };
    }
    return { formative, summative, total: subjectTotal(formative, summative) };
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
    // গাঠনিক / সামষ্টিক components travel alongside the subject total so a class
    // configuration with a custom split can re-derive the total exactly.
    //  • A legacy aggregate row stores the SAME value in both components (that is how
    //    a pre-split mark was persisted) — expanding it would double the total, so it
    //    is skipped.
    //  • A real component row always satisfies `formative + summative = total`.
    const legacyAggregate = mark.formative !== null
      && mark.summative !== null
      && mark.formative === mark.total
      && mark.summative === mark.total;
    const explicitComponents = !legacyAggregate
      && (mark.formative !== null || mark.summative !== null)
      && Math.round(((mark.formative ?? 0) + (mark.summative ?? 0)) * 100) / 100 === Math.round(mark.total * 100) / 100;
    if (!explicitComponents) return;
    marks[appId][`${subjectId}:formative`] = marks[appId][`${subjectId}:formative`] ?? {};
    marks[appId][`${subjectId}:formative`][term] = mark.formative ?? 0;
    marks[appId][`${subjectId}:summative`] = marks[appId][`${subjectId}:summative`] ?? {};
    marks[appId][`${subjectId}:summative`][term] = mark.summative ?? 0;
  };

  const visit = (classId, storedTerm, studentId, row) => {
    if (!isObject(row)) return;
    // `final` ➔ `annual`: the UI reads `TERM_IDS`, the database stores `final`.
    const term = appTermId(storedTerm);
    const normalized = normalizeResultRow(row);
    const appId = aliasOf(normalized.legacyId || studentId) || studentId;

    Object.entries(normalized.subjects ?? {}).forEach(([subjectId, entry]) => {
      writeMark(appId, subjectId, term, entry);
    });

    if (typeof normalized.remark === 'string' && normalized.remark.trim()) {
      termRemarks[appId] = termRemarks[appId] ?? {};
      termRemarks[appId][term] = normalized.remark;
      if (!remarks[appId] || term === 'annual') remarks[appId] = normalized.remark;
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
/** Views key terms by the app-facing id (`final` ➔ `annual`) so hooks stay unchanged. */
const persistedTermId = (term) => {
  const key = termKey(term);
  return key === 'final' ? 'annual' : key;
};

/**
 * Live subscription to one term only (cheaper than the whole tree).
 *
 * Emits `{ [classId]: { [studentId]: row } }` keyed by the APP term id. The stored
 * annual segment is `final`, so the year partition is read with the persisted key and
 * every row is normalised before it reaches a consumer — a `বার্ষিক` term therefore
 * arrives exactly like `১ম` / `২য়`.
 */
export function subscribeTermResults(schoolId, termId, callback, onStatus, year = '') {
  if (!schoolId || !TERM_IDS.includes(termId) || typeof callback !== 'function') {
    callback?.({});
    return () => {};
  }

  // The database segment (`term1` | `term2` | `final`); `termId` stays app-facing.
  const storedTerm = termKey(termId);
  const requestedYear = normalizeSessionYear(year);
  let legacyTerm = {};
  let yearTerm = {};
  let active = true;
  const emit = () => {
    if (!active) return;
    callback({ ...asRecord(legacyTerm), ...asRecord(yearTerm) });
  };

  /** `/results/{term}/{classId}/{studentId}` ➔ `{classId: {studentId: row}}`. */
  const readLegacyTerm = (value) => Object.entries(asRecord(value)).reduce((acc, [classId, rows]) => {
    const perStudent = {};
    Object.entries(asRecord(rows)).forEach(([studentId, row]) => {
      if (!isObject(row)) return;
      // The app-facing term id travels on the row, so a consumer never has to know that
      // the database spells the annual term `final`.
      perStudent[studentId] = { ...normalizeResultRow(row), term: termId };
    });
    if (Object.keys(perStudent).length) acc[classId] = perStudent;
    return acc;
  }, {});

  const unsubs = [safeSubscribe(dbPaths.resultTerm(schoolId, termId), (value) => {
    legacyTerm = readLegacyTerm(value);
    emit();
  }, {}, onStatus)];

  const bindYear = (yearKey) => {
    if (!active) return;
    const normalized = normalizeSessionYear(yearKey);
    if (!normalized) return;
    const listener = safeSubscribe(dbPaths.yearResults(schoolId, normalized), (value) => {
      const perClass = {};
      Object.entries(asRecord(value)).forEach(([classId, terms]) => {
        // Stored key first (`final`), plus the app spelling as a legacy alias.
        const level = asRecord(terms);
        const rows = isObject(level[storedTerm]) ? level[storedTerm] : level[persistedTermId(termId)];
        if (!isObject(rows)) return;
        const perStudent = {};
        Object.entries(rows).forEach(([studentId, row]) => {
          if (!isObject(row)) return;
          perStudent[studentId] = {
            ...normalizeResultRow(row),
            classId,
            // App-facing term id (`annual`), never the stored `final`.
            term: termId,
          };
        });
        if (Object.keys(perStudent).length) perClass[classId] = perStudent;
      });
      yearTerm = perClass;
      emit();
    }, {}, onStatus);
    if (!active) {
      // Unsubscribed while the listener was being created ➔ detach immediately.
      listener?.();
      return;
    }
    unsubs.push(listener);
  };

  if (requestedYear) bindYear(requestedYear);
  else resolveActiveYear(schoolId).then(bindYear).catch(() => {});

  return () => {
    active = false;
    unsubs.forEach((unsub) => unsub?.());
    unsubs.length = 0;
  };
}

/**
 * Live subscription to one academic year's results (merged with the legacy root).
 *
 * The year partition is resolved ASYNCHRONOUSLY when the caller passes no year
 * (`resolveActiveYear`). `unsubscribe()` may therefore run before that promise settles —
 * without a guard the late `safeSubscribe()` would register a listener that NOTHING ever
 * detaches (a real leak that also kept a stale school's data alive). The `active` flag
 * makes a late bind a no-op and detaches anything it just created.
 */
export function subscribeResults(schoolId, callback, onStatus, year = '') {
  if (!schoolId) {
    callback(flatten({}));
    return () => {};
  }

  const requestedYear = normalizeSessionYear(year);
  let legacyTree = {};
  let yearTree = {};
  let aliasOf = (id) => id;
  let active = true;

  const emit = () => {
    if (!active) return;
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
    if (!active) return;
    const normalized = normalizeSessionYear(yearKey);
    if (!normalized) return;
    // Stored rows are keyed by `studentMasterId`; the UI addresses pupils by their
    // roster id, so the alias index is loaded once per subscription.
    readStudentMasterIndex(schoolId).then(({ masters }) => {
      if (!active || !Object.keys(masters).length) return;
      aliasOf = (id) => (masters[id]?.legacyId ? masters[id].legacyId : id);
      emit();
    }).catch(() => {});
    const yearListener = safeSubscribe(dbPaths.yearResults(schoolId, normalized), (value) => {
      yearTree = asRecord(value);
      emit();
    }, {}, onStatus);
    if (!active) {
      // `unsubscribe()` ran while this listener was being created ➔ detach it now.
      yearListener?.();
      return;
    }
    unsubs.push(yearListener);
  };

  if (requestedYear) bindYear(requestedYear);
  else resolveActiveYear(schoolId).then(bindYear).catch(() => {});

  return () => {
    active = false;
    unsubs.forEach((unsub) => unsub?.());
    unsubs.length = 0;
  };
}

/** One-shot read of a past year's flattened results (cross-year history). */
export async function readSessionResults(schoolId, year = '') {
  if (!schoolId || !year) return flatten({});
  const yearKey = normalizeSessionYear(year);
  const partition = asRecord(await safeRead(dbPaths.yearResults(schoolId, yearKey), {}));
  if (Object.keys(partition).length) return flatten(partition);
  return flatten(asRecord(await safeRead(dbPaths.results(schoolId), {})));
}
/**
 * Moves ONE pupil's CURRENT-YEAR result rows from one class to another.
 *
 * Used when a pupil is moved down a class (`এক শ্রেণি নিচে যাবে`) or shifted between
 * classes inside the same academic year: their marks must appear in the TARGET class's
 * current-year result view, otherwise the teacher would keep seeing an empty sheet.
 *
 * Guarantees:
 *  - only `sessions/{year}/results/...` of THIS year is touched;
 *  - every previous academic year stays untouched (frozen history);
 *  - the source class row is removed in the same atomic update, so a pupil is never
 *    counted in two classes at once.
 *
 * @returns {Promise<{synced:boolean, moved:number}>}
 */
export async function moveStudentResultRows(schoolId, year, studentId, fromClassId, toClassId) {
  const yearKey = normalizeSessionYear(year);
  if (!schoolId || !yearKey || !studentId || !fromClassId || !toClassId) return { synced: false, moved: 0 };
  if (toDbClassId(fromClassId) === toDbClassId(toClassId)) return { synced: true, moved: 0 };
  const studentMasterId = await resolveMasterId(schoolId, studentId);
  const sourceRoot = dbPaths.yearResults(schoolId, yearKey);
  const relTo = (absolute) => absolute.slice(sourceRoot.length + 1);

  // The row VALUES travel with the move, so the source rows are read first.
  const rows = await Promise.all(TERM_IDS.map(async (termId) => {
    const raw = await safeRead(yearResultPath(schoolId, yearKey, fromClassId, termId, studentMasterId), null);
    return { termId, row: isObject(raw) ? raw : null };
  }));

  const patch = {};
  let moved = 0;
  rows.forEach(({ termId, row }) => {
    if (!row) return;
    const term = termKey(termId);
    const fromAbsolute = yearResultPath(schoolId, yearKey, fromClassId, term, studentMasterId);
    const toAbsolute = yearResultPath(schoolId, yearKey, toClassId, term, studentMasterId);
    moved += 1;
    patch[relTo(toAbsolute)] = cleanForCloud({
      ...row,
      classId: toDbClassId(toClassId),
      term,
      updatedAt: nowISO(),
    });
    patch[relTo(fromAbsolute)] = null;
  });
  if (!Object.keys(patch).length) return { synced: true, moved: 0 };
  await ensureSchoolYear(schoolId, yearKey);
  const result = await safeUpdate(sourceRoot, patch);
  return { synced: result?.synced !== false, moved };
}

/* ------------------------------------------------------------------ *
 * Reads — one row per student/term inside the year partition
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
 * Explicit component pair ➔ canonical row. The two components are ALWAYS summed, so a
 * genuine ৫০/৫০ split (৩০ + ৩০ = ৬০) is never mistaken for the legacy aggregate shape.
 */
export function buildSubjectMark(formative, summative) {
  const f = numberOrNull(formative);
  const s = numberOrNull(summative);
  if (f === null && s === null) return { formative: null, summative: null, total: null };
  return { formative: f, summative: s, total: subjectTotal(f, s) };
}

/**
 * Auto-save for one subject cell.
 *
 * Three mutually exclusive shapes (see the P0-2 requirement):
 *  1. `component = 'formative' | 'summative'` on a split subject →
 *     `{ formative: fVal, summative: sVal, total: fVal + sVal }`.
 *  2. `component = 'total'` (a single-score subject) → `{ total: value }` and NO
 *     components. The value is never copied into both components, which is what used to
 *     turn a typed `৩০` into a stored `৬০`.
 *  3. An explicit stored `total` is always authoritative on read
 *     (`normalizeSubjectMark`), so a legacy row keeps its own figure.
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
  const isComponent = component === 'formative' || component === 'summative';
  //  • Component edit: keep the other component and re-derive the total from the pair
  //    (a stale stored total must never survive a component change).
  //  • Single-mark edit: store the bare total and clear both components.
  const next = isComponent
    ? buildSubjectMark(
      component === 'formative' ? value : current.formative,
      component === 'summative' ? value : current.summative,
    )
    : { formative: null, summative: null, total: numberOrNull(value) };
  const subjects = { ...priorSubjects, [subjectId]: next };
  return writeResultRow(schoolId, yearKey, classId, term, studentMasterId, {
    ...(isObject(previous) ? previous : {}),
    subjects,
  }, { subjects });
}

/**
 * Bulk Excel save: writes many pupils' marks of ONE term in a single multi-path update.
 *
 * `entries` shape — `{ [studentId]: { [fieldKey]: { component, value } } }` where
 * `fieldKey` is `subjectId` or `subjectId:formative|summative`. Every path is written
 * under the ACTIVE school's own year partition, so nothing can leak between schools.
 * A split subject's `total` is written as the sum of its two components.
 */
export async function saveTermMarksBulk(reference, year, classId, termId, entries = {}, config = null) {
  const yearKey = normalizeSessionYear(year);
  if (!yearKey || !classId) return { synced: false };
  const { byId } = await readStudentMasterIndex(reference);
  const term = termKey(termId);
  const patch = {};
  const now = nowISO();

  Object.entries(asRecord(entries)).forEach(([studentId, fields]) => {
    if (!studentId || !isObject(fields)) return;
    const studentMasterId = byId.get(studentId) || studentId;
    const key = rowRelativeKey(reference, yearKey, classId, term, studentMasterId);
    const perSubject = {};
    Object.entries(fields).forEach(([fieldKey, payload]) => {
      const [subjectId, component = 'total'] = String(fieldKey).split(':');
      if (!subjectId) return;
      perSubject[subjectId] = perSubject[subjectId] ?? {};
      perSubject[subjectId][component] = numberOrNull(payload?.value ?? payload);
    });
    Object.entries(perSubject).forEach(([subjectId, parts]) => {
      const subject = config?.subjects?.find((item) => item.id === subjectId) ?? null;
      if (subject?.split || parts.formative !== undefined || parts.summative !== undefined) {
        // A real component pair is summed (`buildSubjectMark`), never expanded.
        const mark = buildSubjectMark(parts.formative ?? null, parts.summative ?? null);
        patch[`${key}/subjects/${subjectId}/formative`] = mark.formative;
        patch[`${key}/subjects/${subjectId}/summative`] = mark.summative;
        patch[`${key}/subjects/${subjectId}/total`] = mark.total;
        return;
      }
      // Single-score subject: the typed value IS the total — components stay empty so
      // one mark can never be counted twice.
      const total = parts.total ?? null;
      patch[`${key}/subjects/${subjectId}/formative`] = null;
      patch[`${key}/subjects/${subjectId}/summative`] = null;
      patch[`${key}/subjects/${subjectId}/total`] = total;
    });
    patch[`${key}/studentMasterId`] = studentMasterId;
    patch[`${key}/legacyId`] = studentId;
    patch[`${key}/classId`] = toDbClassId(classId);
    patch[`${key}/term`] = term;
    patch[`${key}/updatedAt`] = now;
  });

  if (Object.keys(patch).length === 0) return { synced: true };
  await ensureSchoolYear(reference, yearKey);
  return safeUpdate(rowBasePath(reference, yearKey, classId, term), patch);
}

/** Saves a whole term's subject map at once (paste / import). */
export async function saveStudentTermMarks(schoolId, termId, classId, studentId, marks = {}, year = '') {
  if (!schoolId || !classId || !studentId) return { synced: false };
  const studentMasterId = await resolveMasterId(schoolId, studentId);
  const yearKey = normalizeSessionYear(year);
  const term = termKey(termId);
  const subjects = {};
  Object.entries(asRecord(marks)).forEach(([subjectId, value]) => {
    // An object carrying real components is a split row; anything else is ONE mark.
    const isComponentRow = isObject(value)
      && (value.formative !== undefined || value.summative !== undefined);
    const mark = isComponentRow
      ? buildSubjectMark(value.formative, value.summative)
      : normalizeSubjectMark(value);
    if (mark.formative === null && mark.summative === null && mark.total === null) return;
    // A single mark keeps its components empty so it can never be counted twice.
    subjects[subjectId] = isComponentRow
      ? mark
      : { formative: null, summative: null, total: mark.total };
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
 *
 * `marks` keeps the flat `{ [studentId]: { [subjectId]: { [termId]: number } } }` shape
 * the UI works with. A bare number is ONE mark and is stored as `{ total }` — the single
 * mark is never copied into both components (that doubling is the P0-2 bug).
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

  /** A bare value is ONE mark: it is stored as a total, never doubled into components. */
  const markFromValue = (value) => {
    if (isObject(value)) {
      const isComponentRow = value.formative !== undefined || value.summative !== undefined;
      return isComponentRow
        ? buildSubjectMark(value.formative, value.summative)
        : { formative: null, summative: null, total: numberOrNull(value.total ?? value.mark ?? value.value) };
    }
    return { formative: null, summative: null, total: numberOrNull(value) };
  };

  Object.entries(asRecord(marks)).forEach(([studentId, subjects]) => {
    const student = studentsById.get(studentId);
    if (!student || student.classId === 'archive') return;
    Object.entries(asRecord(subjects)).forEach(([subjectId, terms]) => {
      const keys = Object.keys(asRecord(terms));
      if (keys.length && !keys.some((key) => TERM_IDS.includes(key))) {
        // Already a component map (`{formative, summative}`): apply to every term.
        const mark = markFromValue(terms);
        TERM_IDS.forEach((termId) => setSubject(student, termId, subjectId, mark));
        return;
      }
      Object.entries(asRecord(terms)).forEach(([termId, value]) => {
        if (!TERM_IDS.includes(termId)) return;
        setSubject(student, termId, subjectId, markFromValue(value));
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
      // Keyed by the APP term id (`annual`), so the history viewer can address the
      // locked-in বার্ষিক snapshot exactly like the live tabs do.
      if (isObject(row)) {
        terms[appTermId(termSegment) || termSegment] = normalizeResultRow({ ...row, classId });
      }
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

    const finalResult = terms.annual ?? terms.final ?? null;
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
  buildSubjectMark,
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
  saveTermMarksBulk,
  saveRemark,
  saveRankings,
  saveTermResults,
  syncResultTree,
  deleteStudentResults,
  moveStudentResultRows,
  getStudentCrossYearHistory,
};







