import { describe, expect, it } from 'vitest';
import type { Loan } from '../db';
import {
  isLinkedLoan,
  assertLinkedLoanEditAllowed,
  assertLinkedLoanDeleteAllowed,
} from './linkedLoanGuards';

function loan(over: Partial<Loan> = {}): Loan {
  return {
    id: 'l1',
    personName: 'Ali',
    personId: 'p1',
    type: 'given',
    totalAmount: 500,
    remainingAmount: 500,
    currency: 'AED',
    status: 'active',
    notes: '',
    createdAt: '2026-06-01T00:00:00Z',
    loanPairId: 'pair-1',
    ...over,
  } as Loan;
}

describe('isLinkedLoan', () => {
  it('is true when a pair id is present', () => {
    expect(isLinkedLoan(loan())).toBe(true);
  });
  it('is false for a local-only loan', () => {
    expect(isLinkedLoan(loan({ loanPairId: null }))).toBe(false);
  });
});

describe('assertLinkedLoanEditAllowed', () => {
  it('blocks a currency change on an active linked loan', () => {
    expect(() => assertLinkedLoanEditAllowed(loan(), { currency: 'PKR' })).toThrow(/linked/i);
  });
  it('blocks a totalAmount change on an active linked loan', () => {
    expect(() => assertLinkedLoanEditAllowed(loan(), { totalAmount: 600 })).toThrow(/linked/i);
  });
  it('allows the same currency (no actual change)', () => {
    expect(() => assertLinkedLoanEditAllowed(loan(), { currency: 'AED' })).not.toThrow();
  });
  it('allows edits on a non-linked loan', () => {
    expect(() => assertLinkedLoanEditAllowed(loan({ loanPairId: null }), { currency: 'PKR' })).not.toThrow();
  });
  it('allows edits once the linked loan is settled (not active)', () => {
    expect(() => assertLinkedLoanEditAllowed(loan({ status: 'settled' }), { currency: 'PKR' })).not.toThrow();
  });
  it('does not block unrelated changes (no currency/amount in the patch)', () => {
    expect(() => assertLinkedLoanEditAllowed(loan(), {})).not.toThrow();
  });
});

describe('assertLinkedLoanDeleteAllowed', () => {
  it('blocks deleting an active linked loan', () => {
    expect(() => assertLinkedLoanDeleteAllowed(loan())).toThrow(/linked/i);
  });
  it('allows deleting a settled linked loan', () => {
    expect(() => assertLinkedLoanDeleteAllowed(loan({ status: 'settled' }))).not.toThrow();
  });
  it('allows deleting a local-only loan', () => {
    expect(() => assertLinkedLoanDeleteAllowed(loan({ loanPairId: null }))).not.toThrow();
  });
});
