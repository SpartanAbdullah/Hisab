import { describe, it, expect } from 'vitest';
import { normalizeWhatsAppPhone, hasWhatsAppNumber, buildWhatsAppUrl } from './whatsappReminder';

describe('normalizeWhatsAppPhone', () => {
  it('strips + and separators to bare international digits', () => {
    expect(normalizeWhatsAppPhone('+971 50 123 4567')).toBe('971501234567');
    expect(normalizeWhatsAppPhone('(0300) 123-4567')).toBe('03001234567');
  });

  it('returns null for missing or too-short input', () => {
    expect(normalizeWhatsAppPhone(null)).toBe(null);
    expect(normalizeWhatsAppPhone(undefined)).toBe(null);
    expect(normalizeWhatsAppPhone('')).toBe(null);
    expect(normalizeWhatsAppPhone('123')).toBe(null);
    expect(normalizeWhatsAppPhone('+++')).toBe(null);
  });
});

describe('hasWhatsAppNumber', () => {
  it('reflects whether a usable number exists', () => {
    expect(hasWhatsAppNumber('+971501234567')).toBe(true);
    expect(hasWhatsAppNumber(null)).toBe(false);
    expect(hasWhatsAppNumber('12')).toBe(false);
  });
});

describe('buildWhatsAppUrl', () => {
  it('targets a specific chat when the number is known', () => {
    const url = buildWhatsAppUrl('+971501234567', 'Salam Bilal');
    expect(url).toBe('https://wa.me/971501234567?text=Salam%20Bilal');
  });

  it('falls back to the contact picker when the number is unknown', () => {
    const url = buildWhatsAppUrl(null, 'Salam');
    expect(url).toBe('https://wa.me/?text=Salam');
  });

  it('url-encodes multi-line bodies', () => {
    const url = buildWhatsAppUrl('+971501234567', 'Line one\nLine two & more');
    expect(url).toContain('text=Line%20one%0ALine%20two%20%26%20more');
  });
});
