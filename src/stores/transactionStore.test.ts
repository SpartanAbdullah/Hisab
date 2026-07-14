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

  return {
    __seedAccount: (a: { id: string; balance: number; name?: string; type?: string; currency?: string }) => {
      accounts.set(a.id, {
        id: a.id,
        balance: a.balance,
        name: a.name ?? a.id,
        type: a.type ?? 'cash',
        currency: a.currency ?? 'AED',
        metadata: {},
        createdAt: new Date().toISOString(),
      });
    },
    __seedLoan: (l: Record<string, unknown>) => loans.set(l.id as string, l),
    __failNextTxAdd: (err: Error) => { nextTxAddThrows = err; },
    __reset: () => {
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
      async add(l: Record<string, unknown>) { loans.set(l.id as string, l); },
      async update(id: string, changes: Record<string, unknown>) {
        const cur = loans.get(id);
        if (cur) loans.set(id, { ...cur, ...changes });
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

// Loose-typed accessors on the mock module — these are added by vi.mock above
// but TypeScript doesn't know about them.
const seedAccount = (mockDb as unknown as { __seedAccount: (a: { id: string; balance: number; name?: string; type?: string; currency?: string }) => void }).__seedAccount;
const seedLoan = (mockDb as unknown as { __seedLoan: (l: Record<string, unknown>) => void }).__seedLoan;
const failNextTxAdd = (mockDb as unknown as { __failNextTxAdd: (err: Error) => void }).__failNextTxAdd;
const resetDb = (mockDb as unknown as { __reset: () => void }).__reset;

beforeEach(async () => {
  resetDb();
  // Reset every store touched by processTransaction.
  useAccountStore.setState({ accounts: [], loading: false });
  useTransactionStore.setState({ transactions: [], loading: false });
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

function seedAndLoad(account: { id: string; balance: number; currency?: string; type?: 'cash' | 'bank' | 'digital_wallet' | 'savings' | 'credit_card'; name?: string }) {
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
        metadata: {},
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
    ).rejects.toThrow(/sirf|nahi/i);

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
