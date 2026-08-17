import { useEffect, useRef, useState } from 'react';
import { useReducedMotion } from './useReducedMotion';

// Animate a number toward a target over time.
//
// This exists for one screen above all: the net-worth figure on Home. In a
// money app that number IS the product, and having it blink into existence
// wastes the only moment where motion carries real meaning — watching your
// balance resolve reads as the app counting it up for you.
//
// Two rules that keep it honest rather than decorative:
//
//   • It NEVER animates a number the user is reading. A re-animation on every
//     background refresh would make the balance permanently untrustworthy
//     ("is it still counting? is that the final figure?"). Only a genuine
//     change in value re-runs it.
//   • The final frame is always assigned exactly, never interpolated. Easing
//     that lands on 4823.9997 would render as a different balance than the
//     one in the database.
//
// IMPORTANT — call this from a LEAF component. It sets state every frame; if
// it lives in a page component the whole page re-renders ~50 times per run.
// AnimatedMoney exists precisely to give it a leaf to live in.

// Expo-out — the design system's ELEVATED curve. Fast start, long settle:
// the number is legible almost immediately and the tail reads as "settling"
// rather than "still loading".
function easeOutExpo(t: number): number {
  return t === 1 ? 1 : 1 - Math.pow(2, -10 * t);
}

interface Options {
  /** Milliseconds for a full run. */
  duration?: number;
  /** Skip the animation entirely (e.g. still loading real data). */
  enabled?: boolean;
}

export function useCountUp(target: number, { duration = 850, enabled = true }: Options = {}): number {
  const reduced = useReducedMotion();
  const safeTarget = Number.isFinite(target) ? target : 0;

  const [display, setDisplay] = useState(safeTarget);
  // What we last animated TO. Distinct from `display`, which is mid-flight
  // for most of a run.
  const targetRef = useRef(safeTarget);
  const frameRef = useRef<number | null>(null);
  // First run should count up from zero (a reveal). Later runs travel from
  // wherever the number currently is (a change), so the eye can follow it.
  const hasRunRef = useRef(false);

  useEffect(() => {
    if (!enabled || reduced) {
      targetRef.current = safeTarget;
      hasRunRef.current = true;
      // rAF-wrapped so this is a scheduled update, not a synchronous
      // set-during-effect cascade.
      const id = requestAnimationFrame(() => setDisplay(safeTarget));
      return () => cancelAnimationFrame(id);
    }

    // Same value we already landed on — nothing happened, stay still.
    if (hasRunRef.current && Math.abs(targetRef.current - safeTarget) < 0.005) {
      return;
    }

    const from = hasRunRef.current ? targetRef.current : 0;
    const to = safeTarget;
    targetRef.current = to;
    hasRunRef.current = true;

    // A change too small to see isn't worth a run — it would just make the
    // figure twitch on every sync.
    if (Math.abs(to - from) < 0.005) {
      const id = requestAnimationFrame(() => setDisplay(to));
      return () => cancelAnimationFrame(id);
    }

    const start = performance.now();
    const step = (now: number) => {
      const elapsed = now - start;
      if (elapsed >= duration) {
        // Exact assignment, not eased interpolation. See note above.
        setDisplay(to);
        frameRef.current = null;
        return;
      }
      setDisplay(from + (to - from) * easeOutExpo(elapsed / duration));
      frameRef.current = requestAnimationFrame(step);
    };
    frameRef.current = requestAnimationFrame(step);

    return () => {
      if (frameRef.current !== null) {
        cancelAnimationFrame(frameRef.current);
        frameRef.current = null;
      }
    };
  }, [safeTarget, duration, enabled, reduced]);

  return display;
}
