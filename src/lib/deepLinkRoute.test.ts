import { describe, expect, it } from 'vitest';
import { extractDeepLinkPath } from './deepLinkRoute';

describe('extractDeepLinkPath', () => {
  it('extracts the path from a join invite link', () => {
    expect(extractDeepLinkPath('https://usehisaab.com/join/ABC123')).toBe('/join/ABC123');
  });

  it('extracts the path from a connect-by-code link', () => {
    expect(extractDeepLinkPath('https://usehisaab.com/u/HSB-XXXXXX')).toBe('/u/HSB-XXXXXX');
  });

  it('extracts the path from a kameti witness link', () => {
    expect(extractDeepLinkPath('https://usehisaab.com/kameti/witness/tok_1')).toBe('/kameti/witness/tok_1');
  });

  it('preserves the query string', () => {
    expect(extractDeepLinkPath('https://usehisaab.com/join/ABC123?ref=whatsapp')).toBe('/join/ABC123?ref=whatsapp');
  });

  it('returns null for the bare root path', () => {
    expect(extractDeepLinkPath('https://usehisaab.com/')).toBeNull();
    expect(extractDeepLinkPath('https://usehisaab.com')).toBeNull();
  });

  it('works for the capacitor:// custom scheme too', () => {
    expect(extractDeepLinkPath('capacitor://localhost/join/ABC123')).toBe('/join/ABC123');
  });

  it('returns null for a malformed URL instead of throwing', () => {
    expect(extractDeepLinkPath('not a url')).toBeNull();
  });
});
