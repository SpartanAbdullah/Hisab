# Edit history — "who changed what"

**Status:** SQL written and integration-tested, **pending manual apply**
(`supabase-migration-p2-edit-history.sql`). Client shipped: `editHistoryDb`,
`src/lib/editHistory.ts` (+ 21 unit tests), `EditHistorySheet`, mounted on
`LoanDetailPage`. Group surfaces are **not** mounted — see §6, which gives the
exact insertion points for the batch that owns those files.

Closes audit `docs/audit-2026-09/11-competitive-analysis.md` **G5 / O10**:

> Splitwise logs who added/edited/deleted every expense in a full activity log;
> Settle Up syncs edits in real time with member notifications. Hisaab has an
> activity feed (`/activity`) and client-side Undo/compensation
> (`mutationSafety.ts`) but **no surfaced who-changed-what history per record**.
> For a two-sided ledger — Hisaab's defining feature — edit accountability is
> the dispute-resolution layer; Settle Up's and Tricount's 2025 sync scandals
> (members seeing different/vanishing balances) show ledger-integrity doubt is
> the fatal failure mode.

---

## 1. Why none of the existing surfaces already did this

| Surface | What it holds | Why it is not an audit trail |
|---|---|---|
| `group_events` (`audit-p0-notifications` §5) | "Ali updated Hotel" | Records **that** a row changed, never which field or from what. Settles no argument. |
| `notifications` (+ `p2-notification-maturity`) | per-recipient display payload | Per-recipient, and pruned at 90 days read / 180 unread. |
| `group_expenses.version` | a monotonic integer | Proves a row changed. Holds no history. |
| `updated_by` / `deleted_by` | one uuid | **Client-writable**, inside the WITH CHECK envelope, and only the latest writer. Evidence of nothing. |
| `mutationSafety.ts` | inverse operations | Lives on the device that made the edit, for the duration of that flow. |

---

## 2. Schema

`public.record_edits` — append-only, server-written, one row per meaningful
change.

| Column | Type | Notes |
|---|---|---|
| `id` | `BIGSERIAL` PK | |
| `table_name` | `TEXT` | `group_expenses` · `group_settlements` · `loans` · `transactions` |
| `record_id` | `TEXT` | the audited row's own id |
| `group_id` | `TEXT` NULL | set for group rows only; FK → `split_groups` ON DELETE CASCADE |
| `owner_id` | `UUID` NULL | the audited row's `user_id`; FK → `auth.users` ON DELETE SET NULL |
| `actor_id` | `UUID` NULL | **`auth.uid()` only** (§4); FK → `auth.users` ON DELETE SET NULL |
| `actor_kind` | `TEXT` | `user` \| `system` |
| `action` | `TEXT` | `insert` \| `update` \| `soft_delete` (`delete` reserved, §5) |
| `changed` | `JSONB` | `{column: {old, new}}`, whitelist only |
| `created_at` | `TIMESTAMPTZ` | |

Indexes: `(table_name, record_id, created_at DESC)`, `(group_id, created_at
DESC) WHERE group_id IS NOT NULL`, `(owner_id, created_at DESC) WHERE owner_id
IS NOT NULL`, `(created_at)` for the prune.

Two columns beyond the minimum the task named, both load-bearing:

* **`owner_id`** — RLS must answer "may this user read this?" for a `loans` row
  whose loan `deleteLoanCascade` has since hard-deleted. A policy that joined
  back to `public.loans` would make a deleted loan's history readable by
  nobody, and would need a per-table `CASE`. One denormalized uuid survives the
  row it describes.
* **`actor_kind`** — after `ON DELETE SET NULL`, `actor_id` is NULL for a
  deleted account. Without `actor_kind`, "the system did it" and "a person did
  it and later closed their account" would be indistinguishable.

## 3. Trigger inventory

All four are `AFTER INSERT OR UPDATE … FOR EACH ROW`, all call the one generic
`public.tg_record_edits()` (SECURITY DEFINER, `search_path=public`), and each
carries its tracked-column whitelist as trigger arguments.

| Trigger | Table | Tracked columns |
|---|---|---|
| `group_expenses_record_edits` | `group_expenses` | `amount`, `description`, `date`, `notes`, `paid_by`, `split_type`, `splits` |
| `group_settlements_record_edits` | `group_settlements` | `amount`, `date`, `note`, `from_member`, `to_member` |
| `loans_record_edits` | `loans` | `person_name`, `person_id`, `total_amount`, `remaining_amount`, `currency`, `status`, `notes` |
| `transactions_record_edits` | `transactions` | `amount`, `currency`, `related_person`, `person_id`, `notes`, `created_at` |

`src/lib/editHistory.ts` exports `EDIT_HISTORY_TRACKED_FIELDS` as the client's
checkable copy of that table.

**Deliberately absent:** `source_account_id`, `destination_account_id` (§7),
`user_id`, `updated_at`, `version`, `deleted_at`, `created_by`, `updated_by`,
`deleted_by`, `is_reconciled`, `reconciled_at`, `reconciled_by`,
`receipt_path`, `conversion_rate`, `category`, `related_loan_id`,
`related_goal_id`, `related_investment_id`. A whitelist, never
`to_jsonb(NEW)` — the row is shared with group members.

### Composition with the triggers already on these tables

All four are **AFTER** triggers, so they cannot influence what any BEFORE guard
sees or rejects, and a refused write reaches them never (no history row for a
rejected edit). Fire order among AFTER triggers, by name:

```
group_expenses     …_notify → …_reconciliation_payer → …_record_edits
group_settlements  …_notify → …_record_edits
loans/transactions …_record_edits → trg_broadcast_*   (p2-realtime-broadcast)
```

The BEFORE stack (`…_block_when_archived`, `…_require_authorship`,
`…_require_connected_members`, `…_version_guard`, `…_validate_split_amounts`)
is untouched — this migration `CREATE OR REPLACE`s no function anybody else
owns and drops no trigger it did not create. `8z-edit-history.sql` exercises
the composition directly: the amount edit it asserts on is the same statement
that must satisfy `group_expenses_version_guard` (`version + 1`) and
`group_expenses_validate_split_amounts` (splits sum to amount).

### The three "don't log this" rules

1. **Pure `updated_at` / `version` bumps.** `trg_loans_touch` /
   `trg_transactions_touch` bump `updated_at` on every UPDATE. Since
   `updated_at` and `version` are not in any whitelist, the diff is empty and
   nothing is written. Proven: *"a pure updated_at bump writes NO history row
   (updated_at moved, history did not)"*.
2. **Mirror-only no-ops.** The offline mirror re-pushing an identical row
   produces the same empty diff. Proven: *"an UPDATE that changes no tracked
   column writes NO history row"*.
3. **Empty strings are absence.** `notes`, `note`, `date`, `description` and
   `related_person` all default to `''`, so `''` normalizes to `null` in the
   diff. `'' → 'paid at the table'` reads as *set the note*, not as a
   value-to-value change, and an INSERT never carries a meaningless
   `notes: ""`.

Numbers are compared as `jsonb`, which compares numerically — `500` and
`500.00` are the same value and produce no row.

## 4. The actor rule

`actor_id = auth.uid()`, and nothing else.

The notification triggers fall back to `NEW.updated_by` / `NEW.deleted_by`
(`audit-p0-notifications.sql:478`) because a wrong display name on a push is
cosmetic. An audit trail cannot afford it: those columns sit inside the
client's own WITH CHECK envelope, so a member could stamp another member's uuid
on their own edit. `8z-edit-history.sql` asserts this by having user A write
while naming B as `updated_by` and checking the history says A.

`auth.uid() IS NULL` (pg_cron, `service_role`, the push edge function) →
`actor_id = NULL`, `actor_kind = 'system'`.

## 5. RLS

One policy, SELECT only:

```sql
USING (
  (owner_id IS NOT NULL AND owner_id = auth.uid())
  OR (group_id IS NOT NULL AND public.is_group_member(group_id, auth.uid()))
)
```

* **Group rows** (`group_expenses`, `group_settlements`) carry `group_id`, so
  any **connected** member of that group may read them — plus the author via
  `owner_id`. This is the audited row's own SELECT policy
  (`audit-p0-group-ledger-integrity.sql:256`) restated: *a history row is never
  more visible than the row it describes.* `is_group_member` is connected-only,
  so an **ex-member sees nothing**, and a guest seat (no profile) can never
  match.
* **Personal rows** (`loans`, `transactions`) carry `group_id = NULL`, so only
  the owner matches. Being someone's counterparty grants nothing.

There is **no INSERT / UPDATE / DELETE policy**, and `INSERT`, `UPDATE`,
`DELETE` are revoked from `authenticated` and `anon` at the privilege layer
too. The only writer is the SECURITY DEFINER trigger. All three client write
doors are asserted closed.

**No DELETE trigger, on purpose.** Hard-deleting a group ledger row is already
impossible (`group-ledger-integrity` removed the DELETE policies). On
`loans` / `transactions`, a DELETE trigger would fire once per row during
`delete_current_user()`'s `DELETE FROM auth.users` cascade — writing a fresh
trail of a user in the middle of erasing themselves, and amplifying account
deletion without bound. `'delete'` is reserved in the CHECK so a future
migration can add it deliberately.

## 6. Client

### `editHistoryDb` (end of `src/lib/supabaseDb.ts`)

```ts
editHistoryDb.forRecord(table: EditHistoryTable, id: string): Promise<EditHistoryEntry[]>
editHistoryDb.forGroup(groupId: string): Promise<EditHistoryEntry[]>
```

Newest first, capped at 200 rows. No `add()` / `update()` — same shape as
`groupEventsDb`, and for the same reason. `PGRST205` / `42P01` throws
`EditHistoryUnavailableError` so a client that ships before the migration
degrades to "not available yet" instead of showing a finance app a red error.

### `src/lib/editHistory.ts` (pure, tested)

```ts
renderEditHistoryEntry(entry, ctx): EditHistoryLine[]
renderEditHistory(entries, ctxFor): { entry, lines }[]
EDIT_HISTORY_TRACKED_FIELDS   // the SQL whitelist, mirrored
isForbiddenHistoryField(f)    // /account_?id/i — dropped before rendering
```

`ctx` = `{ lang, actorName, memberName?, money?, date? }`. Actor resolution
needs stores, so it happens in the sheet; this module only substitutes.
No store, page, `supabaseDb` or `i18n` import — the whoOwesMe contract.

The **sentences** are `{ur, en}` templates here (data indexed by field name and
action); the **sheet chrome** is ordinary i18n copy in `src/lib/i18n.ts` under
`eh_*`.

| Template | ur | en |
|---|---|---|
| `changed` | `{actor} ne {field} {old} → {new} ki` | `{actor} changed {field} {old} → {new}` |
| `set` | `{actor} ne {field} {new} rakhi` | `{actor} set {field} to {new}` |
| `cleared` | `{actor} ne {field} hata di` | `{actor} cleared {field}` |
| `created` | `{actor} ne yeh entry banai` | `{actor} created this record` |
| `created_amount` | `{actor} ne yeh entry banai — {amount}` | `{actor} created this record — {amount}` |
| `deleted` | `{actor} ne yeh entry delete ki` | `{actor} deleted this record` |
| `deleted_amount` | `{actor} ne yeh entry delete ki — {amount}` | `{actor} deleted this record — {amount}` |
| `payer_changed` | `{actor} ne payer {old} se {new} kiya` | `{actor} changed the payer from {old} to {new}` |
| `payer_set` | `{actor} ne payer {new} rakha` | `{actor} set the payer to {new}` |
| `split_added` | `{actor} ne {name} ko split mein shamil kiya` | `{actor} added {name} to the split` |
| `split_removed` | `{actor} ne {name} ko split se nikala` | `{actor} removed {name} from the split` |
| `split_changed` | `{actor} ne {name} ka hissa {old} → {new} kiya` | `{actor} changed {name}'s share {old} → {new}` |
| `loan_settled` | `{actor} ne is qarz ko barabar mark kiya` | `{actor} marked this loan settled` |
| `loan_reopened` | `{actor} ne is qarz ko dobara khola` | `{actor} reopened this loan` |

Field labels are bilingual too (`amount` → `raqam`, `remaining_amount` →
`baqi raqam`, `date` → `tareekh`, …). Field render order is fixed, so two
clients reading the same row produce the same lines regardless of JSON key
order.

### `EditHistorySheet` + `EditHistoryRow` (`src/components/EditHistorySheet.tsx`)

```tsx
<EditHistorySheet
  open onClose
  table="group_expenses" recordId={expense.id}
  currency={group.currency}
  actorNames={…}   // profileId  → display_name  (names the ACTOR)
  memberNames={…}  // memberId   → display_name  (names split PARTICIPANTS)
/>
```

Actor resolution order: `actor_kind === 'system'` → `eh_actor_system`; no
`actorId` → `eh_actor_removed`; self → `eh_actor_you` (*Aap* / *You*); else
`actorNames[actorId]`; else `eh_actor_someone`. Relative timestamps use the
same `date-fns` `isToday` / `isYesterday` / `format` helpers as `ActivityPage`.

### Mounted

* `src/pages/LoanDetailPage.tsx` — `<EditHistoryRow>` sits directly below the
  Transaction-history block, and `<EditHistorySheet table="loans">` next to the
  other sheets. Always present, never gated on an edge case
  (`tasks/lessons.md`: a primary capability needs a persistent affordance).

### NOT mounted — exact insertion points for the owning batch

Those files are owned elsewhere; nothing below has been edited.

1. **`src/pages/GroupDetailPage.tsx`**
   * `import { EditHistorySheet } from '../components/EditHistorySheet';`
   * State next to `const [editExpense, …]`:
     `const [historyFor, setHistoryFor] = useState<{ table: EditHistoryTable; id: string } | null>(null);`
   * **Expense rows — `:1236`** (`expenses.map((expense, index) => {`). The row
     already opens `EditGroupExpenseModal` on tap (`:1243`), so history belongs
     as a small secondary control inside the row, not on the tap target.
   * **Settlement rows — `:681`** (`const fromName = group.members.find(…)`),
     the settlement renderer.
   * **Activity tab — `:1448`** (`events.map((event, index) => …)`). A
     `group_events` row and its `record_edits` rows describe the same act;
     showing "see what changed" on an `expense_updated` event is the highest
     value placement in the whole app.
   * **Mount the sheet at `:1544`**, in the modal block beside
     `<GroupSettleUpModal …>`:
     ```tsx
     <EditHistorySheet
       open={!!historyFor} onClose={() => setHistoryFor(null)}
       table={historyFor?.table ?? 'group_expenses'} recordId={historyFor?.id ?? ''}
       currency={group.currency}
       actorNames={Object.fromEntries(group.members.filter(m => m.profileId).map(m => [m.profileId!, m.name]))}
       memberNames={Object.fromEntries(group.members.map(m => [m.id, m.name]))}
     />
     ```
     `group.members` already carries both `profileId` and `id` (used at `:412`
     and `:413`), so no extra fetch is needed.
2. **`src/pages/EditGroupExpenseModal.tsx`** — the natural home. Its footer at
   **`:273–283`** holds Delete + Save; add an `<EditHistoryRow>` at the bottom
   of the body instead (the body starts `:284`). Especially valuable for the
   **non-creator** case: `:288–295` already tells a member "only {creator} can
   edit this" — the honest completion of that sentence is "…here's what they
   changed."
3. **`src/pages/SettleUpModal.tsx` / `GroupSettleUpModal.tsx`** — `Modal` opens
   at `SettleUpModal.tsx:147`. Lower value (a settlement is rarely edited);
   `table="group_settlements"`.
4. **`src/pages/TransactionsPage.tsx` / `EditTransactionModal`** — `table="transactions"`.
   Weigh against the volume risk in §8 before surfacing it broadly.

New chrome strings must go in `src/lib/i18n.ts` as `{ ur, en }`; the `eh_*`
block already exists.

## 7. Both app modes

The change JSON contains **no account id, in either mode**. `loans` has no
account column at all, and both `transactions` account columns are excluded
from the whitelist — because a `splits_only` row carries both as NULL and a
`full_tracker` row carries real ids, so tracking them would make the two modes
produce *different history for the same user action*.

Enumerated per mode, as `tasks/lessons.md` requires:

| Artifact | `full_tracker` | `splits_only` (ledger) |
|---|---|---|
| loan created / repaid → `record_edits` row | ✔ | ✔ (identical) |
| repayment `transactions` row → `record_edits` row | ✔ | ✔ — the ledger row has BOTH account ids null and still logs |
| group expense / settlement → `record_edits` row | ✔ | ✔ |
| account id anywhere in `changed` | ✖ | ✖ |

Three places pin it: the SQL verification V4 and the harness assertion *"no
record_edits trigger tracks an account id column"* (trigger definitions), the
harness assertions *"a splits_only transaction (both account ids NULL) records
exactly the same fields as a full_tracker one"* and *"NO history row anywhere
carries an account id"* (data), and the vitest cases in
`src/lib/editHistory.test.ts` (rendering, plus `isForbiddenHistoryField` as a
belt-and-braces drop).

## 8. Retention, and the volume risk

`prune_record_edits(p_days DEFAULT 180, p_limit DEFAULT 20000)` — bounded per
call, never granted to a client role, scheduled as `hisaab-prune-record-edits`
at `41 3 * * *` behind the same `pg_cron` guard `p2-notification-maturity` §9.1
uses (it unschedules only its own jobname). Without `pg_cron` the file applies
cleanly and prints the statement to schedule by hand.

180 days is a **dispute window**, not forensics — and deliberately ≥ the
notification retention (90 read / 180 unread) so a notification a member still
holds always still has its history behind it.

**The open risk is `transactions`.** It is by far the highest-write table in
the app (every saved expense, every repayment, every recurring run), and this
migration adds one INSERT to each of those writes — roughly doubling the row
count of a busy user's write path and adding a second table to the same
transaction. Mitigations in place: the narrow whitelist keeps each row small,
the empty-diff rule kills no-op updates, and the 180-day prune caps growth.
What is **not** yet known: real volume. Run **Q1/Q2** in the migration footer
after a week in production before trusting the 180-day figure; if
`transactions` dominates, the cheapest lever is dropping the `insert` action
for that one table (a transaction INSERT largely duplicates the row it
describes, and the dispute value is in the *edits*), followed by shortening
retention for `table_name = 'transactions'` specifically.

Second-order risks worth stating:

1. **No history exists for anything that happened before the migration is
   applied.** The sheet's `eh_unavailable_sub` string says so; the first weeks
   of any dispute will still be unanswerable.
2. **Hard deletes are invisible** (§5). `deleteLoanCascade` removes a loan and
   its transactions outright; their history rows survive as owner-readable
   orphans (Q5 censuses them) but nothing records the deletion itself.
3. **A group's history dies with the group.** `group_id` is
   `ON DELETE CASCADE`, matching the ledger rows themselves.
4. **`actor_kind = 'system'` erodes the trail.** Any future definer path that
   runs without a JWT logs anonymously. Q4 is the census; a rising `system`
   share on group tables is the signal.

## 9. Verification

* `supabase-migration-p2-edit-history.sql` — V1–V6 in-file, prints
  `p2-edit-history: OK`; Q1–Q6 operator queries; a rollback block.
* `supabase/tests/tests/8z-edit-history.sql` — **26 assertions**, part of the
  corpus run: `bash supabase/tests/run.sh` → **357 assertions, 0 failed**
  (`postgres:15`, 71 files applied in `apply-order.txt` order).
* Idempotency: applied **three times** in a row against the fully migrated
  database — clean each time, output limited to `already exists, skipping`
  notices plus `p2-edit-history: OK`.
* `src/lib/editHistory.test.ts` — 21 vitest cases (diff rendering, both
  languages, split add/remove/reshare, order-insensitivity, malformed input,
  determinism, account-id containment).
