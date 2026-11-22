/**
 * Render-level smoke test (no browser, no network).
 *
 * Verifies the behaviour that only shows up in the rendered markup:
 *  - the promotion month/year badge animates inside the 90-day window and produces
 *    NO markup at all once the window is over (fully removed from the DOM);
 *  - the roster table renders the clickable name + result entry points;
 *  - the promotion modal renders a clickable name AND a clickable result per row;
 *  - the duplicate-roll rule only compares the SAME class AND SAME শাখা.
 */
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import PromotionBadge from '../../src/components/students/PromotionBadge.jsx';
import StudentTable from '../../src/components/students/StudentTable.jsx';
import AddStudentModal, { classChangeTarget, findDuplicateRoll, nextFreeRoll } from '../../src/components/students/AddStudentModal.jsx';
import { CLASS_CHANGE_MODE } from '../../src/utils/constants.js';

const fresh = {
  id: 's1', name: 'রুমি', classId: 'c2', section: 'ক', roll: 1,
  promotedAt: new Date().toISOString(), promotedFromClass: 'c1', promotedFromYear: '2026', isNewPromotion: true,
};
const stale = {
  id: 's2', name: 'সজীব', classId: 'c2', section: 'ক', roll: 2,
  promotedAt: '2020-01-01T00:00:00.000Z', promotedFromClass: 'c1', isNewPromotion: true,
};

const freshHtml = renderToStaticMarkup(React.createElement(PromotionBadge, { student: fresh }));
assert.ok(freshHtml.includes('animate-pulse-soft'), 'a fresh badge must animate');
assert.ok(freshHtml.length > 0, 'a fresh badge must render');

const staleHtml = renderToStaticMarkup(React.createElement(PromotionBadge, { student: stale }));
assert.equal(staleHtml, '', 'a badge older than 90 days must be REMOVED from the DOM');

const tableHtml = renderToStaticMarkup(React.createElement(StudentTable, {
  students: [fresh, stale],
  canEdit: true,
  onSelect: () => {},
  onShowResult: () => {},
  getStudentResult: () => ({ hasAnyMark: true, totalMarks: 420, gpa: 4.2 }),
}));
assert.ok(tableHtml.includes('ফলাফল'), 'the result column must render');
assert.ok(tableHtml.includes('মোট ৪২০'), 'the result value must render in Bangla digits');
assert.ok(tableHtml.includes('এর পূর্ণাঙ্গ তথ্য'), 'the pupil name must open the profile modal');
// Exactly ONE badge in the whole table: the fresh pupil. The stale pupil's badge is
// gone from the DOM entirely, which is the 3-month rule under test.
assert.equal((tableHtml.match(/animate-pulse-soft/g) ?? []).length, 1, 'only the fresh pupil carries the badge');

// Duplicate roll: exact class + শাখা only.
assert.ok(!findDuplicateRoll([fresh], { classId: 'c2', section: 'খ', roll: 1 }), 'same class, different শাখা is allowed');
assert.ok(!findDuplicateRoll([fresh], { classId: 'c1', section: 'ক', roll: 1 }), 'different class, same শাখা is allowed');
assert.ok(findDuplicateRoll([fresh], { classId: 'c2', section: 'ক', roll: 1 }), 'same class + same শাখা is a duplicate');
assert.ok(!findDuplicateRoll([fresh], { classId: 'c2', section: 'ক', roll: 1, ignoreId: 's1' }), 'editing a pupil never clashes with itself');

/* ------------------------------------------------------------------ *
 * Annual promotion modal — the row entry points exist in the component
 * ------------------------------------------------------------------ *
 * `Modal` renders through a portal and therefore draws nothing without a
 * `document` (server rendering), so the clickable row labels are asserted on the
 * component source + the data helpers the rows use.
 * ------------------------------------------------------------------ */
const { readFile: readSource } = await import('node:fs/promises');
const path = await import('node:path');
const readComponent = async (relative) =>
  readSource(path.join(process.cwd(), 'src/components/students', relative), 'utf8');
const promotionSource = await readComponent('AutoPromotionModal.jsx');
assert.ok(promotionSource.includes('setResultTarget(row.student)'), 'the promotion row result opens the result modal');
assert.ok(promotionSource.includes('setProfileTarget(row.student)'), 'the promotion row name opens the profile modal');
assert.ok((promotionSource.match(/event\.stopPropagation\(\)/g) ?? []).length >= 2, 'both row entry points stop propagation');
assert.ok(promotionSource.includes('<StudentResultModal'), 'the detailed result popup is mounted');
assert.ok(promotionSource.includes('<StudentDetailsModal'), 'the student profile popup is mounted');

/* ------------------------------------------------------------------ *
 * Individual promotion inside the edit form (class change + শাখা)
 * ------------------------------------------------------------------ */
assert.equal(classChangeTarget('c3', CLASS_CHANGE_MODE.PROMOTE), 'c4', 'promote ➔ next class');
assert.equal(classChangeTarget('c3', CLASS_CHANGE_MODE.DEMOTE), 'c2', 'demote ➔ class below');
assert.equal(classChangeTarget('c3', CLASS_CHANGE_MODE.STAY, 'c3'), 'c3', 'stay ➔ same class');
assert.equal(classChangeTarget('pre', CLASS_CHANGE_MODE.DEMOTE), 'pre', 'pre-primary has no class below');
assert.equal(nextFreeRoll([{ id: 'q', classId: 'c4', section: 'ক', roll: 5 }], { classId: 'c4', section: 'ক' }), 6);

const editSource = await readComponent('AddStudentModal.jsx');
assert.ok(editSource.includes('এই শ্রেণিতেই থাকুক'), 'the edit form offers “এই শ্রেণিতেই থাকুক”');
assert.ok(editSource.includes('উত্তীর্ণ ({classLabelOf(promoteClassId)})'), 'the edit form offers “উত্তীর্ণ”');
assert.ok(editSource.includes('এক শ্রেণি নিচে যাবে'), 'the edit form offers “এক শ্রেণি নিচে যাবে”');
assert.ok(editSource.includes('নতুন শাখা'), 'the edit form offers a destination শাখা selector');
assert.ok(editSource.includes('section: DEFAULT_SECTION_ID'), 'the destination শাখা defaults to ক');
assert.ok(editSource.includes('name="classChangeSection"'), 'the destination শাখা is typed/suggested freely');

console.log('PASS — badge DOM removal + roster entry points + duplicate-roll scoping');
