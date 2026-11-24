import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, RefreshCw, Shuffle, Sparkles } from 'lucide-react';
import Modal from '../ui/Modal.jsx';
import { toBanglaNumber, formatBanglaDecimal } from '../../utils/banglaNumberFormatter.js';
import {
  buildComponentProfile,
  generateRemarkOptions,
} from '../../utils/remarkGenerator.js';

const STRENGTH_LABELS = {
  formative: 'গাঠনিক মূল্যায়নে এগিয়ে',
  summative: 'সামষ্টিক মূল্যায়নে এগিয়ে',
  balanced: 'গাঠনিক ও সামষ্টিক সমান',
  partial: 'আংশিক মূল্যায়ন',
};

/**
 * শিক্ষক মন্তব্য — the editable, click-to-cycle remark editor.
 *
 * Opened by clicking a pupil's NAME on the Results page. It shows the pupil's
 * measurable গাঠনিক / সামষ্টিক profile, offers several DIFFERENT generated remark
 * drafts, lets the teacher click "নতুন মন্তব্য চয়েজ করুন" to cycle through them,
 * regenerate from scratch, or simply type a custom remark, and then saves the chosen
 * text to this school's own RTDB path through `onSave` (i.e. `setRemark`).
 */
export default function AIRemarkModal({
  open,
  onClose,
  student,
  result,
  marks = {},
  config = null,
  initialRemark = '',
  onSave,
}) {
  const profile = useMemo(
    () => buildComponentProfile(marks?.[student?.id] ?? {}, config),
    [marks, student?.id, config],
  );
  const options = useMemo(
    () => generateRemarkOptions({ student, result, profile }, { count: 6 }),
    [student, result, profile],
  );

  const [remark, setRemark] = useState(initialRemark || options[0] || '');
  const [saved, setSaved] = useState(false);
  const [edited, setEdited] = useState(false);
  /** Bumped by "আবার তৈরি করুন" so the phrase banks rotate into a NEW draft set. */
  const [variant, setVariant] = useState(0);
  const [drafts, setDrafts] = useState(options);
  const cycleIndex = useRef(0);

  // Re-opening on another pupil always starts from THAT pupil's saved remark.
  useEffect(() => {
    if (!open) return;
    cycleIndex.current = 0;
    setVariant(0);
    setDrafts(options);
    setEdited(false);
    setSaved(false);
    setRemark(initialRemark || options[0] || '');
  }, [open, student?.id, initialRemark, options]);

  /** Click-to-cycle: each click picks the NEXT distinct generated remark. */
  const cycleRemark = () => {
    if (!drafts.length) return;
    cycleIndex.current = (cycleIndex.current + 1) % drafts.length;
    setRemark(drafts[cycleIndex.current]);
    setEdited(false);
    setSaved(false);
  };

  /** "আবার তৈরি করুন" — drafts a fresh set of sentences from the live performance figures. */
  const regenerate = () => {
    const nextVariant = variant + 1;
    const next = generateRemarkOptions(
      { student, result, profile },
      { count: 6, variant: nextVariant },
    );
    setVariant(nextVariant);
    setDrafts(next);
    cycleIndex.current = 0;
    setRemark(next[0] ?? '');
    setEdited(false);
    setSaved(false);
  };

  const store = () => {
    onSave?.(remark);
    setSaved(true);
    setTimeout(() => setSaved(false), 1800);
  };

  const hasResult = Boolean(result?.hasAnyMark);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="শিক্ষক মন্তব্য"
      subtitle={`${student?.name ?? ''} · গাঠনিক ও সামষ্টিক মূল্যায়ন বিশ্লেষণ করে প্রস্তাবিত`}
      icon={Sparkles}
      size="lg"
      footer={(
        <div className="flex w-full flex-wrap items-center justify-between gap-2">
          <button type="button" className="btn-secondary btn-sm" onClick={cycleRemark} disabled={!drafts.length}>
            <Shuffle size={14} /> নতুন মন্তব্য চয়েজ করুন
          </button>
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" className="btn-secondary" onClick={onClose}>বাতিল</button>
            <button type="button" className="btn-primary" onClick={store} disabled={!remark.trim()}>
              <Check size={15} /> মন্তব্য সংরক্ষণ
            </button>
          </div>
        </div>
      )}
    >
      <div className="space-y-4">
        {/* Measurable profile the draft is based on */}
        <section className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
          <div className="rounded-lg bg-slate-50 p-3 dark:bg-slate-800">
            <p className="text-[11px] text-slate-500">মোট নম্বর</p>
            <p className="mt-0.5 text-sm font-bold">{toBanglaNumber(result?.totalMarks ?? 0)}</p>
          </div>
          <div className="rounded-lg bg-slate-50 p-3 dark:bg-slate-800">
            <p className="text-[11px] text-slate-500">GPA · গ্রেড</p>
            <p className="mt-0.5 text-sm font-bold">
              {result?.gpa == null ? '—' : formatBanglaDecimal(result.gpa, 2)} · {result?.grade ?? '—'}
            </p>
          </div>
          <div className="rounded-lg bg-sky-50 p-3 dark:bg-sky-950/40">
            <p className="text-[11px] text-sky-700 dark:text-sky-300">গাঠনিক মূল্যায়ন</p>
            <p className="mt-0.5 text-sm font-bold text-sky-900 dark:text-sky-100">
              {profile.formativePercent == null ? '—' : `${formatBanglaDecimal(profile.formativePercent, 1)}%`}
            </p>
          </div>
          <div className="rounded-lg bg-violet-50 p-3 dark:bg-violet-950/40">
            <p className="text-[11px] text-violet-700 dark:text-violet-300">সামষ্টিক মূল্যায়ন</p>
            <p className="mt-0.5 text-sm font-bold text-violet-900 dark:text-violet-100">
              {profile.summativePercent == null ? '—' : `${formatBanglaDecimal(profile.summativePercent, 1)}%`}
            </p>
          </div>
        </section>
        <p className="rounded-lg bg-brand-50 px-3 py-2 text-[11px] font-semibold text-brand-800 dark:bg-brand-900/30 dark:text-brand-200">
          বিশ্লেষণ: {STRENGTH_LABELS[profile.stronger] ?? STRENGTH_LABELS.partial}
          {hasResult ? ` · ${result?.isPass ? 'উত্তীর্ণ' : 'অনুত্তীর্ণ'}` : ' · কোনো নম্বর এন্ট্রি হয়নি'}
        </p>

        <label className="block">
          <span className="label-base">মন্তব্য (সম্পাদনাযোগ্য)</span>
          <textarea
            className="input-base min-h-32"
            value={remark}
            onChange={(event) => {
              setRemark(event.target.value);
              setEdited(true);
              setSaved(false);
            }}
            placeholder="শিক্ষার্থীর জন্য গঠনমূলক মন্তব্য লিখুন"
          />
          <span className="mt-1 block text-[11px] text-slate-400">
            {edited
              ? 'নিজের লেখা মন্তব্য — সংরক্ষণ চাপলেই এই বিদ্যালয়ের ডেটাবেজে যাবে।'
              : 'প্রস্তাবিত মন্তব্য — পছন্দ না হলে নিচের যেকোনোটি বেছে নিন।'}
          </span>
        </label>

        <section>
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-xs font-bold text-slate-600 dark:text-slate-300">
              মন্তব্য চয়েস ({toBanglaNumber(drafts.length)}টি ভিন্ন প্রস্তাব)
            </h3>
            <button type="button" className="btn-secondary btn-sm" onClick={regenerate}>
              <RefreshCw size={13} /> আবার তৈরি করুন
            </button>
          </div>
          <ul className="space-y-2">
            {drafts.map((option, index) => {
              const active = option === remark;
              return (
                <li key={`${index}-${option.slice(0, 12)}`}>
                  <button
                    type="button"
                    onClick={() => {
                      cycleIndex.current = index;
                      setRemark(option);
                      setEdited(false);
                      setSaved(false);
                    }}
                    className={`w-full rounded-xl border p-3 text-left text-[12px] leading-relaxed transition ${
                      active
                        ? 'border-brand-500 bg-brand-50 text-brand-900 dark:border-brand-400 dark:bg-brand-900/30 dark:text-brand-100'
                        : 'border-slate-200 bg-white text-slate-600 hover:border-brand-300 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300 dark:hover:bg-slate-800'
                    }`}
                  >
                    <span className="mb-1 inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wide opacity-70">
                      প্রস্তাব {toBanglaNumber(index + 1)}
                      {active ? <Check size={11} aria-hidden="true" /> : null}
                    </span>
                    <span className="block">{option}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        </section>

        {saved ? (
          <p role="status" className="rounded-lg bg-emerald-50 p-2.5 text-[11px] font-semibold text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-200">
            মন্তব্য সংরক্ষণ হয়েছে — মার্কশিটে স্বয়ংক্রিয়ভাবে যুক্ত হবে।
          </p>
        ) : null}
      </div>
    </Modal>
  );
}

