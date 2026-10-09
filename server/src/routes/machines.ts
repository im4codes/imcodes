import { Hono } from 'hono';
import { z } from 'zod';
import type { Env } from '../env.js';
import type { Database } from '../db/client.js';
import { requireAuth } from '../security/authorization.js';
import { logAudit } from '../security/audit.js';
import { WsBridge } from '../ws/bridge.js';
import { abandonAllForTarget } from '../ws/machine-exec-registry.js';
import { MACHINE_ACTION, evaluateMachineAction, type MachineAccessSource } from '../../../shared/machine-access-policy.js';
import { listMachineActionAudit } from '../security/machine-exec-audit.js';
import {
  NODE_ROLE,
  MACHINE_LIST_MAX_ITEMS,
  MACHINE_PRESENCE_STALENESS_MS,
  canonicalMachineOs,
  type MachineAccessRole,
  type MachineSummary,
  pickDaemonMachineListItem,
} from '../../../shared/remote-exec.js';
import {
  MACHINE_HOST_LINK_ERROR,
  MACHINE_HOST_LINK_ROUTE,
  MACHINE_REASONS,
  normalizeMachineDisplayName,
} from '../../../shared/machine-reference.js';
import {
  listAccessibleControlledMachines,
  resolveControlledMachineManagementAccess,
} from '../share/machine-access.js';
import { validateControlledNodeCapabilities } from '../../../shared/controlled-node-capabilities.js';
import {
  isImcodesVersionOutdated,
  parseImcodesVersion,
} from '../../../shared/imcodes-version.js';
import {
  REMOTE_DESKTOP_TERMINAL_REASON,
  REMOTE_DESKTOP_CAPABILITY,
} from '../../../shared/remote-desktop.js';
import { CONTROLLED_NODE_WORKER_REFRESH_CAPABILITY } from '../../../shared/controlled-node-worker-refresh.js';
import { randomUUID } from 'node:crypto';
import { DAEMON_COMMAND_TYPES } from '../../../shared/daemon-command-types.js';
import {
  CONTROLLED_NODE_AUTO_UNLOCK_ACTION,
  CONTROLLED_NODE_AUTO_UNLOCK_CAPABILITY,
  CONTROLLED_NODE_AUTO_UNLOCK_ERROR,
  CONTROLLED_NODE_AUTO_UNLOCK_LIMITS,
} from '../../../shared/controlled-node-auto-unlock.js';
import {
  cancelPendingAutoUnlock,
  registerPendingAutoUnlock,
} from '../ws/auto-unlock-registry.js';
import { REMOTE_DESKTOP_INSTALLABLE_CAPABILITY, REMOTE_DESKTOP_MACOS_INSTALLABLE_CAPABILITY } from '../../../shared/remote-desktop-install.js';
import { backfillCanonicalHosts } from '../services/remote-desktop-host-identity.js';
import {
  MACHINE_HOST_LINK_AUDIT,
  hostIdentitiesConflict,
  isOwnedHostDaemon,
  setControlledNodeHost,
} from '../services/controlled-node-host-link.js';
import { isControlledNodeId } from '../../../shared/controlled-node-identity.js';
import { SHARED_MACHINE_AUTHORITY_HEADER } from '../../../shared/shared-machine-authority.js';
import { listActorOperableMachineIds, resolveMachineOperationalUser } from '../share/shared-machine-authority.js';
import {
  CONTROLLED_NODE_UPGRADE_STATUS,
  DAEMON_UPGRADE_DELIVERY_STATUS,
  DAEMON_UPGRADE_SOURCE,
  type ControlledNodeUpgradeStatus,
} from '../../../shared/daemon-upgrade.js';
import {
  CONTROLLED_NODE_WORKER_REFRESH_PHASE,
  type ControlledNodeWorkerRefreshPhase,
} from '../../../shared/controlled-node-worker-refresh.js';

/** A node only has to reach its own disk, so this stays short. */
const AUTO_UNLOCK_TIMEOUT_MS = 15_000;

export const machinesRoutes = new Hono<{
  Bindings: Env;
  Variables: { userId: string; role: string; nodeRole?: string; authServerId?: string };
}>();

interface ControlledRow {
  id: string;
  node_id: string | null;
  team_ids: string[] | null;
  team_names: string[] | null;
  ref_name: string | null;
  display_name: string | null;
  status: string | null;
  last_heartbeat_at: number | null;
  exec_enabled: boolean;
  os: string | null;
  daemon_version: string | null;
  auto_unlock_configured: boolean;
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
  host_server_id: string | null;
  remote_desktop_host_id: string | null;
  access_role: MachineAccessRole;
  access_source: MachineAccessSource | null;
  exec_granted: boolean;
  controlled_capabilities: unknown;
}

/**
 * Shared access-scoped controlled-machine query + DTO mapping (F1: presence is
 * read from the DB `status`/`last_heartbeat_at`, NOT per-pod WsBridge). Both the
 * MCP `list_machines` tool and this HTTP route use this — they do not call each other.
 */
export async function listControlledMachines(
  db: Database,
  userId: string,
  nowMs: number,
  /** A shared-session participant driving the owner's agent: only machines they can operate themselves are listed. */
  delegatedActorUserId?: string,
): Promise<{ machines: (MachineSummary & {
  nodeId: string;
  refName: string;
  displayName: string;
  execEnabled: boolean;
  accessRole: MachineAccessRole;
  /** Browser-only (never sent to a daemon, see DAEMON_MACHINE_LIST_SENT_KEYS): may THIS actor run commands / move files on the device? */
  canExecute: boolean;
  execGranted: boolean;
  accessSource?: MachineAccessSource;
  remoteDesktopHostId?: string;
  // Declared because it is emitted. It was not, so the daemon-strip list below
  // could omit it without a type error -- and every strict daemon then rejected
  // the whole machine list as malformed.
  hostServerId?: string;
})[]; overLimit: boolean }> {
  let rows: ControlledRow[] = await listAccessibleControlledMachines(
    db,
    userId,
    nowMs,
    MACHINE_LIST_MAX_ITEMS + 1,
  );
  // The bound applies to the owner's fleet before any narrowing, so a participant never gets a silently truncated list.
  const overLimit = rows.length > MACHINE_LIST_MAX_ITEMS;
  if (delegatedActorUserId) {
    // The same rule as action admission (actorMayOperateMachine): the owner's
    // fleet intersected with what the participant is themselves allowed to operate.
    const actorOperable = await listActorOperableMachineIds(db, delegatedActorUserId, nowMs, MACHINE_LIST_MAX_ITEMS + 1);
    rows = rows.filter((row) => actorOperable.has(row.id));
  }
  const machines = rows.slice(0, MACHINE_LIST_MAX_ITEMS).map((r) => {
    if (!isControlledNodeId(r.node_id)) {
      throw new Error(`controlled_node_missing_canonical_node_id:${r.id}`);
    }
    const online = r.status === 'online'
      && typeof r.last_heartbeat_at === 'number'
      && nowMs - r.last_heartbeat_at < MACHINE_PRESENCE_STALENESS_MS;
    const capabilities = validateControlledNodeCapabilities(r.controlled_capabilities);
    // Only a parseable release is echoed back: the string arrives from the node
    // itself, so this keeps arbitrary reported text out of every consumer.
    const daemonVersion = typeof r.daemon_version === 'string'
      && parseImcodesVersion(r.daemon_version) !== null
      ? r.daemon_version.trim()
      : null;
    const bridge = WsBridge.find(r.id);
    const liveUpgrade = bridge?.getControlledNodeUpgradeStatus();
    const liveWorkerRefresh = bridge?.getControlledNodeWorkerRefreshStatus();
    const persistedWorkerRefreshPhase = r.controlled_worker_refresh_phase;
    const workerRefreshPhase = persistedWorkerRefreshPhase
      && Object.values(CONTROLLED_NODE_WORKER_REFRESH_PHASE).includes(
        persistedWorkerRefreshPhase as ControlledNodeWorkerRefreshPhase,
      )
      ? persistedWorkerRefreshPhase
      : null;
    const workerRefresh = liveWorkerRefresh ?? (r.controlled_worker_refresh_attempt_id
      && workerRefreshPhase
      && typeof r.controlled_worker_refresh_recorded_at === 'number'
      ? {
        type: 'controlled_node.worker_refresh_status' as const,
        attemptId: r.controlled_worker_refresh_attempt_id,
        phase: workerRefreshPhase,
        ...(r.controlled_worker_refresh_installed_version ? { installedVersion: r.controlled_worker_refresh_installed_version } : {}),
        ...(r.controlled_worker_refresh_target_version ? { targetVersion: r.controlled_worker_refresh_target_version } : {}),
        ...(r.controlled_worker_refresh_artifact_sha256 ? { artifactSha256: r.controlled_worker_refresh_artifact_sha256 } : {}),
        ...(r.controlled_worker_refresh_reason ? { reason: r.controlled_worker_refresh_reason } : {}),
        recordedAt: r.controlled_worker_refresh_recorded_at,
      }
      : undefined);
    const persistedUpgradeStatus = Object.values(CONTROLLED_NODE_UPGRADE_STATUS)
      .includes(r.controlled_upgrade_status as ControlledNodeUpgradeStatus)
      ? r.controlled_upgrade_status as ControlledNodeUpgradeStatus
      : null;
    const upgrade = persistedUpgradeStatus
      ? {
        status: persistedUpgradeStatus,
        ...(r.controlled_upgrade_target_version ? { targetVersion: r.controlled_upgrade_target_version } : {}),
        ...(r.controlled_upgrade_reason ? { reason: r.controlled_upgrade_reason } : {}),
      }
      : liveUpgrade;
    return {
      serverId: r.id,
      nodeId: r.node_id,
      name: r.display_name ?? r.node_id,
      refName: r.ref_name ?? '',
      displayName: r.display_name ?? r.node_id,
      online,
      nodeRole: NODE_ROLE.CONTROLLED,
      // Viewers may inspect bounded metadata only. Projecting false here also
      // keeps old MCP resolution logic from presenting a non-operable target.
      execEnabled: r.exec_enabled === true && r.access_role !== 'viewer',
      accessRole: r.access_role,
      // Operating is not executing: the browser is told whether THIS actor may run commands / move files on the device (an owner, or a
      // participant share with the owner's execute grant), where the access comes from, and whether a grant is held. A turn that was
      // started by a share participant never executes, whatever it holds.
      canExecute: evaluateMachineAction({
        accessRole: r.access_role,
        accessSource: r.access_source,
        execGranted: r.exec_granted === true,
        execEnabled: r.exec_enabled === true,
        participantTurn: Boolean(delegatedActorUserId),
      }, MACHINE_ACTION.EXEC).allowed,
      execGranted: r.exec_granted === true,
      ...(r.access_source ? { accessSource: r.access_source } : {}),
      ...(typeof r.remote_desktop_host_id === 'string' && r.remote_desktop_host_id
        ? { remoteDesktopHostId: r.remote_desktop_host_id }
        : {}),
      // Every group this machine is in, so the owner can see and change them
      // without a round trip per machine. Omitted when it is in none, so "no
      // groups" and "an empty group list" stay the same absent value.
      ...(Array.isArray(r.team_ids) && r.team_ids.length > 0
        ? {
          teamIds: r.team_ids,
          ...(Array.isArray(r.team_names) && r.team_names.length === r.team_ids.length
            ? { teamNames: r.team_names }
            : {}),
        }
        : {}),
      ...(capabilities.ok && capabilities.value.length > 0 ? { capabilities: capabilities.value } : {}),
      ...(canonicalMachineOs(r.os) ? { os: canonicalMachineOs(r.os) } : {}),
      ...(typeof r.last_heartbeat_at === 'number' ? { lastSeenMs: r.last_heartbeat_at } : {}),
      ...(daemonVersion ? { daemonVersion } : {}),
      // The comparison stays here: only the Server knows its release target,
      // and a browser must not have to guess what "current" means.
      ...(isImcodesVersionOutdated(daemonVersion, process.env.APP_VERSION)
        ? { updateAvailable: true }
        : {}),
      // Upgrade lifecycle is process-local to the authenticated WS bridge. It
      // is additive and bounded; absence means this API pod has not observed a
      // live socket yet, while the version mismatch remains authoritative.
      ...(upgrade ? {
        upgradeStatus: upgrade.status,
        ...(upgrade.targetVersion ? { upgradeTargetVersion: upgrade.targetVersion } : {}),
        ...(upgrade.reason ? { upgradeReason: upgrade.reason } : {}),
      } : {}),
      ...(workerRefresh ? { workerRefresh } : {}),
      // Presence of a stored sign-in secret, never the secret itself.
      ...(r.auto_unlock_configured === true ? { autoUnlockConfigured: true } : {}),
      // Same machine as that daemon: the browser keeps one remote-control entry
      // instead of two that would fight over one desktop.
      ...(typeof r.host_server_id === 'string' && r.host_server_id
        ? { hostServerId: r.host_server_id }
        : {}),
    };
  });
  return { machines, overLimit };
}

// GET /api/machines — owned + actively shared controlled machines with DB-backed presence.
machinesRoutes.get('/', requireAuth(), async (c) => {
  let userId = c.get('userId' as never) as string;
  let delegatedActorUserId: string | undefined;
  const now = Date.now();
  // Browser discovery is also the bounded, resumable provisioning seam for an
  // Owner whose remote-desktop node predates canonical host identity. This is
  // idempotent and owner-scoped; strict daemon clients neither need nor receive
  // the additive identity field.
  const authenticatedDaemon = c.get('nodeRole') === NODE_ROLE.FULL
    && typeof c.get('authServerId') === 'string';
  if (authenticatedDaemon) {
    const sourceServerId = c.get('authServerId') as string;
    const operational = await resolveMachineOperationalUser(c.env.DB, {
      token: c.req.header(SHARED_MACHINE_AUTHORITY_HEADER),
      signingKey: c.env.JWT_SIGNING_KEY,
      authenticatedSourceServerId: sourceServerId,
      sourceOwnerUserId: userId,
      now,
    });
    if (!operational) return c.json({ error: 'forbidden' }, 403);
    userId = operational.userId;
    delegatedActorUserId = operational.delegatedActorUserId;
  }
  if (!authenticatedDaemon) {
    await backfillCanonicalHosts({
      db: c.env.DB,
      ownerUserId: userId,
      limit: MACHINE_LIST_MAX_ITEMS,
      now,
    });
  }
  const { machines, overLimit } = await listControlledMachines(c.env.DB, userId, now, delegatedActorUserId);
  if (overLimit) {
    return c.json({ error: 'machine_list_over_limit', maxItems: MACHINE_LIST_MAX_ITEMS }, 413);
  }
  // Older daemons strictly reject unknown machine-list keys. Server-authenticated
  // callers do not need the display-only role because every action is admitted
  // again against the DB; preserve their legacy DTO during rolling upgrades.
  // A daemon (an agent's list_machines) is told `execEnabled` only for devices it can actually execute on, so an agent does not plan
  // commands the server will refuse; the browser keeps the raw switch and the separate `canExecute`.
  const responseMachines = authenticatedDaemon
    ? machines.map((machine) => pickDaemonMachineListItem({ ...machine, execEnabled: machine.execEnabled === true && machine.canExecute === true }))
    : machines;
  return c.json({ machines: responseMachines });
});

// POST /api/machines/:serverId/display-name — operator-controlled render name.
// A deprecated legacy `ref_name` remains immutable so historical markers stay valid.
machinesRoutes.post('/:serverId/display-name', requireAuth(), async (c) => {
  const userId = c.get('userId' as never) as string;
  const serverId = c.req.param('serverId') ?? '';
  if (!serverId) return c.json({ error: 'invalid_body' }, 400);
  const body = await c.req.json().catch(() => null);
  const parsed = z.object({ displayName: z.string() }).safeParse(body);
  if (!parsed.success) return c.json({ error: 'invalid_body' }, 400);
  const displayName = normalizeMachineDisplayName(parsed.data.displayName);
  if (!displayName) return c.json({ error: MACHINE_REASONS.INVALID_DISPLAY_NAME }, 400);
  // The label only: the owner and a group owner/admin (see ControlledMachineManagementScope).
  const access = await resolveControlledMachineManagementAccess(c.env.DB, userId, serverId, Date.now(), 'rename');
  if (!access) return c.json({ error: 'not_found' }, 404);

  const row = await c.env.DB.queryOne<{ previous_name: string | null }>(
    `UPDATE servers SET display_name = $2
       FROM (SELECT display_name AS previous_name FROM servers WHERE id = $1) prev
      WHERE servers.id = $1 AND servers.node_role = $3 AND servers.revoked_at IS NULL
      RETURNING prev.previous_name`,
    [serverId, displayName, NODE_ROLE.CONTROLLED],
  );
  if (!row) return c.json({ error: 'not_found' }, 404);
  const ip = (c.get('clientIp' as never) as string) ?? 'unknown';
  logAudit({
    userId,
    action: 'machine.rename',
    ip,
    details: { serverId, from: row.previous_name, to: displayName },
  }, c.env.DB).catch(() => {});
  return c.json({ ok: true, displayName });
});

// POST /api/machines/:serverId/upgrade — explicit retry for a controlled node.
// Automatic convergence is server-owned; this route is the bounded manual
// escape hatch after a terminal install failure or a deferred safety gate.
machinesRoutes.post('/:serverId/upgrade', requireAuth(), async (c) => {
  const userId = c.get('userId' as never) as string;
  const serverId = c.req.param('serverId') ?? '';
  if (!serverId) return c.json({ error: 'invalid_body' }, 400);
  const access = await resolveControlledMachineManagementAccess(c.env.DB, userId, serverId, Date.now());
  if (!access) return c.json({ error: 'not_found' }, 404);
  const row = await c.env.DB.queryOne<{ node_role: string; revoked_at: number | null }>(
    'SELECT node_role, revoked_at FROM servers WHERE id = $1',
    [serverId],
  );
  if (!row || row.revoked_at !== null || row.node_role !== NODE_ROLE.CONTROLLED) {
    return c.json({ error: 'not_found' }, 404);
  }
  const result = WsBridge.get(serverId).requestDaemonUpgrade({
    targetVersion: process.env.APP_VERSION,
    source: DAEMON_UPGRADE_SOURCE.MANUAL,
  });
  if (!result.ok) {
    return c.json({ error: result.reason ?? 'upgrade_request_failed', deliveryStatus: result.deliveryStatus }, 400);
  }
  const persistedStatus = result.deliveryStatus === DAEMON_UPGRADE_DELIVERY_STATUS.SENT
    ? CONTROLLED_NODE_UPGRADE_STATUS.UPGRADING
    : result.deliveryStatus === DAEMON_UPGRADE_DELIVERY_STATUS.BACKOFF
      ? CONTROLLED_NODE_UPGRADE_STATUS.FAILED
      : CONTROLLED_NODE_UPGRADE_STATUS.DEFERRED;
  await c.env.DB.execute(
    `UPDATE servers
        SET controlled_upgrade_status = $1,
            controlled_upgrade_target_version = $2,
            controlled_upgrade_reason = $3
      WHERE id = $4 AND node_role = $5 AND revoked_at IS NULL`,
    [persistedStatus, result.targetVersion ?? process.env.APP_VERSION ?? null, result.reason ?? null, serverId, NODE_ROLE.CONTROLLED],
  );
  return c.json({
    ok: true,
    upgradeId: result.upgradeId,
    targetVersion: result.targetVersion,
    deliveryStatus: result.deliveryStatus,
    ...(result.nextAttemptAt ? { nextAttemptAt: result.nextAttemptAt } : {}),
    ...(result.reason ? { reason: result.reason } : {}),
  });
});

// POST /api/machines/desk-binding?serverId=... — owner binds this machine to
// one Desk.
//
// Deliberately NOT under the `/:serverId/` device-action namespace. Upstream's
// authority contract defines every route there as a device capability that must
// admit through resolveControlledMachineOperatorAccess with no owner predicate,
// and that is right for acting ON a device. Binding is not such an action: it
// chooses the authorization domain that decides who counts as a Participant at
// all, so delegating it to a Participant would let a grantee re-point the
// machine at a Desk they control. Keeping it outside that namespace states the
// distinction instead of carving an exception into the contract, and matches
// the repository convention of `?serverId=` for new routes.
//
// This is the only way a machine joins or leaves a group, and it is deliberately
// explicit. Nothing infers a group from the owner's memberships: a "obvious
// default" would silently decide who can reach the machine. Every ambiguous or
// unauthorized shape below fails closed and changes no membership.
machinesRoutes.post('/desk-binding', requireAuth(), async (c) => {
  const userId = c.get('userId' as never) as string;
  const serverId = c.req.query('serverId')?.trim();
  if (!serverId) return c.json({ error: 'invalid_body' }, 400);
  const body = await c.req.json().catch(() => null);
  // One group at a time, joined or left explicitly. A machine can be in several
  // groups, so there is no "the" group to set: `{ teamId, member: false }` takes
  // it out of that one and leaves the rest alone. Both keys are required --
  // changing who can reach a machine is not something a malformed body should
  // be able to do by omission.
  const parsed = z.object({
    teamId: z.string().trim().min(1),
    member: z.boolean(),
  }).safeParse(body);
  if (!parsed.success) return c.json({ error: 'invalid_body', reason: 'desk_required' }, 400);
  const { teamId, member } = parsed.data;

  // Only the machine's own owner may file it, and only while it is live.
  const machine = await c.env.DB.queryOne<{ id: string }>(
    `SELECT id FROM servers
      WHERE id = $1 AND user_id = $2 AND node_role = $3 AND revoked_at IS NULL`,
    [serverId, userId, NODE_ROLE.CONTROLLED],
  );
  if (!machine) return c.json({ error: 'not_found' }, 404);

  // Putting a machine INTO a group requires managing that group. Taking it out
  // requires nothing beyond owning the machine, which is checked above --
  // otherwise an owner removed from the group could never get their own machine
  // back out of it.
  if (member) {
    const membership = await c.env.DB.queryOne<{ role: string }>(
      `SELECT tm.role FROM team_members tm
         JOIN teams t ON t.id = tm.team_id
        WHERE tm.team_id = $1 AND tm.user_id = $2 AND tm.role IN ('owner', 'admin')`,
      [teamId, userId],
    );
    if (!membership) return c.json({ error: 'forbidden', reason: 'desk_membership_required' }, 403);
    await c.env.DB.execute(
      `INSERT INTO machine_groups (server_id, team_id, added_at) VALUES ($1, $2, $3)
       ON CONFLICT (server_id, team_id) DO NOTHING`,
      [serverId, teamId, Date.now()],
    );
  } else {
    await c.env.DB.execute(
      'DELETE FROM machine_groups WHERE server_id = $1 AND team_id = $2',
      [serverId, teamId],
    );
  }

  const ip = (c.get('clientIp' as never) as string) ?? 'unknown';
  logAudit({
    userId,
    action: member ? 'machine.group_add' : 'machine.group_remove',
    ip,
    details: { serverId, teamId },
  }, c.env.DB).catch(() => {});
  return c.json({ ok: true, teamId, member });
});

// POST /api/machines/host-link?serverId=... — owner declares which daemon this
// controlled node shares a computer with (`{ hostServerId }`), or clears it
// (`{ hostServerId: null }`).
//
// The same link enrollment records when a node is installed from a daemon's own
// remote-desktop button, for nodes that were installed some other way: that
// daemon's button then opens this node instead of offering an install. Like
// desk-binding, it chooses a relationship rather than acting on the device, so
// it lives outside the `/:serverId/` operator namespace and admits only the
// owner of both rows.
machinesRoutes.post(MACHINE_HOST_LINK_ROUTE, requireAuth(), async (c) => {
  const userId = c.get('userId' as never) as string;
  const serverId = c.req.query('serverId')?.trim();
  if (!serverId) return c.json({ error: 'invalid_body' }, 400);
  const body = await c.req.json().catch(() => null);
  // Required, not optional: clearing a link is `null`, never an omitted key.
  const parsed = z.object({
    hostServerId: z.string().trim().min(1).max(128).nullable(),
  }).safeParse(body);
  if (!parsed.success) return c.json({ error: 'invalid_body' }, 400);
  const { hostServerId } = parsed.data;

  const node = await c.env.DB.queryOne<{ id: string; host_server_id: string | null }>(
    `SELECT id, host_server_id FROM servers
      WHERE id = $1 AND user_id = $2 AND node_role = $3 AND revoked_at IS NULL`,
    [serverId, userId, NODE_ROLE.CONTROLLED],
  );
  if (!node) return c.json({ error: 'not_found' }, 404);

  if (hostServerId !== null) {
    // Same rule enrollment applies to its hostServerId: a live daemon of this
    // same user, never a controlled node and never someone else's machine.
    if (!await isOwnedHostDaemon(c.env.DB, userId, hostServerId)) {
      return c.json({ error: MACHINE_HOST_LINK_ERROR.INVALID_HOST_SERVER }, 403);
    }
    if (await hostIdentitiesConflict(c.env.DB, serverId, hostServerId)) {
      return c.json({ error: MACHINE_HOST_LINK_ERROR.HOST_CONFLICT }, 409);
    }
  }

  await setControlledNodeHost(c.env.DB, { userId, nodeServerId: serverId, hostServerId });

  const ip = (c.get('clientIp' as never) as string) ?? 'unknown';
  logAudit({
    userId,
    action: hostServerId !== null ? MACHINE_HOST_LINK_AUDIT.LINK : MACHINE_HOST_LINK_AUDIT.UNLINK,
    ip,
    details: { serverId, hostServerId, previousHostServerId: node.host_server_id },
  }, c.env.DB).catch(() => {});
  return c.json({ ok: true, hostServerId });
});

// POST /api/machines/:serverId/revoke — operator kill-switch (10.3).
machinesRoutes.post('/:serverId/revoke', requireAuth(), async (c) => {
  const userId = c.get('userId' as never) as string;
  const serverId = c.req.param('serverId');
  if (!serverId) return c.json({ error: 'invalid_body' }, 400);
  const now = Date.now();
  const access = await resolveControlledMachineManagementAccess(c.env.DB, userId, serverId, now);
  if (!access) return c.json({ error: 'not_found' }, 404);
  const row = await c.env.DB.queryOne<{ id: string }>(
    `UPDATE servers SET revoked_at = $2
      WHERE id = $1 AND node_role = $3 AND revoked_at IS NULL
      RETURNING id`,
    [serverId, now, NODE_ROLE.CONTROLLED],
  );
  if (!row) return c.json({ error: 'not_found' }, 404);
  // Drop the live connection immediately (the `:serverId` path is ingress
  // pod-sticky, so this request lands on the pod holding the WS). A reconnect is
  // rejected by the revoked_at check in WebSocket auth. Any in-flight exec is
  // abandoned to `null` → the source sees an indeterminate outcome (the command
  // may already have run on the node), never a fabricated success/failure.
  try {
    const bridge = WsBridge.get(serverId);
    bridge.stopAllRemoteDesktop(REMOTE_DESKTOP_TERMINAL_REASON.AUTHORITY_REVOKED);
    bridge.kickDaemon();
    abandonAllForTarget(serverId);
  } catch { /* offline / other pod */ }
  const ip = (c.get('clientIp' as never) as string) ?? 'unknown';
  logAudit({ userId, action: 'machine.revoke', ip, details: { serverId } }, c.env.DB).catch(() => {});
  return c.json({ ok: true });
});

// POST /api/machines/:serverId/exec-enabled — the OWNER's exec switch (D-E exec gate) for one device.
//
// Owner-only (resolveControlledMachineManagementAccess default scope): the switch that lets commands run as SYSTEM/root is the device
// owner's alone. A participant could otherwise re-enable exec the owner had turned off.
machinesRoutes.post('/:serverId/exec-enabled', requireAuth(), async (c) => {
  const userId = c.get('userId' as never) as string;
  const serverId = c.req.param('serverId');
  if (!serverId) return c.json({ error: 'invalid_body' }, 400);
  const body = await c.req.json().catch(() => null);
  const parsed = z.object({ enabled: z.boolean() }).safeParse(body);
  if (!parsed.success) return c.json({ error: 'invalid_body' }, 400);
  const access = await resolveControlledMachineManagementAccess(c.env.DB, userId, serverId, Date.now());
  if (!access) return c.json({ error: 'not_found' }, 404);
  // Capture the prior value so the audit records from → to (enabling exec is a
  // high-privilege action that gates SYSTEM/root RCE and MUST be attributable).
  const row = await c.env.DB.queryOne<{ was: boolean }>(
    `UPDATE servers SET exec_enabled = $2
       FROM (SELECT exec_enabled AS was FROM servers WHERE id = $1) prev
      WHERE servers.id = $1 AND servers.node_role = $3 AND servers.revoked_at IS NULL
      RETURNING prev.was`,
    [serverId, parsed.data.enabled, NODE_ROLE.CONTROLLED],
  );
  if (!row) return c.json({ error: 'not_found' }, 404);
  if (!parsed.data.enabled) stopExecutionOnDevice(serverId);
  const ip = (c.get('clientIp' as never) as string) ?? 'unknown';
  logAudit({
    userId,
    action: 'machine.exec_enabled',
    ip,
    details: { serverId, from: row.was === true, to: parsed.data.enabled },
  }, c.env.DB).catch(() => {});
  return c.json({ ok: true, execEnabled: parsed.data.enabled });
});

/**
 * Everything that is running or waiting on a device stops when its exec switch goes off: remote-desktop peers end, and every pending
 * exec / computer-use result wait is abandoned (the caller sees an indeterminate outcome, never a late success). New commands are refused
 * by the next admission, and a command already admitted re-reads the switch immediately before it is sent.
 */
function stopExecutionOnDevice(serverId: string): void {
  try {
    const bridge = WsBridge.get(serverId);
    // This route is pod-sticky by serverId. Terminate every peer immediately
    // after the DB mutation; worker lease expiry remains the lost-message guard.
    bridge.stopAllRemoteDesktop(REMOTE_DESKTOP_TERMINAL_REASON.EXECUTION_DISABLED);
    abandonAllForTarget(serverId);
  } catch { /* offline / other pod: the database switch is what every pod reads next */ }
}

// POST /api/machines/exec-enabled — the owner's KILL SWITCH for every device they own, at once. It can only turn execution OFF: turning
// everything on at once is not a convenience worth having.
machinesRoutes.post('/exec-enabled', requireAuth(), async (c) => {
  const userId = c.get('userId' as never) as string;
  const body = await c.req.json().catch(() => null);
  const parsed = z.object({ enabled: z.literal(false) }).safeParse(body);
  if (!parsed.success) return c.json({ error: 'invalid_body', reason: 'only_disable_is_allowed' }, 400);
  const switched = await c.env.DB.query<{ id: string }>(
    `UPDATE servers SET exec_enabled = false
      WHERE user_id = $1 AND node_role = $2 AND revoked_at IS NULL AND exec_enabled = true
      RETURNING id`,
    [userId, NODE_ROLE.CONTROLLED],
  );
  for (const device of switched) stopExecutionOnDevice(device.id);
  const ip = (c.get('clientIp' as never) as string) ?? 'unknown';
  logAudit({
    userId,
    action: 'machine.exec_disabled_all',
    ip,
    details: { count: switched.length },
  }, c.env.DB).catch(() => {});
  return c.json({ ok: true, execEnabled: false, devicesSwitchedOff: switched.length });
});

// GET /api/machines/:serverId/exec-audit — what was tried on this device, allowed and refused (hash and length only, never the command).
machinesRoutes.get('/:serverId/exec-audit', requireAuth(), async (c) => {
  const userId = c.get('userId' as never) as string;
  const serverId = c.req.param('serverId');
  if (!serverId) return c.json({ error: 'invalid_body' }, 400);
  const access = await resolveControlledMachineManagementAccess(c.env.DB, userId, serverId, Date.now());
  if (!access) return c.json({ error: 'not_found' }, 404);
  const limitRaw = Number(c.req.query('limit') ?? 50);
  const limit = Number.isInteger(limitRaw) ? Math.min(Math.max(limitRaw, 1), 200) : 50;
  const beforeRaw = c.req.query('before');
  const before = beforeRaw !== undefined && Number.isSafeInteger(Number(beforeRaw)) ? Number(beforeRaw) : undefined;
  const decisionRaw = c.req.query('decision');
  const decision = decisionRaw === 'allowed' || decisionRaw === 'denied' ? decisionRaw : undefined;
  const entries = await listMachineActionAudit(c.env.DB, serverId, {
    limit,
    ...(before !== undefined ? { before } : {}),
    ...(decision ? { decision } : {}),
  });
  return c.json({ entries });
});

/**
 * Store or clear the node's Windows sign-in secret so it can answer its own
 * lock screen while an authorized controller watches.
 *
 * The secret is relayed and never retained: it is not written to the database,
 * not placed in an audit detail, not logged, and not readable back through any
 * route. Only the boolean outcome the node reports is persisted, so the list
 * page can mark the node. Owner and active Participant use the same
 * centralized device-operation authority.
 */
machinesRoutes.post('/:serverId/auto-unlock', requireAuth(), async (c) => {
  const userId = c.get('userId' as never) as string;
  const serverId = c.req.param('serverId');
  if (!serverId) return c.json({ error: 'invalid_body' }, 400);
  const body = await c.req.json().catch(() => null);
  const parsed = z.object({
    secret: z.string()
      .min(1)
      .max(CONTROLLED_NODE_AUTO_UNLOCK_LIMITS.MAX_SECRET_LENGTH)
      .nullable(),
  }).safeParse(body);
  if (!parsed.success) return c.json({ error: 'invalid_body' }, 400);

  const owned = await resolveControlledMachineManagementAccess(c.env.DB, userId, serverId, Date.now());
  if (!owned) return c.json({ error: 'not_found' }, 404);
  // A node that never advertised auto unlock cannot answer this command; it
  // would simply not reply, and the caller would wait out the whole timeout
  // for what is really "this build does not have the feature".
  const capabilities = validateControlledNodeCapabilities(owned.controlled_capabilities);
  if (!capabilities.ok
    || !capabilities.value.includes(CONTROLLED_NODE_AUTO_UNLOCK_CAPABILITY)) {
    return c.json({ error: CONTROLLED_NODE_AUTO_UNLOCK_ERROR.UNSUPPORTED_PLATFORM }, 409);
  }

  const bridge = WsBridge.get(serverId);
  const generation = bridge.daemonConnectionGeneration();
  const requestId = randomUUID();
  const pending = registerPendingAutoUnlock(
    serverId,
    requestId,
    generation,
    AUTO_UNLOCK_TIMEOUT_MS,
  );
  const sent = bridge.trySendAutoUnlock(JSON.stringify({
    type: DAEMON_COMMAND_TYPES.CONTROLLED_NODE_AUTO_UNLOCK,
    requestId,
    action: parsed.data.secret === null
      ? CONTROLLED_NODE_AUTO_UNLOCK_ACTION.CLEAR
      : CONTROLLED_NODE_AUTO_UNLOCK_ACTION.SET,
    ...(parsed.data.secret === null ? {} : { secret: parsed.data.secret }),
  }), generation);
  if (sent !== 'sent') {
    cancelPendingAutoUnlock(requestId);
    return c.json({ error: 'node_offline' }, 503);
  }
  const result = await pending;
  if (!result) return c.json({ error: 'node_timeout' }, 504);

  await c.env.DB.execute(
    `UPDATE servers SET auto_unlock_configured = $2
      WHERE id = $1`,
    [serverId, result.configured],
  );
  const ip = (c.get('clientIp' as never) as string) ?? 'unknown';
  logAudit({
    userId,
    action: 'machine.auto_unlock',
    ip,
    // Records the decision, never the secret.
    details: { serverId, configured: result.configured, ok: result.ok },
  }, c.env.DB).catch(() => {});
  if (!result.ok) {
    return c.json({ error: result.error ?? 'store_failed', configured: result.configured }, 502);
  }
  return c.json({ ok: true, autoUnlockConfigured: result.configured });
});

// POST /api/machines/:serverId/remote-desktop-permissions — ask the machine to
// raise its own screen-recording prompt.
//
// The grant itself is never made here and cannot be: macOS shows that dialog
// only to a responsible signed application running in the console user's
// session, and only a human can answer it. All this endpoint does is ask the
// node to put it on screen.
machinesRoutes.post('/:serverId/remote-desktop-permissions', requireAuth(), async (c) => {
  const userId = c.get('userId' as never) as string;
  const serverId = c.req.param('serverId');
  if (!serverId) return c.json({ error: 'invalid_body' }, 400);
  const owned = await resolveControlledMachineManagementAccess(c.env.DB, userId, serverId, Date.now());
  if (!owned) return c.json({ error: 'not_found' }, 404);
  const now = Date.now();
  // Presence is load-bearing rather than cosmetic: the dialog appears on the
  // machine, so asking an offline one produces nothing an operator can see.
  if (owned.status !== 'online'
    || typeof owned.last_heartbeat_at !== 'number'
    || now - owned.last_heartbeat_at >= MACHINE_PRESENCE_STALENESS_MS) {
    return c.json({ error: 'node_offline' }, 503);
  }
  const bridge = WsBridge.get(serverId);
  if (bridge.tryRequestControlledNodeRemoteDesktopPermissions(
    bridge.daemonConnectionGeneration(),
  ) !== 'sent') {
    return c.json({ error: 'node_offline' }, 503);
  }
  logAudit({
    userId,
    action: 'machine.remote_desktop_permission_request',
    ip: (c.get('clientIp' as never) as string) ?? 'unknown',
    details: { serverId },
  }, c.env.DB).catch(() => {});
  return c.json({ ok: true }, 202);
});

// POST /api/machines/:serverId/remote-desktop-worker — operator quick repair.
machinesRoutes.post('/:serverId/remote-desktop-worker', requireAuth(), async (c) => {
  const userId = c.get('userId' as never) as string;
  const serverId = c.req.param('serverId');
  if (!serverId) return c.json({ error: 'invalid_body' }, 400);
  const owned = await resolveControlledMachineManagementAccess(c.env.DB, userId, serverId, Date.now());
  if (!owned) return c.json({ error: 'not_found' }, 404);
  const capabilities = validateControlledNodeCapabilities(owned.controlled_capabilities);
  // Whichever platform advertised that it can install. The OS was checked
  // here as well as the capability, which made the capability redundant on
  // Windows and made every other platform unreachable -- a macOS node that
  // advertised it could install was refused by the layer above it.
  const installable = capabilities.ok
    && (capabilities.value.includes(REMOTE_DESKTOP_INSTALLABLE_CAPABILITY)
      || capabilities.value.includes(REMOTE_DESKTOP_MACOS_INSTALLABLE_CAPABILITY));
  // A controlled node may briefly advertise both capabilities while the
  // server's durable snapshot catches up with a reconnect (notably Linux:
  // the worker is present but the Xvfb desktop is not).  The install request
  // is idempotent and the node-side handler decides whether provisioning or
  // repair is still needed, so rejecting the mixed snapshot would strand the
  // one action that can make the node usable.  Keep the capability gate, but
  // do not turn a stale READY token into a permanent 409.
  if (!installable) {
    return c.json({ error: 'remote_desktop_worker_not_installable' }, 409);
  }
  if (isImcodesVersionOutdated(owned.daemon_version, process.env.APP_VERSION)) {
    return c.json({ error: 'node_update_pending' }, 409);
  }
  const now = Date.now();
  if (owned.status !== 'online'
    || typeof owned.last_heartbeat_at !== 'number'
    || now - owned.last_heartbeat_at >= MACHINE_PRESENCE_STALENESS_MS) {
    return c.json({ error: 'node_offline' }, 503);
  }
  const bridge = WsBridge.get(serverId);
  const generation = bridge.daemonConnectionGeneration();
  if (bridge.tryInstallControlledNodeRemoteDesktopWorker(generation) !== 'sent') {
    return c.json({ error: 'node_offline' }, 503);
  }
  const ip = (c.get('clientIp' as never) as string) ?? 'unknown';
  logAudit({
    userId,
    action: 'machine.remote_desktop_worker_install',
    ip,
    details: { serverId },
  }, c.env.DB).catch(() => {});
  return c.json({ ok: true }, 202);
});

// POST /api/machines/:serverId/remote-desktop-worker/refresh — explicitly
// request one independent worker refresh on a controlled node. This is not a
// daemon upgrade and is deliberately separate from the first-install/repair
// endpoint above.
machinesRoutes.post('/:serverId/remote-desktop-worker/refresh', requireAuth(), async (c) => {
  const userId = c.get('userId' as never) as string;
  const serverId = c.req.param('serverId');
  if (!serverId) return c.json({ error: 'invalid_body' }, 400);
  const owned = await resolveControlledMachineManagementAccess(c.env.DB, userId, serverId, Date.now());
  if (!owned) return c.json({ error: 'not_found' }, 404);
  const capabilities = validateControlledNodeCapabilities(owned.controlled_capabilities);
  if (!capabilities.ok
    || !capabilities.value.includes(REMOTE_DESKTOP_CAPABILITY)
    || !capabilities.value.includes(CONTROLLED_NODE_WORKER_REFRESH_CAPABILITY)) {
    return c.json({ error: 'remote_desktop_worker_refresh_unsupported' }, 409);
  }
  const now = Date.now();
  if (owned.status !== 'online'
    || typeof owned.last_heartbeat_at !== 'number'
    || now - owned.last_heartbeat_at >= MACHINE_PRESENCE_STALENESS_MS) {
    return c.json({ error: 'node_offline' }, 503);
  }
  const bridge = WsBridge.get(serverId);
  const generation = bridge.daemonConnectionGeneration();
  const delivery = bridge.tryRefreshControlledNodeRemoteDesktopWorker(generation);
  if (delivery !== 'sent') {
    return c.json({
      error: delivery === 'generation_changed' ? 'node_connection_changed' : 'node_offline',
    }, delivery === 'generation_changed' ? 409 : 503);
  }
  logAudit({
    userId,
    action: 'machine.remote_desktop_worker_refresh',
    ip: (c.get('clientIp' as never) as string) ?? 'unknown',
    details: { serverId },
  }, c.env.DB).catch(() => {});
  return c.json({ ok: true }, 202);
});
