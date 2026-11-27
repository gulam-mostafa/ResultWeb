import { cleanForCloud, safeRead, safeSubscribe, safeUpdate } from './dbFallback.js';
import {
  dbPaths,
  hydrateSchoolLocation,
  normalizeSessionYear,
  resolveSchoolLocation,
  schoolIdOf,
} from './dbPaths.js';
import { CLASS_KEYS } from '../../utils/constants.js';
import { readYearRoster, toAppClassId } from './studentService.js';
import { getStudentCrossYearHistory } from './resultService.js';
import { ensureSchoolYearBuckets, promoteStudentsToNextYear } from './centralSchoolStore.js';

/**
 * sessionService — Permanent Core + Year-Partitioned architecture.
 *
 * ```text
 * …/studentMaster/{studentMasterId}                        ← permanent (lifetime)
 * …/sessions/{year}/students/{classId}/{studentMasterId}   ← that year's enrollment
 * …/sessions/{year}/results/{classId}/{term}/{studentMasterId}
 * …/sessions/{year}/attendance/{date}/{classId}/{studentMasterId}
 * …/sessions/{year}/passedArchive/{studentMasterId}        ← that year's Class-5 leavers
 * schoolData/{schoolId}/sessionsIndex/{year}               ← opened-year registry
 * ```
 *
 * A past year is immutable history: switching to it only *reads*. Year-end
 * promotion never edits `sessions/{currentYear}/students` — it writes the next
 * year's enrollment rows (same `studentMasterId`) and files Class-5 leavers into
 * `sessions/{currentYear}/passedArchive`.
 */

const asRecord = (value) => (value && typeof value === 'object' && !Array.isArray(value) ? value : {});
const isObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/** Current calendar year as the default academic year. */
export const currentSessionYear = () => String(new Date().getFullYear());

/** Offsets used by the topbar selector when a school has no session index yet. */
export function defaultSessionYears(base) {
  const year = Number(normalizeSessionYear(base, currentSessionYear())) || Number(currentSessionYear());
  return [year - 1, year, year + 1].filter((value) => value > 1990).map(String);
}

/**
 * `ensureSchoolYearBuckets` resolved from a bare `schoolId`: the location comes from
 * the in-memory cache, or is hydrated from `schoolLocator/{schoolId}`. Returns
 * `{ synced: false, reason }` (never throws) when the hierarchy is unknown.
 */
async function ensureSchoolYearBucketsForSchool(schoolId, year) {
  const reference = schoolIdOf(schoolId);
  if (!reference) return { synced: false, reason: 'missing-school' };
  const location = resolveSchoolLocation(reference) ?? await hydrateSchoolLocation(reference);
  if (!location) return { synced: false, reason: 'missing-location' };
  return ensureSchoolYearBuckets(location, year);
}

/** Live index of opened academic years: `{ 2026: { year, startedAt } }`. */
export function subscribeSessions(schoolId, callback, onStatus) {
  if (!schoolId) { callback({}); return () => {}; }
  return safeSubscribe(dbPaths.sessions(schoolId), (value) => callback(asRecord(value)), {}, onStatus);
}

export async function readSessions(schoolId) {
  if (!schoolId) return {};
  return asRecord(await safeRead(dbPaths.sessions(schoolId), {}));
}

/**
 * Opens (or re-opens) an academic year. Safe to call repeatedly — the existing
 * node is preserved so a past year is never wiped by a later visit.
 *
 * Opening a year also materialises that year's campus skeleton
 * (`profile`, `studentMaster`, `teachers`, `sessions/{year}/students/{classId}`,
 * `results/{classId}`, `passedArchive`) through `ensureSchoolYearBuckets`, which is
 * exactly the same helper the student/result services call on every write.
 */
export async function ensureSession(schoolId, year, meta = {}) {
  const normalized = normalizeSessionYear(year);
  if (!schoolId || !normalized) return { synced: false, year: '' };
  const existing = await safeRead(dbPaths.sessionMeta(schoolId, normalized), null);
  const buckets = await ensureSchoolYearBucketsForSchool(schoolId, normalized);
  if (existing && typeof existing === 'object') {
    return { synced: buckets.synced !== false, year: normalized, created: false, buckets };
  }
  const result = await safeUpdate(dbPaths.sessionMeta(schoolId, normalized), cleanForCloud({
    year: normalized,
    startedAt: new Date().toISOString(),
    ...meta,
  }));
  return { ...result, year: normalized, created: true, buckets };
}

/** Every academic year that exists for a school (registry + year nodes), newest first. */
export async function readSessionYears(schoolId) {
  if (!schoolId) return [];
  const root = `${(dbPaths.studentMaster(schoolId) || '').replace(/\/studentMaster$/, '')}/sessions`;
  const [registry, nodes] = await Promise.all([
    safeRead(dbPaths.sessions(schoolId), {}),
    safeRead(root, {}),
  ]);
  return [...new Set([
    ...Object.keys(asRecord(registry)),
    ...Object.keys(asRecord(nodes)),
  ].map((year) => normalizeSessionYear(year)).filter(Boolean))].sort((a, b) => Number(b) - Number(a));
}

/** Reads one year's merged roster (permanent identity + that year's enrollment). */
export async function readSessionStudents(schoolId, year) {
  if (!schoolId || !year) return { students: [], archive: [] };
  return readYearRoster(schoolId, normalizeSessionYear(year));
}

/** Reads the permanent alumni (Class-5 graduate) archive. */
export async function readAlumniArchive(schoolId) {
  if (!schoolId) return [];
  return Object.values(asRecord(await safeRead(dbPaths.alumniArchive(schoolId), {})));
}

/** Copies one student node into the permanent alumni archive. */
export function archiveAlumnus(schoolId, student) {
  if (!schoolId || !student?.id) return Promise.resolve({ synced: false });
  const id = student.studentMasterId || student.id;
  return safeUpdate(dbPaths.alumniArchive(schoolId), {
    [id]: cleanForCloud({
      ...student,
      studentMasterId: id,
      graduatedYear: student.graduatedYear || student.session || '',
      archivedAt: new Date().toISOString(),
    }),
  });
}
/* ------------------------------------------------------------------ *
 * Year-end promotion
 * ------------------------------------------------------------------ */

/**
 * Class progression: pre-primary ➔ class-1 … class-4 ➔ class-5, and class-5 ➔
 * `archive` (the pupil leaves primary school inside the same year node).
 * Keyed by the app ids the roster exposes (`pre`, `c1` …) — `toDbClassId` converts
 * them to storage keys when a path is built.
 */
export const NEXT_SESSION_CLASS = Object.freeze({
  pre: 'c1',
  c1: 'c2',
  c2: 'c3',
  c3: 'c4',
  c4: 'c5',
  c5: 'archive',
  [CLASS_KEYS.PRE_PRIMARY]: CLASS_KEYS.CLASS_1,
  [CLASS_KEYS.CLASS_1]: CLASS_KEYS.CLASS_2,
  [CLASS_KEYS.CLASS_2]: CLASS_KEYS.CLASS_3,
  [CLASS_KEYS.CLASS_3]: CLASS_KEYS.CLASS_4,
  [CLASS_KEYS.CLASS_4]: CLASS_KEYS.CLASS_5,
  [CLASS_KEYS.CLASS_5]: 'archive',
});

/** Classes that stay in school next year (everything below Class 5). */
export const PROMOTABLE_CLASS_KEYS = Object.freeze([
  CLASS_KEYS.PRE_PRIMARY,
  CLASS_KEYS.CLASS_1,
  CLASS_KEYS.CLASS_2,
  CLASS_KEYS.CLASS_3,
  CLASS_KEYS.CLASS_4,
]);

export const GRADUATING_CLASS_KEY = CLASS_KEYS.CLASS_5;

/** Next session key: one calendar year on from `year`. */
export const nextSessionYear = (year) => {
  const base = Number(normalizeSessionYear(year, currentSessionYear())) || Number(currentSessionYear());
  return String(base + 1);
};

/**
 * Reads the class/term merit positions for a whole year.
 * `{ [classId]: { [studentMasterId]: { meritPosition, gpa, grade, grandTotal } } }`
 * — taken from the final (annual) term first, falling back to the latest term read.
 */
export async function readYearMerits(schoolId, year) {
  const yearKey = normalizeSessionYear(year);
  if (!schoolId || !yearKey) return {};
  const tree = asRecord(await safeRead(dbPaths.yearResults(schoolId, yearKey), {}));
  const merits = {};
  Object.entries(tree).forEach(([classId, terms]) => {
    const finalTerm = asRecord(terms).final ?? asRecord(terms).annual;
    const candidates = finalTerm
      ? Object.entries(asRecord(finalTerm))
      : Object.entries(asRecord(terms)).slice(-1).flatMap(([, rows]) => Object.entries(asRecord(rows)));
    candidates.forEach(([studentMasterId, row]) => {
      if (!isObject(row)) return;
      const meritPosition = Number(row.meritPosition ?? row.rank);
      merits[classId] = merits[classId] ?? {};
      merits[classId][studentMasterId] = {
        meritPosition: Number.isFinite(meritPosition) && meritPosition > 0 ? meritPosition : null,
        gpa: row.gpa ?? null,
        grade: row.grade ?? '',
        grandTotal: row.grandTotal ?? row.total ?? null,
      };
    });
  });
  return merits;
}

/**
 * Orders one class's promotion candidates by final merit position.
 * Pupils without a published position keep their current roll order behind the
 * ranked pupils, so a missing marking sheet never blocks the promotion.
 */
export function orderByMerit(students = [], merits = {}) {
  const ranked = [...students].map((student) => {
    const merit = merits?.[student.studentMasterId] ?? merits?.[student.id] ?? {};
    return { student, meritPosition: merit.meritPosition ?? null, merit };
  });
  ranked.sort((a, b) => {
    if (a.meritPosition && b.meritPosition) return a.meritPosition - b.meritPosition;
    if (a.meritPosition) return -1;
    if (b.meritPosition) return 1;
    return (Number(a.student.roll) || 0) - (Number(b.student.roll) || 0);
  });
  return ranked.map((entry, index) => ({ ...entry, roll: index + 1 }));
}
/**
 * Year-end promotion (`sessions/{currentYear}` ➔ `sessions/{nextYear}`).
 *
 * Guarantees:
 *  - `sessions/{currentYear}/students`, `/results` and `/attendance` are **never**
 *    modified — the finished year stays complete history;
 *  - promoted pupils keep the exact same `studentMasterId` and receive a new roll
 *    ordered by their final merit position in the destination class;
 *  - Class-5 leavers are filed into `sessions/{currentYear}/passedArchive/{id}` and
 *    their permanent `studentMaster/{id}/overallStatus` becomes `'graduated'`.
 *
 * @param {{year?:string, nextYear?:string, decisions?:Array<{studentId?:string, studentMasterId?:string, action?:'promote'|'retain'|'demote'}>, advanceProfileYear?:boolean}} options
 *   `advanceProfileYear` (default `true`) moves `profile.activeYear` to the
 *   destination year. Per-class promotion passes `false`: the year only advances
 *   when EVERY class is complete, decided by the caller — never by one class.
 * @returns {Promise<{synced:boolean, year:string, nextYear:string, promoted:number, graduated:number, retained:number, demoted:number}>}
 */
export async function promoteSession(schoolId, { year = '', nextYear = '', decisions = [], advanceProfileYear = true } = {}) {
  const fromYear = normalizeSessionYear(year, currentSessionYear());
  const empty = {
    synced: false, year: fromYear, nextYear: '', promoted: 0, graduated: 0, retained: 0, demoted: 0,
  };
  if (!schoolId || !fromYear) return empty;

  const toYear = normalizeSessionYear(nextYear, nextSessionYear(fromYear));
  if (!toYear || toYear === fromYear) return { ...empty, reason: 'invalid-target-year' };

  const decisionMap = new Map(
    (decisions ?? [])
      .map((item) => [item.studentMasterId || item.studentId, item.action || 'promote'])
      .filter(([id]) => Boolean(id)),
  );

  // The merged roster (permanent identity + this year's enrolments) is read here and
  // handed to the central promotion, so the roll order and the counts always agree
  // with what the teacher saw on screen.
  const roster = await readYearRoster(schoolId, fromYear);

  let retained = 0;
  let demoted = 0;
  roster.students.forEach((student) => {
    const action = decisionMap.get(student.studentMasterId) || decisionMap.get(student.id) || 'promote';
    if (action === 'retain') retained += 1;
    if (action === 'demote') demoted += 1;
  });

  // Promotion writes are hierarchical only: without a complete location there is no
  // `sessions/{year}` node to promote into, so the caller is told instead of a legacy
  // flat roster being written behind the school's back.
  const location = resolveSchoolLocation(schoolId) ?? await hydrateSchoolLocation(schoolId);
  if (!location) return { ...empty, reason: 'missing-location' };

  const promotedAt = new Date().toISOString();
  // `advanceProfileYear: false` is the per-class promotion: the roster moves but the
  // school's active year stays put — it only advances when EVERY class is done, and
  // that is decided (and written) by the caller, never here by surprise.
  const result = await promoteStudentsToNextYear(location, fromYear, toYear, {
    decisions,
    students: roster.students,
    advanceProfileYear,
  });
  if (result?.synced === false) return { ...empty, nextYear: toYear, reason: result?.reason ?? 'write-failed' };

  await ensureSession(schoolId, toYear, { promotedFrom: fromYear, promotedAt });

  return {
    synced: true,
    year: fromYear,
    nextYear: toYear,
    // `promotedCount` counts every non-graduate move — promoted, retained AND
    // demoted — so the truly-promoted figure subtracts the other two, otherwise
    // the "উত্তীর্ণ X জন" message would count retained pupils as promoted.
    promoted: Math.max(0, (result.promotedCount ?? 0) - retained - demoted),
    graduated: result.archivedCount ?? 0,
    retained,
    demoted,
  };
}
/* ------------------------------------------------------------------ *
 * Cross-year history
 * ------------------------------------------------------------------ */

/**
 * One pupil's complete history, linked by their permanent `studentMasterId`.
 * Delegates to `resultService.getStudentCrossYearHistory` (results live there) and
 * adds a compact `enrollments` view (`year`, `classId`, `roll`, `section`).
 */
export async function readStudentCrossYearHistory(schoolId, studentMasterId) {
  const empty = { studentMasterId: studentMasterId ?? '', studentMaster: null, years: [], enrollments: [] };
  if (!schoolId || !studentMasterId) return empty;
  const history = await getStudentCrossYearHistory(schoolId, studentMasterId);
  return {
    ...history,
    enrollments: (history.years ?? []).map((entry) => ({
      year: entry.year,
      classId: entry.classId,
      roll: entry.roll,
      section: entry.section,
      status: entry.status,
    })),
  };
}

/**
 * Backwards-compatible enrollment history: `[{ year, student, classId }]`, newest
 * first. Reads one merged roster per known year in parallel.
 */
export async function readStudentHistory(schoolId, studentMasterId) {
  if (!schoolId || !studentMasterId) return [];
  const years = await readSessionYears(schoolId);
  if (years.length === 0) return [];
  const snapshots = await Promise.all(years.map(async (year) => {
    const { students, archive } = await readSessionStudents(schoolId, year);
    const student = [...students, ...archive].find(
      (item) => (item.studentMasterId || item.id) === studentMasterId,
    );
    if (!student) return null;
    return { year, student: { ...student, classId: student.classId }, classId: student.classId };
  }));
  return snapshots.filter(Boolean);
}

export default {
  currentSessionYear,
  defaultSessionYears,
  subscribeSessions,
  readSessions,
  ensureSession,
  readSessionYears,
  readSessionStudents,
  readAlumniArchive,
  archiveAlumnus,
  nextSessionYear,
  readYearMerits,
  orderByMerit,
  promoteSession,
  readStudentHistory,
  readStudentCrossYearHistory,
  NEXT_SESSION_CLASS,
  PROMOTABLE_CLASS_KEYS,
  GRADUATING_CLASS_KEY,
};




