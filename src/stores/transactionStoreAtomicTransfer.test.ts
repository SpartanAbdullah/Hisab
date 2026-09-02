// The L4 pilot: processTransaction's `transfer` branch with
// VITE_ATOMIC_TRANSFER=true, i.e. both balance legs and the transactions row
// committed by ONE server call (`transfer_between_accounts`).
//
// Why a separate file rather than more cases in transactionStore.test.ts:
// `ATOMIC_TRANSFER_ENABLED` is read from import.meta.env at module load, so the
// flag has to be stubbed BEFORE the store is imported — which needs a dynamic
// import, which needs its own module registry. Vitest gives each test file one.
// transactionStore.test.ts therefore keeps proving the legacy path unchanged
// (that is the "byte-for-byte when the flag is off" half of the contract) and
// this file proves the flagged path.
//
// The mock RPC below reproduces supabase-migration-p3-atomic-transfer.sql:
// compare-and-swap on BOTH expected balances, the insufficient-balance guard
// with its allow-negative escape, same/cross-currency destination arithmetic,
// idempotent replay on the transaction id, and — the whole point — all-or-
// nothing: it never applies one leg without the other.
//
// Coverage:
//   1. same-currency transfer moves both legs and writes exactly one row
//   2. the row carries the same shape the legacy path writes
//   3. cross-currency applies the rate to the destination only
//   4. one server call, not two (the half-moved window is gone)
//   5. BALANCE_CONFLICT → refetch + retry once, against server truth
//   6. a second conflict surfaces and nothing moved
//   7. INSUFFICIENT_BALANCE surfaces as the user-facing string
//   8. a failure AFTER the RPC rolls the whole transfer back (inverse)
//   9. a replay moves money once
//  10. paying a card bill still auto-settles its cash advances
//  11. splits_only: a transfer with no accounts is refused, nothing written

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/supabaseDb', async () => {
  const accounts = new Map<string, { id: string; balance: number; name: string; type: string; currency: string; metadata: Record<string, string>; createdAt: string }>();
  const transactions = new Map<string, Record<string, unknown>>();
  const loans = new Map<string, Record<string, unknown>>();
  const emis = new Map<string, Record<string, unknown>>();
  const goals = new Map<string, Record<string, unknown>>();
  const activities = new Map<string, Record<string, unknown>>();

  let nextTxAddThrows: Error | null = null;
  const rpcCalls: Array<Record<string, unknown>> = [];

  const round2 = (n: number) => Math.round(n * 100) / 100;

  return {
    __seedAccount: (a: { id: string; balance: number; name?: string; type?: string; currency?: string; metadata?: Record<string, string> }) => {
      accounts.set(a.id, {
        id: a.id,
        balance: a.balance,
        name: a.name ?? a.id,
        type: a.type ?? 'cash',
        currency: a.currency ?? 'AED',
        metadata: a.metadata ?? {},
        createdAt: new Date().toISOString(),
      });
    },
    __remoteBalanceDelta: (id: string, delta: number) => {
      const cur = accounts.get(id);
      if (cur) accounts.set(id, { ...cur, balance: round2(cur.balance + delta) });
    },
    __failNextTxAdd: (err: Error) => { nextTxAddThrows = err; },
    __rpcCalls: () => rpcCalls,
    __getAccount: (id: string) => accounts.get(id),
    __getTransactions: () => Array.from(transactions.values()),
    __reset: () => {
      accounts.clear(); transactions.clear(); loans.clear();
      emis.clear(); goals.clear(); activities.clear();
      rpcCalls.length = 0;
      nextTxAddThrows = null;
    },

    accountsDb: {
      async getAll() { return Array.from(accounts.values()); },
      async add(a: Record<string, unknown>) { accounts.set(a.id as string, a as never); },
      async update(id: string, changes: Record<string, unknown>) {
        const cur = accounts.get(id);
        if (cur) accounts.set(id, { ...cur, ...changes });
      },
      async applyBalanceDelta(id: string, expectedBalance: number, delta: number) {
        const cur = accounts.get(id);
        if (!cur) throw new Error(`Account ${id} not found`);
        if (cur.balance !== expectedBalance) {
          const err = new Error('BALANCE_CONFLICT') as Error & { code: string };
          err.code = 'BALANCE_CONFLICT';
          throw err;
        }
        const next = round2(cur.balance + delta);
        accounts.set(id, { ...cur, balance: next });
        return next;
      },
      async delete(id: string) { accounts.delete(id); },
    },

    transactionsDb: {
      async getAll() { return Array.from(transactions.values()); },
      async get(id: string) { return transactions.get(id) ?? null; },
      async add(t: Record<string, unknown>) {
        if (nextTxAddThrows) {
          const err = nextTxAddThrows;
          nextTxAddThrows = null;
          throw err;
        }
        transactions.set(t.id as string, t);
      },
      async update(id: string, changes: Record<string, unknown>) {
        const cur = transactions.get(id);
        if (cur) transactions.set(id, { ...cur, ...changes });
      },
      async delete(id: string) { transactions.delete(id); },
    },

    loansDb: {
      async getAll() { return Array.from(loans.values()); },
      async get(id: string) { return loans.get(id) ?? null; },
      async add(l: Record<string, unknown>) { loans.set(l.id as string, l); },
      async update(id: string, changes: Record<string, unknown>) {
        const cur = loans.get(id);
        if (cur) loans.set(id, { ...cur, ...changes });
      },
      async applyRemainingDelta(id: string, expectedRemaining: number, delta: number) {
        const cur = loans.get(id);
        if (!cur) {
          const err = new Error('LOAN_NOT_FOUND') as Error & { code: string };
          err.code = 'LOAN_NOT_FOUND';
          throw err;
        }
        const current = Number(cur.remainingAmount ?? 0);
        if (Math.round(current * 100) !== Math.round(expectedRemaining * 100)) {
          const err = new Error('LOAN_REMAINING_CONFLICT') as Error & { code: string };
          err.code = 'LOAN_REMAINING_CONFLICT';
          throw err;
        }
        const next = round2(Math.max(0, current + delta));
        loans.set(id, { ...cur, remainingAmount: next, status: next === 0 ? 'settled' : 'active' });
        return next;
      },
      async delete(id: string) { loans.delete(id); },
    },

    emiSchedulesDb: {
      async getAll() { return Array.from(emis.values()); },
      async add(e: Record<string, unknown>) { emis.set(e.id as string, e); },
      async update(id: string, changes: Record<string, unknown>) {
        const cur = emis.get(id);
        if (cur) emis.set(id, { ...cur, ...changes });
      },
      async delete(id: string) { emis.delete(id); },
      async deleteByLoan(loanId: string) {
        for (const [id, e] of emis) if ((e as { loanId: string }).loanId === loanId) emis.delete(id);
      },
    },

    goalsDb: {
      async getAll() { return Array.from(goals.values()); },
      async add(g: Record<string, unknown>) { goals.set(g.id as string, g); },
      async update(id: string, changes: Record<string, unknown>) {
        const cur = goals.get(id);
        if (cur) goals.set(id, { ...cur, ...changes });
      },
      async delete(id: string) { goals.delete(id); },
    },

    activitiesDb: {
      async getAll() { return Array.from(activities.values()); },
      async add(a: Record<string, unknown>) { activities.set(a.id as string, a); },
    },

    groupExpensesDb: {
      async get() { return null; },
      async probeExists() { return false; },
    },

    investmentMarketsDb: { async getAll() { return []; } },
    investmentTradesDb: { async getAll() { return []; } },
    investmentPricesDb: { async getAll() { return []; } },

    // ── The RPC under test, in memory ──────────────────────────────────────
    // Faithful to supabase-migration-p3-atomic-transfer.sql, including the
    // property the whole pilot exists for: no partial application. Every
    // refusal happens BEFORE the first mutation, and the two balance writes
    // plus the row insert happen together at the end.
    atomicMoneyDb: {
      async transferAtomic(input: Record<string, unknown>) {
        rpcCalls.push(input);
        const txId = input.transactionId as string;
        const srcId = input.sourceAccountId as string;
        const dstId = input.destinationAccountId as string;
        const amount = input.amount as number;

        const existing = transactions.get(txId);
        if (existing) {
          // Idempotent replay: money already moved, return current truth.
          return {
            replay: true,
            transactionId: txId,
            sourceBalance: accounts.get(srcId)!.balance,
            destinationBalance: accounts.get(dstId)!.balance,
            destinationAmount: null,
            conversionRate: (existing.conversionRate as number) ?? null,
          };
        }

        const src = accounts.get(srcId);
        const dst = accounts.get(dstId);
        if (!src || !dst) {
          const err = new Error('ACCOUNT_NOT_FOUND') as Error & { code: string };
          err.code = 'ACCOUNT_NOT_FOUND';
          throw err;
        }

        const srcDelta = round2(amount);
        const rate = src.currency === dst.currency ? null : (input.conversionRate as number);
        const dstDelta = rate === null ? srcDelta : round2(amount * rate);

        if (src.balance !== (input.expectedSourceBalance as number)
            || dst.balance !== (input.expectedDestinationBalance as number)) {
          const err = new Error('BALANCE_CONFLICT') as Error & {
            code: string; sourceBalance: number; destinationBalance: number;
          };
          err.code = 'BALANCE_CONFLICT';
          err.sourceBalance = src.balance;
          err.destinationBalance = dst.balance;
          throw err;
        }

        if (input.allowNegative !== true && src.balance < srcDelta) {
          const err = new Error(`${src.name} only has ${src.balance} — that's less than ${srcDelta}.`) as Error & { code: string };
          err.code = 'INSUFFICIENT_BALANCE';
          throw err;
        }

        const newSrc = round2(src.balance - srcDelta);
        const newDst = round2(dst.balance + dstDelta);
        accounts.set(srcId, { ...src, balance: newSrc });
        accounts.set(dstId, { ...dst, balance: newDst });
        transactions.set(txId, {
          id: txId, type: 'transfer', amount, currency: src.currency,
          sourceAccountId: srcId, destinationAccountId: dstId,
          relatedPerson: null, personId: null, relatedLoanId: null, relatedGoalId: null,
          conversionRate: rate, category: input.category, notes: input.note,
          createdAt: input.createdAt, isReconciled: false,
        });

        return {
          replay: false,
          transactionId: txId,
          sourceBalance: newSrc,
          destinationBalance: newDst,
          destinationAmount: dstDelta,
          conversionRate: rate,
        };
      },
    },
  };
});

// The flag is read at module-evaluation time, so it must be stubbed before the
// store is imported — hence the dynamic import below.
vi.stubEnv('VITE_ATOMIC_TRANSFER', 'true');

const mockDb = await import('../lib/supabaseDb');
const { useAccountStore } = await import('./accountStore');
const { useTransactionStore } = await import('./transactionStore');
const { useLoanStore } = await import('./loanStore');
const { useGoalStore } = await import('./goalStore');
const { useEmiStore } = await import('./emiStore');
const { useAppModeStore } = await import('./appModeStore');
const { useActivityStore } = await import('./activityStore');
const { useInvestmentStore } = await import('./investmentStore');

type Loose = Record<string, never>;
const seedAccount = (mockDb as unknown as { __seedAccount: (a: { id: string; balance: number; name?: string; type?: string; currency?: string; metadata?: Record<string, string> }) => void }).__seedAccount;
const remoteBalanceDelta = (mockDb as unknown as { __remoteBalanceDelta: (id: string, delta: number) => void }).__remoteBalanceDelta;
const failNextTxAdd = (mockDb as unknown as { __failNextTxAdd: (err: Error) => void }).__failNextTxAdd;
const rpcCalls = (mockDb as unknown as { __rpcCalls: () => Array<Record<string, unknown>> }).__rpcCalls;
const remoteAccount = (mockDb as unknown as { __getAccount: (id: string) => { balance: number } | undefined }).__getAccount;
const remoteTransactions = (mockDb as unknown as { __getTransactions: () => Array<Record<string, unknown>> }).__getTransactions;
const resetDb = (mockDb as unknown as { __reset: () => void }).__reset;

function seedAndLoad(account: { id: string; balance: number; currency?: string; type?: string; name?: string; metadata?: Record<string, string> }) {
  seedAccount(account);
  useAccountStore.setState((s) => ({
    accounts: [
      ...s.accounts,
      {
        id: account.id,
        name: account.name ?? account.id,
        type: (account.type ?? 'cash') as 'cash',
        currency: (account.currency ?? 'AED') as 'AED',
        balance: account.balance,
        metadata: account.metadata ?? {},
        createdAt: new Date().toISOString(),
      },
    ],
  }));
}

beforeEach(() => {
  resetDb();
  useAccountStore.setState({ accounts: [], loading: false });
  useTransactionStore.setState({ transactions: [], loading: false });
  useLoanStore.setState({ loans: [], loading: false });
  useGoalStore.setState({ goals: [], loading: false });
  useEmiStore.setState({ schedules: [], loading: false });
  useAppModeStore.setState({ mode: 'full_tracker' });
  useActivityStore.setState({ activities: [], loading: false });
  useInvestmentStore.setState({ markets: [], trades: [], prices: [], loading: false } as unknown as Loose);
});

describe('processTransaction — transfer via the atomic RPC (VITE_ATOMIC_TRANSFER=true)', () => {
  it('moves both legs and writes exactly one row', async () => {
    seedAndLoad({ id: 'cash', balance: 1000, currency: 'AED', name: 'Cash' });
    seedAndLoad({ id: 'bank', balance: 0, currency: 'AED', name: 'Bank' });

    const tx = await useTransactionStore.getState().processTransaction({
      type: 'transfer', amount: 250, sourceAccountId: 'cash', destinationAccountId: 'bank',
    });

    // Store and server agree — the store adopts the SERVER's balances.
    expect(useAccountStore.getState().getAccount('cash')?.balance).toBe(750);
    expect(useAccountStore.getState().getAccount('bank')?.balance).toBe(250);
    expect(remoteAccount('cash')?.balance).toBe(750);
    expect(remoteAccount('bank')?.balance).toBe(250);
    expect(remoteTransactions()).toHaveLength(1);
    expect(useTransactionStore.getState().transactions).toHaveLength(1);
    expect(tx.type).toBe('transfer');
  });

  it('writes the same row shape the legacy path writes', async () => {
    seedAndLoad({ id: 'cash', balance: 1000, currency: 'AED', name: 'Cash' });
    seedAndLoad({ id: 'bank', balance: 0, currency: 'AED', name: 'Bank' });

    const tx = await useTransactionStore.getState().processTransaction({
      type: 'transfer', amount: 250, sourceAccountId: 'cash', destinationAccountId: 'bank',
      category: 'Transfer', notes: 'rent share',
    });

    expect(tx).toMatchObject({
      type: 'transfer',
      amount: 250,
      currency: 'AED',
      sourceAccountId: 'cash',
      destinationAccountId: 'bank',
      relatedPerson: null,
      relatedLoanId: null,
      relatedGoalId: null,
      conversionRate: null,
      category: 'Transfer',
      notes: 'rent share',
      isReconciled: false,
    });
    // The server row and the client row are the SAME row (same id, same
    // created_at) — the tail's idempotent upsert must not fork them.
    const serverRow = remoteTransactions()[0];
    expect(serverRow.id).toBe(tx.id);
    expect(serverRow.createdAt).toBe(tx.createdAt);
    expect(serverRow.amount).toBe(tx.amount);
  });

  it('cross-currency: the rate lands on the destination only, and on the row', async () => {
    seedAndLoad({ id: 'aed', balance: 1000, currency: 'AED' });
    seedAndLoad({ id: 'pkr', balance: 0, currency: 'PKR' });

    const tx = await useTransactionStore.getState().processTransaction({
      type: 'transfer', amount: 100, sourceAccountId: 'aed', destinationAccountId: 'pkr',
      conversionRate: 76.5,
    });

    expect(useAccountStore.getState().getAccount('aed')?.balance).toBe(900);
    expect(useAccountStore.getState().getAccount('pkr')?.balance).toBe(7650);
    expect(tx.amount).toBe(100);
    expect(tx.currency).toBe('AED');
    expect(tx.conversionRate).toBe(76.5);
  });

  it('is ONE server call — the half-moved window no longer exists', async () => {
    seedAndLoad({ id: 'cash', balance: 1000, currency: 'AED' });
    seedAndLoad({ id: 'bank', balance: 0, currency: 'AED' });

    await useTransactionStore.getState().processTransaction({
      type: 'transfer', amount: 250, sourceAccountId: 'cash', destinationAccountId: 'bank',
    });

    // Legacy: two applyBalanceDelta round-trips, either of which could be the
    // last one to survive the network. Now: one.
    expect(rpcCalls()).toHaveLength(1);
    expect(rpcCalls()[0]).toMatchObject({
      sourceAccountId: 'cash',
      destinationAccountId: 'bank',
      amount: 250,
      expectedSourceBalance: 1000,
      expectedDestinationBalance: 0,
      allowNegative: false,
    });
  });

  it('BALANCE_CONFLICT: refetches once and retries against server truth', async () => {
    seedAndLoad({ id: 'cash', balance: 1000, currency: 'AED' });
    seedAndLoad({ id: 'bank', balance: 0, currency: 'AED' });
    // Another device spent 400 from cash; our store still believes 1000.
    remoteBalanceDelta('cash', -400);

    await useTransactionStore.getState().processTransaction({
      type: 'transfer', amount: 250, sourceAccountId: 'cash', destinationAccountId: 'bank',
    });

    // 600 − 250, NOT 1000 − 250: the other device's spend survived.
    expect(remoteAccount('cash')?.balance).toBe(350);
    expect(useAccountStore.getState().getAccount('cash')?.balance).toBe(350);
    expect(remoteAccount('bank')?.balance).toBe(250);
    expect(rpcCalls()).toHaveLength(2); // conflict, then the retry
    expect(remoteTransactions()).toHaveLength(1);
  });

  it('two consecutive conflicts surface, and nothing moved', async () => {
    seedAndLoad({ id: 'cash', balance: 1000, currency: 'AED' });
    seedAndLoad({ id: 'bank', balance: 0, currency: 'AED' });
    // getAll() is what the retry refetches; poison it so the refreshed
    // expectation is stale too (the second-conflict case accountStore
    // deliberately surfaces to the caller).
    const db = mockDb as unknown as { accountsDb: { getAll: () => Promise<unknown> } };
    const realGetAll = db.accountsDb.getAll;
    db.accountsDb.getAll = async () => {
      const rows = (await realGetAll()) as Array<{ id: string; balance: number }>;
      return rows.map((r) => (r.id === 'cash' ? { ...r, balance: r.balance + 1 } : r));
    };
    remoteBalanceDelta('cash', -400);

    await expect(
      useTransactionStore.getState().processTransaction({
        type: 'transfer', amount: 250, sourceAccountId: 'cash', destinationAccountId: 'bank',
      }),
    ).rejects.toMatchObject({ code: 'BALANCE_CONFLICT' });

    db.accountsDb.getAll = realGetAll;
    expect(remoteAccount('cash')?.balance).toBe(600);
    expect(remoteAccount('bank')?.balance).toBe(0);
    expect(remoteTransactions()).toHaveLength(0);
  });

  it('INSUFFICIENT_BALANCE from the server surfaces as the user-facing string', async () => {
    seedAndLoad({ id: 'cash', balance: 1000, currency: 'AED', name: 'Cash' });
    seedAndLoad({ id: 'bank', balance: 0, currency: 'AED' });
    // Client snapshot says 1000 (so its own checkBalance passes) but the
    // account was drained elsewhere; the retry then hits the server guard.
    remoteBalanceDelta('cash', -950);

    await expect(
      useTransactionStore.getState().processTransaction({
        type: 'transfer', amount: 400, sourceAccountId: 'cash', destinationAccountId: 'bank',
      }),
    ).rejects.toThrow(/only has|sirf/i);

    expect(remoteAccount('cash')?.balance).toBe(50);
    expect(remoteAccount('bank')?.balance).toBe(0);
    expect(remoteTransactions()).toHaveLength(0);
  });

  it('a failure AFTER the RPC unwinds the whole transfer', async () => {
    seedAndLoad({ id: 'cash', balance: 1000, currency: 'AED' });
    seedAndLoad({ id: 'bank', balance: 0, currency: 'AED' });
    failNextTxAdd(new Error('Simulated DB failure'));

    await expect(
      useTransactionStore.getState().processTransaction({
        type: 'transfer', amount: 250, sourceAccountId: 'cash', destinationAccountId: 'bank',
      }),
    ).rejects.toThrow(/Simulated DB failure/);

    // Both legs reversed together — never one of them.
    expect(remoteAccount('cash')?.balance).toBe(1000);
    expect(remoteAccount('bank')?.balance).toBe(0);
    expect(remoteTransactions()).toHaveLength(0);
    expect(useTransactionStore.getState().transactions).toHaveLength(0);
  });

  it('a replayed transaction id moves money once', async () => {
    seedAndLoad({ id: 'cash', balance: 1000, currency: 'AED' });
    seedAndLoad({ id: 'bank', balance: 0, currency: 'AED' });

    await useTransactionStore.getState().processTransaction({
      type: 'transfer', amount: 250, sourceAccountId: 'cash', destinationAccountId: 'bank',
    });
    const id = useTransactionStore.getState().transactions[0].id;

    // The retry a dropped reply would produce, replayed straight at the RPC.
    const replay = await (mockDb as unknown as {
      atomicMoneyDb: { transferAtomic: (i: Record<string, unknown>) => Promise<{ replay: boolean; sourceBalance: number }> };
    }).atomicMoneyDb.transferAtomic({
      transactionId: id, sourceAccountId: 'cash', destinationAccountId: 'bank',
      amount: 250, destinationAmount: 250, conversionRate: null, note: '', category: '',
      createdAt: new Date().toISOString(),
      expectedSourceBalance: 1000, expectedDestinationBalance: 0, allowNegative: false,
    });

    expect(replay.replay).toBe(true);
    expect(replay.sourceBalance).toBe(750);
    expect(remoteAccount('cash')?.balance).toBe(750);
    expect(remoteTransactions()).toHaveLength(1);
  });

  it('paying a card bill still auto-settles the cash advances it funded', async () => {
    // The card-bill settle is loan bookkeeping, not account movement, so it
    // stays client-side after the RPC. Proving it survives the flag is the
    // point (artifact #9 of the contract table).
    seedAndLoad({ id: 'cc', balance: 16500, currency: 'AED', type: 'credit_card', name: 'ENBD', metadata: { creditLimit: '16500' } });
    seedAndLoad({ id: 'bank', balance: 10000, currency: 'AED' });

    const advance = await useTransactionStore.getState().processTransaction({
      type: 'loan_taken', amount: 1500, destinationAccountId: 'bank', sourceAccountId: 'cc',
      personName: 'ENBD Credit Card',
    });
    const loanId = advance.relatedLoanId!;

    await useTransactionStore.getState().processTransaction({
      type: 'transfer', amount: 1500, sourceAccountId: 'bank', destinationAccountId: 'cc',
    });

    expect(useAccountStore.getState().getAccount('cc')?.balance).toBe(16500);
    expect(useAccountStore.getState().getAccount('bank')?.balance).toBe(10000);
    const settled = useLoanStore.getState().getLoan(loanId);
    expect(settled?.remainingAmount).toBe(0);
    expect(settled?.status).toBe('settled');
    const ledgerRows = useTransactionStore.getState().transactions.filter(
      (t) => t.type === 'repayment' && t.relatedLoanId === loanId && !t.sourceAccountId && !t.destinationAccountId,
    );
    expect(ledgerRows).toHaveLength(1);
  });

  it('splits_only: a transfer is unreachable — no accounts, so it is refused', async () => {
    // Ledger-only mode has no accounts at all, and unlike expense/loan/repayment
    // 'transfer' is not in isSimpleModeBalanceBypassAllowed. The branch's own
    // first guard must reject before the RPC is ever called.
    useAppModeStore.setState({ mode: 'splits_only' });

    await expect(
      useTransactionStore.getState().processTransaction({
        type: 'transfer', amount: 250, sourceAccountId: 'nope', destinationAccountId: 'also-nope',
      }),
    ).rejects.toThrow(/Account not found/);

    expect(rpcCalls()).toHaveLength(0);
    expect(remoteTransactions()).toHaveLength(0);
  });
});
