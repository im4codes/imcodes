import { describe, expect, it, vi } from 'vitest';
import { buildProviderContextPayload, dispatchSharedContextSend } from '../../src/agent/transport-runtime-assembly.js';
import type { TransportProvider } from '../../src/agent/transport-provider.js';

function makeProvider(contextSupport: NonNullable<TransportProvider['capabilities']['contextSupport']>): TransportProvider {
  const send = vi.fn(async () => {});
  return {
    id: 'mock',
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

describe('buildProviderContextPayload', () => {
  it('assembles normalized system context from description and runtime prompt', () => {
    const payload = buildProviderContextPayload(makeProvider('full-normalized-context-injection'), {
      userMessage: 'Run tests',
      description: 'Be concise',
      systemPrompt: 'Never edit generated files',
      namespace: { scope: 'personal', projectId: 'repo-1' },
    });

    expect(payload).toMatchObject({
      userMessage: 'Run tests',
      assembledMessage: 'Run tests',
      systemText: 'Be concise\n\nNever edit generated files',
      supportClass: 'full-normalized-context-injection',
    });
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
      systemText: expect.stringContaining('Required shared context:\n- Project coding standard'),
      context: expect.objectContaining({
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
});
