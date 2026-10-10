import type { Database } from '../db/client.js';
import { activeUserExistsSql } from '../security/user-status.js';
import {
  NODE_ROLE,
  type MachineAccessRole,
} from '../../../shared/remote-exec.js';
import type { ControlledNodeCapability } from '../../../shared/controlled-node-capabilities.js';
import type { MachineAccessSource } from '../../../shared/machine-access-policy.js';

export interface ControlledMachineAccessRow {
  id: string;
  node_id: string | null;
  user_id: string;
  ref_name: string | null;
  display_name: string | null;
  status: string | null;
  last_heartbeat_at: number | null;
  exec_enabled: boolean;
  os: string | null;
  daemon_version: string | null;
  auto_unlock_configured: boolean;
  revoked_at: number | null;
  access_role: MachineAccessRole;
  access_expires_at: number | null;
  /** Where the access comes from. An EXECUTE grant only counts when this is `share` (shared/machine-access-policy.ts). */
  access_source: MachineAccessSource | null;
  /** The explicit per-device share row's execute grant; false for the owner row, a group member and every pre-grant share. */
  exec_granted: boolean;
  controlled_capabilities: ControlledNodeCapability[] | null;
  controlled_upgrade_status: string | null;
  controlled_upgrade_target_version: string | null;
  controlled_upgrade_reason: string | null;
  controlled_worker_refresh_attempt_id: string | null;
  controlled_worker_refresh_phase: string | null;
  controlled_worker_refresh_installed_version: string | null;
  controlled_worker_refresh_target_version: string | null;
  controlled_worker_refresh_artifact_sha256: string | null;
  controlled_worker_refresh_reason: string | null;
  controlled_worker_refresh_recorded_at: number | null;
  /** `controlled` for a controlled node; `full`/NULL for a normal daemon. */
  node_role: string | null;
  /** The daemon this node was enrolled from, when it shares that machine. */
  host_server_id: string | null;
  /** Canonical physical-host identity for remote-desktop presentation/management. */
  remote_desktop_host_id: string | null;
  /** Every group this machine is in, as parallel id/name arrays. */
  team_ids: string[] | null;
  team_names: string[] | null;
}

export type ControlledMachineOperatorAccessRow = ControlledMachineAccessRow & {
  access_role: Extract<MachineAccessRole, 'owner' | 'participant'>;
};

/**
 * Is this caller a member of any group this machine is in?
 *
 * EXISTS rather than a join: a machine can be in several groups, and joining
 * would return it once per matching membership -- a list that repeats a machine
 * is not a machine list, and the GROUP BY needed to undo that is one more place
 * to get wrong.
 */
export const IS_MEMBER_OF_A_MACHINE_GROUP = `EXISTS (
           SELECT 1 FROM machine_groups mg
             JOIN team_members tm ON tm.team_id = mg.team_id
            WHERE mg.server_id = s.id
              AND tm.user_id = $1
         )`;

const CAN_MANAGE_A_MACHINE_GROUP = `EXISTS (
           SELECT 1 FROM machine_groups mg
             JOIN team_members tm ON tm.team_id = mg.team_id
            WHERE mg.server_id = s.id
              AND tm.user_id = $2
              AND tm.role IN ('owner', 'admin')
         )`;

/**
 * Both the person asking (`$1`) and the machine's owner must be active accounts (security/user-status.ts). A disabled user operates
 * nothing, and a machine whose owner is disabled is out of service for everyone it was shared with.
 */
const ACTIVE_ACCOUNTS_ACCESS_PREDICATE = `${activeUserExistsSql('$1')} AND ${activeUserExistsSql('s.user_id')}`;

const CONTROLLED_MACHINE_ACCESS_SELECT = `
  SELECT s.id, s.user_id, s.node_id, s.ref_name, s.display_name, s.status, s.node_role, s.host_server_id,
         s.last_heartbeat_at, s.exec_enabled, s.os, s.daemon_version, s.revoked_at,
         s.auto_unlock_configured, s.controlled_capabilities,
         s.controlled_upgrade_status, s.controlled_upgrade_target_version, s.controlled_upgrade_reason,
         s.controlled_worker_refresh_attempt_id, s.controlled_worker_refresh_phase,
         s.controlled_worker_refresh_installed_version, s.controlled_worker_refresh_target_version,
         s.controlled_worker_refresh_artifact_sha256, s.controlled_worker_refresh_reason,
         s.controlled_worker_refresh_recorded_at,
         rdhe.host_id AS remote_desktop_host_id,
         (
           SELECT COALESCE(array_agg(g.team_id ORDER BY gt.name), '{}')
             FROM machine_groups g JOIN teams gt ON gt.id = g.team_id
            WHERE g.server_id = s.id
         ) AS team_ids,
         (
           SELECT COALESCE(array_agg(gt.name ORDER BY gt.name), '{}')
             FROM machine_groups g JOIN teams gt ON gt.id = g.team_id
            WHERE g.server_id = s.id
         ) AS team_names,
         CASE
           WHEN s.user_id = $1 THEN 'owner'
           -- An explicit per-machine grant wins over the team default, in both
           -- directions. It is the more specific statement of intent, so a
           -- deliberate downgrade to viewer is not silently undone by the
           -- grantee also being in the team.
           WHEN sh.role IS NOT NULL THEN sh.role
           WHEN ${IS_MEMBER_OF_A_MACHINE_GROUP} THEN 'participant'
         END AS access_role,
         CASE
           WHEN s.user_id = $1 THEN 'owner'
           WHEN sh.role IS NOT NULL THEN 'share'
           WHEN ${IS_MEMBER_OF_A_MACHINE_GROUP} THEN 'group'
         END AS access_source,
         -- Only the explicit per-device row can carry an execute grant, and only a participant row (CHECK in migration 100). A group
         -- membership has no row, so it can never grant it; a missing column reads false.
         COALESCE(sh.exec_granted, FALSE) AS exec_granted,
         sh.expires_at AS access_expires_at
    FROM servers s
    LEFT JOIN remote_desktop_host_endpoints rdhe
      ON rdhe.server_id = s.id
    -- Direct node shares stand independently of group metadata and are re-read live.
    LEFT JOIN server_shares sh
      ON sh.server_id = s.id
     AND s.user_id <> $1
     AND sh.target_user_id = $1
     AND sh.revoked_at IS NULL
     AND (sh.expires_at IS NULL OR sh.expires_at > $2)
    -- Group rows are retained here only for metadata-management authority.
    -- Operational/list/desktop callers require ownership or an explicit share.
`;

/**
 * Resolve current DB-authoritative access to one controlled node.
 *
 * A grant is deliberately read at action admission rather than cached: expiry,
 * revocation, downgrade, target revocation and role replacement all take effect
 * on the next request. The controlled node's own credential is never involved.
 */
export async function resolveControlledMachineAccess(
  db: Database,
  userId: string,
  serverId: string,
  now: number,
): Promise<ControlledMachineAccessRow | null> {
  return db.queryOne<ControlledMachineAccessRow>(
    `${CONTROLLED_MACHINE_ACCESS_SELECT}
      WHERE s.id = $3
        AND s.node_role = $4
        AND s.revoked_at IS NULL
        AND ${ACTIVE_ACCOUNTS_ACCESS_PREDICATE}
        AND (s.user_id = $1 OR sh.id IS NOT NULL OR ${IS_MEMBER_OF_A_MACHINE_GROUP})
      LIMIT 1`,
    [userId, now, serverId, NODE_ROLE.CONTROLLED],
  );
}

/**
 * The single operational authority boundary for a controlled device.
 *
 * Every device capability must enter through this helper rather than spelling
 * an owner-only predicate in its own route.  The share row is read on every
 * action, so revocation, expiry, and a Participant -> Viewer downgrade take
 * effect without copying an owner credential into the participant's daemon.
 * Sharing-management routes deliberately do not use this helper: they remain
 * owner-only.
 */
export async function resolveControlledMachineOperatorAccess(
  db: Database,
  userId: string,
  serverId: string,
  now: number,
): Promise<ControlledMachineOperatorAccessRow | null> {
  const access = await resolveControlledMachineAccess(db, userId, serverId, now);
  return access && access.access_source !== 'group' && canOperateControlledMachine(access.access_role)
    ? access as ControlledMachineOperatorAccessRow
    : null;
}

/** A participant-origin tool must hold a live direct node share; ownership/group rows are not delegated grants. */
export async function resolveControlledMachineParticipantShareAccess(
  db: Database, userId: string, serverId: string, now: number,
): Promise<ControlledMachineOperatorAccessRow | null> {
  const access = await resolveControlledMachineOperatorAccess(db, userId, serverId, now);
  return access?.access_source === 'share' ? access : null;
}

/** The same live owner/direct-Participant read boundary, batched once per metadata packet (never a group/execute grant). */
export async function resolveControlledMachineReadActors(
  db: Database, serverId: string, actors: string[], now: number,
): Promise<Set<string>> {
  if (!actors.length) return new Set();
  const rows = await db.query<{ actor_id: string }>(
    `SELECT DISTINCT actor.id AS actor_id
       FROM servers s
       JOIN users actor ON actor.id = ANY($2::text[])
       LEFT JOIN server_shares sh ON sh.server_id = s.id AND sh.target_user_id = actor.id
        AND sh.role = 'participant' AND sh.revoked_at IS NULL
        AND (sh.expires_at IS NULL OR sh.expires_at > $3)
      WHERE s.id = $1 AND s.node_role = $4 AND s.revoked_at IS NULL
        AND ${activeUserExistsSql('s.user_id')} AND ${activeUserExistsSql('actor.id')}
        AND (s.user_id = actor.id OR sh.id IS NOT NULL)`,
    [serverId, actors, now, NODE_ROLE.CONTROLLED],
  );
  return new Set(rows.map((row) => row.actor_id));
}

/**
 * Management authority: who may change the device itself (not use it).
 *
 *   `owner` (default)  the device OWNER only. Everything that changes the device's security or availability -- revoke the node's
 *                      credential, switch SYSTEM exec on or off, force a node upgrade, install the remote-desktop worker, store the
 *                      sign-in (auto-unlock) secret, ask for screen-recording permission, read the exec audit, grant execute -- is
 *                      the owner's alone. A share participant (who may operate, and execute with the owner's grant) and a group member
 *                      or group admin (metadata management only) can NOT: they could otherwise re-enable exec the owner switched off, revoke the
 *                      credential and take the node offline, or push an upgrade.
 *   `rename`           the owner and a group owner/admin, for the display name only (a label, not a capability).
 *
 * There is deliberately no branch for an explicit share participant: "can operate" never meant "can manage".
 */
export type ControlledMachineManagementScope = 'owner' | 'rename';

export async function resolveControlledMachineManagementAccess(
  db: Database,
  userId: string,
  serverId: string,
  now: number,
  scope: ControlledMachineManagementScope = 'owner',
): Promise<ControlledMachineOperatorAccessRow | null> {
  const resolved = await resolveControlledMachineAccess(db, userId, serverId, now);
  const access = resolved && canOperateControlledMachine(resolved.access_role) ? resolved as ControlledMachineOperatorAccessRow : null;
  if (!access) return null;
  if (access.access_role === 'owner' && access.access_source === 'owner') return access;
  if (scope !== 'rename') return null;
  const manager = await db.queryOne<{ present: number }>(
    `SELECT 1 AS present FROM servers s
      WHERE s.id = $1
        AND ${CAN_MANAGE_A_MACHINE_GROUP}
      LIMIT 1`,
    [serverId, userId],
  );
  return manager ? access : null;
}

/**
 * Resolve current DB-authoritative access to a remote-desktop host, which may
 * be a controlled node OR a normal (FULL) daemon: on Windows a daemon serves
 * remote control with the same native worker. Node role is returned rather than
 * filtered so admission can apply the checks that belong to each role — the
 * grant read itself (ownership, share, expiry, revocation) is identical.
 */
export async function resolveRemoteDesktopHostAccess(
  db: Database,
  userId: string,
  serverId: string,
  now: number,
): Promise<ControlledMachineAccessRow | null> {
  return db.queryOne<ControlledMachineAccessRow>(
    `${CONTROLLED_MACHINE_ACCESS_SELECT}
      WHERE s.id = $3
        AND s.revoked_at IS NULL
        AND ${ACTIVE_ACCOUNTS_ACCESS_PREDICATE}
        AND (s.user_id = $1 OR sh.id IS NOT NULL OR (s.node_role IS DISTINCT FROM $4 AND ${IS_MEMBER_OF_A_MACHINE_GROUP}))
      LIMIT 1`,
    [userId, now, serverId, NODE_ROLE.CONTROLLED],
  );
}

/** Owner/active-Participant authority for the remote-control capability. */
export async function resolveRemoteDesktopHostOperatorAccess(
  db: Database,
  userId: string,
  serverId: string,
  now: number,
): Promise<ControlledMachineOperatorAccessRow | null> {
  const access = await resolveRemoteDesktopHostAccess(db, userId, serverId, now);
  return access && canOperateControlledMachine(access.access_role)
    ? access as ControlledMachineOperatorAccessRow
    : null;
}

/** One bounded query for owned + actively shared controlled-node discovery. */
export async function listAccessibleControlledMachines(
  db: Database,
  userId: string,
  now: number,
  limit: number,
): Promise<ControlledMachineAccessRow[]> {
  return db.query<ControlledMachineAccessRow>(
    `${CONTROLLED_MACHINE_ACCESS_SELECT}
      WHERE s.node_role = $3
        AND s.revoked_at IS NULL
        AND ${ACTIVE_ACCOUNTS_ACCESS_PREDICATE}
        AND (s.user_id = $1 OR sh.id IS NOT NULL)
      ORDER BY s.display_name NULLS LAST, s.id
      LIMIT $4`,
    [userId, now, NODE_ROLE.CONTROLLED, limit],
  );
}

/**
 * Live Desk authority for MANAGEMENT of a controlled node, as a SQL predicate.
 *
 * R5 audit P0: Desk membership was enforced only in the admission resolver, so
 * reads were fenced while every owner-management mutation still authorized on
 * `servers.user_id` alone. An owner removed from the Desk could therefore no
 * longer SEE the machine yet could still rename it, revoke it, toggle SYSTEM
 * exec, set the Windows auto-unlock secret, install the remote-desktop worker,
 * and grant/revoke other people's access. Hiding a machine from someone who can
 * still hand out control of it is the worst of both worlds.
 *
 * Returned as a predicate rather than a pre-flight check so it is evaluated
 * inside the same statement as the mutation: a separate SELECT would leave a
 * window where membership is dropped between the check and the write.
 *
 * `table` is the table or alias the predicate is applied to, and `userParam`
 * the placeholder holding the actor. Both are compile-time literals at every
 * call site; neither carries user input.
 *
 * The only exception is the legacy bootstrap: a machine with no Desk
 * (`team_id IS NULL`) is still managed by its owner alone, because otherwise
 * the explicit bind step could never be reached.
 */
export function controlledDeskManagementFence(table: string, userParam: string): string {
  return `(${table}.team_id IS NULL OR EXISTS (
    SELECT 1 FROM team_members tm
     WHERE tm.team_id = ${table}.team_id AND tm.user_id = ${userParam}
  ))`;
}

/**
 * Runtime form of the same rule, for callers that must decide before running a
 * statement (share management). Returns false for an unknown or revoked node.
 */
export async function holdsControlledDeskAuthority(
  db: Database,
  serverId: string,
  userId: string,
): Promise<boolean> {
  const row = await db.queryOne<{ present: number }>(
    `SELECT 1 AS present FROM servers s
      WHERE s.id = $1 AND s.revoked_at IS NULL
        AND ${controlledDeskManagementFence('s', '$2')}`,
    [serverId, userId],
  );
  return Boolean(row);
}

export function canOperateControlledMachine(
  accessRole: MachineAccessRole,
): accessRole is Extract<MachineAccessRole, 'owner' | 'participant'> {
  return accessRole === 'owner' || accessRole === 'participant';
}
