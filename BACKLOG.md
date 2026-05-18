# Hisaab Feature Backlog

Ideas surfaced from the deep review on 2026-05-19. The items in this file are **parked for later** — the in-flight batch is tracked separately in `FEATURES_IN_PROGRESS.md`.

Ordering inside each section is rough — read the "Why" first, then decide.

---

## A. Close the obvious gaps (table stakes for the wedge)

### A1. Auto FX rates with manual override
**Why:** Every salary transfer to Pakistan is a mental "what was the rate today?" calculation. Owning that moment owns the user. Today `conversionRate` is hand-typed every transfer.

**Shape:**
- Free API: exchangerate.host or frankfurter.app (no key needed). Cache in localStorage for 6 hours.
- New file `src/lib/fxRates.ts`: `getRate(from: Currency, to: Currency): Promise<number>`.
- In the Transfer step of QuickEntry: pre-fill `conversionRate` with the auto-rate; show "Rate today: 78.2 — tap to override."
- Pairs naturally with the Remittance tracker (already in the in-flight batch).

**Risk:** API downtime — must degrade gracefully to manual entry.

---

### A3. Receipts and photo attachments
**Why:** "Where did that 600 AED go?" is a real problem and a moat. Right now there's nowhere to attach proof.

**Shape:**
- Supabase Storage bucket `receipts/` with per-user prefixes.
- New column `receipt_url` on `transactions` and `group_expenses`.
- Camera/upload button on TransactionItem detail view + GroupExpense modal.
- Strip EXIF client-side before upload (privacy).
- Compress to ~1200px JPEG to keep storage cheap.

**Risk:** Storage cost growth — plan a per-user quota and prune policy.

---

### A5. CSV bank import (UAE banks first)
**Why:** The "I tried to enter a month of transactions and gave up" killer. Emirates NBD, ADCB, Mashreq all export CSV.

**Shape:**
- One parser per bank format in `src/lib/imports/<bank>.ts`.
- New page: `/import` — paste CSV, preview, map columns, dedupe by (date, amount, account) against existing transactions.
- Bulk insert via the existing `transactionsDb.add` path so balance math stays correct.

**Risk:** Each bank changes their export format yearly — fixtures + tests are required.

---

## B. Make the social ledger sticky

### B2. WhatsApp share cards
**Why:** WhatsApp is where Pakistani groups already coordinate. Meet them there.

**Shape:**
- Canvas-based card renderer: "Bilal owes you AED 320 in 'Boys Trip Dubai'" with branding.
- Web Share API with image + text.
- Trigger from group detail page + each settlement request card.

**Risk:** Web Share API has poor coverage in older Android WebViews — falls back to "copy link / save image".

---

### B4. Group categories + per-trip analytics
**Why:** A "Goa Trip Jan 2026" group is already a clustered dataset. Add: total spend, top spender, category breakdown, your share vs. average.

**Shape:**
- New tab on GroupDetailPage: "Insights".
- Reuse existing analytics utilities; group-scope them.
- No schema change.

---

### B5. Multi-currency groups
**Why:** A trip from Dubai to Lahore has both AED and PKR expenses. Today groups have a single currency, forcing manual conversion at entry time.

**Shape:**
- Drop the `currency` field on `split_groups` and put it on `group_expenses` instead.
- At settlement time, normalize to the group's primary currency (settable, defaults to first expense's currency) using a snapshot rate captured per expense.
- Migration to backfill existing rows.

**Risk:** Big migration. Holdback to a second pass — the balance math is delicate.

---

### B6. One-tap UPI-style settlement deep links
**Why:** You can't move money yourself, but you can deep-link to the user's bank app or Aani QR with the amount prefilled.

**Shape:**
- UAE: build Aani QR (EMVCo standard) from amount + recipient mobile or IBAN.
- Pakistan: Raast QR similarly.
- Add a "Pay now" button on settlement detail; renders QR + share sheet.

**Risk:** Aani/Raast QR specs may require registration or compliance review before launch.

---

## C. Insight & engagement (the "cool product" layer)

### C2. Anomaly detection
**Why:** "You spent 3× your usual on dining out this week." Subtle, non-judgmental.

**Shape:**
- Rolling 4-week mean + stddev per category.
- Flag categories where this week is > mean + 2σ.
- Surface as a card on AnalyticsPage, not as a notification (don't be annoying).

---

### C3. Cash flow forecast
**Why:** "You'll have ~AED 2,300 left on the 28th." One sparkline on the home screen.

**Shape:**
- Inputs: current account balance, upcoming expenses (next 30 days), recurring transactions (next 30 days), trailing 4-week average daily spend.
- Output: 30-day balance projection per account.
- Render: tiny sparkline + final-day number on each AccountCard.

---

### C4. EMI / loan calendar view
**Why:** EMIs are buried inside Loan Detail today. A month-grid view makes them collectively visible.

**Shape:**
- New route `/loans/calendar` or a tab on LoansPage.
- Grid of upcoming EMI rows for the next 3 months, colored by status.

---

### C5. Goals with auto-rules
**Why:** "Move 5% of every salary to the Hajj goal." Combined with Recurring Transactions (already in the in-flight batch), the goal hits itself.

**Shape:**
- Extend `goals` with `auto_rule: { triggerType: 'on_income', percent: number, fromAccountId }`.
- When `processTransaction` commits an income, check active auto-rules and queue a goal contribution.

**Risk:** Care to avoid double-applying on retried mutations.

---

### C6. Voice entry
**Why:** "Spent 40 dirhams on petrol" → parse → confirm → save. Powerful for elders and Urdu speakers.

**Shape:**
- Web Speech API for capture (already supported in Chrome/Edge/Safari).
- Send transcript to a cheap LLM endpoint (Claude Haiku or self-hosted) for structured extraction: `{ amount, currency, category, paymentMethod }`.
- Always confirm before saving — never auto-commit.

**Risk:** LLM cost per user. Consider a regex-based parser for the 80% case and only fall back to LLM for ambiguous phrasing.

---

## D. The moat plays (Pakistani-expat specific)

### D1. Arabic UI
**Why:** GCC is the real market. `i18n.ts` is one column away from supporting `ar`.

**Shape:**
- Add `ar` column to every string in i18n.ts (or migrate to JSON files first — see CODE_QUALITY notes).
- RTL layout — Tailwind v4 has `dir:rtl` variants. Audit every flex/grid for asymmetric padding.
- Right-aligned numerals, Arabic numeral toggle.

**Risk:** Bigger than it looks — every modal/dropdown/animation needs to flip.

---

### D2. Zakat calculator
**Why:** No expat-finance app does this well. Genuine differentiation.

**Shape:**
- New page `/zakat`.
- Computes zakatable wealth: cash + bank + savings goals + loans owed to you − loans you owe, where each balance has been held for one Hijri year (nisab threshold check).
- Date math uses Hijri calendar — pull in `hijri-date` or similar.
- Email/PDF a Zakat plan one week before Ramadan.

**Risk:** Religious accuracy is non-negotiable. Have a scholar-reviewed FAQ. Use conservative defaults; let the user override.

---

### D3. Salary certificate / loan letter export (PDF)
**Why:** UAE banks ask for a 3-month transaction statement when issuing personal loans. Directly useful, never asked-for until needed.

**Shape:**
- New page `/export/statement` with date range picker, account multiselect, category filter.
- Client-side PDF via pdf-lib or jsPDF — header with logo + user name, table of transactions, summary totals.
- Watermark "Generated from Hisaab" — fine for bank submissions, builds brand.

---

### D4. End-of-service gratuity tracker
**Why:** UAE law: 21 days × salary per year served (first 5 years), 30 days after. No app surfaces this; every UAE expat thinks about it.

**Shape:**
- New entity `employment_record { startDate, monthlyBase, employerName }` (single per user for v1).
- Widget on HomePage: "Your gratuity is currently AED 18,400 — based on AED 8K base × 27 months."
- Hover/tap shows the calculation breakdown + projection at 5-year and 10-year marks.

**Risk:** UAE labour law has nuances (unlimited vs. limited contract, termination cause). Add a disclaimer.

---

### D5. Visa renewal / Emirates ID / passport reminders
**Why:** Same notification infrastructure as Upcoming Expenses, but for documents. Day-saver.

**Shape:**
- New entity `document_reminder { type, label, expiryDate, reminderDaysBefore[] }`.
- Reuse notification infrastructure — fire reminders at 90/60/30/14/7 days before expiry.
- Pre-built types: Emirates ID, Passport, Driving Licence, Visa, Insurance.

---

### D6. Family budgeting (shared household)
**Why:** Most Pakistani expats split money: personal accounts here, plus a "Pakistan household" allocation managed by a parent or sibling. The linked profile infrastructure already exists.

**Shape:**
- New entity `household` with members (linked profiles or guests).
- Shared accounts: read-only or co-managed depending on member role.
- A household ledger separate from personal ledger; the user's HomePage can switch context.

**Risk:** Large feature. Will touch every existing store. Plan as Phase 3.

---

## E. The "cool" layer (polish that earns word of mouth)

### E2. Quick Entry from notification
**Why:** Android lets a notification carry a text input ("RemoteInput"). Type the amount, hit send, transaction posted.

**Shape:**
- Capacitor plugin for native Android notification handling.
- Service worker route that accepts a POST with `{ amount, category }` and forwards to Supabase.
- Background fetch retry on failure.

**Risk:** Only useful once Capacitor is in. Park until then.

---

### E3. Apple Watch / Wear OS complication
**Why:** Read-only "today's spend, group balance, next bill." Makes the app feel premium.

**Shape:**
- Wear OS tile via Capacitor or native module — likely a separate Kotlin/Swift surface.
- watchOS app via WatchKit + Combine reaching out to a Supabase read endpoint.

**Risk:** Significant native development. Not the highest leverage move yet.

---

### E4. Haptic feedback on tap
**Why:** Costs nothing, feels expensive.

**Shape:**
- Capacitor Haptics plugin — already pre-installed if the Android wrapper is.
- 50ms light tap on every save / settlement / reconciliation.
- Respect the OS "reduce motion" setting.

---

## Code quality / tech-debt cleanup

These came up in the code review and aren't features per se, but they unblock everything above.

### TD1. Delete dead Dexie code
- Remove `src/db/database.ts` and the `dexie` dependency from `package.json`.
- Change `src/db/index.ts` to: `export { SUPPORTED_CURRENCIES } from './types'; export type * from './types';`
- ~150KB shipped to clients today for no reason.
- **Note:** the in-flight Offline-first scaffolding may resurrect Dexie for a different purpose (a write-side mirror, not the legacy schema). Either way the current `HisaabDatabase` class is unused.

### TD2. Rewrite README.md
- Current state: unedited Vite template. Anyone evaluating the project gets no context.
- Need: architecture, run instructions, money-flow philosophy, the Phase 1B/2A/2B/2C/2D model with a one-line summary of each.

### TD3. Add Sentry (or PostHog) error tracking
- 30+ `console.error` sites today, mostly intentional non-fatal logging.
- Wire them to `captureException` so "fanOut: notifications insert failed" is visible in production, not just devtools.
- Free tier is plenty for current scale.

### TD4. Fix `analytics.ts` date math with date-fns
- `monthlyTrend` uses `new Date(year, month - i, 1)` and compares against ISO strings — fragile across timezones and month boundaries.
- Replace with `startOfMonth(subMonths(now, i))` and `endOfMonth(...)`. date-fns is already in deps.

### TD5. Add vitest with 5 core tests
- `mutationSafety.test.ts`: rollback ordering, partial-failure errors collected.
- `splitStore.balances.test.ts`: balance math correctness against a fixture group.
- `linkedRequestBranch.test.ts`: every routing branch.
- `analytics.test.ts`: monthly trend with DST edge case.
- `constants.formatMoney.test.ts`: currency formatting parity.

### TD6. ESLint type-checked preset
- `eslint.config.js:13` extends `tseslint.configs.recommended`. Switch to `recommendedTypeChecked` and fix the ~50 warnings it will surface.

### TD7. Split `supabaseDb.ts` (1141 LOC)
- One module per entity: `accountsDb.ts`, `transactionsDb.ts`, `loansDb.ts`, `personsDb.ts`, `linkedRequestsDb.ts`, `settlementRequestsDb.ts`, `groupsDb.ts`, `notificationsDb.ts`.
- Extract a `pick<T>(obj, keys)` + camel-to-snake helper to kill the 15+ repeated `if (changes.X !== undefined) row.X_y = changes.X` blocks.

### TD8. Move auth from localStorage to in-memory cache
- `supabaseDb.ts:11` reads `hisaab_supabase_uid` from localStorage on every query.
- Drift risk when Supabase session refreshes without re-writing the cache.
- XSS-readable. Use `supabase.auth.getUser()` cached in a module-level variable.

### TD9. Move i18n to JSON files
- `src/lib/i18n.ts` is 1263 lines of a single TS object. Translators can't work on it.
- Move to `src/locales/en.json`, `src/locales/ur.json` (and `ar.json` once D1 lands).
- Tiny loader file replaces the current `useT()`.

---

## Index — sorted by leverage (very rough)

| Tier | Item | Effort |
|---|---|---|
| 🟢 Highest | A1. Auto FX rates | Half day |
| 🟢 Highest | D3. PDF statement export | One day |
| 🟢 Highest | D4. Gratuity tracker | One day |
| 🟢 Highest | D2. Zakat calculator | Two days |
| 🟡 High | A3. Receipts | One day |
| 🟡 High | A5. CSV bank import | Two days |
| 🟡 High | D5. Document expiry reminders | Half day |
| 🟡 High | B2. WhatsApp share cards | One day |
| 🟡 High | D1. Arabic UI | Two days |
| 🟡 High | C3. Cash flow forecast | One day |
| 🟠 Medium | C2. Anomaly detection | Half day |
| 🟠 Medium | C5. Goals with auto-rules | One day |
| 🟠 Medium | B4. Per-trip analytics | Half day |
| 🟠 Medium | C4. EMI calendar view | Half day |
| 🟠 Medium | E4. Haptic feedback | One hour |
| 🔵 Lower | B6. One-tap settlement deep links | One day |
| 🔵 Lower | B5. Multi-currency groups | Two days |
| 🔵 Lower | C6. Voice entry | Two days |
| 🔵 Lower | E2. Notification quick entry | Two days |
| 🔵 Lower | E3. Watch complications | One week |
| 🔵 Lower | D6. Family budgeting | One week |
