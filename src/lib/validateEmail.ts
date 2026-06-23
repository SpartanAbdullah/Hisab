// Lightweight email-format check for the signup affirmation tick. Not meant to
// be RFC-exhaustive — just "looks like an email" (something@something.tld) so we
// can show a green check the moment the format is plausible. The real check is
// the confirmation email that has to be clicked.
export function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
}
