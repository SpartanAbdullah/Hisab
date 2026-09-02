import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  AMOUNT_BUCKETS,
  COUNT_BUCKETS,
  TELEMETRY_SCHEMA,
  bucketAmount,
  bucketCount,
  isKnownTelemetryEvent,
  isSafeDistinctId,
  sanitizeEventProps,
} from './telemetryEvents';

// ── Bucketing ─────────────────────────────────────────────────────────────
// Amounts NEVER leave the device; only which of five bands they fell into.

describe('bucketAmount', () => {
  it('maps the report-10 bands', () => {
    expect(bucketAmount(0)).toBe('zero');
    expect(bucketAmount(1)).toBe('lt_100');
    expect(bucketAmount(99.99)).toBe('lt_100');
    expect(bucketAmount(100)).toBe('100_1k');
    expect(bucketAmount(999.99)).toBe('100_1k');
    expect(bucketAmount(1000)).toBe('1k_10k');
    expect(bucketAmount(9999.99)).toBe('1k_10k');
    expect(bucketAmount(10000)).toBe('gt_10k');
    expect(bucketAmount(2_500_000)).toBe('gt_10k');
  });

  it('is sign-agnostic and NaN-safe (a refund must not become a new band)', () => {
    expect(bucketAmount(-450)).toBe('100_1k');
    expect(bucketAmount(Number.NaN)).toBe('zero');
    expect(bucketAmount(Number.POSITIVE_INFINITY)).toBe('zero');
  });

  it('only ever emits a declared bucket', () => {
    for (const n of [0, 5, 100, 1000, 10000, 1e9, -7]) {
      expect(AMOUNT_BUCKETS).toContain(bucketAmount(n));
    }
  });
});

describe('bucketCount', () => {
  it('caps group/kameti sizes so a big committee is not a fingerprint', () => {
    expect(bucketCount(1)).toBe('1');
    expect(bucketCount(5)).toBe('5');
    expect(bucketCount(6)).toBe('6-10');
    expect(bucketCount(10)).toBe('6-10');
    expect(bucketCount(11)).toBe('10+');
    expect(bucketCount(400)).toBe('10+');
  });

  it('clamps nonsense inputs to the smallest bucket', () => {
    expect(bucketCount(0)).toBe('1');
    expect(bucketCount(-3)).toBe('1');
    expect(bucketCount(Number.NaN)).toBe('1');
    expect(bucketCount(3.7)).toBe('3');
  });

  it('only ever emits a declared bucket', () => {
    for (const n of [1, 2, 6, 11, 99]) {
      expect(COUNT_BUCKETS).toContain(bucketCount(n));
    }
  });
});

// ── Catalog integrity ─────────────────────────────────────────────────────

describe('event catalog', () => {
  it('recognises catalogued events and rejects anything else', () => {
    expect(isKnownTelemetryEvent('entry_created')).toBe(true);
    expect(isKnownTelemetryEvent('kameti_created')).toBe(true);
    expect(isKnownTelemetryEvent('made_up_event')).toBe(false);
    // Prototype keys must not be mistaken for events.
    expect(isKnownTelemetryEvent('toString')).toBe(false);
    expect(isKnownTelemetryEvent('constructor')).toBe(false);
  });

  it('declares every event from the audit design (report 10 §5.3)', () => {
    for (const name of [
      'app_opened', 'signup_started', 'auth_completed', 'onboarding_step_viewed',
      'onboarding_mode_selected', 'onboarding_completed', 'account_created',
      'quick_entry_opened', 'entry_created', 'quick_entry_abandoned',
      'loan_created', 'repayment_recorded', 'contact_link_requested',
      'contact_link_accepted', 'group_created', 'group_invite_shared',
      'group_invite_opened', 'group_joined', 'group_expense_added',
      'settle_up_completed', 'kameti_created', 'kameti_ballot_drawn',
      'kameti_witness_viewed', 'push_permission_result', 'notification_opened',
      'statement_shared', 'ai_entry_submitted', 'error_surfaced',
    ]) {
      expect(isKnownTelemetryEvent(name)).toBe(true);
    }
  });

  it('declares no free-text property anywhere — the PII policy is structural', () => {
    for (const [event, schema] of Object.entries(TELEMETRY_SCHEMA)) {
      for (const [prop, spec] of Object.entries(schema as Record<string, { kind: string }>)) {
        expect(['bool', 'int', 'currency', 'bucket', 'enum'], `${event}.${prop}`).toContain(spec.kind);
      }
    }
  });

  it('lets no string-valued property carry a money- or identity-shaped name', () => {
    // A bool/int cannot smuggle text, so `had_amount` is fine; a string-valued
    // `amount`, `person_name` or `join_code` would not be.
    const risky = /(^|_)(amount|balance|name|phone|email|note|notes|text|description|title|code|token)$/;
    for (const [event, schema] of Object.entries(TELEMETRY_SCHEMA)) {
      for (const [prop, spec] of Object.entries(schema as Record<string, { kind: string }>)) {
        if (spec.kind === 'bool' || spec.kind === 'int') continue;
        const allowed = prop === 'currency' || prop === 'amount_bucket';
        expect(allowed || !risky.test(prop), `${event}.${prop} is a string that looks like PII`).toBe(true);
      }
    }
  });
});

// ── Sanitiser: the last line of defence ───────────────────────────────────

describe('sanitizeEventProps', () => {
  it('keeps well-shaped declared properties', () => {
    const result = sanitizeEventProps('entry_created', {
      entry_type: 'expense',
      source: 'quick_entry',
      is_first_ever: true,
      mode: 'full_tracker',
      currency: 'PKR',
      amount_bucket: '1k_10k',
    });
    expect(result.dropped).toEqual([]);
    expect(result.props).toEqual({
      entry_type: 'expense',
      source: 'quick_entry',
      is_first_ever: true,
      mode: 'full_tracker',
      currency: 'PKR',
      amount_bucket: '1k_10k',
    });
  });

  it('drops undeclared keys — a smuggled amount or note never ships', () => {
    const result = sanitizeEventProps('entry_created', {
      entry_type: 'expense',
      amount: 45000,
      notes: 'Rent to Bilal',
      person_name: 'Bilal',
      phone: '+923001234567',
    });
    expect(result.props).toEqual({ entry_type: 'expense' });
    expect(result.dropped.sort()).toEqual(['amount', 'notes', 'person_name', 'phone']);
  });

  it('drops values outside a declared enum', () => {
    const result = sanitizeEventProps('group_joined', { via: 'telepathy', surface: 'join_modal' });
    expect(result.props).toEqual({ surface: 'join_modal' });
    expect(result.dropped).toEqual(['via']);
  });

  it('enforces the shape of each kind', () => {
    expect(sanitizeEventProps('quick_entry_abandoned', { last_step: 2.5, had_amount: true }).dropped)
      .toEqual(['last_step']);
    expect(sanitizeEventProps('quick_entry_abandoned', { last_step: 2, had_amount: 'yes' }).dropped)
      .toEqual(['had_amount']);
    expect(sanitizeEventProps('group_created', { member_count_bucket: '7', currency: 'PKR' }).dropped)
      .toEqual(['member_count_bucket']);
    expect(sanitizeEventProps('group_created', { member_count_bucket: '6-10', currency: 'Pakistani Rupee' }).dropped)
      .toEqual(['currency']);
  });

  it('refuses everything for an unknown event', () => {
    const result = sanitizeEventProps('exfiltrate', { anything: 1 });
    expect(result.props).toEqual({});
    expect(result.dropped).toEqual(['anything']);
  });

  it('tolerates a missing property object', () => {
    expect(sanitizeEventProps('kameti_witness_viewed')).toEqual({ props: {}, dropped: [] });
  });
});

// ── Identity ──────────────────────────────────────────────────────────────

describe('isSafeDistinctId', () => {
  it('accepts a Supabase auth UUID', () => {
    expect(isSafeDistinctId('3f4a1b2c-9d8e-4f70-a1b2-c3d4e5f60718')).toBe(true);
    expect(isSafeDistinctId('3F4A1B2C-9D8E-4F70-A1B2-C3D4E5F60718')).toBe(true);
  });

  it('refuses anything that could be a human identifier', () => {
    expect(isSafeDistinctId('ahmed@example.com')).toBe(false);
    expect(isSafeDistinctId('+923001234567')).toBe(false);
    expect(isSafeDistinctId('Ahmed Raza')).toBe(false);
    expect(isSafeDistinctId('HSB-4K2P9X')).toBe(false);
    expect(isSafeDistinctId('')).toBe(false);
    expect(isSafeDistinctId(undefined)).toBe(false);
    expect(isSafeDistinctId(12345)).toBe(false);
  });
});

// ── Consent gate (device-level, default OFF) ──────────────────────────────

class MemoryStorage implements Storage {
  private map = new Map<string, string>();
  get length(): number { return this.map.size; }
  clear(): void { this.map.clear(); }
  getItem(key: string): string | null { return this.map.get(key) ?? null; }
  key(index: number): string | null { return [...this.map.keys()][index] ?? null; }
  removeItem(key: string): void { this.map.delete(key); }
  setItem(key: string, value: string): void { this.map.set(key, value); }
}

describe('telemetry consent', () => {
  let store: MemoryStorage;

  beforeEach(() => {
    store = new MemoryStorage();
    (globalThis as { localStorage?: Storage }).localStorage = store;
  });

  afterEach(() => {
    delete (globalThis as { localStorage?: Storage }).localStorage;
  });

  it('defaults to OFF and stays off until explicitly granted', async () => {
    const t = await import('./telemetry');
    expect(t.hasTelemetryConsent()).toBe(false);
    expect(t.isTelemetryConsentAnswered()).toBe(false);

    store.setItem('hisaab_telemetry_consent', 'denied');
    expect(t.hasTelemetryConsent()).toBe(false);
    expect(t.isTelemetryConsentAnswered()).toBe(true);

    store.setItem('hisaab_telemetry_consent', 'granted');
    expect(t.hasTelemetryConsent()).toBe(true);
  });

  it('treats a corrupted value as "no consent"', async () => {
    const t = await import('./telemetry');
    store.setItem('hisaab_telemetry_consent', 'true');
    expect(t.hasTelemetryConsent()).toBe(false);
    store.setItem('hisaab_telemetry_consent', '1');
    expect(t.hasTelemetryConsent()).toBe(false);
  });

  it('purges the SDK\'s device keys on opt-out', async () => {
    const t = await import('./telemetry');
    store.setItem('hisaab_telemetry_consent', 'granted');
    store.setItem('ph_phc_test_posthog', '{"distinct_id":"x"}');
    store.setItem('ph_something_else', 'y');
    store.setItem('hisaab_user_name', 'Ahmed');

    t.optOut();

    expect(store.getItem('ph_phc_test_posthog')).toBeNull();
    expect(store.getItem('ph_something_else')).toBeNull();
    // Non-telemetry keys are untouched.
    expect(store.getItem('hisaab_user_name')).toBe('Ahmed');
  });

  it('setTelemetryConsent(false) writes "denied" and notifies listeners', async () => {
    const t = await import('./telemetry');
    const seen: boolean[] = [];
    const unsubscribe = t.subscribeTelemetryConsent((granted) => seen.push(granted));

    t.setTelemetryConsent(false);
    expect(store.getItem('hisaab_telemetry_consent')).toBe('denied');
    expect(t.hasTelemetryConsent()).toBe(false);
    expect(seen).toEqual([false]);

    unsubscribe();
    t.setTelemetryConsent(false);
    expect(seen).toEqual([false]);
  });

  it('track() is a silent no-op with no key and no consent (never throws)', async () => {
    const t = await import('./telemetry');
    expect(t.isTelemetryConfigured()).toBe(false);
    expect(() => t.track('kameti_witness_viewed', {})).not.toThrow();
    expect(() => t.trackAppOpened()).not.toThrow();
    expect(() => t.identify('3f4a1b2c-9d8e-4f70-a1b2-c3d4e5f60718')).not.toThrow();
  });
});
