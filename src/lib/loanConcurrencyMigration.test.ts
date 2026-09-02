import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// The migration is hand-applied in Supabase Studio, so this is the only
// automated check that the SQL still says what the audit fix requires
// (joinAbuseLimitsMigration.test precedent).
const migration = readFileSync('supabase-migration-audit-p0-loan-concurrency.sql', 'utf8');

// Body of the RPC only — the header comment quotes the old buggy client code
// verbatim as evidence and the verification section greps for the same
// identifiers, both of which would otherwise satisfy these probes.
const functionBody = migration.slice(
  migration.indexOf('CREATE OR REPLACE FUNCTION public.apply_loan_remaining_delta'),
  migration.indexOf('REVOKE ALL ON FUNCTION'),
);

describe('audit C10 (loan part) — remaining_amount optimistic lock migration', () => {
  it('defines the compare-and-swap RPC with the contract the client calls', () => {
    expect(functionBody).toContain('p_loan_id TEXT');
    expect(functionBody).toContain('p_delta NUMERIC');
    expect(functionBody).toContain('p_expected_remaining NUMERIC');
    expect(functionBody).toContain('RETURNS NUMERIC');
    // The lock itself: the UPDATE only fires when the caller's expected value
    // still matches the row. Losing that predicate silently reintroduces F-2.
    expect(functionBody).toContain('AND round(remaining_amount, 2) = round(p_expected_remaining, 2)');
    expect(functionBody).toContain("RAISE EXCEPTION 'LOAN_REMAINING_CONFLICT' USING ERRCODE = 'P0001'");
  });

  it('scopes every access to the caller and skips soft-deleted loans', () => {
    // SECURITY DEFINER means RLS is not consulted — these predicates ARE the
    // access control.
    expect(functionBody).toContain('SECURITY DEFINER');
    expect(functionBody).toContain('SET search_path = public');
    expect(functionBody).toContain('v_uid UUID := auth.uid()');
    expect(functionBody).toContain("RAISE EXCEPTION 'NOT_AUTHENTICATED'");
    expect(functionBody.match(/user_id = v_uid/g)).toHaveLength(2); // probe + update
    expect(functionBody.match(/deleted_at IS NULL/g)).toHaveLength(2);
    expect(functionBody).toContain("RAISE EXCEPTION 'LOAN_NOT_FOUND'");
  });

  it('clamps at zero and re-derives status inside the same statement (F-19)', () => {
    expect(functionBody).toContain('round(GREATEST(0, remaining_amount + p_delta), 2)');
    expect(functionBody).toContain("THEN 'settled'");
    expect(functionBody).toContain("ELSE 'active'");
  });

  it('is idempotent and grants execute to authenticated users only', () => {
    expect(migration).toContain('CREATE OR REPLACE FUNCTION');
    expect(migration).toContain(
      'REVOKE ALL ON FUNCTION public.apply_loan_remaining_delta(TEXT, NUMERIC, NUMERIC) FROM PUBLIC, anon;',
    );
    expect(migration).toContain(
      'GRANT EXECUTE ON FUNCTION public.apply_loan_remaining_delta(TEXT, NUMERIC, NUMERIC) TO authenticated;',
    );
    // No policy or table is widened by this migration.
    expect(migration).not.toContain('CREATE POLICY');
    expect(migration).not.toContain('DROP POLICY');
  });

  it('ships verification queries the applier can actually run', () => {
    expect(migration).toContain('SECTION 2. Verification');
    expect(migration).toContain('has_function_privilege(');
    expect(migration).toContain('pg_get_functiondef(');
    expect(migration).toContain('inconsistent_rows');
  });
});
