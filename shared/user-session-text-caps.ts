/**
 * Hard limits on user-authored free-text fields that get re-injected into
 * every provider turn (description, systemPrompt). Each turn pays the cost
 * of these strings, so without a cap a single oversized paste from the
 * user inflates every subsequent message indefinitely.
 *
 * 300 chars is enough for a focused role/intent statement
 * ("You are a senior TypeScript reviewer..." style) while preventing
 * accidental novel-length pastes from blowing up context. UI surfaces
 * should warn the user but the daemon truncates as a defense in depth so
 * a misbehaving client can't bypass the cap.
 *
 * The cap is shared so daemon, server, and web all enforce the same
 * boundary and a value that round-trips through any of them is stable.
 */
export const USER_SESSION_TEXT_MAX_CHARS = 300;

/**
 * Truncate a user-set text field to `USER_SESSION_TEXT_MAX_CHARS`,
 * preserving leading/trailing whitespace handling done by callers and
 * returning `undefined` for empty / null / whitespace-only input so the
 * downstream payload omits the field entirely instead of carrying an
 * empty string.
 */
export function clampUserSessionText(value: string | null | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.length > USER_SESSION_TEXT_MAX_CHARS
    ? trimmed.slice(0, USER_SESSION_TEXT_MAX_CHARS)
    : trimmed;
}
