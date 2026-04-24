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
import { readdirSync, statSync } from 'fs';
import type { FileChangeInfo } from 'fs/promises';
import { join, dirname, basename } from 'path';
import { homedir } from 'os';
import { timelineEmitter } from './timeline-emitter.js';
import logger from '../util/logger.js';
import { resolveContextWindow } from '../util/model-context.js';
import { getSessionContextWindow } from './cc-presets.js';
import { registerWatcherControl, unregisterWatcherControl, type WatcherControl } from './watcher-controls.js';
import {
  createParseContext,
  forgetSession as forgetSessionInCtx,
  parseLines as parseLinesInCtx,
  type EmitInstruction,
  type ParseContext,
  type ParseLineInput,
} from './jsonl-parse-core.js';
import { jsonlParsePool, isJsonlWorkerEnabled } from './jsonl-parse-pool.js';

// ── Path helpers ──────────────────────────────────────────────────────────────

/** Compute a filesystem-safe project key from an absolute path.
 *  Replaces / \ and : with '-'. Used by Claude Code and Codex watchers.
 *  Exported for reuse and testing. */
export function projectPathKey(absPath: string): string {
  return absPath.replace(/\/+$/, '').replace(/[/\\\\:]/g, '-');
}

// Keep old name as alias for internal use
const claudeProjectKey = projectPathKey;

/** Return the ~/.claude/projects/{key} directory for a given work dir. */
export function claudeProjectDir(workDir: string): string {
  const key = claudeProjectKey(workDir);
  return join(homedir(), '.claude', 'projects', key);
}

/**
 * Scan ~/.claude/projects/* for {sessionId}.jsonl.
 * UUID is globally unique so we don't need the project key to locate it.
 * Returns the real path if found, null otherwise.
 */
export function scanForJsonlBySessionId(sessionId: string): string | null {
  const projectsRoot = join(homedir(), '.claude', 'projects');
  const filename = `${sessionId}.jsonl`;
  let dirs: string[];
  try {
    dirs = readdirSync(projectsRoot);
  } catch {
    return null;
  }
  for (const d of dirs) {
    const candidate = join(projectsRoot, d, filename);
    try {
      statSync(candidate);
      return candidate;
    } catch { /* not here */ }
  }
  return null;
}

/**
 * Locate a Claude Code transcript file by session UUID.
 * First scans ~/.claude/projects/* (robust against project-key changes),
 * then falls back to the deterministic path for seed creation.
 */
export function findJsonlPathBySessionId(workDir: string, sessionId: string): string {
  return scanForJsonlBySessionId(sessionId) ?? join(claudeProjectDir(workDir), `${sessionId}.jsonl`);
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

  // Keep content minimal — CC reads CLAUDE.md on its own.
  // Complex content (with special chars from CLAUDE.md/memory) can crash CC's session picker.
  const content = `Restored/bootstrapped Claude Code session for project: ${cwd}`;
  // CC ≥2.1.88: --resume crashes if the JSONL key order or spacing differs from
  // CC's own output format. Line 1 (user) uses JSON.stringify (key order matches CC).
  // Lines 2+3 use hardcoded templates to guarantee byte-identical format.
  const { randomUUID } = await import('node:crypto');
  const ts = new Date(Date.now() - 3600_000).toISOString();
  const seedLine = JSON.stringify({
    type: 'user',
    message: { role: 'user', content },
    timestamp: ts,
    cwd,
    sessionId,
    version: '2.1.79',
  });
  const msgId = randomUUID();
  const escapedCwd = JSON.stringify(cwd).slice(1, -1);
  const data = [
    seedLine,
    `{"type":"file-history-snapshot","messageId":"${msgId}","snapshot":{"messageId":"${msgId}","trackedFileBackups":{},"timestamp":"${ts}"},"isSnapshotUpdate":false}`,
    `{"parentUuid":null,"isSidechain":false,"type":"assistant","uuid":"${randomUUID()}","timestamp":"${ts}","message":{"id":"${randomUUID()}","container":null,"model":"<synthetic>","role":"assistant","stop_reason":"stop_sequence","stop_sequence":"","type":"message","usage":{"input_tokens":0,"output_tokens":0,"cache_creation_input_tokens":0,"cache_read_input_tokens":0,"server_tool_use":{"web_search_requests":0,"web_fetch_requests":0},"service_tier":null,"cache_creation":{"ephemeral_1h_input_tokens":0,"ephemeral_5m_input_tokens":0},"inference_geo":null,"iterations":null,"speed":null},"content":[{"type":"text","text":"No response requested."}],"context_management":null},"isApiErrorMessage":false,"userType":"external","entrypoint":"cli","cwd":"${escapedCwd}","sessionId":"${sessionId}","version":"2.1.81","gitBranch":"master"}`,
  ].join('\n') + '\n';
  await writeFile(filePath, data, 'utf8');
  logger.info({ sessionId, filePath }, 'jsonl-watcher: created Claude seed transcript');
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
//
// The heavy parsing (JSON.parse + regex + block interpretation) lives in the
// pure `jsonl-parse-core` module so it can run either on the main thread or
// in the `jsonl-parse-worker` thread without diverging. The watcher itself
// only owns I/O and event dispatch.
//
// Strategy:
//   - Default: drained batches are parsed synchronously on main using
//     `mainParseCtx`. Code path identical to pre-worker behaviour.
//   - Opt-in `IM4CODES_JSONL_WORKER=1`: drained batches ship to the worker
//     pool; crash / timeout automatically falls back to the main-thread
//     context (same pure parser). Intended for deployments that observe
//     main-loop pressure from heavy Claude JSONL streams.
//
// `emitRecentHistory` (one-shot at session start) always runs on main using a
// throwaway context, because (a) it's infrequent and (b) we want to filter
// `usage.update` events and emit the snapshot at the end instead.

/** Main-thread fallback state (only used when worker disabled or failed). */
const mainParseCtx: ParseContext = createParseContext();

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
  /** CC session UUID — used to look up preset contextWindow for usage events. */
  ccSessionId?: string;
  /**
   * Waiting-for-file state. When `startWatchingFile` can't find the target
   * JSONL within its 120s fast-poll, it leaves a slow `setInterval` probe
   * running so that as soon as the user's first turn materialises the file,
   * the watcher activates. `stopWatching()` clears this timer.
   */
  pendingFilePath?: string;
  pendingProbeTimer?: ReturnType<typeof setInterval>;
}

const watchers = new Map<string, WatcherState>();

function watcherControl(sessionName: string): WatcherControl {
  return {
    refresh: () => refreshTrackedSession(sessionName),
  };
}

/**
 * Persistent ownership registry: maps JSONL file UUID (from filename) → watcher sessionName.
 * Unlike claimedFiles, this is NOT released on rotation — once a UUID is known to belong
 * to a watcher, it stays registered until that watcher is stopped.  This prevents a
 * sub-session from grabbing the main session's file even if the main session rotates
 * (which would release the old claim in a transient-claim model).
 */
const ownedFileIds = new Map<string, string>(); // fileUuid → sessionName

function fileUuid(filePath: string): string {
  return basename(filePath, '.jsonl');
}

/** Register a file UUID as belonging to a watcher (called on activate). */
function registerOwnership(sessionName: string, filePath: string): void {
  ownedFileIds.set(fileUuid(filePath), sessionName);
}

/** Returns true if the file's UUID is owned by a DIFFERENT watcher. */
function isOwnedByOther(sessionName: string, filePath: string): boolean {
  const owner = ownedFileIds.get(fileUuid(filePath));
  return !!owner && owner !== sessionName;
}

/** Release all owned UUIDs for a watcher (called on stop). */
function releaseOwnership(sessionName: string): void {
  for (const [uuid, name] of ownedFileIds) {
    if (name === sessionName) ownedFileIds.delete(uuid);
  }
}

/** Which session has claimed each JSONL file path (prevents cross-session stealing). */
const claimedFiles = new Map<string, string>(); // filePath → sessionName

/** Manually claim a file for a session (prevents directory scan from stealing it). */
export function preClaimFile(sessionName: string, filePath: string): void {
  // Release any previous file claimed by this session
  for (const [fp, sn] of claimedFiles) {
    if (sn === sessionName) { claimedFiles.delete(fp); break; }
  }
  claimedFiles.set(filePath, sessionName);
  registerOwnership(sessionName, filePath);
}

function releaseFiles(sessionName: string): void {
  for (const [fp, sn] of claimedFiles) {
    if (sn === sessionName) claimedFiles.delete(fp);
  }
}

/** Returns true if filePath is unclaimed or already claimed by sessionName. */
function canClaim(sessionName: string, filePath: string): boolean {
  const owner = claimedFiles.get(filePath);
  if (owner && owner !== sessionName) return false;
  // Also reject if the UUID is owned by another watcher (persistent check)
  return !isOwnedByOther(sessionName, filePath);
}

function isTrackedClaudeFile(state: WatcherState, filePath: string): boolean {
  if (state.ccSessionId) return fileUuid(filePath) === state.ccSessionId;
  return true;
}

// ── Public API ────────────────────────────────────────────────────────────────

const HISTORY_LINES = 500; // max lines to scan for recent assistant.text history

/**
 * Read the tail of a JSONL file and emit history events (text, thinking, tool.call, tool.result).
 */
export async function emitRecentHistory(sessionName: string, filePath: string): Promise<void> {
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
          const presetCtx = watchers.get(sessionName)?.ccSessionId ? getSessionContextWindow(watchers.get(sessionName)!.ccSessionId!) : undefined;
          lastUsagePayload = {
            inputTokens: usage.input_tokens + (usage.cache_creation_input_tokens ?? 0),
            cacheTokens: usage.cache_read_input_tokens ?? 0,
            contextWindow: resolveContextWindow(presetCtx, model),
            ...(model ? { model } : {}),
          };
        }
      }
    }

    // Collect all parseable history entries with their raw line strings so
    // we can replay them through the shared parse core. Only the LAST N are
    // replayed — we want the most recent history, not the oldest within the
    // 256KB tail chunk.
    interface HistoryEntry { lineBytePos: number; rawLine: string; }
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
      allEntries.push({ lineBytePos, rawLine: line });
    }

    // Take last HISTORY_LINES entries and replay them through the shared parse
    // core. A scratch ParseContext keeps history's tool-call correlation state
    // isolated from the live watcher — no leakage into subsequent drains.
    const recentEntries = allEntries.slice(-HISTORY_LINES);
    const historyCtx = createParseContext();
    const presetContextWindow = watchers.get(sessionName)?.ccSessionId
      ? getSessionContextWindow(watchers.get(sessionName)!.ccSessionId!)
      : undefined;
    const { emits } = parseLinesInCtx(historyCtx, {
      sessionName,
      items: recentEntries.map((e) => ({ line: e.rawLine, lineByteOffset: e.lineBytePos })),
      ...(presetContextWindow !== undefined ? { presetContextWindow } : {}),
    });
    // History handles the usage snapshot separately below — drop per-line
    // usage events so we don't spam the context bar during replay.
    for (const em of emits) {
      if (em.type === 'usage.update') continue;
      timelineEmitter.emit(em.sessionName, em.type, em.payload, em.metadata);
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
 * and start polling + fs.watch for new content from the current end of file.
 * Called by both startWatching (found via dir scan) and startWatchingFile (known path).
 */
async function activateFile(sessionName: string, state: WatcherState, filePath: string): Promise<void> {
  preClaimFile(sessionName, filePath);
  registerOwnership(sessionName, filePath);
  state.pendingPartialLine = '';
  try {
    const s = await stat(filePath);
    state.activeFile = filePath;
    state.fileOffset = s.size;
  } catch {
    state.activeFile = filePath;
    state.fileOffset = 0;
  }
}

export async function startWatching(sessionName: string, workDir: string, ccSessionId?: string): Promise<WatcherControl> {
  if (watchers.has(sessionName)) stopWatching(sessionName);

  const projectDir = claudeProjectDir(workDir);
  const state: WatcherState = {
    projectDir, activeFile: null, fileOffset: 0,
    abort: new AbortController(), stopped: false,
    pendingPartialLine: '', status: 'waiting_for_file',
    ccSessionId,
  };
  watchers.set(sessionName, state);
  const control = watcherControl(sessionName);
  registerWatcherControl(sessionName, control);

  if (!ccSessionId) {
    logger.warn({ session: sessionName }, 'jsonl-watcher: falling back to directory scan (no ccSessionId)');
  }

  // Bind to the known Claude session transcript when possible.
  const preferred = ccSessionId ? scanForJsonlBySessionId(ccSessionId) : await findLatestJsonl(projectDir);
  if (preferred && isTrackedClaudeFile(state, preferred) && canClaim(sessionName, preferred)) {
    await activateFile(sessionName, state, preferred);
    state.status = 'active';
  } else {
    state.status = 'degraded';
  }

  // Poll every 2s (uses pollTick so it can re-acquire a file if the claim changes).
  state.pollTimer = setInterval(() => { void pollTick(sessionName, state); }, 2000);
  void watchDir(sessionName, state);
  return control;
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
  // Clear the slow stat-probe that waits for a delayed JSONL file in the
  // pre-activation path. Left running, it would keep hitting `stat()` on
  // a path whose session has been torn down.
  if (state.pendingProbeTimer) clearInterval(state.pendingProbeTimer);
  watchers.delete(sessionName);
  unregisterWatcherControl(sessionName);
  releaseFiles(sessionName);
  releaseOwnership(sessionName);
  // Drop per-session pending tool-call state in both the main-thread fallback
  // context and the worker (best-effort; worker call is async and unawaited).
  forgetSessionInCtx(mainParseCtx, sessionName);
  void jsonlParsePool.forgetSession(sessionName);
}

/**
 * Start watching a specific JSONL file (CC sub-sessions with known --session-id path).
 * Pre-claims the path immediately so the main session's watchDir can't steal it,
 * then polls until the file appears, replays history, and tails new content.
 * Supports rotation to newer files (CC creates new JSONL on context overflow).
 */
export async function startWatchingFile(sessionName: string, filePath: string, ccSessionId?: string): Promise<WatcherControl> {
  if (watchers.has(sessionName)) stopWatching(sessionName);

  // Pre-claim before file exists so the main session watcher cannot steal it.
  preClaimFile(sessionName, filePath);

  const state: WatcherState = {
    projectDir: dirname(filePath), activeFile: null, fileOffset: 0,
    abort: new AbortController(), stopped: false,
    pendingPartialLine: '', status: 'waiting_for_file',
    ccSessionId,
  };
  watchers.set(sessionName, state);
  const control = watcherControl(sessionName);
  registerWatcherControl(sessionName, control);

  // Fast-poll the specific file for up to 120s (~1s interval). Matches the
  // common case where the file materialises within a minute or two of the
  // user starting the session.
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

  // If the file STILL isn't there after 120s, DO NOT clean up. CC only
  // creates the per-session JSONL on the first user turn, which can easily
  // be more than two minutes after the sub-session was restored from the
  // daemon's session store. The previous "clean up phantom watcher" branch
  // left the session permanently unwatched: Claude's assistant replies
  // landed on disk afterwards but nothing emitted them, so the chat UI
  // showed user messages with no response bubble.
  //
  // Instead, keep the watcher alive and switch to a slow stat-probe every
  // 10s. Activation happens as soon as the file appears (or the session is
  // stopped). The slow probe costs ~1 stat() per 10s — negligible.
  if (!appeared && !state.stopped) {
    logger.info(
      { sessionName, filePath },
      'jsonl-watcher: file not yet created after 120s fast-poll, switching to slow probe (kept alive)',
    );
    const started = Date.now();
    state.pendingFilePath = filePath;
    const slowProbe = setInterval(async () => {
      if (state.stopped) {
        clearInterval(slowProbe);
        return;
      }
      try {
        await stat(filePath);
      } catch {
        return;
      }
      clearInterval(slowProbe);
      if (state.stopped) return;
      logger.info(
        { sessionName, filePath, waitedMs: Date.now() - started },
        'jsonl-watcher: file appeared after slow probe, activating',
      );
      try {
        await activateFile(sessionName, state, filePath);
        state.status = 'active';
        startDrainPoll(sessionName, state);
        void watchFile(sessionName, state, filePath);
      } catch (err) {
        logger.warn({ sessionName, filePath, err }, 'jsonl-watcher: failed to activate file after slow probe');
      }
    }, 10_000);
    // Hand the timer to watcher state so stopWatching() can clear it.
    state.pendingProbeTimer = slowProbe;
    return control;
  }

  if (state.stopped) {
    // Session was explicitly stopped while we were waiting — clean exit.
    state.status = 'stopped';
    watchers.delete(sessionName);
    releaseFiles(sessionName);
    return control;
  }

  await activateFile(sessionName, state, filePath);
  state.status = 'active';
  startDrainPoll(sessionName, state);
  void watchFile(sessionName, state, filePath);
  return control;
}

/**
 * Start the standard drain + rotation-check poll loop for an active watcher.
 * Runs every 2s: drain new lines from the active file, and every 5th tick
 * (10s) scan the project dir for a newer JSONL that CC rotated into on
 * context overflow. fs.watch is the primary rotation trigger — this poll
 * is a fallback for platforms where fs.watch events are unreliable.
 *
 * Extracted so the slow-probe path in `startWatchingFile` can reuse the
 * identical startup sequence once the file finally appears, instead of
 * duplicating the body.
 */
function startDrainPoll(sessionName: string, state: WatcherState): void {
  if (state.pollTimer) return; // already running
  let pollCount = 0;
  state.pollTimer = setInterval(async () => {
    await drainNewLines(sessionName, state);
    pollCount++;
    if (pollCount % 5 === 0 && state.activeFile) {
      try {
        const latest = await findLatestJsonl(state.projectDir);
        if (latest && latest !== state.activeFile && isTrackedClaudeFile(state, latest) && canClaim(sessionName, latest)) {
          logger.info({ sessionName, oldFile: basename(state.activeFile), newFile: basename(latest) },
            'jsonl-watcher: newer file detected (poll fallback), switching (CC rotation)');
          await activateFile(sessionName, state, latest);
          state.status = 'active';
        }
      } catch { /* ignore */ }
    }
  }, 2000);
}

async function watchFile(sessionName: string, state: WatcherState, filePath: string): Promise<void> {
  try {
    const dir = dirname(filePath);
    const watcher = watch(dir, { persistent: false, signal: state.abort.signal });
    for await (const event of watcher as AsyncIterable<FileChangeInfo<string>>) {
      if (state.stopped) break;
      if (typeof event.filename !== 'string' || !event.filename.endsWith('.jsonl')) continue;

      const changedFile = join(dir, event.filename);

      if (changedFile === state.activeFile) {
        await drainNewLines(sessionName, state);
      } else if (isTrackedClaudeFile(state, changedFile) && canClaim(sessionName, changedFile)) {
        // A different JSONL file is being written — CC may have rotated (context overflow).
        // Only switch if the new file is actually newer to avoid grabbing another session's file
        // whose claim was momentarily released (matches watchDir's checkNewer guard).
        const isNewer = await checkNewer(changedFile, state.activeFile);
        if (isNewer || !state.activeFile) {
          logger.info({ sessionName, oldFile: basename(state.activeFile ?? ''), newFile: event.filename },
            'jsonl-watcher: new file detected via fs.watch, switching (CC rotation)');
          try {
            await activateFile(sessionName, state, changedFile);
            state.status = 'active';
          } catch {
            logger.warn({ sessionName, file: changedFile }, 'jsonl-watcher: failed to switch to newer file');
          }
        }
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
        if (!isTrackedClaudeFile(state, changedFile)) continue;
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
      const preferred = state.ccSessionId ? scanForJsonlBySessionId(state.ccSessionId) : null;
      if (preferred && isTrackedClaudeFile(state, preferred) && canClaim(sessionName, preferred)) {
        await activateFile(sessionName, state, preferred);
        state.status = 'active';
      } else if (!state.ccSessionId) {
        const entries = await readdir(state.projectDir);
        const jsonls = entries.filter((e) => e.endsWith('.jsonl'));
        const withStats = await Promise.all(
          jsonls.map(async (f) => {
            const fp = join(state.projectDir, f);
            if (!isTrackedClaudeFile(state, fp) || !canClaim(sessionName, fp)) return null;
            try { return { fp, mtime: (await stat(fp)).mtimeMs }; } catch { return null; }
          }),
        );
        const best = withStats
          .filter((x): x is { fp: string; mtime: number } => x !== null)
          .sort((a, b) => b.mtime - a.mtime)[0];
        if (best) {
          await activateFile(sessionName, state, best.fp);
          state.status = 'active';
        }
      }
    } catch { /* ignore */ }
    if (!state.activeFile) {
      state.fileOffset = 0;
      state.status = 'degraded';
    }
  }
  await drainNewLines(sessionName, state);
}

/**
 * Force the registered watcher to immediately run its normal scan/drain cycle for
 * this session. Uses the watcher's existing state and claim rules; does not guess
 * other files by project.
 */
export async function refreshTrackedSession(sessionName: string): Promise<boolean> {
  const state = watchers.get(sessionName);
  if (!state || state.stopped) return false;
  await pollTick(sessionName, state);
  return true;
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

    // Batch complete lines and route to worker (if enabled) or parse on main.
    const items: ParseLineInput[] = [];
    for (const line of lines) {
      if (state.stopped) break;
      items.push({ line, lineByteOffset });
      lineByteOffset += Buffer.byteLength(line, 'utf8') + 1; // +1 for \n
    }
    if (items.length === 0) return;

    const presetContextWindow = state.ccSessionId
      ? getSessionContextWindow(state.ccSessionId)
      : undefined;
    const request = {
      sessionName,
      items,
      ...(state.ccSessionId ? { ccSessionId: state.ccSessionId } : {}),
      ...(presetContextWindow !== undefined ? { presetContextWindow } : {}),
    };

    let emits: EmitInstruction[] | null = null;
    if (isJsonlWorkerEnabled() && jsonlParsePool.isAvailable()) {
      const result = await jsonlParsePool.parseLines(request);
      if (result) emits = result.emits;
    }
    if (!emits) {
      // Main-thread fallback: either worker disabled, unavailable, or returned null.
      emits = parseLinesInCtx(mainParseCtx, request).emits;
    }
    for (const em of emits) {
      timelineEmitter.emit(em.sessionName, em.type, em.payload, em.metadata);
    }
  } catch (err) {
    if (!state.stopped) {
      logger.debug({ sessionName, err }, 'jsonl-watcher: drain error');
    }
  } finally {
    if (fh) await fh.close().catch(() => { /* ignore */ });
  }
}
