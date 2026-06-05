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
