import { describe, expect, it } from 'vitest';
import {
  CURRENCIES,
  CURRENCY_CODES,
  LEGACY_CURRENCIES,
  currencyMeta,
  currencyMinorUnits,
  isSupportedCurrency,
  roundMoney,
  searchCurrencies,
  topCurrencies,
} from './currencies';
import { SUPPORTED_CURRENCIES } from '../db/types';

// The complete set of currencies that do NOT have cents. Spelled out here on
// purpose: a typo in the big RAW table (a 2 where a 0 belongs) silently
// invents fractional yen for every JPY user, and no other test would catch it.
const ZERO_DECIMAL = [
  'BIF', 'CLP', 'DJF', 'GNF', 'ISK', 'JPY', 'KMF', 'KRW',
  'PYG', 'RWF', 'UGX', 'VND', 'VUV', 'XAF', 'XOF', 'XPF',
];

// The mils/fils currencies — three decimals, all Gulf/North-African dinars.
const THREE_DECIMAL = ['BHD', 'IQD', 'JOD', 'KWD', 'LYD', 'OMR', 'TND'];

describe('the catalogue', () => {
  it('holds the full active ISO 4217 list', () => {
    expect(CURRENCIES.length).toBeGreaterThan(150);
    expect(CURRENCY_CODES).toHaveLength(CURRENCIES.length);
  });

  it('is sorted A–Z by code with no duplicates', () => {
    expect([...CURRENCY_CODES]).toEqual([...CURRENCY_CODES].sort());
    expect(new Set(CURRENCY_CODES).size).toBe(CURRENCY_CODES.length);
  });

  it('gives every currency a code, both names, a symbol and a region', () => {
    for (const c of CURRENCIES) {
      expect(c.code, c.code).toMatch(/^[A-Z]{3}$/);
      expect(c.name.en.length, c.code).toBeGreaterThan(0);
      expect(c.name.ur.length, c.code).toBeGreaterThan(0);
      expect(c.symbol.length, c.code).toBeGreaterThan(0);
      expect(c.regions.length, c.code).toBeGreaterThan(0);
      expect([0, 2, 3], c.code).toContain(c.minorUnits);
    }
  });

  it('contains every legacy currency the DB still accepts', () => {
    for (const code of LEGACY_CURRENCIES) {
      expect(CURRENCY_CODES, code).toContain(code);
    }
  });

  it('keeps SUPPORTED_CURRENCIES aliased to LEGACY_CURRENCIES', () => {
    // The DB CHECK is still the eight — db/types must not drift from here.
    expect([...SUPPORTED_CURRENCIES]).toEqual([...LEGACY_CURRENCIES]);
  });

  it('pins the eight legacy symbols so existing statements never change', () => {
    expect(currencyMeta('AED')?.symbol).toBe('AED');
    expect(currencyMeta('PKR')?.symbol).toBe('₨');
    expect(currencyMeta('PHP')?.symbol).toBe('₱');
    for (const code of ['SAR', 'QAR', 'OMR', 'KWD', 'BHD']) {
      expect(currencyMeta(code)?.symbol, code).toBe(code);
    }
  });
});

describe('currencyMeta / isSupportedCurrency', () => {
  it('looks a currency up by code', () => {
    expect(currencyMeta('PKR')?.name.en).toBe('Pakistani Rupee');
    expect(currencyMeta('PKR')?.name.ur).toBe('Pakistani Rupaya');
  });

  it('is case-insensitive and tolerates surrounding whitespace', () => {
    expect(currencyMeta('aed')?.code).toBe('AED');
    expect(currencyMeta('  JpY  ')?.code).toBe('JPY');
  });

  it('returns undefined for an unknown or withdrawn code', () => {
    expect(currencyMeta('XYZ')).toBeUndefined();
    expect(currencyMeta('')).toBeUndefined();
    expect(isSupportedCurrency('ZWL')).toBe(false); // withdrawn 2024
    expect(isSupportedCurrency('USD')).toBe(true);
  });
});

describe('currencyMinorUnits', () => {
  it('reports zero decimals for exactly the whole-unit currencies', () => {
    const actual = CURRENCIES.filter((c) => c.minorUnits === 0).map((c) => c.code);
    expect(actual).toEqual(ZERO_DECIMAL);
  });

  it('reports three decimals for exactly the fils/mils dinars', () => {
    const actual = CURRENCIES.filter((c) => c.minorUnits === 3).map((c) => c.code);
    expect(actual).toEqual(THREE_DECIMAL);
  });

  it('spot-checks the ones people actually hit', () => {
    expect(currencyMinorUnits('JPY')).toBe(0);
    expect(currencyMinorUnits('KRW')).toBe(0);
    expect(currencyMinorUnits('VND')).toBe(0);
    expect(currencyMinorUnits('CLP')).toBe(0);
    expect(currencyMinorUnits('ISK')).toBe(0);
    expect(currencyMinorUnits('UGX')).toBe(0);
    expect(currencyMinorUnits('KWD')).toBe(3);
    expect(currencyMinorUnits('BHD')).toBe(3);
    expect(currencyMinorUnits('OMR')).toBe(3);
    expect(currencyMinorUnits('AED')).toBe(2);
    expect(currencyMinorUnits('PKR')).toBe(2);
  });

  it('falls back to 2 for an unknown code', () => {
    expect(currencyMinorUnits('XYZ')).toBe(2);
  });
});

describe('roundMoney', () => {
  it('rounds to the currency’s smallest unit', () => {
    expect(roundMoney(1234.567, 'JPY')).toBe(1235);
    expect(roundMoney(1234.4, 'KRW')).toBe(1234);
    expect(roundMoney(12.3456, 'KWD')).toBe(12.346);
    expect(roundMoney(12.3454, 'BHD')).toBe(12.345);
    expect(roundMoney(10.005, 'AED')).toBe(10.01);
  });

  it('matches the app-wide 2dp idiom when no currency is given', () => {
    expect(roundMoney(10.005)).toBe(Math.round(10.005 * 100) / 100);
    expect(roundMoney(1 / 3)).toBe(0.33);
  });

  it('passes non-finite values through untouched', () => {
    expect(roundMoney(Number.NaN, 'AED')).toBeNaN();
    expect(roundMoney(Number.POSITIVE_INFINITY, 'AED')).toBe(Number.POSITIVE_INFINITY);
  });
});

describe('searchCurrencies', () => {
  const codes = (q: string, lang: 'ur' | 'en' = 'en') => searchCurrencies(q, lang).map((c) => c.code);

  it('returns nothing for an empty or whitespace query', () => {
    expect(searchCurrencies('', 'en')).toEqual([]);
    expect(searchCurrencies('   ', 'ur')).toEqual([]);
  });

  it('ranks an exact code first', () => {
    expect(codes('AED')[0]).toBe('AED');
    expect(codes('inr')[0]).toBe('INR');
    // INR's code is exact; INR also matches "india" — exactness still wins.
    expect(codes('kwd')[0]).toBe('KWD');
  });

  it('ranks code prefixes above name matches', () => {
    const result = codes('pk');
    expect(result[0]).toBe('PKR');
  });

  it('matches names', () => {
    expect(codes('pakistani')[0]).toBe('PKR');
    expect(codes('japanese')[0]).toBe('JPY');
  });

  it('matches roman-Urdu names when the reader is on Urdu', () => {
    expect(codes('rupaya', 'ur')).toContain('PKR');
    expect(codes('amreeki', 'ur')[0]).toBe('USD');
    expect(codes('bartanvi', 'ur')[0]).toBe('GBP');
  });

  it('matches colloquial aliases', () => {
    expect(codes('dirham')[0]).toBe('AED');
    expect(codes('emirates')[0]).toBe('AED');
    expect(codes('rupee')).toEqual(expect.arrayContaining(['PKR', 'INR', 'LKR', 'NPR']));
    expect(codes('riyal')[0]).toBe('SAR');
    expect(codes('ringgit')[0]).toBe('MYR');
    expect(codes('taka')[0]).toBe('BDT');
  });

  it('matches Urdu-script aliases', () => {
    expect(codes('درہم')[0]).toBe('AED');
    expect(codes('روپیہ')).toContain('PKR');
    expect(codes('ریال')).toEqual(expect.arrayContaining(['SAR', 'QAR', 'OMR']));
  });

  it('is case- and diacritic-insensitive', () => {
    expect(codes('DIRHAM')[0]).toBe('AED');
    expect(codes('DiRhAm')[0]).toBe('AED');
    // "Türkiye" is the stored region name; a user types it without the umlaut.
    expect(codes('turkiye')).toContain('TRY');
    expect(codes('Türkiye')).toContain('TRY');
  });

  it('matches country names', () => {
    expect(codes('pakistan')[0]).toBe('PKR');
    expect(codes('united kingdom')[0]).toBe('GBP');
    expect(codes('philippines')[0]).toBe('PHP');
  });

  it('biases ties toward the currencies this audience holds', () => {
    // AED and MAD are both "dirham"; PKR and INR are both "rupaya". Blind
    // alphabetical order would put INR and AED's competitor first.
    const dirhams = codes('dirham');
    expect(dirhams.indexOf('AED')).toBeLessThan(dirhams.indexOf('MAD'));
    const rupayas = codes('rupaya', 'ur');
    expect(rupayas.indexOf('PKR')).toBeLessThan(rupayas.indexOf('INR'));
  });

  it('falls back to substring matching', () => {
    expect(codes('ingg')).toContain('MYR'); // inside "ringgit"
  });

  it('returns nothing for gibberish', () => {
    expect(codes('zzzzqqq')).toEqual([]);
  });
});

describe('topCurrencies', () => {
  const codes = (input: Parameters<typeof topCurrencies>[0]) =>
    topCurrencies(input).map((c) => c.code);

  it('defaults to five regional suggestions for a brand-new user', () => {
    expect(codes({})).toEqual(['PKR', 'AED', 'SAR', 'USD', 'GBP']);
  });

  it('puts the primary currency first', () => {
    expect(codes({ primary: 'KWD' })[0]).toBe('KWD');
  });

  it('lists used currencies after the primary, in the order given', () => {
    expect(codes({ primary: 'AED', used: ['GBP', 'PKR'] })).toEqual([
      'AED', 'GBP', 'PKR', 'SAR', 'USD',
    ]);
  });

  it('dedupes across primary, used and the regional defaults', () => {
    const result = codes({ primary: 'PKR', used: ['PKR', 'AED', 'AED'], limit: 8 });
    expect(new Set(result).size).toBe(result.length);
    expect(result.slice(0, 2)).toEqual(['PKR', 'AED']);
  });

  it('drops unknown codes instead of rendering a blank row', () => {
    expect(codes({ primary: 'XYZ', used: ['NOPE', 'GBP'] })[0]).toBe('GBP');
  });

  it('honours the region hint', () => {
    expect(codes({ region: 'SA' })[0]).toBe('SAR');
    expect(codes({ region: 'gb' })[0]).toBe('GBP');
    // An unknown region falls through to the default order.
    expect(codes({ region: 'ZZ' })[0]).toBe('PKR');
  });

  it('lets the primary beat the region hint', () => {
    expect(codes({ primary: 'JPY', region: 'SA' })).toEqual([
      'JPY', 'SAR', 'PKR', 'INR', 'USD',
    ]);
  });

  it('respects the limit', () => {
    expect(codes({ limit: 3 })).toHaveLength(3);
    expect(codes({ limit: 0 })).toEqual([]);
    expect(codes({ limit: 500 }).length).toBeLessThanOrEqual(CURRENCIES.length);
  });
});
