import { describe, it, expect } from 'vitest';
import {
  EDIT_HISTORY_TRACKED_FIELDS,
  isForbiddenHistoryField,
  renderEditHistory,
  renderEditHistoryEntry,
  type EditHistoryEntry,
  type EditHistoryRenderContext,
} from './editHistory';

function entry(over: Partial<EditHistoryEntry> = {}): EditHistoryEntry {
  return {
    id: 1,
    tableName: 'group_expenses',
    recordId: 'E1',
    groupId: 'G1',
    ownerId: 'u-ali',
    actorId: 'u-ali',
    actorKind: 'user',
    action: 'update',
    changed: {},
    createdAt: '2026-09-02T10:00:00.000Z',
    ...over,
  };
}

const NAMES: Record<string, string> = { 'M-A': 'Ali', 'M-B': 'Bilal', 'M-C': 'Sara' };

function ctx(over: Partial<EditHistoryRenderContext> = {}): EditHistoryRenderContext {
  return {
    lang: 'en',
    actorName: 'Ali',
    memberName: (id) => NAMES[id] ?? id,
    ...over,
  };
}

const texts = (e: EditHistoryEntry, c = ctx()) => renderEditHistoryEntry(e, c).map((l) => l.text);

describe('renderEditHistoryEntry — the headline cases from the audit', () => {
  it('renders a money change as "Ali changed amount 500 → 450"', () => {
    const e = entry({ changed: { amount: { old: 500, new: 450 } } });
    expect(texts(e)).toEqual(['Ali changed amount 500 → 450']);
  });

  it('renders a removed participant as "Sara removed Bilal from the split"', () => {
    const e = entry({
      changed: {
        splits: {
          old: [{ memberId: 'M-A', amount: 30 }, { memberId: 'M-B', amount: 30 }],
          new: [{ memberId: 'M-A', amount: 60 }],
        },
      },
    });
    expect(texts(e, ctx({ actorName: 'Sara' }))).toEqual([
      "Sara changed Ali's share 30 → 60",
      'Sara removed Bilal from the split',
    ]);
  });

  it('renders both languages from the same row', () => {
    const e = entry({ changed: { amount: { old: 500, new: 450 } } });
    expect(texts(e, ctx({ lang: 'ur' }))).toEqual(['Ali ne raqam 500 → 450 ki']);
    expect(texts(e, ctx({ lang: 'en' }))).toEqual(['Ali changed amount 500 → 450']);
  });
});

describe('splits diffing', () => {
  it('detects an added participant', () => {
    const e = entry({
      changed: {
        splits: {
          old: [{ memberId: 'M-A', amount: 60 }],
          new: [{ memberId: 'M-A', amount: 30 }, { memberId: 'M-C', amount: 30 }],
        },
      },
    });
    expect(texts(e)).toEqual([
      "Ali changed Ali's share 60 → 30",
      'Ali added Sara to the split',
    ]);
  });

  it('is order-insensitive — a reordered but identical split renders nothing', () => {
    const e = entry({
      changed: {
        splits: {
          old: [{ memberId: 'M-B', amount: 30 }, { memberId: 'M-A', amount: 30 }],
          new: [{ memberId: 'M-A', amount: 30 }, { memberId: 'M-B', amount: 30 }],
        },
      },
    });
    // No participant line survives, so the guard headline is all that is left.
    expect(renderEditHistoryEntry(e, ctx())).toHaveLength(1);
    expect(texts(e)).toEqual(['Ali created this record']);
  });

  it('falls back to the raw member id when no name resolver is given', () => {
    const e = entry({
      changed: { splits: { old: [{ memberId: 'M-B', amount: 30 }], new: [] } },
    });
    expect(texts(e, ctx({ memberName: undefined }))).toEqual([
      'Ali removed M-B from the split',
    ]);
  });

  it('ignores malformed split members instead of throwing', () => {
    const e = entry({
      changed: {
        splits: {
          old: [null, { amount: 5 }, { memberId: 'M-B', amount: 30 }],
          new: 'not-an-array',
        },
      },
    });
    expect(texts(e)).toEqual(['Ali removed Bilal from the split']);
  });
});

describe('insert and soft-delete headlines', () => {
  it('an insert carries the amount it was created with', () => {
    const e = entry({
      action: 'insert',
      changed: {
        amount: { old: null, new: 60 },
        description: { old: null, new: 'Hotel' },
      },
    });
    expect(texts(e)).toEqual(['Ali created this record — 60']);
  });

  it('a soft delete carries the amount that stopped counting', () => {
    const e = entry({
      action: 'soft_delete',
      changed: { amount: { old: 60, new: null } },
    });
    expect(texts(e)).toEqual(['Ali deleted this record — 60']);
    expect(texts(e, ctx({ lang: 'ur' }))).toEqual(['Ali ne yeh entry delete ki — 60']);
  });

  it('falls back to the bare headline when no money field is present', () => {
    const e = entry({
      action: 'insert',
      tableName: 'group_settlements',
      changed: { note: { old: null, new: 'cash' } },
    });
    expect(texts(e)).toEqual(['Ali created this record']);
  });
});

describe('field-specific phrasing', () => {
  it('setting a previously empty note reads as "set", clearing it as "cleared"', () => {
    expect(texts(entry({ changed: { notes: { old: null, new: 'split at dinner' } } })))
      .toEqual(['Ali set note to split at dinner']);
    expect(texts(entry({ changed: { notes: { old: 'split at dinner', new: null } } })))
      .toEqual(['Ali cleared note']);
  });

  it('names the payer rather than showing a member id', () => {
    const e = entry({ changed: { paid_by: { old: 'M-A', new: 'M-B' } } });
    expect(texts(e)).toEqual(['Ali changed the payer from Ali to Bilal']);
  });

  it('renders a loan settle/reopen as a status sentence, not a field diff', () => {
    const settled = entry({
      tableName: 'loans',
      changed: {
        remaining_amount: { old: 500, new: 0 },
        status: { old: 'active', new: 'settled' },
      },
    });
    expect(texts(settled)).toEqual([
      'Ali changed remaining 500 → 0',
      'Ali marked this loan settled',
    ]);

    const reopened = entry({
      tableName: 'loans',
      changed: { status: { old: 'settled', new: 'active' } },
    });
    expect(texts(reopened)).toEqual(['Ali reopened this loan']);
  });

  it('formats money and dates through the supplied formatters', () => {
    const e = entry({
      tableName: 'loans',
      changed: { total_amount: { old: 500, new: 450 } },
    });
    expect(texts(e, ctx({ money: (v) => `AED ${v.toFixed(2)}` })))
      .toEqual(['Ali changed total AED 500.00 → AED 450.00']);

    const dated = entry({
      changed: { date: { old: '2026-08-01', new: '2026-08-04' } },
    });
    expect(texts(dated, ctx({ date: (v) => v.split('-').reverse().join('/') })))
      .toEqual(['Ali changed date 01/08/2026 → 04/08/2026']);
  });

  it('renders numeric-string money the same as numeric money (PostgREST NUMERIC)', () => {
    const e = entry({ changed: { amount: { old: '500.00', new: '450.00' } } });
    expect(texts(e, ctx({ money: (v) => v.toFixed(2) })))
      .toEqual(['Ali changed amount 500.00 → 450.00']);
  });

  it('is deterministic in field order regardless of JSON key order', () => {
    const a = entry({
      changed: {
        notes: { old: null, new: 'x' },
        amount: { old: 1, new: 2 },
        date: { old: '2026-01-01', new: '2026-01-02' },
      },
    });
    const b = entry({
      changed: {
        date: { old: '2026-01-01', new: '2026-01-02' },
        amount: { old: 1, new: 2 },
        notes: { old: null, new: 'x' },
      },
    });
    expect(texts(a)).toEqual(texts(b));
    expect(texts(a)).toEqual([
      'Ali changed amount 1 → 2',
      'Ali changed date 2026-01-01 → 2026-01-02',
      'Ali set note to x',
    ]);
  });
});

describe('both app modes / account-id containment', () => {
  it('no tracked whitelist mentions an account id', () => {
    for (const [table, fields] of Object.entries(EDIT_HISTORY_TRACKED_FIELDS)) {
      for (const f of fields) {
        expect(isForbiddenHistoryField(f), `${table}.${f}`).toBe(false);
      }
    }
  });

  it('drops an account id even if a row somehow carries one', () => {
    const e = entry({
      tableName: 'transactions',
      changed: {
        amount: { old: 100, new: 120 },
        source_account_id: { old: 'acc-1', new: 'acc-2' },
        destinationAccountId: { old: null, new: 'acc-3' },
      },
    });
    expect(texts(e)).toEqual(['Ali changed amount 100 → 120']);
  });

  it('a ledger-mode transaction row (no account legs at all) renders identically to a full-tracker one', () => {
    const ledger = entry({
      id: 7,
      tableName: 'transactions',
      groupId: null,
      changed: { amount: { old: 100, new: 120 } },
    });
    const tracker = entry({
      id: 8,
      tableName: 'transactions',
      groupId: null,
      changed: { amount: { old: 100, new: 120 } },
    });
    expect(texts(ledger)).toEqual(texts(tracker));
  });
});

describe('renderEditHistory', () => {
  it('keeps entry order and gives every entry at least one line', () => {
    const entries: EditHistoryEntry[] = [
      entry({ id: 3, action: 'insert', changed: { amount: { old: null, new: 60 } } }),
      entry({ id: 2, changed: { amount: { old: 60, new: 40 } } }),
      entry({ id: 1, action: 'soft_delete', changed: {} }),
    ];
    const rendered = renderEditHistory(entries, () => ctx());
    expect(rendered.map((r) => r.entry.id)).toEqual([3, 2, 1]);
    expect(rendered.every((r) => r.lines.length >= 1)).toBe(true);
    expect(rendered[2].lines[0].text).toBe('Ali deleted this record');
  });

  it('every line key is unique across a list', () => {
    const entries: EditHistoryEntry[] = [
      entry({
        id: 10,
        changed: {
          amount: { old: 1, new: 2 },
          splits: {
            old: [{ memberId: 'M-A', amount: 1 }],
            new: [{ memberId: 'M-B', amount: 2 }],
          },
        },
      }),
      entry({ id: 11, changed: { amount: { old: 2, new: 3 } } }),
    ];
    const keys = renderEditHistory(entries, () => ctx()).flatMap((r) => r.lines.map((l) => l.key));
    expect(new Set(keys).size).toBe(keys.length);
  });
});
