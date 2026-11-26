import { GraduationCap, School } from 'lucide-react';
import { BD_LOCATIONS } from '../../data/bdLocations.js';

const ROLE_CARD_OPTIONS = Object.freeze([
  { id: 'teacher', Icon: School, label: 'শিক্ষক' },
  { id: 'student', Icon: GraduationCap, label: 'শিক্ষার্থী / অভিভাবক' },
]);

export function Field({ label, ...props }) {
  return <label className="block"><span className="label-base">{label}</span><input className="input-base" {...props} /></label>;
}

export function Directory({ value = {}, onChange = () => {}, schools = [], allowAdd = false, adding = false, onAdd = () => {}, newName = '', setNewName = () => {} }) {
  const safeValue = value && typeof value === 'object' ? value : {};
  const safeLocations = Array.isArray(BD_LOCATIONS) ? BD_LOCATIONS : [];
  const safeSchools = Array.isArray(schools) ? schools.filter(Boolean) : [];
  const division = safeLocations.find((item) => item?.id === safeValue.divisionId);
  const districts = Array.isArray(division?.districts) ? division.districts : [];
  const district = districts.find((item) => item?.id === safeValue.districtId);
  const upazilas = Array.isArray(district?.upazilas) ? district.upazilas : [];
  const changeDivision = (divisionId) => {
    const next = safeLocations.find((item) => item?.id === divisionId);
    const nextDistricts = Array.isArray(next?.districts) ? next.districts : [];
    const firstDistrict = nextDistricts[0];
    const nextUpazilas = Array.isArray(firstDistrict?.upazilas) ? firstDistrict.upazilas : [];
    onChange({ divisionId, districtId: firstDistrict?.id ?? '', upazilaId: nextUpazilas[0]?.id ?? '', schoolId: '' });
  };
  const changeDistrict = (districtId) => {
    const next = districts.find((item) => item?.id === districtId);
    const nextUpazilas = Array.isArray(next?.upazilas) ? next.upazilas : [];
    onChange({ ...safeValue, districtId, upazilaId: nextUpazilas[0]?.id ?? '', schoolId: '' });
  };
  return <div className="space-y-3">
    <div className="grid gap-3 sm:grid-cols-3">
      <label><span className="label-base">বিভাগ</span><select className="input-base" value={safeValue.divisionId ?? ''} onChange={(e) => changeDivision(e.target.value)}>{safeLocations.filter((item) => item && item.id).map((item) => <option key={item.id} value={item.id}>{item?.name ?? ''}</option>)}</select></label>
      <label><span className="label-base">জেলা</span><select className="input-base" value={safeValue.districtId ?? ''} onChange={(e) => changeDistrict(e.target.value)}>{districts.filter(Boolean).map((item) => <option key={item.id} value={item.id}>{item?.name ?? ''}</option>)}</select></label>
      <label><span className="label-base">উপজেলা</span><select className="input-base" value={safeValue.upazilaId ?? ''} onChange={(e) => onChange({ ...safeValue, upazilaId: e.target.value, schoolId: '' })}>{upazilas.filter(Boolean).map((item) => <option key={item.id} value={item.id}>{item?.name ?? ''}</option>)}</select></label>
    </div>
    <label className="block"><span className="label-base">বিদ্যালয়ের নাম</span><select className="input-base" value={adding ? '__new__' : (safeValue.schoolId ?? '')} onChange={(e) => e.target.value === '__new__' ? onAdd() : onChange({ ...safeValue, schoolId: e.target.value })}>
      <option value="">বিদ্যালয় নির্বাচন করুন</option>{safeSchools.filter((school) => school?.id).map((school) => <option key={school.id} value={school.id}>{school?.name ?? 'নামহীন বিদ্যালয়'}</option>)}{allowAdd && <option value="__new__">+ নতুন বিদ্যালয় যুক্ত করুন</option>}
    </select></label>
    {adding && allowAdd && <Field label="নতুন বিদ্যালয়ের নাম" value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="বিদ্যালয়ের পূর্ণ নাম" />}
  </div>;
}

export function RoleCards({ kind, onChange }) {
  return (
    <div className="grid grid-cols-2 gap-2">
      {(ROLE_CARD_OPTIONS || []).map(({ id, Icon, label }) => (
        <button type="button" key={id} onClick={() => onChange(id)} aria-pressed={kind === id}
          className={`flex items-center justify-center gap-2 rounded-xl border px-3 py-3 text-sm font-bold ${kind === id ? 'border-brand-600 bg-brand-50 text-brand-800 dark:bg-brand-900/30 dark:text-brand-200' : 'border-slate-200 text-slate-600 dark:border-slate-700 dark:text-slate-300'}`}>
          {Icon ? <Icon size={17} /> : null}{label}
        </button>
      ))}
    </div>
  );
}

export function AuthFormActions({ notice = '', isSubmitting = false, submitLabel = '' }) {
  return <>
    {notice ? <p role="alert" className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700 dark:bg-rose-950/40 dark:text-rose-300">{notice}</p> : null}
    <button type="submit" disabled={isSubmitting} className="btn-primary w-full justify-center py-3 disabled:opacity-60">{isSubmitting ? 'অপেক্ষা করুন...' : submitLabel}</button>
  </>;
}

/**
 * Quick social login — REMOVED (2026-11-27). The Google/Facebook buttons used
 * to call `onBypass` (passwordless bypass login), and no real OAuth handler
 * exists anywhere in this codebase. `bypassLogin()` itself was also removed
 * from AuthContext, so this export is deleted — LoginForm/SignUpForm no longer
 * render it. Re-add these buttons only together with a real `signInWithPopup`
 * handler.
 */
