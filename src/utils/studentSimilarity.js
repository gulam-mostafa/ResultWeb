/**
 * Weighted student similarity (০–১০০) — the rule behind the Excel import's
 * "same pupil?" decision.
 *
 * A candidate row is compared against every stored pupil of the school and scored:
 *
 * ```text
 * শিক্ষার্থীর নাম        (name)          ৩০ পয়েন্ট
 * মাতার নাম             (motherName)    ২৫ পয়েন্ট
 * ফোন                   (father/mother) ২৫ পয়েন্ট
 * জন্ম নিবন্ধন নম্বর     (birthRegNo)    ২০ পয়েন্ট
 *                                      ─────────────
 *                                      ১০০ পয়েন্ট
 * ```
 *
 * A total of **80 or more** means "this is the same pupil": the database roll is kept
 * and the row updates the existing record instead of creating a duplicate admission.
 *
 * Bangla digits are normalised to ASCII before any comparison, so `০১৭০০০০০০০০` and
 * `01700000000` are the same phone number and `১৯৯০…` / `1990…` the same birth
 * registration number.
 *
 * Everything here is PURE (no React, no Firebase) so the preview modal, the import
 * writer and the smoke test can never disagree about a match.
 */
import { toEnglishNumber } from './banglaNumberFormatter.js';

/** Field weights of the 100-point scale (they always sum to 100). */
export const SIMILARITY_WEIGHTS = Object.freeze({
  name: 30,
  motherName: 25,
  phone: 25,
  birthRegNo: 20,
});

/** At or above this total the existing database row wins (its roll is preserved). */
export const SIMILARITY_THRESHOLD = 80;

const round1 = (value) => Math.round((Number(value) || 0) * 10) / 10;

/** Bangla digits ➔ ASCII; every other character is left untouched. */
export const normalizeDigits = (value) => toEnglishNumber(
  value === null || value === undefined ? '' : value,
);

/** Digits only (Bangla digits understood), a leading country code `88` stripped. */
export function normalizeDigitsOnly(value) {
  const digits = normalizeDigits(value).replace(/[^0-9]/g, '');
  if (digits.length > 11 && digits.startsWith('88')) return digits.slice(2);
  return digits;
}

/** Phone in its comparable form (the last 11 digits of the national number). */
export function normalizePhone(value) {
  const digits = normalizeDigitsOnly(value);
  return digits.length > 11 ? digits.slice(-11) : digits;
}

/** Birth-registration / NID number in its comparable form. */
export const normalizeBirthReg = (value) => normalizeDigitsOnly(value);

/** Lower-cased, punctuation-free, space-collapsed name used for matching. */
export function normalizeName(value) {
  return normalizeDigits(value)
    .toLowerCase()
    .replace(/[.,;:'"()[\]{}\\|!?*#@&+=_~^%$`-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const bigramsOf = (text) => {
  const source = String(text ?? '').replace(/\s+/g, ' ');
  if (source.length < 2) return source ? [source] : [];
  const set = new Set();
  for (let index = 0; index < source.length - 1; index += 1) {
    set.add(source.slice(index, index + 2));
  }
  return [...set];
};

/**
 * Sørensen–Dice bigram similarity of two names (`0..1`).
 * Bangla spellings that differ by a single letter still score high, which is exactly
 * what a hand-typed Excel sheet needs.
 */
export function nameSimilarity(left, right) {
  const a = normalizeName(left);
  const b = normalizeName(right);
  if (!a || !b) return 0;
  if (a === b) return 1;
  // One name fully contains the other (`রুমি` / `রুমি আক্তার`) — a strong signal.
  if (a.length >= 3 && b.length >= 3 && (a.includes(b) || b.includes(a))) return 0.9;
  const first = bigramsOf(a);
  const second = bigramsOf(b);
  if (!first.length || !second.length) return 0;
  const pool = new Map();
  second.forEach((gram) => pool.set(gram, (pool.get(gram) ?? 0) + 1));
  let overlap = 0;
  first.forEach((gram) => {
    const count = pool.get(gram) ?? 0;
    if (count <= 0) return;
    overlap += 1;
    pool.set(gram, count - 1);
  });
  return (2 * overlap) / (first.length + second.length);
}

/** Phone identity: exact `1`, tail-of-number match `0.85`, otherwise `0`. */
export function phoneSimilarity(left, right) {
  const a = normalizePhone(left);
  const b = normalizePhone(right);
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.length >= 9 && b.length >= 9 && a.slice(-9) === b.slice(-9)) return 0.85;
  return 0;
}

/** Birth-registration identity: exact `1`, truncated-tail match `0.8`, otherwise `0`. */
export function birthRegSimilarity(left, right) {
  const a = normalizeBirthReg(left);
  const b = normalizeBirthReg(right);
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.length >= 6 && b.length >= 6 && (a.endsWith(b) || b.endsWith(a))) return 0.8;
  return 0;
}

/** The best phone signal across every phone column a record may carry. */
const phoneScoreOf = (incoming, existing) => {
  const incomingPhones = [incoming?.fatherPhone, incoming?.motherPhone, incoming?.guardianPhone];
  const existingPhones = [existing?.fatherPhone, existing?.motherPhone, existing?.guardianPhone];
  let best = 0;
  incomingPhones.forEach((left) => {
    existingPhones.forEach((right) => {
      best = Math.max(best, phoneSimilarity(left, right));
    });
  });
  return best;
};

/**
 * The best birth-registration signal.
 * `birthRegNo` is the database key and `birthCertificateNo` the UI one — both sides are
 * compared so a legacy row and a freshly imported row still match.
 */
const birthRegScoreOf = (incoming, existing) => {
  const incomingValues = [incoming?.birthCertificateNo, incoming?.birthRegNo];
  const existingValues = [existing?.birthCertificateNo, existing?.birthRegNo];
  let best = 0;
  incomingValues.forEach((left) => {
    existingValues.forEach((right) => {
      best = Math.max(best, birthRegSimilarity(left, right));
    });
  });
  return best;
};

/**
 * Weighted similarity of one incoming row against one stored pupil.
 *
 * @param {object} incoming row parsed from the Excel sheet
 * @param {object} existing stored roster row
 * @returns {{score:number, breakdown:object, signals:object}} `score` is 0–100
 */
export function similarityOf(incoming = {}, existing = {}) {
  const signals = {
    name: nameSimilarity(incoming?.name, existing?.name),
    motherName: nameSimilarity(incoming?.motherName, existing?.motherName),
    phone: phoneScoreOf(incoming, existing),
    birthRegNo: birthRegScoreOf(incoming, existing),
  };
  const breakdown = {
    name: round1(signals.name * SIMILARITY_WEIGHTS.name),
    motherName: round1(signals.motherName * SIMILARITY_WEIGHTS.motherName),
    phone: round1(signals.phone * SIMILARITY_WEIGHTS.phone),
    birthRegNo: round1(signals.birthRegNo * SIMILARITY_WEIGHTS.birthRegNo),
  };
  const score = round1(
    breakdown.name + breakdown.motherName + breakdown.phone + breakdown.birthRegNo,
  );
  return { score, breakdown, signals };
}

/**
 * Highest-scoring stored pupil for an incoming row.
 *
 * @param {object} incoming parsed Excel row
 * @param {Array<object>} existing every stored pupil of the school
 * @param {{threshold?:number}} [options] default 80 — returns `null` below it
 * @returns {{student:object, score:number, breakdown:object}|null}
 */
export function findBestMatch(incoming = {}, existing = [], { threshold = SIMILARITY_THRESHOLD } = {}) {
  const list = Array.isArray(existing) ? existing : [];
  let best = null;
  list.forEach((student) => {
    if (!student || student.classId === 'archive') return;
    const verdict = similarityOf(incoming, student);
    if (!best || verdict.score > best.score) best = { student, ...verdict };
  });
  if (!best || best.score < threshold) return null;
  return best;
}

export default {
  SIMILARITY_WEIGHTS,
  SIMILARITY_THRESHOLD,
  normalizeDigits,
  normalizeDigitsOnly,
  normalizePhone,
  normalizeBirthReg,
  normalizeName,
  nameSimilarity,
  phoneSimilarity,
  birthRegSimilarity,
  similarityOf,
  findBestMatch,
};
