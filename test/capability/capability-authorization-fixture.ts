import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import {
  CAPABILITY_AUTHORIZATION_ALGORITHM,
  CAPABILITY_AUTHORITY_STATE,
  type CapabilityAuthorityState,
  CAPABILITY_KIND,
  canonicalCapabilityBindingAuthorizationPayload,
  canonicalCapabilitySkillAuthorizationPayload,
  type CapabilityAuthorizationKey,
  type CapabilitySkillAuthorizationEnvelope,
  type CapabilitySyncBinding,
  type CapabilityVersion,
} from '../../shared/capability-management.js';
import { upsertCapabilityAuthority } from '../../src/capability/capability-authorization.js';
import type { ManagedSkillBinding } from '../../src/capability/managed-skill-store.js';

const pair = generateKeyPairSync('ed25519');
export const TEST_CAPABILITY_AUTHORIZATION_KEY: CapabilityAuthorizationKey = {
  keyId: 'test-server-ed25519-v1',
  algorithm: CAPABILITY_AUTHORIZATION_ALGORITHM.ED25519,
  publicKeySpki: pair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64url'),
};

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

export function signedSyncBinding(input: {
  ownerId: string;
  capabilityId: string;
  version: Pick<CapabilityVersion, 'id' | 'artifactDigest' | 'auditDigest' | 'blobDigest'>;
  binding: CapabilitySyncBinding;
  issuedRevision?: number;
  bindingState?: CapabilityAuthorityState;
}): CapabilitySyncBinding {
  const unsigned: Omit<CapabilitySkillAuthorizationEnvelope, 'signature'> = {
    schemaVersion: 1,
    algorithm: CAPABILITY_AUTHORIZATION_ALGORITHM.ED25519,
    keyId: TEST_CAPABILITY_AUTHORIZATION_KEY.keyId,
    ownerId: input.ownerId,
    capabilityId: input.capabilityId,
    versionId: input.version.id,
    artifactDigest: input.version.artifactDigest,
    auditDigest: input.version.auditDigest,
    ...(input.version.blobDigest ? { blobDigest: input.version.blobDigest } : {}),
    bindingId: input.binding.id,
    bindingDigest: sha256(canonicalCapabilityBindingAuthorizationPayload(input.binding)),
    itemRevision: input.issuedRevision ?? 1,
    bindingRevision: input.issuedRevision ?? 1,
    bindingState: input.bindingState ?? (input.binding.active ? CAPABILITY_AUTHORITY_STATE.ACTIVE : CAPABILITY_AUTHORITY_STATE.DISABLED),
    issuedRevision: input.issuedRevision ?? 1,
    issuedAt: 100,
  };
  return {
    ...input.binding,
    authorization: {
      ...unsigned,
      signature: sign(
        null,
        Buffer.from(canonicalCapabilitySkillAuthorizationPayload(unsigned), 'utf8'),
        pair.privateKey,
      ).toString('base64url'),
    },
  };
}

export function authorizedManagedBindings(input: {
  ownerId: string;
  serverId: string;
  capabilityId: string;
  versionId: string;
  artifactDigest: string;
  auditDigest: string;
  blobDigest?: string;
  bindings: readonly ManagedSkillBinding[];
  issuedRevision?: number;
}): ManagedSkillBinding[] {
  const output = input.bindings.map((binding, index) => {
    const bindingId = binding.bindingId ?? `${input.capabilityId}:binding:${index}`;
    const shared: CapabilitySyncBinding = {
      id: bindingId,
      capabilityId: input.capabilityId,
      versionId: input.versionId,
      scope: binding.scope,
      ...(binding.scope === 'local' ? { scopeId: binding.serverId ?? input.serverId } : {}),
      ...(binding.scope === 'project' && binding.projectId ? { scopeId: binding.projectId } : {}),
      ...(binding.scope === 'session' && binding.sessionId ? { scopeId: binding.sessionId } : {}),
      providers: binding.providers ?? [],
      machines: binding.machines ?? [],
      active: binding.active !== false,
    };
    const signed = signedSyncBinding({
      ownerId: input.ownerId,
      capabilityId: input.capabilityId,
      version: {
        id: input.versionId,
        artifactDigest: input.artifactDigest,
        auditDigest: input.auditDigest,
        ...(input.blobDigest ? { blobDigest: input.blobDigest } : {}),
      },
      binding: shared,
      issuedRevision: input.issuedRevision,
    });
    return {
      ...binding,
      ownerId: binding.ownerId ?? input.ownerId,
      bindingId,
      versionId: input.versionId,
      ...(binding.scope === 'local' ? { serverId: binding.serverId ?? input.serverId } : {}),
      authorization: signed.authorization,
    };
  });
  for (const binding of output) {
    upsertCapabilityAuthority(input.ownerId, input.serverId, input.issuedRevision ?? 1, {
      capabilityId: input.capabilityId,
      versionId: input.versionId,
      bindingId: binding.bindingId!,
      state: binding.active === false ? CAPABILITY_AUTHORITY_STATE.DISABLED : CAPABILITY_AUTHORITY_STATE.ACTIVE,
      itemRevision: binding.authorization!.itemRevision,
      bindingRevision: binding.authorization!.bindingRevision,
      authorization: binding.authorization,
    }, [TEST_CAPABILITY_AUTHORIZATION_KEY]);
  }
  return output;
}

export function authorizeSnapshotBindings(input: {
  ownerId: string;
  revision: number;
  items: readonly { id: string; kind: string }[];
  versions: readonly CapabilityVersion[];
  bindings: readonly CapabilitySyncBinding[];
}): CapabilitySyncBinding[] {
  const skillIds = new Set(input.items.filter((item) => item.kind === CAPABILITY_KIND.SKILL).map((item) => item.id));
  return input.bindings.map((binding) => {
    if (!skillIds.has(binding.capabilityId)) return binding;
    const version = input.versions.find((candidate) => candidate.id === binding.versionId && candidate.capabilityId === binding.capabilityId);
    if (!version) return binding;
    return signedSyncBinding({
      ownerId: input.ownerId,
      capabilityId: binding.capabilityId,
      version,
      binding: { ...binding, authorization: undefined },
      issuedRevision: input.revision,
    });
  });
}
