// Auth error `code` values shared between the server's password auth/refresh
// routes and the web login page's error-message mapping. Keep both sides
// importing these instead of duplicating the string literals.
export const AUTH_ERROR_CODES = {
  TOO_MANY_ATTEMPTS: 'too_many_attempts',
  INVALID_CREDENTIALS: 'invalid_credentials',
  ACCOUNT_PENDING: 'account_pending',
  ACCOUNT_DISABLED: 'account_disabled',
  REGISTRATION_DISABLED: 'registration_disabled',
  INVALID_USERNAME_FORMAT: 'invalid_username_format',
  USERNAME_TAKEN: 'username_taken',
  INVALID_BODY: 'invalid_body',
} as const;

export type AuthErrorCode = (typeof AUTH_ERROR_CODES)[keyof typeof AUTH_ERROR_CODES];
