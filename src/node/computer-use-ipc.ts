import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdtemp, rm } from 'node:fs/promises';
import net from 'node:net';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  closeComputerUseRuntimeForProcessExit,
  runComputerUseTool,
  WINDOWS_DEFAULT_OCU_DIR,
} from './computer-use-runner.js';
import { sweepComputerUseOrphanedResources } from '../daemon/session-resource-service.js';
import { applyWindowsAclCommands, windowsComputerUseHelperAclCommands } from './installer.js';
import {
  authorizeMacosComputerUseSocket,
  prepareMacosComputerUseRuntime,
  MACOS_COMPUTER_USE_RUNTIME_ROOT,
  type MacosComputerUseRuntime,
  type MacosConsoleUser,
} from './macos-computer-use.js';
import {
  launchMacosUserSessionCommand,
  resolveMacosUserSession,
  runMacosUserSessionCommand,
} from './user-session-launcher.js';
import {
  controlledNodeArtifactTarget,
  downloadControlledNodeComputerUseHelper,
} from './self-upgrade.js';
import type { ControlledNodeCredential } from './enrollment.js';
import {
  COMPUTER_USE_DEFAULT_TIMEOUT_MS,
  computerUseMaxTimeoutMs,
  isReadOnlyComputerUseTool,
  validateComputerUseFrame,
  validateComputerUseResultFrame,
  type ComputerUseFrame,
  type ComputerUseResultFrame,
  type ComputerUseToolName,
} from '../../shared/computer-use.js';
import {
  controlledNodeComputerUseHelperFilename,
  CONTROLLED_NODE_OS_MAC,
} from '../../shared/controlled-node-artifacts.js';
import { DAEMON_MSG } from '../../shared/daemon-events.js';
import {
  allowWindowsNamedPipeClients,
  launchWindowsActiveUserElevatedCommand,
  quoteWindowsArgument,
  windowsNamedPipeClientAclCommand,
} from './windows-user-session.js';

/**
 * The request never reached the helper.
 *
 * Its own type because the difference between "not sent" and "sent, no answer"
 * decides whether retrying is safe: only the first can be repeated without
 * risking a second click.
 */
class ComputerUseSendFailure extends Error {
  constructor(readonly cause: Error) {
    super(cause.message);
    this.name = 'ComputerUseSendFailure';
  }
}

interface IpcRequestWire { id: string; request: ComputerUseFrame }
interface IpcResultWire { id: string; result?: ComputerUseResultFrame; error?: string }
interface IpcHelloWire { hello: typeof COMPUTER_USE_IPC_HELPER_HELLO }

export const COMPUTER_USE_IPC_HELPER_HELLO = 'imcodes-computer-use-helper-v1' as const;

/**
 * How many passes `ensureStarted` makes before it reports failure: one to wait
 * out an attempt already in flight, one to make its own, and a little room for
 * a retired server closing in between.
 */
export const COMPUTER_USE_IPC_START_ATTEMPTS = 4;

export function computerUseIpcDeadlineMs(frame: Pick<ComputerUseFrame, 'tool' | 'timeoutMs'>): number {
  return Math.min(
    frame.timeoutMs ?? COMPUTER_USE_DEFAULT_TIMEOUT_MS,
    computerUseMaxTimeoutMs(frame.tool),
  ) + 5_000;
}

type PendingIpc = {
  resolve: (value: ComputerUseResultFrame) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

export function computerUseIpcPipePath(
  tempRoot: string,
  suffix: string,
  platform: NodeJS.Platform = process.platform,
): string {
  return platform === 'win32'
    ? `\\\\.\\pipe\\imcodes-computer-use-${suffix}`
    // Darwin sockaddr_un.sun_path is only 104 bytes including the trailing NUL.
    : join(tempRoot, `iccu-${suffix}.sock`);
}

function pipePath(): string {
  const suffix = `${process.pid}-${randomBytes(8).toString('hex')}`;
  return computerUseIpcPipePath(tmpdir(), suffix);
}

export const quoteWinArg = quoteWindowsArgument;

function helperArgv(
  pipe: string,
  runtimeExecutable = process.execPath,
  entry = process.argv[1],
): string[] {
  const isNodeRuntime = /(?:^|[/\\])node(?:\.exe)?$/i.test(runtimeExecutable);
  return isNodeRuntime && entry
    ? [entry, '--computer-use-helper', '--pipe', pipe]
    : ['--computer-use-helper', '--pipe', pipe];
}

export const windowsPipeClientAclCommand = windowsNamedPipeClientAclCommand;

const allowWindowsPipeClients = allowWindowsNamedPipeClients;

function allowWindowsComputerUseHelperFiles(): void {
  if (!existsSync(WINDOWS_DEFAULT_OCU_DIR)) return;
  applyWindowsAclCommands(windowsComputerUseHelperAclCommands(WINDOWS_DEFAULT_OCU_DIR));
}

export function windowsComputerUseHelperLaunchSpecForTest(
  exe: string,
  pipe: string,
  entry = process.argv[1],
): { executable: string; argsLine: string } {
  return {
    executable: exe,
    argsLine: helperArgv(pipe, exe, entry).map(quoteWinArg).join(' '),
  };
}

function launchWindowsUserSessionHelper(
  exe: string,
  pipe: string,
  onLaunchFailure?: (detail: string) => void,
): void {
  const { executable, argsLine } = windowsComputerUseHelperLaunchSpecForTest(exe, pipe);
  // Launch the helper directly. Routing it through cmd.exe created an extra
  // console-subsystem process on every GUI machine and made a blank console
  // flash/persist whenever the OCU IPC helper was started.
  //
  // With the active administrator's linked token, exactly as the remote-desktop
  // worker already does. The helper IS the daemon binary, and that binary is
  // manifested `requireAdministrator` so its installer can prompt for UAC. Sent
  // into the interactive user's filtered token it can therefore never start:
  // CreateProcessAsUser answers ERROR_ELEVATION_REQUIRED before the process
  // exists. Standard users and non-UAC accounts keep the normal WTS token.
  launchWindowsActiveUserElevatedCommand(executable, argsLine, spawn, onLaunchFailure);
}

function launchSameSessionHelper(exe: string, pipe: string): void {
  const child = spawn(exe, helperArgv(pipe), {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();
}

export interface ComputerUseIpcHostOptions {
  credential?: ControlledNodeCredential;
  platform?: NodeJS.Platform;
  arch?: NodeJS.Architecture;
  execPath?: string;
  macosComputerUseRuntimeRoot?: string;
  fetchImpl?: typeof fetch;
  downloadMacosComputerUseHelper?: typeof downloadControlledNodeComputerUseHelper;
  resolveMacosConsoleUser?: () => Promise<MacosConsoleUser>;
  prepareMacosComputerUseRuntime?: (
    sourceNodeExecutable: string,
    sourceOpenComputerUseArchive: string | undefined,
  ) => Promise<MacosComputerUseRuntime>;
  authorizeMacosComputerUseSocket?: (path: string, user: MacosConsoleUser) => Promise<void>;
  runMacosComputerUseDoctor?: (user: MacosConsoleUser, runtime: MacosComputerUseRuntime) => Promise<void>;
  launchMacosUserSessionHelper?: (
    user: MacosConsoleUser,
    runtime: MacosComputerUseRuntime,
    pipe: string,
  ) => void;
}

export class ComputerUseIpcHost {
  private server: net.Server | null = null;
  private socket: net.Socket | null = null;
  private pending = new Map<string, PendingIpc>();
  private buffer = '';
  private readyPromise: Promise<void> | null = null;
  private readonly path = pipePath();
  /** Why the last launch attempt failed, when the launcher managed to say. */
  private lastLaunchFailure: string | null = null;

  constructor(private readonly options: ComputerUseIpcHostOptions = {}) {}

  async call(frame: ComputerUseFrame): Promise<ComputerUseResultFrame> {
    try {
      return await this.send(frame);
    } catch (err) {
      if (!this.retryable(err, frame.tool)) throw err;
      return await this.send(frame);
    }
  }

  /**
   * May this exact failure be sent again? Once, and only when repeating it is
   * harmless.
   *
   * Two failures look identical to a caller and are not:
   *
   * - The write itself failed, so the helper never saw the request. A helper
   *   that exited a moment ago leaves a socket that still looks alive until
   *   the OS catches up, and this is the common case on a machine where the
   *   helper was restarted. Always safe to resend.
   * - The connection dropped with the request already sent. Whether the tool
   *   ran is unknowable from here, so it depends on the tool: asking what
   *   windows are open twice costs nothing, clicking twice is a different
   *   click.
   */
  private retryable(err: unknown, tool: ComputerUseToolName): boolean {
    if (err instanceof ComputerUseSendFailure) return true;
    if (!isReadOnlyComputerUseTool(tool)) return false;
    return err instanceof Error && err.message === 'computer_use_helper_disconnected';
  }

  private async send(frame: ComputerUseFrame): Promise<ComputerUseResultFrame> {
    await this.ensureStarted(frame.tool);
    const socket = this.socket;
    if (!socket || socket.destroyed) throw new ComputerUseSendFailure(new Error('computer_use_helper_not_connected'));
    const id = randomBytes(12).toString('hex');
    const timeoutMs = computerUseIpcDeadlineMs(frame);
    return await new Promise<ComputerUseResultFrame>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('computer_use_ipc_timeout'));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      socket.write(`${JSON.stringify({ id, request: frame } satisfies IpcRequestWire)}\n`, (err) => {
        if (!err) return;
        clearTimeout(timer);
        this.pending.delete(id);
        // The socket is gone; drop it so the retry starts a helper rather than
        // writing into the same dead pipe.
        if (this.socket === socket) this.socket = null;
        socket.destroy();
        reject(new ComputerUseSendFailure(err));
      });
    });
  }

  close(): void {
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error('computer_use_ipc_closed'));
      this.pending.delete(id);
    }
    this.socket?.destroy();
    this.socket = null;
    this.server?.close();
    this.server = null;
    this.readyPromise = null;
  }

  /**
   * Get a live helper connection, or fail saying so.
   *
   * A bounded loop, deliberately not recursion. This used to call itself when
   * it woke up to a socket that was still dead, and there is a window where
   * that never ends: `destroy()` marks a socket destroyed synchronously while
   * its `close` event -- the thing that clears the readiness promise and
   * relaunches -- is a macrotask. Land a call in that window and the old code
   * awaited an already-resolved promise, found the socket still dead, and
   * called itself again. Awaiting a resolved promise only yields to the
   * microtask queue, so `close` could never run: the loop starved the entire
   * event loop and then grew the stack until the daemon died of heap
   * exhaustion. Every caller hung, not just this one, which is what "OCU times
   * out" looked like from outside.
   *
   * So: each pass either waits for an attempt already in flight or makes one,
   * and after a few passes it gives up with an error. An error is a thing a
   * caller can report; an unbounded retry is a thing that takes the process
   * with it.
   */
  private async ensureStarted(tool: ComputerUseToolName): Promise<void> {
    for (let attempt = 0; attempt < COMPUTER_USE_IPC_START_ATTEMPTS; attempt++) {
      if (this.socket && !this.socket.destroyed) return;
      const inFlight = this.readyPromise;
      if (inFlight) {
        // Someone else is already connecting, or a retired server is still
        // closing. Either way the next pass re-reads the state.
        await inFlight;
        continue;
      }
      await this.startHelper(tool);
    }
    if (this.socket && !this.socket.destroyed) return;
    throw new Error('computer_use_helper_not_connected');
  }

  /**
   * Start one helper, published before it awaits anything.
   *
   * NOT `async`. An async function runs to its first `await` and only then
   * returns, so anything this method does before publishing `readyPromise` is
   * a window in which a second caller sees "nobody is connecting" and starts a
   * helper of its own. Two servers then bind one path and the loser gets
   * EADDRINUSE -- which on Windows is fatal, because the pipe name belongs to
   * this process and no retry can free it. Found by three concurrent calls
   * against a dead socket on a real node.
   *
   * So the in-flight promise is assigned in the same synchronous turn as the
   * call, and everything slow -- closing the old server, binding, launching --
   * happens inside it.
   */
  private startHelper(tool: ComputerUseToolName): Promise<void> {
    // Every teardown path below clears the readiness promise, and each must
    // clear *its own* attempt only: a slow failure from an abandoned attempt
    // must not blank out the attempt that replaced it, which would leave the
    // replacement running with nothing pointing at it.
    const holder: { promise: Promise<void> | null } = { promise: null };
    const clearReady = (): void => {
      if (this.readyPromise === holder.promise) this.readyPromise = null;
    };
    const ready = (async () => {
      // A previous attempt's server can still be listening on this path: its
      // socket is dead, but the `close` event that retires the server has not
      // run yet. Binding the same path again fails outright, so take the old
      // one down first and wait for it.
      await this.closeServer();
      if (this.socket?.destroyed) this.socket = null;
      await new Promise<void>((resolve, reject) => {
        let timer: ReturnType<typeof setTimeout>;
        const server = net.createServer((socket) => {
          this.acceptConnection(socket, () => {
            clearTimeout(timer);
            resolve();
          });
        });
        this.server = server;
        /**
         * End this attempt.
         *
         * The server is *retired*, not merely closed and forgotten. `close()`
         * only stops accepting; the path stays bound until the close completes.
         * Dropping the reference here and rejecting used to leave the pipe
         * half-closed with nothing holding it, and every later attempt then died
         * on `EADDRINUSE` against a name only this process can use -- so a
         * single failed start turned into OCU being unreachable until the daemon
         * was restarted. Retiring parks the close where the next attempt waits
         * for it.
         */
        const fail = (error: Error): void => {
          clearTimeout(timer);
          clearReady();
          if (this.server === server) this.retireServer();
          else void new Promise<void>((done) => server.close(() => done()));
          reject(error);
        };
        timer = setTimeout(() => {
          // Carry the launcher's own words when it left any. A bare timeout says
          // only that nothing connected; it never says the helper was refused
          // before it could exist.
          fail(new Error(this.lastLaunchFailure
            ? `computer_use_helper_connect_timeout: ${this.lastLaunchFailure}`
            : 'computer_use_helper_connect_timeout'));
        }, 15_000);
        timer.unref?.();
        server.once('error', (err) => {
          fail(err instanceof Error ? err : new Error(String(err)));
        });
        server.listen(this.path, () => {
          void (async () => {
            try {
              const platform = this.options.platform ?? process.platform;
              if (platform === 'win32') {
                allowWindowsComputerUseHelperFiles();
                await allowWindowsPipeClients(this.path);
                launchWindowsUserSessionHelper(this.options.execPath ?? process.execPath, this.path, (detail) => {
                  this.lastLaunchFailure = detail;
                });
              } else if (platform === 'darwin') {
                // The socket is visible in /tmp before runtime preparation and
                // artifact download finish. Seal it root-only immediately, then
                // transfer it to the exact console user once resolved.
                await chmod(this.path, 0o600);
                await this.launchMacosHelper(tool);
              } else {
                launchSameSessionHelper(this.options.execPath ?? process.execPath, this.path);
              }
            } catch (err) {
              fail(err instanceof Error ? err : new Error(String(err)));
            }
          })();
          });
        });
    })();
    holder.promise = ready;
    this.readyPromise = ready;
    // Clearing it on success matters as much as clearing it on failure: a
    // fulfilled promise left in place claims an attempt is in flight forever,
    // and the next caller with a dead socket then waits on a result that has
    // already happened instead of starting a helper.
    void ready.then(clearReady, () => { /* every rejection path already cleared it. */ });
    return ready;
  }

  private async launchMacosHelper(tool: ComputerUseToolName): Promise<void> {
    const execPath = this.options.execPath ?? process.execPath;
    const resolveConsoleUser = this.options.resolveMacosConsoleUser ?? resolveMacosUserSession;
    const authorizeSocket = this.options.authorizeMacosComputerUseSocket ?? authorizeMacosComputerUseSocket;
    const prepareRuntime = this.options.prepareMacosComputerUseRuntime ?? prepareMacosComputerUseRuntime;
    const runDoctor = this.options.runMacosComputerUseDoctor ?? ((user, runtime) => (
      runMacosUserSessionCommand(user, {
        executable: runtime.openComputerUseExecutable,
        args: ['doctor'],
      }, 10_000)
    ));
    const launchHelper = this.options.launchMacosUserSessionHelper ?? ((user, runtime, pipe) => {
      launchMacosUserSessionCommand(user, {
        executable: runtime.helperExecutable,
        args: ['--computer-use-helper', '--pipe', pipe],
        environment: [['IMCODES_COMPUTER_USE_EXE', runtime.openComputerUseExecutable]],
      });
    });
    const user = await resolveConsoleUser();
    await authorizeSocket(this.path, user);
    const archiveName = controlledNodeComputerUseHelperFilename(CONTROLLED_NODE_OS_MAC);
    const target = controlledNodeArtifactTarget(
      'darwin',
      this.options.arch ?? process.arch,
    );
    const candidates = [
      join(this.options.macosComputerUseRuntimeRoot ?? MACOS_COMPUTER_USE_RUNTIME_ROOT, archiveName),
      join(dirname(execPath), 'computer-use-helper', archiveName),
      ...(target
        ? [join(dirname(execPath), 'computer-use-helper', `darwin-${target.arch}`, archiveName)]
        : []),
    ];
    let sourceOpenComputerUseArchive = candidates.find((candidate) => existsSync(candidate));
    let downloadDir: string | undefined;
    try {
      if (!sourceOpenComputerUseArchive) {
        const credential = this.options.credential;
        if (!credential || !target) throw new Error('computer_use_helper_not_installed');
        downloadDir = await mkdtemp(join(tmpdir(), 'imcodes-computer-use-download-'));
        const downloadHelper = this.options.downloadMacosComputerUseHelper
          ?? downloadControlledNodeComputerUseHelper;
        const downloaded = await downloadHelper({
          credential,
          target,
          dir: downloadDir,
          fetchImpl: this.options.fetchImpl ?? fetch,
        });
        sourceOpenComputerUseArchive = downloaded?.artifactPath;
      }
      const runtime = await prepareRuntime(execPath, sourceOpenComputerUseArchive);
      if (tool !== 'shell_session1' && !tool.startsWith('browser_')) {
        // `doctor` opens the one-time TCC onboarding UI when permissions are
        // absent. It is advisory: a stale LaunchServices registration must not
        // prevent the real MCP helper from starting and returning its own
        // actionable permission error.
        await runDoctor(user, runtime).catch(() => {});
      }
      launchHelper(user, runtime, this.path);
    } finally {
      if (downloadDir) await rm(downloadDir, { recursive: true, force: true }).catch(() => {});
    }
  }


  private acceptConnection(socket: net.Socket, resolve: () => void): void {
    socket.setEncoding('utf8');
    let accepted = false;
    socket.setTimeout(1_000, () => {
      if (!accepted) socket.destroy();
    });
    let helloBuffer = '';
    const rejectPending = (error: Error) => {
      for (const [id, entry] of this.pending) {
        clearTimeout(entry.timer);
        entry.reject(error);
        this.pending.delete(id);
      }
    };
    const accept = (remaining: string) => {
      if (this.socket && !this.socket.destroyed) this.socket.destroy();
      accepted = true;
      socket.setTimeout(0);
      this.socket = socket;
      this.buffer = '';
      socket.removeAllListeners('data');
      socket.on('data', (chunk) => this.onData(String(chunk)));
      if (remaining) this.onData(remaining);
      resolve();
    };
    socket.on('error', (err) => {
      if (accepted && this.socket === socket) {
        this.socket = null;
        this.retireServer();
        rejectPending(err instanceof Error ? err : new Error(String(err)));
      }
    });
    socket.on('close', () => {
      if (!accepted || this.socket !== socket) return;
      this.socket = null;
      this.retireServer();
      rejectPending(new Error('computer_use_helper_disconnected'));
    });
    socket.on('data', (chunk) => {
      helloBuffer += String(chunk);
      for (;;) {
        const newline = helloBuffer.indexOf('\n');
        if (newline < 0) return;
        const line = helloBuffer.slice(0, newline).trim();
        const remaining = helloBuffer.slice(newline + 1);
        if (!line) {
          helloBuffer = remaining;
          continue;
        }
        let parsed: IpcHelloWire;
        try { parsed = JSON.parse(line) as IpcHelloWire; } catch {
          socket.destroy();
          return;
        }
        if (!parsed || parsed.hello !== COMPUTER_USE_IPC_HELPER_HELLO) {
          socket.destroy();
          return;
        }
        helloBuffer = '';
        accept(remaining);
        return;
      }
    });
  }

  /** Stop listening, and resolve only once the path is free to bind again. */
  private async closeServer(): Promise<void> {
    const server = this.server;
    this.server = null;
    if (!server) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private retireServer(): void {
    this.buffer = '';
    if (!this.server) {
      this.readyPromise = null;
      return;
    }
    // Parked in `readyPromise` so that a call arriving mid-teardown waits for
    // the path to be free rather than racing the close and failing to bind.
    const closing = this.closeServer();
    this.readyPromise = closing;
    void closing.finally(() => {
      if (this.readyPromise === closing) this.readyPromise = null;
    });
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    for (;;) {
      const newline = this.buffer.indexOf('\n');
      if (newline < 0) break;
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      let parsed: IpcResultWire;
      try { parsed = JSON.parse(line) as IpcResultWire; } catch { continue; }
      if (!parsed || typeof parsed.id !== 'string') continue;
      const entry = this.pending.get(parsed.id);
      if (!entry) continue;
      clearTimeout(entry.timer);
      this.pending.delete(parsed.id);
      if (parsed.result) {
        const v = validateComputerUseResultFrame(parsed.result);
        if (v.ok) entry.resolve(v.value);
        else entry.reject(new Error(`invalid_computer_use_ipc_result:${v.error}`));
      } else {
        entry.reject(new Error(parsed.error || 'computer_use_ipc_error'));
      }
    }
  }
}

export async function runComputerUseIpcHelper(
  pipe: string,
  closeRuntime: () => Promise<void> = closeComputerUseRuntimeForProcessExit,
  sweepOrphans: () => Promise<unknown> = sweepComputerUseOrphanedResources,
): Promise<void> {
  await sweepOrphans();
  const socket = net.createConnection(pipe);
  const closed = new Promise<void>((resolve) => socket.once('close', resolve));
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('error', reject);
    });
    socket.write(`${JSON.stringify({ hello: COMPUTER_USE_IPC_HELPER_HELLO } satisfies IpcHelloWire)}\n`);
    socket.setEncoding('utf8');
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += String(chunk);
      void (async () => {
        for (;;) {
          const newline = buffer.indexOf('\n');
          if (newline < 0) break;
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (!line) continue;
          let parsed: IpcRequestWire;
          try { parsed = JSON.parse(line) as IpcRequestWire; } catch { continue; }
          const id = typeof parsed.id === 'string' ? parsed.id : '';
          if (!id) continue;
          const request = validateComputerUseFrame(parsed.request);
          if (!request.ok) {
            socket.write(`${JSON.stringify({ id, error: request.error } satisfies IpcResultWire)}\n`);
            continue;
          }
          const result = await runComputerUseTool(request.value);
          const frame: ComputerUseResultFrame = { type: DAEMON_MSG.COMPUTER_USE_RESULT, ...result };
          const validated = validateComputerUseResultFrame(frame);
          socket.write(`${JSON.stringify(validated.ok ? { id, result: validated.value } : { id, error: validated.error } satisfies IpcResultWire)}\n`);
        }
      })().catch((err) => {
        if (!socket.destroyed) {
          socket.write(`${JSON.stringify({ id: 'unknown', error: err instanceof Error ? err.message : String(err) })}\n`);
        }
      });
    });
    await closed;
  } finally {
    socket.destroy();
    await closeRuntime();
  }
}
