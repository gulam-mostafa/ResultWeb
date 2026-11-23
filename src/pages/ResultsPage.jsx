import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  AlertTriangle, ArrowUpRight, Download, FileSpreadsheet, Printer, Settings2, Sparkles, Upload,
} from 'lucide-react';

import { useSchoolData } from '../context/SchoolDataContext.jsx';
import { useAuth } from '../context/AuthContext.jsx';
import { CLASS_LEVELS, CLASS_LABEL_MAP } from '../utils/constants.js';
import { toBanglaNumber } from '../utils/banglaNumberFormatter.js';
import {
  RESULT_TABS,
  normalizeResultConfig,
  tabById,
  weightsAreClean,
  normalizedWeightPercent,
} from '../utils/resultConfig.js';
import { Card, CardHeader, Badge } from '../components/ui/Primitives.jsx';
import SpreadsheetMarksGrid from '../components/results/SpreadsheetMarksGrid.jsx';
import ResultConfigModal from '../components/results/ResultConfigModal.jsx';
import ExcelPreviewModal from '../components/results/ExcelPreviewModal.jsx';
import ExcelDownloadWarningModal from '../components/results/ExcelDownloadWarningModal.jsx';
import AIRemarkModal from '../components/results/AIRemarkModal.jsx';
import Spinner from '../components/ui/Spinner.jsx';
import TermMarksheetA4 from '../components/documents/TermMarksheetA4.jsx';
import MarksheetA4 from '../components/documents/MarksheetA4.jsx';
import AutoPromotionModal from '../components/students/AutoPromotionModal.jsx';
import StudentDetailsModal from '../components/students/StudentDetailsModal.jsx';
import StudentResultModal from '../components/results/StudentResultModal.jsx';
import { downloadResultExcel, parseResultWorkbook, templateSpec } from '../services/excel/resultExcel.js';
import { DEFAULT_SECTION_ID } from '../services/database/dbPaths.js';

/**
 * ডিজিটাল রেজাল্ট (/results)
 *
 * Four evaluation tabs (১ম প্রান্তিক / ২য় প্রান্তিক / বার্ষিক মূল্যায়ন / বার্ষিক ফলাফল),
 * a school-owned class configuration (subjects, গাঠনিক+সামষ্টিক split, pass mark,
 * annual weights), an Excel-like marks grid, and a strict Excel round-trip that always
 * previews on screen before saving.
 */
export default function ResultsPage() {
  const {
    students: allStudents,
    studentsByClass,
    marks,
    schoolProfile,
    activeYear,
    getResultConfig,
    getStudentResult,
    getTermResult,
    getTabResult,
    setMark,
    applyImportedMarks,
    getRemark,
    setRemark,
    getClassRows,
    getClassAnalytics,
    getStudentClassRank,
    getClassRankMap,
    getSectionsOfClass,
    executePromotion,
    saveResultConfig,
    resetResultConfig,
    syncState,
    isHydrating,
  } = useSchoolData();
  const { canManageStudents } = useAuth();

  const [classId, setClassId] = useState('c5');
  const [tabId, setTabId] = useState('term1');
  const [sectionFilter, setSectionFilter] = useState(DEFAULT_SECTION_ID);
  const [sortMode, setSortMode] = useState('roll');
  const [remarkTarget, setRemarkTarget] = useState(null);
  const [printTargetId, setPrintTargetId] = useState('');
  const [promoting, setPromoting] = useState(false);
  const [profileTarget, setProfileTarget] = useState(null);
  const [resultTarget, setResultTarget] = useState(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [downloadNotice, setDownloadNotice] = useState('');
  const [uploadError, setUploadError] = useState('');
  const [uploadInfo, setUploadInfo] = useState('');
  const [preview, setPreview] = useState(null);
  const [savingPreview, setSavingPreview] = useState(false);
  /** Excel warning popup — the `.xlsx` download only starts after its confirm button. */
  const [downloadWarningOpen, setDownloadWarningOpen] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [parsingUpload, setParsingUpload] = useState(false);
  /** Short-lived overlay while a class/শাখা/tab switch recalculates the grid. */
  const [switching, setSwitching] = useState(false);
  const fileInputRef = useRef(null);
  const switchTimer = useRef(null);


  // The sidebar's "বার্ষিক শ্রেণি উত্তরণ" entry deep-links to `/results?promote=1`.
  const [searchParams, setSearchParams] = useSearchParams();
  useEffect(() => {
    if (searchParams.get('promote') !== '1') return;
    setPromoting(true);
    const next = new URLSearchParams(searchParams);
    next.delete('promote');
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams]);

  const activeTab = tabById(tabId);
  const isConsolidated = tabId === 'consolidated';
  const config = useMemo(
    () => normalizeResultConfig(getResultConfig?.(classId) ?? null, classId),
    [getResultConfig, classId],
  );


  const sections = useMemo(() => getSectionsOfClass?.(classId) ?? [DEFAULT_SECTION_ID], [getSectionsOfClass, classId]);
  useEffect(() => {
    if (!sections.includes(sectionFilter)) setSectionFilter(sections[0] ?? DEFAULT_SECTION_ID);
  }, [sections, sectionFilter]);

  /** Shows the "recalculating" spinner briefly so a filter switch never looks frozen. */
  const flashSwitching = useCallback(() => {
    setSwitching(true);
    if (switchTimer.current) clearTimeout(switchTimer.current);
    switchTimer.current = setTimeout(() => setSwitching(false), 600);
  }, []);
  useEffect(() => () => {
    if (switchTimer.current) clearTimeout(switchTimer.current);
  }, []);
  // Switching a class / শাখা / tab recalculates every row — surface it.
  useEffect(() => {
    flashSwitching();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [classId, tabId, sectionFilter]);

  const students = useMemo(() => {
    const list = studentsByClass?.[classId] ?? [];
    if (!sectionFilter) return list;
    return list.filter((student) => (String(student.section ?? '').trim() || DEFAULT_SECTION_ID) === sectionFilter);
  }, [studentsByClass, classId, sectionFilter]);

  /** Result of one pupil on the active tab (the grid + the print view share it). */
  const getRowResult = useCallback(
    (studentId) => getTabResult?.(studentId, tabId) ?? getTermResult?.(studentId, tabId) ?? {},
    [getTabResult, getTermResult, tabId],
  );

  const classRows = useMemo(() => getClassRows?.(classId, tabId) ?? [], [getClassRows, classId, tabId]);
  /**
   * Consolidated `{studentId: newRoll}` — the ONLY source of নতুন রোল. A per-term tab
   * keeps showing `—` in that column until the combined বার্ষিক ফলাফল is calculated.
   */
  const consolidatedRows = useMemo(
    () => (isConsolidated ? classRows : (getClassRows?.(classId, 'consolidated') ?? [])),
    [getClassRows, classId, classRows, isConsolidated],
  );
  const newRollMap = useMemo(() => {
    const hasAny = consolidatedRows.some((row) => row.result?.hasAnyMark);
    if (!hasAny) return null;
    return consolidatedRows.reduce((acc, row) => {
      if (row.result?.hasAnyMark && row.newRoll) acc[row.studentId] = row.newRoll;
      return acc;
    }, {});
  }, [consolidatedRows]);
  const printTarget = students.find((student) => student.id === printTargetId) ?? students[0];
  const printResult = printTarget ? getRowResult(printTarget.id) : null;
  const printPosition = printTarget
    ? (classRows.find((row) => row.studentId === printTarget.id)?.position ?? undefined)
    : undefined;
  const remarkResult = remarkTarget ? getRowResult(remarkTarget.id) : null;
  const weights = normalizedWeightPercent(config.weights);
  const goldenCount = useMemo(
    () => classRows.filter((row) => row.result?.isGolden).length,
    [classRows],
  );
  const passedCount = useMemo(
    () => classRows.filter((row) => row.result?.isPass).length,
    [classRows],
  );

  /* ---------------------------------------------------------------- *
   * Excel: download (with the format warning) / upload (strict) / save
   * ---------------------------------------------------------------- */

  const excelSpec = useMemo(() => templateSpec({
    schoolProfile,
    classId,
    year: activeYear,
    tabId,
    config,
    students,
  }), [schoolProfile, classId, activeYear, tabId, config, students]);

  /** Opens the mandatory warning popup — NO file is generated at this point. */
  const requestDownload = () => {
    setUploadError('');
    setUploadInfo('');
    setDownloadNotice('');
    setDownloadWarningOpen(true);
  };

  /** Runs only after the teacher confirms inside the warning popup. */
  const handleDownload = async () => {
    if (downloading) return;
    setDownloading(true);
    setUploadError('');
    setUploadInfo('');
    try {
      const computed = Object.fromEntries(
        (excelSpec.students ?? []).map((student) => [student.id, getRowResult(student.id)]),
      );
      const { name } = await downloadResultExcel({ spec: excelSpec, marks, computed });
      setDownloadNotice(`ফাইল ডাউনলোড হয়েছে: ${name}`);
      setDownloadWarningOpen(false);
    } catch {
      setDownloadNotice('');
      setUploadError('এক্সেল ফাইল তৈরি করা যায়নি। আবার চেষ্টা করুন।');
      setDownloadWarningOpen(false);
    } finally {
      setDownloading(false);
    }
  };

  const handleUpload = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    setUploadError('');
    setUploadInfo('');
    setDownloadNotice('');
    setPreview(null);
    setParsingUpload(true);
    try {
      let buffer;
      try {
        buffer = await file.arrayBuffer();
      } catch {
        setUploadError('ফাইলটি পড়া যায়নি।');
        return;
      }
      const parsed = await parseResultWorkbook(new Uint8Array(buffer), excelSpec);
      if (!parsed?.ok) {
        setUploadError(parsed?.message ?? 'ফাইলটি যাচাই করা যায়নি।');
        return;
      }
      setPreview({ rows: parsed.rows ?? {}, spec: excelSpec });
      setUploadInfo('ফাইল যাচাই সম্পন্ন — স্ক্রিন প্রিভিউ থেকে সংরক্ষণ করুন।');
    } catch {
      setUploadError('ফাইল প্রক্রিয়া করা যায়নি। আবার চেষ্টা করুন।');
    } finally {
      setParsingUpload(false);
    }
  };


  /**
   * Saves the previewed sheet in ONE multi-path database write (per class + term), so a
   * 40-pupil upload is a single atomic update inside this school's own year partition.
   */
  const savePreview = async (mergedMarks) => {
    if (isConsolidated || !activeTab.termId) return { synced: false };
    setSavingPreview(true);
    try {
      const entries = {};
      Object.entries(preview?.rows ?? {}).forEach(([studentId, fields]) => {
        entries[studentId] = Object.fromEntries(
          Object.entries(fields ?? {}).map(([fieldKey, mark]) => [fieldKey, { value: mark }]),
        );
      });
      const result = await applyImportedMarks?.(entries, {
        classId,
        termId: activeTab.termId,
        config,
      });
      if (result?.synced === false) return result;
      setUploadInfo('এক্সেলের নম্বর সফলভাবে সংরক্ষণ হয়েছে।');
      return result ?? { synced: true };
    } finally {
      setSavingPreview(false);
    }
  };



  return <>
    <div className="mb-5">
      <h2 className="text-xl font-extrabold">ডিজিটাল রেজাল্ট</h2>
      <p className="text-xs text-slate-500">
        প্রান্তিকভিত্তিক নম্বর, মেধাক্রম ও ফলাফল · বার্ষিক ফলাফল {toBanglaNumber(weights.term1)}% + {toBanglaNumber(weights.term2)}% + {toBanglaNumber(weights.annual)}% ওজনে
      </p>
    </div>

    {/* চারটি মূল্যায়ন ট্যাব */}
    <div className="no-print mb-4 flex flex-wrap gap-2" role="tablist" aria-label="মূল্যায়ন নির্বাচন">
      {RESULT_TABS.map((tab) => (
        <button
          key={tab.id}
          type="button"
          role="tab"
          aria-selected={tabId === tab.id}
          onClick={() => { setTabId(tab.id); setPreview(null); setUploadError(''); setUploadInfo(''); setDownloadNotice(''); }}
          className={`rounded-xl border px-4 py-2.5 text-sm font-bold transition ${tabId === tab.id ? 'border-brand-700 bg-brand-700 text-white shadow-sm' : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300'}`}
        >
          {tab.name}
        </button>
      ))}
    </div>

    <Card className="mb-4 no-print">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-wrap items-end gap-3">
          <label>
            <span className="label-base">শ্রেণি নির্বাচন</span>
            <select className="input-base w-44" value={classId} onChange={(event) => {
              setClassId(event.target.value);
              setPrintTargetId('');
              setPreview(null);
              setUploadError('');
              setUploadInfo('');
              setDownloadNotice('');
            }}>
              {CLASS_LEVELS.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select>
          </label>
          <label>
            <span className="label-base">শাখা</span>
            <select className="input-base w-32" value={sectionFilter} onChange={(event) => setSectionFilter(event.target.value)}>
              {sections.map((section) => <option key={section} value={section}>{section}</option>)}
            </select>
          </label>
          <button type="button" className="btn-secondary" onClick={() => setSettingsOpen(true)}>
            <Settings2 size={15} /> বিষয় ও নম্বর সেটিংস
          </button>
          {canManageStudents && (
            <button type="button" className="btn-secondary" onClick={() => setPromoting(true)}>
              <ArrowUpRight size={15} /> বার্ষিক শ্রেণি উত্তরণ
            </button>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone="brand">{toBanglaNumber(config.subjects.length)} বিষয় · {toBanglaNumber(config.subjects.reduce((sum, subject) => sum + subject.fullMarks, 0))} পূর্ণমান</Badge>
          <Badge tone={weightsAreClean(config.weights) ? 'emerald' : 'amber'}>পাস {toBanglaNumber(config.passMark)}</Badge>
          <Badge tone="amber">গোল্ডেন {toBanglaNumber(goldenCount)}</Badge>
          <Badge tone="emerald">উত্তীর্ণ {toBanglaNumber(passedCount)}</Badge>
        </div>
      </div>
    </Card>

    <Card className="mb-4 no-print">
      <CardHeader
        title="এক্সেল নম্বরপত্র"
        subtitle={`${CLASS_LABEL_MAP[classId]} · ${activeTab.name} · ${activeYear} শিক্ষাবর্ষ`}
        icon={FileSpreadsheet}
        action={<div className="flex flex-wrap items-center gap-2">
          <button type="button" className="btn-secondary btn-sm" onClick={requestDownload} disabled={downloading || parsingUpload}>
            {downloading
              ? <><Spinner size="xs" tone="brand" label="এক্সেল তৈরি হচ্ছে…" /> তৈরি হচ্ছে…</>
              : <><Download size={13} /> এক্সেল ডাউনলোড</>}
          </button>
          <button
            type="button"
            className="btn-primary btn-sm"
            onClick={() => fileInputRef.current?.click()}
            disabled={isConsolidated || parsingUpload}
          >
            {parsingUpload
              ? <><Spinner size="xs" tone="white" label="ফাইল যাচাই হচ্ছে…" /> যাচাই হচ্ছে…</>
              : <><Upload size={13} /> এক্সেল আপলোড</>}
          </button>
          <input ref={fileInputRef} type="file" accept=".xlsx" className="hidden" onChange={handleUpload} aria-label="এক্সেল ফাইল আপলোড" />
        </div>}
      />
      <div className="rounded-xl bg-amber-50 p-3 text-[11px] leading-relaxed font-semibold text-amber-900 dark:bg-amber-900/30 dark:text-amber-100">
        <AlertTriangle size={13} className="mr-1 inline" aria-hidden="true" />
        <b>সতর্কতা:</b> ডাউনলোড করা ফাইলের ফরম্যাট, শিটের নাম, বিষয়ের নাম, কলাম ও সারির কাঠামো <b>পরিবর্তন করবেন না</b> — শুধু নম্বরের ঘর পূরণ করুন। ওয়েবে ইতিমধ্যে দেওয়া নম্বরও ফাইলে থাকবে, তাই অর্ধেক ওয়েবে ও বাকিটা এক্সেলে পূরণ করে পুনরায় আপলোড করা যাবে। কাঠামো বদলালে আপলোড <b>কারণসহ বাতিল</b> হবে এবং নম্বর আগে <b>স্ক্রিন প্রিভিউ</b>তে দেখানো হবে — <b>সংরক্ষণ</b> চাপলেই কেবল এই বিদ্যালয়ের ডেটাবেজে যাবে।
        {isConsolidated ? ' বার্ষিক ফলাফল ট্যাব স্বয়ংক্রিয়ভাবে হিসাব হয়, তাই এখানে আপলোড নেই — অন্য তিনটি ট্যাবে নম্বর দিন।' : ''}
      </div>
      {parsingUpload ? (
        <p role="status" className="mt-2 flex items-center gap-2 rounded-lg bg-sky-50 p-2.5 text-[11px] font-semibold text-sky-800 dark:bg-sky-950/40 dark:text-sky-200">
          <Spinner size="xs" tone="brand" label="এক্সেল ফাইল যাচাই হচ্ছে…" />
          এক্সেল ফাইল পড়া ও যাচাই করা হচ্ছে… অপেক্ষা করুন।
        </p>
      ) : null}
      {downloadNotice ? <p role="status" className="mt-2 rounded-lg bg-brand-50 p-2.5 text-[11px] font-semibold text-brand-800 dark:bg-brand-900/30 dark:text-brand-200">{downloadNotice}</p> : null}

      {uploadInfo ? <p role="status" className="mt-2 rounded-lg bg-emerald-50 p-2.5 text-[11px] font-semibold text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-200">{uploadInfo}</p> : null}
      {uploadError ? <p role="alert" className="mt-2 rounded-lg bg-rose-50 p-2.5 text-[11px] font-semibold text-rose-800 dark:bg-rose-950/40 dark:text-rose-200"><b>আপলোড বাতিল:</b> {uploadError}</p> : null}
    </Card>

    <Card padded={false} className="no-print">
      <div className="relative p-4">
        <CardHeader
          title={`${CLASS_LABEL_MAP[classId]} · ${activeTab.name}`}
          subtitle={isConsolidated
            ? `১ম (${toBanglaNumber(weights.term1)}%) + ২য় (${toBanglaNumber(weights.term2)}%) + বার্ষিক (${toBanglaNumber(weights.annual)}%) অনুযায়ী চূড়ান্ত ফলাফল · মেধাক্রম ও নতুন রোল`
            : `প্রতি বিষয়ে পূর্ণমান ${toBanglaNumber(config.subjects.reduce((sum, subject) => sum + subject.fullMarks, 0))} · পাস নম্বর ${toBanglaNumber(config.passMark)} · এই প্রান্তিকের পৃথক মেধাক্রম`}
        />
        {switching || isHydrating ? (
          <p
            role="status"
            className="mb-2 inline-flex items-center gap-2 rounded-lg bg-brand-50 px-2.5 py-1.5 text-[11px] font-bold text-brand-800 dark:bg-brand-900/40 dark:text-brand-200"
          >
            <Spinner size="xs" tone={isHydrating ? 'rainbow' : 'brand'} label={isHydrating ? 'ডেটা লোড হচ্ছে…' : 'ফলাফল হিসাব হচ্ছে…'} />
            {isHydrating ? 'ডেটা লোড হচ্ছে…' : 'ফলাফল হিসাব হচ্ছে…'}
          </p>
        ) : null}
        <SpreadsheetMarksGrid
          students={students}
          marks={marks}
          config={config}
          tabId={tabId}
          getResult={getRowResult}
          onEntry={setMark}
          setMark={setMark}
          canEdit={!isConsolidated}
          onShowStudent={setProfileTarget}
          onShowResult={setResultTarget}
          sortMode={sortMode}
          onSortModeChange={setSortMode}
          newRollMap={newRollMap}
          saving={syncState === 'saving'}
        />
      </div>

      <div className="flex flex-wrap items-end justify-between gap-3 border-t border-slate-100 p-4 dark:border-slate-800">
        <div className="flex flex-wrap gap-2">
          {students.slice(0, 4).map((student) => (
            <button key={student.id} className="btn-secondary btn-sm" onClick={() => setRemarkTarget(student)}>
              <Sparkles size={13} />{student.name} · মন্তব্য
            </button>
          ))}
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <label>
            <span className="label-base">প্রিন্টের শিক্ষার্থী</span>
            <select className="input-base min-w-44" value={printTargetId || students[0]?.id || ''} onChange={(event) => setPrintTargetId(event.target.value)}>
              {students.map((student) => <option key={student.id} value={student.id}>{student.name} · রোল {student.roll}</option>)}
            </select>
          </label>
          <button type="button" className="btn-primary" onClick={() => window.print()} disabled={!printTarget}>
            <Printer size={15} /> {activeTab.name} প্রিন্ট
          </button>
        </div>
      </div>
    </Card>

    <div className="print-root">
      {printTarget && printResult && (isConsolidated
        ? <MarksheetA4 student={printTarget} result={printResult} remark={getRemark(printTarget.id)} schoolProfile={schoolProfile} />
        : <TermMarksheetA4
          student={printTarget}
          result={printResult}
          term={{ id: tabId, name: activeTab.name }}
          remark={getRemark(printTarget.id)}
          position={printPosition}
          schoolProfile={schoolProfile}
        />)}
    </div>

    {remarkTarget && (
      <AIRemarkModal
        open
        onClose={() => setRemarkTarget(null)}
        student={remarkTarget}
        result={remarkResult}
        initialRemark={getRemark(remarkTarget.id)}
        onSave={(text) => setRemark(remarkTarget.id, text)}
      />
    )}

    <ResultConfigModal
      open={settingsOpen}
      onClose={() => setSettingsOpen(false)}
      classId={classId}
      config={config}
      canEdit={canManageStudents || Boolean(saveResultConfig)}
      onSave={saveResultConfig}
      onReset={resetResultConfig}
    />

    <ExcelDownloadWarningModal
      open={downloadWarningOpen}
      onClose={() => {
        if (downloading) return;
        setDownloadWarningOpen(false);
      }}
      onConfirm={handleDownload}
      downloading={downloading}
      subtitle={`${CLASS_LABEL_MAP[classId] ?? ''} · ${activeTab.name} · ${activeYear} শিক্ষাবর্ষ`}
    />

    <ExcelPreviewModal
      open={Boolean(preview)}
      onClose={() => setPreview(null)}
      spec={preview?.spec ?? excelSpec}
      rows={preview?.rows ?? {}}
      config={config}
      tabId={tabId}
      marks={marks}
      onSave={savePreview}
      saving={savingPreview}
    />

    <StudentDetailsModal
      open={Boolean(profileTarget)}
      onClose={() => setProfileTarget(null)}
      student={profileTarget ? (allStudents.find((item) => item.id === profileTarget.id) ?? profileTarget) : null}
      marks={marks}
      allStudents={allStudents}
      getTermResult={getTermResult}
      getStudentResult={getStudentResult}
      getClassAnalytics={getClassAnalytics}
      getResultConfig={getResultConfig}
    />

    <StudentResultModal
      open={Boolean(resultTarget)}
      onClose={() => setResultTarget(null)}
      student={resultTarget ? (allStudents.find((item) => item.id === resultTarget.id) ?? resultTarget) : null}
      marks={marks}
      getStudentResult={getStudentResult}
      getTermResult={getTermResult}
      getClassAnalytics={getClassAnalytics}
      term={isConsolidated ? null : tabId}
    />

    <AutoPromotionModal
      open={promoting}
      onClose={() => setPromoting(false)}
      students={allStudents}
      defaultClassId={classId}
      allStudents={allStudents}
      marks={marks}
      getStudentResult={getStudentResult}
      getTermResult={getTermResult}
      getClassAnalytics={getClassAnalytics}
      getStudentClassRank={getStudentClassRank}
      getClassRankMap={getClassRankMap}
      getSectionsOfClass={getSectionsOfClass}
      getResultConfig={getResultConfig}
      onExecute={executePromotion}
    />
  </>;
}

