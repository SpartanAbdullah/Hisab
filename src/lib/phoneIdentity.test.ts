import { describe, it, expect } from 'vitest';
import { toE164Candidates, toE164, formatE164 } from './phoneIdentity';

describe('toE164Candidates', () => {
  it('trusts an explicitly international number', () => {
    expect(toE164Candidates('+971 50 123 4567')).toEqual(['+971501234567']);
    expect(toE164Candidates('+92 300 1234567')).toEqual(['+923001234567']);
  });

  it('treats 00 as a written +', () => {
    expect(toE164Candidates('00971501234567')).toEqual(['+971501234567']);
  });

  it('resolves a UAE national mobile', () => {
    expect(toE164Candidates('050 123 4567')).toEqual(['+971501234567']);
    expect(toE164Candidates('0501234567')).toEqual(['+971501234567']);
  });

  it('resolves a Pakistan national mobile', () => {
    expect(toE164Candidates('0300 1234567')).toEqual(['+923001234567']);
    expect(toE164Candidates('03001234567')).toEqual(['+923001234567']);
  });

  it('resolves a bare national number with no trunk zero', () => {
    expect(toE164Candidates('501234567')).toEqual(['+971501234567']);
    expect(toE164Candidates('3001234567')).toEqual(['+923001234567']);
  });

  it('accepts a country code pasted without the plus', () => {
    expect(toE164Candidates('971501234567')).toEqual(['+971501234567']);
  });

  // The point of returning nothing rather than guessing: a wrong candidate
  // would silently fail to match, which looks like "discovery is broken".
  it('returns nothing for input that cannot be a number', () => {
    expect(toE164Candidates('')).toEqual([]);
    expect(toE164Candidates(null)).toEqual([]);
    expect(toE164Candidates('12345')).toEqual([]);
    expect(toE164Candidates('not a phone')).toEqual([]);
  });

  it('returns nothing for a national-length number with a non-mobile prefix', () => {
    // UAE landline 04 XXX XXXX — real, but never a mobile, so no match.
    expect(toE164Candidates('042345678')).toEqual([]);
  });

  it('rejects an over-length number', () => {
    expect(toE164Candidates('+1234567890123456')).toEqual([]);
  });

  it('ignores punctuation and spacing entirely', () => {
    expect(toE164Candidates('(050) 123-4567')).toEqual(['+971501234567']);
  });
});

describe('toE164', () => {
  it('returns the single unambiguous form', () => {
    expect(toE164('+971501234567')).toBe('+971501234567');
    expect(toE164('0300 1234567')).toBe('+923001234567');
  });

  it('returns null when nothing resolves', () => {
    expect(toE164('12345')).toBeNull();
  });
});

describe('formatE164', () => {
  it('groups digits for confirmation UI', () => {
    expect(formatE164('+971501234567')).toBe('+971 501 234 567');
  });

  it('reads +92 as the calling code, not +923', () => {
    expect(formatE164('+923001234567')).toBe('+92 300 123 4567');
  });

  it('never leaves a dangling single digit', () => {
    expect(formatE164('+923001234567').split(' ').pop()).toHaveLength(4);
  });

  it('passes through anything it cannot parse', () => {
    expect(formatE164('nonsense')).toBe('nonsense');
  });
});
