/**
 * Handle commands from the web UI and inbound chat messages via ServerLink.
 * Commands arrive as JSON objects with a `type` field.
 */
import { startProject, stopProject, teardownProject, type ProjectConfig } from '../agent/session-manager.js';
import { sendKeys, sendKeysDelayedEnter, sendRawInput, resizeSession, sendKey } from '../agent/tmux.js';
import { listSessions, getSession } from '../store/session-store.js';
import { routeMessage, type InboundMessage, type RouterContext } from '../router/message-router.js';
import { terminalStreamer, type StreamSubscriber } from './terminal-streamer.js';
import type { ServerLink } from './server-link.js';
import { timelineEmitter } from './timeline-emitter.js';
import { timelineStore } from './timeline-store.js';
import {
  startSubSession,
  stopSubSession,
  rebuildSubSessions,
  detectShells,
  readSubSessionResponse,
  subSessionName,
  type SubSessionRecord,
} from './subsession-manager.js';
import logger from '../util/logger.js';
import { homedir } from 'os';
import { readdir as fsReaddir, realpath as fsRealpath, readFile as fsReadFileRaw, stat as fsStat } from 'node:fs/promises';
import * as nodePath from 'node:path';
import { exec as execCb } from 'node:child_process';
import { promisify } from 'node:util';
const execAsync = promisify(execCb);
import { startP2pRun, cancelP2pRun, getP2pRun, listP2pRuns, type P2pTarget } from './p2p-orchestrator.js';
import { handleFileUpload, handleFileDownload, initFileTransfer, startCleanupTimer, createProjectFileHandle, lookupAttachment } from './file-transfer-handler.js';

// ── Common MIME map for file metadata ────────────────────────────────────────

const MIME_MAP: Record<string, string> = {
  ts: 'text/typescript', tsx: 'text/typescript', js: 'text/javascript', jsx: 'text/javascript',
  mjs: 'text/javascript', cjs: 'text/javascript', json: 'application/json', md: 'text/markdown',
  txt: 'text/plain', html: 'text/html', css: 'text/css', xml: 'text/xml', yaml: 'text/yaml',
  yml: 'text/yaml', toml: 'text/toml', sh: 'text/x-shellscript', py: 'text/x-python',
  rb: 'text/x-ruby', go: 'text/x-go', rs: 'text/x-rust', java: 'text/x-java',
  kt: 'text/x-kotlin', swift: 'text/x-swift', c: 'text/x-c', cpp: 'text/x-c++',
  h: 'text/x-c', hpp: 'text/x-c++', sql: 'text/x-sql', lua: 'text/x-lua',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', svg: 'image/svg+xml', ico: 'image/x-icon', bmp: 'image/bmp',
  pdf: 'application/pdf', zip: 'application/zip', gz: 'application/gzip',
  tar: 'application/x-tar', wasm: 'application/wasm',
};

// ── @@ token parsing ─────────────────────────────────────────────────────────

const DISCUSS_TOKEN_RE = /@@discuss\(([^,]+),\s*([^)]+)\)/g;
const FILE_TOKEN_RE = /@((?:[a-zA-Z0-9_.\-/]+\/)*[a-zA-Z0-9_.\-]+\.[a-zA-Z0-9]+)/g;

interface ParsedTokens {
  agents: P2pTarget[];
  files: string[];
  cleanText: string;
}

function parseAtTokens(text: string): ParsedTokens {
  const agents: P2pTarget[] = [];
  const files: string[] = [];

  for (const m of text.matchAll(DISCUSS_TOKEN_RE)) {
    agents.push({ session: m[1].trim(), mode: m[2].trim() });
  }

  // Remove @@discuss tokens first so @file regex doesn't partially match them
  let withoutCx = text.replace(DISCUSS_TOKEN_RE, '');
  for (const m of withoutCx.matchAll(FILE_TOKEN_RE)) {
    files.push(m[1]);
  }

  const cleanText = withoutCx.replace(FILE_TOKEN_RE, '').replace(/\s+/g, ' ').trim();
  return { agents, files, cleanText };
}

// ── Binary frame packing ─────────────────────────────────────────────────────

/**
 * Pack a raw PTY buffer into the v1 binary frame format:
 *   byte 0: version (0x01)
 *   bytes 1-2: sessionName length (uint16 BE)
 *   bytes 3..3+N-1: sessionName (UTF-8)
 *   bytes 3+N..: raw PTY payload
 */
function packRawFrame(sessionName: string, data: Buffer): Buffer {
  const nameBytes = Buffer.from(sessionName, 'utf8');
  const header = Buffer.allocUnsafe(3 + nameBytes.length);
  header[0] = 0x01;
  header.writeUInt16BE(nameBytes.length, 1);
  nameBytes.copy(header, 3);
  return Buffer.concat([header, data]);
}

// ── AsyncMutex (per-session serialized stdin writes) ─────────────────────────

class AsyncMutex {
  private queue: Array<() => void> = [];
  private locked = false;

  async acquire(): Promise<() => void> {
    return new Promise<() => void>((resolve) => {
      const tryLock = () => {
        if (!this.locked) {
          this.locked = true;
          resolve(() => this.release());
        } else {
          this.queue.push(tryLock);
        }
      };
      tryLock();
    });
  }

  private release(): void {
    this.locked = false;
    const next = this.queue.shift();
    if (next) next();
  }
}

const sessionMutexes = new Map<string, AsyncMutex>();
function getMutex(sessionName: string): AsyncMutex {
  let mutex = sessionMutexes.get(sessionName);
  if (!mutex) {
    mutex = new AsyncMutex();
    sessionMutexes.set(sessionName, mutex);
  }
  return mutex;
}

// ── CommandId dedup cache (100 entries / 5 min TTL per session) ──────────────

class CommandDedup {
  private entries = new Map<string, number>(); // commandId → timestamp
  private readonly MAX_SIZE = 100;
  private readonly TTL_MS = 5 * 60 * 1000;

  has(commandId: string): boolean {
    const ts = this.entries.get(commandId);
    if (ts === undefined) return false;
    if (Date.now() - ts > this.TTL_MS) {
      this.entries.delete(commandId);
      return false;
    }
    return true;
  }

  add(commandId: string): void {
    if (this.entries.size >= this.MAX_SIZE) {
      // Evict expired entries first
      const now = Date.now();
      for (const [id, ts] of this.entries) {
        if (now - ts > this.TTL_MS) this.entries.delete(id);
      }
      // If still at max, evict the oldest
      if (this.entries.size >= this.MAX_SIZE) {
        const oldest = this.entries.keys().next().value;
        if (oldest !== undefined) this.entries.delete(oldest);
      }
    }
    this.entries.set(commandId, Date.now());
  }
}

const sessionDedups = new Map<string, CommandDedup>();
function getDedup(sessionName: string): CommandDedup {
  let dedup = sessionDedups.get(sessionName);
  if (!dedup) {
    dedup = new CommandDedup();
    sessionDedups.set(sessionName, dedup);
  }
  return dedup;
}

function expandTilde(p: string): string {
  return p.startsWith('~/') ? homedir() + p.slice(1) : p === '~' ? homedir() : p;
}

// Track active terminal subscriptions for proper cleanup
const activeSubscriptions = new Map<string, { subscriber: StreamSubscriber; unsubscribe: () => void }>();

let routerCtx: RouterContext | null = null;

/** Set the router context for handling inbound chat messages. Must be called before messages arrive. */
export function setRouterContext(ctx: RouterContext): void {
  routerCtx = ctx;
}

export function handleWebCommand(msg: unknown, serverLink: ServerLink): void {
  if (!msg || typeof msg !== 'object') return;
  const cmd = msg as Record<string, unknown>;

  switch (cmd.type) {
    case 'inbound':
      void handleInbound(cmd);
      break;
    case 'session.start':
      void handleStart(cmd, serverLink);
      break;
    case 'session.stop':
      void handleStop(cmd);
      break;
    case 'session.restart':
      void handleRestart(cmd, serverLink);
      break;
    case 'session.send':
      void handleSend(cmd, serverLink);
      break;
    case 'session.input':
      void handleInput(cmd);
      break;
    case 'session.resize':
      void handleResize(cmd);
      break;
    case 'get_sessions':
      handleGetSessions(serverLink);
      break;
    case 'terminal.subscribe':
      handleSubscribe(cmd, serverLink);
      break;
    case 'terminal.unsubscribe':
      handleUnsubscribe(cmd);
      break;
    case 'terminal.snapshot_request':
      handleSnapshotRequest(cmd);
      break;
    case 'timeline.replay_request':
      handleTimelineReplay(cmd, serverLink);
      break;
    case 'timeline.history_request':
      handleTimelineHistory(cmd, serverLink);
      break;
    case 'subsession.start':
      void handleSubSessionStart(cmd, serverLink);
      break;
    case 'subsession.stop':
      void handleSubSessionStop(cmd);
      break;
    case 'subsession.rebuild_all':
      void handleSubSessionRebuildAll(cmd);
      break;
    case 'subsession.detect_shells':
      void handleSubSessionDetectShells(serverLink);
      break;
    case 'subsession.read_response':
      void handleSubSessionReadResponse(cmd, serverLink);
      break;
    case 'subsession.set_model':
      void handleSubSessionSetModel(cmd);
      break;
    case 'ask.answer':
      void handleAskAnswer(cmd);
      break;
    case 'discussion.start':
      void handleDiscussionStart(cmd, serverLink);
      break;
    case 'discussion.status':
      handleDiscussionStatus(cmd, serverLink);
      break;
    case 'discussion.stop':
      void handleDiscussionStop(cmd);
      break;
    case 'discussion.list':
      handleDiscussionList(serverLink);
      break;
    case 'server.delete':
      void handleServerDelete();
      break;
    case 'daemon.upgrade':
      void handleDaemonUpgrade();
      break;
    case 'file.search':
      void handleFileSearch(cmd, serverLink);
      break;
    case 'fs.ls':
      void handleFsList(cmd, serverLink);
      break;
    case 'fs.read':
      void handleFsRead(cmd, serverLink);
      break;
    case 'fs.git_status':
      void handleFsGitStatus(cmd, serverLink);
      break;
    case 'fs.git_diff':
      void handleFsGitDiff(cmd, serverLink);
      break;
    case 'p2p.cancel':
      void handleP2pCancel(cmd, serverLink);
      break;
    case 'p2p.status':
      void handleP2pStatus(cmd, serverLink);
      break;
    case 'file.upload':
      void handleFileUpload(cmd, serverLink);
      break;
    case 'file.download':
      void handleFileDownload(cmd, serverLink);
      break;
    case 'auth_ok':
    case 'heartbeat':
    case 'heartbeat_ack':
    case 'ping':
    case 'pong':
      // Expected internal messages, ignore silently
      break;
    default:
      if (typeof cmd.type === 'string') {
        logger.warn({ type: cmd.type }, 'Unknown web command type');
      }
  }
}

async function handleInbound(cmd: Record<string, unknown>): Promise<void> {
  const msg = cmd.msg as InboundMessage | undefined;
  if (!msg) {
    logger.warn('inbound: missing msg payload');
    return;
  }
  if (!routerCtx) {
    logger.warn('inbound: router context not set, dropping message');
    return;
  }
  try {
    await routeMessage(msg, routerCtx);
  } catch (err) {
    logger.error({ err, platform: msg.platform, channelId: msg.channelId }, 'inbound: routeMessage failed');
  }
}

async function handleStart(cmd: Record<string, unknown>, serverLink: ServerLink): Promise<void> {
  const project = cmd.project as string | undefined;
  const agentType = (cmd.agentType as string) || 'claude-code';
  const dir = expandTilde((cmd.dir as string) || '~');

  if (!project) {
    logger.warn('session.start: missing project name');
    return;
  }

  try {
    // If project already has sessions, teardown first (keep store records)
    const existing = listSessions(project);
    if (existing.length > 0) {
      await teardownProject(project);
    }
    const config: ProjectConfig = {
      name: project,
      dir,
      brainType: agentType as ProjectConfig['brainType'],
      workerTypes: [],
    };
    await startProject(config);
    logger.info({ project }, 'Session started via web');
  } catch (err) {
    logger.error({ project, err }, 'session.start failed');
    const message = err instanceof Error ? err.message : String(err);
    try { serverLink.send({ type: 'session.error', project, message }); } catch { /* ignore */ }
  }
}

async function handleRestart(cmd: Record<string, unknown>, serverLink: ServerLink): Promise<void> {
  const project = cmd.project as string | undefined;
  const fresh = cmd.fresh === true;
  if (!project) {
    logger.warn('session.restart: missing project name');
    return;
  }

  const sessions = listSessions(project);
  if (!sessions.length) {
    logger.warn({ project }, 'session.restart: no sessions found for project');
    return;
  }

  const brain = sessions.find((s) => s.role === 'brain');
  if (!brain) {
    logger.warn({ project }, 'session.restart: no brain session found');
    return;
  }

  try {
    // Teardown: kill tmux + watchers but keep store records so they survive failures
    await teardownProject(project);
    const config: ProjectConfig = {
      name: project,
      dir: brain.projectDir,
      brainType: brain.agentType as ProjectConfig['brainType'],
      workerTypes: sessions
        .filter((s) => s.role !== 'brain')
        .map((s) => s.agentType as ProjectConfig['brainType']),
      fresh,
    };
    await startProject(config);
    logger.info({ project, fresh }, 'Session restarted via web');
  } catch (err) {
    logger.error({ project, err }, 'session.restart failed');
    const message = err instanceof Error ? err.message : String(err);
    try { serverLink.send({ type: 'session.error', project, message }); } catch { /* ignore */ }
  }
}

async function handleStop(cmd: Record<string, unknown>): Promise<void> {
  const project = cmd.project as string | undefined;
  if (!project) {
    logger.warn('session.stop: missing project name');
    return;
  }

  try {
    await stopProject(project);
    logger.info({ project }, 'Session stopped via web');
  } catch (err) {
    logger.error({ project, err }, 'session.stop failed');
  }
}

/**
 * Send a command to a session, handling `!`-prefixed shell commands:
 * - claude-code: send `!` first (with delayed-Enter), then send the rest of the command
 * - codex: strip `!` and send the shell command directly (Codex has no `!` prefix)
 * - others: send as-is
 */
/** Agents that don't support bracketed paste and need chunked send-keys. */
const CHUNKED_AGENTS = new Set(['codex', 'gemini', 'opencode', 'shell', 'script']);

async function sendShellAwareCommand(sessionName: string, text: string, agentType: string): Promise<void> {
  const opts = CHUNKED_AGENTS.has(agentType) ? { chunked: true } : undefined;
  if (text.startsWith('!')) {
    const shellCmd = text.slice(1).trimStart();
    if (agentType === 'codex') {
      // Codex: just send the shell command without `!`
      await sendKeysDelayedEnter(sessionName, shellCmd, opts);
    } else {
      // claude-code (and others): send `!` first to enter shell mode, then the command
      await sendKeysDelayedEnter(sessionName, '!', opts);
      await new Promise((r) => setTimeout(r, 300));
      await sendKeysDelayedEnter(sessionName, shellCmd, opts);
    }
  } else {
    await sendKeysDelayedEnter(sessionName, text, opts);
  }
}

async function handleSend(cmd: Record<string, unknown>, serverLink: ServerLink): Promise<void> {
  const sessionName = (cmd.sessionName ?? cmd.session) as string | undefined;
  const text = cmd.text as string | undefined;
  const commandId = cmd.commandId as string | undefined;

  if (!sessionName || !text) {
    logger.warn('session.send: missing sessionName or text');
    return;
  }

  // Fallback: legacy clients that don't send commandId get a server-generated one
  const isLegacy = !commandId;
  const effectiveId = commandId ?? crypto.randomUUID();
  if (isLegacy) {
    logger.warn({ sessionName, effectiveId }, 'session.send: missing commandId — using server-generated fallback');
  }

  // Dedup: silently ignore duplicate commandIds
  const dedup = getDedup(sessionName);
  if (dedup.has(effectiveId)) {
    logger.debug({ sessionName, effectiveId }, 'session.send: duplicate commandId, ignored');
    return;
  }
  dedup.add(effectiveId);

  // Check for P2P tokens
  const tokens = parseAtTokens(text);

  if (tokens.agents.length > 0) {
    // P2P Quick Discussion — delegate to orchestrator
    try {
      const fileContents: Array<{ path: string; content: string }> = [];
      const record = getSession(sessionName);
      const projectDir = record?.projectDir ?? '';
      for (const fp of tokens.files) {
        try {
          const absPath = nodePath.isAbsolute(fp) ? fp : nodePath.join(projectDir, fp);
          const content = await fsReadFileRaw(absPath, 'utf8');
          fileContents.push({ path: fp, content: content.slice(0, 50_000) }); // cap at 50KB
        } catch { /* ignore unreadable files */ }
      }
      const run = await startP2pRun(sessionName, tokens.agents, tokens.cleanText, fileContents, serverLink);
      const status = isLegacy ? 'accepted_legacy' : 'accepted';
      timelineEmitter.emit(sessionName, 'command.ack', { commandId: effectiveId, status });
      try {
        serverLink.send({ type: 'command.ack', commandId: effectiveId, status, session: sessionName });
        serverLink.send({ type: 'p2p.run_started', runId: run.id, session: sessionName });
      } catch { /* not connected */ }
    } catch (err) {
      logger.error({ sessionName, err }, 'P2P run start failed');
    }
    return;
  }

  // Preserve raw @file references for normal sends.
  const finalText = text;

  // Build attachment refs for any uploaded files referenced in the message
  const attachments: Array<{ id: string; originalName?: string; mime?: string; size?: number; daemonPath: string }> = [];
  if (tokens.files.length > 0) {
    const record = getSession(sessionName);
    const projectDir = record?.projectDir ?? '';
    for (const fp of tokens.files) {
      const absPath = nodePath.isAbsolute(fp) ? fp : nodePath.join(projectDir, fp);
      const entry = lookupAttachment(absPath);
      if (entry) {
        attachments.push({
          id: entry.id,
          originalName: entry.originalName,
          mime: entry.mime,
          size: entry.size,
          daemonPath: entry.daemonPath,
        });
      }
    }
  }

  // Serialized write via per-session mutex
  const release = await getMutex(sessionName).acquire();
  try {
    const agentType = getSession(sessionName)?.agentType ?? 'unknown';
    await sendShellAwareCommand(sessionName, finalText, agentType);
    const payload: Record<string, unknown> = { text };
    if (attachments.length > 0) payload.attachments = attachments;
    timelineEmitter.emit(sessionName, 'user.message', payload);
    // Emit accepted ack (accepted_legacy for fallback IDs so callers can distinguish)
    const status = isLegacy ? 'accepted_legacy' : 'accepted';
    timelineEmitter.emit(sessionName, 'command.ack', { commandId: effectiveId, status });
    try {
      serverLink.send({ type: 'command.ack', commandId: effectiveId, status, session: sessionName });
    } catch { /* not connected */ }
  } catch (err) {
    logger.error({ sessionName, err }, 'session.send failed');
  } finally {
    release();
  }
}

async function handleInput(cmd: Record<string, unknown>): Promise<void> {
  const sessionName = cmd.sessionName as string | undefined;
  const data = cmd.data as string | undefined;

  // session.input SHALL NOT require or process commandId
  if (!sessionName || data === undefined) return;

  // Serialized via same per-session mutex (no commandId, no retry)
  const release = await getMutex(sessionName).acquire();
  try {
    // For Codex and Gemini, ESC doesn't interrupt an ongoing task — they need Ctrl+C.
    // Remap ESC → Ctrl+C for these agents so interrupt behavior is consistent with CC.
    const agentType = getSession(sessionName)?.agentType;
    const isEsc = data === '\x1b';
    if (isEsc && (agentType === 'codex' || agentType === 'gemini')) {
      await sendRawInput(sessionName, '\x03'); // Ctrl+C
    } else {
      await sendRawInput(sessionName, data);
    }
  } catch (err) {
    logger.error({ sessionName, err }, 'session.input failed');
  } finally {
    release();
  }
}

async function handleResize(cmd: Record<string, unknown>): Promise<void> {
  const sessionName = cmd.sessionName as string | undefined;
  const cols = cmd.cols as number | undefined;
  const rows = cmd.rows as number | undefined;
  if (!sessionName || !cols || !rows) return;
  try {
    // Subtract 1 col so tmux is always slightly narrower than the browser terminal.
    // xterm fitAddon rounds down but container width may have sub-character remainder,
    // causing tmux output to wrap at a wider width and misalign with xterm's display.
    await resizeSession(sessionName, Math.max(cols - 1, 40), Math.max(rows, 10));
    terminalStreamer.invalidateSize(sessionName);
  } catch (err) {
    logger.error({ sessionName, cols, rows, err }, 'session.resize failed');
  }
}

function handleGetSessions(serverLink: ServerLink): void {
  const sessions = listSessions()
    .filter((s) => !s.name.startsWith('deck_sub_'))
    .map((s) => ({
      name: s.name,
      project: s.projectName,
      role: s.role,
      agentType: s.agentType,
      agentVersion: s.agentVersion,
      state: s.state,
      projectDir: s.projectDir,
    }));
  try {
    serverLink.send({ type: 'session_list', daemonVersion: serverLink.daemonVersion, sessions });
  } catch {
    // not connected
  }
}

function handleSubscribe(cmd: Record<string, unknown>, serverLink: ServerLink): void {
  const session = cmd.session as string | undefined;
  if (!session) return;

  const subscriber: StreamSubscriber = {
    sessionName: session,
    send: (diff) => {
      try { serverLink.send({ type: 'terminal_update', diff }); } catch { /* ignore */ }
    },
    sendRaw: (data: Buffer) => {
      serverLink.sendBinary(packRawFrame(session, data));
    },
    sendControl: (msg) => {
      try { serverLink.send(msg); } catch { /* ignore */ }
    },
    onError: () => {
      activeSubscriptions.delete(session);
    },
  };

  // Subscribe new subscriber BEFORE removing old one so the pipe never drops to 0
  // subscribers and unnecessarily stops+restarts (which causes idle→running oscillation
  // and empty-line snapshot spam).
  const unsubscribe = terminalStreamer.subscribe(subscriber);
  const existing = activeSubscriptions.get(session);
  activeSubscriptions.set(session, { subscriber, unsubscribe });
  if (existing) {
    existing.unsubscribe();
  }
  logger.debug({ session }, 'Terminal subscribed via web');
}

function handleUnsubscribe(cmd: Record<string, unknown>): void {
  const session = cmd.session as string | undefined;
  if (!session) return;

  const entry = activeSubscriptions.get(session);
  if (entry) {
    entry.unsubscribe();
    activeSubscriptions.delete(session);
    logger.debug({ session }, 'Terminal unsubscribed via web');
  }
}

function handleSnapshotRequest(cmd: Record<string, unknown>): void {
  const sessionName = cmd.sessionName as string | undefined;
  if (!sessionName) return;
  terminalStreamer.requestSnapshot(sessionName);
  logger.debug({ sessionName }, 'Snapshot requested via web');
}

function handleTimelineReplay(cmd: Record<string, unknown>, serverLink: ServerLink): void {
  const sessionName = cmd.sessionName as string | undefined;
  const afterSeq = cmd.afterSeq as number | undefined;
  const requestEpoch = cmd.epoch as number | undefined;
  const requestId = cmd.requestId as string | undefined;

  if (!sessionName || afterSeq === undefined || requestEpoch === undefined) {
    logger.warn('timeline.replay_request: missing fields');
    return;
  }

  if (requestEpoch !== timelineEmitter.epoch) {
    // Epoch mismatch — serve current epoch events from file store, fallback to all epochs
    let events = timelineStore.read(sessionName, { epoch: timelineEmitter.epoch });
    if (events.length === 0) {
      events = timelineStore.read(sessionName, {});
    }
    try {
      serverLink.send({
        type: 'timeline.replay',
        sessionName,
        requestId,
        events,
        truncated: false,
        epoch: timelineEmitter.epoch,
      });
    } catch { /* not connected */ }
    return;
  }

  const { events, truncated } = timelineEmitter.replay(sessionName, afterSeq);
  try {
    serverLink.send({
      type: 'timeline.replay',
      sessionName,
      requestId,
      events,
      truncated,
      epoch: timelineEmitter.epoch,
    });
  } catch { /* not connected */ }
}

/** Handle timeline.history_request — browser requesting full session history on open. */
function handleTimelineHistory(cmd: Record<string, unknown>, serverLink: ServerLink): void {
  const sessionName = cmd.sessionName as string | undefined;
  const requestId = cmd.requestId as string | undefined;
  const limit = (cmd.limit as number | undefined) ?? 200;
  const afterTs = cmd.afterTs as number | undefined;

  if (!sessionName) {
    logger.warn('timeline.history_request: missing sessionName');
    return;
  }

  // Read more than requested so dedup doesn't shrink the set too aggressively.
  // Do NOT filter by epoch — history should include events across daemon restarts.
  // Filter by afterTs when provided: client already has events up to that timestamp.
  const readLimit = Math.min(limit * 4, 2000);
  const events = timelineStore.read(sessionName, { limit: readLimit, afterTs });

  // Deduplicate consecutive session.state events — keep only the last in each run.
  // This prevents idle↔running oscillation storms from crowding out user.message events.
  const deduped: typeof events = [];
  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    if (ev.type === 'session.state') {
      const next = events[i + 1];
      if (next && next.type === 'session.state') continue; // skip, keep last
    }
    deduped.push(ev);
  }
  // Trim to requested limit after dedup
  const trimmed = deduped.length > limit ? deduped.slice(deduped.length - limit) : deduped;

  try {
    serverLink.send({
      type: 'timeline.history',
      sessionName,
      requestId,
      events: trimmed,
      epoch: timelineEmitter.epoch,
    });
  } catch { /* not connected */ }
}

// ── Sub-session handlers ──────────────────────────────────────────────────

async function handleSubSessionStart(cmd: Record<string, unknown>, serverLink: ServerLink): Promise<void> {
  const id = cmd.id as string | undefined;
  const type = cmd.sessionType as string | undefined;
  if (!id || !type) {
    logger.warn('subsession.start: missing id or type');
    return;
  }
  // Resolve a unique Gemini session ID so each sub-session gets its own conversation
  let geminiSessionId: string | null = null;
  let fileSnapshot: Set<string> | undefined;
  if (type === 'gemini') {
    // Snapshot existing files BEFORE resolving — used as fallback if resolve fails
    const { snapshotSessionFiles } = await import('./gemini-watcher.js');
    fileSnapshot = await snapshotSessionFiles();
    try {
      const { GeminiDriver } = await import('../agent/drivers/gemini.js');
      geminiSessionId = await new GeminiDriver().resolveSessionId(
        (cmd.cwd as string | undefined) ?? undefined,
      );
      logger.info({ id, geminiSessionId }, 'Resolved Gemini session ID for sub-session');
      // Persist to DB so rebuild can use the exact UUID
      serverLink.send({ type: 'subsession.update_gemini_id', id, geminiSessionId });
      fileSnapshot = undefined; // no longer needed
    } catch (e) {
      logger.warn({ err: e, id }, 'Failed to resolve Gemini session ID — using snapshot-diff fallback');
    }
  }
  await startSubSession({
    id,
    type,
    shellBin: cmd.shellBin as string | null | undefined,
    cwd: cmd.cwd as string | null | undefined,
    ccSessionId: cmd.ccSessionId as string | null | undefined,
    parentSession: cmd.parentSession as string | null | undefined,
    geminiSessionId,
    fresh: type === 'gemini' && !geminiSessionId,
    _fileSnapshot: fileSnapshot,
    _onGeminiDiscovered: fileSnapshot ? (sessionId: string) => {
      logger.info({ id, sessionId }, 'Discovered Gemini session ID via snapshot-diff');
      try { serverLink.send({ type: 'subsession.update_gemini_id', id, geminiSessionId: sessionId }); } catch { /* ignore */ }
    } : undefined,
  }).catch((e: unknown) => logger.error({ err: e, id }, 'subsession.start failed'));
}

async function handleSubSessionStop(cmd: Record<string, unknown>): Promise<void> {
  const sName = cmd.sessionName as string | undefined;
  if (!sName) {
    logger.warn('subsession.stop: missing sessionName');
    return;
  }
  await stopSubSession(sName).catch((e: unknown) => logger.error({ err: e, sName }, 'subsession.stop failed'));
}

async function handleSubSessionRebuildAll(cmd: Record<string, unknown>): Promise<void> {
  const subSessions = cmd.subSessions as SubSessionRecord[] | undefined;
  if (!Array.isArray(subSessions)) return;
  await rebuildSubSessions(subSessions).catch((e: unknown) => logger.error({ err: e }, 'subsession.rebuild_all failed'));
}

async function handleSubSessionDetectShells(serverLink: ServerLink): Promise<void> {
  const shells = await detectShells().catch(() => [] as string[]);
  try {
    serverLink.send({ type: 'subsession.shells', shells });
  } catch { /* not connected */ }
}

async function handleSubSessionSetModel(cmd: Record<string, unknown>): Promise<void> {
  const sessionName = cmd.sessionName as string | undefined;
  const model = cmd.model as string | undefined;
  const cwd = cmd.cwd as string | undefined;

  if (!sessionName || !model) {
    logger.warn('subsession.set_model: missing sessionName or model');
    return;
  }

  // Extract sub-session id from name (deck_sub_{id})
  const prefix = 'deck_sub_';
  const id = sessionName.startsWith(prefix) ? sessionName.slice(prefix.length) : null;
  if (!id) {
    logger.warn({ sessionName }, 'subsession.set_model: invalid session name');
    return;
  }

  logger.info({ sessionName, model }, 'Restarting Codex sub-session with new model');
  await stopSubSession(sessionName).catch(() => {});
  await startSubSession({ id, type: 'codex', cwd: cwd ?? null, codexModel: model })
    .catch((e: unknown) => logger.error({ err: e, sessionName, model }, 'subsession.set_model restart failed'));
}

async function handleSubSessionReadResponse(cmd: Record<string, unknown>, serverLink: ServerLink): Promise<void> {
  const sName = cmd.sessionName as string | undefined;
  if (!sName) return;
  const result = await readSubSessionResponse(sName).catch(() => ({ status: 'working' as const }));
  try {
    serverLink.send({ type: 'subsession.response', sessionName: sName, ...result });
  } catch { /* not connected */ }
}

async function handleAskAnswer(cmd: Record<string, unknown>): Promise<void> {
  const sessionName = cmd.sessionName as string | undefined;
  const answer = cmd.answer as string | undefined;
  if (!sessionName || answer === undefined) {
    logger.warn('ask.answer: missing sessionName or answer');
    return;
  }
  // ESC to dismiss the TUI dialog, then send the answer text + Enter
  await sendKey(sessionName, 'Escape');
  await new Promise<void>((r) => setTimeout(r, 150));
  await sendKeys(sessionName, answer);
}

// ── Discussion handlers ────────────────────────────────────────────────────

async function handleDiscussionStart(cmd: Record<string, unknown>, serverLink: ServerLink): Promise<void> {
  const topic = cmd.topic as string | undefined;
  const cwd = cmd.cwd as string | undefined;
  const requestId = cmd.requestId as string | undefined;
  const rawParticipants = cmd.participants as Array<Record<string, unknown>> | undefined;

  if (!topic || !rawParticipants || rawParticipants.length < 2) {
    logger.warn('discussion.start: missing required fields');
    try { serverLink.send({ type: 'discussion.error', requestId, error: 'missing_fields' }); } catch { /* ignore */ }
    return;
  }

  const { startDiscussion } = await import('./discussion-orchestrator.js');

  const id = Array.from(crypto.getRandomValues(new Uint8Array(8)))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

  const participants = rawParticipants.map((p) => ({
    agentType: (p.agentType as string) ?? 'claude-code',
    model: p.model as string | undefined,
    roleId: (p.roleId as string) ?? 'custom',
    roleLabel: p.roleLabel as string | undefined,
    rolePrompt: p.rolePrompt as string | undefined,
    sessionName: p.sessionName as string | undefined,
  }));

  try {
    const d = await startDiscussion(
      {
        id,
        serverId: '',
        topic,
        cwd: cwd ?? '',
        participants,
        maxRounds: (cmd.maxRounds as number | undefined) ?? 3,
        verdictIdx: cmd.verdictIdx as number | undefined,
      },
      (msg) => {
        try { serverLink.send(msg as Record<string, unknown>); } catch { /* not connected */ }
      },
    );

    try {
      serverLink.send({
        type: 'discussion.started',
        requestId,
        discussionId: d.id,
        topic: d.topic,
        maxRounds: d.maxRounds,
        filePath: d.filePath,
        participants: d.participants.map((p) => ({
          sessionName: p.sessionName,
          roleLabel: p.roleLabel,
          agentType: p.agentType,
          model: p.model,
        })),
      });
    } catch { /* not connected */ }
  } catch (err) {
    logger.error({ err }, 'discussion.start failed');
    const error = err instanceof Error ? err.message : String(err);
    try { serverLink.send({ type: 'discussion.error', requestId, error }); } catch { /* ignore */ }
  }
}

function handleDiscussionStatus(cmd: Record<string, unknown>, serverLink: ServerLink): void {
  const discussionId = cmd.discussionId as string | undefined;
  if (!discussionId) return;

  import('./discussion-orchestrator.js').then(({ getDiscussion }) => {
    const d = getDiscussion(discussionId);
    if (!d) {
      try { serverLink.send({ type: 'discussion.error', discussionId, error: 'not_found' }); } catch { /* ignore */ }
      return;
    }
    try {
      serverLink.send({
        type: 'discussion.update',
        discussionId: d.id,
        state: d.state,
        currentRound: d.currentRound,
        maxRounds: d.maxRounds,
        currentSpeaker: d.participants[d.currentSpeakerIdx]?.roleLabel,
      });
    } catch { /* not connected */ }
  }).catch(() => {});
}

function handleDiscussionList(serverLink: ServerLink): void {
  import('./discussion-orchestrator.js').then(({ listDiscussions }) => {
    try {
      serverLink.send({ type: 'discussion.list', discussions: listDiscussions() });
    } catch { /* not connected */ }
  }).catch(() => {});
}

async function handleDiscussionStop(cmd: Record<string, unknown>): Promise<void> {
  const discussionId = cmd.discussionId as string | undefined;
  if (!discussionId) return;
  const { stopDiscussion } = await import('./discussion-orchestrator.js');
  await stopDiscussion(discussionId).catch((e: unknown) =>
    logger.error({ err: e, discussionId }, 'discussion.stop failed'),
  );
}

/** daemon.upgrade — install latest via npm then restart service via a detached script.
 *
 * Safety rules:
 *  1. Never restart the service from within the daemon process itself (would kill us
 *     before the restart completes). Instead we write a shell script and spawn it
 *     fully detached so it outlives us.
 *  2. The script always restarts the service at the end — even if npm install failed —
 *     so the daemon always comes back up (possibly on the old version).
 *  3. A short sleep before the restart gives the current daemon time to finish
 *     sending any in-flight messages.
 */
async function handleDaemonUpgrade(): Promise<void> {
  const { spawn } = await import('child_process');
  const { writeFileSync, mkdtempSync } = await import('fs');
  const { join } = await import('path');
  const { tmpdir, homedir } = await import('os');

  logger.info('daemon.upgrade: preparing upgrade script');

  const scriptDir = mkdtempSync(join(tmpdir(), 'imcodes-upgrade-'));
  const logFile = join(scriptDir, 'upgrade.log');
  const scriptPath = join(scriptDir, 'upgrade.sh');

  // Build the platform-specific restart command.
  // We always restart regardless of whether npm install succeeded, so the daemon
  // is never left permanently dead.
  let restartCmd: string;
  if (process.platform === 'linux') {
    const userSvc = join(homedir(), '.config/systemd/user/imcodes.service');
    const { existsSync } = await import('fs');
    if (existsSync(userSvc)) {
      restartCmd = 'systemctl --user restart imcodes';
    } else {
      restartCmd = 'sudo systemctl restart imcodes';
    }
  } else if (process.platform === 'darwin') {
    const plist = join(homedir(), 'Library/LaunchAgents/imcodes.daemon.plist');
    restartCmd = `launchctl unload "${plist}" 2>/dev/null || true; sleep 1; launchctl load -w "${plist}"`;
  } else {
    logger.warn('daemon.upgrade: unsupported platform, cannot restart service');
    return;
  }

  const script = `#!/bin/bash
LOG="${logFile}"
echo "=== imcodes upgrade started at $(date) ===" >> "$LOG"

# Give the running daemon a moment to finish sending its response
sleep 3

# Attempt npm install — if it fails we still restart to keep the daemon alive
echo "Installing imcodes@latest..." >> "$LOG"
if npm install -g imcodes@latest >> "$LOG" 2>&1; then
  echo "Install succeeded." >> "$LOG"
else
  echo "Install FAILED (exit $?). Will restart on existing version." >> "$LOG"
fi

# Always restart the service
echo "Restarting service..." >> "$LOG"
${restartCmd} >> "$LOG" 2>&1 || echo "Restart command failed (exit $?)" >> "$LOG"

echo "=== upgrade script done at $(date) ===" >> "$LOG"

# Self-cleanup after 60 s
sleep 60 && rm -rf "${scriptDir}" &
`;

  writeFileSync(scriptPath, script, { mode: 0o755 });

  // Spawn fully detached — this process must NOT wait for the child
  const child = spawn('/bin/bash', [scriptPath], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();

  logger.info({ log: logFile }, 'daemon.upgrade: upgrade script spawned, will restart in ~3 s');
}

// ── File system browser ────────────────────────────────────────────────────

const FS_ALLOWED_ROOTS = [homedir()];

// ── P2P cancel/status handlers ────────────────────────────────────────────

async function handleP2pCancel(cmd: Record<string, unknown>, serverLink: ServerLink): Promise<void> {
  const runId = cmd.runId as string | undefined;
  if (!runId) return;
  const ok = await cancelP2pRun(runId, serverLink);
  try { serverLink.send({ type: 'p2p.cancel_response', runId, ok }); } catch { /* ignore */ }
}

async function handleP2pStatus(cmd: Record<string, unknown>, serverLink: ServerLink): Promise<void> {
  const runId = cmd.runId as string | undefined;
  if (runId) {
    const run = getP2pRun(runId);
    try { serverLink.send({ type: 'p2p.status_response', runId, run: run ?? null }); } catch { /* ignore */ }
  } else {
    const runs = listP2pRuns();
    try { serverLink.send({ type: 'p2p.status_response', runs }); } catch { /* ignore */ }
  }
}

// ── File search for @ picker ──────────────────────────────────────────────

const FILE_SEARCH_EXCLUDES = new Set([
  'node_modules', '.git', 'venv', '__pycache__', '.venv',
  'dist', 'build', '.next', '.nuxt', 'vendor', 'target',
]);

const FILE_SEARCH_MAX = 20;

async function handleFileSearch(cmd: Record<string, unknown>, serverLink: ServerLink): Promise<void> {
  const query = (cmd.query as string ?? '').trim().toLowerCase();
  const projectDir = cmd.projectDir as string | undefined;
  const requestId = cmd.requestId as string | undefined;
  if (!requestId || !projectDir) return;

  try {
    const results: Array<{ path: string; basename: string }> = [];
    const queryBase = query.split('/').pop() ?? query;

    async function walk(dir: string, rel: string): Promise<void> {
      if (results.length >= 200) return; // hard cap during walk
      let entries: import('fs').Dirent[];
      try {
        entries = await fsReaddir(dir, { withFileTypes: true });
      } catch { return; }
      for (const entry of entries) {
        if (FILE_SEARCH_EXCLUDES.has(entry.name)) continue;
        const relPath = rel ? `${rel}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          if (entry.name.startsWith('.') && entry.name !== '.github') continue;
          await walk(nodePath.join(dir, entry.name), relPath);
        } else if (entry.isFile()) {
          if (!query || relPath.toLowerCase().includes(query)) {
            results.push({ path: relPath, basename: entry.name });
          }
        }
      }
    }

    await walk(projectDir, '');

    // Sort: basename match first, then path match
    results.sort((a, b) => {
      const aBase = a.basename.toLowerCase().includes(queryBase) ? 0 : 1;
      const bBase = b.basename.toLowerCase().includes(queryBase) ? 0 : 1;
      if (aBase !== bBase) return aBase - bBase;
      return a.path.localeCompare(b.path);
    });

    const top = results.slice(0, FILE_SEARCH_MAX).map((r) => r.path);
    try { serverLink.send({ type: 'file.search_response', requestId, results: top }); } catch { /* ignore */ }
  } catch (err) {
    try { serverLink.send({ type: 'file.search_response', requestId, results: [], error: String(err) }); } catch { /* ignore */ }
  }
}

async function handleFsList(cmd: Record<string, unknown>, serverLink: ServerLink): Promise<void> {
  const rawPath = cmd.path as string | undefined;
  const requestId = cmd.requestId as string | undefined;
  const includeFiles = cmd.includeFiles === true;
  const includeMetadata = cmd.includeMetadata === true;
  if (!rawPath || !requestId) return;

  const expanded = rawPath.startsWith('~') ? rawPath.replace(/^~/, homedir()) : rawPath;
  const resolved = nodePath.resolve(expanded);

  try {
    const real = await fsRealpath(resolved);
    const allowed = FS_ALLOWED_ROOTS.some((root) => real === root || real.startsWith(root + nodePath.sep));
    if (!allowed) {
      try { serverLink.send({ type: 'fs.ls_response', requestId, path: rawPath, resolvedPath: real, status: 'error', error: 'forbidden_path' }); } catch { /* ignore */ }
      return;
    }

    const dirents = await fsReaddir(real, { withFileTypes: true });
    const filtered = dirents.filter((d) => d.isDirectory() || (includeFiles && d.isFile()));

    const entries = await Promise.all(filtered.map(async (d) => {
      const entry: Record<string, unknown> = { name: d.name, isDir: d.isDirectory(), hidden: d.name.startsWith('.') };
      if (includeMetadata && !d.isDirectory()) {
        try {
          const filePath = nodePath.join(real, d.name);
          const fileStat = await fsStat(filePath);
          entry.size = fileStat.size;
          const ext = nodePath.extname(d.name).toLowerCase().slice(1);
          entry.mime = MIME_MAP[ext] || undefined;
          // Generate a short-lived download handle
          const handle = createProjectFileHandle(filePath, d.name, entry.mime as string | undefined, fileStat.size);
          entry.downloadId = handle.id;
        } catch { /* stat failed, skip metadata */ }
      }
      return entry;
    }));

    entries.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      if (a.hidden !== b.hidden) return (a.hidden ? 1 : 0) - (b.hidden ? 1 : 0);
      return (a.name as string).localeCompare(b.name as string);
    });

    try { serverLink.send({ type: 'fs.ls_response', requestId, path: rawPath, resolvedPath: real, status: 'ok', entries }); } catch { /* ignore */ }
  } catch (err) {
    try { serverLink.send({ type: 'fs.ls_response', requestId, path: rawPath, status: 'error', error: err instanceof Error ? err.message : String(err) }); } catch { /* ignore */ }
  }
}

const FS_READ_SIZE_LIMIT = 512 * 1024; // 512 KB

async function handleFsRead(cmd: Record<string, unknown>, serverLink: ServerLink): Promise<void> {
  const rawPath = cmd.path as string | undefined;
  const requestId = cmd.requestId as string | undefined;
  if (!rawPath || !requestId) return;

  const expanded = rawPath.startsWith('~') ? rawPath.replace(/^~/, homedir()) : rawPath;
  const resolved = nodePath.resolve(expanded);

  try {
    const real = await fsRealpath(resolved);
    const allowed = FS_ALLOWED_ROOTS.some((root) => real === root || real.startsWith(root + nodePath.sep));
    if (!allowed) {
      try { serverLink.send({ type: 'fs.read_response', requestId, path: rawPath, resolvedPath: real, status: 'error', error: 'forbidden_path' }); } catch { /* ignore */ }
      return;
    }

    const stats = await fsStat(real);

    // Image files: send as base64 with a higher size limit (5 MB)
    const ext = nodePath.extname(real).toLowerCase().slice(1);
    const IMAGE_MIME: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', ico: 'image/x-icon', bmp: 'image/bmp', svg: 'image/svg+xml' };
    const mimeType = IMAGE_MIME[ext];
    const sizeLimit = mimeType ? 5 * 1024 * 1024 : FS_READ_SIZE_LIMIT;

    // Always generate a download handle so the file can be downloaded even if preview fails
    const fileName = nodePath.basename(real);
    const handle = createProjectFileHandle(real, fileName, mimeType || MIME_MAP[ext], stats.size);

    if (stats.size > sizeLimit) {
      try { serverLink.send({ type: 'fs.read_response', requestId, path: rawPath, resolvedPath: real, status: 'error', error: 'file_too_large', previewReason: 'too_large', downloadId: handle.id }); } catch { /* ignore */ }
      return;
    }

    if (mimeType) {
      const buf = await fsReadFileRaw(real);
      const content = buf.toString('base64');
      try { serverLink.send({ type: 'fs.read_response', requestId, path: rawPath, resolvedPath: real, status: 'ok', content, encoding: 'base64', mimeType, downloadId: handle.id }); } catch { /* ignore */ }
    } else {
      const content = await fsReadFileRaw(real, 'utf-8');
      // Check for binary content
      const sample = content.slice(0, 8192);
      if (sample.includes('\0')) {
        try { serverLink.send({ type: 'fs.read_response', requestId, path: rawPath, resolvedPath: real, status: 'error', error: 'binary_file', previewReason: 'binary', downloadId: handle.id }); } catch { /* ignore */ }
        return;
      }
      try { serverLink.send({ type: 'fs.read_response', requestId, path: rawPath, resolvedPath: real, status: 'ok', content, downloadId: handle.id }); } catch { /* ignore */ }
    }
  } catch (err) {
    try { serverLink.send({ type: 'fs.read_response', requestId, path: rawPath, status: 'error', error: err instanceof Error ? err.message : String(err) }); } catch { /* ignore */ }
  }
}

/** fs.git_status — return git modified file list for a directory */
async function handleFsGitStatus(cmd: Record<string, unknown>, serverLink: ServerLink): Promise<void> {
  const rawPath = cmd.path as string | undefined;
  const requestId = cmd.requestId as string | undefined;
  if (!rawPath || !requestId) return;

  const expanded = rawPath.startsWith('~') ? rawPath.replace(/^~/, homedir()) : rawPath;
  const resolved = nodePath.resolve(expanded);

  try {
    const real = await fsRealpath(resolved);
    const allowed = FS_ALLOWED_ROOTS.some((root) => real === root || real.startsWith(root + nodePath.sep));
    if (!allowed) {
      try { serverLink.send({ type: 'fs.git_status_response', requestId, path: rawPath, status: 'error', error: 'forbidden_path' }); } catch { /* ignore */ }
      return;
    }

    const { stdout } = await execAsync('git status --porcelain -u', { cwd: real, timeout: 5000 });
    const files: Array<{ path: string; code: string }> = [];
    for (const line of stdout.split('\n')) {
      if (!line.trim()) continue;
      const code = line.slice(0, 2).trim();
      const filePath = line.slice(3).trim().replace(/^"(.*)"$/, '$1'); // unquote if needed
      files.push({ path: nodePath.join(real, filePath), code });
    }
    try { serverLink.send({ type: 'fs.git_status_response', requestId, path: rawPath, resolvedPath: real, status: 'ok', files }); } catch { /* ignore */ }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // git not available or not a repo — return empty ok (not an error for the UI)
    const isNotRepo = msg.includes('not a git repository') || msg.includes('128');
    try { serverLink.send({ type: 'fs.git_status_response', requestId, path: rawPath, status: isNotRepo ? 'ok' : 'error', files: [], error: isNotRepo ? undefined : msg }); } catch { /* ignore */ }
  }
}

/** fs.git_diff — return git diff for a specific file */
async function handleFsGitDiff(cmd: Record<string, unknown>, serverLink: ServerLink): Promise<void> {
  const rawPath = cmd.path as string | undefined;
  const requestId = cmd.requestId as string | undefined;
  if (!rawPath || !requestId) return;

  const expanded = rawPath.startsWith('~') ? rawPath.replace(/^~/, homedir()) : rawPath;
  const resolved = nodePath.resolve(expanded);

  try {
    const real = await fsRealpath(resolved);
    const allowed = FS_ALLOWED_ROOTS.some((root) => real === root || real.startsWith(root + nodePath.sep));
    if (!allowed) {
      try { serverLink.send({ type: 'fs.git_diff_response', requestId, path: rawPath, status: 'error', error: 'forbidden_path' }); } catch { /* ignore */ }
      return;
    }

    const dir = nodePath.dirname(real);
    // Try staged+unstaged diff vs HEAD; fall back to index diff; then untracked diff
    let diff = '';
    try {
      const { stdout } = await execAsync(`git diff HEAD -- ${JSON.stringify(real)}`, { cwd: dir, timeout: 5000 });
      diff = stdout;
    } catch { /* ignore */ }
    if (!diff) {
      try {
        const { stdout } = await execAsync(`git diff -- ${JSON.stringify(real)}`, { cwd: dir, timeout: 5000 });
        diff = stdout;
      } catch { /* ignore */ }
    }
    // Untracked files: no diff (nothing meaningful to compare against)
    try { serverLink.send({ type: 'fs.git_diff_response', requestId, path: rawPath, resolvedPath: real, status: 'ok', diff }); } catch { /* ignore */ }
  } catch (err) {
    try { serverLink.send({ type: 'fs.git_diff_response', requestId, path: rawPath, status: 'error', error: err instanceof Error ? err.message : String(err) }); } catch { /* ignore */ }
  }
}

/** server.delete — remove credentials + service, then exit */
async function handleServerDelete(): Promise<void> {
  const { homedir } = await import('os');
  const { join } = await import('path');
  const { unlink, access } = await import('fs/promises');
  const { execSync } = await import('child_process');

  logger.info('server.delete received — self-destructing daemon');

  const credsPath = join(homedir(), '.imcodes', 'server.json');
  try { await unlink(credsPath); } catch { /* already gone */ }

  // Uninstall system service so daemon doesn't restart
  if (process.platform === 'darwin') {
    const plistPath = join(homedir(), 'Library', 'LaunchAgents', 'imcodes.daemon.plist');
    try {
      await access(plistPath);
      execSync(`launchctl unload "${plistPath}" 2>/dev/null`, { stdio: 'ignore' });
      await unlink(plistPath);
    } catch { /* not installed or already removed */ }
  } else if (process.platform === 'linux') {
    try {
      execSync('systemctl --user disable --now imcodes 2>/dev/null', { stdio: 'ignore' });
    } catch { /* not installed */ }
  }

  logger.info('Daemon unbound — exiting');
  // Give the log a moment to flush before exiting
  setTimeout(() => process.exit(0), 500);
}
