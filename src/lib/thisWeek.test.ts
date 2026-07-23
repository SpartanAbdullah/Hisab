import { describe, expect, it } from 'vitest';
import { buildThisWeek, thisWeekTotals, type ThisWeekInputs } from './thisWeek';
import type { Account, Committee, EmiSchedule, Loan, RecurringTransaction, UpcomingExpense } from '../db';

const TODAY = new Date('2026-07-22T10:00:00');

const loan = (over: Partial<Loan> = {}): Loan => ({
  id: 'loan-1', personName: 'Ali', personId: null, type: 'taken',
  totalAmount: 900, remainingAmount: 600, currency: 'AED', status: 'active',
  notes: '', createdAt: '2026-06-01T00:00:00Z', ...over,
});

const emi = (over: Partial<EmiSchedule> = {}): EmiSchedule => ({
  id: 'emi-1', loanId: 'loan-1', installmentNumber: 2,
  dueDate: '2026-07-25', amount: 300, status: 'upcoming', ...over,
});

const inputs = (over: Partial<ThisWeekInputs> = {}): ThisWeekInputs => ({
  loans: [], schedules: [], committees: [], templates: [], upcoming: [],
  accounts: [], today: TODAY, ...over,
});

describe('buildThisWeek', () => {
  it('includes an EMI due within the window, joined to its loan for currency and direction', () => {
    const rows = buildThisWeek(inputs({ loans: [loan()], schedules: [emi()] }));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: 'emi', label: 'Ali', amount: 300, currency: 'AED',
      daysUntil: 3, direction: 'pay', href: '/loan/loan-1',
    });
  });

  it('a GIVEN loan instalment is money coming in', () => {
    const rows = buildThisWeek(inputs({ loans: [loan({ type: 'given' })], schedules: [emi()] }));
    expect(rows[0].direction).toBe('receive');
  });

  it('excludes paid instalments, settled loans, and dates outside the window', () => {
    const rows = buildThisWeek(inputs({
      loans: [loan(), loan({ id: 'loan-2', status: 'settled' })],
      schedules: [
        emi({ id: 'a', status: 'paid' }),
        emi({ id: 'b', loanId: 'loan-2' }),
        emi({ id: 'c', dueDate: '2026-08-15' }),
        emi({ id: 'd', dueDate: '2026-07-20' }), // overdue — not "this week"
      ],
    }));
    expect(rows).toHaveLength(0);
  });

  it('surfaces only the NEXT kameti round when it falls inside the window', () => {
    const committee: Committee = {
      id: 'k-1', name: 'Office Kameti', currency: 'PKR', contributionAmount: 5000,
      memberCount: 10, cadence: 'monthly', totalRounds: 10, startDate: '2026-05-24',
      payoutMethod: 'fixed', status: 'active', notes: '', createdAt: '2026-05-01T00:00:00Z',
    } as Committee;
    // Rounds: May 24, Jun 24, Jul 24 (2 days away) — only Jul 24 appears.
    const rows = buildThisWeek(inputs({ committees: [committee] }));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'kameti', daysUntil: 2, amount: 5000, href: '/kameti/k-1' });
  });

  it('recurring income shows as incoming; inactive templates are skipped', () => {
    const tpl = (over: Partial<RecurringTransaction>): RecurringTransaction => ({
      id: 'r1', type: 'expense', amount: 3500, currency: 'AED', sourceAccountId: 'a',
      destinationAccountId: null, category: 'Bills', notes: '', cadence: 'monthly',
      nextDueDate: '2026-07-24', active: true, label: 'Netflix', createdAt: '', ...over,
    });
    const rows = buildThisWeek(inputs({
      templates: [tpl({}), tpl({ id: 'r2', type: 'income', label: 'Salary' }), tpl({ id: 'r3', active: false })],
    }));
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.label === 'Salary')?.direction).toBe('receive');
  });

  it('credit cards use the monthly due-day and owed amount; no limit → date-only row', () => {
    const card = (over: Partial<Account>): Account => ({
      id: 'cc', name: 'ENBD', type: 'credit_card', currency: 'AED', balance: 15000,
      metadata: { dueDay: '25', creditLimit: '16500' }, createdAt: '', ...over,
    });
    const rows = buildThisWeek(inputs({
      accounts: [card({}), card({ id: 'cc2', name: 'RAK', metadata: { dueDay: '26' } })],
    }));
    expect(rows.find((r) => r.id === 'card-cc')).toMatchObject({ amount: 1500, daysUntil: 3 });
    expect(rows.find((r) => r.id === 'card-cc2')?.amount).toBeNull();
  });

  it('suppresses a cash-advance EMI when its funding card can carry the obligation (same-debt rule)', () => {
    const card: Account = {
      id: 'cc', name: 'ENBD', type: 'credit_card', currency: 'AED', balance: 15000,
      metadata: { dueDay: '25', creditLimit: '16500' }, createdAt: '',
    } as Account;
    const rows = buildThisWeek(inputs({
      loans: [loan()],
      schedules: [emi()],
      accounts: [card],
      cardFundedLoanIds: new Map([['loan-1', 'cc']]),
    }));
    // Only the card row remains — its owed amount already contains the EMI.
    expect(rows.filter((r) => r.kind === 'emi')).toHaveLength(0);
    expect(rows.filter((r) => r.kind === 'card')).toHaveLength(1);
  });

  it('keeps a cash-advance EMI when the funding card has NO due day (nothing else carries it)', () => {
    const card: Account = {
      id: 'cc', name: 'ENBD', type: 'credit_card', currency: 'AED', balance: 15000,
      metadata: { creditLimit: '16500' }, createdAt: '',
    } as Account;
    const rows = buildThisWeek(inputs({
      loans: [loan()],
      schedules: [emi()],
      accounts: [card],
      cardFundedLoanIds: new Map([['loan-1', 'cc']]),
    }));
    expect(rows.filter((r) => r.kind === 'emi')).toHaveLength(1);
  });

  it('skips a fully paid (or overpaid) card — no obligation, no row', () => {
    const card = (id: string, balance: number): Account => ({
      id, name: id, type: 'credit_card', currency: 'AED', balance,
      metadata: { dueDay: '25', creditLimit: '16500' }, createdAt: '',
    } as Account);
    const rows = buildThisWeek(inputs({ accounts: [card('paid', 16500), card('over', 27650)] }));
    expect(rows).toHaveLength(0);
  });

  it('a daily kameti sums every in-window round into one row (weekly total honesty)', () => {
    const committee: Committee = {
      id: 'k-d', name: 'Daily Kameti', currency: 'PKR', contributionAmount: 500,
      memberCount: 10, cadence: 'daily', totalRounds: 30, startDate: '2026-07-20',
      payoutMethod: 'fixed', status: 'active', notes: '', createdAt: '',
    } as Committee;
    const rows = buildThisWeek(inputs({ committees: [committee] }));
    expect(rows).toHaveLength(1);
    // Jul 22..29 inclusive = 8 rounds in the [0,7] window.
    expect(rows[0].amount).toBe(4000);
    expect(rows[0].sub).toMatchObject({ kind: 'round', count: 8 });
    expect(rows[0].daysUntil).toBe(0);
  });

  it('sorts by urgency first, then size, and totals split by currency + direction', () => {
    const bill: UpcomingExpense = {
      id: 'b1', title: 'School fees', amount: 2000, currency: 'AED', dueDate: '2026-07-23',
      accountId: 'a', category: 'Education', notes: '', isPaid: false,
      status: 'upcoming', reminderDaysBefore: 3, createdAt: '',
    } as UpcomingExpense;
    const rows = buildThisWeek(inputs({ loans: [loan(), loan({ id: 'loan-2', type: 'given', currency: 'PKR' })], schedules: [emi(), emi({ id: 'e2', loanId: 'loan-2', amount: 8000 })], upcoming: [bill] }));
    expect(rows[0].label).toBe('School fees'); // day 1 beats day 3
    const totals = thisWeekTotals(rows);
    expect(totals.find((t) => t.currency === 'AED')).toEqual({ currency: 'AED', out: 2300, incoming: 0 });
    expect(totals.find((t) => t.currency === 'PKR')).toEqual({ currency: 'PKR', out: 0, incoming: 8000 });
  });
});
