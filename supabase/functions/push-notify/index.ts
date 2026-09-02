// Supabase Edge Function: notifications row → Android push via FCM HTTP v1.
//
// Called by the `notifications_push` trigger (pg_net, fire-and-forget) that
// supabase-migration-connections-push-discovery.sql installs. The trigger is
// a no-op until app_push_config holds this function's URL and shared secret,
// so nothing here runs — and nothing breaks — before Firebase exists.
//
// Deploy + configure: see docs/push-notifications-setup.md
//
//   supabase functions deploy push-notify --no-verify-jwt
//
// --no-verify-jwt is required: the caller is Postgres, not a signed-in user.
// Authentication is the shared secret below instead, which is why that header
// check is the first thing that happens and why a mismatch returns 401 with
// no detail.

interface PushRequest {
  user_id?: string;
  title?: string;
  body?: string;
  type?: string;
  notification_id?: string;
  // ── Added by supabase-migration-p2-notification-maturity.sql §8 ──────────
  /** In-app route to open on tap, e.g. /group/G1, /kameti/K1, /inbox.
   *  Audit 08-notifications.md N-8: every push used to land on /inbox or
   *  /groups and make the user hunt. */
  href?: string;
  /** Android notification channel: money | groups | kameti. Lets a user
   *  demote group chatter in OS settings without losing loan requests
   *  (audit N-10). Unknown/absent values fall back to CHANNEL_FALLBACK. */
  channel_id?: string;
  /** Tray grouping key (group id + template, or type + row id). Ten expenses
   *  in one trip become one tray entry instead of ten (audit N-10). */
  collapse_key?: string;
  /** TRUE when it is currently inside the RECIPIENT's configured quiet hours,
   *  computed by notification_in_quiet_hours() in the trigger — the DB has the
   *  prefs row one index lookup away, this function would need an extra REST
   *  round-trip per push. The DELIVERY DECISION is made here (see quiet-hours
   *  handling below), not there. */
  quiet?: boolean;
}

// Must stay in step with the channels registered in
// src/lib/pushRegistration.ts and with notification_channel_for() in
// supabase-migration-p2-notification-maturity.sql §3. An unknown channel is
// dropped rather than forwarded: Android silently refuses to display a
// notification whose channel_id does not exist on the device.
const CHANNELS = new Set(['money', 'groups', 'kameti', 'reminders']);
const CHANNEL_FALLBACK = 'groups';

interface ServiceAccount {
  project_id: string;
  client_email: string;
  private_key: string;
}

const SHARED_SECRET = Deno.env.get('PUSH_SHARED_SECRET') ?? '';
const SERVICE_ACCOUNT_JSON = Deno.env.get('FCM_SERVICE_ACCOUNT') ?? '';
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';

// ── Google OAuth: service-account JWT → access token ───────────────────────
// Tokens last an hour. Edge Function instances are reused across invocations,
// so caching turns "two network round-trips per notification" into one.
let cachedToken: { value: string; expiresAt: number } | null = null;

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function pemToPkcs8(pem: string): Uint8Array {
  // Service-account keys arrive with literal \n when the JSON is stored in an
  // env var — normalise before stripping the armour.
  const normalised = pem.replace(/\\n/g, '\n');
  const body = normalised
    .replace(/-----BEGIN PRIVATE KEY-----/, '')
    .replace(/-----END PRIVATE KEY-----/, '')
    .replace(/\s+/g, '');
  const raw = atob(body);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
  return out;
}

async function getAccessToken(account: ServiceAccount): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  // 60s of slack so a token can't expire mid-flight.
  if (cachedToken && cachedToken.expiresAt > now + 60) return cachedToken.value;

  const header = { alg: 'RS256', typ: 'JWT' };
  const claim = {
    iss: account.client_email,
    scope: 'https://www.googleapis.com/auth/firebase.messaging',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  };
  const encoder = new TextEncoder();
  const unsigned =
    `${base64UrlEncode(encoder.encode(JSON.stringify(header)))}.` +
    `${base64UrlEncode(encoder.encode(JSON.stringify(claim)))}`;

  const key = await crypto.subtle.importKey(
    'pkcs8',
    pemToPkcs8(account.private_key),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, encoder.encode(unsigned));
  const jwt = `${unsigned}.${base64UrlEncode(new Uint8Array(signature))}`;

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }),
  });
  if (!res.ok) throw new Error(`token exchange failed: ${res.status} ${await res.text()}`);
  const json = await res.json() as { access_token: string; expires_in: number };
  cachedToken = { value: json.access_token, expiresAt: now + json.expires_in };
  return json.access_token;
}

// ── Token store ───────────────────────────────────────────────────────────

async function fetchTokens(userId: string): Promise<string[]> {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/device_push_tokens?user_id=eq.${userId}&select=token`,
    { headers: { apikey: SERVICE_ROLE_KEY, Authorization: `Bearer ${SERVICE_ROLE_KEY}` } },
  );
  if (!res.ok) throw new Error(`token fetch failed: ${res.status}`);
  const rows = await res.json() as Array<{ token: string }>;
  return rows.map((r) => r.token).filter(Boolean);
}

/** Drop a token FCM has told us is dead. Leaving these around means every
 *  future notification pays for a guaranteed-failing request, forever. */
async function dropToken(token: string): Promise<void> {
  await fetch(
    `${SUPABASE_URL}/rest/v1/device_push_tokens?token=eq.${encodeURIComponent(token)}`,
    {
      method: 'DELETE',
      headers: { apikey: SERVICE_ROLE_KEY, Authorization: `Bearer ${SERVICE_ROLE_KEY}` },
    },
  ).catch(() => {});
}

// ── Handler ───────────────────────────────────────────────────────────────

Deno.serve(async (req) => {
  if (req.method !== 'POST') return new Response('method not allowed', { status: 405 });

  // The only authentication this endpoint has. Constant-ish comparison isn't
  // meaningful here (the secret is high-entropy and the endpoint is not a
  // timing oracle for anything else), but the check must come first.
  if (!SHARED_SECRET || req.headers.get('x-hisaab-push-secret') !== SHARED_SECRET) {
    return new Response('unauthorized', { status: 401 });
  }

  let payload: PushRequest;
  try {
    payload = await req.json();
  } catch {
    return new Response('bad request', { status: 400 });
  }
  const userId = payload.user_id;
  if (!userId) return new Response('missing user_id', { status: 400 });

  if (!SERVICE_ACCOUNT_JSON) {
    // Configured trigger, unconfigured function. Report it rather than
    // failing silently — silent no-push is exactly the bug we're fixing.
    console.error('[push-notify] FCM_SERVICE_ACCOUNT is not set');
    return new Response(JSON.stringify({ sent: 0, reason: 'not_configured' }), { status: 200 });
  }

  try {
    const account = JSON.parse(SERVICE_ACCOUNT_JSON) as ServiceAccount;
    const tokens = await fetchTokens(userId);
    if (tokens.length === 0) {
      return new Response(JSON.stringify({ sent: 0, reason: 'no_devices' }), { status: 200 });
    }

    const accessToken = await getAccessToken(account);
    const endpoint =
      `https://fcm.googleapis.com/v1/projects/${account.project_id}/messages:send`;

    // ── Anti-fatigue shaping (audit N-10) ─────────────────────────────────
    // QUIET HOURS DELIVER SILENTLY, THEY DO NOT DEFER. The notification still
    // lands in the tray — the user must not lose a loan request because it
    // arrived at 01:00 — but it does not ring, buzz, or wake the screen. They
    // find it waiting in the morning instead of being woken by it.
    //
    // Why not defer: pg_net is fire-and-forget and there is no queue or
    // scheduler in this pipeline. Deferring would mean a pending-push table
    // plus a cron drain, i.e. a second delivery path that can fail silently —
    // exactly the failure mode audit N-4 is about. Silent delivery gets almost
    // all of the benefit for almost none of the machinery.
    const quiet = payload.quiet === true;
    const channelId = payload.channel_id && CHANNELS.has(payload.channel_id)
      ? payload.channel_id
      : CHANNEL_FALLBACK;
    // Tray grouping. Falls back to the row id, which is what this function used
    // before M5 — so retry dedupe is preserved even for a pre-migration
    // database that sends no collapse_key.
    const tag = String(payload.collapse_key || payload.notification_id || '');

    let sent = 0;
    await Promise.all(tokens.map(async (token) => {
      const message = {
        message: {
          token,
          notification: {
            title: payload.title || 'Hisaab',
            body: payload.body || '',
          },
          // `data` reaches the app on tap so it can route (see
          // pushRegistration.ts). Values must be strings.
          data: {
            type: String(payload.type ?? 'system'),
            notification_id: String(payload.notification_id ?? ''),
            // Deep link. The tap handler prefers this over the type-based
            // guess, so a "Ali added an expense in Flat 12" push opens Flat 12
            // (audit N-8).
            href: String(payload.href ?? ''),
            collapse_key: tag,
            channel_id: channelId,
          },
          android: {
            // Quiet hours drop the message out of the high-priority lane, so
            // Android does not heads-up/peek it or bypass Doze.
            priority: quiet ? 'NORMAL' : 'HIGH',
            notification: {
              // Matches the local-notification glyph so tray notifications
              // from both channels look like the same app.
              icon: 'ic_stat_hisaab',
              color: '#0B0E2A',
              // Android 8+ routes by channel; the client registers these in
              // pushRegistration.ts. Without a valid channel_id the OS drops
              // the notification entirely, which is why unknown values fall
              // back rather than pass through.
              channel_id: channelId,
              // Collapse per group thread (or per row for money items): a trip
              // entered as ten expenses is one tray entry that updates, not
              // ten (audit N-10).
              tag,
              // NOTE: android.collapse_key (transit collapse) is deliberately
              // NOT set. FCM allows only four distinct collapse keys per
              // device and may discard an entire key's messages beyond that —
              // a user in five active groups could silently lose a thread.
              // `tag` collapses in the tray with no such limit and no risk of
              // dropped delivery.
              default_sound: !quiet,
              default_vibrate_timings: !quiet,
              notification_priority: quiet ? 'PRIORITY_LOW' : 'PRIORITY_DEFAULT',
            },
          },
        },
      };

      const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(message),
      });

      if (res.ok) { sent += 1; return; }

      const text = await res.text();
      // 404 UNREGISTERED = app uninstalled or token rotated.
      // 400 INVALID_ARGUMENT on the token field = malformed/stale token.
      if (res.status === 404 || (res.status === 400 && text.includes('INVALID_ARGUMENT'))) {
        await dropToken(token);
        return;
      }
      console.error('[push-notify] FCM send failed', res.status, text);
    }));

    return new Response(
      JSON.stringify({ sent, devices: tokens.length, channel: channelId, quiet, tag }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  } catch (err) {
    console.error('[push-notify] failed', err);
    // 200 on purpose: pg_net does not retry, and a non-2xx here would only
    // fill the net response table with noise. The failure is in the logs.
    return new Response(JSON.stringify({ sent: 0, error: String(err) }), { status: 200 });
  }
});
