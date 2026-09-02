# Supabase Usage Audit — Hisaab

**Date:** 2026-09-02
**Scope:** Everything between the React client and Postgres: auth, RLS, RPCs, data fetching, caching/mirror, pagination, realtime, storage, the push-notify edge function, and migration/operations hygiene.
**Method:** Two independent finders, each finding subjected to two adversarial refutation attempts. Findings marked **CONFIRMED** survived both; **UNVERIFIED** findings were not adversarially checked (all such findings here are medium/low severity) — every citation relied on in this report was spot-checked against the repo by the consolidating auditor. One high-severity finding drew a **split verdict (1 refuter upheld, 1 refuted it by database experiment)**; the empirical refutation prevailed and it appears only in the appendix, with a belt-and-braces recommendation.

**Severity scale:** critical = money corruption / data loss / account takeover / cross-user leak / launch blocker · high = significant user harm, security weakness or scaling wall · medium = real but bounded · low = polish.

---

## Summary

Hisaab's Supabase architecture is thoughtfully designed in places — private receipt bucket with owner-only RLS, an optimistic-lock balance RPC, a working phone-lookup rate limiter, consistent `SECURITY DEFINER ... SET search_path` discipline (one lapse) — but it is undermined by four systemic problems:

1. **The caching layer defeats the realtime layer.** The Dexie mirror's 2-minute freshness window swallows cross-device and cross-user realtime events, and the resume-refetch path omits exactly the money tables (accounts, transactions, loans). A user who just accepted a settlement — or whose counterparty did — can look at a wrong balance indefinitely on an open screen. Both findings CONFIRMED (F-RT1, F-RT2).
2. **RLS has leftover-policy and author-check gaps.** A forgotten `FOR ALL` policy lets ex-members write and hard-delete rows in the shared `group_settlements` ledger (CONFIRMED, F-RLS1); the join-code brute-force limiter is a structural no-op because its failure rows are rolled back by the same exception that ends the call (CONFIRMED, F-RLS2); phone discovery accepts unverified self-asserted numbers, an identity-spoofing vector the UI then decorates with a VerifiedBadge (CONFIRMED, F-RLS3).
3. **No pagination anywhere.** Every collection read is an unbounded `select('*')` that PostgREST silently truncates (default cap 1000 rows), and the daily full mirror refresh then *deletes the overflow* from the local cache — silent, permanent-looking loss of transaction history at ~1 year of moderate use (CONFIRMED, F-FE1).
4. **Migration hygiene is the single largest operational risk.** 40+ hand-applied root-level SQL files with no runner, no sequence numbers, no drift detection; the same function is redefined in up to five files, an alphabetical-order trap silently regresses settlements to debtor-only, and the repo's own history records two prior production incidents of exactly this class (CONFIRMED, F-MIG1). A schema/client contract drift already exists: cross-user request tables hard-CHECK `currency IN ('AED','PKR')` while the client ships 8 currencies (CONFIRMED, F-MIG2).

Nothing found rises to money-corruption-critical on the server (RLS/RPC guards and the optimistic lock hold for the core account tables), but seven high-severity findings stand, most with small fixes.

---

## Explicit answers

### Is Supabase being used correctly?

**Partially.** The strong points: all entity access funnels through one module (`src/lib/supabaseDb.ts`), definer RPCs guard the sensitive cross-user mutations, `search_path` is pinned on definer functions (except `handle_new_user`, F-AUTH3), the receipts bucket is private with owner-scoped policies, and the phone-lookup rate limiter is implemented correctly. The incorrect uses are structural, not stylistic: (a) the RLS estate has leftover permissive policies that OR past the carefully-built stricter ones (F-RLS1, F-RLS4, F-RLS5); (b) rate-limiting state is written inside the same transaction that raises the failure exception, so it never persists (F-RLS2); (c) client-side fan-out of notifications substitutes for server-side triggers, making notification content forgeable and delivery best-effort (F-RLS6, F-RT6); (d) auth identity is duplicated into a localStorage cache consumed by ~20 call sites instead of derived from the session (F-AUTH2).

### Is data over-fetched?

**Yes, in three ways.** (1) Every collection read is `select('*')` with no column projection and no limit — the only two `.limit()` calls in `src/` are activities and notifications at 100 (`src/lib/supabaseDb.ts:806, :1288`). (2) Cold boot fetches the `profiles` row three separate times and fires ~11 store loads, then the first mounted page re-invokes several of the same loads within a second (F-FE3, UNVERIFIED). (3) A single app foregrounding can fire up to three overlapping refresh storms (visibilitychange + focus + native appStateChange), each ~6 parallel queries, with no in-flight guard (F-RT4, UNVERIFIED). On the 3G-class connections of the target market this is both slow and expensive against Supabase free-tier egress.

### Is data under-cached?

**Simultaneously under- and over-cached — the worse combination.** Over-cached where it hurts: the 2-minute mirror freshness window plus the fire-and-forget background refresh means remote changes render late or never on an open screen (F-RT1), and the incremental-sync cursor uses the client clock, so a fast device clock silently drops remote edits for up to 24h (F-RT5, UNVERIFIED). Under-cached where it would help: signed receipt URLs are re-minted on every render with no memoization (F-ST1), non-mirrored stores (persons, groups, notifications, committees) have no freshness guard at all and hit the network on every trigger, and the unread badge is derived from a 100-row page instead of a cheap `head:true` count (F-RT8, UNVERIFIED).

### Are there security concerns?

**Yes — seven substantive ones**, four CONFIRMED: the ex-member writable/hard-deletable `group_settlements` ledger (F-RLS1), the no-op join-code brute-force limiter (F-RLS2), unverified phone-number discovery enabling identity spoofing in a trust-based debt app (F-RLS3), and the manually-applied-migration estate whose live state is unknowable (F-MIG1, an operational security problem). The UNVERIFIED-but-spot-checked cluster: any group co-member can insert arbitrary-text notifications that the pg_net trigger forwards verbatim as native pushes (F-RLS6); invite `token_hash` is both member-readable and accepted as the bearer credential, enabling guest-seat takeover (F-RLS5); `persons_delete_own` bypasses the entire safe-archive machinery (F-RLS4); `register_push_token` lets any authenticated caller seize any known FCM token (F-RLS7); the anon-callable committee witness endpoint has no throttle, expiry, or revocation (F-RLS8); `lookup_profile_by_code` is unthrottled, enabling code→name enumeration (F-RLS9). No finding reaches account-takeover or direct server-side money-corruption severity.

### Are there scalability risks?

**Yes, two walls plus operational decay.** (1) Realtime: 12 RLS-checked `postgres_changes` bindings per signed-in user, on the highest-write personal tables — the exact per-change authorization fan-out pattern Supabase documents as the first thing to degrade — while the collaborative group tables that would actually benefit from realtime are not published at all (F-SC1, F-SC2, UNVERIFIED). (2) The 1000-row PostgREST cap is not just a fetch bug but a hard functional ceiling: the app's own analytics, exports and mirror break silently past it (F-FE1, CONFIRMED). Decay: `join_code_attempts` grows forever with no TTL and no FK to the user; `phone_lookup_attempts` cleanup runs a global unscoped DELETE on every call (F-MIG4, UNVERIFIED). None of this blocks a small closed launch; all of it bites before meaningful MAU.

---

## Findings by area

### Auth

#### F-AUTH1 · signUp seeds `public_code` with a discarded, session-less write; `updateProfile` ignores errors — **medium, UNVERIFIED**

With email confirmation enforced (the app hard-blocks unverified users, `src/App.tsx:422-428`), `supabase.auth.signUp` returns `data.session = null`, yet `supabaseAuthStore.signUp` immediately issues `supabase.from('profiles').update({onboarding_completed:false, public_code...})` (`src/stores/supabaseAuthStore.ts:110-143`). With no session this runs as anon, RLS matches 0 rows, and the result is discarded unchecked — the seed comment describes behavior that cannot happen on the primary signup path. It also caches `hisaab_supabase_uid` for a session-less user (line 130), priming anon-role queries. The flow survives only because `MyConnectCode`/Settings regenerate a missing code on demand (`src/components/MyConnectCode.tsx:33-36`). Similarly `updateProfile` (`supabaseAuthStore.ts:201-205`) never checks the update error — a failed language/currency/app_mode save looks successful.
**Fix (S):** check and surface errors on every profiles write; seed `public_code` via a DB default on the profile-creation trigger; cache the uid only when a session exists.

#### F-AUTH2 · `hisaab_supabase_uid` localStorage cache is a second source of auth truth for ~20 call sites — **medium, UNVERIFIED**

Every DB helper filters by `getUserId()` read synchronously from localStorage rather than the Supabase session (`src/lib/supabaseDb.ts:19-23`; also `src/lib/receiptStorage.ts:13-17`, `src/db/database.ts:207-210`). When the cache is absent/stale (WebView storage cleanup, multi-tab sign-out race) consequences vary by path: raw unlocalized `'Not authenticated'` throws deep inside loaders; `splitStore.findCurrentMember` falls back to treating the user as the group **owner** when the uid is null (`src/stores/splitStore.ts:228-231`), so split attribution defaults wrongly; Dexie selection forks into an `'anonymous'` mirror database. Writes stay protected by RLS; reads and identity checks are not.
**Fix (M):** derive uid from the auth store/session (memoized), treat localStorage as a boot hint; make `findCurrentMember` return `undefined` instead of owner-fallback.

#### F-AUTH3 · `handle_new_user` is SECURITY DEFINER without a pinned `search_path` — **low, UNVERIFIED**

The one lapse in otherwise-consistent definer discipline (`supabase-schema.sql:24-35`). Body is schema-qualified so practical injection risk is negligible; this is the standard Supabase `function_search_path_mutable` lint.
**Fix (S):** `ALTER FUNCTION public.handle_new_user() SET search_path = public;`

#### F-AUTH4 · Deleted-account gate fails open and re-queries on every auth event — **low, UNVERIFIED**

`isDeletedProfile` returns `false` on ANY error (`src/stores/supabaseAuthStore.ts:33-41`), so a deleted account whose profiles read fails proceeds into the app; the check also re-runs a profiles select on every `onAuthStateChange` including hourly `TOKEN_REFRESHED`. Risk window is small because `delete_current_user` hard-deletes `auth.users` (`supabase-migration-p0-launch-blockers.sql:102-133`), but fail-open is the wrong default for a security gate.
**Fix (S):** cache the verdict per user per session; treat errors as "unknown, retry."

#### F-AUTH5 · Missing Supabase env vars produce a fake "local-only mode" message — **low, UNVERIFIED**

`src/lib/supabase.ts:6-10` logs "running in local-only mode" and constructs `createClient('', '')`. No local-only mode exists anywhere; a misconfigured build boots to an auth screen with opaque fetch errors while the console actively misdirects the debugger.
**Fix (S):** fail fast with an explicit configuration-error screen.

---

### RLS & authorization

#### F-RLS1 · `group_settlements` can be written and hard-deleted by non-members: leftover `FOR ALL` policy ORs past the membership-checked policies — **HIGH, CONFIRMED**

Permissive RLS policies OR together. Prelaunch hardening deliberately dropped the `FOR ALL` policy on `group_expenses` and replaced it with per-command membership-checked policies (`supabase-migration-prelaunch-hardening.sql:63-64`) — but on `group_settlements` it **re-created** `"Users can manage own settlements" FOR ALL USING/WITH CHECK (auth.uid() = user_id)` with no membership condition (`prelaunch-hardening.sql:59-61`; original at `supabase-schema.sql:249`; spot-checked — no later migration drops it). This bypasses the stricter connected-members INSERT policy (`supabase-migration-fix-rls-recursion.sql:94-100`). The validation trigger checks only that `from_member`/`to_member` are connected members — never that the **author** is a member (`supabase-migration-enforce-active-group-transaction-members.sql:74-109`), and it skips re-validation on amount-only UPDATEs (lines 80-83). The DELETE policy is authorship-only (`prelaunch-hardening.sql:307-310`).

**Exploit:** an ex-member (who retains the group id and member ids — ids are client-side uuidv4, `src/stores/splitStore.ts:2`) INSERTs a fabricated "A paid B 5,000" settlement, or UPDATEs amounts on, or hard-DELETEs, their own historical settlement rows post-departure. Balances are computed purely from `from_member/to_member/amount` ignoring the author (`src/lib/groupDebts.ts:47-51`, `src/lib/supabaseDb.ts:1088-1099`), so every remaining member's balances shift. In splits_only mode this ledger IS the entire money record.
**Fix (S):** drop the `FOR ALL` policy (mirror the `group_expenses` treatment) with per-command policies requiring `is_group_member(group_id, auth.uid())` AND authorship; extend the trigger to require the author be a connected member and to re-validate on amount changes.

#### F-RLS2 · Join-code brute-force rate limiter is a no-op: failure rows are rolled back by the exception that ends the call — **HIGH, CONFIRMED**

All three generations of `join_group_by_code` INSERT a failure row into `join_code_attempts` and then immediately `RAISE EXCEPTION` in the same function with no exception sub-block (`supabase-migration-fix-group-invite-join-rpc.sql:48-49` — spot-checked; also `supabase-migration-p0-launch-blockers.sql:264-265`, `supabase-migration-prelaunch-hardening.sql:388-395`). A PostgREST RPC is one transaction; the RAISE rolls back the INSERT, so failed attempts never persist. The `v_failures >= 5 → RATE_LIMITED` gate (`fix-group-invite-join-rpc.sql:33-40`) counts only `succeeded = false` rows and structurally always sees 0 — dead code. Only successful joins commit (line 76). The prelaunch header explicitly names the 32^6 brute-force surface this was built to close (`prelaunch-hardening.sql:15`). Contrast: `lookup_hisaab_users_by_phone` gets the pattern right by recording on the non-raising path (`supabase-migration-connections-push-discovery.sql:341-350`).

**Impact:** an authenticated attacker (self-registration is open) scripts unlimited `join_group_by_code` calls; a hit grants membership and read access to the group's full expense/settlement ledger. Residual protection is only code entropy (~2^30) plus the 14-day expiry.
**Fix (S):** make the RPC return a status object instead of raising, so the attempt INSERT commits — the simplest correct pattern.

#### F-RLS3 · Phone discovery accepts unverified self-asserted numbers — anyone can claim any phone number and become discoverable as it — **HIGH, CONFIRMED**

`profiles.phone_e164`/`phone_discoverable` are ordinary self-service columns by the migration's own admission (`supabase-migration-connections-push-discovery.sql:303-310, 366-369`), written via a plain client UPDATE (`src/lib/supabaseDb.ts:492-498`); the protect-security-fields trigger guards only id/is_deleted/deleted_at/created_at (`supabase-migration-p0-launch-blockers.sql:39-47`). No OTP/verification infrastructure exists anywhere in the repo. The index is deliberately non-unique, and `lookup_hisaab_users_by_phone` returns `(phone, profile_id, display_name)` for any discoverable match (`connections-push-discovery.sql:352-360`). Aggravating: the discovery hit renders a one-tap link button decorated with a **VerifiedBadge** (`src/pages/ContactDetailSheet.tsx:734`), branding an unverified self-asserted match as verified. The 20/hour rate limit throttles enumeration but does nothing against spoofing — the victim's friends reach the fake row through legitimate lookups of a number they already have saved.

**Exploit:** attacker sets a victim's number + name; the victim's community is told "this contact is on Hisaab," links contacts, and sends linked udhaar/settlement requests to the attacker, seeding a fraudulent mutual debt ledger under the victim's identity — in an app whose records back real off-app cash settlements.
**Fix (L):** gate `phone_discoverable` behind Supabase phone OTP (or equivalent); block direct `phone_e164` writes via the existing protect trigger once verified.

#### F-RLS4 · `persons` DELETE policy bypasses the entire safe-archive machinery — **medium, UNVERIFIED (citations spot-checked)**

`safe-contact-archive` builds an RPC refusing to archive contacts with unsettled balances or a `linked_profile_id`, plus triggers blocking direct archived_at writes (`supabase-migration-safe-contact-archive.sql:17-126`) — but `persons_delete_own` (`FOR DELETE USING (user_id = auth.uid())`, `supabase-migration-phase1-persons.sql:34-36` — spot-checked) was never dropped. A plain PostgREST DELETE hard-removes any contact; FKs set `loans.person_id`/`transactions.person_id` to NULL (`phase1-persons.sql:51-62`), detaching loans from the person while the counterparty still sees a live mirror. All the RPC's invariants are advisory.
**Fix (S):** drop `persons_delete_own`; route removals through `archive_contact_if_settled` (the client already does).

#### F-RLS5 · Invite `token_hash` is both member-readable and accepted as the bearer credential — **medium, UNVERIFIED (citations spot-checked)**

`"Members can view invites in their groups"` includes `is_group_member` (`supabase-schema.sql:403-413` — spot-checked), so every connected member can SELECT `token_hash`; `accept_group_invite` compares the caller-supplied `p_invite_token_hash` directly against that column (`supabase-migration-fix-group-invite-join-rpc.sql:87, 111` — spot-checked). The stored hash IS the credential; hashing provides no secrecy against anyone who can read the row. A member can read another outstanding invite's hash and accept it, claiming the guest seat (`linked_member_id`) — and the debts attributed to it — that the owner created for a specific person.
**Fix (M):** exclude `token_hash` from member-visible reads (definer RPC returning no hash), and/or have the client send the raw token with server-side hashing.

#### F-RLS6 · Any group co-member can forge arbitrary notifications — delivered verbatim as native pushes — **medium, UNVERIFIED (citations spot-checked)**

*(Merged from two overlapping finder reports.)* The notifications INSERT policy allows inserting a row for any fellow connected member of a shared group with fully client-controlled `type/title/body` (`supabase-migration-notifications-rls.sql:35-44` — spot-checked; original `supabase-schema.sql:484-493`). Fan-out is performed by the acting client (`src/stores/splitStore.ts:245-276`, `src/lib/supabaseDb.ts:1292-1308`), and the `notifications_push` pg_net trigger forwards title/body verbatim to FCM via the push-notify edge function (`supabase-migration-connections-push-discovery.sql:450-488`, `supabase/functions/push-notify/index.ts:1-16`). Nothing validates the content against a template or reserves system types (`linked_settlement`, `contact_linked`) for definer triggers; there is no insert rate limit, so this is also an unmetered FCM spam channel billed to the project.

**Exploit:** join any group via its invite code, then insert `type='linked_settlement', title='Repayment confirmed', body='Asif confirmed the repayment of AED 5,000.'` — or a phishing "account suspended" alert — pushed to every member's Android tray under the app's identity.
**Fix (M):** move fan-out server-side (trigger composes rows from a template); restrict client INSERT on notifications to self only; per-user insert throttle.

#### F-RLS7 · `register_push_token` lets any authenticated user seize any known FCM token; no per-user cap — **medium, UNVERIFIED (citations spot-checked)**

`on conflict (token) do update set user_id = excluded.user_id` (`supabase-migration-connections-push-discovery.sql:413-427` — spot-checked) is deliberate for shared-phone re-login, but there is no proof-of-possession: any caller who learns a token string re-points it, silently stripping the victim's push delivery and routing the attacker's notification content to the victim's device. Separately, ids are `gen_random_uuid()` per call with no cap — one user can insert unbounded junk token rows, each a guaranteed-failing FCM send amplifying edge-function work.
**Fix (S):** cap tokens per user (delete-oldest); log/notify on ownership change.

#### F-RLS8 · `get_committee_witness` is anon-callable with no rate limiting, expiry, or revocation — **medium, UNVERIFIED (citations spot-checked)**

Granted to `anon` and gated only by `length(p_token) >= 8` plus exact match (`supabase-migration-committees-phase2.sql:25, 57` — spot-checked). The client generates 256-bit tokens (`src/stores/committeeStore.ts:136`) so guessing is infeasible today, but the DB accepts any token ≥8 chars, enumeration attempts are invisible, and a token forwarded on WhatsApp (the intended channel) grants **permanent** anonymous access to member names, per-round payment status, and payout order — no expiry or revocation column exists.
**Fix (M):** token expiry/rotation, server-side minimum length 32, and a phone_lookup-style attempt log/throttle for anon calls.

#### F-RLS9 · `lookup_profile_by_code` has no rate limit — public-code → name enumeration — **medium, UNVERIFIED (citations spot-checked)**

Unthrottled exact-match lookups return `profile_id + display_name` for any authenticated caller (`supabase-migration-p0-launch-blockers.sql:369-385` — spot-checked). Same 32^6-order code space the prelaunch migration called a brute-force surface for groups; join codes got a (broken, F-RLS2) limiter and phone lookup got a working one, but this — the app's primary contact-linking handle — got none. Each discovered (uuid, name) can then be added as a contact and pinged via the `notify_contact_linked` flow (`supabase-migration-connections-push-discovery.sql:97-102`), i.e. cold-contact spam through a consent mechanism designed to require the code being shared.
**Fix (S):** reuse the working `phone_lookup_attempts` throttle pattern.

#### F-RLS10 · Restrictive "Active profiles only" soft-delete gate omits committees, custom_categories, and every table created after June 2026 — **medium, UNVERIFIED**

The RESTRICTIVE policy loop enumerates 20 tables by hand (`supabase-migration-p0-launch-blockers.sql:74-96`); `committees*`, `custom_categories` (which predate the list), `investment_*`, `contact_link_requests`, and `device_push_tokens` are all missing. Bounded because `delete_current_user` now hard-deletes `auth.users`, but the defense-in-depth layer silently decays with every new table.
**Fix (S):** loop over `information_schema` tables having a `user_id` column, or make the policy a per-migration checklist item enforced by a verification script.

#### F-RLS11 · Owner account deletion cascades away entire shared groups, destroying other members' expense history — **medium, UNVERIFIED (cascade citation spot-checked)**

`split_groups.user_id REFERENCES auth.users ON DELETE CASCADE` (`supabase-schema.sql:194` — spot-checked), and `group_expenses`/`group_settlements` cascade from `split_groups` (:213, :238). `delete_current_user`'s comment acknowledges cascading "owned groups" (`supabase-migration-p0-launch-blockers.sql:126-129`) — but an owned group contains other members' expenses, settlements and balances. No ownership-transfer path exists (`leave_group` refuses owners, `supabase-migration-safe-leave-group.sql:100-106`), so an owner's only exit deletes everyone's shared ledger without consent or notice. In a community where these records back real cash settlements, this is a trust-destroying support fire waiting for launch scale.
**Fix (M):** transfer ownership to the oldest connected member (or orphan the group with members retained) instead of cascading.

---

### Data fetching & pagination

#### F-FE1 · No pagination anywhere: unbounded selects silently capped by PostgREST, and the daily full refresh deletes the overflow from the local mirror — **HIGH, CONFIRMED**

`transactionsDb.getAll()`, `loansDb.getAll()`, `groupExpensesDb.getAllVisible()`, `groupSettlementsDb.getAllVisible()` and every other collection read issue `select('*')` with no `.limit()`/`.range()` (`src/lib/supabaseDb.ts:128-135, :220-227, :961-968, :1078-1085`); a repo-wide grep finds exactly two limits in `src/` (activities/notifications at 100, `:806, :1288`) and zero `.range()` calls. PostgREST applies a server-side max-rows cap (hosted default 1000) and returns a truncated result **without an error**. Transactions are ordered `created_at DESC`, so past ~1000 rows (~1 year at 3/day) only the newest survive — and the forced 24h full refresh (`DEFAULT_FULL_REFRESH_MS`, `src/lib/mirrorCache.ts:6`) does `table.clear() + bulkPut` of the truncated set (`mirrorCache.ts:107-114, 131-143`), physically deleting older history from the Dexie mirror. Analytics sums client-side over that array (`src/pages/AnalyticsPage.tsx:45, 82-133`); CSV export calls `getAll` directly (`src/lib/dataExport.ts:23`). Server rows are never deleted, but the loss is invisible and looks permanent to the user.
**Fix (M):** keyset pagination (paged loop on `created_at,id`) in the getAll fetchers, or a UI window with on-demand older pages; at minimum assert `data.length < serverMax` and surface truncation.

#### F-FE2 · Inconsistent single-row error handling: `return null` on ANY error conflates "row gone" with "network down" — **medium, UNVERIFIED**

`transactionsDb.get`, `splitGroupsDb.get`, `groupInvitesDb.getByTokenHash` and `profilesDb.getCurrent` all do `if (error) return null` (`src/lib/supabaseDb.ts:121-127, :904-910, :1228-1235, :1336-1344`). The team already learned this lesson once — `groupExpensesDb.probeExists` exists specifically so "a flaky connection must keep the guard, not release it and let a live group's mirror be deleted" (`supabaseDb.ts:1027-1039`) — but callers like `splitStore.getGroupOrFetch` (`src/stores/splitStore.ts:222-226`) still treat null-from-any-error as "missing." Mixed conventions (throw vs null vs raw error object) make every new call site a judgment call.
**Fix (M):** standardize — throw on transport errors, `null` only on PGRST116/0-rows, or a typed `{status}` result.

#### F-FE3 · Boot performs three separate profiles reads plus ~13 store loads; pages re-fetch on mount — **medium, UNVERIFIED**

`isDeletedProfile()` in `initialize()` (`src/stores/supabaseAuthStore.ts:67-71`), `profilesDb.getCurrent()` in `checkOnboarding` (`src/stores/onboardingStore.ts:44-46`), and `getProfile()` in `App.tsx:349` each fetch the same row on cold start. The boot effect then fires ~11 store loads (`src/App.tsx:266-331`) and the first page re-invokes several within a second (`src/pages/HomePage.tsx:143-147`, `src/pages/LoansPage.tsx:104` — seven loads). Only the four mirrored stores dedupe via freshness. 2–3x avoidable request volume per session; slower first paint on the target market's 3G-class connections.
**Fix (M):** fetch the profile once and pass it down; give non-mirrored stores a loadedAt/in-flight guard.

---

### Realtime & sync

#### F-RT1 · Cross-device/cross-user realtime updates are swallowed by the mirror's 2-minute freshness window and never re-rendered — **HIGH, CONFIRMED**

`realtime.ts` subscribes to accounts/transactions/loans precisely to "sync across devices" (`src/lib/realtime.ts:68-91`) and debounce-calls `loadX()` on each event — but `loadX()` goes through `loadCacheFirst()`, which (a) returns the Dexie cache with **no network fetch at all** when `lastSyncedAt` is under `DEFAULT_FRESH_MS = 2 min` (`src/lib/mirrorCache.ts:5, 186-191` — spot-checked), and (b) when stale, still returns cached rows and fires the refresh as a `void` background promise whose result reaches only Dexie — the Zustand store is set once from the pre-refresh rows (`src/stores/loanStore.ts:42-57`, `accountStore.ts:42-49`, `transactionStore.ts:740-748`) and no Dexie liveQuery exists to re-render when it lands. `markMirrorStale` is called only by LOCAL writes. Net: a remote change (another device, or the accept-settlement RPC moving this user's balance from the other side) is either fully ignored or renders old data; catch-up requires freshness expiry PLUS two successive loads.

**Aggravating (verifier-discovered):** even the accepting device's OWN post-accept reloads (`src/stores/settlementRequestStore.ts:86-91`, `linkedRequestStore.ts:140-142`) hit the same fresh-cache short-circuit with no prior `markMirrorStale` — the user who just accepted a settlement sees pre-settlement balances immediately after accepting.
**Fix (S):** `markMirrorStale(key)` on remote events before the debounced reload; have `loadCacheFirst` re-set the store when the background refresh resolves.

#### F-RT2 · `refreshLiveData()` on resume/reconnect omits exactly the money tables whose missed events are unrecoverable — **HIGH, CONFIRMED**

The resume design's own comment concedes the Android WebView kills the socket silently and "a missed event leaves no trace to detect" (`src/lib/realtime.ts:166-183`) — yet the `Promise.all` (`realtime.ts:184-193`) refetches only notifications, linked/settlement/contact-link requests, persons and groups. Accounts, transactions and loans — the tables the same file subscribes to, and which the cross-user SECURITY DEFINER RPCs mutate from the other side (`supabase-migration-cross-user-account-effects.sql:302-368, 453-456`) — are not refreshed. Every resume path funnels here: native `appStateChange` (`src/lib/nativeBridge.ts:83-100`), web visibility/online/focus (`src/App.tsx:229-238`), push receipt. A settlement accepted while backgrounded updates the server but the resumed app shows old balances until mirror expiry plus repeated loads (compounded by F-RT1) — while the inbox/notifications DO refresh, so the user sees "accepted" beside stale numbers. This is the most common mobile lifecycle reliably producing the exact symptom the resume machinery was built to kill.
**Fix (S):** include `loadAccounts/loadTransactions/loadLoans` (with `markMirrorStale` first) in `refreshLiveData`.

#### F-RT3 · Realtime channel subscribed with no status callback — failures invisible, no foreground retry — **medium, UNVERIFIED**

`.subscribe()` at `src/lib/realtime.ts:154` takes no `(status, err)` callback, so CHANNEL_ERROR/TIMED_OUT/closed are silent. Recovery exists only via `channelIsHealthy()` inside `resumeGlobalRealtime()`, triggered exclusively by visibility/focus/online/appState events (`src/App.tsx:228-241`). A mid-session socket error while the user keeps the app visible leaves the session subscribed-in-name-only until the next tab switch — zero telemetry, unreproducible "inbox never updates" reports.
**Fix (S):** subscribe callback; on error states, stop+start with backoff and `refreshLiveData` once rejoined.

#### F-RT4 · Resume fires up to three overlapping refresh storms with no dedup — **medium, UNVERIFIED**

visibilitychange + focus handlers both call the same `onVisible` (`src/App.tsx:228-241`); Capacitor `appStateChange` adds a third (`src/lib/nativeBridge.ts:99`); `refreshLiveData()` has no in-flight guard and no store load early-returns (`src/stores/notificationStore.ts:45-60`). A single foregrounding issues 12–18 REST queries; `online` adds more. Wasted battery/data, higher request volume at scale, interleaved `set()` races.
**Fix (S):** debounce `resumeGlobalRealtime` (~2s trailing) + in-flight promise guard.

#### F-RT5 · Incremental sync cursor mixes client clock with server `updated_at` — a fast device clock silently drops remote edits for up to 24h — **medium, UNVERIFIED**

`refreshMirrorIncremental` writes `syncStartedAt = new Date().toISOString()` (client clock) as the cursor on empty polls (`src/lib/mirrorCache.ts:155-162`), and `maxSyncedAt` falls back to client now when rows lack `updatedAt` (`:127`); the next poll filters `gt('updated_at', cursor)` against SERVER timestamps (`src/lib/supabaseDb.ts:38-47`). A device clock X minutes fast makes every server write inside the skew window invisible to incremental sync, healed only by the 24h full refresh. Undebuggable in the field.
**Fix (S):** server-derived cursors only — keep the previous cursor on empty polls.

#### F-RT6 · Group notification delivery depends on the writer's client finishing a best-effort fan-out; failures swallowed, no retry — **medium, UNVERIFIED**

`fanOutGroupUpdate` runs after the money write, catches every error and only console.errors it (`src/stores/splitStore.ts:241-276`). Network drop/tab close/RLS rejection between write and fan-out means no `group_events` row, no notifications, no push for anyone — and one bad recipient row voids the whole `addMany` batch. Systematically missed group updates under exactly the flaky connectivity the target users have.
**Fix (M):** generate events/notifications in a DB trigger or RPC atomically with the write (same fix as F-RLS6).

#### F-RT7 · Latent reconnect footgun and narrow sign-out race in the debounce/start logic — **low, UNVERIFIED**

`startGlobalRealtime`'s early return (`src/lib/realtime.ts:44-47`) doesn't verify channel health (keeps a dead channel if ever called for reconnection), and reload timers cleared only on stop can fire a scheduled `loadX` just after sign-out with whatever uid is then in localStorage (`realtime.ts:22-33`).
**Fix (S):** check channel state in the early return; guard scheduled runs with a captured userId.

#### F-RT8 · Unread badge and instant tray notifications computed from only the newest 100 rows — **low, UNVERIFIED**

`notificationsDb.getAll` limits to 100 (`src/lib/supabaseDb.ts:1283-1290`); `unreadCount` filters that page (`src/stores/notificationStore.ts:52`), so the badge undercounts (can read 0 with older unread rows server-side); `instantNotify`'s seen-set primes from the same window (`src/lib/instantNotify.ts:89-111`). Reachable in weeks for an active group user.
**Fix (S):** `head:true` count query filtered on `read_at is null` for the badge.

---

### Scalability (realtime architecture)

#### F-SC1 · 12 RLS-checked `postgres_changes` bindings per signed-in user plus a channel per open group page — **medium, UNVERIFIED**

`startGlobalRealtime` registers 12 separate bindings, several on the same table with different filters (`src/lib/realtime.ts:49-155`); `GroupDetailPage` adds a per-group channel (`:211-223`). Supabase's postgres_changes pipeline evaluates every change against every subscription's RLS on a single replication-slot worker — per-user fan-out of 12+ is precisely the pattern Supabase's guidance says degrades first. High-write `notifications` (one insert per member per group action) rides the same pipeline. No delivery-lag telemetry exists.
**Fix (L):** collapse two-direction subscriptions into or-filters; prefer Broadcast-from-database for fan-out topics; instrument event-to-render latency pre-launch.

#### F-SC2 · The publication covers the full personal money tables while the collaborative group tables are NOT published — **low, UNVERIFIED**

`transactions/accounts/loans` are in the publication (`supabase-migration-linked-notifications-realtime.sql:126-146`, `supabase-migration-realtime.sql:13-29`) — mostly streaming self-echoes at RLS-evaluation cost — while `split_groups/group_expenses/group_settlements`, the tables multiple users actually watch together, are in no publication and no subscription, so a co-member's new expense appears only on reload. The expensive tables stream; the useful ones don't.
**Fix (M):** move personal-table sync to the incremental `updated_at` polling already built; publish the group tables or use broadcast topics.

#### F-SC3 · Realtime coverage depends on publication membership scattered across four hand-applied migrations; a missing one degrades silently — **medium, UNVERIFIED**

The 12 bindings require 9 tables in `supabase_realtime`, whose `ALTER PUBLICATION` statements are spread across four files (`supabase-migration-realtime.sql:16-27`, `linked-notifications-realtime.sql:130-146`, `contact-link-reciprocal.sql:91`, `connections-push-discovery.sql:498-509` — the last believed unapplied per project memory). A channel joins successfully even when a table is absent from the publication; events simply never arrive, indistinguishable from health.
**Fix (S):** one idempotent publication migration listing all subscribed tables; dev-mode self-check against `pg_publication_tables`.

---

### Storage

#### F-ST1 · Receipts: sound private-bucket design, but deleted accounts leave receipt images behind; signed URLs re-minted every render — **low, UNVERIFIED**

The design is good: private bucket keyed `{uid}/{transactionId}.jpg`, owner-only RLS on all four verbs, 30-min signed URLs, client-side compression (`src/lib/receiptStorage.ts:8-11, 67-89`, `supabase-migration-receipts.sql:1-45`). Gaps: (1) `delete_current_user()` never touches `storage.objects`, so a deleted user's receipt photos (financial PII) persist indefinitely — at odds with the account-deletion promise (`supabase-migration-p0-launch-blockers.sql:102-133`); (2) `getReceiptUrl` creates a fresh signed URL per call with no memoization.
**Fix (S):** in `delete_current_user`, delete the user's folder from the receipts bucket; memoize signed URLs for their TTL.

---

### Edge functions & push

#### F-EF1 · push-notify: plaintext shared secret in a DB table, unencoded `user_id` interpolation, no abuse controls — **low, UNVERIFIED**

The only auth is `x-hisaab-push-secret` vs an env var; the secret sits in plaintext in `app_push_config` (RLS-enabled, zero policies — unreadable by clients but visible to any definer compromise, backup, or Studio operator) and travels in pg_net headers persisted in the `net` schema (`supabase-migration-connections-push-discovery.sql:442-448, 465-478`). `fetchTokens` builds `user_id=eq.${userId}` without `encodeURIComponent` (`supabase/functions/push-notify/index.ts:110`). A secret-holder can push arbitrary title/body to ANY user with no rate limit — a second spoofed-push path alongside F-RLS6. The function returns 200 always, so FCM failures live only in unwatched logs.
**Fix (S):** `encodeURIComponent` + UUID validation; secret rotation story; HMAC-signed payload instead of a static header.

---

### Migration hygiene & schema integrity

#### F-MIG1 · No migration runner, no ordering, no drift detection — 40+ hand-applied files with the same function redefined in up to five of them — **HIGH, CONFIRMED**

`accept_settlement_request` is defined in FIVE files (`phase2c-a:288`, `phase2c-b:111`, `fix-bidirectional:259`, `settlement-emi-and-account-guards:24`, `cross-user-account-effects:417`); `tg_lsr_validate_insert` and `join_group_by_code` in four each. Correct final state depends on undocumented chronological application — filenames carry no sequence numbers, and a live **alphabetical-order trap** exists: `fix-bidirectional-linked-settlements.sql` (git-dated 2026-05-09) sorts BEFORE `fix-settlement-request-rls.sql` (2026-05-06), so a directory-order apply re-installs the older debtor-only guard (`fix-settlement-request-rls.sql:68-70`) and silently breaks the creditor-initiated settlements the newer file exists to enable — which the shipped client relies on (`SettleLinkedLoanModal.tsx:22-23`). The repo documents this class biting production twice already (`supabase-migration-fix-settlement-cancel-reject.sql:4-27` — RPCs vanishing → PGRST202). CI (`.github/workflows/ci.yml`) never touches SQL; the verification scripts are manual and cover none of the settlement RPCs. Per project memory, at least four migrations are believed UNAPPLIED in production while the shipped client already calls their RPC signatures (e.g. the 2-arg `accept_linked_request` only exists after `cross-user-account-effects.sql:154-159`; the client falls back to 1-arg only for ledger-only accepts, `supabaseDb.ts:569-576`).
**Fix (L):** adopt Supabase CLI migrations (numbered, tracked); at minimum number the files, maintain a consolidated current-state schema dump, and add a CI job applying all migrations to a throwaway Postgres and running the verification files.

#### F-MIG2 · Cross-user request tables hard-CHECK `currency IN ('AED','PKR')` while the app ships 8 currencies — **HIGH, CONFIRMED**

`linked_transaction_requests` and `linked_settlement_requests` both carry `check (currency in ('AED','PKR'))` (`supabase-migration-phase2b-linked-requests.sql:14`, `phase2c-a-settlement-requests.sql:167`, `fix-bidirectional-linked-settlements.sql:25` — spot-checked; no migration relaxes them). The client supports `['AED','PKR','PHP','SAR','QAR','OMR','KWD','BHD']` (`src/db/types.ts:1`). Some paths gate deliberately (`linkedRequestStore.ts:12-22` filters and surfaces skipped currencies; splits-only QuickEntry gates at `QuickEntry.tsx:712`) — but the primary full_tracker paths are explicitly un-gated (`QuickEntry.tsx:599-601` "Full-tracker keeps its existing (un-gated) behaviour"; `AddLoanModal.tsx:98-116`; `linkedRequestBranch.ts:5-9` "No cross-currency gate"), so a Saudi/Qatari/Filipino user — explicitly targeted personas — recording a loan with a linked contact hits a raw 23514 check violation surfaced as a generic failure toast (`AddLoanModal.tsx:161`). The flagship cross-user loan feature is dead in the primary app mode for 6 of 8 supported currencies.
**Fix (S):** drop and re-add the constraints with the full supported list (or validate against a reference table), and align the client gates.

#### F-MIG3 · No FK from `emi_schedules.loan_id` or `transactions.related_loan_id` to loans — orphanable money references — **low, UNVERIFIED**

`emi_schedules.loan_id` is bare TEXT NOT NULL (`supabase-schema.sql:114`) and `transactions.related_loan_id` bare TEXT (`:68`); person and account references were retrofitted with FKs (`phase1-persons.sql:47-62`) but loan references never were. Loan deletion can strand EMI rows and repayment transactions — in the EMI subsystem that already has a documented desync history.
**Fix (S):** backfill-clean then add `loan_id → loans(id) ON DELETE CASCADE` (schedules) and `related_loan_id ... ON DELETE SET NULL` (transactions).

#### F-MIG4 · `join_code_attempts` grows forever; `phone_lookup_attempts` cleanup deletes globally on every call — **low, UNVERIFIED**

No TTL cleanup or pg_cron anywhere for `join_code_attempts`, and its `user_id` has no FK (`supabase-migration-prelaunch-hardening.sql:332-346`) so deleted users' rows persist — a minor data-retention inconsistency. `phone_lookup_attempts` is cleaned inline but the DELETE is unscoped (`connections-push-discovery.sql:341-342`) — every caller pays for a global sweep; a lock/bloat hotspot later.
**Fix (S):** FK ON DELETE CASCADE; scheduled or per-user-scoped cleanup.

---

## Recommendations table

| # | Recommendation | Findings | Severity | Effort |
|---|---|---|---|---|
| 1 | `markMirrorStale` on remote realtime events + re-set stores when background refresh resolves; add money tables to `refreshLiveData()` | F-RT1, F-RT2 | high | S |
| 2 | Drop `"Users can manage own settlements"` FOR ALL policy; per-command membership+authorship policies; author-membership + amount-change checks in the trigger | F-RLS1 | high | S |
| 3 | Rework `join_group_by_code` to return a status object so failure-attempt INSERTs commit | F-RLS2 | high | S |
| 4 | Gate phone discoverability behind OTP verification; protect `phone_e164` via the security-fields trigger | F-RLS3 | high | L |
| 5 | Keyset pagination in all collection fetchers; assert/surface truncation | F-FE1 | high | M |
| 6 | Adopt Supabase CLI migrations; consolidated schema dump; CI job applying migrations to throwaway Postgres + running verification SQL | F-MIG1, F-SC3, F-RLS10 | high | L |
| 7 | Relax the AED/PKR currency CHECKs to the full supported list; align client gates | F-MIG2 | high | S |
| 8 | Move notification/event fan-out server-side (templated trigger/RPC); restrict client notification INSERT to self; throttle | F-RLS6, F-RT6 | medium | M |
| 9 | Drop `persons_delete_own`; hide invite `token_hash` from member reads (hash server-side) | F-RLS4, F-RLS5 | medium | S–M |
| 10 | Throttle `lookup_profile_by_code` (reuse phone pattern); expiry/rotation + throttle for `get_committee_witness`; cap push tokens per user | F-RLS9, F-RLS8, F-RLS7 | medium | S–M |
| 11 | Ownership transfer (or orphan-with-members) instead of cascading owned groups on account deletion; purge receipts bucket in `delete_current_user` | F-RLS11, F-ST1 | medium | M |
| 12 | Subscribe status callback + backoff reconnect; debounce resume; in-flight guards on store loads; server-derived sync cursors | F-RT3, F-RT4, F-RT5, F-FE3 | medium | S–M |
| 13 | Single source of auth truth (session-derived uid); consistent getter error contract | F-AUTH2, F-FE2, F-AUTH1 | medium | M |
| 14 | Pre-launch realtime architecture review: or-filter subscriptions, broadcast for fan-out, publish group tables, latency telemetry | F-SC1, F-SC2 | medium | L |
| 15 | Hygiene batch: `handle_new_user` search_path, fail-closed deleted gate, env-var fail-fast, badge count query, loan FKs, attempts-table cleanup, push-notify URL encoding | F-AUTH3-5, F-RT8, F-MIG3, F-MIG4, F-EF1 | low | S |

---

## Refuted during verification

- **"`delete_current_user` relies on FK cascades that abort on the transactions→accounts ON DELETE RESTRICT constraint" (was high; verification split 1-1, downgraded on empirical evidence).** One refuter reproduced the exact FK topology and creation order on a throwaway PostgreSQL 16 instance: `DELETE FROM auth.users` succeeded and cascaded away 500 same-user transactions plus the account with no `foreign_key_violation` — cascaded RI check events are appended to the outer statement's shared after-trigger queue, so the RESTRICT check on account rows runs after the transactions cascade has removed the referencing rows; a control test confirmed the RESTRICT FK is otherwise enforced (a *different* user's transaction does abort the delete, a vector that cannot arise under this app's per-user RLS-scoped schema). The old `soft_delete` ordering comment (`supabase-migration-prelaunch-hardening.sql:221-222`) applied only to its separate sequential DELETE statements, where each statement's RI checks complete at its own end. The second refuter upheld the finding on theoretical grounds, so residual doubt exists for the live Supabase Postgres version (15/17 — unverifiable from the repo). Cheap belt-and-braces hygiene: add an explicit `DELETE FROM transactions WHERE user_id = v_uid` before `DELETE FROM auth.users` in `delete_current_user` (`supabase-migration-p0-launch-blockers.sql:102-134`) and verify account deletion end-to-end on a staging project with a transaction-bearing full_tracker user. (Citations were accurate; the claimed Postgres cascade-abort behavior was not reproduced.)

---

## Evidence-unavailable / further investigation

The following cannot be determined from the repository and should be checked directly in the Supabase dashboard / live database before launch:

1. **Actual production schema state** — which of the 40+ migration files were applied, and in what order. Project memory asserts at least `cross-user-account-effects`, `connections-push-discovery`, `settlement-emi-and-account-guards`, and `contacts-merge-unarchive` were PENDING as of late July 2026. Every "latest definition wins" conclusion above assumes chronological application. Run the function-catalog and policy queries from the `*-verification.sql` files, plus `select proname, prosrc from pg_proc` for the five-times-defined RPCs.
2. **PostgREST `max_rows`** — the pagination finding assumes the hosted default of 1000; the live value could be higher or lower.
3. **Live `supabase_realtime` publication contents** and whether `pg_net` is enabled (the push trigger silently no-ops if `net.http_post` is missing — `connections-push-discovery.sql:480-483` swallows the error).
4. **push-notify deployment state** — whether the edge function is deployed, `PUSH_SHARED_SECRET`/`FCM_SERVICE_ACCOUNT` secrets set, `app_push_config` populated, and `google-services.json` present in the shipped AAB (docs describe setup as pending).
5. **Receipts bucket** — existence and live storage-policy state (storage policies are frequently edited in Studio).
6. **Auth dashboard settings** — email-confirmation toggle, captcha, anon sign-in; these condition the multi-account amplification of the rate-limit findings and the signUp session-null analysis (F-AUTH1).
7. **Real-device behavior** — whether Android WebView storage eviction ever splits the Supabase session key from `hisaab_supabase_uid` in practice; realtime socket behavior under OEM battery managers.
8. **Production request volume / egress and table sizes** — needed to quantify the boot-burst (F-FE3), resume-storm (F-RT4), realtime-scaling (F-SC1) and cleanup (F-MIG4) findings.

---

*Report by the consolidating lead auditor, Supabase Usage phase, 2026-09-02. Findings marked UNVERIFIED were not adversarially refuted; all citations relied on above were spot-checked against the repository.*
