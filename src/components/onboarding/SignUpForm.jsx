import { AuthFormActions, AuthQuickAccess, Directory, Field, RoleCards } from './AuthFormParts.jsx';

export default function SignUpForm({
  kind = 'teacher',
  onKindChange = () => {},
  classOptions = [],
  fullName = '',
  onFullNameChange = () => {},
  onFillSample = () => {},
  designation = 'সহকারী শিক্ষক',
  onDesignationChange = () => {},
  studentClass = '',
  onStudentClassChange = () => {},
  roll = '',
  onRollChange = () => {},
  identity = '',
  onIdentityChange = () => {},
  password = '',
  onPasswordChange = () => {},
  directory = {},
  onDirectoryChange = () => {},
  schools = [],
  adding = false,
  onAddSchool = () => {},
  newName = '',
  onNewNameChange = () => {},
  notice = '',
  isSubmitting = false,
  onSubmit = () => {},
  onBypass = () => {},
  schoolName = 'বিদ্যালয় নির্বাচন করুন',
}) {
  return <>
    <form onSubmit={onSubmit} className="space-y-4">
      <div className="flex items-end gap-2"><div className="flex-1"><Field label="পূর্ণ নাম" value={fullName} onChange={(e) => onFullNameChange(e.target.value)} placeholder="আপনার পূর্ণ নাম" autoComplete="name"/></div><button type="button" onClick={onFillSample} className="btn-secondary whitespace-nowrap py-2.5 text-xs">নতুন তথ্য পূরণ করুন</button></div>
      <div><p className="label-base">আপনার পরিচয়</p><RoleCards kind={kind} onChange={onKindChange} /></div>
      {kind === 'teacher' && <><label><span className="label-base">পদবি</span><select className="input-base" value={designation} onChange={(e) => onDesignationChange(e.target.value)}><option>প্রধান শিক্ষক</option><option>সহকারী শিক্ষক</option></select></label><div className="grid gap-3 sm:grid-cols-2"><Field label="মোবাইল নম্বর / ইমেইল" value={identity} onChange={(e) => onIdentityChange(e.target.value)} placeholder="মোবাইল নম্বর বা ইমেইল" autoComplete="username"/><Field label="পাসওয়ার্ড" type="password" value={password} onChange={(e) => onPasswordChange(e.target.value)} placeholder="পাসওয়ার্ড" autoComplete="new-password"/></div></>}
      {kind === 'student' && <><label><span className="label-base">শ্রেণি</span><select className="input-base" value={studentClass} onChange={(e) => onStudentClassChange(e.target.value)}>{classOptions.map((item) => <option key={item.id} value={item?.name ?? ''}>{item?.name ?? ''}</option>)}</select></label><div className="grid gap-3 sm:grid-cols-2"><Field label="রোল নম্বর" value={roll} onChange={(e) => onRollChange(e.target.value)} placeholder="রোল নম্বর"/><Field label="পাসওয়ার্ড" type="password" value={password} onChange={(e) => onPasswordChange(e.target.value)} placeholder="পাসওয়ার্ড"/></div><Field label="অভিভাবকের মোবাইল নম্বর / ইমেইল" value={identity} onChange={(e) => onIdentityChange(e.target.value)} placeholder="০১XXXXXXXXX"/> </>}
      <Directory value={directory} onChange={onDirectoryChange} schools={schools} allowAdd={kind === 'teacher'} adding={adding} onAdd={onAddSchool} newName={newName} setNewName={onNewNameChange} />
      <AuthFormActions notice={notice} isSubmitting={isSubmitting} submitLabel="নিবন্ধন সম্পন্ন করুন" />
    </form>
    <AuthQuickAccess onBypass={onBypass} schoolName={schoolName} />
  </>;
}
