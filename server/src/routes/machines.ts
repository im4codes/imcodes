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
} from '../../../shared/remote-exec.js';
import {
  MACHINE_REASONS,
  normalizeMachineDisplayName,
} from '../../../shared/machine-reference.js';
import { listAccessibleControlledMachines } from '../share/machine-access.js';
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
import { REMOTE_DESKTOP_INSTALLABLE_CAPABILITY } from '../../../shared/remote-desktop-install.js';
import { backfillCanonicalHosts } from '../services/remote-desktop-host-identity.js';

/** A node only has to reach its own disk, so this stays short. */
const AUTO_UNLOCK_TIMEOUT_MS = 15_000;

export const machinesRoutes = new Hono<{
  Bindings: Env;
  Variables: { userId: string; role: string; nodeRole?: string; authServerId?: string };
}>();

interface ControlledRow {
  id: string;
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
  refName: string;
  displayName: string;
  execEnabled: boolean;
  accessRole: MachineAccessRole;
  remoteDesktopHostId?: string;
})[]; overLimit: boolean }> {
  const rows: ControlledRow[] = await listAccessibleControlledMachines(
    db,
    userId,
    nowMs,
    MACHINE_LIST_MAX_ITEMS + 1,
  );
  const overLimit = rows.length > MACHINE_LIST_MAX_ITEMS;
  const machines = rows.slice(0, MACHINE_LIST_MAX_ITEMS).map((r) => {
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
      name: r.display_name ?? r.ref_name ?? r.id,
      refName: r.ref_name ?? r.id,
      displayName: r.display_name ?? r.ref_name ?? r.id,
      online,
      nodeRole: NODE_ROLE.CONTROLLED,
      // Viewers may inspect bounded metadata only. Projecting false here also
      // keeps old MCP resolution logic from presenting a non-operable target.
      execEnabled: r.exec_enabled === true && r.access_role !== 'viewer',
      accessRole: r.access_role,
      ...(typeof r.remote_desktop_host_id === 'string' && r.remote_desktop_host_id
        ? { remoteDesktopHostId: r.remote_desktop_host_id }
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
  const userId = c.get('userId' as never) as string;
  const now = Date.now();
  // Browser discovery is also the bounded, resumable provisioning seam for an
  // Owner whose remote-desktop node predates canonical host identity. This is
  // idempotent and owner-scoped; strict daemon clients neither need nor receive
  // the additive identity field.
  const authenticatedDaemon = c.get('nodeRole') === NODE_ROLE.FULL
    && typeof c.get('authServerId') === 'string';
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
    ? machines.map(({
      accessRole: _accessRole,
      remoteDesktopHostId: _remoteDesktopHostId,
      capabilities: _capabilities,
      daemonVersion: _daemonVersion,
      updateAvailable: _updateAvailable,
      autoUnlockConfigured: _autoUnlockConfigured,
      ...machine
    }) => machine)
    : machines;
  return c.json({ machines: responseMachines });
});

// POST /api/machines/:serverId/display-name — owner-controlled render name.
// `ref_name` remains immutable so existing ^^(refName) markers stay valid.
machinesRoutes.post('/:serverId/display-name', requireAuth(), async (c) => {
  const userId = c.get('userId' as never) as string;
  const serverId = c.req.param('serverId');
  if (!serverId) return c.json({ error: 'invalid_body' }, 400);
  const body = await c.req.json().catch(() => null);
  const parsed = z.object({ displayName: z.string() }).safeParse(body);
  if (!parsed.success) return c.json({ error: 'invalid_body' }, 400);
  const displayName = normalizeMachineDisplayName(parsed.data.displayName);
  if (!displayName) return c.json({ error: MACHINE_REASONS.INVALID_DISPLAY_NAME }, 400);

  const row = await c.env.DB.queryOne<{ previous_name: string | null }>(
    `UPDATE servers SET display_name = $3
       FROM (SELECT display_name AS previous_name FROM servers WHERE id = $1) prev
      WHERE servers.id = $1 AND servers.user_id = $2 AND servers.node_role = $4 AND servers.revoked_at IS NULL
      RETURNING prev.previous_name`,
    [serverId, userId, displayName, NODE_ROLE.CONTROLLED],
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

// POST /api/machines/:serverId/revoke — owner kill-switch (10.3).
machinesRoutes.post('/:serverId/revoke', requireAuth(), async (c) => {
  const userId = c.get('userId' as never) as string;
  const serverId = c.req.param('serverId');
  if (!serverId) return c.json({ error: 'invalid_body' }, 400);
  const now = Date.now();
  const row = await c.env.DB.queryOne<{ id: string }>(
    `UPDATE servers SET revoked_at = $3
      WHERE id = $1 AND user_id = $2 AND node_role = $4 AND revoked_at IS NULL
      RETURNING id`,
    [serverId, userId, now, NODE_ROLE.CONTROLLED],
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

// POST /api/machines/:serverId/exec-enabled — owner toggles D-E exec gate.
machinesRoutes.post('/:serverId/exec-enabled', requireAuth(), async (c) => {
  const userId = c.get('userId' as never) as string;
  const serverId = c.req.param('serverId');
  if (!serverId) return c.json({ error: 'invalid_body' }, 400);
  const body = await c.req.json().catch(() => null);
  const parsed = z.object({ enabled: z.boolean() }).safeParse(body);
  if (!parsed.success) return c.json({ error: 'invalid_body' }, 400);
  // Capture the prior value so the audit records from → to (enabling exec is a
  // high-privilege action that gates SYSTEM/root RCE and MUST be attributable).
  const row = await c.env.DB.queryOne<{ was: boolean }>(
    `UPDATE servers SET exec_enabled = $3
       FROM (SELECT exec_enabled AS was FROM servers WHERE id = $1) prev
      WHERE servers.id = $1 AND servers.user_id = $2 AND servers.node_role = $4 AND servers.revoked_at IS NULL
      RETURNING prev.was`,
    [serverId, userId, parsed.data.enabled, NODE_ROLE.CONTROLLED],
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
 * page can mark the node. Owner-only, like every other node mutation here.
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

  const owned = await c.env.DB.queryOne<{ id: string; controlled_capabilities: unknown }>(
    `SELECT id, controlled_capabilities FROM servers
      WHERE id = $1 AND user_id = $2 AND node_role = $3 AND revoked_at IS NULL`,
    [serverId, userId, NODE_ROLE.CONTROLLED],
  );
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
    `UPDATE servers SET auto_unlock_configured = $3
      WHERE id = $1 AND user_id = $2`,
    [serverId, userId, result.configured],
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

// POST /api/machines/:serverId/remote-desktop-worker — owner-only quick repair.
machinesRoutes.post('/:serverId/remote-desktop-worker', requireAuth(), async (c) => {
  const userId = c.get('userId' as never) as string;
  const serverId = c.req.param('serverId');
  if (!serverId) return c.json({ error: 'invalid_body' }, 400);
  const owned = await c.env.DB.queryOne<{
    id: string;
    os: string | null;
    status: string | null;
    last_heartbeat_at: number | null;
    daemon_version: string | null;
    controlled_capabilities: unknown;
  }>(
    `SELECT id, os, status, last_heartbeat_at, daemon_version, controlled_capabilities FROM servers
      WHERE id = $1 AND user_id = $2 AND node_role = $3 AND revoked_at IS NULL`,
    [serverId, userId, NODE_ROLE.CONTROLLED],
  );
  if (!owned) return c.json({ error: 'not_found' }, 404);
  const capabilities = validateControlledNodeCapabilities(owned.controlled_capabilities);
  if (canonicalMachineOs(owned.os) !== 'win'
    || !capabilities.ok
    || !capabilities.value.includes(REMOTE_DESKTOP_INSTALLABLE_CAPABILITY)
    || capabilities.value.includes(REMOTE_DESKTOP_CAPABILITY)) {
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
