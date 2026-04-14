import { describe, expect, it } from 'vitest';
import { buildContextDiagnostics } from '../../src/agent/context-diagnostics.js';
import { buildProviderContextPayload } from '../../src/agent/transport-runtime-assembly.js';
import type { TransportProvider } from '../../src/agent/transport-provider.js';

function makeProvider(contextSupport: NonNullable<TransportProvider['capabilities']['contextSupport']>): TransportProvider {
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
    send: async () => {},
    onDelta: () => () => {},
    onComplete: () => () => {},
    onError: () => () => {},
  };
}

describe('buildContextDiagnostics', () => {
  it('combines authority, provider, provider-policy, and authored-context diagnostics deterministically', () => {
    const diagnostics = buildContextDiagnostics({
      authority: {
        namespace: { scope: 'project_shared', projectId: 'github.com/acme/repo', enterpriseId: 'ent-1' },
        authoritySource: 'processed_remote',
        freshness: 'fresh',
        fallbackAllowed: false,
        retryScheduled: true,
        providerPolicyOutcome: 'degraded-allowed',
        diagnostics: ['authority-shared', 'retry-scheduled'],
      },
      supportClass: 'degraded-message-side-context-mapping',
      artifact: {
        systemText: 'system',
        messagePreamble: 'preamble',
        requiredAuthoredContext: ['Required standard'],
        advisoryAuthoredContext: ['Advisory note'],
        appliedDocumentVersionIds: ['doc-v2', 'doc-v1'],
        diagnostics: ['authored-required:doc-v2', 'authored-advisory:doc-v1'],
      },
    });

    expect(diagnostics).toEqual(expect.arrayContaining([
      'authority-shared',
      'support:degraded-message-side-context-mapping',
      'authority:processed_remote',
      'freshness:fresh',
      'provider-policy:degraded-allowed',
      'retry-scheduled',
      'document-version:doc-v2',
      'document-version:doc-v1',
      'authored-required:doc-v2',
      'authored-advisory:doc-v1',
    ]));
    expect(new Set(diagnostics).size).toBe(diagnostics.length);
  });

  it('adds fallback-allowed only when the authority decision permits it', () => {
    const diagnostics = buildContextDiagnostics({
      authority: {
        namespace: { scope: 'personal', projectId: 'repo', userId: 'user-1' },
        authoritySource: 'processed_local',
        freshness: 'stale',
        fallbackAllowed: true,
        retryScheduled: false,
        providerPolicyOutcome: 'allowed',
        diagnostics: [],
      },
      supportClass: 'full-normalized-context-injection',
      artifact: {
        requiredAuthoredContext: [],
        advisoryAuthoredContext: [],
        appliedDocumentVersionIds: [],
        diagnostics: [],
      },
    });

    expect(diagnostics).toEqual(expect.arrayContaining([
      'support:full-normalized-context-injection',
      'authority:processed_local',
      'freshness:stale',
      'provider-policy:allowed',
      'fallback-allowed',
    ]));
  });

  it('builds diagnostics strictly from the authority decision rather than any omitted raw freshness inputs', () => {
    const payload = buildProviderContextPayload(makeProvider('full-normalized-context-injection'), {
      userMessage: 'Run tests',
      namespace: { scope: 'org_shared', projectId: 'repo', enterpriseId: 'ent-1' },
      remoteProcessedFreshness: 'missing',
      localProcessedFreshness: 'fresh',
      retryExhausted: true,
    });

    const diagnostics = buildContextDiagnostics({
      authority: payload.authority,
      supportClass: payload.supportClass,
      artifact: payload.context,
    });

    expect(diagnostics).toContain('authority:none');
    expect(diagnostics).toContain('freshness:missing');
    expect(diagnostics).toContain('provider-policy:allowed');
    expect(diagnostics).not.toContain('freshness:fresh');
    expect(diagnostics).not.toContain('authority:processed_local');
  });

  it('surfaces provider-policy:degraded-blocked when shared scope rejects degraded support', () => {
    const payload = buildProviderContextPayload(makeProvider('degraded-message-side-context-mapping'), {
      userMessage: 'Run tests',
      namespace: { scope: 'workspace_shared', projectId: 'repo', workspaceId: 'ws-1' },
      remoteProcessedFreshness: 'fresh',
      retryExhausted: true,
      sharedPolicyOverride: { allowDegradedProvider: false },
    });

    expect(payload.diagnostics).toContain('provider-policy:degraded-blocked');
    expect(payload.authority.providerPolicyOutcome).toBe('degraded-blocked');
  });
});
