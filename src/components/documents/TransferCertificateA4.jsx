import { QRCodeSVG } from 'qrcode.react';
import { CLASS_LABEL_MAP } from '../../utils/constants.js';
import { formatOfficialBanglaDate, toBanglaNumber } from '../../utils/banglaNumberFormatter.js';
import { schoolDisplayName } from '../../utils/schoolProfile.js';
import SchoolDocumentHeader from './SchoolDocumentHeader.jsx';

export default function TransferCertificateA4({ student, schoolProfile }) {
  if (!student) return null;
  const schoolName = schoolDisplayName(schoolProfile);
  return <article className="print-sheet print-sheet--full rounded-lg shadow-lg"><SchoolDocumentHeader schoolProfile={schoolProfile}/><h2 className="doc-title">ছাড়পত্র (Transfer Certificate)</h2><table className="doc-table mt-6"><tbody>{[['শিক্ষার্থীর নাম', student.name], ['পিতার নাম', student.fatherName || '—'], ['মাতার নাম', student.motherName || '—'], ['শ্রেণি', CLASS_LABEL_MAP[student.classId]], ['রোল', toBanglaNumber(student.roll)], ['ভর্তির তারিখ', student.admissionDate || '—'], ['ছাড়পত্র প্রদানের তারিখ', formatOfficialBanglaDate()]].map(([label, value]) => <tr key={label}><th>{label}</th><td>{value}</td></tr>)}</tbody></table><p className="mt-8 flex-1 leading-loose">তার আবেদনক্রমে তাকে বিদ্যালয় থেকে ছাড়পত্র প্রদান করা হলো। বিদ্যালয়ের পাওনা পরিশোধিত এবং তার আচরণ সন্তোষজনক। তার পরবর্তী শিক্ষাজীবনের সর্বাঙ্গীণ সাফল্য কামনা করি।</p><div className="rsheet__foot"><QRCodeSVG className="doc-qr" value={`tc:${schoolProfile?.id || ''}:${student.id}`} size={82} marginSize={4}/><div className="signature"><div className="signature__line">{schoolProfile?.headTeacher || ''}</div><div className="signature__role">প্রধান শিক্ষক</div></div></div></article>;
}
