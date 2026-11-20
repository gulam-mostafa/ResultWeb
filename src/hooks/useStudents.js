import { useCallback, useEffect, useMemo, useState } from 'react';
import { CLASS_LEVELS, NEXT_CLASS_MAP, DEMO_SESSION } from '../utils/constants.js';
import { DEFAULT_ACTIVE_YEAR, isCompleteSchoolRef } from '../context/AuthContext.jsx';
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
  toDbClassId,
  toSectionId,
  DEFAULT_SECTION_ID,
  promoteClassInYear,
  registerSectionCloud,
  unregisterSectionCloud,
  subscribeSectionRegistry,
  ensureSchoolYearBuckets,
} from '../services/database/index.js';

const nowISO = () => new Date().toISOString();
const makeId = (prefix) =>
  `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

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
    [relativeKey(base, dbPaths.studentMasterEntry(reference, studentMasterId))]:
      buildStudentMasterRecord(merged, { studentMasterId, year }),
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
      const student = {
        id: makeId('stu'),
        name: String(input.name ?? '').trim(),
        classId: input.classId,
        section,
        roll: Number(input.roll) || (datasetRef.current.students.filter((item) => item.classId === input.classId).length + 1),
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

  const updateStudent = useCallback(
    (studentId, patch) => {
      const existing = datasetRef.current.students.find((student) => student.id === studentId);
      if (canWriteCloud && canWriteTenant && existing) {
        runCloudSave(() => saveStudentPatch(tenantRef, year, studentId, patch, existing.classId, existing));
        // A section typed into the edit form is declared for the year too.
        const touchedSection = Object.prototype.hasOwnProperty.call(patch ?? {}, 'section');
        const nextClassId = patch?.classId ?? existing.classId;
        if (touchedSection && nextClassId && nextClassId !== 'archive') {
          runCloudSave(() => registerSectionCloud(tenantRef, year, nextClassId, patch.section));
        }
      }
      updateDataset(
        (prev) => ({
          ...prev,
          students: prev.students.map((student) => {
            if (student.id !== studentId) return student;
            const nextClassId = patch.classId ?? student.classId;
            return {
              ...student,
              ...patch,
              classId: nextClassId,
              section: toSectionId(patch.section ?? student.section),
              status: nextClassId === 'archive' ? 'archived' : 'active',
              previousClassId: nextClassId === 'archive'
                ? (student.classId === 'archive' ? student.previousClassId : student.classId)
                : null,
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
      const roll = datasetRef.current.students.filter((student) => student.classId === classId).length + 1;
      // The pupil returns to the শাখা they left (the default one when unknown).
      const section = toSectionId(existing.section ?? existing.previousSectionId);
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
      if (canWriteCloud && canWriteTenant && student) {
        runCloudSave(() => saveStudentPatch(tenantRef, year, studentId, { roll: rounded }, student.classId, student));
      }
      updateDataset((prev) => ({
        ...prev,
        students: prev.students.map((item) => (item.id === studentId ? { ...item, roll: rounded } : item)),
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
   */
  const executePromotion = useCallback(
    (decisions = [], options = {}) => {
      const decisionMap = new Map(decisions.map((item) => [item.studentId, item]));
      const pickSection = (item, fallback) => {
        const raw = item?.section;
        return raw === undefined || raw === null || raw === '' ? fallback : toSectionId(raw);
      };

      updateDataset(
        (prev) => {
          const archivedIds = [];

          // Rolls are re-numbered per destination class AND শাখা, continuing after the
          // pupils who are NOT part of this promotion, so no two pupils share a roll.
          const baseline = new Map();
          const tally = (classId, section) => {
            const key = `${classId}::${toSectionId(section)}`;
            baseline.set(key, (baseline.get(key) ?? 0) + 1);
            return baseline.get(key);
          };
          const targetOf = new Map();
          prev.students.forEach((student) => {
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
              return;
            }
            // Untouched pupils keep their roll and reserve their own slot.
            if (student.classId && student.classId !== 'archive') tally(student.classId, student.section);
          });

          // The decisions arrive in MERIT order (১ম at the top), so rolls are handed
          // out in exactly that order — the same order the campus store writes.
          const updatedById = new Map();
          decisions.forEach((decision) => {
            const student = prev.students.find((item) => item.id === decision.studentId);
            const target = targetOf.get(decision.studentId);
            if (!student || !target) return;
            const roll = tally(target.nextClass, target.section);
            const promoted = {
              ...student,
              classId: target.nextClass,
              section: target.section,
              roll,
              status: target.nextClass === 'archive' ? 'archived' : 'active',
              graduatedYear: target.nextClass === 'archive' ? prev.meta?.session ?? DEMO_SESSION : student.graduatedYear,
              previousClassId: target.nextClass === 'archive'
                ? student.classId
                : (target.action === 'promote' ? student.classId : null),
            };
            if (target.nextClass === 'archive') archivedIds.push(student.id);
            updatedById.set(student.id, promoted);
          });
          const resequenced = prev.students.map((student) => updatedById.get(student.id) ?? student);

          // Annual promotion inside the SAME year node, delegated to the campus store:
          // `sessions/{year}/students/{nextClassId}/{sectionId}/{id}` for every pupil
          // that continues, `sessions/{year}/passedArchive/{id}` for Class-5 leavers,
          // plus the `studentMaster` + `meta/sections` updates. A refresh therefore
          // replays the promoted classes and every teacher sees the same roster live.
          if (canWriteCloud && canWriteTenant) {
            const sourceById = new Map(prev.students.map((student) => [student.id, student]));
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
            fromClassIds.forEach((fromClassId) => {
              const decidedIds = new Set(
                cloudDecisions
                  .filter((item) => sourceById.get(item.studentId)?.classId === fromClassId)
                  .map((item) => item.studentId),
              );
              runCloudSave(() => promoteClassInYear(tenantRef, year, {
                fromClassId,
                decisions: cloudDecisions.filter((item) => decidedIds.has(item.studentId)),
                // Only the pupils the teacher actually decided on are moved — an
                // undecided class keeps its current roster unchanged.
                students: prev.students.filter(
                  (student) => decidedIds.has(student.id) && student.classId === fromClassId,
                ),
                targetSections: options?.targetSections ?? [],
              }));
            });
          }

          const promotedCount = decisions.filter((item) => item.action !== 'retain').length;
          const promotionEntry = {
            at: nowISO(),
            session: prev.meta?.session ?? DEMO_SESSION,
            promoted: archivedIds.length > 0 ? promotedCount - archivedIds.length : promotedCount,
            archived: archivedIds.length,
            retained: decisions.filter((item) => item.action === 'retain').length,
            sections: options?.distribution ?? null,
          };

          return {
            ...prev,
            students: resequenced,
            meta: {
              ...prev.meta,
              lastPromotionAt: promotionEntry.at,
              promotionLog: [promotionEntry, ...(prev.meta?.promotionLog ?? [])].slice(0, 20),
            },
          };
        },
        {
          action: 'promotion.execute',
          detail: `বার্ষিক শ্রেণি উত্তরণ সম্পন্ন — ${decisions.filter((d) => d.action !== 'retain').length} জন উত্তীর্ণ`,
          actor: 'school_admin',
        },
      );
    },
    [updateDataset, canWriteCloud, tenantRef, year, canWriteTenant, runCloudSave],
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
    updateStudent,
    archiveStudent,
    restoreStudent,
    removeStudent,
    setStudentRoll,
    executePromotion,
  };
}

export default useStudents;

