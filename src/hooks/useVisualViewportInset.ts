import { useEffect, useState } from 'react';
import { isNativeRuntime } from '../lib/runtime';
import { computeVisualViewportInset } from '../lib/visualViewportInset';

/**
 * Returns the height (px) of the on-screen keyboard currently covering the
 * bottom of the layout viewport, so a `position: fixed` footer/composer can
 * push itself up above it.
 *
 * Context (audit MF-02): Chrome/Android 108+ resizes only the *visual*
 * viewport when the keyboard opens, so `position: fixed` elements — anchored
 * to the *layout* viewport — stay put behind the keyboard. `index.html` now
 * sets `interactive-widget=resizes-content`, which fixes this for Chrome by
 * resizing the layout viewport itself; this hook is the fallback for iOS
 * Safari (standalone PWA included), which has no such meta option and never
 * resizes the layout viewport for the keyboard.
 *
 * Capacitor-native safe: on native the `@capacitor/keyboard` plugin already
 * resizes the WebView itself (`Keyboard: { resize: 'native' }` in
 * capacitor.config.ts), so applying an inset on top would double-compensate
 * — this always returns 0 there (isNativeRuntime() from src/lib/runtime.ts).
 *
 * SSR/Node-safe: returns 0 when `window` or `window.visualViewport` is
 * unavailable (no-op in the vitest/node test environment).
 */
export function useVisualViewportInset(): number {
  const [inset, setInset] = useState(0);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (isNativeRuntime()) return;
    const vv = window.visualViewport;
    if (!vv) return;

    let rafId: number | null = null;

    const measure = () => {
      rafId = null;
      setInset(computeVisualViewportInset(window.innerHeight, vv.height, vv.offsetTop));
    };

    // rAF-throttled: resize/scroll on visualViewport can fire many times per
    // keyboard animation frame.
    const onChange = () => {
      if (rafId !== null) return;
      rafId = window.requestAnimationFrame(measure);
    };

    vv.addEventListener('resize', onChange);
    vv.addEventListener('scroll', onChange);
    measure();

    return () => {
      vv.removeEventListener('resize', onChange);
      vv.removeEventListener('scroll', onChange);
      if (rafId !== null) window.cancelAnimationFrame(rafId);
    };
  }, []);

  return inset;
}
