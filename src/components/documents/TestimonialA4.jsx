import { QRCodeSVG } from 'qrcode.react';
import { CLASS_LABEL_MAP } from '../../utils/constants.js';
import { formatOfficialBanglaDate, toBanglaNumber } from '../../utils/banglaNumberFormatter.js';
import { schoolDisplayName } from '../../utils/schoolProfile.js';
import SchoolDocumentHeader from './SchoolDocumentHeader.jsx';

export default function TestimonialA4({ student, schoolProfile }) {
  if (!student) return null;
  const schoolName = schoolDisplayName(schoolProfile);
  return <article className="print-sheet print-sheet--full rounded-lg shadow-lg"><SchoolDocumentHeader schoolProfile={schoolProfile}/><h2 className="doc-title">প্রত্যয়ন পত্র</h2><p className="mt-10 flex-1 text-justify leading-[2.3]">এই মর্মে প্রত্যয়ন করা যাচ্ছে যে, <b>{student.name}</b>, পিতা: <b>{student.fatherName || '—'}</b>, মাতা: <b>{student.motherName || '—'}</b>, অত্র বিদ্যালয়ের <b>{CLASS_LABEL_MAP[student.classId]}</b> শ্রেণির একজন নিয়মিত শিক্ষার্থী। বিদ্যালয়ে তার আচরণ ও চরিত্র সন্তোষজনক। আমার জানামতে সে রাষ্ট্র বা সমাজবিরোধী কোনো কর্মকাণ্ডে জড়িত নয়। তার উজ্জ্বল ভবিষ্যৎ কামনা করি।</p><div className="mt-8 flex items-center justify-between"><span>তারিখ: {formatOfficialBanglaDate()}</span><QRCodeSVG className="doc-qr" value={`testimonial:${student.id}`} size={82} marginSize={4}/></div><div className="rsheet__foot"><div/><div className="signature"><div className="signature__line">{schoolProfile?.headTeacher || ''}</div><div className="signature__role">প্রধান শিক্ষক · {schoolName}</div></div></div><p className="text-xs">শিক্ষার্থী আইডি: {student.id} · রোল: {toBanglaNumber(student.roll)}</p></article>;
}
