export const IMCODES_POD_HEADER = 'x-imcodes-pod';
export const CLIENT_TIMEZONE_HEADER = 'x-client-timezone';
export const DEVICE_TIMEZONE_HEADER = 'x-device-timezone';
export const ACCEPT_ENCODING_HEADER = 'Accept-Encoding';
export const AUTHORIZATION_HEADER = 'Authorization';
/** Names the server a daemon credential belongs to; with `Authorization: Bearer <server token>` it is the daemon's identity. */
export const SERVER_ID_HEADER = 'X-Server-Id';
export const CONTENT_ENCODING_HEADER = 'Content-Encoding';

/**
 * Browser-side identity snapshot. The server compares this with the credential
 * that actually authenticated the request so a cookie replaced by another tab
 * cannot silently execute an owner-scoped action under a different account.
 */
export const EXPECTED_USER_ID_HEADER = 'x-imcodes-expected-user-id';
