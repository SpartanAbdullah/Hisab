// Lightweight email-format check for the signup affirmation tick. Not meant to
// be RFC-exhaustive — just "looks like an email" (something@something.tld) so we
// can show a green check the moment the format is plausible. The real check is
// the confirmation email that has to be clicked.
export function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
}

// Common typos of popular email domains → the intended domain. Powers a
// "did you mean…" nudge so a mistyped address (gmial.com) doesn't send the
// user into verification limbo waiting for a mail that never arrives.
const DOMAIN_TYPOS: Record<string, string> = {
  'gmial.com': 'gmail.com', 'gmal.com': 'gmail.com', 'gmai.com': 'gmail.com',
  'gmaill.com': 'gmail.com', 'gamil.com': 'gmail.com', 'gnail.com': 'gmail.com',
  'gmail.co': 'gmail.com', 'gmail.con': 'gmail.com', 'gmail.cm': 'gmail.com',
  'hotmial.com': 'hotmail.com', 'hotmai.com': 'hotmail.com', 'hotmall.com': 'hotmail.com',
  'hotmail.co': 'hotmail.com', 'hotmail.con': 'hotmail.com',
  'yahooo.com': 'yahoo.com', 'yaho.com': 'yahoo.com', 'yahoo.co': 'yahoo.com',
  'outlok.com': 'outlook.com', 'outloo.com': 'outlook.com', 'outlook.co': 'outlook.com',
  'iclod.com': 'icloud.com', 'iclould.com': 'icloud.com', 'icloud.co': 'icloud.com',
};

// Returns the corrected email if the domain looks like a known typo, else null.
export function suggestEmailFix(email: string): string | null {
  const trimmed = email.trim();
  const at = trimmed.lastIndexOf('@');
  if (at < 1) return null;
  const domain = trimmed.slice(at + 1).toLowerCase();
  const fixed = DOMAIN_TYPOS[domain];
  if (!fixed || fixed === domain) return null;
  return trimmed.slice(0, at + 1) + fixed;
}
