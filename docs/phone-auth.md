# Phone auth — decision + migration plan

**Status:** proposal, nothing implemented. Triggered by audit 2026-09 H10/SEC-09 (no phone-ownership verification —
VerifiedBadge demoted, `src/lib/contactVerification.ts`) and G1 (onboarding friction — "phone+OTP is the market's
trained entry grammar; Hisaab's funnel is worst-in-set", `docs/audit-2026-09/11-competitive-analysis.md`).

## 1. Founder decisions

**Phone-first vs phone-optional — recommend phone-optional-first.** Add "Continue with phone" on `AuthPage.tsx` as
the primary/default CTA (top position, filled button), demote email to a secondary "or use email" link. Do not
remove email: every cross-user consent primitive (`link_contact_by_code`, `link_contact_by_discovery`) keys on
`profiles.id`, not auth method, so no data-model change is forced by adding phone. A money app also needs a
recovery channel that survives a lost/swapped SIM (§4.2) — email keeps that until a recovery-code alternative
exists. Revisit phone-only once `signup_started`→`auth_completed` telemetry shows phone durably beating email.

**SMS provider — PK + Gulf.** Supabase Auth's phone provider is pluggable (Twilio Verify, Twilio SMS, Vonage,
MessageBird as of current docs — **re-verify against `supabase.com/docs/guides/auth/phone-login`**, this list
changes). Twilio Verify is the safe default: it owns OTP generation/expiry/retry so Hisaab doesn't reimplement it,
and has the most mature PK sender-ID support. Pakistan (PTA) and the Gulf regulators (UAE TRA, KSA CITC, Qatar CRA)
all filter unregistered international SMS — a registered alphanumeric sender ID is mandatory for reliable PK/Gulf
delivery, not optional polish, and registration has a multi-week lead time (§6). Get live per-country deliverability
quotes from Twilio and one alternative (Vonage or MessageBird) before committing — list pricing doesn't predict
carrier-filtering outcomes.

**OTP budget / rate limits and the free-account multiplier (M11).** Supabase ships per-project SMS send limits and
a per-number cooldown — set them explicitly, don't trust defaults. Add CAPTCHA (hCaptcha/Turnstile) on the
phone-signup form: audit M11 shows every existing per-user limiter is bypassable by free multi-account signup, and
unlike email that abuse now costs real money per OTP. Budget floor: ~$0.03–0.09/OTP × ~2 OTPs/signup (initial +
resend) → 10k signups/month ≈ $600–1,800/month before abuse. Set a hard provider-side spend cap in addition to the
app-level limiter — M11's lesson is that app-level limits alone are gameable.

## 2. Identity model

**Current state (do not repeat).** `src/lib/supabaseDb.ts:492-498` `setMyPhone()` is a plain `profiles` UPDATE —
no OTP, no ownership check. `phone_e164`/`phone_discoverable` are self-service columns by design
(`supabase-migration-connections-push-discovery.sql:303-310`). `VerifiedBadge` was already demoted off phone claims
to `isConsentVerifiedLink()` (accepted `contact_link_requests` row) — that demotion stays; phone verification is
additive, never a substitute for consent-link semantics.

**Target state.**
1. `auth.users.phone`/`phone_confirmed_at` is the only phone value ever trusted as "proved control of this number."
2. `profiles.phone_e164` is set **only** by a SECURITY DEFINER sync — either a trigger on `auth.users` (`AFTER
   UPDATE OF phone, phone_confirmed_at`, copying into `profiles` + a new `phone_verified_at` whenever confirmation
   goes non-null) or, if a direct `auth.users` trigger is undesirable, a `sync_verified_phone()` RPC the client
   calls right after `verifyOtp()` succeeds (reads only `auth.uid()`'s own row — never a client-supplied target).
   Either way, block direct client writes to `phone_e164`/`phone_verified_at` with a protect trigger — same pattern
   as `tg_persons_protect_archive` in `supabase-migration-audit-p0-consent-guards.sql` §1.1 for `linked_profile_id`.
   `phone_discoverable` (the opt-in toggle) stays client-writable; only the *value being toggled* is locked down.
3. New column `profiles.phone_verified_at timestamptz`. Null = unverified (today's state). Non-null = set only by
   the sync path, making a forged verified claim structurally impossible — this is what closes H10.
4. Restore a real verified badge for phone matches, scoped narrowly: render `VerifiedBadge` on a discovery hit only
   when `phone_verified_at is not null`, with copy reading "phone number verified" — distinct tooltip from the
   contact-link badge (`isConsentVerifiedLink()` stays the *stronger* signal), so the two never look identical.

**Merging an email account and a phone account for the same human.** Supabase's identity-linking API (exact method
name has moved across versions — verify against current docs) lets an *already-signed-in* user add a second
credential to the same `auth.users` row: ship "verify a phone from Settings" (email user adds phone) first — low
risk, one `profiles.id` throughout. Supabase does **not** auto-merge two separately-created accounts (one email-only,
one phone-only) that turn out to be the same person; that needs a manual, destructive account-merge feature
(consolidating `accounts`/`transactions`/`group_members` across two `profiles.id`s) — explicitly out of scope here.
Risk to flag: linking trusts whichever OTP/email-verify flow ran, so a shared/family phone number could let the
wrong household member link into someone else's account — require the *linking* OTP to go through the same
rate-limited flow as sign-in, no shortcut.

**Existing users — backfill = none.** Old self-service `phone_e164` values are kept (discovery still matches
against them) but `phone_verified_at` stays null — there's no way to retroactively prove ownership of a number
typed months ago. Prompt for opportunistic verification on next sign-in (dismissible banner), not a hard gate.

## 3. Onboarding collapse (G1)

**Proposed sequence:** `phone → OTP → name → language → mode (intent folded in) → done`.

- **Auth screen** (`AuthPage.tsx`, email+password) becomes phone-first: phone entry + OTP become onboarding's own
  first two screens, no separate auth page for that path. Email stays reachable via "use email instead," still
  routing to today's `AuthPage.tsx`.
- **Step 1 (name+currency)** splits: name stays right after phone verifies (greet by name immediately); currency
  moves into the mode step, since it's really "what kind of tracker" context.
- **Step 2 (intent)** is removed as a standalone screen. `OnboardingPage.tsx:52-68` — UX-03 already documents this
  screen as broken (the captured intent is read nowhere but one `navigate()` call and can dead-end at Home). Each
  mode-quiz answer already implies an intent (`leansTo: AppMode`), so folding intent into the quiz keeps the
  signal — `onboarding_mode_selected`'s `quiz_intent` property is unaffected.
- **Step 3 (safety reassurance, 5 bullets)** is removed as a standalone screen; compressed to 1-2 lines under the
  OTP step. A funnel this doc is trying to shorten can't also keep a screen G1 already flags as excess length.
- **Step 4 (mode quiz)** kept, now carries currency + the folded-in intent.
- **Step 5 (first account / fresh-start)** kept unchanged — genuinely load-bearing.

Net: 6 screens → 5, two removed rather than reordered, matching the brief's sequence.

**Telemetry to keep.** Everything in `src/lib/telemetryEvents.ts` maps cleanly with one required change: `AUTH_METHOD`
(line 67) is currently `enumOf(['email'])` and must widen to `enumOf(['email','phone'])`, or `sanitizeEventProps()`
silently drops `method:'phone'` on `signup_started`/`auth_completed`. Keep `onboarding_step_viewed`,
`onboarding_mode_selected` (`quiz_intent` now carries what the removed intent screen used to), `onboarding_completed`
as-is. Add `phone_otp_requested`/`phone_otp_verified` (new, `{surface}`) so OTP delivery failures are visible
separately from user abandonment — otherwise this repo's "failure looks like abandonment" pattern (flagged
elsewhere for Analytics) repeats on a flow that costs money per attempt.

**Email-verification gate's role for phone users.** `App.tsx:869`: `if (!user.email_confirmed_at) return
<UnverifiedEmailScreen/>` would permanently lock out phone users (no email at all). Change to:
`if (!user.phone_confirmed_at && !user.email_confirmed_at) return <UnverifiedEmailScreen/>` — bypass whenever
`phone_confirmed_at` is set. Phone signup only ever completes post-OTP-verify, so it's non-null by construction;
there's no phone equivalent of "signed up but never confirmed." `UnverifiedEmailScreen` copy needs a phone-aware
variant (or phone users simply never see it).

## 4. Security review

**OTP brute-force limits.** Supabase's phone-verify endpoint enforces its own attempt limits (separate from the
`phone_lookup_attempts` table, which is for the *discovery* RPC, unrelated) — verify current defaults against docs
and set explicitly: recommend max 5 verify attempts per code, ≥60s resend cooldown per number, TTL ≤10 minutes.
Add CAPTCHA to OTP-verify too, not just OTP-send — a brute-force script targeting a 4-6 digit code needs no fresh
number if verify itself is unthrottled.

**SIM-swap / recycled-number risk.** Numbers get recycled and swapped in this market; a money app trusting phone
alone inherits that fraud surface. Mitigations: (a) re-verify for *discovery* every ~90 days — `phone_verified_at`
older than N days drops `phone_discoverable` and the badge (never the login credential) until re-confirmed, which
bounds H10's exploit window even under the verified model; (b) **never make phone the sole recovery path** for a
money-bearing account — `requestPasswordReset`/account-recovery must require a confirmed email or a one-time
recovery code shown at signup, never "you currently hold this number" alone (that's exactly the SIM-swap
attacker's capability). If the founder wants true phone-only signup, issue a recovery code at signup as the backstop.

**PIN lock interplay.** `App.tsx:419-429`'s PIN gate operates on local device state once a session exists,
independent of which credential produced it — no expected interaction. Confirm `authStore.ts` doesn't key `hasPin`
off `user.email` anywhere before shipping (a phone-only user with null email must not skip the PIN gate).

**Session lifetimes.** No change to default JWT/refresh lifetimes for either auth method (existing hygiene gaps —
M2/H8 — apply equally and are out of scope here). Consider a shorter session lifetime specifically for phone-only
accounts with no linked email/recovery-code, until §4.2's recovery-code requirement ships.

## 5. Implementation plan

**SQL migration** (new `supabase-migration-phone-auth.sql`, effort **M**): add `profiles.phone_verified_at
timestamptz`; add a `tg_profiles_protect_phone_verified` BEFORE UPDATE trigger blocking direct writes to
`phone_e164`/`phone_verified_at` unless a session-local flag set by the sync path is present (mirrors the
`linked_profile_id` guard already proven in `audit-p0-consent-guards.sql` §1.1); add `sync_verified_phone()`
SECURITY DEFINER, reading only `auth.uid()`'s own `auth.users` row, revoked from `PUBLIC`/`anon`, granted to
`authenticated`. Needs a live Supabase project to finalize the trigger-vs-RPC choice — this platform surface
changes across versions, do not implement from memory.

**Client changes by file:**

| File | Change | Effort |
|---|---|---|
| `AuthPage.tsx` | Add phone-entry + OTP-verify UI mode, made the primary CTA (§1); `signInWithOtp`→`verifyOtp`→ sync call | L |
| `OnboardingPage.tsx` | Drop intent + safety screens, fold currency into mode step, prepend phone/OTP (§3.1) | M |
| `supabaseAuthStore.ts` | `signInWithPhone`/`verifyPhoneOtp` mirroring `signIn`/`signUp`'s `{success,message}` + store-reset bookkeeping; `linkPhoneIdentity`/`linkEmailIdentity` for in-Settings linking | M |
| `phoneIdentity.ts` | No OTP-specific change; reuse `toE164()` to normalize input before `signInWithOtp` | S |
| `PhoneDiscoverySection.tsx` | Route number entry through OTP-verify instead of the raw settings field (closes UX-17/H10's default-discoverable-on-save gap) | M |
| `App.tsx` | Widen the verification gate (§3) | S |
| `VerifiedBadge.tsx`, `contactVerification.ts` | Add phone-verified predicate/tooltip, distinct from consent-link badge (§2) | S |
| `telemetryEvents.ts` | Widen `AUTH_METHOD`; add OTP funnel events (§3) | S |

**Android:** SMS Retriever (auto-read OTP) is optional. No retriever plugin exists in `package.json` today
(current set: app, core, filesystem, keyboard, local-notifications, preferences, push-notifications, share,
splash-screen, status-bar) — would need a community plugin (check current maintenance) or a small custom wrapper,
plus the SMS provider templating the Google-mandated app-hash format. **Recommend deferring** to a fast-follow;
ship manual entry first (also the only option on PWA), add auto-read only if telemetry shows real OTP-step
abandonment.

**i18n keys (S):** phone-entry label/placeholder, OTP entry + resend/cooldown copy (mirror `verify_resend`/
`verify_resending`/`verify_spam` in `AuthPage.tsx`), phone-verified badge tooltip, replacement copy for the two
removed onboarding screens. Both `ur` (roman Urdu default) and `en`.

**Play data-safety:** phone moves from "optional, social-feature" to also "used for account management." Update
`docs/play-store-listing.md` and the live Play Console form together — the audit already flags stale/false
capability claims as an existential trust risk for this product; don't let this declaration drift the same way.

**Test plan** (land in `supabase/tests` once the pgTAP harness from `05-security.md` M7 exists, or run manually
against a throwaway project meanwhile): (1) a plain client `UPDATE profiles SET phone_e164=...` must fail — proves
the protect-trigger; (2) `sync_verified_phone()` called by user A must never touch user B's row; (3) a profile with
null `phone_verified_at` never renders the badge, and a stale one (>90d) loses `phone_discoverable`; (4) the
`App.tsx` gate passes a phone-confirmed/email-null session and blocks a neither-confirmed session; (5) telemetry
assertion that `onboarding_step_viewed` fires the reduced step count end-to-end for phone signup.

## 6. What needs the founder

1. **SMS provider account + sender-ID registration** — start immediately; PTA/TRA/CITC/CRA pre-approval is
   multi-week and blocks everything else if left to the end.
2. **Supabase Auth dashboard**: enable the chosen phone provider, set rate limits (§1/§4) explicitly, enable
   CAPTCHA on send *and* verify if the dashboard exposes that granularity (verify against current version).
3. **Budget approval** for the SMS spend estimate in §1, plus a provider-side hard cap as backstop.
4. **Sign-off on the §4.2 recovery-code requirement** for phone-only accounts before phone-only signup ships —
   real support-burden implications ("lost my phone, no recovery code") that should be decided up front.
5. **Ship-now vs. fast-follow call on SMS Retriever** (§5) — recommend fast-follow.

---

*Prepared 2026-09-02 against commit `2248327`. Nothing implemented; no SQL run against production. Every
Supabase-specific claim above (provider list, `auth.users` trigger patterns, dashboard rate-limit granularity,
identity-linking API surface) should be re-verified against `supabase.com/docs` at implementation time — this
surface has changed across Supabase versions and none of it is treated as stable here.*
