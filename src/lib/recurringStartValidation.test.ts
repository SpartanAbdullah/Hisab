import { describe, expect, it } from 'vitest';
import { validateRecurringStart } from './recurringStartValidation';

const today = '2026-06-20';

describe('validateRecurringStart', () => {
  it('passes a future start date silently', () => {
    expect(validateRecurringStart('2026-07-20', today)).toEqual({ ok: true });
  });
  it('passes today and a recent past date (within a week)', () => {
    expect(validateRecurringStart(today, today).ok).toBe(true);
    expect(validateRecurringStart('2026-06-17', today).ok).toBe(true);
  });
  it('warns on a clearly retroactive date (>1 week past)', () => {
    const r = validateRecurringStart('2026-05-01', today);
    expect(r.ok).toBe(false);
    expect(r.severity).toBe('warn');
    expect(r.reason).toMatch(/past/);
  });
  it('blocks a date years in the past', () => {
    expect(validateRecurringStart('2023-01-01', today).severity).toBe('block');
  });
  it('blocks a date years in the future', () => {
    expect(validateRecurringStart('2030-01-01', today).severity).toBe('block');
  });
  it('blocks an unparseable date', () => {
    expect(validateRecurringStart('not-a-date', today).severity).toBe('block');
  });
});
