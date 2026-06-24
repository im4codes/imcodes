import { access, copyFile, open, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { homedir } from 'node:os';
import { extname, join, resolve, sep } from 'node:path';
import { TextDecoder } from 'node:util';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import readline, { type Interface as ReadlineInterface } from 'node:readline';
import { killProcessTree } from '../../util/kill-process-tree.js';
import type {
  TransportProvider,
  ProviderCapabilities,
  ProviderConfig,
  ProviderError,
  ProviderModelList,
  SessionConfig,
  SessionInfoUpdate,
  ProviderStatusUpdate,
  ProviderUsageUpdate,
  ToolCallEvent,
} from '../transport-provider.js';
import {
  CONNECTION_MODES,
  normalizeProviderPayload,
  SESSION_OWNERSHIP,
  PROVIDER_ERROR_CODES,
} from '../transport-provider.js';
import type { AgentMessage, MessageDelta } from '../../../shared/agent-message.js';
import type { ProviderContextPayload } from '../../../shared/context-types.js';
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
  makeCodexSubagentCanonicalKey,
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
// Debounce before settling a turn purely from a thread-idle status (current
// Codex app-server sometimes ends a turn without an explicit `turn/completed`).
// Long enough that a transient mid-turn idle is cancelled by the activity that
// follows it; short enough that a genuinely finished turn is never stuck.
const CODEX_IDLE_SETTLE_DEBOUNCE_MS = 1_500;
const TERMINATED_COMPACT_TURN_CACHE_LIMIT = 80;
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

function readBoundedIntegerEnv(
  envName: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = process.env[envName];
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) return fallback;
  if (parsed < min) return min;
  if (parsed > max) return max;
  return parsed;
}

interface CodexRawSpawnAgentCall {
  sessionId: string;
  callId: string;
  args: Record<string, any>;
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
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function getCodexHome(env: Record<string, string | undefined>): string {
  return typeof env.CODEX_HOME === 'string' && env.CODEX_HOME.trim()
    ? resolve(env.CODEX_HOME.trim())
    : resolve(homedir(), '.codex');
}

function codexSessionDir(codexHome: string, date: Date): string {
  const yyyy = date.getUTCFullYear();
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(date.getUTCDate()).padStart(2, '0');
  return join(codexHome, 'sessions', String(yyyy), mm, dd);
}

function recentCodexSessionDirs(codexHome: string): string[] {
  const dirs: string[] = [];
  for (let i = 0; i < 30; i += 1) {
    dirs.push(codexSessionDir(codexHome, new Date(Date.now() - i * 86_400_000)));
  }
  return dirs;
}

async function findCodexRolloutPathByUuid(env: Record<string, string | undefined>, uuid: string): Promise<string | null> {
  const codexHome = getCodexHome(env);
  let latestPath: string | null = null;
  let latestMtime = -1;
  for (const dir of recentCodexSessionDirs(codexHome)) {
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (!name.startsWith('rollout-') || !name.endsWith('.jsonl') || !name.includes(uuid)) continue;
      const candidate = join(dir, name);
      try {
        const info = await stat(candidate);
        if (info.mtimeMs > latestMtime) {
          latestMtime = info.mtimeMs;
          latestPath = candidate;
        }
      } catch {
        continue;
      }
    }
  }
  return latestPath;
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

export interface CodexDiscoveredModel {
  id: string;
  name?: string;
  supportsReasoningEffort?: boolean;
  isDefault?: boolean;
}

interface CodexSdkSessionState {
  routeId: string;
  cwd: string;
  env?: Record<string, string>;
  mcpConfig?: Record<string, unknown>;
  model?: string;
  effort?: TransportEffortLevel;
  threadId?: string;
  loaded: boolean;
  runningTurnId?: string;
  turnStartInFlight: boolean;
  runningCompact: boolean;
  currentMessageId: string | null;
  currentText: string;
  activeItemIds: Set<string>;
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
  completedCompactTurnIds: Set<string>;
  terminatedTurnIds: Set<string>;
  terminatedCompactTurnIds: Set<string>;
  // Debounced turn-end settle, armed when the thread reports idle and cancelled
  // by any subsequent turn activity. Current Codex sometimes ends a turn with
  // only a thread-idle status (no `turn/completed`); this fires that completion
  // once the thread has been quiet for CODEX_IDLE_SETTLE_DEBOUNCE_MS, while a
  // transient mid-turn idle is cancelled by the activity that follows it.
  idleSettleTimer?: ReturnType<typeof setTimeout>;
  idleSettleTurnId?: string;
  generatedImageTracking: GeneratedImageTrackingSnapshot | null;
  generatedImagePaths: string[];
  rawChecklistStartedAt: number;
  rawChecklistRolloutPath?: string;
  rawChecklistRolloutOffset?: number;
  rawChecklistSeenCallIds: Set<string>;
  rawChecklistScanPromise?: Promise<void>;
  rawChecklistPollTimer: ReturnType<typeof setTimeout> | null;
  rawChecklistPollUntil: number;
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
    || normalized === 'completed'
    || normalized === 'notloaded';
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
      ...(record.backgrounded === true ? { backgrounded: true } : {}),
      ...(usageTotalTokens !== undefined ? { usageTotalTokens } : {}),
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
    default:
      return null;
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

  getSessionDiagnostics(sessionId: string): Record<string, unknown> | null {
    const state = this.sessions.get(sessionId);
    if (!state) return null;
    const activeReason = state.runningCompact
      ? 'compact'
      : state.runningTurnId
        ? 'turn'
        : state.turnStartInFlight
          ? 'turn-start'
          : state.activeItemIds.size > 0
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
      turnStartInFlight: state.turnStartInFlight,
      runningCompact: state.runningCompact,
      loaded: state.loaded,
      cancelled: state.cancelled,
      currentMessageId: state.currentMessageId,
      currentTextLength: state.currentText.length,
      activeItemCount: state.activeItemIds.size,
      activeItemIds: [...state.activeItemIds].slice(-20),
      compactObserved: state.compactObserved,
      compactSettleArmed: Boolean(state.compactSettleTimer),
      compactHardTimeoutArmed: Boolean(state.compactHardTimer),
      cancelTimerArmed: Boolean(state.cancelTimer),
      rawChecklistPollArmed: Boolean(state.rawChecklistPollTimer),
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
      cwd: normalizeTransportCwd(config.cwd) ?? existing?.cwd ?? normalizeTransportCwd(process.cwd())!,
      env: { ...(existing?.env ?? {}), ...((config.env as Record<string, string> | undefined) ?? {}) },
      mcpConfig: buildCodexMcpThreadConfig(config) ?? existing?.mcpConfig,
      model: typeof config.agentId === 'string' ? config.agentId : existing?.model,
      effort: config.effort ?? existing?.effort,
      threadId: config.resumeId ?? existing?.threadId,
      loaded: false,
      runningTurnId: undefined,
      turnStartInFlight: false,
      runningCompact: false,
      currentMessageId: null,
      currentText: '',
      activeItemIds: new Set(),
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
      completedCompactTurnIds: existing?.completedCompactTurnIds ?? new Set(),
      terminatedTurnIds: existing?.terminatedTurnIds ?? new Set(),
      terminatedCompactTurnIds: existing?.terminatedCompactTurnIds ?? new Set(),
      generatedImageTracking: null,
      generatedImagePaths: [],
      rawChecklistStartedAt: Date.now(),
      rawChecklistRolloutPath: existing?.rawChecklistRolloutPath,
      rawChecklistRolloutOffset: existing?.rawChecklistRolloutOffset,
      rawChecklistSeenCallIds: existing?.rawChecklistSeenCallIds ?? new Set(),
      rawChecklistScanPromise: undefined,
      rawChecklistPollTimer: null,
      rawChecklistPollUntil: 0,
    });
    if (config.resumeId || config.effort) this.emitSessionInfo(routeId, { ...(config.resumeId ? { resumeId: config.resumeId } : {}), ...(config.effort ? { effort: config.effort } : {}) });
    return routeId;
  }

  async endSession(sessionId: string): Promise<void> {
    const state = this.sessions.get(sessionId);
    if (!state) return;
    this.clearCancelTimer(state);
    this.clearCompactTimers(state);
    this.clearRawChecklistPollTimer(state);
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
    if (state.runningTurnId || state.runningCompact) {
      throw this.makeError(PROVIDER_ERROR_CODES.PROVIDER_ERROR, 'Codex SDK session is already busy', true);
    }
    await this.refreshAppServerForLatestAuth('send');
    if (!this.config || !this.child) {
      throw this.makeError(PROVIDER_ERROR_CODES.CONNECTION_LOST, 'Codex app-server not connected', false);
    }

    state.currentText = '';
    state.currentMessageId = null;    state.activeItemIds.clear();
    state.cancelled = false;
    this.clearCancelTimer(state);
    state.lastUsage = undefined;
    state.lastStatusSignature = null;
    state.generatedImageTracking = null;
    state.generatedImagePaths = [];
    const payload = normalizeProviderPayload(payloadOrMessage, attachments, extraSystemPrompt);
    if (this.isCompactCommand(payload)) {
      await this.startCompact(sessionId, state);
      return;
    }
    await this.startTurn(sessionId, state, payload);
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
    if (!state.threadId) return;
    if (state.runningCompact) {
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
    if (!turnId) return;
    await this.interruptRunningTurn(sessionId, state, turnId);
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
    }, CANCEL_INTERRUPT_TIMEOUT_MS).catch(() => {});
    this.clearCancelTimer(state);
    state.cancelTimer = setTimeout(() => {
      if (!this.sessions.has(sessionId)) return;
      if (state.runningTurnId !== turnId) return;
      this.clearStatus(sessionId, state);
      this.rememberTerminatedTurn(state, turnId);
      state.runningTurnId = undefined;
      state.turnStartInFlight = false;      state.activeItemIds.clear();
      this.clearRawChecklistPollTimer(state);
      this.clearPendingSessionSystemTextUpdate(state);
      this.emitError(sessionId, this.makeError(PROVIDER_ERROR_CODES.CANCELLED, 'Codex turn cancelled', true));
    }, CANCEL_INTERRUPT_TIMEOUT_MS);
    state.cancelTimer.unref?.();
  }

  private buildSpawnEnv(config: ProviderConfig): Record<string, string | undefined> {
    return { ...process.env, ...((config.env as Record<string, string> | undefined) ?? {}) };
  }

  private async stopAppServer(options: { clearSessions: boolean }): Promise<void> {
    this.rejectPending(new Error('Codex app-server disconnected'));
    this.rl?.close();
    this.rl = null;
    for (const [sessionId, state] of this.sessions) {
      this.clearCancelTimer(state);
      this.clearCompactTimers(state);      this.clearRawChecklistPollTimer(state);
      if (!options.clearSessions) {
        this.clearStatus(sessionId, state);
        this.rememberTerminatedActiveTurn(state);
        state.loaded = false;
        state.runningTurnId = undefined;
        state.turnStartInFlight = false;
        state.runningCompact = false;
        state.compactObserved = false;
        state.currentMessageId = null;
        state.currentText = '';
        state.activeItemIds.clear();
        state.cancelled = false;
        state.lastStatusSignature = null;
        this.clearPendingSessionSystemTextUpdate(state);
      }
    }
    // `child.kill('SIGTERM')` only terminates the node wrapper; the native
    // codex binary it spawned lives on and leaks ~60MB per abandoned pair.
    // Walk the descendant tree and tree-kill instead.
    const child = this.child;
    this.child = null;
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
    child.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      if (text.trim()) logger.debug({ provider: this.id, stderr: text.trim() }, 'Codex app-server stderr');
    });
    child.on('exit', (code) => {
      if (this.child !== child) return;
      const err = new Error(`Codex app-server exited with code ${code ?? 'unknown'}`);
      this.rejectPending(err);
      const sessions = [...this.sessions.keys()];
      for (const sid of sessions) {
        this.emitError(sid, this.makeError(PROVIDER_ERROR_CODES.CONNECTION_LOST, err.message, false));
      }
      this.child = null;
      this.appServerAuthFingerprint = null;
    });
    // CRITICAL: must listen for 'error' or spawn failures (e.g. ENOENT) become
    // uncaughtException and crash the daemon.
    child.on('error', (err) => {
      if (this.child !== child) return;
      logger.error({ provider: this.id, err }, 'Codex app-server spawn error');
      this.rejectPending(err);
      const sessions = [...this.sessions.keys()];
      for (const sid of sessions) {
        this.emitError(sid, this.makeError(PROVIDER_ERROR_CODES.CONNECTION_LOST, err.message, false));
      }
      this.child = null;
      this.appServerAuthFingerprint = null;
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

  private async restartAppServerPreservingSessions(reason: string): Promise<void> {
    if (this.appServerRestart) return this.appServerRestart;
    const config = this.config;
    if (!config) return;
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
      state.turnStartInFlight = true;
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
      if (startedTurnId) state.runningTurnId = startedTurnId;
      state.nativePlanEventSeen = false;
      if (state.runningTurnId) {
        state.completedTurnIds.delete(state.runningTurnId);
        state.terminatedTurnIds.delete(state.runningTurnId);
      }
      if (shouldInjectStableUpdate) {
        state.pendingSessionSystemTextUpdate = desiredSessionSystemText;
        state.pendingSessionSystemTextUpdateTurnId = state.runningTurnId;
      }
      if (state.cancelled && state.runningTurnId) {
        await this.interruptRunningTurn(sessionId, state, state.runningTurnId);
      }
      if (state.runningTurnId) this.armRawChecklistPolling(sessionId, state);
    } catch (err) {
      this.rememberTerminatedTurn(state, state.runningTurnId);
      state.runningTurnId = undefined;
      state.turnStartInFlight = false;      state.activeItemIds.clear();
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
      state.runningCompact = true;
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
    for (const cb of this.toolCallCallbacks) cb(sessionId, tool);
  }

  private async readRawChecklistHistoryChunk(state: CodexSdkSessionState): Promise<string | null> {
    if (!state.threadId) return null;
    const env = { ...process.env, ...(state.env ?? {}) };
    const rolloutPath = state.rawChecklistRolloutPath ?? await findCodexRolloutPathByUuid(env, state.threadId);
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

  private handleRawResponseItem(params: Record<string, any>): boolean {
    const threadId = readParamThreadId(params);
    const sessionId = threadId ? this.threadToSession.get(threadId) : undefined;
    const state = sessionId ? this.sessions.get(sessionId) : null;
    const item = isRecord(params.item) ? params.item : undefined;
    if (!sessionId || !state || !item) return false;
    if (state.cancelled) return true;
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
        // Authoritative turn-end signal for the current Codex app-server: it
        // reports the thread going idle when a turn finishes but does NOT always
        // emit an explicit `turn/completed` (confirmed via DIAG logs: turns
        // started, did their work, but no `turn/completed` ever arrived → the
        // runtime stayed "working" forever and the queued message could not
        // drain until a manual STOP). So settle the active normal turn on
        // thread-idle. The `completedTurnIds` dedup makes this coexist safely
        // with a later `turn/completed` for the same turn — whichever arrives
        // first settles it; the other is dropped by the dedup gate.
        if (
          state.runningTurnId
          && !state.cancelled
          && !state.turnStartInFlight
          && !this.isClosedCodexTurn(state, state.runningTurnId)
        ) {
          this.armIdleSettleTimer(sessionId, state, state.runningTurnId);
          return;
        }
      }
      return;
    }

    if (isCodexRuntimeSubagentMethod(method, params)) {
      this.emitRuntimeSubagentNotification(params);
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
      // Native plan event (codex >= 0.139). Render it AND suppress the legacy
      // rollout-file scan for this session so old (file-scrape) + new never
      // double-render the same plan.
      state.nativePlanEventSeen = true;
      const tool = planToolFromTurnPlanEvent(sessionId, turnId ?? state.runningTurnId, params.plan);
      if (tool) {
        for (const cb of this.toolCallCallbacks) cb(sessionId, tool);
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
      this.clearIdleSettleTimer(state); // item activity → turn active, cancel pending idle settle
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
      if (!closedTurn) this.trackCodexTurnItemActivity(sessionId, state, method, item);

      if (item.type === 'contextCompaction') {
        state.runningCompact = true;
        state.compactObserved = true;
        this.clearCompactSettleTimer(state);
        state.runningTurnId = turnId ?? state.runningTurnId;
        if (method === 'item/completed') {
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
        for (const cb of this.toolCallCallbacks) cb(sessionId, tool);
      }

      if (item.type === 'agentMessage') {
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
      this.clearIdleSettleTimer(state); // explicit turn/completed supersedes any pending idle settle

      if (turnId && this.isClosedCompactTurn(state, turnId)) {
        return;
      }
      if (turnId && this.isClosedTurn(state, turnId)) {
        return;
      }

      if (status === 'failed') {
        this.rememberTerminatedActiveTurn(state, turnId);
        this.clearCancelTimer(state);
        this.clearCompactTimers(state);
        this.clearRawChecklistPollTimer(state);
        this.clearStatus(sessionId, state);
        state.runningCompact = false;
        state.compactObserved = false;
        state.runningTurnId = undefined;
        state.turnStartInFlight = false;        state.activeItemIds.clear();
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
        this.clearCancelTimer(state);
        this.clearCompactTimers(state);
        this.clearRawChecklistPollTimer(state);
        state.runningCompact = false;
        state.compactObserved = false;
        if (!state.runningTurnId && state.cancelled) {
          state.cancelled = false;
          state.activeItemIds.clear();          this.clearPendingSessionSystemTextUpdate(state);
          return;
        }
        this.clearStatus(sessionId, state);
        state.runningTurnId = undefined;
        state.turnStartInFlight = false;
        state.activeItemIds.clear();        this.clearPendingSessionSystemTextUpdate(state);
        this.emitError(sessionId, this.makeError(PROVIDER_ERROR_CODES.CANCELLED, 'Codex turn cancelled', true));
        return;
      }

      if (state.runningCompact) {
        this.completeCompact(sessionId, state, typeof turn.id === 'string' ? turn.id : undefined);
        return;
      }

      if (state.cancelled) {
        this.rememberTerminatedActiveTurn(state, turnId);
        this.clearCancelTimer(state);
        this.clearRawChecklistPollTimer(state);
        this.clearStatus(sessionId, state);
        state.runningTurnId = undefined;
        state.turnStartInFlight = false;
        state.currentMessageId = null;
        state.currentText = '';
        state.activeItemIds.clear();
        state.cancelled = false;        this.clearPendingSessionSystemTextUpdate(state);
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

      await this.completeTurn(sessionId, state, turnId);
      return;
    }
  }

  private async completeTurn(sessionId: string, state: CodexSdkSessionState, turnId?: string): Promise<void> {
    this.clearIdleSettleTimer(state);
    this.clearCancelTimer(state);    this.clearStatus(sessionId, state);
    this.queueRawChecklistHistoryScan(sessionId, state);
    this.clearRawChecklistPollTimer(state);
    this.commitPendingSessionSystemTextUpdate(state, turnId);
    this.rememberCompletedTurn(state, turnId);
    const messageId = state.currentMessageId ?? `${sessionId}:agent-message`;
    const currentText = state.currentText;
    const usage = state.lastUsage;
    const model = state.model;
    const resumeId = state.threadId;
    const generatedImageTracking = state.generatedImageTracking;
    const alreadyDetectedImagePaths = [...state.generatedImagePaths];
    state.runningTurnId = undefined;
    state.turnStartInFlight = false;
    state.activeItemIds.clear();
    state.generatedImageTracking = null;
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

  /** Cancel a pending debounced thread-idle settle (turn activity resumed). */
  private clearIdleSettleTimer(state: CodexSdkSessionState): void {
    if (state.idleSettleTimer) {
      clearTimeout(state.idleSettleTimer);
      state.idleSettleTimer = undefined;
    }
    state.idleSettleTurnId = undefined;
  }

  /** Arm the debounced thread-idle settle for `turnId`. If no turn activity
   *  arrives before the debounce elapses, the turn is completed (handles the
   *  current Codex app-server ending a turn with only a thread-idle status). */
  private armIdleSettleTimer(sessionId: string, state: CodexSdkSessionState, turnId: string): void {
    this.clearIdleSettleTimer(state);
    state.idleSettleTurnId = turnId;
    state.idleSettleTimer = setTimeout(() => {
      state.idleSettleTimer = undefined;
      state.idleSettleTurnId = undefined;
      if (
        state.runningTurnId === turnId
        && !state.cancelled
        && !state.turnStartInFlight
        && !this.isClosedCodexTurn(state, turnId)
      ) {
        void this.completeTurn(sessionId, state, turnId);
      }
    }, CODEX_IDLE_SETTLE_DEBOUNCE_MS);
    state.idleSettleTimer.unref?.();
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

  private completeCompact(sessionId: string, state: CodexSdkSessionState, turnId?: string): void {
    this.clearCancelTimer(state);
    this.clearCompactTimers(state);    this.clearRawChecklistPollTimer(state);
    this.clearStatus(sessionId, state);
    state.runningCompact = false;
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
    this.clearCompactTimers(state);
    this.clearRawChecklistPollTimer(state);    this.clearStatus(sessionId, state);
    this.rememberTerminatedCompactTurn(state, state.runningTurnId);
    state.runningCompact = false;
    state.runningTurnId = undefined;
    state.turnStartInFlight = false;
    state.compactObserved = false;
    this.clearPendingSessionSystemTextUpdate(state);
    state.currentMessageId = null;
    state.currentText = '';
    state.activeItemIds.clear();
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
      if (method === 'item/started') {        state.activeItemIds.add(itemId);
      } else {
        state.activeItemIds.delete(itemId);
      }
    }  }

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
      this.clearCompactTimers(state);      this.clearStatus(sessionId, state);
      this.rememberTerminatedCompactTurn(state, state.runningTurnId);
      state.runningCompact = false;
      state.runningTurnId = undefined;
      state.turnStartInFlight = false;
      state.compactObserved = false;
      this.clearPendingSessionSystemTextUpdate(state);
      state.currentMessageId = null;
      state.currentText = '';
      state.activeItemIds.clear();
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
