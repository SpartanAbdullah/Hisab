# Ops Checklist — Hisaab

Bus-factor-1 mitigations and recurring operational checks. This repo is
maintained by one person; `docs/audit-2026-09/13-engineering-standards.md`
§5 ("Future risks") names the pattern directly: *"every schema change and
every Android release passes through one person's hands and machine ...
bus factor 1 on the entire ops surface."* This checklist doesn't remove that
— it makes sure the single points of failure are at least documented,
backed up, and checked on a cadence, so a lost laptop or an unavailable
founder isn't also a lost app.

Nothing in this file is automatable from inside this repo — every item is
either a manual verification step or a dashboard setting on Supabase,
Vercel, Play Console, Sentry, or GitHub. Track completion by literally
checking the boxes in your working copy, or move this into whatever task
tracker you actually use.

---

## 1. Keystore backup — the single most unrecoverable asset in this project

`RELEASE.md` §1 already says it: *"If you lose it, you can never update the
app on Play — there is no recovery."* Two files, both git-ignored by design
(`.gitignore`: `*.jks`, `android/keystore.properties`):

- `android/app/hisaab-upload.jks` — the actual signing key.
- `android/keystore.properties` — the passwords that unlock it (`storeFile`,
  `storePassword`, `keyAlias`, `keyPassword`).

**Losing either one, or forgetting the passwords with no `keystore.properties`
backup, permanently ends your ability to publish updates to the existing Play
listing** — Play refuses an AAB signed with a different key than the one the
listing was created with, and there is no override, appeal, or support path
that restores a lost upload key.

### 1.1 Where both files must be backed up (do this before your next release, not after)

- [ ] At least **two** independent locations, neither of which is only "the
      same laptop this repo lives on." Suggested combination:
      - An encrypted password manager entry (1Password, Bitwarden, etc.) that
        supports file attachments — store the `.jks` file itself plus a note
        with the four `keystore.properties` values.
      - A second physical/cloud location that isn't the password manager's
        own cloud sync alone — an encrypted USB drive kept somewhere other
        than the primary machine, or a separate encrypted cloud folder
        (not a plain unencrypted Drive/Dropbox file — this key signs a
        financial app).
- [ ] Confirm neither backup location is *itself* a single point of failure
      (e.g., don't make "my personal Google account" the only place both the
      password manager and the cloud backup live).
- [ ] Write down (in the password manager entry, not just memory) the
      keystore password, key alias, and key password separately from the
      `.jks` file — the file alone is useless without them.

### 1.2 Verify the backup actually opens — do this now, not when you need it

A backup you haven't restored-and-tested is a hope, not a backup. From a
restored copy of the `.jks` file (not the working copy still on your
machine — actually pull it back from the backup location to prove the
backup is intact):

```powershell
& "C:\Program Files\Android\Android Studio\jbr\bin\keytool.exe" -list -v -keystore <path-to-restored-hisaab-upload.jks> -alias hisaab-upload
```

- It will prompt for the keystore password — use the one from the backup,
  not the one you remember, to confirm the backup note is correct too.
- **Pass:** prints certificate details (`Owner:`, `SHA256:` fingerprint,
  validity dates) matching the upload-key fingerprint already on file as
  the **first** entry of `public/.well-known/assetlinks.json` and in
  `docs/play-store-launch-tracker.md` row **Y7**
  (`0B:B6:45:86:3D:98:A4:E4:91:10:D5:FD:F0:66:34:F4:EA:FE:2D:71:08:77:02:F1:C5:93:5B:82:9D:47:6D:A5`).
- **Fail:** a wrong-password error or a corrupted-keystore error. If this
  happens, fix the backup immediately — regenerate it from the working
  copy while you still have that working copy.
- [ ] Re-run this check whenever the backup location changes (new password
      manager, new drive, etc.), and at least once every 6 months regardless.

### 1.3 Play App Signing — mandatory for AAB, and the second `assetlinks` slot

Play App Signing is **not optional** for an Android App Bundle: the first
AAB upload enrolls the app, Google generates and holds the *app signing
key*, and your `.jks` from §1 is the *upload key* only. That is also
Google's layer of key-loss protection — lose the upload key (but not both)
and Google can reset it. The consequence for this repo is that there are
**two** fingerprints, and only the upload one is known before the first
upload.

- [ ] First upload (`versionCode 1 / versionName 1.0.0`) goes to a
      **closed** testing track — a new developer account needs 12 testers
      for 14 consecutive days before production (`RELEASE.md` §10,
      `docs/play-store-launch-tracker.md` Y11). Enrollment in Play App
      Signing happens as part of that upload; there is no separate switch
      to flip, and it cannot be undone.
- [ ] Immediately after the first upload: Play Console → your app →
      **Setup → App Integrity → App Signing** → copy the **"App signing key
      certificate (SHA-256)"** and paste it into **slot 1** (the second
      entry, currently `REPLACE_WITH_PLAY_SIGNING_KEY_SHA256`) of
      `public/.well-known/assetlinks.json`. Slot 0 stays the upload-key
      fingerprint from §1.2. Record the value in
      `docs/play-store-launch-tracker.md` Y7, then deploy (`RELEASE.md` §6).
- [ ] Verify the served file, not the repo copy:
      `https://usehisaab.com/.well-known/assetlinks.json` must answer
      **200 on the apex** with both fingerprints. Until the founder flips
      Vercel so the apex is primary (today the apex 307-redirects to
      `www`), the App Links verifier — which does **not** follow redirects
      — will keep failing even with a correct file. Do the flip; do **not**
      add `www` to the manifest host as a workaround.
- [ ] Remember the failure mode: a stale `assetlinks.json` is a silent
      deep-link breakage (links fall back to the browser), not a build
      failure — re-check it after any key reset or host change.

---

## 2. Who holds owner/admin access — fill in before this matters

`ARCH-RECON-hisaab.md` §4 lists this as unknowable from the repo. A single
founder holding every credential is itself the bus-factor-1 risk this
checklist exists to mitigate — at minimum, make sure the *list* survives the
founder being unavailable, even if the access itself is intentionally
concentrated for now.

| System | Owner / Admin | Backup contact | 2FA method | Where recovery codes live |
|---|---|---|---|---|
| GitHub (repo + org, if any) | _[fill in]_ | _[fill in]_ | _[fill in]_ | _[fill in]_ |
| Supabase project | _[fill in]_ | _[fill in]_ | _[fill in]_ | _[fill in]_ |
| Vercel project | _[fill in]_ | _[fill in]_ | _[fill in]_ | _[fill in]_ |
| Google Play Console (developer account) | _[fill in]_ | _[fill in]_ | _[fill in]_ | _[fill in]_ |
| Sentry org | _[fill in]_ | _[fill in]_ | _[fill in]_ | _[fill in]_ |
| Domain registrar (`usehisaab.com`) | _[fill in]_ | _[fill in]_ | _[fill in]_ | _[fill in]_ |

- [ ] At least one system above has a **named backup contact** who could act
      (reset a password, approve a critical PR, pause a runaway bill) if the
      primary owner is unreachable for an extended period.
- [ ] Play Console specifically: consider whether the developer account
      should ever have a second Account User added (Play Console supports
      multiple users with scoped permissions) rather than being a single
      Google account with no succession path.

---

## 3. Spend caps and alerts

None of these exist in the repo (`ARCH-RECON-hisaab.md` §4: *"Whether spend
caps / budget alerts are configured on Supabase, Vercel, and Sentry ...
UNKNOWN"*) — they're dashboard settings. A pre-revenue app with no anomaly
detection (`13-engineering-standards.md` §2.3) is exactly the profile that
finds out about a cost spike from an invoice, not a dashboard.

- [ ] **Supabase** — Project Settings → Billing:
      - Confirm current plan tier (Free/Pro/Team) and its included quota
        (DB size, egress, Realtime connections, Edge Function invocations).
      - Set a **spend cap** if on a paid plan (Supabase supports capping
        usage-based billing so it fails over to throttling rather than
        billing past a limit).
      - Set a **usage alert** (email notification at e.g. 80% of quota) even
        on the Free tier, so an unexpected traffic spike (or the unbounded
        `getAll()` fetch pattern flagged in `13-engineering-standards.md`
        §2.1) is visible before the project gets rate-limited or suspended.
- [ ] **Vercel** — Project/Team Settings → Billing:
      - Confirm current plan and bandwidth/build-minute quota.
      - Set a spend/usage alert (Vercel supports usage notifications on
        paid plans; on the Hobby tier, confirm what happens at the limit —
        typically throttling, not silent overage, but verify current
        Vercel policy rather than assuming).
- [ ] **Sentry** — Org Settings → Subscription:
      - Confirm the event quota for the current plan.
      - Set a **spend notification** (Sentry supports alerting before an
        overage charge, or hard-capping at quota depending on plan) — this
        matters here specifically because the release build **ships the
        DSN**: `VITE_SENTRY_DSN` is baked into the web bundle and the AAB
        from the build machine's `.env` (`.env.example` is blank since the
        2026-09 audit — the `13-engineering-standards.md` §2.2 "Low"
        finding is closed), and a browser-side DSN is public by nature, so
        anyone who reads the bundle can inject events into this Sentry
        project and consume quota. Sentry's inbound filters / rate limits
        per project are the mitigation; rotating the DSN is a rebuild +
        `cap sync` + new AAB, not a config change.

---

## 4. Uptime monitoring

`13-engineering-standards.md` §2.3 scores observability 3/10 partly because
*"no uptime monitoring — no synthetic checks, no health endpoint, no status
page anywhere in the repo."* This app has no custom server to add a health
endpoint to (`CLAUDE.md`: "There is no custom server"), so the check is
necessarily external, against the public web app and/or the Supabase REST
endpoint.

- [ ] Set up a free-tier uptime checker against `https://usehisaab.com`
      (a plain GET on the SPA shell is enough to catch "Vercel deploy is
      down" or "DNS broke"). Any of the well-known free tiers work —
      UptimeRobot, Better Stack (formerly Better Uptime), Freshping,
      Pulsetic, or similar; pick one, don't over-index on the specific
      vendor. 5-minute check interval is standard on free tiers.
      **Host note (2026-09-05):** the apex is canonical, but until the
      Vercel flip lands it answers a 307 to `https://www.usehisaab.com`,
      which is what returns 200 today. Configure the monitor to follow
      redirects (or check both hosts) so the pre-flip state doesn't read as
      an outage, and re-check the monitor after the flip (www → apex 308).
- [ ] Point the alert at a channel you actually check promptly (email is
      fine to start; a phone push via the monitor's own app is better for a
      solo operator who won't be staring at an inbox at 3am).
- [ ] Optional, once there's a moment: a second check against the Supabase
      project's REST endpoint (`<VITE_SUPABASE_URL>/rest/v1/`) — Vercel being
      up doesn't mean Supabase is reachable, and a Supabase-only outage
      (project paused, quota exhausted, region issue) is currently
      invisible from the web check alone.

---

## 5. Supabase PITR / backups — confirm the setting, don't assume it

`ARCH-RECON-hisaab.md` §4: *"Whether Point-in-Time Recovery / backups are
enabled ... UNKNOWN — needs dashboard/host check."* For a money app, this is
the difference between "a bad migration is an incident" and "a bad migration
is the end of the company's data."

- [ ] Supabase Dashboard → Project Settings → **Database → Backups**:
      confirm whether daily backups are enabled and their retention window
      (Free tier: typically none or very short; Pro tier and above:
      typically 7-day daily backups included, with PITR available as an add-
      on on Pro+).
- [ ] If on a plan where **PITR is available but not yet enabled**, and this
      project holds real user financial data (i.e., post-launch), enable it.
      PITR is what makes "a migration corrupted rows two hours ago" a
      recoverable event instead of a permanent one — daily backups alone
      only get you back to last night.
- [ ] Record the actual retention window here once confirmed, so it doesn't
      have to be re-discovered under pressure during an incident:
      _[fill in: backup type, retention window, PITR enabled Y/N, as of
      date checked]_.
- [ ] Cross-reference with `docs/release-and-rollback.md` §4 (staging
      project recommendation) — a staging Supabase project is a second
      reason to know your backup/restore story cold: it's also how you'd
      seed staging from a production snapshot safely (strip PII first).

---

## 6. GitHub branch protection for `main`

Currently unconfirmed (`13-engineering-standards.md` §5: *"no branch
protection evidence, no code review (solo direct-to-main commits)"*) and,
per `docs/release-and-rollback.md` §5, currently **not** stopping a red CI
run from reaching production via Vercel's independent git integration. This
is a GitHub repo-settings change — not a file this repo can commit — but the
exact settings to turn on are enumerated here so there's no ambiguity about
what "branch protection is configured" means for this repo.

GitHub → repo → **Settings → Branches → Add branch protection rule** (or
**Rulesets**, GitHub's newer equivalent — either works, use whichever this
repo's GitHub plan currently offers):

- [ ] Branch name pattern: `main`.
- [ ] **Require a pull request before merging** — turns off solo
      direct-to-main pushes, which is the current pattern
      (`13-engineering-standards.md` §5).
      - [ ] Require approvals: 0 is acceptable for a genuine solo repo (there
            is no second reviewer), but turning the PR requirement on still
            forces CI to run before merge, which is the actual goal here.
- [ ] **Require status checks to pass before merging**, and select:
      - [ ] `test` — the job name in `.github/workflows/ci.yml` (typecheck +
            lint + unit tests + production build).
      - [ ] `npm-audit` and `gitleaks` — the two job names in
            `.github/workflows/security.yml`.
      - [ ] `sql` — the job id in `.github/workflows/db-tests.yml`
            ("Apply corpus + trust-boundary assertions": applies
            `supabase/tests/apply-order.txt` to a fresh Postgres and runs
            the 546-assertion suite). It has reported on the audit branch,
            so GitHub will let you select it (a required check that has
            never reported must be seen once first).
      - [ ] **Require branches to be up to date before merging** — prevents
            merging a PR whose CI run predates a since-merged breaking
            change on `main`.
- [ ] **Do not allow bypassing the above settings** — even for repo admins,
      unless there's a specific reason to exempt yourself (e.g., an
      emergency hotfix path you've deliberately decided to keep). If you do
      allow admin bypass, know that you're choosing convenience over the
      gate actually gating anything — document that choice rather than
      leaving it implicit.
- [ ] Once this is on, revisit `docs/release-and-rollback.md` §5's Vercel
      "Ignored Build Step" recommendation — branch protection covers merges
      into `main`; the Ignored Build Step is the defense-in-depth layer for
      a direct push that bypasses PR review entirely (relevant only if admin
      bypass above is left enabled).

---

## 7. Recurring cadence

Suggested check frequency for the items above that aren't one-time:

| Item | Frequency |
|---|---|
| Keystore backup restore-and-verify (§1.2) | Every 6 months, and after any backup-location change |
| Owner/access roster review (§2) | Whenever a system's credentials change, and at least yearly |
| Spend cap / alert thresholds (§3) | Revisit after any usage-shape change (launch, a viral spike, a new feature that changes read/write volume) |
| Uptime monitor is still firing test alerts correctly (§4) | Every few months — an uptime monitor that silently stopped alerting is worse than none, because it creates false confidence |
| Supabase backup/PITR setting (§5) | Whenever the Supabase plan tier changes |
| Branch protection settings (§6) | After any GitHub plan change or repo transfer (personal → org, per the note in `security.yml` about `GITLEAKS_LICENSE`) |
