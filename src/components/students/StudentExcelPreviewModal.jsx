import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, CheckCircle2, FileSpreadsheet, Save, ShieldAlert, Users } from 'lucide-react';
import Modal from '../ui/Modal.jsx';
import Spinner from '../ui/Spinner.jsx';
import { Badge } from '../ui/Primitives.jsx';
import { toBanglaNumber } from '../../utils/banglaNumberFormatter.js';
import { getClassName } from '../../utils/constants.js';
import { IMPORT_ROW_STATUS, IMPORT_STATUS_LABELS } from '../../utils/studentImportPlan.js';

/** Tone of each row status badge in the preview table. */
const STATUS_TONE = Object.freeze({
  [IMPORT_ROW_STATUS.NEW]: 'emerald',
  [IMPORT_ROW_STATUS.MATCH]: 'brand',
  [IMPORT_ROW_STATUS.UPDATE]: 'sky',
  [IMPORT_ROW_STATUS.CONFLICT]: 'rose',
});

const FIELD_LABELS = Object.freeze({
  name: 'নাম', fatherName: 'পিতার নাম', motherName: 'মাতার নাম', gender: 'লিঙ্গ',
  birthCertificateNo: 'জন্ম নিবন্ধন', guardianNid: 'অভিভাবক এনআইডি',
  fatherPhone: 'পিতার ফোন', motherPhone: 'মাতার ফোন', admissionYear: 'ভর্তির সাল',
  birthDate: 'জন্ম তারিখ', address: 'ঠিকানা',
});

/**
 * Screen preview (প্রিভিউ) of a parsed 6-sheet student workbook.
 *
 * Nothing is written until the teacher presses সংরক্ষণ. Rows are grouped by
 * **class ➔ শাখা** (tabs), every row carries a status badge, and a duplicate roll is a
 * TWO-STEP warning:
 *
 *   1. Warning #1 — the conflicts are listed and saving is blocked;
 *   2. Warning #2 — an explicit second confirmation; only then is the file written.
 *
 * @param {object} props
 * @param {object} props.plan `buildImportPlan()` result (`groups`, `rows`, `summary`)
 * @param {(options:{force:boolean})=>Promise<object>} props.onSave writer callback
 */
export default function StudentExcelPreviewModal({
  open,
  onClose,
  plan = null,
  onSave,
  saving = false,
}) {
  const [error, setError] = useState('');
  const [classId, setClassId] = useState('');
  const [section, setSection] = useState('');
  /** `null` ➔ nothing shown; `1` ➔ Warning #1; `2` ➔ Warning #2. */
  const [warningStep, setWarningStep] = useState(null);

  const groups = plan?.groups ?? [];
  const summary = plan?.summary ?? { total: 0, new: 0, match: 0, update: 0, conflict: 0 };

  useEffect(() => {
    setWarningStep(null);
    setError('');
    if (!open) return;
    // Default to the first class that actually holds rows.
    const first = groups[0];
    setClassId((current) => (groups.some((group) => group.classId === current) ? current : (first?.classId ?? '')));
  }, [open, plan]);

  const activeGroup = useMemo(
    () => groups.find((group) => group.classId === classId) ?? groups[0] ?? null,
    [groups, classId],
  );
  const sections = activeGroup?.sections ?? [];
  /** The selected শাখা, defaulting to the first one holding a conflict, then the first. */
  const activeSection = useMemo(
    () => sections.find((entry) => entry.section === section)
      ?? sections.find((entry) => entry.rows.some((row) => row.status === IMPORT_ROW_STATUS.CONFLICT))
      ?? sections[0]
      ?? null,
    [sections, section],
  );
  useEffect(() => {
    if (activeSection && activeSection.section !== section) setSection(activeSection.section);
  }, [activeSection, section]);

  const rows = activeSection?.rows ?? [];
  const conflictRows = useMemo(
    () => (plan?.rows ?? []).filter((row) => row.status === IMPORT_ROW_STATUS.CONFLICT),
    [plan],
  );

  /** Saves; without `force` a remaining conflict opens Warning #1 instead of writing. */
  const save = async (force = false) => {
    setError('');
    if (summary.hasConflict && !force) {
      setWarningStep(1);
      return;
    }
    try {
      const result = await onSave?.({ force });
      if (result?.synced === false) {
        setError('ক্লাউডে সংরক্ষণ ব্যর্থ হয়েছে — ইন্টারনেট সংযোগ দেখে আবার চেষ্টা করুন।');
        return;
      }
      setWarningStep(null);
      onClose?.();
    } catch {
      setError('সংরক্ষণ করা যায়নি। আবার চেষ্টা করুন।');
    }
  };

  return <Modal
    open={open}
    onClose={onClose}
    title="শিক্ষার্থী আমদানি প্রিভিউ"
    subtitle="সংরক্ষণের আগে শ্রেণি ও শাখা অনুযায়ী প্রতিটি সারি যাচাই করুন"
    icon={FileSpreadsheet}
    size="full"
    footer={<div className="flex w-full flex-wrap items-center justify-between gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone="emerald"><CheckCircle2 size={11} /> ফাইল যাচাই সম্পন্ন</Badge>
        <Badge tone="brand">{toBanglaNumber(summary.total)} সারি</Badge>
        <Badge tone="emerald">নতুন {toBanglaNumber(summary.new)}</Badge>
        <Badge tone="sky">হালনাগাদ {toBanglaNumber(summary.update)}</Badge>
        <Badge tone="violet">একই শিক্ষার্থী {toBanglaNumber(summary.match)}</Badge>
        {summary.conflict ? <Badge tone="rose"><AlertTriangle size={11} /> দ্বন্দ্ব {toBanglaNumber(summary.conflict)}</Badge> : null}
      </div>
      <div className="flex items-center gap-2">
        <button type="button" className="btn-secondary" onClick={onClose} disabled={saving}>বাতিল</button>
        <button type="button" className="btn-primary" onClick={() => save(false)} disabled={saving || !summary.total}>
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
        এটি শুধু প্রিভিউ — <b>সংরক্ষণ</b> চাপার আগে কোনো তথ্য ডেটাবেজে যাবে না। ৮০% বা তার বেশি মিল থাকলে
        ডেটাবেজের রোলই বজায় থাকবে।
      </p>
      {error ? <p role="alert" className="rounded-lg bg-rose-50 p-2.5 text-xs font-semibold text-rose-800 dark:bg-rose-950/40 dark:text-rose-200">{error}</p> : null}

      {/* ---- Class tabs ---- */}
      <div className="flex flex-wrap gap-1.5" role="tablist" aria-label="শ্রেণি নির্বাচন">
        {groups.map((group) => (
          <button
            key={group.classId}
            type="button"
            role="tab"
            aria-selected={group.classId === activeGroup?.classId}
            className={`rounded-lg px-2.5 py-1 text-xs font-bold transition ${group.classId === activeGroup?.classId
              ? 'bg-brand-600 text-white'
              : 'bg-slate-100 text-slate-700 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-200'}`}
            onClick={() => { setClassId(group.classId); setSection(''); }}
          >
            {getClassName(group.classId)} ({toBanglaNumber(group.rows.length)})
          </button>
        ))}
      </div>

      {/* ---- শাখা tabs of the selected class ---- */}
      <div className="flex flex-wrap gap-1.5" role="tablist" aria-label="শাখা নির্বাচন">
        {sections.map((entry) => (
          <button
            key={entry.section}
            type="button"
            role="tab"
            aria-selected={entry.section === activeSection?.section}
            className={`rounded-lg px-2.5 py-1 text-[11px] font-bold transition ${entry.section === activeSection?.section
              ? 'bg-brand-100 text-brand-800 ring-1 ring-brand-400 dark:bg-brand-900/40 dark:text-brand-200'
              : 'bg-slate-50 text-slate-600 hover:bg-slate-100 dark:bg-slate-800/60 dark:text-slate-300'}`}
            onClick={() => setSection(entry.section)}
          >
            শাখা {entry.section} ({toBanglaNumber(entry.rows.length)})
          </button>
        ))}
      </div>

      <div className="overflow-auto rounded-xl border border-slate-200 dark:border-slate-700">
        <table className="table-base min-w-[980px]">
          <thead>
            <tr>
              <th>সারি</th><th>রোল</th><th>নাম</th><th>পিতা / মাতা</th><th>ফোন</th>
              <th>অবস্থা</th><th>পরিবর্তন / কারণ</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={`${row.classId}-${row.section}-${row.line}-${row.values.name}`}>
                <td className="text-xs text-slate-400">{toBanglaNumber(row.line)}</td>
                <td className="font-bold">
                  {toBanglaNumber(row.resolvedRoll)}
                  {row.existing && row.resolvedRoll !== Number(row.values.roll) ? (
                    <span className="block text-[10px] font-normal text-slate-400 line-through">
                      {toBanglaNumber(row.values.roll)}
                    </span>
                  ) : null}
                </td>
                <td>
                  <span className="font-bold">{row.values.name}</span>
                  {row.similarity ? (
                    <span className="block text-[10px] text-slate-400">
                      ডাটাবেসে: {row.existing?.name ?? '—'}
                    </span>
                  ) : null}
                </td>
                <td className="text-xs">
                  {row.values.fatherName || '—'}
                  <div className="text-[10px] text-slate-400">{row.values.motherName || '—'}</div>
                </td>
                <td className="text-xs">{row.values.fatherPhone || row.values.motherPhone || '—'}</td>
                <td>
                  <Badge tone={STATUS_TONE[row.status] ?? 'slate'}>
                    {IMPORT_STATUS_LABELS[row.status] ?? row.status}
                  </Badge>
                </td>
                <td className="text-[11px] leading-relaxed">
                  {row.message ? <span className="font-semibold text-slate-600 dark:text-slate-300">{row.message}</span> : null}
                  {Object.entries(row.changes ?? {}).length ? (
                    <ul className="mt-0.5 space-y-0.5 text-[10px] text-slate-500">
                      {Object.entries(row.changes).map(([key, change]) => (
                        <li key={key}>
                          {FIELD_LABELS[key] ?? key}: <s>{change.from}</s> ➔ <b>{change.to}</b>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!rows.length ? <p className="py-8 text-center text-sm text-slate-400">এই শাখায় কোনো সারি নেই।</p> : null}
      </div>

      {/* ---- Warning #1: duplicate rolls ---- */}
      {warningStep === 1 ? (
        <div role="alert" className="rounded-xl border-2 border-amber-400 bg-amber-50 p-3 dark:border-amber-600 dark:bg-amber-900/30">
          <p className="text-sm font-extrabold text-amber-900 dark:text-amber-100">সতর্কতা ১ — রোল দ্বন্দ্ব পাওয়া গেছে</p>
          <ul className="mt-1.5 space-y-1 text-[11px] font-semibold leading-relaxed text-amber-900 dark:text-amber-100">
            {conflictRows.slice(0, 8).map((row) => (
              <li key={`${row.classId}-${row.section}-${row.line}`}>
                {getClassName(row.classId)} · শাখা {row.section} · সারি {toBanglaNumber(row.line)} — {row.message}
              </li>
            ))}
            {conflictRows.length > 8 ? <li>…আরও {toBanglaNumber(conflictRows.length - 8)} টি দ্বন্দ্ব আছে।</li> : null}
          </ul>
          <p className="mt-2 text-[11px] text-amber-800 dark:text-amber-200">
            দ্বন্দ্ব থাকা সারিগুলো সংরক্ষণ করলে একই শ্রেণি ও শাখায় একই রোল দুইবার থাকতে পারে। বাতিল করে
            ফাইল সংশোধন করাই উত্তম।
          </p>
          <div className="mt-2 flex flex-wrap justify-end gap-2">
            <button type="button" className="btn-secondary btn-sm" onClick={() => setWarningStep(null)}>বাতিল করে সংশোধন করি</button>
            <button type="button" className="btn-secondary btn-sm border-amber-300 text-amber-800" onClick={() => setWarningStep(2)}>
              তবুও এগিয়ে যাই (সতর্কতা ২)
            </button>
          </div>
        </div>
      ) : null}

      {/* ---- Warning #2: explicit second confirmation ---- */}
      {warningStep === 2 ? (
        <div role="alert" className="rounded-xl border-2 border-rose-400 bg-rose-50 p-3 dark:border-rose-600 dark:bg-rose-950/40">
          <p className="inline-flex items-center gap-1.5 text-sm font-extrabold text-rose-900 dark:text-rose-100">
            <ShieldAlert size={15} aria-hidden="true" /> সতর্কতা ২ — শেষ নিশ্চিতকরণ
          </p>
          <p className="mt-1 text-[11px] font-semibold leading-relaxed text-rose-900 dark:text-rose-100">
            আপনি কি নিশ্চিতভাবে সংরক্ষণ করতে চান? দ্বন্দ্ব থাকা {toBanglaNumber(conflictRows.length)} টি সারি
            ফাইলের রোল নম্বরসহ সংরক্ষিত হবে এবং পরে হাতে সংশোধন করতে হবে।
          </p>
          <div className="mt-2 flex flex-wrap justify-end gap-2">
            <button type="button" className="btn-secondary btn-sm" onClick={() => setWarningStep(null)}>না, বাতিল করুন</button>
            <button type="button" className="btn-primary btn-sm bg-rose-700 hover:bg-rose-800" onClick={() => save(true)} disabled={saving}>
              <Users size={14} /> হ্যাঁ, নিশ্চিত সংরক্ষণ
            </button>
          </div>
        </div>
      ) : null}
    </div>
  </Modal>;
}

