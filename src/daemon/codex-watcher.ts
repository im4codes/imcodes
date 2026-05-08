/**
 * Watches Codex JSONL rollout files for structured events.
 */

import { watch, readdir, stat, open, mkdir, writeFile } from 'fs/promises';
import { join, basename } from 'path';
import { homedir } from 'os';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
const execAsync = promisify(exec);
import { timelineEmitter } from './timeline-emitter.js';
import { buildSessionBootstrapContext, buildCodexMemoryEntry, readProcessedMemoryItems } from './memory-inject.js';
import { legacyInjectionDisabled } from '../context/shared-context-flags.js';
import logger from '../util/logger.js';
import { buildMemoryContextTimelinePayload } from './memory-context-timeline.js';
import { updateSessionState } from '../store/session-store.js';
import { resolveContextWindow } from '../util/model-context.js';
import { registerWatcherControl, unregisterWatcherControl, type WatcherControl } from './watcher-controls.js';
import { TIMELINE_SUPPRESS_PUSH_FIELD } from '../../shared/push-notifications.js';
import { USAGE_CONTEXT_WINDOW_SOURCES } from '../../shared/usage-context-window.js';

// ── Codex SQLite helpers ────────────────────────────────────────────────────────

/** Find the Codex state SQLite path (state_N.sqlite, take the highest N). */
async function findCodexStateSqlite(): Promise<string | null> {
  const codexDir = join(homedir(), '.codex');
  let entries: string[];
  try { entries = await readdir(codexDir); } catch { return null; }
  const matches = entries.filter((e) => /^state_\d+\.sqlite$/.test(e)).sort();
  if (!matches.length) return null;
  return join(codexDir, matches[matches.length - 1]);
}

/** Upsert a row into Codex's `threads` SQLite table so `codex resume` can find it. */
async function upsertCodexThread(uuid: string, cwd: string, rolloutPath: string, cliVersion: string): Promise<void> {
  const dbPath = await findCodexStateSqlite();
  if (!dbPath) {
    logger.warn({ uuid }, 'codex-watcher: state SQLite not found, skipping thread upsert');
    return;
  }
  const now = Math.floor(Date.now() / 1000);
  // Escape single quotes in values
  const esc = (s: string) => s.replace(/'/g, "''");
  const sql = [
    `INSERT INTO threads (id, rollout_path, created_at, updated_at, source, model_provider, cwd, title, sandbox_policy, approval_mode, tokens_used, has_user_event, archived, cli_version)`,
    `VALUES ('${esc(uuid)}', '${esc(rolloutPath)}', ${now}, ${now}, 'cli', 'openai', '${esc(cwd)}', '', '{"type":"danger-full-access"}', 'on-request', 0, 0, 0, '${esc(cliVersion)}')`,
    `ON CONFLICT(id) DO UPDATE SET`,
    `  cwd = '${esc(cwd)}', model_provider = 'openai', source = 'cli',`,
    `  rollout_path = '${esc(rolloutPath)}', updated_at = ${now}, cli_version = '${esc(cliVersion)}';`,
  ].join(' ');
  await execAsync(`sqlite3 ${JSON.stringify(dbPath)} ${JSON.stringify(sql)}`);
  logger.info({ uuid, cwd }, 'codex-watcher: upserted thread into SQLite');
}

/** Get the installed codex CLI version (cached). */
let _codexVersion: string | null = null;
async function getCodexVersion(): Promise<string> {
  if (_codexVersion) return _codexVersion;
  try {
    const { stdout } = await execAsync('codex --version');
    _codexVersion = stdout.trim().replace(/^codex-cli\s+/, '');
  } catch {
    _codexVersion = '0.113.0';
  }
  return _codexVersion;
}

// ── Path helpers ───────────────────────────────────────────────────────────────

function codexSessionDir(d: Date): string {
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return join(homedir(), '.codex', 'sessions', String(yyyy), mm, dd);
}

function recentSessionDirs(): string[] {
  const dirs: string[] = [];
  for (let i = 0; i < 30; i++) {
    const d = new Date(Date.now() - i * 86_400_000);
    dirs.push(codexSessionDir(d));
  }
  return dirs;
}

// ── JSONL matching ─────────────────────────────────────────────────────────────

export async function readCwd(filePath: string): Promise<string | null> {
  let fh: Awaited<ReturnType<typeof open>> | null = null;
  try {
    fh = await open(filePath, 'r');
    const buf = Buffer.allocUnsafe(4096);
    const { bytesRead } = await fh.read(buf, 0, 4096, 0);
    if (bytesRead === 0) return null;
    const snippet = buf.subarray(0, bytesRead).toString('utf8');
    if (!snippet.includes('"session_meta"')) return null;
    const m = /"cwd"\s*:\s*"([^"]+)"/.exec(snippet);
    return m ? m[1] : null;
  } catch {
    return null;
  } finally {
    if (fh) await fh.close().catch(() => {});
  }
}

async function findLatestRollout(
  dir: string,
  workDir: string,
  excludeClaimed = true,
  sessionName?: string,
  requiredUuid?: string | null,
): Promise<string | null> {
  let entries: string[];
  try { entries = await readdir(dir); } catch { return null; }

  let latestPath: string | null = null;
  let latestMtime = -1;

  for (const name of entries) {
    if (!name.startsWith('rollout-') || !name.endsWith('.jsonl')) continue;
    const fpath = join(dir, name);
    if (excludeClaimed) {
      const owner = claimedFiles.get(fpath);
      if (owner && owner !== 'UNKNOWN') continue;
    }
    if (sessionName && isFileClaimedByOther(sessionName, fpath)) continue;
    if (requiredUuid) {
      const candidateUuid = extractUuidFromPath(fpath);
      if (candidateUuid !== requiredUuid) continue;
    }
    const cwd = await readCwd(fpath);
    if (!cwd || normalizePath(cwd) !== normalizePath(workDir)) continue;
    try {
      const s = await stat(fpath);
      if (s.mtimeMs > latestMtime) {
        latestMtime = s.mtimeMs;
        latestPath = fpath;
      }
    } catch {
      continue;
    }
  }
  return latestPath;
}

async function findLatestMatchingRollout(sessionName: string, projectDir: string, currentUuid: string | null, currentPath: string | null): Promise<string | null> {
  let latestPath: string | null = null;
  let latestMtime = -1;
  for (const dir of recentSessionDirs()) {
    const found = await findLatestRollout(dir, projectDir, false, sessionName, currentUuid);
    if (!found || found === currentPath) continue;
    try {
      const s = await stat(found);
      if (s.mtimeMs > latestMtime) {
        latestMtime = s.mtimeMs;
        latestPath = found;
      }
    } catch {}
  }
  return latestPath;
}

function normalizePath(p: string): string {
  const normalized = p
    .replace(/\\/g, '/')
    .replace(/\/+$/, '');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

// ── JSONL parsing ──────────────────────────────────────────────────────────────

const finalAnswerBuffers = new Map<string, { text: string; timer: ReturnType<typeof setTimeout> }>();
const sessionStates = new Map<string, 'running' | 'idle'>();
const historyReplaySessions = new Set<string>();
const FINAL_ANSWER_DEBOUNCE_MS = 600;

function flushFinalAnswer(sessionName: string): void {
  const buf = finalAnswerBuffers.get(sessionName);
  if (!buf) return;
  finalAnswerBuffers.delete(sessionName);
  const watcher = watchers.get(sessionName);
  if (watcher) watcher.turnHadAssistantText = true;
  timelineEmitter.emit(sessionName, 'assistant.text', { text: buf.text, streaming: false }, { source: 'daemon', confidence: 'high' });
}

function emitSessionState(sessionName: string, state: 'running' | 'idle'): void {
  const prev = sessionStates.get(sessionName);
  if (prev === state) return;
  sessionStates.set(sessionName, state);
  if (state === 'running' && prev !== 'running') {
    const watcher = watchers.get(sessionName);
    if (watcher) {
      watcher.turnHadAssistantText = false;
      watcher.noTextRetrackAttempted = false;
    }
  }
  timelineEmitter.emit(sessionName, 'session.state', {
    state,
    ...(historyReplaySessions.has(sessionName) ? { [TIMELINE_SUPPRESS_PUSH_FIELD]: true } : {}),
  }, { source: 'daemon', confidence: 'high' });
  updateSessionState(sessionName, state);
}

export function resetParseStateForTests(): void {
  for (const { timer } of finalAnswerBuffers.values()) clearTimeout(timer);
  finalAnswerBuffers.clear();
  sessionStates.clear();
}

export function parseLine(sessionName: string, line: string, model?: string): void {
  if (!line.trim()) return;
  let raw: any;
  try { raw = JSON.parse(line); } catch { return; }

  // Extract original timestamp from JSONL entry (Codex writes ISO timestamp on each line)
  const lineTs = raw.timestamp ? new Date(raw.timestamp).getTime() : undefined;
  const ts = lineTs && isFinite(lineTs) ? lineTs : undefined;

  if (raw.type === 'response_item') {
    const pl = raw.payload;
    if (!pl) return;
    if (pl.type === 'function_call') {
      emitSessionState(sessionName, 'running');
      const name = String(pl.name ?? 'tool');
      let input = pl.arguments ?? '';
      try {
        const args = JSON.parse(pl.arguments ?? '{}');
        const summary = args.cmd ?? args.command ?? args.path ?? args.query ?? args.input;
        if (summary !== undefined) input = String(summary);
      } catch {}
      timelineEmitter.emit(sessionName, 'tool.call', { tool: name, ...(input ? { input } : {}) }, { source: 'daemon', confidence: 'high', ...(ts ? { ts } : {}) });
    } else if (pl.type === 'function_call_output') {
      const errMsg = pl.error;
      const output = !errMsg && typeof pl.output === 'string' && pl.output.trim()
        ? (pl.output.length > 200 ? pl.output.slice(0, 197) + '...' : pl.output)
        : undefined;
      timelineEmitter.emit(sessionName, 'tool.result', { ...(errMsg ? { error: errMsg } : {}), ...(output ? { output } : {}) }, { source: 'daemon', confidence: 'high', ...(ts ? { ts } : {}) });
    } else if (pl.type === 'reasoning') {
      emitSessionState(sessionName, 'running');
      // Codex reasoning — content is encrypted, emit empty thinking event to show activity
      timelineEmitter.emit(sessionName, 'assistant.thinking', { text: '' }, { source: 'daemon', confidence: 'high', ...(ts ? { ts } : {}) });
    } else if (pl.type === 'custom_tool_call') {
      emitSessionState(sessionName, 'running');
      const name = String(pl.name ?? 'tool');
      const input = typeof pl.input === 'string' ? pl.input.slice(0, 200) : '';
      timelineEmitter.emit(sessionName, 'tool.call', { tool: name, ...(input ? { input } : {}) }, { source: 'daemon', confidence: 'high', ...(ts ? { ts } : {}) });
    } else if (pl.type === 'custom_tool_call_output') {
      let error: string | undefined;
      let output: string | undefined;
      try {
        const out = JSON.parse(pl.output ?? '{}');
        if (out.metadata?.exit_code && out.metadata.exit_code !== 0) error = `exit ${out.metadata.exit_code}`;
        // Extract truncated output text for display
        const text = typeof out.output === 'string' ? out.output.trim() : '';
        if (!error && text) output = text.length > 200 ? text.slice(0, 197) + '...' : text;
      } catch {}
      timelineEmitter.emit(sessionName, 'tool.result', { ...(error ? { error } : {}), ...(output ? { output } : {}) }, { source: 'daemon', confidence: 'high', ...(ts ? { ts } : {}) });
    } else if (pl.type === 'web_search_call') {
      emitSessionState(sessionName, 'running');
      const action = pl.action;
      const actionType = action?.type ?? 'search';
      const query = action?.query ?? action?.url ?? '';
      timelineEmitter.emit(sessionName, 'tool.call', { tool: `web_${actionType}`, ...(query ? { input: String(query) } : {}) }, { source: 'daemon', confidence: 'high', ...(ts ? { ts } : {}) });
    }
    return;
  }

  if (raw.type !== 'event_msg') return;
  const pl = raw.payload;
  if (!pl) return;

  if (pl.type === 'token_count') {
    const total = pl.info?.total_token_usage;
    const last = pl.info?.last_token_usage;
    // Codex CLI reports `last_token_usage` for the current prompt/window and
    // `total_token_usage` as cumulative billing/thread usage. The UI ctx meter
    // must match Codex CLI's live window occupancy, so prefer `last`; `total`
    // is only a compatibility fallback when old payloads omit `last`.
    const usage = last ?? total;
    if (usage && typeof usage.input_tokens === 'number') {
      const cachedInput = typeof usage.cached_input_tokens === 'number' ? usage.cached_input_tokens : 0;
      const modelContextWindow = typeof pl.info?.model_context_window === 'number' && Number.isFinite(pl.info.model_context_window) && pl.info.model_context_window > 0
        ? pl.info.model_context_window
        : undefined;
      const contextWindow = resolveContextWindow(
        modelContextWindow,
        model,
        1_000_000,
        { preferExplicit: modelContextWindow !== undefined },
      );
      const contextWindowSource = modelContextWindow !== undefined && contextWindow === modelContextWindow
        ? USAGE_CONTEXT_WINDOW_SOURCES.PROVIDER
        : undefined;
      timelineEmitter.emit(sessionName, 'usage.update', {
        inputTokens: Math.max(0, usage.input_tokens - cachedInput),
        cacheTokens: cachedInput,
        outputTokens: usage.output_tokens ?? 0,
        contextWindow,
        ...(contextWindowSource ? { contextWindowSource } : {}),
        ...(model ? { model } : {}),
      }, { source: 'daemon', confidence: 'high', ...(ts ? { ts } : {}) });
    }
  } else if (pl.type === 'task_started') {
    emitSessionState(sessionName, 'running');
  } else if (pl.type === 'task_complete') {
    const watcher = watchers.get(sessionName);
    if (watcher && !watcher.turnHadAssistantText && !watcher.noTextRetrackAttempted) {
      watcher.noTextRetrackAttempted = true;
      void finalizeIdleAfterRefresh(sessionName);
      return;
    }
    flushFinalAnswer(sessionName);
    emitSessionState(sessionName, 'idle');
  } else if (pl.type === 'user_message') {
    flushFinalAnswer(sessionName);
    if (pl.message?.trim()) timelineEmitter.emit(sessionName, 'user.message', { text: pl.message }, { source: 'daemon', confidence: 'high', ...(ts ? { ts } : {}) });
  } else if (pl.type === 'agent_message') {
    const text = pl.message;
    if (!text?.trim()) return;
    if (pl.phase === 'final_answer') {
      emitSessionState(sessionName, 'running');
      const existing = finalAnswerBuffers.get(sessionName);
      if (existing) clearTimeout(existing.timer);
      const timer = setTimeout(() => flushFinalAnswer(sessionName), FINAL_ANSWER_DEBOUNCE_MS);
      finalAnswerBuffers.set(sessionName, { text, timer });
    } else if (pl.phase === 'commentary') {
      emitSessionState(sessionName, 'running');
      const watcher = watchers.get(sessionName);
      if (watcher) watcher.turnHadAssistantText = true;
      timelineEmitter.emit(sessionName, 'assistant.thinking', { text }, { source: 'daemon', confidence: 'high', ...(ts ? { ts } : {}) });
    }
  }
}

// ── History replay ─────────────────────────────────────────────────────────────

async function emitRecentHistory(sessionName: string, filePath: string, model?: string): Promise<void> {
  let fh: any = null;
  try {
    fh = await open(filePath, 'r');
    const { size } = await fh.stat();
    if (size === 0) return;
    const readSize = Math.min(size, 256 * 1024);
    const buf = Buffer.allocUnsafe(readSize);
    const { bytesRead } = await fh.read(buf, 0, readSize, size - readSize);
    const chunk = buf.subarray(0, bytesRead).toString('utf8');
    const lines = chunk.split('\n');
    const startIdx = size > readSize ? 1 : 0;

    historyReplaySessions.add(sessionName);
    try {
      for (let i = startIdx; i < lines.length; i++) {
        const line = lines[i];
        if (!line.trim()) continue;
        parseLine(sessionName, line, model); // Simplified for this restoration fix
      }
    } finally {
      historyReplaySessions.delete(sessionName);
    }
  } catch {} finally { if (fh) await fh.close().catch(() => {}); }
}

// ── Per-session watcher state ──────────────────────────────────────────────────

interface WatcherState {
  workDir: string;
  projectDir: string;
  activeFile: string | null;
  fileOffset: number;
  abort: AbortController;
  stopped: boolean;
  pollTimer?: ReturnType<typeof setInterval>;
  model?: string;
  _lastRotationCheck?: number;
  turnHadAssistantText?: boolean;
  noTextRetrackAttempted?: boolean;
  /**
   * Slow stat-probe kept alive by `startWatchingById` when the rollout
   * file doesn't materialise in the initial 30s fast window. Cleared by
   * `stopWatching()` or when the probe finds and activates the file.
   */
  pendingProbeTimer?: ReturnType<typeof setInterval>;
}

const watchers = new Map<string, WatcherState>();

function watcherControl(sessionName: string): WatcherControl {
  return {
    refresh: () => refreshTrackedSession(sessionName),
  };
}
const claimedFiles = new Map<string, string>(); // filePath → sessionName

export function preClaimFile(sessionName: string, filePath: string): void {
  for (const [fp, sn] of claimedFiles) { if (sn === sessionName) { claimedFiles.delete(fp); break; } }
  claimedFiles.set(filePath, sessionName);
}

export function isFileClaimedByOther(sessionName: string, filePath: string): boolean {
  const owner = claimedFiles.get(filePath);
  return !!(owner && owner !== sessionName && owner !== 'UNKNOWN');
}

export function extractUuidFromPath(p: string): string | null {
  const m = /rollout-.*-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/.exec(p);
  return m ? m[1] : null;
}

/**
 * Wait for a new rollout file to appear for the given workDir after launchTime.
 * Returns the UUID extracted from the filename, or null if not found within timeout.
 */
export async function extractNewRolloutUuid(workDir: string, launchTime: number, timeoutMs = 5000): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const dir of recentSessionDirs()) {
      let entries: string[];
      try { entries = await readdir(dir); } catch { continue; }
      for (const name of entries) {
        if (!name.startsWith('rollout-') || !name.endsWith('.jsonl')) continue;
        const fpath = join(dir, name);
        try {
          const s = await stat(fpath);
          if (s.mtimeMs < launchTime) continue;
        } catch { continue; }
        const cwd = await readCwd(fpath);
        if (cwd && normalizePath(cwd) === normalizePath(workDir)) {
          const uuid = extractUuidFromPath(fpath);
          if (uuid) return uuid;
        }
      }
    }
    await new Promise(r => setTimeout(r, 200));
  }
  return null;
}

/** Search recent session dirs for the rollout file containing the given UUID. */
export async function findRolloutPathByUuid(uuid: string): Promise<string | null> {
  for (const dir of recentSessionDirs()) {
    let entries: string[];
    try { entries = await readdir(dir); } catch { continue; }
    const match = entries.find(e => e.includes(uuid) && e.endsWith('.jsonl'));
    if (match) return join(dir, match);
  }
  return null;
}

/**
 * Ensure a rollout file exists for the given UUID.
 * If one already exists, returns its path. Otherwise creates a minimal
 * session_meta file so `codex resume <uuid>` can find and use it.
 */
export async function ensureSessionFile(uuid: string, cwd: string, sessionName?: string): Promise<string> {
  const existing = await findRolloutPathByUuid(uuid);
  if (existing) return existing;

  const now = new Date();
  const dir = codexSessionDir(now);
  await mkdir(dir, { recursive: true });

  const pad = (n: number) => String(n).padStart(2, '0');
  const ts = `${now.getUTCFullYear()}-${pad(now.getUTCMonth() + 1)}-${pad(now.getUTCDate())}T${pad(now.getUTCHours())}-${pad(now.getUTCMinutes())}-${pad(now.getUTCSeconds())}`;
  const filePath = join(dir, `rollout-${ts}-${uuid}.jsonl`);

  const isoNow = now.toISOString();
  const cliVersion = await getCodexVersion();

  // session_meta must include source, model_provider, cli_version for `codex resume` to succeed.
  const meta = JSON.stringify({
    timestamp: isoNow,
    type: 'session_meta',
    payload: {
      id: uuid,
      timestamp: isoNow,
      cwd,
      originator: 'codex_cli_rs',
      cli_version: cliVersion,
      source: 'cli',
      model_provider: 'openai',
      base_instructions: { text: '' },
    },
  });

  // Inject project memory so the agent starts with project context loaded.
  // Also required: `codex resume` needs at least one entry beyond session_meta.
  const memory = legacyInjectionDisabled()
    ? 'Shared context bootstrap deferred to runtime assembly.'
    : await buildSessionBootstrapContext(cwd, basename(cwd));
  const lines = [meta, buildCodexMemoryEntry(memory, isoNow)];

  await writeFile(filePath, lines.join('\n') + '\n', 'utf8');
  logger.info({ uuid, filePath, hasMemory: !!memory }, 'codex-watcher: created bootstrapped session file');

  if (sessionName && !legacyInjectionDisabled()) {
    const items = await readProcessedMemoryItems(basename(cwd));
    const payload = buildMemoryContextTimelinePayload(undefined, items, 'startup');
    if (payload) {
      timelineEmitter.emit(sessionName, 'memory.context', payload, { source: 'daemon', confidence: 'high' });
    }
  }

  // Upsert into Codex's SQLite threads table so `codex resume <uuid>` finds proper metadata.
  await upsertCodexThread(uuid, cwd, filePath, cliVersion).catch((e) =>
    logger.warn({ err: e, uuid }, 'codex-watcher: SQLite thread upsert failed (non-fatal)'),
  );

  return filePath;
}

// ── Public API ─────────────────────────────────────────────────────────────────

export async function startWatching(sessionName: string, workDir: string, model?: string): Promise<WatcherControl> {
  if (watchers.has(sessionName)) stopWatching(sessionName);
  const state: WatcherState = {
    workDir,
    projectDir: workDir,
    activeFile: null,
    fileOffset: 0,
    abort: new AbortController(),
    stopped: false,
    model,
  };
  watchers.set(sessionName, state);
  const control = watcherControl(sessionName);
  registerWatcherControl(sessionName, control);
  startPoll(sessionName, state);
  void watchDir(sessionName, state, state.workDir || codexSessionDir(new Date()));
  void (async () => {
    for (const dir of recentSessionDirs()) {
      if (state.stopped) return;
      const found = await findLatestRollout(dir, workDir);
      if (!found || state.stopped) continue;
      const s = await stat(found).catch(() => null);
      if (!s || state.stopped) continue;
      state.activeFile = found;
      state.fileOffset = s.size;
      claimedFiles.set(found, sessionName);
      await emitRecentHistory(sessionName, found, model);
      return;
    }
  })().catch((err) => {
    logger.debug({ err, sessionName, workDir }, 'codex-watcher: initial rollout scan failed');
  });
  return control;
}

export async function startWatchingSpecificFile(sessionName: string, filePath: string, model?: string): Promise<WatcherControl> {
  if (watchers.has(sessionName)) stopWatching(sessionName);
  let size = 0; try { size = (await stat(filePath)).size; } catch {}
  const dir = filePath.substring(0, filePath.lastIndexOf('/'));
  const projectDir = (await readCwd(filePath)) ?? dir;
  const state: WatcherState = {
    workDir: dir,
    projectDir,
    activeFile: filePath,
    fileOffset: size,
    abort: new AbortController(),
    stopped: false,
    model,
  };
  watchers.set(sessionName, state);
  const control = watcherControl(sessionName);
  registerWatcherControl(sessionName, control);
  claimedFiles.set(filePath, sessionName);
  startPoll(sessionName, state);
  void watchDir(sessionName, state, dir);
  return control;
}

export async function startWatchingById(sessionName: string, uuid: string, model?: string): Promise<WatcherControl> {
  if (watchers.has(sessionName)) stopWatching(sessionName);
  const state: WatcherState = {
    workDir: '',
    projectDir: '',
    activeFile: null,
    fileOffset: 0,
    abort: new AbortController(),
    stopped: false,
    model,
  };
  watchers.set(sessionName, state);
  const control = watcherControl(sessionName);
  registerWatcherControl(sessionName, control);

  // Helper: one pass over the recent-session dirs looking for a file whose
  // name contains the target uuid. Returns true when activation succeeds.
  const tryActivate = async (): Promise<boolean> => {
    for (const dir of recentSessionDirs()) {
      try {
        const entries = await readdir(dir);
        const match = entries.find((e) => e.includes(uuid));
        if (!match) continue;
        const found = join(dir, match);
        state.activeFile = found;
        state.workDir = dir;
        state.projectDir = (await readCwd(found)) ?? state.projectDir;
        claimedFiles.set(found, sessionName);
        await emitRecentHistory(sessionName, found, model);
        try {
          state.fileOffset = (await stat(found)).size;
        } catch {
          state.fileOffset = 0;
        }
        startPoll(sessionName, state);
        void watchDir(sessionName, state, dir);
        return true;
      } catch {}
    }
    return false;
  };

  // Fast attempt: 60 × 500ms = 30s total, matching Codex's typical
  // file-materialisation latency when the user is already active.
  for (let i = 0; i < 60 && !state.stopped; i++) {
    if (await tryActivate()) return control;
    await new Promise((r) => setTimeout(r, 500));
  }

  // File didn't appear in the fast window. Previously this function returned
  // here, leaving the `WatcherState` orphaned in the map with no timer and
  // no activeFile — so when Codex finally wrote the rollout, nothing tailed
  // it and the sub-session showed user input with no assistant reply in the
  // chat UI. Fall through to a slow probe (every 10s) that keeps trying
  // until the file appears or the session is explicitly stopped.
  if (!state.stopped) {
    logger.info(
      { sessionName, uuid },
      'codex-watcher: rollout file not found after fast poll, switching to slow probe (kept alive)',
    );
    const started = Date.now();
    const slowProbe = setInterval(async () => {
      if (state.stopped) {
        clearInterval(slowProbe);
        state.pendingProbeTimer = undefined;
        return;
      }
      try {
        if (await tryActivate()) {
          clearInterval(slowProbe);
          state.pendingProbeTimer = undefined;
          logger.info(
            { sessionName, uuid, waitedMs: Date.now() - started },
            'codex-watcher: rollout file appeared after slow probe, activated',
          );
        }
      } catch (err) {
        logger.debug({ sessionName, uuid, err }, 'codex-watcher: slow-probe tryActivate threw');
      }
    }, 10_000);
    state.pendingProbeTimer = slowProbe;
  }

  return control;
}


function startPoll(sessionName: string, state: WatcherState) {
  state.pollTimer = setInterval(() => {
    void refreshTrackedSession(sessionName);
  }, 2000);
}

export function stopWatching(sessionName: string): void {
  const state = watchers.get(sessionName);
  if (!state) return;
  state.stopped = true; state.abort.abort();
  if (state.pollTimer) clearInterval(state.pollTimer);
  // Clear any pre-activation slow-probe left behind by `startWatchingById`
  // that was still waiting on a missing rollout file. Without this, the
  // probe keeps hitting readdir() forever after the session is gone.
  if (state.pendingProbeTimer) clearInterval(state.pendingProbeTimer);
  watchers.delete(sessionName);
  unregisterWatcherControl(sessionName);
  sessionStates.delete(sessionName);
  const finalAnswer = finalAnswerBuffers.get(sessionName);
  if (finalAnswer) {
    clearTimeout(finalAnswer.timer);
    finalAnswerBuffers.delete(sessionName);
  }
  for (const [fp, sn] of claimedFiles) { if (sn === sessionName) claimedFiles.delete(fp); }
}

export function isWatching(sessionName: string): boolean { return watchers.has(sessionName); }

/**
 * Force the registered watcher to immediately run its existing drain/rotation logic
 * for this session. Uses the watcher's bound rollout/session identity only.
 */
export async function refreshTrackedSession(sessionName: string): Promise<boolean> {
  const state = watchers.get(sessionName);
  if (!state || state.stopped) return false;
  await drainNewLines(sessionName, state);
  state._lastRotationCheck = Date.now();
  const uuid = state.activeFile ? extractUuidFromPath(state.activeFile) : null;
  const latestPath = state.projectDir
    ? await findLatestMatchingRollout(sessionName, state.projectDir, uuid, state.activeFile)
    : null;
  if (latestPath && await checkNewer(latestPath, state.activeFile)) {
    if (state.activeFile) claimedFiles.delete(state.activeFile);
    state.activeFile = latestPath;
    state.workDir = latestPath.substring(0, latestPath.lastIndexOf('/'));
    state.fileOffset = 0;
    claimedFiles.set(latestPath, sessionName);
    void watchDir(sessionName, state, state.workDir);
  } else if (uuid) {
    for (const dir of recentSessionDirs()) {
      if (dir === state.workDir) continue;
      try {
        const entries = await readdir(dir);
        const match = entries.find(e => e.includes(uuid));
        if (!match) continue;
        const newPath = join(dir, match);
        if (await checkNewer(newPath, state.activeFile)) {
          if (state.activeFile) claimedFiles.delete(state.activeFile);
          state.activeFile = newPath;
          state.workDir = dir;
          state.fileOffset = 0;
          claimedFiles.set(newPath, sessionName);
          void watchDir(sessionName, state, dir);
          break;
        }
      } catch { continue; }
    }
  }
  await drainNewLines(sessionName, state);
  return true;
}

export async function retrackLatestRollout(sessionName: string): Promise<boolean> {
  const state = watchers.get(sessionName);
  if (!state || state.stopped) return false;
  const projectDir = state.projectDir || (state.activeFile ? await readCwd(state.activeFile) : null);
  if (!projectDir) return false;
  const currentUuid = state.activeFile ? extractUuidFromPath(state.activeFile) : null;

  const latestPath = await findLatestMatchingRollout(sessionName, projectDir, currentUuid, state.activeFile);

  if (!latestPath) return false;
  logger.info({ sessionName, old: state.activeFile, new: latestPath }, 'codex-watcher: retracking latest rollout after no-text turn');
  if (state.activeFile) claimedFiles.delete(state.activeFile);
  state.activeFile = latestPath;
  state.workDir = latestPath.substring(0, latestPath.lastIndexOf('/'));
  state.fileOffset = 0;
  claimedFiles.set(latestPath, sessionName);
  void watchDir(sessionName, state, state.workDir);
  await drainNewLines(sessionName, state);
  return true;
}

async function finalizeIdleAfterRefresh(sessionName: string): Promise<void> {
  let refreshed = false;
  let retracked = false;
  try {
    refreshed = await refreshTrackedSession(sessionName).catch(() => false);
    if (sessionStates.get(sessionName) !== 'running') {
      retracked = await retrackLatestRollout(sessionName).catch(() => false);
      if (retracked && sessionStates.get(sessionName) !== 'running') {
        refreshed = (await refreshTrackedSession(sessionName).catch(() => false)) || refreshed;
      }
    }
  } finally {
    flushFinalAnswer(sessionName);
    if ((refreshed || retracked) && sessionStates.get(sessionName) === 'running') return;
    emitSessionState(sessionName, 'idle');
  }
}

async function watchDir(sessionName: string, state: WatcherState, dir: string): Promise<void> {
  try {
    const watcher = watch(dir, { persistent: false, signal: state.abort.signal });
    for await (const event of watcher as any) {
      if (state.stopped) break;
      if (!event.filename?.startsWith('rollout-') || !event.filename.endsWith('.jsonl')) continue;
      const changedPath = join(dir, event.filename);
      await maybeSwitchActiveFile(sessionName, state, changedPath);
      await drainNewLines(sessionName, state);
    }
  } catch {}
}

async function checkNewer(a: string, b: string | null): Promise<boolean> {
  if (!b) return true;
  try { return (await stat(a)).mtimeMs > (await stat(b)).mtimeMs; } catch { return false; }
}

async function maybeSwitchActiveFile(sessionName: string, state: WatcherState, candidatePath: string): Promise<void> {
  if (state.stopped || !candidatePath || candidatePath === state.activeFile) return;
  if (isFileClaimedByOther(sessionName, candidatePath)) return;

  const currentUuid = state.activeFile ? extractUuidFromPath(state.activeFile) : null;
  const candidateUuid = extractUuidFromPath(candidatePath);

  // Follow rollover/rotation for the same Codex session file. This handles
  // same-directory file replacement, not just cross-date directory changes.
  if (currentUuid && candidateUuid && candidateUuid !== currentUuid) return;

  if (!(await checkNewer(candidatePath, state.activeFile))) return;

  logger.info({ sessionName, old: state.activeFile, new: candidatePath }, 'codex-watcher: switched active rollout file');
  if (state.activeFile) claimedFiles.delete(state.activeFile);
  state.activeFile = candidatePath;
  state.fileOffset = 0;
  claimedFiles.set(candidatePath, sessionName);
}

async function drainNewLines(sessionName: string, state: WatcherState): Promise<void> {
  if (!state.activeFile) return;
  let fh: any = null;
  try {
    fh = await open(state.activeFile, 'r');
    const s = await fh.stat();
    if (s.size <= state.fileOffset) return;
    const buf = Buffer.allocUnsafe(s.size - state.fileOffset);
    const { bytesRead } = await fh.read(buf, 0, buf.length, state.fileOffset);
    state.fileOffset += bytesRead;
    const chunk = buf.subarray(0, bytesRead).toString('utf8');
    for (const line of chunk.split('\n')) { if (state.stopped) break; parseLine(sessionName, line, state.model); }
  } catch {} finally { if (fh) await fh.close().catch(() => {}); }
}
