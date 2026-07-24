import { describe, expect, it } from 'vitest';
import { buildInboxActionItems, buildInboxInfoItems, cardPaymentThisCycle, daysUntilDayOfMonth, lastDayOfMonthOccurrence, type ActionInputs } from './inboxInfo';
import type { Account, Budget, Committee, EmiSchedule, Loan, RecurringTransaction, Transaction, UpcomingExpense } from '../db';

const today = new Date(2026, 5, 22, 12, 0, 0); // 22 Jun 2026, noon local
const plusDays = (n: number) => new Date(today.getTime() + n * 86_400_000);
const isoDate = (d: Date) => d.toISOString().slice(0, 10);

describe('daysUntilDayOfMonth', () => {
  it('counts days to a later day this month', () => {
    expect(daysUntilDayOfMonth(25, today)).toBe(3);
  });
  it('returns 0 when the day is today', () => {
    expect(daysUntilDayOfMonth(22, today)).toBe(0);
  });
  it('rolls into next month once the day has passed', () => {
    expect(daysUntilDayOfMonth(20, today)).toBe(28); // → 20 Jul
  });
  it('clamps a 31st due-day to the end of a 30-day month', () => {
    expect(daysUntilDayOfMonth(31, today)).toBe(8); // → 30 Jun
  });
  it('rejects invalid days', () => {
    expect(daysUntilDayOfMonth(0, today)).toBeNull();
    expect(daysUntilDayOfMonth(32, today)).toBeNull();
  });
});

const budget: Budget = {
  id: 'b1',
  category: 'Food',
  monthlyAmount: 100,
  currency: 'AED',
  warnAtPercent: 80,
  createdAt: today.toISOString(),
};

const tx = (amount: number): Transaction => ({
  id: 't1',
  type: 'expense',
  amount,
  currency: 'AED',
  sourceAccountId: 'a0',
  destinationAccountId: null,
  relatedPerson: null,
  relatedLoanId: null,
  relatedGoalId: null,
  conversionRate: null,
  category: 'Food',
  notes: '',
  createdAt: today.toISOString(),
});

const sub: RecurringTransaction = {
  id: 'r1',
  type: 'expense',
  amount: 50,
  currency: 'AED',
  sourceAccountId: 'a0',
  destinationAccountId: null,
  category: 'Subscriptions',
  notes: '',
  cadence: 'monthly',
  nextDueDate: isoDate(plusDays(3)),
  active: true,
  label: 'Netflix',
  createdAt: today.toISOString(),
};

const card: Account = {
  id: 'a1',
  name: 'Visa',
  type: 'credit_card',
  currency: 'AED',
  balance: -200,
  metadata: { dueDay: '25' },
  createdAt: today.toISOString(),
};

const bill: UpcomingExpense = {
  id: 'e1',
  title: 'Electricity',
  amount: 30,
  currency: 'AED',
  dueDate: plusDays(2).toISOString(),
  accountId: 'a0',
  category: 'Utilities',
  notes: '',
  isPaid: false,
  status: 'upcoming',
  reminderDaysBefore: 7,
  createdAt: today.toISOString(),
};

describe('lastDayOfMonthOccurrence + cardPaymentThisCycle', () => {
  it('finds the most recent due-day occurrence, rolling back a month when needed', () => {
    // today = 22 Jun; due day 25 last occurred 25 May.
    expect(lastDayOfMonthOccurrence(25, today)?.getTime()).toBe(new Date(2026, 4, 25).getTime());
    expect(lastDayOfMonthOccurrence(20, today)?.getTime()).toBe(new Date(2026, 5, 20).getTime());
    expect(lastDayOfMonthOccurrence(22, today)?.getTime()).toBe(new Date(2026, 5, 22).getTime());
    expect(lastDayOfMonthOccurrence(31, new Date(2026, 6, 5))?.getTime()).toBe(new Date(2026, 5, 30).getTime()); // clamped to 30 Jun
    expect(lastDayOfMonthOccurrence(0, today)).toBeNull();
  });

  it('sums only real credits inside the 14 days before the UPCOMING due day', () => {
    // today 22 Jun, due day 25 → window opens 11 Jun.
    const cardAcct: Account = { ...card, metadata: { dueDay: '25', creditLimit: '10000' } };
    const paid = cardPaymentThisCycle(cardAcct, [
      { ...tx(500), id: 'p1', type: 'transfer', sourceAccountId: 'a0', destinationAccountId: 'a1', createdAt: plusDays(-1).toISOString() },
      { ...tx(200), id: 'p2', type: 'repayment', sourceAccountId: null, destinationAccountId: 'a1', createdAt: plusDays(-2).toISOString() },
      { ...tx(999), id: 'p3', type: 'transfer', destinationAccountId: 'a1', createdAt: plusDays(-30).toISOString() }, // last cycle's (late) payment
      { ...tx(999), id: 'p4', type: 'transfer', destinationAccountId: 'a1', createdAt: plusDays(-1).toISOString(), deletedAt: today.toISOString() },
      { ...tx(999), id: 'p5', type: 'expense', destinationAccountId: null, createdAt: plusDays(-1).toISOString() },
      // "Correct balance" is bookkeeping, not a payment — never praised.
      { ...tx(999), id: 'p6', type: 'adjustment', destinationAccountId: 'a1', createdAt: plusDays(-1).toISOString() },
    ], today);
    expect(paid).toBe(700);
  });

  it('still counts an early payment ON the due day itself (window anchors to the upcoming due day)', () => {
    const cardAcct: Account = { ...card, metadata: { dueDay: '22', creditLimit: '10000' } };
    const paid = cardPaymentThisCycle(cardAcct, [
      { ...tx(400), id: 'p1', type: 'transfer', destinationAccountId: 'a1', createdAt: plusDays(-3).toISOString() },
    ], today); // today IS the due day (22 Jun)
    expect(paid).toBe(400);
  });
});

describe('buildInboxInfoItems', () => {
  it('surfaces over-budget, renewal, credit-card and bill signals', () => {
    const items = buildInboxInfoItems({
      budgets: [budget],
      transactions: [tx(120)], // 120% of a 100 budget → over limit
      templates: [sub],
      accounts: [card],
      upcoming: [bill],
      today,
    });
    const ids = items.map((i) => i.id);
    expect(ids).toContain('budget-b1');
    expect(ids).toContain('renewal-r1');
    expect(ids).toContain('cc-a1');
    expect(ids).toContain('upcoming-e1');
    const budgetItem = items.find((i) => i.id === 'budget-b1');
    expect(budgetItem?.tone).toBe('pay'); // over the limit, not just warn
    expect(budgetItem?.icon).toBe('budget');
  });

  it('a PAID card stops nagging — and praises when the payment is visible this cycle', () => {
    // owed = limit - balance = 0 → the due reminder must NOT fire.
    const paidCard: Account = { ...card, balance: 8000, metadata: { dueDay: '25', creditLimit: '8000' } };
    const base = { budgets: [], transactions: [] as Transaction[], templates: [], accounts: [paidCard], upcoming: [], today };

    const silent = buildInboxInfoItems(base);
    expect(silent.find((i) => i.id.startsWith('cc'))).toBeUndefined();

    const praised = buildInboxInfoItems({
      ...base,
      transactions: [
        { ...tx(3000), id: 'pay1', type: 'transfer', sourceAccountId: 'a0', destinationAccountId: 'a1', createdAt: plusDays(-2).toISOString() },
      ],
    });
    const praise = praised.find((i) => i.id === 'cc-cleared-a1');
    expect(praise?.tone).toBe('receive');
    expect(praise?.title).toContain('cleared');

    // Still owing → the plain due reminder stays.
    const owing = buildInboxInfoItems({ ...base, accounts: [{ ...paidCard, balance: 5000 }] });
    expect(owing.find((i) => i.id === 'cc-a1')).toBeDefined();
  });

  it('stays empty when nothing needs attention', () => {
    const items = buildInboxInfoItems({
      budgets: [budget],
      transactions: [tx(10)], // well under budget
      templates: [{ ...sub, nextDueDate: isoDate(plusDays(40)) }], // far away
      accounts: [{ ...card, metadata: { dueDay: '25' }, type: 'bank' }], // not a card
      upcoming: [{ ...bill, dueDate: plusDays(40).toISOString() }], // outside window
      today,
    });
    expect(items).toHaveLength(0);
  });
});

// ── needs-action queue ────────────────────────────────────────────────────

const loan = (over: Partial<Loan> = {}): Loan => ({
  id: 'l1', personName: 'Ali', personId: null, type: 'taken', totalAmount: 3000,
  remainingAmount: 2000, currency: 'AED', status: 'active', notes: '',
  createdAt: today.toISOString(), ...over,
});

const emi = (over: Partial<EmiSchedule> = {}): EmiSchedule => ({
  id: 'e1', loanId: 'l1', installmentNumber: 1, dueDate: isoDate(plusDays(-5)),
  amount: 500, status: 'upcoming', ...over,
});

const committee = (over: Partial<Committee> = {}): Committee => ({
  id: 'k1', name: 'Office', currency: 'AED', contributionAmount: 100, memberCount: 4,
  cadence: 'monthly', totalRounds: 4, startDate: isoDate(plusDays(-2)),
  payoutMethod: 'fixed', status: 'active', notes: '', createdAt: today.toISOString(),
  ...over,
} as Committee);

const actionInputs = (over: Partial<ActionInputs> = {}): ActionInputs => ({
  loans: [], schedules: [], transactions: [], templates: [], committees: [],
  committeePayments: [], accounts: [], today, ...over,
});

describe('buildInboxActionItems', () => {
  it('aggregates overdue EMIs per loan into ONE action with the summed amount', () => {
    const items = buildInboxActionItems(actionInputs({
      loans: [loan()],
      schedules: [
        emi(),
        emi({ id: 'e2', installmentNumber: 2, dueDate: isoDate(plusDays(-35)), amount: 500 }),
        emi({ id: 'e3', installmentNumber: 3, dueDate: isoDate(plusDays(4)) }), // future — not overdue
        emi({ id: 'e4', installmentNumber: 4, dueDate: isoDate(plusDays(-9)), status: 'paid' }),
      ],
    }));
    expect(items).toHaveLength(1);
    expect(items[0].id).toBe('emi-overdue-l1');
    expect(items[0].content).toEqual({
      kind: 'emi', person: 'Ali', count: 2, total: 1000, currency: 'AED', daysLate: 35, direction: 'pay',
    });
    expect(items[0].resolve).toEqual({ kind: 'navigate', href: '/loan/l1' });
  });

  it('suppresses cash-advance EMIs when the funding card carries a due day', () => {
    const items = buildInboxActionItems(actionInputs({
      loans: [loan()],
      schedules: [emi()],
      accounts: [card], // dueDay 25
      cardFundedLoanIds: new Map([['l1', 'a1']]),
    }));
    expect(items).toHaveLength(0);
  });

  it('flags missed recurring dates (strictly past — due-today belongs to the runner prompt)', () => {
    const items = buildInboxActionItems(actionInputs({
      templates: [
        { ...sub, nextDueDate: isoDate(plusDays(-3)) },
        { ...sub, id: 'r2', nextDueDate: isoDate(today) }, // due today — runner's job
        { ...sub, id: 'r3', nextDueDate: isoDate(plusDays(-3)), active: false },
      ],
    }));
    expect(items).toHaveLength(1);
    expect(items[0].content).toMatchObject({ kind: 'recurring', label: 'Netflix', amount: 50 });
    expect(items[0].resolve).toEqual({ kind: 'recurringPrompt', templateId: 'r1' });
  });

  it('flags an incomplete kameti round only once its date arrives', () => {
    const started = buildInboxActionItems(actionInputs({
      committees: [committee()],
      committeePayments: [
        { id: 'p1', committeeId: 'k1', memberId: 'm1', round: 1, paidAt: today.toISOString() },
      ],
    }));
    expect(started).toHaveLength(1);
    expect(started[0].content).toMatchObject({ kind: 'kameti', round: 1, paid: 1, members: 4, incompleteRounds: 1 });
    expect(started[0].resolve).toEqual({ kind: 'navigate', href: '/kameti/k1' });

    const complete = buildInboxActionItems(actionInputs({
      committees: [committee()],
      committeePayments: [1, 2, 3, 4].map((n) => ({
        id: `p${n}`, committeeId: 'k1', memberId: `m${n}`, round: 1, paidAt: today.toISOString(),
      })),
    }));
    expect(complete).toHaveLength(0);

    const notStarted = buildInboxActionItems(actionInputs({
      committees: [committee({ startDate: isoDate(plusDays(3)) })],
    }));
    expect(notStarted).toHaveLength(0);
  });

  it('a stuck OLDER round never vanishes when the next round starts', () => {
    // Monthly kameti started ~5 weeks ago: rounds 1 and 2 have both arrived.
    // Round 1 is stuck at 2/4 while round 2 is complete — the queue must
    // still point at round 1 (the earliest incomplete one).
    const items = buildInboxActionItems(actionInputs({
      committees: [committee({ startDate: isoDate(plusDays(-36)) })],
      committeePayments: [
        { id: 'p1', committeeId: 'k1', memberId: 'm1', round: 1, paidAt: today.toISOString() },
        { id: 'p2', committeeId: 'k1', memberId: 'm2', round: 1, paidAt: today.toISOString() },
        ...[1, 2, 3, 4].map((n) => ({
          id: `q${n}`, committeeId: 'k1', memberId: `m${n}`, round: 2, paidAt: today.toISOString(),
        })),
      ],
    }));
    expect(items).toHaveLength(1);
    expect(items[0].content).toMatchObject({ kind: 'kameti', round: 1, paid: 2, incompleteRounds: 1 });
  });

  it('queues recent uncategorised expenses, capped at 5, skipping old and deleted ones', () => {
    const un = (id: string, daysAgo: number, over: Partial<Transaction> = {}): Transaction => ({
      ...tx(25), id, category: '', createdAt: plusDays(-daysAgo).toISOString(), ...over,
    });
    const items = buildInboxActionItems(actionInputs({
      transactions: [
        un('u1', 1), un('u2', 2), un('u3', 3), un('u4', 4), un('u5', 5), un('u6', 6),
        un('old', 45), // outside the 30-day window
        un('del', 2, { deletedAt: today.toISOString() }),
        un('filed', 2, { category: 'Food' }),
      ],
    }));
    expect(items).toHaveLength(5);
    expect(items.map((i) => i.id)).toEqual(['uncategorized-u1', 'uncategorized-u2', 'uncategorized-u3', 'uncategorized-u4', 'uncategorized-u5']);
    expect(items[0].content).toMatchObject({ kind: 'uncategorized', amount: 25, currency: 'AED' });
    expect(items[0].resolve).toEqual({ kind: 'editTxn', txnId: 'u1' });
  });

  it('suggests a category from the payee history when the note matches', () => {
    const filed = (id: string, daysAgo: number): Transaction => ({
      ...tx(30), id, category: 'Transport', notes: 'Careem to office', createdAt: plusDays(-daysAgo).toISOString(),
    });
    const items = buildInboxActionItems(actionInputs({
      transactions: [
        filed('h1', 20), filed('h2', 10), // >= 2 uses builds the profile
        { ...tx(28), id: 'new1', category: '', notes: 'Careem to office', createdAt: plusDays(-1).toISOString() },
        { ...tx(50), id: 'new2', category: '', notes: 'One-off thing', createdAt: plusDays(-1).toISOString() },
      ],
    }));
    const suggested = items.find((i) => i.id === 'uncategorized-new1');
    const bare = items.find((i) => i.id === 'uncategorized-new2');
    expect(suggested?.content).toMatchObject({ kind: 'uncategorized', suggestedCategory: 'Transport' });
    expect(bare?.content.kind === 'uncategorized' && bare.content.suggestedCategory).toBeUndefined();
  });
});
