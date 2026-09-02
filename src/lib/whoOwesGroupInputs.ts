// Feeding GROUP obligations into the who-owes-me aggregator from the data the
// app already has in memory — no extra round-trips.
//
// ── Why this adapter exists ────────────────────────────────────────────────
// `buildWhoOwesMe` wants per-group PAIRWISE debts (`computePairwiseDebts`), so
// it can say "Bilal owes you 400 from Dubai Trip". Producing those needs every
// expense + settlement row of the group, which only `splitStore.getPairwiseDebts`
// fetches — one round-trip pair PER GROUP. HomePage and LoansPage must not pay
// that on every paint.
//
// What those pages DO already hold is `splitStore.balances`: the signed-in
// user's NET position in each group, computed by `loadBalances` from two
// batched queries. That is strictly less information — it says how much the
// group owes you, never WHO inside it — so this adapter is deliberately honest
// about the difference:
//
//   · the counterparty it emits is THE GROUP ITSELF (id `group-net:<groupId>`,
//     display name = the group's name), never a guessed member;
//   · the resulting `WhoOwesRow` therefore reads "Dubai Trip · +AED 400" with a
//     `group` source deep-linking to /group/:id — it never puts group money on
//     a person's row, and never claims a person it cannot prove;
//   · MONEY is exact either way. Per-currency totals from `whoOwesTotals` are
//     identical to what the per-person version would produce, because a group's
//     net position is the sum of its member edges with you.
//
// When a page can afford the per-group fetch it should pass real
// `computePairwiseDebts` output to `buildWhoOwesMe` instead and skip this file
// entirely; the two are interchangeable at the `WhoOwesGroupInput` boundary.
//
// ── Guests (audit G6 / O4) ────────────────────────────────────────────────
// A GUEST is a group member with no Hisaab account (`profile_id IS NULL`,
// status 'connected' — see src/lib/groupGuests.ts). Nothing here needs to
// change for them, and that is worth stating rather than leaving to inference:
//
//   * MONEY. This adapter emits the GROUP as the counterparty, never a member,
//     so a guest's share is already folded into `balances[groupId]` by
//     `splitStore.loadBalances` — which sums the signed-in user's own paid /
//     share / settlement legs and never reads anyone else's profile. A guest
//     edge is arithmetically identical to a real member's.
//   * IDENTITY. When a caller can afford the per-group fetch and passes real
//     `computePairwiseDebts` output to `buildWhoOwesMe` instead, a guest
//     resolves through `resolveGroupMemberIdentity` (docs/who-owes-me.md §3):
//     rule 1 cannot fire (no profileId), so they land on rule 2 (a single
//     same-named contact) or rule 3 (the lowercased trimmed NAME key). That is
//     exactly right — a guest IS a name-keyed person, the same shape an ad-hoc
//     split or a free-typed loan produces — and it means the guest's group
//     balance merges with the loan you already have against that name, which is
//     the whole point of the unified surface.
//   * HONESTY. Such a row's `matchedBy` is 'name' or 'none', never 'profile',
//     so the UI must not render a VerifiedBadge against it. Rule 3's documented
//     ambiguity (two different people sharing a display name become one row)
//     applies to guests too — which is why `add_group_guest` refuses a name
//     already used by a live member of the same group: it removes the only
//     variant of that collision the app can actually prevent.
//
// ── Who is "me" ───────────────────────────────────────────────────────────
// A group is skipped outright unless the caller's `currentProfileId` matches a
// member row. `resolveMeMemberId`'s owner fallback is wrong for any group the
// user does not belong to (docs/who-owes-me.md §3, open risk 2), and
// `loadBalances` uses the same profile-id match, so anything this adapter could
// not identify carries a balance of 0 anyway. Never guess.
//
// Pure; no store, no i18n, no side effects.

import type { GroupMember, Person, SplitGroup } from '../db';
import type { GroupDebt } from './groupDebts';
import type { MeraHisaabTotals } from './meraHisaab';
import { MONEY_TOLERANCE, round2 } from './moneyTolerance';
import {
  buildWhoOwesMe,
  type PersonMatch,
  type WhoOwesCurrencyTotal,
  type WhoOwesGroupInput,
  type WhoOwesRow,
  type WhoOwesSource,
} from './whoOwesMe';

/**
 * Same "this is zero money" tolerance as whoOwesMe / settleUpMinimize, now
 * pulled from the shared module rather than re-declared (docs/who-owes-me.md
 * open risk #5). NOTE this is deliberately NOT the tolerance the pairwise rows
 * were built with: `computePairwiseDebts` uses the stricter
 * GROUP_SETTLEMENT_TOLERANCE (0.01) because the server's settle-up RPC does —
 * see src/lib/moneyTolerance.ts.
 */
export const GROUP_NET_TOLERANCE = MONEY_TOLERANCE;

/**
 * Member-id prefix for the synthetic "the group" counterparty. Namespaced so it
 * can never collide with a real group member id (a uuid).
 */
export const GROUP_COUNTERPARTY_PREFIX = 'group-net:';

/** True for a member id this adapter minted rather than one from the DB. */
export function isGroupCounterpartyId(memberId: string | undefined | null): boolean {
  return typeof memberId === 'string' && memberId.startsWith(GROUP_COUNTERPARTY_PREFIX);
}

/**
 * Turn `splitStore.groups` + `splitStore.balances` into `buildWhoOwesMe` group
 * inputs — one single-edge "you ↔ this group" obligation per group that is not
 * square.
 *
 * Groups with no net, groups the balance map has not been computed for, and
 * groups the user cannot be identified inside are all omitted. Archived groups
 * are KEPT: archiving closes a group to new expenses, it does not forgive the
 * money already owed.
 */
export function groupInputsFromNetBalances(
  groups: ReadonlyArray<SplitGroup>,
  balances: Readonly<Record<string, number>>,
  currentProfileId: string | null | undefined,
): WhoOwesGroupInput[] {
  if (!currentProfileId) return [];

  const out: WhoOwesGroupInput[] = [];
  for (const group of groups) {
    const net = round2(balances[group.id] ?? 0);
    if (!Number.isFinite(net) || Math.abs(net) <= GROUP_NET_TOLERANCE) continue;

    const me = group.members.find((m) => m.profileId === currentProfileId);
    if (!me) continue; // cannot prove which seat is ours — count nothing

    const counterparty: GroupMember = {
      id: `${GROUP_COUNTERPARTY_PREFIX}${group.id}`,
      name: group.name,
      isOwner: false,
      profileId: null,
    };

    // net > 0 ⇒ the group owes me; net < 0 ⇒ I owe the group.
    const iAmOwed = net > 0;
    const amount = Math.abs(net);

    out.push({
      groupId: group.id,
      groupName: group.name,
      currency: group.currency,
      members: [me, counterparty],
      meMemberId: me.id,
      debts: [
        iAmOwed
          ? { from: counterparty.id, fromName: counterparty.name, to: me.id, toName: me.name, amount }
          : { from: me.id, fromName: me.name, to: counterparty.id, toName: counterparty.name, amount },
      ],
    });
  }
  return out;
}

/** The contact fields the identity ladder actually reads. */
export type ContactLike = Pick<Person, 'id' | 'name' | 'linkedProfileId' | 'archivedAt'>;

/** What `splitStore.loadBalances` retains, in the shape this file consumes. */
export interface PairwiseGroupState {
  /**
   * groupId → the DIRECT pairwise debts touching the signed-in user. A PRESENT
   * key means "computed" (an empty array = square with everyone); an ABSENT key
   * means "not computed" and falls back to the net-balance adapter.
   */
  pairwiseByGroup: Readonly<Record<string, ReadonlyArray<GroupDebt>>>;
  /** groupId → the user's net position, the coarse fallback input. */
  balances: Readonly<Record<string, number>>;
}

/**
 * The GOOD adapter: one `WhoOwesGroupInput` per group, carrying the real
 * member↔me edges, so `buildWhoOwesMe` emits one row per PERSON instead of one
 * row per group (docs/who-owes-me.md open risk #1).
 *
 * Costs nothing extra: `splitStore.loadBalances` already downloads every
 * visible expense + settlement in two batched queries and already runs
 * `computePairwiseDebts` over them — it simply keeps the edges touching the
 * user now instead of discarding them.
 *
 * The member→person mapping is NOT done here on purpose. It belongs to
 * `buildWhoOwesMe`, which owns the three-rule ladder (profile link → contact id
 * · unique contact name → contact id · else the lowercased trimmed name key)
 * and the `matchedBy` honesty flag that goes with it. Resolving identity twice,
 * in two places, is how two ladders drift apart. Callers pass their contacts to
 * `buildWhoOwesMe({ contacts })`; guests (no `profileId`) fall through rules 2/3
 * to a name key, exactly like a free-typed loan — which is what lets a guest's
 * group balance merge with the loan already held against that name.
 *
 * Groups are skipped when: the pairwise pass never covered them, the user has
 * no member seat (never the owner fallback — open risk 2), or every edge is
 * square. Archived groups are KEPT: archiving closes a group, it does not
 * forgive money.
 */
export function groupInputsFromPairwise(
  groups: ReadonlyArray<SplitGroup>,
  pairwiseByGroup: Readonly<Record<string, ReadonlyArray<GroupDebt>>>,
  currentProfileId: string | null | undefined,
): WhoOwesGroupInput[] {
  if (!currentProfileId) return [];

  const out: WhoOwesGroupInput[] = [];
  for (const group of groups) {
    const debts = pairwiseByGroup[group.id];
    if (!debts || debts.length === 0) continue;

    const me = group.members.find((m) => m.profileId === currentProfileId);
    if (!me) continue; // cannot prove which seat is ours — count nothing

    // Defensive: the store already filters to my edges, but a stale/hand-built
    // map must never put two strangers' money on my screen.
    const mine = debts.filter((d) => d.from === me.id || d.to === me.id);
    if (mine.length === 0) continue;

    out.push({
      groupId: group.id,
      groupName: group.name,
      currency: group.currency,
      members: group.members,
      meMemberId: me.id,
      debts: mine,
    });
  }
  return out;
}

/**
 * Pairwise where we have it, net-balance edge where we don't — the single entry
 * point a UI should use. Never both for the same group, so nothing is counted
 * twice.
 */
export function groupInputsForWhoOwes(
  groups: ReadonlyArray<SplitGroup>,
  state: PairwiseGroupState,
  currentProfileId: string | null | undefined,
): WhoOwesGroupInput[] {
  const pairwise = groupInputsFromPairwise(groups, state.pairwiseByGroup, currentProfileId);
  // Keyed off the MAP, not off what the adapter emitted: a covered group that
  // came out square must stay square, not fall back to a coarse group row.
  const covered = (group: SplitGroup) =>
    Object.prototype.hasOwnProperty.call(state.pairwiseByGroup, group.id);
  const rest = groups.filter((g) => !covered(g));
  return [...pairwise, ...groupInputsFromNetBalances(rest, state.balances, currentProfileId)];
}

const MATCH_RANK: Record<PersonMatch, number> = { profile: 0, name: 1, none: 2 };

function sortSources(sources: WhoOwesSource[]): WhoOwesSource[] {
  return [...sources].sort(
    (a, b) => b.amount - a.amount || a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id),
  );
}

/** Same ordering contract as `buildWhoOwesMe`. */
function sortRows(rows: WhoOwesRow[]): WhoOwesRow[] {
  return rows.sort(
    (a, b) =>
      Math.abs(b.net) - Math.abs(a.net) ||
      b.youAreOwed + b.youOwe - (a.youAreOwed + a.youOwe) ||
      a.personName.localeCompare(b.personName) ||
      a.currency.localeCompare(b.currency) ||
      a.personKey.localeCompare(b.personKey),
  );
}

function mergeRows(a: ReadonlyArray<WhoOwesRow>, b: ReadonlyArray<WhoOwesRow>): WhoOwesRow[] {
  const byKey = new Map<string, WhoOwesRow>();
  for (const row of [...a, ...b]) {
    const key = `${row.currency}:${row.personKey}`;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, { ...row, sources: [...row.sources] });
      continue;
    }
    existing.youAreOwed = round2(existing.youAreOwed + row.youAreOwed);
    existing.youOwe = round2(existing.youOwe + row.youOwe);
    existing.net = round2(existing.youAreOwed - existing.youOwe);
    existing.sources = sortSources([...existing.sources, ...row.sources]);
    // Strongest identity names the row; weakest sets the caveat — the same rule
    // buildWhoOwesMe applies inside a bucket.
    if (MATCH_RANK[row.matchedBy] < MATCH_RANK[existing.matchedBy] && row.personId) {
      existing.personId = row.personId;
      existing.personName = row.personName;
    }
    if (MATCH_RANK[row.matchedBy] > MATCH_RANK[existing.matchedBy]) {
      existing.matchedBy = row.matchedBy;
    }
  }
  return sortRows([...byKey.values()]);
}

/**
 * Re-attribute the GROUP half of an already-built `buildWhoOwesMe` result to
 * real people, using the pairwise rows the store retained.
 *
 * Why a post-pass rather than "just build the rows right the first time": the
 * pages that own the aggregation call sites build `rows` from whatever group
 * adapter they were written against, and the pairwise data arrives on a
 * different store slice. This lets the surface upgrade itself the moment
 * `pairwiseByGroup` is populated, and degrade to exactly today's behaviour when
 * it is not.
 *
 * Arithmetic is conserved by construction: every group source belonging to a
 * covered group is SUBTRACTED from its row's column before the per-person group
 * rows are added back, and the per-person edges of a group sum to the same net
 * the coarse edge carried. Loans, linked loans and ad-hoc splits are never
 * touched. Accounts are not an input here — group tables never move money — so
 * full_tracker and splits_only produce identical rows.
 */
export function rowsWithPairwiseGroups(
  rows: WhoOwesRow[],
  args: {
    groups: ReadonlyArray<SplitGroup>;
    pairwiseByGroup: Readonly<Record<string, ReadonlyArray<GroupDebt>>>;
    currentProfileId: string | null | undefined;
    contacts?: ReadonlyArray<ContactLike>;
  },
): WhoOwesRow[] {
  const inputs = groupInputsFromPairwise(args.groups, args.pairwiseByGroup, args.currentProfileId);
  // Identity contract: nothing to re-attribute ⇒ the SAME array back, so a
  // caller can cheaply tell "the surface upgraded" from "it did not".
  if (inputs.length === 0) return rows;

  const covered = new Set(inputs.map((i) => i.groupId));

  // 1. Peel off the group sources we are about to re-attribute. What is left is
  //    the loan / linked / ad-hoc half, untouched.
  const remainder: WhoOwesRow[] = [];
  for (const row of rows) {
    const kept: WhoOwesSource[] = [];
    let youAreOwed = row.youAreOwed;
    let youOwe = row.youOwe;
    for (const source of row.sources) {
      if (source.kind === 'group' && covered.has(source.id)) {
        if (source.direction === 'owed_to_me') youAreOwed = round2(youAreOwed - source.amount);
        else youOwe = round2(youOwe - source.amount);
        continue;
      }
      kept.push(source);
    }
    if (kept.length === row.sources.length) {
      remainder.push(row);
      continue;
    }
    // A row that was ONLY this group's coarse edge disappears entirely — it was
    // the group masquerading as a person, which is the bug being fixed.
    if (kept.length === 0) continue;
    remainder.push({
      ...row,
      youAreOwed,
      youOwe,
      net: round2(youAreOwed - youOwe),
      sources: kept,
    });
  }

  // 2. Rebuild the group half per PERSON through the real aggregator, so the
  //    identity ladder and the matchedBy honesty flag come from one place.
  const groupRows = buildWhoOwesMe({
    loans: [],
    groups: inputs,
    contacts: args.contacts,
    currentProfileId: args.currentProfileId,
  });

  return mergeRows(remainder, groupRows);
}

/**
 * Fold group obligations into the "Mera Hisaab" headline.
 *
 * `computeMeraHisaab` stays the authority on the ACCOUNT and LOAN halves — it
 * carries the card-funded cash-advance exclusion that stops one debt being
 * counted twice, and re-deriving loans here would silently drop it. This only
 * adds what that function has no input for: the group side (audit G4 /
 * docs/who-owes-me.md §6a — group balances were missing from the headline).
 *
 * Per currency, never merged across currencies. A currency that exists only in
 * groups gains a row of its own.
 */
export function mergeGroupObligations(
  totals: ReadonlyArray<MeraHisaabTotals>,
  groupTotals: ReadonlyArray<WhoOwesCurrencyTotal>,
): MeraHisaabTotals[] {
  const byCurrency = new Map<string, MeraHisaabTotals>();
  for (const entry of totals) byCurrency.set(entry.currency, { ...entry });

  for (const g of groupTotals) {
    const entry = byCurrency.get(g.currency) ?? {
      currency: g.currency,
      accountsNet: 0,
      receivable: 0,
      payable: 0,
      net: 0,
    };
    entry.receivable = round2(entry.receivable + g.youAreOwed);
    entry.payable = round2(entry.payable + g.youOwe);
    byCurrency.set(g.currency, entry);
  }

  const out = [...byCurrency.values()];
  for (const entry of out) {
    entry.net = round2(entry.accountsNet + entry.receivable - entry.payable);
  }
  // Same ordering contract as computeMeraHisaab: biggest position first.
  return out.sort((a, b) => Math.abs(b.net) - Math.abs(a.net) || a.currency.localeCompare(b.currency));
}
