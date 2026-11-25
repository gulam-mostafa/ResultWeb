import { useMemo } from 'react';
import { AlertTriangle, ArrowDownUp, Crown, Info, ListOrdered } from 'lucide-react';
import { toBanglaNumber, formatBanglaDecimal } from '../../utils/banglaNumberFormatter.js';
import { TERMS } from '../../utils/constants.js';

/**
 * বার্ষিক ফলাফল টেবিল — consolidated annual result WITHOUT subject columns.
 *
 * The requirement is explicit: this tab must never render an individual subject
 * column. Instead it shows the three term results
 * (১ম প্রান্তিক / ২য় প্রান্তিক / বার্ষিক মূল্যায়ন) with the school's configured
 * percentage weights (default ১৫% + ১৫% + ৭০%), followed by the consolidated columns:
 * মোট নম্বর / ফলাফল, GPA, Grade, মেধাক্রম, বর্তমান রোল and নতুন রোল.
 *
 * Every number comes from the SAME engine the marksheet and the promotion flow use
 * (`getClassRows(classId, 'consolidated')`), so the screen and the printed sheet can
 * never disagree. Sorting switches between বর্তমান রোল and মেধাক্রম.
 */
const TONE_BY_GRADE = {
  'A+': 'bg-emerald-100 text-emerald-800',
  A: 'bg-emerald-100 text-emerald-800',
  'A-': 'bg-sky-100 text-sky-800',
  B: 'bg-sky-100 text-sky-800',
  C: 'bg-amber-100 text-amber-800',
  D: 'bg-orange-100 text-orange-800',
  F: 'bg-rose-100 text-rose-800',
};

const percentCell = (value) => (value === null || value === undefined ? '—' : `${formatBanglaDecimal(value, 2)}%`);

/** Term label of the annual table (১ম প্রান্তিক / ২য় প্রান্তিক / বার্ষিক মূল্যায়ন). */
const termLabel = (term) => (term.id === 'annual' ? 'বার্ষিক মূল্যায়ন' : `${term.shortName} প্রান্তিক`);

/**
 * Weighted percentage contribution of each term of ONE consolidated result.
 *
 * No individual subject column is shown; instead every term reports the percentage it
 * contributed to the final figure. Scoring ১০০ in each term at ১৫% / ১৫% / ৭০% therefore
 * yields `১৫ + ১৫ + ৭০ = ১০০`.
 */
export function termCellsOf(result) {
  return TERMS.map((term) => {
    const contributions = (result?.subjects ?? [])
      .map((subject) => (subject.contributions ?? []).find((item) => item.termId === term.id))
      .filter(Boolean);
    const scored = contributions.filter((item) => item.hasMark === true);
    if (!scored.length) return null;
    // Average subject percentage of THIS term × the term's own weight.
    const average = scored.reduce((sum, item) => sum + Number(item.percent || 0), 0) / scored.length;
    const weight = Number(scored[0].weight ?? 0);
    return {
      id: term.id,
      // `weighted` is the number that actually entered the final total.
      weighted: Math.round(((average * weight) / 100 + Number.EPSILON) * 100) / 100,
      percent: Math.round((average + Number.EPSILON) * 100) / 100,
      weight,
      mark: scored.reduce((sum, item) => sum + (Number(item.mark) || 0), 0),
    };
  });
}

export default function ConsolidatedAnnualTable({
  rows = [],
  weights,
  sortMode = 'roll',
  onSortModeChange,
  onShowStudent,
  onShowResult,
  isHydrating = false,
  switching = false,
}) {
  const weightText = `${toBanglaNumber(weights?.term1 ?? 0)}% + ${toBanglaNumber(weights?.term2 ?? 0)}% + ${toBanglaNumber(weights?.annual ?? 0)}%`;

  /** One row per pupil, carrying the consolidated result + its ranked position. */
  const visibleRows = useMemo(() => {
    const list = (Array.isArray(rows) ? rows : []).filter((row) => row?.student);
    if (sortMode === 'merit') return [...list].sort((a, b) => a.position - b.position);
    return [...list].sort((a, b) => (
      (Number(a.student?.roll) || Number.MAX_SAFE_INTEGER) - (Number(b.student?.roll) || Number.MAX_SAFE_INTEGER)
    ));
  }, [rows, sortMode]);

  /** Pupils whose three terms are not all entered — the Bangla warning names the gap. */
  const incompleteCount = useMemo(
    () => visibleRows.filter((row) => row?.result?.hasAnyMark && row?.result?.isComplete === false).length,
    [visibleRows],
  );

  return (
    <div className="rounded-xl border border-slate-200 dark:border-slate-700">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-3 py-2 dark:border-slate-800">
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] font-semibold text-slate-500">
          <Info size={12} aria-hidden="true" />
          কোনো বিষয়ভিত্তিক কলাম নেই — শুধু তিন প্রান্তিকের ওজনযুক্ত ফলাফল ({weightText})
          {switching || isHydrating ? (
            <span className="inline-flex items-center gap-1.5 rounded-full bg-brand-50 px-2 py-0.5 font-bold text-brand-700 dark:bg-brand-900/40 dark:text-brand-200">
              হিসাব হচ্ছে…
            </span>
          ) : null}
        </p>
        {onSortModeChange ? (
          <label className="flex items-center gap-1.5 text-[11px] font-semibold text-slate-600 dark:text-slate-300">
            <ArrowDownUp size={13} aria-hidden="true" /> ক্রম
            <select
              className="input-base w-36 py-1 text-xs"
              value={sortMode}
              onChange={(event) => onSortModeChange(event.target.value)}
              aria-label="সাজানোর ক্রম"
            >
              <option value="roll">বর্তমান রোল</option>
              <option value="merit">মেধাক্রম</option>
            </select>
          </label>
        ) : null}
      </div>

      {incompleteCount > 0 ? (
        <p role="status" className="border-b border-amber-100 bg-amber-50 px-3 py-2 text-[11px] font-semibold text-amber-900 dark:border-amber-900/40 dark:bg-amber-900/30 dark:text-amber-100">
          <AlertTriangle size={12} className="mr-1 inline" aria-hidden="true" />
          {toBanglaNumber(incompleteCount)} জন শিক্ষার্থীর <b>সব প্রান্তিকের নম্বর দেওয়া হয়নি</b> — অনুপস্থিত প্রান্তিক ০ হিসেবে গণনা করা হয়েছে।
        </p>
      ) : null}

      <div className="hidden overflow-auto md:block">
        <table className="table-base min-w-[900px]">
          <thead>
            <tr>
              <th className="sticky left-0 top-0 z-20">শিক্ষার্থী</th>
              {TERMS.map((term) => (
                <th key={term.id} className="text-center">
                  {termLabel(term)}
                  <span className="block text-[10px] font-normal opacity-70">
                    ({toBanglaNumber(weights?.[term.id] ?? 0)}%)
                  </span>
                </th>
              ))}
              <th className="text-center">মোট নম্বর</th>
              <th className="text-center">ফলাফল</th>
              <th className="text-center">GPA</th>
              <th className="text-center">Grade</th>
              <th className="text-center">মেধাক্রম</th>
              <th className="text-center">বর্তমান রোল</th>
              <th className="text-center">নতুন রোল</th>
            </tr>
          </thead>
          <tbody>
            {visibleRows.map(({ student, result, position, newRoll }) => {
              const cells = termCellsOf(result);
              return (
                <tr key={student.id}>
                  <td className="sticky left-0 bg-white dark:bg-slate-900">
                    <button
                      type="button"
                      className="text-left"
                      onClick={() => onShowStudent?.(student)}
                      aria-label={`${student.name} এর পূর্ণাঙ্গ তথ্য ও ফলাফল`}
                    >
                      <span className="inline-flex flex-wrap items-center gap-1 font-bold text-brand-800 underline decoration-brand-300 underline-offset-2 hover:decoration-brand-700 dark:text-brand-200">
                        {student.name}
                        {result?.isGolden ? (
                          <span className="badge bg-amber-100 text-amber-800" title="সব বিষয়ে গোল্ডেন">
                            <Crown size={11} strokeWidth={2.6} aria-hidden="true" /> গোল্ডেন
                          </span>
                        ) : null}
                      </span>
                    </button>
                  </td>
                  {cells.map((cell, index) => (
                    <td key={TERMS[index].id} className="text-center">
                      {cell ? (
                        <>
                          <span className="font-semibold">{toBanglaNumber(cell.weighted)}%</span>
                          <span className="block text-[10px] text-slate-400">{percentCell(cell.percent)}</span>
                        </>
                      ) : '—'}
                    </td>
                  ))}
                  <td className="text-center font-bold">{toBanglaNumber(result?.totalMarks ?? 0)}</td>
                  <td className="text-center">
                    <button
                      type="button"
                      onClick={() => onShowResult?.(student)}
                      disabled={!onShowResult}
                      className={`badge ${result?.isPass ? 'bg-emerald-100 text-emerald-800' : 'bg-rose-100 text-rose-800'} underline-offset-2 hover:underline`}
                    >
                      {result?.hasAnyMark ? (result.isPass ? 'উত্তীর্ণ' : 'অনুত্তীর্ণ') : '—'}
                    </button>
                  </td>
                  <td className="text-center">{result?.gpa == null ? '—' : formatBanglaDecimal(result.gpa, 2)}</td>
                  <td className="text-center">
                    <span className={`badge ${TONE_BY_GRADE[result?.grade] ?? 'bg-slate-100 text-slate-700'}`}>
                      {result?.grade ?? '—'}
                    </span>
                  </td>
                  <td className="text-center">{toBanglaNumber(result?.hasAnyMark ? position ?? '—' : '—')}</td>
                  <td className="text-center">{toBanglaNumber(student.roll ?? '—')}</td>
                  <td className="text-center font-bold text-brand-700 dark:text-brand-300">
                    {toBanglaNumber(newRoll ?? '—')}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Mobile: one card per pupil, same columns, still no subject list. */}
      <div className="divide-y divide-slate-100 md:hidden dark:divide-slate-800">
        {visibleRows.map(({ student, result, position, newRoll }) => {
          const cells = termCellsOf(result);
          return (
            <div key={student.id} className="p-3">
              <div className="mb-2 flex items-start justify-between gap-2">
                <button type="button" className="text-left" onClick={() => onShowStudent?.(student)}>
                  <span className="inline-flex flex-wrap items-center gap-1 text-sm font-bold text-brand-800 dark:text-brand-200">
                    {student.name}
                    {result?.isGolden ? (
                      <span className="badge bg-amber-100 text-amber-800">
                        <Crown size={10} strokeWidth={2.6} aria-hidden="true" /> গোল্ডেন
                      </span>
                    ) : null}
                  </span>
                  <span className="block text-[10px] text-slate-400">
                    বর্তমান রোল {toBanglaNumber(student.roll ?? '—')}
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => onShowResult?.(student)}
                  disabled={!onShowResult}
                  className={`badge ${result?.isPass ? 'bg-emerald-100 text-emerald-800' : 'bg-rose-100 text-rose-800'}`}
                >
                  {result?.grade ?? '—'}
                </button>
              </div>
              <div className="space-y-1 text-[11px] font-semibold text-slate-600 dark:text-slate-300">
                {cells.map((cell, index) => (
                  <p key={TERMS[index].id} className="flex items-center justify-between">
                    <span>
                      {termLabel(TERMS[index])}
                      <span className="ml-1 font-normal text-slate-400">
                        ({toBanglaNumber(weights?.[TERMS[index].id] ?? 0)}%)
                      </span>
                    </span>
                    <span>{cell ? `${toBanglaNumber(cell.weighted)}% · ${percentCell(cell.percent)}` : '—'}</span>
                  </p>
                ))}
                <p className="flex items-center justify-between border-t border-slate-100 pt-1 dark:border-slate-800">
                  <span>মোট নম্বর</span><span>{toBanglaNumber(result?.totalMarks ?? 0)}</span>
                </p>
                <p className="flex items-center justify-between">
                  <span>GPA · Grade</span>
                  <span>
                    {result?.gpa == null ? '—' : formatBanglaDecimal(result.gpa, 2)} · {result?.grade ?? '—'}
                  </span>
                </p>
                <p className="flex items-center justify-between">
                  <span>মেধাক্রম</span>
                  <span>{toBanglaNumber(result?.hasAnyMark ? position ?? '—' : '—')}</span>
                </p>
                <p className="flex items-center justify-between">
                  <span>নতুন রোল</span>
                  <span className="text-brand-700 dark:text-brand-300">{toBanglaNumber(newRoll ?? '—')}</span>
                </p>
              </div>
            </div>
          );
        })}
      </div>

      {!visibleRows.length ? (
        <p className="py-8 text-center text-sm text-slate-400">
          <ListOrdered size={14} className="mr-1 inline" aria-hidden="true" />
          এই শ্রেণিতে কোনো শিক্ষার্থী নেই।
        </p>
      ) : null}
    </div>
  );
}

