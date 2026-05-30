/**
 * Local Web Preview authorization — pure peek/verify split (capability
 * local-web-preview-access, run 8a975732-23a P0.1).
 *
 * `resolveLocalPreviewAccess` is a PURE service function (does NOT depend on a
 * Hono Context, so HTTP routes and the WS upgrade handler can share it
 * verbatim). It performs peek/verify ONLY — it MUST NOT `touch`, slide
 * `expiresAt`, or `Set-Cookie`. Side effects (TTL sliding renewal, preview
 * scoped cookie) are committed separately by `commitAuthorizedAccess`, and ONLY
 * after owner + current role + token/session have all passed. This guarantees a
 * revoked/downgraded user can never extend a preview's TTL just by replaying a
 * still-valid token (P0.1.3 / V-revoke-ttl).
 *
 * Authorization is EQUIVALENT for HTTP and WS:
 *   - resolve a `userId` from session JWT OR a valid preview access token,
 *   - the preview must exist (not hard-expired) and be owned by that user,
 *   - `resolveServerRole(serverId, userId) !== 'none'` (WS upgrade previously
 *     skipped this — P0.2 closes the gap so WS == HTTP).
 */
import type { Database } from '../db/client.js';
import { resolveServerRole, type ServerRole } from '../security/authorization.js';
import { LocalWebPreviewRegistry } from './registry.js';
import { PREVIEW_ERROR, type PreviewRecord } from '../../../shared/preview-types.js';

export interface PreviewAccessInput {
  db: Database;
  serverId: string;
  previewId: string;
  /**
   * The preview access token from `?preview_access_token=` OR the preview
   * scoped cookie, already extracted by the caller. `null` when neither present.
   */
  previewAccessToken: string | null;
  /**
   * A session-resolved identity (cookie JWT / bearer), or `null`. When present,
   * `userId` is trusted; `role` (if known from the session) is ignored — the
   * authoritative per-server role is always recomputed via `resolveServerRole`.
   */
  session: { userId: string } | null;
}

export type PreviewAccessResult =
  | {
    ok: true;
    userId: string;
    role: Exclude<ServerRole, 'none'>;
    preview: PreviewRecord;
    /** The token presented (query or cookie), so HTTP can re-set the scoped cookie. */
    previewAccessToken: string | null;
  }
  | { ok: false; status: 401 | 403 | 404; error: string };

/**
 * Pure authorization decision. NO side effects. Identical result on HTTP and WS.
 *
 * Decision order (matches the long-term contract in the access spec):
 *   1. Resolve userId — session first, else preview access token (PURE token
 *      verify; never touches the registry record).
 *   2. No identity at all → 401.
 *   3. Preview missing / hard-expired → 404.
 *   4. Preview not owned by userId → 403.
 *   5. Current per-server role is `none` → 403 (revoked/never-member).
 */
export async function resolveLocalPreviewAccess(input: PreviewAccessInput): Promise<PreviewAccessResult> {
  const registry = LocalWebPreviewRegistry.get(input.serverId);

  // 1. Resolve userId — session wins; otherwise verify the preview access token.
  let userId: string | null = input.session?.userId ?? null;
  if (!userId && input.previewAccessToken) {
    // PURE verify — peekWithAccessToken never mutates lastAccessAt/expiresAt.
    const fromToken = registry.peekWithAccessToken(input.previewId, input.previewAccessToken);
    if (fromToken) userId = fromToken.userId;
  }

  // 2. No identity → unauthorized.
  if (!userId) return { ok: false, status: 401, error: PREVIEW_ERROR.FORBIDDEN };

  // 3. Preview must exist and not be hard-expired (PURE peek — no renewal).
  const preview = registry.peek(input.previewId);
  if (!preview) return { ok: false, status: 404, error: PREVIEW_ERROR.PREVIEW_EXPIRED };

  // 4. Owner check.
  if (preview.userId !== userId) return { ok: false, status: 403, error: PREVIEW_ERROR.FORBIDDEN };

  // 5. Current per-server role — recomputed every request so revocation/downgrade
  //    takes effect immediately (equivalent for HTTP and WS).
  const role = await resolveServerRole(input.db, input.serverId, userId);
  if (role === 'none') return { ok: false, status: 403, error: PREVIEW_ERROR.FORBIDDEN };

  return { ok: true, userId, role, preview, previewAccessToken: input.previewAccessToken };
}

/**
 * Commit the authorization side effects — called ONLY after
 * `resolveLocalPreviewAccess` returned `ok: true`.
 *
 * Effect: slide the preview's TTL (`touch`). `Set-Cookie` is intentionally NOT
 * handled here — the preview scoped cookie is the HTTP route's responsibility
 * (the WS upgrade has no Hono Context and MUST NOT set cookies), so the route
 * sets the cookie itself after calling this.
 *
 * Returns false if the preview vanished between verify and commit (TOCTOU).
 */
export function commitAuthorizedAccess(serverId: string, previewId: string): boolean {
  return LocalWebPreviewRegistry.get(serverId).touch(previewId);
}
