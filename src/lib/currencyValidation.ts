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

export const CURRENCY_BOUNDS: Record<string, { min: number; max: number }> = {
  AED: { min: 0.5, max: 50_000 },
  PKR: { min: 10, max: 5_000_000 },
};

export interface PlausibilityResult {
  passed: boolean;
  severity?: 'warn' | 'block';
  reason?: string;
}

/**
 * Is this amount plausible for this currency? `block` = almost certainly wrong
 * (zero/negative/absurd) — refuse. `warn` = suspicious but possible (likely a
 * currency mix-up) — confirm before proceeding. Currencies without bounds
 * (anything other than AED/PKR) always pass.
 */
export function plausibilityCheck(amount: number, currency: string): PlausibilityResult {
  if (!Number.isFinite(amount) || amount <= 0) {
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
const HIGH_AMOUNT_THRESHOLD: Record<string, number> = {
  AED: 5_000,
  PKR: 150_000,
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
