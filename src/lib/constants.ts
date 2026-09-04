export const EXPENSE_CATEGORIES = [
  'Food & Dining',
  'Groceries',
  'Transport',
  'Rent',
  'Utilities',
  'Phone & Internet',
  'Healthcare',
  'Education',
  'Shopping',
  'Entertainment',
  'Subscriptions',
  'Remittance',
  'Family Support',
  'Loan Payment',
  'Savings',
  'Other',
] as const;

// The expense category that marks a recurring template as a subscription.
// Phase 1 of the Subscriptions Tracker is a view over recurring expenses
// tagged with this category — no schema change. See subscriptionMetrics.ts.
export const SUBSCRIPTION_CATEGORY = 'Subscriptions';

export const INCOME_CATEGORIES = [
  'Salary',
  'Freelance',
  'Business',
  'Investment',
  'Gift',
  'Refund',
  'Other',
] as const;

import { currencyMeta, currencyMinorUnits } from './currencies';

/**
 * PINNED symbols for the eight currencies that shipped before the ISO
 * widening (2026-09-04). These are what every existing statement, receipt,
 * PDF and screenshot already renders, so they are frozen here rather than
 * read from the ISO catalogue \u2014 changing `AED` to `\u062F.\u0625` retroactively would
 * change documents users have already shared.
 *
 * Any other ISO code falls through to `currencyMeta(code).symbol`, then to
 * the bare code.
 */
export const CURRENCY_SYMBOLS: Record<string, string> = {
  AED: 'AED',
  PKR: '\u20A8',
  PHP: '\u20B1',
  SAR: 'SAR',
  QAR: 'QAR',
  OMR: 'OMR',
  KWD: 'KWD',
  BHD: 'BHD',
};

/** The rendered prefix for a currency \u2014 pinned legacy symbol, else ISO, else the code. */
export const currencySymbol = (currency: string): string =>
  CURRENCY_SYMBOLS[currency] ?? currencyMeta(currency)?.symbol ?? currency;

/**
 * Format an amount for display. ALWAYS unsigned \u2014 callers add the sign (see
 * `formatSignedMoney`).
 *
 * Decimal places follow ISO 4217 minor units, not a hardcoded 2: JPY/KRW/VND
 * render whole units, the Gulf dinars (KWD/BHD/OMR/JOD/IQD/LYD/TND) render
 * three. An unknown code gets 2, the safe default.
 */
export const formatMoney = (amount: number, currency: string): string => {
  const symbol = currencySymbol(currency);
  const digits = currencyMinorUnits(currency);
  const formatted = Math.abs(amount).toLocaleString('en-US', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
  return `${symbol} ${formatted}`;
};

export const formatSignedMoney = (amount: number, currency: string): string => (
  amount < 0 ? `-${formatMoney(amount, currency)}` : formatMoney(amount, currency)
);
