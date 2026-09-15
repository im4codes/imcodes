import { Hono } from 'hono';
import { z } from 'zod';
import type { Env } from '../env.js';
import type { Database } from '../db/client.js';
import { requireAuth } from '../security/authorization.js';
import { logAudit } from '../security/audit.js';
import { WsBridge } from '../ws/bridge.js';
import { abandonAllForTarget } from '../ws/machine-exec-registry.js';
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
  MACHINE_REASONS,
  normalizeMachineDisplayName,
} from '../../../shared/machine-reference.js';
import {
  listAccessibleControlledMachines,
  resolveControlledMachineOperatorAccess,
} from '../share/machine-access.js';
import { validateControlledNodeCapabilities } from '../../../shared/controlled-node-capabilities.js';
import {
  isImcodesVersionOutdated,
  parseImcodesVersion,
} from '../../../shared/imcodes-version.js';
import {
  REMOTE_DESKTOP_CAPABILITY,
  REMOTE_DESKTOP_TERMINAL_REASON,
} from '../../../shared/remote-desktop.js';
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
import { isControlledNodeId } from '../../../shared/controlled-node-identity.js';
import { SHARED_MACHINE_AUTHORITY_HEADER } from '../../../shared/shared-machine-authority.js';
import { resolveMachineOperationalUser } from '../share/shared-machine-authority.js';

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
  host_server_id: string | null;
  remote_desktop_host_id: string | null;
  access_role: MachineAccessRole;
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
): Promise<{ machines: (MachineSummary & {
  nodeId: string;
  refName: string;
  displayName: string;
  execEnabled: boolean;
  accessRole: MachineAccessRole;
  remoteDesktopHostId?: string;
  // Declared because it is emitted. It was not, so the daemon-strip list below
  // could omit it without a type error -- and every strict daemon then rejected
  // the whole machine list as malformed.
  hostServerId?: string;
})[]; overLimit: boolean }> {
  const rows: ControlledRow[] = await listAccessibleControlledMachines(
    db,
    userId,
    nowMs,
    MACHINE_LIST_MAX_ITEMS + 1,
  );
  const overLimit = rows.length > MACHINE_LIST_MAX_ITEMS;
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
  }
  if (!authenticatedDaemon) {
    await backfillCanonicalHosts({
      db: c.env.DB,
      ownerUserId: userId,
      limit: MACHINE_LIST_MAX_ITEMS,
      now,
    });
  }
  const { machines, overLimit } = await listControlledMachines(c.env.DB, userId, now);
  if (overLimit) {
    return c.json({ error: 'machine_list_over_limit', maxItems: MACHINE_LIST_MAX_ITEMS }, 413);
  }
  // Older daemons strictly reject unknown machine-list keys. Server-authenticated
  // callers do not need the display-only role because every action is admitted
  // again against the DB; preserve their legacy DTO during rolling upgrades.
  const responseMachines = authenticatedDaemon
    ? machines.map((machine) => pickDaemonMachineListItem(machine))
    : machines;
  return c.json({ machines: responseMachines });
});

// POST /api/machines/:serverId/display-name — operator-controlled render name.
// A deprecated legacy `ref_name` remains immutable so historical markers stay valid.
machinesRoutes.post('/:serverId/display-name', requireAuth(), async (c) => {
  const userId = c.get('userId' as never) as string;
  const serverId = c.req.param('serverId');
  if (!serverId) return c.json({ error: 'invalid_body' }, 400);
  const body = await c.req.json().catch(() => null);
  const parsed = z.object({ displayName: z.string() }).safeParse(body);
  if (!parsed.success) return c.json({ error: 'invalid_body' }, 400);
  const displayName = normalizeMachineDisplayName(parsed.data.displayName);
  if (!displayName) return c.json({ error: MACHINE_REASONS.INVALID_DISPLAY_NAME }, 400);
  const access = await resolveControlledMachineOperatorAccess(c.env.DB, userId, serverId, Date.now());
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

// POST /api/machines/:serverId/revoke — operator kill-switch (10.3).
machinesRoutes.post('/:serverId/revoke', requireAuth(), async (c) => {
  const userId = c.get('userId' as never) as string;
  const serverId = c.req.param('serverId');
  if (!serverId) return c.json({ error: 'invalid_body' }, 400);
  const now = Date.now();
  const access = await resolveControlledMachineOperatorAccess(c.env.DB, userId, serverId, now);
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

// POST /api/machines/:serverId/exec-enabled — operator toggles D-E exec gate.
machinesRoutes.post('/:serverId/exec-enabled', requireAuth(), async (c) => {
  const userId = c.get('userId' as never) as string;
  const serverId = c.req.param('serverId');
  if (!serverId) return c.json({ error: 'invalid_body' }, 400);
  const body = await c.req.json().catch(() => null);
  const parsed = z.object({ enabled: z.boolean() }).safeParse(body);
  if (!parsed.success) return c.json({ error: 'invalid_body' }, 400);
  const access = await resolveControlledMachineOperatorAccess(c.env.DB, userId, serverId, Date.now());
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
  if (!parsed.data.enabled) {
    // This route is pod-sticky by serverId. Terminate every peer immediately
    // after the DB mutation; worker lease expiry remains the lost-message guard.
    WsBridge.get(serverId).stopAllRemoteDesktop(REMOTE_DESKTOP_TERMINAL_REASON.EXECUTION_DISABLED);
  }
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

  const owned = await resolveControlledMachineOperatorAccess(c.env.DB, userId, serverId, Date.now());
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
  const owned = await resolveControlledMachineOperatorAccess(c.env.DB, userId, serverId, Date.now());
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
  const owned = await resolveControlledMachineOperatorAccess(c.env.DB, userId, serverId, Date.now());
  if (!owned) return c.json({ error: 'not_found' }, 404);
  const capabilities = validateControlledNodeCapabilities(owned.controlled_capabilities);
  // Whichever platform advertised that it can install. The OS was checked
  // here as well as the capability, which made the capability redundant on
  // Windows and made every other platform unreachable -- a macOS node that
  // advertised it could install was refused by the layer above it.
  const installable = capabilities.ok
    && (capabilities.value.includes(REMOTE_DESKTOP_INSTALLABLE_CAPABILITY)
      || capabilities.value.includes(REMOTE_DESKTOP_MACOS_INSTALLABLE_CAPABILITY));
  if (!installable || capabilities.value.includes(REMOTE_DESKTOP_CAPABILITY)) {
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
