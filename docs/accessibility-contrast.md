# Accessibility — contrast fixes & Modal a11y contract

Scope: P2 item M3 (core half). Source findings: `docs/audit-2026-09/09-ui-quality.md`
finding #1 ("Design-token adoption"), finding #2 (Modal), §4 ("Contrast — systemic
small-text failures"), finding #3 (PageHeader dark mode), and
`docs/audit-2026-09/13-engineering-standards.md` §2.5 ("Accessibility maturity").

Math is done with WCAG 2.x relative luminance / contrast-ratio formulas, extracted
as pure functions in `src/lib/contrast.ts` (tested in `src/lib/contrast.test.ts`).
All ratios below were computed with that module (see the "regression guard" tests
for the exact fixed values pinned against drift).

Only **token values** were changed in `src/index.css` — no token was renamed, no
token was added to the color ramps, and hue/saturation were preserved wherever a
token was darkened/lightened (only lightness moved). One new CSS custom property
(`--header-surface`) was added, mirroring the existing `--nav-surface` pattern —
see item 3 below.

---

## 1. Light theme — before / after

| Token pair | Size class it's used at | Before | AA threshold | After | Passes? |
|---|---|---:|---:|---:|:---:|
| `ink-400` on `cream-bg` | Normal text (labels/amounts, mostly 9-13px — well under the 18.66px-bold "large text" cutoff) | 2.05:1 | 4.5:1 | **4.55:1** | ✅ |
| `ink-400` on `cream-card` (white) | Normal text | 2.30:1 | 4.5:1 | 5.10:1 | ✅ (was already the less-binding surface; bg is the constraint) |
| `ink-500` on `cream-bg` | Normal text (default secondary-text color, all sizes below 18.66px-bold) | 3.45:1 | 4.5:1 | **5.31:1** | ✅ |
| `ink-500` on `cream-card` | Normal text | 3.86:1 | 4.5:1 | 5.95:1 | ✅ |
| `warn-600` on `warn-50` | Normal text (badges/inline warnings, 68 call sites, e.g. `AccountDetailPage.tsx:603,674`) | 2.64:1 | 4.5:1 | **4.60:1** | ✅ |

**Hex changes (`src/index.css`, light `@theme` block):**

```
--color-ink-400:  #A8AABD → #696C8B
--color-ink-500:  #7E809A → #60627B
--color-warn-600: #C28E1A → #8D6813
```

Hue held at ~235° (ink) / ~40° (warn); only HSL lightness moved. The 300→900 ink
ramp stays monotonically darker (ink-300 lightest, ink-900 darkest) and ink-400 /
ink-500 remain visually distinct from each other and from their neighbors:

| Token | L (HSL) |
|---|---:|
| ink-300 | 81.8% |
| **ink-400 (new)** | 47.8% |
| **ink-500 (new)** | 42.9% |
| ink-600 (unchanged) | 40.0% |

Note `ink-400`/`ink-500` moved much closer to `ink-600` than they were — that's
the unavoidable consequence of both needing to individually clear 4.5:1 against
the same light background; there wasn't room to keep the old three-way spacing
and pass AA. They stay in the correct order and each is still a distinguishable
step.

`warn-700` (`#8A6410`, added in an earlier pass specifically "for TEXT on
warn-50" per its own code comment, but never adopted at the actual call sites)
is now close in value to the fixed `warn-600` — expected, since both now clear
the same AA floor against the same background. `warn-700` is unchanged and still
used at its one distinct call site (`GroupCard.tsx:116`, border + text on a
plain card background, not warn-50).

**Not changed (computed, already passing or out of this item's scope):**
- `ink-600` on `cream-bg`: 5.85:1 — already AA.
- `ink-300` on `cream-bg`: 1.45:1 — fails, but audited usage is decorative only
  (disclosure chevrons `<ChevronRight className="text-ink-300"/>`, "—" empty-value
  placeholders) — never real body text. Non-text UI components have a separate,
  lower WCAG bar (1.4.11, 3:1) that these arguably still miss for informative
  chevrons; flagged as a follow-up, out of this item's explicit scope
  (ink-400/ink-500 + warn-600/warn-50 per the task brief).
- `receive-text` (4.16:1) / `pay-text` (4.04:1) on `cream-bg`: both sit just
  under 4.5:1 at the 14px-semibold amount size the audit flagged
  (`TransactionItem.tsx:211`) — semibold (600) doesn't qualify as WCAG "bold"
  (≥700) and 14px is under the 18.66px large-text cutoff either way. Not in this
  item's explicit scope (only ink-400/ink-500/warn-600 were named); left as a
  known gap for a follow-up pass since fixing it changes the money-color
  semantics (`--color-receive-text`/`--color-pay-text`), which double as the
  chart colors and are a more product-sensitive change than the neutral ink
  ramp.

---

## 2. Dark theme — computed pass (all `ink-*`, receive/pay/warn semantic pairs)

The dark ramp's contrast had never been computed (audit note, §4). Full
computation against the dark **page background** `cream-bg` (`#131419`) and the
dark **card surface** `cream-card` (`#1E1F27`) — both matter in dark mode because,
unlike light mode, `cream-card` is *lighter* than `cream-bg` (a raised dark
surface), so it's the harder ("binding") constraint for light-colored text, not
the easier one:

| Token | vs dark `cream-bg` | vs dark `cream-card` | AA (4.5:1) | Action |
|---|---:|---:|:---:|---|
| `ink-200` | 1.35:1 | 1.20:1 | fail | Unchanged — decorative only (surfaces/borders, drag-handle fill), never text. |
| `ink-300` | 1.74:1 | 1.55:1 | fail | Unchanged — decorative only (chevrons/placeholders), same as light ramp. |
| `ink-400` | 3.62:1 | 3.23:1 | **fail** | **Fixed** → `#7B7D93`... see below (card-binding retarget) |
| `ink-500` | 6.01:1 | 5.36:1 | pass | Unchanged. |
| `ink-600` | 9.17:1 | 8.17:1 | pass | Unchanged. |
| `ink-700` | 12.02:1 | 10.71:1 | pass | Unchanged. |
| `ink-800` | 14.83:1 | 13.22:1 | pass | Unchanged. |
| `ink-900` | 16.91:1 | 15.08:1 | pass | Unchanged. |
| `receive-text` | 10.06:1 | — | pass | Unchanged. |
| `pay-text` | 8.26:1 | — | pass | Unchanged. |
| `warn-600` on `warn-50` | 6.90:1 | — | pass | Unchanged. |
| `warn-700` on `warn-50` | 8.95:1 | — | pass | Unchanged. |
| `receive-600` on `receive-50` | 6.21:1 | — | pass | Unchanged. |
| `receive-700` on `receive-50` | 3.83:1 | — | **fail, but unused as text** — see note. |
| `pay-600` on `pay-50` | 5.57:1 | — | pass | Unchanged. |
| `pay-700` on `pay-50` | 3.79:1 | — | **fail, used as text** | **Fixed** → `#CA6752` |

### `ink-400` (dark) — fixed, card-binding

`ink-400` is used as real body text at hundreds of call sites (same audit
pattern as the light ramp — labels, amounts, timestamps). First pass targeted
only `cream-bg` (→ `#7B7D93`, 4.55:1 on bg) but that left the *card* surface at
only 4.06:1 — still failing, because `cream-card` (#1E1F27) is lighter than
`cream-bg` (#131419) in dark mode, so a light-toned `ink-400` gets **less**
contrast against the card, not more (the opposite of light mode, where the
white card is the easy case). Retargeted against the card (the actual binding
constraint):

```
--color-ink-400 (dark): #6B6D82 → #848699
```

Result: 4.57:1 on `cream-card`, 5.12:1 on `cream-bg` — both clear AA. Ramp order
preserved: ink-300 (26.7% L) < ink-400 new (55.9% L) < ink-500 (61.2% L) <
ink-600 (74.5% L).

### `pay-700` (dark) — fixed

Used as text at one real call site, `BudgetsPage.tsx:154-155` (the over-budget
pill: `text-pay-700 bg-pay-50`). In dark mode this pairing was 3.79:1, failing
AA.

```
--color-pay-700 (dark): #C2543C → #CA6752
```

Result: 4.56:1 on dark `pay-50`. `pay-600` (5.57:1) and `pay-text` (8.26:1)
already cleared AA and are unchanged.

### `receive-700` (dark) — computed, left unchanged

3.83:1 against `receive-50`, technically failing — but grepping every usage of
`receive-700` in the codebase shows it is **only** ever used decoratively
(`bg-gradient-to-r from-receive-600 to-receive-700` in `GoalsPage.tsx:520` and
`UserAvatar.tsx:14`, both gradient fills, never `text-receive-700` on
`bg-receive-50`). No text-on-background pairing actually exists at this ratio
today, so it was left as-is rather than darkening a token that's never read as
text (which would just make the gradient direction less deep for no a11y gain).
Flagged here so a future `text-receive-700 bg-receive-50` usage doesn't ship
unnoticed.

---

## 3. PageHeader — token-driven dark-mode background

`PageHeader.tsx` set its sticky header's translucent cream background as a
literal inline `rgba(244, 242, 236, 0.9)` (audit finding #3, §8: "the sticky
header on essentially every screen hardcodes the light surface... in dark mode
the app body goes near-black while every page's header should stay glowing
cream"). Inline styles always win over any stylesheet rule, including
`html.dark` overrides, so no CSS-side fix could reach it — the same problem the
codebase already solved once for `BottomNav` via a `--nav-surface` custom
property (`index.css:129`, referenced from an inline style in `BottomNav.tsx`).

Applied the identical pattern: added `--header-surface` next to `--nav-surface`
in `src/index.css` (`:root` + `html.dark` block), and pointed `PageHeader.tsx`'s
inline `background` at `var(--header-surface)` instead of the literal rgba.
`backdropFilter`/`WebkitBackdropFilter` are unchanged.

```css
:root      { --header-surface: rgba(244, 242, 236, 0.9); }
html.dark  { --header-surface: rgba(19, 20, 25, 0.9); }
```

**Render-unverified.** This is a code-level fix matching the audit's own
prescribed pattern and the identical values `.modal-header` already uses per
theme, but per this item's brief it still needs an actual dark-mode device/PWA
check — no visual-regression tooling exists in this repo (see
`docs/audit-2026-09/13-engineering-standards.md` §2.7).

---

## 4. Modal — accessibility contract

`src/components/Modal.tsx` (the shared bottom-sheet modal used by ~40
create/edit flows) previously had no `role="dialog"`, no `aria-modal`, no focus
trap, no initial-focus move, no Escape handling, and no focus restoration
(audit finding #2, `09-ui-quality.md` §9; `13-engineering-standards.md` §2.5).
Fixed:

- **`role="dialog"` + `aria-modal="true"`** on the visible sheet (`.modal-sheet`
  div), not the full-screen backdrop wrapper (which is a decorative
  click-catcher only).
- **`aria-labelledby`** wired to the title `<h2>` via a `useId()`-generated id.
  An optional `ariaLabel` prop overrides this for the rare caller whose visible
  `title` text isn't a good standalone accessible name.
- **Focus trap**: Tab/Shift+Tab cycle within the dialog's focusable elements;
  wrapping past the first/last element loops to the other end. If the dialog
  has no focusable descendants, focus (and the trap) falls back to the dialog
  container itself (`tabIndex={-1}`).
- **Initial focus**: moves to the first focusable element inside the dialog on
  open (falls back to the dialog container if none exists), after one
  `requestAnimationFrame` so it lands once the entering sheet has mounted.
- **Escape → close**, routed through the same `requestClose()` used by the
  backdrop tap and the X button — so it respects an in-flight `confirmClose`
  guard (used by several callers to block dismissal on unsaved changes) exactly
  like every other dismissal path. There is no "destructive confirm that
  shouldn't close on Escape" case to special-case: `ConfirmDestructiveSheet`
  does **not** render inside `<Modal>` — it's a separate imperative
  full-screen sheet (its own zustand store) that already has its own Escape
  story via `useBackStackLayer(open, () => answer(false), 'confirm-sheet')`
  (unchanged, read-only reference for this item).
- **Focus restoration**: the element focused immediately before the modal
  opened is remembered and refocused on close, if it's still attached to the
  document.

### Back-stack / hardware-back coordination — the rule

Three independent "close the topmost dialog" signals exist in this app. Modal
now participates in (or coexists with) all three without ever double-closing:

1. **Capacitor hardware back** (native only, unchanged) —
   `src/lib/nativeBridge.ts`'s `backButton` listener calls
   `useUIStore.getState().closeTopModal()`, which pops the last handler off
   `uiStore.modalStack` directly (in-memory stack). It never touches
   `window.history`.
2. **Browser/PWA back** (`useBackStackLayer`, new in this item) — covers the
   desktop/web surface, which has no hardware back button (this is the
   audit's MF-08 follow-up named in the task). Each `Modal` **instance** gets
   its own history layer tag, `` `modal-${titleId}` `` (from `useId()`),
   instead of the literal `'modal'` example in the task brief. This is a
   deliberate deviation: Modals **do** nest in this app (the existing
   scroll-lock effect's own comment already accounts for "a nested sheet
   closing, e.g. the WhatsApp reminder over the Hisaab check"), and
   `useBackStackLayer`'s popstate matching treats "landed on a history entry
   that still carries MY tag" as a no-op — two Modal instances sharing one
   literal tag would silently swallow the back press instead of closing the
   topmost one (verified by tracing `isLayerState`/`withLayer` in
   `src/lib/backStackLayer.ts` against a 2-deep stack). Unique per-instance
   tags make each instance react only to the popstate that removed **its own**
   pushed entry, which — because pushes/pops are LIFO — is always the
   topmost modal. No extra coordination with `uiStore.modalStack` is needed
   for this path to be correct.
3. **Escape key + the Tab focus trap** (new in this item) — both are wired
   through one `document` keydown listener per open Modal instance. Unlike
   (2), there's no per-instance browser signal to key off here — every open
   modal's listener fires on every keypress — so each instance checks whether
   **its own** registered close handler is the top entry of
   `uiStore.modalStack` (the *same* stack (1) reads and mutates) before
   reacting, and no-ops otherwise. This reuses the app's one existing
   definition of "topmost modal" instead of inventing a second one, and keeps
   Escape/Tab consistent with hardware back: whichever modal hardware-back
   would close is also the one Escape closes and the one Tab stays trapped
   inside.

**Net rule:** a given close signal (hardware back / browser back / Escape)
always closes exactly the topmost open Modal, and the three mechanisms cannot
double-fire for the same key press or gesture, because they listen to disjoint
event sources — an in-memory stack pop, a `popstate` scoped by a unique
per-instance history tag, and a `document` keydown gated by that same
in-memory stack's top entry.

### App-root `inert`/`aria-hidden` — not implemented (documented per the task's escape clause)

`Modal` renders in-place in the React tree (no `createPortal`) at ~40 different
call sites — some nested deep inside a page's own component tree, some
stacked with another already-open Modal. Marking the app root (`#root`)
`inert`/`aria-hidden` while a modal is open would inert the modal's own DOM
too, since it is a *descendant* of `#root`, not a sibling. There is no single
stable "everything except the modal" container to target without either:

- portal-izing `Modal` (rendering it via `createPortal` into a sibling of
  `#root`) — a structural rewrite of the component's rendering model, which
  is out of this item's "no structural rewrites" boundary and would need its
  own review (stacking/z-index, CSS containment, and the `document.body`
  scroll-lock interaction all get re-verified), or
- auditing all ~40 call sites' surrounding DOM to find a per-page container to
  hide — unsafe to do blind, and would need re-doing every time a new call
  site is added.

The focus trap covers the practical keyboard-user risk (Tab cannot reach the
covered page while a modal is open). A screen-reader user driving a virtual
cursor (not Tab) could still swipe into background content while a modal is
open. **Flagged as a follow-up requiring a portal-based Modal** — a good
candidate for a future, separately-scoped item.

---

## 5. What this item did NOT do (explicitly out of scope / owned elsewhere)

- **`lang` attribute following the active language** (`index.html` hardcodes
  `lang="en"` on a Urdu-default app — `13-engineering-standards.md` §2.5).
  Owned by the i18n agent working concurrently in this same pass; this item
  does not touch `src/lib/i18n.ts` or `index.html`.
- **`eslint-plugin-jsx-a11y` + an axe/Lighthouse-a11y CI check** — no a11y
  linting or automated contrast/ARIA checks exist in `.github/workflows/ci.yml`
  or `eslint.config.js` today. Both are owned elsewhere per this item's file
  boundaries (`eslint.config.js` is explicitly out of scope for this agent).
- **A real TalkBack (Android screen reader) pass and a keyboard-only desktop
  PWA walkthrough on a live build.** Everything in this document is a
  code-level fix verified by `npx vitest run`, `tsc -b`, `eslint`, and
  `npm run build` — none of it is a substitute for the device pass the audit
  explicitly calls out as still required (`09-ui-quality.md`, "Required
  rendered visual pass," items 2 and 5).
- **`text-ink-300`/`text-ink-200` non-text (icon) contrast** and
  **`receive-text`/`pay-text` normal-size AA** — computed and documented above
  as known gaps, but not in this item's named token list (`ink-400`,
  `ink-500`, `warn-600`-on-`warn-50`), so left unchanged rather than risking an
  unreviewed change to the money-color semantics or icon visual weight.
- **`GroupDetailPage`'s pre-Sukoon palette leak** (rose `#f43f5e`, old green
  `#10b981`/indigo `#6366f1` — finding #6 in `09-ui-quality.md`) — a
  page-level fix (`src/pages/GroupDetailPage.tsx`), out of this item's file
  ownership (pages are explicitly off-limits for this agent).

---

## Verification run for this item

- `npx vitest run` — full suite passes except 6 pre-existing failures in
  `SplitWithSheet.test.tsx`, `TransactionItem.test.tsx`, and `inboxInfo.test.ts`
  — all i18n-string assertion mismatches in files this item never touched
  (`git status` confirms only `src/components/Modal.tsx`,
  `src/components/PageHeader.tsx`, `src/index.css`, `src/lib/contrast.ts`, and
  `src/lib/contrast.test.ts` were changed by this agent), caused by a
  concurrently-running i18n agent editing `src/lib/i18n.ts` in the same working
  tree.
- `npx vitest run src/lib/contrast.test.ts` — 15/15 pass (generic WCAG math +
  a regression guard pinning every fixed token's new hex against its AA
  threshold).
- `npx tsc -b --noEmit` — clean.
- `npx eslint src/components/Modal.tsx src/components/PageHeader.tsx src/lib/contrast.ts src/lib/contrast.test.ts` — clean.
- `npm run build` — production build succeeds.

---

## 6. M3 remainder — jsx-a11y lint, axe-in-CI, `lang` attribute

This section covers the rest of M3 (item 5's two "owned elsewhere" bullets
above, plus the `lang` attribute): `eslint-plugin-jsx-a11y`, an axe-core
Playwright suite wired into CI, and the runtime fix for `index.html`'s
hardcoded `lang="en"`. File ownership for this pass: `package.json` +
`package-lock.json`, `eslint.config.js`, `e2e/a11y.spec.ts` (new),
`.github/workflows/e2e.yml`, `src/lib/i18n.ts` (only the `setLang`/initial-
language code path), this doc, and tests — `src/pages/**`, `src/components/**`,
`src/stores/**`, `supabaseDb.ts`, any `supabase-*.sql`, `src/App.tsx`,
`vite.config.ts`, `index.html` were off-limits (other agents' concurrent work).

### 6.1 `eslint-plugin-jsx-a11y`

Installed `eslint-plugin-jsx-a11y@6.10.2` (exact, `npm install --save-dev
--save-exact`; peers on `eslint ^3‒^9`, so it's compatible with this repo's
ESLint 9 flat config). Wired into `eslint.config.js`, scoped to
`src/pages/**/*.tsx` + `src/components/**/*.tsx` (same file scope as the
existing i18n `no-restricted-syntax` block), as a second config object in the
`defineConfig([...])` array — `plugins: { 'jsx-a11y': jsxA11y }`, with
`languageOptions.parserOptions.ecmaFeatures.jsx = true`.

Rule severities: started from `jsxA11y.flatConfigs.recommended.rules` (every
rule "error" except a few already "off" — `anchor-ambiguous-text`,
`control-has-associated-label`, `label-has-for`), then **downgraded every
"error" rule to "warn" except a named critical subset**, which stays "error":

```
jsx-a11y/alt-text
jsx-a11y/aria-props
jsx-a11y/aria-role
jsx-a11y/role-has-required-aria-props
jsx-a11y/label-has-associated-control
jsx-a11y/click-events-have-key-events
jsx-a11y/no-static-element-interactions
```

`jsx-a11y/no-noninteractive-element-interactions` (the task brief's "?" rule)
was evaluated and left at **warn**, not promoted to the critical/error list:
a scoped lint run showed its violations are the same backdrop-click-catcher
shape `no-static-element-interactions` (already critical) already catches at
every one of the same call sites — promoting it too would not add new
blocking coverage, just duplicate errors on files this agent cannot edit.

The severity split is computed in code (`A11Y_CRITICAL_RULES` +
`a11ySeverityOf`/`a11yAsWarn` helpers in `eslint.config.js`), not hand-copied,
so a future `eslint-plugin-jsx-a11y` bump that adds/removes recommended rules
stays consistent automatically.

### 6.2 Per-file ignore list (`A11Y_SWEEP_TODO`)

Same ratchet pattern as `I18N_SWEEP_TODO`: `npm run lint` came up with **33
errors across 8 files** the first time the critical rules were wired in, all
in `src/pages/**`/`src/components/**` — off-limits for this agent to edit.
Every single one is the *same* underlying shape: a full-screen
`<div onClick={...}>` used as a backdrop click-catcher (dismiss a sheet/menu/
dialog on outside-click), or its `stopPropagation()` sibling, with no keyboard
handler and no interactive role — `click-events-have-key-events` +
`no-static-element-interactions` fire as a pair on the same line. (This is
the exact pattern §4 above already calls "a decorative click-catcher only"
for `Modal.tsx`'s own backdrop — Escape-to-close + the focus trap on the
dialog body is the real accessible path, not a keyboard handler on the
backdrop div.) The real fix per site is `role="presentation"` on that div
(removing it from the a11y tree, since it carries no content), a
page/component-level change out of this pass's file ownership.

| File | Errors | Rule pair | Call sites |
|---|---:|---|---|
| `src/components/ConfirmDestructiveSheet.tsx` | 4 | click-events-have-key-events + no-static-element-interactions | backdrop div (L125) + its stopPropagation() sibling (L127) |
| `src/components/ConfirmationSheet.tsx` | 4 | same pair | backdrop div (L70) + sibling (L72) |
| `src/components/DailyQuote.tsx` | 2 | same pair | backdrop div (L70), inside an already `role="dialog"` wrapper |
| `src/components/Modal.tsx` | 3 | same pair (2) + click-events-have-key-events alone (1) | shared backdrop div (L247, L249) — see §4 above |
| `src/components/ReceiptField.tsx` | 2 | same pair | image-viewer backdrop (L136) |
| `src/pages/AccountDetailPage.tsx` | 14 | same pair × 7 sites | overflow-menu scrim (L353) + 3 inline centred-dialog backdrops — rename/card-settings/balance-correct (L757-879) |
| `src/pages/GoalsPage.tsx` | 2 | same pair | per-goal overflow-menu scrim (L462) |
| `src/pages/LoanDetailPage.tsx` | 2 | same pair | overflow-menu scrim (L389) |
| **Total** | **33** | | **8 files** |

With those 8 files ignored for the a11y rule block only (not for the i18n
rule — the two ignore lists are independent), `npm run lint` exits **0** with
**25 warnings** remaining (all `jsx-a11y/no-autofocus` — 24, on modal/sheet
first-field inputs — plus 1 pre-existing `react-hooks/exhaustive-deps` in
`RepaymentModal.tsx`, unrelated to this rule). `no-autofocus` firing 24 times
is itself informative: this app's bottom-sheet pattern relies on
`autoFocus` heavily for its "sheet opens, keyboard is already up" feel —
worth a deliberate product/a11y trade-off discussion before touching, not a
mechanical fix, which is why it's "warn" and not on the sweep-list-required
critical rules.

**2026-09-02 follow-up — 7 of 8 files fixed for real.** Once page/component
ownership passed to the agent doing this cleanup, every click-catcher div
above (both the backdrop and its `stopPropagation()` sibling, where one
exists) got `role="presentation"` — the real fix this section originally
deferred, not a suppression:

- `ConfirmDestructiveSheet.tsx`, `ConfirmationSheet.tsx`,
  `ReceiptField.tsx`, `AccountDetailPage.tsx`, `GoalsPage.tsx`:
  `role="presentation"` added to every flagged div (both halves of each
  backdrop/stopPropagation pair, where a pair exists).
- `DailyQuote.tsx`: `aria-hidden="true"` (not `role="presentation"`) on the
  backdrop div at L70, since it sits *inside* a wrapper that already carries
  `role="dialog"` — matching the "aria-hidden where the backdrop is purely
  decorative and the sheet itself carries the dialog role" case named in this
  pass's task brief.
- `Modal.tsx`: could not take the same `role="presentation"` fix on its
  dialog sheet, because that element already carries the real
  `role="dialog"` this doc's own §4 requires — a second `role` would
  overwrite it. Instead, the dismiss-on-outside-tap handler moved from the
  outer full-screen wrapper onto `.modal-backdrop` (a decorative div that
  was already a *sibling* of the dialog sheet, not an ancestor of it), which
  got `role="presentation"`. Because the backdrop is a sibling, a click
  inside the dialog sheet never bubbles through it in the first place, so
  the sheet's `onClick={(e) => e.stopPropagation()}` became dead code and
  was deleted rather than also role-tagged. Net effect is identical:
  clicking the backdrop still calls `requestClose()`; clicking inside the
  sheet still does nothing. `docs/accessibility-contrast.md` §4's dialog
  contract (focus trap, Escape, back-stack coordination) is unchanged — only
  the backdrop-dismiss wiring moved.

`src/pages/LoanDetailPage.tsx` (the 8th file, same overflow-menu-scrim shape
as `GoalsPage.tsx` L462, at its own L389) is **not** fixed here and stays in
`A11Y_SWEEP_TODO` — it's owned by a different, concurrently-running agent in
this pass, out of this item's file boundaries. Not a different fix, just a
different owner.

### 6.3 axe-core in CI (`e2e/a11y.spec.ts`)

Installed `@axe-core/playwright@4.13.0` (exact; peer is `playwright-core >=
1.0.0`, satisfied by this repo's pinned `@playwright/test@1.62.1`). New
`e2e/a11y.spec.ts` scans, with `AxeBuilder`, every route that renders with
**no session** — `/privacy`, `/terms`, `/contact`, `/delete-account`, and `/`
(the signed-out auth gate, per `e2e/auth-page.spec.ts`) — in both `ur` and
`en`, on both Playwright projects (`mobile` = Pixel 5, `desktop` —
`playwright.config.ts`; unmodified, both projects already run every spec by
default, so no config change was needed for "runs on mobile too"). Language
is set the same way `e2e/public-pages.spec.ts`'s `gotoWithLang` does: seed
`hisaab_lang` in `localStorage` via `page.addInitScript` before `page.goto`,
matching what `src/lib/i18n.ts`'s `readStoredLang()` reads on boot and what
`AuthPage`'s own "EN"/"UR" toggle button writes at runtime.

Threshold: an axe violation with impact `serious` or `critical` **fails** the
test. `moderate` violations are attached to the Playwright report as a JSON
artifact (`testInfo.attach`) and also printed to the console/CI log, per the
task brief — visible without blocking merges on the long tail. Wired into
`.github/workflows/e2e.yml` as its own "Accessibility scan (axe)" step
(before "E2E smoke suite", which also re-runs it as part of the full
`testDir`) — it needs no `E2E_EMAIL`/`E2E_PASSWORD` secrets, same "public
pages only" scope as `e2e/public-pages.spec.ts`.

#### Axe findings (`npx playwright test e2e/a11y.spec.ts` against `npm run dev`, 2026-09-02)

| Page | Lang | Original result | 2026-09-02 follow-up | Rule | Impact | File |
|---|---|---|---|---|---|---|
| `/contact` | ur, en | **pass** | pass | — | — | — |
| `/privacy` | ur, en | fixme'd | **fixed** | `color-contrast` | serious | `src/pages/PublicInfoPages.tsx:66` |
| `/terms` | ur, en | fixme'd | **fixed** | `color-contrast` | serious | `src/pages/PublicInfoPages.tsx:66` |
| `/delete-account` | ur, en | fixme'd | **fixed** | `color-contrast` | serious | `src/pages/PublicInfoPages.tsx:66` |
| `/` (auth) | ur, en | fixme'd | **fixed** | `button-name` | critical | `src/pages/AuthPage.tsx:397-400` |

Two distinct real findings, originally in files off-limits to this agent —
`src/pages/**` — both fixed in the 2026-09-02 follow-up pass once page
ownership passed to the agent doing this cleanup:

1. **`color-contrast` on the shared legal-page header's "Last updated" date**
   — was `<p className="mt-4 text-[11px] text-white/45">Last updated: {LAST_UPDATED}</p>`
   (`src/pages/PublicInfoPages.tsx:66`, rendered by `/privacy`, `/terms`,
   `/delete-account`; `/contact` doesn't render this line, hence its pass).
   Measured **4.46:1** against `bg-navy-900` at 11px/normal-weight — the AA
   floor is 4.5:1, a near-miss. **Fixed** by bumping the opacity utility from
   `text-white/45` to `text-white/60`: white blended at 60% over `navy-900`
   (`#0B0E2A`) computes to **7.16:1** — comfortably clear, not shaved thin
   again, since the exact opacity step nearest the 4.5:1 floor (~50%) is
   close enough to it that a small rendering/antialiasing margin was
   preferred. `text-white/60` is an existing convention at this exact
   opacity elsewhere in the codebase (e.g. `src/App.tsx:188`,
   `src/components/AccountCard.tsx:142`), not a new one-off value.
2. **`button-name` on `AuthPage`'s password show/hide toggle** —
   was `<button type="button" tabIndex={-1} onClick={() => setShowPassword(!showPassword)} className="...">{showPassword ? <EyeOff/> : <Eye/>}</button>`
   (`src/pages/AuthPage.tsx:397-400`). Icon-only, no `aria-label`, so a screen
   reader announced an unlabeled button. **Fixed** with
   `aria-label={showPassword ? t('auth_hide_password') : t('auth_show_password')}`
   — two new toggling i18n keys added next to `auth_label_password` in
   `src/lib/i18n.ts`. `tabIndex={-1}` was deliberately left in place: the
   fix in scope was the missing accessible *name* (the axe `button-name`
   finding), not the button's place in the tab order, which is a separate,
   pre-existing product decision (skip the toggle in Tab order, land on the
   email → password → submit sequence) not covered by this item's brief.

Per the task brief ("mark the assertion `test.fixme` ... rather than
weakening the threshold"): both findings had been captured in
`e2e/a11y.spec.ts`'s `KNOWN_VIOLATIONS` map (keyed by page name — verified
lang-independent, both `ur`/`en` hit the identical single violation), with
the affected test cases calling `test.fixme(true, <rule + file + reason>)` as
their first line. Now that both are fixed, `KNOWN_VIOLATIONS` is emptied
(kept as an empty `const`, not deleted, so a future regression on these same
pages has a documented place to record a fixme again) and every
`test.fixme(!!known, …)` call is a no-op, so all 20 cases (5 pages × 2 langs
× 2 projects) now run for real. See "Verification run for this pass" below
for the actual `npx playwright test e2e/a11y.spec.ts` result.

Also observed (not gating, since `moderate`, but noted for completness) on
`/` (auth) in both languages: `landmark-one-main` (document has no `<main>`
landmark) and `region` (page content — `<h1>Hisaab</h1>`, the email/password
fields, the "no ads" tagline, the sign-up hint — isn't contained in any
landmark region). Both are `AuthPage.tsx`-level structural fixes, out of
scope here; flagged for whoever picks up the `AuthPage.tsx` items above.

### 6.4 `lang` attribute

`index.html` hardcodes `lang="en"` and is out of this pass's file ownership
(per the task's explicit note), so the fix is entirely runtime, in
`src/lib/i18n.ts`:

```ts
export function documentLangFor(lang: Language): string {
  return lang === "ur" ? "ur-Latn" : "en";
}
```

`ur` in this app is **roman Urdu — Latin script**, not the Perso-Arabic
script the bare `ur` IANA subtag implies. Assistive tech (and browser
spell/grammar tooling) selecting voice/phoneme rules from `lang="ur"` alone
would apply Perso-Arabic-Urdu handling to text that's actually transliterated
Latin-alphabet copy — wrong pronunciation, wrong script-direction
assumptions. `ur-Latn` (the `Latn` ISO 15924 script subtag, valid under
BCP 47) is the correct tag for "Urdu language, Latin script" and is what
screen readers are documented to key off for script-specific handling. `en`
needs no script subtag (Latin is English's default script).

`applyDocumentLang(lang)` sets `document.documentElement.lang =
documentLangFor(lang)`, guarded on `typeof document === "undefined"` — Node-
safe, since `vitest.config.ts` runs the pure-function suite in the `node`
environment (no jsdom/happy-dom), so `document` does not exist under test.
Called from two places in `src/lib/i18n.ts`:

- **`setLang`** — every future language switch (Settings toggle, onboarding
  step 0, `AuthPage`'s corner "EN"/"UR" button) now also corrects
  `<html lang>` alongside the existing `localStorage`/`profiles.lang` writes.
- **Module-level, once, at import time** — `applyDocumentLang(useI18nStore
  .getState().lang)`, right after the store is created. This is the boot-time
  fix for `index.html`'s hardcoded `lang="en"`: `i18n.ts` is imported by
  virtually every component (per its own existing module comments), so this
  runs before first paint reads happen in practice, without needing an
  `index.html` edit or an `App.tsx` effect.

Verified live (not just unit-tested) against `npm run dev`: `curl`-free check
via a throwaway Playwright+axe script confirmed `<html lang="ur-Latn">` when
`hisaab_lang=ur` is seeded and `<html lang="en">` when `hisaab_lang=en` is
seeded, on `/` (AuthPage) — see the axe scan's `landmark-one-main` node dumps
in §6.3 above, which happen to include the live `<html>` tag as one of their
target nodes: `target=["html"] html=<html lang="ur-Latn">` /
`html=<html lang="en">`.

**2026-09-02 follow-up — `index.html` static tag fixed, with a known
trade-off.** `index.html`'s `<html lang>` changed from the hardcoded
`lang="en"` to `lang="ur-Latn"`, matching `src/lib/i18n.ts`'s
`DEFAULT_LANGUAGE` and the `documentLangFor('ur')` mapping documented above.
This closes the pre-hydration gap for the common case: `ur` is this app's
default (a fresh install, a cleared-storage device, or any visitor before
`localStorage.hisaab_lang` is ever written) and is the majority of traffic
per the product's audience (CLAUDE.md: "Pakistani/Urdu-speaking audience"),
so the static tag now matches the accessible-name expectation for the
common path instead of the uncommon one.

**Trade-off, not eliminated — just inverted:** a returning visitor who
previously switched to English (`hisaab_lang=en` in `localStorage`) still
hits a brief pre-hydration window where `<html lang="ur-Latn">` is live
before `i18n.ts`'s module-level `applyDocumentLang(...)` corrects it to
`en` on import — a screen reader attached in that instant would apply
Latin-Urdu-tagged handling to what is, for that specific return visitor,
about to render as English copy. This is the same class of gap the original
`lang="en"` had for `ur` users, just for the minority language and the
minority visitor (returning + previously switched, not first-visit), and it
is inherent to any static server-rendered tag when the real preference lives
in client storage — genuinely eliminating it needs a tiny render-blocking
inline `<script>` in `<head>` that reads `localStorage.hisaab_lang` and sets
`document.documentElement.lang` before first paint, which this task's file
ownership (`index.html`'s `lang` attribute "and nothing else") does not
extend to adding. Flagged here as the residual gap, not fixed further in
this pass.

**2026-09-02 second follow-up — CSP checked, inline script deliberately NOT
added.** `index.html`'s meta CSP (`<meta http-equiv="Content-Security-Policy"
...>`) sets `script-src 'self'` with no `'unsafe-inline'`, no nonce, and no
hash source. A render-blocking inline `<script>` in `<head>` — the fix
sketched just above to close the residual returning-English-visitor gap —
would be silently blocked by the browser under this policy (the CSP has no
`unsafe-inline`/nonce/hash to permit it), not merely undesirable. Vite's
build pipeline doesn't emit a per-build nonce or a static hash for a
hand-written inline script either, so there is no low-effort way to satisfy
the existing policy for this one script. Adding the script anyway would ship
dead code that only produces a CSP console violation in every browser,
while leaving the same trade-off unresolved. So: not added. The residual gap
described above (a returning visitor who previously switched to English
sees `<html lang="ur-Latn">` for one pre-hydration instant before
`i18n.ts`'s module-level `applyDocumentLang(...)` corrects it to `en`)
remains open. Closing it for real needs either a build-time nonce/hash
wired into the CSP meta tag (a Vite plugin or a small build script) or
moving the language preference into a cookie a server/edge layer could read
before responding — both bigger than a single-file, "and nothing else"
change, and out of scope for this pass.

### `documentLangFor` unit test

`src/lib/i18n.test.ts` (new) — pure mapping only, 2 cases (`ur` → `ur-Latn`,
`en` → `en`). Importing `i18n.ts` also runs its module-level
`applyDocumentLang(...)` call at boot, which is safe under vitest's `node`
environment because of the guard described above.

### 6.5 Remaining M3 items

Carried over from §5 above; updated for the 2026-09-02 follow-up pass
(§6.2/§6.3/§6.4 above) that cleared most of what this section used to list
as still open:

- **A real Android TalkBack pass and a keyboard-only desktop PWA walkthrough
  on a live build.** Still open. Nothing in this repo — this doc included —
  substitutes for the device pass `09-ui-quality.md` calls out as still
  required. Automated coverage (`eslint-plugin-jsx-a11y`, axe-in-CI, and now
  the `role="presentation"`/`aria-hidden` sweep in §6.2) narrows the gap but
  explicitly cannot catch everything a real screen-reader user would hit
  (e.g. reading order, gesture conflicts, TalkBack-specific quirks).
- **`Modal` portal-ization for app-root `inert`/`aria-hidden`** (§4 above,
  "not implemented" section). Still open. `Modal` still renders in-place in
  the React tree at ~40 call sites, so a background screen-reader user
  driving a virtual cursor (not Tab) can still swipe into covered content
  while a modal is open. Needs `createPortal` plus a re-review of
  stacking/z-index, CSS containment, and the scroll-lock interaction — a
  structural rewrite, out of scope for both the original M3 pass and every
  pass since, including this one.
- **The 33-error / 8-file jsx-a11y ignore list (§6.2)** — **7 of 8 files
  fixed** in the 2026-09-02 follow-up pass (real `role="presentation"` /
  `aria-hidden` fixes, not suppressions — see §6.2 for the per-file
  breakdown). `src/pages/LoanDetailPage.tsx` (2 errors, same overflow-menu
  scrim shape, L389) remains on `A11Y_SWEEP_TODO` — owned by a different
  concurrently-running agent this pass, not a harder fix.
- **The 2 axe findings (§6.3)** — **both fixed** in the 2026-09-02 follow-up
  pass: `PublicInfoPages.tsx:66`'s "Last updated" contrast (`text-white/45`
  → `text-white/60`) and `AuthPage.tsx:397-400`'s password-toggle
  `aria-label`. `e2e/a11y.spec.ts`'s `KNOWN_VIOLATIONS` map is now empty.
- **`index.html`'s static `lang`** (§6.4 follow-up) — **fixed**:
  `lang="en"` → `lang="ur-Latn"`, matching `DEFAULT_LANGUAGE`. Closes the
  pre-hydration gap for the common (Urdu-default) case but, as documented in
  §6.4, inverts rather than eliminates it — a returning visitor who switched
  to English now hits the same brief mis-tagged window the `ur` majority
  used to. A render-blocking inline `<script>` reading
  `localStorage.hisaab_lang` before first paint would close that residual
  gap; not implemented here (outside this item's `index.html` file-ownership
  scope, which was the `lang` attribute "and nothing else").
