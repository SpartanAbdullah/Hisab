import { describe, expect, it } from 'vitest';
import { computeTrustScore, trustLevelStyle } from './trustScore';
import type { Loan, Transaction } from '../db';

function loan(overrides: Partial<Loan> = {}): Loan {
  return {
    id: 'loan-1',
    personName: 'Bilal',
    personId: 'p-1',
    type: 'given',
    totalAmount: 100,
    remainingAmount: 0,
    currency: 'AED',
    status: 'settled',
    notes: '',
    createdAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function repayment(loanId: string, createdAt: string): Transaction {
  return {
    id: `tx-${loanId}-${createdAt}`,
    type: 'repayment',
    amount: 100,
    currency: 'AED',
    sourceAccountId: null,
    destinationAccountId: null,
    relatedPerson: null,
    personId: null,
    relatedLoanId: loanId,
    relatedGoalId: null,
    conversionRate: null,
    category: '',
    notes: '',
    createdAt,
  };
}

describe('computeTrustScore', () => {
  it('returns empty for null personId', () => {
    const score = computeTrustScore(null, 'Bilal', [], []);
    expect(score.totalLoans).toBe(0);
    expect(score.level).toBe('new');
  });

  it('returns empty when no loans match the person', () => {
    const score = computeTrustScore('p-1', 'Bilal', [loan({ personId: 'p-2' })], []);
    expect(score.totalLoans).toBe(0);
    expect(score.level).toBe('new');
  });

  it('classifies a single settled loan as "building"', () => {
    const score = computeTrustScore(
      'p-1',
      'Bilal',
      [loan({ id: 'l1', status: 'settled' })],
      [repayment('l1', '2026-01-15T00:00:00Z')],
    );
    expect(score.totalLoans).toBe(1);
    expect(score.settledLoans).toBe(1);
    expect(score.level).toBe('building');
    expect(score.avgDaysToSettle).toBe(14);
  });

  it('classifies 3+ settled loans with fast settlement as "rock_solid"', () => {
    const loans = [
      loan({ id: 'l1', status: 'settled', createdAt: '2026-01-01T00:00:00Z' }),
      loan({ id: 'l2', status: 'settled', createdAt: '2026-02-01T00:00:00Z' }),
      loan({ id: 'l3', status: 'settled', createdAt: '2026-03-01T00:00:00Z' }),
    ];
    const txns = [
      repayment('l1', '2026-01-10T00:00:00Z'), // 9 days
      repayment('l2', '2026-02-08T00:00:00Z'), // 7 days
      repayment('l3', '2026-03-12T00:00:00Z'), // 11 days
    ];
    const score = computeTrustScore('p-1', 'Bilal', loans, txns);
    expect(score.settledLoans).toBe(3);
    expect(score.settlementRatio).toBe(1);
    expect(score.avgDaysToSettle).toBe(9);
    expect(score.level).toBe('rock_solid');
  });

  it('classifies slow settlement as "reliable" not "rock_solid"', () => {
    const loans = [
      loan({ id: 'l1', status: 'settled', createdAt: '2026-01-01T00:00:00Z' }),
      loan({ id: 'l2', status: 'settled', createdAt: '2026-02-01T00:00:00Z' }),
      loan({ id: 'l3', status: 'settled', createdAt: '2026-03-01T00:00:00Z' }),
    ];
    // Each loan takes ~45 days to settle — too slow for rock-solid.
    const txns = [
      repayment('l1', '2026-02-15T00:00:00Z'),
      repayment('l2', '2026-03-18T00:00:00Z'),
      repayment('l3', '2026-04-15T00:00:00Z'),
    ];
    const score = computeTrustScore('p-1', 'Bilal', loans, txns);
    expect(score.level).toBe('reliable');
  });

  it('uses the latest repayment as the settlement date', () => {
    // Two repayments on the same loan; the later one is the settlement.
    const score = computeTrustScore(
      'p-1',
      'Bilal',
      [loan({ id: 'l1', createdAt: '2026-01-01T00:00:00Z' })],
      [
        repayment('l1', '2026-01-05T00:00:00Z'),
        repayment('l1', '2026-01-20T00:00:00Z'),
      ],
    );
    expect(score.avgDaysToSettle).toBe(19);
  });

  it('flags hasOpenBalance when any active loan exists', () => {
    const score = computeTrustScore(
      'p-1',
      'Bilal',
      [
        loan({ id: 'l1', status: 'settled' }),
        loan({ id: 'l2', status: 'active', remainingAmount: 50 }),
      ],
      [],
    );
    expect(score.hasOpenBalance).toBe(true);
    expect(score.activeLoans).toBe(1);
  });

  it('handles settled loan with no repayment txn (legacy data) gracefully', () => {
    const score = computeTrustScore(
      'p-1',
      'Bilal',
      [loan({ id: 'l1', status: 'settled' })],
      [],
    );
    expect(score.settledLoans).toBe(1);
    expect(score.avgDaysToSettle).toBe(null);
  });
});

describe('trustLevelStyle', () => {
  it('returns distinct labels for every level', () => {
    const labels = new Set([
      trustLevelStyle('new').label,
      trustLevelStyle('building').label,
      trustLevelStyle('reliable').label,
      trustLevelStyle('rock_solid').label,
    ]);
    expect(labels.size).toBe(4);
  });
});
