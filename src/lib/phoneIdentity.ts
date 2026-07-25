// Turning a phone number a human typed into something two devices can agree
// on. This is the whole basis of "is this contact already on Hisaab?" — if
// Ali saves "050 123 4567" and Ali's own profile says "+971501234567", the
// match has to still happen.
//
// Deliberately NOT a full libphonenumber. Hisaab's markets are the UAE and
// Pakistan, and shipping a 200KB metadata table to resolve two country codes
// would cost more than it earns on the low-end Androids this app targets.
// Instead:
//   • A number already in international form is trusted as-is.
//   • A local-looking number produces CANDIDATES, one per plausible country,
//     and the server tells us which (if any) exists. Guessing one country and
//     being wrong would silently break discovery; asking about both costs one
//     extra array element.
//   • Anything too short to be a real number produces nothing at all.

/** Countries Hisaab actually operates in, with their national trunk rules. */
const SUPPORTED = [
  // UAE: mobile numbers are 9 digits nationally (5X XXX XXXX), written 05X…
  { calling: '971', nationalLength: 9, mobilePrefix: '5' },
  // Pakistan: 10 digits nationally (3XX XXXXXXX), written 03XX…
  { calling: '92', nationalLength: 10, mobilePrefix: '3' },
] as const;

const MIN_DIGITS = 7;
const MAX_DIGITS = 15; // E.164 hard ceiling

function digitsOf(raw: string): string {
  return (raw ?? '').replace(/[^\d]/g, '');
}

/**
 * Every E.164 string this input could plausibly mean, best guess first.
 * Empty when the input can't be a phone number at all.
 *
 * Examples:
 *   "+971 50 123 4567" → ["+971501234567"]          (explicit, trusted)
 *   "00971501234567"   → ["+971501234567"]          (00 is just a written +)
 *   "0501234567"       → ["+971501234567"]          (national 0 + UAE mobile)
 *   "03001234567"      → ["+923001234567"]          (national 0 + PK mobile)
 *   "501234567"        → ["+971501234567"]          (bare UAE national)
 */
export function toE164Candidates(raw: string | null | undefined): string[] {
  if (!raw) return [];
  const trimmed = raw.trim();
  const digits = digitsOf(trimmed);
  if (digits.length < MIN_DIGITS || digits.length > MAX_DIGITS) return [];

  const out: string[] = [];
  const add = (value: string) => {
    if (value.length <= MAX_DIGITS + 1 && !out.includes(value)) out.push(value);
  };

  // Explicitly international: the user told us the country, believe them.
  if (trimmed.startsWith('+')) {
    add(`+${digits}`);
    return out;
  }
  // "00" is the same statement written the old way.
  if (digits.startsWith('00')) {
    const rest = digits.slice(2);
    if (rest.length >= MIN_DIGITS) add(`+${rest}`);
    return out;
  }

  // National form: a single leading 0 is a trunk prefix, not part of the
  // number. Strip at most one — "00" was already handled above.
  const national = digits.startsWith('0') ? digits.slice(1) : digits;

  for (const country of SUPPORTED) {
    if (national.length !== country.nationalLength) continue;
    if (!national.startsWith(country.mobilePrefix)) continue;
    add(`+${country.calling}${national}`);
  }

  // Already carries a country code but no + (people paste "971501234567").
  for (const country of SUPPORTED) {
    if (!digits.startsWith(country.calling)) continue;
    const rest = digits.slice(country.calling.length);
    if (rest.length !== country.nationalLength) continue;
    add(`+${digits}`);
  }

  return out;
}

/** The single canonical form, or null when the input is ambiguous or
 *  unusable. Used where we must STORE one value (the user's own profile
 *  number) rather than probe several. */
export function toE164(raw: string | null | undefined): string | null {
  const candidates = toE164Candidates(raw);
  return candidates.length === 1 ? candidates[0] : null;
}

/** Pretty-print an E.164 number for confirmation UI: +971 501 234 567.
 *  Grouping is cosmetic — never feed this back into a lookup. */
export function formatE164(e164: string): string {
  if (!/^\+\d{7,15}$/.test(e164)) return e164;
  const digits = e164.slice(1);
  // Prefer a calling code we actually know; +92 must not be read as "923".
  const known = SUPPORTED.find((c) => digits.startsWith(c.calling));
  const calling = known ? known.calling : digits.slice(0, 3);
  const rest = digits.slice(calling.length);

  const groups: string[] = [];
  for (let i = 0; i < rest.length; i += 3) groups.push(rest.slice(i, i + 3));
  // A trailing single digit reads as a typo ("… 456 7"); fold it back.
  if (groups.length > 1 && groups[groups.length - 1].length === 1) {
    groups[groups.length - 2] += groups.pop();
  }
  return `+${calling} ${groups.join(' ')}`.trim();
}
