/**
 * Smoke test for the Results & Excel grading system.
 *
 * Bundled by `scripts/smoke/run.mjs`. Asserts, without a browser or a network:
 *  - class-wise default subjects / গাঠনিক+সামষ্টিক split / pass mark / weights;
 *  - blank marks count as 0, below-pass ⇒ F + GPA 0.00 with the total marks KEPT;
 *  - 80+ highlighting inputs (percent per subject) and the golden-badge condition;
 *  - the consolidated বার্ষিক ফলাফল weighting (১৫% + ১৫% + ৭০%) and its renormalisation;
 *  - merit ranking (passing first, ties by GPA then roll) and নতুন রোল only for the
 *    consolidated result;
 *  - the Excel round-trip: build → parse (valid) and build → tampered (rejected with a
 *    precise reason).
 */
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import XLSX from 'xlsx';
import SpreadsheetMarksGrid from '../../src/components/results/SpreadsheetMarksGrid.jsx';
import ResultConfigModal from '../../src/components/results/ResultConfigModal.jsx';
import ExcelPreviewModal from '../../src/components/results/ExcelPreviewModal.jsx';
import {
  defaultResultConfig,
  normalizeResultConfig,
  defaultSubjectsForClass,
  normalizedWeightPercent,
  weightsAreClean,
} from '../../src/utils/resultConfig.js';
import {
  computeConsolidatedResult,
  computeTermResultForConfig,
  rankClassRows,
} from '../../src/utils/resultEngine.js';
import {
  buildResultWorkbook,
  parseResultWorkbook,
  templateSpec,
} from '../../src/services/excel/resultExcel.js';
import {
  readAllResultConfigs,
  resultConfigPath,
  saveClassResultConfig,
} from '../../src/services/database/resultConfigService.js';
import { rememberSchoolLocation } from '../../src/services/database/dbPaths.js';

/* ------------------------------------------------------------------ *
 * 1. Class-wise defaults
 * ------------------------------------------------------------------ */
const preConfig = defaultResultConfig('pre');
assert.equal(preConfig.subjects.length, 3, 'প্রাক-প্রাথমিক must default to 3 subjects');
assert.ok(
  preConfig.subjects.every((subject) => subject.fullMarks === 100 && subject.split === false),
  'pre-primary uses a single 100-mark score',
);

const c1 = defaultResultConfig('c1');
assert.equal(c1.subjects.length, 4, '১ম শ্রেণি defaults to 4 subjects');
assert.deepEqual(c1.subjects.map((subject) => subject.name), ['বাংলা', 'গণিত', 'ইংরেজি', 'সমন্বিত']);
assert.ok(
  c1.subjects.every((subject) => subject.split && subject.formativeFull === 30
    && subject.summativeFull === 70 && subject.fullMarks === 100),
  '১ম শ্রেণি splits every subject into ৩০ + ৭০',
);

const c3 = defaultResultConfig('c3');
assert.equal(c3.subjects.length, 7, '৩য়–৫ম defaults to 7 subjects');
assert.deepEqual(c3.subjects.map((subject) => subject.name), [
  'বাংলা', 'গণিত', 'ইংরেজি', 'বিজ্ঞান',
  'বাওবি', 'ধর্ম', 'সমন্বিত',
]);
assert.equal(c3.passMark, 33);
assert.deepEqual(c3.weights, { term1: 15, term2: 15, annual: 70 });
assert.ok(weightsAreClean(c3.weights));
assert.ok(defaultSubjectsForClass('c5').every((subject) => subject.split === true));

/* Custom names / full marks / split survive normalisation. */
const custom = normalizeResultConfig({
  classId: 'c2',
  passMark: 40,
  goldenMark: 85,
  weights: { term1: 25, term2: 25, annual: 50 },
  subjects: [
    { id: 'bangla', name: 'বাংলা (কাস্টম)', split: true, formativeFull: 40, summativeFull: 60 },
    { id: 'math', name: 'গণিত', split: false, formativeFull: 100 },
    { id: 'subj-new', name: 'নতুন বিষয়', split: true, formativeFull: 20, summativeFull: 50 },
  ],
}, 'c2');
assert.equal(custom.passMark, 40);
assert.equal(custom.goldenMark, 85);
assert.equal(custom.subjects[0].name, 'বাংলা (কাস্টম)');
assert.equal(custom.subjects[0].fullMarks, 100);
assert.equal(custom.subjects[1].split, false);
assert.equal(custom.subjects[2].fullMarks, 70, 'a custom split totals the SUM of both components');


/* ------------------------------------------------------------------ *
 * 2. Term result: pass / fail / blank / golden
 * ------------------------------------------------------------------ */
const splitMarks = (id, termId, formative, summative) => ({
  [`${id}:formative`]: { [termId]: formative },
  [`${id}:summative`]: { [termId]: summative },
  [id]: { [termId]: formative + summative },
});

// Below the pass mark in ONE subject: F + GPA 0.00, but the total marks stay summed.
const failing = {
  ...splitMarks('bangla', 'term1', 20, 40),      // 60 — pass
  ...splitMarks('math', 'term1', 5, 10),         // 15 — FAIL
  ...splitMarks('english', 'term1', 25, 60),     // 85
  ...splitMarks('integrated', 'term1', 20, 60),  // 80
};
const failResult = computeTermResultForConfig(failing, c1, 'term1');
assert.equal(failResult.grade, 'F');
assert.equal(failResult.gpa, 0);
assert.equal(failResult.isPass, false);
assert.equal(failResult.failCount, 1);
assert.equal(failResult.totalMarks, 60 + 15 + 85 + 80, 'মোট নম্বর must NOT be zeroed on a fail');

// A blank formative component counts as 0 while the subject stays entered.
const blankComponent = computeTermResultForConfig({
  ...splitMarks('bangla', 'term1', 30, 70),
  'math:summative': { term1: 60 },
}, c1, 'term1');
const mathSubject = blankComponent.subjects.find((subject) => subject.id === 'math');
assert.equal(mathSubject.total, 60, 'a blank component counts as 0');
assert.equal(mathSubject.percent, 60);

// Every subject 80+ ⇒ golden badge; below pass ⇒ the red highlight input.
const goldenResult = computeTermResultForConfig({
  ...splitMarks('bangla', 'term1', 30, 70),
  ...splitMarks('math', 'term1', 30, 70),
  ...splitMarks('english', 'term1', 30, 50),
  ...splitMarks('integrated', 'term1', 25, 55),
}, c1, 'term1');
assert.ok(goldenResult.subjects.every((subject) => subject.percent >= 80));
assert.equal(goldenResult.isGolden, true);
assert.equal(goldenResult.isPass, true);
const lowSubject = computeTermResultForConfig({ ...splitMarks('bangla', 'term1', 10, 20) }, c1, 'term1')
  .subjects.find((subject) => subject.id === 'bangla');
assert.ok(lowSubject.percent < 33 && !lowSubject.isPass, 'below pass ⇒ red highlight input');

// A legacy aggregate row (components === total) is not double counted.
const legacyRow = computeTermResultForConfig({ bangla: { term1: 74 } }, c1, 'term1')
  .subjects.find((subject) => subject.id === 'bangla');
assert.equal(legacyRow.total, 74, 'a legacy single value still yields its own total');

// Blank = 0: once ONE mark exists, every subject of the class counts (and blanks fail).
const partlyEntered = computeTermResultForConfig({ bangla: { term1: 90 } }, c1, 'term1');
assert.equal(partlyEntered.totalFullMarks, 400, 'all 4 subjects count once any mark exists');
assert.equal(partlyEntered.totalMarks, 90, 'a blank subject contributes 0 marks');
assert.equal(partlyEntered.isPass, false, 'a blank subject fails the pass check like a 0');
assert.equal(partlyEntered.grade, 'F');
assert.equal(partlyEntered.gpa, 0);
assert.equal(partlyEntered.totalMarks, 90, 'মোট নম্বর stays the summed value, not zeroed');

// Nothing entered at all ⇒ still "not evaluated".
const emptyResult = computeTermResultForConfig({}, c1, 'term1');
assert.equal(emptyResult.hasAnyMark, false);
assert.equal(emptyResult.grade, '—');
assert.equal(emptyResult.gpa, null);

/* ------------------------------------------------------------------ *
 * 3. Consolidated বার্ষিক ফলাফল weighting
 * ------------------------------------------------------------------ */
const weightedMarks = {
  'bangla:formative': { term1: 30, term2: 20, annual: 15 },
  'bangla:summative': { term1: 70, term2: 80, annual: 35 },
  bangla: { term1: 100, term2: 100, annual: 50 },
};
const consolidated = computeConsolidatedResult(weightedMarks, c1);
const bangla = consolidated.subjects.find((subject) => subject.id === 'bangla');
assert.equal(bangla.percent, 65, 'consolidated percent uses ১৫% + ১৫% + ৭০%');
assert.deepEqual(consolidated.weights, { term1: 15, term2: 15, annual: 70 });

// An unclean weight set is renormalised instead of breaking the maths.
const renormalised = normalizedWeightPercent({ term1: 30, term2: 30, annual: 90 });
assert.equal(renormalised.term1 + renormalised.term2 + renormalised.annual, 100);

/* ------------------------------------------------------------------ *
 * 4. Merit ranking + নতুন রোল
 * ------------------------------------------------------------------ */
const rows = [
  { student: { id: 'a', name: 'ক', roll: 1 }, studentId: 'a', result: { totalMarks: 300, gpa: 4, hasAnyMark: true, isPass: true } },
  { student: { id: 'b', name: 'খ', roll: 2 }, studentId: 'b', result: { totalMarks: 400, gpa: 3, hasAnyMark: true, isPass: true } },
  { student: { id: 'c', name: 'গ', roll: 3 }, studentId: 'c', result: { totalMarks: 500, gpa: 0, hasAnyMark: true, isPass: false } },
  { student: { id: 'd', name: 'ঘ', roll: 4 }, studentId: 'd', result: { totalMarks: 400, gpa: 5, hasAnyMark: true, isPass: true } },
  { student: { id: 'e', name: 'ঙ', roll: 5 }, studentId: 'e', result: { totalMarks: 0, gpa: null, hasAnyMark: false, isPass: false } },
];
const ranked = rankClassRows(rows, { assignNewRoll: true });
assert.deepEqual(ranked.map((row) => row.studentId), ['d', 'b', 'a', 'c', 'e'],
  'passing first by total, ties by GPA, failed after, un-entered last');
assert.deepEqual(ranked.map((row) => row.position), [1, 2, 3, 4, 5]);
assert.deepEqual(ranked.map((row) => row.newRoll), [1, 2, 3, 4, 5],
  'নতুন রোল follows the consolidated merit order');

const termRanked = rankClassRows(rows);
assert.ok(termRanked.every((row) => row.newRoll === null),
  'a per-term tab shows মেধাক্রম only — no নতুন রোল');

/* ------------------------------------------------------------------ *
 * 5. Excel round-trip + strict validation
 * ------------------------------------------------------------------ */
const spec = templateSpec({
  schoolProfile: { name: 'টেস্ট বিদ্যালয়' },
  classId: 'c1',
  year: '2026',
  tabId: 'term1',
  config: c1,
  students: [
    { id: 's1', name: 'রুমি', roll: 1 },
    { id: 's2', name: 'সজীব', roll: 2 },
  ],
});
const marks = { s1: splitMarks('bangla', 'term1', 30, 70) };
const buffer = await buildResultWorkbook({ spec, marks, computed: {} });
const parsed = await parseResultWorkbook(new Uint8Array(buffer), spec);
assert.equal(parsed.ok, true, 'a valid untouched template must parse');
assert.equal(parsed.rows.s1['bangla:formative'], 30, 'web marks travel into the sheet');
assert.equal(parsed.rows.s1['bangla:summative'], 70);
assert.equal(parsed.rows.s2['bangla:formative'], null, 'a blank cell parses as null');

// A renamed subject column must be rejected with the exact reason.
const book = XLSX.read(new Uint8Array(buffer), { type: 'array' });
const sheet = book.Sheets[book.SheetNames[0]];
sheet.D9 = { t: 's', v: 'বাংলা-পরিবর্তিত' };
const rejected = await parseResultWorkbook(
  new Uint8Array(XLSX.write(book, { bookType: 'xlsx', type: 'array' })),
  spec,
);
assert.equal(rejected.ok, false);
assert.equal(rejected.code, 'column-mismatch');
assert.ok(rejected.message.includes('বাংলা'), 'the error must name the changed column');

// A removed pupil id must be rejected too.
const book2 = XLSX.read(new Uint8Array(buffer), { type: 'array' });
const sheet2 = book2.Sheets[book2.SheetNames[0]];
delete sheet2.B10;
const rejected2 = await parseResultWorkbook(
  new Uint8Array(XLSX.write(book2, { bookType: 'xlsx', type: 'array' })),
  spec,
);
assert.equal(rejected2.ok, false);
assert.ok(['row-mismatch', 'row-count'].includes(rejected2.code), 'editing a pupil row is rejected');

// A file of another class is rejected with a class-specific reason.
const otherClass = templateSpec({
  schoolProfile: { name: 'টেস্ট বিদ্যালয়' },
  classId: 'c2',
  year: '2026',
  tabId: 'term1',
  config: c1,
  students: [],
});
const wrongClass = await parseResultWorkbook(new Uint8Array(buffer), otherClass);
assert.equal(wrongClass.ok, false);
assert.equal(wrongClass.code, 'class-mismatch');

// An out-of-range mark is rejected with the row/column named.
const book3 = XLSX.read(new Uint8Array(buffer), { type: 'array' });
book3.Sheets[book3.SheetNames[0]].D10 = { t: 'n', v: 999 };
const rejected3 = await parseResultWorkbook(
  new Uint8Array(XLSX.write(book3, { bookType: 'xlsx', type: 'array' })),
  spec,
);
assert.equal(rejected3.ok, false);
assert.equal(rejected3.code, 'mark-range');

/* ------------------------------------------------------------------ *
 * 6. Per-school isolation of the configuration node
 * ------------------------------------------------------------------ */
const schoolA = { divisionId: 'd1', districtId: 'd2', upazilaId: 'u3', schoolId: 'school-A' };
const schoolB = { divisionId: 'd1', districtId: 'd2', upazilaId: 'u3', schoolId: 'school-B' };
rememberSchoolLocation(schoolA);
rememberSchoolLocation(schoolB);
const pathA = resultConfigPath(schoolA, '2026', 'c3');
const pathB = resultConfigPath(schoolB, '2026', 'c3');
assert.ok(pathA.startsWith('divisions/d1/districts/d2/upazilas/u3/schools/school-A/'), 'config A lives in school A');
assert.ok(pathB.startsWith('divisions/d1/districts/d2/upazilas/u3/schools/school-B/'), 'config B lives in school B');
assert.notEqual(pathA, pathB, 'two schools must never share a configuration node');
assert.ok(pathA.includes('/sessions/2026/meta/resultConfig/class-3'), 'config is namespaced per year + class');

// Saving to school B leaves school A's node untouched.
await saveClassResultConfig(schoolB, '2026', 'c3', {
  ...defaultResultConfig('c3'),
  passMark: 45,
});
const savedB = await readAllResultConfigs(schoolB, '2026');
assert.equal(savedB.c3.passMark, 45, 'school B reads its own pass mark');
assert.equal(savedB.c3.subjects.length, 7);
const untouchedA = await readAllResultConfigs(schoolA, '2026');
assert.equal(untouchedA.c3, undefined, 'school A has no configuration of its own yet');
assert.equal(defaultResultConfig('c3').passMark, 33, 'school A still resolves the factory default');
console.log('PASS — config isolation per school/year/class');

console.log('PASS — results engine (subjects, split, pass/fail, golden, weights, ranking) + Excel validation');

/* ------------------------------------------------------------------ *
 * 7. Rendered grid: highlights, golden badge, sort control, per-term columns
 * ------------------------------------------------------------------ */
const gridMarks = {
  // রুমি: every subject 80+ ⇒ golden badge.
  g1: {
    'bangla:formative': { term1: 30 }, 'bangla:summative': { term1: 70 }, bangla: { term1: 100 },
    'math:formative': { term1: 25 }, 'math:summative': { term1: 60 }, math: { term1: 85 },
    'english:formative': { term1: 27 }, 'english:summative': { term1: 60 }, english: { term1: 87 },
    'integrated:formative': { term1: 26 }, 'integrated:summative': { term1: 58 }, integrated: { term1: 84 },
  },
  // সজীব: বাংলা below the pass mark ⇒ light-red cell.
  g2: {
    'bangla:formative': { term1: 10 }, 'bangla:summative': { term1: 15 }, bangla: { term1: 25 },
  },
};

const gridHtml = renderToStaticMarkup(React.createElement(SpreadsheetMarksGrid, {
  students: [{ id: 'g1', name: 'রুমি', roll: 1 }, { id: 'g2', name: 'সজীব', roll: 2 }],
  marks: gridMarks,
  config: c1,
  tabId: 'term1',
  getResult: (studentId) => computeTermResultForConfig(gridMarks[studentId] ?? {}, c1, 'term1'),
  onEntry: () => {},
  canEdit: true,
  onSortModeChange: () => {},
  sortMode: 'roll',
}));

assert.ok(gridHtml.includes('গোল্ডেন'), 'a pupil at 80+ in every subject carries the golden badge');
assert.ok(gridHtml.includes('bg-emerald-50'), '80+ cells carry the light-green highlight class');
assert.ok(gridHtml.includes('bg-rose-50'), 'below-pass cells carry the light-red highlight class');
assert.ok(gridHtml.includes('বর্তমান রোল') && gridHtml.includes('মেধাক্রম'), 'the sort control lists both orders');
assert.ok(gridHtml.includes('গাঠনিক') && gridHtml.includes('সামষ্টিক'), 'গাঠনিক / সামষ্টিক inputs render side by side');
assert.ok(!gridHtml.includes('নতুন রোল'), 'a per-term tab has NO নতুন রোল column until the consolidated result exists');

// The consolidated tab is read-only and DOES show নতুন রোল.
const consolidatedHtml = renderToStaticMarkup(React.createElement(SpreadsheetMarksGrid, {
  students: [{ id: 'g1', name: 'রুমি', roll: 1 }],
  marks: gridMarks,
  config: c1,
  tabId: 'consolidated',
  getResult: (studentId) => computeConsolidatedResult(gridMarks[studentId] ?? {}, c1),
  onEntry: () => {},
  canEdit: false,
  onSortModeChange: () => {},
}));
assert.ok(consolidatedHtml.includes('নতুন রোল'), 'বার্ষিক ফলাফল exposes the নতুন রোল column');
assert.ok(consolidatedHtml.includes('disabled'), 'consolidated cells are read-only (derived result)');

/* ------------------------------------------------------------------ *
 * 8. Modal modules are real components (the modals themselves portal into
 *    `document.body`, which does not exist in Node — so they cannot be
 *    server-rendered; the pure logic they rely on is asserted below).
 * ------------------------------------------------------------------ */
assert.equal(typeof ResultConfigModal, 'function');
assert.equal(typeof ExcelPreviewModal, 'function');

// The settings modal edits through `normalizeResultConfig`, so a rename / split change /
// add / remove round-trips exactly like the persisted row would.
const edited = normalizeResultConfig({
  ...c1,
  passMark: 45,
  weights: { term1: 20, term2: 20, annual: 60 },
  subjects: [
    ...c1.subjects.slice(0, 3).map((subject, index) => (
      index === 0 ? { ...subject, name: 'বাংলা (নতুন নাম)' } : subject
    )),
    { id: 'subj-new', name: 'নতুন বিষয়', split: true, formativeFull: 25, summativeFull: 75 },
  ],
}, 'c1');
assert.equal(edited.passMark, 45);
assert.equal(edited.subjects[0].name, 'বাংলা (নতুন নাম)', 'renaming a subject is preserved');
assert.equal(edited.subjects.length, 4);
assert.equal(edited.subjects[3].fullMarks, 100, 'an added subject sums its split');
assert.ok(weightsAreClean(edited.weights));

console.log('PASS — settings modal helpers (rename / split / add) round-trip');

console.log('PASS — rendered grid (highlights, golden badge, sort control, per-term columns)');
