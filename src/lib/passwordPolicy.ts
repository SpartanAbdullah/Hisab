// Single source of truth for password policy.
//
// Rules:
// 1. At least 8 characters.
// 2. Must contain at least one letter AND at least one digit.
//
// 8 is the signup-friction sweet spot — still solidly secure given Supabase
// hashes + rate-limits auth, but far less of a wall at the moment of signup.
// We deliberately do not enforce special-character complexity; forcing symbols
// is well-documented to encourage weaker, more memorable passwords (NIST
// SP 800-63B).

export const PASSWORD_MIN_LENGTH = 8;

export type PasswordValidationCode =
  | "ok"
  | "too_short"
  | "missing_complexity";

export interface PasswordValidationResult {
  code: PasswordValidationCode;
  // True if the password should be accepted.
  valid: boolean;
}

// Per-condition results for a live signup checklist (each turns green as met).
export interface PasswordChecks {
  length: boolean;
  letter: boolean;
  number: boolean;
}

export function passwordChecks(password: string): PasswordChecks {
  return {
    length: password.length >= PASSWORD_MIN_LENGTH,
    letter: /[A-Za-z]/.test(password),
    number: /\d/.test(password),
  };
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
