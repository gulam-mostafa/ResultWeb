import { useEffect, useMemo, useState } from 'react';
import { MapPin, Building2, ChevronRight, CheckCircle2, Lock } from 'lucide-react';
import { SCHOOL_DIRECTORY } from '../../utils/constants.js';
import { clsx } from '../../utils/clsx.js';
import { BD_LOCATIONS } from '../../data/bdLocations.js';
import { addSchool, subscribeSchools } from '../../services/database/index.js';

/**
 * SchoolDirectorySelector — cascading বিভাগ ➔ জেলা ➔ উপজেলা ➔ স্কুল picker.
 *
 * Fully controlled: the parent owns `value` ({divisionId, districtId, upazilaId, schoolId})
 * so the EMIS step can validate the chosen school.
 */
export default function SchoolDirectorySelector({ value, onChange, disabled = false, onSchoolSelected }) {
  const [schools, setSchools] = useState([]);
  const [registryStatus, setRegistryStatus] = useState('synced');
  const division = useMemo(() => BD_LOCATIONS.find((item) => item.id === value.divisionId) ?? null, [value.divisionId]);

  const district = useMemo(
    () => division?.districts?.find((item) => item.id === value.districtId) ?? null,
    [division, value.districtId],
  );

  const upazila = useMemo(
    () => district?.upazilas?.find((item) => item.id === value.upazilaId) ?? null,
    [district, value.upazilaId],
  );

  useEffect(() => {
    if (!division || !district || !upazila) { setSchools([]); return undefined; }
    return subscribeSchools({ divisionId: division.id, districtId: district.id, upazilaId: upazila.id }, setSchools, setRegistryStatus);
  }, [division, district, upazila]);

  const schoolsInDirectory = upazila?.schools ?? [];
  const availableSchools = schools.length ? schools : schoolsInDirectory;

  const handleDivision = (divisionId) => {
    const nextDivision = BD_LOCATIONS.find((item) => item.id === divisionId);
    const nextDistrict = nextDivision?.districts?.[0] ?? null;
    const nextUpazila = nextDistrict?.upazilas?.[0] ?? null;
    onChange({
      divisionId,
      districtId: nextDistrict?.id ?? '',
      upazilaId: nextUpazila?.id ?? '',
      schoolId: '',
    });
  };

  const handleDistrict = (districtId) => {
    const nextDistrict = division?.districts?.find((item) => item.id === districtId);
    const nextUpazila = nextDistrict?.upazilas?.[0] ?? null;
    onChange({
      ...value,
      districtId,
      upazilaId: nextUpazila?.id ?? '',
      schoolId: '',
    });
  };

  const handleUpazila = (upazilaId) => {
    onChange({ ...value, upazilaId, schoolId: '' });
  };

  const handleSchool = (schoolId) => {
    onChange({ ...value, schoolId });
  };

  return (
    <div className="space-y-3.5">
      <div className="grid gap-3 sm:grid-cols-3">
        <div>
          <label className="label-base" htmlFor="division-select">
            <span className="inline-flex items-center gap-1">
              <MapPin size={11} aria-hidden="true" /> বিভাগ
            </span>
          </label>
          <select
            id="division-select"
            className="input-base"
            value={value.divisionId}
            disabled={disabled}
            onChange={(event) => handleDivision(event.target.value)}
          >
            {BD_LOCATIONS.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className="label-base" htmlFor="district-select">
            জেলা
          </label>
          <select
            id="district-select"
            className="input-base"
            value={value.districtId}
            disabled={disabled || !division}
            onChange={(event) => handleDistrict(event.target.value)}
          >
            {(division?.districts ?? []).map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className="label-base" htmlFor="upazila-select">
            উপজেলা
          </label>
          <select
            id="upazila-select"
            className="input-base"
            value={value.upazilaId}
            disabled={disabled || !district}
            onChange={(event) => handleUpazila(event.target.value)}
          >
            {(district?.upazilas ?? []).map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div>
        <p className="label-base">
          <span className="inline-flex items-center gap-1">
            <Building2 size={11} aria-hidden="true" /> বিদ্যালয় নির্বাচন করুন
          </span>
        </p>
        <div className="space-y-2">
          {schools.length === 0 ? (
            <p className="rounded-xl border border-dashed border-slate-300 px-3 py-4 text-center text-xs text-slate-400">
              এই উপজেলায় কোনো বিদ্যালয় তালিকাভুক্ত নেই।
            </p>
          ) : (
            schools.map((school) => {
              const selected = value.schoolId === school.id;
              return (
                <button
                  key={school.id}
                  type="button"
                  disabled={disabled || !school.isAvailable}
                  onClick={() => handleSchool(school.id)}
                  aria-pressed={selected}
                  className={clsx(
                    'flex w-full items-center gap-3 rounded-xl border px-3 py-2.5 text-left transition',
                    selected
                      ? 'border-brand-500 bg-brand-50 ring-2 ring-brand-500/20'
                      : 'border-slate-200 bg-white hover:border-slate-300 hover:bg-slate-50',
                    !school.isAvailable && 'cursor-not-allowed opacity-55',
                  )}
                >
                  <span
                    className={clsx(
                      'flex h-8 w-8 shrink-0 items-center justify-center rounded-lg',
                      selected ? 'bg-brand-700 text-white' : 'bg-slate-100 text-slate-500',
                    )}
                  >
                    {school.isAvailable ? (
                      <Building2 size={15} aria-hidden="true" />
                    ) : (
                      <Lock size={14} aria-hidden="true" />
                    )}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-xs font-bold text-slate-900">
                      {school.name}
                    </span>
                    <span className="block truncate text-[10px] text-slate-500">
                      ইএমআইএস: {school.emisCode} · {school.address}
                    </span>
                  </span>
                  {selected ? (
                    <CheckCircle2 size={16} className="shrink-0 text-brand-600" aria-hidden="true" />
                  ) : (
                    <ChevronRight size={14} className="shrink-0 text-slate-300" aria-hidden="true" />
                  )}
                </button>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
