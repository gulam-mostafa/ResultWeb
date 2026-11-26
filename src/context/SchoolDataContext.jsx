import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { CLASS_LEVELS, DEMO_SESSION, MEMBER_STATUS } from '../utils/constants.js';
import { academicYearOf, normalizeSchoolProfile } from '../utils/schoolProfile.js';
import { useAuth, buildSchoolRef, isCompleteSchoolRef, DEFAULT_ACTIVE_YEAR } from './AuthContext.jsx';
import {
  createInitialDataset,
  persistDataset,
  clearPersistedDataset,
  SCHEMA_VERSION,
  normalizeSessionYear,
  rememberSchoolLocation,
  subscribeStudents,
  subscribeResults,
  subscribeSchoolProfile,
  subscribeAllResultConfigs,
  saveClassResultConfig,
  resetClassResultConfig,
  saveSchoolProfile,
  syncSchoolProfileRegistry,
} from '../services/database/index.js';
import { normalizeResultConfig, defaultResultConfig } from '../utils/resultConfig.js';
import { useStudents } from '../hooks/useStudents.js';
import { useResults } from '../hooks/useResults.js';

/**
 * SchoolDataContext — the application's single store for pupils, marks, remarks,
 * notices and audit events.
 *
 * Design notes
 * ------------
 * 1. State is kept in ONE normalised-ish object so a whole-document write to
 *    localStorage / Firestore stays atomic and conflict-free.
 * 2. All mutations are expressed as pure reducers over that object, which makes
 *    them easy to replay, test, or mirror into a real backend later.
 * 3. Writes are debounced (400 ms) to avoid hammering storage while a teacher
 *    types through the spreadsheet grid.
 * 4. `syncState` reflects the offline-first behaviour: 'synced' | 'saving' | 'offline'.
 */

const SchoolDataContext = createContext(null);

const PERSIST_DEBOUNCE_MS = 800;

const nowISO = () => new Date().toISOString();
const emptyDataset = (schoolId = '') => ({
  meta: { schemaVersion: SCHEMA_VERSION, schoolId, session: DEMO_SESSION, updatedAt: nowISO() },
  students: [], marks: {}, remarks: {}, termRemarks: {}, notices: [], audits: [],
});

const makeId = (prefix) =>
  `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

const asRecord = (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const asList = (value) => Array.isArray(value) ? value.filter(Boolean) : [];
export function SchoolDataProvider({ children }) {
  const { user, schoolRef: authSchoolRef } = useAuth();
  const schoolId = user?.schoolId || '';
  const [schoolProfile, setSchoolProfile] = useState(() => normalizeSchoolProfile(user?.school || null));
  // The live profile can complete a tenant reference whose `schoolLocator` cache is
  // cold. An INCOMPLETE reference is reported as null so no caller can fall back to
  // the legacy `schoolData/{schoolId}` tree (requirement: hierarchical writes only).
  const schoolRef = useMemo(() => {
    const candidate = schoolId
      ? buildSchoolRef({ ...(user || {}), school: { ...schoolProfile, id: schoolId } })
      : authSchoolRef;
    return isCompleteSchoolRef(candidate) ? candidate : null;
  }, [authSchoolRef, user, schoolId, schoolProfile]);
  // Every read/write is addressed by the hierarchical tenant reference, never by a
  // bare school id, so nothing can land on the legacy `schoolData/{schoolId}` tree.
  const schoolRefKey = schoolRef
    ? `${schoolRef.divisionId}/${schoolRef.districtId}/${schoolRef.upazilaId}/${schoolRef.schoolId}`
    : '';
  const canWriteTenant = user?.role === 'super_admin' || (user?.role === 'school_admin' && user?.status === MEMBER_STATUS.APPROVED);
  // The profile's academic year is the partition key; `'2026'` is the app default.
  const activeYear = useMemo(
    () => normalizeSessionYear(academicYearOf(schoolProfile), DEFAULT_ACTIVE_YEAR),
    [schoolProfile],
  );
  const [dataset, setDataset] = useState(() => emptyDataset(schoolId));
  /**
   * Per-class Results configuration (subjects / full marks / গাঠনিক+সামষ্টিক split /
   * pass mark / annual weights), keyed by class id. It lives inside THIS school's own
   * year partition (`sessions/{year}/meta/resultConfig`), so no other school can read
   * or overwrite it. Defaults apply until the teacher saves a customisation.
   */
  const [resultConfigs, setResultConfigs] = useState({});
  const [syncState, setSyncState] = useState(() => (typeof navigator === 'undefined' || navigator.onLine ? 'synced' : 'offline'));
  const [isOnline, setIsOnline] = useState(() => (typeof navigator === 'undefined' ? true : navigator.onLine));
  /**
   * `true` while the ACTIVE school/year partition is still being read from the database
   * (first snapshot). A hard timeout guarantees it can never hang the UI, and a school
   * with no cloud reference is never left in the loading state.
   */
  const [hydrating, setHydrating] = useState(false);
  const hydrationTimer = useRef(null);

  const saveTimer = useRef(null);
  const lastSavedAt = useRef(null);
  const dirtyRef = useRef(new Set());
  const isRemoteUpdate = useRef(false);
  const localMutationVersion = useRef(0);
  const persistedMutationVersion = useRef(0);
  const activeSaveTimers = useRef(new Map());
  const saveSequence = useRef(0);
  const hydratedRef = useRef(new Set());
  const datasetRef = useRef(dataset);
  datasetRef.current = dataset;
  // Dataset state is per partition (`school@year`), the school profile is per school.
  const activePartitionRef = useRef(`${schoolRefKey}@${activeYear}`);
  const activeSchoolRef = useRef(schoolRefKey);

  /* ---------------------------------------------------------------- *
   * Tenant subscriptions — exactly ONE listener per schoolId.
   * The callbacks only *read* remote values into local state; they never
   * write back to RTDB, which is what previously caused the sync loop.
   * ---------------------------------------------------------------- */
  useEffect(() => {
    // The partition key is school + academic year: switching either one must drop
    // the previous partition's rows and re-subscribe to the new subtree. The
    // profile belongs to the SCHOOL, so a year switch must not clobber it (that
    // would feed back into `activeYear`, which is derived from the profile).
    const partitionKey = `${schoolRefKey}@${activeYear}`;
    if (activePartitionRef.current !== partitionKey) {
      activePartitionRef.current = partitionKey;
      dirtyRef.current.clear();
      localMutationVersion.current = 0;
      persistedMutationVersion.current = 0;
      setSyncState(typeof navigator === 'undefined' || navigator.onLine ? 'synced' : 'offline');
      setDataset(emptyDataset(schoolId));
      // A class configuration belongs to ONE year of ONE school: switching either must
      // never leave the previous partition's subjects/pass mark on screen.
      setResultConfigs({});
    }
    if (activeSchoolRef.current !== schoolRefKey) {
      activeSchoolRef.current = schoolRefKey;
      setSchoolProfile(normalizeSchoolProfile(user?.school || null));
    }
    if (!schoolRef || !schoolId || !canWriteTenant) {
      setHydrating(false);
      return undefined;
    }
    // Register the reference so every service helper (subtrees, profile, legacy
    // readers) resolves the same hierarchical base for this school.
    rememberSchoolLocation(schoolRef);
    const subscriptionKey = schoolRefKey;
    let studentsInitialized = false;
    let resultsInitialized = false;
    // Surface the first read as a real loading state, and never let a stalled listener
    // leave the screen spinning forever.
    setHydrating(true);
    if (hydrationTimer.current) clearTimeout(hydrationTimer.current);
    hydrationTimer.current = setTimeout(() => setHydrating(false), 6000);
    const markHydrated = () => {
      if (hydrationTimer.current) clearTimeout(hydrationTimer.current);
      hydrationTimer.current = null;
      setHydrating(false);
    };
    const unsubStudents = subscribeStudents(schoolRef, (snapshot) => {
      isRemoteUpdate.current = true;
      if (!studentsInitialized) markHydrated();

      const incoming = [...asList(snapshot?.students), ...asList(snapshot?.archive).map((student) => ({ ...student, classId: 'archive', status: 'archived' }))];
      setDataset((previous) => {
        const remote = incoming.length ? incoming : (!studentsInitialized ? previous.students : []);
        studentsInitialized = true;
        if (JSON.stringify(previous.students) === JSON.stringify(remote)) return previous;
        return { ...previous, students: remote, meta: { ...asRecord(previous.meta), schoolId } };
      });
    }, undefined, activeYear);
    const unsubResults = subscribeResults(schoolRef, (results) => {
      if (!results) return;
      isRemoteUpdate.current = true;
      if (!resultsInitialized) markHydrated();

      setDataset((previous) => {
        const marks = asRecord(results.marks);
        const remarks = asRecord(results.remarks);
        // Term-scoped remarks: `{ studentId: { term1|term2|annual: text } }`, so a
        // remark stays tied to its (year, class, term) snapshot.
        const termRemarks = asRecord(results.termRemarks);
        if (!resultsInitialized && !Object.keys(marks).length && !Object.keys(remarks).length) {
          resultsInitialized = true;
          return previous;
        }
        resultsInitialized = true;
        if (
          JSON.stringify(previous.marks) === JSON.stringify(marks)
          && JSON.stringify(previous.remarks) === JSON.stringify(remarks)
          && JSON.stringify(previous.termRemarks ?? {}) === JSON.stringify(termRemarks)
        ) return previous;
        return { ...previous, marks, remarks, termRemarks };
      });
    }, undefined, activeYear);
    const unsubProfile = subscribeSchoolProfile(schoolId, (profile) => {
      isRemoteUpdate.current = true;
      const normalized = normalizeSchoolProfile(profile);
      setSchoolProfile((previous) => {
        const next = { ...previous, ...normalized };
        if (JSON.stringify(previous) === JSON.stringify(next)) return previous;
        return next;
      });
    });
    // The class-wise Results configuration is a per-school node; a change saved on one
    // device is picked up live here (and purged when the year/school partition flips).
    const unsubConfigs = subscribeAllResultConfigs(schoolRef, activeYear, (configs) => {
      setResultConfigs(configs && typeof configs === 'object' ? configs : {});
    });
    hydratedRef.current.add(subscriptionKey);
    return () => {
      unsubStudents();
      unsubResults();
      unsubProfile();
      unsubConfigs();
      if (hydrationTimer.current) clearTimeout(hydrationTimer.current);
      hydrationTimer.current = null;
      hydratedRef.current.delete(subscriptionKey);
    };
  }, [schoolId, schoolRef, schoolRefKey, activeYear, canWriteTenant]);

  /* ---------------------------------------------------------------- *
   * Online / offline listener
   * ---------------------------------------------------------------- */
  useEffect(() => {
    const handleOnline = () => {
      setIsOnline(true);
      setSyncState(activeSaveTimers.current.size ? 'saving' : 'synced');
    };
    const handleOffline = () => {
      setIsOnline(false);
      setSyncState(activeSaveTimers.current.size ? 'saving' : 'offline');
    };
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  /* ---------------------------------------------------------------- *
   * Debounced persistence
   * ---------------------------------------------------------------- */
  useEffect(() => {
    // Remote snapshots are read-only: they must never schedule even a local
    // persistence write. The mutation version also handles batched snapshots.
    const scheduledVersion = localMutationVersion.current;
    if (scheduledVersion <= persistedMutationVersion.current) {
      if (isRemoteUpdate.current) isRemoteUpdate.current = false;
      return undefined;
    }
    isRemoteUpdate.current = false;

    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      const latestVersion = localMutationVersion.current;
      if (latestVersion <= persistedMutationVersion.current) return;
      const current = datasetRef.current;
      const payload = { ...current, meta: { ...current.meta, updatedAt: nowISO() } };
      const ok = persistDataset(payload);
      persistedMutationVersion.current = latestVersion;
      lastSavedAt.current = nowISO();
      // This debounced write is browser cache only and never sets the cloud badge
      // to "saving". Firebase writes happen only in explicit action handlers.
      if (!user?.schoolId && syncState !== 'saving') {
        setSyncState(ok ? (navigator.onLine ? 'synced' : 'offline') : 'error');
      }
    }, PERSIST_DEBOUNCE_MS);

    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    };
  }, [dataset]);

  /* ---------------------------------------------------------------- *
   * Generic mutator – every action funnels through this
   * ---------------------------------------------------------------- */
  const updateDataset = useCallback((recipe, auditEntry, dirtyKey = null) => {
    localMutationVersion.current += 1;
    if (dirtyKey) dirtyRef.current.add(dirtyKey);
    setDataset((prev) => {
      const next = recipe(prev) ?? prev;
      if (!auditEntry) return next;
      const entry = { id: makeId('audit'), at: nowISO(), ...auditEntry };
      return { ...next, audits: [entry, ...(next.audits ?? [])].slice(0, 200) };
    });
  }, []);

  // Only explicitly-invoked mutations enter the Saving state. The timeout keeps
  // a stalled Firebase request from leaving the badge spinning indefinitely; a
  // caller with a bigger payload (a whole class promotion) may pass a longer one.
  const runCloudSave = useCallback(async (operation, { timeoutMs = 3000 } = {}) => {
    const id = ++saveSequence.current;
    let timeoutId;
    const timedOut = new Promise((resolve) => {
      timeoutId = setTimeout(() => {
        activeSaveTimers.current.delete(id);
        setSyncState(activeSaveTimers.current.size ? 'saving' : (isOnline ? 'synced' : 'offline'));
        resolve({ synced: false, timedOut: true });
      }, Math.max(1000, Number(timeoutMs) || 3000));
    });
    activeSaveTimers.current.set(id, timeoutId);
    setSyncState('saving');
    let result = { synced: false };
    try {
      result = await Promise.race([Promise.resolve().then(operation), timedOut]);
      return result;
    } catch {
      result = { synced: false };
      return result;
    } finally {
      clearTimeout(activeSaveTimers.current.get(id));
      activeSaveTimers.current.delete(id);
      if (activeSaveTimers.current.size === 0) {
        // A timed-out request is a slow network, not a rejected write: it must never
        // leave the badge stuck on the red "সেভ ব্যর্থ হয়েছে" state. The same holds
        // for a save whose PRIMARY write succeeded while a non-critical secondary
        // write (`partial: true`) failed — the data the teacher saved is safe.
        const failed = result?.synced === false && !result?.timedOut && result?.partial !== true;
        setSyncState(failed && isOnline ? 'error' : (isOnline ? 'synced' : 'offline'));
      }
    }
  }, [isOnline]);

  /**
   * Explicitly clears a stale failed/saving state.
   *
   * The promotion flow uses this once its PRIMARY write has succeeded: a
   * non-critical secondary/legacy write (permanent identity, শাখা registry, audit
   * log, legacy mirror) must never leave the topbar showing "সেভ ব্যর্থ হয়েছে".
   */
  const markSynced = useCallback(() => {
    if (activeSaveTimers.current.size > 0) return;
    setSyncState(typeof navigator === 'undefined' || navigator.onLine ? 'synced' : 'offline');
  }, []);


  const saveProfile = useCallback(async (patch) => {
    if (!schoolId || !canWriteTenant) return { synced: false };
    const previousProfile = schoolProfile;
    const nextProfile = normalizeSchoolProfile({ ...previousProfile, ...patch }, previousProfile);
    const result = await runCloudSave(async () => {
      const profileResult = await saveSchoolProfile(schoolId, patch, { uid: user?.uid, name: user?.name });
      if (!profileResult?.synced) return profileResult;
      await syncSchoolProfileRegistry(schoolId, previousProfile, nextProfile);
      return profileResult;
    });
    if (result.synced) setSchoolProfile(nextProfile);
    return result;
  }, [schoolId, canWriteTenant, user?.uid, user?.name, schoolProfile, runCloudSave]);

  /* ---------------------------------------------------------------- *
   * Domain hooks — roster, marks and remarks live in dedicated hooks.
   * They receive the shared mutator primitives (updateDataset /
   * runCloudSave) so persistence and audit logging stay centralised.
   * ---------------------------------------------------------------- */
  const {
    studentsByClass,
    sectionCounts,
    sectionRegistry,
    getSectionsOfClass,
    getStudentsOfSection,
    getStudentsOfClass,
    getStudentById,
    addStudent,
    importStudents,
    updateStudent,
    archiveStudent,
    restoreStudent,
    removeStudent,
    setStudentRoll,
    addSection,
    renameSection,
    removeSection,
    executePromotion,
    advanceAcademicYear,
  } = useStudents({
    dataset,
    datasetRef,
    updateDataset,
    schoolId,
    schoolRef,
    activeYear,
    canWriteTenant,
    runCloudSave,
    markSynced,
  });

  const {
    getResultConfig,
    getStudentResult,
    getTermResult,
    getTabResult,
    getRemark,
    getClassRows,
    getClassAnalytics,
    getStudentClassRank,
    getClassRankMap,
    getSubjectEntry,
    setMark,
    setStudentMarks,
    applyTermMarks,
    applyImportedMarks,
    setRemark,
  } = useResults({
    dataset,
    datasetRef,
    updateDataset,
    schoolId,
    schoolRef,
    activeYear,
    canWriteTenant,
    runCloudSave,
    getStudentsOfClass,
    resultConfigs,
  });

  /* ---------------------------------------------------------------- *
   * Results configuration (per school / year / class)
   * ---------------------------------------------------------------- */

  /**
   * Saves ONE class's Results configuration inside the active school's own
   * namespace. The local state is updated optimistically so the grid re-calculates
   * instantly; the cloud result decides whether the sync badge shows a failure.
   */
  const saveResultConfig = useCallback(
    async (classId, config) => {
      const normalized = normalizeResultConfig(config, classId);
      if (!classId || !canWriteTenant || !schoolRef) return { synced: false };
      setResultConfigs((previous) => ({ ...previous, [classId]: normalized }));
      return runCloudSave(
        () => saveClassResultConfig(schoolRef, activeYear, classId, normalized),
        { timeoutMs: 8000 },
      );
    },
    [canWriteTenant, schoolRef, activeYear, runCloudSave],
  );

  /** Restores a class to the factory configuration (subjects + split + pass mark). */
  const resetResultConfig = useCallback(
    async (classId) => {
      if (!classId) return { synced: false };
      const fallback = defaultResultConfig(classId);
      setResultConfigs((previous) => ({ ...previous, [classId]: fallback }));
      if (!canWriteTenant || !schoolRef) return { synced: false };
      return runCloudSave(
        () => resetClassResultConfig(schoolRef, activeYear, classId),
        { timeoutMs: 8000 },
      );
    },
    [canWriteTenant, schoolRef, activeYear, runCloudSave],
  );


  /* ---------------------------------------------------------------- *
   * Notices & maintenance
   * ---------------------------------------------------------------- */
  const addNotice = useCallback(
    (notice) => {
      updateDataset(
        (prev) => ({
          ...prev,
          notices: [{ id: makeId('notice'), date: nowISO().slice(0, 10), tone: 'info', ...notice }, ...prev.notices],
        }),
        { action: 'notice.create', detail: notice?.title ?? 'নতুন নোটিশ', actor: 'school_admin' },
      );
    },
    [updateDataset],
  );

  const resetDemoData = useCallback(() => {
    clearPersistedDataset(schoolId);
    localMutationVersion.current += 1;
    const fresh = createInitialDataset();
    setDataset({ ...fresh, meta: { ...fresh.meta, schoolId } });
  }, [schoolId]);

  /** Clears the local workspace only — cloud data is never wiped implicitly. */
  const clearAllData = useCallback(() => {
    clearPersistedDataset(schoolId);
    localMutationVersion.current += 1;
    setDataset(emptyDataset(schoolId));
  }, [schoolId]);


  const summary = useMemo(() => {
    const active = dataset.students.filter((student) => student.classId !== 'archive');
    const archived = dataset.students.filter((student) => student.classId === 'archive');
    return {
      totalStudents: dataset.students.length,
      activeStudents: active.length,
      archivedStudents: archived.length,
      maleCount: active.filter((student) => student.gender === 'male').length,
      femaleCount: active.filter((student) => student.gender === 'female').length,
      classCount: CLASS_LEVELS.length,
      marksEntered: Object.keys(dataset.marks ?? {}).length,
      noticeCount: dataset.notices?.length ?? 0,
      session: dataset.meta?.session ?? DEMO_SESSION,
    };
  }, [dataset]);


  const value = useMemo(
    () => ({
      // raw state
      dataset,
      students: dataset.students,
      marks: dataset.marks,
      remarks: dataset.remarks,
      termRemarks: dataset.termRemarks ?? {},
      notices: dataset.notices ?? [],
      audits: dataset.audits ?? [],
      meta: dataset.meta,
      // active tenant identity (divisions/…/schools/{schoolId})
      schoolProfile,
      saveProfile,
      schoolId,
      schoolRef,
      activeYear,
      canWriteTenant,
      // sync status
      syncState,
      isOnline,
      isHydrating: hydrating,
      markSynced,
      // selectors
      studentsByClass,
      sectionCounts,
      sectionRegistry,
      summary,
      getSectionsOfClass,
      getStudentsOfSection,
      getStudentsOfClass,
      getStudentById,
      getResultConfig,
      getStudentResult,
      getTermResult,
      getTabResult,
      getClassRows,
      getClassAnalytics,
      getStudentClassRank,
      getClassRankMap,
      getSubjectEntry,
      getRemark,
      resultConfigs,
      saveResultConfig,
      resetResultConfig,
      // mutations
      importStudents,
      addStudent,
      updateStudent,
      removeStudent,
      archiveStudent,
      restoreStudent,
      setStudentRoll,
      addSection,
      renameSection,
      removeSection,
      setMark,
      setStudentMarks,
      applyImportedMarks,
      setRemark,
      executePromotion,
      advanceAcademicYear,
      addNotice,
      resetDemoData,
      clearAllData,
    }),
    [
      dataset,
      schoolProfile,
      saveProfile,
      schoolId,
      schoolRef,
      activeYear,
      canWriteTenant,
      syncState,
      isOnline,
      hydrating,
      markSynced,
      studentsByClass,
      sectionCounts,
      sectionRegistry,
      summary,
      getSectionsOfClass,
      getStudentsOfSection,
      getStudentsOfClass,
      getStudentById,
      getResultConfig,
      getStudentResult,
      getTermResult,
      getTabResult,
      getClassRows,
      getClassAnalytics,
      getStudentClassRank,
      getClassRankMap,
      getSubjectEntry,
      getRemark,
      resultConfigs,
      saveResultConfig,
      resetResultConfig,
      importStudents,
      addStudent,
      updateStudent,
      removeStudent,
      archiveStudent,
      restoreStudent,
      setStudentRoll,
      addSection,
      renameSection,
      removeSection,
      setMark,
      setStudentMarks,
      applyImportedMarks,
      setRemark,
      executePromotion,
      advanceAcademicYear,
      addNotice,
      resetDemoData,
      clearAllData,
    ],
  );

  return <SchoolDataContext.Provider value={value}>{children}</SchoolDataContext.Provider>;
}

export function useSchoolData() {
  const context = useContext(SchoolDataContext);
  if (!context) {
    throw new Error('useSchoolData must be used inside <SchoolDataProvider>.');
  }
  return context;
}

export default SchoolDataContext;

