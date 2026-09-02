// Pure helpers for `useBackStackLayer` (src/hooks/useBackStackLayer.ts).
// Split out so the state-matching logic can be unit-tested without a DOM
// (vitest runs in Node — see vitest.config.ts header).
//
// Context (audit MF-08): ConfirmDestructiveSheet, GlobalSearch, and the QR
// scanner render as full-screen overlays that never register on the
// history/back stack, so a hardware or browser back press while one is open
// falls through to the page underneath instead of closing the overlay. The
// fix pushes a synthetic history entry tagged `{ layer: <name> }` while the
// overlay is open, and treats a `popstate` landing on an entry WITHOUT that
// tag as "the user pressed back — close this layer" instead of letting the
// router navigate.

export interface LayerState {
  layer?: string;
  [key: string]: unknown;
}

/** True when `state` is the history-entry marker for the named overlay layer. */
export function isLayerState(state: unknown, layerName: string): boolean {
  return Boolean(
    state &&
    typeof state === 'object' &&
    (state as LayerState).layer === layerName,
  );
}

/**
 * Builds the `history.state` object for a newly-pushed overlay-layer entry.
 * Preserves whatever was already there (e.g. React Router's own
 * `{ usr, key, idx }` shape) so popping back off this layer lands on a state
 * the rest of the app still recognises — we only ever ADD the `layer` tag,
 * never replace the entry outright.
 */
export function withLayer(currentState: unknown, layerName: string): LayerState {
  const base = currentState && typeof currentState === 'object'
    ? (currentState as Record<string, unknown>)
    : {};
  return { ...base, layer: layerName };
}
