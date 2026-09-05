// Geometry for the settle-up confetti burst (CelebrationMark).
//
// Pure and DETERMINISTIC on purpose — no Math.random, no layout reads, no
// clock. Three reasons:
//
//   1. Testable. The founder approved this exact spread in the 2026-09-05
//      motion preview (hisaab-motion-picks.html). A test can pin the real
//      geometry — angle, radius, delay, colour cycle — instead of asserting
//      "some bits, somewhere".
//   2. Resume-safe. React may re-render the mark any number of times mid-burst
//      (StrictMode double render, a parent state change, an app resume that
//      remounts the sheet). Every render hands each bit the same
//      --dx/--dy/--rot/--d, so the CSS animation never restarts on a different
//      trajectory halfway through — random values would re-aim the burst on
//      every render.
//   3. Cheap. No DOM access, no getBoundingClientRect. The bits are positioned
//      by CSS custom properties and the browser interpolates transform+opacity
//      on the compositor, which is what the motion contract requires for the
//      low-end Android WebViews this app ships to.
//
// The shape: `count` bits spaced evenly around a circle. Odd bits are nudged
// 0.18 rad so the ring does not read as a perfect polygon; radii step through
// four rings (radius, +11, +22, +33) so the burst has depth; dy is lifted 10px
// because a burst that lands slightly above centre reads as "up and out"
// rather than "dropped". Rotation direction alternates so neighbouring shards
// spin against each other.

export interface ConfettiBit {
  /** Horizontal travel in px, relative to the mark's centre. */
  dx: number;
  /** Vertical travel in px (negative = up), already including the 10px lift. */
  dy: number;
  /** End rotation in degrees; sign alternates bit to bit. */
  rot: number;
  /** Animation delay in ms, staggered in five 40ms steps. */
  delayMs: number;
  /** Clay tint key as 'R G B' — wrap it as `rgb(R G B)` in CSS. */
  color: string;
  /** 'dot' = 8px round; 'shard' = 7x10 rectangle with 2px corners. */
  shape: 'dot' | 'shard';
}

/**
 * The six clay tint key colours, as space-separated 'R G B' triples so they
 * compose into modern `rgb(R G B / a)` syntax. Order matters: bit i takes
 * colour i % 6, and this is the order the approved preview used.
 */
export const CONFETTI_COLORS: readonly string[] = [
  '218 180 78', // gold
  '104 141 223', // sky
  '218 108 145', // blush
  '107 199 150', // mint
  '227 138 99', // coral
  '139 113 244', // accent
];

/** Radii step through four rings: radius, +11, +22, +33. */
const RING_STEP = 11;
const RING_COUNT = 4;
/** Upward lift applied to every bit's landing point. */
const LIFT_PX = 10;
/** Odd bits are rotated off the even grid by this much (radians). */
const ODD_NUDGE_RAD = 0.18;
const BASE_DELAY_MS = 160;
const DELAY_STEP_MS = 40;
const DELAY_STEPS = 5;

/** The furthest any bit travels from centre, before the lift. */
export function confettiOuterRadius(radius = 52): number {
  return radius + (RING_COUNT - 1) * RING_STEP;
}

export function confettiBits(count = 20, radius = 52): ConfettiBit[] {
  const bits: ConfettiBit[] = [];
  for (let i = 0; i < count; i++) {
    const odd = i % 2 === 1;
    const angle = (i / count) * Math.PI * 2 + (odd ? ODD_NUDGE_RAD : 0);
    const r = radius + (i % RING_COUNT) * RING_STEP;
    bits.push({
      dx: Math.round(Math.cos(angle) * r),
      dy: Math.round(Math.sin(angle) * r - LIFT_PX),
      rot: (odd ? 1 : -1) * (120 + i * 13),
      delayMs: BASE_DELAY_MS + (i % DELAY_STEPS) * DELAY_STEP_MS,
      color: CONFETTI_COLORS[i % CONFETTI_COLORS.length],
      shape: i % 3 === 0 ? 'shard' : 'dot',
    });
  }
  return bits;
}
