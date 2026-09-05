# Hisaab Android Release Guide

Step-by-step from a fresh checkout to a Google Play production release. Follow in order — earlier steps are prerequisites for later ones.

---

## 0. Prerequisites (one-time, on your development machine)

1. **Java JDK 17+** — required by Android Gradle Plugin 8.x. `java -version` should print 17 or later.
2. **Android Studio** with Android SDK 36 installed (Settings → Languages & Frameworks → Android SDK).
3. **Node 22+** and `npm` (already required by the project).
4. **A Google Play Console developer account** ($25 one-time). Create at https://play.google.com/console.
5. **The domain `usehisaab.com` set up with a working privacy policy + terms + delete-account page.** These three URLs must return HTTP 200 before Play submission — Google's review will reject a 404.

---

## 1. Generate the upload keystore

> **Status 2026-09-05: done** — `android/app/hisaab-upload.jks` exists on the founder's machine and is backed up. Kept here for a fresh machine or a re-key.

The keystore is a single file that signs every release build. **If you lose it, you can never update the app on Play** — there is no recovery. Back it up to a secure location (1Password / encrypted USB / etc.) the moment you generate it.

Run from the project root:

```bash
keytool -genkey -v \
  -keystore android/app/hisaab-upload.jks \
  -keyalg RSA -keysize 2048 -validity 10000 \
  -alias hisaab-upload
```

It will prompt for:
- A keystore password (twice) — pick something long, save it to your password manager.
- A key password — for simplicity, use the same as the keystore password (just hit Enter when prompted).
- Your name, organisational unit, organisation, city, state, country code (e.g., `PK`). These end up embedded in the certificate but aren't shown to users.

Verify the file was created and is NOT tracked by git:

```bash
ls android/app/hisaab-upload.jks   # should exist
git status                          # should NOT show the .jks file
```

The `.gitignore` already excludes `*.jks`, `*.keystore`, and `android/keystore.properties`.

---

## 2. Create `android/keystore.properties`

> **Status 2026-09-05: done** on the founder's machine (git-ignored). Kept here for a fresh machine.

Create the file `android/keystore.properties` with these four lines (substituting your actual passwords):

```properties
storeFile=app/hisaab-upload.jks
storePassword=YOUR_KEYSTORE_PASSWORD_HERE
keyAlias=hisaab-upload
keyPassword=YOUR_KEY_PASSWORD_HERE
```

`storeFile` is **relative to the `android/` directory**, so `app/hisaab-upload.jks` resolves to `android/app/hisaab-upload.jks`.

Verify `android/app/build.gradle` (already set up) will read this file at build time — no edits needed.

---

## 3. Verify the dev build works first

Before doing anything signed, make sure the unsigned debug build still installs cleanly. From the project root:

```bash
npm run build               # builds the web app into dist/
npx cap sync android        # copies dist/ → android/app/src/main/assets/public + updates Capacitor plugins
```

Then in Android Studio:
- File → Open → select the `android/` directory.
- Wait for Gradle sync to finish.
- Connect an Android phone via USB (Developer Options → USB Debugging enabled) OR start an emulator from Tools → Device Manager.
- Click Run (green play icon). Hisaab should install and launch.

If anything errors out here, fix it before moving on to signed builds. Common issues:
- "SDK location not found" → set `ANDROID_HOME` env var, or create `android/local.properties` with `sdk.dir=C:/Users/<you>/AppData/Local/Android/Sdk`.
- Gradle sync hangs → File → Invalidate Caches and Restart.

---

## 4. Build a signed release AAB

The Android App Bundle (`.aab`) is what you upload to Play. From the project root:

```bash
npm run build
npx cap sync android
cd android
./gradlew bundleRelease         # Linux/macOS
# OR on Windows:
gradlew.bat bundleRelease
```

The output appears at `android/app/build/outputs/bundle/release/app-release.aab`. This is the file you upload to Play.

To smoke-test the signed build on a physical device before uploading, generate an APK instead:

```bash
./gradlew assembleRelease       # outputs android/app/build/outputs/apk/release/app-release.apk
```

Side-load with `adb install android/app/build/outputs/apk/release/app-release.apk`. The signed APK behaves identically to the AAB once Play extracts it.

---

## 5. Get your release SHA-256 fingerprint (needed for deep links)

The Android App Link for `https://usehisaab.com/join/*` only works if Google can verify the app was signed by the same key the website declares. Two keys matter:

**Upload key** (this step) — signs the AAB you upload and any side-loaded `assembleRelease` APK. Run:

```bash
keytool -list -v -keystore android/app/hisaab-upload.jks -alias hisaab-upload
```

Look for the line `SHA256: AA:BB:CC:...:ZZ`. Copy that full fingerprint (with colons). It is already in slot 0 of `public/.well-known/assetlinks.json`.

**Play app-signing key** — Play App Signing is **mandatory** for every AAB upload (there is no opt-out), so what users actually install from Play is re-signed with a key Google holds. That fingerprint only exists after the first upload: Play Console → Setup → App Integrity → App signing → "App signing key certificate (SHA-256)". It goes into slot 1 of `assetlinks.json` (Step 6). Until it is there, App Links verify on a side-loaded upload-key APK but not on the Play-installed build.

---

## 6. Deploy `assetlinks.json` to usehisaab.com

The file lives in the repo at `public/.well-known/assetlinks.json` and deploys with the web app, so it is served at `https://usehisaab.com/.well-known/assetlinks.json` over HTTPS with `Content-Type: application/json`. It already holds the upload-key fingerprint in slot 0 and the placeholder `REPLACE_WITH_PLAY_SIGNING_KEY_SHA256` in slot 1:

```json
[{
  "relation": ["delegate_permission/common.handle_all_urls"],
  "target": {
    "namespace": "android_app",
    "package_name": "com.usehisaab.app",
    "sha256_cert_fingerprints": [
      "<upload-key SHA-256 from Step 5 — slot 0, already filled>",
      "REPLACE_WITH_PLAY_SIGNING_KEY_SHA256"
    ]
  }
}]
```

**After the first upload** (Step 8), replace the slot-1 placeholder with the Play app-signing SHA-256 from Step 5, push, and let Vercel redeploy. Keep both fingerprints: slot 0 verifies side-loaded upload-key APKs, slot 1 verifies what Play installs. Play App Signing is mandatory for AABs, so slot 1 is not optional.

**Redirects break verification.** Android's verifier fetches the file from the host exactly as the manifest declares it — `android:host="usehisaab.com"`, the apex only (`android/app/src/main/AndroidManifest.xml`) — and does **not** follow redirects. Today the apex `https://usehisaab.com` 307-redirects to `https://www.usehisaab.com`, so verification fails until the Vercel domain flip makes the apex primary (www → apex 308). After the flip, `curl -sI https://usehisaab.com/.well-known/assetlinks.json` must return `200` with no `Location` header. Do **not** add `www.usehisaab.com` to the manifest as a workaround — invite links are minted on the apex (`VITE_PUBLIC_APP_URL`), and a second host would only be a second thing to keep verified.

Verify with Google's tool once the apex answers directly:
```
https://digitalassetlinks.googleapis.com/v1/statements:list?source.web.site=https://usehisaab.com&relation=delegate_permission/common.handle_all_urls
```

Should return a JSON document listing the package. If it doesn't, fix the file (or the redirect) before continuing — Android won't verify the link otherwise and invite URLs will keep opening the browser.

---

## 7. Set up the test reviewer account

Google's reviewers need working credentials to test the app. Before submitting:

1. **Create a dedicated test account** in Supabase Auth, e.g. `hisaab.reviewer@interior-360.com` with a strong password.
2. **Sign in as that account** on a test device and seed it with realistic data:
   - At least 3 accounts (e.g. "Cash AED", "ADCB AED", "Meezan PKR").
   - At least 5–10 transactions covering each type (expense, income, transfer, loan_given, loan_taken, repayment, goal_contribution).
   - At least 1 contact with a linked profile.
   - At least 1 active loan with an EMI schedule.
   - At least 1 group with a split expense.
3. **Document the credentials** in Play Console → App content → Test account (restricted to Google reviewers only).

---

## 8. First-time Play Console upload

1. **Create the app**: Play Console → All apps → Create app. Fill name (Hisaab), default language, app type (App), free/paid (Free). Accept declarations.
2. **App content** (mandatory questionnaire):
   - **Privacy policy URL**: `https://usehisaab.com/privacy` — the apex is canonical. Until the Vercel domain flip, the apex 307-redirects to `https://www.usehisaab.com/privacy`, which is what answers 200 today; paste the apex URL anyway — it resolves through the redirect now and directly after the flip.
   - **Data Safety form** — `docs/play-store-data-safety.md` is the single source; [Section 9 below](#9-data-safety-form-answers) lists only what changed for this build.
   - **Ads**: No ads.
   - **App access**: Provide the reviewer credentials from Step 7.
   - **Content rating** (IARC questionnaire) — expected result "Everyone". Answer:
     - Violence, sexual content, language, controlled substances, discrimination: **No** to all.
     - Gambling: **No** — no simulated gambling, no real-money gambling. Kameti/committee is a savings rotation the members run themselves, with a fair draw for turn order only; there is no stake, no prize, no odds, and Hisaab never holds money — it just records the rounds.
     - User interaction: **Yes** — users share information and communicate with other users (shared groups, invite links / join codes, linked khata, kameti members), and can share personal info (name, optional phone) with each other. Block-and-report is built in. Location sharing: **No**.
     - Digital purchases: **No** (no in-app purchases in this build).
     - User-generated content: yes, but visible only to the user and the people they share a group/khata with — never public.
   - **Target audience**: 13+ (general audience, no specific child-directed features).
   - **News app**: No.
   - **COVID-19 contact tracing**: No.
   - **Government app**: No.
   - **Financial features**: Declare **"My app does not provide any financial features"** — Hisaab is a personal finance manager / record-keeper. It never lends, moves, holds or exchanges money; no wallet, no payments, no credit; kameti is recorded, not operated. Do NOT pick loans, money transfer or digital wallet — the listing copy is written to match this declaration.

3. **Closed testing first.** A new developer account cannot publish to production until the closed test in Section 10 has run: Testing → Closed testing → Create track → Create new release. Drop the `app-release.aab` from Step 4 (`versionCode 1` / `versionName 1.0.0`) onto the upload area. This first upload enrols the app in **Play App Signing** — mandatory for AABs, not a choice; accept it, then go back to Step 6 and put Play's signing fingerprint into `assetlinks.json` slot 1.
4. **Release notes** — paste this corrected v1.0.0 text (en-US, 492 chars; the Roman-Urdu locale version is in `docs/play-store-listing.md`, same section). The older drafts — "USD, EUR, GBP", "works offline", the 8-currency list — are all retired; do not restore them.
   ```
   Hisaab v1.0.0 — first release. Your money, always in sight.

   Track expenses, income, khata/udhaar, splits, savings goals and budgets in any currency — PKR, AED, SAR and every other world currency. Run your kameti/committee with a provably-fair draw and a witness link. WhatsApp reminders, receipt photos, push alerts, coach cards. Secure cloud sync, no ads. English + Roman Urdu.

   Hisaab only tracks money you already have — it never holds, lends or moves it. Internet needed to save entries.
   ```
5. **Save → Review release → Start rollout to Closed testing.** Run the tester period (Section 10), then promote that same release: Production → Create new release → Send for review.

---

## 9. Data Safety form answers

The Data Safety questionnaire is the most important Play form. Get this wrong and your app gets removed. **`docs/play-store-data-safety.md` is the single source of truth for the form** — fill it from that document, row by row, and keep the two in sync. The answer table that used to live here was a stale duplicate of it; the four things that changed for the v1.0.0 build are recorded here so this section is never silently wrong:

1. **Device or other IDs → collected: YES, shared: YES (Google — Firebase Cloud Messaging).** Push is live (Firebase project `hisaab-2`). When the user turns notifications on, the app stores an FCM registration token in `public.device_push_tokens`; that token plus the notification title/body/deep-link go to Google for delivery. Purpose: app functionality. Optional (user-initiated). Deleted on sign-out, opt-out and account deletion. (Was: No.)
2. **Crash logs / diagnostics → collected: YES, shared: YES (Sentry GmbH, EU).** The release build ships Sentry — `VITE_SENTRY_DSN` is baked in from the build machine's `.env`. Not optional (not user-controllable), but `sendDefaultPii: false` — no names, amounts or user IDs. Analytics is **not** collected in this build: PostHog is off (no `VITE_POSTHOG_KEY`), so do not declare App interactions / User IDs as collected for analytics or shared with an analytics provider.
3. **Photos and videos + Files and docs → collected: YES (optional), not shared.** Receipt photos/PDFs the user attaches to a transaction, stored in a private Supabase Storage bucket readable only by that account (5 MiB, MIME-allowlisted), removed with the transaction / the account (see the deletion note in the data-safety doc on logical vs physical purge). The `CAMERA` permission is declared (QR scanner via `getUserMedia`, receipt capture) with `required="false"`; the app never reads the device gallery or contact list on its own.
4. **Phone number → collected: YES (optional), not shared — and also used for opt-in discovery.** Contacts' numbers the user types, plus the user's own number when the Settings toggle "discoverable by phone" is on (off by default). The old "local-only" note was wrong: the number is stored server-side for that lookup. The app never reads the device contact list; Contacts and Location stay **Not collected**.

Unchanged and still true: **encryption in transit** YES (HTTPS to Supabase, Sentry and FCM); **encryption at rest on device** No — the local Dexie (IndexedDB) mirror stores financial data in plaintext inside the app sandbox, disclose it honestly; **data deletion** YES — in-app Settings → Delete account (current password + type `DELETE`; refused while the user still owns a shared group with other members, or owes / is owed in a shared group that still has another member — transfer ownership / settle first), plus `https://usehisaab.com/delete-account` and `support@usehisaab.com`; **third parties**: Supabase (hosting), Sentry GmbH (crash reports), Google / Firebase Cloud Messaging (push).

---

## 10. Closed testing (required for new developer accounts)

A brand-new Google Play developer account cannot publish directly to production. Play currently requires **at least 12 testers opted in for at least 14 continuous days** — Play Console → Dashboard shows the live requirement and the live tester count for your account; trust that number over this doc if they ever differ. Each tester opts in by opening the tester URL while signed in to their Google account.

**Setup** (this is the first upload — Step 8.3 already put the AAB on this track):
- Play Console → Testing → Closed testing → the track created in Step 8.
- Create a Google Group (e.g. `hisaab-testers@googlegroups.com`) or paste 12+ tester email addresses directly.
- Send the opt-in URL to all testers; they must each open it on an Android device, click "Become a tester", and install from Play — a side-loaded APK does not count.
- Testers should actively use the app for the whole window; Play tracks "active testers", not just opt-ins.
- Play App Signing was enrolled at this first upload (mandatory for AABs). While the test runs, finish Step 6 slot 1 so App Links verify on the Play-signed build the testers actually have.
- When the Console marks the requirement met, apply for production access, then promote the release (Step 8.5).

For an established developer account that has already shipped at least one app, this requirement is waived.

---

## 11. Versioning between releases

Every Play upload must have a **strictly higher** `versionCode` than the previous one. The `versionName` (user-facing, e.g. `1.0.0`) can be any string but should follow semver. The first upload is `versionCode 1` / `versionName "1.0.0"` — already set in `android/app/build.gradle` and `package.json`.

For each release:

1. Edit `android/app/build.gradle`:
   ```gradle
   versionCode 2          // was 1
   versionName "1.0.1"    // was "1.0.0"
   ```
2. Edit `package.json` to match `versionName`:
   ```json
   "version": "1.0.1"
   ```
3. Rebuild + re-sign per Steps 4–5.

`versionCode` is a 32-bit integer — typical convention is to bump it by 1 per release (1, 2, 3, ...). Don't reset, don't skip backward.

---

## 12. Privacy policy / terms / delete-account page checklist

The **apex** `https://usehisaab.com` is the canonical host — the App Link manifest, `VITE_PUBLIC_APP_URL` and every URL you paste into Play use it. Until the Vercel domain flip lands, the apex **307-redirects to `https://www.usehisaab.com`**, and www is what answers 200 today; after the flip the apex answers directly and www 308s to it. Before Play submission, verify each of these returns HTTP 200 in a browser (not 404, not 503, not a redirect to login):

- [ ] `https://usehisaab.com/privacy` — Privacy Policy
- [ ] `https://usehisaab.com/terms` — Terms of Use
- [ ] `https://usehisaab.com/delete-account` — Account deletion instructions (must state both refusals: transfer any group you own that still has members, and settle any open shared-group balance, first)
- [ ] `https://usehisaab.com/contact` — Support contact
- [ ] `https://usehisaab.com/.well-known/assetlinks.json` — Deep-link verification (Step 6). **This one must be 200 on the apex with no redirect at all** (`curl -sI` shows no `Location` header) because Android's verifier does not follow redirects — only true after the Vercel flip.

The privacy policy MUST explicitly cover:
- What personal info is collected (email, name, optional phone — and that the phone number is used for opt-in "discoverable by phone" lookup, off by default).
- What financial info is collected (transactions, loans, balances, investment records, kameti rounds).
- Receipt photos/PDFs: user-attached, private storage bucket, readable only by that account.
- Camera: used on-device for the QR scanner and receipt capture; nothing leaves the device except the receipts the user chooses to attach.
- That data is processed by Supabase (sub-processor disclosure).
- Push notifications: a device token and the notification text go to Google (Firebase Cloud Messaging) when notifications are turned on.
- That crash reports are sent to Sentry (enabled in the release build; no names, amounts or user IDs).
- Product analytics: only "if enabled in a release and you agree" — not enabled in this build.
- How users can delete their data, including the two conditions under which deletion is refused.
- A contact email for privacy concerns (`support@usehisaab.com`).

The current `PublicInfoPages.tsx` covers most of this in-app, but Google needs a publicly-hosted URL, not just the in-app version.

---

## 13. Pre-submission smoke test (on a physical Android device)

Side-load the release APK (Step 4) and run through this list:

- [ ] Splash → login → sign up flow works end-to-end on a fresh install
- [ ] Email verification gate appears for unverified accounts
- [ ] Add 1 account (Cash PKR), confirm balance saves
- [ ] Add 1 expense from Cash, confirm balance decreases
- [ ] Tap "+" FAB → Quick Entry opens, completes a full transaction
- [ ] Settings → Change password → it asks for the CURRENT password first (`src/lib/passwordPolicy.ts`: 8+ chars, at least one letter and one digit). Try `abcdefg1` (7 chars) → rejected; `abcdefgh` (no digit) → rejected; `12345678` (no letter) → rejected — each with the checklist message and Save disabled. Enter `hisaab2026` → accepted. Try once more with a wrong current password → refused with the re-auth error
- [ ] Open a loan → tap "Record payment" → enter overpayment → verify inline error and Save disabled
- [ ] Cross-currency: transfer Cash PKR → ADCB AED, enter rate of "0" → verify error; enter "0.012" (in valid range) → verify accepted
- [ ] Background the app for 5+ minutes, return → confirm session still works, no opaque error
- [ ] Press hardware back from inside a modal → modal closes; from a list page → navigates back; from home → exits
- [ ] Push: Settings → turn notifications on → allow the Android permission → force-stop the app (App info → Force stop) → from a second account, trigger an event for this user (send a loan request, or add an expense to a shared group) → a tray notification arrives with the Hisaab "h" glyph in the status bar (not a bell, not a blank square) → tapping it opens the right screen. If nothing arrives, check `public.device_push_tokens` has a row for this device before blaming FCM
- [ ] Send invite link to yourself via WhatsApp, tap it → Hisaab opens directly. This verifies only after (1) the Vercel flip makes the apex serve `assetlinks.json` with 200 and no redirect, and (2) for a Play-installed build, the Play app-signing fingerprint is in slot 1 (Step 6). A side-loaded upload-key APK needs only (1). Until then the link opens in the browser, where the web app handles it — expected, not a bug. Check with `adb shell pm get-app-links com.usehisaab.app` → `usehisaab.com: verified`
- [ ] Settings → Delete account → enter the current password + type `DELETE`. Walk both refusals first: (a) while this account still owns a shared group that has other members → refused, with the "assign another admin" path offered; (b) after transferring ownership, while this account still owes / is owed in a shared group with another member → refused, "settle first" (the same rule as leaving a group). Settle, then delete → confirm the account is gone (sign-in with the same email fails) and this device's `device_push_tokens` row went with it

If anything in this list fails, fix it before submitting.

---

## 14. Post-launch monitoring

Once live:

- **Crashes**: monitor Play Console → Quality → Android vitals → Crashes. Stay below 1.09% crash-free-session rate (Play's "bad behavior" threshold).
- **Sentry**: review at https://sentry.io daily for the first week, weekly after.
- **Support inbox** (`support@usehisaab.com`): respond within 24h for the first month.
- **Play Console reviews**: respond to negative reviews within 48h.

---

## Appendix: Quick reference

| Action | Command |
|--------|---------|
| Web dev server | `npm run dev` |
| Tests | `npm test` |
| Lint | `npm run lint` |
| Type-check | `npx tsc -b --noEmit` |
| Build web | `npm run build` |
| Sync to Android | `npx cap sync android` |
| Open in Android Studio | `npx cap open android` |
| Run on connected device (debug) | `npm run cap:run:android` |
| Build release APK | `cd android && ./gradlew assembleRelease` |
| Build release AAB | `cd android && ./gradlew bundleRelease` |

---

## What's NOT yet in the code

Done on the founder's machine / in production as of 2026-09-05: the upload keystore (Step 1), `android/keystore.properties` (Step 2), `assetlinks.json` with the upload-key fingerprint in slot 0 (Step 6), `VITE_SENTRY_DSN` in the build environment, every Supabase migration, and the FCM server side (`docs/push-notifications-setup.md`). Still your responsibility before Play submission:

1. **Create the reviewer test account + seed data** (Step 7) and enter it under App access.
2. **Play app-signing fingerprint → `assetlinks.json` slot 1** (Steps 5–6) — only obtainable after the first upload; replace `REPLACE_WITH_PLAY_SIGNING_KEY_SHA256`, push, let Vercel redeploy.
3. **Flip Vercel so the apex is primary** (www → apex 308), then re-verify every URL in Step 12 — `assetlinks.json` must be 200 with no redirect on the apex.

Everything else (Capacitor config, signing infrastructure, Android manifest, money-flow guards, password policy, CSP, deep-link intent-filter, resume handler, label vocabulary, lockout chips, unit tests) is already in the working tree.
