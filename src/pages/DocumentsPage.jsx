import { useState } from 'react';
import { Printer } from 'lucide-react';
import { useSchoolData } from '../context/SchoolDataContext.jsx';
import { useAuth } from '../context/AuthContext.jsx';
import { CLASS_TABS } from '../utils/constants.js';
import { RESULT_TABS, tabById } from '../utils/resultConfig.js';
import { toBanglaNumber } from '../utils/banglaNumberFormatter.js';
import { Card } from '../components/ui/Primitives.jsx';
import MarksheetA4 from '../components/documents/MarksheetA4.jsx';
import TestimonialA4 from '../components/documents/TestimonialA4.jsx';
import TransferCertificateA4 from '../components/documents/TransferCertificateA4.jsx';
import CompletionCertificateA4 from '../components/documents/CompletionCertificateA4.jsx';

/**
 * ডিজিটাল ডকুমেন্ট — print-ready A4 marksheets and certificates.
 *
 * • The marksheet can be printed for ANY of the four evaluation views
 *   (১ম প্রান্তিক / ২য় প্রান্তিক / বার্ষিক মূল্যায়ন / বার্ষিক ফলাফল); the annual view
 *   prints the SAME weighted figures the screen shows.
 * • Eligibility: a marksheet needs an entered result for the chosen term, and printing
 *   is gated behind `canPrintDocuments`. An empty selection renders a `no-print` notice
 *   instead of a blank sheet.
 */
export default function DocumentsPage() {
  const { studentsByClass, getStudentResult, getTermResult, getRemark, schoolProfile } = useSchoolData();
  const { canPrintDocuments } = useAuth();
  const [classId, setClassId] = useState('c5');
  const [studentId, setStudentId] = useState('');
  const [type, setType] = useState('marksheet');
  /** Marksheet evaluation view (`consolidated` = বার্ষিক ফলাফল). */
  const [tabId, setTabId] = useState('consolidated');

  const students = studentsByClass[classId] ?? [];
  const student = students.find((item) => item.id === studentId) ?? students[0] ?? null;
  const isConsolidated = tabId === 'consolidated';
  const activeTab = tabById(tabId);
  const result = student
    ? (isConsolidated ? getStudentResult?.(student.id) : getTermResult?.(student.id, tabId))
    : null;
  const hasResult = result?.hasAnyMark === true;
  const remark = student ? getRemark?.(student.id, isConsolidated ? 'annual' : activeTab.termId) : '';
  const markBlocked = Boolean(student) && type === 'marksheet' && !hasResult;
  const eligible = Boolean(student) && canPrintDocuments && (type !== 'marksheet' || hasResult);

  return <>
    <div className="app-toolbar mb-4">
      <div className="mb-5">
        <h2 className="text-xl font-extrabold">ডিজিটাল ডকুমেন্ট</h2>
        <p className="text-xs text-slate-500">প্রিন্ট-প্রস্তুত A4 মার্কশিট ও সনদ</p>
      </div>
      <Card className="mb-4">
        <div className="grid gap-3 sm:grid-cols-5">
          <label>
            <span className="label-base">শ্রেণি</span>
            <select className="input-base" value={classId} onChange={(event) => { setClassId(event.target.value); setStudentId(''); }}>
              {CLASS_TABS.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select>
          </label>
          <label>
            <span className="label-base">শিক্ষার্থী / রোল</span>
            <select className="input-base" value={student?.id ?? ''} onChange={(event) => setStudentId(event.target.value)}>
              {students.map((item) => <option key={item.id} value={item.id}>{toBanglaNumber(item.roll)} · {item.name}</option>)}
            </select>
          </label>
          <label>
            <span className="label-base">ডকুমেন্ট</span>
            <select className="input-base" value={type} onChange={(event) => setType(event.target.value)}>
              <option value="marksheet">প্রফেশনাল মার্কশিট</option>
              <option value="testimonial">প্রত্যয়ন পত্র</option>
              <option value="tc">ছাড়পত্র (TC)</option>
              <option value="completion">প্রাথমিক শিক্ষা সমাপ্তি সনদ</option>
            </select>
          </label>
          <label>
            <span className="label-base">মার্কশিটের প্রান্তিক</span>
            <select className="input-base" value={tabId} onChange={(event) => setTabId(event.target.value)} disabled={type !== 'marksheet'}>
              {RESULT_TABS.map((tab) => <option key={tab.id} value={tab.id}>{tab.name}</option>)}
            </select>
          </label>
          <div className="flex items-end">
            <button className="btn-primary w-full" onClick={() => window.print()} disabled={!eligible}>
              <Printer size={15} /> প্রিন্ট / PDF
            </button>
          </div>
        </div>
        {!students.length ? (
          <p className="mt-3 rounded-lg bg-slate-50 p-2.5 text-[11px] font-semibold text-slate-600 dark:bg-slate-800 dark:text-slate-300">
            নির্বাচিত শ্রেণিতে কোনো শিক্ষার্থী নেই।
          </p>
        ) : markBlocked ? (
          <p role="status" className="mt-3 rounded-lg bg-amber-50 p-2.5 text-[11px] font-semibold text-amber-900 dark:bg-amber-900/30 dark:text-amber-100">
            এই শিক্ষার্থীর <b>{activeTab.name}</b>-এ কোনো নম্বর এন্ট্রি হয়নি — মার্কশিট প্রিন্ট করা যাবে না। অন্য প্রান্তিক বেছে নিন বা আগে নম্বর দিন।
          </p>
        ) : !canPrintDocuments ? (
          <p role="status" className="mt-3 rounded-lg bg-amber-50 p-2.5 text-[11px] font-semibold text-amber-900 dark:bg-amber-900/30 dark:text-amber-100">
            ডকুমেন্ট প্রিন্ট করার অনুমতি নেই — অনুমোদিত শিক্ষকের সঙ্গে যোগাযোগ করুন।
          </p>
        ) : null}
      </Card>
    </div>

    <div className="print-root print-stage">
      {!students.length || !student ? (
        <Card className="no-print"><p className="p-8 text-center">নির্বাচিত শ্রেণিতে শিক্ষার্থী নেই।</p></Card>
      ) : type === 'marksheet' ? (
        hasResult
          ? <MarksheetA4 student={student} result={result} remark={remark} schoolProfile={schoolProfile} tabName={activeTab.name} />
          : <Card className="no-print"><p className="p-8 text-center">এই প্রান্তিকে কোনো ফলাফল নেই।</p></Card>
      ) : type === 'testimonial' ? (
        <TestimonialA4 student={student} schoolProfile={schoolProfile} />
      ) : type === 'tc' ? (
        <TransferCertificateA4 student={student} schoolProfile={schoolProfile} />
      ) : (
        <CompletionCertificateA4 student={student} schoolProfile={schoolProfile} />
      )}
    </div>
  </>;
}

