import { ref, runTransaction } from 'firebase/database';
import { db } from '../../firebase/firebaseConfig.js';
import { cleanForCloud, safeMultiPathUpdate, safeRead, safeSubscribe, safeUpdate } from './dbFallback.js';
import { DEFAULT_SECTION_ID, dbPaths, normalizeSessionYear, schoolIdOf, sectionSegment } from './dbPaths.js';
import { resolveClassKey } from '../../utils/constants.js';
import { ensureSchoolYear } from './centralSchoolStore.js';

/**
 * studentService — Permanent Student Master + yearly enrollment.
 *
 * ```text
 * …/studentMaster/{studentMasterId}                        ← permanent identity (never deleted)
 * …/sessions/{year}/students/{classId}/{sectionId}/{studentMasterId}
 *                                                          ← yearly enrollment (roll/section/status)
 * …/sessions/{year}/passedArchive/{studentMasterId}        ← that year's Class-5 graduates
 * schoolData/{schoolId}/students/{legacyId}                ← legacy flat mirror (older readers)
 * ```
 *
 * Every enrollment row lives inside a শাখা (section) folder of its class, and older
 * layouts (`students/{classId}/{studentMasterId}`, `students/{studentMasterId}`)
 * stay readable through `normalizeEnrollmentMap`.
 *
 * Personal information is written once to the master node; every academic year only
 * adds a small enrollment row pointing at it. Records are never hard deleted —
 * `isDeleted: true` hides a pupil from active lists while every historical
 * result/attendance row keeps resolving through `studentMasterId`.
 */

const asRecord = (value) => (value && typeof value === 'object' && !Array.isArray(value) ? value : {});
const isObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const toArray = (value) => Object.values(asRecord(value));
const nowISO = () => new Date().toISOString();

/** Keys that belong to the yearly enrollment row, not the permanent identity. */
const ENROLLMENT_FIELD_KEYS = Object.freeze(['classId', 'roll', 'section', 'status']);

/**
 * Enrollment-level promotion metadata (`উত্তরণ`). These fields describe the row of
 * ONE academic year — never the permanent identity — so they are carried by
 * `buildEnrollmentRecord` and merged back by `mergeStudentRecord`.
 */
const PROMOTION_FIELD_KEYS = Object.freeze([
  'promotedAt', 'promotedFromClass', 'promotedFromYear', 'isNewPromotion', 'previousClassId',
]);

/** Only the promotion fields the caller actually supplied (a blank/null one is skipped). */
const promotionFieldsOf = (record = {}) => Object.fromEntries(
  PROMOTION_FIELD_KEYS
    .filter((key) => Object.prototype.hasOwnProperty.call(record, key))
    .filter((key) => record[key] !== undefined && record[key] !== null && record[key] !== '')
    .map((key) => [key, record[key]]),
);


/** Keys never copied verbatim into the master node. */
const RESERVED_FIELD_KEYS = Object.freeze([
  'id', 'studentMasterId', 'legacyId', 'localId', 'classId', 'roll', 'section',
  'status', 'overallStatus', 'isDeleted', 'createdAt', 'updatedAt',
]);

/**
 * Year/roster bookkeeping that belongs to an enrollment row. A roster row is a MERGE
 * of identity + enrollment, so these must be filtered out before it is written back
 * onto `studentMaster` (otherwise last year's class/merit would win on display).
 */
const YEAR_ONLY_FIELD_KEYS = Object.freeze([
  'year', 'retainedAt', 'academicYear', 'archivedYear', 'archivedAt', 'archivedFromClass',
  'passedYear', 'passedAt', 'graduatedYear', 'meritPosition', 'gpa', 'grade', 'grandTotal',
  ...PROMOTION_FIELD_KEYS,
]);

/** Markers that identify a leaf record (tells flat nodes from class-nested nodes). */
const RECORD_MARKERS = Object.freeze([
  'status', 'name', 'roll', 'classId', 'isDeleted', 'studentMasterId', 'legacyId',
]);

/**
 * Root of the permanent tenant tree. Everything below is addressed relative to it
 * so a single `update()` can atomically touch `studentMaster/…` and `sessions/…`.
 */
export const studentSchoolBasePath = (reference) =>
  dbPaths.studentMaster(reference).replace(/\/studentMaster$/, '');

/**
 * The UI addresses classes by their app id (`pre`, `c1` … `c5`), while every
 * database node uses the canonical key (`pre-primary`, `class-1` …). These two
 * helpers are the only translation points, so a tab and a node never disagree.
 */
const APP_CLASS_IDS = Object.freeze({
  'pre-primary': 'pre',
  'class-1': 'c1',
  'class-2': 'c2',
  'class-3': 'c3',
  'class-4': 'c4',
  'class-5': 'c5',
});

/** Canonical storage key for a class id (`archive` stays `archive`). */
export const toDbClassId = (classId) => {
  const key = String(classId ?? '').trim();
  if (!key || key === 'archive') return key;
  return resolveClassKey(key);
};

/** App-facing class id for a stored key (`class-1` ➔ `c1`). */
export const toAppClassId = (classId) => {
  const key = toDbClassId(classId);
  if (!key || key === 'archive' || key === 'unassigned') return key;
  return APP_CLASS_IDS[key] ?? key;
};

/** Every active class, in both vocabularies (`c1` … and `class-1` …). */
const CLASS_LEVEL_IDS = Object.freeze(Object.values(APP_CLASS_IDS));

/**
 * Storage name of a শাখা folder — `''` (a pupil admitted before sections existed)
 * resolves to the default `ক`, so a row always has one home.
 */
export const toSectionId = (section) => sectionSegment(section, DEFAULT_SECTION_ID);


const relativeKey = (base, path) => (path && path.startsWith(`${base}/`) ? path.slice(base.length + 1) : path);

/**
 * Expands `{ a: 1, b: { c: 2 } }` into `{ a: 1, 'b/c': 2 }`.
 * A Realtime Database `update()` treats a nested object as a *replacement* of that
 * child, so every partial patch is flattened to leaf paths — that is what keeps a
 * rename from wiping a pupil's other permanent fields.
 */
export function flattenPatch(prefix, value) {
  const out = {};
  Object.entries(asRecord(value)).forEach(([key, child]) => {
    const path = prefix ? `${prefix}/${key}` : key;
    if (isObject(child)) Object.assign(out, flattenPatch(path, child));
    else out[path] = child;
  });
  return out;
}

const looksLikeRecord = (value) => isObject(value) && RECORD_MARKERS.some((key) => key in value);

/** Academic year of an enrollment: explicit year ➔ student.session ➔ admissionYear. */
export const resolveStudentYear = (year, student = {}) => normalizeSessionYear(
  year || student.session || student.year || student.admissionYear,
  String(new Date().getFullYear()),
);

/* ------------------------------------------------------------------ *
 * Permanent identity helpers
 * ------------------------------------------------------------------ */

/** `STU-{year}-{seq}` — the permanent, human-readable pupil id. */
export function formatStudentMasterId(year, sequence) {
  const yearKey = normalizeSessionYear(year, String(new Date().getFullYear()));
  const numeric = Math.max(1, Number(sequence) || 1);
  return `STU-${yearKey}-${String(numeric).padStart(3, '0')}`;
}

const nextMasterSequence = (masters = {}, yearKey = '') => {
  const prefix = `STU-${yearKey}-`;
  const highest = Object.keys(asRecord(masters)).reduce((max, id) => (
    id.startsWith(prefix) ? Math.max(max, Number(id.slice(prefix.length)) || 0) : max
  ), 0);
  let sequence = highest + 1;
  while (masters[formatStudentMasterId(yearKey, sequence)]) sequence += 1;
  return sequence;
};

/** Finds an existing master id from a master id, a legacy id or a local id. */
export function findStudentMasterId(masters, reference) {
  const wanted = String(reference ?? '').trim();
  if (!wanted) return '';
  const map = asRecord(masters);
  if (map[wanted]) return wanted;
  const match = Object.entries(map).find(([, master]) => (
    master && (master.legacyId === wanted || master.localId === wanted || master.id === wanted)
  ));
  return match ? match[0] : '';
}

/**
 * Mints the next unique `studentMasterId` for a year.
 *
 * Uses an RTDB `runTransaction` on the year's counter node so two teachers admitting a
 * pupil at the same moment can never receive the same id (a plain read-then-write raced
 * and produced duplicates). The transaction only bumps a number; a failure degrades to a
 * cache-aware local scan so an offline admission still gets a usable id.
 *
 * @returns {Promise<string>} e.g. `STU-2026-007`
 */
export async function generateStudentMasterId(schoolId, year) {
  const yearKey = normalizeSessionYear(year, String(new Date().getFullYear()));
  const counterPath = dbPaths.studentMasterCounter(schoolId, yearKey);
  const masters = asRecord(await safeRead(dbPaths.studentMaster(schoolId), {}));
  // A pre-existing roster (or a reseeded counter) must never be shadowed by the counter.
  const highest = nextMasterSequence(masters, yearKey) - 1;
  try {
    const outcome = await runTransaction(ref(db, counterPath), (current) => {
      const value = Math.max(Number(current) || 0, highest);
      return value + 1;
    });
    const sequence = Number(outcome?.snapshot?.val?.()) || 0;
    if (outcome?.committed && sequence > 0) {
      const candidate = formatStudentMasterId(yearKey, sequence);
      // The transaction guarantees a monotonic sequence; the scan is the last guard.
      if (!masters[candidate]) return candidate;
    }
  } catch {
    /* offline / rules blocked — fall back to the cache-aware scan below */
  }
  return formatStudentMasterId(yearKey, nextMasterSequence(masters, yearKey));
}

/** Resolves a master id for an existing pupil (never invents one). */
export async function resolveStudentMasterId(schoolId, studentId, fallback = {}) {
  const masters = asRecord(await safeRead(dbPaths.studentMaster(schoolId), {}));
  return findStudentMasterId(masters, studentId) || String(fallback?.studentMasterId ?? '');
}

/**
 * Short-lived `appId ➔ studentMasterId` index.
 * The UI keeps addressing pupils by their original roster id, while storage uses
 * the permanent master id — this index bridges the two without a read per keystroke.
 */
const masterIndexCache = new Map();
const MASTER_INDEX_TTL = 60000;

export async function readStudentMasterIndex(schoolId) {
  if (!schoolId) return { byId: new Map(), masters: {} };
  const cached = masterIndexCache.get(schoolId);
  if (cached && Date.now() - cached.at < MASTER_INDEX_TTL) return cached;

  const masters = asRecord(await safeRead(dbPaths.studentMaster(schoolId), {}));
  const byId = new Map();
  Object.entries(masters).forEach(([masterId, master]) => {
    byId.set(masterId, masterId);
    [master?.legacyId, master?.localId, master?.id].forEach((alias) => {
      const key = String(alias ?? '').trim();
      if (key) byId.set(key, masterId);
    });
  });
  const entry = { at: Date.now(), byId, masters };
  masterIndexCache.set(schoolId, entry);
  return entry;
}

/** Drops the cached index so the next read sees a fresh admission/rename/delete. */
export const invalidateStudentMasterIndex = (schoolId) => {
  if (schoolId) masterIndexCache.delete(schoolId);
  else masterIndexCache.clear();
};

/**
 * Resolves any pupil reference (master id, legacy roster id, local id) to the
 * permanent `studentMasterId`. Unknown ids are returned unchanged so a legacy
 * roster that has not been migrated yet still writes to a stable path.
 */
export async function resolveMasterId(schoolId, studentId) {
  const key = String(studentId ?? '').trim();
  if (!key) return '';
  if (/^STU-\d{4}-/.test(key)) return key;
  const { byId } = await readStudentMasterIndex(schoolId);
  return byId.get(key) || key;
}

/* ------------------------------------------------------------------ *
 * Record builders & merge helpers
 * ------------------------------------------------------------------ */

/** Permanent personal record: name, parents, dob, birth reg., guardian phone, … */
export function buildStudentMasterRecord(record = {}, { studentMasterId, year } = {}) {
  const personal = {};
  Object.entries(record).forEach(([key, value]) => {
    if (RESERVED_FIELD_KEYS.includes(key) || value === undefined) return;
    // A roster row also carries THIS year's enrollment data. `studentMaster` is a
    // permanent, year-less node, so copying an old `year` / promotion stamp into it
    // would let stale data win over the live enrollment row when the two are merged
    // after a reload (the old class/section reappearing).
    if (YEAR_ONLY_FIELD_KEYS.includes(key)) return;
    personal[key] = value;
  });
  const yearKey = normalizeSessionYear(year, String(new Date().getFullYear()));
  return cleanForCloud({
    ...personal,
    studentMasterId,
    legacyId: record.legacyId ?? record.localId ?? record.id ?? '',
    name: String(record.name ?? '').trim(),
    fatherName: String(record.fatherName ?? '').trim(),
    motherName: String(record.motherName ?? '').trim(),
    dob: record.dob ?? record.birthDate ?? '',
    birthRegNo: record.birthRegNo ?? record.birthCertificateNo ?? '',
    // Only the father's and mother's mobiles are first-class contact fields. A
    // `guardianPhone` written by an older row is kept verbatim (never re-derived
    // from another number), so no extra mobile field is invented any more.
    ...(record.guardianPhone !== undefined && record.guardianPhone !== null && String(record.guardianPhone).trim() !== ''
      ? { guardianPhone: String(record.guardianPhone).trim() }
      : {}),
    admissionYear: String(record.admissionYear ?? yearKey),
    overallStatus: record.overallStatus ?? 'active',
    isDeleted: record.isDeleted === true,
    createdAt: record.createdAt ?? nowISO(),
    updatedAt: nowISO(),
  });
}

/**
 * Yearly enrollment row — the only part of a pupil that changes year to year.
 * Promotion metadata is written on this row (never on the master), so the month
 * badge / origin tag of the roster survive a refresh and a class move.
 */
export function buildEnrollmentRecord(record = {}, { studentMasterId, year, classId, section } = {}) {
  const sectionId = toSectionId(section ?? record.section);
  return cleanForCloud({
    studentMasterId,
    legacyId: record.legacyId ?? record.localId ?? record.id ?? '',
    classId: toDbClassId(classId ?? record.classId),
    roll: Number(record.roll) || 0,
    section: sectionId,
    status: record.status === 'archived' ? 'archived' : 'active',
    year: normalizeSessionYear(year, String(new Date().getFullYear())),
    isDeleted: record.isDeleted === true,
    ...promotionFieldsOf(record),
    updatedAt: nowISO(),
  });
}

/** One view-model row: permanent identity + this year's enrollment. */
export function mergeStudentRecord(master = {}, enrollment = {}, classId = '') {
  const masterId = master?.studentMasterId
    || enrollment?.studentMasterId
    || enrollment?.legacyId
    || enrollment?.id
    || '';
  const legacyId = enrollment?.legacyId || master?.legacyId || master?.localId || '';
  // Promotion metadata describes THIS year's enrollment, never the permanent
  // identity: when merging, the enrollment row always wins (even `null`), so a
  // retained pupil can never inherit an old `promotedAt` from the master node.
  const PROMOTION_KEYS = ['promotedAt', 'promotedFromClass', 'promotedFromYear', 'isNewPromotion', 'previousClassId'];
  const promotionFields = {};
  PROMOTION_KEYS.forEach((key) => {
    if (Object.prototype.hasOwnProperty.call(enrollment ?? {}, key)) promotionFields[key] = enrollment[key];
    else if (!Object.prototype.hasOwnProperty.call(master ?? {}, key)) return;
    else promotionFields[key] = null;
  });
  return {
    ...enrollment,
    ...master,
    // `id` stays the app-facing id (legacy id when the pupil predates the master
    // node) so hooks, marks maps and documents keep matching rows by one key.
    id: legacyId || masterId,
    studentMasterId: masterId,
    legacyId: legacyId || masterId,
    // Class ids are exposed in the app's own vocabulary (`c1`, `pre`) so tabs and
    // hooks keep matching; storage keys stay canonical (`class-1`, `pre-primary`).
    classId: toAppClassId(classId || enrollment?.classId || master?.classId),
    roll: enrollment?.roll ?? master?.roll ?? 0,
    section: toSectionId(enrollment?.section ?? master?.section),
    status: enrollment?.status ?? master?.status ?? 'active',
    isDeleted: master?.isDeleted === true || enrollment?.isDeleted === true,
    overallStatus: master?.overallStatus ?? 'active',
    ...promotionFields,
  };
}


/**
 * Normalises every enrollment layout this app has ever written:
 *
 * ```text
 * {studentId: row}                                  ← first legacy flat roster
 * {classId: {studentId: row}}                       ← legacy class buckets
 * {classId: {sectionId: {studentId: row}}}          ← current শাখা folders
 * ```
 *
 * The result is always `{classId: {studentMasterId: row}}`, so readers (roster,
 * promotion, attendance, history) never need to know which layout they met.
 */
export function normalizeEnrollmentMap(value) {
  const out = {};
  const write = (classId, masterId, enrollment, sectionFolder = '') => {
    const key = String(enrollment.studentMasterId || enrollment.legacyId || masterId || '');
    if (!classId || !key) return;
    out[classId] = out[classId] ?? {};
    // A row inside a শাখা folder inherits the folder name when the field is missing.
    out[classId][key] = {
      ...enrollment,
      studentMasterId: key,
      section: toSectionId(enrollment.section ?? sectionFolder),
    };
  };
  Object.entries(asRecord(value)).forEach(([key, child]) => {
    if (!isObject(child)) return;
    if (looksLikeRecord(child)) {
      write(String(child.classId ?? key), key, child);
      return;
    }
    Object.entries(child).forEach(([entryKey, entry]) => {
      if (!isObject(entry)) return;
      if (looksLikeRecord(entry)) {
        write(key, entryKey, entry);
        return;
      }
      // `{classId: {sectionId: {studentMasterId: row}}}` — one শাখা folder.
      Object.entries(entry).forEach(([masterId, enrollment]) => {
        if (isObject(enrollment)) write(key, masterId, enrollment, entryKey);
      });
    });
  });
  return out;
}

/**
 * Merges several enrollment layouts into one `{classId: {masterId: row}}` map.
 *
 * The maps are given oldest-layout-first, so a LATER map is authoritative: when the
 * same pupil appears in an older layout (a legacy flat roster / `sessions/{year}/
 * students/{id}`) and in the current one, only the current row survives. That is what
 * stops an old class/শাখা copy from resurrecting after a reload.
 */
export const mergeEnrollmentMaps = (...maps) => maps.reduce((acc, map) => {
  const normalized = normalizeEnrollmentMap(map);
  // Every pupil this (newer) map knows about leaves any earlier class bucket.
  const claimed = new Set(
    Object.values(normalized).flatMap((entries) => Object.keys(entries)),
  );
  if (claimed.size) {
    Object.keys(acc).forEach((classId) => {
      Object.keys(acc[classId]).forEach((masterId) => {
        if (claimed.has(masterId)) delete acc[classId][masterId];
      });
      if (Object.keys(acc[classId]).length === 0) delete acc[classId];
    });
  }
  Object.entries(normalized).forEach(([classId, entries]) => {
    acc[classId] = { ...(acc[classId] ?? {}), ...entries };
  });
  return acc;
}, {});

const sortByRoll = (list) => [...list].sort((a, b) => (
  (Number(a?.roll) || 0) - (Number(b?.roll) || 0)
  || String(a?.name ?? '').localeCompare(String(b?.name ?? ''), 'bn')
));

/**
 * Merges `studentMaster` with one year's enrollments.
 * Soft-deleted pupils are hidden from the active list but stay in the database
 * (still reachable with `includeDeleted: true`).
 */
export function buildYearRoster({ masters = {}, enrollments = {}, passed = {}, includeDeleted = false } = {}) {
  const masterMap = asRecord(masters);
  const students = [];
  const archive = [];
  /**
   * One pupil can still be present under an older layout (`students/{classId}/{id}`,
   * the flat legacy mirror, …) after a class/শাখা change. Only ONE row per
   * `studentMasterId` may reach the roster — otherwise a refresh would list the pupil
   * in the class they just left next to the class they moved to. The newest
   * `updatedAt` wins, so the row written by the last move is authoritative.
   */
  const byMasterId = new Map();
  const enroll = (merged) => {
    const key = String(merged.studentMasterId || merged.id || '');
    if (!key) return;
    const stamp = String(merged.updatedAt ?? '');
    const existing = byMasterId.get(key);
    // The row written by the LAST move carries the newest `updatedAt` and wins.
    if (!existing || stamp > String(existing.merged.updatedAt ?? '')) byMasterId.set(key, { merged });
  };

  Object.entries(normalizeEnrollmentMap(enrollments)).forEach(([classId, entries]) => {
    Object.entries(entries).forEach(([, enrollment]) => {
      const merged = mergeStudentRecord(masterMap[enrollment.studentMasterId], enrollment, classId);
      if (merged.isDeleted && !includeDeleted) return;
      enroll(merged);
    });
  });
  byMasterId.forEach(({ merged }) => students.push(merged));

  Object.entries(asRecord(passed)).forEach(([masterId, record]) => {
    if (!isObject(record)) return;
    // Every archive layout is readable:
    //   passedArchive/{studentMasterId}              ← flat, every year
    //   passedArchive/{year}/{studentMasterId}       ← year-keyed
    //   passedArchive/years/{year}/{studentMasterId} ← year-wise folder (current)
    if (!RECORD_MARKERS.some((key) => record[key] !== undefined)) {
      Object.entries(record).forEach(([nestedKey, nested]) => {
        if (!isObject(nested)) return;
        // One extra level for the `years/{year}` folder.
        const leaves = RECORD_MARKERS.some((key) => nested[key] !== undefined)
          ? [[nestedKey, nested]]
          : Object.entries(nested).filter(([, leaf]) => isObject(leaf));
        leaves.forEach(([nestedId, leaf]) => {
          const mergedNested = mergeStudentRecord(masterMap[nestedId], {
            ...leaf,
            studentMasterId: leaf.studentMasterId || nestedId,
          }, 'archive');
          archive.push({ ...mergedNested, classId: 'archive', status: 'archived' });
        });
      });
      return;
    }
    const merged = mergeStudentRecord(masterMap[masterId], {
      ...record,
      studentMasterId: record.studentMasterId || masterId,
    }, 'archive');
    archive.push({ ...merged, classId: 'archive', status: 'archived' });
  });

  // A pupil archived under both the flat and the year-keyed node is listed once.
  const dedupedArchive = [...archive.reduce((map, student) => {
    const key = String(student.studentMasterId || student.id || '');
    if (!key) return map;
    const existing = map.get(key);
    map.set(key, existing ? { ...existing, ...student } : student);
    return map;
  }, new Map()).values()];

  return { students: sortByRoll(students), archive: sortByRoll(dedupedArchive) };
}

/**
 * Absolute path of an enrollment node.
 * Active pupils live inside their class's শাখা folder
 * (`students/{classId}/{sectionId}/{studentMasterId}`); graduates of the year stay
 * in that year's `passedArchive`.
 */
const enrollmentNodePath = (schoolId, year, classId, studentMasterId, section = '') => (
  classId === 'archive'
    ? dbPaths.yearPassedStudent(schoolId, year, studentMasterId)
    : dbPaths.yearSectionStudent(schoolId, year, toDbClassId(classId), toSectionId(section), studentMasterId)
);

/**
 * Every node one enrollment row may previously have been written to, newest first.
 * Used by writers that MOVE a row (class/section change) so no older spelling of
 * the same pupil is left behind next to the new row.
 */
const legacyEnrollmentPaths = (schoolId, year, classId, studentMasterId) => (
  classId === 'archive'
    ? []
    : [dbPaths.yearStudent(schoolId, year, toDbClassId(classId), studentMasterId)]
);
/* ------------------------------------------------------------------ *
 * Reads
 * ------------------------------------------------------------------ */

/** One-shot merged roster for a year (optionally narrowed to one class). */
export async function readYearRoster(schoolId, year, classId = '') {
  const yearKey = normalizeSessionYear(year);
  if (!schoolId || !yearKey) return { students: [], archive: [] };

  const newStudentsPath = dbPaths.yearStudents(schoolId, yearKey);
  const legacyStudentsPath = dbPaths.sessionStudents(schoolId, yearKey);
  const newPassedPath = dbPaths.yearPassedArchive(schoolId, yearKey);
  const legacyArchivePath = dbPaths.sessionArchive(schoolId, yearKey);

  const [masters, studentsRaw, legacyStudentsRaw, passedRaw, legacyArchiveRaw] = await Promise.all([
    safeRead(dbPaths.studentMaster(schoolId), {}),
    safeRead(newStudentsPath, {}),
    legacyStudentsPath === newStudentsPath ? {} : safeRead(legacyStudentsPath, {}),
    safeRead(newPassedPath, {}),
    legacyArchivePath === newPassedPath ? {} : safeRead(legacyArchivePath, {}),
  ]);

  const roster = buildYearRoster({
    masters,
    enrollments: mergeEnrollmentMaps(legacyStudentsRaw, studentsRaw),
    passed: { ...asRecord(legacyArchiveRaw), ...asRecord(passedRaw) },
  });

  if (!classId) return roster;
  const wanted = toAppClassId(classId);
  if (wanted === 'archive') return { students: [], archive: roster.archive };
  return {
    students: roster.students.filter((student) => toAppClassId(student.classId) === wanted),
    archive: roster.archive,
  };
}

/** One-shot read of a pupil's permanent identity node. */
export async function readStudentMaster(schoolId, studentMasterId) {
  if (!schoolId || !studentMasterId) return null;
  const value = await safeRead(dbPaths.studentMasterEntry(schoolId, studentMasterId), null);
  return isObject(value) ? value : null;
}

/**
 * Live শাখা registry of one academic year: `{classId: {sectionId: true}}`.
 *
 * A শাখা is a *folder* inside a class node, and the Realtime Database cannot store
 * an empty folder — so a brand-new শাখা (`খ`, `গ` …) that has no pupil yet would
 * disappear on refresh. The registry under `sessions/{year}/meta/sections` is what
 * keeps every declared শাখা alive, and it is shared live by all teachers.
 */
export function subscribeSectionRegistry(reference, callback, onStatus, year = '') {
  const yearKey = normalizeSessionYear(year);
  if (!reference || !yearKey) {
    callback({});
    return () => {};
  }
  return safeSubscribe(
    dbPaths.yearMetaSections(reference, yearKey),
    (value) => callback(normalizeSectionRegistry(value)),
    {},
    onStatus,
  );
}

/**
 * Normalises the registry node into `{classId: {sectionId: true}}` keyed by the
 * APP class ids (`pre`, `c1` …) so the roster tabs can read it directly.
 */
export function normalizeSectionRegistry(value) {
  const out = {};
  const isMarked = (entry) => entry === true
    || entry === 1
    || (isObject(entry) && entry.isDeleted !== true);
  Object.entries(asRecord(value)).forEach(([classId, sections]) => {
    if (!isObject(sections)) return;
    const appClassId = toAppClassId(classId) || classId;
    const cleaned = {};
    Object.entries(sections).forEach(([sectionId, entry]) => {
      // A shakhá is a label, never a class folder: numeric/enrollment keys are ignored.
      if (!isMarked(entry) || isObject(entry) && entry.roll !== undefined) return;
      const key = sectionSegment(sectionId);
      if (key) cleaned[key] = true;
    });
    if (Object.keys(cleaned).length > 0) {
      out[appClassId] = { ...(out[appClassId] ?? {}), ...cleaned };
    }
  });
  return out;
}

/**
 * Declares a শাখা for a class of one year, so it is listed (count ০) before its
 * first admission and stays listed after the page is refreshed.
 */
export async function registerSectionCloud(reference, year, classId, sectionId) {
  const yearKey = normalizeSessionYear(year);
  const classKey = toDbClassId(classId);
  const sectionKey = sectionSegment(sectionId);
  if (!reference || !yearKey || !classKey || !sectionKey) return { synced: false };
  return safeUpdate(dbPaths.yearMetaSections(reference, yearKey), {
    [`${classKey}/${sectionKey}`]: true,
  });
}

/**
 * Removes a declared-but-empty শাখা. The default `ক` and any শাখা that still holds
 * a pupil are never removed (the caller checks the count first).
 */
export async function unregisterSectionCloud(reference, year, classId, sectionId) {
  const yearKey = normalizeSessionYear(year);
  const classKey = toDbClassId(classId);
  const sectionKey = sectionSegment(sectionId);
  if (!reference || !yearKey || !classKey || !sectionKey || sectionKey === DEFAULT_SECTION_ID) {
    return { synced: false };
  }
  return safeUpdate(dbPaths.yearMetaSections(reference, yearKey), {
    [`${classKey}/${sectionKey}`]: null,
  });
}

/**
 * Live roster subscription.
 * - with a `year`: merges `studentMaster` + `sessions/{year}/students` (+ passed archive);
 * - without a `year`: legacy flat roster, soft-deleted rows hidden.
 */
export function subscribeStudents(schoolId, callback, onStatus, year = '') {
  if (!schoolId) {
    callback({ students: [], archive: [] });
    return () => {};
  }

  const yearKey = normalizeSessionYear(year);

  if (!yearKey) {
    let students = [];
    let archive = [];
    const notify = () => callback({ students, archive });

    const unsubActive = safeSubscribe(
      dbPaths.students(schoolId),
      (value) => {
        students = toArray(value)
          .filter((student) => isObject(student) && student.isDeleted !== true)
          .map((student) => ({ ...student, status: student.status ?? 'active' }));
        notify();
      },
      {},
      onStatus,
    );

    const unsubArchive = safeSubscribe(
      dbPaths.archive(schoolId),
      (value) => {
        archive = toArray(value)
          .filter((student) => isObject(student) && student.isDeleted !== true)
          .map((student) => ({ ...student, classId: 'archive', status: 'archived' }));
        notify();
      },
      {},
      onStatus,
    );

    return () => {
      unsubActive?.();
      unsubArchive?.();
    };
  }

  let masters = {};
  let yearEnrollments = {};
  let legacyEnrollments = {};
  let passed = {};
  const notify = () => callback(buildYearRoster({
    masters,
    enrollments: mergeEnrollmentMaps(legacyEnrollments, yearEnrollments),
    passed,
  }));

  const unsubs = [
    safeSubscribe(dbPaths.studentMaster(schoolId), (value) => {
      masters = asRecord(value);
      notify();
    }, {}, onStatus),
    safeSubscribe(dbPaths.yearStudents(schoolId, yearKey), (value) => {
      yearEnrollments = asRecord(value);
      notify();
    }, {}, onStatus),
    safeSubscribe(dbPaths.yearPassedArchive(schoolId, yearKey), (value) => {
      passed = asRecord(value);
      notify();
    }, {}, onStatus),
  ];

  // Older year-partitioned rosters (`sessions/{year}/students/{studentId}`) stay readable.
  if (dbPaths.sessionStudents(schoolId, yearKey) !== dbPaths.yearStudents(schoolId, yearKey)) {
    unsubs.push(safeSubscribe(dbPaths.sessionStudents(schoolId, yearKey), (value) => {
      legacyEnrollments = asRecord(value);
      notify();
    }, {}, onStatus));
  }

  return () => unsubs.forEach((unsub) => unsub?.());
}
/* ------------------------------------------------------------------ *
 * Writes
 * ------------------------------------------------------------------ */

/**
 * New admission: mints a permanent `studentMasterId`, writes the identity node and
 * this year's enrollment row in one atomic multi-path update. The legacy flat node
 * is mirrored so readers that have not migrated yet keep seeing the pupil.
 */
/**
 * Writes ONE planned import row into the shared patch.
 *
 * Extracted so `importStudentsCloud` stays readable; it only mutates the `state`
 * object it is given (`patch`, `sections`, counters) and never touches the network —
 * the whole file therefore leaves as ONE atomic multi-path update.
 */
function writeImportRow(row, { reference, schoolId, yearKey, force, masters, state, mintMasterId }) {
  const values = row?.values ?? {};
  const classId = toDbClassId(row?.classId);
  const section = toSectionId(row?.section);
  const roll = Number(row?.resolvedRoll) || 0;

  // A row with no usable class/roll, or an unconfirmed duplicate roll, is skipped.
  if (!classId || classId === 'archive' || !roll) {
    state.skipped += 1;
    return;
  }
  if (row.status === 'conflict' && !force) {
    state.skipped += 1;
    return;
  }
  state.sections.add(`${classId}/${section}`);

  const existing = row?.existing ?? null;
  const masterId = String(existing?.studentMasterId || existing?.id || '').trim();

  if (masterId) {
    // Only the fields the sheet actually changed reach the permanent identity; a blank
    // cell never wipes a stored value.
    const personal = Object.keys(row?.changes ?? {}).reduce((acc, key) => {
      if (values[key] !== undefined && String(values[key]).trim() !== '') acc[key] = values[key];
      return acc;
    }, {});
    const sameBucket = toAppClassId(existing.classId) === toAppClassId(row.classId)
      && toSectionId(existing.section) === section;
    const rollChanged = Number(existing.roll) !== roll;
    if (!Object.keys(personal).length && sameBucket && !rollChanged) {
      state.skipped += 1; // nothing new — an unchanged row is never rewritten
      return;
    }
    const currentMaster = asRecord(masters[masterId]);
    state.patch[dbPaths.studentMasterEntry(reference, masterId)] = cleanForCloud({
      ...currentMaster,
      ...personal,
      studentMasterId: masterId,
      legacyId: currentMaster.legacyId || existing.legacyId || existing.id || masterId,
      updatedAt: nowISO(),
    });
    if (!sameBucket) {
      // The row MOVED (class or শাখা): the old folder is cleared in the same update.
      state.patch[dbPaths.yearSectionStudent(
        reference, yearKey, toDbClassId(existing.classId), toSectionId(existing.section), masterId,
      )] = null;
    }
    state.patch[dbPaths.yearSectionStudent(reference, yearKey, classId, section, masterId)] = cleanForCloud({
      studentMasterId: masterId,
      legacyId: existing.legacyId || existing.id || masterId,
      classId,
      section,
      roll,
      status: 'active',
      year: yearKey,
      updatedAt: nowISO(),
    });
    // WRITE TRUTH: no legacy flat mirror — the hierarchical enrollment above is
    // the whole write; old flat rows stay readable via the read fallback.
    state.updated += 1;
    return;
  }

  // New admission: mint a permanent id, then write identity + enrollment together.
  const newMasterId = mintMasterId();
  const record = {
    ...values,
    id: newMasterId,
    classId,
    section,
    roll,
    status: 'active',
    admissionYear: values.admissionYear || yearKey,
  };
  const master = buildStudentMasterRecord(record, { studentMasterId: newMasterId, year: yearKey });
  const enrollment = buildEnrollmentRecord(record, {
    studentMasterId: newMasterId, year: yearKey, classId, section,
  });
  state.patch[dbPaths.studentMasterEntry(reference, newMasterId)] = master;
  state.patch[dbPaths.yearSectionStudent(reference, yearKey, classId, section, newMasterId)] = enrollment;
  // WRITE TRUTH: no legacy flat mirror — identity + hierarchical enrollment only.
  // A later row of the same file must never receive this id again.
  masters[newMasterId] = master;
  state.created += 1;
}

/**
 * Bulk Excel import (`শিক্ষার্থী আমদানি`) — ONE atomic multi-path write.
 *
 * Every planned row of the preview is committed together:
 *
 * ```text
 * studentMaster/{studentMasterId}                       ← identity (new + changed fields)
 * sessions/{year}/students/{classId}/{section}/{id}     ← enrollment (roll / শাখা / class)
 * sessions/{year}/meta/sections/{classId}/{section}     ← declared শাখা registry
 * ```
 * (No legacy `schoolData/{schoolId}/students` mirror is written — WRITE TRUTH,
 * see dbPaths.js. Old flat rows stay readable via the read fallback.)
 *
 * Rules (they mirror `buildImportPlan`, which the preview shows):
 *  - a row scoring ≥80 against a stored pupil keeps the DATABASE roll and only updates
 *    the fields that really changed (a blank cell never wipes a stored value);
 *  - a new row keeps a free roll, otherwise it is appended at the end of its bucket —
 *    existing rolls are never renumbered by an import;
 *  - a `conflict` row is written only when the caller passes `force` (the modal's
 *    Warning #2), so an accidental click can never create a duplicate roll.
 *
 * @param {string|object} reference tenant location or bare `schoolId`
 * @param {string} year active academic year
 * @param {{rows?:Array<object>}} plan `buildImportPlan()` result
 * @param {{force?:boolean}} [options]
 * @returns {Promise<{synced:boolean, written:number, skipped:number,
 *   created:number, updated:number}>}
 */
export async function importStudentsCloud(reference, year, plan = {}, { force = false } = {}) {
  const yearKey = normalizeSessionYear(year);
  const schoolId = schoolIdOf(reference);
  if (!schoolId || !yearKey) {
    return { synced: false, written: 0, skipped: 0, created: 0, updated: 0 };
  }

  const rows = Array.isArray(plan?.rows) ? plan.rows : [];
  if (!rows.length) return { synced: true, written: 0, skipped: 0, created: 0, updated: 0 };

  // The year skeleton must exist before the first admission lands inside it.
  await ensureSchoolYear(schoolId, yearKey);
  const schoolRoot = studentSchoolBasePath(reference);
  if (!schoolRoot) return { synced: false, written: 0, skipped: 0, created: 0, updated: 0 };

  const masters = asRecord(await safeRead(dbPaths.studentMaster(reference), {}));
  let sequence = nextMasterSequence(masters, yearKey);
  const mintMasterId = () => {
    let candidate = formatStudentMasterId(yearKey, sequence);
    while (masters[candidate]) {
      sequence += 1;
      candidate = formatStudentMasterId(yearKey, sequence);
    }
    sequence += 1;
    return candidate;
  };

  const state = {
    patch: {},
    sections: new Set(),
    created: 0,
    updated: 0,
    skipped: 0,
  };

  rows.forEach((row) => {
    writeImportRow(row, {
      reference, schoolId, yearKey, force, masters, state, mintMasterId,
    });
  });

  // A declared শাখা survives a refresh even before its first pupil lands in it.
  state.sections.forEach((key) => {
    state.patch[`${dbPaths.yearMetaSections(reference, yearKey)}/${key}`] = true;
  });

  const result = Object.keys(state.patch).length
    ? await safeMultiPathUpdate(state.patch)
    : { synced: true };
  invalidateStudentMasterIndex(schoolId);
  return {
    synced: result?.synced !== false,
    written: state.created + state.updated,
    skipped: state.skipped,
    created: state.created,
    updated: state.updated,
  };
}

/**
 * New admission: mints a permanent `studentMasterId`, writes the identity node and
 * this year's enrollment row in one atomic multi-path update — hierarchical tree
 * only, no legacy flat mirror (see WRITE TRUTH in dbPaths.js).
 *
 * Both leaves live under the tenant root but under different parents
 * (`studentMaster/…`, `sessions/{year}/students/…`),
 * so a root-relative `update()` is what makes them one indivisible write: a reader can
 * never see the pupil in the year roster without the identity row (or vice versa),
 * and an offline failure is queued as ONE unit instead of half an admission.
 */
export async function addStudentCloud(schoolId, student, year = '') {
  const record = cleanForCloud(student);
  if (!schoolId || !record) return { synced: false, studentMasterId: '' };

  const classId = String(record.classId ?? '').trim();
  if (!classId) return { synced: false, studentMasterId: '' };

  const yearKey = resolveStudentYear(year, record);
  const masters = asRecord(await safeRead(dbPaths.studentMaster(schoolId), {}));
  const studentMasterId = findStudentMasterId(masters, record.studentMasterId)
    || findStudentMasterId(masters, record.id)
    || formatStudentMasterId(yearKey, nextMasterSequence(masters, yearKey));

  const master = buildStudentMasterRecord(record, { studentMasterId, year: yearKey });
  const enrollment = buildEnrollmentRecord(record, { studentMasterId, year: yearKey, classId, section: record.section });

  // Admission also materialises this year's campus skeleton (profile, studentMaster,
  // teachers, students/results class buckets) before the row lands in it.
  await ensureSchoolYear(schoolId, yearKey);

  const legacyId = enrollment.legacyId || record.id || studentMasterId;

  // WRITE TRUTH: identity + year enrollment only, on the hierarchical tree.
  // No legacy `schoolData/{schoolId}/students` mirror is written any more —
  // the year subscription reads the hierarchical node, and old flat rows stay
  // readable through the legacy read fallback (they are never deleted).
  const primary = await safeMultiPathUpdate({
    [dbPaths.studentMasterEntry(schoolId, studentMasterId)]: master,
    [enrollmentNodePath(schoolId, yearKey, classId, studentMasterId, enrollment.section)]: enrollment,
  });

  invalidateStudentMasterIndex(schoolId);

  return {
    synced: primary?.synced !== false,
    studentMasterId,
    legacyId,
    year: yearKey,
    classId,
  };
}

/** Splits an incoming patch into permanent identity fields and enrollment fields. */
function splitStudentFields(record = {}) {
  const personal = {};
  const enrollment = {};
  Object.entries(record).forEach(([key, value]) => {
    if (ENROLLMENT_FIELD_KEYS.includes(key)) enrollment[key] = value;
    else personal[key] = value;
  });
  return { personal, enrollment };
}
/**
 * Merges a partial patch. Identity fields land on `studentMaster/{id}`, enrollment
 * fields on `sessions/{year}/students/{classId}/{id}`; a class transfer moves the
 * enrollment node so the previous year/class keeps its history intact.
 */
export async function updateStudentCloud(schoolId, studentId, patch, previousClassId, existingStudent = {}, year = '') {
  const clean = cleanForCloud(patch) ?? {};
  if (!schoolId) return { synced: false };

  const yearKey = resolveStudentYear(year, { ...existingStudent, ...clean });
  const masters = asRecord(await safeRead(dbPaths.studentMaster(schoolId), {}));
  const studentMasterId = findStudentMasterId(masters, studentId)
    || findStudentMasterId(masters, existingStudent?.id)
    || String(existingStudent?.studentMasterId ?? '');

  const { personal, enrollment } = splitStudentFields(clean);
  const prevClassId = String(previousClassId ?? existingStudent?.classId ?? '').trim();
  const nextClassId = String(enrollment.classId ?? prevClassId).trim();
  // The শাখা folder is part of the path, so a section change is a MOVE, not an edit.
  const prevSectionId = toSectionId(existingStudent?.section);
  const sectionPatch = Object.prototype.hasOwnProperty.call(enrollment, 'section');
  const nextSectionId = toSectionId(sectionPatch ? enrollment.section : prevSectionId);

  // A class transfer lands in a different `sessions/{year}/students/{classId}` node:
  // make sure the target partition exists before the row is written into it.
  if (nextClassId && nextClassId !== 'archive') await ensureSchoolYear(schoolId, yearKey);

  const base = studentSchoolBasePath(schoolId);
  const patchPaths = {};

  if (studentMasterId) {
    const masterPatch = cleanForCloud({ ...personal, updatedAt: nowISO() });
    const masterLeaves = flattenPatch(
      relativeKey(base, dbPaths.studentMasterEntry(schoolId, studentMasterId)),
      masterPatch,
    );
    // `updatedAt` alone means there was nothing permanent to change.
    if (Object.keys(masterLeaves).length > 1) Object.assign(patchPaths, masterLeaves);
  }

  const enrollmentPatch = cleanForCloud({
    ...(enrollment.roll !== undefined ? { roll: Number(enrollment.roll) || 0 } : {}),
    section: nextSectionId,
    ...(enrollment.status !== undefined ? { status: enrollment.status } : {}),
    ...(enrollment.isDeleted !== undefined ? { isDeleted: enrollment.isDeleted } : {}),
    updatedAt: nowISO(),
  });

  if (nextClassId && studentMasterId) {
    const movedClass = Boolean(prevClassId) && prevClassId !== nextClassId;
    const movedSection = nextClassId !== 'archive' && prevSectionId !== nextSectionId;
    if (movedClass || movedSection) {
      // The old class/শাখা node is cleared so the pupil is never listed twice.
      if (prevClassId) {
        patchPaths[relativeKey(base, enrollmentNodePath(
          schoolId, yearKey, prevClassId, studentMasterId, prevSectionId,
        ))] = null;
      }
    }
    // The class-level node written before শাখা folders existed is redundant now, so
    // it is cleared on every save (the pupil's row always has a section folder).
    legacyEnrollmentPaths(schoolId, yearKey, prevClassId, studentMasterId)
      .forEach((path) => { patchPaths[relativeKey(base, path)] = null; });
    legacyEnrollmentPaths(schoolId, yearKey, nextClassId, studentMasterId)
      .forEach((path) => { patchPaths[relativeKey(base, path)] = null; });
    Object.assign(patchPaths, flattenPatch(
      relativeKey(base, enrollmentNodePath(schoolId, yearKey, nextClassId, studentMasterId, nextSectionId)),
      cleanForCloud({
        ...enrollmentPatch,
        studentMasterId,
        classId: toDbClassId(nextClassId),
        year: yearKey,
      }),
    ));
  }

  // WRITE TRUTH: no legacy flat mirror is written any more. The hierarchical
  // year enrollment + identity patch above is the whole write; old flat rows
  // stay readable through the legacy read fallback and are never deleted here.
  const targetClassId = nextClassId || prevClassId || existingStudent?.classId || '';
  const legacyId = String(existingStudent?.legacyId || existingStudent?.id || studentId);
  // One root-relative update: identity patch + enrollment patch.
  const absolutePatch = {};
  Object.entries(patchPaths).forEach(([key, value]) => { absolutePatch[`${base}/${key}`] = value; });
  const primary = Object.keys(absolutePatch).length
    ? await safeMultiPathUpdate(absolutePatch)
    : { synced: true };

  invalidateStudentMasterIndex(schoolId);
  return { ...primary, studentMasterId, year: yearKey, classId: targetClassId || prevClassId, legacyId };
}
/**
 * Soft delete. The pupil disappears from active rosters (`isDeleted: true`) and
 * `overallStatus` becomes `inactive`, while every result/attendance row linked by
 * `studentMasterId` stays untouched and readable.
 */
export async function deleteStudentCloud(schoolId, studentId, year = '', classId = '', section = '') {
  if (!schoolId) return { synced: false, markSynced: false };
  const yearKey = normalizeSessionYear(year);
  const masters = asRecord(await safeRead(dbPaths.studentMaster(schoolId), {}));
  const studentMasterId = findStudentMasterId(masters, studentId);
  const deletedAt = nowISO();
  const base = studentSchoolBasePath(schoolId);
  const patchPaths = {};

  if (studentMasterId) {
    Object.assign(patchPaths, flattenPatch(
      relativeKey(base, dbPaths.studentMasterEntry(schoolId, studentMasterId)),
      { isDeleted: true, overallStatus: 'inactive', deletedAt, updatedAt: deletedAt },
    ));
    if (yearKey && classId) {
      Object.assign(patchPaths, flattenPatch(
        relativeKey(base, enrollmentNodePath(schoolId, yearKey, classId, studentMasterId, section)),
        { isDeleted: true, status: 'inactive', updatedAt: deletedAt },
      ));
    }
  }

  const primary = Object.keys(patchPaths).length
    ? await safeUpdate(base, patchPaths)
    : { synced: false };

  // WRITE TRUTH: no legacy flat mirror is touched — the hierarchical soft-delete
  // above is the whole write; old flat rows stay as they were (readable, never
  // deleted by this call).
  const legacyId = String(masters[studentMasterId]?.legacyId ?? studentMasterId ?? studentId);

  invalidateStudentMasterIndex(schoolId);
  return { ...primary, studentMasterId, legacyId, softDeleted: true };
}

/** Moves one active student into the legacy archive (marks/remarks untouched). */
export function archiveStudentCloud(schoolId, student, year = '') {
  if (!student?.id) return Promise.resolve({ synced: false });
  return moveStudentsCloud(schoolId, [{
    id: student.id,
    from: 'students',
    to: 'archive',
    student: { ...student, classId: 'archive', status: 'archived', previousClassId: student.classId },
  }], year);
}

/** Restores one archived student into the selected active class. */
export function restoreStudentCloud(schoolId, student, classId, year = '') {
  if (!student?.id || !classId) return Promise.resolve({ synced: false });
  return moveStudentsCloud(schoolId, [{
    id: student.id,
    from: 'archive',
    to: 'students',
    student: { ...student, classId, status: 'active', previousClassId: null },
  }], year);
}
/**
 * Writes one promotion move. Never touches the source year; either creates the
 * next year's enrollment row (same `studentMasterId`) or files the pupil into the
 * current year's `passedArchive`.
 * @param {{year:string, nextYear:string, classId:string, nextClassId:string, studentMasterId:string, roll:number, legacyId?:string}} move
 */
export async function writePromotionEnrollment(schoolId, move = {}) {
  const { year, nextYear, classId, nextClassId, studentMasterId, roll } = move;
  if (!schoolId || !studentMasterId) return { synced: false };
  const base = studentSchoolBasePath(schoolId);
  const targetYear = normalizeSessionYear(year);

  if (!nextClassId || nextClassId === 'archive') {
    const passedPatch = {
      studentMasterId,
      legacyId: move.legacyId ?? '',
      classId: classId ?? '',
      roll: Number(roll) || 0,
      previousClassId: classId ?? '',
      passedYear: targetYear,
      passedAt: nowISO(),
    };
    // The bucket skeleton is ensured first so `passedArchive` always exists as a
    // node of a real `sessions/{year}` partition, never as a stray key.
    if (targetYear) await ensureSchoolYear(schoolId, targetYear);
    return safeUpdate(base, {
      [relativeKey(base, dbPaths.yearPassedStudent(schoolId, targetYear, studentMasterId))]: cleanForCloud(passedPatch),
    });
  }

  const target = normalizeSessionYear(nextYear);
  if (!target) return { synced: false };
  const enrollment = buildEnrollmentRecord(
    { roll, status: 'active', legacyId: move.legacyId ?? studentMasterId, section: move.sectionId ?? move.section },
    { studentMasterId, year: target, classId: nextClassId, section: move.sectionId ?? move.section },
  );
  await ensureSchoolYear(schoolId, target);
  return safeUpdate(base, {
    [relativeKey(base, dbPaths.yearSectionStudent(
      schoolId, target, nextClassId, enrollment.section, studentMasterId,
    ))]: enrollment,
  });
}

/** Only identity fields of a roster row — never an enrollment/year value. */
const personalFieldsOf = (record = {}) => Object.fromEntries(
  Object.entries(record).filter(([key, value]) => (
    value !== undefined
    && !ENROLLMENT_FIELD_KEYS.includes(key)
    && !YEAR_ONLY_FIELD_KEYS.includes(key)
    && !['id', 'studentMasterId', 'legacyId', 'localId', 'overallStatus', 'isDeleted', 'createdAt', 'updatedAt'].includes(key)
  )),
);

/**
 * Writes ONE pupil's individual class change (`উত্তীর্ণ` / `এই শ্রেণিতেই থাকুক` /
 * `এক শ্রেণি নিচে যাবে`) inside the active year.
 *
 * A single multi-path `update()` keeps every node in step, so the same pupil is never
 * listed twice and no reader ever observes a half-applied move:
 *
 * ```text
 * sessions/{year}/students/{targetClassId}/{targetSectionId}/{studentMasterId} ← written
 * sessions/{year}/students/{prevClassId}/{prevSectionId}/{studentMasterId}     ← removed
 * sessions/{year}/passedArchive/{studentMasterId}          ← Class-5 leavers only
 * sessions/{year}/passedArchive/years/{year}/{studentMasterId} ← same leaver, year-wise
 * studentMaster/{studentMasterId}                          ← currentClassId / overallStatus
 * ```
 *
 * @param {object}  move
 * @param {string}  move.year              active session year
 * @param {string}  move.prevClassId       class the pupil sits in today
 * @param {string}  move.prevSectionId     শাখা the pupil sits in today
 * @param {string}  move.nextClassId       destination class (`archive` = graduated)
 * @param {string}  move.nextSectionId     destination শাখা (defaults to `ক`)
 * @param {number}  move.roll              roll in the destination folder
 * @param {string}  move.studentMasterId   permanent pupil id
 * @param {object} [move.promotion]        promotion block written verbatim (`null`s clear it)
 * @param {object} [move.personal]         permanent fields kept on `studentMaster`
 */
export async function moveStudentClass(schoolId, move = {}) {
  const studentMasterId = String(move.studentMasterId ?? '').trim();
  const yearKey = normalizeSessionYear(move.year);
  if (!schoolId || !studentMasterId || !yearKey) return { synced: false };
  const prevClassId = String(move.prevClassId ?? '').trim();
  const nextClassId = String(move.nextClassId ?? prevClassId).trim();
  if (!nextClassId) return { synced: false };
  const prevSectionId = toSectionId(move.prevSectionId);
  const nextSectionId = toSectionId(move.nextSectionId);
  const graduated = nextClassId === 'archive';
  const now = nowISO();
  const promotion = isObject(move.promotion) ? move.promotion : null;

  await ensureSchoolYear(schoolId, yearKey);
  const base = studentSchoolBasePath(schoolId);
  const paths = {};

  /**
   * The promotion metadata the pupil ALREADY carries. A শাখা-only move must not drop
   * a month badge / origin tag, while an explicit decision (`promotion` supplied by the
   * caller, `null`s included) always wins — that is what clears a stamp on a demotion.
   */
  const sourceRow = !graduated && prevClassId && prevClassId !== 'archive'
    ? asRecord(await safeRead(
      dbPaths.yearSectionStudent(schoolId, yearKey, toDbClassId(prevClassId), prevSectionId, studentMasterId),
      {},
    ))
    : {};
  const carriedPromotion = Object.fromEntries(
    PROMOTION_FIELD_KEYS
      .filter((key) => sourceRow[key] !== undefined)
      .map((key) => [key, sourceRow[key]]),
  );
  const rowPromotion = { ...carriedPromotion, ...(promotion ?? {}) };

  /* 1. The destination row. -------------------------------------------------- */
  const personal = personalFieldsOf(move.personal ?? {});
  if (graduated) {
    const archivedRecord = cleanForCloud({
      ...personal,
      studentMasterId,
      legacyId: move.legacyId ?? studentMasterId,
      classId: prevClassId,
      section: prevSectionId,
      roll: Number(move.roll) || 0,
      status: 'passed',
      year: yearKey,
      passedYear: yearKey,
      archivedYear: yearKey,
      archivedFromClass: prevClassId,
      passedAt: rowPromotion.promotedAt ?? now,
      ...rowPromotion,
      updatedAt: now,
    });
    // Flat node + the year-wise folder + its year-keyed alias: the same three shapes
    // the class-wide promotion writes, so every archive reader sees the leaver.
    paths[relativeKey(base, dbPaths.yearPassedStudent(schoolId, yearKey, studentMasterId))] = archivedRecord;
    paths[relativeKey(base, dbPaths.yearPassedArchiveYearStudent(schoolId, yearKey, yearKey, studentMasterId))] = archivedRecord;
    paths[`${relativeKey(base, dbPaths.yearPassedArchive(schoolId, yearKey))}/${yearKey}/${studentMasterId}`] = archivedRecord;
  } else {
    paths[relativeKey(base, dbPaths.yearSectionStudent(
      schoolId, yearKey, toDbClassId(nextClassId), nextSectionId, studentMasterId,
    ))] = cleanForCloud({
      ...buildEnrollmentRecord(
        { ...personal, roll: move.roll, section: nextSectionId, status: 'active', legacyId: move.legacyId },
        { studentMasterId, year: yearKey, classId: nextClassId, section: nextSectionId },
      ),
      ...rowPromotion,
      updatedAt: now,
    });
  }

  /* 2. The source row goes away, so the pupil is listed exactly once. --------- */
  const movedClass = Boolean(prevClassId) && prevClassId !== nextClassId;
  const movedSection = !graduated && prevClassId === nextClassId && prevSectionId !== nextSectionId;
  if (prevClassId && (movedClass || movedSection)) {
    paths[relativeKey(base, enrollmentNodePath(schoolId, yearKey, prevClassId, studentMasterId, prevSectionId))] = null;
    legacyEnrollmentPaths(schoolId, yearKey, prevClassId, studentMasterId)
      .forEach((path) => { paths[relativeKey(base, path)] = null; });
  }
  legacyEnrollmentPaths(schoolId, yearKey, nextClassId, studentMasterId)
    .forEach((path) => { paths[relativeKey(base, path)] = null; });

  /* 2b. Every OTHER folder of this year is swept as well. ---------------------
   * A pupil may still sit under a class/শাখা spelling the caller did not know about
   * (an older layout, a rename, or a row written by a previous half-applied move).
   * Leaving such a row behind is exactly what made a class change "revert" (the old
   * class row survived next to the new one and won the merge on reload), so each one
   * is removed in the same atomic update.
   * ------------------------------------------------------------------------ */
  const destinationNode = graduated
    ? ''
    : relativeKey(base, dbPaths.yearSectionStudent(
      schoolId, yearKey, toDbClassId(nextClassId), nextSectionId, studentMasterId,
    ));

  // The real location(s) of this pupil inside the year's roster — discovered, not
  // guessed, so a custom শাখা label (or a row left by an earlier half-applied move in
  // a class the caller does not know about) can never keep a stale row alive.
  const yearStudentsNode = asRecord(await safeRead(dbPaths.yearStudents(schoolId, yearKey), {}));
  Object.entries(yearStudentsNode).forEach(([rawClassId, classNode]) => {
    const classKey = toDbClassId(rawClassId);
    if (!classKey || classKey === 'archive' || !isObject(classNode)) return;
    Object.entries(classNode).forEach(([sectionOrId, entry]) => {
      if (!isObject(entry)) return;
      // `students/{classId}/{studentMasterId}` — the layout written before শাখা folders.
      if (sectionOrId === studentMasterId) {
        const node = relativeKey(base, dbPaths.yearStudent(schoolId, yearKey, classKey, studentMasterId));
        if (node !== destinationNode) paths[node] = null;
        return;
      }
      // `students/{classId}/{sectionId}/{studentMasterId}` — one শাখা folder.
      Object.keys(entry).forEach((nestedId) => {
        const row = entry[nestedId];
        if (!isObject(row)) return;
        if (nestedId !== studentMasterId && row.studentMasterId !== studentMasterId) return;
        const node = relativeKey(base, dbPaths.yearSectionStudent(
          schoolId, yearKey, classKey, sectionOrId, studentMasterId,
        ));
        if (node !== destinationNode) paths[node] = null;
      });
    });
  });

  // Belt and braces: the nominal source folder and every class-level legacy node.
  if (prevClassId && prevClassId !== 'archive' && !graduated) {
    const sourceNode = relativeKey(base, enrollmentNodePath(
      schoolId, yearKey, prevClassId, studentMasterId, prevSectionId,
    ));
    if (sourceNode !== destinationNode) paths[sourceNode] = null;
  }
  [...CLASS_LEVEL_IDS, ...CLASS_LEVEL_IDS.map(toDbClassId)].forEach((classId) => {
    legacyEnrollmentPaths(schoolId, yearKey, classId, studentMasterId)
      .forEach((path) => {
        const node = relativeKey(base, path);
        if (node !== destinationNode) paths[node] = null;
      });
  });
  if (!graduated) {
    // A pupil restored/promoted out of the archive must not linger there either.
    [dbPaths.yearPassedStudent(schoolId, yearKey, studentMasterId),
      dbPaths.yearPassedArchiveYearStudent(schoolId, yearKey, yearKey, studentMasterId),
      `${dbPaths.yearPassedArchive(schoolId, yearKey)}/${yearKey}/${studentMasterId}`,
    ].forEach((path) => { paths[relativeKey(base, path)] = null; });
  }

  /* 3. The permanent identity records the new current class. ------------------ */
  const master = asRecord(await safeRead(dbPaths.studentMasterEntry(schoolId, studentMasterId), {}));
  paths[relativeKey(base, dbPaths.studentMasterEntry(schoolId, studentMasterId))] = cleanForCloud({
    ...master,
    ...personal,
    studentMasterId,
    legacyId: master.legacyId || move.legacyId || studentMasterId,
    overallStatus: graduated ? 'graduated' : 'active',
    currentClassId: graduated ? 'archived' : toDbClassId(nextClassId),
    ...(graduated
      ? { graduatedYear: yearKey, archivedYear: yearKey }
      : { academicYear: yearKey }),
    updatedAt: now,
  });

  invalidateStudentMasterIndex(schoolId);
  return safeUpdate(base, paths);
}

/**
 * Marks a pupil as graduated: permanent identity status + this year's archive row.
 * The previous year's roster node is intentionally left untouched.
 */
export async function markStudentGraduated(schoolId, studentMasterId, { year = '', classId = '', roll = 0, section = '' } = {}) {
  if (!schoolId || !studentMasterId) return { synced: false };
  const yearKey = normalizeSessionYear(year);
  if (yearKey) await ensureSchoolYear(schoolId, yearKey);
  const base = studentSchoolBasePath(schoolId);
  const updatedAt = nowISO();
  const patch = {
    ...flattenPatch(
      relativeKey(base, dbPaths.studentMasterEntry(schoolId, studentMasterId)),
      { overallStatus: 'graduated', graduatedYear: yearKey, updatedAt },
    ),
  };
  if (yearKey && classId) {
    Object.assign(patch, flattenPatch(
      relativeKey(base, enrollmentNodePath(schoolId, yearKey, classId, studentMasterId, section)),
      { status: 'graduated', updatedAt },
    ));
  }
  return safeUpdate(base, patch);
}

/**
 * Legacy flat batch move (yearless roster / demo reset).
 *
 * DEPRECATED for new writes: this writes ONLY the legacy `schoolData/{schoolId}`
 * flat nodes. It is kept because `archiveStudentCloud` / `restoreStudentCloud`
 * (old yearless callers) still use it, and because a live-DB check has not yet
 * proven that no old data lives ONLY under the flat nodes. Do NOT call it for
 * new roster work — use the hierarchical `saveStudentPatch` / `moveStudentClass`
 * path instead. Old flat rows are never deleted by the hierarchical writers.
 * @param {Array<{id:string, from:'students'|'archive', to:'students'|'archive', student:object}>} moves
 */
export function moveStudentsCloud(schoolId, moves = []) {
  const patch = {};
  moves.forEach(({ id, from, to, student }) => {
    if (!id) return;
    if (from === to) {
      patch[`${to}/${id}`] = cleanForCloud(student);
      return;
    }
    patch[`${from}/${id}`] = null;
    patch[`${to}/${id}`] = cleanForCloud(student);
  });
  if (Object.keys(patch).length === 0) return Promise.resolve({ synced: true });
  return safeUpdate(dbPaths.workspace(schoolId), patch);
}

/** Wholesale roster replacement — only used by demo reset / bulk import.
 * DEPRECATED for new writes (legacy flat nodes only, see `moveStudentsCloud`). */
export async function saveStudents(schoolId, students = []) {
  const active = Object.fromEntries(
    students.filter((student) => student.classId !== 'archive').map((student) => [student.id, student]),
  );
  const archive = Object.fromEntries(
    students.filter((student) => student.classId === 'archive').map((student) => [student.id, student]),
  );
  const patch = {};
  Object.entries(active).forEach(([studentId, student]) => {
    patch[`students/${studentId}`] = cleanForCloud(student);
  });
  Object.entries(archive).forEach(([studentId, student]) => {
    patch[`archive/${studentId}`] = cleanForCloud(student);
  });
  if (Object.keys(patch).length === 0) return { synced: true };
  return safeUpdate(dbPaths.workspace(schoolId), patch);
}

export default {
  subscribeStudents,
  subscribeSectionRegistry,
  registerSectionCloud,
  unregisterSectionCloud,
  normalizeSectionRegistry,
  readYearRoster,
  readStudentMaster,
  addStudentCloud,
  importStudentsCloud,
  updateStudentCloud,
  deleteStudentCloud,
  archiveStudentCloud,
  restoreStudentCloud,
  moveStudentsCloud,
  saveStudents,
  writePromotionEnrollment,
  moveStudentClass,
  markStudentGraduated,
  formatStudentMasterId,
  generateStudentMasterId,
  resolveStudentMasterId,
  buildStudentMasterRecord,
  buildEnrollmentRecord,
  buildYearRoster,
  mergeStudentRecord,
  normalizeEnrollmentMap,
};







