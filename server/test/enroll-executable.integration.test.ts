/**
 * GET /api/enroll/executable — prebuilt binary + appended enrollment blob (7.4).
 * Real PostgreSQL; a fake prebuilt binary stands in for the SEA artifact.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Hono } from 'hono';
import { randomBytes, createHash } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDatabase, type Database } from '../src/db/client.js';
import { runMigrations } from '../src/db/migrate.js';
import { createUser, createServer } from '../src/db/queries.js';
import { enrollRoutes } from '../src/routes/enroll.js';
import { decodeEnrollmentTrailer } from '../../shared/remote-exec.js';

let db: Database;
let exeDir: string;
const hex = (n: number) => randomBytes(n).toString('hex');
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const FAKE_BINARY = Buffer.concat([Buffer.from('FAKE-SEA-BINARY'), randomBytes(2048)]);

beforeAll(async () => {
  db = createDatabase(process.env.TEST_DATABASE_URL!);
  await runMigrations(db);
  exeDir = await mkdtemp(join(tmpdir(), 'imcodes-exe-'));
  await writeFile(join(exeDir, 'imcodes-node-linux'), FAKE_BINARY);
  process.env.IMCODES_NODE_EXE_DIR = exeDir;
});
afterAll(async () => { await rm(exeDir, { recursive: true, force: true }); delete process.env.IMCODES_NODE_EXE_DIR; await db.close(); });

function buildApp() {
  const app = new Hono();
  app.use('*', async (c, next) => { (c as unknown as { env: { DB: Database } }).env = { DB: db }; await next(); });
  app.route('/api/enroll', enrollRoutes);
  return app;
}
async function owner(userId: string) {
  const token = hex(16); const serverId = hex(8);
  await createServer(db, serverId, userId, 'full', sha256(token));
  return { serverId, token };
}

describe('GET /api/enroll/executable', () => {
  it('streams the prebuilt binary with an appended, decodable enrollment blob', async () => {
    const app = buildApp(); const u = `u_${hex(4)}`; await createUser(db, u);
    const o = await owner(u);
    const res = await app.request('/api/enroll/executable?os=linux', { headers: { 'X-Server-Id': o.serverId, authorization: `Bearer ${o.token}` } });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/octet-stream');
    const body = Buffer.from(await res.arrayBuffer());
    // Prebuilt binary is intact at the head.
    expect(body.subarray(0, FAKE_BINARY.length).equals(FAKE_BINARY)).toBe(true);
    // Trailer decodes back to a usable blob.
    const blob = decodeEnrollmentTrailer(body.subarray(body.length - 64 * 1024));
    expect(blob).not.toBeNull();
    expect(blob!.enrollToken).toBeTruthy();
    // The minted code exists.
    const row = await db.queryOne<{ code: string }>('SELECT code FROM enrollment_codes WHERE code = $1', [blob!.enrollToken]);
    expect(row?.code).toBe(blob!.enrollToken);
  });

  it('rejects an invalid os (400)', async () => {
    const app = buildApp(); const u = `u_${hex(4)}`; await createUser(db, u); const o = await owner(u);
    const res = await app.request('/api/enroll/executable?os=solaris', { headers: { 'X-Server-Id': o.serverId, authorization: `Bearer ${o.token}` } });
    expect(res.status).toBe(400);
  });

  it('503 when the prebuilt binary for the OS is not present', async () => {
    const app = buildApp(); const u = `u_${hex(4)}`; await createUser(db, u); const o = await owner(u);
    const res = await app.request('/api/enroll/executable?os=win', { headers: { 'X-Server-Id': o.serverId, authorization: `Bearer ${o.token}` } });
    expect(res.status).toBe(503); // only the linux fake exists
  });
});
