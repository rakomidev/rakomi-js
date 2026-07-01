/**
 * Password strength indicator — shared between SignUp and UserProfile.
 * Simple heuristic (NO zxcvbn — 800KB+ bundle).
 */

import { PASSWORD_MIN_LENGTH } from '../_inlined-symbols.js';

export type PasswordStrength = 'weak' | 'fair' | 'strong' | 'very_strong';

const HAS_LOWER = /[a-z]/;
const HAS_UPPER = /[A-Z]/;
const HAS_DIGIT = /\d/;
const HAS_SYMBOL = /[^a-zA-Z0-9]/;

export function getPasswordStrength(password: string): PasswordStrength {
  if (password.length < PASSWORD_MIN_LENGTH) return 'weak';

  const hasLower = HAS_LOWER.test(password);
  const hasUpper = HAS_UPPER.test(password);
  const hasDigit = HAS_DIGIT.test(password);
  const hasSymbol = HAS_SYMBOL.test(password);

  if (password.length >= PASSWORD_MIN_LENGTH && hasLower && hasUpper && hasDigit && hasSymbol) {
    return 'very_strong';
  }

  if (password.length >= 10 && hasLower && hasUpper && hasDigit) {
    return 'strong';
  }

  if ((hasLower && hasUpper) || (hasLower && hasDigit) || (hasUpper && hasDigit)) {
    return 'fair';
  }

  return 'weak';
}
