import net from 'node:net';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DAEMON_COMMAND_TYPES } from '../../shared/daemon-command-types.js';
import { DAEMON_MSG } from '../../shared/daemon-events.js';
import { NODE_ROLE } from '../../shared/remote-exec.js';
import {
  COMPUTER_USE_IPC_HELPER_HELLO,
  ComputerUseIpcHost,
  computerUseIpcDeadlineMs,
  computerUseIpcPipePath,
  quoteWinArg,
  runComputerUseIpcHelper,
  windowsPipeClientAclCommand,
} from '../../src/node/computer-use-ipc.js';
import { allowWindowsNamedPipeClients } from '../../src/node/windows-user-session.js';
import type { MacosComputerUseRuntime, MacosConsoleUser } from '../../src/node/macos-computer-use.js';
import { downloadControlledNodeComputerUseHelper } from '../../src/node/self-upgrade.js';

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('computer use IPC Windows argv quoting', () => {
  it('preserves named pipe backslashes for CreateProcessAsUser command lines', () => {
    expect(quoteWinArg('\\\\.\\pipe\\imcodes-computer-use-123')).toBe('"\\\\.\\pipe\\imcodes-computer-use-123"');
  });

  it('escapes embedded quotes without doubling ordinary path separators', () => {
    expect(quoteWinArg('C:\\Program Files\\im "codes"\\node.exe')).toBe('"C:\\Program Files\\im \\"codes\\"\\node.exe"');
  });

  it('doubles trailing backslashes before the closing quote', () => {
    expect(quoteWinArg('C:\\Temp\\')).toBe('"C:\\Temp\\\\"');
  });
});

describe('computer use IPC Windows pipe ACL', () => {
  it('grants the random per-call pipe to authenticated local users', () => {
    expect(windowsPipeClientAclCommand('\\\\.\\pipe\\imcodes-computer-use-123')).toEqual([
      '\\\\.\\pipe\\imcodes-computer-use-123',
      '/grant',
      '*S-1-5-11:F',
    ]);
  });

  it('awaits the authenticated-user ACL without blocking the event loop', async () => {
    const calls: Array<{ file: string; args: readonly string[] }> = [];
    let completed = false;
    const child = new EventEmitter();
    const applying = allowWindowsNamedPipeClients('\\\\.\\pipe\\imcodes-remote-desktop-123', ((file, args, _options, callback) => {
      calls.push({ file, args: args ?? [] });
      queueMicrotask(() => {
        completed = true;
        callback?.(null, '', '');
      });
      return child;
    }) as unknown as typeof import('node:child_process').execFile);
    expect(completed).toBe(false);
    await expect(applying).resolves.toBeUndefined();
    expect(completed).toBe(true);
    expect(calls).toEqual([{
      file: 'icacls',
      args: ['\\\\.\\pipe\\imcodes-remote-desktop-123', '/grant', '*S-1-5-11:F'],
    }]);
  });
});

describe('computer use IPC deadline', () => {
  it('keeps the full 900 second shell timeout plus transport cleanup buffer', () => {
    expect(computerUseIpcDeadlineMs({ tool: 'shell_session1', timeoutMs: 900_000 })).toBe(905_000);
    expect(computerUseIpcDeadlineMs({ tool: 'list_apps', timeoutMs: 120_000 })).toBe(125_000);
  });
});

describe('computer use IPC helper lifecycle', () => {
  it('keeps the macOS socket path below the sockaddr_un byte limit', () => {
    const macTempDir = `/var/folders/ab/${'c'.repeat(32)}/T`;
    const path = computerUseIpcPipePath(
      macTempDir,
      `1234567890-${'f'.repeat(16)}`,
      'darwin',
    );

    expect(Buffer.byteLength(path)).toBeLessThanOrEqual(103);
  });

  it('closes persistent OCU/browser children when the owning node socket disconnects', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'icu-'));
    dirs.push(dir);
    const pipe = join(dir, 'c.sock');
    const closeRuntime = vi.fn(async () => {});
    const server = net.createServer((socket) => {
      socket.once('data', () => socket.destroy());
    });
    await new Promise<void>((resolve) => server.listen(pipe, resolve));

    await runComputerUseIpcHelper(pipe, closeRuntime);

    expect(closeRuntime).toHaveBeenCalledOnce();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
});

describe('computer use IPC macOS GUI-session boundary', () => {
  it('authorizes the socket, prompts for desktop permissions, and executes through the user helper', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'imcodes-ipc-macos-test-'));
    dirs.push(dir);
    const execPath = join(dir, 'imcodes-node');
    const sourceOcu = join(dir, 'computer-use-helper', 'open-computer-use.app.zip');
    await mkdir(join(dir, 'computer-use-helper'));
    await writeFile(execPath, 'node');
    await writeFile(sourceOcu, 'ocu');
    const user: MacosConsoleUser = {
      name: 'desktop-user',
      uid: 501,
      gid: 20,
      home: '/Users/desktop-user',
      tempDir: '/private/tmp/user/',
    };
    const runtime: MacosComputerUseRuntime = {
      helperExecutable: '/public/imcodes-helper',
      openComputerUseExecutable: '/public/Open Computer Use.app/Contents/MacOS/OpenComputerUse',
    };
    const authorizeSocket = vi.fn(async () => {});
    const runDoctor = vi.fn(async () => {});
    const launchHelper = vi.fn((_user: MacosConsoleUser, _runtime: MacosComputerUseRuntime, pipe: string) => {
      const socket = net.createConnection(pipe, () => {
        socket.write(`${JSON.stringify({ hello: COMPUTER_USE_IPC_HELPER_HELLO })}\n`);
      });
      socket.setEncoding('utf8');
      let buffer = '';
      socket.on('data', (chunk) => {
        buffer += String(chunk);
        const newline = buffer.indexOf('\n');
        if (newline < 0) return;
        const request = JSON.parse(buffer.slice(0, newline)) as {
          id: string;
          request: { correlationId: string; tool: 'list_apps' };
        };
        socket.write(`${JSON.stringify({
          id: request.id,
          result: {
            type: DAEMON_MSG.COMPUTER_USE_RESULT,
            correlationId: request.request.correlationId,
            ok: true,
            tool: request.request.tool,
            content: [{ type: 'text', text: 'Safari' }],
            durationMs: 1,
          },
        })}\n`);
      });
    });
    const host = new ComputerUseIpcHost({
      platform: 'darwin',
      arch: 'arm64',
      execPath,
      resolveMacosConsoleUser: async () => user,
      prepareMacosComputerUseRuntime: async () => runtime,
      authorizeMacosComputerUseSocket: authorizeSocket,
      runMacosComputerUseDoctor: runDoctor,
      launchMacosUserSessionHelper: launchHelper,
    });

    try {
      const result = await host.call({
        type: DAEMON_COMMAND_TYPES.COMPUTER_USE,
        correlationId: 'corr-macos-1',
        tool: 'list_apps',
      });
      expect(result).toMatchObject({
        ok: true,
        tool: 'list_apps',
        content: [{ type: 'text', text: 'Safari' }],
      });
      expect(authorizeSocket).toHaveBeenCalledOnce();
      expect(runDoctor).toHaveBeenCalledWith(user, runtime);
      expect(launchHelper).toHaveBeenCalledWith(user, runtime, expect.stringMatching(/iccu-/));
    } finally {
      host.close();
    }
  });

  it('restarts a disconnected helper instead of reusing a resolved readiness promise', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'imcodes-ipc-macos-reconnect-test-'));
    dirs.push(dir);
    const execPath = join(dir, 'imcodes-node');
    await mkdir(join(dir, 'computer-use-helper'));
    await writeFile(execPath, 'node');
    await writeFile(join(dir, 'computer-use-helper', 'open-computer-use.app.zip'), 'ocu-archive');
    const user: MacosConsoleUser = {
      name: 'desktop-user',
      uid: 501,
      gid: 20,
      home: '/Users/desktop-user',
      tempDir: '/private/tmp/user/',
    };
    const runtime: MacosComputerUseRuntime = {
      helperExecutable: '/public/imcodes-helper',
      openComputerUseExecutable: '/public/Open Computer Use.app/Contents/MacOS/OpenComputerUse',
    };
    let responseCount = 0;
    const launchHelper = vi.fn((_user: MacosConsoleUser, _runtime: MacosComputerUseRuntime, pipe: string) => {
      const socket = net.createConnection(pipe, () => {
        socket.write(`${JSON.stringify({ hello: COMPUTER_USE_IPC_HELPER_HELLO })}\n`);
      });
      socket.setEncoding('utf8');
      let buffer = '';
      socket.on('data', (chunk) => {
        buffer += String(chunk);
        const newline = buffer.indexOf('\n');
        if (newline < 0) return;
        const request = JSON.parse(buffer.slice(0, newline)) as {
          id: string;
          request: { correlationId: string; tool: 'browser_close' };
        };
        responseCount++;
        socket.end(`${JSON.stringify({
          id: request.id,
          result: {
            type: DAEMON_MSG.COMPUTER_USE_RESULT,
            correlationId: request.request.correlationId,
            ok: true,
            tool: request.request.tool,
            content: [{ type: 'text', text: `closed-${responseCount}` }],
            durationMs: 1,
          },
        })}\n`);
      });
    });
    const host = new ComputerUseIpcHost({
      platform: 'darwin',
      arch: 'arm64',
      execPath,
      resolveMacosConsoleUser: async () => user,
      prepareMacosComputerUseRuntime: async () => runtime,
      authorizeMacosComputerUseSocket: async () => {},
      runMacosComputerUseDoctor: async () => {},
      launchMacosUserSessionHelper: launchHelper,
    });

    try {
      const first = await host.call({
        type: DAEMON_COMMAND_TYPES.COMPUTER_USE,
        correlationId: 'corr-reconnect-1',
        tool: 'browser_close',
      });
      expect(first.content[0]?.text).toBe('closed-1');
      await new Promise((resolve) => setTimeout(resolve, 20));
      const second = await host.call({
        type: DAEMON_COMMAND_TYPES.COMPUTER_USE,
        correlationId: 'corr-reconnect-2',
        tool: 'browser_close',
      });
      expect(second.content[0]?.text).toBe('closed-2');
      expect(launchHelper).toHaveBeenCalledTimes(2);
    } finally {
      host.close();
    }
  });

  it('downloads the OCU sidecar on a fresh macOS installation before launching the user helper', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'imcodes-ipc-macos-download-test-'));
    dirs.push(dir);
    const execPath = join(dir, 'imcodes-node');
    await writeFile(execPath, 'node');
    const user: MacosConsoleUser = {
      name: 'desktop-user',
      uid: 501,
      gid: 20,
      home: '/Users/desktop-user',
      tempDir: '/private/tmp/user/',
    };
    const runtime: MacosComputerUseRuntime = {
      helperExecutable: '/public/imcodes-helper',
      openComputerUseExecutable: '/public/Open Computer Use.app/Contents/MacOS/OpenComputerUse',
    };
    const downloadHelper = vi.fn(async (input: { dir: string; target: { os: string; arch: string } }) => {
      expect(input.target).toEqual({ os: 'mac', arch: 'universal' });
      const helperDir = join(input.dir, 'computer-use-helper', 'darwin-universal');
      const artifactPath = join(helperDir, 'open-computer-use.app.zip');
      await mkdir(helperDir, { recursive: true });
      await writeFile(artifactPath, 'downloaded-ocu');
      return { helperDir, artifactPath, sha256: 'a'.repeat(64), sizeBytes: 14 };
    });
    const prepareRuntime = vi.fn(async (
      _sourceNodeExecutable: string,
      sourceOpenComputerUseArchive: string | undefined,
    ) => {
      expect(sourceOpenComputerUseArchive).toBeTruthy();
      expect(await readFile(sourceOpenComputerUseArchive!, 'utf8')).toBe('downloaded-ocu');
      return runtime;
    });
    const launchHelper = vi.fn((_user: MacosConsoleUser, _runtime: MacosComputerUseRuntime, pipe: string) => {
      const socket = net.createConnection(pipe, () => {
        socket.write(`${JSON.stringify({ hello: COMPUTER_USE_IPC_HELPER_HELLO })}\n`);
      });
      socket.setEncoding('utf8');
      socket.once('data', (chunk) => {
        const request = JSON.parse(String(chunk).trim()) as {
          id: string;
          request: { correlationId: string; tool: 'browser_close' };
        };
        socket.write(`${JSON.stringify({
          id: request.id,
          result: {
            type: DAEMON_MSG.COMPUTER_USE_RESULT,
            correlationId: request.request.correlationId,
            ok: true,
            tool: request.request.tool,
            content: [{ type: 'text', text: 'closed' }],
            durationMs: 1,
          },
        })}\n`);
      });
    });
    const host = new ComputerUseIpcHost({
      credential: {
        serverUrl: 'https://im.example',
        serverId: 'server-1',
        token: 'secret',
        nodeRole: NODE_ROLE.CONTROLLED,
      },
      platform: 'darwin',
      arch: 'x64',
      execPath,
      macosComputerUseRuntimeRoot: join(dir, 'empty-runtime'),
      resolveMacosConsoleUser: async () => user,
      prepareMacosComputerUseRuntime: prepareRuntime,
      authorizeMacosComputerUseSocket: async () => {},
      runMacosComputerUseDoctor: async () => {},
      launchMacosUserSessionHelper: launchHelper,
      downloadMacosComputerUseHelper: downloadHelper as unknown as typeof downloadControlledNodeComputerUseHelper,
    });

    try {
      const result = await host.call({
        type: DAEMON_COMMAND_TYPES.COMPUTER_USE,
        correlationId: 'corr-download-1',
        tool: 'browser_close',
      });
      expect(result.ok).toBe(true);
      expect(downloadHelper).toHaveBeenCalledOnce();
      expect(prepareRuntime).toHaveBeenCalledOnce();
      expect(launchHelper).toHaveBeenCalledOnce();
    } finally {
      host.close();
    }
  });
});
