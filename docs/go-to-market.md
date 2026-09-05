# Hisaab — Go-to-Market Plan

**Date:** 2026-09-02 · **For:** the founder · **Sources:** `docs/audit-2026-09/11-competitive-analysis.md`, `00-executive-summary.md` §4/§6.4 L6, `docs/play-store-listing.md`, `docs/audit-2026-09/P0-REMEDIATION.md`, `docs/audit-2026-09/APPLY-ORDER.md`, `src/lib/telemetryEvents.ts`, `src/lib/telemetry.ts`.

**How to read this doc:** every claim below is tagged against actual repo state, not aspiration. Where a feature exists only on the unmerged `audit-p0-remediation` branch (per `P0-REMEDIATION.md` — "currently **uncommitted working-tree changes**, not merged into `main`, not pushed") it is marked **PENDING**, not shipped. Marketing must not get ahead of `main` + production Supabase state.

---

## 0. The one precondition this whole plan sits on

None of §§1–3 should reach a public audience — closed test included — before the P0 criticals in `00-executive-summary.md` §6.1 are actually live: merged to `main`, deployed (web auto-deploys on push; Android needs a rebuilt+signed AAB per `docs/updating-the-android-app.md`), **and** the matching SQL applied to production Supabase in the order in `APPLY-ORDER.md` §2. As of today none of that has happened — the founder has not yet run `supabase-audit-p0-verification.sql` against production (`P0-REMEDIATION.md` §4), so C1–C11 are code-complete on a branch, not shipped. Treat "closed test" (§3 below) as the first audience allowed to see any of this, and only after that release step.

---

## 1. Positioning

### 1.1 Lead with kameti, not udhaar

The competitive research is explicit: **"udhaar" is Udhaar Book's owned keyword** (1.4M+ businesses, claimed #1 — `11-competitive-analysis.md` G10, §1), while **tracker-only kameti with a provably-fair draw + public witness link is unoccupied ground** — Oraan is custodial (KYC, fees, regulatory weight) and the ROSCA-tracker tail (Golak, Kameti.pk) is unfunded and has "no fairness proofs, no witness/verification mechanism" (§1, §4.2). Opportunity O5 says this directly: *"Lead ASO/marketing with kameti + witness link, not 'udhaar'."* Khata stays as a secondary/supporting term (it is generic South Asian vocabulary, not a single competitor's brand), but "udhaar" as a headline word buys a fight Hisaab cannot win on SEO.

**Post-committee-fraud climate works in Hisaab's favor here** — the profile notes DAWN's committee-fraud reporting means the deepest user anxiety is trust, and "never holds money + provable draw" answers it (§4.2). The one caveat carried from the research: a custodial guarantee (Oraan's model) answers that anxiety *more* directly than a witness link — so this wedge is family/known-circle kametis, not stranger circles marketed as "safe with strangers."

### 1.2 ASO variants

All counts are literal character counts of the string shown, verified by hand.

| Slot | Variant | Chars | Notes |
|---|---|---:|---|
| **Title (EN, ≤30)** | `Hisaab: Kameti & Khata Tracker` | 30 | Keeps "khata" as the #2 category word; drops nothing users already searched for. |
| **Title (EN, ≤30)** | `Hisaab: Kameti Draw Tracker` | 27 | Foregrounds the draw mechanic itself. A/B against the above once closed-test ASO data exists (§3). |
| **Title (Roman Urdu, ≤30)** | `Hisaab: Kameti aur Khata` | 24 | Roman-Urdu-market secondary listing locale. |
| **Short desc (EN, ≤80)** | `Kameti with a provably-fair draw, plus khata & expense tracking — AED, PKR` | 74 | Replaces the current `Khata, udhaar, kameti & expense tracker...` line — moves kameti+draw to the front, drops "udhaar" from the headline entirely (it stays in the body copy and keyword list, §1.3, where it still helps discovery without being the *lead*). |
| **Short desc (Roman Urdu, ≤80)** | `Provably-fair kameti draw, khata aur kharch tracker — AED, PKR, no ads` | 71 | |
| **First line, full description (EN)** | `Hisaab runs your kameti with a provably-fair draw and a witness link every member can check — plus khata, splits and budgets, all AED + PKR.` | — | Replaces `Your money, always in sight.` as the opening hook; that line can move to the second paragraph. |
| **First line, full description (Roman Urdu)** | `Hisaab aap ki kameti ek provably-fair draw se chalata hai, aur witness link se har member khud check kar sakta hai — khata, split aur budget bhi, AED + PKR mein.` | — | |

**⚠ Do not ship the "provably-fair" claim as "cannot be re-rolled" yet.** As of `main` today the organiser *can* re-roll the draw until it suits them (`05-security.md` M10, carried into `00-executive-summary.md` §2 finding #8's "just below the cut" note). The binding, single-phase server-side draw (`DRAW_FIELDS_ARE_SERVER_ONLY`, `ALREADY_DRAWN`) only exists on the unmerged `supabase-migration-audit-p0-kameti-draw.sql` + client pair — see §1.4 row 4. Until that ships to production, "provably-fair" copy should describe what's true today: a shareable **witness link** members can use to verify the draw result (`CommitteeVerifyDraw.tsx`, live on `main`) — not yet an unforgeable draw.

### 1.3 Keyword list

`kameti` · `committee tracker` · `BC committee` · `ROSCA` · `provably fair draw` · `parchi draw` · `witness link` · `baari` · `khata` · `udhaar` (body copy only, not headline — §1.1) · `hisab kitab` · `split bill` · `qist` · `expense tracker` · `budget app` · `AED PKR` · `Pakistan UAE` · `Roman Urdu` · `no ads finance` · `savings committee` · `settle up`

### 1.4 Claims — true today vs. still pending

| # | Claim | Status on `main` today (2026-09-02) | Condition to go live |
|---|---|---|---|
| 1 | Every active ISO 4217 currency (`src/lib/currencies.ts`; `supabase-migration-p3-currencies-iso4217.sql` applied 2026-09-04), with AED and PKR first as the audience positioning | **TRUE** — the listing copy was widened from the earlier 8-currency line on 2026-09-05 | None — keep "AED + PKR" as positioning, never as the limit. |
| 2 | PIN lock ("your hisaab, your eyes only") | **FALSE / not claimed** — correctly removed from the listing. Code exists (`PBKDF2` 150k-salted, gates cold start + 60s background + re-auth) but only on the unmerged branch | Merge → deploy web+Android → **device-verify** the lock actually gates (no device farm has run this — `00-executive-summary.md` §7.C). Only then restore the claim. |
| 3 | "Offline-first — syncs when you're back online" | **FALSE / not claimed** — correctly removed. There is no offline write path: the inert outbox scaffold was deleted on 2026-09-04 (D5, Option A — `docs/offline-story.md`); Hisaab is online-required for writes | Do not reintroduce unless Option B (a narrow single-row replay queue, a telemetry-gated backlog item — not a commitment) is actually built, integration-tested and device-verified. This is not a near-term claim. |
| 4 | "Provably-fair" kameti draw (organiser cannot re-roll) | **PARTIALLY true.** Witness link exists and is live. The draw itself is still re-rollable by the organiser on `main` | Requires `supabase-migration-audit-p0-kameti-draw.sql` applied to production **and** its matching client merged+deployed (currently on the unmerged branch — breaking change, must ship together per `APPLY-ORDER.md` step 4). |
| 5 | Two-sided, consent-based udhaar (accept/reject in Inbox) | **TRUE on `main`** — `InboxPage.tsx`, `linked_transaction_requests` | The underlying `supabase-migration-cross-user-account-effects.sql` is flagged **"possibly unapplied"** in production (`APPLY-ORDER.md` §1, row 39) — confirm via `supabase-audit-p0-verification.sql` Section 13 before leaning on this in paid acquisition. |
| 6 | "Roman Urdu" / "Urdu-first" | **Overstated.** `ur` has the deepest string coverage and is the intended default, but the shipped code default is **English** (`i18n.ts:3062`, `\|\| "en"` — `00-executive-summary.md` premise correction, roadmap H5). Cross-user notification content ships English-only regardless of the recipient's language setting (`08-notifications.md` N-1). | Market as "English + Roman-Urdu," not "Urdu-first," until H5 (default-language fix + notification localization) ships. This is a copy change founders can make today — say "bilingual," not "Urdu-first." |
| 7 | Free, no ads, no daily cap | **TRUE** — no entitlement, paywall, or ad code exists anywhere in `src/` (confirmed absence, not just "not found") | None — but see §5 on not promising *future* monetization dates. |
| 8 | Kameti tracker-only, never holds money | **TRUE** — no payment/custody code exists; this is structurally true by omission, not a policy toggle | None. |
| 9 | Guest members — split with people who don't have the app yet | **Client-complete, migration PENDING.** `src/lib/groupGuests.ts`, `CreateGroupModal.tsx`, `GroupInviteModal.tsx` all shipped on the unmerged branch; the two RPCs it calls (`add_group_guest`/`remove_group_guest`) fail closed on an un-migrated DB, so it degrades safely rather than corrupting data | `supabase-migration-p2-guest-members.sql` applied to production. Docker-validated: `supabase/tests/tests/8y-guest-members.sql` (31 assertions; full corpus 331, 0 failed). |
| 10 | Block or report, right from the app | **Client-complete, migration PENDING.** `BlockReportSheet.tsx` + `blockStore.ts`, mounted in `GroupDetailPage.tsx`, `ContactDetailSheet.tsx`, `InboxPage.tsx` — not just a component nobody calls | `supabase-migration-p2-trust-safety.sql` applied to production. `docs/trust-and-safety.md` §7, 62 functional-smoke assertions, Docker-validated. This is also the P2 client work §5 of this doc's Risks table said was "not yet started" — it now exists, still gated on the same migration. |
| 11 | Khata link — a live, read-only balance page shared over WhatsApp, no app required to view | **Client-complete, migration PENDING.** `ShareKhataLinkSheet.tsx`, `KhataLinkPage.tsx`, `khataLinkStore.ts`, route wired in `App.tsx` | `supabase-migration-p3-khata-link.sql` applied to production. Verified via the migration's own in-file V-checks (header). |
| 12 | Edit history — "see who changed what" | **TRUE for loans only; migration PENDING.** `EditHistorySheet.tsx` is mounted on `LoanDetailPage.tsx` only — `docs/edit-history.md` §6 lists `GroupDetailPage`/`EditGroupExpenseModal`/settlement/transaction surfaces as named but unbuilt insertion points. Do not market this as covering groups yet | `supabase-migration-p2-edit-history.sql` applied to production. `supabase/tests/tests/8z-edit-history.sql` (26 assertions; corpus 357, 0 failed), `src/lib/editHistory.test.ts` (21 cases). |
| 13 | Receipt photos | **Overstated in the old listing copy — now corrected.** `ReceiptField.tsx` requires an existing `transactionId` and is mounted only in `EditTransactionModal.tsx`; there is no receipt control on QuickEntry/create. "Log an expense with a receipt photo" was never literally true — "attach a receipt right after saving" is | Bucket size/MIME cap (5 MiB) is enforced by `supabase-migration-p2-trust-safety.sql` §8.1 — uploads work without it but are unbounded until applied. `src/lib/receiptStorage.test.ts`. |
| 14 | Account deletion — "delete anytime" | **Overstated in the old listing copy — now qualified.** `delete_current_user()` REFUSES with `OWNED_GROUPS_WITH_MEMBERS` while the caller owns a shared group with other participants; the resolution path is "Assign another admin" (`transfer_group_ownership`). Since D1 (2026-09-04) it also REFUSES with `UNSETTLED_GROUP_BALANCES` while the caller has an open balance in a shared group — same rule as leaving a group. Listing copy now says "hand over any group you run and settle what you owe first" | `supabase-migration-audit-p0-account-deletion.sql` applied to production; `supabase-migration-p3-account-deletion-balance-gate.sql` pending apply. Docker-validated (throwaway Postgres 15) per migration header. |

Full detail and per-claim verification evidence for rows 9–14: `docs/play-store-listing.md` §"Claims ledger — 2026-09-02" — that table is the source of truth kept in sync with this one.

---

## 2. Splitwise-refugee campaign

### 2.1 The churn trigger

Splitwise's free tier is throttled to **~3 expenses/day with unskippable interstitial ads** — the competitive research calls this "the single biggest driver of user churn and of the current wave of 'Splitwise alternative' apps" (`11-competitive-analysis.md` §1, Cluster A). Reminders are email-only (no push), and any member can delete a shared expense for everyone. Tricount is already actively harvesting this churn with a migration importer (bunq-funded, free-forever). Hisaab's free tier — no cap, no ads, ever (§1.4 row 7) — already beats Splitwise's free tier on every axis; the gap is that nobody outside this repo knows it yet.

### 2.2 Content angles

| Angle | Message | Why it lands |
|---|---|---|
| Free forever | "No 3-expense daily cap. No ads between you and your friends' bill." | Directly names the pain point the research documents as the #1 complaint driver. |
| No bank passwords | "Hisaab never asks for your bank login. Nothing to sync, nothing to leak." | Turns Monarch's/Wallet's #1 complaint stream (sync failures, ~2.2/5 Trustpilot) into a structural Hisaab strength (`11-competitive-analysis.md` §4.6). |
| Roman Urdu, not just English | "Baari, qist, udhaar — the words you actually use, not a translated app." | Splitwise/Settle Up/Splid have zero Urdu; this is real differentiation for a South Asian Splitwise refugee, subject to the honesty caveat in §1.4 row 6. |
| Two-sided ledger vs. one-sided delete | "Any Splitwise member can delete a shared expense for everyone. Hisaab's ledger is consent-based on both sides." | Direct comparison hook (`11-competitive-analysis.md` §1, Splitwise weaknesses). |

### 2.3 Comparison landing page — outline

1. **Hero:** "Tired of Splitwise's daily cap and ads? Track free, forever." + CTA.
2. **Side-by-side table:** free-tier expense cap, ads, currencies (Splitwise 100+ vs Hisaab's 8 Gulf/PKR/PHP — be honest, don't hide this), reminders (email-only vs WhatsApp deep link), roman Urdu, kameti/ROSCA (Splitwise: none), consent model.
3. **"What happens to your Splitwise groups"** — sets expectation for the importer (§2.4) or, until it ships, a short "recreate your group in 2 minutes" walkthrough using ad-hoc splits (`SplitWithSheet`, no group required — commit `331a702`).
4. **Trust block:** "Hisaab is not a lender. We never hold, move, or lend your money." (existing listing copy, §1.4 row 8).
5. **FAQ:** currency limits (be upfront: no USD/EUR/GBP — §1.4 row 1), whether friends need the app (today: yes, for groups — see the honesty note in §2.4), PIN/security status per §1.4 row 2.
6. CTA: install (Android) or open the PWA.

### 2.4 The importer — the strong play, with an honest scope estimate

Tricount's 11.0 importer is the precedent: a dedicated Splitwise-migration path to harvest refugees mid-churn (`11-competitive-analysis.md` §1, O6). Splitwise supports a per-group CSV export today, which is the natural input.

**Scope, staged:**
- **v0 (S, ~2-3 days):** CSV parser mapping Splitwise's export columns (date, description, category, cost, currency, paid-by, per-person owed) into Hisaab's ad-hoc split model (`SplitWithSheet`) — one group at a time, imported as a batch of ad-hoc splits rather than a persistent Group object. Ships fast because ad-hoc splits already handle non-app people (§2.3 point 3).
- **v1 (M, gated on Opportunity O4):** Full Group import (persistent `split_groups` row, members, running balances). **This is currently blocked**, not just harder: `CreateGroupModal.tsx:38-76` requires every group member to already be a resolved Hisaab account (`11-competitive-analysis.md` G6) — an imported Splitwise group typically has members who have never heard of Hisaab. Splitwise's own answer to this (placeholder/claimable friends) is exactly Opportunity O4 ("Guest members in groups"), still open on the roadmap (`00-executive-summary.md` §6.2 wording, effort M, impact High). **Sequence the full-group importer after O4, not before** — building it against the current member model would ship an importer that fails on the exact refugee groups it's meant to capture.

Recommendation: ship v0 alongside the comparison landing page (§2.3) for immediate campaign use; schedule v1 once O4 lands.

---

## 3. Launch sequencing

### 3.1 What gates each phase

The analytics/telemetry layer needed to measure this is **already built** (contrary to the general "zero analytics" audit finding, which predates this work) — `src/lib/telemetryEvents.ts` defines a closed, PII-safe event catalog (amounts/names/phone numbers are structurally unrepresentable — only buckets and enums), and `src/lib/telemetry.ts` wraps `posthog-js` (EU host) behind three independent gates: a build-time `VITE_POSTHOG_KEY`, opt-in device consent (default OFF), and per-event schema validation. **Before any closed test, set `VITE_POSTHOG_KEY` in the Vercel/Android build config** — without it the module is a total no-op and every funnel below reports nothing.

| Phase | Audience | Entry gate | Funnel tracked (event names, in order) | Expansion gate |
|---|---|---|---|---|
| **0 — Dogfood** | Founder + a handful of trusted testers | P0 criticals (C1–C11) merged, deployed, SQL applied to prod; `VITE_POSTHOG_KEY` set | `app_opened` → `error_surfaced` (watch for `feature: money_mutation` spikes — this is the money-corruption canary) | Zero money-mutation errors over a 1-week soak; PIN device-verified per §1.4 row 2 |
| **1 — Closed test** (Play Console closed track, ~20–50 testers — ideally real kameti organisers, §3.2) | **Activation funnel:** `app_opened` → `signup_started` → `auth_completed{is_new_user}` → `onboarding_step_viewed{step}`×N → `onboarding_mode_selected` → `onboarding_completed` → `account_created` → `quick_entry_opened` → `entry_created{is_first_ever:true}` | Activation completion (`auth_completed` → `entry_created` first-ever) ≥ 60%; no `quick_entry_abandoned` clustering at one `last_step`; crash-free sessions | Move to Phase 2 |
| **2 — Soft launch** (WhatsApp/community channels, §3.2 — not yet public ASO) | **Invite-loop funnel:** `group_create_started` → `group_created` → `group_invite_shared{channel}` → `group_invite_opened{is_authed}` → `group_join_started` → `group_joined{via}` → `group_expense_added`. **Kameti funnel:** `kameti_created` → `kameti_ballot_drawn` → `kameti_witness_viewed` (anonymous — witnesses are never `identify()`'d, per the schema's own comment) | `group_invite_opened` → `group_joined` ≥ 25%; at least one full kameti-funnel completion per organiser cohort within 7 days of `kameti_created`; `settle_up_completed` occurring (proves the loop closes, not just opens) | Move to Phase 3 |
| **3 — Public ASO launch + Splitwise campaign** (§2) | Both funnels above sustained at scale, plus `feedback_opened` volume manageable and `error_surfaced` rate flat as installs grow | Ongoing — this is steady-state operation, not a one-time gate | — |

Every phase transition should be a founder decision made by reading the PostHog dashboard, not a date on a calendar — this is the whole point of shipping the funnels before spending on acquisition (roadmap H2/O11).

### 3.2 Community channels + outreach scripts

Target channels, ranked by fit to the wedge in §1.1:

1. **Kameti organiser networks** — the highest-value channel because they're the exact audience the witness link was built for. Mosque/community committee organisers, women's savings-circle leads (the demographic Oraan itself over-indexes on), and existing informal BC/committee WhatsApp groups.
2. **Gulf-expat WhatsApp/Facebook groups** — Pakistani community groups in UAE/KSA/Qatar (rent-splitting, remittance-adjacent audiences); Filipino/OFW community groups given PHP currency support is already shipped.
3. **Splitwise-refugee spaces** — subreddits and forums where "Splitwise alternative" is an active search (the alternatives cottage industry the research documents), pointed at the comparison landing page (§2.3).
4. **Student/flatmate groups** — the ad-hoc split feature (no group required, commit `331a702`) fits this without needing O4 first.

**Outreach script — WhatsApp group admin (asking permission to post), Roman Urdu:**
> Assalam-o-alaikum [naam], main Hisaab app bana raha hoon — ek free tracker jahan kameti ka draw provably-fair tareeke se hota hai aur har member ek witness link se khud verify kar sakta hai ke draw sahi hua. Koi paisa Hisaab ke paas nahi jata, bas record rehta hai. Kya main is group mein ek dafa share kar sakta hoon? Agar kisi ko pasand na aaye to bata dena, hata dunga.

**Outreach script — WhatsApp group admin, English:**
> Hi [name], I'm building Hisaab — a free tracker that runs kameti/committee draws with a public witness link so every member can verify the draw themselves, without anyone holding the money. Would it be okay to share it once in this group? Happy to remove the post if it's not a fit.

**Outreach script — direct to a kameti organiser (individual DM), Roman Urdu:**
> Aap jo kameti chalate hain, uske liye ek cheez dikhana chahta tha — Hisaab mein aap draw karte hain aur ek link ban jata hai jo har member ko bhej sakte hain, wo khud check kar sakte hain ke draw fair tha, bina app install kiye. Free hai, koi paisa Hisaab ke paas nahi aata. Ek dafa dikha doon?

**Outreach script — direct to a kameti organiser, English:**
> I noticed you run a committee/kameti with your group — wanted to show you something. Hisaab lets you draw the order and generates a link any member can open (no install needed) to verify the draw was fair. It's free and never touches the money itself. Want a quick look?

---

## 4. iOS evaluation

**What it needs, concretely:**

| Requirement | Current state | Gap |
|---|---|---|
| Mac + Xcode | No `ios/` directory exists in this repo | `npx cap add ios` plus a Mac (owned or a cloud CI Mac runner) |
| Apple Developer Program | Not enrolled (unknown from repo) | $99/year, plus the enrollment lead time |
| Push | FCM (`google-services.json`, currently absent even for Android checkout builds per `07-mobile-first.md` MF-05) | iOS needs APNs certs/keys, either via Firebase's APNs bridge (reuse the FCM investment once that's fixed) or native APNs directly |
| Universal Links (App Links equivalent for the witness/khata public links) | Android's own equivalent, `assetlinks.json`, is **never deployed** today (`07-mobile-first.md` MF-04) | An `apple-app-site-association` file is net-new work, not a port — and the Android gap should be fixed first so the same mistake isn't repeated on iOS |
| App Store Review — finance-adjacent, no-custody app | Listing copy is already policy-safe: "not a lender," no lending language (`play-store-listing.md` policy notes) | Two live gaps that block iOS review same as they'd risk Play enforcement: (1) no block/report UI — the SQL primitives exist (`supabase-migration-p2-trust-safety.sql`, apply-order: last) but there is no client wiring in `src/` at all (confirmed absent by search) — Apple's Guideline 1.2 (UGC) expects this; (2) in-app account deletion must be reachable in the iOS UI (the underlying soft-delete RPC exists — confirm the entry point ships to iOS too) |
| Sign in with Apple | Auth is email/password only (`AUTH_METHOD` telemetry enum has only `'email'`) — likely exempt from the "offer Sign in with Apple if you offer other third-party logins" rule, but verify against current guideline wording before submission | Low risk, verify late in the process |

**Rough effort:** platform bring-up (icons, splash, `Info.plist` permissions, push cert/key swap) ≈ 1–2 weeks; Universal Links + store assets + review cycle(s) ≈ 2–3 weeks more, contingent on Mac/account already in hand. Call it **4–6 elapsed weeks** for a first submission, not counting the block/report client work above, which should land for Android/web anyway (§5).

**Decision rule:** the brief's own instinct — "Gulf expat iPhone share" — is directionally right but currently unmeasured. The telemetry schema's `SURFACE` enum today only distinguishes `'pwa' | 'android'`; there is no iOS signal at all. **Before committing engineering time to iOS, add a low-cost User-Agent-derived iOS-Safari indicator to the existing `app_opened` PWA telemetry** (still enum-safe, still no PII) and let it run through Phase 2–3 (§3.1). **Recommended trigger:** commit to iOS once the iOS-Safari share of PWA activation-funnel completions (`auth_completed` → `entry_created`) holds ≥30% over a rolling 90 days, or once unprompted iOS requests in `feedback_opened` cross a threshold the founder sets after seeing real volume — whichever comes first. Do not start iOS work while P0 items are still unmerged (§0); three platforms competing for one engineer's time before the money-integrity floor is fixed is its own risk (see the "bus factor 1" finding, `00-executive-summary.md` Top 10 Risks #7).

---

## 5. Risks

| Risk | Grounding | What it means for GTM specifically |
|---|---|---|
| **Over-claiming.** The audit's central finding is that this is a trust-positioned product that shipped provably false security claims (PIN, offline, currency) in its own listing draft. | `00-executive-summary.md` Top Finding #3, `12-qa-review.md` F-1 | Every claim in §1.4 has a status column for a reason — re-check it against `P0-REMEDIATION.md` before every campaign push, not just once at launch. Do not let a marketer or a future contributor "restore" the PIN/offline lines from an old draft without re-verifying they're live in production, on-device. |
| **Play policy — UGC block/report.** Google Play (and Apple, §4) expect a report/block mechanism for any product with user-to-user content or interaction. | SQL primitives exist (`supabase-migration-p2-trust-safety.sql`, apply-order: last, after all audit-p0 and p1 files) but **no client UI or store wiring exists anywhere in `src/`** (confirmed by search) | This is a P2 roadmap item (`00-executive-summary.md` §6.3 M6), not yet started on the client. Do not run paid acquisition or push the app into a wider Play track (open beta / production) until block/report is reachable in the UI — a single harassment incident with zero product answer is a fast way to a policy strike, and it directly contradicts the trust positioning in §1.1. |
| **Monetization messaging — no dates.** The current promise is "free, always, never ads" (`i18n.ts:475-476`) plus a design mock for a future premium-AI tier (`ai-tab-3.jsx:258`); there is **no entitlement, billing, or payment code anywhere in `src/`** (`00-executive-summary.md` G11/O9). | Messaging discipline: keep saying "everyday tracking is free forever" (true, and structurally guaranteed by the absence of any paywall code) and "premium AI features may come later" — never attach a date, a price, or a feature list to the future tier until entitlement code exists. CreditBook is the cited cautionary precedent for a Pakistani free-ledger product with no revenue mechanism (§11 §3, G11) — investors and press will ask about this; the honest answer today is "not yet built," not a promise. |

---

*Prepared 2026-09-02. All claims above are grounded against commit `2248327` and the current working tree; the P0 remediation branch (`audit-p0-remediation`) is cited explicitly wherever it changes a claim's truth value.*
