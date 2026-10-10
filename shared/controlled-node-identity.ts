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

/**
 * The field of a controlled node's `heartbeat_ack` that carries the node's own public ID. A credential written before the public ID
 * existed has none, and a node cannot work its ID out for itself; the server (which backfilled it) tells the node on every ack, and
 * the node adopts it once. Peers that do not know the field ignore it.
 */
export const CONTROLLED_NODE_ACK_NODE_ID_FIELD = 'nodeId' as const;
/** The internal server ID the ack is for: the node adopts a public ID only when this is its own. */
export const CONTROLLED_NODE_ACK_SERVER_ID_FIELD = 'serverId' as const;

export function parseControlledNodeId(value: unknown): ControlledNodeId | null {
  return isControlledNodeId(value) ? value : null;
}

