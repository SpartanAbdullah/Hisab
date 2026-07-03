import { describe, it, expect } from 'vitest';
import { buildReceiptText } from './receiptText';

describe('buildReceiptText', () => {
  it('includes the remaining balance on a partial payment', () => {
    const r = buildReceiptText({ receivedAmount: 500, currency: 'AED', remaining: 1500, date: '2026-07-03T09:00:00.000Z' });
    expect(r.english).toBe('Received AED 500.00 from you on 03 Jul 2026 — remaining AED 1,500.00.');
    expect(r.urdu).toContain('baqi AED 1,500.00');
    expect(r.message).toContain('*Payment received*');
    expect(r.message).toContain('— via Hisaab');
  });

  it('says fully settled when nothing remains', () => {
    const r = buildReceiptText({ receivedAmount: 1500, currency: 'AED', remaining: 0, date: '2026-07-03T09:00:00.000Z' });
    expect(r.english).toContain('now fully settled');
    expect(r.urdu).toContain('hisaab barabar');
    expect(r.english).not.toContain('remaining');
  });

  it('omits the remaining clause when remaining is unknown (null)', () => {
    const r = buildReceiptText({ receivedAmount: 500, currency: 'PKR', remaining: null, date: '2026-07-03T09:00:00.000Z' });
    expect(r.english).toBe('Received ₨ 500.00 from you on 03 Jul 2026.');
    expect(r.english).not.toContain('remaining');
    expect(r.english).not.toContain('settled');
  });

  it('keeps amounts in the given currency only (never mixes)', () => {
    const r = buildReceiptText({ receivedAmount: 500, currency: 'PKR', remaining: 1500, date: '2026-07-03T09:00:00.000Z' });
    expect(r.english).toContain('₨ 500.00');
    expect(r.english).toContain('₨ 1,500.00');
    expect(r.english).not.toContain('AED');
  });

  it('adds greeting and sign-off when provided', () => {
    const r = buildReceiptText({ receivedAmount: 500, currency: 'AED', remaining: 1500, date: '2026-07-03T09:00:00.000Z', greeting: 'Hello Rashid,', fromName: 'Muhammad Abdullah' });
    const lines = r.message.split('\n');
    expect(lines[0]).toBe('Hello Rashid,');
    expect(r.message).toContain('Thank you,');
    expect(r.message).toContain('Muhammad Abdullah');
  });

  it('omits greeting and sign-off when absent', () => {
    const r = buildReceiptText({ receivedAmount: 500, currency: 'AED', remaining: 1500, date: '2026-07-03T09:00:00.000Z' });
    expect(r.message).not.toContain('Thank you,');
    const lines = r.message.split('\n');
    expect(lines[0]).toBe('*Payment received*');
  });
});
