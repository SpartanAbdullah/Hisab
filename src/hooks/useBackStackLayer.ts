import { useEffect, useRef } from 'react';
import { isLayerState, withLayer } from '../lib/backStackLayer';

/**
 * Makes a full-screen overlay (confirm sheet, global search, QR scanner)
 * closeable with the hardware/browser back button, without it falling
 * through to the route underneath (audit MF-08).
 *
 * While `open` is true, pushes a synthetic `history` entry tagged
 * `{ layer: layerName }` on top of whatever's already there. A back press
 * (hardware Android back, or a browser/PWA back gesture) fires `popstate`,
 * landing on the entry below ours — which does NOT carry our layer tag — so
 * we call `onClose()` instead of letting the router react to the
 * navigation. Because the pushed entry shares the current URL (only
 * `history.state` changes), popping it never changes `location.pathname`,
 * so React Router does not re-render routes for it.
 *
 * If the overlay closes by any OTHER means (backdrop tap, X button, Escape,
 * a programmatic close), the synthetic entry is still sitting in history —
 * cleanup consumes it with one `history.back()` so the stack doesn't grow by
 * one entry every open/close cycle (which would otherwise take two back
 * presses to leave the page after the sheet had been opened once).
 *
 * Distinct from `uiStore`'s `modalStack` (src/stores/uiStore.ts), which is
 * an in-memory stack the Capacitor `backButton` listener pops directly
 * (src/lib/nativeBridge.ts) — that mechanism doesn't touch `history` at all,
 * so it does nothing for a browser/PWA back gesture. This hook covers both.
 */
export function useBackStackLayer(open: boolean, onClose: () => void, layerName = 'sheet'): void {
  // Ref updated post-render (not during it, which react-hooks/refs flags) so
  // the popstate handler below always calls the latest onClose without
  // needing it in the effect's dependency array.
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });

  const pushedRef = useRef(false);

  useEffect(() => {
    if (typeof window === 'undefined' || !open) return;

    window.history.pushState(withLayer(window.history.state, layerName), '');
    pushedRef.current = true;

    const onPopState = (event: PopStateEvent) => {
      // Landed back on an entry that still carries our tag (shouldn't
      // normally happen — defensive only): nothing to close yet.
      if (isLayerState(event.state, layerName)) return;
      pushedRef.current = false;
      onCloseRef.current();
    };

    window.addEventListener('popstate', onPopState);

    return () => {
      window.removeEventListener('popstate', onPopState);
      // Closed by something other than a back press — consume the entry we
      // pushed so the back stack stays balanced.
      if (pushedRef.current) {
        pushedRef.current = false;
        window.history.back();
      }
    };
  }, [open, layerName]);
}
