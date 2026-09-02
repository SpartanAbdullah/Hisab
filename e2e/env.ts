import path from 'node:path';
import { fileURLToPath } from 'node:url';

// package.json has "type": "module", so this file runs as ESM under Node —
// no __dirname global here; derive it from import.meta.url the same way
// vite.config.ts does at the repo root.
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Same fallback playwright.config.ts uses. Exported so any file that needs to
// construct a browser context by hand (global-setup.ts, and
// cross-user-loan.spec.ts's throwaway second-account context) can give it an
// explicit `baseURL` — a manually created context does NOT inherit the
// config's `use.baseURL` the way the `page` fixture does.
export const BASE_URL = process.env.E2E_BASE_URL || 'http://localhost:5173';

// ── Credentials & shared state ──────────────────────────────────────────────
//
// There is no way to sign up a real account in this suite: AuthPage hard-gates
// on `email_confirmed_at` (see src/App.tsx) and CI has no SMTP to click a
// verification link with. So every authenticated spec runs against a
// PRE-PROVISIONED account instead — per docs/staging-environment.md this must
// be a `hisaab-staging` account, never production. It is supplied via env
// vars and logged in through the real AuthPage UI once, in global-setup.ts;
// the resulting storageState is then shared by every authenticated test so
// the suite only logs in a single time per run.
//
// Absent credentials is a supported, GREEN state (not a failure): every
// authenticated test calls `test.skip(!hasCreds, ...)` with a clear reason,
// so `npx playwright test` stays honest locally with no secrets configured.
export const E2E_EMAIL = process.env.E2E_EMAIL ?? '';
export const E2E_PASSWORD = process.env.E2E_PASSWORD ?? '';
export const hasCreds = Boolean(E2E_EMAIL && E2E_PASSWORD);

// Second staging account for the cross-user request spec (5e). Falls back to
// E2E_PASSWORD if no distinct E2E_PASSWORD_2 is given — most setups will
// provision both staging accounts with the same throwaway password.
export const E2E_EMAIL_2 = process.env.E2E_EMAIL_2 ?? '';
export const E2E_PASSWORD_2 = process.env.E2E_PASSWORD_2 || E2E_PASSWORD;
export const hasSecondAccount = Boolean(E2E_EMAIL_2 && E2E_PASSWORD_2);

// Where global-setup.ts writes the logged-in storageState. Gitignored (see
// .gitignore's "Playwright" section) — this is a live Supabase session token,
// never something to commit.
export const AUTH_STATE_PATH = path.join(__dirname, '.auth', 'user.json');

export const SKIP_NO_CREDS_REASON =
  'E2E_EMAIL / E2E_PASSWORD not set — skipping authenticated spec. See docs/staging-environment.md for provisioning a hisaab-staging test account.';

export const SKIP_NO_SECOND_ACCOUNT_REASON =
  'E2E_EMAIL_2 (a second staging account) not set — skipping the cross-user request spec.';
