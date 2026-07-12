import { describe, it, expect } from 'vitest';
import { brandIconFor } from './brandIcon';

describe('brandIconFor', () => {
  it('matches well-known brands by substring, case-insensitively', () => {
    expect(brandIconFor('Netflix', 'Subscriptions')).toEqual({ emoji: '🎬', matched: 'brand' });
    expect(brandIconFor('SPOTIFY Premium', 'Subscriptions').matched).toBe('brand');
    expect(brandIconFor('YouTube Premium', 'Subscriptions').emoji).toBe('▶️');
  });

  it('matches regional brands (UAE/Pakistan)', () => {
    expect(brandIconFor('Careem Plus', 'Subscriptions').emoji).toBe('🚗');
    expect(brandIconFor('Jazz monthly bundle', 'Phone & Internet').emoji).toBe('📶');
    expect(brandIconFor('K-Electric bill', 'Utilities').emoji).toBe('⚡');
  });

  it('matches generic recurring names like salary and rent', () => {
    expect(brandIconFor('Salary', 'Salary')).toEqual({ emoji: '💰', matched: 'brand' });
    expect(brandIconFor('House rent', 'Rent').emoji).toBe('🏠');
    expect(brandIconFor('Gym membership', 'Entertainment').emoji).toBe('🏋️');
  });

  it('falls back to the category emoji when the label is unknown', () => {
    expect(brandIconFor('Some Random Service', 'Subscriptions')).toEqual({ emoji: '🔁', matched: 'category' });
    expect(brandIconFor('Weekly bazar', 'Groceries').emoji).toBe('🛒');
  });

  it('returns none for unknown label + unknown/custom category', () => {
    expect(brandIconFor('Mystery thing', 'My Custom Category')).toEqual({ emoji: '', matched: 'none' });
    expect(brandIconFor('', '').matched).toBe('none');
  });

  it('uses the category as the name when the label is empty', () => {
    // label defaults to category in the template model
    expect(brandIconFor('', 'Rent').emoji).toBe('🏠');
  });
});
