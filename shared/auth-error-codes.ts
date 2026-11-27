// Auth error `code` values shared between the server's password auth/refresh
// routes and the web login page's error-message mapping. Keep both sides
// importing these instead of duplicating the string literals.
export const AUTH_ERROR_CODES = {
  TOO_MANY_ATTEMPTS: 'too_many_attempts',
  INVALID_CREDENTIALS: 'invalid_credentials',
  INVALID_OLD_PASSWORD: 'invalid_old_password',
  ACCOUNT_PENDING: 'account_pending',
  ACCOUNT_DISABLED: 'account_disabled',
  REGISTRATION_DISABLED: 'registration_disabled',
  INVALID_USERNAME_FORMAT: 'invalid_username_format',
  USERNAME_TAKEN: 'username_taken',
  INVALID_BODY: 'invalid_body',
  EMAIL_AUTH_DISABLED: 'email_auth_disabled',
  INVALID_EMAIL: 'invalid_email',
  EMAIL_TAKEN: 'email_taken',
  EMAIL_REQUIRED: 'email_required',
  EMAIL_CODE_REQUIRED: 'email_code_required',
  EMAIL_CODE_INVALID: 'email_code_invalid',
  EMAIL_CODE_EXPIRED: 'email_code_expired',
  EMAIL_CODE_RATE_LIMITED: 'email_code_rate_limited',
  EMAIL_NOT_VERIFIED: 'email_not_verified',
  EMAIL_ALREADY_VERIFIED: 'email_already_verified',
} as const;

export type AuthErrorCode = (typeof AUTH_ERROR_CODES)[keyof typeof AUTH_ERROR_CODES];
