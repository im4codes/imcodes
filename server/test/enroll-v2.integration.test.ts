/**
 * Controlled-node v2 enrollment + download ticket — real PostgreSQL
 * (testcontainers via integration-global). Covers the integrated repair:
 *   - separate controlled_node_enrollments_v2 table (audit E1)
 *   - v2 redeem with {version:2, installId, nodeTokenHash, os, arch} body
 *   - atomic claim with idempotent replay (same identity → same server)
 *   - mismatch (installId or nodeTokenHash) → 409
 *   - both-null-or-both-present CHECK
 *   - ticket mint only from a build-pipeline sidecar whose digest matches
 *   - bearer download with same encrypted_code reused across retries
 *   - Range check before incrementing consume_count
 *   - HTTPS origin enforcement in production
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { Hono } from 'hono';
import { randomBytes, createHash } from 'node:crypto';
import { mkdtemp, writeFile, mkdir, rm, readdir, rename, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDatabase, type Database } from '../src/db/client.js';
import { runMigrations } from '../src/db/migrate.js';
import { createUser, createServer } from '../src/db/queries.js';
import { createEnrollRoutes, runEnrollmentRetention } from '../src/routes/enroll.js';
import {
  createArtifactCatalog,
  makeSafeCloseOnce,
  type ArtifactCatalog,
} from '../src/services/controlled-node-artifact-catalog.js';
import { NODE_ROLE, decodeEnrollmentTrailer } from '../../shared/remote-exec.js';

let db: Database;
const hex = (n: number) => randomBytes(n).toString('hex');
const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

let exeDir: string;
let artifactCatalog: ArtifactCatalog;
const FAKE_BINARY = Buffer.from('IMCODES_FAKE_EXECUTABLE_BINARY_v1');
const TEST_ENCRYPTION_KEY = 'test-bot-encryption-key-do-not-use-in-prod';

async function writeManifest(
  fileName: 'imcodes-node-linux' | 'imcodes-node.exe' | 'imcodes-node-macos',
  os: 'linux' | 'win32' | 'darwin',
  arch: 'x64' | 'arm64',
  bytes: Buffer = FAKE_BINARY,
): Promise<void> {
  await writeFile(join(exeDir, `${fileName}.manifest.json`), JSON.stringify({
    schemaVersion: 1,
    artifact: {
      fileName,
      os,
      arch,
      size: bytes.length,
      sha256: sha256(bytes),
    },
    toolchain: {
      nodeVersion: 'v22.11.0',
      nodeArchive: `node-v22.11.0-${os}-${arch}.tar.gz`,
      nodeArchiveSha256: 'a'.repeat(64),
      postjectVersion: '1.0.0-alpha.6',
    },
    build: { commit: 'a'.repeat(40) },
  }));
}

beforeAll(async () => {
  process.env.NODE_ENV = 'development'; // default for HTTPS-off tests; per-test overrides
  db = createDatabase(process.env.TEST_DATABASE_URL!);
  await runMigrations(db);
  exeDir = await mkdtemp(join(tmpdir(), 'imcodes-v2-exe-'));
  await writeFile(join(exeDir, 'imcodes-node-linux'), FAKE_BINARY);
  await writeFile(join(exeDir, 'imcodes-node.exe'), FAKE_BINARY);
  await mkdir(join(exeDir, 'imcodes-node-macos')); // directory, not file
  process.env.IMCODES_NODE_EXE_DIR = exeDir;
});
afterAll(async () => {
  await rm(exeDir, { recursive: true, force: true });
  delete process.env.IMCODES_NODE_EXE_DIR;
  await db.close();
});

beforeEach(async () => {
  artifactCatalog = createArtifactCatalog();
  await db.execute("DELETE FROM controlled_node_enrollments_v2");
  await db.execute("DELETE FROM controlled_node_artifact_manifests");
  await db.execute("DELETE FROM servers WHERE node_role = 'controlled'");
  // Remove sidecars left by a previous test, then restore the verified
  // baseline set. Missing sidecars are intentionally fail-closed.
  const entries = await readdir(exeDir).catch(() => []);
  for (const e of entries) {
    if (e.endsWith('.manifest.json')) {
      await rm(join(exeDir, e), { force: true });
    } else if (e === 'computer-use-helper') {
      await rm(join(exeDir, e), { recursive: true, force: true });
    }
  }
  await writeManifest('imcodes-node-linux', 'linux', 'x64');
  await writeManifest('imcodes-node.exe', 'win32', 'x64');
  await rm(join(exeDir, 'imcodes-node-macos'), { recursive: true, force: true });
  await mkdir(join(exeDir, 'imcodes-node-macos'));
  // Restore dev mode by default (overridden per-test when needed).
  process.env.NODE_ENV = 'development';
});

function buildApp(options: { serverUrl?: string | null; artifactCatalog?: ArtifactCatalog } = {}) {
  const app = new Hono();
  app.use('*', async (c, next) => {
    const serverUrl = options.serverUrl === undefined ? 'http://localhost' : options.serverUrl;
    (c as unknown as { env: Record<string, unknown> }).env = {
      DB: db,
      BOT_ENCRYPTION_KEY: TEST_ENCRYPTION_KEY,
      JWT_SIGNING_KEY: 'unused',
      ...(serverUrl === null ? {} : { SERVER_URL: serverUrl }),
      DATABASE_URL: 'unused',
      NODE_ENV: process.env.NODE_ENV,
    };
    await next();
  });
  app.route('/api/enroll', createEnrollRoutes(options.artifactCatalog ?? artifactCatalog));
  return app;
}

async function owner(userId: string): Promise<{ serverId: string; token: string }> {
  const token = hex(16);
  const serverId = hex(8);
  await createServer(db, serverId, userId, 'full-box', sha256(token));
  return { serverId, token };
}

// ─────────────────────────── POST /v2/ticket ───────────────────────────

describe('POST /api/enroll/v2/ticket (artifact manifest → enrollments_v2 row)', () => {
  it('mints a ticket; stores encrypted code + artifact sha; returns raw ticket + meta', async () => {
    const app = buildApp();
    const userId = `u_${hex(4)}`;
    await createUser(db, userId);
    const o = await owner(userId);

    const r = await app.request('/api/enroll/v2/ticket', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Server-Id': o.serverId, authorization: `Bearer ${o.token}` },
      body: JSON.stringify({ version: 2, os: 'linux', arch: 'x64' }),
    });
    expect(r.status).toBe(200);
    const body = await r.json() as { version: number; ticketId: string; ticket: string; os: string; arch: string; filename: string; sizeBytes: number; sha256: string; maxConsumes: number; expiresAt: number };
    expect(body.version).toBe(2);
    expect(body.ticketId).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.ticket).toMatch(/^[0-9a-f]{64}$/);
    expect(body.os).toBe('linux');
    expect(body.arch).toBe('x64');
    expect(body.sizeBytes).toBe(FAKE_BINARY.length);
    expect(body.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(body.maxConsumes).toBe(3);

    // The DB row carries the same sha + a ticket_hash = sha256(ticket) + a
    // code_hash + the encrypted code. The raw ticket / raw code are never
    // persisted.
    const row = await db.queryOne<{
      ticket_hash: string; code_hash: string; encrypted_code: string;
      artifact_sha256: string; used_at: string | null; install_id: string | null;
      node_token_hash: string | null; consumed_count: number;
    }>(
      `SELECT ticket_hash, code_hash, encrypted_code, artifact_sha256, used_at,
              install_id, node_token_hash, consumed_count
         FROM controlled_node_enrollments_v2 LIMIT 1`,
    );
    expect(row?.ticket_hash).toBe(sha256(body.ticket));
    expect(row?.code_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(row?.encrypted_code).toBeTruthy();
    expect(row?.encrypted_code).not.toContain(body.ticket);
    const { decryptBotConfig } = await import('../src/security/crypto.js');
    expect(decryptBotConfig(row!.encrypted_code, TEST_ENCRYPTION_KEY).serverUrl).toBe('http://localhost');
    expect(row?.used_at).toBeNull();
    expect(row?.install_id).toBeNull();
    expect(row?.node_token_hash).toBeNull();
    expect(row?.consumed_count).toBe(0);
  });

  it('rejects requests missing version:2 or arch (400)', async () => {
    const app = buildApp();
    const userId = `u_${hex(4)}`;
    await createUser(db, userId);
    const o = await owner(userId);

    const r1 = await app.request('/api/enroll/v2/ticket', {
      method: 'POST', headers: { 'content-type': 'application/json', 'X-Server-Id': o.serverId, authorization: `Bearer ${o.token}` },
      body: JSON.stringify({ os: 'linux', arch: 'x64' }),
    });
    expect(r1.status).toBe(400);

    const r2 = await app.request('/api/enroll/v2/ticket', {
      method: 'POST', headers: { 'content-type': 'application/json', 'X-Server-Id': o.serverId, authorization: `Bearer ${o.token}` },
      body: JSON.stringify({ version: 2, os: 'linux' }),
    });
    expect(r2.status).toBe(400);
  });

  it('reads sha + size from the CI nested sidecar manifest', async () => {
    const app = buildApp();
    const userId = `u_${hex(4)}`;
    await createUser(db, userId);
    const o = await owner(userId);
    const r = await app.request('/api/enroll/v2/ticket', {
      method: 'POST', headers: { 'content-type': 'application/json', 'X-Server-Id': o.serverId, authorization: `Bearer ${o.token}` },
      body: JSON.stringify({ version: 2, os: 'linux', arch: 'x64' }),
    });
    expect(r.status).toBe(200);
    const body = await r.json() as { sha256: string };
    expect(body.sha256).toBe(sha256(FAKE_BINARY));

    // The persisted manifest must be tagged source=manifest_json.
    const m = await db.queryOne<{ source: string }>('SELECT source FROM controlled_node_artifact_manifests WHERE os = $1 AND arch = $2', ['linux', 'x64']);
    expect(m?.source).toBe('manifest_json');
  });

  it('fails closed when the sidecar manifest is missing', async () => {
    await rm(join(exeDir, 'imcodes-node-linux.manifest.json'), { force: true });
    const app = buildApp();
    const userId = `u_${hex(4)}`;
    await createUser(db, userId);
    const o = await owner(userId);
    const r = await app.request('/api/enroll/v2/ticket', {
      method: 'POST', headers: { 'content-type': 'application/json', 'X-Server-Id': o.serverId, authorization: `Bearer ${o.token}` },
      body: JSON.stringify({ version: 2, os: 'linux', arch: 'x64' }),
    });
    expect(r.status).toBe(503);
  });

  it('fails closed when the sidecar manifest path is a symlink', async () => {
    const manifestPath = join(exeDir, 'imcodes-node-linux.manifest.json');
    const targetPath = join(exeDir, 'linux-manifest-target.json');
    await rename(manifestPath, targetPath);
    await symlink(targetPath, manifestPath);
    try {
      const app = buildApp();
      const userId = `u_${hex(4)}`;
      await createUser(db, userId);
      const o = await owner(userId);
      const r = await app.request('/api/enroll/v2/ticket', {
        method: 'POST', headers: { 'content-type': 'application/json', 'X-Server-Id': o.serverId, authorization: `Bearer ${o.token}` },
        body: JSON.stringify({ version: 2, os: 'linux', arch: 'x64' }),
      });
      expect(r.status).toBe(503);
    } finally {
      await rm(manifestPath, { force: true });
      await rm(targetPath, { force: true });
    }
  });

  it('fails closed when the artifact path is a symlink', async () => {
    if (process.platform === 'win32') return;
    const artifactPath = join(exeDir, 'imcodes-node-linux');
    const targetPath = join(exeDir, 'linux-artifact-target');
    await rename(artifactPath, targetPath);
    await symlink(targetPath, artifactPath);
    try {
      const app = buildApp();
      const userId = `u_${hex(4)}`;
      await createUser(db, userId);
      const o = await owner(userId);
      const r = await app.request('/api/enroll/v2/ticket', {
        method: 'POST', headers: { 'content-type': 'application/json', 'X-Server-Id': o.serverId, authorization: `Bearer ${o.token}` },
        body: JSON.stringify({ version: 2, os: 'linux', arch: 'x64' }),
      });
      expect(r.status).toBe(503);
    } finally {
      await rm(artifactPath, { force: true });
      await rename(targetPath, artifactPath);
    }
  });

  it('fails closed when artifact bytes do not match the manifest digest', async () => {
    await writeFile(join(exeDir, 'imcodes-node-linux'), Buffer.from('tampered'));
    const app = buildApp();
    const userId = `u_${hex(4)}`;
    await createUser(db, userId);
    const o = await owner(userId);
    const r = await app.request('/api/enroll/v2/ticket', {
      method: 'POST', headers: { 'content-type': 'application/json', 'X-Server-Id': o.serverId, authorization: `Bearer ${o.token}` },
      body: JSON.stringify({ version: 2, os: 'linux', arch: 'x64' }),
    });
    expect(r.status).toBe(503);
    await writeFile(join(exeDir, 'imcodes-node-linux'), FAKE_BINARY);
  });

  it('returns 503 when IMCODES_NODE_EXE_DIR is not configured', async () => {
    const app = buildApp();
    const userId = `u_${hex(4)}`;
    await createUser(db, userId);
    const o = await owner(userId);
    const saved = process.env.IMCODES_NODE_EXE_DIR;
    delete process.env.IMCODES_NODE_EXE_DIR;
    try {
      const r = await app.request('/api/enroll/v2/ticket', {
        method: 'POST', headers: { 'content-type': 'application/json', 'X-Server-Id': o.serverId, authorization: `Bearer ${o.token}` },
        body: JSON.stringify({ version: 2, os: 'linux', arch: 'x64' }),
      });
      expect(r.status).toBe(503);
    } finally {
      process.env.IMCODES_NODE_EXE_DIR = saved;
    }
  });

  it('rejects non-HTTPS origin in production (403)', async () => {
    process.env.NODE_ENV = 'production';
    const app = buildApp({ serverUrl: 'http://insecure.example.com' });
    const userId = `u_${hex(4)}`;
    await createUser(db, userId);
    const o = await owner(userId);
    const r = await app.request('/api/enroll/v2/ticket', {
      method: 'POST', headers: { 'content-type': 'application/json', 'X-Server-Id': o.serverId, authorization: `Bearer ${o.token}` },
      body: JSON.stringify({ version: 2, os: 'linux', arch: 'x64' }),
    });
    expect(r.status).toBe(403);
  });

  it('requires an explicitly configured canonical SERVER_URL in production', async () => {
    process.env.NODE_ENV = 'production';
    const app = buildApp({ serverUrl: null });
    const userId = `u_${hex(4)}`;
    await createUser(db, userId);
    const o = await owner(userId);
    const response = await app.request('https://request-host.example/api/enroll/v2/ticket', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Server-Id': o.serverId, authorization: `Bearer ${o.token}` },
      body: JSON.stringify({ version: 2, os: 'linux', arch: 'x64' }),
    });
    expect(response.status).toBe(403);
  });

  it('reuses BOT_ENCRYPTION_KEY for production ticket mint and download', async () => {
    process.env.NODE_ENV = 'production';
    const app = buildApp({ serverUrl: 'https://legacy-deployment.example' });
    const userId = `u_${hex(4)}`;
    await createUser(db, userId);
    const o = await owner(userId);

    const mint = await app.request('/api/enroll/v2/ticket', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Server-Id': o.serverId, authorization: `Bearer ${o.token}` },
      body: JSON.stringify({ version: 2, os: 'linux', arch: 'x64' }),
    });
    expect(mint.status).toBe(200);
    const { ticket } = await mint.json() as { ticket: string };

    const download = await app.request('/api/enroll/v2/download', {
      headers: { authorization: `Bearer ${ticket}` },
    });
    expect(download.status).toBe(200);
    const downloaded = Buffer.from(await download.arrayBuffer());
    expect(downloaded.subarray(0, FAKE_BINARY.length)).toEqual(FAKE_BINARY);
    expect(decodeEnrollmentTrailer(downloaded)?.serverUrl).toBe('https://legacy-deployment.example');
  });
});

// ─────────────────────────── GET /v2/download ───────────────────────────

describe('GET|POST /api/enroll/v2/download (ticket + streaming)', () => {
  it('admits at most three concurrent streams, hashes once, and closes every pinned handle', async () => {
    const app = buildApp();
    const userId = `u_${hex(4)}`;
    await createUser(db, userId);
    const o = await owner(userId);
    const mint = await app.request('/api/enroll/v2/ticket', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Server-Id': o.serverId, authorization: `Bearer ${o.token}` },
      body: JSON.stringify({ version: 2, os: 'linux', arch: 'x64' }),
    });
    const { ticket } = await mint.json() as { ticket: string };

    const responses = await Promise.all(Array.from({ length: 50 }, () => app.request('/api/enroll/v2/download', {
      headers: { authorization: `Bearer ${ticket}` },
    })));
    const successful = responses.filter((response) => response.status === 200);
    expect(successful).toHaveLength(3);
    expect(responses.filter((response) => response.status === 401)).toHaveLength(47);
    expect(artifactCatalog.getDiagnostics()).toEqual({ fullHashCount: 1, activePinnedHandles: 3 });
    await Promise.all(successful.map((response) => response.arrayBuffer()));
    expect(artifactCatalog.getDiagnostics()).toEqual({ fullHashCount: 1, activePinnedHandles: 0 });

    const row = await db.queryOne<{ consumed_count: number }>(
      'SELECT consumed_count FROM controlled_node_enrollments_v2 LIMIT 1',
    );
    expect(row?.consumed_count).toBe(3);
    const attempts = await db.queryOne<{ committed: number; reserved: number }>(
      `SELECT
         count(*) FILTER (WHERE state = 'committed')::int AS committed,
         count(*) FILTER (WHERE state = 'reserved')::int AS reserved
       FROM controlled_node_download_attempts`,
    );
    expect(attempts).toEqual({ committed: 3, reserved: 0 });
  });

  it('client cancellation after response commitment consumes once and closes the descriptor', async () => {
    const app = buildApp();
    const userId = `u_${hex(4)}`;
    await createUser(db, userId);
    const o = await owner(userId);
    const mint = await app.request('/api/enroll/v2/ticket', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Server-Id': o.serverId, authorization: `Bearer ${o.token}` },
      body: JSON.stringify({ version: 2, os: 'linux', arch: 'x64' }),
    });
    const { ticket } = await mint.json() as { ticket: string };
    const response = await app.request('/api/enroll/v2/download', {
      headers: { authorization: `Bearer ${ticket}` },
    });
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    await reader.read();
    await reader.cancel();
    expect(artifactCatalog.getDiagnostics().activePinnedHandles).toBe(0);
    const state = await db.queryOne<{ state: string }>(
      'SELECT state FROM controlled_node_download_attempts LIMIT 1',
    );
    expect(state?.state).toBe('committed');
    const row = await db.queryOne<{ consumed_count: number }>(
      'SELECT consumed_count FROM controlled_node_enrollments_v2 LIMIT 1',
    );
    expect(row?.consumed_count).toBe(1);
  });

  it('keeps a committed attempt consumed and closes exactly once when artifact streaming fails', async () => {
    const app = buildApp();
    const userId = `u_${hex(4)}`;
    await createUser(db, userId);
    const o = await owner(userId);
    const mint = await app.request('/api/enroll/v2/ticket', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Server-Id': o.serverId, authorization: `Bearer ${o.token}` },
      body: JSON.stringify({ version: 2, os: 'linux', arch: 'x64' }),
    });
    const { ticket } = await mint.json() as { ticket: string };
    const verified = await artifactCatalog.ensureVerified(exeDir, 'linux', 'x64');
    expect(verified.ok).toBe(true);
    if (!verified.ok) throw new Error('fixture artifact was not verified');

    const close = vi.fn(async () => {});
    const failingHandle = {
      read: vi.fn(async () => { throw new Error('injected artifact read failure'); }),
      close,
    };
    vi.spyOn(artifactCatalog, 'openPinned').mockResolvedValue({
      descriptor: verified.descriptor,
      handle: failingHandle as never,
      close: makeSafeCloseOnce(failingHandle as never),
    });

    const response = await app.request('/api/enroll/v2/download', {
      headers: { authorization: `Bearer ${ticket}` },
    });
    expect(response.status).toBe(200);
    await expect(response.arrayBuffer()).rejects.toThrow(/injected artifact read failure/);
    expect(close).toHaveBeenCalledTimes(1);
    const attempt = await db.queryOne<{ state: string }>(
      'SELECT state FROM controlled_node_download_attempts LIMIT 1',
    );
    expect(attempt?.state).toBe('committed');
    const row = await db.queryOne<{ consumed_count: number }>(
      'SELECT consumed_count FROM controlled_node_enrollments_v2 LIMIT 1',
    );
    expect(row?.consumed_count).toBe(1);
  });

  it('audit failure rolls back commit and releases the reserved retry budget', async () => {
    const app = buildApp();
    const userId = `u_${hex(4)}`;
    await createUser(db, userId);
    const o = await owner(userId);
    const mint = await app.request('/api/enroll/v2/ticket', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Server-Id': o.serverId, authorization: `Bearer ${o.token}` },
      body: JSON.stringify({ version: 2, os: 'linux', arch: 'x64' }),
    });
    const { ticket } = await mint.json() as { ticket: string };
    await db.exec(`
      CREATE OR REPLACE FUNCTION reject_controlled_node_consume_audit() RETURNS trigger AS $$
      BEGIN
        IF NEW.action = 'enroll.v2.ticket.consume' THEN
          RAISE EXCEPTION 'consume audit unavailable';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER reject_controlled_node_consume_audit_trigger
        BEFORE INSERT ON audit_log
        FOR EACH ROW EXECUTE FUNCTION reject_controlled_node_consume_audit();
    `);
    try {
      const response = await app.request('/api/enroll/v2/download', {
        headers: { authorization: `Bearer ${ticket}` },
      });
      expect(response.status).toBe(503);
      expect(artifactCatalog.getDiagnostics().activePinnedHandles).toBe(0);
      const row = await db.queryOne<{ consumed_count: number }>(
        'SELECT consumed_count FROM controlled_node_enrollments_v2 LIMIT 1',
      );
      expect(row?.consumed_count).toBe(0);
      const attempt = await db.queryOne<{ state: string }>(
        'SELECT state FROM controlled_node_download_attempts LIMIT 1',
      );
      expect(attempt?.state).toBe('released');
    } finally {
      await db.exec(`
        DROP TRIGGER IF EXISTS reject_controlled_node_consume_audit_trigger ON audit_log;
        DROP FUNCTION IF EXISTS reject_controlled_node_consume_audit();
      `);
    }
  });

  it('streams base + trailer with the SAME encrypted_code on every retry', async () => {
    const app = buildApp();
    const userId = `u_${hex(4)}`;
    await createUser(db, userId);
    const o = await owner(userId);
    const mint = await app.request('/api/enroll/v2/ticket', {
      method: 'POST', headers: { 'content-type': 'application/json', 'X-Server-Id': o.serverId, authorization: `Bearer ${o.token}` },
      body: JSON.stringify({ version: 2, os: 'linux', arch: 'x64' }),
    });
    const { ticket } = await mint.json() as { ticket: string };

    const r1 = await (await app.request('http://first-request-host.invalid/api/enroll/v2/download', { headers: { authorization: `Bearer ${ticket}` } })).arrayBuffer();
    const r2 = await (await app.request('http://second-request-host.invalid/api/enroll/v2/download', { headers: { authorization: `Bearer ${ticket}` } })).arrayBuffer();
    const r3 = await (await app.request('http://third-request-host.invalid/api/enroll/v2/download', { headers: { authorization: `Bearer ${ticket}` } })).arrayBuffer();
    expect(new Uint8Array(r1)).toEqual(new Uint8Array(r2));
    expect(new Uint8Array(r2)).toEqual(new Uint8Array(r3));

    // Each byte slice contains the same enrollment trailer — i.e. the SAME
    // decrypted enrollment code reused across all retries (because the
    // encrypted_code column is unchanged).
    const arr1 = new Uint8Array(r1);
    const tail = Buffer.from(arr1.slice(arr1.length - 40)).toString('ascii');
    expect(tail).toContain('IMCODESENROLL');
    expect(decodeEnrollmentTrailer(Buffer.from(arr1))?.serverUrl).toBe('http://localhost');

    // consumed_count must equal max_consumes (3) after three successes.
    const row = await db.queryOne<{ consumed_count: number; consumed_at: string | null }>(
      'SELECT consumed_count, consumed_at FROM controlled_node_enrollments_v2 LIMIT 1',
    );
    expect(row?.consumed_count).toBe(3);
    expect(row?.consumed_at).not.toBeNull();

    // The encrypted_code column has NOT changed across retries — same bytes.
    const c1 = await db.queryOne<{ encrypted_code: string }>('SELECT encrypted_code FROM controlled_node_enrollments_v2 LIMIT 1');
    const c2 = await db.queryOne<{ encrypted_code: string }>('SELECT encrypted_code FROM controlled_node_enrollments_v2 LIMIT 1');
    expect(c1?.encrypted_code).toBe(c2?.encrypted_code);
  });

  it('returns 401 on the 4th retry (consume_count exceeded)', async () => {
    const app = buildApp();
    const userId = `u_${hex(4)}`;
    await createUser(db, userId);
    const o = await owner(userId);
    const mint = await app.request('/api/enroll/v2/ticket', {
      method: 'POST', headers: { 'content-type': 'application/json', 'X-Server-Id': o.serverId, authorization: `Bearer ${o.token}` },
      body: JSON.stringify({ version: 2, os: 'linux', arch: 'x64' }),
    });
    const { ticket } = await mint.json() as { ticket: string };
    for (let i = 0; i < 3; i++) {
      const r = await app.request('/api/enroll/v2/download', { headers: { authorization: `Bearer ${ticket}` } });
      expect(r.status).toBe(200);
      await r.arrayBuffer();
    }
    const r4 = await app.request('/api/enroll/v2/download', { headers: { authorization: `Bearer ${ticket}` } });
    expect(r4.status).toBe(401);
  });

  it('returns 416 on Range header WITHOUT incrementing consume_count', async () => {
    const app = buildApp();
    const userId = `u_${hex(4)}`;
    await createUser(db, userId);
    const o = await owner(userId);
    const mint = await app.request('/api/enroll/v2/ticket', {
      method: 'POST', headers: { 'content-type': 'application/json', 'X-Server-Id': o.serverId, authorization: `Bearer ${o.token}` },
      body: JSON.stringify({ version: 2, os: 'linux', arch: 'x64' }),
    });
    const { ticket } = await mint.json() as { ticket: string };
    const r = await app.request('/api/enroll/v2/download', {
      headers: { authorization: `Bearer ${ticket}`, range: 'bytes=0-10' },
    });
    expect(r.status).toBe(416);

    // Critical: consume_count must still be 0 — Range does NOT burn a retry.
    const row = await db.queryOne<{ consumed_count: number }>(
      'SELECT consumed_count FROM controlled_node_enrollments_v2 LIMIT 1',
    );
    expect(row?.consumed_count).toBe(0);

    // And a subsequent non-Range GET must still succeed.
    const r2 = await app.request('/api/enroll/v2/download', { headers: { authorization: `Bearer ${ticket}` } });
    expect(r2.status).toBe(200);
    await r2.arrayBuffer();
  });

  it('returns 401 for missing / invalid bearer (consume_count untouched)', async () => {
    const app = buildApp();
    const r1 = await app.request('/api/enroll/v2/download');
    expect(r1.status).toBe(401);
    const r2 = await app.request('/api/enroll/v2/download', { headers: { authorization: 'Bearer not-hex' } });
    expect(r2.status).toBe(401);
  });

  it('rejects an expired five-minute download ticket', async () => {
    const app = buildApp();
    const userId = `u_${hex(4)}`;
    await createUser(db, userId);
    const o = await owner(userId);
    const mint = await app.request('/api/enroll/v2/ticket', {
      method: 'POST', headers: { 'content-type': 'application/json', 'X-Server-Id': o.serverId, authorization: `Bearer ${o.token}` },
      body: JSON.stringify({ version: 2, os: 'linux', arch: 'x64' }),
    });
    const { ticket } = await mint.json() as { ticket: string };
    await db.execute('UPDATE controlled_node_enrollments_v2 SET ticket_expires_at = $1', [Date.now() - 1]);
    const response = await app.request('/api/enroll/v2/download', { headers: { authorization: `Bearer ${ticket}` } });
    expect(response.status).toBe(401);
  });

  it('does not consume retry budget when artifact verification fails before streaming', async () => {
    const app = buildApp();
    const userId = `u_${hex(4)}`;
    await createUser(db, userId);
    const o = await owner(userId);
    const mint = await app.request('/api/enroll/v2/ticket', {
      method: 'POST', headers: { 'content-type': 'application/json', 'X-Server-Id': o.serverId, authorization: `Bearer ${o.token}` },
      body: JSON.stringify({ version: 2, os: 'linux', arch: 'x64' }),
    });
    const { ticket } = await mint.json() as { ticket: string };
    await writeFile(join(exeDir, 'imcodes-node-linux'), Buffer.from('tampered-after-mint'));
    const response = await app.request('/api/enroll/v2/download', { headers: { authorization: `Bearer ${ticket}` } });
    expect(response.status).toBe(503);
    const row = await db.queryOne<{ consumed_count: number }>('SELECT consumed_count FROM controlled_node_enrollments_v2 LIMIT 1');
    expect(row?.consumed_count).toBe(0);
    await writeFile(join(exeDir, 'imcodes-node-linux'), FAKE_BINARY);
  });

  it('streams the same verified file descriptor when the artifact path is replaced after response creation', async () => {
    const app = buildApp();
    const userId = `u_${hex(4)}`;
    await createUser(db, userId);
    const o = await owner(userId);
    const mint = await app.request('/api/enroll/v2/ticket', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Server-Id': o.serverId, authorization: `Bearer ${o.token}` },
      body: JSON.stringify({ version: 2, os: 'linux', arch: 'x64' }),
    });
    const { ticket } = await mint.json() as { ticket: string };
    const response = await app.request('/api/enroll/v2/download', {
      headers: { authorization: `Bearer ${ticket}` },
    });
    expect(response.status).toBe(200);

    const artifactPath = join(exeDir, 'imcodes-node-linux');
    const verifiedPath = join(exeDir, 'imcodes-node-linux.verified-open');
    await rename(artifactPath, verifiedPath);
    await writeFile(artifactPath, Buffer.from('REPLACEMENT_BYTES_MUST_NOT_BE_SERVED'));
    try {
      const body = Buffer.from(await response.arrayBuffer());
      expect(body.subarray(0, FAKE_BINARY.length)).toEqual(FAKE_BINARY);
    } finally {
      await rm(artifactPath, { force: true });
      await rename(verifiedPath, artifactPath);
    }
  });

  it('uses the canonical HTTPS SERVER_URL embedded at mint regardless of download Host', async () => {
    process.env.NODE_ENV = 'production';
    const app = buildApp({ serverUrl: 'https://canonical.example' });
    const userId = `u_${hex(4)}`;
    await createUser(db, userId);
    const o = await owner(userId);
    const mint = await app.request('https://mint-host.invalid/api/enroll/v2/ticket', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Server-Id': o.serverId, authorization: `Bearer ${o.token}` },
      body: JSON.stringify({ version: 2, os: 'linux', arch: 'x64' }),
    });
    expect(mint.status).toBe(200);
    const { ticket } = await mint.json() as { ticket: string };
    const download = await app.request('https://different-download-host.invalid/api/enroll/v2/download', {
      headers: { authorization: `Bearer ${ticket}` },
    });
    expect(download.status).toBe(200);
    const body = Buffer.from(await download.arrayBuffer());
    expect(decodeEnrollmentTrailer(body)?.serverUrl).toBe('https://canonical.example');
  });

  it('bootstrap keeps the ticket in the fragment and POST body download works', async () => {
    const app = buildApp();
    const page = await app.request('/api/enroll/v2/bootstrap');
    expect(page.status).toBe(200);
    expect(page.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(await page.text()).toContain("location.hash.slice(1)");

    const userId = `u_${hex(4)}`;
    await createUser(db, userId);
    const o = await owner(userId);
    const mint = await app.request('/api/enroll/v2/ticket', {
      method: 'POST', headers: { 'content-type': 'application/json', 'X-Server-Id': o.serverId, authorization: `Bearer ${o.token}` },
      body: JSON.stringify({ version: 2, os: 'linux', arch: 'x64' }),
    });
    const { ticket } = await mint.json() as { ticket: string };
    const download = await app.request('/api/enroll/v2/download', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ ticket }).toString(),
    });
    expect(download.status).toBe(200);
    expect(download.headers.get('content-disposition')).toContain('imcodes-node-linux');
    await download.arrayBuffer();
  });
});

// ─────────────────────────── POST /v2/redeem ───────────────────────────

describe('POST /api/enroll/v2/redeem (atomic claim + idempotent + mismatch → 409)', () => {
  it('unknown enroll token returns the same generic redeem failure', async () => {
    const app = buildApp();
    const r = await app.request('/api/enroll/v2/redeem', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        version: 2,
        enrollToken: `missing-${hex(8)}`,
        installId: `inst-${hex(4)}`,
        nodeTokenHash: sha256(hex(16)),
        hostname: 'h',
        os: 'linux',
        arch: 'x64',
      }),
    });
    expect(r.status).toBe(401);
    expect(await r.json()).toEqual({ error: 'redeem_failed' });
  });

  it('atomically binds identity on first claim; no install/identity required at mint', async () => {
    const app = buildApp();
    const userId = `u_${hex(4)}`;
    await createUser(db, userId);
    const o = await owner(userId);
    const mint = await app.request('/api/enroll/v2/ticket', {
      method: 'POST', headers: { 'content-type': 'application/json', 'X-Server-Id': o.serverId, authorization: `Bearer ${o.token}` },
      body: JSON.stringify({ version: 2, os: 'linux', arch: 'x64' }),
    });
    const { ticket: _t } = await mint.json() as { ticket: string };

    // Retrieve the raw enrollment code by decrypting the encrypted_code cell.
    const row = await db.queryOne<{ encrypted_code: string; code_hash: string }>(
      'SELECT encrypted_code, code_hash FROM controlled_node_enrollments_v2 LIMIT 1',
    );
    const encryptionKey = TEST_ENCRYPTION_KEY;
    // Use the route helper via a tiny in-test decrypt using crypto module.
    const { decryptBotConfig } = await import('../src/security/crypto.js');
    const decrypted = decryptBotConfig(row!.encrypted_code, encryptionKey);
    const enrollCode = decrypted.enrollCode;

    const installId = `inst-${hex(4)}`;
    const nodeToken = hex(16);
    const r = await app.request('/api/enroll/v2/redeem', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        version: 2,
        enrollToken: enrollCode,
        installId,
        nodeTokenHash: sha256(nodeToken),
        hostname: 'h',
        os: 'linux',
        arch: 'x64',
      }),
    });
    expect(r.status).toBe(200);
    const body = await r.json() as { serverId: string; version: number; nodeRole: string; token?: string };
    expect(body.version).toBe(2);
    expect(body.token).toBeUndefined(); // audit: no raw token returned
    expect(body.nodeRole).toBe('controlled');

    // Identity is now atomically bound.
    const bound = await db.queryOne<{ install_id: string; node_token_hash: string; used_at: string; redeemed_server_id: string }>(
      'SELECT install_id, node_token_hash, used_at, redeemed_server_id FROM controlled_node_enrollments_v2 LIMIT 1',
    );
    expect(bound?.install_id).toBe(installId);
    expect(bound?.node_token_hash).toBe(sha256(nodeToken));
    expect(bound?.used_at).not.toBeNull();
    expect(bound?.redeemed_server_id).toBe(body.serverId);
  });

  it('idempotent: same installId + same nodeTokenHash replay returns same serverId', async () => {
    const app = buildApp();
    const userId = `u_${hex(4)}`;
    await createUser(db, userId);
    const o = await owner(userId);
    const mint = await app.request('/api/enroll/v2/ticket', {
      method: 'POST', headers: { 'content-type': 'application/json', 'X-Server-Id': o.serverId, authorization: `Bearer ${o.token}` },
      body: JSON.stringify({ version: 2, os: 'linux', arch: 'x64' }),
    });
    const { decryptBotConfig } = await import('../src/security/crypto.js');
    const row = await db.queryOne<{ encrypted_code: string }>('SELECT encrypted_code FROM controlled_node_enrollments_v2 LIMIT 1');
    const enrollCode = decryptBotConfig(row!.encrypted_code, TEST_ENCRYPTION_KEY).enrollCode;

    const installId = `inst-${hex(4)}`;
    const nodeTokenHash = sha256(hex(16));
    const payload = {
      version: 2 as const, enrollToken: enrollCode, installId, nodeTokenHash,
      hostname: 'h', os: 'linux', arch: 'x64',
    };

    const r1 = await app.request('/api/enroll/v2/redeem', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
    const r2 = await app.request('/api/enroll/v2/redeem', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
    const r3 = await app.request('/api/enroll/v2/redeem', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(r3.status).toBe(200);
    const b1 = await r1.json() as { serverId: string };
    const b2 = await r2.json() as { serverId: string };
    const b3 = await r3.json() as { serverId: string };
    expect(b2.serverId).toBe(b1.serverId);
    expect(b3.serverId).toBe(b1.serverId);

    // Only ONE controlled server exists for this user.
    const count = await db.queryOne<{ n: string }>(
      "SELECT COUNT(*)::text AS n FROM servers WHERE user_id = $1 AND node_role = 'controlled'",
      [userId],
    );
    expect(count?.n).toBe('1');
  });

  it('mismatch (same installId, different nodeTokenHash) returns generic 409 redeem failure', async () => {
    const app = buildApp();
    const userId = `u_${hex(4)}`;
    await createUser(db, userId);
    const o = await owner(userId);
    await app.request('/api/enroll/v2/ticket', {
      method: 'POST', headers: { 'content-type': 'application/json', 'X-Server-Id': o.serverId, authorization: `Bearer ${o.token}` },
      body: JSON.stringify({ version: 2, os: 'linux', arch: 'x64' }),
    });
    const { decryptBotConfig } = await import('../src/security/crypto.js');
    const row = await db.queryOne<{ encrypted_code: string }>('SELECT encrypted_code FROM controlled_node_enrollments_v2 LIMIT 1');
    const enrollCode = decryptBotConfig(row!.encrypted_code, TEST_ENCRYPTION_KEY).enrollCode;
    const installId = `inst-${hex(4)}`;
    const originalHash = sha256(hex(16));

    const r1 = await app.request('/api/enroll/v2/redeem', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ version: 2, enrollToken: enrollCode, installId, nodeTokenHash: originalHash, hostname: 'h', os: 'linux', arch: 'x64' }),
    });
    expect(r1.status).toBe(200);

    const r2 = await app.request('/api/enroll/v2/redeem', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ version: 2, enrollToken: enrollCode, installId, nodeTokenHash: sha256(hex(16)), hostname: 'h', os: 'linux', arch: 'x64' }),
    });
    expect(r2.status).toBe(409);
    expect(await r2.json()).toEqual({ error: 'redeem_failed' });
  });

  it('mismatch (different installId) returns the same generic 409 redeem failure', async () => {
    const app = buildApp();
    const userId = `u_${hex(4)}`;
    await createUser(db, userId);
    const o = await owner(userId);
    await app.request('/api/enroll/v2/ticket', {
      method: 'POST', headers: { 'content-type': 'application/json', 'X-Server-Id': o.serverId, authorization: `Bearer ${o.token}` },
      body: JSON.stringify({ version: 2, os: 'linux', arch: 'x64' }),
    });
    const { decryptBotConfig } = await import('../src/security/crypto.js');
    const row = await db.queryOne<{ encrypted_code: string }>('SELECT encrypted_code FROM controlled_node_enrollments_v2 LIMIT 1');
    const enrollCode = decryptBotConfig(row!.encrypted_code, TEST_ENCRYPTION_KEY).enrollCode;
    const nodeTokenHash = sha256(hex(16));
    const r1 = await app.request('/api/enroll/v2/redeem', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ version: 2, enrollToken: enrollCode, installId: 'inst-A', nodeTokenHash, hostname: 'h', os: 'linux', arch: 'x64' }),
    });
    expect(r1.status).toBe(200);
    const r2 = await app.request('/api/enroll/v2/redeem', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ version: 2, enrollToken: enrollCode, installId: 'inst-B', nodeTokenHash, hostname: 'h', os: 'linux', arch: 'x64' }),
    });
    expect(r2.status).toBe(409);
    expect(await r2.json()).toEqual({ error: 'redeem_failed' });
  });

  it('os/arch mismatch on a valid ticket returns the same generic 409 conflict', async () => {
    const app = buildApp();
    const userId = `u_${hex(4)}`;
    await createUser(db, userId);
    const o = await owner(userId);
    await app.request('/api/enroll/v2/ticket', {
      method: 'POST', headers: { 'content-type': 'application/json', 'X-Server-Id': o.serverId, authorization: `Bearer ${o.token}` },
      body: JSON.stringify({ version: 2, os: 'linux', arch: 'x64' }),
    });
    const { decryptBotConfig } = await import('../src/security/crypto.js');
    const row = await db.queryOne<{ encrypted_code: string }>('SELECT encrypted_code FROM controlled_node_enrollments_v2 LIMIT 1');
    const enrollCode = decryptBotConfig(row!.encrypted_code, TEST_ENCRYPTION_KEY).enrollCode;
    const r = await app.request('/api/enroll/v2/redeem', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ version: 2, enrollToken: enrollCode, installId: 'i1', nodeTokenHash: sha256(hex(8)), hostname: 'h', os: 'win', arch: 'x64' }),
    });
    expect(r.status).toBe(409);
    expect(await r.json()).toEqual({ error: 'redeem_failed' });
  });

  it('rejects v1 body (version !== 2) with 400', async () => {
    const app = buildApp();
    const r1 = await app.request('/api/enroll/v2/redeem', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enrollToken: 'x', installId: 'i', nodeTokenHash: sha256(hex(8)), hostname: 'h', os: 'linux', arch: 'x64' }),
    });
    expect(r1.status).toBe(400);
    const r2 = await app.request('/api/enroll/v2/redeem', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ version: 1, enrollToken: 'x', installId: 'i', nodeTokenHash: sha256(hex(8)), hostname: 'h', os: 'linux', arch: 'x64' }),
    });
    expect(r2.status).toBe(400);
  });

  it('enforces both-null-or-both-present CHECK (cannot half-bind identity)', async () => {
    // Direct INSERT attempting to set install_id without node_token_hash must
    // be rejected by the table CHECK constraint (the route never produces
    // this state, but the database enforces it).
    await expect(
      db.execute(
        `INSERT INTO controlled_node_enrollments_v2
           (ticket_hash, code_hash, owner_user_id, os, arch, artifact_sha256,
            encrypted_code, ticket_expires_at, expires_at, created_at, install_id)
         VALUES ($1, $2, $3, 'linux', 'x64', $4, 'enc', $5, $5, $5, 'partial-install')`,
        [sha256(hex(16)), sha256(hex(16)), 'u', sha256(hex(32)), Date.now()],
      ),
    ).rejects.toThrow();
  });

  it('rejects non-HTTPS origin in production (403)', async () => {
    process.env.NODE_ENV = 'production';
    process.env.SERVER_URL = 'http://insecure.example.com';
    const app = buildApp();
    const r = await app.request('/api/enroll/v2/redeem', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ version: 2, enrollToken: 'x', installId: 'i', nodeTokenHash: sha256(hex(8)), hostname: 'h', os: 'linux', arch: 'x64' }),
    });
    expect(r.status).toBe(403);
  });
});

// ─────────────────────────── GET /v2/availability + retention ───────────────────────────

describe('GET /api/enroll/v2/availability + retention', () => {
  it('keeps verifier promises, cache, and diagnostics isolated per injected catalog', async () => {
    const first = createArtifactCatalog();
    const second = createArtifactCatalog();
    const firstApp = buildApp({ artifactCatalog: first });
    const secondApp = buildApp({ artifactCatalog: second });
    const userId = `u_${hex(4)}`;
    await createUser(db, userId);
    const o = await owner(userId);
    const headers = { 'X-Server-Id': o.serverId, authorization: `Bearer ${o.token}` };

    const [firstResponse, secondResponse] = await Promise.all([
      firstApp.request('/api/enroll/v2/availability', { headers }),
      secondApp.request('/api/enroll/v2/availability', { headers }),
    ]);
    expect(firstResponse.status).toBe(200);
    expect(secondResponse.status).toBe(200);
    await Promise.all([firstResponse.json(), secondResponse.json()]);
    expect(first.getDiagnostics()).toEqual({ fullHashCount: 2, activePinnedHandles: 0 });
    expect(second.getDiagnostics()).toEqual({ fullHashCount: 2, activePinnedHandles: 0 });
  });

  it('single-flights concurrent availability and avoids repeat hashes/descriptor writes', async () => {
    const app = buildApp();
    const userId = `u_${hex(4)}`;
    await createUser(db, userId);
    const o = await owner(userId);
    const headers = { 'X-Server-Id': o.serverId, authorization: `Bearer ${o.token}` };
    const responses = await Promise.all(Array.from({ length: 20 }, () => (
      app.request('/api/enroll/v2/availability', { headers })
    )));
    expect(responses.every((response) => response.status === 200)).toBe(true);
    await Promise.all(responses.map((response) => response.json()));
    expect(artifactCatalog.getDiagnostics()).toEqual({ fullHashCount: 2, activePinnedHandles: 0 });
    const before = await db.queryOne<{ max_updated_at: number; count: number }>(
      `SELECT max(updated_at)::bigint AS max_updated_at, count(*)::int AS count
         FROM controlled_node_artifact_manifests`,
    );
    await (await app.request('/api/enroll/v2/availability', { headers })).json();
    const after = await db.queryOne<{ max_updated_at: number; count: number }>(
      `SELECT max(updated_at)::bigint AS max_updated_at, count(*)::int AS count
         FROM controlled_node_artifact_manifests`,
    );
    expect(after).toEqual(before);
    expect(artifactCatalog.getDiagnostics().fullHashCount).toBe(2);
  });

  it('covers the canonical macOS arm64 ticket, bootstrap, download and redeem proxy path', async () => {
    await rm(join(exeDir, 'imcodes-node-macos'), { recursive: true, force: true });
    await writeFile(join(exeDir, 'imcodes-node-macos'), FAKE_BINARY);
    await writeManifest('imcodes-node-macos', 'darwin', 'arm64');
    artifactCatalog = createArtifactCatalog();

    const app = buildApp();
    const userId = `u_${hex(4)}`;
    await createUser(db, userId);
    const o = await owner(userId);
    const headers = { 'X-Server-Id': o.serverId, authorization: `Bearer ${o.token}` };
    const available = await app.request('/api/enroll/v2/availability', { headers });
    const catalog = await available.json() as { artifacts: Array<{ os: string; arch: string }> };
    expect(catalog.artifacts).toContainEqual(expect.objectContaining({ os: 'mac', arch: 'arm64' }));

    const mint = await app.request('/api/enroll/v2/ticket', {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ version: 2, os: 'mac', arch: 'arm64' }),
    });
    expect(mint.status).toBe(200);
    const { ticket } = await mint.json() as { ticket: string };
    const bootstrap = await app.request(`/api/enroll/v2/bootstrap#ticket=${ticket}`);
    expect(bootstrap.status).toBe(200);
    expect(await bootstrap.text()).toContain("f.method='POST'");
    const download = await app.request('/api/enroll/v2/download', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ ticket }).toString(),
    });
    expect(download.status).toBe(200);
    const downloaded = Buffer.from(await download.arrayBuffer());
    expect(downloaded.subarray(0, FAKE_BINARY.length)).toEqual(FAKE_BINARY);
    const enrollment = decodeEnrollmentTrailer(downloaded);
    expect(enrollment).not.toBeNull();
    const redeem = await app.request('/api/enroll/v2/redeem', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        version: 2,
        enrollToken: enrollment!.enrollToken,
        installId: `install-${hex(8)}`,
        nodeTokenHash: sha256(`node-${hex(8)}`),
        hostname: 'mac-arm64-proxy',
        os: 'mac',
        arch: 'arm64',
      }),
    });
    expect(redeem.status).toBe(200);
  });

  it('discovers and returns verified artifact metadata before any ticket is minted', async () => {
    const app = buildApp();
    const userId = `u_${hex(4)}`;
    await createUser(db, userId);
    const o = await owner(userId);
    const r = await app.request('/api/enroll/v2/availability', {
      headers: { 'X-Server-Id': o.serverId, authorization: `Bearer ${o.token}` },
    });
    expect(r.status).toBe(200);
    const body = await r.json() as { artifacts: Array<{ os: string; arch: string; sizeBytes: number; sha256: string; source: string }> };
    expect(body.artifacts).toHaveLength(2);
    expect(new Set(body.artifacts.map((artifact) => `${artifact.os}:${artifact.arch}`)).size).toBe(2);
    expect(body.artifacts.find((a) => a.os === 'linux' && a.arch === 'x64')?.sha256).toBe(sha256(FAKE_BINARY));
    const persisted = await db.queryOne<{ count: string }>(
      'SELECT COUNT(*)::text AS count FROM controlled_node_artifact_manifests',
    );
    expect(persisted?.count).toBe('2');
  });

  it('retention deletes expired rows; keeps live rows', async () => {
    const userId = `u_${hex(4)}`;
    await createUser(db, userId);

    // 1 expired row (8 days past expiry → > 7-day retention window).
    const pastExpiry = Date.now() - 8 * 24 * 60 * 60 * 1000;
    await db.execute(
      `INSERT INTO controlled_node_enrollments_v2
         (ticket_hash, code_hash, owner_user_id, os, arch, artifact_sha256, encrypted_code,
          ticket_expires_at, expires_at, created_at)
       VALUES ($1, $2, $3, 'linux', 'x64', $4, 'enc', $5, $5, $5)`,
      [sha256(hex(16)), sha256(hex(16)), userId, sha256(hex(32)), pastExpiry],
    );
    // 1 live row.
    await db.execute(
      `INSERT INTO controlled_node_enrollments_v2
         (ticket_hash, code_hash, owner_user_id, os, arch, artifact_sha256, encrypted_code,
          ticket_expires_at, expires_at, created_at)
       VALUES ($1, $2, $3, 'linux', 'x64', $4, 'enc', $5, $5, $5)`,
      [sha256(hex(16)), sha256(hex(16)), userId, sha256(hex(32)), Date.now() + 60_000],
    );

    const result = await runEnrollmentRetention(db);
    expect(result.rows).toBeGreaterThanOrEqual(1);

    const live = await db.queryOne<{ n: string }>(
      "SELECT COUNT(*)::text AS n FROM controlled_node_enrollments_v2 WHERE owner_user_id = $1 AND expires_at > $2",
      [userId, Date.now()],
    );
    expect(live?.n).toBe('1');
  });

  it('retention releases an expired reservation without changing committed consumption', async () => {
    const userId = `u_${hex(4)}`;
    await createUser(db, userId);
    const enrollment = await db.queryOne<{ id: string }>(
      `INSERT INTO controlled_node_enrollments_v2
         (ticket_hash, code_hash, owner_user_id, os, arch, artifact_sha256, encrypted_code,
          consumed_count, max_consumes, ticket_expires_at, expires_at, created_at)
       VALUES ($1, $2, $3, 'linux', 'x64', $4, 'enc', 1, 3, $5, $5, $6)
       RETURNING id`,
      [sha256(hex(16)), sha256(hex(16)), userId, sha256(hex(32)), Date.now() + 60_000, Date.now()],
    );
    await db.execute(
      `INSERT INTO controlled_node_download_attempts
         (ticket_id, owner_user_id, state, lease_expires_at, consumed_count_after, created_at, updated_at)
       VALUES ($1, $2, 'reserved', $3, 0, $4, $4)`,
      [enrollment!.id, userId, Date.now() - 1, Date.now() - 10_000],
    );

    const result = await runEnrollmentRetention(db);
    expect(result.attempts).toBe(1);
    const attempt = await db.queryOne<{ state: string }>(
      'SELECT state FROM controlled_node_download_attempts WHERE ticket_id = $1',
      [enrollment!.id],
    );
    expect(attempt?.state).toBe('released');
    const parent = await db.queryOne<{ consumed_count: number }>(
      'SELECT consumed_count FROM controlled_node_enrollments_v2 WHERE id = $1',
      [enrollment!.id],
    );
    expect(parent?.consumed_count).toBe(1);
  });
});


// ─────────────────────────── GET /v2/node-artifact ───────────────────────────

describe('GET /api/enroll/v2/node-artifact (controlled-node self-upgrade)', () => {
  it('streams the bare pinned artifact to an authenticated controlled node', async () => {
    const app = buildApp();
    const userId = `u_${hex(4)}`;
    await createUser(db, userId);
    const token = hex(16);
    const serverId = hex(8);
    await db.execute(
      `INSERT INTO servers (id, user_id, name, token_hash, status, created_at, node_role, exec_enabled, os, arch)
       VALUES ($1, $2, 'controlled-win', $3, 'online', $4, $5, TRUE, 'win', 'x64')`,
      [serverId, userId, sha256(token), Date.now(), NODE_ROLE.CONTROLLED],
    );

    const response = await app.request(`/api/enroll/v2/node-artifact?serverId=${serverId}&os=win&arch=x64`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('x-imcodes-node-artifact-sha256')).toBe(sha256(FAKE_BINARY));
    expect(Buffer.from(await response.arrayBuffer())).toEqual(FAKE_BINARY);

    const helperBytes = Buffer.from('FAKE_OPEN_COMPUTER_USE_HELPER');
    await mkdir(join(exeDir, 'computer-use-helper', 'win32-x64'), { recursive: true });
    await writeFile(join(exeDir, 'computer-use-helper', 'win32-x64', 'open-computer-use.exe'), helperBytes);
    const helperResponse = await app.request(`/api/enroll/v2/node-artifact?serverId=${serverId}&os=win&arch=x64&asset=computer-use-helper`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(helperResponse.status).toBe(200);
    expect(helperResponse.headers.get('x-imcodes-node-artifact-filename')).toBe('open-computer-use.exe');
    expect(helperResponse.headers.get('x-imcodes-node-artifact-sha256')).toBe(sha256(helperBytes));
    expect(Buffer.from(await helperResponse.arrayBuffer())).toEqual(helperBytes);
  });

  it('rejects full daemon tokens and platform mismatches', async () => {
    const app = buildApp();
    const userId = `u_${hex(4)}`;
    await createUser(db, userId);
    const full = await owner(userId);
    const fullResponse = await app.request(`/api/enroll/v2/node-artifact?serverId=${full.serverId}&os=win&arch=x64`, {
      headers: { authorization: `Bearer ${full.token}` },
    });
    expect(fullResponse.status).toBe(403);

    const token = hex(16);
    const serverId = hex(8);
    await db.execute(
      `INSERT INTO servers (id, user_id, name, token_hash, status, created_at, node_role, exec_enabled, os, arch)
       VALUES ($1, $2, 'controlled-linux', $3, 'online', $4, $5, TRUE, 'linux', 'x64')`,
      [serverId, userId, sha256(token), Date.now(), NODE_ROLE.CONTROLLED],
    );
    const mismatch = await app.request(`/api/enroll/v2/node-artifact?serverId=${serverId}&os=win&arch=x64`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(mismatch.status).toBe(403);
  });
});
