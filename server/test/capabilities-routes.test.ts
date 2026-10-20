import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import {
  CAPABILITY_BLOB_ACTION,
  CAPABILITY_AUTHORITY_STATE,
  CAPABILITY_BLOB_TOKEN_HEADER,
  CAPABILITY_CONFIRMATION_DECISION,
  CAPABILITY_KIND,
  CAPABILITY_MANAGE_ACTION,
  CAPABILITY_SCOPE,
  CAPABILITY_SOURCE_KIND,
  CAPABILITY_STATE,
} from '../../shared/capability-management.js';
import type { Env } from '../src/env.js';
import type { CapabilityItemView, CapabilityOperationView } from '../src/db/capabilities.js';

const listCapabilitiesMock = vi.fn();
const listRecentOperationsMock = vi.fn();
const getCapabilityMock = vi.fn();
const getOperationMock = vi.fn();
const createOperationMock = vi.fn();
const confirmOperationMock = vi.fn();
const cancelOperationMock = vi.fn();
const manageCapabilityMock = vi.fn();
const resolveManageTargetMock = vi.fn();
const reserveLocalManageMock = vi.fn();
const releaseLocalManageMock = vi.fn();
const failPendingByVersionMock = vi.fn();
const listAuditMock = vi.fn();
const getSnapshotMock = vi.fn();
const readinessMock = vi.fn();
const canAcceptCapabilityOperationMock = vi.fn();
const dispatchCapabilityInstallMock = vi.fn();
const dispatchCapabilityConfirmationMock = vi.fn();
const dispatchCapabilityCancellationMock = vi.fn();
const issueBlobAccessMock = vi.fn();
const consumeBlobAccessMock = vi.fn();
const persistBlobUploadMock = vi.fn();
const readBlobDownloadMock = vi.fn();
const broadcastCapabilitySyncMock = vi.fn();
const dispatchPendingAuthorizationMock = vi.fn();
const dispatchCapabilityManageMock = vi.fn();

vi.mock('../src/security/authorization.js', () => {
  const middleware = () => async (
    c: { req: { header: (name: string) => string | undefined }; set: (key: string, value: string) => void },
    next: () => Promise<void>,
  ) => {
    c.set('userId', 'owner-1');
    c.set('role', 'owner');
    const serverId = c.req.header('x-test-auth-server');
    if (serverId) c.set('authServerId', serverId);
    await next();
  };
  return { requireOwner: middleware, requireAuth: middleware };
});

vi.mock('../src/db/capabilities.js', () => ({
  listCapabilities: (...args: unknown[]) => listCapabilitiesMock(...args),
  listRecentCapabilityOperations: (...args: unknown[]) => listRecentOperationsMock(...args),
  getCapability: (...args: unknown[]) => getCapabilityMock(...args),
  getCapabilityOperation: (...args: unknown[]) => getOperationMock(...args),
  createInstallOperation: (...args: unknown[]) => createOperationMock(...args),
  confirmCapabilityOperation: (...args: unknown[]) => confirmOperationMock(...args),
  cancelCapabilityOperation: (...args: unknown[]) => cancelOperationMock(...args),
  manageCapability: (...args: unknown[]) => manageCapabilityMock(...args),
  resolveCapabilityManagementTarget: (...args: unknown[]) => resolveManageTargetMock(...args),
  reserveLocalCapabilityManage: (...args: unknown[]) => reserveLocalManageMock(...args),
  releaseLocalCapabilityManage: (...args: unknown[]) => releaseLocalManageMock(...args),
  failCapabilityPendingActivationByVersion: (...args: unknown[]) => failPendingByVersionMock(...args),
  listCapabilityAuditEvidence: (...args: unknown[]) => listAuditMock(...args),
  getCapabilitySyncSnapshot: (...args: unknown[]) => getSnapshotMock(...args),
  acknowledgeCapabilityReadiness: (...args: unknown[]) => readinessMock(...args),
}));

vi.mock('../src/ws/bridge.js', () => ({
  WsBridge: {
    broadcastCapabilitySync: (...args: unknown[]) => broadcastCapabilitySyncMock(...args),
    dispatchPendingCapabilityAuthorization: (...args: unknown[]) => dispatchPendingAuthorizationMock(...args),
    get: () => ({
      canAcceptCapabilityOperation: (...args: unknown[]) => canAcceptCapabilityOperationMock(...args),
      dispatchCapabilityInstall: (...args: unknown[]) => dispatchCapabilityInstallMock(...args),
      dispatchCapabilityConfirmation: (...args: unknown[]) => dispatchCapabilityConfirmationMock(...args),
      dispatchCapabilityCancellation: (...args: unknown[]) => dispatchCapabilityCancellationMock(...args),
      dispatchCapabilityManage: (...args: unknown[]) => dispatchCapabilityManageMock(...args),
    }),
  },
}));

vi.mock('../src/services/capability-package-storage.js', () => ({
  issueCapabilityBlobAccess: (...args: unknown[]) => issueBlobAccessMock(...args),
  consumeCapabilityBlobAccess: (...args: unknown[]) => consumeBlobAccessMock(...args),
  persistCapabilityBlobUpload: (...args: unknown[]) => persistBlobUploadMock(...args),
  readCapabilityBlobDownload: (...args: unknown[]) => readBlobDownloadMock(...args),
}));

function operation(overrides: Partial<CapabilityOperationView> = {}): CapabilityOperationView {
  return {
    id: 'operation-1',
    itemId: null,
    kind: 'install',
    state: 'queued',
    requestSummary: {
      kind: CAPABILITY_KIND.SKILL,
      sourceKind: CAPABILITY_SOURCE_KIND.INLINE,
      scope: CAPABILITY_SCOPE.ACCOUNT,
      providers: [],
      machines: [],
    },
    artifactDigest: null,
    auditDigest: null,
    errorCode: null,
    revision: 1,
    createdAt: 100,
    updatedAt: 100,
    completedAt: null,
    evidence: [],
    confirmation: null,
    ...overrides,
  };
}

function capability(overrides: Partial<CapabilityItemView> = {}): CapabilityItemView {
  return {
    id: 'capability-1',
    kind: CAPABILITY_KIND.SKILL,
    name: 'example-skill',
    lifecycleState: CAPABILITY_STATE.ACTIVE,
    activeVersionId: 'version-1',
    revision: 2,
    tombstonedAt: null,
    removedAt: null,
    createdAt: 100,
    updatedAt: 200,
    activeVersion: {
      id: 'version-1',
      versionNumber: 1,
      artifactDigest: 'a'.repeat(64),
      blobDigest: null,
      blobByteSize: null,
      auditDigest: 'b'.repeat(64),
      sourceKind: CAPABILITY_SOURCE_KIND.INLINE,
      sourceSummary: 'inline package',
      manifest: {},
      definition: null,
      permissionSummary: [],
      publicationState: 'active',
      createdAt: 100,
    },
    versions: [{
      id: 'version-1',
      versionNumber: 1,
      artifactDigest: 'a'.repeat(64),
      blobDigest: null,
      blobByteSize: null,
      auditDigest: 'b'.repeat(64),
      sourceKind: CAPABILITY_SOURCE_KIND.INLINE,
      sourceSummary: 'inline package',
      manifest: {},
      definition: null,
      permissionSummary: [],
      publicationState: 'active',
      createdAt: 100,
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
      authorization: null,
      authorityState: CAPABILITY_AUTHORITY_STATE.ACTIVE,
      enabled: true,
      revision: 1,
      updatedAt: 200,
    }],
    readiness: [],
    ...overrides,
  };
}

async function makeApp() {
  const { capabilityRoutes } = await import('../src/routes/capabilities.js');
  const app = new Hono<{ Bindings: Env }>();
  app.use('*', async (c, next) => {
    if (!c.env) (c as unknown as { env: Env }).env = {} as Env;
    Object.assign(c.env, { DB: {}, JWT_SIGNING_KEY: 'test-key' });
    await next();
  });
  app.route('/api', capabilityRoutes);
  return app;
}

describe('capability owner routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listCapabilitiesMock.mockResolvedValue({ items: [], nextCursor: null });
    listRecentOperationsMock.mockResolvedValue([]);
    getCapabilityMock.mockResolvedValue(null);
    getOperationMock.mockResolvedValue(null);
    listAuditMock.mockResolvedValue([]);
    canAcceptCapabilityOperationMock.mockReturnValue(true);
    dispatchCapabilityInstallMock.mockReturnValue(true);
    dispatchCapabilityConfirmationMock.mockReturnValue(true);
    dispatchCapabilityCancellationMock.mockReturnValue(true);
    issueBlobAccessMock.mockResolvedValue(null);
    consumeBlobAccessMock.mockResolvedValue(null);
    persistBlobUploadMock.mockResolvedValue(null);
    readBlobDownloadMock.mockResolvedValue(null);
    broadcastCapabilitySyncMock.mockResolvedValue(0);
    dispatchPendingAuthorizationMock.mockResolvedValue(true);
    dispatchCapabilityManageMock.mockResolvedValue(null);
    reserveLocalManageMock.mockImplementation(async (_db, params: {
      requestId: string; ownerUserId: string; itemId: string; bindingId: string;
      serverId: string; action: string; expectedRevision: number;
    }) => ({
      status: 'ok',
      request: {
        requestId: params.requestId,
        ownerUserId: params.ownerUserId,
        itemId: params.itemId,
        bindingId: params.bindingId,
        serverId: params.serverId,
        action: params.action,
        expectedRevision: params.expectedRevision,
        authorityRevision: params.expectedRevision + 1,
        targetVersionId: null,
        authorization: null,
        phase: 'prepare_sent',
        errorCode: null,
        resultItemRevision: null,
        resultAccountRevision: null,
        expiresAt: Date.now() + 15_000,
      },
    }));
    releaseLocalManageMock.mockResolvedValue(undefined);
    failPendingByVersionMock.mockResolvedValue(null);
    resolveManageTargetMock.mockImplementation(async (_db, params: { bindingId?: string }) => {
      const item = capability();
      const bindings = params.bindingId
        ? item.bindings.filter((binding) => binding.id === params.bindingId)
        : item.bindings;
      return bindings.length === 1
        ? { status: 'ok', item, binding: bindings[0] }
        : { status: 'ambiguous_binding', bindings };
    });
  });

  it('persists only a content-safe install summary, never inline package bodies or raw MCP config', async () => {
    const app = await makeApp();
    createOperationMock.mockResolvedValue({ operation: operation(), created: true });
    const response = await app.request('/api/capabilities/install?serverId=server-1', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        kind: CAPABILITY_KIND.SKILL,
        source: {
          kind: CAPABILITY_SOURCE_KIND.INLINE,
          inlineFiles: {
            'SKILL.md': 'private-package-body-must-not-persist',
            'references/guide.md': 'another-private-body',
          },
        },
        scope: CAPABILITY_SCOPE.ACCOUNT,
        idempotencyKey: 'install-one',
      }),
    });
    expect(response.status).toBe(202);
    const call = createOperationMock.mock.calls[0]?.[1] as { ownerUserId: string; requestSummary: Record<string, unknown> };
    expect(call.ownerUserId).toBe('owner-1');
    expect(JSON.stringify(call.requestSummary)).not.toContain('private-package-body');
    expect(JSON.stringify(call.requestSummary)).not.toContain('another-private-body');
    expect(call.requestSummary).toMatchObject({
      sourceKind: CAPABILITY_SOURCE_KIND.INLINE,
      sourceLabel: 'inline-package',
      inlineFileCount: 2,
    });
    expect(dispatchCapabilityInstallMock).toHaveBeenCalledWith('owner-1', expect.objectContaining({
      operationId: 'operation-1',
      request: expect.objectContaining({ idempotencyKey: 'install-one' }),
    }));
  });

  it('rejects oversized, type-confused, control-character, and unknown install fields before DB mutation', async () => {
    const app = await makeApp();
    const base = {
      kind: CAPABILITY_KIND.SKILL,
      source: { kind: CAPABILITY_SOURCE_KIND.INLINE, inlineFiles: { 'SKILL.md': 'safe' } },
      scope: CAPABILITY_SCOPE.ACCOUNT,
      idempotencyKey: 'strict-http',
    };
    const invalidBodies = [
      { ...base, unexpected: 'field' },
      { ...base, displayName: 'x'.repeat(97) },
      { ...base, providers: [42] },
      { ...base, providers: ['codex\u0000forged'] },
      { ...base, machines: ['x'.repeat(129)] },
      { ...base, scopeId: 'forbidden-for-account' },
      { ...base, source: { ...base.source, value: 'unexpected' } },
    ];
    for (const body of invalidBodies) {
      const response = await app.request('/api/capabilities/install?serverId=server-1', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      expect(response.status).toBe(400);
    }
    expect(createOperationMock).not.toHaveBeenCalled();
    expect(dispatchCapabilityInstallMock).not.toHaveBeenCalled();
  });

  it('accepts updates only for an exact same-owner capability and binding id', async () => {
    const app = await makeApp();
    getCapabilityMock.mockResolvedValue(capability());
    createOperationMock.mockResolvedValue({ operation: operation(), created: true });
    const accepted = await app.request('/api/capabilities/install?serverId=server-1', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        capabilityId: 'capability-1',
        bindingId: 'binding-1',
        kind: CAPABILITY_KIND.SKILL,
        source: { kind: CAPABILITY_SOURCE_KIND.INLINE, inlineFiles: { 'SKILL.md': 'updated' } },
        scope: CAPABILITY_SCOPE.ACCOUNT,
        idempotencyKey: 'update-one',
      }),
    });
    expect(accepted.status).toBe(202);
    expect(createOperationMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      requestSummary: expect.objectContaining({ capabilityId: 'capability-1', bindingId: 'binding-1' }),
    }));
    expect(dispatchCapabilityInstallMock).toHaveBeenCalledWith('owner-1', expect.objectContaining({
      request: expect.objectContaining({ capabilityId: 'capability-1', bindingId: 'binding-1' }),
    }));

    getCapabilityMock.mockResolvedValueOnce(null);
    const missing = await app.request('/api/capabilities/install?serverId=server-1', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        capabilityId: 'other-owner-capability',
        bindingId: 'other-owner-binding',
        kind: CAPABILITY_KIND.SKILL,
        source: { kind: CAPABILITY_SOURCE_KIND.INLINE, inlineFiles: { 'SKILL.md': 'updated' } },
        scope: CAPABILITY_SCOPE.ACCOUNT,
        idempotencyKey: 'update-other-owner',
      }),
    });
    expect(missing.status).toBe(404);
  });

  it('persists only a basename or host/repository source label for confirmation cards', async () => {
    const app = await makeApp();
    createOperationMock.mockResolvedValue({ operation: operation(), created: true });
    const response = await app.request('/api/capabilities/install?serverId=server-1', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        kind: CAPABILITY_KIND.SKILL,
        source: { kind: CAPABILITY_SOURCE_KIND.LOCAL_PATH, value: '/private/owner/projects/audited-skill' },
        scope: CAPABILITY_SCOPE.LOCAL,
        idempotencyKey: 'safe-source-label',
      }),
    });
    expect(response.status).toBe(202);
    const summary = createOperationMock.mock.calls[0]?.[1]?.requestSummary as Record<string, unknown>;
    expect(summary.sourceLabel).toBe('audited-skill');
    expect(JSON.stringify(summary)).not.toContain('/private/owner/projects');
  });

  it('returns bounded immutable version choices and passes list filters to owner-scoped storage', async () => {
    const app = await makeApp();
    const item = capability();
    listCapabilitiesMock.mockResolvedValue({ items: [item], nextCursor: null });
    const response = await app.request('/api/capabilities?kind=skill&state=active&scope=account&query=example');
    expect(response.status).toBe(200);
    const payload = await response.json() as { items: Array<{ availableVersions?: unknown[] }> };
    expect(payload.items[0]?.availableVersions).toEqual([
      expect.objectContaining({ id: 'version-1', version: 1, label: 'v1' }),
    ]);
    expect(listCapabilitiesMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      ownerUserId: 'owner-1',
      kind: CAPABILITY_KIND.SKILL,
      state: CAPABILITY_STATE.ACTIVE,
      scope: CAPABILITY_SCOPE.ACCOUNT,
      query: 'example',
    }));
  });

  it('discovers owner operations without exposing persisted request summaries', async () => {
    const app = await makeApp();
    listRecentOperationsMock.mockResolvedValue([operation({
      state: 'awaiting_confirmation',
      revision: 4,
      artifactDigest: 'a'.repeat(64),
      auditDigest: 'b'.repeat(64),
      requestSummary: {
        kind: CAPABILITY_KIND.SKILL,
        displayName: 'reviewed-skill',
        sourceLabel: 'github.com/acme/reviewed-skill',
        scope: CAPABILITY_SCOPE.ACCOUNT,
        providers: ['codex'],
        machines: ['server-1'],
        tools: ['filesystem.read'],
        permissions: ['workspace.read'],
        updateDiff: ['instructions_changed'],
        hasScripts: true,
        sourceLocatorDigest: 'private-persisted-summary-must-not-leak',
        inlineFileNameDigest: 'also-private',
      },
      evidence: [{
        id: 'audit-1', kind: 'audit', evidenceDigest: 'b'.repeat(64), artifactDigest: 'a'.repeat(64),
        policyVersion: 'auditor-v1', verdict: 'PASS', findings: [], createdAt: 101,
      }],
    })]);
    const response = await app.request('/api/capabilities');
    expect(response.status).toBe(200);
    const payload = await response.json() as {
      operations: Array<{ id: string; state: string; displayName?: string; sourceLabel?: string; terminal?: boolean }>;
    };
    expect(payload.operations).toEqual([
      expect.objectContaining({
        id: 'operation-1',
        state: 'awaiting_confirmation',
        displayName: 'reviewed-skill',
        sourceLabel: 'github.com/acme/reviewed-skill',
        artifactDigest: 'a'.repeat(64),
        providers: ['codex'],
        machines: ['server-1'],
        tools: ['filesystem.read'],
        permissions: ['workspace.read'],
        updateDiff: ['instructions_changed'],
        hasScripts: true,
        terminal: false,
      }),
    ]);
    expect(JSON.stringify(payload)).not.toContain('private-persisted-summary-must-not-leak');
    expect(JSON.stringify(payload)).not.toContain('also-private');
    expect(listRecentOperationsMock).toHaveBeenCalledWith(expect.anything(), {
      ownerUserId: 'owner-1',
      activeLimit: 200,
      terminalLimit: 12,
    });
  });

  it('fails fast without creating queued work when the selected daemon is offline or belongs to another owner', async () => {
    const app = await makeApp();
    canAcceptCapabilityOperationMock.mockReturnValue(false);
    const response = await app.request('/api/capabilities/install?serverId=server-offline', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        kind: CAPABILITY_KIND.SKILL,
        source: { kind: CAPABILITY_SOURCE_KIND.INLINE, inlineFiles: { 'SKILL.md': 'safe' } },
        scope: CAPABILITY_SCOPE.ACCOUNT,
        idempotencyKey: 'offline-install',
      }),
    });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ reason: 'runtime_pending' });
    expect(createOperationMock).not.toHaveBeenCalled();
    expect(dispatchCapabilityInstallMock).not.toHaveBeenCalled();
  });

  it('returns persisted scanner findings for a reconnecting rework operation', async () => {
    const app = await makeApp();
    getOperationMock.mockResolvedValue(operation({
      state: 'rework',
      revision: 2,
      artifactDigest: 'a'.repeat(64),
      evidence: [{
        id: 'scan-1',
        kind: 'scan',
        evidenceDigest: 'c'.repeat(64),
        artifactDigest: 'a'.repeat(64),
        policyVersion: 'scanner-v1',
        verdict: null,
        findings: [{ code: 'unsafe_script', message: 'blocked', severity: 'high', source: 'scanner', blocking: true }],
        createdAt: 101,
      }, {
        id: 'stale-scan',
        kind: 'scan',
        evidenceDigest: 'd'.repeat(64),
        artifactDigest: 'e'.repeat(64),
        policyVersion: 'scanner-v1',
        verdict: null,
        findings: [{ code: 'stale_finding', message: 'must not surface', severity: 'high', source: 'scanner', blocking: true }],
        createdAt: 102,
      }],
    }));
    const response = await app.request('/api/capabilities/operations/operation-1');
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      operation: {
        state: 'rework',
        findings: [{ code: 'unsafe_script', blocking: true }],
      },
    });
    expect(JSON.stringify(await (await app.request('/api/capabilities/operations/operation-1')).json()))
      .not.toContain('stale_finding');
  });

  it('rejects secret-bearing source URLs before persistence', async () => {
    const app = await makeApp();
    const response = await app.request('/api/capabilities/install?serverId=server-1', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        kind: CAPABILITY_KIND.SKILL,
        source: { kind: CAPABILITY_SOURCE_KIND.URL, value: 'https://example.test/skill.zip?token=plaintext' },
        scope: CAPABILITY_SCOPE.ACCOUNT,
        idempotencyKey: 'install-secret',
      }),
    });
    expect(response.status).toBe(400);
    expect(createOperationMock).not.toHaveBeenCalled();
    expect(JSON.stringify(await response.json())).not.toContain('plaintext');
  });

  it('derives confirmation evidence and targets from authoritative operation state', async () => {
    const app = await makeApp();
    const current = operation({
      state: 'awaiting_confirmation',
      revision: 4,
      artifactDigest: 'a'.repeat(64),
      auditDigest: 'b'.repeat(64),
      requestSummary: {
        kind: CAPABILITY_KIND.MCP,
        scope: CAPABILITY_SCOPE.LOCAL,
        providers: ['codex'],
        machines: ['server-1'],
        targetServerId: 'server-1',
      },
    });
    getOperationMock.mockResolvedValue(current);
    confirmOperationMock.mockResolvedValue({ status: 'ok', operation: operation({ state: 'installing', revision: 5 }) });
    const response = await app.request('/api/capabilities/operations/operation-1/confirmation', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: 'rcc_session=test-session',
      },
      body: JSON.stringify({ decision: CAPABILITY_CONFIRMATION_DECISION.INSTALL, revision: 4 }),
    });
    expect(response.status).toBe(200);
    expect(confirmOperationMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      ownerUserId: 'owner-1',
      operationId: 'operation-1',
      artifactDigest: 'a'.repeat(64),
      auditDigest: 'b'.repeat(64),
      targetSummary: {
        scope: CAPABILITY_SCOPE.LOCAL,
        providers: ['codex'],
        machines: ['server-1'],
      },
    }));
    expect(dispatchCapabilityConfirmationMock).toHaveBeenCalledWith('owner-1', expect.objectContaining({
      operationId: 'operation-1',
      expectedRevision: 5,
      decision: CAPABILITY_CONFIRMATION_DECISION.INSTALL,
    }));
  });

  it('does not allow bearer/AI credentials to synthesize the browser confirmation', async () => {
    const app = await makeApp();
    const response = await app.request('/api/capabilities/operations/operation-1/confirmation', {
      method: 'POST',
      headers: { authorization: 'Bearer daemon-token', 'content-type': 'application/json' },
      body: JSON.stringify({ decision: CAPABILITY_CONFIRMATION_DECISION.INSTALL, revision: 1 }),
    });
    expect(response.status).toBe(403);
    expect(confirmOperationMock).not.toHaveBeenCalled();
  });

  it('cancels authoritatively while the daemon is offline and only attempts best-effort cleanup', async () => {
    const app = await makeApp();
    getOperationMock.mockResolvedValue(operation({
      state: 'auditing',
      revision: 3,
      requestSummary: { targetServerId: 'server-offline', kind: CAPABILITY_KIND.SKILL },
    }));
    cancelOperationMock.mockResolvedValue({
      status: 'ok',
      operation: operation({ state: 'cancelled', revision: 4 }),
    });
    canAcceptCapabilityOperationMock.mockReturnValue(false);
    dispatchCapabilityCancellationMock.mockReturnValue(false);
    const response = await app.request('/api/capabilities/operations/operation-1/cancel', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ revision: 3 }),
    });
    expect(response.status).toBe(200);
    expect(cancelOperationMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      ownerUserId: 'owner-1', operationId: 'operation-1', expectedRevision: 3,
    }));
    expect(dispatchCapabilityCancellationMock).toHaveBeenCalledWith('owner-1', expect.objectContaining({
      operationId: 'operation-1', expectedRevision: 4,
    }));
  });

  it('requires explicit uninstall intent and optimistic item revision', async () => {
    const app = await makeApp();
    const rejected = await app.request('/api/capabilities/capability-1/manage', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        action: CAPABILITY_MANAGE_ACTION.UNINSTALL,
        expectedRevision: 2,
        scope: CAPABILITY_SCOPE.ACCOUNT,
      }),
    });
    expect(rejected.status).toBe(400);
    expect(manageCapabilityMock).not.toHaveBeenCalled();

    manageCapabilityMock.mockResolvedValue({ status: 'ok', item: capability({
      lifecycleState: CAPABILITY_STATE.TOMBSTONED,
      revision: 3,
      tombstonedAt: 300,
    }), accountRevision: 8, synchronized: true });
    const accepted = await app.request('/api/capabilities/capability-1/manage', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        action: CAPABILITY_MANAGE_ACTION.UNINSTALL,
        bindingId: 'binding-1',
        expectedRevision: 2,
        scope: CAPABILITY_SCOPE.ACCOUNT,
        userIntent: 'uninstall example-skill',
      }),
    });
    expect(accepted.status).toBe(200);
    expect(manageCapabilityMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      ownerUserId: 'owner-1', itemId: 'capability-1', bindingId: 'binding-1', expectedRevision: 2,
    }));
    expect(broadcastCapabilitySyncMock).toHaveBeenCalledWith('owner-1', expect.anything(), 7);
  });

  it('returns exact binding choices and never reports unavailable credential deletion as success', async () => {
    const app = await makeApp();
    resolveManageTargetMock.mockResolvedValueOnce({
      status: 'ambiguous_binding',
      bindings: [
        capability().bindings[0],
        { ...capability().bindings[0], id: 'binding-project', scope: CAPABILITY_SCOPE.PROJECT, projectKey: 'project-1' },
      ],
    });
    getCapabilityMock.mockResolvedValue(capability());
    const ambiguous = await app.request('/api/capabilities/capability-1/manage', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: CAPABILITY_MANAGE_ACTION.DISABLE, expectedRevision: 2 }),
    });
    expect(ambiguous.status).toBe(409);
    expect(await ambiguous.json()).toMatchObject({
      reason: 'ambiguous',
      choices: [
        { bindingId: 'binding-1', scope: CAPABILITY_SCOPE.ACCOUNT },
        { bindingId: 'binding-project', scope: CAPABILITY_SCOPE.PROJECT, scopeId: 'project-1' },
      ],
    });

    manageCapabilityMock.mockResolvedValueOnce({ status: 'runtime_pending' });
    const unavailable = await app.request('/api/capabilities/capability-1/manage', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        action: CAPABILITY_MANAGE_ACTION.DELETE_CREDENTIALS,
        expectedRevision: 2,
        userIntent: 'delete retained credentials',
      }),
    });
    expect(unavailable.status).toBe(503);
    expect(await unavailable.json()).toMatchObject({ reason: 'runtime_pending', retryable: false });
    expect(broadcastCapabilitySyncMock).not.toHaveBeenCalled();
  });

  it('never mutates local authority before an exact durable daemon ACK', async () => {
    const app = await makeApp();
    const local = capability({
      bindings: [{
        ...capability().bindings[0]!,
        id: 'binding-local',
        scope: CAPABILITY_SCOPE.LOCAL,
        serverId: 'server-1',
      }],
    });
    resolveManageTargetMock.mockResolvedValue({ status: 'ok', item: local, binding: local.bindings[0] });

    dispatchCapabilityManageMock.mockResolvedValueOnce(null);
    const timeout = await app.request('/api/capabilities/capability-1/manage?serverId=server-1', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        action: CAPABILITY_MANAGE_ACTION.DISABLE,
        bindingId: 'binding-local',
        expectedRevision: 2,
      }),
    });
    expect(timeout.status).toBe(503);
    expect(await timeout.json()).toMatchObject({ reason: 'runtime_pending', retryable: true });
    expect(manageCapabilityMock).not.toHaveBeenCalled();
    expect(releaseLocalManageMock).not.toHaveBeenCalled();

    dispatchCapabilityManageMock.mockResolvedValueOnce({
      requestId: 'ignored-by-route-mock',
      capabilityId: 'capability-1',
      bindingId: 'binding-local',
      action: CAPABILITY_MANAGE_ACTION.DISABLE,
      expectedRevision: 2,
      authorityRevision: 3,
      phase: 'prepared',
      ok: false,
      errorCode: 'conflict',
    });
    const rejected = await app.request('/api/capabilities/capability-1/manage?serverId=server-1', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        action: CAPABILITY_MANAGE_ACTION.DISABLE,
        bindingId: 'binding-local',
        expectedRevision: 2,
      }),
    });
    expect(rejected.status).toBe(409);
    expect(manageCapabilityMock).not.toHaveBeenCalled();

    dispatchCapabilityManageMock.mockResolvedValueOnce({
      requestId: 'ignored-by-route-mock',
      capabilityId: 'capability-1',
      bindingId: 'binding-local',
      action: CAPABILITY_MANAGE_ACTION.DISABLE,
      expectedRevision: 2,
      authorityRevision: 3,
      phase: 'applied',
      ok: true,
    });
    manageCapabilityMock.mockResolvedValueOnce({
      status: 'ok',
      item: capability({ lifecycleState: CAPABILITY_STATE.DISABLED, revision: 3 }),
      accountRevision: 0,
      synchronized: false,
    });
    const accepted = await app.request('/api/capabilities/capability-1/manage?serverId=server-1', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        action: CAPABILITY_MANAGE_ACTION.DISABLE,
        bindingId: 'binding-local',
        expectedRevision: 2,
      }),
    });
    expect(accepted.status).toBe(200);
    expect(manageCapabilityMock).toHaveBeenCalledTimes(1);
    expect(manageCapabilityMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      bindingId: 'binding-local',
      serverId: 'server-1',
      localRequestId: expect.any(String),
    }));
  });

  it('requires daemon authentication bound to the exact sync server id', async () => {
    const app = await makeApp();
    const denied = await app.request('/api/capabilities/sync/snapshot?serverId=server-2', {
      headers: { 'x-test-auth-server': 'server-1' },
    });
    expect(denied.status).toBe(403);
    expect(getSnapshotMock).not.toHaveBeenCalled();
  });

  it('binds binary blob access and transfer to the authenticated daemon plus one-use grant', async () => {
    const app = await makeApp();
    const bytes = Buffer.from('audited-package');
    const claims = {
      sub: 'owner-1',
      serverId: 'server-1',
      capabilityId: 'capability-1',
      versionId: 'version-1',
      blobDigest: 'c'.repeat(64),
      maxBytes: bytes.byteLength,
    };
    issueBlobAccessMock.mockResolvedValue({
      action: CAPABILITY_BLOB_ACTION.DOWNLOAD,
      capabilityId: 'capability-1',
      versionId: 'version-1',
      blobDigest: 'c'.repeat(64),
      maxBytes: bytes.byteLength,
      expiresAt: 1000,
      singleUseToken: 'one-use',
    });
    const accessResponse = await app.request('/api/capabilities/blobs/version-1/access', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-test-auth-server': 'server-1' },
      body: JSON.stringify({ capabilityId: 'capability-1', action: CAPABILITY_BLOB_ACTION.DOWNLOAD }),
    });
    expect(accessResponse.status).toBe(200);
    expect(issueBlobAccessMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      ownerUserId: 'owner-1', serverId: 'server-1', capabilityId: 'capability-1', versionId: 'version-1',
    }));

    consumeBlobAccessMock.mockResolvedValue(claims);
    persistBlobUploadMock.mockResolvedValue({
      stored: true,
      accountRevision: 8,
      authorizationOperationIds: ['operation-1'],
    });
    const uploadResponse = await app.request('/api/capabilities/blobs/version-1', {
      method: 'PUT',
      headers: {
        'content-type': 'application/octet-stream',
        'x-test-auth-server': 'server-1',
        [CAPABILITY_BLOB_TOKEN_HEADER]: 'one-use',
      },
      body: bytes,
    });
    expect(uploadResponse.status).toBe(200);
    expect(consumeBlobAccessMock).toHaveBeenCalledWith(expect.anything(), 'one-use', 'test-key', expect.objectContaining({
      ownerUserId: 'owner-1', serverId: 'server-1', versionId: 'version-1', action: CAPABILITY_BLOB_ACTION.UPLOAD,
    }));
    expect(persistBlobUploadMock).toHaveBeenCalledWith(expect.anything(), claims, bytes);
    expect(dispatchPendingAuthorizationMock).toHaveBeenCalledWith('owner-1', expect.anything(), 'operation-1');
    expect(broadcastCapabilitySyncMock).not.toHaveBeenCalled();

    const writesBeforeOverflow = persistBlobUploadMock.mock.calls.length;
    const overflowResponse = await app.request('/api/capabilities/blobs/version-1', {
      method: 'PUT',
      headers: {
        'content-type': 'application/octet-stream',
        'x-test-auth-server': 'server-1',
        [CAPABILITY_BLOB_TOKEN_HEADER]: 'overflow-grant',
      },
      body: Buffer.concat([bytes, Buffer.from('overflow')]),
    });
    expect(overflowResponse.status).toBe(422);
    expect(persistBlobUploadMock).toHaveBeenCalledTimes(writesBeforeOverflow);

    readBlobDownloadMock.mockResolvedValue(bytes);
    const downloadResponse = await app.request('/api/capabilities/blobs/version-1', {
      headers: {
        'x-test-auth-server': 'server-1',
        [CAPABILITY_BLOB_TOKEN_HEADER]: 'one-use-download',
      },
    });
    expect(downloadResponse.status).toBe(200);
    expect(Buffer.from(await downloadResponse.arrayBuffer())).toEqual(bytes);

    const unauthenticated = await app.request('/api/capabilities/blobs/version-1', {
      headers: { [CAPABILITY_BLOB_TOKEN_HEADER]: 'stolen-grant' },
    });
    expect(unauthenticated.status).toBe(403);
  });
});
