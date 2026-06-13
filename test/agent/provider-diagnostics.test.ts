import { describe, expect, it } from 'vitest';

import { ClaudeCodeSdkProvider } from '../../src/agent/providers/claude-code-sdk.js';
import { CodexSdkProvider } from '../../src/agent/providers/codex-sdk.js';
import { CopilotSdkProvider } from '../../src/agent/providers/copilot-sdk.js';
import { CursorHeadlessProvider } from '../../src/agent/providers/cursor-headless.js';
import { GeminiSdkProvider } from '../../src/agent/providers/gemini-sdk.js';
import { KimiSdkProvider } from '../../src/agent/providers/kimi-sdk.js';
import { QwenProvider } from '../../src/agent/providers/qwen.js';

type ProviderWithDiagnostics = {
  getSessionDiagnostics(sessionId: string): Record<string, unknown> | null;
};

function setSession(provider: unknown, sessionId: string, state: Record<string, unknown>): void {
  ((provider as { sessions: Map<string, Record<string, unknown>> }).sessions).set(sessionId, state);
}

function assertSafeDiagnostics(diagnostics: Record<string, unknown>): void {
  const serialized = JSON.stringify(diagnostics);
  expect(serialized).not.toContain('secret prompt');
  expect(serialized).not.toContain('SECRET_ENV');
  expect(serialized).not.toContain('/secret/project');
  expect(serialized).not.toContain('secret-setting');
  expect(serialized).not.toContain('secret-description');
  expect(serialized).not.toContain('secret-system');
}

describe('provider session diagnostics', () => {
  it('returns null for missing sessions on SDK providers', () => {
    const providers: ProviderWithDiagnostics[] = [
      new CodexSdkProvider(),
      new ClaudeCodeSdkProvider(),
      new QwenProvider(),
      new GeminiSdkProvider(),
      new KimiSdkProvider(),
      new CopilotSdkProvider(),
      new CursorHeadlessProvider(),
    ];

    for (const provider of providers) {
      expect(provider.getSessionDiagnostics('missing')).toBeNull();
    }
  });

  it('exposes safe active-state diagnostics for Codex SDK sessions', () => {
    const provider = new CodexSdkProvider();
    setSession(provider, 'codex-route', {
      routeId: 'codex-route',
      cwd: '/secret/project',
      env: { TOKEN: 'SECRET_ENV' },
      mcpConfig: { secret: 'secret-setting' },
      threadId: 'codex-thread',
      loaded: true,
      runningTurnId: 'codex-turn',
      turnStartInFlight: false,
      runningCompact: false,
      currentMessageId: 'msg-codex',
      currentText: 'secret prompt',
      idleStatusCompletionTimer: null,
      idleStatusCompletionTurnId: undefined,
      agentMessageCompletionTimer: null,
      agentMessageCompletionTurnId: undefined,
      agentMessageCompletionArmedAt: undefined,
      activeItemIds: new Set(['item-1']),
      cancelled: false,
      cancelTimer: null,
      compactSettleTimer: null,
      compactHardTimer: null,
      compactObserved: false,
      rawChecklistPollTimer: null,
    });

    const diagnostics = provider.getSessionDiagnostics('codex-route')!;

    expect(diagnostics).toMatchObject({
      provider: 'codex-sdk',
      active: true,
      activeReason: 'turn',
      threadId: 'codex-thread',
      runningTurnId: 'codex-turn',
      turnStartInFlight: false,
      activeItemCount: 1,
      activeItemIds: ['item-1'],
      currentMessageId: 'msg-codex',
      currentTextLength: 'secret prompt'.length,
    });
    assertSafeDiagnostics(diagnostics);
  });

  it('exposes safe active-state diagnostics for Claude SDK sessions', () => {
    const provider = new ClaudeCodeSdkProvider();
    setSession(provider, 'claude-route', {
      routeId: 'claude-route',
      cwd: '/secret/project',
      env: { TOKEN: 'SECRET_ENV' },
      settings: 'secret-setting',
      description: 'secret-description',
      systemPrompt: 'secret-system',
      started: true,
      resumeId: 'claude-resume',
      currentMessageId: 'msg-claude',
      currentText: 'secret prompt',
      currentQuery: {},
      currentChild: { killed: false },
      completed: false,
      cancelled: false,
      pendingComplete: undefined,
      pendingError: undefined,
      resultCompletionTimer: null,
      resultCompletionGeneration: undefined,
      turnGeneration: 3,
      toolCalls: new Map([['tool', {}]]),
      runtimeAgentToolCalls: new Map(),
      subagentTasks: new Map([['agent', {}]]),
    });

    const diagnostics = provider.getSessionDiagnostics('claude-route')!;

    expect(diagnostics).toMatchObject({
      provider: 'claude-code-sdk',
      active: true,
      activeReason: 'query',
      currentQueryActive: true,
      currentChildActive: true,
      currentMessageId: 'msg-claude',
      currentTextLength: 'secret prompt'.length,
      toolCallCount: 1,
      subagentTaskCount: 1,
    });
    assertSafeDiagnostics(diagnostics);
  });

  it('exposes safe active-state diagnostics for Qwen sessions', () => {
    const provider = new QwenProvider();
    setSession(provider, 'qwen-route', {
      cwd: '/secret/project',
      env: { TOKEN: 'SECRET_ENV' },
      settings: 'secret-setting',
      started: true,
      qwenConversationId: 'qwen-conversation',
      child: { killed: false },
      currentMessageId: 'msg-qwen',
      currentText: 'secret prompt',
      pendingFinalText: 'secret prompt',
      pendingFinalMetadata: { model: 'qwen' },
      cancelled: false,
      toolUseById: new Map([['tool', {}]]),
      toolUseByIndex: new Map([[0, {}]]),
      emittedToolSignatures: new Map([['tool', 'sig']]),
      sessionSystemTextInjected: 'secret-system',
    });

    const diagnostics = provider.getSessionDiagnostics('qwen-route')!;

    expect(diagnostics).toMatchObject({
      provider: 'qwen',
      active: true,
      activeReason: 'child',
      conversationId: 'qwen-conversation',
      childActive: true,
      currentMessageId: 'msg-qwen',
      currentTextLength: 'secret prompt'.length,
      pendingFinalTextLength: 'secret prompt'.length,
      toolUseCount: 1,
      toolUseIndexCount: 1,
    });
    assertSafeDiagnostics(diagnostics);
  });

  it('exposes safe active-state diagnostics for ACP SDK sessions', () => {
    const providers: Array<[GeminiSdkProvider | KimiSdkProvider, string]> = [
      [new GeminiSdkProvider(), 'gemini-sdk'],
      [new KimiSdkProvider(), 'kimi-sdk'],
    ];

    for (const [provider, providerId] of providers) {
      setSession(provider, `${providerId}-route`, {
        routeId: `${providerId}-route`,
        cwd: '/secret/project',
        env: { TOKEN: 'SECRET_ENV' },
        acpSessionId: `${providerId}-acp`,
        loaded: true,
        modeApplied: true,
        promptInFlight: true,
        replaying: false,
        cancelled: false,
        currentMessageId: `msg-${providerId}`,
        currentText: 'secret prompt',
        toolCalls: new Map([['tool', {}]]),
        emittedToolSignatures: new Map([['tool', 'sig']]),
        sessionSystemTextInjected: 'secret-system',
        lastTurnUsage: { output_tokens: 1 },
      });

      const diagnostics = provider.getSessionDiagnostics(`${providerId}-route`)!;

      expect(diagnostics).toMatchObject({
        provider: providerId,
        active: true,
        activeReason: 'prompt',
        acpSessionId: `${providerId}-acp`,
        promptInFlight: true,
        currentMessageId: `msg-${providerId}`,
        currentTextLength: 'secret prompt'.length,
        toolCallCount: 1,
        lastTurnUsagePresent: true,
      });
      assertSafeDiagnostics(diagnostics);
    }
  });

  it('exposes safe active-state diagnostics for Copilot SDK sessions', () => {
    const provider = new CopilotSdkProvider();
    setSession(provider, 'copilot-route', {
      routeId: 'copilot-route',
      sessionId: 'copilot-provider-session',
      session: {},
      cwd: '/secret/project',
      currentMessageId: 'msg-copilot',
      currentText: 'secret prompt',
      completionEmittedForCurrentTurn: false,
      busy: true,
      operation: 'turn',
      backgroundTainted: false,
      cancelRequested: false,
      cancelErrorEmitted: false,
      compactCompletionEmitted: false,
      rotationInProgress: false,
      generation: 5,
      pendingApprovals: new Map([['approval', {}]]),
      sessionSystemTextInjected: 'secret-system',
      sessionSystemTextPending: 'secret-system',
    });

    const diagnostics = provider.getSessionDiagnostics('copilot-route')!;

    expect(diagnostics).toMatchObject({
      provider: 'copilot-sdk',
      active: true,
      activeReason: 'turn',
      providerSessionId: 'copilot-provider-session',
      busy: true,
      operation: 'turn',
      currentMessageId: 'msg-copilot',
      currentTextLength: 'secret prompt'.length,
      pendingApprovalCount: 1,
    });
    assertSafeDiagnostics(diagnostics);
  });

  it('exposes safe active-state diagnostics for Cursor headless sessions', () => {
    const provider = new CursorHeadlessProvider();
    setSession(provider, 'cursor-route', {
      routeId: 'cursor-route',
      resumeId: 'cursor-resume',
      cwd: '/secret/project',
      mcpEnv: { TOKEN: 'SECRET_ENV' },
      child: { killed: false },
      currentMessageId: 'msg-cursor',
      currentText: 'secret prompt',
      pendingFinalText: 'secret prompt',
      pendingFinalMetadata: { model: 'cursor' },
      cancelled: false,
      completed: false,
      emittedToolSignatures: new Map([['tool', 'sig']]),
      sessionSystemTextInjected: 'secret-system',
    });

    const diagnostics = provider.getSessionDiagnostics('cursor-route')!;

    expect(diagnostics).toMatchObject({
      provider: 'cursor-headless',
      active: true,
      activeReason: 'child',
      resumeId: 'cursor-resume',
      childActive: true,
      currentMessageId: 'msg-cursor',
      currentTextLength: 'secret prompt'.length,
      pendingFinalTextLength: 'secret prompt'.length,
      emittedToolSignatureCount: 1,
    });
    assertSafeDiagnostics(diagnostics);
  });
});
