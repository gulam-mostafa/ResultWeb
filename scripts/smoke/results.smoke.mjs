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

// The consolidated view does NOT re-normalise: a missing term contributes 0, so the
// weighted percentage is reported as-is (requirement: "Treat missing terms as 0 without
// silent re-normalization") and the UI shows "সব প্রান্তিকের নম্বর দেওয়া হয়নি".
const midYear = computeConsolidatedResult({ bangla: { term1: 90 }, math: { term1: 80 } }, c1);
const banglaMid = midYear.subjects.find((subject) => subject.id === 'bangla');
assert.equal(banglaMid.percent, 13.5, '৯০ × ১৫% = ১৩.৫ when only the ১st term exists');
assert.equal(banglaMid.scoredPercent, 13.5, 'no silent re-normalisation — the weighted percent IS the score');
assert.equal(banglaMid.mark, 13.5, 'the subject total is the weighted figure');
assert.equal(midYear.percentage, 12.75, 'মোট শতকরা = weighted average of the entered terms only');
assert.equal(midYear.evaluatedWeight, 15);
assert.equal(midYear.isComplete, false, 'two terms are still missing');
assert.deepEqual(midYear.missingTerms, ['term2', 'annual'], 'the missing terms are named');

// A FULL year scores ১০০ in every term? Not necessarily — but ১০০ in each term at
// ১৫/১৫/৭০ must add up to exactly ১০০ (no more, no less).
const perfectYear = {};
['bangla', 'math', 'english', 'integrated'].forEach((id) => {
  perfectYear[`${id}:formative`] = { term1: 30, term2: 30, annual: 30 };
  perfectYear[`${id}:summative`] = { term1: 70, term2: 70, annual: 70 };
  perfectYear[id] = { term1: 100, term2: 100, annual: 100 };
});
const perfect = computeConsolidatedResult(perfectYear, c1);
assert.equal(perfect.subjects[0].percent, 100, '১০০ + ১০০ + ১০০ at ১৫% + ১৫% + ৭০% = ১০০');
assert.equal(perfect.isComplete, true);

/* ------------------------------------------------------------------ *
 * 2b. P0-2 — one typed mark is NEVER doubled
 * ------------------------------------------------------------------ */
import { buildSubjectMark, normalizeSubjectMark } from '../../src/services/database/resultService.js';

// A single ৩০ stays ৩০ (the old bug stored formative=30 + summative=30 ⇒ ৬০).
assert.deepEqual(
  normalizeSubjectMark({ total: 30 }),
  { formative: null, summative: null, total: 30 },
  'a stored single mark keeps its own total and no components',
);
// A legacy `{formative: v, summative: v}` row (written before `total`) is ONE mark, not 2v.
assert.equal(normalizeSubjectMark({ formative: 30, summative: 30 }).total, 30, 'legacy duplicate components count once');
// A real component pair IS summed.
assert.equal(normalizeSubjectMark({ formative: 30, summative: 70 }).total, 100, 'a real ৩০ + ৭০ pair sums');
assert.deepEqual(buildSubjectMark(25, 45), { formative: 25, summative: 45, total: 70 });
// An explicit stored total always wins over the components.
assert.equal(normalizeSubjectMark({ formative: 10, summative: 10, total: 55 }).total, 55, 'explicit total wins');

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

// Shared tie positions (1, 1, 3) — the SAME rule `gradingCalculator.computeMeritRanking`
// applies, so a modal and a printed marksheet never disagree about a pupil's মেধাক্রম.
const tied = rankClassRows([
  { student: { id: 't1', name: 'ক', roll: 1 }, studentId: 't1', result: { totalMarks: 400, gpa: 4, hasAnyMark: true, isPass: true } },
  { student: { id: 't2', name: 'খ', roll: 2 }, studentId: 't2', result: { totalMarks: 400, gpa: 4, hasAnyMark: true, isPass: true } },
  { student: { id: 't3', name: 'গ', roll: 3 }, studentId: 't3', result: { totalMarks: 300, gpa: 3, hasAnyMark: true, isPass: true } },
], { assignNewRoll: true });
assert.deepEqual(tied.map((row) => row.position), [1, 1, 3], 'a tie shares the merit position (1, 1, 3)');
assert.deepEqual(tied.map((row) => row.newRoll), [1, 2, 3], 'নতুন রোল stays unique even on a tie');

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
 * P0-1 — বার্ষিক মূল্যায়ন persistence: `final` in RTDB → `annual` for the UI
 * ------------------------------------------------------------------ */
{
  const { subscribeResults, readSessionResults } = await import('../../src/services/database/resultService.js');
  const schoolRef = { divisionId: 'd1', districtId: 'd2', upazilaId: 'u3', schoolId: 'annual-school' };
  rememberSchoolLocation(schoolRef);

  // A teacher saved weighted marks under the STORED key `final`.
  await saveClassResultConfig(schoolRef, '2026', 'c1', c1);
  const { saveMark } = await import('../../src/services/database/resultService.js');
  await saveMark(schoolRef, 'annual', 'c1', 'STU-2026-001', 'bangla', 30, '2026', 'formative');
  await saveMark(schoolRef, 'annual', 'c1', 'STU-2026-001', 'bangla', 70, '2026', 'summative');

  const flattened = await readSessionResults(schoolRef, '2026');
  assert.equal(flattened.marks['STU-2026-001'].bangla.annual, 100, 'the stored `final` row is read as `annual`');
  assert.equal(flattened.marks['STU-2026-001']['bangla:formative'].annual, 30, 'components keep their term id');
  assert.equal(flattened.rows['STU-2026-001'].annual?.grandTotal, 100, 'the row is keyed by the app term id');

  // The live subscription must emit the very same shape. `safeSubscribe` paints from
  // cache synchronously, so the unsubscribe handle is captured through a holder.
  await new Promise((resolve) => {
    let stop = null;
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      try { stop?.(); } catch { /* noop */ }
      resolve();
    };
    stop = subscribeResults(schoolRef, (payload) => {
      if (settled) return;
      const value = payload?.marks?.['STU-2026-001']?.bangla?.annual;
      if (!value) return;
      assert.equal(value, 100, 'subscribeResults maps final ➔ annual');
      finish();
    }, undefined, '2026');
    setTimeout(finish, 400);
  });

  // A stored single mark stays single (no doubling anywhere on the round trip).
  await saveMark(schoolRef, 'annual', 'c1', 'STU-2026-002', 'math', 42, '2026', 'total');
  const single = await readSessionResults(schoolRef, '2026');
  assert.equal(single.marks['STU-2026-002'].math.annual, 42, 'a single ৪২ stays ৪২');

  /* P0-7 — a class move inside the SAME year carries the result rows across. */
  const { moveStudentResultRows } = await import('../../src/services/database/resultService.js');
  const moved = await moveStudentResultRows(schoolRef, '2026', 'STU-2026-001', 'c1', 'c2');
  assert.equal(moved.moved, 1, 'only the term row that actually holds marks moves');
  const afterMove = await readSessionResults(schoolRef, '2026');
  assert.equal(afterMove.marks['STU-2026-001'].bangla.annual, 100, 'the marks now resolve from the target class');
  assert.equal(afterMove.rows['STU-2026-001'].annual?.classId, 'c2', 'the row is addressed by the target class');

  console.log('PASS — annual (`final`) persistence maps to `annual` and single marks never double');
}

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


/* ------------------------------------------------------------------ *
 * 9. Grouped columns (গাঠনিক first, then সামষ্টিক) + tinted groups
 * ------------------------------------------------------------------ */
// The header must list EVERY গাঠনিক column before the first সামষ্টিক column, and the
// group bands must be present so the two areas are visually distinct.
const firstFormativeAt = gridHtml.indexOf('গাঠনিক মূল্যায়ন');
const firstSummativeAt = gridHtml.indexOf('সামষ্টিক মূল্যায়ন');
assert.ok(firstFormativeAt > -1 && firstSummativeAt > -1, 'both evaluation groups render as labelled bands');
assert.ok(firstFormativeAt < firstSummativeAt, 'গাঠনিক group is rendered before the সামষ্টিক group');
assert.ok(gridHtml.includes('mark-group-head-formative'), 'গাঠনিক headers carry their own tint class');
assert.ok(gridHtml.includes('mark-group-head-summative'), 'সামষ্টিক headers carry their own tint class');
assert.ok(gridHtml.includes('mark-cell-formative'), 'গাঠনিক inputs carry their own tint class');
assert.ok(gridHtml.includes('mark-cell-summative'), 'সামষ্টিক inputs carry their own tint class');

// Within the header row, no সামষ্টিক input tint may appear before the last গাঠনিক one.
const headerEnd = gridHtml.indexOf('</thead>');
const headerHtml = gridHtml.slice(0, headerEnd);
assert.ok(
  headerHtml.lastIndexOf('mark-group-cell-formative') < headerHtml.indexOf('mark-group-cell-summative'),
  'every গাঠনিক subject column is grouped before the first সামষ্টিক column',
);

/* ------------------------------------------------------------------ *
 * 10. Mark entry carries the term id (the “cells wiped on blur” regression)
 * ------------------------------------------------------------------ */
// `SpreadsheetMarksGrid` must forward the ACTIVE TERM to `setMark`; passing only three
// arguments silently dropped every typed value.
const { readFile: readSourceFile } = await import('node:fs/promises');
const pathModule = await import('node:path');
const gridSource = await readSourceFile(
  pathModule.join(process.cwd(), 'src/components/results/SpreadsheetMarksGrid.jsx'),
  'utf8',
);
assert.ok(
  gridSource.includes('setMark(studentId, fieldKey, termForTab, value)'),
  'a committed cell is written with its term id',
);
assert.ok(
  !gridSource.includes('onEntry?.(studentId, fieldKey, value)'),
  'the term-less (value-losing) call shape is gone',
);
assert.ok(gridSource.includes('pendingRef'), 'committed values are pinned until the store confirms them');

/* ------------------------------------------------------------------ *
 * 11. Excel download is gated behind the warning popup
 * ------------------------------------------------------------------ */
const warningSource = await readSourceFile(
  pathModule.join(process.cwd(), 'src/components/results/ExcelDownloadWarningModal.jsx'),
  'utf8',
);
assert.ok(warningSource.includes('বুঝেছি ও ডাউনলোড করুন'), 'the popup exposes the confirm/proceed button');
assert.ok(warningSource.includes('বাতিল'), 'the popup exposes a cancel button');
const pageSource = await readSourceFile(
  pathModule.join(process.cwd(), 'src/pages/ResultsPage.jsx'),
  'utf8',
);
assert.ok(pageSource.includes('setDownloadWarningOpen(true)'), 'the download button only opens the warning first');
assert.ok(
  pageSource.includes('onConfirm={handleDownload}'),
  'the download handler is reached only through the popup confirm',
);
console.log('PASS — grouped গাঠনিক/সামষ্টিক columns, term-carrying writes, gated Excel download');

/* ------------------------------------------------------------------ *
 * 12. Single-score (pre-primary) grid + saving spinner markup
 * ------------------------------------------------------------------ */
const preHtml = renderToStaticMarkup(React.createElement(SpreadsheetMarksGrid, {
  students: [{ id: 'p1', name: 'টিয়া', roll: 1 }],
  marks: { p1: { bangla: { term1: 88 } } },
  config: preConfig,
  tabId: 'term1',
  getResult: (studentId) => computeTermResultForConfig(
    { p1: { bangla: { term1: 88 } } }[studentId] ?? {}, preConfig, 'term1',
  ),
  onEntry: () => {},
  canEdit: true,
  onSortModeChange: () => {},
  saving: true,
}));
assert.ok(preHtml.includes('একক নম্বর'), 'a non-split class renders the একক নম্বর group');
assert.ok(!preHtml.includes('গাঠনিক মূল্যায়ন'), 'a non-split class has no গাঠনিক group');
assert.ok(preHtml.includes('সংরক্ষণ হচ্ছে'), 'the grid surfaces a saving indicator');
assert.ok(preHtml.includes('value="88"'), 'an entered mark is rendered in its cell');

/* ------------------------------------------------------------------ *
 * 13. Per-row মন্তব্য column (P0-5)
 * ------------------------------------------------------------------ */
const remarkHtml = renderToStaticMarkup(React.createElement(SpreadsheetMarksGrid, {
  students: [{ id: 'r1', name: 'রুমি', roll: 1 }, { id: 'r2', name: 'সজীব', roll: 2 }],
  marks: {},
  config: c1,
  tabId: 'term1',
  getResult: () => computeTermResultForConfig({}, c1, 'term1'),
  onEntry: () => {},
  canEdit: true,
  onShowRemark: () => {},
  onSortModeChange: () => {},
  // Only the first pupil has a saved remark for THIS term.
  getRemark: (studentId) => (studentId === 'r1' ? 'নিয়মিত অনুশীলন চালিয়ে যাবে।' : ''),
}));
assert.ok(remarkHtml.includes('মন্তব্য'), 'every row ends with a মন্তব্য column');
assert.ok(remarkHtml.includes('নিয়মিত অনুশীলন'), 'a saved remark is previewed in the row');
assert.ok(remarkHtml.includes('মন্তব্য লিখুন'), 'an empty remark shows the write prompt');
assert.ok(remarkHtml.includes('এর মন্তব্য'), 'the comment cell is a clickable button');

console.log('PASS — rendered grid (highlights, golden badge, sort control, per-term columns)');
