// Product telemetry — a thin, consent-gated wrapper around posthog-js (EU).
//
// Mirrors the errorReporter.ts pattern: "disabled" is a first-class state, not
// an error path. Three independent gates must ALL be open before a single byte
// leaves the device:
//
//   1. `VITE_POSTHOG_KEY` is set at build time. Unset → this module is a total
//      no-op and the SDK is never even downloaded (it is behind a dynamic
//      import, so it is not in the main bundle either).
//   2. The user has granted consent. Consent is DEVICE-level (localStorage),
//      DEFAULT OFF, and is re-read on every track() — flipping the Settings
//      toggle takes effect immediately, no reload.
//   3. The event and every property survive `sanitizeEventProps()` (see
//      src/lib/telemetryEvents.ts — the PII policy is enforced there).
//
// What is NEVER sent, by construction: amounts, balances, names, phone numbers,
// note/description text, account/group/kameti names, AI input, URLs (the URL
// property denylist below strips them — /join/<token> and /loan/<id> are
// themselves identifiers). Autocapture, session recording, surveys, web
// experiments and remote feature-flag fetches are all off; `posthog-js` is
// additionally told never to load external scripts, which keeps index.html's
// `script-src 'self'` intact.
//
// NOTE: src/lib/analytics.ts is the user's own in-app spending aggregation and
// is unrelated to this file.

import type { PostHog } from 'posthog-js';
import {
  isSafeDistinctId,
  sanitizeEventProps,
  type PersonProperties,
  type TelemetryEventName,
  type TelemetryProps,
} from './telemetryEvents';

const CONSENT_KEY = 'hisaab_telemetry_consent';
const DEFAULT_HOST = 'https://eu.i.posthog.com';
const DEFAULT_UI_HOST = 'https://eu.posthog.com';
/** Bounded so a long consent-less session can never grow unbounded memory. */
const MAX_QUEUE = 50;

type SafeProps = Record<string, string | number | boolean>;

let client: PostHog | null = null;
let loading = false;
let queue: Array<{ event: string; props: SafeProps }> = [];
let pendingDistinctId: string | null = null;
let pendingPersonProps: PersonProperties | null = null;
const consentListeners = new Set<(granted: boolean) => void>();

// ── Environment ───────────────────────────────────────────────────────────

function projectKey(): string {
  const key = import.meta.env.VITE_POSTHOG_KEY as string | undefined;
  return typeof key === 'string' ? key.trim() : '';
}

function apiHost(): string {
  const host = import.meta.env.VITE_POSTHOG_HOST as string | undefined;
  const trimmed = typeof host === 'string' ? host.trim() : '';
  return trimmed || DEFAULT_HOST;
}

/** True when a project key exists in this build. Nothing happens without it. */
export function isTelemetryConfigured(): boolean {
  return projectKey().length > 0;
}

// ── Consent (device-level, default OFF) ───────────────────────────────────

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    // Safari private mode / blocked storage.
    return null;
  }
}

/** Consent is opt-IN: anything other than an explicit "granted" means no. */
export function hasTelemetryConsent(): boolean {
  try {
    return storage()?.getItem(CONSENT_KEY) === 'granted';
  } catch {
    return false;
  }
}

/** True once the user has answered either way — used to decide whether to ask. */
export function isTelemetryConsentAnswered(): boolean {
  try {
    const value = storage()?.getItem(CONSENT_KEY);
    return value === 'granted' || value === 'denied';
  } catch {
    return false;
  }
}

export function subscribeTelemetryConsent(listener: (granted: boolean) => void): () => void {
  consentListeners.add(listener);
  return () => { consentListeners.delete(listener); };
}

/**
 * Flip consent. Granting boots the SDK (and records the flip so the opt-in rate
 * is itself measurable); revoking purges everything the SDK stored on device.
 */
export function setTelemetryConsent(granted: boolean, source: 'settings' | 'onboarding' = 'settings'): void {
  try {
    storage()?.setItem(CONSENT_KEY, granted ? 'granted' : 'denied');
  } catch {
    // Storage blocked — consent then lasts for this page only, which is the
    // conservative direction (it reads back as "not granted").
  }
  if (granted) {
    void ensureLoaded();
    track('telemetry_consent_changed', { granted: true, source });
  } else {
    optOut();
  }
  for (const listener of consentListeners) {
    try { listener(granted); } catch { /* a listener must never break consent */ }
  }
}

// ── SDK lifecycle ─────────────────────────────────────────────────────────

function enabled(): boolean {
  return isTelemetryConfigured() && hasTelemetryConsent();
}

async function ensureLoaded(): Promise<void> {
  if (client || loading || !enabled()) return;
  loading = true;
  try {
    const { posthog } = await import('posthog-js');
    posthog.init(projectKey(), {
      api_host: apiHost(),
      ui_host: DEFAULT_UI_HOST,
      // Only our explicit track() calls fire. Nothing is inferred from the DOM.
      autocapture: false,
      capture_pageview: false,
      capture_pageleave: false,
      capture_dead_clicks: false,
      rageclick: false,
      disable_session_recording: true,
      disable_surveys: true,
      disable_web_experiments: true,
      // No remote <script> injection — index.html keeps `script-src 'self'`.
      disable_external_dependency_loading: true,
      // No /flags round-trip: we use no feature flags, and this removes a
      // request that would otherwise fire on every boot.
      advanced_disable_flags: true,
      // Person profiles only for signed-in users we explicitly identify;
      // kameti witnesses and logged-out visitors stay anonymous events.
      person_profiles: 'identified_only',
      persistence: 'localStorage',
      // Consent is checked before every capture; this makes the SDK's own
      // default match ours in case a code path ever bypasses track().
      opt_out_capturing_by_default: !hasTelemetryConsent(),
      // URLs in this app carry identifiers (/join/<token>, /loan/<id>,
      // /group/<id>) and the referrer can carry an invite token. None of it
      // has product value, so none of it is collected.
      property_denylist: [
        '$current_url', '$initial_current_url', '$pathname', '$initial_pathname',
        '$referrer', '$initial_referrer', '$referring_domain', '$initial_referring_domain',
        '$host', '$initial_host', '$screen_name',
      ],
      mask_personal_data_properties: true,
      ip: false,
      loaded: (ph) => {
        if (hasTelemetryConsent()) ph.opt_in_capturing();
      },
    });
    client = posthog;
    if (pendingDistinctId) {
      posthog.identify(pendingDistinctId, pendingPersonProps ?? undefined);
      pendingDistinctId = null;
      pendingPersonProps = null;
    }
    const pending = queue;
    queue = [];
    for (const item of pending) posthog.capture(item.event, item.props);
  } catch (err) {
    if (import.meta.env.DEV) console.warn('[telemetry] SDK load failed', err);
  } finally {
    loading = false;
  }
}

/**
 * Call once at app boot (src/main.tsx), before React renders. Does nothing —
 * including no network — unless the key is present AND consent was granted on
 * a previous run.
 */
export function initTelemetry(): void {
  if (!enabled()) return;
  void ensureLoaded();
}

// ── Public API ────────────────────────────────────────────────────────────

/**
 * Record one product event. Typed against the catalog, sanitised before send,
 * and a hard no-op when telemetry is off. Never throws.
 */
export function track<E extends TelemetryEventName>(event: E, props: TelemetryProps<E>): void {
  try {
    if (!enabled()) return;
    const { props: safe, dropped } = sanitizeEventProps(event, props as Record<string, unknown>);
    if (import.meta.env.DEV && dropped.length > 0) {
      console.warn(`[telemetry] dropped disallowed properties on "${event}":`, dropped);
    }
    if (client) {
      client.capture(event, safe);
      return;
    }
    if (queue.length < MAX_QUEUE) queue.push({ event, props: safe });
    void ensureLoaded();
  } catch {
    // Telemetry must never break the app.
  }
}

/**
 * Attach the session to the Supabase auth user id — an opaque first-party UUID
 * and the ONLY identifier we ever send. An email/phone/name is refused here
 * rather than trusted (see isSafeDistinctId).
 */
export function identify(anonymousStableId: string, personProps?: PersonProperties): void {
  try {
    if (!enabled()) return;
    if (!isSafeDistinctId(anonymousStableId)) {
      if (import.meta.env.DEV) console.warn('[telemetry] refused a non-opaque distinct id');
      return;
    }
    if (client) {
      client.identify(anonymousStableId, personProps as Record<string, unknown> | undefined);
      return;
    }
    pendingDistinctId = anonymousStableId;
    pendingPersonProps = personProps ?? null;
    void ensureLoaded();
  } catch {
    // ignore
  }
}

/** Update person properties without re-identifying. */
export function setPersonProperties(personProps: PersonProperties): void {
  try {
    if (!enabled() || !client) return;
    client.setPersonProperties(personProps as Record<string, unknown>);
  } catch {
    // ignore
  }
}

/** Drop the identity on logout so the next user is not merged into this one. */
export function resetTelemetryIdentity(): void {
  try {
    pendingDistinctId = null;
    pendingPersonProps = null;
    client?.reset();
  } catch {
    // ignore
  }
}

/**
 * Revoke + purge: stop capturing, clear the queue, drop the SDK's identity and
 * remove every `ph_*` key it wrote to this device. Safe to call when the SDK
 * was never loaded.
 */
export function optOut(): void {
  queue = [];
  pendingDistinctId = null;
  pendingPersonProps = null;
  try {
    client?.opt_out_capturing();
    client?.reset(true);
  } catch {
    // ignore
  }
  const store = storage();
  if (store) {
    try {
      const doomed: string[] = [];
      for (let i = 0; i < store.length; i += 1) {
        const key = store.key(i);
        if (key && key.startsWith('ph_')) doomed.push(key);
      }
      for (const key of doomed) store.removeItem(key);
    } catch {
      // ignore
    }
  }
}

// ── Boot-context helpers ──────────────────────────────────────────────────

/** Surface the app is running on. Capacitor WebView → android, else pwa. */
export function telemetrySurface(): 'pwa' | 'android' {
  try {
    if (typeof window === 'undefined') return 'pwa';
    const w = window as Window & { Capacitor?: unknown };
    return w.Capacitor || window.location.protocol === 'capacitor:' ? 'android' : 'pwa';
  } catch {
    return 'pwa';
  }
}

function readSetting(key: string): string | null {
  try {
    return storage()?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

/**
 * The `app_opened` event (catalog #1). Reads its context straight from
 * localStorage so it can run at boot, before any store has hydrated.
 */
export function trackAppOpened(): void {
  const lang = readSetting('hisaab_lang');
  const mode = readSetting('hisaab_app_mode');
  track('app_opened', {
    surface: telemetrySurface(),
    language: lang === 'ur' ? 'ur' : 'en',
    app_mode: mode === 'full_tracker' || mode === 'splits_only' ? mode : 'unknown',
    is_logged_in: Boolean(readSetting('hisaab_supabase_uid')),
  });
}
