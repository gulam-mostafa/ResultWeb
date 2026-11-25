import { useEffect, useMemo, useState } from 'react';
import { UserPlus, ArrowUpRight, Sparkles, RotateCcw, Search } from 'lucide-react';
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
import ClassTabs from '../components/students/ClassTabs.jsx';
import SectionSelect from '../components/students/SectionSelect.jsx';
import StudentTable from '../components/students/StudentTable.jsx';
import AddStudentModal from '../components/students/AddStudentModal.jsx';
import StudentDetailsModal from '../components/students/StudentDetailsModal.jsx';
import AutoPromotionModal from '../components/students/AutoPromotionModal.jsx';
import StudentResultModal from '../components/results/StudentResultModal.jsx';

export default function StudentsPage() {
  const { students, studentsByClass, sectionCounts, marks, schoolId, activeYear, addStudent, updateStudent, archiveStudent, restoreStudent, getStudentResult, getStudentClassRank, getClassRankMap, getTermResult, getClassAnalytics, getResultConfig, getRemark, executePromotion, getSectionsOfClass, getStudentsOfSection, addSection, renameSection, removeSection } = useSchoolData();
  const { canManageStudents } = useAuth();
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
  const saveStudent = (student) => student.id ? updateStudent(student.id, student) : addStudent(student);
  const confirmArchive = (student) => {
    if (window.confirm(`${student.name} — আর্কাইভে পাঠালে সক্রিয় শ্রেণির তালিকা থেকে সরানো হবে। চালিয়ে যাবেন?`)) {
      archiveStudent(student.id);
      setEditing(null);
      setSelected(null);
    }
  };

  return <>
    <div className="mb-5"><h2 className="text-xl font-extrabold">শিক্ষার্থী ব্যবস্থাপনা</h2><p className="text-xs text-slate-500">শ্রেণিভিত্তিক তালিকা, ভর্তি ও বার্ষিক উত্তরণ</p></div>
    <div className="mb-4 flex flex-wrap justify-end gap-2">
      {canManageStudents && <>
        {isDemoLoginEnabled() ? (
          <button className="btn-secondary" onClick={addDemoStudents}><Sparkles size={15} /> ডেমো শিক্ষার্থী যোগ করুন</button>
        ) : null}
        <button className="btn-secondary" onClick={() => setPromoting(true)}><ArrowUpRight size={15} /> বার্ষিক উত্তরণ</button>
        <button className="btn-primary" onClick={() => setAdding(true)}><UserPlus size={15} /> নতুন ভর্তি</button>
      </>}
    </div>
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
    <Card>
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
        <div className="flex justify-end gap-2"><button type="button" className="btn-secondary" onClick={() => setRestoring(null)}>বাতিল</button><button type="button" className="btn-primary" onClick={() => { if (restoring) restoreStudent(restoring.id, restoreClassId); setRestoring(null); }}>শ্রেণিতে ফিরিয়ে নিন</button></div>
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
      onExecute={executePromotion}
    />
  </>;
}


