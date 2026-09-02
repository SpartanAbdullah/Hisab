// L4 step 2: processTransaction's `repayment` branch with
// VITE_ATOMIC_REPAYMENT=true — the account leg, the loan leg, the EMI status
// marks and the transactions row committed by ONE server call
// (`record_loan_repayment`).
//
// Why a separate file rather than more cases in transactionStore.test.ts:
// `ATOMIC_REPAYMENT_ENABLED` is read from import.meta.env at module load, so
// the flag has to be stubbed BEFORE the store is imported — which needs a
// dynamic import, which needs its own module registry. Vitest gives each test
// file one. transactionStore.test.ts therefore keeps proving the legacy path
// unchanged ("byte-for-byte when the flag is off") and this file proves the
// flagged path.
//
// The mock RPC below reproduces supabase-migration-p3-atomic-repayment.sql:
// direction derived from loans.type, the asymmetric cross-currency convention
// (× for a loan given, ÷ for one taken), compare-and-swap on BOTH the account
// balance and the loan remaining, the insufficient-balance guard with its
// allow-negative escape, the 0-clamp + status derivation, EMI re-validation
// (foreign ids refused, already-paid ids skipped), idempotent replay — and,
// the whole point, all-or-nothing: it never applies one leg without the rest.
//
// Coverage:
//   1. loan GIVEN — credits the account, reduces the loan, one row, one call
//   2. loan TAKEN — debits the account instead
//   3. the row carries the same shape the legacy path writes
//   4. it is ONE server call, not four
//   5. cross-currency given multiplies; cross-currency taken DIVIDES
//   6. BALANCE_CONFLICT → refetch + retry once against server truth
//   7. LOAN_REMAINING_CONFLICT → refetch + retry when the loan still covers it
//   8. …and REFUSES to retry when it no longer does (the F-2 floor)
//   9. INSUFFICIENT_BALANCE surfaces as the user-facing string
//  10. a failure AFTER the RPC unwinds account + loan + EMI marks + row
//  11. a replayed transaction id moves money once
//  12. EMI marks: the covered prefix, plus an explicitly targeted instalment
//  13. overpay — the loan clamps and settles, the account moves the full amount
//  14. a cash-advance card repayment stays on the LEGACY path (two legs)
//  15. splits_only: the ledger repayment path never touches the RPC
//  16. the consolidated (multi-loan) loop still commits per iteration

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
  const coded = (code: string, message?: string) => {
    const err = new Error(message ?? code) as Error & { code: string };
    err.code = code;
    return err;
  };

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
    __seedEmi: (e: Record<string, unknown>) => emis.set(e.id as string, e),
    __remoteBalanceDelta: (id: string, delta: number) => {
      const cur = accounts.get(id);
      if (cur) accounts.set(id, { ...cur, balance: round2(cur.balance + delta) });
    },
    __remoteLoanSet: (id: string, remaining: number) => {
      const cur = loans.get(id);
      if (cur) loans.set(id, { ...cur, remainingAmount: remaining, status: remaining === 0 ? 'settled' : 'active' });
    },
    __failNextTxAdd: (err: Error) => { nextTxAddThrows = err; },
    __rpcCalls: () => rpcCalls,
    __getAccount: (id: string) => accounts.get(id),
    __getLoan: (id: string) => loans.get(id),
    __getEmi: (id: string) => emis.get(id),
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
        if (cur.balance !== expectedBalance) throw coded('BALANCE_CONFLICT');
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
        if (!cur) throw coded('LOAN_NOT_FOUND');
        const current = Number(cur.remainingAmount ?? 0);
        if (Math.round(current * 100) !== Math.round(expectedRemaining * 100)) {
          throw coded('LOAN_REMAINING_CONFLICT');
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
      async bulkAdd(rows: Record<string, unknown>[]) { for (const e of rows) emis.set(e.id as string, e); },
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

    atomicMoneyDb: {
      async transferAtomic() {
        throw new Error('transferAtomic is not under test in this file');
      },

      // ── The RPC under test, in memory ────────────────────────────────────
      // Faithful to supabase-migration-p3-atomic-repayment.sql. Every refusal
      // happens BEFORE the first mutation; the four writes happen together at
      // the end. That is the property the whole step exists for.
      async repaymentAtomic(input: Record<string, unknown>) {
        rpcCalls.push(input);
        const txId = input.transactionId as string;
        const loanId = input.loanId as string;
        const acctId = input.accountId as string;
        const amount = input.amount as number;
        const ids = (input.emiScheduleIds as string[]) ?? [];

        const existing = transactions.get(txId);
        if (existing) {
          const l = loans.get(loanId)!;
          return {
            replay: true,
            transactionId: txId,
            accountBalance: accounts.get(acctId)!.balance,
            loanRemaining: Number(l.remainingAmount),
            loanStatus: String(l.status),
            accountDelta: 0,
            loanApplied: 0,
            emiMarked: [],
            conversionRate: (existing.conversionRate as number) ?? null,
          };
        }

        if (!acctId) throw coded('ACCOUNT_NOT_FOUND');
        const loan = loans.get(loanId);
        if (!loan) throw coded('LOAN_NOT_FOUND');
        const acct = accounts.get(acctId);
        if (!acct) throw coded('ACCOUNT_NOT_FOUND');

        const pay = round2(amount);
        const given = loan.type === 'given';
        const rate = acct.currency === loan.currency ? null : (input.conversionRate as number);
        const acctAmount = rate === null
          ? pay
          : round2(given ? amount * rate : amount / rate);
        const acctDelta = given ? acctAmount : -acctAmount;

        // CAS #1: the loan (checked first, like the server).
        const prevRemaining = round2(Number(loan.remainingAmount));
        if (prevRemaining !== round2(input.expectedLoanRemaining as number)) {
          const err = coded('LOAN_REMAINING_CONFLICT') as Error & { code: string; loanRemaining: number };
          err.loanRemaining = prevRemaining;
          throw err;
        }
        // CAS #2: the account.
        if (round2(acct.balance) !== round2(input.expectedAccountBalance as number)) {
          const err = coded('BALANCE_CONFLICT') as Error & { code: string; accountBalance: number };
          err.accountBalance = acct.balance;
          throw err;
        }

        if (acctDelta < 0 && input.allowNegative !== true && acct.balance < acctAmount) {
          throw coded('INSUFFICIENT_BALANCE', `${acct.name} only has ${acct.balance} — that's less than ${acctAmount}.`);
        }

        // EMI re-validation, BEFORE any write.
        for (const id of ids) {
          const e = emis.get(id);
          if (!e || e.loanId !== loanId) throw coded('EMI_SCHEDULE_INVALID');
        }

        // ── The writes, together ────────────────────────────────────────────
        const newRemaining = round2(Math.max(0, prevRemaining - pay));
        const newStatus = newRemaining === 0 ? 'settled' : 'active';
        loans.set(loanId, { ...loan, remainingAmount: newRemaining, status: newStatus });

        const newBalance = round2(acct.balance + acctDelta);
        accounts.set(acctId, { ...acct, balance: newBalance });

        const emiMarked: string[] = [];
        for (const id of ids) {
          const e = emis.get(id)!;
          if (e.status !== 'paid') {
            emis.set(id, { ...e, status: 'paid' });
            emiMarked.push(id);
          }
        }
        emiMarked.sort();

        transactions.set(txId, {
          id: txId, type: 'repayment', amount, currency: loan.currency,
          sourceAccountId: given ? null : acctId,
          destinationAccountId: given ? acctId : null,
          relatedPerson: loan.personName, personId: loan.personId ?? null,
          relatedLoanId: loanId, relatedGoalId: null,
          conversionRate: rate, category: input.category, notes: input.note,
          createdAt: input.createdAt, isReconciled: false,
        });

        return {
          replay: false,
          transactionId: txId,
          accountBalance: newBalance,
          loanRemaining: newRemaining,
          loanStatus: newStatus,
          accountDelta: acctDelta,
          loanApplied: round2(prevRemaining - newRemaining),
          emiMarked,
          conversionRate: rate,
        };
      },
    },
  };
});

// The flag is read at module-evaluation time, so it must be stubbed before the
// store is imported — hence the dynamic imports below.
vi.stubEnv('VITE_ATOMIC_REPAYMENT', 'true');

const mockDb = await import('../lib/supabaseDb');
const { useAccountStore } = await import('./accountStore');
const { useTransactionStore } = await import('./transactionStore');
const { useLoanStore } = await import('./loanStore');
const { useGoalStore } = await import('./goalStore');
const { useEmiStore } = await import('./emiStore');
const { useAppModeStore } = await import('./appModeStore');
const { useActivityStore } = await import('./activityStore');
const { useInvestmentStore } = await import('./investmentStore');
const { executeAllocatedRepayments } = await import('../lib/repaymentExecution');

type Loose = Record<string, never>;
type SeedAccount = { id: string; balance: number; name?: string; type?: string; currency?: string; metadata?: Record<string, string> };

const seedAccount = (mockDb as unknown as { __seedAccount: (a: SeedAccount) => void }).__seedAccount;
const seedEmi = (mockDb as unknown as { __seedEmi: (e: Record<string, unknown>) => void }).__seedEmi;
const remoteBalanceDelta = (mockDb as unknown as { __remoteBalanceDelta: (id: string, d: number) => void }).__remoteBalanceDelta;
const remoteLoanSet = (mockDb as unknown as { __remoteLoanSet: (id: string, r: number) => void }).__remoteLoanSet;
const failNextTxAdd = (mockDb as unknown as { __failNextTxAdd: (err: Error) => void }).__failNextTxAdd;
const rpcCalls = (mockDb as unknown as { __rpcCalls: () => Array<Record<string, unknown>> }).__rpcCalls;
const remoteAccount = (mockDb as unknown as { __getAccount: (id: string) => { balance: number } | undefined }).__getAccount;
const remoteLoan = (mockDb as unknown as { __getLoan: (id: string) => Record<string, unknown> | undefined }).__getLoan;
const remoteEmi = (mockDb as unknown as { __getEmi: (id: string) => Record<string, unknown> | undefined }).__getEmi;
const remoteTransactions = (mockDb as unknown as { __getTransactions: () => Array<Record<string, unknown>> }).__getTransactions;
const resetDb = (mockDb as unknown as { __reset: () => void }).__reset;

function seedAndLoad(account: SeedAccount) {
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

/** Seed a loan into BOTH the remote map and the store, like a loaded app. */
async function seedLoan(l: {
  id: string; type: 'given' | 'taken'; total: number; remaining?: number;
  currency?: string; personName?: string; personId?: string | null;
}) {
  const loan = {
    id: l.id,
    personName: l.personName ?? 'Ali',
    personId: l.personId ?? null,
    type: l.type,
    totalAmount: l.total,
    remainingAmount: l.remaining ?? l.total,
    currency: (l.currency ?? 'AED') as 'AED',
    status: 'active' as const,
    notes: '',
    createdAt: new Date().toISOString(),
  };
  await (mockDb as unknown as { loansDb: { add: (l: unknown) => Promise<void> } }).loansDb.add(loan);
  useLoanStore.setState((s) => ({ loans: [...s.loans, loan] }));
  return loan;
}

function seedSchedule(loanId: string, amounts: number[]) {
  const rows = amounts.map((amount, i) => ({
    id: `${loanId}-e${i + 1}`,
    loanId,
    installmentNumber: i + 1,
    dueDate: `2026-0${i + 1}-01`,
    amount,
    status: 'upcoming' as const,
  }));
  for (const r of rows) seedEmi(r);
  useEmiStore.setState((s) => ({ schedules: [...s.schedules, ...rows] }));
  return rows;
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

describe('processTransaction — repayment via the atomic RPC (VITE_ATOMIC_REPAYMENT=true)', () => {
  it('loan GIVEN: credits the account, reduces the loan, writes exactly one row', async () => {
    seedAndLoad({ id: 'bank', balance: 500, name: 'Bank' });
    await seedLoan({ id: 'L1', type: 'given', total: 1000 });

    const tx = await useTransactionStore.getState().processTransaction({
      type: 'repayment', amount: 250, loanId: 'L1', destinationAccountId: 'bank',
    });

    // Store and server agree — the store adopts the SERVER's figures.
    expect(useAccountStore.getState().getAccount('bank')?.balance).toBe(750);
    expect(remoteAccount('bank')?.balance).toBe(750);
    expect(useLoanStore.getState().getLoan('L1')?.remainingAmount).toBe(750);
    expect(remoteLoan('L1')?.remainingAmount).toBe(750);
    expect(remoteTransactions()).toHaveLength(1);
    expect(useTransactionStore.getState().transactions).toHaveLength(1);
    expect(tx.type).toBe('repayment');
  });

  it('loan TAKEN: debits the account instead', async () => {
    seedAndLoad({ id: 'cash', balance: 500, name: 'Cash' });
    await seedLoan({ id: 'L2', type: 'taken', total: 1000, personName: 'Bilal' });

    await useTransactionStore.getState().processTransaction({
      type: 'repayment', amount: 250, loanId: 'L2', sourceAccountId: 'cash',
    });

    expect(useAccountStore.getState().getAccount('cash')?.balance).toBe(250);
    expect(useLoanStore.getState().getLoan('L2')?.remainingAmount).toBe(750);
  });

  it('writes the same row shape the legacy path writes', async () => {
    seedAndLoad({ id: 'bank', balance: 500 });
    await seedLoan({ id: 'L1', type: 'given', total: 1000, personName: 'Ali', personId: 'p-ali' });

    const tx = await useTransactionStore.getState().processTransaction({
      type: 'repayment', amount: 250, loanId: 'L1', destinationAccountId: 'bank',
      category: 'Loans', notes: 'first instalment',
    });

    expect(tx).toMatchObject({
      type: 'repayment',
      amount: 250,
      currency: 'AED',
      sourceAccountId: null,
      destinationAccountId: 'bank',
      relatedPerson: 'Ali',
      personId: 'p-ali',
      relatedLoanId: 'L1',
      relatedGoalId: null,
      conversionRate: null,
      category: 'Loans',
      notes: 'first instalment',
      isReconciled: false,
    });
    // The server row and the client row are the SAME row (same id, same
    // created_at) — the tail's idempotent upsert must not fork them.
    const serverRow = remoteTransactions()[0];
    expect(serverRow.id).toBe(tx.id);
    expect(serverRow.createdAt).toBe(tx.createdAt);
    expect(serverRow.amount).toBe(tx.amount);
    expect(serverRow.relatedLoanId).toBe('L1');
  });

  it('is ONE server call — the half-applied window no longer exists', async () => {
    seedAndLoad({ id: 'bank', balance: 500 });
    await seedLoan({ id: 'L1', type: 'given', total: 1000 });

    await useTransactionStore.getState().processTransaction({
      type: 'repayment', amount: 250, loanId: 'L1', destinationAccountId: 'bank',
    });

    // Legacy: account CAS, then loan CAS, then N EMI updates, then the row —
    // any of which could be the last one to survive the network. Now: one.
    expect(rpcCalls()).toHaveLength(1);
    expect(rpcCalls()[0]).toMatchObject({
      loanId: 'L1',
      accountId: 'bank',
      amount: 250,
      expectedAccountBalance: 500,
      expectedLoanRemaining: 1000,
      allowNegative: false,
    });
  });

  it('cross-currency GIVEN multiplies the rate onto the account', async () => {
    seedAndLoad({ id: 'aed', balance: 1000, currency: 'AED' });
    await seedLoan({ id: 'LP', type: 'given', total: 100000, currency: 'PKR' });

    const tx = await useTransactionStore.getState().processTransaction({
      type: 'repayment', amount: 7650, loanId: 'LP', destinationAccountId: 'aed',
      conversionRate: 0.01307,
    });

    expect(useAccountStore.getState().getAccount('aed')?.balance).toBe(1099.99); // +round(7650*0.01307,2)
    expect(useLoanStore.getState().getLoan('LP')?.remainingAmount).toBe(92350);  // the loan moves in PKR
    expect(tx.currency).toBe('PKR');
    expect(tx.conversionRate).toBe(0.01307);
  });

  it('cross-currency TAKEN DIVIDES by the rate — the conventions are not symmetric', async () => {
    seedAndLoad({ id: 'aed', balance: 1000, currency: 'AED' });
    await seedLoan({ id: 'LT', type: 'taken', total: 100000, currency: 'PKR' });

    await useTransactionStore.getState().processTransaction({
      type: 'repayment', amount: 7650, loanId: 'LT', sourceAccountId: 'aed',
      conversionRate: 76.5,
    });

    // 7650 / 76.5 = 100 — not 7650 × 76.5.
    expect(useAccountStore.getState().getAccount('aed')?.balance).toBe(900);
    expect(useLoanStore.getState().getLoan('LT')?.remainingAmount).toBe(92350);
  });

  it('BALANCE_CONFLICT: refetches once and retries against server truth', async () => {
    seedAndLoad({ id: 'bank', balance: 500 });
    await seedLoan({ id: 'L1', type: 'given', total: 1000 });
    // Another device spent 200 from bank; our store still believes 500.
    remoteBalanceDelta('bank', -200);

    await useTransactionStore.getState().processTransaction({
      type: 'repayment', amount: 250, loanId: 'L1', destinationAccountId: 'bank',
    });

    // 300 + 250, NOT 500 + 250: the other device's spend survived.
    expect(remoteAccount('bank')?.balance).toBe(550);
    expect(useAccountStore.getState().getAccount('bank')?.balance).toBe(550);
    expect(remoteLoan('L1')?.remainingAmount).toBe(750);
    expect(rpcCalls()).toHaveLength(2); // conflict, then the retry
    expect(remoteTransactions()).toHaveLength(1);
  });

  it('LOAN_REMAINING_CONFLICT: retries when the refetched loan still covers the payment', async () => {
    seedAndLoad({ id: 'bank', balance: 500 });
    await seedLoan({ id: 'L1', type: 'given', total: 1000 });
    // Another device took the loan to 800; our store still believes 1000.
    remoteLoanSet('L1', 800);

    await useTransactionStore.getState().processTransaction({
      type: 'repayment', amount: 250, loanId: 'L1', destinationAccountId: 'bank',
    });

    // 800 − 250, NOT 1000 − 250: the other device's repayment survived.
    expect(remoteLoan('L1')?.remainingAmount).toBe(550);
    expect(useLoanStore.getState().getLoan('L1')?.remainingAmount).toBe(550);
    expect(remoteAccount('bank')?.balance).toBe(750);
    expect(rpcCalls()).toHaveLength(2);
    expect(remoteTransactions()).toHaveLength(1);
  });

  it('LOAN_REMAINING_CONFLICT: REFUSES to retry when the fresh loan can no longer take it', async () => {
    // This is audit F-2 in its subtle form: a blind replay would reduce a
    // now-100 loan by 100 while the row still recorded 250, so the records
    // would exceed the reduction. The floor rule stops it.
    seedAndLoad({ id: 'bank', balance: 500 });
    await seedLoan({ id: 'L1', type: 'given', total: 1000 });
    remoteLoanSet('L1', 100);

    await expect(
      useTransactionStore.getState().processTransaction({
        type: 'repayment', amount: 250, loanId: 'L1', destinationAccountId: 'bank',
      }),
    ).rejects.toMatchObject({ code: 'LOAN_REMAINING_CONFLICT' });

    expect(remoteLoan('L1')?.remainingAmount).toBe(100);
    expect(remoteAccount('bank')?.balance).toBe(500);
    expect(remoteTransactions()).toHaveLength(0);
    expect(rpcCalls()).toHaveLength(1); // the retry was never attempted
  });

  it('INSUFFICIENT_BALANCE from the server surfaces as the user-facing string', async () => {
    seedAndLoad({ id: 'cash', balance: 500, name: 'Cash' });
    await seedLoan({ id: 'L2', type: 'taken', total: 1000 });
    // Client snapshot says 500 (so its own checkBalance passes) but the
    // account was drained elsewhere; the retry then hits the server guard.
    remoteBalanceDelta('cash', -450);

    await expect(
      useTransactionStore.getState().processTransaction({
        type: 'repayment', amount: 300, loanId: 'L2', sourceAccountId: 'cash',
      }),
    ).rejects.toThrow(/only has|sirf/i);

    expect(remoteAccount('cash')?.balance).toBe(50);
    expect(remoteLoan('L2')?.remainingAmount).toBe(1000);
    expect(remoteTransactions()).toHaveLength(0);
  });

  it('a failure AFTER the RPC unwinds the account, the loan, the EMI marks and the row', async () => {
    seedAndLoad({ id: 'cash', balance: 5000 });
    await seedLoan({ id: 'LE', type: 'taken', total: 1200 });
    seedSchedule('LE', [300, 300, 300, 300]);
    failNextTxAdd(new Error('Simulated DB failure'));

    await expect(
      useTransactionStore.getState().processTransaction({
        type: 'repayment', amount: 600, loanId: 'LE', sourceAccountId: 'cash',
      }),
    ).rejects.toThrow(/Simulated DB failure/);

    // All four artifacts reversed together — never some of them.
    expect(remoteAccount('cash')?.balance).toBe(5000);
    expect(remoteLoan('LE')?.remainingAmount).toBe(1200);
    expect(remoteLoan('LE')?.status).toBe('active');
    expect(remoteEmi('LE-e1')?.status).toBe('upcoming');
    expect(remoteEmi('LE-e2')?.status).toBe('upcoming');
    expect(remoteTransactions()).toHaveLength(0);
    expect(useTransactionStore.getState().transactions).toHaveLength(0);
    expect(useLoanStore.getState().getLoan('LE')?.remainingAmount).toBe(1200);
    expect(useEmiStore.getState().schedules.every((e) => e.status === 'upcoming')).toBe(true);
  });

  it('a replayed transaction id moves money once', async () => {
    seedAndLoad({ id: 'bank', balance: 500 });
    await seedLoan({ id: 'L1', type: 'given', total: 1000 });

    await useTransactionStore.getState().processTransaction({
      type: 'repayment', amount: 250, loanId: 'L1', destinationAccountId: 'bank',
    });
    const id = useTransactionStore.getState().transactions[0].id;

    // The retry a dropped reply would produce, replayed straight at the RPC.
    const replay = await (mockDb as unknown as {
      atomicMoneyDb: { repaymentAtomic: (i: Record<string, unknown>) => Promise<{ replay: boolean; accountBalance: number; loanRemaining: number }> };
    }).atomicMoneyDb.repaymentAtomic({
      transactionId: id, loanId: 'L1', accountId: 'bank', amount: 250,
      accountAmount: 250, conversionRate: null, note: '', category: '',
      createdAt: new Date().toISOString(),
      expectedAccountBalance: 500, expectedLoanRemaining: 1000,
      emiScheduleIds: [], allowNegative: false,
    });

    expect(replay.replay).toBe(true);
    expect(replay.accountBalance).toBe(750);
    expect(replay.loanRemaining).toBe(750);
    expect(remoteAccount('bank')?.balance).toBe(750);
    expect(remoteLoan('L1')?.remainingAmount).toBe(750);
    expect(remoteTransactions()).toHaveLength(1);
  });

  it('marks the EMI instalments the repayment covers — and only those', async () => {
    seedAndLoad({ id: 'cash', balance: 5000 });
    await seedLoan({ id: 'LE', type: 'taken', total: 1200 });
    seedSchedule('LE', [300, 300, 300, 300]);

    await useTransactionStore.getState().processTransaction({
      type: 'repayment', amount: 600, loanId: 'LE', sourceAccountId: 'cash',
    });

    expect(remoteEmi('LE-e1')?.status).toBe('paid');
    expect(remoteEmi('LE-e2')?.status).toBe('paid');
    expect(remoteEmi('LE-e3')?.status).toBe('upcoming');
    // The local store adopted the same marks.
    const local = Object.fromEntries(useEmiStore.getState().schedules.map((e) => [e.id, e.status]));
    expect(local['LE-e1']).toBe('paid');
    expect(local['LE-e3']).toBe('upcoming');
  });

  it('an explicitly targeted instalment is marked even when the money does not reach it', async () => {
    seedAndLoad({ id: 'cash', balance: 5000 });
    await seedLoan({ id: 'LE', type: 'taken', total: 1200 });
    seedSchedule('LE', [300, 300, 300, 300]);

    await useTransactionStore.getState().processTransaction({
      type: 'repayment', amount: 300, loanId: 'LE', sourceAccountId: 'cash', emiId: 'LE-e3',
    });

    expect(remoteEmi('LE-e3')?.status).toBe('paid'); // targeted
    expect(remoteEmi('LE-e1')?.status).toBe('paid'); // covered by the 300 paid down
    expect(remoteEmi('LE-e2')?.status).toBe('upcoming');
  });

  it('overpaying settles the loan (clamped at 0) while the account moves the full amount', async () => {
    seedAndLoad({ id: 'bank', balance: 500 });
    await seedLoan({ id: 'L1', type: 'given', total: 1000, remaining: 250 });

    await useTransactionStore.getState().processTransaction({
      type: 'repayment', amount: 400, loanId: 'L1', destinationAccountId: 'bank',
    });

    expect(remoteLoan('L1')?.remainingAmount).toBe(0);
    expect(remoteLoan('L1')?.status).toBe('settled');
    expect(useLoanStore.getState().getLoan('L1')?.status).toBe('settled');
    expect(remoteAccount('bank')?.balance).toBe(900); // the full 400 landed
    expect(remoteTransactions()[0].amount).toBe(400); // the row records what moved
  });

  it('an overpayment that later fails is compensated with the CLAMPED figure, not the requested one', async () => {
    seedAndLoad({ id: 'bank', balance: 500 });
    await seedLoan({ id: 'L1', type: 'given', total: 1000, remaining: 250 });
    failNextTxAdd(new Error('Simulated DB failure'));

    await expect(
      useTransactionStore.getState().processTransaction({
        type: 'repayment', amount: 400, loanId: 'L1', destinationAccountId: 'bank',
      }),
    ).rejects.toThrow(/Simulated DB failure/);

    // Giving back 400 would have inflated the loan past where it started.
    expect(remoteLoan('L1')?.remainingAmount).toBe(250);
    expect(remoteLoan('L1')?.status).toBe('active');
    expect(remoteAccount('bank')?.balance).toBe(500);
  });

  it('a cash-advance card repayment stays on the LEGACY path (the RPC cannot express two account legs)', async () => {
    seedAndLoad({ id: 'cc', balance: 16500, currency: 'AED', type: 'credit_card', name: 'ENBD', metadata: { creditLimit: '16500' } });
    seedAndLoad({ id: 'bank', balance: 10000, currency: 'AED' });

    const advance = await useTransactionStore.getState().processTransaction({
      type: 'loan_taken', amount: 1500, destinationAccountId: 'bank', sourceAccountId: 'cc',
      personName: 'ENBD Credit Card',
    });
    const loanId = advance.relatedLoanId!;
    const callsBefore = rpcCalls().length;

    await useTransactionStore.getState().processTransaction({
      type: 'repayment', amount: 1500, loanId, sourceAccountId: 'bank',
    });

    // No RPC call: the card credit is a second account leg.
    expect(rpcCalls()).toHaveLength(callsBefore);
    // …and the legacy two-leg behaviour is intact.
    expect(useAccountStore.getState().getAccount('bank')?.balance).toBe(10000); // 11500 − 1500
    expect(useAccountStore.getState().getAccount('cc')?.balance).toBe(16500);   // credit restored
    expect(useLoanStore.getState().getLoan(loanId)?.remainingAmount).toBe(0);
    expect(useLoanStore.getState().getLoan(loanId)?.status).toBe('settled');
  });

  it('splits_only: the ledger repayment path never touches the RPC', async () => {
    // Ledger mode has no accounts; loanStore.applyRepayment writes a row with
    // BOTH account ids null and applies the loan CAS directly. Not one line of
    // it changes under this flag, and record_loan_repayment would refuse it
    // (ACCOUNT_NOT_FOUND) if it were ever routed here.
    useAppModeStore.setState({ mode: 'splits_only' });
    await seedLoan({ id: 'LS', type: 'given', total: 1000, personName: 'Sara' });

    await useLoanStore.getState().applyRepayment('LS', 300);

    expect(rpcCalls()).toHaveLength(0);
    expect(remoteLoan('LS')?.remainingAmount).toBe(700);
    const rows = remoteTransactions();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      type: 'repayment', amount: 300, relatedLoanId: 'LS',
      sourceAccountId: null, destinationAccountId: null,
    });
  });

  it('the consolidated multi-loan loop still commits one repayment per iteration', async () => {
    seedAndLoad({ id: 'bank', balance: 1000 });
    await seedLoan({ id: 'A', type: 'given', total: 500, personName: 'Ali' });
    await seedLoan({ id: 'B', type: 'given', total: 500, personName: 'Ali' });

    const result = await executeAllocatedRepayments(
      [{ loanId: 'A', amount: 500 }, { loanId: 'B', amount: 200 }],
      {
        mode: 'tracker',
        direction: 'given',
        accountId: 'bank',
        processTransaction: (i) => useTransactionStore.getState().processTransaction(i),
        applyRepayment: (id, amt, notes) => useLoanStore.getState().applyRepayment(id, amt, notes),
      },
    );

    expect(result.done).toBe(2);
    expect(result.totalApplied).toBe(700);
    expect(remoteLoan('A')?.remainingAmount).toBe(0);
    expect(remoteLoan('A')?.status).toBe('settled');
    expect(remoteLoan('B')?.remainingAmount).toBe(300);
    expect(remoteAccount('bank')?.balance).toBe(1700);
    expect(remoteTransactions()).toHaveLength(2);
    expect(rpcCalls()).toHaveLength(2); // one per iteration, each atomic
  });

  it('a mid-loop failure keeps the committed prefix and reports it honestly', async () => {
    seedAndLoad({ id: 'bank', balance: 1000 });
    await seedLoan({ id: 'A', type: 'given', total: 500, personName: 'Ali' });
    await seedLoan({ id: 'B', type: 'given', total: 500, personName: 'Ali' });
    // The second iteration's row write fails.
    let calls = 0;
    const result = await executeAllocatedRepayments(
      [{ loanId: 'A', amount: 500 }, { loanId: 'B', amount: 200 }],
      {
        mode: 'tracker',
        direction: 'given',
        accountId: 'bank',
        processTransaction: async (i) => {
          calls += 1;
          if (calls === 2) failNextTxAdd(new Error('Simulated DB failure'));
          return useTransactionStore.getState().processTransaction(i);
        },
        applyRepayment: (id, amt, notes) => useLoanStore.getState().applyRepayment(id, amt, notes),
      },
    );

    expect(result.done).toBe(1);
    expect(result.totalApplied).toBe(500);
    expect(result.failed?.item.loanId).toBe('B');
    // Loan A committed; loan B is completely untouched — no half-applied money.
    expect(remoteLoan('A')?.remainingAmount).toBe(0);
    expect(remoteLoan('B')?.remainingAmount).toBe(500);
    expect(remoteAccount('bank')?.balance).toBe(1500);
    expect(remoteTransactions()).toHaveLength(1);
  });
});
