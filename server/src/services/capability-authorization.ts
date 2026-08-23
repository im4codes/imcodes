import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign,
  verify,
  type KeyObject,
} from 'node:crypto';
import {
  CAPABILITY_AUTHORIZATION_ALGORITHM,
  type CapabilityAuthorityState,
  canonicalCapabilityBindingAuthorizationPayload,
  canonicalCapabilitySkillAuthorizationPayload,
  type CapabilityAuthorizationKey,
  type CapabilitySkillAuthorizationEnvelope,
  type CapabilitySyncBinding,
} from '../../../shared/capability-management.js';

const DOMAIN = 'imcodes/capability-authorization/ed25519/v1\0';
// RFC 8410 PKCS#8 wrapper for an Ed25519 32-byte private seed.
const ED25519_PKCS8_SEED_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

export interface CapabilityAuthorizationSigner {
  key: CapabilityAuthorizationKey;
  signSkill(input: {
    ownerId: string;
    capabilityId: string;
    versionId: string;
    artifactDigest: string;
    auditDigest: string;
    blobDigest?: string;
    binding: Pick<CapabilitySyncBinding,
      'id' | 'capabilityId' | 'versionId' | 'scope' | 'scopeId' | 'providers' | 'machines' | 'active'>;
    itemRevision: number;
    bindingRevision: number;
    bindingState: CapabilityAuthorityState;
    issuedRevision: number;
    issuedAt: number;
  }): CapabilitySkillAuthorizationEnvelope;
}

function derivePrivateKey(serverSigningSecret: string): KeyObject {
  const seed = createHash('sha256').update(DOMAIN).update(serverSigningSecret).digest();
  return createPrivateKey({
    key: Buffer.concat([ED25519_PKCS8_SEED_PREFIX, seed]),
    format: 'der',
    type: 'pkcs8',
  });
}

export function createCapabilityAuthorizationSigner(serverSigningSecret: string): CapabilityAuthorizationSigner {
  const privateKey = derivePrivateKey(serverSigningSecret);
  const publicKey = createPublicKey(privateKey);
  const publicKeySpkiBytes = publicKey.export({ format: 'der', type: 'spki' });
  const publicKeySpki = publicKeySpkiBytes.toString('base64url');
  const keyId = createHash('sha256').update(publicKeySpkiBytes).digest('hex');
  const key: CapabilityAuthorizationKey = {
    keyId,
    algorithm: CAPABILITY_AUTHORIZATION_ALGORITHM.ED25519,
    publicKeySpki,
  };
  return {
    key,
    signSkill(input) {
      const unsigned: Omit<CapabilitySkillAuthorizationEnvelope, 'signature'> = {
        schemaVersion: 1,
        algorithm: CAPABILITY_AUTHORIZATION_ALGORITHM.ED25519,
        keyId,
        ownerId: input.ownerId,
        capabilityId: input.capabilityId,
        versionId: input.versionId,
        artifactDigest: input.artifactDigest,
        auditDigest: input.auditDigest,
        ...(input.blobDigest ? { blobDigest: input.blobDigest } : {}),
        bindingId: input.binding.id,
        bindingDigest: createHash('sha256')
          .update(canonicalCapabilityBindingAuthorizationPayload(input.binding))
          .digest('hex'),
        itemRevision: input.itemRevision,
        bindingRevision: input.bindingRevision,
        bindingState: input.bindingState,
        issuedRevision: input.issuedRevision,
        issuedAt: input.issuedAt,
      };
      return {
        ...unsigned,
        signature: sign(
          null,
          Buffer.from(canonicalCapabilitySkillAuthorizationPayload(unsigned), 'utf8'),
          privateKey,
        ).toString('base64url'),
      };
    },
  };
}

/** Test-only verification helper; production daemons verify independently. */
export function verifyCapabilitySkillAuthorization(
  envelope: CapabilitySkillAuthorizationEnvelope,
  key: CapabilityAuthorizationKey,
): boolean {
  if (envelope.keyId !== key.keyId
    || envelope.algorithm !== CAPABILITY_AUTHORIZATION_ALGORITHM.ED25519
    || key.algorithm !== CAPABILITY_AUTHORIZATION_ALGORITHM.ED25519) return false;
  const { signature, ...unsigned } = envelope;
  try {
    const publicKey = createPublicKey({
      key: Buffer.from(key.publicKeySpki, 'base64url'),
      format: 'der',
      type: 'spki',
    });
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
