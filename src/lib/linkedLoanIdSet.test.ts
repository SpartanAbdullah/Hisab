import { describe, expect, it } from 'vitest';
import { linkedLoanIdSet } from './linkedLoanIdSet';

describe('linkedLoanIdSet', () => {
  it('collects both requester and responder loan ids from accepted requests', () => {
    const ids = linkedLoanIdSet([
      { status: 'accepted', requesterLoanId: 'r1', responderLoanId: 'r2' },
    ]);
    expect(ids).toEqual(new Set(['r1', 'r2']));
  });

  it('ignores pending / rejected / cancelled requests', () => {
    const ids = linkedLoanIdSet([
      { status: 'pending', requesterLoanId: 'a', responderLoanId: 'b' },
      { status: 'rejected', requesterLoanId: 'c', responderLoanId: 'd' },
      { status: 'cancelled', requesterLoanId: 'e', responderLoanId: 'f' },
    ]);
    expect(ids.size).toBe(0);
  });

  it('is null-safe on missing loan ids', () => {
    const ids = linkedLoanIdSet([
      { status: 'accepted', requesterLoanId: null, responderLoanId: 'only' },
      { status: 'accepted' },
    ]);
    expect(ids).toEqual(new Set(['only']));
  });
});
