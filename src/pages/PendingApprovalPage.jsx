import { useState } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { Clock3, LogOut, RefreshCw } from 'lucide-react';
import { useAuth } from '../context/AuthContext.jsx';
import { MEMBER_STATUS } from '../utils/constants.js';

export default function PendingApprovalPage() {
  const { user, refreshMembership, signOut } = useAuth();
  const navigate = useNavigate();
  const [checking, setChecking] = useState(false);
  const [message, setMessage] = useState('');

  if (user?.status === MEMBER_STATUS.APPROVED) return <Navigate to="/dashboard" replace />;

  const checkStatus = async () => {
    setChecking(true);
    const member = await refreshMembership();
    setChecking(false);
    setMessage(member?.status === MEMBER_STATUS.APPROVED
      ? 'অনুমোদন সম্পন্ন হয়েছে। কর্মস্থলে প্রবেশ করা হচ্ছে…'
      : member?.status === MEMBER_STATUS.REJECTED
        ? 'আবেদনটি বাতিল করা হয়েছে। বিদ্যালয়ের প্রশাসকের সঙ্গে যোগাযোগ করুন।'
        : 'এখনও অনুমোদন পাওয়া যায়নি। পরে আবার স্ট্যাটাস যাচাই করুন।');
    if (member?.status === MEMBER_STATUS.APPROVED) navigate('/dashboard', { replace: true });
  };

  return <main className="flex min-h-screen items-center justify-center bg-slate-100 p-4 dark:bg-slate-950">
    <section className="w-full max-w-lg rounded-2xl border border-slate-200 bg-white p-7 text-center shadow-card dark:border-slate-800 dark:bg-slate-900">
      <span className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300"><Clock3 size={26}/></span>
      <h1 className="mt-4 text-xl font-extrabold">অনুমোদনের অপেক্ষায় (Pending Approval)</h1>
      <p className="mt-2 text-sm leading-6 text-slate-600 dark:text-slate-300">{user?.schoolName || 'আপনার বিদ্যালয়'}-এ শিক্ষক হিসেবে যোগদানের আবেদন বিদ্যালয়ের অ্যাডমিনের অনুমোদনের অপেক্ষায় আছে। অনুমোদন পেলেই একই কর্মস্থলে প্রবেশ করতে পারবেন।</p>
      {message && <p role="status" className="mt-4 rounded-lg bg-brand-50 p-3 text-sm text-brand-800 dark:bg-brand-900/30 dark:text-brand-200">{message}</p>}
      <div className="mt-6 flex flex-wrap justify-center gap-2">
        <button className="btn-primary" type="button" onClick={checkStatus} disabled={checking}><RefreshCw size={15} className={checking ? 'animate-spin' : ''}/> {checking ? 'যাচাই হচ্ছে…' : 'স্ট্যাটাস চেক করুন'}</button>
        <button className="btn-secondary" type="button" onClick={signOut}><LogOut size={15}/> লগআউট</button>
      </div>
    </section>
  </main>;
}
