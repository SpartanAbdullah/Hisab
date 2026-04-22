import { usePersonStore } from '../stores/personStore';

// Presentational-only helper. Returns the canonical persons.name for a given
// personId if the person exists in the current store snapshot; otherwise
// returns the fallback string. Used on read-only display surfaces so that
// a future rename flow (Phase 2+) cascades through history without touching
// individual loan/transaction rows.
//
// Note: pure function over the latest store snapshot. Components calling it
// will not re-render on person mutations; that's acceptable here because
// Phase 1B-B has no rename path. When renames land, call sites should switch
// to a subscription-based form.
export function resolvePersonName({
  personId,
  fallback,
}: {
  personId?: string | null;
  fallback?: string | null;
}): string {
  if (personId) {
    const match = usePersonStore.getState().persons.find((p) => p.id === personId);
    if (match?.name) return match.name;
  }
  return (fallback ?? '').toString();
}
