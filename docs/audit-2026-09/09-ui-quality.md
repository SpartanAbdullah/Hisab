# Phase 9 — UI Quality Audit (code-level)

**Date:** 2026-09-02
**Auditor role:** Design Engineer, adversarial due-diligence pass
**Scope:** `src/pages/` (50 files), `src/components/` (70 files), `src/index.css` (1,488 lines), `src/lib/design-tokens.ts` (264 lines)
**Method:** static code review — grep-based census of styling patterns plus close reading of the token layer, shared components, and the largest pages. **This is NOT a rendered visual pass.** A screenshots-on-device pass is still required; a checklist for it is at the end.

---

## Verdict

**UI maturity: 6.5 / 10** — well above prototype, below polished product.

This codebase is bimodal in a way that is unusual. The *newest* layer — the "Sukoon" redesign in `src/index.css` — is some of the most carefully reasoned UI CSS I have audited at this company size: a documented motion system with a single reduced-motion gate (index.css:451-471), GPU-only animation contract for low-end Android WebViews (index.css:295-298), a skeleton-sweep philosophy with phase-offset rows (ListSkeleton.tsx:10-18, 26-34), safe-area utilities (index.css:731-744), an overflow guard on the money hero for billion-rupee PKR amounts (MoneyDisplay.tsx:41-46), and inline WCAG contrast math in comments (AuthPage.tsx:16-24, index.css:236-241).

The *older* layers, however, were never cleaned up. The result is: **two contradictory color systems, a token file that nothing imports, ~500 lines of dead component CSS whose own comments misstate their adoption, 1,295 arbitrary font-size utilities across 21 distinct pixel values, and system-wide small-text contrast failures against the very palette the redesign introduced.** The shared `<Modal>` — the container for roughly 40 flows — has no `role="dialog"`, no focus trap, and no Escape handling.

Dimension scores (1-10):

| Dimension | Score | One-line reason |
|---|---|---|
| Design-token adoption | 3 | The TS token file and most CSS component tokens have zero consumers (evidence below) |
| Typography hierarchy | 4 | 29 distinct font sizes in practice; sizes below the repo's own 10px floor |
| Color consistency | 7 | Money semantics centralized and good; three competing greens + red leaks remain |
| Spacing & alignment | 6 | Real rhythm exists (p-4/p-3 dominate) but 10 horizontal-padding values in play |
| Overflow handling | 7 | 117 `truncate` + 136 `min-w-0` + digit-count guard; Urdu strings 57% longer than English is untested at render |
| Loading / layout shift | 8 | ListSkeleton adopted by 16 pages; HomePage has bespoke placeholders |
| Dark mode | 7 | Real, token-driven, cleverly patched — but the page header on every screen likely doesn't flip |
| Focus & keyboard | 4 | Token-level focus-visible is good; the Modal is a keyboard trap-door |
| Accessibility basics | 5 | 101 aria-labels, reduced-motion exemplary; contrast failures are systemic |
| Motion & micro-interaction | 9 | Best-in-class for this stage; documented, gated, performance-budgeted |

---

## 1. Design-token adoption — the token system is mostly fiction (HIGH)

### 1.1 `design-tokens.ts` is dead code except for currency metadata — HIGH (misleading system-of-record)

`src/lib/design-tokens.ts` declares itself "HISAAB DESIGN TOKEN SYSTEM / Premium micro-SaaS fintech design language" (design-tokens.ts:1-4) and exports `colors`, `gradients`, `shadows`, `spacing`, `radii` (design-tokens.ts:7-186). **Every one of the 20 files importing it imports only `currencyMeta`** — verified by grepping all importers: 20/20 are `import { currencyMeta } from '../lib/design-tokens'` (e.g. AccountCard.tsx:5, HomePage.tsx:72, QuickEntry.tsx:40). The `colors`/`gradients`/`shadows`/`spacing`/`radii` exports have **zero consumers**.

Worse, the dead token file *contradicts* the live palette: it defines expense as red `#ef4444` and income as `#10b981` (design-tokens.ts:31-36, 22-28), while the live Sukoon palette in index.css explicitly rules that money-out is "warm coral, NOT red" `#D9614A` and money-in is forest green `#0F9D7B` (index.css:55-60, 48-53, and the rationale at index.css:19-24). A new engineer reading the "token system" file will ship the wrong colors.

### 1.2 The CSS component-token layer is largely unadopted — and its comments lie about it — HIGH (drift)

index.css:5-9 claims `card-premium`/`btn-gradient`/`cta-primary` have "155+ call sites." Actual census across all of `src/` (`*.tsx`):

| Token class | Claimed/intended status | Actual call sites |
|---|---|---|
| `.card-premium` (index.css:899-916) | "155+ call sites" (index.css:7-8) | **0** |
| `.card-base` / `.card-interactive` (index.css:1170-1182) | canonical replacement | **0** |
| `.row-card` (index.css:1207-1213) | canonical row | **0** |
| `.chip-base` / `.chip-selected` (index.css:1265-1290) | canonical chip | **0** |
| `.chip-status` (index.css:1477-1486) | status pill | **0** |
| `.toggle-row` (index.css:1298-1308) | toggle rows | **0** |
| `.state-hint-info/warn/error` (index.css:1125-1150) | advisory banners | **0** |
| `.page-shell` (index.css:1428-1435) | every route wrapper | **0** |
| `.glass` (index.css:881-885) | glassmorphism | **0** |
| `.btn-gradient` (index.css:981-998) | gradient CTA | 1 (Button.tsx:22 `gradient` variant) |
| `.cta-destructive` | destructive CTA | 2 |
| `.cta-secondary` | secondary CTA | 5 |
| `.nav-icon-button` | header icon buttons | 10 |
| `.cta-primary` | primary CTA | 23 |
| `.selector-base` | entry-modal selectors | 31 |
| `.input-field` | form inputs | 65 |
| `.press*` ladder (index.css:351-357) | tap feedback | 125 |

So roughly **550 lines of index.css (the Phase A/D1/E1/F1 "canonical token" blocks plus card-premium/glass/mesh) style classes that nothing renders**, and the dark-mode section spends rules overriding them (`html.dark .card-base, .card-premium, .chip-base, .row-card…` at index.css:170-193). Meanwhile the real UI is written in raw utilities: 273 `bg-cream-card` + 140 `bg-white` + 1,353 `ink-*` utilities. The migration got far on *colors* (only 18 stray `slate-*` utilities remain in tsx) but the *component* abstraction never landed. Several blocks honestly say "Introduced, NOT yet adopted" (index.css:1156, 1316, 1418) — but "card-premium 155+ call sites" (index.css:7-8) is false today, and dead styling layers are exactly where the next visual regression hides.

**Severity: HIGH** (as engineering risk, not user harm): the stated design system and the shipped design system are different artifacts, and both the TS and CSS halves contain live-looking dead code with incorrect self-documentation.

### 1.3 Arbitrary-value census — the utility layer is the real (untyped) token system — MEDIUM

- **1,295 arbitrary font-size utilities** (`text-[Npx]`) across pages+components, spanning **21 distinct pixel values** (366× `text-[11px]`, 300× `text-[12px]`, 265× `text-[13px]`, 179× `text-[10px]`, 53× `text-[14px]`, down to single uses of `text-[19px]`, `text-[26px]`, `text-[54px]`, `text-[64px]`), plus 136 standard `text-xs…text-4xl` utilities — ~29 sizes in practice.
- **432 other arbitrary bracket values** on width/height/padding/radius/etc.
- **94 arbitrary radii** (`rounded-[18px]` ×75, `rounded-[20px]` ×9, plus one-offs `rounded-[17px]`, `[21px]`, `[27px]`, `[28px]`, `[30px]`, `[40px]`) alongside the documented radius ladder that tops out at 24px (design-tokens.ts:179-186). `rounded-[18px]` is clearly the *de facto* card radius (ListSkeleton.tsx:25, HomePage.tsx:549) — it exists in no ladder.
- **56 hardcoded hex colors in 19 tsx files** (38 distinct values).

The saving grace: the *distribution* is consistent. 11/12/13px captions, 14-15px body, `rounded-2xl`/`rounded-[18px]` cards. The system exists — it just lives as memorized numbers instead of tokens, which is exactly how the 21-size drift happened.

---

## 2. Typography — coherent voice, entropic scale — MEDIUM

- Weights are disciplined: 772 `font-semibold`, 331 `font-bold`, 126 `font-medium`, 14 `font-extrabold`, 5 `font-normal` — effectively a 3-weight system. Good.
- Geist with Inter fallback is declared twice (index.css:86, 861) with a sensible rationale for numeral continuity (index.css:82-86).
- **Sizes below the repo's own legibility floor:** the `.chip-status` token documents "The 10px floor keeps chip text legible per the Sukoon a11y bar" (index.css:1476-1477). Yet there are **23 `text-[9px]` and 2 `text-[8px]` call sites**, e.g. metadata dates at `text-[9px] text-ink-500` (GroupDetailPage.tsx:885), section labels "Paid total"/"Share total" at `text-[9px]` (GroupDetailPage.tsx:965, 969), a `text-[9px] text-ink-400` slot label (KametiDetailPage.tsx:300), an unread badge at `text-[9px]` (InboxPage.tsx:882), and an 8px badge (HisaabAIPage.tsx:634). On a 320-360px Android at default DPI these render at ~6-7 physical pt. **Severity: MEDIUM** (legibility for the app's stated audience — older Urdu-speaking family members — see docs/ux-audit-first-time-user-2026-07.md's audience framing).
- Untranslated hardcoded English inside the ur-default UI: "Paid total"/"Share total" (GroupDetailPage.tsx:965, 969), "No accounts yet" (HomePage.tsx:903-905), the "Hisaab AI" tab label (BottomNav.tsx:37 — arguably a brand name). LOW here; the i18n phase owns the full sweep.

---

## 3. Color — semantics are genuinely good; three greens and a leaked red — MEDIUM

**The good:** money direction is centralized in one semantic map — `TransactionItem.tsx:35-62` maps every transaction type to `text-receive-text`/`bg-receive-50` or `text-pay-text`/`bg-pay-50`, and the amount row renders sign + color together (TransactionItem.tsx:211-212). The palette rationale (coral not red, "so dozens-per-week 'you owe' reads don't feel emotionally taxing", index.css:19-24) is a real product decision encoded in CSS. A negative net worth gets a non-color cue (down-caret + word) so it "never relies on the minus sign alone" (HomePage.tsx:926-929). Charts use the correct Sukoon hexes (AnalyticsPage.tsx:316-317: `#0F9D7B` / `#D9614A`).

**The leaks:**
1. **GroupDetailPage still runs the pre-Sukoon palette:** ProgressRing colors `#10b981` (old green) and `#6366f1` (old indigo) at GroupDetailPage.tsx:685-686, and — directly violating the "coral, NOT red" rule — **rose `#f43f5e`** for negative balances at GroupDetailPage.tsx:915. So the group screen's money-out red differs from every other screen's coral.
2. **Three unrelated greens mean "positive":** Sukoon `#0F9D7B` (index.css:51), auth success-check `#12B48C` (AuthPage.tsx:351, 371, 392), legacy `#10b981` (GroupDetailPage.tsx:685). Plus WhatsApp brand `#1FA855` (used consistently, 4 sites, e.g. ContactDetailSheet.tsx:469 — that one is legitimate).
3. **`Button.tsx` never migrated:** primary/ghost variants are `bg-indigo-600`/`text-indigo-600` (Button.tsx:16, 20) — old-brand indigo, not `accent-600` violet — so shared-Button CTAs and `.cta-primary` CTAs (index.css:1056, indigo gradient) render a *different* primary color than the accent-violet FAB (BottomNav.tsx:75-77) and `.auth-cta`. Two primary-action colors coexist app-wide. MEDIUM.
4. Residual old-palette text utilities are nearly gone (5 total: `text-red-*` ×4, `text-emerald-600` ×1) — the bulk swap clearly happened.

---

## 4. Contrast — systemic small-text failures against the repo's own tokens — HIGH

Computed from the palette hexes defined at index.css:35 (cream `#F4F2EC`), :65-67 (ink), :53 (receive-text), :60 (pay-text):

| Pairing | Ratio | WCAG AA (normal text 4.5:1) | Usage |
|---|---|---|---|
| `text-ink-400` (#A8AABD) on cream-bg | **2.05:1** | FAIL (fails even 3:1 large-text) | 134 call sites; **38 of them at 9-11px** (e.g. KametiDetailPage.tsx:300) |
| `text-ink-400` on white card | 2.30:1 | FAIL | (subset of above) |
| `text-ink-500` (#7E809A) on cream-bg | **3.45:1** | FAIL for normal text | the app's default secondary-text color, hundreds of sites (e.g. GroupDetailPage.tsx:885 at 9px) |
| `text-receive-text` (#0F8466) on cream | 4.16:1 | FAIL at <18px/non-bold | the money-in amount color (TransactionItem.tsx:211 at 14px semibold — bold helps but 4.16 < 4.5) |
| `text-pay-text` (#C45339) on cream | 4.04:1 | FAIL at small sizes | the money-out amount color |
| `text-warn-600` (#C28E1A) on warn-50 | **2.64:1** | FAIL | 68 `text-warn-600` sites; the palette even *added* `warn-700` "for TEXT on warn-50 — passes WCAG AA (~5.5:1)" (index.css:78) yet warn-600 is still used as text on warn-50 chips (AccountDetailPage.tsx:603, 674) |

The team demonstrably knows how to do this — AuthPage documents per-word ratios (AuthPage.tsx:16-24), the dark-mode `.auth-cta` flatten exists purely to hold AA (index.css:236-241), and white/50-on-navy clears 5.2:1. But the *cream body* — where users read 90% of the time — pairs its two most common muted text tokens at 2.05:1 and 3.45:1. **Severity: HIGH** (a11y for a mass-market audience including older users; also a Play-listing risk if accessibility review is run). Fix is cheap: darken `ink-400`/`ink-500` two steps for text use, or ban `ink-400` as a text color.

Note: ratios are for light mode; the dark ramp (index.css:127-134) needs its own computed pass.

---

## 5. Spacing & alignment — real rhythm, moderate entropy — MEDIUM-LOW

- Card padding is disciplined: `p-4` ×117, `p-3` ×69, `p-3.5` ×45, `p-5` ×19 — matches the documented ladder (design-tokens.ts:124-134).
- Gaps concentrate on `gap-2`/`gap-1.5`/`gap-3` (269/146/116) — consistent.
- Horizontal page gutters are *not* consistent with the documented canon: the ladder says `px-5` is canonical (design-tokens.ts:150), but the census shows `px-4` ×106 vs `px-5` ×83 vs `px-3` ×83 — ten distinct `px-*` values in play. Since the doc ladder in design-tokens.ts is unenforced prose (§1.1), drift is unchecked. LOW-MEDIUM.
- Radius is bimodal `rounded-2xl` (379) / `rounded-xl` (306) with `rounded-[18px]` (75) as an undocumented third card radius — three near-identical radii (16/18/20px) will read as subtly mismatched corners when cards sit adjacent. LOW, but it's the classic "why does this feel off" bug.

---

## 6. Overflow risk — well defended, one structural unknown — LOW-MEDIUM

- 117 `truncate` + 136 `min-w-0` (the flexbox truncation prerequisite — its presence at this count means someone actually understands why truncate fails in flex rows). Header title truncates (PageHeader.tsx:36, Modal.tsx:84).
- **Big-amount guard:** MoneyDisplay counts digits and steps the hero size ×0.82 above 9 digits "so the number doesn't clip the navy hero" for billion-PKR amounts (MoneyDisplay.tsx:41-46). Only 3 `break-words/all` sites, so free-text notes rely on truncate.
- **Roman-Urdu length risk is real and quantified:** parsing all 1,740 `{ur, en}` string pairs in src/lib/i18n.ts, **57% of Urdu strings are longer than their English counterpart**, with worst-case deltas of +26 to +55 characters (e.g. the linked-contact explainer, the insufficient-funds error "…Jitnay aap nay likhay hain, itnay pesay nahi hain."). Buttons and chips sized visually against English (`text-[10px]` chips, fixed-height rows like BottomNav's `h-[62px]` grid, BottomNav.tsx:58) are the exposure. Truncation handles lists; **multi-line wrapping of Urdu CTAs/banners inside fixed-height containers is untestable statically** — flagged for the rendered pass. MEDIUM (Urdu is the *default* language).

---

## 7. Layout shift & loading — strong — LOW

- `ListSkeleton` (skeleton-sweep, phase-offset rows, `aria-hidden`) is imported by **16 pages** (AccountsPage, ActivityPage, BudgetsPage, ContactsPage, GoalsPage, InboxPage, InvestmentsPage, KametiPage, LoansPage, SplitsPage, SubscriptionsPage, TransactionsPage, ConnectByCodePage, HoldingDetailPage, InsightDetailPage, RemittancesPage) — real adoption, not a showcase component.
- HomePage has bespoke placeholders sized to the real cards (HomePage.tsx:546-552 grid placeholders, :899-900 hero number placeholder) and suppresses the count-up while loading so "animating a placeholder to zero and back looks like the balance dropped" (AnimatedMoney.tsx:8-9, HomePage.tsx:924).
- Minor self-contradiction: ListSkeleton's comment argues `animate-pulse` "reads as stalled" (ListSkeleton.tsx:11-13), yet HomePage's placeholders use `animate-pulse` (HomePage.tsx:549-552, 900). Cosmetic inconsistency only. LOW.
- Only 4 pages use raw `animate-spin` spinners.

---

## 8. Dark mode — real and clever, with one likely every-screen bug — HIGH (pending render check)

Dark mode exists and is architected correctly: `themeStore.ts` supports light/dark/system with a `matchMedia` listener (themeStore.ts:7-51), toggling `html.dark`; the Sukoon tokens are overridden wholesale so utility classes flip automatically (index.css:116-162); the inverted-ink "dark primary button" hazard is fixed systemically with one rule covering "~70 buttons" (index.css:195-206); dark skeleton sweep is tuned down (index.css:434-441); the bottom nav reads a `--nav-surface` var precisely because "a plain rgba white can't flip in dark mode" (index.css:113-114, BottomNav.tsx:46-53). Zero `dark:` prefixes in tsx — everything flips via tokens. This is the right design.

**But `PageHeader` — the sticky header on essentially every screen — hardcodes the light surface as an inline style:** `background: 'rgba(244, 242, 236, 0.9)'` (PageHeader.tsx:20-24). Inline styles beat the `html.dark` stylesheet, and unlike `.modal-header` (which gets an explicit dark override at index.css:189) there is no rule that can reach it. **In dark mode the app body goes near-black while every page's header should stay glowing cream with dark-illegible… actually cream with `text-ink-800` text, where ink-800 flips to near-white (#E6E6EF, index.css:133) — near-white title on cream ≈ unreadable.** The BottomNav comment proves the team knew this class of bug and fixed it for the nav but not the header. **Severity: HIGH pending render verification** (if confirmed on device: every dark-mode screen; if something re-renders it I couldn't see statically, downgrade).

Also: 76 other inline `style={{}}` blocks exist; most are safe (gradients on always-dark navy), but each is outside the dark-token reach and should be swept once.

---

## 9. Focus, keyboard & modal semantics — the biggest interaction gap — HIGH

**The shared `<Modal>` (Modal.tsx:71-103) — container for ~40 create/edit flows — has:**
- no `role="dialog"` / `aria-modal` (the codebase's *only* `role="dialog"` is on DailyQuote.tsx, which also has `aria-modal` + `aria-labelledby` — so the correct pattern exists 30 lines away and wasn't applied to the workhorse);
- **no focus trap and no initial focus move** — zero `focus()`/`autoFocus` management (grep across Modal.tsx / ConfirmDestructiveSheet.tsx: none). Tab walks the page *behind* the sheet; screen readers can read the covered page (background is not `aria-hidden`/`inert`);
- **no Escape-key handling** — the only Escape handlers in the app are three inline field-level ones (CategoryPicker.tsx:89, PhoneDiscoverySection.tsx:135, ContactDetailSheet.tsx:477). Android hardware back is handled via the uiStore modal stack (Modal.tsx:28-36) — good for the primary surface — but the PWA on desktop (usehisaab.com is a marketed surface) cannot close a modal from the keyboard except by tabbing to the X.

**The better news at token level:** `focus-visible` outlines are baked into the interactive tokens — `.selector-base` (index.css:1248-1251), `.chip-base` (1281-1284), `.nav-icon-button` (1467-1470), `.row-interactive` (1222-1225) — and `Button.tsx` composes `focus-visible:ring-2` (Button.tsx:42). The 54 `outline-none`-without-focus-visible hits are nearly all inputs pairing `focus:outline-none` with a `focus:ring-2` replacement (e.g. AccountDetailPage.tsx:759), which is acceptable. But hand-rolled `<button>`s in pages (the majority of interactive elements) mostly have neither ring nor outline suppression — they fall back to UA defaults, which is inconsistent but not invisible. Only 3 `tabIndex` uses app-wide; list rows that act as buttons are real `<button>`s in TransactionItem (TransactionItem.tsx:170 adds `tabIndex`/`role` correctly).

**Severity: HIGH** — for a launch-bound product, an untrappable, unlabeled, un-escapable modal is the single change with the widest a11y payoff.

## 10. Accessibility basics — mixed: exemplary motion, decent labeling, weak semantics — MEDIUM

- **Reduced motion is the best I've seen at this maturity:** one CSS gate covering every animation with per-animation *final-state* reasoning (index.css:451-471 — e.g. press keeps its scale because "a tap response is feedback, not decoration"), belt-and-braces JS guards (AuthPage.tsx:33, AppLoadingScreen.tsx:20), a shared `useReducedMotion` hook wired into the money count-up (useCountUp.ts:40-53), and vestibular-safe fallbacks for the bell (index.css:514-521) and kameti die (index.css:532-538).
- **Labels:** 101 `aria-label`s across 51 files; icon-only buttons in the chrome are covered (Modal close Modal.tsx:88, PageHeader back PageHeader.tsx:32, FAB "Quick entry" BottomNav.tsx:70). 7 `role="alert"`, 4 `role="status"`, `aria-pressed` on toggles (SettingsPage, TransactionItem), `aria-invalid`/`aria-describedby` on auth fields (AuthPage.tsx). This is above average. A page-by-page icon-button sweep will still find gaps (only ~51 of 120 files contain any aria attribute).
- **Touch targets:** 44px is treated as a floor in tokens (`.selector-base` min-height 44px index.css:1237; `.nav-icon-button` expands its 32px visual to ~44px hit area via `::before` inset -6px, index.css:1459-1463 — a genuinely good trick). No `<button className="w-6/w-7">` instances found. Chips at `py-1.5` (~30px tall) remain below 44px — normal for chips, worth a device check.
- **Contrast:** see §4 — this is where a11y actually fails today.

---

## Severity-tagged findings summary

| # | Severity | Finding | Key evidence |
|---|---|---|---|
| 1 | HIGH | Small-text contrast failures baked into the core palette: `ink-400` 2.05:1 (134 sites, 38 at ≤11px), `ink-500` 3.45:1 (default secondary text), `warn-600`-on-`warn-50` 2.64:1 (68 sites) despite `warn-700` existing for exactly this | index.css:35,65-67,78; KametiDetailPage.tsx:300; AccountDetailPage.tsx:603 |
| 2 | HIGH | Shared `<Modal>` lacks `role="dialog"`/`aria-modal`, focus trap, initial focus, and Escape handling — affects ~40 flows; correct pattern exists in DailyQuote.tsx but not here | Modal.tsx:71-103; DailyQuote.tsx (role=dialog/aria-modal) |
| 3 | HIGH (verify on device) | `PageHeader` hardcodes light cream inline background that cannot flip in dark mode, while its title color does flip → likely near-white-on-cream header on every dark-mode screen; team solved the same bug for BottomNav via `--nav-surface` | PageHeader.tsx:20-24; index.css:113-114,133; BottomNav.tsx:46-53 |
| 4 | HIGH (eng. risk) | The declared design system is dead code: `design-tokens.ts` colors/shadows/spacing/radii have 0 importers (only `currencyMeta` is used) and contradict the live palette (red vs coral); ~550 lines of index.css component tokens have 0 call sites; "155+ call sites" comment is false | design-tokens.ts:7-186,31-36; index.css:5-9,899,1011-1487; adoption census §1.2 |
| 5 | MEDIUM | Typography entropy: 1,295 arbitrary `text-[Npx]` across 21 px values (~29 sizes total); 25 sites at 8-9px below the repo's own documented 10px floor | census §1.3; index.css:1476-1477; GroupDetailPage.tsx:965; HisaabAIPage.tsx:634 |
| 6 | MEDIUM | Palette leaks: GroupDetailPage uses rose `#f43f5e` (violates "coral NOT red") and legacy `#10b981`/`#6366f1`; `Button.tsx` primary is old indigo, not accent violet → two primary-action colors app-wide; three distinct "positive" greens | GroupDetailPage.tsx:685-686,915; Button.tsx:16,20; index.css:19-24 |
| 7 | MEDIUM | Roman-Urdu (default language) strings are longer than English in 57% of 1,740 pairs (worst +55 chars) with fixed-height chips/nav sized against English — wrapping behavior unverifiable statically | src/lib/i18n.ts (parsed census §6); BottomNav.tsx:58 |
| 8 | MEDIUM | Money amount colors `receive-text` 4.16:1 / `pay-text` 4.04:1 sit just under AA for the 14px semibold amounts they color | index.css:53,60; TransactionItem.tsx:211 |
| 9 | LOW-MEDIUM | Spacing/radius drift: 10 `px-*` gutter values vs documented `px-5` canon; undocumented `rounded-[18px]` as third card radius (16/18/20px coexist) | design-tokens.ts:147-167; census §5; ListSkeleton.tsx:25 |
| 10 | LOW | Skeleton philosophy self-contradiction (HomePage uses `animate-pulse` the ListSkeleton comment condemns); hardcoded English strings on ur-default screens | ListSkeleton.tsx:11-13 vs HomePage.tsx:549; GroupDetailPage.tsx:965,969; HomePage.tsx:903-905 |

**Credits (things better than the 6.5 suggests):** the motion system + reduced-motion discipline (index.css:284-471), MoneyDisplay's digit-count overflow guard (MoneyDisplay.tsx:41-46), semantic money-color centralization (TransactionItem.tsx:35-62), ListSkeleton adoption across 16 pages, `min-w-0` fluency (136 uses), tap-target expansion via `::before` (index.css:1459-1463), AnimatedMoney's re-render isolation rationale (AnimatedMoney.tsx:13-23), safe-area handling (index.css:731-744, modal-footer 1381-1386), and the non-color liability cue (HomePage.tsx:926-929).

---

## Required rendered visual pass (not performed here)

This audit is code-level only. A device pass (small Android ~360×640 and 320px width, plus the PWA on desktop) must check:

1. **Dark mode, every route** — especially the PageHeader background (finding #3), modal headers, charts (Recharts hexes don't flip), and the 76 inline-style blocks.
2. **Contrast spot-checks with a meter** (or axe/Lighthouse) on cream-body screens — validate the computed ratios in §4 in both themes, including `text-white/40-55` on the navy hero (49 uses at /40-/50).
3. **Urdu (default) text at 320-360px** — CTAs, chips, BottomNav labels, banners: wrapping vs clipping in fixed-height containers; the +26 to +55-char worst-case strings from §6.
4. **Billion-PKR amounts** in list rows and cards (MoneyDisplay guards only the hero size path; `formatMoney` call sites in 14px rows, TransactionItem.tsx:211, are unguarded).
5. **Keyboard-only walkthrough on desktop PWA** — open a modal, attempt Escape, Tab through: confirm the trap-door in finding #2; check hand-rolled page buttons for visible focus.
6. **TalkBack pass** on QuickEntry numpad, kameti draw, and one full add-expense flow.
7. **Geist font failure mode** — offline/Capacitor first load (Google Fonts fetch; index.html) → confirm Inter/system fallback doesn't shift the tabular-nums money layout.
8. **Low-end Android WebView animation frame rate** — stagger-in lists, skeleton sweep, wisdom gradient (the one background-position animation, index.css:812-828).
9. **Notch/gesture-bar devices** — pt-safe/pb-safe utilities and modal footers.
10. **Tablet/desktop width** — the body is hard-capped at `max-width: 480px` centered (index.css:864-866); check what surrounds it on wide screens (currently the raw `#f8fafc` body — an old-palette color, index.css:862 — not cream).

## Evidence unavailable / further investigation

- **Rendered output on any device** — all layout/wrapping/contrast conclusions above are computed from source; ratios assume sRGB and no font-smoothing effects.
- **Dark-mode QA state** — no screenshots, no visual-regression tooling, and no e2e tests exist in the repo (vitest covers pure logic only, vitest.config.ts), so whether finding #3 was ever observed is unknowable from the repo.
- **Real font rendering of Geist** at 8-11px on Android WebView (hinting varies by device).
- **Whether the dead token layers are scheduled for deletion** — no TODO/issue tracker reference found in index.css or BACKLOG.md for removing them; tasks/lessons.md does not cover it.
- **Accessibility audits** — no axe/Lighthouse/pa11y config or CI step exists (.github/workflows/ci.yml runs tsc/eslint/vitest/build only).
