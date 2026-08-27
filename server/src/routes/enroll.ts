import { Hono, type Context } from 'hono';
import { isAllowedServerUrl } from '../security/server-url.js';
import { controlledNodeInstallCommand } from '../services/controlled-node-install-command.js';
import { compress } from 'hono/compress';
import { z } from 'zod';
import { lstat, open, readdir, type FileHandle } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import { join } from 'node:path';
import type { Env } from '../env.js';
import type { Database } from '../db/client.js';
import { randomHex, sha256Hex, encryptBotConfig, decryptBotConfig } from '../security/crypto.js';
import { logAudit } from '../security/audit.js';
import { requireAuth } from '../security/authorization.js';
import logger from '../util/logger.js';
import { AUTH_IDENTITY_ERRORS } from '../../../shared/auth-identity.js';
import { EXPECTED_USER_ID_HEADER } from '../../../shared/http-header-names.js';
import { NODE_ROLE, encodeEnrollmentTrailer, isEnrollmentNodeTokenHash } from '../../../shared/remote-exec.js';
import { REMOTE_DESKTOP_PROTOCOL_VERSION } from '../../../shared/remote-desktop.js';
import { buildWindowsAuthenticodeEnrollmentPlan } from '../../../shared/windows-authenticode-enrollment.js';
import { classifyMachineTarget, deriveDisplayName } from '../../../shared/machine-reference.js';
import {
  isCanonicalControlledNodePair,
  CONTROLLED_NODE_ARTIFACT_COMPRESSION_ENCODING,
  CONTROLLED_NODE_ARTIFACT_ASSETS,
  CONTROLLED_NODE_ARTIFACT_HEADERS,
  CONTROLLED_NODE_OS_MAC,
  CONTROLLED_NODE_OS_WIN,
  CONTROLLED_NODE_TICKET_DELIVERY,
  CONTROLLED_NODE_TICKET_DELIVERY_VALUES,
  controlledNodeComputerUseHelperFilename,
  controlledNodeTicketTtlMs,
  controlledNodeTicketMaxConsumes,
  CONTROLLED_NODE_INSTALL_CODE_ALPHABET,
  CONTROLLED_NODE_INSTALL_CODE_LENGTH,
  isControlledNodeArtifactArch,
  isControlledNodeArtifactCompatibleWithRuntime,
  isControlledNodeArch,
  isControlledNodeRuntimePair,
  isControlledNodeOs,
  isControlledNodeTicketDelivery,
  isRemoteDesktopArtifactAsset,
  normalizeControlledNodeArtifactPair,
  type ControlledNodeArtifactArch,
  type ControlledNodeOs,
} from '../../../shared/controlled-node-artifacts.js';
import {
  REMOTE_DESKTOP_LEGACY_UPGRADE_PROTOCOL_VERSION,
  REMOTE_DESKTOP_MACOS_ARCHITECTURES,
  REMOTE_DESKTOP_MACOS_COMPONENT_ORDER,
  REMOTE_DESKTOP_MACOS_COMPONENT_SET_MANIFEST_MAX_BYTES,
  REMOTE_DESKTOP_MACOS_MANIFEST_FILENAME,
  encodeRemoteDesktopMacosComponentSetPrefix,
  remoteDesktopMacosComponentSetFilename,
  remoteDesktopMacosComponentSetSize,
  REMOTE_DESKTOP_WORKER_FILENAME,
  REMOTE_DESKTOP_WORKER_MANIFEST_SUFFIX,
  REMOTE_DESKTOP_VIRTUAL_DISPLAY_ARCHIVE_FILENAME,
  validateRemoteDesktopWorkerReleaseManifest,
  type RemoteDesktopMacosArchitecture,
  type RemoteDesktopMacosWorkerManifest,
  validateRemoteDesktopWorkerManifest,
} from '../../../shared/remote-desktop-worker.js';
import {
  createArtifactCatalog,
  defaultArtifactCatalog,
  type ArtifactCatalog,
} from '../services/controlled-node-artifact-catalog.js';
import {
  insertControlledServerWithNodeId,
  type SecureRandomBytes,
} from '../services/controlled-node-identity.js';
import { parseControlledNodeId } from '../../../shared/controlled-node-identity.js';

function resolveTicketEncryptionKey(c: { env: Env }): string {
  const key = c.env.BOT_ENCRYPTION_KEY;
  if (!key) throw new Error('BOT_ENCRYPTION_KEY required for v2 ticket issuance');
  return key;
}

type EnrollRouter = Hono<{ Bindings: Env; Variables: { userId: string; role: string } }>;

// Ticket lifetime and download budget now depend on how the ticket reaches the
// target machine; both tables live in shared/ so Web and Server cannot disagree.
const ATTEMPT_LEASE_MS = 30 * 1000;

/**
 * Generate an install code with rejection sampling.
 *
 * `byte % 32` would be uniform only because 256 divides evenly by 32; that is
 * true today but silently stops being true if the alphabet is ever resized.
 * Masking and rejecting keeps the distribution correct for any alphabet size.
 */
function randomInstallCode(): string {
  const alphabet = CONTROLLED_NODE_INSTALL_CODE_ALPHABET;
  const mask = (1 << Math.ceil(Math.log2(alphabet.length))) - 1;
  let out = '';
  while (out.length < CONTROLLED_NODE_INSTALL_CODE_LENGTH) {
    for (const byte of randomBytes(32)) {
      const index = byte & mask;
      if (index < alphabet.length) {
        out += alphabet[index];
        if (out.length === CONTROLLED_NODE_INSTALL_CODE_LENGTH) break;
      }
    }
  }
  return out;
}

export function resolveCanonicalServerUrl(c: { req: { url: string }; env: Env }): string | null {
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


// ── POST /api/enroll/v2/ticket ──────────────────────────────────────────────

const TICKET_BODY = z
  .object({
    version: z.literal(2),
    os: z.string(),
    arch: z.string(),
    /**
     * The daemon whose machine this node is being enrolled on, when the enrolment
     * is the "give this machine login-screen control" flow. Recorded so the
     * browser can tell the two installs are one machine and keep pointing at a
     * single entry.
     */
    hostServerId: z.string().min(1).max(128).optional(),
    /**
     * Omitted means the historical behaviour: a browser standing at the machine,
     * with the short exposure window that allows.
     */
    delivery: z.enum(CONTROLLED_NODE_TICKET_DELIVERY_VALUES as readonly [string, ...string[]]).optional(),
  })
  .strict();

export function createEnrollRoutes(
  artifactCatalog: ArtifactCatalog = createArtifactCatalog(),
  dependencies: { controlledNodeIdRandomBytes?: SecureRandomBytes } = {},
): EnrollRouter {
  const enrollRoutes: EnrollRouter = new Hono();

  // Compress the streamed representation only when the client opts into gzip.
  // The artifact remains an ordinary executable/helper on disk and all custom
  // digest/size headers continue to describe the decoded bytes. Hono removes
  // Content-Length for the encoded response and adds Vary: Accept-Encoding.
  const compressArtifactDownload = compress({
    encoding: CONTROLLED_NODE_ARTIFACT_COMPRESSION_ENCODING,
    threshold: 1024,
    contentTypeFilter: (contentType) => contentType === 'application/octet-stream',
  });
  enrollRoutes.use('/v2/download', compressArtifactDownload);
  enrollRoutes.use('/v2/node-artifact', compressArtifactDownload);

enrollRoutes.post('/v2/ticket', requireAuth(), async (c) => {
  const originCheck = checkOrigin(c);
  if (!originCheck.ok) return c.json({ error: originCheck.reason }, 403);

  const userId = c.get('userId' as never) as string;
  // Minting creates a durable, reusable installer identity. Unlike ordinary
  // API reads, an old client is not allowed to omit its in-memory owner
  // expectation: otherwise a cookie replaced by another tab could permanently
  // bind every future install from this executable to the wrong account.
  const expectedOwnerUserId = c.req.header(EXPECTED_USER_ID_HEADER)?.trim();
  if (!expectedOwnerUserId) {
    return c.json({ error: AUTH_IDENTITY_ERRORS.EXPECTATION_REQUIRED }, 428);
  }
  if (expectedOwnerUserId !== userId) {
    return c.json({ error: AUTH_IDENTITY_ERRORS.CHANGED }, 409);
  }
  const body = await c.req.json().catch(() => null);
  const parsed = TICKET_BODY.safeParse(body);
  if (!parsed.success) return c.json({ error: 'invalid_body' }, 400);
  const { os, arch, hostServerId } = parsed.data;
  const delivery = parsed.data.delivery && isControlledNodeTicketDelivery(parsed.data.delivery)
    ? parsed.data.delivery
    : CONTROLLED_NODE_TICKET_DELIVERY.BROWSER;
  if (!isControlledNodeOs(os) || !isControlledNodeArtifactArch(arch) || !isCanonicalControlledNodePair(os, arch)) {
    return c.json({ error: 'invalid_body' }, 400);
  }
  if (hostServerId !== undefined) {
    // Only over a daemon this same user owns: the host link decides which entry
    // a browser will steer remote control to, so it must not be assignable to
    // someone else's machine.
    const host = await (c.env.DB as Database).queryOne<{ id: string }>(
      `SELECT id FROM servers
        WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL AND node_role IS DISTINCT FROM $3`,
      [hostServerId, userId, NODE_ROLE.CONTROLLED],
    );
    if (!host) return c.json({ error: 'invalid_host_server' }, 403);
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
  // The pasted install command carries a short code instead of the 64-hex
  // ticket: a ticket cannot be read off a phone screen or dictated, which is
  // how a remote install is usually handed over. It is a second lookup key onto
  // this same row, so it inherits the lease, budget and audit path unchanged.
  const installCode = delivery === CONTROLLED_NODE_TICKET_DELIVERY.INSTALL_COMMAND
    ? randomInstallCode()
    : null;
  const installCodeHash = installCode ? sha256Hex(installCode) : null;
  const encryptionKey = resolveTicketEncryptionKey(c);
  const encryptedCode = encryptBotConfig(
    { enrollCode, codeHash, os, arch, serverUrl },
    encryptionKey,
  );

  const now = Date.now();
  const ticketExpiresAt = now + controlledNodeTicketTtlMs(delivery);
  const maxConsumes = controlledNodeTicketMaxConsumes(delivery);

  const inserted = await (c.env.DB as Database).queryOne<{ id: string }>(
    `INSERT INTO controlled_node_enrollments_v2
       (ticket_hash, code_hash, owner_user_id, os, arch, artifact_sha256,
        encrypted_code, consumed_count, max_consumes, ticket_expires_at,
        expires_at, reusable, created_at, host_server_id, install_code_hash)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 0, $8, $9, NULL, TRUE, $10, $11, $12)
     RETURNING id`,
    [ticketHash, codeHash, userId, os, arch, v.descriptor.sha256,
     encryptedCode, maxConsumes, ticketExpiresAt, now, hostServerId ?? null,
     installCodeHash],
  );
  if (!inserted) {
    return c.json({ error: 'ticket_mint_failed' }, 500);
  }

  // Fire-and-forget mint audit (event is non-state-bearing, post-commit).
  logAudit({
    userId,
    action: 'enroll.v2.ticket.mint',
    ip: (c.get('clientIp' as never) as string) ?? 'unknown',
    details: {
      ticketId: inserted.id, os, arch, artifactSha256: v.descriptor.sha256,
      ticketExpiresAt, delivery,
    },
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
    maxConsumes,
    expiresAt: ticketExpiresAt,
    delivery,
    ownerUserId: userId,
    ...(installCode
      ? {
        installCode,
        installCommand: controlledNodeInstallCommand(serverUrl, installCode, os),
      }
      : {}),
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
      // Either credential resolves the same row: the download ticket, or the
      // short install code from a pasted command. Both are sha256 of a
      // high-entropy secret and each column is unique, so they cannot collide.
      `SELECT id, owner_user_id, os, arch, artifact_sha256, encrypted_code
         FROM controlled_node_enrollments_v2
        WHERE (ticket_hash = $1 OR install_code_hash = $1)
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
  patch?: { offset: number; bytes: Buffer },
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
          const chunkStart = position;
          position += bytesRead;
          const chunk = Buffer.from(buffer.subarray(0, bytesRead));
          if (patch) {
            const overlapStart = Math.max(chunkStart, patch.offset);
            const overlapEnd = Math.min(position, patch.offset + patch.bytes.length);
            if (overlapStart < overlapEnd) {
              patch.bytes.copy(
                chunk,
                overlapStart - chunkStart,
                overlapStart - patch.offset,
                overlapEnd - patch.offset,
              );
            }
          }
          controller.enqueue(chunk);
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

function buildBareArtifactStream(
  handle: FileHandle,
  sizeBytes: number,
  closeOnce: () => Promise<void>,
): ReadableStream<Uint8Array> {
  let position = 0;
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

function buildBufferArtifactStream(
  bytes: Buffer,
  closeOnce: () => Promise<void>,
): ReadableStream<Uint8Array> {
  let sent = false;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (!sent) {
        sent = true;
        controller.enqueue(Buffer.from(bytes));
        return;
      }
      await closeOnce();
      controller.close();
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
  const downloadTarget = normalizeControlledNodeArtifactPair(reservation.os, reservation.arch);
  if (!downloadTarget) {
    await releaseAttempt(c.env.DB as Database, reservation.attemptId, reservation.ticketId, ip, now);
    return c.json({ error: 'unsupported_artifact' }, 500);
  }
  const downloadOs: ControlledNodeOs = downloadTarget.os;
  const downloadArch: ControlledNodeArtifactArch = downloadTarget.arch;
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

  let streamSuffix = trailer;
  let streamPatch: { offset: number; bytes: Buffer } | undefined;
  if (downloadTarget.os === CONTROLLED_NODE_OS_WIN) {
    const header = Buffer.alloc(Math.min(actualSize, 4096));
    const { bytesRead } = await opened.handle.read(header, 0, header.length, 0);
    const personalization = bytesRead === header.length
      ? buildWindowsAuthenticodeEnrollmentPlan(header, actualSize, trailer)
      : null;
    if (!personalization) {
      await opened.close();
      await releaseAttempt(c.env.DB as Database, reservation.attemptId, reservation.ticketId, ip, now);
      return c.json({ error: 'windows_artifact_authenticode_container_invalid' }, 503);
    }
    streamSuffix = personalization.certificateEntry;
    streamPatch = {
      offset: personalization.sizeFieldOffset,
      bytes: personalization.patchedCertificateTableSize,
    };
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

  const total = actualSize + streamSuffix.length;
  c.header('Content-Length', String(total));
  c.header('Content-Type', 'application/octet-stream');
  c.header('Content-Disposition', `attachment; filename="${filename}"`);
  c.header('Cache-Control', 'private, no-store');
  c.header('Referrer-Policy', 'no-referrer');
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('Accept-Ranges', 'none');

  // Step 5: stream. safeCloseOnce guarantees a single FD close across the
  // ReadableStream's normal end, stream error, and explicit cancellation.
  const stream = buildArtifactStream(opened.handle, actualSize, streamSuffix, opened.close, streamPatch);
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


const NODE_ARTIFACT_QUERY = z.object({
  serverId: z.string().min(1).max(128),
  os: z.string(),
  arch: z.string(),
  asset: z.enum([
    CONTROLLED_NODE_ARTIFACT_ASSETS.NODE,
    CONTROLLED_NODE_ARTIFACT_ASSETS.COMPUTER_USE_HELPER,
    CONTROLLED_NODE_ARTIFACT_ASSETS.REMOTE_DESKTOP_WORKER,
    CONTROLLED_NODE_ARTIFACT_ASSETS.REMOTE_DESKTOP_WORKER_MANIFEST,
    CONTROLLED_NODE_ARTIFACT_ASSETS.REMOTE_DESKTOP_VIRTUAL_DISPLAY,
    CONTROLLED_NODE_ARTIFACT_ASSETS.REMOTE_DESKTOP_MACOS_COMPONENT_SET,
  ])
    .default(CONTROLLED_NODE_ARTIFACT_ASSETS.NODE),
}).strict();

function controlledNodeRuntimePlatform(os: ControlledNodeOs): 'win32' | 'darwin' | 'linux' {
  if (os === 'win') return 'win32';
  if (os === 'mac') return 'darwin';
  return 'linux';
}

async function openComputerUseHelperArtifact(
  dir: string,
  os: ControlledNodeOs,
  arch: ControlledNodeArtifactArch,
): Promise<{
  handle: FileHandle;
  close: () => Promise<void>;
  filename: string;
  sizeBytes: number;
  sha256: string;
} | null> {
  const filename = controlledNodeComputerUseHelperFilename(os);
  const path = join(dir, 'computer-use-helper', `${controlledNodeRuntimePlatform(os)}-${arch}`, filename);
  let handle: FileHandle | null = null;
  try {
    const pathStat = await lstat(path);
    if (!pathStat.isFile() || pathStat.isSymbolicLink()) return null;
    handle = await open(path, 'r');
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size !== pathStat.size || stat.mtimeMs !== pathStat.mtimeMs || stat.ctimeMs !== pathStat.ctimeMs) {
      await handle.close();
      handle = null;
      return null;
    }
    const hash = createHash('sha256');
    const buffer = Buffer.alloc(64 * 1024);
    let position = 0;
    while (position < stat.size) {
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, stat.size - position), position);
      if (bytesRead <= 0) throw new Error('short_read');
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    let closed = false;
    const pinned = handle;
    handle = null;
    return {
      handle: pinned,
      close: async () => {
        if (closed) return;
        closed = true;
        await pinned.close().catch(() => {});
      },
      filename,
      sizeBytes: stat.size,
      sha256: hash.digest('hex'),
    };
  } catch {
    await handle?.close().catch(() => {});
    return null;
  }
}

async function openRemoteDesktopWorkerArtifact(
  dir: string,
  asset: typeof CONTROLLED_NODE_ARTIFACT_ASSETS.REMOTE_DESKTOP_WORKER
    | typeof CONTROLLED_NODE_ARTIFACT_ASSETS.REMOTE_DESKTOP_WORKER_MANIFEST
    | typeof CONTROLLED_NODE_ARTIFACT_ASSETS.REMOTE_DESKTOP_VIRTUAL_DISPLAY,
  legacyManifest = false,
): Promise<{
  handle?: FileHandle;
  bytes?: Buffer;
  close: () => Promise<void>;
  filename: string;
  sizeBytes: number;
  sha256: string;
  version: string;
} | null> {
  const workerDir = join(dir, 'remote-desktop-worker', 'win32-x64');
  const executablePath = join(workerDir, REMOTE_DESKTOP_WORKER_FILENAME);
  const manifestFilename = `${REMOTE_DESKTOP_WORKER_FILENAME}${REMOTE_DESKTOP_WORKER_MANIFEST_SUFFIX}`;
  const manifestPath = join(workerDir, manifestFilename);
  const virtualDisplayPath = join(workerDir, REMOTE_DESKTOP_VIRTUAL_DISPLAY_ARCHIVE_FILENAME);
  let executable: FileHandle | null = null;
  let manifestHandle: FileHandle | null = null;
  let virtualDisplayHandle: FileHandle | null = null;
  let requested: FileHandle | null = null;
  try {
    const [executablePathStat, manifestPathStat, virtualDisplayPathStat] = await Promise.all([
      lstat(executablePath),
      lstat(manifestPath),
      lstat(virtualDisplayPath),
    ]);
    if (!executablePathStat.isFile() || executablePathStat.isSymbolicLink()
      || !manifestPathStat.isFile() || manifestPathStat.isSymbolicLink()
      || !virtualDisplayPathStat.isFile() || virtualDisplayPathStat.isSymbolicLink()
      || manifestPathStat.size <= 0 || manifestPathStat.size > 64 * 1024) return null;
    manifestHandle = await open(manifestPath, 'r');
    const manifestStat = await manifestHandle.stat();
    if (!manifestStat.isFile() || manifestStat.size !== manifestPathStat.size
      || manifestStat.mtimeMs !== manifestPathStat.mtimeMs
      || manifestStat.ctimeMs !== manifestPathStat.ctimeMs) return null;
    // Keep the exact bytes used for the HTTP digest. Decoding and re-encoding
    // would make the advertised SHA-256 differ from the bytes held by this
    // pinned descriptor if a malformed UTF-8 sequence ever reached disk.
    const rawManifest = await manifestHandle.readFile();
    await manifestHandle.close();
    manifestHandle = null;
    const manifest = validateRemoteDesktopWorkerManifest(JSON.parse(rawManifest.toString('utf8')));
    if (!manifest || manifest.protocolVersion !== REMOTE_DESKTOP_PROTOCOL_VERSION
      || manifest.size !== executablePathStat.size
      || manifest.virtualDisplay.size !== virtualDisplayPathStat.size) return null;

    executable = await open(executablePath, 'r');
    const executableStat = await executable.stat();
    if (!executableStat.isFile() || executableStat.size !== executablePathStat.size
      || executableStat.mtimeMs !== executablePathStat.mtimeMs
      || executableStat.ctimeMs !== executablePathStat.ctimeMs) return null;
    const executableHash = createHash('sha256');
    const executableBuffer = Buffer.alloc(64 * 1024);
    let executablePosition = 0;
    while (executablePosition < executableStat.size) {
      const { bytesRead } = await executable.read(
        executableBuffer,
        0,
        Math.min(executableBuffer.length, executableStat.size - executablePosition),
        executablePosition,
      );
      if (bytesRead <= 0) return null;
      executableHash.update(executableBuffer.subarray(0, bytesRead));
      executablePosition += bytesRead;
    }
    if (executableHash.digest('hex') !== manifest.sha256) return null;

    virtualDisplayHandle = await open(virtualDisplayPath, 'r');
    const virtualDisplayStat = await virtualDisplayHandle.stat();
    if (!virtualDisplayStat.isFile()
      || virtualDisplayStat.size !== virtualDisplayPathStat.size
      || virtualDisplayStat.mtimeMs !== virtualDisplayPathStat.mtimeMs
      || virtualDisplayStat.ctimeMs !== virtualDisplayPathStat.ctimeMs) {
      return null;
    }
    const virtualDisplayHash = createHash('sha256');
    const virtualDisplayBuffer = Buffer.alloc(64 * 1024);
    let virtualDisplayPosition = 0;
    while (virtualDisplayPosition < virtualDisplayStat.size) {
      const { bytesRead } = await virtualDisplayHandle.read(
        virtualDisplayBuffer,
        0,
        Math.min(virtualDisplayBuffer.length, virtualDisplayStat.size - virtualDisplayPosition),
        virtualDisplayPosition,
      );
      if (bytesRead <= 0) {
        return null;
      }
      virtualDisplayHash.update(virtualDisplayBuffer.subarray(0, bytesRead));
      virtualDisplayPosition += bytesRead;
    }
    if (virtualDisplayHash.digest('hex') !== manifest.virtualDisplay.sha256) {
      return null;
    }

    if (asset === CONTROLLED_NODE_ARTIFACT_ASSETS.REMOTE_DESKTOP_WORKER_MANIFEST
      && legacyManifest) {
      const bytes = Buffer.from(JSON.stringify({
        ...manifest,
        protocolVersion: REMOTE_DESKTOP_LEGACY_UPGRADE_PROTOCOL_VERSION,
      }));
      await executable.close();
      executable = null;
      await virtualDisplayHandle.close();
      virtualDisplayHandle = null;
      return {
        bytes,
        close: async () => {},
        filename: manifestFilename,
        sizeBytes: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        version: manifest.workerVersion,
      };
    }

    const requestedPath = asset === CONTROLLED_NODE_ARTIFACT_ASSETS.REMOTE_DESKTOP_WORKER
      ? executablePath
      : asset === CONTROLLED_NODE_ARTIFACT_ASSETS.REMOTE_DESKTOP_WORKER_MANIFEST
        ? manifestPath : virtualDisplayPath;
    const requestedPathStat = asset === CONTROLLED_NODE_ARTIFACT_ASSETS.REMOTE_DESKTOP_WORKER
      ? executablePathStat
      : asset === CONTROLLED_NODE_ARTIFACT_ASSETS.REMOTE_DESKTOP_WORKER_MANIFEST
        ? manifestPathStat : virtualDisplayPathStat;
    requested = asset === CONTROLLED_NODE_ARTIFACT_ASSETS.REMOTE_DESKTOP_WORKER
      ? executable
      : asset === CONTROLLED_NODE_ARTIFACT_ASSETS.REMOTE_DESKTOP_VIRTUAL_DISPLAY
        ? virtualDisplayHandle : await open(requestedPath, 'r');
    if (requested === executable) executable = null;
    if (requested === virtualDisplayHandle) virtualDisplayHandle = null;
    else {
      await virtualDisplayHandle.close();
      virtualDisplayHandle = null;
    }
    const requestedStat = await requested.stat();
    if (!requestedStat.isFile() || requestedStat.size !== requestedPathStat.size
      || requestedStat.mtimeMs !== requestedPathStat.mtimeMs
      || requestedStat.ctimeMs !== requestedPathStat.ctimeMs) return null;
    const requestedHash = asset === CONTROLLED_NODE_ARTIFACT_ASSETS.REMOTE_DESKTOP_WORKER
      ? manifest.sha256
      : asset === CONTROLLED_NODE_ARTIFACT_ASSETS.REMOTE_DESKTOP_WORKER_MANIFEST
        ? createHash('sha256').update(rawManifest).digest('hex')
        : manifest.virtualDisplay.sha256;
    let closed = false;
    const pinned = requested;
    requested = null;
    return {
      handle: pinned,
      close: async () => {
        if (closed) return;
        closed = true;
        await pinned.close().catch(() => {});
      },
      filename: asset === CONTROLLED_NODE_ARTIFACT_ASSETS.REMOTE_DESKTOP_WORKER
        ? REMOTE_DESKTOP_WORKER_FILENAME
        : asset === CONTROLLED_NODE_ARTIFACT_ASSETS.REMOTE_DESKTOP_WORKER_MANIFEST
          ? manifestFilename : REMOTE_DESKTOP_VIRTUAL_DISPLAY_ARCHIVE_FILENAME,
      sizeBytes: requestedStat.size,
      sha256: requestedHash,
      version: manifest.workerVersion,
    };
  } catch {
    return null;
  } finally {
    await executable?.close().catch(() => {});
    await manifestHandle?.close().catch(() => {});
    await virtualDisplayHandle?.close().catch(() => {});
    await requested?.close().catch(() => {});
  }
}

interface OpenedMacosRemoteDesktopComponentSet {
  prefix: Buffer;
  manifestBytes: Buffer;
  handles: Readonly<Record<typeof REMOTE_DESKTOP_MACOS_COMPONENT_ORDER[number], FileHandle>>;
  manifest: RemoteDesktopMacosWorkerManifest;
  filename: string;
  sizeBytes: number;
  sha256: string;
  close: () => Promise<void>;
}

async function openMacosRemoteDesktopComponentSet(
  dir: string,
  arch: RemoteDesktopMacosArchitecture,
): Promise<OpenedMacosRemoteDesktopComponentSet | null> {
  const componentDirectory = join(dir, 'remote-desktop-worker', `darwin-${arch}`);
  const manifestPath = join(componentDirectory, REMOTE_DESKTOP_MACOS_MANIFEST_FILENAME);
  const handles = new Map<typeof REMOTE_DESKTOP_MACOS_COMPONENT_ORDER[number], FileHandle>();
  let manifestHandle: FileHandle | null = null;
  let closed = false;
  let completed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    await Promise.all([
      manifestHandle?.close().catch(() => {}),
      ...[...handles.values()].map((handle) => handle.close().catch(() => {})),
    ]);
    handles.clear();
    manifestHandle = null;
  };
  try {
    const manifestPathStat = await lstat(manifestPath);
    if (!manifestPathStat.isFile() || manifestPathStat.isSymbolicLink()
      || manifestPathStat.size <= 0
      || manifestPathStat.size > REMOTE_DESKTOP_MACOS_COMPONENT_SET_MANIFEST_MAX_BYTES) return null;
    manifestHandle = await open(manifestPath, 'r');
    const manifestStat = await manifestHandle.stat();
    if (!manifestStat.isFile()
      || manifestStat.size !== manifestPathStat.size
      || manifestStat.mtimeMs !== manifestPathStat.mtimeMs
      || manifestStat.ctimeMs !== manifestPathStat.ctimeMs) return null;
    const manifestBytes = await manifestHandle.readFile();
    await manifestHandle.close();
    manifestHandle = null;
    const manifest = validateRemoteDesktopWorkerReleaseManifest(
      JSON.parse(manifestBytes.toString('utf8')),
      { os: 'darwin', arch },
    );
    if (!manifest || manifest.os !== 'darwin' || manifest.arch !== arch) return null;

    // The validated manifest is the single component-name authority. Keep the
    // directory admission set mechanically tied to the same canonical order
    // used for hashing and streaming, so a newly shipped component cannot be
    // silently rejected by a stale hand-maintained three-file list.
    const componentNames = REMOTE_DESKTOP_MACOS_COMPONENT_ORDER.map(
      (kind) => manifest.components[kind].fileName,
    );
    const expectedNames = new Set<string>([
      REMOTE_DESKTOP_MACOS_MANIFEST_FILENAME,
      ...componentNames,
    ]);
    if (expectedNames.size !== REMOTE_DESKTOP_MACOS_COMPONENT_ORDER.length + 1) return null;
    const entries = await readdir(componentDirectory, { withFileTypes: true });
    if (entries.length !== expectedNames.size
      || entries.some((entry) => !entry.isFile() || !expectedNames.has(entry.name))) return null;

    const prefix = Buffer.from(encodeRemoteDesktopMacosComponentSetPrefix(manifestBytes.length));
    const archiveHash = createHash('sha256').update(prefix).update(manifestBytes);
    for (const kind of REMOTE_DESKTOP_MACOS_COMPONENT_ORDER) {
      const descriptor = manifest.components[kind];
      const path = join(componentDirectory, descriptor.fileName);
      const pathStat = await lstat(path);
      if (!pathStat.isFile() || pathStat.isSymbolicLink() || pathStat.size !== descriptor.size) return null;
      const handle = await open(path, 'r');
      handles.set(kind, handle);
      const handleStat = await handle.stat();
      if (!handleStat.isFile()
        || handleStat.size !== pathStat.size
        || handleStat.mtimeMs !== pathStat.mtimeMs
        || handleStat.ctimeMs !== pathStat.ctimeMs) return null;
      const componentHash = createHash('sha256');
      const buffer = Buffer.alloc(64 * 1024);
      let position = 0;
      while (position < descriptor.size) {
        const { bytesRead } = await handle.read(
          buffer,
          0,
          Math.min(buffer.length, descriptor.size - position),
          position,
        );
        if (bytesRead <= 0) return null;
        const bytes = buffer.subarray(0, bytesRead);
        componentHash.update(bytes);
        archiveHash.update(bytes);
        position += bytesRead;
      }
      if (componentHash.digest('hex') !== descriptor.sha256) return null;
    }
    completed = true;
    return {
      prefix,
      manifestBytes,
      handles: Object.freeze(Object.fromEntries(handles) as Record<
        typeof REMOTE_DESKTOP_MACOS_COMPONENT_ORDER[number],
        FileHandle
      >),
      manifest,
      filename: remoteDesktopMacosComponentSetFilename(arch),
      sizeBytes: remoteDesktopMacosComponentSetSize(manifest, manifestBytes.length),
      sha256: archiveHash.digest('hex'),
      close,
    };
  } catch {
    return null;
  } finally {
    if (!completed) await close();
  }
}

function buildMacosRemoteDesktopComponentSetStream(
  opened: OpenedMacosRemoteDesktopComponentSet,
): ReadableStream<Uint8Array> {
  const headers = [opened.prefix, opened.manifestBytes];
  let headerIndex = 0;
  let componentIndex = 0;
  let componentPosition = 0;
  const buffer = Buffer.alloc(64 * 1024);
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        if (headerIndex < headers.length) {
          controller.enqueue(Buffer.from(headers[headerIndex++]!));
          return;
        }
        if (componentIndex < REMOTE_DESKTOP_MACOS_COMPONENT_ORDER.length) {
          const kind = REMOTE_DESKTOP_MACOS_COMPONENT_ORDER[componentIndex]!;
          const size = opened.manifest.components[kind].size;
          const { bytesRead } = await opened.handles[kind].read(
            buffer,
            0,
            Math.min(buffer.length, size - componentPosition),
            componentPosition,
          );
          if (bytesRead <= 0) throw new Error('artifact_stream_ended_early');
          componentPosition += bytesRead;
          controller.enqueue(Buffer.from(buffer.subarray(0, bytesRead)));
          if (componentPosition === size) {
            componentIndex += 1;
            componentPosition = 0;
          }
          return;
        }
        await opened.close();
        controller.close();
      } catch (error) {
        await opened.close();
        controller.error(error);
      }
    },
    async cancel() {
      await opened.close();
    },
  });
}

/**
 * GET /api/enroll/v2/node-artifact — runtime self-upgrade download for an
 * already-enrolled controlled node. Auth uses the node's existing server token;
 * no user cookie, enrollment ticket, or fresh browser flow is required.
 */
enrollRoutes.get('/v2/node-artifact', async (c) => {
  if (c.req.header('range')) {
    c.header('Content-Range', 'bytes */0');
    return c.body(null as unknown as ArrayBuffer, 416);
  }
  const auth = c.req.header('Authorization') ?? '';
  const m = BEARER_RE.exec(auth);
  if (!m || !m[1]) return c.json({ error: 'missing_or_invalid_token' }, 401);

  const parsed = NODE_ARTIFACT_QUERY.safeParse({
    serverId: c.req.query('serverId') ?? c.req.header('X-Server-Id') ?? '',
    os: c.req.query('os') ?? '',
    arch: c.req.query('arch') ?? '',
    asset: c.req.query('asset') ?? CONTROLLED_NODE_ARTIFACT_ASSETS.NODE,
  });
  if (!parsed.success) return c.json({ error: 'invalid_query' }, 400);
  const { serverId, os, arch, asset } = parsed.data;
  const requestedMacosComponentArch = asset
      === CONTROLLED_NODE_ARTIFACT_ASSETS.REMOTE_DESKTOP_MACOS_COMPONENT_SET
    && os === 'mac'
    && REMOTE_DESKTOP_MACOS_ARCHITECTURES.some((candidate) => candidate === arch)
    ? arch as RemoteDesktopMacosArchitecture
    : null;
  if (asset === CONTROLLED_NODE_ARTIFACT_ASSETS.REMOTE_DESKTOP_MACOS_COMPONENT_SET
    && requestedMacosComponentArch === null) {
    return c.json({ error: 'invalid_query' }, 400);
  }
  const artifactTarget = normalizeControlledNodeArtifactPair(os, arch);
  if (!artifactTarget) {
    return c.json({ error: 'invalid_query' }, 400);
  }

  const tokenHash = sha256Hex(m[1]);
  const server = await (c.env.DB as Database).queryOne<{
    id: string;
    token_hash: string;
    node_role: string | null;
    revoked_at: number | null;
    os: string | null;
    arch: string | null;
  }>(
    'SELECT id, token_hash, node_role, revoked_at, os, arch FROM servers WHERE id = $1',
    [serverId],
  );
  // Unknown, wrong-token and revoked answer identically. A distinct `revoked`
  // reply confirmed to whoever holds the credential that it was once real, and
  // contradicted the policy the central daemon-token resolver enforces.
  if (!server || server.token_hash !== tokenHash || server.revoked_at != null) {
    return c.json({ error: 'unauthorized' }, 401);
  }
  // A normal (FULL) daemon may fetch the remote-desktop bundle, and the runtime
  // executable that carries its elevated helper.
  //
  // The worker is the same native binary a controlled node runs. The runtime is
  // needed because a daemon's own code lives in a user-writable npm directory,
  // and nothing user-writable may be what a LocalSystem service executes — so
  // enabling login-screen control installs this signed, Authenticode-verified
  // executable into a SYSTEM-owned directory and runs the helper out of that.
  // Both cross the same trust boundary the daemon already accepts: this server
  // can run commands on that machine through its own sessions.
  //
  // `node_role` is NULL on legacy daemon rows, so "not controlled" is the same
  // test the daemon server list uses.
  if (server.node_role !== NODE_ROLE.CONTROLLED
    && !isRemoteDesktopArtifactAsset(asset)
    && asset !== CONTROLLED_NODE_ARTIFACT_ASSETS.NODE) {
    return c.json({ error: 'forbidden' }, 403);
  }
  if (asset === CONTROLLED_NODE_ARTIFACT_ASSETS.REMOTE_DESKTOP_MACOS_COMPONENT_SET
    && server.node_role !== null
    && server.node_role !== NODE_ROLE.FULL
    && server.node_role !== NODE_ROLE.CONTROLLED) {
    return c.json({ error: 'forbidden' }, 403);
  }
  if (asset === CONTROLLED_NODE_ARTIFACT_ASSETS.REMOTE_DESKTOP_MACOS_COMPONENT_SET
    && ((server.os !== null && server.os !== CONTROLLED_NODE_OS_MAC)
      || (server.arch !== null && server.arch !== requestedMacosComponentArch))) {
    return c.json({ error: 'forbidden' }, 403);
  }
  if ((server.os && server.arch
      && !isControlledNodeArtifactCompatibleWithRuntime(artifactTarget.os, artifactTarget.arch, server.os, server.arch))
    || (server.os && !server.arch && server.os !== artifactTarget.os)
    || (!server.os && server.arch)) {
    return c.json({ error: 'platform_mismatch' }, 403);
  }

  const dir = process.env.IMCODES_NODE_EXE_DIR;
  if (!dir) return c.json({ error: 'executable_dir_not_configured' }, 503);
  if (asset === CONTROLLED_NODE_ARTIFACT_ASSETS.COMPUTER_USE_HELPER) {
    const openedHelper = await openComputerUseHelperArtifact(dir, artifactTarget.os, artifactTarget.arch);
    if (!openedHelper) return c.json({ error: 'computer_use_helper_not_built', os: artifactTarget.os, arch: artifactTarget.arch }, 503);
    c.header('Content-Length', String(openedHelper.sizeBytes));
    c.header('Content-Type', 'application/octet-stream');
    c.header('Content-Disposition', `attachment; filename="${openedHelper.filename}"`);
    c.header('Cache-Control', 'private, no-store');
    c.header('Referrer-Policy', 'no-referrer');
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Accept-Ranges', 'none');
    c.header(CONTROLLED_NODE_ARTIFACT_HEADERS.SHA256, openedHelper.sha256);
    c.header(CONTROLLED_NODE_ARTIFACT_HEADERS.SIZE_BYTES, String(openedHelper.sizeBytes));
    c.header(CONTROLLED_NODE_ARTIFACT_HEADERS.FILENAME, openedHelper.filename);
    return c.body(buildBareArtifactStream(openedHelper.handle, openedHelper.sizeBytes, openedHelper.close) as unknown as ReadableStream, 200);
  }
  if (asset === CONTROLLED_NODE_ARTIFACT_ASSETS.REMOTE_DESKTOP_MACOS_COMPONENT_SET) {
    const requestedProtocol = c.req.header(
      CONTROLLED_NODE_ARTIFACT_HEADERS.REMOTE_DESKTOP_PROTOCOL_VERSION,
    );
    if (requestedProtocol !== String(REMOTE_DESKTOP_PROTOCOL_VERSION)) {
      return c.json({ error: 'remote_desktop_protocol_unsupported' }, 409);
    }
    // Verify the release carrier before pinning any component handles. Apart
    // from preserving the main-release/version binding, this ordering avoids
    // leaking a complete-set handle if catalog verification ever throws.
    const nodeRelease = await artifactCatalog.ensureVerified(dir, 'mac', 'universal');
    if (!nodeRelease.ok) {
      return c.json({ error: 'macos_release_version_mismatch' }, 503);
    }
    const openedSet = await openMacosRemoteDesktopComponentSet(
      dir,
      requestedMacosComponentArch!,
    );
    if (!openedSet) {
      return c.json({
        error: 'remote_desktop_worker_not_built',
        os,
        arch: requestedMacosComponentArch,
      }, 503);
    }
    if (nodeRelease.descriptor.version !== openedSet.manifest.workerVersion) {
      await openedSet.close();
      return c.json({ error: 'macos_release_version_mismatch' }, 503);
    }
    c.header('Content-Length', String(openedSet.sizeBytes));
    c.header('Content-Type', 'application/octet-stream');
    c.header('Content-Disposition', `attachment; filename="${openedSet.filename}"`);
    c.header('Cache-Control', 'private, no-store');
    c.header('Vary', CONTROLLED_NODE_ARTIFACT_HEADERS.REMOTE_DESKTOP_PROTOCOL_VERSION);
    c.header('Referrer-Policy', 'no-referrer');
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Accept-Ranges', 'none');
    c.header(CONTROLLED_NODE_ARTIFACT_HEADERS.SHA256, openedSet.sha256);
    c.header(CONTROLLED_NODE_ARTIFACT_HEADERS.SIZE_BYTES, String(openedSet.sizeBytes));
    c.header(CONTROLLED_NODE_ARTIFACT_HEADERS.FILENAME, openedSet.filename);
    c.header(CONTROLLED_NODE_ARTIFACT_HEADERS.VERSION, openedSet.manifest.workerVersion);
    return c.body(
      buildMacosRemoteDesktopComponentSetStream(openedSet) as unknown as ReadableStream,
      200,
    );
  }
  if (isRemoteDesktopArtifactAsset(asset)) {
    if (artifactTarget.os !== 'win' || artifactTarget.arch !== 'x64') {
      return c.json({ error: 'remote_desktop_worker_unsupported', os: artifactTarget.os, arch: artifactTarget.arch }, 404);
    }
    const requestedProtocol = c.req.header(
      CONTROLLED_NODE_ARTIFACT_HEADERS.REMOTE_DESKTOP_PROTOCOL_VERSION,
    );
    const requestedProtocols = requestedProtocol?.split(',').map((value) => value.trim()) ?? [];
    if (requestedProtocols.length > 0
      && requestedProtocols.some((value) => value !== String(REMOTE_DESKTOP_PROTOCOL_VERSION))) {
      return c.json({ error: 'remote_desktop_protocol_unsupported' }, 409);
    }
    // v1 nodes predate the request header and embed a strict v1 manifest
    // validator. Give only those legacy manifest requests a v1-shaped view of
    // the same hash-pinned v2 worker so they can make the one-hop upgrade.
    const legacyManifest = asset === CONTROLLED_NODE_ARTIFACT_ASSETS.REMOTE_DESKTOP_WORKER_MANIFEST
      && requestedProtocol === undefined;
    const openedWorker = await openRemoteDesktopWorkerArtifact(dir, asset, legacyManifest);
    if (!openedWorker) return c.json({ error: 'remote_desktop_worker_not_built', os: artifactTarget.os, arch: artifactTarget.arch }, 503);
    c.header('Content-Length', String(openedWorker.sizeBytes));
    c.header('Content-Type', 'application/octet-stream');
    c.header('Content-Disposition', `attachment; filename="${openedWorker.filename}"`);
    c.header('Cache-Control', 'private, no-store');
    c.header('Vary', CONTROLLED_NODE_ARTIFACT_HEADERS.REMOTE_DESKTOP_PROTOCOL_VERSION);
    c.header('Referrer-Policy', 'no-referrer');
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Accept-Ranges', 'none');
    c.header(CONTROLLED_NODE_ARTIFACT_HEADERS.SHA256, openedWorker.sha256);
    c.header(CONTROLLED_NODE_ARTIFACT_HEADERS.SIZE_BYTES, String(openedWorker.sizeBytes));
    c.header(CONTROLLED_NODE_ARTIFACT_HEADERS.FILENAME, openedWorker.filename);
    c.header(CONTROLLED_NODE_ARTIFACT_HEADERS.VERSION, openedWorker.version);
    const stream = openedWorker.bytes
      ? buildBufferArtifactStream(openedWorker.bytes, openedWorker.close)
      : buildBareArtifactStream(openedWorker.handle!, openedWorker.sizeBytes, openedWorker.close);
    return c.body(stream as unknown as ReadableStream, 200);
  }
  const v = await artifactCatalog.ensureVerified(dir, artifactTarget.os, artifactTarget.arch);
  if (!v.ok) return c.json({ error: 'executable_not_built', os: artifactTarget.os, arch: artifactTarget.arch }, 503);
  if (artifactTarget.os === CONTROLLED_NODE_OS_WIN && artifactTarget.arch === 'x64') {
    // Old deployed upgraders download the main executable first and used to
    // treat a missing worker as optional. Refuse to publish the executable
    // until the complete same-version Windows release unit is available, so
    // those clients cannot converge the Node version while leaving stale media
    // sidecars behind.
    const workerRelease = await openRemoteDesktopWorkerArtifact(
      dir,
      CONTROLLED_NODE_ARTIFACT_ASSETS.REMOTE_DESKTOP_WORKER_MANIFEST,
    );
    if (!workerRelease) {
      return c.json({ error: 'remote_desktop_worker_not_built', os: artifactTarget.os, arch: artifactTarget.arch }, 503);
    }
    const workerVersionMatches = workerRelease.version === v.descriptor.version;
    await workerRelease.close();
    if (!workerVersionMatches) {
      return c.json({ error: 'windows_release_version_mismatch' }, 503);
    }
  }
  await artifactCatalog.persistDescriptor(c.env.DB as Database, v.descriptor).catch(() => {});
  const opened = await artifactCatalog.openPinned(dir, v.descriptor);
  if (!opened) {
    artifactCatalog.invalidate(dir, artifactTarget.os, artifactTarget.arch);
    return c.json({ error: 'artifact_digest_mismatch' }, 503);
  }

  c.header('Content-Length', String(v.descriptor.sizeBytes));
  c.header('Content-Type', 'application/octet-stream');
  c.header('Content-Disposition', `attachment; filename="${v.descriptor.filename}"`);
  c.header('Cache-Control', 'private, no-store');
  c.header('Referrer-Policy', 'no-referrer');
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('Accept-Ranges', 'none');
  c.header(CONTROLLED_NODE_ARTIFACT_HEADERS.SHA256, v.descriptor.sha256);
  c.header(CONTROLLED_NODE_ARTIFACT_HEADERS.SIZE_BYTES, String(v.descriptor.sizeBytes));
  c.header(CONTROLLED_NODE_ARTIFACT_HEADERS.FILENAME, v.descriptor.filename);
  c.header(CONTROLLED_NODE_ARTIFACT_HEADERS.VERSION, v.descriptor.version);
  if (v.descriptor.authenticodeSignerSha256) {
    c.header(
      CONTROLLED_NODE_ARTIFACT_HEADERS.AUTHENTICODE_SIGNER_SHA256,
      v.descriptor.authenticodeSignerSha256,
    );
  }
  return c.body(buildBareArtifactStream(opened.handle, v.descriptor.sizeBytes, opened.close) as unknown as ReadableStream, 200);
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
  hostServerId: string | null = null,
  secureRandomBytes?: SecureRandomBytes,
): Promise<{ nodeId: string; displayName: string }> {
  const displayName = deriveDisplayName(hostname, os);
  const input = {
    serverId,
    userId,
    tokenHash,
    displayName,
    refName: null,
    os,
    arch,
    hostServerId,
    createdAt: Date.now(),
  };
  const nodeId = secureRandomBytes
    ? await insertControlledServerWithNodeId(tx, input, secureRandomBytes)
    : await insertControlledServerWithNodeId(tx, input);
  return { nodeId, displayName };
}

type RedeemResult =
  | { kind: 'created'; serverId: string; ticketId: string; userId: string; nodeId: string; displayName: string }
  | { kind: 'idempotent'; serverId: string; ticketId: string; userId: string; nodeId: string; refName?: string; displayName: string }
  | { kind: 'mismatch'; ticketId?: string }
  | { kind: 'denied' };

enrollRoutes.post('/v2/redeem', async (c) => {
  const originCheck = checkOrigin(c);
  if (!originCheck.ok) return c.json({ error: originCheck.reason }, 403);

  const body = await c.req.json().catch(() => null);
  const parsed = REDEEM_BODY.safeParse(body);
  if (!parsed.success) return c.json({ error: 'invalid_body' }, 400);
  const { enrollToken, installId, nodeTokenHash, hostname, os, arch } = parsed.data;
  if (!isControlledNodeOs(os) || !isControlledNodeArch(arch) || !isControlledNodeRuntimePair(os, arch)) {
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
        expires_at: string | null;
        reusable: boolean;
        revoked_at: string | null;
        used_at: string | null;
        redeemed_server_id: string | null;
        install_id: string | null;
        node_token_hash: string | null;
        os: string;
        arch: string;
        host_server_id: string | null;
      }>(
        `SELECT id, owner_user_id, expires_at, reusable, revoked_at,
                used_at, redeemed_server_id, host_server_id,
                install_id, node_token_hash, os, arch
           FROM controlled_node_enrollments_v2
          WHERE code_hash = $1
          FOR UPDATE`,
        [codeHash],
      );
      if (!row) return { kind: 'denied' as const };
      if (row.revoked_at != null) return { kind: 'denied' as const };
      if (!row.reusable && (row.expires_at == null || Number(row.expires_at) <= now)) {
        return { kind: 'denied' as const };
      }
      if (!isControlledNodeArtifactCompatibleWithRuntime(row.os, row.arch, os, arch)) {
        return { kind: 'mismatch' as const, ticketId: row.id };
      }

      const existing = await tx.queryOne<{
        node_token_hash: string;
        redeemed_server_id: string;
        node_id: string | null;
        ref_name: string | null;
        display_name: string | null;
      }>(
        `SELECT install.node_token_hash, install.redeemed_server_id,
                server.node_id, server.ref_name, server.display_name
           FROM controlled_node_enrollment_installs AS install
           JOIN servers AS server ON server.id = install.redeemed_server_id
          WHERE install.enrollment_id = $1 AND install.install_id = $2`,
        [row.id, installId],
      );
      if (existing) {
        if (existing.node_token_hash !== nodeTokenHash) {
          return { kind: 'mismatch' as const, ticketId: row.id };
        }
        const existingNodeId = parseControlledNodeId(existing.node_id);
        if (!existingNodeId) throw new Error('controlled_node_redeem_stored_node_id_invalid');
        const legacyTarget = existing.ref_name == null
          ? null
          : classifyMachineTarget(existing.ref_name);
        if (existing.ref_name != null && legacyTarget?.kind !== 'legacy_ref_name') {
          throw new Error('controlled_node_redeem_stored_ref_name_invalid');
        }
        return {
          kind: 'idempotent' as const,
          serverId: existing.redeemed_server_id,
          ticketId: row.id,
          userId: row.owner_user_id,
          nodeId: existingNodeId,
          ...(legacyTarget ? { refName: legacyTarget.value } : {}),
          displayName: existing.display_name ?? '',
        };
      }

      // A legacy package remains single-use. Migration 059 backfills its
      // original claim into the child table; this parent fallback also keeps a
      // partially migrated row fail-closed instead of creating another node.
      if (!row.reusable && row.used_at) {
        return { kind: 'mismatch' as const, ticketId: row.id };
      }

      const reusedToken = await tx.queryOne<{ present: number }>(
        `SELECT 1 AS present
           FROM controlled_node_enrollment_installs
          WHERE enrollment_id = $1 AND node_token_hash = $2`,
        [row.id, nodeTokenHash],
      );
      if (reusedToken) return { kind: 'mismatch' as const, ticketId: row.id };

      const serverId = randomHex(16);
      const { nodeId, displayName } = await insertControlledServer(
        tx, serverId, row.owner_user_id, nodeTokenHash, hostname, os, arch,
        row.host_server_id,
        dependencies.controlledNodeIdRandomBytes,
      );
      await tx.execute(
        `INSERT INTO controlled_node_enrollment_installs
           (enrollment_id, install_id, node_token_hash, redeemed_server_id, created_at)
         VALUES ($1, $2, $3, $4, $5)`,
        [row.id, installId, nodeTokenHash, serverId, now],
      );

      if (!row.reusable) {
        const upd = await tx.execute(
          `UPDATE controlled_node_enrollments_v2
              SET used_at = $2,
                  install_id = $3,
                  node_token_hash = $4,
                  redeemed_server_id = $5
            WHERE id = $1
              AND used_at IS NULL
              AND reusable = FALSE
              AND revoked_at IS NULL
              AND expires_at > $2`,
          [row.id, now, installId, nodeTokenHash, serverId],
        );
        if (upd.changes !== 1) throw new Error('concurrent_legacy_redeem');
      }
      return {
        kind: 'created' as const,
        serverId,
        ticketId: row.id,
        userId: row.owner_user_id,
        nodeId,
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
    nodeId: result.nodeId,
    ticketId: result.ticketId,
    nodeRole: NODE_ROLE.CONTROLLED,
    ...('refName' in result && result.refName ? { refName: result.refName } : {}),
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
  const retentionCutoff = now - 7 * 24 * 60 * 60 * 1000;
  // Step 2: reusable installer parents intentionally live indefinitely, so
  // settled download-attempt rows need their own bounded cleanup instead of
  // relying only on parent deletion.
  await db.execute(
    `WITH settled AS (
       SELECT attempt_id
         FROM controlled_node_download_attempts
        WHERE state IN ('committed', 'released')
          AND updated_at < $1
        ORDER BY updated_at ASC
        LIMIT $2
     )
     DELETE FROM controlled_node_download_attempts AS attempt
      USING settled
      WHERE attempt.attempt_id = settled.attempt_id`,
    [retentionCutoff, bounded],
  );

  // Step 3: active reusable installers survive ticket expiry, consumption and
  // every successful redemption. Legacy single-use rows retain the old bounded
  // cleanup behavior; explicitly revoked installers are reaped after retention.
  const enrollments = await db.execute(
    `WITH expired AS (
       SELECT id
         FROM controlled_node_enrollments_v2
        WHERE (revoked_at IS NOT NULL AND revoked_at < $1)
           OR (
             reusable = FALSE
             AND (
               (expires_at IS NOT NULL AND expires_at < $1)
               OR (consumed_at IS NOT NULL AND consumed_at < $1)
             )
           )
        ORDER BY COALESCE(revoked_at, expires_at, consumed_at, created_at) ASC
        LIMIT $2
     )
     DELETE FROM controlled_node_enrollments_v2 AS enrollment
      USING expired
      WHERE enrollment.id = expired.id`,
    [retentionCutoff, bounded],
  );
  return {
    rows: enrollments.changes,
    attempts: attemptsReleased,
    enrollments: enrollments.changes,
  };
}
