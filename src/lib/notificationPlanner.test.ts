import { describe, expect, it } from 'vitest';
import { notificationId, planNotifications, type PlanInputs } from './notificationPlanner';
import type { Account, Committee, EmiSchedule, Loan, RecurringTransaction, UpcomingExpense } from '../db';

// 09:00 on 24 Jul — before the 10:00 fire slot, so same-day (T-0) entries
// are still schedulable.
const NOW = new Date(2026, 6, 24, 9, 0, 0);

const card = (over: Partial<Account> = {}): Account => ({
  id: 'c1', name: 'RAK Titanium', type: 'credit_card', currency: 'AED',
  balance: 7621.96, metadata: { dueDay: '26', creditLimit: '17600' },
  createdAt: '2026-01-01T00:00:00Z', ...over,
});

const loan = (over: Partial<Loan> = {}): Loan => ({
  id: 'l1', personName: 'Ali', personId: null, type: 'taken', totalAmount: 5000,
  remainingAmount: 5000, currency: 'AED', status: 'active', notes: '',
  createdAt: '2026-06-01T00:00:00Z', ...over,
});

const emi = (over: Partial<EmiSchedule> = {}): EmiSchedule => ({
  id: 'e1', loanId: 'l1', installmentNumber: 2, dueDate: '2026-07-25',
  amount: 500, status: 'upcoming', ...over,
});

const inputs = (over: Partial<PlanInputs> = {}): PlanInputs => ({
  accounts: [], loans: [], schedules: [], templates: [], upcoming: [],
  committees: [], committeePayments: [], now: NOW, ...over,
});

describe('planNotifications', () => {
  it('a card still owing gets the escalation ladder; a PAID card gets nothing', () => {
    const owing = planNotifications(inputs({ accounts: [card()] }));
    // due in 2d → T-1 (tomorrow) and T-0 (due day); T-3 is already past.
    expect(owing.map((p) => p.key).sort()).toEqual(['card:c1:t0', 'card:c1:t1'].sort());
    const dayOf = owing.find((p) => p.key === 'card:c1:t0');
    expect(dayOf?.priority).toBe(100);
    expect(dayOf?.body).toContain('9,978');

    const paid = planNotifications(inputs({ accounts: [card({ balance: 17600 })] }));
    expect(paid).toHaveLength(0);
  });

  it('EMIs remind T-1/T-0, but card-funded ones defer to the funding card', () => {
    const base = inputs({ loans: [loan()], schedules: [emi()] });
    const plain = planNotifications(base);
    expect(plain.map((p) => p.key)).toContain('emi:e1:t0');

    const suppressed = planNotifications({
      ...base,
      accounts: [card()],
      cardFundedLoanIds: new Map([['l1', 'c1']]),
    });
    expect(suppressed.find((p) => p.key.startsWith('emi:'))).toBeUndefined();
  });

  it('paid EMIs and settled loans never ring', () => {
    expect(planNotifications(inputs({ loans: [loan()], schedules: [emi({ status: 'paid' })] }))).toHaveLength(0);
    expect(planNotifications(inputs({ loans: [loan({ status: 'settled' })], schedules: [emi()] }))).toHaveLength(0);
  });

  it('never schedules into the past — an overdue item stays in-app, not on the lock screen', () => {
    const plan = planNotifications(inputs({ loans: [loan()], schedules: [emi({ dueDate: '2026-07-20' })] }));
    expect(plan).toHaveLength(0);
  });

  it('caps each day at 3, keeping the highest-priority reminders', () => {
    const tpl = (id: string): RecurringTransaction => ({
      id, type: 'expense', amount: 100, currency: 'AED', sourceAccountId: 'a',
      destinationAccountId: null, category: 'Bills', notes: '', cadence: 'monthly',
      nextDueDate: '2026-07-25', active: true, label: id, createdAt: '', ...( {} ),
    });
    const bill = (id: string): UpcomingExpense => ({
      id, title: id, amount: 50, currency: 'AED', dueDate: '2026-07-25T00:00:00Z',
      accountId: 'a', category: '', notes: '', isPaid: false, status: 'upcoming',
      reminderDaysBefore: 1, createdAt: '',
    });
    const plan = planNotifications(inputs({
      loans: [loan()],
      schedules: [emi({ dueDate: '2026-07-25' })],
      templates: [tpl('r1'), tpl('r2')],
      upcoming: [bill('b1'), bill('b2')],
    }));
    const onDueDay = plan.filter((p) => new Date(p.atMs).getDate() === 25);
    expect(onDueDay).toHaveLength(3);
    // EMI day-of (90) and the two bill day-ofs (75) outrank recurring (60).
    expect(onDueDay.map((p) => p.key)).toContain('emi:e1:t0');
  });

  it('ids are stable and positive int32', () => {
    expect(notificationId('card:c1:0')).toBe(notificationId('card:c1:0'));
    expect(notificationId('card:c1:0')).not.toBe(notificationId('card:c1:1'));
    const id = notificationId('anything');
    expect(id).toBeGreaterThan(0);
    expect(id).toBeLessThanOrEqual(2147483647);
  });

  it('kameti rounds inside the horizon ring on the day — unless already fully collected', () => {
    const committee = {
      id: 'k1', name: 'Office', currency: 'AED', contributionAmount: 200, memberCount: 2,
      cadence: 'monthly', totalRounds: 5, startDate: '2026-07-26', payoutMethod: 'fixed',
      status: 'active', notes: '', createdAt: '',
    } as Committee;
    const plan = planNotifications(inputs({ committees: [committee] }));
    expect(plan.map((p) => p.key)).toContain('kameti:k1:1');

    const collected = planNotifications(inputs({
      committees: [committee],
      committeePayments: [1, 2].map((n) => ({
        id: `p${n}`, committeeId: 'k1', memberId: `m${n}`, round: 1, paidAt: '2026-07-24T08:00:00Z',
      })),
    }));
    expect(collected.find((p) => p.key === 'kameti:k1:1')).toBeUndefined();
  });
});
