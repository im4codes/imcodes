import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CAPABILITY_INSTALL_STATE,
  CAPABILITY_KIND,
  CAPABILITY_LIMITS,
  CAPABILITY_SCOPE,
  CAPABILITY_SOURCE_KIND,
  type CapabilityInstallRequest,
  type CapabilityOperation,
} from '../../shared/capability-management.js';
import { CapabilityOperationJournal } from '../../src/capability/capability-operation-journal.js';

function request(id: string): CapabilityInstallRequest {
  return {
    kind: CAPABILITY_KIND.SKILL,
    source: { kind: CAPABILITY_SOURCE_KIND.INLINE, inlineFiles: { 'SKILL.md': `---\nname: ${id}\ndescription: test\n---\nSafe.\n` } },
    scope: CAPABILITY_SCOPE.ACCOUNT,
    idempotencyKey: id,
  };
}

function operation(id: string): CapabilityOperation {
  return {
    id, kind: CAPABILITY_KIND.SKILL, state: CAPABILITY_INSTALL_STATE.AWAITING_CONFIRMATION,
    revision: 4, displayName: id, scope: CAPABILITY_SCOPE.ACCOUNT, findings: [], providers: [], machines: [],
    hasScripts: false, hasExecutables: false, artifactDigest: 'a'.repeat(64), auditDigest: 'b'.repeat(64),
    createdAt: 1, updatedAt: 1,
  };
}

describe('capability operation journal bounds', () => {
  let homeDir: string | undefined;
  afterEach(async () => {
    if (homeDir) await rm(homeDir, { recursive: true, force: true });
    homeDir = undefined;
  });

  it('keeps two large candidates restart-readable and rejects aggregate overflow atomically', async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'imcodes-journal-bounds-'));
    const journal = new CapabilityOperationJournal('server-1', homeDir);
    const bytes = Buffer.alloc(16 * 1024 * 1024, 7);
    for (const id of ['large-one', 'large-two']) {
      journal.putCandidate({
        operationId: id, ownerId: 'owner', request: request(id), requestDigest: id,
        createdAt: 1, expiresAt: 1 + CAPABILITY_LIMITS.PERSISTED_CANDIDATE_TTL_MS,
        expectedRevision: 4, operation: operation(id), archiveBase64: bytes.toString('base64'),
        blobDigest: id.padEnd(64, '0'), blobByteSize: bytes.byteLength,
      });
    }
    expect(new CapabilityOperationJournal('server-1', homeDir).candidates().map((entry) => entry.operationId))
      .toEqual(['large-one', 'large-two']);

    const boundedHome = await mkdtemp(join(tmpdir(), 'imcodes-journal-count-'));
    try {
      const bounded = new CapabilityOperationJournal('server-2', boundedHome);
      for (let index = 0; index < CAPABILITY_LIMITS.PERSISTED_CANDIDATES; index += 1) {
        const id = `candidate-${index}`;
        bounded.putCandidate({
          operationId: id, ownerId: 'owner', request: request(id), requestDigest: id,
          createdAt: 1, expiresAt: 1 + CAPABILITY_LIMITS.PERSISTED_CANDIDATE_TTL_MS,
          expectedRevision: 4, operation: operation(id),
        });
      }
      expect(() => bounded.putCandidate({
        operationId: 'overflow', ownerId: 'owner', request: request('overflow'), requestDigest: 'overflow',
        createdAt: 1, expiresAt: 1 + CAPABILITY_LIMITS.PERSISTED_CANDIDATE_TTL_MS,
        expectedRevision: 4, operation: operation('overflow'),
      })).toThrow('persistence limit exceeded');
      expect(new CapabilityOperationJournal('server-2', boundedHome).candidates()).toHaveLength(CAPABILITY_LIMITS.PERSISTED_CANDIDATES);
    } finally {
      await rm(boundedHome, { recursive: true, force: true });
    }
  });

  it('bounds and expires unacknowledged commit and manage outboxes across restart', async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'imcodes-journal-outboxes-'));
    const commits = new CapabilityOperationJournal('server-commits', homeDir);
    for (let index = 0; index < CAPABILITY_LIMITS.RETAINED_TERMINAL_OPERATIONS; index += 1) {
      commits.putCommit({
        ownerId: 'owner',
        result: { operationId: `commit-${index}` } as never,
        rollback: { kind: CAPABILITY_KIND.MCP, capabilityId: `capability-${index}` },
      });
    }
    expect(() => commits.putCommit({
      ownerId: 'owner', result: { operationId: 'commit-overflow' } as never,
      rollback: { kind: CAPABILITY_KIND.MCP, capabilityId: 'overflow' },
    })).toThrow('persistence limit exceeded');
    expect(new CapabilityOperationJournal('server-commits', homeDir).commits())
      .toHaveLength(CAPABILITY_LIMITS.RETAINED_TERMINAL_OPERATIONS);

    const manages = new CapabilityOperationJournal('server-manages', homeDir);
    for (let index = 0; index < CAPABILITY_LIMITS.RETAINED_TERMINAL_OPERATIONS; index += 1) {
      manages.putManage({
        ownerId: 'owner', frame: { requestId: `manage-${index}` } as never,
        result: { requestId: `manage-${index}` } as never,
      });
    }
    expect(() => manages.putManage({
      ownerId: 'owner', frame: { requestId: 'manage-overflow' } as never,
      result: { requestId: 'manage-overflow' } as never,
    })).toThrow('persistence limit exceeded');

    const expired = new CapabilityOperationJournal('server-expired', homeDir);
    const now = Date.now();
    expired.putManage({
      ownerId: 'owner', frame: { requestId: 'expired-manage' } as never,
      result: { requestId: 'expired-manage' } as never,
      createdAt: now - CAPABILITY_LIMITS.PERSISTED_CANDIDATE_TTL_MS - 10,
      expiresAt: now - 1,
    });
    expect(new CapabilityOperationJournal('server-expired', homeDir).manages()).toEqual([]);
  });
});
