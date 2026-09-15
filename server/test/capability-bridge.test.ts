import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CAPABILITY_AUDIT_VERDICT,
  CAPABILITY_ERROR,
  CAPABILITY_INSTALL_STATE,
  CAPABILITY_KIND,
  CAPABILITY_MANAGE_ACTION,
  CAPABILITY_MANAGE_PHASE,
  CAPABILITY_MANAGE_RESULT_PHASE,
  CAPABILITY_OPERATION_MSG,
  CAPABILITY_READINESS,
  CAPABILITY_SCOPE,
  CAPABILITY_SOURCE_KIND,
  CAPABILITY_STATE,
  CAPABILITY_SYNC_MSG,
} from '../../shared/capability-management.js';

const mocks = vi.hoisted(() => ({
  activate: vi.fn(),
  blobAccess: vi.fn(),
  completeCommit: vi.fn(),
  failPending: vi.fn(),
  pendingAuthorization: vi.fn(),
  pendingAuthorizations: vi.fn(),
  pendingBlobUploads: vi.fn(),
  disconnect: vi.fn(),
  expirePreActivation: vi.fn(),
  expirePending: vi.fn(),
  getOperation: vi.fn(),
  authority: vi.fn(),
  localRequests: vi.fn(),
  advanceLocal: vi.fn(),
  markLocalCommit: vi.fn(),
  manage: vi.fn(),
  readiness: vi.fn(),
  snapshot: vi.fn(),
  update: vi.fn(),
  updateState: vi.fn(),
}));

vi.mock('../src/services/capability-package-storage.js', () => ({
  issueCapabilityBlobAccess: (...args: unknown[]) => mocks.blobAccess(...args),
}));

vi.mock('../src/db/capabilities.js', () => ({
  activateCapabilityVersion: (...args: unknown[]) => mocks.activate(...args),
  completeCapabilityCommit: (...args: unknown[]) => mocks.completeCommit(...args),
  failCapabilityPendingActivation: (...args: unknown[]) => mocks.failPending(...args),
  getPendingCapabilityAuthorization: (...args: unknown[]) => mocks.pendingAuthorization(...args),
  listPendingCapabilityAuthorizations: (...args: unknown[]) => mocks.pendingAuthorizations(...args),
  listPendingCapabilityBlobUploads: (...args: unknown[]) => mocks.pendingBlobUploads(...args),
  advanceCapabilityOperation: (...args: unknown[]) => mocks.update(...args),
  updateCapabilityOperation: (...args: unknown[]) => mocks.updateState(...args),
  acknowledgeCapabilityReadiness: (...args: unknown[]) => mocks.readiness(...args),
  getCapabilitySyncSnapshot: (...args: unknown[]) => mocks.snapshot(...args),
  failCapabilityOperationsForDisconnectedServer: (...args: unknown[]) => mocks.disconnect(...args),
  expireCapabilityPreActivationOperations: (...args: unknown[]) => mocks.expirePreActivation(...args),
  expireCapabilityPendingActivations: (...args: unknown[]) => mocks.expirePending(...args),
  getCapabilityOperation: (...args: unknown[]) => mocks.getOperation(...args),
  getCapabilityAuthorityRecordSet: (...args: unknown[]) => mocks.authority(...args),
  listReplayableLocalCapabilityManageRequests: (...args: unknown[]) => mocks.localRequests(...args),
  advanceLocalCapabilityManageResult: (...args: unknown[]) => mocks.advanceLocal(...args),
  markLocalCapabilityManageCommitSent: (...args: unknown[]) => mocks.markLocalCommit(...args),
  manageCapability: (...args: unknown[]) => mocks.manage(...args),
}));

vi.mock('../src/services/capability-wire.js', () => ({
  toCapabilitySummary: (item: { id: string; name: string }) => ({ id: item.id, name: item.name }),
  toCapabilityOperationAuthorizeFrame: (pending: { operationId: string }) => ({
    type: CAPABILITY_OPERATION_MSG.AUTHORIZE,
    operationId: pending.operationId,
  }),
  toCapabilitySyncSnapshot: (
    record: { ownerId: string; revision: number; digest: string },
    type: typeof CAPABILITY_SYNC_MSG.SNAPSHOT | typeof CAPABILITY_SYNC_MSG.DELTA = CAPABILITY_SYNC_MSG.SNAPSHOT,
  ) => ({
    type,
    ownerId: record.ownerId,
    revision: record.revision,
    items: [],
    versions: [],
    bindings: [],
    tombstones: [],
    digest: record.digest,
  }),
  toCapabilitySyncAuthorityFrame: (
    record: { ownerId: string; serverId: string; revision: number },
  ) => ({
    type: CAPABILITY_SYNC_MSG.AUTHORITY,
    ownerId: record.ownerId,
    serverId: record.serverId,
    revision: record.revision,
    records: [],
    authorizationKeys: [],
    digest: 'a'.repeat(64),
  }),
}));

import { WsBridge } from '../src/ws/bridge.js';
import type { Database } from '../src/db/client.js';
import { sha256Hex } from '../src/security/crypto.js';

class MockWs extends EventEmitter {
  readyState = 1;
  sent: string[] = [];

  send(value: string | Buffer): void {
    this.sent.push(typeof value === 'string' ? value : value.toString('utf8'));
  }

  close(): void {
    this.readyState = 3;
    this.emit('close');
  }
}

function makeDb(ownerUserId = 'owner-1', nodeRole = 'full'): Database {
  const db = {
    queryOne: async (sql: string) => {
      if (sql.includes('token_hash')) {
        return {
          token_hash: sha256Hex('raw-token'),
          user_id: ownerUserId,
          node_role: nodeRole,
          revoked_at: null,
          os: 'linux',
        };
      }
      return null;
    },
    query: async () => [],
    execute: async () => ({ changes: 1 }),
    exec: async () => {},
    transaction: async <T>(fn: (tx: Database) => Promise<T>) => fn(db as unknown as Database),
    close: async () => {},
  };
  return db as unknown as Database;
}

async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

describe('capability daemon bridge', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.snapshot.mockResolvedValue({ ownerId: 'owner-1', revision: 7, items: [], tombstones: [], digest: 'd'.repeat(64) });
    mocks.readiness.mockResolvedValue({ serverId: 'server-1' });
    mocks.blobAccess.mockResolvedValue({
      action: 'upload',
      capabilityId: 'server-capability-1',
      versionId: 'server-version-1',
      blobDigest: 'c'.repeat(64),
      maxBytes: 128,
      expiresAt: 1000,
      singleUseToken: 'blob-token',
    });
    mocks.disconnect.mockResolvedValue([]);
    mocks.expirePreActivation.mockResolvedValue([]);
    mocks.expirePending.mockResolvedValue([]);
    mocks.getOperation.mockResolvedValue(null);
    mocks.updateState.mockResolvedValue(null);
    mocks.authority.mockImplementation(async (_db: unknown, params: { ownerUserId: string; serverId: string }) => ({
      ownerId: params.ownerUserId,
      serverId: params.serverId,
      revision: 7,
      records: [],
    }));
    mocks.localRequests.mockResolvedValue([]);
    mocks.advanceLocal.mockResolvedValue(null);
    mocks.markLocalCommit.mockResolvedValue(null);
    mocks.manage.mockResolvedValue({ status: 'runtime_pending' });
    mocks.pendingAuthorization.mockResolvedValue(null);
    mocks.pendingAuthorizations.mockResolvedValue([]);
    mocks.pendingBlobUploads.mockResolvedValue([]);
    mocks.failPending.mockResolvedValue(null);
  });

  afterEach(() => {
    WsBridge.getAll().clear();
  });

  async function authenticatedBridge(serverId = 'server-1', ownerUserId = 'owner-1', nodeRole = 'full') {
    const bridge = WsBridge.get(serverId);
    const daemon = new MockWs();
    bridge.handleDaemonConnection(
      daemon as never,
      makeDb(ownerUserId, nodeRole),
      { JWT_SIGNING_KEY: 'test-signing-key' } as never,
    );
    daemon.emit('message', JSON.stringify({ type: 'auth', serverId, token: 'raw-token' }));
    await flush();
    return { bridge, daemon };
  }

  it('binds live install dispatch to the authenticated daemon owner', async () => {
    const { bridge, daemon } = await authenticatedBridge();
    expect(bridge.canAcceptCapabilityOperation('owner-1')).toBe(true);
    expect(bridge.canAcceptCapabilityOperation('owner-2')).toBe(false);
    expect(bridge.dispatchCapabilityInstall('owner-2', {
      type: CAPABILITY_OPERATION_MSG.INSTALL,
      operationId: 'operation-1',
      ownerId: 'owner-2',
      revision: 1,
      request: {
        kind: CAPABILITY_KIND.SKILL,
        source: { kind: CAPABILITY_SOURCE_KIND.INLINE, inlineFiles: { 'SKILL.md': 'safe' } },
        scope: CAPABILITY_SCOPE.ACCOUNT,
        idempotencyKey: 'one',
      },
    })).toBe(false);
    expect(daemon.sent.some((value) => value.includes('operation-1'))).toBe(false);
  });

  it('terminates server-bound in-flight capability work when the daemon disconnects', async () => {
    const { daemon } = await authenticatedBridge();
    mocks.disconnect.mockResolvedValue([{
      id: 'operation-disconnected',
      revision: 4,
      state: 'failed',
      errorCode: 'runtime_pending',
    }]);
    daemon.close();
    await flush();
    await flush();
    expect(mocks.disconnect).toHaveBeenCalledWith(expect.anything(), {
      ownerUserId: 'owner-1',
      serverId: 'server-1',
    });
  });

  it('expires a confirmed pre-ACTIVATE journal on reconnect and sends bounded cleanup', async () => {
    const { daemon } = await authenticatedBridge();
    mocks.expirePreActivation.mockResolvedValue([{
      id: 'operation-pre-activate-expired',
      revision: 8,
      state: CAPABILITY_INSTALL_STATE.FAILED,
      errorCode: CAPABILITY_ERROR.RUNTIME_PENDING,
    }]);
    daemon.sent = [];
    daemon.emit('message', JSON.stringify({ type: CAPABILITY_SYNC_MSG.REQUEST }));
    await flush();
    expect(mocks.expirePreActivation).toHaveBeenCalledWith(expect.anything(), {
      ownerUserId: 'owner-1',
      serverId: 'server-1',
    });
    expect(daemon.sent.map((value) => JSON.parse(value))).toContainEqual({
      type: CAPABILITY_OPERATION_MSG.CANCEL,
      operationId: 'operation-pre-activate-expired',
      expectedRevision: 8,
    });
  });

  it('serves the same owner-scoped revisioned delta to two authenticated daemons', async () => {
    const first = await authenticatedBridge('server-1');
    const second = await authenticatedBridge('server-2');
    first.daemon.sent = [];
    second.daemon.sent = [];
    first.daemon.emit('message', JSON.stringify({ type: CAPABILITY_SYNC_MSG.REQUEST, afterRevision: 6 }));
    second.daemon.emit('message', JSON.stringify({ type: CAPABILITY_SYNC_MSG.REQUEST, afterRevision: 6 }));
    await flush();
    expect(mocks.snapshot).toHaveBeenCalledWith(expect.anything(), {
      ownerUserId: 'owner-1', maxItems: expect.any(Number), afterRevision: 6,
    });
    for (const daemon of [first.daemon, second.daemon]) {
      expect(daemon.sent.map((value) => JSON.parse(value))).toContainEqual(expect.objectContaining({
        type: CAPABILITY_SYNC_MSG.DELTA,
        revision: 7,
        digest: 'd'.repeat(64),
      }));
      expect(daemon.sent.map((value) => JSON.parse(value))).toContainEqual(expect.objectContaining({
        type: CAPABILITY_SYNC_MSG.AUTHORITY,
        ownerId: 'owner-1',
        serverId: expect.any(String),
        revision: 7,
      }));
    }
  });

  it('fans a new owner revision to every same-owner FULL bridge and excludes other owners and controlled nodes', async () => {
    const first = await authenticatedBridge('server-1');
    const second = await authenticatedBridge('server-2');
    const otherOwner = await authenticatedBridge('server-3', 'owner-2');
    const controlled = await authenticatedBridge('server-4', 'owner-1', 'controlled');
    for (const daemon of [first.daemon, second.daemon, otherOwner.daemon]) {
      daemon.emit('message', JSON.stringify({ type: CAPABILITY_SYNC_MSG.REQUEST }));
    }
    await flush();
    for (const daemon of [first.daemon, second.daemon, otherOwner.daemon, controlled.daemon]) daemon.sent = [];
    mocks.snapshot.mockResolvedValue({
      ownerId: 'owner-1', revision: 8, items: [], tombstones: [], digest: 'e'.repeat(64),
    });
    await expect(WsBridge.broadcastCapabilitySync('owner-1', makeDb(), 7)).resolves.toBe(2);
    for (const daemon of [first.daemon, second.daemon]) {
      expect(daemon.sent.map((value) => JSON.parse(value))).toContainEqual(expect.objectContaining({
        type: CAPABILITY_SYNC_MSG.DELTA,
        ownerId: 'owner-1',
        revision: 8,
      }));
    }
    expect(otherOwner.daemon.sent).toEqual([]);
    expect(controlled.daemon.sent).toEqual([]);
  });

  it('catches cross-pod capability revisions on the next FULL daemon heartbeat', async () => {
    const { daemon } = await authenticatedBridge('server-heartbeat');
    daemon.emit('message', JSON.stringify({ type: CAPABILITY_SYNC_MSG.REQUEST }));
    await flush();
    daemon.sent = [];
    mocks.snapshot.mockResolvedValue({
      ownerId: 'owner-1', revision: 9, items: [], tombstones: [], digest: 'f'.repeat(64),
    });
    daemon.emit('message', JSON.stringify({ type: 'heartbeat' }));
    await flush();
    await flush();
    expect(daemon.sent.map((value) => JSON.parse(value))).toContainEqual(expect.objectContaining({
      type: CAPABILITY_SYNC_MSG.DELTA,
      ownerId: 'owner-1',
      revision: 9,
    }));
  });

  it('accepts only current-revision progress and persists digest-bound audit evidence', async () => {
    const { daemon } = await authenticatedBridge();
    mocks.update.mockResolvedValue({ revision: 3 });
    daemon.emit('message', JSON.stringify({
      type: CAPABILITY_OPERATION_MSG.PROGRESS,
      operationId: 'operation-1',
      expectedRevision: 2,
      state: 'awaiting_confirmation',
      artifactDigest: 'a'.repeat(64),
      auditDigest: 'b'.repeat(64),
      auditVerdict: CAPABILITY_AUDIT_VERDICT.PASS,
      findings: [],
      tools: ['filesystem.read'],
      permissions: ['workspace.read'],
      updateDiff: ['instructions_changed'],
      hasScripts: true,
    }));
    await flush();
    expect(mocks.update).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      ownerUserId: 'owner-1',
      operationId: 'operation-1',
      expectedRevision: 2,
      state: 'awaiting_confirmation',
      allowedCurrentStates: ['queued', 'auditing'],
      requestSummaryPatch: expect.objectContaining({
        tools: ['filesystem.read'],
        permissions: ['workspace.read'],
        updateDiff: ['instructions_changed'],
        hasScripts: true,
      }),
    }));
    expect(mocks.update).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      evidence: expect.objectContaining({
        artifactDigest: 'a'.repeat(64),
        evidenceDigest: 'b'.repeat(64),
        verdict: CAPABILITY_AUDIT_VERDICT.PASS,
      }),
    }));

    mocks.update.mockResolvedValue(null);
    daemon.emit('message', JSON.stringify({
      type: CAPABILITY_OPERATION_MSG.PROGRESS,
      operationId: 'operation-1',
      expectedRevision: 2,
      state: 'auditing',
    }));
    await flush();
    expect(mocks.update).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({
      evidence: undefined,
    }));
  });

  it('accepts an exact reviewed-candidate progress replay after reconnect', async () => {
    const { daemon } = await authenticatedBridge();
    mocks.update.mockResolvedValue(null);
    mocks.getOperation.mockResolvedValue({
      id: 'operation-reviewed-replay',
      state: CAPABILITY_INSTALL_STATE.AWAITING_CONFIRMATION,
      revision: 3,
      artifactDigest: 'a'.repeat(64),
      auditDigest: 'b'.repeat(64),
    });
    daemon.emit('message', JSON.stringify({
      type: CAPABILITY_OPERATION_MSG.PROGRESS,
      operationId: 'operation-reviewed-replay',
      expectedRevision: 2,
      state: CAPABILITY_INSTALL_STATE.AWAITING_CONFIRMATION,
      artifactDigest: 'a'.repeat(64),
      auditDigest: 'b'.repeat(64),
      auditVerdict: CAPABILITY_AUDIT_VERDICT.PASS,
      findings: [],
    }));
    await flush();
    expect(mocks.getOperation).toHaveBeenCalledWith(expect.anything(), {
      ownerUserId: 'owner-1',
      operationId: 'operation-reviewed-replay',
    });

    mocks.getOperation.mockResolvedValue({
      id: 'operation-reviewed-replay',
      state: CAPABILITY_INSTALL_STATE.AWAITING_CONFIRMATION,
      revision: 3,
      artifactDigest: 'c'.repeat(64),
      auditDigest: 'b'.repeat(64),
    });
    daemon.emit('message', JSON.stringify({
      type: CAPABILITY_OPERATION_MSG.PROGRESS,
      operationId: 'operation-reviewed-replay',
      expectedRevision: 2,
      state: CAPABILITY_INSTALL_STATE.AWAITING_CONFIRMATION,
      artifactDigest: 'a'.repeat(64),
      auditDigest: 'b'.repeat(64),
      auditVerdict: CAPABILITY_AUDIT_VERDICT.PASS,
      findings: [],
    }));
    await flush();
    expect(mocks.update).toHaveBeenCalledTimes(2);
  });

  it('correlates local manage ACKs to exact owner, binding, action, and revision', async () => {
    const { bridge, daemon } = await authenticatedBridge();
    const journal = {
      requestId: 'manage-1',
      ownerUserId: 'owner-1',
      serverId: 'server-1',
      itemId: 'capability-1',
      bindingId: 'binding-local',
      action: CAPABILITY_MANAGE_ACTION.DISABLE,
      expectedRevision: 7,
      authorityRevision: 8,
      targetVersionId: null,
      authorization: null,
      phase: 'prepared',
      errorCode: null,
      resultItemRevision: null,
      resultAccountRevision: null,
      expiresAt: Date.now() + 10_000,
    };
    mocks.advanceLocal.mockImplementation(async (_db: unknown, params: { bindingId: string; resultPhase: string }) => (
      params.bindingId === 'binding-local'
        ? { ...journal, phase: params.resultPhase }
        : null
    ));
    mocks.markLocalCommit.mockResolvedValue({ ...journal, phase: 'commit_sent' });
    mocks.manage.mockResolvedValue({
      status: 'ok', item: { id: 'capability-1' }, accountRevision: 9, synchronized: false,
    });
    const pending = bridge.dispatchCapabilityManage('owner-1', {
      type: CAPABILITY_OPERATION_MSG.MANAGE,
      requestId: 'manage-1',
      phase: CAPABILITY_MANAGE_PHASE.PREPARE,
      ownerId: 'owner-1',
      serverId: 'server-1',
      capabilityId: 'capability-1',
      bindingId: 'binding-local',
      action: CAPABILITY_MANAGE_ACTION.DISABLE,
      expectedRevision: 7,
      authorityRevision: 8,
    }, 1_000);
    let resolved = false;
    void pending.then(() => { resolved = true; });
    daemon.emit('message', JSON.stringify({
      type: CAPABILITY_OPERATION_MSG.MANAGE_RESULT,
      requestId: 'manage-1',
      capabilityId: 'capability-1',
      bindingId: 'wrong-binding',
      action: CAPABILITY_MANAGE_ACTION.DISABLE,
      expectedRevision: 7,
      authorityRevision: 8,
      phase: CAPABILITY_MANAGE_RESULT_PHASE.PREPARED,
      ok: true,
    }));
    await flush();
    expect(resolved).toBe(false);
    daemon.emit('message', JSON.stringify({
      type: CAPABILITY_OPERATION_MSG.MANAGE_RESULT,
      requestId: 'manage-1',
      capabilityId: 'capability-1',
      bindingId: 'binding-local',
      action: CAPABILITY_MANAGE_ACTION.DISABLE,
      expectedRevision: 7,
      authorityRevision: 8,
      phase: CAPABILITY_MANAGE_RESULT_PHASE.PREPARED,
      ok: true,
    }));
    await flush();
    expect(resolved).toBe(false);
    expect(daemon.sent.map((value) => JSON.parse(value))).toContainEqual(expect.objectContaining({
      type: CAPABILITY_OPERATION_MSG.MANAGE,
      requestId: 'manage-1',
      phase: CAPABILITY_MANAGE_PHASE.COMMIT,
      authorityRevision: 8,
    }));
    daemon.emit('message', JSON.stringify({
      type: CAPABILITY_OPERATION_MSG.MANAGE_RESULT,
      requestId: 'manage-1',
      capabilityId: 'capability-1',
      bindingId: 'binding-local',
      action: CAPABILITY_MANAGE_ACTION.DISABLE,
      expectedRevision: 7,
      authorityRevision: 8,
      phase: CAPABILITY_MANAGE_RESULT_PHASE.APPLIED,
      ok: true,
    }));
    await expect(pending).resolves.toMatchObject({ ok: true, bindingId: 'binding-local' });
    expect(daemon.sent.map((value) => JSON.parse(value))).toContainEqual(expect.objectContaining({
      type: CAPABILITY_OPERATION_MSG.MANAGE_ACK,
      requestId: 'manage-1',
      authorityRevision: 8,
    }));
  });

  it('replays every durable local manage phase after reconnect', async () => {
    const base = {
      ownerUserId: 'owner-1',
      serverId: 'server-1',
      itemId: 'capability-local',
      bindingId: 'binding-local',
      action: CAPABILITY_MANAGE_ACTION.DISABLE,
      expectedRevision: 7,
      authorityRevision: 8,
      targetVersionId: null,
      authorization: null,
      errorCode: null,
      resultItemRevision: null,
      resultAccountRevision: null,
      expiresAt: Date.now() + 10_000,
    };
    mocks.localRequests.mockResolvedValue([
      { ...base, requestId: 'manage-prepare', phase: 'prepare_sent' },
      { ...base, requestId: 'manage-commit', phase: 'commit_sent' },
      { ...base, requestId: 'manage-applied', phase: 'applied' },
      { ...base, requestId: 'manage-acked', phase: 'committed' },
      { ...base, requestId: 'manage-aborted', phase: 'aborted' },
    ]);
    const { daemon } = await authenticatedBridge();
    const frames = daemon.sent.map((value) => JSON.parse(value));
    expect(frames).toContainEqual(expect.objectContaining({
      type: CAPABILITY_OPERATION_MSG.MANAGE,
      requestId: 'manage-prepare',
      phase: CAPABILITY_MANAGE_PHASE.PREPARE,
    }));
    for (const requestId of ['manage-commit', 'manage-applied']) {
      expect(frames).toContainEqual(expect.objectContaining({
        type: CAPABILITY_OPERATION_MSG.MANAGE,
        requestId,
        phase: CAPABILITY_MANAGE_PHASE.COMMIT,
      }));
    }
    expect(frames).toContainEqual(expect.objectContaining({
      type: CAPABILITY_OPERATION_MSG.MANAGE_ACK,
      requestId: 'manage-acked',
    }));
    expect(frames).toContainEqual(expect.objectContaining({
      type: CAPABILITY_OPERATION_MSG.MANAGE_ACK,
      requestId: 'manage-aborted',
    }));
  });

  it('acknowledges a compensated local manage abort so daemon WAL can terminate', async () => {
    const { daemon } = await authenticatedBridge();
    const journal = {
      requestId: 'manage-abort-complete', ownerUserId: 'owner-1', serverId: 'server-1',
      itemId: 'capability-1', bindingId: 'binding-local', action: CAPABILITY_MANAGE_ACTION.DISABLE,
      expectedRevision: 7, authorityRevision: 8, targetVersionId: null, authorization: null,
      phase: 'aborted', errorCode: CAPABILITY_ERROR.CONFLICT,
      resultItemRevision: null, resultAccountRevision: null, expiresAt: Date.now() + 10_000,
    };
    mocks.advanceLocal.mockResolvedValue(journal);
    daemon.emit('message', JSON.stringify({
      type: CAPABILITY_OPERATION_MSG.MANAGE_RESULT,
      requestId: journal.requestId,
      capabilityId: journal.itemId,
      bindingId: journal.bindingId,
      action: journal.action,
      expectedRevision: journal.expectedRevision,
      authorityRevision: journal.authorityRevision,
      phase: CAPABILITY_MANAGE_RESULT_PHASE.ABORTED,
      ok: false,
      errorCode: CAPABILITY_ERROR.CONFLICT,
    }));
    await flush();
    expect(daemon.sent.map((value) => JSON.parse(value))).toContainEqual(expect.objectContaining({
      type: CAPABILITY_OPERATION_MSG.MANAGE_ACK,
      requestId: journal.requestId,
      capabilityId: journal.itemId,
      bindingId: journal.bindingId,
      authorityRevision: journal.authorityRevision,
    }));
  });

  it('publishes browser/sync authority only after matching COMMIT_RESULT', async () => {
    const { daemon } = await authenticatedBridge();
    mocks.completeCommit.mockResolvedValue({
      status: 'ok',
      item: { id: 'server-capability-1', name: 'portable-skill' },
      operation: { revision: 7, state: 'installed' },
      accountRevision: 9,
      synchronized: true,
    });
    daemon.emit('message', JSON.stringify({
      type: CAPABILITY_OPERATION_MSG.COMMIT_RESULT,
      operationId: 'operation-1',
      expectedRevision: 6,
      capabilityId: 'server-capability-1',
      versionId: 'server-version-1',
      bindingId: 'server-binding-1',
      authorityRevision: 2,
      ok: true,
    }));
    await flush();
    expect(mocks.completeCommit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      ownerUserId: 'owner-1',
      targetServerId: 'server-1',
      operationId: 'operation-1',
      expectedRevision: 6,
      capabilityId: 'server-capability-1',
      versionId: 'server-version-1',
      bindingId: 'server-binding-1',
      authorityRevision: 2,
    }));
    expect(daemon.sent.map((value) => JSON.parse(value))).toContainEqual(expect.objectContaining({
      type: CAPABILITY_OPERATION_MSG.COMMIT_ACK,
      operationId: 'operation-1',
      authorityRevision: 2,
    }));
    daemon.emit('message', JSON.stringify({
      type: CAPABILITY_OPERATION_MSG.COMMIT_RESULT,
      operationId: 'operation-1',
      expectedRevision: 6,
      capabilityId: 'server-capability-1',
      versionId: 'server-version-1',
      bindingId: 'server-binding-1',
      authorityRevision: 2,
      ok: true,
    }));
    await flush();
    expect(daemon.sent.map((value) => JSON.parse(value)).filter((frame) => (
      frame.type === CAPABILITY_OPERATION_MSG.COMMIT_ACK && frame.operationId === 'operation-1'
    ))).toHaveLength(2);

    daemon.emit('message', JSON.stringify({
      type: CAPABILITY_OPERATION_MSG.COMMIT_RESULT,
      operationId: 'operation-2',
      expectedRevision: 8,
      capabilityId: 'server-capability-2',
      versionId: 'server-version-2',
      bindingId: 'server-binding-2',
      authorityRevision: 3,
      ok: false,
      errorCode: CAPABILITY_ERROR.INTEGRITY_FAILED,
    }));
    await flush();
    expect(mocks.failPending).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      ownerUserId: 'owner-1',
      operationId: 'operation-2',
      expectedRevision: 8,
      capabilityId: 'server-capability-2',
      versionId: 'server-version-2',
      bindingId: 'server-binding-2',
      targetServerId: 'server-1',
    }));
  });

  it('rejects installed progress and preserves scan/rework findings as evidence', async () => {
    const { daemon } = await authenticatedBridge();
    daemon.emit('message', JSON.stringify({
      type: CAPABILITY_OPERATION_MSG.PROGRESS,
      operationId: 'operation-installed-bypass',
      expectedRevision: 2,
      state: 'installed',
    }));
    await flush();
    expect(mocks.update).not.toHaveBeenCalled();

    mocks.update.mockResolvedValue({ revision: 4 });
    daemon.emit('message', JSON.stringify({
      type: CAPABILITY_OPERATION_MSG.PROGRESS,
      operationId: 'operation-rework',
      expectedRevision: 3,
      state: 'rework',
      artifactDigest: 'a'.repeat(64),
      findings: [{ code: 'unsafe_script', message: 'script blocked', severity: 'high', source: 'scanner', blocking: true }],
    }));
    await flush();
    expect(mocks.update).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      state: 'rework',
      allowedCurrentStates: ['queued', 'scanning', 'auditing'],
      evidence: expect.objectContaining({
        kind: 'scan',
        artifactDigest: 'a'.repeat(64),
        verdict: null,
      }),
    }));
  });

  it('commits daemon activation only through the owner-scoped transactional repository', async () => {
    const { daemon } = await authenticatedBridge();
    mocks.activate.mockResolvedValue({
      item: { id: 'server-capability-1', activeVersion: null },
      accountRevision: 8,
      pendingBlob: true,
      operation: { revision: 6, state: 'syncing' },
      candidate: {
        versionId: 'server-version-1',
        versionNumber: 1,
        bindingId: 'server-binding-1',
        authorization: null,
      },
    });
    const activationFrame = {
      type: CAPABILITY_OPERATION_MSG.ACTIVATE,
      operationId: 'operation-1',
      expectedRevision: 5,
      capability: {
        id: 'capability-1',
        revision: 1,
        kind: CAPABILITY_KIND.SKILL,
        name: 'portable-skill',
        state: CAPABILITY_STATE.ACTIVE,
        scope: CAPABILITY_SCOPE.ACCOUNT,
        versionId: 'version-1',
        version: 1,
        artifactDigest: 'a'.repeat(64),
        readiness: CAPABILITY_READINESS.READY,
        findings: [],
        updatedAt: 10,
      },
      version: {
        id: 'version-1',
        capabilityId: 'capability-1',
        version: 1,
        artifactDigest: 'a'.repeat(64),
        blobDigest: 'c'.repeat(64),
        blobByteSize: 128,
        auditDigest: 'b'.repeat(64),
        auditVerdict: CAPABILITY_AUDIT_VERDICT.PASS,
        sourceKind: CAPABILITY_SOURCE_KIND.INLINE,
        createdAt: 10,
      },
      binding: {
        id: 'binding-1',
        capabilityId: 'capability-1',
        versionId: 'version-1',
        scope: CAPABILITY_SCOPE.ACCOUNT,
        providers: [],
        machines: [],
        active: true,
      },
    };
    daemon.emit('message', JSON.stringify(activationFrame));
    await flush();
    expect(mocks.activate).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      ownerUserId: 'owner-1',
      targetServerId: 'server-1',
      operationId: 'operation-1',
      expectedOperationRevision: 5,
      requestedItemId: 'capability-1',
      requestedBindingId: 'binding-1',
      blobDigest: 'c'.repeat(64),
      blobByteSize: 128,
    }));
    const activationParams = mocks.activate.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(activationParams).not.toHaveProperty('itemId');
    expect(activationParams).not.toHaveProperty('versionId');
    expect(activationParams).not.toHaveProperty('bindingId');
    expect(mocks.blobAccess).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      ownerUserId: 'owner-1',
      serverId: 'server-1',
      capabilityId: 'server-capability-1',
      versionId: 'server-version-1',
      action: 'upload',
    }));
    expect(daemon.sent.map((value) => JSON.parse(value))).toContainEqual(expect.objectContaining({
      type: CAPABILITY_SYNC_MSG.BLOB_CAPABILITY,
      operationId: 'operation-1',
      access: expect.objectContaining({ singleUseToken: 'blob-token' }),
    }));
    expect(daemon.sent.some((value) => JSON.parse(value).type === CAPABILITY_SYNC_MSG.ACK)).toBe(false);

    mocks.activate.mockRejectedValueOnce(new Error('capability_activation_stale_operation'));
    mocks.updateState.mockResolvedValueOnce(null);
    mocks.getOperation.mockResolvedValueOnce({
      id: 'operation-1',
      revision: 7,
      state: CAPABILITY_INSTALL_STATE.FAILED,
      requestSummary: { targetServerId: 'server-1' },
    });
    daemon.sent = [];
    daemon.emit('message', JSON.stringify(activationFrame));
    await flush();
    expect(daemon.sent.map((value) => JSON.parse(value))).toContainEqual({
      type: CAPABILITY_OPERATION_MSG.CANCEL,
      operationId: 'operation-1',
      expectedRevision: 7,
    });
  });

  it('normalizes complete MCP definitions and rejects secrets, unknown keys, and deprecated transports', async () => {
    const { daemon } = await authenticatedBridge();
    const baseFrame = {
      type: CAPABILITY_OPERATION_MSG.ACTIVATE,
      operationId: 'operation-mcp',
      expectedRevision: 5,
      capability: {
        id: 'capability-mcp', revision: 1, kind: CAPABILITY_KIND.MCP,
        name: 'portable-mcp', state: CAPABILITY_STATE.RUNTIME_PENDING,
        scope: CAPABILITY_SCOPE.ACCOUNT, versionId: 'version-mcp', version: 1,
        artifactDigest: 'a'.repeat(64), readiness: CAPABILITY_READINESS.RUNTIME_PENDING,
        findings: [], tools: ['search', 'read'], updatedAt: 10,
      },
      version: {
        id: 'version-mcp', capabilityId: 'capability-mcp', version: 1,
        artifactDigest: 'a'.repeat(64), auditDigest: 'b'.repeat(64),
        auditVerdict: CAPABILITY_AUDIT_VERDICT.PASS,
        sourceKind: CAPABILITY_SOURCE_KIND.MCP_CONFIG, createdAt: 10,
      },
      binding: {
        id: 'binding-mcp', capabilityId: 'capability-mcp', versionId: 'version-mcp',
        scope: CAPABILITY_SCOPE.ACCOUNT, providers: [], machines: [], active: true,
      },
    };
    for (const definition of [
      { name: 'portable-mcp', transport: 'stdio', command: 'node', env: { TOKEN: 'raw-secret' } },
      { name: 'portable-mcp', transport: 'stdio', command: 'node', env: { TOKEN: { credentialRef: 'vault-token' } } },
      { name: 'portable-mcp', transport: 'streamable_http', url: 'https://mcp.example.test/v1', credentialRef: 'vault-main' },
      { name: 'portable-mcp', transport: 'streamable_http', url: 'https://mcp.example.test/v1', headers: { Authorization: { credentialRef: 'vault-header' } } },
      { name: 'portable-mcp', transport: 'stdio', command: 'node', unknown: true },
      { name: 'portable-mcp', transport: 'sse', url: 'https://mcp.example.test/sse' },
    ]) {
      daemon.emit('message', JSON.stringify({ ...baseFrame, definition }));
      await flush();
    }
    expect(mocks.activate).not.toHaveBeenCalled();

    mocks.activate.mockResolvedValue({
      item: { id: 'server-capability-mcp' },
      accountRevision: 9,
      pendingBlob: false,
      operation: { revision: 6, state: 'syncing' },
      candidate: { versionId: 'server-version-mcp', bindingId: 'server-binding-mcp' },
    });
    daemon.emit('message', JSON.stringify({
      ...baseFrame,
      definition: {
        name: 'portable-mcp',
        transport: 'streamable_http',
        url: 'https://mcp.example.test/v1',
        toolAllowlist: ['search', 'read'],
      },
    }));
    await flush();
    expect(mocks.activate).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      targetServerId: 'server-1',
      definition: {
        name: 'portable-mcp',
        transport: 'streamable_http',
        url: 'https://mcp.example.test/v1',
        toolAllowlist: ['search', 'read'],
      },
    }));
  });
});
