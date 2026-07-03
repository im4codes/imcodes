import { describe, expect, it } from 'vitest';
import { GeminiSdkProvider } from '../../src/agent/providers/gemini-sdk.js';
import type { ToolCallEvent } from '../../src/agent/transport-provider.js';
import {
  SDK_SUBAGENT_DETAIL_KIND,
  SDK_SUBAGENT_PROVIDER_KINDS,
  SDK_SUBAGENT_PROVIDERS,
  SDK_SUBAGENT_STATUS,
} from '../../shared/sdk-subagent-status.js';

function attachRoute(provider: GeminiSdkProvider, routeId = 'gemini-route') {
  const state = {
    routeId,
    cwd: '/tmp/project',
    model: 'gemini-2.5-pro',
    acpSessionId: 'acp-gemini-session',
    loaded: true,
    modeApplied: true,
    promptInFlight: true,
    replaying: false,
    cancelled: false,
    currentMessageId: null,
    currentText: '',
    toolCalls: new Map(),
    emittedToolSignatures: new Map(),
    lastStatusSignature: null,
  };
  (provider as any).sessions.set(routeId, state);
  (provider as any).acpToRoute.set('acp-gemini-session', routeId);
  return state;
}

describe('GeminiSdkProvider runtime subagent status', () => {
  it('emits SDK subagent snapshots for structured ACP runtime notifications', () => {
    const provider = new GeminiSdkProvider();
    const state = attachRoute(provider);
    const tools: ToolCallEvent[] = [];
    provider.onToolCall((_sessionId, tool) => tools.push(tool));

    (provider as any).handleSessionUpdate({
      sessionId: 'acp-gemini-session',
      update: {
        sessionUpdate: 'subagent_notification',
        subagent: {
          agent_path: '019e-gemini-agent',
          name: 'researcher',
          status: 'running',
          prompt: 'Check the Gemini handoff',
          is_backgrounded: true,
        },
      },
    });

    expect(state.currentText).toBe('');
    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({
      id: 'gemini:gemini-route:runtime:019e-gemini-agent',
      name: 'Agent',
      status: 'running',
      input: { action: 'gemini-runtime-subagent', description: 'Check the Gemini handoff' },
      detail: {
        kind: SDK_SUBAGENT_DETAIL_KIND,
        summary: 'Gemini sub-agent researcher',
        meta: {
          provider: SDK_SUBAGENT_PROVIDERS.GEMINI_SDK,
          providerKind: SDK_SUBAGENT_PROVIDER_KINDS.GEMINI_RUNTIME_AGENT,
          canonicalKey: 'gemini:gemini-route:runtime:019e-gemini-agent',
          normalizedStatus: SDK_SUBAGENT_STATUS.RUNNING,
          active: true,
          terminal: false,
          parentSessionId: 'gemini-route',
          agentPath: '019e-gemini-agent',
          agentName: 'researcher',
          model: 'gemini-2.5-pro',
          backgrounded: true,
        },
      },
    });
  });

  it('parses exact raw runtime tags from ACP agent message chunks without emitting assistant text', () => {
    const provider = new GeminiSdkProvider();
    attachRoute(provider, 'gemini-route-tag');
    const tools: ToolCallEvent[] = [];
    const deltas: string[] = [];
    provider.onToolCall((_sessionId, tool) => tools.push(tool));
    provider.onDelta((_sessionId, delta) => deltas.push(delta.delta));

    (provider as any).handleSessionUpdate({
      sessionId: 'acp-gemini-session',
      update: {
        sessionUpdate: 'agent_message_chunk',
        messageId: 'msg-runtime-tag',
        content: {
          type: 'text',
          text: '<subagent_notification>{"agent_path":"019e-gemini-raw","status":{"completed":"done"},"model":"gemini-2.5-flash"}</subagent_notification>',
        },
      },
    });

    expect(deltas).toEqual([]);
    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({
      id: 'gemini:gemini-route-tag:runtime:019e-gemini-raw',
      status: 'complete',
      output: 'done',
      detail: {
        meta: {
          provider: SDK_SUBAGENT_PROVIDERS.GEMINI_SDK,
          providerKind: SDK_SUBAGENT_PROVIDER_KINDS.GEMINI_RUNTIME_AGENT,
          normalizedStatus: SDK_SUBAGENT_STATUS.COMPLETE,
          active: false,
          terminal: true,
          model: 'gemini-2.5-flash',
        },
      },
    });
  });
});

describe('GeminiSdkProvider cross-message streaming accumulator', () => {
  it('resets the streaming accumulator at each new messageId so a second message is not prefixed with the first', () => {
    // A turn with a tool round produces TWO assistant messages with different
    // ACP messageIds. The second message's deltas must start fresh — not carry
    // the first message's full text as a prefix (the cross-message bleed bug).
    const provider = new GeminiSdkProvider();
    attachRoute(provider, 'gemini-route-bleed');

    const deltas: Array<{ id: string; text: string }> = [];
    provider.onDelta((_sessionId, delta) => deltas.push({ id: delta.messageId, text: delta.delta }));

    const chunk = (messageId: string, text: string) =>
      (provider as any).handleSessionUpdate({
        sessionId: 'acp-gemini-session',
        update: {
          sessionUpdate: 'agent_message_chunk',
          messageId,
          content: { type: 'text', text },
        },
      });

    chunk('m1', 'Let me check.');
    // ── tool round happens here; the model continues in a NEW message ──
    chunk('m2', 'The answer');
    chunk('m2', ' is 42.');

    const m1Deltas = deltas.filter((d) => d.id === 'm1').map((d) => d.text);
    expect(m1Deltas).toEqual(['Let me check.']);
    const m2Deltas = deltas.filter((d) => d.id === 'm2').map((d) => d.text);
    expect(m2Deltas).toEqual(['The answer', 'The answer is 42.']);
    expect(deltas.every((d) => !d.text.includes('Let me check.The answer'))).toBe(true);
  });
});
