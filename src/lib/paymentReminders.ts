export type PaymentReminderDirection = 'receivable' | 'payable';
export type PaymentReminderTone = 'friendly' | 'neutral' | 'formal';

export interface ReminderAge {
  days: number | null;
  isOverdue: boolean;
}

export interface ReminderTemplateInput {
  name: string;
  amount: string;
  duration: string;
  direction: PaymentReminderDirection;
  tone: PaymentReminderTone;
}

export type ReminderTemplateMap = Record<PaymentReminderDirection, Record<PaymentReminderTone, string>>;

const DAY_MS = 24 * 60 * 60 * 1000;

export function getReminderAge(dateString?: string | null): ReminderAge {
  if (!dateString) return { days: null, isOverdue: false };
  const timestamp = Date.parse(dateString);
  if (Number.isNaN(timestamp)) return { days: null, isOverdue: false };

  const days = Math.max(0, Math.floor((Date.now() - timestamp) / DAY_MS));
  return { days, isOverdue: days > 7 };
}

export function getOldestIsoDate(dates: Array<string | null | undefined>): string | null {
  let oldest: string | null = null;
  let oldestTime = Number.POSITIVE_INFINITY;

  for (const date of dates) {
    if (!date) continue;
    const time = Date.parse(date);
    if (Number.isNaN(time)) continue;
    if (time < oldestTime) {
      oldestTime = time;
      oldest = date;
    }
  }

  return oldest;
}

export function buildPaymentReminderMessage(input: ReminderTemplateInput, templates: ReminderTemplateMap): string {
  const template = templates[input.direction][input.tone];
  return template
    .replaceAll('{name}', input.name)
    .replaceAll('{amount}', input.amount)
    .replaceAll('{duration}', input.duration);
}
