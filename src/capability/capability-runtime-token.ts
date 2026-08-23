import { randomBytes, timingSafeEqual } from 'node:crypto';

export interface CapabilityRuntimeTokenBinding {
  ownerId: string;
  sessionId: string;
  providerId: string;
  serverId: string;
  token: string;
}

const currentBySession = new Map<string, CapabilityRuntimeTokenBinding>();

function bounded(value: string): boolean {
  return value.length > 0 && Buffer.byteLength(value, 'utf8') <= 256;
}

export function mintCapabilityRuntimeToken(input: Omit<CapabilityRuntimeTokenBinding, 'token'>): string {
  if (!bounded(input.ownerId) || !bounded(input.sessionId) || !bounded(input.providerId) || !bounded(input.serverId)) {
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
  if (!current || current.ownerId !== input.ownerId || current.providerId !== input.providerId || current.serverId !== input.serverId
    || current.token.length !== input.token.length) return false;
  return timingSafeEqual(Buffer.from(current.token), Buffer.from(input.token));
}

/** Revokes provider-generation capabilities when one authenticated link is
 * replaced, disconnected, or changes account owner. */
export function revokeCapabilityRuntimeTokensForServer(serverId: string, exceptOwnerId?: string): void {
  for (const [sessionId, current] of currentBySession) {
    if (current.serverId === serverId && current.ownerId !== exceptOwnerId) currentBySession.delete(sessionId);
  }
}

export const CAPABILITY_RUNTIME_TOKEN_TESTING = {
  clear(): void { currentBySession.clear(); },
};
