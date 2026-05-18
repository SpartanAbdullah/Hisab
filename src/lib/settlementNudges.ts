// Settlement nudges: surface outgoing pending settlement requests that have
// been sitting unanswered for >= NUDGE_AFTER_DAYS. Pure read over existing
// data; no new schema. Snoozes live in localStorage so they don't bloat
// Supabase with per-user UI state.
//
// The user can dismiss a nudge for 24h; after that it returns. This is
// intentional — a forgotten settlement is a real money problem, not a
// notification we want to silence forever.

import type { SettlementRequest, Person } from '../db';

const NUDGE_AFTER_DAYS = 3;
const SNOOZE_DURATION_MS = 24 * 60 * 60 * 1000;
const SNOOZE_KEY = 'hisaab_settlement_snoozes_v1';

export interface SettlementNudge {
  request: SettlementRequest;
  daysOpen: number;
  // Display name resolved via the person record if available, otherwise
  // a generic "Someone in your network" so we never expose raw uuids.
  recipientLabel: string;
  // Optional WhatsApp link — populated only when we know the person's phone.
  whatsappUrl: string | null;
}

function loadSnoozes(): Record<string, number> {
  try {
    const raw = localStorage.getItem(SNOOZE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, number>;
    const now = Date.now();
    // Garbage-collect expired entries so the blob doesn't grow forever.
    const live: Record<string, number> = {};
    for (const [id, expiry] of Object.entries(parsed)) {
      if (typeof expiry === 'number' && expiry > now) live[id] = expiry;
    }
    return live;
  } catch {
    return {};
  }
}

function saveSnoozes(map: Record<string, number>): void {
  try {
    localStorage.setItem(SNOOZE_KEY, JSON.stringify(map));
  } catch {
    // localStorage full / disabled — banners just keep showing. Acceptable.
  }
}

export function snoozeNudge(requestId: string): void {
  const map = loadSnoozes();
  map[requestId] = Date.now() + SNOOZE_DURATION_MS;
  saveSnoozes(map);
}

export function isSnoozed(requestId: string): boolean {
  const map = loadSnoozes();
  const expiry = map[requestId];
  return typeof expiry === 'number' && expiry > Date.now();
}

// Build the list of nudges that should currently surface. Returns at most
// `limit` to avoid drowning the UI; the user can open Inbox for the full
// view. `persons` is optional — used only to enrich labels and phone deeplinks.
export function getOverdueSettlements(
  outgoingPending: readonly SettlementRequest[],
  persons: readonly Person[] = [],
  limit = 3,
): SettlementNudge[] {
  const now = Date.now();
  const snoozes = loadSnoozes();
  const dayMs = 1000 * 60 * 60 * 24;
  const personByLinkedProfile = new Map<string, Person>();
  for (const p of persons) {
    if (p.linkedProfileId) personByLinkedProfile.set(p.linkedProfileId, p);
  }
  const nudges: SettlementNudge[] = [];
  for (const r of outgoingPending) {
    const daysOpen = Math.floor((now - new Date(r.createdAt).getTime()) / dayMs);
    if (daysOpen < NUDGE_AFTER_DAYS) continue;
    const snoozedUntil = snoozes[r.id];
    if (typeof snoozedUntil === 'number' && snoozedUntil > now) continue;
    const linkedPerson = personByLinkedProfile.get(r.toUserId);
    const recipientLabel = linkedPerson?.name ?? 'Someone in your network';
    const whatsappUrl = linkedPerson?.phone
      ? buildWhatsAppNudgeUrl(linkedPerson.phone, recipientLabel, r)
      : null;
    nudges.push({ request: r, daysOpen, recipientLabel, whatsappUrl });
  }
  // Oldest first — most overdue gets attention first.
  nudges.sort((a, b) => b.daysOpen - a.daysOpen);
  return nudges.slice(0, limit);
}

function buildWhatsAppNudgeUrl(phone: string, recipientName: string, r: SettlementRequest): string {
  const cleanedPhone = phone.replace(/[^\d+]/g, '');
  const number = cleanedPhone.replace(/^\+/, '');
  // Light, polite. The amount is intentionally last so the message reads
  // less like a debt-collection notice and more like a friendly check-in.
  const lines = [
    `Salam ${recipientName},`,
    '',
    `Hisaab par maine ek settlement request bheji thi — ${r.currency} ${r.amount.toLocaleString()}.`,
    'Jab time mile, accept kar dena. Shukriya \u{1F642}',
  ];
  const text = encodeURIComponent(lines.join('\n'));
  return `https://wa.me/${number}?text=${text}`;
}
