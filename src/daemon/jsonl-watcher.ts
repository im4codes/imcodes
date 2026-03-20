/**
 * Watches Claude Code JSONL transcript files for structured events.
 *
 * Claude Code writes every conversation turn to:
 *   ~/.claude/projects/{projectKey}/{sessionId}.jsonl
 *
 * Each line is a JSON object with type "assistant", "user", "result", or "system".
 * This watcher tails the active JSONL file and emits structured timeline events —
 * far more reliable than parsing raw PTY terminal output.
 *
 * Integration:
 *   - startWatching(sessionName, projectDir) when a claude-code session starts
 *   - stopWatching(sessionName) when it stops
 */

import { watch, readdir, stat, open, mkdir, writeFile } from 'fs/promises';
import type { FileChangeInfo } from 'fs/promises';
import { join, dirname, basename } from 'path';
import { homedir } from 'os';
import { timelineEmitter } from './timeline-emitter.js';
import logger from '../util/logger.js';
import { resolveContextWindow } from '../util/model-context.js';
import { readProjectMemory } from './memory-inject.js';

// ── Path helpers ──────────────────────────────────────────────────────────────

/** Compute Claude Code project key: replace path separators with '-'. */
function claudeProjectKey(absPath: string): string {
  return absPath.replace(/\/+$/, '').replace(/[/\\]/g, '-');
}

/** Return the ~/.claude/projects/{key} directory for a given work dir. */
export function claudeProjectDir(workDir: string): string {
  const key = claudeProjectKey(workDir);
  return join(homedir(), '.claude', 'projects', key);
}

/** Deterministic path for a Claude Code transcript file by cwd + session UUID. */
export function findJsonlPathBySessionId(workDir: string, sessionId: string): string {
  return join(claudeProjectDir(workDir), `${sessionId}.jsonl`);
}

function buildSeedText(cwd: string, memory: string | null): string {
  if (memory?.trim()) {
    return [
      `Restored/bootstrapped Claude Code session for project: ${cwd}`,
      '',
      memory.trim(),
    ].join('\n');
  }
  return [
    `Restored/bootstrapped Claude Code session for project: ${cwd}`,
    '',
    'This is an automatically created seed transcript so the session can resume deterministically.',
  ].join('\n');
}

/**
 * Ensure a minimally valid Claude Code transcript file exists so `claude --resume <uuid>`
 * has a deterministic landing point even on a cold start.
 */
export async function ensureClaudeSessionFile(sessionId: string, cwd: string): Promise<string> {
  const filePath = findJsonlPathBySessionId(cwd, sessionId);
  try {
    await stat(filePath);
    return filePath;
  } catch { /* create below */ }

  const dir = dirname(filePath);
  await mkdir(dir, { recursive: true });

  const timestamp = new Date().toISOString();
  const memory = await readProjectMemory(cwd).catch(() => null);
  const seedLine = JSON.stringify({
    type: 'user',
    message: {
      role: 'user',
      content: buildSeedText(cwd, memory),
    },
    timestamp,
    cwd,
    sessionId,
    version: '2.1.79',
  });
  await writeFile(filePath, seedLine + '\n', 'utf8');
  logger.info({ sessionId, filePath, hasMemory: !!memory }, 'jsonl-watcher: created Claude seed transcript');
  return filePath;
}

/** Find the most recently modified .jsonl file in a directory. */
async function findLatestJsonl(dir: string): Promise<string | null> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return null;
  }
  const jsonls = entries.filter((e) => e.endsWith('.jsonl'));
  if (jsonls.length === 0) return null;

  const withStats = await Promise.all(
    jsonls.map(async (f) => {
      try {
        const s = await stat(join(dir, f));
        return { f, mtime: s.mtimeMs };
      } catch {
        return { f, mtime: 0 };
      }
    }),
  );
  withStats.sort((a, b) => b.mtime - a.mtime);
  return join(dir, withStats[0].f);
}

// ── JSONL parsing ─────────────────────────────────────────────────────────────

interface ContentBlock {
  type: string;
  id?: string;
  text?: string;
  thinking?: string;
  name?: string;
  input?: Record<string, unknown>;
  content?: unknown;
  is_error?: boolean;
}

/** Patterns for system-injected messages that should not display as user messages. */
const SYSTEM_INJECT_RE = /<task-notification>|<system-reminder>|<command-name>|<local-command-/;

function emitUserStringContent(
  sessionName: string,
  text: string,
  stableId?: (suffix: string) => string,
  ts?: number,
): void {
  if (!text.trim()) return;
  // System-injected messages: don't show as user message, emit working signal instead
  if (SYSTEM_INJECT_RE.test(text)) {
    timelineEmitter.emit(sessionName, 'agent.status', {
      status: 'processing',
      label: 'Processing system event...',
    }, { source: 'daemon', confidence: 'high' });
    return;
  }
  timelineEmitter.emit(sessionName, 'user.message', {
    text,
  }, { source: 'daemon', confidence: 'high', ...(stableId ? { eventId: stableId('um') } : {}), ...(ts ? { ts } : {}) });
}

function emitAssistantStringContent(
  sessionName: string,
  text: string,
  stableId?: (suffix: string) => string,
  ts?: number,
): void {
  if (!text.trim()) return;
  timelineEmitter.emit(sessionName, 'assistant.text', {
    text,
    streaming: false,
  }, { source: 'daemon', confidence: 'high', ...(stableId ? { eventId: stableId('at') } : {}), ...(ts ? { ts } : {}) });
}

/**
 * Parse one JSONL line and emit timeline events.
 * - assistant: emit assistant.text, assistant.thinking, tool.call
 * - user: emit user.message, tool.result
 *
 * lineByteOffset: byte offset of this line in the file — used to generate stable
 * eventIds so the same line always produces the same ID regardless of whether it
 * arrives via real-time streaming or history replay.
 */
function parseLine(sessionName: string, line: string, lineByteOffset?: number): void {
  if (!line.trim()) return;

  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return;
  }

  // Extract original event timestamp from JSONL (CC writes ISO timestamp on each entry).
  const lineTs = raw['timestamp'] ? new Date(raw['timestamp'] as string).getTime() : undefined;
  const ts = lineTs && isFinite(lineTs) ? lineTs : undefined;

  // Stable ID generator: same line always gets same eventId across restarts.
  let blockIdx = 0;
  const stableId = lineByteOffset !== undefined
    ? (suffix: string) => `cc:${sessionName}:${lineByteOffset}:${suffix}:${blockIdx++}`
    : undefined;

  // Progress events — transient status for status bar display (no message.content)
  if (raw['type'] === 'progress') {
    const data = raw['data'] as Record<string, unknown> | undefined;
    if (!data) return;
    const progressType = String(data['type'] ?? '');
    switch (progressType) {
      case 'bash_progress': {
        const elapsed = data['elapsedTimeSeconds'] as number | undefined;
        timelineEmitter.emit(sessionName, 'agent.status', {
          status: 'bash_running',
          label: `Bash running${elapsed ? ` (${Math.round(elapsed)}s)` : ''}...`,
        }, { source: 'daemon', confidence: 'high' });
        break;
      }
      case 'agent_progress': {
        const raw = data['message'];
        let msg = 'working';
        if (typeof raw === 'string') {
          msg = raw;
        } else if (raw && typeof raw === 'object') {
          const role = (raw as Record<string, unknown>).type ?? (raw as Record<string, unknown>).role ?? '';
          msg = String(role) || 'working';
        }
        timelineEmitter.emit(sessionName, 'agent.status', {
          status: 'agent_working',
          label: `Sub-agent: ${msg}`,
        }, { source: 'daemon', confidence: 'high' });
        break;
      }
      case 'mcp_progress': {
        const toolName = String(data['toolName'] ?? 'tool');
        const server = String(data['serverName'] ?? '');
        const mStatus = String(data['status'] ?? 'started');
        if (mStatus === 'started') {
          timelineEmitter.emit(sessionName, 'agent.status', {
            status: 'mcp_running',
            label: `MCP: ${server ? server + '/' : ''}${toolName}...`,
          }, { source: 'daemon', confidence: 'high' });
        }
        break;
      }
      case 'waiting_for_task': {
        const desc = String(data['taskDescription'] ?? 'task');
        timelineEmitter.emit(sessionName, 'agent.status', {
          status: 'waiting',
          label: `Waiting: ${desc}`,
        }, { source: 'daemon', confidence: 'high' });
        break;
      }
    }
    return;
  }

  // Result events — end-of-turn summary with total cost
  if (raw['type'] === 'result') {
    const costUsd = raw['total_cost_usd'] as number | undefined;
    if (typeof costUsd === 'number' && costUsd > 0) {
      timelineEmitter.emit(sessionName, 'usage.update', { costUsd },
        { source: 'daemon', confidence: 'high' });
    }
    return;
  }

  // System events — compact_boundary etc. (no message.content)
  if (raw['type'] === 'system') {
    const subtype = String(raw['subtype'] ?? '');
    if (subtype === 'compact_boundary') {
      timelineEmitter.emit(sessionName, 'agent.status', {
        status: 'compacting',
        label: 'Compacting conversation...',
      }, { source: 'daemon', confidence: 'high' });
    }
    return;
  }

  const msg = raw['message'] as Record<string, unknown> | undefined;
  if (!msg) return;
  const content = msg['content'];

  if (raw['type'] === 'assistant') {
    if (typeof content === 'string') {
      emitAssistantStringContent(sessionName, content, stableId, ts);
      return;
    }
    if (!Array.isArray(content)) return;
    for (const block of content as ContentBlock[]) {
      if (block.type === 'text' && block.text) {
        timelineEmitter.emit(sessionName, 'assistant.text', {
          text: block.text,
          streaming: false,
        }, { source: 'daemon', confidence: 'high', ...(stableId ? { eventId: stableId('at') } : {}), ...(ts ? { ts } : {}) });
      } else if (block.type === 'thinking') {
        timelineEmitter.emit(sessionName, 'assistant.thinking', {
          text: block.thinking,
        }, { source: 'daemon', confidence: 'high', ...(stableId ? { eventId: stableId('th') } : {}), ...(ts ? { ts } : {}) });
      } else if (block.type === 'tool_use' && block.name) {
        if (block.name === 'AskUserQuestion') {
          const inp = block.input as Record<string, unknown> | undefined;
          timelineEmitter.emit(sessionName, 'ask.question', {
            toolUseId: block.id,
            questions: inp?.['questions'] ?? [],
          }, { source: 'daemon', confidence: 'high', ...(stableId ? { eventId: stableId('aq') } : {}), ...(ts ? { ts } : {}) });
        } else {
          const input = extractToolInput(block.name, block.input);
          timelineEmitter.emit(sessionName, 'tool.call', {
            tool: block.name,
            ...(input ? { input } : {}),
          }, { source: 'daemon', confidence: 'high', ...(stableId ? { eventId: stableId('tc') } : {}), ...(ts ? { ts } : {}) });
        }
      }
    }
    // Emit token usage + model for context bar (transient, no stable ID needed)
    const usage = msg['usage'] as { input_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number } | undefined;
    const model = msg['model'] as string | undefined;
    if (usage && typeof usage.input_tokens === 'number') {
      timelineEmitter.emit(sessionName, 'usage.update', {
        inputTokens: usage.input_tokens + (usage.cache_creation_input_tokens ?? 0),
        cacheTokens: usage.cache_read_input_tokens ?? 0,
        contextWindow: resolveContextWindow(undefined, model),
        ...(model ? { model } : {}),
      }, { source: 'daemon', confidence: 'high' });
    }
    return;
  }

  if (raw['type'] === 'user') {
    if (typeof content === 'string') {
      emitUserStringContent(sessionName, content, stableId, ts);
      return;
    }
    if (!Array.isArray(content)) return;
    for (const block of content as ContentBlock[]) {
      if (block.type === 'text' && block.text?.trim()) {
        emitUserStringContent(sessionName, block.text, stableId, ts);
      } else if (block.type === 'tool_result') {
        const error = block.is_error ? String(block.content ?? 'error') : undefined;
        timelineEmitter.emit(sessionName, 'tool.result', {
          ...(error ? { error } : {}),
        }, { source: 'daemon', confidence: 'high', ...(stableId ? { eventId: stableId('tr') } : {}), ...(ts ? { ts } : {}) });
      }
    }
  }
}

/** Extract a short summary of tool input for display. */
function extractToolInput(tool: string, input?: Record<string, unknown>): string {
  if (!input) return '';
  switch (tool) {
    case 'Bash': return String(input['command'] ?? '').split('\n').find((l) => l.trim()) ?? '';
    case 'Read': case 'Write': case 'Edit': return String(input['file_path'] ?? '');
    case 'Glob': return String(input['pattern'] ?? '');
    case 'Grep': return `${input['pattern'] ?? ''}${input['path'] ? ` in ${input['path']}` : ''}`;
    case 'Agent': return String(input['description'] ?? '');
    default: return '';
  }
}

// ── Per-session watcher state ─────────────────────────────────────────────────

type WatcherStatus = 'waiting_for_file' | 'active' | 'degraded' | 'stopped';

interface WatcherState {
  projectDir: string;
  activeFile: string | null;
  fileOffset: number; // byte offset — only read lines written after watch start
  abort: AbortController;
  stopped: boolean;
  pollTimer?: ReturnType<typeof setInterval>;
  /** Partial line buffer — incomplete last line carried over between drainNewLines calls. */
  pendingPartialLine: string;
  /** Watcher health status — distinguishes registered-but-not-working from truly active. */
  status: WatcherStatus;
}

const watchers = new Map<string, WatcherState>();

/** Which session has claimed each JSONL file path (prevents cross-session stealing). */
const claimedFiles = new Map<string, string>(); // filePath → sessionName

/** Manually claim a file for a session (prevents directory scan from stealing it). */
export function preClaimFile(sessionName: string, filePath: string): void {
  // Release any previous file claimed by this session
  for (const [fp, sn] of claimedFiles) {
    if (sn === sessionName) { claimedFiles.delete(fp); break; }
  }
  claimedFiles.set(filePath, sessionName);
}

function releaseFiles(sessionName: string): void {
  for (const [fp, sn] of claimedFiles) {
    if (sn === sessionName) claimedFiles.delete(fp);
  }
}

/** Returns true if filePath is unclaimed or already claimed by sessionName. */
function canClaim(sessionName: string, filePath: string): boolean {
  const owner = claimedFiles.get(filePath);
  return !owner || owner === sessionName;
}

// ── Public API ────────────────────────────────────────────────────────────────

const HISTORY_LINES = 500; // max lines to scan for recent assistant.text history

/**
 * Read the tail of a JSONL file and emit history events (text, thinking, tool.call, tool.result).
 */
async function emitRecentHistory(sessionName: string, filePath: string): Promise<void> {
  let fh: Awaited<ReturnType<typeof open>> | null = null;
  try {
    fh = await open(filePath, 'r');
    const { size } = await fh.stat();
    if (size === 0) return;

    // Read up to 256KB from the end of the file to cover recent history
    const readSize = Math.min(size, 256 * 1024);
    const buf = Buffer.allocUnsafe(readSize);
    const { bytesRead } = await fh.read(buf, 0, readSize, size - readSize);
    if (bytesRead === 0) return;

    const chunk = buf.subarray(0, bytesRead).toString('utf8');
    // Drop the first (possibly partial) line when reading mid-file
    const lines = chunk.split('\n');
    const startIdx = size > readSize ? 1 : 0; // skip partial first line

    // First pass: find the most recent usage data (scan all lines, not limited to HISTORY_LINES)
    let lastUsagePayload: Record<string, unknown> | null = null;
    for (let i = startIdx; i < lines.length; i++) {
      const line = lines[i];
      if (!line.trim()) continue;
      let raw: Record<string, unknown>;
      try { raw = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
      if (raw['type'] === 'assistant') {
        const msg = raw['message'] as Record<string, unknown> | undefined;
        const usage = msg?.['usage'] as { input_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number } | undefined;
        const model = msg?.['model'] as string | undefined;
        if (usage && typeof usage.input_tokens === 'number') {
          lastUsagePayload = {
            inputTokens: usage.input_tokens + (usage.cache_creation_input_tokens ?? 0),
            cacheTokens: usage.cache_read_input_tokens ?? 0,
            contextWindow: resolveContextWindow(undefined, model),
            ...(model ? { model } : {}),
          };
        }
      }
    }

    // Collect all parseable events first, then take the LAST N — not first N.
    // This ensures the most recent history is always returned, not the oldest
    // within the 256KB tail chunk.
    interface HistoryEntry { lineBytePos: number; raw: Record<string, unknown>; }
    const allEntries: HistoryEntry[] = [];

    let bytePos = size - readSize;
    for (let i = 0; i < startIdx; i++) {
      bytePos += Buffer.byteLength(lines[i], 'utf8') + 1;
    }

    for (let i = startIdx; i < lines.length; i++) {
      const lineBytePos = bytePos;
      bytePos += Buffer.byteLength(lines[i], 'utf8') + 1;

      const line = lines[i];
      if (!line.trim()) continue;
      let raw: Record<string, unknown>;
      try { raw = JSON.parse(line) as Record<string, unknown>; } catch { continue; }

      const msg = raw['message'] as Record<string, unknown> | undefined;
      const content = msg?.['content'];
      if (!(Array.isArray(content) || typeof content === 'string')) continue;
      allEntries.push({ lineBytePos, raw });
    }

    // Take last HISTORY_LINES entries
    const recentEntries = allEntries.slice(-HISTORY_LINES);

    for (const { lineBytePos, raw } of recentEntries) {
      let blockIdx = 0;
      const stableId = (suffix: string) => `cc:${sessionName}:${lineBytePos}:${suffix}:${blockIdx++}`;

      if (raw['type'] === 'assistant') {
        const msg = raw['message'] as Record<string, unknown> | undefined;
        const content = msg?.['content'] as ContentBlock[] | string;
        if (typeof content === 'string') {
          emitAssistantStringContent(sessionName, content, stableId);
          continue;
        }
        for (const block of content) {
          if (block.type === 'text' && block.text) {
            timelineEmitter.emit(sessionName, 'assistant.text', {
              text: block.text, streaming: false,
            }, { source: 'daemon', confidence: 'high', eventId: stableId('at') });
          } else if (block.type === 'thinking') {
            timelineEmitter.emit(sessionName, 'assistant.thinking', {
              text: block.thinking,
            }, { source: 'daemon', confidence: 'high', eventId: stableId('th') });
          } else if (block.type === 'tool_use' && block.name) {
            const input = extractToolInput(block.name, block.input);
            timelineEmitter.emit(sessionName, 'tool.call', {
              tool: block.name, ...(input ? { input } : {}),
            }, { source: 'daemon', confidence: 'high', eventId: stableId('tc') });
          }
        }
      } else if (raw['type'] === 'user') {
        const msg = raw['message'] as Record<string, unknown> | undefined;
        const content = msg?.['content'] as ContentBlock[] | string;
        if (typeof content === 'string') {
          emitUserStringContent(sessionName, content, stableId);
          continue;
        }
        for (const block of content) {
          if (block.type === 'text' && block.text?.trim()) {
            emitUserStringContent(sessionName, block.text, stableId);
          } else if (block.type === 'tool_result') {
            const error = block.is_error ? String(block.content ?? 'error') : undefined;
            timelineEmitter.emit(sessionName, 'tool.result', {
              ...(error ? { error } : {}),
            }, { source: 'daemon', confidence: 'high', eventId: stableId('tr') });
          }
        }
      }
    }

    // Emit the most recent usage snapshot so the context bar populates on load
    if (lastUsagePayload) {
      timelineEmitter.emit(sessionName, 'usage.update', lastUsagePayload,
        { source: 'daemon', confidence: 'high' });
    }
  } catch {
    // best-effort
  } finally {
    if (fh) await fh.close().catch(() => { /* ignore */ });
  }
}

/**
 * Start watching Claude Code's JSONL transcript for a session.
 * Only new lines written after this call are emitted — no history replay.
 *
 * @param sessionName  tmux session name (e.g. "deck_myapp_brain")
 * @param workDir      absolute path to the project working directory
 */
/**
 * Shared: once a specific JSONL file is confirmed to exist, claim it,
 * replay recent history, and start polling + fs.watch for new content.
 * Called by both startWatching (found via dir scan) and startWatchingFile (known path).
 */
async function activateFile(sessionName: string, state: WatcherState, filePath: string): Promise<void> {
  preClaimFile(sessionName, filePath);
  state.pendingPartialLine = '';
  try {
    const s = await stat(filePath);
    state.activeFile = filePath;
    state.fileOffset = s.size;
  } catch {
    state.activeFile = filePath;
    state.fileOffset = 0;
  }
  await emitRecentHistory(sessionName, filePath);
}

export async function startWatching(sessionName: string, workDir: string): Promise<void> {
  if (watchers.has(sessionName)) stopWatching(sessionName);

  const projectDir = claudeProjectDir(workDir);
  const state: WatcherState = {
    projectDir, activeFile: null, fileOffset: 0,
    abort: new AbortController(), stopped: false,
    pendingPartialLine: '', status: 'waiting_for_file',
  };
  watchers.set(sessionName, state);

  logger.warn({ session: sessionName }, 'jsonl-watcher: falling back to directory scan (no ccSessionId)');

  // Find the current active JSONL file; only claim an unclaimed one.
  const latest = await findLatestJsonl(projectDir);
  if (latest && canClaim(sessionName, latest)) {
    await activateFile(sessionName, state, latest);
    state.status = 'active';
  } else {
    state.status = 'degraded';
  }

  // Poll every 2s (uses pollTick so it can re-acquire a file if the claim changes).
  state.pollTimer = setInterval(() => { void pollTick(sessionName, state); }, 2000);
  void watchDir(sessionName, state);
}

/** Returns true if a JSONL watcher is registered for this session. */
export function isWatching(sessionName: string): boolean {
  return watchers.has(sessionName);
}

/** Returns the watcher's health status, or null if no watcher exists. */
export function watcherStatus(sessionName: string): WatcherStatus | null {
  return watchers.get(sessionName)?.status ?? null;
}

/** Stop watching and release all file handles for a session. */
export function stopWatching(sessionName: string): void {
  const state = watchers.get(sessionName);
  if (!state) return;
  state.stopped = true;
  state.status = 'stopped';
  state.abort.abort();
  if (state.pollTimer) clearInterval(state.pollTimer);
  watchers.delete(sessionName);
  releaseFiles(sessionName);
}

/**
 * Start watching a specific JSONL file (CC sub-sessions with known --session-id path).
 * Pre-claims the path immediately so the main session's watchDir can't steal it,
 * then polls until the file appears, replays history, and tails new content.
 */
export async function startWatchingFile(sessionName: string, filePath: string): Promise<void> {
  if (watchers.has(sessionName)) stopWatching(sessionName);

  // Pre-claim before file exists so the main session watcher cannot steal it.
  preClaimFile(sessionName, filePath);

  const state: WatcherState = {
    projectDir: dirname(filePath), activeFile: null, fileOffset: 0,
    abort: new AbortController(), stopped: false,
    pendingPartialLine: '', status: 'waiting_for_file',
  };
  watchers.set(sessionName, state);

  // Poll until the specific file appears (up to 120s — CC needs first conversation).
  let appeared = false;
  for (let i = 0; i < 120 && !state.stopped; i++) {
    try {
      await stat(filePath);
      appeared = true;
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  if (!appeared || state.stopped) {
    // Timeout or stopped — clean up to avoid phantom watcher
    logger.warn({ sessionName, filePath }, 'jsonl-watcher: file never appeared, cleaning up phantom watcher');
    state.stopped = true;
    state.status = 'stopped';
    watchers.delete(sessionName);
    releaseFiles(sessionName);
    return;
  }

  await activateFile(sessionName, state, filePath);
  state.status = 'active';

  // startWatchingFile watches a SPECIFIC file — no rotation logic.
  // If CC restarts, a new sub-session watcher will be created.
  state.pollTimer = setInterval(() => { void drainNewLines(sessionName, state); }, 2000);
  void watchFile(sessionName, state, filePath);
}

async function watchFile(sessionName: string, state: WatcherState, filePath: string): Promise<void> {
  try {
    const dir = dirname(filePath);
    const watcher = watch(dir, { persistent: false, signal: state.abort.signal });
    for await (const event of watcher as AsyncIterable<FileChangeInfo<string>>) {
      if (state.stopped) break;
      if (typeof event.filename !== 'string' || !event.filename.endsWith('.jsonl')) continue;

      const changedFile = join(dir, event.filename);

      // startWatchingFile watches a SPECIFIC file — only drain our own file, ignore others.
      if (changedFile === state.activeFile) {
        await drainNewLines(sessionName, state);
      }
    }
  } catch (err) {
    if (!state.stopped) {
      logger.warn({ sessionName, err }, 'jsonl-watcher: file watch error');
    }
  }
}

// ── Internal watcher logic ────────────────────────────────────────────────────

async function watchDir(sessionName: string, state: WatcherState): Promise<void> {
  // Ensure the directory exists (Claude Code may not have created it yet)
  try {
    await stat(state.projectDir);
  } catch {
    // Dir doesn't exist yet — poll until it appears, up to 60s
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      if (state.stopped) return;
      try {
        await stat(state.projectDir);
        break;
      } catch {
        // keep waiting
      }
    }
    if (state.stopped) return;
  }

  try {
    const watcher = watch(state.projectDir, { persistent: false, signal: state.abort.signal });
    for await (const event of watcher as AsyncIterable<FileChangeInfo<string>>) {
      if (state.stopped) break;
      if (typeof event.filename !== 'string' || !event.filename.endsWith('.jsonl')) continue;

      const changedFile = join(state.projectDir, event.filename);

      // If a new file appeared that is newer than our active file, switch to it.
      // Skip if another session has already claimed it.
      if (changedFile !== state.activeFile) {
        if (!canClaim(sessionName, changedFile)) continue; // claimed by another session
        const isNewer = await checkNewer(changedFile, state.activeFile);
        if (isNewer || !state.activeFile) {
          logger.debug({ sessionName, file: event.filename }, 'jsonl-watcher: switching to new JSONL file');
          // Use activateFile for consistent claim/history-replay/offset init
          state.pendingPartialLine = '';
          await activateFile(sessionName, state, changedFile);
          state.status = 'active';
        } else {
          continue; // older file, ignore
        }
      }

      await drainNewLines(sessionName, state);
    }
  } catch (err) {
    if (!state.stopped) {
      logger.warn({ sessionName, err }, 'jsonl-watcher: dir watch error');
    }
  }
}

/** Returns true if candidate is newer than current (or current is null). */
async function checkNewer(candidate: string, current: string | null): Promise<boolean> {
  if (!current) return true;
  try {
    const [cs, curS] = await Promise.all([stat(candidate), stat(current)]);
    return cs.mtimeMs > curS.mtimeMs;
  } catch {
    return false;
  }
}

/**
 * Poll tick for startWatching — drains new lines and re-acquires a file if activeFile was released.
 * Separate from drainNewLines so startWatchingFile's poll timer stays simple.
 */
async function pollTick(sessionName: string, state: WatcherState): Promise<void> {
  // If active file was stolen by another session, try to find a claimable replacement
  if (!state.activeFile) {
    try {
      const entries = await readdir(state.projectDir);
      const jsonls = entries.filter((e) => e.endsWith('.jsonl'));
      const withStats = await Promise.all(
        jsonls.map(async (f) => {
          const fp = join(state.projectDir, f);
          if (!canClaim(sessionName, fp)) return null;
          try { return { fp, mtime: (await stat(fp)).mtimeMs }; } catch { return null; }
        }),
      );
      const best = withStats
        .filter((x): x is { fp: string; mtime: number } => x !== null)
        .sort((a, b) => b.mtime - a.mtime)[0];
      if (best) {
        try {
          await activateFile(sessionName, state, best.fp);
          state.status = 'active';
        } catch {
          state.activeFile = null;
          state.fileOffset = 0;
          state.status = 'degraded';
        }
      }
    } catch { /* ignore */ }
  }
  await drainNewLines(sessionName, state);
}

/** Read any new lines from the active JSONL file since the last offset. */
async function drainNewLines(sessionName: string, state: WatcherState): Promise<void> {
  if (!state.activeFile) return;

  // If another session has claimed our active file, release it so we can re-acquire our own
  if (!canClaim(sessionName, state.activeFile)) {
    state.activeFile = null;
    return;
  }

  let fh: Awaited<ReturnType<typeof open>> | null = null;
  try {
    fh = await open(state.activeFile, 'r');
    const fileStat = await fh.stat();
    if (fileStat.size <= state.fileOffset) return;

    const buf = Buffer.allocUnsafe(fileStat.size - state.fileOffset);
    const { bytesRead } = await fh.read(buf, 0, buf.length, state.fileOffset);
    if (bytesRead === 0) return;

    const chunkStartOffset = state.fileOffset;
    // Always advance fileOffset by what we read — pending partial is held in memory,
    // not re-read from the file.
    state.fileOffset += bytesRead;

    const chunk = buf.subarray(0, bytesRead).toString('utf8');
    // Prepend any partial line carried over from the previous drain
    const fullChunk = state.pendingPartialLine + chunk;
    const lines = fullChunk.split('\n');

    // The last element is either '' (if chunk ended with \n) or an incomplete line.
    // Only process complete lines; carry the rest over.
    state.pendingPartialLine = lines.pop()!;

    // Calculate byte offset for stable eventId generation.
    // The first line spans from where the previous pending partial began in the file.
    // pendingPartialLine bytes were already read in a prior drain, so we subtract them.
    const prevPendingByteLen = Buffer.byteLength(fullChunk.slice(0, fullChunk.length - chunk.length), 'utf8');
    let lineByteOffset = chunkStartOffset - prevPendingByteLen;

    for (const line of lines) {
      if (state.stopped) break;
      parseLine(sessionName, line, lineByteOffset);
      lineByteOffset += Buffer.byteLength(line, 'utf8') + 1; // +1 for \n
    }
  } catch (err) {
    if (!state.stopped) {
      logger.debug({ sessionName, err }, 'jsonl-watcher: drain error');
    }
  } finally {
    if (fh) await fh.close().catch(() => { /* ignore */ });
  }
}
