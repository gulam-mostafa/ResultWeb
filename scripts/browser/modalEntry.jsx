/**
 * Focused harness for the ANNUAL PROMOTION MODAL, used by the browser render check
 * (`scripts/browser/render-check.mjs`, page `/modal-check.html`).
 *
 * The full app is exercised separately (dashboard + roster); this entry point mounts
 * ONLY `AutoPromotionModal` with a controlled promotion log, so the modal's own rules
 * are measured in a real Chrome render without any database at all:
 *  - the default class (first unpromoted ⇒ ১ম শ্রেণি),
 *  - "সম্পূর্ণ" in the dropdown AND in the six-row status list,
 *  - "আনলক করুন" + "আনলক করেছেন: …" for a promoted class,
 *  - the CENTRED confirm overlay after "উত্তরণ কার্যকর".
 *
 * Nothing here reaches Firebase: every prop is a plain in-memory value.
 */
import React, { useState } from 'react';
import ReactDOM from 'react-dom/client';
import '../../src/index.css';
import AutoPromotionModal from '../../src/components/students/AutoPromotionModal.jsx';

const YEAR = '2030';
const NEXT = '2030'.replace('0', '1');

const students = [
  { id: 'R-1', studentMasterId: 'R-1', name: 'রুমি আক্তার', classId: 'pre', section: 'ক', roll: 1 },
  { id: 'R-2', studentMasterId: 'R-2', name: 'সজীব হাসান', classId: 'pre', section: 'ক', roll: 2 },
  { id: 'R-3', studentMasterId: 'R-3', name: 'তানিয়া ইসলাম', classId: 'c1', section: 'ক', roll: 1 },
  { id: 'R-4', studentMasterId: 'R-4', name: 'নাফিস আহমেদ', classId: 'c1', section: 'ক', roll: 2 },
];

/** `pre` is promoted (and was unlocked once by an admin); the rest are open. */
const promotionState = {
  classes: {
    pre: {
      completedAt: `${YEAR}-11-01T09:00:00.000Z`,
      completedBy: 'uid-teacher',
      completedByName: 'মোছাঃ সালমা আক্তার',
      completedByEmail: 'salma@example.com',
      fromYear: YEAR,
      toYear: NEXT,
      promoted: 2,
      retained: 0,
      graduated: 0,
      moved: ['R-1', 'R-2'],
      graduatedIds: [],
      destinations: { 'R-1': 'c1', 'R-2': 'c1' },
      auto: false,
    },
  },
  unlocks: {
    pre: [{
      at: `${YEAR}-11-05T10:30:00.000Z`,
      by: 'school_admin',
      uid: 'uid-admin',
      name: 'মোঃ গোলাম মোস্তফা',
      email: 'golam@example.com',
    }],
  },
  auto: null,
};

const result = { hasAnyMark: true, isPass: true, totalMarks: 420, gpa: 4.6, grade: 'A' };

function Harness() {
  const [open, setOpen] = useState(true);
  return (
    <AutoPromotionModal
      open={open}
      onClose={() => setOpen(false)}
      students={students}
      allStudents={students}
      marks={{}}
      getStudentResult={() => result}
      getStudentClassRank={() => ({ position: 1 })}
      getClassRankMap={() => new Map([['R-1', { position: 1, totalMarks: 420, hasAnyMark: true, result }]])}
      getSectionsOfClass={() => ['ক']}
      getResultConfig={() => null}
      getRemark={() => ''}
      getTermResult={() => result}
      getClassAnalytics={() => ({ rows: [] })}
      schoolId="modal-check-school"
      activeYear={YEAR}
      currentYear={YEAR}
      nextYear={NEXT}
      onAdvanceYear={() => ({ synced: true })}
      onExecute={() => {}}
      promotionState={promotionState}
      onUndoClass={async () => ({ synced: true })}
    />
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(<Harness />);
