# Hisaab — First-Time-User Friction Audit

_Generated 2026-07-08 · method: 12 persona agents walked every claimed feature through the real
code + i18n, then a skeptic pass tried to refute each blocker/major finding. 135 findings total;
52 skeptic-confirmed "real", 3 already mitigated. Live browser spot-checks by the reviewer confirmed
the auth/onboarding and witness-link findings first-hand._

Personas: Bilal (warehouse supervisor, first finance app, Roman-Urdu), Sana (freelancer paid in USD),
Imran (paper-khata shopkeeper), Ayesha (student, flatmate splits), Khala Rubina (runs a family kameti),
Danish (overspends, wants budgets + AI). Each stayed in character: their vocabulary, patience, and
fear that a "money app" will touch their real money.

---

## Executive summary

The **happy path is genuinely warm and well-built** — the onboarding safety step, the "detour not
dead-end" auth errors, the direction-aware khata repayment, the confirm-chip AI contract, and the
per-currency honesty on Accounts are all best-in-class for this audience (full list at the end — do
not regress these). But a first-time user hits friction in three systemic ways, and a handful of
**headline store-listing claims currently don't work at all.**

**The 3 systemic themes**
1. **The bilingual promise breaks exactly where it matters most.** The happy path is translated; the
   consequence-heavy copy (account deletion, contact linking, loan direction, every AI reply, the
   verification screen) is hardcoded English. A Roman-Urdu user is fluent until the scary moment.
2. **"Track vs move money" is answered inconsistently** — the app's central trust question. Sometimes
   an action moves the in-app balance and surprises the user (goals via quick-entry, group "Paid
   from"); sometimes it doesn't and they think it did (bill "Done", settle-up). Money can silently
   vanish from net worth (goals) with no undo.
3. **Several claims oversell the shipped state.** Multi-currency (no USD/EUR/GBP), offline-first (no
   offline write path), PIN lock (renders nowhere), receipt photos (edit-only), plain-words entry
   (buried in the AI tab), group splits with non-app members (impossible).

**Bottom line:** the product's *soul* is right for desi expat users. The risk is a newcomer bouncing
in the first five minutes on a broken promise, or — worse — quietly mistrusting their numbers after
money "moves" in a way they didn't expect. The blockers below are launch-gating; the majors are the
difference between "cute" and "I trust this with my hisaab."

---

## 🔴 Blockers (8) — fix before launch

These either make a listed feature impossible, or silently corrupt the user's intent/data.

### B1 · Multi-currency claim is false — USD/EUR/GBP unsupported
The listing sells "PKR, AED, USD, EUR & GBP." The app supports only
`['AED','PKR','PHP','SAR','QAR','OMR','KWD','BHD']` (`src/db/types.ts:1`). Sana (paid in USD) literally
cannot represent her salary account from minute one. Worse, the NL parser *detects* `usd/eur/gbp` in
typed entries and silently drops the currency, logging the amount in the default (`coffee 5 usd` →
AED 5, no error).
**Fix:** add USD/EUR/GBP to `SUPPORTED_CURRENCIES` + `currencyMeta` + plausibility bounds, **or** correct
the store listing to the GCC+PKR+PHP set actually shipped. If the parser assumes a currency, show a
visible "assumed AED — tap to change" chip instead of substituting silently.

### B2 · Offline-first has no offline write path
The listing promises "log on the bus"; the offline pill implies changes save on reconnect. But the
outbox runner is a feature-flagged scaffold whose every dispatch handler `throw`s
(`src/lib/outboxRunner.ts:26-29, 140-163`), no store enqueues to it, and `processTransaction` awaits a
direct Supabase insert that throws offline and rolls back. **Bilal cannot log a single expense without
signal** — his entire all-day-on-site use case is impossible.
**Fix:** ship the per-store outbox rewire (write to Dexie + enqueue, flush on reconnect) before making
any offline claim; *or* detect `navigator.onLine` at save time and disable Save with honest copy
("No internet — Hisaab abhi save nahi kar sakta"). Never let the user type a full entry and then fail.
*Resolved 2026-09-04: the second fix is the one that shipped — the inert outbox scaffold was deleted (decision D5, Option A, `docs/offline-story.md`), the listing makes no offline claim, and Hisaab is explicitly online-required for writes.*

### B3 · PIN lock does nothing
Setting a PIN shows "PIN set successfully!" but the lock screen is never rendered: `PinLockScreen` has
no importer anywhere, `App.tsx` has no `isLocked` gate, and `authStore.lock()` has zero callers. The
"PIN lock" claim is currently false and a privacy-anxious user's core reason to install is a no-op.
**Fix:** render `<PinLockScreen />` at the app root when `hasPin && isLocked` (the store already
initializes `isLocked=true` when a hash exists) and call `lock()` on `visibilitychange`/app-background.

### B4 · Import Data = wipe-then-replace with no safety net
Import deletes ALL rows across 10 tables *first*, then inserts from the file, with no transaction
(`src/lib/dataExport.ts:70-73`). A corrupt/truncated/incompatible backup → the insert throws → "Import
failed" → **the user's existing data is already gone.** The confirm copy ("Existing data may be
overwritten") badly understates total loss.
**Fix:** validate/stage the whole file before deleting anything (or upsert instead of delete-first).
At minimum auto-export a safety backup before wiping, and tell the truth in the warning.

### B5 · Goals — money can silently vanish from net worth
Two doors, opposite semantics. The goal card's "Add money" sheet says "This just tracks your saving —
it won't move money" and only bumps `savedAmount`. But quick-entry's "Savings" type deducts real
account balance — and since `AddGoalModal` no longer links a storage account, the money lands nowhere.
If the user then taps the goal card's "Take out," `savedAmount` drops but the account deduction is
never reversed: **money permanently disappears from in-app net worth, no trace, no undo.**
(`src/pages/GoalsPage.tsx:52-54, 97`; `src/lib/i18n.ts:1848`.)
**Fix:** unify semantics — make quick-entry "Savings" tracker-only unless the goal is account-linked,
or route the goal-card sheet through the same transaction pipeline. Mirror the "this deducts X from Y"
note both directions.

### B6 · Groups — can't add flatmates who don't have the app
Ayesha's exact scenario (4 flatmates, 2 on the app) is impossible and nothing says so.
`CreateGroupModal` only adds members by resolved HSB user code; there's no "add by name" guest member,
and expenses/settlements only allow connected members. The "share rent with your group" promise
silently shrinks to "with people who installed Hisaab" — unlike khata/instalments, which *do* support
non-app people. (`src/pages/CreateGroupModal.tsx:46-74, 161-163`.)
**Fix:** add "Add by name (not on Hisaab yet)" guest members (the schema already has a guest status +
per-member invite upgrade). At minimum say it upfront: "Everyone in a split needs Hisaab — to track
someone without the app, use Khata."

### B7 · AI's own instructions corrupt the user's data
The AI knowledge answer says: _"Use the Loans page (or tell me 'lent Ali 500') to record money you've
lent."_ But `routeAssistantInput` has **no loan route** — "lent Ali 500" parses as a plain expense
(amount 500, note "Lent Ali", category Other). The user confirms the chip believing the loan is
tracked; Ali's khata shows nothing, the account balance drops, and "how much does Ali owe me?" returns
nothing. (`src/lib/hisaabAssistant.ts:113-118`.)
**Fix:** add a loan intent (detect `lent/borrowed/udhaar diya/liya <name> <amount>` → loan confirm
chip), **or** fix the copy to "Open the Loans page — I can't log loans yet" and redirect the phrase.

### B8 · Linked-contact loan in a non-AED/PKR currency → raw Postgres error
Linked requests only support AED/PKR at the DB layer, but the full-tracker and `AddLoanModal` branches
don't gate on it before sending (the split-only path *does*, at `QuickEntry.tsx:431`). A user with a
USD/GBP account lending to a linked contact confirms the guard sheet and gets a raw
`violates check constraint "...currency..."` in a "Transaction Failed" toast, with no explanation and
no local-save fallback. (`src/pages/QuickEntry.tsx:474-499`, `src/pages/AddLoanModal.tsx:97-121`.)
**Fix:** apply the same AED/PKR gate; fall back to a local-only loan with the existing "linked records
support AED & PKR only for now" copy.

---

## Top systemic fixes (highest leverage)

| # | Theme | Where it bites | Fix mechanism |
|---|-------|----------------|---------------|
| 1 | **i18n leaks on consequence copy** | Verification screen, "Forgot password?", loans ("Your stance", "ppl"), the *entire* contact-linking ritual, kameti draw-verify, **100% of AI replies**, Settings Danger Zone | One sweep: move hardcoded strings into `i18n.ts` `{ur,en}` pairs. Prioritize trust-critical (deletion, linking, money direction). Add a lint/test that flags literal English JSX text in these files. |
| 2 | **"Record vs moves money" ambiguity** | Goals (B5), group "Paid from", settle-up, loan "does not move money" notice (wrong), bill "Done", credit-card bill | One reusable inline note pattern everywhere money is touched: either _"📒 Record only — no balance changes"_ or _"💸 This will subtract {amt} from {account}"_. Never leave the user guessing. |
| 3 | **Listing oversells shipped state** | B1 currency, B2 offline, B3 PIN, receipts (edit-only), plain-words entry (buried), B6 groups | Decide per-claim: ship it or cut it from the listing before store review. Honesty here is also a Play policy exposure. |
| 4 | **Silent-success / dead-end actions** | Bill "Done" (no txn, no undo), verify→"continue" dumps to login unexplained, B4 import, skip-onboarding still makes a phantom account, Monthly Wrap discarded forever | Every completing action needs feedback + (for destructive) undo. Audit for `.then()` that flips state with no toast. |
| 5 | **No edit/repair after creation** | Kameti (can't fix anything — name, amount, member exit), account currency (locked forever), primary currency (one-shot in onboarding) | Add minimal edit affordances; allow currency edit while an account has zero transactions. |

---

## Prioritized fix list (top 20, quick wins first within impact)

| Rank | Area | The confusion, in one line | Sev | Effort | Fix |
|------|------|----------------------------|-----|--------|-----|
| 1 | onboarding | Verification "I've verified — continue" reloads → dumps to Login with no explanation | major | S | Copy → "I've verified — log in"; show "Email confirmed — log in" banner on the login form |
| 2 | onboarding | Typo'd email (`gmal.com`) gets a green tick + succeeds → waits forever for a mail that never comes | major | S | Green tick only means "format ok"; add "did you mean gmail.com?"; make the escape route to re-enter email obvious |
| 3 | auth/settings | UR mode leaks English on scary copy: "Forgot password?", "Don't have an account?", whole Danger Zone | major | M | i18n sweep, trust-critical first |
| 4 | home | Headline claim "log in plain words (karak 3 aed)" is buried behind the "Hisaab AI" tab; the big "+" is a numpad | major | S | Add a one-line "Type it instead → Hisaab AI" affordance on QuickEntry step 0 |
| 5 | home | Receipt-photo claim has no path during entry (edit-only) | major | S | Add a "Receipt lagayein" button to QuickEntry details step + ConfirmationSheet |
| 6 | home | Tapping a transaction on Home does nothing; an unexplained "reconciled" circle sits next to entries | major | S | Make the row open edit; add a one-time "what's this ring?" tooltip |
| 7 | budgets | Bill "Done" records no transaction, no balance change, no undo — user thinks rent is paid | major | S | "Done" → "Log this as an expense? {amt} from {account}" (skippable), or a toast making clear it only hides the reminder |
| 8 | budgets | Every spend for 30 days after adding a bill triggers a full-screen "Spend anyway?" modal | major | S | Only fire when the spend would push the account below the bill amount |
| 9 | accounts | Credit card assumes zero balance owed — net worth instantly wrong, no hint | major | M | Add optional "abhi kitna dena hai?" field; `balance = limit − outstanding` |
| 10 | accounts | No named "Pay card bill" action — user must guess "Move Money" is it | major | S | Add a "Pay card / Card ka bill bharo" tile on card detail |
| 11 | groups | Solo group's big CTA is "Add first expense" — but you can't split with yourself | major | S | While alone, swap CTA to "Share code, invite a friend"; reveal "Add expense" after a 2nd member joins |
| 12 | groups | "Paid from" is mandatory and books the FULL amount as your personal expense, silently | major | M | Make it optional with "Don't track in my accounts"; caption "poora amount is account se minus hoga" |
| 13 | kameti | "Provably fair" explained in cryptographer's words (hex "fingerprint", "sealed seed") | major | S | Plain-words rewrite: "app ne ek band lifafa save kiya; yeh button check karta hai wohi tarteeb aati hai" |
| 14 | kameti | Organizer has no full baari schedule — only one round at a time behind chevrons | major | S | Reuse the witness page's schedule list on the organizer detail page |
| 15 | kameti | A member misses a month → everyone silently resets to "Due", arrears vanish | major | M | Per-member arrears chip ("PKR 10,000 baqi — 2 baariyan") + aggregate banner |
| 16 | kameti | Nothing is editable after creation (typo name, wrong number, member exits) | major | M | Allow rename + phone edit (no money-math impact); a "member exited" action |
| 17 | contacts | "Linking is private — the other user is not notified" is now **false** (reciprocal link notifies + auto-creates) | major | S | Rewrite to reality: "{name} will get a notification and you'll appear in their contacts" |
| 18 | contacts | Both flatmates entering each other's codes → confusing duplicate-link error | major | M | On `DuplicateLinkedContactError`, name the existing contact + "open it?" |
| 19 | insights | Split-linked expenses show a `[[HISAAB_META:%7B…]]` blob as the merchant name | major | S | Reuse `parseInternalNote` (the `getTransactionSubtitle` pattern already exists) |
| 20 | insights | Drilling from Analytics into a category ignores the period/currency just selected | major | M | Pass period+currency in the route to `InsightDetailPage` |

_(The remaining ~24 confirmed-major + 68 minor findings are in the per-area detail and the raw
dataset. Everything AI-language-related — all 13 knowledge answers, every data reply, clarify
questions — is hardcoded English even in UR mode; that's one concentrated fix in `hisaabAssistant.ts`.)_

---

## Per-area detail

### 1. First open & auth — persona: Bilal
The happy path is warm, but the **verification handoff is broken**: `signUp()` sets `user` immediately,
so the beautifully-localized `verify_*` "check your email" screen never renders — App.tsx swaps in its
own hardcoded-English `UnverifiedEmailScreen` instead. After verifying, the "continue" button reloads
into the Login form with no explanation. A typo'd email gets a green tick and succeeds into permanent
limbo. Roman-Urdu access is a tiny "UR" pill most users won't spot before signup.
- **[major]** Verification limbo screen is unreachable localized version / dead-ends to login · `AuthPage.tsx` + `App.tsx` gate
- **[major]** Typo'd email accepted with a reassuring green tick → silent limbo
- **[major]** Multi-currency claim uncompletable (see B1)
- **[minor]** UR toggle is a low-visibility corner pill on the pre-signup screen

### 2. Home & quick entry — persona: Bilal
Empty home is good (warm greeting + two-step GettingStartedCard). But the **headline plain-words claim
is hidden** behind the "Hisaab AI" tab; the obvious "+" is numpad-first. **No receipt path** during
entry. Tapping a transaction on Home does nothing. An unexplained "reconciled" ring appears next to
entries — a word the app never teaches.
- **[major]** "karak 3 aed" plain-words entry buried behind AI tab · **[major]** receipt photo edit-only
- **[major]** AI plain-words: typed currency vs first-account currency mismatch saves silently wrong
- **[minor]** Home transaction rows aren't tappable; "reconciled" ring untaught

### 3. Accounts & currency — persona: Sana
Per-currency honesty is excellent (never a fake combined total). But **USD absent** (B1); **credit card
assumes nothing owed** so net worth is instantly wrong; **currency is locked forever** after creation
and the preset path skips the currency picker entirely; **no "pay card bill"** action; **primary
currency is a one-shot** onboarding decision with no Settings row.
- **[blocker]** B1 currency · **[major]** ×4: credit-card owed, change primary currency, fix wrong account currency, pay card bill

### 4. Khata / udhaar — persona: Imran
The direction-aware repayment flow and hard overpayment block are genuinely protective (delights). But
the "given loan" form **requires an account and deducts real in-app balance while showing a notice
saying it doesn't move money** — directly contradictory. EMI setup **silently assumes monthly** with no
preview. Loan list/detail leak English ("Your stance · AED", "ppl") in UR mode.
- **[major]** ×3: contradictory "does not move money" notice, EMI monthly-assumed no preview, i18n leaks
- **[mitigated]** Direction-entered-backwards is well guarded already

### 5. Contacts & linking — persona: Ayesha
The linking model is powerful but **its privacy copy is now false** ("not notified" — reciprocal links
DO notify + auto-create a contact on the other side). The mutual-link ritual produces confusing
duplicate errors. Linked header reads circularly ("Sana — Linked to Sana"). The whole concept-heavy
flow is hardcoded English. Incoming requests from unrecognised senders read "Hisaab user says they
lent you AED 500" with no verifiable identity.
- **[blocker]** B8 non-AED/PKR linked loan error · **[major]** ×5: false privacy copy, duplicate-link UX, circular identity, i18n, unrecognised-sender identity

### 6. Groups & splits — persona: Ayesha
Debt-from-my-POV framing and the duplicate-expense soft warning are delights. But **non-app members are
impossible** (B6), the **solo group pushes "Add first expense"** you can't use alone, **"Paid from" is
mandatory and books the full amount as your personal expense**, and settle-up never says it's just a
record (newcomers fear it moves money).
- **[blocker]** B6 · **[major]** ×3: solo CTA, mandatory Paid-from books full amount, settle-up "does this move money?"

### 7. Kameti / committee — persona: Khala Rubina
No-custody reassurance and the draw-as-ceremony are excellent. But "provably fair" is explained in
crypto jargon; the **organizer has no full schedule view**; **missed months silently reset to Due**
with no arrears; **nothing is editable after creation**; "Fixed order" has no reorder control.
- **[major]** ×5: crypto-jargon trust panel, no organizer schedule, silent arrears, no post-create edit, fixed-order has no reorder UI

### 8. Budgets, goals & recurring — persona: Danish
Budget pace-tick and the self-correcting dated-goal coach are delights. But **goals can lose money**
(B5), **bill "Done" records nothing** (user thinks rent's paid), and **every spend for 30 days after a
bill triggers a full-screen warning**.
- **[blocker]** B5 goals · **[major]** ×2: bill "Done" silent no-op, over-eager spending warning
- **[mitigated]** "Left to spend" math reads correctly

### 9. Insights & statements — persona: Sana
The recipient-facing statement PDF and the post-repayment nudge are delights. But **split-linked
expenses show a `[[HISAAB_META…]]` blob** as the merchant, drill-in **ignores the selected
period/currency**, and the **Monthly Wrap is discarded forever** once closed.
- **[major]** ×3: meta-blob merchant names, period/currency dropped on drill-in, Wrap not re-openable
- **[mitigated]** Statement sender-vs-recipient preview copy is fine

### 10. Hisaab AI — persona: Danish
The confirm-chip contract and syntax-teaching clarify questions are delights. But **its own loan advice
corrupts data** (B7), category questions **don't match note/label text** ("karak" → 0), **"last month"
is silently ignored** (answers current month), and **every reply is hardcoded English** in UR mode.
- **[blocker]** B7 · **[major]** ×3: category-vs-note miss, period ignored, 100% English replies

### 11. Settings, trust & safety — persona: Imran
Forgot-PIN honesty and the logout reassurance are delights; the retired Remit feature was cleaned up
properly (routes hard-redirect, no stray nav entries). But **PIN lock is a no-op** (B3), **import can
destroy data** (B4), **Export likely does nothing in the Android WebView** (blob-anchor pattern),
**Delete-account "may be removed" hides that owned groups/kametis are deleted for everyone**, and the
Danger Zone stays English in UR mode.
- **[blocker]** B3 PIN, B4 import · **[major]** ×3: Android export no-op, deletion honesty, Danger Zone i18n

### 12. Offline & sync — persona: Bilal
Reads degrade beautifully offline (Dexie mirror) and the money-mutation compensation net is thoughtful
(delights). But **there's no offline write path** (B2), failed saves show raw "Failed to fetch" while a
perfect `err_offline` string sits unused, a **flaky-signal partial commit can leave the balance wrong**,
and the **chunk-load recovery overlay misdiagnoses "App update available"** when the real cause is no
signal (and the web PWA cold-starts blank offline because `/assets/` is never precached).
- **[blocker]** B2 · **[major]** ×5: raw error copy, partial-commit balance drift, false "update" overlay, blank offline cold start

---

## ✅ Delights — protect these, do not regress

- **Auth "detour not dead-end"** (`authErrorMap.ts`): every error → warm bilingual copy + one-tap recovery.
- **Live signup password checklist** that greens each rule and collapses to "Strong password"; login skips the policy so old passwords still work.
- **Onboarding safety step**: "never enter CVV/PIN", "Hisaab is not a bank" — addresses the exact fear pre-emptively, in both languages.
- **`nlExpenseParser`** desi vocabulary (karak, kiraya, hazaar, lakh), never-throw contract, confirm-chip trust model.
- **QuickEntry never strands** an account-less user; preserves the typed amount across the account-creation detour; live "After: {balance}" preview.
- **Per-currency honesty** on Accounts — no fabricated cross-currency total.
- **Novice-friendly credit-card rows** ("available" + "Owe {amount}" instead of a negative balance).
- **Direction-aware khata repayment** + hard overpayment block with a fixable message.
- **WhatsApp reminder** truly works for people without the app (editable `wa.me` deep link).
- **Forgiving connect-code entry** (`normalizePublicCode` strips @, HSB-, hyphens, case).
- **Group debt framed from "my" POV**; duplicate-expense soft warning.
- **Kameti no-custody shield + honest slot-value hints** ("early turn — like an advance") + draw-as-ceremony lock-in.
- **Budget pace-tick**; recurring never auto-posts; dated-goal self-correcting catch-up coach.
- **Recipient-facing bilingual statement PDF**; post-repayment statement nudge; privacy-safe Wrap share card.
- **AI confirm-chip contract** (nothing saved without an editable card); clarify-by-example.
- **Forgot-PIN honesty**; logout reassurance; Remit retired cleanly.
- **Offline reads via Dexie mirror**; LIFO mutation compensation + server optimistic-lock; failed saves never eat typed input.

---

## Already handled (don't re-fix)
- **Khata direction entered backwards** — existing direction guards + repayment title flip cover it.
- **Budgets "Left to spend this month"** — math reads exactly as a newcomer expects (per-currency).
- **Statement sender-vs-recipient preview** — copy is correctly perspective-aware.
