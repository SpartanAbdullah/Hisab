// Canonical local-calendar-date helpers. Every surface that turns a Date (or
// a full ISO timestamp) into a DAY or MONTH key — "today", a transaction's
// spend-day bucket, a streak boundary, a recurring due-date comparison —
// must go through here, never through `toISOString()`.
//
// Why this file exists (audit F-11 / F-18, docs/audit-2026-09/12-qa-review.md
// §4.4): `toISOString()` always renders the UTC calendar day. Hisaab's
// markets sit at UTC+4 (Gulf) / UTC+5 (Pakistan) with no DST, so anything
// between local midnight and ~4-5am is still "yesterday" in UTC — a
// recurring bill due at 00:30 local reads as not-yet-due, a 11pm expense
// buckets into the wrong day of a monthly wrap, a logging streak breaks one
// day early. `localIso`/`localMonthIso` read the Date's LOCAL (device)
// calendar fields instead, which is what every consumer actually wants.
//
// Originally lived inline in thisWeek.ts (and duplicated again in
// cardStatement.ts to dodge an import cycle) — consolidated here so there is
// exactly one implementation. thisWeek.ts re-exports `localIso` for existing
// importers.

/** Local calendar date as YYYY-MM-DD, from the Date's own (device) fields —
 *  never from `toISOString()`, which is always UTC. */
export function localIso(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Local calendar month as YYYY-MM, from the Date's own (device) fields —
 *  the month-key counterpart to `localIso`, for "this month" groupings
 *  (spend summaries, flex budget, recurring-due month roll-forward). */
export function localMonthIso(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}
