import { describe, it, expect } from 'vitest';
import { extractConnectCode, formatConnectCode, buildConnectUrl } from './connectQr';

describe('extractConnectCode', () => {
  it('reads our own QR payload', () => {
    expect(extractConnectCode('https://usehisaab.com/u/HSB-ABC234')).toBe('ABC234');
  });

  it('reads a connect URL with query junk appended by a scanner app', () => {
    expect(extractConnectCode('https://usehisaab.com/u/HSB-ABC234?utm=qr')).toBe('ABC234');
  });

  it('reads a custom-scheme link', () => {
    expect(extractConnectCode('hisaab://u/HSB-XYZ789')).toBe('XYZ789');
  });

  it('reads a bare code with the sigil', () => {
    expect(extractConnectCode('@HSB-ABC234')).toBe('ABC234');
  });

  it('reads a code embedded in shared text', () => {
    expect(extractConnectCode('Add me on Hisaab: HSB-ABC234 — see you!')).toBe('ABC234');
  });

  it('reads a bare six-character code with no prefix', () => {
    expect(extractConnectCode('ABC234')).toBe('ABC234');
  });

  it('is case-insensitive', () => {
    expect(extractConnectCode('hsb-abc234')).toBe('ABC234');
  });

  // The whole point of returning null: the UI can say "that isn't a Hisaab
  // QR" rather than running a lookup that fails for a different reason.
  it('rejects an unrelated QR', () => {
    expect(extractConnectCode('https://example.com/menu')).toBeNull();
    expect(extractConnectCode('WIFI:S:cafe;T:WPA;P:hunter2;;')).toBeNull();
    expect(extractConnectCode('')).toBeNull();
  });

  it('does not mine a six-char substring out of unrelated text', () => {
    // "ABCDEF" appears, but the payload as a whole is not a code.
    expect(extractConnectCode('order ABCDEF confirmed')).toBeNull();
  });

  it('rejects ambiguous characters excluded from the alphabet', () => {
    // O and 0, I and 1 are deliberately not in the code alphabet.
    expect(extractConnectCode('HSB-AB0O1I')).toBeNull();
  });
});

describe('formatConnectCode', () => {
  it('round-trips with extract', () => {
    const shown = formatConnectCode('ABC234');
    expect(shown).toBe('HSB-ABC234');
    expect(extractConnectCode(shown)).toBe('ABC234');
  });
});

describe('buildConnectUrl', () => {
  it('produces a payload extract can read back', () => {
    const url = buildConnectUrl('HSB-ABC234');
    expect(url.endsWith('/u/HSB-ABC234')).toBe(true);
    expect(extractConnectCode(url)).toBe('ABC234');
  });

  it('tolerates a code passed with the @ sigil', () => {
    expect(buildConnectUrl('@HSB-ABC234').endsWith('/u/HSB-ABC234')).toBe(true);
  });
});
