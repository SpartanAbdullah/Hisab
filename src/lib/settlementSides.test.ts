import { describe, expect, it } from 'vitest';
import { resolveSettlementSides } from './settlementSides';

const base = { fromUserId: 'me', toUserId: 'them' };

describe('resolveSettlementSides', () => {
  it('maps sides when my loan is the original requester side', () => {
    const sides = resolveSettlementSides('myLoan', [
      { id: 'pair1', status: 'accepted', requesterLoanId: 'myLoan', responderLoanId: 'theirLoan', ...base },
    ]);
    expect(sides).toEqual({
      loanPairId: 'pair1',
      requesterLoanId: 'myLoan',
      responderLoanId: 'theirLoan',
      toUserId: 'them',
    });
  });

  it('maps sides when my loan is the original responder side (counterparty flips)', () => {
    const sides = resolveSettlementSides('myLoan', [
      { id: 'pair1', status: 'accepted', requesterLoanId: 'theirLoan', responderLoanId: 'myLoan', ...base },
    ]);
    expect(sides).toEqual({
      loanPairId: 'pair1',
      requesterLoanId: 'myLoan',
      responderLoanId: 'theirLoan',
      toUserId: 'me', // original sender is the counterparty now
    });
  });

  it('ignores non-accepted pairs', () => {
    const sides = resolveSettlementSides('myLoan', [
      { id: 'pair1', status: 'pending', requesterLoanId: 'myLoan', responderLoanId: 'theirLoan', ...base },
    ]);
    expect(sides).toBeNull();
  });

  it('returns null when either mirrored id is missing', () => {
    const sides = resolveSettlementSides('myLoan', [
      { id: 'pair1', status: 'accepted', requesterLoanId: 'myLoan', responderLoanId: null, ...base },
    ]);
    expect(sides).toBeNull();
  });

  it('returns null for an unlinked loan', () => {
    expect(resolveSettlementSides('lonely', [])).toBeNull();
  });
});
