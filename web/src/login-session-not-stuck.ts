// sessionStorage key LoginPage sets right before a successful login's own
// reload; app.tsx consumes it if mount verification then finds the session
// didn't stick. Shared between the two files so the literal isn't repeated.
export const LOGIN_SESSION_NOT_STUCK_KEY = 'rcc_login_session_not_stuck';
