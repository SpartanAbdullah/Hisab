import { describe, expect, it } from 'vitest';
import type { Account } from '../db';
import { parseExpenseInput } from './nlExpenseParser';
import { pickAccountForDraft, buildTransactionFromDraft } from './nlExpenseToTransaction';

function acc(over: Partial<Account> = {}): Account {
  return {
    id: 'a1',
    name: 'Cash',
    type: 'cash',
    currency: 'AED',
    balance: 1000,
    ...over,
  } as Account;
}

describe('pickAccountForDraft', () => {
  it('returns null when there are no accounts', () => {
    expect(pickAccountForDraft({ currency: 'AED' }, [])).toBeNull();
  });
  it('prefers an account matching the draft currency', () => {
    const accounts = [acc({ id: 'aed', currency: 'AED' }), acc({ id: 'pkr', currency: 'PKR' })];
    expect(pickAccountForDraft({ currency: 'PKR' }, accounts)?.id).toBe('pkr');
  });
  it('falls back to the first account when no currency matches', () => {
    const accounts = [acc({ id: 'aed', currency: 'AED' })];
    expect(pickAccountForDraft({ currency: 'PKR' }, accounts)?.id).toBe('aed');
  });
  it('falls back to the first account when the draft has no currency', () => {
    const accounts = [acc({ id: 'first' }), acc({ id: 'second' })];
    expect(pickAccountForDraft({ currency: null }, accounts)?.id).toBe('first');
  });
});

describe('buildTransactionFromDraft', () => {
  it('builds an expense input from a parsed draft', () => {
    const draft = parseExpenseInput('add 3 aed for karak');
    const input = buildTransactionFromDraft(draft, acc({ id: 'wallet' }));
    expect(input).toEqual({
      type: 'expense',
      amount: 3,
      sourceAccountId: 'wallet',
      category: 'Food & Dining',
      notes: 'Karak',
    });
  });

  it('builds an income input for income drafts', () => {
    const draft = parseExpenseInput('received 200 from Ali');
    const input = buildTransactionFromDraft(draft, acc({ id: 'bank' }));
    expect(input).toMatchObject({
      type: 'income',
      amount: 200,
      destinationAccountId: 'bank',
      notes: 'Ali',
    });
  });

  it('drops notes when the label is just an echo of the category', () => {
    const draft = parseExpenseInput('rent 3500 aed');
    const input = buildTransactionFromDraft(draft, acc());
    expect(input).toMatchObject({ category: 'Rent', notes: '' });
  });

  it('passes an empty category through when none was inferred', () => {
    const draft = parseExpenseInput('25 aed barber');
    const input = buildTransactionFromDraft(draft, acc());
    expect(input).toMatchObject({ type: 'expense', category: '', notes: 'Barber' });
  });

  it('returns null when there is no postable amount', () => {
    const draft = parseExpenseInput('add karak'); // no amount
    expect(buildTransactionFromDraft(draft, acc())).toBeNull();
  });

  it('returns null for a zero amount', () => {
    const draft = parseExpenseInput('0 aed coffee');
    expect(buildTransactionFromDraft(draft, acc())).toBeNull();
  });
});
