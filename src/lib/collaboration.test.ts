import { describe, it, expect, beforeEach } from 'vitest';
import {
  normalizePublicCode,
  recordCodeLookupCharge,
  codeLookupBudgetSpent,
  resetCodeLookupBudget,
} from './collaboration';

describe('normalizePublicCode', () => {
  it('strips the prefix, sigil, hyphens and case', () => {
    expect(normalizePublicCode(' hsb-ab12cd ')).toBe('AB12CD');
    expect(normalizePublicCode('@HSB-AB12CD')).toBe('AB12CD');
    expect(normalizePublicCode('AB12CD')).toBe('AB12CD');
  });

  // Guards the reason personStore.normaliseEnteredCode passes an
  // already-normalised code straight through: "HSB" is spellable in the code
  // alphabet, so normalising twice eats three real characters.
  it('is NOT idempotent for a code that itself starts with HSB', () => {
    expect(normalizePublicCode('HSB-HSBK47')).toBe('HSBK47');
    expect(normalizePublicCode(normalizePublicCode('HSB-HSBK47'))).toBe('K47');
  });
});

describe('code lookup budget mirror', () => {
  beforeEach(() => resetCodeLookupBudget());

  it('starts unspent', () => {
    expect(codeLookupBudgetSpent()).toBe(false);
  });

  it('trips only at the server’s 20-per-hour ceiling', () => {
    for (let i = 0; i < 19; i += 1) recordCodeLookupCharge();
    expect(codeLookupBudgetSpent()).toBe(false);
    recordCodeLookupCharge();
    expect(codeLookupBudgetSpent()).toBe(true);
  });

  it('resets cleanly (a fresh session can never claim rate-limited)', () => {
    for (let i = 0; i < 25; i += 1) recordCodeLookupCharge();
    expect(codeLookupBudgetSpent()).toBe(true);
    resetCodeLookupBudget();
    expect(codeLookupBudgetSpent()).toBe(false);
  });
});
