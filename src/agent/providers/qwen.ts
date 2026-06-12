import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { killProcessTree } from '../../util/kill-process-tree.js';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import readline from 'node:readline';
import type {
  TransportProvider,
  ProviderCapabilities,
  ProviderConfig,
  ProviderError,
  ProviderStatusUpdate,
  SessionConfig,
  ToolCallEvent,
} from '../transport-provider.js';
import {
  CONNECTION_MODES,
  normalizeProviderPayload,
  SESSION_OWNERSHIP,
  PROVIDER_ERROR_CODES,
  type SessionInfoUpdate,
} from '../transport-provider.js';
import type { AgentMessage, MessageDelta } from '../../../shared/agent-message.js';
import type { ProviderContextPayload } from '../../../shared/context-types.js';
import type { TransportAttachment } from '../../../shared/transport-attachments.js';
import { DEFAULT_TRANSPORT_EFFORT, QWEN_EFFORT_LEVELS, type TransportEffortLevel } from '../../../shared/effort-levels.js';
import logger from '../../util/logger.js';
import { inferContextWindow } from '../../util/model-context.js';
import { composeProviderSystemText, getProviderSystemTextParts } from '../provider-context-routing.js';
import { normalizeTransportCwd, resolveExecutableForSpawn } from '../transport-paths.js';
import {
  SESSION_CONTROL_METADATA_COMMAND_FIELD,
  isSessionCompactCommandText,
} from '../../../shared/session-control-commands.js';
import { ensureQwenMcpHasImcodesEntry, type QwenMcpEnsureResult } from '../../daemon/qwen-mcp-config.js';
import { IMCODES_MEMORY_MCP_SERVER_NAME } from '../../../shared/memory-mcp-server-name.js';
import { getDefaultMcpServers } from './getDefaultMcpServers.js';
import {
  MEMORY_MCP_PROVIDER_STATUS_REASON,
  MEMORY_MCP_STATUS,
  type MemoryMcpProviderStatusView,
} from '../../../shared/memory-ws.js';
import {
  SDK_SUBAGENT_DETAIL_KIND,
  SDK_SUBAGENT_DIAGNOSTIC,
  SDK_SUBAGENT_PROVIDERS,
  SDK_SUBAGENT_PROVIDER_KINDS,
  SDK_SUBAGENT_SCHEMA_VERSION,
  SDK_SUBAGENT_STATUS,
  buildSdkSubagentSafeDetail,
  isSdkRuntimeSubagentEventName,
  makeQwenSubagentCanonicalKey,
  parseSdkRuntimeSubagentTag,
  startsWithSdkRuntimeSubagentTag,
  type SdkSubagentDetail,
  type SdkSubagentDiagnosticCode,
  type SdkSubagentNormalizedStatus,
} from '../../../shared/sdk-subagent-status.js';

const execFileAsync = promisify(execFile);
const QWEN_BIN = 'qwen';
const QWEN_COMPACT_SLASH_COMMAND = '/compress' as const;
const TRANSIENT_RETRY_DELAY_MS = 250;
const TRANSIENT_RETRY_MAX_ATTEMPTS = 1;
const QWEN_RESULT_COMPLETION_FALLBACK_MS = 5_000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const QWEN_COMPATIBLE_API_CLI_AUTH_TYPES = new Set([
  'openai',
  'anthropic',
  'gemini',
  'vertex-ai',
]);

/**
 * Auth types accepted by the qwen CLI's `--auth-type` flag.
 * Verified via `qwen --help` (qwen 0.14.5). Passing this flag forces the CLI
 * to use the named tier for the current run, bypassing the user-level
 * `~/.qwen/settings.json` that otherwise wins over our system-level settings.
 *
 * This is separate from `shared/qwen-auth.ts`'s display-tier constants
 * (`qwen-oauth` / `coding-plan` / `api-key` — used for UI badges).
 */
const QWEN_CLI_AUTH_TYPES = new Set([
  'openai',
  'anthropic',
  'qwen-oauth',
  'gemini',
  'vertex-ai',
]);
const QWEN_EMPTY_RESPONSE_MESSAGE = 'Qwen exited without producing a response';

/** Extract `security.auth.selectedType` from a settings object if it names a
 *  qwen CLI auth type. Returns undefined when settings are absent, malformed,
 *  or hold a value that qwen doesn't recognize (so we don't crash the spawn). */
function resolveCliAuthType(settings: string | Record<string, unknown> | undefined): string | undefined {
  if (!settings || typeof settings === 'string') return undefined;
  const security = settings.security;
  if (!security || typeof security !== 'object') return undefined;
  const auth = (security as Record<string, unknown>).auth;
  if (!auth || typeof auth !== 'object') return undefined;
  const selected = (auth as Record<string, unknown>).selectedType;
  if (typeof selected !== 'string') return undefined;
  return QWEN_CLI_AUTH_TYPES.has(selected) ? selected : undefined;
}

function isUuid(value: string | undefined): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

function extractSyntheticApiError(text: string | undefined): string | undefined {
  if (typeof text !== 'string') return undefined;
  const match = text.trim().match(/^\[API Error:\s*(.+)\]$/i);
  return match?.[1]?.trim() || undefined;
}

function startsWithSyntheticApiError(text: string | undefined): boolean {
  return typeof text === 'string' && /^\s*\[API Error:/i.test(text);
}

function toQwenCompactPayload(payload: ProviderContextPayload): ProviderContextPayload {
  const {
    sessionSystemText: _sessionSystemText,
    turnSystemText: _turnSystemText,
    systemText: _systemText,
    messagePreamble: _messagePreamble,
    startupMemory: _startupMemory,
    memoryRecall: _memoryRecall,
    ...rest
  } = payload;
  const {
    sessionSystemText: _contextSessionSystemText,
    turnSystemText: _contextTurnSystemText,
    systemText: _contextSystemText,
    messagePreamble: _contextMessagePreamble,
    ...contextRest
  } = payload.context;
  return {
    ...rest,
    userMessage: QWEN_COMPACT_SLASH_COMMAND,
    assembledMessage: QWEN_COMPACT_SLASH_COMMAND,
    context: {
      ...contextRest,
      requiredAuthoredContext: [],
      advisoryAuthoredContext: [],
      diagnostics: [],
    },
    diagnostics: [],
  };
}

interface QwenSessionState {
  cwd: string;
  started: boolean;
  description?: string;
  model?: string;
  env?: Record<string, string>;
  mcpEnv?: Record<string, string>;
  effort: TransportEffortLevel;
  settings?: string | Record<string, unknown>;
  settingsDir?: string;
  settingsPath?: string;
  /** Internal Qwen CLI conversation ID — decoupled from provider session ID so cancel can start fresh. */
  qwenConversationId: string;
  child: ChildProcess | null;
  currentMessageId: string | null;
  currentText: string;
  pendingFinalText?: string;
  pendingFinalMetadata?: Record<string, unknown>;
  cancelled?: boolean;
  toolUseByIndex: Map<number, { id: string; name: string; input?: unknown; partialJson: string }>;
  toolUseById: Map<string, { id: string; name: string; input?: unknown; partialJson: string }>;
  emittedToolSignatures: Map<string, string>;
  lastStatusSignature: string | null;
  /** Stable IM.codes context already injected into this Qwen conversation. */
  sessionSystemTextInjected?: string;
}

function toQwenReasoning(effort: TransportEffortLevel): false | { effort: 'low' | 'medium' | 'high' } {
  if (effort === 'off') return false;
  if (effort === 'high') return { effort: 'high' };
  if (effort === 'low') return { effort: 'low' };
  return { effort: 'medium' };
}

function resolveQwenReasoningSetting(
  settings: string | Record<string, unknown> | undefined,
  effort: TransportEffortLevel,
): false | { effort: 'low' | 'medium' | 'high' } {
  const cliAuthType = resolveCliAuthType(settings);
  // Compatible API routes are explicitly used for stronger third-party
  // reasoning models. Keep thinking on and pin it to high; if the Qwen CLI
  // later fails to resume because it did not round-trip reasoning_content, the
  // send path below resets the provider conversation instead of disabling
  // thinking.
  if (cliAuthType && QWEN_COMPATIBLE_API_CLI_AUTH_TYPES.has(cliAuthType)) return { effort: 'high' };
  return toQwenReasoning(effort);
}

function isReasoningContentReplayError(message: string): boolean {
  return /reasoning_content[\s\S]*thinking mode[\s\S]*passed back/i.test(message);
}

function isConversationHistoryReplayError(message: string): boolean {
  return /tool call result[\s\S]*does not follow[\s\S]*tool call/i.test(message)
    || /tool result[\s\S]*does not follow[\s\S]*tool call/i.test(message)
    || /tool_call[\s\S]*result[\s\S]*follow/i.test(message)
    || /invalid params[\s\S]*tool call result/i.test(message)
    || /\b2013\b[\s\S]*tool call result/i.test(message);
}

function isFreshConversationReplayError(message: string): boolean {
  return isReasoningContentReplayError(message) || isConversationHistoryReplayError(message);
}

function isEmptyResponseError(message: string): boolean {
  return /empty response|without producing a response/i.test(message);
}

interface QwenStreamEvent {
  type: string;
  index?: number;
  content_block?: {
    type?: string;
    id?: string;
    name?: string;
    input?: unknown;
  };
  delta?: {
    type?: string;
    text?: string;
    thinking?: string;
    partial_json?: string;
  };
  message?: {
    id?: string;
  };
}

type QwenAssistantContentBlock =
  | { type?: 'text'; text?: string }
  | { type?: 'thinking'; thinking?: string }
  | { type?: 'tool_use'; name?: string; input?: unknown; id?: string }
  | { type?: 'tool_result'; tool_use_id?: string; content?: string | Array<{ type?: string; text?: string }>; is_error?: boolean };

interface QwenStreamMessage {
  type: string;
  session_id?: string;
  subtype?: string;
  model?: string;
  is_error?: boolean;
  error?: { message?: string };
  result?: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    total_tokens?: number;
  };
  event?: QwenStreamEvent;
  message?: {
    id?: string;
    model?: string;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_read_input_tokens?: number;
      total_tokens?: number;
    };
    content?: QwenAssistantContentBlock[];
  };
}

type QwenUsage = NonNullable<QwenStreamMessage['usage']>;

function collectAssistantText(content?: QwenAssistantContentBlock[]): string {
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text);
    }
  }
  return parts.join('');
}

function stringifyToolResultContent(content: unknown): string | undefined {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return undefined;
  const parts = content
    .map((item) => (item && typeof item === 'object' && typeof item.text === 'string' ? item.text : ''))
    .filter(Boolean);
  return parts.length > 0 ? parts.join('\n') : undefined;
}

function hasMeaningfulToolValue(value: unknown): boolean {
  if (value == null) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  if (typeof value === 'number' || typeof value === 'boolean') return true;
  if (Array.isArray(value)) return value.some((item) => hasMeaningfulToolValue(item));
  if (typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).some((item) => hasMeaningfulToolValue(item));
  }
  return false;
}

function sanitizeUsageForDisplay(usage: QwenUsage | undefined, model?: string): QwenUsage | undefined {
  if (!usage) return undefined;
  const input = typeof usage.input_tokens === 'number' ? usage.input_tokens : undefined;
  const cache = typeof usage.cache_read_input_tokens === 'number' ? usage.cache_read_input_tokens : 0;
  const inferredCtx = inferContextWindow(model);
  if (input === undefined) return usage;
  // Qwen stream-json `result.usage` is computed from session metrics and may be
  // cumulative across the whole conversation. That is not a valid context-bar
  // numerator. When it is obviously beyond the model window, treat it as
  // unusable for ctx display and reset the bar instead of showing nonsense like
  // 11M / 1M.
  if (inferredCtx && input + cache > inferredCtx * 2) {
    return {
      input_tokens: 0,
      output_tokens: typeof usage.output_tokens === 'number' ? usage.output_tokens : 0,
      cache_read_input_tokens: 0,
    };
  }
  return usage;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function meaningfulString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function normalizeStatusName(value: string): string {
  return value.trim().toLowerCase().replace(/[\s_-]+/g, '');
}

function readNestedRuntimeSubagentRecord(payload: Record<string, unknown>): Record<string, unknown> | undefined {
  for (const key of ['subagent', 'subAgent', 'agent', 'notification', 'data', 'event']) {
    const nested = payload[key];
    if (isRecord(nested)) return nested;
  }
  return undefined;
}

function isRuntimeSubagentPayload(payload: Record<string, unknown>): boolean {
  const eventName = meaningfulString(payload.subtype)
    ?? meaningfulString(payload.method)
    ?? meaningfulString(payload.event)
    ?? meaningfulString(payload.type);
  return isSdkRuntimeSubagentEventName(eventName);
}

function readRuntimeSubagentId(record: Record<string, unknown>): string | undefined {
  return meaningfulString(record.agent_path)
    ?? meaningfulString(record.agentPath)
    ?? meaningfulString(record.agent_id)
    ?? meaningfulString(record.agentId)
    ?? meaningfulString(record.subagent_id)
    ?? meaningfulString(record.subagentId)
    ?? meaningfulString(record.path)
    ?? meaningfulString(record.id);
}

function readRuntimeSubagentName(record: Record<string, unknown>): string | undefined {
  return meaningfulString(record.agent_name)
    ?? meaningfulString(record.agentName)
    ?? meaningfulString(record.name)
    ?? meaningfulString(record.label);
}

function readRuntimeSubagentModel(record: Record<string, unknown>, fallback?: string): string | undefined {
  return meaningfulString(record.model)
    ?? meaningfulString(record.agentModel)
    ?? meaningfulString(record.agent_model)
    ?? meaningfulString(record.modelId)
    ?? meaningfulString(record.model_id)
    ?? meaningfulString(fallback);
}

function readRuntimeSubagentPrompt(record: Record<string, unknown>): string | undefined {
  return meaningfulString(record.prompt)
    ?? meaningfulString(record.description)
    ?? meaningfulString(record.task)
    ?? meaningfulString(record.request);
}

function readRuntimeSubagentStatusInfo(record: Record<string, unknown>): { status?: string; message?: string } {
  const value = record.status ?? record.state ?? record.phase ?? record.lifecycle;
  if (typeof value === 'string') return { status: value };
  if (isRecord(value)) {
    const [key] = Object.keys(value);
    if (key) return { status: key, message: meaningfulString(value[key]) };
  }
  return {};
}

function mapQwenRuntimeSubagentStatus(
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
    return { toolStatus: 'running', normalizedStatus: SDK_SUBAGENT_STATUS.PENDING, active: true, terminal: false };
  }
  if (
    normalized === 'running'
    || normalized === 'active'
    || normalized === 'started'
    || normalized === 'working'
    || normalized === 'inprogress'
  ) {
    return { toolStatus: 'running', normalizedStatus: SDK_SUBAGENT_STATUS.RUNNING, active: true, terminal: false };
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
    return { toolStatus: 'complete', normalizedStatus: SDK_SUBAGENT_STATUS.COMPLETE, active: false, terminal: true };
  }
  if (
    normalized === 'failed'
    || normalized === 'failure'
    || normalized === 'error'
    || normalized === 'errored'
    || normalized === 'crashed'
  ) {
    return { toolStatus: 'error', normalizedStatus: SDK_SUBAGENT_STATUS.ERROR, active: false, terminal: true };
  }
  if (
    normalized === 'interrupted'
    || normalized === 'cancelled'
    || normalized === 'canceled'
    || normalized === 'stopped'
    || normalized === 'killed'
  ) {
    return { toolStatus: 'error', normalizedStatus: SDK_SUBAGENT_STATUS.INTERRUPTED, active: false, terminal: true };
  }
  return {
    toolStatus: 'error',
    normalizedStatus: SDK_SUBAGENT_STATUS.UNKNOWN,
    active: false,
    terminal: true,
    diagnosticCode: SDK_SUBAGENT_DIAGNOSTIC.UNKNOWN_STATE,
  };
}

function qwenRuntimeSubagentToolFromPayload(
  sessionId: string,
  state: QwenSessionState,
  payload: Record<string, unknown>,
): ToolCallEvent {
  const record = readNestedRuntimeSubagentRecord(payload) ?? payload;
  const rawAgentPath = readRuntimeSubagentId(record);
  const agentPath = rawAgentPath ?? 'notification-missing-id';
  const statusInfo = readRuntimeSubagentStatusInfo(record);
  const diagnosticCode = rawAgentPath
    ? (statusInfo.status ? undefined : SDK_SUBAGENT_DIAGNOSTIC.UNKNOWN_STATE)
    : SDK_SUBAGENT_DIAGNOSTIC.MISSING_ID;
  const statusMapping = mapQwenRuntimeSubagentStatus(statusInfo.status ?? 'unknown', diagnosticCode);
  const canonicalKey = makeQwenSubagentCanonicalKey(sessionId, `runtime:${agentPath}`);
  const agentName = readRuntimeSubagentName(record);
  const model = readRuntimeSubagentModel(record, state.model);
  const prompt = readRuntimeSubagentPrompt(record);
  const summary = agentName ? `Qwen sub-agent ${agentName}` : rawAgentPath ? `Qwen sub-agent ${rawAgentPath}` : 'Qwen sub-agent';
  const output = statusMapping.terminal ? (statusInfo.message ?? statusInfo.status ?? 'unknown') : undefined;
  const detail = buildSdkSubagentSafeDetail({
    kind: SDK_SUBAGENT_DETAIL_KIND,
    summary,
    input: {
      action: 'qwen-runtime-subagent',
      description: prompt ?? summary,
    },
    ...(output ? { output } : {}),
    meta: {
      isSdkSubagent: true,
      schemaVersion: SDK_SUBAGENT_SCHEMA_VERSION,
      provider: SDK_SUBAGENT_PROVIDERS.QWEN,
      providerKind: SDK_SUBAGENT_PROVIDER_KINDS.QWEN_RUNTIME_AGENT,
      canonicalKey,
      normalizedStatus: statusMapping.normalizedStatus,
      ...(statusInfo.status ? { rawStatus: statusInfo.status } : {}),
      active: statusMapping.active,
      terminal: statusMapping.terminal,
      parentSessionId: sessionId,
      parentItemId: canonicalKey,
      ...(rawAgentPath ? { agentPath: rawAgentPath } : {}),
      ...(agentName ? { agentName } : {}),
      ...(model ? { model } : {}),
      diagnosticCode: statusMapping.diagnosticCode,
    },
  } satisfies SdkSubagentDetail, { allowRaw: false });
  return {
    id: canonicalKey,
    name: 'Agent',
    status: statusMapping.toolStatus,
    ...(detail.input ? { input: detail.input } : {}),
    ...(detail.output ? { output: detail.output } : {}),
    detail,
  };
}

function buildQwenMemoryMcpEnv(config: SessionConfig): Record<string, string> | undefined {
  const env = getDefaultMcpServers(config)[IMCODES_MEMORY_MCP_SERVER_NAME]?.env;
  return env && Object.keys(env).length > 0 ? env : undefined;
}

export class QwenProvider implements TransportProvider {
  readonly id = 'qwen';
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
    supportedEffortLevels: QWEN_EFFORT_LEVELS,
    contextSupport: 'degraded-message-side-context-mapping',
    compact: {
      execution: 'slash-command',
      providerCommand: QWEN_COMPACT_SLASH_COMMAND,
      verified: true,
      completion: 'command-result',
      cancellation: 'provider-cancel',
      reason: 'Verified with Qwen Code 0.14.5: non-interactive CLI supports /compress, not /compact; adapter translates the IM.codes /compact control command.',
    },
  };

  private config: ProviderConfig | null = null;
  private mcpRegistration: QwenMcpEnsureResult | null = null;
  private sessions = new Map<string, QwenSessionState>();
  private deltaCallbacks: Array<(sessionId: string, delta: MessageDelta) => void> = [];
  private completeCallbacks: Array<(sessionId: string, message: AgentMessage) => void> = [];
  private errorCallbacks: Array<(sessionId: string, error: ProviderError) => void> = [];
  private toolCallCallbacks: Array<(sessionId: string, tool: ToolCallEvent) => void> = [];
  private statusCallbacks: Array<(sessionId: string, status: ProviderStatusUpdate) => void> = [];
  private sessionInfoCallbacks: Array<(sessionId: string, info: SessionInfoUpdate) => void> = [];

  async connect(config: ProviderConfig): Promise<void> {
    const resolved = resolveExecutableForSpawn(QWEN_BIN);
    await execFileAsync(resolved.executable, [...resolved.prependArgs, '--version'], { windowsHide: true });
    this.mcpRegistration = await ensureQwenMcpHasImcodesEntry({
      qwenBinary: resolved.executable,
      execFileImpl: (file, args, options) => execFileAsync(file, [...resolved.prependArgs, ...args], options) as Promise<{ stdout: string; stderr: string }>,
    });
    this.config = config;
    logger.info({ provider: this.id, resolved: resolved.executable }, 'Qwen provider connected');
  }

  getMemoryMcpStatus(): MemoryMcpProviderStatusView {
    if (this.mcpRegistration?.degraded) {
      return {
        providerId: this.id,
        status: MEMORY_MCP_STATUS.DEGRADED,
        connected: true,
        degradedReasons: [
          this.mcpRegistration.reason ?? MEMORY_MCP_PROVIDER_STATUS_REASON.MCP_REGISTRATION_FAILED,
        ],
      };
    }
    return {
      providerId: this.id,
      status: MEMORY_MCP_STATUS.READY,
      connected: true,
      degradedReasons: [],
    };
  }

  async disconnect(): Promise<void> {
    for (const [sessionId, state] of this.sessions) {
      if (state.child && !state.child.killed) {
        // Tree-kill: qwen CLI forks children (web_search etc.) that survive
        // a wrapper-only SIGTERM. See killProcessTree for walk+SIGKILL logic.
        void killProcessTree(state.child);
      }
      await this.cleanupSessionSettings(state);
      this.sessions.delete(sessionId);
    }
    this.config = null;
    logger.info({ provider: this.id }, 'Qwen provider disconnected');
  }

  async createSession(config: SessionConfig): Promise<string> {
    const sessionId = config.bindExistingKey ?? config.sessionKey;
    const existing = this.sessions.get(sessionId);
    const qwenConversationId = existing?.qwenConversationId
      ?? (isUuid(config.resumeId) ? config.resumeId : undefined)
      ?? (isUuid(config.bindExistingKey) ? config.bindExistingKey : undefined)
      ?? (isUuid(config.sessionKey) ? config.sessionKey : undefined)
      ?? randomUUID();
    this.sessions.set(sessionId, {
      cwd: normalizeTransportCwd(config.cwd) ?? existing?.cwd ?? normalizeTransportCwd(process.cwd())!,
      started: !!(config.resumeId || config.bindExistingKey || config.skipCreate || existing?.started),
      description: config.description ?? existing?.description,
      model: typeof config.agentId === 'string' ? config.agentId : existing?.model,
      env: config.env ?? existing?.env,
      mcpEnv: buildQwenMemoryMcpEnv(config) ?? existing?.mcpEnv,
      effort: config.effort ?? existing?.effort ?? DEFAULT_TRANSPORT_EFFORT,
      settings: config.settings ?? existing?.settings,
      settingsDir: existing?.settingsDir,
      settingsPath: existing?.settingsPath,
      qwenConversationId,
      child: existing?.child ?? null,
      currentMessageId: existing?.currentMessageId ?? null,
      currentText: existing?.currentText ?? '',
      pendingFinalText: existing?.pendingFinalText,
      pendingFinalMetadata: existing?.pendingFinalMetadata,
      cancelled: existing?.cancelled ?? false,
      toolUseByIndex: existing?.toolUseByIndex ?? new Map(),
      toolUseById: existing?.toolUseById ?? new Map(),
      emittedToolSignatures: existing?.emittedToolSignatures ?? new Map(),
      lastStatusSignature: existing?.lastStatusSignature ?? null,
      sessionSystemTextInjected: existing?.sessionSystemTextInjected,
    });
    return sessionId;
  }

  async endSession(sessionId: string): Promise<void> {
    const state = this.sessions.get(sessionId);
    if (state?.child && !state.child.killed) {
      // Tree-kill so any child forked by the qwen CLI (web_search etc.) is
      // also terminated — see provider disconnect comment.
      void killProcessTree(state.child);
    }
    if (state) await this.cleanupSessionSettings(state);
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

  onStatus(cb: (sessionId: string, status: ProviderStatusUpdate) => void): () => void {
    this.statusCallbacks.push(cb);
    return () => {
      const idx = this.statusCallbacks.indexOf(cb);
      if (idx >= 0) this.statusCallbacks.splice(idx, 1);
    };
  }

  onSessionInfo(cb: (sessionId: string, info: SessionInfoUpdate) => void): () => void {
    this.sessionInfoCallbacks.push(cb);
    return () => {
      const idx = this.sessionInfoCallbacks.indexOf(cb);
      if (idx >= 0) this.sessionInfoCallbacks.splice(idx, 1);
    };
  }

  setSessionAgentId(sessionId: string, agentId: string): void {
    const state = this.sessions.get(sessionId);
    if (!state) return;
    state.model = agentId;
    this.sessions.set(sessionId, state);
  }

  async setSessionEffort(sessionId: string, effort: TransportEffortLevel): Promise<void> {
    const state = this.sessions.get(sessionId);
    if (!state) return;
    state.effort = effort;
    await this.ensureSettingsPath(state);
  }

  async send(
    sessionId: string,
    payloadOrMessage: string | ProviderContextPayload,
    _attachments?: TransportAttachment[],
    extraSystemPrompt?: string,
    allowResumeFallback = true,
    transientRetryBudget = TRANSIENT_RETRY_MAX_ATTEMPTS,
    reasoningReplayFallbackBudget = 1,
  ): Promise<void> {
    if (!this.config) {
      throw this.makeError(PROVIDER_ERROR_CODES.CONNECTION_LOST, 'Qwen provider not connected', false);
    }

    const state: QwenSessionState = this.sessions.get(sessionId) ?? {
      cwd: normalizeTransportCwd(process.cwd())!,
      started: true,
      description: undefined,
      model: undefined,
      env: undefined,
      effort: DEFAULT_TRANSPORT_EFFORT,
      settings: undefined,
      settingsDir: undefined,
      settingsPath: undefined,
      qwenConversationId: randomUUID(),
      child: null,
      currentMessageId: null,
      currentText: '',
      pendingFinalText: undefined,
      pendingFinalMetadata: undefined,
      cancelled: false,
      toolUseByIndex: new Map(),
      toolUseById: new Map(),
      emittedToolSignatures: new Map(),
      lastStatusSignature: null,
    };
    if (state.child && !state.child.killed) {
      throw this.makeError(PROVIDER_ERROR_CODES.PROVIDER_ERROR, 'Qwen session is already busy', true);
    }

    state.currentMessageId = null;
    state.currentText = '';
    state.pendingFinalText = undefined;
    state.pendingFinalMetadata = undefined;
    state.cancelled = false;
    state.toolUseByIndex.clear();
    state.toolUseById.clear();
    state.emittedToolSignatures.clear();
    state.lastStatusSignature = null;
    const payload = normalizeProviderPayload(payloadOrMessage, _attachments, extraSystemPrompt);
    const isCompactControl = isSessionCompactCommandText(payload.userMessage);
    const providerPayload = isCompactControl ? toQwenCompactPayload(payload) : payload;
    const compactCompletionMetadata = isCompactControl
      ? {
          [SESSION_CONTROL_METADATA_COMMAND_FIELD]: 'compact',
          event: 'session.history.compress',
          providerCommand: QWEN_COMPACT_SLASH_COMMAND,
        }
      : undefined;

    const args = [
      '-p', providerPayload.assembledMessage,
      '--output-format', 'stream-json',
      '--include-partial-messages',
      '--approval-mode', 'yolo',
    ];
    const systemParts = getProviderSystemTextParts(providerPayload);
    const sessionSystemText = systemParts.sessionSystemText;
    const includeSessionSystemText = !isCompactControl && !!sessionSystemText && state.sessionSystemTextInjected !== sessionSystemText;
    const effectivePrompt = isCompactControl
      ? undefined
      : (
          systemParts.hasSplitSystemText
            ? composeProviderSystemText(providerPayload, { includeSession: includeSessionSystemText, includeTurn: true })
            : (composeProviderSystemText(providerPayload) || state.description?.trim())
        );
    if (effectivePrompt) {
      args.push('--append-system-prompt', effectivePrompt);
    }
    if (state.model) {
      args.push('--model', state.model);
    }
    // When a preset is active, state.settings carries `security.auth.selectedType`.
    // Pass it explicitly via --auth-type so the qwen CLI uses that tier for this
    // run — otherwise user-level ~/.qwen/settings.json (which may still say
    // qwen-oauth) overrides our system-level settings file and we fall back to
    // the discontinued OAuth tier. See shared/qwen-auth.ts for the display-tier
    // counterpart; these CLI values are distinct.
    const cliAuthType = resolveCliAuthType(state.settings);
    if (cliAuthType) {
      args.push('--auth-type', cliAuthType);
    }
    if (this.mcpRegistration?.safeToAllow) {
      args.push('--allowed-mcp-server-names', this.mcpRegistration.serverName);
    }
    if (state.started) {
      args.push('--resume', state.qwenConversationId);
    } else {
      args.push('--session-id', state.qwenConversationId);
    }

    const resolved = resolveExecutableForSpawn(QWEN_BIN);
    const finalArgs = [...resolved.prependArgs, ...args];
    const child = spawn(resolved.executable, finalArgs, {
      cwd: state.cwd,
      env: {
        ...process.env,
        ...((this.config.env as Record<string, string> | undefined) ?? {}),
        ...(state.env ?? {}),
        ...(state.mcpEnv ?? {}),
        QWEN_CODE_SYSTEM_SETTINGS_PATH: await this.ensureSettingsPath(state),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
      windowsHide: true,
    });
    state.child = child;
    this.sessions.set(sessionId, state);
    if (isCompactControl) {
      this.emitStatus(sessionId, state, {
        status: 'compacting',
        label: 'Compacting conversation...',
      });
    }

    let completed = false;
    let sawError = false;
    let stderrBuf = '';
    let retryScheduled = false;
    let reasoningFallbackScheduled = false;
    let resultCompletionTimer: ReturnType<typeof setTimeout> | null = null;

    const sawVisibleTurnProgress = (): boolean => {
      return (state.currentText.length > 0 && !startsWithSyntheticApiError(state.currentText))
        || !!state.pendingFinalText
        || state.toolUseById.size > 0
        || state.emittedToolSignatures.size > 0;
    };

    const clearResultCompletionFallback = (): void => {
      if (!resultCompletionTimer) return;
      clearTimeout(resultCompletionTimer);
      resultCompletionTimer = null;
    };

    const armResultCompletionFallback = (): void => {
      if (!state.pendingFinalText) return;
      clearResultCompletionFallback();
      resultCompletionTimer = setTimeout(() => {
        resultCompletionTimer = null;
        if (completed || sawError || !state.pendingFinalText) return;
        const finalText = state.pendingFinalText;
        const messageId = state.currentMessageId ?? undefined;
        const metadata = state.pendingFinalMetadata;
        if (state.child === child) {
          state.child = null;
          void killProcessTree(child, { gracefulMs: 500 });
        }
        emitComplete(finalText, messageId, metadata);
      }, QWEN_RESULT_COMPLETION_FALLBACK_MS);
      resultCompletionTimer.unref?.();
    };

    const maybeRetryTransientError = async (messageText: string, _details?: unknown): Promise<boolean> => {
      if (retryScheduled || transientRetryBudget <= 0) return false;
      if (sawVisibleTurnProgress()) return false;
      if (!this.isRetryableTransientError(messageText)) return false;
      retryScheduled = true;
      completed = true;
      state.child = null;
      logger.info({ provider: this.id, sessionId, message: messageText }, 'Qwen transient provider error; retrying turn once');
      await new Promise((resolve) => setTimeout(resolve, TRANSIENT_RETRY_DELAY_MS));
      await this.send(sessionId, payload, _attachments, extraSystemPrompt, allowResumeFallback, transientRetryBudget - 1);
      return true;
    };

    const maybeRetryWithFreshConversation = async (messageText: string, details?: unknown): Promise<boolean> => {
      if (reasoningFallbackScheduled || reasoningReplayFallbackBudget <= 0) return false;
      if (sawVisibleTurnProgress()) return false;
      if (!isFreshConversationReplayError(messageText)) return false;
      reasoningFallbackScheduled = true;
      completed = true;
      state.child = null;
      state.started = false;
      state.qwenConversationId = randomUUID();
      state.sessionSystemTextInjected = undefined;
      this.emitSessionInfo(sessionId, { resumeId: state.qwenConversationId });
      await this.ensureSettingsPath(state);
      logger.warn(
        { provider: this.id, sessionId, conversationId: state.qwenConversationId, message: messageText, details },
        'Qwen provider rejected replayed conversation history; retrying turn in a fresh conversation',
      );
      await this.send(
        sessionId,
        payload,
        _attachments,
        extraSystemPrompt,
        false,
        transientRetryBudget,
        reasoningReplayFallbackBudget - 1,
      );
      return true;
    };

    const recoverOrEmitProviderError = (messageText: string, details?: unknown): void => {
      void maybeRetryWithFreshConversation(messageText, details).then((reasoningRetried) => {
        if (reasoningRetried) return;
        void maybeRetryTransientError(messageText, details).then((transientRetried) => {
          if (!transientRetried) emitError(messageText, details);
        });
      });
    };

    const emitError = (messageText: string, details?: unknown): void => {
      if (sawError || completed) return;
      sawError = true;
      clearResultCompletionFallback();
      this.clearStatus(sessionId, state);
      const errorCode = state.cancelled
        ? PROVIDER_ERROR_CODES.CANCELLED
        : (this.isAuthFailureMessage(messageText) ? PROVIDER_ERROR_CODES.AUTH_FAILED : PROVIDER_ERROR_CODES.PROVIDER_ERROR);
      const recoverable = errorCode === PROVIDER_ERROR_CODES.CANCELLED
        || isEmptyResponseError(messageText);
      this.errorCallbacks.forEach((cb) => cb(sessionId, this.makeError(errorCode, messageText, recoverable, details)));
    };

    const emitComplete = (text: string, messageId?: string, metadata?: Record<string, unknown>): void => {
      if (completed || sawError) return;
      completed = true;
      clearResultCompletionFallback();
      state.started = true;
      state.currentMessageId = null;
      state.currentText = '';
      state.pendingFinalText = undefined;
      state.pendingFinalMetadata = undefined;
      const finalMessageId = messageId || randomUUID();
      const isCompactCompletion = metadata?.[SESSION_CONTROL_METADATA_COMMAND_FIELD] === 'compact';
      if (isCompactCompletion) {
        state.sessionSystemTextInjected = undefined;
      } else if (includeSessionSystemText) {
        state.sessionSystemTextInjected = sessionSystemText;
      }
      const msg: AgentMessage = {
        id: finalMessageId,
        sessionId,
        kind: isCompactCompletion ? 'system' : 'text',
        role: isCompactCompletion ? 'system' : 'assistant',
        content: text,
        timestamp: Date.now(),
        status: 'complete',
        ...(metadata ? { metadata } : {}),
      };
      this.completeCallbacks.forEach((cb) => cb(sessionId, msg));
    };

    const emitTool = (tool: ToolCallEvent): void => {
      const signature = JSON.stringify({
        status: tool.status,
        name: tool.name,
        input: tool.input ?? null,
        output: tool.output ?? null,
        ...(tool.detail?.kind === SDK_SUBAGENT_DETAIL_KIND ? { detail: tool.detail } : {}),
      });
      if (state.emittedToolSignatures.get(tool.id) === signature) return;
      state.emittedToolSignatures.set(tool.id, signature);
      this.toolCallCallbacks.forEach((cb) => cb(sessionId, tool));
    };

    const emitRuntimeSubagent = (record: Record<string, unknown>): void => {
      emitTool(qwenRuntimeSubagentToolFromPayload(sessionId, state, record));
    };

    const rl = readline.createInterface({ input: child.stdout! });
    rl.on('line', (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let payload: QwenStreamMessage;
      try {
        payload = JSON.parse(trimmed) as QwenStreamMessage;
      } catch {
        return;
      }

      if (isRuntimeSubagentPayload(payload as unknown as Record<string, unknown>)) {
        emitRuntimeSubagent(payload as unknown as Record<string, unknown>);
        return;
      }

      if (payload.type === 'system' && payload.subtype === 'session_start') {
        state.started = true;
        // Do not overwrite an explicitly selected model with provider-reported
        // backend labels like "coder-model". Keep the requested model as the
        // session truth when available.
        if (!state.model && payload.model) state.model = payload.model;
        if (!state.model && payload.message?.model) state.model = payload.message.model;
        return;
      }

      if (payload.type === 'stream_event') {
        const event = payload.event;
        if (!event) return;
        if (event.type === 'message_start') {
          this.clearStatus(sessionId, state);
          state.currentMessageId = event.message?.id ?? randomUUID();
          state.currentText = '';
          return;
        }
        if (event.type === 'content_block_start' && event.content_block?.type === 'thinking') {
          this.emitStatus(sessionId, state, {
            status: 'thinking',
            label: 'Thinking...',
          });
          return;
        }
        if (event.type === 'content_block_start' && event.content_block?.type === 'tool_use') {
          this.clearStatus(sessionId, state);
          const toolId = event.content_block.id ?? randomUUID();
          const toolName = event.content_block.name ?? 'tool';
          const toolInput = event.content_block.input;
          if (typeof event.index === 'number') {
            state.toolUseByIndex.set(event.index, {
              id: toolId,
              name: toolName,
              input: toolInput,
              partialJson: '',
            });
          }
          state.toolUseById.set(toolId, {
            id: toolId,
            name: toolName,
            input: toolInput,
            partialJson: '',
          });
          if (hasMeaningfulToolValue(toolInput)) {
            emitTool({
              id: toolId,
              name: toolName,
              status: 'running',
              input: toolInput,
              detail: {
                kind: 'tool_use',
                summary: toolName,
                input: toolInput,
                raw: event.content_block,
              },
            });
          }
          return;
        }
        if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta' && typeof event.delta.text === 'string') {
          this.clearStatus(sessionId, state);
          state.currentMessageId ??= randomUUID();
          const nextText = state.currentText + event.delta.text;
          const runtimeSubagentPayload = parseSdkRuntimeSubagentTag(nextText);
          if (runtimeSubagentPayload) {
            state.currentMessageId = null;
            state.currentText = '';
            emitRuntimeSubagent(runtimeSubagentPayload);
            return;
          }
          if (startsWithSdkRuntimeSubagentTag(nextText)) {
            state.currentText = nextText;
            return;
          }
          if (startsWithSyntheticApiError(nextText)) {
            state.currentText = nextText;
            return;
          }
          state.currentText = nextText;
          this.deltaCallbacks.forEach((cb) => cb(sessionId, {
            messageId: state.currentMessageId!,
            type: 'text',
            delta: state.currentText,
            role: 'assistant',
          }));
          return;
        }
        if (event.type === 'content_block_delta' && event.delta?.type === 'thinking_delta' && typeof event.delta.thinking === 'string') {
          this.emitStatus(sessionId, state, {
            status: 'thinking',
            label: 'Thinking...',
          });
          return;
        }
        if (event.type === 'content_block_delta' && event.delta?.type === 'input_json_delta' && typeof event.index === 'number') {
          const tool = state.toolUseByIndex.get(event.index);
          if (!tool) return;
          tool.partialJson += event.delta.partial_json ?? '';
          try {
            tool.input = JSON.parse(tool.partialJson);
          } catch {
            // Partial JSON may be incomplete mid-stream.
          }
          state.toolUseById.set(tool.id, tool);
          emitTool({
            id: tool.id,
            name: tool.name,
            status: 'running',
            ...(hasMeaningfulToolValue(tool.input) ? { input: tool.input } : {}),
            detail: {
              kind: 'tool_use',
              summary: tool.name,
              input: tool.input,
              raw: tool,
            },
          });
        }
        return;
      }

      if (payload.type === 'assistant') {
        if ((payload.message?.content ?? []).some((block) => block?.type === 'thinking')) {
          this.emitStatus(sessionId, state, {
            status: 'thinking',
            label: 'Thinking...',
          });
        } else {
          this.clearStatus(sessionId, state);
        }
        for (const block of payload.message?.content ?? []) {
          if (block?.type === 'tool_use' && block.id) {
            if (hasMeaningfulToolValue(block.input)) {
              emitTool({
                id: block.id,
                name: block.name ?? 'tool',
                status: 'running',
                input: block.input,
                detail: {
                  kind: 'tool_use',
                  summary: block.name ?? 'tool',
                  input: block.input,
                  raw: block,
                },
              });
            }
          }
        }
        const finalText = collectAssistantText(payload.message?.content);
        if (finalText) {
          const runtimeSubagentPayload = parseSdkRuntimeSubagentTag(finalText);
          if (runtimeSubagentPayload) {
            state.pendingFinalText = undefined;
            state.pendingFinalMetadata = undefined;
            emitRuntimeSubagent(runtimeSubagentPayload);
            return;
          }
          const syntheticApiError = extractSyntheticApiError(finalText);
          if (syntheticApiError) {
            recoverOrEmitProviderError(syntheticApiError, payload);
            return;
          }
          state.pendingFinalText = finalText;
          state.pendingFinalMetadata = {
            ...(state.model || payload.message?.model ? { model: state.model ?? payload.message?.model } : {}),
            ...(payload.message?.usage ? { usage: sanitizeUsageForDisplay(payload.message.usage, state.model ?? payload.message?.model) } : {}),
            ...(compactCompletionMetadata ?? {}),
          };
        }
        return;
      }

      if (payload.type === 'user') {
        this.clearStatus(sessionId, state);
        for (const block of payload.message?.content ?? []) {
          if (block?.type !== 'tool_result' || !block.tool_use_id) continue;
          const output = stringifyToolResultContent(block.content);
          const tool = state.toolUseById.get(block.tool_use_id);
          emitTool({
            id: block.tool_use_id,
            name: tool?.name ?? 'tool',
            status: block.is_error ? 'error' : 'complete',
            ...(output ? { output } : {}),
            detail: {
              kind: 'tool_result',
              summary: tool?.name ?? 'tool',
              output,
              raw: block,
            },
          });
        }
        return;
      }

      if (payload.type === 'result') {
        this.clearStatus(sessionId, state);
        if (payload.is_error) {
          const errorText = payload.error?.message || stderrBuf || 'Qwen execution failed';
          recoverOrEmitProviderError(errorText, payload);
          return;
        }
        const syntheticApiError = extractSyntheticApiError(payload.result);
        if (syntheticApiError) {
          recoverOrEmitProviderError(syntheticApiError, payload);
          return;
        }
        const resultText = typeof payload.result === 'string' && payload.result.trim()
          ? payload.result
          : state.pendingFinalText;
        if (!completed && resultText) {
          const assistantUsage = state.pendingFinalMetadata?.usage as QwenUsage | undefined;
          const sanitizedResultUsage = sanitizeUsageForDisplay(payload.usage, state.model);
          state.pendingFinalText = resultText;
          state.pendingFinalMetadata = {
            ...(state.pendingFinalMetadata ?? {}),
            ...(state.model ? { model: state.model } : {}),
            ...(!assistantUsage && sanitizedResultUsage ? { usage: sanitizedResultUsage } : {}),
            ...(compactCompletionMetadata ?? {}),
          };
          armResultCompletionFallback();
        }
      }
    });

    child.stderr?.on('data', (chunk: Buffer | string) => {
      const text = chunk.toString();
      stderrBuf += text;
      logger.debug({ provider: this.id, sessionId, stderr: text.trim() }, 'qwen stderr');
    });

    child.once('close', (code, signal) => {
      setTimeout(() => {
        clearResultCompletionFallback();
        rl.close();
        if (state.child === child) state.child = null;
        if (state.cancelled) {
          emitError('Cancelled');
          return;
        }
        if (!completed && !sawError && code === 0) {
          if (state.pendingFinalText) {
            emitComplete(state.pendingFinalText, state.currentMessageId ?? undefined, state.pendingFinalMetadata);
            return;
          }
          logger.warn(
            { provider: this.id, sessionId, code, signal, stderr: stderrBuf.trim() || undefined },
            'Qwen process exited successfully without a terminal response',
          );
          recoverOrEmitProviderError(QWEN_EMPTY_RESPONSE_MESSAGE, { code, signal, stderr: stderrBuf });
          return;
        }
        if (!completed && !sawError) {
          if (allowResumeFallback && state.started && /No saved session found with ID/i.test(stderrBuf)) {
            state.started = false;
            state.qwenConversationId = randomUUID();
            state.sessionSystemTextInjected = undefined;
            this.emitSessionInfo(sessionId, { resumeId: state.qwenConversationId });
            void this.send(sessionId, payload, _attachments, extraSystemPrompt, false).catch((err) => {
              const providerError = typeof err === 'object' && err && 'code' in err
                ? err as ProviderError
                : this.makeError(PROVIDER_ERROR_CODES.PROVIDER_ERROR, String(err), false, err);
              emitError(providerError.message, providerError.details ?? providerError);
            });
            return;
          }
          const errorText = stderrBuf.trim() || `Qwen exited with code ${code ?? 'null'}${signal ? ` (${signal})` : ''}`;
          recoverOrEmitProviderError(errorText, { code, signal, stderr: stderrBuf });
        }
      }, 0);
    });

    await new Promise<void>((resolve, reject) => {
      child.once('spawn', () => resolve());
      child.once('error', (err) => reject(this.makeError(PROVIDER_ERROR_CODES.PROVIDER_ERROR, err.message, false)));
    });
    // Persistent error listener so post-spawn errors don't escalate to
    // uncaughtException and crash the daemon.
    child.on('error', (err) => {
      logger.error({ provider: this.id, err }, 'Qwen child process error');
      recoverOrEmitProviderError(err.message, err);
    });
  }

  async restoreSession(sessionId: string): Promise<boolean> {
    return this.sessions.has(sessionId) || !!sessionId;
  }

  async cancel(sessionId: string): Promise<void> {
    const state = this.sessions.get(sessionId);
    if (!state?.child || state.child.killed) return;
    state.cancelled = true;
    const child = state.child;
    // Tree-kill: previously we only SIGTERM+SIGKILL'd the wrapper, which
    // left Qwen CLI's grandchildren (web_search, bash helpers) alive.
    // killProcessTree walks the descendant tree via `ps` and sends SIGTERM
    // → SIGKILL to each pid explicitly (2s grace).
    void killProcessTree(child, { gracefulMs: 2_000 });
    // Reset conversation so next send uses --session-id with a fresh ID
    // instead of --resume on the conversation stuck in a tool-call loop.
    state.started = false;
    state.qwenConversationId = randomUUID();
    state.sessionSystemTextInjected = undefined;
  }

  private makeError(code: string, message: string, recoverable: boolean, details?: unknown): ProviderError {
    return { code, message, recoverable, details };
  }

  private isRetryableTransientError(message: string): boolean {
    return /premature close|empty response|without producing a response|fetch failed|connection error|socket hang up|econnreset|etimedout|network error/i.test(message);
  }

  private isAuthFailureMessage(message: string): boolean {
    return /invalid access token|token expired|unauthorized|authentication failed|401\b/i.test(message);
  }

  private emitStatus(sessionId: string, state: QwenSessionState, status: ProviderStatusUpdate): void {
    const signature = JSON.stringify({
      status: status.status,
      label: status.label ?? null,
    });
    if (state.lastStatusSignature === signature) return;
    state.lastStatusSignature = signature;
    for (const cb of this.statusCallbacks) cb(sessionId, status);
  }

  private emitSessionInfo(sessionId: string, info: SessionInfoUpdate): void {
    for (const cb of this.sessionInfoCallbacks) cb(sessionId, info);
  }

  private clearStatus(sessionId: string, state: QwenSessionState): void {
    this.emitStatus(sessionId, state, { status: null, label: null });
  }

  private async ensureSettingsPath(state: QwenSessionState): Promise<string> {
    if (!state.settingsDir) {
      state.settingsDir = await mkdtemp(path.join(os.tmpdir(), 'imcodes-qwen-thinking-'));
      state.settingsPath = path.join(state.settingsDir, 'settings.json');
    }
    const base = typeof state.settings === 'string'
      ? {}
      : (state.settings && typeof state.settings === 'object' ? state.settings : {});
    const nextModel = {
      ...(base.model && typeof base.model === 'object' ? base.model as Record<string, unknown> : {}),
      generationConfig: {
        ...(
          base.model
          && typeof base.model === 'object'
          && (base.model as Record<string, unknown>).generationConfig
          && typeof (base.model as Record<string, unknown>).generationConfig === 'object'
            ? (base.model as Record<string, unknown>).generationConfig as Record<string, unknown>
            : {}
        ),
        reasoning: resolveQwenReasoningSetting(state.settings, state.effort),
      },
    };
    const next = {
      ...base,
      model: nextModel,
    };
    let current = '';
    if (state.settingsPath) {
      try {
        current = await readFile(state.settingsPath, 'utf8');
      } catch {}
      const serialized = JSON.stringify(next);
      if (current.trim() !== serialized) {
        await writeFile(state.settingsPath, serialized, 'utf8');
      }
    }
    return state.settingsPath!;
  }

  private async cleanupSessionSettings(state: QwenSessionState): Promise<void> {
    if (!state.settingsDir) return;
    const dir = state.settingsDir;
    state.settingsDir = undefined;
    state.settingsPath = undefined;
    try {
      await rm(dir, { recursive: true, force: true });
    } catch {}
  }
}
