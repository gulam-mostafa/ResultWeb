import { useEffect, useState } from 'react';
import { Cloud, CloudOff, Loader2, AlertTriangle, Wifi, WifiOff } from 'lucide-react';
import { useSchoolData } from '../../context/SchoolDataContext.jsx';
import { clsx } from '../../utils/clsx.js';

/**
 * OfflineSyncBadge — offline-first PWA status indicator.
 *
 * Shows exactly one of four states:
 *   synced  → 'সিঙ্ক সম্পন্ন'          (green)
 *   saving  → 'সেভ হচ্ছে…'            (blue, spinner)
 *   offline → 'অফলাইন মোডে সেভ হচ্ছে'  (amber)
 *   error   → 'সেভ ব্যর্থ হয়েছে'       (rose)
 */
const STATE_CONFIG = {
  synced: {
    label: 'রিয়েলটাইম সিঙ্কড',
    Icon: Cloud,
    className: 'border-emerald-200 bg-emerald-50 text-emerald-800',
    dot: 'bg-emerald-500',
  },
  saving: {
    label: 'সেভ হচ্ছে…',
    Icon: Loader2,
    className: 'border-brand-200 bg-brand-50 text-brand-800',
    dot: 'bg-brand-500',
  },
  offline: {
    label: 'অফলাইন ক্যাশ',
    Icon: CloudOff,
    className: 'border-amber-200 bg-amber-50 text-amber-800',
    dot: 'bg-amber-500',
  },
  error: {
    label: 'সেভ ব্যর্থ হয়েছে',
    Icon: AlertTriangle,
    className: 'border-rose-200 bg-rose-50 text-rose-800',
    dot: 'bg-rose-500',
  },
};

export default function OfflineSyncBadge({ compact = false, className }) {
  const { syncState, isOnline } = useSchoolData();
  const [pulse, setPulse] = useState(false);

  // Brief highlight whenever the state flips, so a silent save is still visible.
  useEffect(() => {
    setPulse(true);
    const timer = setTimeout(() => setPulse(false), 700);
    return () => clearTimeout(timer);
  }, [syncState]);

  const config = STATE_CONFIG[syncState] ?? STATE_CONFIG.synced;
  const { Icon } = config;
  const spinning = syncState === 'saving';

  return (
    <div
      className={clsx(
        'inline-flex items-center gap-2 rounded-full border px-2.5 py-1 text-[11px] font-bold transition',
        config.className,
        pulse && 'ring-2 ring-current/20',
        className,
      )}
      role="status"
      aria-live="polite"
      title={isOnline ? 'ইন্টারনেট সংযুক্ত' : 'ইন্টারনেট সংযোগ নেই — ডেটা লোকালি সংরক্ষিত হচ্ছে'}
    >
      <span className="relative flex h-2 w-2 shrink-0">
        <span
          className={clsx(
            'absolute inline-flex h-full w-full rounded-full opacity-60',
            config.dot,
            (spinning || syncState === 'offline') && 'animate-pulse-soft',
          )}
        />
        <span className={clsx('relative inline-flex h-2 w-2 rounded-full', config.dot)} />
      </span>
      <Icon size={12} strokeWidth={2.6} className={spinning ? 'animate-spin' : ''} aria-hidden="true" />
      {!compact ? <span className="whitespace-nowrap">{config.label}</span> : null}
      {compact ? (
        <span className="sr-only">{config.label}</span>
      ) : (
        <span
          className={clsx(
            'ml-1 hidden items-center gap-1 border-l border-current/20 pl-2 sm:inline-flex',
            isOnline ? 'opacity-80' : 'opacity-90',
          )}
        >
          {isOnline ? (
            <Wifi size={11} strokeWidth={2.6} aria-hidden="true" />
          ) : (
            <WifiOff size={11} strokeWidth={2.6} aria-hidden="true" />
          )}
          {isOnline ? 'অনলাইন' : 'অফলাইন'}
        </span>
      )}
    </div>
  );
}
