import { useCallback, useRef } from 'react';
import { SUBJECT_IDS, TERMS } from '../utils/constants.js';
import { DEFAULT_ACTIVE_YEAR, isCompleteSchoolRef } from '../context/AuthContext.jsx';
import {
  computeStudentResult,
  computeTermResult,
  computeMeritRanking,
  round,
} from '../utils/gradingCalculator.js';
import {
  createEmptyMarks,
  normalizeSessionYear,
  saveMark,
  saveStudentTermMarks,
  saveRemark as saveRemarkCloud,
} from '../services/database/index.js';

/**
 * Marks, remarks and result selectors.
 *
 * Every mutation is mirrored to Firestore with a granular write (one cell or
 * one term), so two teachers editing different students never clobber each
 * other. Selectors stay pure and memoised on `dataset.marks` / `dataset.remarks`.
 */
export function useResults({
  dataset,
  datasetRef,
  updateDataset,
  schoolId,
  schoolRef = null,
  activeYear = '',
  canWriteTenant,
  runCloudSave,
  getStudentsOfClass,
}) {
  // Marks/remarks are stored in `…/schools/{schoolId}/sessions/{year}/results/…`,
  // so both the tenant reference and the academic year are always explicit.
  // An incomplete reference disables cloud writes rather than falling back to the
  // legacy `schoolData/{schoolId}/results` node.
  const tenantRef = schoolRef ?? null;
  const canWriteCloud = Boolean(tenantRef && isCompleteSchoolRef(tenantRef));
  const year = normalizeSessionYear(activeYear, DEFAULT_ACTIVE_YEAR);

  const getStudentResult = useCallback(
    (studentId) => computeStudentResult(dataset.marks?.[studentId] ?? {}),
    [dataset.marks],
  );

  /** Term-scoped result (১ম/২য় প্রান্তিক) – raw marks, term-only merit list. */
  const getTermResult = useCallback(
    (studentId, termId) => computeTermResult(dataset.marks?.[studentId] ?? {}, termId),
    [dataset.marks],
  );

  const getRemark = useCallback(
    (studentId) => dataset.remarks?.[studentId] ?? '',
    [dataset.remarks],
  );

  /** Class-level analytics: every student's result + merit ranking. */
  const getClassAnalytics = useCallback(
    (classId) => {
      const students = getStudentsOfClass(classId);
      const rows = students.map((student) => {
        const result = computeStudentResult(dataset.marks?.[student.id] ?? {});
        return {
          student,
          studentId: student.id,
          name: student.name,
          roll: student.roll,
          totalMarks: result.totalMarks,
          gpa: result.gpa,
          grade: result.grade,
          isPass: result.isPass,
          hasAnyMark: result.hasAnyMark,
          result,
        };
      });

      const ranked = computeMeritRanking(rows);
      const appeared = rows.filter((row) => row.hasAnyMark);
      const passed = appeared.filter((row) => row.isPass);

      return {
        classId,
        students,
        rows: ranked,
        appearedCount: appeared.length,
        passedCount: passed.length,
        failedCount: appeared.length - passed.length,
        passRate: appeared.length ? round((passed.length / appeared.length) * 100, 1) : 0,
        averageGpa: appeared.length
          ? round(appeared.reduce((sum, row) => sum + (row.gpa ?? 0), 0) / appeared.length, 2)
          : 0,
      };
    },
    [dataset.marks, getStudentsOfClass],
  );

  /**
   * Published merit position + result data of every pupil in one class, keyed by
   * app student id. The promotion modal reads this ONCE per class (not per pupil),
   * so ranking a 300-pupil class stays linear.
   *
   * `dataset.marks` / `dataset.students` are replaced immutably by every reducer, so
   * reference equality is a sufficient cache key (no stale ranking).
   */
  const rankCache = useRef({ marks: null, students: null, byClass: new Map() });
  const getClassRankMap = useCallback(
    (classId) => {
      const cache = rankCache.current;
      if (cache.marks !== dataset.marks || cache.students !== dataset.students) {
        rankCache.current = { marks: dataset.marks, students: dataset.students, byClass: new Map() };
      }
      const store = rankCache.current.byClass;
      if (store.has(classId)) return store.get(classId);
      const rows = dataset.students
        .filter((student) => student.classId === classId)
        .map((student) => {
          const result = computeStudentResult(dataset.marks?.[student.id] ?? {});
          return {
            student,
            studentId: student.id,
            totalMarks: result.totalMarks,
            gpa: result.gpa,
            grade: result.grade,
            isPass: result.isPass,
            hasAnyMark: result.hasAnyMark,
            result,
          };
        });
      const ranked = computeMeritRanking(rows);
      const byStudentId = new Map(ranked.map((row) => [row.studentId, row]));
      store.set(classId, byStudentId);
      return byStudentId;
    },
    [dataset.students, dataset.marks],
  );

  const getStudentClassRank = useCallback(
    (studentId) => {
      const student = dataset.students.find((item) => item.id === studentId);
      if (!student) return { position: 0, total: 0, classSize: 0, hasAnyMark: false, result: {} };
      const byStudentId = getClassRankMap(student.classId);
      const row = byStudentId.get(studentId);
      return {
        position: row?.position ?? 0,
        total: row?.totalMarks ?? 0,
        classSize: byStudentId.size,
        hasAnyMark: row?.hasAnyMark === true,
        result: row?.result ?? {},
      };
    },
    [dataset.students, getClassRankMap],
  );

  const setMark = useCallback(
    (studentId, subjectId, termId, rawValue) => {
      if (!SUBJECT_IDS.includes(subjectId)) return;
      if (!TERMS.some((term) => term.id === termId)) return;

      const value =
        rawValue === '' || rawValue === null || rawValue === undefined
          ? null
          : Math.max(0, Math.min(100, Math.round(Number(rawValue) * 100) / 100));

      const student = datasetRef.current.students.find((item) => item.id === studentId);
      // One granular write per cell: concurrent teachers never clobber each other.
      if (canWriteCloud && canWriteTenant && student && student.classId !== 'archive') {
        runCloudSave(() => saveMark(tenantRef, termId, student.classId, studentId, subjectId, value, year));
      }
      updateDataset((prev) => {
        const existing = prev.marks[studentId] ?? createEmptyMarks();
        const subjectMarks = { ...(existing[subjectId] ?? {}) };
        subjectMarks[termId] = Number.isFinite(value) ? value : null;
        return {
          ...prev,
          marks: {
            ...prev.marks,
            [studentId]: { ...existing, [subjectId]: subjectMarks },
          },
        };
      });
    },
    [updateDataset, canWriteCloud, tenantRef, year, canWriteTenant, runCloudSave],
  );

  /** Bulk write used by paste/import flows — mirrors one merge write per term. */
  const setStudentMarks = useCallback(
    (studentId, marksObject) => {
      const next = { ...createEmptyMarks(), ...(marksObject ?? {}) };
      const student = datasetRef.current.students.find((item) => item.id === studentId);
      if (canWriteCloud && canWriteTenant && student && student.classId !== 'archive') {
        TERMS.forEach((term) => {
          const termSubjects = SUBJECT_IDS.reduce((acc, subjectId) => {
            const raw = next?.[subjectId]?.[term.id];
            if (raw === undefined) return acc;
            acc[subjectId] = raw === '' || raw === null ? null : raw;
            return acc;
          }, {});
          if (Object.keys(termSubjects).length === 0) return;
          runCloudSave(() => saveStudentTermMarks(tenantRef, term.id, student.classId, studentId, termSubjects, year));
        });
      }
      updateDataset((prev) => ({
        ...prev,
        marks: { ...prev.marks, [studentId]: next },
      }));
    },
    [updateDataset, canWriteCloud, tenantRef, year, canWriteTenant, runCloudSave],
  );

  const setRemark = useCallback(
    (studentId, remark) => {
      const text = String(remark ?? '');
      const student = datasetRef.current.students.find((item) => item.id === studentId);
      if (canWriteCloud && canWriteTenant && student && student.classId !== 'archive') {
        runCloudSave(() => saveRemarkCloud(tenantRef, 'annual', student.classId, studentId, text, year));
      }
      updateDataset(
        (prev) => ({
          ...prev,
          remarks: { ...prev.remarks, [studentId]: text },
        }),
        { action: 'remark.save', detail: 'শিক্ষকের মন্তব্য সংরক্ষণ হয়েছে', actor: 'school_admin' },
      );
    },
    [updateDataset, canWriteCloud, tenantRef, year, canWriteTenant, runCloudSave],
  );

  return {
    getStudentResult,
    getTermResult,
    getRemark,
    getClassAnalytics,
    getStudentClassRank,
    getClassRankMap,
    setMark,
    setStudentMarks,
    setRemark,
  };
}

export default useResults;
