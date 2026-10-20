import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  REMOTE_DESKTOP_WORKER_DIAGNOSTIC_EVENT,
  RemoteDesktopWorkerDiagnostics,
  remoteDesktopWorkerDiagnosticsPath,
} from '../../src/node/remote-desktop-worker-diagnostics.js';
import { REMOTE_DESKTOP_TERMINAL_REASON } from '../../shared/remote-desktop.js';

const correlationId = '0123456789abcdef01234567';
const cleanup: string[] = [];

afterEach(async () => {
  for (const path of cleanup.splice(0)) await rm(path, { recursive: true, force: true });
});

describe('RemoteDesktopWorkerDiagnostics', () => {
  it('uses the LocalSystem credential root rather than a user profile', () => {
    expect(remoteDesktopWorkerDiagnosticsPath({ ProgramData: 'C:\\ProgramData' }))
      .toContain('imcodes-node');
    expect(remoteDesktopWorkerDiagnosticsPath({ ProgramData: 'C:\\ProgramData' }))
      .toContain('remote-desktop-worker.log');
  });

  it('writes only its bounded closed schema and never arbitrary payloads', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'imcodes-worker-diagnostics-'));
    cleanup.push(directory);
    const logPath = join(directory, 'worker.log');
    const writer = new RemoteDesktopWorkerDiagnostics({
      logPath,
      now: () => Date.UTC(2026, 7, 29, 12, 0, 0),
    });

    writer.write({
      event: REMOTE_DESKTOP_WORKER_DIAGNOSTIC_EVENT.PIPE_ERROR,
      correlationId,
      workerGeneration: 4,
      workerPid: 91,
      elapsedMs: 30_024,
      errorCode: 'EPIPE',
      token: 'node-secret',
      sdp: 'v=0',
      iceServers: [{ credential: 'ice-secret' }],
      input: 'keystroke',
      screen: 'pixels',
      installLink: 'bearer',
      message: 'raw exception text',
    } as never);
    await writer.drain();

    const record = JSON.parse(await readFile(logPath, 'utf8')) as Record<string, unknown>;
    expect(record).toEqual({
      version: 1,
      timestamp: '2026-08-29T12:00:00.000Z',
      event: 'pipe_error',
      correlationId,
      workerGeneration: 4,
      workerPid: 91,
      elapsedMs: 30_024,
      errorCode: 'EPIPE',
    });
    expect(JSON.stringify(record)).not.toMatch(
      /node-secret|ice-secret|keystroke|pixels|bearer|raw exception|v=0/,
    );
  });

  it('runtime-validates every known key and drops allowed-key secret injections', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'imcodes-worker-diagnostics-'));
    cleanup.push(directory);
    const logPath = join(directory, 'worker.log');
    const writer = new RemoteDesktopWorkerDiagnostics({
      logPath,
      now: () => Date.UTC(2026, 7, 29, 12, 0, 0),
    });
    writer.write({
      event: REMOTE_DESKTOP_WORKER_DIAGNOSTIC_EVENT.CLEANUP,
      correlationId,
      workerGeneration: { token: 'GENERATION_SECRET' },
      workerPid: { token: 'PID_SECRET' },
      elapsedMs: 'ELAPSED_SECRET',
      launchMode: 'SECRET_BEARER_VALUE',
      errorCode: 'SECRET_ERROR_CODE',
      hadError: { token: 'SECOND_SECRET' },
      exitCode: { token: 'EXIT_SECRET' },
      signal: 'SECRET_SIGNAL',
      observedBy: 'SECRET_OBSERVER',
      cleanupReason: 'secret_cleanup_reason',
      terminalReason: 'SECRET_TERMINAL_REASON',
      stdio: 'SECRET_STDIO',
    } as never);
    writer.write({
      event: 'SECRET_EVENT',
      correlationId,
    } as never);
    writer.write({
      event: REMOTE_DESKTOP_WORKER_DIAGNOSTIC_EVENT.CLEANUP,
      correlationId: { token: 'CORRELATION_SECRET' },
    } as never);
    await writer.drain();

    const text = await readFile(logPath, 'utf8');
    expect(text.trim().split('\n')).toHaveLength(1);
    expect(JSON.parse(text)).toEqual({
      version: 1,
      timestamp: '2026-08-29T12:00:00.000Z',
      event: 'cleanup',
      correlationId,
    });
    expect(text).not.toMatch(/SECRET|secret/);
  });

  it('records only a shared terminal reason beside worker-declared cleanup', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'imcodes-worker-diagnostics-'));
    cleanup.push(directory);
    const logPath = join(directory, 'worker.log');
    const writer = new RemoteDesktopWorkerDiagnostics({
      logPath,
      now: () => Date.UTC(2026, 8, 4, 0, 0, 0),
    });
    writer.write({
      event: REMOTE_DESKTOP_WORKER_DIAGNOSTIC_EVENT.CLEANUP,
      correlationId,
      cleanupReason: 'worker_terminal',
      terminalReason: REMOTE_DESKTOP_TERMINAL_REASON.PROTOCOL_ERROR,
    });
    await writer.drain();

    expect(JSON.parse(await readFile(logPath, 'utf8'))).toEqual({
      version: 1,
      timestamp: '2026-09-04T00:00:00.000Z',
      event: 'cleanup',
      correlationId,
      cleanupReason: 'worker_terminal',
      terminalReason: REMOTE_DESKTOP_TERMINAL_REASON.PROTOCOL_ERROR,
    });
  });

  it('defers every filesystem operation off the lifecycle callback', async () => {
    const scheduled: (() => void)[] = [];
    let releaseAppend!: () => void;
    const fileSystem = {
      mkdir: vi.fn(async () => undefined),
      stat: vi.fn(async () => {
        const error = new Error('missing') as NodeJS.ErrnoException;
        error.code = 'ENOENT';
        throw error;
      }),
      appendFile: vi.fn(() => new Promise<void>((resolve) => { releaseAppend = resolve; })),
      rename: vi.fn(async () => undefined),
      rm: vi.fn(async () => undefined),
    };
    const writer = new RemoteDesktopWorkerDiagnostics({
      logPath: '/not-read-synchronously/worker.log',
      schedule: (callback) => scheduled.push(callback),
      fileSystem: fileSystem as never,
    });

    writer.write({
      event: REMOTE_DESKTOP_WORKER_DIAGNOSTIC_EVENT.SPAWN_VERIFIED,
      correlationId,
    });
    expect(fileSystem.mkdir).not.toHaveBeenCalled();
    expect(fileSystem.stat).not.toHaveBeenCalled();
    expect(fileSystem.appendFile).not.toHaveBeenCalled();
    expect(scheduled).toHaveLength(1);

    scheduled.shift()!();
    await vi.waitFor(() => expect(fileSystem.appendFile).toHaveBeenCalledOnce());
    releaseAppend();
    await writer.drain();
  });

  it('coalesces adjacent duplicates and drops newest at fixed queue capacity', () => {
    const writer = new RemoteDesktopWorkerDiagnostics({
      queueCapacity: 2,
      schedule: () => {},
      now: () => 100,
    });
    const event = {
      event: REMOTE_DESKTOP_WORKER_DIAGNOSTIC_EVENT.PIPE_ERROR,
      correlationId,
      errorCode: 'EPIPE',
      elapsedMs: 1,
    } as const;
    writer.write(event);
    writer.write(event);
    writer.write({ ...event, elapsedMs: 2 });
    writer.write({ ...event, elapsedMs: 3 });

    expect(writer.queueState()).toEqual({
      pending: 2,
      dropped: 1,
      coalesced: 1,
      flushing: true,
    });
  });

  it('rotates within fixed file and byte bounds', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'imcodes-worker-diagnostics-'));
    cleanup.push(directory);
    const logPath = join(directory, 'worker.log');
    const writer = new RemoteDesktopWorkerDiagnostics({
      logPath,
      maxBytes: 1024,
      maxFiles: 3,
    });
    for (let index = 0; index < 80; index++) {
      writer.write({
        event: REMOTE_DESKTOP_WORKER_DIAGNOSTIC_EVENT.PREPARE_SENT,
        correlationId,
        elapsedMs: index,
      });
    }
    await writer.drain();

    for (const path of [logPath, `${logPath}.1`, `${logPath}.2`]) {
      expect((await stat(path)).size).toBeLessThanOrEqual(1024);
    }
    await expect(stat(`${logPath}.3`)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('fails open and rate-limits retries after ENOSPC', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'imcodes-worker-diagnostics-'));
    cleanup.push(directory);
    await mkdir(directory, { recursive: true });
    let now = 100;
    const appendFile = vi.fn(async () => {
      const error = new Error('disk full') as NodeJS.ErrnoException;
      error.code = 'ENOSPC';
      throw error;
    });
    const writer = new RemoteDesktopWorkerDiagnostics({
      logPath: join(directory, 'worker.log'),
      retryMs: 60_000,
      now: () => now,
      fileSystem: { appendFile: appendFile as never },
    });
    const event = {
      event: REMOTE_DESKTOP_WORKER_DIAGNOSTIC_EVENT.SPAWN_VERIFIED,
      correlationId,
    } as const;

    expect(() => writer.write(event)).not.toThrow();
    expect(() => writer.write(event)).not.toThrow();
    await writer.drain();
    expect(appendFile).toHaveBeenCalledTimes(1);
    now += 60_000;
    expect(() => writer.write(event)).not.toThrow();
    await writer.drain();
    expect(appendFile).toHaveBeenCalledTimes(2);
  });
});
