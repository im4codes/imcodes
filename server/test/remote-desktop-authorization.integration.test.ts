import { createHash, randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type WebSocket from 'ws';
import { REMOTE_DESKTOP_CAPABILITY, REMOTE_DESKTOP_MSG, REMOTE_DESKTOP_PROTOCOL_VERSION, REMOTE_DESKTOP_TERMINAL_REASON } from '../../shared/remote-desktop.js';
import { NODE_ROLE } from '../../shared/remote-exec.js';
import { createDatabase, type Database } from '../src/db/client.js';
import { runMigrations } from '../src/db/migrate.js';
import { createUser } from '../src/db/queries.js';
import { ensureCanonicalHostForServer } from '../src/services/remote-desktop-host-identity.js';
import { createOrUpdateShare } from '../src/db/tab-sharing.js';
import { RemoteDesktopRouter } from '../src/ws/remote-desktop-router.js';

const hex = (bytes: number) => randomBytes(bytes).toString('hex');
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
let db: Database;

beforeAll(async () => {
  db = createDatabase(process.env.TEST_DATABASE_URL!);
  await runMigrations(db);
});

afterAll(async () => { await db.close(); });

async function createControlledNode(ownerId: string): Promise<string> {
  const serverId = `rd-ctl-${hex(6)}`;
  await db.execute(
    `INSERT INTO servers
       (id, user_id, name, token_hash, status, created_at, last_heartbeat_at,
        node_role, exec_enabled, revoked_at, ref_name, display_name, os,
        controlled_capabilities)
     VALUES ($1,$2,'remote-desktop',$3,'online',$4,$4,$5,true,NULL,$6,
             'Remote desktop test','win',$7::jsonb)`,
    [
      serverId,
      ownerId,
      sha256(hex(16)),
      Date.now(),
      NODE_ROLE.CONTROLLED,
      `rd-ref-${hex(4)}`,
      JSON.stringify([REMOTE_DESKTOP_CAPABILITY]),
    ],
  );
  await ensureCanonicalHostForServer({ db, serverId, now: Date.now() });
  return serverId;
}

async function grant(
  ownerId: string,
  recipientId: string,
  serverId: string,
  role: 'viewer' | 'participant',
  expiresAt: number | null = null,
) {
  return createOrUpdateShare(db, {
    id: `rd-share-${hex(8)}`,
    target: { kind: 'server', serverId },
    targetUserId: recipientId,
    role,
    createdBy: ownerId,
    expiresAt,
    now: Date.now(),
  });
}

function fixture(serverId: string) {
  const daemonMessages: Array<Record<string, unknown>> = [];
  const browserMessages = new Map<WebSocket, Array<Record<string, unknown>>>();
  const router = new RemoteDesktopRouter({
    serverId: () => serverId,
    database: () => db,
    daemonAvailable: () => true,
    daemonSupportsRemoteDesktop: () => true,
    featureEnabled: () => true,
    daemonGeneration: () => 7,
    iceServers: () => ({ iceServers: [] }),
    sendDaemon: (message, generation) => {
      if (generation !== 7) return false;
      daemonMessages.push(message);
      return true;
    },
    sendBrowser: (socket, message) => {
      const current = browserMessages.get(socket) ?? [];
      current.push(message);
      browserMessages.set(socket, current);
    },
  });
  return {
    router,
    daemonMessages,
    messages: (socket: WebSocket) => browserMessages.get(socket) ?? [],
  };
}

async function start(
  f: ReturnType<typeof fixture>,
  userId: string,
  socket: WebSocket,
): Promise<Record<string, unknown>> {
  const requestId = `request-${hex(12)}`;
  await f.router.handleBrowser(socket, userId, {
    type: REMOTE_DESKTOP_MSG.START,
    protocolVersion: REMOTE_DESKTOP_PROTOCOL_VERSION,
    requestId,
  });
  return f.messages(socket).at(-1)!;
}

describe('remote desktop real-PostgreSQL authorization and teardown', () => {
  it('fails active Participant sessions closed after committed downgrade and expiry', async () => {
    const ownerId = `rd-owner-${hex(5)}`;
    const participantId = `rd-participant-${hex(5)}`;
    await Promise.all([createUser(db, ownerId), createUser(db, participantId)]);
    const serverId = await createControlledNode(ownerId);
    const share = await grant(ownerId, participantId, serverId, 'participant');
    const f = fixture(serverId);

    const firstSocket = {} as WebSocket;
    expect(await start(f, participantId, firstSocket)).toMatchObject({
      type: REMOTE_DESKTOP_MSG.AUTHORIZED,
    });
    await grant(ownerId, participantId, serverId, 'viewer');
    await f.router.revalidateUser(participantId);
    expect(f.router.stats().active).toBe(0);
    expect(f.daemonMessages.at(-1)).toMatchObject({ type: REMOTE_DESKTOP_MSG.STOP });
    expect(f.messages(firstSocket).at(-1)).toMatchObject({
      type: REMOTE_DESKTOP_MSG.TERMINAL,
      reason: REMOTE_DESKTOP_TERMINAL_REASON.AUTHORITY_REVOKED,
    });

    await grant(ownerId, participantId, serverId, 'participant', Date.now() + 60_000);
    const secondSocket = {} as WebSocket;
    expect(await start(f, participantId, secondSocket)).toMatchObject({
      type: REMOTE_DESKTOP_MSG.AUTHORIZED,
    });
    await db.execute('UPDATE server_shares SET expires_at = $2 WHERE id = $1', [share.id, Date.now() - 1]);
    await f.router.revalidateUser(participantId);
    expect(f.router.stats().active).toBe(0);
    expect(f.messages(secondSocket).at(-1)).toMatchObject({
      type: REMOTE_DESKTOP_MSG.TERMINAL,
      reason: REMOTE_DESKTOP_TERMINAL_REASON.AUTHORITY_REVOKED,
    });
  });

  it('revalidates execution disable and node revoke against the real row predicates', async () => {
    const ownerId = `rd-owner-${hex(5)}`;
    await createUser(db, ownerId);
    const serverId = await createControlledNode(ownerId);
    const f = fixture(serverId);

    const execSocket = {} as WebSocket;
    expect(await start(f, ownerId, execSocket)).toMatchObject({ type: REMOTE_DESKTOP_MSG.AUTHORIZED });
    await db.execute('UPDATE servers SET exec_enabled = false WHERE id = $1', [serverId]);
    await f.router.revalidateUser(ownerId);
    expect(f.messages(execSocket).at(-1)).toMatchObject({
      type: REMOTE_DESKTOP_MSG.TERMINAL,
      reason: REMOTE_DESKTOP_TERMINAL_REASON.EXECUTION_DISABLED,
    });

    await db.execute('UPDATE servers SET exec_enabled = true WHERE id = $1', [serverId]);
    const revokedSocket = {} as WebSocket;
    expect(await start(f, ownerId, revokedSocket)).toMatchObject({ type: REMOTE_DESKTOP_MSG.AUTHORIZED });
    await db.execute('UPDATE servers SET revoked_at = $2 WHERE id = $1', [serverId, Date.now()]);
    await f.router.revalidateUser(ownerId);
    expect(f.messages(revokedSocket).at(-1)).toMatchObject({
      type: REMOTE_DESKTOP_MSG.TERMINAL,
      reason: REMOTE_DESKTOP_TERMINAL_REASON.AUTHORITY_REVOKED,
    });
  });

  it('serializes concurrent real-DB starts and isolates an unrelated user', async () => {
    const ownerId = `rd-owner-${hex(5)}`;
    const outsiderId = `rd-outsider-${hex(5)}`;
    await Promise.all([createUser(db, ownerId), createUser(db, outsiderId)]);
    const serverId = await createControlledNode(ownerId);
    const f = fixture(serverId);
    const ownerSockets = [{}, {}, {}] as WebSocket[];
    const outsiderSocket = {} as WebSocket;

    const [one, two, three, outsider] = await Promise.all([
      start(f, ownerId, ownerSockets[0]!),
      start(f, ownerId, ownerSockets[1]!),
      start(f, ownerId, ownerSockets[2]!),
      start(f, outsiderId, outsiderSocket),
    ]);
    expect([one, two, three].filter((message) => (
      message.type === REMOTE_DESKTOP_MSG.AUTHORIZED
    ))).toHaveLength(2);
    expect([one, two, three].filter((message) => (
      message.type === REMOTE_DESKTOP_MSG.ERROR
    ))).toHaveLength(1);
    expect(outsider).toMatchObject({ type: REMOTE_DESKTOP_MSG.ERROR });
    expect(f.router.stats().active).toBe(2);
  });
});
