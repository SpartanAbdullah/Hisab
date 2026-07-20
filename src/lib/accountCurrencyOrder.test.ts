import { describe, expect, it } from 'vitest';
import { orderAccountsForCurrency } from './accountCurrencyOrder';

const acct = (id: string, currency: string) => ({ id, currency });

describe('orderAccountsForCurrency', () => {
  it('floats matching-currency accounts to the front, keeping relative order on both sides', () => {
    const list = [acct('pk1', 'PKR'), acct('ae1', 'AED'), acct('pk2', 'PKR'), acct('ae2', 'AED')];
    expect(orderAccountsForCurrency(list, 'AED').map((a) => a.id)).toEqual(['ae1', 'ae2', 'pk1', 'pk2']);
  });

  it('returns the input untouched when no currency is given', () => {
    const list = [acct('pk1', 'PKR'), acct('ae1', 'AED')];
    expect(orderAccountsForCurrency(list, null)).toEqual(list);
    expect(orderAccountsForCurrency(list, undefined)).toEqual(list);
  });

  it('handles lists with no matching accounts (all sink, order preserved)', () => {
    const list = [acct('pk1', 'PKR'), acct('pk2', 'PKR')];
    expect(orderAccountsForCurrency(list, 'AED').map((a) => a.id)).toEqual(['pk1', 'pk2']);
  });
});
