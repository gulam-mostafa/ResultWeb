/**
 * datasetService — the browser-cache layer for a school's full workspace document.
 *
 * The dataset (students, marks, remarks, notices, meta, audits) is persisted as one
 * atomic document per tenant so a partial write can never corrupt a school's data.
 * Firestore/RTDB remain the source of truth; this is the offline-first read cache.
 */

import { DEMO_SESSION, STORAGE_KEYS, SUBJECTS } from '../../utils/constants.js';
import { createDemoStudents, createDemoMarks, REMARK_BANK } from '../../utils/demoSeedData.js';
import { computeStudentResult } from '../../utils/gradingCalculator.js';
import { classifyPerformance } from '../../utils/remarkGenerator.js';
import { readJSON, writeJSON, removeKey } from '../storageService.js';

export const SCHEMA_VERSION = 1;

function buildRemarks(students, marks) {
  const remarks = {};
  students.forEach((student) => {
    if (!marks[student.id]) return;
    const result = computeStudentResult(marks[student.id]);
    const tone = classifyPerformance(result);
    const bank = REMARK_BANK[tone] ?? REMARK_BANK.average;
    remarks[student.id] = bank[student.roll % bank.length];
  });
  return remarks;
}

const NOTICES = [
  {
    id: 'notice-1',
    title: 'বার্ষিক পরীক্ষার রুটিন প্রকাশ',
    body: 'আগামী ১৫ ডিসেম্বর থেকে বার্ষিক মূল্যায়ন শুরু হবে। সকল শিক্ষার্থীকে সকাল ৯টার মধ্যে বিদ্যালয়ে উপস্থিত থাকার জন্য অনুরোধ করা হচ্ছে।',
    date: '2026-11-10',
    tone: 'info',
  },
  {
    id: 'notice-2',
    title: 'অভিভাবক সমাবেশ',
    body: 'প্রতি শ্রেণির অভিভাবকদের নিয়ে ২৮ নভেম্বর সকাল ১০টায় অভিভাবক সমাবেশ অনুষ্ঠিত হবে। উপস্থিতি একান্ত কাম্য।',
    date: '2026-11-05',
    tone: 'success',
  },
  {
    id: 'notice-3',
    title: 'শিক্ষার্থী ভর্তি চলছে',
    body: `${DEMO_SESSION} শিক্ষাবর্ষে প্রাক-প্রাথমিক শ্রেণিতে ভর্তি চলছে। জন্ম নিবন্ধন সনদসহ বিদ্যালয় কার্যালয়ে যোগাযোগ করুন।`,
    date: '2026-10-28',
    tone: 'warning',
  },
];

/**
 * Assembles the full demo dataset.
 * @returns {{meta:object, students:Array, marks:object, remarks:object, notices:Array, audits:Array}}
 */
export function createInitialDataset() {
  const students = createDemoStudents();
  const marks = createDemoMarks(students);
  const remarks = buildRemarks(students, marks);

  return {
    meta: {
      schemaVersion: SCHEMA_VERSION,
      session: DEMO_SESSION,
      schoolId: '',
      schoolName: '',
      sessionStartedAt: new Date().toISOString(),
      lastPromotionAt: null,
      promotionLog: [],
      updatedAt: new Date().toISOString(),
    },
    students,
    marks,
    remarks,
    notices: NOTICES,
    audits: [
      {
        id: 'audit-seed',
        at: new Date().toISOString(),
        action: 'system.seed',
        detail: `ডেমো ডেটা প্রস্তুত — ${students.length} জন শিক্ষার্থী`,
        actor: 'system',
      },
    ],
    subjects: SUBJECTS,
  };
}

/* ------------------------------------------------------------------ *
 * Persistence
 * ------------------------------------------------------------------ */

/** Tenant-scoped local cache key: a browser must never paint another school's data. */
const datasetStorageKey = (schoolId = '') => `${STORAGE_KEYS.SCHOOL_DATA}:${encodeURIComponent(String(schoolId || 'local'))}`;

/** Loads the current tenant's persisted dataset, or null when absent / invalid. */
export function loadPersistedDataset(schoolId = '') {
  const data = readJSON(datasetStorageKey(schoolId), null);
  if (!data || typeof data !== 'object') return null;
  if (data?.meta?.schemaVersion !== SCHEMA_VERSION) return null;
  if (!Array.isArray(data.students) || !data.marks) return null;
  if (String(data.meta?.schoolId || '') !== String(schoolId || '')) return null;
  return data;
}

export function persistDataset(dataset) {
  const schoolId = dataset?.meta?.schoolId || '';
  return writeJSON(datasetStorageKey(schoolId), dataset);
}

export function clearPersistedDataset(schoolId = '') {
  return removeKey(datasetStorageKey(schoolId));
}

export default {
  SCHEMA_VERSION,
  createInitialDataset,
  loadPersistedDataset,
  persistDataset,
  clearPersistedDataset,
};
