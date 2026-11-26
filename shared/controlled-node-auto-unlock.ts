/**
 * Auto unlock: a controlled node may keep a Windows sign-in secret so it can
 * answer its own lock screen while an authorized controller is watching.
 *
 * The secret is write-only end to end. The browser sends it once, the Server
 * relays it without storing it, and the node encrypts it machine-scoped through
 * DPAPI into a LOCAL_SYSTEM-only file. Nothing reads it back: the Server keeps
 * a boolean, the node reports a boolean, and the worker decrypts it only to
 * type it at the sign-in desktop.
 *
 * Enabling it is a deliberate trade: with a stored secret, anyone who may start
 * a remote-desktop session on that node reaches the signed-in desktop, so the
 * lock screen stops being a second gate for remote viewers.
 */

/** Node capability: this node can store and use a sign-in secret. */
export const CONTROLLED_NODE_AUTO_UNLOCK_CAPABILITY = 'remote.desktop.auto_unlock.v1' as const;

export const CONTROLLED_NODE_AUTO_UNLOCK_LIMITS = {
  /** Windows caps interactive passwords well below this; the bound is a guard. */
  MAX_SECRET_LENGTH: 256,
  MAX_REQUEST_ID_LENGTH: 128,
} as const;

export const CONTROLLED_NODE_AUTO_UNLOCK_ACTION = {
  SET: 'set',
  CLEAR: 'clear',
} as const;

export type ControlledNodeAutoUnlockAction =
  typeof CONTROLLED_NODE_AUTO_UNLOCK_ACTION[keyof typeof CONTROLLED_NODE_AUTO_UNLOCK_ACTION];

export const CONTROLLED_NODE_AUTO_UNLOCK_ERROR = {
  UNSUPPORTED_PLATFORM: 'unsupported_platform',
  STORE_FAILED: 'store_failed',
  INVALID_REQUEST: 'invalid_request',
} as const;

export type ControlledNodeAutoUnlockError =
  typeof CONTROLLED_NODE_AUTO_UNLOCK_ERROR[keyof typeof CONTROLLED_NODE_AUTO_UNLOCK_ERROR];

/** Server → controlled node. `secret` is present only for `set`. */
export interface ControlledNodeAutoUnlockCommand {
  type: string;
  requestId: string;
  action: ControlledNodeAutoUnlockAction;
  secret?: string;
}

/** Controlled node → Server. Carries state, never the secret. */
export interface ControlledNodeAutoUnlockResult {
  type: string;
  requestId: string;
  ok: boolean;
  configured: boolean;
  error?: ControlledNodeAutoUnlockError;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.prototype.hasOwnProperty.call(value, key))
    && Object.keys(value).every((key) => allowed.has(key));
}

function isBoundedString(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max;
}

/**
 * Strict validation on the node side. A `set` must carry a secret and a `clear`
 * must not, so a malformed frame can never silently clear a working secret or
 * store an empty one.
 */
export function validateControlledNodeAutoUnlockCommand(
  value: unknown,
  expectedType: string,
): ControlledNodeAutoUnlockCommand | null {
  if (!isRecord(value)
    || value.type !== expectedType
    || !hasExactKeys(value, ['type', 'requestId', 'action'], ['secret'])
    || !isBoundedString(value.requestId, CONTROLLED_NODE_AUTO_UNLOCK_LIMITS.MAX_REQUEST_ID_LENGTH)) {
    return null;
  }
  if (value.action === CONTROLLED_NODE_AUTO_UNLOCK_ACTION.SET) {
    if (!isBoundedString(value.secret, CONTROLLED_NODE_AUTO_UNLOCK_LIMITS.MAX_SECRET_LENGTH)) {
      return null;
    }
    return {
      type: expectedType,
      requestId: value.requestId,
      action: CONTROLLED_NODE_AUTO_UNLOCK_ACTION.SET,
      secret: value.secret,
    };
  }
  if (value.action === CONTROLLED_NODE_AUTO_UNLOCK_ACTION.CLEAR && value.secret === undefined) {
    return {
      type: expectedType,
      requestId: value.requestId,
      action: CONTROLLED_NODE_AUTO_UNLOCK_ACTION.CLEAR,
    };
  }
  return null;
}

/** Strict validation on the Server side of the node's reply. */
export function validateControlledNodeAutoUnlockResult(
  value: unknown,
  expectedType: string,
): ControlledNodeAutoUnlockResult | null {
  if (!isRecord(value)
    || value.type !== expectedType
    || !hasExactKeys(value, ['type', 'requestId', 'ok', 'configured'], ['error'])
    || !isBoundedString(value.requestId, CONTROLLED_NODE_AUTO_UNLOCK_LIMITS.MAX_REQUEST_ID_LENGTH)
    || typeof value.ok !== 'boolean'
    || typeof value.configured !== 'boolean'
    || (value.error !== undefined
      && !(Object.values(CONTROLLED_NODE_AUTO_UNLOCK_ERROR) as string[]).includes(value.error as string))) {
    return null;
  }
  return {
    type: expectedType,
    requestId: value.requestId,
    ok: value.ok,
    configured: value.configured,
    ...(value.error === undefined ? {} : { error: value.error as ControlledNodeAutoUnlockError }),
  };
}
