import { useEffect, useState } from 'react';
import { NavLink } from 'react-router-dom';
import {
  LayoutDashboard,
  Users,
  ClipboardList,
  CalendarCheck,
  FileText,
  GraduationCap,
  Settings,
  Building2,
  ShieldCheck,
  UserCog,
  School as SchoolIcon,
  ChevronRight,
  ArrowUpRight,
} from 'lucide-react';
import { useAuth } from '../../context/AuthContext.jsx';
import { useSchoolData } from '../../context/SchoolDataContext.jsx';
import { MEMBER_STATUS, ROLE_LABELS } from '../../utils/constants.js';
import { toBanglaNumber } from '../../utils/banglaNumberFormatter.js';
import { schoolDisplayName, schoolLogoText, locationSubtitle, academicYearOf } from '../../utils/schoolProfile.js';
import { clsx } from '../../utils/clsx.js';
import { subscribeMembers } from '../../services/database/index.js';

/** Navigation entries, each declaratively tied to the roles allowed to see them. */
const NAV_ITEMS = [
  {
    to: '/dashboard',
    label: 'ড্যাশবোর্ড',
    icon: LayoutDashboard,
    roles: ['super_admin', 'school_admin'],
    hint: 'সারসংক্ষেপ ও পরিসংখ্যান',
  },
  {
    to: '/students',
    label: 'শিক্ষার্থী',
    icon: Users,
    roles: ['super_admin', 'school_admin'],
    hint: 'ভর্তি, তালিকা ও শ্রেণি উত্তরণ',
  },
  {
    to: '/results',
    label: 'রেজাল্ট',
    icon: ClipboardList,
    roles: ['super_admin', 'school_admin'],
    hint: 'মার্কস এন্ট্রি ও গ্রেডিং',
    // Same annual-promotion entry point as the Students page, opened straight from
    // the Results section (`/results?promote=1`).
    promotion: { to: '/results?promote=1', label: 'বার্ষিক শ্রেণি উত্তরণ' },
  },
  {
    to: '/attendance',
    label: 'উপস্থিতি',
    icon: CalendarCheck,
    roles: ['super_admin', 'school_admin'],
    hint: 'দৈনিক উপস্থিতি',
  },
  {
    to: '/documents',
    label: 'ডকুমেন্টস',
    icon: FileText,
    roles: ['super_admin', 'school_admin'],
    hint: 'মার্কশিট ও সনদ',
  },
  {
    to: '/my-result',
    label: 'আমার ফলাফল',
    icon: GraduationCap,
    roles: ['student'],
    hint: 'প্রগ্রেস ও সনদ',
  },
  {
    to: '/schools',
    label: 'স্কুল ডিরেক্টরি',
    icon: Building2,
    roles: ['super_admin'],
    hint: 'সিস্টেম নিয়ন্ত্রণ',
  },
  {
    to: '/school-profile',
    label: 'বিদ্যালয় প্রোফাইল',
    icon: SchoolIcon,
    roles: ['school_admin'],
    hint: 'বিদ্যালয়ের তথ্য হালনাগাদ',
  },
  {
    to: '/teacher-management',
    label: 'শিক্ষক ম্যানেজমেন্ট',
    icon: UserCog,
    roles: ['school_admin'],
    approversOnly: true,
    hint: 'আবেদন অনুমোদন ও ক্ষমতা ব্যবস্থাপনা',
  },
  {
    to: '/settings',
    label: 'সেটিংস',
    icon: Settings,
    roles: ['super_admin', 'school_admin', 'student'],
    hint: 'প্রোফাইল ও ডেটা',
  },
];

export default function Sidebar({ mobileOpen = false, onNavigate }) {
  const { role, user, signOut, canApproveTeachers } = useAuth();
  const { schoolProfile } = useSchoolData();
  const [pendingCount, setPendingCount] = useState(0);

  // Live pending-application count so approvers see work waiting without opening the page.
  useEffect(() => {
    if (!user?.schoolId || !canApproveTeachers) {
      setPendingCount(0);
      return undefined;
    }
    return subscribeMembers(user.schoolId, (members) => {
      setPendingCount(
        Object.values(members || {}).filter(
          (member) => member?.uid !== user.uid && member?.status === MEMBER_STATUS.PENDING,
        ).length,
      );
    });
  }, [user?.schoolId, user?.uid, canApproveTeachers]);

  const visibleItems = NAV_ITEMS.filter((item) => item.roles.includes(role) && (!item.approversOnly || canApproveTeachers));

  return (
    <>
      {mobileOpen ? (
        <div
          className="fixed inset-0 z-30 bg-slate-900/40 backdrop-blur-sm lg:hidden"
          onClick={onNavigate}
          aria-hidden="true"
        />
      ) : null}

      <aside
        className={clsx(
          'app-sidebar fixed inset-y-0 left-0 z-40 flex w-72 flex-col border-r border-slate-200 bg-white transition-transform duration-200 lg:static lg:translate-x-0',
          mobileOpen ? 'translate-x-0 shadow-float' : '-translate-x-full',
        )}
      >
        {/* Brand */}
        <div className="flex items-center gap-3 border-b border-slate-200 px-4 py-4">
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-brand-700 to-brand-900 text-lg font-extrabold text-white shadow-sm">
            {schoolLogoText(schoolProfile)}
          </div>
          <div className="min-w-0">
            <p className="truncate text-sm font-extrabold leading-tight text-slate-900">
              {schoolDisplayName(schoolProfile)}
            </p>
            <p className="mt-0.5 truncate text-[11px] text-slate-500">
              {locationSubtitle(schoolProfile) || 'বিদ্যালয় কর্মস্থল'}
            </p>
          </div>
        </div>

        {/* School meta chip */}
        <div className="mx-3 mt-3 rounded-xl border border-brand-100 bg-brand-50/70 px-3 py-2">
          <div className="flex items-center justify-between gap-2">
            <div className="min-w-0">
              <p className="text-[10px] font-bold uppercase tracking-wide text-brand-700">ইএমআইএস</p>
              <p className="truncate text-xs font-bold text-brand-900 tabular">
                {schoolProfile?.emisCode || '—'}
              </p>
            </div>
            {schoolProfile?.verified === true ? (
              <span className="badge bg-emerald-100 text-emerald-800">
                <ShieldCheck size={11} strokeWidth={2.5} aria-hidden="true" />
                যাচাইকৃত
              </span>
            ) : (
              <span className="badge bg-amber-100 text-amber-800" title="প্রতিষ্ঠান এখনো যাচাই হয়নি">
                <ShieldCheck size={11} strokeWidth={2.5} aria-hidden="true" />
                যাচাই বাকি
              </span>
            )}
          </div>
          <p className="mt-1.5 border-t border-brand-100 pt-1.5 text-[10px] font-semibold text-brand-800">
            শিক্ষাবর্ষ: {academicYearOf(schoolProfile)}
          </p>
        </div>

        {/* Nav */}
        <nav className="mt-3 flex-1 space-y-1 overflow-y-auto px-3 pb-4 scroll-thin" aria-label="প্রধান মেনু">
          {visibleItems.map((item) => {
            const Icon = item.icon;
            return (
              <div key={item.to}>
              <NavLink
                to={item.to}
                onClick={onNavigate}
                className={({ isActive }) =>
                  clsx(
                    'group flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-semibold transition',
                    isActive
                      ? 'bg-brand-700 text-white shadow-sm'
                      : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900',
                  )
                }
              >
                {({ isActive }) => (
                  <>
                    <Icon
                      size={18}
                      strokeWidth={2.2}
                      className={isActive ? 'text-white' : 'text-slate-400 group-hover:text-slate-600'}
                      aria-hidden="true"
                    />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-1.5">
                        <span className="truncate">{item.label}</span>
                        {item.approversOnly && pendingCount > 0 ? (
                          <span
                            className={clsx(
                              'inline-flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[9px] font-bold',
                              isActive ? 'bg-white text-brand-800' : 'bg-rose-500 text-white',
                            )}
                            title={`${toBanglaNumber(pendingCount)}টি অপেক্ষমাণ শিক্ষক আবেদন`}
                          >
                            {toBanglaNumber(pendingCount)}
                          </span>
                        ) : null}
                      </span>
                      <span
                        className={clsx(
                          'block truncate text-[10px] font-medium',
                          isActive ? 'text-brand-100' : 'text-slate-400',
                        )}
                      >
                        {item.hint}
                      </span>
                    </span>
                    <ChevronRight
                      size={14}
                      className={isActive ? 'text-brand-200' : 'text-slate-300'}
                      aria-hidden="true"
                    />
                  </>
                )}
              </NavLink>
              {item.promotion ? (
                <NavLink
                  to={item.promotion.to}
                  onClick={onNavigate}
                  className={({ isActive }) =>
                    clsx(
                      'ml-6 mt-0.5 flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[11px] font-bold transition',
                      isActive
                        ? 'bg-brand-50 text-brand-800'
                        : 'text-slate-500 hover:bg-slate-50 hover:text-slate-800',
                    )
                  }
                >
                  <ArrowUpRight size={12} strokeWidth={2.6} aria-hidden="true" />
                  <span className="truncate">{item.promotion.label}</span>
                </NavLink>
              ) : null}
              </div>
            );
          })}
        </nav>

        {/* User card */}
        <div className="border-t border-slate-200 p-3">
          <div className="flex items-center gap-2.5 rounded-xl bg-slate-50 px-2.5 py-2">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-brand-700 text-sm font-bold text-white">
              {user?.avatarInitial ?? '?'}
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-xs font-bold text-slate-900">{user?.name ?? 'অতিথি'}</p>
              <p className="truncate text-[10px] text-slate-500">
                {ROLE_LABELS[role] ?? 'ভূমিকা নেই'}
              </p>
            </div>
            <button
              type="button"
              onClick={signOut}
              className="rounded-lg px-2 py-1 text-[11px] font-bold text-rose-600 transition hover:bg-rose-50"
            >
              লগআউট
            </button>
          </div>
        </div>
      </aside>
    </>
  );
}

