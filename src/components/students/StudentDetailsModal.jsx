import { useEffect, useMemo, useState } from 'react';
import { GraduationCap, Pencil } from 'lucide-react';
import Modal from '../ui/Modal.jsx';
import { CLASS_LEVELS, SUBJECTS, TERMS } from '../../utils/constants.js';
import { toBanglaNumber } from '../../utils/banglaNumberFormatter.js';

const value = (item) => item || '—';
const Info = ({ label, value: content }) => <div className="rounded-lg bg-slate-50 p-3 dark:bg-slate-800"><p className="text-xs text-slate-500">{label}</p><p className="mt-1 break-words text-sm font-semibold">{value(content)}</p></div>;

export default function StudentDetailsModal({ open, onClose, student, marks = {}, allStudents = [], getTermResult, getStudentResult, getClassAnalytics, onEdit }) {
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

  return <Modal open={open} onClose={onClose} title="শিক্ষার্থীর পূর্ণাঙ্গ তথ্য" subtitle={student?.name ?? ''} icon={GraduationCap} size="xl">
    {student && <div className="space-y-5">
      <section><h3 className="mb-2 text-sm font-bold">ব্যক্তিগত ও ভর্তি তথ্য</h3><div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        <Info label="নাম" value={student.name} /><Info label="রোল" value={toBanglaNumber(student.roll)} /><Info label="শ্রেণি" value={CLASS_LEVELS.find((item) => item.id === student.classId)?.name ?? (student.classId === 'archive' ? 'আর্কাইভ' : '—')} />
        <Info label="ভর্তির সাল" value={toBanglaNumber(student.admissionYear || student.admissionDate?.slice?.(0, 4))} /><Info label="লিঙ্গ" value={student.gender === 'female' ? 'ছাত্রী' : 'ছাত্র'} /><Info label="জন্ম তারিখ" value={student.birthDate} />
        <Info label="জন্ম নিবন্ধন নম্বর" value={student.birthCertificateNo} /><Info label="পিতার নাম" value={student.fatherName} /><Info label="পিতার মোবাইল" value={student.fatherPhone || student.guardianPhone} />
        <Info label="মাতার নাম" value={student.motherName} /><Info label="মাতার মোবাইল" value={student.motherPhone} /><Info label="অভিভাবকের ভোটার আইডি" value={student.guardianNid} />
        <Info label="ঠিকানা" value={student.address} />
      </div></section>
      <section>
        <div className="mb-2 flex flex-wrap items-center justify-between gap-3"><h3 className="text-sm font-bold">প্রান্তিক ও বার্ষিক ফলাফল</h3><label className="flex items-center gap-2 text-xs font-semibold">শ্রেণি <select className="input-base py-1.5" value={currentClassId} onChange={(event) => setClassId(event.target.value)}>{CLASS_LEVELS.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label></div>
        <div className="mb-3 grid gap-2 sm:grid-cols-2">{termResults.map(({ term, result, position: termPosition, classSize }) => <div key={term.id} className="rounded-lg bg-slate-50 p-3 dark:bg-slate-800"><p className="text-xs font-bold text-slate-500">{term.name}</p><p className="mt-1 text-sm font-semibold">মোট {toBanglaNumber(result.totalMarks ?? 0)} · GPA {result.gpa?.toFixed?.(2) ?? '—'} · গ্রেড {result.grade ?? '—'}</p><p className="text-xs text-slate-500">মেধাক্রম {termPosition >= 0 ? `${toBanglaNumber(termPosition + 1)} / ${toBanglaNumber(classSize)}` : '—'}</p></div>)}<Info label="বার্ষিক মেধাক্রম" value={position >= 0 ? `${toBanglaNumber(position + 1)} / ${toBanglaNumber(ranked.length)}` : '—'} /></div>
        <div className="overflow-x-auto rounded-xl border border-slate-200 dark:border-slate-700"><table className="table-base min-w-[580px]"><thead><tr><th>বিষয়</th>{TERMS.map((term) => <th key={term.id}>{term.name}</th>)}<th>বার্ষিক গ্রেড</th></tr></thead><tbody>{SUBJECTS.map((subject) => {
          const subjectMarks = studentMarks?.[subject.id] ?? {};
          const annualSubject = annual.subjects?.find((item) => item.id === subject.id);
          return <tr key={subject.id}><td>{subject.name}</td>{TERMS.map((term) => <td key={term.id}>{subjectMarks[term.id] == null ? '—' : toBanglaNumber(subjectMarks[term.id])}</td>)}<td>{annualSubject?.grade ?? '—'}</td></tr>;
        })}</tbody></table></div>
        <p className="mt-2 text-xs text-slate-500">বার্ষিক ফল: মোট {toBanglaNumber(annual.totalMarks ?? 0)} · GPA {annual.gpa?.toFixed?.(2) ?? '—'} · গ্রেড {annual.grade ?? '—'}</p>
      </section>
      {onEdit && <div className="flex justify-end"><button type="button" className="btn-primary" onClick={() => onEdit(student)}><Pencil size={15} /> এডিট</button></div>}
    </div>}
  </Modal>;
}
