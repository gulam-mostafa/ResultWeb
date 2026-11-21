import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ArrowUpRight, Printer, Sparkles } from 'lucide-react';
import { useSchoolData } from '../context/SchoolDataContext.jsx';
import { useAuth } from '../context/AuthContext.jsx';
import { CLASS_LEVELS, CLASS_LABEL_MAP, TERMS } from '../utils/constants.js';
import { Card, CardHeader, Badge } from '../components/ui/Primitives.jsx';
import SpreadsheetMarksGrid from '../components/results/SpreadsheetMarksGrid.jsx';
import AIRemarkModal from '../components/results/AIRemarkModal.jsx';
import TermMarksheetA4 from '../components/documents/TermMarksheetA4.jsx';
import AutoPromotionModal from '../components/students/AutoPromotionModal.jsx';

export default function ResultsPage() {
  const { students: allStudents, studentsByClass, marks, schoolProfile, getStudentResult, getTermResult, setMark, getRemark, setRemark, getStudentClassRank, getClassRankMap, getSectionsOfClass, executePromotion } = useSchoolData();
  const { canManageStudents } = useAuth();
  const [classId, setClassId] = useState('c5');
  const [termId, setTermId] = useState('term1');
  const [remarkTarget, setRemarkTarget] = useState(null);
  const [printTargetId, setPrintTargetId] = useState('');
  const [promoting, setPromoting] = useState(false);
  // The sidebar's "বার্ষিক শ্রেণি উত্তরণ" entry deep-links to `/results?promote=1`.
  const [searchParams, setSearchParams] = useSearchParams();
  useEffect(() => {
    if (searchParams.get('promote') !== '1') return;
    setPromoting(true);
    const next = new URLSearchParams(searchParams);
    next.delete('promote');
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams]);
  const students = studentsByClass[classId] ?? [];
  const activeTerm = TERMS.find((term) => term.id === termId) ?? TERMS[0];
  const getCurrentResult = useMemo(() => (studentId) => termId === 'annual' ? getStudentResult(studentId) : getTermResult(studentId, termId), [getStudentResult, getTermResult, termId]);
  const result = remarkTarget ? getCurrentResult(remarkTarget.id) : null;
  const printTarget = students.find((student) => student.id === printTargetId) ?? students[0];
  const printResult = printTarget ? getTermResult(printTarget.id, termId) : null;
  const printRows = students.map((student) => ({ studentId: student.id, totalMarks: getTermResult(student.id, termId).totalMarks }));
  printRows.sort((a, b) => b.totalMarks - a.totalMarks);
  const printPosition = printTarget ? printRows.findIndex((row) => row.studentId === printTarget.id) + 1 : undefined;

  return <>
    <div className="mb-5"><h2 className="text-xl font-extrabold">ডিজিটাল রেজাল্ট</h2><p className="text-xs text-slate-500">প্রান্তিকভিত্তিক নম্বর, মেধাক্রম ও ফলাফল · বার্ষিকে ওজন ২০% + ২০% + ৬০%</p></div>
    <div className="no-print mb-4 flex flex-wrap gap-2" role="tablist" aria-label="মূল্যায়ন নির্বাচন">{TERMS.map((term) => <button key={term.id} type="button" role="tab" aria-selected={termId === term.id} onClick={() => setTermId(term.id)} className={`rounded-xl border px-4 py-2.5 text-sm font-bold transition ${termId === term.id ? 'border-brand-700 bg-brand-700 text-white shadow-sm' : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300'}`}>{term.id === 'annual' ? term.name : `${term.name} মূল্যায়ন`}</button>)}</div>
    <Card className="mb-4 no-print"><div className="flex flex-wrap items-end justify-between gap-3"><div className="flex flex-wrap items-end gap-3"><label><span className="label-base">শ্রেণি নির্বাচন</span><select className="input-base w-52" value={classId} onChange={(event) => { setClassId(event.target.value); setPrintTargetId(''); }}>{CLASS_LEVELS.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>{canManageStudents && <button type="button" className="btn-secondary" onClick={() => setPromoting(true)}><ArrowUpRight size={15}/> বার্ষিক শ্রেণি উত্তরণ</button>}</div><div className="flex items-center gap-2"><Badge tone="brand">৬ বিষয় · {activeTerm.weightLabel}</Badge><span className="text-xs text-slate-500">তীরচিহ্ন / Enter দিয়ে ঘর বদলান</span></div></div></Card>
    <Card padded={false} className="no-print"><div className="p-4"><CardHeader title={`${CLASS_LABEL_MAP[classId]} · ${activeTerm.name} নম্বরপত্র`} subtitle={termId === 'annual' ? 'বার্ষিক নম্বর প্রবেশ · চূড়ান্ত ফলাফল ২০% + ২০% + ৬০% ওজনে' : 'প্রতি বিষয়ে ০–১০০ নম্বর · এই প্রান্তিকের পৃথক মেধাক্রম'} /></div><SpreadsheetMarksGrid students={students} marks={marks} getStudentResult={getCurrentResult} setMark={setMark} canEdit activeTerm={termId}/>
      <div className="flex flex-wrap items-end justify-between gap-3 border-t border-slate-100 p-4 dark:border-slate-800"><div className="flex flex-wrap gap-2">{students.slice(0, 4).map((student) => <button key={student.id} className="btn-secondary btn-sm" onClick={() => setRemarkTarget(student)}><Sparkles size={13}/>{student.name} · মন্তব্য</button>)}</div><div className="flex items-end gap-2"><label><span className="label-base">প্রিন্টের শিক্ষার্থী</span><select className="input-base min-w-44" value={printTargetId || students[0]?.id || ''} onChange={(event) => setPrintTargetId(event.target.value)}>{students.map((student) => <option key={student.id} value={student.id}>{student.name} · রোল {student.roll}</option>)}</select></label><button type="button" className="btn-primary" onClick={() => window.print()} disabled={!printTarget}><Printer size={15}/> {activeTerm.name} প্রিন্ট</button></div></div>
    </Card>
    <div className="print-root">{printTarget && printResult && <TermMarksheetA4 student={printTarget} result={printResult} term={activeTerm} remark={getRemark(printTarget.id)} position={printPosition} schoolProfile={schoolProfile}/>}</div>
    {remarkTarget && <AIRemarkModal open onClose={() => setRemarkTarget(null)} student={remarkTarget} result={result} initialRemark={getRemark(remarkTarget.id)} onSave={(text) => setRemark(remarkTarget.id, text)}/>}
    <AutoPromotionModal
      open={promoting}
      onClose={() => setPromoting(false)}
      students={allStudents}
      defaultClassId={classId}
      getStudentResult={getStudentResult}
      getStudentClassRank={getStudentClassRank}
      getClassRankMap={getClassRankMap}
      getSectionsOfClass={getSectionsOfClass}
      onExecute={executePromotion}
    />
  </>;
}

