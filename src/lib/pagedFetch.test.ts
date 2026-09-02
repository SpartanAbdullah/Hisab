import { describe, expect, it } from 'vitest';
import { fetchAllPages } from './pagedFetch';

interface Row {
  id: string;
  createdAt: string;
  /** Present to prove splits_only rows (BOTH account ids null) survive paging. */
  sourceAccountId: string | null;
  destinationAccountId: string | null;
}

function makeRows(count: number, sameTimestampFor = 0): Row[] {
  // Descending created_at, like transactionsDb.getAll.
  return Array.from({ length: count }, (_, i) => ({
    id: `tx-${String(i).padStart(5, '0')}`,
    createdAt: i < sameTimestampFor
      ? '2026-09-02T00:00:00.000Z'
      : new Date(Date.parse('2026-09-02T00:00:00.000Z') - i * 1000).toISOString(),
    sourceAccountId: null,
    destinationAccountId: null,
  }));
}

/**
 * Stands in for PostgREST: descending order on createdAt with id as tiebreaker,
 * an INCLUSIVE `lte` cursor, and an optional server-side max-rows cap that
 * silently overrides the requested limit.
 */
function makeServer(rows: Row[], serverMaxRows = Infinity) {
  const sorted = [...rows].sort((a, b) =>
    a.createdAt === b.createdAt ? b.id.localeCompare(a.id) : b.createdAt.localeCompare(a.createdAt),
  );
  const calls: { cursor: string | null; limit: number }[] = [];
  const fetchPage = async (cursor: string | null, limit: number): Promise<Row[]> => {
    calls.push({ cursor, limit });
    const scoped = cursor ? sorted.filter((r) => r.createdAt <= cursor) : sorted;
    return scoped.slice(0, Math.min(limit, serverMaxRows));
  };
  return { fetchPage, calls };
}

const opts = (fetchPage: (c: string | null, l: number) => Promise<Row[]>, extra = {}) => ({
  label: 'test.rows',
  fetchPage,
  idOf: (r: Row) => r.id,
  cursorOf: (r: Row) => r.createdAt,
  pageSize: 500,
  ...extra,
});

describe('fetchAllPages', () => {
  it('single short page costs exactly one request', async () => {
    const { fetchPage, calls } = makeServer(makeRows(123));
    const result = await fetchAllPages(opts(fetchPage));
    expect(result.rows).toHaveLength(123);
    expect(result.pages).toBe(1);
    expect(result.truncated).toBe(false);
    expect(calls).toHaveLength(1);
  });

  it('empty table costs one request and is not truncated', async () => {
    const { fetchPage } = makeServer([]);
    const result = await fetchAllPages(opts(fetchPage));
    expect(result.rows).toEqual([]);
    expect(result.truncated).toBe(false);
  });

  it('pages past the old ~1000-row PostgREST wall without dropping history', async () => {
    const { fetchPage } = makeServer(makeRows(2600));
    const result = await fetchAllPages(opts(fetchPage));
    expect(result.rows).toHaveLength(2600);
    expect(result.truncated).toBe(false);
    // No duplicates despite the inclusive cursor overlap.
    expect(new Set(result.rows.map((r) => r.id)).size).toBe(2600);
    // Oldest row survived — the exact row class that used to vanish.
    expect(result.rows.at(-1)?.id).toBe('tx-02599');
  });

  it('keeps splits_only rows whose account ids are both null', async () => {
    const { fetchPage } = makeServer(makeRows(1200));
    const result = await fetchAllPages(opts(fetchPage));
    expect(result.rows).toHaveLength(1200);
    expect(result.rows.every((r) => r.sourceAccountId === null && r.destinationAccountId === null)).toBe(true);
  });

  it('detects and works around a server max-rows cap below the page size', async () => {
    const warnings: string[] = [];
    // Server refuses to return more than 200 rows per request.
    const { fetchPage } = makeServer(makeRows(900), 200);
    const result = await fetchAllPages(
      opts(fetchPage, { onWarn: (m: string) => warnings.push(m) }),
    );
    expect(result.rows).toHaveLength(900);
    expect(result.truncated).toBe(false);
    expect(warnings.some((w) => w.includes('max-rows is capping below the page size'))).toBe(true);
  });

  it('does not warn when a short page is genuinely the end of the table', async () => {
    const warnings: string[] = [];
    // 700 rows: page 1 is full (500), page 2 returns 201 (200 new + overlap).
    const { fetchPage } = makeServer(makeRows(700));
    const result = await fetchAllPages(
      opts(fetchPage, { onWarn: (m: string) => warnings.push(m) }),
    );
    expect(result.rows).toHaveLength(700);
    expect(warnings).toEqual([]);
  });

  it('flags truncation when a full page cannot advance the cursor', async () => {
    const warnings: string[] = [];
    // 900 rows all sharing one created_at: the cursor can never move past it.
    const { fetchPage } = makeServer(makeRows(900, 900));
    const result = await fetchAllPages(
      opts(fetchPage, { pageSize: 500, onWarn: (m: string) => warnings.push(m) }),
    );
    expect(result.truncated).toBe(true);
    expect(warnings.some((w) => w.includes('no new rows'))).toBe(true);
  });

  it('flags truncation at the maxRows ceiling instead of paging forever', async () => {
    const warnings: string[] = [];
    const { fetchPage } = makeServer(makeRows(4000));
    const result = await fetchAllPages(
      opts(fetchPage, { maxRows: 1500, onWarn: (m: string) => warnings.push(m) }),
    );
    expect(result.truncated).toBe(true);
    expect(result.rows.length).toBeGreaterThanOrEqual(1500);
    expect(warnings.some((w) => w.includes('ceiling'))).toBe(true);
  });

  it('flags truncation when the cursor column is missing on a full page', async () => {
    const warnings: string[] = [];
    const { fetchPage } = makeServer(makeRows(1200));
    const result = await fetchAllPages(
      opts(fetchPage, { cursorOf: () => null, onWarn: (m: string) => warnings.push(m) }),
    );
    expect(result.truncated).toBe(true);
    expect(result.rows).toHaveLength(500);
    expect(warnings.some((w) => w.includes('no cursor value'))).toBe(true);
  });

  it('propagates fetch errors rather than returning a partial set silently', async () => {
    await expect(
      fetchAllPages(opts(async () => { throw new Error('network down'); })),
    ).rejects.toThrow('network down');
  });
});

/**
 * emiSchedulesDb.getAll orders ASCENDING on installment_number, a column that
 * is deliberately NOT unique — every loan's schedule restarts at 1 — so many
 * rows across different loans legitimately share a cursor value. This is a
 * different shape than the transactions-style descending/mostly-unique
 * timestamp cursor covered above, and is the pattern
 * loansDb.getAll / groupExpensesDb.getAllVisible / groupSettlementsDb.getAllVisible /
 * groupEventsDb.getByGroup / linkedRequestsDb.getAll / settlementRequestsDb.getAll
 * were all built from.
 */
interface EmiRow {
  id: string;
  loanId: string;
  installmentNumber: number;
}

function makeEmiRows(loanCount: number, installmentsPerLoan: number): EmiRow[] {
  const rows: EmiRow[] = [];
  for (let loan = 0; loan < loanCount; loan++) {
    for (let inst = 1; inst <= installmentsPerLoan; inst++) {
      rows.push({
        id: `emi-${String(loan).padStart(3, '0')}-${String(inst).padStart(3, '0')}`,
        loanId: `loan-${loan}`,
        installmentNumber: inst,
      });
    }
  }
  return rows;
}

/** Ascending counterpart to makeServer: (installment_number, id) order, inclusive `gte` cursor. */
function makeAscendingServer(rows: EmiRow[]) {
  const sorted = [...rows].sort((a, b) =>
    a.installmentNumber === b.installmentNumber
      ? a.id.localeCompare(b.id)
      : a.installmentNumber - b.installmentNumber,
  );
  const fetchPage = async (cursor: string | null, limit: number): Promise<EmiRow[]> => {
    const scoped = cursor
      ? sorted.filter((r) => r.installmentNumber >= Number(cursor))
      : sorted;
    return scoped.slice(0, limit);
  };
  return fetchPage;
}

describe('fetchAllPages — ascending, non-unique cursor (emi-schedule shape)', () => {
  it('pages every installment across many loans sharing the same installment_number', async () => {
    // 40 loans x 30 installments = 1200 rows, well past a 500-row page, with
    // every installment_number value shared by all 40 loans.
    const fetchPage = makeAscendingServer(makeEmiRows(40, 30));
    const result = await fetchAllPages<EmiRow>({
      label: 'test.emiSchedules',
      pageSize: 500,
      idOf: (r) => r.id,
      cursorOf: (r) => String(r.installmentNumber),
      fetchPage,
    });
    expect(result.rows).toHaveLength(1200);
    expect(result.truncated).toBe(false);
    expect(new Set(result.rows.map((r) => r.id)).size).toBe(1200);
    // Every loan's final installment survived the paging.
    for (let loan = 0; loan < 40; loan++) {
      expect(result.rows.some((r) => r.id === `emi-${String(loan).padStart(3, '0')}-030`)).toBe(true);
    }
  });
});
