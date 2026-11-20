import { Component } from 'react';

export class AppErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, info) {
    console.error('Application render error:', error, info.componentStack);
  }

  render() {
    if (this.state.hasError) {
      return <main role="alert" className="flex min-h-screen items-center justify-center bg-slate-50 p-6 text-slate-900 dark:bg-slate-950 dark:text-white">
        <section className="w-full max-w-lg rounded-2xl border border-slate-200 bg-white p-7 shadow-lg dark:border-slate-700 dark:bg-slate-900">
          <h1 className="text-xl font-extrabold">পৃষ্ঠাটি দেখাতে সমস্যা হয়েছে</h1>
          <p className="mt-3 text-sm leading-6 text-slate-600 dark:text-slate-300">অ্যাপ্লিকেশনে একটি অপ্রত্যাশিত ত্রুটি ঘটেছে। পৃষ্ঠাটি পুনরায় লোড করুন। সমস্যা চলতে থাকলে বিদ্যালয়ের সিস্টেম পরিচালকের সঙ্গে যোগাযোগ করুন।</p>
          <pre className="mt-4 max-h-40 overflow-auto rounded bg-slate-100 p-3 text-xs dark:bg-slate-800">{this.state.error?.message || 'অজানা JavaScript ত্রুটি'}</pre>
          <button type="button" className="mt-5 rounded-lg bg-blue-700 px-4 py-2 font-bold text-white" onClick={() => window.location.reload()}>পুনরায় লোড করুন</button>
        </section>
      </main>;
    }
    return this.props.children;
  }
}

import { Navigate, Route, Routes } from 'react-router-dom';
import AppLayout from './components/layout/AppLayout.jsx';
import ProtectedRoute from './components/layout/ProtectedRoute.jsx';
import AuthHome from './components/onboarding/AuthHome.jsx';
import Dashboard from './pages/Dashboard.jsx';
import StudentsPage from './pages/StudentsPage.jsx';
import ResultsPage from './pages/ResultsPage.jsx';
import AttendancePage from './pages/AttendancePage.jsx';
import DocumentsPage from './pages/DocumentsPage.jsx';
import MyResultPage from './pages/MyResultPage.jsx';
import SettingsPage from './pages/SettingsPage.jsx';
import SchoolsPage from './pages/SchoolsPage.jsx';
import PendingApprovalPage from './pages/PendingApprovalPage.jsx';
import SchoolProfilePage from './pages/SchoolProfilePage.jsx';
import TeacherManagementPage from './pages/TeacherManagementPage.jsx';

export default function App() {
  return <Routes>
    <Route path="/" element={<AuthHome />} />
    <Route path="/pending-approval" element={<ProtectedRoute><PendingApprovalPage /></ProtectedRoute>} />
    <Route element={<ProtectedRoute><AppLayout /></ProtectedRoute>}>
      <Route path="/dashboard" element={<ProtectedRoute allowedRoles={['super_admin', 'school_admin']}><Dashboard /></ProtectedRoute>} />
      <Route path="/students" element={<ProtectedRoute allowedRoles={['super_admin', 'school_admin']}><StudentsPage /></ProtectedRoute>} />
      <Route path="/results" element={<ProtectedRoute allowedRoles={['super_admin', 'school_admin']}><ResultsPage /></ProtectedRoute>} />
      <Route path="/attendance" element={<ProtectedRoute allowedRoles={['super_admin', 'school_admin']}><AttendancePage /></ProtectedRoute>} />
      <Route path="/documents" element={<ProtectedRoute allowedRoles={['super_admin', 'school_admin']}><DocumentsPage /></ProtectedRoute>} />
      <Route path="/my-result" element={<ProtectedRoute allowedRoles={['student']}><MyResultPage /></ProtectedRoute>} />
      <Route path="/school-profile" element={<ProtectedRoute allowedRoles={['school_admin']}><SchoolProfilePage /></ProtectedRoute>} />
      <Route path="/teacher-management" element={<ProtectedRoute allowedRoles={['school_admin']}><TeacherManagementPage /></ProtectedRoute>} />
      <Route path="/settings" element={<SettingsPage />} />
      <Route path="/schools" element={<ProtectedRoute allowedRoles={['super_admin']}><SchoolsPage /></ProtectedRoute>} />
    </Route>
    <Route path="*" element={<Navigate to="/" replace />} />
  </Routes>;
}
