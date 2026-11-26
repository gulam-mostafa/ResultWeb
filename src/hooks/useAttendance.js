import { useEffect, useMemo, useRef, useState } from 'react';
import { subscribeAttendanceDay, saveAttendanceDay, normalizeSessionYear } from '../services/database/index.js';
import { buildSchoolRef, DEFAULT_ACTIVE_YEAR, isCompleteSchoolRef } from '../context/AuthContext.jsx';

const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

/**
 * Daily attendance for one class/day.
 *
 * Keeps a live subscription to `…/sessions/{year}/attendance/{date}` and layers
 * unsaved drafts on top of it. Drafts carry a revision counter so a save that
 * resolves after the user typed again never overwrites the newer value.
 */
export function useAttendance({ schoolId, schoolRef = null, activeYear = '', user, date, canWriteTenant }) {
  // Callers may still pass a bare id; the hierarchical reference is then rebuilt
  // from the signed-in user so writes always land in the year partition.
  const plainSchoolId = typeof schoolId === 'string' ? schoolId : (schoolId?.schoolId || '');
  const resolvedSchoolId = plainSchoolId || user?.schoolId || '';
  const tenantKey = schoolRef
    ? `${schoolRef.divisionId}/${schoolRef.districtId}/${schoolRef.upazilaId}/${schoolRef.schoolId}`
    : `id:${resolvedSchoolId}`;
  const year = normalizeSessionYear(activeYear, DEFAULT_ACTIVE_YEAR);
  // The reference must be referentially stable: a fresh object per render would
  // tear down and re-open the subscription on every keystroke.
  const tenantRef = useMemo(
    () => schoolRef || buildSchoolRef({ ...(user || {}), schoolId: resolvedSchoolId }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tenantKey, resolvedSchoolId, year],
  );
  // Incomplete reference ➔ no cloud write (never a legacy `schoolData/…/attendance`).
  const canWriteCloud = isCompleteSchoolRef(tenantRef);

  const [records, setRecords] = useState({});
  const [drafts, setDrafts] = useState({});
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState('');
  const dirtyIds = useRef(new Set());
  const draftRevision = useRef(new Map());
  const dateRef = useRef(date);
  dateRef.current = date;

  useEffect(() => {
    if (!resolvedSchoolId || !date) return undefined;
    dirtyIds.current.clear();
    setDrafts({});
    return subscribeAttendanceDay(tenantRef, date, (incoming) => {
      setRecords((previous) => ({
        ...incoming,
        ...Object.fromEntries(
          [...dirtyIds.current].filter((id) => id in previous).map((id) => [id, previous[id]]),
        ),
      }));
    }, undefined, year);
  }, [resolvedSchoolId, tenantRef, year, date]);

  const setStatus = (studentId, status) => {
    dirtyIds.current.add(studentId);
    draftRevision.current.set(studentId, (draftRevision.current.get(studentId) || 0) + 1);
    setDrafts((previous) => ({ ...previous, [studentId]: status }));
  };

  /** Effective status for a row: the pending draft wins over the saved record. */
  const statusOf = (studentId) =>
    hasOwn(drafts, studentId) ? drafts[studentId] : records[studentId]?.status || '';

  /** Saves the pending drafts; returns the cloud result so callers can toast it. */
  const save = async () => {
    if (!canWriteTenant || !canWriteCloud || !resolvedSchoolId || !Object.keys(drafts).length || saving) return { synced: false };
    setSaving(true);
    setNotice('');
    const changes = { ...drafts };
    const revisions = new Map(Object.keys(changes).map((id) => [id, draftRevision.current.get(id) || 0]));
    const savedDate = date;
    let result = { synced: false };
    try {
      result = await Promise.race([
        saveAttendanceDay(tenantRef, savedDate, changes, user, year),
        new Promise((resolve) => setTimeout(() => resolve({ synced: false, timedOut: true }), 3000)),
      ]);
      if (result.synced && dateRef.current === savedDate) {
        setRecords((previous) => {
          const next = { ...previous };
          Object.entries(changes).forEach(([id, status]) => {
            next[id] = { ...(next[id] || {}), status };
          });
          return next;
        });
        setDrafts((previous) => Object.fromEntries(Object.entries(previous).filter(([id, status]) => (
          changes[id] !== status || draftRevision.current.get(id) !== revisions.get(id)
        ))));
        Object.entries(changes).forEach(([id]) => {
          if (draftRevision.current.get(id) === revisions.get(id)) {
            dirtyIds.current.delete(id);
            draftRevision.current.delete(id);
          }
        });
        setNotice('উপস্থিতি সংরক্ষণ হয়েছে।');
      } else setNotice('উপস্থিতি সংরক্ষণ করা যায়নি; সংযোগ পরীক্ষা করে আবার চেষ্টা করুন।');
    } catch {
      result = { synced: false };
      setNotice('উপস্থিতি সংরক্ষণ করা যায়নি; সংযোগ পরীক্ষা করে আবার চেষ্টা করুন।');
    } finally {
      setSaving(false);
    }
    return result;
  };

  return {
    records,
    drafts,
    draftCount: Object.keys(drafts).length,
    setStatus,
    statusOf,
    save,
    saving,
    notice,
  };
}

export default useAttendance;
