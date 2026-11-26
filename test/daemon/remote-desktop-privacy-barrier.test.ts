import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  REMOTE_DESKTOP_PRIVACY_MSG,
  REMOTE_DESKTOP_PRESENTATION_SOURCE,
} from '../../shared/remote-desktop-access.js';
import {
  RemoteDesktopPrivacyBarrier,
  WORKER_PRIVACY_FRAME,
  parseWorkerPrivacyFrame,
  type WorkerPrivacyInboundFrame,
} from '../../src/node/remote-desktop-privacy-ipc.js';

const HOST_ID = 'host-00000000000000000001';
const EPOCH_ID = 'epoch-0000000000000000001';
const ROUTES = [
  { routeId: 'route-000000000000000001', routeGeneration: 3 },
  { routeId: 'route-000000000000000002', routeGeneration: 9 },
];

function begin(overrides: Record<string, unknown> = {}) {
  return {
    type: REMOTE_DESKTOP_PRIVACY_MSG.BEGIN,
    hostId: HOST_ID,
    epochId: EPOCH_ID,
    revision: 1,
    presentationSource: Object.values(REMOTE_DESKTOP_PRESENTATION_SOURCE)[0],
    deadlineAt: 60_000,
    routeSnapshot: ROUTES,
    ...overrides,
  };
}

function end(overrides: Record<string, unknown> = {}) {
  return {
    type: REMOTE_DESKTOP_PRIVACY_MSG.END,
    hostId: HOST_ID,
    epochId: EPOCH_ID,
    revision: 1,
    freshFrameWorkerGeneration: 0,
    ...overrides,
  };
}

function harness(options: {
  shielded?: Partial<Record<string, unknown>> | null;
  released?: Partial<Record<string, unknown>> | null;
  send?: () => boolean;
  generation?: () => number;
  hostId?: string;
} = {}) {
  const sent: Record<string, unknown>[] = [];
  const handlers = new Set<(f: WorkerPrivacyInboundFrame) => void>();
  const transport = {
    send(frame: Record<string, unknown>) {
      sent.push(frame);
      const ok = options.send?.() ?? true;
      if (!ok) return false;
      // The worker answers on the next tick, like the real pipe.
      queueMicrotask(() => {
        if (frame.type === WORKER_PRIVACY_FRAME.SHIELD && options.shielded !== null) {
          emit({
            type: WORKER_PRIVACY_FRAME.SHIELDED,
            epochId: EPOCH_ID,
            revision: 1,
            workerGeneration: 10,
            inputReleased: true,
            routes: ROUTES,
            ...(options.shielded ?? {}),
          } as WorkerPrivacyInboundFrame);
        }
        if (frame.type === WORKER_PRIVACY_FRAME.RELEASE && options.released !== null) {
          emit({
            type: WORKER_PRIVACY_FRAME.RELEASED,
            epochId: EPOCH_ID,
            secretCleanupComplete: true,
            freshFrameWorkerGeneration: 11,
            ...(options.released ?? {}),
          } as WorkerPrivacyInboundFrame);
        }
      });
      return true;
    },
    subscribe(handler: (f: WorkerPrivacyInboundFrame) => void) {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
  };
  function emit(frame: WorkerPrivacyInboundFrame) { for (const h of [...handlers]) h(frame); }
  const barrier = new RemoteDesktopPrivacyBarrier({
    transport,
    hostId: () => options.hostId ?? HOST_ID,
    daemonGeneration: options.generation ?? (() => 5),
    now: () => 1_000,
    workerAckTimeoutMs: 50,
  });
  return { barrier, sent, emit };
}

describe('RemoteDesktopPrivacyBarrier — BEGIN', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('acks with the complete post-switch route set and worker generation', async () => {
    const h = harness();
    const ack = await h.barrier.begin(begin());
    expect(ack).toEqual({
      type: REMOTE_DESKTOP_PRIVACY_MSG.ACK,
      hostId: HOST_ID,
      epochId: EPOCH_ID,
      revision: 1,
      workerGeneration: 10,
      routes: ROUTES,
    });
    expect(h.barrier.shielded()).toBe(true);
    expect(h.sent[0]).toEqual({
      type: WORKER_PRIVACY_FRAME.SHIELD,
      epochId: EPOCH_ID,
      revision: 1,
      presentationSource: Object.values(REMOTE_DESKTOP_PRESENTATION_SOURCE)[0],
      routes: ROUTES,
    });
  });

  it('ignores an early incomplete route set and waits for the exact shielded snapshot', async () => {
    const h = harness({ shielded: { routes: [ROUTES[0]] } });
    const pending = h.barrier.begin(begin());
    await Promise.resolve();
    h.emit({
      type: WORKER_PRIVACY_FRAME.SHIELDED,
      epochId: EPOCH_ID,
      revision: 1,
      workerGeneration: 11,
      inputReleased: true,
      routes: ROUTES,
    });
    await expect(pending).resolves.toMatchObject({ workerGeneration: 11, routes: ROUTES });
  });

  it('forwards a later exact route snapshot after replacement PREPARE changes the Worker set', async () => {
    const updates: unknown[] = [];
    const handlers = new Set<(f: WorkerPrivacyInboundFrame) => void>();
    const barrier = new RemoteDesktopPrivacyBarrier({
      transport: {
        send: () => true,
        subscribe: (handler) => { handlers.add(handler); return () => handlers.delete(handler); },
      },
      hostId: () => HOST_ID,
      daemonGeneration: () => 5,
      now: () => 1_000,
      workerAckTimeoutMs: 50,
      onShieldedUpdate: (ack) => updates.push(ack),
    });
    let settled = false;
    const pending = barrier.begin(begin()).then((ack) => {
      settled = true;
      return ack;
    });
    for (const handler of [...handlers]) handler({
      type: WORKER_PRIVACY_FRAME.SHIELDED,
      epochId: EPOCH_ID,
      revision: 1,
      workerGeneration: 0,
      inputReleased: true,
      routes: [],
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    for (const handler of [...handlers]) handler({
      type: WORKER_PRIVACY_FRAME.SHIELDED,
      epochId: EPOCH_ID,
      revision: 1,
      workerGeneration: 11,
      inputReleased: true,
      routes: ROUTES,
    });
    await expect(pending).resolves.toMatchObject({ routes: ROUTES });
    // A later idempotent re-publication (for example after an ACK loss) is
    // still forwarded; the Server remains the final exact-snapshot authority.
    for (const handler of [...handlers]) handler({
      type: WORKER_PRIVACY_FRAME.SHIELDED,
      epochId: EPOCH_ID,
      revision: 1,
      workerGeneration: 11,
      inputReleased: true,
      routes: ROUTES,
    });
    expect(updates).toEqual([{
      type: REMOTE_DESKTOP_PRIVACY_MSG.ACK,
      hostId: HOST_ID,
      epochId: EPOCH_ID,
      revision: 1,
      workerGeneration: 11,
      routes: ROUTES,
    }]);
  });

  it('does not forward stale-revision route snapshots', async () => {
    const updates: unknown[] = [];
    const handlers = new Set<(f: WorkerPrivacyInboundFrame) => void>();
    const barrier = new RemoteDesktopPrivacyBarrier({
      transport: {
        send: () => true,
        subscribe: (handler) => { handlers.add(handler); return () => handlers.delete(handler); },
      },
      hostId: () => HOST_ID,
      daemonGeneration: () => 5,
      now: () => 1_000,
      workerAckTimeoutMs: 1,
      onShieldedUpdate: (ack) => updates.push(ack),
    });
    const pending = barrier.begin(begin());
    queueMicrotask(() => {
      for (const handler of [...handlers]) handler({
        type: WORKER_PRIVACY_FRAME.SHIELDED,
        epochId: EPOCH_ID,
        revision: 1,
        workerGeneration: 1,
        inputReleased: true,
        routes: ROUTES,
      });
    });
    await pending;
    for (const handler of [...handlers]) handler({
      type: WORKER_PRIVACY_FRAME.SHIELDED,
      epochId: EPOCH_ID,
      revision: 2,
      workerGeneration: 2,
      inputReleased: true,
      routes: ROUTES,
    });
    expect(updates).toEqual([]);
  });

  it('refuses to ack when input was not released before shielding', async () => {
    // A viewer holding a key down would keep typing into a secret surface it
    // can no longer see.
    const h = harness({ shielded: { inputReleased: false } });
    await expect(h.barrier.begin(begin())).resolves.toBeNull();
  });

  it('fails closed when the worker never confirms the shield', async () => {
    const h = harness({ shielded: null });
    const pending = h.barrier.begin(begin());
    await vi.advanceTimersByTimeAsync(60);
    // No ack means the Server never enables secret UI.
    await expect(pending).resolves.toBeNull();
  });

  it('fails closed when the shield frame cannot reach the worker', async () => {
    const h = harness({ send: () => false });
    await expect(h.barrier.begin(begin())).resolves.toBeNull();
  });

  it.each([
    ['a different host', { hostId: 'host-00000000000000000099' }],
    ['an already-expired deadline', { deadlineAt: 500 }],
    ['a malformed payload', { revision: -1 }],
  ] as const)('fails closed on %s', async (_label, patch) => {
    const h = harness();
    await expect(h.barrier.begin(begin(patch))).resolves.toBeNull();
    expect(h.sent).toEqual([]);
  });

  it('refuses a replayed epoch whose revision does not advance', async () => {
    const h = harness();
    await h.barrier.begin(begin());
    await expect(h.barrier.begin(begin())).resolves.toBeNull();
  });

  it('discards the ack when the daemon reconnected while shielding', async () => {
    let generation = 5;
    const h = harness({ generation: () => generation });
    const pending = h.barrier.begin(begin());
    await Promise.resolve();
    generation = 6;
    await expect(pending).resolves.toBeNull();
  });
});

describe('RemoteDesktopPrivacyBarrier — END', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  async function shielded(options: Parameters<typeof harness>[0] = {}) {
    const h = harness(options);
    const ack = await h.barrier.begin(begin());
    expect(ack).not.toBeNull();
    return h;
  }

  it('restores only after cleanup and a strictly newer frame generation', async () => {
    const h = await shielded();
    const ack = await h.barrier.end(end());
    expect(ack).toMatchObject({
      type: REMOTE_DESKTOP_PRIVACY_MSG.ACK,
      epochId: EPOCH_ID,
      workerGeneration: 11,
      routes: ROUTES,
    });
    expect(h.barrier.shielded()).toBe(false);
  });

  it('keeps the shield up when the worker did not finish secret cleanup', async () => {
    const h = await shielded({ released: { secretCleanupComplete: false } });
    await expect(h.barrier.end(end())).resolves.toBeNull();
    expect(h.barrier.shielded()).toBe(true);
  });

  it.each([
    ['equal to the shield generation (a cached frame)', 10],
    ['older than the shield generation', 9],
  ] as const)('refuses a proof frame %s', async (_label, generation) => {
    // Equal means the worker handed back something it already had, which may
    // still contain the secret.
    const h = await shielded({ released: { freshFrameWorkerGeneration: generation } });
    await expect(h.barrier.end(end())).resolves.toBeNull();
    expect(h.barrier.shielded()).toBe(true);
  });

  it('refuses a proof frame older than the Server expected', async () => {
    const h = await shielded({ released: { freshFrameWorkerGeneration: 11 } });
    await expect(h.barrier.end(end({ freshFrameWorkerGeneration: 12 }))).resolves.toBeNull();
    expect(h.barrier.shielded()).toBe(true);
  });

  it('fails closed when the worker never confirms release', async () => {
    const h = await shielded({ released: null });
    const pending = h.barrier.end(end());
    await vi.advanceTimersByTimeAsync(60);
    await expect(pending).resolves.toBeNull();
    expect(h.barrier.shielded()).toBe(true);
  });

  it.each([
    ['a stale revision', { revision: 2 }],
    ['an unknown epoch', { epochId: 'epoch-0000000000000000099' }],
    ['a different host', { hostId: 'host-00000000000000000099' }],
  ] as const)('fails closed on END with %s', async (_label, patch) => {
    const h = await shielded();
    await expect(h.barrier.end(end(patch))).resolves.toBeNull();
    expect(h.barrier.shielded()).toBe(true);
  });

  it('keeps the shield up across a reconnect and refuses to end under new authority', async () => {
    let generation = 5;
    const h = harness({ generation: () => generation });
    await h.barrier.begin(begin());
    generation = 6;
    await expect(h.barrier.end(end())).resolves.toBeNull();
    // Recovery is a new epoch, never a rollback.
    expect(h.barrier.shielded()).toBe(true);
    await expect(h.barrier.begin(begin({ revision: 2 }))).resolves.toBeNull();
  });

  it('a disconnect does not lift the shield', async () => {
    const h = await shielded();
    h.barrier.onDaemonDisconnected();
    expect(h.barrier.shielded()).toBe(true);
    await expect(h.barrier.end(end())).resolves.toBeNull();
  });

  it('marks recovery when release cannot be proven or cleanup is uncertain', async () => {
    const reasons: string[] = [];
    const sent: Record<string, unknown>[] = [];
    const handlers = new Set<(f: WorkerPrivacyInboundFrame) => void>();
    const barrier = new RemoteDesktopPrivacyBarrier({
      transport: {
        send(frame) { sent.push(frame); return true; },
        subscribe(handler) { handlers.add(handler); return () => handlers.delete(handler); },
      },
      hostId: () => HOST_ID,
      daemonGeneration: () => 5,
      now: () => 1_000,
      workerAckTimeoutMs: 50,
      onRecoveryRequired: (reason) => reasons.push(reason),
    });
    const pendingBegin = barrier.begin(begin());
    queueMicrotask(() => {
      for (const handler of [...handlers]) handler({
        type: WORKER_PRIVACY_FRAME.SHIELDED,
        epochId: EPOCH_ID,
        revision: 1,
        workerGeneration: 10,
        inputReleased: true,
        routes: ROUTES,
      });
    });
    await expect(pendingBegin).resolves.not.toBeNull();
    const pendingEnd = barrier.end(end());
    await vi.advanceTimersByTimeAsync(60);
    await expect(pendingEnd).resolves.toBeNull();
    expect(barrier.recoveryPending()).toBe(true);
    expect(reasons).toEqual(['release_unconfirmed']);
  });

  it('maps explicit shell/watchdog recovery to recovery_required while an epoch is active', async () => {
    const reasons: string[] = [];
    const handlers = new Set<(f: WorkerPrivacyInboundFrame) => void>();
    const barrier = new RemoteDesktopPrivacyBarrier({
      transport: {
        send: () => true,
        subscribe: (handler) => { handlers.add(handler); return () => handlers.delete(handler); },
      },
      hostId: () => HOST_ID,
      daemonGeneration: () => 5,
      now: () => 1_000,
      workerAckTimeoutMs: 50,
      onRecoveryRequired: (reason) => reasons.push(reason),
    });
    const pendingBegin = barrier.begin(begin());
    queueMicrotask(() => {
      for (const handler of [...handlers]) handler({
        type: WORKER_PRIVACY_FRAME.SHIELDED,
        epochId: EPOCH_ID,
        revision: 1,
        workerGeneration: 10,
        inputReleased: true,
        routes: ROUTES,
      });
    });
    await expect(pendingBegin).resolves.not.toBeNull();
    barrier.onShellRecoveryRequired();
    expect(barrier.recoveryPending()).toBe(true);
    await expect(barrier.end(end())).resolves.toBeNull();
    expect(reasons).toEqual(['secret_cleanup_failed']);
  });

});

describe('parseWorkerPrivacyFrame', () => {
  it.each([
    ['a non-object', 7],
    ['an unknown type', { type: 'worker.privacy.whatever' }],
    ['a shielded frame with an extra secret-like key', {
      type: WORKER_PRIVACY_FRAME.SHIELDED, epochId: EPOCH_ID, revision: 1,
      workerGeneration: 1, inputReleased: true, routes: [], password: 'nope',
    }],
    ['a shielded frame with duplicate routes', {
      type: WORKER_PRIVACY_FRAME.SHIELDED, epochId: EPOCH_ID, revision: 1, workerGeneration: 1,
      inputReleased: true,
      routes: [{ routeId: 'r-000000000000000001', routeGeneration: 1 },
               { routeId: 'r-000000000000000001', routeGeneration: 2 }],
    }],
    ['a released frame with a non-boolean cleanup flag', {
      type: WORKER_PRIVACY_FRAME.RELEASED, epochId: EPOCH_ID,
      secretCleanupComplete: 'yes', freshFrameWorkerGeneration: 2,
    }],
  ] as const)('returns null for %s', (_label, value) => {
    expect(parseWorkerPrivacyFrame(value)).toBeNull();
  });
});
