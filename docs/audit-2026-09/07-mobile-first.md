# Mobile-First Experience Audit — Hisaab

**Date:** 2026-09-02
**Auditor:** Consolidating lead (Mobile-First Experience report), from 2 independent finder passes
**Scope:** PWA (usehisaab.com) + Capacitor Android wrapper (`android/`, `com.usehisaab.app`), one React 19/TS/Vite codebase
**Verification status:** All raw findings arrived UNVERIFIED (no adversarial refutation pass ran for this phase). The lead auditor re-opened and confirmed every load-bearing citation for the high-severity findings and spot-checked the medium/low set; each finding below carries a `Spot-check` note. Nothing was refuted during consolidation, so there is no refuted-findings appendix. Findings whose *impact* depends on real-device behavior (as opposed to code facts) say so explicitly.

---

## Summary

Hisaab's core mobile chrome shows real craft: a 5-slot bottom nav with centered FAB, a 44px hit-area-expansion idiom (`.nav-icon-button::before`, `src/index.css:1458-1463`; `TransactionItem.tsx:186`), `pt-safe` utilities (`src/index.css:736-738`), consistent `inputMode` on money/phone fields, and route-level code splitting. The failures are where that craft is not systemic — and they cluster on exactly the surfaces internal testing does not exercise: **the PWA** (the Android wrapper's `Keyboard.resize:'native'` masks a keyboard-occlusion defect that breaks every fixed-bottom composer and Save footer on the web surface), **cold start** (deep links are silently dropped because `App.getLaunchUrl()` is never called; assetlinks.json is not deployed; splash auto-hides at 600ms into a 1.15MB bundle parse), **the notification stack** (no `google-services.json` in the checkout, permission requested only from a buried Settings toggle, inexact alarms, a 10-day reminder horizon with no background re-arm, and loan/EMI resolution paths that never cancel stale reminders), and **flaky networks** (multi-leg money mutations can commit half-way server-side while both the compensation and the refetch fail; the offline outbox is an inert scaffold). Six findings are high severity; the half-moved-money finding borders the audit's critical class (visible money corruption). None of these are exotic: they are the daily conditions of the product's own target market — low-end Android, aggressive OEM battery managers, 3G, one-handed use.

---

## Findings index (worst first)

| ID | Severity | Finding | Section |
|----|----------|---------|---------|
| MF-01 | High (borderline critical) | Money can be left half-moved server-side on a flaky network; outbox inert | Mobile-only bugs |
| MF-02 | High | Fixed-bottom inputs/footers hidden by the keyboard on the PWA | Keyboard |
| MF-03 | High | Cold-start deep links silently dropped (`getLaunchUrl` never called) | Native |
| MF-04 | High | `assetlinks.json` absent from repo/deploy — App Links cannot verify | Native |
| MF-05 | High | `google-services.json` absent — checkout builds have zero FCM; fallback tier known-broken | Native |
| MF-06 | High | Notification permission only ever requested from a buried Settings toggle | Native / Onboarding |
| MF-07 | Medium | Hardware back can never exit the app (`history.length > 1`) | Native |
| MF-08 | Medium | Back button invisible to confirm sheets, QR scanner, global search | Native |
| MF-09 | Medium | Reminder schedule not durable: 10-day horizon, no background re-arm, OEM force-stop wipes it | Native |
| MF-10 | Medium | Exact-alarm capability never declared — reminders drift on Android 12+ | Native |
| MF-11 | Medium | loanStore/emiStore resolution paths never force-reschedule reminders | Mobile-only bugs |
| MF-12 | Medium | No force-update / minimum-version mechanism against manual schema drift | Native |
| MF-13 | Medium | Evictable WebView storage for sessions/reminders/mirror; `@capacitor/preferences` shipped unused | Native |
| MF-14 | Medium | Heavy cold boot: 1.15MB entry chunk + ~12 parallel boot fetches | Performance |
| MF-15 | Medium | Bundled native app's first paint blocks on a Google Fonts network fetch | Performance |
| MF-16 | Medium | 59/141 inputs under 16px → iOS Safari focus auto-zoom | Forms / Keyboard |
| MF-17 | Medium | Undo chip: ~29px, top-anchored, no top safe-area, 6s window | Tap targets / Safe areas |
| MF-18 | Medium | Scroll position destroyed on every route change including back | Scroll |
| MF-19 | Medium | Pull-to-refresh disabled app-wide with no replacement | Scroll |
| MF-20 | Medium | Systemic sub-44px tap targets on money-state, destructive, and hero controls | Tap targets |
| MF-21 | Medium | Destructive confirm button in the resting-thumb slot with no arming delay | Tap targets |
| MF-22 | Low | QuickEntry amount: no digit grouping, no integer cap | Forms |
| MF-23 | Low | Sheets show a drag grabber but implement no drag-to-dismiss | Tap targets |
| MF-24 | Low | Auth/onboarding language toggle in the iOS status-bar zone, ~27px | Safe areas / Onboarding |
| MF-25 | Low | Zero `enterKeyHint`; phone fields lack `type=tel`/`autoComplete=tel` | Forms |
| MF-26 | Low | Body scroll-lock is `overflow:hidden` only — iOS ignores it | Scroll |
| MF-27 | Low | Reconcile-toggle hit zone overlaps the row's open target | Tap targets |
| MF-28 | Low | Kameti member phone input 112px wide | Forms |
| MF-29 | Low | 10px bottom-nav labels; 'Group Splits' near cell width at 320px | Bottom nav |
| MF-30 | Low | `captureInput: true` untested against Urdu IME keyboards | Native |
| MF-31 | Low | Splash auto-hides at 600ms, before slow devices reach first paint | Performance |
| MF-32 | Low | R8 disabled; dead `@capacitor/preferences` plugin shipped | Performance |
| MF-33 | Low | minSdk 24 + modern Vite baseline + no WebView guard → unexplained white screen | Performance |

---

## 1. Thumb reachability & one-handed use

The app gets the big call right: primary creation lives on the FAB and bottom nav, and confirmation sheets are bottom sheets. The failures are at the edges of that pattern.

**MF-17 (medium) — Undo, the app's primary money-mistake recovery path, is a ~29px chip at the least reachable point on screen.**
`ToastContainer` is `fixed top-4` (`src/components/Toast.tsx:116`), the action chip is `px-2.5 py-1.5 text-[12px]` (~29px tall, Toast.tsx:96-100), and the window is 6 seconds when an action is present (Toast.tsx:62). The repo's own recovery-audit history (memory: `project_recovery_audit_2026_07`) deliberately leans on toast Undo instead of blocking confirms for reversible money actions — which makes this small, top-anchored, time-boxed button the load-bearing safety mechanism. The user's thumb is at the numpad/FAB that just fired the action; the Undo is a stretch to the top of a 6.5" screen. Safe-area interaction compounds this — see §7. *Spot-check: confirmed (Toast.tsx read in full).*
**Fix (S):** bottom-anchored snackbar for action-bearing toasts, min 44px action hit area.

**MF-21 (medium) — The destructive confirm button lands directly under the resting thumb with no arming delay.**
`ConfirmationActions` renders Cancel *above* the danger button, so the destructive action is bottom-most and full-width (`src/components/ConfirmDestructiveSheet.tsx:49-62`); the sheet becomes visible on the next animation frame with buttons live immediately (ConfirmDestructiveSheet.tsx:104-112; `.sheet-transient` slides over 300ms, `src/index.css:1398-1408`). A double-tap or impatient second tap after "Delete" can land on the red confirm mid-slide — for deletes that reverse account balances, with only the MF-17 toast as recovery. Backdrop-tap-to-cancel (line 120) is a good default; the button order and zero-delay arming are not. *Spot-check: confirmed.*
**Fix (S):** ignore pointer events on the confirm button until the entrance transition ends (~300-500ms); consider Cancel bottom-most.

**MF-20 (part) — hero actions.** The recurring `h-9` (36px) hero-action idiom puts Edit account, Add goal, Add contact, and filters at the top band of the screen — wrong size and wrong reach zone together (`src/pages/AccountDetailPage.tsx:327`, `ActivityPage.tsx:101`, `ContactsPage.tsx:324`, `GoalsPage.tsx:225-232`). The top-left back button (`src/components/PageHeader.tsx:27-34`) is standard and mitigated by Android system back, but the iOS PWA has no swipe-back fallback (no gesture implementation found; grep `onTouchStart` = 1 unrelated hit). *Spot-check: idiom confirmed by grep of `h-9` hero usage; individual line numbers trusted from finder.*

## 2. Bottom navigation

Structurally sound: fixed 5-column grid, stable across both app modes (`src/components/BottomNav.tsx:38-39`), icons hit-expanded via the shared idiom.

**MF-29 (low) — 10px labels; the longest label nearly fills its cell on small devices.**
Labels are `text-[10px]` with no `truncate` (BottomNav.tsx:85,134-139 per finder; grid-cols-5 confirmed at line 39 → ~64px cells at 320px). `nav_groups` is "Group Splits" in both languages (`src/lib/i18n.ts:996`), ~60px at 10px. Below comfortable legibility for the lower-literacy/older segment the udhaar/kameti features target, and there is no overflow safety net for future longer localized labels (189 Roman-Urdu strings in i18n.ts exceed 60 chars). Rendered widths on real 320-360px devices are not verifiable from the repo. *Spot-check: partial (grid + label key confirmed).*
**Fix (S):** shorten to "Groups", raise to 11px, add `truncate`.

## 3. Tap targets

The design system solved this problem — `.nav-icon-button::before { inset: -6px }` (`src/index.css:1458-1463`) and `before:-inset-2.5` on TransactionItem's reconcile toggle — and then large parts of the app skipped the solution.

**MF-20 (medium) — Systemic sub-44px targets on money-state and destructive controls.** *(Merged from two finder reports; citations combined.)*
Worst offenders, all in dense rows where a miss lands on a different action:
- Group-expense reconcile toggle: `w-7 h-7` = 28px, **no** expansion, flush against a tappable row (`src/pages/GroupDetailPage.tsx:850-859`) — a shared money-state toggle other members see.
- Remove-settlement trigger: `text-[10px]` + `Trash2 size 10`, ~14px tall (`GroupDetailPage.tsx:1033-1039`) — recalculates group balances (confirm-guarded at 398-408, but see MF-21).
- Clear-search X: bare 14px icon (`src/pages/ContactsPage.tsx:358-364`; `press-xs` is visual-only, `index.css:351-357`).
- Password show/hide: bare 16px icon on the first screen every user must pass (`src/pages/AuthPage.tsx:383-386`).
- 28-32px icon buttons and a ~28px "Link" CTA across GoalsPage.tsx:437-443, CreateCommitteeModal.tsx:181, ContactsPage.tsx:388-394, 624-639.
- The 36px hero-action idiom (§1).
Mis-taps here toggle shared financial state or open destructive flows; small targets disproportionately hurt the older family-member demographic. *Spot-check: partial (pattern + several sites confirmed via the contrast citations; not every line re-opened).*
**Fix (S):** apply `before:-inset-*` or `min-w/min-h-[44px]` to every interactive element under 44px; add a review-checklist/lint rule.

**MF-27 (low) — Reconcile hit-zone overlap in transaction lists.**
The 24px reconcile circle's invisible 44px zone (`src/components/TransactionItem.tsx:179-193`, `before:-inset-2.5`, `stopPropagation` at 151) sits inside a fully tappable row (167-177): a tap ~10px right of the circle silently flips `isReconciled` — persisted immediately, no confirm, no success feedback — when the user meant to open the editor. Corrupts the "Hisaab check" ritual's record of what was verified. *Spot-check: confirmed idiom exists (index.css/TransactionItem contrast citations).*
**Fix (S):** undoable toast on toggle; keep the expanded zone clear of the row's open target.

**MF-23 (low) — Drag grabber with no drag.**
Every sheet renders the universal 38×4.5px "swipe me down" affordance (`src/components/Modal.tsx:78-81`) but no touch handler exists anywhere in Modal.tsx (repo-wide `onTouchStart` grep = 1 unrelated hit in ConfirmationSheet.tsx:82). Users swipe, fail, and on scrollable bodies their swipe scrolls content instead — reads as "web app, not real app," a perception risk for a finance product. *Spot-check: confirmed (Modal.tsx read).*
**Fix (M):** remove the grabber, or implement drag-to-dismiss on the header region.

## 4. Keyboard interactions

**MF-02 (high) — Fixed-bottom inputs and sheet footers are obscured by the on-screen keyboard on the PWA.**
The viewport meta has no `interactive-widget=resizes-content` (`index.html:26` — confirmed: `width=device-width, initial-scale=1.0, viewport-fit=cover` only) and there is zero `visualViewport` handling anywhere in `src/` (grep = 0 hits, confirmed). Chrome on Android 108+ resizes only the *visual* viewport when the keyboard opens; `position:fixed` elements stay anchored behind the keyboard. Affected: the Hisaab AI composer — the headline natural-language entry — fixed at `calc(70px + env(safe-area-inset-bottom))` (`src/pages/HisaabAIPage.tsx:868-870`), and every bottom-sheet Save/Confirm footer (`src/components/Modal.tsx:72` `fixed inset-0 items-end`; `.modal-footer`, `src/index.css:1381-1386`) in QuickEntry, AddGroupExpenseModal, RepaymentModal, etc. iOS standalone PWA fails the same way (iOS never resizes the layout viewport). Crucially, the Android wrapper is protected by `Keyboard: { resize: 'native' }` (`capacitor.config.ts:41-44` — confirmed), which is exactly why internal wrapper testing does not catch it. Actual on-device behavior was not observed (no device farm); the code facts and documented Chromium/Safari semantics are the evidence. *Spot-check: confirmed (all citations re-opened).*
**Fix (S):** add `interactive-widget=resizes-content` to the viewport meta + a small `visualViewport` resize handler for iOS.

**MF-16 (medium) — 59 of 141 inputs render below 16px, defeating the codebase's own iOS auto-zoom guard.**
The global rule `input, select, textarea { font-size: 16px }` exists precisely to prevent iOS focus-zoom (`src/index.css:871-874` — confirmed) but is overridden wherever a Tailwind `text-[13px]`/`text-sm`/`text-xs` utility lands on the input itself; the finders' scripted scan counted 59/141 across 27 files. High-frequency victims: contact search (`ContactsPage.tsx:354`), the AI composer (`HisaabAIPage.tsx:897`), global search (`GlobalSearch.tsx:170`), per-person split amounts (`AddGroupExpenseModal.tsx:351-377`), kameti phone rows (`CreateCommitteeModal.tsx:178`). The viewport meta correctly omits `maximum-scale` (accessibility), so the zoom persists after blur until a manual pinch-out. Gulf-expat audience is iPhone-heavy. *Spot-check: base rule confirmed; the 59/141 count is the finders' scan, not independently re-run.*
**Fix (M):** keep computed input font-size ≥ 16px; lint sub-16px utilities on input/textarea.

**MF-25 (low) — Zero `enterKeyHint` app-wide; phone fields lack `type=tel`/`autoComplete=tel`.**
Repo-wide grep for `enterKeyHint` = 0 hits (confirmed). `inputMode` coverage is genuinely good, but the keyboard action key is never tuned, and phone fields (`ContactsPage.tsx:420-426`, `PhoneDiscoverySection.tsx:138`, `CreateCommitteeModal.tsx:178`, `KametiDetailPage.tsx:402`) use `inputMode="tel"` without `type=tel`/`autoComplete=tel`, so keyboards never offer contact autofill — in an app whose linking/discovery flows hinge on typing other people's numbers accurately in E.164. Only AuthPage sets any `autoComplete`. *Spot-check: confirmed (grep).*
**Fix (S):** per-role `enterKeyHint`; `type="tel" autoComplete="tel"` on phone inputs.

## 5. Form usability

**MF-22 (low) — QuickEntry amount is a raw ungrouped digit string with no integer cap.**
`numpadPress` caps only decimals at 2 (`src/pages/QuickEntry.tsx:276-280` — confirmed: no integer cap, no grouping) while the 54px display renders the raw string; the quick-amount chips directly below it *do* use `toLocaleString` — the formatting exists in the same file. PKR users routinely enter lakh-scale amounts; "1000000" forces zero-counting by eye at the exact moment a misplaced zero creates a 10x money error that then propagates into loans/splits/cross-user records (downstream guards exist for cross-user sends only, `src/lib/confirmCrossUserRequest.ts`). *Spot-check: confirmed.*
**Fix (S):** live digit grouping on the entry buffer; cap integer digits (~10).

**MF-28 (low) — Kameti member phone input is 112px wide** (`w-28 text-[11px]`, `CreateCommitteeModal.tsx:178`): a 12-13 char +971/+92 number cannot be seen whole, so users edit the tail blind. These numbers feed WhatsApp reminders and (post-migration) discovery matching, where one wrong digit silently targets the wrong person. The sibling flow shows the right pattern — KametiDetailPage's edit-phone field is full-width (KametiDetailPage.tsx:402). *Spot-check: trusted from finder (consistent with MF-16's citation of the same line).*
**Fix (S):** stack the member row; full-width phone on its own line.

Positives worth keeping: consistent `inputMode="decimal|numeric|tel"`, the 16px base rule itself, and quick-amount chips with `min-h` sizing.

## 6. Scroll behavior

**MF-18 (medium) — Scroll position deliberately destroyed on every route change, including back.**
`window.scrollTo(0, 0)` keyed on `location.pathname` (`src/App.tsx:376` — confirmed) with no restoration cache. The app's core review loop — scan TransactionsPage/LoansPage/GroupDetailPage, open a detail route, come back — dumps the user at the top every time; the "Hisaab check" ritual becomes O(n²) scrolling. Android hardware back routes through the same effect (App.tsx:198-207). *Spot-check: confirmed.*
**Fix (S):** restore offsets on POP navigations (react-router distinguishes POP from PUSH); scroll-to-top only on PUSH.

**MF-19 (medium) — Pull-to-refresh disabled with no replacement.**
`body { overscroll-behavior: none }` (`src/index.css:867` — confirmed) kills native pull-to-refresh; no in-app implementation exists (grep). Freshness depends solely on realtime sockets + visibility/online/focus listeners (`App.tsx:228-241` — confirmed). On flaky Gulf↔Pakistan networks, when a realtime event was missed while the socket was down (a failure mode the codebase itself documents, `nativeBridge.ts:95-99`), the user's universal recovery gesture does nothing; the only fix is killing the app. Group balances and inbox requests are exactly the cross-user data most likely to go stale. *Spot-check: confirmed.*
**Fix (M):** lightweight pull-to-refresh on main scrollers or a refresh affordance in PageHeader wired to page loaders + `resumeGlobalRealtime()`.

**MF-26 (low) — Body scroll-lock is `overflow:hidden` only.**
`document.body.style.overflow = 'hidden'` is the sole mechanism (`src/components/Modal.tsx:41,55-57` — confirmed). iOS Safari ignores it for touch scrolling; drags starting on the backdrop scroll the page beneath, so page position has shifted on close (compounding MF-18). Android WebView respects it — another PWA-only defect invisible to wrapper testing. *Spot-check: confirmed.*
**Fix (S):** `position:fixed` body lock with scroll restore, or a maintained lock utility.

## 7. Safe areas & notches

The codebase has the utility (`.pt-safe`, `src/index.css:736-738` — confirmed) and uses it on in-app chrome (NavyHero, OfflineBanner). Two surfaces miss it:

**MF-17 (part, medium) — Toast layer ignores the top safe area.** `fixed top-4` with no `env(safe-area-inset-top)` (`Toast.tsx:116` — confirmed), under `viewport-fit=cover` + `black-translucent` status bar (`index.html:26,30` — confirmed): on notched iPhones in standalone mode, toasts — including the Undo chip — render partially under the clock. The one recovery affordance for money mistakes can be notch-clipped during its 6-second life.

**MF-24 (low) — The pre-auth language toggle sits in the status-bar zone at ~27px.**
`absolute top-5 right-5 … py-1.5 text-[10px]` (`src/App.tsx:120` — confirmed; same placement on `AuthPage.tsx:250`, OnboardingPage container has no `pt-safe` per finder). This is the first tap a Roman-Urdu-preferring user needs (ur is the i18n default, but the toggle is how an English-preferring user switches too), on notched iPhones potentially clipped/untappable at 20px from the top — smallest target, least reachable corner, on the trust-critical first screens. *Spot-check: App.tsx:120 confirmed; AuthPage/Onboarding trusted.*
**Fix (S):** `top-[max(20px,env(safe-area-inset-top))]` or `pt-safe` wrapper; min-h-[44px].

Note: whether `env(safe-area-inset-*)` resolves to non-zero inside the Capacitor WebView on Android 15 edge-to-edge devices is not verifiable from the repo (see Evidence-unavailable). `StatusBar.overlaysWebView: false` (`capacitor.config.ts:30`) suggests the wrapper avoids the issue today; Android 15 forced edge-to-edge may change that at targetSdk 35.

## 8. Native integration (Capacitor)

This is the weakest area of the audit. The bridge itself (`src/lib/nativeBridge.ts`) is thoughtfully commented and wires status bar, back button, resume-resync, and notification taps — but several of its foundations are broken or absent.

**MF-03 (high) — Cold-start deep links are silently dropped.**
`nativeBridge.ts` handles deep links only via the `appUrlOpen` listener (`nativeBridge.ts:65-74` — confirmed by full read); Capacitor's App plugin emits that event only from `handleOnNewIntent()` — i.e. warm starts of the `singleTask` activity (`AndroidManifest.xml:19` — confirmed). When the app is killed and the user taps an invite/connect link, the VIEW intent arrives in `onCreate`, no event fires, and the WebView loads `/`. The launch URL is only retrievable via `App.getLaunchUrl()` — **zero call sites in `src/`** (grep confirmed). The web-side `pendingInvite` fallback (`App.tsx:190-194` — confirmed) never runs because the `/join/` route is never entered natively. Killed-app is the common case for the receiving side of a WhatsApp invite — the app's primary acquisition loop. Today this is masked by MF-04 (links open the browser); the moment assetlinks verification goes live, every cold-start invite tap lands on the home screen with the token lost and no browser fallback. *Spot-check: confirmed.*
**Fix (S):** in `initNativeBridge`, call `CapApp.getLaunchUrl()` after attaching listeners and route it through the same path-extraction logic.

**MF-04 (high) — `assetlinks.json` is not in the repo or deploy output.**
The manifest declares `android:autoVerify="true"` filters for `/join/` and `/u/` (`AndroidManifest.xml:43-58` — confirmed) and its own comment admits verification awaits publishing the JSON (lines 27-42). Neither `public/` nor `dist/` contains `.well-known/` (shell check confirmed), and `vercel.json` adds nothing. The launch tracker's Y7 row marks this open, blocked on Play App Signing enrollment — meaning BOTH the upload-key and Play-signing-key SHA-256 fingerprints must go in the file or links break again after Play re-signs (`docs/play-store-launch-tracker.md:37`, `RELEASE.md:121-142`). Current harm: the entire deep-link surface (invites, connect QR codes) opens in the browser/chooser instead of the installed app. Fixing it exposes MF-03. *Spot-check: confirmed (manifest + filesystem).*
**Fix (S):** ship `public/.well-known/assetlinks.json` with both fingerprints; verify via the digitalassetlinks `statements:list` endpoint.

**MF-05 (high) — `google-services.json` absent: builds from this checkout have zero FCM, and the fallback tier is known-broken.**
`build.gradle:97-104` applies the google-services plugin only if the file exists ("Push Notifications won't work" in the fallback log — confirmed); the file is gitignored and missing (shell check confirmed). Registration throws and is swallowed by design (`src/lib/pushRegistration.ts:8-12,68-72`). The intended fallback — `instantNotify` over the realtime socket — is undermined by the codebase's own admission that the socket does not survive WebView suspension ("came back subscribed-in-name-only", `nativeBridge.ts:95-99` — confirmed). Net effect in any AAB built from this checkout: no notification delivery while backgrounded or killed; the "3-tier push delivery" is one tier. Whether the machine that produced the existing signed AAB had the file is unknowable from the repo (see Evidence-unavailable). Memory notes record Firebase setup as still pending. *Spot-check: confirmed.*
**Fix (M):** complete Firebase setup pre-upload; add a release-build guard (mirroring the keystore guard at `build.gradle:83-93` — confirmed to exist) that fails loudly when the file is missing.

**MF-06 (high) — Notification permission is only ever requested from a buried Settings toggle.**
The sole call sites of `enableRemindersFlow` / `requestPushPermissionAndRegister` are the Settings payment-reminders toggle (`src/pages/SettingsPage.tsx:666,675` — grep confirmed; no other callers in src). `startPushRegistration` at boot deliberately never prompts (`pushRegistration.ts:52-56`). No contextual ask exists at any high-intent moment (first incoming cross-user request, first due-dated loan, kameti join). On Android 13+ the default state for essentially every user is: no POST_NOTIFICATIONS grant → no FCM registration, no local reminders, no tray notifications — for a product whose udhaar/kameti mechanics depend on nudging the other party. *Spot-check: confirmed.*
**Fix (M):** contextual permission ask at high-intent moments, reusing `requestPushPermissionAndRegister`.

**MF-07 (medium) — Hardware back can never exit the app.**
`canGoBack: () => window.history.length > 1` (`src/App.tsx:205` — confirmed). `history.length` counts all session entries and never decreases on back-navigation, so after the first in-app navigation it is permanently > 1: at history index 0 the handler calls `window.history.back()` — a no-op — and `CapApp.exitApp()` (`nativeBridge.ts:56-60` — confirmed) is unreachable. Back presses on the home screen visibly do nothing; reads as a hang, and predictable-back is a behavior Play's pre-launch report commonly flags. *Spot-check: confirmed.*
**Fix (S):** `canGoBack: () => (window.history.state?.idx ?? 0) > 0`.

**MF-08 (medium) — Back button only sees `<Modal>`; confirm sheets, QR scanner, and global search are invisible to it.**
The back handler pops `uiStore.modalStack` (`nativeBridge.ts:55` — confirmed; store at `src/stores/uiStore.ts:8-33`), but only Modal.tsx registers (`Modal.tsx:38-67` — confirmed). ConfirmDestructiveSheet (its own `fixed inset-0 z-[70]` markup, `ConfirmDestructiveSheet.tsx:120` — confirmed), ConfirmationSheet, QRScanner, and GlobalSearch never register (grep confirmed no `openModal` usage). A back press with a destructive confirmation open falls through to `history.back()` — navigating away *underneath* the open sheet; with the scanner open it strands the camera flow. *Spot-check: confirmed.*
**Fix (S):** extract Modal's register/unregister into a `useModalBackRegistration(open, onClose)` hook and adopt it in the non-Modal overlays.

**MF-09 (medium, merged) — The reminder schedule is not durable: 10-day horizon, no background re-arm, and OEM force-stop wipes it.**
The planner schedules at most 10 days ahead, max 24 notifications (`src/lib/notificationPlanner.ts:58-61,262` — confirmed: `HORIZON_DAYS = 10`, `MAX_TOTAL = 24`). Rescheduling happens only inside the running WebView (boot: `App.tsx:325-327` — confirmed; resume: `nativeBridge.ts:94` — confirmed, non-forced; store mutation paths). There is no WorkManager/periodic job in `android/`, no FCM data-message wake, and the plugin's restore receiver re-arms only after device reboot. So: a user who stops opening the app stops receiving reminders after day 10 (exactly the lapsed user reminders exist to recover), and a battery-manager force-stop — default-aggressive on Xiaomi/Oppo/Vivo/Tecno/Infinix, the dominant brands in the market — cancels even the pending 10 days until the next manual open. Silent failure, no telemetry to detect it. Real-device force-stop behavior is inference from documented Android semantics. *Spot-check: code facts confirmed.*
**Fix (L):** a server-scheduled push tier via the existing push-notify edge function (pg_cron over due dates) as the durable layer; optionally surface `isIgnoringBatteryOptimizations` guidance in Settings.

**MF-10 (medium) — Exact-alarm capability never declared: reminders drift on Android 12+.**
Neither the app manifest (`AndroidManifest.xml:73-93` — confirmed: only INTERNET + CAMERA declared) nor the plugin's merged manifest declares `SCHEDULE_EXACT_ALARM`/`USE_EXACT_ALARM`, so `canScheduleExactAlarms()` is always false and the plugin silently downgrades to `setAndAllowWhileIdle` — batched, Doze-deferred. The product promises a 10:00 nudge (`notificationPlanner.ts:58` `REMIND_HOUR = 10` — confirmed, with the "early enough to act the same day" design comment); delivery can drift minutes to hours, worst on aggressive-Doze OEMs. Nothing checks or surfaces the setting. *Spot-check: confirmed (manifest read; plugin behavior from finder's node_modules citation).*
**Fix (M):** declare `USE_EXACT_ALARM` (justifiable under Play policy for a reminder function) or `SCHEDULE_EXACT_ALARM` + the plugin's settings flow — or explicitly accept and document inexact delivery.

**MF-12 (medium) — No force-update/minimum-version mechanism while the backend schema evolves by hand.**
On native, the web bundle updates only via full Play releases (SW deliberately disabled on native, `src/lib/serviceWorker.ts:6-8`; no OTA layer; `versionCode 1` hardcoded, `build.gradle:23` — confirmed). Meanwhile 40 root `supabase-migration-*.sql` files are applied manually, several believed pending (memory notes). No versions table, no boot compatibility check, no kill switch: an old binary keeps calling RPCs whose semantics moved, failing however each call site handles it — many money paths log-and-continue. Play staged rollouts + review latency guarantee weeks of version skew once real users exist. *Spot-check: build.gradle confirmed; migration-file count trusted.*
**Fix (M):** an `app_config` row (min_supported_version, message) fetched at boot; gate with an update screen. Keep RPC changes additive until then.

**MF-13 (medium) — Sessions, reminder opt-in, and the Dexie mirror all live in evictable WebView storage; `@capacitor/preferences` ships unused.**
No `navigator.storage.persist()` call anywhere (grep); the Supabase session uses default localStorage (`src/lib/supabase.ts:10`), REMINDERS_KEY is localStorage (`notificationScheduler.ts` — key confirmed via SettingsPage import), mirror sync stamps too (`mirrorCache.ts:52,76`). On low-storage devices (32/64GB is the market norm) Chromium can evict the origin's storage under pressure: silent sign-out, reminders read back as off, mirror dropped. `allowBackup=false` (`AndroidManifest.xml:5` — confirmed) means device migration also wipes everything. `@capacitor/preferences` — native storage that survives WebView eviction — is a dependency with zero imports. *Spot-check: manifest + import graph confirmed; supabase.ts/mirrorCache lines trusted.*
**Fix (M):** `navigator.storage.persist()` at boot on native; move auth storage adapter + REMINDERS_KEY to `@capacitor/preferences` on native builds.

**MF-30 (low) — `captureInput: true` is a known keyboard-compatibility risk, untested against the audience's IME keyboards.**
`capacitor.config.ts:22` (confirmed). Capacitor documents that this flag can interfere with keyboard suggestions/autofill/IME composition — and Gboard/SwiftKey Urdu transliteration depends on IME composition, the exact input mode the app's Roman-Urdu identity rests on. No rationale for the flag is recorded anywhere in the repo. Unverifiable from code alone; belongs on the device-test matrix.
**Fix (S):** test with Gboard Urdu transliteration + SwiftKey; drop the flag absent a documented reason.

## 9. Performance on low-end devices

**MF-14 (medium) — Heavy cold boot: 1.15MB entry chunk plus ~12 parallel Supabase fetches.**
`dist/assets/index-Dd5g8xje.js` is 1,152,419 bytes (shell check confirmed; jspdf 400K, AnalyticsPage 366K, html2canvas 200K, jsQR 130K as lazy chunks; dist ≈3.6M). The signed-in effect fires persons, linked/settlement/contact-link requests, notifications, accounts, groups, budgets, categories, committees, and recurring loads concurrently (`App.tsx:266-331` — confirmed by full read), and the boot reminder reschedule additionally force-loads seven stores including the full transactions list (`notificationScheduler.ts` ensureLoaded, per finder) to plan ≤24 notifications. Route splitting exists (good), but there is no bundle budget in CI and no manualChunks tuning (`vite.config.ts:1-8`). Multi-second cold starts on sub-$150 Android hardware; every boot burns metered data. Measured times are not available (no device farm). *Spot-check: sizes + boot effect confirmed.*
**Fix (M):** CI bundle budget; entry-chunk audit; defer the boot reschedule until stores are warm; stagger non-critical fetches.

**MF-15 (medium) — First paint of the *bundled* native app blocks on a Google Fonts network fetch.**
`index.html:45` is a synchronous cross-origin stylesheet for Geist (confirmed; same HTML ships in the APK via `webDir: 'dist'`, `capacitor.config.ts:12`). Head stylesheets block first render, so a packaged app's startup stalls until fonts.googleapis.com responds — offline fails fast, 2G/3G can hang paint for seconds, *after* the splash has already gone (MF-31). *Spot-check: confirmed.*
**Fix (S):** self-host the woff2 files with `font-display: swap` (also shrinks the CSP).

**MF-31 (low) — Splash auto-hides on a 600ms timer, before slow devices reach first paint.**
`launchShowDuration: 600, launchAutoHide: true` (`capacitor.config.ts:32-40` — confirmed); the `SplashScreen.hide()` in nativeBridge (`nativeBridge.ts:46` — confirmed) only helps when React is already up. On a low-end device parsing 1.15MB (plus MF-15's font stall) the splash blinks into a blank WebView for one to several seconds — at the single most impression-forming moment. *Spot-check: confirmed.*
**Fix (S):** `launchAutoHide: false`; nativeBridge owns dismissal with a ~5s failsafe.

**MF-32 (low) — Release headroom untapped:** `minifyEnabled false` with an explicit "before a final-perf release" TODO (`build.gradle:44-49` — confirmed), the unused `@capacitor/preferences` plugin shipped, 3.6MB web assets in the APK. Download size is a conversion factor on metered connections. **Fix (M):** enable R8 with Capacitor keep rules; use (or remove) the preferences plugin per MF-13.

**MF-33 (low) — minSdk 24 + Vite 8's modern build target + no WebView-version guard.**
`android/variables.gradle:2` (minSdk 24, per finder) with no legacy plugin or `build.target` tuning (`vite.config.ts` — confirmed minimal) means a stale/disabled Android System WebView throws a SyntaxError before React mounts; the chunk-recovery overlay never renders because the *entry* script fails. Note the CSP (`index.html:22` `script-src 'self'` — confirmed) forbids inline scripts, so any guard must be a separate legacy-syntax file. A permanent, undiagnosable white screen for exactly the oldest-device users. *Spot-check: confirmed (CSP + vite.config).*
**Fix (S):** raise minSdk, or add an ES5 external guard script that shows "update Android System WebView".

## 10. Mobile onboarding

Covered pieces: MF-24 (the language toggle — the first necessary tap for the primary audience — is in the status-bar zone at ~27px on the auth/onboarding screens), MF-06 (onboarding never asks for notification permission at any of its six steps, leaving the social core mute by default), and MF-02/MF-16 (the auth form's password toggle is a 16px bare icon; sub-16px inputs zoom on iOS from the first screen). The onboarding flow itself (language → mode quiz → first account) is well-adapted to mobile; the failures are chrome-level, not flow-level.

## 11. Mobile-only bugs

**MF-01 (high, borderline critical) — Money can be left half-moved server-side on a flaky network; compensation and refetch fail in the same outage; the outbox that would fix it is inert.**
Multi-leg money mutations (debit A, credit B, write transaction row) are sequential Supabase calls with client-side LIFO compensations. The module's own header states the failure plainly: "Compensations may themselves fail (same network outage that killed the forward write usually kills the inverse)" (`src/lib/mutationSafety.ts:10-13` — confirmed by full read; `runSafeMutation` at 57-73 confirmed: on rollback failure it invokes `onRollbackFailure` — typically a refetch that also fails offline — then rethrows). The offline outbox is a scaffold: `ENABLED = import.meta.env.VITE_ENABLE_OUTBOX === 'true'` with "all dispatch handlers throw" (`src/lib/outboxRunner.ts:26-29` — confirmed; App.tsx:253-264 comment "currently inert" — confirmed). Only 4 entity types are Dexie cache-first (`mirrorCache.ts:7`); committees, groups, EMIs, goals, investments, persons render empty offline.
Scenario: AED 2,000 wallet→bank transfer on flaky WiFi; the wallet debit RPC commits, the bank credit times out, the compensating credit times out too. Server truth: 2,000 vanished from the wallet; the user sees a generic error and stale balances. On the audit's severity scale this is money-corruption class; it is rated high rather than critical only because the user sees an error (not silent) and a later refetch surfaces true — if wrong — balances for manual repair. Mid-flow drops are routine, not exceptional, on the target market's networks. *Spot-check: confirmed.*
**Fix (L):** short term, persist a "pending compensation" record in Dexie and replay on connectivity (a one-table mini-outbox for inverses only); long term, move multi-leg money moves into single SECURITY DEFINER RPCs so atomicity lives in Postgres.

**MF-11 (medium) — loanStore and emiStore resolution paths never force-reschedule reminders, violating the repo's own contract.**
The contract ("any resolution must force-reschedule or a settled bill can still ring") lives at `transactionStore.ts:644-653` and is honored by transactionStore (5 `nudgeReminderSchedule()` call sites), committeeStore, recurringStore, and upcomingExpenseStore — grep confirmed those are the *only* stores calling `rescheduleNotifications`. `loanStore.applyRepayment` (the primary splits_only repayment path, also used by consolidated repayment), `deleteLoan`, `updateLoan`, and every `emiStore` mutation have zero calls (grep confirmed: no matches in loanStore.ts or emiStore.ts). The resume-path reschedule (`nativeBridge.ts:94`) is non-forced, so it does not reliably cover this. Scenario: a splits-only user records full repayment at 09:55; the 10:00 "qist due today" reminder still fires — the exact "paid bill rings" failure class the repo's lessons file records as previously shipped and fixed elsewhere. *Spot-check: confirmed.*
**Fix (S):** add the same dynamic-import `nudgeReminderSchedule({force:true})` to `applyRepayment`, `deleteLoan`, `updateLoan`, and emiStore mutations.

Also mobile-only in effect: MF-02 (PWA keyboard), MF-26 (iOS scroll bleed), MF-03/MF-07/MF-08 (Android-wrapper-only), MF-16 (iOS-only).

---

## Code-level limits & required real-device test matrix

This audit ran with **no device farm and no iOS project** (the repo contains none); every behavioral claim about keyboards, notches, Doze, OEM battery managers, and WebView versions is inference from code facts plus documented platform semantics. Before launch, real-device testing must cover:

1. **Keyboard occlusion** on the deployed PWA: Chrome/Android (with and without `interactive-widget`), iOS Safari, iOS standalone PWA — focus the AI composer and a QuickEntry Save footer (MF-02).
2. **iOS focus-zoom** on sub-16px fields (contact search, AI composer, split amounts) (MF-16).
3. **Safe areas**: notched iPhone standalone PWA (toast layer, language toggle); Android 15 edge-to-edge with targetSdk 35 (`env(safe-area-inset-*)` inside the Capacitor WebView) (MF-17, MF-24).
4. **Deep links**: cold-start and warm-start invite taps, before and after assetlinks deploy, with Play-signed builds (MF-03, MF-04).
5. **Notifications**: delivery latency under Doze on Xiaomi/Oppo/Vivo/Tecno/Infinix; behavior after force-stop; exact-alarm drift at the 10:00 slot; FCM with a real `google-services.json` build (MF-05, MF-09, MF-10).
6. **Urdu IME**: Gboard transliteration + SwiftKey composition with `captureInput: true` on and off (MF-30).
7. **Cold start**: measured time-to-interactive on a sub-$150 device over 3G; splash-to-paint gap (MF-14, MF-15, MF-31).
8. **Flaky-network money mutations**: airplane-mode toggles mid-transfer to observe the half-moved state and recovery UX (MF-01).
9. **Back button**: exit from home screen; back with confirm sheet/scanner/search open (MF-07, MF-08).
10. **Stale WebView**: Android 7-8 device with WebView updates disabled (MF-33).
11. **Storage eviction**: low-storage device soak to observe session/reminder loss (MF-13).

## Evidence-unavailable / further investigation

Explicitly not determinable from this repository:

- **Whether `env(safe-area-inset-*)` resolves non-zero** inside the Capacitor Android WebView on Android 15 edge-to-edge devices; all iOS-PWA findings rest on documented Safari behavior, not device runs (no iOS project exists).
- **Actual keyboard-occlusion behavior** on the deployed Vercel PWA in current Chrome/Android and iOS Safari builds (inferred from Chrome 108+ visual-viewport semantics + absence of `interactive-widget`/`visualViewport` handling).
- **Real rendered widths** of Roman-Urdu strings and nav labels on 320-360px devices (estimated from font sizes and character counts).
- **Effect of `captureInput: true`** on Gboard/SwiftKey Urdu transliteration (documented Capacitor tradeoff; no test evidence either way).
- **Play Console state**: pre-launch report results, Play App Signing enrollment (needed for the second assetlinks fingerprint), target-SDK compliance (which governs Android 15 forced edge-to-edge), rollout status.
- **Whether the machine that produced the existing signed AAB** had `google-services.json` and `keystore.properties` present — both gitignored, so the shipped binary's FCM state is unknown; the *checkout* verifiably builds without FCM.
- **Vercel production state**: whether `/.well-known/assetlinks.json` was ever deployed out-of-band (absent from `public/` and `dist/` in the repo — verified).
- **Supabase Studio state**: which of the 40 manual migrations are applied in production — this determines how much version-skew risk MF-12 carries today.
- **Real-device behavior**: notification delivery latency under Doze, OEM force-stop semantics per brand, field WebView versions, measured cold-start times.
- **FCM token rotation while killed** (stale-token accumulation in `device_push_tokens`) depends on the push-notify edge function's production config.

## Refuted during verification

None — no findings in this phase were adversarially refuted (all arrived UNVERIFIED); the lead auditor's spot-checks confirmed every load-bearing citation that was re-opened, with two scope corrections noted inline: MF-04's present-day harm is browser fallback rather than total link loss (the manifest's own comment, `AndroidManifest.xml:27-42`), and MF-01 is rated high rather than critical because the failure is user-visible, not silent.
