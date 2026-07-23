// Privacy masking for shareable artifacts (statements, settle-up receipts,
// kameti slips, Wrapped cards). With "Hide amounts" on, every money figure
// renders as a FIXED-WIDTH mask — the currency stays visible (context), the
// magnitude does not (a 5-dot vs 7-dot mask would leak how big the number
// is, which defeats the point). Structure, names, dates and the verified
// seal remain, so the document still proves WHAT happened — just not for
// how much.
import { formatMoney } from './constants';

// Exported for the PDF renderers, whose ledgers print bare numbers (currency
// stated once per section header) — they mask with the naked pattern, no symbol.
export const AMOUNT_MASK = '●●,●●●';

export function maskedMoney(currency: string): string {
  // Reuse formatMoney on 0 to obtain the exact symbol/prefix convention,
  // then swap the digits for the mask — one source of truth for symbols.
  const zero = formatMoney(0, currency);
  return zero.replace(/[\d.,]+/, AMOUNT_MASK);
}

/**
 * Returns a formatMoney-compatible formatter: the real one, or the masking
 * one. Render libs take this instead of branching on a boolean at every
 * call site.
 */
export function moneyFormatter(hideAmounts: boolean): (amount: number, currency: string) => string {
  return hideAmounts ? (_amount, currency) => maskedMoney(currency) : formatMoney;
}
