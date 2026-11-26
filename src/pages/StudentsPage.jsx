import { useEffect, useMemo, useState } from 'react';
import { UserPlus, ArrowUpRight, Sparkles, RotateCcw, Search, FileSpreadsheet, Download, Upload } from 'lucide-react';
import { useSearchParams } from 'react-router-dom';
import { useSchoolData } from '../context/SchoolDataContext.jsx';
import { useAuth } from '../context/AuthContext.jsx';
import { isDemoLoginEnabled } from '../context/AuthContext.jsx';
import { CLASS_LEVELS, CLASS_TABS } from '../utils/constants.js';
import { createDemoStudents } from '../utils/demoSeedData.js';
import { DEFAULT_SECTION_ID } from '../services/database/dbPaths.js';
import { toBanglaNumber } from '../utils/banglaNumberFormatter.js';
import { Card } from '../components/ui/Primitives.jsx';
import Modal from '../components/ui/Modal.jsx';
import Spinner from '../components/ui/Spinner.jsx';
import { useToast } from '../components/ui/Toast.jsx';
import ClassTabs from '../components/students/ClassTabs.jsx';
import SectionSelect from '../components/students/SectionSelect.jsx';
import StudentTable from '../components/students/StudentTable.jsx';
import AddStudentModal from '../components/students/AddStudentModal.jsx';
import StudentDetailsModal from '../components/students/StudentDetailsModal.jsx';
import AutoPromotionModal from '../components/students/AutoPromotionModal.jsx';
import StudentResultModal from '../components/results/StudentResultModal.jsx';
import ExcelDownloadWarningModal from '../components/results/ExcelDownloadWarningModal.jsx';
import StudentExcelPreviewModal from '../components/students/StudentExcelPreviewModal.jsx';
import { downloadStudentWorkbook } from '../services/excel/studentExcel.js';
import { parseStudentWorkbook } from '../services/excel/studentExcel.js';
import { buildImportPlan } from '../utils/studentImportPlan.js';
import { nextSessionYear } from '../services/database/sessionService.js';

export default function StudentsPage() {
  const { students, studentsByClass, sectionCounts, marks, schoolId, activeYear, addStudent, importStudents, updateStudent, archiveStudent, restoreStudent, getStudentResult, getStudentClassRank, getClassRankMap, getTermResult, getClassAnalytics, getResultConfig, getRemark, executePromotion, advanceAcademicYear, getSectionsOfClass, getStudentsOfSection, addSection, renameSection, removeSection, isHydrating } = useSchoolData();
  const { canManageStudents } = useAuth();
  const toast = useToast();
  const [tab, setTab] = useState('pre');
  const [section, setSection] = useState(DEFAULT_SECTION_ID);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState(null);
  const [selected, setSelected] = useState(null);
  const [resultTarget, setResultTarget] = useState(null);
  const [restoring, setRestoring] = useState(null);
  const [restoreClassId, setRestoreClassId] = useState('pre');
  const [promoting, setPromoting] = useState(false);
  const [demoMessage, setDemoMessage] = useState('');
  /* ---- 6-sheet Excel download / upload ---- */
  const [downloadWarningOpen, setDownloadWarningOpen] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [excelNotice, setExcelNotice] = useState({ tone: '', text: '' });
  const [parsing, setParsing] = useState(false);
  const [importPlan, setImportPlan] = useState(null);
  const [savingImport, setSavingImport] = useState(false);
  const counts = useMemo(() => Object.fromEntries(CLASS_TABS.map((item) => [item.id, studentsByClass[item.id]?.length ?? 0])), [studentsByClass]);

  // Class tabs (pre-primary ➔ class-5) are the only ones split by শাখা; the archive
  // tab keeps its flat list, and a class that lost its শাখা falls back to `ক`.
  const sectioned = tab !== 'archive';
  const sections = useMemo(() => (sectioned ? getSectionsOfClass(tab) : []), [sectioned, tab, getSectionsOfClass]);
  const activeSection = sections.includes(section) ? section : DEFAULT_SECTION_ID;
  useEffect(() => {
    if (sectioned && section !== activeSection) setSection(activeSection);
  }, [sectioned, section, activeSection]);

  const classStudents = studentsByClass[tab] ?? [];
  const visibleStudents = sectioned ? getStudentsOfSection(tab, activeSection) : classStudents;
  /**
   * Roster search (topbar ➔ `/students?q=…`). It filters the current class + শাখা list
   * by name, roll or birth-certificate number, so the topbar search box is a real,
   * working entry point instead of a decorative input.
   */
  const [searchParams, setSearchParams] = useSearchParams();
  const query = String(searchParams.get('q') ?? '').trim();
  const searchedStudents = useMemo(() => {
    if (!query) return visibleStudents;
    const needle = query.toLowerCase();
    return visibleStudents.filter((student) => [
      student?.name,
      student?.roll,
      student?.birthCertificateNo,
      student?.fatherName,
      student?.motherName,
    ].some((field) => String(field ?? '').toLowerCase().includes(needle)));
  }, [visibleStudents, query]);
  const visibleCount = searchedStudents.length;

  const addDemoStudents = () => {
    if (!isDemoLoginEnabled()) {
      setDemoMessage('ডেমো শিক্ষার্থী যোগ করার সুবিধা এই পরিবেশে বন্ধ আছে।');
      return;
    }
    if (!window.confirm('ডেমো (নমুনা) শিক্ষার্থী যোগ করবেন? এরা এই বিদ্যালয়ের আসল তালিকায় যুক্ত হবে।')) return;
    const classId = tab === 'archive' ? 'pre' : tab;
    const targetSection = classId === tab && sectioned ? activeSection : DEFAULT_SECTION_ID;
    const sectionRoster = (studentsByClass[classId] ?? []).filter((student) => (student.section || DEFAULT_SECTION_ID) === targetSection);
    const existingNames = new Set(sectionRoster.map((student) => String(student.name ?? '').trim()));
    const samples = createDemoStudents().filter((student) => student.classId === classId);
    const unused = samples.filter((student) => !existingNames.has(student.name)).slice(0, 3);
    const entries = unused.length ? unused : samples.slice(0, 3).map((student, index) => ({ ...student, name: `${student.name} (ডেমো ${sectionRoster.length + index + 1})` }));
    const firstRoll = Math.max(0, ...sectionRoster.map((student) => Number(student.roll) || 0)) + 1;
    entries.forEach((student, index) => addStudent({ ...student, classId, section: targetSection, roll: firstRoll + index, isDemo: true }));
    setDemoMessage(`${entries.length} জন ডেমো শিক্ষার্থী ${classId === tab ? 'এই' : 'প্রাক-প্রাথমিক'} শ্রেণির ${targetSection} শাখায় যোগ হয়েছে।`);
  };
  /**
   * New admission / edit save. `addStudent` / `updateStudent` apply the local
   * roster write synchronously (the modal already closed on it); the cloud write
   * runs fire-and-forget inside them and its state is shown by the sync badge —
   * so the toast confirms the local save, it never claims the cloud is done.
   */
  const saveStudent = (student) => {
    student.id ? updateStudent(student.id, student) : addStudent(student);
    toast.success('সংরক্ষণ হয়েছে');
  };

  /* ---------------------------------------------------------------- *
   * 6-sheet Excel workbook: download (warned) ➔ upload (validated) ➔ preview
   * ---------------------------------------------------------------- */

  /** Runs only after the teacher confirms inside the warning popup. */
  const handleExport = async () => {
    if (downloading) return;
    setDownloading(true);
    setExcelNotice({ tone: '', text: '' });
    try {
      const { name } = await downloadStudentWorkbook({ students, suffix: activeYear });
      setExcelNotice({ tone: 'success', text: `ফাইল ডাউনলোড হয়েছে: ${name}` });
      setDownloadWarningOpen(false);
    } catch {
      setExcelNotice({ tone: 'error', text: 'এক্সেল ফাইল তৈরি করা যায়নি। আবার চেষ্টা করুন।' });
      setDownloadWarningOpen(false);
    } finally {
      setDownloading(false);
    }
  };

  /**
   * Strict upload: the workbook must keep its six sheet names and header row.
   * A rejection names the sheet, row, column and reason — nothing is written.
   */
  const handleUpload = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    setExcelNotice({ tone: '', text: '' });
    setImportPlan(null);
    setParsing(true);
    try {
      let buffer;
      try {
        buffer = await file.arrayBuffer();
      } catch {
        setExcelNotice({ tone: 'error', text: 'ফাইলটি পড়া যায়নি।' });
        return;
      }
      const parsed = await parseStudentWorkbook(new Uint8Array(buffer));
      if (!parsed?.ok) {
        setExcelNotice({ tone: 'error', text: parsed?.message ?? 'ফাইলটি যাচাই করা যায়নি।' });
        return;
      }
      // The plan applies the 80% similarity rule + bucket-scoped roll uniqueness.
      const plan = buildImportPlan({ rows: parsed.rows, roster: students });
      setImportPlan(plan);
      setExcelNotice({
        tone: 'success',
        text: `ফাইল যাচাই সম্পন্ন — ${toBanglaNumber(plan.summary.total)} সারি; প্রিভিউ থেকে সংরক্ষণ করুন।`,
      });
    } catch {
      setExcelNotice({ tone: 'error', text: 'ফাইল প্রক্রিয়া করা যায়নি। আবার চেষ্টা করুন।' });
    } finally {
      setParsing(false);
    }
  };

  /**
   * Year-end rollover (`বার্ষিক শিক্ষাবর্ষ উত্তরণ`), reachable from the roster screen.
   *
   * `promoteSession()` only WRITES the destination year, files Class-5 leavers into the
   * finished year's `passedArchive` and moves `profile.activeYear`; the finished year
   * itself (roster, results, attendance, remarks) is never modified. The new class's
   * result therefore starts empty and displays `০০` / `ফলাফল নেই`.
   */
  const advanceYear = async (payload = {}) => {
    const result = await advanceAcademicYear?.({
      year: payload.year || activeYear,
      nextYear: payload.nextYear || nextSessionYear(activeYear),
      decisions: payload.decisions ?? [],
    });
    if (result?.synced === false) {
      setExcelNotice({
        tone: 'error',
        text: result?.reason === 'offline'
          ? 'ইন্টারনেট সংযোগ নেই — নতুন শিক্ষাবর্ষ শুরু করা যায়নি।'
          : 'নতুন শিক্ষাবর্ষ শুরু করা যায়নি — আবার চেষ্টা করুন।',
      });
      return result;
    }
    setExcelNotice({
      tone: 'success',
      text: `${toBanglaNumber(result?.nextYear ?? '')} শিক্ষাবর্ষ শুরু হয়েছে — উত্তীর্ণ ${toBanglaNumber(result?.promoted ?? 0)} জন, আর্কাইভ ${toBanglaNumber(result?.graduated ?? 0)} জন। নতুন ক্লাসের রেজাল্ট ০০ থেকে শুরু হয়েছে।`,
    });
    return result;
  };

  /** Commits the reviewed plan (the whole file as one atomic multi-path write). */
  const saveImport = async ({ force = false } = {}) => {
    if (!importPlan) return { synced: true };
    setSavingImport(true);
    try {
      const result = await importStudents(importPlan, { force });
      if (result?.synced === false) {
        // The preview modal stays open on failure and shows its own error; the
        // toast is the floating confirmation above it.
        toast.error('সংরক্ষণ করা যায়নি — আবার চেষ্টা করুন');
        setExcelNotice({ tone: 'error', text: 'এক্সেল আমদানি ক্লাউডে সংরক্ষণ করা যায়নি — ইন্টারনেট সংযোগ দেখে আবার চেষ্টা করুন।' });
        return result;
      }
      toast.success('সংরক্ষণ হয়েছে');
      setExcelNotice({
        tone: 'success',
        text: `আমদানি সম্পন্ন — নতুন ${toBanglaNumber(result?.created ?? 0)} জন, হালনাগাদ ${toBanglaNumber(result?.updated ?? 0)} জন।`,
      });
      setImportPlan(null);
      return result;
    } finally {
      setSavingImport(false);
    }
  };

  const confirmArchive = async (student) => {
    if (!window.confirm(`${student.name} — আর্কাইভে পাঠালে সক্রিয় শ্রেণির তালিকা থেকে সরানো হবে। চালিয়ে যাবেন?`)) return;
    const result = await archiveStudent(student.id);
    if (result?.ok) {
      setExcelNotice({
        tone: 'success',
        text: result?.pending
          ? `${student.name} আর্কাইভে পাঠানো হচ্ছে — সংযোগ ধীর, কিছুক্ষণ পর যাচাই করুন।`
          : `${student.name} আর্কাইভে পাঠানো হয়েছে।`,
      });
      setEditing(null);
      setSelected(null);
      return;
    }
    // Definite failure: the pupil was rolled back to their class, so the modal
    // stays open and the teacher can retry instead of losing the pupil.
    setExcelNotice({
      tone: 'error',
      text: result?.reason === 'already-archived'
        ? `${student.name} ইতিমধ্যেই আর্কাইভে আছে।`
        : `${student.name} আর্কাইভ করা যায়নি — ইন্টারনেট সংযোগ দেখে আবার চেষ্টা করুন।`,
    });
  };

  const confirmRestore = async () => {
    if (!restoring) return;
    const result = await restoreStudent(restoring.id, restoreClassId);
    if (result?.ok) {
      setExcelNotice({
        tone: 'success',
        text: result?.pending
          ? `${restoring.name} শ্রেণিতে ফিরিয়ে নেওয়া হচ্ছে — সংযোগ ধীর, কিছুক্ষণ পর যাচাই করুন।`
          : `${restoring.name} শ্রেণিতে ফিরিয়ে নেওয়া হয়েছে।`,
      });
      setRestoring(null);
      return;
    }
    setExcelNotice({
      tone: 'error',
      text: result?.reason === 'not-archived'
        ? `${restoring.name} আর্কাইভে নেই, তাই ফিরিয়ে নেওয়া যাবে না।`
        : `${restoring.name} শ্রেণিতে ফিরিয়ে নেওয়া যায়নি — ইন্টারনেট সংযোগ দেখে আবার চেষ্টা করুন।`,
    });
  };

  return <>
    <div className="mb-5"><h2 className="text-xl font-extrabold">শিক্ষার্থী ব্যবস্থাপনা</h2><p className="text-xs text-slate-500">শ্রেণিভিত্তিক তালিকা, ভর্তি ও বার্ষিক উত্তরণ</p></div>
    {isHydrating ? (
      <p role="status" className="mb-3 inline-flex items-center gap-2 rounded-lg bg-brand-50 px-2.5 py-1.5 text-[11px] font-bold text-brand-800 dark:bg-brand-900/40 dark:text-brand-200">
        <Spinner size="xs" tone="rainbow" label="ডেটা লোড হচ্ছে…" />
        ডেটা লোড হচ্ছে…
      </p>
    ) : null}
    <div className="mb-4 flex min-w-0 flex-wrap justify-end gap-2">
      {canManageStudents && <>
        {isDemoLoginEnabled() ? (
          <button className="btn-secondary" onClick={addDemoStudents}><Sparkles size={15} /> ডেমো শিক্ষার্থী যোগ করুন</button>
        ) : null}
        <button className="btn-secondary" onClick={() => { setExcelNotice({ tone: '', text: '' }); setDownloadWarningOpen(true); }} disabled={downloading}>
          <Download size={15} /> এক্সেল ডাউনলোড
        </button>
        <label className={`btn-secondary cursor-pointer ${parsing ? 'pointer-events-none opacity-60' : ''}`}>
          <Upload size={15} /> {parsing ? 'যাচাই হচ্ছে…' : 'এক্সেল আপলোড'}
          <input type="file" accept=".xlsx" className="hidden" onChange={handleUpload} disabled={parsing} aria-label="শিক্ষার্থী এক্সেল আপলোড" />
        </label>
        <button className="btn-secondary" onClick={() => setPromoting(true)}><ArrowUpRight size={15} /> বার্ষিক উত্তরণ</button>
        <button className="btn-primary" onClick={() => setAdding(true)}><UserPlus size={15} /> নতুন ভর্তি</button>
      </>}
    </div>
    {excelNotice.text ? (
      <p
        role={excelNotice.tone === 'error' ? 'alert' : 'status'}
        className={`mb-3 flex items-start gap-1.5 rounded-xl p-2.5 text-[11px] font-semibold leading-relaxed ${excelNotice.tone === 'error'
          ? 'bg-rose-50 text-rose-800 dark:bg-rose-950/40 dark:text-rose-200'
          : 'bg-emerald-50 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-200'}`}
      >
        <FileSpreadsheet size={13} className="mt-0.5 shrink-0" aria-hidden="true" />
        <span>{excelNotice.text}</span>
      </p>
    ) : null}
    {demoMessage && <p role="status" className="mb-3 text-right text-sm text-emerald-700 dark:text-emerald-300">{demoMessage}</p>}
    {query ? (
      <p className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-xl bg-brand-50 px-3 py-2 text-[11px] font-semibold text-brand-800 dark:bg-brand-900/30 dark:text-brand-200">
        <span className="inline-flex items-center gap-1.5">
          <Search size={12} aria-hidden="true" />
          অনুসন্ধান: <b>{query}</b> — {toBanglaNumber(searchedStudents.length)} জন পাওয়া গেছে
        </span>
        <button type="button" className="font-bold underline" onClick={() => setSearchParams({}, { replace: true })}>
          অনুসন্ধান মুছুন
        </button>
      </p>
    ) : null}
    <Card padded={false} className="min-w-0 p-4 sm:p-6">
      <ClassTabs value={tab} onChange={(nextTab) => { setTab(nextTab); setSection(DEFAULT_SECTION_ID); setDemoMessage(''); }} counts={counts} />
      {sectioned && <SectionSelect
        value={activeSection}
        onChange={setSection}
        options={sections}
        counts={sectionCounts[tab] ?? {}}
        total={visibleCount}
        canManage={canManageStudents}
        onAddSection={(label) => addSection(tab, label)}
        onRenameSection={(from, to) => renameSection(tab, from, to)}
        onRemoveSection={(label) => removeSection(tab, label)}
      />}
      <StudentTable students={searchedStudents} canEdit={canManageStudents} isArchive={tab === 'archive'} onSelect={setSelected} onEdit={setEditing}
        onShowResult={setResultTarget} getStudentResult={getStudentResult}
        onRestore={(student) => { setRestoring(student); setRestoreClassId(CLASS_LEVELS.some((item) => item.id === student.previousClassId) ? student.previousClassId : 'pre'); }} />
    </Card>
    <AddStudentModal open={adding} onClose={() => setAdding(false)} onSave={saveStudent} defaultClass={tab === 'archive' ? 'pre' : tab} sectionOptions={sectioned ? sections : []} roster={students} />
    <AddStudentModal open={Boolean(editing)} onClose={() => setEditing(null)} onSave={saveStudent} student={editing} defaultClass={editing?.classId === 'archive' ? (editing?.previousClassId || 'pre') : (editing?.classId || tab)} onArchive={confirmArchive} sectionOptions={editing ? getSectionsOfClass(editing.classId === 'archive' ? (editing.previousClassId || 'pre') : editing.classId) : []} roster={students} getSectionsOfClass={getSectionsOfClass} />
    <StudentDetailsModal open={Boolean(selected)} onClose={() => setSelected(null)} student={selected ? (students.find((item) => item.id === selected.id) ?? selected) : null}
      marks={marks} allStudents={students} getTermResult={getTermResult} getStudentResult={getStudentResult} getClassAnalytics={getClassAnalytics} getResultConfig={getResultConfig}
      schoolId={schoolId} activeYear={activeYear}
      onEdit={canManageStudents ? (student) => { setSelected(null); setEditing(student); } : null} />
    <StudentResultModal open={Boolean(resultTarget)} onClose={() => setResultTarget(null)}
      student={resultTarget ? (students.find((item) => item.id === resultTarget.id) ?? resultTarget) : null}
      marks={marks} getStudentResult={getStudentResult} getTermResult={getTermResult} getClassAnalytics={getClassAnalytics} getRemark={getRemark} />
    <Modal open={Boolean(restoring)} onClose={() => setRestoring(null)} title="শিক্ষার্থীকে শ্রেণিতে ফিরিয়ে নিন" subtitle={restoring?.name} icon={RotateCcw}>
      <div className="space-y-4">
        <label className="block"><span className="label-base">যে শ্রেণিতে ফিরিয়ে নেবেন</span><select className="input-base" value={restoreClassId} onChange={(event) => setRestoreClassId(event.target.value)}>{CLASS_LEVELS.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
        <div className="flex flex-wrap justify-end gap-2"><button type="button" className="btn-secondary" onClick={() => setRestoring(null)}>বাতিল</button><button type="button" className="btn-primary" onClick={confirmRestore}>শ্রেণিতে ফিরিয়ে নিন</button></div>
      </div>
    </Modal>
    <AutoPromotionModal
      open={promoting}
      onClose={() => setPromoting(false)}
      students={students}
      allStudents={students}
      marks={marks}
      getStudentResult={getStudentResult}
      getTermResult={getTermResult}
      getClassAnalytics={getClassAnalytics}
      getStudentClassRank={getStudentClassRank}
      getClassRankMap={getClassRankMap}
      getSectionsOfClass={getSectionsOfClass}
      getResultConfig={getResultConfig}
      getRemark={getRemark}
      schoolId={schoolId}
      activeYear={activeYear}
      onExecute={executePromotion}
      currentYear={activeYear}
      nextYear={nextSessionYear(activeYear)}
      onAdvanceYear={advanceYear}
    />
    <ExcelDownloadWarningModal
      open={downloadWarningOpen}
      onClose={() => { if (!downloading) setDownloadWarningOpen(false); }}
      onConfirm={handleExport}
      downloading={downloading}
      variant="students"
      subtitle={`ছয় শ্রেণির শিক্ষার্থী তালিকা · ${activeYear} শিক্ষাবর্ষ`}
    />
    <StudentExcelPreviewModal
      open={Boolean(importPlan)}
      onClose={() => setImportPlan(null)}
      plan={importPlan}
      onSave={saveImport}
      saving={savingImport}
    />
  </>;
}


