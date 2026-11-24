/**
 * Remark generation service — গাঠনিক + সামষ্টিক aware.
 *
 * The product spec calls for a "Human-in-the-Loop AI Remark Generator": the teacher
 * receives a drafted Bangla remark, may cycle through several distinct drafts, edits
 * one, then saves it. This module produces deterministic, data-driven drafts locally.
 *
 * Why local by default?
 *  - Works fully offline (the platform is offline-first).
 *  - Never fails: if anything unexpected happens we return a safe Bangla fallback,
 *    so the marksheet can never render an empty remark block.
 *
 * Individualisation comes from three independent signals:
 *  1. the pupil's own গাঠনিক vs সামষ্টিক strength (see `buildComponentProfile`),
 *  2. the overall marks / GPA / grade / pass-fail tone,
 *  3. a stable per-pupil seed that ROTATES the phrase banks, so two pupils with the
 *     same performance never receive the same sentence order.
 *
 * To connect a real LLM later, implement `remoteRemarkProvider` and pass it in — the
 * contract is `async ({ student, result }) => string`.
 */

import { REMARK_BANK } from './demoSeedData.js';
import { toBanglaNumber, formatBanglaDecimal } from './banglaNumberFormatter.js';
import { RESULT_TERM_IDS } from './resultConfig.js';

export const DEFAULT_FALLBACK_REMARK =
  'শিক্ষার্থীর ফলাফল পর্যবেক্ষণ করা হয়েছে। নিয়মিত পড়াশোনা ও অভিভাবকের সহযোগিতা অব্যাহত রাখলে ভবিষ্যতে আরও ভালো ফলাফল অর্জন সম্ভব হবে।';

/* ------------------------------------------------------------------ *
 * Seeds & small helpers
 * ------------------------------------------------------------------ */

const seedFromString = (value) => {
  const text = String(value ?? '');
  let hash = 0;
  for (let index = 0; index < text.length; index += 1) {
    hash = (hash * 31 + text.charCodeAt(index)) % 100000;
  }
  return Math.abs(hash);
};

const pickBySeed = (list, seed) => {
  if (!Array.isArray(list) || list.length === 0) return DEFAULT_FALLBACK_REMARK;
  return list[Math.abs(Math.floor(seed)) % list.length] ?? DEFAULT_FALLBACK_REMARK;
};

/** Numeric mark or `null` (blank / junk = not entered). */
const numeric = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : null;
};

const round2 = (value) => Math.round((Number(value) + Number.EPSILON) * 100) / 100;

const sentence = (text) => {
  const clean = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!clean) return '';
  return /[।.!?]$/.test(clean) ? clean : `${clean}।`;
};


/* ------------------------------------------------------------------ *
 * Dual-component analysis (গাঠনিক মূল্যায়ন vs সামষ্টিক মূল্যায়ন)
 * ------------------------------------------------------------------ */

/**
 * Averages one pupil's গাঠনিক / সামষ্টিক marks per split subject across the given
 * terms, then classifies which evaluation component is the stronger one.
 *
 * @param {object} marks flat marks of ONE pupil: `{ [subjectId:component]: { [termId]: number } }`
 * @param {object} config the school's class configuration (subject split + full marks)
 * @param {string[]} [termIds] terms to consider (default: all three)
 * @returns {{
 *   hasSplit:boolean, formativePercent:(number|null), summativePercent:(number|null),
 *   stronger:('formative'|'summative'|'balanced'|'partial'),
 *   subjects:Array<object>,
 * }}
 */
export function buildComponentProfile(marks = {}, config = null, termIds = RESULT_TERM_IDS) {
  const subjects = Array.isArray(config?.subjects) ? config.subjects : [];
  const perSubject = [];
  let formativeSum = 0;
  let formativeCount = 0;
  let summativeSum = 0;
  let summativeCount = 0;
  const terms = Array.isArray(termIds) && termIds.length ? termIds : RESULT_TERM_IDS;
  const mean = (list) => (list.length ? round2(list.reduce((sum, item) => sum + item, 0) / list.length) : null);

  subjects.forEach((subject) => {
    if (!subject?.id || !subject.split) return;
    const formativeFull = Number(subject.formativeFull) || 0;
    const summativeFull = Number(subject.summativeFull) || 0;
    const formativeRow = marks?.[`${subject.id}:formative`] ?? {};
    const summativeRow = marks?.[`${subject.id}:summative`] ?? {};
    const formativeScores = [];
    const summativeScores = [];

    terms.forEach((termId) => {
      const formative = numeric(formativeRow?.[termId]);
      if (formative !== null && formativeFull > 0) formativeScores.push((formative / formativeFull) * 100);
      const summative = numeric(summativeRow?.[termId]);
      if (summative !== null && summativeFull > 0) summativeScores.push((summative / summativeFull) * 100);
    });

    const formativePercent = mean(formativeScores);
    const summativePercent = mean(summativeScores);
    if (formativePercent === null && summativePercent === null) return;

    if (formativePercent !== null) {
      formativeSum += formativePercent;
      formativeCount += 1;
    }
    if (summativePercent !== null) {
      summativeSum += summativePercent;
      summativeCount += 1;
    }
    perSubject.push({
      id: subject.id,
      name: subject.name,
      formativePercent,
      summativePercent,
      totalPercent: round2(((formativePercent ?? 0) + (summativePercent ?? 0)) / 2),
    });
  });

  const formativePercent = formativeCount ? round2(formativeSum / formativeCount) : null;
  const summativePercent = summativeCount ? round2(summativeSum / summativeCount) : null;
  let stronger = 'partial';
  if (formativePercent !== null && summativePercent !== null) {
    const gap = round2(formativePercent - summativePercent);
    stronger = Math.abs(gap) < 4 ? 'balanced' : (gap > 0 ? 'formative' : 'summative');
  } else if (formativePercent !== null) {
    stronger = 'formative';
  } else if (summativePercent !== null) {
    stronger = 'summative';
  }

  return {
    hasSplit: perSubject.length > 0,
    formativePercent,
    summativePercent,
    stronger,
    subjects: perSubject,
  };
}

/** Chooses the remark tone bucket from the computed result. */
export function classifyPerformance(result) {
  if (!result || !result.hasAnyMark) return 'none';
  if (result.failCount > 0) return 'weak';
  if (result.gpa === null || result.gpa === undefined) return 'none';
  if (result.gpa >= 4.5) return 'excellent';
  if (result.gpa >= 3.5) return 'good';
  if (result.gpa >= 2.5) return 'average';
  return 'weak';
}

/**
 * Same গাঠনিক / সামষ্টিক classification, but derived from an ALREADY COMPUTED result
 * object (a marksheet row) instead of raw stored marks.
 *
 * The marksheet has no access to the flat marks map, yet it still needs a sensible
 * remark when the teacher has not written one. Subject rows of a term result carry
 * `formative` / `summative`; consolidated rows carry the weighted `contributions`.
 *
 * @param {object} result computed result (`subjects[]` with component figures)
 * @returns {{hasSplit:boolean, formativePercent:(number|null), summativePercent:(number|null),
 *   stronger:('formative'|'summative'|'balanced'|'partial'), subjects:Array<object>}}
 */
export function buildComponentProfileFromResult(result) {
  const subjects = Array.isArray(result?.subjects) ? result.subjects : [];
  const perSubject = [];
  let formativeSum = 0;
  let formativeCount = 0;
  let summativeSum = 0;
  let summativeCount = 0;
  const mean = (list) => (list.length ? round2(list.reduce((sum, item) => sum + item, 0) / list.length) : null);

  subjects.forEach((subject) => {
    if (!subject?.split) return;
    const formativeFull = Number(subject.formativeFull) || 0;
    const summativeFull = Number(subject.summativeFull) || 0;
    // A term result stores the components directly.
    const rawFormative = numeric(subject.formative);
    const rawSummative = numeric(subject.summative);
    const formativeList = rawFormative !== null && formativeFull > 0
      ? [(rawFormative / formativeFull) * 100]
      : [];
    const summativeList = rawSummative !== null && summativeFull > 0
      ? [(rawSummative / summativeFull) * 100]
      : [];
    const formativePercent = mean(formativeList);
    const summativePercent = mean(summativeList);
    if (formativePercent === null && summativePercent === null) return;
    if (formativePercent !== null) {
      formativeSum += formativePercent;
      formativeCount += 1;
    }
    if (summativePercent !== null) {
      summativeSum += summativePercent;
      summativeCount += 1;
    }
    perSubject.push({
      id: subject.id,
      name: subject.name,
      formativePercent,
      summativePercent,
      totalPercent: round2(((formativePercent ?? 0) + (summativePercent ?? 0)) / 2),
    });
  });

  const formativePercent = formativeCount ? round2(formativeSum / formativeCount) : null;
  const summativePercent = summativeCount ? round2(summativeSum / summativeCount) : null;
  let stronger = 'partial';
  if (formativePercent !== null && summativePercent !== null) {
    const gap = round2(formativePercent - summativePercent);
    stronger = Math.abs(gap) < 4 ? 'balanced' : (gap > 0 ? 'formative' : 'summative');
  } else if (formativePercent !== null) {
    stronger = 'formative';
  } else if (summativePercent !== null) {
    stronger = 'summative';
  }

  return {
    hasSplit: perSubject.length > 0,
    formativePercent,
    summativePercent,
    stronger,
    subjects: perSubject,
  };
}

const toneToBankKey = {
  excellent: 'excellent',
  good: 'good',
  average: 'average',
  weak: 'weak',
  none: 'average',
};

/* ------------------------------------------------------------------ *
 * Phrase banks — every pool is independent, so the composed sentence is
 * different for every (pupil, variant) pair.
 * ------------------------------------------------------------------ */

const TONE_OPENERS = Object.freeze({
  excellent: [
    'চলতি মূল্যায়নে শিক্ষার্থীর ফলাফল অত্যন্ত প্রশংসনীয়',
    'শিক্ষার্থীর সামগ্রিক অর্জন এ শ্রেণির মধ্যে অন্যতম',
    'ধারাবাহিক পরিশ্রমের সুফল সুস্পষ্টভাবে প্রতীয়মান',
    'পাঠ্যবিষয়ে দক্ষতা ও আত্মবিশ্বাস দুটোই ঈর্ষণীয় পর্যায়ে',
  ],
  good: [
    'শিক্ষার্থীর ফলাফল সন্তোষজনক ও ক্রমশ উন্নতির পথে',
    'শিক্ষার্থী বেশিরভাগ বিষয়ে ভালো ধারাবাহিকতা রেখেছে, যা আশাব্যঞ্জক',
    'পাঠ্যবিষয়ে আগ্রহ ও শ্রেণিকাজে অংশগ্রহণ উৎসাহব্যঞ্জক',
    'শিক্ষার্থীর অর্জন নির্ধারিত লক্ষ্যের কাছাকাছি',
  ],
  average: [
    'শিক্ষার্থীর ফলাফল মোটামুটি, তবে আরও উন্নতির সুযোগ রয়েছে',
    'শিক্ষার্থী বিষয়ভিত্তিক প্রস্তুতিতে অসম মনোযোগ রেখেছে',
    'ফলাফলে নিয়মিত অনুশীলন ও পরিচ্ছন্ন প্রস্তুতির প্রয়োজনীয়তা বোঝা যায়',
    'শিক্ষার্থীর অর্জন সন্তোষজনক হলেও ধারাবাহিকতা বাড়ানো দরকার',
  ],
  weak: [
    'শিক্ষার্থীর ফলাফল প্রত্যাশার তুলনায় পিছিয়ে',
    'বেশ কয়েকটি বিষয়ে দুর্বলতা প্রকাশ পেয়েছে, যা অবহেলা করা যায় না',
    'মূল্যায়নের ফলাফল জানায় প্রস্তুতিতে আরও পরিশ্রম প্রয়োজন',
    'শিক্ষার্থীর উন্নতির যথেষ্ট সুযোগ রয়েছে',
  ],
  none: [
    'এখনো শিক্ষার্থীর কোনো নম্বর এন্ট্রি হয়নি',
    'শিক্ষার্থীর মূল্যায়ন সম্পূর্ণ হয়নি',
  ],
});

/** গাঠনিক vs সামষ্টিক clause — the heart of the individualisation. */
const COMPONENT_NOTES = Object.freeze({
  formative: [
    'গাঠনিক মূল্যায়নে অংশগ্রহণ ও শ্রেণিকাজ চমৎকার; সামষ্টিক মূল্যায়নেও একই ধারাবাহিকতা রাখলে ফলাফল আরও ঊর্ধ্বে যাবে',
    'শ্রেণিকাজ, উপস্থিতি ও মৌখিক অভিব্যক্তিতে যতটা আত্মবিশ্বাসী, সামষ্টিক পরীক্ষার লিখিত উত্তরে ততটা নয়',
    'গাঠনিক কার্যক্রমে শিক্ষার্থীর নিষ্ঠা প্রশংসনীয়, তাই সামষ্টিক পরীক্ষায় দুশ্চিন্তা কাটিয়ে বিস্তারিত উত্তর লেখার অভ্যাস গড়া দরকার',
  ],
  summative: [
    'সামষ্টিক পরীক্ষায় প্রস্তুতি শক্ত, তবে গাঠনিক মূল্যায়নের শ্রেণিকাজ ও উপস্থিতি নিয়মিত হলে ফলাফল আরও ভালো হবে',
    'লিখিত পরীক্ষায় ভালো করলেও গাঠনিক কাজে অংশগ্রহণ বাড়ানো প্রয়োজন',
    'সামষ্টিক পরীক্ষার নম্বর সন্তোষজনক; শ্রেণিকাজ ও দলগত কার্যক্রমে মনোযোগ দিলে মূল্যায়ন পুরোপুরি উজ্জ্বল হবে',
  ],
  balanced: [
    'গাঠনিক ও সামষ্টিক—দুই মূল্যায়নেই সমান ধারাবাহিকতা বজায় থেকেছে',
    'শ্রেণিকাজ ও পরীক্ষা উভয় ক্ষেত্রেই শিক্ষার্থীর প্রস্তুতি প্রায় সমতুল্য',
    'গাঠনিক ও সামষ্টিক নম্বরের সামঞ্জস্য প্রমাণ করে প্রস্তুতি পদ্ধতিগত',
  ],
  partial: [
    'গাঠনিক ও সামষ্টিক মূল্যায়নের মধ্যে একটি অংশ এখনো বাকি, পূর্ণ চিত্র পেতে উভয়ই পূরণ করুন',
    'এখন পর্যন্ত পাওয়া মূল্যায়নের ভিত্তিতে পর্যালোচনা করা হয়েছে; বাকি অংশ এন্ট্রি হলে মন্তব্য আরও স্পষ্ট হবে',
  ],
});

const SUBJECT_NOTES = Object.freeze({
  both: [
    (best, weakest) => `${best} বিষয়ে তার ফলাফল সবচেয়ে ভালো; ${weakest} বিষয়ে মনোযোগ দিলে সামগ্রিক ফলাফল উন্নত হবে।`,
    (best, weakest) => `${best} বিষয়ে অর্জন সর্বোচ্চ, অন্যদিকে ${weakest} বিষয়ে ঘাটতি পূরণ করা প্রয়োজন।`,
    (best, weakest) => `${best} বিষয়ে দক্ষতা বিশেষভাবে উল্লেখযোগ্য; ${weakest} বিষয়ে অতিরিক্ত অনুশীলন জরুরি।`,
  ],
  strong: [
    (best) => `${best} বিষয়ে দক্ষতা বিশেষভাবে উল্লেখযোগ্য।`,
    (best) => `${best} বিষয়ে তার সর্বোচ্চ নম্বর অর্জন উৎসাহ দেয়।`,
  ],
  weak: [
    (weakest) => `${weakest} বিষয়ে অতিরিক্ত অনুশীলন জরুরি।`,
    (weakest) => `${weakest} বিষয়ে দুর্বলতা কাটাতে প্রতিদিন কিছু সময় আলাদা রাখা দরকার।`,
  ],
});

const CLOSERS = Object.freeze({
  excellent: [
    'এই ধারা অব্যাহত রাখলে ভবিষ্যতে আরও বড় সাফল্য সম্ভব। অভিনন্দন ও শুভকামনা।',
    'শিক্ষক ও অভিভাবকের সহযোগিতা থাকলে সে আরও উচ্চতর লক্ষ্য অর্জন করবে।',
    'জ্ঞানচর্চায় এই প্রবল আগ্রহ ধরে রাখলে সাফল্য অনিবার্য।',
  ],
  good: [
    'পরীক্ষার প্রস্তুতিতে নিয়মিততা বজায় রাখলে গ্রেড আরও উন্নত হওয়ার সম্ভাবনা প্রবল।',
    'আরও অনুশীলন ও সময় ব্যবস্থাপনা যোগ হলে ফলাফল শীর্ষ পর্যায়ে যাবে।',
    'শ্রেণির নির্দেশনা অনুসরণ অব্যাহত রাখলে উন্নতি নিশ্চিত।',
  ],
  average: [
    'প্রতিদিন নির্দিষ্ট সময় পড়াশোনা ও অভিভাবকের নজরদারি অত্যন্ত জরুরি।',
    'শিক্ষকের পরামর্শ মেনে বাড়ির কাজ সম্পূর্ণ করার অভ্যাস গড়ে তুললে দ্রুত উন্নতি হবে।',
    'বিষয়ভিত্তিক দুর্বলতা চিহ্নিত করে ধাপে ধাপে অনুশীলন করলে ফলাফল ভালো হবে।',
  ],
  weak: [
    'নিয়মিত ক্লাসে উপস্থিতি, বাড়তি অনুশীলন ও অভিভাবকের তত্ত্বাবধানে ঘাটতি পূরণ করলে অগ্রগতি সম্ভব।',
    'প্রত্যেক বিষয়ে শিক্ষকের নির্দেশনা অনুযায়ী নিয়মিত অনুশীলন করা অত্যন্ত জরুরি।',
    'বিশেষ যত্নসহ পুনরায় অনুশীলনের মাধ্যমে উন্নতি করা সম্ভব; বিদ্যালয় সর্বাত্মক সহযোগিতা করবে।',
  ],
  none: [
    'নম্বর এন্ট্রি সম্পূর্ণ হলে পূর্ণাঙ্গ মন্তব্য যুক্ত করা যাবে।',
    'মূল্যায়ন শেষ হলে শিক্ষার্থীর ফলাফল পর্যালোচনা করে মন্তব্য প্রদান করা হবে।',
  ],
});

/* ------------------------------------------------------------------ *
 * Fact sentences & subject focus
 * ------------------------------------------------------------------ */

/** The measurable part of the remark (marks, GPA, component split, subject focus). */
function buildFacts({ result, profile, best, weakest, variantIndex }) {
  const parts = [];
  const detailed = variantIndex % 2 === 0;

  if (typeof result?.percentage === 'number' && Number(result.percentage) > 0) {
    parts.push(`সামগ্রিক স্কোর ${formatBanglaDecimal(result.percentage, 2)}%`);
  }
  if (result?.gpa !== null && result?.gpa !== undefined) {
    parts.push(`GPA ${formatBanglaDecimal(result.gpa, 2)}`);
  }
  if (result?.grade && result.grade !== '—') {
    parts.push(`গ্রেড ${result.grade}`);
  }
  if (detailed && result?.totalMarks !== null && result?.totalMarks !== undefined) {
    parts.push(`মোট ${toBanglaNumber(result.totalMarks)} নম্বর`);
  }
  // গাঠনিক / সামষ্টিক numbers — only shown for a split-evaluation class with real data.
  if (detailed && profile?.formativePercent !== null && profile?.formativePercent !== undefined) {
    parts.push(`গাঠনিক ${formatBanglaDecimal(profile.formativePercent, 1)}%`);
  }
  if (detailed && profile?.summativePercent !== null && profile?.summativePercent !== undefined) {
    parts.push(`সামষ্টিক ${formatBanglaDecimal(profile.summativePercent, 1)}%`);
  }
  if (result?.failCount > 0) {
    parts.push(`${toBanglaNumber(result.failCount)}টি বিষয়ে উন্নতি প্রয়োজন`);
  } else if (result?.passedSubjectCount > 0) {
    parts.push(`সকল ${toBanglaNumber(result.passedSubjectCount)}টি বিষয়ে উত্তীর্ণ`);
  }

  const factSentence = parts.length ? sentence(parts.join(', ')) : '';

  let subjectSentence = '';
  if (best && weakest) {
    const pool = SUBJECT_NOTES.both;
    subjectSentence = pool[variantIndex % pool.length](best.name, weakest.name);
  } else if (weakest) {
    const pool = SUBJECT_NOTES.weak;
    subjectSentence = pool[variantIndex % pool.length](weakest.name);
  } else if (best) {
    const pool = SUBJECT_NOTES.strong;
    subjectSentence = pool[variantIndex % pool.length](best.name);
  }

  return { factSentence, subjectSentence };
}

/** Highest / lowest scoring subject of a result (needs at least 2 scored subjects). */
function subjectExtremes(result) {
  const scored = (result?.subjects ?? []).filter((subject) => (
    subject?.hasAnyMark !== false
    && typeof (subject?.percent ?? subject?.scoredPercent ?? subject?.total) === 'number'
  ));
  if (!scored.length) return { best: null, weakest: null };
  const scoreOf = (subject) => Number(subject.percent ?? subject.scoredPercent ?? subject.total) || 0;
  const best = scored.reduce((left, right) => (scoreOf(right) > scoreOf(left) ? right : left));
  if (scored.length < 2) return { best, weakest: null };
  const weakest = scored.reduce((left, right) => (scoreOf(right) < scoreOf(left) ? right : left));
  // A near-identical score is not a "weakness" worth naming.
  if (best.id === weakest.id || Math.abs(scoreOf(best) - scoreOf(weakest)) < 6) return { best, weakest: null };
  return { best, weakest };
}
/**
 * Builds SEVERAL distinct, personalised Bangla remark drafts for one pupil.
 *
 * @param {{student?:object, result?:object, profile?:object}} payload
 *        `profile` is the output of `buildComponentProfile` (গাঠনিক / সামষ্টিক strength).
 * @param {{count?:number, variant?:number}} [options]
 *        `variant` rotates every phrase bank, so "আবার তৈরি করুন" can draft a
 *        genuinely NEW set of sentences for the same performance figures.
 * @returns {string[]} distinct drafts (never empty)
 */
export function generateRemarkOptions(payload = {}, options = {}) {
  const { student, result, profile } = payload;
  const count = Math.max(1, Math.min(12, Number(options.count) || 6));
  // A larger prime step keeps successive variants from re-using the same sentence.
  const variantShift = Math.max(0, Math.floor(Number(options.variant) || 0)) * 11;
  try {
    const tone = classifyPerformance(result);
    // The product's own tone bank is appended, so the wording stays familiar while the
    // local openers add far more variety than two fixed sentences per tone.
    const openers = [...(TONE_OPENERS[tone] ?? TONE_OPENERS.none), ...(REMARK_BANK[toneToBankKey[tone]] ?? [])];
    // Only claim a গাঠনিক/সামষ্টিক split when the class actually evaluates in two parts.
    const notes = profile?.hasSplit
      ? (COMPONENT_NOTES[profile?.stronger] ?? COMPONENT_NOTES.partial)
      : [];
    const closers = CLOSERS[tone] ?? CLOSERS.none;
    const { best, weakest } = subjectExtremes(result);
    // Per-pupil rotation: two pupils with identical results still read differently.
    const seed = seedFromString(`${student?.id ?? ''}|${student?.name ?? ''}|${tone}|${profile?.stronger ?? ''}`);

    const drafts = [];
    const seen = new Set();
    for (let index = 0; index < count * 5 && drafts.length < count; index += 1) {
      const shift = seed + variantShift + index;
      const opener = openers[shift % openers.length];
      const note = notes.length ? notes[(shift * 3 + 1) % notes.length] : '';
      const closer = closers[(shift * 2) % closers.length];
      const { factSentence, subjectSentence } = buildFacts({
        result,
        profile,
        best,
        weakest,
        variantIndex: drafts.length + index + Math.floor(variantShift / 11),
      });
      const text = [sentence(opener), sentence(note), factSentence, subjectSentence, sentence(closer)]
        .filter(Boolean)
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();
      if (!text || seen.has(text)) continue;
      seen.add(text);
      drafts.push(text);
    }

    if (!drafts.length) {
      return [sentence(pickBySeed(REMARK_BANK[toneToBankKey[tone]] ?? [], seed)) || DEFAULT_FALLBACK_REMARK];
    }
    return drafts;
  } catch {
    // Absolutely never throw: the marksheet must always be printable.
    return [DEFAULT_FALLBACK_REMARK];
  }
}

/**
 * Builds the single personalised Bangla remark draft (backwards-compatible helper).
 * @param {{student?: object, result?: object, profile?: object}} payload
 * @returns {string}
 */
export function generateRemarkDraft(payload = {}) {
  return generateRemarkOptions(payload, { count: 1 })[0] ?? DEFAULT_FALLBACK_REMARK;
}

/**
 * Async wrapper so a real AI provider can be swapped in without touching the UI.
 * @param {{student?: object, result?: object, profile?: object}} payload
 * @param {{provider?: Function, delay?: number}} [options]
 */
export async function generateRemark(payload, options = {}) {
  const { provider, delay = 250 } = options;
  try {
    if (typeof provider === 'function') {
      const remote = await provider(payload);
      if (typeof remote === 'string' && remote.trim().length > 0) return remote.trim();
    }
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, delay)));
    return generateRemarkDraft(payload);
  } catch {
    return DEFAULT_FALLBACK_REMARK;
  }
}

/**
 * Convenience for consumers that only hold a COMPUTED result (the marksheet):
 * derives the component profile from the result and drafts the personalised remark.
 *
 * @param {{student?:object, result?:object}} payload
 * @returns {string}
 */
export function generateRemarkForResult({ student, result } = {}) {
  return generateRemarkDraft({
    student,
    result,
    profile: buildComponentProfileFromResult(result),
  });
}

export default {
  generateRemark,
  generateRemarkDraft,
  generateRemarkOptions,
  generateRemarkForResult,
  buildComponentProfile,
  buildComponentProfileFromResult,
  classifyPerformance,
  DEFAULT_FALLBACK_REMARK,
};


