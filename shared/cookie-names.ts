/** Cookie name constants — shared between server and web client. */

/** HttpOnly session cookie (JWT access token). */
export const COOKIE_SESSION = 'rcc_session';

/** Non-HttpOnly CSRF cookie (double-submit token). */
export const COOKIE_CSRF = 'rcc_csrf';

/** CSRF header name sent by the client. */
export const HEADER_CSRF = 'X-CSRF-Token';
