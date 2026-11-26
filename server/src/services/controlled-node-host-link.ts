/**
 * The link between a controlled node and the daemon on the same computer
 * (`servers.host_server_id` on the node's row). That daemon's remote-desktop
 * button opens the linked node, so a link may only ever join one owner's node
 * to the same owner's daemon.
 *
 * Shared by the owner's explicit choice (POST /api/machines/host-link) and the
 * node's own report of the daemons bound on its computer.
 */
import type { Database } from '../db/client.js';
import { NODE_ROLE } from '../../../shared/remote-exec.js';
import {
  CONTROLLED_NODE_HOST_AUTO_LINK_OUTCOME,
  type ControlledNodeHostAutoLinkOutcome,
} from '../../../shared/controlled-node-host-link.js';
import { logAudit } from '../security/audit.js';

export const MACHINE_HOST_LINK_AUDIT = {
  LINK: 'machine.host_link',
  UNLINK: 'machine.host_unlink',
} as const;

/** A live daemon of this user: never a controlled node, never someone else's. */
export async function isOwnedHostDaemon(db: Database, userId: string, hostServerId: string): Promise<boolean> {
  const host = await db.queryOne<{ id: string }>(
    `SELECT id FROM servers
      WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL AND node_role IS DISTINCT FROM $3`,
    [hostServerId, userId, NODE_ROLE.CONTROLLED],
  );
  return host !== null;
}

/**
 * Two endpoints that already carry different canonical desktop identities
 * would become a pending merge conflict (which closes guest admission) the
 * next time either is resolved. A link must never create one.
 */
export async function hostIdentitiesConflict(
  db: Database,
  nodeServerId: string,
  hostServerId: string,
): Promise<boolean> {
  const hosts = await db.queryOne<{ node_host: string | null; daemon_host: string | null }>(
    `SELECT (SELECT host_id FROM remote_desktop_host_endpoints WHERE server_id = $1) AS node_host,
            (SELECT host_id FROM remote_desktop_host_endpoints WHERE server_id = $2) AS daemon_host`,
    [nodeServerId, hostServerId],
  );
  return Boolean(hosts?.node_host && hosts.daemon_host && hosts.node_host !== hosts.daemon_host);
}

/**
 * Point the node at `hostServerId`, or clear it with `null`. One computer, one
 * node: linking replaces whichever other node of this user pointed there.
 */
export async function setControlledNodeHost(db: Database, input: {
  userId: string;
  nodeServerId: string;
  hostServerId: string | null;
}): Promise<void> {
  const { userId, nodeServerId, hostServerId } = input;
  await db.transaction(async (tx) => {
    if (hostServerId !== null) {
      await tx.execute(
        `UPDATE servers SET host_server_id = NULL
          WHERE host_server_id = $1 AND user_id = $2 AND node_role = $3 AND id <> $4`,
        [hostServerId, userId, NODE_ROLE.CONTROLLED, nodeServerId],
      );
    }
    await tx.execute(
      'UPDATE servers SET host_server_id = $2 WHERE id = $1 AND user_id = $3',
      [nodeServerId, hostServerId, userId],
    );
  });
}

/**
 * Act on a node's report of the daemons bound on its computer.
 *
 * Deliberately conservative, because an explicit choice always beats a guess:
 * a node already pointing at a live daemon of its owner is left alone, and
 * nothing is linked unless exactly one reported daemon is the owner's, no
 * other node already claims it, and their host identities agree. Everything
 * else is left for the owner to pick in the daemon's remote-desktop setup.
 */
export async function autoLinkControlledNodeHost(db: Database, input: {
  nodeServerId: string;
  reportedServerIds: readonly string[];
}): Promise<ControlledNodeHostAutoLinkOutcome> {
  const { nodeServerId, reportedServerIds } = input;
  const node = await db.queryOne<{ user_id: string; host_server_id: string | null }>(
    `SELECT user_id, host_server_id FROM servers
      WHERE id = $1 AND node_role = $2 AND revoked_at IS NULL`,
    [nodeServerId, NODE_ROLE.CONTROLLED],
  );
  if (!node) return CONTROLLED_NODE_HOST_AUTO_LINK_OUTCOME.NOT_FOUND;
  if (node.host_server_id && await isOwnedHostDaemon(db, node.user_id, node.host_server_id)) {
    return CONTROLLED_NODE_HOST_AUTO_LINK_OUTCOME.KEPT;
  }

  const owned = await db.query<{ id: string }>(
    `SELECT id FROM servers
      WHERE id = ANY($1::text[]) AND user_id = $2 AND revoked_at IS NULL AND node_role IS DISTINCT FROM $3`,
    [[...reportedServerIds], node.user_id, NODE_ROLE.CONTROLLED],
  );
  if (owned.length === 0) return CONTROLLED_NODE_HOST_AUTO_LINK_OUTCOME.NONE;
  if (owned.length > 1) return CONTROLLED_NODE_HOST_AUTO_LINK_OUTCOME.AMBIGUOUS;
  const hostServerId = owned[0]!.id;

  const claimed = await db.queryOne<{ id: string }>(
    `SELECT id FROM servers
      WHERE host_server_id = $1 AND user_id = $2 AND node_role = $3 AND revoked_at IS NULL AND id <> $4`,
    [hostServerId, node.user_id, NODE_ROLE.CONTROLLED, nodeServerId],
  );
  if (claimed) return CONTROLLED_NODE_HOST_AUTO_LINK_OUTCOME.TAKEN;
  if (await hostIdentitiesConflict(db, nodeServerId, hostServerId)) {
    return CONTROLLED_NODE_HOST_AUTO_LINK_OUTCOME.CONFLICT;
  }

  // Conditional on the link still being what was read above, so an owner's
  // choice made in the meantime is never overwritten by this guess.
  const updated = await db.queryOne<{ id: string }>(
    `UPDATE servers SET host_server_id = $2
      WHERE id = $1 AND host_server_id IS NOT DISTINCT FROM $3
      RETURNING id`,
    [nodeServerId, hostServerId, node.host_server_id],
  );
  if (!updated) return CONTROLLED_NODE_HOST_AUTO_LINK_OUTCOME.KEPT;
  await logAudit({
    userId: node.user_id,
    action: MACHINE_HOST_LINK_AUDIT.LINK,
    ip: 'controlled-node',
    details: {
      serverId: nodeServerId,
      hostServerId,
      previousHostServerId: node.host_server_id,
      automatic: true,
    },
  }, db).catch(() => {});
  return CONTROLLED_NODE_HOST_AUTO_LINK_OUTCOME.LINKED;
}
