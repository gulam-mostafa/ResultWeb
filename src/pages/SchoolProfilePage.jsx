import { useEffect, useMemo, useRef, useState } from 'react';
import { Save } from 'lucide-react';
import { useAuth } from '../context/AuthContext.jsx';
import { useSchoolData } from '../context/SchoolDataContext.jsx';
import { BD_LOCATIONS, findGeoNames } from '../data/bdLocations.js';
import { normalizeSchoolProfile, pickProfileFields } from '../utils/schoolProfile.js';
import { Card } from '../components/ui/Primitives.jsx';

const FIELD_DEFS = [
  ['name','বিদ্যালয়ের নাম','text'],['nameEn','বিদ্যালয়ের নাম (ইংরেজি)','text'],
  ['villageOrUnion','গ্রাম / ইউনিয়ন','text'],['emisCode','ইএমআইএস কোড','text'],
  ['establishedYear','প্রতিষ্ঠার বছর','text'],['academicYear','শিক্ষাবর্ষ','text'],
  ['motto','বিদ্যালয়ের মূলমন্ত্র','text'],['phone','ফোন','tel'],['email','ইমেইল','email'],
  ['website','ওয়েবসাইট','url'],['headTeacher','প্রধান শিক্ষকের নাম','text'],
];

export default function SchoolProfilePage() {
  const { user, canManageStudents } = useAuth();
  const { schoolProfile, saveProfile } = useSchoolData();
  const [form, setForm] = useState(() => normalizeSchoolProfile(schoolProfile));
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState('');
  const editing = useRef(false);
  const editRevision = useRef(0);
  const dirtyFields = useRef(new Set());

  useEffect(() => {
    setForm((previous) => {
      const incoming = normalizeSchoolProfile(schoolProfile);
      const merged = { ...incoming };
      dirtyFields.current.forEach((field) => { merged[field] = previous[field]; });
      const focusedField = document.activeElement?.getAttribute?.('data-profile-field');
      if (focusedField) merged[focusedField] = previous[focusedField];
      return merged;
    });
  }, [schoolProfile]);

  const districts = useMemo(() => BD_LOCATIONS.find((item) => item.id === form.divisionId)?.districts || [], [form.divisionId]);
  const upazilas = useMemo(() => districts.find((item) => item.id === form.districtId)?.upazilas || [], [districts, form.districtId]);
  const setField = (key, value) => {
    editing.current = true;
    editRevision.current += 1;
    const fieldKey = key === 'upazilaId' ? 'upazilaId' : key;
    dirtyFields.current.add(fieldKey);
    if (key === 'upazilaId') {
      const item = upazilas.find((entry) => entry.id === value);
      setForm((previous) => ({ ...previous, upazilaId: item?.id || '', upazilaName: item?.name || '' }));
      return;
    }
    setForm((previous) => ({ ...previous, [key]: value }));
  };
  const setDivision = (divisionId) => {
    editRevision.current += 1;
    ['divisionId', 'divisionName', 'districtId', 'districtName', 'upazilaId', 'upazilaName'].forEach((field) => dirtyFields.current.add(field));
    const division = BD_LOCATIONS.find((item) => item.id === divisionId);
    const district = division?.districts?.[0];
    setForm((previous) => ({ ...previous, divisionId, divisionName: division?.name || '', districtId: district?.id || '', districtName: district?.name || '', upazilaId: district?.upazilas?.[0]?.id || '', upazilaName: district?.upazilas?.[0]?.name || '' }));
    editing.current = true;
  };
  const setDistrict = (districtId) => {
    editRevision.current += 1;
    ['districtId', 'districtName', 'upazilaId', 'upazilaName'].forEach((field) => dirtyFields.current.add(field));
    const district = districts.find((item) => item.id === districtId);
    const upazila = district?.upazilas?.[0];
    setForm((previous) => ({ ...previous, districtId, districtName: district?.name || '', upazilaId: upazila?.id || '', upazilaName: upazila?.name || '' }));
    editing.current = true;
  };
  const save = async (event) => {
    event.preventDefault();
    if (!canManageStudents || saving) return;
    setSaving(true); setNotice('');
    const revision = editRevision.current;
    const submitted = { ...form };
    const names = findGeoNames(submitted.divisionId, submitted.districtId, submitted.upazilaId);
    const patch = pickProfileFields({ ...submitted, ...names, id: user?.schoolId });
    let result = { synced: false };
    try {
      result = await Promise.race([
        saveProfile(patch),
        new Promise((resolve) => setTimeout(() => resolve({ synced: false, timedOut: true }), 3000)),
      ]);
      setNotice(result.synced ? 'বিদ্যালয়ের প্রোফাইল সংরক্ষিত হয়েছে।' : 'প্রোফাইল সংরক্ষণ করা যায়নি। সংযোগ পরীক্ষা করে আবার চেষ্টা করুন।');
      if (result.synced) {
        Object.keys(patch).forEach((field) => {
          if (editRevision.current === revision || !dirtyFields.current.has(field)) dirtyFields.current.delete(field);
        });
        setForm((previous) => {
          const merged = normalizeSchoolProfile({ ...previous, ...patch });
          dirtyFields.current.forEach((field) => { merged[field] = previous[field]; });
          return merged;
        });
        editing.current = dirtyFields.current.size > 0;
      }
    } catch {
      setNotice('প্রোফাইল সংরক্ষণ করা যায়নি। সংযোগ পরীক্ষা করে আবার চেষ্টা করুন।');
    } finally {
      setSaving(false);
    }
  };

  return <div className="mx-auto max-w-4xl space-y-4">
    <header><h1 className="text-xl font-extrabold">বিদ্যালয় প্রোফাইল ও তথ্য আপডেট (School Profile)</h1><p className="mt-1 text-sm text-slate-500">এই বিদ্যালয়ের অনুমোদিত যেকোনো শিক্ষক প্রোফাইল সম্পাদনা করতে পারবেন।</p></header>
    <Card><form onSubmit={save} className="space-y-5 p-5">
      <div className="grid gap-4 sm:grid-cols-2">
        <label><span className="label-base">বিভাগ</span><select className="input-base" data-profile-field="divisionId" value={form.divisionId || ''} onChange={(event) => setDivision(event.target.value)}><option value="">বিভাগ নির্বাচন</option>{BD_LOCATIONS.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
        <label><span className="label-base">জেলা</span><select className="input-base" data-profile-field="districtId" value={form.districtId || ''} onChange={(event) => setDistrict(event.target.value)}><option value="">জেলা নির্বাচন</option>{districts.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
        <label><span className="label-base">উপজেলা</span><select className="input-base" data-profile-field="upazilaId" value={form.upazilaId || ''} onChange={(event) => setField('upazilaId', event.target.value)}><option value="">উপজেলা নির্বাচন</option>{upazilas.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
        {FIELD_DEFS.map(([key,label,type]) => <label key={key}><span className="label-base">{label}</span><input className="input-base" data-profile-field={key} type={type} value={form[key] || ''} onChange={(event) => setField(key, event.target.value)} /></label>)}
      </div>
      {notice && <p role="status" className="rounded-lg bg-emerald-50 p-3 text-sm text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-200">{notice}</p>}
      <button type="submit" className="btn-primary" disabled={saving || !canManageStudents}><Save size={16}/>{saving ? 'সংরক্ষণ হচ্ছে…' : 'প্রোফাইল সংরক্ষণ করুন'}</button>
    </form></Card>
  </div>;
}
