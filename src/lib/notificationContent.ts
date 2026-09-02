// Renders a persisted notification row into display text.
//
// Group notifications used to be composed on the ACTOR's device and frozen as
// English `title`/`body` at write time (splitStore's fanOutGroupUpdate) — which
// meant (a) any co-member could write whatever text they liked into your Inbox
// and your push tray (audit 05-security.md H5), and (b) an Urdu-default app
// shipped its highest-traffic cross-user surface in English only (audit
// 08-notifications.md N-1).
//
// Server triggers now write a `template` key plus structured `params`
// (supabase-migration-audit-p0-notifications.sql) alongside a server-composed
// English `title`/`body`. This module turns template+params into localized
// copy; the stored title/body remain the fallback for legacy rows, for
// templates a newer server knows and this client doesn't, and for the FCM push
// pipeline (which renders server text verbatim and cannot run this code).
//
// Pure: no store reads, no DOM. The translator is injected so both the React
// (useT) and non-React (tStatic) callers work, and so it is unit-testable.

import type { I18nKey } from './i18n';
import { formatMoney } from './constants';

export interface NotificationContentInput {
  template?: string | null;
  params?: Record<string, unknown> | null;
  title?: string | null;
  body?: string | null;
}

export interface NotificationContent {
  title: string;
  body: string;
}

export type NotificationTranslate = (key: I18nKey) => string;

// Must stay in step with the catalog in
// supabase-migration-audit-p0-notifications.sql (SECTION 3).
const TITLE_KEYS: Record<string, I18nKey> = {
  group_added: 'ntf_group_added_title',
  member_joined: 'ntf_member_joined_title',
  expense_added: 'ntf_expense_added_title',
  expense_updated: 'ntf_expense_updated_title',
  expense_deleted: 'ntf_expense_deleted_title',
  settlement_added: 'ntf_settlement_added_title',
  settlement_deleted: 'ntf_settlement_deleted_title',
  // notify_group_archive_state, supabase-migration-audit-p0-group-deletion-
  // guard.sql §6a. Params: { groupId, groupName, currency, actorName }.
  group_archived: 'ntf_group_archived_title',
  group_unarchived: 'ntf_group_unarchived_title',
};

const BODY_KEYS: Record<string, I18nKey> = {
  group_added: 'ntf_group_added_body',
  member_joined: 'ntf_member_joined_body',
  expense_added: 'ntf_expense_added_body',
  expense_updated: 'ntf_expense_updated_body',
  expense_deleted: 'ntf_expense_deleted_body',
  settlement_added: 'ntf_settlement_added_body',
  settlement_deleted: 'ntf_settlement_deleted_body',
  group_archived: 'ntf_group_archived_body',
  group_unarchived: 'ntf_group_unarchived_body',
};

// Amount is optional on the money templates: an expense whose params predate
// the amount field, or a settlement written by an older trigger, must still
// read as a sentence rather than "… for  was added".
const BODY_KEYS_NO_AMOUNT: Record<string, I18nKey> = {
  expense_added: 'ntf_expense_added_body_plain',
  settlement_added: 'ntf_settlement_added_body_plain',
};

function text(params: Record<string, unknown>, key: string): string {
  const value = params[key];
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return '';
}

/** Numeric params arrive as JSON numbers, but a jsonb round-trip can hand
 *  back a string ("250.50") — accept both, reject anything else. */
export function readAmount(params: Record<string, unknown>): number | null {
  const raw = params.amount;
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN;
  return Number.isFinite(n) ? n : null;
}

function fill(template: string, vars: Record<string, string>): string {
  let out = template;
  for (const [key, value] of Object.entries(vars)) {
    out = out.split(`{${key}}`).join(value);
  }
  return out;
}

/** Render one notification's title + body, localized when possible. */
export function renderNotificationContent(
  n: NotificationContentInput,
  t: NotificationTranslate,
): NotificationContent {
  const stored: NotificationContent = {
    title: (n.title ?? '').trim(),
    body: (n.body ?? '').trim(),
  };

  const template = typeof n.template === 'string' ? n.template.trim() : '';
  // No template (legacy row, or a linked-request/contact-link row written by
  // an older trigger) → the server text is all there is.
  if (!template) return stored;

  const titleKey = TITLE_KEYS[template];
  if (!titleKey) return stored;

  const params: Record<string, unknown> =
    n.params && typeof n.params === 'object' && !Array.isArray(n.params)
      ? (n.params as Record<string, unknown>)
      : {};

  const amount = readAmount(params);
  const currency = text(params, 'currency');
  const vars: Record<string, string> = {
    actor: text(params, 'actorName') || t('ntf_someone'),
    group: text(params, 'groupName') || t('ntf_the_group'),
    desc: text(params, 'description') || t('ntf_an_expense'),
    from: text(params, 'fromName') || t('ntf_someone'),
    to: text(params, 'toName') || t('ntf_someone'),
    amount: amount === null ? '' : formatMoney(amount, currency || 'PKR'),
  };

  const bodyKey = amount === null && BODY_KEYS_NO_AMOUNT[template]
    ? BODY_KEYS_NO_AMOUNT[template]
    : BODY_KEYS[template];

  const title = fill(t(titleKey), vars).trim();
  const body = bodyKey ? fill(t(bodyKey), vars).trim() : '';

  // Never render an empty card: a missing translation falls back to whatever
  // the server composed.
  if (!title) return stored;
  return { title, body: body || stored.body };
}

/** Where a notification should land when tapped. Group rows deep-link to the
 *  group itself (the audit's N-8: everything used to dump the user at the top
 *  of /groups and make them hunt). */
export function notificationHref(n: {
  type?: string | null;
  groupId?: string | null;
}): string {
  if (n.type === 'group_update' && n.groupId) return `/group/${n.groupId}`;
  // 'invite' rows are written by tg_group_members_notify_invited
  // (supabase-migration-audit-p0-consent-guards.sql §2.4) and DO carry a
  // group_id — but the recipient is only 'invited', so is_group_member() fails
  // and RLS hides that group row entirely. Deep-linking to /group/:id would
  // land them on a permanent "Loading…". The Groups tab is where the
  // Accept/Decline card lives, so that is the only correct destination.
  if (n.type === 'group_update' || n.type === 'invite') return '/groups';
  return '/inbox';
}
