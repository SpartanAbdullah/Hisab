import { describe, expect, it } from 'vitest';
import {
  HISTORY_MIN_ROWS,
  HISTORY_WINDOW_MONTHS,
  coverageSatisfies,
  earliestIso,
  emptyCoverage,
  fullCoverage,
  historyGap,
  historyWindowStart,
  isoLte,
  mergeCoverage,
  mergeTransactionRows,
  oldestCreatedAt,
  planHistoryLoad,
  shouldStopWindowPaging,
} from './historyWindow';

const NOW = Date.parse('2026-09-02T12:00:00.000Z');

describe('historyWindowStart', () => {
  it('is exactly 12 calendar months back by default', () => {
    expect(historyWindowStart(NOW)).toBe('2025-09-02T12:00:00.000Z');
  });

  it('honours an explicit month count', () => {
    expect(historyWindowStart(NOW, 3)).toBe('2026-06-02T12:00:00.000Z');
  });

  it('accepts a Date as well as an epoch', () => {
    expect(historyWindowStart(new Date(NOW))).toBe(historyWindowStart(NOW));
  });

  it('does not lose a day across a leap year', () => {
    // 2024 was a leap year; 12 months back from 2025-02-28 is 2024-02-28.
    expect(historyWindowStart(Date.parse('2025-02-28T00:00:00.000Z'))).toBe('2024-02-28T00:00:00.000Z');
  });
});

describe('isoLte / earliestIso', () => {
  it('compares instants, not strings', () => {
    // Same instant, two spellings. String compare would get this backwards.
    expect(isoLte('2026-01-01T04:00:00.000+04:00', '2026-01-01T00:00:00.000Z')).toBe(true);
    expect(isoLte('2026-01-01T00:00:00.000Z', '2026-01-01T04:00:00.000+04:00')).toBe(true);
  });

  it('falls back to string order for unparseable values', () => {
    expect(isoLte('aaa', 'bbb')).toBe(true);
    expect(isoLte('bbb', 'aaa')).toBe(false);
  });

  it('treats null as "no value", never as -infinity', () => {
    expect(earliestIso(null, '2026-01-01T00:00:00.000Z')).toBe('2026-01-01T00:00:00.000Z');
    expect(earliestIso('2026-01-01T00:00:00.000Z', null)).toBe('2026-01-01T00:00:00.000Z');
    expect(earliestIso(null, null)).toBeNull();
    expect(earliestIso('2026-03-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')).toBe('2026-01-01T00:00:00.000Z');
  });
});

describe('coverageSatisfies', () => {
  const jan = '2026-01-01T00:00:00.000Z';
  const jun = '2026-06-01T00:00:00.000Z';

  it('complete coverage answers everything', () => {
    expect(coverageSatisfies(fullCoverage(), { all: true })).toBe(true);
    expect(coverageSatisfies(fullCoverage(), { since: '1999-01-01T00:00:00.000Z' })).toBe(true);
    expect(coverageSatisfies(fullCoverage())).toBe(true);
  });

  it('an unknown floor satisfies nothing — not even a recent instant', () => {
    expect(coverageSatisfies(emptyCoverage(), { since: jun })).toBe(false);
    expect(coverageSatisfies(emptyCoverage(), { all: true })).toBe(false);
  });

  it('a floor answers requests at or after it, and refuses ones below it', () => {
    const coverage = { since: jan, complete: false };
    expect(coverageSatisfies(coverage, { since: jan })).toBe(true);
    expect(coverageSatisfies(coverage, { since: jun })).toBe(true);
    expect(coverageSatisfies(coverage, { since: '2025-12-31T23:59:59.999Z' })).toBe(false);
  });

  it('a bare request means "everything" — a caller that does not say is assumed to need all', () => {
    expect(coverageSatisfies({ since: jan, complete: false })).toBe(false);
    expect(coverageSatisfies({ since: jan, complete: false }, {})).toBe(false);
  });

  it('never lets a partial floor answer an {all} request', () => {
    expect(coverageSatisfies({ since: '1970-01-01T00:00:00.000Z', complete: false }, { all: true })).toBe(false);
  });
});

describe('mergeCoverage', () => {
  const jan = '2026-01-01T00:00:00.000Z';
  const jun = '2026-06-01T00:00:00.000Z';

  it('completeness is absorbing', () => {
    expect(mergeCoverage({ since: jun, complete: false }, fullCoverage())).toEqual(fullCoverage());
    expect(mergeCoverage(fullCoverage(), { since: jun, complete: false })).toEqual(fullCoverage());
  });

  it('takes the earlier floor — coverage only ever widens', () => {
    expect(mergeCoverage({ since: jun, complete: false }, { since: jan, complete: false }))
      .toEqual({ since: jan, complete: false });
    expect(mergeCoverage({ since: jan, complete: false }, { since: jun, complete: false }))
      .toEqual({ since: jan, complete: false });
  });

  it('an unknown floor contributes nothing rather than erasing a known one', () => {
    expect(mergeCoverage({ since: jun, complete: false }, emptyCoverage()))
      .toEqual({ since: jun, complete: false });
    expect(mergeCoverage(emptyCoverage(), emptyCoverage())).toEqual(emptyCoverage());
  });
});

describe('planHistoryLoad', () => {
  it('defaults to the 12-month window', () => {
    expect(planHistoryLoad({ coverage: emptyCoverage(), now: NOW }))
      .toEqual({ all: false, since: '2025-09-02T12:00:00.000Z' });
  });

  it('never narrows an established floor', () => {
    const plan = planHistoryLoad({
      coverage: { since: '2020-01-01T00:00:00.000Z', complete: false },
      now: NOW,
    });
    expect(plan).toEqual({ all: false, since: '2020-01-01T00:00:00.000Z' });
  });

  it('honours an explicit since that reaches further back', () => {
    const plan = planHistoryLoad({
      coverage: emptyCoverage(),
      requestedSince: '2019-05-05T00:00:00.000Z',
      now: NOW,
    });
    expect(plan.since).toBe('2019-05-05T00:00:00.000Z');
  });

  it('ignores an explicit since that is NEWER than the window (never shrinks)', () => {
    const plan = planHistoryLoad({
      coverage: emptyCoverage(),
      requestedSince: '2026-08-01T00:00:00.000Z',
      now: NOW,
    });
    expect(plan.since).toBe('2025-09-02T12:00:00.000Z');
  });

  it('once complete, a reload stays complete — a windowed refetch can never demote it', () => {
    expect(planHistoryLoad({ coverage: fullCoverage(), now: NOW }).all).toBe(true);
  });
});

describe('historyGap', () => {
  it('asks only for the part below the established floor', () => {
    expect(historyGap({ since: '2026-01-01T00:00:00.000Z', complete: false }, '2024-01-01T00:00:00.000Z'))
      .toEqual({ from: '2024-01-01T00:00:00.000Z', to: '2026-01-01T00:00:00.000Z' });
  });

  it('has no upper bound when no floor is established', () => {
    expect(historyGap(emptyCoverage(), '2024-01-01T00:00:00.000Z'))
      .toEqual({ from: '2024-01-01T00:00:00.000Z', to: null });
  });
});

describe('mergeTransactionRows', () => {
  const row = (id: string, createdAt: string, amount = 1) => ({ id, createdAt, amount });

  it('keeps rows the incoming set never mentioned', () => {
    const existing = [row('a', '2026-05-01T00:00:00.000Z'), row('b', '2026-04-01T00:00:00.000Z')];
    const incoming = [row('c', '2026-03-01T00:00:00.000Z')];
    expect(mergeTransactionRows(existing, incoming).map((r) => r.id)).toEqual(['a', 'b', 'c']);
  });

  it('never drops NEWER rows when older history is paged in', () => {
    // The exact failure mode this exists to prevent: `set({ transactions: fetched })`
    // on a partial fetch would delete the top of the list.
    const existing = [row('new', '2026-09-01T00:00:00.000Z')];
    const older = [row('old1', '2021-01-02T00:00:00.000Z'), row('old2', '2021-01-01T00:00:00.000Z')];
    expect(mergeTransactionRows(existing, older).map((r) => r.id)).toEqual(['new', 'old1', 'old2']);
  });

  it('incoming wins on an id collision (it is the fresher copy)', () => {
    const merged = mergeTransactionRows(
      [row('a', '2026-05-01T00:00:00.000Z', 100)],
      [row('a', '2026-05-01T00:00:00.000Z', 250)],
    );
    expect(merged).toHaveLength(1);
    expect(merged[0].amount).toBe(250);
  });

  it('orders createdAt DESC, then id DESC — the DAL keyset order', () => {
    const merged = mergeTransactionRows([], [
      row('a', '2026-05-01T00:00:00.000Z'),
      row('c', '2026-05-01T00:00:00.000Z'),
      row('b', '2026-06-01T00:00:00.000Z'),
    ]);
    expect(merged.map((r) => r.id)).toEqual(['b', 'c', 'a']);
  });

  it('returns the original array untouched when nothing came in', () => {
    const existing = [row('a', '2026-05-01T00:00:00.000Z')];
    expect(mergeTransactionRows(existing, [])).toBe(existing);
  });

  it('handles a ledger-only row (both account ids null) like any other', () => {
    // The merge never inspects account ids — it reads id + createdAt only.
    type Row = { id: string; createdAt: string; sourceAccountId: string | null; destinationAccountId: string | null };
    const ledger: Row = { id: 'l1', createdAt: '2026-05-01T00:00:00.000Z', sourceAccountId: null, destinationAccountId: null };
    const tracked: Row = { id: 't1', createdAt: '2026-04-01T00:00:00.000Z', sourceAccountId: 'cash', destinationAccountId: null };
    expect(mergeTransactionRows([tracked], [ledger]).map((r) => r.id)).toEqual(['l1', 't1']);
  });
});

describe('oldestCreatedAt', () => {
  it('finds the earliest instant regardless of array order', () => {
    expect(oldestCreatedAt([
      { createdAt: '2026-05-01T00:00:00.000Z' },
      { createdAt: '2021-01-01T00:00:00.000Z' },
      { createdAt: '2024-01-01T00:00:00.000Z' },
    ])).toBe('2021-01-01T00:00:00.000Z');
  });

  it('is null for an empty set', () => {
    expect(oldestCreatedAt([])).toBeNull();
  });
});

describe('shouldStopWindowPaging', () => {
  const since = '2025-09-02T12:00:00.000Z';

  it('needs BOTH floors — past the date is not enough', () => {
    expect(shouldStopWindowPaging({
      oldestFetched: '2024-01-01T00:00:00.000Z', rowsFetched: 500, since, minRows: 1000,
    })).toBe(false);
  });

  it('needs BOTH floors — enough rows is not enough', () => {
    expect(shouldStopWindowPaging({
      oldestFetched: '2026-01-01T00:00:00.000Z', rowsFetched: 5000, since, minRows: 1000,
    })).toBe(false);
  });

  it('stops once past the date floor AND at the row floor', () => {
    expect(shouldStopWindowPaging({
      oldestFetched: '2024-01-01T00:00:00.000Z', rowsFetched: 1000, since, minRows: 1000,
    })).toBe(true);
  });

  it('does not stop on the boundary instant itself (inclusive window)', () => {
    expect(shouldStopWindowPaging({
      oldestFetched: since, rowsFetched: 5000, since, minRows: 1000,
    })).toBe(false);
  });

  it('never stops before the first page has landed', () => {
    expect(shouldStopWindowPaging({ oldestFetched: null, rowsFetched: 0, since, minRows: 0 })).toBe(false);
  });
});

describe('the documented constants', () => {
  it('are the values the store and the DAL are wired to', () => {
    expect(HISTORY_WINDOW_MONTHS).toBe(12);
    // Two TRANSACTION_PAGE_SIZE pages, and the PostgREST max-rows default.
    expect(HISTORY_MIN_ROWS).toBe(1000);
  });
});
