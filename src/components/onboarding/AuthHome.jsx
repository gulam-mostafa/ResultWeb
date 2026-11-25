import { useEffect, useMemo, useState } from 'react';
import { registerFirebaseAccount, loginFirebaseAccount } from '../../services/firebaseAuthService.js';
import { Navigate, useNavigate } from 'react-router-dom';
import { BookOpen, Sparkles, Zap } from 'lucide-react';
import { useAuth, isDemoLoginEnabled } from '../../context/AuthContext.jsx';
import { buildSchoolId, subscribeSchools } from '../../services/database/index.js';
import { findGeoNames } from '../../data/bdLocations.js';
import { CLASS_LEVELS, ROLES } from '../../utils/constants.js';
import LoginForm from './LoginForm.jsx';
import SignUpForm from './SignUpForm.jsx';

const CLASS_OPTIONS = Array.isArray(CLASS_LEVELS) ? CLASS_LEVELS.filter((item) => item && item.id) : [];
const DEFAULT_DIR = { divisionId: 'dhaka', districtId: 'gazipur', upazilaId: 'gazipur-sadar', schoolId: '' };

export default function AuthHome() {
  const auth = useAuth() || {};
  const { isAuthenticated = false, landingRouteFor, role = null, user, signInWithRole, registerTeacher, bypassLogin } = auth;
  const navigate = useNavigate();
  const [tab, setTab] = useState('login');
  const [kind, setKind] = useState('teacher');
  const [directory, setDirectory] = useState(DEFAULT_DIR);
  const [schools, setSchools] = useState([]);
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState('');
  const [fullName, setFullName] = useState('');
  const [designation, setDesignation] = useState('সহকারী শিক্ষক');
  const [studentClass, setStudentClass] = useState(CLASS_OPTIONS[1]?.name ?? CLASS_OPTIONS[0]?.name ?? 'প্রাক-প্রাথমিক');
  const [roll, setRoll] = useState('');
  const [notice, setNotice] = useState('');
  const [identity, setIdentity] = useState('');
  const [password, setPassword] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const safeDirectory = directory && typeof directory === 'object' ? directory : DEFAULT_DIR;
  const safeClassLevels = CLASS_OPTIONS;
  const safeSchools = Array.isArray(schools) ? schools.filter(Boolean) : [];
  const geoNames = useMemo(() => {
    try { return findGeoNames?.(safeDirectory.divisionId, safeDirectory.districtId, safeDirectory.upazilaId) ?? {}; }
    catch { return {}; }
  }, [safeDirectory.divisionId, safeDirectory.districtId, safeDirectory.upazilaId]);

  useEffect(() => {
    const location = safeDirectory;
    if (!location.divisionId || !location.districtId || !location.upazilaId || typeof subscribeSchools !== 'function') { setSchools([]); return undefined; }
    try {
      return subscribeSchools(location, (records) => setSchools(Array.isArray(records) ? records.filter(Boolean) : []), () => {});
    } catch {
      setSchools([]);
      return undefined;
    }
  }, [safeDirectory.divisionId, safeDirectory.districtId, safeDirectory.upazilaId]);

  if (isAuthenticated) return <Navigate to={typeof landingRouteFor === 'function' ? landingRouteFor(role, user) : '/dashboard'} replace />;
  const school = safeSchools.find((item) => item?.id === safeDirectory.schoolId) ?? null;
  const roleId = kind === 'student' ? ROLES.STUDENT : ROLES.SCHOOL_ADMIN;

  const login = async (schoolOverride = null, isNewSchool = false, authAccount = null) => {
    const chosen = schoolOverride || school;
    const details = { name: fullName.trim() || (kind === 'student' ? 'শিক্ষার্থী / অভিভাবক' : 'শিক্ষক'), schoolId: chosen?.id || safeDirectory.schoolId, schoolName: chosen?.name || '', divisionId: safeDirectory.divisionId, districtId: safeDirectory.districtId, upazilaId: safeDirectory.upazilaId, studentId: kind === 'student' ? 'stu-c5-01' : undefined, designation: kind === 'teacher' ? designation : `${studentClass} · রোল ${roll || '—'}`, uid: authAccount?.uid, email: authAccount?.email, phone: identity, classId: studentClass };
    const result = tab === 'signup' && kind === 'teacher'
      ? await registerTeacher?.({ school: chosen, name: details.name, designation, location: { divisionId: details.divisionId, districtId: details.districtId, upazilaId: details.upazilaId, ...geoNames }, isNewSchool, uid: authAccount?.uid, email: authAccount?.email, phone: identity })
      : signInWithRole?.(roleId, details);
    if (result?.ok) navigate(result.redirectTo || '/dashboard', { replace: true }); else setNotice(result?.message || 'প্রবেশ করা যায়নি।');
  };

  const handleBypass = () => {
    const res = bypassLogin?.(school, safeDirectory);
    if (res?.ok) navigate(res.redirectTo || '/dashboard', { replace: true });
    else if (res?.message) setNotice(res.message);
  };
  const demoEnabled = isDemoLoginEnabled();

  const handleKindChange = (nextKind) => { setKind(nextKind); setAdding(false); };
  const handleAddSchool = () => { setAdding(true); setDirectory((current) => ({ ...(current ?? DEFAULT_DIR), schoolId: '' })); };

  const fillSample = () => {
    const rand = Math.floor(100 + Math.random() * 900);
    setFullName(kind === 'teacher' ? 'মোছাঃ নাসরিন আক্তার' : 'মোঃ আরিফুল ইসলাম');
    setIdentity(kind === 'teacher' ? `teacher${rand}@example.com` : `student${rand}@example.com`);
    setPassword('Result@2026');
    setDesignation('সহকারী শিক্ষক');
    setRoll('১');
    setNotice('');
  };

  const submit = async (event) => {
    event.preventDefault();
    if (isSubmitting) return;
    setNotice('');
    setIsSubmitting(true);
    try {
      if (!identity.trim() || !password) throw new Error('মোবাইল নম্বর / ইমেইল এবং পাসওয়ার্ড পূরণ করুন।');
      if (tab === 'signup') {
        if (!fullName.trim()) throw new Error('পূর্ণ নাম লিখুন।');
        if (kind === 'teacher' && !adding && !school) throw new Error('বিদ্যালয় নির্বাচন করুন।');
        if (kind === 'teacher' && adding && !newName.trim()) throw new Error('নতুন বিদ্যালয়ের নাম লিখুন।');
        if (kind === 'teacher' && adding && (!safeDirectory.divisionId || !safeDirectory.districtId || !safeDirectory.upazilaId)) {
          throw new Error('বিভাগ, জেলা ও উপজেলা নির্বাচন করুন।');
        }
        const account = await registerFirebaseAccount(identity, password);
        if (kind === 'teacher' && adding) {
          // A brand-new school: mint the deterministic id here so the UI can select it
          // immediately and the session is issued against the same `schoolRef`.
          const schoolId = buildSchoolId(safeDirectory, newName.trim());
          if (!schoolId) throw new Error('বিদ্যালয়ের নাম থেকে আইডি তৈরি করা যায়নি; অন্য নাম দিন।');
          const schoolRef = {
            divisionId: safeDirectory.divisionId,
            districtId: safeDirectory.districtId,
            upazilaId: safeDirectory.upazilaId,
            schoolId,
          };
          const created = { id: schoolRef.schoolId, name: newName.trim(), ...schoolRef };
          setSchools((current) => current.some((item) => item?.id === created.id) ? current : [...current, created]);
          setDirectory((current) => ({ ...(current ?? DEFAULT_DIR), schoolId: created.id }));
          // `registerTeacher` fires steps (a)…(d) in order and only then returns a session,
          // so a brand-new school can never surface “বিদ্যালয়ের তথ্য পাওয়া যায়নি”.
          await login(created, true, account);
        } else if (kind === 'teacher') await login(school, false, account);
        else {
          const result = signInWithRole?.(ROLES.STUDENT, { name: fullName.trim(), schoolId: school?.id || safeDirectory.schoolId, schoolName: school?.name || '', studentId: `student-${account.uid}`, uid: account.uid, email: account.email, phone: identity, classId: studentClass, designation: `${studentClass} · রোল ${roll || '—'}` });
          if (!result?.ok) setNotice(result?.message || 'নিবন্ধন সম্পন্ন হয়নি।');
          else navigate(result.redirectTo || '/my-result', { replace: true });
        }
      } else {
        const account = await loginFirebaseAccount(identity, password);
        if (kind === 'teacher') {
          if (!school) throw new Error('বিদ্যালয় নির্বাচন করুন।');
          const result = await auth.signInTeacher?.({ school, uid: account.uid, email: account.email, identity });
          if (result?.ok) navigate(result.redirectTo || '/dashboard', { replace: true });
          else setNotice(result?.message || 'এই বিদ্যালয়ে শিক্ষক অ্যাকাউন্ট পাওয়া যায়নি।');
        } else {
          const result = signInWithRole?.(ROLES.STUDENT, { schoolId: school?.id || safeDirectory.schoolId, schoolName: school?.name || '', uid: account.uid, email: account.email, studentId: `student-${account.uid}` });
          if (result?.ok) navigate(result.redirectTo || '/my-result', { replace: true });
          else setNotice(result?.message || 'প্রবেশ করা যায়নি।');
        }
      }
    } catch (error) {
      setNotice(error?.message || 'নিবন্ধন / লগইন সম্পন্ন করা যায়নি; আবার চেষ্টা করুন।');
    } finally {
      setIsSubmitting(false);
    }
  };

  return <main className="min-h-screen bg-gradient-to-br from-slate-100 via-white to-brand-50 px-4 py-8 dark:from-slate-950 dark:via-slate-900 dark:to-slate-950 sm:py-12">
    <div className="mx-auto grid min-h-[calc(100vh-6rem)] max-w-6xl overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-xl dark:border-slate-800 dark:bg-slate-900 lg:grid-cols-[0.9fr_1.1fr]">
      <aside className="flex flex-col justify-between bg-gradient-to-br from-brand-950 via-brand-800 to-brand-700 p-7 text-white sm:p-10"><div><div className="mb-10 flex items-center gap-3"><span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-white/15"><BookOpen size={25}/></span><div><p className="text-sm font-extrabold">প্রাথমিক বিদ্যালয়</p><p className="text-xs text-brand-100">ব্যবস্থাপনা ও ডিজিটাল ফলাফল</p></div></div><p className="text-sm font-semibold text-brand-100">স্বাগতম</p><h1 className="mt-2 text-3xl font-black leading-tight sm:text-4xl">শিক্ষার অগ্রযাত্রায়<br/>আপনার বিশ্বস্ত সঙ্গী</h1><p className="mt-5 max-w-md text-sm leading-7 text-brand-100">শিক্ষার্থী ব্যবস্থাপনা, ফলাফল এবং বিদ্যালয়ের গুরুত্বপূর্ণ নথি—সবকিছু একটি নিরাপদ কর্মস্থলে।</p></div><div className="mt-12 rounded-2xl border border-white/15 bg-white/10 p-5"><p className="text-sm font-bold">{school?.name || 'আপনার বিদ্যালয়'}</p><p className="mt-1 text-xs text-brand-100">{school ? [school.villageOrUnion || school.village, geoNames.upazilaName, geoNames.districtName].filter(Boolean).join(', ') : 'বিদ্যালয় নির্বাচন বা নিবন্ধন করুন'}</p><div className="mt-4 flex items-center gap-2 text-xs text-brand-100"><Sparkles size={14}/> {school?.motto || 'শিক্ষার্থী ব্যবস্থাপনা ও ডিজিটাল ফলাফল'}</div></div></aside>
      <section className="flex items-center justify-center p-5 sm:p-9 lg:p-12"><div className="w-full max-w-xl">
        <div className="mb-5 flex flex-wrap items-center justify-between gap-2">
          <div><h2 className="text-2xl font-extrabold text-slate-900 dark:text-white">আপনার অ্যাকাউন্টে প্রবেশ করুন</h2><p className="mt-1 text-sm text-slate-500 dark:text-slate-400">চালিয়ে যেতে লগইন করুন অথবা নতুন নিবন্ধন করুন</p></div>
          {demoEnabled ? <button type="button" onClick={handleBypass} className="inline-flex items-center gap-1.5 rounded-xl bg-amber-500 px-3.5 py-2 text-xs font-bold text-white shadow hover:bg-amber-600"><Zap size={14}/> সরাসরি প্রবেশ (ডেমো)</button> : null}
        </div>
        <div className="mb-6 grid grid-cols-2 rounded-xl bg-slate-100 p-1 dark:bg-slate-800"><button type="button" onClick={() => { setTab('login'); setNotice(''); setAdding(false); }} className={`rounded-lg px-3 py-2.5 text-sm font-bold ${tab === 'login' ? 'bg-white text-brand-800 shadow-sm dark:bg-slate-700 dark:text-white' : 'text-slate-500'}`}>লগইন</button><button type="button" onClick={() => { setTab('signup'); setNotice(''); }} className={`rounded-lg px-3 py-2.5 text-sm font-bold ${tab === 'signup' ? 'bg-white text-brand-800 shadow-sm dark:bg-slate-700 dark:text-white' : 'text-slate-500'}`}>সাইন আপ / নিবন্ধন</button></div>
        {tab === 'login' ? (
          <LoginForm
            kind={kind}
            onKindChange={handleKindChange}
            directory={safeDirectory}
            onDirectoryChange={setDirectory}
            schools={safeSchools}
            adding={adding}
            onAddSchool={handleAddSchool}
            newName={newName}
            onNewNameChange={setNewName}
            identity={identity}
            onIdentityChange={setIdentity}
            password={password}
            onPasswordChange={setPassword}
            notice={notice}
            isSubmitting={isSubmitting}
            onSubmit={submit}
            onBypass={handleBypass}
            schoolName={school?.name ?? 'বিদ্যালয় নির্বাচন করুন'}
          />
        ) : (
          <SignUpForm
            kind={kind}
            onKindChange={handleKindChange}
            classOptions={safeClassLevels}
            fullName={fullName}
            onFullNameChange={setFullName}
            onFillSample={fillSample}
            designation={designation}
            onDesignationChange={setDesignation}
            studentClass={studentClass}
            onStudentClassChange={setStudentClass}
            roll={roll}
            onRollChange={setRoll}
            identity={identity}
            onIdentityChange={setIdentity}
            password={password}
            onPasswordChange={setPassword}
            directory={safeDirectory}
            onDirectoryChange={setDirectory}
            schools={safeSchools}
            adding={adding}
            onAddSchool={handleAddSchool}
            newName={newName}
            onNewNameChange={setNewName}
            notice={notice}
            isSubmitting={isSubmitting}
            onSubmit={submit}
            onBypass={handleBypass}
            schoolName={school?.name ?? 'বিদ্যালয় নির্বাচন করুন'}
          />
        )}
      </div></section>
    </div>
  </main>;
}