import { describe, expect, it } from 'vitest';
import { contrastRatio, hexToRgb, meetsAA, relativeLuminance } from './contrast';

describe('hexToRgb', () => {
  it('parses 6-digit hex', () => {
    expect(hexToRgb('#0B0E2A')).toEqual([11, 14, 42]);
  });

  it('parses 3-digit shorthand hex', () => {
    expect(hexToRgb('#fff')).toEqual([255, 255, 255]);
  });

  it('throws on an invalid color', () => {
    expect(() => hexToRgb('not-a-color')).toThrow();
  });
});

describe('relativeLuminance', () => {
  it('is 0 for black and 1 for white', () => {
    expect(relativeLuminance('#000000')).toBeCloseTo(0, 5);
    expect(relativeLuminance('#FFFFFF')).toBeCloseTo(1, 5);
  });
});

describe('contrastRatio', () => {
  it('is 21:1 for black on white (WCAG reference value)', () => {
    expect(contrastRatio('#000000', '#FFFFFF')).toBeCloseTo(21, 1);
  });

  it('is 1:1 for a color against itself', () => {
    expect(contrastRatio('#7E809A', '#7E809A')).toBeCloseTo(1, 5);
  });

  it('is order-independent', () => {
    expect(contrastRatio('#A8AABD', '#F4F2EC')).toBeCloseTo(
      contrastRatio('#F4F2EC', '#A8AABD'),
      10,
    );
  });
});

describe('meetsAA', () => {
  it('requires 4.5:1 for normal-size text', () => {
    expect(meetsAA(4.49)).toBe(false);
    expect(meetsAA(4.5)).toBe(true);
  });

  it('drops to 3:1 for large/bold text', () => {
    expect(meetsAA(2.99, true)).toBe(false);
    expect(meetsAA(3, true)).toBe(true);
  });
});

// Regression guard for the token fixes in src/index.css (audit
// 09-ui-quality.md §4; math documented in docs/accessibility-contrast.md).
// If these start failing, someone changed a token hex back toward the
// pre-fix value without re-deriving new AA-passing values.
describe('Sukoon token contrast — light theme (fixed values)', () => {
  const CREAM_BG = '#F4F2EC';
  const WARN_50 = '#FBF3DD';

  it('ink-400 on cream-bg clears normal-text AA', () => {
    expect(meetsAA(contrastRatio('#696C8B', CREAM_BG))).toBe(true);
  });

  it('ink-500 on cream-bg clears normal-text AA', () => {
    expect(meetsAA(contrastRatio('#60627B', CREAM_BG))).toBe(true);
  });

  it('warn-600 on warn-50 clears normal-text AA', () => {
    expect(meetsAA(contrastRatio('#8D6813', WARN_50))).toBe(true);
  });
});

describe('Sukoon token contrast — dark theme (fixed values)', () => {
  const DARK_CREAM_BG = '#131419';
  const DARK_CREAM_CARD = '#1E1F27';
  const DARK_PAY_50 = '#2A1611';

  it('dark ink-400 on dark cream-bg clears normal-text AA', () => {
    expect(meetsAA(contrastRatio('#848699', DARK_CREAM_BG))).toBe(true);
  });

  it('dark ink-400 on dark cream-card clears normal-text AA (the binding surface — cream-card is lighter than cream-bg in dark mode, so it gives LESS contrast for light text, unlike in light mode)', () => {
    expect(meetsAA(contrastRatio('#848699', DARK_CREAM_CARD))).toBe(true);
  });

  it('dark pay-700 on dark pay-50 clears normal-text AA', () => {
    expect(meetsAA(contrastRatio('#CA6752', DARK_PAY_50))).toBe(true);
  });
});
