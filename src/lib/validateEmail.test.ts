import { describe, it, expect } from 'vitest';
import { isValidEmail } from './validateEmail';

describe('isValidEmail', () => {
  it('accepts plausible addresses', () => {
    expect(isValidEmail('a@b.co')).toBe(true);
    expect(isValidEmail('ahmed.ali@gmail.com')).toBe(true);
    expect(isValidEmail('  user@domain.io  ')).toBe(true);
  });

  it('rejects malformed input', () => {
    expect(isValidEmail('')).toBe(false);
    expect(isValidEmail('ahmed')).toBe(false);
    expect(isValidEmail('ahmed@')).toBe(false);
    expect(isValidEmail('ahmed@gmail')).toBe(false);
    expect(isValidEmail('ahmed @gmail.com')).toBe(false);
    expect(isValidEmail('@gmail.com')).toBe(false);
  });
});
