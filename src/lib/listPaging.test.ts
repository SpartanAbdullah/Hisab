import { describe, it, expect } from 'vitest';
import {
  DEFAULT_LIST_PAGE_SIZE,
  cursorAfter,
  hasMoreRows,
  mergeNewestFirst,
  nextPageCount,
  pagesFor,
  sliceBlocks,
} from './listPaging';

const row = (id: string, createdAt: string) => ({ id, createdAt });

describe('sliceBlocks', () => {
  it('renders nothing for a zero limit but still reports the total', () => {
    const s = sliceBlocks([3, 4, 5], 0);
    expect(s).toEqual({ blocks: 0, lastBlockEntries: 0, rendered: 0, total: 12, hasMore: true });
  });

  it('cuts mid-block when the limit lands inside one', () => {
    // 4 + 4 = 8, so entry 15 sits 7 deep in the third block.
    const s = sliceBlocks([4, 4, 9, 2], 15);
    expect(s.blocks).toBe(3);
    expect(s.lastBlockEntries).toBe(7);
    expect(s.rendered).toBe(15);
    expect(s.total).toBe(19);
    expect(s.hasMore).toBe(true);
  });

  it('cuts cleanly on a block boundary', () => {
    const s = sliceBlocks([5, 5, 5], 10);
    expect(s.blocks).toBe(2);
    expect(s.lastBlockEntries).toBe(5);
    expect(s.rendered).toBe(10);
    expect(s.hasMore).toBe(true);
  });

  it('reports no more once every entry is rendered', () => {
    const s = sliceBlocks([2, 3], 15);
    expect(s.blocks).toBe(2);
    expect(s.lastBlockEntries).toBe(3);
    expect(s.rendered).toBe(5);
    expect(s.total).toBe(5);
    expect(s.hasMore).toBe(false);
  });

  it('handles an empty list', () => {
    expect(sliceBlocks([], 15)).toEqual({
      blocks: 0, lastBlockEntries: 0, rendered: 0, total: 0, hasMore: false,
    });
  });

  it('keeps `blocks` a valid index when a block is empty', () => {
    // An empty block consumes no budget but must still be counted, or the
    // caller's `slice(0, blocks)` would drop a later, non-empty block.
    const s = sliceBlocks([2, 0, 3], 15);
    expect(s.blocks).toBe(3);
    expect(s.lastBlockEntries).toBe(3);
    expect(s.rendered).toBe(5);
  });

  it('never renders more entries than exist even with a huge limit', () => {
    const s = sliceBlocks([1, 1], 10_000);
    expect(s.rendered).toBe(2);
    expect(s.hasMore).toBe(false);
  });
});

describe('nextPageCount / pagesFor', () => {
  it('grows by one page and stops at the last one', () => {
    // 40 entries at 15/page = 3 pages.
    expect(pagesFor(40, 15)).toBe(3);
    expect(nextPageCount(1, 15, 40)).toBe(2);
    expect(nextPageCount(2, 15, 40)).toBe(3);
    expect(nextPageCount(3, 15, 40)).toBe(3);
    expect(nextPageCount(99, 15, 40)).toBe(3);
  });

  it('never drops below one page', () => {
    expect(pagesFor(0, 15)).toBe(1);
    expect(nextPageCount(0, 15, 0)).toBe(1);
    expect(nextPageCount(1, 15, 3)).toBe(1);
  });

  it('is total for a nonsensical page size rather than dividing by zero', () => {
    expect(pagesFor(40, 0)).toBe(1);
    expect(nextPageCount(1, 0, 40)).toBe(1);
  });

  it('uses 15 as the shipped page size', () => {
    expect(DEFAULT_LIST_PAGE_SIZE).toBe(15);
  });
});

describe('cursorAfter', () => {
  it('is null for an empty set — there is no next page to ask for', () => {
    expect(cursorAfter([])).toBeNull();
  });

  it('points at the OLDEST row regardless of the order handed in', () => {
    const c = cursorAfter([
      row('b', '2026-09-01T10:00:00.000Z'),
      row('a', '2026-09-03T10:00:00.000Z'),
      row('c', '2026-09-02T10:00:00.000Z'),
    ]);
    expect(c?.createdAt).toBe('2026-09-01T10:00:00.000Z');
    expect(c?.excludeIds).toEqual(['b']);
  });

  it('carries every id sharing the boundary instant, so the next page can advance', () => {
    // Three rows written by one statement share a created_at. An inclusive
    // `<=` query would re-deliver all three forever; excluding them by id is
    // what makes the walk terminate.
    const c = cursorAfter([
      row('n1', '2026-09-03T10:00:00.000Z'),
      row('n2', '2026-09-01T09:00:00.000Z'),
      row('n3', '2026-09-01T09:00:00.000Z'),
      row('n4', '2026-09-01T09:00:00.000Z'),
    ]);
    expect(c?.createdAt).toBe('2026-09-01T09:00:00.000Z');
    // Sorted id DESC within the instant by the canonical comparator.
    expect([...(c?.excludeIds ?? [])].sort()).toEqual(['n2', 'n3', 'n4']);
  });

  it('does not carry ids from a different instant', () => {
    const c = cursorAfter([
      row('older', '2026-09-01T09:00:00.000Z'),
      row('newer', '2026-09-01T09:00:00.001Z'),
    ]);
    expect(c?.excludeIds).toEqual(['older']);
  });
});

describe('mergeNewestFirst', () => {
  it('orders createdAt DESC then id DESC and never drops a row', () => {
    const merged = mergeNewestFirst(
      [row('a', '2026-09-01T00:00:00.000Z')],
      [row('c', '2026-09-03T00:00:00.000Z'), row('b', '2026-09-02T00:00:00.000Z')],
    );
    expect(merged.map((r) => r.id)).toEqual(['c', 'b', 'a']);
  });

  it('lets the incoming row win an id collision', () => {
    interface ReadableRow { id: string; createdAt: string; readAt: string | null }
    const held: ReadableRow[] = [{ id: 'x', createdAt: '2026-09-01T00:00:00.000Z', readAt: null }];
    const incoming: ReadableRow[] = [
      { id: 'x', createdAt: '2026-09-01T00:00:00.000Z', readAt: '2026-09-02T00:00:00.000Z' },
    ];
    const merged = mergeNewestFirst(held, incoming);
    expect(merged).toHaveLength(1);
    expect(merged[0].readAt).toBe('2026-09-02T00:00:00.000Z');
  });

  it('keeps rows already held when the incoming page is empty', () => {
    const held = [row('a', '2026-09-01T00:00:00.000Z')];
    expect(mergeNewestFirst(held, [])).toBe(held);
  });
});

describe('hasMoreRows', () => {
  it('trusts an exact server count when there is one', () => {
    expect(hasMoreRows({ loaded: 15, total: 40, lastPageSize: 15, pageSize: 15 })).toBe(true);
    expect(hasMoreRows({ loaded: 40, total: 40, lastPageSize: 15, pageSize: 15 })).toBe(false);
    // A full page but nothing left behind it — the count wins over the shape.
    expect(hasMoreRows({ loaded: 15, total: 15, lastPageSize: 15, pageSize: 15 })).toBe(false);
  });

  it('falls back to the page shape when no count is available', () => {
    expect(hasMoreRows({ loaded: 15, total: null, lastPageSize: 15, pageSize: 15 })).toBe(true);
    expect(hasMoreRows({ loaded: 9, total: null, lastPageSize: 9, pageSize: 15 })).toBe(false);
    expect(hasMoreRows({ loaded: 0, total: null, lastPageSize: 0, pageSize: 15 })).toBe(false);
  });

  it('does not hide a tail when the store holds MORE than the page walk saw', () => {
    // The notification store merges every unread row in alongside the newest
    // page, so `loaded` can exceed one page while the table still has more.
    expect(hasMoreRows({ loaded: 22, total: 300, lastPageSize: 15, pageSize: 15 })).toBe(true);
  });
});
