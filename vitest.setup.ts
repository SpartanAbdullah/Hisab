// ── Timezone pin. MUST stay first: Node caches the resolved zone the first
//    time a Date is formatted, so any `new Date()` above this line would lock
//    in the machine's local zone and make DST-boundary assertions
//    machine-dependent. vitest.config.ts advertises this pin; until
//    2026-09 it did not actually exist and the suite's determinism was
//    accidental (audit 2026-09, 12-qa-review.md F-12).
//    CI also exports TZ=UTC as a belt-and-braces measure.
process.env.TZ = 'UTC';

// Minimal localStorage / sessionStorage polyfill so pure-function code
// that reads them (settlementNudges, monthlyWrap) works under Node.
//
// We intentionally do NOT polyfill `crypto.randomUUID` here — that's
// available on Node 20+ which this project already requires.

class MemoryStorage implements Storage {
  private store = new Map<string, string>();
  get length(): number {
    return this.store.size;
  }
  clear(): void {
    this.store.clear();
  }
  getItem(key: string): string | null {
    return this.store.get(key) ?? null;
  }
  key(index: number): string | null {
    return [...this.store.keys()][index] ?? null;
  }
  removeItem(key: string): void {
    this.store.delete(key);
  }
  setItem(key: string, value: string): void {
    this.store.set(key, value);
  }
}

if (typeof globalThis.localStorage === 'undefined') {
  globalThis.localStorage = new MemoryStorage();
}
if (typeof globalThis.sessionStorage === 'undefined') {
  globalThis.sessionStorage = new MemoryStorage();
}

// Pin the UI language for the suite.
//
// A number of tests assert English copy verbatim ("No group needed", "cleared",
// "split 3 ways"). They used to pass by accident: src/lib/i18n.ts had no stored
// preference under Node and fell back to "en". Audit UX-04 flipped that default
// to "ur" (DEFAULT_LANGUAGE) because the product is roman-Urdu-first, which
// would silently change what every one of those assertions is reading.
//
// Pinning it here keeps those tests asserting the language they were written
// against, and makes the dependency explicit instead of implicit. A test that
// wants to check Urdu copy should call useI18nStore.getState().setLang('ur')
// itself — and must restore 'en' afterwards, since the store is module-level.
localStorage.setItem('hisaab_lang', 'en');
