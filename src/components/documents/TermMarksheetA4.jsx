import { Bar } from 'react-chartjs-2';
import { Chart as ChartJS, CategoryScale, LinearScale, BarElement, Tooltip, Legend } from 'chart.js';
import { QRCodeSVG } from 'qrcode.react';
import { CLASS_LABEL_MAP } from '../../utils/constants.js';
import { toBanglaNumber, formatBanglaDecimal } from '../../utils/banglaNumberFormatter.js';
import { buildVerificationRecord, buildVerificationUrl } from '../../utils/verification.js';
import SchoolDocumentHeader from './SchoolDocumentHeader.jsx';
ChartJS.register(CategoryScale, LinearScale, BarElement, Tooltip, Legend);

/** Absolute base of the app, so the printed QR always resolves when scanned. */
const verifyOrigin = () => (typeof window === 'undefined' ? '' : window.location.origin);


/**
 * একক প্রান্তিকের প্রগতিপত্র (১ম / ২য় প্রান্তিক / বার্ষিক মূল্যায়ন).
 *
 * Every subject row, its full marks, its গাঠনিক/সামষ্টিক components and its grade come
 * from the SCHOOL's own class configuration, so a customised subject list prints
 * exactly as it is calculated on screen.
 */
export default function TermMarksheetA4({ student, result, term, remark, position, schoolProfile }) {
  if (!student || !result) return null;
  const subjects = result.subjects ?? [];
  const hasSplit = subjects.some((subject) => subject.split);
  const chart = {
    labels: subjects.map((subject) => subject.name),
    datasets: [{
      label: `${term?.name ?? ''} নম্বর`,
      data: subjects.map((subject) => subject.percent ?? subject.mark ?? 0),
      backgroundColor: subjects.map((subject) => subject.color || '#64748b'),
      borderRadius: 5,
    }],
  };

  return (
    <article className="print-sheet rounded-lg shadow-lg">
      <SchoolDocumentHeader schoolProfile={schoolProfile} />

      <h2 className="doc-title">{term?.name} প্রগতিপত্র</h2>

      <div className="mb-3 grid grid-cols-2 gap-x-5 gap-y-1 text-[10pt] sm:grid-cols-3">
        <p>শিক্ষার্থীর নাম: <b>{student.name}</b></p>
        <p>শ্রেণি: <b>{CLASS_LABEL_MAP[student.classId]}</b></p>
        <p>রোল: <b>{toBanglaNumber(student.roll)}</b></p>
        <p>পিতার নাম: {student.fatherName || '—'}</p>
        <p>মাতার নাম: {student.motherName || '—'}</p>
        <p>মেধাক্রম: <b>{toBanglaNumber(position ?? '—')}</b></p>
      </div>

      <table className="doc-table">
        <thead>
          <tr>
            <th>বিষয়</th>
            <th>পূর্ণমান</th>
            {hasSplit ? <><th>গাঠনিক</th><th>সামষ্টিক</th></> : null}
            <th>প্রাপ্ত নম্বর</th>
            <th>গ্রেড</th>
            <th>গ্রেড পয়েন্ট</th>
            <th>ফলাফল</th>
          </tr>
        </thead>
        <tbody>
          {subjects.map((subject) => (
            <tr key={subject.id}>
              <td className="doc-table__subject">{subject.name}</td>
              <td>{toBanglaNumber(subject.fullMarks ?? 100)}</td>
              {hasSplit ? (
                subject.split ? (
                  <>
                    <td>{subject.formative == null ? '—' : toBanglaNumber(subject.formative)}</td>
                    <td>{subject.summative == null ? '—' : toBanglaNumber(subject.summative)}</td>
                  </>
                ) : <><td>—</td><td>—</td></>
              ) : null}
              <td>{subject.mark == null ? '—' : toBanglaNumber(subject.mark)}</td>
              <td>{subject.grade}</td>
              <td>{formatBanglaDecimal(subject.point, 2)}</td>
              <td>{subject.mark == null ? '—' : subject.isPass ? 'উত্তীর্ণ' : 'অনুত্তীর্ণ'}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <th>সর্বমোট</th>
            <td>{toBanglaNumber(result.totalFullMarks)}</td>
            {hasSplit ? <td colSpan={2} /> : null}
            <th>{toBanglaNumber(result.totalMarks)}</th>
            <th>{result.grade}</th>
            <th>{formatBanglaDecimal(result.gpa ?? 0, 2)}</th>
            <th>{result.isPass ? 'উত্তীর্ণ' : 'অনুত্তীর্ণ'}</th>
          </tr>
        </tfoot>
      </table>

      <div className="my-3 h-44">
        <Bar data={chart} options={{ responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true, max: 100 } } }} />
      </div>

      <div className="rounded border border-slate-300 p-2 text-sm">
        <b>শিক্ষক মন্তব্য:</b> {remark || 'শিক্ষার্থীর ফলাফল পর্যবেক্ষণ করা হয়েছে। নিয়মিত পড়াশোনা অব্যাহত রাখুন।'}
      </div>

      <div className="mt-6 flex items-end justify-between">
        <div className="signature">
          <div className="signature__line">শ্রেণি শিক্ষকের স্বাক্ষর</div>
          <div className="signature__role">তারিখ: ______________</div>
        </div>
        <div className="qr-block">
          <QRCodeSVG
            className="doc-qr"
            value={buildVerificationUrl(
              buildVerificationRecord({
                student,
                result,
                schoolProfile,
                className: CLASS_LABEL_MAP[student.classId] ?? '',
                resultLabel: term?.name ?? '',
              }),
              verifyOrigin(),
            )}
            size={160}
            level="L"
            marginSize={4}
            title={`${student.name} — ফলাফল যাচাই`}
          />
          <div>লগইন ছাড়াই ডিজিটাল যাচাই</div>
        </div>
        <div className="signature">
          <div className="signature__line">{schoolProfile?.headTeacher || ''}</div>
          <div className="signature__role">প্রধান শিক্ষক</div>
        </div>
      </div>
    </article>
  );
}
