/**
 * Shared presentational primitives.
 * Keeping these tiny and dependency-free avoids duplication across modules while
 * staying flexible enough for every screen in the platform.
 */

import { clsx } from '../../utils/clsx.js';

/* ------------------------------------------------------------------ *
 * Card
 * ------------------------------------------------------------------ */
export function Card({ as: Tag = 'div', className, padded = true, children, ...rest }) {
  return (
    <Tag className={clsx('card', padded && 'card-pad', className)} {...rest}>
      {children}
    </Tag>
  );
}

export function CardHeader({ title, subtitle, icon: Icon, action, className }) {
  return (
    <div className={clsx('mb-4 flex items-start justify-between gap-3', className)}>
      <div className="flex items-start gap-3">
        {Icon ? (
          <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-brand-50 text-brand-700">
            <Icon size={18} strokeWidth={2.2} aria-hidden="true" />
          </span>
        ) : null}
        <div>
          <h2 className="text-base font-bold leading-tight text-slate-900">{title}</h2>
          {subtitle ? <p className="mt-0.5 text-xs text-slate-500">{subtitle}</p> : null}
        </div>
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Badge
 * ------------------------------------------------------------------ */
const BADGE_TONES = {
  slate: 'bg-slate-100 text-slate-700',
  brand: 'bg-brand-100 text-brand-800',
  emerald: 'bg-emerald-100 text-emerald-800',
  sky: 'bg-sky-100 text-sky-800',
  amber: 'bg-amber-100 text-amber-800',
  orange: 'bg-orange-100 text-orange-800',
  rose: 'bg-rose-100 text-rose-800',
  violet: 'bg-violet-100 text-violet-800',
};

export function Badge({ tone = 'slate', icon: Icon, children, className }) {
  return (
    <span className={clsx('badge', BADGE_TONES[tone] ?? BADGE_TONES.slate, className)}>
      {Icon ? <Icon size={11} strokeWidth={2.5} aria-hidden="true" /> : null}
      {children}
    </span>
  );
}

/* ------------------------------------------------------------------ *
 * Stat tile
 * ------------------------------------------------------------------ */
const STAT_TONES = {
  brand: 'from-brand-600 to-brand-700',
  emerald: 'from-emerald-500 to-emerald-600',
  amber: 'from-amber-500 to-orange-500',
  violet: 'from-violet-500 to-purple-600',
  slate: 'from-slate-600 to-slate-700',
};

export function StatCard({ label, value, hint, icon: Icon, tone = 'brand', className }) {
  return (
    <div className={clsx('card relative overflow-hidden p-4', className)}>
      <div
        className={clsx(
          'absolute inset-x-0 top-0 h-1 bg-gradient-to-r',
          STAT_TONES[tone] ?? STAT_TONES.brand,
        )}
        aria-hidden="true"
      />
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-xs font-semibold text-slate-500">{label}</p>
          <p className="mt-1 text-2xl font-extrabold leading-none text-slate-900 tabular">{value}</p>
          {hint ? <p className="mt-1.5 truncate text-[11px] text-slate-500">{hint}</p> : null}
        </div>
        {Icon ? (
          <span
            className={clsx(
              'flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br text-white shadow-sm',
              STAT_TONES[tone] ?? STAT_TONES.brand,
            )}
          >
            <Icon size={19} strokeWidth={2.2} aria-hidden="true" />
          </span>
        ) : null}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Empty state
 * ------------------------------------------------------------------ */
export function EmptyState({ icon: Icon, title, message, action, className }) {
  return (
    <div className={clsx('flex flex-col items-center justify-center px-6 py-12 text-center', className)}>
      {Icon ? (
        <span className="mb-3 flex h-14 w-14 items-center justify-center rounded-2xl bg-slate-100 text-slate-400">
          <Icon size={26} strokeWidth={1.8} aria-hidden="true" />
        </span>
      ) : null}
      <h3 className="text-sm font-bold text-slate-800">{title}</h3>
      {message ? <p className="mt-1 max-w-sm text-xs leading-relaxed text-slate-500">{message}</p> : null}
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Section heading
 * ------------------------------------------------------------------ */
export function SectionTitle({ children, hint, className }) {
  return (
    <div className={clsx('mb-3 flex items-baseline justify-between gap-2', className)}>
      <h2 className="text-sm font-bold uppercase tracking-wide text-slate-500">{children}</h2>
      {hint ? <span className="text-xs text-slate-400">{hint}</span> : null}
    </div>
  );
}
