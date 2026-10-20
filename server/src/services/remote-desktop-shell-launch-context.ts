import { createHash, randomBytes } from 'node:crypto';
import type { Database } from '../db/client.js';
import {
  REMOTE_DESKTOP_NATIVE_CLIENT,
  type AccountSession,
} from './remote-desktop-account-auth.js';
import {
  REMOTE_DESKTOP_PRIVACY_LIMITS,
  validateRemoteDesktopShellLaunchContext,
  type RemoteDesktopShellLaunchContext,
} from '../../../shared/remote-desktop-access.js';

const CONTEXT_HASH_DOMAIN = 'imcodes.remote-desktop.shell-launch-context.v1';
const LAUNCH_ID_BYTES = 32;

export interface RemoteDesktopShellEndpointAuthority {
  /** Current authenticated controlled-node channel target. */
  serverId: string;
  /** Current Server connection/daemon generation for that target. */
  endpointGeneration: number;
}

/**
 * Runtime seam owned by the authenticated node-channel adapter.  Implementors
 * must return only an authority-ready controlled endpoint and must make
 * dispatch generation-bound/non-queueing.  This service deliberately cannot
 * infer liveness or generation from database rows.
 */
export interface RemoteDesktopShellLaunchContextDispatcher {
  currentControlledEndpoint(input: {
    ownerUserId: string;
    hostId: string;
  }): Promise<RemoteDesktopShellEndpointAuthority | null>;
  dispatch(input: {
    ownerUserId: string;
    hostId: string;
    context: RemoteDesktopShellLaunchContext;
    executionServerId: string;
    endpointGeneration: number;
  }): Promise<boolean>;
}

let productionDispatcher: RemoteDesktopShellLaunchContextDispatcher | null = null;

/** Install/remove the authenticated-node delivery adapter. Null is fail closed. */
export function setRemoteDesktopShellLaunchContextDispatcher(
  dispatcher: RemoteDesktopShellLaunchContextDispatcher | null,
): void {
  productionDispatcher = dispatcher;
}

export function getRemoteDesktopShellLaunchContextDispatcher():
  RemoteDesktopShellLaunchContextDispatcher | null {
  return productionDispatcher;
}

export type RemoteDesktopShellLaunchBinding = {
  ownerUserId: string;
  nativeSessionId: string;
  hostId: string;
  executionServerId: string;
  endpointGeneration: number;
  issuedAt: number;
  expiresAt: number;
};

type StoredLaunchContext = {
  owner_user_id: string;
  native_session_id: string;
  host_id: string;
  execution_server_id: string;
  endpoint_generation: number;
  issued_at: number;
  expires_at: number;
};

function canonicalContextBytes(context: RemoteDesktopShellLaunchContext): Buffer {
  return Buffer.from(JSON.stringify({
    hostId: context.hostId,
    launchId: context.launchId,
    issuedAt: context.issuedAt,
    expiresAt: context.expiresAt,
    endpointGeneration: context.endpointGeneration,
  }), 'utf8');
}

export function hashRemoteDesktopShellLaunchContext(
  context: RemoteDesktopShellLaunchContext,
): string {
  if (!validateRemoteDesktopShellLaunchContext(context).ok) {
    throw new Error('invalid_shell_launch_context');
  }
  return createHash('sha256')
    .update(CONTEXT_HASH_DOMAIN, 'utf8')
    .update(Buffer.from([0]))
    .update(canonicalContextBytes(context))
    .digest('hex');
}

function nativeSessionOnly(session: AccountSession): session is AccountSession & { kind: 'native' } {
  return session.kind === 'native';
}

async function lockCurrentNativeOwnerSession(
  tx: Database,
  session: AccountSession,
  now: number,
): Promise<boolean> {
  if (!nativeSessionOnly(session)) return false;
  const row = await tx.queryOne<{ id: string }>(
    `SELECT session.id
       FROM remote_desktop_native_sessions AS session
       JOIN users AS account ON account.id = session.user_id
      WHERE session.id = $1
        AND session.user_id = $2
        AND session.client_id = $3
        AND session.audience = $4
        AND session.revoked_at IS NULL
        AND session.expires_at > $5
        AND account.status = 'active'
      FOR UPDATE OF session, account`,
    [
      session.id,
      session.userId,
      REMOTE_DESKTOP_NATIVE_CLIENT.clientId,
      REMOTE_DESKTOP_NATIVE_CLIENT.audience,
      now,
    ],
  );
  return row != null;
}

async function lockOwnedHost(tx: Database, ownerUserId: string, hostId: string): Promise<boolean> {
  const row = await tx.queryOne<{ id: string }>(
    `SELECT host.id
       FROM remote_desktop_hosts AS host
      WHERE host.id = $1 AND host.owner_user_id = $2
        AND host.merge_state = 'resolved'
      FOR UPDATE OF host`,
    [hostId, ownerUserId],
  );
  return row != null;
}

async function lockControlledEndpoint(
  tx: Database,
  binding: { ownerUserId: string; hostId: string; serverId: string },
): Promise<boolean> {
  const row = await tx.queryOne<{ server_id: string }>(
    `SELECT mapping.server_id
       FROM remote_desktop_host_endpoints AS mapping
       JOIN servers AS endpoint ON endpoint.id = mapping.server_id
      WHERE mapping.server_id = $1
        AND mapping.host_id = $2
        AND mapping.owner_user_id = $3
        AND mapping.endpoint_role = 'controlled'
        AND endpoint.user_id = $3
        AND endpoint.node_role = 'controlled'
      FOR UPDATE OF mapping, endpoint`,
    [binding.serverId, binding.hostId, binding.ownerUserId],
  );
  return row != null;
}

function isEndpointAuthority(value: RemoteDesktopShellEndpointAuthority | null):
value is RemoteDesktopShellEndpointAuthority {
  return value != null
    && /^[A-Za-z0-9_-]{1,128}$/.test(value.serverId)
    && Number.isSafeInteger(value.endpointGeneration)
    && value.endpointGeneration >= 0;
}

function storedBinding(row: StoredLaunchContext): RemoteDesktopShellLaunchBinding {
  return {
    ownerUserId: row.owner_user_id,
    nativeSessionId: row.native_session_id,
    hostId: row.host_id,
    executionServerId: row.execution_server_id,
    endpointGeneration: Number(row.endpoint_generation),
    issuedAt: Number(row.issued_at),
    expiresAt: Number(row.expires_at),
  };
}

export async function issueRemoteDesktopShellLaunchContext(input: {
  db: Database;
  accountSession: AccountSession;
  hostId: string;
  dispatcher: RemoteDesktopShellLaunchContextDispatcher;
  now?: number;
  ttlMs?: number;
}): Promise<{
  status: 'accepted';
  expiresAt: number;
} | null> {
  const now = input.now ?? Date.now();
  const ttlMs = input.ttlMs ?? REMOTE_DESKTOP_PRIVACY_LIMITS.LAUNCH_CONTEXT_TTL_MS;
  if (!nativeSessionOnly(input.accountSession)
    || !Number.isSafeInteger(now) || now < 0
    || !Number.isSafeInteger(ttlMs) || ttlMs <= 0
    || ttlMs > REMOTE_DESKTOP_PRIVACY_LIMITS.LAUNCH_CONTEXT_TTL_MS) return null;

  const issued = await input.db.transaction(async (tx) => {
    if (!await lockCurrentNativeOwnerSession(tx, input.accountSession, now)) return null;
    if (!await lockOwnedHost(tx, input.accountSession.userId, input.hostId)) return null;

    const endpoint = await input.dispatcher.currentControlledEndpoint({
      ownerUserId: input.accountSession.userId,
      hostId: input.hostId,
    });
    if (!isEndpointAuthority(endpoint)) return null;
    if (!await lockControlledEndpoint(tx, {
      ownerUserId: input.accountSession.userId,
      hostId: input.hostId,
      serverId: endpoint.serverId,
    })) return null;

    const context: RemoteDesktopShellLaunchContext = {
      hostId: input.hostId,
      launchId: randomBytes(LAUNCH_ID_BYTES).toString('base64url'),
      issuedAt: now,
      expiresAt: now + ttlMs,
      endpointGeneration: endpoint.endpointGeneration,
    };
    if (!validateRemoteDesktopShellLaunchContext(context).ok) return null;
    await tx.execute(
      `INSERT INTO remote_desktop_shell_launch_contexts
         (context_hash, owner_user_id, native_session_id, host_id,
          execution_server_id, endpoint_generation, issued_at, expires_at, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $7)`,
      [
        hashRemoteDesktopShellLaunchContext(context),
        input.accountSession.userId,
        input.accountSession.id,
        input.hostId,
        endpoint.serverId,
        endpoint.endpointGeneration,
        now,
        context.expiresAt,
      ],
    );
    return { context, endpoint };
  });
  if (!issued) return null;

  let dispatched = false;
  try {
    dispatched = await input.dispatcher.dispatch({
      ownerUserId: input.accountSession.userId,
      hostId: input.hostId,
      context: issued.context,
      executionServerId: issued.endpoint.serverId,
      endpointGeneration: issued.endpoint.endpointGeneration,
    });
  } catch {
    dispatched = false;
  }
  if (!dispatched) {
    await input.db.execute(
      `UPDATE remote_desktop_shell_launch_contexts
          SET invalidated_at = $2
        WHERE context_hash = $1 AND redeemed_at IS NULL AND invalidated_at IS NULL`,
      [hashRemoteDesktopShellLaunchContext(issued.context), now],
    );
    return null;
  }
  return {
    status: 'accepted',
    expiresAt: issued.context.expiresAt,
  };
}

/**
 * Consume the launch proof inside its caller's sensitive transaction.  The
 * callback is where the future signed-shell privacy-begin operation belongs;
 * throwing rolls the redeemed_at update back, so there is intentionally no
 * standalone HTTP endpoint that can burn the only proof as a no-op.
 */
export async function redeemRemoteDesktopShellLaunchContext<T>(input: {
  db: Database;
  accountSession: AccountSession;
  context: unknown;
  dispatcher: RemoteDesktopShellLaunchContextDispatcher;
  now?: number;
  onRedeemedTx: (tx: Database, binding: RemoteDesktopShellLaunchBinding) => Promise<T>;
}): Promise<{ binding: RemoteDesktopShellLaunchBinding; result: T } | null> {
  const parsed = validateRemoteDesktopShellLaunchContext(input.context);
  const now = input.now ?? Date.now();
  if (!parsed.ok || !nativeSessionOnly(input.accountSession)
    || !Number.isSafeInteger(now) || now < parsed.value.issuedAt
    || now >= parsed.value.expiresAt) return null;

  return input.db.transaction(async (tx) => {
    if (!await lockCurrentNativeOwnerSession(tx, input.accountSession, now)) return null;
    const row = await tx.queryOne<StoredLaunchContext>(
      `SELECT owner_user_id, native_session_id, host_id, execution_server_id,
              endpoint_generation, issued_at, expires_at
         FROM remote_desktop_shell_launch_contexts
        WHERE context_hash = $1
          AND owner_user_id = $2
          AND native_session_id = $3
          AND host_id = $4
          AND endpoint_generation = $5
          AND issued_at = $6
          AND expires_at = $7
          AND redeemed_at IS NULL
          AND invalidated_at IS NULL
          AND expires_at > $8
        FOR UPDATE`,
      [
        hashRemoteDesktopShellLaunchContext(parsed.value),
        input.accountSession.userId,
        input.accountSession.id,
        parsed.value.hostId,
        parsed.value.endpointGeneration,
        parsed.value.issuedAt,
        parsed.value.expiresAt,
        now,
      ],
    );
    if (!row) return null;
    if (!await lockOwnedHost(tx, row.owner_user_id, row.host_id)) return null;
    if (!await lockControlledEndpoint(tx, {
      ownerUserId: row.owner_user_id,
      hostId: row.host_id,
      serverId: row.execution_server_id,
    })) return null;
    const current = await input.dispatcher.currentControlledEndpoint({
      ownerUserId: row.owner_user_id,
      hostId: row.host_id,
    });
    if (!isEndpointAuthority(current)
      || current.serverId !== row.execution_server_id
      || current.endpointGeneration !== Number(row.endpoint_generation)) return null;

    const consumed = await tx.execute(
      `UPDATE remote_desktop_shell_launch_contexts
          SET redeemed_at = $2
        WHERE context_hash = $1 AND redeemed_at IS NULL AND invalidated_at IS NULL`,
      [hashRemoteDesktopShellLaunchContext(parsed.value), now],
    );
    if (consumed.changes !== 1) return null;
    const binding = storedBinding(row);
    const result = await input.onRedeemedTx(tx, binding);
    return { binding, result };
  });
}
