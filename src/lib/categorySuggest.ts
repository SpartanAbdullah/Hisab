// Learn-from-your-history category suggestion.
//
// This is the answer to "don't hardcode karak": instead of a baked-in keyword
// list being the brain, we look at how THIS user has categorised similar things
// before. "Karak" lands in Food because you logged karak as Food last week —
// not because we hardcoded it. Every confirmed expense becomes history, so the
// app gets smarter about *your* world automatically, on-device, no training.
//
// A tiny seed map (in the parser) stays only as a cold-start fallback for brand
// new users; the user's own history always wins. Pure + tested.

export interface HistoryTxn {
  type: string; // 'income' | 'expense' | ...
  notes?: string | null;
  category?: string | null;
}

function words(text: string): string[] {
  return (text ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 3);
}

/**
 * Suggest a category for `text` (the merchant/label) by matching it against the
 * user's past transactions of the same direction and returning the category
 * they used most often for similar wording. Returns null when nothing matches.
 */
export function suggestCategory(
  text: string,
  history: ReadonlyArray<HistoryTxn>,
  direction: 'income' | 'expense',
): string | null {
  const target = new Set(words(text));
  if (target.size === 0) return null;

  const counts = new Map<string, number>();
  for (const h of history) {
    if (h.type !== direction || !h.category) continue;
    const hWords = words(h.notes ?? '');
    if (hWords.length === 0) continue;
    // Shared significant word → the same kind of thing.
    if (hWords.some((w) => target.has(w))) {
      counts.set(h.category, (counts.get(h.category) ?? 0) + 1);
    }
  }
  if (counts.size === 0) return null;

  // Most frequently-used category for this wording wins; ties keep the first.
  let best: string | null = null;
  let bestCount = 0;
  for (const [cat, n] of counts) {
    if (n > bestCount) {
      best = cat;
      bestCount = n;
    }
  }
  return best;
}
