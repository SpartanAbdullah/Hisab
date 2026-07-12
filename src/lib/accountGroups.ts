// Groups accounts into the three user-facing buckets shown across the app:
// Wallets & Cash (cash + digital_wallet), Banks (bank + savings) and Credit
// Cards. Every account list/picker should present the same sections in the
// same order so accounts never read as one undifferentiated dump. Pure +
// tested; rendering stays in the callers.

import type { Account, AccountType } from '../db';

export type AccountGroupId = 'wallets_cash' | 'banks' | 'credit_cards';

export interface AccountGroup {
  id: AccountGroupId;
  labelKey: 'acct_group_wallets_cash' | 'acct_group_banks' | 'acct_group_cards';
  accounts: Account[];
}

const GROUP_OF: Record<AccountType, AccountGroupId> = {
  cash: 'wallets_cash',
  digital_wallet: 'wallets_cash',
  bank: 'banks',
  savings: 'banks',
  credit_card: 'credit_cards',
};

const GROUP_ORDER: { id: AccountGroupId; labelKey: AccountGroup['labelKey'] }[] = [
  { id: 'wallets_cash', labelKey: 'acct_group_wallets_cash' },
  { id: 'banks', labelKey: 'acct_group_banks' },
  { id: 'credit_cards', labelKey: 'acct_group_cards' },
];

/**
 * Buckets accounts into Wallets & Cash → Banks → Credit Cards, preserving the
 * input order within each bucket (so currency-first or recency sorting done by
 * the caller survives). Empty groups are omitted — callers typically render
 * section labels only when more than one group is present.
 */
export function groupAccountsByType(accounts: Account[]): AccountGroup[] {
  const buckets = new Map<AccountGroupId, Account[]>();
  for (const a of accounts) {
    const id = GROUP_OF[a.type] ?? 'banks';
    const list = buckets.get(id) ?? [];
    list.push(a);
    buckets.set(id, list);
  }
  return GROUP_ORDER.filter((g) => buckets.has(g.id)).map((g) => ({
    id: g.id,
    labelKey: g.labelKey,
    accounts: buckets.get(g.id)!,
  }));
}
