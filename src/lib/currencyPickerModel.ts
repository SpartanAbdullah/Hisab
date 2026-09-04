// Pure composition rules for <CurrencyPicker>.
//
// The picker itself is a React component (src/components/CurrencyPicker.tsx);
// everything here is the decision-making it does BEFORE it paints, kept pure
// and colocated-tested per the repo's testing philosophy (vitest.config.ts
// header): grouping the A–Z list, composing the inline chip row, and deciding
// which codes are currently writable.
//
// The catalogue itself (codes, names, symbols, search, ranking) lives in
// src/lib/currencies.ts and is owned elsewhere — this module only arranges
// what that module returns.

import type { CurrencyMeta } from './currencies';

/** How many currency chips the inline row shows before the "Other…" chip. */
export const CURRENCY_CHIP_LIMIT = 5;

export interface CurrencyChipRow {
  /** The codes to render as chips, in order. Never longer than `limit`. */
  codes: string[];
  /**
   * True when `value` was NOT among the ranked top codes and had to be
   * pinned into first position. Callers use it only for diagnostics/tests —
   * the pinned chip renders identically to any other.
   */
  valuePinned: boolean;
}

/**
 * The inline chip row.
 *
 * Founder rule (2026-09-04): show the top five currencies as chips, then an
 * "Other…" affordance. The one wrinkle is that the CURRENT value must always
 * be visible as a chip — a user whose account is in, say, JPY must see JPY
 * selected without opening the sheet, otherwise the row silently reads as
 * "nothing is selected" and an unwary tap changes their currency.
 *
 * So: if `value` is already inside the top `limit`, the row is just the top
 * `limit`. Otherwise `value` is pinned to the FRONT and the ranked list is
 * truncated by one to keep the row the same length (a row that grows to six
 * chips would reflow the grid under the user).
 *
 * `value` may be empty or unknown (a fresh form, or a code the catalogue does
 * not carry); it is simply not pinned in that case.
 */
export function currencyChipRow(input: {
  value: string;
  /** Ranked codes, most relevant first — i.e. `topCurrencies(...).map(c => c.code)`. */
  top: readonly string[];
  limit?: number;
}): CurrencyChipRow {
  const limit = Math.max(0, input.limit ?? CURRENCY_CHIP_LIMIT);
  const value = input.value?.trim() ?? '';

  // De-dupe defensively: topCurrencies merges "primary" + "used" + regional
  // defaults, and a code can legitimately arrive from more than one of them.
  const ranked: string[] = [];
  for (const code of input.top) {
    if (code && !ranked.includes(code)) ranked.push(code);
  }

  if (!value) return { codes: ranked.slice(0, limit), valuePinned: false };

  const head = ranked.slice(0, limit);
  if (head.includes(value)) return { codes: head, valuePinned: false };

  // Pin. limit - 1 leaves room for the pinned chip; at limit 0 the row is
  // empty and even the value is dropped, which is what a caller asking for
  // zero chips means.
  const rest = ranked.filter((c) => c !== value).slice(0, Math.max(0, limit - 1));
  return { codes: limit === 0 ? [] : [value, ...rest], valuePinned: true };
}

export interface CurrencyLetterGroup {
  /** Uppercase first character of every code in `items`. */
  letter: string;
  items: CurrencyMeta[];
}

/**
 * The empty-query sheet list: every currency, sorted A–Z by CODE, split into
 * one group per first letter so the sheet can render a sticky letter header.
 *
 * Sorted by code rather than by name because the header is a letter and the
 * bold thing on every row is the code — grouping by localized name would put
 * "AED" under "U" (UAE Dirham) in English and somewhere else again in roman
 * Urdu, so the same scroll position would mean different things per language.
 */
export function groupCurrenciesByLetter(list: readonly CurrencyMeta[]): CurrencyLetterGroup[] {
  const sorted = [...list].sort((a, b) => a.code.localeCompare(b.code, 'en'));
  const groups: CurrencyLetterGroup[] = [];
  for (const item of sorted) {
    const letter = (item.code[0] ?? '#').toUpperCase();
    const last = groups[groups.length - 1];
    if (last && last.letter === letter) last.items.push(item);
    else groups.push({ letter, items: [item] });
  }
  return groups;
}

/**
 * Whether a code can actually be written right now.
 *
 * `allowed` is the escape hatch for the window in which the client ships the
 * full ISO catalogue but the database still only accepts the eight legacy
 * codes: a caller passes the narrower list and every other code renders
 * disabled with a "coming soon" note, instead of being silently absent (which
 * would read as "Hisaab doesn't know my currency") or selectable-then-failing
 * at save time (which loses the entry).
 *
 * `undefined` — the default — means everything the catalogue carries is
 * allowed.
 */
export function isCurrencyAllowed(code: string, allowed?: readonly string[]): boolean {
  if (!allowed) return true;
  return allowed.includes(code);
}
