# Hisaab Security Audit — Consolidated Report

**Date:** 2026-09-02
**Scope:** Full repository (client, Supabase SQL migrations, edge function, Android wrapper config). No live-environment access — Supabase Studio state, Vercel dashboard, Firebase/FCM config are out of reach (see Evidence-unavailable at the end).
**Method:** 4 independent finders → 2-round adversarial verification per finding → consolidating lead review with fresh spot-checks of load-bearing citations. Verification labels: **CONFIRMED** (survived 2 independent refutation attempts), **UNVERIFIED** (not adversarially checked; treat critical/high with that caveat). No finding was refuted during verification.

---

## Triage table (bug-bounty style, worst first)

| # | Finding | Severity | Verification | Effort |
|---|---------|----------|--------------|--------|
| C1 | Baseline RLS lets any user self-insert into any group; safety depends on an unproven hand-applied migration | Critical | CONFIRMED | S |
| H1 | join_group_by_code brute-force limiter is a no-op (failure rows rolled back) | High | CONFIRMED | M |
| H2 | `persons.linked_profile_id` is client-writable — forged consent for every cross-user flow; unlimited loan-request/notification spam | High | CONFIRMED | M |
| H3 | group_invites.token_hash is member-readable AND accepted verbatim as the credential (guest-seat hijack) | High | CONFIRMED | M |
| H4 | Ex-members can rewrite or hard-delete their historical group expenses/settlements | High | CONFIRMED | M |
| H5 | Any co-member can insert arbitrary notification title/body, forwarded verbatim as app-branded FCM push | High | CONFIRMED | M |
| H6 | Group owners can conscript any user as a 'connected' member with zero consent — and wedge the exit shut | High | CONFIRMED | M |
| H7 | PIN lock is dead code while the Play listing sells it as shipped (and the design is weak even if wired) | High | CONFIRMED | S–M |
| H8 | signOut leaves the Supabase token in localStorage on network failure — session resurrects for the next device holder | High | CONFIRMED | S |
| H9 | lookup_profile_by_code is unthrottled — user-base enumeration (UUID + real name) | High | CONFIRMED | S |
| H10 | No phone-ownership verification — any account can impersonate any phone number in discovery (with a UI "verified" badge) | High | CONFIRMED | L |
| M1 | 40+ hand-applied migrations, no ledger; later files are load-bearing security fixes; client still calls a dropped RPC | Medium | UNVERIFIED | M |
| M2 | Password change and permanent account deletion require no re-authentication | Medium | UNVERIFIED | M |
| M3 | Password-reset flow unfinished: recovery link = silent magic login, no forced rotation | Medium | UNVERIFIED | M |
| M4 | Email-verification gate is render-only; unverified sessions fully live at the API | Medium | UNVERIFIED | S |
| M5 | FCM push token never unregistered at sign-out (cleanup runs after the session is gone) | Medium | UNVERIFIED | S |
| M6 | Deleted-account gate is fail-open client-side; restrictive RLS list omits newer tables | Medium | UNVERIFIED | M |
| M7 | Zero HTTP security headers from Vercel (meta-CSP only; no frame-ancestors/HSTS/nosniff/Referrer-Policy) | Medium | UNVERIFIED (vercel.json re-checked) | S |
| M8 | Backup import writes arbitrary localStorage keys and is destructively non-atomic | Medium | UNVERIFIED (code re-checked) | S |
| M9 | Production Supabase URL + anon key in git history; key never rotated | Medium | UNVERIFIED (history re-checked) | M |
| M10 | Kameti "provably fair" ballot is not binding — organiser can re-roll until the draw suits them | Medium | UNVERIFIED | M |
| M11 | All per-user rate limits bypassable via free multi-account signup + TOCTOU bursts | Medium | UNVERIFIED | M |
| M12 | No server-side bounds on money values — poisoned amounts/splits insertable into shared group ledgers | Medium | UNVERIFIED | M |
| M13 | Receipts bucket has no size/MIME limits — single-account storage-quota exhaustion | Medium | UNVERIFIED | S |
| M14 | Unthrottled notifications → pg_net → edge → FCM chain: denial-of-wallet | Medium | UNVERIFIED | M |
| M15 | register_push_token repoints any known FCM token to the caller — push-channel hijack | Medium | UNVERIFIED | S–M |
| M16 | is_group_member() exposed as a direct RPC — membership oracle for the social graph | Medium | UNVERIFIED | S |
| M17 | No block/mute/report primitives anywhere — harassment has no product answer | Medium | UNVERIFIED | L |
| M18 | delete_current_user may fail on ON DELETE RESTRICT ordering — broken right-to-delete | Medium | UNVERIFIED | S |
| M19 | Kameti witness link: anon, unthrottled, plaintext-stored, never expires, no revocation | Medium | UNVERIFIED | M |
| L1–L15 | Lower-severity hygiene items (see Low section) | Low | mostly UNVERIFIED | S–M |

---

## Summary & overall security posture

Hisaab's architecture concentrates 100% of its server-side security into Supabase RLS policies and SECURITY DEFINER RPCs defined across **40+ root-level SQL files applied by hand in Supabase Studio** — with no migration ledger, no recorded production verification run (docs/play-store-launch-tracker.md:30 shows the p0 security-verification SQL still pending), and the repo's own memory/docs recording several security-relevant migrations as *not yet applied*. Every "fixed" claim below is therefore fixed **in intent only**; the single highest-leverage action before launch is proving (and then continuously asserting) that production `pg_policies`/`pg_proc` match the repo.

Against that backdrop, adversarial verification **confirmed one critical and ten high findings**. The recurring theme is that *cross-user trust predicates are client-writable*: a user's own `persons` row is treated as proof of consent (H2), a group owner's insert manufactures the victim's "connected" status (H6), a member-readable hash **is** the invite credential (H3), and notification content is composed client-side and pushed verbatim through FCM (H5). The second theme is *rate-limiting theater*: the one server-side brute-force limiter that exists rolls its own evidence back (H1), the profile-code oracle has no limiter at all (H9), and every limiter is keyed on free-to-mint `auth.uid()` (M11). Third: *advertised security that does not exist* — the Play-listed PIN lock is dead code (H7), and sign-out can silently fail to end the session (H8).

Genuine strengths worth keeping: a thoughtfully strict meta-CSP (`script-src 'self'`), disciplined `esc()` usage in all HTML-to-image builders (one gap, L8), hashed group-invite tokens at rest (undermined by H3's read policy), `allowBackup=false` and WebView debugging off on Android, an anti-enumeration-aware password-reset message, the optimistic-lock balance RPC, and the compensation pattern for money mutations. The team demonstrably knows the right patterns — phone lookup got a working rate limiter, contact links got a consent flow — the failures are ones of *coverage and consistency*, not ignorance.

**Posture verdict:** not launchable as-is. The critical finding plus H1–H10 collectively permit cross-user financial-data access, shared-ledger falsification, consent forgery, user enumeration, and app-branded phishing — in a product whose entire pitch is trust in informal money records.

---

## Critical findings

### C1. Baseline schema lets any authenticated user insert/re-point their own group_members row; safety depends entirely on an unverified later migration — **CONFIRMED**

**Evidence:** supabase-schema.sql:364-373 (INSERT policy passes on `auth.uid() = profile_id` alone), supabase-schema.sql:375-384 (UPDATE policy without WITH CHECK), supabase-migration-group-codes.sql:72-76 (self-insert was the intended join path), supabase-schema.sql:335-350 (`is_group_member()` keys purely on a `status='connected'` row and gates split_groups/group_expenses/group_settlements/group_events/group_invites SELECT-and-INSERT plus cross-user notification INSERT — supabase-schema.sql:412,446-535), supabase-migration-p0-launch-blockers.sql:150-178 (the fix — owner-only INSERT/UPDATE), supabase-migration-safe-leave-group.sql:22-49 (protect trigger, UPDATE-only), docs/play-store-launch-tracker.md:30 and docs/p0-launch-blocker-tracker.md:7-8 (verification run never executed; last documented status of the p0 migration is "code ready, next action: run in SQL editor").

Under the base schema, any authenticated user can `INSERT` a `group_members` row for themselves into **any** group id with `status='connected'` — nothing constrains the status column, and the FK is validated as table owner, bypassing RLS. That one row unlocks full read and write access to the group's shared financial ledger. The UPDATE policy additionally allows re-pointing an existing row's `group_id`. The fix exists only in later hand-applied migrations; because all client join paths are SECURITY DEFINER RPCs, no live flow would break or signal whether the fix was ever applied. Group ids are uuid-v4 (unguessable cold), but every current **and former** member knows them — and "left" members are exactly who the leave flow tries to lock out.

- **Exploit scenario:** If the p0 migration is absent or partial in prod, a member who left (or was rejected) issues `POST /rest/v1/group_members` with `{profile_id: self, group_id: <known id>, status: 'connected'}` and regains full read/write access to the group's ledger.
- **Business impact:** Cross-user financial-data leak and write access to shared ledgers; rejoin-after-leave bypass. Meets this audit's definition of critical (cross-user data leak / launch blocker).
- **Recommended fix:** Run `supabase-p0-security-verification.sql` in production **now** and commit the output; add a pg_policies assertion for group_members to CI-adjacent checks; adopt supabase CLI migrations so schema state is provable.
- **Effort:** S.

---

## High findings

### H1. join_group_by_code brute-force rate limiter is a no-op — **CONFIRMED**

**Evidence:** supabase-migration-fix-group-invite-join-rpc.sql:46-50 (latest RPC: `INSERT INTO join_code_attempts(... succeeded=false)` immediately followed by `RAISE EXCEPTION`), same pattern in supabase-migration-p0-launch-blockers.sql:262-266 and supabase-migration-prelaunch-hardening.sql:387-395; limiter counts `succeeded=false` rows (fix:33-40) that can never exist; src/lib/collaboration.ts:1,17-19 (6 chars × 32-symbol alphabet = 32^6 ≈ 1.07e9).

Every version of the RPC records the failed attempt and then RAISEs in the same transaction with no EXCEPTION handler — the unhandled RAISE rolls the INSERT back, so `join_code_attempts` only ever holds `succeeded=true` rows and the "5 failures per 5 minutes" gate can never trip. Verification found the situation is *worse* than filed: the 14-day expiry only backfills pre-migration rows; new groups auto-generate codes with `join_code_expires_at` NULL, which the RPC treats as never-expiring, and a raw-RPC join skips the client-side member_joined fan-out — making a successful guess silent.

- **Exploit scenario:** Attacker scripts the RPC at ~100 req/s from one account; with 10k live codes, expected first hit in ~107k guesses (~18 min), silently joining a stranger's group.
- **Business impact:** Server-side brute-force protection on the only guessable credential in the system is entirely absent.
- **Recommended fix:** Make the failure record survive rollback (return an error row instead of RAISE so the tx commits, or log via a mechanism outside the transaction); set expiry on new codes.
- **Effort:** M.

### H2. `persons.linked_profile_id` is freely client-writable — forging the "consent" every cross-user flow trusts; unlimited loan-request and notification spam — **CONFIRMED** (merges two confirmed findings)

**Evidence:** supabase-migration-phase1-persons.sql:26-32 (persons INSERT/UPDATE policies check only `user_id = auth.uid()`, no column restriction), supabase-migration-phase2a-linked-profile.sql:7-21 (column has only an FK to profiles — no write guard or trigger anywhere in the SQL), src/lib/supabaseDb.ts:307-315 (`setLinkedProfileId` is a plain PostgREST update; the secret-code check is client-side only), supabase-migration-phase2b-linked-requests.sql:59-65 and its latest redefinition in supabase-migration-cross-user-account-effects.sql:57-140 (`tg_ltr_validate_insert` treats the self-writable row as link proof; amount checked only `> 0`, no per-pair pending cap), supabase-migration-linked-notifications-realtime.sql:42-51 (`tg_ltr_notify` fires a victim notification per insert, no dedup), supabase-migration-contact-link-reciprocal.sql:36-77 (superseded-but-possibly-live version force-inserts a persons row with the attacker's chosen name into the victim's ledger plus a "you're now connected" notification), supabase-migration-connections-push-discovery.sql:6-13, 97-142 (v3's "anti-abuse" check is the same self-forgeable row; already-mutual branch inserts a fresh notification on every call, no throttle).

Linking is supposed to require the victim's secret HSB code; in reality, RLS lets a user set `linked_profile_id` to any profile UUID via one PATCH. Every downstream guard treats that row as an established link: unlimited `linked_transaction_requests` ("X wants to record PKR 99,999,999 with you") to any known UUID, each triggering a notification and (once configured) a push; `notify_contact_linked` passes trivially, and — under the reciprocal version still possibly live in prod — force-writes an attacker-named contact into the victim's ledger. Victim UUIDs are obtainable via shared groups, phone discovery, or H9. Money never moves without the victim's own accept (`accept_linked_request` checks `to_user_id = auth.uid()`), which is why this is high, not critical.

- **Exploit scenario:** Attacker PATCHes their persons row to `linked_profile_id=<victim>`, then scripts 10,000 linked-request inserts; victim's inbox and push tray flood with fake-debt intimidation, each item requiring individual rejection. Any once-accepted contact can also loop `notify_contact_linked` for unbounded push spam.
- **Business impact:** Consent-model bypass in a debt-trust app: unsolicited cross-user ledger injection, social-engineering-grade "established contact" loan requests, inbox denial of service.
- **Recommended fix:** Block direct writes to `linked_profile_id` with a protect trigger (same pattern as `tg_persons_protect_archive`) and route linking through a SECURITY DEFINER RPC that re-verifies the code server-side; add a partial-unique pending index per (from,to) pair; drop the notification insert in the already-mutual branch; bound request amounts.
- **Effort:** M.

### H3. group_invites.token_hash is member-readable AND accepted verbatim as the credential — hash-as-password — **CONFIRMED**

**Evidence:** supabase-schema.sql:403-413 / supabase-migration-fix-rls-recursion.sql:103-114 (SELECT policy exposes whole rows incl. token_hash to owner, creator, acceptor, and every connected member; `select('*')` is a live app path — src/lib/supabaseDb.ts:1237-1244), supabase-migration-fix-group-invite-join-rpc.sql:86-158 (`accept_group_invite` matches `gi.token_hash = p_invite_token_hash` at :111 and rebinds guest seats `profile_id = v_uid` at :125-149), src/lib/collaboration.ts:32-40 (client sends sha256 of the raw link token — so the stored hash **is** the credential).

Hashing protects nothing here: the RPC authenticates on the stored hash, and RLS hands that hash to every member. Any member can enumerate the group's open invites and redeem a stolen hash from a second account; where an invite targets a guest seat (`profile_id` NULL), the caller permanently claims that seat and its expense/settlement history. No rate limit on this RPC; the design is even pinned by supabase-group-invite-join-verification.sql:31 and a CI test.

- **Exploit scenario:** Member B reads group_invites, takes the token_hash of the invite the owner created for cousin C's guest seat, calls `accept_group_invite(hash)` from a second account — the second account becomes "C" with C's balances attached.
- **Business impact:** Invite hijack and guest-seat identity capture inside shared financial groups.
- **Recommended fix:** Remove token_hash from member-readable reads (view or RPC), and/or verify a preimage: store sha256(token), accept the raw token, hash server-side.
- **Effort:** M.

### H4. Ex-members can rewrite or hard-delete their historical group expenses and settlements — **CONFIRMED**

**Evidence:** supabase-migration-prelaunch-hardening.sql:59-61, 67-71, 307-310 and supabase-schema.sql:520-522 (all group_expenses/group_settlements UPDATE/DELETE policies gate on `auth.uid() = user_id` only — no membership check; no later migration tightens them), supabase-migration-enforce-active-group-transaction-members.sql:16-19, ~80-83 (triggers validate only participant-shape changes — amount/description/date unguarded; no DELETE trigger exists), supabase-migration-safe-leave-group.sql:110-172, 196-198 (leave gate computes balance from these very rows; leaving preserves row ownership).

A departing member passes the zero-balance leave gate, then — via PostgREST with their own JWT — changes an expense's amount without touching splits, or hard-DELETEs their expense and settlement rows (the client itself relies on the hard-DELETE grant, supabaseDb.ts:1129), silently shifting every remaining member's computed balances with no group event, version check, or tombstone. Soft-delete columns exist but the DELETE policies permit true deletion, erasing the audit trail too.

- **Exploit scenario:** A settled member leaves cleanly, then deletes the AED 3,000 expense they had paid; remaining members now appear to owe each other different amounts with no record of why.
- **Business impact:** Retroactive falsification of multi-party financial records by departed users — the exact trust the product sells.
- **Recommended fix:** Add `is_group_member(group_id, auth.uid())` to UPDATE/DELETE USING (or route mutations through RPCs), extend the trigger to amount changes, drop hard-DELETE in favor of soft-delete-only.
- **Effort:** M.

### H5. Any co-member can insert arbitrary notification title/body — delivered verbatim as app-branded FCM push — **CONFIRMED** (merges 3 filings)

**Evidence:** supabase-schema.sql:455-465, 484-493 and supabase-migration-notifications-rls.sql:35-44 (INSERT policy validates only shared connected membership; type/title/body are unconstrained TEXT, no CHECK, no length cap, no rate limit anywhere), supabase-migration-connections-push-discovery.sql:450-488 (`tg_notifications_push` forwards `new.title/new.body/new.type` verbatim to the edge function; no-op until app_push_config is populated), supabase/functions/push-notify/index.ts:167-195 (attacker text becomes FCM `notification.title/body`, Android HIGH priority, app icon), supabase-migration-p0-launch-blockers.sql:33-50 (profile display name freely settable), src/pages/ActivityPage.tsx:178-181 (in-app tray renders title/body verbatim — React-escaped, so phishing text, not XSS).

The precondition (shared connected membership) is attacker-manufacturable via H6 or a leaked join code. The in-app inbox injection works today with the base schema; the OS-push half activates the moment push is configured — which is the documented launch path. No block/mute/report exists (grep of i18n.ts confirms).

- **Exploit scenario:** Attacker in the victim's group POSTs to `/rest/v1/notifications`: title "Hisaab Security", body "Your session expired — verify at hisaab-verify.com or your loans will be deleted". The victim's phone renders it as a genuine Hisaab push. Or 500 rows per member as a spam flood.
- **Business impact:** Phishing/social engineering through the app's own trusted channel; harassment floods; quota burn (see M14).
- **Recommended fix:** Move fan-out to SECURITY DEFINER RPCs that compose text server-side from a template catalog (the linked-request triggers already do this), tighten the INSERT policy to self-only, add per-sender rate limits.
- **Effort:** M.

### H6. Group owners can force any user into a group as a 'connected' member with zero consent — **CONFIRMED**

**Evidence:** supabase-migration-p0-launch-blockers.sql:150-161 (owner INSERT policy constrains neither profile_id nor status), supabase-schema.sql:335-348 (`is_group_member` checks only `status='connected'`), src/stores/splitStore.ts:407-478 and src/lib/supabaseDb.ts:1169-1191 (the app writes strangers in as `status:'connected'` by design, with an "X added you to a shared group" fan-out), src/pages/CreateGroupModal.tsx:46-74 (any stranger's public code resolves with no relationship check), supabase-migration-safe-leave-group.sql:28-41, 142-155, 212 (BEFORE-UPDATE trigger blocks the victim flipping their own status; leave_group refuses to run while net balance > 0.01).

There is no invitation/accept step for direct member adds (contrast contact links, which got a consent flow), and no way to refuse. Verification found the finding **understated**: an attacker who attaches an expense naming the victim as debtor makes the victim fail the leave gate — conscription with the exit wedged shut. Forced membership is also the gateway predicate for H5 (notification injection) and expense attachment against the victim.

- **Exploit scenario:** Attacker obtains victim's code/UUID (H9), creates groups with the victim as connected member, attaches expenses claiming the victim owes money; victim's app renders it all, their inbox floods, and outstanding "balances" block leave_group.
- **Business impact:** Unsolicited record attachment, harassment at scale, inescapable group membership, and the predicate for cross-user notification injection.
- **Recommended fix:** Owner-inserted members with a profile_id start as `status='invited'` and require target acceptance (the accept-invite machinery already exists) before `is_group_member` treats them as connected.
- **Effort:** M.

### H7. PIN lock is dead code — never rendered, never enforced — while the Play listing sells it as shipped — **CONFIRMED** (merges 2 confirmed filings; design-weakness sub-finding folded in)

**Evidence:** src/pages/PinLockScreen.tsx:12 (sole definition; repo-wide grep: zero importers, no route, no lazy import), src/App.tsx:404-445 (no reference to isLocked/useAuthStore/PinLockScreen anywhere in the shell), src/stores/authStore.ts:33,71 (`checkAuth()`/`lock()` have no callers; `isLocked` is read by nothing outside the store), src/pages/SettingsPage.tsx:135,275-299 (set/change/remove PIN fully wired with a success toast), i18n.ts:2571 ("your PIN locks this device only"), docs/play-store-listing.md:50,103,128,145 ("Optional PIN lock" ×4; line 145 asserts every named feature "is a shipped feature"), docs/ux-audit-first-time-user-2026-07.md:67-70 (the repo's own audit flagged this as launch blocker B3 — still unfixed).

A user who sets a PIN receives affirmative confirmation of protection that does not exist; the app opens straight to Home with full loans, balances, and contacts. No native/biometric fallback exists (no lock plugin in package.json). **Sub-finding (UNVERIFIED):** even when wired, the current design must not ship as-is — 4-digit PIN hashed with a single unsalted SHA-256 round and a hardcoded salt in localStorage (authStore.ts:3-8,27), in-memory-only lockout resettable by refresh (authStore.ts:30-31,62-68), and missing-key-equals-unlocked (authStore.ts:53-54): trivially reversible offline against a keyspace users reuse for bank cards.

- **Exploit scenario:** User sets a PIN, hands the phone to a relative; app opens with zero challenge. Separately, Google Play can reject/suspend over a demonstrably false security claim.
- **Business impact:** False security claim aimed at the app's core shared-device audience; store-compliance exposure at launch review.
- **Recommended fix:** Gate the app shell on `hasPin && isLocked` (lock on boot and appStateChange), or remove the Settings UI and listing claims until wired. Before wiring: PBKDF2/WebCrypto with per-user salt, persisted lockout, missing-key-while-pin-set = locked.
- **Effort:** S (unship claim) / M (wire properly).

### H8. signOut leaves the Supabase auth token in localStorage when the network call fails — the session resurrects on next launch — **CONFIRMED**

**Evidence:** src/stores/supabaseAuthStore.ts:171-183 (`signOut()` never inspects the returned `{error}`; the finally block clears stores/uid and shows AuthPage regardless), node_modules/@supabase/auth-js (v2.100.0) GoTrueClient.js:1762-1777 (`_signOut` returns early on any non-401/403/404 error — including offline `AuthRetryableFetchError` — **before** `_removeSession()`), src/lib/supabase.ts:10 (default client: persistSession in localStorage), supabaseAuthStore.ts:65-83 (`initialize()` finds the persisted token and silently restores the previous user), resetAllStores.ts:36-48 (wipes only `hisaab_*` keys — never the `sb-*` key).

The user sees the login screen and believes they signed out; the un-revoked refresh token keeps the session valid indefinitely. The code's own comment (supabaseAuthStore.ts:172-174) names the shared-device second-user scenario this defeats. Aggravator: combined with M2, the next device holder can change the password (no current-password check) — full takeover. Offline sign-out is a realistic path for the Gulf-to-Pakistan connectivity profile.

- **Exploit scenario:** User A in airplane mode taps Sign out, sees the login screen, hands the phone over; user B opens the app later with connectivity — A's entire ledger restores, and B can set a new password.
- **Business impact:** An explicit sign-out does not end the session on exactly the shared/handed-over devices the product targets.
- **Recommended fix:** Check the `{error}` from `supabase.auth.signOut()`; on failure call `signOut({scope:'local'})` or remove the `sb-*` (and code-verifier) keys before declaring the user signed out.
- **Effort:** S.

### H9. Unthrottled `lookup_profile_by_code` RPC enables enumeration of the user base — **CONFIRMED** (merges 2 unverified duplicates)

**Evidence:** supabase-migration-p0-launch-blockers.sql:369-385 (SECURITY DEFINER, granted to all authenticated, returns `(profile_id, display_name)`, zero attempt accounting; the older phase2a:28-43 version is equally unthrottled), src/lib/collaboration.ts:1,13-15 (32^6 = 2^30 keyspace; codes auto-generate on connect-UI mount so most active users are enumerable — MyConnectCode.tsx:33-37), contrast supabase-migration-connections-push-discovery.sql:339-350 (phone lookup throttled 20/hr with an explicit anti-enumeration comment) and prelaunch-hardening.sql:15 (which names the "32^6 brute-force surface" for join codes) — the identical threat model, addressed everywhere except here.

The RPC is a perfect validity oracle at PostgREST speed. Expected tries to find *some* valid user is keyspace/user-count: at 10k users, ~107k calls to a first hit; a proportional sweep steadily builds a (UUID, real name) directory. A full-base harvest takes days, not minutes — but harvested UUIDs are exactly the input for H2, H6, and H5, and names feed WhatsApp-era social engineering.

- **Exploit scenario:** One burner account loops `supabase.rpc('lookup_profile_by_code', {code})` from a script, building a member directory of a finance app for Gulf-expat families.
- **Business impact:** Mass user enumeration (UUID + real name); feeds every downstream cross-user abuse vector.
- **Recommended fix:** Reuse the phone_lookup_attempts throttle pattern (which, unlike join_code_attempts, actually persists) inside the RPC; consider 8-char codes.
- **Effort:** S.

### H10. No phone-ownership verification: any account can claim any phone number and impersonate it in discovery — **CONFIRMED** (merges 1 unverified duplicate)

**Evidence:** src/lib/supabaseDb.ts:492-498 (`setMyPhone()` is a plain profile UPDATE — no OTP/SMS anywhere; grep confirms), supabase-migration-connections-push-discovery.sql:303-310, 366-369 ("ordinary self-service columns"; index non-unique "on purpose"; plaintext at rest), :323-361 (`lookup_hisaab_users_by_phone` returns `(phone, profile_id, display_name)` for any discoverable claimant), src/pages/ContactDetailSheet.tsx:164-166, 722-742 (a discovery hit renders a one-tap link CTA **with a VerifiedBadge** next to the attacker's self-chosen display name; a one-sided link immediately lets the victim-side user record and send money records to the attacker), src/components/PhoneDiscoverySection.tsx:62-80 (a newly added number defaults to discoverable=true).

The 20/hr lookup rate limit throttles *enumeration*, not *impersonation* — the attacker is passive: claim the number, wait for the victim's contacts to run discovery. The UI actively lends verification semantics to an unverified claim. In a remittance-culture money app this is a fraud primitive; the claimed number's owner need not even be a Hisaab user. Secondary gap: the migration's design note "callers can only ask about numbers they already have" (:25) is unenforced — the RPC accepts arbitrary 60-number arrays, making it a phone→identity oracle within the rate limit.

- **Exploit scenario:** Attacker sets `phone_e164` to a well-known money-changer's number and waits; expat workers see the shop "on Hisaab" (with a verified badge) and start recording loans and repayment confirmations against the attacker's account — later used to dispute real debts.
- **Business impact:** Cross-user identity spoofing inside the money graph; social-engineering fraud; plaintext phone PII enlarging breach blast radius.
- **Recommended fix:** Require SMS OTP before `phone_discoverable` can be set; store a salted hash for matching; prefer verified claims on conflict; drop the VerifiedBadge from unverified discovery hits immediately (S-effort stopgap).
- **Effort:** L (OTP) / S (badge stopgap).

---

## Medium findings

*All findings in this section are labeled **UNVERIFIED** (not adversarially double-checked); the lead auditor spot-checked the citations marked ✓.*

### M1. No migration ledger: 40+ hand-applied SQL files where later files are load-bearing security fixes — drift is unverifiable, partially documented as real, and the client already disagrees with the SQL — UNVERIFIED (merges the code-lookup drift finding)

**Evidence:** 40+ root-level supabase-*.sql files; supabase-schema.sql:364-373 fixed only by p0-launch-blockers.sql:150-178; connections-push-discovery.sql:6-13 (documents that the live `notify_contact_linked` writes into the owner's ledger without consent until this pending migration is applied); docs/play-store-launch-tracker.md:30 (prod verification never run); memory/docs list connections and cross-user-account-effects migrations as pending. **Concrete drift already visible:** two migrations DROP `lookup_profile_by_public_code` (prelaunch-hardening.sql:313-318, p0:386) because it leaked the code itself — yet the shipped client still calls it (src/lib/supabaseDb.ts:1349-1358, CreateGroupModal.tsx:58). So production is in exactly one of two bad states: the drop ran and the add-member-by-code flow is silently broken, or it never ran and a worse enumeration oracle than H9 is live. Same risk for the unthrottled `lookup_group_by_join_code` (group-codes.sql:26-57, dropped only in p0) which would sidestep H1's limiter entirely.

- **Exploit scenario:** Attacker probes every table/RPC named in the migration files for gaps between repo-defined and actually-applied RLS.
- **Business impact:** Unknown production authorization state — every closed hole may be open; the single highest-leverage systemic risk for due diligence.
- **Recommended fix:** Run all *-verification.sql in prod and commit outputs; update the client to the hardened lookup RPC; adopt supabase CLI migrations; schedule a pg_policies/pg_proc diff against the repo's expected catalog.
- **Effort:** M.

### M2. Password change and permanent account deletion require no re-authentication — UNVERIFIED ✓ (updateUser call re-checked)

**Evidence:** src/stores/supabaseAuthStore.ts:207-210 (`updateUser({password})` with no current password — re-verified), src/pages/SettingsPage.tsx:332-371 (change gated only by new-password policy; delete gated by typing "DELETE"), supabase-migration-p0-launch-blockers.sql:102-134 (`delete_current_user` hard-deletes auth.users and cascades everything).

Combined with the non-functional PIN (H7) and indefinitely-persisting refresh tokens, brief access to an unlocked phone escalates to permanent lockout of the real owner or irreversible destruction of years of khata history. Whether the dashboard's "secure password change" reauth toggle is on is not determinable from the repo (default: off).

- **Exploit scenario:** A family member on the shared phone sets a new password (no old password asked) or types DELETE and erases everything permanently.
- **Business impact:** Physical device access = irreversible account takeover or destruction.
- **Recommended fix:** Require the current password (re-signIn) before changePassword/deleteAccount; enable Supabase's reauthentication nonce flow; make a working PIN gate a prerequisite.
- **Effort:** M.

### M3. Password-reset flow is unfinished: the recovery link silently signs the user in and nothing prompts for a new password — UNVERIFIED ✓ (grep re-run: `reset=1` appears only where it is sent)

**Evidence:** src/stores/supabaseAuthStore.ts:190-199 (redirectTo `/?reset=1`); a fresh repo grep for `reset=1`/`PASSWORD_RECOVERY`/`type=recovery` matches only the sender line — no handler exists; src/lib/supabase.ts:10 (default `detectSessionInUrl: true`).

Clicking the emailed link consumes the recovery token, establishes a full session, and lands on Home with the old password unchanged. Functionally, forgotten-password users can never actually reset; security-wise, the reset email is a silent magic-login link — transient mailbox access yields a full session with no visible password-change event, and the victim's credentials still work so nothing looks amiss.

- **Business impact:** Broken account recovery and a stealth login vector via mailbox compromise; no forced credential rotation after recovery.
- **Recommended fix:** Handle the PASSWORD_RECOVERY event with a mandatory set-new-password screen before any app content.
- **Effort:** M.

### M4. Email-verification gate is render-only — UNVERIFIED

**Evidence:** src/App.tsx:422-428 (gate is an early return in JSX), App.tsx:213-331 (realtime start, push registration, and every data-load effect are keyed only on `user?.id` and run regardless), App.tsx:417-421 (comment concedes unconfirmed sessions are possible).

An unverified user's client holds a fully live session, hydrates every store, opens realtime, registers FCM tokens; only pixels are withheld — and the session token works for direct REST calls anyway. RLS cannot check email confirmation. Whether the dashboard's "Confirm email" setting blocks unconfirmed sign-ins is Evidence-unavailable; if off, verification is entirely decorative.

- **Business impact:** Accounts on unowned email addresses may be fully functional for cross-user flows.
- **Recommended fix:** Verify "Confirm email" is ON in the dashboard and document it; split the component so the gate precedes the data effects.
- **Effort:** S.

### M5. FCM push token never unregistered on sign-out — the delete runs after the session is gone — UNVERIFIED

**Evidence:** src/stores/supabaseAuthStore.ts:175-182 (signOut revokes session, removes uid), src/App.tsx:245-251 (stopPushRegistration fires only after `user` becomes null), src/lib/pushRegistration.ts:22-23, 99-109 (the code's own comment describes exactly this leak), src/lib/supabaseDb.ts:20-22, 512-519 (unregister needs getUserId() + an authenticated DELETE — both gone by then).

The device_push_tokens row survives; the previous user's loan/settlement notifications — amounts, counterparty names — keep arriving on a device they no longer control.

- **Business impact:** Financial notification content of the previous account leaks to the next device holder, indefinitely.
- **Recommended fix:** Call stopPushRegistration() inside signOut() *before* `supabase.auth.signOut()`; persist the registered token so cleanup survives restarts.
- **Effort:** S.

### M6. Deleted-account gate: fail-open client check, fire-and-forget on auth changes, and a stale server-side table list — UNVERIFIED (merges the "omits newer tables" low)

**Evidence:** src/stores/supabaseAuthStore.ts:39 (`if (error) return false` — fail-open), :94-96 (unawaited check), supabase-migration-p0-launch-blockers.sql:74-96 (restrictive "Active profiles only" policy applied to a hard-coded ~20-table list that omits committees, committee_members, committee_payments, contact_link_requests, device_push_tokens, investments, custom_categories, phone-discovery tables).

Narrowed by delete_current_user hard-deleting auth.users, but a still-valid JWT (~1h) retains access to the omitted tables, and the hard-coded list guarantees drift as the schema grows.

- **Business impact:** A deleted account may retain read/write access through its remaining token lifetime; inconsistent enforcement.
- **Recommended fix:** Fail-closed on repeated errors; await the check before hydrating; apply the restrictive policy by iterating all RLS-enabled tables; run the verification SQL in prod.
- **Effort:** M.

### M7. Zero HTTP security headers from Vercel — meta-CSP only, so frame-ancestors/HSTS/nosniff/Referrer-Policy/Permissions-Policy are all absent — UNVERIFIED ✓ (vercel.json re-read: only Cache-Control) (merges 3 filings)

**Evidence:** vercel.json:1-34 (only Cache-Control headers — re-verified), index.html:22 (CSP via `<meta http-equiv>` only; frame-ancestors, report-to and sandbox are ignored in meta delivery per spec; connect-src also whitelists `ws://localhost:*`/`http://localhost:*` in production).

usehisaab.com can be framed by any origin — clickjacking over single-tap money-consent actions (accept loan, settle, delete account). No HSTS (first-visit downgrade), no nosniff, no Referrer-Policy — the last matters because kameti witness and group invite links carry live capability tokens in the URL path. No CSP violation reporting is possible via meta.

- **Exploit scenario:** Attacker frames /inbox invisibly under a game UI; the victim's taps land on "Accept" for a fake loan request (H2).
- **Business impact:** Clickjacking of money actions; capability-token leakage via Referer; weakened transport hygiene; zero injection telemetry.
- **Recommended fix:** Headers block in vercel.json for `/(.*)`: full CSP (with `frame-ancestors 'none'` and report-to; keep the meta as WebView fallback), HSTS, `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, Permissions-Policy; drop localhost from the prod CSP.
- **Effort:** S.

### M8. Backup import writes arbitrary localStorage keys and is destructively non-atomic — UNVERIFIED ✓ (import loop re-read)

**Evidence:** src/lib/dataExport.ts:234-238 (`Object.entries(parsed.settings).forEach(([k, v]) => localStorage.setItem(k, v))` — no allowlist; re-verified) vs :9-12 (export writes only 7 fixed keys); :71-82 (import DELETEs all tables before inserting — a malformed file that passes the version check destroys cloud data before failing; matches the repo's own B4 launch blocker).

A tampered "backup" (files travel by WhatsApp by design) can plant `hisaab_pin_hash` (attacker-known PIN, the day PIN ships), `hisaab_supabase_uid` (desyncs uid-derived paths), mode flags, mirror-cache stamps, and more.

- **Business impact:** Client-state tampering via a file users are trained to trust; a corrupt file equals total data loss.
- **Recommended fix:** Filter restored settings to the LS_KEYS allowlist; validate shapes; make import transactional (delete only after all inserts succeed).
- **Effort:** S.

### M9. Production Supabase URL + anon key baked into git history via committed Android build artifacts; key never rotated — UNVERIFIED ✓ (history spot-checked: commit 88ed40c contains `sb_publishable_` in two bundled JS artifacts; the same key family is the current .env value)

**Evidence:** git history commits 88ed40c/dfea60e (android/app/src/main/assets/public/assets/supabaseDb-*.js and build intermediates carrying the literal key — re-verified via `git grep` at 88ed40c), cleanup commit 7768457 deleted the files but they remain reachable in history; .env:2 shows the same `sb_publishable_` key still live; ARCH-RECON-hisaab.md:41 records the leak.

An anon key is public-by-design at runtime, so the real issue is that the leak permanently fixes the production API coordinates while the entire security boundary is RLS/RPC correctness across hand-applied migrations with acknowledged drift (M1). Whether the GitHub remote is public is Evidence-unavailable.

- **Business impact:** Permanently public API coordinates; severity scales with any RLS drift.
- **Recommended fix:** Run the verification SQL to close the drift question; rotate to a fresh publishable key and rebuild; consider history rewrite if the repo is/becomes public.
- **Effort:** M.

### M10. Kameti "provably fair" ballot is not a real commit-reveal — the organiser can re-roll until the draw suits them — UNVERIFIED (merges the low-severity duplicate)

**Evidence:** src/stores/committeeStore.ts:115-130 (seed, commitment, and slot order generated and persisted in one client-side call), src/lib/committeeDraw.ts:55-66, supabase-migration-committees.sql:55-73 (organizer-owned rows, plain UPDATE policies — the DB accepts any (seed, commitment, order) triple, even mutually inconsistent ones), supabase-migration-committees-phase2.sql:1-57 (the witness RPC serves stored values verbatim to anon as the honest record).

A commitment is binding only if published *before* the randomness is used; here nothing is shown to members pre-draw, so the organiser can re-run locally (or write via PostgREST) until they draw slot 1, then persist the matching pair. Every witness verification then passes. The feature's entire differentiator — provable fairness for a trust-sensitive instrument — is spoofable by the one party it exists to constrain.

- **Business impact:** Headline anti-scam guarantee is decorative; reputational blast radius if a rigged draw is ever demonstrated.
- **Recommended fix:** Two-phase server flow: RPC stores the hash-only commitment and notifies members; a later RPC accepts the seed, verifies `sha256(seed)=commitment`, and computes the order in SQL; ideally mix per-member entropy.
- **Effort:** M.

### M11. All per-user rate limits bypassable via free multi-account signup and TOCTOU bursts — UNVERIFIED

**Evidence:** src/stores/supabaseAuthStore.ts:110-115 (signUp passes no captcha token; dashboard captcha state unverifiable), p0-launch-blockers.sql:250-266 and connections-push-discovery.sql:341-350 (limiters keyed on auth.uid() only, count-then-insert with no locking — parallel bursts all pass).

N throwaway accounts multiply every quota by N: phone discovery becomes N×1,200 numbers/hour against the UAE/PK numbering space; join-code guessing N×5/5min (moot while H1 stands, but relevant after the fix).

- **Business impact:** Documented anti-enumeration/anti-brute-force protections are far weaker than their comments claim.
- **Recommended fix:** Enable Supabase captcha + email confirmation, add IP-based limits (edge/WAF), make limiters transactional (advisory lock).
- **Effort:** M.

### M12. No server-side bounds on money values — poisoned amounts/splits insertable into shared group ledgers — UNVERIFIED

**Evidence:** supabase-schema.sql:59-105, 210-230, 509-514 (transactions/loans/group_expenses amounts are unconstrained NUMERIC — no CHECK > 0, no cap, no currency whitelist), supabase-migration-enforce-active-group-transaction-members.sql:41-59 (splits JSONB validated only for member-id membership — not positivity, numeric type, or summing to the amount).

Personal tables are self-harm; group_expenses is cross-user: any connected member can insert `amount=0.01, splits=[{memberId: victim, amount: 50000}]` and every member's client computes balances from the poisoned row.

- **Business impact:** Cross-user balance corruption in shared groups; garbage-data DoS.
- **Recommended fix:** Extend the existing trigger to validate split sums; CHECK constraints (amount > 0, sane cap, currency IN (...)) across money tables.
- **Effort:** M.

### M13. Receipts bucket has no size or MIME limits — single-account storage-quota exhaustion — UNVERIFIED

**Evidence:** supabase-migration-receipts.sql:14-32 (bucket created with no file_size_limit/allowed_mime_types), src/lib/receiptStorage.ts:9-11, 47-76 (compression is client-side only; storage RLS constrains only the `{uid}/` path prefix).

- **Exploit scenario:** One account uploads unlimited 50MB objects under arbitrary names, filling the project quota (1GB free tier) and taking receipt upload down for everyone.
- **Business impact:** Denial-of-wallet; the bucket can also warehouse arbitrary non-image files.
- **Recommended fix:** ALTER bucket with ~2MB file_size_limit and image MIME allowlist; optionally tie object names to transaction ids.
- **Effort:** S.

### M14. Unthrottled notifications → pg_net → edge function → FCM chain: denial-of-wallet — UNVERIFIED

**Evidence:** connections-push-discovery.sql:450-488, push-notify/index.ts:105-125, 167-216, supabase-schema.sql:484-493 (self-inserts always pass RLS).

Every notification INSERT fires trigger → pg_net.http_post → edge invocation → service-role token fetch → one FCM call per device token, with no rate limit anywhere and a deliberate 200-on-failure that prevents backoff. One scripted account looping self-notifications burns edge invocations (free tier 500K/month) and DB writes at PostgREST speed.

- **Business impact:** Quota/cost exhaustion of the push pipeline; real pushes buried.
- **Recommended fix:** Trigger-side per-user rate counter; skip push for self-inserted non-system types; dedupe/batch window.
- **Effort:** M.

### M15. register_push_token repoints any known FCM token to the caller — push-channel hijack — UNVERIFIED (merges the low duplicate)

**Evidence:** connections-push-discovery.sql:413-427 (`ON CONFLICT (token) DO UPDATE SET user_id = excluded.user_id` — no proof of possession, no notification to the displaced owner).

Possession of a victim's token string (logs, debug screenshots, a malicious app on the same device) silently redirects: the victim's loan/settlement alerts go dark, and the attacker's fully-controlled notification traffic (H5) is delivered to the victim's physical device.

- **Business impact:** Targeted suppression of the security-relevant notification channel plus push-content injection.
- **Recommended fix:** Repoint only when the previous owner's session is gone (or revalidate via FCM); notify/invalidate the displaced user; rate-limit claims.
- **Effort:** S–M.

### M16. is_group_member(gid, uid) is a direct RPC callable with arbitrary uid — a membership oracle — UNVERIFIED

**Evidence:** supabase-schema.sql:335-350 and fix-rls-recursion.sql:14-29 (SECURITY DEFINER, GRANT EXECUTE TO authenticated, uid is caller-supplied).

Anyone with harvested UUIDs (H9) and a group id (any ex-member) can confirm exactly which users are connected members of which groups — relationship metadata RLS otherwise hides.

- **Business impact:** Cross-user social/financial-graph disclosure to non-members.
- **Recommended fix:** Revoke the direct grant; expose only a wrapper pinning `uid := auth.uid()`.
- **Effort:** S.

### M17. No abuse controls anywhere: no block, mute, report, or unsubscribe — UNVERIFIED

**Evidence:** src/lib/i18n.ts (grep-verified during H5's confirmation: no block/mute/report strings), phase2b-linked-requests.sql:41-45, p0-launch-blockers.sql:150-161.

Declining is per-item, not per-sender: rejected loan requests can be re-sent indefinitely, force-added groups can't be muted, and there is no report path. For a demographic where debt intimidation is a real harassment pattern, the first determined harasser becomes a trust-and-safety incident with no product answer. Play Store UGC policy also expects in-app report/block for user-to-user content.

- **Business impact:** Unmitigatable harassment; Play UGC-policy exposure; support burden with no tooling.
- **Recommended fix:** A `blocks` table checked by every cross-user RPC/trigger, plus block/report actions on inbox items.
- **Effort:** L.

### M18. delete_current_user relies on undefined FK-cascade ordering against ON DELETE RESTRICT — account deletion can fail outright — UNVERIFIED (finder self-rated PLAUSIBLE; needs a live test)

**Evidence:** p0-launch-blockers.sql:102-138 (single `DELETE FROM auth.users`, comment asserts cascades suffice; drops the ordered soft-delete at :138), prelaunch-hardening.sql:107-127 (transactions→accounts FKs are ON DELETE RESTRICT), prelaunch-hardening.sql:221 (the replaced function explicitly ordered transactions-before-accounts *because of this FK*).

If an accounts row is cascade-processed before the user's transactions rows, the RESTRICT FK raises and the whole deletion fails — for exactly the users with data. Cannot be confirmed from SQL text alone.

- **Business impact:** Potentially broken right-to-delete (a Play data-deletion compliance requirement), failing with a raw FK error.
- **Recommended fix:** Reinstate explicit ordered deletes inside the RPC, or switch those FKs to CASCADE/SET NULL for this path; test against a seeded live database.
- **Effort:** S.

### M19. Kameti witness link: anonymous, unthrottled, plaintext-stored, never expires, no revocation — UNVERIFIED (merges 3 filings)

**Evidence:** committees-phase2.sql:13, 18-57 (share_token stored plaintext, plaintext equality lookup, granted to anon, three subqueries per call, no rate limit, no expiry check), src/stores/committeeStore.ts:132-139 (token created once, reused forever; repo-wide grep finds no rotation/revocation path), src/lib/kametiSlipPdf.ts:72-79 (the URL is printed into every payout slip PDF, forwarded to non-members by design).

Token entropy is sound (24 chars / 256-bit generation), so guessing is infeasible — the risks are (a) lifecycle: once any copy escapes the WhatsApp circle, permanent anonymous access to member names, slots, paid/unpaid status and payout history, forever, with no un-share path; (b) plaintext-at-rest, unlike the correctly-hashed group invites — any future read-path mistake leaks live capabilities; (c) the only unauthenticated endpoint in the system is also unthrottled DB workload (denial-of-wallet).

- **Business impact:** Unbounded-lifetime disclosure of a social financial graph; unauthenticated cost surface.
- **Recommended fix:** Store a hash; add expiry + a "reset witness link" action; per-IP rate limit (edge wrapper or pre-request hook).
- **Effort:** M.

---

## Low findings

All **UNVERIFIED** unless noted; each: evidence → impact → fix.

- **L1. Group invite links never expire; raw token parked in localStorage pre-auth.** splitStore.ts:568 (`expiresAt: null` always), pendingInvite.ts:3-5, App.tsx:190-194. Perpetual capability to join and read group history. *Fix:* default 7-day expiry (server already enforces it); revoke action in group settings. (S)
- **L2. Sign-out leaves user-scoped storage keys behind.** resetAllStores.ts:36-48 list has drifted vs QuickEntry.tsx:1010-1011 (`hisaab_qe_last_source/dest` — previous user's account UUIDs), OnboardingPage.tsx:124, GroupDetailPage.tsx:216, SettingsPage.tsx:632, HomePage.tsx:812. Hygiene today, compounding drift. *Fix:* `hisaab_u:` prefix convention wiped by prefix. (S)
- **L3. Supabase auth tokens (incl. refresh token) in plain localStorage.** supabase.ts:10 default config; mitigated by strict CSP (index.html:22), esc()-disciplined PDF builders, `allowBackup=false`, debugging off. Any future XSS = account takeover. *Fix:* Keystore-backed storage adapter on Capacitor; lint rule banning unescaped `${}` in *Pdf.ts. (M)
- **L4. Client identity derived from mutable `hisaab_supabase_uid` localStorage key across the whole DB layer.** supabaseDb.ts:19-23, dataExport.ts:14-18, receiptStorage.ts:13-17, database.ts:207-210. Backstopped by RLS WITH CHECK; fragility/desync risk (multi-tab, Dexie "anonymous" partition). *Fix:* derive from the cached auth session. (M)
- **L5. Local scheduled reminders not cancelled at sign-out** ✓ (re-checked: resetAllStores.ts contains no LocalNotifications/scheduler call). notificationScheduler.ts:109-117 rebuilds only on boot/resume gated on a signed-in user — already-scheduled "Ali ko 500 AED dena hai" reminders keep firing post-logout. *Fix:* cancel-all in resetAllUserStores/signOut on native. (S)
- **L6. Capacitor deep-link handler routes any URL path with no host validation.** nativeBridge.ts:65-74; combined with pendingInvite auto-resume (pendingInvite.ts:17-27), a malicious app can plant an attacker invite or drop the user on /settings (no-reauth password change, M2). *Fix:* allow-list `/join/`, `/u/`, `/kameti/witness/` and verify origin. (S)
- **L7. Live production Sentry DSN committed in .env.example** ✓ (re-read: .env.example:8 carries the real DSN). Quota-exhaustion griefing buries launch crash telemetry. *Fix:* placeholder + inbound filters. (S)
- **L8. statementPdf interpolates `section.currency` unescaped** ✓ (re-checked: statementPdf.ts:133-136, 213 raw; siblings groupSettleUpPdf.ts:110 / kametiSlipPdf.ts:107 esc() it; sink is `el.innerHTML` at renderNodeToImage.ts:52 where `<img onerror>` executes). Currently self-XSS-only (currency constrained by UI + AED/PKR CHECK on cross-user tables; loans.currency has no CHECK) — one schema change from cross-user stored XSS. *Fix:* esc() everything; CHECK constraint on currency; prefer createElement/textContent. (S)
- **L9. CSP `img-src ... https:` is a ready-made exfiltration channel** for any future injection (index.html:22). *Fix:* tighten to `'self' data: blob: https://*.supabase.co`. (S)
- **L10. Runtime Google Fonts dependency** (index.html:43-45) leaks user IPs to Google on every load (GDPR precedent; at odds with the "nothing to leak" pitch); SW never caches cross-origin fonts (sw.js:35-46). *Fix:* self-host Geist woff2, drop the two hosts from CSP. (S)
- **L11. push-notify edge hygiene:** unencoded `userId` in the PostgREST filter URL (index.ts:107 — filter-injection primitive with service-role scope if the shared secret ever leaks), non-constant-time secret compare (:135), raw `String(err)` echoed (:226). *Fix:* encode+UUID-validate, timing-safe compare, generic errors. (S)
- **L12. Rate-limit/attempt tables grow without bound.** join_code_attempts has no pruning (p0:200-213); succeeded rows are never read. *Fix:* prune inside the RPC (as phone_lookup_attempts does) or pg_cron. (S)
- **L13. Group owner can hard-DELETE a shared group,** cascading away every member's history with no balance gate (prelaunch-hardening.sql:55-57; children all ON DELETE CASCADE) — asymmetric with the strict leave gate members face. *Fix:* deletion RPC requiring zero balances, or soft-delete. (M)
- **L14. FK existence is the only cross-row ownership check** for transactions.source/destination_account_id and person_id (prelaunch-hardening.sql:107-127; phase1-persons.sql:51-61) — cross-user references are insertable if ids leak (RESTRICT FKs can then pin a victim's account against deletion). Defense-in-depth debt. *Fix:* composite FKs `(id, user_id)`. (M)
- **L15. Linked-request tables CHECK currency IN ('AED','PKR')** (phase2b:14, phase2c-a:167, fix-bidirectional:25) while the app sells 8 currencies — flagship cross-user flows fail with raw check_violation for PHP/GCC users. *Fix:* widen the CHECK. (S)

---

## Thematic sections

### Auth
Session lifecycle is the weakest layer: sign-out can silently fail to end the session (H8), the recovery link is a magic login with no forced rotation (M3), password change and account deletion need no re-auth (M2), email verification is render-only (M4), and the advertised PIN gate does not exist (H7). Positive: the password-reset endpoint deliberately avoids user enumeration in its response message (supabaseAuthStore.ts:196-198). All device-local protections ultimately reduce to "whoever holds the phone holds the account".

### Authorization / RLS
The RLS model's fatal pattern is *client-writable trust predicates*: self-inserted group membership in the base schema (C1), forged contact-link consent (H2), owner-manufactured 'connected' status (H6), member-readable invite credentials (H3), and ownership-only (not membership-aware) mutation policies on shared ledger rows (H4). SECURITY DEFINER helpers are over-granted (M16), and the whole stack's true production state is unprovable (M1) — which converts every conditional finding into a live question. Server-side value validation is nearly absent on money columns (M12).

### Client-side storage
Auth tokens, PIN hash, uid, and preferences all live in plain localStorage (L3, H7-sub, L4); sign-out cleanup is incomplete (L2, L5, M5) and can fail entirely (H8); backup import will write any key a JSON file dictates (M8). The Dexie mirror is uid-partitioned but keyed off the same mutable localStorage uid (L4). Android hardening (allowBackup=false, no WebView debugging) is done right.

### Injection / XSS
Genuinely strong: strict meta-CSP, no third-party scripts, React escaping everywhere, and a single `innerHTML` sink whose feeders esc() user input — except one currency interpolation (L8). Residual risk concentrates in (a) header delivery — the CSP's frame-ancestors/reporting halves don't exist because nothing is sent as an HTTP header (M7), (b) the wide-open `img-src https:` exfil channel (L9), and (c) attacker-controlled *text* (not markup) injected through the notifications table and rendered with the app's own trust chrome (H5) — phishing, not XSS, but operationally worse for this audience.

### Secrets
The production anon key + project URL live permanently in git history and were never rotated (M9); a live Sentry DSN sits in .env.example (L7); the push-pipeline shared secret is compared non-constant-time and guards a service-role-scoped code path (L11). The kameti witness capability token is stored plaintext, unlike the correctly-hashed invite tokens (M19 vs H3's opposite problem — one flow hashes but leaks the hash, the other never hashes at all).

### Abuse / enumeration
Every guessable identifier except phone numbers is un- or mis-throttled: profile codes have no limiter (H9), the join-code limiter provably cannot fire (H1), and all limiters are multiplied by free account creation and TOCTOU bursts (M11). Discovery permits passive phone impersonation with a UI verified-badge (H10). There are zero victim-side controls — no block, mute, or report (M17) — and multiple unthrottled cost surfaces (M13, M14, M19) expose the free-tier project to denial-of-wallet from a single account.

---

## Refuted during verification

None — all 15 adversarially-checked findings were CONFIRMED by both refuters. The remaining findings were not adversarially checked and are labeled UNVERIFIED throughout; the lead auditor independently spot-checked citations for M2, M3, M7, M8, M9, L5, L7, and L8 (all held).

---

## Evidence-unavailable / further investigation

The following cannot be determined from the repository and materially condition the findings above:

1. **Live Supabase schema state** — which of the 40+ hand-applied migrations (and *-verification.sql checks) are actually in effect (`pg_policies`, `pg_proc`, `pg_trigger`). The repo's own tracker (docs/play-store-launch-tracker.md:30) shows the prod security verification was never run, and project memory records the connections-push-discovery and cross-user-account-effects migrations as pending. **This is the first thing to close: C1, H2's live variant, M1, M6, and M18 all pivot on it.**
2. **Push pipeline liveness** — app_push_config rows, pg_net enablement, edge-function deployment, PUSH_SHARED_SECRET / FCM service-account secrets. Determines whether H5/M14/M15 reach OS push today or remain in-app-only.
3. **Supabase dashboard auth settings** — "Confirm email" enforcement (M4), "secure password change"/reauth (M2, H8's takeover coda), captcha on signup (M11), token lifetimes, per-IP auth rate limits, legacy/sibling keys for the leaked publishable key (M9).
4. **Storage state** — live receipts-bucket policies and any project-level size limits (M13).
5. **Realtime publication state** — whether the publication migrations were applied (text is policy-correct).
6. **Runtime confirmation of M18** — requires executing delete_current_user for a seeded user with transaction history on a live database.
7. **Vercel project-level headers** — whether anything beyond vercel.json is injected (M7 assumes vercel.json is the whole story).
8. **Real-device behavior** — WebView localStorage-at-rest handling per OEM (L3), meta-CSP enforcement in the Android WebView (M7), persistence of scheduled local notifications across the sign-out scenarios (L5).
9. **GitHub remote visibility** — public vs private for github.com/SpartanAbdullah/Hisab; scales M9 and L7.
10. **Sentry org-side settings** — server-side scrubbing, inbound filters, quota (L7; client sets sendDefaultPii:false).
11. **Production volumes and plan/quotas** — needed to size the denial-of-wallet findings (M13, M14, M19) precisely; plus any WAF/CDN rate limiting in front of *.supabase.co (Vercel serves only static assets — API traffic goes direct).

*Report prepared by the consolidating lead auditor, 2026-09-02. Sources: 4 independent finder reports, 2-round adversarial verification notes, and direct spot-checks of the working tree at commit 2248327.*
