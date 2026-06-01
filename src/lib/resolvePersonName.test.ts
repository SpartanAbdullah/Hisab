import { beforeEach, describe, expect, it } from 'vitest';
import { resolvePersonName } from './resolvePersonName';
import { usePersonStore } from '../stores/personStore';

describe('resolvePersonName', () => {
  beforeEach(() => usePersonStore.getState().reset());

  it('keeps a readable historical name when an archived contact is absent from active state', () => {
    expect(resolvePersonName({ personId: 'archived-contact', fallback: 'Ahmed Khan' })).toBe('Ahmed Khan');
  });
});
