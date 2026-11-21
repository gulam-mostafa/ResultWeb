import { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowUpRight, GraduationCap } from 'lucide-react';
import Modal from '../ui/Modal.jsx';
import { Badge } from '../ui/Primitives.jsx';
import { CLASS_LEVELS, NEXT_CLASS_MAP, getClassName } from '../../utils/constants.js';
import { toBanglaNumber, toBanglaOrdinal, toEnglishNumber } from '../../utils/banglaNumberFormatter.js';
import { DEFAULT_SECTION_ID } from '../../services/database/dbPaths.js';

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
}) {
  const [classId, setClassId] = useState('c5');
  const [overrides, setOverrides] = useState({});     // {studentId: 'promote' | 'retain'}
  const [sectionOverrides, setSectionOverrides] = useState({}); // {studentId: 'ক' | 'খ' | …}
  const [targetSection, setTargetSection] = useState(DEFAULT_SECTION_ID);
  const [failSection, setFailSection] = useState(DEFAULT_SECTION_ID);
  const [splitMode, setSplitMode] = useState('top');  // 'top' | 'rest'
  const [topCount, setTopCount] = useState('');

  const nextClassId = NEXT_CLASS_MAP[classId];
  const isGraduating = nextClassId === 'archive';
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
   * A pupil whose marks were never entered has no failure to show, so they default
   * to `উত্তীর্ণ` (the teacher can still switch any row to `এই ক্লাসেই থাকুক`).
   */
  const statusOf = useCallback((student) => {
    const decided = overrides[student.id];
    if (decided) return decided;
    const row = rowById.get(student.id);
    return row?.hasAnyMark && row?.result?.isPass === false ? STATUS_FAIL : STATUS_PASS;
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

  const execute = () => {
    if (!ranked.length) return;
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
    onClose();
  };

  return <Modal open={open} onClose={onClose} title="বার্ষিক শ্রেণি উত্তরণ" subtitle="মেধাক্রম অনুযায়ী উত্তীর্ণ / একই শ্রেণিতে রাখুন এবং শাখা বণ্টন" icon={GraduationCap} size="xl">
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <label><span className="label-base mb-0">শ্রেণি</span><select className="input-base max-w-xs" value={classId} onChange={(event) => setClassId(event.target.value)}>{CLASS_LEVELS.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
        <label><span className="label-base mb-0">পরবর্তী শ্রেণি</span><p className="input-base max-w-xs bg-slate-50 text-xs font-bold dark:bg-slate-800">{isGraduating ? 'আর্কাইভ (পাসড আর্কাইভ)' : getClassName(nextClassId)}</p></label>
        <Badge tone="emerald">উত্তীর্ণ: {toBanglaNumber(passedCount)}</Badge>
        <Badge tone="rose">এই ক্লাসেই থাকুক: {toBanglaNumber(failedCount)}</Badge>
      </div>

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
        {manualCount > 0 ? <button type="button" className="text-[11px] font-bold text-brand-700 underline" onClick={() => setSectionOverrides({})}>পৃথক শাখা পরিবর্তন রিসেট ({toBanglaNumber(manualCount)})</button> : null}
      </div>
      <div className="max-h-80 overflow-auto rounded-xl border border-slate-200">
        <table className="table-base min-w-[720px]">
          <thead><tr><th>মেধাক্রম</th><th>রোল / নাম</th><th>শাখা</th><th>ফলাফল</th><th>সিদ্ধান্ত</th><th>নতুন শাখা</th></tr></thead>
          <tbody>{ranked.map((row, index) => {
            const status = statusOf(row.student);
            const result = row.result;
            return <tr key={row.student.id}>
              <td className="font-bold">{toBanglaOrdinal(index + 1)}</td>
              <td>{toBanglaNumber(row.student.roll)} · {row.student.name}</td>
              <td><Badge tone="brand">{cleanSection(row.student.section)}</Badge></td>
              <td>{result.hasAnyMark ? `${result.grade} · GPA ${result.gpa?.toFixed(2)}` : 'ফলাফল নেই'}</td>
              <td><select className="input-base min-w-40 py-1.5 text-xs" value={status} onChange={(event) => setOverrides((previous) => ({ ...previous, [row.student.id]: event.target.value }))}><option value={STATUS_PASS}>{isGraduating ? 'উত্তীর্ণ (আর্কাইভ)' : 'উত্তীর্ণ'}</option><option value={STATUS_FAIL}>এই ক্লাসেই থাকুক</option></select></td>
              <td><select className="input-base min-w-28 py-1.5 text-xs" value={sectionOf(row.student)} aria-label={`${row.student.name} এর নতুন শাখা`} onChange={(event) => setSectionOverrides((previous) => ({ ...previous, [row.student.id]: event.target.value }))}>{sectionOptionsFor(sectionOf(row.student)).map((option) => <option key={option} value={option}>{option}</option>)}</select></td>
            </tr>;
          })}</tbody>
        </table>
      </div>

      <p className="text-xs text-slate-500"><b>মেধাক্রম</b> অনুযায়ী ১ম শিক্ষার্থী সবার উপরে; সব শাখার শিক্ষার্থীরা একসাথে দেখানো হয়েছে এবং প্রত্যেকের বর্তমান শাখা আলাদা কলামে লেখা আছে। ডিফল্টভাবে পাস করা শিক্ষার্থী <b>উত্তীর্ণ</b> ও ফেল করা শিক্ষার্থী <b>এই ক্লাসেই থাকুক</b> — যেকোনো শিক্ষার্থীর সিদ্ধান্ত বদলানো যাবে। “শিক্ষার্থী সংখ্যা / মেধাক্রম” ঘরে শুধু একটি সংখ্যা (যেমন <b>৩০</b>) দিলে প্রথম ততজন নির্বাচিত শাখায় যাবে; আর <b>১-৩০</b> বা <b>২০-৩০</b> এর মতো রেঞ্জ দিলে ঠিক ওই মেধাক্রমের শিক্ষার্থীরা নির্বাচিত শাখায় এবং বাকিরা অন্য শাখায় (<b>{otherSection}</b>) যাবে। ডান দিকের <b>নতুন শাখা</b> কলামে যেকোনো শিক্ষার্থীর শাখা আলাদাভাবে বদলানো যাবে এবং সেই পরিবর্তন বণ্টন নিয়মকে অগ্রাহ্য করে “উত্তরণ কার্যকর” এ সংরক্ষিত হবে। ৫ম শ্রেণির উত্তীর্ণরা বছরভিত্তিক <b>passedArchive</b>-এ যাবে।</p>

      <div className="flex justify-end gap-2">
        <button className="btn-secondary" onClick={onClose}>বাতিল</button>
        <button className="btn-primary" onClick={execute} disabled={!ranked.length}><ArrowUpRight size={15}/> উত্তরণ কার্যকর ({toBanglaNumber(ranked.length)} জন)</button>
      </div>
    </div>
  </Modal>;
}

