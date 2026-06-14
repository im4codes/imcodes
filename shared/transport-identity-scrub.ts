// Transport-identity scrubbing for session-group / execution clones.
//
// When a session group (or a single execution clone) is duplicated, the cloned
// copies MUST NOT inherit runtime-bound transport identity fields (provider
// session ids, resume ids, conversation/thread ids, etc.) from the source.
// Carrying those over would make the clone hijack the source's live transport
// session. This module strips those fields out of an arbitrary transport-config
// record, recursively.
//
// IMPORTANT: shared/ is imported by BOTH the daemon and the server. It MUST NOT
// import from src/. Keep this module self-contained.

/**
 * Normalized identity-key denylist. Keys are compared after stripping `-`/`_`
 * and lowercasing (see {@link isCloneTransportIdentityKey}).
 */
export const CLONE_TRANSPORT_IDENTITY_KEY_NORMALIZED = new Set([
  'bindexistingkey',
  'ccsessionid',
  'codexsessionid',
  'conversationid',
  'geminisessionid',
  'opencodesessionid',
  'providersessionid',
  'providerresumeid',
  'resumeid',
  'sessionid',
  'sessionkey',
  'threadid',
]);

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Returns true when `key` names a runtime-bound transport identity field that
 * must be scrubbed from a clone. Matches the explicit normalized denylist plus
 * any key whose normalized form ends in `sessionid`/`sessionkey`/`resumeid`/
 * `threadid`.
 */
export function isCloneTransportIdentityKey(key: string): boolean {
  const normalized = key.replace(/[-_]/g, '').toLowerCase();
  return CLONE_TRANSPORT_IDENTITY_KEY_NORMALIZED.has(normalized)
    || normalized.endsWith('sessionid')
    || normalized.endsWith('sessionkey')
    || normalized.endsWith('resumeid')
    || normalized.endsWith('threadid');
}

/**
 * Recursively removes transport-identity keys from `value`. Arrays are mapped
 * element-wise; plain records are rebuilt without identity keys; any other
 * value (string/number/null/etc.) is returned as-is.
 */
export function scrubCloneTransportIdentity(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => scrubCloneTransportIdentity(item));
  }
  if (!isPlainRecord(value)) return value;

  const cleaned: Record<string, unknown> = {};
  for (const [key, nestedValue] of Object.entries(value)) {
    if (isCloneTransportIdentityKey(key)) continue;
    cleaned[key] = scrubCloneTransportIdentity(nestedValue);
  }
  return cleaned;
}

/**
 * Produces a clone-safe transport config: a deep copy of `config` with all
 * runtime identity keys removed, or `null` when `config` is not a plain record.
 */
export function cloneTransportConfigWithoutRuntimeIdentity(config: Record<string, unknown> | null | undefined): Record<string, unknown> | null {
  if (!isPlainRecord(config)) return null;
  const cleaned = scrubCloneTransportIdentity(config);
  return isPlainRecord(cleaned) ? cleaned : null;
}
