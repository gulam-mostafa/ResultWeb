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
  readYearRoster,
} from '../services/database/index.js';
import { nextSessionYear } from '../services/database/sessionService.js';
import {
  normalizePromotionState,
  isClassPromotionComplete,
  completedClassIds,
  classStudentCounts,
  pendingPromotionClasses,
  isPromotionCompleteForYear,
  activationAfterPromotion,
  defaultPromotionClassId,
  classPromotionStatuses,
  isYearReadOnly,
  januaryStatus,
  buildAutoDecisions,
  destinationClassOf,
  subscribePromotionState,
  readPromotionState,
  markClassPromotionComplete,
  backfillMissingPromotionRecords,
  markAutoPromotionDone,
  undoClassPromotion as undoClassPromotionService,
  reactivateYear as reactivateYearService,
} from '../services/database/promotionService.js';
import { normalizeResultConfig, defaultResultConfig } from '../utils/resultConfig.js';
import { flushOfflineQueue, pendingOfflineCount } from '../services/database/dbFallback.js';
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
  const hydratingRef = useRef(false);
  hydratingRef.current = hydrating;

  /**
   * View year vs active year (বার্ষিক উত্তরণ):
   *
   * - `activeYear` is the school's WORKING year (`profile.academicYear`);
   * - `viewYear` is the year on screen. By default it follows the active year;
   *   picking another year in the Topbar pins the view there.
   * - Only a PAST year is read-only (`isReadOnly`): its work is finished, so
   *   it shows "কার্যক্রম সম্পূর্ণ" in black, colourless text and nothing in
   *   it can be edited. The active year AND any FUTURE year stay open and
   *   editable — the next year is where new work continues, so it must never
   *   be locked. Years compare as numbers, never as strings.
   *
   * `viewYearOverride === null` means "follow the active year". No year is ever
   * hard-coded here — the next year always derives from `activeYear`.
   */
  const [viewYearOverride, setViewYearOverride] = useState(null);
  const viewYear = viewYearOverride ?? activeYear;
  const setViewYear = useCallback((year) => {
    const next = normalizeSessionYear(year);
    // Picking the active year (or an empty value) clears the pin — the view
    // follows the school again instead of staying stuck on a stale year.
    setViewYearOverride(next && next !== activeYear ? next : null);
  }, [activeYear]);
  // When the active year moves onto the pinned year, the pin dissolves.
  useEffect(() => {
    if (viewYearOverride && viewYearOverride === activeYear) setViewYearOverride(null);
  }, [viewYearOverride, activeYear]);
  const isReadOnly = isYearReadOnly(viewYear, activeYear);
  const isReadOnlyRef = useRef(isReadOnly);
  isReadOnlyRef.current = isReadOnly;

  /**
   * One year's promotion log (`sessions/{activeYear}/meta/promotion`), live:
   * which classes are complete, when, by whom, and who moved where. The viewed
   * year never matters here — a past year is read-only at the year level
   * (`isReadOnly` blocks writes), while a class counts as locked only when
   * its own promotion is recorded complete.
   */
  const [promotionState, setPromotionState] = useState(() => normalizePromotionState(null));
  const [promotionStateLoaded, setPromotionStateLoaded] = useState(false);
  const promotionStateRef = useRef(promotionState);
  promotionStateRef.current = promotionState;
  const [autoPromotionNotice, setAutoPromotionNotice] = useState(null);
  const autoPromotionRanRef = useRef(false);

  /**
   * Promotion log of the year ON SCREEN. `viewedPromotionState` is subscribed
   * below whenever the viewed year differs from the active year; when the two
   * are the same year this is simply the active year's log. Class locks, the
   * modal's completion panels and the "X/৬ শ্রেণি সম্পূর্ণ" strip all read
   * THIS — never the active year's log directly — so a class promoted in the
   * viewed year stays locked there, and a class that only exists (open) in
   * the next year is never locked by the active year's log. The January
   * logic keeps reading the ACTIVE year's log only.
   */
  const [viewedPromotionState, setViewedPromotionState] = useState(() => normalizePromotionState(null));
  const [viewedPromotionStateLoaded, setViewedPromotionStateLoaded] = useState(false);
  const viewPromotionState = viewYear === activeYear ? promotionState : viewedPromotionState;

  /**
   * `true` when a class is frozen: ONLY when this class's year-end promotion
   * is recorded as complete in the VIEWED year's log. A class is NEVER locked
   * just because its year is past — the past year is read-only at the YEAR
   * level (`isReadOnly` blocks every write there), but the class itself
   * counts as locked only after its own promotion finishes. A promoted
   * class stays locked forever — the completion record is only ever removed
   * by the guarded undo (the Unlock button), never by a year change, a
   * reload, or the January auto-run. The archive pseudo-class is never
   * locked by promotion (its own rules apply).
   */
  const isClassLocked = useCallback((classId) => {
    if (!classId || classId === 'archive') return false;
    return isClassPromotionComplete(viewPromotionState, classId);
  }, [viewPromotionState]);
  const isClassLockedRef = useRef(isClassLocked);
  isClassLockedRef.current = isClassLocked;
  /** Writes are allowed only for a manager in the ACTIVE year. */
  const effectiveCanWriteTenant = canWriteTenant && !isReadOnly;

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
    // The partition key is school + VIEWED year: switching either one must drop
    // the previous partition's rows and re-subscribe to the new subtree. The
    // profile belongs to the SCHOOL, so a year switch must not clobber it (that
    // would feed back into `activeYear`, which is derived from the profile).
    const partitionKey = `${schoolRefKey}@${viewYear}`;
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
    }, undefined, viewYear);
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
    }, undefined, viewYear);
    const unsubProfile = subscribeSchoolProfile(schoolId, (profile) => {
      isRemoteUpdate.current = true;
      const normalized = normalizeSchoolProfile(profile);
      setSchoolProfile((previous) => {
        /**
         * An EMPTY snapshot must never erase a known profile. When the tenant's
         * profile node cannot be read (offline, a blocked/slow connection, a cold
         * cache) the service emits the empty template; merging that verbatim wiped
         * `academicYear`, which made the ACTIVE year unknown — and a past year then
         * silently looked like a FUTURE (editable) year. Blank values are therefore
         * ignored; a real edit always carries a value.
         */
        const patch = Object.fromEntries(
          Object.entries(normalized).filter(([, value]) => {
            if (value === undefined || value === null) return false;
            if (typeof value === 'string') return value.trim() !== '';
            return true;
          }),
        );
        if (!Object.keys(patch).length) return previous;
        const next = { ...previous, ...patch };
        if (JSON.stringify(previous) === JSON.stringify(next)) return previous;
        return next;
      });
    });
    // The class-wise Results configuration is a per-school node; a change saved on one
    // device is picked up live here (and purged when the year/school partition flips).
    const unsubConfigs = subscribeAllResultConfigs(schoolRef, viewYear, (configs) => {
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
  }, [schoolId, schoolRef, schoolRefKey, viewYear, canWriteTenant]);

  /* ---------------------------------------------------------------- *
   * Promotion state — one year's log, live from the ACTIVE year.
   * This subscription drives the January logic and the active-year locks,
   * and must never follow the viewed year. The location is remembered again
   * here so the promotion path resolves even if this effect runs first.
   * ---------------------------------------------------------------- */
  useEffect(() => {
    if (!schoolRef || !schoolId) {
      setPromotionState(normalizePromotionState(null));
      setPromotionStateLoaded(false);
      return undefined;
    }
    rememberSchoolLocation(schoolRef);
    return subscribePromotionState(schoolId, activeYear, (state) => {
      setPromotionState(state);
      setPromotionStateLoaded(true);
    });
  }, [schoolRef, schoolId, activeYear]);

  /* ---------------------------------------------------------------- *
   * Viewed-year promotion state — the log of the year ON SCREEN.
   * The active-year subscription above drives the January logic and must
   * never follow the viewed year; but the viewed year can be complete or
   * not (a year may have been left by creating a new year manually, or a
   * class may have been reopened by undo after the year advanced), and the
   * banner must say "কার্যক্রম সম্পূর্ণ" only when THIS year's promotion
   * really is complete. The same log also drives the viewed year's class
   * locks and the "X/৬ শ্রেণি সম্পূর্ণ" strip — a future year has its own
   * log, so its classes are never locked by the active year's log. A live
   * subscription keeps it honest if another device writes.
   * ---------------------------------------------------------------- */
  useEffect(() => {
    if (viewYear === activeYear || !schoolRef || !schoolId) {
      setViewedPromotionState(normalizePromotionState(null));
      setViewedPromotionStateLoaded(false);
      return undefined;
    }
    rememberSchoolLocation(schoolRef);
    return subscribePromotionState(schoolId, viewYear, (state) => {
      setViewedPromotionState(state);
      setViewedPromotionStateLoaded(true);
    });
  }, [schoolRef, schoolId, viewYear, activeYear]);

  /* ---------------------------------------------------------------- *
   * Online / offline listener
   * ---------------------------------------------------------------- */
  useEffect(() => {
    const handleOnline = () => {
      setIsOnline(true);
      setSyncState(activeSaveTimers.current.size ? 'saving' : 'synced');
      // Reconnect: replay the durable offline queue in insertion order, so a
      // save that failed while offline lands exactly once, in the order it was made.
      flushOfflineQueue().then((flushed) => {
        if (activeSaveTimers.current.size === 0) {
          setSyncState(flushed?.pending > 0 ? 'offline' : 'synced');
        }
      }).catch(() => {});
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
    // A past (locked) year is view-only: local mutations are refused at the
    // single funnel every action goes through, so no hook or page can write
    // into frozen history even if its button was missed. Remote snapshots use
    // `setDataset` directly and are unaffected by this gate.
    if (isReadOnlyRef.current) return;
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
  //
  // Honesty rules (a failed save must never look `synced`):
  //  - the underlying write runs through `safeUpdate`/`safeMultiPathUpdate`, which
  //    enqueue a failed write in the durable offline queue (`dbFallback.js`) and
  //    replay it in order on reconnect — `runCloudSave` never has to rebuild a
  //    payload it cannot see, it only has to report the outcome truthfully;
  //  - a TIMEOUT is not a failure and not a success: the write may still land, so
  //    the badge stays on 'saving' and the result carries `timedOut: true` (the
  //    caller keeps its optimistic state and says "সংরক্ষণ হচ্ছে…");
  //  - a definite failure (`synced: false`, not a timeout, not `partial`) leaves
  //    the badge on 'error' while online, so the caller can roll back.
  const runCloudSave = useCallback(async (operation, { timeoutMs = 3000 } = {}) => {
    const id = ++saveSequence.current;
    let timeoutId;
    let timedOut = false;
    const operationPromise = Promise.resolve().then(operation);
    // The write keeps running after a timeout — when it finally settles, the
    // badge is corrected from 'saving' to its real state (and any queued writes
    // are drained in order).
    const settleBadge = (settledResult) => {
      if (activeSaveTimers.current.size > 0) return;
      if (settledResult?.synced === false && settledResult?.partial !== true) {
        setSyncState(pendingOfflineCount() > 0 ? 'offline' : (isOnline ? 'error' : 'offline'));
        return;
      }
      if (pendingOfflineCount() > 0) {
        setSyncState('saving');
        flushOfflineQueue().then((flushed) => {
          if (activeSaveTimers.current.size === 0) {
            setSyncState(flushed?.pending > 0 ? 'offline' : (isOnline ? 'synced' : 'offline'));
          }
        }).catch(() => {});
        return;
      }
      setSyncState(isOnline ? 'synced' : 'offline');
    };
    operationPromise.then(
      (settledResult) => { if (timedOut) settleBadge(settledResult); },
      () => { if (timedOut) settleBadge({ synced: false }); },
    );
    const timedOutPromise = new Promise((resolve) => {
      timeoutId = setTimeout(() => {
        timedOut = true;
        activeSaveTimers.current.delete(id);
        // Unknown, not synced: stay on 'saving' until the write settles.
        setSyncState('saving');
        resolve({ synced: false, timedOut: true, pending: true });
      }, Math.max(1000, Number(timeoutMs) || 3000));
    });
    activeSaveTimers.current.set(id, timeoutId);
    setSyncState('saving');
    let result = { synced: false };
    try {
      result = await Promise.race([operationPromise, timedOutPromise]);
      return result;
    } catch {
      result = { synced: false };
      return result;
    } finally {
      clearTimeout(activeSaveTimers.current.get(id));
      activeSaveTimers.current.delete(id);
      if (activeSaveTimers.current.size === 0 && !timedOut) {
        // A timed-out request is a slow network, not a rejected write: it must never
        // leave the badge stuck on the red "সেভ ব্যর্থ হয়েছে" state. The same holds
        // for a save whose PRIMARY write succeeded while a non-critical secondary
        // write (`partial: true`) failed — the data the teacher saved is safe.
        const failed = result?.synced === false && result?.partial !== true;
        if (failed) {
          setSyncState(pendingOfflineCount() > 0 ? 'offline' : (isOnline ? 'error' : 'offline'));
        } else if (pendingOfflineCount() > 0) {
          setSyncState('saving');
          flushOfflineQueue().catch(() => {});
        } else {
          setSyncState(isOnline ? 'synced' : 'offline');
        }
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
    // The profile belongs to the school, but its `academicYear` IS the active
    // year — so in a read-only (past-year) view no profile write is allowed at
    // all. The one caller that changes the year (`advanceClassYear`) only runs
    // in the active view, where this gate is open.
    if (!schoolId || !canWriteTenant || isReadOnlyRef.current) return { synced: false };
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
    // The hooks read and write the VIEWED year; in a past year the effective
    // write right is off, so every cloud write is refused at the hook level
    // and every local write at the `updateDataset` gate above. The ONE
    // exception is a late promotion (a past year's pending class into the
    // ACTIVE year) — the hook needs the real active year to allow exactly
    // that, so it is passed separately and never changes what the hook reads.
    activeYear: viewYear,
    promotionActiveYear: activeYear,
    canWriteTenant: effectiveCanWriteTenant,
    runCloudSave,
    markSynced,
    isClassLocked,
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
    activeYear: viewYear,
    canWriteTenant: effectiveCanWriteTenant,
    runCloudSave,
    getStudentsOfClass,
    resultConfigs,
    isClassLocked,
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
      // A frozen class (or a past year) takes no configuration change.
      if (!classId || !canWriteTenant || !schoolRef || isReadOnly || isClassLocked(classId)) return { synced: false };
      setResultConfigs((previous) => ({ ...previous, [classId]: normalized }));
      return runCloudSave(
        () => saveClassResultConfig(schoolRef, viewYear, classId, normalized),
        { timeoutMs: 8000 },
      );
    },
    [canWriteTenant, schoolRef, viewYear, runCloudSave, isReadOnly, isClassLocked],
  );

  /** Restores a class to the factory configuration (subjects + split + pass mark). */
  const resetResultConfig = useCallback(
    async (classId) => {
      if (!classId) return { synced: false };
      // A frozen class (or a past year) takes no configuration change.
      if (isReadOnly || isClassLocked(classId)) return { synced: false };
      const fallback = defaultResultConfig(classId);
      setResultConfigs((previous) => ({ ...previous, [classId]: fallback }));
      if (!canWriteTenant || !schoolRef) return { synced: false };
      return runCloudSave(
        () => resetClassResultConfig(schoolRef, viewYear, classId),
        { timeoutMs: 8000 },
      );
    },
    [canWriteTenant, schoolRef, viewYear, runCloudSave, isReadOnly, isClassLocked],
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
    // Demo reset wipes the local workspace — never from a locked year.
    if (isReadOnlyRef.current) return;
    clearPersistedDataset(schoolId);
    localMutationVersion.current += 1;
    const fresh = createInitialDataset();
    setDataset({ ...fresh, meta: { ...fresh.meta, schoolId } });
  }, [schoolId]);

  /** Clears the local workspace only — cloud data is never wiped implicitly. */
  const clearAllData = useCallback(() => {
    if (isReadOnlyRef.current) return;
    clearPersistedDataset(schoolId);
    localMutationVersion.current += 1;
    setDataset(emptyDataset(schoolId));
  }, [schoolId]);


  /* ---------------------------------------------------------------- *
   * Annual promotion (বার্ষিক উত্তরণ) — one class at a time.
   * ---------------------------------------------------------------- */

  /**
   * Promotes ONE class into the next year.
   *
   * Steps:
   *  1. `advanceAcademicYear` moves the decided pupils into `sessions/{nextYear}`
   *     (never the profile year — `advanceProfileYear: false`);
   *  2. the completion is recorded under `sessions/{year}/meta/promotion`;
   *  3. when EVERY class is complete (a class with no active pupils counts as
   *     complete), the next year becomes the school's active year.
   *
   * The source year's students/results/attendance are never touched, history is
   * never deleted, and a class that is already complete is refused
   * (`already-complete`) — so the same promotion can never run twice.
   *
   * @returns {{synced, year, nextYear, promoted, graduated, retained, demoted,
   *   completionRecorded, yearActivated, yearComplete, reason?}}
   */
  const advanceClassYear = useCallback(async ({
    year: fromYear = activeYear,
    nextYear = '',
    decisions = [],
    fromClassId = '',
    auto = false,
  } = {}) => {
    const sourceYear = normalizeSessionYear(fromYear, activeYear);
    const targetYear = normalizeSessionYear(nextYear, nextSessionYear(sourceYear));
    const empty = {
      synced: false, year: sourceYear, nextYear: targetYear,
      promoted: 0, graduated: 0, retained: 0, demoted: 0,
      completionRecorded: false, yearActivated: false, yearComplete: false,
    };
    if (!schoolId || !sourceYear || !targetYear || targetYear === sourceYear) {
      return { ...empty, reason: 'invalid-target-year' };
    }
    if (!fromClassId || !CLASS_LEVELS.some((item) => item.id === fromClassId)) {
      return { ...empty, reason: 'invalid-class' };
    }
    // দেরিতে প্রমোশন: আগের সালের বাকি শ্রেণি এখনো প্রমোশন করা যাবে, যদি তার
    // গন্তব্য সালটাই সক্রিয় সাল হয় (যেমন ২০২৬ → ২০২৭, যখন ২০২৭ সক্রিয়)।
    // অন্য সব ক্ষেত্রে লক করা সালে প্রমোশন আগের মতোই বন্ধ থাকবে।
    const isLatePromotion = Number(sourceYear) < Number(activeYear) && targetYear === activeYear;
    if (!canWriteTenant || (isReadOnlyRef.current && !isLatePromotion)) return { ...empty, reason: 'read-only' };
    // The "already complete" guard must read the SOURCE year's log, not the
    // active year's: promoting a class in a viewed future year is refused
    // when THAT year already completed it, and is NOT refused because the
    // active year's same class happens to be complete.
    const sourceState = sourceYear === activeYear
      ? promotionStateRef.current
      : await readPromotionState(schoolId, sourceYear);
    if (isClassPromotionComplete(sourceState, fromClassId)) {
      return { ...empty, reason: 'already-complete' };
    }
    // 1. Move the roster. The profile year stays put on purpose — one class must
    //    never flip the whole school into the next year by itself.
    const result = await advanceAcademicYear({
      year: sourceYear,
      nextYear: targetYear,
      decisions,
      advanceProfileYear: false,
    });
    if (!result?.synced) return { ...result, completionRecorded: false, yearActivated: false, yearComplete: false };
    // 2. Record the completion: who moved, and exactly where each one landed.
    //    `moved` holds every pupil the promotion ENROLLED next year — promoted
    //    AND retained — because the store enrols both groups (retained pupils
    //    keep their class with a new roll), and the undo must delete exactly
    //    what the promotion wrote. `destinations` tells the undo where each
    //    one sits. Class-5 leavers are NOT enrolled next year — they are filed
    //    in `passedArchive`, so they live in `graduatedIds` only: the undo
    //    safety check requires every `moved` pupil to sit in the next-year
    //    roster, and a graduate would fail it as "missing".
    const isGraduatingClass = fromClassId === 'c5';
    const moved = [];
    const destinations = {};
    (decisions ?? []).forEach((decision) => {
      const id = String(decision?.studentMasterId ?? decision?.studentId ?? '').trim();
      if (!id) return;
      const promoted = decision?.action === 'promote';
      destinations[id] = promoted ? destinationClassOf(fromClassId) : fromClassId;
      if (!isGraduatingClass || !promoted) moved.push(id);
    });
    const graduatedIds = isGraduatingClass
      ? (decisions ?? []).filter((decision) => decision?.action === 'promote')
        .map((decision) => String(decision?.studentMasterId ?? decision?.studentId ?? '').trim())
        .filter(Boolean)
      : [];
    const recordResult = await runCloudSave(() => markClassPromotionComplete(schoolId, {
      year: sourceYear,
      classId: fromClassId,
      toYear: targetYear,
      promoted: result.promoted ?? moved.length,
      retained: result.retained ?? 0,
      graduated: result.graduated ?? graduatedIds.length,
      moved,
      graduatedIds,
      destinations,
      auto: auto === true,
      completedBy: user?.uid ?? '',
      completedByName: user?.name ?? '',
      completedByEmail: user?.email ?? '',
    }), { timeoutMs: 8000 });
    const completionRecorded = recordResult?.synced !== false;
    // 2b. মেরামত: পুরনো লেখার বাগে (classes নোড পুরোটা বদলে যেত) আগের শ্রেণিগুলোর
    // সম্পূর্ণ-রেকর্ড মুছে গিয়েছিল। পরের সালের রোস্টার দেখে সেই রেকর্ডগুলো
    // ফিরিয়ে আনো — যে শ্রেণির শিক্ষার্থী ইতিমধ্যে পরের সালে আছে অথচ রেকর্ড
    // নেই, তাদের রেকর্ড লিখে দাও। রেকর্ড আছে এমন শ্রেণি ছোঁয়া হয় না।
    // মেরামত ব্যর্থ হলেও প্রমোশন ব্যর্থ হবে না।
    try {
      await backfillMissingPromotionRecords(schoolId, {
        year: sourceYear,
        toYear: targetYear,
        by: { uid: user?.uid ?? '', name: user?.name ?? '', email: user?.email ?? '' },
      });
    } catch {
      // Repair is best-effort: the promotion itself already succeeded.
    }
    // 3. Fresh state, then: all six classes done ⇒ activate the next year. The
    //    class counts come from the CLOUD roster (authoritative); the local roster
    //    is only the fallback when that read comes back empty — a stale local
    //    roster must never activate the year while a class still has pupils.
    const freshState = await readPromotionState(schoolId, sourceYear);
    // Refresh the log that owns this promotion — the active year's log when
    // promoting the active year, the viewed year's log otherwise. Writing the
    // source year's state into the active year's slot would corrupt it.
    if (sourceYear === activeYear) setPromotionState(freshState);
    else setViewedPromotionState(freshState);
    let counts = {};
    try {
      const { students: sourceRoster } = await readYearRoster(schoolId, sourceYear);
      counts = classStudentCounts(sourceRoster);
    } catch {
      counts = {};
    }
    if (!Object.keys(counts).length) counts = classStudentCounts(datasetRef.current.students);
    // The activation rule lives in ONE tested helper: only the ACTIVE year may
    // advance, only when every class is complete or empty, and only into the next
    // year the promotion recorded (never a hard-coded year). Completing a future
    // year early must never skip it as the active year.
    const activation = activationAfterPromotion({
      sourceYear,
      activeYear,
      state: freshState,
      counts,
    });
    const yearComplete = activation.reason === 'year-complete'
      || isPromotionCompleteForYear(freshState, counts);
    let yearActivated = false;
    if (activation.activate) {
      const saved = await saveProfile({ academicYear: activation.targetYear });
      yearActivated = saved?.synced === true;
    }
    return { ...result, completionRecorded, yearActivated, yearComplete };
  }, [schoolId, activeYear, canWriteTenant, advanceAcademicYear, runCloudSave, saveProfile, user?.uid, user?.name, user?.email]);

  /**
   * Undoes ONE class's promotion (safe, standard): the next-year enrolments and
   * archive entries that promotion wrote are deleted, the pupils' permanent
   * identity rows point back at the source year, and the completion record is
   * removed. The active year is left exactly as it is. The service refuses with
   * a Bangla message when undoing would destroy newer data (new admission,
   * next-year marks/attendance, or an edited pupil).
   *
   * This is the ONLY way a promoted class ever reopens — nothing else in the
   * app removes a completion record: not a year change, not a reload, not the
   * January auto-run. A promoted class is locked forever unless the teacher
   * deliberately undoes it here, with the safety check.
   */
  const undoClassPromotion = useCallback(async (classId, year = activeYear) => {
    const sourceYear = normalizeSessionYear(year, activeYear);
    const targetYear = nextSessionYear(sourceYear);
    // আনলক (undo) লক করা সালেও চলবে — এটাই লক করা শ্রেণি ঠিক করার একমাত্র রাস্তা।
    // নতুন প্রমোশন advanceClassYear-এর read-only গেটেই আটকায়; এখানে শুধু
    // সার্ভিসের নিজের নিরাপত্তা যাচাই (পরের সালে ভর্তি/নম্বর/উপস্থিতি) প্রযোজ্য।
    if (!schoolId || !classId || !canWriteTenant) {
      return { synced: false, reason: 'read-only' };
    }
    // The actor travels with the undo so the promotion log records WHO unlocked
    // this class and WHEN (`meta/promotion/unlocks/{classId}`): name + email + uid.
    const actor = { uid: user?.uid ?? '', name: user?.name ?? '', email: user?.email ?? '', role: user?.role ?? '' };
    const result = await runCloudSave(
      () => undoClassPromotionService(schoolId, { year: sourceYear, nextYear: targetYear, classId, actor }),
      { timeoutMs: 15000 },
    );
    if (result?.synced) {
      // Refresh the log that owned this promotion — the active year's log when
      // undoing the active year, the viewed year's log otherwise.
      if (sourceYear === activeYear) setPromotionState(await readPromotionState(schoolId, sourceYear));
      else setViewedPromotionState(await readPromotionState(schoolId, sourceYear));
    }
    return result;
  }, [schoolId, activeYear, canWriteTenant, runCloudSave, user?.uid, user?.name, user?.email, user?.role]);

  /**
   * Reactivates a year (Topbar year form): the year becomes active, and if it
   * was LOCKED, every completed class of that year goes back to "বাকি" —
   * exactly like before any promotion, nothing stays locked. The unlock is
   * best-effort: a failed unlock never blocks the activation itself.
   */
  const reactivateYear = useCallback(async (year) => {
    const yearKey = normalizeSessionYear(year, activeYear);
    if (!schoolId || !yearKey || !canWriteTenant) return { synced: false, unlocked: [] };
    const actor = { uid: user?.uid ?? '', name: user?.name ?? '', email: user?.email ?? '', role: user?.role ?? '' };
    const result = await runCloudSave(
      () => reactivateYearService(schoolId, { year: yearKey, actor }),
      { timeoutMs: 15000 },
    );
    if (result?.synced) {
      const fresh = await readPromotionState(schoolId, yearKey);
      if (yearKey === activeYear) setPromotionState(fresh);
      else setViewedPromotionState(fresh);
    }
    return result ?? { synced: false, unlocked: [] };
  }, [schoolId, activeYear, canWriteTenant, runCloudSave, user?.uid, user?.name, user?.email, user?.role]);

  /** Classes still waiting for promotion (with pupils, no completion record). */
  const promotionPending = useMemo(
    () => pendingPromotionClasses(promotionState, classStudentCounts(dataset.students)),
    [promotionState, dataset.students],
  );
  /** Class ids whose promotion is recorded as complete, in school order. */
  const promotionCompleted = useMemo(
    () => completedClassIds(promotionState),
    [promotionState],
  );

  /**
   * The same two lists for the year ON SCREEN (the "X/৬ শ্রেণি সম্পূর্ণ" strip
   * and the modal read these). The counts come from the viewed partition's
   * roster, so they always describe the year on screen — never the active
   * year's log mixed with another year's roster.
   */
  const viewPromotionPending = useMemo(
    () => pendingPromotionClasses(viewPromotionState, classStudentCounts(dataset.students)),
    [viewPromotionState, dataset.students],
  );
  const viewPromotionCompleted = useMemo(
    () => completedClassIds(viewPromotionState),
    [viewPromotionState],
  );
  /**
   * The six class rows of the year ON SCREEN for the promotion modal
   * (`{ classId, name, complete, pending, students }`, school order) and the class
   * the modal opens on — the FIRST unpromoted class, falling back to the last one
   * once everything is done. Both come from ONE pure helper so the dropdown, the
   * status list and the default selection can never disagree.
   */
  const viewClassPromotionStatuses = useMemo(
    () => classPromotionStatuses(viewPromotionState, dataset.students),
    [viewPromotionState, dataset.students],
  );
  const viewPromotionDefaultClassId = useMemo(
    () => defaultPromotionClassId(viewPromotionState, classStudentCounts(dataset.students)),
    [viewPromotionState, dataset.students],
  );

  /**
   * `true` when the VIEWED year's promotion is fully complete — every class
   * complete or empty. Only then may the read-only banner say "কার্যক্রম
   * সম্পূর্ণ"; an incomplete viewed year keeps the plain locked wording.
   * The counts come from the viewed partition's roster (`dataset` follows
   * `viewYear`), so an empty class counts as complete, exactly like the
   * active-year rule. Unknown (not loaded yet) never claims complete.
   */
  const isViewYearComplete = useMemo(() => {
    if (viewYear === activeYear) {
      return promotionStateLoaded && isPromotionCompleteForYear(promotionState, classStudentCounts(dataset.students));
    }
    return viewedPromotionStateLoaded && isPromotionCompleteForYear(viewedPromotionState, classStudentCounts(dataset.students));
  }, [viewYear, activeYear, promotionState, viewedPromotionState, promotionStateLoaded, viewedPromotionStateLoaded, dataset.students]);

  /**
   * January warning for the Dashboard and the Promotion page: in January of the
   * target year ("promote now or it will happen automatically after 31 January"),
   * and it stays visible past 31 January while classes are still pending (the
   * auto-run below should have taken them — if it could not, the teacher must).
   * `null` when there is nothing to warn about.
   */
  const januaryWarning = useMemo(() => {
    // The warning belongs to the ACTIVE year only: its pending list is built
    // from the active year's log + roster, so it must never be computed while
    // another year's roster is on screen.
    if (viewYear !== activeYear) return null;
    if (!promotionStateLoaded) return null;
    const status = januaryStatus(activeYear);
    if (!status.isWarningMonth && !status.isAutoDue) return null;
    if (!promotionPending.length) return null;
    return { ...status, pendingClasses: promotionPending, pendingCount: promotionPending.length };
  }, [viewYear, promotionStateLoaded, promotionState, activeYear, promotionPending]);

  /* ---------------------------------------------------------------- *
   * January auto-promotion — once per session, on load.
   *
   * When 31 January of the target year has passed and classes are still
   * pending, they are promoted with the SAME rule as the manual flow
   * (annual result pass ⇒ উত্তীর্ণ, anything else ⇒ এই ক্লাসেই থাকুক) from
   * the live consolidated result. Idempotent: a class that is already
   * complete is refused by `advanceClassYear`, and the run is marked done
   * (`promotion.auto`) only when every pending class succeeded — a failed
   * class retries on the next app load instead of being forgotten.
   * ---------------------------------------------------------------- */
  useEffect(() => {
    if (autoPromotionRanRef.current) return;
    if (!promotionStateLoaded || hydrating) return;
    if (!schoolId || !schoolRef || !canWriteTenant) return;
    if (isReadOnly) return;
    // The auto-run belongs to the ACTIVE year only: its pending list and its
    // decisions are built from the active year's roster. Running it while
    // another year's roster is on screen would promote the wrong pupils.
    if (viewYear !== activeYear) return;
    const status = januaryStatus(activeYear);
    if (!status.isAutoDue) return;
    if (promotionState.auto) return;
    const pending = pendingPromotionClasses(promotionState, classStudentCounts(dataset.students));
    if (!pending.length) return;
    autoPromotionRanRef.current = true;
    (async () => {
      const done = [];
      const failed = [];
      for (const classId of pending) {
        const decisions = buildAutoDecisions(
          dataset.students.filter((student) => student.classId === classId),
          (student) => getStudentResult(student.id)?.isPass === true,
        );
        const result = await advanceClassYear({
          year: activeYear,
          nextYear: status.targetYear,
          decisions,
          fromClassId: classId,
          auto: true,
        });
        if (result?.synced) done.push(classId);
        else failed.push(classId);
      }
      if (failed.length === 0) {
        await markAutoPromotionDone(schoolId, activeYear, user?.uid ?? 'system');
      }
      setPromotionState(await readPromotionState(schoolId, activeYear));
      setAutoPromotionNotice({ at: nowISO(), done, failed, targetYear: status.targetYear });
    })().catch(() => {});
  }, [
    promotionStateLoaded, hydrating, schoolId, schoolRef, canWriteTenant, isReadOnly,
    viewYear, activeYear, promotionState, dataset.students, getStudentResult, advanceClassYear, user?.uid,
  ]);


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
      // viewed year vs active year (বার্ষিক উত্তরণ)
      viewYear,
      setViewYear,
      isReadOnly,
      isClassLocked,
      isViewYearComplete,
      // annual promotion state
      promotionState,
      promotionPending,
      promotionCompleted,
      viewPromotionState,
      viewPromotionPending,
      viewPromotionCompleted,
      januaryWarning,
      autoPromotionNotice,
      advanceClassYear,
      viewClassPromotionStatuses,
      viewPromotionDefaultClassId,
      undoClassPromotion,
      reactivateYear,
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
      viewYear,
      setViewYear,
      isReadOnly,
      isClassLocked,
      promotionState,
      promotionPending,
      promotionCompleted,
      viewPromotionState,
      viewPromotionPending,
      viewPromotionCompleted,
      januaryWarning,
      autoPromotionNotice,
      advanceClassYear,
      viewClassPromotionStatuses,
      viewPromotionDefaultClassId,
      undoClassPromotion,
      reactivateYear,
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

