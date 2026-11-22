import { useEffect, useId, useMemo, useState } from 'react';
import { UserPlus } from 'lucide-react';
import Modal from '../ui/Modal.jsx';
import {
  CLASS_CHANGE_MODE, CLASS_LEVELS, NEXT_CLASS_MAP, PREV_CLASS_MAP, getClassName,
} from '../../utils/constants.js';
import { DEFAULT_SECTION_ID } from '../../services/database/dbPaths.js';
import { toBanglaNumber } from '../../utils/banglaNumberFormatter.js';
import {
  DEFAULT_SECTION_LABEL,
  cleanSectionLabel,
  nextFreeRollInBucket,
  resolveRollAssignment,
} from '../../utils/rollAssignment.js';

/** শাখা of a roster row (a blank value belongs to the default `ক`). */
const sectionOf = (student) => cleanSectionLabel(student?.section, DEFAULT_SECTION_LABEL);

/** `true` when the class id is one of the six active classes. */
const isActiveClass = (classId) => CLASS_LEVELS.some((item) => item.id === classId);

/**
 * The class a pupil moves to for one of the three individual decisions:
 *  - `stay`    → the class chosen in the শ্রেণি select;
 *  - `promote` → the next class (`c5` graduates into `archive`);
 *  - `demote`  → one class down (`pre` has no lower class, so it stays put).
 */
export function classChangeTarget(currentClassId, mode = CLASS_CHANGE_MODE.STAY, stayClassId = currentClassId) {
  if (mode === CLASS_CHANGE_MODE.PROMOTE) return NEXT_CLASS_MAP[currentClassId] ?? currentClassId;
  if (mode === CLASS_CHANGE_MODE.DEMOTE) return PREV_CLASS_MAP[currentClassId] ?? currentClassId;
  return stayClassId || currentClassId;
}

/**
 * Next free roll number in one class + শাখা, so a moved pupil never collides with a
 * roll already in use in the destination folder.
 */
export function nextFreeRoll(roster = [], { classId, section, ignoreId } = {}) {
  return nextFreeRollInBucket(roster, {
    classId,
    section: cleanSectionLabel(section),
    ignoreIds: ignoreId ? [ignoreId] : [],
  });
}


/**
 * A duplicate roll means the SAME roll number inside the SAME class AND the SAME
 * শাখা. A pupil in `২য় শ্রেণি/ক` with roll ৫ therefore does NOT conflict with roll ৫
 * in `২য় শ্রেণি/খ` or in `১ম শ্রেণি/ক` — only the exact class+section pair matters.
 *
 * @param {Array<object>} roster every pupil of the school
 * @param {{classId?:string, section?:string, roll?:string|number, ignoreId?:string}} candidate
 * @returns {object|null} the conflicting pupil, or `null`
 */
export function findDuplicateRoll(roster = [], candidate = {}) {
  const classId = String(candidate.classId ?? '').trim();
  const section = String(candidate.section ?? '').trim() || DEFAULT_SECTION_ID;
  const roll = Number(candidate.roll);
  if (!classId || !Number.isFinite(roll) || roll < 1) return null;
  return (Array.isArray(roster) ? roster : []).find((student) => {
    if (!student || student.id === candidate.ignoreId) return false;
    if (String(student.classId ?? '').trim() !== classId) return false;
    if (sectionOf(student) !== section) return false;
    return Number(student.roll) === roll;
  }) ?? null;
}

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

export default function AddStudentModal({ open, onClose, onSave, defaultClass = 'pre', student = null, onArchive, sectionOptions = [], roster = [], getSectionsOfClass }) {
  const [form, setForm] = useState(() => emptyForm(defaultClass));
  const [error, setError] = useState('');
  // Individual উত্তরণ / শ্রেণি পরিবর্তন (edit only). `stay` is the no-op default, so a
  // plain edit of a pupil's details never moves them.
  const [classChange, setClassChange] = useState({
    mode: CLASS_CHANGE_MODE.STAY,
    section: DEFAULT_SECTION_ID,
    roll: '',
  });
  const editing = Boolean(student);
  // The class the pupil sits in today (an archived pupil belongs to the class they left).
  const currentClassId = student?.classId === 'archive'
    ? (student?.previousClassId || defaultClass)
    : (student?.classId || defaultClass);
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
    // A fresh pupil is never pre-promoted: the individual move always starts as `stay`
    // and its segment selector always defaults to `ক`.
    setClassChange({ mode: CLASS_CHANGE_MODE.STAY, section: DEFAULT_SECTION_ID, roll: '' });
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

  /* ---- Individual উত্তরণ / শ্রেণি পরিবর্তন (destination class + শাখা) -------- */
  const classChangeClassId = classChangeTarget(currentClassId, classChange.mode, form.classId);
  const classChangeSection = cleanSectionLabel(classChange.section);
  const classChangeSectionOptions = useMemo(() => {
    const declared = typeof getSectionsOfClass === 'function' ? getSectionsOfClass(classChangeClassId) : [];
    const used = roster
      .filter((item) => String(item.classId ?? '').trim() === String(classChangeClassId ?? '').trim())
      .map((item) => sectionOf(item));
    return [...new Set([DEFAULT_SECTION_ID, ...declared, ...used].map(cleanSectionLabel))]
      .sort((left, right) => (left === DEFAULT_SECTION_ID ? -1 : right === DEFAULT_SECTION_ID ? 1 : left.localeCompare(right, 'bn')));
  }, [getSectionsOfClass, classChangeClassId, roster]);
  const promoteClassId = NEXT_CLASS_MAP[currentClassId] ?? currentClassId;
  const demoteClassId = PREV_CLASS_MAP[currentClassId] ?? '';
  /** `শ্রেণির নাম` of a destination — the archive is a place, not a শ্রেণি. */
  const classLabelOf = (targetClassId) => (isActiveClass(targetClassId) ? getClassName(targetClassId) : 'আর্কাইভ');
  const classChangeLabel = classLabelOf(classChangeClassId);
  // The section only exists for an active pupil: an archived pupil is restored, not promoted.
  const showClassChange = editing && student?.classId !== 'archive';
  const classChangeSuggestId = `${sectionListId}-promotion`;

  /**
   * Live duplicate check — ONLY the same `classId` + `sectionId` pair is compared,
   * so typing roll ৫ in `২য়/খ` while `২য়/ক` already holds roll ৫ is allowed.
   */
  const duplicate = useMemo(
    () => findDuplicateRoll(roster, {
      classId: form.classId,
      section: sectionValue,
      roll: form.roll,
      ignoreId: student?.id,
    }),
    [roster, form.classId, sectionValue, form.roll, student?.id],
  );
  const submit = (event) => {
    event.preventDefault();
    if (!form.name.trim()) { setError('শিক্ষার্থীর নাম লিখুন।'); return; }
    if (!Number(form.roll) || Number(form.roll) < 1) { setError('সঠিক রোল নম্বর লিখুন।'); return; }
    const admissionYear = String(form.admissionYear || new Date().getFullYear());
    // A blank শাখা falls back to `ক`; a typed one is stored exactly as entered.
    const section = String(form.section ?? '').trim() || DEFAULT_SECTION_ID;

    /* ---- Individual উত্তরণ: only `promote` / `demote` actually move the pupil. ---
     * `stay` sends the form's own শ্রেণি/শাখা, i.e. the plain edit path — so an edit
     * that never touches the promotion choice behaves exactly as before. A promote
     * topple: `c5` ➔ `archive`, which the hook archives through `passedArchive`.
     * ------------------------------------------------------------------------ */
    const moving = editing && classChange.mode !== CLASS_CHANGE_MODE.STAY;
    const targetClassId = moving ? classChangeClassId : form.classId;
    const targetSection = moving ? classChangeSection : section;

    // Duplicate roll: same class AND same শাখা only. A different class or a different
    // শাখা is always accepted.
    const clash = findDuplicateRoll(roster, {
      classId: targetClassId, section: targetSection, roll: form.roll, ignoreId: student?.id,
    });
    /* ---- Roll of the destination row -------------------------------------------
     * `এক শ্রেণি নিচে যাবে` always lands at the very END of the target list (next
     * number after the highest existing roll), so a demotion can never duplicate an
     * existing roll. A promotion / শাখা change keeps the pupil's own number only when
     * it is still free in the destination folder, otherwise it also moves to the end.
     * Changing the শ্রেণি/শাখা through the main selects is the same relocation, so it
     * is resolved the same way. A plain same-folder edit keeps the typed roll (and
     * still reports a clash instead of silently duplicating it).
     * ------------------------------------------------------------------------- */
    const demoting = classChange.mode === CLASS_CHANGE_MODE.DEMOTE;
    const relocating = editing && (
      String(targetClassId ?? '').trim() !== String(currentClassId ?? '').trim()
      || targetSection !== cleanSectionLabel(student?.section)
    );
    // A NEW admission is a placement too: a typed roll that is already taken is
    // resolved to the next free number instead of being rejected, so admitting a
    // pupil can never create a duplicate roll.
    const admitting = !editing;
    const assigning = moving || relocating || admitting;
    const archiving = targetClassId === 'archive';
    let targetRoll = Number(form.roll) || 0;
    if (assigning && !archiving) {
      targetRoll = resolveRollAssignment(roster, {
        classId: targetClassId,
        section: targetSection,
        roll: form.roll,
        ignoreIds: [student?.id],
        placement: demoting ? 'end' : 'preferred',
      });
    }
    // A same-folder edit of an EXISTING pupil keeps the typed roll and reports the
    // clash, because the teacher explicitly asked for that number.
    if (clash && !assigning) {
      const className = CLASS_LEVELS.find((item) => item.id === form.classId)?.name ?? form.classId;
      setError(`${className} শ্রেণির "${section}" শাখায় ${toBanglaNumber(clash.roll)} রোল ইতিমধ্যে ${clash.name} এর নামে আছে। অন্য রোল দিন, অথবা শ্রেণি/শাখা বদলান।`);
      return;
    }

    // Promotion metadata of the destination row: an upward move is a fresh `উত্তীর্ণ`
    // rows (badge + "নতুন উত্তীর্ণ" tag), a downward move clears any earlier stamp so a
    // demoted pupil is never listed as freshly promoted.
    const promotionYear = String(student?.year || student?.session || new Date().getFullYear());
    const promotionPatch = moving
      ? (classChange.mode === CLASS_CHANGE_MODE.PROMOTE
        ? {
          promotedAt: new Date().toISOString(),
          promotedFromClass: currentClassId,
          promotedFromYear: promotionYear,
          isNewPromotion: true,
        }
        : {
          promotedAt: null,
          promotedFromClass: null,
          promotedFromYear: null,
          isNewPromotion: false,
        })
      : {};

    onSave({
      ...form,
      section: targetSection,
      classId: targetClassId,
      roll: Number(targetRoll) || 1,
      id: student?.id,
      name: form.name.trim(),
      admissionYear,
      admissionDate: `${admissionYear}-01-01`,
      ...(moving ? { ...promotionPatch, previousClassId: currentClassId } : {}),
    });
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
      {/* Individual উত্তরণ / শ্রেণি পরিবর্তন — edit only, never shown for an archived pupil. */}
      {showClassChange && <section className="sm:col-span-2 rounded-xl border border-slate-200 bg-slate-50/60 p-3 dark:border-slate-700 dark:bg-slate-800/40">
        <p className="mb-2 text-xs font-bold">শ্রেণি পরিবর্তন (ব্যক্তিগত উত্তরণ)</p>
        <div className="grid gap-2 sm:grid-cols-2">
          <label>
            <span className="label-base">সিদ্ধান্ত</span>
            <select
              className="input-base"
              name="classChangeMode"
              value={classChange.mode}
              onChange={(event) => setClassChange((previous) => ({ ...previous, mode: event.target.value }))}
            >
              <option value={CLASS_CHANGE_MODE.STAY}>এই শ্রেণিতেই থাকুক</option>
              <option value={CLASS_CHANGE_MODE.PROMOTE}>উত্তীর্ণ ({classLabelOf(promoteClassId)})</option>
              <option value={CLASS_CHANGE_MODE.DEMOTE} disabled={!demoteClassId}>
                এক শ্রেণি নিচে যাবে{demoteClassId ? ` (${classLabelOf(demoteClassId)})` : ' — নিচে কোনো শ্রেণি নেই'}
              </option>
            </select>
          </label>
          <label>
            <span className="label-base">নতুন শাখা</span>
            <input
              className="input-base"
              name="classChangeSection"
              list={classChangeSuggestId}
              value={classChangeSection}
              onChange={(event) => setClassChange((previous) => ({ ...previous, section: event.target.value }))}
              placeholder={DEFAULT_SECTION_ID}
              disabled={classChange.mode === CLASS_CHANGE_MODE.STAY}
            />
            <datalist id={classChangeSuggestId}>{classChangeSectionOptions.map((item) => <option key={item} value={item}>{item}</option>)}</datalist>
          </label>
        </div>
        <p className="mt-2 text-[11px] text-slate-500">
          {classChange.mode === CLASS_CHANGE_MODE.STAY
            ? `শিক্ষার্থী ${classLabelOf(currentClassId)} শ্রেণিতেই (${sectionValue} শাখা) থাকবে — উপরের শ্রেণি/শাখা বদলালে সেটিই সংরক্ষিত হবে।`
            : `শিক্ষার্থী ${classChangeLabel} শ্রেণির “${classChangeSection}” শাখায় নতুন রোলসহ সংরক্ষিত হবে, ${classLabelOf(currentClassId)} শ্রেণির পুরোনো তালিকা থেকে সরে যাবে এবং studentMaster হালনাগাদ হবে।`}
          {classChange.mode === CLASS_CHANGE_MODE.PROMOTE && classChangeClassId === 'archive'
            ? ' ৫ম শ্রেণির উত্তীর্ণরা এই বছরের passedArchive-এ সংরক্ষিত হবে।'
            : ''}
        </p>
      </section>}
      <label><span className="label-base">লিঙ্গ</span><select className="input-base" name="gender" value={form.gender} onChange={change}><option value="male">ছাত্র</option><option value="female">ছাত্রী</option></select></label>
      {fields.map(([name, label, type]) => <label key={name}><span className="label-base">{label}</span><input className="input-base" name={name} type={type} value={form[name] ?? ''} onChange={change} /></label>)}
      <label className="sm:col-span-2"><span className="label-base">ঠিকানা</span><textarea className="input-base min-h-20" name="address" value={form.address ?? ''} onChange={change} /></label>
      {duplicate && !error && <p role="status" className="rounded-lg bg-amber-50 p-2.5 text-xs font-semibold text-amber-800 sm:col-span-2 dark:bg-amber-900/30 dark:text-amber-200">একই শ্রেণি ও শাখায় ({CLASS_LEVELS.find((item) => item.id === form.classId)?.name ?? form.classId} · {sectionValue}) {toBanglaNumber(duplicate.roll)} রোল ইতিমধ্যে {duplicate.name} এর নামে আছে। ভিন্ন শাখা বা ভিন্ন শ্রেণিতে এই রোলটি ব্যবহার করা যাবে।</p>}
      {error && <p className="text-xs text-rose-600 sm:col-span-2">{error}</p>}
      <div className="flex flex-wrap justify-between gap-2 sm:col-span-2">
        {editing && student?.classId !== 'archive' && <button type="button" className="btn-secondary border-rose-200 text-rose-700 hover:bg-rose-50" onClick={() => onArchive?.(student)}>অপসারণ / আর্কাইভে পাঠান</button>}
        <div className="ml-auto flex gap-2"><button type="button" className="btn-secondary" onClick={onClose}>বাতিল</button><button className="btn-primary" type="submit">{editing ? 'তথ্য সংরক্ষণ' : 'ভর্তি সম্পন্ন করুন'}</button></div>
      </div>
    </form>
  </Modal>;
}

