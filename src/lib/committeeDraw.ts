// Provably-fair committee (kameti) draw — VERIFICATION side.
//
// The draw itself is NOT performed here any more. Audit 2026-09 item M10 /
// F-13: while the seed, the commitment and the slot order were all produced by
// the organiser's own device and written in one plain UPDATE, the organiser
// could re-roll locally until slot 1 suited them and then persist the matching
// (seed, commitment, order) triple. Every witness verification still passed, so
// "provably fair" was a marketing claim, not a property.
//
// The draw now happens inside the `perform_committee_draw` SECURITY DEFINER RPC
// (supabase-migration-audit-p0-kameti-draw.sql): the SEED comes from server
// entropy the organiser never controls, a `drawn_at IS NULL` guard makes a
// second call fail with ALREADY_DRAWN, and triggers make draw_seed /
// draw_commitment / drawn_at / the member slots immutable afterwards.
//
// What stays on the client is the part that must be reproducible by anyone:
// recomputing the order from the published seed. Any member — even a non-app
// relative on the witness link, or a sceptic with nothing but a sha256 tool —
// can rebuild the exact same order and confirm nothing was changed.
//
// ── DETERMINISM SCHEME: "sha256-rank-v1" ───────────────────────────────────
//
//   rank(id) = sha256_hex(seed || ':' || member_id)
//   order    = every member id sorted by rank ASCENDING, ties broken by
//              member_id ASCENDING, both compared as plain byte strings
//              (JS string `<` on lowercase hex == Postgres `collate "C"`).
//   slot(id) = index in that order + 1
//
// It replaces the previous xmur3 + mulberry32 Fisher-Yates shuffle. That PRNG
// was fine but could not be faithfully re-implemented in plpgsql without
// hand-rolling 32-bit `Math.imul` semantics — and a server draw the client
// cannot reproduce byte-for-byte is worse than no server draw at all. A single
// sha256 rank-sort is portable, needs no PRNG, and is verifiable with any
// off-the-shelf sha256 tool, which is the whole point of the feature.
//
// The commitment (sha256 of the seed) is kept as a tamper check on the stored
// seed itself; the server writes seed and commitment together in one
// transaction, so it is a seal, not a pre-draw commitment. See the migration
// header for why single-phase is sufficient once the server owns the entropy.

export const DRAW_SCHEME_VERSION = 'sha256-rank-v1';

function toHex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// SHA-256 hex of a UTF-8 string. Mirrors Postgres
// `encode(digest(x, 'sha256'), 'hex')` exactly.
export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return toHex(digest);
}

// The rank a member id gets under a given seed. Exported so the witness UI (and
// anyone reading the code) can show its work.
export function rankInput(seed: string, memberId: string): string {
  return `${seed}:${memberId}`;
}

// Canonical draw order from a seed. Pure, total, and independent of the input
// array's order — draw and verify always agree.
export async function drawOrder(memberIds: readonly string[], seed: string): Promise<string[]> {
  const ranked = await Promise.all(
    memberIds.map(async (id) => ({ id, rank: await sha256Hex(rankInput(seed, id)) })),
  );
  ranked.sort((a, b) => (a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return ranked.map((r) => r.id);
}

// A random 128-bit hex string. NO LONGER used for draw seeds (the server owns
// that entropy) — kept for the witness share token, which is a capability, not
// a fairness input.
export function generateSeed(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// SHA-256 hex of the seed — the published seal.
export async function commitmentFor(seed: string): Promise<string> {
  return sha256Hex(seed);
}

// ── LEGACY scheme "mulberry32-shuffle-v0" — VERIFY ONLY, never draw ────────
//
// Draws recorded by builds shipped BEFORE the audit-p0-kameti-draw migration
// used an xmur3-seeded mulberry32 Fisher-Yates over the sorted ids. Those rows
// still exist, and their stored order is internally consistent — so verifying
// them with v1 only would paint honest legacy records as "tampered". This
// fallback keeps them readable.
//
// It proves the stored order matches the stored seed. It does NOT prove the
// seed was fair: v0 seeds were generated on the organiser's device and could be
// re-rolled, which is exactly the hole M10 reported. Anything still on v0 is a
// pre-fix record; the migration backfills committees.draw_scheme so they can be
// listed and cleared. Never call this to CREATE a draw.
function xmur3(str: string): () => number {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return () => {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return (h ^= h >>> 16) >>> 0;
  };
}

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function legacyDrawOrderV0(memberIds: readonly string[], seed: string): string[] {
  const rng = mulberry32(xmur3(seed)());
  const arr = [...memberIds].sort();
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function sameOrder(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, i) => id === b[i]);
}

// Recompute and confirm: the commitment matches the seed AND the stored order
// matches the rank-sort (or the legacy v0 shuffle, for pre-fix records).
// Returns false if anything was tampered with.
export async function verifyDraw(
  memberIds: readonly string[],
  seed: string,
  commitment: string,
  storedOrder: readonly string[],
): Promise<boolean> {
  if (!seed || !commitment) return false;
  const expectedCommitment = await commitmentFor(seed);
  if (expectedCommitment !== commitment) return false;
  if (sameOrder(await drawOrder(memberIds, seed), storedOrder)) return true;
  return sameOrder(legacyDrawOrderV0(memberIds, seed), storedOrder);
}
