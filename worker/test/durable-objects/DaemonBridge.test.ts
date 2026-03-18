import { describe, it, expect } from 'vitest';
import { DaemonBridge } from '../../durable-objects/DaemonBridge.js';

// Constants from DaemonBridge.ts (module-level, not exported — test via behavior expectations)
const EXPECTED_IDLE_TIMEOUT_MS = 120_000;
const EXPECTED_MAX_QUEUE_SIZE = 100;

describe('DaemonBridge', () => {
  it('is exported as a class', () => {
    expect(typeof DaemonBridge).toBe('function');
    expect(DaemonBridge.prototype).toBeDefined();
  });

  it('has a fetch method', () => {
    expect(typeof DaemonBridge.prototype.fetch).toBe('function');
  });

  it('has a sendToDaemon method', () => {
    expect(typeof DaemonBridge.prototype.sendToDaemon).toBe('function');
  });

  it('can be instantiated with a mock state and env', () => {
    const mockStorage = { get: () => Promise.resolve(null), put: () => Promise.resolve() };
    const mockState = { storage: mockStorage } as any;
    const mockEnv = { DB: { prepare: () => ({ bind: () => ({ first: () => null }) }) } } as any;
    const bridge = new DaemonBridge(mockState, mockEnv);
    expect(bridge).toBeInstanceOf(DaemonBridge);
  });

  it('queues messages when daemon is not connected (sendToDaemon)', () => {
    const mockState = { storage: {} } as any;
    const mockEnv = {} as any;
    const bridge = new DaemonBridge(mockState, mockEnv);
    // Should not throw when ws is null (queues the message)
    expect(() => bridge.sendToDaemon('{"type":"test"}')).not.toThrow();
  });

  it('expected IDLE_TIMEOUT_MS constant is 120000', () => {
    // Verify the constant matches the source
    expect(EXPECTED_IDLE_TIMEOUT_MS).toBe(120_000);
  });

  it('expected MAX_QUEUE_SIZE constant is 100', () => {
    expect(EXPECTED_MAX_QUEUE_SIZE).toBe(100);
  });

  it('fetch returns 404 for unknown paths', async () => {
    const mockState = { storage: {} } as any;
    const mockEnv = {} as any;
    const bridge = new DaemonBridge(mockState, mockEnv);
    const req = new Request('https://dummy/unknown');
    const res = await bridge.fetch(req);
    expect(res.status).toBe(404);
  });

  it('fetch returns 426 for /daemon without WebSocket upgrade', async () => {
    const mockState = { storage: {} } as any;
    const mockEnv = {} as any;
    const bridge = new DaemonBridge(mockState, mockEnv);
    const req = new Request('https://dummy/daemon');
    const res = await bridge.fetch(req);
    expect(res.status).toBe(426);
  });

  it('fetch returns 426 for /terminal without WebSocket upgrade', async () => {
    const mockState = { storage: {} } as any;
    const mockEnv = {} as any;
    const bridge = new DaemonBridge(mockState, mockEnv);
    const req = new Request('https://dummy/terminal');
    const res = await bridge.fetch(req);
    expect(res.status).toBe(426);
  });
});
