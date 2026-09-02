# Hisaab Play Store Data Safety Notes

Last reviewed: May 31, 2026

This is an internal developer note for preparing the Google Play Console Data Safety form. It is based on the current Hisaab codebase and must be checked against the final production environment, Supabase project settings, Vercel settings, and the Android release build before submission.

## Product Scope

Hisaab is a personal finance record-keeping app. It is not a bank, wallet custody provider, lender, money transfer provider, investment platform, or financial adviser.

## Likely Data Collected

| Data category | Current code evidence | Required or optional | Primary purposes |
| --- | --- | --- | --- |
| Email address and authentication identifiers | Supabase Auth signup, login, email verification, password reset, and session persistence | Required for account access | Account management, authentication, security |
| Name and profile settings | `profiles`, onboarding, Settings, local storage cache | Name and core settings required for setup; optional phone value may be entered in Settings | App functionality, personalization, support |
| Financial information | Accounts, balances, income, expenses, transfers, loans, repayments, goals, budgets, recurring entries, remittance records, notes, categories, and currencies | Optional user-created records, but core to app functionality when used | App functionality, sync, reports, summaries |
| Collaboration records | Groups, members, split expenses, settlements, invite records, linked loan and settlement requests | Optional, only when collaboration features are used | App functionality, user-requested sharing |
| Manually entered contacts | `persons` table; the optional contact **phone number IS cloud-synced** to Supabase (`persons.phone`, + committee member phone) — disclose Phone number = collected | Optional | App functionality for loans and linked records |
| In-app notification records | `notifications` table for group updates and requests | Generated when applicable | App functionality |
| Local app data | Local storage settings, Supabase browser session persistence, local PIN hash, IndexedDB/Dexie mirror and outbox tables | Generated as needed | Session persistence, local app lock (⚠️ hash is stored but `PinLockScreen` is never rendered — the lock does not currently gate app access, see note below), reliability, offline sync scaffolding (⚠️ scaffold only — the outbox is disabled and every dispatch handler throws; no offline writes actually sync) |
| Crash and diagnostic context | Sentry — **ENABLED in this build** (`VITE_SENTRY_DSN` is configured). Sends exceptions, stack traces & diagnostic context to Sentry GmbH (EU region). `sendDefaultPii: false`; no user ID attached at any current call site | Collected; **shared with Sentry** | Debugging, security, service reliability |

## Sharing

- Hisaab does not include advertising SDKs and the codebase does not show sale of user data.
- Supabase processes authentication and cloud data storage on Hisaab's behalf.
- Vercel processes hosting and delivery traffic needed to serve the web app.
- Sentry (Sentry GmbH, EU region) processes crash and diagnostic information. **This build has `VITE_SENTRY_DSN` configured, so crash data IS collected and shared with Sentry.** `sendDefaultPii: false`; no user ID is attached at any current call site (keep it that way or re-disclose).
- Users intentionally share limited records with other Hisaab users when they use groups, invites, linked loan requests, or linked settlement requests.
- User-exported JSON backups leave the app only when the user downloads and shares them.

Confirm in Play Console whether service-provider processing should be described as "shared" under the current Google Play definitions and exceptions.

## Encryption in Transit

The app is configured to use HTTPS for the public website, Supabase requests, and the Capacitor Android scheme. Data sent over the network is expected to be encrypted in transit. Confirm the final production domain, Supabase endpoint, and Android release traffic before submission.

## Deletion

Users can start deletion in the app:

1. Sign in.
2. Open Settings.
3. Open **Delete account**.
4. Type `DELETE` and confirm.

The client calls the Supabase `delete_current_user` RPC, signs out, clears user stores, clears user-scoped local storage keys, and awaits deletion of the user's IndexedDB database. After `supabase-migration-p0-launch-blockers.sql` is applied, the RPC permanently deletes the matching `auth.users` identity. Existing foreign keys cascade personal money tables and owned groups; shared references configured with `ON DELETE SET NULL` are anonymized. A stale JWT cannot recreate rows because the Auth identity no longer exists and restrictive active-profile RLS policies reject the deleted user.

The public deletion instructions are available at `https://usehisaab.com/delete-account`. Users can also email `support@usehisaab.com`.

## SDK and Permission Review

Current code review found:

- **Analytics:** no product analytics SDK found.
- **Ads:** no advertising SDK found.
- **Crash reporting:** Sentry integration is **enabled** (`VITE_SENTRY_DSN` configured). Crash/diagnostic data is collected and shared with Sentry GmbH (EU). `sendDefaultPii: false`; no user ID attached at current call sites.
- **Push notifications:** no Android push-notification SDK found. The app has database-backed in-app notifications.
- **Device identifiers:** no dedicated device identifier SDK found.
- **Location:** no location or geolocation SDK usage found.
- **Contacts:** no native address-book permission or contacts SDK found. Users may manually enter contact names and phone numbers.
- **Camera/photos:** no camera permission or photo upload implementation found.
- **Files:** JSON backup export and import exist. Import reads a user-selected `.json` file locally; no arbitrary upload feature was found.
- **Clipboard:** invite URLs and share text can be copied when the user requests it.
- **Payments:** no payment SDK found.

## Human Review Before Submission

0. ⚠️ **Added 2026-09-02:** do not describe the "local PIN hash" row above as an active app-lock security control in the Data Safety form or anywhere else reviewer-facing. `src/pages/PinLockScreen.tsx` has zero importers — a PIN can be set and hashed in Settings, but nothing in the app ever renders the lock screen to enforce it, so it currently protects nothing. Same caveat for "offline sync scaffolding": `src/lib/outboxRunner.ts` is gated behind a disabled flag and every handler throws — there is no working offline write path today. (Source: `docs/audit-2026-09/12-qa-review.md` F-1, `docs/audit-2026-09/00-executive-summary.md` Top Finding #3.)
1. ✅ Resolved: Sentry **is enabled** (`VITE_SENTRY_DSN` configured). Crash logs + diagnostics are collected and shared with Sentry GmbH (EU); `sendDefaultPii: false`, no user ID attached at any current call site — keep it that way or re-disclose.
2. Apply `supabase-migration-p0-launch-blockers.sql`, run `supabase-p0-security-verification.sql`, and confirm provider backup retention after permanent Auth identity deletion.
3. ✅ Resolved: contact phone **IS cloud-synced** (`persons.phone` in Supabase). `hisaab_mobile` in Settings is local-only, but `persons.phone` syncs — so **Phone number = Collected** must be disclosed.
4. Confirm the final Android manifest permissions after regenerating the complete Android wrapper.
5. Confirm that the published privacy policy and deletion page match the production RPC deployed in Supabase.
6. Review Google Play's current Data Safety definitions before completing the console form.
