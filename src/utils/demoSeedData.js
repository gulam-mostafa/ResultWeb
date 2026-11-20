/**
 * Generic Bangla demo data for an unconfigured school workspace.
 *
 * The seed is generated deterministically (no Math.random) so that every reload
 * produces the same class rosters, marks and remarks — which keeps screenshots,
 * document previews and manual QA reproducible.
 */

import { CLASS_LEVELS, SUBJECTS, TERMS, DEMO_SESSION } from './constants.js';

const MALE_NAMES = [
  'মোঃ সাকিব হাসান', 'আব্দুল্লাহ আল মামুন', 'মোঃ রাকিবুল ইসলাম', 'তানভীর আহমেদ',
  'মোঃ ইমরান হোসেন', 'সাইফুল ইসলাম', 'মোঃ নাঈম হাসান', 'আরিফুল ইসলাম',
  'মোঃ ফাহিম ফয়সাল', 'শাহরিয়ার কবির', 'মোঃ আসিফ মাহমুদ', 'রেদোয়ান হাবিব',
  'মোঃ জুবায়ের হোসেন', 'সাদমান সাকিব', 'মোঃ হাসিবুল ইসলাম', 'তাসনিম রহমান',
];

const FEMALE_NAMES = [
  'মোছাঃ সুমাইয়া আক্তার', 'ফারহানা ইয়াসমিন', 'মোছাঃ নুসরাত জাহান', 'তাসনিয়া তাবাসসুম',
  'মোছাঃ রুমানা আক্তার', 'সাদিয়া ইসলাম', 'মোছাঃ জান্নাতুল ফেরদৌস', 'আফসানা মিমি',
  'মোছাঃ সাবরিনা হক', 'নাঈমা সুলতানা', 'মোছাঃ তানজিলা আক্তার', 'সুরাইয়া পারভীন',
  'মোছাঃ মেহজাবিন আক্তার', 'রাফিয়া ইসলাম', 'মোছাঃ সাদিয়া আফরিন', 'তাহমিনা আক্তার',
];

const FATHERS = [
  'মোঃ আব্দুল করিম', 'মোঃ শাহজাহান আলী', 'মোঃ রফিকুল ইসলাম', 'মোঃ হাবিবুর রহমান',
  'মোঃ আনোয়ার হোসেন', 'মোঃ জসিম উদ্দিন', 'মোঃ সেলিম মিয়া', 'মোঃ কামরুল হাসান',
  'মোঃ শফিকুল ইসলাম', 'মোঃ নজরুল ইসলাম', 'মোঃ মিজানুর রহমান', 'মোঃ ফরহাদ হোসেন',
];

const MOTHERS = [
  'মোছাঃ রহিমা বেগম', 'মোছাঃ ফাতেমা খাতুন', 'মোছাঃ আমেনা বেগম', 'মোছাঃ শাহানারা বেগম',
  'মোছাঃ নাসরিন আক্তার', 'মোছাঃ জাহানারা বেগম', 'মোছাঃ মমতাজ বেগম', 'মোছাঃ হাসিনা আক্তার',
  'মোছাঃ কুলসুম বেগম', 'মোছাঃ সুরাইয়া বেগম', 'মোছাঃ নূরজাহান বেগম', 'মোছাঃ আনোয়ারা বেগম',
];

const VILLAGES = ['পিরুজালী', 'আলিমপাড়া', 'মধ্যপাড়া', 'উত্তরপাড়া', 'চরপাড়া', 'নতুনপাড়া'];
const BLOOD = ['A+', 'B+', 'O+', 'AB+', 'A-', 'B-', 'O-'];
const RELIGIONS = ['ইসলাম', 'ইসলাম', 'ইসলাম', 'ইসলাম', 'হিন্দু', 'ইসলাম', 'বৌদ্ধ'];

/** Stable pseudo-random generator so demo data never shifts between reloads.
 *  mulberry32 is used because Park–Miller's early outputs are tiny for small
 *  seeds, which would bias every generated mark towards the bottom of the scale. */
function seededRandom(seed) {
  let state = (Number(seed) || 1) >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = (list, rand) => list[Math.floor(rand() * list.length) % list.length];

const padTwo = (value) => String(value).padStart(2, '0');

function makeBirthDate(index, classOrder) {
  const currentYear = 2026;
  const age = 5 + classOrder + (index % 2);
  const year = currentYear - age;
  const month = ((index * 3) % 12) + 1;
  const day = ((index * 7) % 26) + 1;
  return `${year}-${padTwo(month)}-${padTwo(day)}`;
}

/** Number of demo students per class – keeps every tab populated but light. */
const CLASS_ROSTER_SIZE = {
  pre: 8,
  c1: 10,
  c2: 10,
  c3: 10,
  c4: 10,
  c5: 9,
};

const ARCHIVE_ROSTER_SIZE = 6;

function buildStudent({ seed, classId, classOrder, index, status = 'active' }) {
  const rand = seededRandom(seed);
  const isFemale = index % 2 === 1;
  const name = isFemale ? FEMALE_NAMES[index % FEMALE_NAMES.length] : MALE_NAMES[index % MALE_NAMES.length];
  const village = VILLAGES[index % VILLAGES.length];
  const admissionYear = 2026 - classOrder;

  return {
    id: `stu-${classId}-${padTwo(index + 1)}`,
    name,
    classId,
    roll: index + 1,
    gender: isFemale ? 'female' : 'male',
    birthDate: makeBirthDate(index, classOrder),
    birthCertificateNo: `${1990000000000 + (seed % 8999999)}`,
    fatherName: pick(FATHERS, rand),
    motherName: pick(MOTHERS, rand),
    guardianPhone: `01${7 + (index % 3)}${String(10000000 + ((seed * 37) % 89999999)).slice(0, 8)}`,
    address: village,
    village,
    bloodGroup: pick(BLOOD, rand),
    religion: pick(RELIGIONS, rand),
    admissionDate: `${admissionYear}-01-${padTwo(2 + (index % 20))}`,
    session: DEMO_SESSION,
    status,
    isDemo: true,
  };
}

/** Builds the full roster for every class plus an archived (graduated) cohort. */
export function createDemoStudents() {
  const students = [];

  CLASS_LEVELS.forEach((level, classIndex) => {
    const size = CLASS_ROSTER_SIZE[level.id] ?? 8;
    for (let index = 0; index < size; index += 1) {
      students.push(
        buildStudent({
          seed: (classIndex + 1) * 1000 + index * 13 + 7,
          classId: level.id,
          classOrder: level.order,
          index,
        }),
      );
    }
  });

  // Graduated cohort – previous year's Class ৫ students now in the archive tab.
  for (let index = 0; index < ARCHIVE_ROSTER_SIZE; index += 1) {
    const student = buildStudent({
      seed: 9000 + index * 17,
      classId: 'archive',
      classOrder: 6,
      index,
      status: 'archived',
    });
    students.push({
      ...student,
      id: `stu-archive-${padTwo(index + 1)}`,
      graduatedYear: '২০২৫',
      previousClassId: 'c5',
    });
  }

  return students;
}

/**
 * Deterministic mark generator.
 * Each student gets a hidden "ability" value; class marks are spread around it so
 * the roster always shows a believable pass/fail mix and a stable merit order.
 */
export function createDemoMarks(students = []) {
  const entries = {};

  students.forEach((student, studentIndex) => {
    if (student.classId === 'archive') return;

    const seed = studentIndex * 137 + student.roll * 29 + 5;
    const rand = seededRandom(seed);

    // Ability 0.32 – 0.98, so roughly 1 in 8 students lands near/below pass mark.
    const ability = 0.32 + rand() * 0.66;

    const subjectMarks = {};
    SUBJECTS.forEach((subject, subjectIndex) => {
      // Small per-subject tilt keeps the chart from looking like a flat line.
      const tilt = (rand() - 0.5) * 0.18;
      const base = Math.min(0.99, Math.max(0.15, ability + tilt));

      const termMarks = {};
      TERMS.forEach((term, termIndex) => {
        const jitter = (rand() - 0.5) * 0.12;
        const ratio = Math.min(0.99, Math.max(0.08, base + jitter + termIndex * 0.015));
        termMarks[term.id] = Math.round(ratio * 100);
      });

      // Guarantee a couple of visible failures for the promotion-failure demo.
      if (studentIndex % 11 === 0 && subjectIndex === 2) {
        termMarks.term1 = 28;
        termMarks.term2 = 31;
        termMarks.annual = 35;
      }

      subjectMarks[subject.id] = termMarks;
    });

    entries[student.id] = subjectMarks;
  });

  return entries;
}

/* ------------------------------------------------------------------ *
 * AI remark corpus (used as the deterministic fallback + demo values)
 * ------------------------------------------------------------------ */
export const REMARK_BANK = Object.freeze({
  excellent: [
    'অসাধারণ ফলাফল করেছে। নিয়মিত পড়াশোনার এই ধারাবাহিকতা বজায় রাখলে ভবিষ্যতে আরও ভালো করবে। সহপাঠীদের জন্য অনুকরণীয়।',
    'প্রতিটি বিষয়ে চমৎকার দক্ষতা দেখিয়েছে। শিক্ষকের নির্দেশনা মেনে চলার মনোভাব প্রশংসনীয়। এভাবেই এগিয়ে যাক।',
  ],
  good: [
    'ফলাফল সন্তোষজনক ও উন্নতির ধারা স্পষ্ট। হাতের লেখা আরও সুন্দর করলে এবং নিয়মিত অনুশীলন করলে ফলাফল আরও ভালো হবে।',
    'পাঠ্যবিষয়ে আগ্রহ ভালো, তবে পরীক্ষার উত্তরে আরও বিস্তারিত লেখার অভ্যাস গড়ে তুলতে হবে। অভিনন্দন ও শুভকামনা।',
  ],
  average: [
    'ফলাফল মোটামুটি ভালো। গণিত ও ইংরেজিতে অতিরিক্ত অনুশীলন প্রয়োজন। প্রতিদিন নির্দিষ্ট সময় পড়াশোনা করলে দ্রুত উন্নতি সম্ভব।',
    'শৃঙ্খলাবোধ ভালো, তবে বিষয়ভিত্তিক প্রস্তুতিতে আরও মনোযোগ দিতে হবে। অভিভাবকের সহযোগিতা কামনা করছি।',
  ],
  weak: [
    'উন্নতির যথেষ্ট সুযোগ রয়েছে। নিয়মিত ক্লাসে উপস্থিতি ও বাড়িতে বাড়তি অনুশীলন অত্যন্ত জরুরি। আমরা পাশে আছি।',
    'কিছু বিষয়ে দুর্বলতা প্রকাশ পেয়েছে। শিক্ষকের পরামর্শ অনুযায়ী বাড়িতে অভিভাবকের তত্ত্বাবধানে অনুশীলন করলে ফলাফল উন্নত হবে।',
  ],
});

export default { createDemoStudents, createDemoMarks, REMARK_BANK };



