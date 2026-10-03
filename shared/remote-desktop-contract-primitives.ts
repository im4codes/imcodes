/**
 * Shared strict-validation primitives for every remote-desktop contract module.
 *
 * These predicates are deliberately dependency-free so any contract module can
 * import them without creating a cycle back through the message schemas that
 * use them. Keeping one copy matters: a second, subtly different `hasExactKeys`
 * would let unknown keys through on one wire while rejecting them on another,
 * and an inconsistent byte bound would accept a body on the browser edge that
 * the Server later refuses.
 */

/** Opaque identifiers on every remote-desktop wire share one shape. */
export const REMOTE_DESKTOP_ID_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;

export function isRemoteDesktopRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Exact-key check. Unknown keys are rejected rather than ignored so a caller
 * cannot smuggle an extra field past a validator and have a later consumer
 * read it.
 */
export function hasExactRemoteDesktopKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.prototype.hasOwnProperty.call(value, key))
    && Object.keys(value).every((key) => allowed.has(key));
}

export function remoteDesktopUtf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

/** Bounds are UTF-8 bytes, not UTF-16 code units, so CJK cannot exceed a cap. */
export function isBoundedRemoteDesktopString(value: unknown, maxBytes: number): value is string {
  return typeof value === 'string' && value.length > 0 && remoteDesktopUtf8Bytes(value) <= maxBytes;
}

export function isSafeNonNegativeRemoteDesktopInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

export function isRemoteDesktopId(value: unknown): value is string {
  return typeof value === 'string' && REMOTE_DESKTOP_ID_PATTERN.test(value);
}
