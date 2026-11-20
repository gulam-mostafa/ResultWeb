import { QRCodeSVG } from 'qrcode.react';
import { formatOfficialBanglaDate } from '../../utils/banglaNumberFormatter.js';
import { academicYearOf, schoolDisplayName } from '../../utils/schoolProfile.js';
import SchoolDocumentHeader from './SchoolDocumentHeader.jsx';

export default function CompletionCertificateA4({ student, schoolProfile }) {
  if (!student) return null;
  const schoolName = schoolDisplayName(schoolProfile);
  return <article className="print-sheet rounded-lg shadow-lg"><div className="h-full rounded-xl border-[5px] border-double border-brand-700 p-10 text-center"><SchoolDocumentHeader schoolProfile={schoolProfile}/><h2 className="mt-10 text-2xl font-bold text-brand-800">প্রাথমিক শিক্ষা সমাপ্তি সনদ</h2><p className="mt-2">সমাপনী শিক্ষাবর্ষ {academicYearOf(schoolProfile)}</p><p className="mt-12 text-lg leading-[2.5]">এই মর্মে সনদ প্রদান করা যাচ্ছে যে <b>{student.name}</b>, পিতা <b>{student.fatherName || '—'}</b> ও মাতা <b>{student.motherName || '—'}</b>, এই বিদ্যালয় থেকে প্রাথমিক শিক্ষা সফলভাবে সমাপ্ত করেছে। তার সর্বাঙ্গীণ সাফল্য ও উজ্জ্বল ভবিষ্যৎ কামনা করি।</p><p className="mt-8">প্রদানের তারিখ: {formatOfficialBanglaDate()}</p><div className="mt-14 flex items-end justify-between"><div className="signature"><div className="signature__line">শ্রেণি শিক্ষক</div></div><QRCodeSVG value={`completion:${schoolProfile?.id || ''}:${student.id}`} size={90}/><div className="signature"><div className="signature__line">{schoolProfile?.headTeacher || ''}</div><div className="signature__role">প্রধান শিক্ষক</div></div></div></div></article>;
}
