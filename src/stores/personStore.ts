import { create } from 'zustand';
import { v4 as uuid } from 'uuid';
import { personsDb } from '../lib/supabaseDb';
import type { Person } from '../db';

interface PersonState {
  persons: Person[];
  loading: boolean;
  loadPersons: () => Promise<void>;
  getPersons: () => Person[];
  createPerson: (name: string, phone?: string | null) => Promise<Person>;
  findOrCreateByName: (name: string) => Promise<Person>;
  linkToProfile: (personId: string, profileId: string) => Promise<void>;
  unlinkFromProfile: (personId: string) => Promise<void>;
  reset: () => void;
}

// Thrown when a link would collide with the unique (user_id, linked_profile_id)
// index — i.e. the user already linked another of their contacts to the same
// other user. Callers render a clean user-facing message.
export class DuplicateLinkedContactError extends Error {
  constructor() {
    super('DUPLICATE_LINKED_CONTACT');
    this.name = 'DuplicateLinkedContactError';
  }
}

function isUniqueViolation(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const code = (err as { code?: string }).code;
  return code === '23505';
}

const INITIAL_PERSON_STATE = {
  persons: [] as Person[],
  loading: false,
};

// Normalise for case/whitespace-insensitive match. Storage keeps original
// casing — this is only for equality checks against existing rows.
function normalise(name: string): string {
  return name.trim().toLocaleLowerCase();
}

// Dedupe concurrent findOrCreate calls for the same name within a tab so a
// double-submit does not create two person rows. Keyed by normalised name.
const inflight = new Map<string, Promise<Person>>();

export const usePersonStore = create<PersonState>((set, get) => ({
  ...INITIAL_PERSON_STATE,

  reset: () => {
    inflight.clear();
    set(INITIAL_PERSON_STATE);
  },

  loadPersons: async () => {
    set({ loading: true });
    try {
      const persons = await personsDb.getAll();
      set({ persons });
    } finally {
      set({ loading: false });
    }
  },

  getPersons: () => get().persons,

  createPerson: async (name, phone = null) => {
    const trimmed = name.trim();
    if (!trimmed) throw new Error('Contact name is required');
    const now = new Date().toISOString();
    const person: Person = {
      id: uuid(),
      name: trimmed,
      phone: phone ?? null,
      createdAt: now,
      updatedAt: now,
    };
    await personsDb.add(person);
    set((s) => ({ persons: [...s.persons, person] }));
    return person;
  },

  linkToProfile: async (personId, profileId) => {
    try {
      await personsDb.setLinkedProfileId(personId, profileId);
    } catch (err) {
      if (isUniqueViolation(err)) throw new DuplicateLinkedContactError();
      throw err;
    }
    set((s) => ({
      persons: s.persons.map((p) => (p.id === personId ? { ...p, linkedProfileId: profileId } : p)),
    }));
  },

  unlinkFromProfile: async (personId) => {
    await personsDb.setLinkedProfileId(personId, null);
    set((s) => ({
      persons: s.persons.map((p) => (p.id === personId ? { ...p, linkedProfileId: null } : p)),
    }));
  },

  findOrCreateByName: async (name) => {
    const trimmed = name.trim();
    if (!trimmed) throw new Error('Contact name is required');
    const key = normalise(trimmed);

    const existing = get().persons.find((p) => normalise(p.name) === key);
    if (existing) return existing;

    const pending = inflight.get(key);
    if (pending) return pending;

    const promise = (async () => {
      try {
        return await get().createPerson(trimmed);
      } finally {
        inflight.delete(key);
      }
    })();
    inflight.set(key, promise);
    return promise;
  },
}));
