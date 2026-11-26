/**
 * 6-class student workbook (.xlsx) — export & format-locked import.
 *
 * ```text
 * sheet "প্রাক-প্রাথমিক" | "১ম শ্রেণি" | … | "৫ম শ্রেণি"     ← the SHEET names the class
 * row 1 : RESULTWEB STUDENT TEMPLATE v1                    ← template stamp
 * row 2 : রোল | শাখা | শিক্ষার্থীর নাম | … | ঠিকানা          ← fixed header row
 * row 3+: one pupil per row, ordered শাখা ➔ রোল
 * ```
 *
 * There is **no class column inside a sheet** — the class is the sheet. A teacher may
 * append rows anywhere, in any শাখা order; every row is routed to its own `শাখা`
 * (`ক` when blank) on import.
 *
 * Everything an upload is checked against (sheet names, header order, required fields,
 * number/phone/date formats) is validated here and rejected with the exact sheet, row,
 * column and Bangla reason — never silently accepted.
 */
import { toEnglishNumber } from '../../utils/banglaNumberFormatter.js';
import {
  STUDENT_IMPORT_COLUMNS,
  STUDENT_IMPORT_HEADERS,
  STUDENT_SHEET_CLASS_IDS,
  STUDENT_SHEET_NAME_MAP,
  STUDENT_TEMPLATE_MAGIC,
  getClassName,
  studentClassOfSheet,
} from '../../utils/constants.js';
import { cleanSectionLabel, sortRosterForExport } from '../../utils/rollAssignment.js';

/** SheetJS is loaded on demand (only this screen needs it). */
let xlsxPromise = null;
const loadXlsx = () => {
  if (!xlsxPromise) xlsxPromise = import('xlsx');
  return xlsxPromise;
};

export const STUDENT_HEADER_ROW_INDEX = 1; // zero-based: row 2 of the sheet
export const STUDENT_FIRST_DATA_ROW_INDEX = 2;
export const STUDENT_META_ROWS = 1;

const text = (value) => String(value ?? '').replace(/\u00a0/g, ' ').trim();
const ascii = (value) => toEnglishNumber(text(value));

/** `{ok:false}` result carrying one machine code plus a Bangla message. */
const fail = (code, message, extra = {}) => ({ ok: false, code, message, ...extra });

/**
 * One exported cell of a pupil row.
 * A blank value stays an empty string so the teacher sees an empty cell to fill in.
 */
const cellOf = (student, key) => {
  if (key === 'section') return cleanSectionLabel(student?.section);
  if (key === 'roll') return Number(student?.roll) || '';
  if (key === 'birthCertificateNo') return text(student?.birthCertificateNo ?? student?.birthRegNo);
  const value = student?.[key];
  return value === null || value === undefined ? '' : text(value);
};

/**
 * Builds the 6-sheet workbook.
 *
 * @param {{students?:Array<object>}} options every pupil of the school (all classes)
 * @returns {Promise<Uint8Array>} the binary workbook
 */
export async function buildStudentWorkbook({ students = [] } = {}) {
  const XLSX = await loadXlsx();
  const book = XLSX.utils.book_new();
  const roster = Array.isArray(students) ? students.filter((student) => student && student.classId !== 'archive') : [];

  STUDENT_SHEET_CLASS_IDS.forEach((classId) => {
    const rows = [[STUDENT_TEMPLATE_MAGIC], [...STUDENT_IMPORT_HEADERS]];
    sortRosterForExport(roster.filter((student) => student.classId === classId)).forEach((student) => {
      rows.push(STUDENT_IMPORT_COLUMNS.map((column) => cellOf(student, column.key)));
    });
    const sheet = XLSX.utils.aoa_to_sheet(rows);
    sheet['!cols'] = [
      { wch: 8 }, { wch: 8 }, { wch: 26 }, { wch: 22 }, { wch: 22 }, { wch: 9 },
      { wch: 20 }, { wch: 20 }, { wch: 15 }, { wch: 15 }, { wch: 11 }, { wch: 12 }, { wch: 28 },
    ];
    // The stamp/header rows are frozen so a long class list stays readable.
    sheet['!freeze'] = 'A3';
    XLSX.utils.book_append_sheet(book, sheet, STUDENT_SHEET_NAME_MAP[classId]);
  });

  return XLSX.write(book, { bookType: 'xlsx', type: 'array', compression: true });
}

/** A safe, human-readable workbook file name. */
export function studentWorkbookFileName({ prefix = 'শিক্ষার্থী-তালিকা', suffix = '' } = {}) {
  const safe = (value) => String(value ?? '').replace(/[\\/:*?"<>|]+/g, '-').trim();
  return `${safe(prefix)}${suffix ? `-${safe(suffix)}` : ''}.xlsx`.replace(/\s+/g, '_');
}

/** Triggers a browser download of the 6-sheet workbook. */
export async function downloadStudentWorkbook(options = {}) {
  const buffer = await buildStudentWorkbook(options);
  const name = studentWorkbookFileName(options);
  if (typeof document === 'undefined') return { buffer, name };
  const blob = new Blob([buffer], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return { buffer, name };
}

/* ------------------------------------------------------------------ *
 * Upload — strict, format-locked validation (কারণসহ বাংলা এরর)
 * ------------------------------------------------------------------ */

const GENDER_ALIASES = Object.freeze({
  male: 'male', m: 'male', ছাত্র: 'male', পুরুষ: 'male', পুত্র: 'male',
  female: 'female', f: 'female', ছাত্রী: 'female', মহিলা: 'female', মেয়ে: 'female', কন্যা: 'female',
});

/**
 * Validates one cell against its column type.
 * @returns {{ok:true, value:any}|{ok:false, message:string}}
 */
function parseCell(column, raw) {
  const value = text(raw);
  if (!value) {
    return column.required
      ? { ok: false, message: `“${column.header}” আবশ্যক — ঘরটি খালি রাখা যাবে না` }
      : { ok: true, value: '' };
  }
  switch (column.type) {
    case 'roll': {
      const numeric = Number(ascii(value));
      if (!Number.isFinite(numeric) || numeric < 1) {
        return { ok: false, message: `“${column.header}” ঘরে “${value}” বৈধ রোল নম্বর নয় (১ বা তার বেশি লিখুন)` };
      }
      return { ok: true, value: Math.round(numeric) };
    }
    case 'gender': {
      const key = GENDER_ALIASES[ascii(value).toLowerCase()] ?? GENDER_ALIASES[value];
      if (!key) {
        return { ok: false, message: `“${column.header}” ঘরে “${value}” বোঝা যায়নি — ছাত্র/ছাত্রী লিখুন` };
      }
      return { ok: true, value: key };
    }
    case 'phone': {
      const digits = ascii(value).replace(/[^0-9]/g, '');
      if (digits.length < 6) {
        return { ok: false, message: `“${column.header}” ঘরে “${value}” বৈধ ফোন নম্বর নয়` };
      }
      return { ok: true, value: digits };
    }
    case 'number': {
      const digits = ascii(value).replace(/[^0-9]/g, '');
      if (!digits) {
        return { ok: false, message: `“${column.header}” ঘরে “${value}” সংখ্যা নয় — শুধু অঙ্ক লিখুন` };
      }
      return { ok: true, value: digits };
    }
    case 'year': {
      const match = ascii(value).match(/\d{4}/);
      if (!match) {
        return { ok: false, message: `“${column.header}” ঘরে “${value}” বৈধ সাল নয় (যেমন ২০২৬)` };
      }
      return { ok: true, value: match[0] };
    }
    case 'date': {
      const normalized = ascii(value);
      const iso = normalized.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
      if (iso) {
        return { ok: true, value: `${iso[1]}-${iso[2].padStart(2, '0')}-${iso[3].padStart(2, '0')}` };
      }
      const local = normalized.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
      if (local) {
        return { ok: true, value: `${local[3]}-${local[2].padStart(2, '0')}-${local[1].padStart(2, '0')}` };
      }
      return { ok: false, message: `“${column.header}” ঘরে “${value}” বৈধ তারিখ নয় (YYYY-MM-DD বা DD/MM/YYYY)` };
    }
    case 'section':
      return { ok: true, value: cleanSectionLabel(value) };
    default:
      return { ok: true, value };
  }
}



/**
 * Parses and STRICTLY validates an uploaded 6-sheet student workbook.
 *
 * Rejected (with the sheet, row, column and reason) when:
 *  - the file is not a readable `.xlsx`,
 *  - a required sheet is missing or renamed,
 *  - the template stamp line is missing,
 *  - the header row has extra/missing/reordered columns,
 *  - a required value is blank or a number/phone/date cell is malformed.
 *
 * @param {ArrayBuffer|Uint8Array} fileData
 * @returns {Promise<{ok:true, rows:Array<object>, summary:object}|{ok:false, code:string, message:string}>}
 */
export async function parseStudentWorkbook(fileData) {
  if (!fileData) return fail('no-file', 'কোনো ফাইল নির্বাচন করা হয়নি।');

  let XLSX;
  let book;
  try {
    XLSX = await loadXlsx();
    book = XLSX.read(fileData, { type: 'array' });
  } catch {
    return fail('bad-file', 'ফাইলটি পড়া যায়নি। শুধুমাত্র .xlsx ফাইল আপলোড করুন — ফরম্যাট পরিবর্তন করা যাবে না।');
  }

  const names = Array.isArray(book?.SheetNames) ? book.SheetNames : [];
  const missing = STUDENT_SHEET_CLASS_IDS
    .map((classId) => STUDENT_SHEET_NAME_MAP[classId])
    .filter((sheetName) => !names.includes(sheetName));
  if (missing.length) {
    return fail(
      'sheet-missing',
      `প্রত্যাশিত শিট পাওয়া যায়নি: ${missing.join(', ')} — শিটের নাম পরিবর্তন বা মুছে ফেলা যাবে না (পাওয়া গেছে: ${names.join(', ') || 'কিছুই না'})।`,
    );
  }

  const rows = [];
  const perClass = {};

  for (const classId of STUDENT_SHEET_CLASS_IDS) {
    const sheetName = STUDENT_SHEET_NAME_MAP[classId];
    const matrix = XLSX.utils.sheet_to_json(book.Sheets[sheetName], {
      header: 1, blankrows: true, defval: '',
    });
    if (!Array.isArray(matrix) || matrix.length <= STUDENT_HEADER_ROW_INDEX) {
      return fail('empty-sheet', `“${sheetName}” শিটে টেমপ্লেট কাঠামো নেই — শুধু সারি যোগ করুন, হেডার/স্ট্যাম্প মুছবেন না।`);
    }

    const stamp = text(matrix[0]?.[0]);
    if (stamp !== STUDENT_TEMPLATE_MAGIC) {
      return fail(
        'bad-magic',
        `“${sheetName}” শিটের ১ম লাইনে “${STUDENT_TEMPLATE_MAGIC}” থাকা আবশ্যক, পাওয়া গেছে “${stamp || '(খালি)'}” — টেমপ্লেটের কাঠামো পরিবর্তন করা যাবে না।`,
      );
    }

    const headerRow = (matrix[STUDENT_HEADER_ROW_INDEX] ?? []).map(text);
    while (headerRow.length && headerRow[headerRow.length - 1] === '') headerRow.pop();
    if (headerRow.length !== STUDENT_IMPORT_HEADERS.length) {
      return fail(
        'column-count',
        `“${sheetName}” শিটে কলাম সংখ্যা মেলেনি — প্রত্যাশিত ${STUDENT_IMPORT_HEADERS.length}, পাওয়া গেছে ${headerRow.length}। কলাম যোগ/বাদ দেওয়া যাবে না।`,
      );
    }
    for (let index = 0; index < STUDENT_IMPORT_HEADERS.length; index += 1) {
      if (headerRow[index] !== STUDENT_IMPORT_HEADERS[index]) {
        return fail(
          'column-mismatch',
          `“${sheetName}” শিটের ${index + 1} নম্বর কলামে “${STUDENT_IMPORT_HEADERS[index]}” প্রত্যাশিত ছিল, পাওয়া গেছে “${headerRow[index] || '(খালি)'}” — হেডারের নাম বা ক্রম পরিবর্তন করা যাবে না।`,
        );
      }
    }

    let classCount = 0;
    for (let index = STUDENT_FIRST_DATA_ROW_INDEX; index < matrix.length; index += 1) {
      const row = matrix[index] ?? [];
      if (row.every((cell) => text(cell) === '')) continue;
      const values = {};
      for (let columnIndex = 0; columnIndex < STUDENT_IMPORT_COLUMNS.length; columnIndex += 1) {
        const column = STUDENT_IMPORT_COLUMNS[columnIndex];
        const parsed = parseCell(column, row[columnIndex]);
        if (!parsed.ok) {
          return fail(
            'bad-cell',
            `“${sheetName}” শিটের ${index + 1} নম্বর সারি, “${column.header}” কলাম: ${parsed.message}।`,
            { sheet: sheetName, line: index + 1, column: column.header },
          );
        }
        values[column.key] = parsed.value;
      }
      rows.push({ classId, sheet: sheetName, line: index + 1, values });
      classCount += 1;
    }
    // An empty sheet is legal (a class may have no pupil yet).
    perClass[classId] = classCount;
  }

  if (!rows.length) {
    return fail('no-rows', 'ফাইলে কোনো শিক্ষার্থীর সারি পাওয়া যায়নি — অন্তত একটি সারি পূরণ করুন।');
  }

  return {
    ok: true,
    rows,
    summary: { total: rows.length, perClass },
    meta: { sheets: STUDENT_SHEET_CLASS_IDS.map((classId) => STUDENT_SHEET_NAME_MAP[classId]) },
  };
}

/** Class of a worksheet name (`null` for a renamed/unknown sheet). */
export { studentClassOfSheet };

export default {
  STUDENT_HEADER_ROW_INDEX,
  STUDENT_FIRST_DATA_ROW_INDEX,
  buildStudentWorkbook,
  downloadStudentWorkbook,
  parseStudentWorkbook,
  studentWorkbookFileName,
};
