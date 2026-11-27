/**
 * Result Excel (.xlsx) export / import for the Results page.
 *
 * ONE workbook, SIX sheets — one per class (প্রাক-প্রাথমিক … ৫ম শ্রেণি), in
 * CLASS_LEVELS order, for the ACTIVE evaluation tab (১ম / ২য় / বার্ষিক /
 * বার্ষিক ফলাফল). Every sheet holds ALL pupils of its class, ALL sections,
 * ordered শাখা ক → খ → গ, then by roll inside each শাখা:
 *
 * ```text
 * row 1 : RESULTWEB MARKS TEMPLATE v1 | <school name>          (title, merged)
 * row 2 : শ্রেণি            | <class label>
 * row 3 : শ্রেণি কোড        | <classId>
 * row 4 : শিক্ষাবর্ষ        | <year>
 * row 5 : মূল্যায়ন         | <tab label>
 * row 6 : মূল্যায়ন কোড     | <tabId>
 * row 7 : পাস নম্বর        | <passMark>
 * row 8 : (খালি)
 * row 9 : রোল | শাখা | শিক্ষার্থী আইডি | শিক্ষার্থীর নাম | <subject fields…> | মোট | GPA | গ্রেড
 * row 10+: one row per pupil — শাখা ক first, then খ, then গ, roll inside each শাখা
 * ```
 *
 * The download is built with ExcelJS (real formatting: title, bold header with a
 * fill, frozen panes, borders, mark cells highlighted) and loaded on demand, so
 * the main bundle stays small. Upload parsing still uses SheetJS (`xlsx`) — it
 * reads ExcelJS files fine — and stays STRICT: every sheet is validated against
 * its own class spec (sheet name, meta, headers, pupil rows in exact order) and
 * ANY failure rejects the whole file with the exact reason, never silently.
 *
 * Backward compatibility: a single-sheet file downloaded by the OLD format
 * (sheet "নম্বরপত্র", no শাখা column) is still accepted and parsed for its
 * class, so a teacher who downloaded yesterday can still upload it.
 */

import { toEnglishNumber } from '../../utils/banglaNumberFormatter.js';
import {
  configEntryFields,
  totalFullMarks,
  classLabelOf,
  tabById,
} from '../../utils/resultConfig.js';
import { toMark } from '../../utils/resultEngine.js';

/** SheetJS is only needed for upload parsing — loaded on demand. */
let xlsxPromise = null;
const loadXlsx = () => {
  if (!xlsxPromise) xlsxPromise = import('xlsx');
  return xlsxPromise;
};

/** ExcelJS is only needed for the download — loaded on demand (it is large). */
let excelJsPromise = null;
export const loadExcelJs = () => {
  if (!excelJsPromise) excelJsPromise = import('exceljs');
  return excelJsPromise;
};

export const TEMPLATE_MAGIC = 'RESULTWEB MARKS TEMPLATE v1';
/** Sheet name of the OLD single-sheet format (still accepted on upload). */
export const TEMPLATE_SHEET = 'নম্বরপত্র';
export const HEADER_ROW_INDEX = 8; // zero-based row of the column headers
export const FIRST_DATA_ROW_INDEX = 9;
export const META_ROWS = 7;

const META_KEYS = ['শ্রেণি', 'শ্রেণি কোড', 'শিক্ষাবর্ষ', 'মূল্যায়ন', 'মূল্যায়ন কোড', 'পাস নম্বর'];

/** শাখা order inside a sheet: ক first, then খ, then গ, then any other শাখা. */
export const SECTION_ORDER = ['ক', 'খ', 'গ'];

/**
 * Sorts pupils for an Excel sheet: শাখা ক → খ → গ (other sections after, in the
 * declared `sections` order), then roll inside each শাখা. `sections` is the
 * class's declared section list from `getSectionsOfClass` (its first entry is
 * the default শাখা ক).
 */
export function sortStudentsForExcel(students = [], sections = []) {
  const rankOf = (section) => {
    const fixed = SECTION_ORDER.indexOf(section);
    if (fixed !== -1) return fixed;
    const declared = (sections ?? []).indexOf(section);
    return SECTION_ORDER.length + (declared === -1 ? (sections ?? []).length : declared);
  };
  return [...(students ?? [])].sort((a, b) => {
    const bySection = rankOf(String(a?.section ?? '').trim() || 'ক')
      - rankOf(String(b?.section ?? '').trim() || 'ক');
    if (bySection !== 0) return bySection;
    return (Number(a?.roll) || 0) - (Number(b?.roll) || 0);
  });
}

/** Stable mark column headers from a fields list; duplicates get a numeric suffix. */
export function fieldHeadersForFields(fields = []) {
  const seen = new Map();
  return fields.map((field) => {
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

/** Stable mark column headers; duplicates get a numeric suffix so they stay unique. */
export function fieldHeaders(config) {
  return fieldHeadersForFields(configEntryFields(config));
}

/** The full expected header row (identity columns + marks + derived columns). */
export function expectedHeaders(config) {
  return ['রোল', 'শাখা', 'শিক্ষার্থী আইডি', 'শিক্ষার্থীর নাম', ...fieldHeaders(config), 'মোট', 'GPA', 'গ্রেড'];
}

/** Header row of the OLD single-sheet format (no শাখা column) — from a spec. */
export function legacyExpectedHeaders(spec) {
  return ['রোল', 'শিক্ষার্থী আইডি', 'শিক্ষার্থীর নাম', ...fieldHeadersForFields(spec.fields), 'মোট', 'GPA', 'গ্রেড'];
}

/** Everything an upload is validated against (kept in one object, per class). */
export function templateSpec({ schoolProfile, classId, year, tabId, config, students = [], sections = [] }) {
  const tab = tabById(tabId);
  return {
    magic: TEMPLATE_MAGIC,
    sheet: classLabelOf(classId),
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
    students: sortStudentsForExcel(students, sections).map((student) => ({
      id: String(student.id),
      name: String(student.name ?? ''),
      roll: Number(student.roll) || 0,
      section: String(student.section ?? '').trim() || 'ক',
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

/* ------------------------------------------------------------------ *
 * Download — ExcelJS, one formatted sheet per class
 * ------------------------------------------------------------------ */

/** `A` … `Z`, `AA` … — ExcelJS needs letters for ranges and merges. */
export const columnLetter = (index) => {
  let letter = '';
  let value = index + 1;
  while (value > 0) {
    const remainder = (value - 1) % 26;
    letter = String.fromCharCode(65 + remainder) + letter;
    value = Math.floor((value - 1) / 26);
  }
  return letter;
};

export const THIN_BORDER = {
  top: { style: 'thin', color: { argb: 'FFD1D5DB' } },
  left: { style: 'thin', color: { argb: 'FFD1D5DB' } },
  bottom: { style: 'thin', color: { argb: 'FFD1D5DB' } },
  right: { style: 'thin', color: { argb: 'FFD1D5DB' } },
};
export const HEADER_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0F766E' } };
export const MARK_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFFDE7' } };
export const DERIVED_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF1F5F9' } };
export const BAND_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF8FAFC' } };

/** Builds ONE class sheet inside an ExcelJS workbook. */
const addClassSheet = (workbook, spec, marks = {}, computed = {}) => {
  const tab = tabById(spec.tabId);
  const columnCount = spec.headers.length;
  const lastLetter = columnLetter(columnCount - 1);
  const sheet = workbook.addWorksheet(spec.className, {
    properties: { tabColor: { argb: 'FF0F766E' } },
  });

  sheet.columns = [
    { width: 8 }, // রোল
    { width: 8 }, // শাখা
    { width: 20 }, // শিক্ষার্থী আইডি
    { width: 26 }, // শিক্ষার্থীর নাম
    ...spec.fields.map(() => ({ width: 13 })),
    { width: 10 }, // মোট
    { width: 8 }, // GPA
    { width: 8 }, // গ্রেড
  ];

  // Row 1 — template stamp + school name as the visible title.
  sheet.getCell('A1').value = TEMPLATE_MAGIC;
  sheet.getCell('A1').font = { size: 9, italic: true, color: { argb: 'FF94A3B8' } };
  if (spec.schoolName) {
    sheet.mergeCells(`B1:${lastLetter}1`);
    const title = sheet.getCell('B1');
    title.value = spec.schoolName;
    title.font = { size: 13, bold: true, color: { argb: 'FF0F766E' } };
    title.alignment = { horizontal: 'left', vertical: 'middle' };
  }
  sheet.getRow(1).height = 20;

  // Rows 2–7 — meta (label bold, value plain).
  const metaValues = [spec.className, spec.classId, spec.year, spec.tabName, spec.tabId, spec.passMark];
  META_KEYS.forEach((key, index) => {
    const row = sheet.getRow(index + 2);
    row.getCell(1).value = key;
    row.getCell(1).font = { bold: true, size: 11 };
    row.getCell(2).value = metaValues[index];
    row.getCell(2).font = { size: 11 };
  });
  // Row 8 stays blank.

  // Row 9 — header, bold white on a brand fill.
  const headerRow = sheet.getRow(HEADER_ROW_INDEX + 1);
  spec.headers.forEach((header, index) => {
    const cell = headerRow.getCell(index + 1);
    cell.value = header;
    cell.font = { bold: true, size: 11, color: { argb: 'FFFFFFFF' } };
    cell.fill = HEADER_FILL;
    cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
    cell.border = THIN_BORDER;
  });
  headerRow.height = 30;

  // Rows 10+ — one pupil per row (শাখা ক → খ → গ, roll inside each শাখা).
  spec.students.forEach((student, index) => {
    const rowNumber = FIRST_DATA_ROW_INDEX + 1 + index;
    const row = sheet.getRow(rowNumber);
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
    const values = [
      student.roll,
      student.section,
      student.id,
      student.name,
      ...cells,
      result.totalMarks ?? '',
      result.gpa ?? '',
      result.grade ?? '',
    ];
    values.forEach((value, colIndex) => {
      const cell = row.getCell(colIndex + 1);
      cell.value = value;
      cell.border = THIN_BORDER;
      cell.font = { size: 11 };
      if (colIndex === 0 || colIndex === 1) cell.alignment = { horizontal: 'center' };
      if (colIndex === 3) cell.font = { size: 11, bold: true };
      // Mark cells (yellow) vs derived মোট/GPA/গ্রেড (grey); identity cells band.
      if (colIndex >= 4 && colIndex < 4 + spec.fields.length) {
        cell.fill = MARK_FILL;
        cell.alignment = { horizontal: 'center' };
      } else if (colIndex >= 4 + spec.fields.length) {
        cell.fill = DERIVED_FILL;
        cell.alignment = { horizontal: 'center' };
        if (colIndex === 4 + spec.fields.length) cell.font = { size: 11, bold: true };
      } else if (index % 2 === 1) {
        cell.fill = BAND_FILL;
      }
    });
    row.height = 19;
  });

  // Header + first 4 columns stay put while the teacher scrolls the marks.
  sheet.views = [{ state: 'frozen', xSplit: 4, ySplit: HEADER_ROW_INDEX + 1 }];
  sheet.autoFilter = { from: `A${HEADER_ROW_INDEX + 1}`, to: `${lastLetter}${HEADER_ROW_INDEX + 1}` };
  sheet.pageSetup = {
    orientation: 'landscape', paperSize: 9, fitToPage: true, fitToWidth: 1, fitToHeight: 0,
  };
  sheet.printTitleRows = `${HEADER_ROW_INDEX + 1}:${HEADER_ROW_INDEX + 1}`;
  return sheet;
};

/**
 * Builds the `.xlsx` workbook (and returns its binary buffer) — one formatted
 * sheet per class, for one tab. `specs` is the array of per-class specs;
 * a single `spec` is also accepted and wrapped. Existing website marks are
 * included, so a teacher can fill part of the school on the web, download,
 * finish in Excel and upload the same file back.
 */
export async function buildResultWorkbook({ specs, spec, marks = {}, computed = {} }) {
  const list = Array.isArray(specs) ? specs : [spec].filter(Boolean);
  if (!list.length) throw new Error('কোনো শ্রেণির টেমপ্লেট দেওয়া হয়নি।');
  const { default: ExcelJS } = await loadExcelJs();
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'ResultWeb';
  workbook.created = new Date();
  list.forEach((item) => addClassSheet(workbook, item, marks, computed));
  return workbook.xlsx.writeBuffer();
}

/** A safe, human-readable file name: বিদ্যালয়–মূল্যায়ন–শিক্ষাবর্ষ. */
export function resultFileName({ specs, spec }) {
  const list = Array.isArray(specs) ? specs : [spec].filter(Boolean);
  const first = list[0] ?? {};
  const safe = (value) => String(value ?? '').replace(/[\\/:*?"<>|]+/g, '-').trim();
  const school = safe(first.schoolName);
  const parts = [school, safe(first.tabName), safe(first.year)].filter(Boolean);
  return `${parts.join('-')}.xlsx`.replace(/\s+/g, '_');
}

/** Triggers a browser download of the generated 6-sheet workbook. */
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
 * Upload — strict validation (কারণ সহ এরর), all 6 sheets
 * ------------------------------------------------------------------ */

const text = (value) => String(value ?? '').replace(/\u00a0/g, ' ').trim();
const numberText = (value) => toEnglishNumber(text(value));

/** Errors carry a machine-readable `code` plus a human reason (`message`). */
const error = (code, message) => ({ ok: false, code, message });

/**
 * Validates ONE sheet matrix against ONE class spec.
 *
 * @param {boolean} legacy — the OLD single-sheet layout (no শাখা column):
 *   রোল | আইডি | নাম | fields… — column offsets shift by one.
 */
const parseSheetMatrix = (matrix, spec, { legacy = false, sheetLabel = '' } = {}) => {
  const prefix = sheetLabel ? `শিট "${sheetLabel}": ` : '';
  const fail = (code, message) => error(code, `${prefix}${message}`);
  if (!Array.isArray(matrix) || matrix.length <= HEADER_ROW_INDEX) {
    return fail('empty-sheet', 'ফাইলে কোনো ডেটা নেই অথবা টেমপ্লেট ফরম্যাট ভেঙে ফেলা হয়েছে।');
  }

  const cellAt = (rowIndex, colIndex) => text(matrix?.[rowIndex]?.[colIndex]);

  if (cellAt(0, 0) !== TEMPLATE_MAGIC) {
    return fail('bad-magic', `টেমপ্লেট শনাক্তকরণ লাইন "${TEMPLATE_MAGIC}" পাওয়া যায়নি। ফাইলটি আমাদের ডাউনলোড করা টেমপ্লেট নয় বা ফরম্যাট পরিবর্তন করা হয়েছে।`);
  }
  for (let index = 0; index < META_KEYS.length; index += 1) {
    const found = cellAt(index + 1, 0);
    if (found !== META_KEYS[index]) {
      return fail('bad-meta', `লাইন ${index + 2}-এ "${META_KEYS[index]}" প্রত্যাশিত ছিল, পাওয়া গেছে "${found || '(খালি)'}". টেমপ্লেটের লাইন/কলাম কাঠামো পরিবর্তন করা যাবে না।`);
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
    return fail('class-mismatch', `ফাইলটি "${meta.classId}" শ্রেণির, কিন্তু এই শিট "${spec.className}" শ্রেণির। সঠিক শ্রেণির টেমপ্লেট ডাউনলোড করে ব্যবহার করুন।`);
  }
  if (meta.tabId !== String(spec.tabId)) {
    return fail('tab-mismatch', `ফাইলটি "${meta.tabName || meta.tabId}" মূল্যায়নের, কিন্তু বর্তমান ট্যাব "${spec.tabName}"। মূল্যায়নের নাম/কোড পরিবর্তন করা যাবে না।`);
  }
  if (spec.year && meta.year && meta.year !== String(spec.year)) {
    return fail('year-mismatch', `ফাইলটি ${meta.year} শিক্ষাবর্ষের, কিন্তু সক্রিয় শিক্ষাবর্ষ ${spec.year}।`);
  }

  const headerRow = (matrix[HEADER_ROW_INDEX] ?? []).map(text);
  while (headerRow.length && headerRow[headerRow.length - 1] === '') headerRow.pop();
  const expected = legacy ? legacyExpectedHeaders(spec) : spec.headers;
  if (headerRow.length !== expected.length) {
    return fail('column-count', `কলাম সংখ্যা মেলেনি — প্রত্যাশিত ${expected.length}, পাওয়া গেছে ${headerRow.length}। নতুন কলাম যোগ/বাদ দেওয়া যাবে না।`);
  }
  for (let index = 0; index < expected.length; index += 1) {
    if (headerRow[index] !== expected[index]) {
      return fail('column-mismatch', `কলাম ${index + 1}-এ "${expected[index]}" প্রত্যাশিত ছিল, পাওয়া গেছে "${headerRow[index] || '(খালি)'}". বিষয়ের নাম বা কলামের ক্রম পরিবর্তন করা যাবে না।`);
    }
  }

  // Column offsets: the new layout has শাখা at index 1, the old one does not.
  const idCol = legacy ? 1 : 2;
  const nameCol = legacy ? 2 : 3;
  const fieldCol = legacy ? 3 : 4;

  // Rows: the pupil block must match the class roster exactly (same ids, same order).
  const dataRows = [];
  for (let index = FIRST_DATA_ROW_INDEX; index < matrix.length; index += 1) {
    const row = matrix[index] ?? [];
    if (row.every((value) => text(value) === '')) continue;
    dataRows.push({ index, row });
  }
  if (dataRows.length !== spec.students.length) {
    return fail('row-count', `শিক্ষার্থীর সারি মেলেনি — প্রত্যাশিত ${spec.students.length}, পাওয়া গেছে ${dataRows.length}। সারি যোগ, মুছে ফেলা বা পুনর্বিন্যাস করা যাবে না।`);
  }

  const values = {};
  for (let offset = 0; offset < spec.students.length; offset += 1) {
    const student = spec.students[offset];
    const { index, row } = dataRows[offset];
    const rowId = text(row[idCol]);
    if (rowId !== student.id) {
      return fail('row-mismatch', `সারি ${index + 1}-এ শিক্ষার্থী আইডি "${student.id}" প্রত্যাশিত ছিল, পাওয়া গেছে "${rowId || '(খালি)'}". শিক্ষার্থীর সারি বা ক্রম পরিবর্তন করা যাবে না।`);
    }
    const rowRoll = Number(numberText(row[0]));
    if (Number.isFinite(rowRoll) && rowRoll !== Number(student.roll)) {
      return fail('roll-mismatch', `সারি ${index + 1}-এ রোল ${student.roll} প্রত্যাশিত ছিল, পাওয়া গেছে ${rowRoll}. রোল কলাম পরিবর্তন করা যাবে না।`);
    }
    if (!legacy) {
      const rowSection = text(row[1]);
      if (rowSection && rowSection !== student.section) {
        return fail('section-mismatch', `সারি ${index + 1}-এ শাখা "${student.section}" প্রত্যাশিত ছিল, পাওয়া গেছে "${rowSection}". শাখা কলাম পরিবর্তন করা যাবে না।`);
      }
    }
    const rowName = text(row[nameCol]);
    if (rowName && rowName !== text(student.name)) {
      return fail('name-mismatch', `সারি ${index + 1}-এ নাম "${student.name}" প্রত্যাশিত ছিল, পাওয়া গেছে "${rowName}". শিক্ষার্থীর নাম পরিবর্তন করা যাবে না।`);
    }

    const studentValues = {};
    for (let fieldIndex = 0; fieldIndex < spec.fields.length; fieldIndex += 1) {
      const field = spec.fields[fieldIndex];
      const raw = text(row[fieldCol + fieldIndex]);
      if (raw === '') {
        studentValues[field.key] = null;
        continue;
      }
      const numeric = Number(toEnglishNumber(raw));
      if (!Number.isFinite(numeric)) {
        return fail('bad-mark', `সারি ${index + 1}, "${field.label}" ঘরে "${raw}" একটি সংখ্যা নয়। শুধু নম্বর লিখুন।`);
      }
      if (numeric < 0 || numeric > field.max) {
        return fail('mark-range', `সারি ${index + 1}, "${field.label}" ঘরে ${raw} সীমার বাইরে (০–${field.max})।`);
      }
      studentValues[field.key] = Math.round(numeric * 100) / 100;
    }
    values[student.id] = studentValues;
  }

  return { ok: true, rows: values, meta };
};

/**
 * Parses and STRICTLY validates an uploaded workbook against the per-class specs.
 *
 * New format: one sheet per class, named by the class label. Rejected with an
 * exact reason when: the file is not a workbook, a class sheet is missing, the
 * template stamp is missing, a class/year/tab header was changed, the column
 * headers (subject names, order, count) differ, or the pupil rows were edited
 * (added, removed, reordered, renamed). ANY sheet failing rejects the whole file.
 *
 * Old format (one sheet named "নম্বরপত্র", no শাখা column) is still accepted
 * for its own class.
 *
 * @param {Uint8Array|ArrayBuffer} fileData
 * @param {object|object[]} specs — one spec per class (or a single spec)
 * @returns {{ok:true, rowsByClass:object, specsByClass:object, metas:object}
 *   | {ok:false, code:string, message:string}}
 */
export async function parseResultWorkbook(fileData, specsInput) {
  const specs = (Array.isArray(specsInput) ? specsInput : [specsInput]).filter(Boolean);
  if (!fileData) return error('no-file', 'কোনো ফাইল নির্বাচন করা হয়নি।');
  if (!specs.length) return error('no-spec', 'যাচাইয়ের টেমপ্লেট পাওয়া যায়নি।');

  let XLSX;
  let book;
  try {
    XLSX = await loadXlsx();
    book = XLSX.read(fileData, { type: 'array' });
  } catch {
    return error('bad-file', 'ফাইলটি পড়া যায়নি। শুধুমাত্র .xlsx ফাইল আপলোড করুন — ফরম্যাট পরিবর্তন করা যাবে না।');
  }

  const names = Array.isArray(book?.SheetNames) ? book.SheetNames : [];
  const toMatrix = (sheetName) => XLSX.utils.sheet_to_json(
    book.Sheets[sheetName], { header: 1, blankrows: true, defval: '' },
  );

  // OLD single-sheet file: one sheet named "নম্বরপত্র", no শাখা column.
  if (names.length === 1 && names[0] === TEMPLATE_SHEET) {
    const matrix = toMatrix(TEMPLATE_SHEET);
    const metaClassId = text(matrix?.[2]?.[1]);
    const spec = specs.find((item) => String(item.classId) === metaClassId) ?? specs[0];
    const parsed = parseSheetMatrix(matrix, spec, { legacy: true, sheetLabel: TEMPLATE_SHEET });
    if (!parsed.ok) return parsed;
    return {
      ok: true,
      rowsByClass: { [spec.classId]: parsed.rows },
      specsByClass: { [spec.classId]: spec },
      metas: { [spec.classId]: parsed.meta },
    };
  }

  const rowsByClass = {};
  const specsByClass = {};
  const metas = {};
  for (const spec of specs) {
    if (!names.includes(spec.className)) {
      return error(
        'sheet-missing',
        `শিট "${spec.className}" পাওয়া যায়নি (পাওয়া গেছে: ${names.join(', ') || 'কিছুই না'})। সব শ্রেণির শিটসহ ডাউনলোড করা ফাইলটি আপলোড করুন — শিটের নাম পরিবর্তন করা যাবে না।`,
      );
    }
    const parsed = parseSheetMatrix(toMatrix(spec.className), spec, { sheetLabel: spec.className });
    if (!parsed.ok) return parsed;
    rowsByClass[spec.classId] = parsed.rows;
    specsByClass[spec.classId] = spec;
    metas[spec.classId] = parsed.meta;
  }

  return { ok: true, rowsByClass, specsByClass, metas };
}

export default {
  TEMPLATE_MAGIC,
  TEMPLATE_SHEET,
  templateSpec,
  sortStudentsForExcel,
  buildResultWorkbook,
  downloadResultExcel,
  parseResultWorkbook,
  expectedHeaders,
  fieldHeaders,
};
