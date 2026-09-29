/**
 * Phase 2: session identity read/write/delete over the direct v2 lease, with
 * the phase-1 WS-relayed HTTP path (`api.ts`) as the fallback.
 *
 * SESSION scope only. PROJECT scope's server-relayed route resolves a
 * participant's browser-guessed scope key to the daemon's canonical one
 * (`resolveSessionIdentityProjectKey`, session-mgmt.ts) -- server-side logic
 * the direct lease has no way to reach, since it talks to the daemon
 * directly. SESSION scope's key (`sessionIdentitySessionKey(serverId,
 * sessionName)`) is deterministic and computed identically on both sides, so
 * it carries no such ambiguity and is safe to send straight to the daemon.
 * PROJECT-scope identity-over-lease is a follow-up, not attempted here.
 */
import type { SessionIdentityProfile } from '@shared/session-identity.js';
import {
  clearSessionIdentityProfile,
  fetchSessionIdentityProfile,
  saveSessionIdentityProfile,
  type SessionIdentityAccessContext,
} from './api.js';
import {
  deleteSessionIdentityDirect,
  getSessionIdentityDirect,
  setSessionIdentityDirect,
} from './direct-file-transfer.js';
import type { WsClient } from './ws-client.js';

function toProfile(
  direct: { content: string; contentHash: string; revision: number; updatedAt: number } | null,
): SessionIdentityProfile | null {
  if (!direct) return null;
  return { scope: 'session', scopeKey: '', source: 'web', ...direct };
}

export async function fetchSessionIdentityProfileDirectFirst(
  scopeKey: string,
  context: SessionIdentityAccessContext,
  ws?: WsClient | null,
): Promise<SessionIdentityProfile | null> {
  if (ws) {
    try {
      return toProfile(await getSessionIdentityDirect(ws, context.serverId, 'session', scopeKey));
    } catch {
      // Fall through to the WS-relayed HTTP path below.
    }
  }
  return fetchSessionIdentityProfile('session', scopeKey, context);
}

export async function saveSessionIdentityProfileDirectFirst(
  input: { scopeKey: string; content: string; sourceFile?: string },
  context: SessionIdentityAccessContext,
  ws?: WsClient | null,
): Promise<SessionIdentityProfile> {
  if (ws) {
    try {
      const direct = await setSessionIdentityDirect(ws, context.serverId, 'session', input.scopeKey, input.content, {
        source: 'web', sourceFile: input.sourceFile,
      });
      return { scope: 'session', scopeKey: input.scopeKey, source: 'web', ...direct };
    } catch {
      // Fall through to the WS-relayed HTTP path below.
    }
  }
  return saveSessionIdentityProfile({ scope: 'session', ...input }, context);
}

export async function clearSessionIdentityProfileDirectFirst(
  scopeKey: string,
  context: SessionIdentityAccessContext,
  ws?: WsClient | null,
): Promise<boolean> {
  if (ws) {
    try {
      await deleteSessionIdentityDirect(ws, context.serverId, 'session', scopeKey);
      return true;
    } catch {
      // Fall through to the WS-relayed HTTP path below.
    }
  }
  return clearSessionIdentityProfile('session', scopeKey, context);
}
