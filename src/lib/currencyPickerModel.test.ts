import { describe, it, expect } from 'vitest';
import {
  CURRENCY_CHIP_LIMIT,
  currencyChipRow,
  groupCurrenciesByLetter,
  isCurrencyAllowed,
} from './currencyPickerModel';
import type { CurrencyMeta } from './currencies';

function meta(code: string): CurrencyMeta {
  return {
    code,
    name: { en: code, ur: code },
    symbol: code,
    minorUnits: 2,
    aliases: [],
    regions: [],
  };
}

describe('currencyChipRow', () => {
  const top = ['AED', 'PKR', 'SAR', 'USD', 'GBP', 'EUR', 'INR'];

  it('shows exactly the ranked top five by default', () => {
    const row = currencyChipRow({ value: 'AED', top });
    expect(row.codes).toEqual(['AED', 'PKR', 'SAR', 'USD', 'GBP']);
    expect(row.codes).toHaveLength(CURRENCY_CHIP_LIMIT);
    expect(row.valuePinned).toBe(false);
  });

  it('does not pin a value that is already in the visible head', () => {
    const row = currencyChipRow({ value: 'GBP', top });
    expect(row.codes).toEqual(['AED', 'PKR', 'SAR', 'USD', 'GBP']);
    expect(row.valuePinned).toBe(false);
  });

  it('pins a value that ranks BELOW the cut, keeping the row the same length', () => {
    // INR is 7th — outside the top five — so it must still be visible.
    const row = currencyChipRow({ value: 'INR', top });
    expect(row.codes).toEqual(['INR', 'AED', 'PKR', 'SAR', 'USD']);
    expect(row.codes).toHaveLength(CURRENCY_CHIP_LIMIT);
    expect(row.valuePinned).toBe(true);
  });

  it('pins a value the ranking does not contain at all', () => {
    const row = currencyChipRow({ value: 'JPY', top });
    expect(row.codes[0]).toBe('JPY');
    expect(row.codes).toHaveLength(CURRENCY_CHIP_LIMIT);
    expect(row.valuePinned).toBe(true);
  });

  it('never renders the pinned value twice', () => {
    const row = currencyChipRow({ value: 'INR', top });
    expect(row.codes.filter((c) => c === 'INR')).toHaveLength(1);
  });

  it('de-dupes a ranking that repeats a code', () => {
    const row = currencyChipRow({ value: 'AED', top: ['AED', 'AED', 'PKR', 'PKR', 'SAR'] });
    expect(row.codes).toEqual(['AED', 'PKR', 'SAR']);
  });

  it('pins nothing when the value is empty', () => {
    const row = currencyChipRow({ value: '', top });
    expect(row.codes).toEqual(['AED', 'PKR', 'SAR', 'USD', 'GBP']);
    expect(row.valuePinned).toBe(false);
  });

  it('honours a custom limit', () => {
    expect(currencyChipRow({ value: 'INR', top, limit: 3 }).codes).toEqual(['INR', 'AED', 'PKR']);
    expect(currencyChipRow({ value: 'INR', top, limit: 0 }).codes).toEqual([]);
  });

  it('tolerates a ranking shorter than the limit', () => {
    const row = currencyChipRow({ value: 'JPY', top: ['AED'] });
    expect(row.codes).toEqual(['JPY', 'AED']);
  });
});

describe('groupCurrenciesByLetter', () => {
  it('sorts A–Z by code and groups by first letter', () => {
    const groups = groupCurrenciesByLetter([meta('PKR'), meta('AED'), meta('AUD'), meta('BHD')]);
    expect(groups.map((g) => g.letter)).toEqual(['A', 'B', 'P']);
    expect(groups[0].items.map((i) => i.code)).toEqual(['AED', 'AUD']);
    expect(groups[1].items.map((i) => i.code)).toEqual(['BHD']);
    expect(groups[2].items.map((i) => i.code)).toEqual(['PKR']);
  });

  it('produces one group per letter, never a repeat', () => {
    const groups = groupCurrenciesByLetter([meta('AED'), meta('BHD'), meta('AUD')]);
    expect(groups.map((g) => g.letter)).toEqual(['A', 'B']);
  });

  it('does not mutate the input array', () => {
    const input = [meta('PKR'), meta('AED')];
    groupCurrenciesByLetter(input);
    expect(input.map((i) => i.code)).toEqual(['PKR', 'AED']);
  });

  it('returns nothing for an empty catalogue', () => {
    expect(groupCurrenciesByLetter([])).toEqual([]);
  });
});

describe('isCurrencyAllowed', () => {
  it('allows everything when no allowlist is given', () => {
    expect(isCurrencyAllowed('JPY')).toBe(true);
    expect(isCurrencyAllowed('AED')).toBe(true);
  });

  it('disables codes outside a given allowlist', () => {
    const legacy = ['AED', 'PKR'];
    expect(isCurrencyAllowed('AED', legacy)).toBe(true);
    expect(isCurrencyAllowed('JPY', legacy)).toBe(false);
  });

  it('treats an empty allowlist as "nothing is writable yet"', () => {
    expect(isCurrencyAllowed('AED', [])).toBe(false);
  });
});
