import { describe, expect, it } from 'vitest';
import { computeVisualViewportInset } from './visualViewportInset';

describe('computeVisualViewportInset', () => {
  it('returns 0 when the visual viewport fills the layout viewport (no keyboard)', () => {
    expect(computeVisualViewportInset(800, 800, 0)).toBe(0);
  });

  it('returns the covered height when the keyboard shrinks the visual viewport', () => {
    // Keyboard covers the bottom 300px.
    expect(computeVisualViewportInset(800, 500, 0)).toBe(300);
  });

  it('accounts for offsetTop when the page has scrolled within the visual viewport', () => {
    expect(computeVisualViewportInset(800, 500, 20)).toBe(280);
  });

  it('floors sub-pixel rounding noise to 0', () => {
    expect(computeVisualViewportInset(800, 799.6, 0)).toBe(0);
    expect(computeVisualViewportInset(800, 800.4, 0)).toBe(0);
  });

  it('never returns a negative inset', () => {
    // visualViewport briefly larger than innerHeight during a pinch-zoom
    // gesture on some browsers.
    expect(computeVisualViewportInset(800, 820, 0)).toBe(0);
  });

  it('rounds the covered amount to a whole pixel', () => {
    expect(computeVisualViewportInset(800, 500.4, 0)).toBe(300);
  });
});
