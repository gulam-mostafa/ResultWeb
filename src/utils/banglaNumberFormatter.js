/**
 * Bangla numeral helpers.
 * The school platform renders every number (roll, marks, GPA, dates) in Bangla
 * digits, so all conversions are funnelled through this single module.
 */

const BN_DIGITS = ['০', '১', '২', '৩', '৪', '৫', '৬', '৭', '৮', '৯'];
const EN_DIGITS = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'];

/** Converts every ASCII digit inside a value to its Bangla counterpart. */
export function toBanglaNumber(input) {
  if (input === null || input === undefined || input === '') return '';
  return String(input).replace(/[0-9]/g, (digit) => BN_DIGITS[Number(digit)]);
}

/** Converts Bangla digits back to ASCII — required when parsing form input. */
export function toEnglishNumber(input) {
  if (input === null || input === undefined || input === '') return '';
  return String(input).replace(/[০-৯]/g, (digit) => EN_DIGITS[BN_DIGITS.indexOf(digit)]);
}

/** Normalises user-typed numeric input into a plain ASCII number string. */
export function normalizeNumericInput(value) {
  return toEnglishNumber(value).replace(/[^0-9.]/g, '');
}

/** Formats a number with fixed decimals, then converts it to Bangla digits. */
export function formatBanglaDecimal(value, decimals = 2) {
  const numeric = Number(toEnglishNumber(value));
  if (!Number.isFinite(numeric)) return '০.০০';
  return toBanglaNumber(numeric.toFixed(decimals));
}

/** Formats an integer-like value in Bangla digits (2 → "২"). */
export function formatBanglaInt(value) {
  const numeric = Number(toEnglishNumber(value));
  if (!Number.isFinite(numeric)) return '০';
  return toBanglaNumber(Math.round(numeric));
}

/** Ordinal suffix in Bangla: 1 → "১ম", 2 → "২য়", 4 → "৪র্থ". */
export function toBanglaOrdinal(value) {
  const numeric = Number(toEnglishNumber(value));
  if (!Number.isFinite(numeric)) return '';
  const bangla = toBanglaNumber(numeric);
  const lastTwo = numeric % 100;
  if (lastTwo >= 4 && lastTwo <= 6) return `${bangla}র্থ`;
  switch (numeric % 10) {
    case 1:
    case 7:
    case 9:
      return `${bangla}ম`;
    case 2:
    case 3:
      return `${bangla}য়`;
    default:
      return `${bangla}তম`;
  }
}

const BN_MONTHS = [
  'জানুয়ারি', 'ফেব্রুয়ারি', 'মার্চ', 'এপ্রিল', 'মে', 'জুন',
  'জুলাই', 'আগস্ট', 'সেপ্টেম্বর', 'অক্টোবর', 'নভেম্বর', 'ডিসেম্বর',
];

/** ISO date (YYYY-MM-DD) ➔ "১৫ মার্চ ২০১৬" style Bangla date string. */
export function formatBanglaDate(isoDate) {
  if (!isoDate) return '—';
  const parsed = new Date(isoDate);
  if (Number.isNaN(parsed.getTime())) return '—';
  const day = toBanglaNumber(parsed.getDate());
  const month = BN_MONTHS[parsed.getMonth()];
  const year = toBanglaNumber(parsed.getFullYear());
  return `${day} ${month} ${year}`;
}

/**
 * Bengali month + year label of a date: `2026-11-05` ➔ "নভেম্বর ২০২৬".
 * Used by the promotion (উত্তরণ) badge, which names the month a pupil was
 * promoted in. Returns `''` for a missing/unparseable value.
 */
export function formatBanglaMonthYear(isoDate) {
  if (!isoDate) return '';
  const parsed = isoDate instanceof Date ? isoDate : new Date(isoDate);
  if (!(parsed instanceof Date) || Number.isNaN(parsed.getTime())) return '';
  return `${BN_MONTHS[parsed.getMonth()]} ${toBanglaNumber(parsed.getFullYear())}`;
}

/** Long-form date used on official documents: "১৫ মার্চ ২০২৬ খ্রিষ্টাব্দ". */
export function formatOfficialBanglaDate(isoDate = new Date()) {
  const value = typeof isoDate === 'string' ? new Date(isoDate) : isoDate;
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) return '—';
  return `${toBanglaNumber(value.getDate())} ${BN_MONTHS[value.getMonth()]} ${toBanglaNumber(
    value.getFullYear(),
  )} খ্রিষ্টাব্দ`;
}

/** Percentage helper: 85.5 ➔ "৮৫.৫০%" */
export function formatBanglaPercent(value, decimals = 2) {
  return `${formatBanglaDecimal(value, decimals)}%`;
}

export default {
  toBanglaNumber,
  toEnglishNumber,
  normalizeNumericInput,
  formatBanglaDecimal,
  formatBanglaInt,
  toBanglaOrdinal,
  formatBanglaDate,
  formatBanglaMonthYear,
  formatOfficialBanglaDate,
  formatBanglaPercent,
};
