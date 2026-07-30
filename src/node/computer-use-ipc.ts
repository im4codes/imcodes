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
import { applyWindowsAclCommands, windowsComputerUseHelperAclCommands } from './installer.js';
import {
  authorizeMacosComputerUseSocket,
  launchMacosUserSessionHelper,
  prepareMacosComputerUseRuntime,
  resolveMacosConsoleUser,
  runMacosComputerUseDoctor,
  MACOS_COMPUTER_USE_RUNTIME_ROOT,
  type MacosComputerUseRuntime,
  type MacosConsoleUser,
} from './macos-computer-use.js';
import {
  controlledNodeArtifactTarget,
  downloadControlledNodeComputerUseHelper,
} from './self-upgrade.js';
import type { ControlledNodeCredential } from './enrollment.js';
import {
  COMPUTER_USE_DEFAULT_TIMEOUT_MS,
  computerUseMaxTimeoutMs,
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

interface IpcRequestWire { id: string; request: ComputerUseFrame }
interface IpcResultWire { id: string; result?: ComputerUseResultFrame; error?: string }
interface IpcHelloWire { hello: typeof COMPUTER_USE_IPC_HELPER_HELLO }

export const COMPUTER_USE_IPC_HELPER_HELLO = 'imcodes-computer-use-helper-v1' as const;

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

export function quoteWinArg(value: string): string {
  let out = '"';
  let backslashes = 0;
  for (const ch of value) {
    if (ch === '\\') {
      backslashes++;
      continue;
    }
    if (ch === '"') {
      out += '\\'.repeat(backslashes * 2 + 1) + '"';
      backslashes = 0;
      continue;
    }
    out += '\\'.repeat(backslashes) + ch;
    backslashes = 0;
  }
  return `${out}${'\\'.repeat(backslashes * 2)}"`;
}

function helperArgv(pipe: string): string[] {
  const entry = process.argv[1];
  const isNodeRuntime = /(?:^|[/\\])node(?:\.exe)?$/i.test(process.execPath);
  return isNodeRuntime && entry
    ? [entry, '--computer-use-helper', '--pipe', pipe]
    : ['--computer-use-helper', '--pipe', pipe];
}

function psBase64(value: string): string {
  return Buffer.from(value, 'utf16le').toString('base64');
}

export function windowsPipeClientAclCommand(path: string): readonly [string, string, string] {
  return [path, '/grant', '*S-1-5-11:F'];
}

function allowWindowsPipeClients(path: string): void {
  // `icacls \\.\pipe\...` opens the pipe while updating the DACL. Do not wait
  // synchronously: that can deadlock the event loop before the server can drain
  // and reject those non-helper probe connections.
  const child = spawn('icacls', [...windowsPipeClientAclCommand(path)], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.on('error', () => {});
  child.unref();
}

function allowWindowsComputerUseHelperFiles(): void {
  if (!existsSync(WINDOWS_DEFAULT_OCU_DIR)) return;
  applyWindowsAclCommands(windowsComputerUseHelperAclCommands(WINDOWS_DEFAULT_OCU_DIR));
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function windowsCommandShellPath(): string {
  return process.env.ComSpec?.trim() || 'C:\\Windows\\System32\\cmd.exe';
}

function windowsHelperCommandLine(exe: string, pipe: string): { shellExe: string; argsLine: string } {
  const helperArgs = helperArgv(pipe).map(quoteWinArg).join(' ');
  const helperCommand = `${quoteWinArg(exe)} ${helperArgs}`;
  return { shellExe: windowsCommandShellPath(), argsLine: `/d /s /c "${helperCommand}"` };
}

function launchWindowsUserSessionHelper(exe: string, pipe: string): void {
  const { shellExe, argsLine } = windowsHelperCommandLine(exe, pipe);
  const exe64 = Buffer.from(shellExe, 'utf8').toString('base64');
  const args64 = Buffer.from(argsLine, 'utf8').toString('base64');
  const script = String.raw`
$ErrorActionPreference = 'Stop'
$exe = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('__EXE64__'))
$argsLine = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('__ARGS64__'))
$src = @'
using System;
using System.Runtime.InteropServices;
public static class ImcodesUserProc {
  [StructLayout(LayoutKind.Sequential)] public struct WTS_SESSION_INFO { public int SessionID; public IntPtr pWinStationName; public int State; }
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] public struct STARTUPINFO { public int cb; public string lpReserved; public string lpDesktop; public string lpTitle; public int dwX; public int dwY; public int dwXSize; public int dwYSize; public int dwXCountChars; public int dwYCountChars; public int dwFillAttribute; public int dwFlags; public short wShowWindow; public short cbReserved2; public IntPtr lpReserved2; public IntPtr hStdInput; public IntPtr hStdOutput; public IntPtr hStdError; }
  [StructLayout(LayoutKind.Sequential)] public struct PROCESS_INFORMATION { public IntPtr hProcess; public IntPtr hThread; public int dwProcessId; public int dwThreadId; }
  [DllImport("wtsapi32.dll", SetLastError=true)] static extern bool WTSEnumerateSessions(IntPtr hServer, int reserved, int version, out IntPtr ppSessionInfo, out int count);
  [DllImport("wtsapi32.dll")] static extern void WTSFreeMemory(IntPtr memory);
  [DllImport("wtsapi32.dll", SetLastError=true)] static extern bool WTSQueryUserToken(int sessionId, out IntPtr token);
  [DllImport("advapi32.dll", SetLastError=true)] static extern bool DuplicateTokenEx(IntPtr existing, uint desiredAccess, IntPtr attrs, int impersonationLevel, int tokenType, out IntPtr newToken);
  [DllImport("userenv.dll", SetLastError=true)] static extern bool CreateEnvironmentBlock(out IntPtr env, IntPtr token, bool inherit);
  [DllImport("userenv.dll", SetLastError=true)] static extern bool DestroyEnvironmentBlock(IntPtr env);
  [DllImport("advapi32.dll", SetLastError=true, CharSet=CharSet.Unicode)] static extern bool CreateProcessAsUser(IntPtr token, string app, string cmd, IntPtr procAttrs, IntPtr threadAttrs, bool inheritHandles, uint flags, IntPtr env, string cwd, ref STARTUPINFO si, out PROCESS_INFORMATION pi);
  [DllImport("advapi32.dll", SetLastError=true, CharSet=CharSet.Unicode)] static extern bool CreateProcessWithTokenW(IntPtr token, uint logonFlags, string app, string cmd, uint flags, IntPtr env, string cwd, ref STARTUPINFO si, out PROCESS_INFORMATION pi);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool CloseHandle(IntPtr h);
  const int WTSActive = 0;
  const uint TOKEN_ALL_ACCESS = 0xF01FF;
  const int SecurityImpersonation = 2;
  const int TokenPrimary = 1;
  const uint CREATE_UNICODE_ENVIRONMENT = 0x00000400;
  const uint LOGON_WITH_PROFILE = 0x00000001;
  const int ERROR_PRIVILEGE_NOT_HELD = 1314;
  public static int ActiveSessionId() {
    IntPtr p; int count;
    if (!WTSEnumerateSessions(IntPtr.Zero, 0, 1, out p, out count)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
    try {
      int size = Marshal.SizeOf(typeof(WTS_SESSION_INFO));
      for (int i = 0; i < count; i++) {
        WTS_SESSION_INFO s = (WTS_SESSION_INFO)Marshal.PtrToStructure(IntPtr.Add(p, i * size), typeof(WTS_SESSION_INFO));
        if (s.State == WTSActive) return s.SessionID;
      }
    } finally { WTSFreeMemory(p); }
    throw new Exception("no active user session");
  }
  public static void Start(string exe, string argsLine) {
    IntPtr token, primary, env;
    int sid = ActiveSessionId();
    if (!WTSQueryUserToken(sid, out token)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
    try {
      if (!DuplicateTokenEx(token, TOKEN_ALL_ACCESS, IntPtr.Zero, SecurityImpersonation, TokenPrimary, out primary)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
      try {
        if (!CreateEnvironmentBlock(out env, primary, false)) env = IntPtr.Zero;
        try {
          STARTUPINFO si = new STARTUPINFO(); si.cb = Marshal.SizeOf(typeof(STARTUPINFO)); si.lpDesktop = "winsta0\\default";
          PROCESS_INFORMATION pi;
          string cmd = "\"" + exe + "\" " + argsLine;
          if (!CreateProcessAsUser(primary, exe, cmd, IntPtr.Zero, IntPtr.Zero, false, CREATE_UNICODE_ENVIRONMENT, env, null, ref si, out pi)) {
            int error = Marshal.GetLastWin32Error();
            if (error != ERROR_PRIVILEGE_NOT_HELD || !CreateProcessWithTokenW(primary, LOGON_WITH_PROFILE, exe, cmd, CREATE_UNICODE_ENVIRONMENT, env, null, ref si, out pi)) {
              if (error == ERROR_PRIVILEGE_NOT_HELD) error = Marshal.GetLastWin32Error();
              throw new System.ComponentModel.Win32Exception(error);
            }
          }
          CloseHandle(pi.hThread); CloseHandle(pi.hProcess);
        } finally { if (env != IntPtr.Zero) DestroyEnvironmentBlock(env); }
      } finally { CloseHandle(primary); }
    } finally { CloseHandle(token); }
  }
}
'@
Add-Type -TypeDefinition $src
[ImcodesUserProc]::Start($exe, $argsLine)
`.replace('__EXE64__', exe64).replace('__ARGS64__', args64);
  const child = spawn('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', psBase64(script)], {
    stdio: 'ignore',
    windowsHide: true,
  });
  child.on('error', () => {});
  child.unref();
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

  constructor(private readonly options: ComputerUseIpcHostOptions = {}) {}

  async call(frame: ComputerUseFrame): Promise<ComputerUseResultFrame> {
    await this.ensureStarted(frame.tool);
    const socket = this.socket;
    if (!socket || socket.destroyed) throw new Error('computer_use_helper_not_connected');
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
        reject(err);
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

  private async ensureStarted(tool: ComputerUseToolName): Promise<void> {
    if (this.socket && !this.socket.destroyed) return;
    if (this.readyPromise) {
      await this.readyPromise;
      if (this.socket && !this.socket.destroyed) return;
      return await this.ensureStarted(tool);
    }
    this.readyPromise = new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout>;
      const server = net.createServer((socket) => {
        this.acceptConnection(socket, () => {
          clearTimeout(timer);
          resolve();
        });
      });
      this.server = server;
      timer = setTimeout(() => {
        server.close();
        if (this.server === server) this.server = null;
        this.readyPromise = null;
        reject(new Error('computer_use_helper_connect_timeout'));
      }, 15_000);
      timer.unref?.();
      server.once('error', (err) => {
        clearTimeout(timer);
        if (this.server === server) this.server = null;
        this.readyPromise = null;
        reject(err);
      });
      server.listen(this.path, () => {
        void (async () => {
          try {
            const platform = this.options.platform ?? process.platform;
            if (platform === 'win32') {
              allowWindowsComputerUseHelperFiles();
              allowWindowsPipeClients(this.path);
              await delay(750);
              launchWindowsUserSessionHelper(process.execPath, this.path);
            } else if (platform === 'darwin') {
              // The socket is visible in /tmp before runtime preparation and
              // artifact download finish. Seal it root-only immediately, then
              // transfer it to the exact console user once resolved.
              await chmod(this.path, 0o600);
              await this.launchMacosHelper(tool);
            } else {
              launchSameSessionHelper(process.execPath, this.path);
            }
          } catch (err) {
            clearTimeout(timer);
            server.close();
            if (this.server === server) this.server = null;
            this.readyPromise = null;
            reject(err instanceof Error ? err : new Error(String(err)));
          }
        })();
      });
    });
    await this.readyPromise;
  }

  private async launchMacosHelper(tool: ComputerUseToolName): Promise<void> {
    const execPath = this.options.execPath ?? process.execPath;
    const resolveConsoleUser = this.options.resolveMacosConsoleUser ?? resolveMacosConsoleUser;
    const authorizeSocket = this.options.authorizeMacosComputerUseSocket ?? authorizeMacosComputerUseSocket;
    const prepareRuntime = this.options.prepareMacosComputerUseRuntime ?? prepareMacosComputerUseRuntime;
    const runDoctor = this.options.runMacosComputerUseDoctor ?? runMacosComputerUseDoctor;
    const launchHelper = this.options.launchMacosUserSessionHelper ?? launchMacosUserSessionHelper;
    const user = await resolveConsoleUser();
    await authorizeSocket(this.path, user);
    const archiveName = controlledNodeComputerUseHelperFilename(CONTROLLED_NODE_OS_MAC);
    const candidates = [
      join(MACOS_COMPUTER_USE_RUNTIME_ROOT, archiveName),
      join(dirname(execPath), 'computer-use-helper', archiveName),
      join(dirname(execPath), 'computer-use-helper', 'darwin-arm64', archiveName),
    ];
    let sourceOpenComputerUseArchive = candidates.find((candidate) => existsSync(candidate));
    let downloadDir: string | undefined;
    try {
      if (!sourceOpenComputerUseArchive) {
        const credential = this.options.credential;
        const target = controlledNodeArtifactTarget(
          'darwin',
          this.options.arch ?? process.arch,
        );
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

  private retireServer(): void {
    this.buffer = '';
    const server = this.server;
    this.server = null;
    if (!server) {
      this.readyPromise = null;
      return;
    }
    const closing = new Promise<void>((resolve) => server.close(() => resolve()));
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
): Promise<void> {
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
