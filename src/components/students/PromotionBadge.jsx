import { Sparkles } from 'lucide-react';
import { clsx } from '../../utils/clsx.js';
import { promotionBadgeOf } from '../../utils/promotionMeta.js';

/**
 * PromotionBadge — the Bengali "month & year" chip of a freshly promoted pupil
 * (e.g. `নভেম্বর ২০২৬`).
 *
 * The window is THREE MONTHS (90 days) counted from `promotedAt`:
 *  - inside the window the chip is rendered with a soft pulse/glow animation;
 *  - after the window it returns `null`, i.e. the element is completely removed
 *    from the DOM (no hidden node, no placeholder).
 *
 * Only `promotedAt` drives the decision, so the same pupil is shown identically in
 * the roster table and in the promotion modal.
 */
export default function PromotionBadge({ student, className, now }) {
  const badge = promotionBadgeOf(student, now ?? new Date());
  if (!badge?.label) return null;

  return (
    <span
      className={clsx(
        'inline-flex items-center gap-1 rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[10px] font-bold text-emerald-800',
        'animate-fade-in dark:border-emerald-800/60 dark:bg-emerald-900/30 dark:text-emerald-200',
        className,
      )}
      title={`উত্তীর্ণ হয়েছে ${badge.label} — ${badge.days} দিন আগে`}
      data-promoted-at={badge.promotedAt}
      data-promotion-month={badge.monthKey}
    >
      <Sparkles size={10} strokeWidth={2.8} className="animate-pulse-soft" aria-hidden="true" />
      <span className="whitespace-nowrap">{badge.label}</span>
    </span>
  );
}
