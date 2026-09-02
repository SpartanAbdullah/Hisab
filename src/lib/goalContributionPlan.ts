// The pure half of the server-side goal-contribution engine (L4 step 4).
//
// `contribute_to_goal` (supabase-migration-p3-atomic-goal-and-card.sql) commits
// the source account leg, `goals.saved_amount`, the optional stored-in-account
// credit leg and the transactions row in ONE Postgres transaction. Two
// decisions have to be made before that call, and both silently corrupt money
// when they are wrong:
//
//   1. WHICH legs run at all. A contribution made FROM the account the goal is
//      stored in moves NO money — the cash physically stays where it is — and
//      debiting it would push the balance below reality. That branch is also
//      CURRENCY-BLIND: it `break`s before the cross-currency check, so it never
//      converts and never writes a rate.
//   2. HOW MUCH leaves the wallet. The convention here is DIVIDE
//      (`round(amount / rate, 2)`), the opposite of the transfer branch's
//      MULTIPLY — and a single implementation of "convert" would mis-convert
//      one of them by a factor of rate².
//
// Both are pure functions of values the store already holds, so both are
// unit-testable without Supabase. The server re-derives (1) from the goal's own
// `stored_in_account_id` and cross-checks (2) within 0.01 — this file is the
// client's copy, deliberately, so a mismatch fails a test rather than a user's
// wallet. Same philosophy as src/lib/repaymentAtomicPlan.ts and
// src/lib/loanCreateAtomicPlan.ts.

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export interface GoalContributionLegInput {
  /** The funding account. Never empty — ledger mode has no goals at all. */
  sourceAccountId: string;
  sourceCurrency: string;
  goalCurrency: string;
  /** `goals.stored_in_account_id`. '' means "tracked internally". */
  goalStoredInAccountId: string;
  /**
   * Whether that stored-in account is actually present in the account store.
   * The column is a LABEL, not a foreign key (no FK on it), so "the goal names
   * an account that no longer exists" is a reachable state and must contribute
   * WITHOUT a credit leg rather than fail — the branch's own `if (linkedAccount)`
   * guard (transactionStore.ts:2128, :2148).
   */
  storedInAccountExists: boolean;
  /** In GOAL currency — what lands on the row and on saved_amount. */
  amount: number;
  /** Market-per-account; required only when the two currencies differ. */
  conversionRate?: number | null;
}

export interface GoalContributionLegs {
  /** The goal is kept in the very account funding it: no balance legs at all. */
  selfStored: boolean;
  /** SOURCE-currency debit. 0 when self-stored. */
  sourceAmount: number;
  /** What lands in transactions.destination_account_id. */
  linkedAccountId: string | null;
  /** What lands in transactions.conversion_rate. */
  conversionRate: number | null;
}

/**
 * Reproduce the account bookkeeping of `case 'goal_contribution'`
 * (transactionStore.ts:2094-2160) as one value.
 *
 * The three shapes, in the order the branch tests them:
 *   self-stored           → no legs, no rate, currency-blind, destination NULL
 *   cross-currency        → debit round(amount / rate, 2); credit `amount` to
 *                           the stored-in account when it exists
 *   same currency         → debit `amount`; same credit rule
 *
 * Throws nothing: a missing rate on a cross-currency contribution is the
 * BRANCH's guard (it throws a user-facing string before any money moves) and is
 * deliberately left there — duplicating it here would fork the message.
 * `conversionRate` simply comes back null and the caller's own guard fires.
 */
export function planGoalContributionLegs(
  input: GoalContributionLegInput,
): GoalContributionLegs {
  const amount = round2(input.amount);
  // Compared UNTRIMMED, exactly as the branch does
  // (`goal.storedInAccountId === input.sourceAccountId`); the trim below is
  // only the "is it set at all" test the branch expresses as truthiness.
  const storedIn = input.goalStoredInAccountId;

  if (storedIn && storedIn === input.sourceAccountId) {
    return {
      selfStored: true,
      sourceAmount: 0,
      linkedAccountId: null,
      conversionRate: null,
    };
  }

  const crossCurrency = input.sourceCurrency !== input.goalCurrency;
  const rate = crossCurrency ? input.conversionRate ?? null : null;
  const sourceAmount = crossCurrency && rate ? round2(amount / rate) : amount;

  return {
    selfStored: false,
    sourceAmount,
    // The credit leg exists only when the goal names a DIFFERENT account AND
    // that account is really there.
    linkedAccountId: storedIn.trim() && input.storedInAccountExists ? storedIn : null,
    conversionRate: rate,
  };
}

/**
 * What `contribute_to_goal` will leave in goals.saved_amount.
 *
 * Byte-for-byte the server expression
 *   GREATEST(0, round(saved_amount + round(p_amount, 2), 2))
 * which is itself byte-for-byte goalStore.addContribution's
 *   Math.max(0, Math.round((goal.savedAmount + amount) * 100) / 100)
 * — note that the SUM is rounded, not the addend. Three copies of one rule,
 * deliberately identical; this is the client's.
 *
 * The clamp cannot bite for a positive contribution. It is reproduced because
 * the same column is written with a NEGATIVE delta by the delete path, and a
 * predictor that silently disagreed with the server there would hand the
 * compensation the wrong figure to give back.
 */
export function predictedSavedAfter(savedBefore: number, amount: number): number {
  return Math.max(0, round2(savedBefore + round2(amount)));
}
