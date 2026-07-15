import { access, copyFile, open, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { constants as fsConstants, watch, type FSWatcher } from 'node:fs';
import { homedir } from 'node:os';
import { extname, join, resolve, sep } from 'node:path';
import { getCodexHome, recentCodexSessionDirs, findCodexRolloutPathByUuid } from '../../util/codex-rollout-path.js';
import { TextDecoder } from 'node:util';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import readline, { type Interface as ReadlineInterface } from 'node:readline';
import { killProcessTree } from '../../util/kill-process-tree.js';
import type {
  TransportProvider,
  ProviderCapabilities,
  ProviderConfig,
  ProviderError,
  ProviderRolloutCompletionReconcileOptions,
  ProviderModelList,
  SessionConfig,
  SessionInfoUpdate,
  ProviderStatusUpdate,
  ProviderUsageUpdate,
  ToolCallEvent,
  SdkTurnLostRecoveryMetadata,
} from '../transport-provider.js';
import {
  CONNECTION_MODES,
  normalizeProviderPayload,
  SESSION_OWNERSHIP,
  PROVIDER_ERROR_CODES,
  SDK_TURN_LOST_REASON,
} from '../transport-provider.js';
import type { AgentMessage, MessageDelta } from '../../../shared/agent-message.js';
import type { ProviderContextPayload } from '../../../shared/context-types.js';
import type {
  ActivityGeneration,
  CodexLifecycleItemKind,
  ProviderActiveWorkSnapshot,
  SessionActivityBusyReason,
  ToolTerminalReason,
  ToolTerminalStatus,
} from '../../../shared/session-activity-types.js';
import {
  buildCodexLifecycleTerminalMetadata,
} from '../../../shared/session-activity-types.js';
import {
  normalizeActivityGeneration,
  sameActivityGeneration,
  type ActivityGenerationLike,
} from '../../../shared/session-activity-types.js';
import {
  SESSION_CONTROL_METADATA_COMMAND_FIELD,
  isSessionControlCommandText,
} from '../../../shared/session-control-commands.js';
import type { TransportAttachment } from '../../../shared/transport-attachments.js';
import logger from '../../util/logger.js';
import { CODEX_SDK_EFFORT_LEVELS, type TransportEffortLevel } from '../../../shared/effort-levels.js';
import { normalizeTransportCwd, resolveExecutableForSpawn } from '../transport-paths.js';
import { getCodexBaseInstructions } from '../codex-runtime-config.js';
import { buildGeneratedImageReportingPrompt } from '../../../shared/transport-runtime-prompts.js';
import { composeProviderSystemText, getProviderSystemTextParts } from '../provider-context-routing.js';
import { getDefaultCodexMcpArgs } from './getDefaultCodexMcpArgs.js';
import { getDefaultMcpServers } from './getDefaultMcpServers.js';
import { IMCODES_MEMORY_MCP_SERVER_NAME } from '../../../shared/memory-mcp-server-name.js';
import { MEMORY_MCP_STATUS, type MemoryMcpProviderStatusView } from '../../../shared/memory-ws.js';
import {
  SDK_SUBAGENT_DETAIL_KIND,
  SDK_SUBAGENT_DIAGNOSTIC,
  SDK_SUBAGENT_PROVIDERS,
  SDK_SUBAGENT_PROVIDER_KINDS,
  SDK_SUBAGENT_SCHEMA_VERSION,
  SDK_SUBAGENT_STATUS,
  buildSdkSubagentSafeDetail,
  isBackgroundedSdkSubagentTool,
  makeCodexSubagentCanonicalKey,
  readSdkSubagentStartedAtMs,
  type SdkSubagentDetail,
  type SdkSubagentDiagnosticCode,
  type SdkSubagentNormalizedStatus,
} from '../../../shared/sdk-subagent-status.js';

const CODEX_BIN = 'codex';
const CANCEL_INTERRUPT_TIMEOUT_MS = 1_500;
const COMPACT_START_ACCEPT_TIMEOUT_MS = 15_000;
const COMPACT_NO_SIGNAL_SETTLE_MS = 5_000;
const COMPACT_HARD_TIMEOUT_MS = 120_000;
const TERMINATED_TURN_CACHE_LIMIT = 200;
// `thread/status` and `thread/read` idle/completed states are app-server
// liveness hints, not terminal proof. Healthy turns should end via explicit
// `turn/completed`; app-server zombies may be settled only from Codex core's
// durable rollout `task_complete` evidence.
const TERMINATED_COMPACT_TURN_CACHE_LIMIT = 80;
const CODEX_TURN_HEARTBEAT_STRONG_GRACE_MS = 50_000;
const CODEX_TURN_HEARTBEAT_INTERVAL_MS = 20_000;
// Cross-check for an app-server zombie turn: codex core can finish a turn
// (rollout records `task_complete`, needs_follow_up=false) while the
// app-server's turn state never transitions — no `turn/completed` is sent,
// `thread/read` keeps reporting the turn active, and `turn/interrupt` will
// happily "cancel" the already-finished turn. Observed on deck_cd_brain:
// task_complete written at 07:20:03, zero further thread activity, heartbeats
// classified "active" for 34 minutes until the daemon's 30-min last-resort
// force-settled the session. A `task_complete` for the running turn in the
// rollout is AUTHORITATIVE completion evidence — verified live that the
// app-server's `turn/started` id equals the core rollout `turn_id`, so the match
// cannot mistake a different turn. Because it is authoritative we do NOT wait
// long: this threshold only has to be large enough to let the normal
// `turn/completed` path (which lands ~1s after task_complete on healthy turns)
// settle first, so healthy turns go through it and only zombies fall through to
// the rollout cross-check — settled at the next heartbeat rather than after a
// minute of silence. (Detection is still bounded below by CODEX_TURN_HEARTBEAT_INTERVAL_MS.)
// Env override for tuning: IMCODES_CODEX_ROLLOUT_COMPLETE_SILENCE_MS.
const CODEX_ROLLOUT_TASK_COMPLETE_SILENCE_MS = (() => {
  const raw = Number.parseInt(process.env.IMCODES_CODEX_ROLLOUT_COMPLETE_SILENCE_MS ?? '', 10);
  return Number.isFinite(raw) && raw >= 1_000 ? raw : 5_000;
})();
const CODEX_ROLLOUT_TASK_COMPLETE_TAIL_BYTES = 256 * 1024;
const CODEX_TURN_HEARTBEAT_JITTER_MS = 5_000;
const CODEX_TURN_HEARTBEAT_TIMEOUT_MS = 5_000;
const CODEX_TURN_HEARTBEAT_FAILURE_THRESHOLD = 3;
const CODEX_TURN_HEARTBEAT_START_GRACE_MS = 15_000;
const CODEX_TURN_HEARTBEAT_PROVIDER_CAP = 2;
const CODEX_TURN_HEARTBEAT_MAX_TURNS = 100;
const DEFAULT_CODEX_SDK_CONTEXT_INJECTION_MAX_CHARS = 32_000;
const MIN_CODEX_SDK_CONTEXT_INJECTION_MAX_CHARS = 4_000;
const MAX_CODEX_SDK_CONTEXT_INJECTION_MAX_CHARS = 128_000;
const IMCODES_CODEX_BASE_INSTRUCTIONS_MARKER = '# IM.codes runtime instructions';
const GENERATED_IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp']);
const CODEX_COLLAB_MAX_RECEIVERS = 100;
const CODEX_COLLAB_MAX_STATE_KEYS = 200;
const CODEX_COLLAB_MAX_ID_CHARS = 160;
const CODEX_RUNTIME_SUBAGENT_METHODS = new Set([
  'subagent_notification',
  'subagent/notification',
  'subagent/status',
  'agent/subagent_notification',
  'agent/subagent/status',
  'runtime/subagent_notification',
  'runtime/subagent/status',
]);

const CODEX_TOOL_LIKE_ITEM_TYPES = new Set([
  'commandExecution',
  'mcpToolCall',
  'customToolCall',
  'custom_tool_call',
  'customTool',
  'custom_tool',
]);
const CODEX_CUSTOM_TOOL_LIFECYCLE_CACHE_LIMIT = 2_000;
type CodexAppServerDisconnectClass =
  | 'intentional_shutdown'
  | 'auth_refresh_restart'
  | 'unexpected_eof'
  | 'unexpected_crash'
  | 'no_current_work_disconnect';

const CODEX_RUNTIME_SUBAGENT_ITEM_TYPES = new Set([
  'subagentnotification',
  'subagentstatus',
  'runtimesubagent',
  'runtimesubagentnotification',
]);
const CODEX_RAW_SPAWN_AGENT_FUNCTION_NAMES = new Set(['spawn_agent', 'spawnAgent']);
const CODEX_RAW_CHECKLIST_FUNCTION_NAMES = new Set([
  'todowrite',
  'todo_write',
  'write_todos',
  'update_plan',
  'updateplan',
  'update_todo_list',
  'set_plan',
  'setplan',
]);
const CODEX_RAW_CHECKLIST_HISTORY_TAIL_BYTES = 512 * 1024;
const CODEX_RAW_CHECKLIST_HISTORY_CLOCK_SKEW_MS = 5_000;
const CODEX_RAW_CHECKLIST_POLL_INTERVAL_MS = 2_000;
const CODEX_RAW_CHECKLIST_POLL_WINDOW_MS = 20_000;
// Lightweight per-turn rollout tail poll whose only job is to catch app-server
// zombie turns fast (settle from core's `task_complete`). A tail read is far
// cheaper than a `thread/read` RPC, so this runs on a short cadence for the whole
// turn instead of piggybacking the ~20s heartbeat — bounding zombie recovery to
// a few seconds. The read itself is still gated by CODEX_ROLLOUT_TASK_COMPLETE_SILENCE_MS
// (so healthy, actively-streaming turns never touch the file).
const CODEX_ROLLOUT_SETTLE_POLL_INTERVAL_MS = 2_000;
// Store-driven health-poll BACKSTOP grace. The runtime also owns an independent
// 2s poll with a 2s grace so a provider-side watcher teardown cannot leave a
// false-working turn visible for a whole health cycle. This longer default is
// retained for callers that do not carry the runtime's generation/ownership
// evidence.
const CODEX_ROLLOUT_TERMINAL_BACKSTOP_MIN_AGE_MS = 90_000;
// ROLLOUT-FIRST AUTHORITY: codex-core writes a terminal `task_complete{turn_id}`
// to the thread's rollout the instant the model finishes a turn — empirically
// ~2s BEFORE the process would even exit, and terminal in 2813/2813 sampled
// turns. We attach a real-time `fs.watch` to that file so a dropped or absent
// app-server `turn/completed` costs ~0ms instead of 60s+ (or forever on a hard
// zombie). Unlike the legacy settle poll, this path has NO 60s silence gate and
// does NOT depend on the heartbeat lease or any further app-server notification:
// the kernel wakes us on the append, and the rollout record is authoritative
// terminal evidence for that exact turn. The debounce only coalesces the burst
// of change events that a single append can trigger.
const CODEX_ROLLOUT_AUTHORITY_DEBOUNCE_MS = 40;
const CODEX_CHILD_SUBAGENT_ROLLOUT_POLL_INTERVAL_MS = 2_000;
const CODEX_CHILD_SUBAGENT_ROLLOUT_POLL_WINDOW_MS = 15 * 60_000;
const CODEX_CHILD_SUBAGENT_ROLLOUT_CLOCK_SKEW_MS = 5_000;

interface CodexRawSpawnAgentCall {
  sessionId: string;
  callId: string;
  args: Record<string, any>;
  startedAtMs: number;
}

interface CodexCustomToolLifecycle {
  tool: ToolCallEvent;
  terminal: boolean;
}

interface CodexTrackedSubagentThread {
  sessionId: string;
  callId: string;
  agentId: string;
  agentName?: string;
  prompt?: string;
  model?: string;
  lastStatus?: unknown;
  usageTotalTokens?: number;
  rolloutPath?: string;
  startedAtMs?: number;
}

interface CodexChildSubagentRolloutSnapshot {
  agentId: string;
  parentThreadId: string;
  rolloutPath: string;
  cwd?: string;
  imcodesSessionName?: string;
  agentName?: string;
  prompt?: string;
  model?: string;
  completed: boolean;
  output?: string;
  usageTotalTokens?: number;
  startedAtMs?: number;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// Rollout path helpers (getCodexHome, recentCodexSessionDirs, and the
// age/timezone-robust findCodexRolloutPathByUuid) are shared via
// ../../util/codex-rollout-path.ts — do not re-implement per-provider.

function parseCodexRolloutJsonLine(line: string): Record<string, any> | null {
  if (!line.trim()) return null;
  try {
    const parsed = JSON.parse(line);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function codexRolloutPayload(record: Record<string, any>): Record<string, any> {
  return isRecord(record.payload) ? record.payload : record;
}

function readCodexChildSubagentSpawn(payload: Record<string, any>): {
  parentThreadId: string;
  agentId?: string;
  agentName?: string;
} | null {
  const source = isRecord(payload.source) ? payload.source : undefined;
  const subagent = isRecord(source?.subagent) ? source.subagent : undefined;
  const spawn = isRecord(subagent?.thread_spawn) ? subagent.thread_spawn : undefined;
  const parentThreadId = meaningfulString(spawn?.parent_thread_id)
    ?? meaningfulString(spawn?.parentThreadId);
  if (!parentThreadId) return null;
  const agentId = meaningfulString(payload.id)
    ?? meaningfulString(spawn?.agent_id)
    ?? meaningfulString(spawn?.agentId)
    ?? meaningfulString(spawn?.thread_id)
    ?? meaningfulString(spawn?.threadId)
    ?? meaningfulString(spawn?.agent_path)
    ?? meaningfulString(spawn?.agentPath);
  const agentName = meaningfulString(payload.agent_nickname)
    ?? meaningfulString(spawn?.agent_nickname)
    ?? meaningfulString(spawn?.agentNickname)
    ?? meaningfulString(payload.agent_role)
    ?? meaningfulString(spawn?.agent_role)
    ?? meaningfulString(spawn?.agentRole);
  return { parentThreadId, ...(agentId ? { agentId } : {}), ...(agentName ? { agentName } : {}) };
}

function readCodexRolloutUserMessage(payload: Record<string, any>): string | undefined {
  if (payload.type === 'user_message') return meaningfulString(payload.message);
  if (payload.type !== 'message' || payload.role !== 'user') return undefined;
  const content = Array.isArray(payload.content) ? payload.content : [];
  const parts: string[] = [];
  for (const item of content) {
    if (!isRecord(item)) continue;
    const text = meaningfulString(item.text);
    if (text) parts.push(text);
  }
  return parts.length > 0 ? parts.join('\n') : undefined;
}

function readCodexRolloutUsageTotalTokens(payload: Record<string, any>): number | undefined {
  if (payload.type !== 'token_count') return undefined;
  const info = isRecord(payload.info) ? payload.info : undefined;
  const total = isRecord(info?.total_token_usage) ? info.total_token_usage : undefined;
  return finiteNumber(total?.total_tokens);
}

function readCodexRolloutBaseInstructionsText(payload: Record<string, any>): string | undefined {
  const baseInstructions = payload.base_instructions;
  if (typeof baseInstructions === 'string') return meaningfulString(baseInstructions);
  if (isRecord(baseInstructions)) return meaningfulString(baseInstructions.text);
  return meaningfulString(payload.instructions);
}

function readImcodesSessionNameFromBaseInstructions(text: string | undefined): string | undefined {
  if (!text) return undefined;
  const match = /(?:^|\n)\s*-\s*Exact session name:\s*([^\n]+)/.exec(text)
    ?? /(?:^|\n)\s*Exact session name:\s*([^\n]+)/.exec(text);
  if (!match) return undefined;
  return match[1]?.trim().replace(/^`|`$/g, '') || undefined;
}

function childSubagentIdFromRolloutPath(path: string): string | undefined {
  const match = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i.exec(path);
  return match?.[1];
}

async function readCodexChildSubagentRolloutSnapshot(
  rolloutPath: string,
  parentThreadId?: string,
): Promise<CodexChildSubagentRolloutSnapshot | null> {
  let text: string;
  try {
    text = await readFile(rolloutPath, 'utf8');
  } catch {
    return null;
  }
  let spawn: ReturnType<typeof readCodexChildSubagentSpawn> = null;
  let prompt: string | undefined;
  let model: string | undefined;
  let cwd: string | undefined;
  let imcodesSessionName: string | undefined;
  let completed = false;
  let output: string | undefined;
  let usageTotalTokens: number | undefined;
  let startedAtMs: number | undefined;
  for (const line of text.split('\n')) {
    const record = parseCodexRolloutJsonLine(line);
    if (!record) continue;
    if (startedAtMs === undefined) {
      const timestamp = meaningfulString(record.timestamp);
      const parsedTimestamp = timestamp ? Date.parse(timestamp) : NaN;
      if (Number.isFinite(parsedTimestamp)) startedAtMs = parsedTimestamp;
    }
    const payload = codexRolloutPayload(record);
    const nextSpawn = readCodexChildSubagentSpawn(payload);
    if (nextSpawn) spawn = nextSpawn;
    if (!cwd) cwd = meaningfulString(payload.cwd);
    if (!imcodesSessionName) {
      imcodesSessionName = readImcodesSessionNameFromBaseInstructions(
        readCodexRolloutBaseInstructionsText(payload),
      );
    }
    if (!prompt) prompt = readCodexRolloutUserMessage(payload);
    if (!model) model = meaningfulString(payload.model);
    const totalTokens = readCodexRolloutUsageTotalTokens(payload);
    if (totalTokens !== undefined) usageTotalTokens = totalTokens;
    if (payload.type === 'task_complete') {
      completed = true;
      output = meaningfulString(payload.last_agent_message)
        ?? meaningfulString(payload.result)
        ?? meaningfulString(payload.message)
        ?? 'completed';
    }
  }
  if (!spawn) return null;
  if (parentThreadId && spawn.parentThreadId !== parentThreadId) return null;
  const agentId = spawn.agentId ?? childSubagentIdFromRolloutPath(rolloutPath);
  if (!agentId) return null;
  return {
    agentId,
    parentThreadId: spawn.parentThreadId,
    rolloutPath,
    ...(cwd ? { cwd } : {}),
    ...(imcodesSessionName ? { imcodesSessionName } : {}),
    ...(spawn.agentName ? { agentName: spawn.agentName } : {}),
    ...(prompt ? { prompt } : {}),
    ...(model ? { model } : {}),
    completed,
    ...(output ? { output } : {}),
    ...(usageTotalTokens !== undefined ? { usageTotalTokens } : {}),
    ...(startedAtMs !== undefined ? { startedAtMs } : {}),
  };
}

async function discoverCodexChildSubagentRollouts(
  env: Record<string, string | undefined>,
  parentThreadId: string,
  minMtimeMs: number,
): Promise<CodexChildSubagentRolloutSnapshot[]> {
  return discoverCodexChildSubagentRolloutsByPredicate(env, minMtimeMs, async (rolloutPath) => (
    readCodexChildSubagentRolloutSnapshot(rolloutPath, parentThreadId)
  ));
}

async function discoverCodexChildSubagentRolloutsBySession(
  env: Record<string, string | undefined>,
  sessionId: string,
  cwd: string,
  minMtimeMs: number,
): Promise<CodexChildSubagentRolloutSnapshot[]> {
  const normalizedCwd = normalizeTransportCwd(cwd) ?? cwd;
  return discoverCodexChildSubagentRolloutsByPredicate(env, minMtimeMs, async (rolloutPath) => {
    const snapshot = await readCodexChildSubagentRolloutSnapshot(rolloutPath);
    if (!snapshot) return null;
    if (snapshot.imcodesSessionName !== sessionId) return null;
    if (snapshot.cwd) {
      const snapshotCwd = normalizeTransportCwd(snapshot.cwd) ?? snapshot.cwd;
      if (snapshotCwd !== normalizedCwd) return null;
    }
    return snapshot;
  });
}

async function discoverCodexChildSubagentRolloutsByPredicate(
  env: Record<string, string | undefined>,
  minMtimeMs: number,
  readSnapshot: (rolloutPath: string) => Promise<CodexChildSubagentRolloutSnapshot | null>,
): Promise<CodexChildSubagentRolloutSnapshot[]> {
  const codexHome = getCodexHome(env);
  const snapshots: CodexChildSubagentRolloutSnapshot[] = [];
  const minMtimeWithSkew = minMtimeMs - CODEX_CHILD_SUBAGENT_ROLLOUT_CLOCK_SKEW_MS;
  for (const dir of recentCodexSessionDirs(codexHome)) {
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (!name.startsWith('rollout-') || !name.endsWith('.jsonl')) continue;
      const rolloutPath = join(dir, name);
      try {
        const info = await stat(rolloutPath);
        if (info.mtimeMs < minMtimeWithSkew) continue;
      } catch {
        continue;
      }
      const snapshot = await readSnapshot(rolloutPath);
      if (snapshot) snapshots.push(snapshot);
    }
  }
  return snapshots;
}

function isCodexAuthFailureMessage(message: string): boolean {
  return /401\s+Unauthorized/i.test(message)
    || /Missing bearer or basic authentication/i.test(message)
    || /not authenticated/i.test(message)
    || /authentication required/i.test(message);
}

function getCodexAuthPath(env: Record<string, string | undefined>): string {
  return resolve(getCodexHome(env), 'auth.json');
}

async function readCodexAuthFingerprint(env: Record<string, string | undefined>): Promise<string | null> {
  try {
    const authPath = getCodexAuthPath(env);
    const stats = await stat(authPath);
    return `${authPath}:${Math.trunc(stats.mtimeMs)}:${stats.size}`;
  } catch {
    return null;
  }
}

function isCodexThreadHistoryUnreadableError(err: unknown): boolean {
  const message = errorMessage(err).toLowerCase();
  return (
    message.includes('failed to read thread')
    && (
      message.includes('failed to load thread history')
      || message.includes('thread-store internal error')
      || message.includes('valid utf-8')
    )
  );
}

function extractCodexJsonlPath(message: string): string | null {
  const match = /(?:^|\s)(\/[^\s:]+\.jsonl)(?::|\s|$)/.exec(message);
  if (!match) return null;
  const candidate = resolve(match[1]);
  const sessionsRoot = resolve(homedir(), '.codex', 'sessions');
  return candidate === sessionsRoot || candidate.startsWith(`${sessionsRoot}${sep}`) ? candidate : null;
}

function isValidUtf8(buffer: Buffer): boolean {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buffer);
    return true;
  } catch {
    return false;
  }
}

function repairCodexJsonlText(text: string): { text: string; droppedLineCount: number } {
  const repairedLines: string[] = [];
  let droppedLineCount = 0;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      JSON.parse(line);
      repairedLines.push(line);
    } catch {
      droppedLineCount += 1;
    }
  }
  return {
    text: repairedLines.length > 0 ? `${repairedLines.join('\n')}\n` : '',
    droppedLineCount,
  };
}

function getCodexSdkContextInjectionMaxChars(): number {
  const raw = process.env.IMCODES_CODEX_SDK_CONTEXT_MAX_CHARS;
  if (raw === undefined || raw.trim() === '') return DEFAULT_CODEX_SDK_CONTEXT_INJECTION_MAX_CHARS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) return DEFAULT_CODEX_SDK_CONTEXT_INJECTION_MAX_CHARS;
  if (parsed < MIN_CODEX_SDK_CONTEXT_INJECTION_MAX_CHARS) return MIN_CODEX_SDK_CONTEXT_INJECTION_MAX_CHARS;
  if (parsed > MAX_CODEX_SDK_CONTEXT_INJECTION_MAX_CHARS) return MAX_CODEX_SDK_CONTEXT_INJECTION_MAX_CHARS;
  return parsed;
}

function capCodexSdkContextInjection(text: string, maxChars = getCodexSdkContextInjectionMaxChars()): string {
  if (text.length <= maxChars) return text;
  const marker = `\n\n[IM.codes: injected context truncated from ${text.length} to ${maxChars} chars to prevent SDK auto-compaction.]`;
  if (maxChars <= marker.length + 16) return text.slice(0, maxChars);
  return `${text.slice(0, maxChars - marker.length).trimEnd()}${marker}`;
}

function buildCodexTurnInput(payload: ProviderContextPayload, sessionSystemTextUpdate?: string): string {
  const contextParts: string[] = [];
  const split = getProviderSystemTextParts(payload);
  const systemText = split.hasSplitSystemText
    ? composeProviderSystemText(payload, { includeSession: false, includeTurn: true })
    : payload.systemText?.trim();
  const messagePreamble = payload.messagePreamble?.trim();
  const stableUpdate = sessionSystemTextUpdate?.trim();
  if (stableUpdate) {
    contextParts.push(`${IMCODES_CODEX_BASE_INSTRUCTIONS_MARKER} updated:\n${stableUpdate}`);
  }
  if (systemText) contextParts.push(`Context instructions:\n${systemText}`);
  if (messagePreamble) contextParts.push(messagePreamble);
  if (contextParts.length === 0) return payload.assembledMessage;

  const contextText = capCodexSdkContextInjection(contextParts.join('\n\n'));
  const userMessage = messagePreamble ? payload.userMessage : payload.assembledMessage;
  const trimmedUserMessage = userMessage.trim();
  return trimmedUserMessage ? `${contextText}\n\n${trimmedUserMessage}` : contextText;
}

function appendImcodesBaseInstructions(baseInstructions: string, payload: ProviderContextPayload): string {
  const sessionSystemText = getProviderSystemTextParts(payload).sessionSystemText;
  // Generated Image Reporting belongs in Codex's baseInstructions tail
  // (Codex is currently the only transport agent with native image-gen
  // tools). Living here means: sent once per thread/start|resume, picked
  // up by Codex prefix cache, NOT re-rendered every turn, and zero cost
  // for non-Codex providers. See p2p audit 37bfbb85-430 N-A follow-up.
  const imageReporting = buildGeneratedImageReportingPrompt();
  const tailParts = [sessionSystemText, imageReporting].filter((s): s is string => Boolean(s));
  if (tailParts.length === 0) return baseInstructions;
  if (baseInstructions.includes(IMCODES_CODEX_BASE_INSTRUCTIONS_MARKER)) return baseInstructions;
  return `${baseInstructions.trimEnd()}\n\n${IMCODES_CODEX_BASE_INSTRUCTIONS_MARKER}\n\n${capCodexSdkContextInjection(tailParts.join('\n\n'))}`;
}

function appendDetectedGeneratedImagePaths(content: string, paths: string[]): string {
  const missingPaths = paths.filter((path) => !content.includes(path));
  if (missingPaths.length === 0) return content;
  const heading = missingPaths.length === 1
    ? 'Generated image path detected by IM.codes:'
    : 'Generated image paths detected by IM.codes:';
  const pathLines = missingPaths.map((path) => `- ${path}`).join('\n');
  return `${content.trimEnd()}${content.trimEnd() ? '\n\n' : ''}${heading}\n${pathLines}`;
}

/**
 * Provider-neutral fallback `baseInstructions` used when codex's own
 * `~/.codex/models_cache.json` does not have a matching `base_instructions`
 * for the active model — e.g. `codex-MiniMax-M2.5` routed via
 * `[model_providers.minimax]` with `wire_api = "responses"`.
 *
 * Background: codex forwards `baseInstructions` as the OpenAI Responses API
 * `instructions` field. Starting with codex-cli 0.125 + the April 2026
 * Responses API protocol change, an empty/missing `instructions` is
 * rejected with:
 *
 *   {"type":"error","status":400,"error":{"type":"invalid_request_error",
 *     "message":"Instructions are required"}}
 *
 * For catalog models (gpt-5.x), we lift the full per-model prompt straight
 * out of `~/.codex/models_cache.json` so there is no quality regression.
 * For non-catalog / custom-provider models we send this short fallback so
 * the upstream request is at least well-formed. The user's per-turn
 * `systemText` is still prepended into `turn/start` input.
 */
const FALLBACK_BASE_INSTRUCTIONS =
  'You are Codex, an AI coding assistant integrated into IM.codes. ' +
  'Follow the user\'s instructions precisely. ' +
  'Use available tools to inspect, edit, and run code as needed.';

/**
 * Resolve the `baseInstructions` to send with `thread/start` /
 * `thread/resume`. Always returns a non-empty string — codex-cli 0.125's
 * `session_startup_prewarm` will otherwise hand the upstream Responses API
 * an empty `instructions` field, which OpenAI now rejects with 400.
 *
 * Resolution order:
 *   1. `~/.codex/models_cache.json` → per-model `base_instructions`
 *      (preserves codex's full 12–22 KB per-model prompt, no regression)
 *   2. `FALLBACK_BASE_INSTRUCTIONS` (provider-neutral, short)
 */
async function resolveBaseInstructionsOverride(model: string | undefined): Promise<string> {
  if (model) {
    try {
      const cached = await getCodexBaseInstructions(model);
      if (cached && cached.length > 0) return cached;
    } catch {
      // Fall through to fallback.
    }
  }
  return FALLBACK_BASE_INSTRUCTIONS;
}

type JsonRpcResponse = {
  id?: number;
  result?: Record<string, any>;
  error?: { code?: number; message?: string; data?: unknown };
  method?: string;
  params?: Record<string, any>;
};

type PendingRequest = {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
};

type GeneratedImageTrackingSnapshot = {
  dir: string;
  knownPaths: Set<string>;
};

type HeartbeatThreadStatus = 'active' | 'idle' | 'notLoaded' | 'systemError' | 'unknown';
type HeartbeatTurnStatus = 'active' | 'completed' | 'failed' | 'interrupted' | 'unknown';
type HeartbeatClassifier =
  | 'active'
  | 'idle_completed'
  | 'idle_failed'
  | 'idle_interrupted'
  | 'idle_missing_turn'
  | 'not_loaded_with_active_lease'
  | 'start_grace'
  | 'start_grace_expired_no_current_turn'
  | 'system_error'
  | 'malformed'
  | 'oversized'
  | 'missing_turn_list'
  | 'ambiguous_current_turn'
  | 'unknown_status'
  | 'timeout'
  | 'stale'
  | 'local_terminal';
type HeartbeatClassification =
  | { outcome: 'active'; classifier: HeartbeatClassifier }
  | { outcome: 'terminal'; classifier: HeartbeatClassifier; status: 'completed' | 'failed' | 'interrupted'; turnId?: string }
  | { outcome: 'lost'; classifier: 'idle_missing_turn' | 'not_loaded_with_active_lease' | 'start_grace_expired_no_current_turn' }
  | { outcome: 'provider_error'; classifier: 'system_error' }
  | { outcome: 'inconclusive' | 'degraded' | 'stale'; classifier: HeartbeatClassifier };

interface HeartbeatTurnSummary {
  id?: string;
  status: HeartbeatTurnStatus;
  current: boolean;
  startedAtMs?: number;
  updatedAtMs?: number;
  completedAtMs?: number;
}

interface HeartbeatThreadSummary {
  valid: boolean;
  malformedReason?: Extract<HeartbeatClassifier, 'malformed' | 'oversized' | 'missing_turn_list' | 'ambiguous_current_turn'>;
  threadStatus: HeartbeatThreadStatus;
  turns: HeartbeatTurnSummary[];
  requestStartedAtMs: number;
  requestEndedAtMs: number;
  rawTurnCount: number;
}

interface CodexRolloutTaskCompleteEvidence {
  turnId: string;
  lastAgentMessage?: string;
}

interface CodexRolloutTerminalEvidence extends CodexRolloutTaskCompleteEvidence {
  /** Wall-clock ms of the rollout `task_complete` wrapper timestamp, or null if unparseable. */
  completedAtMs: number | null;
}

interface CodexActiveTurnLease {
  id: string;
  attemptId: number;
  localSessionKey: string;
  sessionName?: string;
  providerSessionId: string;
  threadId: string;
  turnId?: string;
  activityGeneration?: ActivityGenerationLike;
  startedAtMs: number;
  turnStartInFlightAtMs?: number;
  lastStrongActivityAtMs: number;
  lastWeakActivityAtMs?: number;
  lastHeartbeatAtMs?: number;
  lastHeartbeatResponseAtMs?: number;
  lastAliveHeartbeatAtMs?: number;
  nextHeartbeatAtMs?: number;
  heartbeatFailureCount: number;
  heartbeatInFlight: boolean;
  heartbeatTimer?: ReturnType<typeof setTimeout>;
}

export interface CodexDiscoveredModel {
  id: string;
  name?: string;
  supportsReasoningEffort?: boolean;
  isDefault?: boolean;
}

interface CodexSdkSessionState {
  routeId: string;
  imcodesSessionName?: string;
  cwd: string;
  env?: Record<string, string>;
  mcpConfig?: Record<string, unknown>;
  model?: string;
  effort?: TransportEffortLevel;
  threadId?: string;
  loaded: boolean;
  runningTurnId?: string;
  runtimeActivityGeneration?: ActivityGeneration;
  activeTurnLease?: CodexActiveTurnLease;
  turnStartInFlight: boolean;
  runningCompact: boolean;
  /** True only for a user-issued standalone `/compact` transport turn. */
  compactCommandInFlight: boolean;
  currentMessageId: string | null;
  currentText: string;
  activeItemIds: Set<string>;
  activeToolItemIds: Set<string>;
  activeCompactionItemIds: Set<string>;
  openProviderToolCalls: Map<string, ToolCallEvent>;
  /**
   * Correlates custom tool lifecycle across both app-server surfaces:
   * `item/started|completed` and `rawResponseItem/completed`. Newer Codex
   * versions can expose either channel (and occasionally both), so call_id is
   * the canonical identity and this map prevents duplicate timeline cards.
   */
  customToolLifecycleByCallId: Map<string, CodexCustomToolLifecycle>;
  runtimeSubagentStartedAtByKey: Map<string, number>;
  cancelled: boolean;
  cancelTimer: ReturnType<typeof setTimeout> | null;
  compactSettleTimer: ReturnType<typeof setTimeout> | null;
  compactHardTimer: ReturnType<typeof setTimeout> | null;
  compactObserved: boolean;
  lastInjectedSessionSystemText?: string;
  lastUsage?: {
    /**
     * Context-bar usage must represent the current prompt/window occupancy,
     * not cumulative billing/thread totals. Codex app-server emits both
     * `last` and `total`; `total` grows across turns and can exceed the model
     * context window, so provider-neutral fields normalize from `last` when
     * available and keep cumulative `total` fields only for diagnostics.
     */
    input_tokens: number;
    cache_read_input_tokens: number;
    cached_input_tokens: number;
    output_tokens: number;
    total_tokens?: number;
    reasoning_output_tokens?: number;
    model_context_window?: number;
    codex_total_input_tokens?: number;
    codex_total_cached_input_tokens?: number;
    codex_total_output_tokens?: number;
    codex_last_input_tokens?: number;
    codex_last_cached_input_tokens?: number;
    codex_last_output_tokens?: number;
  };
  lastStatusSignature: string | null;
  pendingSessionSystemTextUpdate?: string;
  pendingSessionSystemTextUpdateTurnId?: string;
  completedTurnIds: Set<string>;
  terminalDuringTurnStartIds: Set<string>;
  completedCompactTurnIds: Set<string>;
  terminatedTurnIds: Set<string>;
  terminatedCompactTurnIds: Set<string>;
  // App-server idle/completed hints are only deferred until active provider
  // tools close; final turn completion still requires explicit `turn/completed`
  // or rollout `task_complete` evidence for the current turn.
  idleSettleTimer?: ReturnType<typeof setTimeout>;
  idleSettleTurnId?: string;
  deferredIdleSettleTurnId?: string;
  deferredCompactSettleTurnId?: string;
  generatedImageTracking: GeneratedImageTrackingSnapshot | null;
  generatedImagePaths: string[];
  rawChecklistStartedAt: number;
  rawChecklistRolloutPath?: string;
  rawChecklistRolloutOffset?: number;
  /** Guards the async rollout task_complete cross-check (one in flight per session). */
  rolloutTaskCompleteCheckInFlight?: boolean;
  rawChecklistSeenCallIds: Set<string>;
  rawChecklistScanPromise?: Promise<void>;
  rawChecklistPollTimer: ReturnType<typeof setTimeout> | null;
  rawChecklistPollUntil: number;
  rolloutSettlePollTimer: ReturnType<typeof setTimeout> | null;
  /** ROLLOUT-FIRST AUTHORITY: real-time fs.watch on the thread's rollout file. */
  rolloutAuthorityWatcher?: FSWatcher;
  rolloutAuthorityWatchPath?: string;
  /** Turn id the authority watcher is currently settling; re-armed when it changes. */
  rolloutAuthorityTurnId?: string;
  rolloutAuthorityDebounce?: ReturnType<typeof setTimeout>;
  /** Guards the async path-resolution while (re)arming the authority watcher. */
  rolloutAuthorityArmInFlight?: boolean;
  childSubagentRolloutStartedAt: number;
  childSubagentRolloutSeenIds: Set<string>;
  childSubagentRolloutCompletedIds: Set<string>;
  childSubagentRolloutScanPromise?: Promise<void>;
  childSubagentRolloutTimer: ReturnType<typeof setTimeout> | null;
  childSubagentRolloutPollUntil: number;
  /** Set once a native codex>=0.139 `turn/plan/updated` event has rendered the
   *  plan, so the legacy rollout-file scan is suppressed (no double-render). */
  nativePlanEventSeen?: boolean;
}

function buildCodexMcpThreadConfig(config: SessionConfig): Record<string, unknown> | undefined {
  const server = getDefaultMcpServers(config)[IMCODES_MEMORY_MCP_SERVER_NAME];
  if (!server) return undefined;
  return {
    mcp_servers: {
      [IMCODES_MEMORY_MCP_SERVER_NAME]: {
        command: server.command,
        args: server.args,
        env: server.env,
      },
    },
  };
}

function finiteNumber(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return value;
}

function normalizeCodexTokenUsage(params: Record<string, any>): CodexSdkSessionState['lastUsage'] | undefined {
  const tokenUsage = params.tokenUsage;
  if (!tokenUsage || typeof tokenUsage !== 'object') return undefined;

  const total = tokenUsage.total && typeof tokenUsage.total === 'object'
    ? tokenUsage.total as Record<string, unknown>
    : undefined;
  const last = tokenUsage.last && typeof tokenUsage.last === 'object'
    ? tokenUsage.last as Record<string, unknown>
    : undefined;
  if (!total && !last) return undefined;

  const totalInput = finiteNumber(total?.inputTokens);
  const totalCached = finiteNumber(total?.cachedInputTokens);
  const totalOutput = finiteNumber(total?.outputTokens);
  const lastInput = finiteNumber(last?.inputTokens);
  const lastCached = finiteNumber(last?.cachedInputTokens);
  const lastOutput = finiteNumber(last?.outputTokens);

  const inputTokens = lastInput ?? totalInput;
  const cachedTokens = lastCached ?? totalCached;
  const outputTokens = lastOutput ?? totalOutput;
  if (inputTokens === undefined && cachedTokens === undefined && outputTokens === undefined) return undefined;
  const cachedForUi = cachedTokens ?? 0;
  // Codex/OpenAI-style `inputTokens` includes cached input as a subset
  // (`totalTokens === inputTokens + outputTokens` in Codex JSONL). The web ctx
  // bar renders `inputTokens + cacheTokens`, matching Anthropic's split fields.
  // Therefore expose the uncached remainder as provider-neutral `input_tokens`
  // and carry the raw Codex total separately for diagnostics.
  const inputForUi = Math.max(0, (inputTokens ?? 0) - cachedForUi);

  const modelContextWindow = finiteNumber(tokenUsage.modelContextWindow)
    // Backward-compat with older tests / adapters that briefly placed this
    // beside `tokenUsage`; generated app-server types now nest it inside.
    ?? finiteNumber(params.modelContextWindow);

  return {
    input_tokens: inputForUi,
    cache_read_input_tokens: cachedForUi,
    // Keep Codex's native name too for diagnostics and direct provider users.
    cached_input_tokens: cachedForUi,
    output_tokens: outputTokens ?? 0,
    ...(finiteNumber(total?.totalTokens) !== undefined ? { total_tokens: finiteNumber(total?.totalTokens)! } : {}),
    ...(finiteNumber(total?.reasoningOutputTokens) !== undefined ? { reasoning_output_tokens: finiteNumber(total?.reasoningOutputTokens)! } : {}),
    ...(modelContextWindow !== undefined && modelContextWindow > 0 ? { model_context_window: modelContextWindow } : {}),
    ...(totalInput !== undefined ? { codex_total_input_tokens: totalInput } : {}),
    ...(totalCached !== undefined ? { codex_total_cached_input_tokens: totalCached } : {}),
    ...(totalOutput !== undefined ? { codex_total_output_tokens: totalOutput } : {}),
    ...(lastInput !== undefined ? { codex_last_input_tokens: lastInput } : {}),
    ...(lastCached !== undefined ? { codex_last_cached_input_tokens: lastCached } : {}),
    ...(lastOutput !== undefined ? { codex_last_output_tokens: lastOutput } : {}),
  };
}

function readParamThreadId(params: Record<string, any>): string | undefined {
  const threadId = params.threadId ?? params.thread_id ?? params.thread?.id ?? params.thread?.threadId ?? params.thread?.thread_id;
  return typeof threadId === 'string' && threadId.trim() ? threadId : undefined;
}

function readParamTurnId(params: Record<string, any>): string | undefined {
  const turnId = params.turnId ?? params.turn_id ?? params.turn?.id ?? params.turn?.turnId ?? params.turn?.turn_id;
  return typeof turnId === 'string' && turnId.trim() ? turnId : undefined;
}

function readThreadStatus(params: Record<string, any>): string | undefined {
  const raw = params.status ?? params.threadStatus ?? params.thread_status ?? params.thread?.status;
  if (typeof raw === 'string' && raw.trim()) return raw.trim();
  if (!raw || typeof raw !== 'object') return undefined;
  const nested = (raw as Record<string, any>).type
    ?? (raw as Record<string, any>).kind
    ?? (raw as Record<string, any>).state
    ?? (raw as Record<string, any>).status;
  return typeof nested === 'string' && nested.trim() ? nested.trim() : undefined;
}

function readTurnStatus(params: Record<string, any>): string | undefined {
  return meaningfulString(params.turn?.status)
    ?? meaningfulString(params.status)
    ?? meaningfulString(params.turnStatus)
    ?? meaningfulString(params.turn_status);
}

function normalizeStatusName(status: string | undefined): string {
  return (status ?? '').replace(/[_\s-]+/g, '').toLowerCase();
}

function isThreadActiveStatus(status: string | undefined): boolean {
  const normalized = normalizeStatusName(status);
  return normalized === 'active'
    || normalized === 'running'
    || normalized === 'busy'
    || normalized === 'compacting'
    || normalized === 'inprogress';
}

function isThreadIdleStatus(status: string | undefined): boolean {
  const normalized = normalizeStatusName(status);
  return normalized === 'idle'
    || normalized === 'ready'
    || normalized === 'complete'
    || normalized === 'completed';
}

function normalizeHeartbeatThreadStatus(status: string | undefined): HeartbeatThreadStatus {
  const normalized = normalizeStatusName(status);
  if (normalized === 'systemerror' || normalized === 'error') return 'systemError';
  if (normalized === 'notloaded' || normalized === 'notfound' || normalized === 'unloaded') return 'notLoaded';
  if (
    normalized === 'active'
    || normalized === 'running'
    || normalized === 'busy'
    || normalized === 'compacting'
    || normalized === 'inprogress'
  ) return 'active';
  if (
    normalized === 'idle'
    || normalized === 'ready'
    || normalized === 'complete'
    || normalized === 'completed'
  ) return 'idle';
  return 'unknown';
}

function normalizeHeartbeatTurnStatus(status: string | undefined): HeartbeatTurnStatus {
  const normalized = normalizeStatusName(status);
  if (
    normalized === 'active'
    || normalized === 'running'
    || normalized === 'busy'
    || normalized === 'inprogress'
    || normalized === 'pending'
  ) return 'active';
  if (
    normalized === 'completed'
    || normalized === 'complete'
    || normalized === 'succeeded'
    || normalized === 'success'
    || normalized === 'done'
  ) return 'completed';
  if (normalized === 'failed' || normalized === 'error' || normalized === 'errored') return 'failed';
  if (
    normalized === 'interrupted'
    || normalized === 'cancelled'
    || normalized === 'canceled'
    || normalized === 'stopped'
    || normalized === 'killed'
  ) return 'interrupted';
  return 'unknown';
}

function boundedTimestampMs(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return Math.trunc(value);
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function meaningfulString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.length <= CODEX_COLLAB_MAX_ID_CHARS ? trimmed : trimmed.slice(0, CODEX_COLLAB_MAX_ID_CHARS);
}

function meaningfulStringArray(value: unknown): { values: string[]; malformed: boolean } {
  if (!Array.isArray(value)) {
    return { values: [], malformed: value !== undefined };
  }
  if (value.length > CODEX_COLLAB_MAX_RECEIVERS) return { values: [], malformed: true };
  const values: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string') return { values: [], malformed: true };
    const trimmed = entry.trim();
    if (!trimmed || trimmed.length > CODEX_COLLAB_MAX_ID_CHARS) return { values: [], malformed: true };
    const stringValue = meaningfulString(trimmed);
    if (!stringValue) return { values: [], malformed: true };
    values.push(stringValue);
  }
  return { values, malformed: false };
}

function readCodexAgentStates(value: unknown): { states: Record<string, unknown>; malformed: boolean } {
  if (value === undefined) return { states: {}, malformed: false };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { states: {}, malformed: true };
  const keys = Object.keys(value as Record<string, unknown>);
  if (keys.length > CODEX_COLLAB_MAX_STATE_KEYS || keys.some((key) => key.length > CODEX_COLLAB_MAX_ID_CHARS)) {
    return { states: {}, malformed: true };
  }
  return { states: value as Record<string, unknown>, malformed: false };
}

function readCodexChildStatus(value: unknown): string | undefined {
  if (typeof value === 'string') return meaningfulString(value);
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  return meaningfulString(record.status)
    ?? meaningfulString(record.state)
    ?? meaningfulString(record.lifecycleStatus);
}

function isCodexRunningChildStatus(status: string | undefined): boolean {
  const normalized = normalizeStatusName(status);
  return normalized === 'pendinginit' || normalized === 'running';
}

function isKnownCodexChildStatus(status: string | undefined): boolean {
  const normalized = normalizeStatusName(status);
  return normalized === 'pendinginit'
    || normalized === 'running'
    || normalized === 'completed'
    || normalized === 'errored'
    || normalized === 'shutdown'
    || normalized === 'notfound'
    || normalized === 'interrupted'
    || normalized === 'stale';
}

function childStatusSummary(counts: Map<string, number>): string {
  if (counts.size === 0) return 'receivers:0';
  const summary = [...counts.entries()].map(([status, count]) => `${status}:${count}`).join(', ');
  return summary.length <= 160 ? summary : `${summary.slice(0, 157)}...`;
}

type CodexCollabChildSummary = {
  receiverCount: number;
  runningChildCount: number;
  childStatusSummary: string;
  diagnosticCode?: SdkSubagentDiagnosticCode;
};

function summarizeCodexCollabChildren(item: Record<string, any>, diagnosticOnly: boolean): CodexCollabChildSummary {
  const receiverThreads = meaningfulStringArray(item.receiverThreadIds);
  const agentStates = readCodexAgentStates(item.agentsStates);
  const receiverIds = receiverThreads.values;
  const receiverSet = new Set(receiverIds);
  const stateKeys = Object.keys(agentStates.states).filter((key) => key.trim());
  const extraKeys = stateKeys.filter((key) => !receiverSet.has(key));
  const hasMissingState = receiverIds.some((receiverId) => !(receiverId in agentStates.states));
  const counts = new Map<string, number>();
  let hasUnknownChildState = false;

  for (const receiverId of receiverIds) {
    const status = readCodexChildStatus(agentStates.states[receiverId]);
    const statusKey = status ?? 'missing';
    counts.set(statusKey, (counts.get(statusKey) ?? 0) + 1);
    if (!status || !isKnownCodexChildStatus(status)) hasUnknownChildState = true;
  }
  if (extraKeys.length > 0) counts.set('extra', extraKeys.length);

  const malformed = item.receiverThreadIds === undefined
    || receiverThreads.malformed
    || agentStates.malformed
    || hasMissingState
    || extraKeys.length > 0;
  const diagnosticCode = malformed
    ? SDK_SUBAGENT_DIAGNOSTIC.MALFORMED_PAYLOAD
    : hasUnknownChildState
      ? SDK_SUBAGENT_DIAGNOSTIC.UNKNOWN_STATE
      : undefined;
  const runningChildCount = diagnosticOnly || diagnosticCode
    ? 0
    : receiverIds.reduce((count, receiverId) => (
        count + (isCodexRunningChildStatus(readCodexChildStatus(agentStates.states[receiverId])) ? 1 : 0)
      ), 0);

  return {
    receiverCount: receiverIds.length,
    runningChildCount,
    childStatusSummary: childStatusSummary(counts),
    diagnosticCode,
  };
}

function mapCodexCollabStatus(
  rawStatus: string,
  diagnosticCode: SdkSubagentDiagnosticCode | undefined,
): {
  toolStatus: ToolCallEvent['status'];
  normalizedStatus: SdkSubagentNormalizedStatus;
  active: boolean;
  terminal: boolean;
  diagnosticCode?: SdkSubagentDiagnosticCode;
} {
  if (diagnosticCode) {
    return {
      toolStatus: 'error',
      normalizedStatus: SDK_SUBAGENT_STATUS.UNKNOWN,
      active: false,
      terminal: true,
      diagnosticCode,
    };
  }

  const normalized = normalizeStatusName(rawStatus);
  if (normalized === 'inprogress') {
    return {
      toolStatus: 'running',
      normalizedStatus: SDK_SUBAGENT_STATUS.RUNNING,
      active: true,
      terminal: false,
    };
  }
  if (normalized === 'completed' || normalized === 'complete') {
    return {
      toolStatus: 'complete',
      normalizedStatus: SDK_SUBAGENT_STATUS.COMPLETE,
      active: false,
      terminal: true,
    };
  }
  if (normalized === 'failed' || normalized === 'error' || normalized === 'errored') {
    return {
      toolStatus: 'error',
      normalizedStatus: SDK_SUBAGENT_STATUS.ERROR,
      active: false,
      terminal: true,
    };
  }

  return {
    toolStatus: 'error',
    normalizedStatus: SDK_SUBAGENT_STATUS.UNKNOWN,
    active: false,
    terminal: true,
    diagnosticCode: SDK_SUBAGENT_DIAGNOSTIC.UNKNOWN_STATE,
  };
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readAgentMessageText(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return undefined;
  const parts: string[] = [];
  for (const part of value) {
    if (typeof part === 'string') {
      parts.push(part);
      continue;
    }
    if (!isRecord(part)) continue;
    const text = part.text ?? part.content ?? part.value;
    if (typeof text === 'string') parts.push(text);
  }
  return parts.length > 0 ? parts.join('') : undefined;
}

function readRolloutTaskCompleteMessage(payload: Record<string, any>): string | undefined {
  for (const key of ['last_agent_message', 'lastAgentMessage', 'result', 'message']) {
    const value = payload[key];
    const text = typeof value === 'string'
      ? value
      : readAgentMessageText(value);
    if (typeof text === 'string' && text.trim()) return text;
  }
  return undefined;
}

function readTurnCompletedAgentMessage(turn: Record<string, any>): { id: string; text: string } | undefined {
  const items = Array.isArray(turn.items) ? turn.items : [];
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (!isRecord(item) || item.type !== 'agentMessage') continue;
    const text = readAgentMessageText(item.text) ?? readAgentMessageText(item.content);
    if (typeof text !== 'string' || !text.trim()) continue;
    const id = meaningfulString(item.id) ?? `${meaningfulString(turn.id) ?? 'turn'}:agent-message`;
    return { id, text };
  }
  return undefined;
}

function readNestedRuntimeSubagentRecord(value: unknown): Record<string, any> | undefined {
  if (!isRecord(value)) return undefined;
  const record = value;
  const type = meaningfulString(record.type);
  const hasRuntimeShape = Boolean(
    meaningfulString(record.agent_path)
    ?? meaningfulString(record.agentPath)
    ?? meaningfulString(record.agent_id)
    ?? meaningfulString(record.agentId)
    ?? meaningfulString(record.path)
    ?? meaningfulString(record.status)
    ?? meaningfulString(record.state)
    ?? (type && CODEX_RUNTIME_SUBAGENT_ITEM_TYPES.has(normalizeStatusName(type))),
  );
  if (hasRuntimeShape) return record;
  for (const key of ['subagent', 'subAgent', 'agent', 'notification', 'data', 'event']) {
    const nested = readNestedRuntimeSubagentRecord(record[key]);
    if (nested) return nested;
  }
  return undefined;
}

function readRuntimeSubagentId(record: Record<string, any>): string | undefined {
  return meaningfulString(record.agent_path)
    ?? meaningfulString(record.agentPath)
    ?? meaningfulString(record.agent_id)
    ?? meaningfulString(record.agentId)
    ?? meaningfulString(record.path)
    ?? meaningfulString(record.id);
}

function readRuntimeSubagentName(record: Record<string, any>): string | undefined {
  return meaningfulString(record.name)
    ?? meaningfulString(record.nickname)
    ?? meaningfulString(record.displayName)
    ?? meaningfulString(record.display_name)
    ?? meaningfulString(record.label);
}

function readRuntimeSubagentModel(record: Record<string, any>): string | undefined {
  return meaningfulString(record.model)
    ?? meaningfulString(record.agentModel)
    ?? meaningfulString(record.agent_model)
    ?? meaningfulString(record.modelId)
    ?? meaningfulString(record.model_id);
}

function readRuntimeSubagentStatus(record: Record<string, any>): string | undefined {
  return meaningfulString(record.status)
    ?? meaningfulString(record.state)
    ?? meaningfulString(record.lifecycleStatus)
    ?? meaningfulString(record.lifecycle_status);
}

function readRuntimeSubagentStatusInfo(record: Record<string, any>): { status?: string; message?: string } {
  const direct = readRuntimeSubagentStatus(record);
  if (direct) return { status: direct };
  const statusRecord = isRecord(record.status) ? record.status : isRecord(record.state) ? record.state : undefined;
  if (!statusRecord) return {};
  const nested = readRuntimeSubagentStatus(statusRecord);
  if (nested) return { status: nested };
  for (const key of ['completed', 'complete', 'shutdown', 'running', 'pending', 'failed', 'error', 'interrupted', 'cancelled', 'canceled', 'stopped', 'killed']) {
    if (key in statusRecord) {
      return { status: key, message: meaningfulString(statusRecord[key]) };
    }
  }
  return {};
}

function readRuntimeSubagentPrompt(record: Record<string, any>): string | undefined {
  return meaningfulString(record.prompt)
    ?? meaningfulString(record.description)
    ?? meaningfulString(record.instruction)
    ?? meaningfulString(record.instructions)
    ?? meaningfulString(record.message);
}

function readRuntimeSubagentUsageTotalTokens(record: Record<string, any>): number | undefined {
  return finiteNumber(record.usageTotalTokens)
    ?? finiteNumber(record.usage_total_tokens)
    ?? finiteNumber(record.totalTokens)
    ?? finiteNumber(record.total_tokens);
}

function readRuntimeSubagentBackgrounded(record: Record<string, any>): boolean {
  return record.backgrounded === true
    || record.is_backgrounded === true
    || record.background === true
    || record.detached === true;
}

function mapCodexRuntimeSubagentStatus(
  rawStatus: string,
  diagnosticCode: SdkSubagentDiagnosticCode | undefined,
): {
  toolStatus: ToolCallEvent['status'];
  normalizedStatus: SdkSubagentNormalizedStatus;
  active: boolean;
  terminal: boolean;
  diagnosticCode?: SdkSubagentDiagnosticCode;
} {
  if (diagnosticCode) {
    return {
      toolStatus: 'error',
      normalizedStatus: SDK_SUBAGENT_STATUS.UNKNOWN,
      active: false,
      terminal: true,
      diagnosticCode,
    };
  }

  const normalized = normalizeStatusName(rawStatus);
  if (
    normalized === 'pending'
    || normalized === 'queued'
    || normalized === 'starting'
    || normalized === 'created'
    || normalized === 'spawned'
  ) {
    return {
      toolStatus: 'running',
      normalizedStatus: SDK_SUBAGENT_STATUS.PENDING,
      active: true,
      terminal: false,
    };
  }
  if (
    normalized === 'running'
    || normalized === 'active'
    || normalized === 'started'
    || normalized === 'working'
    || normalized === 'inprogress'
  ) {
    return {
      toolStatus: 'running',
      normalizedStatus: SDK_SUBAGENT_STATUS.RUNNING,
      active: true,
      terminal: false,
    };
  }
  if (
    normalized === 'shutdown'
    || normalized === 'complete'
    || normalized === 'completed'
    || normalized === 'done'
    || normalized === 'success'
    || normalized === 'succeeded'
    || normalized === 'finished'
  ) {
    return {
      toolStatus: 'complete',
      normalizedStatus: SDK_SUBAGENT_STATUS.COMPLETE,
      active: false,
      terminal: true,
    };
  }
  if (
    normalized === 'failed'
    || normalized === 'failure'
    || normalized === 'error'
    || normalized === 'errored'
    || normalized === 'crashed'
  ) {
    return {
      toolStatus: 'error',
      normalizedStatus: SDK_SUBAGENT_STATUS.ERROR,
      active: false,
      terminal: true,
    };
  }
  if (
    normalized === 'interrupted'
    || normalized === 'cancelled'
    || normalized === 'canceled'
    || normalized === 'stopped'
    || normalized === 'killed'
  ) {
    return {
      toolStatus: 'error',
      normalizedStatus: SDK_SUBAGENT_STATUS.INTERRUPTED,
      active: false,
      terminal: true,
    };
  }

  return {
    toolStatus: 'error',
    normalizedStatus: SDK_SUBAGENT_STATUS.UNKNOWN,
    active: false,
    terminal: true,
    diagnosticCode: SDK_SUBAGENT_DIAGNOSTIC.UNKNOWN_STATE,
  };
}

function runtimeSubagentToolFromPayload(
  sessionId: string,
  payload: Record<string, any>,
  lifecycle?: 'started' | 'completed',
): ToolCallEvent | null {
  const record = readNestedRuntimeSubagentRecord(payload) ?? payload;
  const rawAgentPath = readRuntimeSubagentId(record);
  const fallbackId = lifecycle ? `${lifecycle}-missing-id` : 'notification-missing-id';
  const agentPath = rawAgentPath ?? fallbackId;
  const statusInfo = readRuntimeSubagentStatusInfo(record);
  const rawStatus = statusInfo.status
    ?? (lifecycle === 'started' ? 'running' : lifecycle === 'completed' ? 'shutdown' : undefined);
  const diagnosticCode = rawAgentPath
    ? (rawStatus ? undefined : SDK_SUBAGENT_DIAGNOSTIC.UNKNOWN_STATE)
    : SDK_SUBAGENT_DIAGNOSTIC.MISSING_ID;
  const statusMapping = mapCodexRuntimeSubagentStatus(rawStatus ?? 'unknown', diagnosticCode);
  const canonicalKey = makeCodexSubagentCanonicalKey(sessionId, `runtime:${agentPath}`);
  const agentName = readRuntimeSubagentName(record);
  const model = readRuntimeSubagentModel(record);
  const prompt = readRuntimeSubagentPrompt(record);
  const usageTotalTokens = readRuntimeSubagentUsageTotalTokens(record);
  const backgrounded = readRuntimeSubagentBackgrounded(record);
  const startedAtMs = readSdkSubagentStartedAtMs(record) ?? readSdkSubagentStartedAtMs(payload);
  const summary = agentName ? `Codex sub-agent ${agentName}` : rawAgentPath ? `Codex sub-agent ${rawAgentPath}` : 'Codex sub-agent';
  const output = statusMapping.terminal ? (statusInfo.message ?? rawStatus ?? 'unknown') : undefined;
  const detail = buildSdkSubagentSafeDetail({
    kind: SDK_SUBAGENT_DETAIL_KIND,
    summary,
    input: {
      action: 'codex-runtime-subagent',
      description: prompt ?? summary,
    },
    ...(output ? { output } : {}),
    meta: {
      isSdkSubagent: true,
      schemaVersion: SDK_SUBAGENT_SCHEMA_VERSION,
      provider: SDK_SUBAGENT_PROVIDERS.CODEX_SDK,
      providerKind: SDK_SUBAGENT_PROVIDER_KINDS.CODEX_RUNTIME_AGENT,
      canonicalKey,
      normalizedStatus: statusMapping.normalizedStatus,
      ...(rawStatus ? { rawStatus } : {}),
      active: statusMapping.active,
      terminal: statusMapping.terminal,
      parentSessionId: sessionId,
      parentItemId: canonicalKey,
      ...(rawAgentPath ? { agentPath: rawAgentPath } : {}),
      ...(agentName ? { agentName } : {}),
      ...(model ? { model } : {}),
      ...(backgrounded ? { backgrounded: true } : {}),
      ...(usageTotalTokens !== undefined ? { usageTotalTokens } : {}),
      ...(startedAtMs !== undefined ? { startedAtMs } : {}),
      diagnosticCode: statusMapping.diagnosticCode,
    },
  } satisfies SdkSubagentDetail, { allowRaw: false });

  return {
    id: canonicalKey,
    name: 'Codex Sub-agent',
    status: statusMapping.toolStatus,
    ...(detail.input ? { input: detail.input } : {}),
    ...(detail.output ? { output: detail.output } : {}),
    detail,
  };
}

function isCodexRuntimeSubagentMethod(method: string, params: Record<string, any>): boolean {
  if (CODEX_RUNTIME_SUBAGENT_METHODS.has(method)) return true;
  const type = meaningfulString(params.type);
  return Boolean(type && CODEX_RUNTIME_SUBAGENT_ITEM_TYPES.has(normalizeStatusName(type)));
}

function parseCodexRuntimeSubagentTag(line: string): Record<string, any> | null {
  const match = /^<subagent_notification>([\s\S]+)<\/subagent_notification>$/.exec(line.trim());
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[1]!);
    return isRecord(parsed) ? { type: 'subagent_notification', ...parsed } : null;
  } catch {
    return null;
  }
}

function parseJsonRecord(value: unknown): Record<string, any> | undefined {
  if (isRecord(value)) return value;
  if (typeof value !== 'string' || !value.trim()) return undefined;
  try {
    const parsed = JSON.parse(value);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function customToolOutputText(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
      try {
        const parsed = JSON.parse(trimmed);
        if (isRecord(parsed) || Array.isArray(parsed)) return customToolOutputText(parsed);
      } catch {}
    }
    return value;
  }
  if (Array.isArray(value)) {
    const parts = value
      .map((entry) => customToolOutputText(entry))
      .filter((entry): entry is string => entry !== undefined);
    return parts.length > 0 ? parts.join('\n') : undefined;
  }
  if (!isRecord(value)) return value === undefined || value === null ? undefined : String(value);

  for (const key of ['text', 'output', 'content', 'value', 'message']) {
    const text = customToolOutputText(value[key]);
    if (text !== undefined) return text;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function customToolOutputRecords(value: unknown): Record<string, any>[] {
  if (Array.isArray(value)) return value.flatMap((entry) => customToolOutputRecords(entry));
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return [];
    try {
      const parsed = JSON.parse(trimmed);
      return customToolOutputRecords(parsed);
    } catch {
      return [];
    }
  }
  if (!isRecord(value)) return [];
  const nested = [value.output, value.content, value.result, value.metadata]
    .flatMap((entry) => customToolOutputRecords(entry));
  return [value, ...nested];
}

function customToolTerminalFromOutput(item: Record<string, any>): {
  status: Exclude<ToolCallEvent['status'], 'running'>;
  terminalStatus: ToolTerminalStatus;
  terminalReason: ToolTerminalReason;
  output: string;
} {
  const rawOutput = item.output ?? item.result ?? item.content ?? item.error;
  const output = customToolOutputText(rawOutput) ?? '';
  const normalizedStatus = normalizeStatusName(meaningfulString(item.status));
  const records = [
    item,
    ...customToolOutputRecords(rawOutput),
    ...customToolOutputRecords(item.metadata),
  ];
  const cancelled = normalizedStatus === 'cancelled'
    || normalizedStatus === 'canceled'
    || normalizedStatus === 'interrupted'
    || normalizedStatus === 'aborted'
    || records.some((record) => record.cancelled === true || record.canceled === true || record.interrupted === true)
    || /^script (?:cancelled|canceled|interrupted|aborted)\b/im.test(output);
  if (cancelled) {
    return {
      status: 'error',
      terminalStatus: 'cancelled',
      terminalReason: normalizedStatus === 'interrupted' ? 'provider_interrupted' : 'provider_cancelled',
      output,
    };
  }

  const failed = normalizedStatus === 'failed'
    || normalizedStatus === 'error'
    || normalizedStatus === 'errored'
    || (item.error !== undefined && item.error !== null)
    || records.some((record) => {
      const exitCode = finiteNumber(record.exit_code) ?? finiteNumber(record.exitCode);
      return record.is_error === true
        || record.isError === true
        || record.success === false
        || (exitCode !== undefined && exitCode !== 0)
        || (record.error !== undefined && record.error !== null);
    })
    || /^script failed\b/im.test(output);
  return failed
    ? { status: 'error', terminalStatus: 'errored', terminalReason: 'provider_error', output }
    : { status: 'complete', terminalStatus: 'succeeded', terminalReason: 'provider_result', output };
}

function rawChecklistText(item: Record<string, unknown>): string | undefined {
  for (const key of ['content', 'step', 'text', 'title', 'task', 'description', 'name']) {
    const value = item[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

function rawChecklistStatus(value: unknown): 'pending' | 'in_progress' | 'completed' {
  const normalized = normalizeStatusName(typeof value === 'string' ? value : undefined);
  if (normalized === 'completed' || normalized === 'complete' || normalized === 'done' || normalized === 'finished' || normalized === 'checked') {
    return 'completed';
  }
  if (normalized === 'inprogress' || normalized === 'active' || normalized === 'doing' || normalized === 'running' || normalized === 'started') {
    return 'in_progress';
  }
  return 'pending';
}

function rawChecklistInputFromArgs(args: Record<string, any>): { plan: Array<{ content: string; status: string }> } | null {
  const rawItems = Array.isArray(args.plan)
    ? args.plan
    : Array.isArray(args.todos)
      ? args.todos
      : Array.isArray(args.tasks)
        ? args.tasks
        : Array.isArray(args.steps)
          ? args.steps
          : null;
  if (!rawItems) return null;
  const plan: Array<{ content: string; status: string }> = [];
  for (const rawItem of rawItems) {
    if (!isRecord(rawItem)) continue;
    const content = rawChecklistText(rawItem);
    if (!content) continue;
    plan.push({ content, status: rawChecklistStatus(rawItem.status) });
  }
  return plan.length ? { plan } : null;
}

function rawChecklistToolFromFunctionCall(sessionId: string, item: Record<string, any>): ToolCallEvent | null {
  const name = meaningfulString(item.name);
  const normalizedName = name?.replace(/[\s-]+/g, '_').toLowerCase();
  if (!name || !normalizedName || !CODEX_RAW_CHECKLIST_FUNCTION_NAMES.has(normalizedName)) return null;
  const args = parseJsonRecord(item.arguments);
  if (!args) return null;
  const input = rawChecklistInputFromArgs(args);
  if (!input) return null;
  const id = meaningfulString(item.call_id) ?? meaningfulString(item.callId) ?? meaningfulString(item.id) ?? `codex-raw-checklist-${sessionId}`;
  return {
    id,
    name,
    status: 'complete',
    input,
    detail: { kind: 'plan', summary: 'Plan', input, meta: {}, raw: item },
  };
}

/**
 * codex >= 0.139 surfaces the running plan via a dedicated `turn/plan/updated`
 * event ({ plan: [{ step, status }] }) instead of an `update_plan` function call
 * in the rollout file. Map it to the SAME `update_plan` tool.call the legacy
 * rollout scan emits so the shared timeline + web checklist render it
 * identically. Older codex (no native event) keeps using the rollout scan.
 */
function planToolFromTurnPlanEvent(sessionId: string, turnId: string | undefined, rawPlan: unknown): ToolCallEvent | null {
  const entries = Array.isArray(rawPlan) ? rawPlan : [];
  const plan = entries
    .map((entry) => {
      const e = isRecord(entry) ? entry : {};
      const content = (meaningfulString(e.step) ?? meaningfulString(e.content) ?? meaningfulString(e.text) ?? '').trim();
      return { content, status: rawChecklistStatus(e.status) };
    })
    .filter((entry) => entry.content);
  if (plan.length === 0) return null;
  const input = { plan };
  const allDone = plan.every((entry) => entry.status === 'completed');
  return {
    id: `codex-plan-${turnId ?? sessionId}`,
    name: 'update_plan',
    status: allDone ? 'complete' : 'running',
    input,
    detail: { kind: 'plan', summary: 'Plan', input, meta: {}, raw: { plan: entries } },
  };
}

function rawChecklistToolFromJsonlLine(sessionId: string, line: string, minTimestampMs: number): ToolCallEvent | null {
  if (!line.trim()) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isRecord(raw) || raw.type !== 'response_item') return null;
  const timestamp = typeof raw.timestamp === 'string' ? new Date(raw.timestamp).getTime() : NaN;
  if (Number.isFinite(timestamp) && timestamp < minTimestampMs) return null;
  const payload = isRecord(raw.payload) ? raw.payload : null;
  if (!payload || payload.type !== 'function_call') return null;
  return rawChecklistToolFromFunctionCall(sessionId, payload);
}

function readRawSpawnAgentId(record: Record<string, any>): string | undefined {
  return meaningfulString(record.agent_id)
    ?? meaningfulString(record.agentId)
    ?? meaningfulString(record.thread_id)
    ?? meaningfulString(record.threadId)
    ?? meaningfulString(record.id);
}

function buildRawSpawnAgentRuntimePayload(
  call: CodexRawSpawnAgentCall,
  output: Record<string, any>,
): Record<string, any> {
  const agentId = readRawSpawnAgentId(output);
  const agentName = meaningfulString(output.nickname)
    ?? meaningfulString(output.name)
    ?? meaningfulString(call.args.nickname)
    ?? meaningfulString(call.args.name)
    ?? meaningfulString(call.args.agent_type)
    ?? meaningfulString(call.args.agentType);
  const prompt = meaningfulString(call.args.message)
    ?? meaningfulString(call.args.prompt)
    ?? meaningfulString(call.args.instructions);
  const model = meaningfulString(call.args.model)
    ?? meaningfulString(call.args.agentId)
    ?? meaningfulString(call.args.agent_id);
  return {
    ...(agentId ? { agent_id: agentId } : {}),
    status: 'running',
    ...(agentName ? { nickname: agentName } : {}),
    ...(prompt ? { prompt } : {}),
    ...(model ? { model } : {}),
    backgrounded: true,
    startedAtMs: call.startedAtMs,
  };
}

function rawSpawnAgentToolFromOutput(call: CodexRawSpawnAgentCall, output: unknown): ToolCallEvent | null {
  const outputRecord = parseJsonRecord(output) ?? {};
  return runtimeSubagentToolFromPayload(
    call.sessionId,
    buildRawSpawnAgentRuntimePayload(call, outputRecord),
  );
}

function collabAgentToolFromItem(
  sessionId: string,
  item: Record<string, any>,
  lifecycle: 'started' | 'completed',
): ToolCallEvent {
  const rawItemId = meaningfulString(item.id);
  const parentItemId = rawItemId ?? `malformed-${lifecycle}`;
  const missingIdDiagnostic = rawItemId ? undefined : SDK_SUBAGENT_DIAGNOSTIC.MISSING_ID;
  const fallbackRawStatus = lifecycle === 'started' ? 'inProgress' : 'completed';
  const rawStatus = meaningfulString(item.status) ?? fallbackRawStatus;
  const childSummary = summarizeCodexCollabChildren(item, Boolean(missingIdDiagnostic));
  const effectiveRawStatus = childSummary.runningChildCount > 0 ? 'inProgress' : rawStatus;
  const statusMapping = mapCodexCollabStatus(effectiveRawStatus, missingIdDiagnostic ?? childSummary.diagnosticCode);
  const receiverCount = childSummary.receiverCount;
  const receiverLabel = receiverCount === 1 ? '1 receiver' : `${receiverCount} receivers`;
  const summary = statusMapping.diagnosticCode
    ? `Codex collaboration diagnostic (${receiverLabel})`
    : `Codex collaboration agent (${receiverLabel})`;
  const model = readRuntimeSubagentModel(item);
  const prompt = readRuntimeSubagentPrompt(item);
  const output = statusMapping.toolStatus === 'complete'
    ? 'completed'
    : statusMapping.toolStatus === 'error'
      ? (statusMapping.diagnosticCode ? 'diagnostic' : 'failed')
      : undefined;
  const detail = buildSdkSubagentSafeDetail({
    kind: SDK_SUBAGENT_DETAIL_KIND,
    summary,
    input: {
      action: 'codex-collaboration',
      receiverCount,
      description: prompt ?? summary,
    },
    ...(output ? { output } : {}),
    meta: {
      isSdkSubagent: true,
      schemaVersion: SDK_SUBAGENT_SCHEMA_VERSION,
      provider: SDK_SUBAGENT_PROVIDERS.CODEX_SDK,
      providerKind: SDK_SUBAGENT_PROVIDER_KINDS.CODEX_COLLAB_AGENT,
      canonicalKey: makeCodexSubagentCanonicalKey(sessionId, parentItemId),
      normalizedStatus: statusMapping.normalizedStatus,
      rawStatus: effectiveRawStatus,
      active: statusMapping.active,
      terminal: statusMapping.terminal,
      parentSessionId: sessionId,
      parentItemId,
      ...(model ? { model } : {}),
      receiverCount,
      runningChildCount: statusMapping.diagnosticCode || statusMapping.terminal ? 0 : childSummary.runningChildCount,
      childStatusSummary: childSummary.childStatusSummary,
      diagnosticCode: statusMapping.diagnosticCode,
    },
  } satisfies SdkSubagentDetail, { allowRaw: false });

  return {
    id: rawItemId ?? `codex-collab-${sessionId}-${lifecycle}-malformed`,
    name: 'Codex Collaboration',
    status: statusMapping.toolStatus,
    ...(detail.input ? { input: detail.input } : {}),
    ...(detail.output ? { output: detail.output } : {}),
    detail,
  };
}

/**
 * Surface a Codex CUSTOM tool call (e.g. the newer unified `exec` tool, whose
 * rollout records are `custom_tool_call{name,input,call_id,status}`) as a
 * timeline tool card. Older Codex shells arrived as `commandExecution`; the
 * current binary drives shell/JS execution through a custom tool that lands in
 * `toolFromItem`'s default branch and used to be dropped — so a turn doing all
 * its work via `exec` showed NO tool updates in the UI. This maps any
 * tool-call-shaped item (has an id, a name, and a call payload) to a tool card,
 * so custom tools are visible regardless of the exact app-server item.type.
 * Returns null for non-tool items (no name / no call payload), so structural
 * items are never turned into spurious tool cards.
 */
function customToolFromItem(sessionId: string, item: Record<string, any>, lifecycle: 'started' | 'completed'): ToolCallEvent | null {
  void sessionId;
  // call_id is shared by the raw-response and typed-item channels; item.id is
  // channel-specific. Prefer call_id so both paths converge on one card.
  const callId = meaningfulString(item.call_id) ?? meaningfulString(item.callId);
  const id = callId ?? meaningfulString(item.id);
  const name = meaningfulString(item.name) ?? meaningfulString(item.tool);
  if (!id || !name) return null;
  const rawInput = item.input ?? item.arguments ?? item.command ?? item.script;
  const hasCallShape = rawInput !== undefined
    || meaningfulString(item.call_id) !== undefined
    || meaningfulString(item.callId) !== undefined;
  if (!hasCallShape) return null; // not a tool call — do not fabricate a card
  const normalizedStatus = normalizeStatusName(meaningfulString(item.status));
  const cancelled = normalizedStatus === 'cancelled'
    || normalizedStatus === 'canceled'
    || normalizedStatus === 'interrupted'
    || normalizedStatus === 'aborted';
  const status: ToolCallEvent['status'] = item.status === 'inProgress' || item.status === 'running' || lifecycle === 'started'
    ? 'running'
    : item.status === 'failed' || item.status === 'error' || item.status === 'errored' || cancelled
      ? 'error'
      : 'complete';
  const input = typeof rawInput === 'string'
    ? { command: rawInput }
    : isRecord(rawInput)
      ? rawInput
      : rawInput !== undefined
        ? { input: rawInput }
        : {};
  const rawOutput = item.output ?? item.aggregatedOutput ?? item.result;
  const output = rawOutput === undefined
    ? undefined
    : typeof rawOutput === 'string' ? rawOutput : JSON.stringify(rawOutput);
  return {
    id,
    name,
    status,
    input,
    ...(status !== 'running' && output !== undefined ? { output } : {}),
    ...(status !== 'running' ? {
      terminalStatus: cancelled ? 'cancelled' : status === 'complete' ? 'succeeded' : 'errored',
      terminalReason: cancelled ? 'provider_cancelled' : status === 'complete' ? 'provider_result' : 'provider_error',
      terminalSynthetic: false,
      terminalSource: 'app_server_jsonrpc',
      terminalDecisionReason: cancelled ? 'custom_tool_cancelled' : status === 'complete' ? 'custom_tool_result' : 'custom_tool_error',
    } : {}),
    detail: {
      kind: 'customToolCall',
      summary: name,
      input,
      ...(rawOutput !== undefined ? { output: rawOutput } : {}),
      meta: {
        status: item.status,
        callId,
      },
      raw: item,
    },
  };
}

export function toolFromItem(sessionId: string, item: Record<string, any>, lifecycle: 'started' | 'completed'): ToolCallEvent | null {
  if (typeof item.type === 'string' && CODEX_RUNTIME_SUBAGENT_ITEM_TYPES.has(normalizeStatusName(item.type))) {
    return runtimeSubagentToolFromPayload(sessionId, item, lifecycle);
  }
  switch (item.type) {
    case 'subagentNotification':
    case 'subagent_notification':
    case 'subagentStatus':
    case 'subagent_status':
    case 'runtimeSubagent':
    case 'runtime_subagent':
      return runtimeSubagentToolFromPayload(sessionId, item, lifecycle);
    case 'collabAgentToolCall':
      return collabAgentToolFromItem(sessionId, item, lifecycle);
    case 'commandExecution':
      return {
        id: item.id,
        name: 'Bash',
        status: item.status === 'inProgress' || lifecycle === 'started' ? 'running' : item.status === 'completed' ? 'complete' : 'error',
        input: { command: item.command },
        ...(item.status !== 'inProgress' ? { output: item.aggregatedOutput ?? item.output ?? '' } : {}),
        detail: {
          kind: 'commandExecution',
          summary: item.command,
          input: {
            command: item.command,
            cwd: item.cwd,
            actions: item.commandActions,
          },
          output: item.aggregatedOutput ?? item.output ?? '',
          meta: {
            status: item.status,
            exitCode: item.exitCode,
            durationMs: item.durationMs,
            processId: item.processId,
          },
          raw: item,
        },
      };
    case 'mcpToolCall':
      return {
        id: item.id,
        name: `mcp:${item.server}:${item.tool}`,
        status: item.status === 'inProgress' || lifecycle === 'started' ? 'running' : item.status === 'completed' ? 'complete' : 'error',
        input: item.arguments,
        ...(item.status === 'completed'
          ? { output: JSON.stringify(item.result?.structuredContent ?? item.result?.content ?? '') }
          : item.status === 'failed'
            ? { output: item.error?.message ?? 'failed' }
            : {}),
        detail: {
          kind: 'mcpToolCall',
          summary: `${item.server}:${item.tool}`,
          input: item.arguments,
          output: item.result?.structuredContent ?? item.result?.content ?? item.error?.message,
          meta: {
            server: item.server,
            tool: item.tool,
            status: item.status,
          },
          raw: item,
        },
      };
    case 'fileChange':
      return {
        id: item.id,
        name: 'Patch',
        status: lifecycle === 'started' || item.status === 'inProgress'
          ? 'running'
          : item.status === 'completed'
            ? 'complete'
            : 'error',
        input: { changes: item.changes },
        detail: {
          kind: 'fileChange',
          summary: Array.isArray(item.changes) ? `${item.changes.length} change(s)` : undefined,
          input: { changes: item.changes },
          output: item.output,
          meta: { status: item.status },
          raw: item,
        },
      };
    case 'webSearch': {
      // The Codex CLI emits `WebSearchAction` as a tagged enum:
      //   { type: 'search',        query: '...' }
      //   { type: 'find_in_page',  pattern: '...', url?: '...' }
      //   { type: 'open_page',     url:   '...' }
      //   { type: 'other' }                       // unknown / catch-all
      //
      // Older CLI versions also surfaced a top-level `item.query`. The
      // current binary does NOT — for the `search` variant the query is
      // nested under `item.action.query`, and for the catch-all `other`
      // there's no query at all.
      //
      // Rendering contract: `input` is the flat summary payload the web UI
      // shows next to the tool name; `detail.raw` keeps the original item
      // for the expand panel. Do NOT inline the raw `action` object into
      // `input` — `summarizeToolInput` walks `TOOL_INPUT_SUMMARY_KEYS`
      // (`query` first); when `query` is an empty string it's treated as
      // not-useful, the walker falls through to all keys, and with two
      // entries (`query` + `action`) the renderer fallbacks to
      // `JSON.stringify(input)` — that's where the
      // `{"query":"","action":{"type":"other"}}` screen artifact came from.
      const action = item.action as Record<string, unknown> | undefined;
      const actionType = meaningfulString(action?.type);
      const actionQuery = meaningfulString(action?.query);
      const actionPattern = meaningfulString(action?.pattern);
      const actionUrl = meaningfulString(action?.url);
      const topLevelQuery = meaningfulString(item.query);
      // Pick the single best human-readable label for the flat `input.query`
      // slot. Priority: explicit query → pattern → url → bracketed action
      // type (`(other)` / `(open_page)`) for the no-info fallback. The UI
      // treats the result as an opaque string, so any of these values flow
      // through `summarizeToolInput` without triggering the empty-string
      // fallback branch.
      const bestLabel = topLevelQuery
        ?? actionQuery
        ?? actionPattern
        ?? actionUrl
        ?? (actionType ? `(${actionType})` : '(web_search)');
      return {
        id: item.id,
        name: 'WebSearch',
        status: lifecycle === 'started' ? 'running' : 'complete',
        input: {
          // Single-key payload: `summarizeToolInput` picks `query` first
          // and short-circuits, so the chat row reads `WebSearch <label>`
          // regardless of which enum variant Codex produced.
          query: bestLabel,
        },
        detail: {
          kind: 'webSearch',
          summary: bestLabel,
          input: {
            query: bestLabel,
            ...(actionPattern ? { pattern: actionPattern } : {}),
            ...(actionUrl ? { url: actionUrl } : {}),
            action,
          },
          meta: { actionType },
          raw: item,
        },
      };
    }
    case 'todo_list': {
      // Codex's running plan/checklist (app-server TodoListItem: items of
      // { text, completed }). Surface it as an update_plan tool.call so the
      // shared timeline + web checklist render it like CC/Qwen/Gemini todos.
      // `update_plan` is intentionally file-tool-shaped so transport-relay
      // emits the completed call with its input (matching the web normalizer).
      const todoItems = Array.isArray(item.items) ? item.items : [];
      const plan = todoItems
        .map((t: Record<string, unknown>) => ({
          content: typeof t?.text === 'string' ? t.text.trim() : '',
          status: t?.completed === true ? 'completed' : 'pending',
        }))
        .filter((t: { content: string }) => t.content);
      const input = { plan };
      return {
        id: item.id ?? `codex-todo-${sessionId}`,
        name: 'update_plan',
        status: lifecycle === 'completed' ? 'complete' : 'running',
        input,
        detail: { kind: 'plan', summary: 'Plan', input, meta: {}, raw: item },
      };
    }
    case 'customToolCall':
    case 'custom_tool_call':
    case 'customTool':
    case 'custom_tool':
    case 'localShellCall':
    case 'local_shell_call':
      return customToolFromItem(sessionId, item, lifecycle);
    default:
      // Best-effort: surface any remaining tool-call-shaped item (id + name +
      // call payload) so a not-yet-enumerated Codex tool type is still visible
      // instead of silently dropped. Non-tool items return null here.
      return customToolFromItem(sessionId, item, lifecycle);
  }
}

export class CodexSdkProvider implements TransportProvider {
  readonly id = 'codex-sdk';
  readonly connectionMode = CONNECTION_MODES.LOCAL_SDK;
  readonly sessionOwnership = SESSION_OWNERSHIP.SHARED;
  readonly capabilities: ProviderCapabilities = {
    streaming: true,
    toolCalling: true,
    approval: false,
    sessionRestore: true,
    multiTurn: true,
    attachments: false,
    reasoningEffort: true,
    supportedEffortLevels: CODEX_SDK_EFFORT_LEVELS,
    contextSupport: 'degraded-message-side-context-mapping',
    compact: {
      execution: 'sdk-rpc',
      verified: true,
      completion: 'provider-event',
      cancellation: 'local-cancel',
    },
  };

  private config: ProviderConfig | null = null;
  private sessions = new Map<string, CodexSdkSessionState>();
  private threadToSession = new Map<string, string>();
  private deltaCallbacks: Array<(sessionId: string, delta: MessageDelta) => void> = [];
  private completeCallbacks: Array<(sessionId: string, message: AgentMessage) => void> = [];
  private errorCallbacks: Array<(sessionId: string, error: ProviderError) => void> = [];
  private toolCallCallbacks: Array<(sessionId: string, tool: ToolCallEvent) => void> = [];
  private sessionInfoCallbacks: Array<(sessionId: string, info: SessionInfoUpdate) => void> = [];
  private statusCallbacks: Array<(sessionId: string, status: ProviderStatusUpdate) => void> = [];
  private usageCallbacks: Array<(sessionId: string, update: ProviderUsageUpdate) => void> = [];
  private child: ChildProcessWithoutNullStreams | null = null;
  private rl: ReadlineInterface | null = null;
  private nextRequestId = 1;
  private pendingRequests = new Map<number, PendingRequest>();
  private appServerAuthFingerprint: string | null = null;
  private appServerRestart: Promise<void> | null = null;
  private rawSpawnAgentCalls = new Map<string, CodexRawSpawnAgentCall>();
  private trackedSubagentThreads = new Map<string, CodexTrackedSubagentThread>();
  private nextActiveTurnLeaseId = 1;
  private heartbeatInFlightCount = 0;

  async connect(config: ProviderConfig): Promise<void> {
    const binaryPath = this.resolveBinaryPath(config);
    // Resolve the binary (handles npm .cmd shims on Windows) and verify it.
    const resolved = resolveExecutableForSpawn(binaryPath);
    await access(resolved.executable, fsConstants.X_OK).catch(async () => {
      // Fall back to spawn-based version probe (works for things on PATH).
      const { execFile } = await import('node:child_process');
      await new Promise<void>((resolve, reject) => {
        execFile(resolved.executable, [...resolved.prependArgs, '--version'], { windowsHide: true }, (err) => (err ? reject(err) : resolve()));
      });
    });
    await this.startAppServer(binaryPath, config, { clearSessions: true });
    logger.info({ provider: this.id, resolved: resolved.executable, prepend: resolved.prependArgs }, 'Codex SDK provider connected via app-server');
  }

  getMemoryMcpStatus(): MemoryMcpProviderStatusView {
    return {
      providerId: this.id,
      status: this.config && this.child ? MEMORY_MCP_STATUS.READY : MEMORY_MCP_STATUS.UNKNOWN,
      connected: Boolean(this.config && this.child),
      degradedReasons: [],
    };
  }

  private getCurrentTurnWorkState(state: CodexSdkSessionState): {
    activeWorkCount: number;
    activeToolCount: number;
    busyReasons: SessionActivityBusyReason[];
  } {
    const activeToolItemIds = state.activeToolItemIds ?? new Set<string>();
    const activeCompactionItemIds = state.activeCompactionItemIds ?? new Set<string>();
    const activeToolIds = new Set<string>(activeToolItemIds);
    for (const toolId of state.openProviderToolCalls.keys()) activeToolIds.add(toolId);
    const activeToolCount = activeToolIds.size;
    const compactionActive = state.runningCompact || activeCompactionItemIds.size > 0;
    const providerTurnActive = Boolean(state.runningTurnId || state.turnStartInFlight);
    const busyReasons: SessionActivityBusyReason[] = [];
    const providerTurnOnlyCount = providerTurnActive && activeToolCount === 0 && !compactionActive ? 1 : 0;
    if (providerTurnOnlyCount > 0) busyReasons.push('provider_wait');
    if (activeToolCount > 0) busyReasons.push('provider_tool_item');
    if (compactionActive) busyReasons.push('provider_compaction');
    return {
      activeWorkCount: providerTurnOnlyCount + activeToolCount + (compactionActive ? 1 : 0),
      activeToolCount,
      busyReasons,
    };
  }

  private getActiveWorkSessionIds(): string[] {
    const active: string[] = [];
    for (const [sessionId, state] of this.sessions) {
      const work = this.getCurrentTurnWorkState(state);
      if (work.activeWorkCount > 0 || Boolean(state.cancelTimer)) active.push(sessionId);
    }
    return active;
  }

  getSessionDiagnostics(sessionId: string): Record<string, unknown> | null {
    const state = this.sessions.get(sessionId);
    if (!state) return null;
    const activeItemIds = state.activeItemIds ?? new Set<string>();
    const activeToolItemIds = state.activeToolItemIds ?? new Set<string>();
    const activeCompactionItemIds = state.activeCompactionItemIds ?? new Set<string>();
    const activeReason = state.runningCompact
      ? 'compact'
      : state.runningTurnId
        ? 'turn'
        : state.turnStartInFlight
          ? 'turn-start'
          : activeItemIds.size > 0
            ? 'item'
            : state.cancelTimer
              ? 'cancelling'
              : null;
    return {
      provider: this.id,
      routeId: state.routeId,
      active: activeReason !== null,
      activeReason,
      threadId: state.threadId ?? null,
      runningTurnId: state.runningTurnId ?? null,
      heartbeatLeaseActive: state.activeTurnLease ? this.isHeartbeatLeaseActive(sessionId, state, state.activeTurnLease) : false,
      heartbeatLeaseTurnId: state.activeTurnLease?.turnId ?? null,
      heartbeatFailureCount: state.activeTurnLease?.heartbeatFailureCount ?? 0,
      heartbeatInFlight: state.activeTurnLease?.heartbeatInFlight ?? false,
      lastHeartbeatAttemptAtMs: state.activeTurnLease?.lastHeartbeatAtMs ?? null,
      lastHeartbeatResponseAtMs: state.activeTurnLease?.lastHeartbeatResponseAtMs ?? null,
      lastAliveHeartbeatAtMs: state.activeTurnLease?.lastAliveHeartbeatAtMs ?? null,
      turnStartInFlight: state.turnStartInFlight,
      runningCompact: state.runningCompact,
      loaded: state.loaded,
      cancelled: state.cancelled,
      currentMessageId: state.currentMessageId,
      currentTextLength: state.currentText.length,
      activeItemCount: activeItemIds.size,
      activeItemIds: [...activeItemIds].slice(-20),
      activeToolItemCount: activeToolItemIds.size,
      activeToolItemIds: [...activeToolItemIds].slice(-20),
      activeCompactionItemCount: activeCompactionItemIds.size,
      compactObserved: state.compactObserved,
      compactSettleArmed: Boolean(state.compactSettleTimer),
      compactHardTimeoutArmed: Boolean(state.compactHardTimer),
      cancelTimerArmed: Boolean(state.cancelTimer),
      deferredIdleSettleTurnId: state.deferredIdleSettleTurnId ?? null,
      deferredCompactSettleTurnId: state.deferredCompactSettleTurnId ?? null,
      rawChecklistPollArmed: Boolean(state.rawChecklistPollTimer),
    };
  }

  getActiveWorkSnapshot(sessionId: string): ProviderActiveWorkSnapshot | null {
    const state = this.sessions.get(sessionId);
    if (!state) return null;
    const work = this.getCurrentTurnWorkState(state);
    return {
      activeWorkCount: work.activeWorkCount,
      activeToolCount: work.activeToolCount,
      busyReasons: work.busyReasons,
      activityGeneration: state.runtimeActivityGeneration,
      providerDiagnosticGeneration: state.runningTurnId ?? state.deferredIdleSettleTurnId ?? state.deferredCompactSettleTurnId ?? null,
    };
  }

  async disconnect(): Promise<void> {
    await this.stopAppServer({ clearSessions: true });
  }

  async createSession(config: SessionConfig): Promise<string> {
    await this.refreshAppServerForLatestAuth('create-session');
    const routeId = config.bindExistingKey ?? config.sessionKey;
    const existing = config.fresh ? undefined : this.sessions.get(routeId);
    this.sessions.set(routeId, {
      routeId,
      ...(config.sessionName ? { imcodesSessionName: config.sessionName } : existing?.imcodesSessionName ? { imcodesSessionName: existing.imcodesSessionName } : {}),
      cwd: normalizeTransportCwd(config.cwd) ?? existing?.cwd ?? normalizeTransportCwd(process.cwd())!,
      env: { ...(existing?.env ?? {}), ...((config.env as Record<string, string> | undefined) ?? {}) },
      mcpConfig: buildCodexMcpThreadConfig(config) ?? existing?.mcpConfig,
      model: typeof config.agentId === 'string' ? config.agentId : existing?.model,
      effort: config.effort ?? existing?.effort,
      threadId: config.resumeId ?? existing?.threadId,
      loaded: false,
      runningTurnId: undefined,
      activeTurnLease: undefined,
      turnStartInFlight: false,
      runningCompact: false,
      compactCommandInFlight: false,
      currentMessageId: null,
      currentText: '',
      activeItemIds: new Set(),
      activeToolItemIds: new Set(),
      activeCompactionItemIds: new Set(),
      openProviderToolCalls: new Map(),
      customToolLifecycleByCallId: new Map(),
      runtimeSubagentStartedAtByKey: existing?.runtimeSubagentStartedAtByKey ?? new Map(),
      cancelled: false,
      cancelTimer: null,
      compactSettleTimer: null,
      compactHardTimer: null,
      compactObserved: false,
      lastInjectedSessionSystemText: existing?.lastInjectedSessionSystemText,
      lastUsage: undefined,
      lastStatusSignature: null,
      pendingSessionSystemTextUpdate: undefined,
      pendingSessionSystemTextUpdateTurnId: undefined,
      completedTurnIds: existing?.completedTurnIds ?? new Set(),
      terminalDuringTurnStartIds: existing?.terminalDuringTurnStartIds ?? new Set(),
      completedCompactTurnIds: existing?.completedCompactTurnIds ?? new Set(),
      terminatedTurnIds: existing?.terminatedTurnIds ?? new Set(),
      terminatedCompactTurnIds: existing?.terminatedCompactTurnIds ?? new Set(),
      deferredIdleSettleTurnId: undefined,
      deferredCompactSettleTurnId: undefined,
      generatedImageTracking: null,
      generatedImagePaths: [],
      rawChecklistStartedAt: Date.now(),
      rawChecklistRolloutPath: existing?.rawChecklistRolloutPath,
      rawChecklistRolloutOffset: existing?.rawChecklistRolloutOffset,
      rawChecklistSeenCallIds: existing?.rawChecklistSeenCallIds ?? new Set(),
      rawChecklistScanPromise: undefined,
      rawChecklistPollTimer: null,
      rawChecklistPollUntil: 0,
      rolloutSettlePollTimer: null,
      childSubagentRolloutStartedAt: Date.now(),
      childSubagentRolloutSeenIds: existing?.childSubagentRolloutSeenIds ?? new Set(),
      childSubagentRolloutCompletedIds: existing?.childSubagentRolloutCompletedIds ?? new Set(),
      childSubagentRolloutScanPromise: undefined,
      childSubagentRolloutTimer: null,
      childSubagentRolloutPollUntil: 0,
    });
    if (config.resumeId || config.effort) this.emitSessionInfo(routeId, { ...(config.resumeId ? { resumeId: config.resumeId } : {}), ...(config.effort ? { effort: config.effort } : {}) });
    return routeId;
  }

  async endSession(sessionId: string): Promise<void> {
    const state = this.sessions.get(sessionId);
    if (!state) return;
    this.clearActiveTurnLease(state);
    this.clearCancelTimer(state);
    this.clearCompactTimers(state);
    this.clearRawChecklistPollTimer(state);
    this.clearChildSubagentRolloutPollTimer(state);
    if (state.threadId && state.loaded) {
      await this.request('thread/unsubscribe', { threadId: state.threadId }).catch(() => {});
      this.threadToSession.delete(state.threadId);
    }
    this.sessions.delete(sessionId);
  }

  onDelta(cb: (sessionId: string, delta: MessageDelta) => void): () => void {
    this.deltaCallbacks.push(cb);
    return () => {
      const idx = this.deltaCallbacks.indexOf(cb);
      if (idx >= 0) this.deltaCallbacks.splice(idx, 1);
    };
  }

  onComplete(cb: (sessionId: string, message: AgentMessage) => void): () => void {
    this.completeCallbacks.push(cb);
    return () => {
      const idx = this.completeCallbacks.indexOf(cb);
      if (idx >= 0) this.completeCallbacks.splice(idx, 1);
    };
  }

  onError(cb: (sessionId: string, error: ProviderError) => void): () => void {
    this.errorCallbacks.push(cb);
    return () => {
      const idx = this.errorCallbacks.indexOf(cb);
      if (idx >= 0) this.errorCallbacks.splice(idx, 1);
    };
  }

  onToolCall(cb: (sessionId: string, tool: ToolCallEvent) => void): void {
    this.toolCallCallbacks.push(cb);
  }

  onSessionInfo(cb: (sessionId: string, info: SessionInfoUpdate) => void): () => void {
    this.sessionInfoCallbacks.push(cb);
    return () => {
      const idx = this.sessionInfoCallbacks.indexOf(cb);
      if (idx >= 0) this.sessionInfoCallbacks.splice(idx, 1);
    };
  }

  onStatus(cb: (sessionId: string, status: ProviderStatusUpdate) => void): () => void {
    this.statusCallbacks.push(cb);
    return () => {
      const idx = this.statusCallbacks.indexOf(cb);
      if (idx >= 0) this.statusCallbacks.splice(idx, 1);
    };
  }

  onUsage(cb: (sessionId: string, update: ProviderUsageUpdate) => void): () => void {
    this.usageCallbacks.push(cb);
    return () => {
      const idx = this.usageCallbacks.indexOf(cb);
      if (idx >= 0) this.usageCallbacks.splice(idx, 1);
    };
  }

  setSessionAgentId(sessionId: string, agentId: string): void {
    const state = this.sessions.get(sessionId);
    if (!state) return;
    state.model = agentId;
  }

  setSessionEffort(sessionId: string, effort: TransportEffortLevel): void {
    const state = this.sessions.get(sessionId);
    if (!state) return;
    state.effort = effort;
    this.emitSessionInfo(sessionId, { effort });
  }

  async send(sessionId: string, payloadOrMessage: string | ProviderContextPayload, attachments?: TransportAttachment[], extraSystemPrompt?: string): Promise<void> {
    if (!this.config || !this.child) {
      throw this.makeError(PROVIDER_ERROR_CODES.CONNECTION_LOST, 'Codex app-server not connected', false);
    }
    const state = this.sessions.get(sessionId);
    if (!state) {
      throw this.makeError(PROVIDER_ERROR_CODES.SESSION_NOT_FOUND, `Unknown Codex SDK session: ${sessionId}`, false);
    }
    if (state.runningTurnId || state.runningCompact || state.turnStartInFlight) {
      throw this.makeError(PROVIDER_ERROR_CODES.PROVIDER_ERROR, 'Codex SDK session is already busy', true);
    }
    await this.refreshAppServerForLatestAuth('send');
    if (!this.config || !this.child) {
      throw this.makeError(PROVIDER_ERROR_CODES.CONNECTION_LOST, 'Codex app-server not connected', false);
    }

    if (state.openProviderToolCalls.size > 0 || state.activeToolItemIds.size > 0 || state.activeCompactionItemIds.size > 0) {
      this.closeOpenProviderToolCalls(sessionId, state, 'error', 'abandoned', 'generation_rollover');
      state.activeToolItemIds.clear();
      state.activeCompactionItemIds.clear();
      state.activeItemIds.clear();
    }
    state.currentText = '';
    state.currentMessageId = null;
    this.clearActiveItemEvidence(state);
    this.clearActiveTurnLease(state);
    state.cancelled = false;
    this.clearCancelTimer(state);
    state.lastUsage = undefined;
    state.lastStatusSignature = null;
    state.generatedImageTracking = null;
    state.generatedImagePaths = [];
    const payload = normalizeProviderPayload(payloadOrMessage, attachments, extraSystemPrompt);
    state.runtimeActivityGeneration = payload.activityGeneration;
    if (this.isCompactCommand(payload)) {
      await this.startCompact(sessionId, state);
      return;
    }
    await this.startTurn(sessionId, state, payload);
  }

  private clearActiveItemEvidence(state: CodexSdkSessionState): void {
    state.activeItemIds.clear();
    state.activeToolItemIds.clear();
    state.activeCompactionItemIds.clear();
  }

  async cancel(sessionId: string): Promise<void> {
    const state = this.sessions.get(sessionId);
    if (!state) return;
    // Mark cancellation before checking threadId/runningTurnId. STOP can land
    // while Codex app-server is still answering thread/start or turn/start; in
    // that window there is not yet a turn id to interrupt. The cancelled flag
    // carries the request across those async boundaries so startTurn() issues
    // turn/interrupt as soon as Codex exposes the id.
    state.cancelled = true;
    this.clearActiveTurnLease(state);
    if (!state.threadId) return;
    if (state.runningCompact && state.compactCommandInFlight) {
      const turnId = state.runningTurnId;
      if (turnId) {
        void this.request('turn/interrupt', {
          threadId: state.threadId,
          turnId,
        }).catch(() => {});
      }
      this.cancelCompactLocally(sessionId, state);
      return;
    }
    const turnId = state.runningTurnId;
    if (!turnId) {
      this.cancelOrphanProviderWorkLocally(sessionId, state);
      return;
    }
    await this.interruptRunningTurn(sessionId, state, turnId);
  }

  private cancelOrphanProviderWorkLocally(sessionId: string, state: CodexSdkSessionState): boolean {
    if (state.turnStartInFlight) return false;
    const work = this.getCurrentTurnWorkState(state);
    if (work.activeWorkCount <= 0 && !state.cancelTimer) return false;
    this.clearCancelTimer(state);
    this.clearActiveTurnLease(state);
    this.clearCompactTimers(state);
    this.clearRawChecklistPollTimer(state);
    this.clearChildSubagentRolloutPollTimer(state);
    this.clearStatus(sessionId, state);
    this.rememberTerminatedActiveTurn(state);
    state.runningTurnId = undefined;
    state.turnStartInFlight = false;
    state.runningCompact = false;
    state.compactCommandInFlight = false;
    state.compactObserved = false;
    state.currentMessageId = null;
    state.currentText = '';
    this.closeOpenProviderToolCalls(sessionId, state, 'error', 'cancelled', 'user_cancelled');
    this.clearActiveItemEvidence(state);
    this.clearPendingSessionSystemTextUpdate(state);
    this.emitError(sessionId, this.makeError(PROVIDER_ERROR_CODES.CANCELLED, 'Codex turn cancelled', true));
    return true;
  }

  private async interruptRunningTurn(
    sessionId: string,
    state: CodexSdkSessionState,
    turnId: string,
  ): Promise<void> {
    state.cancelled = true;
    if (!state.threadId) return;
    // Fire-and-watchdog. Do not await turn/interrupt acknowledgement before
    // arming the local cancellation timer; an app-server/RPC hang must not
    // leave the UI stuck in "stopping" forever.
    void this.request('turn/interrupt', {
      threadId: state.threadId,
      turnId,
    }, CANCEL_INTERRUPT_TIMEOUT_MS).catch((err) => {
      logger.warn(
        {
          err,
          provider: this.id,
          sessionId,
          threadId: state.threadId,
          turnId,
        },
        'Codex SDK turn interrupt request failed',
      );
    });
    this.clearCancelTimer(state);
    state.cancelTimer = setTimeout(() => {
      if (!this.sessions.has(sessionId)) return;
      if (state.runningTurnId !== turnId) return;
      this.clearStatus(sessionId, state);
      this.rememberTerminatedTurn(state, turnId);
      this.clearActiveTurnLease(state);
      state.runningTurnId = undefined;
      state.turnStartInFlight = false;
      state.runningCompact = false;
      state.compactCommandInFlight = false;
      state.compactObserved = false;
      this.clearActiveItemEvidence(state);
      this.closeOpenProviderToolCalls(sessionId, state, 'error', 'cancelled', 'user_cancelled');
      this.clearRawChecklistPollTimer(state);
      this.clearChildSubagentRolloutPollTimer(state);
      this.clearPendingSessionSystemTextUpdate(state);
      this.emitError(sessionId, this.makeError(PROVIDER_ERROR_CODES.CANCELLED, 'Codex turn cancelled', true));
    }, CANCEL_INTERRUPT_TIMEOUT_MS);
    state.cancelTimer.unref?.();
  }

  private buildSpawnEnv(config: ProviderConfig): Record<string, string | undefined> {
    return { ...process.env, ...((config.env as Record<string, string> | undefined) ?? {}) };
  }

  private clearSessionWorkAfterDisconnect(sessionId: string, state: CodexSdkSessionState): void {
    this.clearCancelTimer(state);
    this.clearActiveTurnLease(state);
    this.clearCompactTimers(state);
    this.clearRawChecklistPollTimer(state);
    this.clearChildSubagentRolloutPollTimer(state);
    this.clearStatus(sessionId, state);
    this.rememberTerminatedActiveTurn(state);
    state.loaded = false;
    state.runningTurnId = undefined;
    state.turnStartInFlight = false;
    state.runningCompact = false;
    state.compactCommandInFlight = false;
    state.compactObserved = false;
    state.currentMessageId = null;
    state.currentText = '';
    this.clearActiveItemEvidence(state);
    state.cancelled = false;
    state.lastStatusSignature = null;
    this.clearPendingSessionSystemTextUpdate(state);
  }

  private settleSessionAfterAppServerDisconnect(
    sessionId: string,
    state: CodexSdkSessionState,
    disconnectClass: CodexAppServerDisconnectClass,
    message: string,
  ): boolean {
    const work = this.getCurrentTurnWorkState(state);
    const hasCurrentWork = work.activeWorkCount > 0 || Boolean(state.cancelTimer);
    if (!hasCurrentWork) {
      this.clearSessionWorkAfterDisconnect(sessionId, state);
      return false;
    }

    const terminalReason: ToolTerminalReason = disconnectClass === 'unexpected_eof'
      ? 'unexpected_eof'
      : disconnectClass === 'auth_refresh_restart'
        ? 'auth_refresh_recovery_failed'
        : 'app_server_disconnect';
    this.closeOpenProviderToolCalls(sessionId, state, 'error', 'errored', terminalReason);
    this.clearSessionWorkAfterDisconnect(sessionId, state);
    this.emitError(sessionId, this.makeError(PROVIDER_ERROR_CODES.CONNECTION_LOST, message, false));
    return true;
  }

  private handleAppServerDisconnect(
    child: ChildProcessWithoutNullStreams,
    disconnectClass: Exclude<CodexAppServerDisconnectClass, 'intentional_shutdown' | 'no_current_work_disconnect'>,
    err: Error,
  ): void {
    if (this.child !== child) return;
    this.rejectPending(err);
    let emittedError = false;
    for (const [sessionId, state] of this.sessions) {
      emittedError = this.settleSessionAfterAppServerDisconnect(sessionId, state, disconnectClass, err.message) || emittedError;
    }
    if (!emittedError) {
      logger.info({ provider: this.id, disconnectClass }, 'Codex app-server disconnected with no current work');
    }
    this.child = null;
    this.rl = null;
    this.appServerAuthFingerprint = null;
  }

  private async stopAppServer(options: { clearSessions: boolean }): Promise<void> {
    this.rejectPending(new Error('Codex app-server disconnected'));
    const child = this.child;
    this.child = null;
    this.rl?.close();
    this.rl = null;
    for (const [sessionId, state] of this.sessions) {
      this.clearCancelTimer(state);
      this.clearActiveTurnLease(state);
      this.clearCompactTimers(state);
      this.clearRawChecklistPollTimer(state);
      this.clearChildSubagentRolloutPollTimer(state);
      if (!options.clearSessions) {
        this.clearSessionWorkAfterDisconnect(sessionId, state);
      } else {
        this.closeOpenProviderToolCalls(sessionId, state, 'error', 'cancelled', 'provider_cancelled');
        this.clearSessionWorkAfterDisconnect(sessionId, state);
      }
    }
    // `child.kill('SIGTERM')` only terminates the node wrapper; the native
    // codex binary it spawned lives on and leaks ~60MB per abandoned pair.
    // Walk the descendant tree and tree-kill instead.
    if (child && !child.killed) {
      void killProcessTree(child);
    }
    this.threadToSession.clear();
    this.rawSpawnAgentCalls.clear();
    this.trackedSubagentThreads.clear();
    this.appServerAuthFingerprint = null;
    if (options.clearSessions) {
      this.sessions.clear();
      this.config = null;
    }
  }

  private async startAppServer(
    binaryPath: string,
    config: ProviderConfig,
    options: { clearSessions: boolean },
  ): Promise<void> {
    await this.stopAppServer({ clearSessions: options.clearSessions }).catch(() => {});
    // Resolve npm .cmd shims into (node.exe, [scriptPath]) so spawn works
    // without shell:true (which has its own quoting issues on Windows).
    const resolved = resolveExecutableForSpawn(binaryPath);
    const args = [...resolved.prependArgs, ...getDefaultCodexMcpArgs(), 'app-server'];
    const spawnEnv = this.buildSpawnEnv(config);
    const authFingerprint = await readCodexAuthFingerprint(spawnEnv);
    const child = spawn(resolved.executable, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: spawnEnv,
      windowsHide: true,
    });
    this.child = child;
    this.rl = readline.createInterface({ input: child.stdout });
    this.rl.on('line', (line) => this.handleLine(line));
    this.rl.on('close', () => {
      if (this.child !== child) return;
      this.handleAppServerDisconnect(child, 'unexpected_eof', new Error('Codex app-server stdout closed'));
    });
    child.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      if (text.trim()) logger.debug({ provider: this.id, stderr: text.trim() }, 'Codex app-server stderr');
    });
    child.on('exit', (code) => {
      if (this.child !== child) return;
      this.handleAppServerDisconnect(child, 'unexpected_crash', new Error(`Codex app-server exited with code ${code ?? 'unknown'}`));
    });
    // CRITICAL: must listen for 'error' or spawn failures (e.g. ENOENT) become
    // uncaughtException and crash the daemon.
    child.on('error', (err) => {
      if (this.child !== child) return;
      logger.error({ provider: this.id, err }, 'Codex app-server spawn error');
      this.handleAppServerDisconnect(child, 'unexpected_crash', err);
    });

    try {
      await this.request('initialize', {
        clientInfo: { name: 'imcodes', title: 'IM.codes', version: '0.1.0' },
        capabilities: { experimentalApi: true },
      });
      this.notify('initialized', {});
      this.config = config;
      this.appServerAuthFingerprint = authFingerprint;
    } catch (err) {
      await this.stopAppServer({ clearSessions: options.clearSessions }).catch(() => {});
      throw err;
    }
  }

  private async refreshAppServerForLatestAuth(reason: string): Promise<void> {
    if (this.appServerRestart) await this.appServerRestart;
    if (!this.config || !this.child) return;
    const current = await readCodexAuthFingerprint(this.buildSpawnEnv(this.config));
    if (current === this.appServerAuthFingerprint) return;
    logger.info({
      provider: this.id,
      reason,
      previousAuthPresent: this.appServerAuthFingerprint !== null,
      currentAuthPresent: current !== null,
    }, 'Codex auth file changed; restarting app-server to load latest authentication');
    await this.restartAppServerPreservingSessions(reason);
  }

  private async restartAppServerPreservingSessions(_reason: string): Promise<void> {
    if (this.appServerRestart) return this.appServerRestart;
    const config = this.config;
    if (!config) return;
    const activeSessionIds = this.getActiveWorkSessionIds();
    if (activeSessionIds.length > 0) {
      logger.warn({
        provider: this.id,
        reason: _reason,
        activeSessionCount: activeSessionIds.length,
        activeSessionIds: activeSessionIds.slice(0, 10),
      }, 'Codex app-server restart deferred while current work is active');
      throw this.makeError(
        PROVIDER_ERROR_CODES.PROVIDER_ERROR,
        'Codex app-server restart deferred while current work is active',
        true,
        {
          disconnectClass: 'auth_refresh_restart',
          activeSessionCount: activeSessionIds.length,
          activeSessionIds: activeSessionIds.slice(0, 10),
        },
      );
    }
    const binaryPath = this.resolveBinaryPath(config);
    this.appServerRestart = (async () => {
      await this.startAppServer(binaryPath, config, { clearSessions: false });
    })().finally(() => {
      this.appServerRestart = null;
    });
    return this.appServerRestart;
  }

  private async restartAppServerAfterAuthFailure(reason: string, error: ProviderError): Promise<void> {
    logger.warn({
      provider: this.id,
      reason,
      code: error.code,
      message: error.message,
    }, 'Codex app-server authentication failed; restarting to load latest authentication');
    await this.restartAppServerPreservingSessions(reason);
  }

  private async startTurn(sessionId: string, state: CodexSdkSessionState, payload: ProviderContextPayload): Promise<void> {
    try {
      const desiredSessionSystemText = getProviderSystemTextParts(payload).sessionSystemText;
      const shouldInjectStableUpdate = !!(
        state.threadId
        && state.loaded
        && desiredSessionSystemText
        && state.lastInjectedSessionSystemText !== desiredSessionSystemText
      );
      await this.ensureThreadLoaded(sessionId, state, payload);
      await this.prepareGeneratedImageTracking(sessionId, state);
      const inputText = buildCodexTurnInput(payload, shouldInjectStableUpdate ? desiredSessionSystemText : undefined);
      if (shouldInjectStableUpdate) {
        state.pendingSessionSystemTextUpdate = desiredSessionSystemText;
        state.pendingSessionSystemTextUpdateTurnId = undefined;
      }
      state.turnStartInFlight = true;
      this.refreshActiveTurnLease(sessionId, state, { strong: true, turnStartInFlight: true });
      const result = await this.request('turn/start', {
        threadId: state.threadId,
        input: [{ type: 'text', text: inputText }],
        cwd: state.cwd,
        ...this.sessionEnvironmentParams(state),
        approvalPolicy: 'never',
        sandboxPolicy: { type: 'dangerFullAccess' },
        ...(state.model ? { model: state.model } : {}),
        ...(state.effort ? { effort: state.effort } : {}),
      }).finally(() => {
        state.turnStartInFlight = false;
      });
      // Extract the app-server-assigned turn id defensively — provider versions
      // have shifted the field shape (turn.id / turnId / turn.turnId). Never
      // clobber an id already learned from streamed items/deltas with undefined,
      // or the turn-id guards below would start dropping live assistant text.
      const startedTurnId = readParamTurnId((result ?? {}) as Record<string, any>);
      const terminalArrivedDuringStart = Boolean(startedTurnId && state.terminalDuringTurnStartIds.delete(startedTurnId));
      if (!terminalArrivedDuringStart) {
        if (startedTurnId) {
          state.completedTurnIds.delete(startedTurnId);
          state.terminatedTurnIds.delete(startedTurnId);
          state.completedCompactTurnIds.delete(startedTurnId);
          state.terminatedCompactTurnIds.delete(startedTurnId);
          state.runningTurnId = startedTurnId;
        }
        this.refreshActiveTurnLease(sessionId, state, { turnId: startedTurnId, strong: true });
      }
      state.nativePlanEventSeen = false;
      this.armChildSubagentRolloutPolling(sessionId, state);
      if (state.runningTurnId) {
        state.completedTurnIds.delete(state.runningTurnId);
        state.terminatedTurnIds.delete(state.runningTurnId);
      }
      if (shouldInjectStableUpdate && state.pendingSessionSystemTextUpdate === desiredSessionSystemText) {
        state.pendingSessionSystemTextUpdateTurnId = state.runningTurnId;
      }
      if (state.cancelled && state.runningTurnId) {
        await this.interruptRunningTurn(sessionId, state, state.runningTurnId);
      }
      if (state.runningTurnId) this.armRawChecklistPolling(sessionId, state);
    } catch (err) {
      this.rememberTerminatedTurn(state, state.runningTurnId);
      this.clearActiveTurnLease(state);
      state.runningTurnId = undefined;
      state.turnStartInFlight = false;
      this.clearActiveItemEvidence(state);
      this.closeOpenProviderToolCalls(sessionId, state, 'error', 'errored', 'app_server_failed');
      this.clearRawChecklistPollTimer(state);
      this.clearPendingSessionSystemTextUpdate(state);
      const error = this.normalizeError(err);
      if (this.isCodexAuthError(error)) {
        await this.restartAppServerAfterAuthFailure('start-turn', error).catch((restartErr) => {
          logger.warn({ provider: this.id, err: restartErr }, 'Codex app-server auth refresh restart failed');
        });
      }
      this.emitError(sessionId, error);
    }
  }

  private isCompactCommand(payload: ProviderContextPayload): boolean {
    // Codex slash commands are app-client controls, not ordinary model text.
    // The daemon still forwards `/compact` through the ordinary transport send
    // path; this provider adapter is the SDK boundary that maps the raw command
    // to Codex app-server's native compaction RPC. Using `assembledMessage`
    // here would be wrong because shared-context/preference preambles may wrap
    // the provider-visible text, while `userMessage` preserves the user's raw
    // command token.
    return isSessionControlCommandText(payload.userMessage, 'compact');
  }

  private async startCompact(sessionId: string, state: CodexSdkSessionState): Promise<void> {
    try {
      await this.ensureThreadLoaded(sessionId, state);
      this.clearPendingSessionSystemTextUpdate(state);
      this.clearActiveTurnLease(state);
      state.runningCompact = true;
      state.compactCommandInFlight = true;
      state.compactObserved = false;
      state.currentText = '';
      state.currentMessageId = null;
      this.emitStatus(sessionId, state, {
        status: 'compacting',
        label: 'Compacting context...',
      });
      this.armCompactHardTimeout(sessionId, state);
      const result = await this.request('thread/compact/start', {
        threadId: state.threadId,
      }, COMPACT_START_ACCEPT_TIMEOUT_MS);
      // Some Codex app-server builds accept `thread/compact/start` as a
      // synchronous/no-op request when there is no compactable turn and never
      // emit `thread/compacted` or a `contextCompaction` item. Do not leave the
      // IM.codes runtime permanently busy in that accepted-but-silent state;
      // give the native event stream a short grace window, then settle the UI
      // as a completed native compact request. If a real compaction item/status
      // arrives, `compactObserved` cancels this fallback and we wait for the
      // native completion signal instead.
      if (state.runningCompact && !state.compactObserved) {
        this.armCompactNoSignalSettle(sessionId, state, readParamTurnId(result ?? {}));
      }
    } catch (err) {
      this.clearCompactTimers(state);      this.clearStatus(sessionId, state);
      this.rememberTerminatedCompactTurn(state, state.runningTurnId);
      state.runningCompact = false;
      state.compactCommandInFlight = false;
      state.runningTurnId = undefined;
      state.turnStartInFlight = false;
      state.compactObserved = false;
      this.emitError(sessionId, this.normalizeError(err));
    }
  }

  private async ensureThreadLoaded(sessionId: string, state: CodexSdkSessionState, payload?: ProviderContextPayload): Promise<void> {
    if (state.threadId && state.loaded) return;

    // Always send `baseInstructions`. Catalog models get codex's full
    // per-model prompt (lifted from `~/.codex/models_cache.json`); unknown
    // models fall back to a short provider-neutral default. Either way, the
    // Responses API never sees an empty `instructions` field, which it now
    // rejects with `{"type":"invalid_request_error","message":"Instructions
    // are required"}`.
    const resolvedBaseInstructions = await resolveBaseInstructionsOverride(state.model);
    const baseInstructions = payload
      ? appendImcodesBaseInstructions(resolvedBaseInstructions, payload)
      : resolvedBaseInstructions;
    const sessionSystemText = payload ? getProviderSystemTextParts(payload).sessionSystemText : undefined;

    if (state.threadId) {
      try {
        await this.resumeThread(sessionId, state, baseInstructions);
        state.lastInjectedSessionSystemText = sessionSystemText;
        return;
      } catch (err) {
        if (!isCodexThreadHistoryUnreadableError(err)) throw err;

        const repaired = await this.repairUnreadableThreadHistory(err).catch((repairErr) => {
          logger.warn({ provider: this.id, sessionId, threadId: state.threadId, err: repairErr }, 'Codex SDK failed to repair unreadable thread history');
          return false;
        });
        if (repaired) {
          try {
            await this.resumeThread(sessionId, state, baseInstructions);
            state.lastInjectedSessionSystemText = sessionSystemText;
            return;
          } catch (retryErr) {
            logger.warn({ provider: this.id, sessionId, threadId: state.threadId, err: retryErr }, 'Codex SDK resume still failed after thread history repair');
          }
        }

        const oldThreadId = state.threadId;
        logger.warn({ provider: this.id, sessionId, threadId: oldThreadId, err }, 'Codex SDK stored thread history is unreadable; starting replacement thread');
        if (oldThreadId) this.threadToSession.delete(oldThreadId);
        state.threadId = undefined;
        state.loaded = false;
      }
    }

    await this.startNewThread(sessionId, state, baseInstructions);
    state.lastInjectedSessionSystemText = sessionSystemText;
  }

  private async resumeThread(sessionId: string, state: CodexSdkSessionState, baseInstructions: string): Promise<void> {
    if (!state.threadId) throw new Error('Codex SDK resume requested without a thread id');
    // Resume must carry the same `baseInstructions`: previously-broken
    // threads were persisted with empty base_instructions, and codex's
    // resolution priority (override > stored history > model default)
    // means supplying it on resume is the only way to repair them
    // mid-flight.
    const result = await this.request('thread/resume', {
      threadId: state.threadId,
      ...this.sessionEnvironmentParams(state),
      ...this.sessionMcpConfigParams(state),
      ...(state.model ? { model: state.model } : {}),
      baseInstructions,
    });
    const resumedId = result?.thread?.id ?? state.threadId;
    state.threadId = resumedId;
    state.loaded = true;
    this.threadToSession.set(resumedId, sessionId);
    this.emitSessionInfo(sessionId, { resumeId: resumedId, ...(state.model ? { model: state.model } : {}) });
  }

  private async startNewThread(sessionId: string, state: CodexSdkSessionState, baseInstructions: string): Promise<void> {
    const result = await this.request('thread/start', {
      cwd: state.cwd,
      ...this.sessionEnvironmentParams(state),
      ...this.sessionMcpConfigParams(state),
      approvalPolicy: 'never',
      sandbox: 'danger-full-access',
      personality: 'none',
      ...(state.model ? { model: state.model } : {}),
      baseInstructions,
    });
    const threadId = result?.thread?.id;
    if (!threadId) {
      throw new Error('Codex app-server did not return a thread id');
    }
    state.threadId = threadId;
    state.loaded = true;
    this.threadToSession.set(threadId, sessionId);
    this.emitSessionInfo(sessionId, { resumeId: threadId, ...(state.model ? { model: state.model } : {}) });
  }

  private async repairUnreadableThreadHistory(err: unknown): Promise<boolean> {
    const message = errorMessage(err);
    const filePath = extractCodexJsonlPath(message);
    if (!filePath) return false;

    const before = await readFile(filePath);
    const hadInvalidUtf8 = !isValidUtf8(before);
    const repaired = repairCodexJsonlText(before.toString('utf8'));
    if (!hadInvalidUtf8 && repaired.droppedLineCount === 0) return false;

    const backupPath = `${filePath}.invalid-history-${Date.now()}.bak`;
    await copyFile(filePath, backupPath);
    await writeFile(filePath, Buffer.from(repaired.text, 'utf8'));
    logger.warn({ provider: this.id, filePath, backupPath, hadInvalidUtf8, droppedLineCount: repaired.droppedLineCount }, 'Codex SDK repaired unreadable thread history');
    return true;
  }

  private sessionEnvironmentParams(state: CodexSdkSessionState): { env?: Record<string, string> } {
    return state.env && Object.keys(state.env).length > 0 ? { env: state.env } : {};
  }

  private sessionMcpConfigParams(state: CodexSdkSessionState): { config?: Record<string, unknown> } {
    return state.mcpConfig ? { config: state.mcpConfig } : {};
  }

  private codexGeneratedImageEnv(state: CodexSdkSessionState): Record<string, string | undefined> {
    return {
      ...process.env,
      ...((this.config?.env as Record<string, string | undefined> | undefined) ?? {}),
      ...(state.env ?? {}),
    };
  }

  private codexGeneratedImageDir(state: CodexSdkSessionState): string | null {
    if (!state.threadId) return null;
    return resolve(getCodexHome(this.codexGeneratedImageEnv(state)), 'generated_images', state.threadId);
  }

  private async listGeneratedImagePathsInDir(dir: string): Promise<string[]> {
    try {
      const entries = await readdir(dir, { withFileTypes: true });
      return entries
        .filter((entry) => entry.isFile() && GENERATED_IMAGE_EXTENSIONS.has(extname(entry.name).toLowerCase()))
        .map((entry) => resolve(dir, entry.name))
        .sort();
    } catch {
      return [];
    }
  }

  private async prepareGeneratedImageTracking(sessionId: string, state: CodexSdkSessionState): Promise<void> {
    const dir = this.codexGeneratedImageDir(state);
    if (!dir) {
      state.generatedImageTracking = null;
      state.generatedImagePaths = [];
      return;
    }
    const existingPaths = await this.listGeneratedImagePathsInDir(dir);
    state.generatedImageTracking = {
      dir,
      knownPaths: new Set(existingPaths),
    };
    state.generatedImagePaths = [];
    logger.debug({
      provider: this.id,
      sessionId,
      threadId: state.threadId,
      generatedImageDir: dir,
      knownGeneratedImages: existingPaths.length,
    }, 'Codex SDK prepared generated image path tracking');
  }

  private async detectNewGeneratedImagePaths(
    snapshot: GeneratedImageTrackingSnapshot | null,
  ): Promise<string[]> {
    if (!snapshot) return [];
    const paths = await this.listGeneratedImagePathsInDir(snapshot.dir);
    const freshPaths: string[] = [];
    for (const path of paths) {
      if (snapshot.knownPaths.has(path)) continue;
      freshPaths.push(path);
    }
    return freshPaths;
  }

  private handleLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg: JsonRpcResponse;
    try {
      msg = JSON.parse(trimmed);
    } catch (err) {
      const runtimeSubagentPayload = parseCodexRuntimeSubagentTag(trimmed);
      if (runtimeSubagentPayload) {
        this.emitRuntimeSubagentNotification(runtimeSubagentPayload);
        return;
      }
      logger.warn({ provider: this.id, line: trimmed, err }, 'Failed to parse Codex app-server line');
      return;
    }

    if (typeof msg.id === 'number') {
      const pending = this.pendingRequests.get(msg.id);
      if (!pending) return;
      this.pendingRequests.delete(msg.id);
      if (msg.error) {
        pending.reject(new Error(msg.error.message ?? 'Codex app-server request failed'));
      } else {
        pending.resolve(msg.result);
      }
      return;
    }

    if (!msg.method) return;
    void this.handleNotification(msg.method, msg.params ?? {}).catch((err) => {
      logger.warn({ provider: this.id, method: msg.method, err }, 'Codex app-server notification handler failed');
    });
  }

  private resolveRuntimeSubagentSession(params: Record<string, any>): string | undefined {
    const threadId = readParamThreadId(params);
    if (threadId) return this.threadToSession.get(threadId);
    const activeSessions = [...this.sessions.entries()]
      .filter(([, state]) => state.runningTurnId || state.runningCompact)
      .map(([sessionId]) => sessionId);
    if (activeSessions.length === 1) return activeSessions[0];
    if (this.sessions.size === 1) return [...this.sessions.keys()][0];
    return undefined;
  }

  private emitRuntimeSubagentNotification(params: Record<string, any>): void {
    const sessionId = this.resolveRuntimeSubagentSession(params);
    const state = sessionId ? this.sessions.get(sessionId) : null;
    if (!sessionId || !state) return;
    if (state.cancelled) return;
    this.clearStatus(sessionId, state);
    const tool = runtimeSubagentToolFromPayload(sessionId, params);
    if (!tool) return;
    const detail = tool.detail as SdkSubagentDetail | undefined;
    const canonicalKey = detail?.meta?.canonicalKey;
    if (canonicalKey) {
      const startedAtMs = detail.meta.startedAtMs
        ?? state.runtimeSubagentStartedAtByKey.get(canonicalKey)
        ?? Date.now();
      detail.meta.startedAtMs = startedAtMs;
      if (detail.meta.active && !detail.meta.terminal) {
        state.runtimeSubagentStartedAtByKey.set(canonicalKey, startedAtMs);
      }
    }
    for (const cb of this.toolCallCallbacks) cb(sessionId, tool);
  }

  private async readRawChecklistHistoryChunk(state: CodexSdkSessionState): Promise<string | null> {
    if (!state.threadId) return null;
    const providerEnv = (this.config?.env as Record<string, string> | undefined) ?? {};
    const env = { ...process.env, ...providerEnv, ...(state.env ?? {}) };
    const rolloutPath = state.rawChecklistRolloutPath ?? await findCodexRolloutPathByUuid(state.threadId, { env });
    if (!rolloutPath) return null;
    state.rawChecklistRolloutPath = rolloutPath;

    let fh: Awaited<ReturnType<typeof open>> | null = null;
    try {
      fh = await open(rolloutPath, 'r');
      const { size } = await fh.stat();
      const priorOffset = state.rawChecklistRolloutOffset;
      const shouldDiscardInitialPartial = priorOffset === undefined || priorOffset > size;
      const start = shouldDiscardInitialPartial
        ? Math.max(0, size - CODEX_RAW_CHECKLIST_HISTORY_TAIL_BYTES)
        : priorOffset;
      if (start >= size) {
        state.rawChecklistRolloutOffset = size;
        return null;
      }
      const buffer = Buffer.allocUnsafe(size - start);
      const { bytesRead } = await fh.read(buffer, 0, buffer.length, start);
      if (bytesRead <= 0) return null;

      let processStart = 0;
      if (shouldDiscardInitialPartial && start > 0) {
        const firstNewline = buffer.indexOf(10, 0);
        if (firstNewline < 0 || firstNewline >= bytesRead) return null;
        processStart = firstNewline + 1;
      }

      let processEnd = bytesRead;
      if (buffer[bytesRead - 1] !== 10) {
        const lastNewline = buffer.lastIndexOf(10, bytesRead - 1);
        if (lastNewline < processStart) {
          state.rawChecklistRolloutOffset = start + processStart;
          return null;
        }
        processEnd = lastNewline + 1;
      }
      if (processEnd <= processStart) return null;

      state.rawChecklistRolloutOffset = start + processEnd;
      const chunk = buffer.subarray(processStart, processEnd).toString('utf8');
      return chunk;
    } catch (err) {
      logger.debug({ provider: this.id, threadId: state.threadId, rolloutPath, err }, 'Codex SDK raw checklist history scan failed');
      return null;
    } finally {
      if (fh) await fh.close().catch(() => {});
    }
  }

  private async scanRawChecklistHistory(sessionId: string, state: CodexSdkSessionState): Promise<void> {
    // codex >= 0.139 emits the plan natively via `turn/plan/updated`; once we've
    // seen that for this session, skip the legacy rollout-file scrape so the
    // plan is never rendered twice.
    if (state.nativePlanEventSeen) return;
    const chunk = await this.readRawChecklistHistoryChunk(state);
    if (!chunk) return;
    const minTimestamp = state.rawChecklistStartedAt - CODEX_RAW_CHECKLIST_HISTORY_CLOCK_SKEW_MS;
    for (const line of chunk.split('\n')) {
      const tool = rawChecklistToolFromJsonlLine(sessionId, line, minTimestamp);
      if (!tool) continue;
      if (state.rawChecklistSeenCallIds.has(tool.id)) continue;
      state.rawChecklistSeenCallIds.add(tool.id);
      for (const cb of this.toolCallCallbacks) cb(sessionId, tool);
    }
  }

  private queueRawChecklistHistoryScan(sessionId: string, state: CodexSdkSessionState): void {
    if (!state.threadId || state.rawChecklistScanPromise) return;
    state.rawChecklistScanPromise = this.scanRawChecklistHistory(sessionId, state)
      .catch((err) => logger.debug({ provider: this.id, sessionId, threadId: state.threadId, err }, 'Codex SDK raw checklist history scan failed'))
      .finally(() => {
        state.rawChecklistScanPromise = undefined;
      });
  }

  private clearRawChecklistPollTimer(state: CodexSdkSessionState): void {
    if (state.rawChecklistPollTimer) clearTimeout(state.rawChecklistPollTimer);
    state.rawChecklistPollTimer = null;
    state.rawChecklistPollUntil = 0;
  }

  private armRawChecklistPolling(sessionId: string, state: CodexSdkSessionState): void {
    if (!state.threadId) return;
    state.rawChecklistPollUntil = Date.now() + CODEX_RAW_CHECKLIST_POLL_WINDOW_MS;
    if (state.rawChecklistPollTimer) return;
    const tick = () => {
      state.rawChecklistPollTimer = null;
      if (!this.sessions.has(sessionId)) return;
      if (!state.threadId || Date.now() > state.rawChecklistPollUntil) {
        this.clearRawChecklistPollTimer(state);
        return;
      }
      this.queueRawChecklistHistoryScan(sessionId, state);
      state.rawChecklistPollTimer = setTimeout(tick, CODEX_RAW_CHECKLIST_POLL_INTERVAL_MS);
      state.rawChecklistPollTimer.unref?.();
    };
    state.rawChecklistPollTimer = setTimeout(tick, CODEX_RAW_CHECKLIST_POLL_INTERVAL_MS);
    state.rawChecklistPollTimer.unref?.();
  }

  // Dedicated fast poll so a zombie turn is settled from rollout evidence within
  // a few seconds instead of waiting for the next ~20s thread/read heartbeat.
  private armRolloutSettlePoll(sessionId: string, state: CodexSdkSessionState): void {
    if (!state.threadId) return;
    if (state.rolloutSettlePollTimer) return;
    const tick = () => {
      state.rolloutSettlePollTimer = null;
      if (!this.sessions.has(sessionId)) return;
      const lease = state.activeTurnLease;
      const turnId = state.runningTurnId ?? lease?.turnId;
      if (
        !turnId
        || state.cancelled
        || state.runningCompact
        || this.isClosedCodexTurn(state, turnId)
      ) {
        this.clearRolloutSettlePoll(state);
        return;
      }
      // No-ops until the turn has been silent past the gate, so healthy,
      // actively-streaming turns never touch the file; only zombies settle here.
      if (lease && this.isHeartbeatLeaseActive(sessionId, state, lease)) {
        this.maybeConfirmTaskCompleteFromRollout(sessionId, state, lease, Date.now());
      } else {
        // If the SDK notification/heartbeat path wedges but the runtime still
        // has a current turn id, Codex core's rollout file is still the durable
        // authority. Keep polling it so a recorded task_complete clears the
        // underlying provider state instead of only letting the UI pretend idle.
        this.maybeConfirmCurrentTurnTaskCompleteFromRollout(sessionId, state, turnId);
      }
      state.rolloutSettlePollTimer = setTimeout(tick, CODEX_ROLLOUT_SETTLE_POLL_INTERVAL_MS);
      state.rolloutSettlePollTimer.unref?.();
    };
    state.rolloutSettlePollTimer = setTimeout(tick, CODEX_ROLLOUT_SETTLE_POLL_INTERVAL_MS);
    state.rolloutSettlePollTimer.unref?.();
  }

  private clearRolloutSettlePoll(state: CodexSdkSessionState): void {
    if (state.rolloutSettlePollTimer) clearTimeout(state.rolloutSettlePollTimer);
    state.rolloutSettlePollTimer = null;
  }

  // ROLLOUT-FIRST AUTHORITY — front-line, real-time turn-completion detection.
  //
  // Attaches an fs.watch to the running turn's rollout file so the terminal
  // `task_complete{turn_id}` record settles the turn the instant it lands —
  // independent of the app-server's `turn/completed`, the heartbeat lease, and
  // the legacy 60s silence gate. Armed at the single activity choke-point
  // (`refreshActiveTurnLease`), so every observed turn is covered; the immediate
  // check on arm also self-heals a turn whose `task_complete` was already on disk
  // (e.g. the app-server went silent, or the record landed between events).
  private armRolloutAuthorityWatch(sessionId: string, state: CodexSdkSessionState, turnId: string | undefined): void {
    if (!turnId || !state.threadId) return;
    if (state.cancelled || state.runningCompact) return;
    if (this.isClosedCodexTurn(state, turnId)) return;
    // Already watching this exact turn — cheap no-op (called on every activity).
    if (state.rolloutAuthorityWatcher && state.rolloutAuthorityTurnId === turnId) return;
    if (state.rolloutAuthorityArmInFlight && state.rolloutAuthorityTurnId === turnId) return;
    // New turn (or first arm): tear down any prior watcher and re-target.
    this.disarmRolloutAuthorityWatch(state);
    state.rolloutAuthorityTurnId = turnId;
    state.rolloutAuthorityArmInFlight = true;
    void (async () => {
      try {
        const providerEnv = (this.config?.env as Record<string, string> | undefined) ?? {};
        const env = { ...process.env, ...providerEnv, ...(state.env ?? {}) };
        const rolloutPath = state.rawChecklistRolloutPath ?? await findCodexRolloutPathByUuid(state.threadId!, { env });
        const latest = this.sessions.get(sessionId);
        // Turn rolled over or session gone while resolving the path.
        if (!latest || latest.rolloutAuthorityTurnId !== turnId) return;
        if (!rolloutPath) return; // file not resolvable yet; a later activity re-arms
        latest.rawChecklistRolloutPath = rolloutPath;
        let watcher: FSWatcher;
        try {
          watcher = watch(rolloutPath, { persistent: false }, () => {
            this.scheduleRolloutAuthorityCheck(sessionId, CODEX_ROLLOUT_AUTHORITY_DEBOUNCE_MS);
          });
        } catch (err) {
          logger.debug({ provider: this.id, sessionId, threadId: latest.threadId, turnId, rolloutPath, err }, 'Codex rollout authority watch failed to attach');
          return;
        }
        const cur = this.sessions.get(sessionId);
        if (!cur || cur.rolloutAuthorityTurnId !== turnId) {
          try { watcher.close(); } catch { /* ignore */ }
          return;
        }
        cur.rolloutAuthorityWatcher = watcher;
        cur.rolloutAuthorityWatchPath = rolloutPath;
        // Immediate check: the terminal record may already be on disk (post-restart
        // zombie, or it landed before the watcher attached).
        this.scheduleRolloutAuthorityCheck(sessionId, 0);
      } finally {
        const s = this.sessions.get(sessionId);
        if (s) s.rolloutAuthorityArmInFlight = false;
      }
    })();
  }

  private scheduleRolloutAuthorityCheck(sessionId: string, delayMs: number): void {
    const state = this.sessions.get(sessionId);
    if (!state || !state.rolloutAuthorityTurnId) return;
    if (state.rolloutAuthorityDebounce) return; // coalesce the append burst
    state.rolloutAuthorityDebounce = setTimeout(() => {
      const s = this.sessions.get(sessionId);
      if (s) s.rolloutAuthorityDebounce = undefined;
      void this.runRolloutAuthorityCheck(sessionId);
    }, Math.max(0, delayMs));
    state.rolloutAuthorityDebounce.unref?.();
  }

  private async runRolloutAuthorityCheck(sessionId: string): Promise<void> {
    const state = this.sessions.get(sessionId);
    if (!state) return;
    const turnId = state.rolloutAuthorityTurnId ?? state.runningTurnId;
    if (!turnId) return;
    if (state.cancelled || state.runningCompact || this.isClosedCodexTurn(state, turnId)) {
      this.disarmRolloutAuthorityWatch(state);
      return;
    }
    // Shared with the legacy settle poll so only one rollout read runs at a time.
    if (state.rolloutTaskCompleteCheckInFlight) return;
    state.rolloutTaskCompleteCheckInFlight = true;
    // Current turn's start wallclock — rejects a PRIOR turn's task_complete during
    // the window before this turn's own task_started has been flushed to disk.
    const turnStartedAtMs = state.activeTurnLease?.startedAtMs ?? state.activeTurnLease?.turnStartInFlightAtMs ?? null;
    try {
      // Fast path — UNCHANGED behavior/timing: settle when the tracked turn's own
      // task_complete is on disk. Keeping this first preserves the exact prior
      // code path (and timing) for every healthy turn.
      let evidence: CodexRolloutTaskCompleteEvidence | null = await this.rolloutTailReportsTaskComplete(state, turnId);
      let settledTurnId = turnId;
      let desync = false;
      if (!evidence) {
        // Desync fallback: the tracked turnId no longer matches the turn_id
        // codex-core actually wrote (turn/start result missing / late / wrong id),
        // so the turnId-scoped match above never fires even though task_complete
        // is durably on disk — the exact case that used to strand a finished turn
        // as "working" forever. The rollout file is already session-scoped, so
        // judge liveness by the tail's LAST lifecycle marker and settle when the
        // terminal task_complete was written at/after this turn started (the
        // start-time guard rejects a stale prior turn's completion).
        const terminal = await this.rolloutTailReportsTerminalTaskComplete(state);
        if (
          terminal
          && terminal.turnId !== turnId
          && turnStartedAtMs != null
          && terminal.completedAtMs != null
          && terminal.completedAtMs >= turnStartedAtMs
        ) {
          evidence = terminal;
          settledTurnId = terminal.turnId;
          desync = true;
        }
      }
      if (!evidence) return;
      const latest = this.sessions.get(sessionId);
      if (!latest) return;
      if (latest.cancelled || latest.runningCompact || this.isClosedCodexTurn(latest, settledTurnId)) return;
      // A missing turn/start RPC response can leave startTurn() awaiting forever;
      // record the terminal turn so a very late response cannot re-run it.
      if (latest.turnStartInFlight) latest.terminalDuringTurnStartIds.add(settledTurnId);
      if (evidence.lastAgentMessage && latest.currentText !== evidence.lastAgentMessage) {
        latest.currentMessageId = `${settledTurnId}:rollout-task-complete`;
        latest.currentText = evidence.lastAgentMessage;
      }
      logger.warn({
        provider: this.id,
        sessionId,
        ...(latest.imcodesSessionName ? { sessionName: latest.imcodesSessionName } : {}),
        threadId: latest.threadId,
        turnId: settledTurnId,
        ...(desync ? { trackedTurnId: turnId, desyncSettle: true } : {}),
      }, 'Codex rollout task_complete observed via real-time watch; settling turn from authoritative rollout evidence');
      await this.completeTurn(sessionId, latest, settledTurnId, 'rollout_task_complete');
    } catch (err) {
      logger.debug({ provider: this.id, sessionId, threadId: state.threadId, turnId, err }, 'Codex rollout authority check failed');
    } finally {
      const s = this.sessions.get(sessionId);
      if (s) s.rolloutTaskCompleteCheckInFlight = false;
    }
  }

  private disarmRolloutAuthorityWatch(state: CodexSdkSessionState): void {
    if (state.rolloutAuthorityWatcher) {
      try { state.rolloutAuthorityWatcher.close(); } catch { /* ignore */ }
      state.rolloutAuthorityWatcher = undefined;
    }
    if (state.rolloutAuthorityDebounce) {
      clearTimeout(state.rolloutAuthorityDebounce);
      state.rolloutAuthorityDebounce = undefined;
    }
    state.rolloutAuthorityWatchPath = undefined;
    state.rolloutAuthorityTurnId = undefined;
  }

  private clearChildSubagentRolloutPollTimer(state: CodexSdkSessionState): void {
    if (state.childSubagentRolloutTimer) clearTimeout(state.childSubagentRolloutTimer);
    state.childSubagentRolloutTimer = null;
    state.childSubagentRolloutPollUntil = 0;
  }

  private queueChildSubagentRolloutScan(sessionId: string, state: CodexSdkSessionState): void {
    if (!state.threadId || state.childSubagentRolloutScanPromise) return;
    state.childSubagentRolloutScanPromise = this.scanChildSubagentRollouts(sessionId, state)
      .catch((err) => logger.debug({ provider: this.id, sessionId, threadId: state.threadId, err }, 'Codex SDK child subagent rollout scan failed'))
      .finally(() => {
        state.childSubagentRolloutScanPromise = undefined;
      });
  }

  private armChildSubagentRolloutPolling(sessionId: string, state: CodexSdkSessionState): void {
    if (!state.threadId) return;
    state.childSubagentRolloutPollUntil = Date.now() + CODEX_CHILD_SUBAGENT_ROLLOUT_POLL_WINDOW_MS;
    this.queueChildSubagentRolloutScan(sessionId, state);
    if (state.childSubagentRolloutTimer) return;
    const tick = () => {
      state.childSubagentRolloutTimer = null;
      if (!this.sessions.has(sessionId)) return;
      const hasOpenChild = [...this.trackedSubagentThreads.values()].some(
        (tracked) => tracked.sessionId === sessionId && tracked.rolloutPath,
      );
      if (!state.threadId || (Date.now() > state.childSubagentRolloutPollUntil && !hasOpenChild)) {
        this.clearChildSubagentRolloutPollTimer(state);
        return;
      }
      this.queueChildSubagentRolloutScan(sessionId, state);
      state.childSubagentRolloutTimer = setTimeout(tick, CODEX_CHILD_SUBAGENT_ROLLOUT_POLL_INTERVAL_MS);
      state.childSubagentRolloutTimer.unref?.();
    };
    state.childSubagentRolloutTimer = setTimeout(tick, CODEX_CHILD_SUBAGENT_ROLLOUT_POLL_INTERVAL_MS);
    state.childSubagentRolloutTimer.unref?.();
  }

  private async scanChildSubagentRollouts(sessionId: string, state: CodexSdkSessionState): Promise<void> {
    if (!state.threadId) return;
    const providerEnv = (this.config?.env as Record<string, string> | undefined) ?? {};
    const env = { ...process.env, ...providerEnv, ...(state.env ?? {}) };
    const snapshots = await discoverCodexChildSubagentRollouts(
      env,
      state.threadId,
      state.childSubagentRolloutStartedAt,
    );
    const seenRolloutPaths = new Set(snapshots.map((snapshot) => snapshot.rolloutPath));
    const rememberSnapshot = (snapshot: CodexChildSubagentRolloutSnapshot | null | undefined): void => {
      if (!snapshot || seenRolloutPaths.has(snapshot.rolloutPath)) return;
      snapshots.push(snapshot);
      seenRolloutPaths.add(snapshot.rolloutPath);
    };
    for (const tracked of this.trackedSubagentThreads.values()) {
      if (tracked.sessionId !== sessionId) continue;
      if (state.childSubagentRolloutCompletedIds.has(tracked.agentId)) continue;
      const rolloutPath = tracked.rolloutPath ?? await findCodexRolloutPathByUuid(tracked.agentId, { env });
      if (!rolloutPath || seenRolloutPaths.has(rolloutPath)) continue;
      const snapshot = await readCodexChildSubagentRolloutSnapshot(rolloutPath);
      if (snapshot?.agentId === tracked.agentId) {
        rememberSnapshot(snapshot);
      }
    }
    const sessionSnapshots = await discoverCodexChildSubagentRolloutsBySession(
      env,
      state.imcodesSessionName ?? sessionId,
      state.cwd,
      state.childSubagentRolloutStartedAt,
    );
    for (const snapshot of sessionSnapshots) rememberSnapshot(snapshot);
    for (const snapshot of snapshots) {
      if (state.childSubagentRolloutCompletedIds.has(snapshot.agentId)) continue;
      const existing = this.trackedSubagentThreads.get(snapshot.agentId);
      const tracked: CodexTrackedSubagentThread = existing ?? {
        sessionId,
        callId: `rollout:${snapshot.agentId}`,
        agentId: snapshot.agentId,
      };
      tracked.agentName = snapshot.agentName ?? tracked.agentName;
      tracked.prompt = snapshot.prompt ?? tracked.prompt;
      tracked.model = snapshot.model ?? tracked.model;
      tracked.rolloutPath = snapshot.rolloutPath;
      tracked.startedAtMs = tracked.startedAtMs ?? snapshot.startedAtMs ?? Date.now();
      if (snapshot.usageTotalTokens !== undefined) tracked.usageTotalTokens = snapshot.usageTotalTokens;
      this.trackedSubagentThreads.set(snapshot.agentId, tracked);

      if (!state.childSubagentRolloutSeenIds.has(snapshot.agentId)) {
        state.childSubagentRolloutSeenIds.add(snapshot.agentId);
        this.emitTrackedSubagentSnapshot(tracked, 'running');
      } else if (snapshot.usageTotalTokens !== undefined && !snapshot.completed) {
        this.emitTrackedSubagentSnapshot(tracked, tracked.lastStatus ?? 'running');
      }

      if (snapshot.completed) {
        const status = { completed: snapshot.output ?? 'completed' };
        tracked.lastStatus = status;
        this.emitTrackedSubagentSnapshot(tracked, status);
        state.childSubagentRolloutCompletedIds.add(snapshot.agentId);
        this.trackedSubagentThreads.delete(snapshot.agentId);
      }
    }
  }

  private handleRawResponseItem(params: Record<string, any>): boolean {
    const threadId = readParamThreadId(params);
    const sessionId = threadId ? this.threadToSession.get(threadId) : undefined;
    const state = sessionId ? this.sessions.get(sessionId) : null;
    const item = isRecord(params.item) ? params.item : undefined;
    if (!sessionId || !state || !item) return false;
    if (state.cancelled) return true;
    if (item.type === 'custom_tool_call') {
      const tool = customToolFromItem(sessionId, item, 'started');
      if (!tool) return false;
      const turnId = readParamTurnId(params) ?? state.runningTurnId;
      this.recordStrongActivity(sessionId, state, turnId);
      this.emitTrackedProviderToolCall(sessionId, state, {
        ...tool,
        ...(turnId ? { turnId } : {}),
      });
      return true;
    }

    if (item.type === 'custom_tool_call_output') {
      const callId = meaningfulString(item.call_id) ?? meaningfulString(item.callId);
      if (!callId) return false;
      let prior = state.customToolLifecycleByCallId.get(callId)?.tool;
      if (!prior) {
        // A reconnect/version skew can deliver the result without its matching
        // call notification. Emit a minimal running snapshot first so the
        // transport relay has a card to terminate instead of an orphan result.
        this.emitTrackedProviderToolCall(sessionId, state, {
          id: callId,
          name: meaningfulString(item.name) ?? 'custom_tool',
          status: 'running',
          detail: {
            kind: 'customToolCall',
            summary: meaningfulString(item.name) ?? 'custom_tool',
            meta: { callId, status: 'running', synthesizedFromOutput: true },
            raw: item,
          },
        });
        prior = state.customToolLifecycleByCallId.get(callId)?.tool;
      }
      const terminal = customToolTerminalFromOutput(item);
      const turnId = readParamTurnId(params) ?? state.runningTurnId;
      this.recordStrongActivity(sessionId, state, turnId);
      const priorDetail = isRecord(prior?.detail) ? prior.detail : undefined;
      const priorMeta = isRecord(priorDetail?.meta) ? priorDetail.meta : undefined;
      this.emitTrackedProviderToolCall(sessionId, state, {
        id: callId,
        name: prior?.name ?? meaningfulString(item.name) ?? 'custom_tool',
        status: terminal.status,
        ...(prior?.input !== undefined ? { input: prior.input } : {}),
        output: terminal.output,
        terminalStatus: terminal.terminalStatus,
        terminalReason: terminal.terminalReason,
        terminalSynthetic: false,
        terminalSource: 'app_server_jsonrpc',
        terminalDecisionReason: terminal.terminalReason,
        ...(turnId ? { turnId } : {}),
        detail: {
          kind: 'customToolCall',
          summary: priorDetail?.summary ?? prior?.name ?? meaningfulString(item.name) ?? 'custom_tool',
          ...(prior?.input !== undefined ? { input: prior.input } : {}),
          output: item.output ?? item.result ?? item.content,
          meta: {
            ...priorMeta,
            callId,
            status: item.status ?? terminal.terminalStatus,
          },
          raw: item,
        },
      });
      return true;
    }

    if (item.type === 'function_call') {
      const name = meaningfulString(item.name);
      const checklistTool = rawChecklistToolFromFunctionCall(sessionId, item);
      if (checklistTool) {
        state.rawChecklistSeenCallIds.add(checklistTool.id);
        for (const cb of this.toolCallCallbacks) cb(sessionId, checklistTool);
        return true;
      }
      if (!name || !CODEX_RAW_SPAWN_AGENT_FUNCTION_NAMES.has(name)) return false;
      const callId = meaningfulString(item.call_id) ?? meaningfulString(item.callId);
      if (!callId) return true;
      this.rawSpawnAgentCalls.set(callId, {
        sessionId,
        callId,
        args: parseJsonRecord(item.arguments) ?? {},
        startedAtMs: Date.now(),
      });
      return true;
    }

    if (item.type !== 'function_call_output') return false;
    const callId = meaningfulString(item.call_id) ?? meaningfulString(item.callId);
    if (!callId) return false;
    const call = this.rawSpawnAgentCalls.get(callId);
    if (!call) return false;
    this.rawSpawnAgentCalls.delete(callId);

    const outputRecord = parseJsonRecord(item.output) ?? {};
    const tool = rawSpawnAgentToolFromOutput(call, outputRecord);
    if (tool) {
      for (const cb of this.toolCallCallbacks) cb(call.sessionId, tool);
    }

    const agentId = readRawSpawnAgentId(outputRecord);
    if (agentId) {
      this.trackedSubagentThreads.set(agentId, {
        sessionId: call.sessionId,
        callId,
        agentId,
        startedAtMs: call.startedAtMs,
        agentName: meaningfulString(outputRecord.nickname)
          ?? meaningfulString(outputRecord.name)
          ?? meaningfulString(call.args.nickname)
          ?? meaningfulString(call.args.name)
          ?? meaningfulString(call.args.agent_type)
          ?? meaningfulString(call.args.agentType),
        prompt: meaningfulString(call.args.message)
          ?? meaningfulString(call.args.prompt)
          ?? meaningfulString(call.args.instructions),
        model: meaningfulString(call.args.model)
          ?? meaningfulString(call.args.agentId)
          ?? meaningfulString(call.args.agent_id),
      });
    }
    return true;
  }

  private codexSubagentUsageTotalTokens(usage: CodexSdkSessionState['lastUsage']): number | undefined {
    if (!usage) return undefined;
    const total = finiteNumber(usage.total_tokens);
    if (total !== undefined) return total;
    const codexTotalInput = finiteNumber(usage.codex_total_input_tokens);
    const codexTotalOutput = finiteNumber(usage.codex_total_output_tokens);
    if (codexTotalInput !== undefined || codexTotalOutput !== undefined) {
      return (codexTotalInput ?? 0) + (codexTotalOutput ?? 0);
    }
    return usage.input_tokens + usage.cache_read_input_tokens + usage.output_tokens;
  }

  private emitTrackedSubagentSnapshot(tracked: CodexTrackedSubagentThread, status: unknown): ToolCallEvent | null {
    const tool = runtimeSubagentToolFromPayload(tracked.sessionId, {
      agent_id: tracked.agentId,
      status,
      ...(tracked.agentName ? { nickname: tracked.agentName } : {}),
      ...(tracked.prompt ? { prompt: tracked.prompt } : {}),
      ...(tracked.model ? { model: tracked.model } : {}),
      ...(tracked.usageTotalTokens !== undefined ? { usageTotalTokens: tracked.usageTotalTokens } : {}),
      ...(tracked.startedAtMs !== undefined ? { startedAtMs: tracked.startedAtMs } : {}),
      backgrounded: true,
    });
    if (!tool) return null;
    for (const cb of this.toolCallCallbacks) cb(tracked.sessionId, tool);
    return tool;
  }

  private handleTrackedSubagentTokenUsage(params: Record<string, any>): boolean {
    const threadId = readParamThreadId(params);
    const tracked = threadId ? this.trackedSubagentThreads.get(threadId) : undefined;
    if (!threadId || !tracked) return false;
    const usage = normalizeCodexTokenUsage(params);
    if (!usage) return true;
    const usageTotalTokens = this.codexSubagentUsageTotalTokens(usage);
    if (usageTotalTokens !== undefined) tracked.usageTotalTokens = usageTotalTokens;
    this.emitTrackedSubagentSnapshot(tracked, tracked.lastStatus ?? 'running');
    return true;
  }

  private handleTrackedSubagentTurnCompleted(params: Record<string, any>): boolean {
    const threadId = readParamThreadId(params);
    const tracked = threadId ? this.trackedSubagentThreads.get(threadId) : undefined;
    if (!threadId || !tracked) return false;
    const rawStatus = readTurnStatus(params);
    const normalized = normalizeStatusName(rawStatus);
    const status = normalized === 'completed' || normalized === 'complete' || normalized === 'succeeded' || normalized === 'success'
      ? { completed: rawStatus ?? 'completed' }
      : normalized === 'interrupted' || normalized === 'cancelled' || normalized === 'canceled'
        ? 'interrupted'
        : rawStatus ?? 'completed';
    tracked.lastStatus = status;
    this.emitTrackedSubagentSnapshot(tracked, status);
    this.sessions.get(tracked.sessionId)?.childSubagentRolloutCompletedIds.add(threadId);
    this.trackedSubagentThreads.delete(threadId);
    return true;
  }

  private handleTrackedSubagentThreadStatus(params: Record<string, any>): boolean {
    const threadId = readParamThreadId(params);
    const tracked = threadId ? this.trackedSubagentThreads.get(threadId) : undefined;
    if (!threadId || !tracked) return false;
    const rawStatus = readThreadStatus(params);
    if (!rawStatus) return true;
    const status = isThreadActiveStatus(rawStatus)
      ? 'running'
      : isThreadIdleStatus(rawStatus)
        ? { completed: rawStatus }
        : rawStatus;
    tracked.lastStatus = status;
    const tool = this.emitTrackedSubagentSnapshot(tracked, status);
    if ((tool?.detail as SdkSubagentDetail | undefined)?.meta?.terminal) {
      this.sessions.get(tracked.sessionId)?.childSubagentRolloutCompletedIds.add(threadId);
      this.trackedSubagentThreads.delete(threadId);
    }
    return true;
  }

  private async handleNotification(method: string, params: Record<string, any>): Promise<void> {
    if (method === 'thread/started') {
      const threadId = params.thread?.id;
      if (!threadId) return;
      const sessionId = this.threadToSession.get(threadId);
      if (!sessionId) return;
      const state = this.sessions.get(sessionId);
      if (!state) return;
      state.threadId = threadId;
      state.loaded = true;
      this.emitSessionInfo(sessionId, { resumeId: threadId, ...(state.model ? { model: state.model } : {}) });
      return;
    }

    if (method === 'thread/tokenUsage/updated') {
      if (this.handleTrackedSubagentTokenUsage(params)) return;
      const threadId = readParamThreadId(params);
      const sessionId = threadId ? this.threadToSession.get(threadId) : undefined;
      const state = sessionId ? this.sessions.get(sessionId) : null;
      if (!sessionId || !state) return;      const normalizedUsage = normalizeCodexTokenUsage(params);
      if (!normalizedUsage) return;
      state.lastUsage = normalizedUsage;
      this.recordWeakActivity(sessionId, state);
      for (const cb of this.usageCallbacks) cb(sessionId, {
        usage: normalizedUsage,
        ...(state.model ? { model: state.model } : {}),
      });
      this.queueRawChecklistHistoryScan(sessionId, state);
      return;
    }

    if (method === 'thread/compacted') {
      const threadId = readParamThreadId(params);
      const sessionId = threadId ? this.threadToSession.get(threadId) : undefined;
      const state = sessionId ? this.sessions.get(sessionId) : null;
      if (!sessionId || !state || !state.runningCompact) return;
      this.completeCompact(sessionId, state, readParamTurnId(params));
      return;
    }

    if (method === 'thread/status/changed') {
      if (this.handleTrackedSubagentThreadStatus(params)) return;
      const threadId = readParamThreadId(params);
      const sessionId = threadId ? this.threadToSession.get(threadId) : undefined;
      const state = sessionId ? this.sessions.get(sessionId) : null;
      if (!sessionId || !state) return;
      const status = readThreadStatus(params);
      if (isThreadActiveStatus(status)) {
        this.clearIdleSettleTimer(state); // turn resumed → cancel any pending idle settle
        const turnId = readParamTurnId(params);
        if (turnId && state.runningTurnId === turnId) this.recordStrongActivity(sessionId, state, turnId);
        else this.recordWeakActivity(sessionId, state);
        if (!state.runningCompact) return;
        state.compactObserved = true;
        this.clearCompactSettleTimer(state);
        this.emitStatus(sessionId, state, {
          status: 'compacting',
          label: 'Compacting context...',
        });
        return;
      }
      if (isThreadIdleStatus(status)) {
        if (state.runningCompact) {
          this.completeCompact(sessionId, state, readParamTurnId(params));
          return;
        }
        // App-server thread-idle is not terminal proof. Field logs show both
        // directions: some finished turns never deliver `turn/completed`, while
        // other turns report idle/completed before Codex core keeps producing
        // output. Treat idle as a prompt to consult heartbeat/rollout evidence,
        // not as permission to complete the turn directly.
        if (
          state.runningTurnId
          && !state.cancelled
          && !state.turnStartInFlight
          && !this.isClosedCodexTurn(state, state.runningTurnId)
        ) {
          if (this.hasActiveToolItems(state)) {
            state.deferredIdleSettleTurnId = state.runningTurnId;
            return;
          }
          const lease = state.activeTurnLease;
          if (lease && this.isHeartbeatLeaseActive(sessionId, state, lease)) {
            if (lease.heartbeatTimer) {
              clearTimeout(lease.heartbeatTimer);
              lease.heartbeatTimer = undefined;
            }
            void this.runHeartbeat(sessionId, lease.id, lease.attemptId);
            return;
          }
          this.maybeConfirmCurrentTurnTaskCompleteFromRollout(sessionId, state, state.runningTurnId);
          this.armRolloutSettlePoll(sessionId, state);
          return;
        }
      }
      return;
    }

    if (isCodexRuntimeSubagentMethod(method, params)) {
      this.emitRuntimeSubagentNotification(params);
      return;
    }

    if (method === 'turn/started') {
      const threadId = readParamThreadId(params);
      const sessionId = threadId ? this.threadToSession.get(threadId) : undefined;
      const state = sessionId ? this.sessions.get(sessionId) : null;
      if (!sessionId || !state || state.cancelled || state.runningCompact) return;
      const turnId = readParamTurnId(params);
      if (turnId && !this.isClosedCodexTurn(state, turnId)) state.runningTurnId = state.runningTurnId ?? turnId;
      this.recordStrongActivity(sessionId, state, turnId);
      return;
    }

    if (method === 'rawResponseItem/completed') {
      this.handleRawResponseItem(params);
      return;
    }

    if (method === 'turn/plan/updated') {
      const threadId = readParamThreadId(params);
      const sessionId = threadId ? this.threadToSession.get(threadId) : undefined;
      const state = sessionId ? this.sessions.get(sessionId) : null;
      if (!sessionId || !state) return;
      const turnId = readParamTurnId(params);
      if (turnId && (state.cancelled || this.isClosedCodexTurn(state, turnId))) return;
      if (turnId && state.runningTurnId && turnId !== state.runningTurnId) return;
      this.recordStrongActivity(sessionId, state, turnId);
      // Native plan event (codex >= 0.139). Render it AND suppress the legacy
      // rollout-file scan for this session so old (file-scrape) + new never
      // double-render the same plan.
      state.nativePlanEventSeen = true;
      const tool = planToolFromTurnPlanEvent(sessionId, turnId ?? state.runningTurnId, params.plan);
      if (tool) {
        this.emitTrackedProviderToolCall(sessionId, state, tool);
      }
      return;
    }

    if (method === 'item/agentMessage/delta') {
      const threadId = readParamThreadId(params);
      const sessionId = threadId ? this.threadToSession.get(threadId) : undefined;
      const state = sessionId ? this.sessions.get(sessionId) : null;
      if (!sessionId || !state) return;
      if (state.cancelled) return;
      this.clearIdleSettleTimer(state); // live token → turn active, cancel pending idle settle
      const turnId = readParamTurnId(params);
      const closedTurn = this.isClosedCodexTurn(state, turnId);
      // NEVER drop live assistant text. If our turn bookkeeping lags the
      // app-server (turn/start's result carried no turn id, so runningTurnId was
      // never set, or this delta's turnId is shaped differently), adopt the
      // delta's turnId and render anyway — a real text update must always reach
      // the UI. Closed/terminated turns may still render late text, but they
      // must never be adopted back into running state.
      if (turnId && !closedTurn && !state.runningTurnId) state.runningTurnId = turnId;
      if (!closedTurn) this.recordStrongActivity(sessionId, state, turnId);
      if (!closedTurn) this.clearStatus(sessionId, state);
      // Reset the streaming accumulator when a new agentMessage item starts so
      // its deltas don't render prefixed with the previous message's full text
      // (multi-message turns occur after every tool round). Guards the case
      // where item/started was not observed before the first delta.
      if (state.currentMessageId !== params.itemId) {
        state.currentText = '';
      }
      state.currentMessageId = params.itemId;
      state.currentText += String(params.delta ?? '');
      const delta: MessageDelta = {
        messageId: params.itemId,
        type: 'text',
        delta: state.currentText,
        role: 'assistant',
      };
      for (const cb of this.deltaCallbacks) cb(sessionId, delta);
      return;
    }

    if (method === 'item/started' || method === 'item/completed') {
      const threadId = readParamThreadId(params);
      const sessionId = threadId ? this.threadToSession.get(threadId) : undefined;
      const state = sessionId ? this.sessions.get(sessionId) : null;
      if (!sessionId || !state) return;
      const turnId = readParamTurnId(params);
      if (state.cancelled) return;
      if (method === 'item/started') {
        this.clearIdleSettleTimer(state); // new item activity → turn active, cancel pending idle settle
      }
      const closedTurn = this.isClosedCodexTurn(state, turnId);

      const item = params.item as Record<string, any> | undefined;
      if (!item) return;
      if (closedTurn && item.type !== 'agentMessage') return;
      // NEVER drop a real provider item. If our turn bookkeeping lags the
      // app-server (turn/start's result carried no turn id, or this event's
      // turnId is shaped differently), adopt the event's turnId and process it
      // anyway rather than silently dropping tool calls / reasoning / final
      // assistant text. Closed/terminated turns may still surface final
      // assistant text, but they must never be adopted back into running state.
      if (turnId && !closedTurn && !state.runningTurnId) state.runningTurnId = turnId;
      if (!closedTurn) this.recordStrongActivity(sessionId, state, turnId);
      if (!closedTurn) this.trackCodexTurnItemActivity(sessionId, state, method, item);

      if (item.type === 'contextCompaction') {
        // `contextCompaction` also occurs automatically INSIDE an ordinary
        // model turn. Only a raw `/compact` send sets compactCommandInFlight.
        // An inline compaction must keep the parent turn/dispatch alive; treating
        // its item completion as a standalone transport completion produces a
        // false idle while Codex immediately continues with more tool calls.
        if (!state.runningCompact) state.compactCommandInFlight = false;
        state.runningCompact = true;
        state.compactObserved = true;
        this.clearCompactSettleTimer(state);
        state.runningTurnId = turnId ?? state.runningTurnId;
        if (method === 'item/completed') {
          if (this.hasActiveToolItems(state)) {
            state.deferredCompactSettleTurnId = turnId ?? state.runningTurnId ?? `${sessionId}:context-compaction`;
            return;
          }
          this.completeCompact(sessionId, state, turnId);
          return;
        }
        this.emitStatus(sessionId, state, {
          status: 'compacting',
          label: 'Compacting context...',
        });
        return;
      }

      if (item.type === 'reasoning') {
        this.emitStatus(sessionId, state, {
          status: 'thinking',
          label: 'Thinking...',
        });
        return;
      }

      if (!closedTurn) this.clearStatus(sessionId, state);

      const tool = toolFromItem(sessionId, item, method === 'item/started' ? 'started' : 'completed');
      if (tool) {
        this.emitTrackedProviderToolCall(sessionId, state, tool);
      }

      if (item.type === 'agentMessage') {
        if (method === 'item/completed') this.clearIdleSettleTimer(state);
        // A new agentMessage item begins: clear the accumulator so its stream
        // starts fresh (prevents the previous message's text from bleeding into
        // this message's bubble during streaming). item/completed for the SAME
        // id must NOT clear (currentMessageId already matches), so the final
        // text overwrite below is preserved.
        if (state.currentMessageId !== item.id) {
          state.currentText = '';
        }
        state.currentMessageId = item.id;
        if (method === 'item/completed' && typeof item.text === 'string') {
          const prior = state.currentText;
          state.currentText = item.text;
          if (!prior && item.text) {
            const delta: MessageDelta = {
              messageId: item.id,
              type: 'text',
              delta: item.text,
              role: 'assistant',
            };
            for (const cb of this.deltaCallbacks) cb(sessionId, delta);
          }        }
      }
      return;
    }

    if (method === 'turn/completed') {
      if (this.handleTrackedSubagentTurnCompleted(params)) return;
      const threadId = readParamThreadId(params);
      const sessionId = threadId ? this.threadToSession.get(threadId) : undefined;
      const state = sessionId ? this.sessions.get(sessionId) : null;
      if (!sessionId || !state) return;      const turn = isRecord(params.turn) ? params.turn : {};
      const status = turn.status;
      const turnId = readParamTurnId(params);
      // STOP can be followed by a new turn before the app-server emits the old
      // turn's interrupted notification. Some app-server versions omit the
      // turn id on that late notification. Applying an uncorrelated
      // `interrupted` event while the current session is NOT cancelling would
      // terminate the new turn, clear its rollout-settle poll, and mark the new
      // turn id closed. Codex core can then write final text + task_complete,
      // but the provider remains working until another manual STOP flushes the
      // cached answer. An interrupt for the current turn is always initiated by
      // cancel(), which sets state.cancelled first; otherwise an id-less
      // interrupt is stale and must not mutate current-turn ownership.
      if (
        status === 'interrupted'
        && !turnId
        && !state.cancelled
        && Boolean(state.runningTurnId || state.turnStartInFlight)
      ) {
        logger.warn({
          provider: this.id,
          sessionId,
          ...(state.imcodesSessionName ? { sessionName: state.imcodesSessionName } : {}),
          threadId: state.threadId,
          runningTurnId: state.runningTurnId,
        }, 'Codex SDK ignored an uncorrelated interrupted notification while a newer turn is active');
        return;
      }
      this.clearIdleSettleTimer(state); // explicit turn/completed supersedes any pending idle settle

      const terminalForTurnStartInFlight = Boolean(state.turnStartInFlight && turnId);
      if (terminalForTurnStartInFlight && turnId) state.terminalDuringTurnStartIds.add(turnId);
      if (turnId && this.isClosedCompactTurn(state, turnId) && !terminalForTurnStartInFlight && state.runningTurnId !== turnId) {
        return;
      }
      if (turnId && this.isClosedTurn(state, turnId) && !terminalForTurnStartInFlight && state.runningTurnId !== turnId) {
        return;
      }

      if (status === 'failed') {
        this.rememberTerminatedActiveTurn(state, turnId);
        this.clearActiveTurnLease(state);
        this.clearCancelTimer(state);
        this.clearCompactTimers(state);
        this.clearRawChecklistPollTimer(state);
        this.closeOpenProviderToolCalls(sessionId, state, 'error', 'errored', 'app_server_failed');
        this.clearStatus(sessionId, state);
        state.runningCompact = false;
        state.compactCommandInFlight = false;
        state.compactObserved = false;
        state.runningTurnId = undefined;
        state.turnStartInFlight = false;
        this.clearActiveItemEvidence(state);
        this.clearPendingSessionSystemTextUpdate(state);
        const error = this.normalizeError(turn.error?.message ?? 'Codex turn failed', turn.error);
        if (this.isCodexAuthError(error)) {
          void this.restartAppServerAfterAuthFailure('turn-failed', error).catch((restartErr) => {
            logger.warn({ provider: this.id, err: restartErr }, 'Codex app-server auth refresh restart failed');
          });
        }
        this.emitError(sessionId, error);
        return;
      }
      if (status === 'interrupted') {
        this.rememberTerminatedActiveTurn(state, turnId);
        this.clearActiveTurnLease(state);
        this.clearCancelTimer(state);
        this.clearCompactTimers(state);
        this.clearRawChecklistPollTimer(state);
        state.runningCompact = false;
        state.compactCommandInFlight = false;
        state.compactObserved = false;
        if (!state.runningTurnId && state.cancelled) {
          state.cancelled = false;
          this.clearActiveItemEvidence(state);
          this.clearPendingSessionSystemTextUpdate(state);
          this.closeOpenProviderToolCalls(sessionId, state, 'error', 'cancelled', 'user_cancelled');
          return;
        }
        this.closeOpenProviderToolCalls(sessionId, state, 'error', 'cancelled', 'provider_interrupted');
        this.clearStatus(sessionId, state);
        state.runningTurnId = undefined;
        state.turnStartInFlight = false;
        this.clearActiveItemEvidence(state);
        this.clearPendingSessionSystemTextUpdate(state);
        this.emitError(sessionId, this.makeError(PROVIDER_ERROR_CODES.CANCELLED, 'Codex turn cancelled', true));
        return;
      }

      if (state.runningCompact) {
        if (state.compactCommandInFlight) {
          this.completeCompact(sessionId, state, typeof turn.id === 'string' ? turn.id : undefined);
          return;
        }
        this.completeInlineContextCompaction(sessionId, state, turnId);
      }

      if (state.cancelled) {
        this.rememberTerminatedActiveTurn(state, turnId);
        this.clearActiveTurnLease(state);
        this.clearCancelTimer(state);
        this.clearRawChecklistPollTimer(state);
        this.closeOpenProviderToolCalls(sessionId, state, 'error', 'cancelled', 'user_cancelled');
        this.clearStatus(sessionId, state);
        state.runningTurnId = undefined;
        state.turnStartInFlight = false;
        state.currentMessageId = null;
        state.currentText = '';
        this.clearActiveItemEvidence(state);
        state.cancelled = false;
        this.clearPendingSessionSystemTextUpdate(state);
        this.emitError(sessionId, this.makeError(PROVIDER_ERROR_CODES.CANCELLED, 'Codex turn cancelled', true));
        return;
      }

      if (!state.currentText) {
        const completedAgentMessage = readTurnCompletedAgentMessage(turn);
        if (completedAgentMessage) {
          state.currentMessageId = completedAgentMessage.id;
          state.currentText = completedAgentMessage.text;
        }
      }

      await this.completeTurn(sessionId, state, turnId, 'app_server_completed');
      return;
    }
  }

  private async completeTurn(
    sessionId: string,
    state: CodexSdkSessionState,
    turnId?: string,
    terminalReason: ToolTerminalReason = 'app_server_completed',
  ): Promise<void> {
    this.clearIdleSettleTimer(state);
    this.clearCompactTimers(state);
    state.runningCompact = false;
    state.compactCommandInFlight = false;
    state.compactObserved = false;
    state.deferredCompactSettleTurnId = undefined;
    this.clearActiveTurnLease(state);
    this.clearCancelTimer(state);
    this.queueRawChecklistHistoryScan(sessionId, state);
    this.clearRawChecklistPollTimer(state);
    this.commitPendingSessionSystemTextUpdate(state, turnId);
    this.rememberCompletedTurn(state, turnId);
    this.closeOpenProviderToolCalls(sessionId, state, 'complete', 'succeeded', terminalReason);
    const messageId = state.currentMessageId ?? `${sessionId}:agent-message`;
    const currentText = state.currentText;
    const usage = state.lastUsage;
    const model = state.model;
    const resumeId = state.threadId;
    const generatedImageTracking = state.generatedImageTracking;
    const alreadyDetectedImagePaths = [...state.generatedImagePaths];
    state.runningTurnId = undefined;
    state.turnStartInFlight = false;
    this.clearActiveItemEvidence(state);
    state.generatedImageTracking = null;
    this.clearStatus(sessionId, state);
    const newlyDetectedImagePaths = generatedImageTracking
      ? await this.detectNewGeneratedImagePaths(generatedImageTracking)
      : [];
    const generatedImagePaths = [
      ...alreadyDetectedImagePaths,
      ...newlyDetectedImagePaths.filter((path) => !alreadyDetectedImagePaths.includes(path)),
    ];
    if (newlyDetectedImagePaths.length > 0) {
      logger.info({
        provider: this.id,
        sessionId,
        threadId: resumeId,
        generatedImagePaths: newlyDetectedImagePaths,
      }, 'Codex SDK detected generated image output paths');
    }
    const content = appendDetectedGeneratedImagePaths(currentText, generatedImagePaths);
    const completed: AgentMessage = {
      id: messageId,
      sessionId,
      kind: 'text',
      role: 'assistant',
      content,
      timestamp: Date.now(),
      status: 'complete',
      metadata: {
        ...(usage ? { usage } : {}),
        ...(model ? { model } : {}),
        ...(resumeId ? { resumeId } : {}),
      },
    };
    for (const cb of this.completeCallbacks) cb(sessionId, completed);
  }

  private rememberCompletedTurn(state: CodexSdkSessionState, turnId?: string): void {
    if (!turnId) return;
    state.completedTurnIds.add(turnId);
    if (state.completedTurnIds.size <= 50) return;
    const oldest = state.completedTurnIds.values().next().value;
    if (oldest) state.completedTurnIds.delete(oldest);
  }

  private sameHeartbeatGeneration(a: ActivityGenerationLike, b: ActivityGenerationLike): boolean {
    const left = normalizeActivityGeneration(a);
    const right = normalizeActivityGeneration(b);
    if (left === null && right === null) return true;
    return sameActivityGeneration(a, b);
  }

  private clearActiveTurnLease(state: CodexSdkSessionState): void {
    const lease = state.activeTurnLease;
    if (lease?.heartbeatTimer) clearTimeout(lease.heartbeatTimer);
    this.clearRolloutSettlePoll(state);
    this.disarmRolloutAuthorityWatch(state);
    state.activeTurnLease = undefined;
  }

  private refreshActiveTurnLease(
    sessionId: string,
    state: CodexSdkSessionState,
    options: { turnId?: string; strong: boolean; turnStartInFlight?: boolean },
  ): void {
    if (!state.threadId || state.runningCompact || state.cancelled) return;
    const now = Date.now();
    const current = state.activeTurnLease;
    const canReuse = current
      && current.localSessionKey === sessionId
      && current.threadId === state.threadId
      && this.sameHeartbeatGeneration(current.activityGeneration, state.runtimeActivityGeneration);
    const lease = canReuse
      ? current
      : {
          id: `${sessionId}:${state.threadId}:${this.nextActiveTurnLeaseId++}`,
          attemptId: 0,
          localSessionKey: sessionId,
          ...(state.imcodesSessionName ? { sessionName: state.imcodesSessionName } : {}),
          providerSessionId: state.routeId,
          threadId: state.threadId,
          activityGeneration: state.runtimeActivityGeneration,
          startedAtMs: now,
          lastStrongActivityAtMs: now,
          heartbeatFailureCount: 0,
          heartbeatInFlight: false,
        } satisfies CodexActiveTurnLease;
    if (!canReuse) state.activeTurnLease = lease;
    if (options.turnId && !this.isClosedCodexTurn(state, options.turnId)) {
      lease.turnId = options.turnId;
    }
    if (options.turnStartInFlight) {
      lease.turnStartInFlightAtMs = lease.turnStartInFlightAtMs ?? now;
    }
    if (options.strong) {
      lease.lastStrongActivityAtMs = now;
      lease.heartbeatFailureCount = 0;
    } else {
      lease.lastWeakActivityAtMs = now;
    }
    // ROLLOUT-FIRST: attach the authoritative real-time watch before the legacy
    // heartbeat/poll fallbacks. The watch settles a dropped/absent
    // `turn/completed` in ~0ms; the poll/heartbeat remain only as belt-and-suspenders.
    this.armRolloutAuthorityWatch(sessionId, state, options.turnId ?? lease.turnId ?? state.runningTurnId);
    this.scheduleHeartbeat(sessionId, state, lease);
    this.armRolloutSettlePoll(sessionId, state);
  }

  private recordStrongActivity(sessionId: string, state: CodexSdkSessionState, turnId?: string): void {
    if (state.cancelled || state.runningCompact) return;
    if (turnId && this.isClosedCodexTurn(state, turnId)) return;
    if (turnId && state.runningTurnId && turnId !== state.runningTurnId) return;
    this.refreshActiveTurnLease(sessionId, state, { turnId, strong: true });
  }

  private recordWeakActivity(sessionId: string, state: CodexSdkSessionState): void {
    if (!state.activeTurnLease) return;
    this.refreshActiveTurnLease(sessionId, state, { strong: false });
  }

  private isHeartbeatLeaseActive(sessionId: string, state: CodexSdkSessionState, lease: CodexActiveTurnLease): boolean {
    if (state.activeTurnLease !== lease) return false;
    if (!this.sessions.has(sessionId)) return false;
    if (lease.localSessionKey !== sessionId) return false;
    if (!state.threadId || lease.threadId !== state.threadId) return false;
    if (!this.sameHeartbeatGeneration(lease.activityGeneration, state.runtimeActivityGeneration)) return false;
    if (state.cancelled || state.runningCompact) return false;
    if (lease.turnId) {
      if (this.isClosedCodexTurn(state, lease.turnId)) return false;
      if (state.runningTurnId && state.runningTurnId !== lease.turnId) return false;
      if (!state.runningTurnId && !state.turnStartInFlight) return false;
    }
    return true;
  }

  private scheduleHeartbeat(
    sessionId: string,
    state: CodexSdkSessionState,
    lease: CodexActiveTurnLease,
    options: { minDelayMs?: number } = {},
  ): void {
    if (lease.heartbeatTimer) {
      clearTimeout(lease.heartbeatTimer);
      lease.heartbeatTimer = undefined;
    }
    if (!this.config || !this.child) return;
    if (!this.isHeartbeatLeaseActive(sessionId, state, lease)) return;
    const now = Date.now();
    const strongWait = Math.max(0, CODEX_TURN_HEARTBEAT_STRONG_GRACE_MS - (now - lease.lastStrongActivityAtMs));
    const intervalWait = lease.lastHeartbeatAtMs
      ? Math.max(0, CODEX_TURN_HEARTBEAT_INTERVAL_MS - (now - lease.lastHeartbeatAtMs))
      : 0;
    const backoffWait = lease.heartbeatFailureCount > 0
      ? Math.min(CODEX_TURN_HEARTBEAT_INTERVAL_MS * lease.heartbeatFailureCount, 60_000)
      : 0;
    const jitter = Math.floor(Math.random() * (CODEX_TURN_HEARTBEAT_JITTER_MS + 1));
    const delay = Math.max(strongWait, intervalWait, backoffWait, options.minDelayMs ?? 0) + jitter;
    lease.nextHeartbeatAtMs = now + delay;
    lease.heartbeatTimer = setTimeout(() => {
      lease.heartbeatTimer = undefined;
      void this.runHeartbeat(sessionId, lease.id, lease.attemptId);
    }, delay);
    lease.heartbeatTimer.unref?.();
  }

  private normalizeHeartbeatThreadSummary(raw: unknown, requestStartedAtMs: number, requestEndedAtMs: number): HeartbeatThreadSummary {
    if (!isRecord(raw)) {
      return { valid: false, malformedReason: 'malformed', threadStatus: 'unknown', turns: [], requestStartedAtMs, requestEndedAtMs, rawTurnCount: 0 };
    }
    const thread = isRecord(raw.thread) ? raw.thread : raw;
    const threadStatus = normalizeHeartbeatThreadStatus(readThreadStatus(thread));
    const rawTurnsValue = Array.isArray(thread.turns)
      ? thread.turns
      : Array.isArray(raw.turns)
        ? raw.turns
        : undefined;
    if (!rawTurnsValue) {
      return { valid: false, malformedReason: 'missing_turn_list', threadStatus, turns: [], requestStartedAtMs, requestEndedAtMs, rawTurnCount: 0 };
    }
    if (rawTurnsValue.length > CODEX_TURN_HEARTBEAT_MAX_TURNS) {
      return { valid: false, malformedReason: 'oversized', threadStatus, turns: [], requestStartedAtMs, requestEndedAtMs, rawTurnCount: rawTurnsValue.length };
    }
    const currentTurnIds = new Set<string>();
    const addCurrent = (value: unknown) => {
      if (typeof value === 'string' && value.trim()) currentTurnIds.add(value.trim());
    };
    addCurrent(thread.currentTurnId);
    addCurrent(thread.current_turn_id);
    addCurrent(raw.currentTurnId);
    addCurrent(raw.current_turn_id);
    const turns: HeartbeatTurnSummary[] = [];
    let explicitCurrentCount = 0;
    for (const entry of rawTurnsValue) {
      if (!isRecord(entry)) {
        return { valid: false, malformedReason: 'malformed', threadStatus, turns: [], requestStartedAtMs, requestEndedAtMs, rawTurnCount: rawTurnsValue.length };
      }
      const id = readParamTurnId(entry) ?? meaningfulString(entry.id);
      const status = normalizeHeartbeatTurnStatus(readTurnStatus(entry));
      const current = Boolean(entry.current || entry.isCurrent || entry.active || (id && currentTurnIds.has(id)));
      if (current) explicitCurrentCount += 1;
      turns.push({
        ...(id ? { id } : {}),
        status,
        current,
        ...(boundedTimestampMs(entry.startedAt ?? entry.started_at ?? entry.createdAt ?? entry.created_at) !== undefined ? { startedAtMs: boundedTimestampMs(entry.startedAt ?? entry.started_at ?? entry.createdAt ?? entry.created_at)! } : {}),
        ...(boundedTimestampMs(entry.updatedAt ?? entry.updated_at) !== undefined ? { updatedAtMs: boundedTimestampMs(entry.updatedAt ?? entry.updated_at)! } : {}),
        ...(boundedTimestampMs(entry.completedAt ?? entry.completed_at) !== undefined ? { completedAtMs: boundedTimestampMs(entry.completedAt ?? entry.completed_at)! } : {}),
      });
    }
    const activeTurnCount = turns.filter((turn) => turn.status === 'active').length;
    if (explicitCurrentCount > 1 || (explicitCurrentCount === 0 && activeTurnCount > 1)) {
      return { valid: false, malformedReason: 'ambiguous_current_turn', threadStatus, turns: [], requestStartedAtMs, requestEndedAtMs, rawTurnCount: rawTurnsValue.length };
    }
    return { valid: true, threadStatus, turns, requestStartedAtMs, requestEndedAtMs, rawTurnCount: rawTurnsValue.length };
  }

  private classifyHeartbeatSummary(
    sessionId: string,
    state: CodexSdkSessionState,
    lease: CodexActiveTurnLease,
    summary: HeartbeatThreadSummary,
  ): HeartbeatClassification {
    if (!this.isHeartbeatLeaseActive(sessionId, state, lease)) return { outcome: 'stale', classifier: 'stale' };
    if (lease.turnId && this.isClosedCodexTurn(state, lease.turnId)) return { outcome: 'inconclusive', classifier: 'local_terminal' };
    if (!summary.valid) return { outcome: 'inconclusive', classifier: summary.malformedReason ?? 'malformed' };
    if (summary.threadStatus === 'systemError') return { outcome: 'provider_error', classifier: 'system_error' };
    if (summary.threadStatus === 'notLoaded') return { outcome: 'lost', classifier: 'not_loaded_with_active_lease' };
    if (summary.threadStatus === 'active') return { outcome: 'active', classifier: 'active' };
    if (summary.threadStatus === 'unknown') return { outcome: 'inconclusive', classifier: 'unknown_status' };

    const activeOrCurrentTurns = summary.turns.filter((turn) => turn.current || turn.status === 'active');
    if (lease.turnId) {
      const matching = summary.turns.find((turn) => turn.id === lease.turnId);
      if (!matching) return { outcome: 'lost', classifier: 'idle_missing_turn' };
      if (matching.status === 'active' || matching.current) return { outcome: 'active', classifier: 'active' };
      if (matching.status === 'completed') return { outcome: 'terminal', classifier: 'idle_completed', status: 'completed', turnId: matching.id };
      if (matching.status === 'failed') return { outcome: 'terminal', classifier: 'idle_failed', status: 'failed', turnId: matching.id };
      if (matching.status === 'interrupted') return { outcome: 'terminal', classifier: 'idle_interrupted', status: 'interrupted', turnId: matching.id };
      return { outcome: 'inconclusive', classifier: 'unknown_status' };
    }

    if (Date.now() - lease.startedAtMs < CODEX_TURN_HEARTBEAT_START_GRACE_MS) {
      return { outcome: 'inconclusive', classifier: 'start_grace' };
    }
    if (activeOrCurrentTurns.length > 0) return { outcome: 'inconclusive', classifier: 'start_grace' };
    return { outcome: 'lost', classifier: 'start_grace_expired_no_current_turn' };
  }

  private async runHeartbeat(sessionId: string, leaseId: string, attemptId: number): Promise<void> {
    const state = this.sessions.get(sessionId);
    const lease = state?.activeTurnLease;
    if (!state || !lease || lease.id !== leaseId || lease.attemptId !== attemptId) return;
    if (!this.isHeartbeatLeaseActive(sessionId, state, lease)) return;
    if (lease.heartbeatInFlight) return;
    if (this.heartbeatInFlightCount >= CODEX_TURN_HEARTBEAT_PROVIDER_CAP) {
      this.scheduleHeartbeat(sessionId, state, lease, { minDelayMs: CODEX_TURN_HEARTBEAT_INTERVAL_MS });
      return;
    }
    lease.heartbeatInFlight = true;
    this.heartbeatInFlightCount += 1;
    const requestStartedAtMs = Date.now();
    lease.lastHeartbeatAtMs = requestStartedAtMs;
    try {
      const raw = await this.request('thread/read', {
        threadId: lease.threadId,
        includeTurns: true,
      }, CODEX_TURN_HEARTBEAT_TIMEOUT_MS);
      const requestEndedAtMs = Date.now();
      const latestState = this.sessions.get(sessionId);
      const latestLease = latestState?.activeTurnLease;
      if (!latestState || !latestLease || latestLease.id !== leaseId || latestLease.attemptId !== attemptId || !this.isHeartbeatLeaseActive(sessionId, latestState, latestLease)) return;
      latestLease.lastHeartbeatResponseAtMs = requestEndedAtMs;
      const summary = this.normalizeHeartbeatThreadSummary(raw, requestStartedAtMs, requestEndedAtMs);
      const classification = this.classifyHeartbeatSummary(sessionId, latestState, latestLease, summary);
      this.applyHeartbeatClassification(sessionId, latestState, latestLease, summary, classification);
    } catch {
      const latestState = this.sessions.get(sessionId);
      const latestLease = latestState?.activeTurnLease;
      if (latestState && latestLease && latestLease.id === leaseId && latestLease.attemptId === attemptId && this.isHeartbeatLeaseActive(sessionId, latestState, latestLease)) {
        latestLease.heartbeatFailureCount += 1;
        const classification: HeartbeatClassification = latestLease.heartbeatFailureCount >= CODEX_TURN_HEARTBEAT_FAILURE_THRESHOLD
          ? { outcome: 'degraded', classifier: 'timeout' }
          : { outcome: 'inconclusive', classifier: 'timeout' };
        this.applyHeartbeatClassification(sessionId, latestState, latestLease, {
          valid: true,
          threadStatus: 'unknown',
          turns: [],
          requestStartedAtMs,
          requestEndedAtMs: Date.now(),
          rawTurnCount: 0,
        }, classification);
      }
    } finally {
      const latestState = this.sessions.get(sessionId);
      const latestLease = latestState?.activeTurnLease;
      if (latestLease?.id === leaseId) latestLease.heartbeatInFlight = false;
      if (this.heartbeatInFlightCount > 0) this.heartbeatInFlightCount -= 1;
      if (latestState && latestLease?.id === leaseId && this.isHeartbeatLeaseActive(sessionId, latestState, latestLease)) {
        this.scheduleHeartbeat(sessionId, latestState, latestLease);
      }
    }
  }

  private applyHeartbeatClassification(
    sessionId: string,
    state: CodexSdkSessionState,
    lease: CodexActiveTurnLease,
    summary: HeartbeatThreadSummary,
    classification: HeartbeatClassification,
  ): void {
    if (classification.outcome === 'active') {
      lease.heartbeatFailureCount = 0;
      lease.lastAliveHeartbeatAtMs = summary.requestEndedAtMs;
      // Zombie-turn cross-check: the app-server says the turn is active, but if
      // the event stream has been silent past the rollout-confirm threshold,
      // consult codex core's own durable record. A `task_complete` in the
      // thread's rollout for this turn is authoritative completion evidence the
      // app-server failed to deliver — settle instead of waiting for the
      // daemon's 30-min last resort.
      this.maybeConfirmTaskCompleteFromRollout(sessionId, state, lease, summary.requestEndedAtMs);
      return;
    }
    if (classification.outcome === 'inconclusive' || classification.outcome === 'degraded' || classification.outcome === 'stale') {
      // Heartbeat could not prove liveness either way — the rollout record can
      // still prove completion (e.g. an unresponsive app-server whose core
      // already finished the turn).
      this.maybeConfirmTaskCompleteFromRollout(sessionId, state, lease, summary.requestEndedAtMs);
      return;
    }
    if (classification.outcome === 'provider_error') {
      this.clearActiveTurnLease(state);
      this.emitError(sessionId, this.makeError(PROVIDER_ERROR_CODES.PROVIDER_ERROR, 'Codex thread heartbeat reported systemError', false, {
        heartbeat: {
          classifier: classification.classifier,
          threadStatus: summary.threadStatus,
          requestDurationMs: Math.max(0, summary.requestEndedAtMs - summary.requestStartedAtMs),
        },
      }));
      return;
    }
    if (classification.outcome === 'terminal') {
      if (classification.status === 'completed') {
        // `thread/read` / thread-idle can be a false terminal signal from the
        // app-server while Codex core keeps producing output. Do not complete
        // from it directly. Treat it as a hint to consult the durable rollout;
        // only rollout task_complete or explicit turn/completed may end a turn.
        this.maybeConfirmTaskCompleteFromRollout(sessionId, state, lease, summary.requestEndedAtMs);
        return;
      }
      this.clearActiveTurnLease(state);
      this.rememberTerminatedActiveTurn(state, classification.turnId);
      state.runningTurnId = undefined;
      state.turnStartInFlight = false;
      this.clearActiveItemEvidence(state);
      this.closeOpenProviderToolCalls(sessionId, state, 'error');
      this.emitError(sessionId, this.makeError(
        classification.status === 'interrupted' ? PROVIDER_ERROR_CODES.CANCELLED : PROVIDER_ERROR_CODES.PROVIDER_ERROR,
        classification.status === 'interrupted' ? 'Codex turn cancelled' : 'Codex turn failed',
        classification.status === 'interrupted',
      ));
      return;
    }
    if (classification.outcome === 'lost') {
      this.emitSdkTurnLost(
        sessionId,
        state,
        lease,
        summary,
        classification.classifier as 'idle_missing_turn' | 'not_loaded_with_active_lease' | 'start_grace_expired_no_current_turn',
      );
    }
  }

  /**
   * Fire-and-forget zombie-turn cross-check. Only runs when the provider event
   * stream has been silent past CODEX_ROLLOUT_TASK_COMPLETE_SILENCE_MS while
   * the heartbeat cannot prove the turn terminal. Reads the thread's rollout
   * tail; a recorded `task_complete` for the running turn settles it as
   * completed. When the app-server missed the final delta too, the rollout's
   * `last_agent_message` is the durable source of truth for the final text.
   */
  private maybeConfirmTaskCompleteFromRollout(
    sessionId: string,
    state: CodexSdkSessionState,
    lease: CodexActiveTurnLease,
    nowMs: number,
  ): void {
    if (state.rolloutTaskCompleteCheckInFlight) return;
    if (!state.threadId) return;
    const turnId = state.runningTurnId ?? lease.turnId;
    if (!turnId) return;
    const silenceMs = nowMs - Math.max(lease.lastStrongActivityAtMs, lease.lastWeakActivityAtMs ?? 0);
    if (silenceMs < CODEX_ROLLOUT_TASK_COMPLETE_SILENCE_MS) return;
    state.rolloutTaskCompleteCheckInFlight = true;
    void this.confirmTaskCompleteFromRollout(sessionId, turnId, { leaseId: lease.id, attemptId: lease.attemptId })
      .catch((err) => {
        logger.debug({ provider: this.id, sessionId, threadId: state.threadId, turnId, err }, 'Codex rollout task_complete cross-check failed');
      })
      .finally(() => {
        const latest = this.sessions.get(sessionId);
        if (latest) latest.rolloutTaskCompleteCheckInFlight = false;
      });
  }

  private maybeConfirmCurrentTurnTaskCompleteFromRollout(
    sessionId: string,
    state: CodexSdkSessionState,
    turnId: string,
  ): void {
    if (state.rolloutTaskCompleteCheckInFlight) return;
    if (!state.threadId) return;
    state.rolloutTaskCompleteCheckInFlight = true;
    void this.confirmTaskCompleteFromRollout(sessionId, turnId)
      .catch((err) => {
        logger.debug({ provider: this.id, sessionId, threadId: state.threadId, turnId, err }, 'Codex rollout task_complete current-turn cross-check failed');
      })
      .finally(() => {
        const latest = this.sessions.get(sessionId);
        if (latest) latest.rolloutTaskCompleteCheckInFlight = false;
      });
  }

  private async confirmTaskCompleteFromRollout(
    sessionId: string,
    turnId: string,
    leaseGuard?: { leaseId: string; attemptId: number },
  ): Promise<void> {
    const state = this.sessions.get(sessionId);
    const lease = state?.activeTurnLease;
    if (!state) return;
    if (leaseGuard) {
      if (!lease || lease.id !== leaseGuard.leaseId || lease.attemptId !== leaseGuard.attemptId) return;
      if (!this.isHeartbeatLeaseActive(sessionId, state, lease)) return;
    } else {
      if (state.cancelled || state.runningCompact) return;
      if (state.runningTurnId !== turnId) return;
      if (this.isClosedCodexTurn(state, turnId)) return;
    }
    const evidence = await this.rolloutTailReportsTaskComplete(state, turnId);
    if (!evidence) return;
    // Re-validate after the await — the turn may have settled or rolled over
    // through the normal paths while the file read was in flight.
    const latestState = this.sessions.get(sessionId);
    const latestLease = latestState?.activeTurnLease;
    if (!latestState) return;
    if (leaseGuard) {
      if (!latestLease || latestLease.id !== leaseGuard.leaseId || latestLease.attemptId !== leaseGuard.attemptId) return;
      if (!this.isHeartbeatLeaseActive(sessionId, latestState, latestLease)) return;
      if ((latestState.runningTurnId ?? latestLease.turnId) !== turnId) return;
    } else {
      if (latestState.cancelled || latestState.runningCompact) return;
      if (latestState.runningTurnId !== turnId) return;
      if (this.isClosedCodexTurn(latestState, turnId)) return;
    }
    // A missing turn/start JSON-RPC response can leave startTurn() awaiting
    // forever even though turn/started notifications, final output, and the
    // core rollout task_complete all arrived. The rollout record is
    // authoritative terminal evidence for this exact turn. Remember it while
    // the start RPC is still pending so a very late response cannot assign the
    // completed turn back to running state.
    if (latestState.turnStartInFlight) {
      latestState.terminalDuringTurnStartIds.add(turnId);
    }
    if (evidence.lastAgentMessage && latestState.currentText !== evidence.lastAgentMessage) {
      latestState.currentMessageId = `${turnId}:rollout-task-complete`;
      latestState.currentText = evidence.lastAgentMessage;
    }
    logger.warn({
      provider: this.id,
      sessionId,
      ...(latestState.imcodesSessionName ? { sessionName: latestState.imcodesSessionName } : {}),
      threadId: latestState.threadId,
      turnId,
    }, 'Codex rollout records task_complete for the running turn but the app-server never closed it; settling the zombie turn from rollout evidence');
    await this.completeTurn(sessionId, latestState, turnId, 'rollout_task_complete');
  }

  /** Reads the tail of the thread's rollout file looking for a `task_complete` event for `turnId`. */
  private async rolloutTailReportsTaskComplete(state: CodexSdkSessionState, turnId: string): Promise<CodexRolloutTaskCompleteEvidence | null> {
    if (!state.threadId) return null;
    const providerEnv = (this.config?.env as Record<string, string> | undefined) ?? {};
    const env = { ...process.env, ...providerEnv, ...(state.env ?? {}) };
    const rolloutPath = state.rawChecklistRolloutPath ?? await findCodexRolloutPathByUuid(state.threadId, { env });
    if (!rolloutPath) return null;
    state.rawChecklistRolloutPath = rolloutPath;
    let fh: Awaited<ReturnType<typeof open>> | null = null;
    try {
      fh = await open(rolloutPath, 'r');
      const { size } = await fh.stat();
      const start = Math.max(0, size - CODEX_ROLLOUT_TASK_COMPLETE_TAIL_BYTES);
      if (start >= size) return null;
      const buffer = Buffer.allocUnsafe(size - start);
      const { bytesRead } = await fh.read(buffer, 0, buffer.length, start);
      if (bytesRead <= 0) return null;
      const text = buffer.subarray(0, bytesRead).toString('utf8');
      for (const line of text.split('\n')) {
        const trimmed = line.trim();
        // Cheap pre-filter before JSON.parse.
        if (!trimmed || !trimmed.includes('task_complete') || !trimmed.includes(turnId)) continue;
        try {
          const record = JSON.parse(trimmed) as Record<string, unknown>;
          const payload = isRecord(record.payload) ? record.payload : record;
          if (payload.type !== 'task_complete') continue;
          const completedTurnId = meaningfulString(payload.turn_id) ?? meaningfulString(payload.turnId);
          if (completedTurnId === turnId) {
            const lastAgentMessage = readRolloutTaskCompleteMessage(payload);
            return {
              turnId,
              ...(lastAgentMessage ? { lastAgentMessage } : {}),
            };
          }
        } catch {
          // Partial first line of the tail window or non-JSON noise — skip.
        }
      }
      return null;
    } catch (err) {
      logger.debug({ provider: this.id, threadId: state.threadId, rolloutPath, turnId, err }, 'Codex rollout task_complete tail read failed');
      return null;
    } finally {
      if (fh) await fh.close().catch(() => {});
    }
  }

  /**
   * Store-driven settle BACKSTOP (rollout is authority). When the persisted
   * session state still says a codex turn is running but the rollout tail proves
   * the turn already reached `task_complete`, settle it — WITHOUT requiring the
   * per-turn rollout settle timer/fs.watch to still be armed and WITHOUT
   * requiring `state.runningTurnId` to have been re-observed by a live
   * notification. This closes the gap where a lost `turn/completed`, a disarmed
   * rollout watch, or a `runningTurnId` desync leaves a finished turn "working"
   * forever — a state neither the 2s primary settle poll nor the 12-minute
   * active-turn watchdog can clear (both need a live, matching active turn).
   *
   * Called from the always-on daemon health poll, so it is independent of the
   * per-turn timers that can be torn down mid-flight. Returns true iff it
   * settled a turn. It fires for the exact tracked turn, or for the guarded
   * orphan shape where no newer dispatch/turn owns the runtime state. Both
   * paths drive the normal completion callback while protecting a different or
   * newly starting turn from stale rollout evidence.
   */
  async settleCompletedTurnFromRolloutBackstop(
    sessionId: string,
    opts: ProviderRolloutCompletionReconcileOptions = {},
  ): Promise<boolean> {
    const state = this.sessions.get(sessionId);
    if (!state) return false;
    if (state.cancelled || state.runningCompact) return false;
    const evidence = await this.rolloutTailReportsTerminalTaskComplete(state);
    if (!evidence) return false;
    // Never race the 2s primary settle path: only act once the terminal record
    // has been durable for the grace window.
    const minAge = opts.minCompleteAgeMs ?? CODEX_ROLLOUT_TERMINAL_BACKSTOP_MIN_AGE_MS;
    const now = opts.nowMs ?? Date.now();
    if (evidence.completedAtMs != null && now - evidence.completedAtMs < minAge) return false;
    // Re-read after the await; a newer turn may have genuinely started.
    const latest = this.sessions.get(sessionId);
    if (!latest || latest.cancelled || latest.runningCompact) return false;
    // Normally settle only while the provider still believes THIS exact turn is
    // in-flight. There is one additional zombie shape: app-server loses the
    // terminal notification after leaving tool items open, then clears the turn
    // identity. In that state the rollout tail is terminal, there is no current
    // turn/start to protect, and the only provider "work" is orphaned tool
    // evidence. Treat that evidence as stale and let completeTurn close it.
    //
    // Do NOT generalize this to every missing runningTurnId. During context
    // bootstrap a fresh dispatch can briefly have no provider turn identity, and
    // the rollout may still end with the previous turn's task_complete. An
    // active runtime dispatch is eligible only when it crossed provider.send(),
    // its generation still matches the provider generation, and orphaned tool
    // evidence remains. That distinguishes the observed same-generation zombie
    // from both a healthy pre-start window and a genuinely newer dispatch.
    const activeWork = this.getCurrentTurnWorkState(latest);
    const trackedTurnId = latest.runningTurnId ?? latest.activeTurnLease?.turnId;
    const turnStartInFlightAtMs = latest.activeTurnLease?.turnStartInFlightAtMs;
    const terminalBelongsToInFlightStart =
      latest.turnStartInFlight
      && latest.runningTurnId === undefined
      && turnStartInFlightAtMs != null
      && evidence.completedAtMs != null
      && evidence.completedAtMs >= turnStartInFlightAtMs;
    const providerStillRunningThisTurn =
      latest.runningTurnId === evidence.turnId
      || latest.activeTurnLease?.turnId === evidence.turnId
      || terminalBelongsToInFlightStart;
    const runtimeOwnsMatchingStartedDispatch =
      opts.runtimeHasActiveDispatchOwnership === true
      && opts.runtimeActiveDispatchProviderStarted === true
      && sameActivityGeneration(opts.runtimeActivityGeneration, latest.runtimeActivityGeneration);
    const terminalWithMatchingRuntimeDispatch =
      trackedTurnId === undefined
      && !latest.turnStartInFlight
      && activeWork.activeToolCount > 0
      && runtimeOwnsMatchingStartedDispatch;
    const terminalWithNoRuntimeDispatch =
      trackedTurnId === undefined
      && !latest.turnStartInFlight
      && opts.runtimeHasNoDispatchOwnership === true;
    if (
      !providerStillRunningThisTurn
      && !terminalWithMatchingRuntimeDispatch
      && !terminalWithNoRuntimeDispatch
    ) return false;
    if (this.isClosedCodexTurn(latest, evidence.turnId)) return false;
    if (evidence.lastAgentMessage && latest.currentText !== evidence.lastAgentMessage) {
      latest.currentMessageId = `${evidence.turnId}:rollout-backstop`;
      latest.currentText = evidence.lastAgentMessage;
    }
    logger.warn({
      provider: this.id,
      sessionId,
      ...(latest.imcodesSessionName ? { sessionName: latest.imcodesSessionName } : {}),
      threadId: latest.threadId,
      turnId: evidence.turnId,
      completedAtMs: evidence.completedAtMs,
      ageMs: evidence.completedAtMs != null ? Math.max(0, now - evidence.completedAtMs) : null,
      ...(terminalWithMatchingRuntimeDispatch
        ? {
            matchingRuntimeDispatchRecovered: true,
            orphanedToolCount: activeWork.activeToolCount,
            activityGeneration: normalizeActivityGeneration(latest.runtimeActivityGeneration),
          }
        : {}),
      ...(terminalWithNoRuntimeDispatch ? { noRuntimeDispatchRecovered: true } : {}),
    }, 'Codex store-driven backstop: rollout proves the running turn is complete; settling the zombie turn from rollout evidence');
    await this.completeTurn(sessionId, latest, evidence.turnId, 'rollout_task_complete');
    return true;
  }

  /**
   * Reads the tail of the thread's rollout looking for the LAST turn-lifecycle
   * marker. `task_started` (with no later completion) => a turn is in flight;
   * `task_complete` / `turn_aborted` => the turn is closed. Deriving terminality
   * from the last marker needs no in-memory turnId and is immune to a lost
   * `turn/completed` notification or a `runningTurnId` desync. Returns the
   * terminal `task_complete` evidence (with its wall-clock completion time) iff
   * the tail's last marker is a `task_complete`, else null.
   */
  private async rolloutTailReportsTerminalTaskComplete(state: CodexSdkSessionState): Promise<CodexRolloutTerminalEvidence | null> {
    if (!state.threadId) return null;
    const providerEnv = (this.config?.env as Record<string, string> | undefined) ?? {};
    const env = { ...process.env, ...providerEnv, ...(state.env ?? {}) };
    const rolloutPath = state.rawChecklistRolloutPath ?? await findCodexRolloutPathByUuid(state.threadId, { env });
    if (!rolloutPath) return null;
    state.rawChecklistRolloutPath = rolloutPath;
    let fh: Awaited<ReturnType<typeof open>> | null = null;
    try {
      fh = await open(rolloutPath, 'r');
      const { size } = await fh.stat();
      const start = Math.max(0, size - CODEX_ROLLOUT_TASK_COMPLETE_TAIL_BYTES);
      if (start >= size) return null;
      const buffer = Buffer.allocUnsafe(size - start);
      const { bytesRead } = await fh.read(buffer, 0, buffer.length, start);
      if (bytesRead <= 0) return null;
      const text = buffer.subarray(0, bytesRead).toString('utf8');
      let terminal: CodexRolloutTerminalEvidence | null = null;
      for (const line of text.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        // Cheap pre-filter before JSON.parse — only the three lifecycle markers matter.
        if (!trimmed.includes('task_started') && !trimmed.includes('task_complete') && !trimmed.includes('turn_aborted')) continue;
        let record: Record<string, unknown>;
        try { record = JSON.parse(trimmed) as Record<string, unknown>; } catch { continue; }
        const payload = isRecord(record.payload) ? record.payload : record;
        const type = payload.type;
        if (type === 'task_complete') {
          const turnId = meaningfulString(payload.turn_id) ?? meaningfulString(payload.turnId);
          if (!turnId) { terminal = null; continue; }
          const parsed = meaningfulString(record.timestamp) ? Date.parse(String(record.timestamp)) : NaN;
          const lastAgentMessage = readRolloutTaskCompleteMessage(payload as Record<string, any>);
          terminal = {
            turnId,
            ...(lastAgentMessage ? { lastAgentMessage } : {}),
            completedAtMs: Number.isFinite(parsed) ? parsed : null,
          };
        } else if (type === 'task_started' || type === 'turn_aborted') {
          // A start (or abort) AFTER the last task_complete means the completed
          // turn is no longer the tail state: a new turn is running, or the tail
          // ended on an abort with nothing to settle here. Either way, not terminal.
          terminal = null;
        }
      }
      return terminal;
    } catch (err) {
      logger.debug({ provider: this.id, threadId: state.threadId, rolloutPath, err }, 'Codex rollout terminal tail read failed');
      return null;
    } finally {
      if (fh) await fh.close().catch(() => {});
    }
  }

  private emitSdkTurnLost(
    sessionId: string,
    state: CodexSdkSessionState,
    lease: CodexActiveTurnLease,
    summary: HeartbeatThreadSummary,
    classifier: 'idle_missing_turn' | 'not_loaded_with_active_lease' | 'start_grace_expired_no_current_turn',
  ): void {
    const recoveryAttemptId = `${sessionId}:${normalizeActivityGeneration(lease.activityGeneration) ?? 'unknown'}:${lease.threadId}:${lease.turnId ?? 'no-turn'}:${lease.attemptId + 1}`;
    const details: SdkTurnLostRecoveryMetadata = {
      reason: SDK_TURN_LOST_REASON,
      localSessionKey: sessionId,
      ...(state.imcodesSessionName ? { sessionName: state.imcodesSessionName } : {}),
      providerId: this.id,
      providerSessionId: state.routeId,
      codexThreadId: lease.threadId,
      ...(lease.turnId ? { codexTurnId: lease.turnId } : {}),
      activityGeneration: lease.activityGeneration ?? state.runtimeActivityGeneration,
      leaseStartedAt: lease.startedAtMs,
      lastProviderEventAt: lease.lastStrongActivityAtMs,
      heartbeatStartedAt: summary.requestStartedAtMs,
      heartbeatCompletedAt: summary.requestEndedAtMs,
      heartbeatDurationMs: Math.max(0, summary.requestEndedAtMs - summary.requestStartedAtMs),
      silenceDurationMs: Math.max(0, summary.requestStartedAtMs - lease.lastStrongActivityAtMs),
      heartbeatFailureCount: lease.heartbeatFailureCount,
      classifier,
      recoveryAttemptId,
      correlationId: recoveryAttemptId,
      replayDecision: 'pending',
    };
    this.clearActiveTurnLease(state);
    this.rememberTerminatedActiveTurn(state, lease.turnId);
    state.runningTurnId = undefined;
    state.turnStartInFlight = false;
    this.clearActiveItemEvidence(state);
    this.closeOpenProviderToolCalls(sessionId, state, 'error');
    this.clearStatus(sessionId, state);
    this.emitError(sessionId, this.makeError(
      PROVIDER_ERROR_CODES.SDK_TURN_LOST,
      'Codex SDK active turn was lost by the app-server',
      true,
      details,
    ));
  }

  /** Clear pending idle hints when fresh activity or an explicit terminal event arrives. */
  private clearIdleSettleTimer(state: CodexSdkSessionState): void {
    if (state.idleSettleTimer) {
      clearTimeout(state.idleSettleTimer);
      state.idleSettleTimer = undefined;
    }
    state.idleSettleTurnId = undefined;
    state.deferredIdleSettleTurnId = undefined;
  }

  private hasActiveToolItems(state: CodexSdkSessionState): boolean {
    return state.activeToolItemIds.size > 0;
  }

  private maybeArmDeferredIdleSettle(sessionId: string, state: CodexSdkSessionState): void {
    const turnId = state.deferredIdleSettleTurnId;
    if (!turnId || this.hasActiveToolItems(state)) return;
    if (
      (!state.runningTurnId || state.runningTurnId === turnId)
      && !state.cancelled
      && !state.turnStartInFlight
      && !this.isClosedCodexTurn(state, turnId)
    ) {
      this.maybeConfirmCurrentTurnTaskCompleteFromRollout(sessionId, state, turnId);
      this.armRolloutSettlePoll(sessionId, state);
      return;
    }
    state.deferredIdleSettleTurnId = undefined;
  }

  private maybeCompleteDeferredCompact(sessionId: string, state: CodexSdkSessionState): void {
    const turnId = state.deferredCompactSettleTurnId;
    if (!turnId || this.hasActiveToolItems(state)) return;
    state.deferredCompactSettleTurnId = undefined;
    this.completeCompact(sessionId, state, turnId);
  }

  private rememberTerminatedTurn(state: CodexSdkSessionState, turnId?: string): void {
    if (!turnId) return;
    state.terminatedTurnIds.add(turnId);
    if (state.terminatedTurnIds.size <= TERMINATED_TURN_CACHE_LIMIT) return;
    const oldest = state.terminatedTurnIds.values().next().value;
    if (oldest) state.terminatedTurnIds.delete(oldest);
  }

  private isClosedTurn(state: CodexSdkSessionState, turnId?: string): boolean {
    return Boolean(turnId && (state.completedTurnIds.has(turnId) || state.terminatedTurnIds.has(turnId)));
  }

  private isClosedCompactTurn(state: CodexSdkSessionState, turnId?: string): boolean {
    return Boolean(turnId && (
      state.completedCompactTurnIds.has(turnId)
      || state.terminatedCompactTurnIds.has(turnId)
    ));
  }

  private isClosedCodexTurn(state: CodexSdkSessionState, turnId?: string): boolean {
    return this.isClosedTurn(state, turnId) || this.isClosedCompactTurn(state, turnId);
  }

  private request(method: string, params: Record<string, any>, timeoutMs?: number): Promise<any> {
    if (!this.child?.stdin.writable) {
      return Promise.reject(new Error('Codex app-server stdin is not writable'));
    }
    const id = this.nextRequestId++;
    const payload = JSON.stringify({ id, method, params });
    return new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      if (timeoutMs && timeoutMs > 0 && Number.isFinite(timeoutMs)) {
        timer = setTimeout(() => {
          if (!this.pendingRequests.delete(id)) return;
          reject(new Error(`Codex app-server request ${method} did not settle within ${Math.round(timeoutMs)}ms`));
        }, timeoutMs);
        timer.unref?.();
      }
      this.pendingRequests.set(id, {
        resolve: (value) => {
          if (timer) clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          if (timer) clearTimeout(timer);
          reject(error);
        },
      });
      this.child!.stdin.write(`${payload}\n`);
    });
  }

  private completeInlineContextCompaction(
    sessionId: string,
    state: CodexSdkSessionState,
    turnId?: string,
  ): void {
    this.clearCompactTimers(state);
    this.clearStatus(sessionId, state);
    state.runningCompact = false;
    state.compactCommandInFlight = false;
    state.deferredCompactSettleTurnId = undefined;
    state.compactObserved = false;
    for (const itemId of state.activeCompactionItemIds) state.activeItemIds.delete(itemId);
    state.activeCompactionItemIds.clear();

    // Auto-compaction is an item INSIDE the current model turn, not a transport
    // turn completion. Keep all parent turn identity/text/tool ownership intact
    // and re-arm terminal authority now that the inline compact phase is over.
    const activeTurnId = turnId ?? state.runningTurnId;
    if (!state.cancelled && activeTurnId) {
      state.runningTurnId = activeTurnId;
      this.recordStrongActivity(sessionId, state, activeTurnId);
      this.armRawChecklistPolling(sessionId, state);
      this.armChildSubagentRolloutPolling(sessionId, state);
    }
  }

  private completeCompact(sessionId: string, state: CodexSdkSessionState, turnId?: string): void {
    if (!state.compactCommandInFlight) {
      this.completeInlineContextCompaction(sessionId, state, turnId);
      return;
    }
    this.clearCancelTimer(state);
    this.clearActiveTurnLease(state);
    this.clearCompactTimers(state);    this.clearRawChecklistPollTimer(state);
    this.clearStatus(sessionId, state);
    state.runningCompact = false;
    state.compactCommandInFlight = false;
    state.deferredCompactSettleTurnId = undefined;
    this.clearActiveItemEvidence(state);
    state.runningTurnId = undefined;
    state.turnStartInFlight = false;
    state.compactObserved = false;
    state.generatedImageTracking = null;
    this.rememberCompletedCompactTurn(state, turnId);
    this.clearPendingSessionSystemTextUpdate(state);
    state.currentMessageId = null;
    state.currentText = '';
    const completed: AgentMessage = {
      id: turnId ? `${turnId}:context-compaction` : `${sessionId}:context-compaction:${Date.now()}`,
      sessionId,
      kind: 'system',
      role: 'system',
      content: 'Codex context compacted.',
      timestamp: Date.now(),
      status: 'complete',
      metadata: {
        provider: this.id,
        event: 'thread/compacted',
        [SESSION_CONTROL_METADATA_COMMAND_FIELD]: 'compact',
        ...(state.threadId ? { resumeId: state.threadId } : {}),
        ...(turnId ? { turnId } : {}),
      },
    };
    for (const cb of this.completeCallbacks) cb(sessionId, completed);
  }

  private rememberCompletedCompactTurn(state: CodexSdkSessionState, turnId?: string): void {
    if (!turnId) return;
    state.completedCompactTurnIds.add(turnId);
    if (state.completedCompactTurnIds.size <= 20) return;
    const oldest = state.completedCompactTurnIds.values().next().value;
    if (oldest) state.completedCompactTurnIds.delete(oldest);
  }

  private rememberTerminatedCompactTurn(state: CodexSdkSessionState, turnId?: string): void {
    if (!turnId) return;
    state.terminatedCompactTurnIds.add(turnId);
    if (state.terminatedCompactTurnIds.size <= TERMINATED_COMPACT_TURN_CACHE_LIMIT) return;
    const oldest = state.terminatedCompactTurnIds.values().next().value;
    if (oldest) state.terminatedCompactTurnIds.delete(oldest);
  }

  private rememberTerminatedActiveTurn(state: CodexSdkSessionState, turnId?: string): void {
    const resolvedTurnId = turnId ?? state.runningTurnId;
    if (!resolvedTurnId) return;
    if (state.runningCompact) {
      this.rememberTerminatedCompactTurn(state, resolvedTurnId);
      return;
    }
    this.rememberTerminatedTurn(state, resolvedTurnId);
  }

  /**
   * Expose the `account/rateLimits/read` RPC over the already-connected
   * app-server so callers (e.g. the daemon's rate-limit probe) can reuse
   * this singleton instead of spawning a one-shot codex child. Returns
   * `undefined` if the provider isn't connected or the RPC doesn't include
   * a `rateLimits` payload — the caller then falls back to a fresh spawn.
   *
   * Keeping this method on the provider (rather than exposing `request`
   * publicly) keeps the RPC surface area explicit: future reuse targets
   * (usage summary, plan type, etc.) should each get their own public
   * wrapper.
   */
  async readRateLimits(): Promise<Record<string, unknown> | undefined> {
    if (!this.child || !this.child.stdin.writable) return undefined;
    try {
      await this.refreshAppServerForLatestAuth('rate-limits').catch(() => {});
      const result = await this.request('account/rateLimits/read', {});
      if (result && typeof result === 'object' && 'rateLimits' in (result as Record<string, unknown>)) {
        const payload = (result as Record<string, unknown>).rateLimits;
        return payload && typeof payload === 'object' ? payload as Record<string, unknown> : undefined;
      }
      return undefined;
    } catch {
      return undefined;
    }
  }

  async listModels(force?: boolean): Promise<ProviderModelList> {
    try {
      const { getCodexRuntimeConfig } = await import('../codex-runtime-config.js');
      const cfg = await getCodexRuntimeConfig(force ?? false);
      return {
        models: (cfg.models ?? []).map((m) => ({
          id: m.id,
          ...(m.name ? { name: m.name } : {}),
          ...(m.supportsReasoningEffort ? { supportsReasoningEffort: true } : {}),
        })),
        ...(cfg.defaultModel ? { defaultModel: cfg.defaultModel } : {}),
        ...(typeof cfg.isAuthenticated === 'boolean' ? { isAuthenticated: cfg.isAuthenticated } : {}),
        ...(cfg.probeError ? { error: cfg.probeError } : {}),
      };
    } catch (err) {
      return { models: [], error: err instanceof Error ? err.message : String(err) };
    }
  }

  async readModelList(): Promise<CodexDiscoveredModel[] | undefined> {
    if (!this.child || !this.child.stdin.writable) return undefined;
    try {
      await this.refreshAppServerForLatestAuth('model-list').catch(() => {});
      const discovered: CodexDiscoveredModel[] = [];
      const seen = new Set<string>();
      let cursor: string | null = null;
      do {
        const result = await this.request('model/list', {
          includeHidden: false,
          limit: 100,
          ...(cursor ? { cursor } : {}),
        });
        const data = Array.isArray(result?.data) ? result.data : [];
        for (const entry of data) {
          if (!entry || typeof entry !== 'object') continue;
          const modelId = typeof entry.model === 'string' && entry.model.trim()
            ? entry.model.trim()
            : typeof entry.id === 'string' && entry.id.trim()
              ? entry.id.trim()
              : '';
          if (!modelId || seen.has(modelId)) continue;
          seen.add(modelId);
          discovered.push({
            id: modelId,
            ...(typeof entry.displayName === 'string' && entry.displayName.trim()
              ? { name: entry.displayName.trim() }
              : {}),
            ...(Array.isArray(entry.supportedReasoningEfforts) && entry.supportedReasoningEfforts.length > 0
              ? { supportsReasoningEffort: true }
              : {}),
            ...(entry.isDefault === true ? { isDefault: true } : {}),
          });
        }
        cursor = typeof result?.nextCursor === 'string' && result.nextCursor.trim()
          ? result.nextCursor.trim()
          : null;
      } while (cursor);
      return discovered;
    } catch {
      return undefined;
    }
  }

  private notify(method: string, params: Record<string, any>): void {
    if (!this.child?.stdin.writable) return;
    this.child.stdin.write(`${JSON.stringify({ method, params })}\n`);
  }

  private rejectPending(err: Error): void {
    for (const pending of this.pendingRequests.values()) pending.reject(err);
    this.pendingRequests.clear();
  }

  private emitSessionInfo(sessionId: string, info: SessionInfoUpdate): void {
    for (const cb of this.sessionInfoCallbacks) cb(sessionId, info);
  }

  private emitStatus(sessionId: string, state: CodexSdkSessionState, status: ProviderStatusUpdate): void {
    const signature = JSON.stringify({
      status: status.status,
      label: status.label ?? null,
    });
    if (state.lastStatusSignature === signature) return;
    state.lastStatusSignature = signature;
    for (const cb of this.statusCallbacks) cb(sessionId, status);
  }

  private clearStatus(sessionId: string, state: CodexSdkSessionState): void {
    this.emitStatus(sessionId, state, { status: null, label: null });
  }

  private clearPendingSessionSystemTextUpdate(state: CodexSdkSessionState): void {
    state.pendingSessionSystemTextUpdate = undefined;
    state.pendingSessionSystemTextUpdateTurnId = undefined;
  }

  private emitTrackedProviderToolCall(sessionId: string, state: CodexSdkSessionState, tool: ToolCallEvent): void {
    const dedupedTool = this.dedupeCustomToolLifecycle(state, tool);
    if (!dedupedTool) return;
    tool = dedupedTool;
    const backgroundedSubagent = isBackgroundedSdkSubagentTool(tool);
    if (tool.status === 'running' && !backgroundedSubagent) {
      state.openProviderToolCalls.set(tool.id, tool);
    } else {
      state.openProviderToolCalls.delete(tool.id);
    }
    for (const cb of this.toolCallCallbacks) cb(sessionId, tool);

    if (tool.status !== 'running' && this.isCodexCollabSdkTool(tool)) {
      this.closeOpenCodexCollabProviderToolCalls(
        sessionId,
        state,
        tool.status === 'complete' ? 'complete' : 'error',
        tool.terminalStatus ?? (tool.status === 'complete' ? 'succeeded' : 'errored'),
        tool.terminalReason ?? (tool.status === 'complete' ? 'provider_result' : 'provider_error'),
        tool.id,
      );
    }
  }

  private dedupeCustomToolLifecycle(state: CodexSdkSessionState, tool: ToolCallEvent): ToolCallEvent | null {
    const detail = isRecord(tool.detail) ? tool.detail : undefined;
    if (detail?.kind !== 'customToolCall') return tool;
    const meta = isRecord(detail.meta) ? detail.meta : undefined;
    const callId = meaningfulString(meta?.callId) ?? meaningfulString(tool.id);
    if (!callId) return tool;

    const priorLifecycle = state.customToolLifecycleByCallId.get(callId);
    if (priorLifecycle?.terminal) return null;
    const prior = priorLifecycle?.tool;
    const priorDetail = isRecord(prior?.detail) ? prior.detail : undefined;
    const priorMeta = isRecord(priorDetail?.meta) ? priorDetail.meta : undefined;
    const mergedDetail = {
      ...(priorDetail ?? {}),
      ...detail,
      kind: 'customToolCall',
      ...(tool.input !== undefined || prior?.input !== undefined ? { input: tool.input ?? prior?.input } : {}),
      meta: { ...priorMeta, ...meta, callId },
    };
    const normalizedTool: ToolCallEvent = {
      ...(prior ?? {}),
      ...tool,
      id: callId,
      name: tool.name || prior?.name || 'custom_tool',
      ...(tool.input !== undefined || prior?.input !== undefined ? { input: tool.input ?? prior?.input } : {}),
      detail: mergedDetail,
    };

    // The same logical start can arrive once as a typed item and once as a raw
    // response item. Retain whichever snapshot is richer, but emit only once.
    if (tool.status === 'running' && priorLifecycle) {
      state.customToolLifecycleByCallId.set(callId, { tool: normalizedTool, terminal: false });
      state.openProviderToolCalls.set(callId, normalizedTool);
      return null;
    }

    state.customToolLifecycleByCallId.set(callId, {
      tool: normalizedTool,
      terminal: tool.status !== 'running',
    });
    this.pruneCustomToolLifecycleCache(state);
    return normalizedTool;
  }

  private pruneCustomToolLifecycleCache(state: CodexSdkSessionState): void {
    if (state.customToolLifecycleByCallId.size <= CODEX_CUSTOM_TOOL_LIFECYCLE_CACHE_LIMIT) return;
    for (const [callId, lifecycle] of state.customToolLifecycleByCallId) {
      if (!lifecycle.terminal) continue;
      state.customToolLifecycleByCallId.delete(callId);
      if (state.customToolLifecycleByCallId.size <= CODEX_CUSTOM_TOOL_LIFECYCLE_CACHE_LIMIT) return;
    }
  }

  private isCodexCollabSdkTool(tool: ToolCallEvent): boolean {
    const detail = isRecord(tool.detail) ? tool.detail : undefined;
    const meta = isRecord(detail?.meta) ? detail.meta : undefined;
    return detail?.kind === SDK_SUBAGENT_DETAIL_KIND
      && meta?.provider === SDK_SUBAGENT_PROVIDERS.CODEX_SDK
      && meta?.providerKind === SDK_SUBAGENT_PROVIDER_KINDS.CODEX_COLLAB_AGENT;
  }

  private codexLifecycleItemKindForTool(tool: ToolCallEvent): CodexLifecycleItemKind {
    if (this.isCodexCollabSdkTool(tool)) return 'codex_collaboration';
    if (tool.name === 'WebSearch' || String(tool.detail?.kind ?? '').toLowerCase() === 'websearch') return 'web_search';
    if (String(tool.detail?.kind ?? '') === SDK_SUBAGENT_DETAIL_KIND) return 'sdk_subagent';
    return 'provider_tool_like';
  }

  private closeOpenCodexCollabProviderToolCalls(
    sessionId: string,
    state: CodexSdkSessionState,
    status: Exclude<ToolCallEvent['status'], 'running'>,
    terminalStatus: ToolTerminalStatus = status === 'complete' ? 'succeeded' : 'errored',
    terminalReason: ToolTerminalReason = status === 'complete' ? 'provider_result' : 'provider_error',
    exceptToolId?: string,
  ): void {
    if (state.openProviderToolCalls.size === 0) return;
    for (const [toolId, runningTool] of [...state.openProviderToolCalls]) {
      if (toolId === exceptToolId) continue;
      if (!this.isCodexCollabSdkTool(runningTool)) continue;
      this.closeOneOpenProviderToolCall(sessionId, state, toolId, runningTool, status, terminalStatus, terminalReason);
    }
  }

  private closeOpenProviderToolCalls(
    sessionId: string,
    state: CodexSdkSessionState,
    status: Exclude<ToolCallEvent['status'], 'running'>,
    terminalStatus: ToolTerminalStatus = status === 'complete' ? 'succeeded' : 'errored',
    terminalReason: ToolTerminalReason = status === 'complete' ? 'provider_result' : 'provider_error',
  ): void {
    if (state.openProviderToolCalls.size === 0) return;
    for (const [toolId, runningTool] of [...state.openProviderToolCalls]) {
      this.closeOneOpenProviderToolCall(sessionId, state, toolId, runningTool, status, terminalStatus, terminalReason);
    }
  }

  private closeOneOpenProviderToolCall(
    sessionId: string,
    state: CodexSdkSessionState,
    toolId: string,
    runningTool: ToolCallEvent,
    status: Exclude<ToolCallEvent['status'], 'running'>,
    terminalStatus: ToolTerminalStatus,
    terminalReason: ToolTerminalReason,
  ): void {
    const output = runningTool.output !== undefined ? runningTool.output : status === 'complete' ? 'completed' : 'failed';
    const detail = isRecord(runningTool.detail) && runningTool.detail.kind === SDK_SUBAGENT_DETAIL_KIND && isRecord(runningTool.detail.meta)
      ? buildSdkSubagentSafeDetail({
        ...(runningTool.detail as SdkSubagentDetail),
        output,
        meta: {
          ...(runningTool.detail.meta as SdkSubagentDetail['meta']),
          normalizedStatus: status === 'complete' ? SDK_SUBAGENT_STATUS.COMPLETE : SDK_SUBAGENT_STATUS.ERROR,
          rawStatus: status === 'complete' ? 'completed' : 'error',
          active: false,
          terminal: true,
          ...((runningTool.detail.meta as SdkSubagentDetail['meta']).providerKind === SDK_SUBAGENT_PROVIDER_KINDS.CODEX_COLLAB_AGENT
            ? { runningChildCount: 0 }
            : {}),
        },
      } satisfies SdkSubagentDetail, { allowRaw: false })
      : runningTool.detail;
    const terminalSource = (
      terminalReason === 'thread_idle_settle'
      || terminalReason === 'generation_rollover'
      || terminalReason === 'user_cancelled'
    ) ? 'daemon_synthetic' : 'app_server_jsonrpc';
    const metadata = buildCodexLifecycleTerminalMetadata({
      sessionId,
      terminalStatus,
      terminalReason,
      synthetic: true,
      source: terminalSource,
      decisionReason: terminalReason,
      ...(state.runtimeActivityGeneration ? { activityGeneration: state.runtimeActivityGeneration } : {}),
      toolCallId: toolId,
      ...(state.runningTurnId ? { turnId: state.runningTurnId } : {}),
      itemKind: this.codexLifecycleItemKindForTool(runningTool),
    });
    const terminalTool: ToolCallEvent = {
      ...runningTool,
      id: toolId,
      status,
      output,
      terminalStatus: metadata.terminalStatus,
      terminalReason: metadata.terminalReason,
      terminalSynthetic: metadata.synthetic,
      terminalSource: metadata.source,
      terminalDecisionReason: metadata.decisionReason,
      terminalIdempotencyKey: metadata.idempotencyKey,
      ...(state.runtimeActivityGeneration ? { activityGeneration: state.runtimeActivityGeneration } : {}),
      ...(state.runningTurnId ? { turnId: state.runningTurnId } : {}),
      lifecycleItemKind: metadata.itemKind,
      ...(detail ? { detail } : {}),
    };
    state.openProviderToolCalls.delete(toolId);
    const customDetail = isRecord(terminalTool.detail) ? terminalTool.detail : undefined;
    const customMeta = isRecord(customDetail?.meta) ? customDetail.meta : undefined;
    if (customDetail?.kind === 'customToolCall') {
      const callId = meaningfulString(customMeta?.callId) ?? meaningfulString(toolId);
      if (callId) {
        state.customToolLifecycleByCallId.set(callId, { tool: terminalTool, terminal: true });
        this.pruneCustomToolLifecycleCache(state);
      }
    }
    for (const cb of this.toolCallCallbacks) cb(sessionId, terminalTool);
  }

  private commitPendingSessionSystemTextUpdate(state: CodexSdkSessionState, turnId?: string): void {
    if (!state.pendingSessionSystemTextUpdate) return;
    if (state.pendingSessionSystemTextUpdateTurnId && turnId && state.pendingSessionSystemTextUpdateTurnId !== turnId) {
      this.clearPendingSessionSystemTextUpdate(state);
      return;
    }
    state.lastInjectedSessionSystemText = state.pendingSessionSystemTextUpdate;
    this.clearPendingSessionSystemTextUpdate(state);
  }

  private cancelCompactLocally(sessionId: string, state: CodexSdkSessionState): void {
    this.clearCancelTimer(state);
    this.clearActiveTurnLease(state);
    this.clearCompactTimers(state);
    this.clearRawChecklistPollTimer(state);    this.clearStatus(sessionId, state);
    this.rememberTerminatedCompactTurn(state, state.runningTurnId);
    state.runningCompact = false;
    state.compactCommandInFlight = false;
    state.runningTurnId = undefined;
    state.turnStartInFlight = false;
    state.compactObserved = false;
    this.clearPendingSessionSystemTextUpdate(state);
    state.currentMessageId = null;
    state.currentText = '';
    this.clearActiveItemEvidence(state);
    this.closeOpenProviderToolCalls(sessionId, state, 'error');
    this.emitError(sessionId, this.makeError(PROVIDER_ERROR_CODES.CANCELLED, 'Codex compact cancelled', true));
  }

  private emitError(sessionId: string, error: ProviderError): void {
    for (const cb of this.errorCallbacks) cb(sessionId, error);
  }

  private resolveBinaryPath(config: ProviderConfig | null): string {
    return typeof config?.binaryPath === 'string' && config.binaryPath.trim() ? config.binaryPath : CODEX_BIN;
  }

  private normalizeError(err: unknown, details?: unknown): ProviderError {
    const message = errorMessage(err);
    if (/ENOENT|not found|spawn .*codex/i.test(message)) {
      return this.makeError(PROVIDER_ERROR_CODES.PROVIDER_NOT_FOUND, `Codex binary not found: ${message}`, false, err);
    }
    if (isCodexAuthFailureMessage(message)) {
      return this.makeError(PROVIDER_ERROR_CODES.AUTH_FAILED, message, false, details ?? err);
    }
    if (isCodexThreadHistoryUnreadableError(err) || (/resume|thread/i.test(message) && /not found|invalid|unknown/i.test(message))) {
      return this.makeError(PROVIDER_ERROR_CODES.SESSION_NOT_FOUND, message, true, err);
    }
    return this.makeError(PROVIDER_ERROR_CODES.PROVIDER_ERROR, message, false, err);
  }

  private isCodexAuthError(error: ProviderError): boolean {
    return error.code === PROVIDER_ERROR_CODES.AUTH_FAILED || isCodexAuthFailureMessage(error.message);
  }

  private makeError(code: string, message: string, recoverable: boolean, details?: unknown): ProviderError {
    return { code, message, recoverable, ...(details !== undefined ? { details } : {}) };
  }

  private clearCancelTimer(state: CodexSdkSessionState): void {
    if (!state.cancelTimer) return;
    clearTimeout(state.cancelTimer);
    state.cancelTimer = null;
  }

  private trackCodexTurnItemActivity(
    sessionId: string,
    state: CodexSdkSessionState,
    method: 'item/started' | 'item/completed',
    item: Record<string, any>,
  ): void {
    const itemId = meaningfulString(item.id);
    if (itemId) {
      if (method === 'item/started') {
        state.activeItemIds.add(itemId);
        if (CODEX_TOOL_LIKE_ITEM_TYPES.has(String(item.type))) state.activeToolItemIds.add(itemId);
        if (item.type === 'contextCompaction') state.activeCompactionItemIds.add(itemId);
      } else {
        state.activeItemIds.delete(itemId);
        state.activeToolItemIds.delete(itemId);
        state.activeCompactionItemIds.delete(itemId);
      }
    }
    if (method === 'item/completed') {
      this.maybeCompleteDeferredCompact(sessionId, state);
      this.maybeArmDeferredIdleSettle(sessionId, state);
    }
  }

  private armCompactNoSignalSettle(sessionId: string, state: CodexSdkSessionState, turnId?: string): void {
    this.clearCompactSettleTimer(state);
    state.compactSettleTimer = setTimeout(() => {
      if (!this.sessions.has(sessionId)) return;
      if (!state.runningCompact || state.compactObserved) return;
      this.completeCompact(sessionId, state, turnId);
    }, COMPACT_NO_SIGNAL_SETTLE_MS);
    state.compactSettleTimer.unref?.();
  }

  private armCompactHardTimeout(sessionId: string, state: CodexSdkSessionState): void {
    this.clearCompactHardTimer(state);
    state.compactHardTimer = setTimeout(() => {
      if (!this.sessions.has(sessionId)) return;
      if (!state.runningCompact) return;
      if (!state.compactCommandInFlight) {
        logger.warn({
          provider: this.id,
          sessionId,
          ...(state.imcodesSessionName ? { sessionName: state.imcodesSessionName } : {}),
          threadId: state.threadId,
          turnId: state.runningTurnId,
        }, 'Codex inline context compaction exceeded compact timeout; resuming parent turn without emitting completion');
        this.completeInlineContextCompaction(sessionId, state, state.runningTurnId);
        return;
      }
      this.clearCompactTimers(state);      this.clearStatus(sessionId, state);
      this.rememberTerminatedCompactTurn(state, state.runningTurnId);
      state.runningCompact = false;
      state.compactCommandInFlight = false;
      state.runningTurnId = undefined;
      state.turnStartInFlight = false;
      state.compactObserved = false;
      this.clearPendingSessionSystemTextUpdate(state);
      state.currentMessageId = null;
      state.currentText = '';
      this.clearActiveItemEvidence(state);
      this.closeOpenProviderToolCalls(sessionId, state, 'error');
      this.emitError(sessionId, this.makeError(
        PROVIDER_ERROR_CODES.PROVIDER_ERROR,
        `Codex SDK compact did not complete within ${Math.round(COMPACT_HARD_TIMEOUT_MS)}ms`,
        true,
      ));
    }, COMPACT_HARD_TIMEOUT_MS);
    state.compactHardTimer.unref?.();
  }

  private clearCompactSettleTimer(state: CodexSdkSessionState): void {
    if (!state.compactSettleTimer) return;
    clearTimeout(state.compactSettleTimer);
    state.compactSettleTimer = null;
  }

  private clearCompactHardTimer(state: CodexSdkSessionState): void {
    if (!state.compactHardTimer) return;
    clearTimeout(state.compactHardTimer);
    state.compactHardTimer = null;
  }

  private clearCompactTimers(state: CodexSdkSessionState): void {
    this.clearCompactSettleTimer(state);
    this.clearCompactHardTimer(state);
  }
}
