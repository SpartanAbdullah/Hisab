// Guard against a recurring template whose start date is a typo — years off,
// or far enough in the past that it fires retroactive entries the user didn't
// expect. Gentle: only a clearly-retroactive date warns, an absurd one blocks,
// and a recent/near date passes silently (a start "yesterday" is normal). Pure.

export interface RecurringStartCheck {
  ok: boolean; // true = proceed silently
  severity?: 'warn' | 'block';
  reason?: string;
}

const DAY = 86_400_000;

function toUTC(iso: string): number {
  return Date.parse(`${(iso ?? '').slice(0, 10)}T00:00:00Z`);
}

export function validateRecurringStart(nextDueDate: string, todayIso: string): RecurringStartCheck {
  const due = toUTC(nextDueDate);
  const today = toUTC(todayIso);
  if (!Number.isFinite(due) || !Number.isFinite(today)) {
    return { ok: false, severity: 'block', reason: 'Pick a valid start date.' };
  }
  const days = Math.round((due - today) / DAY);

  if (days < -730) {
    return { ok: false, severity: 'block', reason: 'That start date is years in the past — please pick a recent or future date.' };
  }
  if (days > 730) {
    return { ok: false, severity: 'block', reason: 'That start date is years away — please double-check.' };
  }
  if (days < -7) {
    return {
      ok: false,
      severity: 'warn',
      reason: `That date is ${Math.abs(days)} days in the past, so the first one is due right away. Use it anyway?`,
    };
  }
  return { ok: true };
}
