import { Link } from 'react-router-dom';
import { Bar } from 'react-chartjs-2';
import { useSchoolData } from '../context/SchoolDataContext.jsx';
import { useAuth } from '../context/AuthContext.jsx';
import { toBanglaNumber } from '../utils/banglaNumberFormatter.js';
import { academicYearOf, addressLine, schoolDisplayName } from '../utils/schoolProfile.js';
import { Card, CardHeader, StatCard, Badge } from '../components/ui/Primitives.jsx';
import { Users, School, GraduationCap, FileText, ArrowRight } from 'lucide-react';

export default function Dashboard() {
  const { summary, getClassAnalytics, getResultConfig, schoolProfile } = useSchoolData();
  const { user } = useAuth();
  const analytics = getClassAnalytics('c5');
  // Subject labels/colours come from this school's own class configuration, so a
  // customised subject list is reflected on the dashboard too.
  const subjects = getResultConfig?.('c5')?.subjects ?? [];
  const chart = {
    labels: subjects.map((subject) => subject.name),
    datasets: [{
      label: 'গড় নম্বর',
      data: subjects.map((subject) => {
        const values = analytics.rows
          .map((row) => row.result.subjects.find((item) => item.id === subject.id)?.total)
          .filter(Number.isFinite);
        return values.length ? Math.round(values.reduce((a, b) => a + b, 0) / values.length) : 0;
      }),
      backgroundColor: subjects.map((subject) => subject.color || '#64748b'),
      borderRadius: 6,
    }],
  };

  return <>
    <div className="mb-5">
      <h2 className="text-xl font-extrabold">ড্যাশবোর্ড</h2>
      <p className="text-xs text-slate-500">শিক্ষাবর্ষ {academicYearOf(schoolProfile)} · {schoolDisplayName(schoolProfile)} · বিদ্যালয়ের সার্বিক চিত্র</p>
    </div>
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      <StatCard label="মোট শিক্ষার্থী" value={toBanglaNumber(summary.activeStudents)} hint="সক্রিয় শিক্ষার্থী" icon={Users} tone="brand" />
      <StatCard label="শ্রেণি" value={toBanglaNumber(summary.classCount)} hint="প্রাক-প্রাথমিক থেকে ৫ম" icon={School} tone="emerald" />
      <StatCard label="ছাত্র / ছাত্রী" value={`${toBanglaNumber(summary.maleCount)} / ${toBanglaNumber(summary.femaleCount)}`} hint="সক্রিয় রোস্টার" icon={GraduationCap} tone="violet" />
      <StatCard label="আর্কাইভ" value={toBanglaNumber(summary.archivedStudents)} hint="প্রাক্তন শিক্ষার্থী" icon={FileText} tone="amber" />
    </div>
    <div className="mt-5 grid gap-4 xl:grid-cols-3">
      <Card className="xl:col-span-2">
        <CardHeader title="৫ম শ্রেণির বিষয়ভিত্তিক গড়" subtitle="বার্ষিক মূল্যায়নের ফলাফল" />
        <div className="h-72">
          <Bar data={chart} options={{ responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true, max: 100 } } }} />
        </div>
      </Card>
      <Card>
        <CardHeader title="বিদ্যালয়ের তথ্য" subtitle={schoolDisplayName(schoolProfile)} />
        <div className="space-y-3 text-sm">
          <p><span className="text-slate-500">{schoolProfile?.headTeacherDesignation || 'প্রধান শিক্ষক'}:</span> {schoolProfile?.headTeacher || '—'}</p>
          <p><span className="text-slate-500">ইএমআইএস:</span> {schoolProfile?.emisCode ? toBanglaNumber(schoolProfile.emisCode) : '—'}</p>
          <p><span className="text-slate-500">ঠিকানা:</span> {addressLine(schoolProfile) || '—'}</p>
          <p><span className="text-slate-500">শিক্ষার্থী:</span> {toBanglaNumber(summary.activeStudents)}</p>
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone="emerald">{academicYearOf(schoolProfile)} শিক্ষাবর্ষ</Badge>
            <Link to="/school-profile" className="inline-flex items-center gap-1 text-xs font-bold text-brand-700 hover:underline">
              প্রোফাইল হালনাগাদ <ArrowRight size={12} />
            </Link>
          </div>
        </div>
      </Card>
    </div>
    <Card className="mt-5">
      <CardHeader title="আপনার ভূমিকা" subtitle={user?.isFounder ? 'প্রতিষ্ঠাতা অ্যাডমিন' : user?.canApprove ? 'অনুমোদনকারী শিক্ষক' : 'শিক্ষক'} />
      <p className="p-4 pt-0 text-sm leading-relaxed text-slate-600 dark:text-slate-300">
        এই কর্মস্থলের সকল অনুমোদিত শিক্ষক একই ডেটা সম্পাদনা করেন — শিক্ষার্থী, উপস্থিতি, নম্বর ও বিদ্যালয়ের তথ্য। কোনো পরিবর্তন করলেই তা রিয়েলটাইমে সকল শিক্ষকের কাছে পৌঁছে যায়।
      </p>
    </Card>
  </>;
}
