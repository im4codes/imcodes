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

  // ── Shared helper: bring up an authenticated daemon-backed bridge ────────────
  async function makeAuthedBridge(prefix: string) {
    const { WsBridge } = await import('../src/ws/bridge.js');
    const serverId = `${prefix}-${Math.random().toString(36).slice(2)}`;
    const bridge = WsBridge.get(serverId);
    const daemon = new MockWs();
    bridge.handleDaemonConnection(daemon as never, makeDb(), {} as never);
    daemon.emit('message', Buffer.from(JSON.stringify({ type: 'auth', serverId, token: 't' })), false);
    await flushAsync();
    return { WsBridge, serverId, bridge, daemon };
  }

  // Count how many in-flight HTTP relays exist for a given preview. Derived from
  // the SAME signal the production ceiling uses (the private pendingPreviewRequests
  // map) via the public canAcceptPreviewInflight probe: at the per-preview ceiling
  // of 2, a full preview returns false and a preview with a freed slot returns true.
  function perPreviewFull(bridge: { canAcceptPreviewInflight(p: string): boolean }, preview: string) {
    return bridge.canAcceptPreviewInflight(preview) === false;
  }

  // ── T-I1a V-inflight-release-complete: RESPONSE_END frees the slot ───────────
  it('releases the in-flight slot on NORMAL completion (RESPONSE_START → RESPONSE_END)', async () => {
    const { WsBridge, bridge, daemon } = await makeAuthedBridge('inflight-complete');
    const { PREVIEW_MSG } = await import('../../shared/preview-types.js');

    const preview = 'preview-' + 'a'.repeat(16);
    // Fill the per-preview ceiling (2).
    const r1 = bridge.createPreviewRelay('c1', preview, 60_000);
    // start resolves cleanly on RESPONSE_END (controller.close); ignore the body.
    r1.start.then(() => {}, () => {});
    bridge.createPreviewRelay('c2', preview, 60_000);
    expect(perPreviewFull(bridge, preview)).toBe(true); // full at 2

    // Drive c1 to a NORMAL completion: RESPONSE_START then RESPONSE_END.
    daemon.emit('message', Buffer.from(JSON.stringify({
      type: PREVIEW_MSG.RESPONSE_START, requestId: 'c1', status: 200, headers: {},
    })), false);
    daemon.emit('message', Buffer.from(JSON.stringify({
      type: PREVIEW_MSG.RESPONSE_END, requestId: 'c1',
    })), false);
    await flushAsync();

    // The slot for c1 was released → the preview can accept again.
    expect(bridge.canAcceptPreviewInflight(preview)).toBe(true);

    WsBridge.getAll().clear();
  });

  // ── T-I1b V-inflight-release-fail/abort: ERROR and browser-abort free a slot ──
  it('releases the in-flight slot on ERROR (failPreviewRequest) and on browser abort', async () => {
    const { WsBridge, bridge, daemon } = await makeAuthedBridge('inflight-fail-abort');
    const { PREVIEW_MSG, PREVIEW_ERROR } = await import('../../shared/preview-types.js');

    const preview = 'preview-' + 'a'.repeat(16);

    // (1) ERROR terminal — fill to the ceiling, then a daemon ERROR for one.
    const f1 = bridge.createPreviewRelay('f1', preview, 60_000);
    f1.start.catch(() => {}); // failPreviewRequest rejects rejectStart pre-start
    bridge.createPreviewRelay('f2', preview, 60_000);
    expect(perPreviewFull(bridge, preview)).toBe(true);

    daemon.emit('message', Buffer.from(JSON.stringify({
      type: PREVIEW_MSG.ERROR, requestId: 'f1', code: PREVIEW_ERROR.UPSTREAM_ERROR, message: 'boom',
    })), false);
    await flushAsync();
    expect(bridge.canAcceptPreviewInflight(preview)).toBe(true); // f1 slot released

    // (2) Browser abort terminal — refill the freed slot, then relay.abort() it.
    const f3 = bridge.createPreviewRelay('f3', preview, 60_000);
    f3.start.catch(() => {}); // abort rejects the start promise
    expect(perPreviewFull(bridge, preview)).toBe(true); // full again (f2 + f3)

    f3.abort(); // browser abort → abortPreviewRequest deletes the entry
    expect(bridge.canAcceptPreviewInflight(preview)).toBe(true); // f3 slot released

    WsBridge.getAll().clear();
  });

  // ── T-I1c V-inflight-release-daemon-drop/cleanup ────────────────────────────
  it('releases ALL in-flight slots on daemon disconnect and on registry cleanup', async () => {
    const { WsBridge, bridge, daemon } = await makeAuthedBridge('inflight-drop');

    const preview = 'preview-' + 'a'.repeat(16);

    // (1) Daemon disconnect → ws 'close' → rejectAllPendingPreviewRequests.
    const d1 = bridge.createPreviewRelay('d1', preview, 60_000);
    d1.start.catch(() => {});
    const d2 = bridge.createPreviewRelay('d2', preview, 60_000);
    d2.start.catch(() => {});
    expect(perPreviewFull(bridge, preview)).toBe(true); // full at 2

    daemon.emit('close'); // daemon socket dropped
    await flushAsync();
    // All slots released → the per-preview count is back to 0.
    expect(bridge.canAcceptPreviewInflight(preview)).toBe(true);

    // (2) Registry cleanup eviction → terminatePreviewRelaysForPreview.
    // Reconnect a fresh authenticated daemon so createPreviewRelay is allowed.
    const daemon2 = new MockWs();
    bridge.handleDaemonConnection(daemon2 as never, makeDb(), {} as never);
    daemon2.emit('message', Buffer.from(JSON.stringify({ type: 'auth', serverId: (bridge as unknown as { serverId: string }).serverId, token: 't' })), false);
    await flushAsync();

    const e1 = bridge.createPreviewRelay('e1', preview, 60_000);
    e1.start.catch(() => {});
    const e2 = bridge.createPreviewRelay('e2', preview, 60_000);
    e2.start.catch(() => {});
    expect(perPreviewFull(bridge, preview)).toBe(true); // full at 2

    bridge.terminatePreviewRelaysForPreview(preview);
    expect(bridge.canAcceptPreviewInflight(preview)).toBe(true); // back to 0

    WsBridge.getAll().clear();
  });

  // ── T-I1d (hardening / A28): after every terminal, a brand-new relay is OK ────
  it('accepts a brand-new relay for the same preview after each terminal (no stale entries)', async () => {
    const { WsBridge, bridge, daemon } = await makeAuthedBridge('inflight-a28');
    const { PREVIEW_MSG, PREVIEW_ERROR } = await import('../../shared/preview-types.js');

    const preview = 'preview-' + 'a'.repeat(16);

    // Helper: fill to the per-preview ceiling, run the given terminal on 'slotN',
    // then assert a freshly created relay for the SAME preview is accepted.
    async function expectFreshAcceptedAfter(
      slotId: string,
      fillerId: string,
      drive: () => void | Promise<void>,
    ) {
      const a = bridge.createPreviewRelay(slotId, preview, 60_000);
      a.start.then(() => {}, () => {});
      const b = bridge.createPreviewRelay(fillerId, preview, 60_000);
      b.start.then(() => {}, () => {});
      expect(perPreviewFull(bridge, preview)).toBe(true);
      await drive();
      await flushAsync();
      // A brand-new relay (same preview) must be accepted → no stale/leaked entry.
      expect(bridge.canAcceptPreviewInflight(preview)).toBe(true);
      const fresh = bridge.createPreviewRelay(`${slotId}-fresh`, preview, 60_000);
      fresh.start.then(() => {}, () => {});
      // Now full again (fresh + filler), proving the new entry actually counts.
      expect(perPreviewFull(bridge, preview)).toBe(true);
      // Clean up both for the next sub-case.
      fresh.abort();
      bridge.terminatePreviewRelaysForPreview(preview);
      await flushAsync();
      expect(bridge.canAcceptPreviewInflight(preview)).toBe(true);
    }

    // Complete terminal
    await expectFreshAcceptedAfter('g1', 'g1f', () => {
      daemon.emit('message', Buffer.from(JSON.stringify({
        type: PREVIEW_MSG.RESPONSE_START, requestId: 'g1', status: 200, headers: {},
      })), false);
      daemon.emit('message', Buffer.from(JSON.stringify({
        type: PREVIEW_MSG.RESPONSE_END, requestId: 'g1',
      })), false);
    });

    // Fail terminal
    await expectFreshAcceptedAfter('g2', 'g2f', () => {
      daemon.emit('message', Buffer.from(JSON.stringify({
        type: PREVIEW_MSG.ERROR, requestId: 'g2', code: PREVIEW_ERROR.UPSTREAM_ERROR,
      })), false);
    });

    // Abort terminal — drive via the relay handle captured inside the helper is
    // awkward, so do this sub-case inline.
    {
      const a = bridge.createPreviewRelay('g3', preview, 60_000);
      a.start.catch(() => {});
      const b = bridge.createPreviewRelay('g3f', preview, 60_000);
      b.start.catch(() => {});
      expect(perPreviewFull(bridge, preview)).toBe(true);
      a.abort();
      expect(bridge.canAcceptPreviewInflight(preview)).toBe(true);
      const fresh = bridge.createPreviewRelay('g3-fresh', preview, 60_000);
      fresh.start.catch(() => {});
      expect(perPreviewFull(bridge, preview)).toBe(true);
      bridge.terminatePreviewRelaysForPreview(preview);
      expect(bridge.canAcceptPreviewInflight(preview)).toBe(true);
    }

    WsBridge.getAll().clear();
  });
});
