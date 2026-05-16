import { execFile, type ExecFileOptions } from 'node:child_process';
import { mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { promisify } from 'node:util';
import logger from '../util/logger.js';
import { IMCODES_MEMORY_MCP_ARGS, IMCODES_MEMORY_MCP_COMMAND } from '../agent/providers/getDefaultMcpServers.js';
import { IMCODES_MEMORY_MCP_SERVER_NAME } from '../../shared/memory-mcp-server-name.js';
import { MEMORY_MCP_PROVIDER_STATUS_REASON } from '../../shared/memory-ws.js';

const execFileAsync = promisify(execFile);
const NOTICE_MARKER = join(homedir(), '.imcodes', 'qwen-mcp-notice-shown');
const DAEMON_CONFLICT_SERVER_NAME = `${IMCODES_MEMORY_MCP_SERVER_NAME}-daemon`;

export interface QwenMcpEnsureOptions {
  execFileImpl?: (file: string, args: string[], options: ExecFileOptions) => Promise<{ stdout: string; stderr: string }>;
  qwenBinary?: string;
  noticeMarkerPath?: string;
}

export interface QwenMcpEnsureResult {
  serverName: string;
  changed: boolean;
  degraded: boolean;
  safeToAllow: boolean;
  reason?: string;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function withLock<T>(lockPath: string, fn: () => Promise<T>): Promise<T> {
  await mkdir(dirname(lockPath), { recursive: true });
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      await mkdir(lockPath, { recursive: false });
      try {
        return await fn();
      } finally {
        await rm(lockPath, { recursive: true, force: true });
      }
    } catch (err: any) {
      if (err?.code !== 'EEXIST') throw err;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  throw new Error(`timed out waiting for Qwen MCP lock ${lockPath}`);
}

interface QwenMcpListedServer {
  name: string;
  command?: string;
  args?: string[];
}

function execOutput(result: { stdout: string; stderr: string } | string): string {
  if (typeof result === 'string') return result;
  return `${result.stdout}\n${result.stderr}`;
}

function isSameDaemonServer(server: QwenMcpListedServer | undefined): boolean {
  return server?.command === IMCODES_MEMORY_MCP_COMMAND
    && Array.isArray(server.args)
    && server.args.length === IMCODES_MEMORY_MCP_ARGS.length
    && server.args.every((arg, index) => arg === IMCODES_MEMORY_MCP_ARGS[index]);
}

function parseQwenMcpList(output: string): Map<string, QwenMcpListedServer> | null {
  const trimmed = output.trim();
  if (!trimmed || /no\s+mcp\s+servers\s+configured/i.test(trimmed)) return new Map();
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    const servers = new Map<string, QwenMcpListedServer>();
    const visit = (value: unknown): void => {
      if (Array.isArray(value)) {
        for (const item of value) visit(item);
        return;
      }
      if (!value || typeof value !== 'object') return;
      const record = value as Record<string, unknown>;
      const name = record.name ?? record.serverName ?? record.id;
      if (typeof name === 'string' && name.trim()) {
        const command = typeof record.command === 'string'
          ? record.command
          : typeof record.commandOrUrl === 'string'
            ? record.commandOrUrl
            : undefined;
        const args = Array.isArray(record.args)
          ? record.args.filter((arg): arg is string => typeof arg === 'string')
          : undefined;
        servers.set(name.trim(), { name: name.trim(), command, args });
      }
      for (const key of ['servers', 'mcpServers']) visit(record[key]);
    };
    visit(parsed);
    return servers;
  } catch {
    return parseQwenMcpListText(trimmed);
  }
}

function cleanTableLine(line: string): string {
  return line
    .replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, '')
    .replace(/[│┃║╎╏]/g, ' ')
    .replace(/^(?:[✓✔●○■□◆◇∙•*]\s*)+/, '')
    .replace(/^[\s|+─━\-┌┐└┘├┤┬┴┼]+|[\s|+─━\-┌┐└┘├┤┬┴┼]+$/g, '')
    .trim();
}

function cleanCommandText(commandText: string): string {
  return commandText
    .replace(/\s+\((?:stdio|sse|http|streamable-http)\)\s*(?:[-–—]\s*(?:connected|disconnected|failed|unknown|error).*)?$/i, '')
    .replace(/\s+[-–—]\s*(?:connected|disconnected|failed|unknown|error)\b.*$/i, '')
    .trim();
}

function parseQwenMcpListText(output: string): Map<string, QwenMcpListedServer> | null {
  const servers = new Map<string, QwenMcpListedServer>();
  for (const rawLine of output.split(/\r?\n/)) {
    const line = cleanTableLine(rawLine);
    if (!line) continue;
    if (/^(name|server\s*name)\b/i.test(line) && /\b(command|commandorurl|args)\b/i.test(line)) continue;
    if (/^(server|name)\s*[:=]\s*$/i.test(line)) continue;

    const colonEntry = line.match(/^([A-Za-z0-9_.-]+)\s*:\s+(.+)$/);
    const knownName = line.match(/\b(imcodes-memory(?:-daemon)?)\b\s*:?\s+(.+)$/);
    const parts = knownName
      ? [knownName[1], knownName[2]]
      : colonEntry
        ? [colonEntry[1], colonEntry[2]]
      : line.split(/\s{2,}|\t+/).filter(Boolean);
    if (parts.length < 2) continue;

    const name = parts[0]?.trim();
    const commandText = cleanCommandText(parts.slice(1).join(' ').trim());
    if (!name || !commandText || /^command\b/i.test(commandText)) continue;
    const tokens = commandText.match(/"[^"]*"|'[^']*'|\S+/g)?.map((token) => token.replace(/^['"]|['"]$/g, '')) ?? [];
    const command = tokens[0];
    const args = tokens.slice(1);
    if (!command) continue;
    servers.set(name, { name, command, args });
  }
  return servers.size > 0 ? servers : null;
}

async function writeNoticeOnce(markerPath: string, message: string): Promise<void> {
  if (await pathExists(markerPath)) return;
  await mkdir(dirname(markerPath), { recursive: true });
  await writeFile(markerPath, `${new Date().toISOString()}\n${message}\n`, 'utf8');
  logger.warn({ message }, 'Qwen MCP auto-configuration notice');
}

export async function ensureQwenMcpHasImcodesEntry(options: QwenMcpEnsureOptions = {}): Promise<QwenMcpEnsureResult> {
  const qwenBinary = options.qwenBinary ?? 'qwen';
  const run = options.execFileImpl ?? ((file, args, opts) => execFileAsync(file, args, opts) as Promise<{ stdout: string; stderr: string }>);
  const lockPath = join(homedir(), '.imcodes', 'qwen-mcp.lock');
  try {
    return await withLock(lockPath, async () => {
      const listed = await run(qwenBinary, ['mcp', 'list'], { windowsHide: true, timeout: 10_000 });
      const servers = parseQwenMcpList(execOutput(listed));
      if (!servers) {
        logger.warn({ provider: 'qwen' }, 'Unable to parse qwen mcp list output; continuing with MCP degraded');
        return {
          serverName: IMCODES_MEMORY_MCP_SERVER_NAME,
          changed: false,
          degraded: true,
          safeToAllow: false,
          reason: MEMORY_MCP_PROVIDER_STATUS_REASON.MCP_REGISTRATION_FAILED,
        };
      }
      const existingPrimary = servers.get(IMCODES_MEMORY_MCP_SERVER_NAME);
      if (isSameDaemonServer(existingPrimary)) {
        return {
          serverName: IMCODES_MEMORY_MCP_SERVER_NAME,
          changed: false,
          degraded: false,
          safeToAllow: true,
        };
      }
      const existingConflict = servers.get(DAEMON_CONFLICT_SERVER_NAME);
      if (isSameDaemonServer(existingConflict)) {
        return {
          serverName: DAEMON_CONFLICT_SERVER_NAME,
          changed: false,
          degraded: false,
          safeToAllow: true,
        };
      }
      const serverName = existingPrimary ? DAEMON_CONFLICT_SERVER_NAME : IMCODES_MEMORY_MCP_SERVER_NAME;
      await run(qwenBinary, [
        'mcp',
        'add',
        serverName,
        IMCODES_MEMORY_MCP_COMMAND,
        ...IMCODES_MEMORY_MCP_ARGS,
      ], { windowsHide: true, timeout: 10_000 });
      const message = [
        `Added Qwen MCP server "${serverName}".`,
        `Remove it manually with qwen mcp remove ${serverName} if you no longer want it.`,
        'IM.codes never removes user MCP entries automatically.',
        'IM.codes supplies MCP identity through the daemon-spawned qwen process environment for each managed session.',
      ].join(' ');
      await writeNoticeOnce(options.noticeMarkerPath ?? NOTICE_MARKER, message);
      return {
        serverName,
        changed: true,
        degraded: false,
        safeToAllow: true,
      };
    });
  } catch (err) {
    logger.warn({ provider: 'qwen', err }, 'Qwen MCP auto-configuration failed; continuing without managed MCP registration');
    return {
      serverName: IMCODES_MEMORY_MCP_SERVER_NAME,
      changed: false,
      degraded: true,
      safeToAllow: false,
      reason: MEMORY_MCP_PROVIDER_STATUS_REASON.MCP_REGISTRATION_FAILED,
    };
  }
}
