/**
 * Result LIST Excel (.xlsx) export — the on-screen list, exactly as shown (হুবহু).
 *
 * This is a READ-ONLY report, NOT an upload template:
 * - One workbook, one sheet per class (CLASS_LEVELS order), for the ACTIVE tab
 *   only — clicking another tab downloads that term's own file.
 * - Each sheet mirrors the grid columns as displayed: রোল | শাখা | নাম |
 *   subject marks (গাঠনিক/সামষ্টিক per subject) | মোট | GPA | গ্রেড | মেধাক্রম |
 *   নতুন রোল (when it exists) | মন্তব্য. The consolidated tab mirrors the
 *   বার্ষিক ফলাফল table instead: per-term weighted MARKS, মোট, ফলাফল, GPA,
 *   গ্রেড, মেধাক্রম, নতুন রোল, মন্তব্য.
 * - Every value is the COMPUTED/displayed value — totals, GPA, grade, merit
 *   and remarks come from the engine (`getClassRows` / `getRemark`), never
 *   recomputed here. Rows are ordered শাখা ক → খ → গ, then roll, exactly like
 *   the marks template (`sortStudentsForExcel`).
 * - Deliberately NOT parseable by the marks upload: the first cell carries
 *   `RESULTWEB RESULT LIST` instead of the template stamp, and there are no
 *   meta rows — `parseResultWorkbook` rejects it with `bad-magic`.
 */

import { configEntryFields, tabById } from '../../utils/resultConfig.js';
import {
  BAND_FILL,
  DERIVED_FILL,
  HEADER_FILL,
  MARK_FILL,
  THIN_BORDER,
  columnLetter,
  fieldHeaders,
  loadExcelJs,
  sortStudentsForExcel,
} from './resultExcel.js';
import { termCellsOf } from '../../components/results/ConsolidatedAnnualTable.jsx';

export const LIST_MAGIC = 'RESULTWEB RESULT LIST';
const TITLE_ROW = 1;
const SUBTITLE_ROW = 2;
const HEADER_ROW_INDEX = 2; // zero-based row of the column headers (row 3)
const FIRST_DATA_ROW_INDEX = 3;

const safe = (value) => String(value ?? '').replace(/[\\/:*?"<>|]+/g, '-').trim();

/** Header row of a term-tab sheet (grid columns as displayed). */
export function listHeaders({ config, tabId, showNewRoll = false }) {
  if (tabId === 'consolidated') {
    return [
      'রোল', 'শাখা', 'শিক্ষার্থীর নাম',
      '১ম প্রান্তিক', '২য় প্রান্তিক', 'বার্ষিক মূল্যায়ন',
      'মোট নম্বর', 'ফলাফল', 'GPA', 'গ্রেড', 'মেধাক্রম', 'নতুন রোল', 'মন্তব্য',
    ];
  }
  const headers = [
    'রোল', 'শাখা', 'শিক্ষার্থীর নাম',
    ...fieldHeaders(config),
    'মোট', 'GPA', 'গ্রেড', 'মেধাক্রম',
  ];
  if (showNewRoll) headers.push('নতুন রোল');
  headers.push('মন্তব্য');
  return headers;
}

const blank = (value) => (value === null || value === undefined || value === '' ? '' : value);

/** Subject-mark cells of one pupil on a term tab (computed values, never re-derived). */
const termSubjectCells = (result, fields) => fields.map((field) => {
  const subject = (result?.subjects ?? []).find((item) => item.id === field.subjectId);
  if (!subject) return '';
  if (field.component === 'formative') return blank(subject.formative);
  if (field.component === 'summative') return blank(subject.summative);
  return blank(subject.total ?? subject.mark);
});

/** One data row of a class sheet, in the exact order of `headers`. */
const listRowValues = ({ tabId, headers, fields, student, row, remark }) => {
  const result = row?.result ?? {};
  const hasAny = result.hasAnyMark === true;
  const values = [student.roll, student.section, student.name];
  if (tabId === 'consolidated') {
    const terms = termCellsOf(result);
    terms.forEach((cell) => values.push(cell?.weightedMarks ?? ''));
    values.push(
      hasAny ? result.totalMarks : '',
      !hasAny ? 'মূল্যায়ন হয়নি' : (result.isPass ? 'উত্তীর্ণ' : 'অনুত্তীর্ণ'),
      hasAny ? result.gpa : '',
      hasAny ? result.grade : '',
      hasAny ? row.position : '',
      hasAny ? (row.newRoll ?? '') : '',
      remark || '',
    );
    return values;
  }
  values.push(
    ...termSubjectCells(result, fields),
    hasAny ? result.totalMarks : '',
    hasAny ? result.gpa : '',
    hasAny ? result.grade : '',
    hasAny ? row.position : '',
  );
  if (headers.includes('নতুন রোল')) values.push(hasAny ? (row.newRoll ?? '') : '');
  values.push(remark || '');
  return values;
};

/** Column widths of a class sheet (মন্তব্য is wide — it carries full sentences). */
const listWidths = (headers, fieldCount) => {
  if (headers[3] === '১ম প্রান্তিক') {
    return [8, 8, 26, 13, 13, 14, 10, 12, 8, 8, 10, 10, 40];
  }
  return [
    8, // রোল
    8, // শাখা
    26, // শিক্ষার্থীর নাম
    ...Array.from({ length: fieldCount }, () => 13),
    10, // মোট
    8, // GPA
    8, // গ্রেড
    10, // মেধাক্রম
    ...(headers.includes('নতুন রোল') ? [10] : []),
    40, // মন্তব্য
  ];
};

/** Builds ONE class sheet inside an ExcelJS workbook. */
const addListSheet = (workbook, cls, { schoolName, year, tabId, tabName }) => {
  const tab = tabById(tabId);
  const fields = configEntryFields(cls.config);
  const students = sortStudentsForExcel(cls.students ?? [], cls.sections ?? []);
  const rowById = new Map((cls.rows ?? []).map((row) => [row.studentId, row]));
  const showNewRoll = tabId === 'consolidated'
    || (cls.rows ?? []).some((row) => row?.newRoll != null);
  const headers = listHeaders({ config: cls.config, tabId, showNewRoll });
  const columnCount = headers.length;
  const lastLetter = columnLetter(columnCount - 1);
  const sheet = workbook.addWorksheet(cls.className, {
    properties: { tabColor: { argb: 'FF0F766E' } },
  });

  sheet.columns = listWidths(headers, fields.length).map((width) => ({ width }));

  // Row 1 — list stamp + school name as the visible title.
  sheet.getCell('A1').value = LIST_MAGIC;
  sheet.getCell('A1').font = { size: 9, italic: true, color: { argb: 'FF94A3B8' } };
  if (schoolName) {
    sheet.mergeCells(`B1:${lastLetter}1`);
    const title = sheet.getCell('B1');
    title.value = schoolName;
    title.font = { size: 13, bold: true, color: { argb: 'FF0F766E' } };
    title.alignment = { horizontal: 'left', vertical: 'middle' };
  }
  sheet.getRow(1).height = 20;

  // Row 2 — what this list is (and that it is a read-only report, not a template).
  sheet.mergeCells(`A2:${lastLetter}2`);
  const subtitle = sheet.getCell('A2');
  subtitle.value = `তালিকা · ${cls.className} · ${tabName} · ${year} শিক্ষাবর্ষ (শুধু দেখার জন্য — আপলোডের টেমপ্লেট নয়)`;
  subtitle.font = { size: 11, bold: true };
  subtitle.alignment = { horizontal: 'left', vertical: 'middle' };
  sheet.getRow(2).height = 18;

  // Row 3 — header, bold white on a brand fill.
  const headerRow = sheet.getRow(HEADER_ROW_INDEX + 1);
  headers.forEach((header, index) => {
    const cell = headerRow.getCell(index + 1);
    cell.value = header;
    cell.font = { bold: true, size: 11, color: { argb: 'FFFFFFFF' } };
    cell.fill = HEADER_FILL;
    cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
    cell.border = THIN_BORDER;
  });
  headerRow.height = 30;

  // Rows 4+ — one pupil per row (শাখা ক → খ → গ, roll inside each শাখা).
  students.forEach((student, index) => {
    const rowNumber = FIRST_DATA_ROW_INDEX + 1 + index;
    const row = sheet.getRow(rowNumber);
    const ranked = rowById.get(student.id) ?? {};
    const remark = cls.remarks?.[student.id] ?? '';
    const values = listRowValues({
      tabId,
      headers,
      fields,
      student: {
        roll: student.roll,
        section: String(student.section ?? '').trim() || 'ক',
        name: student.name,
      },
      row: ranked,
      remark,
    });
    const markEnd = tabId === 'consolidated' ? 6 : 3 + fields.length;
    values.forEach((value, colIndex) => {
      const cell = row.getCell(colIndex + 1);
      cell.value = value;
      cell.border = THIN_BORDER;
      cell.font = { size: 11 };
      if (colIndex === 0 || colIndex === 1) cell.alignment = { horizontal: 'center' };
      if (colIndex === 2) cell.font = { size: 11, bold: true };
      // Subject / term-mark cells (yellow) vs derived মোট/GPA/গ্রেড (grey).
      if (colIndex >= 3 && colIndex < markEnd) {
        cell.fill = MARK_FILL;
        cell.alignment = { horizontal: 'center' };
      } else if (colIndex >= markEnd && colIndex < values.length - 1) {
        cell.fill = DERIVED_FILL;
        cell.alignment = { horizontal: 'center' };
        if (colIndex === markEnd) cell.font = { size: 11, bold: true };
      } else if (colIndex === values.length - 1) {
        // মন্তব্য — full sentences, left-aligned and wrapped.
        cell.alignment = { horizontal: 'left', vertical: 'middle', wrapText: true };
      } else if (index % 2 === 1) {
        cell.fill = BAND_FILL;
      }
    });
    row.height = 19;
  });

  // Header + first 3 columns stay put while the teacher scrolls the list.
  sheet.views = [{ state: 'frozen', xSplit: 3, ySplit: HEADER_ROW_INDEX + 1 }];
  sheet.autoFilter = { from: `A${HEADER_ROW_INDEX + 1}`, to: `${lastLetter}${HEADER_ROW_INDEX + 1}` };
  sheet.pageSetup = {
    orientation: 'landscape', paperSize: 9, fitToPage: true, fitToWidth: 1, fitToHeight: 0,
  };
  sheet.printTitleRows = `${HEADER_ROW_INDEX + 1}:${HEADER_ROW_INDEX + 1}`;
  return sheet;
};

/**
 * Builds the `.xlsx` workbook (and returns its binary buffer) — one formatted
 * sheet per class, for the ACTIVE tab only. `classes` is the array of per-class
 * inputs (`{ classId, className, config, students, sections, rows, remarks }`)
 * in CLASS_LEVELS order; a single class object is also accepted and wrapped.
 */
export async function buildResultListWorkbook({ classes, schoolName = '', year = '', tabId, tabName = '' }) {
  const list = Array.isArray(classes) ? classes : [classes].filter(Boolean);
  if (!list.length) throw new Error('কোনো শ্রেণির তালিকা দেওয়া হয়নি।');
  const tab = tabById(tabId);
  const { default: ExcelJS } = await loadExcelJs();
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'ResultWeb';
  workbook.created = new Date();
  list.forEach((cls) => addListSheet(workbook, cls, {
    schoolName: String(schoolName ?? '').trim(),
    year: String(year ?? ''),
    tabId: tab.id,
    tabName: tabName || tab.name,
  }));
  return workbook.xlsx.writeBuffer();
}

/** A safe, human-readable file name: তালিকা–বিদ্যালয়–মূল্যায়ন–শিক্ষাবর্ষ. */
export function resultListFileName({ schoolName, tabName, year }) {
  const parts = ['তালিকা', safe(schoolName), safe(tabName), safe(year)].filter(Boolean);
  return `${parts.join('-')}.xlsx`.replace(/\s+/g, '_');
}

/** Triggers a browser download of the generated list workbook. */
export async function downloadResultList(options) {
  const buffer = await buildResultListWorkbook(options);
  const name = resultListFileName(options);
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

export default {
  LIST_MAGIC,
  listHeaders,
  buildResultListWorkbook,
  downloadResultList,
  resultListFileName,
};
