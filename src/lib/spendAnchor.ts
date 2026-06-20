// "Anchor to something real" — turn a money amount into a relatable comparison
// for the Gulf-expat audience (a round-trip ticket home, or the user's own
// karak habit). Makes a dry number land emotionally. Approximate by design and
// clearly hedged ("about …"). Pure + tested.

const PKR_PER_AED = 76; // rough, for relatability only — never for posting money
const KARAK_AED = 1.5; // a karak chai ≈ AED 1.5

/** A short "about …" comparison, or null when nothing fitting applies. */
export function spendAnchor(amount: number, currency: string): string | null {
  if (!Number.isFinite(amount) || amount <= 0) return null;

  let aed: number;
  if (currency === 'AED') aed = amount;
  else if (currency === 'PKR') aed = amount / PKR_PER_AED;
  else return null; // only the home currencies — don't fake comparisons elsewhere

  // A meaningful chunk of money → a trip home is the comparison that hits.
  if (aed >= 600 && aed <= 2000) return 'about a round-trip ticket home ✈️';

  // Smaller sums → their own karak habit (playful, culturally on-brand).
  const karaks = Math.round(aed / KARAK_AED);
  if (karaks >= 15 && karaks <= 2000) return `about ${karaks.toLocaleString('en-US')} karaks ☕`;

  return null;
}
