import { BarChart3 } from 'lucide-react';
import Modal from '../ui/Modal.jsx';
import { CLASS_LEVELS, SUBJECTS, TERMS } from '../../utils/constants.js';
import { toBanglaNumber } from '../../utils/banglaNumberFormatter.js';
import { promotionMonthLabel } from '../../utils/promotionMeta.js';

const TONE_BY_GRADE = {
  'A+': 'bg-emerald-100 text-emerald-800',
  A: 'bg-emerald-100 text-emerald-800',
  'A-': 'bg-sky-100 text-sky-800',
  B: 'bg-sky-100 text-sky-800',
  C: 'bg-amber-100 text-amber-800',
  D: 'bg-orange-100 text-orange-800',
  F: 'bg-rose-100 text-rose-800',
};

const Info = ({ label, value }) => <div className="rounded-lg bg-slate-50 p-3 dark:bg-slate-800"><p className="text-xs text-slate-500">{label}</p><p className="mt-1 break-words text-sm font-semibold">{value || '—'}</p></div>;

/**
 * Detailed result popup of ONE pupil.
 *
 * Opened by clicking a pupil's result (in the marks grid, the roster, or a
 * promotion row). It shows the annual weighted result, every term, the
 * per-subject breakdown, and — when the pupil arrived through a promotion — the
 * month/year they were promoted in.
 */
export default function StudentResultModal({
  open,
  onClose,
  student,
  marks = {},
  getStudentResult,
  getTermResult,
  getClassAnalytics,
  term = null,
}) {
  const annual = getStudentResult?.(student?.id) ?? { hasAnyMark: false, subjects: [], grade: '—', gpa: null, totalMarks: 0 };
  const studentMarks = marks?.[student?.id] ?? {};
  const classId = student?.classId && student.classId !== 'archive' ? student.classId : student?.previousClassId;
  const classRows = (getClassAnalytics?.(classId)?.rows ?? []).filter((row) => row.hasAnyMark);
  const position = classRows.findIndex((row) => row.studentId === student?.id);
  const activeTerm = TERMS.find((item) => item.id === term) ?? null;
  const termResult = activeTerm ? (getTermResult?.(student?.id, activeTerm.id) ?? {}) : null;
  const promotedMonth = promotionMonthLabel(student?.promotedAt);

  return <Modal
    open={open}
    onClose={onClose}
    title="শিক্ষার্থীর ফলাফল"
    subtitle={student ? `${student.name ?? ''} · রোল ${toBanglaNumber(student.roll)} · ${CLASS_LEVELS.find((item) => item.id === student.classId)?.name ?? 'আর্কাইভ'}` : ''}
    icon={BarChart3}
    size="xl"
  >
    {student && <div className="space-y-5">
      <section className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        <Info label="বার্ষিক মোট" value={toBanglaNumber(annual.totalMarks ?? 0)} />
        <Info label="বার্ষিক GPA" value={annual.gpa == null ? '—' : Number(annual.gpa).toFixed(2)} />
        <Info label="বার্ষিক গ্রেড" value={annual.grade ?? '—'} />
        <Info label="বার্ষিক মেধাক্রম" value={position >= 0 ? `${toBanglaNumber(position + 1)} / ${toBanglaNumber(classRows.length)}` : '—'} />
        {promotedMonth ? <Info label="উত্তরণের মাস" value={promotedMonth} /> : null}
      </section>

      <section>
        <h3 className="mb-2 text-sm font-bold">প্রান্তিকভিত্তিক ফলাফল</h3>
        <div className="grid gap-2 sm:grid-cols-3">{TERMS.map((item) => {
          const result = getTermResult?.(student.id, item.id) ?? {};
          return <div key={item.id} className={`rounded-lg p-3 dark:bg-slate-800 ${activeTerm?.id === item.id ? 'bg-brand-50' : 'bg-slate-50'}`}>
            <p className="text-xs font-bold text-slate-500">{item.name}</p>
            <p className="mt-1 text-sm font-semibold">মোট {toBanglaNumber(result.totalMarks ?? 0)} · GPA {result.gpa == null ? '—' : Number(result.gpa).toFixed(2)} · গ্রেড {result.grade ?? '—'}</p>
            <p className="text-xs text-slate-500">{result.hasAnyMark ? (result.isPass ? 'উত্তীর্ণ' : `অকৃতকার্য (${toBanglaNumber(result.failCount ?? 0)} বিষয়)`) : 'মূল্যায়ন হয়নি'}</p>
          </div>;
        })}</div>
      </section>

      {activeTerm && termResult ? <p className="rounded-lg bg-brand-50 p-3 text-xs text-brand-800 dark:bg-brand-900/30 dark:text-brand-200">বর্তমানে নির্বাচিত মূল্যায়ন: <b>{activeTerm.name}</b> — মোট {toBanglaNumber(termResult.totalMarks ?? 0)}, শতকরা {toBanglaNumber(termResult.percentage ?? 0)}%, গ্রেড {termResult.grade ?? '—'}</p> : null}

      <section>
        <h3 className="mb-2 text-sm font-bold">বিষয়ভিত্তিক নম্বর ও গ্রেড</h3>
        <div className="overflow-x-auto rounded-xl border border-slate-200 dark:border-slate-700">
          <table className="table-base min-w-[560px]">
            <thead><tr><th>বিষয়</th>{TERMS.map((item) => <th key={item.id}>{item.name}</th>)}<th>বার্ষিক মোট</th><th>গ্রেড</th></tr></thead>
            <tbody>{SUBJECTS.map((subject) => {
              const subjectMarks = studentMarks?.[subject.id] ?? {};
              const annualSubject = annual.subjects?.find((item) => item.id === subject.id);
              const grade = annualSubject?.grade ?? '—';
              return <tr key={subject.id}>
                <td>{subject.name}</td>
                {TERMS.map((item) => <td key={item.id}>{subjectMarks[item.id] == null ? '—' : toBanglaNumber(subjectMarks[item.id])}</td>)}
                <td className="font-bold">{annualSubject?.total == null ? '—' : toBanglaNumber(annualSubject.total)}</td>
                <td><span className={`badge ${TONE_BY_GRADE[grade] ?? 'bg-slate-100 text-slate-700'}`}>{grade}</span></td>
              </tr>;
            })}</tbody>
          </table>
        </div>
        {!annual.hasAnyMark && <p className="mt-2 text-xs text-slate-500">এখনো কোনো নম্বর এন্ট্রি হয়নি।</p>}
      </section>
    </div>}
  </Modal>;
}
