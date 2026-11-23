import { Bar } from 'react-chartjs-2';
import { Chart as ChartJS, CategoryScale, LinearScale, BarElement, Tooltip, Legend } from 'chart.js';
import { QRCodeSVG } from 'qrcode.react';
import { CLASS_LABEL_MAP, TERMS } from '../../utils/constants.js';
import { toBanglaNumber, formatBanglaDecimal } from '../../utils/banglaNumberFormatter.js';
import { academicYearOf } from '../../utils/schoolProfile.js';
import SchoolDocumentHeader from './SchoolDocumentHeader.jsx';
ChartJS.register(CategoryScale, LinearScale, BarElement, Tooltip, Legend);

export default function MarksheetA4({ student, result, remark, schoolProfile }) {
  if (!student || !result) return null;
  const data = { labels: (result.subjects ?? []).map((s) => s.name), datasets: [{ label: 'প্রাপ্ত নম্বর', data: (result.subjects ?? []).map((s) => s.total ?? 0), backgroundColor: (result.subjects ?? []).map((s) => s.color || '#64748b'), borderRadius: 5 }] };
  return <article className="print-sheet rounded-lg shadow-lg">
    <SchoolDocumentHeader schoolProfile={schoolProfile} />
    <h2 className="doc-title">ডিজিটাল প্রগতিপত্র / মার্কশিট</h2>
    <div className="mb-3 grid grid-cols-2 gap-x-5 gap-y-1 text-[10pt] sm:grid-cols-3"><p>শিক্ষার্থীর নাম: <b>{student.name}</b></p><p>শ্রেণি: <b>{CLASS_LABEL_MAP[student.classId]}</b></p><p>রোল: <b>{toBanglaNumber(student.roll)}</b></p><p>পিতার নাম: {student.fatherName || '—'}</p><p>মাতার নাম: {student.motherName || '—'}</p><p>ফলাফল: <b>{result.isPass ? 'উত্তীর্ণ' : 'অনুত্তীর্ণ'}</b></p></div>
    <table className="doc-table"><thead><tr><th>বিষয়</th>{TERMS.map((t) => <th key={t.id}>{t.name}<br/>({toBanglaNumber(result.weights?.[t.id] ?? Math.round((t.weight ?? 0) * 100))}%)</th>)}<th>মোট</th><th>গ্রেড</th><th>গ্রেড পয়েন্ট</th></tr></thead><tbody>{(result.subjects ?? []).map((s) => <tr key={s.id}><td className="doc-table__subject">{s.name}</td>{TERMS.map((t) => <td key={t.id}>{s.marks?.[t.id] == null ? '—' : toBanglaNumber(s.marks[t.id])}</td>)}<td>{s.total == null ? '—' : toBanglaNumber(s.total)}</td><td>{s.grade}</td><td>{formatBanglaDecimal(s.point, 2)}</td></tr>)}</tbody><tfoot><tr><th>সর্বমোট / গড়</th><td colSpan="3">{toBanglaNumber(result.totalMarks)} / {toBanglaNumber(result.totalFullMarks)}</td><th>{result.grade}</th><th>{formatBanglaDecimal(result.gpa ?? 0, 2)}</th></tr></tfoot></table>
    <div className="my-3 h-44"><Bar data={data} options={{ responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true, max: 100 } } }}/></div><div className="rounded border border-slate-300 p-2 text-sm"><b>শিক্ষক মন্তব্য:</b> {remark || 'শিক্ষার্থীর ফলাফল পর্যবেক্ষণ করা হয়েছে। নিয়মিত পড়াশোনা অব্যাহত রাখুন।'}</div>
    <div className="mt-6 flex items-end justify-between"><div className="signature"><div className="signature__line">শ্রেণি শিক্ষকের স্বাক্ষর</div><div className="signature__role">তারিখ: ______________</div></div><div className="qr-block"><QRCodeSVG value={`school=${schoolProfile?.id || ''};student=${student.id};roll=${student.roll};session=${academicYearOf(schoolProfile)}`} size={76}/><div>ডিজিটাল যাচাই কোড</div></div><div className="signature"><div className="signature__line">{schoolProfile?.headTeacher || ''}</div><div className="signature__role">প্রধান শিক্ষক</div></div></div>
  </article>;
}
