/**
 * Result Excel (.xlsx) export / import for the Results page.
 *
 * The template is generated from the ACTIVE school + session + class + evaluation
 * configuration, so an uploaded file can be validated strictly against it:
 *
 * ```text
 * row 1 : RESULTWEB MARKS TEMPLATE v1
 * row 2 : শ্রেণি            | <class label>
 * row 3 : শ্রেণি কোড        | <classId>
 * row 4 : শিক্ষাবর্ষ        | <year>
 * row 5 : মূল্যায়ন         | <tab label>
 * row 6 : মূল্যায়ন কোড     | <tabId>
 * row 7 : পাস নম্বর        | <passMark>
 * row 8 : (খালি)
 * row 9 : রোল | শিক্ষার্থী আইডি | শিক্ষার্থীর নাম | <subject fields…> | মোট | GPA | গ্রেড
 * row 10+: one row per pupil, in the grid's order
 * ```
 *
 * Only the subject cells are meant to be edited. Sheet name, header cells, subject
 * names, columns and rows are all verified on upload and a mismatch is rejected with
 * the exact reason, never silently accepted.
 */

import { toEnglishNumber } from '../../utils/banglaNumberFormatter.js';
import {
  configEntryFields,
  totalFullMarks,
  classLabelOf,
  tabById,
} from '../../utils/resultConfig.js';
import { toMark } from '../../utils/resultEngine.js';

/**
 * SheetJS is ~400 KB, and only the Results page needs it — so it is loaded on demand
 * (the first download or upload) instead of being part of the initial bundle.
 */
let xlsxPromise = null;
const loadXlsx = () => {
  if (!xlsxPromise) xlsxPromise = import('xlsx');
  return xlsxPromise;
};

export const TEMPLATE_MAGIC = 'RESULTWEB MARKS TEMPLATE v1';
export const TEMPLATE_SHEET = 'নম্বরপত্র';
export const HEADER_ROW_INDEX = 8; // zero-based row of the column headers
export const FIRST_DATA_ROW_INDEX = 9;
export const META_ROWS = 7;

const META_KEYS = ['শ্রেণি', 'শ্রেণি কোড', 'শিক্ষাবর্ষ', 'মূল্যায়ন', 'মূল্যায়ন কোড', 'পাস নম্বর'];

/** Stable mark column headers; duplicates get a numeric suffix so they stay unique. */
export function fieldHeaders(config) {
  const seen = new Map();
  return configEntryFields(config).map((field) => {
    const base = field.component === 'formative'
      ? `${field.subjectName} (গাঠনিক)`
      : field.component === 'summative'
        ? `${field.subjectName} (সামষ্টিক)`
        : field.subjectName;
    const count = (seen.get(base) ?? 0) + 1;
    seen.set(base, count);
    return count === 1 ? base : `${base} ${count}`;
  });
}

/** The full expected header row (identity columns + marks + derived columns). */
export function expectedHeaders(config) {
  return ['রোল', 'শিক্ষার্থী আইডি', 'শিক্ষার্থীর নাম', ...fieldHeaders(config), 'মোট', 'GPA', 'গ্রেড'];
}

/** Everything an upload is validated against (kept in one object). */
export function templateSpec({ schoolProfile, classId, year, tabId, config, students = [] }) {
  const tab = tabById(tabId);
  return {
    magic: TEMPLATE_MAGIC,
    sheet: TEMPLATE_SHEET,
    schoolName: String(schoolProfile?.name ?? '').trim(),
    classId,
    className: classLabelOf(classId),
    year: String(year ?? ''),
    tabId: tab.id,
    tabName: tab.name,
    passMark: Number(config?.passMark) || 33,
    fullMarks: totalFullMarks(config),
    fields: configEntryFields(config),
    headers: expectedHeaders(config),
    students: (students ?? []).map((student) => ({
      id: String(student.id),
      name: String(student.name ?? ''),
      roll: Number(student.roll) || 0,
    })),
  };
}

/** The marks a pupil already has for the active tab (so web entry survives a trip to Excel). */
const currentCellValues = (marks, studentId, field, tab) => {
  const studentMarks = marks?.[studentId] ?? {};
  if (tab.termId) return toMark(studentMarks?.[field.key]?.[tab.termId]);
  // Consolidated tab: the weighted figure is derived, so the sheet shows the mean of
  // the three terms in the subject's own scale (informational, not an input).
  const terms = ['term1', 'term2', 'annual']
    .map((termId) => toMark(studentMarks?.[field.key]?.[termId]))
    .filter((value) => value !== null);
  if (!terms.length) return null;
  return Math.round((terms.reduce((sum, value) => sum + value, 0) / terms.length) * 100) / 100;
};

/**
 * Builds the `.xlsx` workbook (and returns its binary string) for one class + tab.
 * Existing website marks are included, so a teacher can fill part of the class on the
 * web, download, finish in Excel and upload the same file back.
 */
export async function buildResultWorkbook({ spec, marks = {}, computed = {} }) {
  const XLSX = await loadXlsx();
  const tab = tabById(spec.tabId);
  const rows = [];
  rows[0] = [TEMPLATE_MAGIC];
  rows[1] = ['শ্রেণি', spec.className];
  rows[2] = ['শ্রেণি কোড', spec.classId];
  rows[3] = ['শিক্ষাবর্ষ', spec.year];
  rows[4] = ['মূল্যায়ন', spec.tabName];
  rows[5] = ['মূল্যায়ন কোড', spec.tabId];
  rows[6] = ['পাস নম্বর', spec.passMark];
  rows[HEADER_ROW_INDEX] = spec.headers;

  spec.students.forEach((student, index) => {
    const result = computed?.[student.id] ?? {};
    const cells = spec.fields.map((field) => {
      // Consolidated tab: the subject figure IS the weighted result (read-only sheet).
      if (tab.id === 'consolidated') {
        const subject = (result.subjects ?? []).find((item) => item.id === field.subjectId);
        return subject?.total == null ? '' : subject.total;
      }
      const value = currentCellValues(marks, student.id, field, tab);
      return value === null ? '' : value;
    });
    rows[FIRST_DATA_ROW_INDEX + index] = [
      student.roll,
      student.id,
      student.name,
      ...cells,
      result.totalMarks ?? '',
      result.gpa ?? '',
      result.grade ?? '',
    ];
  });

  const sheet = XLSX.utils.aoa_to_sheet(rows);
  const widths = [8, 20, 26, ...spec.fields.map(() => 14), 10, 8, 8];
  sheet['!cols'] = widths.map((wch) => ({ wch }));
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, sheet, TEMPLATE_SHEET);
  return XLSX.write(book, { bookType: 'xlsx', type: 'array', compression: true });
}

/** A safe, human-readable file name of the template. */
export function resultFileName({ spec }) {
  const safe = (value) => String(value ?? '').replace(/[\\/:*?"<>|]+/g, '-').trim();
  return `${safe(spec.className)}-${safe(spec.tabName)}-${safe(spec.year)}.xlsx`.replace(/\s+/g, '_');
}

/** Triggers a browser download of the generated workbook. */
export async function downloadResultExcel(options) {
  const buffer = await buildResultWorkbook(options);
  const name = resultFileName(options);
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
 * Upload — strict validation (কারণ সহ এরর)
 * ------------------------------------------------------------------ */

const text = (value) => String(value ?? '').replace(/\u00a0/g, ' ').trim();
const numberText = (value) => toEnglishNumber(text(value));

/** Errors carry a machine-readable `code` plus a human reason (`message`). */
const error = (code, message) => ({ ok: false, code, message });

/**
 * Parses and STRICTLY validates an uploaded workbook against the template spec.
 *
 * Rejected with an exact reason when: the file is not a workbook, the sheet is
 * renamed, the template stamp is missing, a class/year/tab header was changed, the
 * column headers (subject names, order, count) differ, or the pupil rows were edited
 * (added, removed, reordered, renamed).
 *
 * @returns {{ok:true, rows:object, meta:object}|{ok:false, code:string, message:string}}
 */
export async function parseResultWorkbook(fileData, spec) {
  if (!fileData) return error('no-file', 'কোনো ফাইল নির্বাচন করা হয়নি।');

  let XLSX;
  let book;
  try {
    XLSX = await loadXlsx();
    book = XLSX.read(fileData, { type: 'array' });
  } catch {
    return error('bad-file', 'ফাইলটি পড়া যায়নি। শুধুমাত্র .xlsx ফাইল আপলোড করুন — ফরম্যাট পরিবর্তন করা যাবে না।');
  }

  const names = Array.isArray(book?.SheetNames) ? book.SheetNames : [];
  if (!names.includes(TEMPLATE_SHEET)) {
    return error('sheet-missing', `শিটের নাম "${TEMPLATE_SHEET}" পাওয়া যায়নি (পাওয়া গেছে: ${names.join(', ') || 'কিছুই না'})। শিটের নাম বা ফরম্যাট পরিবর্তন করা যাবে না।`);
  }
  const sheet = book.Sheets[TEMPLATE_SHEET];
  const matrix = XLSX.utils.sheet_to_json(sheet, { header: 1, blankrows: true, defval: '' });
  if (!Array.isArray(matrix) || matrix.length <= HEADER_ROW_INDEX) {
    return error('empty-sheet', 'ফাইলে কোনো ডেটা নেই অথবা টেমপ্লেট ফরম্যাট ভেঙে ফেলা হয়েছে।');
  }

  const cellAt = (rowIndex, colIndex) => text(matrix?.[rowIndex]?.[colIndex]);

  if (cellAt(0, 0) !== TEMPLATE_MAGIC) {
    return error('bad-magic', `টেমপ্লেট শনাক্তকরণ লাইন "${TEMPLATE_MAGIC}" পাওয়া যায়নি। ফাইলটি আমাদের ডাউনলোড করা টেমপ্লেট নয় বা ফরম্যাট পরিবর্তন করা হয়েছে।`);
  }
  for (let index = 0; index < META_KEYS.length; index += 1) {
    const found = cellAt(index + 1, 0);
    if (found !== META_KEYS[index]) {
      return error('bad-meta', `লাইন ${index + 2}-এ "${META_KEYS[index]}" প্রত্যাশিত ছিল, পাওয়া গেছে "${found || '(খালি)'}". টেমপ্লেটের লাইন/কলাম কাঠামো পরিবর্তন করা যাবে না।`);
    }
  }

  const meta = {
    className: cellAt(1, 1),
    classId: cellAt(2, 1),
    year: numberText(cellAt(3, 1)),
    tabName: cellAt(4, 1),
    tabId: cellAt(5, 1),
    passMark: numberText(cellAt(6, 1)),
  };

  if (meta.classId !== String(spec.classId)) {
    return error('class-mismatch', `ফাইলটি "${meta.classId}" শ্রেণির, কিন্তু বর্তমান শ্রেণি "${spec.classId}"। সঠিক শ্রেণির টেমপ্লেট ডাউনলোড করে ব্যবহার করুন।`);
  }
  if (meta.tabId !== String(spec.tabId)) {
    return error('tab-mismatch', `ফাইলটি "${meta.tabName || meta.tabId}" মূল্যায়নের, কিন্তু বর্তমান ট্যাব "${spec.tabName}"। মূল্যায়নের নাম/কোড পরিবর্তন করা যাবে না।`);
  }
  if (spec.year && meta.year && meta.year !== String(spec.year)) {
    return error('year-mismatch', `ফাইলটি ${meta.year} শিক্ষাবর্ষের, কিন্তু সক্রিয় শিক্ষাবর্ষ ${spec.year}।`);
  }

  const headerRow = (matrix[HEADER_ROW_INDEX] ?? []).map(text);
  while (headerRow.length && headerRow[headerRow.length - 1] === '') headerRow.pop();
  const expected = spec.headers;
  if (headerRow.length !== expected.length) {
    return error('column-count', `কলাম সংখ্যা মেলেনি — প্রত্যাশিত ${expected.length}, পাওয়া গেছে ${headerRow.length}। নতুন কলাম যোগ/বাদ দেওয়া যাবে না।`);
  }
  for (let index = 0; index < expected.length; index += 1) {
    if (headerRow[index] !== expected[index]) {
      return error('column-mismatch', `কলাম ${index + 1}-এ "${expected[index]}" প্রত্যাশিত ছিল, পাওয়া গেছে "${headerRow[index] || '(খালি)'}". বিষয়ের নাম বা কলামের ক্রম পরিবর্তন করা যাবে না।`);
    }
  }

  // Rows: the pupil block must match the class roster exactly (same ids, same order).
  const dataRows = [];
  for (let index = FIRST_DATA_ROW_INDEX; index < matrix.length; index += 1) {
    const row = matrix[index] ?? [];
    if (row.every((value) => text(value) === '')) continue;
    dataRows.push({ index, row });
  }
  if (dataRows.length !== spec.students.length) {
    return error('row-count', `শিক্ষার্থীর সারি মেলেনি — প্রত্যাশিত ${spec.students.length}, পাওয়া গেছে ${dataRows.length}। সারি যোগ, মুছে ফেলা বা পুনর্বিন্যাস করা যাবে না।`);
  }

  const values = {};
  for (let offset = 0; offset < spec.students.length; offset += 1) {
    const student = spec.students[offset];
    const { index, row } = dataRows[offset];
    const rowId = text(row[1]);
    if (rowId !== student.id) {
      return error('row-mismatch', `সারি ${index + 1}-এ শিক্ষার্থী আইডি "${student.id}" প্রত্যাশিত ছিল, পাওয়া গেছে "${rowId || '(খালি)'}". শিক্ষার্থীর সারি বা ক্রম পরিবর্তন করা যাবে না।`);
    }
    const rowRoll = Number(numberText(row[0]));
    if (Number.isFinite(rowRoll) && rowRoll !== Number(student.roll)) {
      return error('roll-mismatch', `সারি ${index + 1}-এ রোল ${student.roll} প্রত্যাশিত ছিল, পাওয়া গেছে ${rowRoll}. রোল কলাম পরিবর্তন করা যাবে না।`);
    }
    const rowName = text(row[2]);
    if (rowName && rowName !== text(student.name)) {
      return error('name-mismatch', `সারি ${index + 1}-এ নাম "${student.name}" প্রত্যাশিত ছিল, পাওয়া গেছে "${rowName}". শিক্ষার্থীর নাম পরিবর্তন করা যাবে না।`);
    }

    const studentValues = {};
    for (let fieldIndex = 0; fieldIndex < spec.fields.length; fieldIndex += 1) {
      const field = spec.fields[fieldIndex];
      const raw = text(row[3 + fieldIndex]);
      if (raw === '') {
        studentValues[field.key] = null;
        continue;
      }
      const numeric = Number(toEnglishNumber(raw));
      if (!Number.isFinite(numeric)) {
        return error('bad-mark', `সারি ${index + 1}, "${field.label}" ঘরে "${raw}" একটি সংখ্যা নয়। শুধু নম্বর লিখুন।`);
      }
      if (numeric < 0 || numeric > field.max) {
        return error('mark-range', `সারি ${index + 1}, "${field.label}" ঘরে ${raw} সীমার বাইরে (০–${field.max})।`);
      }
      studentValues[field.key] = Math.round(numeric * 100) / 100;
    }
    values[student.id] = studentValues;
  }

  return { ok: true, rows: values, meta };
}

export default {
  TEMPLATE_MAGIC,
  TEMPLATE_SHEET,
  templateSpec,
  buildResultWorkbook,
  downloadResultExcel,
  parseResultWorkbook,
  expectedHeaders,
  fieldHeaders,
};

