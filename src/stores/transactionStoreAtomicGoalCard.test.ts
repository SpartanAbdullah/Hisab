// L4 step 4: processTransaction's `goal_contribution` branch with
// VITE_ATOMIC_GOAL=true, and the whole credit-card story — the transfer
// branch's bill-payment tail AND the cash-advance repayment that credits the
// card — with VITE_ATOMIC_CARD_BILL=true.
//
// Why a separate file rather than more cases in transactionStore.test.ts: the
// two flags are read from import.meta.env at module load, so they have to be
// stubbed BEFORE the store is imported — which needs a dynamic import, which
// needs its own module registry. Vitest gives each test file one.
// transactionStore.test.ts therefore keeps proving the legacy paths unchanged
// (its atomicMoneyDb stubs THROW), and this file proves the flagged ones.
//
// The mock RPCs below reproduce supabase-migration-p3-atomic-goal-and-card.sql:
// the self-stored no-leg case, the stored-in credit leg derived from the GOAL,
// the goals.saved_amount compare-and-swap, the loan CAS per plan line, the
// lockstep invariant, the card headroom clamp, instalment re-validation,
// idempotent replay — and, the whole point, all-or-nothing: neither ever
// applies one leg without the rest.
//
// Coverage:
//   GOAL
//    1. tracked internally — one call debits the wallet and grows the goal
//    2. stored in another account — the credit leg lands and is the row's dest
//    3. SELF-STORED — no balance legs at all, and the note carries the flag
//    4. cross-currency DIVIDES, and the row carries the rate
//    5. it is ONE server call, not three
//    6. BALANCE_CONFLICT on the GOAL → refetch + retry once
//    7. …and a conflict writes NOTHING
//    8. a failure AFTER the RPC unwinds the balance, the goal and the row
//    9. the goal inverse is a DELTA, so it cannot clobber a concurrent add
//   10. INSUFFICIENT_BALANCE surfaces as the user-facing string
//   11. a replayed transaction id contributes once
//   CARD
//   12. paying a bill settles the advances AND writes the ledger rows, in one call
//   13. …the ledger rows carry both account ids null and the linking note
//   14. a card transfer with nothing to settle stays on the plain transfer path
//   15. a cash-advance repayment credits the card, reduces the loan, one call
//   16. the clamp: a covered bill credits nothing and stays on the legacy path
//   17. a partially clamped credit stamps cardCreditedAmount into the row
//   18. a failure AFTER the RPC unwinds both balances, the loan and every row
//   19. LOAN_REMAINING_CONFLICT → refetch, RE-PLAN, retry once
//   20. a plan that settles more than the payment credited is refused client-side
//   21. splits_only never reaches either RPC

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/supabaseDb', async () => {
  const accounts = new Map<string, { id: string; balance: number; name: string; type: string; currency: string; metadata: Record<string, string>; createdAt: string }>();
  const transactions = new Map<string, Record<string, unknown>>();
  const loans = new Map<string, Record<string, unknown>>();
  const emis = new Map<string, Record<string, unknown>>();
  const goals = new Map<string, Record<string, unknown>>();
  const activities = new Map<string, Record<string, unknown>>();

  let nextTxAddThrows: Error | null = null;
  const rpcCalls: Array<{ fn: string; input: Record<string, unknown> }> = [];

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
    __seedGoal: (g: Record<string, unknown>) => { goals.set(g.id as string, g); },
    __seedLoan: (l: Record<string, unknown>) => { loans.set(l.id as string, l); },
    __seedEmi: (e: Record<string, unknown>) => { emis.set(e.id as string, e); },
    __seedTransaction: (t: Record<string, unknown>) => { transactions.set(t.id as string, t); },
    __remoteBalanceDelta: (id: string, delta: number) => {
      const cur = accounts.get(id);
      if (cur) accounts.set(id, { ...cur, balance: round2(cur.balance + delta) });
    },
    __remoteGoalSaved: (id: string, saved: number) => {
      const cur = goals.get(id);
      if (cur) goals.set(id, { ...cur, savedAmount: saved });
    },
    __remoteLoanRemaining: (id: string, remaining: number) => {
      const cur = loans.get(id);
      if (cur) loans.set(id, { ...cur, remainingAmount: remaining });
    },
    __failNextTxAdd: (err: Error) => { nextTxAddThrows = err; },
    __rpcCalls: () => rpcCalls,
    __getAccount: (id: string) => accounts.get(id),
    __getGoal: (id: string) => goals.get(id),
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
      async repaymentAtomic() {
        throw new Error('repaymentAtomic is not under test in this file');
      },
      async loanCreateAtomic() {
        throw new Error('loanCreateAtomic is not under test in this file');
      },

      // ── RPC 1: contribute_to_goal, in memory ─────────────────────────────
      // Faithful to Section 1 of the migration. Every refusal happens BEFORE
      // the first mutation; the writes happen together at the end.
      async goalContributeAtomic(input: Record<string, unknown>) {
        rpcCalls.push({ fn: 'contribute_to_goal', input });
        const txId = input.transactionId as string;
        const goalId = input.goalId as string;
        const srcId = input.sourceAccountId as string;
        const amount = round2(input.amount as number);

        const existing = transactions.get(txId);
        if (existing) {
          return {
            replay: true, transactionId: txId, goalId,
            goalSavedAmount: Number(goals.get(goalId)?.savedAmount ?? 0),
            goalApplied: 0,
            sourceBalance: accounts.get(srcId)!.balance, sourceDelta: 0,
            linkedAccountId: (existing.destinationAccountId as string) ?? null,
            linkedBalance: null, linkedDelta: 0,
            currency: existing.currency as string,
            selfStored: existing.destinationAccountId == null,
          };
        }

        if (!srcId) throw coded('ACCOUNT_NOT_FOUND');
        const src = accounts.get(srcId);
        if (!src) throw coded('ACCOUNT_NOT_FOUND');
        const goal = goals.get(goalId);
        if (!goal) throw coded('GOAL_NOT_FOUND');

        // The server derives BOTH of these from the goal, never from the caller.
        const storedIn = ((goal.storedInAccountId as string) ?? '').trim();
        const selfStored = Boolean(storedIn) && storedIn === srcId;
        const linkedId = !selfStored && storedIn && accounts.has(storedIn) ? storedIn : null;
        const linked = linkedId ? accounts.get(linkedId)! : null;

        const srcAmount = selfStored ? 0 : round2(input.sourceAmount as number);
        if (selfStored && input.conversionRate != null) {
          throw coded('CONVERSION_RATE_NOT_APPLICABLE');
        }

        // CAS: source (only when it moves), stored-in, and the GOAL.
        if (!selfStored && round2(src.balance) !== round2(input.expectedSourceBalance as number)) {
          const err = coded('BALANCE_CONFLICT') as Error & { code: string; accountBalance: number };
          err.accountBalance = src.balance;
          throw err;
        }
        if (linked && round2(linked.balance) !== round2(input.expectedLinkedBalance as number)) {
          const err = coded('BALANCE_CONFLICT') as Error & { code: string; accountBalance: number };
          err.accountBalance = linked.balance;
          throw err;
        }
        const savedBefore = Number(goal.savedAmount ?? 0);
        if (round2(savedBefore) !== round2(input.expectedSavedAmount as number)) {
          const err = coded('BALANCE_CONFLICT') as Error & { code: string; goalSavedAmount: number };
          err.goalSavedAmount = savedBefore;
          throw err;
        }

        if (!selfStored && input.allowNegative !== true && src.balance < srcAmount) {
          throw coded('INSUFFICIENT_BALANCE', `${src.name} only has ${src.balance} — that's less than ${srcAmount}.`);
        }

        // ── The writes, together ────────────────────────────────────────────
        const newSaved = Math.max(0, round2(savedBefore + amount));
        goals.set(goalId, { ...goal, savedAmount: newSaved });

        let newSrc = src.balance;
        if (!selfStored) {
          newSrc = round2(src.balance - srcAmount);
          accounts.set(srcId, { ...src, balance: newSrc });
        }
        let newLinked: number | null = null;
        if (linked && linkedId) {
          newLinked = round2(linked.balance + amount);
          accounts.set(linkedId, { ...linked, balance: newLinked });
        }

        transactions.set(txId, {
          id: txId, type: 'goal_contribution',
          amount: input.amount, currency: goal.currency,
          sourceAccountId: srcId, destinationAccountId: linkedId,
          relatedPerson: null, personId: null, relatedLoanId: null,
          relatedGoalId: goalId,
          conversionRate: input.conversionRate ?? null,
          category: input.category, notes: input.note,
          createdAt: input.createdAt, isReconciled: false,
        });

        return {
          replay: false, transactionId: txId, goalId,
          goalSavedAmount: newSaved, goalApplied: round2(newSaved - savedBefore),
          sourceBalance: newSrc, sourceDelta: selfStored ? 0 : -srcAmount,
          linkedAccountId: linkedId, linkedBalance: newLinked,
          linkedDelta: linkedId ? amount : null,
          currency: goal.currency as string, selfStored,
        };
      },

      // ── RPC 2: pay_card_bill, in memory ──────────────────────────────────
      async payCardBillAtomic(input: Record<string, unknown>) {
        rpcCalls.push({ fn: 'pay_card_bill', input });
        const txId = input.transactionId as string;
        const rowType = input.rowType as 'transfer' | 'repayment';
        const srcId = input.sourceAccountId as string;
        const cardId = input.cardAccountId as string;
        const plan = (input.plan as Array<Record<string, unknown>>) ?? [];

        const existing = transactions.get(txId);
        if (existing) {
          return {
            replay: true, transactionId: txId, rowType,
            sourceBalance: accounts.get(srcId)!.balance, sourceDelta: 0,
            cardBalance: accounts.get(cardId)!.balance, cardDelta: 0,
            currency: existing.currency as string, settled: 0, lines: [],
          };
        }

        if (!srcId || !cardId) throw coded('ACCOUNT_NOT_FOUND');
        if (srcId === cardId) throw coded('SAME_ACCOUNT');
        const src = accounts.get(srcId);
        const card = accounts.get(cardId);
        if (!src || !card) throw coded('ACCOUNT_NOT_FOUND');
        if (card.type !== 'credit_card') throw coded('NOT_A_CREDIT_CARD');

        const srcAmount = round2(input.sourceAmount as number);
        const cardAmount = round2(input.cardAmount as number);
        const appliedSum = round2(plan.reduce((t, l) => t + Number(l.applied), 0));

        // The lockstep invariant — BILL PAYMENTS ONLY (a repayment's card
        // credit is clamped and is legitimately smaller than the reduction).
        if (rowType === 'transfer' && appliedSum > cardAmount + 0.01) {
          throw coded('PLAN_OVER_PAYMENT');
        }
        // The headroom clamp — REPAYMENTS ONLY (a direct transfer is
        // deliberately unclamped).
        if (rowType === 'repayment') {
          const limit = parseFloat(card.metadata.creditLimit || '0');
          if (limit > 0 && cardAmount > Math.max(0, round2(limit - card.balance)) + 0.01) {
            throw coded('CARD_CREDIT_OVER_LIMIT');
          }
        }

        if (round2(src.balance) !== round2(input.expectedSourceBalance as number)) {
          const err = coded('BALANCE_CONFLICT') as Error & { code: string; accountBalance: number };
          err.accountBalance = src.balance;
          throw err;
        }
        if (round2(card.balance) !== round2(input.expectedCardBalance as number)) {
          const err = coded('BALANCE_CONFLICT') as Error & { code: string; accountBalance: number };
          err.accountBalance = card.balance;
          throw err;
        }
        if (input.allowNegative !== true && src.balance < srcAmount) {
          throw coded('INSUFFICIENT_BALANCE', `${src.name} only has ${src.balance} — that's less than ${srcAmount}.`);
        }

        // Validation pass over the plan, BEFORE any write.
        for (const line of plan) {
          const loan = loans.get(line.loan_id as string);
          if (!loan) throw coded('LOAN_NOT_FOUND');
          if (loan.type !== 'taken') throw coded('PLAN_INVALID');
          const before = Number(loan.remainingAmount ?? 0);
          if (Math.round(before * 100) !== Math.round(Number(line.expected_remaining) * 100)) {
            const err = coded('LOAN_REMAINING_CONFLICT') as Error & { code: string; loanRemaining: number };
            err.loanRemaining = before;
            throw err;
          }
          for (const id of (line.emi_ids as string[]) ?? []) {
            const e = emis.get(id);
            if (!e || e.loanId !== loan.id) throw coded('EMI_SCHEDULE_INVALID');
          }
          if (line.row_id && transactions.has(line.row_id as string)) {
            throw coded('TRANSACTION_ID_COLLISION');
          }
        }

        // ── The writes, together ────────────────────────────────────────────
        const lines: Array<Record<string, unknown>> = [];
        for (const line of plan) {
          const loan = loans.get(line.loan_id as string)!;
          const before = Number(loan.remainingAmount ?? 0);
          const next = round2(Math.max(0, before - round2(Number(line.applied))));
          loans.set(loan.id as string, {
            ...loan, remainingAmount: next, status: next === 0 ? 'settled' : 'active',
          });
          const marked: string[] = [];
          for (const id of (line.emi_ids as string[]) ?? []) {
            const e = emis.get(id)!;
            if (e.status === 'paid') continue;
            emis.set(id, { ...e, status: 'paid' });
            marked.push(id);
          }
          if (line.row_id) {
            transactions.set(line.row_id as string, {
              id: line.row_id, type: 'repayment',
              amount: round2(Number(line.applied)), currency: loan.currency,
              sourceAccountId: null, destinationAccountId: null,
              relatedPerson: loan.personName, personId: loan.personId ?? null,
              relatedLoanId: loan.id, relatedGoalId: null, conversionRate: null,
              category: '', notes: line.row_note, createdAt: input.createdAt,
              isReconciled: false,
            });
          }
          lines.push({
            loanId: loan.id, applied: round2(before - next), remaining: next,
            status: next === 0 ? 'settled' : 'active', settledNow: next === 0,
            personName: loan.personName, personId: loan.personId ?? null,
            currency: loan.currency, emiMarked: marked,
            rowId: (line.row_id as string) ?? null,
          });
        }

        const newSrc = round2(src.balance - srcAmount);
        accounts.set(srcId, { ...src, balance: newSrc });
        let newCard = card.balance;
        if (cardAmount > 0) {
          newCard = round2(card.balance + cardAmount);
          accounts.set(cardId, { ...card, balance: newCard });
        }

        const mainLoan = rowType === 'repayment'
          ? loans.get(plan[0].loan_id as string)!
          : null;
        transactions.set(txId, {
          id: txId, type: rowType,
          amount: input.amount, currency: input.currency,
          sourceAccountId: srcId, destinationAccountId: cardId,
          relatedPerson: mainLoan ? mainLoan.personName : null,
          personId: mainLoan ? mainLoan.personId ?? null : null,
          relatedLoanId: mainLoan ? mainLoan.id : null,
          relatedGoalId: null,
          conversionRate: input.conversionRate ?? null,
          category: input.category, notes: input.note,
          createdAt: input.createdAt, isReconciled: false,
        });

        return {
          replay: false, transactionId: txId, rowType,
          sourceBalance: newSrc, sourceDelta: -srcAmount,
          cardBalance: newCard, cardDelta: cardAmount,
          currency: input.currency as string,
          settled: lines.length, lines,
        };
      },
    },
  };
});

// Both flags are read at module-evaluation time, so they must be stubbed before
// the store is imported — hence the dynamic imports below.
vi.stubEnv('VITE_ATOMIC_GOAL', 'true');
vi.stubEnv('VITE_ATOMIC_CARD_BILL', 'true');

const mockDb = await import('../lib/supabaseDb');
const { useAccountStore } = await import('./accountStore');
const { useTransactionStore } = await import('./transactionStore');
const { useLoanStore } = await import('./loanStore');
const { useGoalStore } = await import('./goalStore');
const { useEmiStore } = await import('./emiStore');
const { useAppModeStore } = await import('./appModeStore');
const { useActivityStore } = await import('./activityStore');
const { useInvestmentStore } = await import('./investmentStore');
const { parseInternalNote } = await import('../lib/internalNotes');

type Loose = Record<string, never>;
type SeedAccount = { id: string; balance: number; name?: string; type?: string; currency?: string; metadata?: Record<string, string> };

const m = mockDb as unknown as {
  __seedAccount: (a: SeedAccount) => void;
  __seedGoal: (g: Record<string, unknown>) => void;
  __seedLoan: (l: Record<string, unknown>) => void;
  __seedEmi: (e: Record<string, unknown>) => void;
  __seedTransaction: (t: Record<string, unknown>) => void;
  __remoteBalanceDelta: (id: string, d: number) => void;
  __remoteGoalSaved: (id: string, s: number) => void;
  __remoteLoanRemaining: (id: string, r: number) => void;
  __failNextTxAdd: (err: Error) => void;
  __rpcCalls: () => Array<{ fn: string; input: Record<string, unknown> }>;
  __getAccount: (id: string) => { balance: number } | undefined;
  __getGoal: (id: string) => Record<string, unknown> | undefined;
  __getLoan: (id: string) => Record<string, unknown> | undefined;
  __getEmi: (id: string) => Record<string, unknown> | undefined;
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

function seedGoal(goal: {
  id: string; title?: string; currency?: string;
  targetAmount?: number; savedAmount?: number; storedInAccountId?: string;
}) {
  const row = {
    id: goal.id,
    title: goal.title ?? 'Umrah',
    targetAmount: goal.targetAmount ?? 10000,
    savedAmount: goal.savedAmount ?? 0,
    currency: goal.currency ?? 'AED',
    storedInAccountId: goal.storedInAccountId ?? '',
    createdAt: '2026-01-01T00:00:00.000Z',
    targetDate: null,
  };
  m.__seedGoal(row);
  useGoalStore.setState((s) => ({ goals: [...s.goals, row as never] }));
}

function seedAdvance(loan: {
  id: string; cardId: string; total: number; remaining?: number;
  currency?: string; personName?: string; createdAt?: string;
}) {
  const row = {
    id: loan.id,
    personName: loan.personName ?? 'ENBD Credit Card',
    personId: null,
    type: 'taken',
    totalAmount: loan.total,
    remainingAmount: loan.remaining ?? loan.total,
    currency: loan.currency ?? 'AED',
    status: 'active',
    notes: '',
    createdAt: loan.createdAt ?? '2026-05-21T00:00:00.000Z',
  };
  m.__seedLoan(row);
  useLoanStore.setState((s) => ({ loans: [...s.loans, row as never] }));
  // The origin row is what findCashAdvanceCardForLoan /
  // findActiveCashAdvanceLoansForCard read: a loan_taken carrying the card as
  // its SOURCE.
  const origin = {
    id: `origin-${loan.id}`,
    type: 'loan_taken',
    amount: loan.total,
    currency: loan.currency ?? 'AED',
    sourceAccountId: loan.cardId,
    destinationAccountId: 'bank',
    relatedPerson: row.personName,
    personId: null,
    relatedLoanId: loan.id,
    relatedGoalId: null,
    conversionRate: null,
    category: '',
    notes: '',
    createdAt: row.createdAt,
    isReconciled: false,
  };
  m.__seedTransaction(origin);
  useTransactionStore.setState((s) => ({ transactions: [origin as never, ...s.transactions] }));
}

function seedEmi(e: { id: string; loanId: string; n: number; amount: number; dueDate: string; status?: string }) {
  const row = {
    id: e.id, loanId: e.loanId, installmentNumber: e.n,
    dueDate: e.dueDate, amount: e.amount, status: e.status ?? 'upcoming',
  };
  m.__seedEmi(row);
  useEmiStore.setState((s) => ({ schedules: [...s.schedules, row as never] }));
}

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
// GOAL CONTRIBUTIONS — VITE_ATOMIC_GOAL=true
// ════════════════════════════════════════════════════════════════════════════
describe('processTransaction — goal_contribution via the atomic RPC', () => {
  it('tracked internally: ONE call debits the wallet and grows the goal', async () => {
    seedAndLoad({ id: 'bank', balance: 1000, name: 'Bank' });
    seedGoal({ id: 'g1' });

    const tx = await useTransactionStore.getState().processTransaction({
      type: 'goal_contribution', amount: 200, sourceAccountId: 'bank', goalId: 'g1',
    });

    // Store and server agree — the store adopts the SERVER's figures.
    expect(useAccountStore.getState().getAccount('bank')?.balance).toBe(800);
    expect(m.__getAccount('bank')?.balance).toBe(800);
    expect(useGoalStore.getState().getGoal('g1')?.savedAmount).toBe(200);
    expect(m.__getGoal('g1')?.savedAmount).toBe(200);
    expect(tx.sourceAccountId).toBe('bank');
    expect(tx.destinationAccountId).toBeNull();
    expect(tx.relatedGoalId).toBe('g1');
    expect(tx.currency).toBe('AED');
  });

  it('stored in ANOTHER account: the credit leg lands and is the row destination', async () => {
    seedAndLoad({ id: 'bank', balance: 1000 });
    seedAndLoad({ id: 'vault', balance: 50, name: 'Vault' });
    seedGoal({ id: 'g1', storedInAccountId: 'vault' });

    const tx = await useTransactionStore.getState().processTransaction({
      type: 'goal_contribution', amount: 200, sourceAccountId: 'bank', goalId: 'g1',
    });

    expect(m.__getAccount('bank')?.balance).toBe(800);
    expect(m.__getAccount('vault')?.balance).toBe(250);
    expect(useAccountStore.getState().getAccount('vault')?.balance).toBe(250);
    expect(tx.destinationAccountId).toBe('vault');
  });

  it('SELF-STORED: no balance legs at all, and the note carries the flag', async () => {
    // The money physically stays where it is — debiting the source with no
    // credit back would push the balance below reality.
    seedAndLoad({ id: 'bank', balance: 1000, name: 'Bank' });
    seedGoal({ id: 'g1', storedInAccountId: 'bank' });

    const tx = await useTransactionStore.getState().processTransaction({
      type: 'goal_contribution', amount: 200, sourceAccountId: 'bank', goalId: 'g1',
    });

    expect(m.__getAccount('bank')?.balance).toBe(1000);
    expect(useAccountStore.getState().getAccount('bank')?.balance).toBe(1000);
    expect(m.__getGoal('g1')?.savedAmount).toBe(200);
    expect(parseInternalNote(tx.notes).meta.goalSelfStored).toBe('1');
    expect(tx.destinationAccountId).toBeNull();
  });

  it('SELF-STORED is currency-blind: no rate is sent even across currencies', async () => {
    seedAndLoad({ id: 'pkr', balance: 50000, currency: 'PKR' });
    seedGoal({ id: 'g1', currency: 'AED', storedInAccountId: 'pkr' });

    const tx = await useTransactionStore.getState().processTransaction({
      type: 'goal_contribution', amount: 100, sourceAccountId: 'pkr', goalId: 'g1',
      conversionRate: 76.5,
    });

    expect(tx.conversionRate).toBeNull();
    expect(tx.currency).toBe('AED');
    expect(m.__getAccount('pkr')?.balance).toBe(50000);
    expect(m.__rpcCalls()[0].input.conversionRate).toBeNull();
  });

  it('cross-currency DIVIDES, and the row carries the rate', async () => {
    seedAndLoad({ id: 'pkr', balance: 50000, currency: 'PKR', name: 'Meezan' });
    seedGoal({ id: 'g1', currency: 'AED' });

    const tx = await useTransactionStore.getState().processTransaction({
      type: 'goal_contribution', amount: 1000, sourceAccountId: 'pkr', goalId: 'g1',
      conversionRate: 76.5,
    });

    // round(1000 / 76.5, 2) = 13.07 — a MULTIPLY would have debited 76 500.
    expect(m.__getAccount('pkr')?.balance).toBe(49986.93);
    expect(m.__getGoal('g1')?.savedAmount).toBe(1000);
    expect(tx.conversionRate).toBe(76.5);
    expect(tx.amount).toBe(1000);
    expect(tx.currency).toBe('AED');
  });

  it('is ONE server call, not three', async () => {
    seedAndLoad({ id: 'bank', balance: 1000 });
    seedAndLoad({ id: 'vault', balance: 0 });
    seedGoal({ id: 'g1', storedInAccountId: 'vault' });

    await useTransactionStore.getState().processTransaction({
      type: 'goal_contribution', amount: 200, sourceAccountId: 'bank', goalId: 'g1',
    });

    expect(m.__rpcCalls().filter((c) => c.fn === 'contribute_to_goal')).toHaveLength(1);
  });

  it('BALANCE_CONFLICT on the GOAL: refetches and retries once against server truth', async () => {
    seedAndLoad({ id: 'bank', balance: 1000 });
    seedGoal({ id: 'g1', savedAmount: 0 });
    // Another device contributed 500 to the same goal.
    m.__remoteGoalSaved('g1', 500);

    await useTransactionStore.getState().processTransaction({
      type: 'goal_contribution', amount: 200, sourceAccountId: 'bank', goalId: 'g1',
    });

    // Both contributions survive — the lost-update bug this CAS exists to kill.
    expect(m.__getGoal('g1')?.savedAmount).toBe(700);
    expect(m.__getAccount('bank')?.balance).toBe(800);
    expect(m.__rpcCalls().filter((c) => c.fn === 'contribute_to_goal')).toHaveLength(2);
  });

  it('a conflict writes NOTHING — no balance, no goal move, no row', async () => {
    seedAndLoad({ id: 'bank', balance: 1000 });
    seedGoal({ id: 'g1', savedAmount: 0 });
    m.__remoteGoalSaved('g1', 500);
    // Make the RETRY fail too: the second attempt's expectation is refreshed
    // from the store, which loadGoals repopulates — so move it again after.
    const realLoad = useGoalStore.getState().loadGoals;
    let calls = 0;
    useGoalStore.setState({
      loadGoals: async () => {
        await realLoad();
        calls += 1;
        if (calls === 1) m.__remoteGoalSaved('g1', 900);
      },
    } as never);

    await expect(useTransactionStore.getState().processTransaction({
      type: 'goal_contribution', amount: 200, sourceAccountId: 'bank', goalId: 'g1',
    })).rejects.toThrow();

    expect(m.__getAccount('bank')?.balance).toBe(1000);
    expect(m.__getGoal('g1')?.savedAmount).toBe(900);
    expect(m.__getTransactions()).toHaveLength(0);
    useGoalStore.setState({ loadGoals: realLoad } as never);
  });

  it('a failure AFTER the RPC unwinds the balance, the goal AND the row', async () => {
    seedAndLoad({ id: 'bank', balance: 1000 });
    seedAndLoad({ id: 'vault', balance: 0 });
    seedGoal({ id: 'g1', storedInAccountId: 'vault' });
    m.__failNextTxAdd(new Error('boom'));

    await expect(useTransactionStore.getState().processTransaction({
      type: 'goal_contribution', amount: 200, sourceAccountId: 'bank', goalId: 'g1',
    })).rejects.toThrow('boom');

    expect(m.__getAccount('bank')?.balance).toBe(1000);
    expect(m.__getAccount('vault')?.balance).toBe(0);
    expect(m.__getGoal('g1')?.savedAmount).toBe(0);
    expect(m.__getTransactions()).toHaveLength(0);
  });

  it('the goal inverse is a DELTA, so it cannot clobber a concurrent add', async () => {
    // The legacy compensation restores the exact prior savedAmount, which
    // ERASES anything another device added in between. This one gives back
    // exactly what it took.
    seedAndLoad({ id: 'bank', balance: 1000 });
    seedGoal({ id: 'g1', savedAmount: 0 });
    m.__failNextTxAdd(new Error('boom'));

    const realAdd = useGoalStore.getState().addContribution;
    useGoalStore.setState({
      addContribution: async (goalId: string, amount: number) => {
        // Another device lands 300 just before our compensation runs.
        if (amount < 0) m.__remoteGoalSaved('g1', 500);
        useGoalStore.setState((s) => ({
          goals: s.goals.map((g) => (g.id === goalId
            ? { ...g, savedAmount: Number(m.__getGoal(goalId)?.savedAmount ?? 0) }
            : g)),
        }));
        await realAdd(goalId, amount);
      },
    } as never);

    await expect(useTransactionStore.getState().processTransaction({
      type: 'goal_contribution', amount: 200, sourceAccountId: 'bank', goalId: 'g1',
    })).rejects.toThrow('boom');

    // 500 (theirs) − 200 (ours, given back) = 300. A snapshot restore would
    // have written 0 and destroyed their 500.
    expect(m.__getGoal('g1')?.savedAmount).toBe(300);
    useGoalStore.setState({ addContribution: realAdd } as never);
  });

  it('INSUFFICIENT_BALANCE is refused BEFORE the RPC by the branch guard', async () => {
    seedAndLoad({ id: 'bank', balance: 100, name: 'Bank' });
    seedGoal({ id: 'g1' });

    await expect(useTransactionStore.getState().processTransaction({
      type: 'goal_contribution', amount: 500, sourceAccountId: 'bank', goalId: 'g1',
    })).rejects.toThrow(/Bank/);

    // checkBalance runs before any money moves on BOTH paths, so the RPC is
    // never even called — the server guard is the second line of defence.
    expect(m.__rpcCalls()).toHaveLength(0);
    expect(m.__getAccount('bank')?.balance).toBe(100);
  });

  it('a replayed transaction id contributes once', async () => {
    seedAndLoad({ id: 'bank', balance: 1000 });
    seedGoal({ id: 'g1' });
    await useTransactionStore.getState().processTransaction({
      type: 'goal_contribution', amount: 200, sourceAccountId: 'bank', goalId: 'g1',
    });
    const first = m.__getTransactions().length;

    // A second, distinct contribution proves the id is what makes a replay a
    // replay — the mock short-circuits on a known transaction id.
    await useTransactionStore.getState().processTransaction({
      type: 'goal_contribution', amount: 100, sourceAccountId: 'bank', goalId: 'g1',
    });

    expect(m.__getGoal('g1')?.savedAmount).toBe(300);
    expect(m.__getTransactions().length).toBe(first + 1);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// THE CREDIT-CARD STORY — VITE_ATOMIC_CARD_BILL=true
// ════════════════════════════════════════════════════════════════════════════
describe('processTransaction — paying a card bill via the atomic RPC', () => {
  // The RAK card from src/lib/cardStatement.test.ts: limit 16 500, balance
  // 6 521.96 (used 9 978.04), one 13 000 advance over 12 instalments with
  // 8 666.68 left — i.e. four instalments already paid, 1 311.36 of revolving
  // purchases behind the rest.
  const seedCardAndAdvance = () => {
    seedAndLoad({ id: 'bank', balance: 20000, name: 'Bank' });
    seedAndLoad({
      id: 'cc', balance: 6521.96, name: 'ENBD', type: 'credit_card',
      metadata: { creditLimit: '16500', dueDay: '15' },
    });
    seedAdvance({ id: 'adv', cardId: 'cc', total: 13000, remaining: 8666.68 });
    for (let n = 1; n <= 12; n += 1) {
      seedEmi({
        id: `e${n}`,
        loanId: 'adv',
        n,
        // The last instalment absorbs the rounding tail, as generateSchedule does.
        amount: n === 12 ? 1083.37 : 1083.33,
        // 1..5 are already due (5 is this cycle's); 6..12 are in the future.
        dueDate: n <= 5 ? `2026-0${n}-15` : `2027-0${n - 5}-15`,
        status: n <= 4 ? 'paid' : 'upcoming',
      });
    }
  };

  it('ONE call moves both balances, settles the advance and writes BOTH rows', async () => {
    seedCardAndAdvance();

    const tx = await useTransactionStore.getState().processTransaction({
      type: 'transfer', amount: 2394.69, sourceAccountId: 'bank', destinationAccountId: 'cc',
    });

    expect(m.__getAccount('bank')?.balance).toBe(17605.31);
    expect(m.__getAccount('cc')?.balance).toBe(8916.65);
    // The statement-native allocation steps the plan by ONE instalment.
    expect(m.__getLoan('adv')?.remainingAmount).toBe(7583.35);
    expect(m.__getEmi('e5')?.status).toBe('paid');
    expect(m.__getEmi('e6')?.status).toBe('upcoming');
    expect(m.__rpcCalls().filter((c) => c.fn === 'pay_card_bill')).toHaveLength(1);
    expect(tx.type).toBe('transfer');
  });

  it('the ledger rows carry BOTH account ids null and link back to the payment', async () => {
    seedCardAndAdvance();

    const tx = await useTransactionStore.getState().processTransaction({
      type: 'transfer', amount: 2394.69, sourceAccountId: 'bank', destinationAccountId: 'cc',
    });

    const ledger = m.__getTransactions().find(
      (t) => t.type === 'repayment' && t.relatedLoanId === 'adv',
    )!;
    expect(ledger.sourceAccountId).toBeNull();
    expect(ledger.destinationAccountId).toBeNull();
    expect(ledger.amount).toBe(1083.33);
    expect(parseInternalNote(ledger.notes as string).meta.linkedTransactionId).toBe(tx.id);
    expect(parseInternalNote(ledger.notes as string).visibleNote).toBe('Covered by card bill payment');
    // …and it is mirrored into local state, not only written server-side.
    expect(useTransactionStore.getState().transactions.some((t) => t.id === ledger.id)).toBe(true);
  });

  it('a card transfer with NOTHING to settle stays on the plain transfer path', async () => {
    // With no cash advances there is no multi-leg risk to close, so step 1
    // owns it — routing it here would add a code path for no atomicity gain.
    seedAndLoad({ id: 'bank', balance: 5000 });
    seedAndLoad({
      id: 'cc', balance: 10000, type: 'credit_card',
      metadata: { creditLimit: '16500', dueDay: '15' },
    });

    await useTransactionStore.getState().processTransaction({
      type: 'transfer', amount: 1000, sourceAccountId: 'bank', destinationAccountId: 'cc',
    });

    expect(m.__rpcCalls().filter((c) => c.fn === 'pay_card_bill')).toHaveLength(0);
    expect(m.__getAccount('bank')?.balance).toBe(4000);
    expect(m.__getAccount('cc')?.balance).toBe(11000);
  });

  it('a failure AFTER the RPC unwinds both balances, the loan, the instalment AND every row', async () => {
    seedCardAndAdvance();
    m.__failNextTxAdd(new Error('boom'));

    await expect(useTransactionStore.getState().processTransaction({
      type: 'transfer', amount: 2394.69, sourceAccountId: 'bank', destinationAccountId: 'cc',
    })).rejects.toThrow('boom');

    expect(m.__getAccount('bank')?.balance).toBe(20000);
    expect(m.__getAccount('cc')?.balance).toBe(6521.96);
    expect(m.__getLoan('adv')?.remainingAmount).toBe(8666.68);
    expect(m.__getEmi('e5')?.status).toBe('upcoming');
    expect(m.__getTransactions().filter((t) => t.type === 'repayment')).toHaveLength(0);
    expect(m.__getTransactions().filter((t) => t.type === 'transfer')).toHaveLength(0);
  });

  it('LOAN_REMAINING_CONFLICT: refetches, RE-PLANS and retries once', async () => {
    seedCardAndAdvance();
    // Another device repaid 1 000 of the advance between our read and our call.
    m.__remoteLoanRemaining('adv', 7666.68);

    await useTransactionStore.getState().processTransaction({
      type: 'transfer', amount: 2394.69, sourceAccountId: 'bank', destinationAccountId: 'cc',
    });

    // The re-plan carries the FRESH remaining, so their repayment survives and
    // ours applies on top of it.
    expect(m.__getLoan('adv')?.remainingAmount).toBe(6583.35);
    expect(m.__rpcCalls().filter((c) => c.fn === 'pay_card_bill')).toHaveLength(2);
    expect(m.__getAccount('bank')?.balance).toBe(17605.31);
  });

  it('paying the FULL balance clears the whole advance in one call', async () => {
    seedCardAndAdvance();

    await useTransactionStore.getState().processTransaction({
      type: 'transfer', amount: 9978.04, sourceAccountId: 'bank', destinationAccountId: 'cc',
    });

    expect(m.__getLoan('adv')?.remainingAmount).toBe(0);
    expect(m.__getLoan('adv')?.status).toBe('settled');
    expect(m.__getAccount('cc')?.balance).toBe(16500);
    expect(m.__getEmi('e5')?.status).toBe('paid');
    expect(m.__getEmi('e12')?.status).toBe('paid');
  });
});

describe('processTransaction — cash-advance repayment that credits the card', () => {
  const seedRepayable = (cardBalance: number, cardLimit = '16500') => {
    seedAndLoad({ id: 'bank', balance: 20000, name: 'Bank' });
    seedAndLoad({
      id: 'cc', balance: cardBalance, name: 'ENBD', type: 'credit_card',
      metadata: { creditLimit: cardLimit, dueDay: '15' },
    });
    seedAdvance({ id: 'adv', cardId: 'cc', total: 2000, remaining: 2000 });
  };

  it('ONE call debits the wallet, credits the card AND reduces the loan', async () => {
    // This is the case step 2 could not express: record_loan_repayment takes
    // exactly ONE account id.
    seedRepayable(16000);

    const tx = await useTransactionStore.getState().processTransaction({
      type: 'repayment', amount: 400, loanId: 'adv', sourceAccountId: 'bank',
    });

    expect(m.__getAccount('bank')?.balance).toBe(19600);
    expect(m.__getAccount('cc')?.balance).toBe(16400);
    expect(m.__getLoan('adv')?.remainingAmount).toBe(1600);
    expect(tx.sourceAccountId).toBe('bank');
    expect(tx.destinationAccountId).toBe('cc');
    expect(tx.relatedLoanId).toBe('adv');
    expect(m.__rpcCalls().filter((c) => c.fn === 'pay_card_bill')).toHaveLength(1);
    // ONE row, not two: the main row IS the repayment record.
    expect(m.__getTransactions().filter((t) => t.type === 'repayment')).toHaveLength(1);
  });

  it('a bill already covered credits nothing and stays OFF this RPC', async () => {
    // Headroom 0 → clampCardCredit returns { credited: 0 }, so there is no
    // second account leg and the case belongs to step 2, not step 4.
    seedRepayable(16500);

    await useTransactionStore.getState().processTransaction({
      type: 'repayment', amount: 400, loanId: 'adv', sourceAccountId: 'bank',
    });

    expect(m.__rpcCalls().filter((c) => c.fn === 'pay_card_bill')).toHaveLength(0);
    expect(m.__getAccount('cc')?.balance).toBe(16500);
    expect(m.__getAccount('bank')?.balance).toBe(19600);
    expect(m.__getLoan('adv')?.remainingAmount).toBe(1600);
  });

  it('a PARTIALLY clamped credit stamps cardCreditedAmount into the row', async () => {
    // Headroom 500, repayment 900 → credit 500, and deletion must reverse
    // exactly 500, which is what the internal note records.
    seedRepayable(16000);

    const tx = await useTransactionStore.getState().processTransaction({
      type: 'repayment', amount: 900, loanId: 'adv', sourceAccountId: 'bank',
    });

    expect(m.__getAccount('cc')?.balance).toBe(16500);
    expect(m.__getAccount('bank')?.balance).toBe(19100);
    expect(m.__getLoan('adv')?.remainingAmount).toBe(1100);
    expect(parseInternalNote(tx.notes).meta.cardCreditedAmount).toBe('500');
    // The loan drops by MORE than the card was credited, deliberately: the
    // rest of the bill was already paid by a transfer that credited the card.
    expect(m.__rpcCalls()[0].input.cardAmount).toBe(500);
    expect(m.__rpcCalls()[0].input.amount).toBe(900);
  });

  it('a failure AFTER the RPC unwinds both balances, the loan and the row', async () => {
    seedRepayable(16000);
    m.__failNextTxAdd(new Error('boom'));

    await expect(useTransactionStore.getState().processTransaction({
      type: 'repayment', amount: 400, loanId: 'adv', sourceAccountId: 'bank',
    })).rejects.toThrow('boom');

    expect(m.__getAccount('bank')?.balance).toBe(20000);
    expect(m.__getAccount('cc')?.balance).toBe(16000);
    expect(m.__getLoan('adv')?.remainingAmount).toBe(2000);
    expect(m.__getTransactions().filter((t) => t.type === 'repayment')).toHaveLength(0);
  });

  it('the covered instalments flip, and only the covered ones', async () => {
    seedRepayable(16000);
    seedEmi({ id: 'r1', loanId: 'adv', n: 1, amount: 200, dueDate: '2026-10-01' });
    seedEmi({ id: 'r2', loanId: 'adv', n: 2, amount: 200, dueDate: '2026-11-01' });
    seedEmi({ id: 'r3', loanId: 'adv', n: 3, amount: 1600, dueDate: '2026-12-01' });

    await useTransactionStore.getState().processTransaction({
      type: 'repayment', amount: 400, loanId: 'adv', sourceAccountId: 'bank',
    });

    expect(m.__getEmi('r1')?.status).toBe('paid');
    expect(m.__getEmi('r2')?.status).toBe('paid');
    expect(m.__getEmi('r3')?.status).toBe('upcoming');
    expect(useEmiStore.getState().schedules.find((e) => e.id === 'r2')?.status).toBe('paid');
  });

  it('splits_only never reaches either RPC (ledger mode has no accounts)', async () => {
    // A ledger repayment goes through loanStore.applyRepayment and writes a row
    // with BOTH account ids null; it never enters processTransaction's
    // card path. Here the mode is switched but the user still HAS accounts (a
    // full_tracker → splits_only switcher), which is the only way this branch
    // is reachable at all — and the card leg is waived because there is no card.
    useAppModeStore.setState({ mode: 'splits_only' });
    seedAndLoad({ id: 'bank', balance: 100, name: 'Bank' });
    seedAdvance({ id: 'adv', cardId: 'nope', total: 2000, remaining: 2000 });

    await useTransactionStore.getState().processTransaction({
      type: 'repayment', amount: 400, loanId: 'adv', sourceAccountId: 'bank',
    });

    expect(m.__rpcCalls().filter((c) => c.fn === 'pay_card_bill')).toHaveLength(0);
    // The splits_only bypass let the account go negative, exactly as today.
    expect(m.__getAccount('bank')?.balance).toBe(-300);
  });
});
