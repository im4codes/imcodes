import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const loggerMock = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));

const replicateMock = vi.hoisted(() => vi.fn(async () => ({
  replicatedNamespaces: 0,
  replicatedProjections: 0,
  failures: [],
})));

const workerRunMock = vi.hoisted(() => vi.fn(async () => []));

vi.mock('../../src/util/logger.js', () => ({
  default: loggerMock,
}));

vi.mock('../../src/context/processed-context-replication.js', () => ({
  replicatePendingProcessedContext: replicateMock,
}));

vi.mock('../../src/store/context-store-worker-client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/store/context-store-worker-client.js')>();
  return {
    ...actual,
    getContextStoreClient: () => ({
      run: workerRunMock,
    }),
  };
});

import {
  runContextMaterializationPollTick,
  runContextReplicationPollTick,
  startContextMaterializationPoller,
} from '../../src/daemon/lifecycle.js';
import {
  isMemoryDaemonEnabled,
  isMemoryDisabledError,
  MemoryDisabledError,
  MEMORY_DISABLED_MESSAGE,
  setMemoryDaemonEnabled,
} from '../../src/store/memory-daemon-switch.js';
import { ContextStoreError } from '../../src/store/context-store-worker-client.js';
import { LiveContextIngestion } from '../../src/context/live-context-ingestion.js';

describe('context materialization & replication pollers with daemon memory switch', () => {
  const originalSwitchPath = process.env.IMCODES_MEMORY_DAEMON_SWITCH_PATH;
  let tempDir: string;
  let stopPoller: (() => void) | null = null;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'imcodes-ctx-poller-'));
    process.env.IMCODES_MEMORY_DAEMON_SWITCH_PATH = join(tempDir, 'memory-daemon-switch.json');
    loggerMock.info.mockClear();
    loggerMock.warn.mockClear();
    loggerMock.error.mockClear();
    loggerMock.debug.mockClear();
    replicateMock.mockClear();
    workerRunMock.mockClear();
  });

  afterEach(() => {
    stopPoller?.();
    stopPoller = null;
    vi.useRealTimers();
    if (originalSwitchPath === undefined) delete process.env.IMCODES_MEMORY_DAEMON_SWITCH_PATH;
    else process.env.IMCODES_MEMORY_DAEMON_SWITCH_PATH = originalSwitchPath;
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('preserves default enabled polling, skips silently when disabled, and resumes automatically when re-enabled', async () => {
    vi.useFakeTimers();
    const flushAllRetryBuffers = vi.fn(async () => {});
    const flushDueTargets = vi.fn(async () => {});

    expect(isMemoryDaemonEnabled()).toBe(true);
    stopPoller = startContextMaterializationPoller({ flushAllRetryBuffers, flushDueTargets });

    // Default state (no file on disk): first 15s tick flushes normally.
    await vi.advanceTimersByTimeAsync(15_000);
    expect(flushAllRetryBuffers).toHaveBeenCalledTimes(1);
    expect(flushDueTargets).toHaveBeenCalledTimes(1);
    expect(loggerMock.warn).not.toHaveBeenCalled();

    // Disable memory: subsequent ticks skip flushing and emit zero warnings.
    setMemoryDaemonEnabled(false);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(flushAllRetryBuffers).toHaveBeenCalledTimes(1);
    expect(flushDueTargets).toHaveBeenCalledTimes(1);
    expect(loggerMock.warn).not.toHaveBeenCalled();

    // Re-enable memory without restarting daemon/poller: next tick resumes automatically.
    setMemoryDaemonEnabled(true);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(flushAllRetryBuffers).toHaveBeenCalledTimes(2);
    expect(flushDueTargets).toHaveBeenCalledTimes(2);
    expect(loggerMock.warn).not.toHaveBeenCalled();
  });

  it('treats in-flight MemoryDisabledError and worker-serialized memory_disabled ContextStoreError as quiet no-ops while warning on real errors', async () => {
    const flushAllRetryBuffers = vi.fn(async () => {});
    const flushDueTargets = vi.fn(async () => {});

    for (const disabledErr of [
      new MemoryDisabledError(),
      new ContextStoreError('memory_disabled', MEMORY_DISABLED_MESSAGE),
      new ContextStoreError('op_failed', MEMORY_DISABLED_MESSAGE),
    ]) {
      expect(isMemoryDisabledError(disabledErr)).toBe(true);
      flushDueTargets.mockRejectedValueOnce(disabledErr);
      await runContextMaterializationPollTick({ flushAllRetryBuffers, flushDueTargets });
      expect(loggerMock.warn).not.toHaveBeenCalled();
    }
    expect(loggerMock.debug).toHaveBeenCalledTimes(3);

    const realErr = new ContextStoreError('op_failed', 'SQLITE_BUSY: database is locked');
    expect(isMemoryDisabledError(realErr)).toBe(false);
    flushDueTargets.mockRejectedValueOnce(realErr);
    await runContextMaterializationPollTick({ flushAllRetryBuffers, flushDueTargets });
    expect(loggerMock.warn).toHaveBeenCalledTimes(1);
    expect(loggerMock.warn).toHaveBeenCalledWith({ err: realErr }, 'Context materialization poll failed');
  });

  it('guards context replication poller ticks against disabled memory and memory_disabled race errors', async () => {
    const creds = { workerUrl: 'https://example.test', serverId: 'srv-1', token: 'tok' };

    setMemoryDaemonEnabled(false);
    await runContextReplicationPollTick(creds);
    expect(replicateMock).not.toHaveBeenCalled();
    expect(loggerMock.warn).not.toHaveBeenCalled();

    setMemoryDaemonEnabled(true);
    replicateMock.mockRejectedValueOnce(new ContextStoreError('memory_disabled', MEMORY_DISABLED_MESSAGE));
    await runContextReplicationPollTick(creds);
    expect(loggerMock.warn).not.toHaveBeenCalled();

    const realErr = new Error('network down');
    replicateMock.mockRejectedValueOnce(realErr);
    await runContextReplicationPollTick(creds);
    expect(loggerMock.warn).toHaveBeenCalledTimes(1);
    expect(loggerMock.warn).toHaveBeenCalledWith({ err: realErr }, 'Processed-context replication failed');
  });

  it('skips materializeDueMasterSummaries and retry/target flushes in LiveContextIngestion when memory is disabled', async () => {
    const ingestion = new LiveContextIngestion({
      sessionLookup: () => undefined,
      resolveBootstrap: async () => {
        throw new Error('unused');
      },
    });
    try {
      setMemoryDaemonEnabled(false);
      await ingestion.flushAllRetryBuffers();
      await ingestion.flushDueTargets();
      await ingestion.coordinator.materializeDueMasterSummaries();
      expect(workerRunMock).not.toHaveBeenCalled();
    } finally {
      ingestion.dispose();
    }
  });
});
