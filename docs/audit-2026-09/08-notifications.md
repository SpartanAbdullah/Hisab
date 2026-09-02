# Phase 8 — Notification System Review

**Audit date:** 2026-09-02
**Auditor role:** Product Manager + Notification Systems Specialist
**Scope:** every notification channel in the repo, end to end: triggers, delivery path, opt-in/out, i18n, deep links, failure handling; gap analysis vs. category leaders (Splitwise, Khatabook, bank-app alerting).

Severity scale (audit-wide): **critical** = money corruption / data loss / account takeover / cross-user leak / launch blocker · **high** = significant user harm, security weakness or scaling wall · **medium** = real but bounded · **low** = polish.

---

## 1. Channel inventory

Hisaab has **nine** distinct notification surfaces. No custom server exists, so everything is either client-derived, Postgres-trigger-driven, or a Capacitor OS bridge.

| # | Channel | Code | Status |
|---|---------|------|--------|
| 1 | In-app persisted notifications (`notifications` table) | `src/stores/notificationStore.ts`, `src/lib/supabaseDb.ts:1282-1334` | Live |
| 2 | Realtime delivery + resume refetch | `src/lib/realtime.ts:44-207` | Live |
| 3 | "Instant" Android tray notifications (backgrounded-but-alive app) | `src/lib/instantNotify.ts` | Live (native only) |
| 4 | FCM push (app killed) — tier 3 | `supabase/functions/push-notify/index.ts`, `src/lib/pushRegistration.ts`, trigger in `supabase-migration-connections-push-discovery.sql:450-488` | **Built but believed unconfigured** (see §6) |
| 5 | Scheduled local payment reminders | `src/lib/notificationPlanner.ts`, `src/lib/notificationScheduler.ts` | Live (native, opt-in) |
| 6 | Toasts | `src/components/Toast.tsx` (263 call sites of `toast.show` across `src/`) | Live |
| 7 | Bell badge + Inbox tabs + Activity "shared" tab + Splits unread dots | `src/components/InboxAction.tsx`, `src/pages/InboxPage.tsx`, `src/pages/ActivityPage.tsx:61-130`, `src/pages/SplitsPage.tsx:123-127` | Live |
| 8 | Derived in-app nudges (no rows): Inbox Info/To-do, settlement nudges | `src/lib/inboxInfo.ts`, `src/lib/settlementNudges.ts`, `src/components/SettlementNudgeBanner.tsx` | Live |
| 9 | WhatsApp reminder composer (reaches non-app users) | `src/lib/whatsappReminder.ts`, `src/lib/paymentReminders.ts`, `src/components/PaymentReminderModal.tsx` | Live |
| 10 | Email | Supabase auth only: signup confirmation + `resetPasswordForEmail` (`src/stores/supabaseAuthStore.ts:192`). No product email exists anywhere (no mailer/SMTP/resend in `src/` or `supabase/`) | Auth-only |

There is **no SMS channel** and **no web push** (see finding N-5).

### 1.1 Who writes `notifications` rows (event → notification matrix)

| Event | Writer | Where |
|---|---|---|
| Linked loan request created / accepted / rejected | **Server trigger** `tg_ltr_notify` (SECURITY DEFINER) | `supabase-migration-linked-notifications-realtime.sql:34-73` |
| Linked settlement created / accepted / rejected | **Server trigger** `tg_lsr_notify` | `supabase-migration-linked-notifications-realtime.sql:78-117` |
| Contact added you by code (mutual / pending ask) | **Server RPC** (`contact_linked`) | `supabase-migration-connections-push-discovery.sql:135-141, 172-178` |
| Contact accepted your ask ("added you back") | **Server RPC** `respond_contact_link` | `supabase-migration-connections-push-discovery.sql:280-286` |
| Group created / member joined / expense added / updated / deleted / settlement added / deleted | **Client-side fan-out** `fanOutGroupUpdate` from the actor's device | `src/stores/splitStore.ts:245-276`, call sites at lines 463, 510, 592, 696, 884, 958, 1009, 1081 |

Declared notification types `'invite'` and `'system'` (`src/db/types.ts:328`) are **never produced by any writer** — dead enum values that nonetheless get routing cases in `instantNotify.ts:58` and `pushRegistration.ts:34`.

### 1.2 The 3-tier delivery ladder (native Android)

Documented in `docs/push-notifications-setup.md:12-25` and confirmed in code:

1. **App visible** → realtime `postgres_changes` on `notifications` (`realtime.ts:52-58`) → `loadNotifications()` → bell badge/lists update. No tray notification by design (`instantNotify.ts:110`).
2. **App backgrounded, process alive** → same realtime event → `surfaceNewNotifications` fires a `LocalNotifications.schedule` with no `schedule` field so it delivers immediately (`instantNotify.ts:89-131`; called un-awaited from `notificationStore.ts:57`).
3. **App killed** → Postgres `AFTER INSERT` trigger `tg_notifications_push` → `pg_net.http_post` → Edge Function `push-notify` → FCM HTTP v1 → tray. Trigger is a silent no-op until `app_push_config` holds `edge_url` + `edge_secret` (`supabase-migration-connections-push-discovery.sql:450-488`).

Resume hardening is genuinely good: websocket health-check + unconditional refetch on every foreground/`online`/focus event (`realtime.ts:175-207`, `App.tsx:228-241`, `nativeBridge.ts:83-100`).

### 1.3 Scheduled reminder engine (native, opt-in)

Pure planner (`notificationPlanner.ts:78-263`) derives, from live store state: card bills (T-3/T-1/T-0, only while `owed > 0` and statement unpaid, lines 90-138), EMI instalments (T-1/T-0, unpaid + active loan, card-funded suppressed, lines 142-171), recurring charges (day-of, expenses only, lines 176-188), one-off upcoming bills (lead + day-of, lines 191-221), kameti rounds (day-of, skipped when fully collected, lines 227-244). Fire time fixed at 10:00 local (`REMIND_HOUR`, line 58); horizon 10 days; **caps: 3/day by priority, 24 total** (lines 60-61, 247-262). Stable FNV-1a ids make reschedules replace rather than duplicate (lines 65-72).

The bridge contract is cancel-everything-then-rebuild on every run (`notificationScheduler.ts:44-98`), serialized with latest-wins coalescing (lines 100-129), 30s debounce with `force` on every resolution path: transaction post (`transactionStore.ts:651`), recurring changes (`recurringStore.ts:87,114`), committee changes (`committeeStore.ts:165`), upcoming-expense changes (`upcomingExpenseStore.ts:40`), Settings toggle (`SettingsPage.tsx:683`), language change (`i18n.ts:3069-3071` — replans so reminder text follows the new language), boot (`App.tsx:325-327`) and resume (`nativeBridge.ts:94`). Opt-in via `REMINDERS_KEY`, default off (`notificationScheduler.ts:15-27`). This engine is the strongest part of the system — the "paid bill can never ring, by construction" invariant is real.

### 1.4 Opt-in/opt-out controls — the complete list

- **Android local reminders:** one Settings toggle, opt-in, owns the Android 13 permission prompt (`SettingsPage.tsx:645-699`, `notificationScheduler.ts:136-155`).
- **FCM push:** *no dedicated control.* Registration happens only (a) at boot if permission is already granted (`pushRegistration.ts:52-56` deliberately never prompts), or (b) piggybacked on the reminders toggle enabling (`SettingsPage.tsx:671-676`). The i18n strings for a push Settings section exist (`push_title`/`push_desc`, `i18n.ts:1973-1975`) but are referenced by **zero** components — a planned UI that was never built.
- **In-app notifications / group fan-out / bell:** no controls of any kind. No per-group mute, no category preferences, no quiet hours, no frequency settings.
- **Derived nudges:** settlement nudges snoozable 24h via localStorage (`settlementNudges.ts:13-15`).

---

## 2. Findings

### N-1 · HIGH — Every cross-user notification is hardcoded English in an Urdu-default product

The app's default language is Roman Urdu and local reminder bodies are properly bilingual via `tStatic` (`notificationPlanner.ts:118-119`, `i18n.ts:2937-2946`). But **all** server-generated and fan-out notification content is English-only, frozen at write time:

- Linked request/settlement triggers: `'New shared loan to review'`, `'Repayment to confirm'`, etc. (`supabase-migration-linked-notifications-realtime.sql:48-49, 60-63, 92-93, 104-107`).
- Contact-link RPCs: `'New connection on Hisaab'`, `'... you''re now connected, and you can share loans or settle up either way.'` (`supabase-migration-connections-push-discovery.sql:137-140, 174-177, 283-285`).
- Group fan-out: `` `Added to ${group.name}` ``, `` `${actorName} added an expense` ``, `` `${fromName} settled up` `` (`splitStore.ts:476-477, 715-716, 1097-1098`).

These are exactly the notifications that reach the *other* user — whose language preference the writer cannot know, because language lives in the writer's device `localStorage` (`i18n.ts:3062`), not in `profiles`. For the target Gulf-expat/family-back-home audience this is the highest-traffic Urdu surface in the product, and it ships in English. Fix requires storing a language on `profiles` and templating in the trigger (or storing a type+params payload and rendering client-side — the cleaner fix, and it also repairs push, which renders server-side text verbatim in `push-notify/index.ts:171-174`).

### N-2 · HIGH — Group notifications are client-authored, best-effort, and non-transactional

Linked requests get durable SECURITY DEFINER server triggers; group events do not. `fanOutGroupUpdate` runs on the **actor's device after** the money write commits, and swallows every failure with `console.error` (`splitStore.ts:245-276`). Consequences:

- Actor goes offline / app killed / tab closed between the expense insert and the fan-out → co-members get **no notification ever**, and no `group_events` row either (the Activity "shared" record is also client-written, `splitStore.ts:251-255`). There is no retry and no outbox for this path (the outbox scaffold is inert — `App.tsx:253-264`).
- Failures are invisible in production; the repo's own backlog admits it: "Wire them to `captureException` so 'fanOut: notifications insert failed' is visible in production, not just devtools" (`BACKLOG.md:274`).
- The asymmetry is untracked: a user who splits via a **linked contact** gets guaranteed server-side notification; the same expense via a **group** gets best-effort client fan-out.

Move group fan-out into an `AFTER INSERT` trigger on `group_expenses`/`group_settlements`/`group_members` (the pattern already exists for `linked_transaction_requests`), or at minimum report failures to Sentry.

### N-3 · HIGH — Any group co-member can forge arbitrary notifications (and, once push is live, arbitrary push) to fellow members

The INSERT policy allows a row for anyone who shares a group with you, with **no constraint on `type`, `title`, or `body`** and no rate limit:

```sql
CREATE POLICY "Users can insert notifications for self or fellow members"
  ON notifications FOR INSERT
  WITH CHECK (auth.uid() = user_id OR (group_id IS NOT NULL
    AND public.is_group_member(group_id, auth.uid())
    AND public.is_group_member(group_id, user_id)));
```
(`supabase-migration-notifications-rls.sql:35-44`)

Groups are joinable by shareable join code (`splitStore.ts` join flows), so co-membership is cheap to obtain. A malicious member can, via the anon-key REST API:

1. Insert `type='linked_settlement', title='Repayment confirmed', body='<victim name> confirmed the repayment of AED 5,000.'` — indistinguishable in the Inbox from a real trigger-written row, in an app whose records people treat as informal ledgers of who owes whom.
2. Insert `type='contact_linked'` rows to permanently light the victim's bell badge (Info-tab types drive the badge, `inboxInfo.ts:21-23`, `InboxAction.tsx:36-44`).
3. Flood inserts: every row fires `tg_notifications_push` → FCM HIGH-priority sound notification (`push-notify/index.ts:181-192`) with attacker-controlled text, once push is configured. No cap exists anywhere in the pipeline.

Fix: revoke direct INSERT for non-self rows entirely and move group fan-out server-side (same fix as N-2 — these two findings share one root cause: fan-out was made client-writable by policy instead of trigger-written). Failing that, constrain `type='group_update'` in the policy and add a per-writer rate limit.

### N-4 · HIGH — Tier 3 (app killed) is believed dead in production; the promise strings for it are dead code

The FCM path requires: the connections-push-discovery migration applied, a Firebase project, `google-services.json` in the Android build, the Edge Function deployed, and two `app_push_config` rows (`docs/push-notifications-setup.md:1-45`). Project memory records the migration **and** Firebase setup as pending user action as of 2026-07-26. Repo evidence is consistent with never-configured: `push_title`/`push_desc` ("Get told the moment someone sends you a loan … **even when the app is closed**", `i18n.ts:1973-1975`) are referenced by zero components, and no `google-services.json` ships in the repo (correctly gitignored, but nothing indicates a build has one). Until configured, a user whose phone rebooted or whose app Android killed gets **nothing** until next open — for a loan-request product, the highest-value notification moment. Every layer degrades silently by design (`tg_notifications_push` no-ops, `pushRegistration.ts:68-72` swallows registration errors, `push-notify/index.ts:148-153` returns 200 `not_configured`), so nobody will notice it is off. Actual Studio/Firebase state: see Evidence-unavailable.

### N-5 · HIGH — The web/PWA surface has no notification channel at all beyond an open tab

There is no web push: no VAPID keys, no `pushManager` subscription, and the service worker has no `push` handler (`grep` of `src/lib/serviceWorker.ts` and `public/` returns nothing). `instantNotify` returns early off-native (`instantNotify.ts:109`), the scheduler no-ops on web (`notificationScheduler.ts:114`), and FCM registration is native-only (`pushRegistration.ts:42`). A PWA user on usehisaab.com — the product's *primary distribution while the Play listing is unfinished* — learns about a loan request only if the tab is open (realtime) or on next visit. Splitwise, Khatabook, and every bank PWA at minimum send email for actionable cross-user events; Hisaab sends nothing (email is auth-only, §1 row 10). Web push on Android Chrome is well-supported and would reuse the existing trigger → Edge Function pipeline.

### N-6 · MEDIUM — Push opt-in is welded to an unrelated toggle named "Payment reminders"

The only code path that ever *prompts* for notification permission and registers FCM is inside the reminders toggle handler (`SettingsPage.tsx:671-676`); boot-time registration silently bails if permission wasn't already granted (`pushRegistration.ts:52-56` — a deliberate and defensible anti-reflex-deny choice). Net effect: a user who doesn't want daily bill reminders — or who simply never finds the toggle — can never receive cross-user push, and nothing in onboarding or the Inbox ever asks. The intended dedicated push section exists only as unused strings (`i18n.ts:1973-1975`). Best practice (Splitwise, WhatsApp) is a contextual prompt at the first high-intent moment: right after sending your first linked request or joining your first group ("Want to know when Ali confirms?").

### N-7 · MEDIUM — The bell badge counts the user's *own outgoing* pending requests and animates until someone else acts

`InboxAction` counts pending requests where the user is sender **or** receiver (`InboxAction.tsx:18-33`: `r.toUserId === userId || r.fromUserId === userId`), then pulses a halo and rings the bell icon whenever the count is nonzero (`InboxAction.tsx:62-71`). A user who sends one loan request to a slow-to-respond cousin sees a red animated badge for days with nothing to act on — the exact "counter stays at 1" anxiety the codebase fought elsewhere (`notificationStore.ts:23-27`, `InboxPage.tsx:184-188`). Outgoing-pending belongs in the Outgoing tab count (`InboxPage.tsx:167-172` already computes it separately), not the attention badge.

### N-8 · MEDIUM — Tray/push deep links are shallow: everything lands on `/inbox` or `/groups`

- FCM payload carries only `type` and `notification_id` (`push-notify/index.ts:177-180`); the tap handler routes `group_update|invite → /groups`, else `/inbox` (`pushRegistration.ts:31-39`).
- Instant tray notifications do the same (`instantNotify.ts:50-63`) even though the row has a `group_id` that could route to `/group/:id` (where `markGroupRead` already fires on open, `GroupDetailPage.tsx:261`).
- Contrast: scheduled reminders deep-link correctly to `/account/:id`, `/loan/:id`, `/kameti/:id` (`notificationPlanner.ts:134, 167, 240`) via `extra.href` and the tap listener (`nativeBridge.ts:102-108`).

A "Ali added an expense in Flat 12" push that opens the top of the Groups list makes the user hunt. Include `group_id` in the trigger payload and route to the entity.

### N-9 · MEDIUM — Instant-notify burst rule drops *everything* over the cap, showing nothing

`MAX_PER_BATCH = 3`; when a reconnect delivers 4+ fresh unread rows the function returns before scheduling anything (`instantNotify.ts:43, 111`). The comment says bursts are "almost certainly replaying history", but the age/seen filters (24h cutoff, seen-set, unread-only, lines 95-107) have already removed history — four genuinely new events (e.g. a group member posting four expenses of a trip) yield zero tray signal. Leaders collapse instead of dropping: show one summary notification ("4 updates in Hisaab").

### N-10 · MEDIUM — No quiet hours, no sound control, no batching on the push path

Every `notifications` insert immediately becomes a HIGH-priority, `default_sound: true` FCM message (`push-notify/index.ts:182-192`) at whatever hour the actor acted — a Gulf-based user adding expenses at 23:00 UAE rings phones in Pakistan at midnight. There is no server-side coalescing either: adding 10 expenses to a group fires 10 pushes per member (one trigger per row insert, `supabase-migration-connections-push-discovery.sql:486-488`). Local reminders, by contrast, encode good anti-fatigue design (10:00 fire hour, 3/day, priority ladder, `notificationPlanner.ts:57-61`). Bank apps and Splitwise both collapse rapid same-thread events and respect OS notification channels (Android channels would also let users demote group noise vs. money requests — currently all pushes are one undifferentiated channel).

### N-11 · MEDIUM — Important events that generate no notification at all

| Event | Current signal | Gap |
|---|---|---|
| **Kameti draw completed / round due / payout** for members | None cross-user — committees have no linked-member notifications anywhere (`committeeStore.ts` has zero notification writes; only the owner's local day-of reminder, `notificationPlanner.ts:227-244`) | The provably-fair ballot (`committeeDraw.ts`) is a headline feature whose result reaches members only via a manually shared witness link/slip. At minimum: notify linked members on draw + their payout round. |
| **Budget breached** | Derived Inbox Info card only, visible when the user opens the Inbox (`inboxInfo.ts:140-152`) | No push/local reminder even when reminders are on. Monarch/banks alert at 80%/100%. The planner already has budgets adjacent; a `budget:{id}:80` plan entry is cheap. |
| **Goal milestone reached** | Nothing (`goalStore.ts` writes activity rows only) | Low-cost delight moment, standard in category. |
| **Recurring charge auto-posted / due but unconfirmed for N days** | Day-of local reminder + in-app prompt (`notificationPlanner.ts:176-188`, `RecurringDuePrompt`) | Adequate day-of; nothing escalates if the prompt is ignored — it just sits in To-do. |
| **Group member left / removed you** | `member_joined` is fanned out (`splitStore.ts:510, 592`) but no `member_left` fan-out call exists | Members discover silently. |
| **Loan overdue (counterparty side)** | WhatsApp composer is manual; local reminders are only for *your* payables | No automated "your udhaar to Ahmed passed its promised date" nudge — Khatabook's core retention loop. Deliberate per planner comment ("overdue nagging lives in the in-app To-do queue", `notificationPlanner.ts:12-13`) but that queue is only seen on app open. |

Settlement accepted **is** covered (`tg_lsr_notify` UPDATE branch), as are linked-request outcomes — the Phase-1 question list checks out otherwise.

### N-12 · MEDIUM — In-app channel has no lifecycle: unbounded table, top-100 read window

No TTL, pruning, or archival exists for `notifications` in any migration; the client reads the newest 100 (`supabaseDb.ts:1283-1291`). Heavy group users will silently lose older unread items from every surface (badge counts derive from the loaded slice, `notificationStore.ts:50-53`) while the table grows forever behind an `AFTER INSERT` trigger that fires pg_net calls per row. Bounded today, a scaling wall later.

### N-13 · LOW — Raw error strings still surface in toasts

104 error-type toasts exist; 51 sites pass `err.message` straight into the toast subtitle (counts via grep; e.g. `InboxPage.tsx:243-247`). `authErrorMap.ts` and `linkedErrorMap.ts:16-21` map known cases and deliberately pass unknowns through — so Postgres/PostgREST errors still reach users verbatim on unmapped paths. This is UX-audit blocker B8 surviving in attenuated form.

### N-14 · LOW — Minor mechanics

- Realtime `notifications` events trigger an un-debounced full reload each (`realtime.ts:52-58`) while money tables get 500ms coalescing (`realtime.ts:22-33`); a fan-out to you of N rows = N fetches of 100 rows. Bounded but wasteful.
- Fan-out bakes actor/member display names into `title`/`body` at write time (`splitStore.ts:715, 1097`); renames never propagate. Cosmetic.
- `hrefFor`/`hrefForType` carry cases for the never-written `'invite'`/`'system'` types (§1.1) — dead code that will mislead a future maintainer into thinking invites notify.
- Toast auto-dismiss is 3s/6s-with-action (`Toast.tsx:62`) — good Undo affordance pattern (`InboxPage.tsx:232-241`), consistently used.

---

## 3. What is genuinely good (credit where due)

- **The reminder planner is best-in-class for this codebase's size:** derive-from-state (paid things cannot ring), escalation ladder, per-day and total caps, stable ids, force-reschedule wired into every resolution path including language change (`notificationPlanner.ts`, `notificationScheduler.ts`, §1.3). Tested (`notificationPlanner.test.ts`).
- **Anti-noise discipline in instantNotify:** prime-silently-on-boot, seen-set, unread-only, 24h cutoff, suppress-when-visible (`instantNotify.ts:11-19, 95-111`).
- **Race-hardened read state:** `locallyRead` set prevents the resurrect-unread bug (`notificationStore.ts:23-34`); Info badge only counts clearable items (`InboxPage.tsx:184-188`).
- **Push pipeline hygiene:** token cache, dead-token GC on FCM 404/INVALID_ARGUMENT (`push-notify/index.ts:117-125, 211-214`), sign-out token cleanup (`pushRegistration.ts:99-109`), collapse `tag` dedupe (`push-notify/index.ts:190`), fire-and-forget trigger that can never roll back the write (`supabase-migration-connections-push-discovery.sql:463-483`).
- **WhatsApp composer** correctly targets the region's real channel and non-app users, with tone templates fully bilingual (`whatsappReminder.ts:3-8`, `i18n.ts:508-511`) and no invented country codes (`whatsappReminder.ts:14-27`).

---

## 4. Comparison with category leaders

| Capability | Splitwise | Khatabook | Bank apps | Hisaab |
|---|---|---|---|---|
| Push on cross-user money event | Yes, reliable | Yes | Yes (instant txn alerts) | Built, believed unconfigured (N-4); tiers 1-2 only |
| Per-group / per-thread mute | Yes | n/a | Per-category alert prefs | **None** |
| Email digests / fallback | Yes (default on) | No | Yes (statements/alerts) | **None** (auth email only) |
| Reminders to non-app users | Weak | **Core loop** (free SMS/WhatsApp) | n/a | Strong: WhatsApp composer + PDF statements — competitive with Khatabook, but manual-only (no auto-nudge, N-11) |
| Due-date payment reminders | Basic | Yes | Yes | **Strong** (planner engine, opt-in) |
| Batching / summary notifications | Collapses activity | n/a | Per-txn but channel-tiered | **None**; over-cap bursts drop silently (N-9, N-10) |
| Quiet hours / channels | OS channels | OS channels | Configurable | **None** (N-10) |
| Localized notification content | Yes | Yes (vernacular-first) | Yes | **English-only cross-user content in an Urdu-first app** (N-1) |
| Notification preference center | Yes | Yes | Yes | One toggle, mislabeled scope (N-6) |

Hisaab beats Khatabook on reminder *engineering* and matches it on WhatsApp reach, but ships below every leader on delivery reliability (tier 3 off, no web push, client-side fan-out), localization, and user control.

---

## 5. Recommendations (priority order)

1. **P0 — Move group fan-out server-side and lock the INSERT policy** to `auth.uid() = user_id` only. One change fixes N-2 (reliability) and N-3 (forgery/spam) together; the trigger pattern already exists in `supabase-migration-linked-notifications-realtime.sql`.
2. **P0 — Finish tier 3 before launch:** apply the pending migration, stand up Firebase, deploy `push-notify`, and add a monitoring probe (a weekly self-push or a check on `app_push_config`) so silent-degradation can't hide an outage. A loan-request app whose requests don't notify when the app is killed will read as broken.
3. **P0 — Localize cross-user notification content:** store a `lang` on `profiles`; either template in triggers or (better) write `type + params` and render on-device via the existing i18n table. Also unblocks correct push text.
4. **P1 — Decouple push opt-in from reminders:** build the Settings section the `push_title/push_desc` strings were written for, and add a contextual permission ask after the user's first linked request / group join.
5. **P1 — Web push (VAPID) for the PWA**, reusing the trigger → Edge Function path; until then, a minimal transactional email on `linked_request`/`linked_settlement` inserts closes the worst web gap.
6. **P1 — Fix the bell badge:** drop `fromUserId` matches from the attention count (`InboxAction.tsx:22-31`); keep outgoing pending in the Outgoing tab only.
7. **P2 — Deep-link pushes to entities** (include `group_id` in the trigger payload; route `group_update` to `/group/:id`).
8. **P2 — Anti-fatigue on push:** collapse-key per group thread, Android notification channels (money-requests vs. group-activity), a quiet-hours window server-side (delay non-urgent pushes to 08:00 recipient-local), and a summary notification instead of the silent >3 drop in `instantNotify.ts:111`.
9. **P2 — Close the event gaps** (N-11): kameti draw/payout notifications for linked members, budget-80%/100% plan entries, `member_left` fan-out, optional automated overdue-udhaar nudge (opt-in per loan — this is Khatabook's retention engine and Hisaab already has the WhatsApp composer to piggyback on).
10. **P3 — Lifecycle:** 90-day notification pruning job; debounce the realtime notifications reload; delete the dead `'invite'`/`'system'` routing cases or start using the types; wire fan-out failures to Sentry (`BACKLOG.md:274`).

---

## 6. Evidence-unavailable / further investigation

- **Supabase Studio state:** whether `supabase-migration-connections-push-discovery.sql`, `supabase-migration-linked-notifications-realtime.sql`, and `supabase-migration-notifications-rls.sql` are actually applied in production cannot be read from the repo (migrations are manual by design). Project memory (2026-07-26) records connections/push migration + Firebase as pending; if the *linked-notifications* migration is also unapplied, linked-request recipients currently get **no notification at all** — worth verifying first.
- **Firebase/FCM configuration:** existence of a Firebase project, `google-services.json` in the shipped AAB, Edge Function deployment, and `app_push_config` rows are all outside the repo.
- **`app_push_config` contents and pg_net availability** in the live database.
- **Real-device behavior:** Android OEM battery-killer effects on tier 2 (the realtime socket surviving backgrounding varies wildly by OEM — Xiaomi/Oppo/Vivo, dominant in Pakistan, kill aggressively, which raises the stakes on N-4), exact tray dedupe behavior of `tag` collapse, and whether `LocalNotifications` survive reboot (Capacitor does not reschedule after reboot without a boot receiver — **not visible in `android/` from this phase's file set; recommend Phase-9/device QA verify a reboot clears all pending reminders until next app open**).
- **Supabase auth email deliverability/templates** (dashboard-configured, not in repo).
- **Production telemetry** on notification volume, open rates, or push failures — none exists (no analytics anywhere, per Phase 1), so every fatigue judgment above is structural, not measured.
