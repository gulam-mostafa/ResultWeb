import { useState } from 'react';
import { ShieldCheck, ShieldAlert, KeyRound, Hash, Info } from 'lucide-react';
import { clsx } from '../../utils/clsx.js';

/**
 * EMISVerification — step 2 of onboarding.
 * Validates the school's EMIS code + PIN before role login is unlocked.
 */
export default function EMISVerification({ school, verified, onVerifiedChange, onVerify }) {
  const target = school ?? { name: 'নির্বাচিত বিদ্যালয়', emisCode: '', pinCode: '' };
  const [emisCode, setEmisCode] = useState('');
  const [pinCode, setPinCode] = useState('');
  const [message, setMessage] = useState(null);

  const handleSubmit = (event) => {
    event.preventDefault();
    const result = onVerify?.({ emisCode, pinCode, school: target }) ?? {
      ok: false,
      message: 'যাচাই সেবা পাওয়া যায়নি।',
    };

    if (result.ok) {
      setMessage({ tone: 'success', text: result.message });
      onVerifiedChange?.(true);
    } else {
      setMessage({ tone: 'error', text: result.message });
      onVerifiedChange?.(false);
    }
  };

  const fillDemo = () => {
    setEmisCode(String(target.emisCode));
    setPinCode(String(target.pinCode));
    setMessage(null);
  };

  return (
    <div className="space-y-3">
      <div
        className={clsx(
          'flex items-start gap-2.5 rounded-xl border px-3 py-2.5',
          verified ? 'border-emerald-200 bg-emerald-50' : 'border-amber-200 bg-amber-50',
        )}
      >
        {verified ? (
          <ShieldCheck size={16} className="mt-0.5 shrink-0 text-emerald-600" aria-hidden="true" />
        ) : (
          <ShieldAlert size={16} className="mt-0.5 shrink-0 text-amber-600" aria-hidden="true" />
        )}
        <div className="min-w-0">
          <p
            className={clsx(
              'text-xs font-bold',
              verified ? 'text-emerald-900' : 'text-amber-900',
            )}
          >
            {verified ? 'প্রতিষ্ঠান যাচাই সম্পন্ন হয়েছে' : 'ইএমআইএস / পিন যাচাই প্রয়োজন'}
          </p>
          <p
            className={clsx(
              'mt-0.5 text-[11px] leading-relaxed',
              verified ? 'text-emerald-800' : 'text-amber-800',
            )}
          >
            {verified
              ? `${target.name} — ইএমআইএস ${target.emisCode} সফলভাবে যাচাই করা হয়েছে। এখন ভূমিকা নির্বাচন করে লগইন করুন।`
              : 'বিদ্যালয়ের ইএমআইএস কোড ও পিন কোড দিয়ে প্রতিষ্ঠান যাচাই করুন।'}
          </p>
        </div>
      </div>

      {!verified ? (
        <form onSubmit={handleSubmit} className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className="label-base" htmlFor="emis-code">
                <span className="inline-flex items-center gap-1">
                  <Hash size={11} aria-hidden="true" /> ইএমআইএস কোড
                </span>
              </label>
              <input
                id="emis-code"
                className="input-base tabular"
                inputMode="numeric"
                autoComplete="off"
                placeholder="যেমন: 133701"
                value={emisCode}
                onChange={(event) => setEmisCode(event.target.value)}
              />
            </div>
            <div>
              <label className="label-base" htmlFor="pin-code">
                <span className="inline-flex items-center gap-1">
                  <KeyRound size={11} aria-hidden="true" /> পিন কোড
                </span>
              </label>
              <input
                id="pin-code"
                className="input-base"
                autoComplete="off"
                placeholder="যেমন: GZP-4821"
                value={pinCode}
                onChange={(event) => setPinCode(event.target.value)}
              />
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button type="submit" className="btn-primary btn-sm">
              <ShieldCheck size={14} aria-hidden="true" />
              যাচাই করুন
            </button>
            <button type="button" onClick={fillDemo} className="btn-secondary btn-sm">
              <Info size={13} aria-hidden="true" />
              ডেমো তথ্য বসান
            </button>
            <span className="text-[10px] text-slate-400">
              ডেমো: {target.emisCode} / {target.pinCode}
            </span>
          </div>

          {message ? (
            <p
              className={clsx(
                'rounded-lg px-3 py-2 text-[11px] font-semibold',
                message.tone === 'success'
                  ? 'bg-emerald-50 text-emerald-800'
                  : 'bg-rose-50 text-rose-700',
              )}
              role="alert"
            >
              {message.text}
            </p>
          ) : null}
        </form>
      ) : null}
    </div>
  );
}
