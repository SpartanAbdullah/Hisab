// Guest members — the pure half.
//
// A GUEST is a seat in a group with a name, no Hisaab account, and full ledger
// standing: they can hold split shares, they can be the payer, and a real member
// can record a settlement with them. Closes audit
// docs/audit-2026-09/11-competitive-analysis.md G6 / O4 (and July blocker B6):
// every Cluster A competitor lets a group contain people who never install the
// app, and Hisaab's group container required a Hisaab public code for everyone.
//
// ── The one rule everything here rests on ──────────────────────────────────
// `supabase-migration-p2-guest-members.sql` defines a guest as
//     profile_id IS NULL AND status <> 'left'
// and materialises exactly that as the generated column `group_members.is_guest`.
// `isGuestMember` below is that predicate, transliterated. The two must agree:
//   * `status <> 'left'` (rather than `= 'connected'`) is deliberate. A member
//     who deletes their Hisaab account has their seat anonymized to
//     profile_id NULL AND status 'left' (supabase-migration-audit-p0-account-
//     deletion.sql §4b) precisely so it is NOT claimable — reading that as a
//     guest would both mislabel it in the UI and invite a claim. It also keeps
//     LEGACY placeholders (the old status='guest' default, supabase-schema.sql)
//     labelled as guests, which is what they are.
//
// ── What a guest is NOT ────────────────────────────────────────────────────
// Not a lesser member. The status vocabulary answers exactly one question —
// "will this person see this in their own app?" — and for a guest the answer is
// no, which is why every settlement involving one is labelled "recorded on their
// behalf". They are also NOT a member in the ACCESS sense: `is_group_member()`
// requires a profile_id, so nothing can ever act AS a guest.
//
// Pure: no store, no supabase, no React. i18n is used only to map server status
// codes onto the copy the UI shows, the same way groupActiveMembers.ts does.

import { tStatic } from './i18n';
import type { GroupMember, SplitGroup } from '../db';

/** Hard limits, mirroring the constants in the SQL trigger + RPC. */
export const MAX_GROUP_GUESTS = 25;
export const MAX_GROUP_MEMBERS = 60;
/** `display_name` bound enforced by tg_group_members_guest_seat_rules. */
export const MAX_GUEST_NAME_LENGTH = 60;

/** The SQL `is_guest` predicate, client-side. Must not drift from it. */
export function isGuestMember(member: Pick<GroupMember, 'profileId' | 'status'>): boolean {
  return !member.profileId && member.status !== 'left';
}

export function getGuestMembers(group: Pick<SplitGroup, 'members'>): GroupMember[] {
  return group.members.filter(isGuestMember);
}

export function hasGuestMembers(group: Pick<SplitGroup, 'members'>): boolean {
  return group.members.some(isGuestMember);
}

/** True when either side of a settlement is a guest, i.e. the recording member
 *  is acting on someone else's behalf and the UI owes them that sentence. */
export function settlementIsOnBehalf(
  group: Pick<SplitGroup, 'members'>,
  fromMemberId: string,
  toMemberId: string,
): boolean {
  return group.members.some(
    (member) => (member.id === fromMemberId || member.id === toMemberId) && isGuestMember(member),
  );
}

/**
 * Local pre-flight for a typed guest name. The server is the authority
 * (tg_group_members_guest_seat_rules raises, add_group_guest returns a status);
 * this exists so the common mistakes are caught before a round-trip and so the
 * Add button can be disabled honestly.
 *
 * Duplicate detection is case- and whitespace-insensitive and scoped to LIVE
 * seats, exactly like the SQL: a departed member's old name is reusable. It
 * matters because wherever a profile is absent the app keys people by NAME
 * (`personId ?? lowercased trimmed name`, docs/who-owes-me.md §3 rule 3), so two
 * same-named seats would silently merge into one person's money later.
 */
export type GuestNameProblem = 'empty' | 'too_long' | 'duplicate' | null;

export function validateGuestName(
  rawName: string,
  existingMembers: ReadonlyArray<Pick<GroupMember, 'name' | 'status'>>,
  /** Names already staged in the form but not yet written (CreateGroupModal). */
  pendingNames: ReadonlyArray<string> = [],
): GuestNameProblem {
  const name = rawName.trim();
  if (!name) return 'empty';
  if (name.length > MAX_GUEST_NAME_LENGTH) return 'too_long';
  const key = name.toLocaleLowerCase();
  const taken = existingMembers
    .filter((member) => member.status !== 'left')
    .map((member) => member.name.trim().toLocaleLowerCase())
    .concat(pendingNames.map((pending) => pending.trim().toLocaleLowerCase()));
  return taken.includes(key) ? 'duplicate' : null;
}

export function guestNameProblemMessage(problem: Exclude<GuestNameProblem, null>): string {
  return problem === 'duplicate'
    ? tStatic('guest_err_duplicate_name')
    : tStatic('guest_err_invalid_name');
}

/**
 * Map an `add_group_guest` / `remove_group_guest` status object onto user copy.
 * Both RPCs return failures as DATA, never as exceptions (the repo-wide rule
 * from audit H1: a RAISE would roll back the ledger row the call already
 * committed), so this is the only place those codes are read.
 */
export function guestRpcFailureMessage(status: string | null | undefined): string {
  switch (status) {
    case 'INVALID_NAME':       return tStatic('guest_err_invalid_name');
    case 'DUPLICATE_NAME':     return tStatic('guest_err_duplicate_name');
    case 'TOO_MANY_GUESTS':
    case 'TOO_MANY_MEMBERS':   return tStatic('guest_err_too_many');
    case 'NOT_ACTIVE_MEMBER':  return tStatic('guest_err_not_member');
    case 'NOT_AUTHENTICATED':  return tStatic('guest_err_not_member');
    case 'GROUP_ARCHIVED':     return tStatic('guest_err_archived');
    case 'GUEST_HAS_LEDGER':   return tStatic('guest_err_has_ledger');
    case 'NOT_A_GUEST':        return tStatic('guest_err_has_ledger');
    case 'NOT_ALLOWED':        return tStatic('guest_err_not_allowed');
    default:                   return tStatic('guest_err_generic');
  }
}

/**
 * The WhatsApp body for "invite them to Hisaab".
 *
 * Note what is NOT here: the guest's phone number. `add_group_guest` stores it
 * only as a SHA-256 digest in `group_guest_identities`, a table no client role
 * can read (not even the member who typed it), so the share always opens
 * WhatsApp's contact picker rather than a pre-addressed chat. That is a
 * deliberate trade: the number buys the later auto-claim, and the person who
 * typed it already has it in their own phone.
 */
export function buildGuestInviteText(guestName: string, groupName: string, url: string): string {
  return tStatic('guest_invite_share_text')
    .replace('{name}', guestName.trim() || '')
    .replace('{group}', groupName)
    .replace('{url}', url);
}
