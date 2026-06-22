import { describe, expect, it } from 'vitest';
import { parseDataQuery } from './nlQuery';

describe('parseDataQuery — person balance', () => {
  it('parses "Ghulam owes me how much?"', () => {
    expect(parseDataQuery('Ghulam owes me how much?')).toEqual({ kind: 'person-balance', personName: 'Ghulam' });
  });
  it('parses "how much does Ali owe me"', () => {
    expect(parseDataQuery('how much does Ali owe me')).toEqual({ kind: 'person-balance', personName: 'Ali' });
  });
  it('parses "how much do I owe Bilal"', () => {
    expect(parseDataQuery('how much do I owe Bilal')).toEqual({ kind: 'person-balance', personName: 'Bilal' });
  });
  it('parses roman-urdu "Ghulam ka hisaab"', () => {
    expect(parseDataQuery('Ghulam ka hisaab')).toEqual({ kind: 'person-balance', personName: 'Ghulam' });
  });
});

describe('parseDataQuery — net / account balance', () => {
  it('routes "how much am I owed" to net-balance', () => {
    expect(parseDataQuery('how much am I owed')).toEqual({ kind: 'net-balance' });
  });
  it('routes "who owes me money" to net-balance', () => {
    expect(parseDataQuery('who owes me money')).toEqual({ kind: 'net-balance' });
  });
  it('routes "what\'s my balance" / "how much do I have" to account-balance', () => {
    expect(parseDataQuery("what's my balance")).toEqual({ kind: 'account-balance' });
    expect(parseDataQuery('how much do I have')).toEqual({ kind: 'account-balance' });
  });
});

describe('parseDataQuery — spending insight', () => {
  it('routes "where did my money go" to top-spend', () => {
    expect(parseDataQuery('where did my money go')).toEqual({ kind: 'top-spend' });
  });
  it('routes "what did I spend the most on" to top-spend', () => {
    expect(parseDataQuery('what did I spend the most on')).toEqual({ kind: 'top-spend' });
  });
  it('routes "how much did I spend on food" to category-spend', () => {
    expect(parseDataQuery('how much did I spend on food')).toEqual({ kind: 'category-spend', category: 'food' });
  });
  it('routes "am I spending more than last month" to trend', () => {
    expect(parseDataQuery('am I spending more than last month')).toEqual({ kind: 'trend' });
  });
});

describe('parseDataQuery — budget', () => {
  it('routes "what\'s left in my budget" to budget-status', () => {
    expect(parseDataQuery("what's left in my budget")).toEqual({ kind: 'budget-status' });
  });
  it('routes "am I over budget on food" to budget-status with category', () => {
    expect(parseDataQuery('am I over budget on food')).toEqual({ kind: 'budget-status', category: 'food' });
  });
  it('routes "how much can I still spend on groceries" to budget-status', () => {
    expect(parseDataQuery('how much can I still spend on groceries')).toEqual({ kind: 'budget-status', category: 'groceries' });
  });
});

describe('parseDataQuery — income', () => {
  it('routes "how much was my income this month" to income', () => {
    expect(parseDataQuery('how much was my income this month')).toEqual({ kind: 'income', period: 'this' });
  });
  it('routes "how much did I earn last month" to income (last)', () => {
    expect(parseDataQuery('how much did I earn last month')).toEqual({ kind: 'income', period: 'last' });
  });
  it('routes "my income" to income', () => {
    expect(parseDataQuery('my income')).toEqual({ kind: 'income', period: 'this' });
  });
});

describe('parseDataQuery — account / card spend', () => {
  it('routes "which card did I spend most from" to account-spend (aggregate)', () => {
    expect(parseDataQuery('which card did I spend most from')).toEqual({ kind: 'account-spend', period: 'this' });
  });
  it('routes "how much did I spend from my HBL" to account-spend (named)', () => {
    expect(parseDataQuery('how much did I spend from my HBL')).toEqual({ kind: 'account-spend', accountName: 'HBL', period: 'this' });
  });
  it('routes "spending by card" to account-spend (aggregate)', () => {
    expect(parseDataQuery('spending by card')).toEqual({ kind: 'account-spend', period: 'this' });
  });
  it('does NOT hijack "how much did I spend on food" (stays category)', () => {
    expect(parseDataQuery('how much did I spend on food')).toEqual({ kind: 'category-spend', category: 'food' });
  });
});

describe('parseDataQuery — does NOT hijack commands or how-to', () => {
  it('ignores an add command', () => {
    expect(parseDataQuery('add 3 aed for karak')).toBeNull();
    expect(parseDataQuery('spent 45 on food')).toBeNull();
  });
  it('ignores a how-to question', () => {
    expect(parseDataQuery('how do subscriptions work')).toBeNull();
    expect(parseDataQuery('which mode should I use')).toBeNull();
  });
  it('returns null for empty / gibberish', () => {
    expect(parseDataQuery('')).toBeNull();
    expect(parseDataQuery('asdfgh')).toBeNull();
  });
});
