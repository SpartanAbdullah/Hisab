import { create } from 'zustand';
import { phoneDiscoveryDb, type PhoneMatch } from '../lib/supabaseDb';
import { toE164Candidates } from '../lib/phoneIdentity';
import { reportError } from '../lib/errorReporter';

// "This contact is already on Hisaab."
//
// The privacy-preserving half of contact discovery: no address-book access,
// no permission prompt, no upload of numbers the user didn't already save
// themselves. We only ever ask about numbers the user typed into Hisaab, and
// only users who explicitly opted in are discoverable.
//
// The server rate-limits to 20 lookups/hour, so this store is built around
// NOT wasting calls: every number resolves at most once per session (a miss
// is cached as firmly as a hit), lookups batch up to the server's 60-number
// ceiling, and hitting the limit disables the feature for the session rather
// than retry-looping into a wall.
const BATCH_SIZE = 60;

interface PhoneDiscoveryState {
  /** E.164 → match, or null for "checked, not a Hisaab user". */
  results: Record<string, PhoneMatch | null>;
  /** True once the server has told us to back off. */
  exhausted: boolean;
  /** Look up any of these raw phone strings we haven't resolved yet. */
  discover: (rawPhones: Array<string | null | undefined>) => Promise<void>;
  /** Synchronous read for a raw (unnormalised) phone string. */
  matchFor: (rawPhone: string | null | undefined) => PhoneMatch | null;
  /** True when every candidate for this input has been checked. Lets the UI
   *  distinguish "not on Hisaab" from "we haven't looked yet". */
  isResolved: (rawPhone: string | null | undefined) => boolean;
  reset: () => void;
}

const INITIAL_STATE = {
  results: {} as Record<string, PhoneMatch | null>,
  exhausted: false,
};

// In-flight numbers, so two components mounting at once don't each fire a
// lookup for the same contact list.
const inflight = new Set<string>();

/** Pure lookup against an already-subscribed results map. Components that
 *  render below an early return (no hooks available) use this so the value
 *  is derived from the same snapshot React re-rendered them with — calling
 *  a store method there would read a fresher snapshot than the render. */
export function findPhoneMatch(
  results: Record<string, PhoneMatch | null>,
  rawPhone: string | null | undefined,
): PhoneMatch | null {
  for (const candidate of toE164Candidates(rawPhone)) {
    const hit = results[candidate];
    if (hit) return hit;
  }
  return null;
}

export const usePhoneDiscoveryStore = create<PhoneDiscoveryState>((set, get) => ({
  ...INITIAL_STATE,

  reset: () => {
    inflight.clear();
    set({ results: {}, exhausted: false });
  },

  matchFor: (rawPhone) => {
    const { results } = get();
    for (const candidate of toE164Candidates(rawPhone)) {
      const hit = results[candidate];
      if (hit) return hit;
    }
    return null;
  },

  isResolved: (rawPhone) => {
    const candidates = toE164Candidates(rawPhone);
    if (candidates.length === 0) return true; // nothing to look up
    const { results } = get();
    return candidates.every((c) => c in results);
  },

  discover: async (rawPhones) => {
    if (get().exhausted) return;

    const wanted = new Set<string>();
    const { results } = get();
    for (const raw of rawPhones) {
      for (const candidate of toE164Candidates(raw)) {
        if (candidate in results) continue;
        if (inflight.has(candidate)) continue;
        wanted.add(candidate);
      }
    }
    if (wanted.size === 0) return;

    const numbers = [...wanted];
    numbers.forEach((n) => inflight.add(n));
    try {
      for (let i = 0; i < numbers.length; i += BATCH_SIZE) {
        const batch = numbers.slice(i, i + BATCH_SIZE);
        const matches = await phoneDiscoveryDb.lookup(batch);
        const byNumber = new Map(matches.map((m) => [m.phoneE164, m]));
        set((s) => {
          const next = { ...s.results };
          // Record misses too — an unresolved number must never be asked
          // about again this session, or a 40-contact list would eat the
          // hourly budget in two page visits.
          for (const number of batch) next[number] = byNumber.get(number) ?? null;
          return { results: next };
        });
      }
    } catch (err) {
      // Rate limit, missing RPC (migration not applied yet), or offline.
      // All of them mean the same thing to the UI: stop asking. The badge
      // simply doesn't appear — nothing else in the app depends on it.
      reportError(err, {
        feature: 'phoneDiscoveryStore.lookup',
        level: 'warning',
        extra: { batchSize: numbers.length },
      });
      set({ exhausted: true });
    } finally {
      numbers.forEach((n) => inflight.delete(n));
    }
  },
}));
