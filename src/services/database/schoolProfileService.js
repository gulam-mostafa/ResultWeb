import { cleanForCloud, safeRead, safeSubscribe, safeUpdate } from './dbFallback.js';
import {
  dbPaths,
  getSchoolLocatorPath,
  hydrateSchoolLocation,
  rememberSchoolLocation,
  resolveSchoolLocation,
} from './dbPaths.js';
import {
  normalizeSchoolProfile,
  pickProfileFields,
  EMPTY_SCHOOL_PROFILE,
} from '../../utils/schoolProfile.js';

/**
 * schoolProfileService — the tenant's own identity document.
 *
 *   divisions/{divisionId}/districts/{districtId}/upazilas/{upazilaId}/schools/{schoolId}/profile
 *   = {
 *       name, nameEn, divisionId, divisionName, districtId, districtName,
 *       upazilaId, upazilaName, villageOrUnion, emisCode, establishedYear,
 *       academicYear, motto, logoText, phone, email, website,
 *       headTeacher, headTeacherDesignation, updatedAt, updatedBy
 *     }
 *
 * Callers only pass a `schoolId`; the hierarchy is resolved through (1) the
 * in-memory location cache, (2) `schoolLocator/{schoolId}` and (3) the legacy flat
 * `schoolData/{schoolId}/profile` node — in that order.
 *
 * Any *approved* teacher may write it; every teacher subscribing to the school sees
 * the new values instantly because the subscription is a single shared `onValue`.
 */

const hasIdentity = (profile) => Boolean(profile?.id || profile?.name || profile?.schoolName);

const rememberFromProfile = (schoolId, profile) => rememberSchoolLocation({
  schoolId: schoolId || profile?.id,
  divisionId: profile?.divisionId,
  districtId: profile?.districtId,
  upazilaId: profile?.upazilaId,
});

/**
 * Live profile subscription – always emits a normalized profile object.
 * A legacy (flat) node paints instantly while the hierarchy is being resolved and
 * upgrades to the hierarchical node as soon as the location is known.
 */
export function subscribeSchoolProfile(schoolId, callback, onStatus) {
  if (!schoolId) {
    callback(normalizeSchoolProfile(EMPTY_SCHOOL_PROFILE));
    return () => {};
  }

  let latest = null;
  let disposed = false;
  let unsubscribe = null;

  const emit = (value) => {
    if (disposed) return;
    const normalized = normalizeSchoolProfile(value ?? EMPTY_SCHOOL_PROFILE);
    if (!hasIdentity(normalized) && latest) {
      callback(latest);
      return;
    }
    if (hasIdentity(normalized)) {
      latest = normalized;
      rememberFromProfile(schoolId, normalized);
    }
    callback(normalized);
  };

  const attach = (path) => {
    const off = safeSubscribe(path, emit, null, onStatus);
    if (disposed) off?.();
    else unsubscribe = off;
  };

  const knownLocation = resolveSchoolLocation(schoolId);
  attach(dbPaths.profile(schoolId));

  if (!knownLocation) {
    hydrateSchoolLocation(schoolId)
      .then((location) => {
        if (disposed || !location) return;
        const hierarchical = `${dbPaths.schoolBase(location)}/profile`;
        if (hierarchical === dbPaths.profile(schoolId)) return;
        const previous = unsubscribe;
        attach(hierarchical);
        previous?.();
      })
      .catch(() => {});
  }

  return () => {
    disposed = true;
    unsubscribe?.();
  };
}

/** One-shot read (used during sign-in to resolve the school name/location). */
export async function readSchoolProfile(schoolId) {
  if (!schoolId) return normalizeSchoolProfile(EMPTY_SCHOOL_PROFILE);
  await hydrateSchoolLocation(schoolId);
  const value = await safeRead(dbPaths.profile(schoolId), null);
  if (hasIdentity(normalizeSchoolProfile(value ?? {}))) {
    return normalizeSchoolProfile(value ?? EMPTY_SCHOOL_PROFILE);
  }
  // Legacy fallback: the very first tenants wrote to the flat workspace node.
  const legacy = await safeRead(dbPaths.legacyProfile(schoolId), null);
  const profile = normalizeSchoolProfile(legacy ?? EMPTY_SCHOOL_PROFILE);
  rememberFromProfile(schoolId, profile);
  return profile;
}

/**
 * Writes only the profile fields (never the whole workspace tree).
 * Uses `update()` so two teachers saving different fields never clobber each other.
 */
export async function saveSchoolProfile(schoolId, patch, actor = null) {
  if (!schoolId) return Promise.resolve({ synced: false });
  const clean = cleanForCloud(pickProfileFields(patch)) ?? {};
  // Store both the legacy UI keys and requested API names. Prefer explicitly
  // supplied aliases when the canonical spelling is absent, preserving blanks.
  const name = clean.name !== undefined ? clean.name : clean.schoolName;
  const division = clean.divisionName !== undefined ? clean.divisionName : clean.division;
  const district = clean.districtName !== undefined ? clean.districtName : clean.district;
  const upazila = clean.upazilaName !== undefined ? clean.upazilaName : clean.upazila;
  if (name !== undefined) { clean.name = name; clean.schoolName = name; }
  if (division !== undefined) { clean.divisionName = division; clean.division = division; }
  if (district !== undefined) { clean.districtName = district; clean.district = district; }
  if (upazila !== undefined) { clean.upazilaName = upazila; clean.upazila = upazila; }
  const payload = {
    ...clean,
    ...((clean.name ?? clean.schoolName) !== undefined ? { schoolName: clean.name ?? clean.schoolName } : {}),
    ...((clean.divisionName ?? clean.division) !== undefined ? { division: clean.divisionName ?? clean.division } : {}),
    ...((clean.districtName ?? clean.district) !== undefined ? { district: clean.districtName ?? clean.district } : {}),
    ...((clean.upazilaName ?? clean.upazila) !== undefined ? { upazila: clean.upazilaName ?? clean.upazila } : {}),
    updatedAt: new Date().toISOString(),
  };
  if (actor?.uid) payload.updatedBy = actor.uid;
  if (actor?.name) payload.updatedByName = actor.name;
  // The patch itself may carry the geography → resolve the hierarchy from it.
  const location = rememberSchoolLocation({ schoolId, ...clean })
    ?? await hydrateSchoolLocation(schoolId);
  const targetPath = dbPaths.profile(schoolId);
  // Never lose fields: seed the target from the legacy flat node on first migrate.
  const existing = await safeRead(targetPath, null);
  const seed = existing && typeof existing === 'object' && Object.keys(existing).length
    ? existing
    : await safeRead(dbPaths.legacyProfile(schoolId), null);
  const record = cleanForCloud({
    ...(seed && typeof seed === 'object' ? pickProfileFields(seed) : {}),
    ...payload,
    id: schoolId,
  }) ?? payload;
  // A soft-deleted tenant must stay flagged: a profile edit never revives it.
  if (seed?.isDeleted === true) {
    record.isDeleted = true;
    record.deletedAt = seed.deletedAt ?? null;
  }
  const result = await safeUpdate(targetPath, record);
  if (location) {
    await safeUpdate(getSchoolLocatorPath(schoolId), {
      schoolId,
      divisionId: location.divisionId,
      districtId: location.districtId,
      upazilaId: location.upazilaId,
      isDeleted: record.isDeleted === true,
      updatedAt: new Date().toISOString(),
    });
  }
  return result;
}

/**
 * Seeds a brand-new tenant profile the first time its founder registers.
 * Returns `{ synced, created }`; existing profiles are never overwritten.
 */
export async function ensureSchoolProfile(schoolId, initial = {}) {
  if (!schoolId) return { synced: false, created: false };
  const location = rememberSchoolLocation({ schoolId, ...initial })
    ?? await hydrateSchoolLocation(schoolId);
  if (!location) {
    // Without a complete hierarchy the canonical path cannot be composed.
    return { synced: false, created: false, reason: 'missing-location' };
  }
  const existing = await safeRead(dbPaths.profile(schoolId), null);
  // A soft-deleted tenant must stay flagged: re-seeding never revives it.
  const tombstoned = existing?.isDeleted === true;
  await safeUpdate(getSchoolLocatorPath(schoolId), {
    schoolId,
    divisionId: location.divisionId,
    districtId: location.districtId,
    upazilaId: location.upazilaId,
    isDeleted: tombstoned,
    ...(tombstoned ? { deletedAt: existing?.deletedAt ?? null } : {}),
    updatedAt: new Date().toISOString(),
  });
  if (existing && typeof existing === 'object' && Object.keys(existing).length > 0) {
    return { synced: true, created: false };
  }
  const profile = normalizeSchoolProfile({ ...initial, ...location, id: schoolId });
  const clean = cleanForCloud(pickProfileFields(profile)) ?? {};
  await safeUpdate(dbPaths.profile(schoolId), {
    ...clean,
    id: schoolId,
    ...location,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  return { synced: true, created: true };
}

/**
 * Soft-deletes a tenant: the profile is flagged instead of removed, so results,
 * attendance and audit history of past years stay intact.
 */
export async function softDeleteSchoolProfile(schoolId, actor = null) {
  if (!schoolId) return { synced: false };
  const location = await hydrateSchoolLocation(schoolId);
  const now = new Date().toISOString();
  const patch = cleanForCloud({
    isDeleted: true,
    deletedAt: now,
    ...(actor?.uid ? { deletedBy: actor.uid } : {}),
    updatedAt: now,
  });
  const result = await safeUpdate(dbPaths.profile(schoolId), patch);
  if (location) {
    await safeUpdate(getSchoolLocatorPath(schoolId), { ...patch, schoolId, ...location });
  }
  return result;
}

/** True when the tenant has been soft-deleted (the record still exists). */
export async function isSchoolDeleted(schoolId) {
  if (!schoolId) return false;
  const profile = await safeRead(dbPaths.profile(schoolId), null);
  return Boolean(profile?.isDeleted);
}

export default {
  subscribeSchoolProfile,
  readSchoolProfile,
  saveSchoolProfile,
  ensureSchoolProfile,
  softDeleteSchoolProfile,
  isSchoolDeleted,
};
