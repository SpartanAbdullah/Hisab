// WCAG 2.x contrast math — pure functions, no DOM. Used to compute and
// verify the token pairs documented in docs/accessibility-contrast.md
// (audit 09-ui-quality.md §4, "Contrast — systemic small-text failures").
//
// Formulas: https://www.w3.org/WAI/WCAG21/Understanding/contrast-minimum.html
// (relative luminance) and the accompanying contrast-ratio formula.

export type Hex = string;

/** Parses `#RGB` or `#RRGGBB` into 0-255 channel values. Throws on anything else. */
export function hexToRgb(hex: Hex): [number, number, number] {
  const h = hex.trim().replace('#', '');
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  if (!/^[0-9a-fA-F]{6}$/.test(full)) {
    throw new Error(`contrast: not a hex color: ${hex}`);
  }
  return [
    parseInt(full.slice(0, 2), 16),
    parseInt(full.slice(2, 4), 16),
    parseInt(full.slice(4, 6), 16),
  ];
}

// sRGB -> linear-light channel, per the WCAG formula.
function srgbChannelToLinear(c: number): number {
  const cs = c / 255;
  return cs <= 0.03928 ? cs / 12.92 : Math.pow((cs + 0.055) / 1.055, 2.4);
}

/** WCAG relative luminance (0 = black, 1 = white) of a hex color. */
export function relativeLuminance(hex: Hex): number {
  const [r, g, b] = hexToRgb(hex);
  return (
    0.2126 * srgbChannelToLinear(r) +
    0.7152 * srgbChannelToLinear(g) +
    0.0722 * srgbChannelToLinear(b)
  );
}

/** WCAG contrast ratio between two colors, in the range [1, 21]. Order doesn't matter. */
export function contrastRatio(a: Hex, b: Hex): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const lighter = Math.max(la, lb);
  const darker = Math.min(la, lb);
  return (lighter + 0.05) / (darker + 0.05);
}

/**
 * WCAG 2.x AA minimums. `largeText` = true for text at ≥24px regular weight
 * or ≥18.66px (14pt) at bold (font-weight ≥ 700) — the "large text" carve-out
 * that drops the bar from 4.5:1 to 3:1.
 */
export function meetsAA(ratio: number, largeText = false): boolean {
  return ratio >= (largeText ? 3 : 4.5);
}
