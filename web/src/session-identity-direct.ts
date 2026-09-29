/**
 * Phase 2: session identity read/write over the direct v2 lease, with the
 * phase-1 WS-relayed HTTP path (`api.ts`) as the fallback whenever the
 * lease can't be established, the caller isn't the machine owner, or
 * anything else about the direct attempt fails. Delete always uses the
 * HTTP relay path -- there is no content to move, so there is nothing for
 * the lease to save.
 *
 * Owner-only: `resolveSessionIdentityDirectMetadata` (the canonical-key +
 * hash lookup) answers `ok: false` for a share participant (see
 * handleSessionIdentityResolveQuery, server/src/ws/bridge.ts) rather than
 * reimplementing share-coverage access control on this shortcut path.
 * Participants keep using the fully access-controlled HTTP relay route
 * unchanged.
 */
import type { SessionIdentityProfile, SessionIdentityScope } from '@shared/session-identity.js';
import { SESSION_IDENTITY_WS } from '@shared/session-identity-ws.js';
import {
  clearSessionIdentityProfile,
  fetchSessionIdentityProfile,
  saveSessionIdentityProfile,
  type SessionIdentityAccessContext,
} from './api.js';
import { getSessionIdentityDirect, setSessionIdentityDirect } from './direct-file-transfer.js';
import type { WsClient } from './ws-client.js';

function isDirectScope(scope: SessionIdentityScope): scope is 'project' | 'session' {
  return scope === 'project' || scope === 'session';
}

/** Content-addressed cache: skips a bytes fetch when the server's current hash already matches. */
const identityCache = new Map<string, { contentHash: string; content: string }>();

function cacheKey(serverId: string, scope: SessionIdentityScope, scopeKey: string): string {
  return `${serverId}\u0000${scope}\u0000${scopeKey}`;
}

interface ResolvedIdentityMetadata {
  scopeKey: string;
  contentHash?: string;
  revision?: number;
  updatedAt?: number;
}

function resolveSessionIdentityDirectMetadata(
  ws: WsClient, scope: 'project' | 'session', sessionName: string, timeoutMs = 4_000,
): Promise<ResolvedIdentityMetadata | null> {
  const requestId = crypto.randomUUID();
  return new Promise((resolve) => {
    let settled = false;
    let unsubscribe: () => void = () => undefined;
    const finish = (value: ResolvedIdentityMetadata | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unsubscribe();
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    unsubscribe = ws.onMessage((message) => {
      if (message.type !== SESSION_IDENTITY_WS.RESOLVE_RESPONSE || message.requestId !== requestId) return;
      finish(message.ok && message.scopeKey ? {
        scopeKey: message.scopeKey, contentHash: message.contentHash, revision: message.revision, updatedAt: message.updatedAt,
      } : null);
    });
    try {
      ws.send({ type: SESSION_IDENTITY_WS.RESOLVE_QUERY, requestId, scope, sessionName });
    } catch {
      finish(null);
    }
  });
}

function toProfile(
  scope: SessionIdentityScope, scopeKey: string,
  direct: { content: string; contentHash: string; revision: number; updatedAt: number },
): SessionIdentityProfile {
  return { scope, scopeKey, source: 'web', ...direct };
}

/**
 * Both scopes go through this same resolve call, even though SESSION's key
 * is already deterministic client-side: the CURRENT hash/revision this
 * returns -- needed either way, to decide whether a GET can skip
 * transferring bytes at all -- only exists in the server's
 * session_identity_metadata table, so there is no cheaper path for SESSION
 * scope that still gets the hash.
 */
async function resolveIdentityDirect(
  ws: WsClient, scope: 'project' | 'session', context: SessionIdentityAccessContext,
): Promise<ResolvedIdentityMetadata | null> {
  if (!context.sessionName) return null;
  return resolveSessionIdentityDirectMetadata(ws, scope, context.sessionName);
}

export async function fetchSessionIdentityProfileDirectFirst(
  scope: SessionIdentityScope, scopeKey: string, context: SessionIdentityAccessContext, ws?: WsClient | null,
): Promise<SessionIdentityProfile | null> {
  if (ws && isDirectScope(scope)) {
    try {
      const resolved = await resolveIdentityDirect(ws, scope, context);
      if (resolved) {
        const key = cacheKey(context.serverId, scope, resolved.scopeKey);
        const cached = identityCache.get(key);
        if (!resolved.contentHash) {
          identityCache.delete(key);
          return null;
        }
        if (cached && cached.contentHash === resolved.contentHash) {
          return toProfile(scope, resolved.scopeKey, {
            content: cached.content, contentHash: cached.contentHash,
            revision: resolved.revision ?? 0, updatedAt: resolved.updatedAt ?? 0,
          });
        }
        const direct = await getSessionIdentityDirect(ws, context.serverId, scope, resolved.scopeKey);
        identityCache.set(key, { contentHash: resolved.contentHash, content: direct.content });
        return toProfile(scope, resolved.scopeKey, {
          content: direct.content, contentHash: resolved.contentHash,
          revision: resolved.revision ?? 0, updatedAt: resolved.updatedAt ?? 0,
        });
      }
    } catch {
      // Fall through to the WS-relayed HTTP path below.
    }
  }
  return fetchSessionIdentityProfile(scope, scopeKey, context);
}

export async function saveSessionIdentityProfileDirectFirst(
  input: { scope: SessionIdentityScope; scopeKey: string; content: string; sourceFile?: string },
  context: SessionIdentityAccessContext, ws?: WsClient | null,
): Promise<SessionIdentityProfile> {
  if (ws && isDirectScope(input.scope)) {
    try {
      const resolved = await resolveIdentityDirect(ws, input.scope, context);
      // A brand-new (never-saved) key still resolves to a scopeKey with no
      // hash/revision -- only a totally unknown session/scope returns null.
      if (resolved) {
        const direct = await setSessionIdentityDirect(ws, context.serverId, input.scope, resolved.scopeKey, input.content);
        identityCache.set(cacheKey(context.serverId, input.scope, resolved.scopeKey), { contentHash: direct.contentHash, content: input.content });
        return toProfile(input.scope, resolved.scopeKey, { content: input.content, ...direct });
      }
    } catch {
      // Fall through to the WS-relayed HTTP path below.
    }
  }
  return saveSessionIdentityProfile(input, context);
}

/** Always the HTTP relay path -- see the module doc comment. */
export async function clearSessionIdentityProfileDirectFirst(
  scope: SessionIdentityScope, scopeKey: string, context: SessionIdentityAccessContext,
): Promise<boolean> {
  return clearSessionIdentityProfile(scope, scopeKey, context);
}
