-- ════════════════════════════════════════════════════════════════════════════
-- Hisaab — profiles.lang (audit item H5, finding 08-notifications.md N-1)
-- ----------------------------------------------------------------------------
-- Run this in the Supabase SQL Editor. Idempotent: safe to re-run.
-- Apply AFTER:
--   supabase-schema.sql                      (creates public.profiles)
--   supabase-migration-p0-launch-blockers.sql
--   supabase-migration-audit-p0-notifications.sql
-- Order-independent w.r.t. every other p1 migration — this file adds one
-- nullable-free column with a default and touches nothing else. It creates no
-- policy, no trigger, no function, and no index.
--
-- ────────────────────────────────────────────────────────────────────────────
-- WHAT THIS FIXES
-- ────────────────────────────────────────────────────────────────────────────
-- Audit 2026-09-02, 08-notifications.md N-1 (HIGH):
--   Every cross-user notification is hardcoded English in an Urdu-default
--   product. Linked request/settlement triggers
--   (supabase-migration-linked-notifications-realtime.sql:48-49, 60-63, 92-93,
--   104-107), the contact-link RPCs
--   (supabase-migration-connections-push-discovery.sql:137-140, 174-177,
--   283-285) and the client group fan-out all freeze English title/body at
--   write time. Push renders that text verbatim
--   (supabase/functions/push-notify/index.ts:171-174).
--
--   The root cause is that the *writer* cannot know the *reader's* language:
--   the preference lived only in the reader's device localStorage
--   (src/lib/i18n.ts, key `hisaab_lang`). This migration puts it where a
--   trigger, an RPC or the push function can actually read it.
--
-- Related, same audit item (06-user-experience.md UX-04): the client default
-- for a device with no stored preference was flipped from 'en' to 'ur' in
-- src/lib/i18n.ts (`DEFAULT_LANGUAGE`). The column default below matches it
-- deliberately — a profile created before its owner ever opens the language
-- step should read as roman-Urdu, which is what the product, the Play listing
-- and CLAUDE.md all promise.
--
-- ────────────────────────────────────────────────────────────────────────────
-- WHAT IS **NOT** IN THIS MIGRATION — read before wiring anything to it
-- ────────────────────────────────────────────────────────────────────────────
-- Server-side localization of notification title/body is DEFERRED, on purpose.
--
--   supabase-migration-audit-p0-notifications.sql already moved group fan-out
--   into AFTER triggers that store a machine-readable `type` plus a `params`
--   payload, and the client renders the human sentence from those through
--   src/lib/i18n.ts at read time. For the in-app bell and the Inbox that means
--   the content is ALREADY correct in whatever language the reader is using —
--   storing lang server-side buys nothing there.
--
--   The gap that remains is the FCM push path only: push-notify renders the
--   frozen `title`/`body` columns verbatim, because a system notification is
--   composed by the server, not by a React tree. Closing that needs a second
--   change — templating inside push-notify (or the trigger) keyed off
--   `profiles.lang` of the RECIPIENT — which is a separate, larger unit of
--   work with its own copy review, and is tracked as its own item.
--
--   So: this migration is the PRECONDITION, not the fix. It is safe and
--   useful to apply on its own (the client starts writing the column the
--   moment the matching build ships), and nothing reads it server-side yet.
--
-- ────────────────────────────────────────────────────────────────────────────
-- CLIENT SIDE (already in this branch — no action needed here)
-- ────────────────────────────────────────────────────────────────────────────
--   • src/lib/i18n.ts `setLang()` → profilesDb.updateCurrent({ lang })
--     (best-effort, fire-and-forget, no-op while signed out).
--   • src/App.tsx boot profile fetch → reconcileProfileLang(profile.lang),
--     which backfills users who chose a language before this column existed.
--     Device preference wins.
--   The client tolerates the column being absent (the update is swallowed), so
--   shipping the build before applying this SQL degrades gracefully.
-- ════════════════════════════════════════════════════════════════════════════

begin;

-- ────────────────────────────────────────────────────────────────────────────
-- SECTION 1 — the column
-- ────────────────────────────────────────────────────────────────────────────
-- NOT NULL DEFAULT 'ur': existing rows are backfilled to 'ur' by the ADD
-- COLUMN itself, which matches the client's DEFAULT_LANGUAGE. Any user who has
-- actually chosen 'en' overwrites it on their next app boot (App.tsx
-- reconcileProfileLang) or the next time they touch the toggle.
alter table public.profiles
  add column if not exists lang text not null default 'ur';

-- Separate, guarded so a re-run does not error on the existing constraint.
-- CHECK rather than an enum: two values, and a text column keeps the PostgREST
-- surface and the TS type (`Language = 'ur' | 'en'`) trivially aligned.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'profiles_lang_check'
      and conrelid = 'public.profiles'::regclass
  ) then
    alter table public.profiles
      add constraint profiles_lang_check check (lang in ('ur', 'en'));
  end if;
end $$;

comment on column public.profiles.lang is
  'UI language of this user (ur = roman Urdu, en = English). Written by the '
  'client on every language switch (src/lib/i18n.ts setLang) so that '
  'server-composed content addressed TO this user — currently only the FCM '
  'push body, see audit N-1 — can be localized for the reader rather than '
  'frozen in the writer''s language. Default ur: the product is Urdu-first.';

commit;

-- ────────────────────────────────────────────────────────────────────────────
-- SECTION 2 — RLS
-- ────────────────────────────────────────────────────────────────────────────
-- Nothing to do. `profiles` already has RLS with a self-update policy, and
-- this column rides on it: a user can write their own lang and no one else's.
-- Deliberately NOT added to any policy's WITH CHECK and NOT restricted from
-- being read by connected users — the recipient's language is not a secret,
-- and a future server-side templating step needs to read it as the sender.
--
-- Verify (should list the pre-existing self-update policy, unchanged):
--
--   select policyname, cmd, qual, with_check
--   from pg_policies
--   where schemaname = 'public' and tablename = 'profiles'
--   order by policyname;

-- ────────────────────────────────────────────────────────────────────────────
-- SECTION 3 — VERIFICATION (run these after applying)
-- ────────────────────────────────────────────────────────────────────────────
--
-- 3.1 The column exists with the right type, nullability and default:
--
--   select column_name, data_type, is_nullable, column_default
--   from information_schema.columns
--   where table_schema = 'public' and table_name = 'profiles'
--     and column_name = 'lang';
--   -- expect: lang | text | NO | 'ur'::text
--
-- 3.2 The CHECK constraint is present and is the only one on lang:
--
--   select conname, pg_get_constraintdef(oid)
--   from pg_constraint
--   where conrelid = 'public.profiles'::regclass
--     and conname = 'profiles_lang_check';
--   -- expect: profiles_lang_check | CHECK ((lang = ANY (ARRAY['ur'::text, 'en'::text])))
--
-- 3.3 Every existing row was backfilled — no nulls, no strays:
--
--   select lang, count(*) from public.profiles group by lang order by lang;
--   -- expect: only 'ur' (and 'en' once clients start reconciling); never NULL
--
-- 3.4 The guard actually bites. Expect a check-constraint violation:
--
--   update public.profiles set lang = 'fr' where id = auth.uid();
--
-- 3.5 A signed-in client can write its own row (run from the app, or with a
--     user JWT). Expect 1 row updated and the value to stick:
--
--   update public.profiles set lang = 'en' where id = auth.uid();
--   select lang from public.profiles where id = auth.uid();
--
-- 3.6 Re-running this whole file is a no-op — apply it twice and re-run 3.1
--     and 3.2; both must return exactly the same single row.
--
-- ────────────────────────────────────────────────────────────────────────────
-- ROLLBACK (only if this has to be backed out before the client ships)
-- ────────────────────────────────────────────────────────────────────────────
--   alter table public.profiles drop constraint if exists profiles_lang_check;
--   alter table public.profiles drop column if exists lang;
--   -- The client write is best-effort and swallowed on error, so dropping the
--   -- column does not break a shipped build; it only stops the mirroring.
-- ════════════════════════════════════════════════════════════════════════════
