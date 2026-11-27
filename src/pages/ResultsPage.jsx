import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  ArrowUpRight, Download, FileSpreadsheet, FileText, Printer, Settings2, Sparkles, Upload,
} from 'lucide-react';

import { useSchoolData } from '../context/SchoolDataContext.jsx';
import { useAuth } from '../context/AuthContext.jsx';
import { CLASS_LEVELS, CLASS_LABEL_MAP, getClassName } from '../utils/constants.js';
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
import ConsolidatedAnnualTable from '../components/results/ConsolidatedAnnualTable.jsx';
import ResultConfigModal from '../components/results/ResultConfigModal.jsx';
import ExcelPreviewModal from '../components/results/ExcelPreviewModal.jsx';
import AIRemarkModal from '../components/results/AIRemarkModal.jsx';
import Spinner from '../components/ui/Spinner.jsx';
import { useToast } from '../components/ui/Toast.jsx';
import ResultMarksheetA4 from '../components/documents/ResultMarksheetA4.jsx';
import AutoPromotionModal from '../components/students/AutoPromotionModal.jsx';
import StudentDetailsModal from '../components/students/StudentDetailsModal.jsx';
import StudentResultModal from '../components/results/StudentResultModal.jsx';
import { downloadResultExcel, parseResultWorkbook, templateSpec } from '../services/excel/resultExcel.js';
import { downloadResultList } from '../services/excel/resultListExcel.js';
import { downloadSheetsAsPdf } from '../utils/downloadPdf.js';
import { DEFAULT_SECTION_ID } from '../services/database/dbPaths.js';
import { nextSessionYear } from '../services/database/sessionService.js';

/** The two A4 page layouts of the marksheet print / PDF flow. */
const PAGE_LAYOUTS = [
  { id: 'single', name: '১টি A4 পেজে ১ জনের মার্কশিট', hint: 'প্রতি পেজে একজন শিক্ষার্থী' },
  { id: 'pair', name: '১টি A4 পেজে ২ জনের মার্কশিট', hint: 'উপর-নিচে অর্ধেক-অর্ধেক করে' },
];


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
    schoolId,
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
    advanceClassYear,
    undoClassPromotion,
    promotionState,
    isReadOnly,
    isClassLocked,
    saveResultConfig,
    resetResultConfig,
    syncState,
    isHydrating,
  } = useSchoolData();
  const { canManageStudents, canEditMarks, canPrintDocuments } = useAuth();
  const toast = useToast();

  const [classId, setClassId] = useState('c5');
  const [tabId, setTabId] = useState('term1');
  const [sectionFilter, setSectionFilter] = useState(DEFAULT_SECTION_ID);
  const [sortMode, setSortMode] = useState('roll');
  const [remarkTarget, setRemarkTarget] = useState(null);
  const [printTargetId, setPrintTargetId] = useState('');
  /** `'single'` (1 marksheet per A4) | `'pair'` (2 marksheets per A4, top & bottom). */
  const [pageLayout, setPageLayout] = useState('single');
  /** `false` = the single-pupil preview, `true` = the whole class in the print-root. */
  const [bulkPrint, setBulkPrint] = useState(false);
  const [promoting, setPromoting] = useState(false);
  const [profileTarget, setProfileTarget] = useState(null);
  const [resultTarget, setResultTarget] = useState(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [downloadNotice, setDownloadNotice] = useState('');
  const [uploadError, setUploadError] = useState('');
  const [uploadInfo, setUploadInfo] = useState('');
  const [preview, setPreview] = useState(null);
  const [savingPreview, setSavingPreview] = useState(false);
  const [downloading, setDownloading] = useState(false);
  /** তালিকা ডাউনলোড (হুবহু লিস্ট) চলছে কি না। */
  const [downloadingList, setDownloadingList] = useState(false);
  const [parsingUpload, setParsingUpload] = useState(false);
  /** সরাসরি PDF ডাউনলোড চলছে কি না (প্রিন্ট ডায়ালগ ছাড়া, jsPDF দিয়ে)। */
  const [downloadingPdf, setDownloadingPdf] = useState(false);
  /** মার্কশিট প্রিন্ট-রুট — সরাসরি PDF ডাউনলোড এই এলিমেন্টের `.print-sheet` গুলো রেন্ডার করে। */
  const printRootRef = useRef(null);
  /** Short-lived overlay while a class/শাখা/tab switch recalculates the grid. */
  const [switching, setSwitching] = useState(false);
  /** Bangla feedback of the year-end rollover (`নতুন শিক্ষাবর্ষ শুরু`). */
  const [yearNotice, setYearNotice] = useState(null);
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
  const remarkResult = remarkTarget ? getRowResult(remarkTarget.id) : null;
  const remarkMarks = marks ?? {};
  /** Term the remark editor saves into (consolidated edits the ANNUAL remark). */
  const remarkTermId = isConsolidated ? 'annual' : (activeTab.termId ?? 'annual');
  /**
   * Saved remark of one pupil for the ACTIVE term — the grid's মন্তব্য column and the
   * remark modal share it, so what the teacher types is what the row previews.
   */
  const getTermRemark = useCallback(
    (studentId) => getRemark?.(studentId, remarkTermId) ?? '',
    [getRemark, remarkTermId],
  );
  const weights = normalizedWeightPercent(config.weights);
  /**
   * Per-subject vs total full marks — the old subtitle printed the TOTAL (e.g. ৭০০)
   * after "প্রতি বিষয়ে পূর্ণমান". Every subject normally carries ১০০, but a school
   * may customise one subject, so keep every distinct value instead of assuming.
   */
  const totalFullMarks = useMemo(
    () => config.subjects.reduce((sum, subject) => sum + (Number(subject.fullMarks) || 0), 0),
    [config.subjects],
  );
  const perSubjectFullMarksLabel = useMemo(
    () => [...new Set(config.subjects.map((subject) => Number(subject.fullMarks) || 0))]
      .map((value) => toBanglaNumber(value)).join(' / '),
    [config.subjects],
  );
  const goldenCount = useMemo(
    () => classRows.filter((row) => row.result?.isGolden).length,
    [classRows],
  );
  const passedCount = useMemo(
    () => classRows.filter((row) => row.result?.isPass).length,
    [classRows],
  );

  /** Absolute origin so the printed QR code always resolves when scanned. */
  const verifyOrigin = typeof window === 'undefined' ? '' : window.location.origin;

  /**
   * Every marksheet of the active class/শাখা/tab, in the current sort order.
   * The single-pupil preview and the bulk PDF render from this ONE list, so both
   * layouts always contain identical data.
   */
  const marksheetRows = useMemo(() => {
    const positionOf = new Map(
      (isConsolidated ? consolidatedRows : classRows).map((row) => [row.studentId, row.position]),
    );
    const list = students
      .map((student) => ({
        student,
        result: getRowResult(student.id),
        position: positionOf.get(student.id),
      }))
      .filter((row) => Boolean(row.result));
    if (sortMode === 'merit') {
      return [...list].sort((a, b) => (
        (a.position ?? Number.MAX_SAFE_INTEGER) - (b.position ?? Number.MAX_SAFE_INTEGER)
      ));
    }
    return [...list].sort((a, b) => (
      (Number(a.student?.roll) || Number.MAX_SAFE_INTEGER) - (Number(b.student?.roll) || Number.MAX_SAFE_INTEGER)
    ));
  }, [students, getRowResult, isConsolidated, consolidatedRows, classRows, sortMode]);

  /** Single-pupil / class-wide print: mount the sheet(s), print, then restore the UI. */
  const printSheets = () => {
    const cleanup = () => {
      setBulkPrint(false);
      window.removeEventListener('afterprint', cleanup);
    };
    window.addEventListener('afterprint', cleanup);
    // Give React one frame to mount the sheet(s) before the print dialog opens.
    setTimeout(() => window.print(), 80);
  };

  /**
   * সরাসরি PDF ডাউনলোড — প্রিন্ট ডায়ালগ খোলে না। `downloadSheetsAsPdf` মার্কশিট
   * এলিমেন্টগুলোকে A4 PDF-এ রেন্ডার করে (০.৭৫ ইঞ্চি মার্জিন; ১টি/পেজে পুরো পেজ,
   * ২টি/পেজে অর্ধেক-অর্ধেক) এবং ফাইল ডাউনলোড করে। প্রিন্ট বোতাম আলাদাই থাকে।
   */
  const downloadMarksheetPdf = async ({ bulk }) => {
    if (downloadingPdf || !marksheetRows.length) return;
    const previousBulk = bulkPrint;
    setDownloadingPdf(true);
    try {
      if (bulk !== bulkPrint) {
        setBulkPrint(bulk);
        // React-কে শিটগুলো মাউন্ট করার সময় দেওয়া — তারপরেই ক্যাপচার।
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
      const namePart = bulk ? 'সব-শিক্ষার্থী' : (printTarget?.name ?? 'মার্কশিট');
      await downloadSheetsAsPdf(printRootRef.current, {
        filename: `${schoolProfile?.name || 'বিদ্যালয়'}-${CLASS_LABEL_MAP[classId]}-${activeTab.name}-${namePart}-${activeYear}.pdf`,
        sheetsPerPage: pageLayout === 'pair' ? 2 : 1,
      });
      toast.success('PDF ডাউনলোড হয়েছে');
    } catch {
      toast.error('PDF তৈরি করা যায়নি — আবার চেষ্টা করুন');
    } finally {
      if (bulk !== previousBulk) setBulkPrint(previousBulk);
      setDownloadingPdf(false);
    }
  };

  /**
   * Year-end rollover confirmed in the promotion modal — ONE class at a time.
   *
   * `advanceClassYear` writes the NEW year's roster for that class only (same
   * `studentMasterId`s, empty results) and records the completion, which locks
   * the class. The finished year stays frozen, the year activates only when
   * all six classes are done, and a failure surfaces a clear Bangla error —
   * never a silent "synced". The other classes are NOT touched here: the
   * modal's decisions cover exactly the class it was opened on.
   */
  const handleAdvanceYear = useCallback(async (payload = {}) => {
    setYearNotice(null);
    const result = await advanceClassYear?.({
      year: payload.year || activeYear,
      nextYear: payload.nextYear || nextSessionYear(activeYear),
      decisions: payload.decisions ?? [],
      fromClassId: payload.fromClassId || '',
    });
    if (!result?.synced) {
      const reason = result?.reason === 'offline'
        ? 'ইন্টারনেট সংযোগ নেই — প্রমোশন করা যায়নি।'
        : result?.reason === 'already-complete'
          ? 'এই শ্রেণির প্রমোশন ইতিমধ্যেই সম্পূর্ণ হয়েছে।'
          : result?.reason === 'read-only'
            ? 'এই সালটি লক করা — প্রমোশন করা যাবে না।'
            : result?.reason === 'timeout'
              ? 'ক্লাউড সংযোগ সময় শেষ হয়ে গেছে — প্রমোশন হয়নি; আবার চেষ্টা করুন।'
              : 'প্রমোশন করা যায়নি — ক্লাউডে সংরক্ষণ ব্যর্থ হয়েছে; আবার চেষ্টা করুন।';
      setYearNotice({ tone: 'error', text: reason });
      toast.error('সংরক্ষণ করা যায়নি — আবার চেষ্টা করুন');
      return result;
    }
    setYearNotice({
      tone: 'success',
      text: `${getClassName(payload.fromClassId)} শ্রেণির প্রমোশন সম্পন্ন — উত্তীর্ণ ${toBanglaNumber(result.promoted)} জন, একই শ্রেণিতে ${toBanglaNumber(result.retained)} জন, আর্কাইভ ${toBanglaNumber(result.graduated)} জন। নতুন ক্লাসের রেজাল্ট ০০ থেকে শুরু হয়েছে।${
        result?.yearActivated
          ? ` সব শ্রেণি শেষ হয়েছে, তাই ${toBanglaNumber(result.nextYear)} শিক্ষাবর্ষ এখন সক্রিয়।`
          : ' এই শ্রেণির তথ্য এখন লক।'
      }`,
    });
    toast.success('সংরক্ষণ হয়েছে');
    return result;
  }, [advanceClassYear, activeYear]);

  /* ---------------------------------------------------------------- *
   * Excel: download (direct — 6 sheets, all classes) / upload (strict, all
   * 6 sheets) / save (per class, one toast at the end)
   * ---------------------------------------------------------------- */

  /** Per-class result config for ALL six classes (the download covers all of them). */
  const configsByClass = useMemo(() => {
    const map = {};
    CLASS_LEVELS.forEach((level) => {
      map[level.id] = normalizeResultConfig(getResultConfig?.(level.id) ?? null, level.id);
    });
    return map;
  }, [getResultConfig]);

  /**
   * One template spec per class, in CLASS_LEVELS order — every sheet holds ALL
   * pupils of its class, ALL sections (শাখা ক → খ → গ, then roll). The
   * class/শাখা selectors above control only the on-screen grid, never the file.
   */
  const excelSpecs = useMemo(() => CLASS_LEVELS.map((level) => templateSpec({
    schoolProfile,
    classId: level.id,
    year: activeYear,
    tabId,
    config: configsByClass[level.id],
    students: studentsByClass?.[level.id] ?? [],
    sections: getSectionsOfClass?.(level.id) ?? [],
  })), [schoolProfile, activeYear, tabId, configsByClass, studentsByClass, getSectionsOfClass]);

  /** Direct download — no warning popup: one workbook, six class sheets. */
  const handleDownload = async () => {
    if (downloading) return;
    setDownloading(true);
    setUploadError('');
    setUploadInfo('');
    setDownloadNotice('');
    try {
      const computed = {};
      excelSpecs.forEach((item) => {
        (item.students ?? []).forEach((student) => {
          computed[student.id] = getTabResult?.(student.id, tabId) ?? {};
        });
      });
      const { name } = await downloadResultExcel({ specs: excelSpecs, marks, computed });
      setDownloadNotice(`ফাইল ডাউনলোড হয়েছে: ${name}`);
    } catch {
      setDownloadNotice('');
      setUploadError('এক্সেল ফাইল তৈরি করা যায়নি। আবার চেষ্টা করুন।');
    } finally {
      setDownloading(false);
    }
  };

  /**
   * তালিকা ডাউনলোড — the on-screen LIST exactly as shown (হুবহু), all six
   * classes in one file, for the ACTIVE tab only (another tab downloads that
   * term's own file). Values come from the engine (`getClassRows` /
   * `getRemark`), never recomputed here; নতুন রোল comes from the consolidated
   * rows, so a term tab shows it too once the annual result is calculated.
   */
  const listClasses = useMemo(() => CLASS_LEVELS.map((level) => {
    const rows = getClassRows?.(level.id, tabId) ?? [];
    const consolidatedRows = tabId === 'consolidated'
      ? rows
      : (getClassRows?.(level.id, 'consolidated') ?? []);
    const newRollById = new Map(
      consolidatedRows.filter((row) => row?.newRoll != null).map((row) => [row.studentId, row.newRoll]),
    );
    const classStudents = studentsByClass?.[level.id] ?? [];
    return {
      classId: level.id,
      className: CLASS_LABEL_MAP[level.id],
      config: configsByClass[level.id],
      students: classStudents,
      sections: getSectionsOfClass?.(level.id) ?? [],
      rows: rows.map((row) => ({
        ...row,
        newRoll: row.newRoll ?? newRollById.get(row.studentId) ?? null,
      })),
      remarks: Object.fromEntries(
        classStudents.map((student) => [student.id, getRemark?.(student.id, remarkTermId) ?? '']),
      ),
    };
  }), [tabId, getClassRows, configsByClass, studentsByClass, getSectionsOfClass, getRemark, remarkTermId]);

  /** Small list download — a read-only report, not the upload template. */
  const handleDownloadList = async () => {
    if (downloadingList) return;
    setDownloadingList(true);
    try {
      const { name } = await downloadResultList({
        classes: listClasses,
        schoolName: schoolProfile?.name ?? '',
        year: activeYear,
        tabId,
        tabName: activeTab.name,
      });
      toast.success(`তালিকা ডাউনলোড হয়েছে: ${name}`);
    } catch {
      toast.error('তালিকা তৈরি করা যায়নি — আবার চেষ্টা করুন');
    } finally {
      setDownloadingList(false);
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
      const parsed = await parseResultWorkbook(new Uint8Array(buffer), excelSpecs);
      if (!parsed?.ok) {
        setUploadError(parsed?.message ?? 'ফাইলটি যাচাই করা যায়নি।');
        return;
      }
      setPreview({ rowsByClass: parsed.rowsByClass ?? {}, specs: excelSpecs });
      setUploadInfo('ফাইল যাচাই সম্পন্ন — স্ক্রিন প্রিভিউ থেকে সংরক্ষণ করুন।');
    } catch {
      setUploadError('ফাইল প্রক্রিয়া করা যায়নি। আবার চেষ্টা করুন।');
    } finally {
      setParsingUpload(false);
    }
  };


  /**
   * Saves the previewed workbook — ONE multi-path database write per class
   * (per class + term), so a 40-pupil upload is a single atomic update inside
   * this school's own year partition. The preview modal closes on success, so
   * the toast is the visible confirmation; on failure the modal stays open
   * with its own error and the toast floats above it.
   *
   * `mergedByClass` comes from the preview modal (`{ classId: mergedMarks }`)
   * but is only used to know which classes were parsed; the ENTRIES written
   * are built from the parsed rows, exactly like the old single-class save.
   */
  const savePreview = async (mergedByClass) => {
    if (isConsolidated || !activeTab.termId) return { synced: false };
    setSavingPreview(true);
    try {
      const classIds = Object.keys(preview?.rowsByClass ?? {});
      let savedAny = false;
      let lastResult = { synced: true };
      for (const previewClassId of classIds) {
        const classRows = preview.rowsByClass[previewClassId] ?? {};
        if (!Object.keys(classRows).length) continue;
        const entries = {};
        Object.entries(classRows).forEach(([studentId, fields]) => {
          entries[studentId] = Object.fromEntries(
            Object.entries(fields ?? {}).map(([fieldKey, mark]) => [fieldKey, { value: mark }]),
          );
        });
        const result = await applyImportedMarks?.(entries, {
          classId: previewClassId,
          termId: activeTab.termId,
          config: configsByClass[previewClassId],
        });
        lastResult = result ?? { synced: true };
        if (result?.synced === false) {
          toast.error(result?.reason === 'class-locked'
            ? `${getClassName(previewClassId)} শ্রেণির প্রমোশন সম্পূর্ণ হয়েছে — নম্বর সংরক্ষণ করা যাবে না`
            : 'সংরক্ষণ করা যায়নি — আবার চেষ্টা করুন');
          return result;
        }
        savedAny = true;
      }
      if (!savedAny) return { synced: false };
      setUploadInfo('এক্সেলের নম্বর সফলভাবে সংরক্ষণ হয়েছে।');
      toast.success('সংরক্ষণ হয়েছে');
      return lastResult;
    } catch {
      // The modal also shows its own inline error for this; returning
      // `{ synced: false }` (instead of throwing) is what triggers it.
      toast.error('সংরক্ষণ করা যায়নি — আবার চেষ্টা করুন');
      return { synced: false };
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

    {yearNotice ? (
      <p
        role={yearNotice.tone === 'error' ? 'alert' : 'status'}
        className={`no-print mb-4 rounded-xl p-3 text-xs font-bold ${yearNotice.tone === 'error'
          ? 'bg-rose-50 text-rose-800 dark:bg-rose-950/40 dark:text-rose-200'
          : 'bg-emerald-50 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-200'}`}
      >
        {yearNotice.text}
      </p>
    ) : null}

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

    <Card className="mb-4 min-w-0 no-print">
      <div className="flex min-w-0 flex-wrap items-end justify-between gap-3">
        <div className="flex min-w-0 flex-wrap items-end gap-3">
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
            <button type="button" className="btn-secondary" onClick={() => setPromoting(true)} disabled={isReadOnly} title={isReadOnly ? 'এই সালটি লক করা — প্রমোশন করা যাবে না' : undefined}>
              <ArrowUpRight size={15} /> বার্ষিক শ্রেণি উত্তরণ
            </button>
          )}
        </div>
        <div className="flex min-w-0 flex-wrap items-center gap-2">
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
        subtitle={`সব শ্রেণি · ৬টি শিট · ${activeTab.name} · ${activeYear} শিক্ষাবর্ষ`}
        icon={FileSpreadsheet}
        action={<div className="flex flex-wrap items-center gap-2">
          <button type="button" className="btn-secondary btn-sm" onClick={handleDownload} disabled={downloading || parsingUpload}>
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
      {isConsolidated ? (
        <p className="mt-2 text-[11px] font-semibold text-slate-500 dark:text-slate-400">
          বার্ষিক ফলাফল ট্যাব স্বয়ংক্রিয়ভাবে হিসাব হয়, তাই এখানে আপলোড নেই — অন্য তিনটি ট্যাবে নম্বর দিন।
        </p>
      ) : null}
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

    <Card padded={false} className="min-w-0 no-print">
      <div className="relative min-w-0 p-3 sm:p-4">
        <CardHeader
          title={`${CLASS_LABEL_MAP[classId]} · ${activeTab.name}`}
          subtitle={isConsolidated
            ? `১ম (${toBanglaNumber(weights.term1)}%) + ২য় (${toBanglaNumber(weights.term2)}%) + বার্ষিক (${toBanglaNumber(weights.annual)}%) অনুযায়ী চূড়ান্ত ফলাফল · মেধাক্রম ও নতুন রোল`
            : `প্রতি বিষয়ে পূর্ণমান ${perSubjectFullMarksLabel} · মোট পূর্ণমান ${toBanglaNumber(totalFullMarks)} · পাস নম্বর ${toBanglaNumber(config.passMark)} · এই প্রান্তিকের পৃথক মেধাক্রম`}
          action={<button
            type="button"
            className="btn-secondary btn-sm"
            onClick={handleDownloadList}
            disabled={downloadingList}
            title="পর্দার তালিকাটি হুবহু এক্সেলে ডাউনলোড করুন (৬ শ্রেণি, এই প্রান্তিকের ফাইল)"
          >
            {downloadingList
              ? <><Spinner size="xs" tone="brand" label="তালিকা তৈরি হচ্ছে…" /> তৈরি হচ্ছে…</>
              : <><Download size={13} /> তালিকা ডাউনলোড</>}
          </button>}
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
        {isConsolidated ? (
          <ConsolidatedAnnualTable
            rows={classRows}
            weights={weights}
            sortMode={sortMode}
            onSortModeChange={setSortMode}
            onShowStudent={setProfileTarget}
            onShowResult={setResultTarget}
            getRemark={getTermRemark}
            onShowRemark={setRemarkTarget}
            switching={switching}
            isHydrating={isHydrating}
          />
        ) : (
          <SpreadsheetMarksGrid
            students={students}
            marks={marks}
            config={config}
            tabId={tabId}
            getResult={getRowResult}
            onEntry={setMark}
            setMark={setMark}
            canEdit={!isConsolidated && canEditMarks && !isReadOnly && !isClassLocked(classId)}
            onShowStudent={setProfileTarget}
            onShowRemark={setRemarkTarget}
            onShowResult={setResultTarget}
            getRemark={getTermRemark}
            sortMode={sortMode}
            onSortModeChange={setSortMode}
            newRollMap={newRollMap}
            saving={syncState === 'saving'}
          />
        )}
      </div>

      <div className="flex min-w-0 flex-wrap items-end justify-between gap-3 border-t border-slate-100 p-3 sm:p-4 dark:border-slate-800">
        <div className="flex min-w-0 flex-wrap gap-2">
          {/* Every row — not just the first 4. The grid's মন্তব্য column already opens
              this same modal for every pupil, so these buttons reuse setRemarkTarget
              and the single AIRemarkModal below; no second modal logic. */}
          {students.map((student) => (
            <button key={student.id} className="btn-secondary btn-sm" onClick={() => setRemarkTarget(student)}>
              <Sparkles size={13} />{student.name} · মন্তব্য
            </button>
          ))}
        </div>
        <p className="text-[11px] font-semibold text-slate-500">
          শিক্ষার্থীর নাম ক্লিক করলেই পূর্ণাঙ্গ তথ্য ও ফলাফল দেখা যাবে; মন্তব্য দেখে সম্পাদনা ও সংরক্ষণ করতে <b>মন্তব্য</b> কলাম/বাটনে ক্লিক করুন।
        </p>
      </div>
    </Card>

    {/* মার্কশিট প্রিন্ট / PDF — single pupil + whole class, two A4 layouts */}
    <Card className="mt-4 min-w-0 no-print">
      <CardHeader
        title="মার্কশিট প্রিন্ট ও PDF ডাউনলোড"
        subtitle={`${CLASS_LABEL_MAP[classId]} · ${activeTab.name} · ${toBanglaNumber(marksheetRows.length)} জনের মার্কশিট প্রস্তুত`}
        icon={FileText}
      />

      <div className="mb-3">
        <p className="label-base">পেজ লেআউট</p>
        <div className="grid gap-2 sm:grid-cols-2">
          {PAGE_LAYOUTS.map((layout) => {
            const active = pageLayout === layout.id;
            return (
              <button
                key={layout.id}
                type="button"
                onClick={() => setPageLayout(layout.id)}
                aria-pressed={active}
                className={`flex items-start gap-2.5 rounded-xl border p-3 text-left transition ${
                  active
                    ? 'border-brand-600 bg-brand-50 text-brand-900 dark:border-brand-400 dark:bg-brand-900/30 dark:text-brand-100'
                    : 'border-slate-200 bg-white text-slate-600 hover:border-brand-300 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300 dark:hover:bg-slate-800'
                }`}
              >
                <span
                  className={`mt-0.5 flex h-8 w-6 shrink-0 flex-col overflow-hidden rounded border ${
                    active ? 'border-brand-500' : 'border-slate-300 dark:border-slate-600'
                  }`}
                  aria-hidden="true"
                >
                  <span className={`h-full w-full ${active ? 'bg-brand-200' : 'bg-slate-100 dark:bg-slate-700'}`} />
                  {layout.id === 'pair' ? (
                    <span className={`h-full w-full border-t ${active ? 'border-brand-500 bg-brand-100' : 'border-slate-300 bg-white dark:border-slate-600 dark:bg-slate-800'}`} />
                  ) : null}
                </span>
                <span className="min-w-0">
                  <span className="block text-xs font-bold">{layout.name}</span>
                  <span className="block text-[11px] opacity-75">{layout.hint}</span>
                </span>
              </button>
            );
          })}
        </div>
      </div>

      <div className="flex min-w-0 flex-wrap items-end justify-between gap-3">
        <div className="flex min-w-0 flex-wrap items-end gap-2">
          <label className="min-w-0 max-w-full">
            <span className="label-base">প্রিন্টের শিক্ষার্থী</span>
            <select
              className="input-base min-w-44 max-w-full"
              value={printTargetId || students[0]?.id || ''}
              onChange={(event) => setPrintTargetId(event.target.value)}
            >
              {students.map((student) => (
                <option key={student.id} value={student.id}>{student.name} · রোল {student.roll}</option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className="btn-primary"
            onClick={() => {
              setBulkPrint(false);
              printSheets();
            }}
            disabled={!printTarget || !canPrintDocuments}
          >
            <Printer size={15} /> একক শিক্ষার্থীর প্রিন্ট
          </button>
          <button
            type="button"
            className="btn-secondary"
            onClick={() => downloadMarksheetPdf({ bulk: false })}
            disabled={!printTarget || !canPrintDocuments || downloadingPdf}
          >
            {downloadingPdf
              ? <><Spinner size="xs" tone="brand" label="PDF তৈরি হচ্ছে…" /> PDF তৈরি হচ্ছে…</>
              : <><Download size={15} /> একক শিক্ষার্থীর PDF ডাউনলোড</>}
          </button>
        </div>
        <div className="flex min-w-0 flex-wrap items-end gap-2">
          <button
            type="button"
            className="btn-emerald"
            onClick={() => downloadMarksheetPdf({ bulk: true })}
            disabled={!marksheetRows.length || !canPrintDocuments || downloadingPdf}
          >
            {downloadingPdf
              ? <><Spinner size="xs" tone="white" label="PDF তৈরি হচ্ছে…" /> PDF তৈরি হচ্ছে…</>
              : <><Download size={15} /> সব শিক্ষার্থীর একসাথে PDF ডাউনলোড</>}
          </button>
        </div>
      </div>

      <p className="mt-2 rounded-xl bg-slate-50 p-2.5 text-[11px] font-semibold text-slate-600 dark:bg-slate-800 dark:text-slate-300">
        <b>PDF ডাউনলোড</b> বোতামে চাপলেই সরাসরি PDF ফাইল ডাউনলোড হবে — প্রিন্ট ডায়ালগ খুলবে না।
        প্রিন্ট করতে চাইলে <b>প্রিন্ট</b> বোতাম ব্যবহার করুন, সেখানে Save as PDF-ও বেছে নেওয়া যাবে।
        নির্বাচিত লেআউট:{' '}
        <b>{PAGE_LAYOUTS.find((layout) => layout.id === pageLayout)?.name}</b>
        {pageLayout === 'pair' ? ' — দুই মার্কশিট এক পেজে উপর-নিচে অর্ধেক-অর্ধেক করে বসবে।' : ' — প্রতিটি মার্কশিট আলাদা পেজে যাবে।'}
      </p>
    </Card>

    {/* মার্কশিট প্রিভিউ: ১৭১.৯mm চওড়া A4 শিট (০.৭৫ ইঞ্চি মার্জিন বাদে ছাপার জায়গা) — ছোট স্ক্রিনে পাশে স্ক্রল হবে (প্রিন্টে স্ক্রল থাকবে না)। */}
    <div className="max-w-full overflow-x-auto scroll-thin print:overflow-visible">
    <div ref={printRootRef} className={pageLayout === 'pair' ? 'print-root print-pair' : 'print-root print-single'}>
      {(bulkPrint ? marksheetRows : marksheetRows.filter((row) => row.student.id === printTarget?.id)).map((row) => (
        <ResultMarksheetA4
          key={row.student.id}
          student={row.student}
          result={row.result}
          remark={getRemark(row.student.id, isConsolidated ? 'annual' : activeTab.termId)}
          schoolProfile={schoolProfile}
          tabId={tabId}
          tabName={activeTab.name}
          position={row.position}
          layout={pageLayout}
          verifyOrigin={verifyOrigin}
        />
      ))}
    </div>
    </div>

    {remarkTarget && (
      <AIRemarkModal
        open
        onClose={() => setRemarkTarget(null)}
        student={remarkTarget}
        result={remarkResult}
        marks={remarkMarks}
        config={config}
        termId={remarkTermId}
        termName={isConsolidated ? 'বার্ষিক ফলাফল' : activeTab.name}
        initialRemark={getTermRemark(remarkTarget.id)}
        onSave={(text) => {
          setRemark(remarkTarget.id, text, remarkTermId);
          toast.success('সংরক্ষণ হয়েছে');
        }}
      />
    )}

    <ResultConfigModal
      open={settingsOpen}
      onClose={() => setSettingsOpen(false)}
      classId={classId}
      config={config}
      canEdit={(canManageStudents || Boolean(saveResultConfig)) && !isReadOnly && !isClassLocked(classId)}
      onSave={saveResultConfig}
      onReset={resetResultConfig}
    />

    <ExcelPreviewModal
      open={Boolean(preview)}
      onClose={() => setPreview(null)}
      classes={(preview?.specs ?? excelSpecs).map((item) => ({
        spec: item,
        config: configsByClass[item.classId],
        rows: preview?.rowsByClass?.[item.classId] ?? {},
      }))}
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
      schoolId={schoolId}
      activeYear={activeYear}
    />

    <StudentResultModal
      open={Boolean(resultTarget)}
      onClose={() => setResultTarget(null)}
      student={resultTarget ? (allStudents.find((item) => item.id === resultTarget.id) ?? resultTarget) : null}
      marks={marks}
      getStudentResult={getStudentResult}
      getTermResult={getTermResult}
      getClassAnalytics={getClassAnalytics}
      getRemark={getRemark}
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
      getRemark={getRemark}
      onExecute={(decisions, options) => {
        // In-year promotion writes locally (cloud write runs inside the store) —
        // the toast confirms the local save, the sync badge shows the cloud state.
        executePromotion(decisions, options);
        toast.success('সংরক্ষণ হয়েছে');
      }}
      currentYear={activeYear}
      nextYear={nextSessionYear(activeYear)}
      onAdvanceYear={handleAdvanceYear}
      promotionState={promotionState}
      onUndoClass={undoClassPromotion}
    />
  </>;
}

