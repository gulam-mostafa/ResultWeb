/**
 * Promotion (উত্তরণ) metadata helpers.
 *
 * Every helper here is PURE so the promotion modal, the roster table and the
 * student profile all agree on one interpretation of `promotedAt` /
 * `promotedFromClass` / `isNewPromotion`:
 *
 *  - a pupil promoted within the last 90 days carries a Bengali month+year badge
 *    (`নভেম্বর ২০২৬`); after 90 days the badge is dropped from the DOM entirely;
 *  - a pupil whose `promotedFromClass` differs from the class they now sit in is a
 *    NEW arrival (promoted), otherwise they were already in the class (repeating).
 *
 * No React import: the module is consumed by components, hooks and the smoke test.
 */
import { formatBanglaMonthYear } from './banglaNumberFormatter.js';

/** A promotion badge is shown for 3 months (≈ 90 days) after `promotedAt`. */
export const PROMOTION_BADGE_DAYS = 90;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Origin of one pupil inside the class they currently sit in. */
export const PROMOTION_ORIGIN = Object.freeze({
  PROMOTED: 'promoted',   // came from a previous class (নতুন উত্তীর্ণ)
  EXISTING: 'existing',   // was already in this class (এই শ্রেণিতেই ছিল)
});

export const PROMOTION_ORIGIN_LABELS = Object.freeze({
  [PROMOTION_ORIGIN.PROMOTED]: 'নতুন উত্তীর্ণ',
  [PROMOTION_ORIGIN.EXISTING]: 'এই শ্রেণিতেই ছিল',
});

/** Sort orders of the promotion list (display only). */
export const PROMOTION_SORT = Object.freeze({
  NEWEST: 'newest', // নতুন উত্তীর্ণ উপরে
  OLDEST: 'oldest', // পুরাতন উপরে
});

export const PROMOTION_SORT_LABELS = Object.freeze({
  [PROMOTION_SORT.NEWEST]: 'নতুন উত্তীর্ণ উপরে',
  [PROMOTION_SORT.OLDEST]: 'পুরাতন উপরে',
});

/** Parses a stored timestamp into a valid `Date`, or `null`. */
export function toPromotionDate(value) {
  if (!value) return null;
  const parsed = value instanceof Date ? value : new Date(value);
  return parsed instanceof Date && !Number.isNaN(parsed.getTime()) ? parsed : null;
}

/** `promotedAt` of one roster row (timestamp / ISO string), or `null`. */
export const promotedAtOf = (student) =>
  toPromotionDate(student?.promotedAt ?? student?.promotedOn ?? null);

/**
 * Whole days between the promotion and `now`.
 * A future stamp (clock skew) clamps to `0`, so a badge is never negative.
 */
export function daysSincePromotion(promotedAt, now = new Date()) {
  const from = toPromotionDate(promotedAt);
  const to = toPromotionDate(now) ?? new Date();
  if (!from) return null;
  const diff = Math.floor((to.getTime() - from.getTime()) / MS_PER_DAY);
  return diff < 0 ? 0 : diff;
}


/** `true` while the pupil still belongs to the "freshly promoted" 3-month window. */
export function isWithinPromotionWindow(promotedAt, now = new Date(), days = PROMOTION_BADGE_DAYS) {
  const elapsed = daysSincePromotion(promotedAt, now);
  return elapsed !== null && elapsed <= days;
}

/** `YYYY-MM` key of a promotion stamp — the value the month filter compares. */
export function promotionMonthKey(promotedAt) {
  const date = toPromotionDate(promotedAt);
  if (!date) return '';
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

/** `নভেম্বর ২০২৬` label of a promotion stamp (blank when unknown). */
export const promotionMonthLabel = (promotedAt) => formatBanglaMonthYear(toPromotionDate(promotedAt));

/**
 * Badge view-model of one pupil: `{ label, monthKey, days, promotedAt }` while the
 * promotion is younger than `days`, otherwise `null` (nothing is rendered at all).
 */
export function promotionBadgeOf(student, now = new Date(), days = PROMOTION_BADGE_DAYS) {
  const date = promotedAtOf(student);
  if (!date) return null;
  const elapsed = daysSincePromotion(date, now);
  if (elapsed === null || elapsed > days) return null;
  return {
    label: promotionMonthLabel(date),
    monthKey: promotionMonthKey(date),
    days: elapsed,
    promotedAt: date.toISOString(),
  };
}

/**
 * Origin of one pupil inside `classId`:
 *  - `promoted` when they carry a `promotedFromClass` that differs from the class
 *    they now sit in (or an explicit `isNewPromotion` marker);
 *  - `existing` otherwise — a pupil who was already in the class, INCLUDING one who
 *    was retained there (`promotedFromClass === classId`).
 */
export function promotionOriginOf(student, classId = student?.classId) {
  const fromClass = String(student?.promotedFromClass ?? '').trim();
  const current = String(classId ?? student?.classId ?? '').trim();
  if (fromClass && current && fromClass !== current) return PROMOTION_ORIGIN.PROMOTED;
  if (student?.isNewPromotion === true && fromClass && (!current || fromClass !== current)) {
    return PROMOTION_ORIGIN.PROMOTED;
  }
  return PROMOTION_ORIGIN.EXISTING;
}

/** `true` when the pupil arrived through a promotion (নতুন উত্তীর্ণ). */
export const isNewlyPromoted = (student, classId = student?.classId) =>
  promotionOriginOf(student, classId) === PROMOTION_ORIGIN.PROMOTED;

/**
 * Month filter options of a roster, newest month first:
 * `[{ key: '2026-11', label: 'নভেম্বর ২০২৬', count }]`.
 * Only stamps inside the badge window are listed, so the filter matches the badges.
 */
export function promotionMonthOptions(students = [], now = new Date()) {
  const map = new Map();
  (Array.isArray(students) ? students : []).forEach((student) => {
    const badge = promotionBadgeOf(student, now);
    if (!badge?.monthKey) return;
    const entry = map.get(badge.monthKey);
    if (entry) entry.count += 1;
    else map.set(badge.monthKey, { key: badge.monthKey, label: badge.label, count: 1 });
  });
  return [...map.values()].sort((a, b) => b.key.localeCompare(a.key));
}

/**
 * Display order of the promotion list. Roll assignment always stays in merit order
 * (the caller keeps its merit-ordered list for the write); this only re-orders rows.
 *
 * @param {Array<object>} rows rows carrying `student` (and optionally `published`)
 * @param {'newest'|'oldest'} order
 * @param {(student:object)=>string|null} [monthOf] month key accessor
 */
export function sortPromotionRows(rows = [], order = PROMOTION_SORT.NEWEST, monthOf = (student) => promotionMonthKey(promotedAtOf(student))) {
  const list = Array.isArray(rows) ? [...rows] : [];
  const keyed = list.map((row, index) => ({ row, index, key: String(monthOf(row.student) ?? '') }));
  keyed.sort((a, b) => {
    // Pupils with no promotion stamp keep their merit order at the end.
    if (!a.key && !b.key) return a.index - b.index;
    if (!a.key) return 1;
    if (!b.key) return -1;
    return (order === PROMOTION_SORT.OLDEST ? a.key.localeCompare(b.key) : b.key.localeCompare(a.key))
      || a.index - b.index;
  });
  return keyed.map((entry) => entry.row);
}

/**
 * The promotion metadata patch of one promoted pupil. Written to the year's
 * enrollment row (and mirrored into the local dataset) so a refresh replays the
 * exact same "who came from where" answer.
 */
export const promotionPatchOf = ({ at, fromClass, fromYear } = {}) => ({
  promotedAt: at ?? new Date().toISOString(),
  promotedFromClass: fromClass ?? '',
  promotedFromYear: fromYear ?? '',
  isNewPromotion: true,
});

/** The clearing patch used when a pupil is retained (`এই ক্লাসেই থাকুক`). */
export const retainedPatch = () => ({
  promotedAt: null,
  promotedFromClass: null,
  promotedFromYear: null,
  isNewPromotion: false,
});

export default {
  PROMOTION_BADGE_DAYS,
  PROMOTION_ORIGIN,
  PROMOTION_ORIGIN_LABELS,
  PROMOTION_SORT,
  PROMOTION_SORT_LABELS,
  promotedAtOf,
  daysSincePromotion,
  isWithinPromotionWindow,
  promotionMonthKey,
  promotionMonthLabel,
  promotionBadgeOf,
  promotionOriginOf,
  isNewlyPromoted,
  promotionMonthOptions,
  sortPromotionRows,
  promotionPatchOf,
  retainedPatch,
};
