import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type WebSocket from 'ws';
import { createDatabase, type Database } from '../src/db/client.js';
import { runMigrations } from '../src/db/migrate.js';
import { createUser } from '../src/db/queries.js';
import { RemoteDesktopRouter } from '../src/ws/remote-desktop-router.js';
import {
  acknowledgeShield,
  beginPrivacyEpoch,
  getHostRoutesTx,
  getPrivacyState,
  setRemoteDesktopManagementPrivacyDispatcher,
} from '../src/services/remote-desktop-management-privacy.js';
import {
  REMOTE_DESKTOP_ACCESS_MODE,
  REMOTE_DESKTOP_CAPABILITY,
  REMOTE_DESKTOP_MSG,
  REMOTE_DESKTOP_PROTOCOL_VERSION,
  REMOTE_DESKTOP_STOP_ORIGIN,
} from '../../shared/remote-desktop.js';
import {
  REMOTE_DESKTOP_PRESENTATION_SOURCE,
  REMOTE_DESKTOP_PRIVACY_PHASE,
} from '../../shared/remote-desktop-access.js';
import { NODE_ROLE } from '../../shared/remote-exec.js';

let db: Database;
const NOW = 1_700_000_000_000;

beforeAll(async () => {
  db = createDatabase(process.env.TEST_DATABASE_URL!);
  await runMigrations(db);
});
afterAll(async () => {
  setRemoteDesktopManagementPrivacyDispatcher(null);
  await db.close();
});

describe('remote desktop route-generation churn under privacy', () => {
  it('keeps replacement PREPARE quarantined until the exact new snapshot ACK', async () => {
    const ownerId = `owner-${randomUUID()}`;
    const serverId = `server-${randomUUID()}`;
    const hostId = randomUUID();
    await createUser(db, ownerId);
    await db.execute(
      `INSERT INTO servers (id, user_id, name, token_hash, status, last_heartbeat_at, created_at)
       VALUES ($1, $2, 'route churn', 'hash', 'online', $3, $3)`,
      [serverId, ownerId, NOW],
    );
    await db.execute(
      `INSERT INTO remote_desktop_hosts (id, owner_user_id, merge_state, created_at, updated_at)
       VALUES ($1, $2, 'resolved', $3, $3)`,
      [hostId, ownerId, NOW],
    );
    await db.execute(
      `INSERT INTO remote_desktop_host_endpoints
         (server_id, host_id, owner_user_id, endpoint_role, linked_at)
       VALUES ($1, $2, $3, 'controlled', $4)`,
      [serverId, hostId, ownerId, NOW],
    );

    let daemonGeneration = 7;
    const browser = {} as WebSocket;
    const browserMessages: Record<string, unknown>[] = [];
    const daemonMessages: Record<string, unknown>[] = [];
    const router = new RemoteDesktopRouter({
      serverId: () => serverId,
      database: () => db,
      daemonAvailable: () => true,
      daemonSupportsRemoteDesktop: () => true,
      supportsDefaultShieldedRoute: () => true,
      daemonGeneration: () => daemonGeneration,
      iceServers: () => ({ iceServers: ['stun:route-churn.test'] }),
      sendDaemon: (message, expected) => {
        if (expected !== daemonGeneration) return false;
        daemonMessages.push(message);
        return true;
      },
      sendBrowser: (_socket, message) => { browserMessages.push(message); },
      resolveAccess: async () => ({
        id: serverId,
        user_id: ownerId,
        node_role: NODE_ROLE.CONTROLLED,
        exec_enabled: true,
        os: 'win',
        controlled_capabilities: [REMOTE_DESKTOP_CAPABILITY],
        status: 'online',
        last_heartbeat_at: Date.now(),
        access_role: 'owner',
        access_expires_at: null,
      }),
    });
    const requestId = 'route_churn_request_0001';
    await router.handleBrowser(browser, ownerId, {
      type: REMOTE_DESKTOP_MSG.START,
      protocolVersion: REMOTE_DESKTOP_PROTOCOL_VERSION,
      requestId,
    });
    const initialPrepare = daemonMessages.find((message) => message.type === REMOTE_DESKTOP_MSG.PREPARE)!;
    const sessionId = String(initialPrepare.sessionId);
    const initialRouteGeneration = Number(initialPrepare.routeGeneration);
    expect(initialRouteGeneration).not.toBe(daemonGeneration);

    const epochId = randomUUID();
    const begun = await beginPrivacyEpoch(db, {
      hostId,
      epochId,
      presentationSource: REMOTE_DESKTOP_PRESENTATION_SOURCE.SIGNED_SHELL,
      initiatingSessionHash: 'session-hash',
      executionServerId: serverId,
      daemonGeneration,
      leaseExpiresAt: NOW + 60_000,
      deadline: NOW + 30_000,
      now: NOW,
    });
    await acknowledgeShield(db, {
      hostId, epochId, revision: begun.revision, executionServerId: serverId,
      daemonGeneration, workerGeneration: 10,
      acknowledgedRoutes: begun.shieldedActive, now: NOW,
    });

    browserMessages.length = 0;
    daemonGeneration = 8;
    router.setDaemonGeneration(daemonGeneration);
    const reconciling = router.reconcileDaemonReplacement(daemonGeneration);
    let replacementPrepare: Record<string, unknown> | undefined;
    for (let attempt = 0; attempt < 80 && !replacementPrepare; attempt += 1) {
      replacementPrepare = daemonMessages.find((message) => (
        message.type === REMOTE_DESKTOP_MSG.PREPARE
        && message.daemonGeneration === daemonGeneration
      ));
      if (!replacementPrepare) await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(replacementPrepare).toMatchObject({
      type: REMOTE_DESKTOP_MSG.PREPARE,
      sessionId,
      daemonGeneration,
    });
    expect(replacementPrepare!.routeGeneration).not.toBe(initialRouteGeneration);
    expect(browserMessages).toEqual([]);

    const starting = await getPrivacyState(db, hostId);
    expect(starting?.phase).toBe(REMOTE_DESKTOP_PRIVACY_PHASE.STARTING);
    expect(starting?.routeSnapshot).toEqual([{
      routeId: sessionId,
      routeGeneration: replacementPrepare!.routeGeneration,
    }]);
    await acknowledgeShield(db, {
      hostId, epochId, revision: starting!.revision, executionServerId: serverId,
      daemonGeneration, workerGeneration: 11,
      acknowledgedRoutes: starting!.routeSnapshot, now: NOW + 1,
    });
    await expect(reconciling).resolves.toBe(1);
    expect(browserMessages).toContainEqual(expect.objectContaining({
      type: REMOTE_DESKTOP_MSG.AUTHORIZED,
      sessionId,
      daemonGeneration,
    }));
    const rows = await getHostRoutesTx(db, hostId);
    expect(rows.find((row) => row.routeGeneration === initialRouteGeneration)?.state).toBe('closed');
    expect(rows.find((row) => row.routeGeneration === replacementPrepare!.routeGeneration)?.state).toBe('active');

    await router.handleBrowser(browser, ownerId, {
      type: REMOTE_DESKTOP_MSG.STOP,
      requestId,
      sessionId,
      capability: String(replacementPrepare!.capability),
      stopOrigin: REMOTE_DESKTOP_STOP_ORIGIN.USER_CLOSE,
    });
  });
});
