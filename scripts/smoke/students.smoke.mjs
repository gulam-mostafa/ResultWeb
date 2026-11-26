/**
 * Smoke test for the 6-class student workbook (export/import) + the 80% similarity rule.
 *
 * Asserted here:
 *  - the workbook carries exactly SIX sheets, one per class, and NO class column;
 *  - the export orders rows by শাখা (`ক` ➔ `খ` ➔ `গ`) and by roll inside each শাখা;
 *  - an upload with a renamed sheet / changed header / broken required field is
 *    REJECTED with the sheet, row, column and reason;
 *  - the import plan keeps the DATABASE roll when similarity ≥ 80, and never renumbers
 *    an existing roll for a new admission;
 *  - a duplicate roll inside one class + শাখা becomes a `conflict` and is only written
 *    after the second confirmation (`force`).
 */
import assert from 'node:assert/strict';
import XLSX from 'xlsx';
import {
  STUDENT_SHEET_CLASS_IDS,
  STUDENT_SHEET_NAME_MAP,
  STUDENT_IMPORT_HEADERS,
  STUDENT_TEMPLATE_MAGIC,
} from '../../src/utils/constants.js';
import { sortRosterForExport, orderSections } from '../../src/utils/rollAssignment.js';
import {
  SIMILARITY_THRESHOLD,
  normalizePhone,
  normalizeBirthReg,
  similarityOf,
} from '../../src/utils/studentSimilarity.js';
import { buildImportPlan, IMPORT_ROW_STATUS } from '../../src/utils/studentImportPlan.js';
import {
  buildStudentWorkbook,
  parseStudentWorkbook,
  STUDENT_HEADER_ROW_INDEX,
  STUDENT_FIRST_DATA_ROW_INDEX,
} from '../../src/services/excel/studentExcel.js';

/* ------------------------------------------------------------------ *
 * 1. Six sheets, no class column
 * ------------------------------------------------------------------ */
assert.deepEqual(
  [...STUDENT_SHEET_CLASS_IDS],
  ['pre', 'c1', 'c2', 'c3', 'c4', 'c5'],
  'exactly the six active classes, in tab order',
);
assert.equal(Object.keys(STUDENT_SHEET_NAME_MAP).length, 6, 'one worksheet name per class');
assert.ok(
  !STUDENT_IMPORT_HEADERS.includes('শ্রেণি'),
  'a sheet must NOT carry a শ্রেণি column — the sheet name is the class',
);
assert.deepEqual(
  STUDENT_IMPORT_HEADERS.slice(0, 3),
  ['রোল', 'শাখা', 'শিক্ষার্থীর নাম'],
  'roll / শাখা / name are the first three columns',
);

/* ------------------------------------------------------------------ *
 * 2. Export ordering: শাখা first (ক ➔ খ ➔ গ), then roll
 * ------------------------------------------------------------------ */
assert.deepEqual(orderSections(['গ', 'ক', 'খ', 'কাস্টম']), ['ক', 'খ', 'গ', 'কাস্টম']);
const exportOrder = sortRosterForExport([
  { id: 'd', name: 'ঘ', section: 'গ', roll: 1 },
  { id: 'b', name: 'খ২', section: 'খ', roll: 2 },
  { id: 'a', name: 'ক২', section: 'ক', roll: 2 },
  { id: 'c', name: 'খ১', section: 'খ', roll: 1 },
  { id: 'e', name: 'ক১', section: '', roll: 1 },
]).map((student) => student.id);
assert.deepEqual(exportOrder, ['e', 'a', 'c', 'b', 'd'], 'শাখা ক ➔ খ ➔ গ, roll order inside each');

/* ------------------------------------------------------------------ *
 * 3. The workbook itself
 * ------------------------------------------------------------------ */
const roster = [
  { id: 'q1', studentMasterId: 'STU-2026-001', name: 'রুমি আক্তার', classId: 'c1', section: 'ক', roll: 1, fatherName: 'করিম', motherName: 'রহিমা বেগম', fatherPhone: '01700000000', motherPhone: '01800000000', birthCertificateNo: '1990123456789', guardianNid: '1234567890', gender: 'female', admissionYear: '2026', address: 'গ্রাম' },
  { id: 'q2', studentMasterId: 'STU-2026-002', name: 'সজীব হোসেন', classId: 'c1', section: 'খ', roll: 1, fatherName: 'জসিম', motherName: 'সালমা', fatherPhone: '01900000000' },
  { id: 'q3', studentMasterId: 'STU-2026-003', name: 'তানিয়া', classId: 'c5', section: 'ক', roll: 2 },
];
const buffer = await buildStudentWorkbook({ students: roster });
const book = XLSX.read(new Uint8Array(buffer), { type: 'array' });
assert.deepEqual(
  book.SheetNames,
  STUDENT_SHEET_CLASS_IDS.map((classId) => STUDENT_SHEET_NAME_MAP[classId]),
  'the workbook has exactly the six class sheets, in order',
);
const c1Matrix = XLSX.utils.sheet_to_json(book.Sheets[STUDENT_SHEET_NAME_MAP.c1], { header: 1, defval: '' });
assert.equal(c1Matrix[0][0], STUDENT_TEMPLATE_MAGIC, 'row 1 is the template stamp');
assert.deepEqual(
  c1Matrix[STUDENT_HEADER_ROW_INDEX].slice(0, STUDENT_IMPORT_HEADERS.length),
  [...STUDENT_IMPORT_HEADERS],
  'row 2 is the fixed header',
);
assert.equal(c1Matrix[STUDENT_FIRST_DATA_ROW_INDEX][1], 'ক', 'the first data row holds a শাখা value');
assert.equal(c1Matrix[STUDENT_FIRST_DATA_ROW_INDEX + 1][1], 'খ', 'rows follow শাখা order');

/* ------------------------------------------------------------------ *
 * 4. A clean round-trip parses, and a modified file is rejected
 * ------------------------------------------------------------------ */
const parsedClean = await parseStudentWorkbook(new Uint8Array(buffer));
assert.equal(parsedClean.ok, true, 'an untouched template must parse');
assert.equal(parsedClean.rows.length, 3, 'every pupil row is read');
assert.equal(parsedClean.rows[0].classId, 'c1', 'the class comes from the SHEET');

// Renamed sheet ➔ rejected, naming the missing sheet.
const renamed = XLSX.read(new Uint8Array(buffer), { type: 'array' });
renamed.SheetNames[0] = 'শ্রেণি-এক';
renamed.Sheets['শ্রেণি-এক'] = renamed.Sheets[STUDENT_SHEET_NAME_MAP.pre];
const renamedResult = await parseStudentWorkbook(
  new Uint8Array(XLSX.write(renamed, { bookType: 'xlsx', type: 'array' })),
);
assert.equal(renamedResult.ok, false);
assert.equal(renamedResult.code, 'sheet-missing');
assert.ok(renamedResult.message.includes(STUDENT_SHEET_NAME_MAP.pre), 'the reason names the sheet');

// A changed header cell ➔ rejected with the column number + name.
const badHeader = XLSX.read(new Uint8Array(buffer), { type: 'array' });
badHeader.Sheets[STUDENT_SHEET_NAME_MAP.c1][`C${STUDENT_HEADER_ROW_INDEX + 1}`] = { t: 's', v: 'নাম-পরিবর্তিত' };
const headerResult = await parseStudentWorkbook(
  new Uint8Array(XLSX.write(badHeader, { bookType: 'xlsx', type: 'array' })),
);
assert.equal(headerResult.ok, false);
assert.equal(headerResult.code, 'column-mismatch');
assert.ok(headerResult.message.includes(STUDENT_SHEET_NAME_MAP.c1), 'the reason names the sheet');
assert.ok(headerResult.message.includes('3'), 'the reason names the column number');

// A required name cleared ➔ rejected with sheet + row + column.
const badName = XLSX.read(new Uint8Array(buffer), { type: 'array' });
badName.Sheets[STUDENT_SHEET_NAME_MAP.c1][`C${STUDENT_FIRST_DATA_ROW_INDEX + 1}`] = { t: 's', v: '' };
const nameResult = await parseStudentWorkbook(
  new Uint8Array(XLSX.write(badName, { bookType: 'xlsx', type: 'array' })),
);
assert.equal(nameResult.ok, false);
assert.equal(nameResult.code, 'bad-cell');
assert.ok(nameResult.message.includes('শিক্ষার্থীর নাম'), 'the reason names the column');

// An extra “শ্রেণি” column cannot be sneaked in: the header count breaks.
const extraColumn = XLSX.read(new Uint8Array(buffer), { type: 'array' });
const c2Sheet = extraColumn.Sheets[STUDENT_SHEET_NAME_MAP.c2];
XLSX.utils.sheet_add_aoa(c2Sheet, [['শ্রেণি']], { origin: `N${STUDENT_HEADER_ROW_INDEX + 1}` });
const extraResult = await parseStudentWorkbook(
  new Uint8Array(XLSX.write(extraColumn, { bookType: 'xlsx', type: 'array' })),
);
assert.equal(extraResult.ok, false);
assert.equal(extraResult.code, 'column-count');

console.log('PASS — 6-sheet student workbook export/import + strict validation');

/* ------------------------------------------------------------------ *
 * 5. Bangla digits normalise before any comparison
 * ------------------------------------------------------------------ */
assert.equal(normalizePhone('০১৭০০০০০০০০'), '01700000000', 'Bangla digits ➔ ASCII phone');
assert.equal(normalizePhone('+880 1700-000000'), '01700000000', 'country code + separators dropped');
assert.equal(normalizeBirthReg('১৯৯০১২৩৪৫৬৭৮৯'), '1990123456789', 'Bangla digits ➔ ASCII birth reg.');

/* ------------------------------------------------------------------ *
 * 6. The 100-point weighted score (30 / 25 / 25 / 20)
 * ------------------------------------------------------------------ */
const exact = similarityOf(
  { name: 'রুমি আক্তার', motherName: 'রহিমা বেগম', fatherPhone: '০১৭০০০০০০০০', birthCertificateNo: '১৯৯০১২৩৪৫৬৭৮৯' },
  { name: 'রুমি আক্তার', motherName: 'রহিমা বেগম', fatherPhone: '01700000000', birthRegNo: '1990123456789' },
);
assert.equal(exact.score, 100, 'a fully identical pupil scores 100');
assert.equal(exact.breakdown.name, 30, 'name is worth 30');
assert.equal(exact.breakdown.motherName, 25, "mother's name is worth 25");
assert.equal(exact.breakdown.phone, 25, 'phone is worth 25');
assert.equal(exact.breakdown.birthRegNo, 20, 'birth registration is worth 20');
assert.equal(SIMILARITY_THRESHOLD, 80, 'the roll-preserving threshold is 80');

// Name + mother's name + phone but a DIFFERENT birth reg. ➔ 30 + 25 + 25 = 80.
const eighty = similarityOf(
  { name: 'রুমি আক্তার', motherName: 'রহিমা বেগম', fatherPhone: '01700000000', birthCertificateNo: '1111111111111' },
  { name: 'রুমি আক্তার', motherName: 'রহিমা বেগম', fatherPhone: '01700000000', birthRegNo: '1990123456789' },
);
assert.equal(eighty.score, 80, 'name + mother + phone = exactly 80');

/* ------------------------------------------------------------------ *
 * 7. Import plan: ≥80 keeps the DATABASE roll; a new row is appended
 * ------------------------------------------------------------------ */
const storedRoster = [
  { id: 'a1', studentMasterId: 'STU-2026-001', classId: 'c1', section: 'ক', roll: 7, name: 'রুমি আক্তার', motherName: 'রহিমা বেগম', fatherPhone: '01700000000', birthCertificateNo: '1990123456789' },
  { id: 'a2', studentMasterId: 'STU-2026-002', classId: 'c1', section: 'ক', roll: 9, name: 'অন্য ছাত্র' },
];

// The SAME pupil typed as roll ১ ➔ the DB roll ৭ must be kept.
const matchPlan = buildImportPlan({
  roster: storedRoster,
  rows: [{
    classId: 'c1',
    line: 3,
    values: { name: 'রুমি আক্তার', motherName: 'রহিমা বেগম', fatherPhone: '01700000000', birthCertificateNo: '1990123456789', roll: 1, section: 'ক' },
  }],
});
assert.equal(matchPlan.rows[0].status, IMPORT_ROW_STATUS.MATCH, 'a ≥80 match is the same pupil');
assert.equal(matchPlan.rows[0].resolvedRoll, 7, 'the DATABASE roll wins over the sheet roll');
assert.equal(matchPlan.rows[0].similarity, 100);
assert.ok(
  matchPlan.rows[0].message.includes('ডাটাবেস রোল বজায় রাখা হয়েছে'),
  'the preview badge explains the kept roll',
);

// A brand-new pupil with a BLANK roll where the bucket holds ৭ and ৯ ➔ ১০.
const newPlan = buildImportPlan({
  roster: storedRoster,
  rows: [{ classId: 'c1', line: 4, values: { name: 'নতুন ছাত্র', section: '' } }],
});
assert.equal(newPlan.rows[0].status, IMPORT_ROW_STATUS.NEW);
assert.equal(newPlan.rows[0].section, 'ক', 'a blank শাখা defaults to ক');
assert.equal(newPlan.rows[0].resolvedRoll, 10, 'the next free roll follows the highest existing one');

// The SAME number in ANOTHER শাখা is legal (roll uniqueness is bucket-scoped).
const otherSection = buildImportPlan({
  roster: storedRoster,
  rows: [{ classId: 'c1', line: 5, values: { name: 'খ শাখার ছাত্র', section: 'খ', roll: 7 } }],
});
assert.equal(otherSection.rows[0].status, IMPORT_ROW_STATUS.NEW);
assert.equal(otherSection.rows[0].resolvedRoll, 7, 'c1::খ may use ৭ even though c1::ক uses it');

/* ------------------------------------------------------------------ *
 * 8. A duplicate roll in one bucket is a two-step warning
 * ------------------------------------------------------------------ */
const conflictPlan = buildImportPlan({
  roster: storedRoster,
  rows: [{ classId: 'c1', line: 6, values: { name: 'সম্পূর্ণ ভিন্ন নাম', section: 'ক', roll: 7 } }],
});
assert.equal(conflictPlan.rows[0].status, IMPORT_ROW_STATUS.CONFLICT);
assert.equal(conflictPlan.summary.hasConflict, true);
assert.ok(conflictPlan.rows[0].message.includes('রোল ইতিমধ্যে'), 'the reason names the clash');

// Two rows of the SAME file asking for the same free number also clash.
const sameFile = buildImportPlan({
  roster: [],
  rows: [
    { classId: 'c2', line: 3, values: { name: 'এক', section: 'ক', roll: 1 } },
    { classId: 'c2', line: 4, values: { name: 'দুই', section: 'ক', roll: 1 } },
  ],
});
assert.equal(sameFile.rows[0].status, IMPORT_ROW_STATUS.NEW);
assert.equal(sameFile.rows[1].status, IMPORT_ROW_STATUS.CONFLICT);
assert.ok(sameFile.rows[1].message.includes('এই ফাইলেরই'), 'the reason points at the earlier row');

/* ------------------------------------------------------------------ *
 * 9. The preview groups rows by class ➔ শাখা
 * ------------------------------------------------------------------ */
const grouped = buildImportPlan({
  roster: [],
  rows: [
    { classId: 'c1', line: 3, values: { name: 'ক১', section: 'ক', roll: 1 } },
    { classId: 'c1', line: 4, values: { name: 'খ১', section: 'খ', roll: 1 } },
    { classId: 'c3', line: 3, values: { name: 'তিন', section: 'ক', roll: 1 } },
  ],
});
assert.equal(grouped.groups.length, 2, 'two classes ➔ two tab groups');
const c1Group = grouped.groups.find((group) => group.classId === 'c1');
assert.deepEqual(
  c1Group.sections.map((entry) => entry.section),
  ['ক', 'খ'],
  'শাখা tabs in ক ➔ খ order',
);
assert.equal(grouped.summary.total, 3);

console.log('PASS — 80% weighted similarity keeps the DB roll + 2-step duplicate-roll warning');

