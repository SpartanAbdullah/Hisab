# Guest members — people in a group who are not on Hisaab

**Status:** built. SQL is `supabase-migration-p2-guest-members.sql` and is
**PENDING the user applying it in Supabase Studio** (there is no migration
runner in this repo). Client code ships alongside it and degrades safely on an
un-migrated database: the two RPCs simply fail and the guest affordances report
"could not add them" rather than corrupting anything.

Closes audit `docs/audit-2026-09/11-competitive-analysis.md` **G6** (`:88`) and
**O4** (`:121`), and the July UX blocker **B6** at the group container.

---

## 1. The gap

Splitwise placeholder friends, Settle Up offline members, Splid anonymous
members, Tricount profiles — every Cluster A competitor lets a group contain
people who never install the app. Hisaab's `CreateGroupModal` resolved members
**only** by a Hisaab public code, and nothing on screen said so. The ad-hoc
`SplitWithSheet` already proved the data model holds non-app people; the group
container was the hole.

## 2. What a guest is

```
guest  ⇔  group_members row with
            profile_id  IS NULL          (no Hisaab account)
            status      = 'connected'    (a LIVE participant)
            display_name                 (what a member typed)
          + optional row in group_guest_identities (hashed phone)
```

Materialised as the generated column `group_members.is_guest`:

```sql
is_guest BOOLEAN GENERATED ALWAYS AS (profile_id IS NULL AND status <> 'left') STORED
```

`src/lib/groupGuests.ts` carries the same predicate client-side
(`isGuestMember`), and `groupGuests.test.ts` pins it.

**`status <> 'left'`, not `= 'connected'`, is load-bearing.** A member who
deletes their Hisaab account has their seat anonymized to `profile_id NULL` **and**
`status='left'` by `supabase-migration-audit-p0-account-deletion.sql` §4b —
specifically so it is *not* claimable. Reading that seat as a guest would both
mislabel it and open it to a phone-hash claim. The clause also keeps LEGACY
placeholders (the old `status='guest'` default) labelled as guests, which they
are.

## 3. Why almost no enforcement had to change

`status = 'connected'` was chosen precisely because the existing guards key on
**status, never on `profile_id`**:

| Guard | What it requires | Guest verdict |
|---|---|---|
| `tg_group_expenses_require_connected_members` (ledger-integrity `:396-441`) | ≥2 connected members; `paid_by` connected; every split participant connected | passes — guests can be **payer and participant** |
| `tg_group_expenses_validate_split_amounts` (money-bounds `:446+`) | member id belongs to this group, **any status** | passes |
| `tg_group_settlements_require_connected_members` | both members connected | passes |
| `record_group_settlement` (group-concurrency `:365-376`) | both members connected **and** `is_group_member(group, auth.uid())` for the RECORDER | passes for the edge; **fails for a guest as the actor** — which is the feature |
| `group_settlement_cap` | pure ledger arithmetic | applies unchanged |
| `tg_split_groups_guard_delete` Tier A/B | other members `profile_id IS NOT NULL` | guests never block a delete |
| `delete_current_user`'s "other participant" test | `status='connected' AND profile_id IS NOT NULL` | a guest-only group is still SOLO — no new dead-end |
| `tg_group_members_require_invite_consent` | returns `NEW` unchanged when `profile_id IS NULL` | consent model untouched |
| `tg_block_join_archived_group` | refuses anything entering `connected` in an archived group, **all roles** | `add_group_guest` pre-checks and returns `GROUP_ARCHIVED` |

So the task's "relax `record_group_settlement`'s both-connected rule to
both-connected-OR-guest" turned out to need **no relaxation**: a guest *is*
connected. `is_group_member()` still requires a `profile_id`, so nothing can
ever act **as** a guest — every settlement on a guest edge is recorded **by** a
real connected member on their behalf, and the UI says exactly that. The
migration's §6.4 verification block re-reads each of those function bodies out
of the live catalog so a future edit that breaks the arrangement fails loudly.

One header statement is deliberately **superseded**:
`supabase-migration-audit-p0-group-deletion-guard.sql:99-110` says "guests can
never settle". They can now — and that strictly improves the situation that
header was worried about, because an owner who owes a guest can clear the
balance instead of being stranded. The delete verdict is unchanged: Tier A and
Tier B both filter on `profile_id IS NOT NULL`.

## 4. The SQL contract

### New

| Object | Shape |
|---|---|
| `group_members.is_guest` | generated column, above |
| `group_guest_identities(member_id PK, group_id, phone_hashes TEXT[], created_by, created_at)` | **deny-all RLS + table grant revoked** from `anon`/`authenticated` |
| `public.hash_phone_e164(TEXT) -> TEXT` | SHA-256 lowercase hex; revoked from every client role |
| `tg_group_members_guest_seat_rules` | `BEFORE INSERT` on `group_members`, **all roles** |
| `public.add_group_guest(group, name, phone, member_id) -> JSONB` | `authenticated` |
| `public.remove_group_guest(group, member_id) -> JSONB` | `authenticated` |

`add_group_guest` statuses: `ok` · `ALREADY_ADDED` (idempotent replay on the
caller-minted member id) · `NOT_AUTHENTICATED` · `NOT_ACTIVE_MEMBER` (also the
answer for a guessed group id — no existence oracle) · `GROUP_ARCHIVED` ·
`INVALID_NAME` · `DUPLICATE_NAME` · `TOO_MANY_GUESTS` · `TOO_MANY_MEMBERS`.

`remove_group_guest` statuses: `ok` · `NOT_AUTHENTICATED` · `NOT_ACTIVE_MEMBER`
· `GROUP_ARCHIVED` · `NOT_A_GUEST` · `NOT_ALLOWED` · `GUEST_HAS_LEDGER`.

Both return failures as **data, never exceptions** — the repo rule from audit
H1: a `RAISE` rolls back everything the call already committed.

### Changed — one mini-diff

`public.join_group_by_code(TEXT, TEXT)` is `CREATE OR REPLACE`d from
`supabase-migration-p2-trust-safety.sql` §4.1 with **three** changes and nothing
else (the rate window, `CANNOT_JOIN_OWN_GROUP`, the `[J1]` audit-M17 owner-block
check and the never-RAISE contract are byte-for-byte):

```diff
   SELECT gm.* INTO v_member FROM group_members
    WHERE gm.group_id = v_group.id AND gm.profile_id = v_uid LIMIT 1;
+
+  -- [G1a] guest-seat claim by phone hash
+  IF v_member.id IS NULL THEN
+    SELECT hash_phone_e164(pr.phone_e164) INTO v_phone_hash
+      FROM profiles pr WHERE pr.id = v_uid;          -- the CALLER'S OWN number
+    IF v_phone_hash IS NOT NULL THEN
+      SELECT count(*), min(gm.id) INTO v_guest_matches, v_guest_member_id
+        FROM group_members gm JOIN group_guest_identities gi ON gi.member_id = gm.id
+       WHERE gm.group_id = v_group.id AND gm.profile_id IS NULL
+         AND gm.status = 'connected' AND v_phone_hash = ANY (gi.phone_hashes);
+      IF v_guest_matches = 1 THEN  -- exactly one, or nothing
+        SELECT gm.* INTO v_member FROM group_members gm
+         WHERE gm.id = v_guest_member_id FOR UPDATE;
+        v_claimed_guest := v_member.id IS NOT NULL;
+      END IF;
+    END IF;
+  END IF;
   ...
   ELSE
-    v_was_already_connected := v_member.status = 'connected';
+    -- [G1c] IS NOT DISTINCT FROM: a guest seat's profile_id is NULL, and
+    --       `TRUE AND NULL` is NULL, not false.
+    v_was_already_connected := (v_member.status = 'connected'
+                                AND v_member.profile_id IS NOT DISTINCT FROM v_uid);
     UPDATE group_members gm
-       SET status = 'connected',
+       SET profile_id = v_uid,            -- [G1b] the rebind
+           status = 'connected',
            joined_at = COALESCE(gm.joined_at, v_now)
      WHERE gm.id = v_member.id;
   END IF;
+  IF v_claimed_guest THEN
+    DELETE FROM group_guest_identities WHERE member_id = v_member.id;
+  END IF;
```

`[G1b]` is permitted by the **existing** consent carve-out — the single
exception in `tg_group_members_protect_membership_fields` is
`OLD.profile_id IS NULL AND NEW.profile_id = auth.uid()`
(`consent-guards.sql:1048-1059`), self-consent by construction, the same door
`claimPaidByMemberIfMine` already uses. No second claim mechanism was added.

### Unchanged — the owner-assigned claim already existed

`accept_group_invite` (consent-guards §3.5, restated by p2-trust-safety §4.2)
already resolves `linked_member_id` against a seat with
`profile_id IS NULL OR profile_id = v_uid` and rebinds it. That **is** "assign
this seat to a member". The only work was surfacing it for guests in the UI.

## 5. Who may do what

| Action | Who | Why |
|---|---|---|
| add a guest | **owner OR any connected member** | Splitwise/Settle Up/Splid all do; owner-only breaks the moment the flatmate who did not create the group pays the cleaner. Blast radius is one group's member list, capped at 25 guests / 60 members, and every add writes a `guest_added` activity row |
| remove a guest | owner **or** whoever added it, **and only while the seat has zero ledger rows** (soft-deleted ones count) | `group_members` has had no client DELETE since `safe-leave-group.sql`; removing a referenced seat would dangle `paid_by` / `from_member` / `splits[].memberId` |
| rename a guest | owner only (existing `group_members` UPDATE policy) | not surfaced in the UI yet — see §9 |
| settle with a guest | any connected member, capped | recorded on the guest's behalf; the guest cannot act |
| claim a guest seat | the person themselves, via join code (phone match) or an owner-issued invite link | both are self-consent |

## 6. Client insertions

| File | Change |
|---|---|
| `src/lib/groupGuests.ts` **(new)** + `.test.ts` | `isGuestMember` (the SQL predicate), `getGuestMembers`, `settlementIsOnBehalf`, `validateGuestName`, `guestRpcFailureMessage`, `buildGuestInviteText`, the three caps |
| `src/lib/supabaseDb.ts` | `groupGuestsDb.add/remove` + `GuestSeatResult` |
| `src/stores/splitStore.ts` | `GuestMemberInput`; `createGroup(..., guests)` writes them through the RPC **inside the existing rollback try**; `addGroupGuest` / `removeGroupGuest`; `createInvite` no longer flips a **guest** seat to `'invited'` |
| `src/pages/CreateGroupModal.tsx` | "Without the app" name + optional phone, staged chips with a Guest tag, duplicate check across code members **and** staged guests, guests counted in the `group_created` size bucket |
| `src/components/GroupInviteModal.tsx` | guest badge; "Invite them to Hisaab" (WhatsApp) for guests — the old `status !== 'connected'` test hid every affordance from them; per-seat Remove; an inline "add someone without the app" form with a double-tap guard |
| `src/pages/GroupDetailPage.tsx` | `memberStatusLabel/Class` take the member and check guest FIRST; "connected" header count excludes guests; the status legend triggers for guests; per-guest **Invite / Assign this seat**; `guest_added` activity row |
| `src/pages/AddGroupExpenseModal.tsx`, `EditGroupExpenseModal.tsx` | guests were already in the pickers (`getActiveGroupMembers` keys on status); added the Guest tag to payer + split chips |
| `src/pages/SettleUpModal.tsx` | guest edges already listed; added "Recorded on their behalf" on the row and a named sentence on the confirm step |
| `src/lib/whoOwesGroupInputs.ts` | documentation + tests only — see §8 |
| `src/db/types.ts` | `'guest_added'` added to `GroupEventType` |

### The `createInvite` bug this exposed

`createInvite(groupId, linkedMemberId)` used to unconditionally write
`status: 'invited'` on the linked seat. For a **guest** that is wrong twice:

* it would **throw** — the seat is already `'connected'` and
  `tg_group_members_protect_membership_fields` refuses any client status change
  on a connected row;
* and had it succeeded, the seat would stop being a connected member, so every
  new split naming them would be refused — the seat would go inert the moment
  its owner tried to hand it over.

The store now skips the flip for guest seats. The invite alone is the whole
mechanism.

## 7. Both app modes

`group_expenses` and `group_settlements` have **no account columns at all**, and
nothing in this feature touches accounts, transactions or balances. So
`full_tracker` and `splits_only` are identical here, and every artifact a guest
flow leaves is unconditional:

| Flow | Artifacts (both modes) |
|---|---|
| add a guest | `group_members` row · `group_guest_identities` row if a phone was given · `group_events` `guest_added` row · **no notification** (a guest has no account, and the fan-out filters `profile_id IS NOT NULL`) |
| expense naming a guest | `group_expenses` row · `group_events` `expense_added` · member-list balance · settle-up edge |
| settlement on a guest edge | `group_settlements` row (authored by the RECORDER) · `group_events` `settlement_added` · cap consumed |
| guest seat claimed | `group_members.profile_id` bound · `member_joined` event + notification to every other member · `group_guest_identities` row deleted |

The optional "paid from my account" leg on a group expense is unrelated to
guests and behaves exactly as before — a guest can never be the payer of a
tracked leg because that leg requires `paidByMember` to be **you**.

## 8. Guests in "who owes me"

`whoOwesGroupInputs` emits the **group** as the counterparty, never a member, so
a guest's share is already folded into `splitStore.balances` — money is exact
with no change. When a caller passes real `computePairwiseDebts` output to
`buildWhoOwesMe` instead, a guest resolves through
`resolveGroupMemberIdentity` (docs/who-owes-me.md §3): rule 1 cannot fire (no
`profileId`), so they land on rule 2 (a single same-named contact) or rule 3
(the **lowercased trimmed name key**). That is correct — a guest *is* a
name-keyed person, the same shape an ad-hoc split or a free-typed loan produces
— and it means a guest's group balance merges with the loan you already hold
against that name.

Such a row's `matchedBy` is `'name'` or `'none'`, never `'profile'`, so it must
never carry a `VerifiedBadge`. Rule 3's documented ambiguity (two people sharing
a display name become one row) applies to guests too, which is exactly why
`add_group_guest` refuses a name already used by a live member of the same
group: it removes the one variant of that collision the app can prevent.

## 9. Open risks

1. **`profiles.phone_e164` is self-asserted.** Nothing verifies it by OTP, so a
   phone-hash claim proves "this joiner typed the same number the seat's creator
   typed", not "this joiner controls that number". Exploiting it needs the
   group's join code (32⁶ keyspace, 5 failed attempts / 5 minutes) *and* the
   victim's number, and the prize is a ledger position in a group the attacker
   could have joined anyway — no account, no balance, no money moves. Mitigated
   by: exact **unique** match only (two matching seats claim neither); the
   `member_joined` fan-out that announces every claim to the whole group; and
   the hashes being unreadable by any client. The owner-assigned invite path
   needs no phone and is the stronger option.
2. **The invite link is bearer-grade.** Whoever opens a seat-linked invite takes
   that seat *and its history*. That is inherent to `accept_group_invite` and
   predates this work; the 14-day expiry and the raw-token requirement
   (consent-guards §3.3/§3.5) are the existing mitigations.
3. **`accept_group_invite` has the same `TRUE AND NULL` bug** `[G1c]` fixed in
   `join_group_by_code` — its `was_already_connected` returns `null` rather than
   `false` when it rebinds a guest seat. Harmless today (the client treats it as
   falsy) and it lives in a file this batch does not own; worth folding in next
   time that function is touched.
4. **Closed.** The owner-only rename (`renameGroupGuest`) was validated
   client-side only — `tg_group_members_guest_seat_rules` is BEFORE INSERT
   only, so two owner devices could race two guests onto one name. A BEFORE
   UPDATE OF `display_name` twin, `group_members_guest_rename_rules` (guest
   seats only, same 1–40-char + live-duplicate rules, same stable error
   codes), now backstops it server-side.
5. **A guest cannot be "merged" into an existing contact.** They key by name
   like every other account-less person, so the `findLikelyDuplicateRows` hint
   in `whoOwesMe` is the only bridge, and no UI consumes it yet.
6. **`add_group_guest` is one round-trip per guest** at group creation. Fine at
   the 25-guest cap; if a bulk import ever lands, batch it server-side rather
   than looping harder.

## 10. Verification

* `supabase/tests/tests/8y-guest-members.sql` — 31 assertions covering §3's
  whole table plus the claim, the caps, the deletion guard and account deletion.
  `bash supabase/tests/run.sh` → **331 assertions, 0 failed**.
* `src/lib/groupGuests.test.ts` (16) and the guest block appended to
  `src/lib/whoOwesGroupInputs.test.ts` (3). `npx vitest run` → **1822 passed**.
* The migration's §6 verification block prints `p2-guest-members: OK` and
  re-reads every function body §3 depends on.
