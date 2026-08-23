import { createHash, createPublicKey, verify } from 'node:crypto';
import {
  CAPABILITY_AUTHORIZATION_ALGORITHM,
  CAPABILITY_AUTHORITY_STATE,
  canonicalCapabilityBindingAuthorizationPayload,
  canonicalCapabilitySkillAuthorizationPayload,
  type CapabilityAuthorityRecord,
  type CapabilityAuthorizationKey,
  type CapabilitySkillAuthorizationEnvelope,
  type CapabilitySyncBinding,
  type CapabilityVersion,
} from '../../shared/capability-management.js';
import { revokeCapabilityRuntimeTokensForServer } from './capability-runtime-token.js';

const trustByRuntime = new Map<string, ReadonlyMap<string, CapabilityAuthorizationKey>>();
interface RuntimeAuthority {
  revision: number;
  records: ReadonlyMap<string, CapabilityAuthorityRecord>;
}
const authorityByRuntime = new Map<string, RuntimeAuthority>();

function runtimeKey(ownerId: string, serverId: string): string {
  return `${ownerId}\0${serverId}`;
}

function clearOtherOwnersForServer(ownerId: string, serverId: string): void {
  const current = runtimeKey(ownerId, serverId);
  const suffix = `\0${serverId}`;
  for (const key of new Set([...trustByRuntime.keys(), ...authorityByRuntime.keys()])) {
    if (key !== current && key.endsWith(suffix)) {
      trustByRuntime.delete(key);
      authorityByRuntime.delete(key);
    }
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function validKey(key: CapabilityAuthorizationKey): boolean {
  if (!key.keyId || key.keyId.length > 128 || key.algorithm !== CAPABILITY_AUTHORIZATION_ALGORITHM.ED25519) return false;
  try {
    const der = Buffer.from(key.publicKeySpki, 'base64url');
    if (der.length === 0 || der.length > 1024) return false;
    const publicKey = createPublicKey({ key: der, format: 'der', type: 'spki' });
    return publicKey.asymmetricKeyType === 'ed25519';
  } catch {
    return false;
  }
}

export function verifyCapabilityAuthorityRecord(
  ownerId: string,
  record: CapabilityAuthorityRecord,
  keys: readonly CapabilityAuthorizationKey[],
): boolean {
  if (!record.authorization) return true;
  const envelope = record.authorization;
  const key = keys.find((candidate) => candidate.keyId === envelope.keyId);
  if (!key || !validKey(key)
    || envelope.ownerId !== ownerId
    || envelope.capabilityId !== record.capabilityId
    || envelope.versionId !== record.versionId
    || envelope.bindingId !== record.bindingId
    || envelope.bindingState !== record.state
    || envelope.itemRevision !== record.itemRevision
    || envelope.bindingRevision !== record.bindingRevision) return false;
  try {
    const publicKey = createPublicKey({
      key: Buffer.from(key.publicKeySpki, 'base64url'),
      format: 'der',
      type: 'spki',
    });
    const { signature, ...unsigned } = envelope;
    return verify(
      null,
      Buffer.from(canonicalCapabilitySkillAuthorizationPayload(unsigned), 'utf8'),
      publicKey,
      Buffer.from(signature, 'base64url'),
    );
  } catch {
    return false;
  }
}

export function validateCapabilityAuthorizationKeys(keys: readonly CapabilityAuthorizationKey[]): boolean {
  if (keys.length > 16 || keys.some((key) => !validKey(key))) return false;
  return new Set(keys.map((key) => key.keyId)).size === keys.length;
}

/** Replaces process-memory trust anchors learned over one authenticated link. */
export function setCapabilityAuthorizationKeys(
  ownerId: string,
  serverId: string,
  keys: readonly CapabilityAuthorizationKey[],
): boolean {
  if (!ownerId || !serverId || !validateCapabilityAuthorizationKeys(keys)) return false;
  const map = new Map<string, CapabilityAuthorizationKey>();
  for (const key of keys) {
    if (map.has(key.keyId)) return false;
    map.set(key.keyId, structuredClone(key));
  }
  trustByRuntime.set(runtimeKey(ownerId, serverId), map);
  return true;
}

export function clearCapabilityAuthorizationKeys(ownerId: string, serverId: string): void {
  trustByRuntime.delete(runtimeKey(ownerId, serverId));
  authorityByRuntime.delete(runtimeKey(ownerId, serverId));
  revokeCapabilityRuntimeTokensForServer(serverId);
}

/**
 * Returns the one account owner currently backed by a complete authenticated
 * authority frame for this ServerLink. Multiple owners are treated as an
 * identity conflict and fail closed.
 */
export function getAuthenticatedCapabilityOwner(serverId: string): string | undefined {
  if (!serverId) return undefined;
  const suffix = `\0${serverId}`;
  const owners = [...authorityByRuntime.keys()]
    .filter((key) => key.endsWith(suffix))
    .map((key) => key.slice(0, -suffix.length));
  return owners.length === 1 ? owners[0] : undefined;
}

export function getCapabilityAuthorizationKeys(ownerId: string, serverId: string): CapabilityAuthorizationKey[] | undefined {
  const keys = trustByRuntime.get(runtimeKey(ownerId, serverId));
  return keys ? [...keys.values()].map((key) => structuredClone(key)) : undefined;
}

function authorityRecordKey(capabilityId: string, versionId: string, bindingId: string): string {
  return `${capabilityId}\0${versionId}\0${bindingId}`;
}

/**
 * Atomically replaces the complete authority view learned over the current
 * authenticated link. Omitted records are deliberately revoked.
 */
export function setCapabilityAuthority(
  ownerId: string,
  serverId: string,
  revision: number,
  records: readonly CapabilityAuthorityRecord[],
  keys: readonly CapabilityAuthorizationKey[],
): boolean {
  const runtime = runtimeKey(ownerId, serverId);
  const current = authorityByRuntime.get(runtime);
  if (!ownerId || !serverId || !Number.isSafeInteger(revision) || revision < 0
    || (current !== undefined && revision < current.revision)
    || !setCapabilityAuthorizationKeys(ownerId, serverId, keys)) return false;
  const next = new Map<string, CapabilityAuthorityRecord>();
  for (const record of records) {
    if (!record.capabilityId || !record.versionId || !record.bindingId
      || !Number.isSafeInteger(record.itemRevision) || record.itemRevision < 0
      || !Number.isSafeInteger(record.bindingRevision) || record.bindingRevision < 0
      || !Object.values(CAPABILITY_AUTHORITY_STATE).includes(record.state)) {
      clearCapabilityAuthorizationKeys(ownerId, serverId);
      return false;
    }
    if (!verifyCapabilityAuthorityRecord(ownerId, record, keys)) {
      clearCapabilityAuthorizationKeys(ownerId, serverId);
      return false;
    }
    const key = authorityRecordKey(record.capabilityId, record.versionId, record.bindingId);
    if (next.has(key)) {
      clearCapabilityAuthorizationKeys(ownerId, serverId);
      return false;
    }
    next.set(key, structuredClone(record));
  }
  authorityByRuntime.set(runtime, { revision, records: next });
  clearOtherOwnersForServer(ownerId, serverId);
  revokeCapabilityRuntimeTokensForServer(serverId, ownerId);
  return true;
}

export function getCapabilityAuthorityRevision(ownerId: string, serverId: string): number | undefined {
  return authorityByRuntime.get(runtimeKey(ownerId, serverId))?.revision;
}

/** Adds one authenticated operation authority without treating it as a full snapshot. */
export function upsertCapabilityAuthority(
  ownerId: string,
  serverId: string,
  revision: number,
  record: CapabilityAuthorityRecord,
  keys: readonly CapabilityAuthorizationKey[],
): boolean {
  if (!verifyCapabilityAuthorityRecord(ownerId, record, keys)) return false;
  const runtime = runtimeKey(ownerId, serverId);
  const current = authorityByRuntime.get(runtime);
  if (current && revision < current.revision) return false;
  if (!setCapabilityAuthorizationKeys(ownerId, serverId, keys)) return false;
  const records = new Map(current?.records ?? []);
  const prefix = `${record.capabilityId}\0`;
  const suffix = `\0${record.bindingId}`;
  for (const key of records.keys()) {
    if (key.startsWith(prefix) && key.endsWith(suffix)) records.delete(key);
  }
  records.set(authorityRecordKey(record.capabilityId, record.versionId, record.bindingId), structuredClone(record));
  authorityByRuntime.set(runtime, { revision: Math.max(revision, current?.revision ?? 0), records });
  clearOtherOwnersForServer(ownerId, serverId);
  revokeCapabilityRuntimeTokensForServer(serverId, ownerId);
  return true;
}

export function verifyCapabilitySkillAuthorization(input: {
  ownerId: string;
  serverId: string;
  capabilityId: string;
  version: Pick<CapabilityVersion, 'id' | 'artifactDigest' | 'auditDigest' | 'blobDigest'>;
  binding: CapabilitySyncBinding;
  envelope: CapabilitySkillAuthorizationEnvelope;
  authorizationKeys?: readonly CapabilityAuthorizationKey[];
}): boolean {
  const envelope = input.envelope;
  const runtimeKeys = input.authorizationKeys
    ? new Map(input.authorizationKeys.map((key) => [key.keyId, key]))
    : trustByRuntime.get(runtimeKey(input.ownerId, input.serverId));
  const key = runtimeKeys?.get(envelope.keyId);
  if (!key || !validKey(key)
    || envelope.schemaVersion !== 1
    || envelope.algorithm !== CAPABILITY_AUTHORIZATION_ALGORITHM.ED25519
    || envelope.ownerId !== input.ownerId
    || envelope.capabilityId !== input.capabilityId
    || envelope.versionId !== input.version.id
    || envelope.artifactDigest !== input.version.artifactDigest
    || envelope.auditDigest !== input.version.auditDigest
    || envelope.blobDigest !== input.version.blobDigest
    || envelope.bindingId !== input.binding.id
    || envelope.itemRevision < 0
    || envelope.bindingRevision < 0
    || (input.binding.active
      ? envelope.bindingState !== CAPABILITY_AUTHORITY_STATE.ACTIVE
      : envelope.bindingState !== CAPABILITY_AUTHORITY_STATE.DISABLED
        && envelope.bindingState !== CAPABILITY_AUTHORITY_STATE.REMOVED)
    || input.binding.capabilityId !== input.capabilityId
    || input.binding.versionId !== input.version.id
    || envelope.bindingDigest !== sha256(canonicalCapabilityBindingAuthorizationPayload(input.binding))) return false;
  // Callers supplying explicit keys are validating a just-received frame
  // before it becomes current authority. Resolver callers never supply keys
  // and must match the exact complete-current authenticated authority map.
  if (!input.authorizationKeys) {
    const current = authorityByRuntime.get(runtimeKey(input.ownerId, input.serverId));
    const authority = current?.records.get(authorityRecordKey(
      input.capabilityId,
      input.version.id,
      input.binding.id,
    ));
    if (!authority
      || authority.state !== CAPABILITY_AUTHORITY_STATE.ACTIVE
      || authority.itemRevision !== envelope.itemRevision
      || authority.bindingRevision !== envelope.bindingRevision
      || authority.authorization?.signature !== envelope.signature) return false;
  }
  try {
    const publicKey = createPublicKey({
      key: Buffer.from(key.publicKeySpki, 'base64url'),
      format: 'der',
      type: 'spki',
    });
    const { signature, ...unsigned } = envelope;
    return verify(
      null,
      Buffer.from(canonicalCapabilitySkillAuthorizationPayload(unsigned), 'utf8'),
      publicKey,
      Buffer.from(signature, 'base64url'),
    );
  } catch {
    return false;
  }
}

export const CAPABILITY_AUTHORIZATION_TESTING = {
  clearAll(): void { trustByRuntime.clear(); authorityByRuntime.clear(); },
};
