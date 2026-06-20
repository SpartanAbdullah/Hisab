import { describe, expect, it } from 'vitest';
import { findRecentDuplicate } from './duplicateExpense';

const NOW = Date.parse('2026-06-20T12:00:00Z');
const existing = [
  { id: 'e1', description: 'Rent', amount: 1000, createdAt: '2026-06-20T11:40:00Z' }, // 20 min ago
  { id: 'e2', description: 'Groceries', amount: 240, createdAt: '2026-06-19T12:00:00Z' }, // yesterday
];

describe('findRecentDuplicate', () => {
  it('flags a same description+amount added recently', () => {
    expect(findRecentDuplicate({ description: 'Rent', amount: 1000 }, existing, NOW)?.id).toBe('e1');
  });
  it('is case- and whitespace-insensitive on the description', () => {
    expect(findRecentDuplicate({ description: '  rent ', amount: 1000 }, existing, NOW)?.id).toBe('e1');
  });
  it('does not flag a different amount', () => {
    expect(findRecentDuplicate({ description: 'Rent', amount: 900 }, existing, NOW)).toBeNull();
  });
  it('does not flag a different description', () => {
    expect(findRecentDuplicate({ description: 'Wifi', amount: 1000 }, existing, NOW)).toBeNull();
  });
  it('does not flag an old entry outside the window', () => {
    expect(findRecentDuplicate({ description: 'Groceries', amount: 240 }, existing, NOW)).toBeNull();
  });
  it('ignores blank descriptions', () => {
    expect(findRecentDuplicate({ description: '   ', amount: 1000 }, existing, NOW)).toBeNull();
  });
});
