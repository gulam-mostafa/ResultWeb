import { useEffect, useId, useMemo, useState } from 'react';
import { UserPlus } from 'lucide-react';
import Modal from '../ui/Modal.jsx';
import { CLASS_LEVELS } from '../../utils/constants.js';
import { DEFAULT_SECTION_ID } from '../../services/database/dbPaths.js';

const emptyForm = (classId = 'pre', section = DEFAULT_SECTION_ID) => ({
  name: '', roll: '', classId, section,
  admissionYear: String(new Date().getFullYear()), gender: 'male',
  birthDate: '', birthCertificateNo: '', fatherName: '', fatherPhone: '', motherName: '',
  motherPhone: '', guardianNid: '', address: '',
});
const fields = [
  ['admissionYear', 'ভর্তির সাল', 'number'],
  ['birthDate', 'জন্ম তারিখ', 'date'],
  ['birthCertificateNo', 'জন্ম নিবন্ধন নম্বর', 'text'],
  ['fatherName', 'পিতার নাম', 'text'],
  ['fatherPhone', 'পিতার মোবাইল নম্বর', 'tel'],
  ['motherName', 'মাতার নাম', 'text'],
  ['motherPhone', 'মাতার মোবাইল নম্বর', 'tel'],
  ['guardianNid', 'অভিভাবকের ভোটার আইডি', 'text'],
];

export default function AddStudentModal({ open, onClose, onSave, defaultClass = 'pre', student = null, onArchive, sectionOptions = [] }) {
  const [form, setForm] = useState(() => emptyForm(defaultClass));
  const [error, setError] = useState('');
  const editing = Boolean(student);
  // The page renders two instances (admission + edit), so the suggestion list needs
  // its own id — a duplicated `id` would silently point both inputs at one list.
  const sectionListId = useId();

  useEffect(() => {
    if (!open) return;
    setForm(student ? {
      ...emptyForm(defaultClass),
      ...student,
      classId: student.classId === 'archive' ? (student.previousClassId || defaultClass) : student.classId,
      // শাখা stays a free-form label: an existing (possibly custom) section is kept.
      section: String(student.section || student.previousSectionId || DEFAULT_SECTION_ID),
      roll: student.roll ?? '',
      admissionYear: String(student.admissionYear ?? student.admissionDate?.slice?.(0, 4) ?? new Date().getFullYear()),
      fatherPhone: student.fatherPhone ?? (student.guardianPhone ?? ''),
      motherPhone: student.motherPhone ?? '',
      guardianNid: student.guardianNid ?? '',
    } : emptyForm(defaultClass));
    setError('');
  }, [open, defaultClass, student?.id]);

  const change = (event) => setForm((previous) => ({ ...previous, [event.target.name]: event.target.value }));
  // Any number of শাখা per class is allowed: `ক` plus every section the class already
  // uses are offered as suggestions, but the field stays typeable (`ক`, `খ`, `গ`, …).
  const sectionSuggestions = useMemo(
    () => [...new Set([DEFAULT_SECTION_ID, ...sectionOptions.map((item) => String(item).trim())])].filter(Boolean),
    [sectionOptions],
  );
  const sectionValue = form.section ?? DEFAULT_SECTION_ID;
  const submit = (event) => {
    event.preventDefault();
    if (!form.name.trim()) { setError('শিক্ষার্থীর নাম লিখুন।'); return; }
    if (!Number(form.roll) || Number(form.roll) < 1) { setError('সঠিক রোল নম্বর লিখুন।'); return; }
    const admissionYear = String(form.admissionYear || new Date().getFullYear());
    // A blank শাখা falls back to `ক`; a typed one is stored exactly as entered.
    const section = String(form.section ?? '').trim() || DEFAULT_SECTION_ID;
    onSave({ ...form, section, id: student?.id, name: form.name.trim(), roll: Number(form.roll), admissionYear, admissionDate: `${admissionYear}-01-01` });
    setError('');
    onClose();
  };

  return <Modal open={open} onClose={onClose} title={editing ? 'শিক্ষার্থীর তথ্য সম্পাদনা' : 'নতুন শিক্ষার্থী ভর্তি'} subtitle="শিক্ষার্থীর সম্পূর্ণ তথ্য পূরণ করুন" icon={UserPlus} size="lg">
    <form onSubmit={submit} className="grid gap-3 sm:grid-cols-2">
      <label><span className="label-base">শিক্ষার্থীর নাম *</span><input autoFocus name="name" className="input-base" value={form.name} onChange={change} /></label>
      <label><span className="label-base">রোল *</span><input name="roll" type="number" min="1" className="input-base" value={form.roll} onChange={change} /></label>
      <label><span className="label-base">শ্রেণি</span><select className="input-base" name="classId" value={form.classId} onChange={change}>{CLASS_LEVELS.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
      <label>
        <span className="label-base">শাখা</span>
        <input name="section" className="input-base" list={sectionListId} value={sectionValue} onChange={change} placeholder={DEFAULT_SECTION_ID} />
        <datalist id={sectionListId}>{sectionSuggestions.map((item) => <option key={item} value={item}>{item}</option>)}</datalist>
      </label>
      <label><span className="label-base">লিঙ্গ</span><select className="input-base" name="gender" value={form.gender} onChange={change}><option value="male">ছাত্র</option><option value="female">ছাত্রী</option></select></label>
      {fields.map(([name, label, type]) => <label key={name}><span className="label-base">{label}</span><input className="input-base" name={name} type={type} value={form[name] ?? ''} onChange={change} /></label>)}
      <label className="sm:col-span-2"><span className="label-base">ঠিকানা</span><textarea className="input-base min-h-20" name="address" value={form.address ?? ''} onChange={change} /></label>
      {error && <p className="text-xs text-rose-600 sm:col-span-2">{error}</p>}
      <div className="flex flex-wrap justify-between gap-2 sm:col-span-2">
        {editing && student?.classId !== 'archive' && <button type="button" className="btn-secondary border-rose-200 text-rose-700 hover:bg-rose-50" onClick={() => onArchive?.(student)}>অপসারণ / আর্কাইভে পাঠান</button>}
        <div className="ml-auto flex gap-2"><button type="button" className="btn-secondary" onClick={onClose}>বাতিল</button><button className="btn-primary" type="submit">{editing ? 'তথ্য সংরক্ষণ' : 'ভর্তি সম্পন্ন করুন'}</button></div>
      </div>
    </form>
  </Modal>;
}

