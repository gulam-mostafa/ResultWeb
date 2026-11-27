/**
 * White-box render check: seed data for a REAL headless Chrome render of the app.
 *
 * Years are SAMPLE years on purpose (2029 past / 2030 active / 2031 future) so the
 * run can never be confused with live data. Every page load is served from the
 * LOCAL `resultweb:firebase-cache:*` tree built below — the same cache
 * `dbFallback.js` paints from — so nothing is read from or written to the live
 * database during this check.
 */
export const SAMPLE = Object.freeze({
  past: '2029',
  active: '2030',
  future: '2031',
  schoolId: 'render-check-school',
  divisionId: 'render',
  districtId: 'render',
  upazilaId: 'render',
});

const BASE = `divisions/${SAMPLE.divisionId}/districts/${SAMPLE.districtId}/upazilas/${SAMPLE.upazilaId}/schools/${SAMPLE.schoolId}`;

const CLASS_ROWS = [
  { app: 'pre', db: 'pre-primary', name: 'প্রাক-প্রাথমিক' },
  { app: 'c1', db: 'class-1', name: '১ম শ্রেণি' },
  { app: 'c2', db: 'class-2', name: '২য় শ্রেণি' },
  { app: 'c3', db: 'class-3', name: '৩য় শ্রেণি' },
  { app: 'c4', db: 'class-4', name: '৪র্থ শ্রেণি' },
  { app: 'c5', db: 'class-5', name: '৫ম শ্রেণি' },
];

/** Two pupils per class of one year (শাখা `ক`, rolls ১ and ২). */
function roster(year) {
  const students = [];
  const master = {};
  CLASS_ROWS.forEach((row) => {
    for (let index = 0; index < 2; index += 1) {
      const id = `R-${year}-${row.app}-${index + 1}`;
      const legacyId = `rl-${year}-${row.app}-${index + 1}`;
      const stamp = `${year}-01-0${index + 1}T00:00:00.000Z`;
      students.push({
        studentMasterId: id, legacyId, classId: row.db, section: 'ক',
        roll: index + 1, status: 'active', year, updatedAt: stamp,
      });
      master[id] = {
        studentMasterId: id, legacyId, name: `${row.name} শিক্ষার্থী ${index + 1}`,
        fatherName: 'পিতা', motherName: 'মাতা', gender: index ? 'female' : 'male',
        roll: index + 1, section: 'ক', currentClassId: row.db, academicYear: year,
        overallStatus: 'active', updatedAt: stamp,
      };
    }
  });
  return { students, master };
}

/** `{ 'class-1': { ক: { id: row } } }` — the canonical enrollment layout. */
function enrollmentNode(students) {
  const tree = {};
  students.forEach((student) => {
    tree[student.classId] = tree[student.classId] ?? {};
    tree[student.classId].ক = tree[student.classId].ক ?? {};
    tree[student.classId].ক[student.studentMasterId] = student;
  });
  return tree;
}

/**
 * The ACTIVE year's promotion log: `pre` was promoted, then unlocked by an admin
 * (so the UI has an audit row), then promoted again — which is exactly the state
 * that must keep showing "আনলক করেছেন: …" while the class is locked.
 */
function activePromotionLog(year, nextYear) {
  return {
    classes: {
      pre: {
        completedAt: `${year}-11-01T09:00:00.000Z`,
        completedBy: 'uid-teacher',
        completedByName: 'মোছাঃ সালমা আক্তার',
        completedByEmail: 'salma@example.com',
        fromYear: year,
        toYear: nextYear,
        promoted: 2,
        retained: 0,
        graduated: 0,
        moved: [`R-${year}-pre-1`, `R-${year}-pre-2`],
        graduatedIds: [],
        destinations: { [`R-${year}-pre-1`]: 'c1', [`R-${year}-pre-2`]: 'c1' },
        auto: false,
      },
    },
    unlocks: {
      pre: {
        u1: {
          at: `${year}-11-05T10:30:00.000Z`,
          uid: 'uid-admin',
          name: 'মোঃ গোলাম মোস্তফা',
          email: 'golam@example.com',
          by: 'school_admin',
          mode: 'unlock',
          message: 'শ্রেণি আনলক করা হয়েছে',
        },
      },
    },
    auto: null,
  };
}

/** A COMPLETE past year: all six classes promoted ⇒ the banner may say সম্পূর্ণ. */
function completePromotionLog(year, nextYear) {
  return {
    classes: Object.fromEntries(CLASS_ROWS.map((row) => [row.app, {
      completedAt: `${year}-11-20T09:00:00.000Z`,
      completedBy: 'uid-teacher',
      completedByName: 'মোছাঃ সালমা আক্তার',
      completedByEmail: 'salma@example.com',
      fromYear: year,
      toYear: nextYear,
      promoted: 2,
      retained: 0,
      graduated: row.app === 'c5' ? 2 : 0,
      moved: row.app === 'c5' ? [] : [`R-${year}-${row.app}-1`, `R-${year}-${row.app}-2`],
      graduatedIds: row.app === 'c5' ? [`R-${year}-c5-1`, `R-${year}-c5-2`] : [],
      destinations: {},
      auto: false,
    }])),
    unlocks: {},
    auto: { at: `${year}-12-01T00:00:00.000Z`, by: 'system' },
  };
}

/**
 * Builds every `localStorage` entry a full offline render needs: the
 * `schoolLocator` pointer, the school profile, the year partitions (roster,
 * results, meta, promotion log), `studentMaster`, the sessions index and the
 * signed-in approved school-admin session.
 *
 * @returns {Record<string, string>} `localStorage` key ➔ JSON string
 */
export function buildCacheEntries() {
  const entries = {};
  const put = (path, value) => {
    entries[`resultweb:firebase-cache:${path.replaceAll('/', ':')}`] = JSON.stringify(value);
  };

  put(`schoolLocator/${SAMPLE.schoolId}`, {
    schoolId: SAMPLE.schoolId,
    divisionId: SAMPLE.divisionId,
    districtId: SAMPLE.districtId,
    upazilaId: SAMPLE.upazilaId,
  });
  put(`${BASE}/profile`, {
    id: SAMPLE.schoolId,
    name: 'রেন্ডার যাচাই প্রাথমিক বিদ্যালয়',
    schoolName: 'রেন্ডার যাচাই প্রাথমিক বিদ্যালয়',
    emisCode: '999999',
    headTeacher: 'প্রধান শিক্ষক',
    divisionId: SAMPLE.divisionId,
    districtId: SAMPLE.districtId,
    upazilaId: SAMPLE.upazilaId,
    villageOrUnion: 'নমুনা গ্রাম',
    academicYear: SAMPLE.active,
    activeYear: SAMPLE.active,
  });
  put(`schoolData/${SAMPLE.schoolId}/sessionsIndex`, {
    [SAMPLE.past]: { year: SAMPLE.past, startedAt: `${SAMPLE.past}-01-01T00:00:00.000Z` },
    [SAMPLE.active]: { year: SAMPLE.active, startedAt: `${SAMPLE.active}-01-01T00:00:00.000Z` },
  });

  const activeRoster = roster(SAMPLE.active);
  put(`${BASE}/studentMaster`, activeRoster.master);
  [
    { year: SAMPLE.past, students: roster(SAMPLE.past).students },
    { year: SAMPLE.active, students: activeRoster.students },
    { year: SAMPLE.future, students: roster(SAMPLE.future).students },
  ].forEach(({ year, students }) => {
    put(`${BASE}/sessions/${year}/students`, enrollmentNode(students));
    put(`${BASE}/sessions/${year}/results`, {});
    put(`${BASE}/sessions/${year}/passedArchive`, {});
    put(`${BASE}/sessions/${year}/meta`, { year });
    put(`${BASE}/sessions/${year}/meta/resultConfig`, {});
  });
  put(`${BASE}/sessions/${SAMPLE.past}/meta/promotion`, completePromotionLog(SAMPLE.past, SAMPLE.active));
  put(`${BASE}/sessions/${SAMPLE.active}/meta/promotion`, activePromotionLog(SAMPLE.active, SAMPLE.future));
  put(`${BASE}/sessions/${SAMPLE.future}/meta/promotion`, {});

  // A signed-in, approved school admin of that tenant (the session shape of
  // `authService.createSession` + `AuthContext.stampSession`).
  const now = Date.now();
  entries['resultweb:auth:v2'] = JSON.stringify({
    user: {
      id: 'uid-render-admin',
      uid: 'uid-render-admin',
      role: 'school_admin',
      status: 'approved',
      isFounder: true,
      isAdmin: true,
      canApprove: true,
      name: 'মোছাঃ সালমা আক্তার',
      email: 'salma@example.com',
      designation: 'প্রধান শিক্ষক',
      avatarInitial: 'শ',
      schoolId: SAMPLE.schoolId,
      schoolName: 'রেন্ডার যাচাই প্রাথমিক বিদ্যালয়',
      divisionId: SAMPLE.divisionId,
      districtId: SAMPLE.districtId,
      upazilaId: SAMPLE.upazilaId,
    },
    issuedAt: now,
    expiresAt: now + 12 * 60 * 60 * 1000,
    school: {
      id: SAMPLE.schoolId,
      name: 'রেন্ডার যাচাই প্রাথমিক বিদ্যালয়',
      emisCode: '999999',
      divisionId: SAMPLE.divisionId,
      districtId: SAMPLE.districtId,
      upazilaId: SAMPLE.upazilaId,
      academicYear: SAMPLE.active,
    },
  });
  entries['resultweb:membership:v1'] = JSON.stringify({
    schoolId: SAMPLE.schoolId,
    uid: 'uid-render-admin',
    member: {
      uid: 'uid-render-admin',
      name: 'মোছাঃ সালমা আক্তার',
      email: 'salma@example.com',
      role: 'school_admin',
      status: 'approved',
      isFounder: true,
      isAdmin: true,
      canApprove: true,
    },
  });
  return entries;
}

/**
 * The in-memory database tree the render check runs against
 * (`scripts/browser/firebaseStub.mjs` serves exactly this shape).
 */
export function buildStore() {
  const profile = {
    id: SAMPLE.schoolId,
    name: 'রেন্ডার যাচাই প্রাথমিক বিদ্যালয়',
    emisCode: '999999',
    headTeacher: 'প্রধান শিক্ষক',
    divisionId: SAMPLE.divisionId,
    districtId: SAMPLE.districtId,
    upazilaId: SAMPLE.upazilaId,
    villageOrUnion: 'নমুনা গ্রাম',
    academicYear: SAMPLE.active,
    activeYear: SAMPLE.active,
  };
  const sessions = {
    [SAMPLE.past]: {
      students: enrollmentNode(roster(SAMPLE.past).students),
      results: {},
      passedArchive: {},
      meta: { year: SAMPLE.past, promotion: completePromotionLog(SAMPLE.past, SAMPLE.active) },
    },
    [SAMPLE.active]: {
      students: enrollmentNode(roster(SAMPLE.active).students),
      results: {},
      passedArchive: {},
      meta: { year: SAMPLE.active, promotion: activePromotionLog(SAMPLE.active, SAMPLE.future) },
    },
    [SAMPLE.future]: {
      students: enrollmentNode(roster(SAMPLE.future).students),
      results: {},
      passedArchive: {},
      meta: { year: SAMPLE.future },
    },
  };
  const school = {
    profile,
    studentMaster: roster(SAMPLE.active).master,
    sessions,
  };
  return JSON.parse(JSON.stringify({
    schoolLocator: {
      [SAMPLE.schoolId]: {
        schoolId: SAMPLE.schoolId,
        divisionId: SAMPLE.divisionId,
        districtId: SAMPLE.districtId,
        upazilaId: SAMPLE.upazilaId,
      },
    },
    // The legacy flat mirror real schools still carry (read-only fallback), so the
    // hierarchy resolves to the same tenant whichever path the app asks for.
    schoolData: {
      [SAMPLE.schoolId]: {
        profile,
        sessionsIndex: {
          [SAMPLE.past]: { year: SAMPLE.past, startedAt: `${SAMPLE.past}-01-01T00:00:00.000Z` },
          [SAMPLE.active]: { year: SAMPLE.active, startedAt: `${SAMPLE.active}-01-01T00:00:00.000Z` },
        },
        studentMaster: school.studentMaster,
        sessions,
      },
    },
    divisions: {
      [SAMPLE.divisionId]: {
        districts: {
          [SAMPLE.districtId]: {
            upazilas: {
              [SAMPLE.upazilaId]: {
                schools: { [SAMPLE.schoolId]: school },
              },
            },
          },
        },
      },
    },
  }));
}

export default { SAMPLE, buildCacheEntries, buildStore };
