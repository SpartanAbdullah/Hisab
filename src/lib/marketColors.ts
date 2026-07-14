// Bold, Tabby/Noon-style per-market color identity. Each market gets a
// vivid gradient (stable — hashed from its id, so DFM keeps its color on
// every screen, device and reorder) used on chips, symbol tiles and badges.
// Gradient + white text works in light AND dark themes, and every entry
// carries a matching colored glow so the tiles feel alive, not flat.

export interface MarketColor {
  /** Bold gradient fill — pair with white text. */
  gradient: string;
  /** Colored glow shadow to lift gradient elements off the page. */
  glow: string;
  /** Inline colored text (works on cream and dark surfaces). */
  text: string;
}

const PALETTE: MarketColor[] = [
  { gradient: 'bg-gradient-to-br from-violet-500 to-purple-600', glow: 'shadow-md shadow-violet-500/40', text: 'text-violet-500' },
  { gradient: 'bg-gradient-to-br from-emerald-400 to-teal-600', glow: 'shadow-md shadow-teal-500/40', text: 'text-teal-600' },
  { gradient: 'bg-gradient-to-br from-orange-400 to-rose-500', glow: 'shadow-md shadow-rose-500/40', text: 'text-rose-500' },
  { gradient: 'bg-gradient-to-br from-sky-400 to-blue-600', glow: 'shadow-md shadow-blue-500/40', text: 'text-blue-500' },
  { gradient: 'bg-gradient-to-br from-amber-400 to-orange-500', glow: 'shadow-md shadow-amber-500/40', text: 'text-amber-600' },
  { gradient: 'bg-gradient-to-br from-pink-400 to-fuchsia-600', glow: 'shadow-md shadow-fuchsia-500/40', text: 'text-fuchsia-500' },
  { gradient: 'bg-gradient-to-br from-cyan-400 to-sky-500', glow: 'shadow-md shadow-cyan-500/40', text: 'text-cyan-600' },
  { gradient: 'bg-gradient-to-br from-indigo-400 to-violet-600', glow: 'shadow-md shadow-indigo-500/40', text: 'text-indigo-500' },
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
