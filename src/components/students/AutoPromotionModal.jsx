import { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowUpRight, GraduationCap, Undo2 } from 'lucide-react';
import Modal from '../ui/Modal.jsx';
import { Badge } from '../ui/Primitives.jsx';
import { CLASS_LEVELS, NEXT_CLASS_MAP, getClassName } from '../../utils/constants.js';
import { formatOfficialBanglaDate, toBanglaNumber, toBanglaOrdinal, toEnglishNumber } from '../../utils/banglaNumberFormatter.js';
import { DEFAULT_SECTION_ID } from '../../services/database/dbPaths.js';
import PromotionBadge from './PromotionBadge.jsx';
import StudentDetailsModal from './StudentDetailsModal.jsx';
import StudentResultModal from '../results/StudentResultModal.jsx';
import {
  PROMOTION_ORIGIN,
  PROMOTION_ORIGIN_LABELS,
  PROMOTION_SORT,
  PROMOTION_SORT_LABELS,
  promotionMonthKey,
  promotionMonthOptions,
  promotionOriginOf,
  sortPromotionRows,
} from '../../utils/promotionMeta.js';

const STATUS_PASS = 'promote';   // উত্তীর্ণ
const STATUS_FAIL = 'retain';    // এই ক্লাসেই থাকুক

/** Free-form শাখা label (blank falls back to `ক`). */
const cleanSection = (value) => String(value ?? '').trim() || DEFAULT_SECTION_ID;

/**
 * শাখা list of one class: the section registry first (`ক` …), then whatever the
 * supplied learners actually use, plus any free-form label already typed.
 */
const collectSections = (sections = [], ...extra) => {
  const all = [DEFAULT_SECTION_ID, ...(Array.isArray(sections) ? sections : []), ...extra.flat()]
    .map(cleanSection);
  const others = [...new Set(all)]
    .filter((section) => section !== DEFAULT_SECTION_ID)
    .sort((a, b) => a.localeCompare(b, 'bn'));
  return [DEFAULT_SECTION_ID, ...others];
};

/**
 * Parses a merit (মেধাক্রম) range such as `1-30`, `20-30`, `১-৩০` or `1 - 20`.
 * Both ASCII and Bangla digits are accepted; a reversed range is normalised.
 *
 * @param {string|number} value raw input of the "শিক্ষার্থী সংখ্যা" field
 * @returns {{start:number, end:number}|null} `null` when the value is not a range
 */
export function parseMeritRange(value) {
  const ascii = toEnglishNumber(value).trim();
  if (!ascii) return null;
  const match = ascii.match(/^(\d+)\s*(?:-|–|—|~|থেকে|to)\s*(\d+)$/i);
  if (!match) return null;
  const first = Number(match[1]);
  const second = Number(match[2]);
  if (!Number.isFinite(first) || !Number.isFinite(second)) return null;
  return {
    start: Math.max(1, Math.min(first, second)),
    end: Math.max(first, second),
  };
}

/** Parses a single (English or Bangla) count; `null` when the input is not a number. */
export function parseMeritCount(value) {
  const ascii = toEnglishNumber(value).trim();
  if (!/^\d+$/.test(ascii)) return null;
  return Math.max(0, Number(ascii));
}

/**
 * Count / merit-range based শাখা split, expressed as a pure function so it is
 * testable and so the modal and the store can never disagree.
 *
 * @param {Array<string>} meritIds  promoted pupils, best merit first
 * @param {{count?:number|string, mode?:'top'|'rest', targetSection?:string,
 *   sections?:string[]}} options
 *   - `top`:  the first `count` pupils go to `targetSection` (default `ক`), the rest
 *             go to the next available শাখা;
 *   - `rest`: the first `count` pupils STAY in `ক` (the first count is skipped) and
 *             the remaining pupils automatically go to `খ`.
 *   `count` may also be a merit range (`1-30`, `20-30`, `১-৩০`): exactly the pupils
 *   whose merit position falls inside the range go to the selected শাখা and everyone
 *   else goes to the other শাখা.
 *   `restSection` is the free-form label of that second bucket in `rest` mode (the
 *   second "কাস্টম শাখা" input); it falls back to the next declared শাখা.
 * @returns {Map<string,string>} `studentId ➔ section label`
 */
export function distributeByCount(meritIds = [], options = {}) {
  const {
    count = '', mode = 'top', targetSection = DEFAULT_SECTION_ID, sections = [],
    restSection = '',
  } = options;
  const wanted = cleanSection(targetSection);
  const others = collectSections(sections);
  const nextSection = others.find((section) => section !== DEFAULT_SECTION_ID) ?? 'খ';
  const fallbackNext = others.find((section) => section !== wanted) ?? 'খ';
  // A custom rest label only wins when it differs from `ক` (the default); otherwise the
  // first declared শাখা (`খ`) keeps receiving the pupils outside the count/range.
  const customRest = cleanSection(restSection || DEFAULT_SECTION_ID);
  const restTarget = customRest !== DEFAULT_SECTION_ID ? customRest : nextSection;
  // The bulk rule always has two buckets: the chosen one and "the other শাখা".
  const target = mode === 'rest' ? DEFAULT_SECTION_ID : wanted;
  const other = mode === 'rest' ? restTarget : fallbackNext;
  const range = parseMeritRange(count);
  const numeric = range ? null : parseMeritCount(count);
  const blank = range === null && numeric === null;
  const map = new Map();

  meritIds.forEach((studentId, index) => {
    if (blank) {
      map.set(studentId, wanted);
      return;
    }
    // Merit position is ১-ভিত্তিক — exactly the ordinal shown in the list.
    const position = index + 1;
    if (range) {
      // "১-৩০" / "২০-৩০" — inside the range ➔ chosen শাখা, outside ➔ the other one.
      const inside = position >= range.start && position <= range.end;
      map.set(studentId, inside ? target : other);
      return;
    }
    if (!numeric) {
      map.set(studentId, wanted);
      return;
    }
    // "প্রথম যতজন → শাখা" — the first count goes to the chosen bucket.
    map.set(studentId, position <= numeric ? target : other);
  });
  return map;
}

export default function AutoPromotionModal({
  open,
  onClose,
  students = [],
  defaultClassId = '',
  getStudentResult,
  getStudentClassRank,
  getClassRankMap,
  getSectionsOfClass,
  onExecute,
  /**
   * Year-scoped promotion (P0-3). When supplied, the modal confirms the batch with the
   * "নতুন শিক্ষাবর্ষ শুরু করবেন?" wording and the handler advances the academic year.
   */
  currentYear = '',
  nextYear = '',
  onAdvanceYear = null,
  /** Tenant id + active year — enables the read-only cross-year history viewer. */
  schoolId = '',
  activeYear = '',
  // Optional read-only context for the two drill-down popups (result + profile).
  // Without it the popups still open, they just show the marks-free view.
  allStudents = [],
  marks = {},
  getTermResult,
  getClassAnalytics,
  getResultConfig,
  getRemark,
  /**
   * Annual promotion state (বার্ষিক উত্তরণ): one year's log from the provider.
   * A class with a completion record shows a "সম্পূর্ণ" panel with an undo
   * action instead of the execute flow — it can never be promoted twice.
   */
  promotionState = null,
  /** `async (classId) => {synced, message?}` — undoes one class's promotion. */
  onUndoClass = null,
}) {
  const [classId, setClassId] = useState('c5');
  const [overrides, setOverrides] = useState({});     // {studentId: 'promote' | 'retain'}
  const [sectionOverrides, setSectionOverrides] = useState({}); // {studentId: 'ক' | 'খ' | …}
  const [targetSection, setTargetSection] = useState(DEFAULT_SECTION_ID);
  const [failSection, setFailSection] = useState(DEFAULT_SECTION_ID);
  const [splitMode, setSplitMode] = useState('top');  // 'top' | 'rest'
  const [topCount, setTopCount] = useState('');
  // Display-only controls: never affect the merit order used for roll assignment.
  const [monthFilter, setMonthFilter] = useState('');
  const [sortOrder, setSortOrder] = useState(PROMOTION_SORT.NEWEST);
  // Drill-down popups opened from a roster row (name ➔ profile, result ➔ result).
  const [profileTarget, setProfileTarget] = useState(null);
  const [resultTarget, setResultTarget] = useState(null);

  const nextClassId = NEXT_CLASS_MAP[classId];
  const isGraduating = nextClassId === 'archive';
  /**
   * Completion record of the selected class (`sessions/{year}/meta/promotion`).
   * While it exists the class is FROZEN: no execute, no decision change — only
   * the undo below, which the provider refuses when it would destroy newer data.
   */
  const completion = promotionState?.classes?.[classId] ?? null;
  const isClassComplete = Boolean(completion?.completedAt);
  const isClassCompleteFor = useCallback(
    (otherClassId) => Boolean(promotionState?.classes?.[otherClassId]?.completedAt),
    [promotionState],
  );
  /** Undo flow state: first click arms the confirm step, second click runs it. */
  const [undoArmed, setUndoArmed] = useState(false);
  const [undoBusy, setUndoBusy] = useState(false);
  const [undoMessage, setUndoMessage] = useState('');
  const requestUndo = async () => {
    if (!isClassComplete || undoBusy || !onUndoClass) return;
    if (!undoArmed) {
      setUndoArmed(true);
      setUndoMessage('');
      return;
    }
    setUndoBusy(true);
    const result = await onUndoClass(classId);
    setUndoBusy(false);
    setUndoArmed(false);
    if (result?.synced) {
      setUndoMessage('প্রমোশন ফেরানো হয়েছে — শ্রেণিটি আবার "প্রমোশন হয়নি" অবস্থায় ফিরেছে, পরের সালের ভর্তি ও আর্কাইভ মুছে গেছে। সক্রিয় সাল যেমন ছিল তেমনই আছে।');
    } else {
      setUndoMessage(result?.message || 'প্রমোশন ফেরানো যায়নি — আবার চেষ্টা করুন।');
    }
  };
  const classStudents = useMemo(
    () => students.filter((student) => student.classId === classId),
    [students, classId],
  );

  /**
   * Merit order of the WHOLE class (all শাখা together), ১st at the top.
   * One batched read of the class ranking keeps a large class linear; the published
   * merit position wins, then total marks, then the current roll.
   */
  const ranked = useMemo(() => {
    const rankMap = getClassRankMap ? getClassRankMap(classId) : null;
    const rows = classStudents.map((student) => {
      const row = rankMap?.get(student.id) ?? null;
      const live = row?.result ?? getStudentResult?.(student.id) ?? {};
      const published = Number(row?.position ?? getStudentClassRank?.(student.id)?.position ?? 0);
      return {
        student,
        published: Number.isFinite(published) && published > 0 ? published : null,
        hasAnyMark: row ? row.hasAnyMark : live.hasAnyMark === true,
        total: Number(row?.totalMarks ?? live.totalMarks) || 0,
        result: live,
      };
    });
    return [...rows].sort((a, b) => {
      if (a.published && b.published && a.published !== b.published) return a.published - b.published;
      if (Boolean(a.published) !== Boolean(b.published)) return a.published ? -1 : 1;
      if (b.total !== a.total) return b.total - a.total;
      return (Number(a.student.roll) || 0) - (Number(b.student.roll) || 0);
    });
  }, [classStudents, classId, getClassRankMap, getStudentClassRank, getStudentResult]);

  const sections = useMemo(
    () => collectSections(
      getSectionsOfClass ? getSectionsOfClass(classId) : [],
      classStudents.map((student) => student.section),
      isGraduating ? [] : (getSectionsOfClass ? getSectionsOfClass(nextClassId) : []),
      targetSection,
      failSection,
    ),
    [classId, nextClassId, classStudents, getSectionsOfClass, targetSection, failSection, isGraduating],
  );

  // A new class starts from the defaults: `উত্তীর্ণ`/`এই ক্লাসেই থাকুক` and শাখা `ক`.
  useEffect(() => {
    setOverrides({});
    setSectionOverrides({});
    setTargetSection(DEFAULT_SECTION_ID);
    setFailSection(DEFAULT_SECTION_ID);
    setTopCount('');
    setSplitMode('top');
    setMonthFilter('');
    setUndoArmed(false);
    setUndoMessage('');
  }, [classId]);

  // Opening the modal starts on the class the caller came from (the Results page
  // passes its selected class). Without a hint the roster keeps whatever the teacher
  // last picked, exactly as before.
  useEffect(() => {
    if (!open || !defaultClassId) return;
    if (!CLASS_LEVELS.some((level) => level.id === defaultClassId)) return;
    setOverrides({});
    setSectionOverrides({});
    setClassId((current) => (current === defaultClassId ? current : defaultClassId));
  }, [open, defaultClassId]);

  /** Fast lookup of the ranked row per pupil (avoids a linear scan per render). */
  const rowById = useMemo(() => new Map(ranked.map((row) => [row.student.id, row])), [ranked]);

  /**
   * Default status. Requirement: pass ➔ `উত্তীর্ণ`, fail ➔ `এই ক্লাসেই থাকুক`.
   *
   * A pupil with NO annual marks is never auto-promoted: the pass decision must come
   * from the consolidated annual result (`isPass`), so a missing marking sheet keeps the
   * pupil in the same class until the teacher explicitly chooses `উত্তীর্ণ` for that row.
   */
  const statusOf = useCallback((student) => {
    const decided = overrides[student.id];
    if (decided) return decided;
    const row = rowById.get(student.id);
    if (!row?.hasAnyMark) return STATUS_FAIL;
    return row.result?.isPass === false ? STATUS_FAIL : STATUS_PASS;
  }, [overrides, rowById]);

  /**
   * Count / merit-range based শাখা split over the PASSED pupils, in merit order:
   *  - `top`:  the first N promoted pupils go to the selected শাখা (`ক` by default);
   *  - `rest`: the first N promoted pupils STAY in `ক` and the rest automatically go
   *            to the next শাখা (`খ`) — i.e. the first count is skipped;
   *  - a range (`১-৩০`, `২০-৩০`) sends exactly the pupils inside that merit range to
   *    the selected শাখা and everyone else to the other one.
   */
  const distribution = useMemo(() => {
    const passedIds = ranked
      .filter((row) => statusOf(row.student) === STATUS_PASS)
      .map((row) => row.student.id);
    const options = { mode: splitMode, targetSection, sections, restSection: failSection };
    // A merit RANGE refers to the position shown in the মেধাক্রম column, which counts
    // every pupil of the class (all শাখা, passed or not) — so the window is computed
    // over the whole ranked list and then applied to the promoted pupils only.
    if (parseMeritRange(topCount)) {
      const byPosition = distributeByCount(
        ranked.map((row) => row.student.id),
        { ...options, count: topCount },
      );
      return new Map(passedIds.map((studentId) => [
        studentId,
        byPosition.get(studentId) ?? cleanSection(targetSection),
      ]));
    }
    return distributeByCount(passedIds, { ...options, count: topCount });
  }, [ranked, statusOf, topCount, splitMode, targetSection, failSection, sections]);

  /**
   * The two buckets of the bulk rule — exactly what `distributeByCount` uses:
   * inside-range/count pupils go to `primarySection`, everyone else to `otherSection`.
   */
  const { primarySection, otherSection } = useMemo(() => {
    const list = collectSections(sections);
    if (splitMode === 'rest') {
      // `rest` mode: `ক` keeps the first count, the rest follow the custom label (`খ`).
      const customRest = cleanSection(failSection || DEFAULT_SECTION_ID);
      return {
        primarySection: DEFAULT_SECTION_ID,
        otherSection: customRest !== DEFAULT_SECTION_ID
          ? customRest
          : (list.find((section) => section !== DEFAULT_SECTION_ID) ?? 'খ'),
      };
    }
    const primary = cleanSection(targetSection);
    return {
      primarySection: primary,
      otherSection: list.find((section) => section !== primary) ?? 'খ',
    };
  }, [splitMode, targetSection, failSection, sections]);

  /** Live preview of the typed merit range (`১-৩০`), `null` for a plain count. */
  const meritRange = useMemo(() => parseMeritRange(topCount), [topCount]);

  /**
   * Options of one row's "নতুন শাখা" picker: the declared class শাখা plus every label
   * the bulk rule currently hands out, so any pupil can be moved to any of them.
   */
  const sectionOptionsFor = useCallback(
    (current) => collectSections(
      sections,
      current,
      targetSection,
      failSection,
      otherSection,
      [...distribution.values()],
    ),
    [sections, targetSection, failSection, otherSection, distribution],
  );


  /**
   * Destination শাখা of one pupil. A manual pick on the row (`sectionOverrides`) always
   * wins over the bulk rule, so a teacher can move a single pupil afterwards; the
   * choice is forwarded to `executePromotion` and persisted by the store.
   */
  const sectionOf = (student) => {
    const manual = sectionOverrides[student.id];
    if (manual) return cleanSection(manual);
    return statusOf(student) === STATUS_PASS
      ? (distribution.get(student.id) ?? cleanSection(targetSection))
      : cleanSection(failSection);
  };

  const passedCount = ranked.filter((row) => statusOf(row.student) === STATUS_PASS).length;
  const failedCount = ranked.length - passedCount;
  /** Rows whose শাখা was picked by hand (overriding the bulk distribution). */
  const manualCount = Object.keys(sectionOverrides).length;
  /** `true` once the teacher confirmed the batch dialog — never skipped. */
  const [confirmed, setConfirmed] = useState(false);
  const [running, setRunning] = useState(false);
  /** A year advance is only offered when the caller supplies both years + the handler. */
  const canAdvanceYear = Boolean(onAdvanceYear && currentYear && nextYear);

  /**
   * How many pupils of the batch carry NO annual marks. They are never auto-promoted
   * silently: the confirmation dialog names them so the teacher decides explicitly.
   */
  const noMarksCount = ranked.filter((row) => !row.hasAnyMark).length;

  /* ------------------------------------------------------------------ *
   * Origin + promotion-month views (display only).
   *
   * Roll assignment always follows MERIT order (`ranked` above), exactly as the
   * campus store writes it. The controls below only decide WHICH rows are listed
   * and in what order they are painted, so a teacher can see, for example, the
   * pupils that arrived from class 1 inside class 2 without losing the merit view.
   * ------------------------------------------------------------------ */

  /** `{ [studentId]: 'promoted' | 'existing' }` inside the selected class. */
  const originById = useMemo(
    () => new Map(ranked.map((row) => [
      row.student.id,
      promotionOriginOf(row.student, classId),
    ])),
    [ranked, classId],
  );
  const promotedOriginCount = useMemo(
    () => [...originById.values()].filter((origin) => origin === PROMOTION_ORIGIN.PROMOTED).length,
    [originById],
  );
  const existingOriginCount = ranked.length - promotedOriginCount;

  /** Months of the pupils already promoted into THIS class (badges on screen). */
  const monthOptions = useMemo(() => promotionMonthOptions(classStudents), [classStudents]);

  /**
   * The list actually painted in the table: month filter, then the display sort.
   * `meritIndex` keeps the original merit position so the execute payload (which
   * must stay in merit order) can still be derived from `ranked`.
   */
  const visibleRows = useMemo(() => {
    const withMerit = ranked.map((row, index) => ({
      ...row,
      meritIndex: index,
      origin: originById.get(row.student.id) ?? PROMOTION_ORIGIN.EXISTING,
    }));
    const filtered = monthFilter
      ? withMerit.filter((row) => promotionMonthKey(row.student.promotedAt) === monthFilter)
      : withMerit;
    return sortPromotionRows(filtered, sortOrder);
  }, [ranked, originById, monthFilter, sortOrder]);

  /**
   * Asks for ONE explicit Bangla batch confirmation before ANY promotion write.
   * The counts shown are exactly what will be written: উত্তীর্ণ / একই শ্রেণিতে থাকবে /
   * আর্কাইভ.
   */
  const requestExecute = () => {
    // A completed class can never be promoted again — the panel above offers
    // the undo instead. (The button is disabled too; this is the second lock.)
    if (!ranked.length || running || isClassComplete) return;
    setConfirmed(true);
  };

  const confirmExecute = () => {
    if (!ranked.length || running) return;
    setRunning(true);
    // A year advance goes through the dedicated handler (it writes the NEW year only and
    // freezes the finished year); otherwise the in-year promotion writer is used.
    if (canAdvanceYear) {
      onAdvanceYear({
        year: currentYear,
        nextYear,
        decisions: ranked.map((row) => ({
          studentId: row.student.id,
          studentMasterId: row.student.studentMasterId || row.student.id,
          action: statusOf(row.student),
          section: sectionOf(row.student),
        })),
        fromClassId: classId,
        sections,
        passedCount,
        retainedCount: failedCount,
        archivedCount: isGraduating ? passedCount : 0,
      });
      setRunning(false);
      setConfirmed(false);
      onClose?.();
      return;
    }
    // The decision list is already in merit order, so the new rolls follow it.
    onExecute?.(
      ranked.map((row) => ({
        studentId: row.student.id,
        action: statusOf(row.student),
        section: sectionOf(row.student),
      })),
      {
        targetSections: sections,
        distribution: ranked.reduce((acc, row) => {
          const key = sectionOf(row.student);
          acc[key] = (acc[key] ?? 0) + 1;
          return acc;
        }, {}),
      },
    );
    setRunning(false);
    setConfirmed(false);
    onClose();
  };

  /**
   * The promotion modal must never close while a drill-down popup is open: Escape is
   * handled by BOTH dialogs (they listen on `document`), so the parent ignores the
   * key while a child popup is on screen and the child closes itself.
   */
  const closeParent = () => {
    if (profileTarget || resultTarget) return;
    onClose?.();
  };

  return <>
    <Modal open={open} onClose={closeParent} title="বার্ষিক শ্রেণি উত্তরণ" subtitle="মেধাক্রম অনুযায়ী উত্তীর্ণ / একই শ্রেণিতে রাখুন এবং শাখা বণ্টন" icon={GraduationCap} size="xl">
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <label><span className="label-base mb-0">শ্রেণি</span><select className="input-base max-w-xs" value={classId} onChange={(event) => setClassId(event.target.value)}>{CLASS_LEVELS.map((item) => <option key={item.id} value={item.id}>{item.name}{isClassCompleteFor(item.id) ? ' ✓ সম্পূর্ণ' : ''}</option>)}</select></label>
        <label><span className="label-base mb-0">পরবর্তী শ্রেণি</span><p className="input-base max-w-xs bg-slate-50 text-xs font-bold dark:bg-slate-800">{isGraduating ? 'আর্কাইভ (পাসড আর্কাইভ)' : getClassName(nextClassId)}</p></label>
        <Badge tone="emerald">উত্তীর্ণ: {toBanglaNumber(passedCount)}</Badge>
        <Badge tone="rose">এই ক্লাসেই থাকুক: {toBanglaNumber(failedCount)}</Badge>
        <Badge tone="sky">{PROMOTION_ORIGIN_LABELS[PROMOTION_ORIGIN.PROMOTED]}: {toBanglaNumber(promotedOriginCount)}</Badge>
        <Badge tone="slate">{PROMOTION_ORIGIN_LABELS[PROMOTION_ORIGIN.EXISTING]}: {toBanglaNumber(existingOriginCount)}</Badge>
      </div>

      {/* A completed class is frozen: what happened, and the safe way back. */}
      {isClassComplete ? (
        <div
          role="status"
          className="locked-view rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-sm dark:border-emerald-800 dark:bg-emerald-900/20"
        >
          <p className="text-base font-extrabold text-emerald-900 dark:text-emerald-100">
            এই শ্রেণির কার্যক্রম সম্পূর্ণ ✓
          </p>
          <div className="mt-2 space-y-1 text-[12px] font-semibold leading-relaxed text-emerald-900 dark:text-emerald-100">
            <p>
              {completion.completedAt ? `${formatOfficialBanglaDate(new Date(completion.completedAt))} · ` : ''}
              উত্তীর্ণ: <b>{toBanglaNumber(completion.promoted ?? 0)}</b> জন · একই শ্রেণিতে থাকবে: <b>{toBanglaNumber(completion.retained ?? 0)}</b> জন
              {completion.graduated ? <> · আর্কাইভ: <b>{toBanglaNumber(completion.graduated)}</b> জন</> : null}
              {completion.auto ? ' · (অটো-প্রমোশন)' : ''}
              {completion.completedByName ? ` · করেছেন: ${completion.completedByName}` : ''}
            </p>
            <p className="text-[11px] font-normal">
              এই শ্রেণির {toBanglaNumber(currentYear)} সালের তথ্য এখন লক — দেখা যাবে, এডিট করা যাবে না। আবার প্রমোশন করা যাবে না।
            </p>
          </div>
          {onUndoClass ? (
            <div className="mt-3">
              {undoArmed ? (
                <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-[12px] leading-relaxed text-amber-900 dark:bg-amber-900/30 dark:text-amber-100">
                  <p className="font-bold">প্রমোশন ফেরাবেন?</p>
                  <p className="mt-1">
                    পরের সালে ({toBanglaNumber(nextYear)}) এই শ্রেণির জন্য তৈরি ভর্তি ও আর্কাইভ মুছে যাবে, আর শ্রেণিটি আবার "প্রমোশন হয়নি" হবে। সক্রিয় সাল যেমন আছে তেমনই থাকবে।
                    পরের সালে নতুন ভর্তি হয়ে থাকলে বা কারো নম্বর/উপস্থিতি লেখা হয়ে থাকলে ফেরানো যাবে না।
                  </p>
                  <div className="mt-2 flex flex-wrap gap-2">
                    <button type="button" className="btn-primary btn-sm" onClick={requestUndo} disabled={undoBusy}>
                      <Undo2 size={14} /> {undoBusy ? 'ফেরানো হচ্ছে…' : 'হ্যাঁ, প্রমোশন ফেরান'}
                    </button>
                    <button type="button" className="btn-secondary btn-sm" onClick={() => setUndoArmed(false)} disabled={undoBusy}>
                      না, থাক
                    </button>
                  </div>
                </div>
              ) : (
                <button type="button" className="btn-secondary btn-sm" onClick={requestUndo} disabled={undoBusy}>
                  <Undo2 size={14} /> প্রমোশন ফেরান
                </button>
              )}
            </div>
          ) : null}
        </div>
      ) : null}
      {undoMessage ? (
        <p
          role="status"
          className={`rounded-lg p-2.5 text-[12px] font-semibold ${
            undoMessage.startsWith('প্রমোশন ফেরানো হয়েছে')
              ? 'bg-emerald-50 text-emerald-800'
              : 'bg-rose-50 text-rose-700'
          }`}
        >
          {undoMessage}
        </p>
      ) : null}

      <div className="grid gap-3 rounded-xl border border-slate-200 p-3 sm:grid-cols-2 lg:grid-cols-4">
        <label><span className="label-base">বণ্টন পদ্ধতি</span><select className="input-base py-1.5 text-xs" value={splitMode} onChange={(event) => setSplitMode(event.target.value)}><option value="top">প্রথম যতজন → {cleanSection(targetSection)}</option><option value="rest">প্রথম যতজন {DEFAULT_SECTION_ID}-তে থাকবে, বাকিরা অন্য শাখায়</option></select></label>
        <label><span className="label-base">শিক্ষার্থী সংখ্যা / মেধাক্রম</span><input className="input-base py-1.5 text-xs" type="text" inputMode="numeric" value={topCount} onChange={(event) => setTopCount(event.target.value)} placeholder="যেমন ৩০ বা ১-৩০" /></label>
        <label className="sm:col-span-2"><span className="label-base">কাস্টম শাখা (যেকোনো নাম লিখুন)</span><div className="flex gap-2"><input className="input-base py-1.5 text-xs" value={targetSection} onChange={(event) => setTargetSection(event.target.value)} placeholder={DEFAULT_SECTION_ID} aria-label="উত্তীর্ণদের শাখার নাম" disabled={isGraduating} /><input className="input-base py-1.5 text-xs" value={failSection} onChange={(event) => setFailSection(event.target.value)} placeholder={DEFAULT_SECTION_ID} aria-label="একই ক্লাসে থাকা শিক্ষার্থীদের শাখার নাম" /></div></label>
        <p className="text-[11px] leading-relaxed text-slate-500 sm:col-span-2 lg:col-span-4">{meritRange
          ? <>মেধাক্রম <b>{toBanglaNumber(meritRange.start)}–{toBanglaNumber(meritRange.end)}</b> এর শিক্ষার্থীরা <b>{primarySection}</b> শাখায়, বাকিরা <b>{otherSection}</b> শাখায় যাবে।</>
          : <>শুধু একটি সংখ্যা দিলে প্রথম ততজন <b>{primarySection}</b> শাখায় যাবে; <b>১-৩০</b> বা <b>২০-৩০</b> এর মতো মেধাক্রম রেঞ্জ দিলে ঠিক ওই অবস্থানের শিক্ষার্থীরা নির্বাচিত শাখায় যাবে।</>}</p>
      </div>

      <div className="flex flex-wrap items-end justify-between gap-2">
        <p className="text-[11px] font-semibold text-slate-500">মেধাক্রম অনুযায়ী তালিকা (সব শাখা একসাথে)</p>
        <div className="flex flex-wrap items-end gap-2">
          <label><span className="label-base mb-0">উত্তরণের মাস</span><select className="input-base min-w-40 py-1.5 text-xs" value={monthFilter} onChange={(event) => setMonthFilter(event.target.value)} aria-label="উত্তরণের মাস অনুযায়ী ফিল্টার"><option value="">সব মাস</option>{monthOptions.map((option) => <option key={option.key} value={option.key}>{option.label} ({toBanglaNumber(option.count)})</option>)}</select></label>
          <label><span className="label-base mb-0">ক্রম</span><select className="input-base min-w-44 py-1.5 text-xs" value={sortOrder} onChange={(event) => setSortOrder(event.target.value)} aria-label="উত্তরণের ক্রম"><option value={PROMOTION_SORT.NEWEST}>{PROMOTION_SORT_LABELS[PROMOTION_SORT.NEWEST]}</option><option value={PROMOTION_SORT.OLDEST}>{PROMOTION_SORT_LABELS[PROMOTION_SORT.OLDEST]}</option></select></label>
          {manualCount > 0 ? <button type="button" className="text-[11px] font-bold text-brand-700 underline" onClick={() => setSectionOverrides({})}>পৃথক শাখা পরিবর্তন রিসেট ({toBanglaNumber(manualCount)})</button> : null}
        </div>
      </div>
      <div className="max-h-80 overflow-auto rounded-xl border border-slate-200">
        <table className="table-base min-w-[980px]">
          <thead><tr><th>মেধাক্রম</th><th>রোল / নাম</th><th>শাখা</th><th>উৎস</th><th>ফলাফল</th><th>সিদ্ধান্ত</th><th>নতুন শাখা</th></tr></thead>
          <tbody>{visibleRows.map((row, index) => {
            const status = statusOf(row.student);
            const result = row.result;
            // A pupil who came from another class is "নতুন উত্তীর্ণ"; one who was
            // already in this class (including a retained pupil) is "এই শ্রেণিতেই ছিল".
            const promoted = row.origin === PROMOTION_ORIGIN.PROMOTED;
            return <tr key={row.student.id}>
              <td className="font-bold">{toBanglaOrdinal((row.meritIndex ?? index) + 1)}</td>
              <td>
                {/* The name opens the pupil's full profile popup. `stopPropagation`
                    keeps the click away from the row, so no promotion decision and no
                    select/checkbox is ever toggled by drilling into a pupil. */}
                <div className="flex flex-wrap items-center gap-1.5">
                  <button
                    type="button"
                    className="text-left hover:underline focus:outline-none focus-visible:underline"
                    onClick={(event) => { event.stopPropagation(); setProfileTarget(row.student); }}
                    aria-label={`${row.student.name} এর পূর্ণাঙ্গ তথ্য`}
                  >{toBanglaNumber(row.student.roll)} · {row.student.name}</button>
                  <PromotionBadge student={row.student} />
                </div>
              </td>
              <td><Badge tone="brand">{cleanSection(row.student.section)}</Badge></td>
              <td><Badge tone={promoted ? 'sky' : 'slate'}>{PROMOTION_ORIGIN_LABELS[row.origin]}</Badge></td>
              <td>
                {/* The result summary opens the detailed result popup of THIS pupil. */}
                <button
                  type="button"
                  className="text-left hover:underline focus:outline-none focus-visible:underline"
                  onClick={(event) => { event.stopPropagation(); setResultTarget(row.student); }}
                  aria-label={`${row.student.name} এর ফলাফল`}
                >{result.hasAnyMark ? `${result.grade} · GPA ${result.gpa?.toFixed(2)}` : 'ফলাফল নেই'}</button>
              </td>
              <td><select className="input-base min-w-40 py-1.5 text-xs" value={status} disabled={isClassComplete} onChange={(event) => setOverrides((previous) => ({ ...previous, [row.student.id]: event.target.value }))}><option value={STATUS_PASS}>{isGraduating ? 'উত্তীর্ণ (আর্কাইভ)' : 'উত্তীর্ণ'}</option><option value={STATUS_FAIL}>এই ক্লাসেই থাকুক</option></select></td>
              <td><select className="input-base min-w-28 py-1.5 text-xs" value={sectionOf(row.student)} disabled={isClassComplete} aria-label={`${row.student.name} এর নতুন শাখা`} onChange={(event) => setSectionOverrides((previous) => ({ ...previous, [row.student.id]: event.target.value }))}>{sectionOptionsFor(sectionOf(row.student)).map((option) => <option key={option} value={option}>{option}</option>)}</select></td>
            </tr>;
          })}</tbody>
        </table>
        {!visibleRows.length && <p className="py-8 text-center text-sm text-slate-400">এই মাসে কোনো শিক্ষার্থী পাওয়া যায়নি।</p>}
      </div>
      {monthFilter ? <p className="rounded-lg bg-amber-50 p-2.5 text-[11px] font-semibold text-amber-800 dark:bg-amber-900/30 dark:text-amber-200">ফিল্টার শুধু তালিকা দেখার জন্য — “উত্তরণ কার্যকর” চাপলে শ্রেণির <b>সব {toBanglaNumber(ranked.length)} জন</b> শিক্ষার্থীর সিদ্ধান্তই মেধাক্রম অনুযায়ী সংরক্ষিত হবে।</p> : null}

      <p className="text-xs text-slate-500"><b>মেধাক্রম</b> অনুযায়ী ১ম শিক্ষার্থী সবার উপরে; সব শাখার শিক্ষার্থীরা একসাথে দেখানো হয়েছে এবং প্রত্যেকের বর্তমান শাখা আলাদা কলামে লেখা আছে। <b>উৎস</b> কলামে <b>নতুন উত্তীর্ণ</b> মানে শিক্ষার্থী আগের শ্রেণি থেকে এসেছে, আর <b>এই শ্রেণিতেই ছিল</b> মানে সে আগে থেকেই এই শ্রেণিতে ছিল (যেমন ২য় শ্রেণিতে আগের শিক্ষার্থীদের সঙ্গে ১ম থেকে উত্তীর্ণরা যোগ দিলে)। ডিফল্টভাবে পাস করা শিক্ষার্থী <b>উত্তীর্ণ</b> ও ফেল করা শিক্ষার্থী <b>এই ক্লাসেই থাকুক</b> — যেকোনো শিক্ষার্থীর সিদ্ধান্ত বদলানো যাবে। “শিক্ষার্থী সংখ্যা / মেধাক্রম” ঘরে শুধু একটি সংখ্যা (যেমন <b>৩০</b>) দিলে প্রথম ততজন নির্বাচিত শাখায় যাবে; আর <b>১-৩০</b> বা <b>২০-৩০</b> এর মতো রেঞ্জ দিলে ঠিক ওই মেধাক্রমের শিক্ষার্থীরা নির্বাচিত শাখায় এবং বাকিরা অন্য শাখায় (<b>{otherSection}</b>) যাবে। ডান দিকের <b>নতুন শাখা</b> কলামে যেকোনো শিক্ষার্থীর শাখা আলাদাভাবে বদলানো যাবে এবং সেই পরিবর্তন বণ্টন নিয়মকে অগ্রাহ্য করে “উত্তরণ কার্যকর” এ সংরক্ষিত হবে। <b>উত্তরণের মাস</b> ও <b>ক্রম</b> শুধু তালিকা দেখার জন্য — উত্তরণ ও রোল বণ্টন সর্বদা মেধাক্রম অনুযায়ী হয়। উত্তরণের ৩ মাস (৯০ দিন) পর্যন্ত শিক্ষার্থীর নামের পাশে <b>মাস ও বছর</b> ব্যাজ দেখা যায়, এরপর ব্যাজটি সম্পূর্ণভাবে সরে যায়। ৫ম শ্রেণির উত্তীর্ণরা বছরভিত্তিক <b>passedArchive</b>-এ যাবে।</p>

      <div className="flex justify-end gap-2">
        <button className="btn-secondary" onClick={onClose}>বাতিল</button>
        <button className="btn-primary" onClick={requestExecute} disabled={!ranked.length || running || isClassComplete} title={isClassComplete ? 'এই শ্রেণির প্রমোশন সম্পূর্ণ হয়েছে — আবার করা যাবে না' : undefined}><ArrowUpRight size={15}/> {isClassComplete ? 'প্রমোশন সম্পূর্ণ ✓' : `উত্তরণ কার্যকর (${toBanglaNumber(ranked.length)} জন)`}</button>
      </div>

      {/* একক ব্যাচ নিশ্চিতকরণ — কোনো লেখার আগে একটি বাংলা ডায়ালগ। */}
      {confirmed ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="বার্ষিক উত্তরণ নিশ্চিতকরণ"
          className="rounded-xl border-2 border-brand-500 bg-brand-50 p-4 text-sm dark:border-brand-400 dark:bg-brand-900/30"
        >
          <p className="text-base font-extrabold text-brand-900 dark:text-brand-100">
            {canAdvanceYear ? 'নতুন শিক্ষাবর্ষ শুরু করবেন?' : 'বার্ষিক শ্রেণি উত্তরণ নিশ্চিত করুন'}
          </p>
          <div className="mt-2 space-y-1.5 text-[12px] font-semibold leading-relaxed text-brand-900 dark:text-brand-100">
            {canAdvanceYear ? (
              <>
                <p className="rounded-lg bg-white/70 p-2.5 dark:bg-slate-900/50">
                  {toBanglaNumber(currentYear)} শিক্ষাবর্ষ শেষ করে {toBanglaNumber(nextYear)} শিক্ষাবর্ষ শুরু হবে।
                </p>
                <p className="rounded-lg bg-white/70 p-2.5 dark:bg-slate-900/50">
                  উত্তীর্ণ: <b>{toBanglaNumber(passedCount)}</b> জন · একই শ্রেণিতে থাকবে: <b>{toBanglaNumber(failedCount)}</b> জন
                  {' · '}আর্কাইভ: <b>{toBanglaNumber(isGraduating ? passedCount : 0)}</b> জন
                </p>
                <p className="text-[11px] font-normal">
                  নতুন ক্লাসের রেজাল্ট <b>০০</b> থেকে শুরু হবে। গত বছরের রেজাল্ট ও মন্তব্য ইতিহাসে থাকবে, মুছে যাবে না।
                </p>
                {noMarksCount > 0 ? (
                  <p className="text-[11px] font-bold text-amber-800 dark:text-amber-200">
                    নম্বর ছাড়া {toBanglaNumber(noMarksCount)} জন আছেন — তাঁরা ডিফল্টভাবে <b>একই শ্রেণিতে</b> থাকছেন; উত্তীর্ণ করতে চাইলে ওই সারির সিদ্ধান্ত নিজে বদলান।
                  </p>
                ) : null}
              </>
            ) : (
              <>
                <p className="rounded-lg bg-white/70 p-2.5 dark:bg-slate-900/50">
                  <b>{getClassName(classId)}</b> শ্রেণির {toBanglaNumber(ranked.length)} জন শিক্ষার্থীর সিদ্ধান্ত এখন সংরক্ষিত হবে।
                </p>
                <p className="rounded-lg bg-white/70 p-2.5 dark:bg-slate-900/50">
                  উত্তীর্ণ: <b>{toBanglaNumber(passedCount)}</b> জন · একই শ্রেণিতে থাকবে: <b>{toBanglaNumber(failedCount)}</b> জন
                  {isGraduating ? <> · আর্কাইভ: <b>{toBanglaNumber(passedCount)}</b> জন</> : null}
                </p>
                <p className="text-[11px] font-normal">
                  নতুন শ্রেণিতে রোল মেধাক্রম অনুযায়ী আবার শুরু হবে; আগের ফলাফল ইতিহাসে অপরিবর্তিত থাকবে।
                </p>
              </>
            )}
          </div>
          <div className="mt-3 flex flex-wrap justify-end gap-2">
            <button type="button" className="btn-secondary btn-sm" onClick={() => setConfirmed(false)}>
              না, বাতিল করুন
            </button>
            <button type="button" className="btn-primary btn-sm" onClick={confirmExecute} disabled={running}>
              <ArrowUpRight size={14} /> {canAdvanceYear ? 'হ্যাঁ, শুরু করুন' : 'হ্যাঁ, উত্তরণ করুন'}
            </button>
          </div>
        </div>
      ) : null}
    </div>
    </Modal>
    {/* Drill-down popups — inspection only, the promotion state underneath is untouched. */}
    <StudentDetailsModal
      open={Boolean(profileTarget)}
      onClose={() => setProfileTarget(null)}
      student={profileTarget
        ? (allStudents.find((item) => item.id === profileTarget.id) ?? profileTarget)
        : null}
      marks={marks}
      allStudents={allStudents.length ? allStudents : students}
      getTermResult={getTermResult}
      getStudentResult={getStudentResult}
      getClassAnalytics={getClassAnalytics}
      getResultConfig={getResultConfig}
      schoolId={schoolId}
      activeYear={activeYear}
    />
    <StudentResultModal
      open={Boolean(resultTarget)}
      onClose={() => setResultTarget(null)}
      student={resultTarget
        ? (allStudents.find((item) => item.id === resultTarget.id) ?? resultTarget)
        : null}
      marks={marks}
      getStudentResult={getStudentResult}
      getTermResult={getTermResult}
      getClassAnalytics={getClassAnalytics}
      getResultConfig={getResultConfig}
      getRemark={getRemark}
    />
  </>;
}

