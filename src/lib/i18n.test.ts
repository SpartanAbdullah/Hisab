import { describe, it, expect } from 'vitest';
import { documentLangFor } from './i18n';

// Pure mapping only (Language -> document.documentElement.lang BCP-47 tag).
// Importing i18n.ts also runs its module-level `applyDocumentLang(...)` call
// at boot — safe under vitest's `node` environment because that function
// guards on `typeof document === "undefined"` (see i18n.ts) rather than
// assuming a DOM exists.
describe('documentLangFor', () => {
  it('maps "ur" (roman/Latin-script Urdu) to the ur-Latn BCP-47 tag, not bare "ur"', () => {
    // Bare "ur" implies Perso-Arabic script to assistive tech; this app's
    // "ur" is transliterated Latin-script Urdu, so the script subtag is
    // required, not cosmetic.
    expect(documentLangFor('ur')).toBe('ur-Latn');
  });

  it('maps "en" to plain "en"', () => {
    expect(documentLangFor('en')).toBe('en');
  });
});
