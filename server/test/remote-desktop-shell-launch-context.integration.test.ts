import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, type Database } from '../src/db/client.js';
import { runMigrations } from '../src/db/migrate.js';
import { createUser } from '../src/db/queries.js';
import {
  REMOTE_DESKTOP_NATIVE_CLIENT,
  type AccountSession,
} from '../src/services/remote-desktop-account-auth.js';
import {
  hashRemoteDesktopShellLaunchContext,
  issueRemoteDesktopShellLaunchContext,
  redeemRemoteDesktopShellLaunchContext,
  type RemoteDesktopShellEndpointAuthority,
  type RemoteDesktopShellLaunchContextDispatcher,
} from '../src/services/remote-desktop-shell-launch-context.js';
import type { RemoteDesktopShellLaunchContext } from '../../shared/remote-desktop-access.js';
import {
  beginPrivacyEpoch,
  beginPrivacyEpochTx,
  getPrivacyState,
} from '../src/services/remote-desktop-management-privacy.js';
import { REMOTE_DESKTOP_PRESENTATION_SOURCE } from '../../shared/remote-desktop-access.js';

const NOW = 1_700_000_000_000;
let db: Database;

beforeAll(async () => {
  db = createDatabase(process.env.TEST_DATABASE_URL!);
  await runMigrations(db);
});

afterAll(async () => {
  await db.close();
});

type Fixture = {
  ownerUserId: string;
  otherUserId: string;
  hostId: string;
  otherHostId: string;
  serverId: string;
  otherServerId: string;
  nativeSession: AccountSession;
  otherNativeSession: AccountSession;
  sameOwnerOtherSession: AccountSession;
};

async function seedNativeSession(session: AccountSession, sequence: string): Promise<void> {
  await db.execute(
    `INSERT INTO remote_desktop_native_sessions
       (id, session_hash, user_id, originating_session_id, client_id,
        issuer, audience, expires_at, created_at)
     VALUES ($1, $2, $3, $4, $5, 'https://imcodes.test', $6, $7, $8)`,
    [
      session.id,
      createHash('sha256').update(`session:${sequence}`).digest('hex'),
      session.userId,
      `web_${sequence}`,
      REMOTE_DESKTOP_NATIVE_CLIENT.clientId,
      REMOTE_DESKTOP_NATIVE_CLIENT.audience,
      NOW + 3_600_000,
      NOW,
    ],
  );
}

async function seedHostEndpoint(ownerUserId: string, hostId: string, serverId: string): Promise<void> {
  await db.execute(
    `INSERT INTO remote_desktop_hosts (id, owner_user_id, merge_state, created_at, updated_at)
     VALUES ($1, $2, 'resolved', $3, $3)`,
    [hostId, ownerUserId, NOW],
  );
  await db.execute(
    `INSERT INTO servers
       (id, user_id, name, token_hash, status, last_heartbeat_at, created_at, node_role)
     VALUES ($1, $2, 'controlled shell test', $3, 'online', $4, $4, 'controlled')`,
    [serverId, ownerUserId, createHash('sha256').update(serverId).digest('hex'), NOW],
  );
  await db.execute(
    `INSERT INTO remote_desktop_host_endpoints
       (server_id, host_id, owner_user_id, endpoint_role, linked_at)
     VALUES ($1, $2, $3, 'controlled', $4)`,
    [serverId, hostId, ownerUserId, NOW],
  );
}

async function fixture(): Promise<Fixture> {
  const ownerUserId = `u_${randomUUID()}`;
  const otherUserId = `u_${randomUUID()}`;
  await createUser(db, ownerUserId);
  await createUser(db, otherUserId);
  const hostId = randomUUID();
  const otherHostId = randomUUID();
  const serverId = `server_${randomUUID()}`;
  const otherServerId = `server_${randomUUID()}`;
  await seedHostEndpoint(ownerUserId, hostId, serverId);
  await seedHostEndpoint(otherUserId, otherHostId, otherServerId);
  const nativeSession: AccountSession = { kind: 'native', id: `native_${randomUUID()}`, userId: ownerUserId };
  const otherNativeSession: AccountSession = { kind: 'native', id: `native_${randomUUID()}`, userId: otherUserId };
  const sameOwnerOtherSession: AccountSession = { kind: 'native', id: `native_${randomUUID()}`, userId: ownerUserId };
  await seedNativeSession(nativeSession, randomUUID());
  await seedNativeSession(otherNativeSession, randomUUID());
  await seedNativeSession(sameOwnerOtherSession, randomUUID());
  return {
    ownerUserId,
    otherUserId,
    hostId,
    otherHostId,
    serverId,
    otherServerId,
    nativeSession,
    otherNativeSession,
    sameOwnerOtherSession,
  };
}

function dispatcher(initial: RemoteDesktopShellEndpointAuthority): {
  adapter: RemoteDesktopShellLaunchContextDispatcher;
  captured: RemoteDesktopShellLaunchContext[];
  setCurrent: (next: RemoteDesktopShellEndpointAuthority | null) => void;
  setDispatchResult: (next: boolean) => void;
} {
  let current: RemoteDesktopShellEndpointAuthority | null = initial;
  let dispatchResult = true;
  const captured: RemoteDesktopShellLaunchContext[] = [];
  return {
    adapter: {
      currentControlledEndpoint: async () => current,
      dispatch: async (input) => {
        captured.push(input.context);
        return dispatchResult;
      },
    },
    captured,
    setCurrent: (next) => { current = next; },
    setDispatchResult: (next) => { dispatchResult = next; },
  };
}

async function issue(fx: Fixture, adapter: RemoteDesktopShellLaunchContextDispatcher, ttlMs = 60_000) {
  return issueRemoteDesktopShellLaunchContext({
    db,
    accountSession: fx.nativeSession,
    hostId: fx.hostId,
    dispatcher: adapter,
    now: NOW,
    ttlMs,
  });
}

describe('remote desktop signed-shell launch-context persistence', () => {
  it('stores only the context hash, dispatches the exact five-field shape and redeems once', async () => {
    const fx = await fixture();
    const channel = dispatcher({ serverId: fx.serverId, endpointGeneration: 7 });
    const issued = await issue(fx, channel.adapter);
    expect(issued).toEqual({ status: 'accepted', expiresAt: NOW + 60_000 });
    expect(channel.captured).toHaveLength(1);
    const context = channel.captured[0]!;
    expect(Object.keys(context).sort()).toEqual([
      'endpointGeneration', 'expiresAt', 'hostId', 'issuedAt', 'launchId',
    ].sort());

    const stored = await db.queryOne<Record<string, unknown>>(
      'SELECT * FROM remote_desktop_shell_launch_contexts WHERE context_hash = $1',
      [hashRemoteDesktopShellLaunchContext(context)],
    );
    expect(stored).not.toBeNull();
    expect(stored).not.toHaveProperty('launch_id');
    expect(stored).not.toHaveProperty('context_json');
    expect(JSON.stringify(stored)).not.toContain(context.launchId);
    expect(stored?.context_hash).toMatch(/^[0-9a-f]{64}$/);

    const first = await redeemRemoteDesktopShellLaunchContext({
      db,
      accountSession: fx.nativeSession,
      context,
      dispatcher: channel.adapter,
      now: NOW + 1,
      onRedeemedTx: async () => 'ok',
    });
    expect(first?.result).toBe('ok');
    expect(first?.binding).toMatchObject({
      ownerUserId: fx.ownerUserId,
      nativeSessionId: fx.nativeSession.id,
      hostId: fx.hostId,
      executionServerId: fx.serverId,
      endpointGeneration: 7,
    });
    expect(await redeemRemoteDesktopShellLaunchContext({
      db,
      accountSession: fx.nativeSession,
      context,
      dispatcher: channel.adapter,
      now: NOW + 2,
      onRedeemedTx: async () => 'replayed',
    })).toBeNull();
  });

  it('consumes launch context atomically with signed-shell privacy begin', async () => {
    const fx = await fixture();
    const channel = dispatcher({ serverId: fx.serverId, endpointGeneration: 7 });
    await issue(fx, channel.adapter);
    const context = channel.captured[0]!;
    const redeemed = await redeemRemoteDesktopShellLaunchContext({
      db,
      accountSession: fx.nativeSession,
      context,
      dispatcher: channel.adapter,
      now: NOW + 1,
      onRedeemedTx: (tx, binding) => beginPrivacyEpochTx(tx, {
        hostId: binding.hostId,
        epochId: randomUUID(),
        presentationSource: REMOTE_DESKTOP_PRESENTATION_SOURCE.SIGNED_SHELL,
        initiatingSessionHash: 'native-session-hash',
        executionServerId: binding.executionServerId,
        daemonGeneration: binding.endpointGeneration,
        leaseExpiresAt: NOW + 300_000,
        deadline: NOW + 60_000,
        now: NOW + 1,
      }),
    });
    expect(redeemed?.result.phase).toBe('active');
    expect(await getPrivacyState(db, fx.hostId)).toMatchObject({
      presentationSource: REMOTE_DESKTOP_PRESENTATION_SOURCE.SIGNED_SHELL,
      admissionOpen: false,
    });
    expect(await redeemRemoteDesktopShellLaunchContext({
      db,
      accountSession: fx.nativeSession,
      context,
      dispatcher: channel.adapter,
      now: NOW + 2,
      onRedeemedTx: async () => 'replay',
    })).toBeNull();
  });

  it('does not burn launch context when privacy begin rolls back', async () => {
    const fx = await fixture();
    const channel = dispatcher({ serverId: fx.serverId, endpointGeneration: 9 });
    await issue(fx, channel.adapter);
    const context = channel.captured[0]!;
    await beginPrivacyEpoch(db, {
      hostId: fx.hostId,
      epochId: randomUUID(),
      presentationSource: REMOTE_DESKTOP_PRESENTATION_SOURCE.MANAGEMENT_WEB,
      initiatingSessionHash: 'other-session',
      executionServerId: fx.serverId,
      daemonGeneration: null,
      leaseExpiresAt: NOW + 300_000,
      deadline: NOW + 60_000,
      now: NOW + 1,
    });
    await expect(redeemRemoteDesktopShellLaunchContext({
      db,
      accountSession: fx.nativeSession,
      context,
      dispatcher: channel.adapter,
      now: NOW + 2,
      onRedeemedTx: (tx, binding) => beginPrivacyEpochTx(tx, {
        hostId: binding.hostId,
        epochId: randomUUID(),
        presentationSource: REMOTE_DESKTOP_PRESENTATION_SOURCE.SIGNED_SHELL,
        initiatingSessionHash: 'native-session',
        executionServerId: binding.executionServerId,
        daemonGeneration: binding.endpointGeneration,
        leaseExpiresAt: NOW + 300_000,
        deadline: NOW + 60_000,
        now: NOW + 2,
      }),
    })).rejects.toThrow('epoch_busy');
    expect(await db.queryOne<{ redeemed_at: number | null }>(
      'SELECT redeemed_at FROM remote_desktop_shell_launch_contexts WHERE context_hash = $1',
      [hashRemoteDesktopShellLaunchContext(context)],
    )).toEqual({ redeemed_at: null });
  });

  it('rejects expiry and any TTL above the shared 60-second maximum', async () => {
    const fx = await fixture();
    const channel = dispatcher({ serverId: fx.serverId, endpointGeneration: 2 });
    expect(await issue(fx, channel.adapter, 60_001)).toBeNull();
    expect(channel.captured).toHaveLength(0);
    expect(await issue(fx, channel.adapter, 10)).not.toBeNull();
    const context = channel.captured[0]!;
    expect(await redeemRemoteDesktopShellLaunchContext({
      db,
      accountSession: fx.nativeSession,
      context,
      dispatcher: channel.adapter,
      now: NOW + 10,
      onRedeemedTx: async () => true,
    })).toBeNull();
  });

  it('rejects cross-owner, cross-host, cross-session and browser account sessions', async () => {
    const fx = await fixture();
    const channel = dispatcher({ serverId: fx.serverId, endpointGeneration: 3 });
    await issue(fx, channel.adapter);
    const context = channel.captured[0]!;
    const attempt = (accountSession: AccountSession, candidate: unknown) => (
      redeemRemoteDesktopShellLaunchContext({
        db,
        accountSession,
        context: candidate,
        dispatcher: channel.adapter,
        now: NOW + 1,
        onRedeemedTx: async () => true,
      })
    );
    await expect(attempt(fx.otherNativeSession, context)).resolves.toBeNull();
    await expect(attempt(fx.sameOwnerOtherSession, context)).resolves.toBeNull();
    await expect(attempt({ kind: 'web', id: 'web-session', userId: fx.ownerUserId }, context))
      .resolves.toBeNull();
    await expect(attempt(fx.nativeSession, { ...context, hostId: fx.otherHostId }))
      .resolves.toBeNull();
    await expect(attempt(fx.nativeSession, { ...context, password: 'must-not-travel' }))
      .resolves.toBeNull();
    // Failed mismatched attempts do not burn the rightful one-shot context.
    await expect(attempt(fx.nativeSession, context)).resolves.not.toBeNull();
  });

  it('rechecks endpoint identity and daemon generation before redemption', async () => {
    const fx = await fixture();
    const channel = dispatcher({ serverId: fx.serverId, endpointGeneration: 4 });
    await issue(fx, channel.adapter);
    const staleGenerationContext = channel.captured[0]!;
    channel.setCurrent({ serverId: fx.serverId, endpointGeneration: 5 });
    expect(await redeemRemoteDesktopShellLaunchContext({
      db, accountSession: fx.nativeSession, context: staleGenerationContext,
      dispatcher: channel.adapter, now: NOW + 1, onRedeemedTx: async () => true,
    })).toBeNull();

    channel.setCurrent({ serverId: fx.serverId, endpointGeneration: 4 });
    expect(await redeemRemoteDesktopShellLaunchContext({
      db, accountSession: fx.nativeSession, context: staleGenerationContext,
      dispatcher: channel.adapter, now: NOW + 2, onRedeemedTx: async () => true,
    })).not.toBeNull();

    const replacement = dispatcher({ serverId: fx.serverId, endpointGeneration: 8 });
    await issue(fx, replacement.adapter);
    const replacementContext = replacement.captured[0]!;
    replacement.setCurrent({ serverId: fx.otherServerId, endpointGeneration: 8 });
    expect(await redeemRemoteDesktopShellLaunchContext({
      db, accountSession: fx.nativeSession, context: replacementContext,
      dispatcher: replacement.adapter, now: NOW + 1, onRedeemedTx: async () => true,
    })).toBeNull();
  });

  it('rolls one-use consumption back when the transaction callback fails', async () => {
    const fx = await fixture();
    const channel = dispatcher({ serverId: fx.serverId, endpointGeneration: 9 });
    await issue(fx, channel.adapter);
    const context = channel.captured[0]!;
    await expect(redeemRemoteDesktopShellLaunchContext({
      db,
      accountSession: fx.nativeSession,
      context,
      dispatcher: channel.adapter,
      now: NOW + 1,
      onRedeemedTx: async () => { throw new Error('rollback-me'); },
    })).rejects.toThrow('rollback-me');
    const stored = await db.queryOne<{ redeemed_at: number | null }>(
      'SELECT redeemed_at FROM remote_desktop_shell_launch_contexts WHERE context_hash = $1',
      [hashRemoteDesktopShellLaunchContext(context)],
    );
    expect(stored?.redeemed_at).toBeNull();
    expect(await redeemRemoteDesktopShellLaunchContext({
      db,
      accountSession: fx.nativeSession,
      context,
      dispatcher: channel.adapter,
      now: NOW + 2,
      onRedeemedTx: async () => 'committed',
    })).toMatchObject({ result: 'committed' });
  });

  it('rechecks native session revocation and invalidates failed dispatch', async () => {
    const fx = await fixture();
    const channel = dispatcher({ serverId: fx.serverId, endpointGeneration: 10 });
    await issue(fx, channel.adapter);
    const context = channel.captured[0]!;
    await db.execute(
      'UPDATE remote_desktop_native_sessions SET revoked_at = $2 WHERE id = $1',
      [fx.nativeSession.id, NOW + 1],
    );
    expect(await redeemRemoteDesktopShellLaunchContext({
      db, accountSession: fx.nativeSession, context, dispatcher: channel.adapter,
      now: NOW + 2, onRedeemedTx: async () => true,
    })).toBeNull();

    const fresh = await fixture();
    const failed = dispatcher({ serverId: fresh.serverId, endpointGeneration: 11 });
    failed.setDispatchResult(false);
    expect(await issue(fresh, failed.adapter)).toBeNull();
    const failedContext = failed.captured[0]!;
    const row = await db.queryOne<{ invalidated_at: number | null }>(
      'SELECT invalidated_at FROM remote_desktop_shell_launch_contexts WHERE context_hash = $1',
      [hashRemoteDesktopShellLaunchContext(failedContext)],
    );
    expect(row?.invalidated_at).not.toBeNull();
    expect(row?.invalidated_at).toBe(NOW);
    expect(await redeemRemoteDesktopShellLaunchContext({
      db, accountSession: fresh.nativeSession, context: failedContext,
      dispatcher: failed.adapter, now: NOW + 1, onRedeemedTx: async () => true,
    })).toBeNull();
  });

  it('lets PostgreSQL reject endpoint/time values outside the JS safe-integer domain', async () => {
    const fx = await fixture();
    const contextHash = 'f'.repeat(64);
    await expect(db.execute(
      `INSERT INTO remote_desktop_shell_launch_contexts
         (context_hash, owner_user_id, native_session_id, host_id,
          execution_server_id, endpoint_generation, issued_at, expires_at, created_at)
       VALUES ($1, $2, $3, $4, $5, 9007199254740992, $6, $7, $6)`,
      [contextHash, fx.ownerUserId, fx.nativeSession.id, fx.hostId, fx.serverId, NOW, NOW + 1],
    )).rejects.toThrow();
    await expect(db.execute(
      `INSERT INTO remote_desktop_shell_launch_contexts
         (context_hash, owner_user_id, native_session_id, host_id,
          execution_server_id, endpoint_generation, issued_at, expires_at, created_at)
       VALUES ($1, $2, $3, $4, $5, 1, -1, 1, 0)`,
      ['e'.repeat(64), fx.ownerUserId, fx.nativeSession.id, fx.hostId, fx.serverId],
    )).rejects.toThrow();
  });
});
