# Hisaab — User Experience Audit

**Report 06 · 2026-09-02 · Consolidating lead auditor (UX)**

> **Method note — code-level walkthrough only.** This report was produced by reading the current codebase (routes, pages, stores, i18n catalog) and simulating user journeys; no live rendering, emulator, or real-device pass was performed. Findings from two independent finders were deduplicated; every citation relied on in a high-severity finding was re-opened and spot-checked by the lead auditor. Where a finding was **not** independently re-verified, it is labeled. See the final section for what a moderated usability test must confirm that code reading cannot.

---

## Summary

Hisaab's UX has a demonstrably high polish ceiling — before/after balance previews on money mutations, post-save confirmation sheets with deep links, disciplined splits-mode route gating, dirty-close guards, and a best-in-class consolidated-repayment allocation preview (src/pages/QuickEntry.tsx:1138-1149, 2079, 1890-1925; src/App.tsx:458-497). The gaps are therefore not craft failures but **localized betrayals of the product's own promises**, concentrated in four clusters:

1. **The Urdu-first promise is roughly 70% true.** The most-visited screens (Home in both modes, Transactions, Budgets, Settings) and — worse — the highest-stakes sentences in the app (who owes whom, group balance direction, the invite landing page a non-user's relative first sees) are hardcoded English, while translations for many of them already exist unused in i18n.ts. The app also *defaults* to English (src/lib/i18n.ts:3062) despite docs stating Urdu is default.
2. **Security/consent theater.** A settable PIN that gates nothing (PinLockScreen.tsx has zero importers — re-verified), blind group joins with no preview, kameti members listed on a public witness link they never consented to with no token revocation, and group settlements recordable between two *other* members with no confirmation — in an app whose loan flow proudly requires two-sided consent.
3. **Silent data drops.** An EMI plan configured on a loan is silently discarded when the request branches to a linked contact (re-verified: src/pages/AddLoanModal.tsx:104-121 sends no EMI fields); "Save profile" writes the phone number to localStorage only; full-tracker group settle-up never offers to touch a real account.
4. **Irreversible onboarding.** Primary currency and display name are set once and can never be changed; the captured "intent" is written and never read, and can even dead-end into a silent redirect.

Of the July 2026 first-time-user audit's 8 launch blockers, **B1, B2, B3 remain fully open**, B4 and B6 are partially mitigated, B8 appears addressed client-side, and B5/B7 were not re-verified this pass.

**Verification status:** none of the 30 raw findings were adversarially refuted; all arrived UNVERIFIED from the finders. The lead auditor spot-checked the citations behind every high finding and most mediums (marked "re-verified" below). No "refuted" appendix is required — zero findings were rejected.

---

## Per-flow walkthrough findings

### Flow 1 — Onboarding & first run

**UX-01 · Primary currency is set once and can never be changed. (Medium)**
`hisaab_primary_currency` is written only by src/stores/onboardingStore.ts:65,98 (mirrored from profile in src/App.tsx:355); SettingsPage.tsx contains no currency control anywhere in its ~15 sections. Every headline number (home hero, month flow, budgets, analytics default) pivots on this choice. The core persona — a Gulf expat who may relocate AED→PKR — has no recourse but account deletion. Onboarding says "switch anytime" about the app *mode* (src/pages/OnboardingPage.tsx:413), training users to expect other onboarding choices are also revisitable. *Fix (S): a Settings row writing localStorage + profile; display-only preference, no data migration needed.* (Not independently re-verified; grep evidence is strong.)

**UX-02 · Display name is equally frozen. (Medium)**
`hisaab_user_name` is written only at onboarding (onboardingStore.ts:64,97; App.tsx:354). The "My Account" panel (SettingsPage.tsx:456-570) exposes email, mobile, user code, and password — but not the name that greets the user daily and appears on WhatsApp-delivered statements and receipts. A typo ("Ahemd") is permanent and lands on documents sent to real people. *Fix (S).*

**UX-03 · The onboarding "intent" is captured, promised routing power, then dropped — and can dead-end. (Medium)**
OnboardingPage.tsx:48-51 comments that the intent "routes the user's FIRST DAY"; in reality it produces exactly one `navigate()` (:123-128) and `hisaab_onboarding_intent` is written once and read nowhere. Worse: a user who answers "budgets" but lands in splits_only mode is navigated to /budgets — which silently redirects to Home (App.tsx:465). The user's stated reason for installing evaporates without a word. *Fix (S): validate intent against final mode; use the stored intent or stop writing it.*

**UX-04 · Documented default language is Urdu; the code defaults to English. (Low — re-verified)**
src/lib/i18n.ts:3062: `lang: (localStorage.getItem("hisaab_lang") as Language) || "en"`. The onboarding language picker mitigates this, but the doc/code drift should be resolved deliberately — for an Urdu-first brand, first paint in English weakens the differentiation moment.

**UX-05 · Full-tracker Home is nearly empty until an account exists, though onboarding lets you skip account creation. (Medium)**
The quick-tile grid (Kameti, Contacts, Analytics, Budgets…) and the To Receive/To Pay row are both gated on `accountCount > 0` (src/pages/HomePage.tsx:1083, :998), while onboarding's first-account step is explicitly skippable (OnboardingPage.tsx:475). A user who came for kameti or loans (the intent screen courts exactly them) sees only the GettingStarted card and cannot reach the differentiators from Home. In splits mode, kameti — available in both modes (App.tsx:472-475) — has **no Home tile and no bottom-nav slot** at all; it hides behind Settings (SettingsPage.tsx:907-919). *Fix (S): show the mode-filtered grid regardless of accountCount; add a kameti tile to the splits home.*

**UX-06 · GettingStarted "log your first entry" CTA routes to an empty list instead of opening QuickEntry. (Low)**
HomePage.tsx:987 `onLogEntry={() => navigate('/transactions')}` — a page that is by definition empty for this user, where a *second* CTA opens the entry sheet (TransactionsPage.tsx:496-504). The splits-home equivalent does it right, opening QuickEntry directly (HomePage.tsx:565-571). An extra hop at the single most fragile activation moment.

### Flow 2 — Quick Entry (the daily-driver flow)

**UX-07 · No date field — expenses can only be recorded "now". (Medium — re-verified)**
QuickEntry.tsx's only `type="date"` input is the EMI start date (:1762); there is no transaction-date control in any step. Backdating requires save → find → EditTransactionModal → change date (src/components/EditTransactionModal.tsx:589-597) — four extra steps most users will never discover. The app's own "Hisaab check" ritual assumes batch catch-up logging, yet lazily-logged weekends silently distort day grouping, "This month" totals, budget usage, and analytics, all keyed off createdAt. *Fix (S): an optional "Today ▾" chip (today/yesterday/pick date).*

**UX-08 · The Save button disables silently — nothing says what is missing. (Medium)**
`canSubmit` gates on up to four selections — account, contact, loan, goal, conversion rate (QuickEntry.tsx:525-562) — and the button just sits at reduced opacity (:1212-1214). Only overpayment gets inline copy (:1783-1791). The cross-currency rate requirement (:529) is especially opaque. Same pattern on onboarding step 5 and AddAccountStepper (issuer+last4+limit+due-day required with no unmet-requirement messaging, AddAccountStepper.tsx:102-110). *Fix (S): flash the first unmet requirement on disabled-tap.*

### Flow 3 — Transactions, Budgets, Analytics

**UX-09 · Analytics ignores the house loading-state pattern and flashes "no data" on every cold load. (Medium)**
AnalyticsPage.tsx:87 fires a fire-and-forget effect (no useAsyncLoad), :134 computes hasAnyData from a store that starts empty, :257-265 renders the EmptyState immediately. Sibling pages carefully suppress empty states until first load resolves (HomePage.tsx:180-184 — the comment documents exactly this pattern; TransactionsPage.tsx:489-505; AccountsPage.tsx:114-119). There is also **no error state**: a failed fetch is indistinguishable from "you have no spending data" — a meaningful lie in a finance app.

**UX-10 · Analytics leaks into splits mode and its CTA dead-ends. (Medium)**
/analytics is not mode-gated (App.tsx:450) while /transactions redirects in splits mode (:460). A splits user reaching Analytics via deep link or search sees a screen about transactions they cannot create; its empty-state CTA navigates to /transactions (AnalyticsPage.tsx:257-265) which silently bounces to Home. GlobalSearch — offered on the splits home (HomePage.tsx:498) — sends transaction-result taps to the same silently-redirecting route (src/components/GlobalSearch.tsx:90). Silent redirects with no toast are the exact failure mode tasks/lessons.md warns about. *Fix (S).*

**UX-11 · Filter pills break their own mental model. (Low)**
The "Loans" pill silently matches loan_given|loan_taken|repayment (TransactionsPage.tsx:256-259), while goal_contribution and opening_balance rows exist in the list with no pill that can select them (:210-216). A user auditing "where did my savings go" cannot filter to goal contributions.

### Flow 4 — Loans, contacts & the linked ledger

**UX-12 · EMI/instalment plan silently discarded when a loan branches to a linked cross-user request. (High — re-verified)**
AddLoanModal's validation comment promises the user "can't think they set up instalments and silently get none" (AddLoanModal.tsx:73-75), and `canSubmit` enforces `emiConfigured` (:78-79). But the linked branch (:104-121) sends only `{toUserId, personId, kind, amount, currency, note}` and **returns before any schedule generation** — while the EMI section remains visible and required in exactly this case. A user configures 12 instalments, taps send, and no schedule exists on either side; the confirm sheet (src/lib/confirmCrossUserRequest.ts) never mentions the drop. Qist is a headline instrument for this audience; reminders, due-soon/overdue status, and the To-do queue are all EMI-driven (LoansPage.tsx:282-295). *Fix (S): hide/disable the EMI section on the linked branch with an inline explanation, or carry the schedule in the request.*

**UX-13 · Rejecting a linked request supports no reason — the UI renders a field that can never be populated. (Medium)**
handleReject is a bare confirmDestructive with no text input (InboxPage.tsx:400-418; settlements at :491-509), yet the card renders `request.rejectionReason` (:1341-1343) — permanently empty. The entire point of a linked ledger is reconciling two memories of a debt; "Rejected" with no channel for "it was 300, not 500" pushes the disagreement out to WhatsApp. *Fix (S).*

**UX-14 · Name-fallback matching can put a stranger's loans on someone's WhatsApp statement. (Medium)**
Legacy loans without personId are matched to contacts by case-insensitive name in the contacts list chip (ContactsPage.tsx:188-204 — the comment acknowledges the risk), LoansPage grouping (:204-227), and — most seriously — the loan set handed to SendStatementModal (LoansPage.tsx:898-915; ContactDetailSheet.tsx:187-192). Duplicate names are allowed with only a soft warning (ContactsPage.tsx:253-257). Two contacts named "Ali" → one Ali's statement can include the other Ali's udhaar, delivered to a real person. *Fix (S): exclude name-fallback loans when the contact has a personId, or add a review step.*

**UX-15 · "Sync past records" is all-or-nothing. (Medium)**
One confirmDestructive fires every eligible historical loan at the counterparty (ContactDetailSheet.tsx:206-239); the card shows only aggregate counts (:619-674) — no per-loan checklist, no preview of the notes being shared. A single sensitive or disputed old entry cannot be held back. The AED/PKR-only limitation is disclosed in 10.5px fine print (:665-671). *Fix (M): per-loan checklist, default all checked.*

**UX-16 · Contact-link resolution verifies only a self-chosen display name. (Low)**
Pre-confirm, the user sees only the counterparty's displayName (ContactDetailSheet.tsx:793-804; ConnectByCodePage.tsx:150-161); the comparable short account ref appears only *after* linking (:411-420) — by which point the reciprocal "X added you" request has already been sent and the sync-past-records card is one tap away. Two "Ahmed"s are indistinguishable at the moment of commitment.

**UX-17 · Every unlinked contact's phone number is auto-submitted to the discovery RPC. (Low — re-verified)**
An effect batches every unlinked contact's phone into `discover()` on each contact-list change (ContactsPage.tsx:113-117), numbers are looked up while still being typed (debounced, :122-128), and per-open lookups run from the detail sheet (ContactDetailSheet.tsx:112-118). The *receiving* side's opt-in is handled; the *sending* side's third-party numbers leave the device with no user action, in a product whose pitch is "nothing to leak". Whether numbers are hashed in transit was not verified (see Evidence-unavailable). *Fix (S): gate behind the phone-discovery opt-in or a one-time prompt.*

### Flow 5 — Groups & splits

**UX-18 · Joining a group is completely blind. (High — re-verified)**
JoinGroupModal's own comment admits it: group metadata "can't be previewed before joining — strict RLS blocks reading a group you're not yet a member of — so the confirm step echoes the verified code + its kind instead" (JoinGroupModal.tsx:78-83). The "confirmation" card shows the user the code they just typed — zero new information — and the invite landing page (JoinGroupPage.tsx:126-135, 144-149) says only "Join shared group". The user consents to broadcasting their profile name to strangers they cannot see; a mistyped/stale GRP- code joins the wrong group, fires a member_joined event to all members (GroupDetailPage.tsx:133-139), and leaving is gated on settled balances (GroupDetailPage.tsx:421-455). *Fix (M): a SECURITY DEFINER preview RPC returning {name, emoji, memberCount, owner} — the exact pattern connect codes already use (resolveProfileByCode).* 

**UX-19 · Consent asymmetry: any member can record settlements and expenses on others' behalf — including between two people who are both not the recorder. (Medium — re-verified)**
SettleUpModal makes every debt row selectable, including third-party pairs (SettleUpModal.tsx:33-44, 68-72 even has dedicated copy for "debts between two other members"), and `addSettlement` commits instantly with no consent step (:88; src/stores/splitStore.ts:104-110, 1038-1055). Contrast the loan flow's flagship two-sided confirmation (InboxPage.tsx:357-399; confirmCrossUserRequest.ts:36-66). A member disputing a debt can record a fabricated "Ali paid Sara 500" that instantly settles balances for everyone; affected members get only a passive activity event. **Compounding it:** deletion is creator-only, but the guard inverts for legacy rows — `if (settlement.createdBy && settlement.createdBy !== currentUserId) return null;` (GroupDetailPage.tsx:1027-1041, re-verified at :1031) shows the Remove button to *every* member when createdBy is null; whether the server RPC independently enforces creator-only was not verified. *Fix (M): restrict recording to debts involving the recorder; hide delete on null-createdBy rows; confirm server-side enforcement.*

**UX-20 · Group "you" silently falls back to the owner. (Medium — re-verified)**
`currentMember = members.find(profileId match) ?? members.find(isOwner)` (GroupDetailPage.tsx:298-299). When the viewer's membership row doesn't match, the debts pinned and labelled "You" (:717-734), the "Your share" chip (:312-320), and the member id handed to SettleUpModal (:1077) all become the **owner's**. AddGroupExpenseModal proves the unmatched state occurs in practice — it has dedicated error copy for it (AddGroupExpenseModal.tsx:150-153, 252-255). Showing another member's stance as "you" is direction ambiguity of the worst kind in a money app. *Fix (S): drop the fallback; render neutral labels + the reconnect banner.*

**UX-21 · Full-tracker group settle-up never touches accounts — the one settlement family with no account leg. (Medium — re-verified)**
Linked-loan settlements offer an opt-in account leg on both sides (SettleLinkedLoanModal.tsx:193-265; AcceptIntoAccountSheet); group expenses can debit a paid-from account (AddGroupExpenseModal.tsx:284-309); group settle-up — the moment cash most reliably changes hands — has no account option at all (SettleUpModal.tsx:88; splitStore.ts:104-110 input shape has no accountId) and no hint that wallet balances will drift. *Fix (M): reuse AcceptIntoAccountSheet for debt rows involving the current user.*

**UX-22 · Ad-hoc split "they paid" renders shares that are never recorded. (Low)**
In they_paid direction only the user's own share is recorded — by design ("their debts aren't mine", SplitWithSheet.tsx:29-32, 153-156) — but the summary card still lists every participant with a computed share (:325-336), and the only hint is generic (:353-355). Users discover later that the app "forgot" the others' debts. *Fix (S): mute non-me rows + one explanatory line.*

**UX-23 · Terminology drift: "splits" vs "groups" vs three split mechanisms with no signposting. (Low)**
SplitsPage.tsx:199 counts "split(s)" under headers using t('groups_title') (:148-150, 298-303); SplitWithSheet (contact-based) vs AddGroupExpenseModal (member-based) vs the QuickEntry handoff use different participant models with nothing explaining when to use which. Three doors, different vocabularies, for one job ("where do I put a shared dinner?").

### Flow 6 — Kameti

**UX-24 · Kameti members never consent, and the public witness link exposes named delinquency forever with no revocation. (Medium)**
Members are organizer-typed name+phone rows (CreateCommitteeModal.tsx:36-70); the unauthenticated witness page lists every member's name, slot, and paid/unpaid badge (KametiWitnessPage.tsx:104-121), arrears amounts appear per member (KametiDetailPage.tsx:302-309), and shareWitness broadcasts the token to WhatsApp (:147-159) — the forwarding channel by design. `ensureShareToken` is the only token API; no revoke/rotate exists anywhere (src/stores/committeeStore.ts:132-139). Once forwarded outside the circle, a member's arrears are visible to arbitrary third parties indefinitely. *Fix (S): rotate-token action, initials-only display option, plain-language warning before first share.*

**UX-25 · No dropout/removal or order-fixing path — the organizer's only structural action is deleting the whole committee. (Low)**
Edit member = name/phone only (KametiDetailPage.tsx:58-72; committeeStore.ts:176 comment confirms slot/payments untouched); "fixed" payout order is frozen as typed with no reorder UI (committeeStore.ts:82-93); delete committee is the only escape (:161-167). Mid-cycle dropout is *the* classic ROSCA failure mode.

### Flow 7 — Settings, mode & security

**UX-26 · PIN lock is settable but never enforced — a false security control. (High — re-verified)**
Settings offers the full PIN lifecycle with a shield-icon "Security" section (SettingsPage.tsx:753-835). `PinLockScreen` is imported by **nothing** — a grep across src returns only its own file; App.tsx never mounts it (re-verified 2026-09-02). A user on a shared family phone — the realistic scenario for this demographic — sets a PIN believing their udhaar ledger is protected; anyone opening the app sees everything. The Play listing draft claims PIN protection (docs/play-store-listing.md), making this a store-misrepresentation risk on top of a trust betrayal. This is July-audit blocker **B3, unchanged after two months**. *Fix (S): mount PinLockScreen at launch/resume when hasPin, or remove the section and the claim.*

**UX-27 · Mode switching: blocked with a dead-end toast, or succeeds with silent apparent data loss. (Medium — re-verified)**
Switching to splits_only with any nonzero balance yields only a transient error toast (SettingsPage.tsx:723-733) — no guidance on which accounts or how to zero them. If balances are zero, the switch commits instantly with **no confirmation** (:734-735), and every account/transaction/budget/subscription/goal/investment surface vanishes from navigation (App.tsx:458-470) — reading as data loss. The two mode buttons visually resemble the harmless theme toggle above them. *Fix (S): confirmDestructive with a consequences list; a sheet linking to offending accounts.*

**UX-28 · "Sync Status" advertises offline-queue machinery that can never dispatch. (Medium)**
A permanent Settings card shows per-entity mirror timestamps and a "Queued offline changes" counter (SettingsPage.tsx:999-1043, :171-186 `db.outbox.count()`), while all outbox dispatch handlers throw behind VITE_ENABLE_OUTBOX (per architecture recon) — anything queued waits forever and the UI proudly counts it. Developer telemetry in consumer settings, entirely in English, compounding the "offline-first" listing claim (July blocker **B2**, still open). *Fix (S): hide unless the flag is on.*

**UX-29 · "Save profile" claims success while writing the mobile number to localStorage only. (Low)**
handleSaveProfile → localStorage + success toast (SettingsPage.tsx:301-304, read back at :156-158). The number never reaches the profile row, is invisible to phone-discovery matching (which has its own section), and evaporates on reinstall. *Fix (S): persist via profilesDb.updateCurrent or remove the field.*

**UX-30 · Credit-card setup mandates last-4 digits — privacy-sensitive, functionally cosmetic. (Low)**
canProceedStep1 requires `ccLast4.length === 4` (AddAccountStepper.tsx:107, input :255-256); last-4 is used only for the "⋯4521" row subtitle (AccountsPage.tsx:125). The heaviest form in the app (6 required fields) hard-requires a field that the "nothing to leak" pitch's own audience will balk at or fake. *Fix (S): make optional.*

---

## Cross-cutting sections

### Internationalization — the single largest UX defect cluster (High)

**UX-31 · Merged finding: hardcoded English saturates both the most-visited screens and the highest-stakes sentences. (High — spot-checked)**

Two independent finders converged on the same systemic defect from different directions; merged here with combined citations.

*Core screens (both modes):* The entire splits_only home hero and body are hardcoded English — "Good to see you" (HomePage.tsx:489-490), "Splits only" (:517), "Track people, not accounts." (:520), "Loans and groups. No cash wallets…" (:534), "No IOUs yet" (:560), "To receive"/"no one" (:584, :590) — all re-verified in-file, sitting *next to* correctly keyed strings (`t('home_people_to_settle')` :527, `t('home_record_iou_hint')` :563), proving the mechanism exists and is simply not applied. Full-tracker home hardcodes "Your money", "No accounts yet", "Your dashboard is up to date.", "N more · tap to manage" (HomePage.tsx:613-630, 675-693, 726, 739-745, 896-908, 941, 1447, 1494). TransactionsPage hardcodes the hero, day labels ("Today"/"Yesterday"), and the NextStepHint coaching copy (:310-312, 348, 365, 372, 453-467, 483). BudgetsPage title/intro/empty state (:123, 137-140, 253-259). Settings hardcodes "Sync Status", "Privacy Policy", "Delete account", PIN-editor buttons, password toasts (SettingsPage.tsx:92-97, 347, 351, 483-510, 797, 804, 1006-1041, 1098-1140, 1156-1196, 1224). QuickEntry:714, 768, 1127, 1469-1513; AddAccountStepper:280, 330.

*High-stakes social surfaces:* the sentences stating **who owes whom** are English-only string literals — "{name} owes you …" / "You owe {name} …" (ContactDetailSheet.tsx:443-444, re-verified) and "Gets back"/"Has to pay" (GroupDetailPage.tsx:939, 944). The invite landing page — the first screen a non-user's relative ever sees — is 100% English (JoinGroupPage.tsx:19-172), as is GroupInviteModal, which has no useT import at all (src/components/GroupInviteModal.tsx:52-116). Also affected: ContactsPage (:274-289, 327-386, 559-601, 653-696, 756), LoansPage (:494-501, 550-595, 698-701, 810-833, 1023), GroupDetailPage (~30 sites incl. :908-909, 965-985), AddGroupExpenseModal, SettleUpModal (:78-99 — including validation errors and success toasts, re-verified), InboxPage (:344, 447, 1320), HisaabAIPage (:36-37, 164-170).

*Direction even flips:* HomePage.tsx:1413-1415 shows "Overdue!" (English) to Urdu users but "Kal dena hai!" (Roman Urdu) to English users; AddAccountStepper.tsx:165 shows "Account nahi bana" to English users. Translation keys for many hardcoded strings already exist unused (i18n.ts:50 'settled', :2869 'check_receivable' = "To receive").

*Contrast:* newer surfaces (InvestmentsPage, KametiDetailPage, KametiWitnessPage, InboxPage card bodies, SettleLinkedLoanModal) are fully keyed — the debt is concentrated in the oldest, most-used code.

**Impact:** the primary persona cannot reliably read debt direction in their chosen language; the Urdu-first marketing claim is only partially true on the very first post-onboarding screen; directly re-confirms the July audit's systemic i18n theme. **Fix (M):** sweep for JSX string literals, reuse existing keys, add a CI grep/lint banning bare user-facing literals in src/pages and src/components.

**UX-32 · Roman Urdu register is inconsistent — tu/tum-form and aap-form mix across adjacent strings. (Low)**
'Amount daalo' (i18n.ts:71), 'Pehle Account Banao' (:76), 'kuch missing hay, check kro' (:712) vs 'Paisay Move Karein' (:28), 'chunein' (:55). For an audience where the aap/tum distinction carries real social weight — elders in a kameti — inconsistent register reads as unedited machine output. All strings live in one file; a native-speaker pass is cheap. (Needs native-speaker validation — see Evidence-unavailable.)

**UX-33 · Raw status enums leak into trust-critical badges. (Low)**
GroupInviteModal renders `member.status ?? 'connected'` verbatim, uppercase, unlocalized (:88, 99-101) — the *exact* bug GroupDetailPage documents as fixed ("replacing the raw enum … that leaked into the UI", :164-171). LoanDrilldownRow renders raw `loan.status` 'active'/'settled' (LoansPage.tsx:1023). These badges answer "is this person really on the app?" and "is this debt really settled?".

### First impression & learnability
The 6-step onboarding is well-structured (language → identity → intent → safety → mode quiz → first account), but its output is squandered: intent unused and possibly dead-ending (UX-03), currency/name frozen (UX-01/02), account-skippers landing on a near-empty Home (UX-05), and the first-entry CTA taking the long way (UX-06). The first *social* impression — a relative opening an invite link — is all-English (UX-31) and blind (UX-18).

### Information architecture & navigation
Mode gating is otherwise disciplined: routes redirect, BottomNav swaps tabs per mode (src/components/BottomNav.tsx:27-39), QuickEntry filters intents (QuickEntry.tsx:204-206). The leaks are specific: Analytics/GlobalSearch (UX-10), kameti's missing entry point in splits mode (UX-05), and three split mechanisms with no cross-signposting (UX-23). Silent mode redirects with no toast remain the standing IA hazard (App.tsx:458-470).

### Consistency
The app's best patterns are applied unevenly, which is more damning than absence: consent required for loans but not group settlements (UX-19); account legs on two of three settlement families (UX-21); useAsyncLoad on every core page except Analytics (UX-09); memberStatusLabel on the page but not its own modal (UX-33); AED fallback on ~19 screens vs PKR on 4 — **UX-34 (Medium):** when localStorage is empty, Home/Transactions/Accounts/Budgets fall back to AED (HomePage.tsx:133, TransactionsPage.tsx:187, AccountsPage.tsx:53, BudgetsPage.tsx:63) while Analytics, CreateGroupModal, CreateCommitteeModal, and the QuickEntry confirmation fall back to PKR (AnalyticsPage.tsx:102, CreateGroupModal.tsx:35, CreateCommitteeModal.tsx:29, QuickEntry.tsx:1087). A group or kameti created in the wrong currency in this state is a real data error — group currency is fixed at creation. *Fix (S): one getPrimaryCurrency() helper.*

### Visual hierarchy
Code-inferred only: the mode-switch buttons are styled like the adjacent harmless theme toggle (UX-27); the AED/PKR sync limitation lives in 10.5px fine print (UX-15); disabled Save communicates via opacity alone (UX-08). Real-device hierarchy needs the usability pass.

### Empty states
Generally excellent — gated to avoid flash (HomePage.tsx:180-184, TransactionsPage.tsx:489-505, AccountsPage.tsx:114-119), with CTAs. Exceptions: Analytics flashes its empty state and its CTA dead-ends in splits mode (UX-09/10); the accountless full-tracker Home is an empty state that hides the whole product (UX-05).

### Error states
Analytics has none — failure masquerades as "no spending data" (UX-09). The blocked mode switch is an error with no resolution path (UX-27). Rejection carries no reason channel (UX-13). SettleUpModal's validation errors are hardcoded English (SettleUpModal.tsx:78, 82). PageErrorState + retry exists and is used well elsewhere (HomePage.tsx:541-545).

### Loading states
House pattern (useAsyncLoad + skeletons) is strong and consistently applied — Analytics is the sole core-page defector (UX-09).

### Success/confirmation states
QuickEntry's post-save ConfirmationSheet with before/after balances (QuickEntry.tsx:1138-1149, 2079) is best-in-class. But success can lie: "Save profile" toasts success for a localStorage-only write (UX-29); a mode switch "succeeds" into apparent data loss (UX-27); a linked loan request "sends" while dropping its EMI plan (UX-12); a group join "confirms" nothing (UX-18).

### Forms
Disable-until-valid without saying *why* is the systemic form defect (UX-08, QuickEntry/onboarding/AddAccountStepper). Required-field overreach: last-4 (UX-30). No date field on the primary form (UX-07). Dirty-close guards (useDiscardGuard) are a genuine strength.

### Search & filters
GlobalSearch routes splits-mode transaction hits into a silent redirect (UX-10). Filter pills are lossy in both directions (UX-11).

### Friction points (ranked)
1. Backdating an entry: 4-step workaround on the daily-driver flow (UX-07).
2. First entry via GettingStarted: two screens instead of one tap (UX-06).
3. Blocked mode switch with no path forward (UX-27).
4. Dead Save button with no explanation (UX-08).
5. Sync-past-records: all-or-nothing with sensitive history (UX-15).

### Confusing interactions
"You" that is actually the owner (UX-20); recorded shares that vanish (UX-22); a settlement any bystander can record (UX-19); joining an invisible group (UX-18); "splits" that are "groups" (UX-23); random language direction flips (UX-31).

### Hidden functionality
Kameti in splits mode (Settings-only, UX-05); edit-to-backdate (UX-07); the entire quick-tile grid behind accountCount (UX-05); PIN "protection" that hides the fact it does nothing (UX-26).

### Cognitive overload
Settings is a ~15-section page carrying developer telemetry (Sync Status, UX-28), a security section that doesn't work (UX-26), and a mode switch styled like a preference (UX-27). The credit-card step is the heaviest form (6 fields) with a mandatory cosmetic one (UX-30).

### Missing guidance
No explanation of why loans need consent but group settlements don't (UX-19); no "this will drop your EMI plan" (UX-12); no "your data is kept" on mode switch (UX-27); no witness-link privacy warning before first share (UX-24); no cross-signposting among three split mechanisms (UX-23).

---

## Cross-reference: docs/ux-audit-first-time-user-2026-07.md (8 launch blockers)

| # | Blocker (July 2026) | Status 2026-09-02 | Evidence |
|---|---|---|---|
| B1 | Multi-currency claim false (USD/EUR/GBP unsupported) | **Still open** (re-verified in Phase 1) | src/db/types.ts:1 vs docs/play-store-listing.md:35 |
| B2 | Offline-first has no offline write path | **Still open** (2026-09-02) — resolved 2026-09-04: scaffold deleted, app explicitly online-required (D5, Option A) | Outbox dispatch throws behind VITE_ENABLE_OUTBOX; Settings still advertises the queue (SettingsPage.tsx:999-1043) — UX-28 |
| B3 | PIN lock does nothing | **Still open — re-verified this pass** | PinLockScreen.tsx zero importers; Settings UI intact (SettingsPage.tsx:753-835) — UX-26 |
| B4 | Import = wipe-then-replace, no safety net | **Partially mitigated** | A confirmDestructive warning was added ("Existing data may be overwritten", SettingsPage.tsx:243-249 — note: hardcoded English), but importData still deletes every user row first (src/lib/dataExport.ts:79-81); no backup/undo |
| B5 | Goals — money silently vanishes from net worth | **Not re-verified this pass** | Phase-1 memory notes goal fixes in the July recovery commits; needs a dedicated money-flow check |
| B6 | Groups can't include non-app users | **Partially fixed** | Ad-hoc SplitWithSheet ships (contact-based, no group needed); groups themselves still require app users — no guest members |
| B7 | AI's own instructions corrupt user data | **Not re-verified this pass** | HisaabAIPage exists (English-hardcoded strings noted, UX-31); behavior unaudited |
| B8 | Non-AED/PKR linked loan → raw Postgres error | **Appears addressed client-side** | confirmCrossUserRequest guard returns blockedReason pre-send (AddLoanModal.tsx:106-107); the AED/PKR limit is surfaced (as fine print — UX-15); server behavior unverified |

The July audit's systemic themes — i18n debt, "record vs moves money" ambiguity, listing overselling shipped state, silent-success actions — are all re-confirmed by this pass's findings (UX-31, UX-21, UX-26/28, UX-12/29 respectively). Two months on, the two blockers that are pure marketing/honesty problems (B1, B3) remain untouched, which is the cheapest possible category to have left open.

---

## Positive findings (protect these)

Route gating + catch-all (App.tsx:458-497); splits intent filtering (QuickEntry.tsx:204-206); after-balance previews and ConfirmationSheet (QuickEntry.tsx:1138-1149, 2079); per-mode BottomNav (:27-39); no-flash empty-state gating (HomePage.tsx:180-184 et al.); dirty-close guards (useDiscardGuard); consistent confirmDestructive on destructive actions; type-first QuickEntry with payee memory and reversible autofill; the consolidated-repayment FIFO allocation preview (QuickEntry.tsx:1890-1925). The gaps above are localized, not systemic craft failures — which cuts both ways: the team demonstrably knows how to do all of this, so the unfinished surfaces read as prioritization debt, not skill debt.

---

## Refuted during verification

None. All 30 raw findings arrived unrefuted (verification pipeline did not complete adversarial passes; findings were labeled UNVERIFIED). The lead auditor independently re-opened the citations behind every high-severity finding and most mediums — all spot-checks confirmed (PIN no-op, EMI drop, blind join, owes-you literals, owner fallback, null-createdBy delete, en default, silent mode switch, no date field, third-party settlements, auto phone discovery, hardcoded home strings, import wipe). Two overlapping finder submissions were merged: the two i18n findings (→ UX-31) and the legacy-settlement-delete finding into the consent-asymmetry finding (→ UX-19).

## What a moderated usability test should verify

This report is a code-level walkthrough; no screen was ever rendered. Before launch, a moderated test (5–8 participants, Urdu-first, at least two on shared family phones, at least one elder in a kameti) should confirm or size the following, which code reading can only infer:

1. **Language comprehension under mixing** — can an Urdu-mode participant correctly state who owes whom on ContactDetailSheet and GroupDetailPage, where the direction sentences are English (UX-31)? Measure error rate, not preference.
2. **Backdating discovery** — ask participants to log "yesterday's lunch"; observe whether anyone finds the save-then-edit path unprompted (UX-07).
3. **Dead Save button** — time-to-recovery when the QuickEntry Save is disabled for a missing conversion rate (UX-08); count who blames the app vs. who finds the cause.
4. **PIN expectation** — after setting a PIN in Settings, ask "what happens if your brother opens the app now?" and then demonstrate (UX-26). Record trust reaction.
5. **Blind join comfort** — hand participants a GRP- code and watch whether they notice the confirmation shows them nothing (UX-18); ask what they believe they just joined.
6. **Mode-switch mental model** — have a full-tracker participant switch to splits mode and narrate what they think happened to their transactions (UX-27).
7. **Witness-link privacy** — show a kameti member the public witness page listing their unpaid status; record consent reaction (UX-24).
8. **Touch ergonomics on-device** — 44px targets, safe-area, keyboard-over-input behavior in the Capacitor WebView; the 10.5px fine-print legibility (UX-15).
9. **Three-doors split confusion** — task: "you had dinner with two friends, one paid"; observe which of the three split mechanisms they pick and how long it takes (UX-23).
10. **Register reaction** — read tu-form strings ('Amount daalo') aloud to older participants and record whether it reads as disrespectful (UX-32).

## Evidence-unavailable / further investigation

The following cannot be determined from the repository and must be checked elsewhere:

1. **Real-device rendering and touch ergonomics** — 44px targets, safe-area behavior, keyboard interactions in the Capacitor Android WebView. Code-only pass.
2. **Native-speaker Roman Urdu quality** — register inconsistency (UX-32) is verifiable from i18n.ts; naturalness judgments need a native reviewer.
3. **Live Play Store listing state** — PIN/offline/currency claims compared against docs/play-store-listing.md in-repo, not the live console.
4. **User behavior/funnel data** — the repo ships zero product analytics, so every friction finding here is code-inferred, unsized, and unprioritizable by real usage.
5. **Supabase Studio migration state** — whether profile-mirrored settings (onboarding_intent, app_mode) persist server-side; manual-apply drift is a known risk.
6. **Server-side enforcement** — creator-only settlement deletion (UX-19), witness-token scoping (UX-24), and group-preview denial (UX-18) were verified as *client* behavior only.
7. **Phone-number handling in the discovery RPC** — hashed or plaintext in transit/storage (UX-17) not audited.
8. **Effective default language on real devices** — i18n.ts:3062 falls back to 'en'; whether onboarding writes hisaab_lang before first paint was not traced end-to-end.
9. **WhatsApp deep links, navigator.share fallbacks, QR scanning** in the Capacitor wrapper.
10. **B5 (goals) and B7 (AI data corruption)** from the July audit — need dedicated money-flow and AI-behavior passes.

**What a moderated usability test should verify** (5–8 participants, Urdu-first, mix of Gulf-expat and Pakistan-resident, at least two on shared family phones): (a) whether the mixed-language home screen is noticed/tolerated or read as broken; (b) whether anyone discovers edit-to-backdate unaided; (c) reactions to the mode switch "losing" data; (d) whether the blind group-join confirmation is read as a real confirmation; (e) whether a PIN-setter believes the app is locked; (f) kameti members' reaction to seeing their name/arrears on a forwarded witness link; (g) whether the disabled Save button causes retype-and-abandon; (h) aap/tum register perception across age groups.
