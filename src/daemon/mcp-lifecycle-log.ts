import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Durable, cross-process record of IM.codes MCP stdio process lifecycle.
 *
 * The memory MCP bootstrap runs as a child of the agent CLI (Claude Code, the
 * Codex app-server, ...), so its stderr lands in THAT host's log -- for Codex, a
 * sampled SQLite store -- and never in daemon.log. When a host reported
 * "Transport closed", nothing on the IM.codes side recorded that the child had
 * exited, why, or who killed it. Every exit the bootstrap can observe, and
 * every process the daemon's resource registry signals, is appended here.
 *
 * Deliberately fs-only and synchronous: it is imported by the lightweight
 * bootstrap (which must not load the daemon graph) and is called from exit
 * paths, where an async write could be lost.
 */

export const MCP_LIFECYCLE_LOG_FILE = 'mcp-lifecycle.log';
const MAX_LOG_BYTES = 5 * 1024 * 1024;

export const MCP_LIFECYCLE_EVENT = {
  /** The bootstrap (the process the agent CLI holds the stdio pipe to) is exiting. */
  BOOTSTRAP_EXIT: 'bootstrap_exit',
  /** A stray exception inside the bootstrap; it keeps serving (not an exit). */
  BOOTSTRAP_FAULT: 'bootstrap_fault',
  /** The bootstrap's heavy backend exited; the bootstrap restarts it. */
  BACKEND_EXIT: 'backend_exit',
  /** The daemon's resource registry released (signalled) a registered process. */
  RESOURCE_RELEASED: 'resource_released',
} as const;

export type McpLifecycleEvent = typeof MCP_LIFECYCLE_EVENT[keyof typeof MCP_LIFECYCLE_EVENT];

/** Why a bootstrap exited; the stdio guard and signal handlers report these. */
export const MCP_BOOTSTRAP_EXIT_REASON = {
  STDIN_END: 'stdin_end',
  STDIN_CLOSE: 'stdin_close',
  PARENT_EXITED: 'parent_exited',
  DECLARED_PARENT_MISMATCH: 'declared_parent_mismatch',
  SIGTERM: 'SIGTERM',
  SIGINT: 'SIGINT',
  UNCAUGHT_EXCEPTION: 'uncaught_exception',
  UNHANDLED_REJECTION: 'unhandled_rejection',
} as const;

export type McpBootstrapExitReason = typeof MCP_BOOTSTRAP_EXIT_REASON[keyof typeof MCP_BOOTSTRAP_EXIT_REASON];

export function mcpLifecycleLogPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.IMCODES_HOME?.trim() || join(homedir(), '.imcodes'), 'logs', MCP_LIFECYCLE_LOG_FILE);
}

/** Append one JSON line. Never throws: logging must not change lifecycle behavior. */
export function appendMcpLifecycleEvent(
  event: McpLifecycleEvent,
  fields: Record<string, unknown>,
  path: string = mcpLifecycleLogPath(),
): void {
  try {
    mkdirSync(join(path, '..'), { recursive: true, mode: 0o700 });
    try {
      if (statSync(path).size >= MAX_LOG_BYTES) renameSync(path, `${path}.1`);
    } catch { /* absent or racing another writer: keep appending */ }
    appendFileSync(path, `${JSON.stringify({ time: new Date().toISOString(), event, pid: process.pid, ...fields })}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
  } catch { /* best-effort */ }
}
