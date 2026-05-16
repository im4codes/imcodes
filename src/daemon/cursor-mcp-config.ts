import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import logger from '../util/logger.js';
import { IMCODES_MEMORY_MCP_ARGS, IMCODES_MEMORY_MCP_COMMAND } from '../agent/providers/getDefaultMcpServers.js';
import { IMCODES_MEMORY_MCP_SERVER_NAME } from '../../shared/memory-mcp-server-name.js';

const DAEMON_CONFLICT_SERVER_NAME = `${IMCODES_MEMORY_MCP_SERVER_NAME}-daemon`;
const NOTICE_MARKER = join(homedir(), '.imcodes', 'cursor-mcp-notice-shown');

export interface CursorMcpEnsureOptions {
  configPath?: string;
  noticeMarkerPath?: string;
  skipTestDefaultPath?: boolean;
}

export interface CursorMcpEnsureResult {
  serverName: string;
  configPath: string;
  backupPath?: string;
  changed: boolean;
  degraded: boolean;
  reason?: string;
}

function defaultConfigPath(): string {
  return join(homedir(), '.cursor', 'mcp.json');
}

function daemonEntry(): Record<string, unknown> {
  return {
    command: IMCODES_MEMORY_MCP_COMMAND,
    args: [...IMCODES_MEMORY_MCP_ARGS],
  };
}

function isSameDaemonEntry(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return record.command === IMCODES_MEMORY_MCP_COMMAND
    && Array.isArray(record.args)
    && record.args.length === IMCODES_MEMORY_MCP_ARGS.length
    && record.args.every((arg, index) => arg === IMCODES_MEMORY_MCP_ARGS[index]);
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
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      await mkdir(lockPath);
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
  throw new Error(`timed out waiting for lock ${lockPath}`);
}

async function writeNoticeOnce(markerPath: string, message: string): Promise<void> {
  if (await pathExists(markerPath)) return;
  await mkdir(dirname(markerPath), { recursive: true });
  await writeFile(markerPath, `${new Date().toISOString()}\n${message}\n`, 'utf8');
  logger.warn({ message }, 'Cursor MCP auto-configuration notice');
}

export async function ensureCursorMcpJsonHasImcodesEntry(options: CursorMcpEnsureOptions = {}): Promise<CursorMcpEnsureResult> {
  const configPath = options.configPath ?? defaultConfigPath();
  if (!options.configPath && options.skipTestDefaultPath !== false && process.env.VITEST === 'true') {
    return {
      serverName: IMCODES_MEMORY_MCP_SERVER_NAME,
      configPath,
      changed: false,
      degraded: true,
      reason: 'cursor_mcp_autoconfig_skipped_under_test',
    };
  }
  const lockPath = `${configPath}.lock`;
  return withLock(lockPath, async () => {
    await mkdir(dirname(configPath), { recursive: true });
    let parsed: Record<string, unknown> = {};
    let raw = '';
    try {
      raw = await readFile(configPath, 'utf8');
      parsed = raw.trim() ? JSON.parse(raw) as Record<string, unknown> : {};
    } catch (err: any) {
      if (err?.code !== 'ENOENT') throw err;
    }
    const mcpServers = parsed.mcpServers && typeof parsed.mcpServers === 'object' && !Array.isArray(parsed.mcpServers)
      ? { ...(parsed.mcpServers as Record<string, unknown>) }
      : {};
    if (isSameDaemonEntry(mcpServers[IMCODES_MEMORY_MCP_SERVER_NAME]) || isSameDaemonEntry(mcpServers[DAEMON_CONFLICT_SERVER_NAME])) {
      return {
        serverName: isSameDaemonEntry(mcpServers[IMCODES_MEMORY_MCP_SERVER_NAME]) ? IMCODES_MEMORY_MCP_SERVER_NAME : DAEMON_CONFLICT_SERVER_NAME,
        configPath,
        changed: false,
        degraded: false,
      };
    }

    const serverName = mcpServers[IMCODES_MEMORY_MCP_SERVER_NAME] === undefined
      ? IMCODES_MEMORY_MCP_SERVER_NAME
      : DAEMON_CONFLICT_SERVER_NAME;
    const backupPath = raw
      ? `${configPath}.imcodes-backup-${Date.now()}`
      : undefined;
    if (backupPath) {
      await writeFile(backupPath, raw, 'utf8');
    }
    const next = {
      ...parsed,
      mcpServers: {
        ...mcpServers,
        [serverName]: daemonEntry(),
      },
    };
    const tmpPath = `${configPath}.tmp-${process.pid}-${Date.now()}`;
    await writeFile(tmpPath, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
    await rename(tmpPath, configPath);
    const message = [
      `Added Cursor MCP entry "${serverName}" to ${configPath}.`,
      `Remove it by deleting mcpServers.${serverName} from that file.`,
      backupPath ? `Restore the previous file from ${backupPath}.` : 'No previous file existed, so no backup was needed.',
      'IM.codes supplies MCP identity through the daemon-spawned cursor-agent process environment for each managed session.',
    ].join(' ');
    await writeNoticeOnce(options.noticeMarkerPath ?? NOTICE_MARKER, message);
    return {
      serverName,
      configPath,
      backupPath,
      changed: true,
      degraded: false,
    };
  });
}
