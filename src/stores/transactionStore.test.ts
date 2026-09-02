// Tests for the money-flow engine. processTransaction is the most critical
// piece of code in the app — every branch moves real money, and a bug here
// silently corrupts user balances. These tests mock supabaseDb so they run
// fully in-memory, against the real Zustand stores.
//
// Coverage:
//   1. Expense — debits source
//   2. Income — credits destination
//   3. Transfer same-currency — debits source + credits destination
//   4. Transfer cross-currency — applies conversion rate to destination
//   5. Expense throws on insufficient balance (full_tracker mode)
//   6. Loan-taken cash-advance — debits credit card AND credits destination
//   7. Loan-taken cash-advance rejects mismatched currency
//   8. Repayment of "given" loan — credits destination + decrements loan
//   9. Rollback restores source balance when the final write throws

import { beforeEach, describe, expect, it, vi } from 'vitest';

// ─────────────────────────────────────────────────────────────────────────
// Mock supabaseDb with in-memory stubs. Hoisted by Vitest before imports.
// Each table is a simple Map keyed by id. applyBalanceDelta is the new
// optimistic-lock RPC; we honor expected_balance the same way the server does.
// ─────────────────────────────────────────────────────────────────────────
vi.mock('../lib/supabaseDb', async () => {
  const accounts = new Map<string, { id: string; balance: number; name: string; type: string; currency: string; metadata: Record<string, string>; createdAt: string }>();
  const transactions = new Map<string, Record<string, unknown>>();
  const loans = new Map<string, Record<string, unknown>>();
  const emis = new Map<string, Record<string, unknown>>();
  const goals = new Map<string, Record<string, unknown>>();
  const activities = new Map<string, Record<string, unknown>>();
  const investmentMarkets = new Map<string, Record<string, unknown>>();
  const investmentTrades = new Map<string, Record<string, unknown>>();
  const investmentPrices = new Map<string, Record<string, unknown>>();

  // Toggle: when true, transactionsDb.add throws on the next call. Lets us
  // simulate "final write fails after balance moved" for the rollback test.
  let nextTxAddThrows: Error | null = null;
  // Optional side-effect fired immediately BEFORE that throw. The only hook we
  // have for interleaving a competing device's write into the exact window
  // between "loan balance moved" and "rollback runs" (audit C10).
  let nextTxAddBefore: (() => void) | null = null;

  // Round-trip counters for the bounded-history reads below.
  const historyCalls = { all: 0, window: 0, range: 0 };
  const sortedDesc = () =>
    Array.from(transactions.values()).sort((a, b) => {
      const ac = String(a.createdAt ?? '');
      const bc = String(b.createdAt ?? '');
      if (ac !== bc) return bc.localeCompare(ac);
      return String(b.id).localeCompare(String(a.id));
    });

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
    __seedLoan: (l: Record<string, unknown>) => loans.set(l.id as string, l),
    __failNextTxAdd: (err: Error, before?: () => void) => { nextTxAddThrows = err; nextTxAddBefore = before ?? null; },
    // Simulate another device moving this loan: change ONLY the remote row,
    // leaving the local store holding the stale figure.
    __remoteLoanDelta: (id: string, delta: number) => {
      const cur = loans.get(id);
      if (!cur) return;
      const next = Math.round(Math.max(0, Number(cur.remainingAmount ?? 0) + delta) * 100) / 100;
      loans.set(id, { ...cur, remainingAmount: next, status: next === 0 ? 'settled' : 'active' });
    },
    __reset: () => {
      historyCalls.all = 0;
      historyCalls.window = 0;
      historyCalls.range = 0;
      accounts.clear();
      transactions.clear();
      loans.clear();
      emis.clear();
      goals.clear();
      activities.clear();
      investmentMarkets.clear();
      investmentTrades.clear();
      investmentPrices.clear();
      nextTxAddThrows = null;
      nextTxAddBefore = null;
    },
    __getInvestmentTrades: () => Array.from(investmentTrades.values()),
    __getAccount: (id: string) => accounts.get(id),
    __getLoan: (id: string) => loans.get(id),
    __getTransactions: () => Array.from(transactions.values()),

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
        const next = Math.round((cur.balance + delta) * 100) / 100;
        accounts.set(id, { ...cur, balance: next });
        return next;
      },
      async delete(id: string) { accounts.delete(id); },
    },

    // ── Bounded history reads (docs/performance.md §7) ────────────────────
    // The three paged fetchers the store's load path uses. They reproduce the
    // real DAL's semantics at row granularity (the real one walks in 500-row
    // pages, which over-fetches the last block; the STOP RULE is identical and
    // is what these tests are about). `__historyCalls` counts round-trips so a
    // test can assert that coverage actually prevents a redundant fetch.
    __seedTransaction: (t: Record<string, unknown>) => transactions.set(t.id as string, t),
    __historyCalls: () => ({ ...historyCalls }),
    __resetHistoryCalls: () => { historyCalls.all = 0; historyCalls.window = 0; historyCalls.range = 0; },

    transactionsDb: {
      async getAll() { return Array.from(transactions.values()); },
      async getAllPaged() {
        historyCalls.all += 1;
        return { rows: sortedDesc(), pages: 1, truncated: false };
      },
      async getWindowPaged({ since, minRows = 0 }: { since: string; minRows?: number }) {
        historyCalls.window += 1;
        const all = sortedDesc();
        const rows: Record<string, unknown>[] = [];
        for (const row of all) {
          rows.push(row);
          // BOTH floors, exactly as `shouldStopWindowPaging` states them.
          if (rows.length >= minRows && String(row.createdAt) < since) break;
        }
        const complete = rows.length === all.length;
        return {
          rows,
          pages: 1,
          truncated: false,
          complete,
          coveredSince: complete ? null : since,
        };
      },
      async getRangePaged(from: string, to?: string | null) {
        historyCalls.range += 1;
        return {
          rows: sortedDesc().filter((r) => {
            const at = String(r.createdAt);
            return at >= from && (!to || at <= to);
          }),
          pages: 1,
          truncated: false,
        };
      },
      async getUpdatedSince() { return []; },
      async getDeletedSince() { return []; },
      async get(id: string) { return transactions.get(id) ?? null; },
      async add(t: Record<string, unknown>) {
        if (nextTxAddThrows) {
          const err = nextTxAddThrows;
          const before = nextTxAddBefore;
          nextTxAddThrows = null;
          nextTxAddBefore = null;
          before?.();
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
      // Mirrors apply_loan_remaining_delta: compare-and-swap on the expected
      // remaining, clamp at 0, re-derive status, raise the conflict code.
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
        const next = Math.round(Math.max(0, current + delta) * 100) / 100;
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

    // Mirror-liveness probe: false = the group expense is gone (orphan mirror
    // released). Tests never exercise live group guards.
    groupExpensesDb: {
      async get() { return null; },
      async probeExists() { return false; },
    },

    investmentMarketsDb: {
      async getAll() { return Array.from(investmentMarkets.values()); },
      async add(m: Record<string, unknown>) { investmentMarkets.set(m.id as string, m); },
      async update(id: string, changes: Record<string, unknown>) {
        const cur = investmentMarkets.get(id);
        if (cur) investmentMarkets.set(id, { ...cur, ...changes });
      },
      async delete(id: string) { investmentMarkets.delete(id); },
    },
    investmentTradesDb: {
      async getAll() { return Array.from(investmentTrades.values()); },
      async add(t: Record<string, unknown>) { investmentTrades.set(t.id as string, t); },
      async delete(id: string) { investmentTrades.delete(id); },
    },
    investmentPricesDb: {
      async getAll() { return Array.from(investmentPrices.values()); },
      async upsert(p: Record<string, unknown>) { investmentPrices.set(p.id as string, p); },
    },

    // L4 pilot gateway. Present because transactionStore imports it by name
    // (an ESM named import missing from a mock factory throws at import time);
    // NEVER called here, because VITE_ATOMIC_TRANSFER is unset in this file, so
    // every transfer above still exercises the legacy two-leg path. The flagged
    // path has its own suite: transactionStoreAtomicTransfer.test.ts.
    atomicMoneyDb: {
      async transferAtomic() {
        throw new Error('atomicMoneyDb.transferAtomic must not be called with the flag off');
      },
      // Same contract for L4 step 2: VITE_ATOMIC_REPAYMENT is unset here, so
      // every repayment above still exercises the legacy account-CAS +
      // loan-CAS + EMI + row sequence. Flagged path:
      // transactionStoreAtomicRepayment.test.ts.
      async repaymentAtomic() {
        throw new Error('atomicMoneyDb.repaymentAtomic must not be called with the flag off');
      },
      // Same contract for L4 step 3: VITE_ATOMIC_LOAN_CREATE is unset here, so
      // every loan_given / loan_taken above still exercises the legacy
      // balance-delta + loans-INSERT + row sequence. Flagged path:
      // transactionStoreAtomicLoanCreate.test.ts.
      async loanCreateAtomic() {
        throw new Error('atomicMoneyDb.loanCreateAtomic must not be called with the flag off');
      },
      // Same contract for L4 step 4: VITE_ATOMIC_GOAL and VITE_ATOMIC_CARD_BILL
      // are unset here, so every goal contribution, every card-bill transfer
      // and every cash-advance repayment above still exercises its legacy
      // multi-round-trip sequence. These throwing stubs are what turns "the
      // legacy path is byte-for-byte unchanged with the flags off" from a hope
      // into an assertion — the card-bill tests below (paying a bill settles
      // its advances, the clamped credit, the Available-over-Limit case,
      // deleting a bill payment re-opens the loans) would fail loudly if the
      // hoisted plan had accidentally routed one of them through an RPC.
      // Flagged path: transactionStoreAtomicGoalCard.test.ts.
      async goalContributeAtomic() {
        throw new Error('atomicMoneyDb.goalContributeAtomic must not be called with the flag off');
      },
      async payCardBillAtomic() {
        throw new Error('atomicMoneyDb.payCardBillAtomic must not be called with the flag off');
      },
    },
  };
});

import * as mockDb from '../lib/supabaseDb';
import { useAccountStore } from './accountStore';
import { useTransactionStore } from './transactionStore';
import { useLoanStore } from './loanStore';
import { useGoalStore } from './goalStore';
import { useEmiStore } from './emiStore';
import { useAppModeStore } from './appModeStore';
import { useActivityStore } from './activityStore';
import { useInvestmentStore } from './investmentStore';
import { emptyCoverage } from '../lib/historyWindow';

// Loose-typed accessors on the mock module — these are added by vi.mock above
// but TypeScript doesn't know about them.
const seedAccount = (mockDb as unknown as { __seedAccount: (a: { id: string; balance: number; name?: string; type?: string; currency?: string; metadata?: Record<string, string> }) => void }).__seedAccount;
const seedLoan = (mockDb as unknown as { __seedLoan: (l: Record<string, unknown>) => void }).__seedLoan;
const failNextTxAdd = (mockDb as unknown as { __failNextTxAdd: (err: Error, before?: () => void) => void }).__failNextTxAdd;
const resetDb = (mockDb as unknown as { __reset: () => void }).__reset;
const remoteLoanDelta = (mockDb as unknown as { __remoteLoanDelta: (id: string, delta: number) => void }).__remoteLoanDelta;
const remoteLoan = (mockDb as unknown as { __getLoan: (id: string) => Record<string, unknown> | undefined }).__getLoan;
const seedTransaction = (mockDb as unknown as { __seedTransaction: (t: Record<string, unknown>) => void }).__seedTransaction;
const historyCalls = (mockDb as unknown as { __historyCalls: () => { all: number; window: number; range: number } }).__historyCalls;
const resetHistoryCalls = (mockDb as unknown as { __resetHistoryCalls: () => void }).__resetHistoryCalls;

beforeEach(async () => {
  resetDb();
  // Reset every store touched by processTransaction.
  useAccountStore.setState({ accounts: [], loading: false });
  useTransactionStore.setState({
    transactions: [],
    loading: false,
    historyCoverage: emptyCoverage(),
    historyLoading: false,
  });
  useLoanStore.setState({ loans: [], loading: false });
  useGoalStore.setState({ goals: [], loading: false });
  useEmiStore.setState({ schedules: [], loading: false });
  useAppModeStore.setState({ mode: 'full_tracker' });
  // Silence activity logging during tests — the real implementation calls
  // activitiesDb.add which is already mocked, but the store also reads
  // localStorage for de-dup. Reset it for isolation.
  useActivityStore.setState({ activities: [], loading: false });
  useInvestmentStore.setState({ markets: [], trades: [], prices: [], loading: false });
});

function seedMarket(market: { id: string; name: string; currency: 'AED' | 'PKR' }) {
  useInvestmentStore.setState((s) => ({
    markets: [...s.markets, { ...market, createdAt: new Date().toISOString() }],
  }));
}

function seedAndLoad(account: { id: string; balance: number; currency?: string; type?: 'cash' | 'bank' | 'digital_wallet' | 'savings' | 'credit_card'; name?: string; metadata?: Record<string, string> }) {
  seedAccount(account);
  useAccountStore.setState((s) => ({
    accounts: [
      ...s.accounts,
      {
        id: account.id,
        name: account.name ?? account.id,
        type: account.type ?? 'cash',
        currency: (account.currency ?? 'AED') as 'AED' | 'PKR' | 'PHP' | 'SAR' | 'QAR' | 'OMR' | 'KWD' | 'BHD',
        balance: account.balance,
        metadata: account.metadata ?? {},
        createdAt: new Date().toISOString(),
      },
    ],
  }));
}

describe('processTransaction', () => {
  it('expense: debits the source account by the exact amount', async () => {
    seedAndLoad({ id: 'cash-1', balance: 1000, currency: 'AED' });

    await useTransactionStore.getState().processTransaction({
      type: 'expense',
      amount: 200,
      sourceAccountId: 'cash-1',
      category: 'Food & Dining',
    });

    const after = useAccountStore.getState().getAccount('cash-1');
    expect(after?.balance).toBe(800);
    expect(useTransactionStore.getState().transactions).toHaveLength(1);
  });

  it('income: credits the destination account by the exact amount', async () => {
    seedAndLoad({ id: 'bank-1', balance: 500, currency: 'AED' });

    await useTransactionStore.getState().processTransaction({
      type: 'income',
      amount: 3000,
      destinationAccountId: 'bank-1',
    });

    const after = useAccountStore.getState().getAccount('bank-1');
    expect(after?.balance).toBe(3500);
  });

  it('transfer same-currency: moves amount from source to destination', async () => {
    seedAndLoad({ id: 'cash', balance: 1000, currency: 'AED' });
    seedAndLoad({ id: 'bank', balance: 0, currency: 'AED' });

    await useTransactionStore.getState().processTransaction({
      type: 'transfer',
      amount: 250,
      sourceAccountId: 'cash',
      destinationAccountId: 'bank',
    });

    expect(useAccountStore.getState().getAccount('cash')?.balance).toBe(750);
    expect(useAccountStore.getState().getAccount('bank')?.balance).toBe(250);
  });

  it('transfer cross-currency: applies conversion rate to destination amount', async () => {
    seedAndLoad({ id: 'aed-src', balance: 1000, currency: 'AED' });
    seedAndLoad({ id: 'pkr-dst', balance: 0, currency: 'PKR' });

    await useTransactionStore.getState().processTransaction({
      type: 'transfer',
      amount: 100,
      sourceAccountId: 'aed-src',
      destinationAccountId: 'pkr-dst',
      conversionRate: 76.5,
    });

    expect(useAccountStore.getState().getAccount('aed-src')?.balance).toBe(900);
    // 100 AED * 76.5 = 7650 PKR (rounded to 2dp)
    expect(useAccountStore.getState().getAccount('pkr-dst')?.balance).toBe(7650);
  });

  it('expense in full_tracker mode: throws when source has insufficient balance', async () => {
    seedAndLoad({ id: 'cash', balance: 50, currency: 'AED' });

    await expect(
      useTransactionStore.getState().processTransaction({
        type: 'expense',
        amount: 200,
        sourceAccountId: 'cash',
      }),
    ).rejects.toThrow(/only has|sirf/i);

    // Source balance must NOT have moved.
    expect(useAccountStore.getState().getAccount('cash')?.balance).toBe(50);
  });

  it('loan_taken with cash advance: debits the credit card AND credits the destination', async () => {
    seedAndLoad({ id: 'cc-1', balance: 5000, currency: 'AED', type: 'credit_card', name: 'CC' });
    seedAndLoad({ id: 'bank-1', balance: 0, currency: 'AED', name: 'Bank' });

    await useTransactionStore.getState().processTransaction({
      type: 'loan_taken',
      amount: 1500,
      destinationAccountId: 'bank-1',
      sourceAccountId: 'cc-1',
      personName: 'Bank Card Cash Advance',
    });

    expect(useAccountStore.getState().getAccount('cc-1')?.balance).toBe(3500); // -1500
    expect(useAccountStore.getState().getAccount('bank-1')?.balance).toBe(1500); // +1500
    expect(useLoanStore.getState().loans).toHaveLength(1);
    expect(useLoanStore.getState().loans[0].type).toBe('taken');
  });

  it('loan_taken cash advance: rejects when card currency differs from destination', async () => {
    seedAndLoad({ id: 'cc-pkr', balance: 50000, currency: 'PKR', type: 'credit_card' });
    seedAndLoad({ id: 'bank-aed', balance: 0, currency: 'AED' });

    await expect(
      useTransactionStore.getState().processTransaction({
        type: 'loan_taken',
        amount: 500,
        destinationAccountId: 'bank-aed',
        sourceAccountId: 'cc-pkr',
        personName: 'Mismatched',
      }),
    ).rejects.toThrow(/currency/i);

    // Neither account moved.
    expect(useAccountStore.getState().getAccount('cc-pkr')?.balance).toBe(50000);
    expect(useAccountStore.getState().getAccount('bank-aed')?.balance).toBe(0);
    expect(useLoanStore.getState().loans).toHaveLength(0);
  });

  it('repayment of given loan: credits destination AND decrements loan remaining', async () => {
    seedAndLoad({ id: 'bank', balance: 100, currency: 'AED' });
    const loan = {
      id: 'loan-1',
      personName: 'Ahmed',
      personId: null,
      type: 'given',
      totalAmount: 1000,
      remainingAmount: 1000,
      currency: 'AED',
      status: 'active',
      notes: '',
      createdAt: new Date().toISOString(),
    };
    seedLoan(loan);
    useLoanStore.setState({ loans: [loan as never] });

    await useTransactionStore.getState().processTransaction({
      type: 'repayment',
      amount: 400,
      loanId: 'loan-1',
      destinationAccountId: 'bank',
    });

    expect(useAccountStore.getState().getAccount('bank')?.balance).toBe(500);
    const updatedLoan = useLoanStore.getState().getLoan('loan-1');
    expect(updatedLoan?.remainingAmount).toBe(600);
    expect(updatedLoan?.status).toBe('active');
  });

  it('rollback: restores source balance when the final transactionsDb.add fails', async () => {
    seedAndLoad({ id: 'cash', balance: 1000, currency: 'AED' });
    failNextTxAdd(new Error('Simulated DB failure'));

    await expect(
      useTransactionStore.getState().processTransaction({
        type: 'expense',
        amount: 300,
        sourceAccountId: 'cash',
      }),
    ).rejects.toThrow(/Simulated DB failure/);

    // After rollback, the source balance must be back to its pre-mutation value.
    expect(useAccountStore.getState().getAccount('cash')?.balance).toBe(1000);
    // And no transaction row should have been persisted.
    expect(useTransactionStore.getState().transactions).toHaveLength(0);
  });
});

// The credit-card model + loan lifecycle fixes: card credits clamp at the
// limit, paying a card bill settles its cash advances, EMI overpay covers
// later instalments, repayments are deletable (schedule follows the money),
// loans are cascade-deletable, and balances are correctable via adjustment.
describe('processTransaction — credit-card model & loan lifecycle', () => {
  const seedEmis = (loanId: string, amounts: number[]) => {
    const schedules = amounts.map((amount, i) => ({
      id: `emi-${i + 1}`,
      loanId,
      installmentNumber: i + 1,
      dueDate: `2026-0${i + 1}-15`,
      amount,
      status: 'upcoming' as const,
    }));
    useEmiStore.setState({ schedules });
    return schedules;
  };

  async function createCashAdvance(amount: number, card = 'cc', bank = 'bank') {
    const tx = await useTransactionStore.getState().processTransaction({
      type: 'loan_taken',
      amount,
      destinationAccountId: bank,
      sourceAccountId: card,
      personName: 'ENBD Credit Card',
    });
    return useLoanStore.getState().loans.find((l) => l.id === tx.relatedLoanId)!;
  }

  it('cash-advance repayment with headroom: credits the card the full amount', async () => {
    seedAndLoad({ id: 'cc', balance: 16500, currency: 'AED', type: 'credit_card', name: 'ENBD', metadata: { creditLimit: '16500' } });
    seedAndLoad({ id: 'bank', balance: 1000, currency: 'AED' });
    const loan = await createCashAdvance(1500);
    // card 15000, bank 2500

    await useTransactionStore.getState().processTransaction({
      type: 'repayment',
      amount: 900,
      loanId: loan.id,
      sourceAccountId: 'bank',
    });

    expect(useAccountStore.getState().getAccount('cc')?.balance).toBe(15900);
    expect(useAccountStore.getState().getAccount('bank')?.balance).toBe(1600);
    expect(useLoanStore.getState().getLoan(loan.id)?.remainingAmount).toBe(600);
  });

  it('cash-advance repayment when the bill was already paid: card is NOT credited again', async () => {
    seedAndLoad({ id: 'cc', balance: 16500, currency: 'AED', type: 'credit_card', name: 'ENBD', metadata: { creditLimit: '16500' } });
    seedAndLoad({ id: 'bank', balance: 2000, currency: 'AED' });
    seedAndLoad({ id: 'other-bank', balance: 20000, currency: 'AED' });
    const loan = await createCashAdvance(1500); // card 15000, bank 3500

    // User pays the bill by transfer from another account — card back at limit.
    // (This also auto-settles the loan now, so re-open it manually to recreate
    // the legacy "loan survived the bill payment" state the guard must handle.)
    await useTransactionStore.getState().processTransaction({
      type: 'transfer', amount: 1500, sourceAccountId: 'other-bank', destinationAccountId: 'cc',
    });
    expect(useAccountStore.getState().getAccount('cc')?.balance).toBe(16500);
    await useLoanStore.getState().updateLoan(loan.id, { remainingAmount: 1500, status: 'active' });

    // The forced EMI-style repayment that used to inflate the card:
    const tx = await useTransactionStore.getState().processTransaction({
      type: 'repayment',
      amount: 929.17,
      loanId: loan.id,
      sourceAccountId: 'bank',
    });

    // Card must stay at its limit — no double credit.
    expect(useAccountStore.getState().getAccount('cc')?.balance).toBe(16500);
    expect(useAccountStore.getState().getAccount('bank')?.balance).toBe(2570.83);
    expect(tx.destinationAccountId).toBeNull();
    expect(useLoanStore.getState().getLoan(loan.id)?.remainingAmount).toBe(570.83);
  });

  it('cash-advance repayment with partial headroom: clamps the credit and deletion reverses exactly it', async () => {
    seedAndLoad({ id: 'cc', balance: 16000, currency: 'AED', type: 'credit_card', name: 'ENBD', metadata: { creditLimit: '16500' } });
    seedAndLoad({ id: 'bank', balance: 5000, currency: 'AED' });
    const loan = await createCashAdvance(1500); // card 14500, bank 6500

    // Simulate external drift: someone paid the card down to 500 headroom.
    await useAccountStore.getState().updateBalance('cc', 1500); // card back to 16000

    const tx = await useTransactionStore.getState().processTransaction({
      type: 'repayment',
      amount: 900,
      loanId: loan.id,
      sourceAccountId: 'bank',
    });

    // Only the 500 headroom lands on the card.
    expect(useAccountStore.getState().getAccount('cc')?.balance).toBe(16500);
    expect(useAccountStore.getState().getAccount('bank')?.balance).toBe(5600);
    expect(tx.destinationAccountId).toBe('cc');

    await useTransactionStore.getState().deleteTransaction(tx.id);

    // Reversal debits the card by the clamped 500, not the full 900.
    expect(useAccountStore.getState().getAccount('cc')?.balance).toBe(16000);
    expect(useAccountStore.getState().getAccount('bank')?.balance).toBe(6500);
    expect(useLoanStore.getState().getLoan(loan.id)?.remainingAmount).toBe(1500);
  });

  it('paying a card bill by transfer settles the cash-advance loans it funded', async () => {
    seedAndLoad({ id: 'cc', balance: 16500, currency: 'AED', type: 'credit_card', name: 'ENBD', metadata: { creditLimit: '16500' } });
    seedAndLoad({ id: 'bank', balance: 10000, currency: 'AED' });
    const loan = await createCashAdvance(1500); // card 15000, bank 11500
    seedEmis(loan.id, [500, 500, 500]);

    await useTransactionStore.getState().processTransaction({
      type: 'transfer',
      amount: 1500,
      sourceAccountId: 'bank',
      destinationAccountId: 'cc',
    });

    // Money moved once (via the transfer)…
    expect(useAccountStore.getState().getAccount('cc')?.balance).toBe(16500);
    expect(useAccountStore.getState().getAccount('bank')?.balance).toBe(10000);
    // …and the loan record settled with it, EMIs reconciled, ledger row written.
    const settled = useLoanStore.getState().getLoan(loan.id);
    expect(settled?.remainingAmount).toBe(0);
    expect(settled?.status).toBe('settled');
    expect(useEmiStore.getState().schedules.every((e) => e.status === 'paid')).toBe(true);
    const ledgerRows = useTransactionStore.getState().transactions.filter(
      (t) => t.type === 'repayment' && t.relatedLoanId === loan.id && !t.sourceAccountId && !t.destinationAccountId,
    );
    expect(ledgerRows).toHaveLength(1);
    expect(ledgerRows[0].amount).toBe(1500);
  });

  it('partial bill payment pays the loan down partially, oldest loan first', async () => {
    seedAndLoad({ id: 'cc', balance: 16500, currency: 'AED', type: 'credit_card', name: 'ENBD', metadata: { creditLimit: '16500' } });
    seedAndLoad({ id: 'bank', balance: 10000, currency: 'AED' });
    const loan = await createCashAdvance(1500);

    await useTransactionStore.getState().processTransaction({
      type: 'transfer',
      amount: 600,
      sourceAccountId: 'bank',
      destinationAccountId: 'cc',
    });

    const after = useLoanStore.getState().getLoan(loan.id);
    expect(after?.remainingAmount).toBe(900);
    expect(after?.status).toBe('active');
  });

  it('EMI overpay: a targeted instalment payment also covers the instalments the extra reaches', async () => {
    seedAndLoad({ id: 'bank', balance: 5000, currency: 'AED' });
    const loan = {
      id: 'loan-emi', personName: 'Ali', personId: null, type: 'taken',
      totalAmount: 900, remainingAmount: 900, currency: 'AED', status: 'active',
      notes: '', createdAt: new Date().toISOString(),
    };
    seedLoan(loan);
    useLoanStore.setState({ loans: [loan as never] });
    seedEmis('loan-emi', [300, 300, 300]);

    await useTransactionStore.getState().processTransaction({
      type: 'repayment',
      amount: 600, // double one instalment
      loanId: 'loan-emi',
      sourceAccountId: 'bank',
      emiId: 'emi-1',
    });

    const statuses = useEmiStore.getState().getByLoan('loan-emi').map((e) => e.status);
    expect(statuses).toEqual(['paid', 'paid', 'upcoming']);
    expect(useLoanStore.getState().getLoan('loan-emi')?.remainingAmount).toBe(300);
  });

  it('deleting a repayment on an EMI loan works and un-marks the instalments it covered', async () => {
    seedAndLoad({ id: 'bank', balance: 5000, currency: 'AED' });
    const loan = {
      id: 'loan-emi', personName: 'Ali', personId: null, type: 'taken',
      totalAmount: 900, remainingAmount: 900, currency: 'AED', status: 'active',
      notes: '', createdAt: new Date().toISOString(),
    };
    seedLoan(loan);
    useLoanStore.setState({ loans: [loan as never] });
    seedEmis('loan-emi', [300, 300, 300]);

    const tx = await useTransactionStore.getState().processTransaction({
      type: 'repayment', amount: 600, loanId: 'loan-emi', sourceAccountId: 'bank',
    });
    expect(useEmiStore.getState().getByLoan('loan-emi').map((e) => e.status)).toEqual(['paid', 'paid', 'upcoming']);

    // The old blanket guard threw here; deletion must now reverse everything.
    await useTransactionStore.getState().deleteTransaction(tx.id);

    expect(useAccountStore.getState().getAccount('bank')?.balance).toBe(5000);
    expect(useLoanStore.getState().getLoan('loan-emi')?.remainingAmount).toBe(900);
    expect(useEmiStore.getState().getByLoan('loan-emi').map((e) => e.status)).toEqual(['upcoming', 'upcoming', 'upcoming']);
  });

  it('deleteLoanCascade: removes the loan, its rows and schedule, restoring every balance', async () => {
    seedAndLoad({ id: 'cc', balance: 16500, currency: 'AED', type: 'credit_card', name: 'ENBD', metadata: { creditLimit: '16500' } });
    seedAndLoad({ id: 'bank', balance: 10000, currency: 'AED' });
    const loan = await createCashAdvance(1500); // card 15000, bank 11500
    seedEmis(loan.id, [500, 500, 500]);
    await useTransactionStore.getState().processTransaction({
      type: 'repayment', amount: 500, loanId: loan.id, sourceAccountId: 'bank', emiId: 'emi-1',
    });
    // card 15500, bank 11000, remaining 1000

    await useTransactionStore.getState().deleteLoanCascade(loan.id);

    expect(useAccountStore.getState().getAccount('cc')?.balance).toBe(16500);
    expect(useAccountStore.getState().getAccount('bank')?.balance).toBe(10000);
    expect(useLoanStore.getState().getLoan(loan.id)).toBeUndefined();
    expect(useTransactionStore.getState().transactions).toHaveLength(0);
    expect(useEmiStore.getState().schedules).toHaveLength(0);
  });

  it('adjustment: sets the balance to the target and is reversible by delete', async () => {
    seedAndLoad({ id: 'cc', balance: 27650, currency: 'AED', type: 'credit_card', name: 'ENBD', metadata: { creditLimit: '16500' } });

    const tx = await useTransactionStore.getState().processTransaction({
      type: 'adjustment',
      amount: 0, // engine derives the delta
      accountId: 'cc',
      targetBalance: 16500,
    });

    expect(useAccountStore.getState().getAccount('cc')?.balance).toBe(16500);
    expect(tx.amount).toBe(11150);
    expect(tx.sourceAccountId).toBe('cc');

    await useTransactionStore.getState().deleteTransaction(tx.id);
    expect(useAccountStore.getState().getAccount('cc')?.balance).toBe(27650);
  });
});

// Mistake-and-recovery mechanics: Undo hardening, the delete-anyway escape,
// soft-deleted-account tolerance, transfer-delete reversing its auto-settles,
// linked-loan repayment protection, and goal self-stored contributions.
describe('deleteTransaction — recovery mechanics', () => {
  it('restoreTransaction refuses types whose money it cannot re-apply (Undo hardening)', async () => {
    seedAndLoad({ id: 'bank', balance: 1000, currency: 'AED' });
    const tx = await useTransactionStore.getState().processTransaction({
      type: 'transfer', amount: 100, sourceAccountId: 'bank', destinationAccountId: 'bank2',
    }).catch(() => null);
    // Build a fake snapshot directly — the guard must reject regardless.
    const snapshot = {
      id: 'snap-1', type: 'transfer' as const, amount: 100, currency: 'AED' as const,
      sourceAccountId: 'bank', destinationAccountId: 'bank2', relatedPerson: null,
      personId: null, relatedLoanId: null, relatedGoalId: null, conversionRate: null,
      category: '', notes: '', createdAt: new Date().toISOString(),
    };
    await expect(useTransactionStore.getState().restoreTransaction(snapshot)).rejects.toThrow(/only supported/i);
    void tx;
  });

  it('blocked delete carries the escape code, and allowNegative completes it', async () => {
    seedAndLoad({ id: 'bank', balance: 0, currency: 'AED' });
    const income = await useTransactionStore.getState().processTransaction({
      type: 'income', amount: 500, destinationAccountId: 'bank',
    });
    await useTransactionStore.getState().processTransaction({
      type: 'expense', amount: 400, sourceAccountId: 'bank',
    });

    // 100 left < 500 to reverse → blocked, with the typed escape code.
    await expect(useTransactionStore.getState().deleteTransaction(income.id))
      .rejects.toMatchObject({ code: 'REVERSAL_NEEDS_NEGATIVE' });
    expect(useAccountStore.getState().getAccount('bank')?.balance).toBe(100);

    await useTransactionStore.getState().deleteTransaction(income.id, { allowNegative: true });
    expect(useAccountStore.getState().getAccount('bank')?.balance).toBe(-400);
    expect(useTransactionStore.getState().transactions.find((t) => t.id === income.id)).toBeUndefined();
  });

  it('deleting a row whose account was since (soft-)deleted skips the leg instead of stranding the row', async () => {
    seedAndLoad({ id: 'bank', balance: 1000, currency: 'AED' });
    const tx = await useTransactionStore.getState().processTransaction({
      type: 'expense', amount: 200, sourceAccountId: 'bank',
    });
    // Simulate the account being retired: gone from the live store.
    useAccountStore.setState((s) => ({ accounts: s.accounts.filter((a) => a.id !== 'bank') }));

    await useTransactionStore.getState().deleteTransaction(tx.id);
    expect(useTransactionStore.getState().transactions).toHaveLength(0);
  });

  it('deleting a card-bill transfer re-opens the cash-advance loans it auto-settled', async () => {
    seedAndLoad({ id: 'cc', balance: 16500, currency: 'AED', type: 'credit_card', name: 'ENBD', metadata: { creditLimit: '16500' } });
    seedAndLoad({ id: 'bank', balance: 10000, currency: 'AED' });
    const advance = await useTransactionStore.getState().processTransaction({
      type: 'loan_taken', amount: 1500, destinationAccountId: 'bank', sourceAccountId: 'cc', personName: 'ENBD Card',
    });
    const loanId = advance.relatedLoanId!;
    const billPay = await useTransactionStore.getState().processTransaction({
      type: 'transfer', amount: 1500, sourceAccountId: 'bank', destinationAccountId: 'cc',
    });
    expect(useLoanStore.getState().getLoan(loanId)?.status).toBe('settled');

    await useTransactionStore.getState().deleteTransaction(billPay.id);

    // Loan re-opened, ledger row gone, balances back to post-advance state.
    const loan = useLoanStore.getState().getLoan(loanId);
    expect(loan?.status).toBe('active');
    expect(loan?.remainingAmount).toBe(1500);
    expect(useAccountStore.getState().getAccount('cc')?.balance).toBe(15000);
    expect(useAccountStore.getState().getAccount('bank')?.balance).toBe(11500);
    expect(
      useTransactionStore.getState().transactions.filter((t) => t.type === 'repayment' && t.relatedLoanId === loanId),
    ).toHaveLength(0);
  });

  it('repayments on an ACTIVE linked loan cannot be deleted one-sided', async () => {
    seedAndLoad({ id: 'bank', balance: 5000, currency: 'AED' });
    const loan = {
      id: 'linked-1', personName: 'Maryam', personId: null, type: 'taken',
      totalAmount: 1000, remainingAmount: 1000, currency: 'AED', status: 'active',
      notes: '', createdAt: new Date().toISOString(), loanPairId: 'pair-1',
    };
    seedLoan(loan);
    useLoanStore.setState({ loans: [loan as never] });
    const tx = await useTransactionStore.getState().processTransaction({
      type: 'repayment', amount: 300, loanId: 'linked-1', sourceAccountId: 'bank',
    });

    await expect(useTransactionStore.getState().deleteTransaction(tx.id)).rejects.toThrow(/linked/i);
  });
});

describe('goal contributions — self-stored + rollback', () => {
  const seedGoal = (over: Record<string, unknown> = {}) => {
    const goal = {
      id: 'goal-1', title: 'Umrah', targetAmount: 10000, savedAmount: 0,
      currency: 'AED' as const, storedInAccountId: '', createdAt: new Date().toISOString(),
      targetDate: null, ...over,
    };
    useGoalStore.setState({ goals: [goal as never] });
    return goal;
  };

  it('contributing FROM the storedIn account moves no balances — record only, and delete reverses only the goal', async () => {
    seedAndLoad({ id: 'hbl', balance: 30000, currency: 'AED' });
    seedGoal({ storedInAccountId: 'hbl' });

    const tx = await useTransactionStore.getState().processTransaction({
      type: 'goal_contribution', amount: 20000, sourceAccountId: 'hbl', goalId: 'goal-1',
    });

    // The money physically stayed in HBL — no debit.
    expect(useAccountStore.getState().getAccount('hbl')?.balance).toBe(30000);
    expect(useGoalStore.getState().getGoal('goal-1')?.savedAmount).toBe(20000);

    await useTransactionStore.getState().deleteTransaction(tx.id);
    expect(useAccountStore.getState().getAccount('hbl')?.balance).toBe(30000);
    expect(useGoalStore.getState().getGoal('goal-1')?.savedAmount).toBe(0);
  });

  it('rollback restores the exact prior savedAmount (snapshot, not delta)', async () => {
    seedAndLoad({ id: 'bank', balance: 5000, currency: 'AED' });
    seedGoal({ savedAmount: 750 });
    failNextTxAdd(new Error('Simulated DB failure'));

    await expect(
      useTransactionStore.getState().processTransaction({
        type: 'goal_contribution', amount: 500, sourceAccountId: 'bank', goalId: 'goal-1',
      }),
    ).rejects.toThrow(/Simulated/);

    expect(useGoalStore.getState().getGoal('goal-1')?.savedAmount).toBe(750);
    expect(useAccountStore.getState().getAccount('bank')?.balance).toBe(5000);
  });
});

// Audit C10 / F-2. loans.remainingAmount is never written as an absolute
// figure any more — every change (forward AND rollback) goes through the
// apply_loan_remaining_delta compare-and-swap. The mock RPC above enforces the
// same expected-value check the server does, so these drive the real ladder in
// src/lib/loanRemainingDelta.ts through the full_tracker money path.
describe('full_tracker repayment — loan optimistic lock', () => {
  const seedGivenLoan = (remaining = 2000) => {
    const loan = {
      id: 'loan-race', personName: 'Bilal', personId: null, type: 'given',
      totalAmount: 2000, remainingAmount: remaining, currency: 'AED',
      status: 'active', notes: '', createdAt: new Date().toISOString(),
    };
    seedLoan(loan);
    useLoanStore.setState({ loans: [loan as never] });
    return loan;
  };

  it('retries against server truth when another device moved the loan and it still covers the payment', async () => {
    seedAndLoad({ id: 'bank', balance: 0, currency: 'AED' });
    seedGivenLoan(2000);
    // Another device already collected 500; our store still shows 2000.
    remoteLoanDelta('loan-race', -500);

    await useTransactionStore.getState().processTransaction({
      type: 'repayment', amount: 300, loanId: 'loan-race', destinationAccountId: 'bank',
    });

    // 1500 − 300, NOT 2000 − 300: the other device's payment survived.
    expect(remoteLoan('loan-race')?.remainingAmount).toBe(1200);
    expect(useLoanStore.getState().getLoan('loan-race')?.remainingAmount).toBe(1200);
    expect(useAccountStore.getState().getAccount('bank')?.balance).toBe(300);
    expect(useTransactionStore.getState().transactions).toHaveLength(1);
  });

  it('refuses — and unwinds every leg — when the refreshed loan can no longer absorb the payment', async () => {
    seedAndLoad({ id: 'bank', balance: 0, currency: 'AED' });
    seedGivenLoan(2000);
    // Settled elsewhere down to 100. Applying 900 would clamp, leaving the
    // account leg and the transaction row overstating the loan's reduction.
    remoteLoanDelta('loan-race', -1900);

    await expect(
      useTransactionStore.getState().processTransaction({
        type: 'repayment', amount: 900, loanId: 'loan-race', destinationAccountId: 'bank',
      }),
    ).rejects.toThrow(/another device|kisi aur device/i);

    expect(remoteLoan('loan-race')?.remainingAmount).toBe(100);
    expect(useAccountStore.getState().getAccount('bank')?.balance).toBe(0);
    expect(useTransactionStore.getState().transactions).toHaveLength(0);
  });

  it('rollback gives back only what it took — a concurrent repayment is not clobbered', async () => {
    seedAndLoad({ id: 'bank', balance: 0, currency: 'AED' });
    seedGivenLoan(2000);
    // Their 200 lands in the window between our loan write and our rollback.
    // The old snapshot compensation restored a flat 2000 here, erasing it.
    failNextTxAdd(new Error('Simulated DB failure'), () => remoteLoanDelta('loan-race', -200));

    await expect(
      useTransactionStore.getState().processTransaction({
        type: 'repayment', amount: 300, loanId: 'loan-race', destinationAccountId: 'bank',
      }),
    ).rejects.toThrow(/Simulated DB failure/);

    // 2000 − 300 (ours) − 200 (theirs) + 300 (our rollback) = 1800.
    expect(remoteLoan('loan-race')?.remainingAmount).toBe(1800);
    expect(useAccountStore.getState().getAccount('bank')?.balance).toBe(0);
    expect(useTransactionStore.getState().transactions).toHaveLength(0);
  });
});

describe('processTransaction — investments', () => {
  it('buy same-currency: debits total cost including fees and creates the trade row', async () => {
    seedAndLoad({ id: 'aed-bank', balance: 10000, currency: 'AED' });
    seedMarket({ id: 'dfm', name: 'DFM', currency: 'AED' });

    const tx = await useTransactionStore.getState().processTransaction({
      type: 'investment_buy',
      amount: 0, // engine computes the real cash amount
      marketId: 'dfm',
      symbol: 'emaar',
      quantity: 500,
      pricePerUnit: 2.5,
      fees: 15,
      sourceAccountId: 'aed-bank',
    });

    // 500 × 2.50 + 15 = 1265
    expect(tx.amount).toBe(1265);
    expect(tx.type).toBe('investment_buy');
    expect(tx.relatedInvestmentId).toBeTruthy();
    expect(useAccountStore.getState().getAccount('aed-bank')?.balance).toBe(8735);

    const trades = useInvestmentStore.getState().trades;
    expect(trades).toHaveLength(1);
    expect(trades[0].symbol).toBe('EMAAR'); // uppercased
    expect(trades[0].transactionId).toBe(tx.id);
    expect(trades[0].accountId).toBe('aed-bank');
  });

  it('buy cross-currency: rate = market-per-account (divide) — PKR stock from AED account', async () => {
    seedAndLoad({ id: 'aed-bank', balance: 1000, currency: 'AED' });
    seedMarket({ id: 'psx', name: 'PSX', currency: 'PKR' });

    const tx = await useTransactionStore.getState().processTransaction({
      type: 'investment_buy',
      amount: 0,
      marketId: 'psx',
      symbol: 'HBL',
      quantity: 100,
      pricePerUnit: 76,
      fees: 50,
      sourceAccountId: 'aed-bank',
      conversionRate: 76.5, // 1 AED = 76.5 PKR → rate is market-per-account
    });

    // Total PKR 7650; AED deducted = 7650 / 76.5 = 100
    expect(tx.amount).toBe(7650);
    expect(tx.currency).toBe('PKR');
    expect(useAccountStore.getState().getAccount('aed-bank')?.balance).toBe(900);
  });

  it('sell same-currency: credits net proceeds after fees and stamps the trade', async () => {
    seedAndLoad({ id: 'aed-bank', balance: 0, currency: 'AED' });
    seedMarket({ id: 'dfm', name: 'DFM', currency: 'AED' });
    // Existing position: 500 EMAAR (outside-Hisaab buy so no balance involved)
    useInvestmentStore.setState((s) => ({
      trades: [...s.trades, {
        id: 'buy-1', marketId: 'dfm', symbol: 'EMAAR', name: '', kind: 'buy' as const,
        quantity: 500, pricePerUnit: 2.0, amount: 0, fees: 0, accountId: null,
        transactionId: null, tradedAt: '2026-01-01T00:00:00Z', notes: '',
        createdAt: '2026-01-01T00:00:00Z',
      }],
    }));

    const tx = await useTransactionStore.getState().processTransaction({
      type: 'investment_sell',
      amount: 0,
      marketId: 'dfm',
      symbol: 'EMAAR',
      quantity: 200,
      pricePerUnit: 2.6,
      fees: 10,
      destinationAccountId: 'aed-bank',
    });

    // 200 × 2.60 − 10 = 510
    expect(tx.amount).toBe(510);
    expect(useAccountStore.getState().getAccount('aed-bank')?.balance).toBe(510);
    expect(useInvestmentStore.getState().trades).toHaveLength(2);
  });

  it('oversell: throws before any balance moves', async () => {
    seedAndLoad({ id: 'aed-bank', balance: 100, currency: 'AED' });
    seedMarket({ id: 'dfm', name: 'DFM', currency: 'AED' });

    await expect(
      useTransactionStore.getState().processTransaction({
        type: 'investment_sell',
        amount: 0,
        marketId: 'dfm',
        symbol: 'EMAAR',
        quantity: 50,
        pricePerUnit: 2,
        fees: 0,
        destinationAccountId: 'aed-bank',
      }),
    ).rejects.toThrow(/only hold 0/);

    expect(useAccountStore.getState().getAccount('aed-bank')?.balance).toBe(100);
    expect(useInvestmentStore.getState().trades).toHaveLength(0);
    expect(useTransactionStore.getState().transactions).toHaveLength(0);
  });

  it('dividend: credits gross minus fees', async () => {
    seedAndLoad({ id: 'pkr-bank', balance: 0, currency: 'PKR' });
    seedMarket({ id: 'psx', name: 'PSX', currency: 'PKR' });

    const tx = await useTransactionStore.getState().processTransaction({
      type: 'investment_dividend',
      amount: 0,
      marketId: 'psx',
      symbol: 'HBL',
      grossAmount: 1000,
      fees: 150, // withholding
      destinationAccountId: 'pkr-bank',
    });

    expect(tx.amount).toBe(850);
    expect(useAccountStore.getState().getAccount('pkr-bank')?.balance).toBe(850);
    const trade = useInvestmentStore.getState().trades[0];
    expect(trade.kind).toBe('dividend');
    expect(trade.amount).toBe(1000); // gross stored on the trade row
  });

  it('delete buy: refunds the source exactly, including cross-currency', async () => {
    seedAndLoad({ id: 'aed-bank', balance: 1000, currency: 'AED' });
    seedMarket({ id: 'psx', name: 'PSX', currency: 'PKR' });

    const tx = await useTransactionStore.getState().processTransaction({
      type: 'investment_buy',
      amount: 0,
      marketId: 'psx',
      symbol: 'HBL',
      quantity: 100,
      pricePerUnit: 76,
      fees: 50,
      sourceAccountId: 'aed-bank',
      conversionRate: 76.5,
    });
    expect(useAccountStore.getState().getAccount('aed-bank')?.balance).toBe(900);

    await useTransactionStore.getState().deleteTransaction(tx.id, { allowInvestment: true });

    expect(useAccountStore.getState().getAccount('aed-bank')?.balance).toBe(1000);
    expect(useInvestmentStore.getState().trades).toHaveLength(0);
    expect(useTransactionStore.getState().transactions).toHaveLength(0);
  });

  it('delete without allowInvestment: redirects to the Investments screen', async () => {
    seedAndLoad({ id: 'aed-bank', balance: 10000, currency: 'AED' });
    seedMarket({ id: 'dfm', name: 'DFM', currency: 'AED' });

    const tx = await useTransactionStore.getState().processTransaction({
      type: 'investment_buy',
      amount: 0,
      marketId: 'dfm',
      symbol: 'EMAAR',
      quantity: 10,
      pricePerUnit: 2,
      fees: 0,
      sourceAccountId: 'aed-bank',
    });

    await expect(
      useTransactionStore.getState().deleteTransaction(tx.id),
    ).rejects.toThrow(/Investments screen/);
  });

  it('deleteTrade guard: blocks deleting a buy that a later sell depends on', async () => {
    seedAndLoad({ id: 'aed-bank', balance: 10000, currency: 'AED' });
    seedMarket({ id: 'dfm', name: 'DFM', currency: 'AED' });

    const buyTx = await useTransactionStore.getState().processTransaction({
      type: 'investment_buy', amount: 0, marketId: 'dfm', symbol: 'EMAAR',
      quantity: 100, pricePerUnit: 2, fees: 0, sourceAccountId: 'aed-bank',
    });
    await useTransactionStore.getState().processTransaction({
      type: 'investment_sell', amount: 0, marketId: 'dfm', symbol: 'EMAAR',
      quantity: 80, pricePerUnit: 2.5, fees: 0, destinationAccountId: 'aed-bank',
    });

    const buyTrade = useInvestmentStore.getState().trades.find((t) => t.transactionId === buyTx.id);
    expect(buyTrade).toBeTruthy();
    await expect(useInvestmentStore.getState().deleteTrade(buyTrade!.id)).rejects.toThrow(/delete the newer sell/i);
  });
});

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// Bounded history load (docs/performance.md Â§7)
//
// `loadTransactions()` used to be a keyset walk of the user's ENTIRE
// transactions table, on every boot, every money write and every realtime
// nudge. It now fetches a window and publishes what that window PROVES, so a
// consumer that needs the whole history has to ask for it.
//
// These run against the same in-memory DAL as everything above. The Dexie
// mirror is unavailable under Node, which is itself worth exercising: the
// store must still end up holding the rows the server returned.
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

/** A bare server row, planted directly (never through processTransaction). */
function historyRow(id: string, createdAt: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    type: 'expense',
    amount: 10,
    currency: 'AED',
    sourceAccountId: 'cash-1',
    destinationAccountId: null,
    createdAt,
    updatedAt: createdAt,
    ...extra,
  };
}

const MONTHS_AGO = (n: number) => {
  const d = new Date();
  d.setUTCMonth(d.getUTCMonth() - n);
  return d.toISOString();
};

/**
 * 1200 rows inside the window + `ancient` rows well outside it. The count is
 * deliberate: it clears HISTORY_MIN_ROWS (1000), so the row floor stops
 * mattering and the DATE floor is what bounds the fetch.
 */
function seedHeavyHistory(ancient: number, rowExtra: Record<string, unknown> = {}) {
  for (let i = 0; i < 1200; i += 1) {
    // Spread across the last ~6 months, comfortably inside the 12-month window.
    const at = new Date(Date.now() - i * 4 * 60 * 60 * 1000).toISOString();
    seedTransaction(historyRow(`recent-${String(i).padStart(4, '0')}`, at, rowExtra));
  }
  for (let i = 0; i < ancient; i += 1) {
    seedTransaction(historyRow(`ancient-${i}`, MONTHS_AGO(30 + i * 6), rowExtra));
  }
}

describe('loadTransactions â€” the bounded default', () => {
  it('a heavy user gets the window, not the whole table, and coverage says so', async () => {
    seedHeavyHistory(5);

    await useTransactionStore.getState().loadTransactions();

    const state = useTransactionStore.getState();
    // Everything inside the window, plus the one row the pager had to read to
    // learn it was past the date floor. NOT the four remaining ancient rows.
    expect(state.transactions.length).toBeGreaterThanOrEqual(1200);
    expect(state.transactions.length).toBeLessThan(1205);
    expect(state.historyCoverage.complete).toBe(false);
    expect(state.historyCoverage.since).toBeTruthy();
    expect(historyCalls().window).toBe(1);
    expect(historyCalls().all).toBe(0);
  });

  it('a sparse user gets their WHOLE history and coverage comes back complete', async () => {
    // The row floor reaches past the date floor: three lifetime entries, one of
    // them five years old, all fetched. This is the common case, and it is why
    // the bound is not a regression for most users.
    seedTransaction(historyRow('t-new', new Date().toISOString()));
    seedTransaction(historyRow('t-mid', MONTHS_AGO(8)));
    seedTransaction(historyRow('t-old', MONTHS_AGO(60)));

    await useTransactionStore.getState().loadTransactions();

    const state = useTransactionStore.getState();
    expect(state.transactions.map((t) => t.id).sort()).toEqual(['t-mid', 't-new', 't-old']);
    expect(state.historyCoverage).toEqual({ since: null, complete: true });
  });

  it('an explicit `since` widens the fetch for that call', async () => {
    seedHeavyHistory(5);

    await useTransactionStore.getState().loadTransactions({ since: MONTHS_AGO(120) });

    const state = useTransactionStore.getState();
    // Reaching past every ancient row means the walk hit the end of the table.
    expect(state.transactions).toHaveLength(1205);
    expect(state.historyCoverage.complete).toBe(true);
  });

  it('never narrows an established floor â€” a reload after "show full history" stays full', async () => {
    seedHeavyHistory(5);
    await useTransactionStore.getState().ensureTransactionHistory({ all: true });
    expect(useTransactionStore.getState().historyCoverage.complete).toBe(true);

    resetHistoryCalls();
    // The reload a money write or a realtime nudge triggers.
    await useTransactionStore.getState().loadTransactions();

    const state = useTransactionStore.getState();
    expect(state.historyCoverage.complete).toBe(true);
    expect(state.transactions).toHaveLength(1205);
    // It took the ALL path, not the window path â€” the user is not silently
    // demoted back to 12 months by a background refresh.
    expect(historyCalls().all).toBe(1);
    expect(historyCalls().window).toBe(0);
  });

  it('reset() drops the coverage claim along with the rows', async () => {
    seedTransaction(historyRow('t-new', new Date().toISOString()));
    await useTransactionStore.getState().loadTransactions();
    expect(useTransactionStore.getState().historyCoverage.complete).toBe(true);

    useTransactionStore.getState().reset();

    expect(useTransactionStore.getState().historyCoverage).toEqual({ since: null, complete: false });
    expect(useTransactionStore.getState().transactions).toHaveLength(0);
  });
});

describe('ensureTransactionHistory', () => {
  it('merges older rows in WITHOUT dropping the newer ones already held', async () => {
    seedHeavyHistory(5);
    await useTransactionStore.getState().loadTransactions();
    const before = useTransactionStore.getState().transactions;
    const newestBefore = before[0].id;

    await useTransactionStore.getState().ensureTransactionHistory({ all: true });

    const after = useTransactionStore.getState().transactions;
    expect(after).toHaveLength(1205);
    // Every ancient row arrived...
    for (let i = 0; i < 5; i += 1) {
      expect(after.some((t) => t.id === `ancient-${i}`)).toBe(true);
    }
    // ...and nothing that was already on screen was replaced away.
    expect(after[0].id).toBe(newestBefore);
    for (const row of before) {
      expect(after.some((t) => t.id === row.id)).toBe(true);
    }
    expect(useTransactionStore.getState().historyCoverage).toEqual({ since: null, complete: true });
  });

  it('is a no-op once coverage already answers the request â€” no second round-trip', async () => {
    seedHeavyHistory(5);
    await useTransactionStore.getState().ensureTransactionHistory({ all: true });
    resetHistoryCalls();

    await useTransactionStore.getState().ensureTransactionHistory({ all: true });
    await useTransactionStore.getState().ensureTransactionHistory({ since: MONTHS_AGO(120) });

    expect(historyCalls()).toEqual({ all: 0, window: 0, range: 0 });
  });

  it('a `{ since }` request fetches only the GAP below the current floor', async () => {
    seedHeavyHistory(5);
    await useTransactionStore.getState().loadTransactions();
    resetHistoryCalls();
    const wanted = MONTHS_AGO(37);

    await useTransactionStore.getState().ensureTransactionHistory({ since: wanted });

    // The range fetcher, not the whole-table one.
    expect(historyCalls().range).toBe(1);
    expect(historyCalls().all).toBe(0);
    const state = useTransactionStore.getState();
    // ancient-0 (30 months) and ancient-1 (36 months) are inside the request;
    // ancient-2 (42 months) is not and must NOT have been dragged in.
    expect(state.transactions.some((t) => t.id === 'ancient-0')).toBe(true);
    expect(state.transactions.some((t) => t.id === 'ancient-1')).toBe(true);
    expect(state.transactions.some((t) => t.id === 'ancient-2')).toBe(false);
    // The floor widened to exactly what was asked for, and nobody claimed
    // completeness on the strength of it.
    expect(state.historyCoverage.complete).toBe(false);
    expect(state.historyCoverage.since).toBe(wanted);

    // A later, narrower request is now answered from coverage alone.
    resetHistoryCalls();
    await useTransactionStore.getState().ensureTransactionHistory({ since: MONTHS_AGO(2) });
    expect(historyCalls()).toEqual({ all: 0, window: 0, range: 0 });
  });

  it('concurrent callers share ONE walk', async () => {
    seedHeavyHistory(5);
    await useTransactionStore.getState().loadTransactions();
    resetHistoryCalls();

    // Home, a statement sheet and the person backfill all mounting at once.
    await Promise.all([
      useTransactionStore.getState().ensureTransactionHistory({ all: true }),
      useTransactionStore.getState().ensureTransactionHistory({ all: true }),
      useTransactionStore.getState().ensureTransactionHistory({ all: true }),
    ]);

    expect(historyCalls().all).toBe(1);
    expect(useTransactionStore.getState().historyCoverage.complete).toBe(true);
  });

  it('a locally-written row survives an older-history merge', async () => {
    // The row exists only in the store (mid-mutation); the fetch cannot know
    // about it. Merging must not delete it.
    seedHeavyHistory(2);
    await useTransactionStore.getState().loadTransactions();
    useTransactionStore.setState((s) => ({
      transactions: [
        historyRow('local-only', new Date().toISOString()) as never,
        ...s.transactions,
      ],
    }));

    await useTransactionStore.getState().ensureTransactionHistory({ all: true });

    expect(useTransactionStore.getState().transactions.some((t) => t.id === 'local-only')).toBe(true);
  });
});

describe('bounded history â€” both app modes', () => {
  // A splits_only row has BOTH account ids null. The window is purely
  // createdAt-based and reads no account id anywhere, so the two modes must
  // produce identical results from identical rows.
  const runBoth = async (mode: 'full_tracker' | 'splits_only') => {
    resetDb();
    useTransactionStore.setState({
      transactions: [],
      loading: false,
      historyCoverage: emptyCoverage(),
      historyLoading: false,
    });
    useAppModeStore.setState({ mode });
    const ledgerFields = mode === 'splits_only'
      ? { sourceAccountId: null, destinationAccountId: null }
      : {};
    seedHeavyHistory(5, ledgerFields);

    await useTransactionStore.getState().loadTransactions();
    const windowed = useTransactionStore.getState();
    const windowedCount = windowed.transactions.length;
    const windowedComplete = windowed.historyCoverage.complete;

    await useTransactionStore.getState().ensureTransactionHistory({ all: true });
    const full = useTransactionStore.getState();

    return {
      windowedCount,
      windowedComplete,
      fullCount: full.transactions.length,
      fullComplete: full.historyCoverage.complete,
      hasAncient: full.transactions.some((t) => t.id === 'ancient-4'),
    };
  };

  it('windows and merges identically in full_tracker and splits_only', async () => {
    const tracked = await runBoth('full_tracker');
    const ledger = await runBoth('splits_only');
    expect(ledger).toEqual(tracked);
    expect(ledger.fullCount).toBe(1205);
    expect(ledger.fullComplete).toBe(true);
    expect(ledger.hasAncient).toBe(true);
  });

  it('a ledger-only row with BOTH account ids null is windowed by date, never filtered out', async () => {
    useAppModeStore.setState({ mode: 'splits_only' });
    seedTransaction(historyRow('ledger-recent', new Date().toISOString(), {
      type: 'repayment', sourceAccountId: null, destinationAccountId: null,
    }));
    seedTransaction(historyRow('ledger-ancient', MONTHS_AGO(40), {
      type: 'repayment', sourceAccountId: null, destinationAccountId: null,
    }));

    await useTransactionStore.getState().loadTransactions();

    const rows = useTransactionStore.getState().transactions;
    expect(rows.map((t) => t.id).sort()).toEqual(['ledger-ancient', 'ledger-recent']);
    expect(rows.every((t) => t.sourceAccountId === null && t.destinationAccountId === null)).toBe(true);
  });
});

