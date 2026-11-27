import { useMemo, useState } from 'react';
import { AlertTriangle, CheckCircle2, FileSpreadsheet, Save } from 'lucide-react';
import Modal from '../ui/Modal.jsx';
import Spinner from '../ui/Spinner.jsx';
import { Badge } from '../ui/Primitives.jsx';
import { toBanglaNumber } from '../../utils/banglaNumberFormatter.js';
import { configEntryFields } from '../../utils/resultConfig.js';
import { computeConsolidatedResult, computeTermResultForConfig, rankClassRows } from '../../utils/resultEngine.js';


/**
 * Screen preview (আগে স্ক্রিন প্রিভিউ) of a parsed 6-sheet Excel upload.
 *
 * One class tab per শ্রেণি — the teacher checks each class, then presses
 * সংরক্ষণ ONCE. Nothing is written until then: the modal re-calculates the
 * result of every pupil from the PARSED marks, merges them over the website's
 * values and shows exactly what will be saved to the active school's own
 * database path. `onSave` receives `{ classId: mergedMarks }` for every class.
 *
 * `classes` — `[{ spec, config, rows }]` in CLASS_LEVELS order.
 */
const cellKey = (studentId, fieldKey) => `${studentId}:${fieldKey}`;

const GROUP_LABEL = {
  formative: { label: 'গাঠনিক মূল্যায়ন', head: 'mark-group-head-formative', cell: 'mark-group-cell-formative' },
  summative: { label: 'সামষ্টিক মূল্যায়ন', head: 'mark-group-head-summative', cell: 'mark-group-cell-summative' },
  single: { label: 'একক নম্বর', head: 'mark-group-head-single', cell: 'mark-group-cell-single' },
};

/** Pure per-class preview: merged marks, ranked rows, changed-cell count. */
function buildClassPreview({ spec, config, rows = {} }, tabId, marks = {}) {
  const fields = configEntryFields(config);
  const isConsolidated = tabId === 'consolidated';

  /**
   * Same grouping as the on-screen grid: every গাঠনিক column first, then every
   * সামষ্টিক column, then the single-score subjects — so the preview reads
   * exactly like the grid.
   */
  const buckets = { formative: [], summative: [], single: [] };
  (config?.subjects ?? []).forEach((subject) => {
    if (!subject?.id) return;
    fields
      .filter((field) => field.subjectId === subject.id)
      .forEach((field) => {
        const bucket = field.component === 'formative'
          ? 'formative'
          : field.component === 'summative' ? 'summative' : 'single';
        buckets[bucket].push({ ...field, subject });
      });
  });
  const groups = {
    ...buckets,
    ordered: ['formative', 'summative', 'single'].flatMap((key) => buckets[key]),
    active: ['formative', 'summative', 'single'].filter((key) => buckets[key].length > 0),
  };

  /** Merged marks: the parsed values win, everything else keeps the website value. */
  const mergedMarks = {};
  (spec?.students ?? []).forEach((student) => {
    const studentMarks = { ...(marks?.[student.id] ?? {}) };
    const parsed = rows?.[student.id] ?? {};
    Object.entries(parsed).forEach(([fieldKey, value]) => {
      const existing = { ...(studentMarks[fieldKey] ?? {}) };
      existing[tabId] = value;
      studentMarks[fieldKey] = existing;
    });
    // A split subject's components decide its total, exactly like the grid does.
    (config?.subjects ?? []).filter((subject) => subject.split).forEach((subject) => {
      const formative = studentMarks[`${subject.id}:formative`]?.[tabId];
      const summative = studentMarks[`${subject.id}:summative`]?.[tabId];
      if (formative === undefined && summative === undefined) return;
      studentMarks[subject.id] = {
        ...(studentMarks[subject.id] ?? {}),
        [tabId]: formative == null && summative == null
          ? null
          : Math.round(((Number(formative) || 0) + (Number(summative) || 0)) * 100) / 100,
      };
    });
    mergedMarks[student.id] = studentMarks;
  });

  const preview = rankClassRows(
    (spec?.students ?? []).map((student) => {
      const result = isConsolidated
        ? computeConsolidatedResult(mergedMarks[student.id] ?? {}, config)
        : computeTermResultForConfig(mergedMarks[student.id] ?? {}, config, tabId);
      return { student, studentId: student.id, result };
    }),
    { assignNewRoll: isConsolidated },
  );

  let changedCount = 0;
  (spec?.students ?? []).forEach((student) => {
    fields.forEach((field) => {
      const parsed = rows?.[student.id]?.[field.key];
      const current = marks?.[student.id]?.[field.key]?.[tabId] ?? null;
      if ((parsed ?? null) !== (current ?? null)) changedCount += 1;
    });
  });

  return { fields, groups, mergedMarks, preview, changedCount };
}

export default function ExcelPreviewModal({
  open,
  onClose,
  /** New shape: `[{ spec, config, rows }]` — one entry per শ্রেণি. */
  classes = [],
  /** Kept for the old single-class call shape (wrapped into `classes`). */
  spec,
  rows = {},
  config,
  tabId = 'term1',
  marks = {},
  onSave,
  saving = false,
}) {
  const [error, setError] = useState('');
  const isConsolidated = tabId === 'consolidated';

  const classList = useMemo(() => {
    if (classes.length) return classes;
    if (spec) return [{ spec, config, rows }];
    return [];
  }, [classes, spec, config, rows]);

  const previews = useMemo(
    () => classList.map((entry) => ({
      ...entry,
      ...buildClassPreview(entry, tabId, marks),
    })),
    [classList, tabId, marks],
  );

  // Default to the first class that actually has changes, else the first class.
  const defaultClassId = useMemo(() => {
    const withChanges = previews.find((entry) => entry.changedCount > 0);
    return (withChanges ?? previews[0])?.spec?.classId ?? '';
  }, [previews]);
  const [activeClassId, setActiveClassId] = useState('');
  const active = previews.find((entry) => entry.spec?.classId === activeClassId)
    ?? previews.find((entry) => entry.spec?.classId === defaultClassId)
    ?? previews[0];

  const totalChanged = previews.reduce((sum, entry) => sum + entry.changedCount, 0);
  const totalStudents = previews.reduce((sum, entry) => sum + (entry.spec?.students?.length ?? 0), 0);
  const activeTabName = active?.spec?.tabName ?? '';

  const save = async () => {
    setError('');
    try {
      const mergedByClass = {};
      previews.forEach((entry) => {
        mergedByClass[entry.spec.classId] = entry.mergedMarks;
      });
      const result = await onSave?.(mergedByClass);
      if (result?.synced === false) {
        setError('ক্লাউডে সংরক্ষণ ব্যর্থ হয়েছে — ইন্টারনেট সংযোগ দেখে আবার চেষ্টা করুন।');
        return;
      }
      onClose?.();
    } catch {
      setError('সংরক্ষণ করা যায়নি। আবার চেষ্টা করুন।');
    }
  };

  return <Modal
    open={open}
    onClose={onClose}
    title="এক্সেল প্রিভিউ"
    subtitle={`${activeTabName} — সংরক্ষণের আগে যাচাই করুন`}
    icon={FileSpreadsheet}
    size="xl"
    footer={<div className="flex w-full flex-wrap items-center justify-between gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone="emerald"><CheckCircle2 size={11} /> ফাইল যাচাই সম্পন্ন</Badge>
        <Badge tone="brand">{toBanglaNumber(totalChanged)} ঘর পরিবর্তিত</Badge>
        <Badge tone="slate">{toBanglaNumber(totalStudents)} শিক্ষার্থী</Badge>
      </div>
      <div className="flex items-center gap-2">
        <button type="button" className="btn-secondary" onClick={onClose}>বাতিল</button>
        <button type="button" className="btn-primary" onClick={save} disabled={saving}>
          {saving
            ? <><Spinner size="xs" tone="white" label="সংরক্ষণ হচ্ছে…" /> সংরক্ষণ হচ্ছে…</>
            : <><Save size={15} /> সংরক্ষণ</>}
        </button>
      </div>
    </div>}
  >
    <div className="space-y-3">
      <p className="rounded-lg bg-amber-50 p-2.5 text-[11px] font-semibold text-amber-800 dark:bg-amber-900/30 dark:text-amber-200">
        <AlertTriangle size={12} className="mr-1 inline" aria-hidden="true" />
        এটি শুধু প্রিভিউ — নিচের <b>সংরক্ষণ</b> বাটনে চাপ দেওয়ার আগে কোনো নম্বর ডেটাবেজে যাবে না।
      </p>
      {error ? <p role="alert" className="rounded-lg bg-rose-50 p-2.5 text-xs font-semibold text-rose-800 dark:bg-rose-950/40 dark:text-rose-200">{error}</p> : null}

      {/* এক শ্রেণি এক ট্যাব — প্রতিটি শ্রেণির পরিবর্তিত ঘর ও শিক্ষার্থী সংখ্যাসহ */}
      {previews.length > 1 ? (
        <div className="flex flex-wrap gap-2" role="tablist" aria-label="শ্রেণি নির্বাচন">
          {previews.map((entry) => {
            const selected = entry.spec?.classId === active?.spec?.classId;
            return (
              <button
                key={entry.spec.classId}
                type="button"
                role="tab"
                aria-selected={selected}
                onClick={() => setActiveClassId(entry.spec.classId)}
                className={`rounded-xl border px-3 py-2 text-xs font-bold transition ${selected
                  ? 'border-brand-700 bg-brand-700 text-white shadow-sm'
                  : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300'}`}
              >
                {entry.spec.className}
                <span className="ml-1.5 font-semibold opacity-80">
                  {toBanglaNumber(entry.changedCount)} ঘর · {toBanglaNumber(entry.spec?.students?.length ?? 0)} জন
                </span>
              </button>
            );
          })}
        </div>
      ) : null}

      {active ? (
        <div className="overflow-auto rounded-xl border border-slate-200 dark:border-slate-700">
          <table className="table-base min-w-[900px]">
            <thead>
              <tr>
                <th rowSpan={2} className="sticky left-0 z-20">শিক্ষার্থী</th>
                {active.groups.active.map((groupKey) => (
                  <th
                    key={`grp-${groupKey}`}
                    colSpan={active.groups[groupKey].length}
                    className={`text-center ${GROUP_LABEL[groupKey].head}`}
                  >
                    {GROUP_LABEL[groupKey].label}
                  </th>
                ))}
                <th rowSpan={2}>মোট</th>
                <th rowSpan={2}>GPA</th>
                <th rowSpan={2}>গ্রেড</th>
                <th rowSpan={2}>মেধাক্রম</th>
                {isConsolidated ? <th rowSpan={2}>নতুন রোল</th> : null}
              </tr>
              <tr>
                {active.groups.active.flatMap((groupKey) => active.groups[groupKey].map((field) => (
                  <th key={`pv-${field.key}`} className={`text-center ${GROUP_LABEL[groupKey].cell}`}>
                    <span className="block max-w-24 truncate">{field.subject?.name ?? field.subjectName}</span>
                    <span className="block text-[10px] font-normal opacity-70">({toBanglaNumber(field.max)})</span>
                  </th>
                )))}
              </tr>
            </thead>
            <tbody>
              {active.preview.map(({ student, result }) => (
                <tr key={student.id}>
                  <td className="sticky left-0 bg-white dark:bg-slate-900">
                    <span className="font-bold">{student.name}</span>
                    <span className="block text-[10px] text-slate-400">রোল {toBanglaNumber(student.roll)}{student.section ? ` · শাখা ${student.section}` : ''}</span>
                  </td>
                  {active.groups.active.flatMap((groupKey) => active.groups[groupKey].map((field) => {
                    const value = active.rows?.[student.id]?.[field.key];
                    const previous = marks?.[student.id]?.[field.key]?.[tabId] ?? null;
                    const changed = (value ?? null) !== (previous ?? null);
                    return (
                      <td
                        key={cellKey(student.id, field.key)}
                        className={`text-center ${GROUP_LABEL[groupKey].cell} ${changed ? 'bg-brand-50 font-bold text-brand-800 dark:bg-brand-900/30 dark:text-brand-200' : ''}`}
                      >
                        {value === null || value === undefined ? '—' : toBanglaNumber(value)}
                      </td>
                    );
                  }))}
                  <td className="font-bold">{toBanglaNumber(result.totalMarks)}</td>
                  <td>{result.gpa == null ? '—' : Number(result.gpa).toFixed(2)}</td>
                  <td><span className={`badge ${result.isPass ? 'bg-emerald-100 text-emerald-800' : 'bg-rose-100 text-rose-800'}`}>{result.grade}</span></td>
                  <td>{toBanglaNumber(result.hasAnyMark ? result.position : '—')}</td>
                  {isConsolidated ? <td className="font-bold">{toBanglaNumber(result.hasAnyMark ? result.newRoll : '—')}</td> : null}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="rounded-lg bg-slate-50 p-3 text-xs font-semibold text-slate-500 dark:bg-slate-800 dark:text-slate-300">
          এই ফাইলে কোনো শ্রেণির নম্বর পাওয়া যায়নি।
        </p>
      )}
    </div>
  </Modal>;
}
