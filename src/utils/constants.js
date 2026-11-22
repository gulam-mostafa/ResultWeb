/**
 * Application-wide constants for the Primary School Management & Digital Result Platform.
 * Keeping all enumerations in a single module prevents magic strings from leaking
 * into components and makes future backend/Firebase mapping straightforward.
 */

/* ------------------------------------------------------------------ *
 * 1. Roles
 * ------------------------------------------------------------------ */
export const ROLES = Object.freeze({
  SUPER_ADMIN: 'super_admin',
  SCHOOL_ADMIN: 'school_admin',
  STUDENT: 'student',
});

export const ROLE_LABELS = Object.freeze({
  [ROLES.SUPER_ADMIN]: 'সুপার অ্যাডমিন',
  [ROLES.SCHOOL_ADMIN]: 'স্কুল অ্যাডমিন / শিক্ষক',
  [ROLES.STUDENT]: 'শিক্ষার্থী / অভিভাবক',
});

/* ------------------------------------------------------------------ *
 * 2. School membership (multi-tenant roles & approvals)
 *    ওয়ার্কস্পেসে শিক্ষক সদস্যের ভূমিকা ও অনুমোদন অবস্থা
 * ------------------------------------------------------------------ */
export const MEMBER_STATUS = Object.freeze({
  PENDING: 'pending',
  APPROVED: 'approved',
  REJECTED: 'rejected',
});

export const MEMBER_STATUS_LABELS = Object.freeze({
  [MEMBER_STATUS.PENDING]: 'অনুমোদনের অপেক্ষায়',
  [MEMBER_STATUS.APPROVED]: 'অনুমোদিত',
  [MEMBER_STATUS.REJECTED]: 'বাতিলকৃত',
});

/** Membership roles inside one school workspace. */
export const MEMBER_ROLES = Object.freeze({
  FOUNDER: 'founder_admin',
  TEACHER: 'teacher',
});

export const MEMBER_ROLE_LABELS = Object.freeze({
  [MEMBER_ROLES.FOUNDER]: 'প্রতিষ্ঠাতা অ্যাডমিন',
  [MEMBER_ROLES.TEACHER]: 'শিক্ষক',
});

/* ------------------------------------------------------------------ *
 * 3. Classes (শ্রেণি)
 * ------------------------------------------------------------------ */
export const CLASS_LEVELS = Object.freeze([
  { id: 'pre', name: 'প্রাক-প্রাথমিক', shortName: 'প্রাক-প্রাথমিক', order: 0 },
  { id: 'c1', name: '১ম শ্রেণি', shortName: '১ম', order: 1 },
  { id: 'c2', name: '২য় শ্রেণি', shortName: '২য়', order: 2 },
  { id: 'c3', name: '৩য় শ্রেণি', shortName: '৩য়', order: 3 },
  { id: 'c4', name: '৪র্থ শ্রেণি', shortName: '৪র্থ', order: 4 },
  { id: 'c5', name: '৫ম শ্রেণি', shortName: '৫ম', order: 5 },
]);

export const ARCHIVE_CLASS = Object.freeze({
  id: 'archive',
  name: 'আর্কাইভ (প্রাক্তন শিক্ষার্থী)',
  shortName: 'আর্কাইভ',
  order: 99,
});

export const CLASS_TABS = Object.freeze([...CLASS_LEVELS, ARCHIVE_CLASS]);

/** ক্লাস ➔ পরবর্তী ক্লাস (শ্রেণি উত্তরণের মানচিত্র) */
export const NEXT_CLASS_MAP = Object.freeze({
  pre: 'c1',
  c1: 'c2',
  c2: 'c3',
  c3: 'c4',
  c4: 'c5',
  c5: 'archive',
});

/**
 * ক্লাস ➔ আগের ক্লাস (এক শ্রেণি নিচে নামানোর মানচিত্র).
 * `pre` is the first class, so it has no lower class (`undefined`).
 */
export const PREV_CLASS_MAP = Object.freeze({
  c1: 'pre',
  c2: 'c1',
  c3: 'c2',
  c4: 'c3',
  c5: 'c4',
});

/**
 * The three per-pupil class-change decisions of the student edit form.
 * `stay` keeps the current class, `promote` moves one class up and `demote` one down.
 */
export const CLASS_CHANGE_MODE = Object.freeze({
  STAY: 'stay',
  PROMOTE: 'promote',
  DEMOTE: 'demote',
});

export const CLASS_LABEL_MAP = Object.freeze(
  CLASS_TABS.reduce((acc, item) => {
    acc[item.id] = item.name;
    return acc;
  }, {}),
);

export const getClassName = (classId) => CLASS_LABEL_MAP[classId] ?? 'অজানা শ্রেণি';

/* ------------------------------------------------------------------ *
 * 4. Subjects, class-wise curriculum & evaluation (বিষয় ও মূল্যায়ন)
 * ------------------------------------------------------------------ */

/**
 * Every subject carries two evaluation components plus their combined total:
 *   formative (গাঠনিক) + summative (সামষ্টিক) ➔ total (মোট)
 * `total` is derived, so it is never entered by hand.
 */
export const EVALUATION_COMPONENTS = Object.freeze([
  { id: 'formative', name: 'গাঠনিক মূল্যায়ন', shortName: 'গাঠনিক', weight: 0.4, weightLabel: '৪০%', fullMarks: 100, derived: false },
  { id: 'summative', name: 'সামষ্টিক মূল্যায়ন', shortName: 'সামষ্টিক', weight: 0.6, weightLabel: '৬০%', fullMarks: 100, derived: false },
  { id: 'total', name: 'মোট নম্বর', shortName: 'মোট', weight: 1, weightLabel: '১০০%', fullMarks: 100, derived: true },
]);

export const EVALUATION_COMPONENT_IDS = Object.freeze(EVALUATION_COMPONENTS.map((component) => component.id));
export const EVALUATION_COMPONENT_LABELS = Object.freeze(
  EVALUATION_COMPONENTS.reduce((acc, component) => {
    acc[component.id] = component.name;
    return acc;
  }, {}),
);
/** Components a teacher actually enters — `total` is always computed. */
export const ENTERED_COMPONENT_IDS = Object.freeze(
  EVALUATION_COMPONENTS.filter((component) => !component.derived).map((component) => component.id),
);

/** Master subject catalogue — every entry supports formative + summative + total. */
export const SUBJECTS = Object.freeze([
  { id: 'bangla', name: 'বাংলা', code: 'BAN', color: '#2563eb', components: EVALUATION_COMPONENT_IDS },
  { id: 'english', name: 'ইংরেজি', code: 'ENG', color: '#059669', components: EVALUATION_COMPONENT_IDS },
  { id: 'math', name: 'গণিত', code: 'MAT', color: '#d97706', components: EVALUATION_COMPONENT_IDS },
  { id: 'integrated', name: 'সমন্বিত', code: 'INT', color: '#7c3aed', components: EVALUATION_COMPONENT_IDS },
  { id: 'science', name: 'প্রাথমিক বিজ্ঞান', code: 'SCI', color: '#0891b2', components: EVALUATION_COMPONENT_IDS },
  { id: 'bgs', name: 'বাংলাদেশ ও বিশ্বপরিচয়', code: 'BGS', color: '#0d9488', components: EVALUATION_COMPONENT_IDS },
  { id: 'religion', name: 'ধর্ম ও নৈতিক শিক্ষা', code: 'REL', color: '#db2777', components: EVALUATION_COMPONENT_IDS },
]);

export const SUBJECT_IDS = Object.freeze(SUBJECTS.map((subject) => subject.id));
export const SUBJECT_LABEL_MAP = Object.freeze(
  SUBJECTS.reduce((acc, subject) => {
    acc[subject.id] = subject.name;
    return acc;
  }, {}),
);

const SUBJECT_MAP = Object.freeze(
  SUBJECTS.reduce((acc, subject) => {
    acc[subject.id] = subject;
    return acc;
  }, {}),
);

/** Canonical class keys used by the database paths and the subject matrix. */
export const CLASS_KEYS = Object.freeze({
  PRE_PRIMARY: 'pre-primary',
  CLASS_1: 'class-1',
  CLASS_2: 'class-2',
  CLASS_3: 'class-3',
  CLASS_4: 'class-4',
  CLASS_5: 'class-5',
});

/** App class ids (`pre`, `c1` … `c5`) ➔ canonical class keys. */
const APP_CLASS_KEY_MAP = Object.freeze({
  pre: CLASS_KEYS.PRE_PRIMARY,
  c1: CLASS_KEYS.CLASS_1,
  c2: CLASS_KEYS.CLASS_2,
  c3: CLASS_KEYS.CLASS_3,
  c4: CLASS_KEYS.CLASS_4,
  c5: CLASS_KEYS.CLASS_5,
});

/** Accepts `pre`/`c1`/`class-1`/`pre-primary` and returns one canonical key. */
export const resolveClassKey = (classId) => {
  const key = String(classId ?? '').trim();
  return APP_CLASS_KEY_MAP[key] ?? key;
};

/**
 * Class-wise subject matrix (শ্রেণিভিত্তিক বিষয়):
 *  - প্রাক-প্রাথমিক       ➔ বাংলা, ইংরেজি, গণিত                    (৩)
 *  - ১ম ও ২য় শ্রেণি       ➔ বাংলা, ইংরেজি, গণিত, সমন্বিত           (৪)
 *  - ৩য়, ৪র্থ, ৫ম শ্রেণি  ➔ বাংলা, ইংরেজি, গণিত, বিজ্ঞান, বি.ও.বি., ধর্ম (৬)
 */
export const CLASS_SUBJECT_IDS = Object.freeze({
  [CLASS_KEYS.PRE_PRIMARY]: Object.freeze(['bangla', 'english', 'math']),
  [CLASS_KEYS.CLASS_1]: Object.freeze(['bangla', 'english', 'math', 'integrated']),
  [CLASS_KEYS.CLASS_2]: Object.freeze(['bangla', 'english', 'math', 'integrated']),
  [CLASS_KEYS.CLASS_3]: Object.freeze(['bangla', 'english', 'math', 'science', 'bgs', 'religion']),
  [CLASS_KEYS.CLASS_4]: Object.freeze(['bangla', 'english', 'math', 'science', 'bgs', 'religion']),
  [CLASS_KEYS.CLASS_5]: Object.freeze(['bangla', 'english', 'math', 'science', 'bgs', 'religion']),
});

/** Unknown/archived class ids fall back to the widest (Class 3–5) syllabus. */
export const getSubjectIdsForClass = (classId) =>
  CLASS_SUBJECT_IDS[resolveClassKey(classId)] ?? CLASS_SUBJECT_IDS[CLASS_KEYS.CLASS_3];

/** Full subject descriptors (with their evaluation components) for one class. */
export const getSubjectsForClass = (classId) =>
  getSubjectIdsForClass(classId).map((subjectId) => SUBJECT_MAP[subjectId]).filter(Boolean);

/** The evaluation structure every subject of a class supports. */
export const getEvaluationStructure = () => EVALUATION_COMPONENTS;

/**
 * Terms (প্রান্তিক): ১ম প্রান্তিক, ২য় প্রান্তিক ও বার্ষিক।
 * `id` is the persisted key every existing reader uses; `key` is the canonical
 * name, so `final` and `annual` address the same term (see `resolveTermKey`).
 */
export const TERMS = Object.freeze([
  { id: 'term1', key: 'term1', name: '১ম প্রান্তিক', shortName: '১ম', weight: 0.2, weightLabel: '২০%', fullMarks: 100 },
  { id: 'term2', key: 'term2', name: '২য় প্রান্তিক', shortName: '২য়', weight: 0.2, weightLabel: '২০%', fullMarks: 100 },
  { id: 'annual', key: 'final', name: 'বার্ষিক মূল্যায়ন', shortName: 'বার্ষিক', weight: 0.6, weightLabel: '৬০%', fullMarks: 100 },
]);

export const TERM_IDS = Object.freeze(TERMS.map((term) => term.id));

/** Canonical term keys used by new (hierarchical) database nodes. */
export const TERM_KEYS = Object.freeze({ TERM_1: 'term1', TERM_2: 'term2', FINAL: 'final' });

/**
 * `final` is the canonical name of the annual term; `annual` is the spelling
 * already persisted across the app. Both resolve to the same key so switching
 * spelling never forks a student's marks into two nodes.
 */
const TERM_KEY_ALIASES = Object.freeze({ final: 'annual', annual: 'annual' });

/** Normalises `final`/`annual`/`term1`/`term2` to the persisted term key. */
export const resolveTermKey = (term) => {
  const key = String(term ?? '').trim();
  if (!key) return '';
  return TERM_KEY_ALIASES[key] ?? key;
};

export const isFinalTerm = (term) => resolveTermKey(term) === 'annual';

/* ------------------------------------------------------------------ *
 * 5. Academic rules
 * ------------------------------------------------------------------ */
export const PASS_MARK = 33;
export const FULL_MARKS_PER_SUBJECT = 100;
export const GPA_SCALE = 5.0;

/** বাংলাদেশ শিক্ষা বোর্ডের মান অনুসারে গ্রেড সারণি (GPA 5.00 স্কেল) */
export const GRADE_SCALE = Object.freeze([
  { min: 80, max: 100, grade: 'A+', point: 5.0, label: 'অসাধারণ' },
  { min: 70, max: 79, grade: 'A', point: 4.0, label: 'উত্তম' },
  { min: 60, max: 69, grade: 'A-', point: 3.5, label: 'ভালো' },
  { min: 50, max: 59, grade: 'B', point: 3.0, label: 'মোটামুটি' },
  { min: 40, max: 49, grade: 'C', point: 2.0, label: 'সন্তোষজনক' },
  { min: 33, max: 39, grade: 'D', point: 1.0, label: 'উন্নতিসাধন প্রয়োজন' },
  { min: 0, max: 32, grade: 'F', point: 0.0, label: 'অকৃতকার্য' },
]);

export const GRADE_TONE_MAP = Object.freeze({
  'A+': 'emerald',
  A: 'emerald',
  'A-': 'sky',
  B: 'sky',
  C: 'amber',
  D: 'orange',
  F: 'rose',
});

/* ------------------------------------------------------------------ *
 * 6. Misc
 * ------------------------------------------------------------------ */
export const DEMO_SESSION = '২০২৬';

export const STORAGE_KEYS = Object.freeze({
  AUTH: 'resultweb:auth:v2',
  SCHOOL_DATA: 'resultweb:school-data:v2',
  UI: 'resultweb:ui:v1',
  /** Cached `…/schools/{schoolId}/teachers/{uid}` snapshot for instant paint. */
  MEMBERSHIP: 'resultweb:membership:v1',
});

export const BLOOD_GROUPS = Object.freeze(['A+', 'A-', 'B+', 'B-', 'O+', 'O-', 'AB+', 'AB-']);
export const RELIGIONS = Object.freeze(['ইসলাম', 'হিন্দু', 'বৌদ্ধ', 'খ্রিস্টান']);
export const GENDERS = Object.freeze([
  { id: 'male', name: 'পুরুষ' },
  { id: 'female', name: 'মহিলা' },
]);
export const GENDER_LABEL_MAP = Object.freeze({ male: 'ছাত্র', female: 'ছাত্রী' });
