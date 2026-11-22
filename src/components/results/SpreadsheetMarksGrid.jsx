import { useEffect, useMemo, useRef, useState } from 'react';
import { SUBJECTS, TERMS } from '../../utils/constants.js';
import { computeMeritRanking } from '../../utils/gradingCalculator.js';
import { toBanglaNumber } from '../../utils/banglaNumberFormatter.js';

const cellKey = (studentId, subjectId, termId) => `${studentId}:${subjectId}:${termId}`;

export default function SpreadsheetMarksGrid({ students, marks, getStudentResult, getResult, setMark, canEdit, activeTerm = null, onShowStudent, onShowResult }) {
  const resolveResult = getResult ?? getStudentResult;
  const [drafts, setDrafts] = useState({});
  const draftsRef = useRef(drafts);
  const editingKey = useRef(null);

  const changeDraft = (key, value) => {
    const next = { ...draftsRef.current, [key]: value };
    draftsRef.current = next;
    setDrafts(next);
  };

  useEffect(() => {
    draftsRef.current = drafts;
  }, [drafts]);

  // Remote updates refresh untouched cells, but never replace the value currently being edited.
  useEffect(() => {
    setDrafts((previous) => {
      let changed = false;
      const next = { ...previous };
      students.forEach((student) => SUBJECTS.forEach((subject) => TERMS.forEach((term) => {
        const key = cellKey(student.id, subject.id, term.id);
        const focusedInput = document.activeElement?.closest?.('input[data-grid]');
        const focusedKey = focusedInput?.getAttribute?.('data-grid-key');
        if (editingKey.current === key || focusedKey === key) return;
        const remote = marks?.[student.id]?.[subject.id]?.[term.id] ?? '';
        if (Object.prototype.hasOwnProperty.call(next, key) && next[key] !== remote) {
          next[key] = remote;
          changed = true;
        }
      })));
      return changed ? next : previous;
    });
  }, [students, marks]);

  const rows = useMemo(() => {
    const computed = students.map((student) => ({ student, result: resolveResult(student.id) }));
    const ranked = computeMeritRanking(computed.filter(({ result }) => result.hasAnyMark).map(({ student, result }) => ({ studentId: student.id, totalMarks: result.totalMarks, hasAnyMark: result.hasAnyMark })));
    const positions = new Map(ranked.map((row) => [row.studentId, row.position]));
    const newRolls = new Map(ranked.map((row, index) => [row.studentId, index + 1]));
    let nextRoll = ranked.length + 1;
    computed.filter(({ result }) => !result.hasAnyMark).sort((a, b) => (a.student.roll ?? 0) - (b.student.roll ?? 0)).forEach(({ student }) => newRolls.set(student.id, nextRoll++));
    return computed.map((row) => ({ ...row, position: positions.get(row.student.id), newRoll: newRolls.get(row.student.id) }));
  }, [students, marks, resolveResult]);

  const commitCell = (studentId, subjectId, termId, inputValue) => {
    const key = cellKey(studentId, subjectId, termId);
    const hasDraft = Object.prototype.hasOwnProperty.call(draftsRef.current, key);
    const value = hasDraft ? draftsRef.current[key] : inputValue;
    editingKey.current = null;
    if (hasDraft) {
      const next = { ...draftsRef.current };
      delete next[key];
      draftsRef.current = next;
      setDrafts(next);
    }
    if (value !== undefined) setMark(studentId, subjectId, termId, value);
  };

  const move = (event) => {
    if (!['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Enter'].includes(event.key)) return;
    event.preventDefault();
    const inputs = [...event.currentTarget.closest('tbody').querySelectorAll('input[data-grid]')];
    const index = inputs.indexOf(event.currentTarget);
    const rowWidth = SUBJECTS.length * (activeTerm ? 1 : TERMS.length);
    const delta = event.key === 'ArrowDown' || event.key === 'Enter' ? rowWidth : event.key === 'ArrowUp' ? -rowWidth : event.key === 'ArrowRight' ? 1 : -1;
    inputs[Math.max(0, Math.min(inputs.length - 1, index + delta))]?.focus();
  };

  const visibleTerms = activeTerm ? TERMS.filter((term) => term.id === activeTerm) : TERMS;
  return <div className="overflow-auto rounded-xl border border-slate-200"><table className="table-base min-w-[1180px]"><thead>
    <tr><th className="sticky left-0 z-20">শিক্ষার্থী</th>{SUBJECTS.map((subject) => <th key={subject.id} colSpan={activeTerm ? 1 : 3} className="text-center">{subject.name}</th>)}<th>মোট</th><th>GPA</th><th>গ্রেড</th><th>মেধাক্রম</th><th>নতুন রোল</th></tr>
    <tr><th className="sticky left-0 z-20">রোল</th>{SUBJECTS.flatMap((subject) => visibleTerms.map((term) => <th key={`${subject.id}-${term.id}`} className="text-center">{term.shortName}</th>))}<th>{activeTerm ? '১০০' : '৬০০'}</th><th>৫.০০</th><th>—</th><th>—</th><th>—</th></tr>
  </thead><tbody>{rows.map(({ student, result, position, newRoll }) => <tr key={student.id}>
    <td className="sticky left-0 bg-white"><button type="button" className="text-left" onClick={() => onShowStudent?.(student)} aria-label={`${student.name} এর পূর্ণাঙ্গ তথ্য`}><span className="font-bold text-brand-800 underline decoration-brand-300 underline-offset-2 hover:decoration-brand-700 dark:text-brand-200">{student.name}</span></button><div className="text-[10px] text-slate-400">রোল {toBanglaNumber(student.roll)}</div></td>
    {SUBJECTS.flatMap((subject) => visibleTerms.map((term) => {
      const key = cellKey(student.id, subject.id, term.id);
      const remote = marks?.[student.id]?.[subject.id]?.[term.id] ?? '';
      const value = Object.prototype.hasOwnProperty.call(drafts, key) ? drafts[key] : remote;
      return <td key={key} className="min-w-16 p-1"><input data-grid="true" data-grid-key={key} aria-label={`${student.name}, ${subject.name}, ${term.name}`} disabled={!canEdit} type="number" min="0" max="100" className="mark-cell" value={value} onFocus={(event) => { editingKey.current = key; if (!Object.prototype.hasOwnProperty.call(draftsRef.current, key)) changeDraft(key, event.currentTarget.value); }} onChange={(event) => changeDraft(key, event.target.value)} onBlur={(event) => commitCell(student.id, subject.id, term.id, event.currentTarget.value)} onKeyDown={move} /></td>;
    }))}
    <td className="font-bold">{toBanglaNumber(result.totalMarks)}</td><td>{result.gpa?.toFixed(2) ?? '—'}</td>
    {/* The result badge opens the detailed result popup. */}
    <td><button type="button" onClick={() => onShowResult?.(student)} aria-label={`${student.name} এর ফলাফল`} disabled={!onShowResult} className={`badge ${result.isPass ? 'bg-emerald-100 text-emerald-800' : 'bg-rose-100 text-rose-800'} underline-offset-2 hover:underline`}>{result.grade}</button></td>
    <td>{toBanglaNumber(position ?? '—')}</td><td>{toBanglaNumber(newRoll ?? '—')}</td>
  </tr>)}</tbody></table></div>;
}

