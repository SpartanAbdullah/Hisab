import { describe, expect, it } from 'vitest';
import { cardCreditHeadroom, clampCardCredit, type CardLike } from './cardCredit';

const card = (over: Partial<CardLike> = {}): CardLike => ({
  type: 'credit_card',
  balance: 5000,
  metadata: { creditLimit: '16500' },
  ...over,
});

describe('cardCreditHeadroom', () => {
  it('returns limit minus balance for a card below its limit', () => {
    expect(cardCreditHeadroom(card())).toBe(11500);
  });

  it('returns 0 for a card already at its limit (bill fully paid)', () => {
    expect(cardCreditHeadroom(card({ balance: 16500 }))).toBe(0);
  });

  it('returns 0, never negative, for a card already over its limit', () => {
    expect(cardCreditHeadroom(card({ balance: 27650 }))).toBe(0);
  });

  it('returns null for non-card accounts', () => {
    expect(cardCreditHeadroom(card({ type: 'bank' }))).toBeNull();
  });

  it('returns null when no limit is configured', () => {
    expect(cardCreditHeadroom(card({ metadata: {} }))).toBeNull();
    expect(cardCreditHeadroom(card({ metadata: { creditLimit: '0' } }))).toBeNull();
  });
});

describe('clampCardCredit', () => {
  it('passes the full amount when headroom covers it', () => {
    expect(clampCardCredit(card(), 929.17)).toEqual({ credited: 929.17, skipped: 0 });
  });

  it('credits only the headroom when the request exceeds it', () => {
    expect(clampCardCredit(card({ balance: 16000 }), 929.17)).toEqual({ credited: 500, skipped: 429.17 });
  });

  it('skips the credit entirely when the bill is already covered — the double-credit guard', () => {
    // The user paid the card bill by transfer, then clicks an EMI repayment:
    // the card must NOT be credited again.
    expect(clampCardCredit(card({ balance: 16500 }), 929.17)).toEqual({ credited: 0, skipped: 929.17 });
  });

  it('does not clamp when no limit is set', () => {
    expect(clampCardCredit(card({ metadata: {} }), 929.17)).toEqual({ credited: 929.17, skipped: 0 });
  });

  it('returns zeros for a non-positive request', () => {
    expect(clampCardCredit(card(), 0)).toEqual({ credited: 0, skipped: 0 });
    expect(clampCardCredit(card(), -5)).toEqual({ credited: 0, skipped: 0 });
  });

  it('keeps two-decimal money rounding on both legs', () => {
    const c = card({ balance: 16400.005, metadata: { creditLimit: '16500' } });
    const res = clampCardCredit(c, 333.333);
    expect(res.credited + res.skipped).toBeCloseTo(333.33, 2);
    expect(res.credited).toBeCloseTo(100, 1);
  });
});
