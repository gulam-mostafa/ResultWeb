import { useState } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import { useSchoolData } from '../../context/SchoolDataContext.jsx';
import { academicYearOf, fullAddress, schoolDisplayName } from '../../utils/schoolProfile.js';
import { lockedViewClass, yearLockBannerText } from '../../services/database/promotionService.js';
import Sidebar from './Sidebar.jsx';
import Topbar from './Topbar.jsx';

/**
 * AppLayout — the authenticated shell (sidebar + topbar + routed content).
 * Print rules hide sidebar/topbar so only `.print-sheet` reaches paper.
 */
/**
 * Page titles, exactly as the sidebar labels them (Sidebar.jsx `NAV_ITEMS`).
 * The header used to say "ড্যাশবোর্ড" on every page because AppLayout never
 * received a title and Topbar falls back to it. An explicit `title` prop still
 * wins (per-page override); otherwise the route decides; 'ড্যাশবোর্ড' remains
 * only as the last-resort fallback for an unknown path.
 */
const ROUTE_TITLES = Object.freeze({
  '/dashboard': 'ড্যাশবোর্ড',
  '/students': 'শিক্ষার্থী',
  '/results': 'রেজাল্ট',
  '/attendance': 'উপস্থিতি',
  '/documents': 'ডকুমেন্টস',
  '/my-result': 'আমার ফলাফল',
  '/schools': 'স্কুল ডিরেক্টরি',
  '/school-profile': 'বিদ্যালয় প্রোফাইল',
  '/teacher-management': 'শিক্ষক ম্যানেজমেন্ট',
  '/settings': 'সেটিংস',
});

export default function AppLayout({ title, subtitle }) {
  const [mobileOpen, setMobileOpen] = useState(false);
  const location = useLocation();
  const { schoolProfile, isReadOnly, isViewYearComplete, viewYear, activeYear, setViewYear } = useSchoolData();
  const pageTitle = title ?? ROUTE_TITLES[location.pathname] ?? 'ড্যাশবোর্ড';

  return (
    <div className={`app-shell ${lockedViewClass(isReadOnly)}`}>
      <Sidebar mobileOpen={mobileOpen} onNavigate={() => setMobileOpen(false)} />

      <div className="flex min-h-screen w-full min-w-0 flex-col">
        <Topbar
          onMenuClick={() => setMobileOpen((prev) => !prev)}
          title={pageTitle}
          subtitle={subtitle}
        />
        {isReadOnly ? (
          <div
            role="status"
            className="flex flex-wrap items-center justify-center gap-2 border-b border-slate-300 bg-white px-4 py-2 text-center text-xs font-bold text-slate-900 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
          >
            <span>
              {yearLockBannerText({ year: viewYear, isComplete: isViewYearComplete })}
            </span>
            <button
              type="button"
              onClick={() => setViewYear(activeYear)}
              className="rounded-lg bg-slate-900 px-2.5 py-1 text-[11px] font-bold text-white transition hover:bg-slate-700 dark:bg-white dark:text-slate-900 dark:hover:bg-slate-200"
            >
              সক্রিয় সালে ({activeYear}) ফিরুন
            </button>
          </div>
        ) : null}
        <main
          key={location.pathname}
          className="min-w-0 flex-1 px-4 py-5 sm:px-6 sm:py-6"
        >
          <Outlet />
        </main>
        <footer className="app-footer border-t border-slate-200 bg-white px-4 py-3 text-center text-[11px] text-slate-400 sm:px-6">
          {schoolDisplayName(schoolProfile)}{fullAddress(schoolProfile) ? ` · ${fullAddress(schoolProfile)}` : ''} · শিক্ষাবর্ষ {academicYearOf(schoolProfile)} · ডিজিটাল রেজাল্ট সিস্টেম
        </footer>
      </div>
    </div>
  );
}
