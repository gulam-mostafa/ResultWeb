import { AlertTriangle, CheckCircle2, Info } from 'lucide-react';
import { CLASS_LEVELS } from '../../utils/constants.js';
import { toBanglaNumber } from '../../utils/banglaNumberFormatter.js';

const classNameOf = (classId) => CLASS_LEVELS.find((level) => level.id === classId)?.name ?? classId;

/**
 * January promotion warning + auto-promotion notice (বার্ষিক উত্তরণ).
 *
 * - `warning` — the context's `januaryWarning` (or `null`): shown in January of
 *   the target year while classes are still pending, and it stays visible past
 *   31 January while any class is still unpromoted.
 * - `autoNotice` — the context's `autoPromotionNotice` (or `null`): what this
 *   session's automatic run did, so the teacher is never left wondering.
 *
 * Renders nothing when there is nothing to say. Purely informational — no
 * button here changes any data.
 */
export default function PromotionJanuaryWarning({ warning, autoNotice, className = '' }) {
  if (!warning && !autoNotice) return null;

  return (
    <div className={`space-y-3 ${className}`}>
      {warning ? (
        <div
          role="alert"
          className="flex items-start gap-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3"
        >
          <AlertTriangle size={18} className="mt-0.5 shrink-0 text-amber-600" aria-hidden="true" />
          <div className="min-w-0">
            <p className="text-sm font-bold text-amber-900">
              {warning.isAutoDue
                ? `৩১ জানুয়ারি পার হয়ে গেছে — ${toBanglaNumber(warning.pendingCount)}টি শ্রেণির প্রমোশন এখনো বাকি`
                : `জানুয়ারি মাস চলছে — ${toBanglaNumber(warning.pendingCount)}টি শ্রেণির প্রমোশন বাকি আছে`}
            </p>
            <p className="mt-0.5 text-xs leading-relaxed text-amber-800">
              {warning.isAutoDue
                ? `বাকি শ্রেণিগুলোর প্রমোশন আপনাআপনি হবে (পাস → উত্তীর্ণ, ফেল → এই ক্লাসেই থাকুক)। না হলে "বার্ষিক উত্তরণ" থেকে হাতে করে নিন।`
                : `শ্রেণি প্রমোশন করুন, না হলে ${toBanglaNumber(warning.targetYear)} সালের ৩১ জানুয়ারির পর বাকি শ্রেণিগুলোর প্রমোশন আপনাআপনি হয়ে যাবে (পাস → উত্তীর্ণ, ফেল → এই ক্লাসেই থাকুক)।`}
            </p>
            <p className="mt-1.5 text-xs font-semibold text-amber-900">
              বাকি: {warning.pendingClasses.map(classNameOf).join(' · ')}
            </p>
          </div>
        </div>
      ) : null}

      {autoNotice && (autoNotice.done?.length > 0 || autoNotice.failed?.length > 0) ? (
        <div
          role="status"
          className={`flex items-start gap-3 rounded-xl border px-4 py-3 ${
            autoNotice.failed?.length
              ? 'border-amber-200 bg-amber-50'
              : 'border-emerald-200 bg-emerald-50'
          }`}
        >
          {autoNotice.failed?.length ? (
            <Info size={18} className="mt-0.5 shrink-0 text-amber-600" aria-hidden="true" />
          ) : (
            <CheckCircle2 size={18} className="mt-0.5 shrink-0 text-emerald-600" aria-hidden="true" />
          )}
          <div className="min-w-0">
            <p className={`text-sm font-bold ${autoNotice.failed?.length ? 'text-amber-900' : 'text-emerald-900'}`}>
              {autoNotice.failed?.length
                ? `অটো-প্রমোশনে ${toBanglaNumber(autoNotice.done?.length ?? 0)}টি শ্রেণি হয়েছে, ${toBanglaNumber(autoNotice.failed.length)}টি হয়নি`
                : `অটো-প্রমোশন সম্পন্ন — ${toBanglaNumber(autoNotice.done?.length ?? 0)}টি শ্রেণি আপনাআপনি প্রমোট হয়েছে (${toBanglaNumber(autoNotice.targetYear)})`}
            </p>
            {autoNotice.failed?.length ? (
              <p className="mt-0.5 text-xs leading-relaxed text-amber-800">
                হয়নি: {autoNotice.failed.map(classNameOf).join(' · ')} — "বার্ষিক উত্তরণ" থেকে হাতে করে নিন।
              </p>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
