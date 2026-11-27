import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowDownUp, CheckCircle2, Crown, Info, Star } from 'lucide-react';
import { toBanglaNumber } from '../../utils/banglaNumberFormatter.js';
import { configEntryFields } from '../../utils/resultConfig.js';
import { rankClassRows, subjectTermEntry } from '../../utils/resultEngine.js';
import { clsx } from '../../utils/clsx.js';
import Spinner from '../ui/Spinner.jsx';
import StickyScrollBar from '../ui/StickyScrollBar.jsx';

/**
 * Excel-like marks grid (one evaluation tab).
 *
 * Column order is GROUPED, not per-subject interleaved:
 *   শিক্ষার্থী │ গাঠনিক মূল্যায়ন (সব বিষয়) │ সামষ্টিক মূল্যায়ন (সব বিষয়) │
 *   একক নম্বর │ মোট │ GPA │ গ্রেড │ মেধাক্রম │ নতুন রোল
 *
 * Each group carries its own header tint and cell tint (sky = গাঠনিক, violet = সামষ্টিক,
 * slate = একক, emerald = ফলাফল তৈরি) so a teacher can tell the groups apart at a glance.
 * Clicking a group header scrolls that section to the MIDDLE of the visible grid
 * (`centerSection`) — the sticky শিক্ষার্থী column stays put while the section centres
 * in the space to its right.
 * The section tabs ALSO live in a sticky bar above the grid (`sticky top-0`): the
 * in-table headers sit inside the horizontal-scroll container, so they scroll away
 * with the page — the bar above never leaves the screen while the grid is in view.
 *
 * • Keyboard: arrows move one cell/row, `Tab`/`Shift+Tab` walk the natural order,
 *   `Enter` jumps to the same subject of the next pupil.
 * • Cells are proofed as the teacher types (`proofTone`, error > fail > weak > golden):
 *   a mark above the field's set max (or negative / not a number) is ERROR RED with a
 *   red border; a subject whose formative + summative combined total is below the
 *   pass mark is LIGHT RED; a single component below the pass mark's share of ITS
 *   own max is LIGHT YELLOW; 80+ is light green. Empty cells are never coloured.
 * • A pupil at/above the golden mark in EVERY subject carries the golden badge.
 * • Clicking a pupil's NAME opens the pupil's profile & result details (`onShowStudent`);
 *   the small info button beside it opens the same full record.
 * • Remarks are opened ONLY from the dedicated মন্তব্য column / remark button
 *   (`onShowRemark`) — a name click never hijacks remark editing.
 *
 * Every typed value is committed WITH its term id — `setMark(studentId, fieldKey,
 * termId, value)` — so moving to another cell can never wipe a previously entered
 * cell. A committed value stays pinned locally until the store echoes it back, so the
 * input never flickers to a stale blank while the write is in flight.
 */
const cellKey = (studentId, fieldKey) => `${studentId}:${fieldKey}`;

const fieldLimit = (field) => (Number(field?.max) > 0 ? Number(field.max) : 100);

/** Value as shown inside an input (blank stays blank — never `undefined`). */
const displayValue = (value) => (value === null || value === undefined ? '' : String(value));

/** Loose numeric comparison so `"45"`, `45` and `45.00` are the same committed cell. */
const sameValue = (a, b) => {
  const left = displayValue(a).trim();
  const right = displayValue(b).trim();
  if (left === right) return true;
  const leftNumber = Number(left);
  const rightNumber = Number(right);
  return Number.isFinite(leftNumber) && Number.isFinite(rightNumber) && leftNumber === rightNumber;
};

/** A committed value waits at most this long for the store to confirm it. */
const PENDING_TTL_MS = 8000;

/**
 * Proofing colour of one entered cell — the three-tier result check, strongest first:
 *
 *   1. WRONG MARK (error red + red border) — the typed value is above the field's set
 *      max (e.g. 35 in a 30-mark field), negative, or not a number. `setMark` stores
 *      an over-max value as-is (it only clamps negatives to 0), so the error state
 *      stays visible after saving, not just while typing.
 *   2. COMBINED BELOW PASS (light red, warning-like) — the subject's formative +
 *      summative total is below the pass mark (default 33% of the subject's full
 *      mark, from the result config). Applied to that subject's entered cells.
 *   3. SINGLE COMPONENT BELOW 33% (light yellow) — this component alone is below
 *      the pass mark's share of ITS OWN max (e.g. pass 33 ⇒ formative max 30 needs
 *      ≥ 9.9, summative max 70 needs ≥ 23.1). Never hard-coded 30/70.
 *   4. Golden (light green) — the subject is at/above the golden mark.
 *
 * Precedence: error > light red > light yellow > section tint. The classes are
 * Tailwind utilities, so they beat the batch-5b section tints (component layer)
 * wherever they apply. Empty cells (`numeric === null`) are never coloured as
 * failing — a pupil with no marks at all shows no proofing colour.
 */
function proofTone({ entry, numeric, fieldMax, passMark, goldenMark, invalid }) {
  if (invalid) {
    return 'border-rose-600 bg-rose-100 text-rose-800 ring-1 ring-rose-500/50 dark:border-rose-400 dark:bg-rose-950/60 dark:text-rose-200';
  }
  if (numeric === null || !entry?.hasAnyMark) return '';
  if (!entry.isPass) {
    return 'bg-rose-50 text-rose-700 dark:bg-rose-950/40 dark:text-rose-200';
  }
  const threshold = (Number(passMark) / 100) * Number(fieldMax);
  if (Number.isFinite(numeric) && numeric >= 0 && numeric < threshold) {
    return 'bg-amber-50 text-amber-800 dark:bg-amber-950/40 dark:text-amber-200';
  }
  if (entry.percent >= goldenMark) {
    return 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-200';
  }
  return '';
}

/** Visual class of one group (header / cell background / input tint). */
const GROUP_STYLE = {
  formative: {
    head: 'mark-group-head-formative',
    cell: 'mark-group-cell-formative',
    input: 'mark-cell-formative',
    edge: 'border-l-2 border-l-sky-400 dark:border-l-sky-600',
    label: 'গাঠনিক মূল্যায়ন',
    hint: 'শ্রেণিকাজ · উপস্থিতি · কার্যক্রম',
  },
  summative: {
    head: 'mark-group-head-summative',
    cell: 'mark-group-cell-summative',
    input: 'mark-cell-summative',
    edge: 'border-l-2 border-l-violet-400 dark:border-l-violet-600',
    label: 'সামষ্টিক মূল্যায়ন',
    hint: 'প্রান্তিক পরীক্ষা',
  },
  single: {
    head: 'mark-group-head-single',
    cell: 'mark-group-cell-single',
    input: 'mark-cell-single',
    edge: 'border-l-2 border-l-slate-300 dark:border-l-slate-600',
    label: 'একক নম্বর',
    hint: 'বিভাজন ছাড়া বিষয়',
  },
  /** ফলাফল তৈরি — the trailing মোট / GPA / গ্রেড / মেধাক্রম / নতুন রোল / মন্তব্য columns. */
  result: {
    head: 'mark-group-head-result',
    cell: 'mark-group-cell-result',
    input: 'mark-cell-single',
    edge: 'border-l-2 border-l-emerald-400 dark:border-l-emerald-600',
    label: 'ফলাফল তৈরি',
    hint: 'মোট · GPA · গ্রেড · মেধাক্রম',
  },
};

/** A remark preview: one sentence, trimmed, or the `মন্তব্য লিখুন` prompt. */
const remarkPreview = (text) => {
  const clean = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!clean) return '';
  const sentences = clean.match(/[^।]+।?/g) ?? [clean];
  const first = (sentences[0] ?? clean).trim();
  return first.length > 34 ? `${first.slice(0, 32)}…` : first;
};

/** The three renderable groups, in display order. */
const GROUP_ORDER = ['formative', 'summative', 'single'];


export default function SpreadsheetMarksGrid({
  students = [],
  marks = {},
  config,
  tabId = 'term1',
  getResult,
  onEntry,
  setMark,
  canEdit = false,
  /** Click on a pupil's NAME → the profile & result-details modal. */
  onShowStudent,
  /** Click on the মন্তব্য cell → the editable remark modal. */
  onShowRemark,
  onShowResult,
  /** `(studentId) => string` — the saved remark of the ACTIVE term (preview column). */
  getRemark,
  sortMode = 'roll',
  onSortModeChange,
  saving = false,
  /** `{studentId: newRoll}` from the CONSOLIDATED result — `{}` until it is calculated. */
  newRollMap = null,
}) {
  const fields = useMemo(() => configEntryFields(config), [config]);
  const passMark = Number(config?.passMark) || 33;
  const goldenMark = Number(config?.goldenMark) || 80;
  const isConsolidated = tabId === 'consolidated';
  /** Term id used by every write of this tab (the consolidated tab is read-only). */
  const termForTab = tabId || 'term1';
  /** Term the per-subject entry highlighting is computed from. */
  const entryTerm = isConsolidated ? 'annual' : termForTab;
  // নতুন রোল only exists once the combined বার্ষিক ফলাফল has been calculated. The
  // caller passes the consolidated map, so a per-term tab shows মেধাক্রম only until then.
  const showNewRoll = Boolean(newRollMap) || isConsolidated;
  const safeStudents = useMemo(
    () => (Array.isArray(students) ? students.filter((student) => student && student.id) : []),
    [students],
  );
  const disabled = !canEdit || isConsolidated;

  const [drafts, setDrafts] = useState({});
  const draftsRef = useRef(drafts);
  const pendingRef = useRef({});
  const editingKey = useRef(null);
  const gridRef = useRef(null);
  /** The desktop table's horizontal scroll container (the sticky bottom bar syncs with it). */
  const tableWrapRef = useRef(null);

  /**
   * Brief "সংরক্ষণ হয়েছে" confirmation after the "সংরক্ষণ হচ্ছে…" spinner clears.
   * A toast per typed cell would spam the teacher, so the grid shows this inline
   * flash instead: it appears only on a `saving: true → false` transition (never
   * on first render) and hides itself after 2.5 s or when the next save starts.
   */
  const [justSaved, setJustSaved] = useState(false);
  const prevSavingRef = useRef(saving);
  const savedTimerRef = useRef(null);
  useEffect(() => {
    if (prevSavingRef.current && !saving) {
      setJustSaved(true);
      if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
      savedTimerRef.current = setTimeout(() => setJustSaved(false), 2500);
    } else if (saving) {
      setJustSaved(false);
    }
    prevSavingRef.current = saving;
  }, [saving]);
  useEffect(() => () => {
    if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
  }, []);

  const changeDraft = useCallback((key, value) => {
    const next = { ...draftsRef.current, [key]: value };
    draftsRef.current = next;
    setDrafts(next);
  }, []);

  useEffect(() => {
    draftsRef.current = drafts;
  }, [drafts]);

  /**
   * A draft/pinned value belongs to ONE term. Switching the evaluation tab must drop
   * them, otherwise the previous term's typed value could be re-pinned into the new one.
   */
  const previousTermRef = useRef(termForTab);
  useEffect(() => {
    if (previousTermRef.current === termForTab) return;
    previousTermRef.current = termForTab;
    draftsRef.current = {};
    pendingRef.current = {};
    editingKey.current = null;
    setDrafts({});
  }, [termForTab]);

  /**
   * Columns grouped by evaluation type — ALL গাঠনিক columns first, then ALL সামষ্টিক
   * columns, then the single-score subjects. `ordered` drives rendering AND keyboard
   * navigation, so Tab / arrows always walk the grid left-to-right, top-to-bottom.
   */
  const columnGroups = useMemo(() => {
    const subjects = Array.isArray(config?.subjects) ? config.subjects : [];
    const groups = { formative: [], summative: [], single: [] };
    subjects.forEach((subject) => {
      if (!subject?.id) return;
      fields
        .filter((field) => field.subjectId === subject.id)
        .forEach((field) => {
          const bucket = field.component === 'formative'
            ? 'formative'
            : field.component === 'summative' ? 'summative' : 'single';
          groups[bucket].push({ ...field, subject });
        });
    });
    return {
      ...groups,
      ordered: GROUP_ORDER.flatMap((groupKey) => groups[groupKey]),
    };
  }, [config, fields]);

  const ordered = columnGroups.ordered;

  /**
   * Commits one typed cell WITH the active term id — this is the fix for previously
   * entered cells being wiped when the teacher moves to another cell.
   */
  const writeCell = useCallback((studentId, fieldKey, value) => {
    if (typeof setMark === 'function') {
      setMark(studentId, fieldKey, termForTab, value);
      return;
    }
    onEntry?.(studentId, fieldKey, termForTab, value);
  }, [setMark, onEntry, termForTab]);

  const commitCell = useCallback((studentId, fieldKey, inputValue) => {
    const key = cellKey(studentId, fieldKey);
    const hasDraft = Object.prototype.hasOwnProperty.call(draftsRef.current, key);
    const raw = hasDraft ? draftsRef.current[key] : inputValue;
    editingKey.current = null;
    if (raw === undefined || raw === null) return;
    const value = String(raw);
    // Pin the committed value until the store echoes it back (no flicker / no wipe).
    pendingRef.current[key] = { value, at: Date.now() };
    writeCell(studentId, fieldKey, value);
  }, [writeCell]);

  // Store → local sync. A focused cell is never touched; a committed cell keeps its
  // typed value until the store confirms it, then the draft is released.
  useEffect(() => {
    if (!safeStudents.length || !ordered.length) return;
    const focusedKey = document.activeElement?.closest?.('input[data-grid]')
      ?.getAttribute?.('data-grid-key') ?? null;
    const now = Date.now();
    setDrafts((previous) => {
      let changed = false;
      const next = { ...previous };
      safeStudents.forEach((student) => {
        ordered.forEach((column) => {
          const key = cellKey(student.id, column.key);
          const remote = displayValue(marks?.[student?.id]?.[column.key]?.[termForTab]);
          if (editingKey.current === key || focusedKey === key) {
            if (!Object.prototype.hasOwnProperty.call(next, key) && remote !== '') {
              next[key] = remote;
              changed = true;
            }
            return;
          }
          const pending = pendingRef.current[key];
          if (pending) {
            if (sameValue(pending.value, remote) || now - pending.at > PENDING_TTL_MS) {
              delete pendingRef.current[key];
              if (Object.prototype.hasOwnProperty.call(next, key)) {
                delete next[key];
                changed = true;
              }
              return;
            }
            if (next[key] !== pending.value) {
              next[key] = pending.value;
              changed = true;
            }
            return;
          }
          if (Object.prototype.hasOwnProperty.call(next, key) && next[key] !== remote) {
            next[key] = remote;
            changed = true;
          }
        });
      });
      return changed ? next : previous;
    });
  }, [safeStudents, ordered, marks, termForTab]);

  const rows = useMemo(() => {
    const computed = safeStudents.map((student) => ({
      student,
      result: getResult?.(student.id) ?? { hasAnyMark: false, totalMarks: 0, subjects: [] },
    }));
    return rankClassRows(computed, { assignNewRoll: isConsolidated });
  }, [safeStudents, getResult, isConsolidated]);

  /** `studentId ➔ ranked row` — O(1) lookup instead of a `find` per pupil. */
  const rankMap = useMemo(() => {
    const map = new Map();
    rows.forEach((row) => map.set(row.studentId, row));
    return map;
  }, [rows]);

  /** Presentation order: current roll, or merit position (both ascending). */
  const visibleRows = useMemo(() => {
    const list = [...rows];
    if (sortMode === 'merit') return list.sort((a, b) => a.position - b.position);
    return list.sort((a, b) => (Number(a.student?.roll) || Number.MAX_SAFE_INTEGER)
      - (Number(b.student?.roll) || Number.MAX_SAFE_INTEGER));
  }, [rows, sortMode]);

  /** Arrow/Tab/Enter navigation over the whole grid (row-major, Excel-like). */
  const move = useCallback((event) => {
    const { key } = event;
    if (!['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Enter', 'Tab'].includes(key)) return;
    const inputs = [...(gridRef.current?.querySelectorAll('input[data-grid]') ?? [])];
    const index = inputs.indexOf(event.currentTarget);
    if (index < 0) return;
    const width = Math.max(1, ordered.length);
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
  }, [ordered.length]);

  /** `{ [studentId]: { [subjectId]: {formative, summative, total} } }` of this tab. */
  const entries = useMemo(() => {
    const map = {};
    const subjects = Array.isArray(config?.subjects) ? config.subjects : [];
    safeStudents.forEach((student) => {
      map[student.id] = {};
      subjects.forEach((subject) => {
        if (!subject?.id) return;
        map[student.id][subject.id] = subjectTermEntry(
          subject, marks?.[student.id] ?? {}, entryTerm, passMark,
        );
      });
    });
    return map;
  }, [safeStudents, config, marks, entryTerm, passMark]);

  const goldenOf = (studentId) => {
    const subjects = Array.isArray(config?.subjects) ? config.subjects : [];
    if (!subjects.length) return false;
    const row = entries?.[studentId] ?? {};
    return subjects.every((subject) => {
      const entry = row?.[subject?.id];
      return Boolean(entry?.hasAnyMark) && Number(entry?.percent) >= goldenMark;
    });
  };

  const valueOf = (student, field) => {
    const key = cellKey(student.id, field.key);
    if (Object.prototype.hasOwnProperty.call(drafts, key)) return drafts[key];
    return displayValue(marks?.[student.id]?.[field.key]?.[termForTab]);
  };

  const renderInput = (student, field) => {
    const key = cellKey(student.id, field.key);
    const entry = entries?.[student.id]?.[field.subjectId];
    const value = valueOf(student, field);
    const blank = value === '' || value === null || value === undefined;
    const numeric = blank ? null : Number(value);
    const invalid = numeric !== null
      && (!Number.isFinite(numeric) || numeric < 0 || numeric > fieldLimit(field));
    // Proofing (error > combined-fail > single-component > golden) wins over the
    // section tint; the `mark-cell-invalid` class keeps the error focus ring too.
    const tone = disabled ? '' : proofTone({
      entry,
      numeric,
      fieldMax: fieldLimit(field),
      passMark,
      goldenMark,
      invalid,
    });
    const groupStyle = GROUP_STYLE[field.component] ?? GROUP_STYLE.single;
    return (
      <input
        data-grid="true"
        data-grid-key={key}
        data-group={field.component === 'formative' || field.component === 'summative' ? field.component : 'single'}
        aria-label={`${student.name}, ${field.label}`}
        disabled={disabled}
        type="number"
        min="0"
        max={fieldLimit(field)}
        step="any"
        inputMode="decimal"
        className={clsx('mark-cell min-w-0 flex-1', groupStyle.input, tone, invalid && 'mark-cell-invalid')}
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

  const rankOf = (studentId) => rankMap.get(studentId) ?? null;

  /** Saved remark of a pupil for the ACTIVE term (undefined when the caller has none). */
  const remarkOf = (studentId) => {
    if (typeof getRemark !== 'function') return '';
    return String(getRemark(studentId) ?? '');
  };

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

  /** The group buckets that actually carry columns, in display order. */
  const activeGroups = useMemo(
    () => GROUP_ORDER.filter((groupKey) => columnGroups[groupKey].length > 0),
    [columnGroups],
  );

  /** Trailing result columns (মোট … মন্তব্য) — the ফলাফল তৈরি section. */
  const resultColumnCount = 4 + (showNewRoll ? 1 : 0) + 1;

  /**
   * Click a section header → scroll the grid so that section sits in the MIDDLE of
   * the visible display. The sticky শিক্ষার্থী column stays put, so the section is
   * centred in the space to its right; a section wider than that space is shown
   * from its first column instead. Smooth scroll, clamped to the scroll range.
   */
  const centerSection = useCallback((sectionKey) => {
    const wrap = tableWrapRef.current;
    if (!wrap) return;
    const cells = [...wrap.querySelectorAll(`th[data-section="${sectionKey}"]`)];
    if (!cells.length) return;
    const first = cells[0];
    const last = cells[cells.length - 1];
    const wrapRect = wrap.getBoundingClientRect();
    const firstRect = first.getBoundingClientRect();
    const lastRect = last.getBoundingClientRect();
    const sectionLeft = wrap.scrollLeft + (firstRect.left - wrapRect.left);
    const sectionWidth = lastRect.right - firstRect.left;
    const stickyTh = wrap.querySelector('thead th.sticky');
    const stickyWidth = stickyTh ? stickyTh.getBoundingClientRect().width : 0;
    const visibleWidth = Math.max(1, wrap.clientWidth - stickyWidth);
    const target = sectionWidth >= visibleWidth
      ? sectionLeft - stickyWidth
      : sectionLeft + sectionWidth / 2 - stickyWidth - visibleWidth / 2;
    const max = Math.max(0, wrap.scrollWidth - wrap.clientWidth);
    wrap.scrollTo({ left: Math.max(0, Math.min(max, target)), behavior: 'smooth' });
  }, []);

  /** One clickable group header — label + hint, hover hint so teachers discover it. */
  const renderGroupHeader = (groupKey) => (
    <button
      type="button"
      onClick={() => centerSection(groupKey)}
      className="block w-full cursor-pointer rounded-md px-1 py-0.5 transition hover:bg-white/40 hover:underline hover:underline-offset-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/60 dark:hover:bg-white/10"
      title={`${GROUP_STYLE[groupKey].label} — ক্লিক করলে এই অংশ মাঝখানে আসবে`}
      aria-label={`${GROUP_STYLE[groupKey].label} মাঝখানে দেখুন`}
    >
      {GROUP_STYLE[groupKey].label}
      <span className="ml-1 block text-[10px] font-normal opacity-80">
        {GROUP_STYLE[groupKey].hint}
      </span>
    </button>
  );

  return (
    <div className="min-w-0 rounded-xl border border-slate-200 dark:border-slate-700">
      {onSortModeChange ? (
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-3 py-2 dark:border-slate-800">
          <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] font-semibold text-slate-500">
            <Info size={12} aria-hidden="true" />
            তীরচিহ্ন / Tab / Enter দিয়ে ঘর বদলান · খালি ঘর ০ হিসেবে গণ্য হবে
            {saving ? (
              <span className="inline-flex items-center gap-1.5 rounded-full bg-brand-50 px-2 py-0.5 font-bold text-brand-700 dark:bg-brand-900/40 dark:text-brand-200">
                <Spinner size="xs" tone="brand" label="নম্বর সংরক্ষণ হচ্ছে…" /> সংরক্ষণ হচ্ছে…
              </span>
            ) : justSaved ? (
              <span role="status" className="inline-flex items-center gap-1.5 rounded-full bg-emerald-50 px-2 py-0.5 font-bold text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-200">
                <CheckCircle2 size={12} aria-hidden="true" /> সংরক্ষণ হয়েছে
              </span>
            ) : null}
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

      {/* Group legend: which tint belongs to which evaluation group. */}
      {activeGroups.length ? (
        <div className="flex flex-wrap items-center gap-2 border-b border-slate-100 px-3 py-2 dark:border-slate-800">
          {activeGroups.map((groupKey) => (
            <span key={groupKey} className={clsx('badge border', GROUP_STYLE[groupKey].head)}>
              {GROUP_STYLE[groupKey].label}
              <span className="font-normal opacity-80">· {toBanglaNumber(columnGroups[groupKey].length)} কলাম</span>
            </span>
          ))}
        </div>
      ) : null}

      {/*
        Sticky section tabs — স্ক্রল করলেও স্ক্রিনের উপরে আটকে থাকে, কখনো
        বাইরে যায় না। টেবিলের ভেতরের গ্রুপ হেডার (`th`, sticky top-0) এই কাজ
        করতে পারে না: টেবিলটা `overflow-x-auto` কনটেইনারের ভেতরে, তাই হেডার
        পেজের সঙ্গে উপরে চলে যায়। এই বারটি সেই কনটেইনারের বাইরে, গ্রিডের
        উপরে — `sticky top-0` (টপবারের z-20-এর উপরে, z-30) বলে পেজের উপরে
        আটকে থাকে যতক্ষণ গ্রিড পর্দায় আছে; পেজের উপরে থাকলে নিজের জায়গাতেই
        থাকে, কিছু ঢাকে না। বাটনগুলো টেবিলের হেডারের মতোই `centerSection`
        ডাকে — ক্লিক করলে সেই সেকশন ডিসপ্লের মাঝখানে আসে। ডেস্কটপ/ট্যাবলেটে
        দেখায়; মোবাইলে গ্রিড কার্ড আকারে (পাশে স্ক্রল নেই), তাই সেখানে বার
        লুকানো থাকে — কার্ডে প্রতিটা সেকশনের নাম এমনিতেই লেখা থাকে।
      */}
      <div
        className="sticky top-0 z-30 hidden border-b border-slate-200 bg-white/95 shadow-sm backdrop-blur-sm md:flex dark:border-slate-700 dark:bg-slate-900/95"
        role="tablist"
        aria-label="মূল্যায়ন সেকশন — ক্লিক করলে সেই অংশ মাঝখানে আসবে"
      >
        {[...activeGroups, 'result'].map((groupKey) => {
          const count = groupKey === 'result'
            ? resultColumnCount
            : columnGroups[groupKey].length;
          return (
            <button
              key={`tab-${groupKey}`}
              type="button"
              role="tab"
              onClick={() => centerSection(groupKey)}
              className={clsx(
                'flex-1 px-3 py-2 text-center transition hover:brightness-95 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/60',
                GROUP_STYLE[groupKey].head,
              )}
              title={`${GROUP_STYLE[groupKey].label} — ক্লিক করলে এই অংশ মাঝখানে আসবে`}
              aria-label={`${GROUP_STYLE[groupKey].label} মাঝখানে দেখুন`}
            >
              <span className="block text-xs font-bold">{GROUP_STYLE[groupKey].label}</span>
              <span className="block text-[10px] font-normal opacity-80">
                {GROUP_STYLE[groupKey].hint} · {toBanglaNumber(count)} কলাম
              </span>
            </button>
          );
        })}
      </div>

      {/* Desktop / tablet: one spreadsheet row per pupil. */}
      <div ref={tableWrapRef} className="hidden max-w-full overflow-x-auto scroll-thin md:block">
        <table className="table-base min-w-[980px]">
          <thead>
            <tr>
              <th rowSpan={2} className="sticky left-0 top-0 z-20">শিক্ষার্থী / রোল</th>
              {activeGroups.map((groupKey) => (
                <th
                  key={`group-${groupKey}`}
                  colSpan={columnGroups[groupKey].length}
                  className={clsx('top-0 z-20 text-center', GROUP_STYLE[groupKey].head, GROUP_STYLE[groupKey].edge)}
                >
                  {renderGroupHeader(groupKey)}
                </th>
              ))}
              {/* ফলাফল তৈরি — its own clickable header over the trailing result columns. */}
              <th
                colSpan={resultColumnCount}
                className={clsx('top-0 z-20 text-center', GROUP_STYLE.result.head, GROUP_STYLE.result.edge)}
              >
                {renderGroupHeader('result')}
              </th>
            </tr>
            <tr>
              {activeGroups.flatMap((groupKey) => columnGroups[groupKey].map((field) => (
                <th
                  key={`head-${field.key}`}
                  data-section={groupKey}
                  className={clsx('top-[2.4rem] z-10 text-center', GROUP_STYLE[groupKey].cell, GROUP_STYLE[groupKey].edge)}
                  title={`${field.subject?.name ?? field.subjectName} · ${field.label}`}
                >
                  <span className="block max-w-24 truncate">{field.subject?.name ?? field.subjectName}</span>
                  <span className="block text-[10px] font-normal opacity-70">({toBanglaNumber(fieldLimit(field))})</span>
                </th>
              )))}
              <th data-section="result" className={clsx('top-[2.4rem] z-10 text-center', GROUP_STYLE.result.cell, GROUP_STYLE.result.edge)}>মোট</th>
              <th data-section="result" className={clsx('top-[2.4rem] z-10 text-center', GROUP_STYLE.result.cell)}>GPA</th>
              <th data-section="result" className={clsx('top-[2.4rem] z-10 text-center', GROUP_STYLE.result.cell)}>গ্রেড</th>
              <th data-section="result" className={clsx('top-[2.4rem] z-10 text-center', GROUP_STYLE.result.cell)}>মেধাক্রম</th>
              {showNewRoll ? <th data-section="result" className={clsx('top-[2.4rem] z-10 text-center', GROUP_STYLE.result.cell)}>নতুন রোল</th> : null}
              <th data-section="result" className={clsx('top-[2.4rem] z-10 text-center', GROUP_STYLE.result.cell)}>মন্তব্য</th>
            </tr>
          </thead>
          <tbody ref={gridRef}>
            {visibleRows.map(({ student, result }) => {
              const golden = goldenOf(student.id);
              const rankRow = rankOf(student.id);
              return (
                <tr key={student.id}>
                  <td className="sticky left-0 bg-white dark:bg-slate-900">
                    <div className="flex items-start gap-1.5">
                      <button
                        type="button"
                        className="text-left"
                        onClick={() => onShowStudent?.(student)}
                        title="পূর্ণাঙ্গ তথ্য ও ফলাফল দেখুন"
                        aria-label={`${student.name} এর পূর্ণাঙ্গ তথ্য ও ফলাফল`}
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
                      {onShowStudent ? (
                        <button
                          type="button"
                          onClick={() => onShowStudent(student)}
                          className="mt-0.5 shrink-0 rounded p-0.5 text-slate-400 transition hover:bg-slate-100 hover:text-brand-700 dark:hover:bg-slate-800"
                          title="পূর্ণাঙ্গ তথ্য"
                          aria-label={`${student.name} এর পূর্ণাঙ্গ তথ্য`}
                        >
                          <Info size={12} aria-hidden="true" />
                        </button>
                      ) : null}
                    </div>
                    <div className="text-[10px] text-slate-400">রোল {toBanglaNumber(student.roll)}</div>
                  </td>
                  {activeGroups.flatMap((groupKey) => columnGroups[groupKey].map((field) => (
                    <td
                      key={field.key}
                      className={clsx('min-w-16 p-1', GROUP_STYLE[groupKey].cell, GROUP_STYLE[groupKey].edge)}
                    >
                      {renderInput(student, field)}
                    </td>
                  )))}
                  <td className={clsx('font-bold', GROUP_STYLE.result.cell, GROUP_STYLE.result.edge)}>{toBanglaNumber(result?.totalMarks ?? 0)}</td>
                  <td className={GROUP_STYLE.result.cell}>{result?.gpa == null ? '—' : Number(result.gpa).toFixed(2)}</td>
                  <td className={GROUP_STYLE.result.cell}>
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
                  <td className={GROUP_STYLE.result.cell}>{toBanglaNumber(result?.hasAnyMark ? rankRow?.position ?? '—' : '—')}</td>
                  {showNewRoll ? (
                    <td className={clsx('font-bold text-brand-700 dark:text-brand-300', GROUP_STYLE.result.cell)}>
                      {toBanglaNumber(newRollOf(student.id) ?? '—')}
                    </td>
                  ) : null}
                  <td className={clsx('min-w-32 align-top', GROUP_STYLE.result.cell)}>
                    {/* মন্তব্য — the ONLY place a remark modal opens (name clicks open the profile). */}
                    <button
                      type="button"
                      onClick={() => (onShowRemark ?? onShowStudent)?.(student)}
                      className="w-full rounded-lg px-1.5 py-1 text-left text-[11px] font-semibold leading-snug text-slate-600 transition hover:bg-brand-50 hover:text-brand-800 dark:text-slate-300 dark:hover:bg-slate-800"
                      title="মন্তব্য দেখুন ও সম্পাদনা করুন"
                      aria-label={`${student.name} এর মন্তব্য`}
                    >
                      {remarkOf(student.id)
                        ? remarkPreview(remarkOf(student.id))
                        : <span className="text-slate-400 underline decoration-dotted underline-offset-2">মন্তব্য লিখুন</span>}
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* পর্দার নিচে আটকে থাকা স্ক্রল বার (fixed — পেজ যেখানেই স্ক্রল থাকুক, বার
          স্ক্রিনের নিচে থাকে; গ্রিড পর্দায় না থাকলে বার নিজে লুকিয়ে যায়)।
          মোবাইলে ডেস্কটপ টেবিল লুকানো থাকে বলে বার নিজেই লুকিয়ে যায়। */}
      <StickyScrollBar targetRef={tableWrapRef} label="নম্বর গ্রিড পাশে স্ক্রল করুন" />

      {/* Mobile: each pupil is a card; গাঠনিক and সামষ্টিক stay in their own tinted areas. */}
      <div className="divide-y divide-slate-100 md:hidden dark:divide-slate-800">
        {visibleRows.map(({ student, result }) => {
          const golden = goldenOf(student.id);
          const rankRow = rankOf(student.id);
          return (
            <div key={student.id} className="p-3">
              <div className="mb-2 flex items-start justify-between gap-2">
                <div className="flex items-start gap-1.5">
                  <button
                    type="button"
                    className="text-left"
                    onClick={() => onShowStudent?.(student)}
                    title="পূর্ণাঙ্গ তথ্য ও ফলাফল দেখুন"
                    aria-label={`${student.name} এর পূর্ণাঙ্গ তথ্য ও ফলাফল`}
                  >
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
                  {onShowStudent ? (
                    <button
                      type="button"
                      onClick={() => onShowStudent(student)}
                      className="mt-0.5 shrink-0 rounded p-0.5 text-slate-400 transition hover:bg-slate-100 hover:text-brand-700 dark:hover:bg-slate-800"
                      title="পূর্ণাঙ্গ তথ্য"
                      aria-label={`${student.name} এর পূর্ণাঙ্গ তথ্য`}
                    >
                      <Info size={12} aria-hidden="true" />
                    </button>
                  ) : null}
                </div>
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
                {activeGroups.map((groupKey) => (
                  <div
                    key={`${student.id}-${groupKey}`}
                    className={clsx('rounded-lg p-1.5', GROUP_STYLE[groupKey].cell, GROUP_STYLE[groupKey].edge)}
                  >
                    <p className="mb-1 text-[11px] font-bold text-slate-600 dark:text-slate-300">
                      {GROUP_STYLE[groupKey].label}
                    </p>
                    <div className="grid gap-1.5 sm:grid-cols-2">
                      {columnGroups[groupKey].map((field) => (
                        <label key={field.key} className="flex min-w-0 items-center gap-1.5">
                          <span className="w-20 shrink-0 truncate text-[10px] font-semibold text-slate-600 dark:text-slate-300">
                            {field.subject?.name ?? field.subjectName}
                            <span className="block text-[9px] font-normal text-slate-400">
                              ({toBanglaNumber(fieldLimit(field))})
                            </span>
                          </span>
                          {renderInput(student, field)}
                        </label>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
              <div className={clsx('mt-1.5 flex flex-wrap items-center gap-1.5 rounded-lg px-2 py-1 text-[11px] font-semibold text-slate-600 dark:text-slate-300', GROUP_STYLE.result.cell)}>
                <span>মোট {toBanglaNumber(result?.totalMarks ?? 0)}</span>
                <span>· GPA {result?.gpa == null ? '—' : Number(result.gpa).toFixed(2)}</span>
                <span>· মেধাক্রম {toBanglaNumber(result?.hasAnyMark ? rankRow?.position ?? '—' : '—')}</span>
                {showNewRoll ? (
                  <span>· নতুন রোল {toBanglaNumber(newRollOf(student.id) ?? '—')}</span>
                ) : null}
              </div>
              <button
                type="button"
                onClick={() => (onShowRemark ?? onShowStudent)?.(student)}
                className="mt-1.5 w-full rounded-lg border border-dashed border-slate-300 px-2 py-1.5 text-left text-[11px] font-semibold text-slate-600 transition hover:border-brand-300 hover:bg-brand-50 dark:border-slate-600 dark:text-slate-300 dark:hover:bg-slate-800"
                aria-label={`${student.name} এর মন্তব্য`}
              >
                <span className="text-slate-400">মন্তব্য: </span>
                {remarkOf(student.id)
                  ? remarkPreview(remarkOf(student.id))
                  : <span className="text-slate-400">মন্তব্য লিখুন</span>}
              </button>
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


