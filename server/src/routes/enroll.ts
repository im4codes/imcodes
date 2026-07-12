import { Hono } from 'hono';
import { z } from 'zod';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Env } from '../env.js';
import type { Database } from '../db/client.js';
import { randomHex, sha256Hex } from '../security/crypto.js';
import { logAudit } from '../security/audit.js';
import { requireAuth } from '../security/authorization.js';
import { NODE_ROLE, encodeEnrollmentTrailer } from '../../../shared/remote-exec.js';
import { deriveRefName, deriveDisplayName } from '../../../shared/machine-reference.js';

/** Prebuilt controlled-node executable filenames per OS (produced by the SEA build). */
const NODE_EXE_FILENAMES: Record<string, string> = {
  win: 'imcodes-node.exe',
  mac: 'imcodes-node-macos',
  linux: 'imcodes-node-linux',
};

/** Insert a controlled server row inside a transaction (exec_enabled defaults false via migration). */
async function insertControlledServer(
  tx: Database,
  serverId: string,
  userId: string,
  tokenHash: string,
  hostname: string,
  os: string,
): Promise<{ refName: string; displayName: string }> {
  const refName = deriveRefName(hostname, serverId);
  const displayName = deriveDisplayName(hostname, os);
  await tx.execute(
    `INSERT INTO servers (id, user_id, name, token_hash, status, created_at, node_role, ref_name, display_name)
     VALUES ($1, $2, $3, $4, 'offline', $5, $6, $7, $8)`,
    [serverId, userId, displayName, tokenHash, Date.now(), NODE_ROLE.CONTROLLED, refName, displayName],
  );
  return { refName, displayName };
}

export const enrollRoutes = new Hono<{ Bindings: Env; Variables: { userId: string; role: string } }>();

// Enrollment codes are one-time and short-lived: a leaked pre-paired executable
// is only useful within this window and only for a single claim.
const ENROLL_CODE_TTL_MS = 30 * 60 * 1000; // 30 minutes

// POST /api/enroll/new — an authenticated user mints a one-time enrollment code
// that a pre-paired controlled-node executable will redeem on first run.
enrollRoutes.post('/new', requireAuth(), async (c) => {
  const userId = c.get('userId' as never) as string;
  const keyId = c.get('keyId' as never) as string | undefined;

  const code = randomHex(24);
  const now = Date.now();
  const expiresAt = now + ENROLL_CODE_TTL_MS;

  await c.env.DB.execute(
    'INSERT INTO enrollment_codes (code, code_hash, user_id, created_by_key_id, expires_at, created_at) VALUES ($1, $2, $3, $4, $5, $6)',
    [code, sha256Hex(code), userId, keyId ?? null, expiresAt, now],
  );

  return c.json({ enrollToken: code, expiresAt });
});

// GET /api/enroll/executable?os=win|mac|linux — stream the prebuilt per-OS
// controlled-node executable with a freshly minted enrollment blob appended to
// its tail (no recompile). The download origin is pinned into the blob so first
// run redeems against this server over TLS (7.4 / D-C).
enrollRoutes.get('/executable', requireAuth(), async (c) => {
  const userId = c.get('userId' as never) as string;
  const keyId = c.get('keyId' as never) as string | undefined;
  const os = c.req.query('os') ?? '';
  const filename = NODE_EXE_FILENAMES[os];
  if (!filename) return c.json({ error: 'invalid_os' }, 400);

  const dir = process.env.IMCODES_NODE_EXE_DIR;
  if (!dir) return c.json({ error: 'executable_not_available' }, 503);
  let binary: Buffer;
  try {
    binary = await readFile(join(dir, filename));
  } catch {
    return c.json({ error: 'executable_not_built', os }, 503);
  }

  const code = randomHex(24);
  const now = Date.now();
  await c.env.DB.execute(
    'INSERT INTO enrollment_codes (code, code_hash, user_id, created_by_key_id, expires_at, created_at) VALUES ($1, $2, $3, $4, $5, $6)',
    [code, sha256Hex(code), userId, keyId ?? null, now + ENROLL_CODE_TTL_MS, now],
  );

  const serverUrl = (process.env.SERVER_URL ?? new URL(c.req.url).origin).replace(/\/+$/, '');
  const trailer = encodeEnrollmentTrailer({ serverUrl, enrollToken: code });
  const body = Buffer.concat([binary, trailer]);
  return c.body(body as unknown as ArrayBuffer, 200, {
    'content-type': 'application/octet-stream',
    'content-disposition': `attachment; filename="${filename}"`,
  });
});

// POST /api/enroll/redeem — a controlled node exchanges its one-time enrollment
// token for a persistent CONTROLLED credential. No prior auth: the token IS the
// proof. Single-use (burned atomically) and TTL-bounded.
enrollRoutes.post('/redeem', async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = z
    .object({
      enrollToken: z.string().min(1),
      installId: z.string().min(1).max(128).optional(),
      nodeTokenHash: z.string().min(1).max(128).optional(),
      hostname: z.string().min(1).max(255),
      os: z.string().min(1).max(64),
    })
    .safeParse(body);
  if (!parsed.success) return c.json({ error: 'invalid_body' }, 400);

  const { enrollToken, installId, nodeTokenHash, hostname, os } = parsed.data;
  const now = Date.now();
  const codeHash = sha256Hex(enrollToken);

  // D-A: recoverable, idempotent, transactional redemption. The claim + server
  // creation + link happen in ONE transaction — a failure rolls back so the code
  // is not consumed without delivering a credential. Under D-A the node supplies
  // `nodeTokenHash` (its client-generated token never leaves the node); the
  // legacy path (no nodeTokenHash) has the server mint and return a raw token.
  let result:
    | { kind: 'created'; serverId: string; refName: string; displayName: string; userId: string; rawToken?: string }
    | { kind: 'idempotent'; serverId: string; refName: string; displayName: string }
    | { kind: 'denied' };
  try {
    result = await c.env.DB.transaction(async (tx) => {
      // Idempotent replay: a prior successful redemption with the same installId.
      if (installId) {
        const prior = await tx.queryOne<{ redeemed_server_id: string | null; ref_name: string | null; display_name: string | null }>(
          `SELECT ec.redeemed_server_id, s.ref_name, s.display_name
             FROM enrollment_codes ec LEFT JOIN servers s ON s.id = ec.redeemed_server_id
            WHERE ec.code = $1 AND ec.install_id = $2 AND ec.redeemed_server_id IS NOT NULL`,
          [enrollToken, installId],
        );
        if (prior?.redeemed_server_id) {
          return { kind: 'idempotent', serverId: prior.redeemed_server_id, refName: prior.ref_name ?? '', displayName: prior.display_name ?? '' };
        }
      }
      // Claim: only an unused, unexpired code flips to used (single-use even under a race).
      const claimed = await tx.queryOne<{ user_id: string }>(
        `UPDATE enrollment_codes
            SET used_at = $2, install_id = COALESCE($3, install_id), code_hash = COALESCE(code_hash, $4)
          WHERE code = $1 AND used_at IS NULL AND expires_at > $2
          RETURNING user_id`,
        [enrollToken, now, installId ?? null, codeHash],
      );
      if (!claimed) return { kind: 'denied' };

      const serverId = randomHex(16);
      let rawToken: string | undefined;
      let tokenHash: string;
      if (nodeTokenHash) {
        tokenHash = nodeTokenHash;
      } else {
        rawToken = randomHex(32);
        tokenHash = sha256Hex(rawToken);
      }
      const { refName, displayName } = await insertControlledServer(tx, serverId, claimed.user_id, tokenHash, hostname, os);
      await tx.execute(
        'UPDATE enrollment_codes SET redeemed_server_id = $2, node_token_hash = COALESCE($3, node_token_hash) WHERE code = $1',
        [enrollToken, serverId, nodeTokenHash ?? null],
      );
      return { kind: 'created', serverId, refName, displayName, userId: claimed.user_id, rawToken };
    });
  } catch {
    // Transaction rolled back → the code was NOT consumed; the client may retry.
    return c.json({ error: 'redeem_failed' }, 500);
  }

  if (result.kind === 'denied') return c.json({ error: 'invalid_or_used_code' }, 404);

  if (result.kind === 'created') {
    // Audit is best-effort AFTER commit: its failure must not undo a successful redemption.
    const ip = (c.get('clientIp' as never) as string) ?? 'unknown';
    logAudit({ userId: result.userId, action: 'enroll.redeem', ip, details: { serverId: result.serverId, os } }, c.env.DB).catch(() => {});
  }
  return c.json({
    serverId: result.serverId,
    nodeRole: NODE_ROLE.CONTROLLED,
    refName: result.refName,
    displayName: result.displayName,
    ...('rawToken' in result && result.rawToken ? { token: result.rawToken } : {}),
  });
});
