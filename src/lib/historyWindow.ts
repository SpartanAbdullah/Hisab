// Pure window + coverage math for the transaction history load.
//
// Why this exists
// ---------------
// `transactionStore.loadTransactions()` used to ask Supabase for the user's
// ENTIRE transaction history on every boot, every money write and every
// realtime nudge. M2(d) windowed the *rendering* on TransactionsPage but left
// the fetch unbounded, because the same store feeds HomePage, LoansPage, the
// statement generators, the exports and the analytics fallback
// (docs/performance.md §7, "the transactions FETCH is still unbounded").
//
// The fix is not "fetch less and hope". It is: fetch a bounded window by
// default, and make the *guarantee* about what was fetched a first-class,
// inspectable value — so a screen that needs the whole history has to ask for
// it, and a screen that shows a partial view can say so honestly.
//
// This module is the pure half: window arithmetic, the coverage lattice, the
// merge rule. `mirrorCache.ts`/`supabaseDb.ts` own the I/O; the store owns the
// wiring. Nothing here touches Dexie, Supabase or the clock unless told to.

/**
 * The default window: the last 12 calendar months.
 *
 * Chosen (not tuned) because every recurring surface the store feeds is inside
 * it — the monthly-wrap gate reads the PREVIOUS calendar month, budgets read
 * the current one, the Hisaab-check ritual reads the last few weeks, the
 * TransactionsPage default view is 90 days, and Analytics' longest client-side
 * window (`monthlyTrend`) is 6 months. 12 months covers the widest of those
 * twice over and gives a year-on-year comparison room to grow into.
 */
export const HISTORY_WINDOW_MONTHS = 12;

/**
 * ...OR the newest 1000 rows, whichever reaches FURTHER BACK.
 *
 * The month window alone would be a regression for the app's most common user:
 * someone with a few hundred lifetime entries, whose whole history costs one
 * or two pages. For them the row floor walks the pager to the end of the table
 * and coverage comes back `complete: true` — same data as before this change,
 * same number of round-trips, and every "needs everything" consumer resolves
 * without a second fetch. It only bites for a genuinely heavy user, which is
 * exactly who the bound is for.
 *
 * 1000 = two `TRANSACTION_PAGE_SIZE` pages. Deliberately at the PostgREST
 * max-rows default, so a windowed load costs at most what one unbounded
 * `select('*')` used to *silently truncate to*.
 */
export const HISTORY_MIN_ROWS = 1000;

/**
 * What the store PROVES it holds.
 *
 * Read the two fields together — `since: null` is not "since the beginning of
 * time", it is "no floor established":
 *
 * | complete | since | meaning                                                  |
 * |----------|-------|----------------------------------------------------------|
 * | `true`   | any   | every non-deleted transaction the user owns is in the store |
 * | `false`  | `null`| **nothing is guaranteed** (initial state, cache-only load) |
 * | `false`  | ISO   | every row with `createdAt >= since` is in the store        |
 *
 * The store may (and usually does) hold rows OLDER than `since` — the Dexie
 * mirror keeps whatever it already had, and the row floor above over-fetches.
 * Those rows are real, they are shown, they are not lies. They are simply not
 * a promise: nothing asserts they are the COMPLETE set for their period. A
 * consumer that would compute a wrong number from a partial set must call
 * `ensureTransactionHistory` and wait, not eyeball `transactions.length`.
 */
export interface HistoryCoverage {
  /** Complete from this instant onward. `null` + `!complete` = nothing proven. */
  since: string | null;
  /** The whole history is held. `since` is then irrelevant. */
  complete: boolean;
}

/** What a consumer asks for. `all` wins over `since` when both are set. */
export interface HistoryRequest {
  all?: boolean;
  since?: string | null;
}

export function emptyCoverage(): HistoryCoverage {
  return { since: null, complete: false };
}

export function fullCoverage(): HistoryCoverage {
  return { since: null, complete: true };
}

/**
 * Timestamp compare that does not assume a canonical ISO shape.
 *
 * Every `createdAt` this app writes is `new Date().toISOString()`, so plain
 * string compare would work — but a hand-set date that ever arrives with an
 * offset (`+04:00`) instead of `Z` would sort wrong, and sorting wrong here
 * means claiming coverage we do not have. Parse first, fall back to string
 * order only for values `Date` cannot read.
 */
export function isoLte(a: string, b: string): boolean {
  const ta = Date.parse(a);
  const tb = Date.parse(b);
  if (Number.isFinite(ta) && Number.isFinite(tb)) return ta <= tb;
  return a <= b;
}

/** The earlier of two instants; `null` is treated as "no value", not "-∞". */
export function earliestIso(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  return isoLte(a, b) ? a : b;
}

/** Start of the default window: `now` minus `months` calendar months, as ISO. */
export function historyWindowStart(
  now: number | Date = Date.now(),
  months: number = HISTORY_WINDOW_MONTHS,
): string {
  const at = new Date(typeof now === 'number' ? now : now.getTime());
  const shifted = new Date(at.getTime());
  shifted.setUTCMonth(shifted.getUTCMonth() - months);
  return shifted.toISOString();
}

/**
 * Does what we hold already answer this request?
 *
 * Conservative by construction: an unknown floor (`since: null`, not complete)
 * satisfies nothing, and a bare `{}` request means "all" — a caller that does
 * not say what it needs is assumed to need everything.
 */
export function coverageSatisfies(coverage: HistoryCoverage, request: HistoryRequest = {}): boolean {
  if (coverage.complete) return true;
  if (request.all) return false;
  const wanted = request.since ?? null;
  if (!wanted) return false;
  if (!coverage.since) return false;
  return isoLte(coverage.since, wanted);
}

/**
 * Union of two coverages.
 *
 * `[t1, ∞) ∪ [t2, ∞) = [min(t1,t2), ∞)` — contiguous half-open ranges, so the
 * union is just the earlier floor. Coverage therefore only ever WIDENS within
 * a session; `ensureTransactionHistory` can never make the store claim less
 * than it did a moment ago.
 */
export function mergeCoverage(a: HistoryCoverage, b: HistoryCoverage): HistoryCoverage {
  if (a.complete || b.complete) return fullCoverage();
  return { since: earliestIso(a.since, b.since), complete: false };
}

/** The fetch `loadTransactions` should issue. */
export interface HistoryLoadPlan {
  /** Walk the whole table (coverage was already complete — never shrink it). */
  all: boolean;
  /** Fetch every row at/after this instant. Meaningless when `all` is true. */
  since: string;
}

/**
 * Plan a (re)load.
 *
 * The floor is the EARLIEST of the default window, whatever coverage we have
 * already established, and whatever the caller explicitly asked for. That is
 * what makes a refresh non-destructive: a user who tapped "Show full history"
 * and then saved an expense does not get quietly demoted to 12 months on the
 * reload that follows the write.
 */
export function planHistoryLoad(input: {
  coverage: HistoryCoverage;
  requestedSince?: string | null;
  now?: number | Date;
  months?: number;
}): HistoryLoadPlan {
  if (input.coverage.complete) return { all: true, since: '' };
  const windowStart = historyWindowStart(input.now ?? Date.now(), input.months ?? HISTORY_WINDOW_MONTHS);
  const floor =
    earliestIso(earliestIso(windowStart, input.coverage.since), input.requestedSince ?? null) ?? windowStart;
  return { all: false, since: floor };
}

/** The half-open gap a `{ since }` request still has to fetch. */
export interface HistoryGap {
  from: string;
  /** Inclusive upper bound — the current floor. `null` = fetch to the present. */
  to: string | null;
}

export function historyGap(coverage: HistoryCoverage, since: string): HistoryGap {
  // Only the part BELOW the established floor is missing; the inclusive upper
  // bound re-fetches rows sharing that exact instant, which the id-dedupe in
  // `fetchAllPages` and `mergeTransactionRows` absorbs for free.
  return { from: since, to: coverage.since ?? null };
}

interface HistoryRow {
  id: string;
  createdAt: string;
}

/**
 * Merge fetched rows into the rows we hold. NEVER drops a row that is not
 * being replaced by its own id.
 *
 * This is the counterpart of the mirror's merge rule: a windowed or gap fetch
 * is a PARTIAL set by construction, so `set({ transactions: fetched })` would
 * delete history from the screen exactly the way the mirror's `clear()` used
 * to delete it from Dexie (audit 04-supabase F-FE1). Incoming wins on an id
 * collision (it is fresher); order is `createdAt DESC, id DESC`, matching the
 * DAL's keyset order so the list never re-shuffles under the user.
 */
export function mergeTransactionRows<T extends HistoryRow>(existing: T[], incoming: T[]): T[] {
  if (incoming.length === 0) return existing;
  const byId = new Map<string, T>();
  for (const row of existing) byId.set(row.id, row);
  for (const row of incoming) byId.set(row.id, row);
  return [...byId.values()].sort(compareByCreatedAtDesc);
}

export function compareByCreatedAtDesc(a: HistoryRow, b: HistoryRow): number {
  if (a.createdAt !== b.createdAt) return b.createdAt.localeCompare(a.createdAt);
  return b.id.localeCompare(a.id);
}

/** Oldest `createdAt` in a set, or null for an empty set. */
export function oldestCreatedAt(rows: readonly { createdAt: string }[]): string | null {
  let oldest: string | null = null;
  for (const row of rows) {
    if (!row.createdAt) continue;
    if (oldest === null || isoLte(row.createdAt, oldest)) oldest = row.createdAt;
  }
  return oldest;
}

/**
 * Should the windowed pager stop here?
 *
 * Both conditions must hold: we are past the date floor AND we have at least
 * the row floor. Either one alone would break one of the two user shapes the
 * window is sized for (the sparse user who wants their whole history, and the
 * heavy user who must not download five years of it).
 */
export function shouldStopWindowPaging(input: {
  oldestFetched: string | null;
  rowsFetched: number;
  since: string;
  minRows: number;
}): boolean {
  if (!input.oldestFetched) return false;
  if (input.rowsFetched < input.minRows) return false;
  return !isoLte(input.since, input.oldestFetched);
}
