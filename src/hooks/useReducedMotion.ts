import { useSyncExternalStore } from 'react';

// Single source of truth for "should this animate?".
//
// CSS handles most of the app's motion and gates itself with
// @media (prefers-reduced-motion: reduce). But JS-driven motion (count-ups,
// rAF loops, staged reveals) has to make the same decision, and it must make
// it the SAME way — an app that honours the setting in CSS and ignores it in
// JS is worse than one that ignores it everywhere, because the user thinks
// they've turned it off.
//
// useSyncExternalStore rather than useState+useEffect: the value is external
// browser state, it can change mid-session (the user flips it in system
// settings), and this shape gives a correct first render with no flash of
// animated content.

const QUERY = '(prefers-reduced-motion: reduce)';

function subscribe(onChange: () => void): () => void {
  if (typeof window === 'undefined' || !window.matchMedia) return () => {};
  const mq = window.matchMedia(QUERY);
  // addEventListener is unavailable on Safari < 14 and some older Android
  // WebViews, which are squarely in this app's support range.
  if (mq.addEventListener) {
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }
  mq.addListener(onChange);
  return () => mq.removeListener(onChange);
}

function getSnapshot(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return false;
  return window.matchMedia(QUERY).matches;
}

// Server/prerender: assume motion is fine. The client corrects on hydration,
// and guessing "reduced" would suppress the first (most valuable) animation
// for everyone.
function getServerSnapshot(): boolean {
  return false;
}

export function useReducedMotion(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
