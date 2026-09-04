# The offline story — a decision memo

**Written:** 2026-09-02 · **For:** the founder · **Decision needed:** D5 in `docs/audit-2026-09/P0-REMEDIATION.md` §6.1 ("M1 — the offline story")

**Status (2026-09-04):** D5 decided — Option A approved and implemented in the same change; see §5. The file and line references in §1–§2 describe the tree as it stood on 2026-09-02, before the deletion.

This resolves one open founder decision, not a new finding. Every claim below cites the file that proves it.

---

## 1. Where things stand today

**No offline write path exists, and the app no longer claims one.**

- `src/lib/outboxRunner.ts:26-30` gates the entire runner behind `VITE_ENABLE_OUTBOX` (default off), and even with the flag on, `dispatch()` (`outboxRunner.ts:157-180`) throws `"Outbox dispatch not yet implemented"` for every one of its 12 op kinds. Nothing has ever drained an outbox row in production.
- `src/db/database.ts:19-38` documents the intended design ("Dexie is hydrated from Supabase pulls... user mutations write to BOTH Dexie and an outbox table") and says plainly: *"Current commit ships ONLY the schema + outbox primitives. The stores are not yet rewired."* That was true when written and is still true today — `enqueueOutboxOp` (`outboxRunner.ts:108-124`) has zero production callers from any store.
- The Settings "Sync Status" card that would show a queued-changes count is itself dead: `src/pages/SettingsPage.tsx:159-165` gates it behind the same flag with a comment reading *"the outbox is inert in shipping builds... it returns the day the outbox actually ships."* The "stuck operations" panel `outboxRunner.ts`'s own header describes (lines 13-15) does not exist anywhere in `SettingsPage.tsx` — the doc-comment is aspirational, not shipped.
- The honest copy already ships: `src/lib/i18n.ts:2815` — `err_offline`: *"You're offline — this entry was not saved. Try again once you're connected."* — with a code comment above it (`i18n.ts:2813-2814`) stating the same fact this memo does.
- The Play listing's "Offline-first — syncs when you're back online" claim was **already removed** on 2026-09-02 (`docs/play-store-listing.md:146`), per audit finding 12-qa-review.md F-1 / O-2. `docs/go-to-market.md:49` explicitly says not to reintroduce it until the outbox is "actually built and integration-tested."

**What changed since the audit that matters for this decision:** the atomic-RPC work (L4, `docs/server-side-money-engine.md`) makes each *individual* money move all-or-nothing **when the device is online**. Transfer, repayment, and loan-creation now have `SECURITY DEFINER` RPCs (`transfer_between_accounts`, `record_loan_repayment`, `create_loan_with_leg`) that either commit every leg or none, behind `VITE_ATOMIC_TRANSFER` / `VITE_ATOMIC_REPAYMENT` / `VITE_ATOMIC_LOAN_CREATE` — all default off, migrations not yet applied to production (`server-side-money-engine.md:1-3`, `P0-REMEDIATION.md:195`). This closes the *half-moved-money* failure (MF-01/F-4) for the flows it covers. It does **not** touch the separate question this memo answers: what happens when there is no connection at all. `server-side-money-engine.md` says so itself under "What this does not solve" (line ~181): *"An atomic RPC still needs a connection... the honest interim answer remains 'Hisaab needs a network to record money.'"*

So: two different problems, two different fixes. Atomic RPCs fix **corruption while online**. This memo is about **what to do about being offline** — which today means "nothing is recorded, and the app says so."

---

## 2. Three options

### Option A — Delete the scaffold; the app is explicitly online-required

**What it is:** Remove the inert outbox code entirely. Keep (and lean into) the existing `err_offline` copy and retry-on-reconnect UX. State plainly, in docs and in the app, that Hisaab needs a connection to record money.

**What to remove:**
| File | What goes |
|---|---|
| `src/lib/outboxRunner.ts` | Whole file — `startOutboxRunner`/`stopOutboxRunner`/`enqueueOutboxOp`/`dispatch`/stuck-op helpers |
| `src/db/database.ts` | `OutboxOpKind` type (40-52), `OutboxEntry` interface (54-64), the `outbox` table field (96) and its schema declarations (v6 line 180, v7 line 199) — or leave the Dexie schema as inert dead weight if a version bump feels riskier than it's worth |
| `src/App.tsx` | Import at line 111; the `startOutboxRunner()`/`stopOutboxRunner()` calls at 491-501 |
| `src/pages/SettingsPage.tsx` | `OUTBOX_UI_ENABLED` block (159-165), `outboxCount` state + `db.outbox.count()` read (282-296), the guard at 336-338, the whole "Sync Status" card (1484-1531) |
| `src/lib/i18n.ts` | `sync_queued_label` (1480) and its sibling `sync_queued_n`/`sync_queued_zero`-style keys once the card that reads them is gone |
| `.env.example` | `VITE_ENABLE_OUTBOX` entry |

**Keep as-is:** `err_offline` (`i18n.ts:2815`), `offline_banner` (`i18n.ts:4231`), `OfflineBanner.tsx`, `useOnlineStatus.ts` — these already do the honest job: detect offline, say so, block the save, let the user retry once reconnected. DB-first write ordering (`loansDb.add` before state update, etc. — `12-qa-review.md` §4.7) already guarantees a fully-offline write fails cleanly with no phantom local row.

**Effort:** S (a few hours — mostly deletion, one PR).
**Trade-off:** Loses nothing the app actually does today. Gains: no dead code pretending to be a feature, no future contributor mistaking `enqueueOutboxOp` for a working call, no risk of someone flipping `VITE_ENABLE_OUTBOX` and shipping silent data loss (every queued entry would sit forever since every dispatch handler throws).

### Option B — A narrow queue-and-replay outbox for low-risk single-row entries only

**Scope:** Only entries that are (a) single-table, single-row writes and (b) not cross-user: `expense`/`income` in full_tracker via the atomic CAS path, and ledger-mode (`splits_only`) loan creation. These are the branches `server-side-money-engine.md:177` already calls out as needing "no RPC" because they're single-leg — one balance write plus one row (or, for ledger loans, one row with no balance leg at all).

**Design:** Persist the mutation's payload in Dexie keyed by the client-generated transaction/loan id (the same id the atomic RPCs already use as an idempotency key — `server-side-money-engine.md` §2.3, §9). Replay drains the queue through the *same* atomic RPC/CAS path a live save would use, so a replay is provably idempotent: re-sending an id the server already has returns `{status:'ok', replay:true}` and moves nothing twice.

**What it would NOT cover — explicitly:**
- Transfers, repayments, loan creation with EMI schedules or cash advances — anything multi-leg. (The atomic RPCs make these safe *online*; queuing them offline reopens the exact half-applied-state risk the RPCs were built to close, because a client can't know if a queued multi-leg call partially landed before the connection dropped.)
- Any cross-user flow: linked loan requests, group expenses/settlements, kameti actions, invites. These require the *other* party's account to exist and their consent state to be current at write time — replaying a stale queued request against a server state that moved (they already rejected it, the group is gone, they blocked you) is a correctness problem, not just a UX one.
- Anything touching `linked_profile_id`, group membership, or any predicate the audit's C6/H2 already flagged as forgeable — a queued write is client state from potentially minutes or hours ago; replaying it against current server truth needs its own conflict story that doesn't exist yet.

**Conflict UX:** A replay that the server refuses (stale CAS, account deleted meanwhile, insufficient balance now) surfaces as a "some things you did offline couldn't be saved" review list — not a silent drop and not a silent retry-forever. This is new UI that doesn't exist today.

**Effort:** M (single-row plumbing is real work: a queue table, a drain loop, retry/backoff, the review-list UI, and an integration-test harness proving replay is actually idempotent against the live RPCs — this is most of what the existing scaffold *intended* but never delivered).

### Option C — Full offline-first (the original scaffold's ambition)

**What it is:** What the `database.ts` header from Phase 3 originally described — every entity mirrored, every mutation queued, full read/write parity offline including cross-user flows, groups, kameti.

**Why not, per this audit:**
- The cross-user consent model (`05-security.md` H2/H3/H6, `P0-REMEDIATION.md` C6) depends on server-side state at the moment of action — group membership, invite status, block lists, linked-profile consent. A client queuing a group expense or a settlement offline has no way to know if the group still exists, if it's still a member, or if the other side revoked consent since the device went dark. Replaying blind risks exactly the shared-ledger corruption class C2-C4 already document (falsified/duplicated settlements, over-settled debts).
- The multi-leg money flows (transfer, repayment, loan-with-EMI, cash advance) that the L4 program is *still mid-way through* atomizing would need their offline replay logic built against a moving target — every RPC template in `server-side-money-engine.md` §6 assumes a live connection to lock rows and CAS.
- `02-repository-architecture.md` H-4 already calls partially-wired write mirroring "the classic source of split-brain bugs when someone later flips the flag" — full offline-first is that risk at 10x the surface area.
- Real effort: this is the L-sized, multi-week item every audit report already scored it as (`00-executive-summary.md` M1, roadmap). It touches every store, every RPC, every RLS-adjacent flow, and needs an integration-test harness that doesn't exist yet (`12-qa-review.md` M-7 notes zero automated RLS/RPC testing today; `testing-the-trust-boundary.md`'s harness is new and SQL-only).

**Effort:** L (multi-week, and the real risk is data corruption in production, not schedule).

---

## 3. Recommendation

**A now.** Delete the scaffold before launch. It is dead code standing in for a promise the listing no longer makes, and every day it stays it's a trap for a future contributor (or an agent) who sees `enqueueOutboxOp` and assumes it works. This is hours of work, not weeks, and it directly closes P0-REMEDIATION D5's "or delete the scaffold and be honest" branch.

**B as a post-launch experiment, gated on telemetry — not before.** Don't build it speculatively. Ship analytics first (it's already wired — see `docs/audit-2026-09/P0-REMEDIATION.md` H2), watch two signals for a real launch cohort, and only spec Option B if the data says offline failures are a material share of drop-off:
- **`error_surfaced`** (`src/lib/telemetryEvents.ts:194`) filtered to `feature: 'money_mutation'` — this is the bridge from `reportError()` calls, which includes every `mutationSafety.rollback.*` and `runSafeMutation.*` signal (`src/lib/mutationSafety.ts:16-30`). A spike here that correlates with `is_logged_in`/low-connectivity sessions is the offline-failure signal.
- **`quick_entry_abandoned`** (`telemetryEvents.ts:129`, props `last_step` + `had_amount`) — if abandonment concentrates at the save step with an amount already entered, that's consistent with save failures (offline among them) killing entries users meant to complete.
Only if both trend the way that story predicts is Option B's effort justified — and even then, scope stays exactly as narrow as §2 describes: single-row, non-cross-user only.

**C never, in its original form.** The audit's own findings (consent model, in-flight L4 program, zero RLS/RPC test harness at the time C1's fix shipped) make full offline-first a data-corruption bet, not a feature. If it's ever revisited, it's after L4 finishes (all branches, not just three) and after `testing-the-trust-boundary.md`'s SQL harness has real production-parity coverage — a precondition, not a schedule.

---

## 4. The real answer to "half-moved money": L4, already rolling out

Option A ships the honest offline story; it does not fix corruption-while-online, because that was never the outbox's job — `mutationSafety.ts`'s own header (`:10-13`) already admits compensations can fail in the same outage that broke the forward write. The actual fix for that is the atomic-RPC program already in flight: `docs/server-side-money-engine.md` §5/§10/§15 give the flag order — `VITE_ATOMIC_TRANSFER` first (one release cycle solo), then `VITE_ATOMIC_REPAYMENT`, then `VITE_ATOMIC_LOAN_CREATE` — web before Android each time, never two flags flipped together ("an incident un-bisectable" — `server-side-money-engine.md:292`). Card-bill-pay (branch 5) and `goal_contribution` remain unbuilt (`server-side-money-engine.md` §6 table, `P0-REMEDIATION.md:195`). This is the rollout to point to whenever "what about half-applied transfers" comes up — it is a separate, already-answered question from this memo's offline scope.

---

## 5. The decision line, and what it changes in the listing

> **Decided: YES — Option A, 2026-09-04.** The scaffold is deleted in this change: `src/lib/outboxRunner.ts` is gone; `OutboxOpKind`, `OutboxEntry` and the `outbox` Dexie store are removed from `src/db/database.ts` (schema version 8 drops the object store from existing devices — the v6/v7 declarations stay because Dexie needs the history); the `startOutboxRunner`/`stopOutboxRunner` lifecycle is removed from `src/App.tsx`; the Settings "Sync Status" card, its `OUTBOX_UI_ENABLED` gate, the mirror-snapshot helper that fed it and its `sync_*` i18n keys are removed; `VITE_ENABLE_OUTBOX` is removed from `.env.example`. Hisaab is explicitly online-required for writes — `err_offline`, `offline_banner`, `OfflineBanner.tsx`, `useOnlineStatus.ts` and the DB-first write ordering stay as the honest UX. **Option B stays a backlog item, not a commitment** — gated on the two §3 telemetry signals (`error_surfaced` filtered to `money_mutation`, `quick_entry_abandoned`) from a real launch cohort.
>
> **The founder's stated view when approving:** offline "can work with the Android app but not the web app." **The answer, for the record: platform is not the constraint.** Both surfaces are the same bundle — the Android app is the web build running inside a Capacitor WebView, with the same IndexedDB and the same stores — so anything that queued and replayed on Android would behave identically in the PWA, and vice versa. The real constraint is *which writes are safe to replay*: personal single-row entries (an expense, an income, a ledger-mode loan — one row, one owner, idempotent by client-generated id) **yes**; cross-user or multi-leg flows (transfers, repayments, linked loans, group expenses and settlements, kameti) **no**, for the reasons §2 Option B lists. If Option B is ever built, that line — not the platform — is its scope, on both surfaces at once.

What each choice does to `docs/play-store-listing.md`:
- **A (recommended):** No listing change needed — the offline-first claim is already removed (line 146) and stays removed. Nothing to write until B or C ships. Optionally add one line to the "no lending, no custody" honesty block: *"An internet connection is needed to save entries"* — already implied by line 43's parenthetical (`"...an internet connection is needed to log entries"`) but could be stated more directly if the founder wants zero ambiguity for reviewers.
- **B, once shipped and device-verified:** Listing could add a scoped claim — *"expenses and udhaar you log while offline save automatically once you're back online"* — but must NOT say "offline-first" or claim group/split/kameti coverage, since B deliberately excludes those. Any such claim needs the same device-verification bar the audit already applied to the PIN claim (`go-to-market.md:48`) before it goes live.
- **C:** Not a near-term listing question — see §2.
