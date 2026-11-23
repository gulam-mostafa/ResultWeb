/**
 * Clear, accent-coloured loading spinner.
 *
 * Used wherever the app is loading, calculating, saving or processing (initial data,
 * class/tab switches, mark saving, Excel parsing/saving). The `rainbow` tone adds a
 * multi-colour ring so a longer operation is instantly recognisable as "work in
 * progress" without changing any existing layout.
 */

import { clsx } from '../../utils/clsx.js';

const SIZE_MAP = {
  xs: 'h-3.5 w-3.5 border-[1.5px]',
  sm: 'h-4 w-4 border-2',
  md: 'h-6 w-6 border-2',
  lg: 'h-9 w-9 border-[3px]',
};

const TONE_MAP = {
  brand: 'border-brand-100 border-t-brand-600 border-r-brand-500 dark:border-brand-900 dark:border-t-brand-300 dark:border-r-brand-400',
  emerald: 'border-emerald-100 border-t-emerald-600 border-r-emerald-500 dark:border-emerald-900 dark:border-t-emerald-300 dark:border-r-emerald-400',
  amber: 'border-amber-100 border-t-amber-500 border-r-orange-400 dark:border-amber-900 dark:border-t-amber-300 dark:border-r-orange-300',
  violet: 'border-violet-100 border-t-violet-600 border-r-violet-500 dark:border-violet-900 dark:border-t-violet-300 dark:border-r-violet-400',
  white: 'border-white/30 border-t-white border-r-white/80',
  /** Multi-colour ring for long-running processing (Excel / save). */
  rainbow: 'border-brand-100 border-t-brand-600 border-r-emerald-500 border-b-amber-500 dark:border-brand-900 dark:border-t-brand-300 dark:border-r-emerald-400 dark:border-b-amber-400',
};

export default function Spinner({
  size = 'sm',
  tone = 'brand',
  className,
  label = 'লোড হচ্ছে…',
}) {
  return (
    <span
      role="status"
      aria-live="polite"
      aria-label={label}
      title={label}
      className={clsx(
        'inline-block shrink-0 animate-spin rounded-full border-solid',
        SIZE_MAP[size] ?? SIZE_MAP.sm,
        TONE_MAP[tone] ?? TONE_MAP.brand,
        className,
      )}
    >
      <span className="sr-only">{label}</span>
    </span>
  );
}

/** Inline "busy + message" row used inside cards and banners. */
export function LoadingNote({ message, tone = 'rainbow', size = 'sm', className }) {
  return (
    <span className={clsx('inline-flex items-center gap-2 text-[11px] font-semibold', className)}>
      <Spinner size={size} tone={tone} label={message || 'প্রক্রিয়া চলছে…'} />
      <span>{message}</span>
    </span>
  );
}
