import { describe, expect, it, vi } from 'vitest';
import { executeAllocatedRepayments, type RepaymentExecDeps, type RepaymentTransactionInput } from './repaymentExecution';

function deps(over: Partial<RepaymentExecDeps> = {}): RepaymentExecDeps & {
  processTransaction: ReturnType<typeof vi.fn>;
  applyRepayment: ReturnType<typeof vi.fn>;
} {
  return {
    mode: 'tracker',
    direction: 'given',
    accountId: 'acc1',
    processTransaction: vi.fn().mockResolvedValue({}),
    applyRepayment: vi.fn().mockResolvedValue(undefined),
    ...over,
  } as never;
}

const items = [
  { loanId: 'l1', amount: 100 },
  { loanId: 'l2', amount: 200 },
  { loanId: 'l3', amount: 150.5 },
];

describe('executeAllocatedRepayments — tracker mode', () => {
  it('given direction: money lands in the account (destination), never source', async () => {
    const d = deps();
    const result = await executeAllocatedRepayments(items, d);
    expect(result.done).toBe(3);
    expect(result.totalApplied).toBe(450.5);
    expect(result.failed).toBeUndefined();
    expect(d.processTransaction).toHaveBeenCalledTimes(3);
    for (const call of d.processTransaction.mock.calls) {
      const input = call[0] as RepaymentTransactionInput;
      expect(input.type).toBe('repayment');
      expect(input.destinationAccountId).toBe('acc1');
      expect(input.sourceAccountId).toBeUndefined();
    }
    expect(d.applyRepayment).not.toHaveBeenCalled();
  });

  it('taken direction: money leaves the account (source), never destination', async () => {
    const d = deps({ direction: 'taken' });
    await executeAllocatedRepayments(items, d);
    for (const call of d.processTransaction.mock.calls) {
      const input = call[0] as RepaymentTransactionInput;
      expect(input.sourceAccountId).toBe('acc1');
      expect(input.destinationAccountId).toBeUndefined();
    }
  });

  it('passes conversionRate, notes and per-loan emiId through', async () => {
    const d = deps({ conversionRate: 76.5, notes: 'Eid repayment', emiIdByLoan: { l2: 'emi9' } });
    await executeAllocatedRepayments(items, d);
    const inputs = d.processTransaction.mock.calls.map((c) => c[0] as RepaymentTransactionInput);
    expect(inputs.every((i) => i.conversionRate === 76.5 && i.notes === 'Eid repayment')).toBe(true);
    expect(inputs.find((i) => i.loanId === 'l2')?.emiId).toBe('emi9');
    expect(inputs.find((i) => i.loanId === 'l1')?.emiId).toBeUndefined();
  });
});

describe('executeAllocatedRepayments — splits_only mode', () => {
  it('routes through applyRepayment only, threading the notes through', async () => {
    const d = deps({ mode: 'splits_only', notes: 'Eid lump' });
    const result = await executeAllocatedRepayments(items, d);
    expect(result.done).toBe(3);
    expect(d.applyRepayment.mock.calls).toEqual([
      ['l1', 100, 'Eid lump'],
      ['l2', 200, 'Eid lump'],
      ['l3', 150.5, 'Eid lump'],
    ]);
    expect(d.processTransaction).not.toHaveBeenCalled();
  });

  it('passes undefined notes when none given', async () => {
    const d = deps({ mode: 'splits_only' });
    await executeAllocatedRepayments([items[0]], d);
    expect(d.applyRepayment).toHaveBeenCalledWith('l1', 100, undefined);
  });
});

describe('executeAllocatedRepayments — failure semantics', () => {
  it('stops at the first failure, keeps the committed prefix, never throws', async () => {
    const boom = new Error('BALANCE_CONFLICT');
    const d = deps();
    d.processTransaction
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(boom);
    const result = await executeAllocatedRepayments(items, d);
    expect(result.done).toBe(1);
    expect(result.applied).toEqual([{ loanId: 'l1', amount: 100 }]);
    expect(result.failed?.item).toEqual({ loanId: 'l2', amount: 200 });
    expect(result.failed?.error).toBe(boom);
    expect(result.totalApplied).toBe(100);
    // l3 must never be attempted after l2 failed.
    expect(d.processTransaction).toHaveBeenCalledTimes(2);
  });

  it('failure on the very first item reports done 0', async () => {
    const d = deps({ mode: 'splits_only' });
    d.applyRepayment.mockRejectedValue(new Error('offline'));
    const result = await executeAllocatedRepayments(items, d);
    expect(result.done).toBe(0);
    expect(result.applied).toEqual([]);
    expect(result.totalApplied).toBe(0);
    expect(d.applyRepayment).toHaveBeenCalledTimes(1);
  });

  it('empty items → zero calls, clean result', async () => {
    const d = deps();
    const result = await executeAllocatedRepayments([], d);
    expect(result).toEqual({ total: 0, done: 0, applied: [], totalApplied: 0 });
    expect(d.processTransaction).not.toHaveBeenCalled();
  });

  it('rounds totalApplied to 2 dp', async () => {
    const d = deps({ mode: 'splits_only' });
    const result = await executeAllocatedRepayments(
      [
        { loanId: 'a', amount: 33.33 },
        { loanId: 'b', amount: 33.34 },
      ],
      d,
    );
    expect(result.totalApplied).toBe(66.67);
  });
});
