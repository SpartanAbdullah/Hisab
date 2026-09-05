import { describe, expect, it } from 'vitest';
import { CONFETTI_COLORS, confettiBits, confettiOuterRadius } from './motion';

// These pin the geometry the founder approved in the 2026-09-05 motion
// preview. The burst is pure CSS driven by custom properties, so a drift here
// would only ever show up as a slightly-wrong 1s animation — easy to miss by
// eye, cheap to pin in a test.
describe('confettiBits', () => {
  it('returns the requested number of bits, defaulting to 20', () => {
    expect(confettiBits()).toHaveLength(20);
    expect(confettiBits(12)).toHaveLength(12);
    expect(confettiBits(0)).toEqual([]);
  });

  it('is deterministic — two calls produce identical geometry', () => {
    expect(confettiBits()).toEqual(confettiBits());
    expect(confettiBits(9, 30)).toEqual(confettiBits(9, 30));
  });

  it('makes every third bit a shard and the rest dots', () => {
    const bits = confettiBits();
    bits.forEach((bit, i) => {
      expect(bit.shape).toBe(i % 3 === 0 ? 'shard' : 'dot');
    });
    expect(bits.filter((b) => b.shape === 'shard')).toHaveLength(7);
  });

  it('cycles through the six clay tint colours in order', () => {
    expect(CONFETTI_COLORS).toHaveLength(6);
    const bits = confettiBits();
    bits.forEach((bit, i) => {
      expect(bit.color).toBe(CONFETTI_COLORS[i % 6]);
    });
    // Every tint gets used at least three times across 20 bits.
    for (const color of CONFETTI_COLORS) {
      expect(bits.filter((b) => b.color === color).length).toBeGreaterThanOrEqual(3);
    }
  });

  it('emits colours as "R G B" triples ready for rgb(R G B)', () => {
    for (const color of CONFETTI_COLORS) {
      expect(color).toMatch(/^\d{1,3} \d{1,3} \d{1,3}$/);
    }
  });

  it('keeps every bit within the outer ring (radius + 33px) before the 10px lift', () => {
    for (const radius of [52, 30, 80]) {
      const outer = confettiOuterRadius(radius);
      expect(outer).toBe(radius + 33);
      for (const bit of confettiBits(20, radius)) {
        // dy already carries the -10px lift; undo it to measure travel from
        // the centre. +1 absorbs the per-axis rounding.
        const travel = Math.hypot(bit.dx, bit.dy + 10);
        expect(travel).toBeLessThanOrEqual(outer + 1);
        expect(travel).toBeGreaterThanOrEqual(radius - 1);
        expect(Math.abs(bit.dx)).toBeLessThanOrEqual(outer);
        expect(Math.abs(bit.dy + 10)).toBeLessThanOrEqual(outer);
      }
    }
  });

  it('steps through the four ring radii so the burst has depth', () => {
    const bits = confettiBits(20, 52);
    // Bits 0..3 sit on rings 52, 63, 74, 85 respectively (before the lift).
    const ringOf = (bit: { dx: number; dy: number }) => Math.round(Math.hypot(bit.dx, bit.dy + 10));
    expect(ringOf(bits[0])).toBe(52);
    expect(ringOf(bits[1])).toBe(63);
    expect(ringOf(bits[2])).toBe(74);
    expect(ringOf(bits[3])).toBe(85);
    expect(ringOf(bits[4])).toBe(52);
  });

  it('lifts every bit 10px above where the circle alone would land it', () => {
    // Bit 0 is at angle 0: pure +x travel, so dy is exactly the lift.
    const [first] = confettiBits();
    expect(first.dx).toBe(52);
    expect(first.dy).toBe(-10);
  });

  it('staggers delays in 40ms steps between 160ms and 320ms', () => {
    const bits = confettiBits();
    bits.forEach((bit, i) => {
      expect(bit.delayMs).toBe(160 + (i % 5) * 40);
      expect(bit.delayMs).toBeGreaterThanOrEqual(160);
      expect(bit.delayMs).toBeLessThanOrEqual(320);
    });
  });

  it('alternates rotation direction bit to bit and grows the spin with index', () => {
    const bits = confettiBits();
    bits.forEach((bit, i) => {
      expect(Math.sign(bit.rot)).toBe(i % 2 === 1 ? 1 : -1);
      expect(Math.abs(bit.rot)).toBe(120 + i * 13);
    });
  });

  it('rounds every px value to a whole number so the CSS never sees sub-pixel noise', () => {
    for (const bit of confettiBits()) {
      expect(Number.isInteger(bit.dx)).toBe(true);
      expect(Number.isInteger(bit.dy)).toBe(true);
      expect(Number.isInteger(bit.rot)).toBe(true);
      expect(Number.isInteger(bit.delayMs)).toBe(true);
    }
  });
});
