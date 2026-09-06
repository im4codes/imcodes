import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DIRECT_FILE_TRANSFER_HOST_METHOD,
  DIRECT_FILE_TRANSFER_LIMITS,
  DIRECT_FILE_TRANSFER_MSG,
  DIRECT_FILE_TRANSFER_PROTOCOL_VERSION,
  DIRECT_FILE_TRANSFER_WORKER_MSG,
  DIRECT_FILE_TRANSFER_WORKER_PROTOCOL_VERSION,
  validateDirectFileTransferWorkerEnvelope,
} from '../../shared/direct-file-transfer.js';
import {
  __directFileTransferWorkerGenerationForTests as workerGeneration,
  __resetDirectFileTransferForTests as resetProxy,
  __setDirectFileTransferWorkerFactoryForTests as setWorkerFactory,
  getDirectConnectivityRuntimeStatus,
  handleDirectFileTransferCommand,
  isDirectFileTransferAvailable,
  isDirectTransferNativeQuiesced,
  quiesceDirectFileTransferNative,
  SHUTDOWN_ACK_TIMEOUT_MS,
  shutdownDirectFileTransfers,
} from '../../src/daemon/direct-file-transfer.js';
import {
  releaseClientUploadClaim,
  tryClaimClientUpload,
} from '../../src/daemon/file-transfer-handler.js';

/**
 * Controllable stand-in for the transfer worker.
 *
 * Crash, restart-budget and stale-generation behaviour has to be provable
 * without racing a real thread to die on cue, so these cases drive the double
 * directly. The real worker is exercised separately by the stall proof below.
 */
class FakeWorker extends EventEmitter {
  readonly posted: Record<string, unknown>[] = [];
  terminated = 0;
  constructor(readonly generation: number) { super(); }
  postMessage(value: Record<string, unknown>): void { this.posted.push(value); }
  async terminate(): Promise<number> { this.terminated += 1; this.emit('exit', 0); return 0; }
  /** Emit an envelope as the worker would. */
  emitEnvelope(envelope: Record<string, unknown>): void {
    this.emit('message', { v: DIRECT_FILE_TRANSFER_WORKER_PROTOCOL_VERSION, generation: this.generation, ...envelope });
  }
  emitRaw(value: unknown): void { this.emit('message', value); }
}

/**
 * Drive a host call exactly as the worker does, and read back the reply the
 * proxy posts. This goes through the real envelope validator and the real
 * claim registry, so it measures the authority itself rather than a stand-in.
 */
async function hostCall(worker: FakeWorker, method: string, args: unknown[]): Promise<Record<string, unknown>> {
  const callId = `test-call-${++hostCallSeq}`;
  worker.emitEnvelope({ type: DIRECT_FILE_TRANSFER_WORKER_MSG.HOST_CALL, callId, method, args });
  await vi.waitFor(() => {
    expect(worker.posted.some((p) => p.type === DIRECT_FILE_TRANSFER_WORKER_MSG.HOST_RESULT && p.callId === callId)).toBe(true);
  });
  return worker.posted.find((p) => p.type === DIRECT_FILE_TRANSFER_WORKER_MSG.HOST_RESULT && p.callId === callId)!;
}
let hostCallSeq = 0;

/**
 * Real protocol messages, not placeholders.
 *
 * The boundary now validates in both directions before anything crosses, so a
 * test driving `{any: 'cmd'}` would exercise the rejection path and nothing
 * else — and would silently stop covering the behaviour it was written for.
 */
const BINDING = {
  serverId: 'daemon-0001',
  browserTabId: 'browser-tab-0001',
  leaseId: 'lease-0001',
  leaseGeneration: 1,
  daemonGeneration: 1,
  requestId: 'request-0001',
};

function leasePrepareCommand(overrides: Record<string, unknown> = {}) {
  return {
    type: DIRECT_FILE_TRANSFER_MSG.LEASE_PREPARE,
    protocolVersion: DIRECT_FILE_TRANSFER_PROTOCOL_VERSION,
    ...BINDING,
    expiresAt: Date.now() + 60_000,
    iceServers: [],
    ...overrides,
  };
}

function leasePreparedControl(overrides: Record<string, unknown> = {}) {
  return {
    type: DIRECT_FILE_TRANSFER_MSG.LEASE_PREPARED,
    protocolVersion: DIRECT_FILE_TRANSFER_PROTOCOL_VERSION,
    ...BINDING,
    ...overrides,
  };
}

let spawned: FakeWorker[] = [];

function installFakeWorkers(): void {
  setWorkerFactory((_url, options) => {
    const fake = new FakeWorker(options.workerData.generation);
    spawned.push(fake);
    return fake as unknown as import('node:worker_threads').Worker;
  });
}

function ready(worker: FakeWorker): void {
  worker.emitEnvelope({ type: DIRECT_FILE_TRANSFER_WORKER_MSG.READY });
}

function sender() {
  const sent: unknown[] = [];
  return { sent, handle: { send: (message: unknown) => { sent.push(message); return undefined; } } };
}

beforeEach(() => { spawned = []; resetProxy(); installFakeWorkers(); });
afterEach(() => { setWorkerFactory(null); resetProxy(); });

describe('direct file transfer worker boundary', () => {
  it('R-3: routes one control envelope to exactly its own sender', async () => {
    const a = sender();
    const b = sender();
    await handleDirectFileTransferCommand(leasePrepareCommand(), a.handle);
    await handleDirectFileTransferCommand(leasePrepareCommand({ leaseId: 'lease-0002' }), b.handle);
    const worker = spawned[0]!;
    ready(worker);

    const commands = worker.posted.filter((p) => p.type === DIRECT_FILE_TRANSFER_WORKER_MSG.COMMAND);
    expect(commands, 'each command is forwarded once').toHaveLength(2);
    const idA = commands[0]!.senderId as string;
    const idB = commands[1]!.senderId as string;
    expect(idA).not.toBe(idB);

    worker.emitEnvelope({
      type: DIRECT_FILE_TRANSFER_WORKER_MSG.CONTROL, senderId: idA,
      message: leasePreparedControl(), emittedAt: Date.now(),
    });
    expect(a.sent).toEqual([leasePreparedControl()]);
    expect(b.sent, 'a control message must not reach another transport').toEqual([]);
  });

  it('R-3: drops a control envelope for an unknown sender instead of guessing', async () => {
    const a = sender();
    await handleDirectFileTransferCommand(leasePrepareCommand(), a.handle);
    const worker = spawned[0]!;
    ready(worker);
    worker.emitEnvelope({
      type: DIRECT_FILE_TRANSFER_WORKER_MSG.CONTROL, senderId: 'dft-sender-does-not-exist',
      message: leasePreparedControl(), emittedAt: Date.now(),
    });
    expect(a.sent).toEqual([]);
  });

  it('fails closed on a malformed envelope rather than coercing it', async () => {
    const a = sender();
    await handleDirectFileTransferCommand(leasePrepareCommand(), a.handle);
    const worker = spawned[0]!;
    ready(worker);
    // wrong version, missing emittedAt, non-record message, and a bare string
    worker.emitRaw({ v: 999, generation: worker.generation, type: DIRECT_FILE_TRANSFER_WORKER_MSG.CONTROL, senderId: 'dft-sender-1', message: leasePreparedControl(), emittedAt: 1 });
    worker.emitEnvelope({ type: DIRECT_FILE_TRANSFER_WORKER_MSG.CONTROL, senderId: 'dft-sender-1', message: leasePreparedControl() });
    worker.emitEnvelope({ type: DIRECT_FILE_TRANSFER_WORKER_MSG.CONTROL, senderId: 'dft-sender-1', message: 'not-a-record', emittedAt: 1 });
    worker.emitRaw('garbage');
    expect(a.sent).toEqual([]);
  });

  it('drops a late envelope from a superseded worker generation', async () => {
    const a = sender();
    await handleDirectFileTransferCommand(leasePrepareCommand(), a.handle);
    const first = spawned[0]!;
    ready(first);
    const firstSenderId = (first.posted.find((p) => p.type === DIRECT_FILE_TRANSFER_WORKER_MSG.COMMAND)!.senderId) as string;

    first.emit('exit', 1);                    // crash
    expect(spawned).toHaveLength(2);          // replaced
    const second = spawned[1]!;
    expect(second.generation).toBeGreaterThan(first.generation);

    // The dead worker speaks after being replaced. Its generation is stale.
    first.emitEnvelope({
      type: DIRECT_FILE_TRANSFER_WORKER_MSG.CONTROL, senderId: firstSenderId,
      message: leasePreparedControl({ requestId: 'request-dead' }), emittedAt: Date.now(),
    });
    expect(a.sent, 'a replaced worker must not drive a live transport').toEqual([]);

    // The live worker still works.
    ready(second);
    second.emitEnvelope({
      type: DIRECT_FILE_TRANSFER_WORKER_MSG.CONTROL, senderId: firstSenderId,
      message: leasePreparedControl({ requestId: 'request-live' }), emittedAt: Date.now(),
    });
    expect(a.sent).toEqual([leasePreparedControl({ requestId: 'request-live' })]);
  });

  it('rejects an envelope whose stamped generation is not the live one', async () => {
    // Distinct from the stale-worker case: here the CURRENT worker emits an
    // envelope claiming a different generation. The payload's own claim is not
    // evidence, so it must be refused on its content, not merely on which
    // object delivered it.
    const a = sender();
    await handleDirectFileTransferCommand(leasePrepareCommand(), a.handle);
    const worker = spawned[0]!;
    ready(worker);
    const senderId = (worker.posted.find((p) => p.type === DIRECT_FILE_TRANSFER_WORKER_MSG.COMMAND)!.senderId) as string;

    worker.emit('message', {
      v: DIRECT_FILE_TRANSFER_WORKER_PROTOCOL_VERSION,
      generation: worker.generation + 41,
      type: DIRECT_FILE_TRANSFER_WORKER_MSG.CONTROL,
      senderId,
      message: leasePreparedControl({ requestId: 'request-forged' }),
      emittedAt: Date.now(),
    });
    expect(a.sent, 'a mis-stamped generation must be refused').toEqual([]);

    // The same worker, correctly stamped, still works.
    worker.emitEnvelope({
      type: DIRECT_FILE_TRANSFER_WORKER_MSG.CONTROL, senderId,
      message: leasePreparedControl(), emittedAt: Date.now(),
    });
    expect(a.sent).toEqual([leasePreparedControl()]);
  });

  it('restarts a crashed worker but stops at the restart budget', async () => {
    const a = sender();
    await handleDirectFileTransferCommand(leasePrepareCommand(), a.handle);
    ready(spawned[0]!);
    for (let i = 0; i < 8; i += 1) spawned[spawned.length - 1]!.emit('exit', 1);
    // 1 initial + 5 permitted restarts; the budget must bound it.
    expect(spawned).toHaveLength(6);
    expect(workerGeneration(), 'no live worker once the budget is exhausted').toBe(0);
    expect(isDirectFileTransferAvailable(), 'availability must fail closed').toBe(false);
    expect(getDirectConnectivityRuntimeStatus().state).toBe('runtime_unavailable');
  });

  it('a late exit from an already-replaced generation does not disturb the live worker', async () => {
    const a = sender();
    await handleDirectFileTransferCommand(leasePrepareCommand(), a.handle);
    const first = spawned[0]!;
    ready(first);
    first.emit('exit', 1);
    const second = spawned[1]!;
    ready(second);
    const liveGeneration = workerGeneration();

    first.emit('exit', 1);   // the corpse exits again
    expect(workerGeneration(), 'the live worker survives a stale exit').toBe(liveGeneration);
    expect(spawned, 'no extra worker is spawned for a stale exit').toHaveLength(2);
  });

  it('shutdown handshakes, terminates, and is idempotent', async () => {
    const a = sender();
    await handleDirectFileTransferCommand(leasePrepareCommand(), a.handle);
    const worker = spawned[0]!;
    ready(worker);

    const done = shutdownDirectFileTransfers();
    const shutdownMsg = worker.posted.find((p) => p.type === DIRECT_FILE_TRANSFER_WORKER_MSG.SHUTDOWN);
    expect(shutdownMsg, 'shutdown is requested over the protocol').toBeTruthy();
    worker.emitEnvelope({ type: DIRECT_FILE_TRANSFER_WORKER_MSG.SHUTDOWN_ACK, cleanupOk: true });
    await done;
    expect(worker.terminated, 'terminate still runs after the ack').toBe(1);

    // Repeating shutdown must not throw or double-terminate.
    await shutdownDirectFileTransfers();
    expect(worker.terminated).toBe(1);
    expect(isDirectFileTransferAvailable()).toBe(false);
  });

  it('a shutdown whose cleanup failed is surfaced, not read as a safe quiesce', async () => {
    const a = sender();
    await handleDirectFileTransferCommand(leasePrepareCommand(), a.handle);
    const worker = spawned[0]!;
    ready(worker);

    const done = shutdownDirectFileTransfers();
    worker.emitEnvelope({
      type: DIRECT_FILE_TRANSFER_WORKER_MSG.SHUTDOWN_ACK,
      cleanupOk: false,
      detail: 'lease_close_failed',
    });
    // The ack ARRIVED. Without the outcome field this is byte-for-byte the
    // successful path, which is exactly how a half-released worker used to be
    // recorded as an orderly stop.
    await expect(done).rejects.toThrow(/lease_close_failed/);
    // Local teardown still completes: failing closed means reporting the
    // failure, not leaking the worker.
    expect(worker.terminated, 'the worker is still terminated').toBe(1);
    expect(isDirectFileTransferAvailable(), 'availability is not projected after a failed stop').toBe(false);
  });

  it('an ack that does not state its cleanup outcome is refused', async () => {
    vi.useFakeTimers();
    try {
      const a = sender();
      await handleDirectFileTransferCommand(leasePrepareCommand(), a.handle);
      const worker = spawned[0]!;
      ready(worker);

      const done = shutdownDirectFileTransfers();
      const rejected = expect(done).rejects.toThrow(/shutdown_ack_timeout/);
      // A worker built against an older protocol omits the field entirely. It
      // must not be able to claim a clean stop by saying nothing.
      worker.emitEnvelope({ type: DIRECT_FILE_TRANSFER_WORKER_MSG.SHUTDOWN_ACK });
      await vi.advanceTimersByTimeAsync(SHUTDOWN_ACK_TIMEOUT_MS + 1);
      await rejected;
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * The reason the data plane moved to a worker at all is that two isolates must
   * not each believe they own an upload. The claim registry stays on the thread
   * that also runs the relay path; these cases hold it to that.
   */
  describe('single claim authority across the isolate boundary', () => {
    it('refuses the worker a claim the relay path already holds, and grants it after release', async () => {
      const a = sender();
      await handleDirectFileTransferCommand(leasePrepareCommand(), a.handle);
      const worker = spawned[0]!;
      ready(worker);

      // The relay claims first, on the main thread, exactly as an HTTP upload does.
      const relayToken = tryClaimClientUpload('upload-contended');
      expect(relayToken, 'the relay holds the claim').not.toBeNull();

      const denied = await hostCall(worker, DIRECT_FILE_TRANSFER_HOST_METHOD.TRY_CLAIM_CLIENT_UPLOAD, ['upload-contended']);
      expect(denied.ok).toBe(true);
      expect(denied.value, 'the worker is refused while the relay holds it').toBeNull();

      releaseClientUploadClaim('upload-contended', relayToken!);
      const granted = await hostCall(worker, DIRECT_FILE_TRANSFER_HOST_METHOD.TRY_CLAIM_CLIENT_UPLOAD, ['upload-contended']);
      expect(typeof granted.value, 'and granted once the relay is done').toBe('string');
    });

    it('hands the worker a cloneable handle, never the claim token itself', async () => {
      const a = sender();
      await handleDirectFileTransferCommand(leasePrepareCommand(), a.handle);
      const worker = spawned[0]!;
      ready(worker);

      const granted = await hostCall(worker, DIRECT_FILE_TRANSFER_HOST_METHOD.TRY_CLAIM_CLIENT_UPLOAD, ['upload-cloneable']);
      expect(typeof granted.value).toBe('string');
      // A symbol would throw here, which is precisely how the token would have
      // announced itself if it ever tried to cross.
      expect(() => structuredClone(granted)).not.toThrow();
    });

    it('blocks the relay while the worker holds the claim, and frees it on release', async () => {
      const a = sender();
      await handleDirectFileTransferCommand(leasePrepareCommand(), a.handle);
      const worker = spawned[0]!;
      ready(worker);

      const granted = await hostCall(worker, DIRECT_FILE_TRANSFER_HOST_METHOD.TRY_CLAIM_CLIENT_UPLOAD, ['upload-worker-owned']);
      const handle = granted.value as string;
      expect(tryClaimClientUpload('upload-worker-owned'), 'the relay cannot take a live worker claim').toBeNull();

      // A handle the host never issued must not release someone else's claim.
      await hostCall(worker, DIRECT_FILE_TRANSFER_HOST_METHOD.RELEASE_CLIENT_UPLOAD_CLAIM, ['upload-worker-owned', 'dft-claim-forged']);
      expect(tryClaimClientUpload('upload-worker-owned'), 'a forged handle releases nothing').toBeNull();

      await hostCall(worker, DIRECT_FILE_TRANSFER_HOST_METHOD.RELEASE_CLIENT_UPLOAD_CLAIM, ['upload-worker-owned', handle]);
      const afterRelease = tryClaimClientUpload('upload-worker-owned');
      expect(afterRelease, 'the real handle hands the id back').not.toBeNull();
      releaseClientUploadClaim('upload-worker-owned', afterRelease!);
    });

    it('releases a crashed worker\'s claims instead of locking the id for the daemon\'s lifetime', async () => {
      const a = sender();
      await handleDirectFileTransferCommand(leasePrepareCommand(), a.handle);
      const worker = spawned[0]!;
      ready(worker);
      await hostCall(worker, DIRECT_FILE_TRANSFER_HOST_METHOD.TRY_CLAIM_CLIENT_UPLOAD, ['upload-crashed']);

      // The worker dies holding it. Its handles die with it, so only the host
      // can give the id back.
      worker.emit('exit', 1);

      const reclaimed = tryClaimClientUpload('upload-crashed');
      expect(reclaimed, 'the relay can take over an upload the dead worker held').not.toBeNull();
      releaseClientUploadClaim('upload-crashed', reclaimed!);
    });

    it('releases claims held at shutdown as well as at crash', async () => {
      const a = sender();
      await handleDirectFileTransferCommand(leasePrepareCommand(), a.handle);
      const worker = spawned[0]!;
      ready(worker);
      await hostCall(worker, DIRECT_FILE_TRANSFER_HOST_METHOD.TRY_CLAIM_CLIENT_UPLOAD, ['upload-at-shutdown']);

      const done = shutdownDirectFileTransfers();
      worker.emitEnvelope({ type: DIRECT_FILE_TRANSFER_WORKER_MSG.SHUTDOWN_ACK, cleanupOk: true });
      await done;

      const reclaimed = tryClaimClientUpload('upload-at-shutdown');
      expect(reclaimed).not.toBeNull();
      releaseClientUploadClaim('upload-at-shutdown', reclaimed!);
    });
  });

  /**
   * Both directions are validated by the protocol's own validators, on the main
   * thread, before anything is handed on. Inbound that means before the
   * structured clone, which is the cost the worker split exists to avoid
   * paying; outbound it means the browser's transport only ever carries
   * messages the daemon protocol describes.
   */
  describe('semantic validation guards both directions', () => {
    it('refuses an invalid command before it is ever cloned into the worker', async () => {
      const a = sender();
      await handleDirectFileTransferCommand(leasePrepareCommand(), a.handle);
      const worker = spawned[0]!;
      ready(worker);
      const before = worker.posted.filter((p) => p.type === DIRECT_FILE_TRANSFER_WORKER_MSG.COMMAND).length;

      for (const bad of [
        { any: 'not a protocol message' },
        leasePrepareCommand({ protocolVersion: 999 }),
        leasePrepareCommand({ leaseGeneration: 'one' }),
        { ...leasePrepareCommand(), extraKey: 'unexpected' },
        leasePrepareCommand({ sdp: 'x'.repeat(1024) }),
        'a bare string',
        null,
      ]) {
        await expect(handleDirectFileTransferCommand(bad, a.handle), JSON.stringify(bad)?.slice(0, 60))
          .resolves.toBe(false);
      }

      const after = worker.posted.filter((p) => p.type === DIRECT_FILE_TRANSFER_WORKER_MSG.COMMAND).length;
      expect(after, 'nothing invalid reached the clone').toBe(before);
    });

    it('still forwards a protocol-legal command carrying the largest allowed SDP', async () => {
      // The guard must bound the payload without deleting real traffic: a
      // multi-candidate offer is large, and it is entirely legal.
      const a = sender();
      await handleDirectFileTransferCommand(leasePrepareCommand(), a.handle);
      const worker = spawned[0]!;
      ready(worker);
      const offer = {
        type: DIRECT_FILE_TRANSFER_MSG.LEASE_OFFER,
        protocolVersion: DIRECT_FILE_TRANSFER_PROTOCOL_VERSION,
        ...BINDING,
        sdp: `v=0\r\n${'a'.repeat(DIRECT_FILE_TRANSFER_LIMITS.SDP_BYTES - 5)}`,
      };
      await expect(handleDirectFileTransferCommand(offer, a.handle)).resolves.toBe(true);
      const forwarded = worker.posted.filter((p) => p.type === DIRECT_FILE_TRANSFER_WORKER_MSG.COMMAND);
      expect((forwarded.at(-1)!.command as { sdp: string }).sdp.length,
        'the whole offer crossed, not a truncated one').toBe(DIRECT_FILE_TRANSFER_LIMITS.SDP_BYTES);
    });

    it('does not put a message the daemon protocol never described onto the transport', async () => {
      const a = sender();
      await handleDirectFileTransferCommand(leasePrepareCommand(), a.handle);
      const worker = spawned[0]!;
      ready(worker);
      const senderId = (worker.posted.find((p) => p.type === DIRECT_FILE_TRANSFER_WORKER_MSG.COMMAND)!.senderId) as string;

      for (const bad of [
        { hello: 'arbitrary' },
        { type: 'not.a.direct_file.type', protocolVersion: DIRECT_FILE_TRANSFER_PROTOCOL_VERSION },
        leasePreparedControl({ protocolVersion: 999 }),
        { ...leasePreparedControl(), smuggled: 'extra' },
      ]) {
        worker.emitEnvelope({
          type: DIRECT_FILE_TRANSFER_WORKER_MSG.CONTROL, senderId,
          message: bad, emittedAt: Date.now(),
        });
      }
      expect(a.sent, 'the transport received none of them').toEqual([]);

      // And the real thing still gets through, so the guard is a filter, not a wall.
      worker.emitEnvelope({
        type: DIRECT_FILE_TRANSFER_WORKER_MSG.CONTROL, senderId,
        message: leasePreparedControl(), emittedAt: Date.now(),
      });
      expect(a.sent).toEqual([leasePreparedControl()]);
    });
  });

  /**
   * The upgrade path replaces node_datachannel.node in place. Only the isolate
   * holding that mapping can prove it is idle, so the main thread asks — and a
   * missing, malformed or failed answer must never read as permission.
   */
  describe('upgrade quiesce across the boundary', () => {
    async function live() {
      const a = sender();
      await handleDirectFileTransferCommand(leasePrepareCommand(), a.handle);
      const worker = spawned[0]!;
      ready(worker);
      return { a, worker };
    }
    const quiesceRequests = (w: FakeWorker) =>
      w.posted.filter((p) => p.type === DIRECT_FILE_TRANSFER_WORKER_MSG.QUIESCE);

    it('ends the worker on a proven quiesce, and refuses to start another', async () => {
      const { a, worker } = await live();
      const pending = quiesceDirectFileTransferNative(1_000);
      await vi.waitFor(() => expect(quiesceRequests(worker)).toHaveLength(1));
      worker.emitEnvelope({
        type: DIRECT_FILE_TRANSFER_WORKER_MSG.QUIESCE_RESULT, ok: true, closedLeases: 3,
      });

      await expect(pending).resolves.toEqual({ ok: true, closedLeases: 3 });
      // Draining leaves the mapping idle; ending the thread makes it unreachable.
      expect(worker.terminated, 'the isolate holding the addon is gone').toBe(1);
      expect(isDirectTransferNativeQuiesced()).toBe(true);
      // A replacement worker would map the very file about to be replaced.
      await expect(handleDirectFileTransferCommand(leasePrepareCommand(), a.handle)).resolves.toBe(false);
      expect(spawned, 'no worker is spawned after quiesce').toHaveLength(1);
    });

    it('fails closed when the worker reports it could not quiesce', async () => {
      const { worker } = await live();
      const pending = quiesceDirectFileTransferNative(1_000);
      await vi.waitFor(() => expect(quiesceRequests(worker)).toHaveLength(1));
      worker.emitEnvelope({
        type: DIRECT_FILE_TRANSFER_WORKER_MSG.QUIESCE_RESULT,
        ok: false, closedLeases: 0, reason: 'quiesce_drain_timeout',
      });

      await expect(pending).resolves.toEqual({ ok: false, closedLeases: 0, reason: 'quiesce_drain_timeout' });
      expect(worker.terminated, 'peers may still be live, so the thread is left alone').toBe(0);
      expect(isDirectTransferNativeQuiesced(), 'admission stays shut; transfer degrades to relay').toBe(true);
    });

    it('treats a worker that dies mid-quiesce as proof of nothing', async () => {
      const { worker } = await live();
      const pending = quiesceDirectFileTransferNative(1_000);
      await vi.waitFor(() => expect(quiesceRequests(worker)).toHaveLength(1));
      worker.emit('exit', 1);
      await expect(pending).resolves.toMatchObject({ ok: false, reason: 'quiesce_worker_exited' });
      expect(spawned, 'and a dead worker is not replaced while quiescing').toHaveLength(1);
    });

    it('refuses a result that cannot state the outcome, rather than reading it as success', async () => {
      vi.useFakeTimers();
      try {
        const { worker } = await live();
        const pending = quiesceDirectFileTransferNative(1_000);
        await vi.waitFor(() => expect(quiesceRequests(worker)).toHaveLength(1));
        const settled = expect(pending).resolves.toMatchObject({ ok: false, reason: 'quiesce_result_timeout' });
        // Each of these is malformed in exactly one way, and silence is the
        // only safe reading of every one of them.
        worker.emitEnvelope({ type: DIRECT_FILE_TRANSFER_WORKER_MSG.QUIESCE_RESULT, closedLeases: 0 });
        worker.emitEnvelope({ type: DIRECT_FILE_TRANSFER_WORKER_MSG.QUIESCE_RESULT, ok: true });
        worker.emitEnvelope({ type: DIRECT_FILE_TRANSFER_WORKER_MSG.QUIESCE_RESULT, ok: true, closedLeases: -1 });
        worker.emitEnvelope({ type: DIRECT_FILE_TRANSFER_WORKER_MSG.QUIESCE_RESULT, ok: 'yes', closedLeases: 0 });
        await vi.advanceTimersByTimeAsync(1_000 + SHUTDOWN_ACK_TIMEOUT_MS + 1);
        await settled;
        expect(worker.terminated, 'nothing was authorized').toBe(0);
      } finally {
        vi.useRealTimers();
      }
    });

    it('gives concurrent callers one real outcome, and repeats are free', async () => {
      const { worker } = await live();
      const first = quiesceDirectFileTransferNative(1_000);
      const second = quiesceDirectFileTransferNative(1_000);
      await vi.waitFor(() => expect(quiesceRequests(worker)).toHaveLength(1));
      expect(quiesceRequests(worker), 'the worker is asked exactly once').toHaveLength(1);
      worker.emitEnvelope({
        type: DIRECT_FILE_TRANSFER_WORKER_MSG.QUIESCE_RESULT, ok: true, closedLeases: 2,
      });
      expect(await first).toEqual(await second);
      expect(worker.terminated).toBe(1);

      // Completed quiesce is standing authority; asking again costs nothing.
      await expect(quiesceDirectFileTransferNative(1_000)).resolves.toEqual({ ok: true, closedLeases: 0 });
      expect(worker.terminated, 'and does not re-terminate').toBe(1);
      // The invariant the cheap path rests on: completion implies no live
      // isolate, because admission is shut and nothing may respawn. Stated here
      // because it is why the early return and the no-worker branch agree.
      // Generations start at 1, so 0 is unambiguously "no live worker".
      expect(workerGeneration(), 'no worker survives a completed quiesce').toBe(0);
      expect(isDirectTransferNativeQuiesced()).toBe(true);
      expect(spawned, 'and none was created by asking again').toHaveLength(1);
    });

    it('reports a quiesce with no worker as already idle', async () => {
      // Nothing ever mapped the addon in a live isolate, so nothing can fault.
      await expect(quiesceDirectFileTransferNative(1_000)).resolves.toEqual({ ok: true, closedLeases: 0 });
      expect(spawned, 'and asking must not create one').toHaveLength(0);
      expect(isDirectTransferNativeQuiesced()).toBe(true);
    });
  });

  it('R-2: the worker isolate cannot reach claim, attachment or registry authority', async () => {
    // Structural, because the property is about what the worker's isolate is
    // ABLE to touch. Every authority function is single-copy state the relay
    // path shares; a second copy inside the worker is invisible until two
    // uploads disagree about who owns an id.
    const source = await readFile(
      path.join(process.cwd(), 'src/daemon/direct-file-transfer-worker.ts'), 'utf8',
    );
    const imported = /import\s*\{([^}]*)\}\s*from\s*'\.\/file-transfer-handler\.js'/.exec(source);
    expect(imported, 'the worker still imports from the file transfer handler').toBeTruthy();
    const names = imported![1]!
      .split(',')
      .map((entry) => entry.replace(/^\s*type\s+/, '').trim())
      .filter(Boolean);
    // Path and filename helpers only: they own nothing.
    expect(names.sort()).toEqual([
      'DirectFileDownloadSource', 'createDirectUploadFilename', 'ensureUploadDirectory', 'resolveUploadPath',
    ].sort());

    // And the host side does hold them, so they were not simply dropped.
    const handler = await import('../../src/daemon/file-transfer-handler.js');
    for (const authority of Object.values(DIRECT_FILE_TRANSFER_HOST_METHOD)) {
      expect(typeof (handler as unknown as Record<string, unknown>)[authority],
        `${authority} is host-owned`).toBe('function');
    }
  });

  it('R-4/R-2: only control envelopes cross the boundary, and the proxy owns no transfer state', async () => {
    const a = sender();
    await handleDirectFileTransferCommand(leasePrepareCommand(), a.handle);
    const worker = spawned[0]!;
    ready(worker);

    for (const posted of worker.posted) {
      const envelope = validateDirectFileTransferWorkerEnvelope(posted);
      expect(envelope, 'every outbound message is a valid envelope').toBeTruthy();
      const serialized = JSON.stringify(posted);
      // File contents are read, hashed and written inside the worker; a chunk
      // crossing here would mean the data plane came back to the main loop.
      expect(serialized).not.toMatch(/"(chunk|bytes|buffer|fileData)"/);
      for (const value of Object.values(posted)) {
        expect(ArrayBuffer.isView(value), 'no binary payload may cross').toBe(false);
        expect(value instanceof ArrayBuffer, 'no raw buffer may cross').toBe(false);
      }
    }

    // The proxy exposes no lease/attempt/hash state: ownership lives in the worker.
    const proxy = await import('../../src/daemon/direct-file-transfer.js');
    for (const forbidden of ['leases', 'activeAttempts', 'uploadResumeStates', 'recentOperations']) {
      expect(Object.keys(proxy)).not.toContain(forbidden);
    }
  });
});
