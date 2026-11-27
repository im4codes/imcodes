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
import { chmodSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
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

/** Validate that `publicKeyB64` is a base64url DER SPKI Ed25519 public key. */
export function validateEd25519SpkiPublicKey(publicKeyB64: string): boolean {
  const trimmed = publicKeyB64.trim();
  if (!trimmed || !/^[A-Za-z0-9_-]{32,128}$/.test(trimmed)) return false;
  try {
    const key = createPublicKey({
      key: Buffer.from(trimmed, 'base64url'),
      format: 'der',
      type: 'spki',
    });
    return key.asymmetricKeyType === 'ed25519';
  } catch {
    return false;
  }
}

/** Deterministic SHA-256 fingerprint for out-of-band verification / display. */
export function computePortForwardIdentityFingerprint(publicKeyB64: string): string {
  const der = Buffer.from(publicKeyB64.trim(), 'base64url');
  return `sha256:${createHash('sha256').update(der).digest('hex')}`;
}

function writePrivateJsonAtomic(filePath: string, data: unknown): void {
  mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  try {
    writeFileSync(tmpPath, `${JSON.stringify(data, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    chmodSync(tmpPath, 0o600);
    renameSync(tmpPath, filePath);
    chmodSync(filePath, 0o600);
  } catch (err) {
    try {
      unlinkSync(tmpPath);
    } catch {
      // ignore cleanup error
    }
    throw err;
  }
}

function loadRawTrustedPeersObject(filePath: string): Record<string, unknown> {
  try {
    const raw = JSON.parse(readFileSync(filePath, 'utf8')) as unknown;
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      return { ...(raw as Record<string, unknown>) };
    }
  } catch {
    // Missing or unreadable trust file -> treat as empty store.
  }
  return {};
}

function extractTrustedPeerEntryKey(value: unknown): string | null {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed && validateEd25519SpkiPublicKey(trimmed) ? trimmed : null;
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const candidate = (value as { publicKeyB64?: unknown }).publicKeyB64;
    if (typeof candidate === 'string') {
      const trimmed = candidate.trim();
      return trimmed && validateEd25519SpkiPublicKey(trimmed) ? trimmed : null;
    }
  }
  return null;
}

export type TrustedPeerLookupResult =
  | { status: 'pinned'; publicKey: string }
  | { status: 'absent' }
  | { status: 'missing'; store: Record<string, unknown> }
  | { status: 'error'; reason: string };

export type PinTrustedPeerIfMissingResult =
  | { ok: true; created: boolean; publicKey: string }
  | { ok: false; reason: string; writeFailed?: boolean };

/**
 * Strictly inspect the local trust store for `peerServerId`, distinguishing an absent store
 * or readable store missing that peer from unreadable/corrupted stores or malformed peer entries.
 */
export function readTrustedPeerLookupStrict(
  filePath: string,
  peerServerId: string,
): TrustedPeerLookupResult {
  const normalizedId = peerServerId.trim();
  if (!normalizedId || normalizedId.length > 128 || /[\s\0]/.test(normalizedId)) {
    return { status: 'error', reason: 'invalid_peer_server_id' };
  }

  let rawText: string;
  try {
    rawText = readFileSync(filePath, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return { status: 'absent' };
    }
    return { status: 'error', reason: `trust_store_unreadable:${code ?? 'io_error'}` };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    return { status: 'error', reason: 'trust_store_corrupt_json' };
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { status: 'error', reason: 'trust_store_invalid_shape' };
  }

  const store = { ...(parsed as Record<string, unknown>) };
  const matchingEntries = Object.entries(store).filter(([rawKey]) => rawKey.trim() === normalizedId);
  if (matchingEntries.length === 0) {
    return { status: 'missing', store };
  }

  const matchedKeys = new Set<string>();
  for (const [, entry] of matchingEntries) {
    const pub = extractTrustedPeerEntryKey(entry);
    if (!pub) {
      return { status: 'error', reason: `trust_store_corrupt_entry:${normalizedId}` };
    }
    matchedKeys.add(pub);
  }
  if (matchedKeys.size > 1) {
    return { status: 'error', reason: `trust_store_conflicting_entries:${normalizedId}` };
  }
  const [publicKey] = matchedKeys;
  return { status: 'pinned', publicKey: publicKey! };
}

/**
 * Atomically persist a TOFU peer public key only when the trust store is absent or readable
 * without an entry for `peerServerId`. Never overwrites an existing entry or unreadable store.
 */
export function pinTrustedPeerIfMissing(
  filePath: string,
  peerServerId: string,
  publicKeyB64: string,
): PinTrustedPeerIfMissingResult {
  const normalizedId = peerServerId.trim();
  if (!normalizedId || normalizedId.length > 128 || /[\s\0]/.test(normalizedId)) {
    return { ok: false, reason: 'invalid_peer_server_id' };
  }
  const normalizedKey = publicKeyB64.trim();
  if (!validateEd25519SpkiPublicKey(normalizedKey)) {
    return { ok: false, reason: 'invalid_ed25519_public_key' };
  }

  const state = readTrustedPeerLookupStrict(filePath, normalizedId);
  if (state.status === 'error') {
    return { ok: false, reason: state.reason };
  }
  if (state.status === 'pinned') {
    if (state.publicKey === normalizedKey) {
      return { ok: true, created: false, publicKey: state.publicKey };
    }
    return { ok: false, reason: 'peer_already_pinned_mismatch' };
  }

  const store: Record<string, unknown> = state.status === 'missing' ? { ...state.store } : {};
  const fingerprint = computePortForwardIdentityFingerprint(normalizedKey);
  store[normalizedId] = {
    algorithm: 'Ed25519',
    publicKeyB64: normalizedKey,
    fingerprint,
    updatedAt: Date.now(),
  };
  try {
    writePrivateJsonAtomic(filePath, store);
    return { ok: true, created: true, publicKey: normalizedKey };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    return {
      ok: false,
      reason: `trust_store_write_failed:${code ?? (err instanceof Error ? err.message : 'io_error')}`,
      writeFailed: true,
    };
  }
}

/**
 * Read locally pinned peer public keys from disk (relay-independent trust store).
 */
export function loadTrustedPeerPublicKeys(filePath: string): Map<string, string> {
  const map = new Map<string, string>();
  const raw = loadRawTrustedPeersObject(filePath);
  for (const [k, v] of Object.entries(raw)) {
    const peerId = k.trim();
    if (!peerId) continue;
    const pub = extractTrustedPeerEntryKey(v);
    if (pub) {
      map.set(peerId, pub);
    }
  }
  return map;
}

/**
 * Owner-authorized relay-independent trust registration: atomically pin a validated
 * Ed25519 SPKI public key for a peer serverId in the local trust store.
 */
export function upsertTrustedPeerPublicKey(
  filePath: string,
  peerServerId: string,
  publicKeyB64: string,
): { peerServerId: string; publicKey: string; fingerprint: string; created: boolean } {
  const normalizedId = peerServerId.trim();
  if (!normalizedId || normalizedId.length > 128 || /[\s\0]/.test(normalizedId)) {
    throw new Error('invalid_peer_server_id');
  }
  const normalizedKey = publicKeyB64.trim();
  if (!validateEd25519SpkiPublicKey(normalizedKey)) {
    throw new Error('invalid_ed25519_public_key');
  }
  const store = loadRawTrustedPeersObject(filePath);
  const created = !Object.prototype.hasOwnProperty.call(store, normalizedId);
  const fingerprint = computePortForwardIdentityFingerprint(normalizedKey);
  store[normalizedId] = {
    algorithm: 'Ed25519',
    publicKeyB64: normalizedKey,
    fingerprint,
    updatedAt: Date.now(),
  };
  writePrivateJsonAtomic(filePath, store);
  return { peerServerId: normalizedId, publicKey: normalizedKey, fingerprint, created };
}

export function removeTrustedPeerPublicKey(filePath: string, peerServerId: string): boolean {
  const normalizedId = peerServerId.trim();
  if (!normalizedId) return false;
  const store = loadRawTrustedPeersObject(filePath);
  if (!Object.prototype.hasOwnProperty.call(store, normalizedId)) return false;
  delete store[normalizedId];
  writePrivateJsonAtomic(filePath, store);
  return true;
}

export function listTrustedPeerPublicKeys(
  filePath: string,
): Array<{ peerServerId: string; publicKey: string; fingerprint: string }> {
  const map = loadTrustedPeerPublicKeys(filePath);
  return [...map.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([peerServerId, publicKey]) => ({
      peerServerId,
      publicKey,
      fingerprint: computePortForwardIdentityFingerprint(publicKey),
    }));
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
