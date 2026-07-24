import { create } from 'zustand';
import { v4 as uuid } from 'uuid';
import { personsDb } from '../lib/supabaseDb';
import type { ArchiveContactResult, MergePersonResult } from '../lib/supabaseDb';
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
  updatePhone: (personId: string, phone: string | null) => Promise<void>;
  archiveIfSettled: (personId: string) => Promise<ArchiveContactResult>;
  // Server-side atomic merge of a LOCAL duplicate into another contact.
  // Loans/transactions reloads are the CALLER's job (cross-store).
  mergePerson: (sourceId: string, targetId: string) => Promise<MergePersonResult>;
  unarchive: (personId: string) => Promise<boolean>;
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
    // Best-effort: notify the code owner they were added (consensual — they
    // shared their code with the caller). A failure here must NEVER surface as
    // a link error; the link itself already succeeded.
    try {
      await personsDb.notifyContactLinked(profileId);
    } catch (err) {
      console.error('notifyContactLinked failed (non-fatal)', err);
    }
  },

  unlinkFromProfile: async (personId) => {
    await personsDb.setLinkedProfileId(personId, null);
    set((s) => ({
      persons: s.persons.map((p) => (p.id === personId ? { ...p, linkedProfileId: null } : p)),
    }));
  },

  updatePhone: async (personId, phone) => {
    const next = phone && phone.trim() ? phone.trim() : null;
    await personsDb.setPhone(personId, next);
    set((s) => ({
      persons: s.persons.map((p) => (p.id === personId ? { ...p, phone: next } : p)),
    }));
  },

  archiveIfSettled: async (personId) => {
    const result = await personsDb.archiveIfSettled(personId);
    if (result.success) {
      set((s) => ({ persons: s.persons.filter((p) => p.id !== personId) }));
    }
    return result;
  },

  mergePerson: async (sourceId, targetId) => {
    const result = await personsDb.merge(sourceId, targetId);
    if (result.success) {
      // The source is archived server-side; a phone may have been copied to
      // the target — refetch rather than patch.
      const persons = await personsDb.getAll();
      set({ persons });
    }
    return result;
  },

  unarchive: async (personId) => {
    const ok = await personsDb.unarchive(personId);
    if (ok) {
      const persons = await personsDb.getAll();
      set({ persons });
    }
    return ok;
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
