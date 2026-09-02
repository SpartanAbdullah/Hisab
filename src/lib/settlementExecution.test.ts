import { describe, expect, it, vi } from 'vitest';
import { executeAllocatedSettlements, type SettlementExecDeps, type SettlementRequestInput } from './settlementExecution';

const sides = {
  l1: { loanPairId: 'p1', requesterLoanId: 'l1', responderLoanId: 'r1', toUserId: 'them' },
  l2: { loanPairId: 'p2', requesterLoanId: 'l2', responderLoanId: 'r2', toUserId: 'them' },
};

function deps(over: Partial<SettlementExecDeps> = {}): SettlementExecDeps & { createRequest: ReturnType<typeof vi.fn> } {
  return {
    currency: 'AED',
    sidesByLoan: sides,
    createRequest: vi.fn().mockResolvedValue({}),
    ...over,
  } as never;
}

const items = [
  { loanId: 'l1', amount: 100.5 },
  { loanId: 'l2', amount: 200 },
];

describe('executeAllocatedSettlements', () => {
  it('sends one request per allocation with the pair sides and shared fields', async () => {
    const d = deps({ note: 'Eid lump', requesterAccountId: 'acc9' });
    const result = await executeAllocatedSettlements(items, d);
    expect(result).toMatchObject({ total: 2, done: 2, totalRequested: 300.5 });
    expect(result.failed).toBeUndefined();
    const inputs = d.createRequest.mock.calls.map((c) => c[0] as SettlementRequestInput);
    expect(inputs[0]).toEqual({
      loanPairId: 'p1', requesterLoanId: 'l1', responderLoanId: 'r1', toUserId: 'them',
      amount: 100.5, currency: 'AED', note: 'Eid lump', requesterAccountId: 'acc9',
    });
    expect(inputs[1].loanPairId).toBe('p2');
  });

  it('stamps a per-loan idempotency id when requestIdFor is supplied', async () => {
    const d = deps({ requestIdFor: (loanId) => `intent-7:${loanId}` });
    await executeAllocatedSettlements(items, d);
    const inputs = d.createRequest.mock.calls.map((c) => c[0] as SettlementRequestInput);
    expect(inputs.map((i) => i.requestId)).toEqual(['intent-7:l1', 'intent-7:l2']);
  });

  it('leaves requestId undefined when no id source is supplied (store mints a uuid)', async () => {
    const d = deps();
    await executeAllocatedSettlements([items[0]], d);
    expect((d.createRequest.mock.calls[0][0] as SettlementRequestInput).requestId).toBeUndefined();
  });

  it('defaults requesterAccountId to null (ledger-only request)', async () => {
    const d = deps();
    await executeAllocatedSettlements([items[0]], d);
    expect((d.createRequest.mock.calls[0][0] as SettlementRequestInput).requesterAccountId).toBeNull();
  });

  it('stops at the first failure and reports the sent prefix', async () => {
    const boom = new Error('offline');
    const d = deps();
    d.createRequest.mockResolvedValueOnce({}).mockRejectedValueOnce(boom);
    const result = await executeAllocatedSettlements(items, d);
    expect(result.done).toBe(1);
    expect(result.sent).toEqual([{ loanId: 'l1', amount: 100.5 }]);
    expect(result.failed?.error).toBe(boom);
    expect(result.totalRequested).toBe(100.5);
  });

  it('fails cleanly when a loan has no resolved pair', async () => {
    const d = deps({ sidesByLoan: { l1: sides.l1 } });
    const result = await executeAllocatedSettlements(items, d);
    expect(result.done).toBe(1);
    expect(result.failed?.item.loanId).toBe('l2');
    expect(d.createRequest).toHaveBeenCalledTimes(1);
  });

  it('empty items → clean zero result', async () => {
    const d = deps();
    const result = await executeAllocatedSettlements([], d);
    expect(result).toEqual({ total: 0, done: 0, sent: [], totalRequested: 0 });
  });
});
