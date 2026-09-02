import { describe, it, expect, afterEach } from 'vitest';
import {
  DEFAULT_PRIMARY_CURRENCY,
  PRIMARY_CURRENCY_KEY,
  getPrimaryCurrency,
  resolvePrimaryCurrency,
} from './primaryCurrency';
import { SUPPORTED_CURRENCIES } from '../db/types';

afterEach(() => {
  localStorage.removeItem(PRIMARY_CURRENCY_KEY);
});

describe('resolvePrimaryCurrency', () => {
  it('passes through every supported currency untouched', () => {
    for (const currency of SUPPORTED_CURRENCIES) {
      expect(resolvePrimaryCurrency(currency)).toBe(currency);
    }
  });

  it('falls back for null / undefined / empty', () => {
    expect(resolvePrimaryCurrency(null)).toBe(DEFAULT_PRIMARY_CURRENCY);
    expect(resolvePrimaryCurrency(undefined)).toBe(DEFAULT_PRIMARY_CURRENCY);
    expect(resolvePrimaryCurrency('')).toBe(DEFAULT_PRIMARY_CURRENCY);
  });

  it('falls back for an unsupported or tampered value', () => {
    expect(resolvePrimaryCurrency('USD')).toBe(DEFAULT_PRIMARY_CURRENCY);
    expect(resolvePrimaryCurrency('aed')).toBe(DEFAULT_PRIMARY_CURRENCY); // case-sensitive on purpose
    expect(resolvePrimaryCurrency('{"a":1}')).toBe(DEFAULT_PRIMARY_CURRENCY);
  });
});

describe('getPrimaryCurrency', () => {
  it('reads the profile mirror when it holds a supported currency', () => {
    localStorage.setItem(PRIMARY_CURRENCY_KEY, 'PKR');
    expect(getPrimaryCurrency()).toBe('PKR');
  });

  it('returns exactly ONE fallback when the mirror is empty — the UX-34 bug', () => {
    // The regression: Analytics/CreateGroupModal/CreateCommitteeModal used to
    // answer 'PKR' here while Home/Transactions/Accounts/Budgets answered
    // 'AED', so a group could be created in a currency no other screen used.
    expect(getPrimaryCurrency()).toBe(DEFAULT_PRIMARY_CURRENCY);
    expect(getPrimaryCurrency()).toBe(getPrimaryCurrency());
  });

  it('does not trust a garbage mirror value', () => {
    localStorage.setItem(PRIMARY_CURRENCY_KEY, 'NOT_A_CURRENCY');
    expect(getPrimaryCurrency()).toBe(DEFAULT_PRIMARY_CURRENCY);
  });

  it('the fallback is itself a supported currency', () => {
    expect(SUPPORTED_CURRENCIES).toContain(DEFAULT_PRIMARY_CURRENCY);
  });
});
