// The pure half of the server-side loan-creation engine (L4 step 3).
//
// `create_loan_with_leg` (supabase-migration-p3-atomic-loan-create.sql) commits
// the funding/receiving account leg, the optional credit-card cash-advance leg,
// the loans row, an optional EMI schedule and the transactions row in ONE
// Postgres transaction. Two decisions have to be made before that call, and
// both are the kind that silently corrupt money when they are wrong:
//
//   1. WHICH account moves WHICH way, and which id lands in which column of the
//      transactions row. `loan_given` debits its source; `loan_taken` credits
//      its destination AND, for a cash advance, debits a card as well — so the
//      row can carry one id, or two, depending on a branch three levels deep.
//   2. Whether an EMI schedule actually adds up to the loan it belongs to.
//
// Both are pure functions of values the store already holds, so both are
// unit-testable without Supabase. The server re-derives (1) from its own
// `loans.type` and re-validates (2) with the identical rule — this file is the
// client's copy, deliberately, so a mismatch fails a test rather than a user's
// wallet. Same philosophy as src/lib/repaymentAtomicPlan.ts.

/**
 * The tolerance the whole product uses for allocation arithmetic:
 * p1-money-bounds' split-sum check, splitMath's remainder rule, and the
 * server's own EMI sum check. Half a paisa either side of a cent.
 */
export const EMI_SUM_TOLERANCE = 0.01;

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export type LoanDirection = 'given' | 'taken';

export interface LoanCreateLegInput {
  direction: LoanDirection;
  amount: number;
  /** Source for a loan given, destination for one taken. Never empty. */
  accountId: string;
  /**
   * The credit card a cash advance is drawn on. `loan_taken` only; the branch
   * already refuses a non-card, or one in another currency, before this runs.
   */
  cardAccountId?: string | null;
}

export interface LoanCreateLegs {
  /** What lands in transactions.source_account_id. */
  sourceAccountId: string | null;
  /** What lands in transactions.destination_account_id. */
  destinationAccountId: string | null;
  /** Signed, already 2dp: what the primary account moves by. */
  accountDelta: number;
  /** Signed, already 2dp: what the card moves by. Null when there is no card. */
  cardDelta: number | null;
}

/**
 * Reproduce the account bookkeeping of `case 'loan_given'` (transactionStore.ts
 * :1536-1566) and `case 'loan_taken'` (:1568-1607) as one value.
 *
 * The asymmetry is the point:
 *   given                → the account is DEBITED, and it is the row's SOURCE.
 *   taken                → the account is CREDITED, and it is the row's
 *                          DESTINATION; the source stays null.
 *   taken + cash advance → the card is additionally DEBITED and becomes the
 *                          row's SOURCE, so the row reads card → receiver.
 *
 * A cardAccountId on a `given` direction is not representable in the product
 * (the branch has no cash-advance path) and is dropped rather than honoured —
 * the RPC refuses it outright with INVALID_CASH_ADVANCE, and silently inventing
 * a card leg here would be the worse of the two failures.
 */
export function planLoanCreateLegs(input: LoanCreateLegInput): LoanCreateLegs {
  const amount = round2(input.amount);
  const card = input.direction === 'taken' && input.cardAccountId
    ? input.cardAccountId
    : null;

  if (input.direction === 'given') {
    return {
      sourceAccountId: input.accountId,
      destinationAccountId: null,
      accountDelta: -amount,
      cardDelta: null,
    };
  }

  return {
    sourceAccountId: card,
    destinationAccountId: input.accountId,
    accountDelta: amount,
    cardDelta: card ? -amount : null,
  };
}

export interface LoanEmiPlanRow {
  id: string;
  installmentNumber: number;
  dueDate: string;
  amount: number;
}

/**
 * The wire shape `p_emi` takes — snake_case, because it is read straight back
 * out by the plpgsql `e ->> 'installment_number'` expressions.
 */
export interface LoanEmiPlanPayloadRow {
  id: string;
  installment_number: number;
  due_date: string;
  amount: number;
}

/**
 * The client half of the server's EMI validation. Returns a stable token (the
 * SAME token the RPC raises) or null when the plan is sound.
 *
 * Checking here as well as there is not redundancy: a refusal that costs a
 * round-trip on 3G is a refusal the user waits for, and the tokens have to
 * agree or the two halves have forked. The test file asserts they do.
 */
export function emiPlanProblem(
  rows: LoanEmiPlanRow[],
  loanAmount: number,
): 'EMI_PLAN_INVALID' | 'EMI_ID_COLLISION' | 'EMI_PLAN_MISMATCH' | null {
  if (rows.length === 0) return null;
  if (rows.length > 1200) return 'EMI_PLAN_INVALID';

  for (const row of rows) {
    if (typeof row.id !== 'string' || row.id.trim() === '') return 'EMI_PLAN_INVALID';
    if (typeof row.dueDate !== 'string' || row.dueDate.trim() === '') return 'EMI_PLAN_INVALID';
    if (!Number.isFinite(row.amount) || row.amount < 0 || row.amount >= 1e12) {
      return 'EMI_PLAN_INVALID';
    }
    if (!Number.isInteger(row.installmentNumber)
      || row.installmentNumber < 1
      || row.installmentNumber > 1200) {
      return 'EMI_PLAN_INVALID';
    }
  }

  // Numbering must be exactly 1..N, each once — what emiStore.generateSchedule
  // emits, and what uncoveredToPaidIds' oldest-first walk assumes.
  const numbers = new Set(rows.map((r) => r.installmentNumber));
  if (numbers.size !== rows.length) return 'EMI_PLAN_INVALID';
  for (let i = 1; i <= rows.length; i += 1) {
    if (!numbers.has(i)) return 'EMI_PLAN_INVALID';
  }

  if (new Set(rows.map((r) => r.id)).size !== rows.length) return 'EMI_ID_COLLISION';

  const sum = round2(rows.reduce((total, r) => total + r.amount, 0));
  if (Math.abs(sum - round2(loanAmount)) > EMI_SUM_TOLERANCE) return 'EMI_PLAN_MISMATCH';

  return null;
}

/** Camel → the snake_case array the RPC binds. Null when there is no plan. */
export function toEmiPayload(rows: LoanEmiPlanRow[] | null | undefined): LoanEmiPlanPayloadRow[] | null {
  if (!rows || rows.length === 0) return null;
  return rows.map((r) => ({
    id: r.id,
    installment_number: r.installmentNumber,
    due_date: r.dueDate,
    amount: r.amount,
  }));
}
