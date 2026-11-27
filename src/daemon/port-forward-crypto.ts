import {
  createHash,
  createHmac,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  sign as cryptoSign,
  timingSafeEqual,
  verify as cryptoVerify,
  type KeyObject,
} from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type {
  PortForwardCandidate,
  PortForwardRole,
  PortForwardTransport,
} from '../../shared/port-forward.js';

export interface EphemeralEcdhKeyPair {
  privateKey: KeyObject;
  publicKeyB64: string;
}

export interface EndpointIdentityKeyPair {
  publicKeyB64: string;
  privateKey: KeyObject;
}

export interface PortForwardTranscriptParams {
  tunnelId: string;
  role: PortForwardRole;
  selfServerId: string;
  peerServerId: string;
  capability: string;
  ecdhPublicKey: string;
  candidates: readonly PortForwardCandidate[];
}

export interface E2eTransportKeys {
  confirmListenToTargetKey: Buffer;
  confirmTargetToListenKey: Buffer;
  listenToTargetKey: Buffer;
  targetToListenKey: Buffer;
}

export function generateEndpointIdentityKeyPair(): EndpointIdentityKeyPair {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const spkiDer = publicKey.export({ format: 'der', type: 'spki' });
  return {
    publicKeyB64: Buffer.from(spkiDer).toString('base64url'),
    privateKey,
  };
}

/**
 * Load or create a persistent Ed25519 long-term identity keypair on disk (mode 0600).
 * Private keys never leave the node; only the SPKI public key is shared/trusted out-of-band.
 */
export function loadOrCreatePortForwardIdentity(filePath: string): EndpointIdentityKeyPair {
  try {
    const raw = JSON.parse(readFileSync(filePath, 'utf8')) as {
      publicKeyB64?: unknown;
      privateKeyPkcs8B64?: unknown;
    };
    if (typeof raw.publicKeyB64 === 'string' && typeof raw.privateKeyPkcs8B64 === 'string') {
      const privateKey = createPrivateKey({
        key: Buffer.from(raw.privateKeyPkcs8B64, 'base64url'),
        format: 'der',
        type: 'pkcs8',
      });
      const derivedPub = Buffer.from(
        createPublicKey(privateKey).export({ format: 'der', type: 'spki' }),
      ).toString('base64url');
      if (privateKey.asymmetricKeyType === 'ed25519' && derivedPub === raw.publicKeyB64) {
        return { publicKeyB64: raw.publicKeyB64, privateKey };
      }
    }
  } catch {
    // Missing or unreadable identity file -> generate a fresh Ed25519 keypair below.
  }

  const kp = generateEndpointIdentityKeyPair();
  const pkcs8Der = kp.privateKey.export({ format: 'der', type: 'pkcs8' });
  try {
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(
      filePath,
      `${JSON.stringify({
        algorithm: 'Ed25519',
        publicKeyB64: kp.publicKeyB64,
        privateKeyPkcs8B64: Buffer.from(pkcs8Der).toString('base64url'),
      }, null, 2)}\n`,
      { encoding: 'utf8', mode: 0o600 },
    );
    chmodSync(filePath, 0o600);
  } catch {
    // Best effort persistence; runtime still holds keypair safely in memory.
  }
  return kp;
}

/**
 * Read locally pinned peer public keys from disk (relay-independent trust store).
 */
export function loadTrustedPeerPublicKeys(filePath: string): Map<string, string> {
  const map = new Map<string, string>();
  try {
    const raw = JSON.parse(readFileSync(filePath, 'utf8')) as unknown;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return map;
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof v === 'string' && v.trim()) {
        map.set(k.trim(), v.trim());
      } else if (v && typeof v === 'object' && !Array.isArray(v)) {
        const pub = (v as { publicKeyB64?: unknown }).publicKeyB64;
        if (typeof pub === 'string' && pub.trim()) {
          map.set(k.trim(), pub.trim());
        }
      }
    }
  } catch {
    // Missing trust store returns empty map -> fail closed when peer key is absent.
  }
  return map;
}

export function canonicalPortForwardTranscript(params: PortForwardTranscriptParams): string {
  const candidatesCanonical = params.candidates
    .map((c) => `${c.transport}:${c.kind}:${c.host}:${c.port}`)
    .join(',');
  return [
    'imcodes-pf-transcript-v1',
    params.tunnelId,
    params.role,
    params.selfServerId,
    params.peerServerId,
    params.capability,
    params.ecdhPublicKey,
    candidatesCanonical,
  ].join('\0');
}

export function signPortForwardTranscript(
  privateKey: KeyObject,
  params: PortForwardTranscriptParams,
): string {
  const payload = Buffer.from(canonicalPortForwardTranscript(params), 'utf8');
  return cryptoSign(null, payload, privateKey).toString('base64url');
}

export function verifyPortForwardTranscript(
  trustedPublicKeyB64: string,
  params: PortForwardTranscriptParams,
  signatureB64: string,
): boolean {
  try {
    const key = createPublicKey({
      key: Buffer.from(trustedPublicKeyB64, 'base64url'),
      format: 'der',
      type: 'spki',
    });
    if (key.asymmetricKeyType !== 'ed25519') return false;
    const payload = Buffer.from(canonicalPortForwardTranscript(params), 'utf8');
    const sig = Buffer.from(signatureB64, 'base64url');
    return cryptoVerify(null, payload, key, sig);
  } catch {
    return false;
  }
}

/**
 * Derive admission-only MAC key from server-issued capability.
 * Used solely for UDP NAT punch / TCP hello1-2 admission and READY key-proof checks;
 * never used to authenticate endpoint identity or encrypt/derive traffic keys without ECDH.
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
 * tunnelId, both serverIds, both Ed25519 identity keys, both ephemeral X25519 keys,
 * and the active transportMode.
 */
export function deriveE2eTransportKeys(params: {
  ecdhSecret: Buffer;
  capability: string;
  tunnelId: string;
  listenServerId: string;
  targetServerId: string;
  listenPublicKey: string;
  targetPublicKey: string;
  listenIdentityPublicKey?: string;
  targetIdentityPublicKey?: string;
  transportMode: PortForwardTransport;
  sessionSalt?: string;
}): E2eTransportKeys {
  const capBytes = Buffer.from(params.capability, 'base64url');
  if (capBytes.length !== 32) throw new Error('invalid_capability');
  if (params.ecdhSecret.length !== 32) throw new Error('invalid_ecdh_secret');

  const transcript = [
    params.tunnelId,
    params.listenServerId,
    params.targetServerId,
    params.listenIdentityPublicKey ?? '',
    params.targetIdentityPublicKey ?? '',
    params.listenPublicKey,
    params.targetPublicKey,
    params.sessionSalt ?? '',
  ].join('\0');
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
    listenIdentityPublicKey?: string;
    targetIdentityPublicKey?: string;
    transportMode: PortForwardTransport;
    direction: 'l2t' | 't2l';
  },
): Buffer {
  return createHmac('sha256', confirmKey)
    .update(
      `pf-kc-v2:${params.direction}:${params.transportMode}:${params.tunnelId}:${params.listenServerId}:${params.targetServerId}:${params.listenIdentityPublicKey ?? ''}:${params.targetIdentityPublicKey ?? ''}:${params.listenPublicKey}:${params.targetPublicKey}`,
    )
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
    listenIdentityPublicKey?: string;
    targetIdentityPublicKey?: string;
    transportMode: PortForwardTransport;
    direction: 'l2t' | 't2l';
  },
  actualTag: Buffer,
): boolean {
  const expected = computeKeyConfirmationMac(confirmKey, params);
  return actualTag.length === expected.length && timingSafeEqual(expected, actualTag);
}
