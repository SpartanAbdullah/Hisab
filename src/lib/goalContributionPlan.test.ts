import { describe, expect, it } from 'vitest';
import { planGoalContributionLegs, predictedSavedAfter } from './goalContributionPlan';

const base = {
  sourceAccountId: 'bank',
  sourceCurrency: 'AED',
  goalCurrency: 'AED',
  goalStoredInAccountId: '',
  storedInAccountExists: false,
  amount: 200,
};

describe('planGoalContributionLegs', () => {
  it('tracked internally: debits the source, credits nothing, writes no rate', () => {
    expect(planGoalContributionLegs(base)).toEqual({
      selfStored: false,
      sourceAmount: 200,
      linkedAccountId: null,
      conversionRate: null,
    });
  });

  it('stored in a DIFFERENT account that exists: the credit leg is the row destination', () => {
    expect(planGoalContributionLegs({
      ...base, goalStoredInAccountId: 'vault', storedInAccountExists: true,
    })).toEqual({
      selfStored: false, sourceAmount: 200, linkedAccountId: 'vault', conversionRate: null,
    });
  });

  it('stored in an account that no longer exists: contributes WITHOUT a credit leg', () => {
    // stored_in_account_id is a label, not a foreign key (no FK on the column),
    // so this is a reachable state and must not fail — it is the branch's own
    // `if (linkedAccount)` guard.
    expect(planGoalContributionLegs({
      ...base, goalStoredInAccountId: 'closed-vault', storedInAccountExists: false,
    })).toMatchObject({ selfStored: false, sourceAmount: 200, linkedAccountId: null });
  });

  it('SELF-STORED: no legs at all — the money physically stays where it is', () => {
    expect(planGoalContributionLegs({
      ...base, goalStoredInAccountId: 'bank', storedInAccountExists: true,
    })).toEqual({
      selfStored: true, sourceAmount: 0, linkedAccountId: null, conversionRate: null,
    });
  });

  it('SELF-STORED is currency-blind: it breaks before the cross-currency check', () => {
    // transactionStore.ts:2105-2113 — the self-stored branch `break`s BEFORE
    // the `src.currency !== goal.currency` test, so a PKR account funding an
    // AED goal it stores writes NO rate and converts nothing.
    expect(planGoalContributionLegs({
      ...base,
      sourceCurrency: 'PKR',
      goalStoredInAccountId: 'bank',
      storedInAccountExists: true,
      conversionRate: 76.5,
    })).toEqual({
      selfStored: true, sourceAmount: 0, linkedAccountId: null, conversionRate: null,
    });
  });

  it('cross-currency DIVIDES — the opposite of the transfer branch', () => {
    // transactionStore.ts:2118 `Math.round(input.amount / input.conversionRate * 100) / 100`.
    // A "multiply" implementation would debit 15 300 PKR instead of 2.61.
    expect(planGoalContributionLegs({
      ...base, sourceCurrency: 'PKR', conversionRate: 76.5,
    })).toEqual({
      selfStored: false, sourceAmount: 2.61, linkedAccountId: null, conversionRate: 76.5,
    });
  });

  it('cross-currency still credits the stored-in account by the GOAL-currency amount', () => {
    expect(planGoalContributionLegs({
      ...base,
      sourceCurrency: 'PKR',
      conversionRate: 76.5,
      goalStoredInAccountId: 'vault',
      storedInAccountExists: true,
    })).toEqual({
      selfStored: false, sourceAmount: 2.61, linkedAccountId: 'vault', conversionRate: 76.5,
    });
  });

  it('a rate on a same-currency contribution is dropped, never written', () => {
    expect(planGoalContributionLegs({ ...base, conversionRate: 3.67 }).conversionRate).toBeNull();
  });

  it('a missing rate on a cross-currency contribution leaves the branch guard to fire', () => {
    // The user-facing "Conversion rate required" string lives in the branch;
    // duplicating it here would fork the message.
    expect(planGoalContributionLegs({ ...base, sourceCurrency: 'PKR' })).toEqual({
      selfStored: false, sourceAmount: 200, linkedAccountId: null, conversionRate: null,
    });
  });

  it('whitespace-only stored-in id is "tracked internally", not a self-store', () => {
    expect(planGoalContributionLegs({
      ...base, goalStoredInAccountId: '   ', storedInAccountExists: true,
    })).toMatchObject({ selfStored: false, linkedAccountId: null });
  });

  it('rounds the source deduction to 2dp, like the branch', () => {
    expect(planGoalContributionLegs({
      ...base, amount: 1000, sourceCurrency: 'PKR', conversionRate: 76.5,
    }).sourceAmount).toBe(13.07);
  });
});

describe('predictedSavedAfter — the client copy of the server clamp', () => {
  it('adds and rounds the SUM, exactly as goalStore.addContribution does', () => {
    expect(predictedSavedAfter(0, 200)).toBe(200);
    expect(predictedSavedAfter(0.1, 0.2)).toBe(0.3);
    expect(predictedSavedAfter(1000.005, 0)).toBe(1000.01);
  });

  it('clamps at zero for the negative delta the delete path applies', () => {
    expect(predictedSavedAfter(100, -250)).toBe(0);
    expect(predictedSavedAfter(100, -100)).toBe(0);
  });

  it('agrees with the SQL expression GREATEST(0, round(saved + round(amount,2), 2))', () => {
    // The three copies of this rule (client store, this predictor, the RPC)
    // have to agree to the cent or a compensation hands back the wrong figure.
    for (const [saved, amount, expected] of [
      [8666.68, 1083.33, 9750.01],
      [0, 0.005, 0.01],
      [12.34, 0.001, 12.34],
    ] as const) {
      expect(predictedSavedAfter(saved, amount)).toBe(expected);
    }
  });
});
