// The one invariant in the consent-guards migration that can break SILENTLY.
//
// link_contact_by_discovery re-derives, in SQL, the same E.164 candidates the
// client derives in TS — that re-derivation is the whole reason the RPC can
// refuse to trust the (person, profile) pairing a client sends. If
// src/lib/phoneIdentity.ts gains a country, changes a national length or moves
// a length bound and public.phone_e164_candidates does not, nothing throws:
// discovery links just quietly stop resolving for the numbers that drifted,
// and users get "that number isn't theirs any more" for a number that is.
//
// So this file asserts the two sides still describe the same rules. It is a
// text check, matching the repo's other *Migration.test.ts files (the SQL
// cannot be executed here); the migration's own verification query 4.11 pins
// the actual outputs against the same pairs at apply time.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { toE164Candidates } from './phoneIdentity';

const migration = readFileSync(
  resolve('supabase-migration-audit-p0-consent-guards.sql'),
  'utf8',
);
const phoneIdentity = readFileSync(resolve('src/lib/phoneIdentity.ts'), 'utf8');

/** The SUPPORTED table as the client actually declares it. */
function clientCountries(): Array<{ calling: string; nationalLength: string; mobilePrefix: string }> {
  const rows = [...phoneIdentity.matchAll(
    /calling:\s*'(\d+)',\s*nationalLength:\s*(\d+),\s*mobilePrefix:\s*'(\d+)'/g,
  )];
  return rows.map(([, calling, nationalLength, mobilePrefix]) => ({
    calling,
    nationalLength,
    mobilePrefix,
  }));
}

describe('phone_e164_candidates mirrors toE164Candidates', () => {
  it('finds the client country table at all (guards this test against silent rot)', () => {
    expect(clientCountries().length).toBeGreaterThan(0);
  });

  it('declares the same countries, national lengths and mobile prefixes', () => {
    for (const { calling, nationalLength, mobilePrefix } of clientCountries()) {
      // e.g. ('971'::TEXT, 9::INT, '5'::TEXT)
      expect(migration).toContain(
        `('${calling}'::TEXT, ${nationalLength}::INT, '${mobilePrefix}'::TEXT)`,
      );
    }
  });

  it('does not carry a country the client has never heard of', () => {
    const sqlCallingCodes = new Set(
      [...migration.matchAll(/\('(\d+)'::TEXT, \d+::INT, '\d+'::TEXT\)/g)].map(([, code]) => code),
    );
    const clientCallingCodes = new Set(clientCountries().map((c) => c.calling));
    for (const code of sqlCallingCodes) expect(clientCallingCodes).toContain(code);
  });

  it('uses the same digit bounds', () => {
    // MIN_DIGITS = 7, MAX_DIGITS = 15, and the E.164 string ceiling of 16.
    expect(phoneIdentity).toContain('const MIN_DIGITS = 7;');
    expect(phoneIdentity).toContain('const MAX_DIGITS = 15;');
    expect(migration).toContain("IF length(v_digits) < 7 OR length(v_digits) > 15 THEN");
    expect(migration).toContain('length(v_candidate) <= 16');
  });

  it('keeps the same three shortcuts: explicit +, 00, and one trunk 0', () => {
    expect(migration).toContain("IF left(v_trimmed, 1) = '+' THEN");
    expect(migration).toContain("IF left(v_digits, 2) = '00' THEN");
    expect(migration).toContain(
      "CASE WHEN left(v_digits, 1) = '0' THEN substr(v_digits, 2) ELSE v_digits END",
    );
  });

  // A tripwire, not a re-test of phoneIdentity: if any of these client answers
  // changes, verification query 4.11 in the migration is now asserting the
  // wrong pairs and must be updated in the same commit.
  it.each([
    ['+971 50 123 4567', '+971501234567'],
    ['+92 300 1234567', '+923001234567'],
    ['00971501234567', '+971501234567'],
    ['050 123 4567', '+971501234567'],
    ['03001234567', '+923001234567'],
    ['501234567', '+971501234567'],
    ['3001234567', '+923001234567'],
    ['971501234567', '+971501234567'],
    ['(050) 123-4567', '+971501234567'],
  ])('the pair pinned in verification 4.11 still holds: %s', (raw, expected) => {
    expect(toE164Candidates(raw)).toEqual([expected]);
    expect(migration).toContain(`public.phone_e164_candidates('${raw}')`);
    expect(migration).toContain(`ARRAY['${expected}']`);
  });
});

describe('link_contact_by_discovery never trusts the client pairing', () => {
  it('re-derives the caller own saved number rather than taking one as input', () => {
    expect(migration).toContain('public.phone_e164_candidates(v_person.phone)');
    // The signature takes a profile id to TEST, never a phone number to match.
    expect(migration).toContain(
      'CREATE OR REPLACE FUNCTION public.link_contact_by_discovery(\n  p_person_id  TEXT,\n  p_profile_id UUID\n)',
    );
  });

  it('re-checks the target opt-in and soft-delete at link time', () => {
    expect(migration).toContain('pr.phone_discoverable');
    expect(migration).toContain('pr.phone_e164 IS NOT NULL');
    expect(migration).toContain('pr.phone_e164 = ANY (v_candidates)');
    expect(migration).toContain('COALESCE(pr.is_deleted, false) = false');
  });

  it('meters the phone window, not the code window, and only on a miss', () => {
    expect(migration).toContain('INSERT INTO public.phone_lookup_attempts(user_id) VALUES (v_uid)');
    const body = migration.slice(
      migration.indexOf('CREATE OR REPLACE FUNCTION public.link_contact_by_discovery'),
    );
    const fnEnd = body.indexOf('REVOKE ALL ON FUNCTION public.link_contact_by_discovery');
    const discovery = body.slice(0, fnEnd);
    expect(discovery).not.toContain('code_lookup_attempts');
    // The charge sits inside the NO_MATCH branch.
    expect(
      discovery.indexOf('INSERT INTO public.phone_lookup_attempts'),
    ).toBeGreaterThan(discovery.indexOf('IF v_target IS NULL THEN'));
  });

  it('is granted to authenticated only, and the unchecked internals to nobody', () => {
    expect(migration).toContain(
      'GRANT EXECUTE ON FUNCTION public.link_contact_by_discovery(TEXT, UUID) TO authenticated;',
    );
    expect(migration).toContain(
      'REVOKE ALL ON FUNCTION public.apply_verified_contact_link(TEXT, UUID, TEXT)\n  FROM PUBLIC, anon, authenticated;',
    );
    expect(migration).toContain(
      'REVOKE ALL ON FUNCTION public.phone_e164_candidates(TEXT) FROM PUBLIC, anon, authenticated;',
    );
  });
});

describe('link_contact_by_code no longer double-charges a successful link', () => {
  it('charges the code window inside the NO_MATCH branch only', () => {
    const start = migration.indexOf('CREATE OR REPLACE FUNCTION public.link_contact_by_code');
    const body = migration.slice(start, migration.indexOf('REVOKE ALL ON FUNCTION public.link_contact_by_code'));
    expect(body).toContain('INSERT INTO public.code_lookup_attempts(user_id) VALUES (v_uid)');
    expect(body.indexOf('INSERT INTO public.code_lookup_attempts')).toBeGreaterThan(
      body.indexOf('IF v_target IS NULL THEN'),
    );
    // Exactly one charge site: a second would be the old pre-lookup one.
    expect(body.match(/INSERT INTO public\.code_lookup_attempts/g)).toHaveLength(1);
  });

  it('routes both link paths through the one shared consent step', () => {
    expect(migration).toContain('RETURN public.apply_verified_contact_link(v_person.id, v_target, v_name);');
    expect(migration.match(/RETURN public\.apply_verified_contact_link/g)).toHaveLength(2);
  });
});
