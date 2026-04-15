import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ContextNamespace,
  ContextTargetRef,
  ProcessedContextReplicationBody,
  ProviderContextPayload,
} from '../../shared/context-types.js';
import { dispatchSharedContextSend } from '../../src/agent/transport-runtime-assembly.js';
import type { TransportProvider } from '../../src/agent/transport-provider.js';
import { fetchBackendManagedAuthoredContext } from '../../src/context/backend-authored-context.js';
import { setContextModelRuntimeConfig } from '../../src/context/context-model-config.js';
import { MaterializationCoordinator } from '../../src/context/materialization-coordinator.js';
import { localOnlyCompressor } from '../../src/context/summary-compressor.js';
import { replicatePendingProcessedContext } from '../../src/context/processed-context-replication.js';
import { cleanupIsolatedSharedContextDb, createIsolatedSharedContextDb } from '../util/shared-context-db.js';

function makeProvider(
  contextSupport: NonNullable<TransportProvider['capabilities']['contextSupport']> = 'full-normalized-context-injection',
) {
  const send = vi.fn(async () => {});
  const provider: TransportProvider = {
    id: 'integration-provider',
    connectionMode: 'local-sdk',
    sessionOwnership: 'shared',
    capabilities: {
      streaming: true,
      toolCalling: false,
      approval: false,
      sessionRestore: false,
      multiTurn: true,
      attachments: false,
      contextSupport,
    },
    connect: async () => {},
    disconnect: async () => {},
    createSession: async () => 'sess-1',
    endSession: async () => {},
    send,
    onDelta: () => () => {},
    onComplete: () => () => {},
    onError: () => () => {},
  };
  return { provider, send };
}

function latestSummary(body: ProcessedContextReplicationBody): string {
  const projection = [...body.projections].sort((left, right) => right.updatedAt - left.updatedAt)[0];
  return projection?.summary ?? '';
}

describe('shared-agent-context continuity integration', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await createIsolatedSharedContextDb('shared-context-integration');
    setContextModelRuntimeConfig(null);
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    setContextModelRuntimeConfig(null);
    await cleanupIsolatedSharedContextDb(tempDir);
  });

  it('preserves personal multi-machine continuity from processed local to processed remote authority', async () => {
    const namespace: ContextNamespace = {
      scope: 'personal',
      projectId: 'github.com/acme/repo',
      userId: 'user-1',
    };
    const target: ContextTargetRef = {
      namespace,
      kind: 'session',
      sessionName: 'deck_repo_brain',
    };
    const coordinator = new MaterializationCoordinator({ compressor: localOnlyCompressor,
      thresholds: { eventCount: 99, idleMs: 1_000, scheduleMs: 10_000 },
      modelConfig: {
        primaryContextBackend: 'codex-sdk',
        primaryContextModel: 'gpt-5.2',
        backupContextBackend: 'qwen',
        backupContextModel: 'qwen',
        enablePersonalMemorySync: true,
      },
    });

    coordinator.ingestEvent({ target, eventType: 'user.turn', content: 'Investigate rollout failure', createdAt: 100 });
    coordinator.ingestEvent({ target, eventType: 'assistant.turn', content: 'Root cause is stale config replay', createdAt: 101 });
    const materialized = await coordinator.materializeTarget(target, 'manual', 200);
    setContextModelRuntimeConfig({
      primaryContextBackend: 'codex-sdk',
      primaryContextModel: 'gpt-5.2',
      backupContextBackend: 'qwen',
      backupContextModel: 'qwen',
      enablePersonalMemorySync: true,
    });

    let replicatedBody: ProcessedContextReplicationBody | null = null;
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      replicatedBody = JSON.parse(String(init?.body)) as ProcessedContextReplicationBody;
      return { ok: true };
    }));

    const replication = await replicatePendingProcessedContext({
      workerUrl: 'http://worker.test',
      serverId: 'srv-1',
      token: 'daemon-token',
    });

    expect(replication.failures).toEqual([]);
    expect(replicatedBody?.namespace).toEqual(namespace);
    expect(latestSummary(replicatedBody!)).toContain(materialized.summaryProjection.summary);

    const { provider, send } = makeProvider();
    await dispatchSharedContextSend(provider, 'sess-1', {
      userMessage: 'Continue from the replicated summary',
      namespace,
      remoteProcessedFreshness: 'fresh',
      messagePreamble: latestSummary(replicatedBody!),
    }, {
      flags: {
        identityShadow: true,
        localStaging: true,
        materialization: true,
        remoteReplication: true,
        controlPlane: true,
        runtimeSend: true,
        legacyInjectionDisabled: true,
        shadowDiagnostics: false,
      },
    });

    expect(send).toHaveBeenCalledWith('sess-1', expect.objectContaining<Partial<ProviderContextPayload>>({
      authority: expect.objectContaining({
        authoritySource: 'processed_remote',
        freshness: 'fresh',
      }),
      assembledMessage: `${latestSummary(replicatedBody!)}\n\nContinue from the replicated summary`,
    }));
  });

  it('preserves enrolled shared-project continuity with replicated summaries and backend-authored context', async () => {
    const namespace: ContextNamespace = {
      scope: 'project_shared',
      projectId: 'github.com/acme/repo',
      enterpriseId: 'ent-1',
      workspaceId: 'ws-1',
    };
    const target: ContextTargetRef = {
      namespace,
      kind: 'project',
    };
    const coordinator = new MaterializationCoordinator({ compressor: localOnlyCompressor,
      thresholds: { eventCount: 99, idleMs: 1_000, scheduleMs: 10_000 },
      modelConfig: {
        primaryContextBackend: 'claude-code-sdk',
        primaryContextModel: 'sonnet',
        backupContextBackend: 'codex-sdk',
        backupContextModel: 'gpt-5.2',
      },
    });

    coordinator.ingestEvent({ target, eventType: 'decision', content: 'Repository migration stays incremental', createdAt: 10 });
    coordinator.ingestEvent({ target, eventType: 'constraint', content: 'Do not bypass shared runtime assembly', createdAt: 20 });
    await coordinator.materializeTarget(target, 'manual', 30);

    let replicationBody: ProcessedContextReplicationBody | null = null;
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes('/shared-context/processed')) {
        replicationBody = JSON.parse(String(init?.body)) as ProcessedContextReplicationBody;
        return { ok: true };
      }
      if (url.includes('/shared-context/authored-bindings')) {
        return {
          ok: true,
          json: async () => ({
            bindings: [
              {
                bindingId: 'binding-required',
                documentVersionId: 'doc-v2',
                mode: 'required',
                scope: 'project_shared',
                repository: 'github.com/acme/repo',
                language: 'typescript',
                pathPattern: 'src/**',
                content: 'Use the shared transport contract.',
                active: true,
                superseded: false,
              },
              {
                bindingId: 'binding-advisory',
                documentVersionId: 'doc-v1',
                mode: 'advisory',
                scope: 'org_shared',
                content: 'Prefer bounded summaries over raw logs.',
                active: true,
                superseded: false,
              },
            ],
          }),
        };
      }
      throw new Error(`unexpected fetch url: ${url}`);
    }));

    await replicatePendingProcessedContext({
      workerUrl: 'http://worker.test',
      serverId: 'srv-1',
      token: 'daemon-token',
    });

    const { provider, send } = makeProvider();
    await dispatchSharedContextSend(provider, 'sess-1', {
      userMessage: 'Apply the shared repository guidance',
      namespace,
      remoteProcessedFreshness: 'fresh',
      retryExhausted: true,
      messagePreamble: latestSummary(replicationBody!),
      authoredContextRepository: 'github.com/acme/repo',
      authoredContextLanguage: 'typescript',
      authoredContextFilePath: 'src/runtime.ts',
    }, {
      flags: {
        identityShadow: true,
        localStaging: true,
        materialization: true,
        remoteReplication: true,
        controlPlane: true,
        runtimeSend: true,
        legacyInjectionDisabled: true,
        shadowDiagnostics: false,
      },
      resolveAuthoredContext: (input) => fetchBackendManagedAuthoredContext({
        workerUrl: 'http://worker.test',
        serverId: 'srv-1',
        token: 'daemon-token',
      }, {
        namespace: input.namespace!,
        language: input.authoredContextLanguage,
        filePath: input.authoredContextFilePath,
      }),
    });

    expect(send).toHaveBeenCalledWith('sess-1', expect.objectContaining<Partial<ProviderContextPayload>>({
      authority: expect.objectContaining({
        authoritySource: 'processed_remote',
        freshness: 'fresh',
      }),
      context: expect.objectContaining({
        requiredAuthoredContext: ['Use the shared transport contract.'],
        advisoryAuthoredContext: ['Prefer bounded summaries over raw logs.'],
        appliedDocumentVersionIds: ['doc-v2', 'doc-v1'],
      }),
    }));
  });

  it('hard-fails shared-scope fallback by default after retry exhaustion even when processed local exists', async () => {
    const namespace: ContextNamespace = {
      scope: 'org_shared',
      projectId: 'github.com/acme/repo',
      enterpriseId: 'ent-1',
    };
    const target: ContextTargetRef = {
      namespace,
      kind: 'project',
    };
    const coordinator = new MaterializationCoordinator({ compressor: localOnlyCompressor,
      thresholds: { eventCount: 99, idleMs: 1_000, scheduleMs: 10_000 },
    });

    coordinator.ingestEvent({ target, eventType: 'decision', content: 'Local summary exists but is not shared authority', createdAt: 1 });
    await coordinator.materializeTarget(target, 'manual', 2);

    const { provider, send } = makeProvider();
    await expect(dispatchSharedContextSend(provider, 'sess-1', {
      userMessage: 'Attempt shared send',
      namespace,
      localProcessedFreshness: 'fresh',
      remoteProcessedFreshness: 'missing',
      retryExhausted: true,
    }, {
      flags: {
        identityShadow: true,
        localStaging: true,
        materialization: true,
        remoteReplication: true,
        controlPlane: true,
        runtimeSend: true,
        legacyInjectionDisabled: true,
        shadowDiagnostics: false,
      },
    })).rejects.toThrow(/shared context authority is unavailable/i);

    expect(send).not.toHaveBeenCalled();
  });
});
