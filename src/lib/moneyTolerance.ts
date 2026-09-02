// Single source of truth for "is this amount effectively zero money" — the
// group/loan netting engines each grew their own copy of this number
// (docs/who-owes-me.md §7 open risk #5: "two zero-tolerances coexist").
//
// TWO tolerances live here on purpose. Collapsing them into one was the
// starting brief for this module and was found UNSAFE — see "Tolerance rule"
// in docs/who-owes-me.md and the "server boundary" tests in
// moneyTolerance.test.ts for the worked proof.
//
// ── MONEY_TOLERANCE (0.005) ─────────────────────────────────────────────
// The general "this is float noise, not real money" epsilon already used by
// statementOfAccount.isNonZero, settleUpMinimize.SETTLE_TOLERANCE and
// whoOwesMe.WHO_OWES_TOLERANCE. Every value that reaches these comparisons
// has already been rounded to cents (this file's round2 / Postgres'
// round(x,2)), so in practice 0.005 only ever has to answer "is this exactly
// zero after rounding" — any nonzero cent amount (0.01 and up) clears it.
//
// ── GROUP_SETTLEMENT_TOLERANCE (0.01) ───────────────────────────────────
// A DIFFERENT number: the server's own zero-cutoff for group settlements.
//   · record_group_settlement (supabase-migration-audit-p0-group-concurrency
//     .sql:381) refuses to record ANY settlement once the outstanding cap is
//     <= 0.01 ("ALREADY_SETTLED"), and the raw-insert backstop trigger
//     (same file:451) applies the same cap.
//   · leave_group (supabase-migration-safe-leave-group.sql:142) blocks
//     leaving only while |net| > 0.01 — so exactly one cent is "square
//     enough" to leave.
// Both gates compute their inputs with Postgres' round(x, 2) — the same
// rounding rule as this file's round2 — before comparing, so the two RPCs
// agree with each other exactly, and both draw the "zero" line at ONE CENT,
// not half a cent.
//
// `computePairwiseDebts` (groupDebts.ts) is what `record_group_settlement`
// is validated against (group_settlement_cap mirrors it directly, comment at
// concurrency.sql:215-219), and its output also seeds settleUpMinimize's
// balances — the "minimized" plan settles through the same RPC. If the
// pairwise-debt threshold used MONEY_TOLERANCE (0.005) instead of
// GROUP_SETTLEMENT_TOLERANCE (0.01), an exact one-cent net position
// (0.01 > 0.005) would be shown to the user as a real, payable debt — and
// the server would then refuse to record it (cap 0.01 <= 0.01 ⇒
// ALREADY_SETTLED). Symmetrically, on the leave-group gate, exactly one cent
// is "square enough" server-side but would read as an open balance
// client-side. So groupDebts.ts intentionally imports the STRICTER (larger)
// GROUP_SETTLEMENT_TOLERANCE, not the shared MONEY_TOLERANCE — see
// moneyTolerance.test.ts's "server boundary" describe block for the
// regression proof, and docs/who-owes-me.md's "Tolerance rule" section for
// the residual risk this does NOT close (settleUpMinimize.ts is out of this
// change's scope).
export const MONEY_TOLERANCE = 0.005;
export const GROUP_SETTLEMENT_TOLERANCE = 0.01;

/** Round to cents the same way every netting engine in this repo does. */
export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** True when `n` is zero money under the general (0.005) tolerance. */
export function isZeroMoney(n: number): boolean {
  return Math.abs(n) <= MONEY_TOLERANCE;
}

/** True when `a` and `b` are the same money under the general tolerance. */
export function moneyEq(a: number, b: number): boolean {
  return isZeroMoney(a - b);
}

/**
 * True when `n` is zero money under the group-settlement (0.01) tolerance —
 * i.e. the server would treat it as already-settled / square-enough-to-leave.
 * Use this (not `isZeroMoney`) for anything that decides whether to offer or
 * gate a group settlement.
 */
export function isZeroGroupSettlement(n: number): boolean {
  return Math.abs(n) <= GROUP_SETTLEMENT_TOLERANCE;
}

// Back-compat aliases for new importers. settleUpMinimize.ts and whoOwesMe.ts
// keep their OWN local `SETTLE_TOLERANCE` / `WHO_OWES_TOLERANCE` exports
// (this module does not own those files, and does not change them) — these
// aliases just mean new code can pull the same value from one shared module
// instead of learning three names. They are values, not live references: if
// either original file's constant is ever tuned independently of
// MONEY_TOLERANCE, these aliases will silently stop matching it — that's a
// deliberate trade-off for not touching files outside this change's scope.
export const SETTLE_TOLERANCE = MONEY_TOLERANCE;
export const WHO_OWES_TOLERANCE = MONEY_TOLERANCE;
