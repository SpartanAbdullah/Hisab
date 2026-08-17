import { describe, expect, it } from 'vitest';
import { bundleSplitEvents, splitEventTransactionIds } from './splitLedger';
import { buildInternalNote } from './internalNotes';
import type { Transaction } from '../db';

function txn(id: string, amount: number, splitEventId?: string, extra: Partial<Transaction> = {}): Transaction {
  return {
    id,
    type: 'expense',
    amount,
    currency: 'AED',
    sourceAccountId: 'acc',
    destinationAccountId: null,
    relatedPerson: null,
    relatedLoanId: null,
    relatedGoalId: null,
    conversionRate: null,
    category: 'Food',
    notes: splitEventId
      ? buildInternalNote('', { splitEventId, splitLabel: 'Friday lunch', splitPartyCount: '3' })
      : '',
    createdAt: '2026-08-17T10:00:00.000Z',
    ...extra,
  };
}

describe('bundleSplitEvents', () => {
  it('leaves ordinary rows alone', () => {
    const entries = bundleSplitEvents([txn('a', 10), txn('b', 20)]);
    expect(entries.map((e) => e.kind)).toEqual(['txn', 'txn']);
  });

  it('collapses one split event into a single entry carrying the full bill', () => {
    const entries = bundleSplitEvents([
      txn('l1', 400, 'evt'),
      txn('l2', 400, 'evt'),
      txn('mine', 400, 'evt'),
    ]);
    expect(entries).toHaveLength(1);
    const [entry] = entries;
    expect(entry.kind).toBe('split');
    if (entry.kind !== 'split') throw new Error('expected a split entry');
    expect(entry.total).toBe(1200);
    expect(entry.label).toBe('Friday lunch');
    expect(entry.partyCount).toBe(3);
    expect(entry.items.map((i) => i.id)).toEqual(['l1', 'l2', 'mine']);
  });

  it('keeps the bundle where its first row was', () => {
    const entries = bundleSplitEvents([
      txn('before', 5),
      txn('s1', 100, 'evt'),
      txn('between', 7),
      txn('s2', 100, 'evt'),
      txn('after', 9),
    ]);
    expect(entries.map((e) => e.key)).toEqual(['before', 'split:evt', 'between', 'after']);
  });

  it('never loses or duplicates a row', () => {
    const input = [
      txn('a', 1),
      txn('s1', 2, 'e1'),
      txn('s2', 3, 'e1'),
      txn('t1', 4, 'e2'),
      txn('t2', 5, 'e2'),
      txn('b', 6),
    ];
    const entries = bundleSplitEvents(input);
    const seen = entries.flatMap((e) => (e.kind === 'txn' ? [e.txn.id] : e.items.map((i) => i.id)));
    expect(seen.sort()).toEqual(input.map((t) => t.id).sort());
    expect(new Set(seen).size).toBe(input.length);
  });

  it('does not bundle a split event that only produced one row', () => {
    const entries = bundleSplitEvents([txn('solo', 400, 'evt'), txn('other', 5)]);
    expect(entries.map((e) => e.kind)).toEqual(['txn', 'txn']);
  });

  it('keeps two different split events apart', () => {
    const entries = bundleSplitEvents([
      txn('a1', 1, 'e1'), txn('a2', 1, 'e1'),
      txn('b1', 2, 'e2'), txn('b2', 2, 'e2'),
    ]);
    expect(entries).toHaveLength(2);
    expect(entries.map((e) => e.key)).toEqual(['split:e1', 'split:e2']);
  });
});

describe('splitEventTransactionIds', () => {
  it('finds every row of the event and nothing else', () => {
    const all = [txn('a', 1), txn('s1', 2, 'e1'), txn('s2', 3, 'e1'), txn('t1', 4, 'e2')];
    expect(splitEventTransactionIds(all, 'e1')).toEqual(['s1', 's2']);
  });

  it('returns empty for an unknown event', () => {
    expect(splitEventTransactionIds([txn('a', 1)], 'nope')).toEqual([]);
  });
});
