import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { clsx } from '../../utils/clsx.js';

const SIZE_MAP = {
  sm: 'max-w-md',
  md: 'max-w-xl',
  lg: 'max-w-3xl',
  xl: 'max-w-5xl',
  full: 'max-w-6xl',
};

/**
 * Accessible modal dialog.
 * - closes on Escape / backdrop click
 * - locks body scroll while open
 * - traps initial focus inside the dialog
 */
export default function Modal({
  open,
  onClose,
  title,
  subtitle,
  icon: Icon,
  size = 'md',
  footer,
  children,
  noPrint = true,
}) {
  const panelRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;

    const handleKeyDown = (event) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose?.();
      }
    };

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    document.addEventListener('keydown', handleKeyDown);

    const timer = setTimeout(() => {
      const focusable = panelRef.current?.querySelector(
        'input:not([disabled]), select:not([disabled]), textarea:not([disabled]), button:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );
      focusable?.focus?.();
    }, 30);

    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener('keydown', handleKeyDown);
      clearTimeout(timer);
    };
  }, [open, onClose]);

  if (!open || typeof document === 'undefined') return null;

  return createPortal(
    <div
      className={clsx(
        'fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-slate-900/50 p-4 backdrop-blur-sm sm:items-center',
        noPrint && 'no-print',
      )}
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose?.();
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={typeof title === 'string' ? title : undefined}
        className={clsx(
          'my-6 w-full animate-fade-in rounded-2xl border border-slate-200 bg-white shadow-float',
          SIZE_MAP[size] ?? SIZE_MAP.md,
        )}
      >
        <header className="flex items-start justify-between gap-3 border-b border-slate-200 px-5 py-4">
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
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1.5 text-slate-400 transition hover:bg-slate-100 hover:text-slate-700"
            aria-label="বন্ধ করুন"
          >
            <X size={18} aria-hidden="true" />
          </button>
        </header>

        <div className="max-h-[70vh] overflow-y-auto px-5 py-4 scroll-thin">{children}</div>

        {footer ? (
          <footer className="flex flex-wrap items-center justify-end gap-2 border-t border-slate-200 bg-slate-50/70 px-5 py-3.5">
            {footer}
          </footer>
        ) : null}
      </div>
    </div>,
    document.body,
  );
}
