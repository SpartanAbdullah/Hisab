// Premium per-market color identity, tuned to how top-tier fintech apps
// (Tabby, TAMM, Revolut) actually use color: a quiet tinted surface with a
// deep jewel-tone text/dot for idle tags, and a single solid deep hue for
// the selected state. No multi-hue gradients, no neon — color codes the
// market, restraint keeps it premium. Stable per market (hashed id), and
// the /10 tints + deep solids read well in BOTH light and dark themes.
//
// Per-hue scales are hand-tuned for contrast (e.g. amber needs 700 where
// blue is fine at 600).

export interface MarketColor {
  /** Soft tinted surface for idle chips / monogram tiles. */
  tint: string;
  /** Deep hue text on cream or tint surfaces. */
  text: string;
  /** Whisper-strength border matching the hue. */
  border: string;
  /** Solid deep fill for the SELECTED state — pair with white text. */
  solid: string;
  /** Small identity dot. */
  dot: string;
}

const PALETTE: MarketColor[] = [
  { tint: 'bg-teal-600/10', text: 'text-teal-700', border: 'border-teal-600/20', solid: 'bg-teal-700', dot: 'bg-teal-600' },
  { tint: 'bg-indigo-600/10', text: 'text-indigo-600', border: 'border-indigo-600/20', solid: 'bg-indigo-600', dot: 'bg-indigo-500' },
  { tint: 'bg-amber-600/10', text: 'text-amber-700', border: 'border-amber-600/25', solid: 'bg-amber-700', dot: 'bg-amber-600' },
  { tint: 'bg-rose-600/10', text: 'text-rose-600', border: 'border-rose-600/20', solid: 'bg-rose-600', dot: 'bg-rose-500' },
  { tint: 'bg-blue-600/10', text: 'text-blue-600', border: 'border-blue-600/20', solid: 'bg-blue-600', dot: 'bg-blue-500' },
  { tint: 'bg-emerald-600/10', text: 'text-emerald-700', border: 'border-emerald-600/20', solid: 'bg-emerald-700', dot: 'bg-emerald-600' },
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
