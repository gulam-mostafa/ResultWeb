/**
 * Result configuration model (বিষয়, পূর্ণমান, গাঠনিক/সামষ্টিক বিভাজন, পাস মার্ক, ওজন).
 *
 * Everything here is PURE. A school's configuration is persisted inside its OWN
 * tenant namespace (`…/schools/{schoolId}/sessions/{year}/meta/resultConfig/{classId}`),
 * so one school's subjects, marks split, pass mark and annual weights can never leak
 * into another school's result calculation.
 *
 * Shape of a normalized configuration:
 * ```js
 * {
 *   classId: 'c3',
 *   passMark: 33,
 *   goldenMark: 80,
 *   weights: { term1: 15, term2: 15, annual: 70 },
 *   subjects: [
 *     { id: 'bangla', name: 'বাংলা', split: true,
 *       formativeFull: 30, summativeFull: 70, fullMarks: 100, color: '#2563eb' },
 *   ],
 *   updatedAt: '',
 * }
 * ```
 */

import { CLASS_LEVELS, SUBJECTS, resolveClassKey } from './constants.js';
import { toEnglishNumber } from './banglaNumberFormatter.js';

/** The four evaluation tabs of the Results page. */
export const RESULT_TABS = Object.freeze([
  { id: 'term1', name: '১ম প্রান্তিক মূল্যায়ন', shortName: '১ম প্রান্তিক', termId: 'term1' },
  { id: 'term2', name: '২য় প্রান্তিক মূল্যায়ন', shortName: '২য় প্রান্তিক', termId: 'term2' },
  { id: 'annual', name: 'বার্ষিক মূল্যায়ন', shortName: 'বার্ষিক', termId: 'annual' },
  { id: 'consolidated', name: 'বার্ষিক ফলাফল', shortName: 'বার্ষিক ফলাফল', termId: null },
]);

export const RESULT_TAB_IDS = Object.freeze(RESULT_TABS.map((tab) => tab.id));

/** The persisted term ids the annual result combines (in tab order). */
export const RESULT_TERM_IDS = Object.freeze(['term1', 'term2', 'annual']);

export const DEFAULT_PASS_MARK = 33;
export const DEFAULT_GOLDEN_MARK = 80;
export const DEFAULT_WEIGHTS = Object.freeze({ term1: 15, term2: 15, annual: 70 });
export const DEFAULT_FULL_MARKS = 100;
export const DEFAULT_FORMATIVE_FULL = 30;
export const DEFAULT_SUMMATIVE_FULL = 70;

export const isResultTabId = (value) => RESULT_TAB_IDS.includes(String(value ?? ''));
export const tabById = (tabId) => RESULT_TABS.find((tab) => tab.id === tabId) ?? RESULT_TABS[0];

/** A blank/NaN number falls back to `fallback`. */
const numberOr = (value, fallback = 0) => {
  if (value === null || value === undefined || value === '') return fallback;
  const numeric = Number(toEnglishNumber(value));
  return Number.isFinite(numeric) ? numeric : fallback;
};

export const round2 = (value) => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  return Math.round((numeric + Number.EPSILON) * 100) / 100;
};

/* ------------------------------------------------------------------ *
 * Class-wise default subjects (শ্রেণিভিত্তিক ডিফল্ট বিষয়)
 * ------------------------------------------------------------------ */

const SUBJECT_BY_ID = Object.freeze(
  SUBJECTS.reduce((acc, subject) => {
    acc[subject.id] = subject;
    return acc;
  }, {}),
);

/**
 * - প্রাক-প্রাথমিক  : ৩ বিষয়, প্রতি বিষয়ে ১০০ পূর্ণমান (কোনো বিভাজন নেই)
 * - ১ম / ২য় শ্রেণি : বাংলা, গণিত, ইংরেজি, সমন্বিত — গাঠনিক ৩০ + সামষ্টিক ৭০
 * - ৩য়–৫ম শ্রেণি   : বাংলা, গণিত, ইংরেজি, বিজ্ঞান, বাওবি, ধর্ম, সমন্বিত — ৩০ + ৭০
 */
const CLASS_SUBJECT_SEEDS = Object.freeze({
  pre: ['bangla', 'english', 'math'],
  c1: ['bangla', 'math', 'english', 'integrated'],
  c2: ['bangla', 'math', 'english', 'integrated'],
  c3: ['bangla', 'math', 'english', 'science', 'bgs', 'religion', 'integrated'],
  c4: ['bangla', 'math', 'english', 'science', 'bgs', 'religion', 'integrated'],
  c5: ['bangla', 'math', 'english', 'science', 'bgs', 'religion', 'integrated'],
});

/** Pre-primary evaluates a single 100-mark score; classes 1–5 use গাঠনিক + সামষ্টিক. */
const CLASS_USES_SPLIT = Object.freeze({ pre: false, c1: true, c2: true, c3: true, c4: true, c5: true });

/**
 * Short, school-friendly default names for classes 3–5 (`বাওবি` = বাংলাদেশ ও বিশ্বপরিচয়).
 * A user can rename any subject afterwards; these are only the seeded labels.
 */
const CLASS_SUBJECT_NAME_OVERRIDES = Object.freeze({
  c3: { science: 'বিজ্ঞান', bgs: 'বাওবি', religion: 'ধর্ম' },
  c4: { science: 'বিজ্ঞান', bgs: 'বাওবি', religion: 'ধর্ম' },
  c5: { science: 'বিজ্ঞান', bgs: 'বাওবি', religion: 'ধর্ম' },
});

const seedSubjectIds = (classId) => CLASS_SUBJECT_SEEDS[classId] ?? CLASS_SUBJECT_SEEDS.c3;

/** A stable, collision-free subject id for a brand-new custom subject. */
export function makeSubjectId(name = '', existingIds = []) {
  const base = String(name ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u0980-\u09FF]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24) || 'subject';
  const taken = new Set(existingIds);
  let candidate = `subj-${base}`;
  let counter = 2;
  while (taken.has(candidate)) {
    candidate = `subj-${base}-${counter}`;
    counter += 1;
  }
  return candidate;
}

/**
 * Normalises ONE subject descriptor.
 * `fullMarks` of a split subject is always the SUM of its two components, so the
 * screen, the Excel template and the calculation engine can never disagree.
 */
export function normalizeSubject(entry = {}, index = 0) {
  const id = String(entry?.id ?? '').trim() || `subj-${index + 1}`;
  const catalogue = SUBJECT_BY_ID[id];
  const name = String(entry?.name ?? '').trim() || catalogue?.name || `বিষয় ${index + 1}`;
  const split = entry?.split === undefined || entry?.split === null
    ? Boolean(catalogue)
    : entry.split === true || entry.split === 'true';
  const fallbackFormative = split ? DEFAULT_FORMATIVE_FULL : DEFAULT_FULL_MARKS;
  const formativeFull = Math.max(1, round2(numberOr(entry?.formativeFull, fallbackFormative)));
  const summativeFull = split
    ? Math.max(1, round2(numberOr(entry?.summativeFull, DEFAULT_SUMMATIVE_FULL)))
    : 0;
  const fullMarks = split ? round2(formativeFull + summativeFull) : formativeFull;
  return {
    id,
    name,
    split,
    formativeFull: split ? formativeFull : fullMarks,
    summativeFull,
    fullMarks,
    color: String(entry?.color ?? '') || catalogue?.color || '#64748b',
  };
}

/** The factory subject list of a class. */
export function defaultSubjectsForClass(classId) {
  const resolved = String(classId ?? 'c3');
  const split = CLASS_USES_SPLIT[resolved] ?? true;
  const overrides = CLASS_SUBJECT_NAME_OVERRIDES[resolved] ?? {};
  return seedSubjectIds(resolved).map((subjectId, index) => normalizeSubject({
    id: subjectId,
    name: overrides[subjectId] ?? SUBJECT_BY_ID[subjectId]?.name ?? subjectId,
    split,
    formativeFull: split ? DEFAULT_FORMATIVE_FULL : DEFAULT_FULL_MARKS,
    summativeFull: split ? DEFAULT_SUMMATIVE_FULL : 0,
    color: SUBJECT_BY_ID[subjectId]?.color,
  }, index));
}

/** Annual weights: each value is kept as typed; the sum normalises the calculation. */
export function normalizeWeights(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  return {
    term1: Math.max(0, round2(numberOr(source.term1, DEFAULT_WEIGHTS.term1))),
    term2: Math.max(0, round2(numberOr(source.term2, DEFAULT_WEIGHTS.term2))),
    annual: Math.max(0, round2(numberOr(source.annual, DEFAULT_WEIGHTS.annual))),
  };
}

/** `true` when the three weights add up to 100 (a clean, expected configuration). */
export function weightsAreClean(raw) {
  const weights = normalizeWeights(raw);
  const total = round2(weights.term1 + weights.term2 + weights.annual);
  return Math.abs(total - 100) < 0.01;
}

/** Weights expressed as percentages of their own sum (always sums to 100). */
export function normalizedWeightPercent(raw) {
  const safe = normalizeWeights(raw);
  const total = safe.term1 + safe.term2 + safe.annual;
  if (total <= 0) return { ...DEFAULT_WEIGHTS };
  return {
    term1: round2((safe.term1 / total) * 100),
    term2: round2((safe.term2 / total) * 100),
    annual: round2((safe.annual / total) * 100),
  };
}

/** Factory configuration of one class (no database involved). */
export function defaultResultConfig(classId = 'c3') {
  return {
    classId,
    passMark: DEFAULT_PASS_MARK,
    goldenMark: DEFAULT_GOLDEN_MARK,
    weights: { ...DEFAULT_WEIGHTS },
    subjects: defaultSubjectsForClass(classId),
    updatedAt: '',
    isDefault: true,
  };
}

/**
 * Normalises a stored (or edited) configuration.
 * A missing/blank/legacy node resolves to the class's factory defaults, so a fresh
 * school immediately has the correct syllabus without a single write.
 */
export function normalizeResultConfig(raw, classId = raw?.classId ?? 'c3') {
  const fallback = defaultResultConfig(classId);
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const list = Array.isArray(source.subjects) ? source.subjects : null;
  const subjects = list && list.length
    ? list.map((entry, index) => normalizeSubject(entry, index))
    : fallback.subjects;
  // Two subjects must never share an id — the duplicate is re-keyed.
  const seen = new Set();
  const unique = subjects.map((subject, index) => {
    if (!seen.has(subject.id)) {
      seen.add(subject.id);
      return subject;
    }
    const rekeyed = { ...subject, id: `${subject.id}-${index + 1}` };
    seen.add(rekeyed.id);
    return rekeyed;
  });
  return {
    ...fallback,
    ...source,
    classId,
    passMark: Math.max(1, Math.min(100, round2(numberOr(source.passMark, fallback.passMark)))),
    goldenMark: Math.max(1, Math.min(100, round2(numberOr(source.goldenMark, fallback.goldenMark)))),
    weights: normalizeWeights(source.weights),
    subjects: unique,
    updatedAt: source.updatedAt ?? '',
    isDefault: !list || !list.length,
  };
}

/** Total full marks of a class configuration (for the grid footer). */
export const totalFullMarks = (config) =>
  round2((config?.subjects ?? []).reduce((sum, subject) => sum + (Number(subject.fullMarks) || 0), 0));

/** The persisted field key of one subject component (`total` ➔ bare subject id). */
export const entryFieldKey = (subjectId, component = 'total') => (
  component === 'total' ? subjectId : `${subjectId}:${component}`
);

/** Every mark input of a configuration, in subject order (formative ➔ summative). */
export function configEntryFields(config) {
  return (config?.subjects ?? []).flatMap((subject) => (
    subject.split
      ? [
        {
          key: entryFieldKey(subject.id, 'formative'),
          subjectId: subject.id,
          subjectName: subject.name,
          component: 'formative',
          label: `${subject.name} (গাঠনিক)`,
          shortLabel: 'গাঠনিক',
          max: subject.formativeFull,
        },
        {
          key: entryFieldKey(subject.id, 'summative'),
          subjectId: subject.id,
          subjectName: subject.name,
          component: 'summative',
          label: `${subject.name} (সামষ্টিক)`,
          shortLabel: 'সামষ্টিক',
          max: subject.summativeFull,
        },
      ]
      : [
        {
          key: entryFieldKey(subject.id, 'total'),
          subjectId: subject.id,
          subjectName: subject.name,
          component: 'total',
          label: subject.name,
          shortLabel: subject.name,
          max: subject.fullMarks,
        },
      ]
  ));
}

/** Class label used by the Excel template and the headers. */
export const classLabelOf = (classId) =>
  CLASS_LEVELS.find((item) => item.id === classId)?.name ?? String(classId ?? '');

/** Stable database segment of a class configuration (`c5` ➔ `class-5`). */
export const configClassKey = (classId) => resolveClassKey(classId);

export default {
  RESULT_TABS,
  RESULT_TAB_IDS,
  RESULT_TERM_IDS,
  DEFAULT_PASS_MARK,
  DEFAULT_GOLDEN_MARK,
  DEFAULT_WEIGHTS,
  isResultTabId,
  tabById,
  makeSubjectId,
  normalizeSubject,
  defaultSubjectsForClass,
  defaultResultConfig,
  normalizeResultConfig,
  normalizeWeights,
  weightsAreClean,
  normalizedWeightPercent,
  totalFullMarks,
  entryFieldKey,
  configEntryFields,
  classLabelOf,
  configClassKey,
  round2,
};
