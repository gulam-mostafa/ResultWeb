import { useCallback, useRef } from 'react';
import { TERMS } from '../utils/constants.js';
import { DEFAULT_ACTIVE_YEAR, isCompleteSchoolRef } from '../context/AuthContext.jsx';
import {
  computeConsolidatedResult,
  computeTermResultForConfig,
  rankClassRows,
  subjectTermEntry,
  toMark,
} from '../utils/resultEngine.js';
import { normalizeResultConfig, round2 } from '../utils/resultConfig.js';
import {
  createEmptyMarks,
  normalizeSessionYear,
  saveMark,
  saveStudentTermMarks,
  saveTermMarksBulk,
  saveRemark as saveRemarkCloud,
} from '../services/database/index.js';

/**
 * Marks, remarks and result selectors.
 *
 * Every calculation is driven by the ACTIVE SCHOOL's own class configuration
 * (`resultConfigs`, persisted under `sessions/{year}/meta/resultConfig`), so subjects,
 * full marks, the গাঠনিক/সামষ্টিক split, the pass mark and the annual weights are
 * always that school's — never a global default belonging to another tenant.
 *
 * Every mutation is mirrored to the database with a granular write (one cell or one
 * term), so two teachers editing different students never clobber each other.
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
  resultConfigs = {},
}) {
  // Marks/remarks are stored in `…/schools/{schoolId}/sessions/{year}/results/…`,
  // so both the tenant reference and the academic year are always explicit.
  // An incomplete reference disables cloud writes rather than falling back to the
  // legacy `schoolData/{schoolId}/results` node.
  const tenantRef = schoolRef ?? null;
  const canWriteCloud = Boolean(tenantRef && isCompleteSchoolRef(tenantRef));
  const year = normalizeSessionYear(activeYear, DEFAULT_ACTIVE_YEAR);

  /** The active school's configuration of one class (factory defaults when unset). */
  const getResultConfig = useCallback(
    (classId) => normalizeResultConfig(resultConfigs?.[classId] ?? null, classId || 'c3'),
    [resultConfigs],
  );

  /** Class id a pupil's result is calculated with (archive keeps the last class). */
  const classIdForStudent = useCallback(
    (studentId) => {
      const student = dataset.students.find((item) => item.id === studentId);
      return student?.classId && student.classId !== 'archive'
        ? student.classId
        : (student?.previousClassId || 'c3');
    },
    [dataset.students],
  );

  /** Class configuration of a pupil. */
  const configForStudent = useCallback(
    (studentId) => getResultConfig(classIdForStudent(studentId)),
    [classIdForStudent, getResultConfig],
  );

  /**
   * Annual CONSOLIDATED result (বার্ষিক ফলাফল) of one pupil — the weighted ৩ প্রান্তিক
   * figure the promotion flow and every printable document use.
   */
  const getStudentResult = useCallback(
    (studentId) => computeConsolidatedResult(
      dataset.marks?.[studentId] ?? {},
      configForStudent(studentId),
    ),
    [dataset.marks, configForStudent],
  );

  /** Term-scoped result (১ম/২য় প্রান্তিক/বার্ষিক মূল্যায়ন) with the class config. */
  const getTermResult = useCallback(
    (studentId, termId) => computeTermResultForConfig(
      dataset.marks?.[studentId] ?? {},
      configForStudent(studentId),
      termId,
    ),
    [dataset.marks, configForStudent],
  );

  const getRemark = useCallback(
    (studentId) => dataset.remarks?.[studentId] ?? '',
    [dataset.remarks],
  );

  /** Result of one pupil for one tab (`term1` | `term2` | `annual` | `consolidated`). */
  const getTabResult = useCallback(
    (studentId, tabId) => (
      tabId === 'consolidated'
        ? getStudentResult(studentId)
        : getTermResult(studentId, tabId)
    ),
    [getStudentResult, getTermResult],
  );

  /**
   * Merit-ranked rows of ONE class for one evaluation tab.
   * `newRoll` is generated only for the consolidated বার্ষিক ফলাফল — that is the
   * figure class promotion and roll regeneration are based on.
   */
  const getClassRows = useCallback(
    (classId, tabId = 'consolidated') => {
      const config = getResultConfig(classId);
      const students = getStudentsOfClass(classId);
      const rows = students.map((student) => {
        const studentMarks = dataset.marks?.[student.id] ?? {};
        const result = tabId === 'consolidated'
          ? computeConsolidatedResult(studentMarks, config)
          : computeTermResultForConfig(studentMarks, config, tabId);
        return { student, studentId: student.id, result };
      });
      return rankClassRows(rows, { assignNewRoll: tabId === 'consolidated' });
    },
    [dataset.marks, getResultConfig, getStudentsOfClass],
  );

  /** Class-level analytics: every pupil's consolidated result + merit ranking. */
  const getClassAnalytics = useCallback(
    (classId) => {
      const students = getStudentsOfClass(classId);
      const ranked = getClassRows(classId, 'consolidated').map((row) => ({
        student: row.student,
        studentId: row.studentId,
        name: row.student?.name ?? '',
        roll: row.student?.roll ?? 0,
        position: row.position,
        newRoll: row.newRoll,
        totalMarks: row.result.totalMarks,
        gpa: row.result.gpa,
        grade: row.result.grade,
        isPass: row.result.isPass,
        hasAnyMark: row.result.hasAnyMark,
        isGolden: row.result.isGolden,
        result: row.result,
      }));
      const appeared = ranked.filter((row) => row.hasAnyMark);
      const passed = appeared.filter((row) => row.isPass);
      return {
        classId,
        config: getResultConfig(classId),
        students,
        rows: ranked,
        appearedCount: appeared.length,
        passedCount: passed.length,
        failedCount: appeared.length - passed.length,
        passRate: appeared.length ? round2((passed.length / appeared.length) * 100) : 0,
        averageGpa: appeared.length
          ? round2(appeared.reduce((sum, row) => sum + (row.gpa ?? 0), 0) / appeared.length)
          : 0,
      };
    },
    [getClassRows, getResultConfig, getStudentsOfClass],
  );

  /**
   * Published merit position + consolidated result of every pupil in one class,
   * keyed by app student id. The promotion modal reads this ONCE per class (not per
   * pupil), so ranking a 300-pupil class stays linear.
   *
   * `dataset.marks` / `dataset.students` / `resultConfigs` are replaced immutably, so
   * reference equality is a sufficient cache key (no stale ranking).
   */
  const rankCache = useRef({ marks: null, students: null, configs: null, byClass: new Map() });
  const getClassRankMap = useCallback(
    (classId) => {
      const cache = rankCache.current;
      if (cache.marks !== dataset.marks || cache.students !== dataset.students || cache.configs !== resultConfigs) {
        rankCache.current = {
          marks: dataset.marks, students: dataset.students, configs: resultConfigs, byClass: new Map(),
        };
      }
      const store = rankCache.current.byClass;
      if (store.has(classId)) return store.get(classId);
      const byStudentId = new Map(getClassRows(classId, 'consolidated').map((row) => [row.studentId, row]));
      store.set(classId, byStudentId);
      return byStudentId;
    },
    [dataset.marks, dataset.students, resultConfigs, getClassRows],
  );

  const getStudentClassRank = useCallback(
    (studentId) => {
      const student = dataset.students.find((item) => item.id === studentId);
      if (!student) return { position: 0, total: 0, classSize: 0, hasAnyMark: false, result: {} };
      const byStudentId = getClassRankMap(student.classId);
      const row = byStudentId.get(studentId);
      return {
        position: row?.position ?? 0,
        total: row?.result?.totalMarks ?? 0,
        classSize: byStudentId.size,
        hasAnyMark: row?.result?.hasAnyMark === true,
        result: row?.result ?? {},
      };
    },
    [dataset.students, getClassRankMap],
  );

  /**
   * Store one entered field of one pupil.
   *
   * `fieldKey` is either a bare subject id (a single-score subject — the legacy shape)
   * or `subjectId:formative` / `subjectId:summative` for a split subject. The subject
   * TOTAL row (`marks[sid][subjectId][term]`) is kept in step as the sum of the two
   * components, so every existing reader (marksheets, promotion, exports) keeps
   * working unchanged.
   */
  const setMark = useCallback(
    (studentId, fieldKey, termId, rawValue) => {
      const key = String(fieldKey ?? '');
      if (!key) return;
      const [subjectId, component = 'total'] = key.split(':');
      if (!subjectId) return;
      if (!TERMS.some((term) => term.id === termId)) return;

      const value = rawValue === '' || rawValue === null || rawValue === undefined
        ? null
        : Math.max(0, Math.round(Number(rawValue) * 100) / 100);

      const student = datasetRef.current.students.find((item) => item.id === studentId);
      const classId = student?.classId && student.classId !== 'archive'
        ? student.classId
        : (student?.previousClassId || '');
      const config = normalizeResultConfig(resultConfigs?.[classId] ?? null, classId || 'c3');
      const subject = config.subjects.find((item) => item.id === subjectId) ?? null;
      const isComponent = component === 'formative' || component === 'summative';

      // One granular write per cell: concurrent teachers never clobber each other.
      if (canWriteCloud && canWriteTenant && student && student.classId !== 'archive') {
        runCloudSave(() => saveMark(
          tenantRef, termId, student.classId, studentId, subjectId, value, year,
          isComponent ? component : 'total',
        ));
      }

      updateDataset((prev) => {
        const existing = prev.marks[studentId] ?? createEmptyMarks();
        const nextSubject = { ...(existing[subjectId] ?? {}) };
        if (isComponent) {
          const fieldKeyName = `${subjectId}:${component}`;
          const fieldRow = { ...(existing[fieldKeyName] ?? {}) };
          fieldRow[termId] = value;
          const otherComponent = component === 'formative' ? 'summative' : 'formative';
          const otherRow = existing[`${subjectId}:${otherComponent}`] ?? {};
          const formative = component === 'formative' ? value : toMark(otherRow[termId]);
          const summative = component === 'summative' ? value : toMark(otherRow[termId]);
          // Both components blank ⇒ the subject is simply not entered for this term.
          nextSubject[termId] = formative === null && summative === null
            ? null
            : round2((formative ?? 0) + (summative ?? 0));
          return {
            ...prev,
            marks: {
              ...prev.marks,
              [studentId]: { ...existing, [subjectId]: nextSubject, [fieldKeyName]: fieldRow },
            },
          };
        }

        nextSubject[termId] = Number.isFinite(value) ? value : null;
        const nextMarks = { ...existing, [subjectId]: nextSubject };
        if (subject?.split) {
          // A single-score edit of a split subject clears the stale components, so the
          // entry can never be counted twice.
          [`${subjectId}:formative`, `${subjectId}:summative`].forEach((fieldKeyName) => {
            if (nextMarks[fieldKeyName]) {
              nextMarks[fieldKeyName] = { ...nextMarks[fieldKeyName], [termId]: null };
            }
          });
        }
        return { ...prev, marks: { ...prev.marks, [studentId]: nextMarks } };
      });
    },
    [updateDataset, canWriteCloud, tenantRef, year, canWriteTenant, runCloudSave, resultConfigs],
  );


  /**
   * Bulk write used by paste / upload flows.
   * `marksObject` is `{ [fieldKey]: { [termId]: number } }` — subject totals AND
   * component fields, so a whole term can be restored exactly as it was exported.
   */
  const setStudentMarks = useCallback(
    (studentId, marksObject) => {
      const next = { ...createEmptyMarks(), ...(marksObject ?? {}) };
      const student = datasetRef.current.students.find((item) => item.id === studentId);
      if (canWriteCloud && canWriteTenant && student && student.classId !== 'archive') {
        TERMS.forEach((term) => {
          const perSubject = {};
          Object.entries(next).forEach(([key, terms]) => {
            const [subjectId, component = 'total'] = String(key).split(':');
            const raw = terms?.[term.id];
            if (raw === undefined || raw === null || raw === '') return;
            perSubject[subjectId] = perSubject[subjectId] ?? {};
            perSubject[subjectId][component] = raw;
          });
          // A component pair collapses into the documented `{formative, summative}` row;
          // a bare total stays a total.
          const termSubjects = Object.entries(perSubject).reduce((acc, [subjectId, parts]) => {
            if (parts.formative !== undefined || parts.summative !== undefined) {
              acc[subjectId] = { formative: parts.formative ?? null, summative: parts.summative ?? null };
            } else if (parts.total !== undefined) {
              acc[subjectId] = parts.total;
            }
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

  /** Saves each field of a bulk payload through the single-cell writer. */
  const applyTermMarks = useCallback(
    (entries = {}) => {
      Object.entries(entries ?? {}).forEach(([studentId, fields]) => {
        Object.entries(fields ?? {}).forEach(([fieldKey, value]) => {
          if (value && typeof value === 'object' && value.termId) {
            setMark(studentId, fieldKey, value.termId, value.mark);
          }
        });
      });
    },
    [setMark],
  );

  /**
   * Excel import save — ONE multi-path database write for the whole class/term instead
   * of hundreds of single-cell writes, plus one local state pass.
   *
   * @param {object} entries `{ [studentId]: { [fieldKey]: {component, value} } }`
   * @param {{classId:string, termId:string, config:object}} meta
   */
  const applyImportedMarks = useCallback(
    async (entries = {}, meta = {}) => {
      const fieldEntries = entries ?? {};
      const studentIds = Object.keys(fieldEntries);
      if (!studentIds.length || !meta.classId || !meta.termId) return { synced: false };
      const config = normalizeResultConfig(
        meta.config ?? resultConfigs?.[meta.classId] ?? null,
        meta.classId,
      );

      // Local state first, so the grid recalculates immediately.
      updateDataset((prev) => {
        const nextMarks = { ...prev.marks };
        studentIds.forEach((studentId) => {
          const existing = { ...(nextMarks[studentId] ?? createEmptyMarks()) };
          Object.entries(fieldEntries[studentId] ?? {}).forEach(([fieldKey, payload]) => {
            const value = payload && typeof payload === 'object' ? payload.value : payload;
            const clean = value === '' || value === null || value === undefined ? null : Number(value);
            existing[fieldKey] = { ...(existing[fieldKey] ?? {}), [meta.termId]: clean };
          });
          config.subjects.forEach((subject) => {
            if (!subject.split) return;
            const formative = existing[`${subject.id}:formative`]?.[meta.termId] ?? null;
            const summative = existing[`${subject.id}:summative`]?.[meta.termId] ?? null;
            existing[subject.id] = {
              ...(existing[subject.id] ?? {}),
              [meta.termId]: formative === null && summative === null
                ? null
                : round2((formative ?? 0) + (summative ?? 0)),
            };
          });
          nextMarks[studentId] = existing;
        });
        return { ...prev, marks: nextMarks };
      });

      if (!canWriteCloud || !canWriteTenant) return { synced: false };
      return runCloudSave(
        () => saveTermMarksBulk(tenantRef, year, meta.classId, meta.termId, fieldEntries, config),
        { timeoutMs: 15000 },
      );
    },
    [updateDataset, canWriteCloud, canWriteTenant, tenantRef, year, runCloudSave, resultConfigs],
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

  /**
   * Effective subject entry of one pupil/term (the grid uses it for highlighting).
   * Returns `null` when the class configuration has no such subject.
   */
  const getSubjectEntry = useCallback(
    (studentId, subjectId, termId) => {
      const config = configForStudent(studentId);
      const subject = config.subjects.find((item) => item.id === subjectId);
      if (!subject) return null;
      return subjectTermEntry(subject, dataset.marks?.[studentId] ?? {}, termId, config.passMark);
    },
    [configForStudent, dataset.marks],
  );

  return {
    getResultConfig,
    getStudentResult,
    getTermResult,
    getTabResult,
    getRemark,
    getClassRows,
    getClassAnalytics,
    getStudentClassRank,
    getClassRankMap,
    getSubjectEntry,
    setMark,
    setStudentMarks,
    applyTermMarks,
    applyImportedMarks,
    setRemark,
  };
}

export default useResults;

