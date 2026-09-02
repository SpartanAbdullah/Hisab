import { describe, it, expect } from 'vitest';
import { nextIntentId, type IntentIdCell } from './useSubmitGuard';

function counter() {
  let n = 0;
  return () => `id-${++n}`;
}

describe('nextIntentId', () => {
  it('mints an id on the first call', () => {
    const cell = nextIntentId(null, 'k1', counter());
    expect(cell).toEqual({ key: 'k1', id: 'id-1' });
  });

  it('reuses the same id while the intent key is unchanged (double tap / retry)', () => {
    const mint = counter();
    let cell: IntentIdCell | null = null;
    cell = nextIntentId(cell, 'amount=500|person=ali', mint);
    const first = cell.id;
    cell = nextIntentId(cell, 'amount=500|person=ali', mint);
    cell = nextIntentId(cell, 'amount=500|person=ali', mint);
    expect(cell.id).toBe(first);
    expect(cell.id).toBe('id-1');
  });

  it('returns the identical cell object when nothing changed', () => {
    const cell = nextIntentId(null, 'k', counter());
    expect(nextIntentId(cell, 'k', counter())).toBe(cell);
  });

  it('mints a fresh id when the form changes — a deliberate second record', () => {
    const mint = counter();
    const a = nextIntentId(null, 'amount=500', mint);
    const b = nextIntentId(a, 'amount=600', mint);
    expect(b.id).not.toBe(a.id);
    expect(b).toEqual({ key: 'amount=600', id: 'id-2' });
  });

  it('mints a fresh id when the modal closes and reopens on the same values', () => {
    const mint = counter();
    const open = nextIntentId(null, 'open=true|amount=500', mint);
    const closed = nextIntentId(open, 'open=false|amount=500', mint);
    const reopened = nextIntentId(closed, 'open=true|amount=500', mint);
    expect(reopened.id).not.toBe(open.id);
  });

  it('goes back to a NEW id after returning to an earlier key (no id resurrection)', () => {
    const mint = counter();
    const a = nextIntentId(null, 'amount=500', mint);
    const b = nextIntentId(a, 'amount=600', mint);
    const c = nextIntentId(b, 'amount=500', mint);
    expect(c.id).not.toBe(a.id);
    expect(c.id).not.toBe(b.id);
  });

  it('treats an undefined cell like a missing one', () => {
    expect(nextIntentId(undefined, 'k', counter()).id).toBe('id-1');
  });
});
