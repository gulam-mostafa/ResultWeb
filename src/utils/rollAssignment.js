/**
 * Roll-number assignment helpers — the ONE place that decides which roll a pupil
 * receives inside a class + শাখা (section) bucket.
 *
 * The rules the roster screen relies on:
 *  - a roll is unique inside ONE `classId` + `section` pair only (the same number in
 *    another class or another শাখা is perfectly legal);
 *  - a pupil that keeps a free roll keeps it, otherwise the next number AFTER the
 *    highest existing roll is handed out — a conflicting roll is never written;
 *  - `এক শ্রেণি নিচে যাবে` (move down) always lands at the very END of the target list;
 *  - legacy rows may carry a suffix notation (`১-১`, `2-2`); those parse to `0` and
 *    are therefore never treated as an occupied number — the pupil is renumbered with
 *    a clean single roll.
 *
 * Everything here is PURE, so the edit modal, the roster hook and the promotion
 * writer can never disagree about a roll.
 */
import { toEnglishNumber } from './banglaNumberFormatter.js';

export const DEFAULT_SECTION_LABEL = 'ক';

/** A blank শাখা label falls back to the school's default `ক`. */
export const cleanSectionLabel = (section, fallback = DEFAULT_SECTION_LABEL) =>
  String(section ?? '').trim() || fallback;

/**
 * Positive integer roll of a stored row, or `0` when it is not a plain number
 * (`''`, `null`, `1-1`, `২-২` …). Bangla digits are understood.
 */
export function normalizeRoll(value) {
  const ascii = toEnglishNumber(value).trim();
  if (!ascii) return 0;
  const numeric = Number(ascii);
  if (!Number.isFinite(numeric) || numeric < 1) return 0;
  return Math.round(numeric);
}

/** Every `{classId, section}` identity pair as one comparable key. */
export const rollBucketKey = (classId, section) =>
  `${String(classId ?? '').trim()}::${cleanSectionLabel(section)}`;

/** `true` when the row belongs to exactly that class + শাখা. */
export const isInRollBucket = (student, classId, section) => Boolean(student)
  && String(student.classId ?? '').trim() === String(classId ?? '').trim()
  && cleanSectionLabel(student.section) === cleanSectionLabel(section);

/**
 * Roll numbers already in use inside one class + শাখা (duplicates collapsed).
 *
 * @param {Array<object>} roster every pupil of the school
 * @param {{classId?:string, section?:string, ignoreIds?:Array<string>}} options
 *   `ignoreIds` are the pupil(s) being written — their own row never blocks itself.
 * @returns {number[]} sorted, unique, positive rolls
 */
export function bucketRolls(roster = [], { classId = '', section = '', ignoreIds = [] } = {}) {
  const ignored = new Set((Array.isArray(ignoreIds) ? ignoreIds : [ignoreIds])
    .filter(Boolean)
    .map((id) => String(id)));
  return [...new Set(
    (Array.isArray(roster) ? roster : [])
      .filter((student) => student && !ignored.has(String(student.id ?? '')))
      .filter((student) => isInRollBucket(student, classId, section))
      .map((student) => normalizeRoll(student.roll))
      .filter((roll) => roll > 0),
  )].sort((left, right) => left - right);
}

/** Highest roll in one class + শাখা (`0` when the bucket is empty). */
export function highestRollInBucket(roster = [], options = {}) {
  const rolls = bucketRolls(roster, options);
  return rolls.length ? rolls[rolls.length - 1] : 0;
}

/** Next free roll — always AFTER the highest one already in that folder. */
export function nextFreeRollInBucket(roster = [], options = {}) {
  return highestRollInBucket(roster, options) + 1;
}

/** `true` when the roll is not used by any other pupil of that class + শাখা. */
export function isRollFree(roster = [], { classId = '', section = '', roll, ignoreIds = [] } = {}) {
  const wanted = normalizeRoll(roll);
  if (!wanted) return false;
  return !bucketRolls(roster, { classId, section, ignoreIds }).includes(wanted);
}

/**
 * The roll a pupil actually receives.
 *
 * @param {Array<object>} roster every pupil of the school
 * @param {{classId?:string, section?:string, roll?:string|number,
 *   ignoreIds?:Array<string>, placement?:'preferred'|'end'}} options
 *   - `preferred`: keep `roll` when it is still free in the destination folder
 *     (a শাখা change / an admission that typed a free number);
 *   - `end`: always the next number after the highest one
 *     (`এক শ্রেণি নিচে যাবে`, a restore into an occupied class).
 * @returns {number} a positive, non-conflicting roll
 */
export function resolveRollAssignment(roster = [], {
  classId = '', section = '', roll, ignoreIds = [], placement = 'preferred',
} = {}) {
  const options = { classId, section, ignoreIds };
  if (placement !== 'end') {
    const preferred = normalizeRoll(roll);
    if (preferred && isRollFree(roster, { ...options, roll: preferred })) return preferred;
  }
  return nextFreeRollInBucket(roster, options);
}

/**
 * Rolls of ONE destination bucket (class + শাখা), in the order the caller lists them:
 * `incoming` (promoted in from a lower class) first, then `staying` (pupils of the
 * same class that were re-decided in this batch), then `residents`.
 * Numbers are consecutive single integers starting at `startAt`.
 */
export function assignBucketRolls({ incoming = [], staying = [], residents = [] } = {}, startAt = 1) {
  const out = new Map();
  let next = Math.max(1, Number(startAt) || 1);
  [...incoming, ...staying, ...residents].forEach((id) => {
    const key = String(id ?? '').trim();
    if (!key || out.has(key)) return;
    out.set(key, next);
    next += 1;
  });
  return out;
}

/**
 * Roll plan of one promotion batch, keyed by pupil id (`Map<id, roll>`).
 *
 * Rules (requirement: zero duplicate rolls, ever):
 *  - a bucket that RECEIVES pupils promoted from a lower class hands out clean
 *    `১, ২, ৩…` in merit order to those pupils; pupils already present in that class
 *    (including the ones kept with `এই শ্রেণিতেই থাকুক`) are renumbered AFTER them —
 *    the staying ones in merit order, then the untouched residents in their current
 *    roll order;
 *  - a bucket that receives nobody keeps its residents' numbers; only invalid /
 *    suffixed (`১-১`) and duplicated ones are renumbered, and the batch's own pupils
 *    are placed at the very end of the list.
 *
 * @param {object} options
 * @param {Array<{id?:string, studentId?:string, action?:'promote'|'retain',
 *   targetClassId?:string, classId?:string, section?:string}>} options.entries
 *   the batch decisions in MERIT order (১ম first); `classId` is the DESTINATION.
 * @param {Array<object>} options.roster every pupil row (`id`, `classId`, `section`, `roll`)
 * @param {Array<string>|Set<string>} [options.movingIds] pupils handled by the batch
 * @param {(student:object)=>number} [options.meritOf] optional published merit position
 * @returns {Map<string, number>}
 */
export function planPromotionRolls({ entries = [], roster = [], movingIds = [], meritOf } = {}) {
  const rows = Array.isArray(roster) ? roster.filter(Boolean) : [];
  const movingList = movingIds instanceof Set ? [...movingIds] : (Array.isArray(movingIds) ? movingIds : []);
  const moving = new Set(
    movingList.map((id) => String(id ?? '').trim()).filter(Boolean),
  );
  if (moving.size === 0) {
    (Array.isArray(entries) ? entries : []).forEach((entry) => {
      const id = String(entry?.id ?? entry?.studentId ?? '').trim();
      if (id) moving.add(id);
    });
  }

  /** `classId::section` ➔ the three ordered buckets of that destination folder. */
  const buckets = new Map();
  const bucketOf = (classId, section) => {
    const key = rollBucketKey(classId, section);
    if (!buckets.has(key)) {
      buckets.set(key, {
        classId: String(classId ?? '').trim(),
        section: cleanSectionLabel(section),
        incoming: [],
        staying: [],
        residents: [],
      });
    }
    return buckets.get(key);
  };

  (Array.isArray(entries) ? entries : []).forEach((entry) => {
    const id = String(entry?.id ?? entry?.studentId ?? '').trim();
    const targetClassId = String(entry?.targetClassId ?? entry?.classId ?? '').trim();
    if (!id || !targetClassId || targetClassId === 'archive') return;
    const bucket = bucketOf(targetClassId, entry.section);
    if (entry.action === 'retain') bucket.staying.push(id);
    else bucket.incoming.push(id);
  });

  // Everybody already sitting in a destination folder is a resident of that folder.
  rows.forEach((student) => {
    const id = String(student?.id ?? '').trim();
    if (!id) return;
    const bucket = buckets.get(rollBucketKey(student.classId, student.section));
    if (!bucket || moving.has(id)) return;
    bucket.residents.push(student);
  });

  const plan = new Map();
  const rowById = new Map(rows.map((student) => [String(student?.id ?? ''), student]));
  buckets.forEach((bucket) => {
    const rankOf = (student) => {
      const merit = Number(meritOf?.(student));
      return Number.isFinite(merit) && merit > 0 ? merit : Number.POSITIVE_INFINITY;
    };
    // Residents are ordered by merit, then by their existing position; a row whose
    // roll is invalid/duplicated/`১-১` has no position, so it goes to the end.
    const positionOf = (student) => {
      const roll = normalizeRoll(student.roll);
      return roll > 0 ? roll : Number.MAX_SAFE_INTEGER;
    };
    const byExistingOrder = (left, right) => (
      rankOf(left) - rankOf(right)
      || positionOf(left) - positionOf(right)
      || String(left.name ?? '').localeCompare(String(right.name ?? ''), 'bn')
    );
    const residents = [...bucket.residents].sort(byExistingOrder);

    if (bucket.incoming.length === 0) {
      // Nobody new arrives (everybody is `এই শ্রেণিতেই থাকুক`). A staying pupil keeps
      // the roll they already hold when it is valid and unique; only the invalid /
      // duplicated ones are repaired, and each renumbered pupil goes to the end.
      const used = new Set();
      const repair = [];
      const kept = [];
      residents.forEach((student) => {
        const roll = normalizeRoll(student.roll);
        const id = String(student.id);
        if (roll && !used.has(roll)) {
          used.add(roll);
          kept.push([id, roll]);
        } else {
          repair.push(student);
        }
      });
      let next = [...used].reduce((max, roll) => Math.max(max, roll), 0) + 1;
      const tail = [];
      // A staying pupil that already had a valid, unused roll keeps it.
      bucket.staying.forEach((id) => {
        const own = normalizeRoll(rowById.get(String(id))?.roll);
        if (own && !used.has(own)) {
          used.add(own);
          kept.push([id, own]);
          return;
        }
        tail.push([id, next]);
        next += 1;
      });
      repair.forEach((student) => {
        tail.push([String(student.id), next]);
        next += 1;
      });
      [...kept, ...tail].forEach(([id, roll]) => plan.set(id, roll));
      return;
    }

    // Pupils arriving from a lower class take ১..n in merit order; everybody who was
    // already in the class follows, so no two pupils can ever share a roll.
    assignBucketRolls({
      incoming: bucket.incoming,
      staying: bucket.staying,
      residents: residents.map((student) => String(student.id)),
    }).forEach((roll, id) => plan.set(id, roll));
  });

  return plan;
}

export default {
  DEFAULT_SECTION_LABEL,
  cleanSectionLabel,
  normalizeRoll,
  rollBucketKey,
  isInRollBucket,
  bucketRolls,
  highestRollInBucket,
  nextFreeRollInBucket,
  isRollFree,
  resolveRollAssignment,
  assignBucketRolls,
  planPromotionRolls,
};
