/**
 * Handle commands from the web UI and inbound chat messages via ServerLink.
 * Commands arrive as JSON objects with a `type` field.
 */
import { startProject, stopProject, teardownProject, getTransportRuntime, launchTransportSession, isProviderSessionBound, persistSessionRecord, relaunchSessionWithSettings, type ProjectConfig } from '../agent/session-manager.js';
import { isTransportAgent } from '../agent/detect.js';
import { sendKeys, sendKeysDelayedEnter, sendRawInput, resizeSession, sendKey, getPaneStartCommand } from '../agent/tmux.js';
import { listSessions, getSession, upsertSession, removeSession, type SessionRecord } from '../store/session-store.js';
import { routeMessage, type InboundMessage, type RouterContext } from '../router/message-router.js';
import { terminalStreamer, type StreamSubscriber } from './terminal-streamer.js';
import type { ServerLink } from './server-link.js';
import { timelineEmitter } from './timeline-emitter.js';
import { timelineStore } from './timeline-store.js';
import { emitSessionInlineError } from './session-error.js';
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
import { readdir as fsReaddir, realpath as fsRealpath, readFile as fsReadFileRaw, stat as fsStat, writeFile as fsWriteFile } from 'node:fs/promises';
import * as nodePath from 'node:path';
import { exec as execCb } from 'node:child_process';
import { promisify } from 'node:util';
const execAsync = promisify(execCb);
import { startP2pRun, cancelP2pRun, getP2pRun, listP2pRuns, serializeP2pRun, type P2pTarget } from './p2p-orchestrator.js';
import { getComboRoundCount, parseModePipeline, P2P_CONFIG_MODE, type P2pSessionConfig } from '../../shared/p2p-modes.js';
import type { P2pAdvancedRound, P2pContextReducerConfig } from '../../shared/p2p-advanced.js';
import { CRON_MSG } from '../../shared/cron-types.js';
import { executeCronJob } from './cron-executor.js';
import { TRANSPORT_MSG } from '../../shared/transport-events.js';
import { copyFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { ensureImcDir, imcSubDir } from '../util/imc-dir.js';
import { buildWindowsCleanupScript, buildWindowsCleanupVbs, buildWindowsUpgradeBatch, buildWindowsUpgradeVbs } from '../util/windows-upgrade-script.js';
import { UPGRADE_LOCK_FILE, encodeVbsAsUtf16, encodeCmdAsUtf8Bom } from '../util/windows-launch-artifacts.js';
import { registerTempFile, removeTrackedTempFile } from '../store/temp-file-store.js';
import { sanitizeProjectName } from '../../shared/sanitize-project-name.js';
import { CODEX_MODEL_IDS, normalizeClaudeCodeModelId } from '../shared/models/options.js';
import { getClaudeSdkRuntimeConfig, normalizeClaudeSdkModelForProvider } from '../agent/sdk-runtime-config.js';
import { getCodexRuntimeConfig } from '../agent/codex-runtime-config.js';
import { P2P_TERMINAL_RUN_STATUSES } from '../../shared/p2p-status.js';
import { DAEMON_MSG } from '../../shared/daemon-events.js';
import {
  CLAUDE_SDK_EFFORT_LEVELS,
  CODEX_SDK_EFFORT_LEVELS,
  DEFAULT_TRANSPORT_EFFORT,
  OPENCLAW_THINKING_LEVELS,
  QWEN_EFFORT_LEVELS,
  isTransportEffortLevel,
  type TransportEffortLevel,
} from '../../shared/effort-levels.js';

/**
 * Build a unified subsession.sync payload from the session store record.
 * Ensures all fields (including Qwen metadata) are always sent — no more
 * scattered inline objects with different field subsets.
 *
 * For Qwen sub-sessions, display metadata (planLabel, quotaLabel, quotaUsageLabel)
 * is computed FRESH (same as buildSessionList for main sessions) rather than
 * reading stale values from the session store.
 */
async function buildSubSessionSync(id: string, overrides?: Partial<SessionRecord>): Promise<Record<string, unknown>> {
  const sessionName = subSessionName(id);
  const record = getSession(sessionName);
  const r = { ...record, ...overrides };

  // Compute transport display metadata fresh — matches session-list.ts hydration logic.
  // The session store may have stale or missing metadata during early launch/update windows.
  const freshDisplay: Partial<Pick<SessionRecord, 'modelDisplay' | 'planLabel' | 'quotaLabel' | 'quotaUsageLabel' | 'quotaMeta'>> = r?.agentType === 'qwen'
    ? getQwenDisplayMetadata({
        model: r?.qwenModel,
        authType: r?.qwenAuthType,
        authLimit: r?.qwenAuthLimit,
        quotaUsageLabel: r?.qwenAuthType === 'qwen-oauth' ? getQwenOAuthQuotaUsageLabel() : undefined,
      })
    : r?.agentType === 'claude-code-sdk'
      ? await getClaudeSdkRuntimeConfig().catch(() => ({}))
      : r?.agentType === 'codex-sdk'
        ? await getCodexRuntimeConfig().catch(() => ({}))
    : {};

  return {
    type: 'subsession.sync',
    id,
    sessionType: r?.agentType ?? null,
    cwd: r?.projectDir ?? null,
    shellBin: null,
    ccSessionId: r?.ccSessionId ?? null,
    geminiSessionId: r?.geminiSessionId ?? null,
    parentSession: r?.parentSession ?? null,
    ccPresetId: r?.ccPreset ?? null,
    description: r?.description ?? null,
    label: r?.label ?? null,
    runtimeType: r?.runtimeType ?? null,
    providerId: r?.providerId ?? null,
    providerSessionId: r?.providerSessionId ?? null,
    requestedModel: r?.requestedModel ?? null,
    activeModel: r?.activeModel ?? r?.modelDisplay ?? null,
    transportConfig: r?.transportConfig ?? null,
    // Qwen metadata — freshly computed display fields + stored config fields
    qwenModel: r?.qwenModel ?? null,
    qwenAuthType: r?.qwenAuthType ?? null,
    qwenAuthLimit: r?.qwenAuthLimit ?? null,
    qwenAvailableModels: r?.qwenAvailableModels ?? null,
    modelDisplay: freshDisplay.modelDisplay ?? r?.modelDisplay ?? null,
    planLabel: freshDisplay.planLabel ?? r?.planLabel ?? null,
    quotaLabel: freshDisplay.quotaLabel ?? r?.quotaLabel ?? null,
    quotaUsageLabel: freshDisplay.quotaUsageLabel ?? r?.quotaUsageLabel ?? null,
    quotaMeta: freshDisplay.quotaMeta ?? r?.quotaMeta ?? null,
    effort: r?.effort ?? null,
  };
}

function supportsEffort(agentType: string | undefined): agentType is 'claude-code-sdk' | 'codex-sdk' | 'openclaw' | 'qwen' {
  return agentType === 'claude-code-sdk' || agentType === 'codex-sdk' || agentType === 'openclaw' || agentType === 'qwen';
}

function getSupportedEffortLevels(agentType: string | undefined): readonly TransportEffortLevel[] {
  return agentType === 'claude-code-sdk'
    ? CLAUDE_SDK_EFFORT_LEVELS
    : agentType === 'codex-sdk'
      ? CODEX_SDK_EFFORT_LEVELS
      : agentType === 'qwen'
        ? QWEN_EFFORT_LEVELS
      : agentType === 'openclaw'
        ? OPENCLAW_THINKING_LEVELS
        : [];
}

function getDefaultThinkingLevel(agentType: string | undefined): TransportEffortLevel | undefined {
  return supportsEffort(agentType) ? DEFAULT_TRANSPORT_EFFORT : undefined;
}

async function syncSubSessionIfNeeded(sessionName: string, serverLink: ServerLink): Promise<void> {
  if (!sessionName.startsWith('deck_sub_')) return;
  const subId = sessionName.slice('deck_sub_'.length);
  try { serverLink.send(await buildSubSessionSync(subId)); } catch { /* ignore */ }
}

/**
 * For sandboxed agents (Gemini, Codex): copy files from ~/.imcodes/ to
 * the session's project .imc/refs/ so the agent can access them.
 * Rewrites @paths in the message text. Auto-deletes copies after 30 min and
 * persists cleanup metadata in ~/.imcodes/temp-files.json.
 */
async function rewritePathsForSandbox(sessionName: string, text: string): Promise<string> {
  const record = getSession(sessionName);
  const projectDir = record?.projectDir;
  if (!projectDir) return text;

  const imcodesDir = nodePath.join(homedir(), '.imcodes');
  // Match @paths that point into ~/.imcodes/
  const pathRegex = new RegExp(`@(${imcodesDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[/\\\\][^\\s]+)`, 'g');

  let result = text;
  const matches = [...text.matchAll(pathRegex)];
  if (matches.length === 0) return text;

  const refsDir = await ensureImcDir(projectDir, 'refs');

  for (const match of matches) {
    const srcPath = match[1];
    const filename = nodePath.basename(srcPath);
    // Unique prefix prevents collision when multiple sessions copy the same file concurrently
    const uniqueName = `${Date.now()}_${Math.random().toString(36).slice(2, 6)}_${filename}`;
    const destPath = nodePath.join(refsDir, uniqueName);
    try {
      await copyFile(srcPath, destPath);
      const now = Date.now();
      await registerTempFile({
        path: destPath,
        createdAt: now,
        expiresAt: now + (30 * 60_000),
        reason: 'sandbox-ref-copy',
      });
      result = result.replace(`@${srcPath}`, `@${destPath}`);
      // Auto-delete after 30 minutes
      setTimeout(async () => {
        try { const { unlink } = await import('node:fs/promises'); await unlink(destPath); } catch { /* already deleted */ }
        try { await removeTrackedTempFile(destPath); } catch { /* ignore */ }
      }, 30 * 60_000);
    } catch (err) {
      logger.warn({ src: srcPath, dest: destPath, err }, 'Failed to copy file for sandboxed agent');
    }
  }

  return result;
}
import { handleRepoCommand } from './repo-handler.js';
import { handleFileUpload, handleFileDownload, createProjectFileHandle, lookupAttachment } from './file-transfer-handler.js';
import { REPO_MSG } from '../shared/repo-types.js';
import { handlePreviewCommand } from './preview-relay.js';
import { PREVIEW_MSG } from '../../shared/preview-types.js';

import { resolveContextWindow } from '../util/model-context.js';
import { QWEN_MODEL_IDS } from '../../shared/qwen-models.js';
import { getQwenRuntimeConfig } from '../agent/qwen-runtime-config.js';
import { getQwenDisplayMetadata } from '../agent/provider-display.js';
import { buildSessionList } from './session-list.js';
import { getQwenOAuthQuotaUsageLabel, recordQwenOAuthRequest } from '../agent/provider-quota.js';
import { listProviderSessions as listProviderSessionsImpl } from './provider-sessions.js';

function describeTransportSendError(err: unknown): string {
  if (err && typeof err === 'object') {
    const record = err as { message?: unknown };
    if (typeof record.message === 'string' && record.message.trim()) return record.message;
  }
  return err instanceof Error ? err.message : String(err);
}

const pendingSessionRelaunches = new Map<string, Promise<void>>();

function trackPendingSessionRelaunch(sessionName: string, pending: Promise<void>): Promise<void> {
  pendingSessionRelaunches.set(sessionName, pending);
  void pending.then(() => {
    if (pendingSessionRelaunches.get(sessionName) === pending) pendingSessionRelaunches.delete(sessionName);
  }, () => {
    if (pendingSessionRelaunches.get(sessionName) === pending) pendingSessionRelaunches.delete(sessionName);
  });
  return pending;
}

async function waitForPendingSessionRelaunch(sessionName: string): Promise<void> {
  const pending = pendingSessionRelaunches.get(sessionName);
  if (!pending) return;
  try {
    await pending;
  } catch {
    // Restart path already emitted its own error and corrective session sync.
  }
}

function refreshQwenQuotaUsageLabels(serverLink?: ServerLink): void {
  const usageLabel = getQwenOAuthQuotaUsageLabel();
  for (const session of listSessions()) {
    if (session.agentType !== 'qwen' || session.qwenAuthType !== 'qwen-oauth') continue;
    upsertSession({
      ...session,
      quotaUsageLabel: usageLabel,
      updatedAt: Date.now(),
    });
    // Re-sync sub-sessions so their quota usage labels update in the browser
    if (session.name.startsWith('deck_sub_')) {
      const subId = session.name.replace(/^deck_sub_/, '');
      if (serverLink) void buildSubSessionSync(subId).then((payload) => {
        serverLink.send(payload);
      }).catch(() => { /* not connected */ });
    }
  }
  if (serverLink) void handleGetSessions(serverLink);
}

export async function refreshCodexQuotaMetadata(serverLink?: ServerLink): Promise<void> {
  const sessions = listSessions();
  const codexSessions = sessions.filter((session) => session.agentType === 'codex' || session.agentType === 'codex-sdk');
  if (codexSessions.length === 0) return;

  if (serverLink) {
    await handleGetSessions(serverLink);
  } else {
    await buildSessionList();
  }

  if (!serverLink) return;
  for (const session of codexSessions) {
    if (!session.name.startsWith('deck_sub_')) continue;
    const subId = session.name.replace(/^deck_sub_/, '');
    try {
      serverLink.send(await buildSubSessionSync(subId));
    } catch {
      // not connected
    }
  }
}

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

/**
 * Expand @@all — find all active sessions in the same domain as the initiator.
 *
 * Rules:
 * - If initiator is a main session (deck_{project}_{role}):
 *   select its direct sub-sessions + same-project main sessions
 * - If initiator is a sub-session (deck_sub_*):
 *   select its siblings (same parentSession) + parent
 * - Always skip: initiator itself, stopped sessions
 */
function expandAllTargets(initiatorName: string, mode: string, excludeSameType = false, sessionConfig?: P2pSessionConfig): P2pTarget[] {
  const initiator = getSession(initiatorName);
  const all = listSessions();
  const targets: P2pTarget[] = [];

  const NON_DISCUSSABLE = new Set(['shell', 'script']);

  for (const s of all) {
    if (s.name === initiatorName) continue;
    if (s.state === 'stopped') continue;
    if (NON_DISCUSSABLE.has(s.agentType ?? '')) continue;
    if (excludeSameType && initiator?.agentType && s.agentType === initiator.agentType) continue;

    let inDomain = false;
    if (initiatorName.startsWith('deck_sub_')) {
      const isSibling = s.parentSession && s.parentSession === initiator?.parentSession;
      const isParent = s.name === initiator?.parentSession;
      inDomain = !!(isSibling || isParent);
    } else {
      const isChild = s.parentSession === initiatorName;
      const isSameProject = !s.name.startsWith('deck_sub_') && initiator?.projectName && s.projectName === initiator.projectName;
      inDomain = !!(isChild || isSameProject);
    }

    if (!inDomain) continue;

    if (sessionConfig) {
      const entry = sessionConfig[s.name];
      if (!entry || !entry.enabled) continue;        // strict: missing = excluded
      if (entry.mode === 'skip') continue;
      targets.push({ session: s.name, mode: mode === P2P_CONFIG_MODE ? entry.mode : mode });
    } else {
      targets.push({ session: s.name, mode });
    }
  }
  // Sort deterministically by session name for predictable ordering
  targets.sort((a, b) => a.session.localeCompare(b.session));
  return targets;
}

// Session names: alphanumeric + underscore only (matches deck_{project}_{role} and deck_sub_{id} patterns)
const SESSION_NAME_RE = /[a-zA-Z0-9_]+/;
const SINGLE_MODES = new Set(['audit', 'review', 'plan', 'brainstorm', 'discuss', 'config']);
const VALID_MODES = SINGLE_MODES; // alias for parseAtTokens (individual session tokens always use single modes)

/** Validate a mode string — single mode or combo pipeline (e.g. "brainstorm>discuss>plan"). */
function isValidP2pMode(mode: string): boolean {
  if (SINGLE_MODES.has(mode)) return true;
  // Combo pipeline: every segment must be a known mode (not config)
  const pipeline = parseModePipeline(mode);
  return pipeline.length > 1 && pipeline.every((m) => SINGLE_MODES.has(m) && m !== 'config');
}
const DISCUSS_TOKEN_RE = /@@discuss\(([^,]+),\s*([^)]+)\)/g;
// @@all(mode) or @@all(mode, exclude-same-type)
const ALL_TOKEN_RE = /@@all\(([^)]+)\)/g;
const P2P_CONFIG_TOKEN_RE = /@@p2p-config\([^)]*\)/g;
const FILE_TOKEN_RE = /@((?:[a-zA-Z0-9_.\-/]+\/)*[a-zA-Z0-9_.\-]+\.[a-zA-Z0-9]+)/g;

export interface ParsedTokens {
  agents: P2pTarget[];
  files: string[];
  cleanText: string;
  /** True if @@all was used — caller must expand with active sessions. */
  expandAll?: { mode: string; excludeSameType?: boolean; rounds?: number };
  /** True if @@discuss tokens were present but ALL failed validation. */
  hadDiscussTokens?: boolean;
}

function parseAllModeSpec(raw: string): { mode: string; rounds?: number; excludeSameType?: boolean } | null {
  const parts = raw.split(',').map((s) => s.trim()).filter(Boolean);
  if (parts.length === 0) return null;
  const excludeSameType = parts.includes('exclude-same-type');
  const first = parts[0] ?? '';
  const roundsMatch = /^(.*?)\s*[×x]\s*(\d+)\s*$/.exec(first);
  const mode = (roundsMatch?.[1] ?? first).trim();
  const rounds = roundsMatch ? Math.max(1, Math.min(parseInt(roundsMatch[2] ?? '1', 10) || 1, 6)) : undefined;
  if (!isValidP2pMode(mode)) return null;
  return { mode, rounds, excludeSameType };
}

export function parseAtTokens(text: string): ParsedTokens {
  const agents: P2pTarget[] = [];
  const files: string[] = [];
  let expandAll: { mode: string; excludeSameType?: boolean; rounds?: number } | undefined;

  // Check for @@all(mode[, flags]) first
  const allMatch = ALL_TOKEN_RE.exec(text);
  if (allMatch) {
    const parsed = parseAllModeSpec(allMatch[1]);
    if (parsed) expandAll = parsed;
  }
  ALL_TOKEN_RE.lastIndex = 0; // reset regex state

  // Validate session names and modes in @@discuss tokens
  const validSessions = new Set(listSessions().map((s) => s.name));
  let discussTokenCount = 0;
  for (const m of text.matchAll(DISCUSS_TOKEN_RE)) {
    discussTokenCount++;
    const session = m[1].trim();
    const mode = m[2].trim();
    if (SESSION_NAME_RE.test(session) && validSessions.has(session) && VALID_MODES.has(mode)) {
      agents.push({ session, mode });
    } else {
      logger.warn({ session, mode, valid: validSessions.has(session), modeValid: VALID_MODES.has(mode) }, 'parseAtTokens: @@discuss token skipped — session not in store or invalid mode');
    }
  }

  // Remove @@all, @@discuss, and @@p2p-config tokens first so @file regex doesn't partially match them
  let withoutCx = text.replace(ALL_TOKEN_RE, '').replace(DISCUSS_TOKEN_RE, '').replace(P2P_CONFIG_TOKEN_RE, '');
  for (const m of withoutCx.matchAll(FILE_TOKEN_RE)) {
    files.push(m[1]);
  }

  const cleanText = withoutCx.replace(FILE_TOKEN_RE, '').replace(/\s+/g, ' ').trim();
  const hadDiscussTokens = discussTokenCount > 0 && agents.length === 0;
  return { agents, files, cleanText, expandAll, hadDiscussTokens };
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
  if (p === '~') return homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return homedir() + p.slice(1);
  return p;
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
      void handleStop(cmd, serverLink);
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
      void handleTimelineHistory(cmd, serverLink);
      break;
    case 'chat.subscribe':
      void handleChatSubscribeReplay(cmd, serverLink);
      break;
    case 'subsession.start':
      void handleSubSessionStart(cmd, serverLink);
      break;
    case 'subsession.stop':
      void handleSubSessionStop(cmd, serverLink);
      break;
    case 'subsession.restart':
      void handleSubSessionRestart(cmd, serverLink);
      break;
    case 'subsession.rebuild_all':
      void handleSubSessionRebuildAll(cmd, serverLink);
      break;
    case 'subsession.detect_shells':
      void handleSubSessionDetectShells(serverLink);
      break;
    case 'subsession.read_response':
      void handleSubSessionReadResponse(cmd, serverLink);
      break;
    case 'subsession.set_model':
      void handleSubSessionSetModel(cmd, serverLink);
      break;
    case 'subsession.rename': {
      const sName = cmd.sessionName as string | undefined;
      const label = cmd.label as string | undefined;
      if (sName && label !== undefined) {
        const record = getSession(sName);
        if (record) {
          upsertSession({ ...record, label, updatedAt: Date.now() });
          logger.info({ sessionName: sName, label }, 'subsession.rename: label updated');
        }
      }
      break;
    }
    case 'ask.answer':
      void handleAskAnswer(cmd);
      break;
    case 'discussion.start':
      void handleDiscussionStart(cmd, serverLink);
      break;
    case 'discussion.status':
      handleDiscussionStatus(cmd, serverLink);
      break;
    case 'p2p.list_discussions':
      void handleP2pListDiscussions(cmd, serverLink);
      break;
    case 'p2p.read_discussion':
      void handleP2pReadDiscussion(cmd, serverLink);
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
      void handleDaemonUpgrade(cmd.targetVersion as string | undefined, serverLink);
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
    case 'fs.mkdir':
      void handleFsMkdir(cmd, serverLink);
      break;
    case 'fs.write':
      void handleFsWrite(cmd, serverLink);
      break;
    case 'p2p.cancel':
      void handleP2pCancel(cmd, serverLink);
      break;
    case 'p2p.status':
      void handleP2pStatus(cmd, serverLink);
      break;
    case 'cc.presets.list':
      void handleCcPresetsList(serverLink);
      break;
    case 'cc.presets.save':
      void handleCcPresetsSave(cmd, serverLink);
      break;
    case 'file.upload':
      void handleFileUpload(cmd, serverLink);
      break;
    case 'file.download':
      void handleFileDownload(cmd, serverLink);
      break;
    case TRANSPORT_MSG.LIST_SESSIONS:
      void handleListProviderSessions(cmd, serverLink);
      break;
    case CRON_MSG.DISPATCH:
      void executeCronJob(cmd as unknown as import('../../shared/cron-types.js').CronDispatchMessage, serverLink);
      break;
    case PREVIEW_MSG.REQUEST:
    case PREVIEW_MSG.REQUEST_END:
    case PREVIEW_MSG.CLOSE:
    case PREVIEW_MSG.ABORT:
    case PREVIEW_MSG.WS_OPEN:
    case PREVIEW_MSG.WS_CLOSE:
      if (handlePreviewCommand(cmd, serverLink)) break;
      break;
    case 'auth_ok':
    case 'heartbeat':
    case 'heartbeat_ack':
    case 'ping':
    case 'pong':
      // Expected internal messages, ignore silently
      break;
    case 'openclaw.list_sessions':
      void (async () => {
        try {
          const sessions = await listProviderSessions('openclaw');
          serverLink.send({ type: 'openclaw.sessions_response', sessions });
        } catch (err) {
          logger.warn({ err }, 'openclaw.list_sessions failed');
          serverLink.send({ type: 'openclaw.sessions_response', sessions: [] });
        }
      })();
      break;
    case REPO_MSG.DETECT:
    case REPO_MSG.LIST_ISSUES:
    case REPO_MSG.LIST_PRS:
    case REPO_MSG.LIST_BRANCHES:
    case REPO_MSG.LIST_COMMITS:
    case REPO_MSG.LIST_ACTIONS:
    case REPO_MSG.ACTION_DETAIL:
    case REPO_MSG.COMMIT_DETAIL:
    case REPO_MSG.PR_DETAIL:
    case REPO_MSG.ISSUE_DETAIL:
      void handleRepoCommand(cmd, serverLink);
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

// sanitizeProjectName moved to shared/sanitize-project-name.ts

async function handleStart(cmd: Record<string, unknown>, serverLink: ServerLink): Promise<void> {
  const rawProject = cmd.project as string | undefined;
  const agentType = (cmd.agentType as string) || 'claude-code';
  const dir = expandTilde((cmd.dir as string) || '~');
  const ccPresetName = cmd.ccPreset as string | undefined;
  const ccInitPrompt = cmd.ccInitPrompt as string | undefined;
  const requestedEffort: unknown = cmd.thinking ?? cmd.effort;
  const effort = isTransportEffortLevel(requestedEffort)
    ? requestedEffort
    : getDefaultThinkingLevel(agentType);

  if (!rawProject) {
    logger.warn('session.start: missing project name');
    return;
  }
  const project = sanitizeProjectName(rawProject);
  // Preserve original name as label when sanitization changes it (e.g. Chinese characters)
  const label = project !== rawProject.trim().toLowerCase() ? rawProject.trim() : undefined;

  try {
    // Resolve CC env preset if specified
    let extraEnv: Record<string, string> | undefined;
    if (ccPresetName && (agentType === 'claude-code' || agentType === 'claude-code-sdk')) {
      const { resolvePresetEnv } = await import('./cc-presets.js');
      extraEnv = await resolvePresetEnv(ccPresetName);
    }

    // Reject duplicate main-session starts for an existing project/session namespace.
    const existingByProject = listSessions(project).filter((s) => s.role === 'brain' && s.state !== 'stopped');
    if (existingByProject.length > 0) {
      const message = `Session already exists for project ${project}. Stop or restart it instead of starting a duplicate.`;
      logger.warn({ project, dir, agentType, existing: existingByProject.map((s) => s.name) }, 'session.start rejected because project already has an active main session');
      try { serverLink.send({ type: 'session.error', project, message }); } catch { /* ignore */ }
      return;
    }
    if (agentType === 'claude-code-sdk' || agentType === 'codex-sdk') {
      logger.info({ project, agentType }, 'SDK fresh session.start removing stale main-session store record');
      removeSession(`deck_${project}_brain`);
    }
    const config: ProjectConfig = {
      name: project,
      dir,
      brainType: agentType as ProjectConfig['brainType'],
      workerTypes: [],
      label,
      fresh: agentType === 'claude-code-sdk' || agentType === 'codex-sdk',
      extraEnv,
      ccPreset: ccPresetName,
      effort,
    };
    if (agentType === 'claude-code-sdk') {
      logger.info({ project }, 'SDK fresh session.start launching new Claude SDK main session');
      await launchTransportSession({
        name: `deck_${project}_brain`,
        projectName: project,
        role: 'brain',
        agentType: 'claude-code-sdk',
        projectDir: dir,
        fresh: true,
        ccSessionId: randomUUID(),
        extraEnv,
        ccPreset: ccPresetName,
        label,
        effort,
      });
    } else if (agentType === 'codex-sdk') {
      logger.info({ project }, 'SDK fresh session.start launching new Codex SDK main session');
      await launchTransportSession({
        name: `deck_${project}_brain`,
        projectName: project,
        role: 'brain',
        agentType: 'codex-sdk',
        projectDir: dir,
        fresh: true,
        label,
        effort,
      });
    } else {
      await startProject(config);
    }
    logger.info({ project }, 'Session started via web');

    // Inject preset init message after session starts
    if (agentType === 'claude-code' && (ccPresetName || ccInitPrompt)) {
      const brainSession = `deck_${project}_brain`;
      const parts: string[] = [];
      if (ccPresetName) {
        const { getPreset, getPresetInitMessage } = await import('./cc-presets.js');
        const preset = await getPreset(ccPresetName);
        if (preset) parts.push(getPresetInitMessage(preset));
      }
      if (ccInitPrompt) parts.push(ccInitPrompt);
      if (parts.length > 0) {
        const msg = `[Context — absorb silently, do not respond to this message]\n${parts.join('\n\n')}`;
        setTimeout(async () => {
          try { await sendKeysDelayedEnter(brainSession, msg); } catch { /* session may not be ready */ }
        }, 5000);
      }
    }
  } catch (err) {
    logger.error({ project, err }, 'session.start failed');
    const message = err instanceof Error ? err.message : String(err);
    try { serverLink.send({ type: 'session.error', project, message }); } catch { /* ignore */ }
  }
}

async function handleRestart(cmd: Record<string, unknown>, serverLink: ServerLink): Promise<void> {
  const sessionName = cmd.sessionName as string | undefined;
  if (sessionName) {
    const record = getSession(sessionName);
    if (!record) {
      logger.warn({ sessionName }, 'session.restart: session not found in store');
      return;
    }
    try {
      await trackPendingSessionRelaunch(sessionName, (async () => {
        try {
          await relaunchSessionWithSettings(record, {
            agentType: (cmd.agentType as any) ?? undefined,
            projectDir: ('cwd' in cmd ? (cmd.cwd as string | undefined) : undefined),
            label: ('label' in cmd ? (cmd.label as string | null) : undefined),
            description: ('description' in cmd ? (cmd.description as string | null) : undefined),
            requestedModel: ('requestedModel' in cmd ? (cmd.requestedModel as string | null) : undefined),
            effort: ('effort' in cmd ? (cmd.effort as any) : undefined),
            transportConfig: ('transportConfig' in cmd ? (cmd.transportConfig as Record<string, unknown> | null) : undefined),
          });
          await handleGetSessions(serverLink);
          logger.info({ sessionName, agentType: cmd.agentType ?? record.agentType }, 'Session relaunched via settings');
        } catch (err) {
          logger.error({ sessionName, err }, 'session.restart(sessionName) failed');
          const message = err instanceof Error ? err.message : String(err);
          emitSessionInlineError(sessionName, message);
          try { serverLink.send({ type: 'session.error', project: record.projectName, message }); } catch { /* ignore */ }
          await handleGetSessions(serverLink);
          throw err;
        }
      })());
    } catch {
      // Failure already surfaced via session.error + corrective session_list.
    }
    return;
  }

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
    emitSessionInlineError(brain.name, message);
    try { serverLink.send({ type: 'session.error', project, message }); } catch { /* ignore */ }
  }
}

async function handleStop(cmd: Record<string, unknown>, serverLink: ServerLink): Promise<void> {
  const project = cmd.project as string | undefined;
  if (!project) {
    logger.warn('session.stop: missing project name');
    return;
  }

  let result;
  try {
    result = await stopProject(project, serverLink);
  } catch (err) {
    logger.error({ project, err }, 'session.stop failed');
    const message = err instanceof Error ? err.message : String(err);
    try { serverLink.send({ type: 'session.error', project, message: `Shutdown failed: ${message}` }); } catch { /* ignore */ }
    return;
  }

  if (result.ok) {
    logger.info({ project }, 'Session stopped via web');
    return;
  }

  const message = result.failed
    .map((failure) => `${failure.sessionName}:${failure.stage}`)
    .join(', ');
  logger.warn({ project, failed: result.failed }, 'session.stop completed with shutdown failures');
  try { serverLink.send({ type: 'session.error', project, message: `Shutdown failed: ${message}` }); } catch { /* ignore */ }
}

/**
 * Send a command to a session, handling `!`-prefixed shell commands:
 * - claude-code: send `!` first (with delayed-Enter), then send the rest of the command
 * - codex: strip `!` and send the shell command directly (Codex has no `!` prefix)
 * - others: send as-is
 */
/** Agents with sandboxed file access — temp files must be in project dir. */
const SANDBOXED_AGENTS = new Set(['gemini']);

async function sendShellAwareCommand(sessionName: string, text: string, agentType: string): Promise<void> {
  const record = getSession(sessionName);
  const cwd = SANDBOXED_AGENTS.has(agentType) ? record?.projectDir : undefined;
  const opts = cwd ? { cwd } : undefined;
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

function resolveSingleTargetMode(
  targetSession: string,
  requestedMode: string,
  sessionConfig?: P2pSessionConfig,
): string {
  if (requestedMode !== P2P_CONFIG_MODE) return requestedMode;
  const configuredMode = sessionConfig?.[targetSession]?.mode;
  return configuredMode && configuredMode !== 'skip' ? configuredMode : 'discuss';
}

async function handleSend(cmd: Record<string, unknown>, serverLink: ServerLink): Promise<void> {
  const sessionName = (cmd.sessionName ?? cmd.session) as string | undefined;
  const text = cmd.text as string | undefined;
  const commandId = cmd.commandId as string | undefined;
  const directTargetSession = (cmd as any).directTargetSession as string | undefined;
  const directTargetMode = ((cmd as any).directTargetMode as string | undefined) ?? 'discuss';

  if (!sessionName || !text) {
    logger.warn('session.send: missing sessionName or text');
    return;
  }

  await waitForPendingSessionRelaunch(sessionName);

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

// ── P2P routing: structured WS fields (new) or inline @@tokens (legacy) ──
  const p2pSessionConfig = (cmd as any).p2pSessionConfig as P2pSessionConfig | undefined;
  let p2pRounds = (cmd as any).p2pRounds as number | undefined;
  let p2pExtraPrompt = (cmd as any).p2pExtraPrompt as string | undefined;
  const p2pLocale = (cmd as any).p2pLocale as string | undefined;
  const p2pHopTimeoutMs = (cmd as any).p2pHopTimeoutMs as number | undefined;
  const p2pAdvancedPresetKey = (cmd as any).p2pAdvancedPresetKey as string | undefined;
  const p2pAdvancedRounds = (cmd as any).p2pAdvancedRounds as P2pAdvancedRound[] | undefined;
  const p2pAdvancedRunTimeoutMinutes = (cmd as any).p2pAdvancedRunTimeoutMinutes as number | undefined;
  const p2pContextReducer = (cmd as any).p2pContextReducer as P2pContextReducerConfig | undefined;
  const p2pModeField = (cmd as any).p2pMode as string | undefined;
  const p2pAtTargets = (cmd as any).p2pAtTargets as Array<{ session: string; mode: string }> | undefined;
  const explicitTargets = directTargetSession
    ? [{ session: directTargetSession, mode: resolveSingleTargetMode(directTargetSession, directTargetMode, p2pSessionConfig) }]
    : p2pAtTargets;

  // Build P2P tokens from structured fields (frontend no longer injects @@tokens into text)
  let tokens: ParsedTokens;
  if (explicitTargets && explicitTargets.length > 0) {
    // @ picker targets — expand __all__ or use specific sessions
    const agents: P2pTarget[] = [];
    const files: string[] = [];
    for (const t of explicitTargets) {
      if (t.session === '__all__') {
        agents.push(...expandAllTargets(sessionName, t.mode, false, p2pSessionConfig));
      } else if (getSession(t.session)) {
        agents.push({ session: t.session, mode: t.mode });
      }
    }
    // Extract @file references from text
    for (const m of text.matchAll(FILE_TOKEN_RE)) files.push(m[1]);
    const cleanText = text.replace(FILE_TOKEN_RE, '').replace(/\s+/g, ' ').trim();
    tokens = { agents, files, cleanText };
  } else if (p2pModeField) {
    // Dropdown P2P mode — expand to all targets
    const agents = expandAllTargets(sessionName, p2pModeField, !!(cmd as any).p2pExcludeSameType, p2pSessionConfig);
    const files: string[] = [];
    for (const m of text.matchAll(FILE_TOKEN_RE)) files.push(m[1]);
    const cleanText = text.replace(FILE_TOKEN_RE, '').replace(/\s+/g, ' ').trim();
    tokens = { agents, files, cleanText };
  } else {
    // Legacy: parse @@tokens from text (backward compat with older frontends)
    tokens = parseAtTokens(text);
  }

  // Extract rounds from @@p2p-config(rounds=N) text token if not in WS field
  if (!p2pRounds) {
    const roundsMatch = /@@p2p-config\(rounds=(\d+)\)/.exec(text);
    if (roundsMatch) p2pRounds = Math.min(parseInt(roundsMatch[1], 10), 6);
  }

  // For combo pipelines, auto-set rounds to match pipeline length if not explicitly overridden
  const resolvedMode = p2pModeField ?? tokens.agents[0]?.mode ?? '';
  const comboRounds = getComboRoundCount(resolvedMode);
  if (comboRounds && !p2pRounds) {
    p2pRounds = comboRounds;
  }

  // All @@discuss tokens were rejected — sessions not found in store
  if (tokens.hadDiscussTokens) {
    logger.warn({ sessionName }, 'P2P: all @@discuss tokens had invalid session names — none matched session store');
    timelineEmitter.emit(sessionName, 'command.ack', { commandId: effectiveId, status: 'error', error: 'No valid P2P targets — session names not found' });
    try { serverLink.send({ type: 'command.ack', commandId: effectiveId, status: 'error', session: sessionName, error: 'no_valid_targets' }); } catch {}
    return;
  }

  // @@all(mode) from legacy text tokens — expand to all active sessions
  if (tokens.expandAll && tokens.agents.length === 0) {
    const mode = tokens.expandAll.mode;
    if (!p2pRounds && tokens.expandAll.rounds) {
      p2pRounds = tokens.expandAll.rounds;
    }
    tokens.agents.push(...expandAllTargets(sessionName, mode, tokens.expandAll.excludeSameType, p2pSessionConfig));
    if (tokens.agents.length === 0) {
      logger.warn({ sessionName }, '@@all: no active sessions found in same domain');
      timelineEmitter.emit(sessionName, 'command.ack', { commandId: effectiveId, status: 'error', error: 'No active sessions found for @@all' });
      try { serverLink.send({ type: 'command.ack', commandId: effectiveId, status: 'error', session: sessionName, error: 'no_sessions' }); } catch {}
      return;
    }
    logger.info({ sessionName, targets: tokens.agents.map(a => a.session) }, '@@all expanded');
  }

  // No targets found from any source
  if ((explicitTargets || p2pModeField) && tokens.agents.length === 0) {
    logger.warn({ sessionName, p2pModeField }, 'P2P: no active sessions found for structured routing');
    timelineEmitter.emit(sessionName, 'command.ack', { commandId: effectiveId, status: 'error', error: 'No active sessions found' });
    try { serverLink.send({ type: 'command.ack', commandId: effectiveId, status: 'error', session: sessionName, error: 'no_sessions' }); } catch {}
    return;
  }

  if (tokens.agents.length > 0) {
    // P2P Quick Discussion — delegate to orchestrator
    try {
      // ── Concurrency guard: check for active P2P runs on same initiator ──
      const forceNew = !!(cmd as Record<string, unknown>).force;
      const existingRun = listP2pRuns().find(
        (r) => r.initiatorSession === sessionName && !P2P_TERMINAL_RUN_STATUSES.has(r.status),
      );

      if (existingRun && !forceNew) {
        // Conflict: active run exists, user didn't force → notify browser
        logger.info({ sessionName, existingRunId: existingRun.id }, 'P2P conflict: active run already exists');
        try {
          serverLink.send({
            type: 'p2p.conflict',
            existingRunId: existingRun.id,
            initiatorSession: sessionName,
            commandId: effectiveId,
          });
          // Send command.ack so pending message state clears
          serverLink.send({ type: 'command.ack', commandId: effectiveId, status: 'conflict', session: sessionName });
        } catch { /* not connected */ }
        return;
      }

      if (existingRun && forceNew) {
        // Force: cancel existing run first, then start new
        logger.info({ sessionName, existingRunId: existingRun.id }, 'P2P force: cancelling existing run');
        cancelP2pRun(existingRun.id, serverLink);
      }

      const fileContents: Array<{ path: string; content: string }> = [];
      const record = getSession(sessionName);
      const projectDir = record?.projectDir ?? '';
      for (const fp of tokens.files) {
        try {
          const absPath = nodePath.isAbsolute(fp) ? fp : nodePath.join(projectDir, fp);
          // Check for binary content (null bytes anywhere in the capped content)
          const content = await fsReadFileRaw(absPath, 'utf8');
          const capped = content.slice(0, 50_000);
          if (capped.includes('\0')) {
            // Binary file (image, etc.) — include path reference so agents can read it
            fileContents.push({ path: absPath, content: '' });
            continue;
          }
          fileContents.push({ path: fp, content: capped }); // cap at 50KB
        } catch { /* ignore unreadable files */ }
      }
      // Auto-append language instruction based on the user's selected i18n locale
      if (p2pLocale && !p2pExtraPrompt?.match(/语言|language|lang|中文|日本語|한국어|español|русский/i)) {
        const LOCALE_NAMES: Record<string, string> = {
          'en': 'English',
          'zh-CN': 'Chinese (Simplified)', 'zh-TW': 'Chinese (Traditional)',
          'ja': 'Japanese', 'ko': 'Korean', 'es': 'Spanish', 'ru': 'Russian',
        };
        const langName = LOCALE_NAMES[p2pLocale] ?? p2pLocale;
        const langInstr = `Use the user's selected i18n language (${langName}) for the discussion.`;
        p2pExtraPrompt = p2pExtraPrompt ? `${p2pExtraPrompt}\n${langInstr}` : langInstr;
      }
      const run = await startP2pRun({
        initiatorSession: sessionName,
        targets: tokens.agents,
        userText: tokens.cleanText,
        fileContents,
        serverLink,
        rounds: p2pRounds,
        extraPrompt: p2pExtraPrompt,
        modeOverride: resolvedMode || undefined,
        hopTimeoutMs: p2pHopTimeoutMs,
        advancedPresetKey: p2pAdvancedPresetKey,
        advancedRounds: p2pAdvancedRounds,
        advancedRunTimeoutMs: p2pAdvancedRunTimeoutMinutes != null ? p2pAdvancedRunTimeoutMinutes * 60_000 : undefined,
        contextReducer: p2pContextReducer,
      });
      const status = isLegacy ? 'accepted_legacy' : 'accepted';
      timelineEmitter.emit(sessionName, 'command.ack', { commandId: effectiveId, status });
      try {
        serverLink.send({ type: 'command.ack', commandId: effectiveId, status, session: sessionName });
        serverLink.send({ type: 'p2p.run_started', runId: run.id, session: sessionName });
      } catch { /* not connected */ }
    } catch (err) {
      logger.error({ sessionName, err }, 'P2P run start failed');
      const errMsg = err instanceof Error ? err.message : String(err);
      // Emit error ack so the message exits pending state in the UI
      timelineEmitter.emit(sessionName, 'command.ack', { commandId: effectiveId, status: 'error', error: errMsg });
      try {
        serverLink.send({ type: 'command.ack', commandId: effectiveId, status: 'error', session: sessionName, error: errMsg });
      } catch { /* not connected */ }
    }
    return;
  }

  // Transport sessions — route directly to the provider runtime, bypassing tmux.
  const transportRuntime = getTransportRuntime(sessionName);
  const record = (await import('../store/session-store.js')).getSession(sessionName);
  const emitTransportUserMessage = (payloadText: string, extra?: Record<string, unknown>) => {
    timelineEmitter.emit(sessionName, 'user.message', { text: payloadText, allowDuplicate: true, ...(extra ?? {}) });
  };
  if (!transportRuntime && record?.runtimeType === 'transport') {
    // No runtime — provider not connected. Show error in chat.
    const errMsg = `Provider ${record.providerId ?? 'unknown'} not connected. Reconnecting...`;
    logger.warn({ sessionName, providerId: record.providerId }, 'session.send: transport session has no runtime');
    emitTransportUserMessage(text);
    timelineEmitter.emit(sessionName, 'assistant.text', { text: `⚠️ ${errMsg}`, streaming: false }, { source: 'daemon', confidence: 'high' });
    timelineEmitter.emit(sessionName, 'session.state', { state: 'idle', error: errMsg }, { source: 'daemon', confidence: 'high' });
    const errStatus = 'error';
    timelineEmitter.emit(sessionName, 'command.ack', { commandId: effectiveId, status: errStatus, error: errMsg });
    try { serverLink.send({ type: 'command.ack', commandId: effectiveId, status: errStatus, session: sessionName, error: errMsg }); } catch { /* not connected */ }
    return;
  }
  if (transportRuntime) {
    const release = await getMutex(sessionName).acquire();
    try {
      if (text.trim() === '/stop') {
        emitTransportUserMessage(text);
        await transportRuntime.cancel();
        // Mark session for fresh start so daemon restart doesn't resume the stuck conversation
        if (record?.agentType === 'qwen') {
          upsertSession({ ...record, qwenFreshOnResume: true, updatedAt: Date.now() });
        }
        const stopStatus = isLegacy ? 'accepted_legacy' : 'accepted';
        timelineEmitter.emit(sessionName, 'command.ack', { commandId: effectiveId, status: stopStatus });
        try {
          serverLink.send({ type: 'command.ack', commandId: effectiveId, status: stopStatus, session: sessionName });
        } catch { /* */ }
        return;
      }
      const modelMatch = text.trim().match(/^\/model\s+(\S+)(?:\s+.*)?$/);
      const effortMatch = text.trim().match(/^\/(?:thinking|effort)\s+(\S+)\s*$/);
      if (record?.agentType === 'qwen' && modelMatch) {
        const nextModel = modelMatch[1];
          const runtimeConfig = await getQwenRuntimeConfig(true).catch(() => null);
          const allowedModels = runtimeConfig?.availableModels?.length
            ? runtimeConfig.availableModels
            : (record.qwenAvailableModels?.length ? record.qwenAvailableModels : QWEN_MODEL_IDS);
          if (!allowedModels.includes(nextModel)) {
            const qwenAuthType = runtimeConfig?.authType ?? record.qwenAuthType;
            const authHint = qwenAuthType === 'qwen-oauth'
              ? ' (current tier only allows coder-model)'
              : '';
            emitTransportUserMessage(text);
            timelineEmitter.emit(sessionName, 'assistant.text', {
              text: `⚠️ Unknown Qwen model: ${nextModel}${authHint}`,
              streaming: false,
            }, { source: 'daemon', confidence: 'high' });
            timelineEmitter.emit(sessionName, 'command.ack', { commandId: effectiveId, status: 'error', error: `Unknown Qwen model: ${nextModel}${authHint}` });
            try { serverLink.send({ type: 'command.ack', commandId: effectiveId, status: 'error', session: sessionName, error: `Unknown Qwen model: ${nextModel}${authHint}` }); } catch { /* */ }
            return;
          }
          transportRuntime.setAgentId(nextModel);
          const qwenAuthType = runtimeConfig?.authType ?? record.qwenAuthType;
          const nextRecord = {
            ...record,
            requestedModel: nextModel,
            activeModel: nextModel,
            modelDisplay: nextModel,
            qwenModel: nextModel,
            ...(qwenAuthType ? { qwenAuthType } : {}),
            ...(runtimeConfig?.authLimit ? { qwenAuthLimit: runtimeConfig.authLimit } : {}),
            ...(runtimeConfig?.availableModels?.length ? { qwenAvailableModels: runtimeConfig.availableModels } : {}),
            ...getQwenDisplayMetadata({
              model: nextModel,
              authType: qwenAuthType,
              authLimit: runtimeConfig?.authLimit ?? record.qwenAuthLimit,
              quotaUsageLabel: qwenAuthType === 'qwen-oauth' ? getQwenOAuthQuotaUsageLabel() : undefined,
            }),
            updatedAt: Date.now(),
          };
          upsertSession(nextRecord);
          persistSessionRecord(nextRecord, sessionName);
          await handleGetSessions(serverLink);
          syncSubSessionIfNeeded(sessionName, serverLink);
          emitTransportUserMessage(text);
          timelineEmitter.emit(sessionName, 'usage.update', {
            model: nextModel,
            contextWindow: resolveContextWindow(undefined, nextModel),
          }, { source: 'daemon', confidence: 'high' });
          timelineEmitter.emit(sessionName, 'assistant.text', {
            text: `Switched model to ${nextModel}`,
            streaming: false,
          }, { source: 'daemon', confidence: 'high' });
          timelineEmitter.emit(sessionName, 'command.ack', { commandId: effectiveId, status: isLegacy ? 'accepted_legacy' : 'accepted' });
          try { serverLink.send({ type: 'command.ack', commandId: effectiveId, status: isLegacy ? 'accepted_legacy' : 'accepted', session: sessionName }); } catch { /* */ }
          return;
      }
      if (record?.agentType === 'claude-code-sdk' && modelMatch) {
        const requestedModel = modelMatch[1];
        const selectedModel = normalizeClaudeCodeModelId(requestedModel);
        if (!selectedModel) {
          emitTransportUserMessage(text);
          timelineEmitter.emit(sessionName, 'assistant.text', { text: `⚠️ Unknown Claude model: ${requestedModel}`, streaming: false }, { source: 'daemon', confidence: 'high' });
          timelineEmitter.emit(sessionName, 'command.ack', { commandId: effectiveId, status: 'error', error: `Unknown Claude model: ${requestedModel}` });
          try { serverLink.send({ type: 'command.ack', commandId: effectiveId, status: 'error', session: sessionName, error: `Unknown Claude model: ${requestedModel}` }); } catch {}
          return;
        }
        transportRuntime.setAgentId(normalizeClaudeSdkModelForProvider(selectedModel));
        const sdkDisplay = await getClaudeSdkRuntimeConfig(true).catch(() => ({}) as import('../agent/sdk-runtime-config.js').SdkRuntimeConfig);
        const nextRecord = {
          ...record,
          requestedModel: selectedModel,
          activeModel: selectedModel,
          modelDisplay: selectedModel,
          ...(sdkDisplay.planLabel ? { planLabel: sdkDisplay.planLabel } : {}),
          updatedAt: Date.now(),
        };
        upsertSession(nextRecord);
        persistSessionRecord(nextRecord, sessionName);
        await handleGetSessions(serverLink);
        syncSubSessionIfNeeded(sessionName, serverLink);
        emitTransportUserMessage(text);
        timelineEmitter.emit(sessionName, 'usage.update', { model: selectedModel, contextWindow: resolveContextWindow(undefined, selectedModel) }, { source: 'daemon', confidence: 'high' });
        timelineEmitter.emit(sessionName, 'assistant.text', { text: `Switched model to ${selectedModel}`, streaming: false }, { source: 'daemon', confidence: 'high' });
        timelineEmitter.emit(sessionName, 'command.ack', { commandId: effectiveId, status: isLegacy ? 'accepted_legacy' : 'accepted' });
        try { serverLink.send({ type: 'command.ack', commandId: effectiveId, status: isLegacy ? 'accepted_legacy' : 'accepted', session: sessionName }); } catch {}
        return;
      }
      if (record?.agentType === 'codex-sdk' && modelMatch) {
        const nextModel = modelMatch[1];
        if (!CODEX_MODEL_IDS.includes(nextModel as any)) {
          emitTransportUserMessage(text);
          timelineEmitter.emit(sessionName, 'assistant.text', { text: `⚠️ Unknown Codex model: ${nextModel}`, streaming: false }, { source: 'daemon', confidence: 'high' });
          timelineEmitter.emit(sessionName, 'command.ack', { commandId: effectiveId, status: 'error', error: `Unknown Codex model: ${nextModel}` });
          try { serverLink.send({ type: 'command.ack', commandId: effectiveId, status: 'error', session: sessionName, error: `Unknown Codex model: ${nextModel}` }); } catch {}
          return;
        }
        transportRuntime.setAgentId(nextModel);
        const sdkDisplay = await getCodexRuntimeConfig(true).catch(() => ({}) as import('../agent/codex-runtime-config.js').CodexRuntimeConfig);
        const nextRecord = {
          ...record,
          requestedModel: nextModel,
          activeModel: nextModel,
          modelDisplay: nextModel,
          planLabel: sdkDisplay.planLabel,
          quotaLabel: sdkDisplay.quotaLabel,
          quotaUsageLabel: sdkDisplay.quotaUsageLabel,
          updatedAt: Date.now(),
        };
        upsertSession(nextRecord);
        persistSessionRecord(nextRecord, sessionName);
        await handleGetSessions(serverLink);
        syncSubSessionIfNeeded(sessionName, serverLink);
        emitTransportUserMessage(text);
        timelineEmitter.emit(sessionName, 'usage.update', { model: nextModel, contextWindow: resolveContextWindow(undefined, nextModel) }, { source: 'daemon', confidence: 'high' });
        timelineEmitter.emit(sessionName, 'assistant.text', { text: `Switched model to ${nextModel}`, streaming: false }, { source: 'daemon', confidence: 'high' });
        timelineEmitter.emit(sessionName, 'command.ack', { commandId: effectiveId, status: isLegacy ? 'accepted_legacy' : 'accepted' });
        try { serverLink.send({ type: 'command.ack', commandId: effectiveId, status: isLegacy ? 'accepted_legacy' : 'accepted', session: sessionName }); } catch {}
        return;
      }
      if (supportsEffort(record?.agentType) && effortMatch) {
        const nextEffort = effortMatch[1];
        const allowed = getSupportedEffortLevels(record?.agentType);
        if (!isTransportEffortLevel(nextEffort) || !allowed.includes(nextEffort)) {
          const supported = allowed.join(', ');
          emitTransportUserMessage(text);
          timelineEmitter.emit(sessionName, 'assistant.text', {
            text: `⚠️ Unsupported thinking level: ${nextEffort}. Supported: ${supported}`,
            streaming: false,
          }, { source: 'daemon', confidence: 'high' });
          timelineEmitter.emit(sessionName, 'command.ack', { commandId: effectiveId, status: 'error', error: `Unsupported thinking level: ${nextEffort}` });
          try { serverLink.send({ type: 'command.ack', commandId: effectiveId, status: 'error', session: sessionName, error: `Unsupported thinking level: ${nextEffort}` }); } catch {}
          return;
        }
        transportRuntime.setEffort(nextEffort);
        const nextRecord = {
          ...record,
          effort: nextEffort,
          updatedAt: Date.now(),
        };
        upsertSession(nextRecord);
        persistSessionRecord(nextRecord, sessionName);
        await handleGetSessions(serverLink);
        syncSubSessionIfNeeded(sessionName, serverLink);
        emitTransportUserMessage(text);
        timelineEmitter.emit(sessionName, 'assistant.text', {
          text: `Switched thinking level to ${nextEffort}`,
          streaming: false,
        }, { source: 'daemon', confidence: 'high' });
        timelineEmitter.emit(sessionName, 'command.ack', { commandId: effectiveId, status: isLegacy ? 'accepted_legacy' : 'accepted' });
        try { serverLink.send({ type: 'command.ack', commandId: effectiveId, status: isLegacy ? 'accepted_legacy' : 'accepted', session: sessionName }); } catch {}
        return;
      }
      if (record?.agentType === 'qwen' && record.qwenAuthType === 'qwen-oauth') {
        recordQwenOAuthRequest();
        refreshQwenQuotaUsageLabels(serverLink);
      }
      // send() is synchronous: dispatches immediately if idle, queues if busy.
      // Status changes come from transport runtime's onStatusChange callback.
      const result = transportRuntime.send(text);
      if (result === 'sent') {
        emitTransportUserMessage(text);
      }
      if (result === 'queued') {
        timelineEmitter.emit(sessionName, 'session.state', {
          state: 'queued',
          pendingCount: transportRuntime.pendingCount,
          pendingMessages: transportRuntime.pendingMessages,
        }, { source: 'daemon', confidence: 'high' });
      }
      // Clear fresh-start flag — the new conversation is now active
      if (record?.qwenFreshOnResume) {
        upsertSession({ ...record, qwenFreshOnResume: undefined, updatedAt: Date.now() });
      }
      const status = isLegacy ? 'accepted_legacy' : 'accepted';
      timelineEmitter.emit(sessionName, 'command.ack', { commandId: effectiveId, status });
      try {
        serverLink.send({ type: 'command.ack', commandId: effectiveId, status, session: sessionName });
      } catch { /* not connected */ }
    } catch (err) {
      const errMsg = describeTransportSendError(err);
      logger.error({ sessionName, err }, 'session.send (transport) failed');
      timelineEmitter.emit(sessionName, 'assistant.text', { text: `⚠️ Send failed: ${errMsg}`, streaming: false }, { source: 'daemon', confidence: 'high' });
      timelineEmitter.emit(sessionName, 'session.state', { state: 'idle', error: errMsg }, { source: 'daemon', confidence: 'high' });
      try { serverLink.send({ type: 'command.ack', commandId: effectiveId, status: 'error', session: sessionName, error: errMsg }); } catch { /* */ }
    } finally {
      release();
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

    // Sandboxed agents (Gemini, Codex) can only access files under their project dir.
    // Copy referenced files from ~/.imcodes/ to project .imc/ and rewrite paths.
    let sendText = finalText;
    if (agentType === 'gemini' || agentType === 'codex') {
      sendText = await rewritePathsForSandbox(sessionName, finalText);
    }

    await sendShellAwareCommand(sessionName, sendText, agentType);
    const payload: Record<string, unknown> = { text };
    if (attachments.length > 0) payload.attachments = attachments;
    timelineEmitter.emit(sessionName, 'user.message', payload);
    // Emit accepted ack (accepted_legacy for fallback IDs so callers can distinguish)
    const status = isLegacy ? 'accepted_legacy' : 'accepted';
    timelineEmitter.emit(sessionName, 'command.ack', { commandId: effectiveId, status });
    try {
      serverLink.send({ type: 'command.ack', commandId: effectiveId, status, session: sessionName });
    } catch { /* not connected */ }
    if (agentType === 'opencode') {
      const { scheduleCatchup } = await import('./opencode-watcher.js');
      scheduleCatchup(sessionName);
    }
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

  // Transport sessions have no terminal, but ESC should cancel the active turn.
  const transportRuntime = getTransportRuntime(sessionName);
  if (transportRuntime) {
    if (data === '\x1b') {
      try {
        await transportRuntime.cancel();
        // Mark Qwen sessions for fresh start so restart doesn't resume stuck conversation
        const rec = getSession(sessionName);
        if (rec?.agentType === 'qwen') {
          upsertSession({ ...rec, qwenFreshOnResume: true, updatedAt: Date.now() });
        }
      } catch (err) {
        logger.error({ sessionName, err }, 'session.input transport cancel failed');
      }
    }
    return;
  }

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

async function handleGetSessions(serverLink: ServerLink): Promise<void> {
  const sessions = await buildSessionList();
  try {
    serverLink.send({ type: 'session_list', daemonVersion: serverLink.daemonVersion, sessions });
  } catch {
    // not connected
  }
}

const RAW_BATCH_FLUSH_MS = 42;           // ~24fps flush interval
const RAW_BATCH_MAX_BYTES = 32 * 1024;   // flush immediately at 32KB

function handleSubscribe(cmd: Record<string, unknown>, serverLink: ServerLink): void {
  const session = cmd.session as string | undefined;
  if (!session) return;

  // The bridge may include a `raw` flag on terminal.subscribe for its own forwarding-mode
  // bookkeeping, but daemon-side terminal streaming remains transport-stable in this phase:
  // once subscribed for a session, we continue emitting both text diffs and raw PTY bytes.
  // Per-session raw PTY batching: accumulate small chunks and flush on timer or size threshold.
  let rawBatch: Buffer[] = [];
  let rawBatchBytes = 0;
  let rawBatchTimer: ReturnType<typeof setTimeout> | null = null;

  const flushRawBatch = (): void => {
    if (rawBatchTimer) { clearTimeout(rawBatchTimer); rawBatchTimer = null; }
    if (rawBatch.length === 0) return;
    const combined = rawBatch.length === 1 ? rawBatch[0] : Buffer.concat(rawBatch);
    serverLink.sendBinary(packRawFrame(session, combined));
    rawBatch = [];
    rawBatchBytes = 0;
  };

  const subscriber: StreamSubscriber = {
    sessionName: session,
    send: (diff) => {
      try { serverLink.send({ type: 'terminal_update', diff }); } catch { /* ignore */ }
    },
    sendRaw: (data: Buffer) => {
      rawBatch.push(data);
      rawBatchBytes += data.length;
      if (rawBatchBytes >= RAW_BATCH_MAX_BYTES) {
        flushRawBatch();
      } else if (!rawBatchTimer) {
        rawBatchTimer = setTimeout(flushRawBatch, RAW_BATCH_FLUSH_MS);
      }
    },
    sendControl: (msg) => {
      try { serverLink.send(msg); } catch { /* ignore */ }
    },
    onError: () => {
      if (rawBatchTimer) clearTimeout(rawBatchTimer);
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

const OPENCODE_SYNTH_HISTORY_OVERLAP_MS = 60_000;

export function getOpenCodeSynthesizedAfterTs(afterTs: number | undefined): number | undefined {
  return afterTs === undefined ? undefined : Math.max(0, afterTs - OPENCODE_SYNTH_HISTORY_OVERLAP_MS);
}

/** Handle timeline.history_request — browser requesting full session history on open. */
export function hasSubstantiveTimelineHistory(events: Array<{ type: string }>): boolean {
  return events.some((event) => (
    event.type === 'user.message'
    || event.type === 'assistant.text'
    || event.type === 'assistant.thinking'
    || event.type === 'tool.call'
    || event.type === 'tool.result'
    || event.type === 'ask.question'
  ));
}

export function countSubstantiveTimelineEvents(events: Array<{ type: string }>): number {
  return events.filter((event) => (
    event.type === 'user.message'
    || event.type === 'assistant.text'
    || event.type === 'assistant.thinking'
    || event.type === 'tool.call'
    || event.type === 'tool.result'
    || event.type === 'ask.question'
  )).length;
}

async function recoverOpenCodeSessionRecord(record: SessionRecord | undefined): Promise<SessionRecord | undefined> {
  if (!record || record.agentType !== 'opencode' || !record.projectDir) return record;
  try {
    let paneCmd = '';
    try {
      paneCmd = await getPaneStartCommand(record.name);
    } catch { /* ignore */ }
    const explicitPaneId = paneCmd.match(/\bopencode\b[\s\S]*?(?:--session|-s)\s+(?:"([^"]+)"|'([^']+)'|([^\s"'`;|&]+))/)?.slice(1).find(Boolean);
    if (explicitPaneId) {
      if (record.opencodeSessionId === explicitPaneId) return record;
      const next = { ...record, opencodeSessionId: explicitPaneId };
      upsertSession(next);
      return next;
    }

    const { discoverLatestOpenCodeSessionId } = await import('./opencode-history.js');
    const opencodeSessionId = await discoverLatestOpenCodeSessionId(record.projectDir, {
      exactDirectory: record.projectDir,
      maxCount: 50,
    });
    if (!opencodeSessionId || opencodeSessionId === record.opencodeSessionId) return record;
    const next = { ...record, opencodeSessionId };
    upsertSession(next);
    return next;
  } catch (err) {
    logger.debug({ err, sessionName: record.name, projectDir: record.projectDir }, 'Failed to recover OpenCode session ID from local history');
    return record;
  }
}

async function handleTimelineHistory(cmd: Record<string, unknown>, serverLink: ServerLink): Promise<void> {
  const sessionName = cmd.sessionName as string | undefined;
  const requestId = cmd.requestId as string | undefined;
  const rawLimit = cmd.limit;
  const limit = typeof rawLimit === 'number' && Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 2000) : 500;
  const rawAfterTs = cmd.afterTs;
  const afterTs = typeof rawAfterTs === 'number' && Number.isFinite(rawAfterTs) ? rawAfterTs : undefined;
  const rawBeforeTs = cmd.beforeTs;
  const beforeTs = typeof rawBeforeTs === 'number' && Number.isFinite(rawBeforeTs) ? rawBeforeTs : undefined;

  if (!sessionName) {
    logger.warn('timeline.history_request: missing sessionName');
    return;
  }

  // Read generously from disk — session.state events are excluded from the limit budget
  // so we need to read more to ensure enough substantive events.
  // Do NOT filter by epoch — history should include events across daemon restarts.
  const readLimit = Math.min(limit * 6, 10000);
  const events = timelineStore.read(sessionName, { limit: readLimit, afterTs, beforeTs });

  // Content-aware limit: session.state events don't count toward the budget.
  // This prevents idle↔running oscillation storms from crowding out user.message events.
  const substantive: typeof events = [];
  const stateEvents: typeof events = [];
  for (const ev of events) {
    if (ev.type === 'session.state') stateEvents.push(ev);
    else substantive.push(ev);
  }
  // Trim substantive to the requested limit
  const trimmedSubstantive = substantive.length > limit ? substantive.slice(substantive.length - limit) : substantive;
  // Interleave state events that fall within the trimmed time range
  let trimmed: typeof events;
  if (trimmedSubstantive.length > 0 && stateEvents.length > 0) {
    const cutoffTs = trimmedSubstantive[0].ts;
    const relevantState = stateEvents.filter((e) => e.ts >= cutoffTs);
    trimmed = [...trimmedSubstantive, ...relevantState].sort((a, b) => a.ts - b.ts);
  } else {
    trimmed = trimmedSubstantive;
  }

  const record = await recoverOpenCodeSessionRecord(getSession(sessionName));
  if (record?.agentType === 'opencode' && record.projectDir && record.opencodeSessionId) {
    try {
      const { exportOpenCodeSession, buildTimelineEventsFromOpenCodeExport } = await import('./opencode-history.js');
      const exportData = await exportOpenCodeSession(record.projectDir, record.opencodeSessionId);
      const synthesizedAfterTs = getOpenCodeSynthesizedAfterTs(afterTs);
      const synthesized = buildTimelineEventsFromOpenCodeExport(sessionName, exportData, timelineEmitter.epoch)
        .filter((event) => synthesizedAfterTs === undefined || event.ts > synthesizedAfterTs)
        .filter((event) => beforeTs === undefined || event.ts < beforeTs);
      const synthesizedTrimmed = synthesized.length > limit ? synthesized.slice(synthesized.length - limit) : synthesized;
      if (
        !hasSubstantiveTimelineHistory(trimmed)
        || countSubstantiveTimelineEvents(synthesizedTrimmed) > countSubstantiveTimelineEvents(trimmed)
      ) {
        trimmed = synthesizedTrimmed;
      }
    } catch (err) {
      logger.debug({ err, sessionName, opencodeSessionId: record.opencodeSessionId }, 'Failed to synthesize OpenCode timeline history');
    }
  }

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
  const cwd = cmd.cwd as string | null | undefined;
  const shellBin = cmd.shellBin as string | null | undefined;
  const ccSessionId = cmd.ccSessionId as string | null | undefined;
  const parentSession = cmd.parentSession as string | null | undefined;
  const ccPreset = cmd.ccPreset as string | null | undefined;
  const requestedEffort: unknown = cmd.thinking ?? cmd.effort;
  const effort = isTransportEffortLevel(requestedEffort)
    ? requestedEffort
    : getDefaultThinkingLevel(type);

  // Transport-backed providers: launch without tmux.
  if (isTransportAgent(type)) {
    const sessionName = subSessionName(id);
    const ocMode = cmd.ocMode as string | undefined;
    const bindExistingKey = type === 'openclaw'
      ? (ocMode === 'bind' ? (cmd.ocSessionId as string) || undefined : undefined)
      : ((cmd.providerSessionId as string | undefined) || undefined);
    const description = ((cmd.ocDescription as string) || (cmd.description as string) || '').trim() || undefined;
    if (bindExistingKey && isProviderSessionBound(bindExistingKey)) {
      logger.warn({ id, bindExistingKey }, 'subsession.start: providerSessionId already bound — skipped');
      return;
    }
    try {
      await launchTransportSession({
        name: sessionName,
        projectName: sessionName,
        role: 'w1',
        agentType: type as any,
        projectDir: (cwd as string) || process.cwd(),
        description,
        requestedModel: (cmd.requestedModel as string | undefined) ?? (cmd.model as string | undefined),
        transportConfig: (cmd.transportConfig as Record<string, unknown> | undefined) ?? undefined,
        bindExistingKey,
        ...(ccPreset ? { ccPreset } : {}),
        ...(type === 'claude-code-sdk' ? { ccSessionId: randomUUID(), fresh: true } : {}),
        ...(type === 'codex-sdk' ? { fresh: true } : {}),
        ...(effort ? { effort } : {}),
        userCreated: true,
        parentSession: parentSession || undefined,
      });
      // Sync to server DB
      try {
        serverLink.send(await buildSubSessionSync(id));
      } catch { /* not connected */ }
    } catch (e: unknown) {
      logger.error({ err: e, id, type }, 'subsession.start failed (transport)');
    }
    return;
  }
  const subCcInitPrompt = cmd.ccInitPrompt as string | null | undefined;
  const description = cmd.description as string | null | undefined;

  try {
    await startSubSession({
      id,
      type,
      shellBin,
      cwd,
      ccSessionId,
      parentSession,
      geminiSessionId,
      ccPreset,
      ccInitPrompt: subCcInitPrompt,
      description,
      effort,
      fresh: type === 'gemini' && !geminiSessionId,
      _fileSnapshot: fileSnapshot,
      _onGeminiDiscovered: fileSnapshot ? (sessionId: string) => {
        logger.info({ id, sessionId }, 'Discovered Gemini session ID via snapshot-diff');
        try { serverLink.send({ type: 'subsession.update_gemini_id', id, geminiSessionId: sessionId }); } catch { /* ignore */ }
      } : undefined,
    });
    // Sync to server DB so frontend can see the sub-session
    try {
      serverLink.send(await buildSubSessionSync(id));
    } catch { /* not connected */ }
  } catch (e: unknown) {
    logger.error({ err: e, id }, 'subsession.start failed');
  }
}

async function handleSubSessionStop(cmd: Record<string, unknown>, serverLink: ServerLink): Promise<void> {
  const sName = cmd.sessionName as string | undefined;
  if (!sName) {
    logger.warn('subsession.stop: missing sessionName');
    return;
  }
  const result = await stopSubSession(sName, serverLink).catch((e: unknown) => {
    logger.error({ err: e, sName }, 'subsession.stop failed');
    return null;
  });
  if (!result || result.ok) return;
  logger.warn({ sessionName: sName, failed: result.failed }, 'subsession.stop completed with shutdown failures');
}

async function handleSubSessionRestart(cmd: Record<string, unknown>, serverLink: ServerLink): Promise<void> {
  const sName = cmd.sessionName as string | undefined;
  if (!sName) {
    logger.warn('subsession.restart: missing sessionName');
    return;
  }
  const record = getSession(sName);
  if (!record) {
    logger.warn({ sessionName: sName }, 'subsession.restart: session not found in store');
    return;
  }
  const id = sName.replace(/^deck_sub_/, '');
  try {
    await trackPendingSessionRelaunch(sName, (async () => {
      try {
        const effectiveRecord = (await recoverOpenCodeSessionRecord(record)) ?? record;
        await relaunchSessionWithSettings(effectiveRecord, {
          agentType: (cmd.agentType as any) ?? undefined,
          projectDir: ('cwd' in cmd ? (cmd.cwd as string | undefined) : undefined),
          label: ('label' in cmd ? (cmd.label as string | null) : undefined),
          description: ('description' in cmd ? (cmd.description as string | null) : undefined),
          requestedModel: ('requestedModel' in cmd ? (cmd.requestedModel as string | null) : undefined),
          effort: ('effort' in cmd ? (cmd.effort as any) : undefined),
          transportConfig: ('transportConfig' in cmd ? (cmd.transportConfig as Record<string, unknown> | null) : undefined),
        });
        try {
          serverLink.send(await buildSubSessionSync(id));
        } catch { /* not connected */ }
      } catch (e: unknown) {
        logger.error({ err: e, sessionName: sName }, 'subsession.restart failed');
        throw e;
      }
    })());
  } catch {
    // Failure already logged; keep command handler alive for future sends.
  }
}

async function handleSubSessionRebuildAll(cmd: Record<string, unknown>, serverLink: ServerLink): Promise<void> {
  const subSessions = cmd.subSessions as SubSessionRecord[] | undefined;
  if (!Array.isArray(subSessions)) return;
  await rebuildSubSessions(subSessions).catch((e: unknown) => logger.error({ err: e }, 'subsession.rebuild_all failed'));
  for (const sub of subSessions) {
    try {
      serverLink.send(await buildSubSessionSync(sub.id));
    } catch (e) {
      logger.warn({ err: e, id: sub.id }, 'Failed to sync rebuilt sub-session');
    }
  }
}

async function handleSubSessionDetectShells(serverLink: ServerLink): Promise<void> {
  const shells = await detectShells().catch(() => [] as string[]);
  try {
    serverLink.send({ type: 'subsession.shells', shells });
  } catch { /* not connected */ }
}

async function handleSubSessionSetModel(cmd: Record<string, unknown>, serverLink: ServerLink): Promise<void> {
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
  await stopSubSession(sessionName, serverLink).catch(() => {});
  try {
    await startSubSession({ id, type: 'codex', cwd: cwd ?? null, codexModel: model });
    // Sync restarted sub-session to server DB
    try {
      serverLink.send(await buildSubSessionSync(id));
    } catch { /* not connected */ }
  } catch (e: unknown) {
    logger.error({ err: e, sessionName, model }, 'subsession.set_model restart failed');
  }
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

// ── P2P discussion file listing ────────────────────────────────────────────

async function handleP2pListDiscussions(_cmd: Record<string, unknown>, serverLink: ServerLink): Promise<void> {
  // Collect unique project dirs from all sessions
  const projectDirs = new Set<string>();
  for (const s of listSessions()) {
    if (s.projectDir) projectDirs.add(s.projectDir);
  }
  const discussions: Array<{ id: string; fileName: string; path: string; preview: string; mtime: number }> = [];
  for (const projectDir of projectDirs) {
    const dir = imcSubDir(projectDir, 'discussions');
    try {
      const entries = await fsReaddir(dir);
      const files = entries.filter(e => e.endsWith('.md'));
      for (const f of files) {
        try {
          const fullPath = nodePath.join(dir, f);
          const s = await fsStat(fullPath);
          const content = await fsReadFileRaw(fullPath, 'utf8');
          const reqMatch = content.match(/## User Request\s*\n+(.+)/);
          const preview = reqMatch?.[1]?.trim().slice(0, 120) || f;
          discussions.push({ id: f.replace('.md', ''), fileName: f, path: fullPath, preview, mtime: s.mtimeMs });
        } catch { /* skip unreadable */ }
      }
    } catch { /* dir may not exist */ }
  }
  // Sort by mtime descending, cap at 50
  discussions.sort((a, b) => b.mtime - a.mtime);
  serverLink.send({ type: 'p2p.list_discussions_response', discussions: discussions.slice(0, 50) });
}

async function handleP2pReadDiscussion(cmd: Record<string, unknown>, serverLink: ServerLink): Promise<void> {
  const id = cmd.id as string | undefined;
  const requestId = cmd.requestId as string | undefined;
  if (!id) { serverLink.send({ type: 'p2p.read_discussion_response', requestId, error: 'missing_id' }); return; }

  // 1. Check active P2P runs first (in-memory, always fresh)
  for (const run of listP2pRuns()) {
    if (run.id === id || run.discussionId === id) {
      try {
        const content = await fsReadFileRaw(run.contextFilePath, 'utf8');
        serverLink.send({ type: 'p2p.read_discussion_response', id, requestId, content });
        return;
      } catch { /* file may not exist yet */ }
    }
  }

  // 2. Search across all known project .imc/discussions/ directories
  const projectDirs = new Set<string>();
  for (const s of listSessions()) {
    if (s.projectDir) projectDirs.add(s.projectDir);
  }
  for (const projectDir of projectDirs) {
    const filePath = nodePath.join(imcSubDir(projectDir, 'discussions'), `${id}.md`);
    try {
      const content = await fsReadFileRaw(filePath, 'utf8');
      serverLink.send({ type: 'p2p.read_discussion_response', id, requestId, content });
      return;
    } catch { /* try next project */ }
  }
  serverLink.send({ type: 'p2p.read_discussion_response', id, requestId, error: 'not_found' });
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
async function handleDaemonUpgrade(targetVersion?: string, serverLink?: ServerLink): Promise<void> {
  const activeRuns = getActiveP2pRunsBlockingDaemonUpgrade();
  if (activeRuns.length > 0) {
    logger.warn({
      targetVersion,
      activeRunIds: activeRuns.map((run) => run.id),
      activeRunStatuses: activeRuns.map((run) => run.status),
    }, 'daemon.upgrade: blocked because P2P runs are active');
    try {
      serverLink?.send({
        type: DAEMON_MSG.UPGRADE_BLOCKED,
        reason: 'p2p_active',
        activeRunIds: activeRuns.map((run) => run.id),
      });
    } catch { /* ignore */ }
    return;
  }

  const { spawn } = await import('child_process');
  const { writeFileSync, mkdtempSync, existsSync } = await import('fs');
  const { join, dirname } = await import('path');
  const { tmpdir, homedir } = await import('os');

  const { DAEMON_VERSION } = await import('../util/version.js');
  if (targetVersion && DAEMON_VERSION === targetVersion) {
    logger.info({ daemonVersion: DAEMON_VERSION, targetVersion }, 'daemon.upgrade: already at target version, skipping');
    return;
  }

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
    if (existsSync(userSvc)) {
      restartCmd = 'systemctl --user restart imcodes';
    } else {
      restartCmd = 'echo "No user service found. Run: imcodes bind" && exit 1';
    }
  } else if (process.platform === 'darwin') {
    const plist = join(homedir(), 'Library/LaunchAgents/imcodes.daemon.plist');
    const pidFile = join(homedir(), '.imcodes', 'daemon.pid');
    restartCmd = `launchctl unload "${plist}" 2>/dev/null || true
# Kill any lingering daemon processes after unload
STALE_PID=$(cat "${pidFile}" 2>/dev/null)
if [ -n "$STALE_PID" ] && kill -0 "$STALE_PID" 2>/dev/null; then
  kill "$STALE_PID" 2>/dev/null; sleep 2
  kill -0 "$STALE_PID" 2>/dev/null && kill -9 "$STALE_PID" 2>/dev/null
fi
launchctl load -w "${plist}"`;
  } else if (process.platform === 'win32') {
    // Windows: generate a CMD batch script
    const npmBin = join(dirname(process.execPath), 'npm.cmd');
    const npmCmd = existsSync(npmBin) ? npmBin : 'npm';
    const pkgSpec = targetVersion ? `imcodes@${targetVersion}` : 'imcodes@latest';
    const batchPath = join(scriptDir, 'upgrade.cmd');
    const upgradeVbsPath = join(scriptDir, 'upgrade.vbs');
    const cleanupPath = join(scriptDir, 'cleanup.cmd');
    const cleanupVbsPath = join(scriptDir, 'cleanup.vbs');
    const targetVer = targetVersion ?? 'latest';
    // .cmd files: UTF-8 + BOM, and the script itself switches to UTF-8 with
    // `chcp 65001` before touching any non-ASCII paths.
    // .vbs files: UTF-16 LE + BOM so wscript handles non-ASCII paths.
    writeFileSync(cleanupPath, encodeCmdAsUtf8Bom(buildWindowsCleanupScript(scriptDir)));
    writeFileSync(cleanupVbsPath, encodeVbsAsUtf16(buildWindowsCleanupVbs(cleanupPath)));
    const vbsLauncherPath = join(homedir(), '.imcodes', 'daemon-launcher.vbs');
    const batch = buildWindowsUpgradeBatch({
      logFile,
      scriptDir,
      cleanupPath,
      cleanupVbsPath,
      npmCmd,
      pkgSpec,
      targetVer,
      vbsLauncherPath,
      upgradeLockFile: UPGRADE_LOCK_FILE,
    });

    writeFileSync(batchPath, encodeCmdAsUtf8Bom(batch));
    writeFileSync(upgradeVbsPath, encodeVbsAsUtf16(buildWindowsUpgradeVbs(batchPath)));

    // Launch via wscript on the wrapper VBS — this guarantees that ALL child
    // processes spawned by the batch (wmic, find, tasklist, etc.) inherit a
    // fully hidden parent and never flash console windows.
    const child = spawn('wscript', [upgradeVbsPath], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.unref();

    logger.info({ log: logFile }, 'daemon.upgrade: Windows upgrade script spawned');
    return;
  } else {
    logger.warn('daemon.upgrade: unsupported platform, cannot restart service');
    return;
  }

  // Resolve full npm path — bare `npm` may not work in detached shells (nvm not loaded)
  const npmBin = join(dirname(process.execPath), 'npm');
  const npmCmd = existsSync(npmBin) ? npmBin : 'npm';

  const pkgSpec = targetVersion ? `imcodes@${targetVersion}` : 'imcodes@latest';
  const targetVer = targetVersion ?? 'latest';
  const script = `#!/bin/bash
LOG="${logFile}"
echo "=== imcodes upgrade started at $(date) ===" >> "$LOG"

# Give the running daemon a moment to finish sending its response
sleep 3

# Remove npm link if present — it shadows npm install and prevents real upgrades
GLOBAL_PKG=$(${npmCmd} root -g 2>/dev/null)/imcodes
if [ -L "$GLOBAL_PKG" ]; then
  echo "Removing npm link ($GLOBAL_PKG -> $(readlink "$GLOBAL_PKG"))..." >> "$LOG"
  ${npmCmd} uninstall -g imcodes >> "$LOG" 2>&1 || true
fi

# Attempt npm install — only restart if install succeeds
echo "Installing ${pkgSpec}..." >> "$LOG"
if ! "${npmCmd}" install -g ${pkgSpec} >> "$LOG" 2>&1; then
  echo "Install FAILED (exit $?). Keeping current daemon running." >> "$LOG"
  echo "=== upgrade aborted at $(date) ===" >> "$LOG"
  sleep 60 && rm -rf "${scriptDir}" &
  exit 0
fi
echo "Install succeeded." >> "$LOG"

# Verify installed version matches target (skip for "latest")
INSTALLED_VER=$(imcodes --version 2>/dev/null || echo "unknown")
echo "Installed version: $INSTALLED_VER, target: ${targetVer}" >> "$LOG"
if [ "${targetVer}" != "latest" ] && [ "$INSTALLED_VER" != "${targetVer}" ]; then
  echo "Version mismatch after install — keeping current daemon running." >> "$LOG"
  echo "=== upgrade aborted at $(date) ===" >> "$LOG"
  sleep 60 && rm -rf "${scriptDir}" &
  exit 0
fi

# Install succeeded and version verified — restart the service
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

// On Windows, don't restrict paths — projects commonly live on any drive (D:\code, etc.)
// The daemon runs as the user, so OS-level permissions are the real security boundary.
// Deny-list: block access to sensitive directories regardless of platform.
// Everything else is allowed — the daemon runs as the user and inherits their permissions.
const FS_DENIED_DIRS = ['.ssh', '.gnupg', '.pki'];

/** Special sentinel path that browses Windows drive roots (C:\, D:\, ...).
 *  Distinct from `~` so the home directory remains accessible on Windows. */
const WINDOWS_DRIVES_PATH = ':drives:';
const WINDOWS_DRIVES_ROOT = '__imcodes_windows_drives__';

function isPathAllowed(realPath: string): boolean {
  // Block sensitive directories (e.g. ~/.ssh, ~/.gnupg)
  const home = homedir();
  for (const dir of FS_DENIED_DIRS) {
    const denied = nodePath.join(home, dir);
    if (realPath === denied || realPath.startsWith(denied + nodePath.sep)) return false;
  }
  return true;
}

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
    try { serverLink.send({ type: 'p2p.status_response', runId, run: run ? serializeP2pRun(run) : null }); } catch { /* ignore */ }
  } else {
    const runs = listP2pRuns();
    try { serverLink.send({ type: 'p2p.status_response', runs: runs.map((run) => serializeP2pRun(run)) }); } catch { /* ignore */ }
  }
}

// ── File search for @ picker ──────────────────────────────────────────────

const FILE_SEARCH_EXCLUDES = new Set([
  'node_modules', '.git', 'venv', '__pycache__', '.venv',
  'dist', 'build', '.next', '.nuxt', 'vendor', 'target',
]);

const FILE_SEARCH_MAX = 20;

export function getActiveP2pRunsBlockingDaemonUpgrade(runs = listP2pRuns()) {
  return runs.filter((run) => !P2P_TERMINAL_RUN_STATUSES.has(run.status));
}

async function handleFileSearch(cmd: Record<string, unknown>, serverLink: ServerLink): Promise<void> {
  const query = (cmd.query as string ?? '').trim();
  const projectDir = cmd.projectDir as string | undefined;
  const requestId = cmd.requestId as string | undefined;
  if (!requestId || !projectDir) return;

  try {
    // 1. Crawl all files/dirs
    const allPaths: string[] = [];
    async function walk(dir: string, rel: string): Promise<void> {
      if (allPaths.length >= 20000) return;
      let entries: import('fs').Dirent[];
      try { entries = await fsReaddir(dir, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        if (FILE_SEARCH_EXCLUDES.has(entry.name)) continue;
        const relPath = rel ? `${rel}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          if (entry.name.startsWith('.') && entry.name !== '.github') continue;
          allPaths.push(relPath + '/');
          await walk(nodePath.join(dir, entry.name), relPath);
        } else if (entry.isFile()) {
          allPaths.push(relPath);
        }
      }
    }
    await walk(projectDir, '');

    let top: string[];
    if (!query) {
      // No query — return first files alphabetically
      allPaths.sort();
      top = allPaths.slice(0, FILE_SEARCH_MAX);
    } else {
      // 2. Fuzzy search via fzf
      const { Fzf } = await import('fzf');
      const fzf = new Fzf(allPaths, {
        fuzzy: allPaths.length > 20000 ? 'v1' : 'v2',
        forward: false,
        tiebreakers: [fileSearchByBasenamePrefix, fileSearchByMatchPosFromEnd, fileSearchByLengthAsc],
      });
      const results = fzf.find(query);
      top = results.slice(0, FILE_SEARCH_MAX).map((r: { item: string }) => r.item);
    }

    try { serverLink.send({ type: 'file.search_response', requestId, results: top }); } catch { /* ignore */ }
  } catch (err) {
    try { serverLink.send({ type: 'file.search_response', requestId, results: [], error: String(err) }); } catch { /* ignore */ }
  }
}

const FS_LIST_DEADLINE_MS = 10_000;

async function handleFsList(cmd: Record<string, unknown>, serverLink: ServerLink): Promise<void> {
  const rawPath = cmd.path as string | undefined;
  const requestId = cmd.requestId as string | undefined;
  const includeFiles = cmd.includeFiles === true;
  const includeMetadata = cmd.includeMetadata === true;
  if (!rawPath || !requestId) return;

  // Special sentinel paths bypass normal path resolution
  const isDrivesSentinel = rawPath === WINDOWS_DRIVES_PATH;
  const expanded = isDrivesSentinel
    ? rawPath
    : (rawPath.startsWith('~') ? rawPath.replace(/^~/, homedir()) : rawPath);
  const resolved = isDrivesSentinel ? rawPath : nodePath.resolve(expanded);

  const deadline = new Promise<never>((_, reject) => setTimeout(() => reject(new Error('fs_list_timeout')), FS_LIST_DEADLINE_MS));

  try {
    await Promise.race([handleFsListInner(resolved, rawPath, requestId, includeFiles, includeMetadata, serverLink), deadline]);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg === 'fs_list_timeout') {
      try { serverLink.send({ type: 'fs.ls_response', requestId, path: rawPath, status: 'error', error: 'fs_list_timeout' }); } catch { /* ignore */ }
    } else {
      try { serverLink.send({ type: 'fs.ls_response', requestId, path: rawPath, status: 'error', error: msg }); } catch { /* ignore */ }
    }
  }
}

async function handleFsListInner(resolved: string, rawPath: string, requestId: string, includeFiles: boolean, includeMetadata: boolean, serverLink: ServerLink): Promise<void> {
  // Windows drive picker — only triggered by the explicit `:drives:` path,
  // NOT by `~` (which always means the user's home directory on every OS).
  if (process.platform === 'win32' && rawPath === WINDOWS_DRIVES_PATH) {
    const entries = await Promise.all(
      Array.from({ length: 26 }, (_, i) => String.fromCharCode(65 + i))
        .map(async (letter) => {
          const drive = `${letter}:\\`;
          try {
            await fsReaddir(drive, { withFileTypes: true });
            return { name: drive, path: drive, isDir: true, hidden: false };
          } catch {
            return null;
          }
        }),
    );
    try {
      serverLink.send({
        type: 'fs.ls_response',
        requestId,
        path: rawPath,
        resolvedPath: WINDOWS_DRIVES_ROOT,
        status: 'ok',
        entries: entries.filter(Boolean),
      });
    } catch { /* ignore */ }
    return;
  }

  let real: string;
  try {
    real = await fsRealpath(resolved);
  } catch (err) {
    if (process.platform === 'win32') {
      logger.debug({ resolved, err }, 'fsRealpath failed on Windows, falling back to resolved path');
      real = resolved;
    } else {
      throw err;
    }
  }

  const allowed = isPathAllowed(real);
  if (!allowed) {
    try { serverLink.send({ type: 'fs.ls_response', requestId, path: rawPath, resolvedPath: real, status: 'error', error: 'forbidden_path' }); } catch { /* ignore */ }
    return;
  }

  const dirents = await fsReaddir(real, { withFileTypes: true });
  const filtered = dirents.filter((d) => d.isDirectory() || (includeFiles && d.isFile()));

  const entries = await Promise.all(filtered.map(async (d) => {
    const entry: Record<string, unknown> = { name: d.name, path: nodePath.join(real, d.name), isDir: d.isDirectory(), hidden: d.name.startsWith('.') };
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
}

const FS_READ_SIZE_LIMIT = 512 * 1024; // 512 KB

interface FsReadSnapshot {
  fileSignature: string;
  status: 'ok' | 'error';
  content?: string;
  encoding?: 'base64';
  mimeType?: string;
  error?: string;
  previewReason?: 'too_large' | 'binary' | 'unknown_type';
}

const fsReadCache = new Map<string, { expiresAt: number; value: FsReadSnapshot }>();
const fsReadInflight = new Map<string, Promise<FsReadSnapshot>>();
const FS_READ_CACHE_TTL_MS = 5_000;

async function loadFsReadSnapshot(realPath: string, fileSignature: string): Promise<FsReadSnapshot> {
  const ext = nodePath.extname(realPath).toLowerCase().slice(1);
  const IMAGE_MIME: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', ico: 'image/x-icon', bmp: 'image/bmp', svg: 'image/svg+xml' };
  const OFFICE_MIME: Record<string, string> = {
    pdf: 'application/pdf',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  };
  const mimeType = IMAGE_MIME[ext] ?? OFFICE_MIME[ext];

  if (mimeType) {
    const buf = await fsReadFileRaw(realPath);
    return {
      fileSignature,
      status: 'ok',
      content: buf.toString('base64'),
      encoding: 'base64',
      mimeType,
    };
  }

  const content = await fsReadFileRaw(realPath, 'utf-8');
  const sample = content.slice(0, 8192);
  if (sample.includes('\0')) {
    return {
      fileSignature,
      status: 'error',
      error: 'binary_file',
      previewReason: 'binary',
    };
  }

  return {
    fileSignature,
    status: 'ok',
    content,
  };
}

async function getFsReadSnapshot(realPath: string, fileSignature: string): Promise<FsReadSnapshot> {
  const cached = fsReadCache.get(realPath);
  if (cached && cached.expiresAt > Date.now() && cached.value.fileSignature === fileSignature) {
    return cached.value;
  }
  const inflight = fsReadInflight.get(realPath);
  if (inflight) return await inflight;
  const promise = loadFsReadSnapshot(realPath, fileSignature)
    .then((value) => {
      fsReadCache.set(realPath, { value, expiresAt: Date.now() + FS_READ_CACHE_TTL_MS });
      return value;
    })
    .finally(() => {
      fsReadInflight.delete(realPath);
    });
  fsReadInflight.set(realPath, promise);
  return await promise;
}

async function handleFsRead(cmd: Record<string, unknown>, serverLink: ServerLink): Promise<void> {
  const rawPath = cmd.path as string | undefined;
  const requestId = cmd.requestId as string | undefined;
  if (!rawPath || !requestId) return;

  const expanded = rawPath.startsWith('~') ? rawPath.replace(/^~/, homedir()) : rawPath;
  const resolved = nodePath.resolve(expanded);

  try {
    const real = await fsRealpath(resolved);
    const allowed = isPathAllowed(real);
    if (!allowed) {
      try { serverLink.send({ type: 'fs.read_response', requestId, path: rawPath, resolvedPath: real, status: 'error', error: 'forbidden_path' }); } catch { /* ignore */ }
      return;
    }

    const stats = await fsStat(real);
    const fileSignature = `${stats.mtimeMs}:${stats.size}`;

    // Image files: send as base64 with a higher size limit (5 MB)
    const ext = nodePath.extname(real).toLowerCase().slice(1);
    const IMAGE_MIME: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', ico: 'image/x-icon', bmp: 'image/bmp', svg: 'image/svg+xml' };
    // Office documents: send as base64 for frontend preview (PDF.js, docx-preview, xlsx)
    const OFFICE_MIME: Record<string, string> = {
      pdf: 'application/pdf',
      docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    };
    const mimeType = IMAGE_MIME[ext] ?? OFFICE_MIME[ext];
    const sizeLimit = mimeType ? 5 * 1024 * 1024 : FS_READ_SIZE_LIMIT;

    // Always generate a download handle so the file can be downloaded even if preview fails
    const fileName = nodePath.basename(real);
    const handle = createProjectFileHandle(real, fileName, mimeType || MIME_MAP[ext], stats.size);

    if (stats.size > sizeLimit) {
      try { serverLink.send({ type: 'fs.read_response', requestId, path: rawPath, resolvedPath: real, status: 'error', error: 'file_too_large', previewReason: 'too_large', downloadId: handle.id }); } catch { /* ignore */ }
      return;
    }

    const mtime = stats.mtimeMs;
    const snapshot = await getFsReadSnapshot(real, fileSignature);
    if (snapshot.status === 'error') {
      try { serverLink.send({ type: 'fs.read_response', requestId, path: rawPath, resolvedPath: real, status: 'error', error: snapshot.error, previewReason: snapshot.previewReason, downloadId: handle.id }); } catch { /* ignore */ }
      return;
    }
    try {
      serverLink.send({
        type: 'fs.read_response',
        requestId,
        path: rawPath,
        resolvedPath: real,
        status: 'ok',
        content: snapshot.content,
        ...(snapshot.encoding ? { encoding: snapshot.encoding } : {}),
        ...(snapshot.mimeType ? { mimeType: snapshot.mimeType } : {}),
        downloadId: handle.id,
        mtime,
      });
    } catch { /* ignore */ }
  } catch (err) {
    try { serverLink.send({ type: 'fs.read_response', requestId, path: rawPath, status: 'error', error: err instanceof Error ? err.message : String(err) }); } catch { /* ignore */ }
  }
}

const GIT_STATUS_CACHE_TTL_MS = 5_000;
const GIT_DIFF_CACHE_TTL_MS = 5_000;

type GitStatusFile = { path: string; code: string; additions?: number; deletions?: number };

interface RepoContext {
  repoRoot: string;
  gitDir: string;
  repoSignature: string;
}

interface GitStatusSnapshot {
  repoRoot: string;
  repoSignature: string;
  files: GitStatusFile[];
}

interface GitNumstatSnapshot {
  repoRoot: string;
  repoSignature: string;
  stats: Map<string, { additions?: number; deletions?: number }>;
}

interface GitDiffSnapshot {
  repoRoot: string;
  repoSignature: string;
  fileSignature: string;
  diff: string;
}

const gitStatusCache = new Map<string, { expiresAt: number; value: GitStatusSnapshot }>();
const gitStatusInflight = new Map<string, Promise<GitStatusSnapshot>>();
const gitNumstatCache = new Map<string, { expiresAt: number; value: GitNumstatSnapshot }>();
const gitNumstatInflight = new Map<string, Promise<GitNumstatSnapshot>>();
const gitDiffCache = new Map<string, { expiresAt: number; value: GitDiffSnapshot }>();
const gitDiffInflight = new Map<string, Promise<GitDiffSnapshot>>();

function normalizeFsPath(value: string): string {
  return nodePath.resolve(value);
}

function isPathInside(root: string, candidate: string): boolean {
  const normalizedRoot = normalizeFsPath(root);
  const normalizedCandidate = normalizeFsPath(candidate);
  return normalizedCandidate === normalizedRoot || normalizedCandidate.startsWith(normalizedRoot + nodePath.sep);
}

async function safeStatSignature(targetPath: string): Promise<string> {
  try {
    const stats = await fsStat(targetPath);
    return `${stats.mtimeMs}:${stats.size}`;
  } catch {
    return 'missing';
  }
}

async function resolveGitDir(dotGitPath: string, repoRoot: string): Promise<string | null> {
  try {
    const stats = await fsStat(dotGitPath);
    if (stats.isDirectory()) return dotGitPath;
    if (!stats.isFile()) return null;
    const raw = await fsReadFileRaw(dotGitPath, 'utf8');
    const match = raw.match(/^gitdir:\s*(.+)\s*$/mi);
    if (!match?.[1]) return null;
    return nodePath.resolve(repoRoot, match[1].trim());
  } catch {
    return null;
  }
}

async function findRepoRoot(startPath: string): Promise<{ repoRoot: string; gitDir: string } | null> {
  let current = normalizeFsPath(startPath);
  while (true) {
    const dotGit = nodePath.join(current, '.git');
    const gitDir = await resolveGitDir(dotGit, current);
    if (gitDir) return { repoRoot: current, gitDir };
    const parent = nodePath.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}

async function buildRepoSignature(gitDir: string): Promise<string> {
  const indexSig = await safeStatSignature(nodePath.join(gitDir, 'index'));
  const headPath = nodePath.join(gitDir, 'HEAD');
  const headSig = await safeStatSignature(headPath);
  let refSig = 'none';
  try {
    const headRaw = await fsReadFileRaw(headPath, 'utf8');
    const match = headRaw.match(/^ref:\s*(.+)\s*$/m);
    if (match?.[1]) {
      refSig = await safeStatSignature(nodePath.join(gitDir, match[1].trim()));
    }
  } catch {
    refSig = 'missing';
  }
  return `${indexSig}|${headSig}|${refSig}`;
}

async function resolveRepoContext(startPath: string): Promise<RepoContext | null> {
  const repo = await findRepoRoot(startPath);
  if (!repo) return null;
  return {
    repoRoot: repo.repoRoot,
    gitDir: repo.gitDir,
    repoSignature: await buildRepoSignature(repo.gitDir),
  };
}

async function loadRepoGitStatusSnapshot(repoRoot: string, repoSignature: string): Promise<GitStatusSnapshot> {
  const { stdout } = await execAsync('git status --porcelain -u', { cwd: repoRoot, timeout: 5000 });
  const files: GitStatusFile[] = [];
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue;
    const code = line.slice(0, 2).trim();
    const filePath = line.slice(3).trim().replace(/^"(.*)"$/, '$1');
    files.push({ path: nodePath.join(repoRoot, filePath), code });
  }
  return { repoRoot, repoSignature, files };
}

async function getRepoGitStatusSnapshot(startPath: string): Promise<GitStatusSnapshot | null> {
  const context = await resolveRepoContext(startPath);
  if (!context) return null;
  const cached = gitStatusCache.get(context.repoRoot);
  if (cached && cached.expiresAt > Date.now() && cached.value.repoSignature === context.repoSignature) {
    return cached.value;
  }
  const inflight = gitStatusInflight.get(context.repoRoot);
  if (inflight) return await inflight;
  const promise = loadRepoGitStatusSnapshot(context.repoRoot, context.repoSignature)
    .then((value) => {
      gitStatusCache.set(context.repoRoot, { value, expiresAt: Date.now() + GIT_STATUS_CACHE_TTL_MS });
      return value;
    })
    .finally(() => {
      gitStatusInflight.delete(context.repoRoot);
    });
  gitStatusInflight.set(context.repoRoot, promise);
  return await promise;
}

async function loadRepoGitNumstatSnapshot(repoRoot: string, repoSignature: string): Promise<GitNumstatSnapshot> {
  let stdout = '';
  try {
    ({ stdout } = await execAsync('git diff --numstat HEAD', { cwd: repoRoot, timeout: 5000 }));
  } catch {
    try {
      ({ stdout } = await execAsync('git diff --numstat', { cwd: repoRoot, timeout: 5000 }));
    } catch {
      stdout = '';
    }
  }
  const stats = new Map<string, { additions?: number; deletions?: number }>();
  for (const line of stdout.split('\n')) {
    const match = line.match(/^(\d+|-)\t(\d+|-)\t(.+)$/);
    if (!match) continue;
    const additions = match[1] === '-' ? undefined : parseInt(match[1], 10);
    const deletions = match[2] === '-' ? undefined : parseInt(match[2], 10);
    stats.set(nodePath.join(repoRoot, match[3].trim()), { additions, deletions });
  }
  return { repoRoot, repoSignature, stats };
}

async function getRepoGitNumstatSnapshot(startPath: string): Promise<GitNumstatSnapshot | null> {
  const context = await resolveRepoContext(startPath);
  if (!context) return null;
  const cached = gitNumstatCache.get(context.repoRoot);
  if (cached && cached.expiresAt > Date.now() && cached.value.repoSignature === context.repoSignature) {
    return cached.value;
  }
  const inflight = gitNumstatInflight.get(context.repoRoot);
  if (inflight) return await inflight;
  const promise = loadRepoGitNumstatSnapshot(context.repoRoot, context.repoSignature)
    .then((value) => {
      gitNumstatCache.set(context.repoRoot, { value, expiresAt: Date.now() + GIT_STATUS_CACHE_TTL_MS });
      return value;
    })
    .finally(() => {
      gitNumstatInflight.delete(context.repoRoot);
    });
  gitNumstatInflight.set(context.repoRoot, promise);
  return await promise;
}

async function loadFileGitDiffSnapshot(realPath: string, repoRoot: string, repoSignature: string, fileSignature: string): Promise<GitDiffSnapshot> {
  let diff = '';
  try {
    const { stdout } = await execAsync(`git diff HEAD -- ${JSON.stringify(realPath)}`, { cwd: repoRoot, timeout: 5000 });
    diff = stdout;
  } catch { /* ignore */ }
  if (!diff) {
    try {
      const { stdout } = await execAsync(`git diff -- ${JSON.stringify(realPath)}`, { cwd: repoRoot, timeout: 5000 });
      diff = stdout;
    } catch { /* ignore */ }
  }
  return { repoRoot, repoSignature, fileSignature, diff };
}

async function getFileGitDiffSnapshot(realPath: string): Promise<GitDiffSnapshot | null> {
  const context = await resolveRepoContext(nodePath.dirname(realPath));
  if (!context) return null;
  const fileSignature = await safeStatSignature(realPath);
  const cached = gitDiffCache.get(realPath);
  if (
    cached
    && cached.expiresAt > Date.now()
    && cached.value.repoSignature === context.repoSignature
    && cached.value.fileSignature === fileSignature
  ) {
    return cached.value;
  }
  const inflight = gitDiffInflight.get(realPath);
  if (inflight) return await inflight;
  const promise = loadFileGitDiffSnapshot(realPath, context.repoRoot, context.repoSignature, fileSignature)
    .then((value) => {
      gitDiffCache.set(realPath, { value, expiresAt: Date.now() + GIT_DIFF_CACHE_TTL_MS });
      return value;
    })
    .finally(() => {
      gitDiffInflight.delete(realPath);
    });
  gitDiffInflight.set(realPath, promise);
  return await promise;
}

function filterRepoFilesForPath(files: GitStatusFile[], requestedPath: string): GitStatusFile[] {
  return files.filter((file) => isPathInside(requestedPath, file.path));
}

function invalidateGitCachesForPath(targetPath: string): void {
  const normalized = normalizeFsPath(targetPath);
  fsReadCache.delete(normalized);
  fsReadInflight.delete(normalized);
  gitDiffCache.delete(normalized);
  gitDiffInflight.delete(normalized);
  for (const key of gitStatusCache.keys()) {
    if (isPathInside(key, normalized)) gitStatusCache.delete(key);
  }
  for (const key of gitNumstatCache.keys()) {
    if (isPathInside(key, normalized)) gitNumstatCache.delete(key);
  }
}

export function __resetFsGitCachesForTests(): void {
  fsReadCache.clear();
  fsReadInflight.clear();
  gitStatusCache.clear();
  gitStatusInflight.clear();
  gitNumstatCache.clear();
  gitNumstatInflight.clear();
  gitDiffCache.clear();
  gitDiffInflight.clear();
}

/** fs.git_status — return git modified file list for a directory */
async function handleFsGitStatus(cmd: Record<string, unknown>, serverLink: ServerLink): Promise<void> {
  const rawPath = cmd.path as string | undefined;
  const requestId = cmd.requestId as string | undefined;
  const includeStats = cmd.includeStats === true;
  if (!rawPath || !requestId) return;

  const expanded = rawPath.startsWith('~') ? rawPath.replace(/^~/, homedir()) : rawPath;
  const resolved = nodePath.resolve(expanded);

  try {
    const real = await fsRealpath(resolved);
    const allowed = isPathAllowed(real);
    if (!allowed) {
      try { serverLink.send({ type: 'fs.git_status_response', requestId, path: rawPath, status: 'error', error: 'forbidden_path' }); } catch { /* ignore */ }
      return;
    }
    const [snapshot, numstat] = await Promise.all([
      getRepoGitStatusSnapshot(real),
      includeStats ? getRepoGitNumstatSnapshot(real) : Promise.resolve(null),
    ]);
    const files = snapshot ? filterRepoFilesForPath(snapshot.files, real).map((file) => {
      const stats = numstat?.stats.get(file.path);
      return stats ? { ...file, ...stats } : file;
    }) : [];
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
    const allowed = isPathAllowed(real);
    if (!allowed) {
      try { serverLink.send({ type: 'fs.git_diff_response', requestId, path: rawPath, status: 'error', error: 'forbidden_path' }); } catch { /* ignore */ }
      return;
    }
    const snapshot = await getFileGitDiffSnapshot(real);
    const diff = snapshot?.diff ?? '';
    // Untracked files: no diff (nothing meaningful to compare against)
    try { serverLink.send({ type: 'fs.git_diff_response', requestId, path: rawPath, resolvedPath: real, status: 'ok', diff }); } catch { /* ignore */ }
  } catch (err) {
    try { serverLink.send({ type: 'fs.git_diff_response', requestId, path: rawPath, status: 'error', error: err instanceof Error ? err.message : String(err) }); } catch { /* ignore */ }
  }
}

/** fs.mkdir — create a directory */
async function handleFsMkdir(cmd: Record<string, unknown>, serverLink: ServerLink): Promise<void> {
  const rawPath = cmd.path as string | undefined;
  const requestId = cmd.requestId as string | undefined;
  if (!rawPath || !requestId) return;

  const expanded = rawPath.startsWith('~') ? rawPath.replace(/^~/, homedir()) : rawPath;
  const resolved = nodePath.resolve(expanded);

  // Check parent directory is in allowed roots
  const parent = nodePath.dirname(resolved);
  try {
    const realParent = await fsRealpath(parent);
    const allowed = isPathAllowed(realParent);
    if (!allowed) {
      try { serverLink.send({ type: 'fs.mkdir_response', requestId, path: rawPath, status: 'error', error: 'forbidden_path' }); } catch { /* ignore */ }
      return;
    }
  } catch {
    try { serverLink.send({ type: 'fs.mkdir_response', requestId, path: rawPath, status: 'error', error: 'parent_not_found' }); } catch { /* ignore */ }
    return;
  }

  try {
    const { mkdir } = await import('fs/promises');
    await mkdir(resolved, { recursive: true });
    const real = await fsRealpath(resolved);
    try { serverLink.send({ type: 'fs.mkdir_response', requestId, path: rawPath, resolvedPath: real, status: 'ok' }); } catch { /* ignore */ }
  } catch (err) {
    try { serverLink.send({ type: 'fs.mkdir_response', requestId, path: rawPath, status: 'error', error: err instanceof Error ? err.message : String(err) }); } catch { /* ignore */ }
  }
}

/** fs.write — write a file (with optional mtime conflict detection) */
async function handleFsWrite(cmd: Record<string, unknown>, serverLink: ServerLink): Promise<void> {
  const rawPath = cmd.path as string | undefined;
  const requestId = cmd.requestId as string | undefined;
  const content = cmd.content as string | undefined;
  if (!rawPath || !requestId || content === undefined) {
    if (requestId) {
      try { serverLink.send({ type: 'fs.write_response', requestId, path: rawPath ?? '', status: 'error', error: 'invalid_request' }); } catch { /* ignore */ }
    }
    return;
  }

  const expectedMtime = typeof cmd.expectedMtime === 'number' ? cmd.expectedMtime : undefined;

  const expanded = rawPath.startsWith('~') ? rawPath.replace(/^~/, homedir()) : rawPath;
  const resolved = nodePath.resolve(expanded);

  // Size check first (cheap, before any I/O)
  if (Buffer.byteLength(content, 'utf-8') > 1_048_576) {
    try { serverLink.send({ type: 'fs.write_response', requestId, path: rawPath, status: 'error', error: 'file_too_large' }); } catch { /* ignore */ }
    return;
  }

  // Determine if file exists to choose sandbox validation strategy
  let fileExists = false;
  try {
    await fsStat(resolved);
    fileExists = true;
  } catch {
    fileExists = false;
  }

  if (fileExists) {
    // Existing file: realpath of target must be within FS_ALLOWED_ROOTS
    try {
      const real = await fsRealpath(resolved);
      const allowed = isPathAllowed(real);
      if (!allowed) {
        try { serverLink.send({ type: 'fs.write_response', requestId, path: rawPath, resolvedPath: real, status: 'error', error: 'forbidden_path' }); } catch { /* ignore */ }
        return;
      }

      // mtime conflict check
      if (expectedMtime !== undefined) {
        const stats = await fsStat(real);
        if (stats.mtimeMs !== expectedMtime) {
          // Read disk content (capped at 1MB)
          let diskContent: string | undefined;
          try {
            const diskBuf = await fsReadFileRaw(real, 'utf-8');
            diskContent = Buffer.byteLength(diskBuf, 'utf-8') > 1_048_576
              ? diskBuf.slice(0, 1_048_576)
              : diskBuf;
          } catch { /* ignore read errors for conflict content */ }
          try { serverLink.send({ type: 'fs.write_response', requestId, path: rawPath, resolvedPath: real, status: 'conflict', diskContent, diskMtime: stats.mtimeMs }); } catch { /* ignore */ }
          return;
        }
      }

      // Write the file
      await fsWriteFile(real, content, 'utf-8');
      const newStats = await fsStat(real);
      invalidateGitCachesForPath(real);
      try { serverLink.send({ type: 'fs.write_response', requestId, path: rawPath, resolvedPath: real, status: 'ok', mtime: newStats.mtimeMs }); } catch { /* ignore */ }
    } catch (err) {
      try { serverLink.send({ type: 'fs.write_response', requestId, path: rawPath, status: 'error', error: err instanceof Error ? err.message : String(err) }); } catch { /* ignore */ }
    }
  } else {
    // New file: realpath of parent must be within FS_ALLOWED_ROOTS
    const parent = nodePath.dirname(resolved);
    try {
      const realParent = await fsRealpath(parent);
      const allowed = isPathAllowed(realParent);
      if (!allowed) {
        try { serverLink.send({ type: 'fs.write_response', requestId, path: rawPath, status: 'error', error: 'forbidden_path' }); } catch { /* ignore */ }
        return;
      }
      // Write the file
      await fsWriteFile(resolved, content, 'utf-8');
      const newStats = await fsStat(resolved);
      const real = await fsRealpath(resolved);
      invalidateGitCachesForPath(real);
      try { serverLink.send({ type: 'fs.write_response', requestId, path: rawPath, resolvedPath: real, status: 'ok', mtime: newStats.mtimeMs }); } catch { /* ignore */ }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const isNotFound = msg.includes('ENOENT') || msg.includes('no such file');
      try { serverLink.send({ type: 'fs.write_response', requestId, path: rawPath, status: 'error', error: isNotFound ? 'parent_not_found' : msg }); } catch { /* ignore */ }
    }
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

// ── Transport chat history replay ─────────────────────────────────────────────

async function handleChatSubscribeReplay(cmd: Record<string, unknown>, serverLink: ServerLink): Promise<void> {
  const sessionId = cmd.sessionId as string | undefined;
  if (!sessionId) return;
  try {
    const { replayTransportHistory } = await import('./transport-history.js');
    const events = await replayTransportHistory(sessionId);
    if (events.length === 0) return;
    // Send history as a batch so the browser can render them before live events
    serverLink.send({ type: 'chat.history', sessionId, events });
    logger.debug({ sessionId, count: events.length }, 'Replayed transport chat history');
  } catch (err) {
    logger.debug({ sessionId, err }, 'Transport history replay failed');
  }
}

/** Handle provider.list_sessions — list remote sessions from a provider, materialize + respond. */
async function handleListProviderSessions(cmd: Record<string, unknown>, serverLink: ServerLink): Promise<void> {
  const providerId = (cmd.providerId as string) || 'openclaw';
  try {
    // Materialize any new sessions (side-effectful — creates sessions/sub-sessions)
    if (providerId === 'openclaw') {
      const { syncOcSessions } = await import('./oc-session-sync.js');
      await syncOcSessions(serverLink).catch((e) => logger.warn({ err: e }, 'OC sync during refresh failed'));
    }
    const sessions = await listProviderSessions(providerId);
    // Send via sync_sessions — bridge handles this type: caches, persists to DB, and broadcasts to browsers
    serverLink.send({ type: 'provider.sync_sessions', providerId, sessions });
  } catch (err) {
    logger.warn({ err, providerId }, 'Failed to list provider sessions');
    serverLink.send({ type: 'provider.sync_sessions', providerId, sessions: [] });
  }
}

// ── File search tiebreakers for fzf (exported for unit testing) ──────────────

type FzfEntry = { item: string; positions: Set<number> };

/** Tiebreaker: prefer matches in the basename (filename) over directory path. */
export function fileSearchByBasenamePrefix(a: FzfEntry, b: FzfEntry): number {
  const getBasenameStart = (p: string) => {
    const trimmed = p.endsWith('/') ? p.slice(0, -1) : p;
    return Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\')) + 1;
  };
  const aDiff = Math.min(...a.positions) - getBasenameStart(a.item);
  const bDiff = Math.min(...b.positions) - getBasenameStart(b.item);
  const aIsFilename = aDiff >= 0;
  const bIsFilename = bDiff >= 0;
  if (aIsFilename && !bIsFilename) return -1;
  if (!aIsFilename && bIsFilename) return 1;
  if (aIsFilename && bIsFilename) return aDiff - bDiff;
  return 0;
}

/** Tiebreaker: prefer matches closer to the end of the path. */
export function fileSearchByMatchPosFromEnd(a: FzfEntry, b: FzfEntry): number {
  const maxPosA = Math.max(-1, ...a.positions);
  const maxPosB = Math.max(-1, ...b.positions);
  return (a.item.length - maxPosA) - (b.item.length - maxPosB);
}

/** Tiebreaker: prefer shorter paths. */
export function fileSearchByLengthAsc(a: FzfEntry, b: FzfEntry): number {
  return a.item.length - b.item.length;
}

/** Reusable: fetch remote sessions from a provider. */
export async function listProviderSessions(providerId: string): Promise<Array<{ key: string; displayName?: string; agentId?: string; updatedAt?: number; percentUsed?: number }>> {
  return listProviderSessionsImpl(providerId);
}

// ── CC env presets ────────────────────────────────────────────────────────

async function handleCcPresetsList(serverLink: ServerLink): Promise<void> {
  const { loadPresets } = await import('./cc-presets.js');
  const presets = await loadPresets();
  serverLink.send({ type: 'cc.presets.list_response', presets });
}

async function handleCcPresetsSave(cmd: Record<string, unknown>, serverLink: ServerLink): Promise<void> {
  const presets = cmd.presets as Array<{ name: string; env: Record<string, string> }> | undefined;
  if (!presets) return;
  const { savePresets, invalidateCache } = await import('./cc-presets.js');
  invalidateCache();
  await savePresets(presets);
  serverLink.send({ type: 'cc.presets.save_response', ok: true });
}
