import { useEffect, useMemo, useState } from 'react';
import { Plus, RotateCcw, Save, Settings2, Trash2 } from 'lucide-react';
import Modal from '../ui/Modal.jsx';
import Spinner from '../ui/Spinner.jsx';
import { Badge } from '../ui/Primitives.jsx';
import { toBanglaNumber } from '../../utils/banglaNumberFormatter.js';
import {
  DEFAULT_SUMMATIVE_FULL,
  classLabelOf,
  makeSubjectId,
  normalizeResultConfig,
  normalizeWeights,
  normalizedWeightPercent,
  round2,
  totalFullMarks,
  weightsAreClean,
} from '../../utils/resultConfig.js';

/**
 * Class-wise Results configuration editor.
 *
 * Lets a teacher customise, for THIS school / session / class only:
 *  • subject list (add / remove / rename),
 *  • গাঠনিক + সামষ্টিক full marks of every subject (e.g. 30 + 70),
 *  • the pass mark and the golden (৮০+) badge threshold,
 *  • the annual weights (default ১৫% + ১৫% + ৭০%).
 */
const numberValue = (value, fallback = 0) => {
  if (value === '' || value === null || value === undefined) return fallback;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
};

export default function ResultConfigModal({ open, onClose, classId, config, onSave, onReset, canEdit = true }) {
  const [draft, setDraft] = useState(() => normalizeResultConfig(config, classId));
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');

  useEffect(() => {
    if (!open) return;
    setDraft(normalizeResultConfig(config, classId));
    setNotice('');
  }, [open, classId, config]);

  const weightsPercent = useMemo(() => normalizedWeightPercent(draft.weights), [draft.weights]);
  const fullMarks = useMemo(() => totalFullMarks(draft), [draft]);
  const clean = weightsAreClean(draft.weights);

  const setField = (patch) => setDraft((previous) => normalizeResultConfig({ ...previous, ...patch }, classId));

  const setSubject = (subjectId, patch) => setDraft((previous) => normalizeResultConfig({
    ...previous,
    subjects: previous.subjects.map((subject) => (
      subject.id === subjectId ? { ...subject, ...patch } : subject
    )),
  }, classId));

  const addSubject = () => setDraft((previous) => normalizeResultConfig({
    ...previous,
    subjects: [
      ...previous.subjects,
      {
        id: makeSubjectId(`subject-${previous.subjects.length + 1}`, previous.subjects.map((item) => item.id)),
        name: `নতুন বিষয় ${previous.subjects.length + 1}`,
        split: true,
        formativeFull: 30,
        summativeFull: DEFAULT_SUMMATIVE_FULL,
      },
    ],
  }, classId));

  const removeSubject = (subjectId) => setDraft((previous) => {
    const remaining = previous.subjects.filter((subject) => subject.id !== subjectId);
    if (!remaining.length) return previous;
    return normalizeResultConfig({ ...previous, subjects: remaining }, classId);
  });

  const submit = async () => {
    if (!canEdit) return;
    // Weights must sum to EXACTLY 100%. An invalid sum is rejected in Bangla instead of
    // being silently re-normalised (the annual figure must be predictable for the school).
    if (!weightsAreClean(draft.weights)) {
      const total = round2(draft.weights.term1 + draft.weights.term2 + draft.weights.annual);
      setNotice(`ওজনের যোগফল ${toBanglaNumber(total)}% — তিন প্রান্তিকের ওজনের যোগফল অবশ্যই ১০০% হতে হবে। সংরক্ষণ করা হয়নি।`);
      return;
    }
    setBusy(true);
    setNotice('');
    const result = await onSave?.(classId, draft);
    setBusy(false);
    if (result?.synced === false) {
      setNotice('সেটিংস এই ব্রাউজারে রাখা হয়েছে, কিন্তু ক্লাউডে সংরক্ষণ ব্যর্থ — ইন্টারনেট সংযোগ দেখে আবার চেষ্টা করুন।');
      return;
    }
    setNotice('শ্রেণির রেজাল্ট সেটিংস সংরক্ষিত হয়েছে।');
    onClose?.();
  };

  const reset = async () => {
    if (!canEdit) return;
    setBusy(true);
    const result = await onReset?.(classId);
    setBusy(false);
    setDraft(normalizeResultConfig(null, classId));
    setNotice(result?.synced === false
      ? 'ডিফল্ট ফিরিয়ে আনা লোকালি হয়েছে।'
      : 'ডিফল্ট বিষয় ও নম্বর ফিরিয়ে আনা হয়েছে।');
  };

  return <Modal
    open={open}
    onClose={onClose}
    title="শ্রেণির রেজাল্ট সেটিংস"
    subtitle={`${classLabelOf(classId)} · এই বিদ্যালয়ের নিজস্ব সেটিংস (অন্য বিদ্যালয়ে প্রভাব পড়বে না)`}
    icon={Settings2}
    size="xl"
    footer={<div className="flex w-full flex-wrap items-center justify-between gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className="btn-secondary btn-sm" onClick={reset} disabled={!canEdit || busy}>
          <RotateCcw size={13} /> ডিফল্ট ফিরিয়ে আনুন
        </button>
        <Badge tone={clean ? 'emerald' : 'amber'}>
          ওজন {toBanglaNumber(weightsPercent.term1)}% + {toBanglaNumber(weightsPercent.term2)}% + {toBanglaNumber(weightsPercent.annual)}%
        </Badge>
        <Badge tone="slate">সর্বমোট পূর্ণমান {toBanglaNumber(fullMarks)}</Badge>
      </div>
      <div className="flex items-center gap-2">
        <button type="button" className="btn-secondary" onClick={onClose}>বাতিল</button>
        <button type="button" className="btn-primary" onClick={submit} disabled={!canEdit || busy}>
          {busy
            ? <><Spinner size="xs" tone="white" label="সংরক্ষণ হচ্ছে…" /> সংরক্ষণ হচ্ছে…</>
            : <><Save size={15} /> সংরক্ষণ</>}
        </button>
      </div>
    </div>}
  >
    <div className="space-y-4">
      {notice ? <p role="status" className="rounded-lg bg-brand-50 p-2.5 text-xs font-semibold text-brand-800 dark:bg-brand-900/30 dark:text-brand-200">{notice}</p> : null}

      <div className="grid gap-3 sm:grid-cols-3">
        <label><span className="label-base">পাস নম্বর</span><input type="number" min="1" max="100" className="input-base" value={draft.passMark} onChange={(event) => setField({ passMark: numberValue(event.target.value, 33) })} /></label>
        <label><span className="label-base">গোল্ডেন ব্যাজ (নম্বর ≥)</span><input type="number" min="1" max="100" className="input-base" value={draft.goldenMark} onChange={(event) => setField({ goldenMark: numberValue(event.target.value, 80) })} /></label>
        <div className="rounded-xl bg-slate-50 p-3 text-[11px] leading-relaxed text-slate-600 dark:bg-slate-800 dark:text-slate-300">
          কোনো বিষয়ে পাস নম্বরের কম হলে গ্রেড <b>F</b> ও GPA <b>০.০০</b> হবে, তবে <b>মোট নম্বর</b> অপরিবর্তিত থাকবে। {toBanglaNumber(draft.goldenMark)}+ পেলে ঘর হালকা সবুজ, আর সব বিষয়ে পেলে <b>গোল্ডেন ব্যাজ</b>।
        </div>
      </div>

      <div className="rounded-xl border border-slate-200 p-3 dark:border-slate-700">
        <p className="mb-2 text-xs font-bold text-slate-600 dark:text-slate-300">বার্ষিক ফলাফলের ওজন (১ম + ২য় + বার্ষিক)</p>
        <div className="grid gap-3 sm:grid-cols-3">
          <label><span className="label-base">১ম প্রান্তিক (%)</span><input type="number" min="0" max="100" className="input-base" value={draft.weights.term1} onChange={(event) => setField({ weights: normalizeWeights({ ...draft.weights, term1: numberValue(event.target.value, 0) }) })} /></label>
          <label><span className="label-base">২য় প্রান্তিক (%)</span><input type="number" min="0" max="100" className="input-base" value={draft.weights.term2} onChange={(event) => setField({ weights: normalizeWeights({ ...draft.weights, term2: numberValue(event.target.value, 0) }) })} /></label>
          <label><span className="label-base">বার্ষিক (%)</span><input type="number" min="0" max="100" className="input-base" value={draft.weights.annual} onChange={(event) => setField({ weights: normalizeWeights({ ...draft.weights, annual: numberValue(event.target.value, 0) }) })} /></label>
        </div>
        <p className="mt-2 text-[11px] text-slate-500">
          {clean
            ? 'ওজনের যোগফল ১০০% — সরাসরি ব্যবহৃত হবে।'
            : 'যোগফল ১০০% নয় — সংরক্ষণ করা হবে না। ১ম + ২য় + বার্ষিক = ১০০% করুন (ডিফল্ট ১৫ + ১৫ + ৭০)।'}
        </p>
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between gap-2">
          <p className="text-xs font-bold text-slate-600 dark:text-slate-300">বিষয় তালিকা ও পূর্ণমান</p>
          <button type="button" className="btn-secondary btn-sm" onClick={addSubject} disabled={!canEdit}>
            <Plus size={13} /> নতুন বিষয়
          </button>
        </div>
        <p className="text-[11px] text-slate-500">
          ডেস্কটপে গাঠনিক ও সামষ্টিক পাশাপাশি, মোবাইলে উপর-নিচে দেখাবে। বিষয়ের নাম, পূর্ণমান, গাঠনিক/সামষ্টিক বিভাজন — সবকিছুই পরিবর্তনযোগ্য।
        </p>
        <div className="space-y-2">
          {draft.subjects.map((subject, index) => (
            <div key={subject.id} className="grid gap-2 rounded-xl border border-slate-200 p-2.5 sm:grid-cols-12 dark:border-slate-700">
              <label className="sm:col-span-4"><span className="label-base mb-1">বিষয়ের নাম</span>
                <input
                  className="input-base py-1.5 text-sm"
                  value={subject.name}
                  onChange={(event) => setSubject(subject.id, { name: event.target.value })}
                  aria-label={`বিষয় ${index + 1} এর নাম`}
                />
              </label>
              <label className="sm:col-span-2"><span className="label-base mb-1">ধরন</span>
                <select
                  className="input-base py-1.5 text-xs"
                  value={subject.split ? 'split' : 'single'}
                  onChange={(event) => setSubject(subject.id, { split: event.target.value === 'split' })}
                  aria-label={`${subject.name} এর ধরন`}
                >
                  <option value="split">গাঠনিক + সামষ্টিক</option>
                  <option value="single">একক নম্বর</option>
                </select>
              </label>
              {subject.split ? <>
                <label className="sm:col-span-2"><span className="label-base mb-1">গাঠনিক</span>
                  <input type="number" min="1" className="input-base py-1.5 text-sm" value={subject.formativeFull} onChange={(event) => setSubject(subject.id, { formativeFull: numberValue(event.target.value, 30) })} aria-label={`${subject.name} গাঠনিক পূর্ণমান`} />
                </label>
                <label className="sm:col-span-2"><span className="label-base mb-1">সামষ্টিক</span>
                  <input type="number" min="1" className="input-base py-1.5 text-sm" value={subject.summativeFull} onChange={(event) => setSubject(subject.id, { summativeFull: numberValue(event.target.value, 70) })} aria-label={`${subject.name} সামষ্টিক পূর্ণমান`} />
                </label>
              </> : (
                <label className="sm:col-span-4"><span className="label-base mb-1">পূর্ণমান</span>
                  <input type="number" min="1" className="input-base py-1.5 text-sm" value={subject.formativeFull} onChange={(event) => setSubject(subject.id, { formativeFull: numberValue(event.target.value, 100) })} aria-label={`${subject.name} পূর্ণমান`} />
                </label>
              )}
              <div className="flex items-end gap-1 sm:col-span-2">
                <span className="flex-1 rounded-lg bg-slate-50 px-2 py-2 text-center text-xs font-bold text-slate-600 dark:bg-slate-800 dark:text-slate-300">{toBanglaNumber(subject.fullMarks)}</span>
                <button
                  type="button"
                  className="rounded-lg p-2 text-rose-600 transition hover:bg-rose-50 disabled:opacity-40 dark:hover:bg-rose-950/40"
                  onClick={() => removeSubject(subject.id)}
                  disabled={!canEdit || draft.subjects.length <= 1}
                  aria-label={`${subject.name} মুছে ফেলুন`}
                >
                  <Trash2 size={14} />
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  </Modal>;
}

