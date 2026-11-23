export * from './dbPaths.js';
export * from './dbFallback.js';
export * from './schoolRegistryService.js';
export * from './schoolProfileService.js';
export * from './memberService.js';
export * from './studentService.js';
export * from './resultService.js';
export * from './resultConfigService.js';
export * from './attendanceService.js';
export * from './userAndVisitorService.js';
export * from './datasetService.js';
/**
 * Central campus store — the one place that owns a school's
 * `profile` / `studentMaster` / `teachers` / `sessions/{year}` skeleton.
 * Re-exported by name (not `*`) so the identical bindings already surfaced through
 * `schoolRegistryService` are never ambiguous.
 */
export {
  CLASS_ORDER,
  ensureSchoolYearBuckets,
  ensureSchoolYear,
  promoteStudentsToNextYear,
  promoteSchoolSession,
  promoteClassInYear,
  promoteClassSession,
} from './centralSchoolStore.js';
