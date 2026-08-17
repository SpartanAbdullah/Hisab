// Collapse the several rows an ad-hoc split produces back into the ONE thing
// the user actually did. "Friday lunch, 1200, split 3 ways" is a single event
// in their head; showing it as an expense plus two unrelated loan rows is
// technically honest and practically unreadable.
//
// Pure list-shaping so it can be tested: every input row must come out exactly
// once, and the original ordering must survive (each bundle sits where its
// FIRST row was).

import { parseInternalNote } from './internalNotes';
import type { Currency, Transaction } from '../db';

export type LedgerEntry =
  | { kind: 'txn'; key: string; txn: Transaction }
  | {
      kind: 'split';
      key: string;
      splitEventId: string;
      label: string;
      partyCount: number;
      items: Transaction[];
      /** What actually left the account — the sum of every row in the event. */
      total: number;
      currency: Currency;
    };

export function bundleSplitEvents(items: Transaction[]): LedgerEntry[] {
  const bySplit = new Map<string, Transaction[]>();
  for (const txn of items) {
    const id = parseInternalNote(txn.notes).meta.splitEventId;
    if (!id) continue;
    const bucket = bySplit.get(id) ?? [];
    bucket.push(txn);
    bySplit.set(id, bucket);
  }

  const entries: LedgerEntry[] = [];
  const emitted = new Set<string>();

  for (const txn of items) {
    const meta = parseInternalNote(txn.notes).meta;
    const id = meta.splitEventId;
    const bucket = id ? bySplit.get(id) : undefined;

    // A lone row is not a bundle — collapsing one item into an expandable
    // group is pure noise, and can happen legitimately (a split where the
    // payer's own share was zero and only one person owed anything).
    if (!id || !bucket || bucket.length < 2) {
      entries.push({ kind: 'txn', key: txn.id, txn });
      continue;
    }
    if (emitted.has(id)) continue;
    emitted.add(id);

    entries.push({
      kind: 'split',
      key: `split:${id}`,
      splitEventId: id,
      label: meta.splitLabel || '',
      partyCount: Number(meta.splitPartyCount) || bucket.length,
      items: bucket,
      total: Math.round(bucket.reduce((sum, t) => sum + t.amount, 0) * 100) / 100,
      currency: bucket[0].currency,
    });
  }

  return entries;
}

/** Every transaction id belonging to a split event, for whole-event delete. */
export function splitEventTransactionIds(all: Transaction[], splitEventId: string): string[] {
  return all
    .filter((t) => parseInternalNote(t.notes).meta.splitEventId === splitEventId)
    .map((t) => t.id);
}
