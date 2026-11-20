import { AuthFormActions, AuthQuickAccess, Directory, Field, RoleCards } from './AuthFormParts.jsx';

export default function LoginForm({
  kind = 'teacher',
  onKindChange = () => {},
  directory = {},
  onDirectoryChange = () => {},
  schools = [],
  adding = false,
  onAddSchool = () => {},
  newName = '',
  onNewNameChange = () => {},
  identity = '',
  onIdentityChange = () => {},
  password = '',
  onPasswordChange = () => {},
  notice = '',
  isSubmitting = false,
  onSubmit = () => {},
  onBypass = () => {},
  schoolName = 'বিদ্যালয় নির্বাচন করুন',
}) {
  return <>
    <form onSubmit={onSubmit} className="space-y-4">
      <div><p className="label-base">আপনার পরিচয়</p><RoleCards kind={kind} onChange={onKindChange} /></div>
      <Directory value={directory} onChange={onDirectoryChange} schools={schools} allowAdd={false} adding={adding} onAdd={onAddSchool} newName={newName} setNewName={onNewNameChange} />
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={kind === 'teacher' ? 'মোবাইল / ইমেইল' : 'রোল নম্বর / অভিভাবকের মোবাইল'} value={identity} onChange={(e) => onIdentityChange(e.target.value)} placeholder="প্রবেশের তথ্য"/>
        <Field label="পাসওয়ার্ড / জন্ম তারিখ" type="password" value={password} onChange={(e) => onPasswordChange(e.target.value)} placeholder="আপনার পাসওয়ার্ড"/>
      </div>
      <AuthFormActions notice={notice} isSubmitting={isSubmitting} submitLabel="লগইন করুন" />
    </form>
    <AuthQuickAccess onBypass={onBypass} schoolName={schoolName} />
  </>;
}
