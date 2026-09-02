import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Guards the exact properties that make the audit fix real. The migration is
// hand-applied in Supabase Studio, so this is the only automated check that the
// SQL still says what the security fix requires (groupInviteJoinMigration.test
// precedent).
const migration = readFileSync('supabase-migration-audit-p0-join-abuse-limits.sql', 'utf8');

// The body of join_group_by_code only. The header comment quotes the old buggy
// code verbatim as evidence, and the verification section greps for
// 'RAISE EXCEPTION' — both would otherwise defeat these probes.
const functionBody = migration.slice(
  migration.indexOf('CREATE FUNCTION public.join_group_by_code'),
  migration.indexOf('SECTION 4.'),
);

describe('audit C5 — join/lookup abuse limits migration', () => {
  it('replaces the RAISE-based join contract with a jsonb status result (H1)', () => {
    // The whole bug: RAISE aborts the transaction and rolls back the
    // rate-limiter's own evidence row.
    expect(functionBody).not.toContain('RAISE EXCEPTION');
    expect(migration).toContain('DROP FUNCTION IF EXISTS public.join_group_by_code(TEXT, TEXT);');
    expect(migration).toContain('RETURNS JSONB');
    for (const status of [
      "'status', 'ok'",
      "'status', 'INVALID_OR_EXPIRED_CODE'",
      "'status', 'RATE_LIMITED'",
      "'status', 'CANNOT_JOIN_OWN_GROUP'",
      "'status', 'INVALID_CODE'",
      "'status', 'NOT_AUTHENTICATED'",
    ]) {
      expect(functionBody).toContain(status);
    }
  });

  it('keeps the sliding window and still records the failed attempt', () => {
    expect(functionBody).toContain("jca.succeeded = false");
    expect(functionBody).toContain("INTERVAL '5 minutes'");
    expect(functionBody).toContain('IF v_failures >= 5 THEN');
    expect(functionBody).toContain(
      'INSERT INTO public.join_code_attempts(user_id, succeeded) VALUES (v_uid, false);',
    );
  });

  it('preserves the success-path semantics of the RPC it replaces', () => {
    // Same qualified member lookup the existing verification script asserts on.
    expect(functionBody).toContain('WHERE gm.group_id = v_group.id');
    expect(functionBody).toContain("COALESCE(NULLIF(trim(p_display_name), ''), 'Member')");
    expect(functionBody).toContain('v_was_already_connected := v_member.status = \'connected\'');
    expect(functionBody).toContain('join_code_expires_at < v_now');
  });

  it('throttles lookup_profile_by_code with the phone-discovery ledger pattern (H9)', () => {
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS public.code_lookup_attempts');
    expect(migration).toContain('INSERT INTO public.code_lookup_attempts(user_id) VALUES (v_uid);');
    expect(migration).toContain('IF v_recent >= 20 THEN');
    // Throttled callers get zero rows, indistinguishable from a miss.
    expect(migration).not.toContain('RATE_LIMITED_LOOKUP');
  });

  it('stamps an expiry on every new or rotated join code', () => {
    expect(migration).toContain('CREATE TRIGGER trg_split_groups_join_code_expiry');
    expect(migration).toContain("NEW.join_code_expires_at := now() + INTERVAL '14 days';");
  });

  it('keeps both attempt ledgers unreachable from the client', () => {
    expect(migration).toContain('ALTER TABLE public.code_lookup_attempts ENABLE ROW LEVEL SECURITY;');
    expect(migration).toContain('ON public.code_lookup_attempts FOR ALL');
    expect(migration).toContain('USING (false) WITH CHECK (false);');
    expect(migration).toContain(
      'REVOKE ALL ON FUNCTION public.join_group_by_code(TEXT, TEXT) FROM PUBLIC, anon;',
    );
    expect(migration).toContain(
      'REVOKE ALL ON FUNCTION public.lookup_profile_by_code(TEXT) FROM PUBLIC, anon;',
    );
  });

  it('is idempotent and does not widen any RLS policy', () => {
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS public.join_code_attempts');
    expect(migration).toContain('DROP POLICY IF EXISTS');
    expect(migration).toContain('DROP TRIGGER IF EXISTS trg_split_groups_join_code_expiry');
    // The only policies here are the deny-all ones on the attempt ledgers.
    expect(migration.match(/CREATE POLICY/g)).toHaveLength(2);
  });
});
