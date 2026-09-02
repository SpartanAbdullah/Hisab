-- ═══════════════════════════════════════════════════════════════════════════
-- Audit 2026-09 · P2 item M2(b) — move the money tables from postgres_changes
--                                 to Realtime Broadcast-from-database
--
-- Findings: docs/audit-2026-09/03-performance.md  H5  (HIGH, CONFIRMED)
--           docs/audit-2026-09/04-supabase.md     F-SC1 (medium, UNVERIFIED)
--                                                 F-RT1/F-RT2 (context)
--
-- PROBLEM
-- `supabase-migration-linked-notifications-realtime.sql:126-146` adds
-- `loans`, `transactions` and `accounts` to the `supabase_realtime`
-- publication, and `src/lib/realtime.ts` binds them with `postgres_changes`
-- filtered on `user_id=eq.<uid>`. postgres_changes evaluates EVERY WAL change
-- against EVERY subscription on a single-threaded service, running an RLS
-- check per subscriber per change. Those three tables are the highest-churn
-- personal tables in the app — one expense entry writes `transactions` AND
-- `accounts` — so the per-change fan-out work scales with concurrent users
-- while each individual user only ever wants their own rows. Supabase's own
-- documentation points at Broadcast once this matters.
--
-- WHAT THIS MIGRATION DOES
-- Adds AFTER STATEMENT triggers on `public.transactions`, `public.accounts`
-- and `public.loans` that call `realtime.send(payload, event, topic, private)`
-- once per affected user per statement, on that user's private topic
-- `user:<uid>`, plus an RLS policy on `realtime.messages` that lets a user
-- read ONLY their own topic. The server then does one targeted insert per
-- statement instead of a subscription scan per WAL record.
--
--   topic   'user:' || <uid>          (must match src/lib/realtime.ts's
--                                      moneyBroadcastTopic() EXACTLY)
--   event   'transactions' | 'accounts' | 'loans'   (= the table name)
--   payload {"table": …, "op": INSERT|UPDATE|DELETE, "rows": <n>}
--
-- The payload carries NO money, names, notes or row ids — the client's
-- handler already ignores it and re-reads through the mirror's incremental
-- sync (`markMirrorStale` + the debounced store reload), so there is nothing
-- to gain from a fat payload and a PII surface to lose.
--
-- WHAT THIS MIGRATION DELIBERATELY DOES NOT DO
--   * It does NOT remove the three tables from the `supabase_realtime`
--     publication. Both transports must work at once, because the client
--     flag rolls out independently of this SQL (see ROLLOUT below). The
--     publication drop is written out, commented, in §5 — run it only after
--     every shipped client has the flag ON.
--   * It does NOT touch the cross-user tables (`notifications`,
--     `group_members`, `linked_transaction_requests`,
--     `linked_settlement_requests`, `contact_link_requests`). Those are
--     low-churn, are written by the OTHER user, and their per-change RLS
--     check is exactly what makes delivery correct. They stay on
--     postgres_changes — this migration changes nothing about them.
--   * It does NOT add an INSERT policy on `realtime.messages`. Only the
--     database (via these SECURITY DEFINER triggers) may write to a user
--     topic; a client cannot forge a "your balance changed" broadcast into
--     someone else's topic.
--
-- APPLY ORDER
-- LAST — after every file in docs/audit-2026-09/APPLY-ORDER.md §1 and §2.
-- It shares no object with any of them (its only public objects are one new
-- function and nine new triggers), so it is order-independent in practice;
-- "last" is simply the safe default for a brand-new file.
--
-- SAFE AHEAD OF THE CLIENT: yes, and that is the intended sequence. With the
-- client flag OFF (the default) the broadcasts are written and nobody
-- subscribes — the only cost is one small insert into `realtime.messages`
-- per money statement. Nothing in the current client breaks.
--
-- ROLLOUT
--   1. Apply this file. Verify with §6. Nothing changes for users.
--   2. Confirm broadcasts are being produced (§6 query V6, run right after
--      saving an expense from a test account).
--   3. Ship a client build with VITE_REALTIME_BROADCAST=true. Money-table
--      events now arrive over Broadcast; the postgres_changes bindings for
--      those three tables are not registered at all in that build.
--   4. Once no old client remains (Play Store rollout complete — the Android
--      binary lags the web deploy), run §5's publication drop to actually
--      collect the win.
--   Rollback at any point: unset the client flag (or roll back the web
--   deploy). The publication is untouched until step 4, so the old transport
--   is still live and correct.
--
-- PREREQUISITE — "Broadcast from Database" must be available on the project
-- ------------------------------------------------------------------------
-- `realtime.send(jsonb, text, text, boolean)` and the `realtime.messages`
-- table ship with Supabase's Realtime extension. They are NOT present on a
-- bare `postgres:15` image, and they may be absent on an old self-hosted
-- Realtime. Every DDL block below is therefore guarded with
-- `to_regprocedure` / `to_regclass`: on an instance without them the file
-- applies cleanly, installs the triggers, and each trigger becomes a no-op
-- until the function appears (the check is at RUNTIME inside the function,
-- not just at install time). The operator prerequisite is:
--
--   Supabase Dashboard → Database → Replication / Realtime must be enabled
--   for the project (it is, on every hosted project — the app already uses
--   postgres_changes), and the project must be on a Realtime version that
--   ships `realtime.send` (generally available since 2024). Verify with V1
--   in §6 BEFORE trusting the broadcast path; if V1 says MISSING, do not
--   turn the client flag on.
--
-- DOCKER VALIDATION
-- Validated on `postgres:15` with a hand-rolled stub of the realtime schema
-- (see the note at the end of §6): `realtime.messages` as a plain table and
-- `realtime.send` / `realtime.topic` as SQL stubs. That proves the DDL, the
-- trigger wiring, the per-user fan-out and the idempotency of a second pass.
-- It does NOT prove the hosted Realtime service actually delivers the
-- messages, nor the private-channel authorization handshake — those need the
-- V6 check against the real project.
--
-- SAFETY / IDEMPOTENCY
--   * `create or replace function`, `drop trigger if exists` before each
--     `create trigger`, policy creation guarded by a catalog lookup — the
--     whole file re-applies cleanly.
--   * The trigger body is wrapped in its own BEGIN/EXCEPTION block and always
--     returns NULL: a broadcast failure (missing partition, revoked grant,
--     realtime schema absent) raises a WARNING and the money write COMMITS.
--     A realtime hiccup must never be able to fail an expense.
--   * AFTER STATEMENT + transition tables: N inserted rows produce ONE
--     message per user, not N. The consolidated-repayment loop
--     (`src/lib/repaymentExecution.ts`) and any future batch write therefore
--     cost one message each, where postgres_changes charged per row.
-- ═══════════════════════════════════════════════════════════════════════════

begin;

-- ───────────────────────────────────────────────────────────────────────────
-- §1 · The broadcast function
-- ───────────────────────────────────────────────────────────────────────────
-- SECURITY DEFINER: `realtime.send` inserts into `realtime.messages`, which
-- the `authenticated` role has no direct write grant on. Running as the
-- function owner (postgres, when applied from the Supabase SQL editor) is
-- what lets a user's own INSERT produce a broadcast without granting any
-- client the ability to write messages directly.
--
-- search_path is pinned (repo convention for every definer function; the one
-- exception, handle_new_user, is audit finding F-AUTH3).

create or replace function public.hisaab_broadcast_money_change()
returns trigger
language plpgsql
security definer
set search_path = public, realtime, pg_temp
as $$
declare
  v_user_id uuid;
  v_rows integer := 0;
begin
  -- Runtime capability check. `to_regprocedure` returns NULL rather than
  -- raising when the function does not exist, so this file is safe to apply
  -- to an instance whose realtime schema has not been provisioned (a bare
  -- postgres image, an old self-hosted Realtime). The triggers then simply
  -- do nothing until the function appears — no error, no failed writes.
  if to_regprocedure('realtime.send(jsonb,text,text,boolean)') is null then
    return null;
  end if;

  begin
    if tg_op = 'DELETE' then
      -- One message per DISTINCT owner in the statement. Cross-user
      -- SECURITY DEFINER RPCs (accept_linked_request, accept_settlement_request,
      -- apply_account_balance_delta on the counterparty's row) can touch two
      -- users' rows in one statement — each must be told.
      for v_user_id, v_rows in
        select o.user_id, count(*)::int
          from old_rows o
         where o.user_id is not null
         group by o.user_id
      loop
        perform realtime.send(
          jsonb_build_object('table', tg_table_name, 'op', tg_op, 'rows', v_rows),
          tg_table_name,                       -- event = table name
          'user:' || v_user_id::text,          -- private per-user topic
          true                                 -- private → RLS-checked
        );
      end loop;
    else
      for v_user_id, v_rows in
        select n.user_id, count(*)::int
          from new_rows n
         where n.user_id is not null
         group by n.user_id
      loop
        perform realtime.send(
          jsonb_build_object('table', tg_table_name, 'op', tg_op, 'rows', v_rows),
          tg_table_name,
          'user:' || v_user_id::text,
          true
        );
      end loop;
    end if;
  exception when others then
    -- NEVER break a money write for a notification. The client's resume path
    -- (refreshLiveData) is the backstop for a dropped signal.
    raise warning 'hisaab_broadcast_money_change(%, %) failed: %',
      tg_table_name, tg_op, sqlerrm;
  end;

  return null;
end;
$$;

comment on function public.hisaab_broadcast_money_change() is
  'Audit P2 M2(b): AFTER STATEMENT trigger that emits one Realtime Broadcast '
  'per affected user per statement on the private topic user:<uid>. Replaces '
  'postgres_changes for accounts/transactions/loans. No-op (and never fatal) '
  'when realtime.send is unavailable.';

-- ───────────────────────────────────────────────────────────────────────────
-- §2 · Triggers
-- ───────────────────────────────────────────────────────────────────────────
-- Three per table. PostgreSQL forbids transition tables on a trigger with
-- more than one event ("transition tables cannot be specified for triggers
-- with more than one event"), so INSERT / UPDATE / DELETE each get their own.
-- INSERT and UPDATE declare only NEW TABLE; DELETE only OLD TABLE — the
-- function branches on TG_OP and never references the table it wasn't given.
--
-- Soft deletes are UPDATEs (`deleted_at`), so the DELETE trigger is for the
-- rare hard delete only; it is installed for completeness.

do $$
declare
  t text;
begin
  foreach t in array array['transactions', 'accounts', 'loans'] loop
    if to_regclass('public.' || t) is null then
      raise notice 'p2-realtime-broadcast: public.% missing — skipped', t;
      continue;
    end if;

    execute format('drop trigger if exists trg_broadcast_%1$s_ins on public.%1$I', t);
    execute format($f$
      create trigger trg_broadcast_%1$s_ins
        after insert on public.%1$I
        referencing new table as new_rows
        for each statement
        execute function public.hisaab_broadcast_money_change()
    $f$, t);

    execute format('drop trigger if exists trg_broadcast_%1$s_upd on public.%1$I', t);
    execute format($f$
      create trigger trg_broadcast_%1$s_upd
        after update on public.%1$I
        referencing new table as new_rows
        for each statement
        execute function public.hisaab_broadcast_money_change()
    $f$, t);

    execute format('drop trigger if exists trg_broadcast_%1$s_del on public.%1$I', t);
    execute format($f$
      create trigger trg_broadcast_%1$s_del
        after delete on public.%1$I
        referencing old table as old_rows
        for each statement
        execute function public.hisaab_broadcast_money_change()
    $f$, t);
  end loop;
end;
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- §3 · RLS on realtime.messages — a user may read ONLY their own topic
-- ───────────────────────────────────────────────────────────────────────────
-- A private channel (`supabase.channel('user:<uid>', { config: { private:
-- true } })`) is authorized per subscriber against a SELECT policy on
-- `realtime.messages`. Without this policy the join is refused and the client
-- receives nothing — which is the correct fail-closed direction, but it means
-- this block is load-bearing for the feature.
--
-- `realtime.topic()` returns the topic of the channel being authorized.
-- Wrapping auth.uid() in a scalar subquery is the Supabase-recommended form
-- (the planner evaluates it once instead of per row).
--
-- Guarded three ways: the table may not exist (bare postgres), the policy may
-- already exist (re-run), and the role applying the file may not own the
-- realtime schema (self-hosted). None of those may abort the migration.

do $$
begin
  if to_regclass('realtime.messages') is null then
    raise notice 'p2-realtime-broadcast: realtime.messages missing — RLS policy skipped. '
                 'Broadcast will not work until the Realtime extension is provisioned.';
    return;
  end if;

  if exists (
    select 1 from pg_policies
     where schemaname = 'realtime'
       and tablename  = 'messages'
       and policyname = 'hisaab_read_own_user_topic'
  ) then
    raise notice 'p2-realtime-broadcast: policy hisaab_read_own_user_topic already present';
    return;
  end if;

  begin
    execute $p$
      create policy hisaab_read_own_user_topic
        on realtime.messages
        for select
        to authenticated
        using (
          extension = 'broadcast'
          and realtime.topic() = 'user:' || (select auth.uid())::text
        )
    $p$;
    raise notice 'p2-realtime-broadcast: policy hisaab_read_own_user_topic created';
  exception when others then
    raise warning 'p2-realtime-broadcast: could not create the realtime.messages policy (%). '
                  'Create it by hand as the owner before enabling VITE_REALTIME_BROADCAST.',
                  sqlerrm;
  end;
end;
$$;

commit;

-- ───────────────────────────────────────────────────────────────────────────
-- §4 · Rollback (paste-able, not executed)
-- ───────────────────────────────────────────────────────────────────────────
-- Turning the client flag off is the real rollback — it takes effect
-- immediately and leaves the DB alone. To remove the server side as well:
--
--   drop trigger if exists trg_broadcast_transactions_ins on public.transactions;
--   drop trigger if exists trg_broadcast_transactions_upd on public.transactions;
--   drop trigger if exists trg_broadcast_transactions_del on public.transactions;
--   drop trigger if exists trg_broadcast_accounts_ins     on public.accounts;
--   drop trigger if exists trg_broadcast_accounts_upd     on public.accounts;
--   drop trigger if exists trg_broadcast_accounts_del     on public.accounts;
--   drop trigger if exists trg_broadcast_loans_ins        on public.loans;
--   drop trigger if exists trg_broadcast_loans_upd        on public.loans;
--   drop trigger if exists trg_broadcast_loans_del        on public.loans;
--   drop function if exists public.hisaab_broadcast_money_change();
--   drop policy if exists hisaab_read_own_user_topic on realtime.messages;

-- ───────────────────────────────────────────────────────────────────────────
-- §5 · STEP 4 OF THE ROLLOUT — collect the win (do NOT run yet)
-- ───────────────────────────────────────────────────────────────────────────
-- Only after every shipped client (web AND the Play Store Android binary,
-- which lags) runs with VITE_REALTIME_BROADCAST=true. Until then these three
-- tables must stay in the publication or old clients go silently stale.
--
--   alter publication supabase_realtime drop table public.transactions;
--   alter publication supabase_realtime drop table public.accounts;
--   alter publication supabase_realtime drop table public.loans;
--
-- Cross-user tables STAY in the publication — do not touch
-- notifications / group_members / *_requests here.

-- ───────────────────────────────────────────────────────────────────────────
-- §6 · Verification (read-only — safe to run any time)
-- ───────────────────────────────────────────────────────────────────────────

-- V1 · Is broadcast-from-database available at all?
select
  'V1 realtime.send present' as check,
  case when to_regprocedure('realtime.send(jsonb,text,text,boolean)') is null
       then '!! MISSING — triggers are inert; do NOT enable VITE_REALTIME_BROADCAST'
       else 'ok' end as verdict;

-- V2 · Are the nine triggers installed and enabled?
select
  'V2 triggers' as check,
  c.relname   as table_name,
  t.tgname    as trigger_name,
  case t.tgenabled when 'O' then 'enabled' else 'DISABLED (' || t.tgenabled::text || ')' end as state
from pg_trigger t
join pg_class c on c.oid = t.tgrelid
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
  and t.tgname like 'trg_broadcast_%'
order by c.relname, t.tgname;
-- Expect exactly 9 rows, all 'enabled'.

-- V3 · Is the function SECURITY DEFINER with a pinned search_path?
select
  'V3 function hardening' as check,
  p.proname,
  p.prosecdef as security_definer,
  coalesce(array_to_string(p.proconfig, ', '), '(none)') as settings
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname = 'hisaab_broadcast_money_change';
-- Expect security_definer = t, settings containing search_path.

-- V4 · Every policy on realtime.messages (ours must be the only SELECT one
--      that a plain authenticated user matches; there must be NO client
--      INSERT policy, or users could forge broadcasts into other topics).
select
  'V4 realtime.messages policies' as check,
  policyname, cmd, roles::text, qual, with_check
from pg_policies
where schemaname = 'realtime' and tablename = 'messages'
order by cmd, policyname;

-- V5 · The publication still carries the three tables (it must, until
--      rollout step 4).
select
  'V5 publication' as check,
  tablename,
  'still published (expected until rollout step 4)' as note
from pg_publication_tables
where pubname = 'supabase_realtime'
  and schemaname = 'public'
  and tablename in ('transactions', 'accounts', 'loans')
order by tablename;

-- V6 · LIVE PROOF. Save one expense from a test account, then run this
--      within a minute. Zero rows means the triggers are not producing
--      broadcasts — do not enable the client flag.
--      (realtime.messages is partitioned by day and retained briefly.)
--      Guarded so the file also applies on an instance (or the CI harness)
--      without the Realtime schema: a bare SELECT against a missing relation
--      fails at parse time and would abort the whole file.
do $$
declare v_n bigint;
begin
  if to_regclass('realtime.messages') is null then
    raise notice 'V6 recent broadcasts: realtime.messages missing — skipped';
    return;
  end if;
  execute $q$
    select count(*) from realtime.messages
     where event in ('transactions', 'accounts', 'loans')
       and inserted_at > now() - interval '10 minutes'
  $q$ into v_n;
  raise notice 'V6 recent broadcasts (last 10 min): %', v_n;
end
$$;

-- Docker note: on a bare `postgres:15` image V1 reports MISSING and V4/V6
-- error with "schema realtime does not exist" — that is expected and is
-- exactly what the runtime guard in §1 is for. To exercise §1/§2 locally,
-- stub the schema first:
--
--   create schema if not exists realtime;
--   create table if not exists realtime.messages (
--     id bigserial primary key, topic text, event text, payload jsonb,
--     private boolean, extension text, inserted_at timestamptz default now());
--   create or replace function realtime.send(payload jsonb, event text,
--     topic text, private boolean default true) returns void language sql as $$
--     insert into realtime.messages(topic, event, payload, private, extension)
--     values (topic, event, payload, private, 'broadcast'); $$;
--   create or replace function realtime.topic() returns text language sql
--     stable as $$ select current_setting('realtime.topic', true) $$;
--
-- …then apply this file, insert a couple of rows into public.transactions in
-- ONE statement, and confirm realtime.messages holds exactly ONE row with
-- topic 'user:<uid>', event 'transactions' and payload rows = 2.
