// "Who owes me" — ONE per-person, per-currency view across every mechanism
// Hisaab uses to record an obligation.
//
// Hisaab has four doors onto the same question and no surface that nets them
// (audit 11-competitive-analysis G4/O7, 06-user-experience UX-23):
//   1. personal loans        — Loan rows (given / taken), the khata primitive
//   2. linked loans          — the same rows, mirrored to another Hisaab user
//   3. ad-hoc splits         — "I paid, split it with these people", which
//                              MATERIALISES as ordinary Loan rows (splitEvent.ts)
//   4. group splits          — SplitGroup expenses/settlements, netted by
//                              groupDebts.computePairwiseDebts into member↔member
//                              debts that live entirely inside the group
// A user with a loan to Bilal, an ad-hoc lunch with Bilal, and a Dubai-trip
// group containing Bilal currently reads three screens and does the arithmetic
// themselves. This module does it for them.
//
// ── WHAT THIS IS NOT ──────────────────────────────────────────────────────
// It NEVER touches accounts, balances or transactions-as-money. It reads
// obligations only, so it behaves identically in full_tracker and splits_only
// (ledger-only) mode. A ledger-mode loan has no account leg and no transaction
// row at all — it is still a loan and still counted here. Transactions are read
// for exactly one purpose: labelling which loans came from an ad-hoc split.
//
// ── NO DOUBLE COUNTING (the load-bearing rule) ────────────────────────────
// An ad-hoc split does not create a third kind of debt: `executeSplitEvent`
// writes ONE loan per participant. So ad-hoc splits are a *classification* of
// loans, never an addition to them. `adhocByLoanId` re-labels a loan's source
// as `adhoc` and attaches the split's label; the amount is counted once, from
// the loan. Feeding split rows in separately would double every lunch.
//
// ── PERSON-KEY MAPPING (and its ambiguity) ────────────────────────────────
// Loans already key on the repo-wide rule: `personId ?? lowercased trimmed
// name` (LoansPage, repaymentGroups). Group members are a different namespace —
// a per-group member id — so they must be mapped onto that key:
//   1. member.profileId matches a contact's linkedProfileId  → that contact's id
//      ("profile"): the only identification the app can actually prove.
//   2. exactly ONE non-archived contact's name matches the member's name,
//      case- and whitespace-insensitively                     → that contact's id
//      ("name"): a guess. Two contacts with the same name ⇒ no match, on purpose.
//   3. otherwise the lowercased trimmed member name           → name key ("none")
// Consequences the UI must be honest about:
//   · Rule 3 merges two DIFFERENT people who share a display name. That is
//     already true of loans typed without a contact, so this changes nothing —
//     but it is now visible in one place.
//   · A group member resolved to contact X does NOT merge with a loan typed
//     free-hand against the same name (key `x-id` vs key `bilal`). Rows carry
//     `matchedBy`, and `findLikelyDuplicateRows` surfaces the pair so the UI can
//     offer "link this contact" instead of silently merging money.
// Rows never merge across currency or across direction: youAreOwed and youOwe
// stay as separate columns on the row, `net` is derived, and every contributing
// source is retained so the UI can always explain the number.

import type { Currency, GroupMember, Loan, Person, Transaction } from '../db';
import type { GroupDebt } from './groupDebts';
import { parseInternalNote } from './internalNotes';
import { isZeroMoney } from './moneyTolerance';

/** Same "this is zero money" tolerance as statementOfAccount / settleUpMinimize. */
export { WHO_OWES_TOLERANCE } from './moneyTolerance';

export type WhoOwesSourceKind = 'loan' | 'group' | 'adhoc';
export type WhoOwesDirection = 'owed_to_me' | 'i_owe';

export interface WhoOwesSource {
  kind: WhoOwesSourceKind;
  /** loan id · group id · split event id — whatever the UI should navigate to. */
  id: string;
  /** Always positive; the direction carries the sign. */
  amount: number;
  direction: WhoOwesDirection;
  currency: Currency;
  /** Loan note, group name, or ad-hoc split label. May be ''. */
  label: string;
  /** Mirrored to another Hisaab user — settles through the cross-user flow. */
  linked?: boolean;
  /** Group sources only: the counterparty's member id inside that group. */
  memberId?: string;
}

export type PersonMatch = 'profile' | 'name' | 'none';

export interface WhoOwesRow {
  /** `personId ?? lowercased trimmed name` — the repo-wide person key. */
  personKey: string;
  personName: string;
  /** Null when the row was keyed by name alone (no contact behind it). */
  personId: string | null;
  currency: Currency;
  youAreOwed: number;
  youOwe: number;
  /** youAreOwed − youOwe. Positive = they owe you. */
  net: number;
  sources: WhoOwesSource[];
  /**
   * Weakest identification behind any source on the row: 'profile' when every
   * contributing source was id-matched, 'name'/'none' when a group member was
   * matched by display name or not at all.
   */
  matchedBy: PersonMatch;
}

export interface WhoOwesGroupInput {
  groupId: string;
  groupName: string;
  currency: Currency;
  members: ReadonlyArray<GroupMember>;
  /**
   * DIRECT pairwise debts from `computePairwiseDebts` — not the store's
   * simplified list. Simplified debts reroute through third parties, which
   * would attribute money to the wrong person on this screen.
   */
  debts: ReadonlyArray<GroupDebt>;
  /** The current user's member id. Resolved from profileId / owner when omitted. */
  meMemberId?: string | null;
}

export interface WhoOwesInput {
  loans: ReadonlyArray<Loan>;
  groups?: ReadonlyArray<WhoOwesGroupInput>;
  /** Contacts, for mapping group members onto person keys. */
  contacts?: ReadonlyArray<Pick<Person, 'id' | 'name' | 'linkedProfileId' | 'archivedAt'>>;
  /** The signed-in user's auth uid — how "me" is found inside each group. */
  currentProfileId?: string | null;
  /**
   * loanId → the ad-hoc split it came from. RE-LABELS those loans; it never
   * adds money. Build it with `buildAdhocSplitIndex`.
   */
  adhocByLoanId?: ReadonlyMap<string, AdhocSplitRef>;
}

export interface AdhocSplitRef {
  splitEventId: string;
  label: string;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function isMoney(n: number): boolean {
  return !isZeroMoney(n);
}

/** The repo-wide person key: a contact id when we have one, else the name. */
export function personKeyOf(personId: string | null | undefined, name: string): string {
  return personId ?? name.trim().toLowerCase();
}

/**
 * Which loans came from an ad-hoc split, read off the `splitEventId` meta that
 * `executeSplitEvent` stamps on the transaction rows.
 *
 * LIMITATION (documented, not a money bug): in splits_only mode an ad-hoc split
 * writes loans with NO transaction rows at all, so there is nothing to read and
 * those loans surface as plain `loan` sources. The amount and direction are
 * identical either way — only the label and the deep-link target differ.
 */
export function buildAdhocSplitIndex(
  transactions: ReadonlyArray<Transaction>,
): Map<string, AdhocSplitRef> {
  const out = new Map<string, AdhocSplitRef>();
  for (const txn of transactions) {
    if (txn.deletedAt || !txn.relatedLoanId) continue;
    const meta = parseInternalNote(txn.notes).meta;
    if (!meta.splitEventId) continue;
    if (out.has(txn.relatedLoanId)) continue;
    out.set(txn.relatedLoanId, {
      splitEventId: meta.splitEventId,
      label: meta.splitLabel ?? '',
    });
  }
  return out;
}

export interface ResolvedIdentity {
  personKey: string;
  personId: string | null;
  personName: string;
  matchedBy: PersonMatch;
}

interface ContactIndex {
  byProfile: Map<string, Pick<Person, 'id' | 'name'>>;
  byName: Map<string, Pick<Person, 'id' | 'name'> | null>; // null = ambiguous
}

function indexContacts(
  contacts: ReadonlyArray<Pick<Person, 'id' | 'name' | 'linkedProfileId' | 'archivedAt'>>,
): ContactIndex {
  const byProfile = new Map<string, Pick<Person, 'id' | 'name'>>();
  const byName = new Map<string, Pick<Person, 'id' | 'name'> | null>();
  for (const c of contacts) {
    if (c.linkedProfileId && !byProfile.has(c.linkedProfileId)) {
      byProfile.set(c.linkedProfileId, { id: c.id, name: c.name });
    }
    // Archived contacts still identify a profile link, but must not win a
    // name guess against a live contact.
    if (c.archivedAt) continue;
    const key = c.name.trim().toLowerCase();
    if (!key) continue;
    if (byName.has(key)) byName.set(key, null); // two people, same name → refuse
    else byName.set(key, { id: c.id, name: c.name });
  }
  return { byProfile, byName };
}

/**
 * Map one group member onto the app-wide person key. See the header for the
 * three-rule ladder and what each rule can get wrong.
 */
export function resolveGroupMemberIdentity(
  member: Pick<GroupMember, 'id' | 'name' | 'profileId'>,
  contacts: ReadonlyArray<Pick<Person, 'id' | 'name' | 'linkedProfileId' | 'archivedAt'>> = [],
): ResolvedIdentity {
  const index = indexContacts(contacts);
  return resolveWithIndex(member, index);
}

function resolveWithIndex(
  member: Pick<GroupMember, 'id' | 'name' | 'profileId'>,
  index: ContactIndex,
): ResolvedIdentity {
  const name = member.name.trim();
  if (member.profileId) {
    const contact = index.byProfile.get(member.profileId);
    if (contact) {
      return { personKey: contact.id, personId: contact.id, personName: contact.name, matchedBy: 'profile' };
    }
  }
  const guess = index.byName.get(name.toLowerCase());
  if (guess) {
    return { personKey: guess.id, personId: guess.id, personName: guess.name, matchedBy: 'name' };
  }
  return { personKey: name.toLowerCase(), personId: null, personName: name, matchedBy: 'none' };
}

/** Which member row is the signed-in user: explicit id → profile match → owner. */
export function resolveMeMemberId(
  group: WhoOwesGroupInput,
  currentProfileId?: string | null,
): string | null {
  if (group.meMemberId) return group.meMemberId;
  if (currentProfileId) {
    const byProfile = group.members.find((m) => m.profileId === currentProfileId);
    if (byProfile) return byProfile.id;
  }
  // Mirrors GroupDetailPage's fallback. On a group the user does not belong to
  // this is wrong, so callers should pass currentProfileId whenever they have it.
  return group.members.find((m) => m.isOwner)?.id ?? null;
}

const MATCH_RANK: Record<PersonMatch, number> = { profile: 0, name: 1, none: 2 };

interface Bucket {
  personKey: string;
  personName: string;
  personId: string | null;
  currency: Currency;
  youAreOwed: number;
  youOwe: number;
  sources: WhoOwesSource[];
  matchedBy: PersonMatch;
}

/**
 * The aggregator. One row per (person key, currency); both directions kept as
 * separate columns; every contributing source retained.
 */
export function buildWhoOwesMe(input: WhoOwesInput): WhoOwesRow[] {
  const contactIndex = indexContacts(input.contacts ?? []);
  const buckets = new Map<string, Bucket>();

  const bucketFor = (identity: ResolvedIdentity, currency: Currency): Bucket => {
    const key = `${currency}:${identity.personKey}`;
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = {
        personKey: identity.personKey,
        personName: identity.personName,
        personId: identity.personId,
        currency,
        youAreOwed: 0,
        youOwe: 0,
        sources: [],
        matchedBy: identity.matchedBy,
      };
      buckets.set(key, bucket);
    }
    // Keep the strongest identity for the id/name, the weakest as the caveat.
    if (MATCH_RANK[identity.matchedBy] < MATCH_RANK[bucket.matchedBy] && identity.personId) {
      bucket.personId = identity.personId;
      bucket.personName = identity.personName;
    }
    if (MATCH_RANK[identity.matchedBy] > MATCH_RANK[bucket.matchedBy]) {
      bucket.matchedBy = identity.matchedBy;
    }
    return bucket;
  };

  const add = (bucket: Bucket, source: WhoOwesSource) => {
    if (source.direction === 'owed_to_me') bucket.youAreOwed = round2(bucket.youAreOwed + source.amount);
    else bucket.youOwe = round2(bucket.youOwe + source.amount);
    bucket.sources.push(source);
  };

  // ── Loans (personal, linked, and the ad-hoc splits that materialised as loans)
  for (const loan of input.loans) {
    if (loan.deletedAt) continue;
    if (loan.status === 'settled') continue;
    const remaining = round2(loan.remainingAmount);
    if (!isMoney(remaining)) continue; // fully repaid ⇒ nothing outstanding

    const identity: ResolvedIdentity = {
      personKey: personKeyOf(loan.personId, loan.personName),
      personId: loan.personId ?? null,
      personName: loan.personName.trim(),
      matchedBy: loan.personId ? 'profile' : 'none',
    };
    const adhoc = input.adhocByLoanId?.get(loan.id);
    add(bucketFor(identity, loan.currency), {
      kind: adhoc ? 'adhoc' : 'loan',
      id: adhoc ? adhoc.splitEventId : loan.id,
      amount: remaining,
      direction: loan.type === 'given' ? 'owed_to_me' : 'i_owe',
      currency: loan.currency,
      label: (adhoc?.label || loan.notes || '').trim(),
      ...(loan.loanPairId ? { linked: true } : {}),
    });
  }

  // ── Group splits: only the edges the signed-in user is actually on.
  for (const group of input.groups ?? []) {
    const meMemberId = resolveMeMemberId(group, input.currentProfileId);
    if (!meMemberId) continue; // cannot tell which side is "me" — count nothing
    const memberById = new Map(group.members.map((m) => [m.id, m]));

    for (const d of group.debts) {
      if (!isMoney(d.amount)) continue;
      const iAmPayer = d.from === meMemberId;
      const iAmPayee = d.to === meMemberId;
      if (iAmPayer === iAmPayee) continue; // not my edge (or a self-edge)

      const otherId = iAmPayer ? d.to : d.from;
      const other = memberById.get(otherId) ?? {
        id: otherId,
        name: iAmPayer ? d.toName : d.fromName,
        profileId: null,
      };
      const identity = resolveWithIndex(
        { id: other.id, name: other.name, profileId: other.profileId ?? null },
        contactIndex,
      );
      add(bucketFor(identity, group.currency), {
        kind: 'group',
        id: group.groupId,
        amount: round2(d.amount),
        direction: iAmPayer ? 'i_owe' : 'owed_to_me',
        currency: group.currency,
        label: group.groupName,
        memberId: otherId,
      });
    }
  }

  const rows: WhoOwesRow[] = [];
  for (const bucket of buckets.values()) {
    const net = round2(bucket.youAreOwed - bucket.youOwe);
    if (!isMoney(bucket.youAreOwed) && !isMoney(bucket.youOwe)) continue;
    rows.push({
      personKey: bucket.personKey,
      personName: bucket.personName,
      personId: bucket.personId,
      currency: bucket.currency,
      youAreOwed: round2(bucket.youAreOwed),
      youOwe: round2(bucket.youOwe),
      net,
      sources: bucket.sources.sort(
        (a, b) => b.amount - a.amount || a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id),
      ),
      matchedBy: bucket.matchedBy,
    });
  }

  return rows.sort(
    (a, b) =>
      Math.abs(b.net) - Math.abs(a.net) ||
      b.youAreOwed + b.youOwe - (a.youAreOwed + a.youOwe) ||
      a.personName.localeCompare(b.personName) ||
      a.currency.localeCompare(b.currency) ||
      a.personKey.localeCompare(b.personKey),
  );
}

export interface WhoOwesCurrencyTotal {
  currency: Currency;
  youAreOwed: number;
  youOwe: number;
  net: number;
  people: number;
}

/** Headline figures, per currency. Never summed across currencies. */
export function whoOwesTotals(rows: ReadonlyArray<WhoOwesRow>): WhoOwesCurrencyTotal[] {
  const byCurrency = new Map<Currency, WhoOwesCurrencyTotal>();
  for (const row of rows) {
    const total = byCurrency.get(row.currency) ?? {
      currency: row.currency,
      youAreOwed: 0,
      youOwe: 0,
      net: 0,
      people: 0,
    };
    total.youAreOwed = round2(total.youAreOwed + row.youAreOwed);
    total.youOwe = round2(total.youOwe + row.youOwe);
    total.net = round2(total.youAreOwed - total.youOwe);
    total.people += 1;
    byCurrency.set(row.currency, total);
  }
  return [...byCurrency.values()].sort(
    (a, b) => Math.abs(b.net) - Math.abs(a.net) || a.currency.localeCompare(b.currency),
  );
}

export interface DuplicateRowHint {
  /** The row backed by a real contact. */
  linked: WhoOwesRow;
  /** The name-only row that probably belongs to the same human. */
  unlinked: WhoOwesRow;
}

/**
 * Rows that share a display name and a currency but not a key — i.e. "Bilal the
 * contact" and "Bilal typed by hand". Deliberately a HINT, not a merge: the app
 * has never merged those elsewhere, and silently combining two people's money on
 * a name match is exactly the kind of quiet wrongness a trust product cannot
 * afford. The UI should offer "same person? link the contact".
 */
export function findLikelyDuplicateRows(rows: ReadonlyArray<WhoOwesRow>): DuplicateRowHint[] {
  const out: DuplicateRowHint[] = [];
  for (const linked of rows) {
    if (!linked.personId) continue;
    for (const unlinked of rows) {
      if (unlinked.personId) continue;
      if (unlinked.currency !== linked.currency) continue;
      if (unlinked.personName.trim().toLowerCase() !== linked.personName.trim().toLowerCase()) continue;
      out.push({ linked, unlinked });
    }
  }
  return out;
}
