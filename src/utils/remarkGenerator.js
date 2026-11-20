/**
 * Remark generation service.
 *
 * The product spec calls for a "Human-in-the-Loop AI Remark Generator": the teacher
 * receives an AI-drafted Bangla remark, edits it, then saves. This module produces a
 * deterministic, data-driven draft locally.
 *
 * Why local by default?
 *  - Works fully offline (the platform is offline-first).
 *  - Never fails: if anything unexpected happens we return a safe Bangla fallback,
 *    so the marksheet can never render an empty remark block.
 *
 * To connect a real LLM later, implement `remoteRemarkProvider` and pass it in —
 * the contract is `async ({ student, result }) => string`.
 */

import { REMARK_BANK } from './demoSeedData.js';
import { toBanglaNumber, formatBanglaDecimal } from './banglaNumberFormatter.js';

export const DEFAULT_FALLBACK_REMARK =
  'শিক্ষার্থীর ফলাফল পর্যবেক্ষণ করা হয়েছে। নিয়মিত পড়াশোনা ও অভিভাবকের সহযোগিতা অব্যাহত রাখলে ভবিষ্যতে আরও ভালো ফলাফল অর্জন সম্ভব হবে।';

const pickBySeed = (list, seed) => {
  if (!Array.isArray(list) || list.length === 0) return DEFAULT_FALLBACK_REMARK;
  const index = Math.abs(Math.floor(seed)) % list.length;
  return list[index] ?? DEFAULT_FALLBACK_REMARK;
};

const seedFromString = (value) => {
  const text = String(value ?? '');
  let hash = 0;
  for (let index = 0; index < text.length; index += 1) {
    hash = (hash * 31 + text.charCodeAt(index)) % 100000;
  }
  return hash;
};

/** Chooses the remark tone bucket from the computed result. */
export function classifyPerformance(result) {
  if (!result || !result.hasAnyMark) return 'none';
  if (result.failCount > 0) return 'weak';
  if (result.gpa === null) return 'none';
  if (result.gpa >= 4.5) return 'excellent';
  if (result.gpa >= 3.5) return 'good';
  if (result.gpa >= 2.5) return 'average';
  return 'weak';
}

const toneToBankKey = {
  excellent: 'excellent',
  good: 'good',
  average: 'average',
  weak: 'weak',
  none: 'average',
};

/**
 * Builds a personalised Bangla remark draft.
 * @param {{student?: object, result?: object}} payload
 * @returns {string}
 */
export function generateRemarkDraft({ student, result } = {}) {
  try {
    const tone = classifyPerformance(result);
    const bank = REMARK_BANK[toneToBankKey[tone]] ?? REMARK_BANK.average;
    const seed = seedFromString(`${student?.id ?? ''}-${student?.name ?? ''}-${tone}`);
    const base = pickBySeed(bank, seed);

    if (!result?.hasAnyMark) {
      return `${base}${DEFAULT_FALLBACK_REMARK}`;
    }

    const facts = [];
    if (typeof result.percentage === 'number') {
      facts.push(`সামগ্রিক স্কোর ${formatBanglaDecimal(result.percentage, 2)}%`);
    }
    if (result.gpa !== null) {
      facts.push(`জিপিএ ${formatBanglaDecimal(result.gpa, 2)}`);
    }
    if (result.failCount > 0) {
      facts.push(`${toBanglaNumber(result.failCount)}টি বিষয়ে উন্নতি প্রয়োজন`);
    } else if (result.passedSubjectCount > 0) {
      facts.push(`সকল ${toBanglaNumber(result.passedSubjectCount)}টি বিষয়ে উত্তীর্ণ`);
    }

    const factSentence = facts.length ? `${facts.join(', ')}। ` : '';

    // Highlight the strongest and weakest subject for a genuinely personalised note.
    const scored = (result.subjects ?? []).filter((subject) => typeof subject.total === 'number');
    let focusSentence = '';
    if (scored.length > 1) {
      const best = scored.reduce((a, b) => (b.total > a.total ? b : a));
      const weakest = scored.reduce((a, b) => (b.total < a.total ? b : a));
      if (best.id !== weakest.id) {
        focusSentence = `${best.name} বিষয়ে সবচেয়ে ভালো করেছে; ${weakest.name} বিষয়ে আরও মনোযোগ দিতে হবে। `;
      }
    }

    return `${base} ${factSentence}${focusSentence}`.replace(/\s+/g, ' ').trim();
  } catch {
    // Absolutely never throw: the marksheet must always be printable.
    return DEFAULT_FALLBACK_REMARK;
  }
}

/**
 * Async wrapper so a real AI provider can be swapped in without touching the UI.
 * @param {{student?: object, result?: object}} payload
 * @param {{provider?: Function, delay?: number}} [options]
 */
export async function generateRemark(payload, options = {}) {
  const { provider, delay = 650 } = options;
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

export default { generateRemark, generateRemarkDraft, classifyPerformance, DEFAULT_FALLBACK_REMARK };
