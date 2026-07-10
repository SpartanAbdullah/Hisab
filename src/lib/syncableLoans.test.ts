import { describe, it, expect } from 'vitest';
import { alreadySharedLoanIds, syncCandidateLoans } from './syncableLoans';
import type { Loan, LinkedRequest } from '../db';

function loan(over: Partial<Loan> = {}): Loan {
  return {
    id: 'loan-1',
    personName: 'Ali',
    personId: 'person-1',
    type: 'given',
    totalAmount: 1000,
    remainingAmount: 1000,
    currency: 'AED',
    status: 'active',
    notes: '',
    createdAt: '2026-01-01T00:00:00.000Z',
    loanPairId: null,
    ...over,
  };
}

function req(over: Partial<LinkedRequest> = {}): LinkedRequest {
  return {
    id: 'req-1',
    fromUserId: 'me',
    toUserId: 'them',
    personId: 'person-1',
    kind: 'lent',
    amount: 1000,
    currency: 'AED',
    note: '',
    status: 'pending',
    rejectionReason: null,
    requesterLoanId: null,
    responderLoanId: null,
    requesterTxnId: null,
    responderTxnId: null,
    loanPairId: null,
    preExistingLoanId: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    respondedAt: null,
    ...over,
  };
}

describe('alreadySharedLoanIds', () => {
  it('blocks loans referenced by a live request via any of the three link fields', () => {
    const ids = alreadySharedLoanIds([
      req({ id: 'a', preExistingLoanId: 'L1' }),
      req({ id: 'b', requesterLoanId: 'L2', status: 'accepted' }),
      req({ id: 'c', responderLoanId: 'L3', status: 'accepted' }),
    ]);
    expect(ids).toEqual(new Set(['L1', 'L2', 'L3']));
  });

  it('frees the slot for cancelled / rejected requests so the user can retry', () => {
    const ids = alreadySharedLoanIds([
      req({ id: 'a', preExistingLoanId: 'L1', status: 'cancelled' }),
      req({ id: 'b', preExistingLoanId: 'L2', status: 'rejected' }),
    ]);
    expect(ids.size).toBe(0);
  });
});

describe('syncCandidateLoans', () => {
  it('offers a plain unsynced, unlinked, active loan', () => {
    const loans = [loan({ id: 'L1' })];
    expect(syncCandidateLoans('person-1', loans, []).map((l) => l.id)).toEqual(['L1']);
  });

  it('does NOT re-offer a loan already sent via a pending sync request', () => {
    const loans = [loan({ id: 'L1' })];
    const requests = [req({ preExistingLoanId: 'L1', status: 'pending' })];
    expect(syncCandidateLoans('person-1', loans, requests)).toEqual([]);
  });

  it('does NOT re-offer a loan whose sync request was accepted', () => {
    const loans = [loan({ id: 'L1' })];
    const requests = [req({ preExistingLoanId: 'L1', status: 'accepted' })];
    expect(syncCandidateLoans('person-1', loans, requests)).toEqual([]);
  });

  // The core "ambiguous for both users" bug: the recipient's freshly-mirrored
  // loan is referenced by the accepted request via responderLoanId (NOT
  // preExistingLoanId), so the old code re-offered it → a ping-pong sync.
  it('does NOT offer the recipient mirrored copy (accepted responderLoanId)', () => {
    const mirror = loan({ id: 'MIRROR', personId: 'person-1' });
    const requests = [req({ status: 'accepted', responderLoanId: 'MIRROR', preExistingLoanId: null })];
    expect(syncCandidateLoans('person-1', [mirror], requests)).toEqual([]);
  });

  it('does NOT offer a loan linked via the normal fresh-loan branch (requesterLoanId)', () => {
    const loans = [loan({ id: 'L1' })];
    const requests = [req({ status: 'accepted', requesterLoanId: 'L1', preExistingLoanId: null })];
    expect(syncCandidateLoans('person-1', loans, requests)).toEqual([]);
  });

  it('does NOT offer an already-linked loan (loanPairId set)', () => {
    const loans = [loan({ id: 'L1', loanPairId: 'pair-1' })];
    expect(syncCandidateLoans('person-1', loans, [])).toEqual([]);
  });

  it('re-offers a loan after its sync request was rejected', () => {
    const loans = [loan({ id: 'L1' })];
    const requests = [req({ preExistingLoanId: 'L1', status: 'rejected' })];
    expect(syncCandidateLoans('person-1', loans, requests).map((l) => l.id)).toEqual(['L1']);
  });

  it('excludes settled loans, zero-balance loans, and other people', () => {
    const loans = [
      loan({ id: 'settled', status: 'settled' }),
      loan({ id: 'zero', remainingAmount: 0 }),
      loan({ id: 'other', personId: 'person-2' }),
      loan({ id: 'keep' }),
    ];
    expect(syncCandidateLoans('person-1', loans, []).map((l) => l.id)).toEqual(['keep']);
  });
});
