import { describe, expect, it } from 'vitest';
import { isSplitIntent, parseGroupExpenseInput } from './nlGroupExpenseParser';

describe('isSplitIntent', () => {
  it('triggers on explicit split verbs and group/between', () => {
    expect(isSplitIntent('split 200 dinner with flat')).toBe(true);
    expect(isSplitIntent('divide 600 between us')).toBe(true);
    expect(isSplitIntent('add dinner to the flat group')).toBe(true);
  });
  it('does NOT trigger on an ordinary expense note with "with"', () => {
    expect(isSplitIntent('spent 45 on lunch with team')).toBe(false);
    expect(isSplitIntent('karak 3')).toBe(false);
  });
});

describe('parseGroupExpenseInput', () => {
  it('parses amount, description and a named group hint', () => {
    const r = parseGroupExpenseInput('split 200 for dinner with flatmates', { defaultCurrency: 'AED' });
    expect(r.amount).toBe(200);
    expect(r.description).toBe('Dinner');
    // "flatmates" is generic → no specific group name, UI will ask/choose
    expect(r.groupNameHint).toBeNull();
    expect(r.canCreate).toBe(true);
    expect(r.splitType).toBe('equal');
  });

  it('extracts a named group from "<name> group"', () => {
    const r = parseGroupExpenseInput('divide 1500 rent with the flat group');
    expect(r.amount).toBe(1500);
    expect(r.description).toBe('Rent');
    expect(r.groupNameHint).toBe('flat');
  });

  it('extracts a multi-word group name from the tail', () => {
    const r = parseGroupExpenseInput('split 100 aed with goa trip');
    expect(r.currency).toBe('AED');
    expect(r.groupNameHint).toBe('goa trip');
  });

  it('treats "between us" as no specific group', () => {
    const r = parseGroupExpenseInput('divide 600 between us');
    expect(r.amount).toBe(600);
    expect(r.groupNameHint).toBeNull();
  });

  it('falls back to "Group expense" when there is no description word', () => {
    const r = parseGroupExpenseInput('split 600 between us');
    expect(r.description).toBe('Group expense');
  });

  it('asks for an amount when none is given', () => {
    const r = parseGroupExpenseInput('split dinner with flat');
    expect(r.canCreate).toBe(false);
    expect(r.clarify).toMatch(/how much/i);
  });

  it('carries the currency through', () => {
    expect(parseGroupExpenseInput('split 300 pkr for groceries with flat').currency).toBe('PKR');
  });

  it('never throws on odd input', () => {
    expect(() => parseGroupExpenseInput('')).not.toThrow();
    expect(() => parseGroupExpenseInput('split split split')).not.toThrow();
  });
});
