import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { type FileHandle } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import type { Env } from '../env.js';
import type { Database } from '../db/client.js';
import { randomHex, sha256Hex, encryptBotConfig, decryptBotConfig } from '../security/crypto.js';
import { logAudit } from '../security/audit.js';
import { requireAuth } from '../security/authorization.js';
import logger from '../util/logger.js';
import { NODE_ROLE, encodeEnrollmentTrailer, isEnrollmentNodeTokenHash } from '../../../shared/remote-exec.js';
import { deriveRefName, deriveDisplayName } from '../../../shared/machine-reference.js';
import {
  isCanonicalControlledNodePair,
  isControlledNodeArch,
  isControlledNodeOs,
  type ControlledNodeArch,
  type ControlledNodeOs,
} from '../../../shared/controlled-node-artifacts.js';
import {
  createArtifactCatalog,
  defaultArtifactCatalog,
  type ArtifactCatalog,
} from '../services/controlled-node-artifact-catalog.js';

function resolveTicketEncryptionKey(c: { env: Env }): string {
  const key = c.env.BOT_ENCRYPTION_KEY;
  if (!key) throw new Error('BOT_ENCRYPTION_KEY required for v2 ticket issuance');
  return key;
}

type EnrollRouter = Hono<{ Bindings: Env; Variables: { userId: string; role: string } }>;

const ENROLL_TTL_MS = 30 * 60 * 1000;
const DOWNLOAD_TICKET_TTL_MS = 5 * 60 * 1000;
const TICKET_MAX_CONSUMES = 3;
const ATTEMPT_LEASE_MS = 30 * 1000;

function resolveCanonicalServerUrl(c: { req: { url: string }; env: Env }): string | null {
  const envName = c.env.NODE_ENV ?? 'development';
  const configured = c.env.SERVER_URL?.trim();
  if (envName === 'production' && !configured) return null;
  try {
    const url = new URL(configured || new URL(c.req.url).origin);
    if (url.username || url.password || url.search || url.hash) return null;
    if (envName === 'production') {
      if (url.protocol !== 'https:') return null;
    } else if (!isAllowedServerUrl(url.origin)) {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}

function checkOrigin(c: { req: { url: string }; env: Env }): { ok: true } | { ok: false; reason: string } {
  return resolveCanonicalServerUrl(c)
    ? { ok: true }
    : { ok: false, reason: 'canonical_server_url_required' };
}

function isAllowedServerUrl(value: string): boolean {
  if (/^https:\/\//.test(value)) return true;
  if (/^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?\/?$/.test(value)) return true;
  return false;
}

// ── POST /api/enroll/v2/ticket ──────────────────────────────────────────────

const TICKET_BODY = z
  .object({ version: z.literal(2), os: z.string(), arch: z.string() })
  .strict();

export function createEnrollRoutes(
  artifactCatalog: ArtifactCatalog = createArtifactCatalog(),
): EnrollRouter {
  const enrollRoutes: EnrollRouter = new Hono();

enrollRoutes.post('/v2/ticket', requireAuth(), async (c) => {
  const originCheck = checkOrigin(c);
  if (!originCheck.ok) return c.json({ error: originCheck.reason }, 403);

  const userId = c.get('userId' as never) as string;
  const body = await c.req.json().catch(() => null);
  const parsed = TICKET_BODY.safeParse(body);
  if (!parsed.success) return c.json({ error: 'invalid_body' }, 400);
  const { os, arch } = parsed.data;
  if (!isControlledNodeOs(os) || !isControlledNodeArch(arch) || !isCanonicalControlledNodePair(os, arch)) {
    return c.json({ error: 'invalid_body' }, 400);
  }

  const dir = process.env.IMCODES_NODE_EXE_DIR;
  if (!dir) return c.json({ error: 'executable_dir_not_configured' }, 503);

  // Single-flight verification caches descriptors only; mint never borrows a
  // stream handle that could later be closed underneath a download.
  const v = await artifactCatalog.ensureVerified(dir, os, arch);
  if (!v.ok) return c.json({ error: 'executable_not_built', os, arch }, 503);
  // Persist the descriptor so /v2/availability and downstream tooling can
  // read it without re-hashing. Best-effort; not on the critical mint path.
  await artifactCatalog.persistDescriptor(c.env.DB as Database, v.descriptor).catch(() => {});

  const serverUrl = resolveCanonicalServerUrl(c);
  if (!serverUrl) return c.json({ error: 'canonical_server_url_required' }, 403);

  const enrollCode = randomHex(32);
  const codeHash = sha256Hex(enrollCode);
  const rawTicket = randomHex(32);
  const ticketHash = sha256Hex(rawTicket);
  const encryptionKey = resolveTicketEncryptionKey(c);
  const encryptedCode = encryptBotConfig(
    { enrollCode, codeHash, os, arch, serverUrl },
    encryptionKey,
  );

  const now = Date.now();
  const expiresAt = now + ENROLL_TTL_MS;
  const ticketExpiresAt = now + DOWNLOAD_TICKET_TTL_MS;

  const inserted = await (c.env.DB as Database).queryOne<{ id: string }>(
    `INSERT INTO controlled_node_enrollments_v2
       (ticket_hash, code_hash, owner_user_id, os, arch, artifact_sha256,
        encrypted_code, consumed_count, max_consumes, ticket_expires_at, expires_at, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 0, $8, $9, $10, $11)
     RETURNING id`,
    [ticketHash, codeHash, userId, os, arch, v.descriptor.sha256,
     encryptedCode, TICKET_MAX_CONSUMES, ticketExpiresAt, expiresAt, now],
  );
  if (!inserted) {
    return c.json({ error: 'ticket_mint_failed' }, 500);
  }

  // Fire-and-forget mint audit (event is non-state-bearing, post-commit).
  logAudit({
    userId,
    action: 'enroll.v2.ticket.mint',
    ip: (c.get('clientIp' as never) as string) ?? 'unknown',
    details: { ticketId: inserted.id, os, arch, artifactSha256: v.descriptor.sha256, ticketExpiresAt },
  }, c.env.DB).catch(() => {});

  return c.json({
    ticketId: inserted.id,
    ticket: rawTicket,
    version: 2,
    os,
    arch,
    filename: v.descriptor.filename,
    sizeBytes: v.descriptor.sizeBytes,
    sha256: v.descriptor.sha256,
    maxConsumes: TICKET_MAX_CONSUMES,
    expiresAt: ticketExpiresAt,
  });
});

// ── GET /api/enroll/v2/download (bearer) ───────────────────────────────────

const BEARER_RE = /^Bearer\s+([A-Za-z0-9_-]{8,128})$/;
const DOWNLOAD_BODY = z.object({ ticket: z.string().min(8).max(128) }).strict();

/** Pull ticket from JSON POST body first, then form-urlencoded, then Bearer. */
async function readTicket(c: Context): Promise<string | null> {
  const contentType = c.req.header('content-type') ?? '';
  if (c.req.method === 'POST') {
    if (contentType.includes('application/json')) {
      const body = await c.req.json().catch(() => null);
      const parsed = DOWNLOAD_BODY.safeParse(body);
      if (parsed.success) return parsed.data.ticket;
    } else if (contentType.includes('application/x-www-form-urlencoded')) {
      const raw = await c.req.text();
      const params = new URLSearchParams(raw);
      const t = params.get('ticket');
      if (t && t.length >= 8 && t.length <= 128 && /^[A-Za-z0-9_-]+$/.test(t)) return t;
    }
  }
  const auth = c.req.header('Authorization') ?? '';
  const m = BEARER_RE.exec(auth);
  if (m && m[1]) return m[1];
  return null;
}

async function preConsumeGate(c: Context): Promise<Response | null> {
  const originCheck = checkOrigin(c);
  if (!originCheck.ok) return c.json({ error: originCheck.reason }, 403);
  if (c.req.header('range')) {
    c.header('Content-Range', 'bytes */0');
    return c.body(null as unknown as ArrayBuffer, 416);
  }
  return null;
}

// ── Reservation + transaction + FD lifecycle ────────────────────────────────

interface DownloadCommit {
  ticketId: string;
  ownerUserId: string;
  os: string;
  arch: string;
  artifactSha256: string;
  encryptedCode: string;
  attemptId: string;
  ip: string;
}

/** Reserve one of the ticket's three slots in a short row-locked transaction. */
async function reserveAttempt(
  db: Database,
  ticketHash: string,
  ip: string,
  now: number,
): Promise<DownloadCommit | null> {
  return db.transaction(async (tx) => {
    // Lock the parent row.
    const candidate = await tx.queryOne<{
      id: string; owner_user_id: string; os: string; arch: string;
      artifact_sha256: string; encrypted_code: string;
    }>(
      `SELECT id, owner_user_id, os, arch, artifact_sha256, encrypted_code
         FROM controlled_node_enrollments_v2
        WHERE ticket_hash = $1
          AND revoked_at IS NULL
          AND ticket_expires_at > $2
        FOR UPDATE`,
      [ticketHash, now],
    );
    if (!candidate) return null;

    const capacity = await tx.queryOne<{ admitted: boolean }>(
      `SELECT (
         enrollment.consumed_count + (
           SELECT count(*)::int
             FROM controlled_node_download_attempts AS attempt
            WHERE attempt.ticket_id = enrollment.id
              AND attempt.state = 'reserved'
              AND attempt.lease_expires_at >= $2
         ) < enrollment.max_consumes
       ) AS admitted
         FROM controlled_node_enrollments_v2 AS enrollment
        WHERE enrollment.id = $1`,
      [candidate.id, now],
    );
    if (!capacity?.admitted) return null;

    const attemptInsert = await tx.queryOne<{ attempt_id: string }>(
      `INSERT INTO controlled_node_download_attempts
         (ticket_id, owner_user_id, state, lease_expires_at, consumed_count_after, last_consume_ip, created_at, updated_at)
       VALUES ($1, $2, 'reserved', $3, $4, $5, $6, $6)
       RETURNING attempt_id`,
      [candidate.id, candidate.owner_user_id, now + ATTEMPT_LEASE_MS, 0, ip, now],
    );
    if (!attemptInsert) return null;

    return {
      ticketId: candidate.id,
      ownerUserId: candidate.owner_user_id,
      os: candidate.os,
      arch: candidate.arch,
      artifactSha256: candidate.artifact_sha256,
      encryptedCode: candidate.encrypted_code,
      attemptId: attemptInsert.attempt_id,
      ip,
    };
  });
}

/** Commit count + attempt + semantic consume audit atomically before bytes. */
async function commitAttempt(db: Database, reservation: DownloadCommit, now: number): Promise<boolean> {
  return db.transaction(async (tx) => {
    // Lock/revalidate the parent first. reserveAttempt uses the same lock
    // order, so admission and commitment cannot oversubscribe max_consumes.
    const parent = await tx.queryOne<{ consumed_count: number }>(
      `UPDATE controlled_node_enrollments_v2
          SET consumed_count = consumed_count + 1,
              consumed_at = CASE WHEN consumed_count + 1 >= max_consumes THEN $2 ELSE consumed_at END,
              last_consume_ip = $3
        WHERE id = $1
          AND revoked_at IS NULL
          AND ticket_expires_at > $2
          AND consumed_count < max_consumes
        RETURNING consumed_count`,
      [reservation.ticketId, now, reservation.ip],
    );
    if (!parent) return false;
    const updated = await tx.execute(
      `UPDATE controlled_node_download_attempts
          SET state = 'committed', committed_at = $2, updated_at = $2,
              consumed_count_after = $3
        WHERE attempt_id = $1 AND state = 'reserved'`,
      [reservation.attemptId, now, parent.consumed_count],
    );
    if (updated.changes !== 1) {
      // Throw so the parent increment is rolled back with this transaction.
      throw new Error('download_attempt_not_reserved');
    }
    await tx.execute(
      `INSERT INTO audit_log (id, user_id, server_id, action, details, ip, created_at)
       VALUES ($1, $2, NULL, $3, $4, $5, $6)`,
      [
        randomHex(16),
        reservation.ownerUserId,
        'enroll.v2.ticket.consume',
        JSON.stringify({
          ticketId: reservation.ticketId,
          attemptId: reservation.attemptId,
          os: reservation.os,
          arch: reservation.arch,
          consumedCountAfter: parent.consumed_count,
          artifactSha256: reservation.artifactSha256,
        }),
        reservation.ip,
        now,
      ],
    );
    return true;
  });
}

/** Release a still-`reserved` attempt.
 *  Idempotent and safe to call multiple times. Used for pre-stream
 *  failures (decrypt, trailer, etc.) where the response has not begun. */
async function releaseAttempt(
  db: Database,
  attemptId: string,
  parentTicketId: string,
  ip: string,
  now: number,
): Promise<void> {
  await db.transaction(async (tx) => {
    const upd = await tx.queryOne<{ attempt_id: string; owner_user_id: string }>(
      `UPDATE controlled_node_download_attempts
          SET state = 'released', released_at = $2, updated_at = $2
        WHERE attempt_id = $1 AND state = 'reserved'
        RETURNING attempt_id, owner_user_id`,
      [attemptId, now],
    );
    if (!upd) return; // already committed / released / expired; nothing to do
    await tx.execute(
      `INSERT INTO audit_log (id, user_id, server_id, action, details, ip, created_at)
       VALUES ($1, $2, NULL, $3, $4, $5, $6)`,
      [
        randomHex(16),
        upd.owner_user_id,
        'enroll.v2.ticket.release',
        JSON.stringify({ ticketId: parentTicketId, attemptId, reason: 'pre_stream_failure' }),
        ip,
        now,
      ],
    );
  });
}

/**
 * Build the trailer + binary into one Web ReadableStream. A native pull/cancel
 * adapter gives us an explicit close path for EOF, read error and client abort.
 */
function buildArtifactStream(
  handle: FileHandle,
  sizeBytes: number,
  trailer: Buffer,
  closeOnce: () => Promise<void>,
): ReadableStream<Uint8Array> {
  let position = 0;
  let trailerSent = false;
  const buffer = Buffer.alloc(64 * 1024);
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        if (position < sizeBytes) {
          const length = Math.min(buffer.length, sizeBytes - position);
          const { bytesRead } = await handle.read(buffer, 0, length, position);
          if (bytesRead <= 0) throw new Error('artifact_stream_ended_early');
          position += bytesRead;
          controller.enqueue(Buffer.from(buffer.subarray(0, bytesRead)));
          return;
        }
        if (!trailerSent) {
          trailerSent = true;
          controller.enqueue(Buffer.from(trailer));
          return;
        }
        await closeOnce();
        controller.close();
      } catch (error) {
        await closeOnce();
        controller.error(error);
      }
    },
    async cancel() {
      await closeOnce();
    },
  });
}

// ── Consume + stream: reservation → pre-stream checks → committed → stream ─

async function consumeAndStream(c: Context, rawTicket: string): Promise<Response> {
  const ticketHash = sha256Hex(rawTicket);
  const now = Date.now();
  const ip = (c.get('clientIp' as never) as string) ?? 'unknown';

  // Step 1: pre-check via single-flight reservation. This also serializes
  // concurrent requests for the same ticket via SELECT ... FOR UPDATE.
  const reservation = await reserveAttempt(c.env.DB as Database, ticketHash, ip, now);
  if (!reservation) {
    return c.json({ error: 'invalid_or_expired_ticket' }, 401);
  }

  // Step 2: single-flight hash + open FD. Use the same (dir, os, arch) key
  // the catalog already keyed on for ticket mint; concurrent downloads of
  // the same ticket and concurrent mints will share the verification.
  const dir = process.env.IMCODES_NODE_EXE_DIR;
  if (!dir) {
    await releaseAttempt(c.env.DB as Database, reservation.attemptId, reservation.ticketId, ip, now);
    return c.json({ error: 'executable_dir_not_configured' }, 503);
  }
  if (!isControlledNodeOs(reservation.os)
    || !isControlledNodeArch(reservation.arch)
    || !isCanonicalControlledNodePair(reservation.os, reservation.arch)) {
    await releaseAttempt(c.env.DB as Database, reservation.attemptId, reservation.ticketId, ip, now);
    return c.json({ error: 'unsupported_artifact' }, 500);
  }
  const downloadOs: ControlledNodeOs = reservation.os;
  const downloadArch: ControlledNodeArch = reservation.arch;
  const v = await artifactCatalog.ensureVerified(dir, downloadOs, downloadArch);
  if (!v.ok) {
    await releaseAttempt(c.env.DB as Database, reservation.attemptId, reservation.ticketId, ip, now);
    logAudit({
      userId: reservation.ownerUserId,
      action: 'enroll.v2.artifact.digest_mismatch',
      ip,
      details: {
        ticketId: reservation.ticketId, attemptId: reservation.attemptId,
        os: reservation.os, arch: reservation.arch,
        pinnedSha256: reservation.artifactSha256, actualSha256: v.actualSha,
        reason: v.reason,
      },
    }, c.env.DB).catch(() => {});
    return c.json({ error: 'artifact_digest_mismatch' }, 503);
  }
  if (v.descriptor.sha256 !== reservation.artifactSha256) {
    // Stale manifest pin; release the slot and surface the mismatch.
    artifactCatalog.invalidate(dir, downloadOs, downloadArch);
    await releaseAttempt(c.env.DB as Database, reservation.attemptId, reservation.ticketId, ip, now);
    return c.json({ error: 'artifact_digest_mismatch' }, 503);
  }

  // Step 3: cheap post-verify transforms. No stream descriptor is open yet.
  let encryptionKey: string;
  try {
    encryptionKey = resolveTicketEncryptionKey(c);
  } catch {
    await releaseAttempt(c.env.DB as Database, reservation.attemptId, reservation.ticketId, ip, now);
    return c.json({ error: 'ticket_encryption_key_unavailable' }, 500);
  }
  let enrollCode: string;
  let serverUrl: string;
  try {
    const decrypted = decryptBotConfig(reservation.encryptedCode, encryptionKey);
    enrollCode = decrypted.enrollCode;
    serverUrl = decrypted.serverUrl;
    if (!enrollCode || !serverUrl || !isAllowedServerUrl(serverUrl)) {
      throw new Error('decrypted_ticket_payload_invalid');
    }
    if ((c.env.NODE_ENV ?? 'development') === 'production' && new URL(serverUrl).protocol !== 'https:') {
      throw new Error('decrypted_ticket_server_url_insecure');
    }
  } catch {
    await releaseAttempt(c.env.DB as Database, reservation.attemptId, reservation.ticketId, ip, now);
    logAudit({
      userId: reservation.ownerUserId,
      action: 'enroll.v2.ticket.decrypt_failed',
      ip,
      details: {
        ticketId: reservation.ticketId,
        attemptId: reservation.attemptId,
        os: reservation.os,
        arch: reservation.arch,
      },
    }, c.env.DB).catch(() => {});
    return c.json({ error: 'ticket_decrypt_failed' }, 500);
  }

  const filename = v.descriptor.filename;
  const actualSize = v.descriptor.sizeBytes;
  let trailer: Buffer;
  try {
    trailer = encodeEnrollmentTrailer({ serverUrl, enrollToken: enrollCode });
  } catch {
    await releaseAttempt(c.env.DB as Database, reservation.attemptId, reservation.ticketId, ip, now);
    return c.json({ error: 'enrollment_trailer_failed' }, 500);
  }

  const opened = await artifactCatalog.openPinned(dir, v.descriptor);
  if (!opened) {
    artifactCatalog.invalidate(dir, downloadOs, downloadArch);
    await releaseAttempt(c.env.DB as Database, reservation.attemptId, reservation.ticketId, ip, now);
    return c.json({ error: 'artifact_digest_mismatch' }, 503);
  }

  // Step 4: commit attempt + consume audit before response bytes. Audit/commit
  // failure is pre-response, so close/release and return a retryable 503.
  try {
    const committed = await commitAttempt(c.env.DB as Database, reservation, now);
    if (!committed) throw new Error('download_attempt_not_reserved');
  } catch {
    await opened.close();
    await releaseAttempt(c.env.DB as Database, reservation.attemptId, reservation.ticketId, ip, now);
    return c.json({ error: 'ticket_consume_unavailable' }, 503);
  }

  const total = actualSize + trailer.length;
  c.header('Content-Length', String(total));
  c.header('Content-Type', 'application/octet-stream');
  c.header('Content-Disposition', `attachment; filename="${filename}"`);
  c.header('Cache-Control', 'private, no-store');
  c.header('Referrer-Policy', 'no-referrer');
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('Accept-Ranges', 'none');

  // Step 5: stream. safeCloseOnce guarantees a single FD close across the
  // ReadableStream's normal end, stream error, and explicit cancellation.
  const stream = buildArtifactStream(opened.handle, actualSize, trailer, opened.close);
  return c.body(stream as unknown as ReadableStream, 200);
}

enrollRoutes.post('/v2/download', async (c) => {
  const gate = await preConsumeGate(c);
  if (gate) return gate;
  const rawTicket = await readTicket(c);
  if (!rawTicket) return c.json({ error: 'missing_ticket' }, 401);
  return consumeAndStream(c, rawTicket);
});

enrollRoutes.get('/v2/download', async (c) => {
  const gate = await preConsumeGate(c);
  if (gate) return gate;
  const auth = c.req.header('Authorization') ?? '';
  const m = BEARER_RE.exec(auth);
  if (!m || !m[1]) return c.json({ error: 'missing_or_invalid_ticket' }, 401);
  return consumeAndStream(c, m[1]);
});

// ── GET /api/enroll/v2/bootstrap (system-browser bridge) ──────────────────

enrollRoutes.get('/v2/bootstrap', async (c) => {
  const originCheck = checkOrigin(c);
  if (!originCheck.ok) return c.json({ error: originCheck.reason }, 403);

  const nonce = randomBytes(16).toString('base64');
  c.header('Content-Type', 'text/html; charset=utf-8');
  c.header('Cache-Control', 'no-store, no-cache, must-revalidate, private, max-age=0');
  c.header('Pragma', 'no-cache');
  c.header('Referrer-Policy', 'no-referrer');
  c.header('Content-Security-Policy',
    `default-src 'none'; ` +
    `script-src 'nonce-${nonce}'; ` +
    `style-src 'nonce-${nonce}'; ` +
    `form-action 'self'; ` +
    `base-uri 'none'; ` +
    `frame-ancestors 'none'; ` +
    `navigate-to 'self'`,
  );
  c.header('X-Content-Type-Options', 'nosniff');

  const scriptBody =
    "(function(){"
    + "var p=location.hash.slice(1);"
    + "var m=p.match(/(?:^|&)ticket=([A-Za-z0-9_-]+)/);"
    + "if(!m){document.body.textContent='missing ticket';return}"
    + "var t=m[1];"
    + "try{history.replaceState(null,'',location.pathname+location.search)}catch(e){}"
    + "var f=document.createElement('form');"
    + "f.method='POST';"
    + "f.action='/api/enroll/v2/download';"
    + "f.style.display='none';"
    + "var i=document.createElement('input');"
    + "i.type='hidden';"
    + "i.name='ticket';"
    + "i.value=t;"
    + "f.appendChild(i);"
    + "document.body.appendChild(f);"
    + "f.submit();"
    + "})();";

  const html =
    `<!doctype html><html><head><meta charset="utf-8"><title>Download</title></head>` +
    `<body><noscript>This endpoint requires JavaScript.</noscript>` +
    `<script nonce="${nonce}">${scriptBody}</script>` +
    `</body></html>`;
  return c.body(html, 200);
});

const REDEEM_BODY = z
  .object({
    version: z.literal(2),
    enrollToken: z.string().min(1).max(128),
    installId: z.string().min(1).max(128),
    nodeTokenHash: z.string().refine(isEnrollmentNodeTokenHash, 'invalid_node_token_hash'),
    hostname: z.string().min(1).max(255),
    os: z.string().min(1).max(64),
    arch: z.string().min(1).max(16),
  })
  .strict();

async function insertControlledServer(
  tx: Database,
  serverId: string,
  userId: string,
  tokenHash: string,
  hostname: string,
  os: string,
  arch: string,
): Promise<{ refName: string; displayName: string }> {
  const refName = deriveRefName(hostname, serverId);
  const displayName = deriveDisplayName(hostname, os);
  await tx.execute(
    `INSERT INTO servers (id, user_id, name, token_hash, status, created_at, node_role, exec_enabled, ref_name, display_name, os, arch)
     VALUES ($1, $2, $3, $4, 'offline', $5, $6, true, $7, $8, $9, $10)`,
    [serverId, userId, displayName, tokenHash, Date.now(), NODE_ROLE.CONTROLLED, refName, displayName, os, arch],
  );
  return { refName, displayName };
}

type RedeemResult =
  | { kind: 'created'; serverId: string; ticketId: string; userId: string; refName: string; displayName: string }
  | { kind: 'idempotent'; serverId: string; ticketId: string; userId: string; refName: string; displayName: string }
  | { kind: 'mismatch'; existingInstallId: string | null; existingNodeTokenHash: string | null; ticketId?: string }
  | { kind: 'denied' };

enrollRoutes.post('/v2/redeem', async (c) => {
  const originCheck = checkOrigin(c);
  if (!originCheck.ok) return c.json({ error: originCheck.reason }, 403);

  const body = await c.req.json().catch(() => null);
  const parsed = REDEEM_BODY.safeParse(body);
  if (!parsed.success) return c.json({ error: 'invalid_body' }, 400);
  const { enrollToken, installId, nodeTokenHash, hostname, os, arch } = parsed.data;
  if (!isControlledNodeOs(os) || !isControlledNodeArch(arch) || !isCanonicalControlledNodePair(os, arch)) {
    return c.json({ error: 'invalid_body' }, 400);
  }
  const codeHash = sha256Hex(enrollToken);

  const now = Date.now();
  let result: RedeemResult;
  try {
    result = await c.env.DB.transaction(async (tx) => {
      const row = await tx.queryOne<{
        id: string;
        owner_user_id: string;
        expires_at: string;
        used_at: string | null;
        redeemed_server_id: string | null;
        install_id: string | null;
        node_token_hash: string | null;
        os: string;
        arch: string;
      }>(
        `SELECT id, owner_user_id, expires_at, used_at, redeemed_server_id,
                install_id, node_token_hash, os, arch
           FROM controlled_node_enrollments_v2
          WHERE code_hash = $1
          FOR UPDATE`,
        [codeHash],
      );
      if (!row) return { kind: 'denied' as const };
      if (Number(row.expires_at) <= now) return { kind: 'denied' as const };
      if (row.os !== os || row.arch !== arch) {
        return { kind: 'mismatch' as const, existingInstallId: row.install_id, existingNodeTokenHash: row.node_token_hash, ticketId: row.id };
      }

      if (row.used_at && row.redeemed_server_id) {
        if (row.install_id === installId && row.node_token_hash === nodeTokenHash) {
          const srv = await tx.queryOne<{ ref_name: string | null; display_name: string | null }>(
            'SELECT ref_name, display_name FROM servers WHERE id = $1',
            [row.redeemed_server_id],
          );
          return {
            kind: 'idempotent' as const,
            serverId: row.redeemed_server_id,
            ticketId: row.id,
            userId: row.owner_user_id,
            refName: srv?.ref_name ?? '',
            displayName: srv?.display_name ?? '',
          };
        }
        return {
          kind: 'mismatch' as const,
          existingInstallId: row.install_id,
          existingNodeTokenHash: row.node_token_hash,
          ticketId: row.id,
        };
      }

      const serverId = randomHex(16);
      const { refName, displayName } = await insertControlledServer(
        tx, serverId, row.owner_user_id, nodeTokenHash, hostname, os, arch,
      );
      const upd = await tx.execute(
        `UPDATE controlled_node_enrollments_v2
            SET used_at = $2,
                install_id = $3,
                node_token_hash = $4,
                redeemed_server_id = $5
          WHERE id = $1 AND used_at IS NULL AND expires_at > $2`,
        [row.id, now, installId, nodeTokenHash, serverId],
      );
      if (upd.changes !== 1) {
        throw new Error('concurrent_redeem');
      }
      return {
        kind: 'created' as const,
        serverId,
        ticketId: row.id,
        userId: row.owner_user_id,
        refName,
        displayName,
      };
    });
  } catch (err) {
    logger.error({ err }, 'controlled node v2 redeem failed');
    return c.json({ error: 'redeem_failed' }, 500);
  }

  const ip = (c.get('clientIp' as never) as string) ?? 'unknown';
  if (result.kind === 'denied') return c.json({ error: 'redeem_failed' }, 401);
  if (result.kind === 'mismatch') {
    // A real, already-claimed credential with a different installation identity
    // is a conflict, not an unknown credential. Keep the response body generic
    // and log only the server-generated ticket id — never either supplied secret
    // or hash — so the distinction does not disclose credential material.
    logger.warn({ ticketId: result.ticketId }, 'controlled node v2 redeem identity conflict');
    return c.json({ error: 'redeem_failed' }, 409);
  }
  logAudit({
    userId: result.userId,
    action: result.kind === 'created' ? 'enroll.v2.redeem' : 'enroll.v2.redeem.idempotent',
    ip,
    details: {
      ticketId: result.ticketId,
      serverId: result.serverId,
      os, arch, installId,
    },
  }, c.env.DB).catch(() => {});
  return c.json({
    serverId: result.serverId,
    ticketId: result.ticketId,
    nodeRole: NODE_ROLE.CONTROLLED,
    refName: result.refName,
    displayName: result.displayName,
    version: 2,
  });
});

// ── GET /api/enroll/v2/availability ─────────────────────────────────────────
//
// Reads from the in-process catalog. The catalog itself only does the
// expensive hash at most once per (dir, os, arch) and caches the
// descriptor; this endpoint does no per-request disk IO beyond the cache
// hit. Sidecar-free artifacts (file present but no `.manifest.json`) are
// deliberately omitted — availability is a supply-chain trust boundary.

enrollRoutes.get('/v2/availability', requireAuth(), async (c) => {
  const dir = process.env.IMCODES_NODE_EXE_DIR;
  if (!dir) return c.json({ available: [], artifacts: [] });
  const descriptors = await artifactCatalog.listAvailable(dir, c.env.DB as Database);
  return c.json({
    available: [...new Set(descriptors.map((d) => d.os))],
    artifacts: descriptors.map((d) => ({
      os: d.os,
      arch: d.arch,
      filename: d.filename,
      sizeBytes: d.sizeBytes,
      sha256: d.sha256,
    })),
  });
});

  return enrollRoutes;
}

export const enrollRoutes = createEnrollRoutes(defaultArtifactCatalog);

// ── Retention ────────────────────────────────────────────────────────────────

export interface RetentionResult {
  /** Total enrollments deleted (kept as `rows` for back-compat with existing callers). */
  rows: number;
  attempts: number;
  enrollments: number;
}

export async function runEnrollmentRetention(
  db: Database,
  now: number = Date.now(),
  batchSize: number = 500,
): Promise<RetentionResult> {
  const bounded = Math.max(1, Math.min(5_000, Math.trunc(batchSize)));
  // Step 1: reclaim stale reservations. Reservations count against admission
  // while live but do not increment consumed_count until commit, so lease
  // expiry only needs an idempotent state transition.
  let attemptsReleased = 0;
  await db.transaction(async (tx) => {
    const expired = await tx.query<{ attempt_id: string; ticket_id: string }>(
      `SELECT attempt_id, ticket_id
         FROM controlled_node_download_attempts
        WHERE state = 'reserved' AND lease_expires_at < $1
        LIMIT $2`,
      [now, bounded],
    );
    for (const e of expired) {
      const upd = await tx.queryOne<{ attempt_id: string }>(
        `UPDATE controlled_node_download_attempts
            SET state = 'released', released_at = $2, updated_at = $2
          WHERE attempt_id = $1 AND state = 'reserved'
          RETURNING attempt_id`,
        [e.attempt_id, now],
      );
      if (!upd) continue;
      attemptsReleased += 1;
    }
  });
  // Step 2: reaped attempt rows are then dropped by the parent
  // enrollment sweep (ON DELETE CASCADE).
  const enrollments = await db.execute(
    `WITH expired AS (
       SELECT id
         FROM controlled_node_enrollments_v2
        WHERE expires_at < $1
           OR revoked_at IS NOT NULL
           OR (consumed_at IS NOT NULL AND consumed_at < $1)
        ORDER BY expires_at ASC
        LIMIT $2
     )
     DELETE FROM controlled_node_enrollments_v2 AS enrollment
      USING expired
      WHERE enrollment.id = expired.id`,
    [now - 7 * 24 * 60 * 60 * 1000, bounded],
  );
  return {
    rows: enrollments.changes,
    attempts: attemptsReleased,
    enrollments: enrollments.changes,
  };
}
