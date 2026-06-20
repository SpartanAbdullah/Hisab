// Natural-language parser for SPLIT/group expenses — "split 200 for dinner
// with the flat", "divide 1500 rent between us".
//
// Pure and total. It reuses the personal parser for amount/currency, then
// pulls out a group-name hint and a clean description. It does NOT resolve the
// group or members (that needs the live groups list) — the UI matches the hint
// to a real group and shows a confirm chip. Phase 1 is equal-split only; other
// split types stay in the full form.

import { parseExpenseInput, type ParseOptions } from './nlExpenseParser';

// A statement is a split intent if it uses an explicit split verb, names a
// "group", or says "between/among". Plain "lunch with team" is NOT a split —
// "with X" alone is too common in ordinary notes to trigger on.
const SPLIT_INTENT_RE = /\b(split|splitting|divide|dividing|group|between|among|amongst)\b/i;

export function isSplitIntent(text: string): boolean {
  return SPLIT_INTENT_RE.test(text ?? '');
}

// Words that mean "everyone here", not a named group — these yield a null hint
// so the UI falls back to the only/last group or asks which one.
const GENERIC_GROUP_WORDS = new Set([
  'us', 'everyone', 'everybody', 'friends', 'guys', 'them', 'all', 'people', 'flatmates', 'roommates',
]);

const DESC_STOP = new Set([
  'split', 'splitting', 'divide', 'dividing', 'share', 'sharing', 'group', 'between', 'among', 'amongst',
  'with', 'in', 'to', 'for', 'the', 'my', 'our', 'us', 'everyone', 'everybody', 'friends', 'guys',
  'them', 'all', 'people', 'flatmates', 'roommates', 'add', 'paid', 'pay', 'spent', 'spend', 'a', 'an', 'of', 'on', 'and', 'i', 'me',
  // currency words
  'aed', 'pkr', 'rs', 'dirham', 'dirhams', 'php', 'sar', 'riyal', 'usd', 'dollar',
  // roman-urdu fillers
  'ka', 'ke', 'ki', 'liye', 'mein',
]);

export interface ParsedGroupExpense {
  amount: number | null;
  currency: string | null;
  currencyAssumed: boolean;
  description: string; // Title Cased; falls back to "Group expense"
  splitType: 'equal';
  groupNameHint: string | null; // a guess at which group (UI fuzzy-matches it)
  canCreate: boolean; // amount > 0
  clarify: string | null;
  rawText: string;
}

function titleCase(s: string): string {
  return s
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

function extractGroupHint(lower: string): string | null {
  // "<name> group" wins — e.g. "the trip group" → "trip".
  const mGroup = /\b([a-z][a-z]*)\s+group\b/.exec(lower);
  if (mGroup && !GENERIC_GROUP_WORDS.has(mGroup[1])) return mGroup[1];

  // Otherwise the tail after the LAST with/in/to/for, minus a leading the/my.
  // The greedy "^.*" makes the matched preposition the last one, so
  // "for dinner with flat" yields "flat", not "dinner with flat".
  const mTail = /^.*\b(?:with|in|to|for)\s+(?:the\s+|my\s+)?([a-z][a-z ]*?)\s*$/.exec(lower);
  if (mTail) {
    const cand = mTail[1].trim().replace(/\s+group$/, '').trim();
    if (cand && !GENERIC_GROUP_WORDS.has(cand)) return cand;
  }
  return null;
}

export function parseGroupExpenseInput(text: string, opts: ParseOptions = {}): ParsedGroupExpense {
  const rawText = (text ?? '').trim();
  const base = parseExpenseInput(rawText, opts);
  const lower = rawText.toLowerCase();

  const groupNameHint = extractGroupHint(lower);
  const hintWords = new Set((groupNameHint ?? '').split(/\s+/).filter(Boolean));

  const descWords = lower
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w && !DESC_STOP.has(w) && !/\d/.test(w) && !hintWords.has(w));
  const description = titleCase(descWords.join(' ')) || 'Group expense';

  const amount = base.amount;
  const canCreate = amount !== null && amount > 0;
  const clarify = canCreate
    ? null
    : "How much to split? Try 'split 200 for dinner with flatmates'.";

  return {
    amount,
    currency: base.currency,
    currencyAssumed: base.currencyAssumed,
    description,
    splitType: 'equal',
    groupNameHint,
    canCreate,
    clarify,
    rawText,
  };
}
