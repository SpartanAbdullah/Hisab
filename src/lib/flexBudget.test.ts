import { describe, expect, it } from 'vitest';
import { computeFlexBudget, type FlexBudgetInputs } from './flexBudget';
import { buildInternalNote } from './internalNotes';
import type { Committee, EmiSchedule, Loan, RecurringTransaction, Transaction } from '../db';

const TODAY = new Date('2026-07-23T10:00:00');

const inputs = (over: Partial<FlexBudgetInputs> = {}): FlexBudgetInputs => ({
  income: 100000,
  currency: 'PKR',
  loans: [],
  schedules: [],
  committees: [],
  templates: [],
  transactions: [],
  today: TODAY,
  ...over,
});

const loan = (over: Partial<Loan> = {}): Loan => ({
  id: 'l1', personName: 'Ali', personId: null, type: 'taken', totalAmount: 30000,
  remainingAmount: 20000, currency: 'PKR', status: 'active', notes: '', createdAt: '', ...over,
});

const emi = (over: Partial<EmiSchedule> = {}): EmiSchedule => ({
  id: 'e1', loanId: 'l1', installmentNumber: 2, dueDate: '2026-07-28',
  amount: 10000, status: 'upcoming', ...over,
});

const tpl = (over: Partial<RecurringTransaction> = {}): RecurringTransaction => ({
  id: 'r1', type: 'expense', amount: 3500, currency: 'PKR', sourceAccountId: 'a',
  destinationAccountId: null, category: 'Bills', notes: '', cadence: 'monthly',
  nextDueDate: '2026-07-25', active: true, label: 'Netflix', createdAt: '', ...over,
});

const expense = (over: Partial<Transaction> = {}): Transaction => ({
  id: Math.random().toString(36).slice(2), type: 'expense', amount: 5000, currency: 'PKR',
  sourceAccountId: 'a', destinationAccountId: null, relatedPerson: null, personId: null,
  relatedLoanId: null, relatedGoalId: null, conversionRate: null, category: 'Food',
  notes: '', createdAt: '2026-07-10T12:00:00', ...over,
});

describe('computeFlexBudget', () => {
  it('fixed = taken EMIs + kameti rounds + recurring charges due this month', () => {
    const committee: Committee = {
      id: 'k1', name: 'Office', currency: 'PKR', contributionAmount: 5000, memberCount: 10,
      cadence: 'monthly', totalRounds: 10, startDate: '2026-05-24', payoutMethod: 'fixed',
      status: 'active', notes: '', createdAt: '',
    } as Committee;
    const result = computeFlexBudget(inputs({
      // remaining 20000 of 30000 = instalment #1 already paid; #2 due this month.
      loans: [loan()],
      schedules: [emi({ id: 'p1', installmentNumber: 1, dueDate: '2026-06-28', status: 'paid' }), emi()],
      committees: [committee], templates: [tpl()],
    }));
    expect(result.fixedParts).toEqual({ emi: 10000, kameti: 5000, recurring: 3500 });
    expect(result.flexTotal).toBe(81500);
  });

  it('a weekly template counts every occurrence remaining in the month', () => {
    // Jul 25 weekly → Jul 25 only? No: 25 (then Aug 1 stops). Start earlier:
    const result = computeFlexBudget(inputs({ templates: [tpl({ cadence: 'weekly', nextDueDate: '2026-07-03', amount: 400 })] }));
    // Jul 3, 10, 17, 24, 31 = 5 occurrences.
    expect(result.fixedParts.recurring).toBe(2000);
  });

  it('flexSpent excludes recurring expansions (already inside fixed) — no double subtraction', () => {
    const result = computeFlexBudget(inputs({
      transactions: [
        expense({ amount: 4000 }),
        expense({ amount: 3500, notes: buildInternalNote('', { recurringExpansion: 'r1@2026-07-01' }) }),
        expense({ amount: 999, createdAt: '2026-06-15T12:00:00' }), // last month
        expense({ amount: 50, currency: 'AED' }), // other currency
      ],
    }));
    expect(result.flexSpent).toBe(4000);
  });

  it('GIVEN-loan EMIs (money coming back) never reduce flex; paid/settled/other-currency excluded', () => {
    const result = computeFlexBudget(inputs({
      loans: [
        loan(), loan({ id: 'g', type: 'given' }), loan({ id: 's', status: 'settled' }),
      ],
      schedules: [
        emi({ id: 'a', status: 'paid' }),
        emi({ id: 'b', loanId: 'g' }),
        emi({ id: 'c', loanId: 's' }),
        emi({ id: 'd', dueDate: '2026-08-05' }),
      ],
    }));
    expect(result.fixedParts.emi).toBe(0);
  });

  it('an ALREADY-POSTED recurring expansion still counts as fixed — never vanishes from the equation', () => {
    // Rent posted on the 1st: nextDueDate advanced to next month, and
    // flexSpent excludes the expansion row. Without the posted-expansion
    // term, 25,000 would disappear and "bacha" would lie by that much.
    const result = computeFlexBudget(inputs({
      templates: [tpl({ nextDueDate: '2026-08-01', amount: 25000, label: 'Rent' })],
      transactions: [
        expense({ amount: 25000, notes: buildInternalNote('', { recurringExpansion: 'r1@2026-07-01' }), createdAt: '2026-07-01T12:00:00' }),
      ],
    }));
    expect(result.fixedParts.recurring).toBe(25000);
    expect(result.flexSpent).toBe(0);
    expect(result.remaining).toBe(75000);
  });

  it('an EMI already PAID this month still counts as fixed via its repayment row', () => {
    const result = computeFlexBudget(inputs({
      loans: [loan()],
      schedules: [emi({ status: 'paid' })],
      transactions: [
        {
          ...expense({ amount: 10000, createdAt: '2026-07-05T12:00:00' }),
          type: 'repayment',
          relatedLoanId: 'l1',
          category: '',
        } as Transaction,
      ],
    }));
    expect(result.fixedParts.emi).toBe(10000);
    expect(result.flexSpent).toBe(0);
  });

  it('a PARTIAL repayment never counts twice: instalment shrinks to its uncovered remainder', () => {
    // 10,000 EMI due this month; 4,000 partial paid Jul 5 → schedule stays
    // 'upcoming' (emiCoverage flips only on full cover). fixed must be
    // 6,000 (still owed) + 4,000 (already paid) = 10,000 — never 14,000.
    const result = computeFlexBudget(inputs({
      loans: [loan({ totalAmount: 10000, remainingAmount: 6000 })],
      schedules: [emi({ installmentNumber: 1, amount: 10000 })],
      transactions: [
        { ...expense({ amount: 4000, createdAt: '2026-07-05T12:00:00' }), type: 'repayment', relatedLoanId: 'l1', category: '' } as Transaction,
      ],
    }));
    expect(result.fixedParts.emi).toBe(10000);
  });

  it('an unpaid instalment from an EARLIER month is still owed — arrears stay in fixed', () => {
    const result = computeFlexBudget(inputs({
      loans: [loan({ totalAmount: 30000, remainingAmount: 30000 })],
      schedules: [emi({ installmentNumber: 1, dueDate: '2026-06-15', amount: 5000 })],
    }));
    expect(result.fixedParts.emi).toBe(5000);
  });

  it('a template stuck in a PAST month still contributes this month\'s occurrences', () => {
    // Missed June prompt: nextDueDate 2026-06-28. July\'s own rent must not
    // vanish from fixed while the To-do tab calls the template overdue.
    const result = computeFlexBudget(inputs({
      templates: [tpl({ nextDueDate: '2026-06-28', amount: 30000, label: 'Rent' })],
    }));
    expect(result.fixedParts.recurring).toBe(30000);
  });

  it('"settle — no money moved" write-offs are forgiveness, not spending', () => {
    const result = computeFlexBudget(inputs({
      loans: [loan({ totalAmount: 50000, remainingAmount: 0, status: 'settled' })],
      transactions: [
        {
          ...expense({ amount: 50000, createdAt: '2026-07-06T12:00:00' }),
          type: 'repayment',
          relatedLoanId: 'l1',
          category: '',
          notes: buildInternalNote('Settled — no money moved', { writeOff: '1' }),
        } as Transaction,
      ],
    }));
    expect(result.fixedParts.emi).toBe(0);
    expect(result.remaining).toBe(100000);
  });

  it('traffic light: red at zero, yellow under 20% of flex, green otherwise', () => {
    expect(computeFlexBudget(inputs({ transactions: [expense({ amount: 100000 })] })).state).toBe('red');
    expect(computeFlexBudget(inputs({ transactions: [expense({ amount: 85000 })] })).state).toBe('yellow');
    expect(computeFlexBudget(inputs({ transactions: [expense({ amount: 40000 })] })).state).toBe('green');
  });
});
