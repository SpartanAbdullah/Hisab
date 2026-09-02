import { beforeEach, describe, expect, it } from 'vitest';
import {
  QUOTE_ENABLED_KEY,
  QUOTE_SHOWN_KEY,
  dailyQuoteToday,
  disableDailyQuote,
  markDailyQuoteShown,
  shouldShowDailyQuote,
} from './dailyQuotePrefs';

// The lazy-mount gate in src/App.tsx calls shouldShowDailyQuote() BEFORE the
// DailyQuote chunk exists, so these three rules are the whole contract between
// the gate and the component.
describe('shouldShowDailyQuote', () => {
  beforeEach(() => {
    localStorage.removeItem(QUOTE_ENABLED_KEY);
    localStorage.removeItem(QUOTE_SHOWN_KEY);
  });

  it('shows by default (opt-out feature, nothing stored)', () => {
    expect(shouldShowDailyQuote()).toBe(true);
  });

  it('does not show once today has been marked', () => {
    const now = new Date('2026-04-15T09:00:00Z');
    markDailyQuoteShown(now);
    expect(localStorage.getItem(QUOTE_SHOWN_KEY)).toBe('2026-04-15');
    expect(shouldShowDailyQuote(now)).toBe(false);
  });

  it('shows again the next calendar day', () => {
    markDailyQuoteShown(new Date('2026-04-15T09:00:00Z'));
    expect(shouldShowDailyQuote(new Date('2026-04-16T00:05:00Z'))).toBe(true);
  });

  it('stays off once disabled, even on a fresh day', () => {
    disableDailyQuote();
    expect(shouldShowDailyQuote(new Date('2026-05-01T00:00:00Z'))).toBe(false);
  });

  it('treats any value other than the literal "false" as enabled', () => {
    localStorage.setItem(QUOTE_ENABLED_KEY, 'true');
    expect(shouldShowDailyQuote()).toBe(true);
    localStorage.setItem(QUOTE_ENABLED_KEY, '0');
    expect(shouldShowDailyQuote()).toBe(true);
  });

  it('buckets by LOCAL calendar day', () => {
    // vitest.setup.ts pins TZ=UTC, so local === UTC here; the assertion still
    // documents that the key is a calendar date, not an instant.
    expect(dailyQuoteToday(new Date('2026-04-15T23:59:59Z'))).toBe('2026-04-15');
  });
});
