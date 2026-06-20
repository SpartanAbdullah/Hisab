import { describe, expect, it } from 'vitest';
import { suggestCategory, type HistoryTxn } from './categorySuggest';

const history: HistoryTxn[] = [
  { type: 'expense', notes: 'Karak', category: 'Food & Dining' },
  { type: 'expense', notes: 'Karak tea at office', category: 'Food & Dining' },
  { type: 'expense', notes: 'Samosa', category: 'Food & Dining' },
  { type: 'expense', notes: 'Barber haircut', category: 'Personal Care' },
  { type: 'income', notes: 'Salary', category: 'Salary' },
];

describe('suggestCategory', () => {
  it('learns a category from the user\'s own past wording (not a hardcoded list)', () => {
    expect(suggestCategory('karak', history, 'expense')).toBe('Food & Dining');
  });

  it('generalises to a thing never hardcoded anywhere ("barber")', () => {
    expect(suggestCategory('barber', history, 'expense')).toBe('Personal Care');
  });

  it('matches on a shared significant word', () => {
    expect(suggestCategory('morning karak', history, 'expense')).toBe('Food & Dining');
  });

  it('respects direction — income wording does not leak into expense suggestions', () => {
    expect(suggestCategory('salary', history, 'expense')).toBeNull();
    expect(suggestCategory('salary', history, 'income')).toBe('Salary');
  });

  it('returns null when there is no similar history (cold start)', () => {
    expect(suggestCategory('helicopter', history, 'expense')).toBeNull();
  });

  it('picks the most frequently used category when wording is ambiguous', () => {
    const h: HistoryTxn[] = [
      { type: 'expense', notes: 'lunch', category: 'Food & Dining' },
      { type: 'expense', notes: 'lunch', category: 'Food & Dining' },
      { type: 'expense', notes: 'lunch meeting', category: 'Business' },
    ];
    expect(suggestCategory('lunch', h, 'expense')).toBe('Food & Dining');
  });

  it('returns null for blank input', () => {
    expect(suggestCategory('', history, 'expense')).toBeNull();
  });
});
