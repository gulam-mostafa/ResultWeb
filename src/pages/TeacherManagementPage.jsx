import { useEffect, useMemo, useState } from 'react';
import {
  Check,
  Loader2,
  RotateCcw,
  ShieldCheck,
  ShieldOff,
  ShieldAlert,
  UserRoundX,
  X,
} from 'lucide-react';
import { useAuth } from '../context/AuthContext.jsx';
import { MEMBER_STATUS } from '../utils/constants.js';
import { toBanglaNumber, formatBanglaDate } from '../utils/banglaNumberFormatter.js';
import {
  removeMember,
  setMemberAdmin,
  setMemberApprover,
  setMemberStatus,
  subscribeMembers,
} from '../services/database/index.js';
import { Card, CardHeader, EmptyState } from '../components/ui/Primitives.jsx';
import { clsx } from '../utils/clsx.js';

const asList = (record) => Object.values(record || {}).filter((member) => member?.uid);

const roleTags = (member) => {
  const tags = [];
  if (member.isFounder) tags.push({ label: 'প্রতিষ্ঠাতা অ্যাডমিন', tone: 'bg-amber-100 text-amber-800' });
  if (member.isAdmin && !member.isFounder) tags.push({ label: 'কো-অ্যাডমিন', tone: 'bg-violet-100 text-violet-800' });
  if (member.canApprove && !member.isFounder) tags.push({ label: 'অনুমোদনকারী', tone: 'bg-brand-100 text-brand-800' });
  return tags;
};

function MemberMeta({ member }) {
  const approverLabel = member.approvedByName || member.approvedBy || '';
  return (
    <div className="min-w-0">
      <p className="flex flex-wrap items-center gap-1.5 text-sm font-bold text-slate-900">
        <span className="truncate">{member.name || 'নামহীন শিক্ষক'}</span>
        {roleTags(member).map((tag) => (
          <span key={tag.label} className={clsx('badge', tag.tone)}>
            {tag.label}
          </span>
        ))}
      </p>
      <p className="mt-0.5 truncate text-[11px] text-slate-500">
        {member.designation || 'শিক্ষক'} · {member.email || member.phone || member.uid}
      </p>
      {member.createdAt ? (
        <p className="text-[10px] text-slate-400">আবেদন: {formatBanglaDate(member.createdAt)}</p>
      ) : null}
      {member.status === MEMBER_STATUS.APPROVED && (approverLabel || member.approvedAt) ? (
        <p className="text-[10px] text-emerald-700">
          অনুমোদন করেছেন: {approverLabel || '—'}
          {member.approvedAt ? ` (${formatBanglaDate(member.approvedAt)})` : ''}
        </p>
      ) : null}
    </div>
  );
}

export default function TeacherManagementPage() {
  const { user, canApproveTeachers } = useAuth();
  const [members, setMembers] = useState({});
  const [busyId, setBusyId] = useState('');
  const [notice, setNotice] = useState(null);

  useEffect(() => {
    if (!user?.schoolId) return undefined;
    return subscribeMembers(user.schoolId, setMembers);
  }, [user?.schoolId]);

  const { pending, approved, rejected } = useMemo(() => {
    const all = asList(members).filter((member) => member.uid !== user?.uid);
    return {
      pending: all.filter((member) => member.status === MEMBER_STATUS.PENDING),
      approved: all
        .filter((member) => member.status === MEMBER_STATUS.APPROVED)
        .sort((a, b) => Number(Boolean(b.isFounder)) - Number(Boolean(a.isFounder))),
      rejected: all.filter((member) => member.status === MEMBER_STATUS.REJECTED),
    };
  }, [members, user?.uid]);

  const roster = useMemo(
    () => [
      ...approved,
      ...(user?.uid
        ? [{
            uid: user.uid,
            name: user.name,
            designation: user.designation,
            email: user.email,
            isFounder: Boolean(user.isFounder),
            isAdmin: Boolean(user.isAdmin),
            canApprove: Boolean(user.canApprove),
            status: MEMBER_STATUS.APPROVED,
            isSelf: true,
          }]
        : []),
    ],
    [approved, user],
  );

  const canDelegateAdmin = Boolean(user?.isFounder || user?.isAdmin);

  const act = async (member, action, value) => {
    if (!user?.schoolId || busyId) return;
    setBusyId(member.uid);
    setNotice(null);
    let result = { synced: false };
    if (action === 'status') result = await setMemberStatus(user.schoolId, member.uid, value, user);
    else if (action === 'approver') result = await setMemberApprover(user.schoolId, member.uid, value, user);
    else if (action === 'admin') result = await setMemberAdmin(user.schoolId, member.uid, value, user);
    else if (action === 'remove') result = await removeMember(user.schoolId, member.uid, user);
    setBusyId('');
    setNotice({
      ok: Boolean(result?.synced),
      text: result?.synced
        ? action === 'remove'
          ? 'শিক্ষককে এই বিদ্যালয় থেকে সরানো হয়েছে।'
          : 'পরিবর্তন সংরক্ষণ হয়েছে।'
        : 'পরিবর্তন সংরক্ষণ করা যায়নি; অনুমতি ও সংযোগ যাচাই করে আবার চেষ্টা করুন।',
    });
  };

  const confirmRemove = (member) => {
    const label = member.name || 'এই শিক্ষক';
    if (typeof window !== 'undefined' && !window.confirm(`${label}-কে এই বিদ্যালয়ের তালিকা থেকে সরিয়ে দেবেন?`)) return;
    act(member, 'remove');
  };

  if (!canApproveTeachers) {
    return (
      <Card>
        <EmptyState
          icon={ShieldAlert}
          title="এই প্যানেল দেখার অনুমতি নেই"
          message="শিক্ষক অনুমোদন ও ক্ষমতা ব্যবস্থাপনা শুধু প্রতিষ্ঠাতা অ্যাডমিন বা অনুমোদিত ক্ষমতাধারী শিক্ষকের জন্য প্রযোজ্য।"
        />
      </Card>
    );
  }

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-extrabold">শিক্ষক ম্যানেজমেন্ট</h1>
          <p className="mt-1 text-sm text-slate-500">
            শিক্ষক আবেদন অনুমোদন/বাতিল, অ্যাডমিন ভূমিকা প্রদান এবং সদস্য অপসারণ করুন।
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-[11px] font-bold">
          <span className="badge bg-rose-100 text-rose-700">অপেক্ষমাণ {toBanglaNumber(pending.length)}</span>
          <span className="badge bg-emerald-100 text-emerald-800">অনুমোদিত {toBanglaNumber(roster.length)}</span>
          <span className="badge bg-slate-100 text-slate-700">বাতিল {toBanglaNumber(rejected.length)}</span>
        </div>
      </header>

      {notice ? (
        <p
          role="status"
          className={clsx(
            'rounded-lg p-3 text-sm',
            notice.ok
              ? 'bg-brand-50 text-brand-800 dark:bg-brand-900/30 dark:text-brand-200'
              : 'bg-rose-50 text-rose-700 dark:bg-rose-950/40 dark:text-rose-300',
          )}
        >
          {notice.text}
        </p>
      ) : null}

      <Card>
        <CardHeader
          title="অপেক্ষমাণ আবেদন (Pending Requests)"
          subtitle={`${toBanglaNumber(pending.length)}টি আবেদন`}
        />
        {pending.length === 0 ? (
          <p className="py-6 text-center text-sm text-slate-500">কোনো অপেক্ষমাণ আবেদন নেই।</p>
        ) : (
          <ul className="divide-y divide-slate-100 dark:divide-slate-800">
            {pending.map((member) => {
              const busy = busyId === member.uid;
              return (
                <li key={member.uid} className="flex flex-wrap items-center justify-between gap-3 py-3">
                  <MemberMeta member={member} />
                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      className="btn-emerald btn-sm"
                      disabled={busy}
                      onClick={() => act(member, 'status', MEMBER_STATUS.APPROVED)}
                    >
                      {busy ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />} অনুমোদন দিন
                    </button>
                    <button
                      type="button"
                      className="btn-danger btn-sm"
                      disabled={busy}
                      onClick={() => act(member, 'status', MEMBER_STATUS.REJECTED)}
                    >
                      <X size={14} /> বাতিল করুন
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      <Card>
        <CardHeader
          title="অনুমোদিত শিক্ষক ও ক্ষমতা প্রদান (Approved Teachers & Delegation)"
          subtitle={`${toBanglaNumber(roster.length)} জন অনুমোদিত সদস্য`}
        />
        <ul className="divide-y divide-slate-100 dark:divide-slate-800">
          {roster.map((member) => {
            const busy = busyId === member.uid;
            const locked = member.isFounder || member.isSelf;
            return (
              <li key={member.uid} className="flex flex-wrap items-center justify-between gap-3 py-3">
                <MemberMeta member={member} />
                {locked ? (
                  <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold text-slate-500">
                    <ShieldCheck size={13} className="text-amber-500" />
                    {member.isSelf ? 'আপনার নিজের অ্যাকাউন্ট' : 'প্রতিষ্ঠাতা ক্ষমতা সুরক্ষিত'}
                  </span>
                ) : (
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      disabled={busy}
                      className={member.canApprove ? 'btn-secondary btn-sm' : 'btn-primary btn-sm'}
                      onClick={() => act(member, 'approver', !member.canApprove)}
                      title="শিক্ষক আবেদন অনুমোদনের ক্ষমতা"
                    >
                      {member.canApprove ? <ShieldOff size={14} /> : <ShieldCheck size={14} />}
                      {member.canApprove ? 'অনুমোদন ক্ষমতা সরান' : 'অনুমোদন ক্ষমতা দিন'}
                    </button>
                    <button
                      type="button"
                      disabled={busy || !canDelegateAdmin}
                      className="btn-secondary btn-sm"
                      onClick={() => act(member, 'admin', !member.isAdmin)}
                      title="কো-অ্যাডমিন ভূমিকা পরিবর্তন (শুধু প্রতিষ্ঠাতা/কো-অ্যাডমিন)"
                    >
                      {member.isAdmin ? <ShieldOff size={14} /> : <ShieldCheck size={14} />}
                      {member.isAdmin ? 'অ্যাডমিন ভূমিকা সরান' : 'অ্যাডমিন বানান'}
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      className="btn-danger btn-sm"
                      onClick={() => confirmRemove(member)}
                      title="বিদ্যালয়ের সদস্য তালিকা থেকে সরান"
                    >
                      {busy ? <Loader2 size={14} className="animate-spin" /> : <UserRoundX size={14} />}
                      সরিয়ে ফেলুন
                    </button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      </Card>

      {rejected.length > 0 ? (
        <Card>
          <CardHeader
            title="বাতিলকৃত আবেদন (Rejected Requests)"
            subtitle={`${toBanglaNumber(rejected.length)}টি আবেদন`}
          />
          <ul className="divide-y divide-slate-100 dark:divide-slate-800">
            {rejected.map((member) => {
              const busy = busyId === member.uid;
              return (
                <li key={member.uid} className="flex flex-wrap items-center justify-between gap-3 py-3">
                  <MemberMeta member={member} />
                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      className="btn-emerald btn-sm"
                      disabled={busy}
                      onClick={() => act(member, 'status', MEMBER_STATUS.APPROVED)}
                    >
                      {busy ? <Loader2 size={14} className="animate-spin" /> : <RotateCcw size={14} />} পুনরায় অনুমোদন
                    </button>
                    <button
                      type="button"
                      className="btn-secondary btn-sm"
                      disabled={busy}
                      onClick={() => confirmRemove(member)}
                    >
                      <UserRoundX size={14} /> সরিয়ে ফেলুন
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        </Card>
      ) : null}
    </div>
  );
}