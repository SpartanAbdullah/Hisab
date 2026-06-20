import { describe, expect, it } from 'vitest';
import { parseExpenseInput } from './nlExpenseParser';

describe('parseExpenseInput — the headline case', () => {
  it('parses "add 3 aed for karak"', () => {
    const r = parseExpenseInput('add 3 aed for karak');
    expect(r.amount).toBe(3);
    expect(r.currency).toBe('AED');
    expect(r.direction).toBe('expense');
    expect(r.category).toBe('Food & Dining');
    expect(r.label).toBe('Karak');
    expect(r.canPost).toBe(true);
    expect(r.confidence).toBe('high');
    expect(r.clarify).toBeNull();
  });
});

describe('amount + currency extraction', () => {
  it('handles currency after the number', () => {
    expect(parseExpenseInput('coffee 12 aed').amount).toBe(12);
    expect(parseExpenseInput('coffee 12 aed').currency).toBe('AED');
  });
  it('handles currency before the number', () => {
    const r = parseExpenseInput('aed 30 lunch');
    expect(r.amount).toBe(30);
    expect(r.currency).toBe('AED');
  });
  it('handles number glued to currency (3aed / aed3)', () => {
    expect(parseExpenseInput('3aed karak').amount).toBe(3);
    expect(parseExpenseInput('3aed karak').currency).toBe('AED');
    expect(parseExpenseInput('aed3 karak').amount).toBe(3);
  });
  it('parses decimals', () => {
    expect(parseExpenseInput('12.50 aed coffee').amount).toBe(12.5);
  });
  it('parses thousands separators', () => {
    expect(parseExpenseInput('1,200 aed rent').amount).toBe(1200);
  });
  it('expands k / thousand', () => {
    expect(parseExpenseInput('2k aed shopping').amount).toBe(2000);
    expect(parseExpenseInput('1.2k aed').amount).toBe(1200);
    expect(parseExpenseInput('5 thousand pkr').amount).toBe(5000);
  });
  it('expands lakh and crore (PKR market)', () => {
    expect(parseExpenseInput('5 lakh pkr rent').amount).toBe(500000);
    expect(parseExpenseInput('2 crore pkr').amount).toBe(20000000);
    expect(parseExpenseInput('1cr pkr').amount).toBe(10000000);
  });
  it('maps rupee word + symbol to PKR', () => {
    expect(parseExpenseInput('rs 500 groceries').currency).toBe('PKR');
    expect(parseExpenseInput('₨500 bread').currency).toBe('PKR');
    expect(parseExpenseInput('₨500 bread').amount).toBe(500);
  });
  it('maps peso symbol and word to PHP', () => {
    expect(parseExpenseInput('₱300 jeepney').currency).toBe('PHP');
    expect(parseExpenseInput('300 pesos load').currency).toBe('PHP');
  });
  it('returns null currency when none is named', () => {
    expect(parseExpenseInput('uber 24').currency).toBeNull();
  });
  it('falls back to the default currency when provided', () => {
    const r = parseExpenseInput('karak 3', { defaultCurrency: 'AED' });
    expect(r.currency).toBe('AED');
    expect(r.currencyAssumed).toBe(true);
    expect(r.confidence).toBe('medium'); // assumed currency caps confidence
  });
  it('drops unsupported currencies back to the default', () => {
    const r = parseExpenseInput('spent $20 lunch', { defaultCurrency: 'AED' });
    expect(r.currency).toBe('AED');
    expect(r.currencyAssumed).toBe(true);
  });
});

describe('amount disambiguation', () => {
  it('prefers the currency-adjacent number when several appear', () => {
    const r = parseExpenseInput('2 coffees 18 aed');
    expect(r.amount).toBe(18);
    expect(r.currency).toBe('AED');
    expect(r.ambiguousAmount).toBe(true);
  });
  it('falls back to the largest number when no currency anchors it', () => {
    const r = parseExpenseInput('lunch for 4 people 120');
    expect(r.amount).toBe(120);
    expect(r.ambiguousAmount).toBe(true);
  });
  it('is not ambiguous with a single number', () => {
    expect(parseExpenseInput('karak 3').ambiguousAmount).toBe(false);
  });
});

describe('category inference', () => {
  const cases: Array<[string, string]> = [
    ['add 38 aed talabat', 'Food & Dining'],
    ['carrefour 240 aed', 'Groceries'],
    ['careem 31 aed', 'Transport'],
    ['petrol 90 aed', 'Transport'],
    ['rent 3500 aed', 'Rent'],
    ['dewa bill 320 aed', 'Utilities'],
    ['etisalat recharge 55', 'Phone & Internet'],
    ['pharmacy 47 aed', 'Healthcare'],
    ['netflix 56 aed', 'Subscriptions'],
    ['gym 200 aed', 'Subscriptions'],
    ['amazon 150 aed', 'Shopping'],
    ['vox cinema 90', 'Entertainment'],
  ];
  it.each(cases)('classifies %s → %s', (input, cat) => {
    expect(parseExpenseInput(input).category).toBe(cat);
  });
  it('returns null category when nothing matches but keeps the label', () => {
    const r = parseExpenseInput('25 aed barber');
    expect(r.category).toBeNull();
    expect(r.label).toBe('Barber');
    expect(r.canPost).toBe(true);
    expect(r.confidence).toBe('medium');
  });
});

describe('income detection', () => {
  it('detects salary income', () => {
    const r = parseExpenseInput('got salary 5000 aed');
    expect(r.direction).toBe('income');
    expect(r.category).toBe('Salary');
    expect(r.amount).toBe(5000);
  });
  it('detects "received N from X" and keeps the payer as label', () => {
    const r = parseExpenseInput('received 200 from Ali');
    expect(r.direction).toBe('income');
    expect(r.label).toBe('Ali');
    expect(r.amount).toBe(200);
  });
  it('detects refund', () => {
    const r = parseExpenseInput('refund 150 aed');
    expect(r.direction).toBe('income');
    expect(r.category).toBe('Refund');
  });
});

describe('roman-urdu phrasing', () => {
  it('parses "300 ka petrol"', () => {
    const r = parseExpenseInput('300 ka petrol');
    expect(r.amount).toBe(300);
    expect(r.category).toBe('Transport');
    expect(r.label).toBe('Petrol');
  });
  it('parses "karak ke liye 3 aed"', () => {
    const r = parseExpenseInput('karak ke liye 3 aed');
    expect(r.amount).toBe(3);
    expect(r.currency).toBe('AED');
    expect(r.label).toBe('Karak');
  });
});

describe('label cleanup', () => {
  it('keeps descriptive words like "with team"', () => {
    expect(parseExpenseInput('spent 45 on lunch with team').label).toBe('Lunch With Team');
  });
  it('title-cases multi-word merchants', () => {
    expect(parseExpenseInput('200 aed sharaf dg').label).toBe('Sharaf Dg');
  });
  it('falls back to the category name when only an amount+keyword exist', () => {
    expect(parseExpenseInput('rent 3500 aed').label).toBe('Rent');
  });
});

describe('"guided not lost" — never a dead end', () => {
  it('asks for the amount when only a description is given', () => {
    const r = parseExpenseInput('add karak');
    expect(r.canPost).toBe(false);
    expect(r.amount).toBeNull();
    expect(r.clarify).toContain('karak');
    expect(r.confidence).toBe('low');
  });
  it('gives a generic guide for empty input', () => {
    const r = parseExpenseInput('');
    expect(r.canPost).toBe(false);
    expect(r.clarify).toMatch(/add 12 aed|karak 3/);
  });
  it('gives a generic guide for whitespace', () => {
    expect(parseExpenseInput('    ').canPost).toBe(false);
  });
  it('rejects a zero amount with a helpful nudge', () => {
    const r = parseExpenseInput('0 aed coffee');
    expect(r.canPost).toBe(false);
    expect(r.clarify).toMatch(/more than zero/i);
  });
  it('never throws on gibberish and still guides', () => {
    const r = parseExpenseInput('asdfgh qwerty');
    expect(r.canPost).toBe(false);
    expect(r.clarify).not.toBeNull();
  });
  it('never throws on emoji / symbols', () => {
    expect(() => parseExpenseInput('☕️🚕 50 aed')).not.toThrow();
    expect(parseExpenseInput('☕️🚕 50 aed').amount).toBe(50);
  });
  it('handles very long noisy input', () => {
    const noise = 'um so like '.repeat(50) + 'i paid 75 aed for dinner honestly';
    const r = parseExpenseInput(noise);
    expect(r.amount).toBe(75);
    expect(r.category).toBe('Food & Dining');
  });
  it('handles extra whitespace and mixed case', () => {
    const r = parseExpenseInput('   ADD   3   AED   for   KARAK   ');
    expect(r.amount).toBe(3);
    expect(r.currency).toBe('AED');
    expect(r.label).toBe('Karak');
  });
});

describe('totality — fuzz a range of inputs without throwing', () => {
  const inputs = [
    '', ' ', '3', 'aed', 'karak', '3 3 3', '...', '12.', '.5',
    'rs', '₨', 'k', '2k', '1,2,3', 'netflix', 'add for on', '999999999999',
    '-5 aed', '3.14159 aed pie', 'salary', 'from ali', '50% off',
  ];
  it.each(inputs)('does not throw on %j', (input) => {
    expect(() => parseExpenseInput(input)).not.toThrow();
    const r = parseExpenseInput(input);
    expect(typeof r.canPost).toBe('boolean');
    expect(r.canPost ? r.clarify === null : r.clarify !== null).toBe(true);
  });
});
