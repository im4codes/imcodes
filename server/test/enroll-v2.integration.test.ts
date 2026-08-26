/**
 * Controlled-node v2 enrollment + download ticket — real PostgreSQL
 * (testcontainers via integration-global). Covers the integrated repair:
 *   - separate controlled_node_enrollments_v2 table (audit E1)
 *   - v2 redeem with {version:2, installId, nodeTokenHash, os, arch} body
 *   - permanent multi-use package identity with per-machine install rows
 *   - idempotent replay (same install identity → same server)
 *   - mismatch (same installId with another hash, or reused hash) → 409
 *   - ticket mint only from a build-pipeline sidecar whose digest matches
 *   - bearer download with same encrypted_code reused across retries
 *   - Range check before incrementing consume_count
 *   - HTTPS origin enforcement in production
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { Hono } from 'hono';
import { randomBytes, createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
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
import { NODE_ROLE, decodeEnrollmentTrailer, decodeEnrollmentTrailerWithRange } from '../../shared/remote-exec.js';
import { inspectWindowsAuthenticodeEnrollmentContainer } from '../../shared/windows-authenticode-enrollment.js';
import {
  ACCEPT_ENCODING_HEADER,
  CONTENT_ENCODING_HEADER,
  EXPECTED_USER_ID_HEADER,
} from '../../shared/http-header-names.js';
import { AUTH_IDENTITY_ERRORS } from '../../shared/auth-identity.js';
import {
  CONTROLLED_NODE_ARTIFACT_COMPRESSION_ENCODING,
  CONTROLLED_NODE_ARTIFACT_HEADERS,
  CONTROLLED_NODE_TICKET_DELIVERY,
  CONTROLLED_NODE_TICKET_MAX_CONSUMES,
  CONTROLLED_NODE_TICKET_TTL_MS,
  isControlledNodeInstallCode,
} from '../../shared/controlled-node-artifacts.js';
import { controlledNodeInstallCommandRoutes } from '../src/routes/controlled-node-install.js';
import {
  REMOTE_DESKTOP_LEGACY_UPGRADE_PROTOCOL_VERSION,
  REMOTE_DESKTOP_WORKER_FILENAME,
  REMOTE_DESKTOP_WORKER_MANIFEST_SUFFIX,
} from '../../shared/remote-desktop-worker.js';
import { WINDOWS_REMOTE_DESKTOP_QUALIFICATION_PLAN } from '../../shared/remote-desktop-qualification.js';

let db: Database;
const hex = (n: number) => randomBytes(n).toString('hex');
const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

let exeDir: string;
let artifactCatalog: ArtifactCatalog;
const FAKE_BINARY = Buffer.from('IMCODES_FAKE_EXECUTABLE_BINARY_v1');
const COMPRESSIBLE_FAKE_BINARY = Buffer.alloc(4096, 0x41);
function fakeSignedWindowsPe(): Buffer {
  const certificateOffset = 512;
  const certificateSize = 16;
  const file = Buffer.alloc(certificateOffset + certificateSize, 0x5a);
  file.writeUInt32LE(0x80, 0x3c);
  file.writeUInt32LE(0x00004550, 0x80);
  const optional = 0x80 + 24;
  file.writeUInt16LE(0x20b, optional);
  file.writeUInt32LE(16, optional + 108);
  const securityEntry = optional + 112 + 4 * 8;
  file.writeUInt32LE(certificateOffset, securityEntry);
  file.writeUInt32LE(certificateSize, securityEntry + 4);
  file.writeUInt32LE(certificateSize, certificateOffset);
  file.writeUInt16LE(0x0200, certificateOffset + 4);
  file.writeUInt16LE(0x0002, certificateOffset + 6);
  return file;
}
const FAKE_WINDOWS_SIGNED_PE = fakeSignedWindowsPe();
const TEST_ENCRYPTION_KEY = 'test-bot-encryption-key-do-not-use-in-prod';

async function writeManifest(
  fileName: 'imcodes-node-linux' | 'imcodes-node.exe' | 'imcodes-node-macos',
  os: 'linux' | 'win32' | 'darwin',
  arch: 'x64' | 'arm64' | 'universal',
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
      ...(os === 'win32' ? { authenticodeSignerSha256: 'c'.repeat(64) } : {}),
    },
    toolchain: {
      nodeVersion: 'v22.11.0',
      nodeArchive: `node-v22.11.0-${os}-${arch}.tar.gz`,
      nodeArchiveSha256: 'a'.repeat(64),
      postjectVersion: '1.0.0-alpha.6',
    },
    build: { commit: 'a'.repeat(40), version: '2026.7.1234-dev.5' },
  }));
}

async function writeRemoteDesktopRelease(workerVersion: string): Promise<{
  workerBytes: Buffer;
  virtualDisplayBytes: Buffer;
  workerManifest: Record<string, unknown>;
  workerManifestBytes: Buffer;
}> {
  const workerBytes = Buffer.from('FAKE_PINNED_LIBWEBRTC_WORKER');
  const virtualDisplayBytes = Buffer.from('SIGNED_VIRTUAL_DISPLAY_ARCHIVE');
  const workerDir = join(exeDir, 'remote-desktop-worker', 'win32-x64');
  await mkdir(workerDir, { recursive: true });
  const workerManifest = {
    manifestVersion: 2,
    workerVersion,
    protocolVersion: 2,
    ipcVersion: 1,
    os: 'win32',
    arch: 'x64',
    fileName: REMOTE_DESKTOP_WORKER_FILENAME,
    size: workerBytes.length,
    sha256: sha256(workerBytes),
    authenticodeSignerSha256: 'c'.repeat(64),
    libwebrtcRevision: WINDOWS_REMOTE_DESKTOP_QUALIFICATION_PLAN.mediaStackDecision.libwebrtcRevision,
    virtualDisplay: {
      archiveFileName: 'imcodes-virtual-display.zip',
      packageManifestFileName: 'imcodes-virtual-display.manifest.json',
      size: virtualDisplayBytes.length,
      sha256: sha256(virtualDisplayBytes),
    },
    toolchain: {
      msvc: '14.44',
      windowsSdk: '10.0.26100.0',
      cmake: 'not-used-gn',
      ninja: '1.13.1',
      depotTools: WINDOWS_REMOTE_DESKTOP_QUALIFICATION_PLAN.mediaStackDecision.depotToolsRevision,
    },
  };
  const workerManifestBytes = Buffer.from(JSON.stringify(workerManifest));
  await Promise.all([
    writeFile(join(workerDir, REMOTE_DESKTOP_WORKER_FILENAME), workerBytes),
    writeFile(
      join(workerDir, `${REMOTE_DESKTOP_WORKER_FILENAME}${REMOTE_DESKTOP_WORKER_MANIFEST_SUFFIX}`),
      workerManifestBytes,
    ),
    writeFile(join(workerDir, 'imcodes-virtual-display.zip'), virtualDisplayBytes),
  ]);
  return { workerBytes, virtualDisplayBytes, workerManifest, workerManifestBytes };
}

beforeAll(async () => {
  process.env.NODE_ENV = 'development'; // default for HTTPS-off tests; per-test overrides
  db = createDatabase(process.env.TEST_DATABASE_URL!);
  await runMigrations(db);
  exeDir = await mkdtemp(join(tmpdir(), 'imcodes-v2-exe-'));
  await writeFile(join(exeDir, 'imcodes-node-linux'), FAKE_BINARY);
  await writeFile(join(exeDir, 'imcodes-node.exe'), FAKE_WINDOWS_SIGNED_PE);
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
    } else if (e === 'computer-use-helper' || e === 'remote-desktop-worker') {
      await rm(join(exeDir, e), { recursive: true, force: true });
    }
  }
  await writeFile(join(exeDir, 'imcodes-node-linux'), FAKE_BINARY);
  await writeManifest('imcodes-node-linux', 'linux', 'x64');
  await writeFile(join(exeDir, 'imcodes-node.exe'), FAKE_WINDOWS_SIGNED_PE);
  await writeManifest('imcodes-node.exe', 'win32', 'x64', FAKE_WINDOWS_SIGNED_PE);
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

function ticketHeaders(userId: string, auth: { serverId: string; token: string }): Record<string, string> {
  return {
    'content-type': 'application/json',
    'X-Server-Id': auth.serverId,
    authorization: `Bearer ${auth.token}`,
    [EXPECTED_USER_ID_HEADER]: userId,
  };
}

// ─────────────────────────── POST /v2/ticket ───────────────────────────

describe('POST /api/enroll/v2/ticket (artifact manifest → enrollments_v2 row)', () => {
  it('requires the caller identity expectation before creating a durable installer', async () => {
    const app = buildApp();
    const userId = `u_${hex(4)}`;
    await createUser(db, userId);
    const o = await owner(userId);

    const missing = await app.request('/api/enroll/v2/ticket', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Server-Id': o.serverId, authorization: `Bearer ${o.token}` },
      body: JSON.stringify({ version: 2, os: 'linux', arch: 'x64' }),
    });
    expect(missing.status).toBe(428);
    expect(await missing.json()).toEqual({ error: AUTH_IDENTITY_ERRORS.EXPECTATION_REQUIRED });

    const changed = await app.request('/api/enroll/v2/ticket', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'X-Server-Id': o.serverId,
        authorization: `Bearer ${o.token}`,
        [EXPECTED_USER_ID_HEADER]: 'different-user',
      },
      body: JSON.stringify({ version: 2, os: 'linux', arch: 'x64' }),
    });
    expect(changed.status).toBe(409);
    expect(await changed.json()).toEqual({ error: AUTH_IDENTITY_ERRORS.CHANGED });

    const count = await db.queryOne<{ n: string }>('SELECT COUNT(*)::text AS n FROM controlled_node_enrollments_v2');
    expect(count?.n).toBe('0');
  });

  it('gives a remote install link a lifetime that can survive being carried to another machine', async () => {
    const app = buildApp();
    const userId = `u_${hex(4)}`;
    await createUser(db, userId);
    const o = await owner(userId);

    const before = Date.now();
    const res = await app.request('/api/enroll/v2/ticket', {
      method: 'POST',
      headers: ticketHeaders(userId, o),
      body: JSON.stringify({
        version: 2, os: 'linux', arch: 'x64',
        delivery: CONTROLLED_NODE_TICKET_DELIVERY.REMOTE_LINK,
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { ticketId: string; expiresAt: number; delivery: string };
    expect(body.delivery).toBe(CONTROLLED_NODE_TICKET_DELIVERY.REMOTE_LINK);

    // `before` is sampled ahead of the request, so the observed window is the
    // TTL plus request latency. Band it rather than pin it; the exact value is
    // asserted against the durable row below.
    const ttl = body.expiresAt - before;
    const expected = CONTROLLED_NODE_TICKET_TTL_MS[CONTROLLED_NODE_TICKET_DELIVERY.REMOTE_LINK];
    expect(ttl).toBeGreaterThan(expected - 60_000);
    expect(ttl).toBeLessThan(expected + 60_000);

    // The durable row, not just the response, must carry the long window —
    // download consumption is gated on ticket_expires_at.
    const row = await db.queryOne<{ ticket_expires_at: string; created_at: string }>(
      'SELECT ticket_expires_at, created_at FROM controlled_node_enrollments_v2 WHERE id = $1',
      [body.ticketId],
    );
    expect(Number(row?.ticket_expires_at) - Number(row?.created_at)).toBe(expected);
  });

  /**
   * The pasted one-liner, end to end.
   *
   * The pieces are covered separately elsewhere; what is only provable here is
   * that they compose: minting must actually persist a code, `/i/:code` must
   * find that row and render a script naming it, and the code must then work as
   * a download credential against the real artifact. A direct row INSERT would
   * skip the mint wiring entirely, which is where a silent break would live.
   */
  it('mints an install command whose code fetches a script and then downloads the artifact', async () => {
    const app = buildApp();
    // The short path is mounted at the root in production, not under /api/enroll.
    app.route('/i', controlledNodeInstallCommandRoutes);
    const userId = `u_${hex(4)}`;
    await createUser(db, userId);
    const o = await owner(userId);

    const minted = await app.request('/api/enroll/v2/ticket', {
      method: 'POST',
      headers: ticketHeaders(userId, o),
      body: JSON.stringify({
        version: 2, os: 'linux', arch: 'x64',
        delivery: CONTROLLED_NODE_TICKET_DELIVERY.INSTALL_COMMAND,
      }),
    });
    expect(minted.status).toBe(200);
    const body = await minted.json() as {
      ticketId: string; delivery: string; maxConsumes: number;
      installCode?: string; installCommand?: string;
    };

    expect(body.delivery).toBe(CONTROLLED_NODE_TICKET_DELIVERY.INSTALL_COMMAND);
    expect(isControlledNodeInstallCode(body.installCode)).toBe(true);
    // A fleet-sized budget, not the three attempts a single enrolment gets.
    expect(body.maxConsumes).toBe(
      CONTROLLED_NODE_TICKET_MAX_CONSUMES[CONTROLLED_NODE_TICKET_DELIVERY.INSTALL_COMMAND],
    );
    const row = await db.queryOne<{ max_consumes: number; install_code_hash: string | null }>(
      'SELECT max_consumes, install_code_hash FROM controlled_node_enrollments_v2 WHERE id = $1',
      [body.ticketId],
    );
    // Persisted as a hash; the plaintext code exists only in the response.
    expect(row?.install_code_hash).toBe(sha256(body.installCode!));
    expect(Number(row?.max_consumes)).toBe(
      CONTROLLED_NODE_TICKET_MAX_CONSUMES[CONTROLLED_NODE_TICKET_DELIVERY.INSTALL_COMMAND],
    );

    // The command is the literal line the operator pastes.
    expect(body.installCommand).toContain(`/i/${body.installCode}`);
    expect(body.installCommand).toMatch(/^curl -fsSL /);
    expect(body.installCommand).toContain('sudo sh');
    // The minted command is what the operator pastes into a root shell. A test
    // that only required `^curl -fsSL ` codified the unpinned form and would
    // have accepted a transport that follows a cross-scheme redirect.
    //
    // The pin must match the origin's own scheme; this harness mints against
    // http://localhost, so asserting a literal `=https` would only prove the
    // test knew the harness, not that the command is pinned at all.
    const mintedScheme = body.installCommand!.includes('https://') ? 'https' : 'http';
    expect(body.installCommand).toContain(`--proto '=${mintedScheme}'`);
    expect(body.installCommand).toContain(`--proto-redir '=${mintedScheme}'`);

    // 1. The pasted command fetches its script.
    const script = await app.request(`/i/${body.installCode}`);
    expect(script.status).toBe(200);
    const scriptBody = await script.text();
    expect(scriptBody).toContain(body.installCode!);
    expect(scriptBody).toContain("imcodes_expect_os='linux'");
    // Rendering must not spend a download slot, or probing would exhaust it.
    const afterRender = await db.queryOne<{ consumed_count: number }>(
      'SELECT consumed_count FROM controlled_node_enrollments_v2 WHERE id = $1', [body.ticketId],
    );
    expect(Number(afterRender?.consumed_count)).toBe(0);

    // 2. That same code is what the script posts to download the binary.
    const download = await app.request('/api/enroll/v2/download', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ ticket: body.installCode! }).toString(),
    });
    expect(download.status).toBe(200);
    const bytes = Buffer.from(await download.arrayBuffer());
    // A real personalized artifact, carrying the enrolment trailer.
    expect(bytes.length).toBeGreaterThan(FAKE_BINARY.length);
    expect(decodeEnrollmentTrailer(bytes)).not.toBeNull();

    const afterDownload = await db.queryOne<{ consumed_count: number }>(
      'SELECT consumed_count FROM controlled_node_enrollments_v2 WHERE id = $1', [body.ticketId],
    );
    expect(Number(afterDownload?.consumed_count)).toBe(1);
  });

  it('keeps the default and every unknown delivery on the short browser window', async () => {
    const app = buildApp();
    const userId = `u_${hex(4)}`;
    await createUser(db, userId);
    const o = await owner(userId);
    const browserTtl = CONTROLLED_NODE_TICKET_TTL_MS[CONTROLLED_NODE_TICKET_DELIVERY.BROWSER];

    // Omitted: historical callers must be unaffected.
    const omitted = await app.request('/api/enroll/v2/ticket', {
      method: 'POST',
      headers: ticketHeaders(userId, o),
      body: JSON.stringify({ version: 2, os: 'linux', arch: 'x64' }),
    });
    expect(omitted.status).toBe(200);
    const omittedBody = await omitted.json() as { ticketId: string; delivery: string };
    expect(omittedBody.delivery).toBe(CONTROLLED_NODE_TICKET_DELIVERY.BROWSER);
    const omittedRow = await db.queryOne<{ ticket_expires_at: string; created_at: string }>(
      'SELECT ticket_expires_at, created_at FROM controlled_node_enrollments_v2 WHERE id = $1',
      [omittedBody.ticketId],
    );
    expect(Number(omittedRow?.ticket_expires_at) - Number(omittedRow?.created_at)).toBe(browserTtl);

    // A bogus value must be refused outright, never silently widened: the body
    // schema is strict precisely so an attacker cannot invent a longer window.
    const bogus = await app.request('/api/enroll/v2/ticket', {
      method: 'POST',
      headers: ticketHeaders(userId, o),
      body: JSON.stringify({ version: 2, os: 'linux', arch: 'x64', delivery: 'forever' }),
    });
    expect(bogus.status).toBe(400);
    expect(await bogus.json()).toEqual({ error: 'invalid_body' });
  });

  it('records the daemon a login-screen enrolment was started from, and refuses another user\'s', async () => {
    const app = buildApp();
    const userId = `u_${hex(4)}`;
    const otherUserId = `u_${hex(4)}`;
    await createUser(db, userId);
    await createUser(db, otherUserId);
    const o = await owner(userId);
    const stranger = await owner(otherUserId);

    // The host link decides which entry a browser steers remote control to, so
    // it must not be assignable to a machine this user does not own.
    const forbidden = await app.request('/api/enroll/v2/ticket', {
      method: 'POST',
      headers: ticketHeaders(userId, o),
      body: JSON.stringify({ version: 2, os: 'win', arch: 'x64', hostServerId: stranger.serverId }),
    });
    expect(forbidden.status).toBe(403);
    expect(await forbidden.json()).toEqual({ error: 'invalid_host_server' });

    const minted = await app.request('/api/enroll/v2/ticket', {
      method: 'POST',
      headers: ticketHeaders(userId, o),
      body: JSON.stringify({ version: 2, os: 'win', arch: 'x64', hostServerId: o.serverId }),
    });
    expect(minted.status).toBe(200);
    const { ticketId } = await minted.json() as { ticketId: string };
    const stored = await db.queryOne<{ host_server_id: string | null }>(
      'SELECT host_server_id FROM controlled_node_enrollments_v2 WHERE id = $1',
      [ticketId],
    );
    expect(stored?.host_server_id).toBe(o.serverId);
  });

  it('leaves the host link unset for an ordinary enrolment', async () => {
    const app = buildApp();
    const userId = `u_${hex(4)}`;
    await createUser(db, userId);
    const o = await owner(userId);
    const r = await app.request('/api/enroll/v2/ticket', {
      method: 'POST',
      headers: ticketHeaders(userId, o),
      body: JSON.stringify({ version: 2, os: 'linux', arch: 'x64' }),
    });
    expect(r.status).toBe(200);
    const { ticketId } = await r.json() as { ticketId: string };
    const stored = await db.queryOne<{ host_server_id: string | null }>(
      'SELECT host_server_id FROM controlled_node_enrollments_v2 WHERE id = $1',
      [ticketId],
    );
    expect(stored?.host_server_id).toBeNull();
  });

  it('mints a ticket; stores encrypted code + artifact sha; returns raw ticket + meta', async () => {
    const app = buildApp();
    const userId = `u_${hex(4)}`;
    await createUser(db, userId);
    const o = await owner(userId);

    const r = await app.request('/api/enroll/v2/ticket', {
      method: 'POST',
      headers: ticketHeaders(userId, o),
      body: JSON.stringify({ version: 2, os: 'linux', arch: 'x64' }),
    });
    expect(r.status).toBe(200);
    const body = await r.json() as { version: number; ticketId: string; ticket: string; os: string; arch: string; filename: string; sizeBytes: number; sha256: string; maxConsumes: number; expiresAt: number; ownerUserId: string };
    expect(body.version).toBe(2);
    expect(body.ticketId).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.ticket).toMatch(/^[0-9a-f]{64}$/);
    expect(body.os).toBe('linux');
    expect(body.arch).toBe('x64');
    expect(body.sizeBytes).toBe(FAKE_BINARY.length);
    expect(body.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(body.maxConsumes).toBe(3);
    expect(body.ownerUserId).toBe(userId);

    // The DB row carries the same sha + a ticket_hash = sha256(ticket) + a
    // code_hash + the encrypted code. The raw ticket / raw code are never
    // persisted.
    const row = await db.queryOne<{
      ticket_hash: string; code_hash: string; encrypted_code: string;
      artifact_sha256: string; used_at: string | null; install_id: string | null;
      node_token_hash: string | null; consumed_count: number;
      reusable: boolean; expires_at: string | null;
    }>(
      `SELECT ticket_hash, code_hash, encrypted_code, artifact_sha256, used_at,
              install_id, node_token_hash, consumed_count, reusable, expires_at
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
    expect(row?.reusable).toBe(true);
    expect(row?.expires_at).toBeNull();
  });

  it('rejects requests missing version:2 or arch (400)', async () => {
    const app = buildApp();
    const userId = `u_${hex(4)}`;
    await createUser(db, userId);
    const o = await owner(userId);

    const r1 = await app.request('/api/enroll/v2/ticket', {
      method: 'POST', headers: ticketHeaders(userId, o),
      body: JSON.stringify({ os: 'linux', arch: 'x64' }),
    });
    expect(r1.status).toBe(400);

    const r2 = await app.request('/api/enroll/v2/ticket', {
      method: 'POST', headers: ticketHeaders(userId, o),
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
      method: 'POST', headers: ticketHeaders(userId, o),
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
      method: 'POST', headers: ticketHeaders(userId, o),
      body: JSON.stringify({ version: 2, os: 'linux', arch: 'x64' }),
    });
    expect(r.status).toBe(503);
  });

  it('fails closed when the sidecar manifest omits the runtime build version', async () => {
    await writeFile(join(exeDir, 'imcodes-node-linux.manifest.json'), JSON.stringify({
      schemaVersion: 1,
      artifact: {
        fileName: 'imcodes-node-linux',
        os: 'linux',
        arch: 'x64',
        size: FAKE_BINARY.length,
        sha256: sha256(FAKE_BINARY),
      },
      build: { commit: 'a'.repeat(40) },
    }));
    const app = buildApp();
    const userId = `u_${hex(4)}`;
    await createUser(db, userId);
    const o = await owner(userId);
    const r = await app.request('/api/enroll/v2/ticket', {
      method: 'POST', headers: ticketHeaders(userId, o),
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
        method: 'POST', headers: ticketHeaders(userId, o),
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
        method: 'POST', headers: ticketHeaders(userId, o),
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
      method: 'POST', headers: ticketHeaders(userId, o),
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
        method: 'POST', headers: ticketHeaders(userId, o),
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
      method: 'POST', headers: ticketHeaders(userId, o),
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
      headers: ticketHeaders(userId, o),
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
      headers: ticketHeaders(userId, o),
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
  it('gzip-encodes the personalized stream on demand without changing the downloaded executable', async () => {
    const app = buildApp();
    await writeFile(join(exeDir, 'imcodes-node-linux'), COMPRESSIBLE_FAKE_BINARY);
    await writeManifest('imcodes-node-linux', 'linux', 'x64', COMPRESSIBLE_FAKE_BINARY);
    const userId = `u_${hex(4)}`;
    await createUser(db, userId);
    const o = await owner(userId);
    const mint = await app.request('/api/enroll/v2/ticket', {
      method: 'POST',
      headers: ticketHeaders(userId, o),
      body: JSON.stringify({ version: 2, os: 'linux', arch: 'x64' }),
    });
    expect(mint.status).toBe(200);
    const { ticket } = await mint.json() as { ticket: string };

    const response = await app.request('/api/enroll/v2/download', {
      headers: {
        authorization: `Bearer ${ticket}`,
        [ACCEPT_ENCODING_HEADER]: CONTROLLED_NODE_ARTIFACT_COMPRESSION_ENCODING,
      },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get(CONTENT_ENCODING_HEADER)).toBe(CONTROLLED_NODE_ARTIFACT_COMPRESSION_ENCODING);
    expect(response.headers.get('content-length')).toBeNull();
    expect(response.headers.get('vary')).toContain(ACCEPT_ENCODING_HEADER);

    const downloaded = gunzipSync(Buffer.from(await response.arrayBuffer()));
    expect(downloaded.subarray(0, COMPRESSIBLE_FAKE_BINARY.length)).toEqual(COMPRESSIBLE_FAKE_BINARY);
    expect(decodeEnrollmentTrailer(downloaded)?.serverUrl).toBe('http://localhost');
  });

  it('personalizes a signed Windows PE inside its certificate table and preserves reversible signed bytes', async () => {
    const app = buildApp();
    const userId = `u_${hex(4)}`;
    await createUser(db, userId);
    const o = await owner(userId);
    const mint = await app.request('/api/enroll/v2/ticket', {
      method: 'POST',
      headers: ticketHeaders(userId, o),
      body: JSON.stringify({ version: 2, os: 'win', arch: 'x64' }),
    });
    expect(mint.status).toBe(200);
    const { ticket } = await mint.json() as { ticket: string };
    const response = await app.request('/api/enroll/v2/download', {
      headers: { authorization: `Bearer ${ticket}` },
    });
    expect(response.status).toBe(200);
    const personalized = Buffer.from(await response.arrayBuffer());
    expect(Number(response.headers.get('content-length'))).toBe(personalized.length);
    const decoded = decodeEnrollmentTrailerWithRange(personalized);
    expect(decoded?.blob.serverUrl).toBe('http://localhost');
    const restore = inspectWindowsAuthenticodeEnrollmentContainer(
      personalized.subarray(0, Math.min(personalized.length, 4096)),
      personalized.length,
      personalized,
      0,
      decoded!.trailerStart,
      decoded!.trailerLength,
    );
    expect(restore).not.toBeNull();
    const restored = Buffer.from(personalized.subarray(0, restore!.signedArtifactSize));
    restored.writeUInt32LE(restore!.originalCertificateTableSize, restore!.sizeFieldOffset);
    expect(restored).toEqual(FAKE_WINDOWS_SIGNED_PE);
  });

  it('admits at most three concurrent streams, hashes once, and closes every pinned handle', async () => {
    const app = buildApp();
    const userId = `u_${hex(4)}`;
    await createUser(db, userId);
    const o = await owner(userId);
    const mint = await app.request('/api/enroll/v2/ticket', {
      method: 'POST',
      headers: ticketHeaders(userId, o),
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
      headers: ticketHeaders(userId, o),
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
      headers: ticketHeaders(userId, o),
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
      headers: ticketHeaders(userId, o),
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
      method: 'POST', headers: ticketHeaders(userId, o),
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
      method: 'POST', headers: ticketHeaders(userId, o),
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
      method: 'POST', headers: ticketHeaders(userId, o),
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
      method: 'POST', headers: ticketHeaders(userId, o),
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
      method: 'POST', headers: ticketHeaders(userId, o),
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
      headers: ticketHeaders(userId, o),
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
      headers: ticketHeaders(userId, o),
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
      method: 'POST', headers: ticketHeaders(userId, o),
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

  it('atomically binds a per-machine identity while the reusable installer remains unexpired', async () => {
    const app = buildApp();
    const userId = `u_${hex(4)}`;
    await createUser(db, userId);
    const o = await owner(userId);
    const mint = await app.request('/api/enroll/v2/ticket', {
      method: 'POST', headers: ticketHeaders(userId, o),
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

    const installer = await db.queryOne<{ reusable: boolean; expires_at: string | null; used_at: string | null }>(
      'SELECT reusable, expires_at, used_at FROM controlled_node_enrollments_v2 LIMIT 1',
    );
    expect(installer).toEqual({ reusable: true, expires_at: null, used_at: null });

    // Machine identity is atomically bound in its own install row.
    const bound = await db.queryOne<{ install_id: string; node_token_hash: string; redeemed_server_id: string }>(
      'SELECT install_id, node_token_hash, redeemed_server_id FROM controlled_node_enrollment_installs LIMIT 1',
    );
    expect(bound?.install_id).toBe(installId);
    expect(bound?.node_token_hash).toBe(sha256(nodeToken));
    expect(bound?.redeemed_server_id).toBe(body.serverId);
  });

  it('idempotent: same installId + same nodeTokenHash replay returns same serverId', async () => {
    const app = buildApp();
    const userId = `u_${hex(4)}`;
    await createUser(db, userId);
    const o = await owner(userId);
    const mint = await app.request('/api/enroll/v2/ticket', {
      method: 'POST', headers: ticketHeaders(userId, o),
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

  it('serializes concurrent redemption of the same installer/install identity', async () => {
    const app = buildApp();
    const userId = `u_${hex(4)}`;
    await createUser(db, userId);
    const o = await owner(userId);
    await app.request('/api/enroll/v2/ticket', {
      method: 'POST', headers: ticketHeaders(userId, o),
      body: JSON.stringify({ version: 2, os: 'linux', arch: 'x64' }),
    });
    const { decryptBotConfig } = await import('../src/security/crypto.js');
    const row = await db.queryOne<{ encrypted_code: string }>('SELECT encrypted_code FROM controlled_node_enrollments_v2 LIMIT 1');
    const payload = {
      version: 2 as const,
      enrollToken: decryptBotConfig(row!.encrypted_code, TEST_ENCRYPTION_KEY).enrollCode,
      installId: `concurrent-${hex(4)}`,
      nodeTokenHash: sha256(hex(16)),
      hostname: 'concurrent-host',
      os: 'linux',
      arch: 'x64',
    };
    const responses = await Promise.all(Array.from({ length: 8 }, () => app.request('/api/enroll/v2/redeem', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
    })));
    expect(responses.every((response) => response.status === 200)).toBe(true);
    const serverIds = new Set(await Promise.all(responses.map(async (response) => (
      (await response.json() as { serverId: string }).serverId
    ))));
    expect(serverIds.size).toBe(1);
    const count = await db.queryOne<{ n: string }>(
      'SELECT COUNT(*)::text AS n FROM controlled_node_enrollment_installs',
    );
    expect(count?.n).toBe('1');
  });

  it('mismatch (same installId, different nodeTokenHash) returns generic 409 redeem failure', async () => {
    const app = buildApp();
    const userId = `u_${hex(4)}`;
    await createUser(db, userId);
    const o = await owner(userId);
    await app.request('/api/enroll/v2/ticket', {
      method: 'POST', headers: ticketHeaders(userId, o),
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

  it('different installIds with different token hashes create independent nodes from one package', async () => {
    const app = buildApp();
    const userId = `u_${hex(4)}`;
    await createUser(db, userId);
    const o = await owner(userId);
    await app.request('/api/enroll/v2/ticket', {
      method: 'POST', headers: ticketHeaders(userId, o),
      body: JSON.stringify({ version: 2, os: 'linux', arch: 'x64' }),
    });
    const { decryptBotConfig } = await import('../src/security/crypto.js');
    const row = await db.queryOne<{ encrypted_code: string }>('SELECT encrypted_code FROM controlled_node_enrollments_v2 LIMIT 1');
    const enrollCode = decryptBotConfig(row!.encrypted_code, TEST_ENCRYPTION_KEY).enrollCode;
    const firstNodeTokenHash = sha256(hex(16));
    const r1 = await app.request('/api/enroll/v2/redeem', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ version: 2, enrollToken: enrollCode, installId: 'inst-A', nodeTokenHash: firstNodeTokenHash, hostname: 'h-a', os: 'linux', arch: 'x64' }),
    });
    expect(r1.status).toBe(200);
    const first = await r1.json() as { serverId: string };
    const secondNodeTokenHash = sha256(hex(16));
    const r2 = await app.request('/api/enroll/v2/redeem', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ version: 2, enrollToken: enrollCode, installId: 'inst-B', nodeTokenHash: secondNodeTokenHash, hostname: 'h-b', os: 'linux', arch: 'x64' }),
    });
    expect(r2.status).toBe(200);
    const second = await r2.json() as { serverId: string };
    expect(second.serverId).not.toBe(first.serverId);

    const installs = await db.query<{ install_id: string; node_token_hash: string; redeemed_server_id: string }>(
      `SELECT install_id, node_token_hash, redeemed_server_id
         FROM controlled_node_enrollment_installs
        ORDER BY install_id`,
    );
    expect(installs).toEqual([
      { install_id: 'inst-A', node_token_hash: firstNodeTokenHash, redeemed_server_id: first.serverId },
      { install_id: 'inst-B', node_token_hash: secondNodeTokenHash, redeemed_server_id: second.serverId },
    ]);
  });

  it('rejects reusing one node token hash for another install under the same package', async () => {
    const app = buildApp();
    const userId = `u_${hex(4)}`;
    await createUser(db, userId);
    const o = await owner(userId);
    await app.request('/api/enroll/v2/ticket', {
      method: 'POST', headers: ticketHeaders(userId, o),
      body: JSON.stringify({ version: 2, os: 'linux', arch: 'x64' }),
    });
    const { decryptBotConfig } = await import('../src/security/crypto.js');
    const row = await db.queryOne<{ encrypted_code: string }>('SELECT encrypted_code FROM controlled_node_enrollments_v2 LIMIT 1');
    const enrollCode = decryptBotConfig(row!.encrypted_code, TEST_ENCRYPTION_KEY).enrollCode;
    const nodeTokenHash = sha256(hex(16));
    const first = await app.request('/api/enroll/v2/redeem', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ version: 2, enrollToken: enrollCode, installId: 'inst-A', nodeTokenHash, hostname: 'h-a', os: 'linux', arch: 'x64' }),
    });
    expect(first.status).toBe(200);
    const second = await app.request('/api/enroll/v2/redeem', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ version: 2, enrollToken: enrollCode, installId: 'inst-B', nodeTokenHash, hostname: 'h-b', os: 'linux', arch: 'x64' }),
    });
    expect(second.status).toBe(409);
    expect(await second.json()).toEqual({ error: 'redeem_failed' });
  });

  it('keeps a downloaded reusable package valid after its short-lived download ticket expires', async () => {
    const app = buildApp();
    const userId = `u_${hex(4)}`;
    await createUser(db, userId);
    const o = await owner(userId);
    await app.request('/api/enroll/v2/ticket', {
      method: 'POST', headers: ticketHeaders(userId, o),
      body: JSON.stringify({ version: 2, os: 'linux', arch: 'x64' }),
    });
    const { decryptBotConfig } = await import('../src/security/crypto.js');
    const row = await db.queryOne<{ encrypted_code: string; reusable: boolean; expires_at: string | null }>(
      'SELECT encrypted_code, reusable, expires_at FROM controlled_node_enrollments_v2 LIMIT 1',
    );
    expect(row?.reusable).toBe(true);
    expect(row?.expires_at).toBeNull();
    const enrollCode = decryptBotConfig(row!.encrypted_code, TEST_ENCRYPTION_KEY).enrollCode;
    await db.execute(
      'UPDATE controlled_node_enrollments_v2 SET ticket_expires_at = $1, consumed_at = $1',
      [Date.now() - 30 * 24 * 60 * 60 * 1000],
    );

    const redeem = await app.request('/api/enroll/v2/redeem', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        version: 2,
        enrollToken: enrollCode,
        installId: 'late-install',
        nodeTokenHash: sha256(hex(16)),
        hostname: 'late-host',
        os: 'linux',
        arch: 'x64',
      }),
    });
    expect(redeem.status).toBe(200);
  });

  it('rejects future installs after installer revocation without deleting an already enrolled node', async () => {
    const app = buildApp();
    const userId = `u_${hex(4)}`;
    await createUser(db, userId);
    const o = await owner(userId);
    await app.request('/api/enroll/v2/ticket', {
      method: 'POST', headers: ticketHeaders(userId, o),
      body: JSON.stringify({ version: 2, os: 'linux', arch: 'x64' }),
    });
    const { decryptBotConfig } = await import('../src/security/crypto.js');
    const row = await db.queryOne<{ id: string; encrypted_code: string }>(
      'SELECT id, encrypted_code FROM controlled_node_enrollments_v2 LIMIT 1',
    );
    const enrollCode = decryptBotConfig(row!.encrypted_code, TEST_ENCRYPTION_KEY).enrollCode;
    const first = await app.request('/api/enroll/v2/redeem', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ version: 2, enrollToken: enrollCode, installId: 'inst-A', nodeTokenHash: sha256(hex(16)), hostname: 'h-a', os: 'linux', arch: 'x64' }),
    });
    expect(first.status).toBe(200);
    const firstBody = await first.json() as { serverId: string };
    await db.execute('UPDATE controlled_node_enrollments_v2 SET revoked_at = $2 WHERE id = $1', [row!.id, Date.now()]);

    const second = await app.request('/api/enroll/v2/redeem', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ version: 2, enrollToken: enrollCode, installId: 'inst-B', nodeTokenHash: sha256(hex(16)), hostname: 'h-b', os: 'linux', arch: 'x64' }),
    });
    expect(second.status).toBe(401);
    const existing = await db.queryOne<{ id: string; revoked_at: string | null }>(
      'SELECT id, revoked_at FROM servers WHERE id = $1',
      [firstBody.serverId],
    );
    expect(existing).toEqual({ id: firstBody.serverId, revoked_at: null });
  });

  it('preserves legacy single-use and expiry semantics', async () => {
    const app = buildApp();
    const userId = `u_${hex(4)}`;
    await createUser(db, userId);
    const o = await owner(userId);
    await app.request('/api/enroll/v2/ticket', {
      method: 'POST', headers: ticketHeaders(userId, o),
      body: JSON.stringify({ version: 2, os: 'linux', arch: 'x64' }),
    });
    const { decryptBotConfig } = await import('../src/security/crypto.js');
    const row = await db.queryOne<{ encrypted_code: string }>('SELECT encrypted_code FROM controlled_node_enrollments_v2 LIMIT 1');
    const enrollCode = decryptBotConfig(row!.encrypted_code, TEST_ENCRYPTION_KEY).enrollCode;
    await db.execute(
      'UPDATE controlled_node_enrollments_v2 SET reusable = FALSE, expires_at = $1',
      [Date.now() + 60_000],
    );
    const first = await app.request('/api/enroll/v2/redeem', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ version: 2, enrollToken: enrollCode, installId: 'legacy-A', nodeTokenHash: sha256(hex(16)), hostname: 'legacy-a', os: 'linux', arch: 'x64' }),
    });
    expect(first.status).toBe(200);
    const second = await app.request('/api/enroll/v2/redeem', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ version: 2, enrollToken: enrollCode, installId: 'legacy-B', nodeTokenHash: sha256(hex(16)), hostname: 'legacy-b', os: 'linux', arch: 'x64' }),
    });
    expect(second.status).toBe(409);

    await db.execute(
      `UPDATE controlled_node_enrollments_v2
          SET used_at = NULL, redeemed_server_id = NULL, install_id = NULL,
              node_token_hash = NULL, expires_at = $1
        WHERE code_hash = $2`,
      [Date.now() - 1, sha256(enrollCode)],
    );
    await db.execute('DELETE FROM controlled_node_enrollment_installs');
    const expired = await app.request('/api/enroll/v2/redeem', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ version: 2, enrollToken: enrollCode, installId: 'legacy-C', nodeTokenHash: sha256(hex(16)), hostname: 'legacy-c', os: 'linux', arch: 'x64' }),
    });
    expect(expired.status).toBe(401);
  });

  it('os/arch mismatch on a valid ticket returns the same generic 409 conflict', async () => {
    const app = buildApp();
    const userId = `u_${hex(4)}`;
    await createUser(db, userId);
    const o = await owner(userId);
    await app.request('/api/enroll/v2/ticket', {
      method: 'POST', headers: ticketHeaders(userId, o),
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
    const headers = { 'X-Server-Id': o.serverId, authorization: `Bearer ${o.token}`, [EXPECTED_USER_ID_HEADER]: userId };

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
    const headers = { 'X-Server-Id': o.serverId, authorization: `Bearer ${o.token}`, [EXPECTED_USER_ID_HEADER]: userId };
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

  it('covers one canonical macOS Universal 2 artifact redeeming on an Intel runtime', async () => {
    await rm(join(exeDir, 'imcodes-node-macos'), { recursive: true, force: true });
    await writeFile(join(exeDir, 'imcodes-node-macos'), FAKE_BINARY);
    await writeManifest('imcodes-node-macos', 'darwin', 'universal');
    artifactCatalog = createArtifactCatalog();

    const app = buildApp();
    const userId = `u_${hex(4)}`;
    await createUser(db, userId);
    const o = await owner(userId);
    const headers = { 'X-Server-Id': o.serverId, authorization: `Bearer ${o.token}`, [EXPECTED_USER_ID_HEADER]: userId };
    const available = await app.request('/api/enroll/v2/availability', { headers });
    const catalog = await available.json() as { artifacts: Array<{ os: string; arch: string }> };
    expect(catalog.artifacts).toContainEqual(expect.objectContaining({ os: 'mac', arch: 'universal' }));

    const mint = await app.request('/api/enroll/v2/ticket', {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ version: 2, os: 'mac', arch: 'universal' }),
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
        hostname: 'mac-intel-proxy',
        os: 'mac',
        arch: 'x64',
      }),
    });
    expect(redeem.status).toBe(200);

    const armRedeem = await app.request('/api/enroll/v2/redeem', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        version: 2,
        enrollToken: enrollment!.enrollToken,
        installId: `install-${hex(8)}`,
        nodeTokenHash: sha256(`node-${hex(8)}`),
        hostname: 'mac-apple-silicon-proxy',
        os: 'mac',
        arch: 'arm64',
      }),
    });
    expect(armRedeem.status).toBe(200);
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

  it('retention keeps an active reusable installer after old ticket consumption and repeated redemption', async () => {
    const app = buildApp();
    const userId = `u_${hex(4)}`;
    await createUser(db, userId);
    const o = await owner(userId);
    await app.request('/api/enroll/v2/ticket', {
      method: 'POST', headers: ticketHeaders(userId, o),
      body: JSON.stringify({ version: 2, os: 'linux', arch: 'x64' }),
    });
    const { decryptBotConfig } = await import('../src/security/crypto.js');
    const row = await db.queryOne<{ id: string; encrypted_code: string }>(
      'SELECT id, encrypted_code FROM controlled_node_enrollments_v2 LIMIT 1',
    );
    const enrollCode = decryptBotConfig(row!.encrypted_code, TEST_ENCRYPTION_KEY).enrollCode;
    for (const installId of ['keep-A', 'keep-B']) {
      const response = await app.request('/api/enroll/v2/redeem', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ version: 2, enrollToken: enrollCode, installId, nodeTokenHash: sha256(hex(16)), hostname: installId, os: 'linux', arch: 'x64' }),
      });
      expect(response.status).toBe(200);
    }
    await db.execute(
      `UPDATE controlled_node_enrollments_v2
          SET consumed_at = $2, ticket_expires_at = $2
        WHERE id = $1`,
      [row!.id, Date.now() - 8 * 24 * 60 * 60 * 1000],
    );

    await runEnrollmentRetention(db);
    const kept = await db.queryOne<{ reusable: boolean; installs: string }>(
      `SELECT enrollment.reusable,
              COUNT(install.id)::text AS installs
         FROM controlled_node_enrollments_v2 AS enrollment
         LEFT JOIN controlled_node_enrollment_installs AS install
           ON install.enrollment_id = enrollment.id
        WHERE enrollment.id = $1
        GROUP BY enrollment.reusable`,
      [row!.id],
    );
    expect(kept).toEqual({ reusable: true, installs: '2' });
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
  /**
   * A revoked credential must be indistinguishable from an unknown one.
   *
   * This route authenticates independently of the central daemon-token
   * resolver, because it is one of the two HTTP calls a controlled node
   * legitimately makes (`src/node/self-upgrade.ts`). It used to answer a
   * revoked credential with 403 `revoked`, which confirmed to whoever held it
   * that the credential had once been real, and contradicted the policy the
   * central resolver enforces everywhere else.
   */
  it('answers a revoked credential exactly as it answers an unknown one', async () => {
    const app = buildApp();
    await writeFile(join(exeDir, 'imcodes-node-linux'), FAKE_BINARY);
    await writeManifest('imcodes-node-linux', 'linux', 'x64', FAKE_BINARY);
    const userId = `u_${hex(4)}`;
    await createUser(db, userId);

    const token = hex(16);
    const serverId = hex(8);
    await db.execute(
      `INSERT INTO servers (id, user_id, name, token_hash, status, created_at, node_role, exec_enabled, os, arch)
       VALUES ($1, $2, 'controlled-linux', $3, 'online', $4, $5, TRUE, 'linux', 'x64')`,
      [serverId, userId, sha256(token), Date.now(), NODE_ROLE.CONTROLLED],
    );
    const path = `/api/enroll/v2/node-artifact?serverId=${serverId}&os=linux&arch=x64`;
    const headers = { authorization: `Bearer ${token}`, 'X-Server-Id': serverId };

    // Live: the upgrade path a controlled node depends on must keep working.
    // The body MUST be consumed. This route streams from an open FileHandle that
    // production closes only at EOF, on error, or on cancel
    // (`server/src/routes/enroll.ts` bare-stream close path). Asserting only the
    // status leaves the descriptor pinned until GC finalizes it, which Node now
    // raises as ERR_INVALID_STATE — an unhandled error that fails the run while
    // every assertion still reports as passing.
    const live = await app.request(path, { headers });
    expect(live.status).toBe(200);
    expect(Buffer.from(await live.arrayBuffer()).equals(FAKE_BINARY)).toBe(true);

    await db.execute('UPDATE servers SET revoked_at = $1 WHERE id = $2', [Date.now(), serverId]);

    const revoked = await app.request(path, { headers });
    const unknown = await app.request(
      `/api/enroll/v2/node-artifact?serverId=${hex(8)}&os=linux&arch=x64`,
      { headers: { authorization: `Bearer ${hex(16)}`, 'X-Server-Id': hex(8) } },
    );
    expect(revoked.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(await revoked.text()).toBe(await unknown.text());
  });

  it('gzip-encodes self-upgrade bytes on demand while retaining decoded size and digest metadata', async () => {
    const app = buildApp();
    await writeFile(join(exeDir, 'imcodes-node-linux'), COMPRESSIBLE_FAKE_BINARY);
    await writeManifest('imcodes-node-linux', 'linux', 'x64', COMPRESSIBLE_FAKE_BINARY);
    const userId = `u_${hex(4)}`;
    await createUser(db, userId);
    const token = hex(16);
    const serverId = hex(8);
    await db.execute(
      `INSERT INTO servers (id, user_id, name, token_hash, status, created_at, node_role, exec_enabled, os, arch)
       VALUES ($1, $2, 'controlled-linux', $3, 'online', $4, $5, TRUE, 'linux', 'x64')`,
      [serverId, userId, sha256(token), Date.now(), NODE_ROLE.CONTROLLED],
    );

    const response = await app.request(`/api/enroll/v2/node-artifact?serverId=${serverId}&os=linux&arch=x64`, {
      headers: {
        authorization: `Bearer ${token}`,
        [ACCEPT_ENCODING_HEADER]: CONTROLLED_NODE_ARTIFACT_COMPRESSION_ENCODING,
      },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get(CONTENT_ENCODING_HEADER)).toBe(CONTROLLED_NODE_ARTIFACT_COMPRESSION_ENCODING);
    expect(response.headers.get('content-length')).toBeNull();
    expect(response.headers.get('vary')).toContain(ACCEPT_ENCODING_HEADER);
    expect(response.headers.get(CONTROLLED_NODE_ARTIFACT_HEADERS.SIZE_BYTES)).toBe(String(COMPRESSIBLE_FAKE_BINARY.length));
    expect(response.headers.get(CONTROLLED_NODE_ARTIFACT_HEADERS.SHA256)).toBe(sha256(COMPRESSIBLE_FAKE_BINARY));
    expect(gunzipSync(Buffer.from(await response.arrayBuffer()))).toEqual(COMPRESSIBLE_FAKE_BINARY);
  });

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

    const missingWorkerResponse = await app.request(`/api/enroll/v2/node-artifact?serverId=${serverId}&os=win&arch=x64`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(missingWorkerResponse.status).toBe(503);
    expect(await missingWorkerResponse.json()).toMatchObject({ error: 'remote_desktop_worker_not_built' });

    await writeRemoteDesktopRelease('0.1.2');
    const mismatchedWorkerResponse = await app.request(`/api/enroll/v2/node-artifact?serverId=${serverId}&os=win&arch=x64`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(mismatchedWorkerResponse.status).toBe(503);
    expect(await mismatchedWorkerResponse.json()).toEqual({ error: 'windows_release_version_mismatch' });

    const { workerBytes, virtualDisplayBytes, workerManifest, workerManifestBytes } = await writeRemoteDesktopRelease(
      '2026.7.1234-dev.5',
    );
    const response = await app.request(`/api/enroll/v2/node-artifact?serverId=${serverId}&os=win&arch=x64`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('x-imcodes-node-artifact-sha256')).toBe(sha256(FAKE_WINDOWS_SIGNED_PE));
    expect(response.headers.get('x-imcodes-node-artifact-version')).toBe('2026.7.1234-dev.5');
    expect(response.headers.get(CONTROLLED_NODE_ARTIFACT_HEADERS.AUTHENTICODE_SIGNER_SHA256))
      .toBe('c'.repeat(64));
    expect(Buffer.from(await response.arrayBuffer())).toEqual(FAKE_WINDOWS_SIGNED_PE);

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

    const workerResponse = await app.request(`/api/enroll/v2/node-artifact?serverId=${serverId}&os=win&arch=x64&asset=remote-desktop-worker`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(workerResponse.status).toBe(200);
    expect(workerResponse.headers.get('x-imcodes-node-artifact-filename')).toBe(REMOTE_DESKTOP_WORKER_FILENAME);
    expect(workerResponse.headers.get('x-imcodes-node-artifact-sha256')).toBe(sha256(workerBytes));
    expect(Buffer.from(await workerResponse.arrayBuffer())).toEqual(workerBytes);
    const workerManifestResponse = await app.request(`/api/enroll/v2/node-artifact?serverId=${serverId}&os=win&arch=x64&asset=remote-desktop-worker-manifest`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(workerManifestResponse.status).toBe(200);
    expect(workerManifestResponse.headers.get('x-imcodes-node-artifact-filename')).toBe(`${REMOTE_DESKTOP_WORKER_FILENAME}${REMOTE_DESKTOP_WORKER_MANIFEST_SUFFIX}`);
    const legacyManifestBytes = Buffer.from(await workerManifestResponse.arrayBuffer());
    expect(JSON.parse(legacyManifestBytes.toString('utf8'))).toEqual({
      ...workerManifest,
      protocolVersion: REMOTE_DESKTOP_LEGACY_UPGRADE_PROTOCOL_VERSION,
    });
    expect(workerManifestResponse.headers.get('x-imcodes-node-artifact-sha256'))
      .toBe(sha256(legacyManifestBytes));

    const currentWorkerManifestResponse = await app.request(`/api/enroll/v2/node-artifact?serverId=${serverId}&os=win&arch=x64&asset=remote-desktop-worker-manifest`, {
      headers: {
        authorization: `Bearer ${token}`,
        [CONTROLLED_NODE_ARTIFACT_HEADERS.REMOTE_DESKTOP_PROTOCOL_VERSION]: '2',
      },
    });
    expect(currentWorkerManifestResponse.status).toBe(200);
    expect(currentWorkerManifestResponse.headers.get('vary'))
      .toBe(CONTROLLED_NODE_ARTIFACT_HEADERS.REMOTE_DESKTOP_PROTOCOL_VERSION);
    expect(Buffer.from(await currentWorkerManifestResponse.arrayBuffer())).toEqual(workerManifestBytes);
    const duplicatedCurrentProtocolResponse = await app.request(`/api/enroll/v2/node-artifact?serverId=${serverId}&os=win&arch=x64&asset=remote-desktop-worker-manifest`, {
      headers: {
        authorization: `Bearer ${token}`,
        [CONTROLLED_NODE_ARTIFACT_HEADERS.REMOTE_DESKTOP_PROTOCOL_VERSION]: '2, 2',
      },
    });
    expect(duplicatedCurrentProtocolResponse.status).toBe(200);
    expect(Buffer.from(await duplicatedCurrentProtocolResponse.arrayBuffer())).toEqual(workerManifestBytes);
    const unsupportedWorkerManifestResponse = await app.request(`/api/enroll/v2/node-artifact?serverId=${serverId}&os=win&arch=x64&asset=remote-desktop-worker-manifest`, {
      headers: {
        authorization: `Bearer ${token}`,
        [CONTROLLED_NODE_ARTIFACT_HEADERS.REMOTE_DESKTOP_PROTOCOL_VERSION]: '99',
      },
    });
    expect(unsupportedWorkerManifestResponse.status).toBe(409);
    const virtualDisplayResponse = await app.request(`/api/enroll/v2/node-artifact?serverId=${serverId}&os=win&arch=x64&asset=remote-desktop-virtual-display`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(virtualDisplayResponse.status).toBe(200);
    expect(virtualDisplayResponse.headers.get('x-imcodes-node-artifact-filename')).toBe('imcodes-virtual-display.zip');
    expect(Buffer.from(await virtualDisplayResponse.arrayBuffer())).toEqual(virtualDisplayBytes);

    const macToken = hex(16);
    const macServerId = hex(8);
    await db.execute(
      `INSERT INTO servers (id, user_id, name, token_hash, status, created_at, node_role, exec_enabled, os, arch)
       VALUES ($1, $2, 'controlled-mac-arm', $3, 'online', $4, $5, TRUE, 'mac', 'arm64')`,
      [macServerId, userId, sha256(macToken), Date.now(), NODE_ROLE.CONTROLLED],
    );
    const macArchiveBytes = Buffer.from('SIGNED_OPEN_COMPUTER_USE_APP_ARCHIVE');
    await mkdir(join(exeDir, 'computer-use-helper', 'darwin-universal'), { recursive: true });
    await writeFile(
      join(exeDir, 'computer-use-helper', 'darwin-universal', 'open-computer-use.app.zip'),
      macArchiveBytes,
    );
    const macHelperResponse = await app.request(
      `/api/enroll/v2/node-artifact?serverId=${macServerId}&os=mac&arch=universal&asset=computer-use-helper`,
      { headers: { authorization: `Bearer ${macToken}` } },
    );
    expect(macHelperResponse.status).toBe(200);
    expect(macHelperResponse.headers.get('x-imcodes-node-artifact-filename')).toBe('open-computer-use.app.zip');
    expect(macHelperResponse.headers.get('x-imcodes-node-artifact-sha256')).toBe(sha256(macArchiveBytes));
    expect(Buffer.from(await macHelperResponse.arrayBuffer())).toEqual(macArchiveBytes);

    const legacyMacHelperResponse = await app.request(
      `/api/enroll/v2/node-artifact?serverId=${macServerId}&os=mac&arch=arm64&asset=computer-use-helper`,
      { headers: { authorization: `Bearer ${macToken}` } },
    );
    expect(legacyMacHelperResponse.status).toBe(200);
    expect(Buffer.from(await legacyMacHelperResponse.arrayBuffer())).toEqual(macArchiveBytes);
  });

  it('admits full daemon tokens for the remote-desktop bundle and the runtime that hosts it', async () => {
    const app = buildApp();
    const userId = `u_${hex(4)}`;
    await createUser(db, userId);
    const full = await owner(userId);
    // The runtime carries the elevated remote-desktop helper, which cannot be
    // executed out of the daemon's user-writable npm directory.
    const fullResponse = await app.request(`/api/enroll/v2/node-artifact?serverId=${full.serverId}&os=win&arch=x64`, {
      headers: { authorization: `Bearer ${full.token}` },
    });
    expect(fullResponse.status).not.toBe(403);

    // The worker bundle is the one artifact family a normal daemon may fetch:
    // on Windows it serves remote control with the same native worker. Only the
    // role gate is asserted here — whether the artifact is built on this host is
    // a separate concern, so anything but `forbidden` proves the gate opened.
    const workerResponse = await app.request(
      `/api/enroll/v2/node-artifact?serverId=${full.serverId}&os=win&arch=x64&asset=remote-desktop-worker`,
      { headers: { authorization: `Bearer ${full.token}` } },
    );
    expect(workerResponse.status).not.toBe(403);

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
