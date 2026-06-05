import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  formatDurationSeconds,
  getDaemonServerLinkFreshness,
  parseWindowsWmicCreationDateEpochMs,
  parsePsElapsedSeconds,
  readDaemonRestartCount,
  readDaemonRuntimeStatus,
  readPersistedDaemonUptimeSeconds,
  readProcessUptimeSeconds,
  readServiceRestartCount,
  recordDaemonStart,
  recordDaemonServerLinkStatus,
  setDaemonRuntimeDiagnosticsProvider,
} from '../../src/util/daemon-status.js';

describe('daemon status helpers', () => {
  it('parses ps elapsed seconds and elapsed time formats', () => {
    expect(parsePsElapsedSeconds('123')).toBe(123);
    expect(parsePsElapsedSeconds('01:02')).toBe(62);
    expect(parsePsElapsedSeconds('03:04:05')).toBe(11_045);
    expect(parsePsElapsedSeconds('2-03:04:05')).toBe(183_845);
  });

  it('rejects invalid ps elapsed values', () => {
    expect(parsePsElapsedSeconds('')).toBeNull();
    expect(parsePsElapsedSeconds('1-2-3')).toBeNull();
    expect(parsePsElapsedSeconds('00:00:99')).toBeNull();
    expect(parsePsElapsedSeconds('not-time')).toBeNull();
  });

  it('formats uptime compactly', () => {
    expect(formatDurationSeconds(9)).toBe('9s');
    expect(formatDurationSeconds(65)).toBe('1m 5s');
    expect(formatDurationSeconds(3_660)).toBe('1h 1m');
    expect(formatDurationSeconds(90_061)).toBe('1d 1h 1m');
  });

  it('reads process uptime from ps etimes', () => {
    const runner = vi.fn(() => '456\n');

    expect(readProcessUptimeSeconds(123, runner)).toBe(456);
    expect(runner).toHaveBeenCalledWith(
      'ps',
      ['-p', '123', '-o', 'etimes='],
      expect.any(Object),
    );
  });

  it('falls back to ps etime when etimes is unavailable', () => {
    const runner = vi.fn((file: string, args: string[]) => {
      if (args.includes('etimes=')) throw new Error('unsupported');
      return '01:02:03\n';
    });

    expect(readProcessUptimeSeconds(123, runner)).toBe(3_723);
  });

  it('uses the ps etime fallback on macOS when etimes is unavailable', () => {
    const runner = vi.fn((file: string, args: string[]) => {
      if (args.includes('etimes=')) throw new Error('unsupported');
      return '2-03:04:05\n';
    });

    expect(readProcessUptimeSeconds(123, runner, 'darwin')).toBe(183_845);
  });

  it('reads Windows process uptime from PowerShell CIM output', () => {
    const runner = vi.fn(() => '789\n');

    expect(readProcessUptimeSeconds(123, runner, 'win32')).toBe(789);
    expect(runner).toHaveBeenCalledWith(
      'powershell',
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        expect.stringContaining('ProcessId = 123'),
      ],
      expect.objectContaining({ windowsHide: true }),
    );
  });

  it('falls back to Windows wmic CreationDate when PowerShell is unavailable', () => {
    const runner = vi.fn((file: string) => {
      if (file === 'powershell') throw new Error('powershell unavailable');
      return 'CreationDate=20260505080000.000000+480\r\r\n\r\r\n';
    });
    const nowMs = Date.UTC(2026, 4, 5, 0, 10, 0);

    expect(readProcessUptimeSeconds(123, runner, 'win32', nowMs)).toBe(600);
    expect(runner).toHaveBeenLastCalledWith(
      'wmic',
      ['process', 'where', 'ProcessId=123', 'get', 'CreationDate', '/value'],
      expect.objectContaining({ windowsHide: true }),
    );
  });

  it('parses Windows wmic CreationDate with timezone offset', () => {
    expect(parseWindowsWmicCreationDateEpochMs('CreationDate=20260505080000.123456+480'))
      .toBe(Date.UTC(2026, 4, 5, 0, 0, 0, 123));
    expect(parseWindowsWmicCreationDateEpochMs('CreationDate=20260505023000.000000-300'))
      .toBe(Date.UTC(2026, 4, 5, 7, 30, 0, 0));
    expect(parseWindowsWmicCreationDateEpochMs('CreationDate=20261305080000.000000+480')).toBeNull();
  });

  it('reads systemd restart count on linux when available', () => {
    const runner = vi.fn(() => '7\n');

    expect(readServiceRestartCount('linux', runner)).toBe(7);
    expect(runner).toHaveBeenCalledWith(
      'systemctl',
      ['--user', 'show', 'imcodes', '--property=NRestarts', '--value'],
      expect.any(Object),
    );
  });

  it('omits restart count on non-systemd platforms or command failure', () => {
    expect(readServiceRestartCount('darwin', vi.fn())).toBeNull();
    expect(readServiceRestartCount('linux', vi.fn(() => { throw new Error('missing'); }))).toBeNull();
  });

  it('records daemon runtime status and increments restart count on a new pid', () => {
    const dir = mkdtempSync(join(tmpdir(), 'imcodes-daemon-status-'));
    try {
      expect(recordDaemonStart({ pid: 100, nowMs: 1_000, baseDir: dir, version: '1.0.0' })).toMatchObject({
        pid: 100,
        startedAt: 1_000,
        restartCount: 0,
        version: '1.0.0',
      });
      expect(recordDaemonStart({ pid: 100, nowMs: 2_000, baseDir: dir, version: '1.0.0' })?.restartCount).toBe(0);
      expect(recordDaemonStart({ pid: 101, nowMs: 3_000, baseDir: dir, version: '1.0.1' })?.restartCount).toBe(1);
      expect(readDaemonRuntimeStatus(dir)).toMatchObject({
        pid: 101,
        startedAt: 3_000,
        restartCount: 1,
        version: '1.0.1',
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('records server link health without changing daemon restart count', () => {
    const dir = mkdtempSync(join(tmpdir(), 'imcodes-daemon-status-'));
    try {
      recordDaemonStart({ pid: 400, nowMs: 10_000, baseDir: dir, version: '1.0.0' });
      expect(recordDaemonServerLinkStatus({
        pid: 400,
        nowMs: 11_000,
        baseDir: dir,
        state: 'connected',
        serverId: 'srv_1',
        workerUrl: 'https://example.test',
        lastConnectedAt: 11_000,
        lastHeartbeatAckAt: 12_000,
      })).toMatchObject({
        pid: 400,
        restartCount: 0,
        serverLink: {
          state: 'connected',
          serverId: 'srv_1',
          workerUrl: 'https://example.test',
          lastConnectedAt: 11_000,
          lastHeartbeatAckAt: 12_000,
        },
      });

      expect(recordDaemonServerLinkStatus({
        pid: 400,
        nowMs: 13_000,
        baseDir: dir,
        state: 'disconnected',
        lastDisconnectedAt: 13_000,
        lastError: 'closed:1006',
      })?.restartCount).toBe(0);
      expect(readDaemonRuntimeStatus(dir)?.serverLink).toMatchObject({
        state: 'disconnected',
        serverId: 'srv_1',
        lastDisconnectedAt: 13_000,
        lastError: 'closed:1006',
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('records daemon runtime diagnostics on status writes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'imcodes-daemon-status-'));
    try {
      setDaemonRuntimeDiagnosticsProvider(() => ({
        capturedAt: 11_000,
        transportQueues: {
          sessionCount: 1,
          totalPendingCount: 1,
          totalResendCount: 1,
          totalActiveDispatchCount: 0,
          sessions: [{
            sessionName: 'deck_test_brain',
            agentType: 'qwen',
            status: 'idle',
            sending: false,
            pendingCount: 1,
            pendingVersion: 3,
            activeDispatchCount: 0,
            stalePendingRecoveryActive: true,
            providerSessionBound: true,
            lastActivityAt: 10_500,
            lastActivityAgeMs: 500,
            resendCount: 1,
            resendEntries: [{
              commandId: 'cmd-1',
              queuedAt: 10_000,
              ageMs: 1_000,
              textPreview: 'hello',
            }],
          }],
        },
        p2p: {
          activeCount: 1,
          discussionWriteQueueCount: 1,
          discussionWritePendingBytes: 42,
          runs: [{
            id: 'run-1',
            discussionId: 'disc-1',
            status: 'running',
            runPhase: 'round_execution',
            activePhase: 'hop',
            currentRound: 1,
            totalRounds: 3,
            currentTargetSession: 'deck_test_w1',
            currentTargetLabel: 'deck_test_w1',
            hopStartedAt: 10_000,
            hopElapsedMs: 1_000,
            executionAttempt: null,
            executionCycleCurrent: null,
            executionCycleTotal: null,
            executionMarkerPath: null,
            error: null,
          }],
        },
      }));

      recordDaemonStart({ pid: 500, nowMs: 11_000, baseDir: dir, version: 'diag' });
      const status = readDaemonRuntimeStatus(dir);
      expect(status?.diagnostics?.transportQueues?.totalPendingCount).toBe(1);
      expect(status?.diagnostics?.transportQueues?.sessions[0]?.stalePendingRecoveryActive).toBe(true);
      expect(status?.diagnostics?.transportQueues?.sessions[0]?.resendEntries?.[0]?.commandId).toBe('cmd-1');
      expect(status?.diagnostics?.p2p?.runs[0]?.id).toBe('run-1');
    } finally {
      setDaemonRuntimeDiagnosticsProvider(null);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps daemon runtime status writable when diagnostics collection throws', () => {
    const dir = mkdtempSync(join(tmpdir(), 'imcodes-daemon-status-'));
    try {
      setDaemonRuntimeDiagnosticsProvider(() => {
        throw new Error('diagnostics unavailable');
      });

      expect(recordDaemonStart({ pid: 501, nowMs: 12_000, baseDir: dir, version: 'diag-fail' })).toMatchObject({
        pid: 501,
        version: 'diag-fail',
      });
      const status = readDaemonRuntimeStatus(dir);
      expect(status?.pid).toBe(501);
      expect(status?.diagnostics).toBeUndefined();
    } finally {
      setDaemonRuntimeDiagnosticsProvider(null);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('classifies server link freshness from the last proof timestamp', () => {
    expect(getDaemonServerLinkFreshness(null, 10_000)).toMatchObject({ status: 'unknown', fresh: false });
    expect(getDaemonServerLinkFreshness({
      pid: 1,
      startedAt: 1,
      updatedAt: 1,
      restartCount: 0,
      serverLink: { state: 'connected', updatedAt: 1_000, lastConnectedAt: 1_000, lastHeartbeatAckAt: 9_000 },
    }, 10_000, 2_000)).toMatchObject({ status: 'connected', fresh: true, staleMs: 1_000 });
    expect(getDaemonServerLinkFreshness({
      pid: 1,
      startedAt: 1,
      updatedAt: 1,
      restartCount: 0,
      serverLink: { state: 'connected', updatedAt: 1_000, lastConnectedAt: 1_000, lastHeartbeatAckAt: 3_000 },
    }, 10_000, 2_000)).toMatchObject({ status: 'stale', fresh: false, staleMs: 7_000 });
    expect(getDaemonServerLinkFreshness({
      pid: 1,
      startedAt: 1,
      updatedAt: 1,
      restartCount: 0,
      serverLink: { state: 'disconnected', updatedAt: 8_000, lastDisconnectedAt: 8_000 },
    }, 10_000, 2_000)).toMatchObject({ status: 'disconnected', fresh: false });
  });

  it('uses persisted runtime status as restart count and uptime fallback', () => {
    const dir = mkdtempSync(join(tmpdir(), 'imcodes-daemon-status-'));
    try {
      recordDaemonStart({ pid: 200, nowMs: 10_000, baseDir: dir });
      recordDaemonStart({ pid: 201, nowMs: 20_000, baseDir: dir });

      expect(readDaemonRestartCount('win32', vi.fn(), dir)).toBe(1);
      expect(readDaemonRestartCount('darwin', vi.fn(), dir)).toBe(1);
      expect(readPersistedDaemonUptimeSeconds(201, 25_500, dir)).toBe(5);
      expect(readPersistedDaemonUptimeSeconds(999, 25_500, dir)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('prefers systemd restart count over persisted runtime status on linux', () => {
    const dir = mkdtempSync(join(tmpdir(), 'imcodes-daemon-status-'));
    try {
      recordDaemonStart({ pid: 300, nowMs: 10_000, baseDir: dir });
      recordDaemonStart({ pid: 301, nowMs: 20_000, baseDir: dir });

      expect(readDaemonRestartCount('linux', vi.fn(() => '7\n'), dir)).toBe(7);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
