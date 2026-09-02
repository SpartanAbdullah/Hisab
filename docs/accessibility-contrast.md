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
