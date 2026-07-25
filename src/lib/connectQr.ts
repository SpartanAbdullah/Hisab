// QR payloads for connecting two Hisaab users face-to-face.
//
// The code in a QR is the SAME public code that already exists (HSB-XXXXXX)
// — a QR is just a faster way to hand it over than reading six characters
// aloud across a table. That means a scan can never do something a typed
// code couldn't, and a printed/screenshotted code stays valid.
//
// Encoded form is a real https URL so that:
//   • a non-Hisaab scanner (any camera app) lands on the app's page instead
//     of showing the user meaningless text, and
//   • Android App Links can route it straight into the app when installed.
import { normalizePublicCode } from './collaboration';

/** A code as it appears in a QR / share text: HSB- + 6 chars from the
 *  unambiguous alphabet (no O/I/0/1). */
const CODE_PATTERN = /HSB-?([ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6})/i;

function appOrigin(): string {
  const configured = (import.meta.env.VITE_PUBLIC_APP_URL as string | undefined)?.trim();
  const fallback = typeof window === 'undefined' ? '' : window.location.origin;
  return (configured || fallback).replace(/\/+$/, '');
}

/** The string that gets encoded into the user's own QR. */
export function buildConnectUrl(publicCode: string): string {
  const code = publicCode.trim().replace(/^@/, '').toUpperCase();
  const origin = appOrigin();
  return origin ? `${origin}/u/${code}` : `/u/${code}`;
}

/**
 * Pull a Hisaab public code out of whatever the camera decoded.
 *
 * Accepts, in rough order of how often it happens in the wild:
 *   • https://usehisaab.com/u/HSB-ABC234   (our own QR)
 *   • hisaab://u/HSB-ABC234               (custom scheme, if ever used)
 *   • @HSB-ABC234 / HSB-ABC234            (someone shared the text)
 *   • "Add me on Hisaab: HSB-ABC234"      (pasted share message)
 *
 * Returns the NORMALISED code (what lookup_profile_by_code matches on), or
 * null when the payload has nothing that looks like a Hisaab code — which is
 * what tells the UI to say "that's not a Hisaab QR" instead of failing a
 * lookup with a confusing "no user found".
 */
export function extractConnectCode(raw: string): string | null {
  const text = (raw ?? '').trim();
  if (!text) return null;

  // Prefer an explicit /u/<code> path — an unambiguous "this is a connect
  // link" signal, and it survives a code that shares characters with the
  // surrounding URL.
  const pathMatch = text.match(/\/u\/([A-Za-z0-9-]+)/);
  if (pathMatch) {
    const normalised = normalizePublicCode(pathMatch[1]);
    if (normalised.length >= 6) return normalised;
  }

  const loose = text.match(CODE_PATTERN);
  if (loose) return normalizePublicCode(`HSB-${loose[1]}`);

  // Bare six-character code with no prefix at all (someone typed just the
  // suffix). Only accept when the WHOLE payload is that code — otherwise
  // we'd match random substrings of unrelated QR content.
  const bare = normalizePublicCode(text);
  if (/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/.test(bare)) return bare;

  return null;
}

/** Human-facing form of a normalised code, for display and share text. */
export function formatConnectCode(normalised: string): string {
  return `HSB-${normalised.toUpperCase()}`;
}
