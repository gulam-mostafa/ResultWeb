import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, X } from 'lucide-react';

/**
 * One shared toast (floating notification) system for the whole app.
 *
 * There was no toast/notification system before this: pages only showed inline
 * notices (`excelNotice`, `uploadInfo` …) that sit inside the page and are hidden
 * behind an open modal. A toast floats above everything (including modals), so a
 * "সংরক্ষণ হয়েছে" / "সংরক্ষণ করা যায়নি" confirmation is always visible.
 *
 * Usage:
 *   import { useToast } from '../components/ui/Toast.jsx';
 *   const toast = useToast();
 *   toast.success('সংরক্ষণ হয়েছে');
 *   toast.error('সংরক্ষণ করা যায়নি — আবার চেষ্টা করুন');
 *
 * No new dependency — plain React context + `setTimeout`. Mounted once in
 * `main.jsx` around `<App />`. Toasts auto-dismiss after ~4.5 s and can also be
 * closed by tapping the × button. At most 3 are shown at once.
 */

const ToastContext = createContext(null);

export function useToast() {
  const toast = useContext(ToastContext);
  if (!toast) throw new Error('useToast() must be used inside <ToastProvider>');
  return toast;
}

const TONE = {
  success: {
    Icon: CheckCircle2,
    box: 'border-emerald-200 bg-emerald-50 text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-100',
    iconClass: 'text-emerald-600 dark:text-emerald-300',
    role: 'status',
  },
  error: {
    Icon: AlertTriangle,
    box: 'border-rose-200 bg-rose-50 text-rose-900 dark:border-rose-800 dark:bg-rose-950 dark:text-rose-100',
    iconClass: 'text-rose-600 dark:text-rose-300',
    role: 'alert',
  },
};

const AUTO_DISMISS_MS = 4500;
const MAX_VISIBLE = 3;

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);
  const idRef = useRef(0);
  const timersRef = useRef(new Map());

  const dismiss = useCallback((id) => {
    const timer = timersRef.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timersRef.current.delete(id);
    }
    setToasts((prev) => prev.filter((toast) => toast.id !== id));
  }, []);

  // Never leak a pending auto-dismiss timer if the provider unmounts.
  useEffect(() => () => {
    timersRef.current.forEach((timer) => clearTimeout(timer));
    timersRef.current.clear();
  }, []);

  const push = useCallback((tone, message) => {
    const id = ++idRef.current;
    setToasts((prev) => [...prev.slice(-(MAX_VISIBLE - 1)), { id, tone, message }]);
    timersRef.current.set(id, setTimeout(() => dismiss(id), AUTO_DISMISS_MS));
    return id;
  }, [dismiss]);

  const api = useMemo(() => ({
    success: (message) => push('success', message),
    error: (message) => push('error', message),
  }), [push]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      {/* `z-[100]` sits above the modal overlay (`z-50`); `aria-live` announces it. */}
      <div aria-live="polite" className="pointer-events-none fixed inset-x-0 bottom-4 z-[100] flex flex-col items-center gap-2 px-4">
        {toasts.map((toast) => {
          const tone = TONE[toast.tone] ?? TONE.success;
          const { Icon } = tone;
          return (
            <div
              key={toast.id}
              role={tone.role}
              className={`pointer-events-auto flex w-full max-w-sm items-start gap-2 rounded-xl border px-3 py-2.5 text-sm font-bold shadow-lg ${tone.box}`}
            >
              <Icon size={18} className={`mt-0.5 shrink-0 ${tone.iconClass}`} aria-hidden="true" />
              <span className="min-w-0 flex-1 leading-snug">{toast.message}</span>
              <button
                type="button"
                onClick={() => dismiss(toast.id)}
                aria-label="বিজ্ঞপ্তি বন্ধ করুন"
                className="shrink-0 rounded p-0.5 opacity-60 hover:opacity-100"
              >
                <X size={15} aria-hidden="true" />
              </button>
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
}
