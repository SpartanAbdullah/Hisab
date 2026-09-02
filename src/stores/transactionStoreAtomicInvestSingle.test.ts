// L4 step 5: processTransaction's four SINGLE-LEG branches (income, expense,
// opening_balance, adjustment) with VITE_ATOMIC_SINGLE_LEG=true, the three
// INVESTMENT branches with VITE_ATOMIC_INVEST=true, and the goal
// compensation's own compare-and-swap (`apply_goal_saved_delta`), which is
// reached from the already-flagged VITE_ATOMIC_GOAL path.
//
// Why a separate file rather than more cases in transactionStore.test.ts: the
// flags are read from import.meta.env at module load, so they have to be
// stubbed BEFORE the store is imported — which needs a dynamic import, which
// needs its own module registry. Vitest gives each test file one.
// transactionStore.test.ts therefore keeps proving the legacy paths unchanged,
// and this file proves the flagged ones.
//
// The mock RPCs below reproduce
// supabase-migration-p3-atomic-investments-and-single-leg.sql: the balance
// compare-and-swap, the adjustment that SETS its target inside the lock and
// derives its own |delta| there, the per-kind cash derivation, the asymmetric
// currency convention (buy DIVIDES, sell and dividend MULTIPLY), the oversell
// replay, the trade-id collision, idempotent replay — and, the whole point,
// all-or-nothing: neither ever applies one artifact without the rest.
//
// Coverage:
//   SINGLE LEG
//    1. expense — ONE server call moves the balance and writes the row
//    2. income and opening_balance credit, and are never balance-guarded
//    3. adjustment UP — the server SETS the target; the row's leg follows it
//    4. adjustment DOWN — the account lands on the SOURCE leg
//    5. adjustment adopts the SERVER's magnitude after a conflict retry
//    6. BALANCE_CONFLICT → refetch the accounts and retry once
//    7. …and a conflict writes NOTHING
//    8. a failure AFTER the RPC unwinds the balance and the row
//    9. INSUFFICIENT_BALANCE surfaces as the user-facing string
//   10. splits_only sends allowNegative and the expense goes negative
//   11. a replayed transaction id moves the money once
//   INVESTMENT
//   12. buy — one call: the debit, the trade row and the money row
//   13. sell — credits, and fees NET rather than capitalise
//   14. dividend — GROSS on the trade, NET on the row and the wallet
//   15. cross-currency buy DIVIDES; sell MULTIPLIES
//   16. the CLIENT's oversell guard still refuses before any round-trip
//   17. the SERVER's oversell refusal writes nothing and is never retried
//   18. BALANCE_CONFLICT → refetch and retry once
//   19. a failure AFTER the RPC unwinds all THREE artifacts
//   20. a replay adopts the SERVER's trade id, not the local one
//   GOAL COMPENSATION
//   21. the goal inverse goes through apply_goal_saved_delta
//   22. …and falls back to the legacy unlocked write when the RPC is absent

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/supabaseDb', async () => {
  const accounts = new Map<string, { id: string; balance: number; name: string; type: string; currency: string; metadata: Record<string, string>; createdAt: string }>();
  const transactions = new Map<string, Record<string, unknown>>();
  const loans = new Map<string, Record<string, unknown>>();
  const emis = new Map<string, Record<string, unknown>>();
  const goals = new Map<string, Record<string, unknown>>();
  const activities = new Map<string, Record<string, unknown>>();
  const markets = new Map<string, Record<string, unknown>>();
  const trades = new Map<string, Record<string, unknown>>();

  let nextTxAddThrows: Error | null = null;
  let goalDeltaThrows: Error | null = null;
  const rpcCalls: Array<{ fn: string; input: Record<string, unknown> }> = [];

  const round2 = (n: number) => Math.round(n * 100) / 100;
  const coded = (code: string, message?: string) => {
    const err = new Error(message ?? code) as Error & { code: string };
    err.code = code;
    return err;
  };
  const conflict = (balance: number) => {
    const err = coded('BALANCE_CONFLICT') as Error & { code: string; accountBalance: number };
    err.accountBalance = balance;
    return err;
  };
  const rejected = (token: string) => {
    const err = coded('TRADE_REJECTED', 'That trade couldn\'t be recorded') as Error & {
      code: string; serverToken: string;
    };
    err.serverToken = token;
    return err;
  };
  const insufficient = (name: string, available: number, requested: number) =>
    coded('INSUFFICIENT_BALANCE', `${name} only has ${available} — that's less than ${requested}.`);

  // The server's half of investmentMath.simulateTimeline, over the stored rows.
  const oversells = (
    marketId: string, symbol: string,
    candidate: { id: string; quantity: number; tradedAt: string; createdAt: string },
  ): { held: number } | null => {
    const scoped = Array.from(trades.values()).filter(
      (t) => t.marketId === marketId && t.symbol === symbol,
    ) as Array<Record<string, unknown>>;
    const order: Record<string, number> = { buy: 0, dividend: 1, sell: 2 };
    const rows = [
      ...scoped.map((t) => ({
        id: t.id as string, kind: t.kind as string, quantity: Number(t.quantity),
        tradedAt: t.tradedAt as string, createdAt: t.createdAt as string,
      })),
      { id: candidate.id, kind: 'sell', quantity: candidate.quantity, tradedAt: candidate.tradedAt, createdAt: candidate.createdAt },
    ].sort((a, b) =>
      a.tradedAt.localeCompare(b.tradedAt)
      || order[a.kind] - order[b.kind]
      || a.createdAt.localeCompare(b.createdAt)
      || a.id.localeCompare(b.id));

    let held = 0;
    for (const r of rows) {
      if (r.kind === 'buy') held += r.quantity;
      else if (r.kind === 'sell') {
        if (r.quantity > held + 1e-9) return { held };
        held -= r.quantity;
      }
    }
    return null;
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
    __seedMarket: (m: Record<string, unknown>) => { markets.set(m.id as string, m); },
    __seedTrade: (t: Record<string, unknown>) => { trades.set(t.id as string, t); },
    __seedGoal: (g: Record<string, unknown>) => { goals.set(g.id as string, g); },
    __remoteBalanceDelta: (id: string, delta: number) => {
      const cur = accounts.get(id);
      if (cur) accounts.set(id, { ...cur, balance: round2(cur.balance + delta) });
    },
    __remoteGoalSaved: (id: string, saved: number) => {
      const cur = goals.get(id);
      if (cur) goals.set(id, { ...cur, savedAmount: saved });
    },
    __failNextTxAdd: (err: Error) => { nextTxAddThrows = err; },
    __failGoalDelta: (err: Error | null) => { goalDeltaThrows = err; },
    __rpcCalls: () => rpcCalls,
    __getAccount: (id: string) => accounts.get(id),
    __getGoal: (id: string) => goals.get(id),
    __getTrade: (id: string) => trades.get(id),
    __getTrades: () => Array.from(trades.values()),
    __getTransactions: () => Array.from(transactions.values()),
    __reset: () => {
      accounts.clear(); transactions.clear(); loans.clear();
      emis.clear(); goals.clear(); activities.clear();
      markets.clear(); trades.clear();
      rpcCalls.length = 0;
      nextTxAddThrows = null;
      goalDeltaThrows = null;
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

    investmentMarketsDb: {
      async getAll() { return Array.from(markets.values()); },
      async add(m: Record<string, unknown>) { markets.set(m.id as string, m); },
    },
    investmentTradesDb: {
      async getAll() { return Array.from(trades.values()); },
      async add(t: Record<string, unknown>) { trades.set(t.id as string, t); },
      async delete(id: string) { trades.delete(id); },
    },
    investmentPricesDb: {
      async getAll() { return []; },
      async upsert() { /* prices are never written by the money engine */ },
    },

    atomicMoneyDb: {
      async transferAtomic() { throw new Error('transferAtomic is not under test in this file'); },
      async repaymentAtomic() { throw new Error('repaymentAtomic is not under test in this file'); },
      async loanCreateAtomic() { throw new Error('loanCreateAtomic is not under test in this file'); },
      async payCardBillAtomic() { throw new Error('payCardBillAtomic is not under test in this file'); },

      // ── RPC 1: record_single_leg_entry, in memory ────────────────────────
      // Faithful to Section 1 of the migration. Every refusal happens BEFORE
      // the first mutation; the two writes happen together at the end.
      async singleLegAtomic(input: Record<string, unknown>) {
        rpcCalls.push({ fn: 'record_single_leg_entry', input });
        const txId = input.transactionId as string;
        const acctId = input.accountId as string;
        const type = input.type as string;

        const existing = transactions.get(txId);
        if (existing) {
          return {
            replay: true, transactionId: txId, type: existing.type as string,
            accountBalance: accounts.get(acctId)!.balance, accountDelta: 0,
            amount: Number(existing.amount), currency: existing.currency as string,
          };
        }

        if (!acctId || !acctId.trim()) throw coded('ACCOUNT_NOT_FOUND');
        const acct = accounts.get(acctId);
        if (!acct) throw coded('ACCOUNT_NOT_FOUND');

        if (round2(acct.balance) !== round2(input.expectedBalance as number)) {
          throw conflict(acct.balance);
        }

        let delta: number;
        let amount: number;
        if (type === 'adjustment') {
          // Derived from the LOCKED row, never from the caller's snapshot.
          delta = round2((input.targetBalance as number) - acct.balance);
          if (Math.abs(delta) < 0.005) throw coded('NOTHING_TO_CORRECT');
          amount = Math.abs(delta);
          if (input.amount != null && Math.abs(round2(input.amount as number) - amount) > 0.01) {
            throw coded('AMOUNT_MISMATCH');
          }
        } else if (type === 'expense') {
          amount = input.amount as number;
          delta = -round2(amount);
        } else {
          amount = input.amount as number;
          delta = round2(amount);
        }

        // EXPENSE only — income/opening_balance credit, adjustment is unguarded.
        if (type === 'expense' && input.allowNegative !== true
            && acct.balance < round2(input.amount as number)) {
          throw insufficient(acct.name, acct.balance, round2(input.amount as number));
        }

        const newBal = type === 'adjustment'
          ? (input.targetBalance as number)
          : round2(acct.balance + delta);
        accounts.set(acctId, { ...acct, balance: newBal });
        transactions.set(txId, {
          id: txId, type, amount, currency: acct.currency,
          sourceAccountId: delta < 0 ? acctId : null,
          destinationAccountId: delta > 0 ? acctId : null,
          relatedPerson: null, personId: null, relatedLoanId: null,
          relatedGoalId: null, relatedInvestmentId: null, conversionRate: null,
          category: input.category, notes: input.note,
          createdAt: input.createdAt, isReconciled: false,
        });

        return {
          replay: false, transactionId: txId, type,
          accountBalance: newBal, accountDelta: round2(newBal - acct.balance),
          amount, currency: acct.currency,
        };
      },

      // ── RPC 2: record_investment_trade, in memory ────────────────────────
      async investmentTradeAtomic(input: Record<string, unknown>) {
        rpcCalls.push({ fn: 'record_investment_trade', input });
        const txId = input.transactionId as string;
        const acctId = input.accountId as string;
        const kind = input.kind as 'buy' | 'sell' | 'dividend';

        const existing = transactions.get(txId);
        if (existing) {
          return {
            replay: true, transactionId: txId,
            // The trade the FIRST call minted, never this retry's id.
            tradeId: existing.relatedInvestmentId as string,
            kind, symbol: input.symbol as string,
            accountBalance: accounts.get(acctId)!.balance, accountDelta: 0,
            amount: Number(existing.amount), currency: existing.currency as string,
            conversionRate: (existing.conversionRate as number) ?? null,
          };
        }

        if (!acctId || !acctId.trim()) throw coded('ACCOUNT_NOT_FOUND');
        const acct = accounts.get(acctId);
        if (!acct) throw coded('ACCOUNT_NOT_FOUND');
        const market = markets.get(input.marketId as string);
        if (!market) throw rejected('MARKET_NOT_FOUND');
        if (trades.has(input.tradeId as string)) throw rejected('TRADE_ID_COLLISION');

        const symbol = (input.symbol as string).trim().toUpperCase();
        const qty = Number(input.quantity ?? 0);
        const price = Number(input.pricePerUnit ?? 0);
        const fees = Number(input.fees ?? 0);
        const gross = Number(input.grossAmount ?? 0);

        const derived = kind === 'buy' ? round2(round2(qty * price) + fees)
          : kind === 'sell' ? round2(round2(qty * price) - fees)
          : round2(gross - fees);
        if (Math.abs(round2(input.amount as number) - derived) > 0.01) {
          throw rejected('TRADE_AMOUNT_MISMATCH');
        }

        if (kind === 'sell') {
          const bad = oversells(input.marketId as string, symbol, {
            id: input.tradeId as string, quantity: qty,
            tradedAt: input.tradedAt as string, createdAt: input.tradeCreatedAt as string,
          });
          if (bad) throw rejected('INSUFFICIENT_HOLDINGS');
        }

        const cross = kind === 'dividend'
          ? acct.currency !== market.currency
          : acct.currency !== market.currency && derived > 0;
        const rate = input.conversionRate as number | null;
        if (cross && !rate) throw rejected('ACCOUNT_AMOUNT_MISMATCH');
        const acctAmount = cross
          ? (kind === 'buy' ? round2(derived / rate!) : round2(derived * rate!))
          : derived;
        if (Math.abs(round2(input.accountAmount as number) - acctAmount) > 0.01) {
          throw rejected('ACCOUNT_AMOUNT_MISMATCH');
        }

        if (round2(acct.balance) !== round2(input.expectedBalance as number)) {
          throw conflict(acct.balance);
        }
        if (kind === 'buy' && input.allowNegative !== true && acct.balance < acctAmount) {
          throw insufficient(acct.name, acct.balance, acctAmount);
        }

        // ── The three writes, together ──────────────────────────────────────
        const delta = kind === 'buy' ? -acctAmount : acctAmount;
        const newBal = round2(acct.balance + delta);
        accounts.set(acctId, { ...acct, balance: newBal });
        trades.set(input.tradeId as string, {
          id: input.tradeId, marketId: input.marketId, symbol,
          name: kind === 'dividend' ? '' : (input.companyName as string),
          kind,
          quantity: kind === 'dividend' ? 0 : qty,
          pricePerUnit: kind === 'dividend' ? 0 : price,
          amount: kind === 'dividend' ? gross : 0,
          fees, accountId: acctId, transactionId: txId,
          tradedAt: input.tradedAt, notes: input.tradeNotes,
          createdAt: input.tradeCreatedAt,
        });
        transactions.set(txId, {
          id: txId, type: `investment_${kind}`, amount: derived,
          currency: market.currency,
          sourceAccountId: kind === 'buy' ? acctId : null,
          destinationAccountId: kind === 'buy' ? null : acctId,
          relatedPerson: null, personId: null, relatedLoanId: null,
          relatedGoalId: null, relatedInvestmentId: input.tradeId,
          conversionRate: rate ?? null,
          category: input.category, notes: input.note,
          createdAt: input.createdAt, isReconciled: false,
        });

        return {
          replay: false, transactionId: txId, tradeId: input.tradeId as string,
          kind, symbol, accountBalance: newBal, accountDelta: delta,
          amount: derived, currency: market.currency as string,
          conversionRate: rate ?? null,
        };
      },

      // ── RPC 3: apply_goal_saved_delta, in memory ─────────────────────────
      async goalSavedDelta(goalId: string, delta: number, expectedSaved: number) {
        rpcCalls.push({ fn: 'apply_goal_saved_delta', input: { goalId, delta, expectedSaved } });
        if (goalDeltaThrows) throw goalDeltaThrows;
        const goal = goals.get(goalId);
        if (!goal) throw coded('GOAL_NOT_FOUND');
        const before = Number(goal.savedAmount ?? 0);
        if (round2(before) !== round2(expectedSaved)) {
          const err = coded('BALANCE_CONFLICT') as Error & { code: string; goalSavedAmount: number };
          err.goalSavedAmount = before;
          throw err;
        }
        const next = Math.max(0, round2(before + delta));
        goals.set(goalId, { ...goal, savedAmount: next });
        return { goalId, goalSavedAmount: next, goalApplied: round2(next - before) };
      },

      // ── Step 4's contribute_to_goal, only far enough to reach the inverse ─
      async goalContributeAtomic(input: Record<string, unknown>) {
        rpcCalls.push({ fn: 'contribute_to_goal', input });
        const txId = input.transactionId as string;
        const goalId = input.goalId as string;
        const srcId = input.sourceAccountId as string;
        const amount = round2(input.amount as number);
        const src = accounts.get(srcId);
        if (!src) throw coded('ACCOUNT_NOT_FOUND');
        const goal = goals.get(goalId);
        if (!goal) throw coded('GOAL_NOT_FOUND');
        const savedBefore = Number(goal.savedAmount ?? 0);
        const newSaved = Math.max(0, round2(savedBefore + amount));
        goals.set(goalId, { ...goal, savedAmount: newSaved });
        const newSrc = round2(src.balance - amount);
        accounts.set(srcId, { ...src, balance: newSrc });
        transactions.set(txId, {
          id: txId, type: 'goal_contribution', amount, currency: goal.currency,
          sourceAccountId: srcId, destinationAccountId: null,
          relatedGoalId: goalId, conversionRate: null,
          category: input.category, notes: input.note,
          createdAt: input.createdAt, isReconciled: false,
        });
        return {
          replay: false, transactionId: txId, goalId,
          goalSavedAmount: newSaved, goalApplied: round2(newSaved - savedBefore),
          sourceBalance: newSrc, sourceDelta: -amount,
          linkedAccountId: null, linkedBalance: null, linkedDelta: null,
          currency: goal.currency as string, selfStored: false,
        };
      },
    },
  };
});

// The flags are read at module-evaluation time, so they must be stubbed before
// the store is imported — hence the dynamic imports below.
vi.stubEnv('VITE_ATOMIC_SINGLE_LEG', 'true');
vi.stubEnv('VITE_ATOMIC_INVEST', 'true');
vi.stubEnv('VITE_ATOMIC_GOAL', 'true');

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
type SeedAccount = { id: string; balance: number; name?: string; type?: string; currency?: string; metadata?: Record<string, string> };

const m = mockDb as unknown as {
  __seedAccount: (a: SeedAccount) => void;
  __seedMarket: (x: Record<string, unknown>) => void;
  __seedTrade: (x: Record<string, unknown>) => void;
  __seedGoal: (g: Record<string, unknown>) => void;
  __remoteBalanceDelta: (id: string, d: number) => void;
  __remoteGoalSaved: (id: string, s: number) => void;
  __failNextTxAdd: (err: Error) => void;
  __failGoalDelta: (err: Error | null) => void;
  __rpcCalls: () => Array<{ fn: string; input: Record<string, unknown> }>;
  __getAccount: (id: string) => { balance: number } | undefined;
  __getGoal: (id: string) => Record<string, unknown> | undefined;
  __getTrade: (id: string) => Record<string, unknown> | undefined;
  __getTrades: () => Array<Record<string, unknown>>;
  __getTransactions: () => Array<Record<string, unknown>>;
  __reset: () => void;
};

function seedAndLoad(account: SeedAccount) {
  m.__seedAccount(account);
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

function seedMarket(mk: { id: string; name?: string; currency?: string }) {
  const row = {
    id: mk.id,
    name: mk.name ?? 'DFM',
    currency: mk.currency ?? 'AED',
    createdAt: '2026-01-01T00:00:00.000Z',
  };
  m.__seedMarket(row);
  useInvestmentStore.setState((s) => ({ markets: [...s.markets, row as never] }));
}

function seedTrade(t: {
  id: string; marketId: string; symbol: string; kind: 'buy' | 'sell' | 'dividend';
  quantity?: number; pricePerUnit?: number; amount?: number; fees?: number;
  tradedAt?: string; createdAt?: string;
}) {
  const row = {
    id: t.id, marketId: t.marketId, symbol: t.symbol, name: '', kind: t.kind,
    quantity: t.quantity ?? 0, pricePerUnit: t.pricePerUnit ?? 0,
    amount: t.amount ?? 0, fees: t.fees ?? 0,
    accountId: null, transactionId: null,
    tradedAt: t.tradedAt ?? '2026-01-01T00:00:00.000Z',
    notes: '',
    createdAt: t.createdAt ?? t.tradedAt ?? '2026-01-01T00:00:00.000Z',
  };
  m.__seedTrade(row);
  useInvestmentStore.setState((s) => ({ trades: [row as never, ...s.trades] }));
}

function seedGoal(goal: { id: string; savedAmount?: number; currency?: string }) {
  const row = {
    id: goal.id, title: 'Umrah', targetAmount: 10000,
    savedAmount: goal.savedAmount ?? 0, currency: goal.currency ?? 'AED',
    storedInAccountId: '', createdAt: '2026-01-01T00:00:00.000Z', targetDate: null,
  };
  m.__seedGoal(row);
  useGoalStore.setState((s) => ({ goals: [...s.goals, row as never] }));
}

const rpcNames = () => m.__rpcCalls().map((c) => c.fn);

beforeEach(() => {
  m.__reset();
  useAccountStore.setState({ accounts: [], loading: false });
  useTransactionStore.setState({ transactions: [], loading: false });
  useLoanStore.setState({ loans: [], loading: false });
  useGoalStore.setState({ goals: [], loading: false });
  useEmiStore.setState({ schedules: [], loading: false });
  useAppModeStore.setState({ mode: 'full_tracker' });
  useActivityStore.setState({ activities: [], loading: false });
  useInvestmentStore.setState({ markets: [], trades: [], prices: [], loading: false } as unknown as Loose);
});

// ════════════════════════════════════════════════════════════════════════════
// SINGLE LEG — VITE_ATOMIC_SINGLE_LEG=true
// ════════════════════════════════════════════════════════════════════════════
describe('processTransaction — the four single-leg branches via the atomic RPC', () => {
  it('expense: ONE server call moves the balance AND writes the row', async () => {
    seedAndLoad({ id: 'bank', balance: 1000, name: 'Bank' });

    const tx = await useTransactionStore.getState().processTransaction({
      type: 'expense', amount: 100, sourceAccountId: 'bank', category: 'Food', notes: 'chai',
    });

    expect(useAccountStore.getState().getAccount('bank')?.balance).toBe(900);
    expect(m.__getAccount('bank')?.balance).toBe(900);
    expect(tx.sourceAccountId).toBe('bank');
    expect(tx.destinationAccountId).toBeNull();
    // ONE round-trip, not "a balance write and then a row write".
    expect(rpcNames()).toEqual(['record_single_leg_entry']);
    expect(m.__getTransactions()).toHaveLength(1);
  });

  it('income and opening_balance credit, and are never balance-guarded', async () => {
    seedAndLoad({ id: 'jar', balance: 0, name: 'Jar' });

    await useTransactionStore.getState().processTransaction({
      type: 'income', amount: 750, destinationAccountId: 'jar',
    });
    expect(m.__getAccount('jar')?.balance).toBe(750);

    await useTransactionStore.getState().processTransaction({
      type: 'opening_balance', amount: 50, destinationAccountId: 'jar',
    });
    expect(m.__getAccount('jar')?.balance).toBe(800);

    const legs = m.__rpcCalls().filter((c) => c.fn === 'record_single_leg_entry');
    expect(legs.map((c) => c.input.allowNegative)).toEqual([false, false]);
  });

  it('adjustment UP: the server SETS the target and the row follows its delta', async () => {
    seedAndLoad({ id: 'bank', balance: 900, name: 'Bank' });

    const tx = await useTransactionStore.getState().processTransaction({
      type: 'adjustment', amount: 0, accountId: 'bank', targetBalance: 1000,
    });

    expect(m.__getAccount('bank')?.balance).toBe(1000);
    expect(tx.amount).toBe(100);
    expect(tx.destinationAccountId).toBe('bank');
    expect(tx.sourceAccountId).toBeNull();
  });

  it('adjustment DOWN: the account lands on the SOURCE leg', async () => {
    seedAndLoad({ id: 'bank', balance: 1000, name: 'Bank' });

    const tx = await useTransactionStore.getState().processTransaction({
      type: 'adjustment', amount: 0, accountId: 'bank', targetBalance: 750,
    });

    expect(m.__getAccount('bank')?.balance).toBe(750);
    expect(tx.amount).toBe(250);
    expect(tx.sourceAccountId).toBe('bank');
    expect(tx.destinationAccountId).toBeNull();
  });

  it('adjustment adopts the SERVER magnitude after a conflict retry — the row agrees with the money', async () => {
    seedAndLoad({ id: 'bank', balance: 1000, name: 'Bank' });
    // Another device already spent 200. The local snapshot says 1000, so the
    // branch derives |delta| = 200; the server, holding the row, derives 400.
    m.__remoteBalanceDelta('bank', -200);

    const tx = await useTransactionStore.getState().processTransaction({
      type: 'adjustment', amount: 0, accountId: 'bank', targetBalance: 1200,
    });

    expect(m.__getAccount('bank')?.balance).toBe(1200);
    expect(tx.amount).toBe(400);
    expect(tx.destinationAccountId).toBe('bank');
    expect(rpcNames()).toEqual(['record_single_leg_entry', 'record_single_leg_entry']);
  });

  it('BALANCE_CONFLICT: refetch the accounts and retry once', async () => {
    seedAndLoad({ id: 'bank', balance: 1000, name: 'Bank' });
    m.__remoteBalanceDelta('bank', -300);

    await useTransactionStore.getState().processTransaction({
      type: 'expense', amount: 100, sourceAccountId: 'bank',
    });

    expect(m.__getAccount('bank')?.balance).toBe(600);
    expect(useAccountStore.getState().getAccount('bank')?.balance).toBe(600);
    expect(rpcNames()).toHaveLength(2);
  });

  it('a conflict writes NOTHING — the retry has nothing to compensate', async () => {
    seedAndLoad({ id: 'bank', balance: 1000, name: 'Bank' });
    m.__remoteBalanceDelta('bank', -300);

    await useTransactionStore.getState().processTransaction({
      type: 'expense', amount: 100, sourceAccountId: 'bank',
    });

    // One row, one net movement: 700 − 100. Never 700 − 200.
    expect(m.__getTransactions()).toHaveLength(1);
    expect(m.__getAccount('bank')?.balance).toBe(600);
  });

  it('a failure AFTER the RPC unwinds the balance and the row together', async () => {
    seedAndLoad({ id: 'bank', balance: 1000, name: 'Bank' });
    m.__failNextTxAdd(new Error('mirror upsert died'));

    await expect(useTransactionStore.getState().processTransaction({
      type: 'expense', amount: 100, sourceAccountId: 'bank',
    })).rejects.toThrow();

    expect(m.__getAccount('bank')?.balance).toBe(1000);
    expect(m.__getTransactions()).toHaveLength(0);
    expect(useTransactionStore.getState().transactions).toHaveLength(0);
  });

  it('INSUFFICIENT_BALANCE never reaches the RPC — the client guard still fires first', async () => {
    seedAndLoad({ id: 'cash', balance: 250, name: 'Cash' });

    await expect(useTransactionStore.getState().processTransaction({
      type: 'expense', amount: 10000, sourceAccountId: 'cash',
    })).rejects.toThrow(/only has/);

    expect(rpcNames()).toHaveLength(0);
    expect(m.__getAccount('cash')?.balance).toBe(250);
  });

  it('splits_only sends allowNegative, and the expense goes negative', async () => {
    useAppModeStore.setState({ mode: 'splits_only' });
    seedAndLoad({ id: 'cash', balance: 250, name: 'Cash' });

    await useTransactionStore.getState().processTransaction({
      type: 'expense', amount: 450, sourceAccountId: 'cash',
    });

    expect(m.__rpcCalls()[0].input.allowNegative).toBe(true);
    expect(m.__getAccount('cash')?.balance).toBe(-200);
  });

  it('a replayed transaction id moves the money exactly once', async () => {
    seedAndLoad({ id: 'bank', balance: 1000, name: 'Bank' });

    const tx = await useTransactionStore.getState().processTransaction({
      type: 'expense', amount: 100, sourceAccountId: 'bank',
    });

    // The reply was dropped and the same call is retried with the same id.
    const replay = await mockDb.atomicMoneyDb.singleLegAtomic({
      transactionId: tx.id, type: 'expense', accountId: 'bank',
      amount: 100, targetBalance: null, note: '', category: '',
      createdAt: tx.createdAt, expectedBalance: 999999, allowNegative: false,
    });

    expect(replay.replay).toBe(true);
    expect(replay.accountDelta).toBe(0);
    expect(m.__getAccount('bank')?.balance).toBe(900);
    expect(m.__getTransactions()).toHaveLength(1);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// INVESTMENTS — VITE_ATOMIC_INVEST=true
// ════════════════════════════════════════════════════════════════════════════
describe('processTransaction — investment trades via the atomic RPC', () => {
  it('buy: ONE call debits the wallet, writes the trade AND writes the money row', async () => {
    seedAndLoad({ id: 'bank', balance: 5000, name: 'Bank' });
    seedMarket({ id: 'm1', currency: 'AED' });

    const tx = await useTransactionStore.getState().processTransaction({
      type: 'investment_buy', amount: 0, marketId: 'm1', symbol: ' emaar ',
      companyName: 'Emaar', quantity: 100, pricePerUnit: 10, fees: 5,
      sourceAccountId: 'bank',
    });

    // qty x price PLUS fees — buy fees are CAPITALIZED.
    expect(m.__getAccount('bank')?.balance).toBe(3995);
    expect(tx.amount).toBe(1005);
    expect(tx.sourceAccountId).toBe('bank');
    expect(tx.relatedInvestmentId).toBeTruthy();
    expect(tx.category).toBe('Investments');

    const trade = m.__getTrade(tx.relatedInvestmentId!);
    expect(trade).toBeTruthy();
    expect(trade!.symbol).toBe('EMAAR');
    expect(trade!.quantity).toBe(100);
    // The DERIVED position lives in one place only, and the store holds
    // exactly one row for it.
    expect(useInvestmentStore.getState().trades).toHaveLength(1);
    expect(rpcNames()).toEqual(['record_investment_trade']);
  });

  it('sell: fees NET rather than capitalise, and the wallet is credited', async () => {
    seedAndLoad({ id: 'bank', balance: 1000, name: 'Bank' });
    seedMarket({ id: 'm1', currency: 'AED' });
    seedTrade({ id: 'old', marketId: 'm1', symbol: 'EMAAR', kind: 'buy', quantity: 100, pricePerUnit: 10 });

    const tx = await useTransactionStore.getState().processTransaction({
      type: 'investment_sell', amount: 0, marketId: 'm1', symbol: 'EMAAR',
      quantity: 40, pricePerUnit: 12, fees: 3,
      destinationAccountId: 'bank',
    });

    expect(tx.amount).toBe(477);
    expect(m.__getAccount('bank')?.balance).toBe(1477);
    expect(tx.destinationAccountId).toBe('bank');
    expect(tx.sourceAccountId).toBeNull();
  });

  it('dividend: the GROSS is stored on the trade, the NET reaches the wallet', async () => {
    seedAndLoad({ id: 'bank', balance: 1000, name: 'Bank' });
    seedMarket({ id: 'm1', currency: 'AED' });

    const tx = await useTransactionStore.getState().processTransaction({
      type: 'investment_dividend', amount: 0, marketId: 'm1', symbol: 'EMAAR',
      grossAmount: 200, fees: 20, destinationAccountId: 'bank',
    });

    expect(tx.amount).toBe(180);
    expect(m.__getAccount('bank')?.balance).toBe(1180);
    const trade = m.__getTrade(tx.relatedInvestmentId!)!;
    expect(trade.amount).toBe(200);
    expect(trade.quantity).toBe(0);
    expect(trade.name).toBe('');
  });

  it('cross-currency: a buy DIVIDES and a sell MULTIPLIES — never one convention for both', async () => {
    seedAndLoad({ id: 'bank', balance: 5000, name: 'Bank', currency: 'AED' });
    seedMarket({ id: 'pk', currency: 'PKR' });

    await useTransactionStore.getState().processTransaction({
      type: 'investment_buy', amount: 0, marketId: 'pk', symbol: 'OGDC',
      quantity: 100, pricePerUnit: 76.5, fees: 0,
      sourceAccountId: 'bank', conversionRate: 76.5,
    });
    // round(7650 / 76.5, 2) = 100 leaves the AED wallet.
    expect(m.__getAccount('bank')?.balance).toBe(4900);

    await useTransactionStore.getState().processTransaction({
      type: 'investment_sell', amount: 0, marketId: 'pk', symbol: 'OGDC',
      quantity: 50, pricePerUnit: 76.5, fees: 0,
      destinationAccountId: 'bank', conversionRate: 0.01307,
    });
    // round(3825 x 0.01307, 2) = 49.99 arrives — note it is NOT the exact
    // inverse of the buy, because the two rates are independent inputs and each
    // conversion rounds once at 2dp. Asserting the rounded figure rather than a
    // "clean" one is the point: the client and the server must agree on THIS
    // number, and they do (the RPC re-derives it and refuses a disagreement).
    expect(m.__getAccount('bank')?.balance).toBe(4949.99);
  });

  it('the CLIENT oversell guard still refuses before any round-trip', async () => {
    seedAndLoad({ id: 'bank', balance: 1000, name: 'Bank' });
    seedMarket({ id: 'm1', currency: 'AED' });
    seedTrade({ id: 'old', marketId: 'm1', symbol: 'EMAAR', kind: 'buy', quantity: 10, pricePerUnit: 10 });

    await expect(useTransactionStore.getState().processTransaction({
      type: 'investment_sell', amount: 0, marketId: 'm1', symbol: 'EMAAR',
      quantity: 500, pricePerUnit: 12, fees: 0, destinationAccountId: 'bank',
    })).rejects.toThrow(/only hold/);

    // On 3G a refusal that costs a round-trip is a refusal the user waits for.
    expect(rpcNames()).toHaveLength(0);
    expect(m.__getAccount('bank')?.balance).toBe(1000);
  });

  it('the SERVER oversell refusal writes nothing, and is never retried', async () => {
    seedAndLoad({ id: 'bank', balance: 1000, name: 'Bank' });
    seedMarket({ id: 'm1', currency: 'AED' });
    // The local store thinks 100 are held; the server knows the buy is gone
    // (deleted on another device), so only the server can catch this one.
    useInvestmentStore.setState((s) => ({
      trades: [{
        id: 'ghost', marketId: 'm1', symbol: 'EMAAR', name: '', kind: 'buy',
        quantity: 100, pricePerUnit: 10, amount: 0, fees: 0,
        accountId: null, transactionId: null,
        tradedAt: '2026-01-01T00:00:00.000Z', notes: '',
        createdAt: '2026-01-01T00:00:00.000Z',
      } as never, ...s.trades],
    }));

    await expect(useTransactionStore.getState().processTransaction({
      type: 'investment_sell', amount: 0, marketId: 'm1', symbol: 'EMAAR',
      quantity: 40, pricePerUnit: 12, fees: 0, destinationAccountId: 'bank',
    })).rejects.toThrow();

    expect(rpcNames()).toEqual(['record_investment_trade']);   // never retried
    expect(m.__getAccount('bank')?.balance).toBe(1000);
    expect(m.__getTrades()).toHaveLength(0);
    expect(m.__getTransactions()).toHaveLength(0);
  });

  it('BALANCE_CONFLICT: refetch the accounts and retry once', async () => {
    seedAndLoad({ id: 'bank', balance: 5000, name: 'Bank' });
    seedMarket({ id: 'm1', currency: 'AED' });
    m.__remoteBalanceDelta('bank', -1000);

    await useTransactionStore.getState().processTransaction({
      type: 'investment_buy', amount: 0, marketId: 'm1', symbol: 'EMAAR',
      quantity: 10, pricePerUnit: 10, fees: 0, sourceAccountId: 'bank',
    });

    expect(m.__getAccount('bank')?.balance).toBe(3900);
    expect(rpcNames()).toHaveLength(2);
    // The conflicting first attempt left NO trade behind, or the retry would
    // have collided with its own orphan.
    expect(m.__getTrades()).toHaveLength(1);
  });

  it('a failure AFTER the RPC unwinds all THREE artifacts', async () => {
    seedAndLoad({ id: 'bank', balance: 5000, name: 'Bank' });
    seedMarket({ id: 'm1', currency: 'AED' });
    m.__failNextTxAdd(new Error('mirror upsert died'));

    await expect(useTransactionStore.getState().processTransaction({
      type: 'investment_buy', amount: 0, marketId: 'm1', symbol: 'EMAAR',
      quantity: 10, pricePerUnit: 10, fees: 0, sourceAccountId: 'bank',
    })).rejects.toThrow();

    expect(m.__getAccount('bank')?.balance).toBe(5000);
    expect(m.__getTrades()).toHaveLength(0);
    expect(m.__getTransactions()).toHaveLength(0);
    expect(useInvestmentStore.getState().trades).toHaveLength(0);
  });

  it('a replay adopts the SERVER trade id, not the one this attempt generated', async () => {
    seedAndLoad({ id: 'bank', balance: 5000, name: 'Bank' });
    seedMarket({ id: 'm1', currency: 'AED' });

    const first = await useTransactionStore.getState().processTransaction({
      type: 'investment_buy', amount: 0, marketId: 'm1', symbol: 'EMAAR',
      quantity: 10, pricePerUnit: 10, fees: 0, sourceAccountId: 'bank',
    });

    const replay = await mockDb.atomicMoneyDb.investmentTradeAtomic({
      transactionId: first.id, tradeId: 'a-brand-new-id', kind: 'buy',
      marketId: 'm1', symbol: 'EMAAR', companyName: '',
      quantity: 10, pricePerUnit: 10, grossAmount: 0, fees: 0,
      accountId: 'bank', amount: 100, accountAmount: 100, conversionRate: null,
      note: '', category: 'Investments', createdAt: first.createdAt,
      tradedAt: first.createdAt, tradeNotes: '', tradeCreatedAt: first.createdAt,
      expectedBalance: 999999, allowNegative: false,
    });

    expect(replay.replay).toBe(true);
    expect(replay.tradeId).toBe(first.relatedInvestmentId);
    expect(replay.tradeId).not.toBe('a-brand-new-id');
    expect(m.__getTrades()).toHaveLength(1);
    expect(m.__getAccount('bank')?.balance).toBe(4900);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// THE GOAL COMPENSATION — apply_goal_saved_delta (doc §23 item 6)
// ════════════════════════════════════════════════════════════════════════════
describe('the goal contribution inverse', () => {
  it('reverses goals.saved_amount through the compare-and-swap RPC', async () => {
    seedAndLoad({ id: 'bank', balance: 1000, name: 'Bank' });
    seedGoal({ id: 'g1', savedAmount: 500 });
    m.__failNextTxAdd(new Error('mirror upsert died'));

    await expect(useTransactionStore.getState().processTransaction({
      type: 'goal_contribution', amount: 200, sourceAccountId: 'bank', goalId: 'g1',
    })).rejects.toThrow();

    // The forward move and the rollback both landed: 500 → 700 → 500.
    expect(m.__getGoal('g1')?.savedAmount).toBe(500);
    expect(useGoalStore.getState().getGoal('g1')?.savedAmount).toBe(500);
    expect(rpcNames()).toContain('apply_goal_saved_delta');
    const call = m.__rpcCalls().find((c) => c.fn === 'apply_goal_saved_delta')!;
    expect(call.input.delta).toBe(-200);
    expect(call.input.expectedSaved).toBe(700);
  });

  it('falls back to the legacy unlocked write when the CAS RPC is unavailable', async () => {
    seedAndLoad({ id: 'bank', balance: 1000, name: 'Bank' });
    seedGoal({ id: 'g1', savedAmount: 500 });
    // A project that has step 4's migration but not step 5's. A rollback that
    // REFUSES to run would be strictly worse than one that races.
    const missing = new Error('apply_goal_saved_delta is not available') as Error & { code: string };
    missing.code = 'ATOMIC_GOAL_UNAVAILABLE';
    m.__failGoalDelta(missing);
    m.__failNextTxAdd(new Error('mirror upsert died'));

    await expect(useTransactionStore.getState().processTransaction({
      type: 'goal_contribution', amount: 200, sourceAccountId: 'bank', goalId: 'g1',
    })).rejects.toThrow();

    expect(m.__getGoal('g1')?.savedAmount).toBe(500);
  });
});
