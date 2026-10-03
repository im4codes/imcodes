import { describe, expect, it } from 'vitest';
import {
  CAPABILITY_AUTHORITY_STATE,
  CAPABILITY_SCOPE,
  canonicalCapabilityBindingAuthorizationPayload,
} from '../../shared/capability-management.js';
import { sha256Hex } from '../src/security/crypto.js';
import {
  createCapabilityAuthorizationSigner,
  verifyCapabilitySkillAuthorization,
} from '../src/services/capability-authorization.js';

describe('capability Skill authorization', () => {
  it('binds owner, authoritative identities, digests, and exact binding authority', () => {
    const signer = createCapabilityAuthorizationSigner('server-only-secret-for-test');
    const binding = {
      id: 'binding-1',
      capabilityId: 'capability-1',
      versionId: 'version-1',
      scope: CAPABILITY_SCOPE.PROJECT,
      scopeId: 'project-1',
      providers: ['codex'],
      machines: ['server-1'],
      active: true,
    };
    const envelope = signer.signSkill({
      ownerId: 'owner-1',
      capabilityId: binding.capabilityId,
      versionId: binding.versionId,
      artifactDigest: 'a'.repeat(64),
      auditDigest: 'b'.repeat(64),
      blobDigest: 'c'.repeat(64),
      binding,
      itemRevision: 7,
      bindingRevision: 3,
      bindingState: CAPABILITY_AUTHORITY_STATE.ACTIVE,
      issuedRevision: 7,
      issuedAt: 1_000,
    });
    expect(envelope.bindingDigest).toBe(sha256Hex(canonicalCapabilityBindingAuthorizationPayload(binding)));
    expect(verifyCapabilitySkillAuthorization(envelope, signer.key)).toBe(true);
    expect(verifyCapabilitySkillAuthorization({ ...envelope, ownerId: 'owner-2' }, signer.key)).toBe(false);
    expect(verifyCapabilitySkillAuthorization({ ...envelope, bindingId: 'binding-2' }, signer.key)).toBe(false);
    expect(verifyCapabilitySkillAuthorization({ ...envelope, versionId: 'version-2' }, signer.key)).toBe(false);
    expect(verifyCapabilitySkillAuthorization({ ...envelope, itemRevision: 8 }, signer.key)).toBe(false);
    expect(verifyCapabilitySkillAuthorization({ ...envelope, bindingRevision: 4 }, signer.key)).toBe(false);
    expect(verifyCapabilitySkillAuthorization({
      ...envelope,
      bindingState: CAPABILITY_AUTHORITY_STATE.DISABLED,
    }, signer.key)).toBe(false);
    expect(verifyCapabilitySkillAuthorization({ ...envelope, signature: envelope.signature.slice(1) }, signer.key)).toBe(false);

    const otherSigner = createCapabilityAuthorizationSigner('different-server-secret');
    expect(verifyCapabilitySkillAuthorization(envelope, otherSigner.key)).toBe(false);
    expect(signer.key.publicKeySpki).not.toContain('server-only-secret');
  });
});
