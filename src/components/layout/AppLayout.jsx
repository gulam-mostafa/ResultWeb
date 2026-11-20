import { useState } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import { useSchoolData } from '../../context/SchoolDataContext.jsx';
import { academicYearOf, fullAddress, schoolDisplayName } from '../../utils/schoolProfile.js';
import Sidebar from './Sidebar.jsx';
import Topbar from './Topbar.jsx';

/**
 * AppLayout — the authenticated shell (sidebar + topbar + routed content).
 * Print rules hide sidebar/topbar so only `.print-sheet` reaches paper.
 */
export default function AppLayout({ title, subtitle }) {
  const [mobileOpen, setMobileOpen] = useState(false);
  const location = useLocation();
  const { schoolProfile } = useSchoolData();

  return (
    <div className="app-shell">
      <Sidebar mobileOpen={mobileOpen} onNavigate={() => setMobileOpen(false)} />

      <div className="flex min-h-screen w-full min-w-0 flex-col">
        <Topbar
          onMenuClick={() => setMobileOpen((prev) => !prev)}
          title={title}
          subtitle={subtitle}
        />
        <main
          key={location.pathname}
          className="flex-1 animate-fade-in px-4 py-5 sm:px-6 sm:py-6"
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
