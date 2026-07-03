# Statement Family — Build Plan

_Planned 2026-07-02 · execution starts 2026-07-03 (morning)._

Four features that extend the shipped **Statement of Account** pattern —
"data we already have → recipient-focused, trust-building artifact → delivered
over WhatsApp (reaches non-users)". Ordered for build.

## Ground rules (apply to every feature)

- **Reuse the shipped pipeline:** `statementOfAccount.ts` (ledger), `statementText.ts`
  (`payOrReceiveLabel`, `greetingLine`, recipient-focused bilingual text),
  `statementPdf.ts` (DOM→raster→A4 PDF), `shareStatement.ts` (native/web/download),
  `whatsappReminder.ts` (`buildWhatsAppUrl` → reaches non-users).
- **No schema changes** — all four are confirmed doable in v1 with existing data.
- **Guardrails:** recipient-focused wording + CVD-safe colour (`#047857` receive /
  `#C2410C` pay, always with a sign + label); strict per-currency sectioning (never
  sum PKR into AED); no-custody TRACKER framing (never move money / imply interest /
  credit score); default privacy on anything exposing an absolute balance.
- **Ship each feature to BOTH targets:** `npm run build` → `npx cap sync android`,
  then hand off the signed AAB (`gradlew bundleRelease`, `JAVA_HOME=C:\Program Files\Android\Android Studio\jbr`)
  — the Gradle step can't run in-agent (loopback blocked).
- **Per-feature verification:** `npx tsc -b`, `npx vitest run`, `npm run build`; for
  visual output, the temp offscreen-node render + computed-style check pattern.
- Suggest one branch per feature (`feat/payment-receipt`, …) or a shared
  `feat/statement-family` with a commit per feature.

---

## Build order

### ▶ 1. Payment-received receipt  ·  effort S  ·  **tomorrow's kickoff**

When money **arrives**, the receiver one-taps a warm acknowledgement to the payer:
_"Received AED 500 on 2 Jul — remaining AED 1,500. Shukriya!"_ (bilingual, WhatsApp
text primary; PDF is a fast-follow). Closes the reminder→pay→**confirm** loop.

- **New:** `src/lib/receiptText.ts` (`buildReceiptText({receivedAmount, currency, remaining|null, date, payerName?, fromName?, greeting?})` → `{english, urdu, message}`) + `receiptText.test.ts`.
- **Edit:**
  - `RepaymentModal.tsx` — `onRepaid?({ amount })` (capture `parsedAmount` in a ref before fields reset; emit from the ConfirmationSheet `onClose`).
  - `LoanDetailPage.tsx` — offer the receipt **only when `loan.type === 'given'`** (money came back to the user); pass `receipt={{ receivedAmount, currency: loan.currency, remaining: loan.remainingAmount, date: now }}` into the existing `SendStatementModal`; `taken` loans keep the statement-only nudge.
  - `SendStatementModal.tsx` — optional `receipt` prop + a **Receipt / Full statement** toggle (Receipt default when present); reuse greeting selector, `preparedName`, WhatsApp-text, copy.
  - `InboxPage.tsx` — after a linked SettlementRequest is accepted and the user is the **creditor**, offer the receipt (`remaining = null` acceptable in v1).
  - `SettleUpModal.tsx` — after a group settlement where the user is the **payee**, offer the receipt (wa.me picker fallback — no phone in this context).
  - `i18n.ts` — `rcpt_*` keys in the `soa_*` block.
- **Decisions locked:** toggle inside `SendStatementModal`; include `remaining` when available; Inbox `remaining=null` in v1; **PDF receipt deferred** (text + copy only for v1); wa.me picker fallback for group receipts.
- **Schema:** none.

### ▶ 2. Groundwork — shared `renderNodeToImage`  ·  ~30–60 min

Before the PDF/image-heavy features, extract the DOM→raster core out of
`statementPdf.ts` so it's reused, not copy-pasted.

- **New:** `src/lib/renderNodeToImage.ts` — `renderNodeToPng(html, {width, height, scale})` and `renderNodeToPdf(html, {format})`; lazy-imports `modern-screenshot` + `jspdf`; owns the offscreen-node append/measure/snapshot/remove dance.
- **Edit:** `statementPdf.ts` → delegate to it (keep all existing statement tests green).

### ▶ 3. Group settle-up sheet  ·  effort M  ·  **flagship**

The Statement, for splits: a per-recipient WhatsApp card ("You owe AED 120 in
Dubai Trip") + a one-page settle-up-plan PDF of every X-pays-Y transfer.

- **New:** `src/lib/groupSettleUp.ts` (adapter: `computePairwiseDebts` → per-recipient card + full plan), `src/lib/groupSettleUpPdf.ts` (plan PDF via `renderNodeToImage`), `src/pages/GroupSettleUpModal.tsx`, + `groupSettleUp.test.ts`, `groupSettleUpPdf.test.ts`.
- **Edit:** `GroupDetailPage.tsx` (Share button on the Balances tab — today it has none), `SettleUpModal.tsx` (hook), `i18n.ts`.
- **Decisions locked:** default to the **current user's own** recipient card (privacy) + a member picker + an explicit "Full plan PDF"; PDF sub-heading states **Direct vs Simplified** view; **picker-only phone** for v1 (defer the `Person.linkedProfileId → phone` bridge); primary entry = Balances-tab button; text card = transfers + a compact "expenses you were in on" count, full itemisation in the PDF only.
- **Schema:** none (guest/unlinked members have no phone → wa.me picker covers it).

### ▶ 4. Hisaab Wrapped  ·  effort M  ·  **growth**

Turn the in-app-only Monthly Wrap into a shareable **portrait 1080×1920** image
card for WhatsApp Status — each view a branded impression in front of non-users.

- **New:** `src/lib/wrapCard.ts` (portrait card HTML from `WrapStats`), `src/components/ShareWrapCard.tsx` (share UI + privacy toggle), + `wrapCard.test.ts`. Uses `renderNodeToImage` (Phase 2).
- **Edit:** `MonthlyWrapModal.tsx` (Share button), `AnalyticsPage.tsx` (on-demand "Share your Wrap", `≥3-tx` gate), `i18n.ts`.
- **Decisions locked:** default to **"proud numbers"** (percentages / categories / active-days / headline); exact totals only behind an explicit opt-in; footer = "— tracked with Hisaab" + `@connect` code + short URL; native `domToPng` scale capped at **1.5** (node is already 1080 wide); single primary-currency card in v1 (honest "X only" note).
- **Schema:** none.

### ▶ 5. Kameti payout slip & contribution receipt  ·  effort M

On payout, the organiser sends a premium "You received the Round 4 payout of
PKR 80,000" slip; a lighter "contribution recorded" card per payment; both foot
the anonymous **witness link** as a "verify live" proof.

- **New:** `src/lib/kametiSlipPdf.ts` (payout slip + contribution card via `renderNodeToImage`), `src/components/KametiPayoutSlipSheet.tsx`, + `kametiSlipPdf.test.ts`.
- **Edit:** `KametiDetailPage.tsx` (hook the existing `confirmPayout` / "Mark received"), `committeeStore.ts` (`ensureShareToken`), `i18n.ts`.
- **Decisions locked:** slip **auto-opens** on "Mark received" (easy dismiss); per-payment = **text ping** default + optional PDF behind an icon (avoid rasterising every tap); **issued by** the organiser (`hisaab_user_name`), **received by** the member; ephemeral (no record stored); witness footer shows the **full URL** so a forwarded PDF is actionable.
- **Schema:** none (reuses `shareToken`, `committeeMath` position, `CommitteePayment`).

---

## Tomorrow-morning first three steps (Feature 1)

1. `git checkout -b feat/payment-receipt`.
2. Write `src/lib/receiptText.ts` + `receiptText.test.ts` (pure logic first — TDD).
3. Wire `RepaymentModal.onRepaid({ amount })` → `LoanDetailPage` (given-loan only) → `SendStatementModal` Receipt/Statement toggle. Then `tsc` + `vitest` + build.
