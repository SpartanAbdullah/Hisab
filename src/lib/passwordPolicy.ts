// Single source of truth for password policy.
//
// Rules (Phase H2 hardening — Android prod):
// 1. At least 12 characters.
// 2. Must contain at least one letter AND at least one digit.
//
// We deliberately do not enforce special-character complexity. The 12-char
// minimum is the stronger guard against brute-force; forcing symbols is
// well-documented to encourage weaker, more memorable passwords. This
// matches current NIST SP 800-63B guidance.

export const PASSWORD_MIN_LENGTH = 12;

export type PasswordValidationCode =
  | "ok"
  | "too_short"
  | "missing_complexity";

export interface PasswordValidationResult {
  code: PasswordValidationCode;
  // True if the password should be accepted.
  valid: boolean;
}

export function validatePassword(password: string): PasswordValidationResult {
  if (password.length < PASSWORD_MIN_LENGTH) {
    return { code: "too_short", valid: false };
  }
  const hasLetter = /[A-Za-z]/.test(password);
  const hasDigit = /\d/.test(password);
  if (!(hasLetter && hasDigit)) {
    return { code: "missing_complexity", valid: false };
  }
  return { code: "ok", valid: true };
}
