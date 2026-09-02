// The coverage contract, enforced against the source.
//
// `transactionStore.loadTransactions()` returns a WINDOW now (12 months / 1000
// rows — see historyWindow.ts). Most screens are fine with that. A handful are
// not: a statement of account, a data-shaped migration, an account's own
// ledger, and the Analytics client-side fallback all produce a NUMBER that is
// simply wrong — not empty, not obviously broken, just quietly smaller — if
// they compute over a partial set.
//
// That failure is invisible to every other kind of test: the store is
// populated, the component renders, the arithmetic is correct, and the answer
// is a lie. The only durable guard is a structural one — each of these files
// must be seen to ask for completeness. If a future refactor drops the call,
// this suite says so by name rather than a user noticing a debt shrank.
//
// Deliberately a source-level assertion. These are React components and
// migration side-effects; standing up a DOM and a fake Supabase to observe one
// awaited call would be a far heavier test that proves less.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

function source(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), 'utf8');
}

/** Files that MUST NOT compute on a partial history. */
const COMPLETENESS_CRITICAL: { file: string; why: string }[] = [
  {
    file: '../components/SendStatementModal.tsx',
    why: 'the statement of account a user sends to another person as a record of a debt',
  },
  {
    file: '../pages/AnalyticsPage.tsx',
    why: 'the client-side fallback aggregation, whose periods include "this year" and "all time"',
  },
  {
    file: '../pages/AccountDetailPage.tsx',
    why: "an account's own statement, plus the card-cycle debt derived from advance/bill rows",
  },
  {
    file: './migrations/backfillPersons.ts',
    why: 'a one-shot migration that rewrites every historical row and then never looks again',
  },
];

describe('history coverage contract', () => {
  for (const { file, why } of COMPLETENESS_CRITICAL) {
    it(`${file} asks for the whole history — ${why}`, () => {
      const text = source(file);
      expect(
        /ensureTransactionHistory\(\s*\{\s*all:\s*true\s*\}\s*\)/.test(text),
        `${file} reads the transaction store but never calls ensureTransactionHistory({ all: true }).`,
      ).toBe(true);
    });
  }

  it('the statement call site AWAITS coverage.complete before building', () => {
    // Not "it fired the fetch" — it must refuse to build until the set is
    // provably complete, so a failed or in-flight fetch cannot produce a
    // confident-looking ledger with older repayments missing.
    const text = source('../components/SendStatementModal.tsx');

    // It reads the completeness flag...
    expect(/historyCoverage\.complete/.test(text)).toBe(true);
    // ...and buildStatement is guarded by it, not merely near it.
    const build = text.slice(text.indexOf('const statement = useMemo('), text.indexOf('buildStatement({'));
    expect(build).toMatch(/if\s*\(\s*!historyReady\s*\)\s*return null;/);
    // The guard is a dependency of the memo, so an arriving fetch re-runs it.
    const memoTail = text.slice(text.indexOf('buildStatement({'));
    expect(memoTail.slice(0, 400)).toMatch(/historyReady/);
  });

  it('windowed screens ask only for what their own horizon needs', () => {
    // Home and Loans key card-funded loans off the loan's ORIGIN transaction,
    // which can predate the window. They widen coverage to the oldest loan they
    // hold — not to the whole table, which would put the unbounded fetch back
    // on the boot path it was just taken off.
    for (const file of ['../pages/HomePage.tsx', '../pages/LoansPage.tsx']) {
      const text = source(file);
      expect(
        /ensureTransactionHistory\(\s*\{\s*since:/.test(text),
        `${file} should widen coverage with a bounded { since }, not { all: true }.`,
      ).toBe(true);
      expect(
        /ensureTransactionHistory\(\s*\{\s*all:\s*true\s*\}\s*\)/.test(text),
        `${file} must NOT pull the whole history on a boot path.`,
      ).toBe(false);
    }
  });

  it('TransactionsPage pays for "Show full history" and for any active filter', () => {
    const text = source('../pages/TransactionsPage.tsx');
    // The button fetches rather than only lifting the render window.
    expect(/revealFullHistory/.test(text)).toBe(true);
    expect(/onClick=\{\s*revealFullHistory\s*\}/.test(text)).toBe(true);
    expect(/setShowFullHistory\(true\)[\s\S]{0,200}ensureTransactionHistory\(\s*\{\s*all:\s*true\s*\}/.test(text)).toBe(true);
    // §6.6.5's promise: a search always runs over the complete history.
    expect(/filtersActive[\s\S]{0,300}ensureTransactionHistory/.test(text)).toBe(true);
  });

  it('exportAllData reads the DAL directly, so the window never truncates a backup', () => {
    // dataExport is the one "must be complete" consumer that needs no change:
    // it has always gone straight to transactionsDb.getAll() (the keyset walk),
    // never through the store. Pinned so a future "reuse the store's rows"
    // tidy-up cannot silently start exporting 12 months.
    const text = source('./dataExport.ts');
    expect(/transactionsDb\.getAll\(\)/.test(text)).toBe(true);
    expect(/useTransactionStore/.test(text)).toBe(false);
  });
});
