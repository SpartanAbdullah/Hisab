/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SUPABASE_URL: string;
  readonly VITE_SUPABASE_ANON_KEY: string;
  readonly VITE_PUBLIC_APP_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

/**
 * Build-time constant: the `version` field of package.json, substituted by
 * Vite's `define` (vite.config.ts). Used by the minimum-supported-version gate
 * (src/lib/versionGate.ts) to decide whether this bundle may still talk to the
 * backend. It is NOT defined under Vitest, so every read goes through
 * `getCurrentAppVersion()`, which guards with `typeof`.
 */
declare const __APP_VERSION__: string;
