/**
 * resultConfigService — per-school Results configuration (STRICTLY school-isolated).
 *
 * Every read/write is addressed through the active school's OWN tenant base
 * (`divisions/…/schools/{schoolId}/sessions/{year}/meta/resultConfig/{classId}`),
 * which `dbPaths` resolves from the authenticated school reference. There is no
 * global / shared / universal configuration node: two schools can use completely
 * different subjects, splits, pass marks and weights without ever seeing each
 * other's data.
 *
 * ```text
 * …/schools/{schoolId}/sessions/{year}/meta/resultConfig/{classId} = {
 *   classId, passMark, goldenMark,
 *   weights: { term1, term2, annual },
 *   subjects: [{ id, name, split, formativeFull, summativeFull, fullMarks, color }],
 *   updatedAt,
 * }
 * ```
 */

import { safeRead, safeSubscribe, safeUpdate, cleanForCloud } from './dbFallback.js';
import { dbPaths, normalizeSessionYear } from './dbPaths.js';
import { ensureSchoolYear } from './centralSchoolStore.js';
import { toAppClassId } from './studentService.js';
import { normalizeResultConfig, configClassKey } from '../../utils/resultConfig.js';

const asRecord = (value) => (value && typeof value === 'object' && !Array.isArray(value) ? value : {});
const nowISO = () => new Date().toISOString();

/**
 * The configuration tree is stored under canonical class segments (`class-1`), while
 * the whole app addresses classes as `c1`. Every reader converts the segment back so
 * `resultConfigs['c1']` always resolves the right configuration.
 */
const toConfigTree = (tree) => Object.entries(asRecord(tree)).reduce((acc, [segment, raw]) => {
  const appClassId = toAppClassId(segment) || segment;
  acc[appClassId] = normalizeResultConfig(raw, appClassId);
  return acc;
}, {});

/** One stored row ➔ normalized config addressed by the app class id. */
const toConfigRow = (raw, classId) => normalizeResultConfig(raw, classId);

/** Absolute node of ONE class configuration inside the school's year partition. */
export const resultConfigPath = (reference, year, classId) =>
  `${dbPaths.yearMeta(reference, year)}/resultConfig/${configClassKey(classId)}`;

/** Normalises a stored configuration row; blanks resolve to the class's defaults. */
export function readResultConfigState(schoolId, settings, classId) {
  return normalizeResultConfig(settings, classId);
}

/**
 * One-shot read of a class configuration.
 * @returns {Promise<object>} the normalized config (factory defaults when absent)
 */
export async function readClassResultConfig(reference, year, classId) {
  const yearKey = normalizeSessionYear(year);
  if (!yearKey) return normalizeResultConfig(null, classId);
  const raw = await safeRead(resultConfigPath(reference, yearKey, classId), null);
  return toConfigRow(raw, classId);
}

/** Reads EVERY class configuration of the school's year in one round-trip. */
export async function readAllResultConfigs(reference, year) {
  const yearKey = normalizeSessionYear(year);
  if (!yearKey) return {};
  const tree = await safeRead(`${dbPaths.yearMeta(reference, yearKey)}/resultConfig`, {});
  return toConfigTree(tree);
}

/**
 * Live subscription to one class configuration (auto-save from another device is
 * picked up instantly). Returns an idempotent unsubscribe.
 */
export function subscribeClassResultConfig(reference, year, classId, callback, onStatus) {
  const yearKey = normalizeSessionYear(year);
  if (!yearKey || !classId || typeof callback !== 'function') {
    callback?.(normalizeResultConfig(null, classId));
    return () => {};
  }
  return safeSubscribe(
    resultConfigPath(reference, yearKey, classId),
    (raw) => callback(normalizeResultConfig(raw, classId)),
    null,
    onStatus,
  );
}

/** Live subscription to the whole year's configuration tree (`{classId: config}`). */
export function subscribeAllResultConfigs(reference, year, callback, onStatus) {
  const yearKey = normalizeSessionYear(year);
  if (!yearKey || typeof callback !== 'function') {
    callback?.({});
    return () => {};
  }
  return safeSubscribe(
    `${dbPaths.yearMeta(reference, yearKey)}/resultConfig`,
    (tree) => callback(toConfigTree(tree)),
    {},
    onStatus,
  );
}

/**
 * Persists one class configuration inside the ACTIVE SCHOOL's own namespace.
 * Only the validated configuration fields are written, so a stray UI flag (a draft
 * marker, a dirty bit) can never end up in the database.
 */
export async function saveClassResultConfig(reference, year, classId, config) {
  const yearKey = normalizeSessionYear(year);
  if (!yearKey || !classId) return { synced: false };
  const safe = normalizeResultConfig(config, classId);
  if (yearKey) await ensureSchoolYear(reference, yearKey);
  const row = cleanForCloud({
    classId,
    passMark: safe.passMark,
    goldenMark: safe.goldenMark,
    weights: safe.weights,
    subjects: safe.subjects,
    updatedAt: nowISO(),
  });
  return safeUpdate(dbPaths.yearMeta(reference, yearKey), {
    [`resultConfig/${configClassKey(classId)}`]: row,
  });
}
/** Restores one class to the factory (default) configuration. */
export async function resetClassResultConfig(reference, year, classId) {
  return saveClassResultConfig(reference, year, classId, normalizeResultConfig(null, classId));
}

/** Removes a class configuration so the defaults apply again. */
export async function deleteClassResultConfig(reference, year, classId) {
  const yearKey = normalizeSessionYear(year);
  if (!yearKey || !classId) return { synced: false };
  return safeUpdate(dbPaths.yearMeta(reference, yearKey), {
    [`resultConfig/${configClassKey(classId)}`]: null,
  });
}

export default {
  resultConfigPath,
  readResultConfigState,
  readClassResultConfig,
  readAllResultConfigs,
  subscribeClassResultConfig,
  subscribeAllResultConfigs,
  saveClassResultConfig,
  resetClassResultConfig,
  deleteClassResultConfig,
};
