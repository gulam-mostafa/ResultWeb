import { cleanForCloud, safeRead, safeSubscribe, safeUpdate } from './dbFallback.js';
import { dbPaths, normalizeSessionYear } from './dbPaths.js';
import { readYearRoster, readStudentMasterIndex, toAppClassId, toDbClassId } from './studentService.js';
import { resolveClassKey } from '../../utils/constants.js';

/**
 * attendanceService — daily attendance inside the year partition.
 *
 * ```text
 * …/sessions/{year}/attendance/{date}/{classId}/{studentMasterId} = {
 *     studentMasterId, classId, status, markedAt, updatedAt, updatedBy,
 * }
 * ```
 *
 * Rows are keyed by the permanent `studentMasterId`, so a pupil's attendance follows
 * them across class changes and years. Legacy flat records
 * (`…/attendance/{date}/{studentId}`) stay readable through the same API.
 */

const asRecord = (value) => (value && typeof value === 'object' && !Array.isArray(value) ? value : {});
const isObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const nowISO = () => new Date().toISOString();

export const ATTENDANCE_STATUSES = Object.freeze(['present', 'absent', 'late', 'excused']);
const attKey = (date) => String(date ?? '').trim();
const currentCalendarYear = () => String(new Date().getFullYear());

/** Memoised active academic year per school. */
let activeYearMemo = new Map();

/** Active academic year of a school (`profile/{academicYear}`, else this year). */
export async function resolveAttendanceYear(schoolId, year = '') {
  const requested = normalizeSessionYear(year);
  if (requested) return requested;
  if (!schoolId) return currentCalendarYear();
  if (activeYearMemo.has(schoolId)) return activeYearMemo.get(schoolId);
  const profile = asRecord(await safeRead(dbPaths.profile(schoolId), {}));
  const resolved = normalizeSessionYear(profile.academicYear || profile.session, currentCalendarYear());
  activeYearMemo.set(schoolId, resolved);
  return resolved;
}

/** Clears the memoised active year (call it after the topbar switches years). */
export const forgetAttendanceYear = (schoolId) => {
  if (schoolId) activeYearMemo.delete(schoolId);
  else activeYearMemo = new Map();
};

/* ------------------------------------------------------------------ *
 * Normalisation
 * ------------------------------------------------------------------ */

const isRecord = (value) => isObject(value)
  && (value.status !== undefined || value.studentMasterId !== undefined || value.updatedAt !== undefined);

/**
 * Flattens a day's attendance node into `{ studentMasterId: { status, … } }`.
 * Understands the new `{classId: {studentMasterId: row}}` layout, the flat
 * `{studentId: row}` layout and bare `{studentId: 'present'}` strings.
 */
export function normalizeAttendanceDay(value) {
  const out = {};
  const write = (studentMasterId, row, classId = '') => {
    if (!studentMasterId) return;
    if (typeof row === 'string') {
      out[studentMasterId] = { studentMasterId, status: row, ...(classId ? { classId: toAppClassId(classId) } : {}) };
      return;
    }
    if (!isObject(row)) return;
    const merged = { ...row, studentMasterId: row.studentMasterId || studentMasterId };
    if (classId) merged.classId = toAppClassId(row.classId || classId);
    // Rows are stored under the master id but the UI looks pupils up by roster id.
    out[row.legacyId || studentMasterId] = merged;
  };

  Object.entries(asRecord(value)).forEach(([key, child]) => {
    if (!isObject(child)) {
      write(key, child);
      return;
    }
    if (isRecord(child)) {
      write(key, child);
      return;
    }
    // Nested: `{classId: {studentMasterId: row}}`
    Object.entries(child).forEach(([nestedKey, nested]) => {
      if (!isObject(nested)) {
        write(nestedKey, nested, key);
        return;
      }
      if (isRecord(nested)) {
        write(nestedKey, nested, key);
        return;
      }
      Object.entries(nested).forEach(([studentMasterId, row]) => {
        write(studentMasterId, isObject(row) ? row : { status: row }, key);
      });
    });
  });

  return out;
}

/** Keeps only the rows that belong to the requested class. */
const filterByClass = (records, classId) => {
  if (!classId) return records;
  const wanted = toAppClassId(classId);
  return Object.fromEntries(
    Object.entries(records).filter(([, row]) => !row?.classId || toAppClassId(row.classId) === wanted),
  );
};
/* ------------------------------------------------------------------ *
 * Reads
 * ------------------------------------------------------------------ */

/** One-shot read of a day's attendance for a year (optionally one class). */
export async function readAttendanceDay(schoolId, date, year = '', classId = '') {
  const day = attKey(date);
  if (!schoolId || !day) return {};
  const yearKey = await resolveAttendanceYear(schoolId, year);
  const [partition, legacy] = await Promise.all([
    safeRead(dbPaths.yearAttendanceDay(schoolId, yearKey, day), {}),
    safeRead(dbPaths.attendanceDay(schoolId, day), {}),
  ]);
  return filterByClass(
    { ...normalizeAttendanceDay(legacy), ...normalizeAttendanceDay(partition) },
    classId,
  );
}

/**
 * Subscribe to one school's attendance for one date.
 * Emits the flat `{ studentMasterId: row }` map the attendance hook consumes; the
 * optional `year`/`classId` narrow the year partition (legacy rows are merged in).
 */
export function subscribeAttendanceDay(schoolId, date, callback, onStatus, year = '', classId = '') {
  const day = attKey(date);
  if (!schoolId || !day || typeof callback !== 'function') {
    callback?.({});
    return () => {};
  }

  let legacy = {};
  let partition = {};
  const emit = () => callback(filterByClass(
    { ...normalizeAttendanceDay(legacy), ...normalizeAttendanceDay(partition) },
    classId,
  ));

  const unsubs = [safeSubscribe(dbPaths.attendanceDay(schoolId, day), (value) => {
    legacy = asRecord(value);
    emit();
  }, {}, onStatus)];

  const bindYear = (yearKey) => {
    const normalized = normalizeSessionYear(yearKey);
    if (!normalized) return;
    unsubs.push(safeSubscribe(dbPaths.yearAttendanceDay(schoolId, normalized, day), (value) => {
      partition = asRecord(value);
      emit();
    }, {}, onStatus));
  };

  const requested = normalizeSessionYear(year);
  if (requested) bindYear(requested);
  else resolveAttendanceYear(schoolId).then(bindYear).catch(() => {});

  return () => unsubs.forEach((unsub) => unsub?.());
}

/** One pupil's attendance rows across a whole academic year. */
export async function readStudentYearAttendance(schoolId, year, studentMasterId) {
  if (!schoolId || !studentMasterId) return [];
  const yearKey = await resolveAttendanceYear(schoolId, year);
  const days = asRecord(await safeRead(dbPaths.yearAttendance(schoolId, yearKey), {}));
  return Object.entries(days)
    .map(([date, node]) => {
      const record = normalizeAttendanceDay(node)[studentMasterId];
      return record ? { date, ...record } : null;
    })
    .filter(Boolean)
    .sort((a, b) => String(b.date).localeCompare(String(a.date)));
}
/* ------------------------------------------------------------------ *
 * Writes
 * ------------------------------------------------------------------ */

/**
 * Persist a day's status changes as one non-destructive multi-path update.
 *
 * `statuses` may be:
 *  - `{ [studentMasterId]: 'present' }` — the attendance hook's draft map, or
 *  - `{ [studentMasterId]: { status, classId } }` — richer callers.
 *
 * Rows land in `sessions/{year}/attendance/{date}/{classId}/{studentMasterId}`;
 * the year is the explicit argument, else the school's active academic year.
 */
export async function saveAttendanceDay(schoolId, date, statuses, actor = null, year = '', classId = '') {
  const day = attKey(date);
  if (!schoolId || !day) return Promise.resolve({ synced: false });

  const yearKey = await resolveAttendanceYear(schoolId, year);
  const entries = Object.entries(asRecord(statuses))
    .map(([studentId, value]) => {
      const row = typeof value === 'string' ? { status: value } : asRecord(value);
      const status = row.status;
      if (!studentId || !ATTENDANCE_STATUSES.includes(status)) return null;
      return {
        appId: studentId,
        status,
        classId: row.classId || classId || '',
      };
    })
    .filter(Boolean);

  if (entries.length === 0) return { synced: true };

  // Rows are stored under the permanent master id; the UI addresses pupils by
  // their roster id, so resolve both the id and (when needed) the class.
  const { byId } = await readStudentMasterIndex(schoolId);
  if (entries.some((entry) => !entry.classId)) {
    const roster = await readYearRoster(schoolId, yearKey);
    const classById = new Map(roster.students.map((student) => [student.id, student.classId]));
    entries.forEach((entry) => {
      if (!entry.classId) entry.classId = classById.get(entry.appId) || 'unassigned';
    });
  }

  const base = dbPaths.yearAttendanceDay(schoolId, yearKey, day);
  const markedAt = nowISO();
  const patch = {};
  entries.forEach((entry) => {
    const studentMasterId = byId.get(entry.appId) || entry.appId;
    const rowClassId = toDbClassId(entry.classId);
    patch[`${rowClassId}/${studentMasterId}`] = cleanForCloud({
      studentMasterId,
      legacyId: entry.appId,
      classId: rowClassId,
      status: entry.status,
      markedAt,
      updatedAt: markedAt,
      ...(actor?.uid ? { updatedBy: actor.uid } : {}),
    });
  });

  return safeUpdate(base, patch);
}

/**
 * Bulk write for one class/day (`{ [studentMasterId]: status }`).
 * Used by import/seed flows that already know the class.
 */
export function saveClassAttendance(schoolId, year, date, classId, statuses, actor = null) {
  if (!classId) return Promise.resolve({ synced: false });
  return saveAttendanceDay(schoolId, date, statuses, actor, year, classId);
}

/** Removes one day's rows for a class (explicit correction only). */
export async function clearAttendanceDay(schoolId, year, date, classId) {
  const day = attKey(date);
  const rowClassId = resolveClassKey(classId);
  if (!schoolId || !day || !rowClassId) return { synced: false };
  const yearKey = await resolveAttendanceYear(schoolId, year);
  return safeUpdate(dbPaths.yearAttendanceDay(schoolId, yearKey, day), { [rowClassId]: null });
}

export default {
  ATTENDANCE_STATUSES,
  resolveAttendanceYear,
  forgetAttendanceYear,
  normalizeAttendanceDay,
  readAttendanceDay,
  subscribeAttendanceDay,
  readStudentYearAttendance,
  saveAttendanceDay,
  saveClassAttendance,
  clearAttendanceDay,
};



