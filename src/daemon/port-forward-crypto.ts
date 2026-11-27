import {
  createHash,
  createHmac,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  timingSafeEqual,
  type KeyObject,
} from 'node:crypto';
import type { PortForwardRole, PortForwardTransport } from '../../shared/port-forward.js';

export interface EphemeralEcdhKeyPair {
  privateKey: KeyObject;
  publicKeyB64: string;
}

export interface E2eTransportKeys {
  confirmListenToTargetKey: Buffer;
  confirmTargetToListenKey: Buffer;
  listenToTargetKey: Buffer;
  targetToListenKey: Buffer;
}

/**
 * Derive admission-only MAC key from server-issued capability.
 * Used solely for UDP NAT punch / TCP hello1-2 admission and key-proof checks;
 * never used to encrypt or authenticate tunnel payload or relay traffic.
 */
export function deriveAdmissionMacKey(capability: string, tunnelId: string): Buffer {
  const secret = Buffer.from(capability, 'base64url');
  if (secret.length !== 32) throw new Error('invalid_capability');
  return Buffer.from(hkdfSync('sha256', secret, Buffer.from(tunnelId, 'utf8'), Buffer.from('imcodes-pf-v2:admission'), 32));
}

export function generateEphemeralEcdhKeyPair(): EphemeralEcdhKeyPair {
  const { publicKey, privateKey } = generateKeyPairSync('x25519');
  const spkiDer = publicKey.export({ format: 'der', type: 'spki' });
  return {
    privateKey,
    publicKeyB64: Buffer.from(spkiDer).toString('base64url'),
  };
}

export function computeEcdhSharedSecret(privateKey: KeyObject, peerPublicKeyB64: string): Buffer {
  const peerDer = Buffer.from(peerPublicKeyB64, 'base64url');
  const peerKey = createPublicKey({ key: peerDer, format: 'der', type: 'spki' });
  if (peerKey.asymmetricKeyType !== 'x25519') {
    throw new Error('invalid_peer_key_type');
  }
  const secret = diffieHellman({ privateKey, publicKey: peerKey });
  // Reject all-zero low-order shared secrets cleanly.
  if (secret.length !== 32 || secret.every((b) => b === 0)) {
    throw new Error('invalid_ecdh_shared_secret');
  }
  return secret;
}

export function computeEphemeralKeyProof(
  admissionMacKey: Buffer,
  params: {
    tunnelId: string;
    role: PortForwardRole;
    selfServerId: string;
    peerServerId: string;
    publicKey: string;
  },
): string {
  return createHmac('sha256', admissionMacKey)
    .update(`pf-e2e-pub:${params.tunnelId}:${params.role}:${params.selfServerId}:${params.peerServerId}:${params.publicKey}`)
    .digest('base64url');
}

export function verifyEphemeralKeyProof(
  admissionMacKey: Buffer,
  params: {
    tunnelId: string;
    role: PortForwardRole;
    selfServerId: string;
    peerServerId: string;
    publicKey: string;
  },
  actualProof: string,
): boolean {
  const expected = Buffer.from(computeEphemeralKeyProof(admissionMacKey, params));
  const actual = Buffer.from(actualProof);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

/**
 * Derive transport- and direction-specific E2E traffic & confirmation keys
 * from the endpoints' exclusive X25519 shared secret, bound to capability,
 * tunnelId, both serverIds, both ephemeral public keys, and the active transportMode.
 */
export function deriveE2eTransportKeys(params: {
  ecdhSecret: Buffer;
  capability: string;
  tunnelId: string;
  listenServerId: string;
  targetServerId: string;
  listenPublicKey: string;
  targetPublicKey: string;
  transportMode: PortForwardTransport;
  sessionSalt?: string;
}): E2eTransportKeys {
  const capBytes = Buffer.from(params.capability, 'base64url');
  if (capBytes.length !== 32) throw new Error('invalid_capability');
  if (params.ecdhSecret.length !== 32) throw new Error('invalid_ecdh_secret');

  const transcript = `${params.tunnelId}\0${params.listenServerId}\0${params.targetServerId}\0${params.listenPublicKey}\0${params.targetPublicKey}\0${params.sessionSalt ?? ''}`;
  const salt = createHash('sha256').update(capBytes).update(transcript).digest();
  const baseInfo = `imcodes-pf-e2e-v2:${params.transportMode}:${params.tunnelId}:${params.listenServerId}:${params.targetServerId}`;

  return {
    confirmListenToTargetKey: Buffer.from(hkdfSync('sha256', params.ecdhSecret, salt, Buffer.from(`${baseInfo}:confirm-l2t`), 32)),
    confirmTargetToListenKey: Buffer.from(hkdfSync('sha256', params.ecdhSecret, salt, Buffer.from(`${baseInfo}:confirm-t2l`), 32)),
    listenToTargetKey: Buffer.from(hkdfSync('sha256', params.ecdhSecret, salt, Buffer.from(`${baseInfo}:data-l2t`), 32)),
    targetToListenKey: Buffer.from(hkdfSync('sha256', params.ecdhSecret, salt, Buffer.from(`${baseInfo}:data-t2l`), 32)),
  };
}

export function computeKeyConfirmationMac(
  confirmKey: Buffer,
  params: {
    tunnelId: string;
    listenServerId: string;
    targetServerId: string;
    listenPublicKey: string;
    targetPublicKey: string;
    transportMode: PortForwardTransport;
    direction: 'l2t' | 't2l';
  },
): Buffer {
  return createHmac('sha256', confirmKey)
    .update(`pf-kc-v2:${params.direction}:${params.transportMode}:${params.tunnelId}:${params.listenServerId}:${params.targetServerId}:${params.listenPublicKey}:${params.targetPublicKey}`)
    .digest();
}

export function verifyKeyConfirmationMac(
  confirmKey: Buffer,
  params: {
    tunnelId: string;
    listenServerId: string;
    targetServerId: string;
    listenPublicKey: string;
    targetPublicKey: string;
    transportMode: PortForwardTransport;
    direction: 'l2t' | 't2l';
  },
  actualTag: Buffer,
): boolean {
  const expected = computeKeyConfirmationMac(confirmKey, params);
  return actualTag.length === expected.length && timingSafeEqual(expected, actualTag);
}
