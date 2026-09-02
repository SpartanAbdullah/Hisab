-- ════════════════════════════════════════════════════════════════════════════
-- Hisaab — Remote app config / minimum supported version (audit item H9)
-- ----------------------------------------------------------------------------
-- Run this in the Supabase SQL Editor. Idempotent: safe to re-run.
-- Apply AFTER: supabase-schema.sql (no dependency on any other migration —
--   this table is standalone and references nothing).
--
-- ────────────────────────────────────────────────────────────────────────────
-- WHAT THIS FIXES
-- ────────────────────────────────────────────────────────────────────────────
-- Audit 2026-09-02:
--   • 07-mobile-first.md MF-12 — CONFIRMED, MEDIUM.
--     "No force-update/minimum-version mechanism while the backend schema
--      evolves by hand. On native, the web bundle updates only via full Play
--      releases (SW deliberately disabled on native, src/lib/serviceWorker.ts:6-8;
--      no OTA layer; versionCode 1 hardcoded, android/app/build.gradle:23).
--      Meanwhile 40 root supabase-migration-*.sql files are applied manually,
--      several believed pending. No versions table, no boot compatibility
--      check, no kill switch: an old binary keeps calling RPCs whose semantics
--      moved, failing however each call site handles it — many money paths
--      log-and-continue."
--     Recommended fix, verbatim: "an app_config row (min_supported_version,
--     message) fetched at boot; gate with an update screen."
--   • 13-engineering-standards.md §2.10 — three unsynchronised release tracks
--     (Vercel-on-push web, hand-built Android AAB, prod-first hand-applied SQL)
--     make version skew structural, not accidental: "The two surfaces *will*
--     run divergent money logic against the same database for days at a time."
--   • 13-engineering-standards.md §2.11 — "No feature flags, no experimentation,
--     no remote config." This table is the first remote-config surface; keep it
--     to the kill switch until there is a reason to grow it.
--
-- ────────────────────────────────────────────────────────────────────────────
-- HOW IT IS FIXED
-- ────────────────────────────────────────────────────────────────────────────
-- 1. A singleton `public.app_config` row (id = 'default') holding the minimum
--    supported web semver and the minimum supported Android versionCode, plus
--    an optional bilingual message shown on the update screen.
-- 2. RLS ON with a SELECT policy for BOTH `authenticated` AND `anon`. The gate
--    has to run before login — a binary too old to talk to the schema must be
--    stopped at the door, not after it has a session. The row contains no user
--    data; it is deliberately world-readable to every app instance.
-- 3. NO client write policy at all. INSERT/UPDATE/DELETE are reachable only by
--    `service_role` (which bypasses RLS) — i.e. Supabase Studio or an edge
--    function. A compromised anon key cannot brick every installed app.
-- 4. Seeded with the CURRENT shipped versions (package.json version 1.0.0,
--    android/app/build.gradle versionCode 1), i.e. the gate is inert on day
--    one and blocks nobody until a human raises the floor.
--
-- ────────────────────────────────────────────────────────────────────────────
-- RELEASE POLICY (the part that matters more than the SQL)
-- ────────────────────────────────────────────────────────────────────────────
-- Until an OTA path exists (Capgo/Appflow — see docs/updating-the-android-app.md),
-- an installed Android binary can be WEEKS behind the schema. Therefore:
--   • Keep every schema/RPC change ADDITIVE and backwards-compatible by default.
--     New nullable columns, new RPCs, new optional params. Never rename, never
--     repurpose, never tighten an existing RPC's contract in place.
--   • Only when a genuinely breaking migration ships do you raise
--     `min_supported_version` / `min_supported_version_code` — AND only after
--     the fixed build is live on Play and on Vercel, otherwise you lock users
--     out of an app they have no way to update to.
--   • Raising the floor is a kill switch, not a nag. It hard-blocks the app.
--     There is no "remind me later" path by design.
-- The same policy is restated at the top of src/lib/versionGate.ts so it is
-- read by whoever touches the client side.
-- ════════════════════════════════════════════════════════════════════════════


-- ────────────────────────────────────────────────────────────────────────────
-- SECTION 1 — table
-- ────────────────────────────────────────────────────────────────────────────

create table if not exists public.app_config (
  id                          text        primary key default 'default',
  -- Minimum web/PWA build allowed to run, as a semver string ("1.4.0").
  -- Compared against __APP_VERSION__ (injected from package.json by Vite).
  min_supported_version       text        not null default '0.0.0',
  -- Minimum Android versionCode allowed to run (android/app/build.gradle).
  -- Native compares THIS, not the semver: versionCode is the only monotonic
  -- identity Play guarantees, and a hotfix can ship the same versionName.
  min_supported_version_code  integer     not null default 0,
  -- Optional override copy for the update screen. NULL → the client falls back
  -- to its bundled i18n string (upd_body), which is always translated.
  message_en                  text,
  message_ur                  text,
  updated_at                  timestamptz not null default now()
);

comment on table public.app_config is
  'Singleton remote config (id = ''default''). World-readable, service_role-writable only. Holds the minimum supported client version — the app''s only kill switch against schema/binary skew. See supabase-migration-p1-app-config.sql.';

-- Singleton guard: exactly one row, always id = 'default'. Cheap insurance
-- against a second row silently shadowing the one the client reads.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.app_config'::regclass
      and conname  = 'app_config_singleton'
  ) then
    alter table public.app_config
      add constraint app_config_singleton check (id = 'default');
  end if;
end $$;

-- Shape guard on the semver string. A typo here ("1.4" / "v1.4.0") would make
-- every client's comparison meaningless, and the client fails OPEN, so the
-- mistake would be invisible. Fail at write time instead.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.app_config'::regclass
      and conname  = 'app_config_semver_shape'
  ) then
    alter table public.app_config
      add constraint app_config_semver_shape
      check (min_supported_version ~ '^[0-9]+\.[0-9]+\.[0-9]+$');
  end if;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.app_config'::regclass
      and conname  = 'app_config_version_code_nonneg'
  ) then
    alter table public.app_config
      add constraint app_config_version_code_nonneg
      check (min_supported_version_code >= 0);
  end if;
end $$;

-- Keep updated_at honest without anyone remembering to set it. The client
-- does not depend on it, but it is the only audit trail for "when did we
-- raise the floor, and did it line up with the release?".
create or replace function public.touch_app_config_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists trg_app_config_touch on public.app_config;
create trigger trg_app_config_touch
  before update on public.app_config
  for each row execute function public.touch_app_config_updated_at();


-- ────────────────────────────────────────────────────────────────────────────
-- SECTION 2 — RLS: readable by everyone (incl. logged-out), writable by nobody
-- ────────────────────────────────────────────────────────────────────────────

alter table public.app_config enable row level security;
-- Belt and braces: the table owner would otherwise bypass its own policies.
alter table public.app_config force row level security;

-- SELECT to anon AND authenticated. `anon` is not optional — the version gate
-- runs BEFORE the auth gate in src/App.tsx, so the very clients we most need
-- to stop (too old to authenticate correctly against a changed schema) read
-- this row with no session at all.
drop policy if exists "app_config read for all app clients" on public.app_config;
create policy "app_config read for all app clients"
  on public.app_config
  for select
  to anon, authenticated
  using (true);

-- Deliberately NO insert/update/delete policy. With RLS enabled and no
-- permissive policy, every write from anon/authenticated is denied. Only
-- service_role (RLS-exempt) — i.e. Supabase Studio / an edge function — can
-- change the floor. Do not add a client write path here.

grant select on public.app_config to anon, authenticated;
revoke insert, update, delete on public.app_config from anon, authenticated;


-- ────────────────────────────────────────────────────────────────────────────
-- SECTION 3 — seed (current shipped versions → gate starts inert)
-- ────────────────────────────────────────────────────────────────────────────
-- package.json                 "version": "1.0.0"
-- android/app/build.gradle     versionCode 1   /   versionName "1.0.0"
--
-- ON CONFLICT DO NOTHING: re-running this file must never stomp a floor a
-- human raised in Studio during an incident.

insert into public.app_config (
  id, min_supported_version, min_supported_version_code, message_en, message_ur
) values (
  'default', '1.0.0', 1, null, null
)
on conflict (id) do nothing;


-- ────────────────────────────────────────────────────────────────────────────
-- SECTION 4 — verification (run these after applying)
-- ────────────────────────────────────────────────────────────────────────────
-- 4.1 The row exists and holds the expected floor.
--     Expect exactly one row: default | 1.0.0 | 1
--
--   select id, min_supported_version, min_supported_version_code, updated_at
--   from public.app_config;
--
-- 4.2 RLS is on and forced.
--     Expect: relrowsecurity = true, relforcerowsecurity = true
--
--   select relrowsecurity, relforcerowsecurity
--   from pg_class where oid = 'public.app_config'::regclass;
--
-- 4.3 Exactly ONE policy, SELECT only, granted to anon + authenticated.
--     Expect one row: cmd = SELECT, roles = {anon,authenticated}
--
--   select polname, polcmd, polroles::regrole[]
--   from pg_policy where polrelid = 'public.app_config'::regclass;
--
-- 4.4 No client role holds a write grant.
--     Expect ZERO rows.
--
--   select grantee, privilege_type
--   from information_schema.role_table_grants
--   where table_schema = 'public' and table_name = 'app_config'
--     and grantee in ('anon','authenticated')
--     and privilege_type in ('INSERT','UPDATE','DELETE');
--
-- 4.5 An anon client can read it. From a terminal (anon key, no session):
--
--   curl "$SUPABASE_URL/rest/v1/app_config?select=*&id=eq.default" \
--        -H "apikey: $SUPABASE_ANON_KEY"
--   -- expect: [{"id":"default","min_supported_version":"1.0.0",...}]
--
-- 4.6 Writes are refused for a client role. Expect "new row violates
--     row-level security policy" / permission denied:
--
--   set local role authenticated;
--   update public.app_config set min_supported_version = '9.9.9' where id = 'default';
--   reset role;
--
-- 4.7 The semver shape guard bites. Expect a check-constraint violation:
--
--   update public.app_config set min_supported_version = '1.4' where id = 'default';
--
-- ────────────────────────────────────────────────────────────────────────────
-- SECTION 5 — HOW TO USE THIS DURING A BREAKING RELEASE
-- ────────────────────────────────────────────────────────────────────────────
-- Order matters. Raise the floor LAST, never first.
--   1. Ship the fixed web build (Vercel, on push) and the fixed AAB (Play,
--      rolled out to 100%). Wait for the Play rollout to actually complete.
--   2. Apply the breaking migration.
--   3. Only then, in Supabase Studio:
--
--        update public.app_config
--        set min_supported_version      = '1.4.0',   -- new package.json version
--            min_supported_version_code = 12,        -- new build.gradle versionCode
--            message_en = 'This version of Hisaab can no longer talk to the server safely. Update to continue.',
--            message_ur = 'Hisaab ka yeh version ab server ke sath theek kaam nahi karega. Update karein.'
--        where id = 'default';
--
--      Leave message_en/message_ur NULL to use the app's own translated copy.
--   4. To undo a mistaken lockout, set both floors back down. Clients re-check
--      on resume (and always on a cold start), so recovery is minutes, not a
--      release cycle.
-- ════════════════════════════════════════════════════════════════════════════
