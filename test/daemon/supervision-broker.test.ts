import { describe, expect, it, vi, beforeEach } from 'vitest';
import { normalizeSessionSupervisionSnapshot, SUPERVISION_MODE } from '../../shared/supervision-config.js';
import { SupervisionBroker, parseSupervisionDecision } from '../../src/daemon/supervision-broker.js';
import type { TransportProvider, ProviderError, SessionConfig } from '../../src/agent/transport-provider.js';
import type { AgentMessage, MessageDelta } from '../../shared/agent-message.js';

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
    expect(provider.send).toHaveBeenCalledTimes(2);
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
    await expect(second).resolves.toMatchObject({ decision: 'ask_human' });
    await expect(second).resolves.toHaveProperty('reason');
    vi.useRealTimers();
  });
});
