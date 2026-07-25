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
}

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
          // pushRegistration.ts hrefForType). Values must be strings.
          data: {
            type: String(payload.type ?? 'system'),
            notification_id: String(payload.notification_id ?? ''),
          },
          android: {
            priority: 'HIGH',
            notification: {
              // Matches the local-notification glyph so tray notifications
              // from both channels look like the same app.
              icon: 'ic_stat_hisaab',
              color: '#0B0E2A',
              // Collapse on the notification row id: a retry can never
              // produce two identical entries in the tray.
              tag: String(payload.notification_id ?? ''),
              default_sound: true,
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

    return new Response(JSON.stringify({ sent, devices: tokens.length }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    console.error('[push-notify] failed', err);
    // 200 on purpose: pg_net does not retry, and a non-2xx here would only
    // fill the net response table with noise. The failure is in the logs.
    return new Response(JSON.stringify({ sent: 0, error: String(err) }), { status: 200 });
  }
});
