// Keyset pagination for PostgREST collection reads.
//
// Why: every collection read in `supabaseDb.ts` was an unbounded `select('*')`.
// PostgREST applies a server-side max-rows cap (hosted default 1000) and returns
// the truncated result WITHOUT an error. Transactions are ordered
// `created_at DESC`, so past ~1000 rows only the newest survived — and the
// mirror's daily full refresh then did `table.clear() + bulkPut(truncated set)`,
// physically deleting the older half of the user's history from Dexie. Silent,
// and it looks permanent to the user (audit 04-supabase F-FE1, 03-performance H3).
//
// Contract
// --------
// `fetchPage(cursor, limit)` must:
//   1. apply a STABLE total order on one column (`created_at DESC`,
//      `updated_at ASC`, …) plus `id` as a tiebreaker;
//   2. when `cursor` is non-null, apply an INCLUSIVE bound on that same column
//      (`.lte(col, cursor)` for descending, `.gte(col, cursor)` for ascending);
//   3. apply `.limit(limit)`.
//
// Inclusive (not exclusive) is deliberate: rows sharing a timestamp can straddle
// a page boundary, and an exclusive bound would drop the ones after the cut.
// The helper de-duplicates by id, so the overlap costs nothing but is safe.
//
// `cursorOf(row)` must return the value of that ordered column for a row.
// `idOf(row)` must return a stable unique id.
//
// The helper never inspects row shape beyond `idOf`/`cursorOf`, so rows with
// null fields (e.g. splits_only transactions where BOTH account ids are null)
// pass through untouched.
//
// Termination: stop on an empty page, on a page that adds no new rows, or on a
// short page that doesn't look like a server cap. `truncated: true` means the
// result is NOT the complete set — callers must never clear a mirror from it.
import { reportMessage } from './errorReporter';

export const DEFAULT_PAGE_SIZE = 500;
/** Hard stop so a pathological loop can't page forever on a metered connection. */
export const DEFAULT_MAX_ROWS = 50_000;

export interface PagedFetchResult<T> {
  rows: T[];
  /** Number of network round-trips made. */
  pages: number;
  /**
   * true = the server did not give us everything. The caller holds a PARTIAL
   * set and must merge rather than replace any local copy.
   */
  truncated: boolean;
}

export interface PagedFetchOptions<T> {
  /** Grouping tag for truncation warnings, e.g. "transactions.getAll". */
  label: string;
  fetchPage: (cursor: string | null, limit: number) => Promise<T[]>;
  idOf: (row: T) => string;
  cursorOf: (row: T) => string | null;
  pageSize?: number;
  maxRows?: number;
  /** Injectable for tests. Defaults to the app's error reporter. */
  onWarn?: (message: string, extra: Record<string, unknown>) => void;
}

function defaultWarn(message: string, extra: Record<string, unknown>): void {
  reportMessage(message, { feature: 'pagedFetch', extra });
}

/**
 * A short page whose length is a round hundred is more likely a server-side
 * max-rows cap than a real end-of-table. We probe one more page before
 * believing it; the probe is only paid in that rare case.
 */
function looksLikeServerCap(pageLength: number, pageSize: number): boolean {
  return pageLength > 0 && pageLength < pageSize && pageLength % 100 === 0;
}

export async function fetchAllPages<T>(options: PagedFetchOptions<T>): Promise<PagedFetchResult<T>> {
  const pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE;
  const maxRows = options.maxRows ?? DEFAULT_MAX_ROWS;
  const warn = options.onWarn ?? defaultWarn;

  const rows: T[] = [];
  const seen = new Set<string>();
  let cursor: string | null = null;
  let pages = 0;
  // Set when a short page looked like a server cap; confirmed (and reported)
  // only if the probe page actually yields more rows.
  let suspectedCap: number | null = null;

  for (;;) {
    const page = await options.fetchPage(cursor, pageSize);
    pages += 1;

    let added = 0;
    for (const row of page) {
      const id = options.idOf(row);
      if (seen.has(id)) continue;
      seen.add(id);
      rows.push(row);
      added += 1;
    }

    if (suspectedCap !== null && added > 0) {
      warn(
        `[pagedFetch] ${options.label}: server returned ${suspectedCap} rows for a ${pageSize}-row page request — PostgREST max-rows is capping below the page size`,
        { label: options.label, serverPageLength: suspectedCap, requestedPageSize: pageSize },
      );
      suspectedCap = null;
    }

    if (page.length === 0) return { rows, pages, truncated: false };

    // A FULL page of rows we already have means the cursor cannot advance: more
    // rows share this timestamp than fit in one page. This is the "page came
    // back exactly at the limit unexpectedly" case — we stop, and say so.
    if (page.length >= pageSize && added === 0) {
      warn(
        `[pagedFetch] ${options.label}: a full ${pageSize}-row page contained no new rows — cursor cannot advance, result is incomplete`,
        { label: options.label, cursor, rowsSoFar: rows.length },
      );
      return { rows, pages, truncated: true };
    }

    // Short page that only re-delivered the overlap: end of the table.
    if (added === 0) return { rows, pages, truncated: false };

    if (rows.length >= maxRows) {
      warn(
        `[pagedFetch] ${options.label}: hit the ${maxRows}-row ceiling — result is incomplete`,
        { label: options.label, rowsSoFar: rows.length },
      );
      return { rows, pages, truncated: true };
    }

    const nextCursor = options.cursorOf(page[page.length - 1]);
    if (!nextCursor) {
      warn(
        `[pagedFetch] ${options.label}: last row of a full page has no cursor value — cannot page further`,
        { label: options.label, rowsSoFar: rows.length },
      );
      return { rows, pages, truncated: true };
    }

    if (page.length < pageSize) {
      if (!looksLikeServerCap(page.length, pageSize)) {
        return { rows, pages, truncated: false };
      }
      suspectedCap = page.length;
    }

    cursor = nextCursor;
  }
}
