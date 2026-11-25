import { useEffect, useMemo, useState } from 'react';
import { GraduationCap, History, Pencil } from 'lucide-react';
import Modal from '../ui/Modal.jsx';
import { CLASS_LEVELS, CLASS_LABEL_MAP, TERMS } from '../../utils/constants.js';
import { toBanglaNumber } from '../../utils/banglaNumberFormatter.js';
import PromotionBadge from './PromotionBadge.jsx';
import { promotionMonthLabel, promotionOriginOf, PROMOTION_ORIGIN_LABELS } from '../../utils/promotionMeta.js';
import { getStudentCrossYearHistory } from '../../services/database/index.js';

const value = (item) => item || '—';
const Info = ({ label, value: content }) => <div className="rounded-lg bg-slate-50 p-3 dark:bg-slate-800"><p className="text-xs text-slate-500">{label}</p><p className="mt-1 break-words text-sm font-semibold">{value(content)}</p></div>;

/**
 * One stored subject entry of a historical snapshot (`{formative, summative, total}`).
 * An explicit `total` always wins; only a real component pair is summed.
 */
const snapshotTotal = (entry) => {
  if (!entry || typeof entry !== 'object') return null;
  if (entry.total !== null && entry.total !== undefined) return Number(entry.total);
  const formative = Number(entry.formative);
  const summative = Number(entry.summative);
  if (Number.isFinite(formative) || Number.isFinite(summative)) {
    return (Number.isFinite(formative) ? formative : 0) + (Number.isFinite(summative) ? summative : 0);
  }
  return null;
};

export default function StudentDetailsModal({
  open,
  onClose,
  student,
  marks = {},
  allStudents = [],
  getTermResult,
  getStudentResult,
  getClassAnalytics,
  getResultConfig,
  onEdit,
  /** Tenant id — enables the read-only cross-year history viewer. */
  schoolId = '',
  /** Default year of the history viewer (the school's active year). */
  activeYear = '',
}) {
  const initialClass = student?.classId === 'archive' ? (student?.previousClassId || 'c5') : (student?.classId || 'pre');
  const [classId, setClassId] = useState(initialClass);
  useEffect(() => setClassId(initialClass), [student?.id, initialClass]);
  const currentClassId = CLASS_LEVELS.some((item) => item.id === classId) ? classId : initialClass;
  const classStudents = allStudents.filter((item) => item.classId === currentClassId);
  const studentMarks = marks?.[student?.id] ?? {};
  const annual = getStudentResult?.(student?.id) ?? { hasAnyMark: false, subjects: [], grade: '—', gpa: null };
  const termResults = useMemo(() => TERMS.map((term) => {
    const result = getTermResult?.(student?.id, term.id) ?? {};
    const rankRows = classStudents.map((classStudent) => ({
      studentId: classStudent.id,
      total: getTermResult?.(classStudent.id, term.id)?.totalMarks ?? 0,
      hasAnyMark: getTermResult?.(classStudent.id, term.id)?.hasAnyMark ?? false,
    })).filter((row) => row.hasAnyMark).sort((left, right) => right.total - left.total);
    const position = rankRows.findIndex((row) => row.studentId === student?.id);
    return { term, result, position, classSize: rankRows.length };
  }), [student?.id, marks, classStudents, getTermResult]);
  const ranked = getClassAnalytics?.(currentClassId)?.rows ?? [];
  const position = ranked.findIndex((row) => row.studentId === student?.id);
  // The school's own class configuration supplies the subject rows (custom names,
  // full marks and the গাঠনিক/সামষ্টিক split all flow through here).
  const classConfig = getResultConfig?.(currentClassId) ?? null;
  const subjects = (classConfig?.subjects ?? []).map((subject) => ({
    ...subject,
    annual: annual.subjects?.find((item) => item.id === subject.id) ?? null,
  }));

  /* ------------------------------------------------------------------ *
   * Historical (read-only) snapshots — শিক্ষাবর্ষ ➔ শ্রেণি ➔ প্রান্তিক
   *
   * A past academic year is FROZEN history: this viewer only READS
   * `sessions/{year}/students` + `sessions/{year}/results` (via
   * `getStudentCrossYearHistory`), so inspecting an old marksheet can never
   * rewrite it. Defaults to the current year / class / annual term.
   * ------------------------------------------------------------------ */
  const [history, setHistory] = useState(null);
  const [historyYear, setHistoryYear] = useState(activeYear || '');
  const [historyTerm, setHistoryTerm] = useState('annual');
  const [historyState, setHistoryState] = useState('idle'); // idle | loading | ready | error
  const studentMasterId = student?.studentMasterId || student?.id || '';

  useEffect(() => {
    if (!open || !schoolId || !studentMasterId) {
      setHistory(null);
      setHistoryState('idle');
      return undefined;
    }
    let active = true;
    setHistoryState('loading');
    getStudentCrossYearHistory(schoolId, studentMasterId)
      .then((data) => {
        if (!active) return;
        setHistory(data);
        setHistoryState('ready');
        const years = (data?.years ?? []).map((entry) => entry.year);
        const wanted = activeYear && years.includes(activeYear) ? activeYear : (years[0] ?? '');
        setHistoryYear((current) => (current && years.includes(current) ? current : wanted));
      })
      .catch(() => {
        if (!active) return;
        setHistory(null);
        setHistoryState('error');
      });
    return () => { active = false; };
  }, [open, schoolId, studentMasterId, activeYear]);

  /** `[{year, classId, roll}]`, newest first — the শিক্ষাবর্ষ selector's options. */
  const historyYears = useMemo(
    () => (history?.years ?? []).map((entry) => ({ year: entry.year, classId: entry.classId, roll: entry.roll })),
    [history],
  );
  const historyEntry = useMemo(
    () => (history?.years ?? []).find((entry) => entry.year === historyYear) ?? null,
    [history, historyYear],
  );
  const historyRow = historyEntry?.terms?.[historyTerm] ?? null;
  /** Subject rows of the frozen snapshot, using the class's own (current) subject names. */
  const historySubjects = useMemo(() => {
    const configSubjects = getResultConfig?.(historyEntry?.classId)?.subjects ?? [];
    return Object.entries(historyRow?.subjects ?? {}).map(([subjectId, entry]) => ({
      id: subjectId,
      name: configSubjects.find((item) => item.id === subjectId)?.name ?? subjectId,
      formative: entry?.formative ?? null,
      summative: entry?.summative ?? null,
      total: snapshotTotal(entry),
    }));
  }, [historyRow, historyEntry, getResultConfig]);
  const historyTermName = TERMS.find((term) => term.id === historyTerm)?.name ?? historyTerm;

  return <Modal open={open} onClose={onClose} title="শিক্ষার্থীর পূর্ণাঙ্গ তথ্য" subtitle={student?.name ?? ''} icon={GraduationCap} size="xl">
    {student && <div className="space-y-5">
      <section><h3 className="mb-2 text-sm font-bold">ব্যক্তিগত ও ভর্তি তথ্য</h3><div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        <Info label="নাম" value={<span className="inline-flex flex-wrap items-center gap-1.5">{student.name}<PromotionBadge student={student} /></span>} /><Info label="রোল" value={toBanglaNumber(student.roll)} /><Info label="শ্রেণি" value={CLASS_LEVELS.find((item) => item.id === student.classId)?.name ?? (student.classId === 'archive' ? 'আর্কাইভ' : '—')} />
        <Info label="ভর্তির সাল" value={toBanglaNumber(student.admissionYear || student.admissionDate?.slice?.(0, 4))} /><Info label="লিঙ্গ" value={student.gender === 'female' ? 'ছাত্রী' : 'ছাত্র'} /><Info label="জন্ম তারিখ" value={student.birthDate} />
        <Info label="জন্ম নিবন্ধন নম্বর" value={student.birthCertificateNo} /><Info label="পিতার নাম" value={student.fatherName} /><Info label="পিতার মোবাইল" value={student.fatherPhone || student.guardianPhone} />
        <Info label="মাতার নাম" value={student.motherName} /><Info label="মাতার মোবাইল" value={student.motherPhone} /><Info label="অভিভাবকের ভোটার আইডি" value={student.guardianNid} />
        <Info label="ঠিকানা" value={student.address} />
        <Info label="উৎস" value={PROMOTION_ORIGIN_LABELS[promotionOriginOf(student, student.classId)]} />
        <Info label="উত্তরণের মাস" value={promotionMonthLabel(student.promotedAt)} />
        <Info label="পূর্ববর্তী শ্রেণি" value={CLASS_LEVELS.find((item) => item.id === student.promotedFromClass)?.name ?? (student.promotedFromClass || '')} />
      </div></section>
      <section>
        <div className="mb-2 flex flex-wrap items-center justify-between gap-3"><h3 className="text-sm font-bold">প্রান্তিক ও বার্ষিক ফলাফল</h3><label className="flex items-center gap-2 text-xs font-semibold">শ্রেণি <select className="input-base py-1.5" value={currentClassId} onChange={(event) => setClassId(event.target.value)}>{CLASS_LEVELS.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label></div>
        <div className="mb-3 grid gap-2 sm:grid-cols-2">{termResults.map(({ term, result, position: termPosition, classSize }) => <div key={term.id} className="rounded-lg bg-slate-50 p-3 dark:bg-slate-800"><p className="text-xs font-bold text-slate-500">{term.name}</p><p className="mt-1 text-sm font-semibold">মোট {toBanglaNumber(result.totalMarks ?? 0)} · GPA {result.gpa?.toFixed?.(2) ?? '—'} · গ্রেড {result.grade ?? '—'}</p><p className="text-xs text-slate-500">মেধাক্রম {termPosition >= 0 ? `${toBanglaNumber(termPosition + 1)} / ${toBanglaNumber(classSize)}` : '—'}</p></div>)}<Info label="বার্ষিক মেধাক্রম" value={position >= 0 ? `${toBanglaNumber(position + 1)} / ${toBanglaNumber(ranked.length)}` : '—'} /></div>
        <div className="overflow-x-auto rounded-xl border border-slate-200 dark:border-slate-700"><table className="table-base min-w-[580px]"><thead><tr><th>বিষয়</th>{TERMS.map((term) => <th key={term.id}>{term.name}</th>)}<th>বার্ষিক গ্রেড</th></tr></thead><tbody>{subjects.map((subject) => {
          const subjectMarks = studentMarks?.[subject.id] ?? {};
          return <tr key={subject.id}><td>{subject.name}</td>{TERMS.map((term) => <td key={term.id}>{subjectMarks[term.id] == null ? '—' : toBanglaNumber(subjectMarks[term.id])}</td>)}<td>{subject.annual?.grade ?? '—'}</td></tr>;
        })}</tbody></table></div>
        <p className="mt-2 text-xs text-slate-500">বার্ষিক ফল: মোট {toBanglaNumber(annual.totalMarks ?? 0)} · GPA {annual.gpa?.toFixed?.(2) ?? '—'} · গ্রেড {annual.grade ?? '—'}</p>
      </section>
      {schoolId ? <section className="rounded-xl border border-slate-200 p-3 dark:border-slate-700">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <h3 className="inline-flex items-center gap-1.5 text-sm font-bold"><History size={15} aria-hidden="true" /> ঐতিহাসিক ফলাফল (রিড-অনলি)</h3>
          <div className="flex flex-wrap items-end gap-2">
            <label className="text-xs font-semibold"><span className="label-base mb-0">শিক্ষাবর্ষ</span>
              <select className="input-base py-1.5 text-xs" value={historyYear} onChange={(event) => setHistoryYear(event.target.value)} disabled={!historyYears.length} aria-label="ঐতিহাসিক শিক্ষাবর্ষ">
                {historyYears.length ? historyYears.map((entry) => <option key={entry.year} value={entry.year}>{toBanglaNumber(entry.year)}{entry.classId ? ` · ${CLASS_LABEL_MAP[entry.classId] ?? entry.classId}` : ''}</option>) : <option value="">—</option>}
              </select>
            </label>
            <label className="text-xs font-semibold"><span className="label-base mb-0">প্রান্তিক</span>
              <select className="input-base py-1.5 text-xs" value={historyTerm} onChange={(event) => setHistoryTerm(event.target.value)} aria-label="ঐতিহাসিক প্রান্তিক">
                {TERMS.map((term) => <option key={term.id} value={term.id}>{term.name}</option>)}
              </select>
            </label>
          </div>
        </div>
        {historyState === 'loading' ? <p role="status" className="py-4 text-center text-xs font-semibold text-slate-500">ইতিহাস লোড হচ্ছে…</p>
          : historyState === 'error' ? <p role="alert" className="rounded-lg bg-rose-50 p-2.5 text-[11px] font-semibold text-rose-700">ইতিহাস লোড করা যায়নি; আবার চেষ্টা করুন।</p>
            : !historyYears.length ? <p className="py-3 text-center text-xs text-slate-500">এই শিক্ষার্থীর কোনো সংরক্ষিত ইতিহাস পাওয়া যায়নি।</p>
              : !historyRow ? <p className="py-3 text-center text-xs text-slate-500">{toBanglaNumber(historyYear)} শিক্ষাবর্ষের {historyTermName}-এ কোনো ফলাফল সংরক্ষিত নেই।</p>
                : <div className="space-y-2">
                  <div className="grid gap-2 sm:grid-cols-4">
                    <Info label="শ্রেণি" value={CLASS_LABEL_MAP[historyEntry.classId] ?? historyEntry.classId} />
                    <Info label="মোট নম্বর" value={toBanglaNumber(historyRow.grandTotal ?? 0)} />
                    <Info label="GPA · গ্রেড" value={`${historyRow.gpa == null ? '—' : Number(historyRow.gpa).toFixed(2)} · ${historyRow.grade || '—'}`} />
                    <Info label="মেধাক্রম" value={historyRow.meritPosition ? toBanglaNumber(historyRow.meritPosition) : '—'} />
                  </div>
                  <div className="overflow-x-auto rounded-lg border border-slate-200 dark:border-slate-700">
                    <table className="table-base min-w-[420px]">
                      <thead><tr><th>বিষয়</th><th>গাঠনিক</th><th>সামষ্টিক</th><th>মোট</th></tr></thead>
                      <tbody>{historySubjects.map((subject) => <tr key={subject.id}>
                        <td>{subject.name}</td>
                        <td>{subject.formative == null ? '—' : toBanglaNumber(subject.formative)}</td>
                        <td>{subject.summative == null ? '—' : toBanglaNumber(subject.summative)}</td>
                        <td className="font-bold">{subject.total == null ? '—' : toBanglaNumber(subject.total)}</td>
                      </tr>)}</tbody>
                    </table>
                  </div>
                  {historyRow.remark ? <p className="rounded-lg bg-slate-50 p-2.5 text-[11px] leading-relaxed text-slate-700 dark:bg-slate-800 dark:text-slate-200"><b>মন্তব্য:</b> {historyRow.remark}</p> : null}
                  <p className="text-[10px] font-semibold text-slate-400">অতীত শিক্ষাবর্ষ সম্পূর্ণ ফ্রিজ — এখান থেকে কোনো কিছু পরিবর্তন করা যায় না।</p>
                </div>}
      </section> : null}
      {onEdit && <div className="flex justify-end"><button type="button" className="btn-primary" onClick={() => onEdit(student)}><Pencil size={15} /> এডিট</button></div>}
    </div>}
  </Modal>;
}
