// Catch the "both flatmates logged the same shared bill" double-count: when a
// new group expense matches a recently-added one (same description + amount,
// within a short window), warn the second person before it's counted twice.
// A soft warning, never a hard block — they might genuinely mean to add two.
// Pure + tested.

export interface DuplicateCandidate {
  description: string;
  amount: number;
}

export interface ExistingExpenseLike {
  id: string;
  description: string;
  amount: number;
  createdAt: string;
}

const DEFAULT_WINDOW_MS = 60 * 60 * 1000; // 1 hour

export function findRecentDuplicate(
  candidate: DuplicateCandidate,
  existing: ReadonlyArray<ExistingExpenseLike>,
  nowMs: number,
  windowMs: number = DEFAULT_WINDOW_MS,
): ExistingExpenseLike | null {
  const desc = candidate.description.trim().toLowerCase();
  if (!desc) return null; // don't flag blank-description entries
  for (const e of existing) {
    if (e.description.trim().toLowerCase() !== desc) continue;
    if (Math.abs(e.amount - candidate.amount) > 0.01) continue;
    const t = Date.parse(e.createdAt);
    if (Number.isFinite(t) && Math.abs(nowMs - t) <= windowMs) return e;
  }
  return null;
}
