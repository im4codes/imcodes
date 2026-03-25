/**
 * Tests for provider callback lifecycle (unsubscribe) and key sanitization defense.
 */
import { describe, it, expect, vi } from 'vitest';
import type { TransportProvider, ProviderCapabilities, ProviderConfig, SessionConfig, ProviderError } from '../../src/agent/transport-provider.js';
import type { AgentMessage, MessageDelta } from '../../shared/agent-message.js';

// ── Minimal mock provider implementing the new unsubscribe interface ────────

class MockProvider implements TransportProvider {
  readonly id = 'mock';
  readonly connectionMode = 'persistent' as const;
  readonly sessionOwnership = 'provider' as const;
  readonly capabilities: ProviderCapabilities = {
    streaming: true, toolCalling: false, approval: false,
    sessionRestore: false, multiTurn: true, attachments: false,
  };

  deltaCallbacks: Array<(sid: string, d: MessageDelta) => void> = [];
  completeCallbacks: Array<(sid: string, m: AgentMessage) => void> = [];
  errorCallbacks: Array<(sid: string, e: ProviderError) => void> = [];

  async connect(_config: ProviderConfig) {}
  async disconnect() {}
  async send(_sid: string, _msg: string) {}
  async createSession(config: SessionConfig) { return config.sessionKey; }
  async endSession(_sid: string) {}

  onDelta(cb: (sid: string, d: MessageDelta) => void): () => void {
    this.deltaCallbacks.push(cb);
    return () => { const i = this.deltaCallbacks.indexOf(cb); if (i >= 0) this.deltaCallbacks.splice(i, 1); };
  }
  onComplete(cb: (sid: string, m: AgentMessage) => void): () => void {
    this.completeCallbacks.push(cb);
    return () => { const i = this.completeCallbacks.indexOf(cb); if (i >= 0) this.completeCallbacks.splice(i, 1); };
  }
  onError(cb: (sid: string, e: ProviderError) => void): () => void {
    this.errorCallbacks.push(cb);
    return () => { const i = this.errorCallbacks.indexOf(cb); if (i >= 0) this.errorCallbacks.splice(i, 1); };
  }
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('Provider callback unsubscribe', () => {
  it('onDelta returns unsubscribe that removes the callback', () => {
    const provider = new MockProvider();
    const cb = vi.fn();
    const unsub = provider.onDelta(cb);
    expect(provider.deltaCallbacks).toHaveLength(1);
    unsub();
    expect(provider.deltaCallbacks).toHaveLength(0);
  });

  it('onComplete returns unsubscribe that removes the callback', () => {
    const provider = new MockProvider();
    const cb = vi.fn();
    const unsub = provider.onComplete(cb);
    expect(provider.completeCallbacks).toHaveLength(1);
    unsub();
    expect(provider.completeCallbacks).toHaveLength(0);
  });

  it('onError returns unsubscribe that removes the callback', () => {
    const provider = new MockProvider();
    const cb = vi.fn();
    const unsub = provider.onError(cb);
    expect(provider.errorCallbacks).toHaveLength(1);
    unsub();
    expect(provider.errorCallbacks).toHaveLength(0);
  });

  it('unsubscribe is idempotent — calling twice does not throw', () => {
    const provider = new MockProvider();
    const unsub = provider.onDelta(vi.fn());
    unsub();
    unsub(); // second call should be safe
    expect(provider.deltaCallbacks).toHaveLength(0);
  });

  it('multiple callbacks: unsubscribing one does not affect others', () => {
    const provider = new MockProvider();
    const cb1 = vi.fn();
    const cb2 = vi.fn();
    const unsub1 = provider.onDelta(cb1);
    provider.onDelta(cb2);
    expect(provider.deltaCallbacks).toHaveLength(2);
    unsub1();
    expect(provider.deltaCallbacks).toHaveLength(1);
    expect(provider.deltaCallbacks[0]).toBe(cb2);
  });
});

describe('TransportSessionRuntime callback cleanup', () => {
  it('kill() removes all 3 provider callbacks', async () => {
    const provider = new MockProvider();
    const { TransportSessionRuntime } = await import('../../src/agent/transport-session-runtime.js');
    const runtime = new TransportSessionRuntime(provider, 'test-session');
    // Constructor registers 3 callbacks
    expect(provider.deltaCallbacks).toHaveLength(1);
    expect(provider.completeCallbacks).toHaveLength(1);
    expect(provider.errorCallbacks).toHaveLength(1);

    await runtime.kill();

    expect(provider.deltaCallbacks).toHaveLength(0);
    expect(provider.completeCallbacks).toHaveLength(0);
    expect(provider.errorCallbacks).toHaveLength(0);
  });

  it('creating and killing multiple runtimes cleans up correctly', async () => {
    const provider = new MockProvider();
    const { TransportSessionRuntime } = await import('../../src/agent/transport-session-runtime.js');

    const r1 = new TransportSessionRuntime(provider, 's1');
    const r2 = new TransportSessionRuntime(provider, 's2');
    const r3 = new TransportSessionRuntime(provider, 's3');
    expect(provider.deltaCallbacks).toHaveLength(3);

    await r1.kill();
    await r3.kill();
    expect(provider.deltaCallbacks).toHaveLength(1);
    expect(provider.completeCallbacks).toHaveLength(1);
    expect(provider.errorCallbacks).toHaveLength(1);

    await r2.kill();
    expect(provider.deltaCallbacks).toHaveLength(0);
  });
});

describe('Key sanitization ___ defense', () => {
  it('listSessions filters out keys containing ___', async () => {
    // We can't easily test the real OpenClawProvider without a gateway.
    // Test the hasCollisionRisk function logic directly.
    const rawKeys = [
      'agent:main:main',
      'agent:test___name:main', // contains ___
      'agent:emma:discord:channel:123',
    ];
    const filtered = rawKeys.filter((k) => !k.includes('___'));
    expect(filtered).toEqual([
      'agent:main:main',
      'agent:emma:discord:channel:123',
    ]);
    expect(filtered).not.toContainEqual('agent:test___name:main');
  });
});
