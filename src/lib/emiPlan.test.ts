// planEmiRows — the instalment plan extracted out of emiStore.generateSchedule
// so the atomic loan-create path can send it as `p_emi` (L4 step 3).
//
// The load-bearing assertion in this file is PARITY: `legacyGenerateSchedule`
// below is a verbatim copy of the arithmetic emiStore.generateSchedule ran
// before the extraction (emiStore.ts:63-84 at commit 2248327), and every
// fixture is asserted against both. If the two ever disagree, this file fails
// rather than a user's schedule.

import { describe, expect, it } from 'vitest';
import { addMonths, format } from 'date-fns';
import { planEmiRows, type EmiPlanRow } from './emiPlan';
import { emiPlanProblem, toEmiPayload } from './loanCreateAtomicPlan';
import { statementInstalmentDates } from './cardStatement';

// ── The pre-extraction implementation, verbatim ──────────────────────────────
// Ids are the only thing that cannot be compared (uuid), so this copy takes the
// same injectable factory the new one does; everything else — the rounding, the
// tail absorption, the date walk, the dueDates precedence — is byte-for-byte
// what shipped.
function legacyGenerateSchedule(input: {
  totalAmount: number;
  installments: number;
  startDate: string;
  dueDates?: string[];
  makeId: (i: number) => string;
}): EmiPlanRow[] {
  const emiAmount = Math.round((input.totalAmount / input.installments) * 100) / 100;
  const entries: EmiPlanRow[] = [];
  const startDate = new Date(input.startDate);
  const dueDateFor = (i: number): string =>
    input.dueDates && input.dueDates[i]
      ? input.dueDates[i]
      : format(addMonths(startDate, i), 'yyyy-MM-dd');

  for (let i = 0; i < input.installments; i++) {
    entries.push({
      id: input.makeId(i),
      installmentNumber: i + 1,
      dueDate: dueDateFor(i),
      amount: i === input.installments - 1
        ? Math.round((input.totalAmount - emiAmount * (input.installments - 1)) * 100) / 100
        : emiAmount,
    });
  }
  return entries;
}

const seq = (i: number) => `e${i + 1}`;

// The three fixtures the task pins: an evenly divisible human loan, one with a
// rounding tail, and a statement-day-anchored cash advance.
const FIXTURES: Array<{ name: string; input: Parameters<typeof legacyGenerateSchedule>[0] }> = [
  {
    name: 'evenly divisible, monthly from the typed start date',
    input: { totalAmount: 1200, installments: 4, startDate: '2026-10-01', makeId: seq },
  },
  {
    name: 'rounding tail — the last instalment absorbs it',
    input: { totalAmount: 1000, installments: 3, startDate: '2026-10-15', makeId: seq },
  },
  {
    name: 'statement-day anchored cash advance (dueDates win over startDate)',
    input: {
      totalAmount: 1500,
      installments: 3,
      startDate: '2026-07-24',
      dueDates: statementInstalmentDates(26, 3, '2026-07-24'),
      makeId: seq,
    },
  },
];

describe('planEmiRows — parity with the pre-extraction generateSchedule', () => {
  for (const fixture of FIXTURES) {
    it(fixture.name, () => {
      expect(planEmiRows(fixture.input)).toEqual(legacyGenerateSchedule(fixture.input));
    });
  }
});

describe('planEmiRows — the arithmetic itself', () => {
  it('splits an evenly divisible loan into equal instalments, numbered 1..N', () => {
    const rows = planEmiRows({ totalAmount: 1200, installments: 4, startDate: '2026-10-01', makeId: seq });
    expect(rows).toEqual([
      { id: 'e1', installmentNumber: 1, dueDate: '2026-10-01', amount: 300 },
      { id: 'e2', installmentNumber: 2, dueDate: '2026-11-01', amount: 300 },
      { id: 'e3', installmentNumber: 3, dueDate: '2026-12-01', amount: 300 },
      { id: 'e4', installmentNumber: 4, dueDate: '2027-01-01', amount: 300 },
    ]);
  });

  it('gives the rounding tail to the LAST instalment so the plan sums to the loan', () => {
    const rows = planEmiRows({ totalAmount: 1000, installments: 3, startDate: '2026-10-15', makeId: seq });
    expect(rows.map((r) => r.amount)).toEqual([333.33, 333.33, 333.34]);
    // Exactly the shape the server accepts (7x-atomic-loan-create.sql, "the 2dp
    // rounding tail of an unevenly divisible loan is accepted").
    expect(Math.round(rows.reduce((t, r) => t + r.amount, 0) * 100) / 100).toBe(1000);
  });

  it('anchors a cash advance to the card statement day, ignoring the start date', () => {
    const dueDates = statementInstalmentDates(26, 3, '2026-07-24');
    const rows = planEmiRows({
      totalAmount: 1500, installments: 3, startDate: '2026-01-01', dueDates, makeId: seq,
    });
    expect(rows.map((r) => r.dueDate)).toEqual(['2026-07-26', '2026-08-26', '2026-09-26']);
  });

  it('falls back to the monthly walk for any instalment dueDates does not cover', () => {
    // A short dueDates array must not produce empty due dates — the server
    // refuses those with EMI_PLAN_INVALID.
    const rows = planEmiRows({
      totalAmount: 300, installments: 3, startDate: '2026-03-31',
      dueDates: ['2026-04-26'], makeId: seq,
    });
    expect(rows.map((r) => r.dueDate)).toEqual(['2026-04-26', '2026-04-30', '2026-05-31']);
  });

  it('plans nothing for a non-positive or unparseable instalment count', () => {
    expect(planEmiRows({ totalAmount: 500, installments: 0, startDate: '2026-10-01' })).toEqual([]);
    expect(planEmiRows({ totalAmount: 500, installments: -3, startDate: '2026-10-01' })).toEqual([]);
    expect(planEmiRows({ totalAmount: 500, installments: NaN, startDate: '2026-10-01' })).toEqual([]);
  });

  it('mints a distinct id per instalment when no factory is injected', () => {
    const rows = planEmiRows({ totalAmount: 900, installments: 3, startDate: '2026-10-01' });
    expect(new Set(rows.map((r) => r.id)).size).toBe(3);
    expect(rows.every((r) => r.id.length > 0)).toBe(true);
  });
});

describe('planEmiRows feeds the RPC payload unchanged', () => {
  it('every fixture passes the client half of the server validation', () => {
    for (const fixture of FIXTURES) {
      const rows = planEmiRows(fixture.input);
      expect(emiPlanProblem(rows, fixture.input.totalAmount)).toBeNull();
    }
  });

  it('converts to the exact snake_case p_emi shape the migration binds', () => {
    // Matches supabase/tests/tests/7x-atomic-loan-create.sql §7 field for field:
    // {"id", "installment_number", "due_date", "amount"} and nothing else.
    const rows = planEmiRows({ totalAmount: 1200, installments: 4, startDate: '2026-10-01', makeId: seq });
    expect(toEmiPayload(rows)).toEqual([
      { id: 'e1', installment_number: 1, due_date: '2026-10-01', amount: 300 },
      { id: 'e2', installment_number: 2, due_date: '2026-11-01', amount: 300 },
      { id: 'e3', installment_number: 3, due_date: '2026-12-01', amount: 300 },
      { id: 'e4', installment_number: 4, due_date: '2027-01-01', amount: 300 },
    ]);
  });

  it('an empty plan converts to null, never to an empty array', () => {
    // `p_emi: []` and `p_emi: null` are the same to the server, but null is what
    // "no plan" has always meant on the wire — keep the two unambiguous.
    expect(toEmiPayload(planEmiRows({ totalAmount: 500, installments: 0, startDate: '2026-10-01' }))).toBeNull();
  });
});
