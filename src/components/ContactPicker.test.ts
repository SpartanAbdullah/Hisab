import { describe, expect, it } from 'vitest';
import { getContactSecondaryText, getContactTypeLabel } from './ContactPicker';
import type { Person } from '../db';

function person(overrides: Partial<Person>): Person {
  return {
    id: 'person-1',
    name: 'Ahmed Khan',
    phone: null,
    linkedProfileId: null,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

describe('ContactPicker option presentation', () => {
  it('distinguishes duplicate linked and local names', () => {
    const linked = person({ id: 'linked', linkedProfileId: 'profile-2' });
    const local = person({ id: 'local', phone: '+971501234567' });

    expect(getContactTypeLabel(linked)).toBe('Linked');
    expect(getContactSecondaryText(linked)).toBe('Hisaab user');
    expect(getContactTypeLabel(local)).toBe('Local');
    expect(getContactSecondaryText(local)).toBe('Saved locally · +971501234567');
  });
});
