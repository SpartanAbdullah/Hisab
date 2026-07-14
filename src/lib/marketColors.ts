// Stable per-market color coding. Each market gets a consistent hue from the
// Sukoon palette (derived from its id, so it never changes between renders,
// devices, or reorderings) — used on market chips, holding tiles, and the
// market label wherever holdings are shown.

export interface MarketColor {
  /** Chip / tile background when unselected. */
  bg: string;
  /** Text on that background. */
  text: string;
  /** Border matching the hue. */
  border: string;
  /** Selected-chip background (solid). */
  solidBg: string;
  /** Text on the solid background. */
  solidText: string;
}

const PALETTE: MarketColor[] = [
  { bg: 'bg-accent-50', text: 'text-accent-600', border: 'border-accent-100', solidBg: 'bg-accent-600', solidText: 'text-white' },
  { bg: 'bg-info-50', text: 'text-info-600', border: 'border-info-600/25', solidBg: 'bg-info-600', solidText: 'text-white' },
  { bg: 'bg-receive-50', text: 'text-receive-text', border: 'border-receive-100', solidBg: 'bg-receive-700', solidText: 'text-white' },
  { bg: 'bg-warn-50', text: 'text-warn-700', border: 'border-warn-600/25', solidBg: 'bg-warn-700', solidText: 'text-white' },
  { bg: 'bg-pay-50', text: 'text-pay-text', border: 'border-pay-100', solidBg: 'bg-pay-700', solidText: 'text-white' },
];

/** Deterministic, well-distributed hash of the market id. */
function hashCode(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

export function marketColorFor(marketId: string): MarketColor {
  return PALETTE[hashCode(marketId) % PALETTE.length];
}
