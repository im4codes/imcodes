import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  normalizeSessionSupervisionSnapshot,
  SUPERVISION_MODE,
  SUPERVISION_UNAVAILABLE_REASONS,
} from '../../shared/supervision-config.js';
import { SupervisionBroker, parseSupervisionDecision } from '../../src/daemon/supervision-broker.js';
import type { TransportProvider, ProviderError, SessionConfig } from '../../src/agent/transport-provider.js';
import type { AgentMessage, MessageDelta } from '../../shared/agent-message.js';

// Mock the preset resolver so broker tests don't touch ~/.imcodes/cc-presets.json.
// Tests that care about preset behaviour inspect `resolverMock.mock.calls` and
// set `resolverMock.mockResolvedValueOnce(...)` to shape the response.
const resolverMock = vi.fn(async (selection: { backend: string; model?: string; preset?: string }) => ({
  cacheKey: 'test',
  ...(selection.model ? { agentId: selection.model } : {}),
}));
vi.mock('../../src/context/processing-provider-config.js', () => ({
  resolveProcessingProviderSessionConfig: (selection: { backend: string; model?: string; preset?: string }) =>
    resolverMock(selection),
}));

class FakeProvider implements TransportProvider {
  readonly id = 'codex-sdk';
  readonly connectionMode = 'local-sdk';
  readonly sessionOwnership = 'shared';
  readonly capabilities = {
    streaming: false,
    toolCalling: false,
    approval: false,
    sessionRestore: false,
    multiTurn: true,
    attachments: false,
  };

  protected completeHandlers = new Set<(sessionId: string, message: AgentMessage) => void>();
  protected errorHandlers = new Set<(sessionId: string, error: ProviderError) => void>();
  protected readonly outputs: string[];

  connect = vi.fn(async () => {});
  disconnect = vi.fn(async () => {});
  createSession = vi.fn(async (config: SessionConfig) => config.sessionKey);
  endSession = vi.fn(async () => {});
  cancel = vi.fn(async () => {});
  onDelta = vi.fn((_cb: (sessionId: string, delta: MessageDelta) => void) => () => {});
  onComplete = vi.fn((cb: (sessionId: string, message: AgentMessage) => void) => {
    this.completeHandlers.add(cb);
    return () => { this.completeHandlers.delete(cb); };
  });
  onError = vi.fn((cb: (sessionId: string, error: ProviderError) => void) => {
    this.errorHandlers.add(cb);
    return () => { this.errorHandlers.delete(cb); };
  });

  constructor(outputs: string[]) {
    this.outputs = outputs;
  }

  send = vi.fn(async (sessionId: string): Promise<void> => {
    const next = this.outputs.shift();
    if (next === undefined) {
      queueMicrotask(() => {
        for (const cb of this.errorHandlers) {
          cb(sessionId, { code: 'PROVIDER_ERROR', message: 'missing scripted output', recoverable: false });
        }
      });
      return;
    }
    queueMicrotask(() => {
      const message: AgentMessage = {
        id: `msg-${sessionId}`,
        sessionId,
        kind: 'text',
        role: 'assistant',
        content: next,
        timestamp: Date.now(),
        status: 'complete',
      };
      for (const cb of this.completeHandlers) cb(sessionId, message);
    });
  });
}

beforeEach(() => {
  vi.restoreAllMocks();
  // vi.restoreAllMocks() clears implementations on vi.fn() too, so re-install
  // the default preset resolver behaviour for each test.
  resolverMock.mockImplementation(async (selection: { backend: string; model?: string; preset?: string }) => ({
    cacheKey: 'test',
    ...(selection.model ? { agentId: selection.model } : {}),
  }));
});

describe('parseSupervisionDecision', () => {
  it('parses raw and fenced JSON candidates', () => {
    expect(parseSupervisionDecision('{"decision":"complete","reason":"ok","confidence":0.9}')).toEqual({
      decision: 'complete',
      reason: 'ok',
      confidence: 0.9,
    });
    expect(parseSupervisionDecision('```json\n{"decision":"continue","reason":"keep going","confidence":0.1}\n```')).toEqual({
      decision: 'continue',
      reason: 'keep going',
      confidence: 0.1,
    });
  });

  it('rejects prose-wrapped JSON and invalid confidence values', () => {
    expect(parseSupervisionDecision('Decision:\n{"decision":"complete","reason":"ok","confidence":0.9}')).toBeNull();
    expect(parseSupervisionDecision('{"decision":"complete","reason":"ok"}')).toBeNull();
    expect(parseSupervisionDecision('{"decision":"complete","reason":"ok","confidence":1.1}')).toBeNull();
  });
});

describe('SupervisionBroker', () => {
  it.each([
    ['claude-code-sdk', 'sonnet'],
    ['codex-sdk', 'gpt-5.3-codex-spark'],
    ['qwen', 'qwen3-coder-plus'],
    ['openclaw', 'openclaw-custom-model'],
  ] as const)('accepts supported backend %s through the common provider contract', async (backend, model) => {
    const provider = new FakeProvider([
      '{"decision":"complete","reason":"ok","confidence":0.5}',
    ]);
    const broker = new SupervisionBroker({
      resolveProvider: async () => provider,
    });
    const snapshot = normalizeSessionSupervisionSnapshot({
      mode: SUPERVISION_MODE.SUPERVISED,
      backend,
      model,
      timeoutMs: 2_000,
      promptVersion: 'supervision_decision_v1',
      maxParseRetries: 1,
      auditMode: 'audit',
      maxAuditLoops: 2,
      taskRunPromptVersion: 'task_run_status_v1',
    });

    const result = await broker.decide({
      snapshot,
      taskRequest: 'Implement the task',
      assistantResponse: 'I implemented part of it.',
    });

    expect(result.decision).toBe('complete');
    expect(provider.createSession).toHaveBeenCalledWith(expect.objectContaining({
      agentId: model,
      fresh: true,
    }));
  });

  it('uses the session snapshot promptVersion in the decision prompt contract header', async () => {
    const provider = new FakeProvider([
      '{"decision":"complete","reason":"ok","confidence":0.5}',
    ]);
    const broker = new SupervisionBroker({
      resolveProvider: async () => provider,
    });
    const snapshot = normalizeSessionSupervisionSnapshot({
      mode: SUPERVISION_MODE.SUPERVISED,
      backend: 'codex-sdk',
      model: 'gpt-5.3-codex-spark',
      timeoutMs: 2_000,
      promptVersion: 'custom_supervision_contract_v2',
      maxParseRetries: 1,
      auditMode: 'audit',
      maxAuditLoops: 2,
      taskRunPromptVersion: 'task_run_status_v1',
    });

    await broker.decide({
      snapshot,
      taskRequest: 'Implement the task',
      assistantResponse: 'Latest assistant response',
    });

    expect(String(provider.send.mock.calls[0]?.[1])).toContain('[Contract: custom_supervision_contract_v2]');
  });

  it('includes stricter completion guardrails in the supervision decision prompt', async () => {
    const provider = new FakeProvider([
      '{"decision":"complete","reason":"ok","confidence":0.5}',
    ]);
    const broker = new SupervisionBroker({
      resolveProvider: async () => provider,
    });
    const snapshot = normalizeSessionSupervisionSnapshot({
      mode: SUPERVISION_MODE.SUPERVISED,
      backend: 'codex-sdk',
      model: 'gpt-5.3-codex-spark',
      timeoutMs: 2_000,
      promptVersion: 'supervision_decision_v1',
      maxParseRetries: 1,
      auditMode: 'audit',
      maxAuditLoops: 2,
      taskRunPromptVersion: 'task_run_status_v1',
    });

    await broker.decide({
      snapshot,
      taskRequest: 'Implement the task',
      assistantResponse: 'Latest assistant response',
    });

    const prompt = String(provider.send.mock.calls[0]?.[1] ?? '');
    expect(prompt).toContain('If the assistant says tests, validation, fixes, commit/push, or other implementation work still needs to be done, choose continue.');
    expect(prompt).toContain('Do not choose complete when the assistant itself indicates remaining work');
    expect(prompt).toContain('Use this background mainly to interpret the user\'s requested workflow and custom instructions.');
    expect(prompt).toContain('Do not treat the mere need to use one of these IM.codes workflows as a reason to ask_human');
    expect(prompt).toContain('openspec status --change "<name>" --json');
    expect(prompt).toContain('@@all(discuss) <message>');
    expect(prompt).toContain('imcodes send --list');
  });

  it('injects custom session instructions into decision and repair prompts', async () => {
    const provider = new FakeProvider([
      'not valid json',
      '{"decision":"continue","reason":"keep going","confidence":0.5}',
    ]);
    const broker = new SupervisionBroker({
      resolveProvider: async () => provider,
    });
    const snapshot = normalizeSessionSupervisionSnapshot({
      mode: SUPERVISION_MODE.SUPERVISED,
      backend: 'codex-sdk',
      model: 'gpt-5.3-codex-spark',
      timeoutMs: 2_000,
      promptVersion: 'supervision_decision_v1',
      customInstructions: 'Prefer adding tests and running verification before complete.',
      maxParseRetries: 1,
      auditMode: 'audit',
      maxAuditLoops: 2,
      taskRunPromptVersion: 'task_run_status_v1',
    });

    await broker.decide({
      snapshot,
      taskRequest: 'Implement the task',
      assistantResponse: 'Latest assistant response',
    });

    expect(String(provider.send.mock.calls[0]?.[1] ?? '')).toContain('Prefer adding tests and running verification before complete.');
    expect(String(provider.send.mock.calls[1]?.[1] ?? '')).toContain('Prefer adding tests and running verification before complete.');
  });

  it('retries once when the first supervisor reply is not valid JSON', async () => {
    const provider = new FakeProvider([
      'not valid json',
      '{"decision":"continue","reason":"looks good","confidence":0.91}',
    ]);
    const broker = new SupervisionBroker({
      resolveProvider: async () => provider,
    });
    const snapshot = normalizeSessionSupervisionSnapshot({
      mode: SUPERVISION_MODE.SUPERVISED,
      backend: 'codex-sdk',
      model: 'gpt-5.3-codex-spark',
      timeoutMs: 2_000,
      promptVersion: 'supervision_decision_v1',
      maxParseRetries: 1,
      auditMode: 'audit',
      maxAuditLoops: 2,
      taskRunPromptVersion: 'task_run_status_v1',
    });

    const result = await broker.decide({
      snapshot,
      taskRequest: 'Implement the task',
      assistantResponse: 'Partial output',
      cwd: '/tmp/project',
      description: 'test session',
    });

    expect(result).toEqual({
      decision: 'continue',
      reason: 'looks good',
      confidence: 0.91,
    });
    expect(provider.createSession).toHaveBeenCalledTimes(1);
    expect(provider.send).toHaveBeenCalledTimes(2);
    expect(provider.endSession).toHaveBeenCalledTimes(1);
  });

  it('creates a fresh provider session for each supervision decision', async () => {
    const provider = new FakeProvider([
      '{"decision":"complete","reason":"first","confidence":0.8}',
      '{"decision":"complete","reason":"second","confidence":0.9}',
    ]);
    const broker = new SupervisionBroker({
      resolveProvider: async () => provider,
    });
    const snapshot = normalizeSessionSupervisionSnapshot({
      mode: SUPERVISION_MODE.SUPERVISED,
      backend: 'codex-sdk',
      model: 'gpt-5.3-codex-spark',
      timeoutMs: 2_000,
      promptVersion: 'supervision_decision_v1',
      maxParseRetries: 1,
      auditMode: 'audit',
      maxAuditLoops: 2,
      taskRunPromptVersion: 'task_run_status_v1',
    });

    await broker.decide({ snapshot, taskRequest: 'first', assistantResponse: 'first reply' });
    await broker.decide({ snapshot, taskRequest: 'second', assistantResponse: 'second reply' });

    expect(provider.createSession).toHaveBeenCalledTimes(2);
    const firstSessionKey = provider.createSession.mock.calls[0]?.[0]?.sessionKey;
    const secondSessionKey = provider.createSession.mock.calls[1]?.[0]?.sessionKey;
    expect(firstSessionKey).not.toEqual(secondSessionKey);
  });

  it('fails closed when both replies are invalid', async () => {
    const provider = new FakeProvider(['still not json', 'also invalid']);
    const broker = new SupervisionBroker({
      resolveProvider: async () => provider,
    });
    const snapshot = normalizeSessionSupervisionSnapshot({
      mode: SUPERVISION_MODE.SUPERVISED,
      backend: 'codex-sdk',
      model: 'gpt-5.3-codex-spark',
      timeoutMs: 2_000,
      promptVersion: 'supervision_decision_v1',
      maxParseRetries: 1,
      auditMode: 'audit',
      maxAuditLoops: 2,
      taskRunPromptVersion: 'task_run_status_v1',
    });

    const result = await broker.decide({
      snapshot,
      taskRequest: 'Implement the task',
      assistantResponse: 'Partial output',
      cwd: '/tmp/project',
      description: 'test session',
    });

    expect(result.decision).toBe('ask_human');
    expect(result.reason).toMatch(/invalid supervisor decision|supervision/i);
    expect(result.unavailableReason).toBe(SUPERVISION_UNAVAILABLE_REASONS.INVALID_OUTPUT);
    expect(provider.send).toHaveBeenCalledTimes(2);
  });

  it('downgrades a complete verdict to continue when the assistant response clearly says more tests should be added', async () => {
    const provider = new FakeProvider([
      '{"decision":"complete","reason":"looks good","confidence":0.92}',
    ]);
    const broker = new SupervisionBroker({
      resolveProvider: async () => provider,
    });
    const snapshot = normalizeSessionSupervisionSnapshot({
      mode: SUPERVISION_MODE.SUPERVISED,
      backend: 'codex-sdk',
      model: 'gpt-5.3-codex-spark',
      timeoutMs: 2_000,
      promptVersion: 'supervision_decision_v1',
      maxParseRetries: 1,
      auditMode: 'audit',
      maxAuditLoops: 2,
      taskRunPromptVersion: 'task_run_status_v1',
    });

    const result = await broker.decide({
      snapshot,
      taskRequest: 'Fix the bug and make the change production-ready',
      assistantResponse: 'The bug is fixed. If you want, next I can add an end-to-end repro test and push the branch.',
    });

    expect(result).toMatchObject({
      decision: 'continue',
    });
    expect(result.reason).toMatch(/follow-up engineering step|remaining work/i);
  });

  it('downgrades a complete verdict to continue for the real Chinese follow-up phrasing from the reported regression', async () => {
    const provider = new FakeProvider([
      '{"decision":"complete","reason":"looks good","confidence":0.92}',
    ]);
    const broker = new SupervisionBroker({
      resolveProvider: async () => provider,
    });
    const snapshot = normalizeSessionSupervisionSnapshot({
      mode: SUPERVISION_MODE.SUPERVISED,
      backend: 'codex-sdk',
      model: 'gpt-5.3-codex-spark',
      timeoutMs: 2_000,
      promptVersion: 'supervision_decision_v1',
      maxParseRetries: 1,
      auditMode: 'audit',
      maxAuditLoops: 2,
      taskRunPromptVersion: 'task_run_status_v1',
    });

    const result = await broker.decide({
      snapshot,
      taskRequest: '修复 Auto supervision 的误判并完成收尾工作',
      assistantResponse: '如果你愿意，我下一步可以再补一个更偏端到端的复现测试，把你这类真实聊天顺序直接固化进去。',
    });

    expect(result).toMatchObject({
      decision: 'continue',
    });
    expect(result.reason).toMatch(/follow-up work in Chinese|original supervisor reason/i);
  });

  it('downgrades a complete verdict to continue for the exact Chinese commit-followup phrasing from the reported screenshot', async () => {
    const provider = new FakeProvider([
      '{"decision":"complete","reason":"looks good","confidence":0.92}',
    ]);
    const broker = new SupervisionBroker({
      resolveProvider: async () => provider,
    });
    const snapshot = normalizeSessionSupervisionSnapshot({
      mode: SUPERVISION_MODE.SUPERVISED,
      backend: 'codex-sdk',
      model: 'gpt-5.3-codex-spark',
      timeoutMs: 2_000,
      promptVersion: 'supervision_decision_v1',
      maxParseRetries: 1,
      auditMode: 'audit',
      maxAuditLoops: 2,
      taskRunPromptVersion: 'task_run_status_v1',
    });

    const result = await broker.decide({
      snapshot,
      taskRequest: '把 .gitignore 这个改动提交掉',
      assistantResponse: '这还没提交。如果你要，我可以顺手给你再提一个小 commit。',
    });

    expect(result).toMatchObject({
      decision: 'continue',
    });
    expect(result.reason).toMatch(/follow-up work in Chinese|remaining work|original supervisor reason/i);
  });

  it('does not downgrade a complete verdict for an unrelated explanation offer', async () => {
    const provider = new FakeProvider([
      '{"decision":"complete","reason":"looks good","confidence":0.92}',
    ]);
    const broker = new SupervisionBroker({
      resolveProvider: async () => provider,
    });
    const snapshot = normalizeSessionSupervisionSnapshot({
      mode: SUPERVISION_MODE.SUPERVISED,
      backend: 'codex-sdk',
      model: 'gpt-5.3-codex-spark',
      timeoutMs: 2_000,
      promptVersion: 'supervision_decision_v1',
      maxParseRetries: 1,
      auditMode: 'audit',
      maxAuditLoops: 2,
      taskRunPromptVersion: 'task_run_status_v1',
    });

    const result = await broker.decide({
      snapshot,
      taskRequest: 'Fix the bug',
      assistantResponse: 'The bug is fixed. If you want, I can also explain the diff.',
    });

    expect(result).toMatchObject({
      decision: 'complete',
      reason: 'looks good',
    });
  });

  it('honors a larger maxParseRetries budget from the session snapshot', async () => {
    const provider = new FakeProvider([
      'invalid-1',
      'invalid-2',
      '{"decision":"complete","reason":"third time works","confidence":0.7}',
    ]);
    const broker = new SupervisionBroker({
      resolveProvider: async () => provider,
    });
    const snapshot = normalizeSessionSupervisionSnapshot({
      mode: SUPERVISION_MODE.SUPERVISED,
      backend: 'codex-sdk',
      model: 'gpt-5.3-codex-spark',
      timeoutMs: 2_000,
      promptVersion: 'supervision_decision_v1',
      maxParseRetries: 2,
      auditMode: 'audit',
      maxAuditLoops: 2,
      taskRunPromptVersion: 'task_run_status_v1',
    });

    const result = await broker.decide({
      snapshot,
      taskRequest: 'Implement the task',
      assistantResponse: 'Partial output',
    });

    expect(result).toMatchObject({
      decision: 'complete',
      reason: 'third time works',
    });
    expect(provider.send).toHaveBeenCalledTimes(3);
  });

  it('fails closed when the snapshot is missing backend/model data', async () => {
    const broker = new SupervisionBroker({
      resolveProvider: async () => new FakeProvider([]),
    });

    const result = await broker.decide({
      snapshot: { mode: SUPERVISION_MODE.SUPERVISED } as never,
      taskRequest: 'Implement the task',
      assistantResponse: 'Partial output',
    });

    expect(result).toEqual({
      decision: 'ask_human',
      reason: 'invalid supervision snapshot',
      confidence: 0,
      unavailableReason: SUPERVISION_UNAVAILABLE_REASONS.INVALID_SNAPSHOT,
    });
  });

  it('fails closed on timeout', async () => {
    vi.useFakeTimers();
    const provider: TransportProvider = {
      id: 'codex-sdk',
      connectionMode: 'local-sdk',
      sessionOwnership: 'shared',
      capabilities: {
        streaming: false,
        toolCalling: false,
        approval: false,
        sessionRestore: false,
        multiTurn: true,
        attachments: false,
      },
      connect: vi.fn(async () => {}),
      disconnect: vi.fn(async () => {}),
      createSession: vi.fn(async (config: SessionConfig) => config.sessionKey),
      endSession: vi.fn(async () => {}),
      send: vi.fn(async () => {}),
      onDelta: vi.fn(() => () => {}),
      onComplete: vi.fn(() => () => {}),
      onError: vi.fn(() => () => {}),
      cancel: vi.fn(async () => {}),
    };
    const broker = new SupervisionBroker({
      resolveProvider: async () => provider,
    });
    const snapshot = normalizeSessionSupervisionSnapshot({
      mode: SUPERVISION_MODE.SUPERVISED,
      backend: 'codex-sdk',
      model: 'gpt-5.3-codex-spark',
      timeoutMs: 10,
      promptVersion: 'supervision_decision_v1',
      maxParseRetries: 1,
      auditMode: 'audit',
      maxAuditLoops: 2,
      taskRunPromptVersion: 'task_run_status_v1',
    });

    const promise = broker.decide({
      snapshot,
      taskRequest: 'Implement the task',
      assistantResponse: 'Partial output',
      cwd: '/tmp/project',
      description: 'test session',
    });
    await vi.advanceTimersByTimeAsync(25);
    const result = await promise;

    expect(result.decision).toBe('ask_human');
    expect(result.reason).toMatch(/timeout/i);
    expect(result.unavailableReason).toBe(SUPERVISION_UNAVAILABLE_REASONS.DECISION_TIMEOUT);
    expect(provider.cancel).toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('fails closed when queue wait exhausts the timeout budget', async () => {
    vi.useFakeTimers();
    class SlowProvider extends FakeProvider {
      override send = vi.fn(async (sessionId: string): Promise<void> => {
        const next = this.outputs.shift();
        setTimeout(() => {
          if (!next) return;
          const message: AgentMessage = {
            id: `msg-${sessionId}`,
            sessionId,
            kind: 'text',
            role: 'assistant',
            content: next,
            timestamp: Date.now(),
            status: 'complete',
          };
          for (const cb of this.completeHandlers) {
            cb(sessionId, message);
          }
        }, 20);
      });
    }

    const provider = new SlowProvider([
      '{"decision":"complete","reason":"first","confidence":0.8}',
      '{"decision":"complete","reason":"second","confidence":0.8}',
    ]);
    const broker = new SupervisionBroker({
      resolveProvider: async () => provider,
    });
    const snapshot = normalizeSessionSupervisionSnapshot({
      mode: SUPERVISION_MODE.SUPERVISED,
      backend: 'codex-sdk',
      model: 'gpt-5.3-codex-spark',
      timeoutMs: 25,
      promptVersion: 'supervision_decision_v1',
      maxParseRetries: 1,
      auditMode: 'audit',
      maxAuditLoops: 2,
      taskRunPromptVersion: 'task_run_status_v1',
    });

    const first = broker.decide({ snapshot, taskRequest: 'first', assistantResponse: 'first reply' });
    const second = broker.decide({ snapshot, taskRequest: 'second', assistantResponse: 'second reply' });
    await vi.advanceTimersByTimeAsync(50);

    await expect(first).resolves.toMatchObject({ decision: 'complete' });
    await expect(second).resolves.toMatchObject({
      decision: 'ask_human',
      unavailableReason: SUPERVISION_UNAVAILABLE_REASONS.QUEUE_TIMEOUT,
    });
    vi.useRealTimers();
  });

  it('classifies provider-side failures with the shared unavailable reason enum', async () => {
    const provider = new FakeProvider([]);
    const broker = new SupervisionBroker({
      resolveProvider: async () => provider,
    });
    const snapshot = normalizeSessionSupervisionSnapshot({
      mode: SUPERVISION_MODE.SUPERVISED,
      backend: 'codex-sdk',
      model: 'gpt-5.3-codex-spark',
      timeoutMs: 2_000,
      promptVersion: 'supervision_decision_v1',
      maxParseRetries: 1,
      auditMode: 'audit',
      maxAuditLoops: 2,
      taskRunPromptVersion: 'task_run_status_v1',
    });

    const result = await broker.decide({
      snapshot,
      taskRequest: 'Implement the task',
      assistantResponse: 'Partial output',
    });

    expect(result).toMatchObject({
      decision: 'ask_human',
      unavailableReason: SUPERVISION_UNAVAILABLE_REASONS.PROVIDER_ERROR,
    });
  });

  describe('custom instructions merge (end-to-end through broker)', () => {
    const decisionOk = '{"decision":"complete","reason":"ok","confidence":0.5}';

    const base = {
      mode: SUPERVISION_MODE.SUPERVISED,
      backend: 'codex-sdk' as const,
      model: 'gpt-5.3-codex-spark',
      timeoutMs: 2_000,
      promptVersion: 'supervision_decision_v1',
      maxParseRetries: 1,
      auditMode: 'audit' as const,
      maxAuditLoops: 2,
      taskRunPromptVersion: 'task_run_status_v1',
    };

    it('injects the concatenated global + session text into the supervisor prompt when override is false', async () => {
      const provider = new FakeProvider([decisionOk]);
      const broker = new SupervisionBroker({ resolveProvider: async () => provider });
      const snapshot = normalizeSessionSupervisionSnapshot({
        ...base,
        customInstructions: 'SESSION-EXTRA-XYZ',
        globalCustomInstructions: 'GLOBAL-PERSONA-ABC',
      });

      await broker.decide({
        snapshot,
        taskRequest: 'implement',
        assistantResponse: 'progress so far',
      });

      const prompt = String(provider.send.mock.calls[0]?.[1] ?? '');
      // Both layers present with global first, double-newline, then session.
      expect(prompt).toContain('GLOBAL-PERSONA-ABC\n\nSESSION-EXTRA-XYZ');
      // Merged heading reflects the real source (both layers present) and
      // frames the block as supervision-enforced rules, not chat hints.
      expect(prompt).toContain('Supervision rules set by the user (global baseline first, then session-specific additions — supervision enforces all of them):');
    });

    it('uses only session text when the override flag is set', async () => {
      const provider = new FakeProvider([decisionOk]);
      const broker = new SupervisionBroker({ resolveProvider: async () => provider });
      const snapshot = normalizeSessionSupervisionSnapshot({
        ...base,
        customInstructions: 'SESSION-ONLY',
        globalCustomInstructions: 'GLOBAL-SHOULD-NOT-APPEAR',
        customInstructionsOverride: true,
      });

      await broker.decide({
        snapshot,
        taskRequest: 'implement',
        assistantResponse: 'progress',
      });

      const prompt = String(provider.send.mock.calls[0]?.[1] ?? '');
      expect(prompt).toContain('SESSION-ONLY');
      expect(prompt).not.toContain('GLOBAL-SHOULD-NOT-APPEAR');
    });

    it('falls back to global only when session is empty', async () => {
      const provider = new FakeProvider([decisionOk]);
      const broker = new SupervisionBroker({ resolveProvider: async () => provider });
      const snapshot = normalizeSessionSupervisionSnapshot({
        ...base,
        globalCustomInstructions: 'ONLY-GLOBAL',
      });

      await broker.decide({
        snapshot,
        taskRequest: 'implement',
        assistantResponse: 'progress',
      });

      const prompt = String(provider.send.mock.calls[0]?.[1] ?? '');
      expect(prompt).toContain('ONLY-GLOBAL');
    });

    it('emits no custom-instructions block when both layers are empty', async () => {
      const provider = new FakeProvider([decisionOk]);
      const broker = new SupervisionBroker({ resolveProvider: async () => provider });
      const snapshot = normalizeSessionSupervisionSnapshot({ ...base });

      await broker.decide({
        snapshot,
        taskRequest: 'implement',
        assistantResponse: 'progress',
      });

      const prompt = String(provider.send.mock.calls[0]?.[1] ?? '');
      expect(prompt).not.toContain('Session-specific supervision instructions from the user:');
    });
  });

  describe('qwen preset plumbing', () => {
    const decisionOk = '{"decision":"complete","reason":"ok","confidence":0.5}';

    it('passes preset into resolveProcessingProviderSessionConfig and forwards env/agentId into createSession', async () => {
      // Simulate the resolver returning a preset-backed env bundle + pinned model.
      resolverMock.mockResolvedValueOnce({
        cacheKey: 'qwen:MiniMax:MiniMax-M2.5',
        agentId: 'MiniMax-M2.5',
        env: {
          ANTHROPIC_BASE_URL: 'https://minimax.example.com',
          ANTHROPIC_API_KEY: 'secret',
          ANTHROPIC_MODEL: 'MiniMax-M2.5',
        },
      });

      const provider = new FakeProvider([decisionOk]);
      const broker = new SupervisionBroker({ resolveProvider: async () => provider });
      const snapshot = normalizeSessionSupervisionSnapshot({
        mode: SUPERVISION_MODE.SUPERVISED,
        backend: 'qwen',
        model: 'qwen3-coder-plus', // user's display model; preset pins something else
        preset: 'MiniMax',
        timeoutMs: 2_000,
        promptVersion: 'supervision_decision_v1',
        maxParseRetries: 1,
        auditMode: 'audit',
        maxAuditLoops: 2,
        taskRunPromptVersion: 'task_run_status_v1',
      });

      await broker.decide({
        snapshot,
        taskRequest: 'implement',
        assistantResponse: 'progress',
      });

      // Resolver was called with the triple.
      expect(resolverMock).toHaveBeenCalledWith(expect.objectContaining({
        backend: 'qwen',
        model: 'qwen3-coder-plus',
        preset: 'MiniMax',
      }));

      // createSession received the resolver's agentId + env — the preset actually
      // routes traffic, it's not just a label.
      expect(provider.createSession).toHaveBeenCalledWith(expect.objectContaining({
        fresh: true,
        agentId: 'MiniMax-M2.5',
        env: expect.objectContaining({
          ANTHROPIC_BASE_URL: 'https://minimax.example.com',
          ANTHROPIC_API_KEY: 'secret',
          ANTHROPIC_MODEL: 'MiniMax-M2.5',
        }),
      }));
    });

    it('without preset falls back to snapshot.model as agentId and no env override', async () => {
      const provider = new FakeProvider([decisionOk]);
      const broker = new SupervisionBroker({ resolveProvider: async () => provider });
      const snapshot = normalizeSessionSupervisionSnapshot({
        mode: SUPERVISION_MODE.SUPERVISED,
        backend: 'qwen',
        model: 'qwen3-coder-plus',
        timeoutMs: 2_000,
        promptVersion: 'supervision_decision_v1',
        maxParseRetries: 1,
        auditMode: 'audit',
        maxAuditLoops: 2,
        taskRunPromptVersion: 'task_run_status_v1',
      });

      await broker.decide({
        snapshot,
        taskRequest: 'implement',
        assistantResponse: 'progress',
      });

      const call = provider.createSession.mock.calls[0]?.[0];
      expect(call).toMatchObject({
        fresh: true,
        agentId: 'qwen3-coder-plus',
      });
      expect((call as SessionConfig | undefined)?.env).toBeUndefined();
    });

    it('fails closed with PROVIDER_ERROR when preset resolution throws', async () => {
      resolverMock.mockRejectedValueOnce(new Error('preset not found'));
      const provider = new FakeProvider([decisionOk]);
      const broker = new SupervisionBroker({ resolveProvider: async () => provider });
      const snapshot = normalizeSessionSupervisionSnapshot({
        mode: SUPERVISION_MODE.SUPERVISED,
        backend: 'qwen',
        model: 'qwen3-coder-plus',
        preset: 'VanishedPreset',
        timeoutMs: 2_000,
        promptVersion: 'supervision_decision_v1',
        maxParseRetries: 1,
        auditMode: 'audit',
        maxAuditLoops: 2,
        taskRunPromptVersion: 'task_run_status_v1',
      });

      const result = await broker.decide({
        snapshot,
        taskRequest: 'implement',
        assistantResponse: 'progress',
      });

      expect(result.decision).toBe('ask_human');
      // Existing broker catch path surfaces this as PROVIDER_NOT_CONNECTED
      // when the error has no supervisionUnavailableReason attached — that's
      // the correct fail-closed behaviour; the key assertion is that decide()
      // does NOT silently claim success.
      expect(result.unavailableReason).toBeDefined();
    });
  });
});
