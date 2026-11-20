import { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowUpRight, GraduationCap } from 'lucide-react';
import Modal from '../ui/Modal.jsx';
import { Badge } from '../ui/Primitives.jsx';
import { CLASS_LEVELS, NEXT_CLASS_MAP, getClassName } from '../../utils/constants.js';
import { toBanglaNumber, toBanglaOrdinal } from '../../utils/banglaNumberFormatter.js';
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
 * Count-based শাখা split, expressed as a pure function so it is testable and so the
 * modal and the store can never disagree.
 *
 * @param {Array<string>} meritIds  promoted pupils, best merit first
 * @param {{count?:number|string, mode?:'top'|'rest', targetSection?:string,
 *   sections?:string[]}} options
 *   - `top`:  the first `count` pupils go to `targetSection` (default `ক`), the rest
 *             go to the next available শাখা;
 *   - `rest`: the first `count` pupils STAY in `ক` (the first count is skipped) and
 *             the remaining pupils automatically go to `খ`.
 * @returns {Map<string,string>} `studentId ➔ section label`
 */
export function distributeByCount(meritIds = [], options = {}) {
  const {
    count = '', mode = 'top', targetSection = DEFAULT_SECTION_ID, sections = [],
  } = options;
  const wanted = cleanSection(targetSection);
  const others = collectSections(sections);
  const fallbackNext = others.find((section) => section !== wanted) ?? 'খ';
  const restTarget = others.find((section) => section !== DEFAULT_SECTION_ID) ?? 'খ';
  const limit = Math.max(0, Math.min(Number(count) || 0, meritIds.length));
  const map = new Map();

  meritIds.forEach((studentId, index) => {
    if (count === '' || count === null || limit === 0) {
      map.set(studentId, wanted);
      return;
    }
    if (mode === 'rest') {
      // "ক-তে যতজন থাকবে" — first count stays in `ক`, the rest go to `খ`.
      map.set(studentId, index < limit ? DEFAULT_SECTION_ID : restTarget);
      return;
    }
    // "ক-তে যতজন যাবে" — top count to the chosen শাখা, the rest elsewhere.
    map.set(studentId, index < limit ? wanted : fallbackNext);
  });
  return map;
}

export default function AutoPromotionModal({
  open,
  onClose,
  students = [],
  getStudentResult,
  getStudentClassRank,
  getClassRankMap,
  getSectionsOfClass,
  onExecute,
}) {
  const [classId, setClassId] = useState('c5');
  const [overrides, setOverrides] = useState({});     // {studentId: 'promote' | 'retain'}
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
    setTargetSection(DEFAULT_SECTION_ID);
    setFailSection(DEFAULT_SECTION_ID);
    setTopCount('');
    setSplitMode('top');
  }, [classId]);

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
   * Count-based শাখা split over the PASSED pupils, in merit order:
   *  - `top`:  the first N promoted pupils go to the selected শাখা (`ক` by default);
   *  - `rest`: the first N promoted pupils STAY in `ক` and the rest automatically go
   *            to the next শাখা (`খ`) — i.e. the first count is skipped.
   */
  const distribution = useMemo(() => {
    const passedIds = ranked
      .filter((row) => statusOf(row.student) === STATUS_PASS)
      .map((row) => row.student.id);
    return distributeByCount(passedIds, {
      count: topCount,
      mode: splitMode,
      targetSection,
      sections,
    });
  }, [ranked, statusOf, topCount, splitMode, targetSection, sections]);

  const sectionOf = (student) => (statusOf(student) === STATUS_PASS
    ? (distribution.get(student.id) ?? cleanSection(targetSection))
    : cleanSection(failSection));

  const passedCount = ranked.filter((row) => statusOf(row.student) === STATUS_PASS).length;
  const failedCount = ranked.length - passedCount;

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
          const key = sectionOf(row);
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
        <label><span className="label-base">{isGraduating ? 'পাসড আর্কাইভে যাবে' : 'উত্তীর্ণদের শাখা'}</span><select className="input-base py-1.5 text-xs" value={targetSection} onChange={(event) => setTargetSection(event.target.value)} disabled={isGraduating}>{sections.map((section) => <option key={section} value={section}>{section}</option>)}</select></label>
        <label><span className="label-base">এই ক্লাসেই থাকুকদের শাখা</span><select className="input-base py-1.5 text-xs" value={failSection} onChange={(event) => setFailSection(event.target.value)}>{sections.map((section) => <option key={section} value={section}>{section}</option>)}</select></label>
        <label><span className="label-base">বণ্টন পদ্ধতি</span><select className="input-base py-1.5 text-xs" value={splitMode} onChange={(event) => setSplitMode(event.target.value)}><option value="top">প্রথম যতজন → {cleanSection(targetSection)}</option><option value="rest">প্রথম যতজন {DEFAULT_SECTION_ID}-তে থাকবে, বাকিরা অন্য শাখায়</option></select></label>
        <label><span className="label-base">শিক্ষার্থী সংখ্যা</span><input className="input-base py-1.5 text-xs" type="number" min="0" value={topCount} onChange={(event) => setTopCount(event.target.value)} placeholder="যেমন ৩০" /></label>
        <label className="sm:col-span-2"><span className="label-base">কাস্টম শাখা (যেকোনো নাম লিখুন)</span><div className="flex gap-2"><input className="input-base py-1.5 text-xs" value={targetSection} onChange={(event) => setTargetSection(event.target.value)} placeholder={DEFAULT_SECTION_ID} aria-label="উত্তীর্ণদের শাখার নাম" disabled={isGraduating} /><input className="input-base py-1.5 text-xs" value={failSection} onChange={(event) => setFailSection(event.target.value)} placeholder={DEFAULT_SECTION_ID} aria-label="একই ক্লাসে থাকা শিক্ষার্থীদের শাখার নাম" /></div></label>
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
              <td><Badge tone={status === STATUS_PASS ? 'emerald' : 'amber'}>{sectionOf(row.student)}</Badge></td>
            </tr>;
          })}</tbody>
        </table>
      </div>

      <p className="text-xs text-slate-500"><b>মেধাক্রম</b> অনুযায়ী ১ম শিক্ষার্থী সবার উপরে; সব শাখার শিক্ষার্থীরা একসাথে দেখানো হয়েছে এবং প্রত্যেকের শাখা ব্যাজে লেখা আছে। ডিফল্টভাবে পাস করা শিক্ষার্থী <b>উত্তীর্ণ</b> ও ফেল করা শিক্ষার্থী <b>এই ক্লাসেই থাকুক</b> — যেকোনো শিক্ষার্থীর সিদ্ধান্ত বদলানো যাবে। “শিক্ষার্থী সংখ্যা” দিয়ে <b>{cleanSection(targetSection)}</b>-এ কতজন যাবে, অথবা {DEFAULT_SECTION_ID}-তে কতজন থাকবে তা নির্ধারণ করুন; দ্বিতীয় ক্ষেত্রে প্রথম গণনাটি বাদ দিয়ে বাকিরা স্বয়ংক্রিয়ভাবে <b>খ</b> শাখায় যাবে। ৫ম শ্রেণির উত্তীর্ণরা বছরভিত্তিক <b>passedArchive</b>-এ যাবে।</p>

      <div className="flex justify-end gap-2">
        <button className="btn-secondary" onClick={onClose}>বাতিল</button>
        <button className="btn-primary" onClick={execute} disabled={!ranked.length}><ArrowUpRight size={15}/> উত্তরণ কার্যকর ({toBanglaNumber(ranked.length)} জন)</button>
      </div>
    </div>
  </Modal>;
}

