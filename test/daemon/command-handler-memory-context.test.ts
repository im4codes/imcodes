import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

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
  recallClientControl,
  collectRecentSummarySyncCandidatesMock,
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
  // Controls the fake context-store client's production-owner mode. Default
  // false → the recall façades take the in-process fallback (this suite's
  // existing expectations). One test flips it true to exercise the owner-mode
  // bounded-empty path (no in-process recall).
  recallClientControl: { isProductionOwner: false },
  collectRecentSummarySyncCandidatesMock: vi.fn(),
}));

vi.mock('../../src/store/session-store.js', () => ({
  listSessions: listSessionsMock,
  getSession: getSessionMock,
  upsertSession: vi.fn(),
  removeSession: vi.fn(),
}));


// Spread the real module so the worker-client's in-process cold fallback
// (`buildContextStoreOpHandlers`, which the command handlers now reach via
// `getContextStoreClient().run(...)` when no worker is spawned) can resolve
// every allowlisted L1 op export. The asserted store functions remain mock
// spies; only they are dispatched by the ops these tests exercise.
vi.mock('../../src/store/context-store.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/store/context-store.js')>()),
  deleteContextObservation: deleteContextObservationMock,
  ensureContextNamespace: vi.fn(),
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

// Route the command handlers' context-store client through the in-process
// op-handler map (the bounded cold fallback) instead of spawning a real
// worker thread. `run` already cold-falls-back this way; this also makes
// `fireAndForget` (e.g. recordMemoryHits) dispatch in-process so it reaches
// the mocked store spies these tests assert on, rather than a separate
// worker-thread module graph the mocks don't touch.
vi.mock('../../src/store/context-store-worker-client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/store/context-store-worker-client.js')>();
  const { buildContextStoreOpHandlers } = await import('../../src/store/context-store-op-handlers.js');
  let handlers: Map<string, (args: unknown[]) => unknown> | null = null;
  const dispatch = (op: string, args: unknown[] = []): unknown => {
    if (!handlers) handlers = buildContextStoreOpHandlers().handlers;
    const handler = handlers.get(op);
    if (!handler) throw new Error(`no in-process handler for op: ${op}`);
    return handler(args);
  };
  const fakeClient = {
    get isReady() { return false; },
    // !started (default) branch: the front-of-turn recall façades take the
    // in-process fallback (the sync `searchLocalMemorySemanticMock` this suite
    // asserts on). When `recallClientControl.isProductionOwner` is flipped true,
    // the façades return bounded empty WITHOUT calling the in-process reader.
    get isProductionOwner() { return recallClientControl.isProductionOwner; },
    async run(op: string, args: unknown[] = []) { return dispatch(op, args); },
    fireAndForget(op: string, args: unknown[] = []) { dispatch(op, args); },
    fireAndForgetCount: 0,
  };
  return {
    ...actual,
    getContextStoreClient: () => fakeClient,
  };
});

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
  handleFileUploadFetch: vi.fn(),
  handleFileDownload: vi.fn(),
  createProjectFileHandle: vi.fn(),
  createProjectFileHandleFromValidatedPath: vi.fn(),
  tryCreateProjectFileHandle: vi.fn(),
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


vi.mock('../../src/context/memory-recall-client.js', () => ({
  searchLocalMemorySemanticFrontOfTurn: vi.fn(async (query) => {
    if (recallClientControl.isProductionOwner) {
      return {
        items: [],
        stats: { totalRecords: 0, matchedRecords: 0, recentSummaryCount: 0, durableCandidateCount: 0, projectCount: 0, stagedEventCount: 0, dirtyTargetCount: 0, pendingJobCount: 0 },
      };
    }
    return searchLocalMemorySemanticMock(query);
  }),
  searchLocalMemoryForManagement: vi.fn(async (query) => searchLocalMemorySemanticMock(query)),
  searchLocalMemorySemanticForManagement: vi.fn(async (query) => searchLocalMemorySemanticMock(query)),
  searchLocalMemoryAuthorizedForManagement: vi.fn(async (query) => searchLocalMemorySemanticMock(query)),
}));

vi.mock('../../src/context/summary-sync.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/context/summary-sync.js')>()),
  collectRecentSummarySyncCandidates: collectRecentSummarySyncCandidatesMock,
}));

vi.mock('../../src/repo/detector.js', () => ({
  detectRepo: detectRepoMock,
  parseRemoteUrl: vi.fn((url: string) => {
    if (url === 'git@github.com:imcodes/codedeck.git') {
      return { host: 'github.com', owner: 'imcodes', repo: 'codedeck' };
    }
    if (url === 'ssh://git@172.16.253.211:2224/Hermit/ai_purchase2.git') {
      return { host: '172.16.253.211', owner: 'Hermit', repo: 'ai_purchase2' };
    }
    return null;
  }),
  parseRemotes: vi.fn((output: string) => output
    .split('\n')
    .map((line) => /^(\S+)\s+(\S+)\s+\(fetch\)/.exec(line))
    .filter((match): match is RegExpExecArray => Boolean(match))
    .map((match) => {
      if (match[2] === 'git@github.com:imcodes/codedeck.git') {
        return { name: match[1], url: match[2], host: 'github.com', owner: 'imcodes', repo: 'codedeck' };
      }
      return null;
    })
    .filter((remote): remote is { name: string; url: string; host: string; owner: string; repo: string } => Boolean(remote))),
}));

import { handleWebCommand } from '../../src/daemon/command-handler.js';
import { setContextModelRuntimeConfig } from '../../src/context/context-model-config.js';
import { resetAllRecentInjectionHistories } from '../../src/context/recent-injection-history.js';
import { resetAllSummarySyncHistories } from '../../src/context/summary-sync-history.js';
import { fingerprintRecentSummary } from '../../src/context/summary-sync.js';
import { resetMemoryFeatureConfigStoreForTests } from '../../src/store/memory-feature-config-store.js';
import { MEMORY_WS } from '../../shared/memory-ws.js';
import { MEMORY_MANAGEMENT_CONTEXT_FIELD } from '../../shared/memory-management-context.js';
import { MEMORY_MANAGEMENT_ERROR_CODES } from '../../shared/memory-management.js';
import { ALIAS_REASONS, ALIAS_LEGEND_DIRECTIVE, buildAliasLegendLine } from '../../shared/alias-types.js';
import { getResendEntries, clearResend } from '../../src/daemon/transport-resend-queue.js';
// Resolves to the vi.fn() from the ../../src/agent/tmux.js mock above — lets the
// fail-closed tests assert the raw `sendKeys` variant is never called with `;;(`.
import { sendKeys as tmuxSendKeysMock } from '../../src/agent/tmux.js';

const flushAsync = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const originalFeatureEnv = {
  configPath: process.env.IMCODES_MEMORY_FEATURE_CONFIG_PATH,
  namespaceRegistry: process.env.IMCODES_MEM_FEATURE_NAMESPACE_REGISTRY,
  observationStore: process.env.IMCODES_MEM_FEATURE_OBSERVATION_STORE,
};

async function createGitRepoWithOrigin(projectDir: string, originUrl: string): Promise<void> {
  await mkdir(projectDir, { recursive: true });
  await execFileAsync('git', ['init'], { cwd: projectDir });
  await execFileAsync('git', ['remote', 'add', 'origin', originUrl], { cwd: projectDir });
}

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
    recallClientControl.isProductionOwner = false; // default tests/CLI path
    process.env.IMCODES_MEMORY_FEATURE_CONFIG_PATH = join(tmpdir(), `imcodes-memory-feature-${process.pid}-${Date.now()}-${Math.random()}.json`);
    process.env.IMCODES_MEM_FEATURE_NAMESPACE_REGISTRY = 'true';
    process.env.IMCODES_MEM_FEATURE_OBSERVATION_STORE = 'true';
    resetMemoryFeatureConfigStoreForTests();
    resetAllRecentInjectionHistories();
    resetAllSummarySyncHistories();
    collectRecentSummarySyncCandidatesMock.mockResolvedValue([]);
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

  it('resolves canonical ids from self-hosted GitLab remotes even when repo features cannot identify a platform', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'imcodes-project-resolve-gitlab-'));
    const projectDir = join(tempDir, 'ai_purchase2');
    await mkdir(projectDir);
    listSessionsMock.mockReturnValue([{ name: 'deck_ai_purchase2_brain', projectDir }]);
    detectRepoMock.mockResolvedValueOnce({
      status: 'unknown_platform',
      info: {
        platform: 'unknown',
        owner: 'Hermit',
        repo: 'ai_purchase2',
        remoteUrl: 'ssh://git@172.16.253.211:2224/Hermit/ai_purchase2.git',
      },
    });

    try {
      handleWebCommand({
        type: MEMORY_WS.PROJECT_RESOLVE,
        requestId: 'resolve-gitlab-ssh-port',
        projectDir,
        [MEMORY_MANAGEMENT_CONTEXT_FIELD]: {
          actorId: 'user-bob',
          userId: 'user-bob',
          role: 'user',
          source: 'server_bridge',
          requestId: 'resolve-gitlab-ssh-port',
          boundProjects: [{ projectDir }],
        },
      }, serverLink as any);

      await vi.waitFor(() => {
        expect(serverLink.send).toHaveBeenCalledWith(expect.objectContaining({
          type: MEMORY_WS.PROJECT_RESOLVE_RESPONSE,
          requestId: 'resolve-gitlab-ssh-port',
          success: true,
          status: 'resolved',
          canonicalRepoId: '172.16.253.211/hermit/ai_purchase2',
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

  it('validates manual memory project directories before trusting canonical repo ids', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'imcodes-manual-memory-'));
    const projectDir = join(tempDir, 'codedeck');
    await createGitRepoWithOrigin(projectDir, 'git@github.com:imcodes/codedeck.git');
    listSessionsMock.mockReturnValue([{ name: 'deck_codedeck_brain', projectDir }]);

    try {
      handleWebCommand({
        type: MEMORY_WS.CREATE,
        requestId: 'create-local-project-memory',
        canonicalRepoId: 'github.com/imcodes/codedeck',
        projectDir,
        text: 'Remember local project identity checks.',
        [MEMORY_MANAGEMENT_CONTEXT_FIELD]: {
          actorId: 'user-bob',
          userId: 'user-bob',
          role: 'user',
          source: 'server_bridge',
          requestId: 'create-local-project-memory',
          boundProjects: [{ projectDir, canonicalRepoId: 'github.com/imcodes/codedeck' }],
        },
      }, serverLink as any);

      await vi.waitFor(() => {
        expect(writeProcessedProjectionMock).toHaveBeenCalledWith(expect.objectContaining({
          namespace: { scope: 'personal', projectId: 'github.com/imcodes/codedeck', userId: 'user-bob' },
          summary: 'Remember local project identity checks.',
        }));
        expect(serverLink.send).toHaveBeenCalledWith(expect.objectContaining({
          type: MEMORY_WS.CREATE_RESPONSE,
          requestId: 'create-local-project-memory',
          success: true,
        }));
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('rejects manual memory create when project directory identity does not match the requested canonical id', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'imcodes-manual-memory-mismatch-'));
    const projectDir = join(tempDir, 'codedeck');
    await createGitRepoWithOrigin(projectDir, 'git@github.com:imcodes/codedeck.git');
    listSessionsMock.mockReturnValue([{ name: 'deck_codedeck_brain', projectDir }]);

    try {
      handleWebCommand({
        type: MEMORY_WS.CREATE,
        requestId: 'create-local-project-memory-mismatch',
        canonicalRepoId: 'github.com/acme/private',
        projectDir,
        text: 'This must not be written under a spoofed repo id.',
        [MEMORY_MANAGEMENT_CONTEXT_FIELD]: {
          actorId: 'user-bob',
          userId: 'user-bob',
          role: 'user',
          source: 'server_bridge',
          requestId: 'create-local-project-memory-mismatch',
          boundProjects: [{ projectDir, canonicalRepoId: 'github.com/acme/private' }],
        },
      }, serverLink as any);

      await vi.waitFor(() => {
        expect(writeProcessedProjectionMock).not.toHaveBeenCalled();
        expect(serverLink.send).toHaveBeenCalledWith(expect.objectContaining({
          type: MEMORY_WS.CREATE_RESPONSE,
          requestId: 'create-local-project-memory-mismatch',
          success: false,
          errorCode: MEMORY_MANAGEMENT_ERROR_CODES.PROJECT_IDENTITY_MISMATCH,
        }));
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
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

  it('returns explicit localUnavailable response when personal semantic management search degrades', async () => {
    getProcessedProjectionStatsMock.mockReturnValue({
      totalRecords: 2,
      matchedRecords: 2,
      recentSummaryCount: 2,
      durableCandidateCount: 0,
      projectCount: 1,
      stagedEventCount: 0,
      dirtyTargetCount: 0,
      pendingJobCount: 0,
    });
    searchLocalMemorySemanticMock.mockRejectedValueOnce(new Error('context-store worker unavailable'));

    handleWebCommand({
      type: MEMORY_WS.PERSONAL_QUERY,
      requestId: 'personal-search-degraded',
      canonicalRepoId: 'github.com/acme/repo',
      query: 'matching',
      [MEMORY_MANAGEMENT_CONTEXT_FIELD]: {
        actorId: 'user-bob',
        userId: 'user-bob',
        role: 'user',
        source: 'server_bridge',
        requestId: 'personal-search-degraded',
        boundProjects: [{ canonicalRepoId: 'github.com/acme/repo' }],
      },
    }, serverLink as any);

    await flushAsync();

    expect(serverLink.send).toHaveBeenCalledWith(expect.objectContaining({
      type: MEMORY_WS.PERSONAL_RESPONSE,
      requestId: 'personal-search-degraded',
      records: [],
      pendingRecords: [],
      projects: [],
      stats: expect.objectContaining({
        totalRecords: 2,
        matchedRecords: 0,
        localUnavailable: true,
      }),
    }));
    expect(queryPendingContextEventsMock).not.toHaveBeenCalled();
    expect(listMemoryProjectSummariesMock).not.toHaveBeenCalled();
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

  it('synchronizes a new recent summary once across subsequent process sends', async () => {
    searchLocalMemorySemanticMock.mockResolvedValue({
      items: [],
      stats: { totalRecords: 0, matchedRecords: 0, recentSummaryCount: 0, durableCandidateCount: 0, projectCount: 0, stagedEventCount: 0, dirtyTargetCount: 0, pendingJobCount: 0 },
    });
    const summary = 'New project summary created after this process session started';
    collectRecentSummarySyncCandidatesMock.mockResolvedValue([{
      fingerprint: fingerprintRecentSummary(summary),
      item: {
        id: 'recent-new',
        type: 'processed',
        projectId: 'github.com/imcodes/codedeck',
        scope: 'personal',
        summary,
        projectionClass: 'recent_summary',
        sourceKind: 'local_processed',
        updatedAt: 2,
      },
    }]);

    handleWebCommand({
      type: 'session.send',
      session: 'deck_process_brain',
      text: 'First concurrent normal request',
      commandId: 'cmd-summary-one',
    }, serverLink as any);
    for (let i = 0; i < 20 && sendKeysDelayedEnterMock.mock.calls.length < 1; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    handleWebCommand({
      type: 'session.send',
      session: 'deck_process_brain',
      text: 'Second concurrent normal request',
      commandId: 'cmd-summary-two',
    }, serverLink as any);

    for (let i = 0; i < 20 && sendKeysDelayedEnterMock.mock.calls.length < 2; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    const delivered = sendKeysDelayedEnterMock.mock.calls.map((call) => String(call[1]));
    expect(delivered).toHaveLength(2);
    expect(delivered.filter((text) => text.includes(summary))).toHaveLength(1);
    expect(delivered.find((text) => text.includes(summary))).toContain('# Recent project memory (reference only)');
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

  it('retries an unsynchronized summary after a process delivery failure', async () => {
    const summary = 'Process delivery must not tombstone this summary on failure';
    searchLocalMemorySemanticMock.mockResolvedValue({
      items: [],
      stats: { totalRecords: 0, matchedRecords: 0, recentSummaryCount: 0, durableCandidateCount: 0, projectCount: 0, stagedEventCount: 0, dirtyTargetCount: 0, pendingJobCount: 0 },
    });
    collectRecentSummarySyncCandidatesMock.mockResolvedValue([{
      fingerprint: fingerprintRecentSummary(summary),
      item: {
        id: 'recent-process-retry',
        type: 'processed',
        projectId: 'github.com/imcodes/codedeck',
        scope: 'personal',
        summary,
        projectionClass: 'recent_summary',
        sourceKind: 'local_processed',
      },
    }]);
    sendKeysDelayedEnterMock.mockRejectedValueOnce(new Error('tmux failed'));

    handleWebCommand({
      type: 'session.send',
      session: 'deck_process_brain',
      text: 'First process delivery attempt',
      commandId: 'cmd-summary-failed',
    }, serverLink as any);
    for (let i = 0; i < 20 && sendKeysDelayedEnterMock.mock.calls.length < 1; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    handleWebCommand({
      type: 'session.send',
      session: 'deck_process_brain',
      text: 'Second process delivery attempt',
      commandId: 'cmd-summary-retry',
    }, serverLink as any);
    for (let i = 0; i < 20 && sendKeysDelayedEnterMock.mock.calls.length < 2; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    expect(String(sendKeysDelayedEnterMock.mock.calls[1]?.[1])).toContain(summary);
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

  it('returns empty process recall in production-owner mode without running the in-process semantic reader', async () => {
    // Production single-owner mode + worker not warm: the front-of-turn façade
    // returns bounded empty rather than opening a main-thread in-process reader.
    recallClientControl.isProductionOwner = true;
    // Make the in-process mock conspicuous: if it were (incorrectly) called, it
    // would surface a match and emit `status: 'matched'` + record a hit.
    searchLocalMemorySemanticMock.mockResolvedValue({
      items: [{
        id: 'must-not-appear',
        type: 'processed',
        projectId: 'codedeck',
        scope: 'personal',
        summary: 'In-process read must not run in owner mode',
        createdAt: 1,
        relevanceScore: 0.99,
      }],
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
      text: 'Investigate websocket reconnect behavior in production owner mode',
      commandId: 'cmd-memory-owner-empty',
    }, serverLink as any);

    await flushAsync();

    // The owner-mode façade short-circuits to empty: the in-process reader is
    // never touched, no hit is recorded, and the original prompt is sent as-is.
    expect(searchLocalMemorySemanticMock).not.toHaveBeenCalled();
    expect(recordMemoryHitsMock).not.toHaveBeenCalled();
    expect(sendKeysDelayedEnterMock).toHaveBeenCalledWith(
      'deck_process_brain',
      'Investigate websocket reconnect behavior in production owner mode',
      undefined,
    );
    expect(emitMock).toHaveBeenCalledWith(
      'deck_process_brain',
      'memory.context',
      expect.objectContaining({
        relatedToEventId: 'evt-user-1',
        status: 'no_matches',
        items: [],
      }),
    );
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

  // ── Alias quick-insert (A′) — process/tmux dispatch wiring ────────────────
  // The human-facing `user.message` ALWAYS carries the ORIGINAL `;;(name)`
  // markers; only the agent-bound tmux input is expanded. Inline mode (shell /
  // script) substitutes values in place and FAILS CLOSED on an unresolved
  // marker; legend mode (LLM process agents) keeps markers + prepends a legend.
  describe('alias quick-insert (A′) — process/tmux wiring', () => {
    const emptyRecall = {
      items: [] as unknown[],
      stats: {
        totalRecords: 0, matchedRecords: 0, recentSummaryCount: 0, durableCandidateCount: 0,
        projectCount: 0, stagedEventCount: 0, dirtyTargetCount: 0, pendingJobCount: 0,
      },
    };
    const shellSession = (agentType: 'shell' | 'script' = 'shell') => ({
      name: 'deck_process_brain',
      projectName: 'codedeck',
      role: 'brain',
      agentType,
      runtimeType: 'process',
      state: 'idle',
      projectDir: '/worktrees/codedeck',
    });
    const lastKeysText = () => {
      const call = sendKeysDelayedEnterMock.mock.calls.at(-1);
      return call ? String(call[1]) : undefined;
    };
    const userMessageEmit = (commandId: string) => emitMock.mock.calls.find(
      ([session, type, payload]) => session === 'deck_process_brain'
        && type === 'user.message'
        && (payload as { commandId?: string } | undefined)?.commandId === commandId,
    );

    it('12.5 shell inline: substituted value reaches the agent; timeline keeps the marker', async () => {
      searchLocalMemorySemanticMock.mockResolvedValue(emptyRecall);
      getSessionMock.mockReturnValue(shellSession('shell'));

      handleWebCommand({
        type: 'session.send',
        session: 'deck_process_brain',
        text: 'echo ;;(greeting)',
        commandId: 'cmd-alias-inline-shell',
        resolvedAliases: { greeting: 'hello world' },
      }, serverLink as any);
      await flushAsync();

      // Agent-bound tmux input has the value substituted in place — no marker.
      expect(lastKeysText()).toBe('echo hello world');
      expect(lastKeysText()).not.toContain(';;(');
      // Human-facing timeline keeps the ORIGINAL marker text.
      expect(userMessageEmit('cmd-alias-inline-shell')?.[2]).toMatchObject({ text: 'echo ;;(greeting)' });
    });

    it('12.5 script inline: multiple markers substituted; timeline unchanged', async () => {
      searchLocalMemorySemanticMock.mockResolvedValue(emptyRecall);
      getSessionMock.mockReturnValue(shellSession('script'));

      handleWebCommand({
        type: 'session.send',
        session: 'deck_process_brain',
        text: 'deploy ;;(host) as ;;(user)',
        commandId: 'cmd-alias-inline-script',
        resolvedAliases: { host: 'prod.example.com', user: 'deployer' },
      }, serverLink as any);
      await flushAsync();

      expect(lastKeysText()).toBe('deploy prod.example.com as deployer');
      expect(userMessageEmit('cmd-alias-inline-script')?.[2]).toMatchObject({ text: 'deploy ;;(host) as ;;(user)' });
    });

    it('12.5 LLM (legend): claude-code process agent keeps markers in body + prepends the legend directive', async () => {
      searchLocalMemorySemanticMock.mockResolvedValue(emptyRecall);
      getSessionMock.mockReturnValue({ ...shellSession('shell'), agentType: 'claude-code' });

      handleWebCommand({
        type: 'session.send',
        session: 'deck_process_brain',
        text: 'ping ;;(host) please',
        commandId: 'cmd-alias-legend',
        resolvedAliases: { host: 'prod.example.com' },
      }, serverLink as any);
      await flushAsync();

      const delivered = lastKeysText() ?? '';
      // Directive + legend line present, and the original marker is STILL in the body.
      expect(delivered).toContain(ALIAS_LEGEND_DIRECTIVE);
      expect(delivered).toContain(buildAliasLegendLine('host', 'prod.example.com'));
      expect(delivered).toContain('ping ;;(host) please');
      // Timeline keeps the original.
      expect(userMessageEmit('cmd-alias-legend')?.[2]).toMatchObject({ text: 'ping ;;(host) please' });
    });

    it('12.6 shell unresolved marker: command NOT delivered, diagnostic emitted, no literal ;; reaches the agent', async () => {
      searchLocalMemorySemanticMock.mockResolvedValue(emptyRecall);
      getSessionMock.mockReturnValue(shellSession('shell'));
      sendKeysDelayedEnterMock.mockClear();

      handleWebCommand({
        type: 'session.send',
        session: 'deck_process_brain',
        text: 'rm -rf ;;(target)',
        commandId: 'cmd-alias-failclosed',
        resolvedAliases: {}, // marker unresolved → fail closed
      }, serverLink as any);
      await flushAsync();

      // Nothing at all was handed to the shell — the literal ;;(target) never runs.
      expect(sendKeysDelayedEnterMock).not.toHaveBeenCalled();
      // Original message still shows on the timeline (the user typed it).
      expect(userMessageEmit('cmd-alias-failclosed')?.[2]).toMatchObject({ text: 'rm -rf ;;(target)' });
      // A non-blocking diagnostic names the unresolved marker + reason.
      const diag = emitMock.mock.calls.find(
        ([session, type, payload]) => session === 'deck_process_brain'
          && type === 'assistant.text'
          && String((payload as { text?: string } | undefined)?.text ?? '').includes(ALIAS_REASONS.UNRESOLVED_FAILCLOSED),
      );
      expect(diag).toBeDefined();
      expect(diag?.[2]).toMatchObject({ memoryExcluded: true });
      expect(String(diag?.[2]?.text)).toContain('target');
    });

    it('12.6 NL (legend) unresolved marker: stays literal AND is delivered to the agent', async () => {
      searchLocalMemorySemanticMock.mockResolvedValue(emptyRecall);
      getSessionMock.mockReturnValue({ ...shellSession('shell'), agentType: 'claude-code' });

      handleWebCommand({
        type: 'session.send',
        session: 'deck_process_brain',
        text: 'summarize ;;(missing) for me',
        commandId: 'cmd-alias-legend-unresolved',
        resolvedAliases: {}, // unresolved
      }, serverLink as any);
      await flushAsync();

      // Legend agents always deliver; the unresolved marker stays literal in the body.
      const delivered = lastKeysText() ?? '';
      expect(delivered).toContain('summarize ;;(missing) for me');
      // No legend directive is prepended when there is nothing resolved to explain.
      expect(delivered).not.toContain(ALIAS_LEGEND_DIRECTIVE);
      expect(userMessageEmit('cmd-alias-legend-unresolved')?.[2]).toMatchObject({ text: 'summarize ;;(missing) for me' });
    });

    it('12.8 fail-closed diagnostic contains the marker name + reason but NEVER the value', async () => {
      searchLocalMemorySemanticMock.mockResolvedValue(emptyRecall);
      getSessionMock.mockReturnValue(shellSession('shell'));
      sendKeysDelayedEnterMock.mockClear();

      const SECRET = 'super-secret-token-abc123';
      handleWebCommand({
        type: 'session.send',
        session: 'deck_process_brain',
        // 'token' IS resolved (to a secret), but 'other' is NOT → whole inline
        // send fails closed. The diagnostic must never leak the resolved value.
        text: 'use ;;(token) and ;;(other)',
        commandId: 'cmd-alias-noleak',
        resolvedAliases: { token: SECRET },
      }, serverLink as any);
      await flushAsync();

      expect(sendKeysDelayedEnterMock).not.toHaveBeenCalled();
      const diag = emitMock.mock.calls.find(
        ([session, type, payload]) => session === 'deck_process_brain'
          && type === 'assistant.text'
          && String((payload as { text?: string } | undefined)?.text ?? '').includes(ALIAS_REASONS.UNRESOLVED_FAILCLOSED),
      );
      expect(diag).toBeDefined();
      const diagText = String(diag?.[2]?.text ?? '');
      expect(diagText).toContain('other'); // unresolved name is fine
      expect(diagText).toContain(ALIAS_REASONS.UNRESOLVED_FAILCLOSED);
      // The resolved value must NEVER appear in any emitted diagnostic.
      expect(diagText).not.toContain(SECRET);
      for (const call of emitMock.mock.calls) {
        expect(JSON.stringify(call[2] ?? '')).not.toContain(SECRET);
      }
    });

    // ── Real-dispatch fail-closed integration (the bug that shipped: the pure
    //    function was tested, but real dispatch to a shell/script never was). ──
    // Timeline `command.ack` error emissions captured by emitMock.
    const failClosedTimelineAcks = () => emitMock.mock.calls.filter(
      ([session, type, payload]) => session === 'deck_process_brain'
        && type === 'command.ack'
        && (payload as { status?: string } | undefined)?.status === 'error'
        && String((payload as { error?: string } | undefined)?.error ?? '').includes(ALIAS_REASONS.UNRESOLVED_FAILCLOSED),
    );
    // Reliable ack (outbox → serverLink.send) carries type 'command.ack' + reason.
    const failClosedWireAcks = () => (serverLink.send as any).mock.calls.filter(
      ([msg]: [Record<string, unknown>]) => msg?.type === 'command.ack'
        && msg?.status === 'error'
        && String(msg?.error ?? '').includes(ALIAS_REASONS.UNRESOLVED_FAILCLOSED),
    );
    // Any tmux write (either variant) that carries a literal `;;(` — must be none.
    const anyLiteralMarkerSent = () => {
      const delayed = sendKeysDelayedEnterMock.mock.calls.some((c) => String(c[1] ?? '').includes(';;('));
      const raw = (tmuxSendKeysMock as any).mock.calls.some((c: unknown[]) => String(c[1] ?? '').includes(';;('));
      return delayed || raw;
    };

    for (const agentType of ['shell', 'script'] as const) {
      it(`12.9 REAL dispatch (${agentType}): unresolved marker never reaches tmux; command.ack error emitted`, async () => {
        searchLocalMemorySemanticMock.mockResolvedValue(emptyRecall);
        getSessionMock.mockReturnValue(shellSession(agentType));
        sendKeysDelayedEnterMock.mockClear();
        (tmuxSendKeysMock as any).mockClear();
        (serverLink.send as any).mockClear();

        handleWebCommand({
          type: 'session.send',
          session: 'deck_process_brain',
          text: `deploy ;;(missingHost) now`,
          commandId: `cmd-failclosed-${agentType}`,
          resolvedAliases: {}, // unresolved → fail closed
        }, serverLink as any);
        await flushAsync();

        // NOTHING with a literal `;;(` reached the shell/script via EITHER tmux fn.
        expect(sendKeysDelayedEnterMock).not.toHaveBeenCalled();
        expect(tmuxSendKeysMock).not.toHaveBeenCalled();
        expect(anyLiteralMarkerSent()).toBe(false);
        // A terminal command.ack error was emitted on BOTH channels with the code.
        expect(failClosedTimelineAcks().length).toBeGreaterThanOrEqual(1);
        expect(failClosedWireAcks().length).toBeGreaterThanOrEqual(1);
        // The reliable ack also carries the machine reason (never a value).
        const wireAck = failClosedWireAcks()[0]?.[0] as Record<string, unknown>;
        expect(wireAck?.reason).toBe(ALIAS_REASONS.UNRESOLVED_FAILCLOSED);
        // Human-facing echo still shows the original marker text.
        expect(userMessageEmit(`cmd-failclosed-${agentType}`)?.[2]).toMatchObject({
          text: 'deploy ;;(missingHost) now',
        });
      });
    }

    it('12.10 REAL dispatch (transport, no runtime): guard fires BEFORE enqueue — no literal ;;( queued', async () => {
      searchLocalMemorySemanticMock.mockResolvedValue(emptyRecall);
      // A session flagged transport (runtimeType='transport') whose agentType is
      // unknown → alias mode defaults to `inline`, so an unresolved marker fails
      // closed. No transport runtime is registered, so WITHOUT the early guard the
      // message would fall into the no-runtime enqueueResend branch carrying the
      // literal `;;(`. The guard must short-circuit BEFORE that enqueue.
      const transportInlineSession = {
        name: 'deck_process_brain',
        projectName: 'codedeck',
        role: 'brain',
        agentType: 'brand-new-inline-agent', // unknown → aliasExpansionModeFor → inline
        runtimeType: 'transport',
        providerId: 'unknown',
        state: 'idle',
        projectDir: '/worktrees/codedeck',
      };
      getSessionMock.mockReturnValue(transportInlineSession);
      getTransportRuntimeMock.mockReturnValue(undefined); // no runtime → would enqueue
      clearResend('deck_process_brain');
      (serverLink.send as any).mockClear();

      handleWebCommand({
        type: 'session.send',
        session: 'deck_process_brain',
        text: 'run ;;(nope) please',
        commandId: 'cmd-failclosed-transport',
        resolvedAliases: {}, // unresolved
      }, serverLink as any);
      await flushAsync();

      // The real resend queue is untouched — nothing (least of all a literal
      // `;;(`) was enqueued for redelivery.
      const queued = getResendEntries('deck_process_brain');
      expect(queued.length).toBe(0);
      for (const entry of queued) {
        expect(entry.text).not.toContain(';;(');
        expect(entry.providerText ?? '').not.toContain(';;(');
      }
      // Terminal command.ack error surfaced (reliable channel).
      expect(failClosedWireAcks().length).toBeGreaterThanOrEqual(1);
      // Human echo preserved.
      expect(userMessageEmit('cmd-failclosed-transport')?.[2]).toMatchObject({
        text: 'run ;;(nope) please',
      });
    });
  });
});
