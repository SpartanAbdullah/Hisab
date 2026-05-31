# Hisaab P0 Launch Blocker Tracker

Last updated: May 31, 2026

| Blocker | Status | Owner | Next action |
| --- | --- | --- | --- |
| Permanent account deletion and deleted-profile RLS block | Code ready | Abdullah | Run `supabase-migration-p0-launch-blockers.sql` in Supabase SQL Editor. |
| RPC-only group joining and legacy lookup removal | Code ready | Abdullah | Run the same migration, then run `supabase-p0-security-verification.sql`. |
| Cross-account local cache isolation | Done | Codex | Deploy the web build and include a shared-device QA pass before launch. |
| Reproducible Capacitor Android project | Done | Codex | Commit the regenerated source project. Keep AABs, APKs, caches, keystores, and `local.properties` untracked. |
| Apex domain legal routes | Resolved, monitor propagation | Abdullah | Latest checks return Hisaab on apex and `www`. Re-check `/privacy` and `/delete-account` after deployment and after DNS TTLs settle because mixed routing was observed earlier on May 31, 2026. |

## Validation Notes

- `npm run cap:sync` passes.
- `android\gradlew.bat bundleRelease` passes when `JAVA_HOME` and `ANDROID_HOME` are set as documented in `docs/android-setup.md`.
- The generated local AAB output path is ignored at `android/app/build/outputs/bundle/release/app-release.aab`; remove local bundles after verification.
