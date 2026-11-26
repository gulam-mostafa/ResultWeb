/* ------------------------------------------------------------------ *
 * WRITE TRUTH — একটাই লেখার ঠিকানা (single write truth)
 * ------------------------------------------------------------------ *
 * সব নতুন লেখা (write) যায় ক্যানোনিক্যাল hierarchical পাথে:
 *   divisions/{divisionId}/districts/{districtId}/upazilas/{upazilaId}
 *     /schools/{schoolId}/sessions/{year}/...
 * `writeSchoolBase(reference)` সেই ঠিকানাই দেয় — location অজানা থাকলে '' দেয়,
 * কখনো legacy-তে ফেলে দেয় না (লেখার caller-কে তখন লেখা বন্ধ করতে হবে)।
 *
 * পুরনো `schoolData/{schoolId}` গাছ থেকে শুধু পড়া যায় (read fallback):
 * পুরনো ডেটা কখনো মোছা হয় না, কোনো পুরনো রো-কে orphan করা হয় না।
 * নিচের `students` / `results` / `session*` হেল্পারগুলো সেই fallback-এর
 * জন্যই আছে — নতুন কোনো লেখায় এগুলো ব্যবহার করা যাবে না।
 * লিগ্যাসি মিরর লেখা (addStudentCloud / updateStudentCloud / import) থেকে
 * সরানো হয়েছে; `moveStudentsCloud` / `saveStudents` শুধু পুরনো yearless
 * ডেটার batch helper হিসেবে রয়ে গেছে — live-DB যাচাই ছাড়া সেগুলোও
 * সরানো যাবে না (দেখুন studentService.js)।
 */
import { resolveTermKey } from '../../utils/constants.js';
import { safeRead } from './dbFallback.js';

const segment = (value) => String(value ?? '').trim().replace(/[.#$/\[\]]/g, '_');

/** Legacy nodes store the annual term as `annual` — every existing reader relies on it. */
const termSegment = (term) => segment(resolveTermKey(term) || 'final');

/** New hierarchical nodes use the canonical key: `term1` | `term2` | `final`. */
const finalSegment = (term) => {
  const key = segment(term);
  return !key || key === 'annual' ? 'final' : key;
};

const BANGLA_DIGITS = { '০': '0', '১': '1', '২': '2', '৩': '3', '৪': '4', '৫': '5', '৬': '6', '৭': '7', '৮': '8', '৯': '9' };

/** Normalises "২০২৬", "2026" and "2026-01-01" to the canonical `2026` session key. */
export function normalizeSessionYear(value, fallback = '') {
  const ascii = String(value ?? '').replace(/[০-৯]/g, (digit) => BANGLA_DIGITS[digit] ?? digit);
  const match = ascii.match(/\d{4}/);
  if (match) return match[0];
  return String(fallback ?? '').trim();
}

/**
 * শাখা (section) a roster row belongs to when no section was ever stored.
 * A section is a folder inside the class node:
 * `…/sessions/{year}/students/{classId}/{sectionId}/{studentMasterId}`.
 */
export const DEFAULT_SECTION_ID = 'ক';

/** Storage segment of one section folder; a blank label falls back to the default শাখা. */
export const sectionSegment = (section, fallback = DEFAULT_SECTION_ID) =>
  segment(section) || segment(fallback) || DEFAULT_SECTION_ID;

/* ------------------------------------------------------------------ *
 * Hierarchy roots
 * ------------------------------------------------------------------ */
const SCHOOL_INDEX_ROOT = 'schoolIndex';
const SCHOOL_LOCATOR_ROOT = 'schoolLocator';
const USERS_ROOT = 'users';
const LEGACY_SCHOOL_ROOT = 'schoolData';

/** First non-blank value of the given keys (a blank edit never wipes a cache). */
const firstFilled = (source, keys) => {
  for (let index = 0; index < keys.length; index += 1) {
    const value = source?.[keys[index]];
    if (value !== undefined && value !== null && String(value).trim() !== '') return value;
  }
  return '';
};

const filledEntries = (source) => Object.fromEntries(
  Object.entries(source ?? {}).filter(
    ([, value]) => value !== undefined && value !== null && String(value).trim() !== '',
  ),
);

/**
 * Normalises every shape a school location travels in (`divisionId`/`division`,
 * `schoolId`/`id`, …) into the canonical quadruple. Returns `null` when the
 * location is incomplete — a half-built path would write a school's data to the
 * wrong node, so callers fall back to the legacy flat workspace instead.
 */
export function normalizeLocation(location) {
  if (!location || typeof location !== 'object') return null;
  const divisionId = segment(firstFilled(location, ['divisionId', 'division']));
  const districtId = segment(firstFilled(location, ['districtId', 'district']));
  const upazilaId = segment(firstFilled(location, ['upazilaId', 'upazila']));
  const schoolId = segment(firstFilled(location, ['schoolId', 'id']));
  if (!divisionId || !districtId || !upazilaId || !schoolId) return null;
  return { divisionId, districtId, upazilaId, schoolId };
}

/** Reads the `schoolId` from either a location object or a bare id string. */
export const schoolIdOf = (reference) => (reference && typeof reference === 'object'
  ? segment(firstFilled(reference, ['schoolId', 'id']))
  : segment(reference));

/* ------------------------------------------------------------------ *
 * Location memory — building a path is synchronous, the database is not.
 * The registry / profile / member services populate this cache the moment they
 * learn where a school lives, so a later `schoolId`-only call can resolve to the
 * hierarchical node without another round-trip.
 * ------------------------------------------------------------------ */
const schoolLocationCache = new Map();

/** Remembers (and merges) a school's location; returns the canonical object. */
export function rememberSchoolLocation(location) {
  if (!location || typeof location !== 'object') return null;
  const schoolId = schoolIdOf(location);
  const cached = schoolId ? schoolLocationCache.get(schoolId) : null;
  const merged = normalizeLocation({ ...(cached ?? {}), ...filledEntries(location) });
  if (!merged) return null;
  schoolLocationCache.set(merged.schoolId, merged);
  return merged;
}

export function forgetSchoolLocation(reference) {
  const schoolId = schoolIdOf(reference);
  return schoolId ? schoolLocationCache.delete(schoolId) : false;
}

/** Cached location for a school, or `null` while it is still unknown. */
export function resolveSchoolLocation(reference) {
  const schoolId = schoolIdOf(reference);
  return schoolId ? (schoolLocationCache.get(schoolId) ?? null) : null;
}

/** Hierarchical base for a location, or `''` while the location is unknown. */
export function resolveSchoolBase(reference) {
  const location = reference && typeof reference === 'object'
    ? (rememberSchoolLocation(reference) ?? resolveSchoolLocation(reference))
    : resolveSchoolLocation(reference);
  return location ? getSchoolBasePath(location) : '';
}

/**
 * WRITE TRUTH: the hierarchical tenant root for new writes, or `''` when the
 * location is unknown. Unlike `baseOrLegacy` it NEVER falls back to
 * `schoolData/{schoolId}` — a caller that gets `''` must refuse the write
 * (see `tenantBasePath` in useStudents.js) instead of writing to the legacy tree.
 */
export function writeSchoolBase(reference) {
  return resolveSchoolBase(reference);
}

/**
 * Resolves (and caches) a school's location from `schoolLocator/{schoolId}`.
 * Lets services that only receive a `schoolId` (e.g. a restored session) reach
 * the hierarchical node without scanning the nationwide tree.
 */
export async function hydrateSchoolLocation(reference) {
  const cached = resolveSchoolLocation(reference)
    ?? (reference && typeof reference === 'object' ? rememberSchoolLocation(reference) : null);
  if (cached) return cached;
  const schoolId = schoolIdOf(reference);
  if (!schoolId) return null;
  try {
    const pointer = await safeRead(getSchoolLocatorPath(schoolId), null);
    if (!pointer || pointer.isDeleted) return null;
    return rememberSchoolLocation({ ...pointer, schoolId });
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ *
 * Hierarchical path builders
 * ------------------------------------------------------------------ */

/** `divisions/{divisionId}/districts/{districtId}/upazilas/{upazilaId}/schools/{schoolId}` */
export function getSchoolBasePath(location) {
  const normalized = normalizeLocation(location);
  if (!normalized) return '';
  const { divisionId, districtId, upazilaId, schoolId } = normalized;
  return `divisions/${divisionId}/districts/${districtId}/upazilas/${upazilaId}/schools/${schoolId}`;
}

/** One Upazila's lightweight dropdown index. */
export function getSchoolIndexPath(divisionId, districtId, upazilaId) {
  return `${SCHOOL_INDEX_ROOT}/${segment(divisionId)}/${segment(districtId)}/${segment(upazilaId)}`;
}

/** One lightweight school record: `schoolIndex/{division}/{district}/{upazila}/{schoolId}`. */
export function getSchoolIndexEntryPath(divisionId, districtId, upazilaId, schoolId) {
  return `${getSchoolIndexPath(divisionId, districtId, upazilaId)}/${segment(schoolId)}`;
}

/** `users/{uid}` — the signed-in teacher's school pointer. */
export function getUserPath(uid) {
  return `${USERS_ROOT}/${segment(uid)}`;
}

/** `schoolLocator/{schoolId}` — schoolId ➔ division/district/upazila pointer. */
export function getSchoolLocatorPath(schoolId) {
  return `${SCHOOL_LOCATOR_ROOT}/${segment(schoolId)}`;
}

/** Legacy flat workspace root, still used by year-less service calls. */
const legacyRoot = (schoolId) => `${LEGACY_SCHOOL_ROOT}/${segment(schoolId)}`;

/**
 * Hierarchical equivalents. They degrade to the legacy flat workspace while a
 * school's location is still unknown (fresh cache, offline first paint), so no
 * call ever throws or silently drops a write.
 */
const baseOrLegacy = (reference) => resolveSchoolBase(reference) || legacyRoot(schoolIdOf(reference));

const profileOrLegacy = (reference) => {
  const base = resolveSchoolBase(reference);
  return base ? `${base}/profile` : `${legacyRoot(schoolIdOf(reference))}/profile`;
};

const collectionOrLegacy = (reference, node) => `${baseOrLegacy(reference)}/${node}`;

const sessionOrLegacy = (reference, year) =>
  `${baseOrLegacy(reference)}/sessions/${segment(normalizeSessionYear(year, 'default'))}`;

const sessionRoot = (schoolId, year) => `${legacyRoot(schoolId)}/sessions/${segment(normalizeSessionYear(year, 'default'))}`;

/**
 * Canonical Realtime Database layout.
 *
 * ```text
 * # 1. Nationwide lightweight dropdown index (tiny records only)
 * schoolIndex/{divisionId}/{districtId}/{upazilaId}/{schoolId}
 *     = { id, name, emisCode, divisionId, districtId, upazilaId }
 *
 * # 2. Full tenant tree (heavy data, opened only for the active school)
 * divisions/{divisionId}/districts/{districtId}/upazilas/{upazilaId}/schools/{schoolId}
 *     /profile                            ← permanent identity
 *     /teachers/{uid}                     ← permanent, soft-deleted (isDeleted)
 *     /studentMaster/{studentMasterId}    ← permanent pupil identity
 *     /sessions/{year}/students/{classId}/{studentMasterId}
 *     /sessions/{year}/results/{classId}/{term}/{studentMasterId}
 *     /sessions/{year}/attendance/{date}/{classId}/{studentMasterId}
 *     /sessions/{year}/passedArchive/{studentMasterId}
 *
 * # 3. Lookups
 * users/{uid}         = { schoolId, divisionId, districtId, upazilaId, role, name }
 * schoolLocator/{id}  = { schoolId, divisionId, districtId, upazilaId }
 * ```
 *
 * The helpers degrade to the legacy flat workspace (`schoolData/{schoolId}/…`)
 * while a school's location is still unknown (fresh cache / offline first paint),
 * so existing nodes stay readable and no write is ever silently dropped.
 * READ ONLY, however: `writeSchoolBase()` never degrades, and every new write
 * helper (`saveNewStudent`, `saveStudentPatch`, `importStudentsCloud`, …) refuses
 * to write when the hierarchical reference is incomplete. */
export const dbPaths = Object.freeze({
  visitors: () => 'visitors',
  visitor: (visitorId) => `visitors/${segment(visitorId)}`,

  /* ---------------- Hierarchical school directory ---------------- */
  /** Full tenant tree root: `divisions/…/upazilas/…/schools/{schoolId}`. */
  schoolBase: (location) => getSchoolBasePath(location),
  /** Every lightweight record, nationwide: `schoolIndex`. */
  schoolIndexAll: () => SCHOOL_INDEX_ROOT,
  /** One Upazila's dropdown index: `schoolIndex/{division}/{district}/{upazila}`. */
  schoolIndex: (divisionId, districtId, upazilaId) => getSchoolIndexPath(divisionId, districtId, upazilaId),
  /** One dropdown record: `schoolIndex/…/{schoolId}`. */
  schoolIndexEntry: (divisionId, districtId, upazilaId, schoolId) =>
    getSchoolIndexEntryPath(divisionId, districtId, upazilaId, schoolId),
  /** schoolId ➔ location pointer: `schoolLocator/{schoolId}`. */
  schoolLocator: (schoolId) => getSchoolLocatorPath(schoolId),

  /* ---------------- Legacy directory nodes (read-only history) ---------------- */
  registry: () => 'schoolRegistry',
  schools: (division, district, upazila) => `schoolRegistry/${segment(division)}/${segment(district)}/${segment(upazila)}`,
  school: (division, district, upazila, schoolId) => `schoolRegistry/${segment(division)}/${segment(district)}/${segment(upazila)}/${segment(schoolId)}`,
  schoolLoose: (schoolId) => `schoolRegistryIndex/${segment(schoolId)}`,

  /* ---------------- Permanent school-lifetime nodes ---------------- */
  /** Legacy flat workspace root — the fallback while the location is unknown. */
  workspace: (schoolId) => legacyRoot(schoolId),
  /** Hierarchical profile (falls back to the legacy node while unknown). */
  profile: (reference) => profileOrLegacy(reference),
  legacyProfile: (schoolId) => `${legacyRoot(schoolId)}/profile`,
  meta: (schoolId) => `${legacyRoot(schoolId)}/meta`,
  /** Teaching staff — soft-deleted (`isDeleted`) instead of being removed. */
  teachers: (reference) => collectionOrLegacy(reference, 'teachers'),
  teacher: (reference, uid) => `${collectionOrLegacy(reference, 'teachers')}/${segment(uid)}`,
  /** Legacy alias: the roster used to live under `members`. */
  members: (reference) => collectionOrLegacy(reference, 'teachers'),
  member: (reference, memberId) => `${collectionOrLegacy(reference, 'teachers')}/${segment(memberId)}`,
  legacyMembers: (schoolId) => `${legacyRoot(schoolId)}/members`,
  legacyMember: (schoolId, memberId) => `${legacyRoot(schoolId)}/members/${segment(memberId)}`,
  /** Permanent pupil identities, keyed by the unique `studentMasterId`. */
  studentMaster: (reference) => collectionOrLegacy(reference, 'studentMaster'),
  studentMasterEntry: (reference, studentMasterId) =>
    `${collectionOrLegacy(reference, 'studentMaster')}/${segment(studentMasterId)}`,
  /**
   * `…/studentMasterCounters/{year}` — the per-year admission sequence that
   * `generateStudentMasterId()` bumps with an atomic RTDB transaction, so two teachers
   * admitting a pupil at the same moment can never mint the same id.
   */
  studentMasterCounter: (reference, year) =>
    `${collectionOrLegacy(reference, 'studentMasterCounters')}/${segment(normalizeSessionYear(year, 'default'))}`,
  /* ---------------- Legacy flat roster / results (READ FALLBACK ONLY) ----------------
   * These nodes are read for old data only — no new write may target them.
   * New writes go to the hierarchical `year*` helpers above. */
  students: (schoolId) => `${legacyRoot(schoolId)}/students`,
  student: (schoolId, studentId) => `${legacyRoot(schoolId)}/students/${segment(studentId)}`,
  archive: (schoolId) => `${legacyRoot(schoolId)}/archive`,
  archivedStudent: (schoolId, studentId) => `${legacyRoot(schoolId)}/archive/${segment(studentId)}`,
  results: (schoolId) => `${legacyRoot(schoolId)}/results`,
  resultTerm: (schoolId, term, classId) => `${legacyRoot(schoolId)}/results/${termSegment(term)}/${segment(classId)}`,
  resultStudent: (schoolId, term, classId, studentId) => `${legacyRoot(schoolId)}/results/${termSegment(term)}/${segment(classId)}/${segment(studentId)}`,
  notices: (schoolId) => `${legacyRoot(schoolId)}/notices`,
  attendance: (schoolId) => `${legacyRoot(schoolId)}/attendance`,
  attendanceDay: (schoolId, date) => `${legacyRoot(schoolId)}/attendance/${segment(date)}`,
  attendanceRecord: (schoolId, date, studentId) => `${legacyRoot(schoolId)}/attendance/${segment(date)}/${segment(studentId)}`,
  audits: (schoolId) => `${legacyRoot(schoolId)}/audits`,
  /** 5th-grade graduates — permanent, never cleared by a session switch. */
  alumniArchive: (schoolId) => `${legacyRoot(schoolId)}/alumniArchive`,
  alumni: (schoolId, studentId) => `${legacyRoot(schoolId)}/alumniArchive/${segment(studentId)}`,
  /** Registry of academic years that have been opened for this school. */
  sessions: (schoolId) => `${legacyRoot(schoolId)}/sessionsIndex`,
  sessionMeta: (schoolId, year) => `${legacyRoot(schoolId)}/sessionsIndex/${segment(normalizeSessionYear(year, 'default'))}`,

  /* ---------------- Legacy academic-year partitioned nodes (READ FALLBACK ONLY) ----------------
   * Older `sessions/{year}/students/{studentId}` layout — read for old data only.
   * New writes use the `year*` helpers (শাখা folders). */
  session: (schoolId, year) => sessionRoot(schoolId, year),
  sessionStudents: (schoolId, year) => `${sessionRoot(schoolId, year)}/students`,
  sessionStudent: (schoolId, year, studentId) => `${sessionRoot(schoolId, year)}/students/${segment(studentId)}`,
  sessionArchive: (schoolId, year) => `${sessionRoot(schoolId, year)}/archive`,
  sessionArchivedStudent: (schoolId, year, studentId) => `${sessionRoot(schoolId, year)}/archive/${segment(studentId)}`,
  sessionResults: (schoolId, year) => `${sessionRoot(schoolId, year)}/results`,
  sessionResultTerm: (schoolId, year, term) => `${sessionRoot(schoolId, year)}/results/${termSegment(term)}`,
  sessionResultClass: (schoolId, year, term, classId) => `${sessionRoot(schoolId, year)}/results/${termSegment(term)}/${segment(classId)}`,
  sessionResultStudent: (schoolId, year, term, classId, studentId) => `${sessionRoot(schoolId, year)}/results/${termSegment(term)}/${segment(classId)}/${segment(studentId)}`,
  sessionAttendance: (schoolId, year) => `${sessionRoot(schoolId, year)}/attendance`,
  sessionAttendanceDay: (schoolId, year, date) => `${sessionRoot(schoolId, year)}/attendance/${segment(date)}`,
  sessionAttendanceRecord: (schoolId, year, date, studentId) => `${sessionRoot(schoolId, year)}/attendance/${segment(date)}/${segment(studentId)}`,

  /* ---------------- Hierarchical year-partitioned nodes ---------------- */
  /** `…/schools/{schoolId}/sessions/{year}` */
  yearSession: (reference, year) => sessionOrLegacy(reference, year),
  /** `…/sessions/{year}/students/{classId}/{studentMasterId}` */
  yearStudents: (reference, year) => `${sessionOrLegacy(reference, year)}/students`,
  yearStudent: (reference, year, classId, studentMasterId) =>
    `${sessionOrLegacy(reference, year)}/students/${segment(classId)}/${segment(studentMasterId)}`,
  /** `…/sessions/{year}/students/{classId}/{sectionId}` — one শাখা folder of a class. */
  yearSectionStudents: (reference, year, classId, sectionId) =>
    `${sessionOrLegacy(reference, year)}/students/${segment(classId)}/${sectionSegment(sectionId)}`,
  /** `…/sessions/{year}/students/{classId}/{sectionId}/{studentMasterId}` — current layout. */
  yearSectionStudent: (reference, year, classId, sectionId, studentMasterId) =>
    `${sessionOrLegacy(reference, year)}/students/${segment(classId)}/${sectionSegment(sectionId)}/${segment(studentMasterId)}`,
  /** `…/sessions/{year}/results/{classId}/{term}/{studentMasterId}` */
  yearResults: (reference, year) => `${sessionOrLegacy(reference, year)}/results`,
  yearResultClass: (reference, year, classId) => `${sessionOrLegacy(reference, year)}/results/${segment(classId)}`,
  yearResult: (reference, year, classId, term, studentMasterId) =>
    `${sessionOrLegacy(reference, year)}/results/${segment(classId)}/${finalSegment(term)}/${segment(studentMasterId)}`,
  /** `…/sessions/{year}/attendance/{date}/{classId}/{studentMasterId}` */
  yearAttendance: (reference, year) => `${sessionOrLegacy(reference, year)}/attendance`,
  yearAttendanceDay: (reference, year, date) => `${sessionOrLegacy(reference, year)}/attendance/${segment(date)}`,
  yearAttendanceRecord: (reference, year, date, classId, studentMasterId) =>
    `${sessionOrLegacy(reference, year)}/attendance/${segment(date)}/${segment(classId)}/${segment(studentMasterId)}`,
  /**
   * `…/sessions/{year}/meta` — the year's own metadata (session stamp, promotion
   * log and the শাখা registry every teacher reads).
   */
  yearMeta: (reference, year) => `${sessionOrLegacy(reference, year)}/meta`,
  /**
   * `…/sessions/{year}/meta/sections` — the class ➔ শাখা registry:
   * `{classId: {sectionId: true}}`. A শাখা is a folder inside a class node, and an
   * empty folder cannot exist in the Realtime Database, so the registry is what lets
   * a brand-new শাখা appear (with a count of ০) before its first admission.
   */
  yearMetaSections: (reference, year) => `${sessionOrLegacy(reference, year)}/meta/sections`,
  yearMetaSection: (reference, year, classId) =>
    `${sessionOrLegacy(reference, year)}/meta/sections/${segment(classId)}`,
  yearMetaSectionEntry: (reference, year, classId, sectionId) =>
    `${sessionOrLegacy(reference, year)}/meta/sections/${segment(classId)}/${sectionSegment(sectionId)}`,
  /** `…/sessions/{year}/passedArchive/{studentMasterId}` — that year's Class-5 graduates. */
  yearPassedArchive: (reference, year) => `${sessionOrLegacy(reference, year)}/passedArchive`,
  /**
   * `…/sessions/{year}/passedArchive/years/{year}/{studentMasterId}` — the year-wise
   * archive folder a graduate is filed into, so a school can list "who passed in
   * which year" without reading every year node.
   */
  yearPassedArchiveYears: (reference, year) => `${sessionOrLegacy(reference, year)}/passedArchive/years`,
  yearPassedArchiveYear: (reference, year, archivedYear) =>
    `${sessionOrLegacy(reference, year)}/passedArchive/years/${segment(normalizeSessionYear(archivedYear, year))}`,
  yearPassedArchiveYearStudent: (reference, year, archivedYear, studentMasterId) =>
    `${sessionOrLegacy(reference, year)}/passedArchive/years/${segment(normalizeSessionYear(archivedYear, year))}/${segment(studentMasterId)}`,
  yearPassedStudent: (reference, year, studentMasterId) =>
    `${sessionOrLegacy(reference, year)}/passedArchive/${segment(studentMasterId)}`,

  /* ---------------- User lookups ---------------- */
  users: () => USERS_ROOT,
  user: (uid) => getUserPath(uid),
  /** Index of every school a teacher belongs to (fast multi-school sign-in). */
  userSchools: (uid) => `${getUserPath(uid)}/schools`,
  userSchool: (uid, schoolId) => `${getUserPath(uid)}/schools/${segment(schoolId)}`,
});

export default dbPaths;

