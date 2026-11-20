import { safeUpdate } from './dbFallback.js';
import { dbPaths, normalizeLocation } from './dbPaths.js';
import {
  DEFAULT_ACTIVE_YEAR,
  DEMO_SCHOOL_LOCATION,
  buildSchoolId,
  ensureDemoSchoolInHierarchy,
  readSchoolRecord,
  registerSchoolInHierarchy,
  softDeleteSchoolInHierarchy,
  subscribeAllIndexedSchools,
  subscribeSchoolsByLocation,
  syncSchoolRegistryWithProfile,
  updateSchoolInHierarchy,
} from './centralSchoolStore.js';

export const DEFAULT_SCHOOLS = Object.freeze([]);
export { DEFAULT_ACTIVE_YEAR, DEMO_SCHOOL_LOCATION, buildSchoolId };

const seedsFor = ({ divisionId, districtId, upazilaId }) =>
  DEFAULT_SCHOOLS.filter(
    (school) =>
      school.divisionId === divisionId
      && school.districtId === districtId
      && school.upazilaId === upazilaId,
  );

const indexRoot = (location) =>
  dbPaths.schoolIndex(location?.divisionId, location?.districtId, location?.upazilaId);

const seededThisSession = new Set();

export async function ensureDemoSchool(extra = {}) {
  return ensureDemoSchoolInHierarchy(extra);
}

export async function ensureSeedSchools(location = { divisionId: '', districtId: '', upazilaId: '' }) {
  const seeds = seedsFor(location);
  if (seeds.length === 0) return { synced: true };
  const path = indexRoot(location);
  const now = new Date().toISOString();
  return safeUpdate(
    path,
    Object.fromEntries(seeds.map((school) => [school.id, {
      id: school.id,
      name: school.name ?? '',
      emisCode: school.emisCode ?? '',
      divisionId: school.divisionId ?? '',
      districtId: school.districtId ?? '',
      upazilaId: school.upazilaId ?? '',
      isDeleted: false,
      deletedAt: null,
      updatedAt: now,
    }])),
  );
}

export function subscribeSchools(location, callback, onStatus) {
  const { divisionId, districtId, upazilaId } = location ?? {};
  if (!divisionId || !districtId || !upazilaId) {
    callback([]);
    return () => {};
  }
  const path = indexRoot(location);
  const seeds = seedsFor(location);
  if (seeds.length > 0 && !seededThisSession.has(path)) {
    seededThisSession.add(path);
    ensureSeedSchools(location).catch(() => {});
  }
  return subscribeSchoolsByLocation(location, callback, onStatus);
}

export function subscribeAllSchools(callback, onStatus) {
  return subscribeAllIndexedSchools(callback, onStatus);
}

export async function getSchool(location, schoolId) {
  const record = await readSchoolRecord(location, schoolId);
  const seeded = DEFAULT_SCHOOLS.find((school) => school.id === schoolId) ?? null;
  if (!record) return seeded;
  return { ...seeded, ...record, id: schoolId, isDeleted: Boolean(record.isDeleted) };
}

export async function addSchool(location, school) {
  return registerSchoolInHierarchy(location, school);
}

export async function updateSchool(location, schoolId, patch) {
  return updateSchoolInHierarchy(location, schoolId, patch);
}

export async function syncSchoolProfileRegistry(schoolId, previous = {}, next = {}) {
  return syncSchoolRegistryWithProfile(schoolId, previous, next);
}

export async function deleteSchool(location, schoolId) {
  const normalized = normalizeLocation({
    divisionId: location?.divisionId,
    districtId: location?.districtId,
    upazilaId: location?.upazilaId,
    schoolId,
  });
  if (!normalized) return { synced: false };
  return softDeleteSchoolInHierarchy(location, schoolId);
}

export default {
  DEFAULT_SCHOOLS,
  DEFAULT_ACTIVE_YEAR,
  buildSchoolId,
  subscribeSchools,
  subscribeAllSchools,
  ensureSeedSchools,
  getSchool,
  addSchool,
  updateSchool,
  syncSchoolProfileRegistry,
  deleteSchool,
};