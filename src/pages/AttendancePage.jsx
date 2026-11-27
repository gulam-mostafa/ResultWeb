import { useMemo, useState } from 'react';
import { CalendarCheck, Save } from 'lucide-react';
import { useAuth } from '../context/AuthContext.jsx';
import { useSchoolData } from '../context/SchoolDataContext.jsx';
import { useAttendance } from '../hooks/useAttendance.js';
import { Card, CardHeader } from '../components/ui/Primitives.jsx';
import { useToast } from '../components/ui/Toast.jsx';
import { toBanglaNumber } from '../utils/banglaNumberFormatter.js';

const today = () => new Date().toISOString().slice(0, 10);
const STATUS_LABELS = { present: 'উপস্থিত', absent: 'অনুপস্থিত', late: 'বিলম্বে', excused: 'ছুটি' };

export default function AttendancePage() {
  const { user, canManageStudents } = useAuth();
  const { studentsByClass, viewYear, isReadOnly, isClassLocked } = useSchoolData();
  const toast = useToast();
  const [classId, setClassId] = useState('pre');
  const [date, setDate] = useState(today);
  const students = useMemo(() => studentsByClass[classId] || [], [studentsByClass, classId]);
  // A past year — or a class whose promotion is complete — is view-only: the
  // hook's cloud write is refused and the selects/save below are disabled.
  const classLocked = isClassLocked(classId);
  const canWriteAttendance = canManageStudents && !isReadOnly && !classLocked;
  const {
    setStatus,
    statusOf,
    save,
    saving,
    notice,
    draftCount,
  } = useAttendance({
    schoolId: user?.schoolId || '',
    user,
    date,
    activeYear: viewYear,
    canWriteTenant: canWriteAttendance,
  });

  const options = Object.entries(STATUS_LABELS);
  return <div className="space-y-4">
    <header><h1 className="text-xl font-extrabold">দৈনিক উপস্থিতি</h1><p className="mt-1 text-sm text-slate-500">বিদ্যালয়ের সব অনুমোদিত শিক্ষক একই উপস্থিতির তথ্য দেখতে ও সম্পাদনা করতে পারবেন।</p></header>
    <Card>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="grid flex-1 gap-3 sm:grid-cols-2">
          <label><span className="label-base">তারিখ</span><input type="date" className="input-base" value={date} onChange={(event) => setDate(event.target.value)} /></label>
          <label><span className="label-base">শ্রেণি</span><select className="input-base" value={classId} onChange={(event) => setClassId(event.target.value)}>{Object.entries(studentsByClass).filter(([id]) => id !== 'archive').map(([id, list]) => <option key={id} value={id}>{list?.[0]?.className || id.toUpperCase()}</option>)}</select></label>
        </div>
        <button
          type="button"
          className="btn-primary"
          disabled={saving || !canWriteAttendance || !draftCount}
          title={classLocked ? 'এই শ্রেণির প্রমোশন সম্পূর্ণ হয়েছে — উপস্থিতি সংরক্ষণ করা যাবে না' : undefined}
          onClick={async () => {
            const result = await save();
            if (result?.synced) toast.success('সংরক্ষণ হয়েছে');
            else toast.error('সংরক্ষণ করা যায়নি — আবার চেষ্টা করুন');
          }}
        >
          <Save size={15}/>{saving ? 'সংরক্ষণ হচ্ছে…' : `উপস্থিতি সংরক্ষণ (${draftCount})`}
        </button>
      </div>
      {notice && <p role="status" className="mt-3 rounded-lg bg-brand-50 p-3 text-sm text-brand-800 dark:bg-brand-900/30 dark:text-brand-200">{notice}</p>}
    </Card>
    <Card padded={false}>
      <CardHeader title="শিক্ষার্থী তালিকা" subtitle={`${toBanglaNumber(students.length)} জন`} icon={CalendarCheck} className="p-4 pb-0" />
      {!students.length ? <p className="p-5 text-sm text-slate-500">এই শ্রেণিতে শিক্ষার্থী নেই।</p> : <div className="overflow-x-auto"><table className="table-base"><thead><tr><th>রোল</th><th>শিক্ষার্থীর নাম</th><th>উপস্থিতি</th></tr></thead><tbody>{students.map((student) => {
        const selected = statusOf(student.id);
        return <tr key={student.id}><td>{toBanglaNumber(student.roll)}</td><td className="font-semibold">{student.name}</td><td><select className="input-base max-w-48" value={selected} disabled={!canWriteAttendance} onChange={(event) => setStatus(student.id, event.target.value)}><option value="">নির্বাচন করুন</option>{options.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></td></tr>;
      })}</tbody></table></div>}
    </Card>
  </div>;
}
