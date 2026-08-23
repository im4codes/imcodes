import { randomBytes, timingSafeEqual } from 'node:crypto';

export interface CapabilityRuntimeTokenBinding {
  ownerId: string;
  sessionId: string;
  providerId: string;
  serverId: string;
  token: string;
}

interface PendingCapabilityRuntimeTokenBinding extends Omit<CapabilityRuntimeTokenBinding, 'ownerId'> {
  ownerId?: string;
}

const currentBySession = new Map<string, PendingCapabilityRuntimeTokenBinding>();

function bounded(value: string): boolean {
  return value.length > 0 && Buffer.byteLength(value, 'utf8') <= 256;
}

export function mintCapabilityRuntimeToken(
  input: Omit<CapabilityRuntimeTokenBinding, 'token' | 'ownerId'> & { ownerId?: string },
): string {
  if ((input.ownerId !== undefined && !bounded(input.ownerId))
    || !bounded(input.sessionId) || !bounded(input.providerId) || !bounded(input.serverId)) {
    throw new Error('Capability runtime identity is invalid');
  }
  const token = randomBytes(32).toString('base64url');
  currentBySession.set(input.sessionId, { ...input, token });
  return token;
}

export function revokeCapabilityRuntimeToken(sessionId: string, token?: string): void {
  const current = currentBySession.get(sessionId);
  if (!current) return;
  if (token && current.token !== token) return;
  currentBySession.delete(sessionId);
}

export function verifyCapabilityRuntimeToken(input: CapabilityRuntimeTokenBinding): boolean {
  const current = currentBySession.get(input.sessionId);
  if (!current || (current.ownerId !== undefined && current.ownerId !== input.ownerId)
    || current.providerId !== input.providerId || current.serverId !== input.serverId
    || current.token.length !== input.token.length) return false;
  if (!timingSafeEqual(Buffer.from(current.token), Buffer.from(input.token))) return false;
  // Restored provider sessions can start before ServerLink receives its first
  // complete AUTHORITY frame. Their daemon-minted token is still bound to the
  // exact session/provider/server generation, but has no account owner yet.
  // Bind it once, to the first authenticated owner observed on that link.
  if (current.ownerId === undefined) current.ownerId = input.ownerId;
  return true;
}

/** Revokes provider-generation capabilities when one authenticated link is
 * replaced, disconnected, or changes account owner. */
export function revokeCapabilityRuntimeTokensForServer(serverId: string, exceptOwnerId?: string): void {
  for (const [sessionId, current] of currentBySession) {
    if (current.serverId !== serverId) continue;
    if (exceptOwnerId === undefined
      || (current.ownerId !== undefined && current.ownerId !== exceptOwnerId)) {
      currentBySession.delete(sessionId);
    }
  }
}

export const CAPABILITY_RUNTIME_TOKEN_TESTING = {
  clear(): void { currentBySession.clear(); },
};
