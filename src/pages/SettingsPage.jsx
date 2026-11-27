import { RotateCcw } from 'lucide-react';
import { useAuth } from '../context/AuthContext.jsx';
import { useSchoolData } from '../context/SchoolDataContext.jsx';
import { Card,CardHeader } from '../components/ui/Primitives.jsx';
import { useToast } from '../components/ui/Toast.jsx';
import { toBanglaNumber } from '../utils/banglaNumberFormatter.js';
/**
 * সেটিংস ও অ্যাকাউন্ট.
 *
 * The storage note below describes what the app REALLY does: every school write goes to
 * its own Firebase Realtime Database partition (`divisions/…/schools/{schoolId}/sessions/{year}`),
 * and only the browser session/cache is kept in `localStorage`. It is not an offline-only
 * demo any more — claiming so led teachers to believe their marks were never uploaded.
 */
export default function SettingsPage(){const {user,signOut}=useAuth();const {resetDemoData,summary,schoolProfile,activeYear,syncState,isReadOnly}=useSchoolData();const toast=useToast();return <><div className="mb-5"><h2 className="text-xl font-extrabold">সেটিংস ও অ্যাকাউন্ট</h2><p className="text-xs text-slate-500">প্রোফাইল, ডেটা এবং সিস্টেম পরিচিতি</p></div><div className="grid gap-4 lg:grid-cols-2"><Card><CardHeader title="ব্যবহারকারী প্রোফাইল" subtitle="সক্রিয় সেশন"/><p className="font-bold">{user?.name}</p><p className="mt-1 text-sm text-slate-500">{user?.designation}</p><p className="mt-2 text-xs font-semibold text-slate-500">শিক্ষাবর্ষ: {toBanglaNumber(activeYear)} · সিঙ্ক: {syncState === 'synced' ? 'সংরক্ষিত' : syncState === 'saving' ? 'সংরক্ষণ হচ্ছে…' : syncState === 'offline' ? 'অফলাইন' : 'ব্যর্থ'}</p><button className="btn-secondary mt-4" onClick={signOut}>লগআউট</button></Card><Card><CardHeader title="স্থানীয় ক্যাশ ও ডেমো ডেটা" subtitle="শুধু এই ব্রাউজারে সংরক্ষিত"/><p className="text-sm">মোট {toBanglaNumber(summary.totalStudents)} শিক্ষার্থী · শিক্ষাবর্ষ {summary.session}</p><p className="mt-1 text-[11px] font-semibold text-slate-500">বিদ্যালয়: {schoolProfile?.name || '—'}</p><button className="btn-secondary mt-4" disabled={isReadOnly} title={isReadOnly ? 'এই সালটি লক করা — ডেমো ডেটা রিসেট করা যাবে না' : undefined} onClick={()=>{if(window.confirm('ডেমো ডেটা পুনরায় স্থাপন করবেন? বর্তমান পরিবর্তন মুছে যাবে।')){resetDemoData();toast.success('সংরক্ষণ হয়েছে');}}}><RotateCcw size={14}/> ডেমো ডেটা রিসেট</button></Card><Card className="lg:col-span-2"><CardHeader title="সংযোগ ও গোপনীয়তা"/><p className="text-sm leading-relaxed text-slate-600">নম্বর, উপস্থিতি ও শিক্ষার্থীর তথ্য এই বিদ্যালয়ের নিজস্ব Firebase Realtime Database বিভাজনে (<b>sessions/{activeYear}</b>) সংরক্ষিত হয়; ব্রাউজারে শুধু লগইন সেশন ও অফলাইন ক্যাশ থাকে। প্রতিটি লেখা বিদ্যালয়-ভিত্তিক ডেটাবেজ নিয়মে সুরক্ষিত, এবং কেবল অনুমোদিত শিক্ষকই তা পড়তে ও লিখতে পারেন।</p></Card></div></>;}
