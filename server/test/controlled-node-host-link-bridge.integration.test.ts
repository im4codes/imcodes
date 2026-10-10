/**
 * A controlled node's report of the daemons bound on its computer, through the
 * real Bridge allowlist and a real database: accepted exactly-shaped, turned
 * into a link, and dropped when it carries anything else.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { createDatabase, type Database } from '../src/db/client.js';
import { runMigrations } from '../src/db/migrate.js';
import { createServer, createUser } from '../src/db/queries.js';
import { WsBridge } from '../src/ws/bridge.js';
import { generateControlledNodeId } from '../src/services/controlled-node-identity.js';
import { DAEMON_MSG } from '../../shared/daemon-events.js';
import { NODE_ROLE } from '../../shared/remote-exec.js';

const hex = (bytes: number) => randomBytes(bytes).toString('hex');
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
let db: Database;

class NodeSocket extends EventEmitter {
  readyState = 1;
  send(_data: string | Buffer, _options?: unknown, callback?: (error?: Error) => void): void { callback?.(); }
  close(): void { this.readyState = 3; this.emit('close'); }
}

async function waitFor(predicate: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('condition_timeout');
}

async function hostOf(serverId: string): Promise<string | null> {
  const row = await db.queryOne<{ host_server_id: string | null }>(
    'SELECT host_server_id FROM servers WHERE id = $1',
    [serverId],
  );
  return row?.host_server_id ?? null;
}

beforeAll(async () => {
  db = createDatabase(process.env.TEST_DATABASE_URL!);
  await runMigrations(db);
}, 30_000);

afterAll(async () => { await db.close(); });

describe('controlled node local-daemons report through the Bridge', () => {
  it('links the node to the daemon it reports, and drops a report with anything extra', async () => {
    const userId = `user-${hex(6)}`;
    await createUser(db, userId);
    const daemonId = `full-${hex(6)}`;
    await createServer(db, daemonId, userId, 'daemon', sha256(hex(16)));
    const nodeId = `ctl-${hex(6)}`;
    const token = hex(16);
    await db.execute(
      `INSERT INTO servers (id, user_id, name, token_hash, status, created_at, node_role, exec_enabled, ref_name, display_name, os, node_id)
       VALUES ($1,$2,'controlled',$3,'online',$4,$5,true,$6,'Linux Node','linux',$7)`,
      [nodeId, userId, sha256(token), Date.now(), NODE_ROLE.CONTROLLED, `ref-${hex(4)}`, generateControlledNodeId()],
    );

    const bridge = WsBridge.get(nodeId);
    const socket = new NodeSocket();
    bridge.handleDaemonConnection(socket as never, db, {} as never);
    socket.emit('message', Buffer.from(JSON.stringify({ type: 'auth', serverId: nodeId, token })), false);
    await waitFor(() => bridge.isDaemonConnected());

    try {
      const dropped = WsBridge.controlledInboundDropped;
      socket.emit('message', Buffer.from(JSON.stringify({
        type: DAEMON_MSG.CONTROLLED_NODE_LOCAL_DAEMONS,
        serverIds: [daemonId],
        token: 'never-forwarded',
      })), false);
      await waitFor(() => WsBridge.controlledInboundDropped === dropped + 1);
      expect(await hostOf(nodeId)).toBeNull();

      socket.emit('message', Buffer.from(JSON.stringify({
        type: DAEMON_MSG.CONTROLLED_NODE_LOCAL_DAEMONS,
        serverIds: [daemonId],
      })), false);
      await waitFor(async () => (await hostOf(nodeId)) === daemonId);
      expect(WsBridge.controlledInboundDropped).toBe(dropped + 1);
    } finally {
      socket.close();
    }
  });
});
