/**
 * Which canonical server URLs the product accepts.
 *
 * Plain HTTP is allowed only for loopback, so a development machine works while
 * a deployment cannot quietly serve enrolment over cleartext.
 *
 * This lives on its own because two very different callers need the same
 * answer: the enrolment routes, which decide whether a request has a usable
 * canonical origin, and the install-command renderer, which interpolates that
 * origin into a script executed as root. A second copy of this rule that drifted
 * would either break development or widen what can be pasted into a shell.
 */
export function isAllowedServerUrl(value: string): boolean {
  if (/^https:\/\//.test(value)) return true;
  if (/^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?\/?$/.test(value)) return true;
  return false;
}

/**
 * True when the value is exactly an origin — scheme, host and optional port,
 * with no path, query, fragment or credentials.
 *
 * Origins cannot contain whitespace, quotes or shell metacharacters, because
 * `URL` rejects them in a hostname. That is what makes interpolating this value
 * into a shell or PowerShell script safe, so it is asserted rather than assumed.
 */
export function isCanonicalServerOrigin(value: string): boolean {
  if (!isAllowedServerUrl(value)) return false;
  try {
    return new URL(value).origin === value;
  } catch {
    return false;
  }
}
