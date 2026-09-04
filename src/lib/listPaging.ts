// Pure paging arithmetic for the two long lists in the app: the transaction
// history and the notification inbox.
//
// WHY THIS EXISTS (founder request 2026-09-03)
// -------------------------------------------
// Both screens painted their whole loaded set on first render:
//
//   * TransactionsPage rendered every day group inside the 90-day recent
//     window, revealed 8 groups at a time by an IntersectionObserver that
//     fires ahead of the viewport — so a scroll walked the entire history
//     without ever asking. On a heavy month that is hundreds of rows mounted
//     before the user has decided they want them.
//   * The notification list fetched a flat `limit=100` and rendered all 100,
//     every boot, every realtime nudge.
//
// The fix is the same shape on both: show the newest N, and make "more" an
// explicit tap. What differs is WHERE the bound lives — the transactions list
// pages its RENDERING over rows the store already holds (the store's fetch was
// bounded separately in docs/performance.md §7.1 and feeds five other
// screens), while notifications page from the SERVER by keyset cursor, because
// that store feeds nothing that needs the tail.
//
// Everything here is pure so it can be unit-tested without a store, a DOM or a
// database — the repo's testing philosophy (vitest.config.ts header).

import { compareByCreatedAtDesc, mergeTransactionRows } from './historyWindow';

/**
 * One page. Fifteen, not ten or twenty, because it is what fills a phone
 * screen plus a little: the user sees a full list rather than a stub, and the
 * "Load more" button is reachable without a long scroll on the first page.
 */
export const DEFAULT_LIST_PAGE_SIZE = 15;

/** A row this module can order and page: newest-first by `(createdAt, id)`. */
export interface PageableRow {
  id: string;
  createdAt: string;
}

/**
 * Where the next server page starts.
 *
 * `createdAt` alone is not enough. Rows written by one statement — a server
 * sweep fanning several notifications to the same user — share an identical
 * `created_at`, so a strict `created_at < cursor` would silently drop the
 * siblings that fell on the far side of a page boundary, and an inclusive
 * `<=` would re-deliver them forever without advancing. `excludeIds` carries
 * the ids already held AT that exact instant so the query can be inclusive on
 * the timestamp and still guarantee forward progress.
 */
export interface KeysetCursor {
  createdAt: string;
  excludeIds: string[];
}

/**
 * The cursor for the page AFTER `rows`.
 *
 * Derived from the OLDEST row in the set — which is the last one once the set
 * is in the app's canonical `createdAt DESC, id DESC` order. Sorted here
 * rather than trusting the caller's order, because a merge can hand this
 * function a set that was assembled from two fetches.
 *
 * Returns null for an empty set: there is no next page to ask for.
 */
export function cursorAfter(rows: readonly PageableRow[]): KeysetCursor | null {
  if (rows.length === 0) return null;
  const ordered = [...rows].sort(compareByCreatedAtDesc);
  const oldest = ordered[ordered.length - 1];
  return {
    createdAt: oldest.createdAt,
    excludeIds: ordered.filter((r) => r.createdAt === oldest.createdAt).map((r) => r.id),
  };
}

/**
 * Merge a freshly fetched page into rows already held: keyed by id, incoming
 * wins a collision (it is fresher), nothing is ever dropped, result ordered
 * `createdAt DESC, id DESC`.
 *
 * Deliberately delegates to `historyWindow.mergeTransactionRows` instead of
 * re-implementing it. That function is already the audited merge rule for this
 * codebase (docs/performance.md §7.1.2: replacing rather than merging a
 * partial result is what deleted history from the screen in F-FE1) and it is
 * generic over `{ id, createdAt }`. This wrapper exists only so a notification
 * list can use it without importing a transactions-shaped module.
 */
export function mergeNewestFirst<T extends PageableRow>(existing: T[], incoming: T[]): T[] {
  return mergeTransactionRows(existing, incoming);
}

/**
 * Are there rows on the server we do not hold?
 *
 * `total` is the exact server-side count when we have one (PostgREST
 * `count: 'exact'` rides along with the first page for free). When we do not,
 * fall back to the only other honest signal: a page that came back FULL
 * probably has more behind it, a short page is the end of the table.
 *
 * Conservative in the direction that matters — it would rather leave a
 * "Load more" button on screen that finds nothing than hide the tail of a
 * user's history behind a button that vanished.
 */
export function hasMoreRows(input: {
  loaded: number;
  total: number | null;
  lastPageSize: number;
  pageSize: number;
}): boolean {
  if (input.total !== null) return input.loaded < input.total;
  return input.lastPageSize >= input.pageSize;
}

/**
 * How many pages to render after one more "Load more" tap.
 *
 * Grows only, and never past what the data can fill — tapping the button on
 * the last page is a no-op rather than an unbounded counter.
 */
export function nextPageCount(current: number, pageSize: number, totalEntries: number): number {
  const maxPages = pagesFor(totalEntries, pageSize);
  if (maxPages <= 0) return 1;
  return Math.min(Math.max(current, 1) + 1, maxPages);
}

/** Pages needed to show `totalEntries` at `pageSize` each. At least 1. */
export function pagesFor(totalEntries: number, pageSize: number): number {
  if (pageSize <= 0) return 1;
  return Math.max(1, Math.ceil(totalEntries / pageSize));
}

/**
 * The result of cutting a list of BLOCKS (day groups) at an ENTRY count.
 *
 * The transactions list is grouped by day, but the founder's ask — and the
 * honest unit for "showing 15 of 240" — is the entry, not the group. So the
 * cut happens mid-block when it has to, and the caller renders
 * `blocks.slice(0, blocks)` with the final one truncated to `lastBlockEntries`.
 */
export interface BlockSlice {
  /** Day groups that get at least one rendered entry. */
  blocks: number;
  /** Entries to render from block index `blocks - 1`. */
  lastBlockEntries: number;
  /** Entries actually rendered. The "N" of "Showing N of M". */
  rendered: number;
  /** Entries available across every block. The "M". */
  total: number;
  hasMore: boolean;
}

/**
 * Cut `blockSizes` at `limit` entries.
 *
 * A block whose day total is computed from all of its rows still shows that
 * FULL total in its header even when cut — the caller owns that, and it is the
 * right call: a day's arithmetic must not change because the user has not
 * pressed "Load more" yet. Only the number of visible lines changes.
 *
 * Empty blocks are counted as included-with-zero-entries so `blocks` stays a
 * valid index into the caller's array. (Day groups are never empty in
 * practice; this just keeps the function total.)
 */
export function sliceBlocks(blockSizes: readonly number[], limit: number): BlockSlice {
  const total = blockSizes.reduce((sum, n) => sum + Math.max(0, n), 0);
  if (limit <= 0) {
    return { blocks: 0, lastBlockEntries: 0, rendered: 0, total, hasMore: total > 0 };
  }
  let remaining = limit;
  let blocks = 0;
  let lastBlockEntries = 0;
  let rendered = 0;
  for (const rawSize of blockSizes) {
    if (remaining <= 0) break;
    const size = Math.max(0, rawSize);
    const take = Math.min(size, remaining);
    blocks += 1;
    lastBlockEntries = take;
    rendered += take;
    remaining -= take;
  }
  return { blocks, lastBlockEntries, rendered, total, hasMore: rendered < total };
}
