import { useCallback, useEffect, useMemo, useState } from 'react';
import { CLASS_LEVELS, NEXT_CLASS_MAP, DEMO_SESSION } from '../utils/constants.js';
import { DEFAULT_ACTIVE_YEAR, isCompleteSchoolRef } from '../context/AuthContext.jsx';
import {
  nextFreeRollInBucket,
  planPromotionRolls,
  resolveRollAssignment,
} from '../utils/rollAssignment.js';
import {
  createEmptyMarks,
  normalizeLocation,
  normalizeSessionYear,
  rememberSchoolLocation,
  dbPaths,
  safeUpdate,
  generateStudentMasterId,
  resolveMasterId,
  buildStudentMasterRecord,
  buildEnrollmentRecord,
  moveStudentClass,
  moveStudentResultRows,
  toDbClassId,
  toSectionId,
  DEFAULT_SECTION_ID,
  promoteClassInYear,
  registerSectionCloud,
  unregisterSectionCloud,
  subscribeSectionRegistry,
  ensureSchoolYearBuckets,
  importStudentsCloud,
} from '../services/database/index.js';
import { promoteSession, nextSessionYear } from '../services/database/sessionService.js';

const nowISO = () => new Date().toISOString();
const makeId = (prefix) =>
  `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

/**
 * A class-wide promotion writes the roster, the passed archive and the permanent
 * identity rows. That legitimately takes longer than a single mark cell, and the
 * generic 3 s save timeout used to report it as a failed save.
 */
const PROMOTION_SAVE_TIMEOUT_MS = 20000;

const asList = (value) => (Array.isArray(value) ? value.filter(Boolean) : []);
const sortByRoll = (list) => asList(list).sort((a, b) => (a?.roll ?? 0) - (b?.roll ?? 0));

/** Trims a tenant path back to a key that `update()` can merge from the base. */
const relativeKey = (base, path) => (path && path.startsWith(`${base}/`) ? path.slice(base.length + 1) : path);

/**
 * Safe, always-defined শাখা registry: every class owns the default `ক`.
 *
 * The live cloud node (`sessions/{year}/meta/sections`) is empty until the first
 * শাখা is declared, and it is not readable at all while offline — so a consumer
 * reading `sectionRegistry[classId][section]` would hit `undefined`. Seeding every
 * class with `ক` keeps that read total; declared শাখা are merged on top.
 */
export const createSectionRegistry = () => Object.fromEntries(
  [...CLASS_LEVELS.map((level) => level.id), 'archive']
    .map((classId) => [classId, { [DEFAULT_SECTION_ID]: true }]),
);

/** Merges a live/normalised registry over the defaults (never drops `ক`). */
const mergeSectionRegistry = (registry) => {
  const out = createSectionRegistry();
  if (!registry || typeof registry !== 'object' || Array.isArray(registry)) return out;
  Object.entries(registry).forEach(([classId, sections]) => {
    if (!classId || !sections || typeof sections !== 'object' || Array.isArray(sections)) return;
    const declared = {};
    Object.keys(sections).forEach((section) => {
      const label = toSectionId(section);
      if (label) declared[label] = true;
    });
    out[classId] = { ...(out[classId] ?? { [DEFAULT_SECTION_ID]: true }), ...declared };
  });
  return out;
};

/** Declares one শাখা of a class (pure: returns a new registry). */
export const declareSection = (registry, classId, label) => {
  const key = toSectionId(label);
  if (!classId || !key) return mergeSectionRegistry(registry);
  const current = mergeSectionRegistry(registry);
  return {
    ...current,
    [classId]: { ...(current[classId] ?? { [DEFAULT_SECTION_ID]: true }), [key]: true },
  };
};

/** Re-declares a শাখা under a new label (pure: returns a new registry). */
export const relabelSection = (registry, classId, from, to) => {
  const fromKey = toSectionId(from);
  const toKey = toSectionId(to);
  const current = mergeSectionRegistry(registry);
  if (!classId || !fromKey || !toKey || fromKey === toKey) return current;
  const sections = { ...(current[classId] ?? { [DEFAULT_SECTION_ID]: true }) };
  delete sections[fromKey];
  sections[toKey] = true;
  return { ...current, [classId]: sections };
};

/** Drops a declared-but-empty শাখা (pure: `ক` is never dropped). */
export const dropSection = (registry, classId, label) => {
  const key = toSectionId(label);
  const current = mergeSectionRegistry(registry);
  if (!classId || !key || key === DEFAULT_SECTION_ID) return current;
  const sections = { ...(current[classId] ?? { [DEFAULT_SECTION_ID]: true }) };
  delete sections[key];
  if (Object.keys(sections).length === 0) sections[DEFAULT_SECTION_ID] = true;
  return { ...current, [classId]: sections };
};

/**
 * `…/sessions/{year}/students/{classId}/{sectionId}/{id}` — or this year's
 * `passedArchive`. `classId` is translated to the canonical node key
 * (`c5` ➔ `class-5`) and a blank শাখা falls back to `ক`, so this hook and
 * `studentService.addStudentCloud` address the SAME enrollment node.
 */
const enrollmentPath = (reference, year, classId, studentMasterId, section = '') => (
  classId === 'archive'
    ? dbPaths.yearPassedStudent(reference, year, studentMasterId)
    : dbPaths.yearSectionStudent(
      reference, year, toDbClassId(classId), toSectionId(section), studentMasterId,
    )
);

/** The class-level enrollment node written before শাখা folders existed. */
const legacyEnrollmentPath = (reference, year, classId, studentMasterId) => (
  classId === 'archive'
    ? ''
    : dbPaths.yearStudent(reference, year, toDbClassId(classId), studentMasterId)
);

/**
 * Strictly hierarchical tenant root
 * (`divisions/{divisionId}/districts/{districtId}/upazilas/{upazilaId}/schools/{schoolId}`).
 *
 * Returns `''` for an incomplete reference so the caller refuses to write instead of
 * silently degrading to the legacy `schoolData/{schoolId}` tree.
 */
const tenantBasePath = (reference) => {
  const location = normalizeLocation(reference);
  if (!location) return '';
  // Caching the location is what keeps EVERY `dbPaths` helper (student master,
  // sessions, results, attendance) on the hierarchical node instead of degrading
  // to the legacy `schoolData/{schoolId}` tree.
  rememberSchoolLocation(location);
  return dbPaths.schoolBase(location);
};

/**
 * New admission, hierarchical only:
 * `studentMaster/{id}` (permanent identity) +
 * `sessions/{year}/students/{classId}/{sectionId}/{id}`.
 * No legacy `schoolData/{schoolId}/students` mirror is written — an incomplete
 * reference aborts the write instead.
 */
async function saveNewStudent(reference, year, student) {
  const base = tenantBasePath(reference);
  if (!base) return { synced: false, reason: 'incomplete-school-ref' };
  // The year's campus skeleton (profile/studentMaster/teachers/class buckets) is
  // materialised before the very first admission lands in it.
  await ensureSchoolYearBuckets(reference, year);
  const studentMasterId = await generateStudentMasterId(reference, year);
  const master = buildStudentMasterRecord(student, { studentMasterId, year });
  const enrollment = buildEnrollmentRecord(student, {
    studentMasterId, year, classId: student.classId, section: student.section,
  });
  return safeUpdate(base, {
    [relativeKey(base, dbPaths.studentMasterEntry(reference, studentMasterId))]: master,
    [relativeKey(base, enrollmentPath(reference, year, student.classId, studentMasterId, enrollment.section))]: enrollment,
  });
}

/**
 * Partial update, hierarchical only: identity fields merge into `studentMaster`,
 * enrollment fields into this year's শাখা folder. A class or section change moves
 * the enrollment row so no pupil is listed in two classes/sections, and the
 * previous class/year keeps its history.
 */
async function saveStudentPatch(reference, year, studentId, patch, previousClassId, existing) {
  const base = tenantBasePath(reference);
  if (!base) return { synced: false, reason: 'incomplete-school-ref' };
  const studentMasterId = existing?.studentMasterId || await resolveMasterId(reference, studentId);
  if (!studentMasterId) return { synced: false };
  const merged = { ...(existing ?? {}), ...(patch ?? {}), id: existing?.id ?? studentId };
  const nextClassId = patch?.classId ?? existing?.classId ?? '';
  // A class change / archive move targets a different `sessions/{year}/…` node:
  // make sure it exists before the row is written into it.
  if (nextClassId && nextClassId !== 'archive') await ensureSchoolYearBuckets(reference, year);
  const previousSectionId = toSectionId(existing?.section);
  const nextSectionId = toSectionId(Object.prototype.hasOwnProperty.call(patch ?? {}, 'section')
    ? patch.section
    : previousSectionId);
  const paths = {
    [relativeKey(base, dbPaths.studentMasterEntry(reference, studentMasterId))]: {
      ...buildStudentMasterRecord(merged, { studentMasterId, year }),
      // The permanent identity records which class the pupil currently sits in, so a
      // reader that only has the master node still knows the class (and a leaver
      // stays marked as graduated).
      overallStatus: nextClassId === 'archive' ? 'graduated' : 'active',
      currentClassId: nextClassId === 'archive' ? 'archived' : toDbClassId(nextClassId),
    },
    [relativeKey(base, enrollmentPath(reference, year, nextClassId, studentMasterId, nextSectionId))]:
      buildEnrollmentRecord(merged, {
        studentMasterId, year, classId: nextClassId, section: nextSectionId,
      }),
  };
  if (previousClassId && previousClassId !== nextClassId) {
    paths[relativeKey(base, enrollmentPath(reference, year, previousClassId, studentMasterId, previousSectionId))] = null;
    const legacy = legacyEnrollmentPath(reference, year, previousClassId, studentMasterId);
    if (legacy) paths[relativeKey(base, legacy)] = null;
  } else if (nextClassId !== 'archive' && previousSectionId !== nextSectionId) {
    // Section move: the old শাখা folder entry is cleared so the pupil appears once.
    paths[relativeKey(base, enrollmentPath(reference, year, nextClassId, studentMasterId, previousSectionId))] = null;
  }
  // The class-level node an older version wrote is always redundant now that the row
  // lives inside a শাখা folder, so it is cleared even when the target is unchanged.
  const legacyTarget = legacyEnrollmentPath(reference, year, nextClassId, studentMasterId);
  if (legacyTarget) paths[relativeKey(base, legacyTarget)] = null;
  return safeUpdate(base, paths);
}

/** Enrollment-level promotion keys, rewritten on every individual class move. */
const PROMOTION_ROW_KEYS = Object.freeze([
  'promotedAt', 'promotedFromClass', 'promotedFromYear', 'isNewPromotion', 'previousClassId',
]);

/**
 * Individual class change (`উত্তরণ` / শাখা বদল) of ONE pupil.
 *
 * All of the RTDB bookkeeping — the destination enrollment row, removal of the old
 * class/শাখা row, the `passedArchive` filing of a Class-5 leaver and the
 * `studentMaster` update — lives in `studentService.moveStudentClass`, so the same
 * tested writer serves the profile modal and any future caller.
 *
 * The tenant REFERENCE (`divisions/…/schools/{schoolId}`) is what `moveStudentClass`
 * resolves its base path from; passing the base path itself used to demote the write
 * to `schoolData/{slug}` so the move never reached the real node and the old
 * class/শাখা came back on reload.
 *
 * A promotion block is only written when the caller actually decided the promotion:
 * a শাখা-only move keeps the pupil's existing badge/origin metadata untouched.
 *
 * @param {object} previous the roster row as it is stored today
 * @param {object} next     the row as it should be stored (classId/section/roll applied)
 * @param {string} year     the active session year
 */
async function saveStudentClassChange(reference, year, previous = {}, next = {}) {
  const base = tenantBasePath(reference);
  if (!base) return { synced: false, reason: 'incomplete-school-ref' };
  const studentId = String(next.id ?? previous.id ?? '').trim();
  if (!studentId) return { synced: false };
  const studentMasterId = previous.studentMasterId
    || next.studentMasterId
    || await resolveMasterId(reference, studentId);
  if (!studentMasterId) return { synced: false };

  return moveStudentClass(reference, {
    year: normalizeSessionYear(year, DEFAULT_ACTIVE_YEAR),
    studentMasterId,
    legacyId: previous.legacyId ?? studentId,
    prevClassId: previous.classId,
    prevSectionId: previous.section,
    nextClassId: next.classId ?? previous.classId,
    nextSectionId: next.section ?? previous.section,
    roll: Number(next.roll ?? previous.roll) || 0,
    // Only the fields the caller explicitly decided are written (`null` clears them).
    promotion: PROMOTION_ROW_KEYS.some((key) => Object.prototype.hasOwnProperty.call(next, key))
      ? PROMOTION_ROW_KEYS.reduce((acc, key) => {
        acc[key] = next[key] === undefined ? null : next[key];
        return acc;
      }, {})
      : undefined,
    // Permanent identity fields travel with the move, so a rename is never lost.
    // `moveStudentClass` filters out every enrollment/year key itself.
    personal: next,
  });
}


/**
 * Student roster: read selectors plus every roster mutation.
 *
 * All cloud writes go through `runCloudSave` so the sync badge reflects real
 * Firebase traffic, and every local change funnels through `updateDataset`
 * so persistence + audit logging stay in one place.
 */
export function useStudents({
  dataset,
  datasetRef,
  updateDataset,
  schoolId,
  schoolRef = null,
  activeYear = '',
  canWriteTenant,
  runCloudSave,
  markSynced,
}) {
  // Roster, marks and attendance are all addressed through the hierarchical
  // `…/schools/{schoolId}/sessions/{year}` reference — never a bare school id.
  // An incomplete reference disables cloud writes instead of falling back to the
  // legacy `schoolData/{schoolId}/…` tree.
  const tenantRef = useMemo(() => normalizeLocation(schoolRef ?? {}), [schoolRef]);
  const canWriteCloud = Boolean(tenantRef && isCompleteSchoolRef(tenantRef));
  const year = normalizeSessionYear(activeYear, DEFAULT_ACTIVE_YEAR);
  // Register the tenant so every `dbPaths` helper resolves the hierarchical base
  // (demo additions included — never `schoolData/demo-school-01`).
  useEffect(() => {
    if (tenantRef) rememberSchoolLocation(tenantRef);
  }, [tenantRef]);

  const studentsByClass = useMemo(() => {
    const map = {};
    asList(dataset?.students).forEach((student) => {
      if (!student?.classId) return;
      const list = map[student.classId] ?? [];
      // A pupil stored before শাখা folders existed is shown under the default one.
      list.push({ ...student, section: toSectionId(student.section) });
      map[student.classId] = list;
    });
    Object.keys(map).forEach((classId) => {
      map[classId] = sortByRoll(map[classId]);
    });
    return map;
  }, [dataset.students]);

  /** `{classId: {sectionId: count}}` — drives the শাখা selector's totals. */
  const sectionCounts = useMemo(() => {
    const map = {};
    Object.entries(studentsByClass).forEach(([classId, list]) => {
      map[classId] = {};
      list.forEach((student) => {
        const section = toSectionId(student.section);
        map[classId][section] = (map[classId][section] ?? 0) + 1;
      });
    });
    return map;
  }, [studentsByClass]);

  /**
   * শাখা folders declared for this year (`sessions/{year}/meta/sections`).
   * It is a live subscription, so a শাখা created by one teacher appears for every
   * teacher — and an empty-but-declared শাখা survives a page refresh, which a
   * folder alone cannot (the Realtime Database drops empty nodes).
   */
  const [sectionRegistry, setSectionRegistry] = useState(createSectionRegistry);
  useEffect(() => {
    if (!tenantRef || !canWriteCloud) {
      // Offline / incomplete tenant: fall back to the seeded defaults so the
      // selector always has a usable object instead of `undefined`.
      setSectionRegistry(createSectionRegistry());
      return undefined;
    }
    return subscribeSectionRegistry(
      tenantRef,
      (registry) => setSectionRegistry(mergeSectionRegistry(registry)),
      undefined,
      year,
    );
  }, [tenantRef, canWriteCloud, year]);

  /**
   * শাখা folders of a class: `ক` first, then every other declared/used শাখা.
   * A section is free-form (any number of sections per class), so the union of the
   * registry and the pupils actually stored is what the selector lists.
   */
  const getSectionsOfClass = useCallback(
    (classId) => {
      const stored = Object.keys(sectionCounts[classId] ?? {});
      const declared = Object.keys(sectionRegistry?.[classId] ?? {});
      const others = [...new Set([...declared, ...stored])]
        .filter((section) => section !== DEFAULT_SECTION_ID)
        .sort((a, b) => a.localeCompare(b, 'bn'));
      return [DEFAULT_SECTION_ID, ...others];
    },
    [sectionCounts, sectionRegistry],
  );

  /** Roster of exactly one class + one শাখা. */
  const getStudentsOfSection = useCallback(
    (classId, section) => {
      const wanted = toSectionId(section);
      return (studentsByClass?.[classId] ?? []).filter((student) => toSectionId(student.section) === wanted);
    },
    [studentsByClass],
  );

  const getStudentsOfClass = useCallback(
    (classId) => (Array.isArray(studentsByClass?.[classId]) ? studentsByClass[classId] : []),
    [studentsByClass],
  );

  const getStudentById = useCallback(
    (studentId) => dataset.students.find((student) => student.id === studentId) ?? null,
    [dataset.students],
  );

  const addStudent = useCallback(
    (input) => {
      // A pupil always lands in a শাখা folder; `ক` is the school's default section.
      const section = toSectionId(input.section);
      // A roll typed in the admission form is kept when it is still free in that
      // class + শাখা; otherwise the next number AFTER the highest existing roll is
      // used, so a new admission can never duplicate a roll.
      const roster = datasetRef.current.students;
      const typedRoll = Number(input.roll) || 0;
      const roll = resolveRollAssignment(roster, {
        classId: input.classId,
        section,
        roll: typedRoll,
        placement: typedRoll ? 'preferred' : 'end',
      });
      const student = {
        id: makeId('stu'),
        name: String(input.name ?? '').trim(),
        classId: input.classId,
        section,
        roll,
        gender: input.gender ?? 'male',
        admissionYear: String(input.admissionYear ?? input.admissionDate?.slice?.(0, 4) ?? new Date().getFullYear()),
        birthDate: input.birthDate ?? '',
        birthCertificateNo: input.birthCertificateNo ?? '',
        fatherName: input.fatherName ?? '',
        fatherPhone: input.fatherPhone ?? '',
        motherName: input.motherName ?? '',
        motherPhone: input.motherPhone ?? '',
        guardianNid: input.guardianNid ?? '',
        address: input.address ?? '',
        admissionDate: input.admissionDate ?? `${input.admissionYear ?? new Date().getFullYear()}-01-01`,
        village: input.village ?? '',
        bloodGroup: input.bloodGroup ?? '',
        religion: input.religion ?? '',
        session: dataset.meta?.session ?? DEMO_SESSION,
        status: 'active',
        isDemo: input.isDemo === true,
      };

      if (canWriteCloud && canWriteTenant) {
        runCloudSave(() => saveNewStudent(tenantRef, year, student));
        // The শাখা is declared for the year as well, so a section that was typed in
        // the admission form is listed (and shared with every teacher) immediately.
        runCloudSave(() => registerSectionCloud(tenantRef, year, student.classId, section));
      }
      updateDataset(
        (prev) => ({
          ...prev,
          students: [...prev.students, student],
          marks: { ...prev.marks, [student.id]: createEmptyMarks() },
        }),
        {
          action: 'student.create',
          detail: `${student.name} — নতুন শিক্ষার্থী যুক্ত হয়েছে`,
          actor: 'school_admin',
        },
      );

      return student;
    },
    [dataset.meta, updateDataset, canWriteCloud, tenantRef, year, canWriteTenant, runCloudSave],
  );

  /**
   * Bulk Excel import save (`শিক্ষার্থী আমদানি`).
   *
   * The plan was already built and reviewed in the preview modal, so this only
   * (a) mirrors the same rows locally (instant roster paint) and (b) commits the whole
   * file with ONE atomic multi-path database update.
   *
   * `force` is only passed by Warning #2 of the preview: without it, rows whose roll
   * conflicts with another pupil are skipped instead of creating a duplicate.
   */
  const importStudents = useCallback(
    async (plan, { force = false } = {}) => {
      const rows = Array.isArray(plan?.rows) ? plan.rows : [];
      if (!rows.length) return { synced: true, written: 0, skipped: 0 };

      // Local mirror first: the roster shows the imported pupils immediately.
      updateDataset(
        (prev) => {
          const byId = new Map(prev.students.map((student) => [student.studentMasterId || student.id, student]));
          let created = 0;
          rows.forEach((row) => {
            if (row.status === 'conflict' && !force) return;
            const values = row.values ?? {};
            const existing = row.existing;
            if (existing) {
              const key = existing.studentMasterId || existing.id;
              byId.set(key, {
                ...existing,
                ...values,
                classId: row.classId,
                section: row.section,
                roll: row.resolvedRoll,
                id: existing.id,
              });
              return;
            }
            created += 1;
            const localId = `stu-import-${row.classId}-${row.section}-${row.line}`;
            byId.set(localId, {
              ...values,
              id: localId,
              classId: row.classId,
              section: row.section,
              roll: row.resolvedRoll,
              status: 'active',
              isDemo: false,
            });
          });
          const students = [...byId.values()];
          const marks = { ...prev.marks };
          students.forEach((student) => {
            if (!marks[student.id]) marks[student.id] = createEmptyMarks();
          });
          return { ...prev, students, marks };
        },
        {
          action: 'student.import',
          detail: `এক্সেল থেকে ${rows.length} সারি আমদানি হয়েছে`,
          actor: 'school_admin',
        },
      );

      if (!canWriteCloud || !canWriteTenant) return { synced: false, written: 0, skipped: 0 };
      return runCloudSave(
        () => importStudentsCloud(tenantRef, year, plan, { force }),
        { timeoutMs: PROMOTION_SAVE_TIMEOUT_MS },
      );
    },
    [updateDataset, canWriteCloud, canWriteTenant, tenantRef, year, runCloudSave],
  );

  const updateStudent = useCallback(
    (studentId, patch) => {
      const existing = datasetRef.current.students.find((student) => student.id === studentId);
      // A class change / শাখা change / archive move is a MOVE of the enrollment row,
      // not an in-place edit — it goes through the single multi-path writer so the
      // old folder is cleared, the new one written and `studentMaster` stays in step.
      const nextClassId = patch?.classId ?? existing?.classId ?? '';
      const classMoved = Boolean(existing) && Boolean(patch?.classId) && patch.classId !== existing.classId;
      const sectionMoved = Boolean(existing)
        && patch?.section !== undefined
        && toSectionId(patch.section) !== toSectionId(existing.section);
      const isMove = Boolean(existing) && (classMoved || sectionMoved);

      /* ---- Zero duplicate rolls -----------------------------------------------
       * A class/শাখা change always writes a roll that no other pupil of the target
       * class + শাখা holds. The edit modal already resolved it; this is the safety
       * net for any other caller (a শাখা rename, a bulk import, a script), so a move
       * can never land on an occupied number. `এক শ্রেণি নিচে যাবে` is identified by
       * the target class being BELOW the current one and always goes to the very end
       * of the destination list.
       * ----------------------------------------------------------------------- */
      let effectivePatch = patch;
      if (isMove && existing && nextClassId !== 'archive') {
        const targetSection = toSectionId(patch.section ?? existing.section);
        const demoting = Boolean(existing.classId)
          && (CLASS_LEVELS.findIndex((item) => item.id === nextClassId) <
            CLASS_LEVELS.findIndex((item) => item.id === existing.classId));
        const roll = resolveRollAssignment(datasetRef.current.students, {
          classId: nextClassId,
          section: targetSection,
          roll: patch.roll ?? existing.roll,
          ignoreIds: [studentId],
          placement: demoting ? 'end' : 'preferred',
        });
        effectivePatch = { ...patch, roll };
      }

      if (canWriteCloud && canWriteTenant && existing) {
        if (isMove) {
          runCloudSave(() => saveStudentClassChange(
            tenantRef,
            year,
            existing,
            {
              ...existing,
              ...effectivePatch,
              classId: nextClassId,
              section: toSectionId(effectivePatch.section ?? existing.section),
            },
          ));
          // A class move inside the SAME year keeps the pupil's marks usable: their
          // current-year result rows follow them into the target class, so the target's
          // result view is never blank while the old class no longer lists them.
          if (classMoved && nextClassId !== 'archive') {
            runCloudSave(() => moveStudentResultRows(tenantRef, year, studentId, existing.classId, nextClassId));
          }
        } else {
          runCloudSave(() => saveStudentPatch(tenantRef, year, studentId, effectivePatch, existing.classId, existing));
        }
        // A section typed into the edit form is declared for the year too, so the
        // destination শাখা selector lists it immediately.
        const touchedSection = Object.prototype.hasOwnProperty.call(effectivePatch ?? {}, 'section');
        if (touchedSection && nextClassId && nextClassId !== 'archive') {
          runCloudSave(() => registerSectionCloud(tenantRef, year, nextClassId, effectivePatch.section));
        }
      }
      updateDataset(
        (prev) => ({
          ...prev,
          students: prev.students.map((student) => {
            if (student.id !== studentId) return student;
            const targetClassId = effectivePatch.classId ?? student.classId;
            const targetSection = toSectionId(effectivePatch.section ?? student.section);
            const archived = targetClassId === 'archive';
            return {
              ...student,
              ...effectivePatch,
              classId: targetClassId,
              section: targetSection,
              status: archived ? 'archived' : 'active',
              previousClassId: archived
                ? (student.classId === 'archive' ? student.previousClassId : student.classId)
                : (effectivePatch.previousClassId ?? student.previousClassId ?? null),
              id: student.id,
            };
          }),
        }),
        { action: 'student.update', detail: 'শিক্ষার্থীর তথ্য হালনাগাদ হয়েছে', actor: 'school_admin' },
      );
    },
    [updateDataset, canWriteCloud, tenantRef, year, canWriteTenant, runCloudSave],
  );

  const archiveStudent = useCallback(
    (studentId) => {
      const existing = datasetRef.current.students.find((student) => student.id === studentId);
      if (!existing || existing.classId === 'archive') return;
      const archived = { ...existing, previousClassId: existing.classId, classId: 'archive', status: 'archived' };
      // The year partition keeps the graduate, so no flat `schoolData/{id}/archive`
      // mirror is written any more.
      if (canWriteCloud && canWriteTenant) {
        runCloudSave(() => saveStudentPatch(
          tenantRef,
          year,
          studentId,
          { classId: 'archive', status: 'archived', previousClassId: existing.classId },
          existing.classId,
          existing,
        ));
      }
      updateDataset(
        (previous) => ({
          ...previous,
          students: previous.students.map((student) => (student.id === studentId ? archived : student)),
        }),
        { action: 'student.archive', detail: `${existing.name} আর্কাইভে পাঠানো হয়েছে`, actor: 'school_admin' },
      );
    },
    [updateDataset, canWriteCloud, tenantRef, year, canWriteTenant, runCloudSave],
  );

  const restoreStudent = useCallback(
    (studentId, classId) => {
      const existing = datasetRef.current.students.find((student) => student.id === studentId);
      if (!existing || existing.classId !== 'archive' || !CLASS_LEVELS.some((item) => item.id === classId)) return;
      // The pupil returns to the শাখা they left (the default one when unknown) and is
      // placed at the END of that class + শাখা list, so a restore never duplicates a
      // roll that is already in use.
      const section = toSectionId(existing.section ?? existing.previousSectionId ?? existing.previousSection);
      const roll = nextFreeRollInBucket(datasetRef.current.students, {
        classId,
        section,
        ignoreIds: [studentId],
      });
      const restored = { ...existing, classId, roll, section, status: 'active', previousClassId: null };
      if (canWriteCloud && canWriteTenant) {
        runCloudSave(() => saveStudentPatch(
          tenantRef,
          year,
          studentId,
          { classId, roll, section, status: 'active', previousClassId: null },
          existing.classId,
          existing,
        ));
      }
      updateDataset(
        (previous) => ({
          ...previous,
          students: previous.students.map((student) => (student.id === studentId ? restored : student)),
        }),
        { action: 'student.restore', detail: `${existing.name} ${classId} শ্রেণিতে ফিরিয়ে নেওয়া হয়েছে`, actor: 'school_admin' },
      );
    },
    [updateDataset, canWriteCloud, tenantRef, year, canWriteTenant, runCloudSave],
  );

  const removeStudent = useCallback(
    (studentId) => {
      const existing = datasetRef.current.students.find((student) => student.id === studentId);
      if (existing) archiveStudent(studentId);
    },
    [archiveStudent],
  );

  const setStudentRoll = useCallback(
    (studentId, roll) => {
      const numeric = Number(roll);
      if (!Number.isFinite(numeric) || numeric < 1) return;
      const rounded = Math.round(numeric);
      const student = datasetRef.current.students.find((item) => item.id === studentId);
      // A hand-typed roll is only accepted when it is free in that class + শাখা;
      // asking for an occupied number keeps the pupil at the end of the list instead
      // of creating a duplicate.
      const resolved = student && student.classId !== 'archive'
        ? resolveRollAssignment(datasetRef.current.students, {
          classId: student.classId,
          section: student.section,
          roll: rounded,
          ignoreIds: [studentId],
          placement: 'preferred',
        })
        : rounded;
      if (canWriteCloud && canWriteTenant && student) {
        runCloudSave(() => saveStudentPatch(tenantRef, year, studentId, { roll: resolved }, student.classId, student));
      }
      updateDataset((prev) => ({
        ...prev,
        students: prev.students.map((item) => (item.id === studentId ? { ...item, roll: resolved } : item)),
      }));
    },
    [updateDataset, canWriteCloud, tenantRef, year, canWriteTenant, runCloudSave],
  );

  /* ---------------------------------------------------------------- *
   * Flexible শাখা management (any number of sections per class)
   * ---------------------------------------------------------------- */

  /** Declares a free-form শাখা of a class (`ক`, `খ`, `ক-শাখা`, anything). */
  const addSection = useCallback(
    (classId, section) => {
      const label = toSectionId(section);
      if (!classId || !label) return '';
      setSectionRegistry((previous) => declareSection(previous, classId, label));
      if (canWriteCloud && canWriteTenant) {
        runCloudSave(() => registerSectionCloud(tenantRef, year, classId, label));
      }
      updateDataset(
        (previous) => previous,
        {
          action: 'section.create',
          detail: `${classId} শ্রেণিতে "${label}" শাখা যোগ হয়েছে`,
          actor: 'school_admin',
        },
      );
      return label;
    },
    [updateDataset, canWriteCloud, canWriteTenant, tenantRef, year, runCloudSave],
  );

  /**
   * Renames a শাখা: the declared folder is re-declared under the new label and every
   * pupil of the old folder is moved, so a class is never split across two spellings.
   */
  const renameSection = useCallback(
    (classId, from, to) => {
      const fromKey = toSectionId(from);
      const toKey = toSectionId(to);
      if (!classId || !fromKey || !toKey || fromKey === toKey) return false;
      const roster = datasetRef.current.students.filter(
        (student) => student.classId === classId && toSectionId(student.section) === fromKey,
      );
      roster.forEach((student) => {
        updateStudent(student.id, { section: toKey });
      });
      setSectionRegistry((previous) => relabelSection(previous, classId, fromKey, toKey));
      if (canWriteCloud && canWriteTenant) {
        runCloudSave(async () => {
          if (fromKey !== DEFAULT_SECTION_ID) {
            await unregisterSectionCloud(tenantRef, year, classId, fromKey);
          }
          return registerSectionCloud(tenantRef, year, classId, toKey);
        });
      }
      updateDataset(
        (previous) => previous,
        {
          action: 'section.rename',
          detail: `${classId} শ্রেণির "${fromKey}" শাখা "${toKey}" নামে পরিবর্তিত হয়েছে`,
          actor: 'school_admin',
        },
      );
      return true;
    },
    [updateStudent, updateDataset, canWriteCloud, canWriteTenant, tenantRef, year, runCloudSave],
  );

  /** Removes a declared-but-empty শাখা; `ক` and any occupied শাখা are kept. */
  const removeSection = useCallback(
    (classId, section) => {
      const key = toSectionId(section);
      if (!classId || !key || key === DEFAULT_SECTION_ID) return false;
      if ((sectionCounts?.[classId]?.[key] ?? 0) > 0) return false;
      setSectionRegistry((previous) => dropSection(previous, classId, key));
      if (canWriteCloud && canWriteTenant) {
        runCloudSave(() => unregisterSectionCloud(tenantRef, year, classId, key));
      }
      updateDataset(
        (previous) => previous,
        {
          action: 'section.remove',
          detail: `${classId} শ্রেণির "${key}" শাখা সরানো হয়েছে`,
          actor: 'school_admin',
        },
      );
      return true;
    },
    [sectionCounts, updateDataset, canWriteCloud, canWriteTenant, tenantRef, year, runCloudSave],
  );

  /**
   * Executes annual promotion **inside the active year**, section-aware.
   *
   * @param {Array<{studentId:string, action:'promote'|'retain', section?:string}>} decisions
   *   `promote` ➔ উত্তীর্ণ (next class), `retain` ➔ এই ক্লাসেই থাকুক. `section` is the
   *   destination শাখা (any label); blank keeps the pupil's own শাখা.
   * @returns {Promise<{synced:boolean, promoted:number, retained:number, archived:number}>}
   *   `synced` reflects ONLY the primary roster write, so a failing non-critical
   *   secondary/legacy write can never report the promotion as failed.
   */
  const executePromotion = useCallback(
    (decisions = [], options = {}) => {
      const decisionMap = new Map(decisions.map((item) => [item.studentId, item]));
      const pickSection = (item, fallback) => {
        const raw = item?.section;
        return raw === undefined || raw === null || raw === '' ? fallback : toSectionId(raw);
      };
      const sourceStudents = datasetRef.current.students;
      const sourceById = new Map(sourceStudents.map((student) => [student.id, student]));
      // The active partition is authoritative (it is the `sessions/{year}` node the
      // cloud write targets); `meta.session` is only a display fallback.
      const promotedAt = nowISO();
      const yearKey = normalizeSessionYear(year, normalizeSessionYear(datasetRef.current.meta?.session, DEFAULT_ACTIVE_YEAR));

      /** `studentId ➔ {action, nextClass, section, roll, archived}` computed locally. */
      const moves = new Map();
      const archivedIds = [];
      /** `studentId ➔ roll` of every row this batch renumbers (batch + displaced residents). */
      let assignments = new Map();
      {
        /* ---- Rolls ------------------------------------------------------------
         * One plan for the whole batch (`planPromotionRolls`), the exact same function
         * the campus store uses: pupils promoted in from a lower class get clean
         * ১, ২, ৩… rolls in merit order, and pupils already sitting in the class
         * (including `এই ক্লাসেই থাকুক`) are placed AFTER them — so a class receiving
         * lower-class students can never end up with two pupils sharing a roll.
         * `staying`/`incoming` follow the merit order the decisions arrive in.
         * -------------------------------------------------------------------- */
        const targetOf = new Map();
        sourceStudents.forEach((student) => {
          const decision = decisionMap.get(student.id);
          if (decision && student.classId !== 'archive') {
            // Where the pupil lands (own class when `এই ক্লাসেই থাকুক`). The roster
            // offers exactly two decisions: `উত্তীর্ণ` and `এই ক্লাসেই থাকুক`.
            const action = decision.action === 'retain' ? 'retain' : 'promote';
            const nextClass = action === 'retain'
              ? student.classId
              : NEXT_CLASS_MAP[student.classId];
            targetOf.set(student.id, {
              action,
              nextClass: nextClass || student.classId,
              section: pickSection(decision, toSectionId(student.section)),
            });
          }
        });

        const rollPlan = planPromotionRolls({
          entries: decisions
            .map((decision) => {
              const target = targetOf.get(decision.studentId);
              if (!target) return null;
              return {
                id: decision.studentId,
                action: target.action,
                targetClassId: target.nextClass,
                section: target.section,
              };
            })
            .filter(Boolean),
          roster: sourceStudents,
          movingIds: [...targetOf.keys()],
        });
        assignments = rollPlan;

        decisions.forEach((decision) => {
          const candidate = sourceById.get(decision.studentId);
          const target = targetOf.get(decision.studentId);
          if (!candidate || !target) return;
          const archived = target.nextClass === 'archive';
          // A graduate keeps their roll (the archive is not a numbered list); a
          // continuing pupil always takes the roll the plan assigned.
          const plannedRoll = rollPlan.get(candidate.id);
          const roll = archived
            ? (Number(candidate.roll) || 0)
            : (plannedRoll ?? (Number(candidate.roll) || 0));
          if (archived) archivedIds.push(candidate.id);
          moves.set(candidate.id, { ...target, roll, archived });
        });
      }

      // Local (optimistic) roster: the same reshuffle the campus store writes. The
      // reducer stays PURE — no cloud call is made from inside it.
      updateDataset(
        (prev) => {
          const resequenced = prev.students.map((student) => {
            const move = moves.get(student.id);
            // A pupil already sitting in a class that received lower-class students is
            // renumbered after them, so the local list matches the stored one exactly.
            const plannedRoll = assignments.get(student.id);
            if (!move) {
              return plannedRoll && plannedRoll !== Number(student.roll)
                ? { ...student, roll: plannedRoll }
                : student;
            }
            const archived = move.archived;
            // Promotion metadata distinguishes "নতুন উত্তীর্ণ" (came from another
            // class) from a repeating pupil kept in the same class.
            const origin = archived || move.action === 'promote'
              ? {
                promotedAt,
                promotedFromClass: student.classId,
                promotedFromYear: yearKey,
                isNewPromotion: true,
              }
              : {
                promotedAt: null,
                promotedFromClass: null,
                promotedFromYear: null,
                isNewPromotion: false,
              };
            return {
              ...student,
              classId: move.nextClass,
              section: move.section,
              roll: move.roll,
              status: archived ? 'archived' : 'active',
              graduatedYear: archived ? (prev.meta?.session ?? DEMO_SESSION) : student.graduatedYear,
              previousClassId: archived || move.action === 'promote' ? student.classId : null,
              // A pupil who moves to a NEW class starts with no published result: the old
              // merit/GPA/grade belong to the class they left, so the new class shows `০০`
              // / `ফলাফল নেই` until its own marks exist. Nothing is deleted — the
              // historical result rows stay under the previous class.
              ...(move.action === 'promote' && !archived
                ? { meritPosition: null, gpa: null, grade: '', grandTotal: null }
                : {}),
              ...origin,
            };
          });

          return {
            ...prev,
            students: resequenced,
            meta: {
              ...prev.meta,
              lastPromotionAt: promotedAt,
              promotionLog: [{
                at: promotedAt,
                session: prev.meta?.session ?? DEMO_SESSION,
                promoted: [...moves.values()].filter((move) => move.action === 'promote' && !move.archived).length,
                archived: archivedIds.length,
                retained: decisions.filter((item) => item.action === 'retain').length,
                sections: options?.distribution ?? null,
              }, ...(prev.meta?.promotionLog ?? [])].slice(0, 20),
            },
          };
        },
        {
          action: 'promotion.execute',
          detail: `বার্ষিক শ্রেণি উত্তরণ সম্পন্ন — ${decisions.filter((d) => d.action !== 'retain').length} জন উত্তীর্ণ`,
          actor: 'school_admin',
        },
      );

      const summary = {
        synced: true,
        partial: false,
        // Retained pupils stay where they are, so only continuing pupils count as
        // promoted; Class-5 leavers are reported separately as `archived`.
        promoted: [...moves.values()].filter((move) => move.action === 'promote' && !move.archived).length,
        retained: decisions.filter((item) => item.action === 'retain').length,
        archived: archivedIds.length,
      };

      /* ---- campus store write ------------------------------------------------
       * Annual promotion inside the SAME year node:
       * `sessions/{year}/students/{nextClassId}/{sectionId}/{id}` for every pupil
       * that continues, `sessions/{year}/passedArchive/{id}` for Class-5 leavers,
       * plus the `studentMaster` / `meta/sections` side writes. A refresh therefore
       * replays the promoted classes and every teacher sees the same roster live.
       *
       * The save is scheduled OUTSIDE the reducer so React's double-invoked state
       * updater can never issue the same RTDB write twice — and its verdict is what
       * the caller receives, so the promotion can report an accurate save result.
       * --------------------------------------------------------------------- */
      if (!moves.size || !canWriteCloud || !canWriteTenant) return Promise.resolve(summary);

      // Choices are addressed by app id; the store needs the permanent master id,
      // resolved from the row BEFORE the move (a leaver is still in class 5 here).
      const cloudDecisions = decisions
        .map((item) => {
          const student = sourceById.get(item.studentId);
          if (!student || student.classId === 'archive') return null;
          return {
            studentId: item.studentId,
            studentMasterId: student.studentMasterId || student.id,
            action: item.action === 'retain' ? 'retain' : 'promote',
            section: item.section === undefined || item.section === null ? '' : toSectionId(item.section),
          };
        })
        .filter(Boolean);

      const fromClassIds = [...new Set(
        cloudDecisions
          .map((item) => sourceById.get(item.studentId)?.classId)
          .filter((classId) => classId && classId !== 'archive'),
      )];
      if (!fromClassIds.length) return Promise.resolve(summary);

      // Sequential on purpose: each class's roll plan is computed against the stored
      // roster, so two batches must never renumber the same class at the same time.
      const saves = fromClassIds.reduce((chain, fromClassId) => chain.then(async (results) => {
        const decidedIds = new Set(
          cloudDecisions
            .filter((item) => sourceById.get(item.studentId)?.classId === fromClassId)
            .map((item) => item.studentId),
        );
        // A class-wide promotion is a multi-node write; 3s is too tight for it and a
        // timeout used to be reported as a failed save.
        const result = await runCloudSave(() => promoteClassInYear(tenantRef, year, {
          fromClassId,
          decisions: cloudDecisions.filter((item) => decidedIds.has(item.studentId)),
          // Only the pupils the teacher actually decided on are moved — an
          // undecided class keeps its current roster unchanged.
          students: sourceStudents.filter(
            (student) => decidedIds.has(student.id) && student.classId === fromClassId,
          ),
          targetSections: options?.targetSections ?? [],
          // Shared batch timestamp so the stored `promotedAt` matches the local rows.
          promotedAt,
        }), { timeoutMs: PROMOTION_SAVE_TIMEOUT_MS });
        return [...results, result];
      }), Promise.resolve([]));

      return saves.then((results) => {
        const synced = results.length > 0 && results.every((entry) => entry?.synced !== false);
        /* ---- Mirror the authoritative rolls ---------------------------------
         * The store returns `{ studentMasterId: roll }` for every row it wrote —
         * including the pupils it pushed to the end of a class that received
         * lower-class students. Applying it locally keeps the on-screen roll list
         * identical to the persisted one (no duplicate after a reload).
         * ------------------------------------------------------------------- */
        const written = results.reduce((acc, entry) => ({ ...acc, ...(entry?.assignment ?? {}) }), {});
        if (Object.keys(written).length) {
          const byMasterId = new Map(sourceStudents.map((student) => [
            String(student.studentMasterId || student.id),
            student.id,
          ]));
          const resolved = new Map();
          Object.entries(written).forEach(([masterId, roll]) => {
            const appId = byMasterId.get(String(masterId)) ?? String(masterId);
            const numeric = Number(roll);
            if (Number.isFinite(numeric) && numeric > 0) resolved.set(appId, numeric);
          });
          if (resolved.size) {
            updateDataset((previous) => ({
              ...previous,
              students: previous.students.map((student) => {
                const roll = resolved.get(student.id);
                return roll && roll !== Number(student.roll) ? { ...student, roll } : student;
              }),
            }));
          }
        }
        // The PRIMARY roster write succeeded ➔ the promotion is saved. Any stale
        // failed/partial badge state is cleared here, so a non-critical secondary
        // write (identity row, শাখা registry, audit log) can never leave the topbar
        // stuck on "সেভ ব্যর্থ হয়েছে".
        if (synced) markSynced?.();
        return {
          ...summary,
          // PRIMARY roster writes decide the verdict — a secondary-only failure is
          // still a successful promotion (`partial`), never "সেভ ব্যর্থ হয়েছে".
          synced,
          partial: results.some((entry) => entry?.partial === true),
        };
      });
    },
    [updateDataset, canWriteCloud, tenantRef, year, canWriteTenant, runCloudSave, markSynced],
  );

  /* ---------------------------------------------------------------- *
   * Year-scoped promotion (P0-3 / P0-7)
   * ---------------------------------------------------------------- */

  /**
   * Annual rollover: `sessions/{currentYear}` ➔ `sessions/{nextYear}`.
   *
   * Guarantees:
   *  - the finished year (`students`, `results`, `attendance`, remarks) is NEVER edited —
   *    it stays frozen history;
   *  - every pupil keeps the same `studentMasterId`; the new year's roster starts with
   *    EMPTY results (the new class's result begins at `০০`, no old GPA/grade stamp);
   *  - `profile.activeYear` moves to the new year, so the whole UI re-partitions.
   *
   * @param {{year?:string, nextYear?:string, decisions?:Array<object>}} options
   * @returns {Promise<{synced:boolean, year:string, nextYear:string, promoted:number,
   *   graduated:number, retained:number, demoted:number, reason?:string}>}
   */
  const advanceAcademicYear = useCallback(
    async ({ year: fromYear = year, nextYear = '', decisions = [] } = {}) => {
      const sourceYear = normalizeSessionYear(fromYear, year);
      const targetYear = normalizeSessionYear(nextYear, nextSessionYear(sourceYear));
      const failed = { synced: false, year: sourceYear, nextYear: targetYear, promoted: 0, graduated: 0, retained: 0, demoted: 0 };
      if (!schoolId || !sourceYear || !targetYear || targetYear === sourceYear) {
        return { ...failed, reason: 'invalid-target-year' };
      }
      if (!canWriteCloud || !canWriteTenant) return { ...failed, reason: 'offline' };

      // The source year is only READ here: `promoteSession` writes the destination year,
      // the leavers' archive and the profile's active year.
      const result = await runCloudSave(
        () => promoteSession(schoolId, { year: sourceYear, nextYear: targetYear, decisions }),
        { timeoutMs: PROMOTION_SAVE_TIMEOUT_MS },
      );
      if (result?.synced === false) {
        return { ...failed, reason: result?.reason || (result?.timedOut ? 'timeout' : 'write-failed') };
      }
      markSynced?.();
      return {
        synced: true,
        year: sourceYear,
        nextYear: targetYear,
        promoted: result?.promoted ?? 0,
        graduated: result?.graduated ?? 0,
        retained: result?.retained ?? 0,
        demoted: result?.demoted ?? 0,
      };
    },
    [schoolId, year, canWriteCloud, canWriteTenant, runCloudSave, markSynced],
  );

  return {
    studentsByClass,
    sectionCounts,
    sectionRegistry,
    getSectionsOfClass,
    getStudentsOfSection,
    getStudentsOfClass,
    getStudentById,
    addSection,
    renameSection,
    removeSection,
    addStudent,
    importStudents,
    updateStudent,
    archiveStudent,
    restoreStudent,
    removeStudent,
    setStudentRoll,
    executePromotion,
    advanceAcademicYear,
  };
}

export default useStudents;

