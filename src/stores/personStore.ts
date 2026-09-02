import { create } from 'zustand';
import { v4 as uuid } from 'uuid';
import { personsDb } from '../lib/supabaseDb';
import type { ArchiveContactResult, MergePersonResult } from '../lib/supabaseDb';
import { normalizePublicCode, recordCodeLookupCharge } from '../lib/collaboration';
import {
  linkStatusMessageKey,
  type ContactLinkFailureStatus,
  type ContactLinkState,
} from '../lib/contactLinkStatus';
import type { I18nKey } from '../lib/i18n';
import type { Person } from '../db';

interface PersonState {
  persons: Person[];
  loading: boolean;
  loadPersons: () => Promise<void>;
  getPersons: () => Person[];
  createPerson: (name: string, phone?: string | null) => Promise<Person>;
  findOrCreateByName: (name: string) => Promise<Person>;
  /** Link a contact to the Hisaab account that owns `rawCode`. The server
   *  verifies the code — `fallback` is only used against a database that
   *  hasn't had the consent-guard migration applied yet. Throws
   *  ContactLinkError (or its DuplicateLinkedContactError subclass). */
  linkToProfile: (
    personId: string,
    rawCode: string,
    fallback?: { profileId: string; displayName: string } | null,
  ) => Promise<{ profileId: string; displayName: string; linkState: ContactLinkState }>;
  /** Code-less link (phone-discovery hit). A real path again: the server
   *  re-derives the phone match itself (link_contact_by_discovery), so the
   *  profile id the badge produced is a claim to be checked, not a credential.
   *  Same outcomes as linkToProfile; a stale badge answers NO_MATCH. Throws
   *  ContactLinkError (or DuplicateLinkedContactError). */
  linkToDiscoveredProfile: (
    personId: string,
    profileId: string,
    displayName: string,
  ) => Promise<{ profileId: string; displayName: string; linkState: ContactLinkState }>;
  unlinkFromProfile: (personId: string) => Promise<void>;
  updatePhone: (personId: string, phone: string | null) => Promise<void>;
  archiveIfSettled: (personId: string) => Promise<ArchiveContactResult>;
  // Server-side atomic merge of a LOCAL duplicate into another contact.
  // Loans/transactions reloads are the CALLER's job (cross-store).
  mergePerson: (sourceId: string, targetId: string) => Promise<MergePersonResult>;
  unarchive: (personId: string) => Promise<boolean>;
  reset: () => void;
}

// Any non-'ok' outcome from link_contact_by_code / unlink_contact_profile.
// Carries the status so the UI can pick its own copy, plus the ready-made
// i18n key for the common case.
export class ContactLinkError extends Error {
  readonly status: ContactLinkFailureStatus;
  readonly messageKey: I18nKey;
  readonly retryAfterSeconds?: number;

  constructor(status: ContactLinkFailureStatus, retryAfterSeconds?: number) {
    super(status);
    this.name = 'ContactLinkError';
    this.status = status;
    this.messageKey = linkStatusMessageKey(status);
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

// Thrown when a link would collide with the unique (user_id, linked_profile_id)
// index — i.e. the user already linked another of their contacts to the same
// other user. Its own class because callers name the colliding contact.
// Post-migration this arrives as a DUPLICATE_LINKED_CONTACT status rather than
// a raw PostgREST 23505.
export class DuplicateLinkedContactError extends ContactLinkError {
  constructor() {
    super('DUPLICATE_LINKED_CONTACT');
    this.name = 'DuplicateLinkedContactError';
  }
}

// Same normalisation the lookup uses (strip HSB-/@/hyphens, uppercase) — the
// server matches on `public_code_normalized` and shape-checks length 6.
// Already-normalised input is passed through untouched: normalizePublicCode
// strips a leading "HSB", and "HSB" is spellable in the code alphabet, so a
// second pass over a bare code like "HSBK47" would eat three real characters.
const NORMALISED_CODE = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/;

function normaliseEnteredCode(rawCode: string): string {
  const upper = (rawCode ?? '').trim().toUpperCase();
  return NORMALISED_CODE.test(upper) ? upper : normalizePublicCode(rawCode ?? '');
}

// Outcomes that actually cost a slot in the shared code_lookup_attempts window.
// Since the "double charge" fix, link_contact_by_code charges ONLY when the
// code fails to resolve: the preview lookup already spent one on the same code,
// and a code that resolves is the answer rather than a guess. So a resolved
// code — success, self, already-linked, duplicate — costs nothing here, and
// only NO_MATCH does. Keep this in step with the NO_MATCH branch of
// link_contact_by_code; over-counting would show a phantom "rate limited".
const CHARGED_LINK_STATUSES = new Set<string>(['NO_MATCH']);

function linkErrorFor(status: ContactLinkFailureStatus, retryAfterSeconds?: number): ContactLinkError {
  return status === 'DUPLICATE_LINKED_CONTACT'
    ? new DuplicateLinkedContactError()
    : new ContactLinkError(status, retryAfterSeconds);
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

  // The code — not a resolved uuid — is what crosses the wire now: only the
  // server may decide which account a code belongs to (audit 2026-09 C6/H2).
  // The other side is asked, never forced: the RPC calls notify_contact_linked
  // itself, so there is no client-side notify here any more.
  linkToProfile: async (personId, rawCode, fallback) => {
    const normalised = normaliseEnteredCode(rawCode);
    if (normalised.length !== 6) throw new ContactLinkError('INVALID_CODE');
    const result = await personsDb.linkByCode(personId, normalised, fallback ?? null);
    // The RPC shares the 20/hour code_lookup_attempts window with the preview
    // lookup, but only charges once it actually resolves the code — so mirror
    // the charge for exactly those outcomes (never for a throttled call).
    if (CHARGED_LINK_STATUSES.has(result.status)) recordCodeLookupCharge();
    if (result.status !== 'ok') throw linkErrorFor(result.status, result.retryAfterSeconds);
    set((s) => ({
      persons: s.persons.map((p) =>
        p.id === personId ? { ...p, linkedProfileId: result.profileId } : p,
      ),
    }));
    return { profileId: result.profileId, displayName: result.displayName, linkState: result.linkState };
  },

  // No recordCodeLookupCharge here, on purpose: this path is metered against
  // phone_lookup_attempts (the discovery budget), not the code window, and
  // there is no client-side mirror of that one — phoneDiscoveryStore just stops
  // asking once the server says it has had enough.
  linkToDiscoveredProfile: async (personId, profileId, displayName) => {
    const result = await personsDb.linkByProfileId(personId, profileId, displayName);
    if (result.status !== 'ok') throw linkErrorFor(result.status, result.retryAfterSeconds);
    set((s) => ({
      persons: s.persons.map((p) =>
        p.id === personId ? { ...p, linkedProfileId: result.profileId } : p,
      ),
    }));
    return { profileId: result.profileId, displayName: result.displayName, linkState: result.linkState };
  },

  unlinkFromProfile: async (personId) => {
    const result = await personsDb.unlinkProfile(personId);
    if (result.status !== 'ok') throw linkErrorFor(result.status, result.retryAfterSeconds);
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
