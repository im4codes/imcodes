/**
 * Shared password complexity rules — used by both server and web.
 *
 * Requirements:
 *   - At least 8 characters
 *   - At least one uppercase letter
 *   - At least one lowercase letter
 *   - At least one digit
 */

export interface PasswordValidationResult {
  valid: boolean;
  /** Error key for i18n (e.g. 'password_too_short', 'password_missing_uppercase') */
  errorKey: string | null;
}

export function validatePasswordComplexity(password: string): PasswordValidationResult {
  if (password.length < 8) {
    return { valid: false, errorKey: 'password_too_short' };
  }
  if (!/[A-Z]/.test(password)) {
    return { valid: false, errorKey: 'password_missing_uppercase' };
  }
  if (!/[a-z]/.test(password)) {
    return { valid: false, errorKey: 'password_missing_lowercase' };
  }
  if (!/[0-9]/.test(password)) {
    return { valid: false, errorKey: 'password_missing_digit' };
  }
  return { valid: true, errorKey: null };
}

/** Username format: 3-32 chars, starts/ends with alphanumeric, allows . _ - in middle */
export const USERNAME_REGEX = /^[a-z0-9](?:[a-z0-9._-]{1,30}[a-z0-9])?$/;
