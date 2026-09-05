<!-- Generated 2026-09-05 by the Play-readiness audit (five parallel checkers +
adversarial verification) against production a5fe530. Companion to
docs/play-first-upload-runbook.md (the order of operations) and
docs/play-store-data-safety.md (the authoritative Data Safety table).
Host note: at generation time the apex 307-redirected to www; once the founder
makes the apex Vercel's primary domain, every www URL below can be the apex. -->

# Hisaab — Play Console answer sheet (closed testing, v1.0.0 / versionCode 1)

Verified against production `a5fe530` on `main`, 2026-09-05. Build assumption for every Data Safety answer below: the AAB is built from the local `.env`, which sets `VITE_SENTRY_DSN` and does **not** set `VITE_POSTHOG_KEY` → **Sentry ON, PostHog OFF**. Re-answer if that changes.

**Rebuild first:** the existing 3.4 MB AAB predates a5fe530 (status-bar glyph). `npm run build && npx cap sync android` then `gradlew.bat bundleRelease` in your own PowerShell. versionCode stays 1 for the very first upload.

**Host rule:** the canonical host is the **apex** `https://usehisaab.com` (it is what the app, the manifest and every generated link use). Until the Vercel flip in the runbook's Phase 0 is done, the apex answers 307 → www and only `https://www.usehisaab.com/...` returns 200 — so if you paste before the flip, paste www and switch to apex afterwards.

---

## 0. Order of operations (saves a week)

1. Create the app (Free, App, default language English (US)).
2. Upload versionCode 1 / 1.0.0 to a **Closed testing** track (Play App Signing is mandatory for AAB uploads — accept the default "Google manages the key"). Save the release without rolling out. Then copy *Setup → App integrity → App signing key certificate SHA-256* and append it as the second entry in `public/.well-known/assetlinks.json` (the placeholder was removed on 2026-09-05), commit, let Vercel deploy. (An Internal testing track first is optional and harmless; it does not need the declarations, but it does not start the 14-day clock either.)
3. Complete Store listing + every App content section below — Play blocks a closed-testing rollout until they are done.
4. Add testers, send the opt-in link, roll out to Closed testing, start the 14-day clock. Full order of operations: `docs/play-first-upload-runbook.md`.

---

## 1. App content → Privacy policy

`https://usehisaab.com/privacy` (paste `https://www.usehisaab.com/privacy` until the apex flip; see Host rule).

Done 2026-09-05: the hosted policy now covers Firebase Cloud Messaging push tokens, receipt attachments, opt-in phone discovery, investment + kameti records, Sentry and PostHog-if-enabled (`src/pages/PublicInfoPages.tsx`). Still absent, deliberately minor: an explicit line on khata/witness links and block/report records.

## 2. App content → App access

Select: **All or some functionality is restricted** → Add instructions.

Do this first (founder, not Claude): create the reviewer account in Supabase Auth, **confirm its email** (App.tsx hard-gates on `email_confirmed_at`), sign in once on a phone and complete onboarding in **Full tracker** mode, then seed per RELEASE.md §7 (3 accounts incl. one non-legacy currency such as USD, 5–10 transactions of each type, a contact, an EMI loan, a group with a split). Do **not** set a PIN on it. Create a second seeded account so the reviewer can see a group with another member.

Instruction text (fill the two placeholders; never paste real credentials anywhere else):

```
Login type: Email + password (no phone/OTP, no social login).
Username: <reviewer email>
Password: <reviewer password>

Notes for review:
- The account is already email-verified and onboarded; open the app, tap Login, enter the credentials above.
- App default language is Roman Urdu; tap the language toggle on the login/onboarding screen or Settings → Language to switch to English.
- Hisaab is a record-keeping app. It never holds, moves, lends or transfers money; every amount is typed by the user.
- Push notifications: Settings → Notifications → enable, then grant the Android notification permission.
- QR connect (camera): Contacts → Connect → Scan QR. Camera is optional; "type the code" works without it.
- Account deletion: Settings → Delete account → type DELETE → enter current password. It is refused while the account still owns a group with other members (assign another admin first) or has an unsettled balance in a shared group (settle first) — both are intentional.
- These public pages need no login: /privacy, /terms, /delete-account, /support, /kameti/witness/<token>, khata links.
```

## 3. App content → Ads

**No, my app does not contain ads.** (No ad SDK; manifest has no `com.google.android.gms.permission.AD_ID`.) Advertising ID question: **No**.

## 4. App content → Content rating (IARC)

Category: **Utility, Productivity, Communication, or Other**. Email: support@usehisaab.com.

| IARC question | Answer | Why |
|---|---|---|
| Violence / blood / sexual content / nudity / language / crude humour / fear / discrimination | No | none |
| Controlled substances, alcohol, tobacco | No | none |
| Simulated gambling | **No** | Kameti (committee/BC) is a rotating savings group: every member pays the same amount and receives the same total; the "parchi draw" only decides the **order** of payouts. No stake, no odds, no prize, no house. Hisaab never handles the money. |
| Real-money gambling / wagering / lotteries with prizes | **No** | same |
| Does the app allow users to interact or exchange content with other users | **Yes** | groups, invites, split expenses, linked loan requests, in-app notifications |
| Does the app share user-provided personal information with other users | **Yes (limited, user-initiated)** | your display name and the amounts/notes you enter in a shared group are visible to that group; opt-in phone discovery lets someone who already has your number find you |
| Does the app share the user's location with others | No | no location |
| Can users purchase digital goods or currency in-app | No | no IAP, no billing SDK |
| Unrestricted web browsing / browser | No | |
| User-generated content visible to others (if asked) | Yes — with in-app **block and report** and a moderation email | `src/components/BlockReportSheet.tsx`, `public.blocks`, `public.reports` |

Expected result: **Everyone** (ESRB E / PEGI 3 / IARC 3+) with the "Users Interact" interactive element.

## 5. App content → Target audience and content

Age groups: **18 and over** only. Reason: a debt/khata/finance app with no child appeal; picking any under-18 group adds Teen/Families questions and (under 13) the Families policy. If asked "Could your app unintentionally appeal to children?" → **No**. Add an 18+ line to the Terms (nit in findings).

## 6. App content → News app

**No** — not a news app.

## 7. App content → COVID-19 contact tracing and status apps

**No** — not a contact-tracing or status app.

## 8. App content → Government apps

**No** — not developed by or on behalf of a government.

## 9. App content → Health apps (if shown)

**My app does not have any health features.**

## 10. App content → Financial features

Select **"My app doesn't provide any of these financial features"** (the form's none-of-the-above option; there is no "personal finance manager" choice). If a free-text box appears:

```
Hisaab is a personal expense, khata (ledger) and budget record-keeping app. Users type in
money they already spent, lent, borrowed, saved or contributed to a savings committee.
The app does not hold, custody, move, transfer, lend, invest or pay out any money, has no
payment or banking integration, and offers no loans, credit, interest, insurance or
trading. Loan and kameti screens are diaries of amounts agreed between the user and
people they know.
```

Do NOT tick personal loans, banking, money transfer/remittance, investment, crypto, BNPL, credit cards, insurance.

## 11. App content → Data safety

**Single source of truth: `docs/play-store-data-safety.md` §1** — it carries the top-level answers and one row per Play data type, corrected on 2026-09-05 for this exact build (Sentry ON, PostHog OFF, FCM live). Paste from there, not from here. The four answers people get wrong:

- **Device or other IDs** → collected **Yes**, shared **Yes — Google LLC (Firebase Cloud Messaging)**, optional (only after the user turns notifications on), purpose App functionality, deleted on sign-out / opt-out / account deletion.
- **Crash logs + Diagnostics** → collected **Yes**, shared **Yes — Sentry GmbH (EU)**, **not** optional (the DSN is baked into the release build; no names or amounts are sent).
- **App interactions** → collected Yes (edit history, consent-gated analytics scaffold), **not shared** — PostHog is not in this build.
- **Purchase history** → **not collected**; user-typed expenses are disclosed under *Other financial info*.

Deletion URL for the form: `https://usehisaab.com/delete-account` (www until the flip), plus in-app Settings → Delete account (current password + type DELETE; refused while the account owns a shared group with members or has an open shared-group balance).

## 12. Store listing (Grow → Store presence → Main store listing)

Use `docs/play-store-listing.md` **after** the three edits: currency line → every ISO 4217 currency; "English by default" → "Roman-Urdu by default, English one tap away"; header blockquote deleted. Feature graphic: `docs/store-assets/feature-graphic-1024x500.png`. Icon: `docs/store-assets/icon-512.png`. Screenshots: capture ≥2 phone shots (tracker Y9) — one Urdu, one English. Category: Finance. Contact email: support@usehisaab.com. Website: https://usehisaab.com (www until the flip).

Release notes — v1.0.0 (≤500 chars, this is 462):

```
Hisaab v1.0.0 — your money, always in sight.

Track expenses, income, khata/udhaar, splits, savings goals and envelope budgets in
every world currency (PKR, AED, SAR, USD, GBP and more). Run your kameti with a
provably-fair draw and a witness link. WhatsApp reminders, receipt photos, coach cards.
Roman-Urdu by default, English one tap away. Secure cloud sync (internet needed to save).
No ads. Hisaab only tracks money you already have — it never holds, lends or moves it.
```

## 13. Closed testing setup

- Testing → Closed testing → **Create track** → name it `hisaab-closed-1` (track name is internal; testers never see it). Countries: Pakistan, UAE, Saudi Arabia, Qatar, Oman, Kuwait, Bahrain, UK, US (or "all").
- Testers → **Create email list** ("Hisaab testers") and paste Google-account emails (the exact Gmail/Workspace address each tester uses on their phone), or use a Google Group. Save, then copy the **opt-in URL** (`https://play.google.com/apps/testing/com.usehisaab.app`).
- Create release → upload the rebuilt AAB (or promote the internal-testing build) → release name = `1.0.0 (1)` → paste the v1.0.0 notes → Review → **Start rollout to Closed testing**.
- Play blocks rollout until the App content sections above, the store listing and content rating are complete.
- Send testers the opt-in URL. Each must: open it while signed in to the listed Google account → tap **Become a tester** → tap the Play Store link → **Install from Play**. A side-loaded APK does not count.
- **"Active tester"** = a listed Google account that has opted in **and** kept the app installed from Play. Play counts continuous days per tester; uninstalling or opting out resets that tester. You need **12 active testers for 14 consecutive days** (read the exact number on Dashboard → *Apply for production access* — Google has changed it before). Recruit 15–16 so drop-offs don't restart the clock.
- After 14 days the dashboard shows **Apply for production access**: a short questionnaire (who tested, what feedback, what you changed). Answer with real feedback — Google reads it. Approval takes days, then Production → Create release with a **higher versionCode** (2) if the build changed.
- During the 14 days: fix bugs freely — new closed-testing releases don't reset the clock as long as testers stay installed.

---

## 14. RELEASE.md §13 smoke test — what's stale, with corrected wording

Run on the rebuilt signed APK (`gradlew.bat assembleRelease`, `adb install`), on Android 13+ so the notification-permission prompt appears.

| # | Original step | Status | Corrected step |
|---|---|---|---|
| 1 | Splash → login → sign up | **stale wording** | Fresh install shows **Roman Urdu** by default (i18n `DEFAULT_LANGUAGE="ur"`); onboarding step 0 offers the language choice — pick English, confirm the choice sticks after relaunch. Sign-up password rule shows 3 live checks (8+ chars, a letter, a digit). |
| 2 | Email verification gate | OK | unchanged |
| 3 | Add 1 account (Cash PKR) | **stale** | Onboarding → Full tracker → create first account "Cash", PKR; then Accounts → add a second account in a **non-legacy ISO currency (e.g. USD)** — confirm it saves (proves the ISO-4217 migration in prod). |
| 4 | Add 1 expense from Cash | OK | unchanged |
| 5 | "+" FAB → Quick Entry | OK (type-first) | Tap + → choose the type first → complete an expense; confirm balance and the transaction row. |
| 6 | Change password (8+ chars, letter + digit) | **stale** | Settings → **Security → Change password**: enter current password; try `abc123` → "too short"; try `abcdefgh` → "needs a letter and a digit"; `abcdef12` → accepted. Wrong current password → re-auth error. |
| 7 | Loan → Record payment → overpayment | OK | Label is "Record payment" / "Payment Record Karo"; overpayment → inline `err_overpayment`, Save disabled. **Repeat in Splits-only mode** on a second account (no account picker; repayment must still appear as a record). |
| 8 | Transfer PKR → AED, rate 0 / 0.012 | OK | Rate `0` → rejected (`RATE_MIN` 0.0001); `0.012` → accepted. Also try `200000` → rejected (`RATE_MAX` 100000). |
| 9 | Background 5 min | OK | unchanged; additionally confirm the resume refresh shows data (no blank list). |
| 10 | Hardware back | OK | unchanged |
| 11 | WhatsApp invite link opens Hisaab | **stale expectation** | Until the apex/www host decision (Y7) is implemented the link opens in the **browser** (307 → www → JoinGroupPage) — that is the expected fallback, not a failure. After assetlinks verifies on the declared host: link opens the app directly; also test a `/u/HSB-…` QR URL and a `/kameti/witness/…` link. |
| 12 | Delete account → type DELETE | **stale** | Settings → Delete account → type `DELETE` **and enter the current password**. On an account that owns a group with members → refusal toast naming the group ("assign another admin"); with an open shared-group balance → refusal ("settle first"). Only a clean account is deleted; sign-in with that email then fails. |

New steps to add (features that did not exist when §13 was written):

- **PIN lock:** Settings → set a 4-digit PIN → background the app > 60 s → returns to PinLockScreen; 5 wrong attempts → 30 s lockout chip.
- **FCM push (killed app):** Settings → Notifications → enable → grant Android permission → swipe the app away → from the second account add a group expense → tray notification arrives with the **Hisaab glyph** (a5fe530), tapping it deep-links to the group.
- **Camera / QR:** Contacts → Connect → Scan QR → Android camera prompt; deny → "type the code instead" still works.
- **Kameti:** create a committee with 3 members → draw → draw button is inert afterwards (server-side, cannot re-roll) → witness link opens without login.
- **Version gate:** (optional) temporarily set `app_config.min_supported_version` above 1.0.0 in Supabase → app shows the update screen; revert.
- **Language round-trip:** Settings → English → Roman Urdu; check the loan, group and kameti screens render in both (no raw keys).
