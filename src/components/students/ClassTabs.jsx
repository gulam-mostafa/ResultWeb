import { CLASS_TABS } from '../../utils/constants.js';
import { toBanglaNumber } from '../../utils/banglaNumberFormatter.js';
export default function ClassTabs({ value, onChange, counts = {} }) {
  return <div className="flex gap-2 overflow-x-auto pb-2" role="tablist" aria-label="শ্রেণি নির্বাচন">{CLASS_TABS.map((item) => <button key={item.id} role="tab" aria-selected={value === item.id} onClick={() => onChange(item.id)} className={`shrink-0 rounded-xl border px-3 py-2 text-xs font-bold ${value === item.id ? 'border-brand-700 bg-brand-700 text-white' : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50'}`}>{item.shortName}<span className="ml-2 opacity-70">{toBanglaNumber(counts[item.id] ?? 0)}</span></button>)}</div>;
}
