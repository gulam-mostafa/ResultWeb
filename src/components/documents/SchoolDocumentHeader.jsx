import { formatOfficialBanglaDate, toBanglaNumber } from '../../utils/banglaNumberFormatter.js';
import { academicYearOf, schoolDisplayName, schoolLogoText } from '../../utils/schoolProfile.js';

export default function SchoolDocumentHeader({ schoolProfile, includeYear = true }) {
  const name = schoolDisplayName(schoolProfile);
  const location = [schoolProfile?.villageOrUnion, schoolProfile?.upazilaName, schoolProfile?.districtName, schoolProfile?.divisionName].filter(Boolean).join(', ');
  const details = [
    schoolProfile?.emisCode ? `ইএমআইএস: ${toBanglaNumber(schoolProfile.emisCode)}` : '',
    schoolProfile?.establishedYear ? `প্রতিষ্ঠিত: ${toBanglaNumber(schoolProfile.establishedYear)}` : '',
  ].filter(Boolean).join(' · ');
  return <header className="doc-header">
    <div className="doc-header__logo">{schoolLogoText(schoolProfile)}</div>
    <h1 className="doc-header__school">{name}</h1>
    {location && <p className="doc-header__address">{location}</p>}
    {details && <p className="doc-header__address">{details}</p>}
    {schoolProfile?.motto && <p className="doc-header__address">{schoolProfile.motto}</p>}
    {includeYear && <div className="doc-header__meta"><span>শিক্ষাবর্ষ: {academicYearOf(schoolProfile)}</span><span>প্রকাশের তারিখ: {formatOfficialBanglaDate()}</span></div>}
  </header>;
}
