import { afterEach, describe, expect, it } from 'vitest';
import {
  CAPABILITY_AUDIT_VERDICT,
  CAPABILITY_AUTHORITY_STATE,
  CAPABILITY_SCOPE,
  CAPABILITY_SOURCE_KIND,
  type CapabilitySyncBinding,
  type CapabilityVersion,
} from '../../shared/capability-management.js';
import {
  CAPABILITY_AUTHORIZATION_TESTING,
  upsertCapabilityAuthority,
  verifyCapabilitySkillAuthorization,
} from '../../src/capability/capability-authorization.js';
import { signedSyncBinding, TEST_CAPABILITY_AUTHORIZATION_KEY } from './capability-authorization-fixture.js';

const digest = (character: string): string => character.repeat(64);

describe('capability runtime authority', () => {
  afterEach(() => { CAPABILITY_AUTHORIZATION_TESTING.clearAll(); });

  it('replaces the prior version authority for the same exact binding', () => {
    const versions: CapabilityVersion[] = ['1', '2'].map((suffix, index) => ({
      id: `version-${suffix}`, capabilityId: 'capability-1', version: index + 1,
      artifactDigest: digest(suffix), auditDigest: digest(index === 0 ? 'a' : 'b'),
      auditVerdict: CAPABILITY_AUDIT_VERDICT.PASS, sourceKind: CAPABILITY_SOURCE_KIND.INLINE, createdAt: index + 1,
    }));
    const binding = (versionId: string): CapabilitySyncBinding => ({
      id: 'binding-1', capabilityId: 'capability-1', versionId,
      scope: CAPABILITY_SCOPE.ACCOUNT, providers: ['codex-sdk'], machines: [], active: true,
    });
    const signed = versions.map((version, index) => signedSyncBinding({
      ownerId: 'owner-1', capabilityId: 'capability-1', version,
      binding: binding(version.id), issuedRevision: index + 1,
    }));
    for (const [index, authorized] of signed.entries()) {
      expect(upsertCapabilityAuthority('owner-1', 'server-1', index + 1, {
        capabilityId: 'capability-1', versionId: authorized.versionId, bindingId: authorized.id,
        state: CAPABILITY_AUTHORITY_STATE.ACTIVE,
        itemRevision: authorized.authorization!.itemRevision,
        bindingRevision: authorized.authorization!.bindingRevision,
        authorization: authorized.authorization,
      }, [TEST_CAPABILITY_AUTHORIZATION_KEY])).toBe(true);
    }
    expect(verifyCapabilitySkillAuthorization({
      ownerId: 'owner-1', serverId: 'server-1', capabilityId: 'capability-1',
      version: versions[0]!, binding: signed[0]!, envelope: signed[0]!.authorization!,
    })).toBe(false);
    expect(verifyCapabilitySkillAuthorization({
      ownerId: 'owner-1', serverId: 'server-1', capabilityId: 'capability-1',
      version: versions[1]!, binding: signed[1]!, envelope: signed[1]!.authorization!,
    })).toBe(true);
  });
});
