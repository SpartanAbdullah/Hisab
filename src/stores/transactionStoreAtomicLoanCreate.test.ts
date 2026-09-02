// L4 step 3: processTransaction's `loan_given` / `loan_taken` branches with
// VITE_ATOMIC_LOAN_CREATE=true — the funding/receiving account leg, the
// credit-card cash-advance leg, the loans row and the transactions row
// committed by ONE server call (`create_loan_with_leg`).
//
// Why a separate file rather than more cases in transactionStore.test.ts:
// `ATOMIC_LOAN_CREATE_ENABLED` is read from import.meta.env at module load, so
// the flag has to be stubbed BEFORE the store is imported — which needs a
// dynamic import, which needs its own module registry. Vitest gives each test
// file one. transactionStore.test.ts therefore keeps proving the legacy path
// unchanged ("byte-for-byte when the flag is off") and this file proves the
// flagged path.
//
// The mock RPC below reproduces supabase-migration-p3-atomic-loan-create.sql:
// direction derived from p_type, the loan currency taken from the ACCOUNT,
// compare-and-swap on every account balance touched, the insufficient-balance
// guard with its allow-negative escape, the cash-advance card guards, the
// loan-id collision refusal, EMI plan re-validation, idempotent replay — and,
// the whole point, all-or-nothing: it never applies one leg without the rest.
//
// Coverage:
//   1. loan GIVEN — debits the account, creates the loan, one row, one call
//   2. loan TAKEN — credits the account instead
//   3. cash advance — charges the card AND credits the receiver in one call
//   4. the rows carry the same shape the legacy path writes
//   5. it is ONE server call, not three (or four)
//   6. BALANCE_CONFLICT → refetch + retry once against server truth
//   7. …and a conflict writes NOTHING — no loan, no row, no balance move
//   8. INSUFFICIENT_BALANCE surfaces as the user-facing string
//   9. splits_only waives the guard exactly as checkBalanceForTransaction does
//  10. a failure AFTER the RPC unwinds the balances, the loan and the row
//  11. a cash-advance failure unwinds BOTH balance legs
//  12. a replayed transaction id lends once
//  13. attaching to an existing loan creates no second loan
//  14. splits_only loan creation never touches the RPC (loanStore.createLoan)
//  15. the ad-hoc-split internal note is stripped from Loan.notes, not the row
//  16. the cash-advance guards still refuse before any money moves
//  17. the EMI plan rides in as p_emi and the schedule is adopted from
//      emi_inserted (the step-3 addendum: the schedule is no longer written by
//      the page after the fact, so a drop can no longer orphan it)
//  18. a server refusal of the plan is a CLEAN failure — no loan, no row, no
//      balance move, no local schedule, and a user-facing message
//  19. a failure after the RPC unwinds the instalments with everything else

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
    __remoteBalanceDelta: (id: string, delta: number) => {
      const cur = accounts.get(id);
      if (cur) accounts.set(id, { ...cur, balance: round2(cur.balance + delta) });
    },
    __failNextTxAdd: (err: Error) => { nextTxAddThrows = err; },
    __rpcCalls: () => rpcCalls,
    __getAccount: (id: string) => accounts.get(id),
    __getLoan: (id: string) => loans.get(id),
    __getLoans: () => Array.from(loans.values()),
    __getEmis: () => Array.from(emis.values()),
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

      // ── The RPC under test, in memory ────────────────────────────────────
      // Faithful to supabase-migration-p3-atomic-loan-create.sql. Every refusal
      // happens BEFORE the first mutation; the writes happen together at the
      // end. That is the property the whole step exists for.
      async loanCreateAtomic(input: Record<string, unknown>) {
        rpcCalls.push(input);
        const txId = input.transactionId as string;
        const loanId = input.loanId as string;
        const acctId = input.accountId as string;
        const cardId = (input.cardAccountId as string | null) ?? null;
        const amount = input.amount as number;
        const direction = input.direction as 'given' | 'taken';
        const emi = (input.emi as Array<Record<string, unknown>> | null) ?? null;

        const existing = transactions.get(txId);
        if (existing) {
          return {
            replay: true,
            transactionId: txId,
            loanId: (existing.relatedLoanId as string) ?? loanId,
            loanCreated: false,
            accountBalance: accounts.get(acctId)!.balance,
            accountDelta: 0,
            cardBalance: cardId ? accounts.get(cardId)!.balance : null,
            cardDelta: 0,
            currency: existing.currency as string,
            emiInserted: [],
          };
        }

        if (!acctId) throw coded('ACCOUNT_NOT_FOUND');
        if (input.conversionRate != null) throw coded('CONVERSION_RATE_NOT_APPLICABLE');
        const acct = accounts.get(acctId);
        if (!acct) throw coded('ACCOUNT_NOT_FOUND');
        const currency = acct.currency;

        let card: typeof acct | undefined;
        if (cardId) {
          if (direction !== 'taken') throw coded('INVALID_CASH_ADVANCE');
          if (cardId === acctId) throw coded('SAME_ACCOUNT');
          card = accounts.get(cardId);
          if (!card) throw coded('ACCOUNT_NOT_FOUND');
          if (card.type !== 'credit_card') throw coded('INVALID_CASH_ADVANCE');
          if (card.currency !== currency) throw coded('INVALID_CASH_ADVANCE');
        }

        if (input.createLoan === true) {
          if (loans.has(loanId)) throw coded('LOAN_ID_COLLISION');
        } else {
          const existingLoan = loans.get(loanId);
          if (!existingLoan) throw coded('LOAN_NOT_FOUND');
          if (existingLoan.type !== direction || existingLoan.currency !== currency) {
            throw coded('LOAN_MISMATCH');
          }
        }

        const pay = round2(amount);
        const acctDelta = direction === 'given' ? -pay : pay;
        const cardDelta = card ? -pay : null;

        // CAS on every account touched.
        if (round2(acct.balance) !== round2(input.expectedAccountBalance as number)) {
          const err = coded('BALANCE_CONFLICT') as Error & { code: string; accountBalance: number };
          err.accountBalance = acct.balance;
          throw err;
        }
        if (card && round2(card.balance) !== round2(input.expectedCardBalance as number)) {
          const err = coded('BALANCE_CONFLICT') as Error & { code: string; accountBalance: number };
          err.accountBalance = card.balance;
          throw err;
        }

        if (acctDelta < 0 && input.allowNegative !== true && acct.balance < pay) {
          throw coded('INSUFFICIENT_BALANCE', `${acct.name} only has ${acct.balance} — that's less than ${pay}.`);
        }
        if (card && input.allowNegative !== true && card.balance < pay) {
          throw coded('INSUFFICIENT_BALANCE', `${card.name} only has ${card.balance} — that's less than ${pay}.`);
        }

        // EMI plan re-validation, BEFORE any write. The refusal is thrown in
        // the shape `atomicMoneyDb.loanCreateAtomic` maps the three server
        // tokens to (EMI_PLAN_MISMATCH / EMI_PLAN_INVALID / EMI_ID_COLLISION →
        // one coded EMI_PLAN_REJECTED carrying the user-facing string), because
        // this mock stands in for the wrapper, not for plpgsql.
        if (emi && emi.length > 0) {
          const reject = (serverToken: string) => {
            const err = coded('EMI_PLAN_REJECTED', 'the instalment plan was refused') as Error & { code: string; serverToken: string };
            err.serverToken = serverToken;
            return err;
          };
          const sum = round2(emi.reduce((t, e) => t + Number(e.amount), 0));
          if (Math.abs(sum - pay) > 0.01) throw reject('EMI_PLAN_MISMATCH');
          for (const e of emi) if (emis.has(e.id as string)) throw reject('EMI_ID_COLLISION');
        }

        // ── The writes, together ────────────────────────────────────────────
        let loanCreated = false;
        if (input.createLoan === true) {
          loans.set(loanId, {
            id: loanId,
            personName: input.personName,
            personId: (input.personId as string | null) ?? null,
            type: direction,
            totalAmount: amount,
            remainingAmount: amount,
            currency,
            status: 'active',
            notes: input.loanNotes ?? '',
            createdAt: input.loanCreatedAt,
          });
          loanCreated = true;
        }

        const newBalance = round2(acct.balance + acctDelta);
        accounts.set(acctId, { ...acct, balance: newBalance });

        let newCardBalance: number | null = null;
        if (card && cardId) {
          newCardBalance = round2(card.balance + (cardDelta as number));
          accounts.set(cardId, { ...card, balance: newCardBalance });
        }

        const emiInserted: string[] = [];
        if (emi) {
          for (const e of emi) {
            emis.set(e.id as string, {
              id: e.id, loanId,
              installmentNumber: e.installment_number,
              dueDate: e.due_date, amount: e.amount, status: 'upcoming',
            });
            emiInserted.push(e.id as string);
          }
        }

        transactions.set(txId, {
          id: txId,
          type: direction === 'given' ? 'loan_given' : 'loan_taken',
          amount, currency,
          sourceAccountId: direction === 'given' ? acctId : cardId,
          destinationAccountId: direction === 'given' ? null : acctId,
          relatedPerson: input.personName,
          personId: (input.personId as string | null) ?? null,
          relatedLoanId: loanId, relatedGoalId: null,
          conversionRate: null, category: input.category, notes: input.note,
          createdAt: input.createdAt, isReconciled: false,
        });

        return {
          replay: false,
          transactionId: txId,
          loanId,
          loanCreated,
          accountBalance: newBalance,
          accountDelta: acctDelta,
          cardBalance: newCardBalance,
          cardDelta,
          currency,
          emiInserted,
        };
      },
    },
  };
});

// The flag is read at module-evaluation time, so it must be stubbed before the
// store is imported — hence the dynamic imports below.
vi.stubEnv('VITE_ATOMIC_LOAN_CREATE', 'true');

const mockDb = await import('../lib/supabaseDb');
const { useAccountStore } = await import('./accountStore');
const { useTransactionStore, loanScheduleAlreadyCreated } = await import('./transactionStore');
const { useLoanStore } = await import('./loanStore');
const { useGoalStore } = await import('./goalStore');
const { useEmiStore } = await import('./emiStore');
const { useAppModeStore } = await import('./appModeStore');
const { useActivityStore } = await import('./activityStore');
const { useInvestmentStore } = await import('./investmentStore');

type Loose = Record<string, never>;
type SeedAccount = { id: string; balance: number; name?: string; type?: string; currency?: string; metadata?: Record<string, string> };

const seedAccount = (mockDb as unknown as { __seedAccount: (a: SeedAccount) => void }).__seedAccount;
const remoteBalanceDelta = (mockDb as unknown as { __remoteBalanceDelta: (id: string, d: number) => void }).__remoteBalanceDelta;
const failNextTxAdd = (mockDb as unknown as { __failNextTxAdd: (err: Error) => void }).__failNextTxAdd;
const rpcCalls = (mockDb as unknown as { __rpcCalls: () => Array<Record<string, unknown>> }).__rpcCalls;
const remoteAccount = (mockDb as unknown as { __getAccount: (id: string) => { balance: number } | undefined }).__getAccount;
const remoteLoan = (mockDb as unknown as { __getLoan: (id: string) => Record<string, unknown> | undefined }).__getLoan;
const remoteLoans = (mockDb as unknown as { __getLoans: () => Array<Record<string, unknown>> }).__getLoans;
const remoteTransactions = (mockDb as unknown as { __getTransactions: () => Array<Record<string, unknown>> }).__getTransactions;
const remoteEmis = (mockDb as unknown as { __getEmis: () => Array<Record<string, unknown>> }).__getEmis;
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

describe('processTransaction — loan creation via the atomic RPC (VITE_ATOMIC_LOAN_CREATE=true)', () => {
  it('loan GIVEN: debits the account, creates the loan, writes exactly one row', async () => {
    seedAndLoad({ id: 'bank', balance: 1000, name: 'Bank' });

    const tx = await useTransactionStore.getState().processTransaction({
      type: 'loan_given', amount: 250, sourceAccountId: 'bank', personName: 'Ali',
    });

    // Store and server agree — the store adopts the SERVER's figures.
    expect(useAccountStore.getState().getAccount('bank')?.balance).toBe(750);
    expect(remoteAccount('bank')?.balance).toBe(750);
    expect(remoteLoans()).toHaveLength(1);
    expect(remoteLoan(tx.relatedLoanId!)).toMatchObject({
      type: 'given', totalAmount: 250, remainingAmount: 250,
      currency: 'AED', status: 'active', personName: 'Ali',
    });
    expect(useLoanStore.getState().loans).toHaveLength(1);
    expect(remoteTransactions()).toHaveLength(1);
    expect(useTransactionStore.getState().transactions).toHaveLength(1);
  });

  it('loan TAKEN: credits the account instead', async () => {
    seedAndLoad({ id: 'bank', balance: 1000 });

    const tx = await useTransactionStore.getState().processTransaction({
      type: 'loan_taken', amount: 500, destinationAccountId: 'bank', personName: 'Sara',
    });

    expect(useAccountStore.getState().getAccount('bank')?.balance).toBe(1500);
    expect(remoteLoan(tx.relatedLoanId!)).toMatchObject({ type: 'taken', totalAmount: 500 });
    expect(tx.sourceAccountId).toBeNull();
    expect(tx.destinationAccountId).toBe('bank');
  });

  it('cash advance: charges the card AND credits the receiver in ONE call', async () => {
    // The worst instance of MF-01 in the whole switch — under the legacy path
    // a drop between the two legs left available credit consumed and the cash
    // arriving nowhere, with no loan and no row to explain it.
    seedAndLoad({ id: 'cc', balance: 16500, type: 'credit_card', name: 'ENBD', metadata: { creditLimit: '16500' } });
    seedAndLoad({ id: 'bank', balance: 1000, name: 'Bank' });

    const tx = await useTransactionStore.getState().processTransaction({
      type: 'loan_taken', amount: 1500, destinationAccountId: 'bank',
      sourceAccountId: 'cc', personName: 'ENBD Credit Card',
    });

    expect(rpcCalls()).toHaveLength(1);
    expect(remoteAccount('cc')?.balance).toBe(15000);   // available credit down
    expect(remoteAccount('bank')?.balance).toBe(2500);  // cash up
    expect(useAccountStore.getState().getAccount('cc')?.balance).toBe(15000);
    expect(useAccountStore.getState().getAccount('bank')?.balance).toBe(2500);
    // The row reads card → receiver, which is what findCashAdvanceCardForLoan
    // looks for when a later repayment has to credit the card back.
    expect(tx.sourceAccountId).toBe('cc');
    expect(tx.destinationAccountId).toBe('bank');
    expect(remoteLoan(tx.relatedLoanId!)).toMatchObject({ type: 'taken', totalAmount: 1500 });
  });

  it('writes the same row shape the legacy path writes', async () => {
    seedAndLoad({ id: 'bank', balance: 1000 });

    const tx = await useTransactionStore.getState().processTransaction({
      type: 'loan_given', amount: 250, sourceAccountId: 'bank',
      personName: 'Ali', personId: 'p-ali', category: 'Loans', notes: 'for the deposit',
    });

    expect(tx).toMatchObject({
      type: 'loan_given',
      amount: 250,
      currency: 'AED',
      sourceAccountId: 'bank',
      destinationAccountId: null,
      relatedPerson: 'Ali',
      personId: 'p-ali',
      relatedGoalId: null,
      // A created loan takes the account's currency, so there is never a rate.
      conversionRate: null,
      category: 'Loans',
      notes: 'for the deposit',
      isReconciled: false,
    });
    // The server row and the client row are the SAME row (same id, same
    // created_at) — the tail's idempotent upsert must not fork them.
    const serverRow = remoteTransactions()[0];
    expect(serverRow.id).toBe(tx.id);
    expect(serverRow.createdAt).toBe(tx.createdAt);
    expect(serverRow.relatedLoanId).toBe(tx.relatedLoanId);
  });

  it('is ONE server call — the half-applied window no longer exists', async () => {
    seedAndLoad({ id: 'bank', balance: 1000 });

    await useTransactionStore.getState().processTransaction({
      type: 'loan_given', amount: 250, sourceAccountId: 'bank', personName: 'Ali',
    });

    // Legacy: the balance CAS, then the loans INSERT, then the row — any of
    // which could be the last one to survive the network. Now: one.
    expect(rpcCalls()).toHaveLength(1);
    expect(rpcCalls()[0]).toMatchObject({
      direction: 'given',
      accountId: 'bank',
      cardAccountId: null,
      createLoan: true,
      amount: 250,
      currency: 'AED',
      expectedAccountBalance: 1000,
      expectedCardBalance: null,
      allowNegative: false,
      // The schedule is still written by the page, after this call resolves.
      emi: null,
    });
  });

  it('BALANCE_CONFLICT: refetches once and retries against server truth', async () => {
    seedAndLoad({ id: 'bank', balance: 1000 });
    // Another device spent 200 from bank; our store still believes 1000.
    remoteBalanceDelta('bank', -200);

    await useTransactionStore.getState().processTransaction({
      type: 'loan_given', amount: 250, sourceAccountId: 'bank', personName: 'Ali',
    });

    // 800 − 250, NOT 1000 − 250: the other device's spend survived.
    expect(remoteAccount('bank')?.balance).toBe(550);
    expect(useAccountStore.getState().getAccount('bank')?.balance).toBe(550);
    expect(rpcCalls()).toHaveLength(2);       // conflict, then the retry
    expect(remoteLoans()).toHaveLength(1);    // exactly ONE loan, not two
    expect(remoteTransactions()).toHaveLength(1);
  });

  it('a conflict writes NOTHING — no loan is left behind by the failed attempt', async () => {
    // The property that makes the retry safe: a refused call must not have
    // created the loan, or the retry would raise LOAN_ID_COLLISION and the
    // user would end up with an orphan loan and no transaction.
    seedAndLoad({ id: 'bank', balance: 1000 });
    remoteBalanceDelta('bank', -200);
    // Make the retry fail too, so we can inspect the aftermath of two refusals.
    const firstAttemptLoans = remoteLoans().length;

    await useTransactionStore.getState().processTransaction({
      type: 'loan_given', amount: 250, sourceAccountId: 'bank', personName: 'Ali',
    });

    expect(firstAttemptLoans).toBe(0);
    // The loan the FIRST (conflicted) call would have created does not exist;
    // only the retry's does.
    expect(remoteLoans()).toHaveLength(1);
    expect(remoteLoans()[0].id).toBe(remoteTransactions()[0].relatedLoanId);
  });

  it('INSUFFICIENT_BALANCE from the server surfaces as the user-facing string', async () => {
    seedAndLoad({ id: 'cash', balance: 500, name: 'Cash' });
    // Client snapshot says 500 (so its own checkBalance passes) but the
    // account was drained elsewhere; the retry then hits the server guard.
    remoteBalanceDelta('cash', -450);

    await expect(
      useTransactionStore.getState().processTransaction({
        type: 'loan_given', amount: 300, sourceAccountId: 'cash', personName: 'Ali',
      }),
    ).rejects.toThrow(/only has|sirf/i);

    expect(remoteAccount('cash')?.balance).toBe(50);
    expect(remoteLoans()).toHaveLength(0);
    expect(remoteTransactions()).toHaveLength(0);
    expect(useLoanStore.getState().loans).toHaveLength(0);
  });

  it('splits_only waives the server guard exactly as checkBalanceForTransaction does', async () => {
    // A user who switched full_tracker → splits_only still HAS accounts, and
    // isSimpleModeBalanceBypassAllowed lets these entries go negative. The
    // server flag has to be waived in that case and ONLY that case.
    useAppModeStore.setState({ mode: 'splits_only' });
    seedAndLoad({ id: 'cash', balance: 100, name: 'Cash' });

    await useTransactionStore.getState().processTransaction({
      type: 'loan_given', amount: 300, sourceAccountId: 'cash', personName: 'Ali',
    });

    expect(rpcCalls()[0]).toMatchObject({ allowNegative: true });
    expect(remoteAccount('cash')?.balance).toBe(-200);
    expect(remoteLoans()).toHaveLength(1);
  });

  it('a failure AFTER the RPC unwinds the balance, the loan and the row', async () => {
    seedAndLoad({ id: 'bank', balance: 1000 });
    failNextTxAdd(new Error('Simulated DB failure'));

    await expect(
      useTransactionStore.getState().processTransaction({
        type: 'loan_given', amount: 250, sourceAccountId: 'bank', personName: 'Ali',
      }),
    ).rejects.toThrow(/Simulated DB failure/);

    // All three artifacts reversed together — never some of them.
    expect(remoteAccount('bank')?.balance).toBe(1000);
    expect(remoteLoans()).toHaveLength(0);
    expect(remoteTransactions()).toHaveLength(0);
    expect(useAccountStore.getState().getAccount('bank')?.balance).toBe(1000);
    expect(useLoanStore.getState().loans).toHaveLength(0);
    expect(useTransactionStore.getState().transactions).toHaveLength(0);
  });

  it('a cash-advance failure unwinds BOTH balance legs and the loan', async () => {
    seedAndLoad({ id: 'cc', balance: 16500, type: 'credit_card', name: 'ENBD' });
    seedAndLoad({ id: 'bank', balance: 1000 });
    failNextTxAdd(new Error('Simulated DB failure'));

    await expect(
      useTransactionStore.getState().processTransaction({
        type: 'loan_taken', amount: 1500, destinationAccountId: 'bank',
        sourceAccountId: 'cc', personName: 'ENBD Credit Card',
      }),
    ).rejects.toThrow(/Simulated DB failure/);

    expect(remoteAccount('cc')?.balance).toBe(16500);
    expect(remoteAccount('bank')?.balance).toBe(1000);
    expect(useAccountStore.getState().getAccount('cc')?.balance).toBe(16500);
    expect(useAccountStore.getState().getAccount('bank')?.balance).toBe(1000);
    expect(remoteLoans()).toHaveLength(0);
    expect(remoteTransactions()).toHaveLength(0);
  });

  it('a replayed transaction id lends once', async () => {
    seedAndLoad({ id: 'bank', balance: 1000 });

    const tx = await useTransactionStore.getState().processTransaction({
      type: 'loan_given', amount: 250, sourceAccountId: 'bank', personName: 'Ali',
    });

    // The retry a dropped reply would produce, replayed straight at the RPC.
    const replay = await (mockDb as unknown as {
      atomicMoneyDb: { loanCreateAtomic: (i: Record<string, unknown>) => Promise<{ replay: boolean; accountBalance: number; loanCreated: boolean }> };
    }).atomicMoneyDb.loanCreateAtomic({
      transactionId: tx.id, loanId: tx.relatedLoanId, createLoan: true,
      direction: 'given', personName: 'Ali', personId: null,
      accountId: 'bank', cardAccountId: null, amount: 250, currency: 'AED',
      note: '', category: '', createdAt: tx.createdAt, loanNotes: '',
      loanCreatedAt: tx.createdAt, emi: null,
      expectedAccountBalance: 1000, expectedCardBalance: null, allowNegative: false,
    });

    expect(replay.replay).toBe(true);
    expect(replay.loanCreated).toBe(false);
    expect(replay.accountBalance).toBe(750);
    expect(remoteAccount('bank')?.balance).toBe(750);
    expect(remoteLoans()).toHaveLength(1);
    expect(remoteTransactions()).toHaveLength(1);
  });

  it('attaching to an existing loan creates no second loan', async () => {
    // The ad-hoc-split / cash-advance re-entry shape: input.loanId is set, so
    // the entry funds a loan that already exists.
    seedAndLoad({ id: 'bank', balance: 2000 });

    const first = await useTransactionStore.getState().processTransaction({
      type: 'loan_given', amount: 250, sourceAccountId: 'bank', personName: 'Ali',
    });
    const loanId = first.relatedLoanId!;

    const second = await useTransactionStore.getState().processTransaction({
      type: 'loan_given', amount: 100, sourceAccountId: 'bank',
      personName: 'Ali', loanId,
    });

    expect(second.relatedLoanId).toBe(loanId);
    expect(remoteLoans()).toHaveLength(1);
    expect(rpcCalls()[1]).toMatchObject({ createLoan: false, loanId });
    // The loan itself is NOT topped up by the second entry — that is the
    // legacy behaviour too (only trackedCreateLoan ever sets total_amount).
    expect(remoteLoan(loanId)?.totalAmount).toBe(250);
    expect(remoteAccount('bank')?.balance).toBe(1650);
    expect(remoteTransactions()).toHaveLength(2);
  });

  it('splits_only: ledger loan creation never touches the RPC', async () => {
    // Ledger mode has no accounts; AddLoanModal.tsx:164-165 and
    // QuickEntry.tsx:750/:850 call loanStore.createLoan directly, which writes
    // a loans row and NOTHING else — no account leg, no transactions row. Not
    // one line of it changes under this flag, and create_loan_with_leg would
    // refuse it (ACCOUNT_NOT_FOUND) if it were ever routed here.
    useAppModeStore.setState({ mode: 'splits_only' });

    await useLoanStore.getState().createLoan({
      personName: 'Sara', personId: null, type: 'given',
      totalAmount: 1000, currency: 'AED', notes: '',
    });

    expect(rpcCalls()).toHaveLength(0);
    expect(remoteLoans()).toHaveLength(1);
    expect(remoteTransactions()).toHaveLength(0);
    expect(remoteLoans()[0]).toMatchObject({ type: 'given', remainingAmount: 1000 });
  });

  it('the ad-hoc-split internal note is stripped from Loan.notes but kept on the row', async () => {
    // Loan.notes is rendered RAW on LoansPage / LoanDetailPage / statements, so
    // [[HISAAB_META:…]] must never reach it — while the row keeps it, because
    // that is how the split is traced back.
    seedAndLoad({ id: 'bank', balance: 1000 });
    const { buildInternalNote } = await import('../lib/internalNotes');
    const notes = buildInternalNote('Dinner share', { splitEventId: 'S1' });

    const tx = await useTransactionStore.getState().processTransaction({
      type: 'loan_given', amount: 250, sourceAccountId: 'bank',
      personName: 'Ali', notes,
    });

    expect(remoteLoan(tx.relatedLoanId!)?.notes).toBe('Dinner share');
    expect(useLoanStore.getState().getLoan(tx.relatedLoanId!)?.notes).toBe('Dinner share');
    expect(tx.notes).toBe(notes);
    expect(rpcCalls()[0]).toMatchObject({ loanNotes: 'Dinner share', note: notes });
  });

  it('the cash-advance guards still refuse before any money moves', async () => {
    seedAndLoad({ id: 'notacard', balance: 5000, type: 'bank', name: 'Other Bank' });
    seedAndLoad({ id: 'aedcard', balance: 5000, type: 'credit_card', currency: 'AED' });
    seedAndLoad({ id: 'pkrbank', balance: 5000, currency: 'PKR' });
    seedAndLoad({ id: 'bank', balance: 1000 });

    await expect(
      useTransactionStore.getState().processTransaction({
        type: 'loan_taken', amount: 100, destinationAccountId: 'bank',
        sourceAccountId: 'notacard', personName: 'X',
      }),
    ).rejects.toThrow(/credit card account/);

    await expect(
      useTransactionStore.getState().processTransaction({
        type: 'loan_taken', amount: 100, destinationAccountId: 'pkrbank',
        sourceAccountId: 'aedcard', personName: 'X',
      }),
    ).rejects.toThrow(/match the receiving account currency/);

    // Both refusals happened in the client, before the RPC was ever reached.
    expect(rpcCalls()).toHaveLength(0);
    expect(remoteAccount('bank')?.balance).toBe(1000);
    expect(remoteAccount('pkrbank')?.balance).toBe(5000);
    expect(remoteLoans()).toHaveLength(0);
    expect(remoteTransactions()).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// THE STEP-3 ADDENDUM — the EMI schedule inside the same transaction.
//
// Before this, `emiStore.generateSchedule` was called by the PAGE after
// processTransaction resolved, outside the MutationScope: a drop between the
// two left a funded loan with no schedule and nothing rolled back (migration
// verification query V7 counts the loans it already broke). The plan is now
// computed first (planEmiRows) and inserted by the RPC.
// ═══════════════════════════════════════════════════════════════════════════

const { planEmiRows } = await import('../lib/emiPlan');
const { tStatic } = await import('../lib/i18n');

/** Deterministic ids so the p_emi payload can be asserted field for field. */
const plan = (total: number, count: number, start: string, prefix = 'e') =>
  planEmiRows({ totalAmount: total, installments: count, startDate: start, makeId: (i) => `${prefix}${i + 1}` });

describe('processTransaction — the instalment plan travels with the loan', () => {
  it('sends p_emi in the SAME call and adopts the schedule from emi_inserted', async () => {
    seedAndLoad({ id: 'bank', balance: 5000 });

    const tx = await useTransactionStore.getState().processTransaction({
      type: 'loan_taken', amount: 1200, destinationAccountId: 'bank',
      personName: 'Bilal', emiPlan: plan(1200, 4, '2026-10-01'),
    });

    // ONE call — the schedule is no longer a second, uncompensated round-trip.
    expect(rpcCalls()).toHaveLength(1);
    // The exact snake_case shape supabase/tests/tests/7x-atomic-loan-create.sql
    // §7 binds — field for field.
    expect(rpcCalls()[0].emi).toEqual([
      { id: 'e1', installment_number: 1, due_date: '2026-10-01', amount: 300 },
      { id: 'e2', installment_number: 2, due_date: '2026-11-01', amount: 300 },
      { id: 'e3', installment_number: 3, due_date: '2026-12-01', amount: 300 },
      { id: 'e4', installment_number: 4, due_date: '2027-01-01', amount: 300 },
    ]);

    // Server truth: four upcoming instalments, on THIS loan.
    expect(remoteEmis()).toHaveLength(4);
    expect(remoteEmis().every((e) => e.status === 'upcoming' && e.loanId === tx.relatedLoanId)).toBe(true);

    // Adopted locally from the server's own emi_inserted list.
    const local = useEmiStore.getState().getByLoan(tx.relatedLoanId!);
    expect(local.map((e) => e.installmentNumber)).toEqual([1, 2, 3, 4]);
    expect(local.map((e) => e.amount)).toEqual([300, 300, 300, 300]);
    expect(local.every((e) => e.status === 'upcoming')).toBe(true);

    // …and the page's signal to skip its own generateSchedule call.
    expect(loanScheduleAlreadyCreated(tx.relatedLoanId)).toBe(true);
  });

  it('carries a cash advance‘s statement-anchored dates through unchanged', async () => {
    seedAndLoad({ id: 'cc', balance: 16500, type: 'credit_card', name: 'ENBD', metadata: { dueDay: '26' } });
    seedAndLoad({ id: 'bank', balance: 1000, name: 'Bank' });

    const dueDates = ['2026-07-26', '2026-08-26', '2026-09-26'];
    const tx = await useTransactionStore.getState().processTransaction({
      type: 'loan_taken', amount: 1500, destinationAccountId: 'bank',
      sourceAccountId: 'cc', personName: 'ENBD',
      emiPlan: planEmiRows({
        totalAmount: 1500, installments: 3, startDate: '2026-07-24',
        dueDates, makeId: (i) => `ca${i + 1}`,
      }),
    });

    // The instalment is a LINE on the card's statement — the typed start date
    // must never win over the statement day.
    expect(useEmiStore.getState().getByLoan(tx.relatedLoanId!).map((e) => e.dueDate)).toEqual(dueDates);
    // All four legs still committed together.
    expect(remoteAccount('cc')?.balance).toBe(15000);
    expect(remoteAccount('bank')?.balance).toBe(2500);
    expect(remoteEmis()).toHaveLength(3);
  });

  it('no plan still sends p_emi: null — the schedule stays the page‘s job', async () => {
    seedAndLoad({ id: 'bank', balance: 1000 });

    const tx = await useTransactionStore.getState().processTransaction({
      type: 'loan_given', amount: 250, sourceAccountId: 'bank', personName: 'Ali',
    });

    expect(rpcCalls()[0].emi).toBeNull();
    expect(remoteEmis()).toHaveLength(0);
    // …so the page generates it client-side, exactly as before.
    expect(loanScheduleAlreadyCreated(tx.relatedLoanId)).toBe(false);
  });

  it('a plan that does not add up is refused BEFORE the RPC, with a user-facing message', async () => {
    // The client's copy of the server's rule (emiPlanProblem). Refusing here
    // saves a round-trip on 3G, and the message has to be the same either way.
    seedAndLoad({ id: 'bank', balance: 5000 });

    const rejected = useTransactionStore.getState().processTransaction({
      type: 'loan_given', amount: 1200, sourceAccountId: 'bank', personName: 'Ali',
      emiPlan: [{ id: 'z1', installmentNumber: 1, dueDate: '2026-10-01', amount: 100 }],
    });

    await expect(rejected).rejects.toMatchObject({ code: 'EMI_PLAN_REJECTED' });
    // Bilingual copy, never a raw Postgres token.
    await expect(rejected).rejects.toThrow(tStatic('err_emi_plan_rejected'));

    // A CLEAN failure: the RPC was never reached, so there is nothing to undo.
    expect(rpcCalls()).toHaveLength(0);
    expect(remoteAccount('bank')?.balance).toBe(5000);
    expect(useAccountStore.getState().getAccount('bank')?.balance).toBe(5000);
    expect(remoteLoans()).toHaveLength(0);
    expect(remoteTransactions()).toHaveLength(0);
    expect(remoteEmis()).toHaveLength(0);
    expect(useLoanStore.getState().loans).toHaveLength(0);
    expect(useEmiStore.getState().schedules).toHaveLength(0);
  });

  it('a SERVER refusal of the plan creates no half-loan either', async () => {
    // The one refusal the client cannot predict: an instalment id that is
    // already in the table. The RPC is atomic, so the whole creation is undone
    // with it — the balance, the loan, the row and the instalments.
    seedAndLoad({ id: 'bank', balance: 5000 });

    await useTransactionStore.getState().processTransaction({
      type: 'loan_taken', amount: 1200, destinationAccountId: 'bank',
      personName: 'Bilal', emiPlan: plan(1200, 4, '2026-10-01'),
    });
    const balanceAfterFirst = remoteAccount('bank')?.balance;

    await expect(
      useTransactionStore.getState().processTransaction({
        // Same id prefix → 'e1' collides with the schedule above.
        type: 'loan_taken', amount: 600, destinationAccountId: 'bank',
        personName: 'Bilal', emiPlan: plan(600, 2, '2026-10-01'),
      }),
    ).rejects.toMatchObject({ code: 'EMI_PLAN_REJECTED' });

    // Exactly the first loan's artifacts survive — nothing of the second.
    expect(remoteAccount('bank')?.balance).toBe(balanceAfterFirst);
    expect(remoteLoans()).toHaveLength(1);
    expect(remoteTransactions()).toHaveLength(1);
    expect(remoteEmis()).toHaveLength(4);
    expect(useLoanStore.getState().loans).toHaveLength(1);
    expect(useEmiStore.getState().schedules).toHaveLength(4);
  });

  it('a failure AFTER the RPC unwinds the instalments with everything else', async () => {
    seedAndLoad({ id: 'bank', balance: 5000 });
    failNextTxAdd(new Error('Simulated DB failure'));

    await expect(
      useTransactionStore.getState().processTransaction({
        type: 'loan_taken', amount: 1200, destinationAccountId: 'bank',
        personName: 'Bilal', emiPlan: plan(1200, 4, '2026-10-01'),
      }),
    ).rejects.toThrow(/Simulated DB failure/);

    // FIVE artifacts reversed together — the schedule included, which the
    // legacy page-level call could never have been part of.
    expect(remoteAccount('bank')?.balance).toBe(5000);
    expect(remoteLoans()).toHaveLength(0);
    expect(remoteTransactions()).toHaveLength(0);
    expect(remoteEmis()).toHaveLength(0);
    expect(useEmiStore.getState().schedules).toHaveLength(0);
    expect(useLoanStore.getState().loans).toHaveLength(0);
  });

  it('attaching to an EXISTING loan never smuggles a second schedule onto it', async () => {
    // The plan is dropped rather than forwarded (the compensation can only
    // unwind instalments by deleting the whole loan's schedule, which would be
    // destructive for a loan that was already there) — and because it is
    // dropped, loanScheduleAlreadyCreated stays false and the page still
    // generates one client-side. Nothing is silently lost.
    seedAndLoad({ id: 'bank', balance: 5000 });

    const first = await useTransactionStore.getState().processTransaction({
      type: 'loan_given', amount: 250, sourceAccountId: 'bank', personName: 'Ali',
    });
    const loanId = first.relatedLoanId!;

    await useTransactionStore.getState().processTransaction({
      type: 'loan_given', amount: 100, sourceAccountId: 'bank',
      personName: 'Ali', loanId, emiPlan: plan(100, 2, '2026-10-01', 'attach'),
    });

    expect(rpcCalls()[1]).toMatchObject({ createLoan: false, loanId, emi: null });
    expect(remoteEmis()).toHaveLength(0);
    expect(loanScheduleAlreadyCreated(loanId)).toBe(false);
  });

  it('splits_only still generates its schedule client-side — no RPC in sight', async () => {
    // Ledger mode has no accounts, so loanStore.createLoan writes the loan and
    // emiStore.generateSchedule writes the schedule, both client-side. Neither
    // half changes under this flag, and create_loan_with_leg would refuse the
    // loan anyway (ACCOUNT_NOT_FOUND on a null account).
    useAppModeStore.setState({ mode: 'splits_only' });

    const loan = await useLoanStore.getState().createLoan({
      personName: 'Sara', personId: null, type: 'given',
      totalAmount: 1200, currency: 'AED', notes: '',
    });
    await useEmiStore.getState().generateSchedule({
      loanId: loan.id, totalAmount: 1200, installments: 4, startDate: '2026-10-01',
    });

    expect(rpcCalls()).toHaveLength(0);
    expect(remoteTransactions()).toHaveLength(0);
    expect(remoteEmis()).toHaveLength(4);
    expect(useEmiStore.getState().getByLoan(loan.id)).toHaveLength(4);
    expect(remoteEmis().every((e) => e.status === 'upcoming')).toBe(true);
  });
});
