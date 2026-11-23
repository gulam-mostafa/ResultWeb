import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowDownUp, Crown, Star } from 'lucide-react';
import { toBanglaNumber } from '../../utils/banglaNumberFormatter.js';
import { configEntryFields } from '../../utils/resultConfig.js';
import { rankClassRows, subjectTermEntry } from '../../utils/resultEngine.js';
import { clsx } from '../../utils/clsx.js';

/**
 * Excel-like marks grid (one evaluation tab).
 *
 * • Keyboard navigation: arrows move one cell/row, `Tab`/`Shift+Tab` follow the natural
 *   order, `Enter` jumps to the same subject of the next pupil (fast numeric entry).
 * • Cells highlight softly: light red below the school's pass mark, light green at or
 *   above the golden mark.
 * • A pupil with the golden mark in EVERY subject carries a golden badge (গোল্ডেন ব্যাজ).
 * • Sorting follows `বর্তমান রোল` or `মেধাক্রম` (display only — the stored order never
 *   changes).
 *
 * The whole table is derived from the ACTIVE SCHOOL's class configuration, so subject
 * names, full marks and the গাঠনিক/সামষ্টিক split are always that school's own.
 */
const cellKey = (studentId, fieldKey) => `${studentId}:${fieldKey}`;

const fieldLimit = (field) => (Number(field?.max) > 0 ? Number(field.max) : 100);

/** Soft highlight of one entered cell, based on its own percentage. */
function cellTone(entry, passMark, goldenMark) {
  if (!entry?.hasAnyMark) return '';
  if (!entry.isPass) return 'bg-rose-50 text-rose-700 dark:bg-rose-950/40 dark:text-rose-200';
  if (entry.percent >= goldenMark) return 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-200';
  return '';
}

export default function SpreadsheetMarksGrid({
  students = [],
  marks = {},
  config,
  tabId = 'term1',
  getResult,
  onEntry,
  setMark,
  canEdit = false,
  onShowStudent,
  onShowResult,
  sortMode = 'roll',
  onSortModeChange,
  /** `{studentId: newRoll}` from the CONSOLIDATED result — `{}` until it is calculated. */
  newRollMap = null,
}) {
  const fields = useMemo(() => configEntryFields(config), [config]);
  const passMark = Number(config?.passMark) || 33;
  const goldenMark = Number(config?.goldenMark) || 80;
  const isConsolidated = tabId === 'consolidated';
  // নতুন রোল only exists once the combined বার্ষিক ফলাফল has been calculated. The
  // caller passes the consolidated map, so a per-term tab shows মেধাক্রম only until then.
  const showNewRoll = Boolean(newRollMap) || isConsolidated;
  const [drafts, setDrafts] = useState({});
  const draftsRef = useRef(drafts);
  const editingKey = useRef(null);
  const gridRef = useRef(null);

  const changeDraft = useCallback((key, value) => {
    const next = { ...draftsRef.current, [key]: value };
    draftsRef.current = next;
    setDrafts(next);
  }, []);

  useEffect(() => {
    draftsRef.current = drafts;
  }, [drafts]);

  // Remote updates refresh untouched cells, but never replace the value being typed.
  useEffect(() => {
    setDrafts((previous) => {
      let changed = false;
      const next = { ...previous };
      students.forEach((student) => fields.forEach((field) => {
        const key = cellKey(student.id, field.key);
        const focusedInput = document.activeElement?.closest?.('input[data-grid]');
        const focusedKey = focusedInput?.getAttribute?.('data-grid-key');
        if (editingKey.current === key || focusedKey === key) return;
        const remote = marks?.[student.id]?.[field.key]?.[tabId] ?? '';
        if (Object.prototype.hasOwnProperty.call(next, key) && next[key] !== remote) {
          next[key] = remote;
          changed = true;
        }
      }));
      return changed ? next : previous;
    });
  }, [students, marks, fields, tabId]);

  const rows = useMemo(() => {
    const computed = students.map((student) => ({
      student,
      result: getResult?.(student.id) ?? { hasAnyMark: false, totalMarks: 0, subjects: [] },
    }));
    return rankClassRows(computed, { assignNewRoll: isConsolidated });
  }, [students, getResult, isConsolidated]);

  /** Presentation order: current roll, or merit position (both ascending). */
  const visibleRows = useMemo(() => {
    const list = [...rows];
    if (sortMode === 'merit') return list.sort((a, b) => a.position - b.position);
    return list.sort((a, b) => (Number(a.student?.roll) || Number.MAX_SAFE_INTEGER)
      - (Number(b.student?.roll) || Number.MAX_SAFE_INTEGER));
  }, [rows, sortMode]);

  const commitCell = (studentId, fieldKey, inputValue) => {
    const key = cellKey(studentId, fieldKey);
    const hasDraft = Object.prototype.hasOwnProperty.call(draftsRef.current, key);
    const value = hasDraft ? draftsRef.current[key] : inputValue;
    editingKey.current = null;
    if (hasDraft) {
      const next = { ...draftsRef.current };
      delete next[key];
      draftsRef.current = next;
      setDrafts(next);
    }
    if (value !== undefined) onEntry?.(studentId, fieldKey, value);
  };

  /** Arrow/Tab/Enter navigation over the whole grid (row-major, Excel-like). */
  const move = (event) => {
    const { key } = event;
    if (!['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Enter', 'Tab'].includes(key)) return;
    const inputs = [...(gridRef.current?.querySelectorAll('input[data-grid]') ?? [])];
    const index = inputs.indexOf(event.currentTarget);
    if (index < 0) return;
    const width = Math.max(1, fields.length);
    let delta = 0;
    if (key === 'ArrowDown') delta = width;
    else if (key === 'ArrowUp') delta = -width;
    else if (key === 'ArrowRight') delta = 1;
    else if (key === 'ArrowLeft') delta = -1;
    else if (key === 'Enter') delta = event.shiftKey ? -width : width;
    else if (key === 'Tab') delta = event.shiftKey ? -1 : 1;
    event.preventDefault();
    const target = inputs[Math.max(0, Math.min(inputs.length - 1, index + delta))];
    target?.focus?.();
    target?.select?.();
  };


  /** `{ [studentId]: { [subjectId]: {formative, summative, total} } }` of this tab. */
  const entries = useMemo(() => {
    const map = {};
    students.forEach((student) => {
      map[student.id] = {};
      (config?.subjects ?? []).forEach((subject) => {
        map[student.id][subject.id] = subjectTermEntry(
          subject, marks?.[student.id] ?? {}, isConsolidated ? 'annual' : tabId, passMark,
        );
      });
    });
    return map;
  }, [students, config, marks, tabId, passMark, isConsolidated]);

  const goldenOf = (studentId) => {
    const subjects = config?.subjects ?? [];
    if (!subjects.length) return false;
    const row = entries[studentId] ?? {};
    return subjects.every((subject) => row[subject.id]?.hasAnyMark && row[subject.id]?.percent >= goldenMark);
  };

  const valueOf = (studentId, field) => {
    const key = cellKey(studentId, field.key);
    if (Object.prototype.hasOwnProperty.call(drafts, key)) return drafts[key];
    return marks?.[studentId]?.[field.key]?.[tabId] ?? '';
  };

  const renderInput = (student, field) => {
    const key = cellKey(student.id, field.key);
    const entry = entries[student.id]?.[field.subjectId];
    const value = valueOf(student.id, field);
    const blank = value === '' || value === null || value === undefined;
    const numeric = blank ? null : Number(value);
    const invalid = numeric !== null && (numeric < 0 || numeric > fieldLimit(field));
    // The consolidated tab is derived from the three terms, so it is read-only.
    const disabled = !canEdit || isConsolidated;
    const tone = disabled ? '' : cellTone(entry, passMark, goldenMark);
    return (
      <input
        data-grid="true"
        data-grid-key={key}
        aria-label={`${student.name}, ${field.label}`}
        disabled={disabled}
        type="number"
        min="0"
        max={fieldLimit(field)}
        inputMode="decimal"
        className={clsx('mark-cell', tone, invalid && 'mark-cell-invalid')}
        value={value}
        onFocus={(event) => {
          editingKey.current = key;
          if (!Object.prototype.hasOwnProperty.call(draftsRef.current, key)) {
            changeDraft(key, event.currentTarget.value);
          }
        }}
        onChange={(event) => changeDraft(key, event.target.value)}
        onBlur={(event) => commitCell(student.id, field.key, event.currentTarget.value)}
        onKeyDown={move}
      />
    );
  };

  const rankOf = (studentId) => rows.find((row) => row.studentId === studentId) ?? null;

  /**
   * নতুন রোল of one pupil: the consolidated map wins; the consolidated tab falls back to
   * its own ranking. A per-term tab therefore shows `—` until বার্ষিক ফলাফল exists.
   */
  const newRollOf = (studentId) => {
    if (newRollMap && Object.prototype.hasOwnProperty.call(newRollMap, studentId)) {
      return newRollMap[studentId];
    }
    if (!isConsolidated) return null;
    return rankOf(studentId)?.newRoll ?? null;
  };


  return (
    <div className="rounded-xl border border-slate-200 dark:border-slate-700">
      {onSortModeChange ? (
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-3 py-2 dark:border-slate-800">
          <p className="text-[11px] font-semibold text-slate-500">
            তীরচিহ্ন / Tab / Enter দিয়ে ঘর বদলান · খালি ঘর ০ হিসেবে গণ্য হবে
          </p>
          <label className="flex items-center gap-1.5 text-[11px] font-semibold text-slate-600 dark:text-slate-300">
            <ArrowDownUp size={13} aria-hidden="true" /> ক্রম
            <select
              className="input-base w-36 py-1 text-xs"
              value={sortMode}
              onChange={(event) => onSortModeChange(event.target.value)}
              aria-label="সাজানোর ক্রম"
            >
              <option value="roll">বর্তমান রোল</option>
              <option value="merit">মেধাক্রম</option>
            </select>
          </label>
        </div>
      ) : null}

      {/* Desktop / tablet: one spreadsheet row per pupil. */}
      <div className="hidden overflow-auto md:block">
        <table className="table-base min-w-[980px]">
          <thead>
            <tr>
              <th className="sticky left-0 z-20">শিক্ষার্থী</th>
              {(config?.subjects ?? []).map((subject) => (
                <th key={subject.id} colSpan={subject.split ? 2 : 1} className="text-center">
                  {subject.name}
                  <span className="ml-1 font-normal text-slate-400">({toBanglaNumber(subject.fullMarks)})</span>
                </th>
              ))}
              <th>মোট</th>
              <th>GPA</th>
              <th>গ্রেড</th>
              <th>মেধাক্রম</th>
              {showNewRoll ? <th>নতুন রোল</th> : null}
            </tr>
            <tr>
              <th className="sticky left-0 z-20">রোল</th>
              {(config?.subjects ?? []).flatMap((subject) => (
                subject.split
                  ? [
                    <th key={`${subject.id}-f`} className="text-center">গাঠনিক</th>,
                    <th key={`${subject.id}-s`} className="text-center">সামষ্টিক</th>,
                  ]
                  : [<th key={subject.id} className="text-center">নম্বর</th>]
              ))}
              <th>{toBanglaNumber(config?.subjects?.reduce((sum, subject) => sum + subject.fullMarks, 0) ?? 0)}</th>
              <th>৫.০০</th>
              <th>—</th>
              <th>—</th>
              {showNewRoll ? <th>—</th> : null}
            </tr>
          </thead>
          <tbody ref={gridRef}>
            {visibleRows.map(({ student, result }) => {
              const golden = goldenOf(student.id);
              const rankRow = rankOf(student.id);
              return (
                <tr key={student.id}>
                  <td className="sticky left-0 bg-white dark:bg-slate-900">
                    <button
                      type="button"
                      className="text-left"
                      onClick={() => onShowStudent?.(student)}
                      aria-label={`${student.name} এর পূর্ণাঙ্গ তথ্য`}
                    >
                      <span className="inline-flex flex-wrap items-center gap-1 font-bold text-brand-800 underline decoration-brand-300 underline-offset-2 hover:decoration-brand-700 dark:text-brand-200">
                        {student.name}
                        {golden ? (
                          <span className="badge bg-amber-100 text-amber-800" title="সব বিষয়ে ৮০+ — গোল্ডেন ব্যাজ">
                            <Crown size={11} strokeWidth={2.6} aria-hidden="true" /> গোল্ডেন
                          </span>
                        ) : null}
                      </span>
                    </button>
                    <div className="text-[10px] text-slate-400">রোল {toBanglaNumber(student.roll)}</div>
                  </td>
                  {(config?.subjects ?? []).map((subject) => fields
                    .filter((field) => field.subjectId === subject.id)
                    .map((field) => (
                      <td key={field.key} className="min-w-16 p-1">{renderInput(student, field)}</td>
                    )))}
                  <td className="font-bold">{toBanglaNumber(result?.totalMarks ?? 0)}</td>
                  <td>{result?.gpa == null ? '—' : Number(result.gpa).toFixed(2)}</td>
                  <td>
                    <button
                      type="button"
                      onClick={() => onShowResult?.(student)}
                      aria-label={`${student.name} এর ফলাফল`}
                      disabled={!onShowResult}
                      className={`badge ${result?.isPass ? 'bg-emerald-100 text-emerald-800' : 'bg-rose-100 text-rose-800'} underline-offset-2 hover:underline`}
                    >
                      {result?.grade ?? '—'}
                    </button>
                  </td>
                  <td>{toBanglaNumber(result?.hasAnyMark ? rankRow?.position ?? '—' : '—')}</td>
                  {showNewRoll ? (
                    <td className="font-bold text-brand-700 dark:text-brand-300">
                      {toBanglaNumber(newRollOf(student.id) ?? '—')}
                    </td>
                  ) : null}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Mobile: each pupil is a card; গাঠনিক / সামষ্টিক stack vertically. */}
      <div className="divide-y divide-slate-100 md:hidden dark:divide-slate-800">
        {visibleRows.map(({ student, result }) => {
          const golden = goldenOf(student.id);
          const rankRow = rankOf(student.id);
          return (
            <div key={student.id} className="p-3">
              <div className="mb-2 flex items-start justify-between gap-2">
                <button type="button" className="text-left" onClick={() => onShowStudent?.(student)}>
                  <span className="inline-flex flex-wrap items-center gap-1 text-sm font-bold text-brand-800 dark:text-brand-200">
                    {student.name}
                    {golden ? (
                      <span className="badge bg-amber-100 text-amber-800">
                        <Crown size={10} strokeWidth={2.6} aria-hidden="true" /> গোল্ডেন
                      </span>
                    ) : null}
                  </span>
                  <span className="block text-[10px] text-slate-400">রোল {toBanglaNumber(student.roll)}</span>
                </button>
                <button
                  type="button"
                  onClick={() => onShowResult?.(student)}
                  disabled={!onShowResult}
                  className={`badge ${result?.isPass ? 'bg-emerald-100 text-emerald-800' : 'bg-rose-100 text-rose-800'}`}
                >
                  {result?.grade ?? '—'}
                </button>
              </div>
              <div className="space-y-1.5">
                {(config?.subjects ?? []).map((subject) => (
                  <div key={subject.id} className="rounded-lg bg-slate-50 p-1.5 dark:bg-slate-800">
                    <p className="mb-1 text-[11px] font-bold text-slate-500">
                      {subject.name} · পূর্ণমান {toBanglaNumber(subject.fullMarks)}
                    </p>
                    <div className="grid gap-1.5 sm:grid-cols-2">
                      {fields.filter((field) => field.subjectId === subject.id).map((field) => (
                        <label key={field.key} className="flex items-center gap-1.5">
                          <span className="w-16 shrink-0 text-[10px] font-semibold text-slate-500">
                            {field.component === 'formative' ? 'গাঠনিক' : field.component === 'summative' ? 'সামষ্টিক' : 'নম্বর'}
                          </span>
                          {renderInput(student, field)}
                        </label>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
              <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[11px] font-semibold text-slate-600 dark:text-slate-300">
                <span>মোট {toBanglaNumber(result?.totalMarks ?? 0)}</span>
                <span>· GPA {result?.gpa == null ? '—' : Number(result.gpa).toFixed(2)}</span>
                <span>· মেধাক্রম {toBanglaNumber(result?.hasAnyMark ? rankRow?.position ?? '—' : '—')}</span>
                {showNewRoll ? (
                  <span>· নতুন রোল {toBanglaNumber(newRollOf(student.id) ?? '—')}</span>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>

      {!visibleRows.length ? (
        <p className="py-8 text-center text-sm text-slate-400">
          <Star size={14} className="mr-1 inline" aria-hidden="true" />
          এই শ্রেণিতে কোনো শিক্ষার্থী নেই।
        </p>
      ) : null}
    </div>
  );
}

