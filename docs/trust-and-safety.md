# Trust & safety in Hisaab — the block/report model

**Written:** 2026-09-02 · **Status:** SQL written and Docker-validated; **not yet applied to production**, and the client half is **not built**.
**Migration:** `supabase-migration-p2-trust-safety.sql` (apply after all `audit-p0-*` and all `p1-*` files).
**Closes:** audit `M17` (no block/mute/report), `M19` + `UX-24` (witness-link lifecycle), `M13` + `F-ST1` (receipts), `UX-13` (rejection reason), and the discovery half of `H10`.

---

## 1. Why this exists

`docs/audit-2026-09/05-security.md` M17:

> Declining is per-item, not per-sender: rejected loan requests can be re-sent indefinitely, force-added groups can't be muted, and there is no report path. For a demographic where debt intimidation is a real harassment pattern, the first determined harasser becomes a trust-and-safety incident with no product answer.

Hisaab's whole pitch is a trustworthy record of informal money between people who know each other. That is exactly the relationship in which harassment happens — a lender who will not stop asking, a relative who keeps re-adding you to a group, an ex who keeps sending loan requests you have to decline one at a time. Before this migration the app had no answer at all, and Google Play's UGC policy expects one.

---

## 2. The model, in three rules

### RULE 1 — A block is one-sided and silent

The person you block is never told. Every refusal reuses a status value that already existed in that RPC for an innocent cause, so being blocked is indistinguishable from a wrong code, a contact who turned discovery off, or an invite that was withdrawn.

Where the **caller is the blocker**, the caller already knows, so they get a plain answer — that leaks nothing and is better product.

| Interaction | What the **blocker** sees | What the **blocked person** sees |
|---|---|---|
| Looking up the other's profile code | `BLOCKED_BY_YOU` (uncharged) | zero rows — same as a bad code, and the attempt is charged to the same 20/hour window |
| Phone discovery | the other simply is not in the results | the other simply is not in the results |
| Linking a contact by code | `BLOCKED_BY_YOU` | `NO_MATCH`, charged — same row, same accounting as a miss |
| Linking a contact by discovery | `BLOCKED_BY_YOU` | `NO_MATCH`, charged to the phone window |
| A contact-link ask already in the inbox | `reason_code: BLOCKED` | it silently resolves as `DECLINED` — no contact row, no notification back |
| Joining a group the other **owns** by code | n/a (owner can't join their own) | `INVALID_OR_EXPIRED_CODE` + one `succeeded=false` attempt row — identical to a dead code |
| Accepting an invite link into a group the other **owns** | n/a | `INVITE_NOT_FOUND_OR_EXPIRED` + one failure row — identical to a dead token |
| Accepting an owner's group invitation | n/a | `NO_PENDING_INVITE` — identical to a withdrawn invite |
| Owner force-adds the other to their group | the INSERT raises `GROUP_MEMBERSHIP_BLOCKED` | nothing happens; no row is ever created |
| A new linked **loan** request | `ltr: recipient is not accepting requests` | same neutral message (worded so it also fits a future "requests off" setting) |
| Group activity in a group they share | their action still writes the shared `group_events` row | **no notification, no push** |
| An existing linked loan | fully usable | fully usable — see RULE 2 |

Consequences that are load-bearing, not incidental:

- `public.blocks` has **no SELECT policy naming `blocked_id`**. The blocked party cannot read, count, or infer a row about themselves.
- `is_blocked_either_way()` and `has_blocked()` are **REVOKED from `authenticated` and `anon`**. There is deliberately no client-callable RPC that answers "is this pair blocked" — one would hand the blocked party the exact bit the model exists to withhold. Every caller is itself `SECURITY DEFINER`.
- Blocking is keyed on the auth user id, so **a harasser who deletes and re-registers gets a clean slate.** Phone-level blocking needs H10's OTP work first. Say this in the help copy rather than implying otherwise.

### RULE 2 — A block stops new relationships, not existing debts

**Blocked:** new contact links (either direction), new linked loan requests *and their acceptance*, joining or being added to a group the blocker owns, discovery by phone or code, notifications between the pair.

**Not blocked:** settling an **already accepted** linked loan pair, reading a shared group ledger you are already a member of, leaving a group, declining an invitation, rejecting or cancelling a request.

The settlement carve-out is the important one and it is deliberate. A settlement request can only exist for a loan pair both people already accepted. If blocking froze it:

- a debtor blocked by their creditor could never record a repayment — the creditor's block would freeze the debt in place; and
- a creditor blocked by their debtor could never be repaid.

Either turns a safety feature into a debt-collection weapon. Winding an existing obligation *down* is precisely what a blocked pair still needs to do. The client copy should say so: **"You can still settle up what's already between you. Block stops anything new."**

The corollary for the user: if they want zero contact, the sequence is *settle to zero, then block* — and the block sheet should offer that as the next step when a live balance exists.

Refusal paths are never blocked either. `decline_group_membership`, `leave_group`, `reject_linked_request` and `reject_settlement_request` all keep working, because a user must always be able to clear their own inbox and exit.

### RULE 3 — A block is not a deletion

Existing contact rows, loans, group memberships, ledger rows and already-delivered notifications are untouched. Blocking is about what happens next. Unblocking (`DELETE FROM blocks`) restores everything with no side effects — validated end to end.

---

## 3. Reporting

Reporting is a separate action from blocking and the UI must offer both, because they do different things: **block protects you now; report tells the operator.**

- `public.reports` is **INSERT-only for clients**. There is no SELECT policy at all, so PostgREST returns nothing to `authenticated` no matter what. Only `service_role` and Supabase Studio can read the queue. A readable report table would tell a harasser they had been reported.
- Both user FKs are `ON DELETE SET NULL`, not CASCADE — a report must outlive the accounts involved, or a reported user deletes their account and erases the operator's only record. Validated: after the reporter deleted their account, the reports survived with `reporter_id = NULL`.
- Capped at **20 reports per reporter per rolling day** (`REPORT_RATE_LIMITED`). `reason` ≤ 128 chars, `details` ≤ 2000, all trimmed, empty-to-NULL.
- `reviewed_at` is the operator's triage marker. No client can read or write it.

**There is no operator console.** Working the queue today means running SQL in Studio:

```sql
select r.created_at, r.reason, r.details, r.context_type, r.context_id,
       rep.name as reporter, tgt.name as reported
  from public.reports r
  left join public.profiles rep on rep.id = r.reporter_id
  left join public.profiles tgt on tgt.id = r.reported_id
 where r.reviewed_at is null
 order by r.created_at desc;

-- mark handled
update public.reports set reviewed_at = now() where id = '…';
```

That is acceptable for launch volume, but it is a real operational gap — someone has to own checking it. Put it in the launch runbook.

---

## 4. Client follow-ups — exact contracts

Nothing below exists yet. Every string needs a `{ ur, en }` entry in `src/lib/i18n.ts` (roman Urdu is the default language).

### 4.1 Blocking — plain table access, no RPC

```ts
// Block. Idempotent: the PK is (blocker_id, blocked_id).
await supabase.from('blocks').insert({
  blocker_id: getUserId(),        // must equal auth.uid() — RLS enforces it
  blocked_id: theirProfileId,
  reason: freeText ?? null,       // trimmed + capped to 500 server-side
});

// Unblock.
await supabase.from('blocks').delete().eq('blocked_id', theirProfileId);

// My block list (the blocked party can never see these rows).
const { data } = await supabase.from('blocks').select('blocked_id, reason, created_at');
```

There is **no UPDATE policy**: changing a reason is delete + insert, which keeps `created_at` honest. `blocked_id` must be a real user (FK). Self-blocks are rejected by a CHECK.

### 4.2 Reporting — plain INSERT

```ts
await supabase.from('reports').insert({
  reporter_id: getUserId(),
  reported_id: theirProfileId,
  context_type: 'inbox_item' | 'contact' | 'group_member' | 'group_expense' | 'kameti',
  context_id: entityId,
  reason: 'harassment' | 'spam' | 'impersonation' | 'wrong_amounts' | 'other',
  details: freeText,
});
```

Reading it back is impossible by design — the UI must show an optimistic "Report sent" confirmation, not a fetched list. Handle `53400` (`REPORT_RATE_LIMITED`) with a calm message, not an error toast.

### 4.3 Where the actions belong

| Surface | File | What to add |
|---|---|---|
| **Inbox item** (loan / settlement / contact-link request) | `src/pages/InboxPage.tsx` | Overflow menu on each card: *Report* and *Block this person*. This is the audit's own recommendation — "declining is per-item, not per-sender" is exactly the gap. |
| **Contact sheet** | `src/pages/ContactDetailSheet.tsx` | *Block* / *Unblock* in the sheet's menu, below Archive. Show the live balance in the confirm sheet and, when it is non-zero, the "settle up first" nudge from RULE 2. |
| **Group member list** | `src/pages/GroupDetailPage.tsx` | Per-member *Report* / *Block*. Copy must be honest: blocking a fellow member stops notifications between you, it does **not** remove them from the group and does not hide their ledger rows. |
| **Kameti** | `src/pages/KametiDetailPage.tsx` | Not a block surface (members are organiser-typed rows, not accounts). This is where the witness-link controls go — §4.5. |
| **Settings** | `src/pages/SettingsPage.tsx` | A "Blocked people" list with unblock. Users need to see and undo what they did. |

### 4.4 New / changed status values the client must handle

| RPC | New value | Meaning |
|---|---|---|
| `link_contact_by_code` / `link_contact_by_discovery` | `BLOCKED_BY_YOU` | Show "You blocked this person. Unblock them first." Only ever returned to the blocker. |
| `respond_contact_link` | `reason_code: 'BLOCKED'` | Same message. |
| everything else | *(no new values)* | A blocked pair reuses `NO_MATCH`, `INVALID_OR_EXPIRED_CODE`, `INVITE_NOT_FOUND_OR_EXPIRED`, `NO_PENDING_INVITE`. **Do not special-case these** — that would leak the block back to the blocked party through the UI. |

### 4.5 Kameti witness link — **BREAKING**

`src/stores/committeeStore.ts:154-161` (`ensureShareToken`) and `src/lib/supabaseDb.ts:2437` (`committeesDb.update({ shareToken })`) now **raise** `committees: WITNESS_TOKEN_IS_SERVER_ONLY`. The token is server-generated and only its SHA-256 is stored.

```ts
// Replaces ensureShareToken. Returns the raw token EXACTLY ONCE — it is never
// stored and cannot be re-read. Rotating invalidates the previous link.
const { data } = await supabase.rpc('rotate_committee_witness_token', { p_committee_id: id });
// { status: 'ok', token: '<64 hex>', expires_at: '…', initials_only: bool, replaced_previous: bool }
// { status: 'NOT_FOUND' }  — not the organiser (or no such kameti)
// { status: 'NOT_AUTHENTICATED' }

await supabase.rpc('revoke_committee_witness_token', { p_committee_id: id });
// { status: 'ok', was_active: bool }

// initials-only is an ordinary owner-writable column, no RPC needed
await supabase.from('committees').update({ witness_initials_only: true }).eq('id', id);
```

`get_committee_witness(p_token)` is unchanged in shape; its payload gains `committee.witnessExpiresAt` and `committee.initialsOnly`.

UI work:

1. **`committees.share_token` is nulled by the migration.** Any existing link the organiser wants to re-share must be re-minted. Existing *already-shared* links keep working (the migration hashes them in place) and now expire in 90 days — but the app can no longer display them. Handle a null `shareToken` as "no active link" and offer *Create link*.
2. **Show the token once.** A copy/share sheet at rotate time, and never again. The old "share witness" button becomes *Create link* / *Replace link*.
3. **The privacy warning UX-24 asks for**, before the first share: this link shows every member's name, slot and paid/unpaid status to anyone who opens it, it can be forwarded, and it works for 90 days.
4. **Initials-only toggle** in kameti settings, with a live preview ("Ali Raza → A.R."). UX-24's "named delinquency" concern; slots and paid/unpaid stay visible so the ledger is still provable.
5. **Revoke button** — "Stop sharing". UX-24: there is currently no un-share path at all.
6. **`src/pages/KametiWitnessPage.tsx`**: show the expiry, and render the initials-only state as a deliberate privacy setting rather than as missing data. A revoked or expired token returns `null`, same as a bad one — the existing "not found" state covers it.
7. **`src/lib/kametiSlipPdf.ts:72-79`** prints the witness URL into every payout slip. Once links expire and rotate, a printed slip goes stale. Either stop embedding the URL, or print the expiry date next to it.

### 4.6 UX-13 — the rejection reason

**No schema work is needed and none was done.** The reason channel has existed since April: both tables carry `rejection_reason` and both RPCs already take `reason text default null`. The client simply never sends it — `handleReject` in `src/pages/InboxPage.tsx:400-418` (and settlements at `:491-509`) is a bare `confirmDestructive`, while the card at `:1341-1343` renders `request.rejectionReason`, which is therefore permanently empty.

*Adding a second `reject_reason` column would have been a bug* — two columns with one meaning, data split between them, and the card that already reads the old one broken.

```ts
await supabase.rpc('reject_linked_request',     { request_id: id, reason: text || null });
await supabase.rpc('reject_settlement_request', { request_id: id, reason: text || null });
```

The migration adds normalisation: trimmed, empty-to-NULL, capped at 500 characters. So an untouched optional field stores NULL and the card stays hidden, exactly as today. Replace the confirm dialog with a sheet carrying an optional one-line "Why? (optional)" input — "it was 300, not 500" is the case the audit names.

### 4.7 Receipts — **BREAKING for large files**

The `receipts` bucket now enforces a **5 MiB** cap and a MIME allowlist (`image/jpeg`, `image/png`, `image/webp`, `application/pdf`).

`src/lib/receiptStorage.ts:47-63` compresses to a 1280px JPEG at q0.7 (~150-300 KB), but **falls back to the original file** whenever the browser cannot decode it — HEIC is the common case — while still declaring `contentType: 'image/jpeg'`. Those uploads will now fail with no user-facing message.

Client work: check `file.size` before upload and show a translated "This photo is too large — try a smaller one" message. Once that lands, tighten the bucket to 2 MiB (the audit's own recommendation) with a one-line SQL change.

### 4.8 Account deletion

`delete_current_user()` now deletes the caller's `receipts/<uid>/` rows from `storage.objects` before removing the auth identity. No client change. **But read §6.1 — this is not a complete purge.**

---

## 5. Google Play UGC policy mapping

Play's User Generated Content policy applies to Hisaab because users send each other free text (loan notes, group expense descriptions, rejection reasons, kameti names) and can add each other to shared spaces. The store listing and the Data safety form both need this to be true, not aspirational.

| Play UGC requirement | How this migration answers it | Client work still required |
|---|---|---|
| **An in-app system for reporting objectionable content and users** | `public.reports` — INSERT-only, capped, operator-reviewed, survives account deletion | Report actions on inbox items, contact sheet, group member list (§4.3) |
| **An in-app system for blocking users** | `public.blocks` + enforcement at 13 cross-user entry points | Block/unblock actions + a "Blocked people" list in Settings |
| **Published, enforced terms / content policy** | — | A short in-app "Community rules" page and a link from the Play listing. Not written yet. |
| **Moderation that is actually performed** | `reports.reviewed_at`, Studio queue (§3) | Someone must own the queue. Name them in the launch runbook. |
| **Account termination for repeat offenders** | The operator can set `profiles.is_deleted` via existing tooling | No self-serve path; document the manual procedure |
| **Data safety: what is shared with other users** | Unchanged by this file, but note the kameti witness link is now expiring and revocable, which makes the "shared publicly" answer defensible | Update the Data safety form if the witness link is declared |

**Honest gap:** Play also expects moderation of the content itself (not just the person). Hisaab has no text moderation and does not need one at this scale, but the *reporting* path is what the policy actually requires and that now exists end to end.

---

## 6. Open risks

### 6.1 The receipt purge deletes the index row, not necessarily the file
Deleting a `storage.objects` row removes Storage's index entry — after it, no signed URL can be minted and no list call returns the object. It does **not** itself issue a delete against the underlying S3/GCS blob. For a hard guarantee the operator must also run a storage-API purge (`supabase.storage.from('receipts').remove([...])` with the service-role key, or the dashboard). Until that is automated (an edge function on account deletion would do it), **account deletion is a logical purge, not a physical one** — do not claim otherwise in the privacy policy. The migration warns loudly if the DB-side purge itself fails, and never lets a Storage problem block a right-to-delete.

### 6.2 The "merely a member" carve-out is a real, deliberate hole
A blocked user can still join a group whose owner they have not blocked, even if the blocker is a member of it. Two reasons, both stronger than closing it: (a) letting one member silently exclude arbitrary others from a group they do not control is a bigger abuse surface than the one it closes; (b) a join that failed because of a *member's* block would tell the joiner exactly who is inside a group they cannot see — a membership oracle of the same shape as audit M16. The victim is still protected inside that group (no notifications, no push), but they will see the other person in the member list and in the ledger. **The block sheet copy must say this**, or users will believe they are more protected than they are.

### 6.3 Block is per-account, and accounts are free
A harasser deletes and re-registers with a new email and gets a fresh id. Nothing in SQL can fix that; it needs phone verification (audit H10, currently unverified claims with a "verified" badge on top). This is the single largest residual in the whole model.

### 6.4 `is_blocked_either_way` is evaluated per recipient in the group fan-out
Up to 100 index lookups per group action. `idx_blocks_blocked` covers the reverse direction and the PK covers the forward one, so each is a two-column index probe on a table that will be tiny. Fine at launch volume; if `blocks` ever grows large, this is where to look. Never `EXPLAIN`ed under load — the whole batch has this limitation (`APPLY-ORDER.md` §7).

### 6.5 The `storage.objects` metadata guard may not fire
On real Supabase the object row is created and its `metadata` (carrying `size` and `mimetype`) is populated by the storage service, so a `WITH CHECK` on metadata can see NULL at insert time. The guard tolerates NULL by design. **The bucket-level `file_size_limit` / `allowed_mime_types` is the real enforcement**; the filename-extension allowlist is the part of the policy that always fires. Not verifiable in the harness (see §7).

### 6.6 Unbounded receipt object COUNT is still open
The size cap stops 50 MB objects; it does not stop one account writing many small ones under arbitrary names inside its own `{uid}/` folder. Closing it needs either a per-user object-count cap in the insert policy (a count query per upload) or tying object names to real transaction ids. Neither is in this file. M13's headline scenario is closed; this residual is not.

### 6.7 Blocking does not retract what was already delivered
Already-sent notifications, an existing contact row on the other side, and past ledger entries all survive (RULE 3). That is correct — a financial record must not vanish because of a social action — but it means "block" does not mean "erase". The confirm sheet should say what block does and does not do, in one line each.

---

## 7. What the Docker validation covered

`postgres:15` + a Supabase-shaped scaffold, exactly the harness `docs/audit-2026-09/APPLY-ORDER.md` §3 describes.

**Applied in order:** `supabase-schema.sql` + the 40 historical migrations + the 11 `audit-p0-*` files + the 4 `p1-*` files (**56 files, 0 failures**), then `supabase-migration-p2-trust-safety.sql` **twice** — the second pass clean, so the idempotency claim holds under a full replay.

**Functional smoke, three→four seeded users:** 40 block/report assertions, 9 group-membership-ordering assertions, 13 settlement-carve-out assertions, all passing. Highlights: `BLOCKED_BY_YOU` vs `NO_MATCH` asymmetry with matching rate-limit accounting; the blocked party seeing zero rows in `blocks`; the group-owner carve-out (`INVALID_OR_EXPIRED_CODE` for the owner's group, `ok` for a group the blocker merely belongs to); the owner force-add refused by the structural trigger; `decline_group_membership` and `leave_group` still working while blocked; group `notifications` suppressed while the `group_events` row is still written; witness rotate → old link dies → revoke → expiry → plaintext write refused → non-organiser refused; report reporter-spoofing refused and the 20/day cap firing; and **RULE 2 proved end to end** — a 1000 AED linked loan accepted, then blocked, then a 400 partial settlement raised by the blocked debtor and accepted by the blocking creditor, both loans landing at 600.

**What was stubbed** (these are simulations, not proof):
- `storage.buckets` / `storage.objects` / `storage.foldername()` are hand-rolled shims. Real Supabase Storage RLS, the actual size/MIME rejection at the API boundary, and object ownership semantics were **not** exercised — see §6.5. The `delete_current_user` purge was verified against the shim only (B's row deleted, C's untouched).
- `auth.users` is a 3-column shim; `auth.uid()` reads `request.jwt.claim.sub`.
- `pg_net.http_post` is a logging stub, so no push was ever sent — the *suppression* was verified by counting `notifications` rows, not FCM deliveries.
- PostgREST is absent. Every "client" call was raw SQL as role `authenticated`. Named-argument binding for the new RPCs, the `jsonb` return-shape mapping, and HTTP 403s on the revoked helpers are untested.
- One harness prelude was needed (the documented `notifications-rls` replay drift, `APPLY-ORDER.md` §6) and the database `search_path` was set to `public, extensions` so unqualified `digest()` in `kameti-draw`'s verification section resolves — both harness artifacts, neither a change to any repo file.
- Single session: no concurrency, no volume, no `EXPLAIN`.
- **Production drift remains the largest gap and is not closable from here.** Run `supabase-audit-p0-verification.sql` against production and reconcile Section 13 before applying anything.
