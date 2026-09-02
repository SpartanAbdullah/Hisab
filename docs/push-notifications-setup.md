# Android push notifications — setup

Everything in the app and the database is already built. What's left is the
part that needs *your* Google account: a Firebase project, its config file,
and one secret. Until you do this, Hisaab still delivers notifications — just
not while Android has the app killed (see "What works before you do this").

Roughly 20–30 minutes, once.

---

## What works before you do this

Two delivery channels already ship and need no configuration:

| Situation | Delivered? | By what |
|---|---|---|
| App open on screen | Yes, instantly | Realtime → in-app list + bell |
| App backgrounded, process alive | Yes, tray notification | `src/lib/instantNotify.ts` |
| App killed / phone rebooted / socket dead | **No** | needs FCM |
| App reopened after being killed | Yes, on resume | `resumeGlobalRealtime()` |

FCM closes the third row. That's the only gap it closes — the other rows do
not get faster or more reliable by adding it.

---

## Step 1 — Apply the SQL migration

In the Supabase SQL editor, run:

```
supabase-migration-connections-push-discovery.sql
```

This creates `device_push_tokens`, `app_push_config`, and the
`notifications_push` trigger. **The trigger is a deliberate no-op** until
Step 5 fills in `app_push_config`, so it is safe to run right now, before
Firebase exists.

It also needs the `pg_net` extension, which Supabase ships enabled by
default. If the trigger errors on `net.http_post`, enable it under
**Database → Extensions → pg_net**.

---

## Step 2 — Create the Firebase project

1. <https://console.firebase.google.com> → **Add project** → name it `Hisaab`.
   Google Analytics is not needed; skip it.
2. In the project, **Add app → Android**.
   - **Android package name**: `com.usehisaab.app`
     This must match `appId` in `capacitor.config.ts` exactly, or FCM will
     reject every message.
   - Nickname and debug SHA-1 are optional for push.
3. Download **`google-services.json`**.

---

## Step 3 — Drop the config file into the Android project

Put the downloaded file at:

```
android/app/google-services.json
```

Then add the Google Services Gradle plugin.

**`android/build.gradle`** — inside `buildscript { dependencies { … } }`:

```gradle
classpath 'com.google.gms:google-services:4.4.2'
```

**`android/app/build.gradle`** — at the very bottom of the file:

```gradle
apply plugin: 'com.google.gms.google-services'
```

`google-services.json` contains no secrets (it is a client config and ships
inside every APK), but it *is* environment-specific — if you keep separate
Firebase projects for staging and production, keep the files separate too.

**Release builds now enforce this file.** `android/app/build.gradle` fails
`bundleRelease`/`assembleRelease` loudly (`GradleException`, before the AAB/APK
is produced) if `android/app/google-services.json` is missing — mirroring the
existing keystore guard right above it in the same file. This exists because
a checkout without the file used to build a release AAB that *looked* fine
but shipped with zero FCM delivery, silently. Debug builds (`cap run
android`) are unaffected and still work without the file — only a release
bundle/APK is blocked. If you hit this error, it means Step 2-3 above
weren't done on the machine building the release.

---

## Step 4 — Deploy the Edge Function

The function lives at `supabase/functions/push-notify/index.ts`.

```bash
supabase functions deploy push-notify --no-verify-jwt
```

`--no-verify-jwt` is required and intentional: the caller is Postgres, not a
signed-in user, so there is no JWT to verify. The function authenticates on a
shared secret header instead (Step 5).

Then create a service account key for FCM:

1. Firebase console → **Project settings → Service accounts**
2. **Generate new private key** → downloads a JSON file
3. Set both secrets:

```bash
supabase secrets set FCM_SERVICE_ACCOUNT="$(cat path/to/service-account.json)"
supabase secrets set PUSH_SHARED_SECRET="$(openssl rand -hex 32)"
```

Keep that generated `PUSH_SHARED_SECRET` value — Step 5 needs it.

> This service-account JSON **is** a credential. It can send push to every
> user of the project. Never commit it, and never put it in the app bundle.

`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are injected automatically by
the Edge runtime; you do not set those.

---

## Step 5 — Point the database at the function

In the Supabase SQL editor, with your own values substituted:

```sql
insert into public.app_push_config(key, value) values
  ('edge_url',    'https://<your-project-ref>.supabase.co/functions/v1/push-notify'),
  ('edge_secret', '<the PUSH_SHARED_SECRET you generated>')
on conflict (key) do update set value = excluded.value, updated_at = now();
```

The trigger reads these on every notification insert. Deleting either row
switches push off cleanly — the app keeps working, it just stops pushing.

---

## Step 6 — Build and test

```bash
npm run cap:sync
```

Then build the APK/AAB in Android Studio and install on a real device
(the emulator needs Play Services; a plain AVD image won't register).

To test end-to-end:

1. Sign in on the device.
2. **Settings → Payment reminders → on** — or open a loan with an active
   balance (`/loan/:id`) and tap **Remind**; after that sheet closes,
   `NotificationPermissionPrompt` (`src/components/NotificationPermissionPrompt.tsx`)
   offers the same opt-in at that higher-intent moment instead of only from
   the buried Settings toggle. Either path grants Android 13+'s
   `POST_NOTIFICATIONS` and registers the FCM token in the same step — there
   is deliberately no second, separate push opt-in. Declining the in-context
   prompt ("Not now") is remembered for 14 days (`localStorage`) before it
   asks again; Settings always stays available regardless. Other high-intent
   moments worth wiring the same prompt into later: first kameti round going
   due, a budget breach.
3. Confirm a row appeared:
   ```sql
   select user_id, platform, created_at from public.device_push_tokens;
   ```
4. **Force-stop the app** (Settings → Apps → Hisaab → Force stop). This is
   the case FCM exists for; testing with the app merely backgrounded proves
   nothing, because `instantNotify` would have handled that anyway.
5. From another account, send that user a loan request — or just insert a
   notification directly:
   ```sql
   insert into public.notifications(id, user_id, type, title, body)
   values (gen_random_uuid()::text, '<their-user-id>', 'system',
           'Test', 'Push is working.');
   ```
6. The notification should arrive in the tray within a few seconds.

---

## Troubleshooting

**Nothing arrives, no token row exists.**
Registration failed. Check `adb logcat | grep -i "\[push\]"`. Almost always a
missing `google-services.json` or the Gradle plugin not applied (Step 3).

**Token row exists, still nothing.**
Check the Edge Function logs in the Supabase dashboard.
- `not_configured` → `FCM_SERVICE_ACCOUNT` secret is unset.
- `401` → `edge_secret` in `app_push_config` doesn't match
  `PUSH_SHARED_SECRET`.
- `no_devices` → the trigger fired for a user with no registered device.
- `SENDER_ID_MISMATCH` → `google-services.json` is from a different Firebase
  project than the service account.

**Function is never called at all.**
The trigger silently no-ops when `app_push_config` is incomplete. Verify:
```sql
select * from public.app_push_config;
```
If both rows are present, check the `net` response table for the HTTP result:
```sql
select * from net._http_response order by created desc limit 10;
```

**Works on one phone, not another.**
The other device likely denied the notification permission. Android never
re-prompts after a denial — the user has to enable it in system settings.

---

## Cost

FCM is free with no message quota. The Edge Function invocations count
against your Supabase function budget: one invocation per notification row,
which is roughly one per cross-user event (loan request, settlement, connect
ask). Nowhere near the free tier for any realistic user count.
