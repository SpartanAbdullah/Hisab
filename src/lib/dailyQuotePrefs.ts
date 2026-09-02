// Daily-wisdom popup preferences + the "should it show today?" trigger.
//
// Extracted from src/components/DailyQuote.tsx (audit 03-performance H1 / P2
// M2c). The component is now lazy-mounted from src/App.tsx, so the DECISION to
// show it has to be answerable WITHOUT importing the component — otherwise the
// gate pulls the very chunk it is supposed to defer (financeQuotes, the
// WhatsApp share helper, the modal markup) back into the entry graph.
//
// Everything here is pure + storage-only, so it stays unit-testable in Node
// (vitest runs with the MemoryStorage polyfill from vitest.setup.ts).

import { localIso } from './localDate';

export const QUOTE_SHOWN_KEY = 'hisaab_quote_last_shown';
export const QUOTE_ENABLED_KEY = 'hisaab_daily_quote_enabled';

/** Local calendar day, not UTC — this app's markets are UTC+4/+5. */
export function dailyQuoteToday(now: Date = new Date()): string {
  return localIso(now);
}

/**
 * True when the once-a-day popup is due: the feature is on (opt-OUT, so only
 * the literal string 'false' disables it) and it has not already been shown on
 * today's local calendar day.
 *
 * A throwing/absent localStorage (private mode, storage disabled) resolves to
 * "show" — same as the pre-extraction behaviour, where the two getItem calls
 * would have thrown out of the effect.
 */
export function shouldShowDailyQuote(now: Date = new Date()): boolean {
  try {
    if (localStorage.getItem(QUOTE_ENABLED_KEY) === 'false') return false;
    if (localStorage.getItem(QUOTE_SHOWN_KEY) === dailyQuoteToday(now)) return false;
  } catch {
    // Storage unavailable — show anyway, exactly as before.
    return true;
  }
  return true;
}

/** Record that today's quote has been seen. Never throws. */
export function markDailyQuoteShown(now: Date = new Date()): void {
  try {
    localStorage.setItem(QUOTE_SHOWN_KEY, dailyQuoteToday(now));
  } catch {
    /* storage off — the quote may reappear next open. Harmless. */
  }
}

/** The in-modal "don't show these again" switch (mirrored in Settings). */
export function disableDailyQuote(): void {
  try {
    localStorage.setItem(QUOTE_ENABLED_KEY, 'false');
  } catch {
    /* ignore */
  }
}
