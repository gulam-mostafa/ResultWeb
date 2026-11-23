import { AlertTriangle, Download, FileSpreadsheet, ShieldAlert } from 'lucide-react';
import Modal from '../ui/Modal.jsx';
import Spinner from '../ui/Spinner.jsx';

/**
 * Warning shown BEFORE an Excel template download starts.
 *
 * Nothing is generated or downloaded until the teacher explicitly presses
 * “বুঝেছি ও ডাউনলোড করুন”. The rules listed here are exactly the ones the strict
 * upload validator enforces (sheet name, subject names, column/row structure), so a
 * teacher who reads this popup can never be surprised by a rejected upload.
 */
const RULES = [
  'ফাইলের ফরম্যাট (`.xlsx`) পরিবর্তন করবেন না — CSV/PDF বা অন্য নামে সেভ করবেন না।',
  'শিটের নাম, লাইন/কলাম কাঠামো বা বিষয়ের নাম পরিবর্তন করবেন না।',
  'কোনো কলাম, সারি যোগ, বাদ বা পুনর্বিন্যাস করবেন না; রোল/আইডি/নাম কলামে হাত দেবেন না।',
  'শুধুমাত্র বিষয়ভিত্তিক নম্বরের ঘরগুলো পূরণ করুন (গাঠনিক / সামষ্টিক / একক নম্বর)।',
  'ফাইলটি আপলোড করলে আগে স্ক্রিন প্রিভিউ দেখাবে — সংরক্ষণ চাপলেই কেবল এই বিদ্যালয়ের ডেটাবেজে যাবে।',
];

export default function ExcelDownloadWarningModal({
  open,
  onClose,
  onConfirm,
  downloading = false,
  subtitle = '',
}) {
  return <Modal
    open={open}
    onClose={downloading ? () => {} : onClose}
    title="এক্সেল ডাউনলোডের আগে সতর্কতা"
    subtitle={subtitle || 'ফাইলটি ডাউনলোড করার আগে নিচের নিয়মগুলো পড়ে নিন'}
    icon={FileSpreadsheet}
    size="lg"
    footer={<div className="flex w-full flex-wrap items-center justify-between gap-2">
      <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold text-rose-700 dark:text-rose-300">
        <ShieldAlert size={13} aria-hidden="true" /> কাঠামো বদলালে আপলোড কারণসহ বাতিল হবে
      </span>
      <div className="flex items-center gap-2">
        <button type="button" className="btn-secondary" onClick={onClose} disabled={downloading}>
          বাতিল
        </button>
        <button type="button" className="btn-primary" onClick={onConfirm} disabled={downloading}>
          {downloading
            ? <><Spinner size="xs" tone="white" label="ফাইল তৈরি হচ্ছে…" /> ফাইল তৈরি হচ্ছে…</>
            : <><Download size={15} /> বুঝেছি ও ডাউনলোড করুন</>}
        </button>
      </div>
    </div>}
  >
    <div className="space-y-3">
      <div className="flex items-start gap-2 rounded-xl border border-amber-300 bg-amber-50 p-3 text-xs font-semibold leading-relaxed text-amber-900 dark:border-amber-700 dark:bg-amber-900/30 dark:text-amber-100">
        <AlertTriangle size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
        <p>
          <b>সতর্কতা:</b> ডাউনলোড করা ফাইলের ফরম্যাট, বিষয়ের নাম বা সারি/কলামের কাঠামো
          <b> পরিবর্তন করবেন না</b> — শুধু <b>নম্বরের ঘর</b> পূরণ করুন।
        </p>
      </div>

      <ol className="list-decimal space-y-1.5 pl-5 text-xs leading-relaxed text-slate-700 dark:text-slate-200">
        {RULES.map((rule) => <li key={rule}>{rule}</li>)}
      </ol>

      <p className="rounded-xl bg-slate-50 p-3 text-[11px] leading-relaxed text-slate-600 dark:bg-slate-800 dark:text-slate-300">
        ওয়েবে ইতিমধ্যে দেওয়া নম্বর ফাইলেও থাকবে, তাই অর্ধেক ওয়েবে ও বাকিটা এক্সেলে
        পূরণ করে পুনরায় আপলোড করা যাবে। ডাউনলোড শুরু হবে কেবল নিচের
        <b> “বুঝেছি ও ডাউনলোড করুন”</b> বাটনে চাপ দেওয়ার পরেই।
      </p>
    </div>
  </Modal>;
}
