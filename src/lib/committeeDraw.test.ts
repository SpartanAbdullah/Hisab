import { describe, it, expect } from 'vitest';
import { drawOrder, commitmentFor, sha256Hex, verifyDraw, legacyDrawOrderV0, DRAW_SCHEME_VERSION } from './committeeDraw';

// ── The cross-check vector ──────────────────────────────────────────────────
// The SAME numbers appear in the header of
// supabase-migration-audit-p0-kameti-draw.sql and in its verification queries.
// If the SQL draw and this client recompute ever diverge, one of the two
// assertions below breaks first — that is the whole safety net for
// "provably fair", so do not weaken it.
const VECTOR = {
  seed: '00112233445566778899aabbccddeeff',
  memberIds: ['m1', 'm2', 'm3', 'm4', 'm5'],
  ranks: {
    m1: '51e0bdc994f0427918337c264c882c5f8ee0744dc748f9fe21551065a53adb6a',
    m2: '90d21fef9a44c2cd2618b4d53b8d9c229221d004f86d5074a015c32d540b2825',
    m3: 'bd5fddabdfbcf0149db3b82b907180b6af15a644affcb4aa2f53190ff1c8e667',
    m4: '059f50d5e2c6af646c6a7f0a8b9e449fcec8d1d73bfdc99c003470cbe608a524',
    m5: 'c9cf26d8917790e30295caae45412598ed5b84a93e5d1baaf6accd499d764ed5',
  } as Record<string, string>,
  order: ['m4', 'm1', 'm2', 'm3', 'm5'],
  commitment: '5947d7c33d783f94b3b4c1a96ebc8991ed28f1b069b71e03376cba8caa98a720',
};

describe('draw scheme sha256-rank-v1 — fixed cross-check vector', () => {
  it('pins the scheme version the migration writes into committees.draw_scheme', () => {
    expect(DRAW_SCHEME_VERSION).toBe('sha256-rank-v1');
  });

  it('each member rank is sha256(seed || ":" || member_id)', async () => {
    for (const id of VECTOR.memberIds) {
      expect(await sha256Hex(`${VECTOR.seed}:${id}`)).toBe(VECTOR.ranks[id]);
    }
  });

  it('client recompute equals the server order for the fixed vector', async () => {
    expect(await drawOrder(VECTOR.memberIds, VECTOR.seed)).toEqual(VECTOR.order);
  });

  it('the commitment is sha256(seed)', async () => {
    expect(await commitmentFor(VECTOR.seed)).toBe(VECTOR.commitment);
  });

  it('the fixed vector verifies end-to-end', async () => {
    expect(await verifyDraw(VECTOR.memberIds, VECTOR.seed, VECTOR.commitment, VECTOR.order)).toBe(true);
  });
});

describe('drawOrder', () => {
  it('is deterministic for the same seed', async () => {
    const a = await drawOrder(['a', 'b', 'c', 'd', 'e'], 'seed-1');
    const b = await drawOrder(['a', 'b', 'c', 'd', 'e'], 'seed-1');
    expect(a).toEqual(b);
  });

  it('differs for different seeds (with high probability)', async () => {
    const a = await drawOrder(['a', 'b', 'c', 'd', 'e', 'f'], 'seed-1');
    const b = await drawOrder(['a', 'b', 'c', 'd', 'e', 'f'], 'seed-2');
    expect(a).not.toEqual(b);
  });

  it('is a permutation of the input', async () => {
    expect([...(await drawOrder(['x', 'y', 'z'], 'whatever'))].sort()).toEqual(['x', 'y', 'z']);
  });

  it('ignores input ordering (canonical)', async () => {
    expect(await drawOrder(['c', 'a', 'b'], 's')).toEqual(await drawOrder(['b', 'c', 'a'], 's'));
  });

  it('handles the degenerate 1-member committee', async () => {
    expect(await drawOrder(['only'], 'seed')).toEqual(['only']);
  });

  it('spreads slot 1 across members over many seeds (no structural bias)', async () => {
    const ids = ['a', 'b', 'c', 'd'];
    const firsts = new Set<string>();
    for (let i = 0; i < 40; i++) firsts.add((await drawOrder(ids, `s-${i}`))[0]);
    expect(firsts.size).toBe(ids.length);
  });
});

describe('verifyDraw', () => {
  it('a faithfully-recorded draw verifies true', async () => {
    const ids = ['m1', 'm2', 'm3', 'm4'];
    const seed = 'abc123';
    const commitment = await commitmentFor(seed);
    const order = await drawOrder(ids, seed);
    expect(await verifyDraw(ids, seed, commitment, order)).toBe(true);
  });

  it('a tampered ORDER fails verification', async () => {
    const ids = ['m1', 'm2', 'm3', 'm4'];
    const seed = 'abc123';
    const commitment = await commitmentFor(seed);
    const order = await drawOrder(ids, seed);
    const tampered = [order[1], order[0], ...order.slice(2)];
    expect(await verifyDraw(ids, seed, commitment, tampered)).toBe(false);
  });

  it('a wrong commitment (organizer swapped the seed) fails', async () => {
    const ids = ['m1', 'm2', 'm3'];
    const seed = 'real-seed';
    const order = await drawOrder(ids, seed);
    const fakeCommitment = await commitmentFor('different-seed');
    expect(await verifyDraw(ids, seed, fakeCommitment, order)).toBe(false);
  });

  it('a member added or removed after the draw fails', async () => {
    const ids = ['m1', 'm2', 'm3'];
    const seed = 'abc123';
    const commitment = await commitmentFor(seed);
    const order = await drawOrder(ids, seed);
    expect(await verifyDraw([...ids, 'm4'], seed, commitment, order)).toBe(false);
  });

  it('an empty seed or commitment never verifies', async () => {
    expect(await verifyDraw(['m1'], '', 'x', ['m1'])).toBe(false);
    expect(await verifyDraw(['m1'], 'x', '', ['m1'])).toBe(false);
  });

  // Pre-fix records must not be painted as tampered — see legacyDrawOrderV0.
  it('a legacy v0 (pre-fix, client-shuffled) draw still verifies', async () => {
    const ids = ['m1', 'm2', 'm3', 'm4', 'm5'];
    const seed = 'legacy-seed';
    const commitment = await commitmentFor(seed);
    const v0 = legacyDrawOrderV0(ids, seed);
    expect(v0).not.toEqual(await drawOrder(ids, seed));
    expect(await verifyDraw(ids, seed, commitment, v0)).toBe(true);
  });

  it('the legacy fallback does not excuse an order matching NEITHER scheme', async () => {
    const ids = ['m1', 'm2', 'm3', 'm4', 'm5'];
    const seed = 'legacy-seed';
    const commitment = await commitmentFor(seed);
    expect(await verifyDraw(ids, seed, commitment, ['m1', 'm2', 'm3', 'm4', 'm5'].reverse())).toBe(false);
  });
});
