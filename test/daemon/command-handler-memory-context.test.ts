import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const {
  getSessionMock,
  getTransportRuntimeMock,
  emitMock,
  sendKeysDelayedEnterMock,
  searchLocalMemorySemanticMock,
  recordMemoryHitsMock,
  detectRepoMock,
  getProcessedProjectionStatsMock,
  getProcessedProjectionByIdMock,
  listMemoryProjectSummariesMock,
  queryProcessedProjectionsMock,
  queryPendingContextEventsMock,
  archiveMemoryMock,
  restoreArchivedMemoryMock,
  writeProcessedProjectionMock,
  updateProcessedProjectionSummaryMock,
  listContextNamespacesMock,
  listContextObservationsMock,
  deleteContextObservationMock,
  updateContextObservationTextMock,
  upsertPinnedNoteMock,
  deleteMemoryMock,
  listSessionsMock,
} = vi.hoisted(() => ({
  getSessionMock: vi.fn(),
  getTransportRuntimeMock: vi.fn(),
  emitMock: vi.fn(),
  sendKeysDelayedEnterMock: vi.fn().mockResolvedValue(undefined),
  searchLocalMemorySemanticMock: vi.fn(),
  recordMemoryHitsMock: vi.fn(),
  detectRepoMock: vi.fn(),
  getProcessedProjectionStatsMock: vi.fn(),
  getProcessedProjectionByIdMock: vi.fn(),
  listMemoryProjectSummariesMock: vi.fn(),
  queryProcessedProjectionsMock: vi.fn(),
  queryPendingContextEventsMock: vi.fn(),
  archiveMemoryMock: vi.fn(),
  restoreArchivedMemoryMock: vi.fn(),
  writeProcessedProjectionMock: vi.fn(),
  updateProcessedProjectionSummaryMock: vi.fn(),
  listContextNamespacesMock: vi.fn(() => []),
  listContextObservationsMock: vi.fn(() => []),
  deleteContextObservationMock: vi.fn(),
  updateContextObservationTextMock: vi.fn(),
  upsertPinnedNoteMock: vi.fn(),
  deleteMemoryMock: vi.fn(),
  listSessionsMock: vi.fn(() => []),
}));

vi.mock('../../src/store/session-store.js', () => ({
  listSessions: listSessionsMock,
  getSession: getSessionMock,
  upsertSession: vi.fn(),
  removeSession: vi.fn(),
}));


vi.mock('../../src/store/context-store.js', () => ({
  deleteContextObservation: deleteContextObservationMock,
  ensureContextNamespace: vi.fn(),
  LEGACY_DAEMON_LOCAL_USER_ID: 'daemon-local',
  getProcessedProjectionStats: getProcessedProjectionStatsMock,
  getProcessedProjectionById: getProcessedProjectionByIdMock,
  listMemoryProjectSummaries: listMemoryProjectSummariesMock,
  listContextNamespaces: listContextNamespacesMock,
  listContextObservations: listContextObservationsMock,
  promoteContextObservation: vi.fn(),
  queryPendingContextEvents: queryPendingContextEventsMock,
  queryProcessedProjections: queryProcessedProjectionsMock,
  recordMemoryHits: recordMemoryHitsMock,
  archiveMemory: archiveMemoryMock,
  restoreArchivedMemory: restoreArchivedMemoryMock,
  writeProcessedProjection: writeProcessedProjectionMock,
  updateProcessedProjectionSummary: updateProcessedProjectionSummaryMock,
  updateContextObservationText: updateContextObservationTextMock,
  upsertPinnedNote: upsertPinnedNoteMock,
  deleteMemory: deleteMemoryMock,
  writeContextObservation: vi.fn(),
}));

vi.mock('../../src/agent/session-manager.js', () => ({
  startProject: vi.fn(),
  stopProject: vi.fn(),
  teardownProject: vi.fn(),
  getTransportRuntime: getTransportRuntimeMock,
  launchTransportSession: vi.fn(),
  isProviderSessionBound: vi.fn(() => false),
  persistSessionRecord: vi.fn(),
  relaunchSessionWithSettings: vi.fn(),
  stopTransportRuntimeSession: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../src/agent/tmux.js', () => ({
  sendKeys: vi.fn(),
  sendKeysDelayedEnter: sendKeysDelayedEnterMock,
  sendRawInput: vi.fn(),
  resizeSession: vi.fn(),
  sendKey: vi.fn(),
  getPaneStartCommand: vi.fn(),
}));

vi.mock('../../src/router/message-router.js', () => ({
  routeMessage: vi.fn(),
}));

vi.mock('../../src/daemon/terminal-streamer.js', () => ({
  terminalStreamer: {
    subscribe: vi.fn(() => vi.fn()),
    unsubscribe: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
    requestSnapshot: vi.fn(),
    invalidateSize: vi.fn(),
  },
}));

vi.mock('../../src/daemon/timeline-emitter.js', () => ({
  timelineEmitter: {
    emit: emitMock,
    on: vi.fn(() => () => {}),
    off: vi.fn(),
    epoch: 0,
    replay: vi.fn(() => ({ events: [], truncated: false })),
  },
}));

vi.mock('../../src/daemon/timeline-store.js', () => ({
  timelineStore: {
    append: vi.fn(),
    read: vi.fn(() => []),
    clear: vi.fn(),
  },
}));

vi.mock('../../src/daemon/subsession-manager.js', () => ({
  startSubSession: vi.fn(),
  stopSubSession: vi.fn(),
  rebuildSubSessions: vi.fn(),
  detectShells: vi.fn().mockResolvedValue([]),
  readSubSessionResponse: vi.fn(),
  subSessionName: (id: string) => `deck_sub_${id}`,
}));

vi.mock('../../src/daemon/p2p-orchestrator.js', () => ({
  startP2pRun: vi.fn(),
  cancelP2pRun: vi.fn(),
  getP2pRun: vi.fn(() => undefined),
  listP2pRuns: vi.fn(() => []),
  serializeP2pRun: vi.fn(),
}));

vi.mock('../../src/daemon/repo-handler.js', () => ({
  handleRepoCommand: vi.fn(),
}));

vi.mock('../../src/daemon/file-transfer-handler.js', () => ({
  handleFileUpload: vi.fn(),
  handleFileDownload: vi.fn(),
  createProjectFileHandle: vi.fn(),
  lookupAttachment: vi.fn(() => undefined),
}));

vi.mock('../../src/daemon/preview-relay.js', () => ({
  handlePreviewCommand: vi.fn(),
}));

vi.mock('../../src/daemon/provider-sessions.js', () => ({
  listProviderSessions: vi.fn(() => []),
}));

vi.mock('../../src/util/logger.js', () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('../../src/util/imc-dir.js', () => ({
  ensureImcDir: vi.fn().mockResolvedValue('/tmp/imc'),
  imcSubDir: vi.fn((dir: string, sub: string) => `${dir}/.imc/${sub}`),
}));

vi.mock('../../src/context/memory-search.js', () => ({
  searchLocalMemorySemantic: searchLocalMemorySemanticMock,
}));

vi.mock('../../src/repo/detector.js', () => ({
  detectRepo: detectRepoMock,
  parseRemoteUrl: vi.fn((url: string) => {
    if (url === 'git@github.com:imcodes/codedeck.git') {
      return { host: 'github.com', owner: 'imcodes', repo: 'codedeck' };
    }
    return null;
  }),
}));

import { handleWebCommand } from '../../src/daemon/command-handler.js';
import { setContextModelRuntimeConfig } from '../../src/context/context-model-config.js';
import { resetAllRecentInjectionHistories } from '../../src/context/recent-injection-history.js';
import { resetMemoryFeatureConfigStoreForTests } from '../../src/store/memory-feature-config-store.js';
import { MEMORY_WS } from '../../shared/memory-ws.js';
import { MEMORY_MANAGEMENT_CONTEXT_FIELD } from '../../shared/memory-management-context.js';
import { MEMORY_MANAGEMENT_ERROR_CODES } from '../../shared/memory-management.js';

const flushAsync = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const originalFeatureEnv = {
  configPath: process.env.IMCODES_MEMORY_FEATURE_CONFIG_PATH,
  namespaceRegistry: process.env.IMCODES_MEM_FEATURE_NAMESPACE_REGISTRY,
  observationStore: process.env.IMCODES_MEM_FEATURE_OBSERVATION_STORE,
};

function restoreFeatureEnv(): void {
  if (originalFeatureEnv.configPath === undefined) delete process.env.IMCODES_MEMORY_FEATURE_CONFIG_PATH;
  else process.env.IMCODES_MEMORY_FEATURE_CONFIG_PATH = originalFeatureEnv.configPath;
  if (originalFeatureEnv.namespaceRegistry === undefined) delete process.env.IMCODES_MEM_FEATURE_NAMESPACE_REGISTRY;
  else process.env.IMCODES_MEM_FEATURE_NAMESPACE_REGISTRY = originalFeatureEnv.namespaceRegistry;
  if (originalFeatureEnv.observationStore === undefined) delete process.env.IMCODES_MEM_FEATURE_OBSERVATION_STORE;
  else process.env.IMCODES_MEM_FEATURE_OBSERVATION_STORE = originalFeatureEnv.observationStore;
  resetMemoryFeatureConfigStoreForTests();
}

describe('handleWebCommand memory context timeline', () => {
  const serverLink = {
    send: vi.fn(),
    sendBinary: vi.fn(),
    sendTimelineEvent: vi.fn(),
    daemonVersion: '0.1.0',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.IMCODES_MEMORY_FEATURE_CONFIG_PATH = join(tmpdir(), `imcodes-memory-feature-${process.pid}-${Date.now()}-${Math.random()}.json`);
    process.env.IMCODES_MEM_FEATURE_NAMESPACE_REGISTRY = 'true';
    process.env.IMCODES_MEM_FEATURE_OBSERVATION_STORE = 'true';
    resetMemoryFeatureConfigStoreForTests();
    resetAllRecentInjectionHistories();
    setContextModelRuntimeConfig(null);
    getProcessedProjectionStatsMock.mockReturnValue({
      totalRecords: 0,
      matchedRecords: 0,
      recentSummaryCount: 0,
      durableCandidateCount: 0,
      projectCount: 0,
      stagedEventCount: 0,
      dirtyTargetCount: 0,
      pendingJobCount: 0,
    });
    queryProcessedProjectionsMock.mockReturnValue([]);
    queryPendingContextEventsMock.mockReturnValue([]);
    getProcessedProjectionByIdMock.mockReturnValue(undefined);
    listContextNamespacesMock.mockReturnValue([]);
    listContextObservationsMock.mockReturnValue([]);
    deleteContextObservationMock.mockReturnValue(false);
    updateContextObservationTextMock.mockReturnValue(null);
    listMemoryProjectSummariesMock.mockReturnValue([]);
    archiveMemoryMock.mockReturnValue(false);
    restoreArchivedMemoryMock.mockReturnValue(false);
    writeProcessedProjectionMock.mockImplementation((input: any) => ({
      id: 'manual-proj',
      namespace: input.namespace,
      class: input.class,
      sourceEventIds: input.sourceEventIds,
      summary: input.summary,
      content: input.content,
      createdAt: 1,
      updatedAt: 2,
      status: 'active',
    }));
    updateProcessedProjectionSummaryMock.mockReturnValue({
      id: 'legacy-proj',
      namespace: { scope: 'personal', projectId: 'github.com/acme/repo' },
      class: 'durable_memory_candidate',
      sourceEventIds: [],
      summary: 'Updated project memory',
      content: {},
      createdAt: 1,
      updatedAt: 3,
      status: 'active',
    });
    upsertPinnedNoteMock.mockReturnValue({
      id: 'projection:legacy-proj',
      namespaceKey: 'personal::user-bob::github.com/acme/repo',
      content: 'Legacy project memory',
      origin: 'manual_pin',
      createdAt: 1,
      updatedAt: 2,
    });
    deleteMemoryMock.mockReturnValue(false);
    listSessionsMock.mockReturnValue([]);
    getSessionMock.mockReturnValue({
      name: 'deck_process_brain',
      projectName: 'codedeck',
      role: 'brain',
      agentType: 'claude-code',
      runtimeType: 'process',
      state: 'running',
    });
    emitMock.mockImplementation((sessionId: string, type: string, payload: Record<string, unknown>) => ({
      eventId: type === 'user.message' ? 'evt-user-1' : `evt-${type}`,
      sessionId,
      ts: 1000,
      seq: 1,
      epoch: 0,
      source: 'daemon',
      confidence: 'high',
      type,
      payload,
    }));
    searchLocalMemorySemanticMock.mockResolvedValue({
      items: [
        {
          id: 'mem-1',
          type: 'processed',
          projectId: 'codedeck',
          scope: 'personal',
          summary: 'Fix websocket reconnect loop',
          createdAt: 1,
          relevanceScore: 0.812,
          hitCount: 4,
          lastUsedAt: 1710000000000,
        },
      ],
      stats: {
        totalRecords: 1,
        matchedRecords: 1,
        recentSummaryCount: 1,
        durableCandidateCount: 0,
        projectCount: 1,
        stagedEventCount: 0,
        dirtyTargetCount: 0,
        pendingJobCount: 0,
      },
    });
    detectRepoMock.mockResolvedValue({
      info: { remoteUrl: 'git@github.com:imcodes/codedeck.git' },
    });
  });

  afterEach(() => {
    restoreFeatureEnv();
  });

  it('fails closed for personal memory management queries without injected management context', async () => {
    handleWebCommand({
      type: MEMORY_WS.PERSONAL_QUERY,
      requestId: 'personal-no-context',
      projectId: 'github.com/acme/repo',
    }, serverLink as any);

    await flushAsync();

    expect(getProcessedProjectionStatsMock).not.toHaveBeenCalled();
    expect(queryProcessedProjectionsMock).not.toHaveBeenCalled();
    expect(serverLink.send).toHaveBeenCalledWith(expect.objectContaining({
      type: MEMORY_WS.PERSONAL_RESPONSE,
      requestId: 'personal-no-context',
      records: [],
      pendingRecords: [],
      errorCode: MEMORY_MANAGEMENT_ERROR_CODES.MANAGEMENT_REQUEST_UNROUTED,
      stats: expect.objectContaining({
        totalRecords: 0,
        matchedRecords: 0,
        pendingJobCount: 0,
      }),
    }));
  });

  it('authorizes project resolution by realpath so cwd aliases do not leave the selector without a canonical id', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'imcodes-project-resolve-'));
    const realProjectDir = join(tempDir, 'repo');
    const aliasProjectDir = join(tempDir, 'repo-link');
    await mkdir(realProjectDir);
    await symlink(realProjectDir, aliasProjectDir);
    listSessionsMock.mockReturnValue([{ name: 'deck_repo_brain', projectDir: aliasProjectDir }]);

    try {
      handleWebCommand({
        type: MEMORY_WS.PROJECT_RESOLVE,
        requestId: 'resolve-realpath',
        projectDir: realProjectDir,
        [MEMORY_MANAGEMENT_CONTEXT_FIELD]: {
          actorId: 'user-bob',
          userId: 'user-bob',
          role: 'user',
          source: 'server_bridge',
          requestId: 'resolve-realpath',
          boundProjects: [{ projectDir: realProjectDir }],
        },
      }, serverLink as any);

      await vi.waitFor(() => {
        expect(detectRepoMock).toHaveBeenCalledWith(realProjectDir);
        expect(serverLink.send).toHaveBeenCalledWith(expect.objectContaining({
          type: MEMORY_WS.PROJECT_RESOLVE_RESPONSE,
          requestId: 'resolve-realpath',
          success: true,
          status: 'resolved',
          canonicalRepoId: 'github.com/imcodes/codedeck',
        }));
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('filters personal memory management list, stats, and pending records by derived user id', async () => {
    getProcessedProjectionStatsMock.mockReturnValue({
      totalRecords: 1,
      matchedRecords: 1,
      recentSummaryCount: 1,
      durableCandidateCount: 0,
      projectCount: 1,
      stagedEventCount: 1,
      dirtyTargetCount: 1,
      pendingJobCount: 1,
    });
    queryProcessedProjectionsMock.mockReturnValue([{
      id: 'bob-proj',
      namespace: { scope: 'personal', projectId: 'github.com/acme/repo', userId: 'user-bob' },
      class: 'recent_summary',
      sourceEventIds: ['evt-bob'],
      summary: 'Bob private project memory',
      content: { createdByUserId: 'user-bob', updatedByUserId: 'user-bob' },
      createdAt: 100,
      updatedAt: 200,
      hitCount: 2,
      lastUsedAt: 150,
      status: 'active',
    }]);
    queryPendingContextEventsMock.mockReturnValue([{
      id: 'pending-bob',
      projectId: 'github.com/acme/repo',
      eventType: 'user.turn',
      content: 'pending private event',
      createdAt: 123,
    }]);
    listMemoryProjectSummariesMock.mockReturnValue([{
      projectId: 'github.com/acme/repo',
      displayName: 'acme/repo',
      totalRecords: 1,
      recentSummaryCount: 1,
      durableCandidateCount: 0,
      pendingEventCount: 1,
      updatedAt: 200,
    }]);

    handleWebCommand({
      type: MEMORY_WS.PERSONAL_QUERY,
      requestId: 'personal-list',
      projectId: 'github.com/acme/repo',
      [MEMORY_MANAGEMENT_CONTEXT_FIELD]: {
        actorId: 'user-bob',
        userId: 'user-bob',
        role: 'user',
        source: 'server_bridge',
        requestId: 'personal-list',
        boundProjects: [{ canonicalRepoId: 'github.com/acme/repo' }],
      },
    }, serverLink as any);

    await flushAsync();

    expect(getProcessedProjectionStatsMock).toHaveBeenCalledWith(expect.objectContaining({
      scope: 'personal',
      userId: 'user-bob',
      projectId: 'github.com/acme/repo',
    }));
    expect(queryProcessedProjectionsMock).toHaveBeenCalledWith(expect.objectContaining({
      scope: 'personal',
      userId: 'user-bob',
      projectId: 'github.com/acme/repo',
      limit: 20,
    }));
    expect(queryPendingContextEventsMock).toHaveBeenCalledWith(expect.objectContaining({
      scope: 'personal',
      userId: 'user-bob',
      projectId: 'github.com/acme/repo',
      limit: 20,
    }));
    expect(listMemoryProjectSummariesMock).toHaveBeenCalledWith(expect.objectContaining({
      scope: 'personal',
      userId: 'user-bob',
      projectId: 'github.com/acme/repo',
      includeLegacyPersonalOwner: true,
    }));
    expect(serverLink.send).toHaveBeenCalledWith(expect.objectContaining({
      type: MEMORY_WS.PERSONAL_RESPONSE,
      requestId: 'personal-list',
      records: [expect.objectContaining({
        id: 'bob-proj',
        summary: 'Bob private project memory',
        ownerUserId: 'user-bob',
        createdByUserId: 'user-bob',
        updatedByUserId: 'user-bob',
      })],
      pendingRecords: [expect.objectContaining({ id: 'pending-bob' })],
      projects: [expect.objectContaining({ projectId: 'github.com/acme/repo' })],
    }));
  });

  it('enables explicit legacy local-owner compatibility for personal memory management reads', async () => {
    handleWebCommand({
      type: MEMORY_WS.PERSONAL_QUERY,
      requestId: 'legacy-personal-list',
      canonicalRepoId: 'github.com/acme/repo',
      [MEMORY_MANAGEMENT_CONTEXT_FIELD]: {
        actorId: 'user-bob',
        userId: 'user-bob',
        role: 'user',
        source: 'server_bridge',
        requestId: 'legacy-personal-list',
        boundProjects: [{ canonicalRepoId: 'github.com/acme/repo' }],
      },
    }, serverLink as any);

    await flushAsync();

    expect(getProcessedProjectionStatsMock).toHaveBeenCalledWith(expect.objectContaining({
      scope: 'personal',
      userId: 'user-bob',
      projectId: 'github.com/acme/repo',
      includeLegacyPersonalOwner: true,
    }));
    expect(queryProcessedProjectionsMock).toHaveBeenCalledWith(expect.objectContaining({
      scope: 'personal',
      userId: 'user-bob',
      projectId: 'github.com/acme/repo',
      includeLegacyPersonalOwner: true,
    }));
    expect(queryPendingContextEventsMock).toHaveBeenCalledWith(expect.objectContaining({
      scope: 'personal',
      userId: 'user-bob',
      projectId: 'github.com/acme/repo',
      includeLegacyPersonalOwner: true,
    }));
  });

  it('allows management actions on visible legacy personal rows in the bound project', async () => {
    getProcessedProjectionByIdMock.mockReturnValue({
      id: 'legacy-proj',
      namespace: { scope: 'personal', projectId: 'github.com/acme/repo' },
      class: 'recent_summary',
      sourceEventIds: ['evt-legacy'],
      summary: 'Legacy project memory',
      content: {},
      createdAt: 1,
      updatedAt: 2,
      status: 'active',
    });
    archiveMemoryMock.mockReturnValue(true);

    handleWebCommand({
      type: MEMORY_WS.ARCHIVE,
      requestId: 'archive-legacy',
      id: 'legacy-proj',
      canonicalRepoId: 'github.com/acme/repo',
      [MEMORY_MANAGEMENT_CONTEXT_FIELD]: {
        actorId: 'user-bob',
        userId: 'user-bob',
        role: 'user',
        source: 'server_bridge',
        requestId: 'archive-legacy',
        boundProjects: [{ canonicalRepoId: 'github.com/acme/repo' }],
      },
    }, serverLink as any);

    await flushAsync();

    expect(archiveMemoryMock).toHaveBeenCalledWith('legacy-proj');
    expect(serverLink.send).toHaveBeenCalledWith(expect.objectContaining({
      type: MEMORY_WS.ARCHIVE_RESPONSE,
      requestId: 'archive-legacy',
      success: true,
    }));
  });

  it('allows explicit manual create, edit, and pin for visible project personal memory', async () => {
    getProcessedProjectionByIdMock.mockReturnValue({
      id: 'legacy-proj',
      namespace: { scope: 'personal', projectId: 'github.com/acme/repo' },
      class: 'durable_memory_candidate',
      sourceEventIds: ['evt-legacy'],
      summary: 'Legacy project memory',
      content: {},
      createdAt: 1,
      updatedAt: 2,
      status: 'active',
    });

    const context = {
      actorId: 'user-bob',
      userId: 'user-bob',
      role: 'user',
      source: 'server_bridge',
      boundProjects: [{ canonicalRepoId: 'github.com/acme/repo' }],
    };

    handleWebCommand({
      type: MEMORY_WS.CREATE,
      requestId: 'create-memory',
      canonicalRepoId: 'github.com/acme/repo',
      text: 'Remember to run focused tests.',
      [MEMORY_MANAGEMENT_CONTEXT_FIELD]: { ...context, requestId: 'create-memory' },
    }, serverLink as any);
    await flushAsync();

    expect(writeProcessedProjectionMock).toHaveBeenCalledWith(expect.objectContaining({
      namespace: { scope: 'personal', projectId: 'github.com/acme/repo', userId: 'user-bob' },
      class: 'durable_memory_candidate',
      summary: 'Remember to run focused tests.',
      origin: 'user_note',
      content: expect.objectContaining({
        ownerUserId: 'user-bob',
        createdByUserId: 'user-bob',
        updatedByUserId: 'user-bob',
      }),
    }));
    expect(serverLink.send).toHaveBeenCalledWith(expect.objectContaining({
      type: MEMORY_WS.CREATE_RESPONSE,
      requestId: 'create-memory',
      success: true,
      id: 'manual-proj',
    }));

    handleWebCommand({
      type: MEMORY_WS.UPDATE,
      requestId: 'update-memory',
      id: 'legacy-proj',
      canonicalRepoId: 'github.com/acme/repo',
      text: 'Updated project memory',
      [MEMORY_MANAGEMENT_CONTEXT_FIELD]: { ...context, requestId: 'update-memory' },
    }, serverLink as any);
    await flushAsync();

    expect(updateProcessedProjectionSummaryMock).toHaveBeenCalledWith(expect.objectContaining({
      projectionId: 'legacy-proj',
      summary: 'Updated project memory',
      ownerUserId: 'user-bob',
      createdByUserId: 'user-bob',
      updatedByUserId: 'user-bob',
    }));
    expect(serverLink.send).toHaveBeenCalledWith(expect.objectContaining({
      type: MEMORY_WS.UPDATE_RESPONSE,
      requestId: 'update-memory',
      success: true,
      id: 'legacy-proj',
    }));

    handleWebCommand({
      type: MEMORY_WS.PIN,
      requestId: 'pin-memory',
      id: 'legacy-proj',
      canonicalRepoId: 'github.com/acme/repo',
      [MEMORY_MANAGEMENT_CONTEXT_FIELD]: { ...context, requestId: 'pin-memory' },
    }, serverLink as any);
    await flushAsync();

    expect(upsertPinnedNoteMock).toHaveBeenCalledWith(expect.objectContaining({
      id: 'projection:legacy-proj',
      content: 'Legacy project memory',
      origin: 'manual_pin',
    }));
    expect(serverLink.send).toHaveBeenCalledWith(expect.objectContaining({
      type: MEMORY_WS.PIN_RESPONSE,
      requestId: 'pin-memory',
      success: true,
      id: 'projection:legacy-proj',
    }));
  });

  it('rejects management actions on another real user personal rows', async () => {
    getProcessedProjectionByIdMock.mockReturnValue({
      id: 'alice-proj',
      namespace: { scope: 'personal', projectId: 'github.com/acme/repo', userId: 'user-alice' },
      class: 'recent_summary',
      sourceEventIds: ['evt-alice'],
      summary: 'Alice project memory',
      content: {},
      createdAt: 1,
      updatedAt: 2,
      status: 'active',
    });

    handleWebCommand({
      type: MEMORY_WS.DELETE,
      requestId: 'delete-alice',
      id: 'alice-proj',
      canonicalRepoId: 'github.com/acme/repo',
      [MEMORY_MANAGEMENT_CONTEXT_FIELD]: {
        actorId: 'user-bob',
        userId: 'user-bob',
        role: 'user',
        source: 'server_bridge',
        requestId: 'delete-alice',
        boundProjects: [{ canonicalRepoId: 'github.com/acme/repo' }],
      },
    }, serverLink as any);

    await flushAsync();

    expect(deleteMemoryMock).not.toHaveBeenCalled();
    expect(serverLink.send).toHaveBeenCalledWith(expect.objectContaining({
      type: MEMORY_WS.DELETE_RESPONSE,
      requestId: 'delete-alice',
      success: false,
      errorCode: MEMORY_MANAGEMENT_ERROR_CODES.OBSERVATION_QUERY_FORBIDDEN,
    }));
  });

  it('distinguishes record creator ownership from admin role for shared memory mutations', async () => {
    getProcessedProjectionByIdMock.mockReturnValue({
      id: 'shared-proj',
      namespace: { scope: 'project_shared', projectId: 'github.com/acme/repo' },
      class: 'durable_memory_candidate',
      sourceEventIds: ['evt-shared'],
      summary: 'Shared project convention',
      content: { createdByUserId: 'user-bob', ownerUserId: 'user-bob' },
      createdAt: 1,
      updatedAt: 2,
      status: 'active',
    });
    archiveMemoryMock.mockReturnValue(true);

    handleWebCommand({
      type: MEMORY_WS.ARCHIVE,
      requestId: 'archive-own-shared',
      id: 'shared-proj',
      canonicalRepoId: 'github.com/acme/repo',
      [MEMORY_MANAGEMENT_CONTEXT_FIELD]: {
        actorId: 'user-bob',
        userId: 'user-bob',
        role: 'user',
        source: 'server_bridge',
        requestId: 'archive-own-shared',
        boundProjects: [{ canonicalRepoId: 'github.com/acme/repo' }],
      },
    }, serverLink as any);

    await flushAsync();

    expect(archiveMemoryMock).toHaveBeenCalledWith('shared-proj');
    expect(serverLink.send).toHaveBeenCalledWith(expect.objectContaining({
      type: MEMORY_WS.ARCHIVE_RESPONSE,
      requestId: 'archive-own-shared',
      success: true,
    }));

    archiveMemoryMock.mockClear();
    handleWebCommand({
      type: MEMORY_WS.ARCHIVE,
      requestId: 'archive-other-shared',
      id: 'shared-proj',
      canonicalRepoId: 'github.com/acme/repo',
      [MEMORY_MANAGEMENT_CONTEXT_FIELD]: {
        actorId: 'user-alice',
        userId: 'user-alice',
        role: 'user',
        source: 'server_bridge',
        requestId: 'archive-other-shared',
        boundProjects: [{ canonicalRepoId: 'github.com/acme/repo' }],
      },
    }, serverLink as any);

    await flushAsync();

    expect(archiveMemoryMock).not.toHaveBeenCalled();
    expect(serverLink.send).toHaveBeenCalledWith(expect.objectContaining({
      type: MEMORY_WS.ARCHIVE_RESPONSE,
      requestId: 'archive-other-shared',
      success: false,
      errorCode: MEMORY_MANAGEMENT_ERROR_CODES.OBSERVATION_QUERY_FORBIDDEN,
    }));
  });

  it('does not authorize shared memory mutations from display-only legacy user metadata', async () => {
    getProcessedProjectionByIdMock.mockReturnValue({
      id: 'shared-legacy-forged',
      namespace: { scope: 'project_shared', projectId: 'github.com/acme/repo' },
      class: 'durable_memory_candidate',
      sourceEventIds: ['evt-shared'],
      summary: 'Shared project convention',
      content: { userId: 'user-bob', createdBy: 'user-bob', authorUserId: 'user-bob' },
      createdAt: 1,
      updatedAt: 2,
      status: 'active',
    });

    handleWebCommand({
      type: MEMORY_WS.ARCHIVE,
      requestId: 'archive-forged-legacy-metadata',
      id: 'shared-legacy-forged',
      canonicalRepoId: 'github.com/acme/repo',
      [MEMORY_MANAGEMENT_CONTEXT_FIELD]: {
        actorId: 'user-bob',
        userId: 'user-bob',
        role: 'user',
        source: 'server_bridge',
        requestId: 'archive-forged-legacy-metadata',
        boundProjects: [{ canonicalRepoId: 'github.com/acme/repo' }],
      },
    }, serverLink as any);

    await flushAsync();

    expect(archiveMemoryMock).not.toHaveBeenCalled();
    expect(serverLink.send).toHaveBeenCalledWith(expect.objectContaining({
      type: MEMORY_WS.ARCHIVE_RESPONSE,
      requestId: 'archive-forged-legacy-metadata',
      success: false,
      errorCode: MEMORY_MANAGEMENT_ERROR_CODES.OBSERVATION_QUERY_FORBIDDEN,
    }));
  });

  it('fails closed for processed memory mutations when the observation store feature is disabled', async () => {
    process.env.IMCODES_MEM_FEATURE_OBSERVATION_STORE = 'false';
    resetMemoryFeatureConfigStoreForTests();

    const baseContext = {
      actorId: 'user-bob',
      userId: 'user-bob',
      role: 'user',
      source: 'server_bridge',
      boundProjects: [{ canonicalRepoId: 'github.com/acme/repo' }],
    };
    const cases = [
      { requestType: MEMORY_WS.ARCHIVE, responseType: MEMORY_WS.ARCHIVE_RESPONSE, requestId: 'archive-feature-disabled', extra: { id: 'projection-1' } },
      { requestType: MEMORY_WS.RESTORE, responseType: MEMORY_WS.RESTORE_RESPONSE, requestId: 'restore-feature-disabled', extra: { id: 'projection-1' } },
      { requestType: MEMORY_WS.CREATE, responseType: MEMORY_WS.CREATE_RESPONSE, requestId: 'create-feature-disabled', extra: { canonicalRepoId: 'github.com/acme/repo', text: 'This write must not persist while disabled.' } },
      { requestType: MEMORY_WS.UPDATE, responseType: MEMORY_WS.UPDATE_RESPONSE, requestId: 'update-feature-disabled', extra: { id: 'projection-1', text: 'Updated text' } },
      { requestType: MEMORY_WS.PIN, responseType: MEMORY_WS.PIN_RESPONSE, requestId: 'pin-feature-disabled', extra: { id: 'projection-1' } },
      { requestType: MEMORY_WS.DELETE, responseType: MEMORY_WS.DELETE_RESPONSE, requestId: 'delete-feature-disabled', extra: { id: 'projection-1' } },
    ];

    for (const testCase of cases) {
      serverLink.send.mockClear();
      handleWebCommand({
        type: testCase.requestType,
        requestId: testCase.requestId,
        ...testCase.extra,
        [MEMORY_MANAGEMENT_CONTEXT_FIELD]: { ...baseContext, requestId: testCase.requestId },
      }, serverLink as any);

      await flushAsync();

      expect(serverLink.send).toHaveBeenCalledWith(expect.objectContaining({
        type: testCase.responseType,
        requestId: testCase.requestId,
        success: false,
        errorCode: MEMORY_MANAGEMENT_ERROR_CODES.FEATURE_DISABLED,
      }));
    }
    expect(archiveMemoryMock).not.toHaveBeenCalled();
    expect(restoreArchivedMemoryMock).not.toHaveBeenCalled();
    expect(writeProcessedProjectionMock).not.toHaveBeenCalled();
    expect(updateProcessedProjectionSummaryMock).not.toHaveBeenCalled();
    expect(upsertPinnedNoteMock).not.toHaveBeenCalled();
    expect(deleteMemoryMock).not.toHaveBeenCalled();
  });

  it('requires an authorized canonical project binding before manual memory creation', async () => {
    handleWebCommand({
      type: MEMORY_WS.CREATE,
      requestId: 'create-unbound-project',
      canonicalRepoId: 'github.com/acme/repo',
      text: 'This project must be authorized first.',
      [MEMORY_MANAGEMENT_CONTEXT_FIELD]: {
        actorId: 'user-bob',
        userId: 'user-bob',
        role: 'user',
        source: 'server_bridge',
        requestId: 'create-unbound-project',
        boundProjects: [],
      },
    }, serverLink as any);

    await flushAsync();

    expect(writeProcessedProjectionMock).not.toHaveBeenCalled();
    expect(serverLink.send).toHaveBeenCalledWith(expect.objectContaining({
      type: MEMORY_WS.CREATE_RESPONSE,
      requestId: 'create-unbound-project',
      success: false,
      errorCode: MEMORY_MANAGEMENT_ERROR_CODES.OBSERVATION_QUERY_FORBIDDEN,
    }));
  });

  it('deletes observations without cascading to the linked processed projection', async () => {
    listContextNamespacesMock.mockReturnValue([{
      id: 'ns-personal',
      scope: 'personal',
      userId: 'user-bob',
      projectId: 'github.com/acme/repo',
      key: 'personal::user-bob::github.com/acme/repo',
      visibility: 'private',
      createdAt: 1,
      updatedAt: 2,
    }]);
    listContextObservationsMock.mockReturnValue([{
      id: 'obs-linked',
      namespaceId: 'ns-personal',
      scope: 'personal',
      class: 'note',
      origin: 'user_note',
      fingerprint: 'fp-linked',
      content: { text: 'Linked note', ownerUserId: 'user-bob' },
      textHash: 'hash-linked',
      sourceEventIds: ['evt-linked'],
      projectionId: 'projection-linked',
      state: 'active',
      confidence: 1,
      createdAt: 1,
      updatedAt: 2,
    }]);
    deleteContextObservationMock.mockReturnValue(true);

    handleWebCommand({
      type: MEMORY_WS.OBSERVATION_DELETE,
      requestId: 'delete-observation-only',
      id: 'obs-linked',
      expectedFromScope: 'personal',
      [MEMORY_MANAGEMENT_CONTEXT_FIELD]: {
        actorId: 'user-bob',
        userId: 'user-bob',
        role: 'user',
        source: 'server_bridge',
        requestId: 'delete-observation-only',
        boundProjects: [{ canonicalRepoId: 'github.com/acme/repo' }],
      },
    }, serverLink as any);

    await flushAsync();

    expect(deleteMemoryMock).not.toHaveBeenCalled();
    expect(deleteContextObservationMock).toHaveBeenCalledWith('obs-linked');
    expect(serverLink.send).toHaveBeenCalledWith(expect.objectContaining({
      type: MEMORY_WS.OBSERVATION_DELETE_RESPONSE,
      requestId: 'delete-observation-only',
      success: true,
    }));
  });

  it('returns typed errors for missing and stale-scope observation promotion', async () => {
    handleWebCommand({
      type: MEMORY_WS.OBSERVATION_PROMOTE,
      requestId: 'promote-missing',
      id: 'missing-observation',
      toScope: 'project_shared',
      expectedFromScope: 'personal',
      [MEMORY_MANAGEMENT_CONTEXT_FIELD]: {
        actorId: 'user-bob',
        userId: 'user-bob',
        role: 'workspace_admin',
        source: 'server_bridge',
        requestId: 'promote-missing',
        boundProjects: [{ canonicalRepoId: 'github.com/acme/repo' }],
      },
    }, serverLink as any);

    await flushAsync();

    expect(serverLink.send).toHaveBeenCalledWith(expect.objectContaining({
      type: MEMORY_WS.OBSERVATION_PROMOTE_RESPONSE,
      requestId: 'promote-missing',
      success: false,
      errorCode: MEMORY_MANAGEMENT_ERROR_CODES.OBSERVATION_NOT_FOUND,
    }));

    serverLink.send.mockClear();
    listContextNamespacesMock.mockReturnValue([{
      id: 'ns-personal',
      scope: 'personal',
      userId: 'user-bob',
      projectId: 'github.com/acme/repo',
      key: 'personal::user-bob::github.com/acme/repo',
      visibility: 'private',
      createdAt: 1,
      updatedAt: 2,
    }]);
    listContextObservationsMock.mockReturnValue([{
      id: 'obs-stale',
      namespaceId: 'ns-personal',
      scope: 'personal',
      class: 'note',
      origin: 'user_note',
      fingerprint: 'fp-stale',
      content: { text: 'Stale note', ownerUserId: 'user-bob' },
      textHash: 'hash-stale',
      sourceEventIds: ['evt-stale'],
      state: 'active',
      confidence: 1,
      createdAt: 1,
      updatedAt: 2,
    }]);

    handleWebCommand({
      type: MEMORY_WS.OBSERVATION_PROMOTE,
      requestId: 'promote-stale',
      id: 'obs-stale',
      toScope: 'project_shared',
      expectedFromScope: 'project_shared',
      [MEMORY_MANAGEMENT_CONTEXT_FIELD]: {
        actorId: 'user-bob',
        userId: 'user-bob',
        role: 'workspace_admin',
        source: 'server_bridge',
        requestId: 'promote-stale',
        boundProjects: [{ canonicalRepoId: 'github.com/acme/repo' }],
      },
    }, serverLink as any);

    await flushAsync();

    expect(serverLink.send).toHaveBeenCalledWith(expect.objectContaining({
      type: MEMORY_WS.OBSERVATION_PROMOTE_RESPONSE,
      requestId: 'promote-stale',
      success: false,
      errorCode: MEMORY_MANAGEMENT_ERROR_CODES.OBSERVATION_FROM_SCOPE_MISMATCH,
    }));
  });

  it('passes derived owner and personal scope into semantic personal memory management queries', async () => {
    searchLocalMemorySemanticMock.mockResolvedValueOnce({
      items: [
        {
          id: 'bob-personal',
          type: 'processed',
          scope: 'personal',
          userId: 'user-bob',
          projectId: 'github.com/acme/repo',
          summary: 'Bob matching memory',
          projectionClass: 'recent_summary',
          createdAt: 1,
          updatedAt: 2,
        },
        {
          id: 'alice-personal',
          type: 'processed',
          scope: 'personal',
          userId: 'user-alice',
          projectId: 'github.com/acme/repo',
          summary: 'Alice must not leak',
          projectionClass: 'recent_summary',
          createdAt: 1,
          updatedAt: 2,
        },
        {
          id: 'bob-shared',
          type: 'processed',
          scope: 'project_shared',
          userId: 'user-bob',
          projectId: 'github.com/acme/repo',
          summary: 'Shared must not appear in personal response',
          projectionClass: 'recent_summary',
          createdAt: 1,
          updatedAt: 2,
        },
      ],
      stats: {
        totalRecords: 3,
        matchedRecords: 3,
        recentSummaryCount: 3,
        durableCandidateCount: 0,
        projectCount: 1,
        stagedEventCount: 0,
        dirtyTargetCount: 0,
        pendingJobCount: 0,
      },
    });

    handleWebCommand({
      type: MEMORY_WS.PERSONAL_QUERY,
      requestId: 'personal-search',
      canonicalRepoId: 'github.com/acme/repo',
      query: 'matching',
      [MEMORY_MANAGEMENT_CONTEXT_FIELD]: {
        actorId: 'user-bob',
        userId: 'user-bob',
        role: 'user',
        source: 'server_bridge',
        requestId: 'personal-search',
        boundProjects: [{ canonicalRepoId: 'github.com/acme/repo' }],
      },
    }, serverLink as any);

    await flushAsync();

    expect(searchLocalMemorySemanticMock).toHaveBeenCalledWith(expect.objectContaining({
      query: 'matching',
      scope: 'personal',
      userId: 'user-bob',
      repo: 'github.com/acme/repo',
      limit: 20,
    }));
    expect(serverLink.send).toHaveBeenCalledWith(expect.objectContaining({
      type: MEMORY_WS.PERSONAL_RESPONSE,
      requestId: 'personal-search',
      records: [expect.objectContaining({ id: 'bob-personal', summary: 'Bob matching memory' })],
    }));
    const response = serverLink.send.mock.calls.find((call) => call[0]?.type === MEMORY_WS.PERSONAL_RESPONSE)?.[0] as { records?: unknown[] } | undefined;
    expect(response?.records).toHaveLength(1);
  });

  it('emits a linked memory.context event for injected related history', async () => {
    handleWebCommand({
      type: 'session.send',
      session: 'deck_process_brain',
      text: 'Fix reconnect issues in websocket client',
      commandId: 'cmd-memory',
    }, serverLink as any);

    await flushAsync();

    expect(sendKeysDelayedEnterMock).toHaveBeenCalledWith(
      'deck_process_brain',
      expect.stringContaining('[Related past work]'),
      undefined,
    );
    expect(emitMock).toHaveBeenCalledWith(
      'deck_process_brain',
      'memory.context',
      expect.objectContaining({
        relatedToEventId: 'evt-user-1',
        query: 'Fix reconnect issues in websocket client',
        injectedText: '[Related past work]\n<related-past-work advisory="true">\n- [codedeck] Fix websocket reconnect loop\n</related-past-work>',
        items: [
          expect.objectContaining({
            id: 'mem-1',
            projectId: 'codedeck',
            relevanceScore: 0.812,
            hitCount: 4,
            scope: 'personal',
          }),
        ],
      }),
    );
    expect(recordMemoryHitsMock).toHaveBeenCalledWith(['mem-1']);
    expect(recordMemoryHitsMock.mock.invocationCallOrder[0]).toBeGreaterThan(sendKeysDelayedEnterMock.mock.invocationCallOrder[0]);
  });

  it('REGRESSION GUARD: process recall queries must use canonical repo identity instead of projectName and this test must not be deleted', async () => {
    getSessionMock.mockReturnValue({
      name: 'deck_process_brain',
      projectName: 'friendly-name',
      projectDir: '/worktrees/codedeck',
      role: 'brain',
      agentType: 'claude-code',
      runtimeType: 'process',
      state: 'running',
    });

    handleWebCommand({
      type: 'session.send',
      session: 'deck_process_brain',
      text: 'Fix reconnect issues in websocket client',
      commandId: 'cmd-memory-canonical',
    }, serverLink as any);

    await flushAsync();
    await flushAsync();

    expect(detectRepoMock).toHaveBeenCalledWith('/worktrees/codedeck');
    expect(searchLocalMemorySemanticMock).toHaveBeenCalledWith(expect.objectContaining({
      query: 'Fix reconnect issues in websocket client',
      namespace: { scope: 'personal', projectId: 'github.com/imcodes/codedeck' },
      repo: 'github.com/imcodes/codedeck',
      limit: 10,
    }));
    expect(searchLocalMemorySemanticMock).not.toHaveBeenCalledWith(expect.objectContaining({
      repo: 'friendly-name',
    }));
  });

  it('applies the configured recall threshold when deciding whether to inject related history', async () => {
    setContextModelRuntimeConfig({
      primaryContextBackend: 'claude-code-sdk',
      primaryContextModel: 'sonnet',
      memoryRecallMinScore: 0.4,
    });
    searchLocalMemorySemanticMock.mockResolvedValue({
      items: [
        {
          id: 'mem-threshold',
          type: 'processed',
          projectId: 'codedeck',
          scope: 'personal',
          summary: 'Mid-threshold multilingual semantic match',
          createdAt: 1,
          relevanceScore: 0.4446,
        },
      ],
      stats: {
        totalRecords: 1,
        matchedRecords: 1,
        recentSummaryCount: 1,
        durableCandidateCount: 0,
        projectCount: 1,
        stagedEventCount: 0,
        dirtyTargetCount: 0,
        pendingJobCount: 0,
      },
    });

    handleWebCommand({
      type: 'session.send',
      session: 'deck_process_brain',
      text: '我感觉现在发的消息都没有相关历史recall了, 就像这句话 你自己测试下 不可能没有!',
      commandId: 'cmd-memory-threshold',
    }, serverLink as any);

    await flushAsync();

    expect(sendKeysDelayedEnterMock).toHaveBeenCalledWith(
      'deck_process_brain',
      expect.stringContaining('[Related past work]'),
      undefined,
    );
    expect(recordMemoryHitsMock).toHaveBeenCalledWith(['mem-threshold']);
  });

  it('does not increment recall hits when the process send fails before the linked memory card is emitted', async () => {
    sendKeysDelayedEnterMock.mockRejectedValueOnce(new Error('tmux failed'));

    handleWebCommand({
      type: 'session.send',
      session: 'deck_process_brain',
      text: 'Fix reconnect issues in websocket client',
      commandId: 'cmd-memory-fail',
    }, serverLink as any);

    await flushAsync();

    expect(recordMemoryHitsMock).not.toHaveBeenCalled();
    expect(emitMock).not.toHaveBeenCalledWith(
      'deck_process_brain',
      'memory.context',
      expect.anything(),
    );
  });

  it('emits a no-matches status when no related process memory is found', async () => {
    searchLocalMemorySemanticMock.mockResolvedValue({
      items: [],
      stats: {
        totalRecords: 0,
        matchedRecords: 0,
        recentSummaryCount: 0,
        durableCandidateCount: 0,
        projectCount: 0,
        stagedEventCount: 0,
        dirtyTargetCount: 0,
        pendingJobCount: 0,
      },
    });

    handleWebCommand({
      type: 'session.send',
      session: 'deck_process_brain',
      text: 'Investigate websocket reconnect behavior',
      commandId: 'cmd-memory-none',
    }, serverLink as any);

    await flushAsync();

    expect(sendKeysDelayedEnterMock).toHaveBeenCalledWith(
      'deck_process_brain',
      'Investigate websocket reconnect behavior',
      undefined,
    );
    expect(emitMock).toHaveBeenCalledWith(
      'deck_process_brain',
      'memory.context',
      expect.objectContaining({
        relatedToEventId: 'evt-user-1',
        query: 'Investigate websocket reconnect behavior',
        status: 'no_matches',
        items: [],
      }),
    );
    expect(recordMemoryHitsMock).not.toHaveBeenCalled();
  });

  it('emits a recently-injected status when matches were found but all were filtered by recency', async () => {
    handleWebCommand({
      type: 'session.send',
      session: 'deck_process_brain',
      text: 'Fix reconnect issues in websocket client',
      commandId: 'cmd-memory-first',
    }, serverLink as any);
    await flushAsync();

    emitMock.mockClear();
    recordMemoryHitsMock.mockClear();

    handleWebCommand({
      type: 'session.send',
      session: 'deck_process_brain',
      text: 'Fix reconnect issues in websocket client',
      commandId: 'cmd-memory-second',
    }, serverLink as any);
    await flushAsync();

    expect(emitMock).toHaveBeenCalledWith(
      'deck_process_brain',
      'memory.context',
      expect.objectContaining({
        relatedToEventId: 'evt-user-1',
        query: 'Fix reconnect issues in websocket client',
        status: 'deduped_recently',
        matchedCount: 1,
        dedupedCount: 1,
        items: [],
      }),
    );
    expect(recordMemoryHitsMock).not.toHaveBeenCalled();
  });

  it('emits a template-prompt skip status for built-in workflow prompts', async () => {
    handleWebCommand({
      type: 'session.send',
      session: 'deck_process_brain',
      // Workflow phrase triggers the skip; bare @openspec/changes refs alone would not.
      text: 'Drive the implementation of @openspec/changes/shared-agent-context aggressively.',
      commandId: 'cmd-memory-template',
    }, serverLink as any);

    await flushAsync();

    expect(searchLocalMemorySemanticMock).not.toHaveBeenCalled();
    expect(emitMock).toHaveBeenCalledWith(
      'deck_process_brain',
      'memory.context',
      expect.objectContaining({
        relatedToEventId: 'evt-user-1',
        status: 'skipped_template_prompt',
        items: [],
      }),
    );
  });

  it('skips recall for imperative command prompts (commit&push, redeploy, etc.)', async () => {
    // User-reported regression: short ops directives passed the <10-char
    // filter and triggered irrelevant semantic recalls over the current
    // task's own logs.
    handleWebCommand({
      type: 'session.send',
      session: 'deck_process_brain',
      text: 'commit&push',
      commandId: 'cmd-memory-imperative',
    }, serverLink as any);

    await flushAsync();

    expect(searchLocalMemorySemanticMock).not.toHaveBeenCalled();
    expect(emitMock).toHaveBeenCalledWith(
      'deck_process_brain',
      'memory.context',
      expect.objectContaining({
        relatedToEventId: 'evt-user-1',
        status: 'skipped_control_message',
        items: [],
      }),
    );
  });
});
