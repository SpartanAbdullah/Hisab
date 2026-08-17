import { describe, expect, it, vi } from 'vitest';
import { executeSplitEvent, splitAccountImpact } from './splitEvent';
import { parseInternalNote } from './internalNotes';
import type { SplitEventDeps, SplitEventInput } from './splitEvent';

function makeDeps(overrides: Partial<SplitEventDeps> = {}) {
  const processTransaction = vi.fn().mockResolvedValue({ id: 'tx' });
  const createLoan = vi.fn().mockResolvedValue({ id: 'loan' });
  return {
    processTransaction,
    createLoan,
    ...overrides,
  } as SplitEventDeps & { processTransaction: typeof processTransaction; createLoan: typeof createLoan };
}

const BASE: SplitEventInput = {
  label: 'Friday lunch',
  category: 'Food',
  mode: 'tracker',
  direction: 'i_paid',
  currency: 'AED',
  myShare: 400,
  others: [
    { personId: 'p-ali', personName: 'Ali', amount: 400 },
    { personId: 'p-sara', personName: 'Sara', amount: 400 },
  ],
  accountId: 'acc-1',
};

describe('splitAccountImpact', () => {
  it('is the FULL bill when I paid in tracker mode', () => {
    expect(splitAccountImpact(BASE)).toBe(1200);
  });

  it('is zero when someone else paid — no money left my wallet', () => {
    expect(splitAccountImpact({ ...BASE, direction: 'they_paid' })).toBe(0);
  });

  it('is zero in splits_only mode — there are no accounts', () => {
    expect(splitAccountImpact({ ...BASE, mode: 'splits_only' })).toBe(0);
  });
});

describe('executeSplitEvent — I paid, tracker mode', () => {
  it('debits the account the full bill, but books only my share as spending', async () => {
    const deps = makeDeps();
    const result = await executeSplitEvent(BASE, deps);

    expect(result.done).toBe(3);
    expect(result.total).toBe(3);
    expect(result.failed).toBeUndefined();

    const calls = deps.processTransaction.mock.calls.map((c) => c[0]);
    const debited = calls.reduce((sum, c) => sum + c.amount, 0);
    expect(debited).toBe(1200);

    const expenses = calls.filter((c) => c.type === 'expense');
    expect(expenses).toHaveLength(1);
    expect(expenses[0].amount).toBe(400);

    const loans = calls.filter((c) => c.type === 'loan_given');
    expect(loans.map((l) => l.amount)).toEqual([400, 400]);
    expect(loans.map((l) => l.personName)).toEqual(['Ali', 'Sara']);
    expect(loans.map((l) => l.personId)).toEqual(['p-ali', 'p-sara']);
  });

  it('every row carries the same splitEventId so the ledger can group them', async () => {
    const deps = makeDeps();
    const result = await executeSplitEvent(BASE, deps);

    const metas = deps.processTransaction.mock.calls.map((c) => parseInternalNote(c[0].notes).meta);
    expect(metas).toHaveLength(3);
    for (const meta of metas) {
      expect(meta.splitEventId).toBe(result.splitEventId);
      expect(meta.splitLabel).toBe('Friday lunch');
      expect(meta.splitPartyCount).toBe('3');
    }
  });

  it('keeps the user note readable alongside the meta blob', async () => {
    const deps = makeDeps();
    await executeSplitEvent({ ...BASE, notes: 'tip included' }, deps);
    const parsed = parseInternalNote(deps.processTransaction.mock.calls[0][0].notes);
    expect(parsed.visibleNote).toBe('tip included');
    expect(parsed.meta.splitLabel).toBe('Friday lunch');
  });

  it('commits receivables BEFORE my own share', async () => {
    const deps = makeDeps();
    await executeSplitEvent(BASE, deps);
    const types = deps.processTransaction.mock.calls.map((c) => c[0].type);
    expect(types).toEqual(['loan_given', 'loan_given', 'expense']);
  });

  it('skips the expense row when my share is zero (I paid, ate nothing)', async () => {
    const deps = makeDeps();
    const result = await executeSplitEvent({ ...BASE, myShare: 0 }, deps);
    expect(result.total).toBe(2);
    expect(deps.processTransaction.mock.calls.every((c) => c[0].type === 'loan_given')).toBe(true);
  });

  it('refuses to run without an account in tracker mode', async () => {
    await expect(
      executeSplitEvent({ ...BASE, accountId: undefined }, makeDeps()),
    ).rejects.toThrow(/account is required/i);
  });
});

describe('executeSplitEvent — partial failure', () => {
  it('keeps the committed prefix and reports how far it got', async () => {
    const processTransaction = vi.fn()
      .mockResolvedValueOnce({ id: 'tx1' })
      .mockRejectedValueOnce(new Error('Insufficient balance'));
    const deps = makeDeps({ processTransaction });

    const result = await executeSplitEvent(BASE, deps);

    expect(result.done).toBe(1);
    expect(result.total).toBe(3);
    expect(result.committed.map((s) => s.label)).toEqual(['Ali']);
    expect(result.failed?.step.label).toBe('Sara');
    expect((result.failed?.error as Error).message).toBe('Insufficient balance');
  });

  it('loses my own share rather than a receivable when the account runs dry', async () => {
    // Third call is the payer's own expense — the recoverable row.
    const processTransaction = vi.fn()
      .mockResolvedValueOnce({ id: 'tx1' })
      .mockResolvedValueOnce({ id: 'tx2' })
      .mockRejectedValueOnce(new Error('Insufficient balance'));
    const deps = makeDeps({ processTransaction });

    const result = await executeSplitEvent(BASE, deps);

    expect(result.committed.map((s) => s.kind)).toEqual(['receivable', 'receivable']);
    expect(result.failed?.step.kind).toBe('my_share');
  });
});

describe('executeSplitEvent — they paid', () => {
  const theyPaid: SplitEventInput = {
    ...BASE,
    direction: 'they_paid',
    myShare: 400,
    others: [],
    payer: { personId: 'p-ali', personName: 'Ali' },
  };

  it('records one taken loan and touches no account', async () => {
    const deps = makeDeps();
    const result = await executeSplitEvent(theyPaid, deps);

    expect(result.done).toBe(1);
    expect(deps.processTransaction).not.toHaveBeenCalled();
    expect(deps.createLoan).toHaveBeenCalledTimes(1);
    expect(deps.createLoan.mock.calls[0][0]).toMatchObject({
      type: 'taken',
      totalAmount: 400,
      personName: 'Ali',
      personId: 'p-ali',
      currency: 'AED',
    });
  });

  it('never writes the meta blob into Loan.notes — it is rendered raw', async () => {
    const deps = makeDeps();
    await executeSplitEvent({ ...theyPaid, notes: 'tip included' }, deps);
    const notes = deps.createLoan.mock.calls[0][0].notes as string;
    expect(notes).not.toContain('HISAAB_META');
    expect(notes).toContain('Friday lunch');
    expect(notes).toContain('tip included');
  });

  it('requires a payer', async () => {
    await expect(
      executeSplitEvent({ ...theyPaid, payer: undefined }, makeDeps()),
    ).rejects.toThrow(/payer is required/i);
  });

  it('surfaces a failure instead of reporting success', async () => {
    const createLoan = vi.fn().mockRejectedValue(new Error('offline'));
    const result = await executeSplitEvent(theyPaid, makeDeps({ createLoan }));
    expect(result.done).toBe(0);
    expect(result.failed?.step.kind).toBe('payable');
  });
});

describe('executeSplitEvent — splits_only mode', () => {
  it('writes loans only, with no expense row and no account', async () => {
    const deps = makeDeps();
    const result = await executeSplitEvent(
      { ...BASE, mode: 'splits_only', accountId: undefined },
      deps,
    );

    expect(result.done).toBe(2);
    expect(deps.processTransaction).not.toHaveBeenCalled();
    expect(deps.createLoan).toHaveBeenCalledTimes(2);
    for (const [call] of deps.createLoan.mock.calls) {
      expect(call.type).toBe('given');
      expect(call.amount).toBeUndefined();
      expect(call.notes).not.toContain('HISAAB_META');
    }
    expect(deps.createLoan.mock.calls.map(([c]) => c.totalAmount)).toEqual([400, 400]);
  });
});
