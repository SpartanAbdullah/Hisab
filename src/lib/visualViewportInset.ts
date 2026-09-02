// Pure math for `useVisualViewportInset` (src/hooks/useVisualViewportInset.ts).
// Split out so it can be unit-tested without a DOM/visualViewport shim —
// vitest runs in Node (see vitest.config.ts header).

/**
 * How much of the bottom of the layout viewport is currently covered by the
 * on-screen keyboard (or any other visual-viewport-shrinking chrome), in px.
 *
 * `visualViewport.height` + `visualViewport.offsetTop` describes the visible
 * region; `window.innerHeight` describes the full layout viewport a
 * `position: fixed` element is anchored against. The gap between them is
 * what a fixed-bottom element needs to shift up by to stay clear of the
 * keyboard. Small (sub-1px) or negative gaps are noise (browser chrome
 * rounding, momentum scroll) and are floored to 0.
 */
export function computeVisualViewportInset(
  innerHeight: number,
  visualViewportHeight: number,
  visualViewportOffsetTop: number,
): number {
  const covered = innerHeight - visualViewportHeight - visualViewportOffsetTop;
  return covered > 1 ? Math.round(covered) : 0;
}
