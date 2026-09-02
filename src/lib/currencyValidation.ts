// Currency plausibility + deliberate-confirm rules.
//
// Cross-user linked loans are AED/PKR only and the currency LOCKS at creation
// (it mirrors onto both users and can't be edited after accept). AED and PKR
// differ ~76x, so a currency mix-up is silently catastrophic. This pure module
// catches the gross typos at the source and decides when an action is risky
// enough to warrant a deliberate (double) confirmation. No React, no DB —
// fully unit-testable.

// Approx mid-2026 rate, for MAGNITUDE DISPLAY ONLY — never used to post money.
const PKR_PER_AED = 76;

/**
 * Hard ceiling on any single money value, shared with the server.
 *
 * Mirrors `1e12` in supabase-migration-p1-money-bounds.sql. The number is not
 * arbitrary: every amount in this app round-trips through a JS `number` and is
 * rounded with `Math.round(x * 100) / 100`, which is cent-exact only while
 * `x * 100 <= Number.MAX_SAFE_INTEGER` (9.007e15), i.e. `x <= 9.007e13`. 1e12
 * keeps two orders of magnitude of headroom and is far above any real khata
 * entry, so anything at or beyond it is garbage data, not a user's money.
 *
 * This is the LAST line — the per-currency plausibility bounds below reject
 * far smaller nonsense first, with a far more useful message.
 */
export const MAX_MONEY_MAGNITUDE = 1e12;

/**
 * Per-currency plausibility window for ONE entry.
 *
 * Derivation (all eight, so no currency is silently unbounded — audit
 * docs/audit-2026-09/12-qa-review.md V-2/F-15):
 * `max` is the AED 50,000 anchor that already shipped, converted at approximate
 * mid-2026 rates and rounded to one clean significant figure; `min` is the
 * smallest amount a person plausibly records, on the same scale. They are
 * deliberately generous — the job is catching order-of-magnitude and
 * wrong-currency typos, not policing what someone may lend.
 *
 *   AED  1.00 (anchor)   → max    50,000   min  0.5   [unchanged, shipped]
 *   PKR  ≈  76 per AED   → max 5,000,000   min 10     [unchanged, shipped]
 *   SAR  ≈ 1.02 per AED  → max    50,000   min  0.5
 *   QAR  ≈ 1.00 per AED  → max    50,000   min  0.5
 *   PHP  ≈ 15.4 per AED  → max   750,000   min  5
 *   OMR  ≈ 0.105 per AED → max     5,000   min  0.05
 *   BHD  ≈ 0.103 per AED → max     5,000   min  0.05
 *   KWD  ≈ 0.084 per AED → max     5,000   min  0.05
 *
 * The three Gulf dinars (OMR/BHD/KWD) are worth ~10 AED each, hence the 10x
 * tighter window — a KWD figure typed as if it were AED is exactly the mistake
 * this catches.
 */
export const CURRENCY_BOUNDS: Record<string, { min: number; max: number }> = {
  AED: { min: 0.5, max: 50_000 },
  PKR: { min: 10, max: 5_000_000 },
  SAR: { min: 0.5, max: 50_000 },
  QAR: { min: 0.5, max: 50_000 },
  PHP: { min: 5, max: 750_000 },
  OMR: { min: 0.05, max: 5_000 },
  BHD: { min: 0.05, max: 5_000 },
  KWD: { min: 0.05, max: 5_000 },
};

/**
 * Why a raw money amount is unusable. Currency-independent and
 * language-independent — callers map these onto their own i18n keys, the
 * `ShareErrorCode` convention from splitMath.ts.
 */
export type MoneyAmountProblem = 'not_a_number' | 'not_positive' | 'too_large';

export interface MoneyAmountOptions {
  /**
   * Accept exactly 0. Only for the handful of values that are legitimately
   * zero — a zero-cash investment row (bonus shares), a zero opening balance.
   * Defaults to false: money that MOVES must be greater than zero.
   */
  allowZero?: boolean;
}

/**
 * The one gate every money amount passes before any write. Currency-agnostic
 * and deliberately blunt: NaN, Infinity, negatives, and absurd magnitudes.
 *
 * Returns null when the amount is usable, else the problem code.
 *
 * This is NOT the plausibility check — `plausibilityCheck` below is the
 * per-currency "did you mean PKR?" layer, which is advisory and needs a
 * currency. This one has no opinions and no exceptions: an amount that fails
 * here cannot be recorded in any currency, by any caller, in either app mode.
 */
export function checkMoneyAmount(
  amount: number,
  options: MoneyAmountOptions = {},
): MoneyAmountProblem | null {
  if (typeof amount !== 'number' || !Number.isFinite(amount)) return 'not_a_number';
  if (options.allowZero ? amount < 0 : amount <= 0) return 'not_positive';
  if (Math.abs(amount) >= MAX_MONEY_MAGNITUDE) return 'too_large';
  return null;
}

export interface PlausibilityResult {
  passed: boolean;
  severity?: 'warn' | 'block';
  reason?: string;
}

/**
 * Is this amount plausible for this currency? `block` = almost certainly wrong
 * (zero/negative/absurd) — refuse. `warn` = suspicious but possible (likely a
 * currency mix-up) — confirm before proceeding.
 *
 * All eight SUPPORTED_CURRENCIES now have bounds (audit V-2). An unrecognised
 * currency code still falls through to `passed: true` — validating the CODE is
 * not this function's job (that is the DB's currency whitelist and the client's
 * `isSupportedCurrency`), and a silent pass here is safer than inventing a
 * window for a code we know nothing about. The magnitude ceiling still applies
 * via `checkMoneyAmount`, which has no currency opinion at all.
 */
export function plausibilityCheck(amount: number, currency: string): PlausibilityResult {
  if (checkMoneyAmount(amount) !== null) {
    return { passed: false, severity: 'block', reason: 'Enter an amount greater than zero.' };
  }
  const bounds = CURRENCY_BOUNDS[currency];
  if (!bounds) return { passed: true };

  if (amount > bounds.max) {
    return {
      passed: false,
      severity: 'block',
      reason: `${amount.toLocaleString('en-US')} is unusually large for ${currency} — please double-check.`,
    };
  }
  if (amount < bounds.min) {
    return {
      passed: false,
      severity: 'warn',
      reason: `${amount} is unusually small for ${currency} — did you mean a different currency?`,
    };
  }
  // Cross-confusion: an AED figure that looks like a PKR amount, or vice versa.
  if (currency === 'AED' && amount > 20_000) {
    return {
      passed: false,
      severity: 'warn',
      reason: `${amount.toLocaleString('en-US')} is high for AED (${approxOther(amount, 'AED')}). Did you mean PKR?`,
    };
  }
  if (currency === 'PKR' && amount < 100) {
    return {
      passed: false,
      severity: 'warn',
      reason: `${amount} is low for PKR (${approxOther(amount, 'PKR')}). Did you mean AED?`,
    };
  }
  return { passed: true };
}

/** A human "≈ X OTHER" string for magnitude display. Null for unsupported pairs. */
export function approxOther(amount: number, currency: string): string | null {
  if (currency === 'AED') {
    return `≈ ${Math.round(amount * PKR_PER_AED).toLocaleString('en-US')} PKR`;
  }
  if (currency === 'PKR') {
    return `≈ ${Math.round(amount / PKR_PER_AED).toLocaleString('en-US')} AED`;
  }
  return null;
}

export interface DeliberateConfirmInput {
  crossUser?: boolean; // mirrors to another user's device
  irreversibleCascade?: boolean; // delete cascades (loan→txn→EMI), group delete
  currencyLocked?: boolean; // AED/PKR linked create — currency can't change later
  plausibilityWarn?: boolean; // plausibilityCheck returned a warning
  amount?: number;
  currency?: string;
}

// Above these, even a routine single-user add gets a deliberate confirm.
// AED and PKR are the shipped values, left exactly as they were. The other six
// are CURRENCY_BOUNDS[c].max / 10, the same ratio AED uses (5,000 / 50,000) —
// so a Saudi or Filipino user gets the same "are you sure" moment an Emirati
// one already did, instead of none at all.
const HIGH_AMOUNT_THRESHOLD: Record<string, number> = {
  AED: 5_000,
  PKR: 150_000,
  SAR: 5_000,
  QAR: 5_000,
  PHP: 75_000,
  OMR: 500,
  BHD: 500,
  KWD: 500,
};

/** Should this action require a deliberate (double) confirmation, not just a fast success? */
export function requiresDeliberateConfirm(input: DeliberateConfirmInput): boolean {
  if (input.crossUser || input.irreversibleCascade || input.currencyLocked || input.plausibilityWarn) {
    return true;
  }
  if (input.amount != null && input.currency) {
    const threshold = HIGH_AMOUNT_THRESHOLD[input.currency];
    if (threshold != null && input.amount >= threshold) return true;
  }
  return false;
}
