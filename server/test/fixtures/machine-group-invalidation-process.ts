import { serve } from '@hono/node-server';
import { createDatabase } from '../../src/db/client.js';
import { buildApp, setupWebSocketUpgrade } from '../../src/index.js';
import { MachineGroupInvalidationRuntime } from '../../src/services/machine-group-invalidation.js';
import { applyMachineGroupInvalidation, failClosedMachineGroupConnections } from '../../src/ws/machine-group-revalidation.js';
import { GROUP_TEST_IPC as IPC } from './machine-group-invalidation-control.js';
import type { Env } from '../../src/env.js';

const db = createDatabase(process.env.TEST_DATABASE_URL!);
let heldActor: string | null = null;
let release: (() => void) | null = null;
const query = db.query.bind(db);
db.query = async <T>(sql: string, parameters: unknown[] = []): Promise<T[]> => {
  const rows = await query<T>(sql, parameters);
  // Actual PG permission snapshot; only its completion is delayed to exercise the epoch fence.
  if (heldActor && sql.includes('SELECT DISTINCT actor.id AS actor_id') &&
      Array.isArray(parameters[1]) && parameters[1].includes(heldActor)) {
    heldActor = null;
    await new Promise<void>((resolve) => { release = resolve; process.send?.({ type: IPC.HELD }); });
  }
  return rows;
};
const runtime = new MachineGroupInvalidationRuntime(db,
  scope => applyMachineGroupInvalidation(db, scope), failClosedMachineGroupConnections,
  process.env.TEST_GROUP_LISTEN === '0' ? undefined : process.env.TEST_DATABASE_URL,
  () => process.send?.({ type: IPC.ERROR }));
await runtime.start();
const env = { DATABASE_URL: process.env.TEST_DATABASE_URL!, JWT_SIGNING_KEY: process.env.TEST_GROUP_KEY!,
  DB: db, BOT_ENCRYPTION_KEY: process.env.TEST_GROUP_KEY!, SERVER_URL: 'http://127.0.0.1',
  ALLOWED_ORIGINS: 'http://127.0.0.1', NODE_ENV: 'development' } as Env;
const app = buildApp(env);
const http = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 });
setupWebSocketUpgrade(http, env);
if (!http.listening) await new Promise<void>(resolve => http.once('listening', resolve));
process.on('message', (message: { type: string; actor?: string }) => {
  if (message.type === IPC.ARM) { heldActor = message.actor!; process.send?.({ type: IPC.ARM }); }
  if (message.type === IPC.RELEASE) { release?.(); release = null; }
  if (message.type === IPC.STOP) {
    release?.();
    void (async () => { await runtime.stop(); http.close(); await db.close(); process.exit(0); })();
  }
});
const address = http.address();
process.send?.({ type: IPC.READY, port: typeof address === 'object' && address ? address.port : null, receiverId: runtime.receiverId });
