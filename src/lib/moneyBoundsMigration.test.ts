import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SUPPORTED_CURRENCIES } from '../db/types';
import { MAX_MONEY_MAGNITUDE } from './currencyValidation';

// The migration is hand-applied in Supabase Studio, so this is the only
// automated check that the SQL still says what the audit fix requires
// (loanConcurrencyMigration.test / joinAbuseLimitsMigration.test precedent).
const migration = readFileSync('supabase-migration-p1-money-bounds.sql', 'utf8');

// The splits trigger body only. The header quotes the exploit payload verbatim
// as evidence and Section 5's finder queries repeat the same predicates, both
// of which would otherwise satisfy these probes.
const splitsTrigger = migration.slice(
  migration.indexOf('CREATE OR REPLACE FUNCTION public.tg_group_expenses_validate_split_amounts'),
  migration.indexOf('DROP TRIGGER IF EXISTS group_expenses_validate_split_amounts'),
);

describe('audit M12 — money bounds migration: constraints', () => {
  it('bounds the cross-user ledger tables strictly above zero', () => {
    expect(migration).toContain("'group_expenses', 'group_expenses_amount_positive'");
    expect(migration).toContain("'group_settlements', 'group_settlements_amount_positive'");
    expect(migration).toContain("'amount > 0 AND amount < 1e12'");
  });

  it('bounds the personal money columns, allowing the legitimate zeroes', () => {
    // >= 0, not > 0: zero-cash investment rows and the rounding tail of a tiny
    // EMI schedule are real. Negative is what the finding is about.
    expect(migration).toContain("'transactions', 'transactions_amount_bounded',\n    'amount >= 0 AND amount < 1e12'");
    expect(migration).toContain("'emi_schedules', 'emi_schedules_amount_bounded',\n    'amount >= 0 AND amount < 1e12'");
    expect(migration).toContain("'upcoming_expenses', 'upcoming_expenses_amount_bounded'");
    expect(migration).toContain("'goals', 'goals_target_amount_bounded'");
    expect(migration).toContain("'goals', 'goals_saved_amount_bounded'");
  });

  it('bounds account balances by MAGNITUDE, because credit cards go negative', () => {
    expect(migration).toContain("'accounts', 'accounts_balance_bounded',\n    'balance > -1e12 AND balance < 1e12'");
    // A `balance >= 0` here would brick every credit-card user.
    expect(migration).not.toContain("'balance >= 0");
  });

  it('bounds loans and keeps remaining under total', () => {
    expect(migration).toContain("'loans', 'loans_total_amount_bounded'");
    expect(migration).toContain("'loans', 'loans_remaining_amount_bounded'");
    expect(migration).toContain(
      "'loans', 'loans_remaining_not_over_total',\n    'remaining_amount <= total_amount + 0.01'",
    );
  });

  it('bounds the cross-user request tables, kameti, investments and recurring', () => {
    expect(migration).toContain("'linked_transaction_requests', 'ltr_amount_bounded'");
    expect(migration).toContain("'linked_settlement_requests', 'lsr_amount_bounded'");
    expect(migration).toContain("'committees', 'committees_contribution_amount_positive'");
    expect(migration).toContain("'investment_trades', 'investment_trades_amounts_bounded'");
    expect(migration).toContain("'investment_prices', 'investment_prices_price_bounded'");
    expect(migration).toContain("'recurring_transactions', 'recurring_transactions_amount_bounded'");
    expect(migration).toContain("'budgets', 'budgets_monthly_amount_bounded'");
  });

  it('pins the conversion-rate window to conversionMath RATE_MIN/RATE_MAX', () => {
    expect(migration).toContain(
      'conversion_rate IS NULL OR (conversion_rate >= 0.0001 AND conversion_rate <= 100000)',
    );
  });

  it('uses the same magnitude ceiling as the client', () => {
    expect(MAX_MONEY_MAGNITUDE).toBe(1e12);
    // Every bound is written as the literal 1e12; if the client constant moves,
    // this fails and forces the SQL to move with it.
    expect(migration).toContain(`${MAX_MONEY_MAGNITUDE.toExponential().replace('+', '')}`);
  });
});

describe('audit M12 — money bounds migration: currency whitelist', () => {
  it('declares the eight shipped currencies in exactly one array', () => {
    const list = SUPPORTED_CURRENCIES.map((c) => `'${c}'`).join(',');
    expect(migration).toContain(`v_currencies CONSTANT TEXT[] := ARRAY[${list}]`);
    // One place only. Any second literal list would be a drift source — the
    // whole point of §0. (audit-p0-currencies.sql owns the two linked_* tables
    // and is deliberately not duplicated here.)
    const occurrences = migration.split(`ARRAY[${list}]`).length - 1;
    expect(occurrences).toBe(1);
  });

  it('generates the whitelist for every table that has a currency column', () => {
    for (const table of [
      'profiles',
      'accounts',
      'transactions',
      'loans',
      'goals',
      'upcoming_expenses',
      'split_groups',
      'committees',
      'investment_markets',
      'budgets',
      'recurring_transactions',
      'remittances',
    ]) {
      expect(migration, `${table} missing from the currency column list`).toContain(`'${table}',`);
    }
  });

  it('does NOT redefine the two constraints audit-p0-currencies.sql owns', () => {
    // They are named in the §0 header (explaining who owns them) but must
    // never be re-declared here — that would put the currency list in two
    // places, the exact drift §0 exists to prevent.
    expect(migration).not.toContain("'ltr_currency_supported'");
    expect(migration).not.toContain("'lsr_currency_supported'");
    expect(migration).not.toContain('ADD CONSTRAINT ltr_currency_supported');
    expect(migration).not.toContain('ADD CONSTRAINT lsr_currency_supported');
    // The two linked_* tables must not appear in the generated currency-column
    // list either.
    expect(migration).not.toContain("ARRAY['linked_transaction_requests',");
    expect(migration).not.toContain("ARRAY['linked_settlement_requests',");
  });
});

describe('audit M12 — money bounds migration: the splits trigger', () => {
  it('is a NEW function and trigger, not a replacement of either sibling', () => {
    expect(migration).toContain(
      'CREATE OR REPLACE FUNCTION public.tg_group_expenses_validate_split_amounts()',
    );
    expect(migration).toContain('CREATE TRIGGER group_expenses_validate_split_amounts');
    // The two siblings must be named only in comments/verification — never
    // redefined or dropped, or this file silently undoes a P0 fix.
    expect(migration).not.toContain(
      'CREATE OR REPLACE FUNCTION public.tg_group_expenses_require_connected_members',
    );
    expect(migration).not.toContain('CREATE OR REPLACE FUNCTION public.tg_group_expenses_version_guard');
    expect(migration).not.toContain('DROP TRIGGER IF EXISTS group_expenses_require_connected_members');
    expect(migration).not.toContain('DROP TRIGGER IF EXISTS group_expenses_version_guard');
  });

  it('validates the shape of the splits array', () => {
    expect(splitsTrigger).toContain("jsonb_typeof(v_splits) <> 'array'");
    expect(splitsTrigger).toContain('jsonb_array_length(v_splits) = 0');
    expect(splitsTrigger).toContain('INVALID_GROUP_SPLITS');
  });

  it('requires every share to be a real, non-negative, in-range number', () => {
    // `jsonb_typeof(... -> 'amount') <> 'number'` is what rejects the string
    // "50000", null, true and a missing key in one predicate.
    expect(splitsTrigger).toContain("jsonb_typeof(s.value -> 'amount') <> 'number'");
    expect(splitsTrigger).toContain("(s.value ->> 'amount')::numeric < 0");
    expect(splitsTrigger).toContain("(s.value ->> 'amount')::numeric >= 1e12");
    expect(splitsTrigger).toContain('INVALID_GROUP_SPLIT_AMOUNT');
    // >= 0, not > 0 — a zero share is reachable from equalSplits' rounding
    // tail and from an exact/percentage split. At least one must be positive.
    expect(splitsTrigger).toContain("(s.value ->> 'amount')::numeric > 0");
    expect(splitsTrigger).toContain('at least one split share must be greater than zero');
  });

  it('requires every memberId to belong to this group, camelCase or snake_case', () => {
    expect(splitsTrigger).toContain("COALESCE(s.value ->> 'memberId', s.value ->> 'member_id')");
    expect(splitsTrigger).toContain('gm.group_id = NEW.group_id');
    expect(splitsTrigger).toContain('INVALID_GROUP_SPLIT_MEMBER');
  });

  it('THE FINDING: shares must sum to the amount within 0.01', () => {
    expect(splitsTrigger).toContain('abs(v_sum - NEW.amount) > 0.01');
    expect(splitsTrigger).toContain('GROUP_SPLITS_DO_NOT_SUM');
    expect(splitsTrigger).toContain("USING ERRCODE = '23514'");
  });

  it('short-circuits on metadata-only edits so history stays editable', () => {
    // Without this, reconciling or soft-deleting a historical row would
    // re-run the arithmetic and could freeze legacy rows outright.
    expect(splitsTrigger).toContain('NEW.amount   IS NOT DISTINCT FROM OLD.amount');
    expect(splitsTrigger).toContain('NEW.splits   IS NOT DISTINCT FROM OLD.splits');
    expect(splitsTrigger).toContain('NEW.group_id IS NOT DISTINCT FROM OLD.group_id');
  });
});

describe('audit M12 — money bounds migration: apply safety', () => {
  it('adds every constraint NOT VALID and validates it best-effort', () => {
    expect(migration).toContain('CHECK (%s) NOT VALID');
    expect(migration).toContain('VALIDATE CONSTRAINT');
    // The exception handler is what stops a legacy row from aborting the whole
    // apply and leaving the hole open.
    expect(migration).toContain('EXCEPTION WHEN check_violation THEN');
    expect(migration).toContain('left NOT VALID');
  });

  it('is idempotent: every add is a drop-then-add, guarded by table existence', () => {
    expect(migration).toContain('DROP CONSTRAINT IF EXISTS');
    expect(migration).toContain("to_regclass('public.' || quote_ident(p_table)) IS NULL");
    expect(migration).toContain('DROP TRIGGER IF EXISTS group_expenses_validate_split_amounts');
    expect(migration).toContain('CREATE OR REPLACE FUNCTION');
  });

  it('changes no policy and no RPC', () => {
    expect(migration).not.toContain('CREATE POLICY');
    expect(migration).not.toContain('DROP POLICY');
    expect(migration).not.toContain('SECURITY DEFINER');
    expect(migration).not.toContain('GRANT EXECUTE');
  });

  it('leaves no permanent helper behind (pg_temp is session-scoped)', () => {
    expect(migration).toContain('CREATE OR REPLACE FUNCTION pg_temp.hisaab_money_check');
    expect(migration).not.toContain('CREATE OR REPLACE FUNCTION public.hisaab_money_check');
  });

  it('ships verification and row-finder queries the applier can actually run', () => {
    expect(migration).toContain('SECTION 4. VERIFICATION');
    expect(migration).toContain('c.convalidated');
    expect(migration).toContain('SECTION 5. FINDERS');
    expect(migration).toContain('p1-money-bounds: verification passed');
  });
});
