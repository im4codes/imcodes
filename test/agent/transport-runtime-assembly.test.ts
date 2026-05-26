import { describe, expect, it, vi } from 'vitest';
import {
  buildProviderContextPayload,
  dispatchSharedContextSend,
  MCP_MEMORY_SEARCH_SYSTEM_GUIDANCE,
} from '../../src/agent/transport-runtime-assembly.js';
import type { TransportProvider } from '../../src/agent/transport-provider.js';
import type { TransportMemoryRecallArtifact } from '../../shared/context-types.js';

function makeProvider(
  contextSupport: NonNullable<TransportProvider['capabilities']['contextSupport']>,
  id = 'mock',
): TransportProvider {
  const send = vi.fn(async () => {});
  return {
    id,
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
}

function makeRecall(overrides: Partial<TransportMemoryRecallArtifact> = {}): TransportMemoryRecallArtifact {
  return {
    reason: 'message',
    runtimeFamily: 'transport',
    authoritySource: 'processed_local',
    sourceKind: 'local_processed',
    injectedText: '[Related past work]\n- [repo-1] Fix transport recall visibility',
    items: [
      {
        id: 'mem-1',
        projectId: 'repo-1',
        summary: 'Fix transport recall visibility',
      },
    ],
    ...overrides,
  };
}

describe('buildProviderContextPayload', () => {
  it('assembles normalized system context from description and runtime prompt', () => {
    const payload = buildProviderContextPayload(makeProvider('full-normalized-context-injection'), {
      userMessage: 'Run tests',
      description: 'Be concise',
      systemPrompt: 'Never edit generated files',
      namespace: { scope: 'personal', projectId: 'repo-1' },
    });

    expect(payload.userMessage).toBe('Run tests');
    expect(payload.assembledMessage).toBe('Run tests');
    expect(payload.supportClass).toBe('full-normalized-context-injection');
    expect(payload.sessionSystemText).toContain('Be concise');
    expect(payload.sessionSystemText).toContain('Never edit generated files');
    expect(payload.sessionSystemText).toContain(MCP_MEMORY_SEARCH_SYSTEM_GUIDANCE);
    expect(payload.turnSystemText).toBeUndefined();
    expect(payload.systemText).toContain('Be concise');
    expect(payload.systemText).toContain('Never edit generated files');
    expect(payload.systemText).toContain(MCP_MEMORY_SEARCH_SYSTEM_GUIDANCE);
    expect(payload.systemText).toContain('get_memory_sources');
    expect(payload.systemText).toContain('sourceLookup fields');
    expect(payload.systemText).toContain('Work transparently while you act.');
    expect(payload.systemText).toContain('briefly state what you are checking or changing');
  });

  it('adds shared system guidance for every managed SDK provider id', () => {
    const providerIds = [
      'claude-code-sdk',
      'gemini-sdk',
      'kimi-sdk',
      'copilot-sdk',
      'codex-sdk',
      'cursor-headless',
      'qwen',
    ];

    for (const providerId of providerIds) {
      const payload = buildProviderContextPayload(makeProvider('full-normalized-context-injection', providerId), {
        userMessage: 'What did we decide about memory recall last week?',
        namespace: { scope: 'personal', projectId: 'repo-1' },
      });

      expect(payload.systemText).toContain(MCP_MEMORY_SEARCH_SYSTEM_GUIDANCE);
      expect(payload.systemText).toContain('Do not call memory for bare control messages');
      expect(payload.systemText).toContain('call get_memory_sources with the returned sourceLookup fields');
      expect(payload.systemText).toContain('do not invent details from summaries alone');
      expect(payload.systemText).toContain('Work transparently while you act.');
      expect(payload.systemText).toContain('Keep updates short and useful');
      expect(payload.assembledMessage).toBe('What did we decide about memory recall last week?');
    }
  });

  it('can suppress shared guidance for raw slash controls', () => {
    const payload = buildProviderContextPayload(makeProvider('full-normalized-context-injection'), {
      userMessage: '/compact',
      suppressMcpMemorySearchGuidance: true,
      suppressAgentProgressGuidance: true,
      namespace: { scope: 'personal', projectId: 'repo-1' },
    });

    expect(payload.systemText).toBeUndefined();
    expect(payload.assembledMessage).toBe('/compact');
  });

  it('keeps agent progress guidance independent from memory guidance suppression', () => {
    const payload = buildProviderContextPayload(makeProvider('full-normalized-context-injection'), {
      userMessage: 'Run tests',
      suppressMcpMemorySearchGuidance: true,
      namespace: { scope: 'personal', projectId: 'repo-1' },
    });

    expect(payload.systemText).not.toContain(MCP_MEMORY_SEARCH_SYSTEM_GUIDANCE);
    expect(payload.systemText).toContain('Work transparently while you act.');
  });

  it('renders startup memory and message recall into messagePreamble without mutating userMessage', () => {
    const payload = buildProviderContextPayload(makeProvider('full-normalized-context-injection'), {
      userMessage: 'Run tests',
      namespace: { scope: 'personal', projectId: 'repo-1' },
      localProcessedFreshness: 'fresh',
      startupMemory: makeRecall({
        reason: 'startup',
        injectedText: '# Recent project memory\n\n- Prior fix for transport bootstrap',
      }),
      memoryRecall: makeRecall(),
    });

    expect(payload.userMessage).toBe('Run tests');
    expect(payload.systemText ?? '').not.toContain('# Recent project memory');
    expect(payload.messagePreamble).toContain('# Recent project memory');
    expect(payload.messagePreamble).toContain('[Related past work]');
    expect(payload.assembledMessage).toContain('# Recent project memory');
    expect(payload.assembledMessage).toContain('[Related past work]');
    expect(payload.startupMemory?.injectionSurface).toBe('normalized-payload');
    expect(payload.memoryRecall?.injectionSurface).toBe('normalized-payload');
    expect(payload.startupMemory?.authoritySource).toBe('processed_local');
    expect(payload.memoryRecall?.sourceKind).toBe('local_processed');
  });

  it('marks degraded providers in authority and payload diagnostics', () => {
    const payload = buildProviderContextPayload(makeProvider('degraded-message-side-context-mapping'), {
      userMessage: 'Run tests',
      namespace: { scope: 'personal', projectId: 'repo-1' },
    });

    expect(payload.supportClass).toBe('degraded-message-side-context-mapping');
    expect(payload.authority.diagnostics).toContain('personal-no-processed-context');
    expect(payload.diagnostics).toContain('support:degraded-message-side-context-mapping');
  });

  it('marks recalled memory as degraded-message-side when provider support is degraded', () => {
    const payload = buildProviderContextPayload(makeProvider('degraded-message-side-context-mapping'), {
      userMessage: 'Run tests',
      namespace: { scope: 'personal', projectId: 'repo-1' },
      localProcessedFreshness: 'fresh',
      memoryRecall: makeRecall(),
    });

    expect(payload.supportClass).toBe('degraded-message-side-context-mapping');
    expect(payload.memoryRecall?.injectionSurface).toBe('degraded-message-side');
    expect(payload.assembledMessage).toContain('[Related past work]');
  });

  it('blocks degraded providers in shared scope by default and only allows them when policy explicitly permits', () => {
    const denyPayload = buildProviderContextPayload(makeProvider('degraded-message-side-context-mapping'), {
      userMessage: 'Run tests',
      namespace: { scope: 'project_shared', projectId: 'repo-1' },
      remoteProcessedFreshness: 'fresh',
      retryExhausted: true,
    });
    const allowPayload = buildProviderContextPayload(makeProvider('degraded-message-side-context-mapping'), {
      userMessage: 'Run tests',
      namespace: { scope: 'project_shared', projectId: 'repo-1' },
      remoteProcessedFreshness: 'fresh',
      retryExhausted: true,
      sharedPolicyOverride: { allowDegradedProvider: true },
    });

    expect(denyPayload.authority.authoritySource).toBe('none');
    expect(denyPayload.diagnostics).toContain('support:degraded-message-side-context-mapping');
    expect(allowPayload.authority.authoritySource).toBe('processed_remote');
    expect(allowPayload.authority.diagnostics).not.toContain('shared-scope-provider-degraded');
  });

  it('uses provided freshness inputs when evaluating retry-then-fail shared authority', () => {
    const payload = buildProviderContextPayload(makeProvider('full-normalized-context-injection'), {
      userMessage: 'Run tests',
      namespace: { scope: 'workspace_shared', projectId: 'repo-1', workspaceId: 'ws-1' },
      remoteProcessedFreshness: 'stale',
      retryExhausted: false,
    });

    expect(payload.authority.retryScheduled).toBe(true);
    expect(payload.diagnostics).toContain('retry-scheduled');
    expect(payload.diagnostics).toContain('freshness:stale');
  });

  it('does not expose raw processed-state freshness fields to downstream payload consumers', () => {
    const payload = buildProviderContextPayload(makeProvider('full-normalized-context-injection'), {
      userMessage: 'Run tests',
      namespace: { scope: 'workspace_shared', projectId: 'repo-1', workspaceId: 'ws-1' },
      remoteProcessedFreshness: 'stale',
      localProcessedFreshness: 'fresh',
      retryExhausted: false,
    });

    expect(payload).not.toHaveProperty('remoteProcessedFreshness');
    expect(payload).not.toHaveProperty('localProcessedFreshness');
    expect(payload).not.toHaveProperty('retryExhausted');
    expect(payload.authority).toMatchObject({
      authoritySource: 'none',
      freshness: 'stale',
      retryScheduled: true,
    });
  });

  it('does not fall back to local processed context in shared scope without explicit policy', () => {
    const payload = buildProviderContextPayload(makeProvider('full-normalized-context-injection'), {
      userMessage: 'Run tests',
      namespace: { scope: 'org_shared', projectId: 'repo-1', enterpriseId: 'ent-1' },
      remoteProcessedFreshness: 'missing',
      localProcessedFreshness: 'fresh',
      retryExhausted: true,
    });

    expect(payload.authority.authoritySource).toBe('none');
    expect(payload.authority.fallbackAllowed).toBe(false);
  });

  it('keeps per-message local recall as auxiliary context even when authority resolves to processed_remote', () => {
    const payload = buildProviderContextPayload(makeProvider('full-normalized-context-injection'), {
      userMessage: 'Run tests',
      namespace: { scope: 'project_shared', projectId: 'repo-1', enterpriseId: 'ent-1' },
      remoteProcessedFreshness: 'fresh',
      retryExhausted: true,
      startupMemory: makeRecall({
        reason: 'startup',
        injectedText: '# Recent project memory (reference only)\n<recent-project-memory advisory=\"true\">\n- Prior fix\n</recent-project-memory>',
      }),
      memoryRecall: makeRecall({ authoritySource: 'processed_remote' }),
    });

    expect(payload.authority.authoritySource).toBe('processed_remote');
    expect(payload.startupMemory).toBeUndefined();
    expect(payload.memoryRecall).toEqual(expect.objectContaining({
      sourceKind: 'local_processed',
      authoritySource: 'processed_remote',
      injectionSurface: 'normalized-payload',
    }));
    expect(payload.systemText ?? '').not.toContain('Recent project memory');
    expect(payload.messagePreamble).toContain('[Related past work]');
    expect(payload.diagnostics).toContain('memory:start:suppressed-authority');
    expect(payload.diagnostics).toContain('memory:message:local-auxiliary');
  });

  it('keeps personal local startup memory as auxiliary when remote authority has no startup hits', () => {
    const payload = buildProviderContextPayload(makeProvider('full-normalized-context-injection'), {
      userMessage: 'Run tests',
      namespace: { scope: 'personal', projectId: 'repo-1' },
      remoteProcessedFreshness: 'fresh',
      retryExhausted: true,
      startupMemory: makeRecall({
        reason: 'startup',
        injectedText: '# Recent project memory (reference only)\n<recent-project-memory advisory="true">\n- Local personal startup memory\n</recent-project-memory>',
      }),
    });

    expect(payload.authority.authoritySource).toBe('processed_remote');
    expect(payload.startupMemory).toEqual(expect.objectContaining({
      sourceKind: 'local_processed',
      authoritySource: 'processed_local',
      injectionSurface: 'normalized-payload',
    }));
    expect(payload.messagePreamble).toContain('Local personal startup memory');
    expect(payload.assembledMessage).toContain('Local personal startup memory');
    expect(payload.diagnostics).toContain('memory:start:local-auxiliary');
  });

  it('injects remote startup memory when remote processed context is authoritative', () => {
    const payload = buildProviderContextPayload(makeProvider('full-normalized-context-injection'), {
      userMessage: 'Run tests',
      namespace: { scope: 'project_shared', projectId: 'repo-1', enterpriseId: 'ent-1' },
      remoteProcessedFreshness: 'fresh',
      retryExhausted: true,
      startupMemory: makeRecall({
        reason: 'startup',
        authoritySource: 'processed_remote',
        sourceKind: 'mixed_processed',
        injectedText: '# Recent project memory (reference only)\n<recent-project-memory advisory=\"true\">\n- [important] Cloud startup memory\n- [recent] Local startup memory\n</recent-project-memory>',
        items: [
          {
            id: 'cloud-startup',
            projectId: 'repo-1',
            summary: 'Cloud startup memory',
            projectionClass: 'durable_memory_candidate',
            sourceKind: 'remote_processed',
          },
          {
            id: 'local-startup',
            projectId: 'repo-1',
            summary: 'Local startup memory',
            projectionClass: 'recent_summary',
            sourceKind: 'local_processed',
          },
        ],
      }),
    });

    expect(payload.authority.authoritySource).toBe('processed_remote');
    expect(payload.startupMemory).toEqual(expect.objectContaining({
      sourceKind: 'remote_processed',
      authoritySource: 'processed_remote',
      injectionSurface: 'normalized-payload',
      items: [
        expect.objectContaining({
          id: 'cloud-startup',
          sourceKind: 'remote_processed',
        }),
      ],
    }));
    expect(payload.messagePreamble).toContain('Cloud startup memory');
    expect(payload.assembledMessage).toContain('Cloud startup memory');
    expect(payload.systemText ?? '').not.toContain('Cloud startup memory');
    expect(payload.systemText ?? '').not.toContain('Local startup memory');
    expect(payload.diagnostics).toContain('memory:start');
  });

  it('allows shared local processed fallback only when explicit policy permits it', () => {
    const payload = buildProviderContextPayload(makeProvider('full-normalized-context-injection'), {
      userMessage: 'Run tests',
      namespace: { scope: 'org_shared', projectId: 'repo-1', enterpriseId: 'ent-1' },
      remoteProcessedFreshness: 'missing',
      localProcessedFreshness: 'fresh',
      retryExhausted: true,
      sharedPolicyOverride: { allowLocalProcessedFallback: true },
    });

    expect(payload.authority.authoritySource).toBe('processed_local');
    expect(payload.authority.fallbackAllowed).toBe(true);
  });

  it('compiles required authored context before advisory context and surfaces applied versions in diagnostics', () => {
    const payload = buildProviderContextPayload(makeProvider('full-normalized-context-injection'), {
      userMessage: 'Run tests',
      namespace: { scope: 'project_shared', projectId: 'repo-1' },
      remoteProcessedFreshness: 'fresh',
      retryExhausted: true,
      authoredContextRepository: 'github.com/acme/repo',
      authoredContext: [
        {
          bindingId: 'project-required',
          documentVersionId: 'doc-v2',
          mode: 'required',
          scope: 'project_shared',
          repository: 'github.com/acme/repo',
          content: 'Project required standard',
        },
        {
          bindingId: 'org-advisory',
          documentVersionId: 'doc-v1',
          mode: 'advisory',
          scope: 'org_shared',
          content: 'Org advisory guidance',
        },
      ],
    });

    expect(payload.context.requiredAuthoredContext).toEqual(['Project required standard']);
    expect(payload.context.advisoryAuthoredContext).toEqual(['Org advisory guidance']);
    expect(payload.context.appliedDocumentVersionIds).toEqual(['doc-v2', 'doc-v1']);
    expect(payload.diagnostics).toContain('document-version:doc-v2');
    expect(payload.diagnostics).toContain('document-version:doc-v1');
  });

  it('fails closed when required authored context cannot fit into the compiled payload budget', () => {
    expect(() => buildProviderContextPayload(makeProvider('full-normalized-context-injection'), {
      userMessage: 'Run tests',
      namespace: { scope: 'project_shared', projectId: 'repo-1' },
      remoteProcessedFreshness: 'fresh',
      retryExhausted: true,
      maxRequiredAuthoredChars: 5,
      authoredContext: [
        {
          bindingId: 'project-required',
          documentVersionId: 'doc-v2',
          mode: 'required',
          scope: 'project_shared',
          content: 'Project required standard',
        },
      ],
    })).toThrow(/required authored context/i);
  });

  it('rolls back to raw user-message send when runtime-send cutover is disabled', async () => {
    const provider = makeProvider('full-normalized-context-injection');

    await dispatchSharedContextSend(provider, 'sess-1', {
      userMessage: 'Run tests',
      description: 'Be concise',
      namespace: { scope: 'personal', projectId: 'repo-1' },
    }, {
      flags: {
        identityShadow: true,
        localStaging: true,
        materialization: true,
        remoteReplication: true,
        controlPlane: true,
        runtimeSend: false,
        legacyInjectionDisabled: false,
        shadowDiagnostics: false,
      },
    });

    expect(provider.send).toHaveBeenCalledWith('sess-1', 'Run tests');
  });

  it('emits shadow diagnostics without altering the live payload when shadow mode is enabled before cutover', async () => {
    const provider = makeProvider('full-normalized-context-injection');
    const onShadowDiagnostics = vi.fn();

    await dispatchSharedContextSend(provider, 'sess-1', {
      userMessage: 'Run tests',
      description: 'Be concise',
      namespace: { scope: 'project_shared', projectId: 'repo-1' },
      remoteProcessedFreshness: 'stale',
      retryExhausted: false,
    }, {
      flags: {
        identityShadow: true,
        localStaging: true,
        materialization: true,
        remoteReplication: true,
        controlPlane: true,
        runtimeSend: false,
        legacyInjectionDisabled: false,
        shadowDiagnostics: true,
      },
      onShadowDiagnostics,
    });

    expect(onShadowDiagnostics).toHaveBeenCalledWith(expect.arrayContaining(['freshness:stale', 'retry-scheduled']));
    expect(provider.send).toHaveBeenCalledWith('sess-1', 'Run tests');
  });

  it('can resolve backend-managed authored bindings before runtime compilation', async () => {
    const provider = makeProvider('full-normalized-context-injection');
    const resolveAuthoredContext = vi.fn().mockResolvedValue([
      {
        bindingId: 'binding-project',
        documentVersionId: 'doc-v2',
        mode: 'required',
        scope: 'project_shared',
        repository: 'github.com/acme/repo',
        content: 'Project coding standard',
      },
    ]);

    await dispatchSharedContextSend(provider, 'sess-1', {
      userMessage: 'Run tests',
      namespace: {
        scope: 'project_shared',
        projectId: 'github.com/acme/repo',
        enterpriseId: 'ent-1',
      },
      remoteProcessedFreshness: 'fresh',
      retryExhausted: true,
      authoredContextRepository: 'github.com/acme/repo',
    }, {
      resolveAuthoredContext,
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

    expect(resolveAuthoredContext).toHaveBeenCalledWith(expect.objectContaining({
      namespace: expect.objectContaining({
        scope: 'project_shared',
        projectId: 'github.com/acme/repo',
      }),
    }));
    expect(provider.send).toHaveBeenCalledWith('sess-1', expect.objectContaining({
      sessionSystemText: expect.stringContaining(MCP_MEMORY_SEARCH_SYSTEM_GUIDANCE),
      turnSystemText: 'Required shared context:\n- Project coding standard',
      systemText: expect.stringContaining('Required shared context:\n- Project coding standard'),
      context: expect.objectContaining({
        turnSystemText: 'Required shared context:\n- Project coding standard',
        requiredAuthoredContext: ['Project coding standard'],
        appliedDocumentVersionIds: ['doc-v2'],
      }),
    }));
  });

  it('blocks shared-scope dispatch when authority resolution yields no authoritative shared source', async () => {
    const provider = makeProvider('full-normalized-context-injection');

    await expect(dispatchSharedContextSend(provider, 'sess-1', {
      userMessage: 'Run tests',
      namespace: {
        scope: 'project_shared',
        projectId: 'github.com/acme/repo',
        enterpriseId: 'ent-1',
      },
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

    expect(provider.send).not.toHaveBeenCalled();
  });

  // ── Identity + Generated Image Reporting injection (p2p 37bfbb85-430 N-A) ────
  describe('sessionIdentity / includeGeneratedImageReporting', () => {
    it('injects identity + image-reporting into sessionSystemText, intact and untruncated', () => {
      const payload = buildProviderContextPayload(makeProvider('full-normalized-context-injection'), {
        userMessage: 'hi',
        description: 'short user description',
        systemPrompt: 'short user system prompt',
        sessionIdentity: { sessionName: 'deck_myapp_brain', label: 'My App Brain' },
        namespace: { scope: 'personal', projectId: 'repo-1' },
      });
      const systemText = payload.sessionSystemText ?? '';
      expect(systemText).toContain('short user description');
      expect(systemText).toContain('short user system prompt');
      expect(systemText).toContain('IM.codes session identity:');
      expect(systemText).toContain('Exact session name: deck_myapp_brain');
      expect(systemText).toContain('Display label: My App Brain');
      expect(systemText).toContain('imcodes send');
      expect(systemText).toContain('Generated Image Reporting:');
      expect(systemText).toContain('MUST report the local file path');
      expect(systemText).toContain(MCP_MEMORY_SEARCH_SYSTEM_GUIDANCE);
    });

    it('falls back to the exact session name when label is null / undefined / blank', () => {
      const cases: Array<string | null | undefined> = [null, undefined, '', '   '];
      for (const label of cases) {
        const payload = buildProviderContextPayload(makeProvider('full-normalized-context-injection'), {
          userMessage: 'hi',
          sessionIdentity: { sessionName: 'deck_unlabeled_brain', label },
          namespace: { scope: 'personal', projectId: 'repo-1' },
        });
        const systemText = payload.sessionSystemText ?? '';
        expect(systemText).toContain('Exact session name: deck_unlabeled_brain');
        expect(systemText).toContain('Display label: deck_unlabeled_brain');
      }
    });

    it('does not inject identity / image-reporting when sessionIdentity is absent (process/tmux agents)', () => {
      const payload = buildProviderContextPayload(makeProvider('full-normalized-context-injection'), {
        userMessage: 'hi',
        description: 'some text',
        namespace: { scope: 'personal', projectId: 'repo-1' },
      });
      const systemText = payload.sessionSystemText ?? '';
      expect(systemText).not.toContain('IM.codes session identity:');
      expect(systemText).not.toContain('Generated Image Reporting:');
      expect(systemText).toContain('some text');
    });

    it('omits the image-reporting block when includeGeneratedImageReporting is false but still injects identity', () => {
      const payload = buildProviderContextPayload(makeProvider('full-normalized-context-injection'), {
        userMessage: 'hi',
        sessionIdentity: { sessionName: 'deck_quiet_brain', label: 'Quiet' },
        includeGeneratedImageReporting: false,
        namespace: { scope: 'personal', projectId: 'repo-1' },
      });
      const systemText = payload.sessionSystemText ?? '';
      expect(systemText).toContain('IM.codes session identity:');
      expect(systemText).toContain('Exact session name: deck_quiet_brain');
      expect(systemText).not.toContain('Generated Image Reporting:');
    });

    it('emits identity / image-reporting peer-level with memory + progress guidance — single contiguous sessionSystemText', () => {
      // Order matters for prefix-cache friendliness: stable session-level
      // blocks should appear in a deterministic order so the model's
      // prompt cache hits across turns. The assembly order is:
      //   description -> systemPrompt -> identity -> image-reporting
      //   -> memory-search guidance -> agent progress guidance.
      const payload = buildProviderContextPayload(makeProvider('full-normalized-context-injection'), {
        userMessage: 'hi',
        description: 'desc-here',
        systemPrompt: 'sp-here',
        sessionIdentity: { sessionName: 'deck_order_brain', label: 'Order' },
        namespace: { scope: 'personal', projectId: 'repo-1' },
      });
      const systemText = payload.sessionSystemText ?? '';
      const descIdx = systemText.indexOf('desc-here');
      const spIdx = systemText.indexOf('sp-here');
      const identityIdx = systemText.indexOf('IM.codes session identity:');
      const imageIdx = systemText.indexOf('Generated Image Reporting:');
      const memoryIdx = systemText.indexOf('Use memory MCP search');
      const progressIdx = systemText.indexOf('Work transparently while you act.');
      expect(descIdx).toBeGreaterThanOrEqual(0);
      expect(spIdx).toBeGreaterThan(descIdx);
      expect(identityIdx).toBeGreaterThan(spIdx);
      expect(imageIdx).toBeGreaterThan(identityIdx);
      expect(memoryIdx).toBeGreaterThan(imageIdx);
      expect(progressIdx).toBeGreaterThan(memoryIdx);
    });
  });
});
