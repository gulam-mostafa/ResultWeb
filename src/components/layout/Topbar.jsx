import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Bell, Calendar, Check, ChevronDown, Loader2, Menu, Plus, Search, X } from 'lucide-react';
import { useAuth } from '../../context/AuthContext.jsx';
import { useSchoolData } from '../../context/SchoolDataContext.jsx';
import { MEMBER_STATUS, ROLES, ROLE_LABELS } from '../../utils/constants.js';
import { formatOfficialBanglaDate, toBanglaNumber } from '../../utils/banglaNumberFormatter.js';
import { academicYearOf } from '../../utils/schoolProfile.js';
import { clsx } from '../../utils/clsx.js';
import { normalizeSessionYear, setMemberStatus, subscribeMembers } from '../../services/database/index.js';
import {
  currentSessionYear,
  defaultSessionYears,
  ensureSession,
  subscribeSessions,
} from '../../services/database/sessionService.js';
import OfflineSyncBadge from './OfflineSyncBadge.jsx';

function usePopover() {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  const close = useCallback(() => setOpen(false), []);
  const toggle = useCallback(() => setOpen((value) => !value), []);

  useEffect(() => {
    if (!open) return undefined;
    const handlePointer = (event) => {
      if (ref.current && !ref.current.contains(event.target)) setOpen(false);
    };
    const handleKey = (event) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', handlePointer);
    document.addEventListener('touchstart', handlePointer);
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('mousedown', handlePointer);
      document.removeEventListener('touchstart', handlePointer);
      document.removeEventListener('keydown', handleKey);
    };
  }, [open]);

  return { open, setOpen, toggle, close, ref };
}

function usePendingTeachers(schoolId, currentUid, enabled) {
  const [members, setMembers] = useState({});

  useEffect(() => {
    if (!enabled || !schoolId) {
      setMembers({});
      return undefined;
    }
    return subscribeMembers(schoolId, setMembers);
  }, [schoolId, enabled]);

  return useMemo(
    () =>
      Object.values(members || {})
        .filter((member) => member?.uid && member.uid !== currentUid && member.status === MEMBER_STATUS.PENDING)
        .sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || ''))),
    [members, currentUid],
  );
}

/**
 * Academic-year selector (বার্ষিক উত্তরণ):
 *
 * - Picking a year only CHANGES THE VIEW (`onView` = `setViewYear`): a past
 *   year shows that year's data read-only, the active year is never moved by
 *   a click here. The button shows the VIEWED year, with a "শুধু দেখা" mark
 *   while a past year is on screen; the list marks the active year ("সক্রিয়")
 *   and the viewed year ("দেখছেন").
 * - The "new year" form is the ONLY path that activates a year: it creates
 *   the session and then calls `onSelect` (ensure + `saveProfile`), exactly
 *   as before. It is hidden while a past year is being viewed — creating a
 *   year is an active-year action.
 */
function AcademicYearSelector({ schoolId, activeYear, viewYear, isReadOnly, canManage, onView, onSelect }) {
  const { open, toggle, close, ref } = usePopover();
  const [sessions, setSessions] = useState({});
  const [creating, setCreating] = useState(false);
  const [newYear, setNewYear] = useState(() => normalizeSessionYear('', currentSessionYear()));
  const [message, setMessage] = useState('');

  useEffect(() => {
    if (!schoolId) {
      setSessions({});
      return undefined;
    }
    return subscribeSessions(schoolId, setSessions);
  }, [schoolId]);

  const years = useMemo(() => {
    const opened = Object.keys(sessions || {}).map((year) => normalizeSessionYear(year)).filter(Boolean);
    const defaults = defaultSessionYears(activeYear || currentSessionYear());
    return [...new Set([...opened, ...defaults])].sort();
  }, [sessions, activeYear]);

  const shownYear = normalizeSessionYear(viewYear) || normalizeSessionYear(activeYear);

  const select = (year) => {
    const normalized = normalizeSessionYear(year);
    if (!normalized) return;
    // View-only: no session is created, no profile is written — the provider
    // re-subscribes to that year's partition and the app goes read-only.
    setMessage('');
    onView?.(normalized);
    close();
  };

  const create = async (event) => {
    event.preventDefault();
    const normalized = normalizeSessionYear(newYear);
    if (!schoolId || !normalized || creating) return;
    setCreating(true);
    setMessage('');
    const result = await ensureSession(schoolId, normalized, { createdBy: 'topbar' });
    setCreating(false);
    if (!result.synced) {
      setMessage('নতুন শিক্ষাবর্ষ শুরু করা যায়নি; আবার চেষ্টা করুন।');
      return;
    }
    const ok = await onSelect(normalized);
    if (ok === false) {
      setMessage('শিক্ষাবর্ষ সক্রিয় করা যায়নি; আবার চেষ্টা করুন।');
      return;
    }
    close();
  };

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={toggle}
        aria-haspopup="menu"
        aria-expanded={open}
        className="flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-bold text-slate-700 transition hover:bg-slate-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/40"
        title="শিক্ষাবর্ষ নির্বাচন"
      >
        <Calendar size={14} className="text-brand-700" aria-hidden="true" />
        <span className="hidden sm:inline">শিক্ষাবর্ষ:</span>
        <span className="tabular text-brand-800">{toBanglaNumber(shownYear || '—')}</span>
        {isReadOnly ? (
          <span className="rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-bold text-amber-800">শুধু দেখা</span>
        ) : null}
        <ChevronDown size={13} className={clsx('text-slate-400 transition', open && 'rotate-180')} aria-hidden="true" />
      </button>

      {open ? (
        <div
          role="menu"
          aria-label="শিক্ষাবর্ষ নির্বাচন"
          className="absolute right-0 z-40 mt-2 w-64 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-float"
        >
          <p className="border-b border-slate-100 bg-slate-50 px-3 py-2 text-[11px] font-bold uppercase tracking-wide text-slate-500">
            শিক্ষাবর্ষ নির্বাচন
          </p>
          {isReadOnly ? (
            <p className="border-b border-amber-100 bg-amber-50 px-3 py-2 text-[11px] font-semibold text-amber-800">
              {toBanglaNumber(shownYear)} সালের তথ্য দেখছেন — এই সালটি লক করা, কিছুই এডিট করা যাবে না। সক্রিয় সালে ফিরতে "সক্রিয়" সালটি বাছুন।
            </p>
          ) : null}
          <ul className="max-h-56 overflow-y-auto py-1 scroll-thin">
            {years.map((year) => {
              const isActive = year === normalizeSessionYear(activeYear);
              const isViewed = year === shownYear;
              return (
                <li key={year}>
                  <button
                    type="button"
                    role="menuitemradio"
                    aria-checked={isViewed}
                    disabled={!canManage && !isActive}
                    onClick={() => select(year)}
                    className={clsx(
                      'flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-xs font-semibold transition',
                      isViewed ? 'bg-brand-50 text-brand-800' : 'text-slate-600 hover:bg-slate-50',
                      !canManage && !isActive && 'cursor-not-allowed opacity-50',
                    )}
                  >
                    <span className="tabular">{toBanglaNumber(year)}</span>
                    {isActive ? (
                      <span className="badge bg-brand-100 text-brand-800">সক্রিয়</span>
                    ) : isViewed ? (
                      <span className="badge bg-amber-100 text-amber-800">দেখছেন</span>
                    ) : (
                      <span className="text-[10px] font-medium text-slate-400">নির্বাচন করুন</span>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>

          {canManage && !isReadOnly ? (
            <form onSubmit={create} className="space-y-2 border-t border-slate-100 bg-slate-50/70 p-2.5">
              <label className="block">
                <span className="label-base">নতুন বছরের বছর লিখুন</span>
                <input
                  type="number"
                  inputMode="numeric"
                  min="1991"
                  max="2100"
                  step="1"
                  value={newYear}
                  onChange={(event) => setNewYear(event.target.value)}
                  className="input-base py-1.5 text-xs"
                  aria-label="নতুন শিক্ষাবর্ষ"
                />
              </label>
              <button type="submit" disabled={creating} className="btn-primary btn-sm w-full">
                {creating ? <Loader2 size={13} className="animate-spin" /> : <Plus size={13} />}
                {creating ? 'শুরু হচ্ছে…' : '+ নতুন শিক্ষাবর্ষ শুরু করুন'}
              </button>
              {message ? (
                <p role="alert" className="text-[11px] font-semibold text-rose-600">
                  {message}
                </p>
              ) : null}
            </form>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function AdminNotificationBell({ schoolId, user, pending, noticeCount }) {
  const { open, toggle, close, ref } = usePopover();
  const [busyUid, setBusyUid] = useState('');
  const [message, setMessage] = useState('');

  const pendingCount = pending.length;
  const noticeCountValue = Number(noticeCount || 0);

  const act = async (member, status) => {
    setBusyUid(member.uid);
    setMessage('');
    const result = await setMemberStatus(schoolId, member.uid, status, user);
    setBusyUid('');
    if (!result?.synced) {
      setMessage('পরিবর্তন সংরক্ষণ করা যায়নি; আবার চেষ্টা করুন।');
      return;
    }
    setMessage(status === MEMBER_STATUS.APPROVED ? 'শিক্ষক অনুমোদিত হয়েছেন।' : 'আবেদন বাতিল করা হয়েছে।');
  };

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={toggle}
        aria-haspopup="dialog"
        aria-expanded={open}
        className="relative rounded-lg border border-slate-200 p-2 text-slate-500 transition hover:bg-slate-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/40"
        aria-label={`অ্যাডমিন নোটিফিকেশন — ${toBanglaNumber(pendingCount)}টি অপেক্ষমাণ শিক্ষক আবেদন`}
        title={`${toBanglaNumber(pendingCount)}টি অপেক্ষমাণ শিক্ষক আবেদন · ${toBanglaNumber(noticeCountValue)}টি নোটিশ`}
      >
        <Bell size={16} aria-hidden="true" />
        {pendingCount > 0 ? (
          <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-rose-500 px-1 text-[9px] font-bold text-white">
            {toBanglaNumber(pendingCount)}
          </span>
        ) : null}
      </button>

      {open ? (
        <div
          role="dialog"
          aria-label="অ্যাডমিন নোটিফিকেশন"
          className="absolute right-0 z-40 mt-2 w-[min(22rem,calc(100vw-1.5rem))] overflow-hidden rounded-xl border border-slate-200 bg-white shadow-float"
        >
          <div className="flex items-center justify-between gap-2 border-b border-slate-100 bg-slate-50 px-3 py-2">
            <p className="text-[11px] font-bold uppercase tracking-wide text-slate-500">অপেক্ষমাণ শিক্ষক আবেদন</p>
            <span className="badge bg-rose-100 text-rose-700">{toBanglaNumber(pendingCount)}</span>
          </div>

          {message ? (
            <p
              role="status"
              className={clsx(
                'border-b px-3 py-2 text-[11px] font-semibold',
                message.includes('যায়নি')
                  ? 'border-rose-100 bg-rose-50 text-rose-700'
                  : 'border-emerald-100 bg-emerald-50 text-emerald-700',
              )}
            >
              {message}
            </p>
          ) : null}

          <div className="max-h-72 overflow-y-auto scroll-thin">
            {pendingCount === 0 ? (
              <p className="px-3 py-6 text-center text-xs text-slate-500">কোনো অপেক্ষমাণ শিক্ষক আবেদন নেই।</p>
            ) : (
              <ul className="divide-y divide-slate-100">
                {pending.map((member) => {
                  const busy = busyUid === member.uid;
                  return (
                    <li key={member.uid} className="px-3 py-2.5">
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <p className="truncate text-xs font-bold text-slate-900">
                            {member.name || 'নামহীন শিক্ষক'}
                          </p>
                          <p className="truncate text-[10px] text-slate-500">
                            {member.designation || 'শিক্ষক'} · {member.email || member.phone || member.uid}
                          </p>
                        </div>
                        <div className="flex shrink-0 gap-1">
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => act(member, MEMBER_STATUS.APPROVED)}
                            className="inline-flex items-center gap-1 rounded-lg bg-emerald-600 px-2 py-1 text-[10px] font-bold text-white transition hover:bg-emerald-700 disabled:opacity-50"
                            title="অনুমোদন দিন"
                          >
                            {busy ? <Loader2 size={11} className="animate-spin" /> : <Check size={11} />}
                            অনুমোদন
                          </button>
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => act(member, MEMBER_STATUS.REJECTED)}
                            className="inline-flex items-center gap-1 rounded-lg bg-rose-600 px-2 py-1 text-[10px] font-bold text-white transition hover:bg-rose-700 disabled:opacity-50"
                            title="বাতিল করুন"
                          >
                            <X size={11} />
                            বাতিল
                          </button>
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          <Link
            to="/teacher-management"
            onClick={close}
            className="block border-t border-slate-100 bg-slate-50 px-3 py-2 text-center text-[11px] font-bold text-brand-800 transition hover:bg-brand-50"
          >
            শিক্ষক ম্যানেজমেন্ট প্যানেল
          </Link>
        </div>
      ) : null}
    </div>
  );
}

export default function Topbar({ onMenuClick, title, subtitle }) {
  const { user, role, canApproveTeachers } = useAuth();
  const { notices, schoolProfile, saveProfile, viewYear, setViewYear, isReadOnly } = useSchoolData();
  const navigate = useNavigate();
  /** Student search — Enter jumps to the roster with that query applied. */
  const [search, setSearch] = useState('');

  const schoolId = user?.schoolId || '';
  const isSuperAdmin = role === ROLES.SUPER_ADMIN;
  const isSchoolAdmin = role === ROLES.SCHOOL_ADMIN;
  const canManageYear = isSuperAdmin || isSchoolAdmin;
  const activeYear = normalizeSessionYear(academicYearOf(schoolProfile), currentSessionYear());
  const canSeeTeacherNotifications = Boolean(canApproveTeachers || (isSchoolAdmin && user?.status === MEMBER_STATUS.APPROVED));
  const pending = usePendingTeachers(schoolId, user?.uid, canSeeTeacherNotifications);

  const today = formatOfficialBanglaDate(new Date());

  /**
   * Activates a year (new-year form only): creates the session, then moves the
   * profile's academic year. Picking a year in the list does NOT call this —
   * that only changes the view (`setViewYear`).
   */
  const changeYear = async (year) => {
    if (!canManageYear) return false;
    const sessionResult = await ensureSession(schoolId, year, { activatedBy: user?.uid || '' });
    const profileResult = await saveProfile({ academicYear: year });
    return Boolean(sessionResult?.synced && profileResult?.synced);
  };

  return (
    <header className="app-topbar sticky top-0 z-20 border-b border-slate-200 bg-white/90 backdrop-blur">
      <div className="flex items-center gap-3 px-4 py-3 sm:px-6">
        <button
          type="button"
          onClick={onMenuClick}
          className="rounded-lg border border-slate-200 p-2 text-slate-600 transition hover:bg-slate-50 lg:hidden"
          aria-label="মেনু খুলুন"
        >
          <Menu size={18} aria-hidden="true" />
        </button>

        <div className="min-w-0 flex-1">
          <h1 className="truncate text-base font-extrabold leading-tight text-slate-900 sm:text-lg">
            {title ?? 'ড্যাশবোর্ড'}
          </h1>
          <p className="mt-0.5 flex items-center gap-1.5 truncate text-[11px] text-slate-500">
            <Calendar size={11} aria-hidden="true" />
            {subtitle ?? today}
          </p>
        </div>

        <div className="hidden items-center gap-2 md:flex">
          <OfflineSyncBadge />
          <form
            className="relative"
            role="search"
            onSubmit={(event) => {
              event.preventDefault();
              const query = search.trim();
              // The roster reads `?q=` — an empty query simply opens the roster.
              navigate(query ? `/students?q=${encodeURIComponent(query)}` : '/students');
            }}
          >
            <Search
              size={14}
              className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400"
              aria-hidden="true"
            />
            <input
              type="search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="শিক্ষার্থী খুঁজুন…"
              className="w-44 rounded-lg border border-slate-200 bg-slate-50 py-1.5 pl-8 pr-2 text-xs text-slate-700 placeholder:text-slate-400 focus:border-brand-400 focus:bg-white focus:outline-none focus:ring-2 focus:ring-brand-500/20 xl:w-56"
              aria-label="শিক্ষার্থী অনুসন্ধান"
            />
          </form>
          <AcademicYearSelector
            schoolId={schoolId}
            activeYear={activeYear}
            viewYear={viewYear}
            isReadOnly={isReadOnly}
            canManage={canManageYear}
            onView={setViewYear}
            onSelect={changeYear}
          />
          {canSeeTeacherNotifications ? (
            <AdminNotificationBell
              schoolId={schoolId}
              user={user}
              pending={pending}
              noticeCount={notices.length}
            />
          ) : null}
        </div>

        <div className="flex items-center gap-2 border-l border-slate-200 pl-2 sm:pl-3">
          <div className="hidden text-right sm:block">
            <p className="max-w-[10rem] truncate text-xs font-bold text-slate-900">
              {user?.name ?? 'অতিথি'}
            </p>
            <p className="text-[10px] text-slate-500">{ROLE_LABELS[role] ?? '—'}</p>
          </div>
          <span className="flex h-9 w-9 items-center justify-center rounded-full bg-brand-700 text-sm font-bold text-white">
            {user?.avatarInitial ?? user?.name?.slice(0, 1) ?? 'শ'}
          </span>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2 border-t border-slate-100 px-4 py-2 md:hidden">
        <OfflineSyncBadge />
        <AcademicYearSelector
          schoolId={schoolId}
          activeYear={activeYear}
          viewYear={viewYear}
          isReadOnly={isReadOnly}
          canManage={canManageYear}
          onView={setViewYear}
          onSelect={changeYear}
        />
        {canSeeTeacherNotifications ? (
          <AdminNotificationBell
            schoolId={schoolId}
            user={user}
            pending={pending}
            noticeCount={notices.length}
          />
        ) : null}
      </div>
    </header>
  );
}