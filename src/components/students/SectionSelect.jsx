import { useEffect, useState } from 'react';
import { Check, Pencil, Plus, Trash2, X } from 'lucide-react';
import { toBanglaNumber } from '../../utils/banglaNumberFormatter.js';
import { Badge } from '../ui/Primitives.jsx';
import { DEFAULT_SECTION_ID } from '../../services/database/dbPaths.js';

/**
 * শাখা selector shown under the class tabs.
 *
 * `options` are the section folders of the selected class and `counts` maps each
 * section to its student total, so the teacher sees how big the chosen শাখা is.
 * A class may have ANY number of sections, so the selector also lets a teacher
 * add a new one (a typed label), rename one, or delete an empty one.
 */
export default function SectionSelect({
  value,
  onChange,
  options = [],
  counts = {},
  total = 0,
  canManage = false,
  onAddSection,
  onRenameSection,
  onRemoveSection,
}) {
  const [adding, setAdding] = useState(false);
  const [newSection, setNewSection] = useState('');
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState(value ?? DEFAULT_SECTION_ID);

  // Switching the selected শাখা closes any inline editor, so no stale label is written.
  useEffect(() => {
    setAdding(false);
    setRenaming(false);
    setNewSection('');
    setRenameValue(value ?? DEFAULT_SECTION_ID);
  }, [value]);

  const submitAdd = () => {
    const label = newSection.trim();
    if (!label || !onAddSection) return;
    const created = onAddSection(label);
    if (created) {
      onChange(created);
      setAdding(false);
      setNewSection('');
    }
  };
  const submitRename = () => {
    const label = renameValue.trim();
    if (!label || label === value || !onRenameSection) return;
    if (onRenameSection(value, label)) onChange(label);
    setRenaming(false);
  };

  const activeCount = counts[value] ?? 0;
  return <div className="mb-3 flex flex-wrap items-center gap-3">
    <label className="flex items-center gap-2 text-xs font-semibold">শাখা
      <select className="input-base w-auto py-1.5" value={value} onChange={(event) => onChange(event.target.value)} aria-label="শাখা নির্বাচন">
        {options.map((section) => <option key={section} value={section}>
          {section} ({toBanglaNumber(counts[section] ?? 0)})
        </option>)}
      </select>
    </label>
    {canManage && <>
      {adding
        ? <span className="flex flex-wrap items-center gap-1.5">
          <input
            className="input-base w-32 py-1.5 text-xs"
            value={newSection}
            onChange={(event) => setNewSection(event.target.value)}
            onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); submitAdd(); } }}
            placeholder="নতুন শাখা (যেমন খ)"
            aria-label="নতুন শাখার নাম"
            autoFocus
          />
          <button type="button" className="btn-ghost btn-sm text-emerald-700" onClick={submitAdd} aria-label="শাখা যোগ করুন"><Check size={14} /></button>
          <button type="button" className="btn-ghost btn-sm" onClick={() => { setAdding(false); setNewSection(''); }} aria-label="বাতিল"><X size={14} /></button>
        </span>
        : <button type="button" className="btn-ghost btn-sm text-brand-700" onClick={() => { setAdding(true); setRenaming(false); }}><Plus size={14} /> শাখা যোগ</button>}
      {!adding && (renaming
        ? <span className="flex flex-wrap items-center gap-1.5">
          <input
            className="input-base w-32 py-1.5 text-xs"
            value={renameValue}
            onChange={(event) => setRenameValue(event.target.value)}
            onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); submitRename(); } }}
            aria-label="শাখার নতুন নাম"
            autoFocus
          />
          <button type="button" className="btn-ghost btn-sm text-emerald-700" onClick={submitRename} aria-label="নাম পরিবর্তন সংরক্ষণ"><Check size={14} /></button>
          <button type="button" className="btn-ghost btn-sm" onClick={() => { setRenaming(false); setRenameValue(value); }} aria-label="বাতিল"><X size={14} /></button>
        </span>
        : <button type="button" className="btn-ghost btn-sm" onClick={() => { setRenaming(true); setRenameValue(value); }}><Pencil size={14} /> নাম পরিবর্তন</button>)}
      {!adding && !renaming && value !== DEFAULT_SECTION_ID && activeCount === 0
        && <button type="button" className="btn-ghost btn-sm text-rose-700" onClick={() => onRemoveSection?.(value)}><Trash2 size={14} /> শাখা মুছুন</button>}
    </>}
    <Badge tone="brand">মোট শিক্ষার্থী: {toBanglaNumber(total)}</Badge>
  </div>;
}
