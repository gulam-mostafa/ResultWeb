import { Link, useSearchParams } from 'react-router-dom';
import { BadgeCheck, School, ShieldAlert, ShieldCheck, UserRound } from 'lucide-react';
import { toBanglaNumber, formatBanglaDecimal } from '../utils/banglaNumberFormatter.js';
import { readVerificationFromSearch } from '../utils/verification.js';

/**
 * /verify — public marksheet verification (কোনো লগইন ছাড়াই).
 *
 * Reached by scanning the QR code printed on a marksheet. The route is deliberately
 * OUTSIDE `ProtectedRoute`, so a guardian, an employer or another school can check a
 * paper WITHOUT a login.
 *
 * Privacy: the QR carries only the fields a verifier is meant to see — name (নাম),
 * roll (রোল), GPA and school name (বিদ্যালয়ের নাম), plus the class / result label and
 * the academic year for context. No guardian phone, NID, birth certificate or address
 * ever travels in the link, and no database lookup is required, so this page works
 * offline and cannot expose another pupil's private record.
 */
export default function VerifyResultPage() {
  const [searchParams] = useSearchParams();
  const { ok, reason, record, code } = readVerificationFromSearch(searchParams.toString());
  const gpaNumber = Number(record?.g);

  const shell = (children) => (
    <main className="flex min-h-screen items-center justify-center bg-gradient-to-br from-brand-50 via-slate-100 to-slate-200 p-4 dark:from-slate-950 dark:via-slate-900 dark:to-slate-950">
      <div className="w-full max-w-lg">{children}</div>
    </main>
  );

  if (!record) {
    return shell(
      <section className="card card-pad text-center">
        <span className="mx-auto mb-3 flex h-14 w-14 items-center justify-center rounded-2xl bg-rose-100 text-rose-700">
          <ShieldAlert size={26} aria-hidden="true" />
        </span>
        <h1 className="text-lg font-extrabold">যাচাই কোড পাওয়া যায়নি</h1>
        <p className="mt-2 text-sm leading-relaxed text-slate-600 dark:text-slate-300">
          লিংকটি অসম্পূর্ণ বা ভুল। মার্কশিটে ছাপা QR কোডটি আবার স্ক্যান করুন।
        </p>
        <p className="mt-3 text-[11px] text-slate-400">কারণ: {reason || 'missing'}</p>
      </section>,
    );
  }

  return shell(
    <section className="card overflow-hidden">
      <header className="flex items-center gap-3 bg-brand-700 px-5 py-4 text-white">
        <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-white/15">
          {ok ? <ShieldCheck size={22} aria-hidden="true" /> : <ShieldAlert size={22} aria-hidden="true" />}
        </span>
        <div>
          <h1 className="text-base font-extrabold leading-tight">মার্কশিট যাচাই</h1>
          <p className="text-[11px] opacity-90">ডিজিটাল ফলাফল যাচাই · লগইন ছাড়াই</p>
        </div>
      </header>

      <div className="space-y-4 p-5">
        <p
          role="status"
          className={`flex items-start gap-2 rounded-xl p-3 text-xs font-semibold leading-relaxed ${
            ok
              ? 'bg-emerald-50 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-200'
              : 'bg-amber-50 text-amber-900 dark:bg-amber-900/30 dark:text-amber-100'
          }`}
        >
          <BadgeCheck size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
          {ok
            ? 'এই মার্কশিটের যাচাই কোড সঠিক — তথ্য প্রতিষ্ঠানের ডিজিটাল রেকর্ডের সঙ্গে মিলে গেছে।'
            : 'যাচাই কোডটি মেলেনি। লিংকের তথ্য পরিবর্তিত হয়ে থাকতে পারে — প্রতিষ্ঠানের সঙ্গে যোগাযোগ করুন।'}
        </p>


        <dl className="divide-y divide-slate-100 dark:divide-slate-800">
          <div className="flex items-start gap-3 py-3">
            <UserRound size={16} className="mt-0.5 shrink-0 text-brand-700 dark:text-brand-300" aria-hidden="true" />
            <div className="min-w-0 flex-1">
              <dt className="text-[11px] font-semibold text-slate-500">নাম</dt>
              <dd className="break-words text-sm font-bold text-slate-900 dark:text-white">{record.n || '—'}</dd>
            </div>
          </div>
          <div className="flex items-start gap-3 py-3">
            <BadgeCheck size={16} className="mt-0.5 shrink-0 text-brand-700 dark:text-brand-300" aria-hidden="true" />
            <div className="min-w-0 flex-1">
              <dt className="text-[11px] font-semibold text-slate-500">রোল</dt>
              <dd className="text-sm font-bold text-slate-900 dark:text-white">
                {record.r ? toBanglaNumber(record.r) : '—'}
              </dd>
            </div>
          </div>
          <div className="flex items-start gap-3 py-3">
            <BadgeCheck size={16} className="mt-0.5 shrink-0 text-brand-700 dark:text-brand-300" aria-hidden="true" />
            <div className="min-w-0 flex-1">
              <dt className="text-[11px] font-semibold text-slate-500">GPA</dt>
              <dd className="text-sm font-extrabold text-slate-900 dark:text-white">
                {Number.isFinite(gpaNumber) ? formatBanglaDecimal(gpaNumber, 2) : '—'}
                <span className="ml-1 text-[11px] font-normal text-slate-400">/ ৫.০০</span>
              </dd>
            </div>
          </div>
          <div className="flex items-start gap-3 py-3">
            <School size={16} className="mt-0.5 shrink-0 text-brand-700 dark:text-brand-300" aria-hidden="true" />
            <div className="min-w-0 flex-1">
              <dt className="text-[11px] font-semibold text-slate-500">বিদ্যালয়ের নাম</dt>
              <dd className="break-words text-sm font-bold text-slate-900 dark:text-white">{record.s || '—'}</dd>
            </div>
          </div>
        </dl>

        {(record.c || record.t || record.y) ? (
          <p className="flex flex-wrap gap-x-3 gap-y-1 rounded-xl bg-slate-50 p-3 text-[11px] font-semibold text-slate-600 dark:bg-slate-800 dark:text-slate-300">
            {record.c ? <span>শ্রেণি: {record.c}</span> : null}
            {record.t ? <span>ফলাফল: {record.t}</span> : null}
            {record.y ? <span>শিক্ষাবর্ষ: {toBanglaNumber(record.y)}</span> : null}
          </p>
        ) : null}

        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-100 pt-3 dark:border-slate-800">
          <p className="text-[10px] font-semibold text-slate-400">
            যাচাই কোড: <span className="font-mono tracking-wider">{code || '—'}</span>
          </p>
          <Link
            to="/"
            className="text-[11px] font-bold text-brand-700 underline underline-offset-2 hover:text-brand-900 dark:text-brand-300"
          >
            প্রতিষ্ঠানের লগইন পেজ
          </Link>
        </div>
      </div>
    </section>,
  );
}
