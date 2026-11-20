import { useMemo, useState } from 'react';
import { Search, UserRound, Pencil, RotateCcw } from 'lucide-react';
import { EmptyState } from '../ui/Primitives.jsx';
import { toBanglaNumber } from '../../utils/banglaNumberFormatter.js';

export default function StudentTable({ students = [], canEdit, isArchive = false, onSelect, onEdit, onRestore }) {
  const [query, setQuery] = useState('');
  const filtered = useMemo(() => students.filter((student) => [student.name, student.roll, student.fatherName, student.motherName, student.guardianPhone, student.fatherPhone, student.motherPhone].join(' ').toLowerCase().includes(query.toLowerCase())), [students, query]);
  if (!students.length) return <EmptyState icon={UserRound} title={isArchive ? 'আর্কাইভে শিক্ষার্থী নেই' : 'এই শ্রেণিতে শিক্ষার্থী নেই'} message="শিক্ষার্থীর তালিকা এখানে দেখা যাবে।" />;
  return <div>
    <div className="relative mb-3 max-w-sm"><Search size={16} className="absolute left-3 top-3 text-slate-400" /><input className="input-base pl-9" placeholder="নাম, রোল বা অভিভাবক খুঁজুন" value={query} onChange={(event) => setQuery(event.target.value)} /></div>
    <div className="overflow-x-auto"><table className="table-base min-w-[720px]"><thead><tr><th>রোল</th><th>শিক্ষার্থীর নাম</th><th>পিতা / মাতা</th><th>লিঙ্গ</th><th>অভিভাবকের ফোন</th>{canEdit && <th>কার্যক্রম</th>}</tr></thead><tbody>
      {filtered.map((student) => <tr key={student.id} onClick={() => onSelect?.(student)} onKeyDown={(event) => { if (event.key === 'Enter') onSelect?.(student); }} tabIndex={0} className="cursor-pointer hover:bg-brand-50/60 dark:hover:bg-slate-800">
        <td className="font-bold">{toBanglaNumber(student.roll)}</td><td><p className="font-bold text-slate-900 dark:text-white">{student.name}</p><p className="text-[10px] text-slate-400">{student.id}</p></td>
        <td>{student.fatherName || '—'}<div className="text-[10px] text-slate-400">{student.motherName || '—'}</div></td><td>{student.gender === 'female' ? 'ছাত্রী' : 'ছাত্র'}</td><td>{student.fatherPhone || student.guardianPhone || '—'}</td>
        {canEdit && <td onClick={(event) => event.stopPropagation()}>{isArchive
          ? <button type="button" className="btn-ghost btn-sm text-emerald-700" onClick={() => onRestore?.(student)} aria-label={`${student.name} শ্রেণিতে ফিরিয়ে নিন`}><RotateCcw size={14} /> শ্রেণিতে ফিরিয়ে নিন</button>
          : <button type="button" className="btn-ghost btn-sm text-brand-700" onClick={(event) => { event.stopPropagation(); onEdit?.(student); }} aria-label={`${student.name} এডিট করুন`}><Pencil size={14} /> এডিট</button>}</td>}
      </tr>)}
    </tbody></table>{!filtered.length && <p className="py-8 text-center text-sm text-slate-400">কোনো শিক্ষার্থী পাওয়া যায়নি।</p>}</div>
  </div>;
}

