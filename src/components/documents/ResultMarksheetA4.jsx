import { QRCodeSVG } from 'qrcode.react';
import { CLASS_LABEL_MAP, TERMS } from '../../utils/constants.js';
import { toBanglaNumber, formatBanglaDecimal } from '../../utils/banglaNumberFormatter.js';
import { academicYearOf } from '../../utils/schoolProfile.js';
import { buildVerificationRecord, buildVerificationUrl } from '../../utils/verification.js';
import { generateRemarkForResult } from '../../utils/remarkGenerator.js';
import SchoolDocumentHeader from './SchoolDocumentHeader.jsx';

/**
 * Result-marksheet (মার্কশিট) used by the Results page print / PDF flow.
 *
 * Two page layouts are supported through `layout`:
 *  • `'single'` → one marksheet on one full A4 page
 *  • `'pair'`   → two marksheets stacked in the top and bottom half of one A4 page
 *
 * Everything on the sheet (subjects, full marks, গাঠনিক/সামষ্টিক split, weights,
 * pass mark, grade, GPA, remark) comes from the ACTIVE school's own configuration, and
 * the QR code is a REAL scannable link to the public, login-free `/verify` route that
 * shows the pupil's name, roll, GPA and school name.
 *
 * The visual progress bars are pure CSS (no canvas), so a 40-pupil bulk PDF renders
 * instantly and can never clip a chart across a page boundary.
 */

const GRADE_TONE = {
  'A+': 'rsheet-chip--aplus',
  A: 'rsheet-chip--a',
  'A-': 'rsheet-chip--aminus',
  B: 'rsheet-chip--b',
  C: 'rsheet-chip--c',
  D: 'rsheet-chip--d',
  F: 'rsheet-chip--f',
};

const percentOf = (mark, full) => {
  const numeric = Number(mark);
  const fullMarks = Number(full);
  if (!Number.isFinite(numeric) || !Number.isFinite(fullMarks) || fullMarks <= 0) return null;
  return Math.max(0, Math.min(100, (numeric / fullMarks) * 100));
};

const bangla = (value) => (value === null || value === undefined || value === '' ? '—' : toBanglaNumber(value));

/**
 * Shortens a remark for the half-page (`pair`) layout WITHOUT cutting mid-sentence.
 * A 135mm half page has room for two sentences; trimming at a `।` boundary keeps the
 * text readable and guarantees the sheet can never overflow onto a third page.
 */
const compactRemark = (text, maxSentences = 2) => {
  const clean = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!clean) return '';
  const sentences = clean.match(/[^।]+।?/g) ?? [clean];
  return sentences.slice(0, maxSentences).join(' ').replace(/\s+/g, ' ').trim();
};

/**
 * QRs are printed at a fixed paper size (see `.rsheet__qr` in print.css) and the SVG
 * simply scales to it, so a marksheet keeps a real, scannable code in BOTH A4 layouts.
 * `marginSize={4}` is the quiet zone the QR spec requires — without it many phone
 * cameras refuse to lock on.
 */
const QR_MARGIN_MODULES = 4;

/** One horizontal percentage bar (pure CSS — prints exactly as it looks). */
function ScoreBar({ percent, tone = 'brand' }) {
  const value = percent === null ? 0 : Math.max(0, Math.min(100, percent));
  return (
    <span className="rsheet-bar" aria-hidden="true">
      <span className={`rsheet-bar__fill rsheet-bar__fill--${tone}`} style={{ width: `${value}%` }} />
    </span>
  );
}

export default function ResultMarksheetA4({
  student,
  result,
  remark,
  schoolProfile,
  /** `'term1' | 'term2' | 'annual' | 'consolidated'` */
  tabId = 'consolidated',
  tabName = '',
  position,
  /** `'single'` (1 per A4) or `'pair'` (2 per A4, top & bottom halves). */
  layout = 'single',
  /** Origin used to build the absolute QR verification URL. */
  verifyOrigin = '',
}) {
  if (!student || !result) return null;
  const isConsolidated = tabId === 'consolidated';
  const compact = layout === 'pair';
  const subjects = Array.isArray(result.subjects) ? result.subjects : [];
  const hasSplit = subjects.some((subject) => subject.split);
  const weights = result.weights ?? null;
  const termColumns = TERMS.map((term) => ({
    ...term,
    percent: weights?.[term.id] ?? Math.round((term.weight ?? 0) * 100),
  }));

  const title = isConsolidated
    ? 'বার্ষিক ফলাফল · মার্কশিট'
    : `${tabName || TERMS.find((term) => term.id === tabId)?.name || ''} · প্রগতিপত্র`;

  const verifyRecord = buildVerificationRecord({
    student,
    result,
    schoolProfile,
    className: CLASS_LABEL_MAP[student.classId] ?? '',
    resultLabel: isConsolidated ? 'বার্ষিক ফলাফল' : (tabName || tabId),
    year: academicYearOf(schoolProfile),
  });
  const verifyUrl = buildVerificationUrl(verifyRecord, verifyOrigin);
  const markCell = (value) => (value === null || value === undefined ? '—' : toBanglaNumber(value));
  // No saved remark yet? Draft one from THIS pupil's own গাঠনিক/সামষ্টিক + GPA, so two
  // marksheets never fall back to the same stock sentence.
  const defaultRemark = remark || generateRemarkForResult({ student, result });

  return (
    <article className={`print-sheet rsheet ${compact ? 'print-sheet--compact rsheet--compact' : ''}`}>
      <SchoolDocumentHeader schoolProfile={schoolProfile} />

      <div className="rsheet__heading">
        <h2 className="doc-title">{title}</h2>
        {isConsolidated && weights ? (
          <p className="rsheet__weights">
            ১ম প্রান্তিক {toBanglaNumber(weights.term1)}% + ২য় প্রান্তিক {toBanglaNumber(weights.term2)}%
            {' + '}বার্ষিক {toBanglaNumber(weights.annual)}%
          </p>
        ) : null}
      </div>

      <div className="rsheet__info">
        <p>শিক্ষার্থীর নাম: <b>{student.name}</b></p>
        <p>শ্রেণি: <b>{CLASS_LABEL_MAP[student.classId] ?? '—'}</b></p>
        <p>রোল: <b>{bangla(student.roll)}</b></p>
        <p>পিতার নাম: {student.fatherName || '—'}</p>
        <p>মাতার নাম: {student.motherName || '—'}</p>
        <p>মেধাক্রম: <b>{bangla(result.hasAnyMark ? (position ?? '—') : '—')}</b></p>
      </div>

      <table className="doc-table rsheet__table">
        <thead>
          <tr>
            <th className="rsheet__subject-col">বিষয়</th>
            <th>পূর্ণমান</th>
            {isConsolidated ? (
              termColumns.map((term) => (
                <th key={term.id}>
                  {term.shortName}
                  <span className="rsheet__head-note">({toBanglaNumber(term.percent)}%)</span>
                </th>
              ))
            ) : (
              <>
                <th>গাঠনিক</th>
                <th>সামষ্টিক</th>
              </>
            )}
            <th>মোট</th>
            <th>গ্রেড</th>
            <th>পয়েন্ট</th>
          </tr>
        </thead>
        <tbody>
          {subjects.map((subject) => {
            const percent = isConsolidated
              ? (subject.scoredPercent ?? subject.percent ?? null)
              : percentOf(subject.mark ?? subject.total, subject.fullMarks);
            return (
              <tr key={subject.id}>
                <td className="doc-table__subject">
                  <span className="rsheet__subject">{subject.name}</span>
                  {!compact ? <ScoreBar percent={percent} tone={subject.isPass === false ? 'rose' : 'brand'} /> : null}
                </td>
                <td>{bangla(subject.fullMarks ?? 100)}</td>
                {isConsolidated ? (
                  termColumns.map((term) => (
                    <td key={term.id}>{markCell(subject.marks?.[term.id])}</td>
                  ))
                ) : (
                  <>
                    <td>{hasSplit && subject.split ? markCell(subject.formative) : '—'}</td>
                    <td>{hasSplit && subject.split ? markCell(subject.summative) : '—'}</td>
                  </>
                )}
                <td className="rsheet__total-cell">{markCell(subject.total ?? subject.mark)}</td>
                <td>
                  <span className={`rsheet-chip ${GRADE_TONE[subject.grade] ?? 'rsheet-chip--b'}`}>
                    {subject.grade ?? '—'}
                  </span>
                </td>
                <td>{formatBanglaDecimal(subject.point ?? 0, 2)}</td>
              </tr>
            );
          })}
        </tbody>
        <tfoot>
          <tr>
            <th>সর্বমোট</th>
            <td>{bangla(result.totalFullMarks)}</td>
            <td colSpan={isConsolidated ? termColumns.length : 2}>{bangla(result.totalMarks)}</td>
            <th>{bangla(result.totalMarks)}</th>
            <th>{result.grade ?? '—'}</th>
            <th>{formatBanglaDecimal(result.gpa ?? 0, 2)}</th>
          </tr>
        </tfoot>
      </table>

      <div className="rsheet__summary">
        <span>মোট নম্বর: <b>{bangla(result.totalMarks)}</b></span>
        <span>GPA: <b>{result.gpa == null ? '—' : formatBanglaDecimal(result.gpa, 2)}</b></span>
        <span>গ্রেড: <b>{result.grade ?? '—'}</b></span>
        <span>
          ফলাফল:{' '}
          <b className={result.isPass ? 'rsheet__pass' : 'rsheet__fail'}>
            {result.hasAnyMark ? (result.isPass ? 'উত্তীর্ণ' : 'অনুত্তীর্ণ') : 'মূল্যায়ন হয়নি'}
          </b>
        </span>
        {result.isGolden ? <span className="rsheet__golden">★ গোল্ডেন ব্যাজ</span> : null}
      </div>

      <div className="rsheet__remark">
        <b>শিক্ষক মন্তব্য:</b> {compact ? compactRemark(defaultRemark) : defaultRemark}
      </div>

      <div className="rsheet__foot">
        <div className="signature">
          <div className="signature__line">শ্রেণি শিক্ষকের স্বাক্ষর</div>
          <div className="signature__role">তারিখ: ______________</div>
        </div>
        <div className="qr-block">
          <QRCodeSVG
            className="rsheet__qr"
            value={verifyUrl}
            size={160}
            level="L"
            marginSize={QR_MARGIN_MODULES}
            title={`${student.name} — ফলাফল যাচাই`}
          />
          <div>লগইন ছাড়াই যাচাই</div>
        </div>
        <div className="signature">
          <div className="signature__line">{schoolProfile?.headTeacher || ''}</div>
          <div className="signature__role">{schoolProfile?.headTeacherDesignation || 'প্রধান শিক্ষক'}</div>
        </div>
      </div>
    </article>
  );
}

