import { useEffect, useMemo, useState } from 'react';
import { Building2, MapPin } from 'lucide-react';
import { toBanglaNumber } from '../utils/banglaNumberFormatter.js';
import { Card, CardHeader, Badge, EmptyState } from '../components/ui/Primitives.jsx';
import { subscribeAllSchools } from '../services/database/index.js';

const flattenRegistry = (registry) => {
  const rows = [];
  Object.entries(registry ?? {}).forEach(([divisionId, districts]) => {
    Object.entries(districts ?? {}).forEach(([districtId, upazilas]) => {
      Object.entries(upazilas ?? {}).forEach(([upazilaId, schools]) => {
        Object.values(schools ?? {}).forEach((school) => {
          if (!school || typeof school !== 'object') return;
          rows.push({ ...school, divisionId: school.divisionId || divisionId, districtId: school.districtId || districtId, upazilaId: school.upazilaId || upazilaId });
        });
      });
    });
  });
  return rows.sort((a, b) => String(a.name ?? '').localeCompare(String(b.name ?? ''), 'bn'));
};

export default function SchoolsPage() {
  const [registry, setRegistry] = useState({});

  useEffect(() => subscribeAllSchools((value) => setRegistry(value ?? {})), []);

  const schools = useMemo(() => flattenRegistry(registry), [registry]);

  return <>
    <div className="mb-5">
      <h2 className="text-xl font-extrabold">বিদ্যালয় ডিরেক্টরি</h2>
      <p className="text-xs text-slate-500">সিস্টেম পরিচালকের জন্য নিবন্ধিত বিদ্যালয়ের তালিকা · {toBanglaNumber(schools.length)}টি প্রতিষ্ঠান</p>
    </div>
    <Card padded={false}>
      <div className="p-4"><CardHeader title="নিবন্ধিত বিদ্যালয়" subtitle="schoolRegistry/{'{'}বিভাগ{'}'}/{'{'}জেলা{'}'}/{'{'}উপজেলা{'}'}" /></div>
      {schools.length === 0 ? (
        <EmptyState icon={Building2} title="কোনো বিদ্যালয় নিবন্ধিত হয়নি" message="শিক্ষক নিবন্ধনের সময় নতুন বিদ্যালয় যোগ করলে তা এখানে দেখা যাবে।" />
      ) : (
        <div className="divide-y divide-slate-100 dark:divide-slate-800">
          {schools.map((school) => (
            <div key={`${school.divisionId}-${school.districtId}-${school.upazilaId}-${school.id}`} className="flex flex-wrap items-center gap-3 p-4">
              <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-brand-50 text-brand-700 dark:bg-brand-900/30 dark:text-brand-200"><Building2 size={18} /></span>
              <div className="min-w-0 flex-1">
                <p className="truncate font-bold">{school.name || 'নামহীন বিদ্যালয়'}</p>
                <p className="flex items-center gap-1 truncate text-xs text-slate-500">
                  <MapPin size={11} />
                  {[school.villageOrUnion || school.village, school.upazilaName, school.districtName].filter(Boolean).join(', ') || 'ঠিকানা অসম্পূর্ণ'}
                  {school.emisCode ? ` · EMIS ${toBanglaNumber(school.emisCode)}` : ''}
                </p>
              </div>
              <Badge tone={school.verified ? 'emerald' : 'amber'}>{school.verified ? 'যাচাইকৃত' : 'যাচাই বাকি'}</Badge>
            </div>
          ))}
        </div>
      )}
    </Card>
  </>;
}
