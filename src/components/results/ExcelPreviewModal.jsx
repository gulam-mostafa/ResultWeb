import { useMemo, useState } from 'react';
import { AlertTriangle, CheckCircle2, FileSpreadsheet, Save } from 'lucide-react';
import Modal from '../ui/Modal.jsx';
import { Badge } from '../ui/Primitives.jsx';
import { toBanglaNumber } from '../../utils/banglaNumberFormatter.js';
import { configEntryFields } from '../../utils/resultConfig.js';
import { computeConsolidatedResult, computeTermResultForConfig, rankClassRows } from '../../utils/resultEngine.js';

/**
 * Screen preview (আগে স্ক্রিন প্রিভিউ) of a parsed Excel upload.
 *
 * Nothing is written until the teacher presses সংরক্ষণ — the modal re-calculates the
 * result of every pupil from the PARSED marks, merges them over the website's values
 * and shows exactly what will be saved to the active school's own database path.
 */
const cellKey = (studentId, fieldKey) => `${studentId}:${fieldKey}`;

export default function ExcelPreviewModal({
  open,
  onClose,
  spec,
  rows = {},
  config,
  tabId = 'term1',
  marks = {},
  onSave,
  saving = false,
}) {
  const [error, setError] = useState('');
  const fields = useMemo(() => configEntryFields(config), [config]);
  const isConsolidated = tabId === 'consolidated';

  /** Merged marks: the parsed values win, everything else keeps the website value. */
  const mergedMarks = useMemo(() => {
    const next = {};
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
      next[student.id] = studentMarks;
    });
    return next;
  }, [spec, rows, marks, config, tabId]);

  const preview = useMemo(() => {
    const computed = (spec?.students ?? []).map((student) => {
      const result = isConsolidated
        ? computeConsolidatedResult(mergedMarks[student.id] ?? {}, config)
        : computeTermResultForConfig(mergedMarks[student.id] ?? {}, config, tabId);
      return { student, studentId: student.id, result };
    });
    return rankClassRows(computed, { assignNewRoll: isConsolidated });
  }, [spec, mergedMarks, config, tabId, isConsolidated]);

  const changedCount = useMemo(() => {
    let count = 0;
    (spec?.students ?? []).forEach((student) => {
      fields.forEach((field) => {
        const parsed = rows?.[student.id]?.[field.key];
        const current = marks?.[student.id]?.[field.key]?.[tabId] ?? null;
        if ((parsed ?? null) !== (current ?? null)) count += 1;
      });
    });
    return count;
  }, [spec, rows, marks, fields, tabId]);

  const save = async () => {
    setError('');
    try {
      const result = await onSave?.(mergedMarks);
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
    subtitle={`${spec?.className ?? ''} · ${spec?.tabName ?? ''} — সংরক্ষণের আগে যাচাই করুন`}
    icon={FileSpreadsheet}
    size="xl"
    footer={<div className="flex w-full flex-wrap items-center justify-between gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone="emerald"><CheckCircle2 size={11} /> ফাইল যাচাই সম্পন্ন</Badge>
        <Badge tone="brand">{toBanglaNumber(changedCount)} ঘর পরিবর্তিত</Badge>
        <Badge tone="slate">{toBanglaNumber(preview.length)} শিক্ষার্থী</Badge>
      </div>
      <div className="flex items-center gap-2">
        <button type="button" className="btn-secondary" onClick={onClose}>বাতিল</button>
        <button type="button" className="btn-primary" onClick={save} disabled={saving}>
          <Save size={15} /> {saving ? 'সংরক্ষণ হচ্ছে…' : 'সংরক্ষণ'}
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

      <div className="overflow-auto rounded-xl border border-slate-200 dark:border-slate-700">
        <table className="table-base min-w-[900px]">
          <thead>
            <tr>
              <th className="sticky left-0 z-20">শিক্ষার্থী</th>
              {(config?.subjects ?? []).map((subject) => (
                <th key={subject.id} colSpan={subject.split ? 2 : 1} className="text-center">{subject.name}</th>
              ))}
              <th>মোট</th>
              <th>GPA</th>
              <th>গ্রেড</th>
              <th>মেধাক্রম</th>
              {isConsolidated ? <th>নতুন রোল</th> : null}
            </tr>
          </thead>
          <tbody>
            {preview.map(({ student, result }) => (
              <tr key={student.id}>
                <td className="sticky left-0 bg-white dark:bg-slate-900">
                  <span className="font-bold">{student.name}</span>
                  <span className="block text-[10px] text-slate-400">রোল {toBanglaNumber(student.roll)}</span>
                </td>
                {(config?.subjects ?? []).map((subject) => fields
                  .filter((field) => field.subjectId === subject.id)
                  .map((field) => {
                    const value = rows?.[student.id]?.[field.key];
                    const previous = marks?.[student.id]?.[field.key]?.[tabId] ?? null;
                    const changed = (value ?? null) !== (previous ?? null);
                    return (
                      <td key={cellKey(student.id, field.key)} className={`text-center ${changed ? 'bg-brand-50 font-bold text-brand-800 dark:bg-brand-900/30 dark:text-brand-200' : ''}`}>
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
    </div>
  </Modal>;
}

