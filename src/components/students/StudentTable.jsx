import { useMemo, useState } from 'react';
import { Search, UserRound, Pencil, RotateCcw, BarChart3 } from 'lucide-react';
import { EmptyState } from '../ui/Primitives.jsx';
import { toBanglaNumber } from '../../utils/banglaNumberFormatter.js';
import { matchesStudentSearch } from '../../utils/studentSearch.js';
import PromotionBadge from './PromotionBadge.jsx';

/**
 * Roster table.
 *
 * Every pupil row is clickable in two ways:
 *  - the NAME opens the full student profile modal (`onSelect`);
 *  - the result summary (মোট / GPA / গ্রেড) opens the detailed result modal
 *    (`onShowResult`).
 *
 * A freshly promoted pupil also carries the Bengali month/year badge next to their
 * name (see `PromotionBadge`), which disappears completely after 90 days.
 */
export default function StudentTable({ students = [], canEdit, isArchive = false, onSelect, onEdit, onRestore, onShowResult, getStudentResult }) {
  const [query, setQuery] = useState('');
  // নাম বা প্রোফাইলের যেকোনো তথ্য (পিতা/মাতার নাম, রোল, ফোন, জন্ম নিবন্ধন নম্বর,
  // ঠিকানা, অভিভাবকের এনআইডি) দিয়ে খোঁজা — বাংলা সংখ্যা আগে ASCII-তে বদলে মেলানো
  // হয়, তাই `০১৭…` আর `017…` একই নম্বর। একাধিক মিললে সবাই দেখায়।
  const filtered = useMemo(() => students.filter((student) => matchesStudentSearch(student, query)), [students, query]);
  if (!students.length) return <EmptyState icon={UserRound} title={isArchive ? 'আর্কাইভে শিক্ষার্থী নেই' : 'এই শ্রেণিতে শিক্ষার্থী নেই'} message="শিক্ষার্থীর তালিকা এখানে দেখা যাবে।" />;
  return <div>
    <div className="relative mb-3 w-full max-w-sm"><Search size={16} className="absolute left-3 top-3 text-slate-400" /><input className="input-base pl-9" placeholder="নাম, রোল, ফোন, জন্ম নিবন্ধন, ঠিকানা বা এনআইডি দিয়ে খুঁজুন" value={query} onChange={(event) => setQuery(event.target.value)} /></div>
    <div className="max-w-full overflow-x-auto scroll-thin"><table className="table-base min-w-[720px]"><thead><tr><th>রোল</th><th>শিক্ষার্থীর নাম</th><th>পিতা / মাতা</th><th>লিঙ্গ</th><th>ফলাফল · বার্ষিক (ওজনযুক্ত)</th><th>অভিভাবকের ফোন</th>{canEdit && <th>কার্যক্রম</th>}</tr></thead><tbody>
      {filtered.map((student) => {
        const result = getStudentResult?.(student.id) ?? null;
        return <tr key={student.id} onClick={() => onSelect?.(student)} onKeyDown={(event) => { if (event.key === 'Enter') onSelect?.(student); }} tabIndex={0} className="cursor-pointer hover:bg-brand-50/60 dark:hover:bg-slate-800">
        <td className="font-bold">{toBanglaNumber(student.roll)}</td>
        <td>
          {/* The name itself is the entry point to the profile modal. */}
          <button type="button" className="text-left" onClick={(event) => { event.stopPropagation(); onSelect?.(student); }} aria-label={`${student.name} এর পূর্ণাঙ্গ তথ্য`}>
            <span className="font-bold text-brand-800 underline decoration-brand-300 underline-offset-2 hover:decoration-brand-700 dark:text-brand-200">{student.name}</span>
          </button>
          <div className="mt-0.5 flex min-w-0 flex-wrap items-center gap-1.5 break-all text-[10px] text-slate-400">{student.id}<PromotionBadge student={student} /></div>
        </td>
        <td>{student.fatherName || '—'}<div className="text-[10px] text-slate-400">{student.motherName || '—'}</div></td><td>{student.gender === 'female' ? 'ছাত্রী' : 'ছাত্র'}</td>
        <td onClick={(event) => event.stopPropagation()}>
          <button type="button" className="inline-flex max-w-full items-center gap-1 whitespace-nowrap text-xs font-bold text-brand-700 underline decoration-brand-300 underline-offset-2 hover:decoration-brand-700" onClick={() => onShowResult?.(student)} aria-label={`${student.name} এর ফলাফল`} disabled={!onShowResult} title="বার্ষিক ফলাফল — ১ম প্রান্তিক ১৫% + ২য় প্রান্তিক ১৫% + বার্ষিক ৭০% ওজনে হিসাব করা মোট (কোনো এক প্রান্তিকের কাঁচা মোট নয়)">
            <BarChart3 size={12} /> {result?.hasAnyMark
              ? `বার্ষিক মোট ${toBanglaNumber(result.totalMarks ?? 0)} · GPA ${result.gpa == null ? '—' : Number(result.gpa).toFixed(2)}`
              : `বার্ষিক মোট ${toBanglaNumber(0)} · ফলাফল নেই`}
          </button>
        </td>
        <td>{student.fatherPhone || student.guardianPhone || '—'}</td>
        {canEdit && <td onClick={(event) => event.stopPropagation()}>{isArchive
          ? <button type="button" className="btn-ghost btn-sm text-emerald-700" onClick={() => onRestore?.(student)} aria-label={`${student.name} শ্রেণিতে ফিরিয়ে নিন`}><RotateCcw size={14} /> শ্রেণিতে ফিরিয়ে নিন</button>
          : <button type="button" className="btn-ghost btn-sm text-brand-700" onClick={(event) => { event.stopPropagation(); onEdit?.(student); }} aria-label={`${student.name} এডিট করুন`}><Pencil size={14} /> এডিট</button>}</td>}
      </tr>;
      })}
    </tbody></table>{!filtered.length && <p className="py-8 text-center text-sm text-slate-400">কোনো শিক্ষার্থী পাওয়া যায়নি।</p>}</div>
  </div>;
}

