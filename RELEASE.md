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

The Android App Link for `https://usehisaab.com/join/*` only works if Google can verify the app was signed by the same key the website declares. Run:

```bash
keytool -list -v -keystore android/app/hisaab-upload.jks -alias hisaab-upload
```

Look for the line `SHA256: AA:BB:CC:...:ZZ`. Copy that full fingerprint (with colons).

---

## 6. Deploy `assetlinks.json` to usehisaab.com

Create this file at `https://usehisaab.com/.well-known/assetlinks.json` (must be served over HTTPS with no redirect and `Content-Type: application/json`):

```json
[{
  "relation": ["delegate_permission/common.handle_all_urls"],
  "target": {
    "namespace": "android_app",
    "package_name": "com.usehisaab.app",
    "sha256_cert_fingerprints": [
      "AA:BB:CC:...:ZZ"
    ]
  }
}]
```

Replace `AA:BB:CC:...:ZZ` with the fingerprint from Step 5.

Verify with Google's tool:
```
https://digitalassetlinks.googleapis.com/v1/statements:list?source.web.site=https://usehisaab.com&relation=delegate_permission/common.handle_all_urls
```

Should return a JSON document listing the package. If it doesn't, fix the file before continuing — Android won't verify the link otherwise and invite URLs will keep opening the browser.

**Important:** Google Play also auto-signs your app with its own key (Play App Signing — opt in during first upload). Once that's enabled, you'll need to ALSO add Play's signing fingerprint to the `sha256_cert_fingerprints` array. Get it from Play Console → Setup → App Integrity → App Signing → "App signing key certificate (SHA-256)". Add both fingerprints (upload + Play-signed).

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
   - **Privacy policy URL**: `https://usehisaab.com/privacy`
   - **Data Safety form** — see detailed answers in [Section 9 below](#9-data-safety-form-answers).
   - **Ads**: No ads.
   - **App access**: Provide the reviewer credentials from Step 7.
   - **Content rating**: Run through the IARC questionnaire. Hisaab is "Everyone" — no violence, no profanity, no controlled substances. Just say no to everything except "User-generated content" (transactions/notes are user-generated, but private to the user).
   - **Target audience**: 13+ (general audience, no specific child-directed features).
   - **News app**: No.
   - **COVID-19 contact tracing**: No.
   - **Data Safety** — fill thoroughly; see Section 9.
   - **Government app**: No.
   - **Financial features**: Declare as "Personal finance manager" (NOT lending, NOT money movement). Hisaab tracks money the user already has; it does not move it.

3. **Production track upload**: Production → Create new release. Drop the `app-release.aab` from Step 4 onto the upload area.
4. **Release notes**: For v1.0.0, write something like:
   ```
   Hisaab v1.0.0 — first release.

   Track money, loans, and group expenses with friends and family across
   PKR, AED, PHP, SAR, QAR, OMR, KWD, BHD. Secure cloud storage. Pakistani-Urdu and English UI.
   ```
   <!-- Corrected 2026-09-02 (audit finding 12-qa-review.md F-1): the previous draft claimed
        "USD, EUR, GBP" (unsupported — see src/db/types.ts:1 for the real 8-currency list) and
        "Works offline" (all mutations currently hard-fail offline; the outbox is a disabled
        scaffold). Do not restore either claim until the underlying feature actually ships. -->
5. **Save → Review release → Send for review**. (For first uploads, see Section 10 about closed testing — Play requires it for new developer accounts.)

---

## 9. Data Safety form answers

The Data Safety questionnaire is the most important Play form. Get this wrong and your app gets removed. Hisaab's correct answers:

### Data collection: YES, this app collects user data

**Categories of data collected:**

| Category | Data type | Collected? | Shared with third parties? | Purpose |
|----------|-----------|------------|----------------------------|---------|
| **Personal info** | Name | Yes (optional, user-entered) | No | App functionality |
| **Personal info** | Email | Yes (required for auth) | No | Account management |
| **Personal info** | Phone number | Yes (optional, user-entered for contacts) | No | App functionality |
| **Financial info** | User payment info | **No** | — | We don't collect card numbers, bank account credentials, etc. |
| **Financial info** | Purchase history | Yes (the transactions the user records) | No | App functionality |
| **Financial info** | Credit info | No | — | — |
| **Financial info** | Other financial info | Yes (account balances, loan balances, goal progress) | No | App functionality |
| **App activity** | Other actions | Yes (transaction creates/edits/deletes) | No | Account management |
| **App activity** | Crash logs | Yes (via Sentry, if VITE_SENTRY_DSN is set) | Yes — Sentry GmbH | Analytics, app diagnostics |
| **Device or other IDs** | Device or other IDs | No | — | — |

**Encryption in transit:** Yes (HTTPS to Supabase, HTTPS to Sentry).

**Encryption at rest on device:** **No** — the local Dexie (IndexedDB) mirror stores financial data in plaintext on the device. Disclose this honestly. Android's app-data sandbox protects against other apps reading it, but it is not encrypted.

**User can request data deletion:** Yes — in-app via Settings → "Delete account", and via email to `support@usehisaab.com`. Provide the URL `https://usehisaab.com/delete-account`.

**Data is shared with third parties:** Yes, with Supabase (storage provider) and Sentry (crash reporting). Mark both.

---

## 10. Closed testing (required for new developer accounts since 2023)

If this is a brand-new Google Play developer account, you cannot publish directly to production. You must:

1. Run **closed testing** with **at least 12 testers** for **at least 14 days continuously**.
2. Each tester must opt in by clicking a tester URL while signed in to their Google account.

**Setup**:
- Play Console → Testing → Closed testing → Create track.
- Upload the same AAB to the closed track.
- Create a Google Group (e.g. `hisaab-testers@googlegroups.com`) or paste 12+ tester email addresses directly.
- Send the opt-in URL to all testers; they must each open it on an Android device and click "Become a tester".
- Wait 14 days. Testers should actively use the app; Play tracks "active testers".
- After 14 days of continuous testing with 12+ opted-in testers, you can promote to production.

For an established developer account that has already shipped at least one app, this requirement is waived.

---

## 11. Versioning between releases

Every Play upload must have a **strictly higher** `versionCode` than the previous one. The `versionName` (user-facing, e.g. `1.0.0`) can be any string but should follow semver.

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

Before Play submission, verify each of these returns HTTP 200 in a browser (not 404, not 503, not a redirect to login):

- [ ] `https://usehisaab.com/privacy` — Privacy Policy
- [ ] `https://usehisaab.com/terms` — Terms of Use
- [ ] `https://usehisaab.com/delete-account` — Account deletion instructions
- [ ] `https://usehisaab.com/contact` — Support contact
- [ ] `https://usehisaab.com/.well-known/assetlinks.json` — Deep-link verification (Step 6)

The privacy policy MUST explicitly cover:
- What personal info is collected (email, name, phone).
- What financial info is collected (transactions, loans, balances).
- That data is processed by Supabase (sub-processor disclosure).
- That crash reports are sent to Sentry (if enabled).
- How users can delete their data.
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
- [ ] Open Settings → Change password → enter 12-char password with letters+digits → verify accepted; try a 6-char password → verify rejected with friendly message
- [ ] Open a loan → tap "Record payment" → enter overpayment → verify inline error and Save disabled
- [ ] Cross-currency: transfer Cash PKR → ADCB AED, enter rate of "0" → verify error; enter "0.012" (in valid range) → verify accepted
- [ ] Background the app for 5+ minutes, return → confirm session still works, no opaque error
- [ ] Press hardware back from inside a modal → modal closes; from a list page → navigates back; from home → exits
- [ ] Send invite link to yourself via WhatsApp, tap it → confirm Hisaab opens (after `assetlinks.json` is deployed)
- [ ] Settings → Delete account → type DELETE → confirm account is gone (sign-in attempt with same email fails)

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

These are still your responsibility before Play submission:

1. **Generate the keystore** (Step 1).
2. **Create `android/keystore.properties`** (Step 2).
3. **Deploy `assetlinks.json` to usehisaab.com** (Step 6).
4. **Create the reviewer test account + seed data** (Step 7).
5. **Verify all public URLs are live** (Step 12).
6. **Set the `VITE_SENTRY_DSN` env var** for the production build (in your CI or `.env.production`), OR remove Sentry from `main.tsx` if you decide not to use crash reporting.

Everything else (Capacitor config, signing infrastructure, Android manifest, money-flow guards, password policy, CSP, deep-link intent-filter, resume handler, label vocabulary, lockout chips, unit tests) is already in the working tree.
