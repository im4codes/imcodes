import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  STARTUP_DIAGNOSTIC_EVENT,
  STARTUP_DIAGNOSTICS_HEALTH_LEASE_TIMEOUT_MS,
  StartupDiagnosticsLog,
  startupDiagnosticsDir,
  startupDiagnosticsLogPath,
} from '../../src/node/startup-diagnostics.js';

const cleanup: string[] = [];

afterEach(async () => {
  for (const path of cleanup.splice(0)) await rm(path, { recursive: true, force: true });
});

async function readLines(logPath: string): Promise<Record<string, unknown>[]> {
  const raw = await readFile(logPath, 'utf8');
  return raw.split('\n').filter((line) => line.length > 0).map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe('startup diagnostics directory/path resolution', () => {
  it('uses the LocalSystem credential root on Windows, not a per-user profile', () => {
    expect(startupDiagnosticsDir('win32', { ProgramData: 'C:\\ProgramData' }))
      .toBe('C:\\ProgramData\\imcodes-node');
    expect(startupDiagnosticsLogPath('win32', { ProgramData: 'C:\\ProgramData' }))
      .toBe('C:\\ProgramData\\imcodes-node\\startup-diagnostics.log');
  });

  it('uses the home-based ~/.imcodes/ directory on macOS and Linux, matching the full daemon\'s own state dir', () => {
    for (const platform of ['darwin', 'linux'] as const) {
      const dir = startupDiagnosticsDir(platform);
      expect(dir.endsWith(`${dir.includes('/') ? '/' : '\\'}.imcodes`)).toBe(true);
      expect(startupDiagnosticsLogPath(platform)).toContain('startup-diagnostics.log');
    }
  });
});

describe('StartupDiagnosticsLog', () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'imcodes-startup-diagnostics-'));
    cleanup.push(directory);
  });

  it('creates the log file on first event and appends one JSON line per event', async () => {
    const logPath = join(directory, 'startup-diagnostics.log');
    const log = new StartupDiagnosticsLog({ logPath, now: () => Date.UTC(2026, 8, 22, 3, 0, 0) });

    log.record(STARTUP_DIAGNOSTIC_EVENT.PROCESS_START, { platform: 'win32', pid: 4242 });
    log.record(STARTUP_DIAGNOSTIC_EVENT.WS_CONNECT_ATTEMPT, {});
    log.record(STARTUP_DIAGNOSTIC_EVENT.WS_CONNECT_ESTABLISHED, {});
    log.record(STARTUP_DIAGNOSTIC_EVENT.AUTH_SENT, {});
    log.record(STARTUP_DIAGNOSTIC_EVENT.AUTH_ACK, {});
    await log.drain();

    const stats = await stat(logPath);
    expect(stats.isFile()).toBe(true);

    const lines = await readLines(logPath);
    expect(lines.map((line) => line.type)).toEqual([
      'process_start',
      'ws_connect_attempt',
      'ws_connect_established',
      'auth_sent',
      'auth_ack',
    ]);
    expect(lines[0]).toEqual({
      version: 1,
      timestamp: '2026-09-22T03:00:00.000Z',
      type: 'process_start',
      platform: 'win32',
      pid: 4242,
    });
  });

  it('records a connect-failed event with the error reason', async () => {
    const logPath = join(directory, 'startup-diagnostics.log');
    const log = new StartupDiagnosticsLog({ logPath, now: () => Date.UTC(2026, 8, 22, 3, 0, 0) });

    log.record(STARTUP_DIAGNOSTIC_EVENT.WS_CONNECT_FAILED, { reason: 'ECONNREFUSED' });
    await log.drain();

    const [line] = await readLines(logPath);
    expect(line).toMatchObject({ type: 'ws_connect_failed', reason: 'ECONNREFUSED' });
  });

  it('redacts a token/key/secret-bearing field before it ever reaches disk (the exact server/src/util/logger.ts convention)', async () => {
    const logPath = join(directory, 'startup-diagnostics.log');
    const log = new StartupDiagnosticsLog({ logPath, now: () => Date.UTC(2026, 8, 22, 3, 0, 0) });

    log.record(STARTUP_DIAGNOSTIC_EVENT.AUTH_SENT, {
      session_token: 'do-not-leak-this-token',
      client_secret: 'do-not-leak-this-secret',
      api_key: 'do-not-leak-this-key',
      serverId: 'srv-plain-safe-to-log',
    });
    await log.drain();

    const [line] = await readLines(logPath);
    expect(line).toEqual({
      version: 1,
      timestamp: '2026-09-22T03:00:00.000Z',
      type: 'auth_sent',
      session_token: '[REDACTED]',
      client_secret: '[REDACTED]',
      api_key: '[REDACTED]',
      serverId: 'srv-plain-safe-to-log',
    });
    const raw = await readFile(logPath, 'utf8');
    expect(raw).not.toContain('do-not-leak-this-token');
    expect(raw).not.toContain('do-not-leak-this-secret');
    expect(raw).not.toContain('do-not-leak-this-key');
  });

  it('fires a health-lease-timeout event naming the last completed step when no lease publishes within the window, using an injected clock (no real 120s wait)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const logPath = join(directory, 'startup-diagnostics.log');
      const log = new StartupDiagnosticsLog({ logPath, now: () => Date.now() });

      log.record(STARTUP_DIAGNOSTIC_EVENT.PROCESS_START, {});
      log.armHealthLeaseTimeout(STARTUP_DIAGNOSTICS_HEALTH_LEASE_TIMEOUT_MS);
      log.record(STARTUP_DIAGNOSTIC_EVENT.WS_CONNECT_ATTEMPT, {});
      log.record(STARTUP_DIAGNOSTIC_EVENT.WS_CONNECT_ESTABLISHED, {});
      log.record(STARTUP_DIAGNOSTIC_EVENT.AUTH_SENT, {});
      // Auth ack never arrives; no health_lease_published is ever recorded.

      await vi.advanceTimersByTimeAsync(STARTUP_DIAGNOSTICS_HEALTH_LEASE_TIMEOUT_MS + 1);
      await log.drain();

      const lines = await readLines(logPath);
      const timeout = lines.at(-1);
      expect(timeout).toMatchObject({
        type: 'health_lease_timeout',
        lastStep: 'auth_sent',
        timeoutMs: STARTUP_DIAGNOSTICS_HEALTH_LEASE_TIMEOUT_MS,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('never fires the timeout once a health lease actually published before the deadline', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const logPath = join(directory, 'startup-diagnostics.log');
      const log = new StartupDiagnosticsLog({ logPath, now: () => Date.now() });

      log.armHealthLeaseTimeout(STARTUP_DIAGNOSTICS_HEALTH_LEASE_TIMEOUT_MS);
      await vi.advanceTimersByTimeAsync(1_000);
      log.record(STARTUP_DIAGNOSTIC_EVENT.HEALTH_LEASE_PUBLISHED, {});

      await vi.advanceTimersByTimeAsync(STARTUP_DIAGNOSTICS_HEALTH_LEASE_TIMEOUT_MS);
      await log.drain();

      const lines = await readLines(logPath);
      expect(lines.map((line) => line.type)).toEqual(['health_lease_published']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('rotates the log once it exceeds the configured size, keeping one backup', async () => {
    const logPath = join(directory, 'startup-diagnostics.log');
    const log = new StartupDiagnosticsLog({
      logPath,
      maxBytes: 200,
      maxFiles: 2,
      now: () => Date.UTC(2026, 8, 22, 3, 0, 0),
    });

    for (let i = 0; i < 10; i += 1) {
      log.record(STARTUP_DIAGNOSTIC_EVENT.WS_CONNECT_ATTEMPT, { attempt: i, padding: 'x'.repeat(20) });
    }
    await log.drain();

    const stats = await stat(logPath);
    expect(stats.size).toBeLessThanOrEqual(200 + 200); // one record's worth of slack over the cap
    const backupExists = await stat(`${logPath}.1`).then(() => true, () => false);
    expect(backupExists).toBe(true);
  });

  it('rotates a log older than the configured max age even when well under the size cap', async () => {
    const logPath = join(directory, 'startup-diagnostics.log');
    // Pre-seed a real file so `rename` has something to move, but control
    // its reported age through an injected `stat` rather than the real OS
    // mtime — this must be deterministic, not a race against real wall time.
    await writeFile(logPath, `${JSON.stringify({ version: 1, timestamp: 'old', type: 'process_start' })}\n`, 'utf8');

    const now = Date.UTC(2026, 8, 22, 3, 0, 0);
    const realStat = stat;
    const log = new StartupDiagnosticsLog({
      logPath,
      maxAgeMs: 1_000,
      maxFiles: 2,
      now: () => now,
      fileSystem: {
        stat: async (path: Parameters<typeof stat>[0]) => {
          const info = await realStat(path);
          // Report the pre-seeded file as already 2s old — well past the
          // 1s maxAgeMs — regardless of its real OS mtime.
          return { ...info, mtimeMs: now - 2_000 } as Awaited<ReturnType<typeof stat>>;
        },
      },
    });
    log.record(STARTUP_DIAGNOSTIC_EVENT.WS_CONNECT_ATTEMPT, {});
    await log.drain();

    const backupExists = await stat(`${logPath}.1`).then(() => true, () => false);
    expect(backupExists).toBe(true);
    const lines = await readLines(logPath);
    expect(lines).toHaveLength(1);
    expect(lines[0]?.type).toBe('ws_connect_attempt');
  });

  it('is best-effort: a filesystem failure drops the batch and opens a retry window instead of throwing', async () => {
    const logPath = join(directory, 'does-not-exist', 'nested', 'startup-diagnostics.log');
    const log = new StartupDiagnosticsLog({
      logPath,
      now: () => Date.UTC(2026, 8, 22, 3, 0, 0),
      fileSystem: {
        mkdir: async () => { throw new Error('EACCES: permission denied'); },
      },
    });

    expect(() => log.record(STARTUP_DIAGNOSTIC_EVENT.PROCESS_START, {})).not.toThrow();
    await log.drain();
    expect(log.droppedForTests()).toBeGreaterThan(0);
  });
});
