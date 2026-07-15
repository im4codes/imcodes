import { execFile, spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import WebSocket from 'ws';
import {
  COMPUTER_USE_DEFAULT_TIMEOUT_MS,
  COMPUTER_USE_MAX_ERROR_BYTES,
  COMPUTER_USE_MAX_TEXT_BYTES,
  COMPUTER_USE_MAX_IMAGE_BASE64_BYTES,
  COMPUTER_USE_MAX_ARGUMENT_BYTES,
  COMPUTER_USE_MIN_TIMEOUT_MS,
  computerUseMaxTimeoutMs,
  type ComputerUseContentItem,
  type ComputerUseRequest,
  type ComputerUseResult,
  type ComputerUseToolName,
} from '../../shared/computer-use.js';

export const WINDOWS_DEFAULT_OCU_DIR = 'C:\\ProgramData\\imcodes-node\\computer-use-helper';
const WINDOWS_DEFAULT_OCU_EXE = `${WINDOWS_DEFAULT_OCU_DIR}\\open-computer-use.exe`;
const SHELL_SESSION1_OUTPUT_MAX_BYTES = 96 * 1024;
const OPEN_COMPUTER_USE_STDOUT_MAX_BYTES = 24 * 1024 * 1024;
const OPEN_COMPUTER_USE_BINARY = process.platform === 'win32' ? 'open-computer-use.exe' : 'open-computer-use';

function platformArchKey(platform: NodeJS.Platform = process.platform, arch: string = process.arch): string {
  return `${platform}-${arch === 'arm64' ? 'arm64' : 'x64'}`;
}

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

function truncateUtf8(value: string, maxBytes: number): { value: string; truncated: boolean } {
  if (utf8Bytes(value) <= maxBytes) return { value, truncated: false };
  let low = 0;
  let high = value.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (utf8Bytes(value.slice(0, mid)) <= maxBytes) low = mid;
    else high = mid - 1;
  }
  return { value: value.slice(0, low), truncated: true };
}

async function fileExists(path: string): Promise<boolean> {
  try { await access(path); return true; } catch { return false; }
}

export function openComputerUseCandidateBinariesForTest(moduleFilePath?: string, entryFilePath?: string): string[] {
  return openComputerUseCandidateBinaries({ moduleFilePath, entryFilePath });
}

function pushPackagedHelperCandidates(candidates: Array<string | undefined>, baseDir: string, key: string): void {
  candidates.push(
    // npm package layout: dist/src/index.js -> dist/computer-use-helper/<platform-arch>/...
    resolve(baseDir, '..', 'computer-use-helper', key, OPEN_COMPUTER_USE_BINARY),
    // module layout: dist/src/node/computer-use-runner.js -> dist/computer-use-helper/<platform-arch>/...
    resolve(baseDir, '..', '..', 'computer-use-helper', key, OPEN_COMPUTER_USE_BINARY),
    // source/dev checkout layout: src/... -> dist/computer-use-helper/<platform-arch>/...
    resolve(baseDir, '..', '..', 'dist', 'computer-use-helper', key, OPEN_COMPUTER_USE_BINARY),
  );
}

function openComputerUseCandidateBinaries(options: { moduleFilePath?: string; entryFilePath?: string } = {}): string[] {
  const key = platformArchKey();
  const helperDir = process.env.IMCODES_COMPUTER_USE_HELPER_DIR?.trim();
  const candidates: Array<string | undefined> = [
    process.env.IMCODES_COMPUTER_USE_EXE?.trim(),
    helperDir ? join(helperDir, OPEN_COMPUTER_USE_BINARY) : undefined,
  ];

  if (options.moduleFilePath) {
    pushPackagedHelperCandidates(candidates, dirname(resolve(options.moduleFilePath)), key);
  }
  const entryFilePath = options.entryFilePath ?? process.argv[1];
  if (entryFilePath) {
    pushPackagedHelperCandidates(candidates, dirname(resolve(entryFilePath)), key);
  }
  candidates.push(
    // Build-tree fallback for local development and tests.
    resolve(process.cwd(), 'dist', 'computer-use-helper', key, OPEN_COMPUTER_USE_BINARY),
    resolve(process.cwd(), 'computer-use-helper', key, OPEN_COMPUTER_USE_BINARY),
    // controlled-node / manually-installed sidecar next to the running executable.
    join(dirname(process.execPath), 'computer-use-helper', OPEN_COMPUTER_USE_BINARY),
    join(dirname(process.execPath), 'computer-use-helper', key, OPEN_COMPUTER_USE_BINARY),
    process.platform === 'win32' ? WINDOWS_DEFAULT_OCU_EXE : undefined,
    OPEN_COMPUTER_USE_BINARY,
  );

  const unique = new Set<string>();
  return candidates.filter((value): value is string => {
    if (!value || unique.has(value)) return false;
    unique.add(value);
    return true;
  });
}

async function resolveOpenComputerUseBinary(): Promise<string> {
  const candidates = openComputerUseCandidateBinaries();
  for (let index = 0; index < candidates.length; index++) {
    const candidate = candidates[index]!;
    // Explicit path/env or final PATH lookup may be returned without probing.
    if (index === 0 && process.env.IMCODES_COMPUTER_USE_EXE?.trim()) return candidate;
    if (candidate === OPEN_COMPUTER_USE_BINARY) return candidate;
    if (await fileExists(candidate)) return candidate;
  }
  return OPEN_COMPUTER_USE_BINARY;
}

interface ComputerUseReturnOptions {
  includeImage: boolean;
  includeState: boolean;
  imageFormat: 'jpeg' | 'png' | 'webp';
  imageQuality: number;
  imageMaxWidth: number;
}

const COMPUTER_USE_INTERNAL_ARG_KEYS = new Set([
  'includeImage',
  'includeState',
  'imageFormat',
  'imageQuality',
  'imageMaxWidth',
]);

function stripInternalArgs(args: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!args) return null;
  let changed = false;
  const next: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (COMPUTER_USE_INTERNAL_ARG_KEYS.has(key)) {
      changed = true;
      continue;
    }
    next[key] = value;
  }
  return changed ? next : args;
}

function parseReturnOptions(tool: string, args: Record<string, unknown> | null): ComputerUseReturnOptions {
  const format = args?.imageFormat;
  const quality = args?.imageQuality;
  const maxWidth = args?.imageMaxWidth;
  return {
    includeImage: args?.includeImage === true,
    includeState: args?.includeState === true || !isActionTool(tool),
    imageFormat: format === 'png' || format === 'webp' || format === 'jpeg' ? format : 'jpeg',
    imageQuality: typeof quality === 'number' && Number.isFinite(quality)
      ? Math.min(Math.max(Math.round(quality), 1), 100)
      : 60,
    imageMaxWidth: typeof maxWidth === 'number' && Number.isFinite(maxWidth)
      ? Math.min(Math.max(Math.round(maxWidth), 320), 3840)
      : 1280,
  };
}


function forwardedComputerUseArgs(args: Record<string, unknown> | null): Record<string, unknown> {
  return stripInternalArgs(args) ?? {};
}

function openComputerUseMcpToolArgs(tool: string, args: Record<string, unknown>): Record<string, unknown> {
  const next: Record<string, unknown> = { ...args };
  if (tool === 'click') {
    if (next.mouse_button === undefined && typeof next.button === 'string') next.mouse_button = next.button;
    if (next.click_count === undefined && typeof next.clicks === 'number') next.click_count = next.clicks;
    delete next.button;
    delete next.clicks;
  }
  return next;
}

function isNoAppStateError(raw: unknown): boolean {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
  if (!(raw as { isError?: unknown }).isError) return false;
  const content = (raw as { content?: unknown }).content;
  if (!Array.isArray(content)) return false;
  return content.some((item) => Boolean(item
    && typeof item === 'object'
    && !Array.isArray(item)
    && (item as { type?: unknown }).type === 'text'
    && typeof (item as { text?: unknown }).text === 'string'
    && (item as { text: string }).text.includes('No app state is available')));
}

interface JsonRpcResponse { id?: unknown; result?: unknown; error?: { message?: unknown } | unknown }

type PendingMcp = {
  resolve: (value: JsonRpcResponse) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

class OpenComputerUseMcpClient {
  private child: ChildProcessWithoutNullStreams | null = null;
  private buffer = '';
  private nextId = 1;
  private pending = new Map<number, PendingMcp>();
  private starting: Promise<void> | null = null;

  constructor(private readonly binary: string) {}

  async callTool(tool: string, args: Record<string, unknown>, timeoutMs: number): Promise<unknown> {
    await this.ensureStarted();
    return await this.request('tools/call', { name: tool, arguments: openComputerUseMcpToolArgs(tool, args) }, timeoutMs);
  }

  close(): void {
    this.rejectAll(new Error('open_computer_use_mcp_closed'));
    this.child?.kill();
    this.child = null;
    this.starting = null;
    this.buffer = '';
  }

  private async ensureStarted(): Promise<void> {
    if (this.child && !this.child.killed && this.child.exitCode === null) return;
    if (this.starting) return this.starting;
    this.starting = this.start();
    try { await this.starting; } finally { this.starting = null; }
  }

  private async start(): Promise<void> {
    this.close();
    const env = process.platform === 'win32'
      ? { ...process.env, OPEN_COMPUTER_USE_WINDOWS_ALLOW_UIA_TEXT_FALLBACK: '1' }
      : process.env;
    const child = spawn(this.binary, ['mcp'], { windowsHide: true, env });
    this.child = child;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => this.onStdout(String(chunk)));
    child.stderr.on('data', () => {});
    child.on('error', (error) => {
      if (this.child === child) this.child = null;
      this.rejectAll(error instanceof Error ? error : new Error(String(error)));
    });
    child.on('exit', (code, signal) => {
      if (this.child === child) this.child = null;
      this.rejectAll(new Error(`open_computer_use_mcp_exited:${code ?? signal ?? 'unknown'}`));
    });
    await this.request('initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'imcodes-controlled-node', version: '0.1.0' },
    }, 10_000);
    this.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  }

  private request(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    const child = this.child;
    if (!child || child.killed || child.exitCode !== null) return Promise.reject(new Error('open_computer_use_mcp_not_running'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`open_computer_use_mcp_timeout:${method}`));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, {
        resolve: (message) => {
          if (message.error) {
            const err = message.error;
            const text = err && typeof err === 'object' && !Array.isArray(err) && typeof (err as { message?: unknown }).message === 'string'
              ? (err as { message: string }).message
              : JSON.stringify(err);
            reject(new Error(text || `open_computer_use_mcp_error:${method}`));
            return;
          }
          resolve(message.result);
        },
        reject,
        timer,
      });
      try { this.send({ jsonrpc: '2.0', id, method, params }); }
      catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private send(message: unknown): void {
    const child = this.child;
    if (!child || child.killed || child.exitCode !== null) throw new Error('open_computer_use_mcp_not_running');
    child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private onStdout(chunk: string): void {
    this.buffer += chunk;
    for (;;) {
      const newline = this.buffer.indexOf('\n');
      if (newline < 0) return;
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      let parsed: JsonRpcResponse;
      try { parsed = JSON.parse(line) as JsonRpcResponse; } catch { continue; }
      if (typeof parsed.id !== 'number') continue;
      const pending = this.pending.get(parsed.id);
      if (!pending) continue;
      clearTimeout(pending.timer);
      this.pending.delete(parsed.id);
      pending.resolve(parsed);
    }
  }

  private rejectAll(error: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(id);
    }
  }
}

let mcpClient: OpenComputerUseMcpClient | null = null;
let mcpClientBinary = '';

async function openComputerUseMcpClient(): Promise<OpenComputerUseMcpClient> {
  const bin = await resolveOpenComputerUseBinary();
  if (!mcpClient || mcpClientBinary !== bin) {
    mcpClient?.close();
    mcpClient = new OpenComputerUseMcpClient(bin);
    mcpClientBinary = bin;
  }
  return mcpClient;
}

async function callOpenComputerUseMcpTool(tool: string, args: Record<string, unknown>, timeoutMs: number): Promise<unknown> {
  const client = await openComputerUseMcpClient();
  const result = await client.callTool(tool, args, timeoutMs);
  if (isActionTool(tool) && typeof args.app === 'string' && args.app.trim() && isNoAppStateError(result)) {
    await client.callTool('get_app_state', { app: args.app, text_limit: 1_000, max_tree_nodes: 1_500, max_tree_depth: 80 }, timeoutMs);
    return await client.callTool(tool, args, timeoutMs);
  }
  return result;
}

export function openComputerUseCallArgs(tool: string, argsJson: string): string[] {
  let args: Record<string, unknown> | null = null;
  try {
    const parsed = JSON.parse(argsJson);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) args = parsed as Record<string, unknown>;
  } catch {
    args = null;
  }
  const forwardedArgs = forwardedComputerUseArgs(args);
  const forwardedJson = JSON.stringify(forwardedArgs);
  if (isActionTool(tool) && typeof forwardedArgs?.app === 'string' && forwardedArgs.app.trim()) {
    return ['call', '--calls', JSON.stringify([
      { tool: 'get_app_state', args: { app: forwardedArgs.app, text_limit: 1_000, max_tree_nodes: 1_500, max_tree_depth: 80 } },
      { tool, args: forwardedArgs },
    ])];
  }
  return ['call', tool, '--args', forwardedJson];
}

export function openComputerUseEnv(tool: string, baseEnv: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): NodeJS.ProcessEnv | undefined {
  if (platform !== 'win32' || tool !== 'type_text') return undefined;
  return { ...baseEnv, OPEN_COMPUTER_USE_WINDOWS_ALLOW_UIA_TEXT_FALLBACK: '1' };
}

const ACTION_TOOLS: ReadonlySet<string> = new Set([
  'click',
  'perform_secondary_action',
  'scroll',
  'drag',
  'type_text',
  'press_key',
  'set_value',
]);

function isActionTool(tool: string): tool is Exclude<ComputerUseToolName, 'list_apps' | 'get_app_state' | 'shell_session1'> {
  return ACTION_TOOLS.has(tool);
}

type ExecOutcome = { stdout: string; stderr: string; timedOut: boolean; error?: string };

function execFileBounded(file: string, args: string[], timeoutMs: number, env?: NodeJS.ProcessEnv): Promise<ExecOutcome> {
  return new Promise((resolve) => {
    execFile(file, args, {
      timeout: timeoutMs,
      maxBuffer: OPEN_COMPUTER_USE_STDOUT_MAX_BYTES,
      windowsHide: true,
      encoding: 'utf8',
      ...(env ? { env } : {}),
    }, (error, stdout, stderr) => {
      const anyErr = error as NodeJS.ErrnoException & { killed?: boolean; signal?: string } | null;
      resolve({
        stdout: typeof stdout === 'string' ? stdout : String(stdout ?? ''),
        stderr: typeof stderr === 'string' ? stderr : String(stderr ?? ''),
        timedOut: Boolean(anyErr?.killed || anyErr?.signal === 'SIGTERM'),
        ...(anyErr ? { error: anyErr.message } : {}),
      });
    });
  });
}

async function compressImageBase64(data: string, options: ComputerUseReturnOptions): Promise<{ data: string; mimeType: string; truncated: boolean }> {
  if (process.platform === 'win32') {
    const compressed = await compressImageBase64WithWindowsDrawing(data, options).catch(() => null);
    if (compressed) return compressed;
  }
  const cut = truncateUtf8(data, COMPUTER_USE_MAX_IMAGE_BASE64_BYTES);
  return { data: cut.value, mimeType: 'image/png', truncated: cut.truncated };
}


function isFastWindowsCoordinateClick(tool: ComputerUseToolName, args: Record<string, unknown>): boolean {
  return process.platform === 'win32'
    && tool === 'click'
    && typeof args.app === 'string'
    && args.app.trim().length > 0
    && typeof args.x === 'number'
    && Number.isFinite(args.x)
    && typeof args.y === 'number'
    && Number.isFinite(args.y)
    && args.element_index === undefined
    && args.includeState !== true
    && args.includeImage !== true;
}


type PendingFastClick = {
  resolve: (ok: boolean) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

class FastWindowsClickClient {
  private child: ChildProcessWithoutNullStreams | null = null;
  private buffer = '';
  private nextId = 1;
  private pending = new Map<number, PendingFastClick>();
  private starting: Promise<void> | null = null;

  async click(args: Record<string, unknown>, timeoutMs: number): Promise<boolean> {
    await this.ensureStarted();
    const clickCountRaw = typeof args.click_count === 'number' ? args.click_count : args.clicks;
    return await this.request({
      app: args.app,
      x: args.x,
      y: args.y,
      button: typeof args.mouse_button === 'string' ? args.mouse_button : (typeof args.button === 'string' ? args.button : 'left'),
      clickCount: typeof clickCountRaw === 'number' && Number.isFinite(clickCountRaw)
        ? Math.min(Math.max(Math.round(clickCountRaw), 1), 3)
        : 1,
    }, timeoutMs);
  }

  close(): void {
    this.rejectAll(new Error('fast_click_helper_closed'));
    this.child?.kill();
    this.child = null;
    this.buffer = '';
    this.starting = null;
  }

  private async ensureStarted(): Promise<void> {
    if (this.child && !this.child.killed && this.child.exitCode === null) return;
    if (this.starting) return this.starting;
    this.starting = this.start();
    try { await this.starting; } finally { this.starting = null; }
  }

  private async start(): Promise<void> {
    this.close();
    const script = String.raw`
$ErrorActionPreference = 'Stop'
$src = @'
using System;
using System.Runtime.InteropServices;
public static class ImcodesFastClick {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, UIntPtr dwExtraInfo);
}
'@
Add-Type -TypeDefinition $src
[Console]::Out.WriteLine('{"ready":true}')
while (($line = [Console]::In.ReadLine()) -ne $null) {
  if ([string]::IsNullOrWhiteSpace($line)) { continue }
  try {
    $payload = $line | ConvertFrom-Json
    $id = [int]$payload.id
    $app = [string]$payload.app
    $processName = [System.IO.Path]::GetFileNameWithoutExtension($app)
    $windows = Get-Process | Where-Object { $_.MainWindowHandle -ne 0 }
    $p = $windows | Where-Object { $_.ProcessName -ieq $processName } | Select-Object -First 1
    if ($null -eq $p) { $p = $windows | Where-Object { $_.MainWindowTitle -like "*$app*" } | Select-Object -First 1 }
    if ($null -eq $p) { throw "window_not_found:$app" }
    $r = New-Object ImcodesFastClick+RECT
    if (-not [ImcodesFastClick]::GetWindowRect($p.MainWindowHandle, [ref]$r)) { throw 'get_window_rect_failed' }
    [ImcodesFastClick]::SetForegroundWindow($p.MainWindowHandle) | Out-Null
    Start-Sleep -Milliseconds 20
    $screenX = $r.Left + [int][Math]::Round([double]$payload.x)
    $screenY = $r.Top + [int][Math]::Round([double]$payload.y)
    [ImcodesFastClick]::SetCursorPos($screenX, $screenY) | Out-Null
    $down = 0x0002; $up = 0x0004
    switch ([string]$payload.button) {
      'right' { $down = 0x0008; $up = 0x0010 }
      'middle' { $down = 0x0020; $up = 0x0040 }
    }
    for ($i = 0; $i -lt [int]$payload.clickCount; $i++) {
      [ImcodesFastClick]::mouse_event($down, 0, 0, 0, [UIntPtr]::Zero)
      [ImcodesFastClick]::mouse_event($up, 0, 0, 0, [UIntPtr]::Zero)
      if ($i + 1 -lt [int]$payload.clickCount) { Start-Sleep -Milliseconds 80 }
    }
    [Console]::Out.WriteLine(([pscustomobject]@{ id = $id; ok = $true } | ConvertTo-Json -Compress))
  } catch {
    $message = $_.Exception.Message
    $outId = if ($null -ne $payload -and $null -ne $payload.id) { [int]$payload.id } else { -1 }
    [Console]::Out.WriteLine(([pscustomobject]@{ id = $outId; ok = $false; error = $message } | ConvertTo-Json -Compress))
  }
}
`;
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = child;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => this.onStdout(String(chunk)));
    child.stderr.on('data', () => {});
    child.on('error', (error) => {
      if (this.child === child) this.child = null;
      this.rejectAll(error instanceof Error ? error : new Error(String(error)));
    });
    child.on('exit', (code, signal) => {
      if (this.child === child) this.child = null;
      this.rejectAll(new Error(`fast_click_helper_exited:${code ?? signal ?? 'unknown'}`));
    });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('fast_click_helper_ready_timeout')), 5_000);
      timer.unref?.();
      const onReady = (chunk: string) => {
        if (!chunk.includes('"ready":true')) return;
        clearTimeout(timer);
        child.stdout.off('data', onReady);
        resolve();
      };
      child.stdout.on('data', onReady);
    });
  }

  private request(payload: Record<string, unknown>, timeoutMs: number): Promise<boolean> {
    const child = this.child;
    if (!child || child.killed || child.exitCode !== null) return Promise.reject(new Error('fast_click_helper_not_running'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('fast_click_timeout'));
      }, Math.min(Math.max(timeoutMs, 1_000), 10_000));
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      try { child.stdin.write(`${JSON.stringify({ id, ...payload })}\n`); }
      catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private onStdout(chunk: string): void {
    this.buffer += chunk;
    for (;;) {
      const newline = this.buffer.indexOf('\n');
      if (newline < 0) return;
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line || line.includes('"ready":true')) continue;
      let parsed: { id?: unknown; ok?: unknown; error?: unknown };
      try { parsed = JSON.parse(line) as { id?: unknown; ok?: unknown; error?: unknown }; } catch { continue; }
      if (typeof parsed.id !== 'number') continue;
      const pending = this.pending.get(parsed.id);
      if (!pending) continue;
      clearTimeout(pending.timer);
      this.pending.delete(parsed.id);
      if (parsed.ok === true) pending.resolve(true);
      else pending.reject(new Error(typeof parsed.error === 'string' ? parsed.error : 'fast_click_failed'));
    }
  }

  private rejectAll(error: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(id);
    }
  }
}

let fastClickClient: FastWindowsClickClient | null = null;

function runFastWindowsCoordinateClick(args: Record<string, unknown>, timeoutMs: number): Promise<boolean> {
  fastClickClient ??= new FastWindowsClickClient();
  return fastClickClient.click(args, timeoutMs);
}


function compressImageBase64WithWindowsDrawing(
  data: string,
  options: ComputerUseReturnOptions,
): Promise<{ data: string; mimeType: string; truncated: boolean }> {
  const payload = JSON.stringify({
    data,
    format: options.imageFormat === 'png' ? 'png' : 'jpeg',
    quality: options.imageQuality,
    maxWidth: options.imageMaxWidth,
  });
  const script = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$payload = [Console]::In.ReadToEnd() | ConvertFrom-Json
$bytes = [Convert]::FromBase64String([string]$payload.data)
$srcStream = [System.IO.MemoryStream]::new($bytes)
$src = [System.Drawing.Image]::FromStream($srcStream)
$scale = [Math]::Min(1.0, [double]$payload.maxWidth / [double]$src.Width)
$w = [Math]::Max(1, [int][Math]::Round($src.Width * $scale))
$h = [Math]::Max(1, [int][Math]::Round($src.Height * $scale))
$bmp = [System.Drawing.Bitmap]::new($w, $h)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
$g.DrawImage($src, 0, 0, $w, $h)
$out = [System.IO.MemoryStream]::new()
if ([string]$payload.format -eq 'png') {
  $mime = 'image/png'
  $bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
} else {
  $mime = 'image/jpeg'
  $codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' } | Select-Object -First 1
  $encParams = [System.Drawing.Imaging.EncoderParameters]::new(1)
  $encParams.Param[0] = [System.Drawing.Imaging.EncoderParameter]::new([System.Drawing.Imaging.Encoder]::Quality, [int64]$payload.quality)
  $bmp.Save($out, $codec, $encParams)
}
$g.Dispose(); $bmp.Dispose(); $src.Dispose(); $srcStream.Dispose()
[pscustomobject]@{ data = [Convert]::ToBase64String($out.ToArray()); mimeType = $mime } | ConvertTo-Json -Compress
`;
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    const maxStdout = COMPUTER_USE_MAX_IMAGE_BASE64_BYTES + 4096;
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('image_compress_timeout'));
    }, 10_000);
    timer.unref?.();
    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes <= maxStdout) stdoutChunks.push(Buffer.from(chunk));
    });
    child.stderr.on('data', (chunk: Buffer) => stderrChunks.push(Buffer.from(chunk)));
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(Buffer.concat(stderrChunks).toString('utf8') || `image_compress_exit_${code}`));
        return;
      }
      try {
        const parsed = JSON.parse(Buffer.concat(stdoutChunks).toString('utf8')) as { data?: unknown; mimeType?: unknown };
        if (typeof parsed.data !== 'string' || typeof parsed.mimeType !== 'string') throw new Error('invalid_image_compress_output');
        const cut = truncateUtf8(parsed.data, COMPUTER_USE_MAX_IMAGE_BASE64_BYTES);
        resolve({ data: cut.value, mimeType: parsed.mimeType, truncated: cut.truncated || stdoutBytes > maxStdout });
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
    child.stdin.end(payload);
  });
}

async function normalizeContent(raw: unknown, options: ComputerUseReturnOptions): Promise<{ content: ComputerUseContentItem[]; truncated: boolean }> {
  const contentRaw = raw && typeof raw === 'object' && !Array.isArray(raw)
    ? (raw as { content?: unknown }).content
    : undefined;
  const items = Array.isArray(contentRaw) ? contentRaw : [];
  let truncated = false;
  const content: ComputerUseContentItem[] = [];
  for (const item of items) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const record = item as Record<string, unknown>;
    if (record.type === 'text' && typeof record.text === 'string') {
      if (!options.includeState) continue;
      const cut = truncateUtf8(record.text, COMPUTER_USE_MAX_TEXT_BYTES);
      truncated ||= cut.truncated;
      content.push({ type: 'text', text: cut.value });
      continue;
    }
    if (record.type === 'image' && typeof record.data === 'string') {
      if (!options.includeImage) continue;
      const image = await compressImageBase64(record.data, options);
      truncated ||= image.truncated;
      content.push({ type: 'image', data: image.data, mimeType: image.mimeType });
    }
  }
  return { content, truncated };
}

export async function normalizeOpenComputerUseParsedResult(
  tool: string,
  args: Record<string, unknown> | null,
  parsed: unknown,
): Promise<{ content: ComputerUseContentItem[]; truncated: boolean; isError: boolean }> {
  const returnOptions = parseReturnOptions(tool, args);
  const isError = Boolean(parsed && typeof parsed === 'object' && !Array.isArray(parsed) && (parsed as { isError?: unknown }).isError);
  const { content, truncated } = await normalizeContent(parsed, { ...returnOptions, includeState: returnOptions.includeState || isError });
  if (!isError && isActionTool(tool) && !returnOptions.includeState) {
    return { content: [{ type: 'text', text: `${tool} completed` }, ...content], truncated, isError };
  }
  return { content, truncated, isError };
}

function normalizeError(message: string): { error: string; truncated: boolean } {
  const text = message.trim() || 'computer use tool failed';
  const cut = truncateUtf8(text, COMPUTER_USE_MAX_ERROR_BYTES);
  return { error: cut.value || 'computer use tool failed', truncated: cut.truncated };
}

function selectOpenComputerUseResult(raw: unknown): unknown {
  if (!Array.isArray(raw)) return raw;
  const last = raw.at(-1);
  if (last && typeof last === 'object' && !Array.isArray(last) && 'result' in last) {
    return (last as { result?: unknown }).result;
  }
  return last;
}

function shellCommandForPlatform(shell: string | undefined, command: string): { file: string; args: string[] } {
  if (process.platform === 'win32') {
    if (shell === 'cmd') return { file: 'cmd.exe', args: ['/d', '/s', '/c', command] };
    return { file: 'powershell.exe', args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command] };
  }
  return { file: shell === 'bash' ? 'bash' : 'sh', args: ['-lc', command] };
}

function runSessionShell(args: Record<string, unknown>, timeoutMs: number): Promise<{ exitCode: number | null; stdout: string; stderr: string; timedOut: boolean; truncated: boolean; error?: string }> {
  const command = typeof args.command === 'string' ? args.command : '';
  if (!command) return Promise.resolve({ exitCode: null, stdout: '', stderr: '', timedOut: false, truncated: false, error: 'command is required' });
  const cwd = typeof args.cwd === 'string' && args.cwd ? args.cwd : undefined;
  const shell = typeof args.shell === 'string' ? args.shell : undefined;
  const spec = shellCommandForPlatform(shell, command);
  return new Promise((resolve) => {
    const child = spawn(spec.file, spec.args, { cwd, windowsHide: true });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let truncated = false;
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      child.kill();
      resolve({ exitCode: null, stdout: Buffer.concat(stdoutChunks).toString('utf8'), stderr: Buffer.concat(stderrChunks).toString('utf8'), timedOut: true, truncated, error: 'shell_session1_timeout' });
    }, timeoutMs);
    timer.unref?.();
    const collect = (chunks: Buffer[], which: 'stdout' | 'stderr') => (chunk: Buffer) => {
      const max = SHELL_SESSION1_OUTPUT_MAX_BYTES;
      const current = which === 'stdout' ? stdoutBytes : stderrBytes;
      if (current >= max) { truncated = true; return; }
      const next = Buffer.from(chunk);
      const room = max - current;
      chunks.push(next.byteLength > room ? next.subarray(0, room) : next);
      if (which === 'stdout') stdoutBytes += Math.min(next.byteLength, room);
      else stderrBytes += Math.min(next.byteLength, room);
      if (next.byteLength > room) truncated = true;
    };
    child.stdout.on('data', collect(stdoutChunks, 'stdout'));
    child.stderr.on('data', collect(stderrChunks, 'stderr'));
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ exitCode: null, stdout: Buffer.concat(stdoutChunks).toString('utf8'), stderr: Buffer.concat(stderrChunks).toString('utf8'), timedOut: false, truncated, error: err.message });
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        exitCode: code,
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
        timedOut: false,
        truncated,
      });
    });
  });
}

async function runShellSession1(request: ComputerUseRequest, timeoutMs: number, started: number): Promise<ComputerUseResult> {
  const result = await runSessionShell(request.arguments ?? {}, timeoutMs);
  const payload = {
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    timedOut: result.timedOut,
    ...(result.error ? { error: result.error } : {}),
    truncated: result.truncated,
  };
  const ok = result.error === undefined && !result.timedOut;
  return {
    correlationId: request.correlationId,
    ok,
    tool: request.tool,
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    durationMs: Date.now() - started,
    ...(ok ? {} : { error: result.error ?? 'shell_session1_failed' }),
    ...(result.timedOut ? { timedOut: true } : {}),
    ...(result.truncated ? { truncated: true } : {}),
  };
}

const BROWSER_USE_TOOLS = new Set<string>([
  'browser_open',
  'browser_navigate',
  'browser_snapshot',
  'browser_click',
  'browser_fill',
  'browser_press',
  'browser_evaluate',
  'browser_close',
]);

function isBrowserUseTool(tool: string): boolean {
  return BROWSER_USE_TOOLS.has(tool);
}

function optionalStringArg(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function truncateJsonText(value: unknown, maxBytes: number = COMPUTER_USE_MAX_TEXT_BYTES): { text: string; truncated: boolean } {
  let text: string;
  try { text = typeof value === 'string' ? value : JSON.stringify(value, null, 2); }
  catch { text = String(value); }
  const truncated = truncateUtf8(text, maxBytes);
  return { text: truncated.value, truncated: truncated.truncated };
}

interface CdpResponse { id?: number; result?: unknown; error?: { message?: string; data?: string } }
interface CdpEvent { method?: string; params?: unknown }

type CdpPending = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

class CdpClient {
  private ws: WebSocket | null = null;
  private nextId = 1;
  private pending = new Map<number, CdpPending>();
  private eventWaiters: Array<{ method: string; resolve: () => void; timer: ReturnType<typeof setTimeout> }> = [];

  constructor(private readonly endpoint: string) {}

  async connect(timeoutMs: number): Promise<void> {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return;
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(this.endpoint);
      const timer = setTimeout(() => {
        ws.close();
        reject(new Error('browser_cdp_connect_timeout'));
      }, timeoutMs);
      timer.unref?.();
      ws.once('open', () => {
        clearTimeout(timer);
        this.ws = ws;
        ws.on('message', (data) => this.onMessage(String(data)));
        ws.on('close', () => this.rejectAll(new Error('browser_cdp_closed')));
        ws.on('error', (error) => this.rejectAll(error instanceof Error ? error : new Error(String(error))));
        resolve();
      });
      ws.once('error', (error) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      });
    });
  }

  call(method: string, params: Record<string, unknown> = {}, timeoutMs: number = 30_000): Promise<unknown> {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error('browser_cdp_not_connected'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`browser_cdp_timeout:${method}`));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      ws.send(JSON.stringify({ id, method, params }), (error) => {
        if (!error) return;
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      });
    });
  }

  waitForEvent(method: string, timeoutMs: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, timeoutMs);
      timer.unref?.();
      this.eventWaiters.push({ method, resolve: () => { clearTimeout(timer); resolve(); }, timer });
    });
  }

  close(): void {
    this.ws?.close();
    this.ws = null;
    this.rejectAll(new Error('browser_cdp_closed'));
  }

  private onMessage(raw: string): void {
    let message: CdpResponse & CdpEvent;
    try { message = JSON.parse(raw) as CdpResponse & CdpEvent; } catch { return; }
    if (typeof message.id === 'number') {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message || message.error.data || 'browser_cdp_error'));
      else pending.resolve(message.result);
      return;
    }
    if (message.method) {
      const waiters = this.eventWaiters.splice(0);
      for (const waiter of waiters) {
        if (waiter.method === message.method) waiter.resolve();
        else this.eventWaiters.push(waiter);
      }
    }
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    for (const waiter of this.eventWaiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.resolve();
    }
  }
}

type BrowserPlatform = NodeJS.Platform;

export function browserExecutableCandidatesForTest(args: Record<string, unknown>, platform: BrowserPlatform): string[] {
  return browserExecutableCandidates(args, platform);
}

export function browserLaunchArgsForTest(userDataDir: string, args: Record<string, unknown>, platform: BrowserPlatform, env: NodeJS.ProcessEnv): string[] {
  return browserLaunchArgs(userDataDir, args, platform, env);
}

function browserExecutableCandidates(args: Record<string, unknown>, platform: BrowserPlatform = process.platform): string[] {
  const explicit = optionalStringArg(args, 'executablePath') ?? process.env.IMCODES_BROWSER_EXE?.trim();
  if (explicit) return [explicit];
  const channel = optionalStringArg(args, 'channel')?.toLowerCase();
  const wants = (name: 'chrome' | 'msedge' | 'chromium') => !channel
    || channel === name
    || (name === 'msedge' && channel === 'edge');
  if (platform === 'win32') return [
    ...(wants('msedge') ? [
      'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
      ...(process.env.LOCALAPPDATA ? [join(process.env.LOCALAPPDATA, 'Microsoft', 'Edge', 'Application', 'msedge.exe')] : []),
    ] : []),
    ...(wants('chrome') ? [
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
      ...(process.env.LOCALAPPDATA ? [join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe')] : []),
    ] : []),
  ];
  if (platform === 'darwin') return [
    ...(wants('chrome') ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'] : []),
    ...(wants('msedge') ? ['/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'] : []),
    ...(wants('chromium') ? ['/Applications/Chromium.app/Contents/MacOS/Chromium'] : []),
  ];
  return [
    ...(wants('chrome') ? ['google-chrome', 'google-chrome-stable', '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable'] : []),
    ...(wants('chromium') ? ['chromium-browser', 'chromium', '/usr/bin/chromium-browser', '/usr/bin/chromium'] : []),
    ...(wants('msedge') ? ['microsoft-edge', 'microsoft-edge-stable', '/usr/bin/microsoft-edge', '/usr/bin/microsoft-edge-stable'] : []),
  ];
}

async function firstExistingBrowser(args: Record<string, unknown>): Promise<string> {
  const candidates = browserExecutableCandidates(args);
  for (const candidate of candidates) {
    if (candidate.includes('/') || candidate.includes('\\')) {
      if (await fileExists(candidate)) return candidate;
      continue;
    }
    const proc = await execFileBounded(process.platform === 'win32' ? 'where' : 'which', [candidate], 2_000);
    const first = proc.stdout.split(/\r?\n/).find((line) => line.trim());
    if (first) return first.trim();
  }
  throw new Error('browser_executable_not_found');
}

function browserLaunchArgs(userDataDir: string, args: Record<string, unknown>, platform: BrowserPlatform = process.platform, env: NodeJS.ProcessEnv = process.env): string[] {
  const headless = args.headless === true
    || (platform === 'linux' && args.headless !== false && !env.DISPLAY && !env.WAYLAND_DISPLAY);
  const launchArgs = [
    '--remote-debugging-port=0',
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
  ];
  if (headless) launchArgs.splice(1, 0, '--headless=new');
  if (platform === 'linux') {
    launchArgs.splice(1, 0, '--disable-dev-shm-usage');
    if (args.noSandbox !== false) launchArgs.splice(1, 0, '--no-sandbox');
  }
  launchArgs.push('about:blank');
  return launchArgs;
}

class BrowserUseController {
  private child: ChildProcess | null = null;
  private userDataDir: string | null = null;
  private client: CdpClient | null = null;
  private starting: Promise<CdpClient> | null = null;

  async run(tool: ComputerUseToolName, args: Record<string, unknown>, timeoutMs: number): Promise<{ content: ComputerUseContentItem[]; truncated?: boolean }> {
    if (tool === 'browser_close') {
      await this.close();
      return { content: [{ type: 'text', text: 'browser closed' }] };
    }
    const client = await this.ensureClient(args, timeoutMs);
    if (tool === 'browser_open' || tool === 'browser_navigate') {
      const url = optionalStringArg(args, 'url');
      if (tool === 'browser_navigate' && !url) throw new Error('url_required');
      if (url) await this.navigate(client, url, timeoutMs);
      return this.snapshot(client, args, timeoutMs);
    }
    if (tool === 'browser_snapshot') return this.snapshot(client, args, timeoutMs);
    if (tool === 'browser_click') {
      await this.evalInPage(client, this.selectorScript(args, 'click'), timeoutMs);
      return { content: [{ type: 'text', text: 'browser_click completed' }] };
    }
    if (tool === 'browser_fill') {
      if (typeof args.value !== 'string') throw new Error('value_required');
      await this.evalInPage(client, this.selectorScript(args, 'fill'), timeoutMs);
      return { content: [{ type: 'text', text: 'browser_fill completed' }] };
    }
    if (tool === 'browser_press') {
      const key = optionalStringArg(args, 'key');
      if (!key) throw new Error('key_required');
      const selector = optionalStringArg(args, 'selector');
      if (selector) await this.evalInPage(client, this.selectorScript(args, 'focus'), timeoutMs);
      await client.call('Input.dispatchKeyEvent', { type: 'keyDown', key }, Math.min(timeoutMs, 30_000));
      await client.call('Input.dispatchKeyEvent', { type: 'keyUp', key }, Math.min(timeoutMs, 30_000));
      return { content: [{ type: 'text', text: 'browser_press completed' }] };
    }
    if (tool === 'browser_evaluate') {
      const script = optionalStringArg(args, 'script');
      if (!script) throw new Error('script_required');
      const result = await this.evalInPage(client, script, timeoutMs);
      const output = truncateJsonText(result);
      return { content: [{ type: 'text', text: output.text }], ...(output.truncated ? { truncated: true } : {}) };
    }
    throw new Error(`unsupported_browser_tool:${tool}`);
  }

  private async ensureClient(args: Record<string, unknown>, timeoutMs: number): Promise<CdpClient> {
    if (this.client) return this.client;
    if (this.starting) return this.starting;
    this.starting = this.start(args, timeoutMs);
    try { return await this.starting; } finally { this.starting = null; }
  }

  private async start(args: Record<string, unknown>, timeoutMs: number): Promise<CdpClient> {
    const cdpEndpoint = optionalStringArg(args, 'cdpEndpoint');
    if (cdpEndpoint) {
      const client = new CdpClient(cdpEndpoint);
      await client.connect(Math.min(timeoutMs, 30_000));
      await client.call('Page.enable', {}, Math.min(timeoutMs, 30_000)).catch(() => {});
      await client.call('Runtime.enable', {}, Math.min(timeoutMs, 30_000)).catch(() => {});
      this.client = client;
      return client;
    }

    const browser = await firstExistingBrowser(args);
    this.userDataDir = await mkdtemp(join(tmpdir(), 'imcodes-browser-'));
    const launchArgs = browserLaunchArgs(this.userDataDir, args);
    this.child = spawn(browser, launchArgs, { windowsHide: true, stdio: 'ignore' });
    this.child.once('exit', () => {
      this.client?.close();
      this.client = null;
      this.child = null;
    });
    const portFile = join(this.userDataDir, 'DevToolsActivePort');
    const deadline = Date.now() + Math.min(timeoutMs, 30_000);
    let port = '';
    while (Date.now() < deadline) {
      const text = await readFile(portFile, 'utf8').catch(() => '');
      port = text.split(/\r?\n/)[0]?.trim() ?? '';
      if (/^\d+$/.test(port)) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (!/^\d+$/.test(port)) throw new Error('browser_debug_port_unavailable');
    const target = await this.newPageTarget(Number(port), optionalStringArg(args, 'url') ?? 'about:blank');
    const client = new CdpClient(target.webSocketDebuggerUrl);
    await client.connect(Math.min(timeoutMs, 30_000));
    await client.call('Page.enable', {}, Math.min(timeoutMs, 30_000)).catch(() => {});
    await client.call('Runtime.enable', {}, Math.min(timeoutMs, 30_000)).catch(() => {});
    this.client = client;
    return client;
  }

  private async newPageTarget(port: number, url: string): Promise<{ webSocketDebuggerUrl: string }> {
    const response = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' });
    if (!response.ok) throw new Error(`browser_target_failed:${response.status}`);
    const json = await response.json() as { webSocketDebuggerUrl?: unknown };
    if (typeof json.webSocketDebuggerUrl !== 'string') throw new Error('browser_target_missing_ws');
    return { webSocketDebuggerUrl: json.webSocketDebuggerUrl };
  }

  private async navigate(client: CdpClient, url: string, timeoutMs: number): Promise<void> {
    const wait = client.waitForEvent('Page.loadEventFired', Math.min(timeoutMs, 30_000));
    await client.call('Page.navigate', { url }, Math.min(timeoutMs, 30_000));
    await wait;
  }

  private async evalInPage(client: CdpClient, expression: string, timeoutMs: number): Promise<unknown> {
    const result = await client.call('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      timeout: Math.min(timeoutMs, 30_000),
    }, Math.min(timeoutMs, 30_000)) as { result?: { value?: unknown; description?: string }; exceptionDetails?: { text?: string } };
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || 'browser_evaluate_failed');
    return result.result?.value ?? result.result?.description ?? null;
  }

  private selectorScript(args: Record<string, unknown>, action: 'click' | 'fill' | 'focus'): string {
    const selector = optionalStringArg(args, 'selector');
    const text = optionalStringArg(args, 'text');
    const value = typeof args.value === 'string' ? args.value : '';
    const exact = args.exact === true;
    const selectorJson = JSON.stringify(selector ?? null);
    const textJson = JSON.stringify(text ?? null);
    const valueJson = JSON.stringify(value);
    return `(() => {
      const selector = ${selectorJson};
      const text = ${textJson};
      const exact = ${JSON.stringify(exact)};
      const value = ${valueJson};
      function visible(el) { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; }
      let el = selector ? document.querySelector(selector) : null;
      if (!el && text) {
        const all = Array.from(document.querySelectorAll('a,button,input,textarea,select,[role="button"],[role="link"],label,*'));
        el = all.find((candidate) => {
          const t = (candidate.innerText || candidate.textContent || candidate.getAttribute('aria-label') || candidate.getAttribute('placeholder') || '').trim();
          return visible(candidate) && (exact ? t === text : t.includes(text));
        }) || null;
      }
      if (!el) throw new Error('element_not_found');
      el.scrollIntoView({ block: 'center', inline: 'center' });
      el.focus?.();
      if (${JSON.stringify(action)} === 'click') { el.click(); return true; }
      if (${JSON.stringify(action)} === 'fill') {
        el.value = value;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      }
      return true;
    })()`;
  }

  private async snapshot(client: CdpClient, args: Record<string, unknown>, timeoutMs: number): Promise<{ content: ComputerUseContentItem[]; truncated?: boolean }> {
    const textLimitRaw = args.textLimit;
    const textLimit = typeof textLimitRaw === 'number' && Number.isFinite(textLimitRaw)
      ? Math.min(Math.max(Math.round(textLimitRaw), 1_000), COMPUTER_USE_MAX_TEXT_BYTES)
      : 32_000;
    const result = await this.evalInPage(client, `(() => {
      const elements = Array.from(document.querySelectorAll('a,button,input,textarea,select,[role="button"],[role="link"]')).slice(0, 80).map((el) => ({
        tag: el.tagName.toLowerCase(),
        text: (el.innerText || el.textContent || '').trim().slice(0, 160),
        aria: el.getAttribute('aria-label') || '',
        role: el.getAttribute('role') || '',
        placeholder: el.getAttribute('placeholder') || '',
        type: el.getAttribute('type') || '',
        id: el.id || '',
        name: el.getAttribute('name') || '',
        href: el.href || '',
      }));
      return { url: location.href, title: document.title, visibleText: (document.body?.innerText || '').slice(0, ${textLimit}), elements };
    })()`, timeoutMs);
    const output = truncateJsonText(result);
    return { content: [{ type: 'text', text: output.text }], ...(output.truncated ? { truncated: true } : {}) };
  }

  async close(): Promise<void> {
    this.client?.close();
    this.client = null;
    this.child?.kill();
    this.child = null;
    const dir = this.userDataDir;
    this.userDataDir = null;
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

const browserUseController = new BrowserUseController();

async function runBrowserUseTool(request: ComputerUseRequest, timeoutMs: number, started: number): Promise<ComputerUseResult> {
  try {
    const result = await browserUseController.run(request.tool, request.arguments ?? {}, timeoutMs);
    return {
      correlationId: request.correlationId,
      ok: true,
      tool: request.tool,
      content: result.content,
      durationMs: Date.now() - started,
      ...(result.truncated ? { truncated: true } : {}),
    };
  } catch (error) {
    const normalized = normalizeError(error instanceof Error ? error.message : String(error));
    return {
      correlationId: request.correlationId,
      ok: false,
      tool: request.tool,
      content: [],
      durationMs: Date.now() - started,
      error: normalized.error,
      ...(normalized.truncated ? { truncated: true } : {}),
    };
  }
}

export async function runComputerUseTool(request: ComputerUseRequest): Promise<ComputerUseResult> {
  const started = Date.now();
  const timeoutMs = Math.min(
    Math.max(request.timeoutMs ?? COMPUTER_USE_DEFAULT_TIMEOUT_MS, COMPUTER_USE_MIN_TIMEOUT_MS),
    computerUseMaxTimeoutMs(request.tool),
  );
  const argsObject = request.arguments ?? {};
  const argsJson = JSON.stringify(argsObject);
  if (utf8Bytes(argsJson) > COMPUTER_USE_MAX_ARGUMENT_BYTES) {
    return {
      correlationId: request.correlationId,
      ok: false,
      tool: request.tool,
      content: [],
      durationMs: Date.now() - started,
      error: 'arguments_too_large',
    };
  }

  if (request.tool === 'shell_session1') return runShellSession1(request, timeoutMs, started);
  if (isBrowserUseTool(request.tool)) return runBrowserUseTool(request, timeoutMs, started);

  if (isFastWindowsCoordinateClick(request.tool, argsObject)) {
    try {
      if (await runFastWindowsCoordinateClick(argsObject, timeoutMs)) {
        return {
          correlationId: request.correlationId,
          ok: true,
          tool: request.tool,
          content: [{ type: 'text', text: 'click completed' }],
          durationMs: Date.now() - started,
        };
      }
    } catch {
      // Fall back to open-computer-use for apps/windows that the fast Win32 path cannot target.
    }
  }

  try {
    let parsed: unknown;
    try {
      parsed = await callOpenComputerUseMcpTool(request.tool, forwardedComputerUseArgs(argsObject), timeoutMs);
    } catch {
      const bin = await resolveOpenComputerUseBinary();
      const proc = await execFileBounded(bin, openComputerUseCallArgs(request.tool, argsJson), timeoutMs + 1_000, openComputerUseEnv(request.tool));
      const durationMs = Date.now() - started;
      try { parsed = JSON.parse(proc.stdout); } catch {
        if (proc.error) {
          const normalized = normalizeError(proc.stderr || proc.error);
          return {
            correlationId: request.correlationId,
            ok: false,
            tool: request.tool,
            content: [],
            durationMs,
            error: normalized.error,
            ...(proc.timedOut ? { timedOut: true } : {}),
            ...(normalized.truncated ? { truncated: true } : {}),
          };
        }
        const normalized = normalizeError(proc.stderr || proc.stdout || 'computer use tool returned non-json output');
        return {
          correlationId: request.correlationId,
          ok: false,
          tool: request.tool,
          content: [],
          durationMs,
          error: normalized.error,
          ...(normalized.truncated ? { truncated: true } : {}),
        };
      }
      parsed = selectOpenComputerUseResult(parsed);
    }
    const durationMs = Date.now() - started;
    const normalizedResult = await normalizeOpenComputerUseParsedResult(request.tool, argsObject, parsed);
    if (normalizedResult.isError) {
      const text = normalizedResult.content.find((item) => item.type === 'text')?.text ?? 'computer use tool failed';
      const normalized = normalizeError(text);
      return {
        correlationId: request.correlationId,
        ok: false,
        tool: request.tool,
        content: normalizedResult.content,
        durationMs,
        error: normalized.error,
        ...(normalizedResult.truncated || normalized.truncated ? { truncated: true } : {}),
      };
    }
    return {
      correlationId: request.correlationId,
      ok: true,
      tool: request.tool,
      content: normalizedResult.content,
      durationMs,
      ...(normalizedResult.truncated ? { truncated: true } : {}),
    };
  } catch (error) {
    const normalized = normalizeError(error instanceof Error ? error.message : String(error));
    return {
      correlationId: request.correlationId,
      ok: false,
      tool: request.tool,
      content: [],
      durationMs: Date.now() - started,
      error: normalized.error,
      ...(normalized.truncated ? { truncated: true } : {}),
    };
  }
}
