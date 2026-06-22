import { describe, expect, it } from 'vitest';
import { buildInboxInfoItems, daysUntilDayOfMonth } from './inboxInfo';
import type { Account, Budget, RecurringTransaction, Transaction, UpcomingExpense } from '../db';

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
