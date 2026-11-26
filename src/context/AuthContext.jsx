import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { MEMBER_STATUS, ROLES, STORAGE_KEYS } from '../utils/constants.js';
import { createSession, readSession, persistSession, clearSession, landingRouteFor, verifyEmisCredentials } from '../services/authService.js';
import { ensureSchoolProfile, readSchoolProfile } from '../services/database/schoolProfileService.js';
import { readMember, registerMember, subscribeMembers } from '../services/database/memberService.js';
import {
  DEMO_SCHOOL_LOCATION,
  addSchool,
  buildSchoolId,
  ensureDemoSchool,
  getSchool,
} from '../services/database/schoolRegistryService.js';
import { resolveSchoolLocation, hydrateSchoolLocation, rememberSchoolLocation } from '../services/database/dbPaths.js';
import { readJSON as readCache, writeJSON as writeCache } from '../services/storageService.js';

const AuthContext = createContext(null);

/** Academic year every tenant is partition-keyed by when nothing else is known. */
export const DEFAULT_ACTIVE_YEAR = '2026';

/**
 * Demo/bypass tools are OFF unless the environment explicitly opts in.
 *
 * Enable with either `VITE_ENABLE_DEMO_LOGIN=true` (build env) or a `?demo=1` query
 * flag. Nothing in the production UI can therefore open a bypass admin session by
 * accident, and every demo entry point shows a Bangla confirmation first.
 */
export function isDemoLoginEnabled() {
  const envFlag = String(import.meta.env?.VITE_ENABLE_DEMO_LOGIN ?? '').toLowerCase();
  if (envFlag === '1' || envFlag === 'true') return true;
  if (typeof window === 'undefined') return false;
  try {
    return new URLSearchParams(window.location.search).get('demo') === '1';
  } catch {
    return false;
  }
}

/**
 * The seeded demo tenant, re-exported so every consumer (Demo / Bypass login,
 * demo-student seeding, hooks) shares ONE quadruple:
 * `{ divisionId: 'dhaka', districtId: 'gazipur', upazilaId: 'gazipur-sadar', schoolId: 'demo-school-01' }`.
 */
export { DEMO_SCHOOL_LOCATION };

/** Name of the seeded demo tenant (only used when it has to be created). */
const DEMO_SCHOOL_NAME = 'আদর্শ সরকারি প্রাথমিক বিদ্যালয় (ডেমো)';

/** First non-blank value (a blank edit never erases a known tenant field). */
const firstFilled = (...values) => {
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value !== undefined && value !== null && String(value).trim() !== '') return String(value).trim();
  }
  return '';
};

/**
 * Memoise references per quadruple: the database services key their caches
 * (`readStudentMasterIndex`, result/attendance year memos) by this object.
 */
const schoolRefCache = new Map();

/**
 * Canonical tenant reference used by every database path:
 * `divisions/{divisionId}/districts/{districtId}/upazilas/{upazilaId}/schools/{schoolId}`.
 *
 * Always returns a complete quadruple: a real school's own ids win, the
 * `schoolLocator/{schoolId}` cache is consulted next, and demo / bypass logins
 * fall back to the seeded demo school so a write never reaches a half-built path.
 */
export function buildSchoolRef(user = null) {
  const profile = user?.school && typeof user.school === 'object' ? user.school : {};
  const schoolId = firstFilled(user?.schoolId, profile.id, profile.schoolId);
  const cached = schoolId ? resolveSchoolLocation(schoolId) : null;
  // The demo quadruple is only a default for the demo tenant; a real school must
  // never be filed under the demo upazila just because its profile is incomplete.
  const demo = !schoolId || schoolId === DEMO_SCHOOL_LOCATION.schoolId ? DEMO_SCHOOL_LOCATION : null;
  const ref = {
    divisionId: firstFilled(user?.divisionId, profile.divisionId, cached?.divisionId, demo?.divisionId),
    districtId: firstFilled(user?.districtId, profile.districtId, cached?.districtId, demo?.districtId),
    upazilaId: firstFilled(user?.upazilaId, profile.upazilaId, cached?.upazilaId, demo?.upazilaId),
    schoolId: firstFilled(schoolId, cached?.schoolId, DEMO_SCHOOL_LOCATION.schoolId),
  };
  const key = `${ref.divisionId}/${ref.districtId}/${ref.upazilaId}/${ref.schoolId}`;
  const memo = schoolRefCache.get(key);
  if (memo) return memo;
  // Older path helpers (`dbPaths.workspace`, `dbPaths.results`, `dbPaths.attendanceDay`,
  // `dbPaths.sessionStudents`, …) still take a bare id and run it through `String()`.
  // Without this the reference would stringify to "[object Object]" and point at a
  // non-existent node; with it every helper keeps addressing the same school.
  // The property is a function, so `JSON.stringify` (session cache) ignores it.
  ref.toString = () => ref.schoolId;
  schoolRefCache.set(key, ref);
  return ref;
}

/** True only when all four hierarchy segments are present (a write-safe reference). */
export function isCompleteSchoolRef(reference) {
  return Boolean(
    reference
    && String(reference.divisionId ?? '').trim()
    && String(reference.districtId ?? '').trim()
    && String(reference.upazilaId ?? '').trim()
    && String(reference.schoolId ?? '').trim(),
  );
}

/** Stamps the valid `schoolRef` (and its flat fields) onto a session. */
function stampSession(session) {
  if (!session?.user) return session;
  const schoolRef = buildSchoolRef(session.user);
  const isSuperAdmin = session.user.role === ROLES.SUPER_ADMIN;
  return {
    ...session,
    schoolRef,
    user: {
      ...session.user,
      divisionId: schoolRef.divisionId,
      districtId: schoolRef.districtId,
      upazilaId: schoolRef.upazilaId,
      // A super admin browses many schools and must keep its "no tenant" scope.
      schoolId: isSuperAdmin ? (session.user.schoolId ?? null) : (session.user.schoolId || schoolRef.schoolId),
    },
  };
}

export function AuthProvider({ children }) {
  // A restored session may predate the hierarchical paths, so it is stamped too.
  const [session, setSession] = useState(() => stampSession(readSession()));
  const [status, setStatus] = useState('idle');
  const [error, setError] = useState(null);
  const user = session?.user ?? null;
  // Bumped when a real school's `schoolLocator` pointer arrives, so the memoised
  // `schoolRef` below re-resolves to the full hierarchical quadruple.
  const [locationVersion, setLocationVersion] = useState(0);

  /**
   * Requirement: every signed-in user — including Demo / Bypass Login — always has a
   * complete `{ divisionId, districtId, upazilaId, schoolId }` reference. Demo has
   * static ids; a real school is completed from `schoolLocator/{schoolId}`.
   */
  useEffect(() => {
    if (!user?.schoolId || user.role === ROLES.SUPER_ADMIN) return undefined;
    if (user.divisionId && user.districtId && user.upazilaId) return undefined;
    let active = true;
    hydrateSchoolLocation(user.schoolId)
      .then((location) => {
        if (!active || !location) return;
        setSession((current) => (current?.user?.schoolId === user.schoolId
          ? stampSession({ ...current, user: { ...current.user, ...location } })
          : current));
        setLocationVersion((version) => version + 1);
      })
      .catch(() => {});
    return () => { active = false; };
  }, [user?.schoolId, user?.role, user?.divisionId, user?.districtId, user?.upazilaId]);

  useEffect(() => { if (session) persistSession(session); }, [session]);

  useEffect(() => {
    if (user?.role !== ROLES.SCHOOL_ADMIN || !user.schoolId || !user.uid || user.isBypass) return undefined;
    const cached = readCache(STORAGE_KEYS.MEMBERSHIP, null);
    if (cached?.schoolId === user.schoolId && cached?.uid === user.uid) {
      setSession((current) => (current?.user?.uid === user.uid
        ? stampSession({ ...current, user: { ...current.user, ...cached.member } })
        : current));
    }
    return subscribeMembers(user.schoolId, (members) => {
      const member = members?.[user.uid];
      if (!member) return;
      writeCache(STORAGE_KEYS.MEMBERSHIP, { schoolId: user.schoolId, uid: user.uid, member });
      setSession((current) => {
        if (current?.user?.uid !== user.uid) return current;
        const nextUser = {
          ...current.user,
          ...member,
          role: current.user.role,
          schoolId: current.user.schoolId,
        };
        if (JSON.stringify(nextUser) === JSON.stringify(current.user)) return current;
        return stampSession({ ...current, user: nextUser });
      });
    });
  }, [user?.role, user?.schoolId, user?.uid, user?.isBypass]);

  const signInWithRole = useCallback((role, overrides) => {
    setError(null);
    try {
      const next = stampSession(createSession(role, overrides));
      if (!next) return { ok: false, message: 'অ্যাকাউন্ট পাওয়া যায়নি।' };
      // A demo / student login can carry no school id at all: the ref then resolves to
      // the seeded demo tenant, so it is seeded into the hierarchy here too.
      const ref = next.schoolRef;
      if (ref?.schoolId === DEMO_SCHOOL_LOCATION.schoolId) {
        rememberSchoolLocation(ref);
        ensureDemoSchool({ name: DEMO_SCHOOL_NAME }).catch(() => {});
      } else if (ref && isCompleteSchoolRef(ref)) {
        rememberSchoolLocation(ref);
      }
      setSession(next);
      setStatus('authenticated');
      return { ok: true, session: next, redirectTo: landingRouteFor(role) };
    } catch {
      setStatus('error');
      setError('লগইন করতে সমস্যা হয়েছে। আবার চেষ্টা করুন।');
      return { ok: false, message: 'লগইন ব্যর্থ হয়েছে।' };
    }
  }, []);

  // NOTE (2026-11-27): the passwordless `bypassLogin()` ("1-Click Bypass Admin
  // Login") was REMOVED entirely — it fabricated an approved founder-admin
  // session (`bypass-founder-admin`) without any credential. Admin access now
  // requires a real Firebase account + membership of the school (see
  // `signInTeacher`, which refuses unknown members). The demo-school seed
  // (`ensureDemoSchool`) is still used by the normal demo sign-in path in
  // `signInWithRole`; `isDemoLoginEnabled()` is kept for the demo-student
  // seeding gate only.

  const signInTeacher = useCallback(async ({ school, uid, email, identity }) => {
    if (!school?.id || !uid) return { ok: false, message: 'বিদ্যালয় ও অ্যাকাউন্ট তথ্য প্রয়োজন।' };
    setStatus('authenticating');
    setError(null);
    try {
      const member = await readMember(school.id, uid);
      const profile = await readSchoolProfile(school.id);
      // NO auto-approve fallback: a Firebase account that is not a member of THIS school
      // must be told so. Inventing an approved row here used to grant full mark-entry
      // rights to any signed-in stranger.
      if (!member || member.isDeleted === true) {
        setStatus('error');
        return {
          ok: false,
          message: 'এই বিদ্যালয়ে আপনার শিক্ষক অ্যাকাউন্ট পাওয়া যায়নি। প্রতিষ্ঠাতা অ্যাডমিনের কাছে অনুমোদনের আবেদন করুন।',
        };
      }
      if (member.status === MEMBER_STATUS.REJECTED) {
        setStatus('error');
        return { ok: false, message: 'আপনার আবেদন বাতিল করা হয়েছে — প্রতিষ্ঠানের সঙ্গে যোগাযোগ করুন।' };
      }
      const next = createSession(ROLES.SCHOOL_ADMIN, {
        ...member,
        uid,
        id: uid,
        email: email || member.email || '',
        role: ROLES.SCHOOL_ADMIN,
        schoolId: school.id,
        schoolName: profile?.name || school.name || '',
        divisionId: profile?.divisionId || school.divisionId || '',
        districtId: profile?.districtId || school.districtId || '',
        upazilaId: profile?.upazilaId || school.upazilaId || '',
      });
      next.school = profile;
      const stamped = stampSession(next);
      setSession(stamped);
      setStatus('authenticated');
      return {
        ok: true,
        session: stamped,
        redirectTo: member.status === MEMBER_STATUS.APPROVED ? '/dashboard' : '/pending-approval',
      };
    } catch {
      setStatus('error');
      return { ok: false, message: 'লগইন সম্পন্ন করা যায়নি; আবার চেষ্টা করুন।' };
    }
  }, []);

  /**
   * Teacher / founder sign-up.
   *
   * A brand-new school is created **before** the session is issued, and every write
   * lands on the hierarchical, year-partitioned tree (see `addSchool`):
   * `schoolIndex/…` ➔ `divisions/…/schools/{schoolId}/profile` ➔
   * `divisions/…/schools/{schoolId}/teachers/{uid}` ➔ `users/{uid}`.
   *
   * Only a **join** attempt against a school that does not exist reports
   * “বিদ্যালয়ের তথ্য পাওয়া যায়নি”; creating a new school can never raise it.
   */
  const registerTeacher = useCallback(async ({ school, name, designation, location, isNewSchool = false, uid: providedUid, email, phone }) => {
    const fullName = String(name ?? '').trim();
    if (!fullName) return { ok: false, message: 'পূর্ণ নাম লিখুন।' };
    const geo = {
      divisionId: String(location?.divisionId ?? school?.divisionId ?? '').trim(),
      districtId: String(location?.districtId ?? school?.districtId ?? '').trim(),
      upazilaId: String(location?.upazilaId ?? school?.upazilaId ?? '').trim(),
    };
    const schoolName = String(school?.name ?? '').trim();
    const creating = isNewSchool === true || !String(school?.id ?? '').trim();
    const schoolId = String(school?.id ?? '').trim() || buildSchoolId(geo, schoolName);
    if (!schoolId) return { ok: false, message: 'নতুন বিদ্যালয়ের নাম লিখুন।' };
    // A canonical path needs all four segments — otherwise the school cannot be filed.
    if (!geo.divisionId || !geo.districtId || !geo.upazilaId) {
      return { ok: false, message: 'বিভাগ, জেলা ও উপজেলা নির্বাচন করুন।' };
    }

    setStatus('authenticating');
    setError(null);
    try {
      const uid = providedUid || `teacher-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      const schoolRef = { ...geo, schoolId };
      // Prime the location cache so every helper addresses the hierarchical nodes.
      rememberSchoolLocation(schoolRef);

      let record = { ...(school ?? {}), id: schoolId, name: schoolName, ...geo };
      let founderGranted = false;
      if (creating) {
        // Steps (a)…(d) run in order inside `addSchool`; the founder membership is
        // only written once the school itself is addressable.
        const registered = await addSchool({ ...geo, ...(location ?? {}) }, {
          id: schoolId,
          name: schoolName,
          emisCode: school?.emisCode ?? '',
          villageOrUnion: school?.villageOrUnion ?? school?.village ?? '',
          activeYear: DEFAULT_ACTIVE_YEAR,
          createdBy: fullName,
          founder: { uid, name: fullName, designation, email, phone },
        });
        if (!registered?.school?.id) {
          // No school id ⇒ the hierarchy was incomplete; nothing was written.
          return { ok: false, message: 'বিভাগ, জেলা, উপজেলা ও বিদ্যালয়ের নাম পূরণ করুন।' };
        }
        record = registered.school;
        founderGranted = Boolean(registered.founder);
      } else {
        // Joining an EXISTING school: it must actually exist, otherwise the user is
        // told the school could not be found (the only place that message belongs).
        const existing = await getSchool(geo, schoolId);
        const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
        if (!existing && !offline) {
          return { ok: false, message: 'বিদ্যালয়ের তথ্য পাওয়া যায়নি; আবার চেষ্টা করুন।' };
        }
        if (existing?.isDeleted === true) {
          return { ok: false, message: 'বিদ্যালয়ের তথ্য পাওয়া যায়নি; আবার চেষ্টা করুন।' };
        }
        record = { ...record, ...(existing ?? {}) };
      }

      // A brand-new school already has its Founder & Admin record (step c) plus the
      // `users/{uid}` pointer (step d) — re-registering would demote it to pending,
      // so when the founder write succeeded the membership object is built locally.
      let member;
      if (creating && founderGranted) {
        member = {
          uid, name: fullName, designation: designation || 'সহকারী শিক্ষক',
          email: email || '', phone: phone || '',
          role: ROLES.SCHOOL_ADMIN, schoolId, schoolName,
          ...schoolRef,
          status: MEMBER_STATUS.APPROVED,
          isFounder: true, isAdmin: true, canApprove: true, isDeleted: false,
        };
      } else {
        const result = await registerMember(
          schoolId,
          { uid, name: fullName, designation: designation || 'সহকারী শিক্ষক', email: email || '', phone: phone || '', schoolId, schoolName, ...schoolRef },
          { founder: creating },
        );
        if (!result?.member) throw new Error('membership registration failed');
        member = result.member;
        if (member.isFounder) {
          // A founder re-joining their own school: keep the profile/locator fresh.
          await ensureSchoolProfile(schoolId, {
            ...record,
            villageOrUnion: record.villageOrUnion || record.village || '',
            academicYear: record.academicYear || DEFAULT_ACTIVE_YEAR,
          });
        }
      }
      const profile = await readSchoolProfile(schoolId);
      const next = createSession(ROLES.SCHOOL_ADMIN, {
        ...member, uid, id: uid, role: ROLES.SCHOOL_ADMIN,
        name: fullName, designation: designation || 'সহকারী শিক্ষক',
        schoolId, schoolName: profile?.name || record.name || schoolName,
        ...schoolRef,
      });
      next.school = profile;
      writeCache(STORAGE_KEYS.MEMBERSHIP, { schoolId, uid, member });
      const stamped = stampSession(next);
      setSession(stamped);
      setStatus('authenticated');
      return { ok: true, session: stamped, redirectTo: member.status === MEMBER_STATUS.APPROVED ? '/dashboard' : '/pending-approval' };
    } catch {
      setStatus('error');
      setError('শিক্ষক নিবন্ধন সম্পন্ন করা যায়নি।');
      return { ok: false, message: 'নিবন্ধন সম্পন্ন করা যায়নি; আবার চেষ্টা করুন।' };
    }
  }, []);

  const refreshMembership = useCallback(async () => {
    const currentUser = session?.user;
    if (!currentUser?.schoolId || !currentUser?.uid) return null;
    const member = await readMember(currentUser.schoolId, currentUser.uid);
    if (member) {
      writeCache(STORAGE_KEYS.MEMBERSHIP, { schoolId: currentUser.schoolId, uid: currentUser.uid, member });
      setSession((current) => {
        if (current?.user?.uid !== currentUser.uid) return current;
        const nextUser = { ...current.user, ...member, role: current.user.role, schoolId: current.user.schoolId };
        return JSON.stringify(nextUser) === JSON.stringify(current.user)
          ? current
          : stampSession({ ...current, user: nextUser });
      });
    }
    return member;
  }, [session?.user?.schoolId, session?.user?.uid]);

  const verifySchool = useCallback((payload) => verifyEmisCredentials(payload), []);

  const signOut = useCallback(() => {
    clearSession();
    setSession(null);
    setStatus('idle');
    setError(null);
  }, []);

  const value = useMemo(() => {
    const currentUser = session?.user ?? null;
    const role = currentUser?.role ?? null;
    const isApprovedTeacher = role === ROLES.SCHOOL_ADMIN && currentUser?.status === MEMBER_STATUS.APPROVED;
    // Re-derive (rather than trusting the stored copy) so a late-arriving
    // `schoolLocator` cache or membership refresh is always reflected.
    const schoolRef = currentUser ? buildSchoolRef(currentUser) : null;
    return {
      session, user: currentUser, role, isAuthenticated: Boolean(currentUser), status, error,
      schoolRef, activeYear: DEFAULT_ACTIVE_YEAR,
      isSuperAdmin: role === ROLES.SUPER_ADMIN, isSchoolAdmin: role === ROLES.SCHOOL_ADMIN,
      isStudent: role === ROLES.STUDENT, isApprovedTeacher,
      canApproveTeachers: Boolean(role === ROLES.SCHOOL_ADMIN && currentUser?.status === MEMBER_STATUS.APPROVED && (currentUser?.isFounder || currentUser?.canApprove || currentUser?.isAdmin)),
      canManageStudents: role === ROLES.SUPER_ADMIN || isApprovedTeacher,
      canEditMarks: role === ROLES.SUPER_ADMIN || isApprovedTeacher,
      canPrintDocuments: role === ROLES.SUPER_ADMIN || isApprovedTeacher,
      signInWithRole, signInTeacher, registerTeacher, refreshMembership, signOut, verifySchool, landingRouteFor,
    };
  }, [session, status, error, locationVersion, signInWithRole, signInTeacher, registerTeacher, refreshMembership, signOut, verifySchool]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used inside <AuthProvider>.');
  return context;
}

export default AuthContext;