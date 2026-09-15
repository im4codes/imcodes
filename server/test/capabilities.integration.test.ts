import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CAPABILITY_BLOB_ACTION,
  CAPABILITY_AUTHORITY_STATE,
  CAPABILITY_CONFIRMATION_DECISION,
  CAPABILITY_ERROR,
  CAPABILITY_INSTALL_STATE,
  CAPABILITY_KIND,
  CAPABILITY_LIMITS,
  CAPABILITY_MANAGE_ACTION,
  CAPABILITY_SCOPE,
  CAPABILITY_SOURCE_KIND,
  CAPABILITY_STATE,
  CAPABILITY_SYNC_MSG,
} from '../../shared/capability-management.js';
import {
  activateCapabilityVersion,
  advanceLocalCapabilityManageResult,
  advanceCapabilityOperation,
  cancelCapabilityOperation,
  completeCapabilityCommit,
  confirmCapabilityOperation,
  createInstallOperation,
  expireCapabilityPreActivationOperations,
  sweepExpiredCapabilityHistory,
  getCapability,
  getCapabilityAuthorityRecordSet,
  getCapabilityOperation,
  getCapabilitySyncSnapshot,
  failCapabilityOperationsForDisconnectedServer,
  expireCapabilityPendingActivations,
  failCapabilityPendingActivation,
  listCapabilities,
  listRecentCapabilityOperations,
  manageCapability,
  markLocalCapabilityManageCommitSent,
  recordCapabilityEvidence,
  reserveLocalCapabilityManage,
  updateCapabilityOperation,
} from '../src/db/capabilities.js';
import { createDatabase, type Database } from '../src/db/client.js';
import { runMigrations } from '../src/db/migrate.js';
import { createServer, createUser } from '../src/db/queries.js';
import { randomHex, sha256Hex } from '../src/security/crypto.js';
import {
  consumeCapabilityBlobAccess,
  issueCapabilityBlobAccess,
  persistCapabilityBlobUpload,
  readCapabilityBlobDownload,
} from '../src/services/capability-package-storage.js';
import {
  createCapabilityAuthorizationSigner,
  verifyCapabilitySkillAuthorization,
} from '../src/services/capability-authorization.js';
import {
  toCapabilityOperationWire,
  toCapabilitySummary,
  toCapabilitySyncAuthorityFrame,
  toCapabilitySyncSnapshot,
} from '../src/services/capability-wire.js';

let db: Database;
let ownerOne: string;
let ownerTwo: string;
let serverOne: string;
let serverTwo: string;
let serverOtherOwner: string;

const ARTIFACT_DIGEST = 'a'.repeat(64);
const AUDIT_DIGEST = 'b'.repeat(64);
const SKILL_BLOB = Buffer.from('portable audited skill package');
const BLOB_DIGEST = sha256Hex(SKILL_BLOB);
const authorizationSigner = createCapabilityAuthorizationSigner('capability-integration-signing-key');

function sourceServerForOwner(ownerUserId: string): string {
  return ownerUserId === ownerTwo ? serverOtherOwner : serverOne;
}

beforeAll(async () => {
  db = createDatabase(process.env.TEST_DATABASE_URL!);
  await runMigrations(db);
  ownerOne = `cap-owner-${randomHex(8)}`;
  ownerTwo = `cap-owner-${randomHex(8)}`;
  serverOne = `cap-server-${randomHex(8)}`;
  serverTwo = `cap-server-${randomHex(8)}`;
  serverOtherOwner = `cap-server-${randomHex(8)}`;
  await createUser(db, ownerOne, ownerOne);
  await createUser(db, ownerTwo, ownerTwo);
  await createServer(db, serverOne, ownerOne, 'capability-server', sha256Hex(randomHex(32)));
  await createServer(db, serverTwo, ownerOne, 'capability-server-two', sha256Hex(randomHex(32)));
  await createServer(db, serverOtherOwner, ownerTwo, 'capability-server-other', sha256Hex(randomHex(32)));
});

afterAll(async () => {
  await db.execute('DELETE FROM servers WHERE id = ANY($1::text[])', [[serverOne, serverTwo, serverOtherOwner]]);
  await db.execute('DELETE FROM users WHERE id = ANY($1::text[])', [[ownerOne, ownerTwo]]);
  await db.close();
});

async function prepareConfirmedOperation(
  idempotencyKey: string,
  ownerUserId = ownerOne,
  artifactDigest = ARTIFACT_DIGEST,
  auditDigest = AUDIT_DIGEST,
  scope = CAPABILITY_SCOPE.ACCOUNT,
  targetServerId?: string,
  kind = CAPABILITY_KIND.SKILL,
  capabilityId?: string,
  bindingId?: string,
  providers: string[] = [],
) {
  const sourceServerId = targetServerId ?? sourceServerForOwner(ownerUserId);
  const created = await createInstallOperation(db, {
    ownerUserId,
    idempotencyKey,
    requestSummary: {
      kind,
      sourceKind: CAPABILITY_SOURCE_KIND.INLINE,
      scope,
      providers,
      machines: [],
      ...(capabilityId ? { capabilityId } : {}),
      ...(bindingId ? { bindingId } : {}),
      targetServerId: sourceServerId,
    },
    now: 1_000,
  });
  const awaiting = await updateCapabilityOperation(db, {
    ownerUserId,
    operationId: created.operation.id,
    expectedRevision: created.operation.revision,
    state: 'awaiting_confirmation',
    artifactDigest,
    auditDigest,
    now: 2_000,
  });
  if (!awaiting) throw new Error('test operation transition failed');
  await recordCapabilityEvidence(db, {
    ownerUserId,
    operationId: created.operation.id,
    kind: 'audit',
    evidenceDigest: auditDigest,
    artifactDigest,
    policyVersion: 'auditor-v1',
    verdict: 'PASS',
    findings: [],
    now: 2_000,
  });
  const confirmed = await confirmCapabilityOperation(db, {
    ownerUserId,
    operationId: created.operation.id,
    expectedRevision: awaiting.revision,
    decision: CAPABILITY_CONFIRMATION_DECISION.INSTALL,
    artifactDigest,
    auditDigest,
    targetSummary: {
      scope,
      ...(capabilityId ? { capabilityId } : {}),
      ...(bindingId ? { bindingId } : {}),
      providers,
      machines: [],
    },
    now: 3_000,
  });
  if (confirmed.status !== 'ok') throw new Error(`test confirmation failed: ${confirmed.status}`);
  return confirmed.operation;
}

async function activateAndCommit(
  params: Omit<Parameters<typeof activateCapabilityVersion>[1], 'authorizationSigner' | 'targetServerId'>
    & { targetServerId?: string },
) {
  const targetServerId = params.targetServerId ?? sourceServerForOwner(params.ownerUserId);
  const candidate = await activateCapabilityVersion(db, {
    ...params,
    targetServerId,
    authorizationSigner,
  });
  if (candidate.pendingBlob) {
    const access = await issueCapabilityBlobAccess(db, {
      ownerUserId: params.ownerUserId,
      serverId: targetServerId,
      capabilityId: candidate.item.id,
      versionId: candidate.candidate.versionId,
      action: CAPABILITY_BLOB_ACTION.UPLOAD,
      signingKey: 'capability-blob-integration-key',
    });
    if (!access) throw new Error('candidate blob upload grant missing');
    const claims = await consumeCapabilityBlobAccess(db, access.singleUseToken, 'capability-blob-integration-key', {
      ownerUserId: params.ownerUserId,
      serverId: targetServerId,
      capabilityId: candidate.item.id,
      versionId: candidate.candidate.versionId,
      action: CAPABILITY_BLOB_ACTION.UPLOAD,
    });
    if (!claims) throw new Error('candidate blob upload claims missing');
    const stored = await persistCapabilityBlobUpload(db, claims, SKILL_BLOB);
    if (!stored?.stored) throw new Error('candidate blob upload failed');
  }
  const committed = await completeCapabilityCommit(db, {
    ownerUserId: params.ownerUserId,
    targetServerId,
    operationId: params.operationId,
    expectedRevision: candidate.operation.revision,
    capabilityId: candidate.item.id,
    versionId: candidate.candidate.versionId,
    bindingId: candidate.candidate.bindingId,
    authorityRevision: candidate.candidate.authorityRevision,
    now: (params.now ?? Date.now()) + 1,
  });
  if (committed.status !== 'ok') throw new Error(`candidate commit failed: ${committed.status}`);
  const replayedCommit = await completeCapabilityCommit(db, {
    ownerUserId: params.ownerUserId,
    targetServerId,
    operationId: params.operationId,
    expectedRevision: candidate.operation.revision,
    capabilityId: candidate.item.id,
    versionId: candidate.candidate.versionId,
    bindingId: candidate.candidate.bindingId,
    authorityRevision: candidate.candidate.authorityRevision,
    now: (params.now ?? Date.now()) + 2,
  });
  if (replayedCommit.status !== 'ok'
    || replayedCommit.item.revision !== committed.item.revision
    || replayedCommit.operation.revision !== committed.operation.revision) {
    throw new Error('candidate commit replay was not idempotently acknowledged');
  }
  return { ...candidate, item: committed.item, operation: committed.operation, accountRevision: committed.accountRevision };
}

describe('capability PostgreSQL authority', () => {
  it('creates install operations idempotently and hides them across accounts', async () => {
    const first = await createInstallOperation(db, {
      ownerUserId: ownerOne,
      idempotencyKey: 'same-logical-install',
      requestSummary: { kind: CAPABILITY_KIND.SKILL, sourceKind: CAPABILITY_SOURCE_KIND.INLINE },
      now: 10,
    });
    const retry = await createInstallOperation(db, {
      ownerUserId: ownerOne,
      idempotencyKey: 'same-logical-install',
      requestSummary: { kind: CAPABILITY_KIND.SKILL, sourceKind: CAPABILITY_SOURCE_KIND.INLINE },
      now: 20,
    });
    expect(first.created).toBe(true);
    expect(retry.created).toBe(false);
    expect(retry.operation.id).toBe(first.operation.id);
    await expect(getCapabilityOperation(db, {
      ownerUserId: ownerTwo,
      operationId: first.operation.id,
    })).resolves.toBeNull();

    const wrongOwnerCancel = await cancelCapabilityOperation(db, {
      ownerUserId: ownerTwo,
      operationId: first.operation.id,
      expectedRevision: first.operation.revision,
    });
    expect(wrongOwnerCancel.status).toBe('not_found');
    const cancelled = await cancelCapabilityOperation(db, {
      ownerUserId: ownerOne,
      operationId: first.operation.id,
      expectedRevision: first.operation.revision,
    });
    expect(cancelled).toMatchObject({ status: 'ok', operation: { state: 'cancelled', revision: 2 } });
    const staleCancel = await cancelCapabilityOperation(db, {
      ownerUserId: ownerOne,
      operationId: first.operation.id,
      expectedRevision: first.operation.revision,
    });
    expect(staleCancel.status).toBe('stale');
  });

  it('discovers bounded owner operations with active work first and recent terminals sorted newest-first', async () => {
    const baseTime = Date.now() + 100_000;
    const activeOld = await createInstallOperation(db, {
      ownerUserId: ownerOne,
      idempotencyKey: 'discover-active-old',
      requestSummary: { kind: CAPABILITY_KIND.SKILL, sourceKind: CAPABILITY_SOURCE_KIND.INLINE },
      now: baseTime,
    });
    const activeNew = await createInstallOperation(db, {
      ownerUserId: ownerOne,
      idempotencyKey: 'discover-active-new',
      requestSummary: { kind: CAPABILITY_KIND.SKILL, sourceKind: CAPABILITY_SOURCE_KIND.INLINE },
      now: baseTime + 1,
    });
    const otherOwner = await createInstallOperation(db, {
      ownerUserId: ownerTwo,
      idempotencyKey: 'discover-other-owner',
      requestSummary: { kind: CAPABILITY_KIND.SKILL, sourceKind: CAPABILITY_SOURCE_KIND.INLINE },
      now: baseTime + 2,
    });
    const terminalIds: string[] = [];
    for (let index = 0; index < 3; index += 1) {
      const created = await createInstallOperation(db, {
        ownerUserId: ownerOne,
        idempotencyKey: `discover-terminal-${index}`,
        requestSummary: { kind: CAPABILITY_KIND.SKILL, sourceKind: CAPABILITY_SOURCE_KIND.INLINE },
        now: baseTime + 3 + index,
      });
      const cancelled = await cancelCapabilityOperation(db, {
        ownerUserId: ownerOne,
        operationId: created.operation.id,
        expectedRevision: created.operation.revision,
        now: baseTime + 6 + index,
      });
      if (cancelled.status !== 'ok') throw new Error('test cancellation failed');
      terminalIds.push(cancelled.operation.id);
    }

    const discovered = await listRecentCapabilityOperations(db, {
      ownerUserId: ownerOne,
      activeLimit: 4,
      terminalLimit: 2,
    });
    expect(discovered.slice(0, 2).map((entry) => entry.id)).toEqual([
      activeNew.operation.id,
      activeOld.operation.id,
    ]);
    expect(discovered.slice(2).map((entry) => entry.id)).toEqual([
      terminalIds[2],
      terminalIds[1],
    ]);
    expect(discovered).toHaveLength(4);
    expect(discovered.every((entry) => entry.id !== otherOwner.operation.id)).toBe(true);

    const otherOwnerDiscovered = await listRecentCapabilityOperations(db, {
      ownerUserId: ownerTwo,
      activeLimit: 4,
      terminalLimit: 2,
    });
    expect(otherOwnerDiscovered.map((entry) => entry.id)).toContain(otherOwner.operation.id);
    expect(otherOwnerDiscovered.every((entry) => (
      entry.id !== activeOld.operation.id && entry.id !== activeNew.operation.id
    ))).toBe(true);
  });

  it('returns a revision and digest-bound content-safe confirmation envelope after reconnect', async () => {
    const created = await createInstallOperation(db, {
      ownerUserId: ownerOne,
      idempotencyKey: 'confirmation-envelope',
      requestSummary: {
        kind: CAPABILITY_KIND.SKILL,
        sourceKind: CAPABILITY_SOURCE_KIND.REPOSITORY,
        sourceLabel: 'github.com/acme/audited-skill',
        sourceLocatorDigest: '0'.repeat(64),
        scope: CAPABILITY_SCOPE.ACCOUNT,
        providers: ['codex'],
        machines: [serverOne],
      },
      now: 20_000,
    });
    const advanced = await advanceCapabilityOperation(db, {
      ownerUserId: ownerOne,
      operationId: created.operation.id,
      expectedRevision: created.operation.revision,
      state: 'awaiting_confirmation',
      artifactDigest: '3'.repeat(64),
      auditDigest: '4'.repeat(64),
      allowedCurrentStates: ['queued'],
      requestSummaryPatch: {
        tools: ['filesystem.read'], permissions: ['workspace.read'],
        updateDiff: ['instructions_changed'], hasScripts: true, hasExecutables: false,
      },
      evidence: {
        kind: 'audit', evidenceDigest: '4'.repeat(64), artifactDigest: '3'.repeat(64),
        policyVersion: 'auditor-v1', verdict: 'PASS', findings: [],
      },
      now: 20_001,
    });
    if (!advanced) throw new Error('confirmation operation did not advance');
    expect(toCapabilityOperationWire(advanced)).toMatchObject({
      revision: 2,
      sourceLabel: 'github.com/acme/audited-skill',
      artifactDigest: '3'.repeat(64),
      auditDigest: '4'.repeat(64),
      providers: ['codex'],
      machines: [serverOne],
      tools: ['filesystem.read'],
      permissions: ['workspace.read'],
      updateDiff: ['instructions_changed'],
      hasScripts: true,
      hasExecutables: false,
    });
    expect(JSON.stringify(toCapabilityOperationWire(advanced))).not.toContain('sourceLocatorDigest');
  });

  it('fails only nonterminal work bound to the disconnected owner daemon', async () => {
    const target = await createInstallOperation(db, {
      ownerUserId: ownerOne,
      idempotencyKey: 'disconnect-target',
      requestSummary: { targetServerId: serverOne, kind: CAPABILITY_KIND.SKILL },
      now: 30_000,
    });
    const otherServer = await createInstallOperation(db, {
      ownerUserId: ownerOne,
      idempotencyKey: 'disconnect-other-server',
      requestSummary: { targetServerId: 'another-server', kind: CAPABILITY_KIND.SKILL },
      now: 30_001,
    });
    const terminal = await createInstallOperation(db, {
      ownerUserId: ownerOne,
      idempotencyKey: 'disconnect-terminal',
      requestSummary: { targetServerId: serverOne, kind: CAPABILITY_KIND.SKILL },
      now: 30_002,
    });
    await cancelCapabilityOperation(db, {
      ownerUserId: ownerOne,
      operationId: terminal.operation.id,
      expectedRevision: terminal.operation.revision,
      now: 30_003,
    });
    const otherOwner = await createInstallOperation(db, {
      ownerUserId: ownerTwo,
      idempotencyKey: 'disconnect-other-owner',
      requestSummary: { targetServerId: serverOne, kind: CAPABILITY_KIND.SKILL },
      now: 30_004,
    });
    const confirmedBeforeCandidate = await prepareConfirmedOperation(
      'disconnect-after-confirm-before-candidate',
      ownerOne,
      '1'.repeat(64),
      '2'.repeat(64),
      CAPABILITY_SCOPE.ACCOUNT,
      serverOne,
    );
    const reviewed = await createInstallOperation(db, {
      ownerUserId: ownerOne,
      idempotencyKey: `disconnect-reviewed-${randomHex(6)}`,
      requestSummary: { targetServerId: serverOne, kind: CAPABILITY_KIND.SKILL },
      now: 30_004,
    });
    const reviewedAwaiting = await updateCapabilityOperation(db, {
      ownerUserId: ownerOne,
      operationId: reviewed.operation.id,
      expectedRevision: reviewed.operation.revision,
      state: CAPABILITY_INSTALL_STATE.AWAITING_CONFIRMATION,
      artifactDigest: '3'.repeat(64),
      auditDigest: '4'.repeat(64),
      now: 30_004,
    });
    if (!reviewedAwaiting) throw new Error('reviewed operation did not advance');

    const failed = await failCapabilityOperationsForDisconnectedServer(db, {
      ownerUserId: ownerOne,
      serverId: serverOne,
      now: 30_005,
    });
    expect(failed).toEqual([
      expect.objectContaining({
        id: target.operation.id,
        state: CAPABILITY_INSTALL_STATE.FAILED,
        errorCode: CAPABILITY_ERROR.RUNTIME_PENDING,
        revision: 2,
      }),
    ]);
    await expect(getCapabilityOperation(db, {
      ownerUserId: ownerOne,
      operationId: confirmedBeforeCandidate.id,
    })).resolves.toMatchObject({
      state: CAPABILITY_INSTALL_STATE.INSTALLING,
      revision: confirmedBeforeCandidate.revision,
    });
    await expect(getCapabilityOperation(db, {
      ownerUserId: ownerOne,
      operationId: reviewed.operation.id,
    })).resolves.toMatchObject({
      state: CAPABILITY_INSTALL_STATE.AWAITING_CONFIRMATION,
      revision: reviewedAwaiting.revision,
    });
    await expect(getCapabilityOperation(db, {
      ownerUserId: ownerOne,
      operationId: otherServer.operation.id,
    })).resolves.toMatchObject({ state: 'queued' });

    const expiredReviewed = await expireCapabilityPreActivationOperations(db, {
      ownerUserId: ownerOne,
      serverId: serverOne,
      now: 30_004 + CAPABILITY_LIMITS.PERSISTED_CANDIDATE_TTL_MS + 1,
    });
    expect(expiredReviewed).toContainEqual(expect.objectContaining({
      id: reviewed.operation.id,
      state: CAPABILITY_INSTALL_STATE.FAILED,
      errorCode: CAPABILITY_ERROR.RUNTIME_PENDING,
    }));
    await expect(getCapabilityOperation(db, {
      ownerUserId: ownerOne,
      operationId: terminal.operation.id,
    })).resolves.toMatchObject({ state: 'cancelled' });
    await expect(getCapabilityOperation(db, {
      ownerUserId: ownerTwo,
      operationId: otherOwner.operation.id,
    })).resolves.toMatchObject({ state: 'queued' });

    await db.execute(`
      UPDATE capability_operations
      SET request_summary = request_summary || '{"commitExpiresAt":0}'::jsonb
      WHERE owner_user_id = $1 AND id = $2
    `, [ownerOne, confirmedBeforeCandidate.id]);
    const expired = await expireCapabilityPreActivationOperations(db, {
      ownerUserId: ownerOne,
      serverId: serverOne,
      now: Date.now(),
    });
    expect(expired).toEqual([
      expect.objectContaining({
        id: confirmedBeforeCandidate.id,
        state: CAPABILITY_INSTALL_STATE.FAILED,
        errorCode: CAPABILITY_ERROR.RUNTIME_PENDING,
        revision: confirmedBeforeCandidate.revision + 1,
      }),
    ]);
  });

  it('atomically activates an immutable version only after current confirmation evidence', async () => {
    const confirmed = await prepareConfirmedOperation('activate-skill');
    await expect(activateCapabilityVersion(db, {
      authorizationSigner,
      ownerUserId: ownerOne,
      targetServerId: serverTwo,
      operationId: confirmed.id,
      expectedOperationRevision: confirmed.revision,
      name: 'portable-skill',
      kind: CAPABILITY_KIND.SKILL,
      sourceKind: CAPABILITY_SOURCE_KIND.INLINE,
      sourceSummary: 'wrong same-owner source daemon',
      artifactDigest: ARTIFACT_DIGEST,
      blobDigest: BLOB_DIGEST,
      blobByteSize: SKILL_BLOB.byteLength,
      auditDigest: AUDIT_DIGEST,
      manifest: {},
      permissionSummary: [],
      scope: CAPABILITY_SCOPE.ACCOUNT,
    })).rejects.toThrow('capability_activation_stale_operation');
    await expect(activateCapabilityVersion(db, {
      authorizationSigner,
      ownerUserId: ownerOne,
      targetServerId: sourceServerForOwner(ownerOne),
      operationId: confirmed.id,
      expectedOperationRevision: confirmed.revision,
      name: 'portable-skill',
      kind: CAPABILITY_KIND.SKILL,
      sourceKind: CAPABILITY_SOURCE_KIND.INLINE,
      sourceSummary: 'missing transfer blob',
      artifactDigest: ARTIFACT_DIGEST,
      auditDigest: AUDIT_DIGEST,
      manifest: {},
      permissionSummary: [],
      scope: CAPABILITY_SCOPE.ACCOUNT,
    })).rejects.toThrow('capability_activation_blob_policy');
    await expect(activateCapabilityVersion(db, {
      authorizationSigner,
      ownerUserId: ownerOne,
      targetServerId: sourceServerForOwner(ownerOne),
      operationId: confirmed.id,
      expectedOperationRevision: confirmed.revision,
      name: 'portable-skill',
      kind: CAPABILITY_KIND.SKILL,
      sourceKind: CAPABILITY_SOURCE_KIND.INLINE,
      sourceSummary: 'mismatched provider target',
      artifactDigest: ARTIFACT_DIGEST,
      blobDigest: BLOB_DIGEST,
      blobByteSize: SKILL_BLOB.byteLength,
      auditDigest: AUDIT_DIGEST,
      manifest: {},
      permissionSummary: [],
      scope: CAPABILITY_SCOPE.ACCOUNT,
      providerFilter: ['codex'],
      now: 3_500,
    })).rejects.toThrow('capability_activation_confirmation_mismatch');
    const activated = await activateAndCommit({
      ownerUserId: ownerOne,
      operationId: confirmed.id,
      expectedOperationRevision: confirmed.revision,
      name: 'portable-skill',
      kind: CAPABILITY_KIND.SKILL,
      sourceKind: CAPABILITY_SOURCE_KIND.INLINE,
      sourceSummary: 'inline package',
      artifactDigest: ARTIFACT_DIGEST,
      blobDigest: BLOB_DIGEST,
      blobByteSize: SKILL_BLOB.byteLength,
      auditDigest: AUDIT_DIGEST,
      manifest: { name: 'portable-skill' },
      permissionSummary: [],
      scope: CAPABILITY_SCOPE.ACCOUNT,
      now: 4_000,
    });
    expect(activated.item.lifecycleState).toBe(CAPABILITY_STATE.ACTIVE);
    expect(activated.item.activeVersion).toMatchObject({
      artifactDigest: ARTIFACT_DIGEST,
      auditDigest: AUDIT_DIGEST,
      versionNumber: 1,
    });
    const activatedAuthorization = activated.item.bindings[0]?.authorization;
    expect(activatedAuthorization).toBeDefined();
    expect(verifyCapabilitySkillAuthorization(
      activatedAuthorization!,
      authorizationSigner.key,
    )).toBe(true);
    expect(activatedAuthorization).toMatchObject({
      itemRevision: activated.item.revision,
      issuedRevision: activated.item.revision,
      bindingRevision: activated.item.bindings[0]?.revision,
      bindingState: CAPABILITY_AUTHORITY_STATE.ACTIVE,
    });
    const firstManage = await manageCapability(db, {
      ownerUserId: ownerOne,
      itemId: activated.item.id,
      expectedRevision: activated.item.revision,
      action: CAPABILITY_MANAGE_ACTION.DISABLE,
      bindingId: activated.item.bindings[0]?.id,
      authorizationSigner,
      now: 4_100,
    });
    expect(firstManage.status).toBe('ok');
    if (firstManage.status !== 'ok') throw new Error('first post-install manage failed');
    expect(firstManage.item.bindings[0]?.authorization).toMatchObject({
      itemRevision: firstManage.item.revision,
      issuedRevision: firstManage.item.revision,
      bindingState: CAPABILITY_AUTHORITY_STATE.DISABLED,
    });
    const disabledAuthority = toCapabilitySyncAuthorityFrame(
      await getCapabilityAuthorityRecordSet(db, { ownerUserId: ownerOne, serverId: serverOne }),
      [authorizationSigner.key],
    );
    expect(disabledAuthority.records.find((record) => record.bindingId === activated.item.bindings[0]?.id))
      .toMatchObject({
        state: CAPABILITY_AUTHORITY_STATE.DISABLED,
        itemRevision: firstManage.item.revision,
        authorization: firstManage.item.bindings[0]?.authorization,
      });
    expect(disabledAuthority.digest).toMatch(/^[0-9a-f]{64}$/);
    const reenabled = await manageCapability(db, {
      ownerUserId: ownerOne,
      itemId: activated.item.id,
      expectedRevision: firstManage.item.revision,
      action: CAPABILITY_MANAGE_ACTION.ENABLE,
      bindingId: firstManage.item.bindings[0]?.id,
      authorizationSigner,
      now: 4_101,
    });
    expect(reenabled.status).toBe('ok');
    if (reenabled.status !== 'ok') throw new Error('post-install re-enable failed');
    const signedSnapshot = toCapabilitySyncSnapshot(await getCapabilitySyncSnapshot(db, {
      ownerUserId: ownerOne,
      maxItems: CAPABILITY_LIMITS.SYNC_ITEMS,
      afterRevision: 0,
    }), CAPABILITY_SYNC_MSG.SNAPSHOT, [authorizationSigner.key]);
    expect(signedSnapshot.authorizationKeys).toEqual([authorizationSigner.key]);
    expect(signedSnapshot.bindings.find((binding) => binding.id === activated.item.bindings[0]?.id))
      .toMatchObject({ authorization: reenabled.item.bindings[0]?.authorization });
    expect(activated.accountRevision).toBeGreaterThan(0);
    await expect(getCapability(db, {
      ownerUserId: ownerTwo,
      itemId: activated.item.id,
    })).resolves.toBeNull();

    // Replaying the old activation revision is stale and the immutable version
    // count remains one: partial failure cannot replace the active version.
    await expect(activateCapabilityVersion(db, {
      authorizationSigner,
      ownerUserId: ownerOne,
      targetServerId: sourceServerForOwner(ownerOne),
      operationId: confirmed.id,
      expectedOperationRevision: confirmed.revision,
      name: 'portable-skill',
      kind: CAPABILITY_KIND.SKILL,
      sourceKind: CAPABILITY_SOURCE_KIND.INLINE,
      sourceSummary: 'replay',
      artifactDigest: 'd'.repeat(64),
      blobDigest: BLOB_DIGEST,
      blobByteSize: SKILL_BLOB.byteLength,
      auditDigest: AUDIT_DIGEST,
      manifest: {},
      permissionSummary: [],
      scope: CAPABILITY_SCOPE.ACCOUNT,
      now: 5_000,
    })).rejects.toThrow('capability_activation_stale_operation');
    const versionCount = await db.queryOne<{ count: number }>(`
      SELECT COUNT(*)::int AS count FROM capability_versions
      WHERE owner_user_id = $1 AND item_id = $2
    `, [ownerOne, activated.item.id]);
    expect(versionCount?.count).toBe(1);
    const evidenceBefore = await db.queryOne<{ count: number }>(`
      SELECT COUNT(*)::int AS count FROM capability_evidence WHERE operation_id = $1
    `, [confirmed.id]);
    const staleProgress = await advanceCapabilityOperation(db, {
      ownerUserId: ownerOne,
      operationId: confirmed.id,
      expectedRevision: confirmed.revision,
      state: 'rework',
      artifactDigest: 'd'.repeat(64),
      allowedCurrentStates: ['auditing'],
      evidence: {
        kind: 'scan',
        evidenceDigest: 'f'.repeat(64),
        artifactDigest: 'd'.repeat(64),
        policyVersion: 'stale-scanner',
        verdict: null,
        findings: [{ code: 'stale' }],
      },
    });
    expect(staleProgress).toBeNull();
    const evidenceAfter = await db.queryOne<{ count: number }>(`
      SELECT COUNT(*)::int AS count FROM capability_evidence WHERE operation_id = $1
    `, [confirmed.id]);
    expect(evidenceAfter?.count).toBe(evidenceBefore?.count);
  });

  it('accepts cancellation before confirmation and rejects it at the durable commit boundary', async () => {
    const queued = await createInstallOperation(db, {
      ownerUserId: ownerOne,
      idempotencyKey: `cancel-before-${randomHex(6)}`,
      requestSummary: { kind: CAPABILITY_KIND.SKILL, sourceKind: CAPABILITY_SOURCE_KIND.INLINE },
    });
    await expect(cancelCapabilityOperation(db, {
      ownerUserId: ownerOne,
      operationId: queued.operation.id,
      expectedRevision: queued.operation.revision,
    })).resolves.toMatchObject({ status: 'ok', operation: { state: 'cancelled' } });

    const committing = await prepareConfirmedOperation(`cancel-after-${randomHex(6)}`);
    await expect(cancelCapabilityOperation(db, {
      ownerUserId: ownerOne,
      operationId: committing.id,
      expectedRevision: committing.revision,
    })).resolves.toEqual({ status: 'committing' });
    await expect(getCapabilityOperation(db, {
      ownerUserId: ownerOne,
      operationId: committing.id,
    })).resolves.toMatchObject({ state: 'installing', revision: committing.revision });
  });

  it('issues an upload grant only to the exact daemon that owns the pending activation', async () => {
    const confirmed = await prepareConfirmedOperation(
      `blob-source-${randomHex(6)}`,
      ownerOne,
      'c'.repeat(64),
    );
    const content = Buffer.from(`source-bound-${randomHex(8)}`);
    const digest = sha256Hex(content);
    const candidate = await activateCapabilityVersion(db, {
      authorizationSigner,
      ownerUserId: ownerOne,
      targetServerId: serverOne,
      operationId: confirmed.id,
      expectedOperationRevision: confirmed.revision,
      name: 'source-bound-skill',
      kind: CAPABILITY_KIND.SKILL,
      sourceKind: CAPABILITY_SOURCE_KIND.INLINE,
      sourceSummary: 'source-bound package',
      artifactDigest: 'c'.repeat(64),
      blobDigest: digest,
      blobByteSize: content.byteLength,
      auditDigest: AUDIT_DIGEST,
      manifest: { name: 'source-bound-skill' },
      permissionSummary: [],
      scope: CAPABILITY_SCOPE.ACCOUNT,
      now: 4_500,
    });

    await expect(issueCapabilityBlobAccess(db, {
      ownerUserId: ownerOne,
      serverId: serverTwo,
      capabilityId: candidate.item.id,
      versionId: candidate.candidate.versionId,
      action: CAPABILITY_BLOB_ACTION.UPLOAD,
      signingKey: 'capability-blob-integration-key',
    })).resolves.toBeNull();
    await expect(getCapabilityOperation(db, {
      ownerUserId: ownerOne,
      operationId: confirmed.id,
    })).resolves.toMatchObject({
      state: CAPABILITY_INSTALL_STATE.SYNCING,
      revision: candidate.operation.revision,
    });

    await expect(issueCapabilityBlobAccess(db, {
      ownerUserId: ownerOne,
      serverId: serverOne,
      capabilityId: candidate.item.id,
      versionId: candidate.candidate.versionId,
      action: CAPABILITY_BLOB_ACTION.UPLOAD,
      signingKey: 'capability-blob-integration-key',
    })).resolves.toMatchObject({
      action: CAPABILITY_BLOB_ACTION.UPLOAD,
      capabilityId: candidate.item.id,
      versionId: candidate.candidate.versionId,
    });
    await expect(failCapabilityPendingActivation(db, {
      ownerUserId: ownerOne,
      operationId: confirmed.id,
      expectedRevision: candidate.operation.revision,
      targetServerId: serverOne,
      errorCode: CAPABILITY_ERROR.RUNTIME_PENDING,
    })).resolves.toMatchObject({ state: CAPABILITY_INSTALL_STATE.FAILED });
  });

  it('stores independently-digested Skill blobs once and serves them only through owner/server-bound grants', async () => {
    const item = (await listCapabilities(db, { ownerUserId: ownerOne, limit: 50 })).items
      .find((entry) => entry.name === 'portable-skill');
    if (!item?.activeVersion) throw new Error('portable skill version missing');
    expect(item.activeVersion.blobDigest).toBe(BLOB_DIGEST);
    expect(item.activeVersion.blobDigest).not.toBe(item.activeVersion.artifactDigest);
    expect(item.activeVersion.blobByteSize).toBe(SKILL_BLOB.byteLength);
    const readySync = await getCapabilitySyncSnapshot(db, {
      ownerUserId: ownerOne,
      maxItems: 50,
      afterRevision: 0,
    });
    expect(readySync.items.map((entry) => entry.id)).toContain(item.id);

    const signingKey = 'capability-blob-integration-key';
    await expect(issueCapabilityBlobAccess(db, {
      ownerUserId: ownerOne,
      serverId: serverOne,
      capabilityId: item.id,
      versionId: item.activeVersion.id,
      action: CAPABILITY_BLOB_ACTION.UPLOAD,
      signingKey,
    })).resolves.toBeNull();

    await db.execute(`
      UPDATE capability_bindings
      SET machine_filter = $3::jsonb
      WHERE owner_user_id = $1 AND item_id = $2 AND scope = 'account'
    `, [ownerOne, item.id, JSON.stringify([serverOne])]);
    await expect(issueCapabilityBlobAccess(db, {
      ownerUserId: ownerOne,
      serverId: serverTwo,
      capabilityId: item.id,
      versionId: item.activeVersion.id,
      action: CAPABILITY_BLOB_ACTION.DOWNLOAD,
      signingKey,
    })).resolves.toBeNull();
    await expect(issueCapabilityBlobAccess(db, {
      ownerUserId: ownerOne,
      serverId: serverOtherOwner,
      capabilityId: item.id,
      versionId: item.activeVersion.id,
      action: CAPABILITY_BLOB_ACTION.DOWNLOAD,
      signingKey,
    })).resolves.toBeNull();

    const download = await issueCapabilityBlobAccess(db, {
      ownerUserId: ownerOne,
      serverId: serverOne,
      capabilityId: item.id,
      versionId: item.activeVersion.id,
      action: CAPABILITY_BLOB_ACTION.DOWNLOAD,
      signingKey,
    });
    if (!download) throw new Error('download grant missing');
    await expect(consumeCapabilityBlobAccess(db, download.singleUseToken, signingKey, {
      ownerUserId: ownerOne,
      serverId: 'wrong-server',
      versionId: item.activeVersion.id,
      action: CAPABILITY_BLOB_ACTION.DOWNLOAD,
    })).resolves.toBeNull();
    const downloadClaims = await consumeCapabilityBlobAccess(db, download.singleUseToken, signingKey, {
      ownerUserId: ownerOne,
      serverId: serverOne,
      versionId: item.activeVersion.id,
      action: CAPABILITY_BLOB_ACTION.DOWNLOAD,
    });
    if (!downloadClaims) throw new Error('download grant rejected');
    await expect(readCapabilityBlobDownload(db, downloadClaims)).resolves.toEqual(SKILL_BLOB);

    await db.execute(`
      UPDATE capability_bindings
      SET machine_filter = '[]'::jsonb
      WHERE owner_user_id = $1 AND item_id = $2 AND scope = 'account'
    `, [ownerOne, item.id]);
    await expect(issueCapabilityBlobAccess(db, {
      ownerUserId: ownerOne,
      serverId: serverTwo,
      capabilityId: item.id,
      versionId: item.activeVersion.id,
      action: CAPABILITY_BLOB_ACTION.DOWNLOAD,
      signingKey,
    })).resolves.toMatchObject({ action: CAPABILITY_BLOB_ACTION.DOWNLOAD });
  });

  it('generates server-owned item/version identities for equal digests across owners and installs', async () => {
    const ownerTwoOperation = await prepareConfirmedOperation('same-content-owner-two', ownerTwo);
    const ownerTwoActivation = await activateAndCommit({
      ownerUserId: ownerTwo,
      operationId: ownerTwoOperation.id,
      expectedOperationRevision: ownerTwoOperation.revision,
      name: 'shared-content-skill',
      kind: CAPABILITY_KIND.SKILL,
      sourceKind: CAPABILITY_SOURCE_KIND.INLINE,
      sourceSummary: 'same bytes',
      artifactDigest: ARTIFACT_DIGEST,
      blobDigest: BLOB_DIGEST,
      blobByteSize: SKILL_BLOB.byteLength,
      auditDigest: AUDIT_DIGEST,
      manifest: {},
      permissionSummary: [],
      scope: CAPABILITY_SCOPE.ACCOUNT,
      now: 4_100,
    });
    const ownerOneSecondOperation = await prepareConfirmedOperation('same-content-owner-one-second');
    const ownerOneSecondActivation = await activateAndCommit({
      ownerUserId: ownerOne,
      operationId: ownerOneSecondOperation.id,
      expectedOperationRevision: ownerOneSecondOperation.revision,
      name: 'shared-content-skill-two',
      kind: CAPABILITY_KIND.SKILL,
      sourceKind: CAPABILITY_SOURCE_KIND.INLINE,
      sourceSummary: 'same bytes',
      artifactDigest: ARTIFACT_DIGEST,
      blobDigest: BLOB_DIGEST,
      blobByteSize: SKILL_BLOB.byteLength,
      auditDigest: AUDIT_DIGEST,
      manifest: {},
      permissionSummary: [],
      scope: CAPABILITY_SCOPE.ACCOUNT,
      now: 4_200,
    });
    const ownerOneFirst = (await listCapabilities(db, { ownerUserId: ownerOne, limit: 50 })).items
      .find((item) => item.name === 'portable-skill');
    expect(ownerOneFirst).toBeDefined();
    expect(new Set([
      ownerOneFirst!.id,
      ownerTwoActivation.item.id,
      ownerOneSecondActivation.item.id,
    ]).size).toBe(3);
    expect(new Set([
      ownerOneFirst!.activeVersion!.id,
      ownerTwoActivation.item.activeVersion!.id,
      ownerOneSecondActivation.item.activeVersion!.id,
    ]).size).toBe(3);
    expect(ownerTwoActivation.item.activeVersion?.artifactDigest).toBe(ARTIFACT_DIGEST);
    expect(ownerOneSecondActivation.item.activeVersion?.artifactDigest).toBe(ARTIFACT_DIGEST);
  });

  it('keeps a bounded immutable version history that can be rolled back by owner revision', async () => {
    const current = (await listCapabilities(db, { ownerUserId: ownerOne, limit: 50 })).items
      .find((item) => item.name === 'portable-skill');
    if (!current?.activeVersion || !current.bindings[0]) throw new Error('portable skill missing');
    const originalVersionId = current.activeVersion.id;
    const updateArtifact = 'd'.repeat(64);
    const updateAudit = 'e'.repeat(64);
    const updateOperation = await prepareConfirmedOperation(
      'portable-skill-update',
      ownerOne,
      updateArtifact,
      updateAudit,
      CAPABILITY_SCOPE.ACCOUNT,
      undefined,
      CAPABILITY_KIND.SKILL,
      current.id,
      current.bindings[0].id,
    );
    const updated = await activateAndCommit({
      ownerUserId: ownerOne,
      operationId: updateOperation.id,
      expectedOperationRevision: updateOperation.revision,
      requestedItemId: current.id,
      requestedBindingId: current.bindings[0].id,
      name: 'portable-skill',
      kind: CAPABILITY_KIND.SKILL,
      sourceKind: CAPABILITY_SOURCE_KIND.INLINE,
      sourceSummary: 'inline package update',
      artifactDigest: updateArtifact,
      blobDigest: BLOB_DIGEST,
      blobByteSize: SKILL_BLOB.byteLength,
      auditDigest: updateAudit,
      manifest: {},
      permissionSummary: [],
      scope: CAPABILITY_SCOPE.ACCOUNT,
      now: 4_300,
    });
    expect(updated.item.id).toBe(current.id);
    expect(updated.item.versions.map((version) => version.versionNumber)).toEqual([2, 1]);
    expect(updated.item.activeVersion?.id).not.toBe(originalVersionId);
    const updatedVersionId = updated.item.activeVersion!.id;
    const projectBindingId = `project-binding-${randomHex(8)}`;
    const projectAuthorization = authorizationSigner.signSkill({
      ownerId: ownerOne,
      capabilityId: current.id,
      versionId: updatedVersionId,
      artifactDigest: updateArtifact,
      auditDigest: updateAudit,
      blobDigest: BLOB_DIGEST,
      binding: {
        id: projectBindingId,
        capabilityId: current.id,
        versionId: updatedVersionId,
        scope: CAPABILITY_SCOPE.PROJECT,
        scopeId: 'project-two-version-fixture',
        providers: [],
        machines: [],
        active: true,
      },
      itemRevision: updated.item.revision,
      bindingRevision: 1,
      bindingState: CAPABILITY_AUTHORITY_STATE.ACTIVE,
      issuedRevision: updated.item.revision,
      issuedAt: 4_350,
    });
    await db.execute(`
      INSERT INTO capability_bindings (
        id, owner_user_id, item_id, version_id, scope, project_key,
        provider_filter, machine_filter, enabled, authority_state,
        authorization_envelope, revision, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, 'project', $5, '[]'::jsonb, '[]'::jsonb,
                TRUE, 'active', $6::jsonb, 1, $7, $7)
    `, [
      projectBindingId, ownerOne, current.id, updatedVersionId,
      'project-two-version-fixture', JSON.stringify(projectAuthorization), 4_350,
    ]);
    const accountBindingId = updated.item.bindings[0]!.id;
    const rolledBack = await manageCapability(db, {
      ownerUserId: ownerOne,
      itemId: current.id,
      expectedRevision: updated.item.revision,
      action: CAPABILITY_MANAGE_ACTION.ROLLBACK,
      bindingId: accountBindingId,
      targetVersionId: originalVersionId,
      scope: CAPABILITY_SCOPE.ACCOUNT,
      authorizationSigner,
      now: 4_400,
    });
    expect(rolledBack.status).toBe('ok');
    if (rolledBack.status !== 'ok') throw new Error('rollback failed');
    expect(rolledBack.item.versions).toHaveLength(2);
    const rolledBackAccount = rolledBack.item.bindings.find((binding) => binding.id === accountBindingId);
    const untouchedProject = rolledBack.item.bindings.find((binding) => binding.id === projectBindingId);
    expect(rolledBackAccount?.versionId).toBe(originalVersionId);
    expect(untouchedProject).toMatchObject({
      versionId: updatedVersionId,
      revision: 1,
      authorization: projectAuthorization,
    });
    const rollbackAuthorization = rolledBackAccount?.authorization;
    expect(rollbackAuthorization).toMatchObject({
      ownerId: ownerOne,
      capabilityId: current.id,
      versionId: originalVersionId,
      bindingId: accountBindingId,
      issuedRevision: rolledBack.item.revision,
    });
    expect(verifyCapabilitySkillAuthorization(
      rollbackAuthorization!,
      authorizationSigner.key,
    )).toBe(true);
    const currentAuthority = await getCapabilityAuthorityRecordSet(db, {
      ownerUserId: ownerOne,
      serverId: serverOne,
    });
    expect(currentAuthority.records.find((record) => record.bindingId === projectBindingId)).toMatchObject({
      versionId: updatedVersionId,
      itemRevision: projectAuthorization.itemRevision,
      bindingRevision: 1,
      authorization: projectAuthorization,
    });
    const siblingBindingId = `account-filter-binding-${randomHex(8)}`;
    const siblingAuthorization = authorizationSigner.signSkill({
      ownerId: ownerOne,
      capabilityId: current.id,
      versionId: updatedVersionId,
      artifactDigest: updateArtifact,
      auditDigest: updateAudit,
      blobDigest: BLOB_DIGEST,
      binding: {
        id: siblingBindingId,
        capabilityId: current.id,
        versionId: updatedVersionId,
        scope: CAPABILITY_SCOPE.ACCOUNT,
        providers: ['codex'],
        machines: [],
        active: true,
      },
      itemRevision: rolledBack.item.revision,
      bindingRevision: 1,
      bindingState: CAPABILITY_AUTHORITY_STATE.ACTIVE,
      issuedRevision: rolledBack.item.revision,
      issuedAt: 4_450,
    });
    await db.execute(`
      INSERT INTO capability_bindings (
        id, owner_user_id, item_id, version_id, scope, provider_filter,
        machine_filter, enabled, authority_state, authorization_envelope,
        revision, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, 'account', $5::jsonb, '[]'::jsonb,
                TRUE, 'active', $6::jsonb, 1, $7, $7)
    `, [
      siblingBindingId, ownerOne, current.id, updatedVersionId,
      JSON.stringify(['codex']), JSON.stringify(siblingAuthorization), 4_450,
    ]);
    const exactUpdateArtifact = '9'.repeat(64);
    const exactUpdateAudit = 'a'.repeat(64);
    const exactUpdateOperation = await prepareConfirmedOperation(
      `exact-binding-update-${randomHex(6)}`,
      ownerOne,
      exactUpdateArtifact,
      exactUpdateAudit,
      CAPABILITY_SCOPE.ACCOUNT,
      undefined,
      CAPABILITY_KIND.SKILL,
      current.id,
      siblingBindingId,
      ['codex'],
    );
    const exactUpdated = await activateAndCommit({
      ownerUserId: ownerOne,
      operationId: exactUpdateOperation.id,
      expectedOperationRevision: exactUpdateOperation.revision,
      requestedItemId: current.id,
      requestedBindingId: siblingBindingId,
      name: 'portable-skill',
      kind: CAPABILITY_KIND.SKILL,
      sourceKind: CAPABILITY_SOURCE_KIND.INLINE,
      sourceSummary: 'exact binding update',
      artifactDigest: exactUpdateArtifact,
      blobDigest: BLOB_DIGEST,
      blobByteSize: SKILL_BLOB.byteLength,
      auditDigest: exactUpdateAudit,
      manifest: {},
      permissionSummary: [],
      scope: CAPABILITY_SCOPE.ACCOUNT,
      providerFilter: ['codex'],
      now: 4_500,
    });
    expect(exactUpdated.item.bindings.find((binding) => binding.id === siblingBindingId)?.versionId)
      .toBe(exactUpdated.candidate.versionId);
    expect(exactUpdated.item.bindings.find((binding) => binding.id === accountBindingId)?.versionId)
      .toBe(originalVersionId);
    expect(exactUpdated.item.bindings.find((binding) => binding.id === projectBindingId)?.versionId)
      .toBe(updatedVersionId);
    await db.execute(`
      UPDATE capability_items SET active_version_id = $3
      WHERE owner_user_id = $1 AND id = $2
    `, [ownerOne, current.id, originalVersionId]);
    await db.execute(`
      DELETE FROM capability_bindings
      WHERE owner_user_id = $1 AND item_id = $2 AND id = ANY($3::text[])
    `, [ownerOne, current.id, [projectBindingId, siblingBindingId]]);
    await db.execute(`
      DELETE FROM capability_versions
      WHERE owner_user_id = $1 AND item_id = $2 AND id = $3
    `, [ownerOne, current.id, exactUpdated.candidate.versionId]);

    const crossOwnerOperation = await prepareConfirmedOperation(
      'cross-owner-update-target',
      ownerTwo,
      '7'.repeat(64),
      '8'.repeat(64),
      CAPABILITY_SCOPE.ACCOUNT,
      undefined,
      CAPABILITY_KIND.SKILL,
      current.id,
      current.bindings[0].id,
    );
    await expect(activateCapabilityVersion(db, {
      authorizationSigner,
      ownerUserId: ownerTwo,
      targetServerId: sourceServerForOwner(ownerTwo),
      operationId: crossOwnerOperation.id,
      expectedOperationRevision: crossOwnerOperation.revision,
      requestedItemId: current.id,
      requestedBindingId: current.bindings[0].id,
      name: 'forbidden-cross-owner-update',
      kind: CAPABILITY_KIND.SKILL,
      sourceKind: CAPABILITY_SOURCE_KIND.INLINE,
      sourceSummary: 'must not create a replacement item',
      artifactDigest: '7'.repeat(64),
      blobDigest: BLOB_DIGEST,
      blobByteSize: SKILL_BLOB.byteLength,
      auditDigest: '8'.repeat(64),
      manifest: {},
      permissionSummary: [],
      scope: CAPABILITY_SCOPE.ACCOUNT,
      now: 4_405,
    })).rejects.toThrow('capability_update_target_missing');
  });

  it('keeps the prior active version untouched until blob-ready and matching daemon commit', async () => {
    const current = (await listCapabilities(db, { ownerUserId: ownerOne, limit: 50 })).items
      .find((item) => item.name === 'portable-skill');
    if (!current?.activeVersion || !current.bindings[0]) throw new Error('atomic update baseline missing');
    const priorVersionId = current.activeVersion.id;
    const candidateBytes = Buffer.from(`candidate-${randomHex(8)}`);
    const candidateBlobDigest = sha256Hex(candidateBytes);
    const operation = await prepareConfirmedOperation(
      `atomic-update-${randomHex(6)}`,
      ownerOne,
      '6'.repeat(64),
      '7'.repeat(64),
      CAPABILITY_SCOPE.ACCOUNT,
      undefined,
      CAPABILITY_KIND.SKILL,
      current.id,
      current.bindings[0].id,
    );
    const disconnected = await failCapabilityOperationsForDisconnectedServer(db, {
      ownerUserId: ownerOne,
      serverId: sourceServerForOwner(ownerOne),
    });
    expect(disconnected.every((entry) => entry.id !== operation.id)).toBe(true);
    await expect(getCapabilityOperation(db, {
      ownerUserId: ownerOne,
      operationId: operation.id,
    })).resolves.toMatchObject({
      state: CAPABILITY_INSTALL_STATE.INSTALLING,
      revision: operation.revision,
    });
    const candidate = await activateCapabilityVersion(db, {
      authorizationSigner,
      ownerUserId: ownerOne,
      targetServerId: sourceServerForOwner(ownerOne),
      operationId: operation.id,
      expectedOperationRevision: operation.revision,
      requestedItemId: current.id,
      requestedBindingId: current.bindings[0].id,
      name: current.name,
      kind: CAPABILITY_KIND.SKILL,
      sourceKind: CAPABILITY_SOURCE_KIND.INLINE,
      sourceSummary: 'candidate update',
      artifactDigest: '6'.repeat(64),
      blobDigest: candidateBlobDigest,
      blobByteSize: candidateBytes.byteLength,
      auditDigest: '7'.repeat(64),
      manifest: {},
      permissionSummary: [],
      scope: CAPABILITY_SCOPE.ACCOUNT,
    });
    expect(candidate.pendingBlob).toBe(true);
    const replayedCandidate = await activateCapabilityVersion(db, {
      authorizationSigner,
      ownerUserId: ownerOne,
      targetServerId: sourceServerForOwner(ownerOne),
      operationId: operation.id,
      expectedOperationRevision: operation.revision,
      requestedItemId: current.id,
      requestedBindingId: current.bindings[0].id,
      name: current.name,
      kind: CAPABILITY_KIND.SKILL,
      sourceKind: CAPABILITY_SOURCE_KIND.INLINE,
      sourceSummary: 'candidate update',
      artifactDigest: '6'.repeat(64),
      blobDigest: candidateBlobDigest,
      blobByteSize: candidateBytes.byteLength,
      auditDigest: '7'.repeat(64),
      manifest: {},
      permissionSummary: [],
      scope: CAPABILITY_SCOPE.ACCOUNT,
    });
    expect(replayedCandidate.candidate).toEqual(candidate.candidate);
    expect(replayedCandidate.operation).toMatchObject({
      id: candidate.operation.id,
      revision: candidate.operation.revision,
      state: CAPABILITY_INSTALL_STATE.SYNCING,
    });
    await expect(activateCapabilityVersion(db, {
      authorizationSigner,
      ownerUserId: ownerOne,
      targetServerId: sourceServerForOwner(ownerOne),
      operationId: operation.id,
      expectedOperationRevision: operation.revision,
      requestedItemId: current.id,
      requestedBindingId: current.bindings[0].id,
      name: current.name,
      kind: CAPABILITY_KIND.SKILL,
      sourceKind: CAPABILITY_SOURCE_KIND.INLINE,
      sourceSummary: 'tampered replay source',
      artifactDigest: '6'.repeat(64),
      blobDigest: candidateBlobDigest,
      blobByteSize: candidateBytes.byteLength,
      auditDigest: '7'.repeat(64),
      manifest: {},
      permissionSummary: [],
      scope: CAPABILITY_SCOPE.ACCOUNT,
    })).rejects.toThrow('capability_activation_stale_operation');
    const pendingVersionCount = await db.queryOne<{ count: number }>(`
      SELECT COUNT(*)::int AS count
      FROM capability_versions
      WHERE owner_user_id = $1 AND item_id = $2 AND publication_state = 'pending'
    `, [ownerOne, current.id]);
    expect(pendingVersionCount?.count).toBe(1);
    const beforeUpload = await getCapability(db, { ownerUserId: ownerOne, itemId: current.id });
    expect(beforeUpload?.activeVersion?.id).toBe(priorVersionId);
    expect(beforeUpload?.versions.some((version) => version.id === candidate.candidate.versionId)).toBe(false);
    const beforeUploadSnapshot = await getCapabilitySyncSnapshot(db, {
      ownerUserId: ownerOne,
      maxItems: CAPABILITY_LIMITS.SYNC_ITEMS,
      afterRevision: 0,
    });
    const synchronizedBeforeUpload = beforeUploadSnapshot.items.find((item) => item.id === current.id);
    expect(synchronizedBeforeUpload?.activeVersion?.id).toBe(priorVersionId);
    expect(synchronizedBeforeUpload?.versions.some((version) => (
      version.id === candidate.candidate.versionId
    ))).toBe(false);

    const wrongSourceCommit = await completeCapabilityCommit(db, {
      ownerUserId: ownerOne,
      targetServerId: serverTwo,
      operationId: operation.id,
      expectedRevision: candidate.operation.revision,
      capabilityId: current.id,
      versionId: candidate.candidate.versionId,
      bindingId: candidate.candidate.bindingId,
      authorityRevision: candidate.candidate.authorityRevision,
    });
    expect(wrongSourceCommit.status).toBe('stale');

    const mismatchedFailure = await failCapabilityPendingActivation(db, {
      ownerUserId: ownerOne,
      operationId: operation.id,
      errorCode: CAPABILITY_ERROR.INTEGRITY_FAILED,
      expectedRevision: candidate.operation.revision,
      capabilityId: current.id,
      versionId: candidate.candidate.versionId,
      bindingId: candidate.candidate.bindingId,
      authorityRevision: candidate.candidate.authorityRevision,
      targetServerId: serverTwo,
    });
    expect(mismatchedFailure).toBeNull();
    await expect(getCapabilityOperation(db, {
      ownerUserId: ownerOne,
      operationId: operation.id,
    })).resolves.toMatchObject({
      state: CAPABILITY_INSTALL_STATE.SYNCING,
      revision: candidate.operation.revision,
    });
    await db.execute(`
      UPDATE capability_pending_activations SET expires_at = 0
      WHERE owner_user_id = $1 AND operation_id = $2
    `, [ownerOne, operation.id]);
    const expired = await expireCapabilityPendingActivations(db, {
      ownerUserId: ownerOne,
      targetServerId: sourceServerForOwner(ownerOne),
      now: Date.now(),
    });
    expect(expired).toEqual([expect.objectContaining({
      capabilityId: current.id,
      versionId: candidate.candidate.versionId,
      authorityRevision: candidate.candidate.authorityRevision,
      operation: expect.objectContaining({
        state: CAPABILITY_INSTALL_STATE.FAILED,
        errorCode: CAPABILITY_ERROR.RUNTIME_PENDING,
      }),
    })]);
    const afterFailure = await getCapability(db, { ownerUserId: ownerOne, itemId: current.id });
    expect(afterFailure?.activeVersion?.id).toBe(priorVersionId);
    const replay = await completeCapabilityCommit(db, {
      ownerUserId: ownerOne,
      targetServerId: sourceServerForOwner(ownerOne),
      operationId: operation.id,
      expectedRevision: candidate.operation.revision,
      capabilityId: current.id,
      versionId: candidate.candidate.versionId,
      bindingId: candidate.candidate.bindingId,
      authorityRevision: candidate.candidate.authorityRevision,
    });
    expect(replay.status).toBe('not_found');
  });

  it('keeps a fresh synchronized Skill candidate invisible until its durable commit', async () => {
    const name = `pending-skill-${randomHex(6)}`;
    const artifactDigest = '4'.repeat(64);
    const auditDigest = '5'.repeat(64);
    const candidateBytes = Buffer.from(`pending-${randomHex(8)}`);
    const operation = await prepareConfirmedOperation(
      `pending-invisible-${randomHex(6)}`,
      ownerOne,
      artifactDigest,
      auditDigest,
    );
    const candidate = await activateCapabilityVersion(db, {
      authorizationSigner,
      ownerUserId: ownerOne,
      targetServerId: sourceServerForOwner(ownerOne),
      operationId: operation.id,
      expectedOperationRevision: operation.revision,
      name,
      kind: CAPABILITY_KIND.SKILL,
      sourceKind: CAPABILITY_SOURCE_KIND.INLINE,
      sourceSummary: 'fresh candidate must remain private',
      artifactDigest,
      blobDigest: sha256Hex(candidateBytes),
      blobByteSize: candidateBytes.byteLength,
      auditDigest,
      manifest: {},
      permissionSummary: [],
      scope: CAPABILITY_SCOPE.ACCOUNT,
    });
    expect(candidate.pendingBlob).toBe(true);
    expect((await listCapabilities(db, {
      ownerUserId: ownerOne,
      limit: CAPABILITY_LIMITS.SYNC_ITEMS,
      includeRemoved: true,
    })).items.some((item) => item.id === candidate.item.id)).toBe(false);
    expect((await getCapabilitySyncSnapshot(db, {
      ownerUserId: ownerOne,
      maxItems: CAPABILITY_LIMITS.SYNC_ITEMS,
      afterRevision: 0,
    })).items.some((item) => item.id === candidate.item.id)).toBe(false);

    await db.execute(`
      UPDATE capability_pending_activations SET expires_at = 0
      WHERE owner_user_id = $1 AND operation_id = $2
    `, [ownerOne, operation.id]);
    await expireCapabilityPendingActivations(db, {
      ownerUserId: ownerOne,
      targetServerId: sourceServerForOwner(ownerOne),
      now: Date.now(),
    });
    await expect(getCapability(db, {
      ownerUserId: ownerOne,
      itemId: candidate.item.id,
    })).resolves.toBeNull();
  });

  it('admits exactly the complete-state synchronized item cap and rejects the next item atomically', async () => {
    const quotaOwner = `cap-quota-owner-${randomHex(8)}`;
    const prefix = `quota-${randomHex(8)}`;
    await createUser(db, quotaOwner, quotaOwner);
    try {
      const seeded = CAPABILITY_LIMITS.SYNC_ITEMS - 1;
      await db.execute(`
        INSERT INTO capability_items (
          id, owner_user_id, kind, name, lifecycle_state, revision, created_at, updated_at
        )
        SELECT $1 || '-item-' || n, $2, 'mcp', $1 || '-name-' || n,
               'runtime_pending', 1, 6000 + n, 6000 + n
        FROM generate_series(1, $3::int) AS n
      `, [prefix, quotaOwner, seeded]);
      await db.execute(`
        INSERT INTO capability_versions (
          id, owner_user_id, item_id, version_number, artifact_digest, audit_digest,
          source_kind, source_summary, manifest, definition, permission_summary,
          publication_state, created_at
        )
        SELECT $1 || '-version-' || n, $2, $1 || '-item-' || n, 1,
               repeat('a', 64), repeat('b', 64), 'mcp_config',
               'quota fixture', '{}'::jsonb,
               jsonb_build_object(
                 'name', $1 || '-mcp-' || n,
                 'transport', 'streamable_http',
                 'url', 'https://mcp.example.test/v1'
               ),
               '[]'::jsonb, 'active', 6000 + n
        FROM generate_series(1, $3::int) AS n
      `, [prefix, quotaOwner, seeded]);
      await db.execute(`
        UPDATE capability_items
        SET active_version_id = replace(id, '-item-', '-version-')
        WHERE owner_user_id = $1 AND id LIKE $2
      `, [quotaOwner, `${prefix}-item-%`]);
      await db.execute(`
        INSERT INTO capability_bindings (
          id, owner_user_id, item_id, version_id, scope, provider_filter,
          machine_filter, enabled, revision, created_at, updated_at
        )
        SELECT $1 || '-binding-' || n, $2, $1 || '-item-' || n,
               $1 || '-version-' || n, 'account', '[]'::jsonb, '[]'::jsonb,
               TRUE, 1, 6000 + n, 6000 + n
        FROM generate_series(1, $3::int) AS n
      `, [prefix, quotaOwner, seeded]);

      const twoHundredth = await prepareConfirmedOperation(
        `${prefix}-accepted`,
        quotaOwner,
        'c'.repeat(64),
        'd'.repeat(64),
        CAPABILITY_SCOPE.ACCOUNT,
        undefined,
        CAPABILITY_KIND.MCP,
      );
      await activateAndCommit({
        ownerUserId: quotaOwner,
        operationId: twoHundredth.id,
        expectedOperationRevision: twoHundredth.revision,
        name: `${prefix}-accepted`,
        kind: CAPABILITY_KIND.MCP,
        sourceKind: CAPABILITY_SOURCE_KIND.MCP_CONFIG,
        sourceSummary: 'quota accepted fixture',
        artifactDigest: 'c'.repeat(64),
        auditDigest: 'd'.repeat(64),
        manifest: {},
        definition: {
          name: `${prefix}-accepted`,
          transport: 'streamable_http',
          url: 'https://mcp.example.test/v1',
        },
        permissionSummary: [],
        scope: CAPABILITY_SCOPE.ACCOUNT,
      });
      const complete = await getCapabilitySyncSnapshot(db, {
        ownerUserId: quotaOwner,
        maxItems: CAPABILITY_LIMITS.SYNC_ITEMS,
        afterRevision: 0,
      });
      expect(complete.items).toHaveLength(CAPABILITY_LIMITS.SYNC_ITEMS);
      expect(new Set(complete.items.map((item) => item.id)).size).toBe(CAPABILITY_LIMITS.SYNC_ITEMS);
      expect(() => toCapabilitySyncSnapshot(
        complete,
        CAPABILITY_SYNC_MSG.SNAPSHOT,
        [authorizationSigner.key],
      )).not.toThrow();

      const rejected = await prepareConfirmedOperation(
        `${prefix}-rejected`,
        quotaOwner,
        'e'.repeat(64),
        'f'.repeat(64),
        CAPABILITY_SCOPE.ACCOUNT,
        undefined,
        CAPABILITY_KIND.MCP,
      );
      await expect(activateCapabilityVersion(db, {
        authorizationSigner,
        ownerUserId: quotaOwner,
        targetServerId: sourceServerForOwner(quotaOwner),
        operationId: rejected.id,
        expectedOperationRevision: rejected.revision,
        name: `${prefix}-rejected`,
        kind: CAPABILITY_KIND.MCP,
        sourceKind: CAPABILITY_SOURCE_KIND.MCP_CONFIG,
        sourceSummary: 'quota rejected fixture',
        artifactDigest: 'e'.repeat(64),
        auditDigest: 'f'.repeat(64),
        manifest: {},
        definition: {
          name: `${prefix}-rejected`,
          transport: 'streamable_http',
          url: 'https://mcp.example.test/v1',
        },
        permissionSummary: [],
        scope: CAPABILITY_SCOPE.ACCOUNT,
      })).rejects.toThrow('capability_sync_item_quota_exceeded');
      const count = await db.queryOne<{ count: number }>(`
        SELECT COUNT(DISTINCT item_id)::int AS count
        FROM capability_bindings
        WHERE owner_user_id = $1 AND scope <> 'local'
      `, [quotaOwner]);
      expect(count?.count).toBe(CAPABILITY_LIMITS.SYNC_ITEMS);
      await expect(db.queryOne<{ id: string }>(`
        SELECT id FROM capability_items
        WHERE owner_user_id = $1 AND name = $2
      `, [quotaOwner, `${prefix}-rejected`])).resolves.toBeNull();
      await expect(getCapabilityOperation(db, {
        ownerUserId: quotaOwner,
        operationId: rejected.id,
      })).resolves.toMatchObject({ state: CAPABILITY_INSTALL_STATE.INSTALLING, itemId: null });

      await db.execute(`
        UPDATE capability_bindings
        SET enabled = FALSE, authority_state = 'removed'
        WHERE owner_user_id = $1 AND item_id LIKE $2
      `, [quotaOwner, `${prefix}-item-%`]);
      await db.execute(`
        UPDATE capability_items
        SET lifecycle_state = 'removed', active_version_id = NULL, removed_at = 7_000
        WHERE owner_user_id = $1 AND id LIKE $2
      `, [quotaOwner, `${prefix}-item-%`]);
      await db.execute(`
        INSERT INTO capability_tombstones (
          id, owner_user_id, item_id, scope, account_revision, expires_at, created_at
        )
        SELECT $1 || '-tombstone-' || n, $2, $1 || '-item-' || n,
               'account', 1, 0, 7_000
        FROM generate_series(1, $3::int) AS n
      `, [prefix, quotaOwner, seeded]);
      await expect(sweepExpiredCapabilityHistory(db, { now: 8_000 })).resolves.toBe(seeded);

      await activateAndCommit({
        ownerUserId: quotaOwner,
        operationId: rejected.id,
        expectedOperationRevision: rejected.revision,
        name: `${prefix}-accepted-after-retention`,
        kind: CAPABILITY_KIND.MCP,
        sourceKind: CAPABILITY_SOURCE_KIND.MCP_CONFIG,
        sourceSummary: 'quota accepted after retention fixture',
        artifactDigest: 'e'.repeat(64),
        auditDigest: 'f'.repeat(64),
        manifest: {},
        definition: {
          name: `${prefix}-accepted-after-retention`,
          transport: 'streamable_http',
          url: 'https://mcp.example.test/v1',
        },
        permissionSummary: [],
        scope: CAPABILITY_SCOPE.ACCOUNT,
      });
      const compacted = await getCapabilitySyncSnapshot(db, {
        ownerUserId: quotaOwner,
        maxItems: CAPABILITY_LIMITS.SYNC_ITEMS,
        afterRevision: 0,
      });
      expect(compacted.items).toHaveLength(2);
      expect(compacted.items.some((item) => item.id.startsWith(`${prefix}-item-`))).toBe(false);
      expect(() => toCapabilitySyncSnapshot(
        compacted,
        CAPABILITY_SYNC_MSG.SNAPSHOT,
        [authorizationSigner.key],
      )).not.toThrow();
    } finally {
      await db.execute('DELETE FROM users WHERE id = $1', [quotaOwner]);
    }
  });

  it('enforces complete-state version and binding caps before creating a candidate', async () => {
    const versionOwner = `cap-version-quota-${randomHex(8)}`;
    const bindingOwner = `cap-binding-quota-${randomHex(8)}`;
    await createUser(db, versionOwner, versionOwner);
    await createUser(db, bindingOwner, bindingOwner);
    try {
      const versionItem = `version-item-${randomHex(6)}`;
      await db.execute(`
        INSERT INTO capability_items (
          id, owner_user_id, kind, name, lifecycle_state, revision, created_at, updated_at
        ) VALUES ($1, $2, 'mcp', 'version-cap-fixture', 'runtime_pending', 1, 9000, 9000)
      `, [versionItem, versionOwner]);
      await db.execute(`
        INSERT INTO capability_versions (
          id, owner_user_id, item_id, version_number, artifact_digest, audit_digest,
          source_kind, source_summary, manifest, definition, permission_summary,
          publication_state, created_at
        )
        SELECT $1 || '-v-' || n, $2, $1, n,
               repeat(md5('artifact-' || n::text), 2), repeat(md5('audit-' || n::text), 2),
               'mcp_config', 'version quota fixture', '{}'::jsonb,
               jsonb_build_object(
                 'name', 'version-cap-fixture',
                 'transport', 'streamable_http',
                 'url', 'https://mcp.example.test/v1'
               ),
               '[]'::jsonb, 'active', 9000 + n
        FROM generate_series(1, $3::int) AS n
      `, [versionItem, versionOwner, CAPABILITY_LIMITS.SYNC_VERSIONS]);
      await db.execute(`
        UPDATE capability_items SET active_version_id = $2
        WHERE owner_user_id = $1 AND id = $3
      `, [versionOwner, `${versionItem}-v-1`, versionItem]);
      await db.execute(`
        INSERT INTO capability_bindings (
          id, owner_user_id, item_id, version_id, scope, provider_filter,
          machine_filter, enabled, revision, created_at, updated_at
        ) VALUES ($1, $2, $3, $4, 'account', '[]'::jsonb, '[]'::jsonb, TRUE, 1, 9000, 9000)
      `, [`${versionItem}-binding`, versionOwner, versionItem, `${versionItem}-v-1`]);
      const versionRejected = await prepareConfirmedOperation(
        `version-cap-rejected-${randomHex(6)}`,
        versionOwner,
        '6'.repeat(64),
        '7'.repeat(64),
        CAPABILITY_SCOPE.ACCOUNT,
        undefined,
        CAPABILITY_KIND.MCP,
        versionItem,
        `${versionItem}-binding`,
      );
      await expect(activateCapabilityVersion(db, {
        authorizationSigner,
        ownerUserId: versionOwner,
        targetServerId: sourceServerForOwner(versionOwner),
        operationId: versionRejected.id,
        expectedOperationRevision: versionRejected.revision,
        requestedItemId: versionItem,
        requestedBindingId: `${versionItem}-binding`,
        name: 'version-cap-fixture',
        kind: CAPABILITY_KIND.MCP,
        sourceKind: CAPABILITY_SOURCE_KIND.MCP_CONFIG,
        sourceSummary: 'version quota rejected fixture',
        artifactDigest: '6'.repeat(64),
        auditDigest: '7'.repeat(64),
        manifest: {},
        definition: {
          name: 'version-cap-fixture',
          transport: 'streamable_http',
          url: 'https://mcp.example.test/v1',
        },
        permissionSummary: [],
        scope: CAPABILITY_SCOPE.ACCOUNT,
      })).rejects.toThrow('capability_sync_version_quota_exceeded');

      const bindingItem = `binding-item-${randomHex(6)}`;
      const bindingVersion = `${bindingItem}-v-1`;
      await db.execute(`
        INSERT INTO capability_items (
          id, owner_user_id, kind, name, lifecycle_state, revision,
          active_version_id, created_at, updated_at
        ) VALUES ($1, $2, 'mcp', 'binding-cap-fixture', 'runtime_pending', 1,
          NULL, 10000, 10000)
      `, [bindingItem, bindingOwner]);
      await db.execute(`
        INSERT INTO capability_versions (
          id, owner_user_id, item_id, version_number, artifact_digest, audit_digest,
          source_kind, source_summary, manifest, definition, permission_summary,
          publication_state, created_at
        ) VALUES ($1, $2, $3, 1, $4, $5, 'mcp_config', 'binding quota fixture',
          '{}'::jsonb, $6::jsonb, '[]'::jsonb, 'active', 10000)
      `, [
        bindingVersion,
        bindingOwner,
        bindingItem,
        '8'.repeat(64),
        '9'.repeat(64),
        JSON.stringify({
          name: 'binding-cap-fixture',
          transport: 'streamable_http',
          url: 'https://mcp.example.test/v1',
        }),
      ]);
      await db.execute(`
        UPDATE capability_items SET active_version_id = $2
        WHERE owner_user_id = $1 AND id = $3
      `, [bindingOwner, bindingVersion, bindingItem]);
      await db.execute(`
        INSERT INTO capability_bindings (
          id, owner_user_id, item_id, version_id, scope, provider_filter,
          machine_filter, enabled, revision, created_at, updated_at
        )
        SELECT $1 || '-b-' || n, $2, $1, $3, 'account', '[]'::jsonb, '[]'::jsonb,
               TRUE, 1, 10000 + n, 10000 + n
        FROM generate_series(1, $4::int) AS n
      `, [bindingItem, bindingOwner, bindingVersion, CAPABILITY_LIMITS.SYNC_BINDINGS]);
      const bindingRejected = await prepareConfirmedOperation(
        `binding-cap-rejected-${randomHex(6)}`,
        bindingOwner,
        '1'.repeat(64),
        '2'.repeat(64),
        CAPABILITY_SCOPE.ACCOUNT,
        undefined,
        CAPABILITY_KIND.MCP,
      );
      await expect(activateCapabilityVersion(db, {
        authorizationSigner,
        ownerUserId: bindingOwner,
        targetServerId: sourceServerForOwner(bindingOwner),
        operationId: bindingRejected.id,
        expectedOperationRevision: bindingRejected.revision,
        name: 'binding-cap-rejected',
        kind: CAPABILITY_KIND.MCP,
        sourceKind: CAPABILITY_SOURCE_KIND.MCP_CONFIG,
        sourceSummary: 'binding quota rejected fixture',
        artifactDigest: '1'.repeat(64),
        auditDigest: '2'.repeat(64),
        manifest: {},
        definition: {
          name: 'binding-cap-rejected',
          transport: 'streamable_http',
          url: 'https://mcp.example.test/v1',
        },
        permissionSummary: [],
        scope: CAPABILITY_SCOPE.ACCOUNT,
      })).rejects.toThrow('capability_sync_binding_quota_exceeded');
    } finally {
      await db.execute('DELETE FROM users WHERE id = ANY($1::text[])', [[versionOwner, bindingOwner]]);
    }
  }, 60_000);

  it('synchronizes disabled bindings explicitly, restores them, and requires an exact choice when multiple bindings exist', async () => {
    const current = (await listCapabilities(db, { ownerUserId: ownerOne, limit: 50 })).items
      .find((item) => item.name === 'portable-skill');
    if (!current?.activeVersion || current.bindings.length !== 1) throw new Error('portable skill binding missing');
    const accountBinding = current.bindings[0]!;
    const disabled = await manageCapability(db, {
      ownerUserId: ownerOne,
      itemId: current.id,
      bindingId: accountBinding.id,
      expectedRevision: current.revision,
      action: CAPABILITY_MANAGE_ACTION.DISABLE,
      authorizationSigner,
      now: 4_410,
    });
    if (disabled.status !== 'ok') throw new Error(`disable failed: ${disabled.status}`);
    expect(disabled.item.lifecycleState).toBe(CAPABILITY_STATE.DISABLED);
    const disabledWire = toCapabilitySyncSnapshot(await getCapabilitySyncSnapshot(db, {
      ownerUserId: ownerOne, maxItems: 50, afterRevision: disabled.accountRevision - 1,
    }), CAPABILITY_SYNC_MSG.DELTA);
    expect(disabledWire.items).toContainEqual(expect.objectContaining({ id: current.id, state: CAPABILITY_STATE.DISABLED }));
    expect(disabledWire.bindings).toContainEqual(expect.objectContaining({ id: accountBinding.id, active: false }));
    const otherOwnerWire = toCapabilitySyncSnapshot(await getCapabilitySyncSnapshot(db, {
      ownerUserId: ownerTwo, maxItems: 50, afterRevision: 0,
    }));
    expect(otherOwnerWire.items.every((item) => item.id !== current.id)).toBe(true);

    const enabled = await manageCapability(db, {
      ownerUserId: ownerOne,
      itemId: current.id,
      bindingId: accountBinding.id,
      expectedRevision: disabled.item.revision,
      action: CAPABILITY_MANAGE_ACTION.ENABLE,
      authorizationSigner,
      now: 4_420,
    });
    if (enabled.status !== 'ok') throw new Error(`enable failed: ${enabled.status}`);
    const enabledWire = toCapabilitySyncSnapshot(await getCapabilitySyncSnapshot(db, {
      ownerUserId: ownerOne, maxItems: 50, afterRevision: enabled.accountRevision - 1,
    }), CAPABILITY_SYNC_MSG.DELTA);
    expect(enabledWire.bindings).toContainEqual(expect.objectContaining({ id: accountBinding.id, active: true }));

    const projectBindingId = `binding-project-${randomHex(8)}`;
    await db.execute(`
      INSERT INTO capability_bindings (
        id, owner_user_id, item_id, version_id, scope, project_key, session_key,
        server_id, provider_filter, machine_filter, enabled, revision, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, 'project', 'project-1', NULL, NULL, '[]', '[]', TRUE, 1, $5, $5)
    `, [projectBindingId, ownerOne, current.id, enabled.item.activeVersion!.id, 4_425]);
    const refreshed = await getCapability(db, { ownerUserId: ownerOne, itemId: current.id });
    if (!refreshed) throw new Error('refreshed capability missing');
    const ambiguous = await manageCapability(db, {
      ownerUserId: ownerOne,
      itemId: current.id,
      expectedRevision: refreshed.revision,
      action: CAPABILITY_MANAGE_ACTION.DISABLE,
      now: 4_430,
    });
    expect(ambiguous).toMatchObject({ status: 'ambiguous_binding' });
    const exact = await manageCapability(db, {
      ownerUserId: ownerOne,
      itemId: current.id,
      bindingId: projectBindingId,
      expectedRevision: refreshed.revision,
      action: CAPABILITY_MANAGE_ACTION.DISABLE,
      authorizationSigner,
      now: 4_440,
    });
    if (exact.status !== 'ok') throw new Error(`exact binding disable failed: ${exact.status}`);
    expect(exact.item.bindings.find((binding) => binding.id === projectBindingId)?.enabled).toBe(false);
    expect(exact.item.bindings.find((binding) => binding.id === accountBinding.id)?.enabled).toBe(true);
    await db.execute('DELETE FROM capability_bindings WHERE owner_user_id = $1 AND id = $2', [ownerOne, projectBindingId]);
  });

  it('keeps local bindings and tombstones out of account synchronization', async () => {
    const localArtifact = 'f'.repeat(64);
    const localAudit = '9'.repeat(64);
    const operation = await prepareConfirmedOperation(
      'local-only-skill', ownerOne, localArtifact, localAudit, CAPABILITY_SCOPE.LOCAL, serverOne,
    );
    await expect(activateCapabilityVersion(db, {
      authorizationSigner,
      ownerUserId: ownerOne,
      targetServerId: sourceServerForOwner(ownerOne),
      operationId: operation.id,
      expectedOperationRevision: operation.revision,
      name: 'local-only-skill',
      kind: CAPABILITY_KIND.SKILL,
      sourceKind: CAPABILITY_SOURCE_KIND.LOCAL_PATH,
      sourceSummary: 'local package must not upload',
      artifactDigest: localArtifact,
      blobDigest: BLOB_DIGEST,
      blobByteSize: SKILL_BLOB.byteLength,
      auditDigest: localAudit,
      manifest: {},
      permissionSummary: [],
      scope: CAPABILITY_SCOPE.LOCAL,
      serverId: serverOne,
    })).rejects.toThrow('capability_activation_blob_policy');
    const activated = await activateAndCommit({
      ownerUserId: ownerOne,
      operationId: operation.id,
      expectedOperationRevision: operation.revision,
      name: 'local-only-skill',
      kind: CAPABILITY_KIND.SKILL,
      sourceKind: CAPABILITY_SOURCE_KIND.LOCAL_PATH,
      sourceSummary: 'daemon local package',
      artifactDigest: localArtifact,
      auditDigest: localAudit,
      manifest: {},
      permissionSummary: [],
      scope: CAPABILITY_SCOPE.LOCAL,
      serverId: serverOne,
      now: 4_500,
    });
    const before = await getCapabilitySyncSnapshot(db, { ownerUserId: ownerOne, maxItems: 50, afterRevision: 0 });
    expect(before.items.every((item) => item.id !== activated.item.id)).toBe(true);
    const localRequestId = `local-manage-${randomHex(8)}`;
    const reserved = await reserveLocalCapabilityManage(db, {
      requestId: localRequestId,
      ownerUserId: ownerOne,
      itemId: activated.item.id,
      bindingId: activated.item.bindings[0]!.id,
      serverId: serverOne,
      action: CAPABILITY_MANAGE_ACTION.UNINSTALL,
      expectedRevision: activated.item.revision,
      timeoutMs: 10_000,
      authorizationSigner,
      now: 4_599,
    });
    expect(reserved.status).toBe('ok');
    if (reserved.status !== 'ok') throw new Error('local request reservation failed');
    await advanceLocalCapabilityManageResult(db, {
      requestId: localRequestId,
      ownerUserId: ownerOne,
      serverId: serverOne,
      itemId: activated.item.id,
      bindingId: activated.item.bindings[0]!.id,
      action: CAPABILITY_MANAGE_ACTION.UNINSTALL,
      expectedRevision: activated.item.revision,
      authorityRevision: reserved.request.authorityRevision,
      resultPhase: 'prepared',
      ok: true,
      now: 4_599,
    });
    await markLocalCapabilityManageCommitSent(db, {
      requestId: localRequestId,
      ownerUserId: ownerOne,
      serverId: serverOne,
      now: 4_599,
    });
    await advanceLocalCapabilityManageResult(db, {
      requestId: localRequestId,
      ownerUserId: ownerOne,
      serverId: serverOne,
      itemId: activated.item.id,
      bindingId: activated.item.bindings[0]!.id,
      action: CAPABILITY_MANAGE_ACTION.UNINSTALL,
      expectedRevision: activated.item.revision,
      authorityRevision: reserved.request.authorityRevision,
      resultPhase: 'applied',
      ok: true,
      now: 4_599,
    });
    const removed = await manageCapability(db, {
      ownerUserId: ownerOne,
      itemId: activated.item.id,
      expectedRevision: activated.item.revision,
      action: CAPABILITY_MANAGE_ACTION.UNINSTALL,
      bindingId: activated.item.bindings[0]?.id,
      scope: CAPABILITY_SCOPE.LOCAL,
      serverId: serverOne,
      localRequestId,
      authorizationSigner,
      now: 4_600,
    });
    expect(removed.status).toBe('ok');
    if (removed.status !== 'ok') throw new Error('local manage commit failed');
    const replayedApplied = await manageCapability(db, {
      ownerUserId: ownerOne,
      itemId: activated.item.id,
      expectedRevision: activated.item.revision,
      action: CAPABILITY_MANAGE_ACTION.UNINSTALL,
      bindingId: activated.item.bindings[0]?.id,
      scope: CAPABILITY_SCOPE.LOCAL,
      serverId: serverOne,
      localRequestId,
      authorizationSigner,
      now: 4_601,
    });
    expect(replayedApplied).toMatchObject({
      status: 'ok',
      item: { revision: removed.item.revision },
      accountRevision: removed.accountRevision,
    });
    const after = await getCapabilitySyncSnapshot(db, { ownerUserId: ownerOne, maxItems: 50, afterRevision: 0 });
    expect(after.items.every((item) => item.id !== activated.item.id)).toBe(true);
    expect(after.tombstones.every((entry) => entry.itemId !== activated.item.id)).toBe(true);
  });

  it('rejects unresolved MCP credential references and round-trips a credential-free definition', async () => {
    const artifactDigest = '1'.repeat(64);
    const auditDigest = '2'.repeat(64);
    const operation = await prepareConfirmedOperation(
      'mcp-definition-roundtrip', ownerOne, artifactDigest, auditDigest,
      CAPABILITY_SCOPE.ACCOUNT, undefined, CAPABILITY_KIND.MCP,
    );
    const credentialDefinition = {
      name: 'portable-mcp',
      transport: 'streamable_http',
      url: 'https://mcp.example.test/v1',
      credentialRef: 'credential-main',
      headers: { Authorization: { credentialRef: 'credential-header' } },
      toolAllowlist: ['search', 'read'],
    };
    await expect(activateCapabilityVersion(db, {
      authorizationSigner,
      ownerUserId: ownerOne,
      targetServerId: sourceServerForOwner(ownerOne),
      operationId: operation.id,
      expectedOperationRevision: operation.revision,
      name: 'portable-mcp',
      kind: CAPABILITY_KIND.MCP,
      sourceKind: CAPABILITY_SOURCE_KIND.MCP_CONFIG,
      sourceSummary: 'mcp must not upload a Skill archive',
      artifactDigest,
      blobDigest: BLOB_DIGEST,
      blobByteSize: SKILL_BLOB.byteLength,
      auditDigest,
      manifest: { tools: ['search', 'read'] },
      definition: credentialDefinition,
      permissionSummary: ['network'],
      scope: CAPABILITY_SCOPE.ACCOUNT,
    })).rejects.toThrow('capability_activation_blob_policy');
    await expect(activateCapabilityVersion(db, {
      authorizationSigner,
      ownerUserId: ownerOne,
      targetServerId: sourceServerForOwner(ownerOne),
      operationId: operation.id,
      expectedOperationRevision: operation.revision,
      name: 'portable-mcp',
      kind: CAPABILITY_KIND.MCP,
      sourceKind: CAPABILITY_SOURCE_KIND.MCP_CONFIG,
      sourceSummary: 'unresolved credential reference must fail closed',
      artifactDigest,
      auditDigest,
      manifest: { tools: ['search', 'read'] },
      definition: credentialDefinition,
      permissionSummary: ['network'],
      scope: CAPABILITY_SCOPE.ACCOUNT,
    })).rejects.toThrow('capability_activation_definition_policy');
    await expect(getCapabilityOperation(db, {
      ownerUserId: ownerOne,
      operationId: operation.id,
    })).resolves.toMatchObject({
      state: CAPABILITY_INSTALL_STATE.INSTALLING,
      itemId: null,
      revision: operation.revision,
    });
    const definition = {
      name: 'portable-mcp',
      transport: 'streamable_http',
      url: 'https://mcp.example.test/v1',
      toolAllowlist: ['search', 'read'],
    };
    const activated = await activateAndCommit({
      ownerUserId: ownerOne,
      operationId: operation.id,
      expectedOperationRevision: operation.revision,
      name: 'portable-mcp',
      kind: CAPABILITY_KIND.MCP,
      sourceKind: CAPABILITY_SOURCE_KIND.MCP_CONFIG,
      sourceSummary: 'audited mcp config',
      artifactDigest,
      auditDigest,
      manifest: { tools: ['search', 'read'] },
      definition,
      permissionSummary: ['network'],
      scope: CAPABILITY_SCOPE.ACCOUNT,
      now: 4_700,
    });
    expect(activated.item.lifecycleState).toBe(CAPABILITY_STATE.RUNTIME_PENDING);
    expect(activated.item.activeVersion?.definition).toEqual(definition);
    expect(activated.item.activeVersion?.permissionSummary).toEqual(['network']);
    const sync = toCapabilitySyncSnapshot(await getCapabilitySyncSnapshot(db, {
      ownerUserId: ownerOne,
      maxItems: 50,
      afterRevision: 0,
    }));
    expect(sync.ownerId).toBe(ownerOne);
    expect(sync.versions.find((version) => version.id === activated.item.activeVersion?.id)?.definition)
      .toEqual(definition);
    expect(toCapabilitySummary(activated.item).credentialsRetained).toBe(false);

    const beforeDelete = activated.item.revision;
    const unavailableDelete = await manageCapability(db, {
      ownerUserId: ownerOne,
      itemId: activated.item.id,
      expectedRevision: beforeDelete,
      action: CAPABILITY_MANAGE_ACTION.DELETE_CREDENTIALS,
      scope: CAPABILITY_SCOPE.ACCOUNT,
      now: 5_500,
    });
    expect(unavailableDelete.status).toBe('runtime_pending');
    await expect(getCapability(db, { ownerUserId: ownerOne, itemId: activated.item.id }))
      .resolves.toMatchObject({ revision: beforeDelete });
    const audit = await db.queryOne<{ outcome: string }>(`
      SELECT outcome FROM capability_audit_events
      WHERE owner_user_id = $1 AND item_id = $2 AND action = $3
      ORDER BY created_at DESC LIMIT 1
    `, [ownerOne, activated.item.id, CAPABILITY_MANAGE_ACTION.DELETE_CREDENTIALS]);
    expect(audit?.outcome).toBe('runtime_pending');
  });

  it('uses optimistic revisions and publishes synchronized recoverable tombstones', async () => {
    const items = await listCapabilities(db, { ownerUserId: ownerOne, limit: 50 });
    const item = items.items.find((entry) => entry.name === 'portable-skill');
    if (!item) throw new Error('activated test capability missing');
    const stale = await manageCapability(db, {
      ownerUserId: ownerOne,
      itemId: item.id,
      expectedRevision: item.revision - 1,
      action: CAPABILITY_MANAGE_ACTION.UNINSTALL,
      bindingId: item.bindings[0]?.id,
      scope: CAPABILITY_SCOPE.ACCOUNT,
      now: 6_000,
    });
    expect(stale.status).toBe('stale');

    const removed = await manageCapability(db, {
      ownerUserId: ownerOne,
      itemId: item.id,
      expectedRevision: item.revision,
      action: CAPABILITY_MANAGE_ACTION.UNINSTALL,
      bindingId: item.bindings[0]?.id,
      scope: CAPABILITY_SCOPE.ACCOUNT,
      authorizationSigner,
      now: 7_000,
      retentionMs: 10_000,
    });
    expect(removed.status).toBe('ok');
    if (removed.status !== 'ok') throw new Error('unexpected uninstall result');
    expect(removed.item.lifecycleState).toBe(CAPABILITY_STATE.TOMBSTONED);
    expect(removed.item.bindings.every((binding) => !binding.enabled)).toBe(true);

    const snapshot = await getCapabilitySyncSnapshot(db, {
      ownerUserId: ownerOne,
      maxItems: 50,
      afterRevision: 0,
    });
    expect(snapshot.tombstones).toEqual(expect.arrayContaining([
      expect.objectContaining({ itemId: item.id, scope: CAPABILITY_SCOPE.ACCOUNT }),
    ]));
    expect(snapshot.digest).toMatch(/^[0-9a-f]{64}$/);
    const ownerTwoSnapshot = await getCapabilitySyncSnapshot(db, {
      ownerUserId: ownerTwo,
      maxItems: 50,
      afterRevision: 0,
    });
    expect(ownerTwoSnapshot.items.every((entry) => entry.id !== item.id)).toBe(true);
    expect(ownerTwoSnapshot.tombstones).toEqual([]);
  });

  it('bounds retained terminal operations and audit history per owner', async () => {
    const prefix = `retention-${randomHex(8)}`;
    const terminalCount = CAPABILITY_LIMITS.RETAINED_TERMINAL_OPERATIONS + 5;
    const auditCount = CAPABILITY_LIMITS.RETAINED_AUDIT_EVENTS + 5;
    await db.execute(`
      INSERT INTO capability_operations (
        id, owner_user_id, operation_kind, idempotency_key, state,
        request_summary, error_code, revision, created_at, updated_at, completed_at
      )
      SELECT $1 || '-op-' || n, $2, 'install', $1 || '-key-' || n, 'failed',
             '{}'::jsonb, 'runtime_pending', 1, n, n, n
      FROM generate_series(1, $3::int) AS n
    `, [prefix, ownerTwo, terminalCount]);
    await db.execute(`
      INSERT INTO capability_audit_events (
        id, owner_user_id, action, outcome, actor_kind, metadata, created_at
      )
      SELECT $1 || '-audit-' || n, $2, 'retention_test', 'failed', 'system', '{}'::jsonb, n
      FROM generate_series(1, $3::int) AS n
    `, [prefix, ownerTwo, auditCount]);

    await createInstallOperation(db, {
      ownerUserId: ownerTwo,
      idempotencyKey: `${prefix}-trigger`,
      requestSummary: {
        kind: CAPABILITY_KIND.SKILL,
        sourceKind: CAPABILITY_SOURCE_KIND.INLINE,
        scope: CAPABILITY_SCOPE.ACCOUNT,
      },
      now: auditCount + 100,
    });

    const retained = await db.queryOne<{ operations: string; audits: string }>(`
      SELECT
        (SELECT COUNT(*) FROM capability_operations
         WHERE owner_user_id = $1 AND state = ANY($2::text[]))::text AS operations,
        (SELECT COUNT(*) FROM capability_audit_events
         WHERE owner_user_id = $1)::text AS audits
    `, [
      ownerTwo,
      [
        CAPABILITY_INSTALL_STATE.INSTALLED,
        CAPABILITY_INSTALL_STATE.REWORK,
        CAPABILITY_INSTALL_STATE.FAILED,
        CAPABILITY_INSTALL_STATE.CANCELLED,
      ],
    ]);
    expect(Number(retained?.operations)).toBeLessThanOrEqual(CAPABILITY_LIMITS.RETAINED_TERMINAL_OPERATIONS);
    expect(Number(retained?.audits)).toBeLessThanOrEqual(CAPABILITY_LIMITS.RETAINED_AUDIT_EVENTS);
  });
});
