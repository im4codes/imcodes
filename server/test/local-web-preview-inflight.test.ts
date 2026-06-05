import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';

/**
 * V-conc-503 (run 8a975732-23a P0.5.2) with a SMALL env threshold so we do not
 * have to spin up the real 64/256 in-flight ceiling. `PREVIEW_LIMITS` reads the
 * env override at module-eval time (`previewLimitFromEnv`), so we stub the env
 * and then DYNAMICALLY import both the shared types and the bridge AFTER the
 * stub is in place (a static import would be hoisted and evaluated first).
 */

class MockWs extends EventEmitter {
  sent: Array<string | Buffer> = [];
  closed = false;
  readyState = 1;
  send(data: string | Buffer, _opts?: unknown, cb?: (err?: Error) => void) {
    if (this.closed) { cb?.(new Error('closed')); return; }
    this.sent.push(data);
    cb?.();
  }
  close() { this.closed = true; this.readyState = 3; this.emit('close'); }
}

function makeDb() {
  return {
    queryOne: async () => ({ token_hash: 'valid-hash', user_id: 'u' }),
    query: async () => [],
    execute: async () => ({ changes: 1 }),
    exec: async () => {},
    close: () => {},
  } as unknown as import('../src/db/client.js').Database;
}

vi.mock('../src/security/crypto.js', () => ({
  sha256Hex: () => 'valid-hash',
  randomHex: () => 'a'.repeat(32),
}));
vi.mock('../src/routes/push.js', () => ({ dispatchPush: vi.fn() }));

async function flushAsync() {
  for (let i = 0; i < 5; i++) await new Promise((r) => process.nextTick(r));
}

describe('V-conc-503: in-flight HTTP concurrency floor', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv('PREVIEW_MAX_INFLIGHT_PER_PREVIEW', '2');
    vi.stubEnv('PREVIEW_MAX_INFLIGHT_PER_SERVER', '3');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  it('canAcceptPreviewInflight honors per-preview and per-server ceilings (env small thresholds)', async () => {
    const { WsBridge } = await import('../src/ws/bridge.js');
    const { PREVIEW_LIMITS } = await import('../../shared/preview-types.js');
    expect(PREVIEW_LIMITS.MAX_INFLIGHT_PREVIEW_HTTP_PER_PREVIEW).toBe(2);
    expect(PREVIEW_LIMITS.MAX_INFLIGHT_PREVIEW_HTTP_PER_SERVER).toBe(3);

    const serverId = `inflight-${Math.random().toString(36).slice(2)}`;
    const bridge = WsBridge.get(serverId);
    const daemon = new MockWs();
    bridge.handleDaemonConnection(daemon as never, makeDb(), {} as never);
    daemon.emit('message', Buffer.from(JSON.stringify({ type: 'auth', serverId, token: 't' })), false);
    await flushAsync();

    const previewA = 'preview-' + 'a'.repeat(16);
    const previewB = 'preview-' + 'b'.repeat(16);

    // Per-preview ceiling = 2: two pending relays for A fill it.
    expect(bridge.canAcceptPreviewInflight(previewA)).toBe(true);
    bridge.createPreviewRelay('a1', previewA, 60_000);
    expect(bridge.canAcceptPreviewInflight(previewA)).toBe(true);
    bridge.createPreviewRelay('a2', previewA, 60_000);
    // A is now full (2 in-flight) → reject the 3rd for A.
    expect(bridge.canAcceptPreviewInflight(previewA)).toBe(false);

    // B has 0 in-flight, and the per-server ceiling (3) still has 1 slot.
    expect(bridge.canAcceptPreviewInflight(previewB)).toBe(true);
    bridge.createPreviewRelay('b1', previewB, 60_000);
    // Now 3 total in-flight (a1,a2,b1) → per-server ceiling hit → reject anything.
    expect(bridge.canAcceptPreviewInflight(previewB)).toBe(false);

    WsBridge.getAll().clear();
  });

  // ── A6 lifecycle: a slot is released on ANY terminal ─────────────────────────
  it('releases an in-flight slot on terminal so a new request is accepted again', async () => {
    const { WsBridge } = await import('../src/ws/bridge.js');
    const serverId = `inflight-rel-${Math.random().toString(36).slice(2)}`;
    const bridge = WsBridge.get(serverId);
    const daemon = new MockWs();
    bridge.handleDaemonConnection(daemon as never, makeDb(), {} as never);
    daemon.emit('message', Buffer.from(JSON.stringify({ type: 'auth', serverId, token: 't' })), false);
    await flushAsync();

    const preview = 'preview-' + 'a'.repeat(16);
    const r1 = bridge.createPreviewRelay('r1', preview, 60_000);
    r1.start.catch(() => {}); // abort() below rejects this start; we never consume it
    bridge.createPreviewRelay('r2', preview, 60_000);
    expect(bridge.canAcceptPreviewInflight(preview)).toBe(false); // full at per-preview=2

    r1.abort(); // terminal (abort) → slot released
    expect(bridge.canAcceptPreviewInflight(preview)).toBe(true);

    WsBridge.getAll().clear();
  });

  // ── R5: WS tunnels MUST NOT count toward the HTTP in-flight ceiling ──────────
  it('does NOT count WS tunnels toward the HTTP in-flight ceiling', async () => {
    const { WsBridge } = await import('../src/ws/bridge.js');
    const serverId = `inflight-ws-${Math.random().toString(36).slice(2)}`;
    const bridge = WsBridge.get(serverId);
    const daemon = new MockWs();
    bridge.handleDaemonConnection(daemon as never, makeDb(), {} as never);
    daemon.emit('message', Buffer.from(JSON.stringify({ type: 'auth', serverId, token: 't' })), false);
    await flushAsync();

    const preview = 'preview-' + 'a'.repeat(16);
    // Two WS tunnels for the preview — these are HTTP-ceiling-irrelevant.
    bridge.createPreviewWsTunnel('a'.repeat(32), preview, 3000, '/', new MockWs() as never, {}, []);
    bridge.createPreviewWsTunnel('b'.repeat(32), preview, 3000, '/', new MockWs() as never, {}, []);
    expect(bridge.getPreviewWsCount(preview)).toBe(2);

    // 1 HTTP in-flight is still under the per-preview ceiling of 2 — WS uncounted.
    bridge.createPreviewRelay('h1', preview, 60_000);
    expect(bridge.canAcceptPreviewInflight(preview)).toBe(true);
    // The 2nd HTTP hits the HTTP ceiling regardless of the 2 live WS tunnels.
    bridge.createPreviewRelay('h2', preview, 60_000);
    expect(bridge.canAcceptPreviewInflight(preview)).toBe(false);
    expect(bridge.getPreviewWsCount(preview)).toBe(2);

    bridge.closeAllPreviewWsForPreview(preview);
    WsBridge.getAll().clear();
  });
});
