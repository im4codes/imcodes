/** Canonical public identity for a controlled node. Internal serverId remains separate. */
export const CONTROLLED_NODE_ID_LENGTH = 10;
export const CONTROLLED_NODE_ID_PATTERN_SOURCE = '^[1-9][0-9]{9}$';
export const CONTROLLED_NODE_ID_PATTERN = new RegExp(CONTROLLED_NODE_ID_PATTERN_SOURCE);
export const CONTROLLED_NODE_ID_MIN = '1000000000';
export const CONTROLLED_NODE_ID_MAX = '9999999999';
export const CONTROLLED_NODE_ID_SPACE_SIZE = '9000000000';
export const CONTROLLED_NODE_ID_COLLISION_RETRY_LIMIT = 32;

declare const controlledNodeIdBrand: unique symbol;
export type ControlledNodeId = string & { readonly [controlledNodeIdBrand]: true };

export function isControlledNodeId(value: unknown): value is ControlledNodeId {
  return typeof value === 'string' && CONTROLLED_NODE_ID_PATTERN.test(value);
}

export function parseControlledNodeId(value: unknown): ControlledNodeId | null {
  return isControlledNodeId(value) ? value : null;
}

