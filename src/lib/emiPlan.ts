// The instalment schedule, as a PURE plan.
//
// Why this file exists (L4 step 3, docs/server-side-money-engine.md §13.1 /
// §16): until now the only place that could compute a loan's instalments was
// `emiStore.generateSchedule`, which computes AND writes in one step. The pages
// therefore called it AFTER `processTransaction` had already resolved — outside
// the MutationScope entirely — so a dropped connection between the two left a
// funded loan with no schedule and nothing rolled back. `create_loan_with_leg`
// accepts the schedule as `p_emi` and inserts it inside the same Postgres
// transaction; to hand it one, the *computation* has to be separable from the
// *write*. That separation is this module.
//
// `planEmiRows` is byte-identical to the arithmetic `generateSchedule` has
// always performed (emiStore.ts:63-84), and `generateSchedule` now calls it —
// so the legacy path and the atomic path share one source of truth for what an
// instalment plan looks like, and `emiPlan.test.ts` pins the parity.
//
// Deliberately loan-AGNOSTIC: a row carries no `loanId` and no `status`. The
// atomic path has to plan the schedule BEFORE the loan id exists (the server
// mints the row and echoes the id back), and the legacy path stamps the loan id
// on afterwards. Keeping the loan out of the plan is what lets both do that,
// and it makes the shape structurally identical to `LoanEmiPlanRow` in
// src/lib/loanCreateAtomicPlan.ts, whose `emiPlanProblem` / `toEmiPayload`
// consume these rows unchanged.

import { v4 as uuid } from 'uuid';
import { addMonths, format } from 'date-fns';

export interface EmiPlanInput {
  /** The loan total the instalments must add up to. */
  totalAmount: number;
  /** How many instalments. 0 or less plans nothing. */
  installments: number;
  /** `yyyy-MM-dd` (or any Date-parsable string). Instalment 1 falls here. */
  startDate: string;
  /**
   * Statement-native cash advances pass explicit due-dates anchored to the
   * funding card's statement day (`statementInstalmentDates`). When present
   * these win over `startDate` — a card instalment is billed on the card's
   * statement day, never a free-typed date. Human loans omit it and keep the
   * monthly-from-startDate behaviour.
   */
  dueDates?: string[];
  /**
   * Id factory, one call per instalment in order. Defaults to uuid v4 — the
   * same generator `generateSchedule` has always used. Injected only by tests,
   * which need the ids to be predictable to assert the payload.
   */
  makeId?: (index: number) => string;
}

/**
 * One planned instalment. No `loanId`, no `status` — see the header.
 * Structurally the `LoanEmiPlanRow` that `loanCreateAtomicPlan` validates and
 * converts to the RPC's snake_case `p_emi` shape.
 */
export interface EmiPlanRow {
  id: string;
  /** 1-based, and always exactly 1..N — the server refuses anything else. */
  installmentNumber: number;
  /** `yyyy-MM-dd`, matching the TEXT column emi_schedules.due_date. */
  dueDate: string;
  amount: number;
}

/**
 * Plan `installments` instalments for `totalAmount`.
 *
 * The arithmetic, unchanged from emiStore.generateSchedule:
 *   · every instalment is `round(totalAmount / installments, 2)` …
 *   · … except the LAST, which absorbs the rounding tail as
 *     `round(totalAmount − emiAmount × (installments − 1), 2)`, so the plan
 *     always sums to the loan (1000 / 3 → 333.33, 333.33, 333.34). That is
 *     what keeps the server's `EMI_PLAN_MISMATCH` sum rule satisfied.
 *   · due dates come from `dueDates[i]` when supplied, else
 *     `addMonths(startDate, i)` formatted `yyyy-MM-dd`.
 *
 * Returns `[]` for a non-positive instalment count — the same no-op the old
 * `for` loop produced — so a caller cannot accidentally send `p_emi: []`
 * meaning "a plan" when it meant "no plan".
 */
export function planEmiRows(input: EmiPlanInput): EmiPlanRow[] {
  const count = input.installments;
  if (!Number.isFinite(count) || count <= 0) return [];

  const makeId = input.makeId ?? (() => uuid());
  const emiAmount = Math.round((input.totalAmount / count) * 100) / 100;
  const startDate = new Date(input.startDate);
  const dueDateFor = (i: number): string =>
    input.dueDates && input.dueDates[i]
      ? input.dueDates[i]
      : format(addMonths(startDate, i), 'yyyy-MM-dd');

  const rows: EmiPlanRow[] = [];
  for (let i = 0; i < count; i++) {
    rows.push({
      id: makeId(i),
      installmentNumber: i + 1,
      dueDate: dueDateFor(i),
      amount: i === count - 1
        ? Math.round((input.totalAmount - emiAmount * (count - 1)) * 100) / 100
        : emiAmount,
    });
  }
  return rows;
}
