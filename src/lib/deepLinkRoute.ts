// Pure URL → in-app route mapping for native deep links (Android App Links /
// custom scheme). Shared by both delivery paths in `nativeBridge.ts`:
//   - `appUrlOpen` (Capacitor App plugin) — fires only when the singleTask
//     MainActivity is already running (`onNewIntent`), i.e. a WARM start.
//   - `App.getLaunchUrl()` — the only way to see the VIEW intent that
//     CREATED the activity, i.e. a COLD start (app was killed, user tapped
//     an invite/witness link). See MF-03, docs/audit-2026-09/07-mobile-first.md.
// Kept dependency-free (no Capacitor, no stores) so it's cheaply and
// deterministically unit-testable.
export function extractDeepLinkPath(url: string): string | null {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname + parsed.search;
    return path && path !== '/' ? path : null;
  } catch {
    // Malformed URL — the OS already handed us a sanitised URL, so this is
    // mostly a defensive guard against custom-scheme oddities.
    return null;
  }
}
