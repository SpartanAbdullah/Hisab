import { describe, it, expect } from 'vitest';
import { seededShuffle, drawOrder, commitmentFor, verifyDraw } from './committeeDraw';

describe('seededShuffle / drawOrder', () => {
  it('is deterministic for the same seed', () => {
    expect(seededShuffle(['a', 'b', 'c', 'd', 'e'], 'seed-1')).toEqual(seededShuffle(['a', 'b', 'c', 'd', 'e'], 'seed-1'));
  });

  it('differs for different seeds (with high probability)', () => {
    const a = drawOrder(['a', 'b', 'c', 'd', 'e', 'f'], 'seed-1');
    const b = drawOrder(['a', 'b', 'c', 'd', 'e', 'f'], 'seed-2');
    expect(a).not.toEqual(b);
  });

  it('is a permutation of the input', () => {
    expect([...drawOrder(['x', 'y', 'z'], 'whatever')].sort()).toEqual(['x', 'y', 'z']);
  });

  it('drawOrder ignores input ordering (canonical)', () => {
    expect(drawOrder(['c', 'a', 'b'], 's')).toEqual(drawOrder(['b', 'c', 'a'], 's'));
  });
});

describe('commit-reveal verifyDraw', () => {
  it('a faithfully-recorded draw verifies true', async () => {
    const ids = ['m1', 'm2', 'm3', 'm4'];
    const seed = 'abc123';
    const commitment = await commitmentFor(seed);
    const order = drawOrder(ids, seed);
    expect(await verifyDraw(ids, seed, commitment, order)).toBe(true);
  });

  it('a tampered ORDER fails verification', async () => {
    const ids = ['m1', 'm2', 'm3', 'm4'];
    const seed = 'abc123';
    const commitment = await commitmentFor(seed);
    const order = drawOrder(ids, seed);
    const tampered = [order[1], order[0], ...order.slice(2)];
    expect(await verifyDraw(ids, seed, commitment, tampered)).toBe(false);
  });

  it('a wrong commitment (organizer swapped the seed) fails', async () => {
    const ids = ['m1', 'm2', 'm3'];
    const seed = 'real-seed';
    const order = drawOrder(ids, seed);
    const fakeCommitment = await commitmentFor('different-seed');
    expect(await verifyDraw(ids, seed, fakeCommitment, order)).toBe(false);
  });
});
