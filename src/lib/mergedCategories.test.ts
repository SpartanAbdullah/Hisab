import { describe, it, expect } from 'vitest';
import { mergeCategories, validateNewCategoryName, withCurrentValue } from './mergedCategories';

describe('mergeCategories', () => {
  it('appends custom names but keeps a trailing "Other" last', () => {
    expect(mergeCategories(['Food', 'Rent', 'Other'], ['Pets', 'Gym'])).toEqual(
      ['Food', 'Rent', 'Pets', 'Gym', 'Other'],
    );
  });

  it('appends to the end when there is no "Other"', () => {
    expect(mergeCategories(['Food', 'Rent'], ['Pets'])).toEqual(['Food', 'Rent', 'Pets']);
  });

  it('drops custom names that collide with a built-in (case-insensitive)', () => {
    expect(mergeCategories(['Food', 'Other'], ['food', 'Pets'])).toEqual(['Food', 'Pets', 'Other']);
  });

  it('dedupes custom names against each other', () => {
    expect(mergeCategories(['Food'], ['Pets', 'pets', ' PETS '])).toEqual(['Food', 'Pets']);
  });

  it('returns a copy of built-ins when there are no custom names', () => {
    const builtIns = ['Food', 'Other'];
    const merged = mergeCategories(builtIns, []);
    expect(merged).toEqual(['Food', 'Other']);
    expect(merged).not.toBe(builtIns);
  });
});

describe('validateNewCategoryName', () => {
  it('rejects empty / whitespace-only names', () => {
    expect(validateNewCategoryName('   ', 'expense', [])).toEqual({ ok: false, code: 'EMPTY' });
  });

  it('rejects overly long names', () => {
    expect(validateNewCategoryName('x'.repeat(29), 'expense', [])).toEqual({ ok: false, code: 'TOO_LONG' });
  });

  it('rejects a name that matches a built-in (case-insensitive)', () => {
    expect(validateNewCategoryName('groceries', 'expense', [])).toEqual({ ok: false, code: 'DUPLICATE' });
    expect(validateNewCategoryName('SALARY', 'income', [])).toEqual({ ok: false, code: 'DUPLICATE' });
  });

  it('rejects a name that matches an existing custom name (case-insensitive)', () => {
    expect(validateNewCategoryName('pets', 'expense', ['Pets'])).toEqual({ ok: false, code: 'DUPLICATE' });
  });

  it('accepts and trims a fresh name', () => {
    expect(validateNewCategoryName('  Pets  ', 'expense', [])).toEqual({ ok: true, name: 'Pets' });
  });
});

describe('withCurrentValue', () => {
  it('appends a current value missing from the options', () => {
    expect(withCurrentValue(['Food', 'Rent'], 'Pets')).toEqual(['Food', 'Rent', 'Pets']);
  });

  it('is a no-op when the value is present (case-insensitive) or empty', () => {
    expect(withCurrentValue(['Food', 'Pets'], 'pets')).toEqual(['Food', 'Pets']);
    expect(withCurrentValue(['Food'], null)).toEqual(['Food']);
    expect(withCurrentValue(['Food'], '')).toEqual(['Food']);
  });
});
