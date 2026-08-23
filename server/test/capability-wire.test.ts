import { describe, expect, it } from 'vitest';
import {
  CAPABILITY_KIND,
  CAPABILITY_LIMITS,
  CAPABILITY_READINESS,
  CAPABILITY_SCOPE,
  CAPABILITY_SOURCE_KIND,
  CAPABILITY_STATE,
  CAPABILITY_SYNC_MSG,
  computeCapabilitySyncDigest,
} from '../../shared/capability-management.js';
import type { CapabilitySyncSnapshotRecord } from '../src/db/capabilities.js';
import { sha256Hex } from '../src/security/crypto.js';
import { toCapabilitySyncSnapshot } from '../src/services/capability-wire.js';

describe('capability sync wire projection', () => {
  it('includes transfer-blob metadata and hashes the canonical wire frame rather than the DB view', () => {
    const record: CapabilitySyncSnapshotRecord = {
      ownerId: 'owner-1',
      revision: 7,
      digest: 'f'.repeat(64),
      tombstones: [],
      items: [{
        id: 'capability-1',
        kind: CAPABILITY_KIND.SKILL,
        name: 'portable-skill',
        lifecycleState: CAPABILITY_STATE.ACTIVE,
        activeVersionId: 'version-1',
        revision: 2,
        tombstonedAt: null,
        removedAt: null,
        createdAt: 10,
        updatedAt: 20,
        activeVersion: {
          id: 'version-1',
          versionNumber: 1,
          artifactDigest: 'a'.repeat(64),
          blobDigest: 'c'.repeat(64),
          blobByteSize: 128,
          auditDigest: 'b'.repeat(64),
          sourceKind: CAPABILITY_SOURCE_KIND.INLINE,
          sourceSummary: 'audited package',
          manifest: {},
          definition: null,
          permissionSummary: [],
          createdAt: 10,
        },
        versions: [{
          id: 'version-1',
          versionNumber: 1,
          artifactDigest: 'a'.repeat(64),
          blobDigest: 'c'.repeat(64),
          blobByteSize: 128,
          auditDigest: 'b'.repeat(64),
          sourceKind: CAPABILITY_SOURCE_KIND.INLINE,
          sourceSummary: 'audited package',
          manifest: {},
          definition: null,
          permissionSummary: [],
          createdAt: 10,
        }],
        bindings: [{
          id: 'binding-1',
          versionId: 'version-1',
          scope: CAPABILITY_SCOPE.ACCOUNT,
          projectKey: null,
          sessionKey: null,
          serverId: null,
          providerFilter: [],
          machineFilter: [],
          enabled: true,
          revision: 1,
          updatedAt: 20,
        }],
        readiness: [{
          serverId: 'server-1',
          state: CAPABILITY_READINESS.READY,
          reasonCode: null,
          accountRevision: 7,
          manifestDigest: null,
          acknowledgedAt: 20,
        }],
      }],
    };
    const frame = toCapabilitySyncSnapshot(record, CAPABILITY_SYNC_MSG.SNAPSHOT);
    expect(frame.versions).toEqual([
      expect.objectContaining({
        id: 'version-1',
        artifactDigest: 'a'.repeat(64),
        blobDigest: 'c'.repeat(64),
        blobByteSize: 128,
      }),
    ]);
    expect(frame.ownerId).toBe('owner-1');
    expect(frame.digest).not.toBe(record.digest);
    expect(frame.digest).toBe(computeCapabilitySyncDigest(frame, sha256Hex));
    const oversized = structuredClone(record);
    oversized.items[0]!.versions[0]!.sourceSummary = 'x'.repeat(CAPABILITY_LIMITS.SYNC_VERSION_RECORD_BYTES);
    expect(() => toCapabilitySyncSnapshot(oversized, CAPABILITY_SYNC_MSG.SNAPSHOT))
      .toThrow('capability_sync_version_record_too_large');
  });
});
