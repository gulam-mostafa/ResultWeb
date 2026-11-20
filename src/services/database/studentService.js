import { cleanForCloud, safeRead, safeSubscribe, safeUpdate } from './dbFallback.js';
import { DEFAULT_SECTION_ID, dbPaths, normalizeSessionYear, sectionSegment } from './dbPaths.js';
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

/** Keys never copied verbatim into the master node. */
const RESERVED_FIELD_KEYS = Object.freeze([
  'id', 'studentMasterId', 'legacyId', 'localId', 'classId', 'roll', 'section',
  'status', 'overallStatus', 'isDeleted', 'createdAt', 'updatedAt',
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

/** Mints the next unique `studentMasterId` for a year (reads the master index). */
export async function generateStudentMasterId(schoolId, year) {
  const yearKey = normalizeSessionYear(year, String(new Date().getFullYear()));
  const masters = asRecord(await safeRead(dbPaths.studentMaster(schoolId), {}));
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

/** Yearly enrollment row — the only part of a pupil that changes year to year. */
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

const mergeEnrollmentMaps = (...maps) => maps.reduce((acc, map) => {
  Object.entries(normalizeEnrollmentMap(map)).forEach(([classId, entries]) => {
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

  Object.entries(normalizeEnrollmentMap(enrollments)).forEach(([classId, entries]) => {
    Object.entries(entries).forEach(([masterId, enrollment]) => {
      const merged = mergeStudentRecord(masterMap[masterId], enrollment, classId);
      if (merged.isDeleted && !includeDeleted) return;
      students.push(merged);
    });
  });

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

  const base = studentSchoolBasePath(schoolId);
  const primary = await safeUpdate(base, {
    [relativeKey(base, dbPaths.studentMasterEntry(schoolId, studentMasterId))]: master,
    [relativeKey(base, enrollmentNodePath(schoolId, yearKey, classId, studentMasterId, enrollment.section))]: enrollment,
  });

  const legacyId = enrollment.legacyId || record.id || studentMasterId;
  invalidateStudentMasterIndex(schoolId);
  const workspace = dbPaths.workspace(schoolId);
  const mirrorPath = classId === 'archive'
    ? dbPaths.archivedStudent(schoolId, legacyId)
    : dbPaths.student(schoolId, legacyId);
  await safeUpdate(workspace, {
    [relativeKey(workspace, mirrorPath)]: cleanForCloud({
      ...record,
      ...master,
      ...enrollment,
      id: legacyId,
      legacyId,
      studentMasterId,
    }),
  });

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

  const primary = Object.keys(patchPaths).length
    ? await safeUpdate(base, patchPaths)
    : { synced: true };

  // Legacy flat mirror keeps the flat roster accurate for older readers.
  const workspace = dbPaths.workspace(schoolId);
  const legacyId = String(existingStudent?.legacyId || existingStudent?.id || studentId);
  const legacyPatch = {};
  const targetClassId = nextClassId || prevClassId || existingStudent?.classId || '';
  if (legacyId && targetClassId) {
    const mirrorPath = targetClassId === 'archive'
      ? dbPaths.archivedStudent(schoolId, legacyId)
      : dbPaths.student(schoolId, legacyId);
    legacyPatch[relativeKey(workspace, mirrorPath)] = cleanForCloud({
      ...existingStudent,
      ...clean,
      id: legacyId,
      legacyId,
      ...(studentMasterId ? { studentMasterId } : {}),
      classId: targetClassId,
      status: targetClassId === 'archive' ? 'archived' : (enrollment.status ?? existingStudent?.status ?? 'active'),
      updatedAt: nowISO(),
    });
    if (prevClassId && targetClassId !== prevClassId) {
      const previousPath = prevClassId === 'archive'
        ? dbPaths.archivedStudent(schoolId, legacyId)
        : dbPaths.student(schoolId, legacyId);
      if (previousPath !== mirrorPath) legacyPatch[relativeKey(workspace, previousPath)] = null;
    }
  }
  if (Object.keys(legacyPatch).length) await safeUpdate(workspace, legacyPatch);
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

  const workspace = dbPaths.workspace(schoolId);
  const legacyId = String(masters[studentMasterId]?.legacyId ?? studentMasterId ?? studentId);
  if (legacyId) {
    await safeUpdate(workspace, {
      [relativeKey(workspace, dbPaths.student(schoolId, legacyId))]: { isDeleted: true, deletedAt, updatedAt: deletedAt },
      [relativeKey(workspace, dbPaths.archivedStudent(schoolId, legacyId))]: { isDeleted: true, deletedAt, updatedAt: deletedAt },
    });
  }

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

/** Wholesale roster replacement — only used by demo reset / bulk import. */
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
  updateStudentCloud,
  deleteStudentCloud,
  archiveStudentCloud,
  restoreStudentCloud,
  moveStudentsCloud,
  saveStudents,
  writePromotionEnrollment,
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







