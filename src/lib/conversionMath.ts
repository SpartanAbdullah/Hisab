// Math for the cross-currency conversion card. The design premise: users
// don't know exchange rates — they know what they sent and what landed on
// the other side. So the primary input is the RECEIVED amount and the rate
// is derived, with direct-rate entry (either direction) as the advanced
// path. Pure + tested; all display/i18n stays in the component.

// Sanity bounds shared with the old inline validation (Phase H2): a typo'd
// rate silently corrupts balances, so reject anything outside this window.
export const RATE_MIN = 0.0001;
export const RATE_MAX = 100000;

export function rateIsSane(rate: number): boolean {
  return Number.isFinite(rate) && rate >= RATE_MIN && rate <= RATE_MAX;
}

/**
 * Rate ("1 sent-currency = rate received-currency") derived from the two
 * amounts the user actually knows. Returns null when either side is missing
 * or nonsense — the caller keeps the previous rate in that case.
 */
export function deriveRate(sentAmount: number, receivedAmount: number): number | null {
  if (!Number.isFinite(sentAmount) || sentAmount <= 0) return null;
  if (!Number.isFinite(receivedAmount) || receivedAmount <= 0) return null;
  const rate = receivedAmount / sentAmount;
  return rateIsSane(rate) ? rate : null;
}

/** Amount converted by a to-per-from rate, rounded to 2dp (money). */
export function convertAmount(amount: number, rate: number): number {
  return Math.round(amount * rate * 100) / 100;
}

/**
 * Inverse rate for the flip affordance ("1 PKR = 0.0131 AED"). Null when the
 * inverse would fall outside the sane window (e.g. rate 0 or absurd).
 */
export function invertRate(rate: number): number | null {
  if (!Number.isFinite(rate) || rate <= 0) return null;
  const inv = 1 / rate;
  return rateIsSane(inv) ? inv : null;
}

/**
 * Compact display for a rate: enough precision to be meaningful for both
 * big rates (1 AED = 76.5 PKR) and tiny ones (1 PKR = 0.0131 AED), without
 * dumping float noise on the user.
 */
export function formatRate(rate: number): string {
  if (!Number.isFinite(rate)) return '—';
  if (rate >= 100) return rate.toLocaleString(undefined, { maximumFractionDigits: 2 });
  if (rate >= 1) return rate.toLocaleString(undefined, { maximumFractionDigits: 4 });
  return rate.toLocaleString(undefined, { maximumSignificantDigits: 4 });
}
