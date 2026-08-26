import { Hono } from 'hono';
import type { Env } from '../env.js';
import type { Database } from '../db/client.js';
import { sha256Hex } from '../security/crypto.js';
import { resolveCanonicalServerUrl } from './enroll.js';
import { renderControlledNodeInstallScript } from '../services/controlled-node-install-command.js';
import {
  isControlledNodeArtifactArch,
  isControlledNodeOs,
  normalizeControlledNodeInstallCode,
} from '../../../shared/controlled-node-artifacts.js';

/**
 * `GET /i/:code` — the installer script a pasted one-liner fetches.
 *
 * Mounted at the root rather than under `/api`, because this URL is typed by
 * hand, read off a phone screen and dictated over the phone. It is its own
 * module because the enrolment routes are built inside a factory, and this one
 * is a plain top-level router with a different mount point and a different
 * audience: a shell, not a browser or a daemon.
 *
 * This is the only enrolment surface reached with a credential in the request
 * line, which a terminal cannot avoid — `curl` does not send URL fragments, so
 * the trick the browser bootstrap page uses is unavailable here. Two properties
 * bound that exposure:
 *
 * 1. The code is validated against its exact alphabet before any database work,
 *    so a malformed or probing request costs one regex.
 * 2. Rendering consumes nothing. The download the script later performs is what
 *    spends a slot, so fetching this page repeatedly can neither exhaust the
 *    ticket nor distinguish a real code from an invented one: unknown, expired
 *    and revoked all answer with the same 404.
 */
export const controlledNodeInstallCommandRoutes = new Hono<{ Bindings: Env }>();

controlledNodeInstallCommandRoutes.get('/:code', async (c) => {
  const serverUrl = resolveCanonicalServerUrl(c);
  if (!serverUrl) return c.text('not found\n', 404);

  // Fold the hand-typed forms (lowercase, l-for-1, O-for-0) before validating.
  const installCode = normalizeControlledNodeInstallCode(c.req.param('code') ?? '');
  if (!installCode) return c.text('not found\n', 404);

  const row = await (c.env.DB as Database).queryOne<{ os: string; arch: string }>(
    `SELECT os, arch
       FROM controlled_node_enrollments_v2
      WHERE install_code_hash = $1
        AND revoked_at IS NULL
        AND ticket_expires_at > $2`,
    [sha256Hex(installCode), Date.now()],
  );
  if (!row || !isControlledNodeOs(row.os) || !isControlledNodeArtifactArch(row.arch)) {
    return c.text('not found\n', 404);
  }

  const script = renderControlledNodeInstallScript({
    serverUrl,
    installCode,
    os: row.os,
    arch: row.arch,
  });
  c.header('Content-Type', script.contentType);
  c.header('Cache-Control', 'no-store, no-cache, must-revalidate, private, max-age=0');
  c.header('Referrer-Policy', 'no-referrer');
  c.header('X-Content-Type-Options', 'nosniff');
  return c.body(script.body, 200);
});
