/**
 * Authentication service.
 *
 * Deliberately backend-agnostic: the whole app talks to `AuthContext`, which in
 * turn only uses these functions. Swapping in Firebase Auth later means
 * re-implementing this file (signInWithRole → signInWithCustomToken / signInWithEmail)
 * without touching a single component.
 */

import { ROLES, STORAGE_KEYS } from '../utils/constants.js';
import { readJSON, writeJSON, removeKey } from './storageService.js';

/** Pre-seeded demo accounts – one per role. */
export const DEMO_ACCOUNTS = Object.freeze([
  {
    id: 'user-super-admin',
    role: ROLES.SUPER_ADMIN,
    name: 'মোঃ গোলাম মোস্তফা',
    designation: 'সুপার অ্যাডমিন (সিস্টেম পরিচালক)',
    email: 'golam.mostofa@resultweb.gov.bd',
    phone: '০১৭১২-৩৪৫৬৭৮',
    schoolId: null,
    avatarInitial: 'গ',
    scope: 'সকল বিদ্যালয় ও ডেটা নিয়ন্ত্রণ',
  },
  {
    id: 'user-school-admin',
    role: ROLES.SCHOOL_ADMIN,
    name: 'মোছাঃ সালমা আক্তার',
    designation: 'প্রধান শিক্ষক / শ্রেণি শিক্ষক',
    email: 'salma.akter@gps.gov.bd',
    phone: '',
    schoolId: '',
    status: 'approved',
    isFounder: false,
    canApprove: false,
    avatarInitial: 'শ',
    scope: 'শিক্ষার্থী, মার্কস এন্ট্রি ও ডকুমেন্ট',
  },
  {
    id: 'user-student-demo',
    role: ROLES.STUDENT,
    name: 'মোঃ সাকিব হাসান',
    designation: '৫ম শ্রেণি — রোল ০১',
    email: 'guardian.sakib@example.com',
    phone: '০১৯১১-২২৩৩৪৪',
    schoolId: '',
    studentId: 'stu-c5-01',
    avatarInitial: 'স',
    scope: 'নিজের ফলাফল ও সনদ (রিড-অনলি)',
  },
]);

const SESSION_DURATION_MS = 1000 * 60 * 60 * 12; // 12 hours

export const findDemoAccount = (role) => DEMO_ACCOUNTS.find((account) => account.role === role) ?? null;

/** Verifies the school's EMIS code + PIN pair. */
export function verifyEmisCredentials({ emisCode, pinCode, school }) {
  const target = school ?? {};
  const emis = String(emisCode ?? '').trim();
  const pin = String(pinCode ?? '').trim().toUpperCase();

  if (!emis || !pin) {
    return { ok: false, message: 'ইএমআইএস কোড ও পিন কোড উভয়ই পূরণ করুন।' };
  }
  if (emis !== String(target.emisCode)) {
    return { ok: false, message: 'ইএমআইএস কোড সঠিক নয়। ডেমো কোড: ১৩৩৭০১' };
  }
  if (pin !== String(target.pinCode).toUpperCase()) {
    return { ok: false, message: 'পিন কোড সঠিক নয়। ডেমো পিন: GZP-4821' };
  }
  return { ok: true, message: 'প্রতিষ্ঠান সফলভাবে যাচাই করা হয়েছে।' };
}

/**
 * Creates a session object for the given role.
 * In production this is where Firebase's `onAuthStateChanged` payload would land.
 */
export function createSession(role, overrides = {}) {
  const account = findDemoAccount(role);
  if (!account) return null;
  const now = Date.now();
  return {
    user: { ...account, ...overrides },
    issuedAt: now,
    expiresAt: now + SESSION_DURATION_MS,
    school: overrides.school ?? {},
  };
}

export function isSessionValid(session) {
  if (!session || !session.user) return false;
  if (!session.expiresAt) return true;
  return Date.now() < session.expiresAt;
}

export function persistSession(session) {
  return writeJSON(STORAGE_KEYS.AUTH, session);
}

export function readSession() {
  const session = readJSON(STORAGE_KEYS.AUTH, null);
  return isSessionValid(session) ? session : null;
}

export function clearSession() {
  return removeKey(STORAGE_KEYS.AUTH);
}

/** Role-aware landing route. */
export function landingRouteFor(role, user = null) {
  if (role === ROLES.SCHOOL_ADMIN && user?.status === 'pending') return '/pending-approval';
  if (role === ROLES.SCHOOL_ADMIN && user?.status === 'rejected') return '/pending-approval';
  switch (role) {
    case ROLES.SUPER_ADMIN:
      return '/dashboard';
    case ROLES.SCHOOL_ADMIN:
      return '/dashboard';
    case ROLES.STUDENT:
      return '/my-result';
    default:
      return '/';
  }
}

export default {
  DEMO_ACCOUNTS,
  findDemoAccount,
  verifyEmisCredentials,
  createSession,
  isSessionValid,
  persistSession,
  readSession,
  clearSession,
  landingRouteFor,
};
