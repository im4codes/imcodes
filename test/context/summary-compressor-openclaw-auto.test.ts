import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CompressionInput } from '../../src/context/summary-compressor.js';
import {
  defaultSharedContextRuntimeConfig,
  resolveEffectiveSharedContextRuntimeConfig,
} from '../../shared/shared-context-runtime-config.js';

interface SentFrame {
  type?: string;
  id?: string;
  method?: string;
  params?: Record<string, unknown>;
}

const gatewayState = vi.hoisted(() => ({
  sentFrames: [] as SentFrame[],
  lastWs: null as { emit: (event: string, data: string) => void } | null,
  rejectModels: new Set<string>(),
}));

vi.mock('ws', () => {
  const { EventEmitter } = require('node:events') as typeof import('node:events');

  class MockWebSocket extends EventEmitter {
    static OPEN = 1;
    readyState = 1;

    constructor(_url?: string) {
      super();
      gatewayState.lastWs = this as unknown as { emit: (event: string, data: string) => void };
      queueMicrotask(() => {
        this.emit('message', JSON.stringify({ type: 'event', event: 'connect.challenge', payload: { nonce: 'n1' } }));
        this.emit('message', JSON.stringify({ type: 'event', event: 'hello-ok' }));
      });
    }

    send(data: string) {
      const frame = JSON.parse(data) as SentFrame;
      gatewayState.sentFrames.push(frame);
      if (frame.type !== 'req' || !frame.id) return;

      if (frame.method === 'sessions.create') {
        const agentId = String(frame.params?.agentId ?? '');
        if (agentId !== 'main') {
          this.emit('message', JSON.stringify({
            type: 'res',
            id: frame.id,
            ok: false,
            payload: { error: `unknown agentId: ${agentId}` },
          }));
          return;
        }
        this.emit('message', JSON.stringify({ type: 'res', id: frame.id, ok: true, payload: {} }));
        return;
      }

      if (frame.method === 'sessions.patch') {
        const patchedModel = typeof frame.params?.model === 'string' ? frame.params.model : undefined;
        if (patchedModel && gatewayState.rejectModels.has(patchedModel)) {
          this.emit('message', JSON.stringify({
            type: 'res',
            id: frame.id,
            ok: false,
            payload: { error: `INVALID_REQUEST: disallowed model ${patchedModel}` },
          }));
          return;
        }
        this.emit('message', JSON.stringify({ type: 'res', id: frame.id, ok: true, payload: {} }));
        return;
      }

      if (frame.method === 'sessions.send') {
        const key = String(frame.params?.key ?? '');
        const runId = `oc-run-${gatewayState.sentFrames.length}`;
        this.emit('message', JSON.stringify({ type: 'res', id: frame.id, ok: true, payload: {} }));
        queueMicrotask(() => {
          this.emit('message', JSON.stringify({
            type: 'event',
            event: 'agent',
            payload: { runId, key, stream: 'lifecycle', data: { phase: 'start' } },
          }));
          this.emit('message', JSON.stringify({
            type: 'event',
            event: 'agent',
            payload: { runId, key, stream: 'assistant', data: { text: '## Problem\nOpenClaw gateway default summary' } },
          }));
          this.emit('message', JSON.stringify({
            type: 'event',
            event: 'agent',
            payload: { runId, key, stream: 'lifecycle', data: { phase: 'end' } },
          }));
        });
        return;
      }

      this.emit('message', JSON.stringify({ type: 'res', id: frame.id, ok: true, payload: {} }));
    }

    close() {
      this.readyState = 3;
      this.emit('close', 1000, Buffer.from(''));
    }

    removeAllListeners() {
      super.removeAllListeners();
      return this;
    }
  }

  return { default: MockWebSocket, __esModule: true };
});

describe('summary-compressor — openclaw Auto routing with mock gateway', () => {
  beforeEach(async () => {
    gatewayState.sentFrames = [];
    gatewayState.lastWs = null;
    gatewayState.rejectModels.clear();
    const { connectProvider } = await import('../../src/agent/provider-registry.js');
    await connectProvider('openclaw', { url: 'ws://mock-openclaw', token: 'tok' });
    const { resetFailureTracking, resetActiveCompressionRunsForTests, resumeAcceptingCompression } = await import('../../src/context/summary-compressor.js');
    resetFailureTracking();
    resetActiveCompressionRunsForTests();
    resumeAcceptingCompression();
  });

  afterEach(async () => {
    const { shutdownCompressionProvider, resetFailureTracking, resetActiveCompressionRunsForTests } = await import('../../src/context/summary-compressor.js');
    await shutdownCompressionProvider();
    resetFailureTracking();
    resetActiveCompressionRunsForTests();
    const { disconnectAll } = await import('../../src/agent/provider-registry.js');
    await disconnectAll();
  });

  it('uses configured gateway agentId (main) instead of passing context model name as agentId, avoiding fallback', async () => {
    const effective = resolveEffectiveSharedContextRuntimeConfig(defaultSharedContextRuntimeConfig(), {
      sessionAgentType: 'openclaw',
    });
    expect(effective.primaryContextBackend).toBe('openclaw');
    expect(effective.primaryContextModel).toBe('default');

    const { compressWithSdk } = await import('../../src/context/summary-compressor.js');
    const input: CompressionInput = {
      events: [
        { type: 'user.turn', content: 'Summarize openclaw gateway task', createdAt: 100 } as unknown as CompressionInput['events'][number],
      ],
      modelConfig: effective,
    };

    const result = await compressWithSdk(input);
    expect(result.fromSdk).toBe(true);
    expect(result.usedBackup).toBe(false);
    expect(result.backend).toBe('openclaw');
    expect(result.summary).toContain('OpenClaw gateway default summary');

    const createFrame = gatewayState.sentFrames.find((f) => f.method === 'sessions.create');
    expect(createFrame).toBeDefined();
    expect(createFrame?.params?.agentId).toBe('main');

    const sendFrame = gatewayState.sentFrames.find((f) => f.method === 'sessions.send');
    expect(sendFrame).toBeDefined();
    expect(String(sendFrame?.params?.key ?? '')).toMatch(/^agent:main:/);
    expect(String(sendFrame?.params?.key ?? '')).not.toContain('agent:sonnet:');
    expect(String(sendFrame?.params?.key ?? '')).not.toContain('agent:default:');
    expect(gatewayState.sentFrames.some((f) => f.method === 'sessions.patch' && f.params?.model !== undefined)).toBe(false);
  });

  it('applies distinct Manual OpenClaw models on agent main via sessions.create/sessions.patch and fails closed when gateway rejects the model', async () => {
    const { compressWithSdk } = await import('../../src/context/summary-compressor.js');

    const firstRes = await compressWithSdk({
      events: [{ type: 'user.turn', content: 'First manual openclaw model', createdAt: 100 } as unknown as CompressionInput['events'][number]],
      modelConfig: {
        modelSelectionMode: 'manual',
        primaryContextBackend: 'openclaw',
        primaryContextModel: 'anthropic/claude-opus-4-6',
      },
    });
    expect(firstRes.fromSdk).toBe(true);
    expect(firstRes.usedBackup).toBe(false);
    expect(firstRes.backend).toBe('openclaw');
    expect(firstRes.model).toBe('anthropic/claude-opus-4-6');
    expect(gatewayState.sentFrames.find((f) => f.method === 'sessions.create')?.params).toMatchObject({
      agentId: 'main',
      model: 'anthropic/claude-opus-4-6',
    });
    expect(gatewayState.sentFrames.find((f) => f.method === 'sessions.patch')?.params).toMatchObject({
      key: expect.stringMatching(/^agent:main:/),
      model: 'anthropic/claude-opus-4-6',
    });

    // Changing manual model creates a fresh sub-session and patches the new model.
    gatewayState.sentFrames = [];
    const secondRes = await compressWithSdk({
      events: [{ type: 'user.turn', content: 'Second manual openclaw model', createdAt: 200 } as unknown as CompressionInput['events'][number]],
      modelConfig: {
        modelSelectionMode: 'manual',
        primaryContextBackend: 'openclaw',
        primaryContextModel: 'openai/gpt-5',
      },
    });
    expect(secondRes.fromSdk).toBe(true);
    expect(secondRes.model).toBe('openai/gpt-5');
    expect(gatewayState.sentFrames.find((f) => f.method === 'sessions.patch')?.params).toMatchObject({
      key: expect.stringMatching(/^agent:main:/),
      model: 'openai/gpt-5',
    });

    // When the gateway rejects the manual model, sessions.send is never called and fallback occurs cleanly.
    gatewayState.sentFrames = [];
    gatewayState.rejectModels.add('disallowed-oc-model');
    const rejectedRes = await compressWithSdk({
      events: [{ type: 'user.turn', content: 'Disallowed manual openclaw model', createdAt: 300 } as unknown as CompressionInput['events'][number]],
      modelConfig: {
        modelSelectionMode: 'manual',
        primaryContextBackend: 'openclaw',
        primaryContextModel: 'disallowed-oc-model',
      },
    });
    expect(rejectedRes.fromSdk).toBe(false);
    expect(rejectedRes.backend).toBe('none');
    expect(gatewayState.sentFrames.some((f) => f.method === 'sessions.patch' && f.params?.model === 'disallowed-oc-model')).toBe(true);
    expect(gatewayState.sentFrames.some((f) => f.method === 'sessions.send')).toBe(false);
  });
});
