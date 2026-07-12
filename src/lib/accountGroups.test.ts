import { describe, it, expect } from 'vitest';
import { groupAccountsByType } from './accountGroups';
import type { Account, AccountType } from '../db';

function acct(id: string, type: AccountType): Account {
  return {
    id,
    name: id,
    type,
    currency: 'AED',
    balance: 0,
    metadata: {},
    createdAt: '2026-01-01T00:00:00.000Z',
  };
}

describe('groupAccountsByType', () => {
  it('buckets all five types into three ordered groups', () => {
    const groups = groupAccountsByType([
      acct('card', 'credit_card'),
      acct('bank', 'bank'),
      acct('cash', 'cash'),
      acct('savings', 'savings'),
      acct('wallet', 'digital_wallet'),
    ]);
    expect(groups.map((g) => g.id)).toEqual(['wallets_cash', 'banks', 'credit_cards']);
    expect(groups[0].accounts.map((a) => a.id)).toEqual(['cash', 'wallet']);
    expect(groups[1].accounts.map((a) => a.id)).toEqual(['bank', 'savings']);
    expect(groups[2].accounts.map((a) => a.id)).toEqual(['card']);
  });

  it('omits empty groups', () => {
    const groups = groupAccountsByType([acct('b1', 'bank'), acct('b2', 'bank')]);
    expect(groups.map((g) => g.id)).toEqual(['banks']);
  });

  it('preserves the caller-supplied order within each group', () => {
    const groups = groupAccountsByType([
      acct('z-cash', 'cash'),
      acct('a-wallet', 'digital_wallet'),
      acct('m-cash', 'cash'),
    ]);
    expect(groups[0].accounts.map((a) => a.id)).toEqual(['z-cash', 'a-wallet', 'm-cash']);
  });

  it('returns an empty array for no accounts', () => {
    expect(groupAccountsByType([])).toEqual([]);
  });
});
