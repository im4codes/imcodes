import { execFile, spawn } from 'node:child_process';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  COMPUTER_USE_DEFAULT_TIMEOUT_MS,
  COMPUTER_USE_MAX_ERROR_BYTES,
  COMPUTER_USE_MAX_TEXT_BYTES,
  COMPUTER_USE_MAX_IMAGE_BASE64_BYTES,
  COMPUTER_USE_MAX_ARGUMENT_BYTES,
  COMPUTER_USE_MIN_TIMEOUT_MS,
  COMPUTER_USE_MAX_TIMEOUT_MS,
  type ComputerUseContentItem,
  type ComputerUseRequest,
  type ComputerUseResult,
} from '../../shared/computer-use.js';

const WINDOWS_DEFAULT_OCU_EXE = 'C:\\ProgramData\\imcodes-node\\computer-use-helper\\open-computer-use.exe';
const SHELL_SESSION1_OUTPUT_MAX_BYTES = 96 * 1024;

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

async function resolveOpenComputerUseBinary(): Promise<string> {
  const explicit = process.env.IMCODES_COMPUTER_USE_EXE?.trim();
  if (explicit) return explicit;
  if (process.platform === 'win32' && await fileExists(WINDOWS_DEFAULT_OCU_EXE)) return WINDOWS_DEFAULT_OCU_EXE;
  return process.platform === 'win32' ? 'open-computer-use.exe' : 'open-computer-use';
}

type ExecOutcome = { stdout: string; stderr: string; timedOut: boolean; error?: string };

function execFileBounded(file: string, args: string[], timeoutMs: number): Promise<ExecOutcome> {
  return new Promise((resolve) => {
    execFile(file, args, {
      timeout: timeoutMs,
      maxBuffer: COMPUTER_USE_MAX_TEXT_BYTES + COMPUTER_USE_MAX_IMAGE_BASE64_BYTES + COMPUTER_USE_MAX_ERROR_BYTES + 4096,
      windowsHide: true,
      encoding: 'utf8',
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

function normalizeContent(raw: unknown): { content: ComputerUseContentItem[]; truncated: boolean } {
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
      const cut = truncateUtf8(record.text, COMPUTER_USE_MAX_TEXT_BYTES);
      truncated ||= cut.truncated;
      content.push({ type: 'text', text: cut.value });
      continue;
    }
    if (record.type === 'image' && typeof record.data === 'string') {
      const mimeType = typeof record.mimeType === 'string' ? record.mimeType : 'image/png';
      const cut = truncateUtf8(record.data, COMPUTER_USE_MAX_IMAGE_BASE64_BYTES);
      truncated ||= cut.truncated;
      content.push({ type: 'image', data: cut.value, mimeType });
    }
  }
  return { content, truncated };
}

function normalizeError(message: string): { error: string; truncated: boolean } {
  const text = message.trim() || 'computer use tool failed';
  const cut = truncateUtf8(text, COMPUTER_USE_MAX_ERROR_BYTES);
  return { error: cut.value || 'computer use tool failed', truncated: cut.truncated };
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

export async function runComputerUseTool(request: ComputerUseRequest): Promise<ComputerUseResult> {
  const started = Date.now();
  const timeoutMs = Math.min(Math.max(request.timeoutMs ?? COMPUTER_USE_DEFAULT_TIMEOUT_MS, COMPUTER_USE_MIN_TIMEOUT_MS), COMPUTER_USE_MAX_TIMEOUT_MS);
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

  const temp = await mkdtemp(join(tmpdir(), 'imcodes-computer-use-'));
  const argsFile = join(temp, 'args.json');
  try {
    await writeFile(argsFile, argsJson, 'utf8');
    const bin = await resolveOpenComputerUseBinary();
    const proc = await execFileBounded(bin, ['call', request.tool, '--args-file', argsFile, '--timeout', `${timeoutMs}ms`], timeoutMs + 1_000);
    const durationMs = Date.now() - started;
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
    let parsed: unknown;
    try { parsed = JSON.parse(proc.stdout); } catch {
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
    const { content, truncated } = normalizeContent(parsed);
    const isError = Boolean(parsed && typeof parsed === 'object' && !Array.isArray(parsed) && (parsed as { isError?: unknown }).isError);
    if (isError) {
      const text = content.find((item) => item.type === 'text')?.text ?? 'computer use tool failed';
      const normalized = normalizeError(text);
      return {
        correlationId: request.correlationId,
        ok: false,
        tool: request.tool,
        content,
        durationMs,
        error: normalized.error,
        ...(truncated || normalized.truncated ? { truncated: true } : {}),
      };
    }
    return {
      correlationId: request.correlationId,
      ok: true,
      tool: request.tool,
      content,
      durationMs,
      ...(truncated ? { truncated: true } : {}),
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
  } finally {
    await rm(temp, { recursive: true, force: true }).catch(() => {});
  }
}
