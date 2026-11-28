import { runTransaction, ref } from 'firebase/database';
import { db } from '../../firebase/firebaseConfig.js';
import { MEMBER_STATUS, resolveClassKey } from '../../utils/constants.js';
import { normalizeSchoolProfile, pickProfileFields } from '../../utils/schoolProfile.js';
import { normalizeRoll, planPromotionRolls } from '../../utils/rollAssignment.js';
import { cleanForCloud, safeRead, safeSubscribe, safeUpdate } from './dbFallback.js';
import {
  dbPaths,
  getSchoolBasePath,
  getSchoolIndexEntryPath,
  getSchoolLocatorPath,
  getUserPath,
  hydrateSchoolLocation,
  normalizeLocation,
  normalizeSessionYear,
  rememberSchoolLocation,
  resolveSchoolLocation,
  schoolIdOf,
  sectionSegment,
} from './dbPaths.js';

export const DEFAULT_ACTIVE_YEAR = '2026';

export const CLASS_ORDER = Object.freeze([
  'pre-primary',
  'class-1',
  'class-2',
  'class-3',
  'class-4',
  'class-5',
]);

export const DEMO_SCHOOL_LOCATION = Object.freeze({
  divisionId: 'dhaka',
  districtId: 'gazipur',
  upazilaId: 'gazipur-sadar',
  schoolId: 'demo-school-01',
});

const asRecord = (value) => (value && typeof value === 'object' && !Array.isArray(value) ? value : {});
const isObjectRecord = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const isLiveMember = (member) => Boolean(member) && member.isDeleted !== true;

const slug = (value) => String(value ?? '').trim().toLowerCase()
  .replace(/[^\p{L}\p{N}\p{M}]+/gu, '_')
  .replace(/^_+|_+$/g, '')
  .slice(0, 48);

const nameHash = (value) => {
  let hash = 5381;
  const text = String(value ?? '').trim();
  for (let index = 0; index < text.length; index += 1) {
    hash = ((hash << 5) + hash + text.charCodeAt(index)) >>> 0;
  }
  return hash.toString(36);
};

export function buildSchoolId(location, name) {
  const place = [location?.divisionId, location?.districtId, location?.upazilaId]
    .map(slug)
    .filter(Boolean);
  if (place.length < 3) return '';
  const nameSlug = slug(name) || `s${nameHash(name)}`;
  return [...place, nameSlug].join('_');
}

const buildIndexEntry = (school, now = new Date().toISOString()) => {
  const deleted = Boolean(school.isDeleted);
  return {
    id: school.id,
    name: school.name ?? '',
    emisCode: school.emisCode ?? '',
    divisionId: school.divisionId ?? '',
    districtId: school.districtId ?? '',
    upazilaId: school.upazilaId ?? '',
    ...(school.verified !== undefined ? { verified: Boolean(school.verified) } : {}),
    isDeleted: deleted,
    deletedAt: deleted ? (school.deletedAt ?? now) : null,
    updatedAt: now,
  };
};

const buildProfileEntry = (schoolId, location, school, now) => {
  const activeYear = normalizeSessionYear(
    school?.activeYear ?? school?.academicYear ?? school?.session,
    DEFAULT_ACTIVE_YEAR,
  ) || DEFAULT_ACTIVE_YEAR;
  const profile = normalizeSchoolProfile({
    ...location,
    ...pickProfileFields(school ?? {}),
    ...(school?.name !== undefined ? { name: school.name, schoolName: school.name } : {}),
    ...(school?.emisCode !== undefined ? { emisCode: school.emisCode } : {}),
    id: schoolId,
  });
  return cleanForCloud({
    ...profile,
    id: schoolId,
    divisionId: location.divisionId,
    districtId: location.districtId,
    upazilaId: location.upazilaId,
    academicYear: activeYear,
    activeYear,
    createdAt: now,
    createdBy: school?.createdBy ?? null,
    updatedAt: now,
  });
};

/**
 * Canonical storage key of a class id: app ids (`pre`, `c5`) and canonical keys
 * (`class-5`) resolve to the same node; `archive` is never remapped.
 */
const classKey = (classId) => {
  const key = String(classId ?? '').trim();
  if (!key || key === 'archive') return key;
  return resolveClassKey(key);
};

/** Markers that tell a leaf enrollment row from a `{sectionId: {…}}` folder. */
const ENROLLMENT_ROW_MARKERS = Object.freeze(['roll', 'status', 'studentMasterId', 'name', 'legacyId']);

const isEnrollmentRow = (value) => isObjectRecord(value)
  && ENROLLMENT_ROW_MARKERS.some((key) => value[key] !== undefined);

/**
 * Flattens one year's `students` node into `{[classId]: {[studentMasterId]: row}}`.
 *
 * Rows live in a শাখা folder (`{class-1: {ক: {id: row}}}`), but the older
 * `{class-1: {id: row}}` and fully flat `{id: row}` layouts stay readable, and the
 * section a row belongs to is carried on the record itself.
 */
const flattenEnrollmentNode = (studentsNode) => {
  const byClass = {};
  const write = (storageClassId, studentMasterId, record, sectionFolder) => {
    if (!CLASS_ORDER.includes(storageClassId)) return;
    byClass[storageClassId] = byClass[storageClassId] ?? {};
    byClass[storageClassId][studentMasterId] = {
      ...record,
      section: sectionSegment(record.section ?? sectionFolder),
    };
  };
  Object.entries(asRecord(studentsNode)).forEach(([rawClassId, entries]) => {
    const storageClassId = classKey(rawClassId);
    Object.entries(asRecord(entries)).forEach(([entryKey, entry]) => {
      if (!isObjectRecord(entry)) return;
      if (isEnrollmentRow(entry)) {
        write(storageClassId, entryKey, entry, '');
        return;
      }
      Object.entries(entry).forEach(([masterId, record]) => {
        if (isObjectRecord(record)) write(storageClassId, masterId, record, entryKey);
      });
    });
  });
  return byClass;
};

/**
 * Keys that belong to one year's enrollment row — they must never leak into the
 * permanent `studentMaster/{id}` identity, otherwise an old class/roll would win
 * over the current enrollment when the two are merged for display.
 */
const MASTER_LIFETIME_KEYS = Object.freeze([
  'id', 'studentMasterId', 'legacyId', 'localId',
  'classId', 'roll', 'section', 'status',
  'overallStatus', 'isDeleted', 'createdAt', 'updatedAt', 'deletedAt',
  // Year/roster bookkeeping belongs to the enrollment row only.
  'year', 'previousClassId', 'promotedFromClass', 'promotedFromYear', 'promotedAt',
  'isNewPromotion', 'retainedAt',
  'academicYear', 'archivedYear', 'archivedAt', 'archivedFromClass',
  'passedYear', 'passedAt', 'graduatedYear',
  'meritPosition', 'gpa', 'grade', 'grandTotal',
]);

/**
 * Permanent identity patch for one promoted/graduated pupil.
 *
 * The base is the pupil's EXISTING master record (so a name, father's name, date of
 * birth… is never lost just because the roster row only carries enrollment fields),
 * extended with whatever personal fields the roster row does carry. Every yearly key
 * is filtered out, so an old class/roll can never win when the master and the
 * year's enrollment are merged for display.
 */
const buildMasterUpdate = (existingMaster, record, { studentMasterId, now, extra = {} }) => {
  const base = asRecord(existingMaster);
  const personal = {};
  Object.entries(asRecord(record)).forEach(([key, value]) => {
    if (value === undefined || MASTER_LIFETIME_KEYS.includes(key)) return;
    personal[key] = value;
  });
  return cleanForCloud({
    ...base,
    ...personal,
    studentMasterId,
    legacyId: base.legacyId || personal.legacyId || studentMasterId,
    ...extra,
    updatedAt: now,
  });
};

const YEAR_BUCKET_TTL_MS = 5 * 60 * 1000;
/** `basePath@year` ➔ pending `syncYearBuckets()` — every write path shares it. */
const yearBucketCache = new Map();

async function syncYearBuckets(location, normalized, sessionYear) {
  const basePath = getSchoolBasePath(normalized);
  const yearPath = `${basePath}/sessions/${sessionYear}`;
  const now = new Date().toISOString();

  const [studentsNode, resultsNode, profileNode, metaNode] = await Promise.all([
    safeRead(`${yearPath}/students`, null),
    safeRead(`${yearPath}/results`, null),
    safeRead(`${basePath}/profile`, null),
    safeRead(`${yearPath}/meta`, null),
  ]);

  const writes = [];

  // Only stamp the year label when it is missing/changed, so this never turns into
  // a periodic write on a school that is merely typing marks.
  if (!isObjectRecord(metaNode) || normalizeSessionYear(metaNode.year) !== sessionYear) {
    writes.push(safeUpdate(`${yearPath}/meta`, { year: sessionYear, updatedAt: now }));
  }

  // A class bucket is only seeded when it is genuinely absent, so a real roster can
  // never be replaced by a placeholder. Empty objects are not persisted by the
  // Realtime Database, so this seeding is BEST EFFORT: it never decides `synced`.
  const bestEffort = [];
  const seedClassBuckets = (node, path) => {
    const parent = node === null || node === undefined ? {} : node;
    if (!isObjectRecord(parent)) return;
    const patch = {};
    CLASS_ORDER.forEach((classId) => {
      if (!isObjectRecord(parent[classId])) patch[classId] = {};
    });
    if (Object.keys(patch).length > 0) bestEffort.push(safeUpdate(path, patch));
  };
  seedClassBuckets(studentsNode, `${yearPath}/students`);
  seedClassBuckets(resultsNode, `${yearPath}/results`);

  // `profile` is the school's permanent identity: seed it once (and only when the
  // name is actually known), never overwrite an existing record.
  if (!isObjectRecord(profileNode) || Object.keys(profileNode).length === 0) {
    const seed = cleanForCloud(pickProfileFields(asRecord(location))) ?? {};
    const name = String(seed.name ?? seed.schoolName ?? '').trim();
    if (name) {
      writes.push(safeUpdate(
        `${basePath}/profile`,
        buildProfileEntry(normalized.schoolId, normalized, { ...seed, name, schoolName: name }, now),
      ));
    }
  }

  // `teachers/{uid}` is written by the member service; a school with no staff yet
  // simply has no node, and `subscribeSchoolTeachers` already treats that as `{}`.

  // Best-effort bucket seeding first (never awaited for the verdict), then the
  // writes that genuinely decide whether the year is ready.
  if (bestEffort.length > 0) Promise.all(bestEffort).catch(() => {});
  if (writes.length === 0) return { synced: true, year: sessionYear };
  const results = await Promise.all(writes);
  return { synced: results.every((entry) => entry?.synced !== false), year: sessionYear };
}

/**
 * Ensures the campus skeleton of one academic year:
 *
 * ```text
 * divisions/…/schools/{schoolId}/profile
 * divisions/…/schools/{schoolId}/studentMaster
 * divisions/…/schools/{schoolId}/teachers            ← written by the member service
 * divisions/…/schools/{schoolId}/sessions/{year}/students/{classId}
 * divisions/…/schools/{schoolId}/sessions/{year}/results/{classId}
 * divisions/…/schools/{schoolId}/sessions/{year}/passedArchive
 * divisions/…/schools/{schoolId}/sessions/{year}/meta
 * ```
 *
 * Idempotent and memoised (5 minutes per school+year) because every student/result
 * write funnels through it; a failed sync retries on the next call.
 */
export async function ensureSchoolYearBuckets(location, year = DEFAULT_ACTIVE_YEAR) {
  const normalized = normalizeLocation(location);
  if (!normalized) return { synced: false };
  const sessionYear = normalizeSessionYear(year, DEFAULT_ACTIVE_YEAR) || DEFAULT_ACTIVE_YEAR;
  // Remembering the location keeps every `dbPaths` helper on the hierarchical node.
  rememberSchoolLocation(normalized);

  const key = `${getSchoolBasePath(normalized)}@${sessionYear}`;
  const cached = yearBucketCache.get(key);
  if (cached && Date.now() - cached.at < YEAR_BUCKET_TTL_MS) return cached.pending;

  const pending = syncYearBuckets(location, normalized, sessionYear)
    .catch(() => ({ synced: false, year: sessionYear }))
    .then((result) => {
      if (result?.synced === false) yearBucketCache.delete(key);
      return result;
    });
  yearBucketCache.set(key, { at: Date.now(), pending });
  return pending;
}

/**
 * `ensureSchoolYearBuckets` for callers that only hold a bare `schoolId`
 * (the location is served from the cache, or hydrated from `schoolLocator/{id}`).
 */
export async function ensureSchoolYear(schoolId, year = DEFAULT_ACTIVE_YEAR) {
  const reference = schoolIdOf(schoolId);
  if (!reference) return { synced: false };
  const location = resolveSchoolLocation(reference) ?? await hydrateSchoolLocation(reference);
  if (!location) return { synced: false };
  return ensureSchoolYearBuckets(location, year);
}

/** Next / previous canonical class of one class key (`class-5` ➔ `''`). */
const nextClassOf = (classId) => {
  const index = CLASS_ORDER.indexOf(classKey(classId));
  return index < 0 || index === CLASS_ORDER.length - 1 ? '' : CLASS_ORDER[index + 1];
};
const previousClassOf = (classId) => {
  const index = CLASS_ORDER.indexOf(classKey(classId));
  return index <= 0 ? '' : CLASS_ORDER[index - 1];
};

/**
 * Orders one destination class for roll numbering.
 *
 * A destination bucket can hold pupils from several source classes (a retained
 * class-2 pupil next to a demoted class-3 pupil), so each entry's merit is read from
 * ITS OWN source class. The stored final-term merit position comes first, then the
 * source roll — a missing marking sheet therefore never blocks a promotion and never
 * reshuffles a roster for no reason.
 */
const orderByMeritAndRoll = (entries, resultsTree) => {
  const rankOf = (entry) => {
    const rank = Number(finalMeritOf(resultsTree, entry.sourceClassId, entry.studentMasterId).meritPosition);
    return Number.isFinite(rank) && rank > 0 ? rank : null;
  };
  return [...entries].sort((a, b) => {
    const aRank = rankOf(a);
    const bRank = rankOf(b);
    if (aRank && bRank && aRank !== bRank) return aRank - bRank;
    if (Boolean(aRank) !== Boolean(bRank)) return aRank ? -1 : 1;
    const rollDiff = (Number(a.record?.roll) || 0) - (Number(b.record?.roll) || 0);
    if (rollDiff !== 0) return rollDiff;
    return String(a.record?.name ?? '').localeCompare(String(b.record?.name ?? ''), 'bn');
  });
};

/**
 * Published final-term merit of one pupil in one class
 * (`{ meritPosition, gpa, grade, grandTotal }`, all `null` when unpublished).
 */
const finalMeritOf = (resultsTree, classId, studentMasterId) => {
  const classNode = asRecord(resultsTree?.[classKey(classId)]);
  const row = asRecord(asRecord(classNode.final ?? classNode.annual)[studentMasterId]);
  const rank = Number(row.meritPosition ?? row.rank);
  return {
    meritPosition: Number.isFinite(rank) && rank > 0 ? rank : null,
    gpa: row.gpa ?? null,
    grade: row.grade ?? '',
    grandTotal: row.grandTotal ?? row.total ?? null,
  };
};


/**
 * One term row's total marks. The stored `grandTotal` wins when it exists;
 * otherwise the total is summed from the row's own subject marks, so a row
 * written by an older save path (subjects only, no stored total) still ranks
 * by its real marks. Returns `{ total, hasMarks }`.
 */
const termTotalOf = (row) => {
  const record = asRecord(row);
  const stored = Number(record.grandTotal ?? record.total);
  if (Number.isFinite(stored)) return { total: stored, hasMarks: true };
  let sum = 0;
  let hasMarks = false;
  Object.values(asRecord(record.subjects)).forEach((mark) => {
    const total = Number(mark?.total);
    if (Number.isFinite(total)) { sum += total; hasMarks = true; return; }
    const f = Number(mark?.formative);
    const s = Number(mark?.summative);
    if (Number.isFinite(f) || Number.isFinite(s)) {
      sum += (Number.isFinite(f) ? f : 0) + (Number.isFinite(s) ? s : 0);
      hasMarks = true;
      return;
    }
    if (typeof mark === 'number' && Number.isFinite(mark)) { sum += mark; hasMarks = true; }
  });
  return { total: sum, hasMarks };
};

/** Term weights as percentages summing to 100 (default 15/15/70). */
const DEFAULT_TERM_WEIGHTS = { term1: 15, term2: 15, annual: 70 };
const weightsForClass = (configTree, classId) => {
  const raw = asRecord(asRecord(configTree)?.[classKey(classId)]?.weights);
  const pick = (key) => {
    const value = Number(raw[key]);
    return Number.isFinite(value) && value >= 0 ? value : DEFAULT_TERM_WEIGHTS[key];
  };
  const weights = { term1: pick('term1'), term2: pick('term2'), annual: pick('annual') };
  const sum = weights.term1 + weights.term2 + weights.annual;
  if (!(sum > 0)) return { ...DEFAULT_TERM_WEIGHTS };
  return {
    term1: (weights.term1 / sum) * 100,
    term2: (weights.term2 / sum) * 100,
    annual: (weights.annual / sum) * 100,
  };
};

/**
 * One pupil's ANNUAL merit for the COMBINED destination-class ranking:
 * the previous year's বার্ষিক ফলাফল total marks — the SAME weighted total
 * (`term1 × w1 + term2 × w2 + annual × wA`) the result sheet and the
 * promotion modal rank by. (The old code read only the raw annual-term
 * `grandTotal`, a different number with a different order — that is why the
 * new rolls looked jumbled next to the modal's merit list.)
 * The source class is the class the pupil sat in during the source year — for a
 * newly promoted pupil that is the class being promoted, for a pupil already in
 * the destination class it is the class they came from (`promotedFromClass`).
 * Returns `{ total }`, or `null` when the pupil has no marks in any term of
 * the source year (new admission, or a year with no marks entered) — such a
 * pupil keeps their current roll.
 */
const combinedMeritOf = (resultsTree, sourceClassId, studentMasterId, configTree) => {
  if (!sourceClassId || !studentMasterId) return null;
  const classNode = asRecord(resultsTree?.[classKey(sourceClassId)]);
  const weights = weightsForClass(configTree, sourceClassId);
  const t1 = termTotalOf(asRecord(classNode.term1)[studentMasterId]);
  const t2 = termTotalOf(asRecord(classNode.term2)[studentMasterId]);
  const ta = termTotalOf(asRecord(classNode.final ?? classNode.annual)[studentMasterId]);
  if (!t1.hasMarks && !t2.hasMarks && !ta.hasMarks) return null;
  const total = Math.round(
    ((t1.total * weights.term1 + t2.total * weights.term2 + ta.total * weights.annual) / 100) * 100,
  ) / 100;
  return { total };
};

/**
 * Combined merit order — TOTAL MARKS of the previous year's annual result
 * only (no GPA, no per-class merit position, which cannot compare two
 * classes). Ties fall to the old roll, then name, so the order is stable.
 */
const byCombinedMerit = (a, b) => (
  (b.merit.total - a.merit.total)
  || (Number(a.record?.roll) || Number.MAX_SAFE_INTEGER) - (Number(b.record?.roll) || Number.MAX_SAFE_INTEGER)
  || String(a.record?.name ?? '').localeCompare(String(b.record?.name ?? ''), 'bn')
);

/**
 * Year-end promotion for one school (`sessions/{currentYear}` ➔ `sessions/{nextYear}`).
 *
 * Guarantees, matching `sessionService.promoteSession`:
 *  - `sessions/{currentYear}/students` and `/results` are **never** edited — a
 *    finished year stays complete history;
 *  - every pupil keeps the same permanent `studentMasterId`; the destination year
 *    receives `sessions/{nextYear}/students/{classId}/{studentMasterId}` with a roll
 *    ordered by the previous year's annual total marks (বার্ষিক ফলাফল);
 *  - Class-5 leavers are filed into `sessions/{nextYear}/passedArchive/{id}` and
 *    their `studentMaster/{id}` is stamped `overallStatus: 'graduated'`.
 *
 * @param {object} location complete school location (division/district/upazila/schoolId)
 * @param {string} currentYear source academic year
 * @param {string} [nextYear] destination academic year (defaults to source + 1)
 * @param {{decisions?: Array<{studentId?:string, studentMasterId?:string, action?:'promote'|'retain'|'demote'}>,
 *          students?: Array<object>, advanceProfileYear?: boolean}} [options]
 *        `decisions` carries explicit teacher choices; `students` supplies the
 *        already-merged source roster (defaults to reading the year node);
 *        `advanceProfileYear` (default `true`) moves `profile.activeYear` to the
 *        destination year — pass `false` for a partial promotion that must leave the
 *        school's active year alone.
 */
export async function promoteStudentsToNextYear(location, currentYear, nextYear, options = {}) {
  const normalized = normalizeLocation(location);
  if (!normalized) return { synced: false, promotedCount: 0, archivedCount: 0 };
  const fromYear = normalizeSessionYear(currentYear, DEFAULT_ACTIVE_YEAR) || DEFAULT_ACTIVE_YEAR;
  const toYear = normalizeSessionYear(nextYear) || String(Number(fromYear) + 1);
  if (!toYear || toYear === fromYear) {
    return { synced: false, promotedCount: 0, archivedCount: 0, reason: 'invalid-target-year' };
  }
  // Remembering the location guarantees the paths below are the hierarchical nodes,
  // and registration is what keeps `dbPaths.yearStudent(…)` off the legacy tree.
  rememberSchoolLocation(normalized);
  const basePath = getSchoolBasePath(normalized);
  const fromYearPath = `${basePath}/sessions/${fromYear}`;
  const toYearPath = `${basePath}/sessions/${toYear}`;
  const now = new Date().toISOString();

  await ensureSchoolYearBuckets(normalized, fromYear);
  await ensureSchoolYearBuckets(normalized, toYear);

  const [studentsNode, resultsTree, masterMap, resultConfigTree] = await Promise.all([
    safeRead(`${fromYearPath}/students`, {}),
    safeRead(`${fromYearPath}/results`, {}),
    safeRead(`${basePath}/studentMaster`, {}),
    // আগের সালের বার্ষিক ওজন (১৫/১৫/৭০ বা শিক্ষকের নিজের সেটিং) — মেধার
    // মোট নম্বরটা রেজাল্ট শিটের বার্ষিক ফলাফলের মতোই ওজনযুক্ত হয়।
    safeRead(`${fromYearPath}/meta/resultConfig`, {}),
  ]);

  // দেরিতে প্রমোশন: গন্তব্য সালে আগেই শিক্ষার্থী থাকতে পারে (নতুন ভর্তি, বা আগের
  // প্রমোশন)। গন্তব্যের রোস্টার এখানে পড়া হয়; নতুন রোলের হিসাব নিচে, রোল
  // বণ্টনের ঠিক আগে করা হয় — যাতে এই প্রমোশনে যাওয়া শিক্ষার্থীরা নিজেরাই
  // হিসাব থেকে বাদ যায় (একই শ্রেণি আবার প্রমোশন করলে রোল বদলাবে না)।
  const targetStudentsNode = await safeRead(`${toYearPath}/students`, {});
  const targetEnrollment = flattenEnrollmentNode(targetStudentsNode);

  // Older rosters may still be keyed by the app ids (`pre`, `c5`) and older rows may
  // sit directly under the class node instead of a শাখা folder: both layouts are
  // normalised so one class/section can never be promoted twice.
  const enrollmentByClass = flattenEnrollmentNode(studentsNode);

  // A caller that has already merged the roster (master + enrolment rows, legacy
  // spellings included) passes it in; it then becomes the authoritative list.
  const suppliedRoster = (options?.students ?? [])
    .filter((student) => isObjectRecord(student) && student.classId && student.classId !== 'archive');
  if (suppliedRoster.length > 0) {
    Object.keys(enrollmentByClass).forEach((classId) => delete enrollmentByClass[classId]);
    suppliedRoster.forEach((student) => {
      const studentMasterId = String(student.studentMasterId || student.id || '').trim();
      const storageClassId = classKey(student.classId);
      if (!studentMasterId || !CLASS_ORDER.includes(storageClassId)) return;
      enrollmentByClass[storageClassId] = enrollmentByClass[storageClassId] ?? {};
      enrollmentByClass[storageClassId][studentMasterId] = student;
    });
  }

  const decisionMap = new Map(
    (options?.decisions ?? [])
      .map((item) => [String(item?.studentMasterId || item?.studentId || '').trim(), item?.action || 'promote'])
      .filter(([id]) => Boolean(id)),
  );
  /**
   * The teacher's শাখা choice travels with the decision (the promotion modal lets
   * the teacher move a pupil to another শাখা of the destination class). It used to
   * be dropped here — every pupil silently kept their old শাখা — even though the
   * modal promises the new শাখা is saved. A blank/omitted section still falls back
   * to the pupil's own শাখা.
   */
  const decisionSectionMap = new Map(
    (options?.decisions ?? [])
      .map((item) => [String(item?.studentMasterId || item?.studentId || '').trim(), String(item?.section ?? '').trim()])
      .filter(([id, section]) => Boolean(id) && Boolean(section)),
  );
  const decisionSectionFor = (studentMasterId, record) => (
    decisionSectionMap.get(studentMasterId)
    || decisionSectionMap.get(String(record?.legacyId ?? ''))
    || ''
  );
  /**
   * When the caller supplies decisions, ONLY the pupils it decided are moved.
   *
   * A pupil with no explicit teacher decision is skipped entirely — never auto-promoted
   * and never auto-retained — because the pass decision must come from the consolidated
   * annual result the teacher reviewed. An undecided pupil simply keeps their current
   * year's enrollment untouched.
   */
  const decidedOnly = options?.decisions !== undefined && options?.decisions !== null;
  const decisionFor = (studentMasterId, record) => (
    decisionMap.get(studentMasterId)
    || decisionMap.get(String(record?.legacyId ?? ''))
    || ''
  );

  /** Every pupil of the source year, resolved to its destination class. */
  const moves = [];
  CLASS_ORDER.forEach((sourceClassId) => {
    Object.entries(asRecord(enrollmentByClass[sourceClassId])).forEach(([studentMasterId, record]) => {
      const decided = decisionFor(studentMasterId, record);
      // With explicit decisions, an undecided pupil is left where they are.
      if (decidedOnly && !decided) return;
      const action = decided || 'promote';
      const targetClassId = action === 'retain'
        ? sourceClassId
        : (action === 'demote'
          ? (previousClassOf(sourceClassId) || sourceClassId)
          : (nextClassOf(sourceClassId) || 'archive'));
      moves.push({
        studentMasterId,
        record,
        sourceClassId,
        targetClassId,
        section: decisionSectionFor(studentMasterId, record),
      });
    });
  });

  const promotions = moves.filter((move) => move.targetClassId && move.targetClassId !== 'archive');
  const graduates = moves.filter((move) => !move.targetClassId || move.targetClassId === 'archive');
  const nextYearClassUpdates = {};
  const archiveUpdates = {};
  const masterUpdates = {};

  // গন্তব্য শ্রেণির রোল মেধাক্রমে নতুন করে সাজে — নতুন ব্যাচ + ওই শ্রেণিতে আগে
  // থেকে থাকা শিক্ষার্থী (যেমন আগের প্রমোশনে একই শ্রেণিতে থেকে যাওয়া শিক্ষার্থী)
  // সবাই একসঙ্গে মেধা অনুযায়ী রোল পায়। আগে থাকা শিক্ষার্থী আগে এসেছে বলে
  // সামনের রোল ধরে বসে থাকে না — মেধায় যে এগিয়ে, রোল তারই আগে।
  // মেধা তথ্য নেই এমন শিক্ষার্থী (যেমন নতুন ভর্তি) তাদের বর্তমান রোলেই থাকে,
  // তাদের রোল নম্বর ফাঁকা রেখে বাকিদের রোল দেওয়া হয়।
  const batchIds = new Set(promotions.map((move) => move.studentMasterId));
  const existingByClassSection = new Map();
  Object.entries(asRecord(targetEnrollment)).forEach(([classId, byStudent]) => {
    Object.entries(asRecord(byStudent)).forEach(([studentMasterId, row]) => {
      if (batchIds.has(studentMasterId)) return;
      const key = `${classId}/${sectionSegment(row?.section)}`;
      existingByClassSection.set(key, [...(existingByClassSection.get(key) ?? []), { studentMasterId, record: row }]);
    });
  });
  // গন্তব্য শ্রেণিতে আগে থেকে থাকা শিক্ষার্থীদের রোল বদলে থাকলে শুধু সেই রোলটাই
  // আপডেট হয় (পুরো রো নয়) — একই atomic লেখায়, প্রমোশনের সঙ্গে।
  const existingRollUpdates = {};

  // Rolls are re-numbered ১..n per destination class AND শাখা, ordered by the
  // combined merit of everyone in that class+section. A pupil stays in their
  // own section folder (the default `ক` when they never had one).
  CLASS_ORDER.forEach((targetClassId) => {
    const inClass = promotions.filter((move) => move.targetClassId === targetClassId);
    if (inClass.length === 0) return;
    const bySection = new Map();
    inClass.forEach((move) => {
      // The teacher's chosen শাখা wins; otherwise the pupil keeps their own শাখা.
      const section = sectionSegment(move.section || move.record?.section);
      bySection.set(section, [...(bySection.get(section) ?? []), move]);
    });
    bySection.forEach((bucket, section) => {
      const existing = existingByClassSection.get(`${targetClassId}/${section}`) ?? [];
      // মেধা তথ্য আছে এমন আগের শিক্ষার্থীরা নতুন ব্যাচের সঙ্গে একসঙ্গে সাজে।
      const rankedExisting = [];
      const fixedRolls = new Set();
      existing.forEach((entry) => {
        const fromClass = entry.record?.promotedFromClass || entry.record?.previousClassId || '';
        const merit = String(entry.record?.promotedFromYear ?? '') === String(fromYear)
          ? combinedMeritOf(resultsTree, fromClass, entry.studentMasterId, resultConfigTree)
          : null;
        if (merit) rankedExisting.push({ ...entry, sourceClassId: fromClass, merit });
        else fixedRolls.add(Number(entry.record?.roll) || 0);
      });
      const rankedBatch = bucket.map((entry) => ({
        ...entry,
        merit: combinedMeritOf(resultsTree, entry.sourceClassId, entry.studentMasterId, resultConfigTree),
      }));
      const ranked = [...rankedExisting, ...rankedBatch].sort((a, b) => {
        if (a.merit && b.merit) return byCombinedMerit(a, b);
        if (Boolean(a.merit) !== Boolean(b.merit)) return a.merit ? -1 : 1;
        const rollDiff = (Number(a.record?.roll) || 0) - (Number(b.record?.roll) || 0);
        if (rollDiff !== 0) return rollDiff;
        return String(a.record?.name ?? '').localeCompare(String(b.record?.name ?? ''), 'bn');
      });
      // রোল ১ থেকে শুরু; মেধা তথ্য নেই এমন শিক্ষার্থীর রোল নম্বর ফাঁকা রাখা হয়।
      const usedRolls = new Set([...fixedRolls].filter((roll) => roll > 0));
      let nextRoll = 1;
      const newRollOf = new Map();
      ranked.forEach((entry) => {
        while (usedRolls.has(nextRoll)) nextRoll += 1;
        newRollOf.set(entry.studentMasterId, nextRoll);
        usedRolls.add(nextRoll);
        nextRoll += 1;
      });
      rankedBatch.forEach((entry) => {
        nextYearClassUpdates[`${targetClassId}/${section}/${entry.studentMasterId}`] = cleanForCloud({
          ...entry.record,
          studentMasterId: entry.studentMasterId,
          legacyId: entry.record?.legacyId ?? entry.record?.id ?? entry.studentMasterId,
          classId: targetClassId,
          roll: newRollOf.get(entry.studentMasterId),
          section,
          status: 'active',
          year: toYear,
          previousClassId: entry.sourceClassId,
          promotedFromClass: entry.sourceClassId,
          promotedFromYear: fromYear,
          academicYear: toYear,
          // The NEW year starts clean: last year's GPA / grade / merit / total belong to
          // the frozen history and must never label a fresh best-empty roster row.
          meritPosition: null,
          gpa: null,
          grade: '',
          grandTotal: null,
          promotedAt: now,
          updatedAt: now,
        });
      });
      rankedExisting.forEach((entry) => {
        const newRoll = newRollOf.get(entry.studentMasterId);
        const oldRoll = Number(entry.record?.roll) || 0;
        if (newRoll && newRoll !== oldRoll) {
          existingRollUpdates[`${targetClassId}/${section}/${entry.studentMasterId}`] = newRoll;
        }
      });
    });
  });

  // Class-5 leavers: the NEXT year's `passedArchive`, never a rewrite of the roster.
  // `passedYear` stays the source year (the year they passed — the backfill and the
  // undo safety check filter on it); `archivedYear` is the archive node it lives in.
  graduates.forEach((entry) => {
    const merit = finalMeritOf(resultsTree, entry.sourceClassId, entry.studentMasterId);
    archiveUpdates[entry.studentMasterId] = cleanForCloud({
      ...entry.record,
      studentMasterId: entry.studentMasterId,
      legacyId: entry.record?.legacyId ?? entry.record?.id ?? entry.studentMasterId,
      classId: entry.sourceClassId,
      status: 'passed',
      passedYear: fromYear,
      archivedYear: toYear,
      archivedFromClass: entry.sourceClassId,
      meritPosition: merit.meritPosition,
      gpa: merit.gpa,
      grade: merit.grade,
      grandTotal: merit.grandTotal,
      passedAt: now,
      updatedAt: now,
    });
  });

  // Permanent identity: only the personal fields plus the new current class, so an
  // old roll/class can never win when master and enrollment are merged for display.
  promotions.forEach((entry) => {
    masterUpdates[entry.studentMasterId] = buildMasterUpdate(masterMap?.[entry.studentMasterId], entry.record, {
      studentMasterId: entry.studentMasterId,
      now,
      extra: { currentClassId: entry.targetClassId, academicYear: toYear, overallStatus: 'active' },
    });
  });
  graduates.forEach((entry) => {
    masterUpdates[entry.studentMasterId] = buildMasterUpdate(masterMap?.[entry.studentMasterId], entry.record, {
      studentMasterId: entry.studentMasterId,
      now,
      extra: {
        currentClassId: 'archived',
        overallStatus: 'graduated',
        graduatedYear: fromYear,
        archivedYear: toYear,
      },
    });
  });

  // PRIMARY writes = the actual pupil movement (next year's roster + the leavers'
  // archive). SECONDARY writes = permanent identity + the profile's active year.
  // Only the primary verdict decides `synced`, so a blocked/failed identity or
  // profile write can NEVER report the promotion itself as failed.
  //
  // Both primary targets live under `sessions/`, so they travel as ONE atomic
  // multi-path update: a pupil can never be enrolled in the next year while still
  // missing from the leaver archive (or vice versa).
  const primaryPatch = {};
  if (Object.keys(nextYearClassUpdates).length > 0) {
    Object.entries(nextYearClassUpdates).forEach(([key, value]) => {
      primaryPatch[`${toYear}/students/${key}`] = value;
    });
  }
  // আগে থেকে থাকা শিক্ষার্থীদের বদলে যাওয়া রোল — শুধু রোল ফিল্ডটাই লেখা হয়।
  if (Object.keys(existingRollUpdates).length > 0) {
    Object.entries(existingRollUpdates).forEach(([key, newRoll]) => {
      primaryPatch[`${toYear}/students/${key}/roll`] = newRoll;
    });
  }
  if (Object.keys(archiveUpdates).length > 0) {
    Object.entries(archiveUpdates).forEach(([key, value]) => {
      primaryPatch[`${toYear}/passedArchive/${key}`] = value;
      // আগের প্রমোশনে একই শিক্ষার্থীর আগের সালের আর্কাইভে এন্ট্রি থাকলে (যেমন
      // সাল আবার সক্রিয় করে আবার প্রমোশন করলে) সেটা মুছে যায় — নইলে দুই সালে
      // দুটো আর্কাইভ জমে যেত।
      primaryPatch[`${fromYear}/passedArchive/${key}`] = null;
    });
  }
  const primaryResults = Object.keys(primaryPatch).length
    ? [await safeUpdate(`${basePath}/sessions`, primaryPatch)]
    : [];
  const primarySynced = primaryResults.every((entry) => entry?.synced !== false);

  const secondaryWrites = [];
  if (Object.keys(masterUpdates).length > 0) {
    secondaryWrites.push({ path: `${basePath}/studentMaster`, patch: masterUpdates });
  }
  // The annual rollover also moves the school's active year. A partial/decided
  // promotion from the roster screen leaves that to the year switcher, so
  // `profile.activeYear` (and therefore the whole UI) never jumps by surprise.
  if (options?.advanceProfileYear !== false) {
    secondaryWrites.push({
      path: `${basePath}/profile`,
      patch: { academicYear: toYear, activeYear: toYear, updatedAt: now },
    });
  }

  const secondaryResults = await Promise.all(secondaryWrites.map(async ({ path, patch: value }) => {
    const first = await safeUpdate(path, value).catch(() => ({ synced: false }));
    if (first?.synced !== false) return first;
    return safeUpdate(path, value).catch(() => ({ synced: false }));
  }));

  return {
    synced: primarySynced,
    partial: !secondaryResults.every((entry) => entry?.synced !== false),
    fromYear,
    toYear,
    promotedCount: promotions.length,
    archivedCount: graduates.length,
    retainedCount: moves.filter((move) => move.targetClassId === move.sourceClassId).length,
  };
}

/** `promoteStudentsToNextYear` for callers that only hold a bare `schoolId`. */
export async function promoteSchoolSession(schoolId, currentYear, nextYear, options = {}) {
  const reference = schoolIdOf(schoolId);
  const empty = { synced: false, promotedCount: 0, archivedCount: 0 };
  if (!reference) return empty;
  const location = resolveSchoolLocation(reference) ?? await hydrateSchoolLocation(reference);
  if (!location) return { ...empty, reason: 'missing-location' };
  return promoteStudentsToNextYear(location, currentYear, nextYear, options);
}

/* ------------------------------------------------------------------ *
 * In-year class promotion (merit rank + শাখা distribution)
 * ------------------------------------------------------------------ */

/** Every শাখা a class registry holds, `ক` first, then Bangla alphabetical. */
const orderSections = (sections = []) => {
  const unique = [...new Set(
    (Array.isArray(sections) ? sections : [])
      .map((section) => sectionSegment(section))
      .filter(Boolean),
  )];
  const others = unique
    .filter((section) => section !== 'ক')
    .sort((a, b) => a.localeCompare(b, 'bn'));
  return ['ক', ...others];
};

/**
 * Annual promotion **inside the active year**:
 * `sessions/{year}/students/{classId}/{sectionId}/{id}` ➔
 * `sessions/{year}/students/{nextClassId}/{sectionId}/{id}` (same year node),
 * Class-5 leavers ➔ `sessions/{year}/passedArchive/{id}`.
 *
 * Guarantees required by the roster screen:
 *  - the ranked order is merit first (`results/final/{id}/meritPosition`), then the
 *    current roll, so the list the teacher sees is exactly the order written;
 *  - the source class/শাখা row is cleared, the pupil appears in exactly one class;
 *  - the target শাখা may be ANY label (`ক`, `খ`, `গ`, …) — a school with an arbitrary
 *    number of sections is supported;
 *  - the destination শাখা folders are recorded in `sessions/{year}/meta/sections` so
 *    an empty-but-declared শাখা survives a page refresh for every teacher;
 *  - `studentMaster/{id}` keeps only the permanent identity + the new current class.
 *
 * @param {object} location complete school location
 * @param {string} year academic year being promoted inside
 * @param {{fromClassId:string,
 *   decisions?:Array<{studentId?:string, studentMasterId?:string,
 *     action?:'promote'|'retain', section?:string}>,
 *   students?:Array<object>, targetSections?:Array<string>,
 *   promotedAt?:string}} options
 *   `promotedAt` is the batch timestamp the caller stamped on its local rows; a
 *   caller that omits it gets one minted here.
 */
export async function promoteClassInYear(location, year, options = {}) {
  const normalized = normalizeLocation(location);
  const fromClassId = classKey(options?.fromClassId);
  const empty = { synced: false, promotedCount: 0, retainedCount: 0, archivedCount: 0, sections: {} };
  if (!normalized || !CLASS_ORDER.includes(fromClassId)) return { ...empty, reason: 'invalid-class' };

  const yearKey = normalizeSessionYear(year, DEFAULT_ACTIVE_YEAR) || DEFAULT_ACTIVE_YEAR;
  rememberSchoolLocation(normalized);
  const basePath = getSchoolBasePath(normalized);
  const yearPath = `${basePath}/sessions/${yearKey}`;
  // The caller's batch timestamp wins, so the rows stored here and the rows the
  // roster already shows carry the SAME `promotedAt` (badge + filter stay in sync).
  const now = String(options?.promotedAt ?? '').trim() || new Date().toISOString();

  await ensureSchoolYearBuckets(normalized, yearKey);

  const [studentsNode, resultsTree, masterMap, sectionRegistry] = await Promise.all([
    safeRead(`${yearPath}/students`, {}),
    safeRead(`${yearPath}/results`, {}),
    safeRead(`${basePath}/studentMaster`, {}),
    safeRead(`${yearPath}/meta/sections`, {}),
  ]);

  return applyClassPromotion({
    normalized, fromClassId, yearKey, basePath, yearPath, now,
    studentsNode, resultsTree, masterMap, sectionRegistry,
    options,
  });
}

/**
 * Core of `promoteClassInYear`: everything is already read, so the whole move is
 * written with one multi-path `update()` per node (students / registry /
 * studentMaster / year meta) and a refresh replays exactly the same reshuffle.
 */
async function applyClassPromotion({
  fromClassId, yearKey, basePath, yearPath, now,
  studentsNode, resultsTree, masterMap, sectionRegistry, options = {},
}) {
  const empty = { synced: false, promotedCount: 0, retainedCount: 0, archivedCount: 0, sections: {} };
  const nextClassId = nextClassOf(fromClassId) || 'archive';

  // Source roster: the supplied merged roster wins (it already carries master +
  // enrollment + the শাখা the teacher saw); otherwise the stored class node is read.
  const supplied = (options?.students ?? [])
    .filter((student) => isObjectRecord(student) && student.classId && student.classId !== 'archive');
  const sourceEntries = supplied.length > 0
    ? supplied
      .map((student) => ({
        sourceClassId: fromClassId,
        studentMasterId: String(student.studentMasterId || student.id || '').trim(),
        record: student,
      }))
      .filter((entry) => Boolean(entry.studentMasterId))
    : Object.entries(asRecord(flattenEnrollmentNode(studentsNode)[fromClassId]))
      .map(([studentMasterId, record]) => ({ sourceClassId: fromClassId, studentMasterId, record }));

  if (sourceEntries.length === 0) {
    return { ...empty, synced: true, year: yearKey, fromClassId, nextClassId };
  }

  // `{id: {action, section}}` — a missing entry means the default (উত্তীর্ণ, own শাখা).
  const decisionMap = new Map(
    (options?.decisions ?? [])
      .map((item) => [
        String(item?.studentMasterId || item?.studentId || '').trim(),
        {
          action: item?.action === 'retain' ? 'retain' : 'promote',
          section: item?.section === undefined || item?.section === null ? '' : item.section,
        },
      ])
      .filter(([id]) => Boolean(id)),
  );
  const decisionOf = (entry) => decisionMap.get(entry.studentMasterId)
    ?? decisionMap.get(String(entry.record?.legacyId ?? ''))
    ?? { action: 'promote', section: '' };

  // Merit order (১ম at the top) — exactly the order the promotion modal shows.
  const ranked = orderByMeritAndRoll(sourceEntries, resultsTree);

  const knownSections = new Set(orderSections([
    ...Object.keys(asRecord(sectionRegistry?.[fromClassId])),
    ...(Array.isArray(options?.targetSections) ? options.targetSections : []),
    ...sourceEntries.map((entry) => sectionSegment(entry.record?.section)),
  ]));

  /* ------------------------------------------------------------------ *
   * Roll plan of the whole batch — the single source of truth.
   *
   * `planPromotionRolls` hands clean `১..n` numbers (in merit order) to the pupils
   * promoted INTO a class from a lower one, and pushes everybody already sitting in
   * that class (including the `এই ক্লাসেই থাকুক` pupils) AFTER them, so a class that
   * receives lower-class students never ends up with two pupils sharing a roll. A
   * bucket that receives nobody keeps its residents' numbers and simply appends the
   * batch's own pupils at the very end.
   *
   * The stored roster (`studentsNode`, every class) is used as the resident source, so
   * a demoted/kept pupil is numbered against the pupils who really are in the class.
   * ------------------------------------------------------------------ */
  const storedByClass = flattenEnrollmentNode(studentsNode);
  const storedRoster = Object.entries(storedByClass).flatMap(([classId, entries]) => (
    Object.entries(asRecord(entries)).map(([studentMasterId, record]) => ({
      ...record,
      id: studentMasterId,
      classId: classKey(classId),
      section: sectionSegment(record?.section),
    }))
  ));
  const batchDecisions = ranked.map((entry) => {
    const decision = decisionOf(entry);
    const sourceSection = sectionSegment(entry.record?.section);
    return {
      id: entry.studentMasterId,
      action: decision.action === 'retain' ? 'retain' : 'promote',
      targetClassId: decision.action === 'retain' ? fromClassId : nextClassId,
      section: sectionSegment(decision.section === '' ? sourceSection : decision.section),
    };
  });
  const rollPlan = planPromotionRolls({
    entries: batchDecisions,
    roster: storedRoster,
    movingIds: sourceEntries.map((entry) => entry.studentMasterId),
    // A resident's merit is published in THEIR OWN class, not in the source class.
    meritOf: (student) => finalMeritOf(resultsTree, student.classId, student.id).meritPosition,
  });

  return writeClassPromotion({
    fromClassId, nextClassId, yearKey, basePath, yearPath, now,
    ranked, knownSections, decisionOf, resultsTree, masterMap, rollPlan, storedRoster,
  });
}

/** Writes one class's promotion: destination rows, registry, masters, year meta. */
async function writeClassPromotion({
  fromClassId, nextClassId, yearKey, basePath, yearPath, now,
  ranked, knownSections, decisionOf, resultsTree, masterMap,
  rollPlan = new Map(), storedRoster = [],
}) {
  const patch = {};
  const archivePatch = {};
  const masterUpdates = {};
  let promotedCount = 0;
  let retainedCount = 0;
  let archivedCount = 0;
  /** `{ [studentMasterId]: roll }` — the authoritative rolls of this batch. */
  const assignment = {};
  // Fallback numbering for a pupil the plan did not cover (never expected, but a
  // promotion must always write a valid roll).
  const fallbackRolls = new Map();
  const fallbackRoll = (targetClassId, section) => {
    const key = `${targetClassId}/${section}`;
    fallbackRolls.set(key, (fallbackRolls.get(key) ?? 0) + 1);
    return fallbackRolls.get(key);
  };
  const highestPlanned = [...rollPlan.values()].reduce((max, roll) => Math.max(max, Number(roll) || 0), 0);
  const batchRollOf = (entry, targetClassId, section) => {
    const planned = normalizeRoll(rollPlan.get(String(entry.studentMasterId)));
    if (planned) return planned;
    return highestPlanned + fallbackRoll(targetClassId, section);
  };

  ranked.forEach((entry) => {
    const decision = decisionOf(entry);
    const sourceSection = sectionSegment(entry.record?.section);
    const merit = finalMeritOf(resultsTree, entry.sourceClassId ?? fromClassId, entry.studentMasterId);
    const legacyId = entry.record?.legacyId ?? entry.record?.id ?? entry.studentMasterId;
    const graduated = decision.action !== 'retain' && nextClassId === 'archive';
    // A blank choice keeps the pupil's own শাখা; any other label is accepted as-is.
    const section = sectionSegment(decision.section === '' ? sourceSection : decision.section);
    // The destination folder a pupil lands in (its own class when retained).
    const targetClassId = decision.action === 'retain' ? fromClassId : nextClassId;
    knownSections.add(section);

    // Rolls come from the batch plan: clean ১, ২, ৩… in merit order inside each
    // destination class AND শাখা, with every already-present pupil placed after them.
    const roll = graduated ? normalizeRoll(entry.record?.roll) : batchRollOf(entry, targetClassId, section);
    if (!graduated) assignment[entry.studentMasterId] = roll;

    // The source row always goes away: a pupil is never listed twice.
    patch[`${fromClassId}/${sourceSection}/${entry.studentMasterId}`] = null;

    if (decision.action === 'retain') {
      // `এই ক্লাসেই থাকুক` — same class, possibly a different শাখা. Any promotion
      // marker from an earlier run is cleared, so a repeating pupil is never listed
      // as "নতুন উত্তীর্ণ" in the class they already sat in.
      retainedCount += 1;
      patch[`${fromClassId}/${section}/${entry.studentMasterId}`] = cleanForCloud({
        ...entry.record,
        studentMasterId: entry.studentMasterId,
        legacyId,
        classId: fromClassId,
        section,
        roll,
        status: 'active',
        year: yearKey,
        previousClassId: null,
        promotedFromClass: null,
        promotedFromYear: null,
        promotedAt: null,
        isNewPromotion: false,
        meritPosition: merit.meritPosition,
        gpa: merit.gpa,
        grade: merit.grade,
        retainedAt: now,
        updatedAt: now,
      });
    } else if (graduated) {
      // Class-5 leavers: this year's year-wise `passedArchive`. The pupil is filed
      // both directly under the archive and inside `passedArchive/years/{year}`, so
      // "who passed in which year" is readable without walking every year node.
      archivedCount += 1;
      const archivedRecord = cleanForCloud({
        ...entry.record,
        studentMasterId: entry.studentMasterId,
        legacyId,
        classId: fromClassId,
        section: sourceSection,
        status: 'passed',
        year: yearKey,
        passedYear: yearKey,
        archivedYear: yearKey,
        archivedFromClass: fromClassId,
        promotedFromClass: fromClassId,
        promotedFromYear: yearKey,
        promotedAt: now,
        isNewPromotion: true,
        meritPosition: merit.meritPosition,
        gpa: merit.gpa,
        grade: merit.grade,
        grandTotal: merit.grandTotal,
        passedAt: now,
        updatedAt: now,
      });
      archivePatch[entry.studentMasterId] = archivedRecord;
      // Year-wise flows: `passedArchive/years/{year}/{id}` (canonical folder) and
      // `passedArchive/{year}/{id}` (year-keyed alias). Both are readable by
      // `studentService.buildYearRoster`, so "who passed in which year" is always
      // answerable without walking every year node.
      archivePatch[`years/${yearKey}/${entry.studentMasterId}`] = archivedRecord;
      archivePatch[`${yearKey}/${entry.studentMasterId}`] = archivedRecord;
    } else {
      // `উত্তীর্ণ`: the next class, inside the SAME year partition.
      //
      // The NEW class row must NOT inherit the previous class's published result
      // stamps (`meritPosition` / `gpa` / `grade` / `grandTotal`): that figure belongs
      // to the class the pupil just left. Until the new class has its own marks, the
      // UI therefore shows `০০` / `ফলাফল নেই` — nothing is deleted, the old year/class
      // result row stays exactly where it is.
      promotedCount += 1;
      patch[`${nextClassId}/${section}/${entry.studentMasterId}`] = cleanForCloud({
        ...entry.record,
        studentMasterId: entry.studentMasterId,
        legacyId,
        classId: nextClassId,
        section,
        roll,
        status: 'active',
        year: yearKey,
        previousClassId: fromClassId,
        promotedFromClass: fromClassId,
        promotedFromYear: yearKey,
        academicYear: yearKey,
        isNewPromotion: true,
        meritPosition: null,
        gpa: null,
        grade: '',
        grandTotal: null,
        promotedAt: now,
        updatedAt: now,
      });
    }

    // Permanent identity: personal fields only, plus the new current class.
    masterUpdates[entry.studentMasterId] = buildMasterUpdate(
      masterMap?.[entry.studentMasterId],
      entry.record,
      {
        studentMasterId: entry.studentMasterId,
        now,
        extra: graduated
          ? {
            currentClassId: 'archived',
            overallStatus: 'graduated',
            graduatedYear: yearKey,
            archivedYear: yearKey,
          }
          : { currentClassId: targetClassId, academicYear: yearKey },
      },
    );
  });

  /* ------------------------------------------------------------------ *
   * Displaced residents.
   *
   * When pupils are promoted INTO a class, the pupils already sitting there are
   * pushed AFTER them (see `planPromotionRolls`), and a resident whose stored roll is
   * a duplicate or a legacy suffix notation (`১-১`) is repaired. Their destination row
   * must therefore be rewritten with the new roll — otherwise two pupils would keep
   * the same number in the same class + শাখা after a refresh.
   * ------------------------------------------------------------------ */
  const batchIds = new Set(ranked.map((entry) => String(entry.studentMasterId)));
  /** `{ [studentMasterId]: roll }` — every row this batch renumbered. */
  const rolls = { ...assignment };
  (Array.isArray(storedRoster) ? storedRoster : []).forEach((student) => {
    const id = String(student?.id ?? '').trim();
    if (!id || batchIds.has(id)) return;
    const planned = Number(rollPlan.get(id));
    if (!Number.isFinite(planned) || planned < 1) return;
    const storedRoll = normalizeRoll(student.roll);
    if (planned === storedRoll) return;
    const storageClassId = classKey(student.classId);
    const section = sectionSegment(student.section);
    patch[`${storageClassId}/${section}/${id}`] = cleanForCloud({
      ...student,
      id: undefined,
      studentMasterId: String(student.studentMasterId ?? id),
      legacyId: student.legacyId ?? student.id ?? id,
      classId: storageClassId,
      section,
      roll: planned,
      year: yearKey,
      updatedAt: now,
    });
    rolls[id] = planned;
  });

  /** `{ 'class-4/ক': <highest roll used> }` — the auditable summary of the batch. */
  const sections = {};
  Object.entries(assignment).forEach(([studentMasterId, roll]) => {
    const entry = ranked.find((row) => String(row.studentMasterId) === studentMasterId);
    if (!entry) return;
    const decision = decisionOf(entry);
    const targetClassId = decision.action === 'retain' ? fromClassId : nextClassId;
    if (!targetClassId || targetClassId === 'archive') return;
    const section = sectionSegment(decision.section === '' ? entry.record?.section : decision.section);
    const key = `${targetClassId}/${section}`;
    sections[key] = Math.max(sections[key] ?? 0, Number(roll) || 0);
  });

  /* ------------------------------------------------------------------ *
   * PRIMARY vs SECONDARY writes.
   *
   * The promotion itself is the pair of roster writes:
   *   - `sessions/{year}/students`  (promoted + retained pupils)
   *   - `sessions/{year}/passedArchive` (Class-5 leavers)
   * If those succeed the movement really happened, so the save MUST NOT be
   * reported as failed just because one of the non-critical side writes below
   * (permanent identity, শাখা registry, year audit log) hit a permission rule or
   * a transient network hiccup.
   *
   * Secondary writes are still attempted (and retried once), but only the PRIMARY
   * verdict decides `synced`.
   * ------------------------------------------------------------------ */
  /* ------------------------------------------------------------------ *
   * PRIMARY writes — ONE atomic multi-path update.
   *
   * The promotion itself is the pair of roster writes
   * (`sessions/{year}/students` + `sessions/{year}/passedArchive`). They are sent as
   * a SINGLE root-relative `update()` on `sessions/{year}`, so a promoted pupil can
   * never be listed in the next class while still sitting in the old one (or vanish
   * from both if the connection drops mid-write).
   *
   * If that write succeeds the movement really happened, so the save MUST NOT be
   * reported as failed just because one of the non-critical side writes below
   * (permanent identity, শাখা registry, year audit log) hit a permission rule or a
   * transient network hiccup.
   * ------------------------------------------------------------------ */
  const primaryPatch = {};
  Object.entries(patch).forEach(([key, value]) => { primaryPatch[`students/${key}`] = value; });
  Object.entries(archivePatch).forEach(([key, value]) => { primaryPatch[`passedArchive/${key}`] = value; });

  const primaryResults = Object.keys(primaryPatch).length
    ? [await safeUpdate(yearPath, primaryPatch)]
    : [];
  const primarySynced = primaryResults.every((entry) => entry?.synced !== false);

  /** `[{ path, patch }]` — non-critical side writes, ranked after the roster. */
  const secondaryWrites = [];

  // Declared শাখা registry (so an empty-but-created শাখা survives a refresh).
  const registryPatch = {};
  knownSections.forEach((section) => {
    registryPatch[`${fromClassId}/${section}`] = true;
    if (nextClassId !== 'archive') registryPatch[`${nextClassId}/${section}`] = true;
  });
  if (Object.keys(registryPatch).length > 0) {
    secondaryWrites.push({ path: `${yearPath}/meta/sections`, patch: registryPatch });
  }

  if (Object.keys(masterUpdates).length > 0) {
    secondaryWrites.push({ path: `${basePath}/studentMaster`, patch: masterUpdates });
  }

  // The year keeps its own auditable log, readable by every teacher after a refresh.
  secondaryWrites.push({
    path: `${yearPath}/meta`,
    patch: cleanForCloud({
      year: yearKey,
      lastPromotionAt: now,
      lastPromotion: {
        fromClassId,
        nextClassId,
        promoted: promotedCount,
        retained: retainedCount,
        archived: archivedCount,
        sections,
        at: now,
      },
      updatedAt: now,
    }),
  });

  // Secondary writes never flip the save verdict. A single retry keeps a transient
  // hiccup from leaving the permanent identity / registry / audit log stale.
  const secondaryResults = await Promise.all(secondaryWrites.map(async ({ path, patch: value }) => {
    const first = await safeUpdate(path, value).catch(() => ({ synced: false }));
    if (first?.synced !== false) return first;
    return safeUpdate(path, value).catch(() => ({ synced: false }));
  }));

  return {
    // The promotion is saved when the ROSTER write succeeded. Secondary/audit
    // writes never mark it as failed (that was the false "সেভ ব্যর্থ হয়েছে").
    synced: primarySynced,
    partial: !secondaryResults.every((entry) => entry?.synced !== false),
    year: yearKey,
    fromClassId,
    nextClassId,
    promotedCount,
    retainedCount,
    archivedCount,
    sections,
    // Authoritative `{ studentMasterId: roll }` of this batch, so the roster hook can
    // mirror exactly what was written instead of re-deriving it.
    assignment: rolls,
  };
}

/** `promoteClassInYear` for callers that only hold a bare `schoolId`. */
export async function promoteClassSession(schoolId, year, options = {}) {
  const reference = schoolIdOf(schoolId);
  if (!reference) return { synced: false, promotedCount: 0, reason: 'missing-school' };
  const location = resolveSchoolLocation(reference) ?? await hydrateSchoolLocation(reference);
  if (!location) return { synced: false, promotedCount: 0, reason: 'missing-location' };
  return promoteClassInYear(location, year, options);
}
export function subscribeSchoolsByLocation(location, callback, onStatus) {
  const { divisionId, districtId, upazilaId } = location ?? {};
  if (!divisionId || !districtId || !upazilaId) {
    callback([]);
    return () => {};
  }
  const path = dbPaths.schoolIndex(divisionId, districtId, upazilaId);
  return safeSubscribe(
    path,
    (value) => {
      const remote = asRecord(value);
      const visible = Object.values(remote)
        .filter((school) => school && school.id && !school.isDeleted)
        .sort((a, b) => String(a.name ?? '').localeCompare(String(b.name ?? ''), 'bn'));
      callback(visible);
    },
    {},
    onStatus,
  );
}

export function subscribeAllIndexedSchools(callback, onStatus) {
  return safeSubscribe(dbPaths.schoolIndexAll(), (value) => callback(asRecord(value)), {}, onStatus);
}

export async function readSchoolRecord(location, schoolId) {
  if (!schoolId) return null;
  const { divisionId, districtId, upazilaId } = location ?? {};
  const cached = rememberSchoolLocation({ schoolId, divisionId, districtId, upazilaId });
  const indexValue = divisionId && districtId && upazilaId
    ? await safeRead(getSchoolIndexEntryPath(divisionId, districtId, upazilaId, schoolId), null)
    : null;

  let record = indexValue;
  if (cached) {
    const profilePath = `${getSchoolBasePath(cached)}/profile`;
    const profile = await safeRead(profilePath, null);
    if (profile && typeof profile === 'object') record = { ...(indexValue ?? {}), ...profile };
  }
  if (!record) {
    const pointer = await safeRead(getSchoolLocatorPath(schoolId), null);
    if (pointer && !pointer.isDeleted) {
      const resolved = rememberSchoolLocation({ ...pointer, schoolId });
      if (resolved) {
        const profile = await safeRead(`${getSchoolBasePath(resolved)}/profile`, null);
        record = profile || pointer;
      }
    }
  }
  if (!record) return null;
  return { ...record, id: schoolId, isDeleted: Boolean(record.isDeleted) };
}

export async function registerSchoolInHierarchy(location, school) {
  const now = new Date().toISOString();
  const id = String(school?.id ?? '').trim() || buildSchoolId(location, school?.name);
  if (!id) return { synced: false, school: null };
  const normalized = normalizeLocation({
    divisionId: location?.divisionId,
    districtId: location?.districtId,
    upazilaId: location?.upazilaId,
    schoolId: id,
  });
  if (!normalized) return { synced: false, school: null };

  const indexPath = getSchoolIndexEntryPath(
    normalized.divisionId,
    normalized.districtId,
    normalized.upazilaId,
    id,
  );
  const basePath = getSchoolBasePath(normalized);
  const existing = await safeRead(indexPath, null);
  rememberSchoolLocation(normalized);

  const merged = { ...(location ?? {}), ...(school ?? {}), id };
  const activeYear = normalizeSessionYear(
    merged?.activeYear ?? merged?.academicYear ?? merged?.session,
    DEFAULT_ACTIVE_YEAR,
  ) || DEFAULT_ACTIVE_YEAR;
  const writes = [];

  writes.push(await safeUpdate(indexPath, buildIndexEntry({
    ...merged,
    id,
    ...normalized,
    isDeleted: false,
  }, now)));

  const currentProfile = await safeRead(`${basePath}/profile`, null);
  const profilePatch = currentProfile && typeof currentProfile === 'object' && Object.keys(currentProfile).length > 0
    ? null
    : buildProfileEntry(id, normalized, merged, now);
  if (profilePatch) writes.push(await safeUpdate(`${basePath}/profile`, profilePatch));

  writes.push(await ensureSchoolYearBuckets(normalized, activeYear));

  const founder = school?.founder && typeof school.founder === 'object' ? school.founder : null;
  const uid = String(founder?.uid ?? '').trim();
  if (uid) {
    const teachers = asRecord(await safeRead(`${basePath}/teachers`, {}));
    const incumbentFounder = Object.values(teachers).find(
      (teacher) => teacher && teacher.isFounder === true && teacher.isDeleted !== true && teacher.uid !== uid,
    );
    if (!incumbentFounder) {
      const founderName = String(founder.name ?? school?.createdBy ?? '').trim() || 'প্রতিষ্ঠাতা অ্যাডমিন';
      const teacher = cleanForCloud({
        uid,
        name: founderName,
        designation: String(founder.designation ?? 'সহকারী শিক্ষক').trim() || 'সহকারী শিক্ষক',
        email: founder.email ?? '',
        phone: founder.phone ?? '',
        role: 'school_admin',
        schoolId: id,
        divisionId: normalized.divisionId,
        districtId: normalized.districtId,
        upazilaId: normalized.upazilaId,
        status: MEMBER_STATUS.APPROVED,
        isFounder: true,
        isAdmin: true,
        canApprove: true,
        isDeleted: false,
        approvedAt: now,
        approvedBy: uid,
        approvedByName: founderName,
        joinedAt: now,
        createdAt: now,
        updatedAt: now,
      });
      writes.push(await safeUpdate(`${basePath}/teachers/${uid}`, teacher));
      writes.push(await safeUpdate(getUserPath(uid), {
        uid,
        name: teacher.name,
        email: teacher.email ?? '',
        role: 'school_admin',
        schoolId: id,
        divisionId: normalized.divisionId,
        districtId: normalized.districtId,
        upazilaId: normalized.upazilaId,
        status: MEMBER_STATUS.APPROVED,
        isDeleted: false,
        updatedAt: now,
      }));
    }
  }

  writes.push(await safeUpdate(getSchoolLocatorPath(id), {
    schoolId: id,
    divisionId: normalized.divisionId,
    districtId: normalized.districtId,
    upazilaId: normalized.upazilaId,
    isDeleted: false,
    updatedAt: now,
  }));
  rememberSchoolLocation(normalized);

  const synced = writes.every((entry) => entry?.synced !== false);
  return {
    synced,
    school: {
      ...merged,
      id,
      ...normalized,
      isAvailable: true,
      verified: Boolean(existing?.verified),
      createdAt: currentProfile?.createdAt ?? now,
      createdBy: school?.createdBy ?? null,
    },
    created: true,
  };
}

export async function ensureDemoSchoolInHierarchy(extra = {}) {
  const location = normalizeLocation({ ...DEMO_SCHOOL_LOCATION, ...extra });
  if (!location) return { synced: false, school: null };
  rememberSchoolLocation(location);
  const name = String(extra.name ?? '').trim() || 'আদর্শ সরকারি প্রাথমিক বিদ্যালয় (ডেমো)';
  return registerSchoolInHierarchy({ ...location, ...extra }, {
    id: location.schoolId,
    name,
    emisCode: extra.emisCode ?? '133701',
    villageOrUnion: extra.villageOrUnion ?? '',
    activeYear: extra.activeYear ?? DEFAULT_ACTIVE_YEAR,
    createdBy: extra.createdBy ?? 'ডেমো সিড',
  });
}

export async function updateSchoolInHierarchy(location, schoolId, patch) {
  const normalized = normalizeLocation({
    divisionId: location?.divisionId,
    districtId: location?.districtId,
    upazilaId: location?.upazilaId,
    schoolId,
  });
  if (!normalized) return { synced: false };
  rememberSchoolLocation(normalized);
  const now = new Date().toISOString();
  const indexPath = getSchoolIndexEntryPath(
    normalized.divisionId,
    normalized.districtId,
    normalized.upazilaId,
    schoolId,
  );
  const existing = await safeRead(indexPath, {});
  const merged = { ...existing, ...patch, id: schoolId };
  const results = await Promise.all([
    safeUpdate(indexPath, buildIndexEntry({ ...merged, isDeleted: Boolean(existing?.isDeleted) }, now)),
    safeUpdate(`${getSchoolBasePath(normalized)}/profile`, cleanForCloud(pickProfileFields(merged)) ?? {}),
    safeUpdate(getSchoolLocatorPath(schoolId), { schoolId, ...normalized, updatedAt: now }),
  ]);
  return { synced: results.every((entry) => entry?.synced !== false) };
}

export async function syncSchoolRegistryWithProfile(schoolId, previous = {}, next = {}) {
  if (!schoolId) return { synced: true };
  const oldLocation = normalizeLocation({
    divisionId: previous.divisionId,
    districtId: previous.districtId,
    upazilaId: previous.upazilaId,
    schoolId,
  });
  const newLocation = normalizeLocation({
    divisionId: next.divisionId || previous.divisionId,
    districtId: next.districtId || previous.districtId,
    upazilaId: next.upazilaId || previous.upazilaId,
    schoolId,
  });
  if (!newLocation) return { synced: true };

  const now = new Date().toISOString();
  const name = next.name ?? next.schoolName ?? previous.name ?? previous.schoolName ?? '';
  const emisCode = next.emisCode ?? previous.emisCode ?? '';
  rememberSchoolLocation(newLocation);

  const newIndexPath = getSchoolIndexEntryPath(
    newLocation.divisionId,
    newLocation.districtId,
    newLocation.upazilaId,
    schoolId,
  );
  const current = await safeRead(newIndexPath, {});
  const tombstoned = current?.isDeleted === true;
  const results = await Promise.all([
    safeUpdate(newIndexPath, buildIndexEntry({
      id: schoolId,
      name,
      emisCode,
      ...newLocation,
      isDeleted: tombstoned,
      deletedAt: current?.deletedAt,
    }, now)),
    safeUpdate(getSchoolLocatorPath(schoolId), {
      schoolId,
      ...newLocation,
      isDeleted: tombstoned,
      updatedAt: now,
    }),
  ]);
  if (oldLocation) {
    const oldIndexPath = getSchoolIndexEntryPath(
      oldLocation.divisionId,
      oldLocation.districtId,
      oldLocation.upazilaId,
      schoolId,
    );
    if (oldIndexPath !== newIndexPath) results.push(await safeUpdate(oldIndexPath, { [schoolId]: null }));
  }
  return { synced: results.every((entry) => entry?.synced !== false) };
}

export async function softDeleteSchoolInHierarchy(location, schoolId) {
  const normalized = normalizeLocation({
    divisionId: location?.divisionId,
    districtId: location?.districtId,
    upazilaId: location?.upazilaId,
    schoolId,
  });
  if (!normalized) return { synced: false };
  rememberSchoolLocation(normalized);
  const now = new Date().toISOString();
  const tombstone = cleanForCloud({
    isDeleted: true,
    deletedAt: now,
    ...(location?.actorUid ? { deletedBy: location.actorUid } : {}),
    updatedAt: now,
  });
  const results = await Promise.all([
    safeUpdate(getSchoolIndexEntryPath(
      normalized.divisionId,
      normalized.districtId,
      normalized.upazilaId,
      schoolId,
    ), tombstone),
    safeUpdate(`${getSchoolBasePath(normalized)}/profile`, tombstone),
    safeUpdate(getSchoolLocatorPath(schoolId), {
      schoolId,
      ...normalized,
      isDeleted: true,
      deletedAt: now,
      updatedAt: now,
    }),
  ]);
  return { synced: results.every((entry) => entry?.synced !== false) };
}

async function resolveSchoolTeachersPath(schoolId) {
  const location = await hydrateSchoolLocation(schoolId);
  if (location) {
    const base = getSchoolBasePath(location);
    if (base) return `${base}/teachers`;
  }
  return dbPaths.teachers(schoolId);
}

export function subscribeSchoolTeachers(schoolId, callback, onStatus) {
  if (!schoolId) {
    callback({});
    return () => {};
  }
  let primary = {};
  let legacy = {};
  let disposed = false;
  let upgraded = false;

  const emit = () => {
    if (disposed) return;
    callback({ ...asRecord(legacy), ...asRecord(primary) });
  };

  let offPrimary = safeSubscribe(dbPaths.teachers(schoolId), (value) => {
    if (upgraded) return;
    primary = asRecord(value);
    emit();
  }, {}, onStatus);

  const attachPrimary = (path) => {
    upgraded = true;
    const off = safeSubscribe(path, (value) => {
      primary = asRecord(value);
      emit();
    }, {}, onStatus);
    if (disposed) off?.();
    else offPrimary = off;
  };

  const offLegacy = safeSubscribe(dbPaths.legacyMembers(schoolId), (value) => {
    legacy = asRecord(value);
    emit();
  }, {}, onStatus);

  hydrateSchoolLocation(schoolId)
    .then((location) => {
      if (disposed || !location) return;
      const hierarchical = `${getSchoolBasePath(location)}/teachers`;
      if (!hierarchical || hierarchical === dbPaths.teachers(schoolId)) return;
      const previous = offPrimary;
      attachPrimary(hierarchical);
      previous?.();
    })
    .catch(() => {});

  return () => {
    disposed = true;
    offPrimary?.();
    offLegacy?.();
  };
}

export function subscribeActiveSchoolTeachers(schoolId, callback, onStatus) {
  return subscribeSchoolTeachers(schoolId, (members) => {
    callback(Object.fromEntries(
      Object.entries(members ?? {}).filter(([, member]) => isLiveMember(member)),
    ));
  }, onStatus);
}

export async function readSchoolTeacher(schoolId, memberId) {
  if (!schoolId || !memberId) return null;
  const targetPath = await resolveSchoolTeachersPath(schoolId);
  const teachers = asRecord(await safeRead(targetPath, {}));
  if (teachers[memberId]) return teachers[memberId];
  const fallbackTeachers = asRecord(await safeRead(dbPaths.teachers(schoolId), {}));
  if (fallbackTeachers[memberId]) return fallbackTeachers[memberId];
  const legacy = asRecord(await safeRead(dbPaths.legacyMembers(schoolId), {}));
  return legacy[memberId] ?? null;
}

async function locateTeacherRecord(schoolId, memberId) {
  const targetPath = await resolveSchoolTeachersPath(schoolId);
  const teachers = asRecord(await safeRead(targetPath, {}));
  if (teachers[memberId]) {
    return { path: targetPath, record: teachers[memberId] };
  }
  const fallbackTeachers = asRecord(await safeRead(dbPaths.teachers(schoolId), {}));
  if (fallbackTeachers[memberId]) {
    return { path: targetPath, record: fallbackTeachers[memberId] };
  }
  const legacy = asRecord(await safeRead(dbPaths.legacyMembers(schoolId), {}));
  if (legacy[memberId]) {
    return { path: dbPaths.legacyMembers(schoolId), record: legacy[memberId] };
  }
  return { path: targetPath, record: null };
}

async function writeTeacherRecord(schoolId, memberId, patch, known = null) {
  const located = known ?? await locateTeacherRecord(schoolId, memberId);
  const base = located.record ?? { uid: memberId, schoolId };
  const merged = cleanForCloud({
    ...base,
    ...patch,
    uid: memberId,
    schoolId,
    isDeleted: Boolean(patch?.isDeleted ?? base.isDeleted),
  });
  const result = await safeUpdate(located.path, { [memberId]: merged });
  return { result, member: merged };
}

export async function readUserPointer(uid) {
  if (!uid) return null;
  const pointer = await safeRead(dbPaths.user(uid), null);
  if (!pointer || typeof pointer !== 'object' || !pointer.schoolId) return null;
  rememberSchoolLocation(pointer);
  return pointer;
}

async function syncTeacherUserPointer(schoolId, member, location = null) {
  if (!member?.uid) return { synced: false };
  const resolved = location
    ?? rememberSchoolLocation({
      schoolId,
      divisionId: member.divisionId,
      districtId: member.districtId,
      upazilaId: member.upazilaId,
    })
    ?? await hydrateSchoolLocation(schoolId);
  const now = new Date().toISOString();
  const clean = cleanForCloud({
    uid: member.uid,
    schoolId,
    ...(resolved ?? {}),
    role: member.role ?? 'school_admin',
    name: member.name ?? '',
    email: member.email ?? '',
    status: member.status ?? MEMBER_STATUS.PENDING,
    isDeleted: Boolean(member.isDeleted),
    updatedAt: now,
  });
  const results = await Promise.all([
    safeUpdate(dbPaths.user(member.uid), clean),
    safeUpdate(dbPaths.userSchool(member.uid, schoolId), cleanForCloud({
      schoolId,
      name: member.name ?? '',
      status: member.status ?? MEMBER_STATUS.PENDING,
      role: member.role ?? 'school_admin',
      isDeleted: Boolean(member.isDeleted),
      updatedAt: now,
    })),
  ]);
  return { synced: results.every((entry) => entry?.synced !== false) };
}

export async function registerSchoolTeacher(schoolId, member, { founder = false } = {}) {
  if (!schoolId || !member?.uid) return { synced: false, member: null };
  const location = rememberSchoolLocation({
    schoolId,
    divisionId: member.divisionId,
    districtId: member.districtId,
    upazilaId: member.upazilaId,
  }) ?? await hydrateSchoolLocation(schoolId);
  if (location) rememberSchoolLocation(location);

  const path = await resolveSchoolTeachersPath(schoolId);
  const now = new Date().toISOString();
  const candidate = cleanForCloud({
    ...member,
    uid: member.uid,
    schoolId,
    ...(location ?? {}),
    status: MEMBER_STATUS.PENDING,
    isFounder: false,
    isAdmin: false,
    canApprove: false,
    role: 'school_admin',
    isDeleted: false,
    createdAt: now,
    joinedAt: now,
  });

  try {
    const legacy = asRecord(await safeRead(dbPaths.legacyMembers(schoolId), {}));
    const legacyMember = legacy[member.uid]
      ? cleanForCloud({ ...legacy[member.uid], ...location, schoolId })
      : null;

    let resultMember = null;
    let created = false;
    const transaction = await runTransaction(ref(db, path), (current) => {
      const teachers = asRecord(current);
      const existing = teachers[member.uid];
      if (existing && existing.isDeleted !== true) {
        resultMember = existing;
        return;
      }
      if (legacyMember) {
        resultMember = legacyMember;
        teachers[member.uid] = resultMember;
        created = true;
        return teachers;
      }
      const isFounder = founder === true && Object.keys(teachers).length === 0;
      resultMember = isFounder
        ? {
            ...candidate,
            status: MEMBER_STATUS.APPROVED,
            isFounder: true,
            isAdmin: true,
            canApprove: true,
            role: 'school_admin',
            approvedAt: now,
            approvedBy: member.uid,
            approvedByName: candidate.name || 'প্রতিষ্ঠাতা অ্যাডমিন',
          }
        : candidate;
      teachers[member.uid] = resultMember;
      created = true;
      return teachers;
    }, { applyLocally: false });

    const saved = transaction.snapshot?.val();
    const savedMember = resultMember || saved?.[member.uid] || null;
    if (legacyMember && savedMember) {
      await safeUpdate(dbPaths.legacyMembers(schoolId), { [member.uid]: null });
    }
    const pointer = await syncTeacherUserPointer(schoolId, savedMember ?? candidate, location);
    return { synced: transaction.committed || pointer.synced, member: savedMember, created };
  } catch {
    const teachers = asRecord(await safeRead(path, {}));
    if (teachers[member.uid] && teachers[member.uid].isDeleted !== true) {
      return { synced: true, member: teachers[member.uid], created: false };
    }
    const result = await safeUpdate(path, { [member.uid]: candidate });
    const pointer = await syncTeacherUserPointer(schoolId, candidate, location);
    return { ...result, synced: result.synced || pointer.synced, member: candidate, created: true };
  }
}

async function canActorApprove(schoolId, actor) {
  if (!actor?.uid || (actor.schoolId && actor.schoolId !== schoolId)) return false;
  const member = await readSchoolTeacher(schoolId, actor.uid);
  if (member) {
    return Boolean(
      member.isDeleted !== true
      && (
        member.status === MEMBER_STATUS.APPROVED
        || member.isFounder
        || member.isAdmin
        || member.canApprove
      ),
    );
  }
  return actor.isFounder === true || actor.isAdmin === true || actor.status === MEMBER_STATUS.APPROVED;
}

export async function updateTeacherStatus(schoolId, memberId, status, actor = null) {
  if (!schoolId || !memberId || !Object.values(MEMBER_STATUS).includes(status)) return { synced: false };
  if (!await canActorApprove(schoolId, actor)) return { synced: false };
  const located = await locateTeacherRecord(schoolId, memberId);
  const target = located.record;
  if (!target || target.isFounder || target.isDeleted === true) return { synced: false };
  const now = new Date().toISOString();
  const patch = { status, updatedAt: now };
  if (status === MEMBER_STATUS.APPROVED) {
    patch.canApprove = Boolean(target.canApprove) || Boolean(target.isAdmin);
    patch.approvedAt = now;
    patch.approvedBy = actor?.uid || null;
    patch.approvedByName = actor?.name || actor?.email || actor?.uid || '';
  } else {
    patch.canApprove = false;
    patch.isAdmin = false;
  }
  if (actor?.uid) patch.updatedBy = actor.uid;
  const { result, member } = await writeTeacherRecord(schoolId, memberId, patch, located);
  await syncTeacherUserPointer(schoolId, member);
  return result;
}

export async function updateTeacherApprover(schoolId, memberId, canApprove, actor = null) {
  if (!schoolId || !memberId || !await canActorApprove(schoolId, actor)) return { synced: false };
  const located = await locateTeacherRecord(schoolId, memberId);
  const member = located.record;
  if (!member || member.isFounder || member.isDeleted === true || member.status !== MEMBER_STATUS.APPROVED) return { synced: false };
  const patch = { canApprove: Boolean(canApprove), updatedAt: new Date().toISOString() };
  if (actor?.uid) patch.updatedBy = actor.uid;
  const { result, member: updated } = await writeTeacherRecord(schoolId, memberId, patch, located);
  await syncTeacherUserPointer(schoolId, updated);
  return result;
}

export async function updateTeacherAdmin(schoolId, memberId, isAdmin, actor = null) {
  if (!schoolId || !memberId || !await canActorApprove(schoolId, actor)) return { synced: false };
  const located = await locateTeacherRecord(schoolId, memberId);
  const member = located.record;
  if (!member || member.isFounder || member.isDeleted === true || member.status !== MEMBER_STATUS.APPROVED) return { synced: false };
  const admin = Boolean(isAdmin);
  const patch = {
    isAdmin: admin,
    canApprove: admin ? true : Boolean(member.canApprove && actor?.isFounder),
    updatedAt: new Date().toISOString(),
  };
  if (actor?.uid) patch.updatedBy = actor.uid;
  const { result, member: updated } = await writeTeacherRecord(schoolId, memberId, patch, located);
  await syncTeacherUserPointer(schoolId, updated);
  return result;
}

export async function softRemoveTeacher(schoolId, memberId, actor = null) {
  if (!schoolId || !memberId || !await canActorApprove(schoolId, actor)) return { synced: false };
  const located = await locateTeacherRecord(schoolId, memberId);
  const member = located.record;
  if (!member || member.isFounder) return { synced: false };
  const now = new Date().toISOString();
  const patch = cleanForCloud({
    isDeleted: true,
    deletedAt: now,
    deletedBy: actor?.uid ?? null,
    status: MEMBER_STATUS.REJECTED,
    canApprove: false,
    isAdmin: false,
    updatedAt: now,
  });
  const { result, member: updated } = await writeTeacherRecord(schoolId, memberId, patch, located);
  await syncTeacherUserPointer(schoolId, updated);
  return result;
}

export async function restoreSoftRemovedTeacher(schoolId, memberId, actor = null) {
  if (!schoolId || !memberId || !await canActorApprove(schoolId, actor)) return { synced: false };
  const located = await locateTeacherRecord(schoolId, memberId);
  const member = located.record;
  if (!member || member.isDeleted !== true) return { synced: false };
  const now = new Date().toISOString();
  const patch = cleanForCloud({
    isDeleted: false,
    deletedAt: null,
    restoredAt: now,
    status: MEMBER_STATUS.PENDING,
    updatedAt: now,
    ...(actor?.uid ? { updatedBy: actor.uid } : {}),
  });
  const { result, member: updated } = await writeTeacherRecord(schoolId, memberId, patch, located);
  await syncTeacherUserPointer(schoolId, updated);
  return result;
}