// Gentle logging streak: how many consecutive days (ending today, or
// yesterday if you haven't logged yet today) you've recorded at least one
// expense. Pure + tested. The UI shows it ONLY as encouragement — never to
// shame — per the "streaks can feel annoying if misrepresented" rule.

export interface StreakResult {
  streak: number;
  loggedToday: boolean;
}

function dayOf(iso: string): string {
  return (iso ?? '').slice(0, 10);
}

function shiftDay(dayIso: string, delta: number): string {
  const d = new Date(`${dayIso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

/**
 * @param createdAts ISO timestamps of logged expenses (any order, dups fine).
 * @param todayIso   today's date (ISO or YYYY-MM-DD).
 */
export function computeLoggingStreak(createdAts: string[], todayIso: string): StreakResult {
  const today = dayOf(todayIso);
  const days = new Set(createdAts.map(dayOf).filter(Boolean));
  const loggedToday = days.has(today);

  // Anchor the streak at today (if logged) or yesterday (so a not-yet-logged
  // today doesn't break a run you're about to continue). Otherwise it's broken.
  let anchor: string | null = null;
  if (loggedToday) anchor = today;
  else if (days.has(shiftDay(today, -1))) anchor = shiftDay(today, -1);

  if (!anchor) return { streak: 0, loggedToday };

  let streak = 0;
  let cursor = anchor;
  while (days.has(cursor)) {
    streak += 1;
    cursor = shiftDay(cursor, -1);
  }
  return { streak, loggedToday };
}
