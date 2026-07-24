// Praise-row behavior for cleared card bills (kept separate from the main
// thisWeek fixtures — these tests are about the paid-state contract).
import { describe, expect, it } from 'vitest';
import { buildThisWeek, thisWeekTotals } from './thisWeek';
import type { Account, Transaction } from '../db';

const TODAY = new Date(2026, 6, 24, 12, 0, 0); // 24 Jul 2026 local

const card = (over: Partial<Account> = {}): Account => ({
  id: 'c1', name: 'RAK Titanium', type: 'credit_card', currency: 'AED',
  balance: 17600, metadata: { dueDay: '26', creditLimit: '17600' },
  createdAt: '2026-01-01T00:00:00Z', ...over,
});

const payment = (over: Partial<Transaction> = {}): Transaction => ({
  id: 'p1', type: 'transfer', amount: 9978.04, currency: 'AED',
  sourceAccountId: 'bank', destinationAccountId: 'c1', relatedPerson: null,
  personId: null, relatedLoanId: null, relatedGoalId: null, conversionRate: null,
  category: '', notes: '', createdAt: new Date(2026, 6, 23, 9, 0, 0).toISOString(), ...over,
});

const inputs = (accounts: Account[], transactions?: Transaction[]) => ({
  loans: [], schedules: [], committees: [], templates: [], upcoming: [],
  accounts, transactions, today: TODAY,
});

describe('cleared-card praise rows', () => {
  it('a cleared bill with a visible payment this cycle earns a praise row, not silence', () => {
    const rows = buildThisWeek(inputs([card()], [payment()]));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: 'card-cleared-c1',
      kind: 'card',
      sub: { kind: 'cleared', daysEarly: 2 },
      amount: null,
    });
    // Praise rows never pollute the "going out" header total.
    expect(thisWeekTotals(rows)).toEqual([]);
  });

  it('no payment visible this cycle → stays silent (never praise an untouched card)', () => {
    expect(buildThisWeek(inputs([card()], []))).toHaveLength(0);
  });

  it('without transaction data the old silent behavior is preserved', () => {
    expect(buildThisWeek(inputs([card()]))).toHaveLength(0);
  });

  it('a card still owing keeps its normal due row', () => {
    const rows = buildThisWeek(inputs([card({ balance: 7621.96 })], [payment({ amount: 500 })]));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: 'card-c1', amount: 9978.04 });
  });

  it('a payment from the PREVIOUS cycle does not count as clearing this one', () => {
    const rows = buildThisWeek(inputs(
      [card()],
      [payment({ createdAt: new Date(2026, 5, 20, 9, 0, 0).toISOString() })], // weeks before the upcoming due day
    ));
    expect(rows).toHaveLength(0);
  });

  it('praise survives ON the due day for an early payer (no due-day vanish)', () => {
    const dueDayToday = new Date(2026, 6, 26, 9, 0, 0);
    const rows = buildThisWeek({
      ...inputs([card()], [payment()]), // paid 23 Jul
      today: dueDayToday,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: 'card-cleared-c1', sub: { kind: 'cleared', daysEarly: 0 } });
  });
});
