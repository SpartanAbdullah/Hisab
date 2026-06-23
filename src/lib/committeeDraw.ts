// Provably-fair committee draw (commit-reveal).
//
// 1. The organizer generates a random SEED and the draw publishes a SHA-256
//    COMMITMENT (hash) of it. Because the order is derived deterministically
//    from the seed, and the commitment is fixed before anyone sees the result,
//    the organizer cannot rig the outcome after the fact.
// 2. The seed is revealed (stored alongside the committee). ANY member — even a
//    non-app relative on the witness link — can recompute hash(seed) and the
//    shuffle on their own device and prove the order wasn't manipulated.
//
// The shuffle uses well-known small PRNGs (xmur3 seed + mulberry32) so it is
// fully deterministic and portable. drawOrder sorts the ids first so the input
// is canonical regardless of array order — draw and verify always agree.

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

export function seededShuffle<T>(items: readonly T[], seed: string): T[] {
  const rng = mulberry32(xmur3(seed)());
  const arr = [...items];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// Canonical draw order from a seed — sorts the ids first so the input is fixed.
export function drawOrder(memberIds: readonly string[], seed: string): string[] {
  return seededShuffle([...memberIds].sort(), seed);
}

// A random 128-bit hex seed.
export function generateSeed(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// SHA-256 hex of the seed — the public commitment.
export async function commitmentFor(seed: string): Promise<string> {
  const data = new TextEncoder().encode(seed);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Recompute and confirm: the commitment matches the seed AND the stored order
// matches the seeded shuffle. Returns false if anything was tampered with.
export async function verifyDraw(
  memberIds: readonly string[],
  seed: string,
  commitment: string,
  storedOrder: readonly string[],
): Promise<boolean> {
  const expectedCommitment = await commitmentFor(seed);
  if (expectedCommitment !== commitment) return false;
  const order = drawOrder(memberIds, seed);
  return order.length === storedOrder.length && order.every((id, i) => id === storedOrder[i]);
}
