import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';

// ═══════════════════════════════════════════════════════════════════════════
// Windowed rendering for long lists — audit P2 M2 / 03-performance H3
// ═══════════════════════════════════════════════════════════════════════════
//
// TransactionsPage rendered EVERY transaction in the user's history, every
// render: one <TransactionItem> per row, all of them mounted, laid out and
// painted. A year of daily spending is a few thousand DOM subtrees on a low-end
// Android (07-mobile-first MF-14).
//
// This module is a HOOK plus a style helper — no component, on purpose: the
// consumer already has the markup, and a wrapper component here would only add
// a DOM node between the stagger container and its children.
//
// WHY NOT A VIRTUAL-LIST LIBRARY, and why not classic virtualization:
//
//   1. NO NEW DEPENDENCY. The entry bundle is the thing M2 has spent three
//      passes shrinking; adding react-window to fix a render cost would give
//      some of it back.
//   2. UNMOUNTING ROWS FIGHTS SCROLL RESTORATION. src/App.tsx (H7 / MF-18)
//      restores `window.scrollY` on every POP navigation, immediately after the
//      route commits. Classic virtualization makes document height a function
//      of what is currently mounted, so on the frame the restore runs the page
//      is short and the browser clamps the offset — you land at the wrong
//      place, or at the bottom. So this window only ever GROWS, never shrinks,
//      and it REMEMBERS how far it had grown (`blockMemory` below) so a POP
//      back onto the page re-renders the same height it left with.
//   3. ROWS ARE NOT FIXED-HEIGHT. The list is day-grouped: a group is a header
//      plus 1..n rows, and an ad-hoc split row expands in place. Any fixed
//      row-height math would be wrong the moment a split is expanded.
//
// So: progressive reveal by BLOCK (a day group), driven by an
// IntersectionObserver sentinel, plus `content-visibility: auto` on each
// rendered block so blocks that are mounted but off-screen cost no layout and
// no paint. Together, the browser does work proportional to what the user has
// actually scrolled past, while the DOM the user has already seen stays put.
//
// HONEST LIMITS
//   * Browser find-in-page (Ctrl+F) cannot find a block that has not been
//     revealed yet. `content-visibility: auto` content IS searchable (browsers
//     expand it for find-in-page); un-revealed blocks are not in the DOM at
//     all. The page's own search box searches the FULL filtered set, which is
//     the search that matters on this screen.
//   * No IntersectionObserver (very old WebView, jsdom) ⇒ everything renders,
//     exactly as before. Degrades to the old behaviour, never to a broken one.

export const DEFAULT_INITIAL_BLOCKS = 8;
export const DEFAULT_BLOCK_STEP = 8;

/** How many blocks to show after one more sentinel hit. Pure; unit-tested. */
export function nextBlockCount(current: number, total: number, step: number): number {
  if (step <= 0) return clampBlockCount(current, total);
  return clampBlockCount(current + step, total);
}

/** Never below 1 (an empty window would never intersect anything), never above `total`. */
export function clampBlockCount(count: number, total: number): number {
  if (total <= 0) return 0;
  return Math.max(1, Math.min(count, total));
}

/**
 * A rough px height for a not-yet-laid-out day group, used only as
 * `contain-intrinsic-size`. Wrong by a little is fine — it keeps the scrollbar
 * approximately right before a block is first painted; the real height replaces
 * it the moment the block enters the viewport.
 */
export function estimateGroupHeight(rowCount: number): number {
  const HEADER = 28;
  const ROW = 64;
  return HEADER + Math.max(1, rowCount) * ROW;
}

/**
 * Style for one rendered block: let the browser skip layout and paint entirely
 * while the block is off-screen, and keep the scrollbar honest meanwhile.
 *
 * Both properties are progressive enhancement — a browser that does not know
 * them (older iOS Safari) simply renders the block normally.
 */
export function deferredBlockStyle(estimatedHeight: number): CSSProperties {
  return {
    contentVisibility: 'auto',
    containIntrinsicSize: `auto ${estimatedHeight}px`,
  };
}

// How far each list has been revealed, kept across unmounts for the lifetime of
// the session (a module variable, deliberately not state: it must survive the
// component). This is what makes POP scroll restoration land correctly — see
// note 2 above.
const blockMemory = new Map<string, number>();

/** Forget a list's revealed depth — for when its identity changes, not its contents. */
export function resetBlockMemory(key: string): void {
  blockMemory.delete(key);
}

export interface ProgressiveBlocksOptions {
  /** Blocks rendered before the user scrolls. Default 8. */
  initial?: number;
  /** Blocks added per sentinel hit. Default 8. */
  step?: number;
  /** Remember the revealed depth under this key across unmounts (POP restore). */
  memoryKey?: string;
  /** Distance ahead of the viewport at which the next batch is prepared. */
  rootMargin?: string;
}

export interface ProgressiveBlocks {
  /** How many blocks to render right now. */
  visible: number;
  /** True while blocks remain unrevealed — render the sentinel only then. */
  hasMore: boolean;
  /** Attach to an element placed AFTER the last rendered block. */
  sentinelRef: (node: HTMLElement | null) => void;
  /** Reveal everything at once (the "show all" escape hatch). */
  revealAll: () => void;
}

export function useProgressiveBlocks(
  total: number,
  options: ProgressiveBlocksOptions = {},
): ProgressiveBlocks {
  const {
    initial = DEFAULT_INITIAL_BLOCKS,
    step = DEFAULT_BLOCK_STEP,
    memoryKey,
    rootMargin = '800px 0px',
  } = options;

  const supported = typeof IntersectionObserver !== 'undefined';
  const [visible, setVisible] = useState(() =>
    Math.max(initial, memoryKey ? blockMemory.get(memoryKey) ?? 0 : 0),
  );

  // The observer callback fires long after render, so it must not close over a
  // stale `total` — a filter change can shrink the list under it.
  const totalRef = useRef(total);
  useEffect(() => {
    totalRef.current = total;
  }, [total]);

  const observerRef = useRef<IntersectionObserver | null>(null);
  const sentinelRef = useCallback(
    (node: HTMLElement | null) => {
      observerRef.current?.disconnect();
      observerRef.current = null;
      if (!node || typeof IntersectionObserver === 'undefined') return;
      const observer = new IntersectionObserver(
        (entries) => {
          if (!entries.some((entry) => entry.isIntersecting)) return;
          setVisible((current) => nextBlockCount(current, totalRef.current, step));
        },
        { rootMargin },
      );
      observer.observe(node);
      observerRef.current = observer;
    },
    [step, rootMargin],
  );

  useEffect(() => () => observerRef.current?.disconnect(), []);

  const effective = supported ? clampBlockCount(visible, total) : total;

  useEffect(() => {
    if (memoryKey) blockMemory.set(memoryKey, effective);
  }, [memoryKey, effective]);

  const revealAll = useCallback(() => setVisible(totalRef.current), []);

  return {
    visible: effective,
    hasMore: supported && effective < total,
    sentinelRef,
    revealAll,
  };
}
