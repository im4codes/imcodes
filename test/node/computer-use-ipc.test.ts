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
  windowsComputerUseHelperLaunchSpecForTest,
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

  it('launches the interactive helper directly instead of opening a cmd console', () => {
    expect(windowsComputerUseHelperLaunchSpecForTest(
      'C:\\ProgramData\\imcodes-node\\imcodes-node.exe',
      '\\\\.\\pipe\\imcodes-computer-use-123',
      undefined,
    )).toEqual({
      executable: 'C:\\ProgramData\\imcodes-node\\imcodes-node.exe',
      argsLine: '"--computer-use-helper" "--pipe" "\\\\.\\pipe\\imcodes-computer-use-123"',
    });
  });

  it('retains the JavaScript entry only when the runtime executable is node.exe', () => {
    expect(windowsComputerUseHelperLaunchSpecForTest(
      'C:\\Program Files\\nodejs\\node.exe',
      '\\\\.\\pipe\\imcodes-computer-use-123',
      'C:\\imcodes\\dist\\src\\node\\index.js',
    ).argsLine).toBe(
      '"C:\\imcodes\\dist\\src\\node\\index.js" "--computer-use-helper" "--pipe" "\\\\.\\pipe\\imcodes-computer-use-123"',
    );
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
    const sweepOrphans = vi.fn(async () => ({}));
    const server = net.createServer((socket) => {
      socket.once('data', () => socket.destroy());
    });
    await new Promise<void>((resolve) => server.listen(pipe, resolve));

    await runComputerUseIpcHelper(pipe, closeRuntime, sweepOrphans);

    expect(sweepOrphans).toHaveBeenCalledOnce();
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

  it('relaunches when the socket is dead but its close event has not landed yet', async () => {
    // The window between `destroy()` (synchronous: `destroyed` is true at
    // once) and the `close` event (a macrotask). In that window the readiness
    // promise is still the RESOLVED one from the first connect, because
    // nothing clears it on success -- so `ensureStarted` awaits an
    // already-resolved promise, finds the socket still dead, and calls itself
    // again. Awaiting a resolved promise only yields to the microtask queue,
    // which means `close` can never run and the loop never ends: the daemon's
    // whole event loop stops, and every caller -- not just this one -- hangs
    // until something kills the process.
    const dir = await mkdtemp(join(tmpdir(), 'imcodes-ipc-macos-deadsocket-test-'));
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
      socket.on('error', () => {});
      socket.on('data', (chunk) => {
        buffer += String(chunk);
        const newline = buffer.indexOf('\n');
        if (newline < 0) return;
        const request = JSON.parse(buffer.slice(0, newline)) as {
          id: string;
          request: { correlationId: string; tool: 'list_apps' };
        };
        buffer = '';
        responseCount++;
        socket.write(`${JSON.stringify({
          id: request.id,
          result: {
            type: DAEMON_MSG.COMPUTER_USE_RESULT,
            correlationId: request.request.correlationId,
            ok: true,
            tool: request.request.tool,
            content: [{ type: 'text', text: `apps-${responseCount}` }],
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
        correlationId: 'corr-dead-1',
        tool: 'list_apps',
      });
      expect(first.content[0]?.text).toBe('apps-1');

      // Kill the socket and call in the SAME tick, with no sleep in between.
      // A sleep here is what hides this: it lets `close` run first and takes
      // the test through the recovery path that already works.
      (host as unknown as { socket: { destroy(): void } }).socket.destroy();
      const second = await host.call({
        type: DAEMON_COMMAND_TYPES.COMPUTER_USE,
        correlationId: 'corr-dead-2',
        tool: 'list_apps',
      });
      expect(second.content[0]?.text).toBe('apps-2');
      expect(launchHelper).toHaveBeenCalledTimes(2);
    } finally {
      host.close();
    }
  });

  it('frees the path when a launch fails, so the next call can still bind', async () => {
    // Found on a real Windows node: after one failed start, every later call
    // died with EADDRINUSE on a pipe name only this process can use. Closing
    // the server is not instant -- the path stays bound until the close
    // completes -- so dropping the reference and rejecting left the path held
    // by nothing. OCU was then unreachable until the daemon restarted, which
    // is what "it has never worked" looked like from outside.
    const dir = await mkdtemp(join(tmpdir(), 'imcodes-ipc-macos-rebind-test-'));
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
    let failNext = true;
    const launchHelper = vi.fn((_user: MacosConsoleUser, _runtime: MacosComputerUseRuntime, pipe: string) => {
      if (failNext) {
        failNext = false;
        throw new Error('helper_launch_refused');
      }
      const socket = net.createConnection(pipe, () => {
        socket.write(`${JSON.stringify({ hello: COMPUTER_USE_IPC_HELPER_HELLO })}\n`);
      });
      socket.setEncoding('utf8');
      socket.on('error', () => {});
      let buffer = '';
      socket.on('data', (chunk) => {
        buffer += String(chunk);
        const newline = buffer.indexOf('\n');
        if (newline < 0) return;
        const request = JSON.parse(buffer.slice(0, newline)) as {
          id: string;
          request: { correlationId: string; tool: 'list_apps' };
        };
        buffer = '';
        socket.write(`${JSON.stringify({
          id: request.id,
          result: {
            type: DAEMON_MSG.COMPUTER_USE_RESULT,
            correlationId: request.request.correlationId,
            ok: true,
            tool: request.request.tool,
            content: [{ type: 'text', text: 'recovered' }],
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

    // The order of these three is the whole fix, and on a unix socket the
    // race is usually won by luck -- the close finishes before the rebind and
    // the test passes either way. So the ordering is recorded and asserted
    // directly rather than inferred from the outcome.
    const order: string[] = [];
    const realListen = net.Server.prototype.listen;
    const realClose = net.Server.prototype.close;
    const listenSpy = vi.spyOn(net.Server.prototype, 'listen').mockImplementation(function listen(
      this: net.Server,
      ...args: Parameters<typeof realListen>
    ) {
      order.push('listen');
      return realListen.apply(this, args);
    } as typeof realListen);
    const closeSpy = vi.spyOn(net.Server.prototype, 'close').mockImplementation(function close(
      this: net.Server,
      callback?: (err?: Error) => void,
    ) {
      order.push('close:start');
      return realClose.call(this, (err?: Error) => {
        order.push('close:done');
        callback?.(err);
      });
    } as typeof realClose);

    try {
      await expect(host.call({
        type: DAEMON_COMMAND_TYPES.COMPUTER_USE,
        correlationId: 'corr-rebind-1',
        tool: 'list_apps',
      })).rejects.toThrow('helper_launch_refused');

      // The failure has to be survivable. Asserted as the successful result
      // rather than "not EADDRINUSE", because a different error here would
      // still mean the node stays unreachable.
      const second = await host.call({
        type: DAEMON_COMMAND_TYPES.COMPUTER_USE,
        correlationId: 'corr-rebind-2',
        tool: 'list_apps',
      });
      expect(second.content[0]?.text).toBe('recovered');

      // Nothing may bind the path again until the previous close has actually
      // completed. On Windows it does not merely race -- the pipe name is
      // per-process, so an early rebind fails outright and stays failed.
      const secondListen = order.lastIndexOf('listen');
      expect(order.slice(0, secondListen), order.join(' -> ')).toContain('close:done');
    } finally {
      listenSpy.mockRestore();
      closeSpy.mockRestore();
      host.close();
    }
  });

  it('starts exactly one helper when several calls arrive against a dead socket', async () => {
    // Found by three concurrent calls on a real Windows node. `startHelper`
    // was `async`, so it returned at its first `await` and published the
    // in-flight promise only afterwards -- a window in which the next caller
    // saw "nobody is connecting" and started a second helper. Both bound the
    // same path and the loser got EADDRINUSE, which on Windows is permanent:
    // the pipe name belongs to this process, so no retry frees it.
    const dir = await mkdtemp(join(tmpdir(), 'imcodes-ipc-macos-concurrent-test-'));
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
    const launchHelper = vi.fn((_user: MacosConsoleUser, _runtime: MacosComputerUseRuntime, pipe: string) => {
      const socket = net.createConnection(pipe, () => {
        socket.write(`${JSON.stringify({ hello: COMPUTER_USE_IPC_HELPER_HELLO })}\n`);
      });
      socket.setEncoding('utf8');
      socket.on('error', () => {});
      let buffer = '';
      socket.on('data', (chunk) => {
        buffer += String(chunk);
        for (;;) {
          const newline = buffer.indexOf('\n');
          if (newline < 0) return;
          const request = JSON.parse(buffer.slice(0, newline)) as {
            id: string;
            request: { correlationId: string; tool: 'list_apps' };
          };
          buffer = buffer.slice(newline + 1);
          socket.write(`${JSON.stringify({
            id: request.id,
            result: {
              type: DAEMON_MSG.COMPUTER_USE_RESULT,
              correlationId: request.request.correlationId,
              ok: true,
              tool: request.request.tool,
              content: [{ type: 'text', text: request.request.correlationId }],
              durationMs: 1,
            },
          })}\n`);
        }
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

    const frame = (id: string) => ({
      type: DAEMON_COMMAND_TYPES.COMPUTER_USE,
      correlationId: id,
      tool: 'list_apps' as const,
    });

    try {
      // Cold, three at once: one helper between them.
      const coldIds = ['corr-cold-1', 'corr-cold-2', 'corr-cold-3'];
      const cold = await Promise.all(coldIds.map((id) => host.call(frame(id))));
      expect(cold.map((result) => result.content[0]?.text)).toEqual(coldIds);
      expect(launchHelper, 'one helper for three cold callers').toHaveBeenCalledTimes(1);

      // And again in the window where the socket is dead but its close has not
      // been delivered -- all three must share the one relaunch.
      (host as unknown as { socket: { destroy(): void } }).socket.destroy();
      const revivedIds = ['corr-revive-1', 'corr-revive-2', 'corr-revive-3'];
      const revived = await Promise.all(revivedIds.map((id) => host.call(frame(id))));
      expect(revived.map((result) => result.content[0]?.text)).toEqual(revivedIds);
      expect(launchHelper, 'one relaunch, not one per caller').toHaveBeenCalledTimes(2);
    } finally {
      host.close();
    }
  });

  it('retries a request that never left the process, and never one that did', async () => {
    // Two different failures that look alike from the caller's seat:
    //   write fails  -> the helper never saw it -> safe to send again
    //   no answer    -> the helper may have done it -> NOT safe to send again
    // Repeating a click because the answer went missing is worse than saying
    // the answer went missing.
    const dir = await mkdtemp(join(tmpdir(), 'imcodes-ipc-macos-retry-test-'));
    dirs.push(dir);
    const execPath = join(dir, 'imcodes-node');
    await mkdir(join(dir, 'computer-use-helper'));
    await writeFile(execPath, 'node');
    await writeFile(join(dir, 'computer-use-helper', 'open-computer-use.app.zip'), 'ocu-archive');
    const user: MacosConsoleUser = {
      name: 'desktop-user', uid: 501, gid: 20, home: '/Users/desktop-user', tempDir: '/private/tmp/user/',
    };
    const runtime: MacosComputerUseRuntime = {
      helperExecutable: '/public/imcodes-helper',
      openComputerUseExecutable: '/public/Open Computer Use.app/Contents/MacOS/OpenComputerUse',
    };
    // How many of the next requests to swallow: taken, then the helper dies
    // without answering.
    let dieForNextRequests = 0;
    const launchHelper = vi.fn((_user: MacosConsoleUser, _runtime: MacosComputerUseRuntime, pipe: string) => {
      const socket = net.createConnection(pipe, () => {
        socket.write(`${JSON.stringify({ hello: COMPUTER_USE_IPC_HELPER_HELLO })}\n`);
      });
      socket.setEncoding('utf8');
      socket.on('error', () => {});
      let buffer = '';
      socket.on('data', (chunk) => {
        buffer += String(chunk);
        const newline = buffer.indexOf('\n');
        if (newline < 0) return;
        const request = JSON.parse(buffer.slice(0, newline)) as {
          id: string;
          request: { correlationId: string; tool: 'click' | 'list_apps' };
        };
        buffer = '';
        if (dieForNextRequests > 0) {
          // Took the request, then died. Whether the click happened is
          // unknowable from here, which is the entire point.
          dieForNextRequests--;
          socket.destroy();
          return;
        }
        socket.write(`${JSON.stringify({
          id: request.id,
          result: {
            type: DAEMON_MSG.COMPUTER_USE_RESULT,
            correlationId: request.request.correlationId,
            ok: true,
            tool: request.request.tool,
            content: [{ type: 'text', text: 'answered' }],
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
        type: DAEMON_COMMAND_TYPES.COMPUTER_USE, correlationId: 'corr-retry-warm', tool: 'list_apps',
      });
      expect(first.content[0]?.text).toBe('answered');
      expect(launchHelper).toHaveBeenCalledTimes(1);

      // A write the OS refuses: exactly what a helper that exited a moment ago
      // produces, because the socket still looks alive until it does not.
      const live = (host as unknown as { socket: net.Socket }).socket;
      const realWrite = live.write.bind(live);
      let refused = false;
      (live as unknown as { write: net.Socket['write'] }).write = ((
        data: string,
        callback?: (err?: Error) => void,
      ) => {
        if (refused) return realWrite(data, callback as never);
        refused = true;
        setImmediate(() => callback?.(Object.assign(new Error('write EPIPE'), { code: 'EPIPE' })));
        return true;
      }) as net.Socket['write'];

      const retried = await host.call({
        type: DAEMON_COMMAND_TYPES.COMPUTER_USE, correlationId: 'corr-retry-epipe', tool: 'click',
      });
      expect(retried.content[0]?.text, 'a refused write is resent').toBe('answered');
      expect(launchHelper, 'and the resend goes to a fresh helper').toHaveBeenCalledTimes(2);

      // Now the other kind: the helper takes the request and dies. A click may
      // already have landed, so it is reported, not repeated.
      dieForNextRequests = 1;
      const launchesBefore = launchHelper.mock.calls.length;
      await expect(host.call({
        type: DAEMON_COMMAND_TYPES.COMPUTER_USE, correlationId: 'corr-retry-silent', tool: 'click',
      })).rejects.toThrow('computer_use_helper_disconnected');
      expect(launchHelper.mock.calls.length, 'a delivered click is never sent twice')
        .toBe(launchesBefore);

      // The same lost answer for a tool that only looks is simply asked again.
      // This is the everyday case: the helper was killed or restarted, and
      // asking which windows are open costs nothing to repeat.
      dieForNextRequests = 1;
      const beforeLook = launchHelper.mock.calls.length;
      const looked = await host.call({
        type: DAEMON_COMMAND_TYPES.COMPUTER_USE, correlationId: 'corr-retry-readonly', tool: 'list_apps',
      });
      expect(looked.content[0]?.text, 'the lost look is asked again').toBe('answered');
      expect(launchHelper.mock.calls.length, 'and a helper was started for the second ask')
        .toBeGreaterThan(beforeLook);
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
