import { randomUUID } from 'node:crypto';
import type { ChildProcess, ChildProcessWithoutNullStreams } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';
import {
  ndJsonStream,
  RequestError,
  type ContentBlock,
  type InitializeResponse,
  type LoadSessionResponse,
  type McpServer,
  type NewSessionResponse,
  type PromptResponse,
  type ReadTextFileRequest,
  type ReadTextFileResponse,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification,
  type StopReason,
  type ToolCall,
  type ToolCallContent,
  type ToolCallUpdate,
  type WriteTextFileRequest,
  type WriteTextFileResponse,
} from '@agentclientprotocol/sdk/unstable';
import { AGENT_DELEGATION_ACTIVE_NOTIFICATION_MODES } from '../../../shared/agent-delegation.js';
import type { AgentMessage, MessageDelta } from '../../../shared/agent-message.js';
import type { ProviderContextPayload } from '../../../shared/context-types.js';
import { IMCODES_MEMORY_MCP_SERVER_NAME } from '../../../shared/memory-mcp-server-name.js';
import {
  MEMORY_MCP_PROVIDER_STATUS_REASON,
  MEMORY_MCP_STATUS,
  type MemoryMcpProviderStatusView,
} from '../../../shared/memory-ws.js';
import { NATIVE_AGENT_ADMISSION_MODES } from '../../../shared/native-collaboration-policy.js';
import { isSessionControlCommandText } from '../../../shared/session-control-commands.js';
import { SESSION_MODEL_APPLIED, type SessionModelApplied } from '../../../shared/session-model-control.js';
import type { TransportAttachment } from '../../../shared/transport-attachments.js';
import {
  ensureCursorMcpJsonHasImcodesEntry,
  type CursorMcpEnsureOptions,
  type CursorMcpEnsureResult,
} from '../../daemon/cursor-mcp-config.js';
import { gateChildStream } from '../../util/event-loop-backpressure.js';
import { killProcessTree } from '../../util/kill-process-tree.js';
import logger from '../../util/logger.js';
import { withTimeoutOutcome } from '../../util/timeout-outcome.js';
import { getCursorRuntimeConfig } from '../cursor-runtime-config.js';
import { composeMessageSideProviderPrompt, getProviderSystemTextParts } from '../provider-context-routing.js';
import { confirmPromiseStop } from '../provider-stop-confirmation.js';
import { sessionSystemContractKey, shouldInjectSessionSystemContract } from '../session-system-contract.js';
import {
  canonicalizeTransportCwd,
  hasPendingCursorStagedUpdate,
  normalizeTransportCwd,
  resolveCursorLaunchPlan,
  resolveCursorPathForSdk,
  type ResolvedExecutable,
} from '../transport-paths.js';
import type {
  ApprovalRequest,
  ProviderCancelOptions,
  ProviderCapabilities,
  ProviderConfig,
  ProviderError,
  ProviderModelInfo,
  ProviderModelList,
  ProviderStatusUpdate,
  ProviderUsageUpdate,
  RemoteSessionInfo,
  RemoteSessionListOptions,
  SessionConfig,
  SessionInfoUpdate,
  ToolCallEvent,
  TransportProvider,
} from '../transport-provider.js';
import {
  CONNECTION_MODES,
  normalizeProviderPayload,
  PROVIDER_CANCEL_ORIGINS,
  PROVIDER_ERROR_CODES,
  SESSION_OWNERSHIP,
} from '../transport-provider.js';
import {
  createAcpClientConnection,
  type AcpClientConnection,
  type AcpClientHandlers,
} from './acp-client-adapter.js';
import { filterAcpJsonLines } from './acp-json-filter.js';
import { acpPlanEntriesToInput } from './acp-plan.js';
import { getDefaultAcpMcpServers, getDefaultMcpServers } from './getDefaultMcpServers.js';

const CURSOR_BIN = 'cursor-agent';
const CURSOR_PROVIDER_ID = 'cursor-headless';
const CURSOR_AUTH_METHOD_LOGIN = 'cursor_login';
const CONNECT_PROBE_TIMEOUT_MS = 15_000;
const AUTH_RPC_TIMEOUT_MS = 4_000;
const SESSION_RPC_TIMEOUT_MS = 30_000;
const MODE_MODEL_RPC_TIMEOUT_MS = 10_000;
const ACP_WRITE_TIMEOUT_MS = 10_000;
const CANCEL_GRACE_MS = 5_000;
const CANCEL_ESCALATION_MS = 2_000;
const APPROVAL_TIMEOUT_MS = 120_000;
const RETIRED_TOOL_CALL_LIMIT = 512;
const CURSOR_MODEL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:/[\]-]*$/;
const IMAGE_EXT_RE = /\.(?:png|jpe?g|gif|webp|bmp|svg)$/i;
const AUTH_ACTION_HINT = "Cursor authentication required or expired. Run 'agent login' or set CURSOR_API_KEY, then retry.";

export interface CursorAcpRuntimeHooks {
  loadChildProcess(): Promise<typeof import('node:child_process')>;
}

export const cursorAcpRuntimeHooks: CursorAcpRuntimeHooks = {
  loadChildProcess: async () => import('node:child_process'),
};

interface CursorAcpExtraMcpServerConfig {
  type?: 'http' | 'sse' | 'stdio';
  name: string;
  url?: string;
  headers?: Array<{ name: string; value: string }> | Record<string, string>;
  command?: string;
  args?: string[];
  env?: Array<{ name: string; value: string }> | Record<string, string>;
}

interface CursorMergedToolCall {
  toolCallId: string;
  title: string;
  kind?: string;
  status: string;
  content: ToolCallContent[];
  rawInput?: unknown;
  rawOutput?: unknown;
}

interface PendingApprovalEntry {
  routeId: string;
  options: RequestPermissionRequest['options'];
  resolve: (res: RequestPermissionResponse) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface WireSlot {
  waitForPrior?: Promise<void>;
  release: () => void;
}

interface CursorAcpSessionState {
  routeId: string;
  sessionName?: string;
  projectName?: string;
  serverId?: string;
  cwd: string;
  env?: Record<string, string>;
  contextNamespace?: SessionConfig['contextNamespace'];
  mcpEnv?: Record<string, string>;
  model?: string;
  confirmedModel?: string;
  attemptedModel?: string;
  acpSessionId?: string;
  loaded: boolean;
  replaying: boolean;
  promptInFlight: boolean;
  cancelled: boolean;
  compacting: boolean;
  compactedInTurn: boolean;
  turnGeneration: number;
  settledGeneration: number;
  currentMessageId: string | null;
  currentText: string;
  lastTurnUsage?: NonNullable<ProviderUsageUpdate['usage']>;
  lastStatusSignature: string | null;
  sessionSystemTextInjected?: string;
  modelConfigOptionId?: string;
  availableCommands: Set<string>;
  toolCalls: Map<string, CursorMergedToolCall>;
  emittedToolSignatures: Map<string, string>;
  retiredToolCallIds: Set<string>;
  wireOrderTail?: Promise<void>;
  cancelGraceTimer?: ReturnType<typeof setTimeout>;
  cancelGraceGeneration?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isTruthyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function normalizeCursorModelId(value: unknown): string | undefined {
  if (!isTruthyString(value)) return undefined;
  const trimmed = value.trim();
  return CURSOR_MODEL_ID_RE.test(trimmed) ? trimmed : undefined;
}

function nonNegativeNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function positiveNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

function cursorMcpEnsureOptionsFromConfig(config: ProviderConfig): CursorMcpEnsureOptions {
  const configPath = isTruthyString(config.cursorMcpConfigPath)
    ? config.cursorMcpConfigPath.trim()
    : undefined;
  return configPath ? { configPath, skipTestDefaultPath: false } : {};
}

function buildCursorMemoryMcpEnv(config: SessionConfig): Record<string, string> | undefined {
  const env = getDefaultMcpServers(config)[IMCODES_MEMORY_MCP_SERVER_NAME]?.env;
  return env && Object.keys(env).length > 0 ? env : undefined;
}

function formatErrorMessage(err: unknown): string {
  if (err && typeof err === 'object') {
    const rec = err as { message?: unknown; data?: unknown };
    const dataMsg = isRecord(rec.data) && isTruthyString(rec.data.message) ? rec.data.message.trim() : undefined;
    if (dataMsg) return dataMsg;
    if (isTruthyString(rec.message)) return rec.message.trim();
  }
  return err instanceof Error ? err.message : String(err);
}

function isAuthErrorLike(err: unknown): boolean {
  if (isRecord(err) && err.code === PROVIDER_ERROR_CODES.AUTH_FAILED) return true;
  if (isRecord(err) && err.code === -32000) return true;
  if (err instanceof RequestError && err.code === -32000) return true;
  const msg = formatErrorMessage(err);
  return /auth(?:entication)?\s*required|not\s+logged\s+in|agent\s+login|cursor_login|unauth|invalid\s+api\s+key|expired\s+token/i.test(msg);
}

function extractModelContextWindow(record: Record<string, unknown>): number | undefined {
  const limit = isRecord(record.limit) ? record.limit : undefined;
  const meta = isRecord(record._meta) ? record._meta : undefined;
  const metaLimit = meta && isRecord(meta.limit) ? meta.limit : undefined;
  return (
    positiveNumber(record.contextWindow)
    ?? positiveNumber(record.context_window)
    ?? positiveNumber(record.model_context_window)
    ?? positiveNumber(record.maxContextTokens)
    ?? positiveNumber(record.max_context_tokens)
    ?? positiveNumber(record.size)
    ?? positiveNumber(limit?.context)
    ?? positiveNumber(limit?.contextWindow)
    ?? positiveNumber(meta?.contextWindow)
    ?? positiveNumber(meta?.context_window)
    ?? positiveNumber(meta?.model_context_window)
    ?? positiveNumber(metaLimit?.context)
  );
}

function extractTextFromContent(block: ContentBlock): string {
  if (!block || typeof block !== 'object') return '';
  if (block.type === 'text' && typeof block.text === 'string') return block.text;
  return '';
}

function flattenToolContent(content: ToolCallContent[]): string | undefined {
  if (!Array.isArray(content) || content.length === 0) return undefined;
  const parts: string[] = [];
  for (const item of content) {
    if (!item || typeof item !== 'object') continue;
    if (item.type === 'content' && item.content?.type === 'text' && typeof item.content.text === 'string') {
      parts.push(item.content.text);
    } else if (item.type === 'diff' && typeof item.newText === 'string') {
      parts.push(item.newText);
    }
  }
  return parts.length > 0 ? parts.join('\n') : undefined;
}

function mapToolStatus(status: string): 'running' | 'complete' | 'error' {
  switch (status) {
    case 'completed':
    case 'complete':
      return 'complete';
    case 'failed':
    case 'cancelled':
    case 'canceled':
    case 'error':
      return 'error';
    case 'pending':
    case 'in_progress':
    default:
      return 'running';
  }
}

function guessImageMimeType(attachment: TransportAttachment): string | undefined {
  const mime = attachment.mime?.trim().toLowerCase();
  if (mime && mime.startsWith('image/')) return mime;
  const nameOrPath = (attachment.originalName || attachment.daemonPath).toLowerCase();
  if (!IMAGE_EXT_RE.test(nameOrPath)) return undefined;
  if (nameOrPath.endsWith('.png')) return 'image/png';
  if (nameOrPath.endsWith('.jpg') || nameOrPath.endsWith('.jpeg')) return 'image/jpeg';
  if (nameOrPath.endsWith('.gif')) return 'image/gif';
  if (nameOrPath.endsWith('.webp')) return 'image/webp';
  if (nameOrPath.endsWith('.bmp')) return 'image/bmp';
  if (nameOrPath.endsWith('.svg')) return 'image/svg+xml';
  return undefined;
}

function normalizeHttpHeaders(
  headers: Array<{ name: string; value: string }> | Record<string, string> | undefined,
): Array<{ name: string; value: string }> {
  if (!headers) return [];
  if (Array.isArray(headers)) {
    return headers
      .filter((h) => h && isTruthyString(h.name) && typeof h.value === 'string')
      .map((h) => ({ name: h.name.trim(), value: h.value }));
  }
  return Object.entries(headers)
    .filter(([name, value]) => isTruthyString(name) && typeof value === 'string')
    .map(([name, value]) => ({ name: name.trim(), value }));
}

function normalizeStdioEnv(
  env: Array<{ name: string; value: string }> | Record<string, string> | undefined,
): Array<{ name: string; value: string }> {
  if (!env) return [];
  if (Array.isArray(env)) {
    return env
      .filter((e) => e && isTruthyString(e.name) && typeof e.value === 'string')
      .map((e) => ({ name: e.name.trim(), value: e.value }));
  }
  return Object.entries(env)
    .filter(([name, value]) => isTruthyString(name) && typeof value === 'string')
    .map(([name, value]) => ({ name: name.trim(), value }));
}

/**
 * Normalize ACP usage frames (`session/update` `usage_update` or `PromptResponse.usage` / `_meta`)
 * into `ProviderUsageUpdate['usage']` consumed by `transport-relay.ts` and the UI context bar.
 */
export function normalizeCursorAcpUsage(
  raw: Record<string, unknown> | null | undefined,
  fallbackContextWindow?: number,
): NonNullable<ProviderUsageUpdate['usage']> | undefined {
  if (!raw) return undefined;
  const nestedTokens = isRecord(raw.tokens) ? raw.tokens : undefined;
  const nestedUsage = isRecord(raw.usage) ? raw.usage : undefined;
  const meta = isRecord(raw._meta) ? raw._meta : undefined;
  const metaUsage = meta && isRecord(meta.usage) ? meta.usage : undefined;
  const sources = [nestedTokens, nestedUsage, metaUsage, meta, raw].filter((s): s is Record<string, unknown> => !!s);

  const pickNonNeg = (...keys: string[]): number | undefined => {
    for (const src of sources) {
      for (const key of keys) {
        const num = nonNegativeNumber(src[key]);
        if (num !== undefined) return num;
      }
    }
    return undefined;
  };
  const pickPos = (...keys: string[]): number | undefined => {
    for (const src of sources) {
      for (const key of keys) {
        const num = positiveNumber(src[key]);
        if (num !== undefined) return num;
      }
      if (isRecord(src.limit)) {
        const ctx = positiveNumber(src.limit.context) ?? positiveNumber(src.limit.contextWindow);
        if (ctx !== undefined) return ctx;
      }
    }
    return undefined;
  };

  const explicitInput = pickNonNeg('input_tokens', 'inputTokens');
  const used = nonNegativeNumber(raw.used) ?? pickNonNeg('used');
  const outputTokens = pickNonNeg('output_tokens', 'outputTokens');
  const cachedTokens = pickNonNeg(
    'cache_read_input_tokens',
    'cached_input_tokens',
    'cachedInputTokens',
    'cachedReadTokens',
    'cache_read_tokens',
    'cacheReadTokens',
  );
  const cacheWriteTokens = pickNonNeg(
    'cache_creation_input_tokens',
    'cachedWriteTokens',
    'cacheCreationInputTokens',
    'cache_write_tokens',
    'cacheWriteTokens',
  );
  const thoughtTokens = pickNonNeg('thought_tokens', 'thoughtTokens');
  const totalTokens = pickNonNeg('total_tokens', 'totalTokens');
  const contextWindow =
    positiveNumber(raw.size)
    ?? pickPos('size', 'model_context_window', 'contextWindow', 'context_window', 'contextWindowSize', 'maxContextTokens')
    ?? (fallbackContextWindow && fallbackContextWindow > 0 ? fallbackContextWindow : undefined);

  // ACP `UsageUpdate.used` represents live context occupancy when discrete inputTokens is absent.
  const inputTokens = explicitInput ?? (
    used !== undefined
      ? (cachedTokens !== undefined && used >= cachedTokens ? used - cachedTokens : (cachedTokens === undefined ? used : undefined))
      : undefined
  );
  if (
    inputTokens === undefined
    && outputTokens === undefined
    && cachedTokens === undefined
    && cacheWriteTokens === undefined
    && contextWindow === undefined
    && totalTokens === undefined
  ) {
    return undefined;
  }

  return {
    ...(inputTokens !== undefined ? { input_tokens: inputTokens } : {}),
    ...(outputTokens !== undefined ? { output_tokens: outputTokens } : {}),
    ...(cachedTokens !== undefined ? { cached_input_tokens: cachedTokens, cache_read_input_tokens: cachedTokens } : {}),
    ...(cacheWriteTokens !== undefined ? { cache_creation_input_tokens: cacheWriteTokens } : {}),
    ...(thoughtTokens !== undefined ? { thought_tokens: thoughtTokens } : {}),
    ...(totalTokens !== undefined ? { total_tokens: totalTokens } : {}),
    ...(contextWindow !== undefined ? { model_context_window: contextWindow } : {}),
  };
}

/**
 * Cursor ACP TransportProvider (`agent acp` / `cursor-agent acp`).
 * Keeps `id = 'cursor-headless'` so existing persisted sessions and UI config work transparently.
 */
export class CursorAcpProvider implements TransportProvider {
  readonly id = CURSOR_PROVIDER_ID;
  readonly connectionMode = CONNECTION_MODES.LOCAL_SDK;
  readonly sessionOwnership = SESSION_OWNERSHIP.SHARED;
  readonly capabilities: ProviderCapabilities = {
    streaming: true,
    toolCalling: true,
    approval: true,
    sessionRestore: true,
    multiTurn: true,
    attachments: true,
    reasoningEffort: false,
    contextSupport: 'degraded-message-side-context-mapping',
    activeDelegationNotification: AGENT_DELEGATION_ACTIVE_NOTIFICATION_MODES.UNSUPPORTED,
    compact: {
      execution: 'unsupported',
      verified: true,
      completion: 'none',
      cancellation: 'none',
      reason: 'Cursor agent acp does not advertise static compaction; dynamic /compact passes through and compaction_update drives compaction status.',
    },
    nativeAgentAdmission: NATIVE_AGENT_ADMISSION_MODES.UNENFORCEABLE,
  };

  private config: ProviderConfig | null = null;
  private child: ChildProcessWithoutNullStreams | null = null;
  private connection: AcpClientConnection | null = null;
  private connectInFlight: Promise<void> | null = null;
  private isDisconnecting = false;
  private loadSessionSupported = true;
  private sessionListSupported = false;
  private imageAttachmentSupported = true;
  private mcpHttpSupported = false;
  private mcpSseSupported = false;
  private supportedAuthMethodIds = new Set<string>();
  private authenticated = false;
  private mcpRegistration: CursorMcpEnsureResult | null = null;
  private cachedModels: ProviderModelInfo[] | null = null;
  private cachedDefaultModel: string | null = null;
  private modelContextWindows = new Map<string, number>();

  private sessions = new Map<string, CursorAcpSessionState>();
  private acpToRoute = new Map<string, string>();
  private pendingApprovals = new Map<string, PendingApprovalEntry>();
  private pendingUpdateSlots = new WeakMap<object, WireSlot>();
  private promptTerminals = new WeakMap<CursorAcpSessionState, Promise<unknown>>();
  private stopTargets = new WeakMap<CursorAcpSessionState, { terminal: Promise<void>; complete: () => void }>();
  private promptWriteQueues = new WeakMap<AcpClientConnection, {
    pending: Map<string, Array<{ onResponseArrived: () => void; clearPending: () => void }>>;
    reserveSlot: (state: CursorAcpSessionState) => WireSlot;
  }>();

  private deltaCallbacks: Array<(sessionId: string, delta: MessageDelta) => void> = [];
  private completeCallbacks: Array<(sessionId: string, message: AgentMessage) => void> = [];
  private errorCallbacks: Array<(sessionId: string, error: ProviderError) => void> = [];
  private toolCallCallbacks: Array<(sessionId: string, tool: ToolCallEvent) => void> = [];
  private sessionInfoCallbacks: Array<(sessionId: string, info: SessionInfoUpdate) => void> = [];
  private statusCallbacks: Array<(sessionId: string, status: ProviderStatusUpdate) => void> = [];
  private usageCallbacks = new Set<(sessionId: string, update: ProviderUsageUpdate) => void>();
  private approvalCallbacks: Array<(sessionId: string, req: ApprovalRequest) => void> = [];

  async connect(config: ProviderConfig): Promise<void> {
    this.config = config;
    await this.ensureConnected(config);
    this.mcpRegistration = await ensureCursorMcpJsonHasImcodesEntry(cursorMcpEnsureOptionsFromConfig(config)).catch((err) => {
      logger.warn({ provider: this.id, err }, 'Cursor MCP auto-configuration failed; continuing with per-session ACP MCP servers');
      return {
        serverName: IMCODES_MEMORY_MCP_SERVER_NAME,
        configPath: '',
        changed: false,
        degraded: true as const,
        reason: MEMORY_MCP_PROVIDER_STATUS_REASON.MCP_REGISTRATION_FAILED,
      };
    });
  }

  async disconnect(): Promise<void> {
    this.isDisconnecting = true;
    try {
      this.cancelAllPendingApprovals();
      for (const state of this.sessions.values()) {
        state.cancelled = true;
        state.compacting = false;
        this.clearCancelGraceTimer(state);
        this.clearStatus(state.routeId, state);
      }
      await this.teardownChild();
      this.sessions.clear();
      this.acpToRoute.clear();
      this.cachedModels = null;
      this.cachedDefaultModel = null;
      this.modelContextWindows.clear();
      this.supportedAuthMethodIds.clear();
      this.authenticated = false;
      this.config = null;
      this.connectInFlight = null;
    } finally {
      this.isDisconnecting = false;
    }
  }

  getMemoryMcpStatus(): MemoryMcpProviderStatusView {
    const ready = Boolean(this.config && this.connection);
    if (this.mcpRegistration?.degraded) {
      return {
        providerId: this.id,
        status: MEMORY_MCP_STATUS.DEGRADED,
        connected: ready,
        degradedReasons: [
          this.mcpRegistration.reason ?? MEMORY_MCP_PROVIDER_STATUS_REASON.MCP_REGISTRATION_FAILED,
        ],
      };
    }
    return {
      providerId: this.id,
      status: ready ? MEMORY_MCP_STATUS.READY : MEMORY_MCP_STATUS.UNKNOWN,
      connected: ready,
      degradedReasons: [],
    };
  }

  getSessionDiagnostics(sessionId: string): Record<string, unknown> | null {
    const resolved = this.findSessionByAnyId(sessionId);
    if (!resolved) return null;
    const [routeId, state] = resolved;
    const activeReason = state.compacting
      ? 'compacting'
      : state.promptInFlight
        ? 'prompt'
        : state.replaying
          ? 'history-replay'
          : null;
    return {
      provider: this.id,
      routeId,
      active: activeReason !== null,
      activeReason,
      acpSessionId: state.acpSessionId ?? null,
      loaded: state.loaded,
      promptInFlight: state.promptInFlight,
      compacting: state.compacting,
      replaying: state.replaying,
      cancelled: state.cancelled,
      currentMessageId: state.currentMessageId,
      currentTextLength: state.currentText.length,
      toolCallCount: state.toolCalls.size,
      emittedToolSignatureCount: state.emittedToolSignatures.size,
      sessionSystemTextInjected: Boolean(state.sessionSystemTextInjected),
      lastTurnUsagePresent: Boolean(state.lastTurnUsage),
    };
  }

  getCachedModels(): ProviderModelList | null {
    if (!this.cachedModels || this.cachedModels.length === 0) return null;
    return {
      models: this.cachedModels,
      ...(this.cachedDefaultModel ? { defaultModel: this.cachedDefaultModel } : {}),
      isAuthenticated: true,
    };
  }

  async listModels(force?: boolean): Promise<ProviderModelList> {
    if (force) {
      this.cachedModels = null;
      this.cachedDefaultModel = null;
    }
    let authError: string | undefined;
    if ((!this.cachedModels || force) && this.connection) {
      const connection = this.connection;
      try {
        const cwd = normalizeTransportCwd(process.cwd()) ?? '/';
        const result = await this.withAuthRetry(() => this.runWithTimeout(
          'Cursor ACP model probe',
          SESSION_RPC_TIMEOUT_MS,
          () => connection.newSession({ cwd, mcpServers: [] }),
        ));
        this.captureSessionModels(result);
        const closer = connection.closeSession;
        if (typeof closer === 'function') {
          void closer.call(connection, { sessionId: result.sessionId }).catch(() => {});
        }
      } catch (err) {
        if (isAuthErrorLike(err)) {
          authError = AUTH_ACTION_HINT;
        } else {
          logger.debug({ provider: this.id, message: formatErrorMessage(err) }, 'Cursor ACP model probe failed (falling back to CLI)');
        }
      }
    }
    if (this.cachedModels && this.cachedModels.length > 0) {
      return {
        models: this.cachedModels,
        ...(this.cachedDefaultModel ? { defaultModel: this.cachedDefaultModel } : {}),
        isAuthenticated: true,
      };
    }
    if (authError) {
      return {
        models: [],
        isAuthenticated: false,
        error: authError,
      };
    }
    try {
      const cfg = await getCursorRuntimeConfig(force ?? false);
      return {
        models: cfg.availableModels.map((id) => ({ id })),
        ...(cfg.defaultModel ? { defaultModel: cfg.defaultModel } : {}),
        isAuthenticated: cfg.isAuthenticated,
        ...(!cfg.isAuthenticated ? { error: AUTH_ACTION_HINT } : {}),
      };
    } catch (err) {
      return { models: [], isAuthenticated: false, error: formatErrorMessage(err) };
    }
  }

  async listSessions(options: RemoteSessionListOptions = {}): Promise<RemoteSessionInfo[]> {
    if (!this.connection && this.config) {
      await this.ensureConnected(this.config).catch(() => {});
    }
    const connection = this.connection;
    if (!connection?.listSessions || !this.sessionListSupported) return [];

    const directoryRequested = options.directory !== undefined;
    const queryDirectory = normalizeTransportCwd(options.directory);
    const expectedDirectory = canonicalizeTransportCwd(options.directory);
    if (directoryRequested && (!queryDirectory || !expectedDirectory)) return [];

    const sessions: RemoteSessionInfo[] = [];
    const seenCursors = new Set<string>();
    let cursor: string | undefined;
    do {
      const result = await this.withAuthRetry(() => this.runWithTimeout(
        'Cursor ACP session/list',
        SESSION_RPC_TIMEOUT_MS,
        () => connection.listSessions!({
          ...(queryDirectory ? { cwd: queryDirectory } : {}),
          ...(cursor ? { cursor } : {}),
        }),
      ));
      for (const session of result.sessions) {
        const directory = canonicalizeTransportCwd(session.cwd);
        if (!directory || (expectedDirectory && directory !== expectedDirectory)) continue;
        const updatedAt = session.updatedAt ? Date.parse(session.updatedAt) : Number.NaN;
        sessions.push({
          key: session.sessionId,
          ...(session.title ? { displayName: session.title } : {}),
          directory: session.cwd.trim(),
          ...(Number.isFinite(updatedAt) ? { updatedAt } : {}),
        });
      }
      const nextCursor = result.nextCursor ?? undefined;
      if (!nextCursor || seenCursors.has(nextCursor)) break;
      seenCursors.add(nextCursor);
      cursor = nextCursor;
    } while (cursor);
    return sessions;
  }

  async createSession(config: SessionConfig): Promise<string> {
    const routeId = config.bindExistingKey ?? config.sessionKey;
    const existing = config.fresh ? undefined : this.findSessionByRouteId(routeId)?.[1];
    if (existing) {
      const requestedModel = normalizeCursorModelId(config.agentId ?? config.model);
      if (requestedModel) existing.model = requestedModel;
      if (isTruthyString(config.resumeId) && !existing.acpSessionId) {
        existing.acpSessionId = config.resumeId.trim();
        this.acpToRoute.set(existing.acpSessionId, routeId);
      }
      this.emitSessionInfo(routeId, {
        ...(existing.acpSessionId ? { resumeId: existing.acpSessionId } : {}),
        ...(existing.model ? { model: existing.model } : {}),
      });
      return routeId;
    }

    if (config.fresh && this.sessions.has(routeId)) {
      await this.endSession(routeId).catch(() => {});
    }

    const cwd = normalizeTransportCwd(config.cwd) ?? normalizeTransportCwd(process.cwd()) ?? '/';
    const requestedModel = normalizeCursorModelId(config.agentId ?? config.model) ?? this.resolveDefaultModel();
    const acpSessionId = isTruthyString(config.resumeId) ? config.resumeId.trim() : undefined;

    const state: CursorAcpSessionState = {
      routeId,
      sessionName: config.sessionName,
      projectName: config.projectName,
      serverId: config.serverId,
      cwd,
      env: config.env,
      contextNamespace: config.contextNamespace,
      mcpEnv: buildCursorMemoryMcpEnv(config),
      model: requestedModel,
      confirmedModel: undefined,
      attemptedModel: undefined,
      acpSessionId,
      loaded: false,
      replaying: false,
      promptInFlight: false,
      cancelled: false,
      compacting: false,
      compactedInTurn: false,
      turnGeneration: 0,
      settledGeneration: 0,
      currentMessageId: null,
      currentText: '',
      lastTurnUsage: undefined,
      lastStatusSignature: null,
      availableCommands: new Set(),
      toolCalls: new Map(),
      emittedToolSignatures: new Map(),
      retiredToolCallIds: new Set(),
    };

    this.sessions.set(routeId, state);
    if (acpSessionId) {
      this.acpToRoute.set(acpSessionId, routeId);
    }
    this.emitSessionInfo(routeId, {
      ...(acpSessionId ? { resumeId: acpSessionId } : {}),
      ...(requestedModel ? { model: requestedModel } : {}),
    });
    return routeId;
  }

  async restoreSession(sessionId: string): Promise<boolean> {
    const resolved = this.findSessionByAnyId(sessionId);
    if (!resolved) return false;
    const [routeId, state] = resolved;
    if (state.loaded) return true;
    try {
      if (!this.connection && this.config) {
        await this.ensureConnected(this.config);
      }
      if (!state.acpSessionId || !this.connection) return true;
      await this.ensureSessionReady(routeId, state);
      return true;
    } catch {
      return false;
    }
  }

  async endSession(sessionId: string): Promise<void> {
    const resolved = this.findSessionByAnyId(sessionId);
    if (!resolved) return;
    const [routeId, state] = resolved;
    state.cancelled = true;
    state.compacting = false;
    this.clearCancelGraceTimer(state);
    this.cancelPendingApprovals(routeId);
    this.clearStatus(routeId, state);
    this.sessions.delete(routeId);
    if (state.acpSessionId && this.acpToRoute.get(state.acpSessionId) === routeId) {
      this.acpToRoute.delete(state.acpSessionId);
      const closer = this.connection?.closeSession;
      if (state.loaded && typeof closer === 'function') {
        await closer.call(this.connection, { sessionId: state.acpSessionId }).catch(() => {});
      }
    }
  }

  async detachSession(sessionId: string): Promise<void> {
    const resolved = this.findSessionByAnyId(sessionId);
    if (!resolved) return;
    const [routeId, state] = resolved;
    state.cancelled = true;
    state.compacting = false;
    this.clearCancelGraceTimer(state);
    this.cancelPendingApprovals(routeId);
    this.clearStatus(routeId, state);
    this.sessions.delete(routeId);
    if (state.acpSessionId && this.acpToRoute.get(state.acpSessionId) === routeId) {
      this.acpToRoute.delete(state.acpSessionId);
    }
  }

  setSessionAgentId(sessionId: string, agentId: string): void {
    const resolved = this.findSessionByAnyId(sessionId);
    if (!resolved) return;
    const [routeId, state] = resolved;
    const model = normalizeCursorModelId(agentId);
    if (!model) return;
    state.model = model;
    this.emitSessionInfo(routeId, {
      ...(state.acpSessionId ? { resumeId: state.acpSessionId } : {}),
      model,
    });
    if (state.loaded && state.acpSessionId && this.connection) {
      void this.applyModelOnConnection(state, model).catch((err) => {
        logger.debug({ provider: this.id, routeId, model, message: formatErrorMessage(err) }, 'Cursor ACP set model failed (non-fatal)');
      });
    }
  }

  async applySessionModel(sessionId: string, agentId: string): Promise<SessionModelApplied> {
    const resolved = this.findSessionByAnyId(sessionId);
    if (!resolved) {
      throw this.makeError(PROVIDER_ERROR_CODES.SESSION_NOT_FOUND, `Unknown Cursor session: ${sessionId}`, false);
    }
    const [routeId, state] = resolved;
    const model = normalizeCursorModelId(agentId);
    if (!model) {
      throw this.makeError(PROVIDER_ERROR_CODES.CONFIG_ERROR, `Invalid Cursor model id: ${agentId}`, false);
    }
    state.model = model;
    state.attemptedModel = undefined;
    if (!state.loaded || !state.acpSessionId || !this.connection) {
      return SESSION_MODEL_APPLIED.NEXT_START;
    }
    state.attemptedModel = model;
    await this.applyModelOnConnection(state, model);
    this.emitSessionInfo(routeId, {
      resumeId: state.acpSessionId,
      model,
    });
    return state.promptInFlight ? SESSION_MODEL_APPLIED.NEXT_START : SESSION_MODEL_APPLIED.LIVE;
  }

  refreshSessionSystemText(sessionId: string): void {
    const state = this.findSessionByAnyId(sessionId)?.[1];
    if (!state) return;
    state.sessionSystemTextInjected = undefined;
  }

  async send(
    sessionId: string,
    payloadOrMessage: string | ProviderContextPayload,
    attachments?: TransportAttachment[],
    extraSystemPrompt?: string,
  ): Promise<void> {
    if (!this.config) {
      throw this.makeError(PROVIDER_ERROR_CODES.CONNECTION_LOST, 'Cursor ACP provider not connected', false);
    }
    const resolved = this.findSessionByAnyId(sessionId);
    if (!resolved) {
      throw this.makeError(PROVIDER_ERROR_CODES.SESSION_NOT_FOUND, `Unknown Cursor session: ${sessionId}`, false);
    }
    const [routeId, state] = resolved;
    if (!this.connection || !this.child || this.child.killed || this.child.exitCode != null) {
      await this.ensureConnected(this.config);
    }
    if (!this.connection) {
      throw this.makeError(PROVIDER_ERROR_CODES.CONNECTION_LOST, 'Cursor ACP server not connected', false);
    }
    if (state.promptInFlight) {
      throw this.makeError(PROVIDER_ERROR_CODES.PROVIDER_ERROR, 'Cursor session is already busy', true);
    }

    state.cancelled = false;
    state.compacting = false;
    state.compactedInTurn = false;
    state.lastTurnUsage = undefined;
    state.lastStatusSignature = null;
    this.retireOpenToolCalls(state);

    const generation = ++state.turnGeneration;
    let completeStop!: () => void;
    const stopTerminal = new Promise<void>((resolve) => {
      completeStop = resolve;
    });
    this.stopTargets.set(state, { terminal: stopTerminal, complete: completeStop });
    state.promptInFlight = true;

    const payload = normalizeProviderPayload(payloadOrMessage, attachments, extraSystemPrompt);
    this.emitStatus(routeId, state, { status: 'connecting', label: 'Connecting…' });

    try {
      await this.ensureSessionReady(routeId, state, generation);
      this.assertCurrentTurn(routeId, state, generation);

      state.currentText = '';
      state.currentMessageId = null;

      const sessionSystemText = getProviderSystemTextParts(payload).sessionSystemText;
      const sessionContractKey = sessionSystemContractKey(sessionSystemText);
      const isSlashControl = payload.userMessage?.trim().startsWith('/') === true;
      const compactControl = isSessionControlCommandText(payload.userMessage, 'compact');
      const includeSessionSystemText = isSlashControl
        ? false
        : shouldInjectSessionSystemContract(state.sessionSystemTextInjected, sessionSystemText);

      const promptBlocks = isSlashControl
        ? [{ type: 'text' as const, text: payload.assembledMessage || payload.userMessage }]
        : await this.buildPromptContent(payload, includeSessionSystemText);
      this.assertCurrentTurn(routeId, state, generation);

      this.emitStatus(routeId, state, { status: 'thinking', label: 'Thinking…' });
      const connection = this.connection!;
      const turn = connection.prompt({
        sessionId: state.acpSessionId!,
        prompt: promptBlocks,
        messageId: randomUUID(),
      });
      this.promptTerminals.set(state, turn);
      this.trackPromptSettlement(
        connection,
        state.acpSessionId!,
        state,
        turn,
        (result) => {
          this.settleTurn(
            routeId,
            state,
            generation,
            result,
            includeSessionSystemText ? sessionContractKey : undefined,
            compactControl,
          );
        },
        (err) => {
          this.failTurn(routeId, state, generation, err);
        },
      );

      const writeOk = await this.waitForAcpWrite(connection);
      if (!writeOk) {
        throw this.makeError(PROVIDER_ERROR_CODES.CONNECTION_LOST, 'Cursor ACP prompt write failed', true);
      }
    } catch (err) {
      this.failTurn(routeId, state, generation, err);
      throw this.normalizeError(err);
    }
  }

  cancelAndWait(sessionId: string): Promise<void> {
    const resolved = this.findSessionByAnyId(sessionId);
    if (!resolved) return Promise.reject(new Error('Unknown Cursor ACP session'));
    const [routeId, state] = resolved;
    const target = this.stopTargets.get(state);
    if (!target || !state.promptInFlight) {
      return Promise.reject(new Error('Cursor ACP prompt terminal unavailable'));
    }
    const generation = state.turnGeneration;
    return confirmPromiseStop(
      target,
      target.terminal,
      () => this.cancel(routeId),
      () => this.sessions.get(routeId) === state && state.turnGeneration === generation,
    );
  }

  async cancel(sessionId: string, options?: ProviderCancelOptions): Promise<void> {
    const resolved = this.findSessionByAnyId(sessionId);
    if (!resolved) return;
    const [routeId, state] = resolved;
    this.cancelPendingApprovals(routeId);
    this.retireOpenToolCalls(state);
    state.compacting = false;
    this.clearStatus(routeId, state);

    if (!state.promptInFlight) return;
    state.cancelled = true;
    const generation = state.turnGeneration;
    const connection = this.connection;
    if (!state.acpSessionId || !connection) {
      this.forceFailWedgedTurn(routeId, state, generation, 'Cursor turn cancelled');
      return;
    }

    const cancelNotify = connection.cancel({ sessionId: state.acpSessionId }).catch((err: unknown) => {
      logger.debug({ provider: this.id, routeId, message: formatErrorMessage(err) }, 'Cursor ACP cancel failed (non-fatal)');
    });
    const isStaleWatchdog = options?.origin === PROVIDER_CANCEL_ORIGINS.STALE_WATCHDOG;
    if (!isStaleWatchdog) {
      this.armCancelGraceTimer(routeId, state, generation);
      await Promise.race([
        cancelNotify,
        new Promise<void>((resolve) => {
          const t = setTimeout(resolve, CANCEL_ESCALATION_MS);
          t.unref?.();
        }),
      ]);
      return;
    }

    await Promise.race([
      cancelNotify,
      new Promise<void>((resolve) => setTimeout(resolve, CANCEL_ESCALATION_MS)),
    ]);
    const terminal = this.promptTerminals.get(state);
    if (terminal && this.sessions.get(routeId) === state && state.promptInFlight && state.turnGeneration === generation) {
      await Promise.race([
        terminal.catch(() => {}),
        new Promise<void>((resolve) => setTimeout(resolve, 1_000)),
      ]);
    }
    if (this.sessions.get(routeId) === state && state.promptInFlight && state.turnGeneration === generation) {
      this.forceFailWedgedTurn(routeId, state, generation, 'Cursor ACP turn cancelled on stale watchdog');
    }
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
    this.usageCallbacks.add(cb);
    return () => {
      this.usageCallbacks.delete(cb);
    };
  }

  onApprovalRequest(cb: (sessionId: string, req: ApprovalRequest) => void): void {
    this.approvalCallbacks.push(cb);
  }

  async respondApproval(sessionId: string, requestId: string, approved: boolean): Promise<void> {
    const resolvedRoute = this.findSessionByAnyId(sessionId)?.[0] ?? sessionId;
    const pending = this.pendingApprovals.get(requestId);
    if (!pending || (pending.routeId !== resolvedRoute && pending.routeId !== sessionId)) return;
    this.pendingApprovals.delete(requestId);
    clearTimeout(pending.timer);
    const selected = pending.options.find((option) => approved
      ? option.kind === 'allow_once' || option.kind === 'allow_always'
      : option.kind === 'reject_once' || option.kind === 'reject_always');
    pending.resolve(selected
      ? { outcome: { outcome: 'selected', optionId: selected.optionId } }
      : { outcome: { outcome: 'cancelled' } });
  }

  // ── Internal ACP connection lifecycle ────────────────────────────────────

  private async ensureConnected(config: ProviderConfig): Promise<void> {
    if (this.connection && this.child && !this.child.killed && this.child.exitCode == null) return;
    if (this.connectInFlight) return await this.connectInFlight;

    const run = this.startAcpProcess(config).finally(() => {
      if (this.connectInFlight === run) this.connectInFlight = null;
    });
    this.connectInFlight = run;
    await run;
  }

  private async startAcpProcess(config: ProviderConfig): Promise<void> {
    await this.teardownChild();
    const resolved = await this.resolveDirectExecutableWithStagedPromote(config);
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...((config.env && typeof config.env === 'object' ? config.env : {}) as NodeJS.ProcessEnv),
      ...(isTruthyString(config.apiKey) ? { CURSOR_API_KEY: config.apiKey.trim() } : {}),
      ...(isTruthyString(config.token) ? { CURSOR_AUTH_TOKEN: config.token.trim() } : {}),
    };
    const spawnCwd = normalizeTransportCwd(process.cwd()) ?? '/';
    const { spawn } = await cursorAcpRuntimeHooks.loadChildProcess();
    const child = spawn(resolved.executable, [...resolved.prependArgs, 'acp'], {
      detached: process.platform !== 'win32',
      cwd: spawnCwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
      windowsHide: true,
    }) as ChildProcessWithoutNullStreams;

    this.child = child;
    this.authenticated = false;
    this.supportedAuthMethodIds.clear();

    const spawnFailure = new Promise<never>((_resolve, reject) => {
      child.once('error', (err) => reject(this.normalizeConnectError(err, 'Cursor ACP process failed to start')));
    });

    child.stderr?.on('data', (chunk: Buffer | string) => {
      const text = chunk.toString().trim();
      if (text) logger.debug({ provider: this.id, stderrBytes: Buffer.byteLength(text) }, 'Cursor ACP stderr');
    });

    const writable = Writable.toWeb(child.stdin) as WritableStream<Uint8Array>;
    const readable = Readable.toWeb(
      filterAcpJsonLines(gateChildStream(child.stdout), (line, n) => {
        if (n === 1 || n % 200 === 0) {
          logger.debug({ provider: this.id, droppedCount: n, sample: line.slice(0, 160) }, 'Cursor ACP dropped non-JSON stdout line');
        }
      }),
    ) as ReadableStream<Uint8Array>;
    const rawStream = ndJsonStream(writable, readable);

    const pendingPromptWrites = new Map<string, Array<{ onResponseArrived: () => void; clearPending: () => void }>>();
    const inFlightPromptWrites = new Map<string | number, { onResponseArrived: () => void; clearPending: () => void }>();
    const activeSlotReleasers = new Set<() => void>();
    const reserveSlot = (state: CursorAcpSessionState): WireSlot => {
      const waitForPrior = state.wireOrderTail;
      let resolveSlot!: () => void;
      const slot = new Promise<void>((r) => {
        resolveSlot = r;
      });
      state.wireOrderTail = slot;
      const release = (): void => {
        if (!activeSlotReleasers.delete(release)) return;
        if (state.wireOrderTail === slot) state.wireOrderTail = undefined;
        resolveSlot();
      };
      activeSlotReleasers.add(release);
      return { waitForPrior, release };
    };
    const releaseAllSlots = (): void => {
      for (const release of [...activeSlotReleasers]) release();
    };

    const handleChildFailure = (err: Error): void => {
      releaseAllSlots();
      if (this.isDisconnecting || this.child !== child) return;
      this.cancelAllPendingApprovals();
      for (const [routeId, state] of this.sessions) {
        state.loaded = false;
        state.replaying = false;
        state.compacting = false;
        state.confirmedModel = undefined;
        state.attemptedModel = undefined;
        this.clearCancelGraceTimer(state);
        this.retireOpenToolCalls(state);
        this.clearStatus(routeId, state);
        if (state.promptInFlight) {
          state.promptInFlight = false;
          state.settledGeneration = state.turnGeneration;
          state.currentMessageId = null;
          state.currentText = '';
          this.stopTargets.get(state)?.complete();
          for (const cb of this.errorCallbacks) {
            cb(routeId, this.makeError(PROVIDER_ERROR_CODES.CONNECTION_LOST, err.message, true));
          }
        }
      }
      this.child = null;
      this.connection = null;
    };

    child.once('exit', (code, signal) => {
      handleChildFailure(new Error(`Cursor ACP server exited with code=${code ?? 'null'} signal=${signal ?? 'null'}`));
    });
    child.on('error', (err) => {
      handleChildFailure(err);
    });

    const rawWriter = rawStream.writable.getWriter();
    const interceptedWritable = new WritableStream({
      write: (message) => {
        const msg = message && typeof message === 'object' ? (message as unknown as Record<string, unknown>) : null;
        if (
          msg
          && msg.id !== undefined
          && msg.id !== null
          && msg.method === 'session/prompt'
          && isRecord(msg.params)
          && typeof msg.params.sessionId === 'string'
        ) {
          const q = pendingPromptWrites.get(msg.params.sessionId);
          const entry = q?.shift();
          if (q && q.length === 0) pendingPromptWrites.delete(msg.params.sessionId);
          if (entry) {
            const reqId = msg.id as string | number;
            inFlightPromptWrites.set(reqId, entry);
            entry.clearPending = () => {
              inFlightPromptWrites.delete(reqId);
            };
          }
        }
        return rawWriter.write(message as Parameters<typeof rawWriter.write>[0]);
      },
      close: () => rawWriter.close(),
      abort: (reason) => rawWriter.abort(reason),
    }) as typeof rawStream.writable;

    const stream = {
      writable: interceptedWritable,
      readable: rawStream.readable.pipeThrough(new TransformStream({
        transform: (message, controller) => {
          const msg = message && typeof message === 'object' ? (message as unknown as Record<string, unknown>) : null;
          if (
            msg
            && msg.id !== undefined
            && msg.id !== null
            && !('method' in msg)
          ) {
            const entry = inFlightPromptWrites.get(msg.id as string | number);
            if (entry) {
              inFlightPromptWrites.delete(msg.id as string | number);
              entry.onResponseArrived();
            }
          } else if (msg && !('id' in msg)) {
            if (msg.method === 'session/update' && isRecord(msg.params)) {
              const sid = msg.params.sessionId;
              const routeId = typeof sid === 'string' ? this.acpToRoute.get(sid) : undefined;
              const state = routeId ? this.sessions.get(routeId) : undefined;
              if (state && state.acpSessionId === sid && state.wireOrderTail) {
                this.pendingUpdateSlots.set(msg.params, reserveSlot(state));
              }
              controller.enqueue({ ...msg, method: '_imcodes/session/update' });
              return;
            }
          }
          controller.enqueue(message);
        },
        flush() {
          releaseAllSlots();
        },
      })),
    };

    const connection = createAcpClientConnection(this.createClientHandlers(child), stream);
    this.connection = connection;
    this.promptWriteQueues.set(connection, { pending: pendingPromptWrites, reserveSlot });

    try {
      const initResult = await Promise.race([
        this.runWithTimeout('Cursor ACP initialize', CONNECT_PROBE_TIMEOUT_MS, () => connection.initialize({
          protocolVersion: 1,
          clientCapabilities: {
            fs: { readTextFile: false, writeTextFile: false },
            terminal: false,
          },
        })),
        spawnFailure,
      ]);
      this.applyInitializeCapabilities(initResult);
    } catch (err) {
      await this.teardownChild();
      if (isRecord(err) && 'code' in err && 'message' in err && 'recoverable' in err) {
        throw err;
      }
      throw this.normalizeConnectError(err, 'Cursor ACP initialize failed');
    }
  }

  private applyInitializeCapabilities(result: InitializeResponse): void {
    if (result.protocolVersion !== 1) {
      throw this.makeError(
        PROVIDER_ERROR_CODES.CONFIG_ERROR,
        `Unsupported Cursor ACP protocolVersion: ${String(result.protocolVersion)}`,
        false,
      );
    }
    const caps = result.agentCapabilities;
    this.loadSessionSupported = caps?.loadSession !== false;
    this.sessionListSupported = caps?.sessionCapabilities?.list != null;
    this.imageAttachmentSupported = caps?.promptCapabilities?.image !== false;
    this.mcpHttpSupported = caps?.mcpCapabilities?.http === true;
    this.mcpSseSupported = caps?.mcpCapabilities?.sse === true;
    this.capabilities.attachments = this.imageAttachmentSupported;
    this.supportedAuthMethodIds.clear();
    if (Array.isArray(result.authMethods)) {
      for (const method of result.authMethods) {
        if (method && isTruthyString(method.id)) {
          this.supportedAuthMethodIds.add(method.id.trim());
        }
      }
    }
  }

  private createClientHandlers(child: ChildProcessWithoutNullStreams): AcpClientHandlers {
    const isCurrentChild = () => this.child === child;
    return {
      requestPermission: async (params: RequestPermissionRequest): Promise<RequestPermissionResponse> => {
        if (!isCurrentChild()) return { outcome: { outcome: 'cancelled' } };
        return this.handlePermissionRequest(params);
      },
      sessionUpdate: async (params: SessionNotification): Promise<void> => {
        if (isCurrentChild()) this.enqueueSessionUpdate(params);
      },
      extNotification: async (method: string, params: Record<string, unknown>): Promise<void> => {
        if (!isCurrentChild()) return;
        if (method === '_imcodes/session/update') {
          this.enqueueSessionUpdate(params as unknown as SessionNotification);
          return;
        }
        logger.debug({ provider: this.id, method }, 'Ignored Cursor ACP extension notification');
      },
      readTextFile: async (_params: ReadTextFileRequest): Promise<ReadTextFileResponse> => {
        throw new RequestError(-32601, 'Method not available — client fs capability disabled');
      },
      writeTextFile: async (_params: WriteTextFileRequest): Promise<WriteTextFileResponse> => {
        throw new RequestError(-32601, 'Method not available — client fs capability disabled');
      },
    };
  }

  private async ensureSessionReady(
    routeId: string,
    state: CursorAcpSessionState,
    expectedGeneration?: number,
  ): Promise<void> {
    const connection = this.connection!;
    if (!state.loaded) {
      const mcpServers = this.mcpServersForState(state);
      if (state.acpSessionId && this.loadSessionSupported && typeof connection.loadSession === 'function') {
        state.replaying = true;
        try {
          const loadResult = await this.withAuthRetry(() => this.runWithTimeout(
            'Cursor ACP loadSession',
            SESSION_RPC_TIMEOUT_MS,
            () => connection.loadSession!({
              sessionId: state.acpSessionId!,
              cwd: state.cwd,
              mcpServers,
            }),
          ));
          if (state.wireOrderTail) {
            await this.runWithTimeout('Cursor ACP replay drain', SESSION_RPC_TIMEOUT_MS, () => state.wireOrderTail!);
          }
          this.assertCurrentTurn(routeId, state, expectedGeneration);
          state.loaded = true;
          this.captureSessionModels(loadResult || undefined, state);
          if (state.model && state.confirmedModel !== state.model && state.attemptedModel !== state.model) {
            state.attemptedModel = state.model;
            await this.applyModelOnConnection(state, state.model).catch(() => {});
          }
          return;
        } catch (err) {
          if (isAuthErrorLike(err) || this.isCancelledOrTimeout(err)) throw err;
          logger.info(
            { provider: this.id, routeId, acpSessionId: state.acpSessionId, message: formatErrorMessage(err) },
            'Cursor ACP loadSession failed; creating fresh session',
          );
          if (state.acpSessionId && this.acpToRoute.get(state.acpSessionId) === routeId) {
            this.acpToRoute.delete(state.acpSessionId);
          }
          state.acpSessionId = undefined;
        } finally {
          state.replaying = false;
        }
      }

      const created = await this.withAuthRetry(() => this.runWithTimeout(
        'Cursor ACP newSession',
        SESSION_RPC_TIMEOUT_MS,
        () => connection.newSession({
          cwd: state.cwd,
          mcpServers,
        }),
      ));
      this.assertCurrentTurn(routeId, state, expectedGeneration);
      state.acpSessionId = created.sessionId;
      state.loaded = true;
      this.acpToRoute.set(created.sessionId, routeId);
      this.captureSessionModels(created, state);
      this.emitSessionInfo(routeId, {
        resumeId: created.sessionId,
        ...(state.model ? { model: state.model } : {}),
      });
    }

    if (state.model && state.confirmedModel !== state.model && state.attemptedModel !== state.model && state.acpSessionId) {
      state.attemptedModel = state.model;
      await this.applyModelOnConnection(state, state.model).catch((err) => {
        logger.debug({ provider: this.id, routeId, model: state.model, message: formatErrorMessage(err) }, 'Cursor ACP set model pre-turn failed');
      });
    }
  }

  private async withAuthRetry<T>(fn: () => Promise<T>): Promise<T> {
    try {
      const value = await fn();
      this.authenticated = true;
      return value;
    } catch (err) {
      if (!isAuthErrorLike(err)) throw err;
      if (this.authenticated || !this.connection?.authenticate || !this.supportedAuthMethodIds.has(CURSOR_AUTH_METHOD_LOGIN)) {
        throw this.makeError(PROVIDER_ERROR_CODES.AUTH_FAILED, AUTH_ACTION_HINT, false, err);
      }
      try {
        await this.runWithTimeout(
          'Cursor ACP authenticate',
          AUTH_RPC_TIMEOUT_MS,
          () => this.connection!.authenticate!({ methodId: CURSOR_AUTH_METHOD_LOGIN }),
        );
        this.authenticated = true;
      } catch (authErr) {
        throw this.makeError(PROVIDER_ERROR_CODES.AUTH_FAILED, AUTH_ACTION_HINT, false, authErr);
      }
      try {
        return await fn();
      } catch (retryErr) {
        if (isAuthErrorLike(retryErr)) {
          throw this.makeError(PROVIDER_ERROR_CODES.AUTH_FAILED, AUTH_ACTION_HINT, false, retryErr);
        }
        throw retryErr;
      }
    }
  }

  private async applyModelOnConnection(state: CursorAcpSessionState, modelId: string): Promise<void> {
    if (!this.connection || !state.acpSessionId) return;
    if (typeof this.connection.unstable_setSessionModel === 'function') {
      try {
        await this.runWithTimeout(
          'Cursor ACP set_model',
          MODE_MODEL_RPC_TIMEOUT_MS,
          () => this.connection!.unstable_setSessionModel!({
            sessionId: state.acpSessionId!,
            modelId,
          }),
        );
        state.confirmedModel = modelId;
        return;
      } catch (err) {
        if (!state.modelConfigOptionId || typeof this.connection.setSessionConfigOption !== 'function') {
          throw err;
        }
      }
    }
    if (state.modelConfigOptionId && typeof this.connection.setSessionConfigOption === 'function') {
      await this.runWithTimeout(
        'Cursor ACP set_config_option',
        MODE_MODEL_RPC_TIMEOUT_MS,
        () => this.connection!.setSessionConfigOption!({
          sessionId: state.acpSessionId!,
          configId: state.modelConfigOptionId!,
          value: modelId,
        }),
      );
      state.confirmedModel = modelId;
    }
  }

  private captureSessionModels(
    result: Partial<NewSessionResponse & LoadSessionResponse> | undefined,
    state?: CursorAcpSessionState,
  ): void {
    if (!result) return;
    const rawResult = result as Record<string, unknown>;
    const collected: ProviderModelInfo[] = [];
    const seen = new Set<string>();
    const pushModel = (rawEntry: Record<string, unknown>): void => {
      const id = normalizeCursorModelId(rawEntry.modelId ?? rawEntry.id ?? rawEntry.value);
      if (!id || seen.has(id)) return;
      seen.add(id);
      const name = isTruthyString(rawEntry.name) ? rawEntry.name.trim() : undefined;
      const ctxWin = extractModelContextWindow(rawEntry);
      if (ctxWin) this.modelContextWindows.set(id, ctxWin);
      collected.push({ id, ...(name ? { name } : {}) });
    };

    if (isRecord(rawResult.models)) {
      const available = rawResult.models.availableModels;
      if (Array.isArray(available)) {
        for (const item of available) {
          if (isRecord(item)) pushModel(item);
        }
      }
      const current = normalizeCursorModelId(rawResult.models.currentModelId);
      if (current) {
        this.cachedDefaultModel ??= current;
        if (state) {
          if (!state.model) {
            state.model = current;
            state.confirmedModel = current;
            this.emitSessionInfo(state.routeId, {
              ...(state.acpSessionId ? { resumeId: state.acpSessionId } : {}),
              model: current,
            });
          } else if (state.model === current) {
            state.confirmedModel = current;
          }
        }
      }
    }

    if (Array.isArray(rawResult.configOptions)) {
      this.captureConfigOptions(rawResult.configOptions, state, pushModel);
    }

    if (collected.length > 0) {
      this.cachedModels = collected;
    }
  }

  private captureConfigOptions(
    configOptions: unknown[],
    state?: CursorAcpSessionState,
    pushModel?: (entry: Record<string, unknown>) => void,
  ): void {
    for (const opt of configOptions) {
      if (!isRecord(opt)) continue;
      const category = isTruthyString(opt.category) ? opt.category.trim().toLowerCase() : '';
      const optId = isTruthyString(opt.id) ? opt.id.trim() : '';
      if (category !== 'model' && optId !== 'model') continue;
      if (state && optId) state.modelConfigOptionId = optId;
      const currentValue = normalizeCursorModelId(opt.currentValue);
      if (currentValue) {
        this.cachedDefaultModel ??= currentValue;
        if (state) {
          if (!state.model) {
            state.model = currentValue;
            state.confirmedModel = currentValue;
          } else if (state.model === currentValue) {
            state.confirmedModel = currentValue;
          }
        }
      }
      const options = opt.options;
      if (Array.isArray(options) && pushModel) {
        for (const entry of options) {
          if (!isRecord(entry)) continue;
          if (Array.isArray(entry.options)) {
            for (const sub of entry.options) {
              if (isRecord(sub)) pushModel(sub);
            }
          } else {
            pushModel(entry);
          }
        }
      }
    }
  }

  private mcpServersForState(state: CursorAcpSessionState): McpServer[] {
    const servers: McpServer[] = getDefaultAcpMcpServers({
      sessionKey: state.routeId,
      sessionName: state.sessionName,
      projectName: state.projectName,
      serverId: state.serverId,
      cwd: state.cwd,
      env: state.env,
      contextNamespace: state.contextNamespace,
    });
    const extra = this.config?.mcpServers;
    if (Array.isArray(extra)) {
      for (const rawEntry of extra as CursorAcpExtraMcpServerConfig[]) {
        if (!rawEntry || !isTruthyString(rawEntry.name)) continue;
        const type = rawEntry.type ?? (rawEntry.url ? 'http' : 'stdio');
        if (type === 'http' && this.mcpHttpSupported && isTruthyString(rawEntry.url)) {
          servers.push({
            type: 'http',
            name: rawEntry.name.trim(),
            url: rawEntry.url.trim(),
            headers: normalizeHttpHeaders(rawEntry.headers),
          });
        } else if (type === 'sse' && this.mcpSseSupported && isTruthyString(rawEntry.url)) {
          servers.push({
            type: 'sse',
            name: rawEntry.name.trim(),
            url: rawEntry.url.trim(),
            headers: normalizeHttpHeaders(rawEntry.headers),
          });
        } else if (type === 'stdio' && isTruthyString(rawEntry.command)) {
          servers.push({
            name: rawEntry.name.trim(),
            command: rawEntry.command.trim(),
            args: Array.isArray(rawEntry.args) ? rawEntry.args.filter((a): a is string => typeof a === 'string') : [],
            env: normalizeStdioEnv(rawEntry.env),
          });
        }
      }
    }
    return servers;
  }

  private async buildPromptContent(payload: ProviderContextPayload, includeSessionSystemText: boolean): Promise<ContentBlock[]> {
    const promptText = composeMessageSideProviderPrompt(payload, { includeSessionSystemText });
    const blocks: ContentBlock[] = [];
    const fallbackNotes: string[] = [];

    for (const attachment of payload.attachments ?? []) {
      const daemonPath = attachment.daemonPath.trim();
      const displayName = attachment.originalName?.trim() || path.basename(daemonPath);
      const imageMime = this.imageAttachmentSupported ? guessImageMimeType(attachment) : undefined;
      if (imageMime && path.isAbsolute(daemonPath)) {
        try {
          const bytes = await readFile(daemonPath);
          blocks.push({
            type: 'image',
            data: bytes.toString('base64'),
            mimeType: imageMime,
          });
          continue;
        } catch (err) {
          logger.debug({ provider: this.id, daemonPath, message: formatErrorMessage(err) }, 'Cursor ACP image read failed; falling back to text ref');
        }
      }
      fallbackNotes.push(`[Attachment: ${displayName} (${daemonPath})]`);
    }

    const combinedText = fallbackNotes.length > 0
      ? `${promptText}\n\n${fallbackNotes.join('\n')}`
      : promptText;
    blocks.unshift({ type: 'text', text: combinedText });
    return blocks;
  }

  // ── Session update & permission routing ──────────────────────────────────

  private enqueueSessionUpdate(params: SessionNotification): void {
    if (!params || typeof params !== 'object' || typeof params.sessionId !== 'string' || !isRecord(params.update)) {
      return;
    }
    const slot = this.pendingUpdateSlots.get(params);
    if (slot) this.pendingUpdateSlots.delete(params);
    if (!slot?.waitForPrior) {
      try {
        this.handleSessionUpdate(params);
      } finally {
        slot?.release();
      }
      return;
    }
    void slot.waitForPrior
      .catch(() => {})
      .then(() => {
        this.handleSessionUpdate(params);
      })
      .finally(() => {
        slot.release();
      });
  }

  private handleSessionUpdate(params: SessionNotification): void {
    const routeId = this.acpToRoute.get(params.sessionId);
    if (!routeId) return;
    const state = this.sessions.get(routeId);
    if (!state || state.acpSessionId !== params.sessionId) return;
    if (state.replaying) return;

    const update = params.update as unknown as Record<string, unknown>;
    const kind = update.sessionUpdate;
    if (typeof kind !== 'string') return;

    if (kind === 'user_message_chunk') return;

    if (kind === 'available_commands_update') {
      const commands = Array.isArray(update.availableCommands) ? update.availableCommands : [];
      state.availableCommands.clear();
      for (const cmd of commands) {
        if (isRecord(cmd) && isTruthyString(cmd.name)) {
          state.availableCommands.add(cmd.name.trim().replace(/^\//, ''));
        }
      }
      return;
    }

    if (kind === 'config_option_update') {
      if (Array.isArray(update.configOptions)) {
        this.captureConfigOptions(update.configOptions, state);
      }
      return;
    }

    if (kind === 'current_mode_update') {
      return;
    }

    if (kind === 'compaction_update' || kind === 'compaction_summary_chunk') {
      this.handleCompactionUpdate(routeId, state, update, kind);
      return;
    }

    if (kind === 'usage_update') {
      if (!state.promptInFlight || state.cancelled) return;
      const modelWindow = state.model ? this.modelContextWindows.get(state.model) : undefined;
      const normalized = normalizeCursorAcpUsage(update, modelWindow);
      if (normalized) {
        state.lastTurnUsage = { ...state.lastTurnUsage, ...normalized };
        this.emitUsage(routeId, state, state.lastTurnUsage, false);
      }
      return;
    }

    if (kind === 'session_info_update') {
      const infoUpdate: SessionInfoUpdate = {};
      const model = normalizeCursorModelId(update.model ?? update.modelId);
      if (model) {
        state.model = model;
        infoUpdate.model = model;
      }
      if (Object.keys(infoUpdate).length > 0) {
        this.emitSessionInfo(routeId, infoUpdate);
      }
      return;
    }

    if (!state.promptInFlight || state.cancelled) return;

    switch (kind) {
      case 'agent_message_chunk': {
        const chunkText = extractTextFromContent(update.content as ContentBlock);
        if (!chunkText) return;
        state.compacting = false;
        this.clearStatus(routeId, state);
        const incomingId = isTruthyString(update.messageId) ? update.messageId.trim() : null;
        if (incomingId && incomingId !== state.currentMessageId) {
          state.currentMessageId = incomingId;
          state.currentText = '';
        } else if (!state.currentMessageId) {
          state.currentMessageId = randomUUID();
        }
        state.currentText += chunkText;
        const delta: MessageDelta = {
          messageId: state.currentMessageId,
          type: 'text',
          delta: state.currentText,
          role: 'assistant',
        };
        for (const cb of this.deltaCallbacks) cb(routeId, delta);
        return;
      }
      case 'agent_thought_chunk': {
        if (!state.compacting) {
          this.emitStatus(routeId, state, { status: 'thinking', label: 'Thinking…' });
        }
        return;
      }
      case 'tool_call': {
        this.handleToolCall(routeId, state, update as unknown as ToolCall);
        return;
      }
      case 'tool_call_update': {
        this.handleToolCallUpdate(routeId, state, update as unknown as ToolCallUpdate);
        return;
      }
      case 'plan':
      case 'plan_update': {
        this.handlePlan(routeId, state, update);
        return;
      }
      default:
        logger.debug({ provider: this.id, routeId, kind }, 'Unhandled Cursor ACP session update');
    }
  }

  private handleCompactionUpdate(
    routeId: string,
    state: CursorAcpSessionState,
    update: Record<string, unknown>,
    kind: string,
  ): void {
    if (kind === 'compaction_summary_chunk') {
      state.compacting = true;
      this.emitStatus(routeId, state, { status: 'compacting', label: 'Compacting…' });
      return;
    }
    const rawStatus = isTruthyString(update.status) ? update.status.trim().toLowerCase() : 'in_progress';
    if (rawStatus === 'completed' || rawStatus === 'complete' || rawStatus === 'done' || rawStatus === 'finished' || rawStatus === 'failed' || rawStatus === 'cancelled' || rawStatus === 'canceled') {
      state.compacting = false;
      if (rawStatus === 'completed' || rawStatus === 'complete' || rawStatus === 'done' || rawStatus === 'finished') {
        state.sessionSystemTextInjected = undefined;
        state.compactedInTurn = true;
      }
      this.clearStatus(routeId, state);
      return;
    }
    state.compacting = true;
    this.emitStatus(routeId, state, { status: 'compacting', label: 'Compacting…' });
  }

  private handleToolCall(routeId: string, state: CursorAcpSessionState, update: ToolCall): void {
    if (!update.toolCallId || state.retiredToolCallIds.has(update.toolCallId)) return;
    if (!state.compacting) this.clearStatus(routeId, state);
    const merged: CursorMergedToolCall = {
      toolCallId: update.toolCallId,
      title: update.title ?? update.toolCallId,
      kind: update.kind ?? undefined,
      status: update.status ?? 'pending',
      content: Array.isArray(update.content) ? update.content : [],
      rawInput: update.rawInput,
      rawOutput: update.rawOutput,
    };
    state.toolCalls.set(update.toolCallId, merged);
    this.emitMergedToolCall(routeId, state, merged);
  }

  private handleToolCallUpdate(routeId: string, state: CursorAcpSessionState, update: ToolCallUpdate): void {
    if (!update.toolCallId || state.retiredToolCallIds.has(update.toolCallId)) return;
    const existing = state.toolCalls.get(update.toolCallId);
    const merged: CursorMergedToolCall = existing ?? {
      toolCallId: update.toolCallId,
      title: update.title ?? update.toolCallId,
      kind: update.kind ?? undefined,
      status: update.status ?? (state.promptInFlight ? 'pending' : 'completed'),
      content: [],
    };
    if (typeof update.title === 'string') merged.title = update.title;
    if (typeof update.kind === 'string') merged.kind = update.kind;
    if (typeof update.status === 'string') merged.status = update.status;
    if (Array.isArray(update.content)) merged.content = update.content;
    if ('rawInput' in update) merged.rawInput = update.rawInput;
    if ('rawOutput' in update) merged.rawOutput = update.rawOutput;
    state.toolCalls.set(update.toolCallId, merged);
    this.emitMergedToolCall(routeId, state, merged);
  }

  private handlePlan(routeId: string, state: CursorAcpSessionState, update: Record<string, unknown>): void {
    let input: { plan: Array<{ content: string; status: string }> } | null = null;
    if (update.sessionUpdate === 'plan_update' && isRecord(update.plan)) {
      if (update.plan.type === 'items') {
        input = acpPlanEntriesToInput(update.plan.entries);
      } else if (update.plan.type === 'markdown' && typeof update.plan.markdown === 'string') {
        const text = update.plan.markdown.trim();
        if (text) input = { plan: [{ content: text, status: 'in_progress' }] };
      }
    } else {
      input = acpPlanEntriesToInput(update.entries);
    }
    if (!input) return;
    if (!state.compacting) this.clearStatus(routeId, state);
    const plan: CursorMergedToolCall = {
      toolCallId: `${this.id}-plan:${routeId}`,
      title: 'plan',
      kind: 'plan',
      status: 'in_progress',
      content: [],
      rawInput: input,
    };
    state.toolCalls.set(plan.toolCallId, plan);
    this.emitMergedToolCall(routeId, state, plan);
  }

  private emitMergedToolCall(routeId: string, state: CursorAcpSessionState, merged: CursorMergedToolCall): void {
    const status = mapToolStatus(merged.status);
    const output = status === 'running'
      ? undefined
      : (flattenToolContent(merged.content)
        ?? (merged.rawOutput !== undefined
          ? (typeof merged.rawOutput === 'string' ? merged.rawOutput : JSON.stringify(merged.rawOutput))
          : undefined));
    const evt: ToolCallEvent = {
      id: merged.toolCallId,
      name: merged.title,
      status,
      ...(merged.rawInput !== undefined ? { input: merged.rawInput } : {}),
      ...(output !== undefined ? { output } : {}),
      detail: {
        kind: merged.kind ?? 'tool_use',
        summary: merged.title,
        input: merged.rawInput,
        output,
        meta: { status: merged.status },
        raw: merged,
      },
    };
    const signature = JSON.stringify({
      status: evt.status,
      name: evt.name,
      input: evt.input ?? null,
      output: evt.output ?? null,
    });
    if (state.emittedToolSignatures.get(merged.toolCallId) === signature) return;
    state.emittedToolSignatures.set(merged.toolCallId, signature);
    for (const cb of this.toolCallCallbacks) cb(routeId, evt);
  }

  private handlePermissionRequest(params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    const routeId = this.acpToRoute.get(params.sessionId);
    if (!routeId) {
      return Promise.resolve({ outcome: { outcome: 'cancelled' } });
    }
    const autoApprove = this.config?.autoApprove === true || this.approvalCallbacks.length === 0;
    if (autoApprove && this.config?.autoApprove === true) {
      const selected = params.options.find((opt) => opt.kind === 'allow_always')
        ?? params.options.find((opt) => opt.kind === 'allow_once');
      return Promise.resolve(selected
        ? { outcome: { outcome: 'selected', optionId: selected.optionId } }
        : { outcome: { outcome: 'cancelled' } });
    }
    if (this.approvalCallbacks.length === 0) {
      return Promise.resolve({ outcome: { outcome: 'cancelled' } });
    }
    const state = this.sessions.get(routeId);
    const requestId = randomUUID();
    const rawInput = params.toolCall?.rawInput;
    let inputPreview: string | undefined;
    if (rawInput !== undefined) {
      try {
        const text = typeof rawInput === 'string' ? rawInput : JSON.stringify(rawInput);
        inputPreview = text.slice(0, 400);
      } catch {
        inputPreview = undefined;
      }
    }
    return new Promise<RequestPermissionResponse>((resolve) => {
      const timer = setTimeout(() => {
        this.pendingApprovals.delete(requestId);
        resolve({ outcome: { outcome: 'cancelled' } });
      }, APPROVAL_TIMEOUT_MS);
      timer.unref?.();
      this.pendingApprovals.set(requestId, {
        routeId,
        options: params.options,
        resolve,
        timer,
      });
      const req: ApprovalRequest = {
        id: requestId,
        description: params.toolCall?.title ?? 'Cursor requested permission to use a tool',
        ...(params.toolCall?.title ? { tool: params.toolCall.title } : {}),
        provider: this.id,
        ...(state ? { providerGeneration: state.turnGeneration } : {}),
        ...(params.toolCall?.toolCallId ? { providerToolUseId: params.toolCall?.toolCallId } : {}),
        ...(inputPreview ? { inputPreview } : {}),
      };
      for (const cb of this.approvalCallbacks) cb(routeId, req);
    });
  }

  // ── Turn settlement ──────────────────────────────────────────────────────

  private trackPromptSettlement(
    connection: AcpClientConnection,
    acpSessionId: string,
    state: CursorAcpSessionState,
    turn: Promise<PromptResponse>,
    onFulfilled: (result: PromptResponse) => void,
    onRejected: (err: unknown) => void,
  ): void {
    const queue = this.promptWriteQueues.get(connection);
    let slot: WireSlot | undefined;
    const entry = {
      onResponseArrived: () => {
        if (!slot && queue) {
          slot = queue.reserveSlot(state);
        }
      },
      clearPending: () => {},
    };
    if (queue) {
      let list = queue.pending.get(acpSessionId);
      if (!list) {
        list = [];
        queue.pending.set(acpSessionId, list);
      }
      list.push(entry);
    }
    void turn
      .then(async (result) => {
        if (slot?.waitForPrior) await slot.waitForPrior;
        onFulfilled(result);
      })
      .catch(async (err) => {
        if (slot?.waitForPrior) await slot.waitForPrior;
        onRejected(err);
      })
      .finally(() => {
        entry.clearPending();
        const list = queue?.pending.get(acpSessionId);
        if (list) {
          const idx = list.indexOf(entry);
          if (idx >= 0) list.splice(idx, 1);
          if (list.length === 0) queue?.pending.delete(acpSessionId);
        }
        slot?.release();
      });
  }

  private settleTurn(
    routeId: string,
    state: CursorAcpSessionState,
    generation: number,
    result: PromptResponse,
    sessionSystemTextToCommit?: string,
    compactControl = false,
  ): void {
    if (this.sessions.get(routeId) !== state || state.settledGeneration >= generation) return;
    this.clearCancelGraceTimer(state);
    state.settledGeneration = generation;
    state.promptInFlight = false;
    state.compacting = false;
    this.clearStatus(routeId, state);
    this.cancelPendingApprovals(routeId);
    this.retireOpenToolCalls(state);

    const stopReason: StopReason = result.stopReason;
    const text = state.currentText;
    const messageId = state.currentMessageId ?? `${routeId}:${randomUUID()}`;
    state.currentText = '';
    state.currentMessageId = null;

    this.stopTargets.get(state)?.complete();

    if (stopReason === 'cancelled' || state.cancelled) {
      state.cancelled = false;
      for (const cb of this.errorCallbacks) {
        cb(routeId, this.makeError(PROVIDER_ERROR_CODES.CANCELLED, 'Cursor turn cancelled', true));
      }
      return;
    }

    if (stopReason === 'refusal') {
      for (const cb of this.errorCallbacks) {
        cb(routeId, this.makeError(PROVIDER_ERROR_CODES.PROVIDER_ERROR, 'Cursor refused the request', false));
      }
      return;
    }

    const modelWindow = state.model ? this.modelContextWindows.get(state.model) : undefined;
    const resultUsage = normalizeCursorAcpUsage(result as unknown as Record<string, unknown>, modelWindow);
    const mergedUsage = (state.lastTurnUsage || resultUsage)
      ? { ...state.lastTurnUsage, ...resultUsage }
      : undefined;
    state.lastTurnUsage = undefined;

    if (mergedUsage) {
      this.emitUsage(routeId, state, mergedUsage, true, messageId);
    }

    if (sessionSystemTextToCommit && !state.compactedInTurn) {
      state.sessionSystemTextInjected = sessionSystemTextToCommit;
    }
    if (compactControl) {
      state.sessionSystemTextInjected = undefined;
    }

    const msg: AgentMessage = {
      id: messageId,
      sessionId: routeId,
      kind: 'text',
      role: 'assistant',
      content: text,
      timestamp: Date.now(),
      status: 'complete',
      metadata: {
        ...(stopReason === 'max_tokens' || stopReason === 'max_turn_requests' ? { stopReason } : {}),
        ...(state.model ? { model: state.model } : {}),
        ...(state.acpSessionId ? { resumeId: state.acpSessionId } : {}),
        ...(mergedUsage ? { usage: mergedUsage } : {}),
      },
    };
    for (const cb of this.completeCallbacks) cb(routeId, msg);
  }

  private failTurn(routeId: string, state: CursorAcpSessionState, generation: number, err: unknown): void {
    if (this.sessions.get(routeId) !== state || state.settledGeneration >= generation) return;
    this.clearCancelGraceTimer(state);
    state.settledGeneration = generation;
    state.promptInFlight = false;
    state.cancelled = false;
    state.compacting = false;
    state.currentText = '';
    state.currentMessageId = null;
    state.lastTurnUsage = undefined;
    state.sessionSystemTextInjected = undefined;
    this.cancelPendingApprovals(routeId);
    this.retireOpenToolCalls(state);
    this.clearStatus(routeId, state);
    this.stopTargets.get(state)?.complete();
    if (this.isDisconnecting) return;
    const normalized = this.normalizeError(err);
    for (const cb of this.errorCallbacks) cb(routeId, normalized);
  }

  private forceFailWedgedTurn(routeId: string, state: CursorAcpSessionState, generation: number, reason: string): void {
    if (this.sessions.get(routeId) !== state || state.turnGeneration !== generation || state.settledGeneration >= generation) return;
    this.clearCancelGraceTimer(state);
    state.settledGeneration = generation;
    state.promptInFlight = false;
    state.cancelled = false;
    state.compacting = false;
    state.currentText = '';
    state.currentMessageId = null;
    state.lastTurnUsage = undefined;
    this.cancelPendingApprovals(routeId);
    this.retireOpenToolCalls(state);
    this.clearStatus(routeId, state);
    this.stopTargets.get(state)?.complete();
    if (this.isDisconnecting) return;
    for (const cb of this.errorCallbacks) {
      cb(routeId, this.makeError(PROVIDER_ERROR_CODES.CANCELLED, reason, true));
    }
  }

  // ── Utilities ────────────────────────────────────────────────────────────

  private async waitForAcpWrite(connection: AcpClientConnection): Promise<boolean> {
    const tracker = connection.connection;
    if (!tracker?.writeQueue) return true;
    const outcome = await withTimeoutOutcome(tracker.writeQueue, ACP_WRITE_TIMEOUT_MS);
    if (outcome.timedOut) return false;
    return tracker.abortController?.signal?.aborted !== true;
  }

  private async runWithTimeout<T>(operation: string, timeoutMs: number, fn: () => Promise<T>): Promise<T> {
    const outcome = await withTimeoutOutcome(fn(), timeoutMs);
    if (outcome.timedOut) {
      throw this.makeError(PROVIDER_ERROR_CODES.PROVIDER_ERROR, `${operation} timed out after ${timeoutMs}ms`, true);
    }
    return outcome.value;
  }

  private armCancelGraceTimer(routeId: string, state: CursorAcpSessionState, generation: number): void {
    if (state.cancelGraceTimer && state.cancelGraceGeneration === generation) return;
    this.clearCancelGraceTimer(state);
    state.cancelGraceGeneration = generation;
    const timer = setTimeout(() => {
      if (state.cancelGraceTimer === timer) {
        state.cancelGraceTimer = undefined;
        state.cancelGraceGeneration = undefined;
      }
      if (this.sessions.get(routeId) === state && state.promptInFlight && state.cancelled && state.turnGeneration === generation) {
        this.forceFailWedgedTurn(routeId, state, generation, 'Cursor turn cancelled (grace teardown)');
      }
    }, CANCEL_GRACE_MS);
    timer.unref?.();
    state.cancelGraceTimer = timer;
  }

  private clearCancelGraceTimer(state: CursorAcpSessionState): void {
    if (state.cancelGraceTimer) {
      clearTimeout(state.cancelGraceTimer);
      state.cancelGraceTimer = undefined;
    }
    state.cancelGraceGeneration = undefined;
  }

  private assertCurrentTurn(routeId: string, state: CursorAcpSessionState, expectedGeneration?: number): void {
    if (
      this.sessions.get(routeId) !== state
      || state.cancelled
      || (expectedGeneration !== undefined && (state.turnGeneration !== expectedGeneration || state.settledGeneration >= expectedGeneration))
    ) {
      throw this.makeError(PROVIDER_ERROR_CODES.CANCELLED, 'Cursor ACP session owner changed or stopped', true);
    }
  }

  private retireOpenToolCalls(state: CursorAcpSessionState): void {
    for (const id of state.toolCalls.keys()) {
      if (state.retiredToolCallIds.size >= RETIRED_TOOL_CALL_LIMIT) {
        const oldest = state.retiredToolCallIds.values().next().value;
        if (oldest !== undefined) state.retiredToolCallIds.delete(oldest);
      }
      state.retiredToolCallIds.add(id);
    }
    state.toolCalls.clear();
    state.emittedToolSignatures.clear();
  }

  private cancelPendingApprovals(routeId: string): void {
    for (const [reqId, pending] of this.pendingApprovals) {
      if (pending.routeId !== routeId) continue;
      this.pendingApprovals.delete(reqId);
      clearTimeout(pending.timer);
      pending.resolve({ outcome: { outcome: 'cancelled' } });
    }
  }

  private cancelAllPendingApprovals(): void {
    for (const [reqId, pending] of this.pendingApprovals) {
      this.pendingApprovals.delete(reqId);
      clearTimeout(pending.timer);
      pending.resolve({ outcome: { outcome: 'cancelled' } });
    }
  }

  private emitSessionInfo(routeId: string, info: SessionInfoUpdate): void {
    for (const cb of this.sessionInfoCallbacks) cb(routeId, info);
  }

  private emitStatus(routeId: string, state: CursorAcpSessionState, update: ProviderStatusUpdate): void {
    const signature = `${update.status ?? ''}\0${update.label ?? ''}`;
    if (state.lastStatusSignature === signature) return;
    state.lastStatusSignature = signature;
    for (const cb of this.statusCallbacks) cb(routeId, update);
  }

  private clearStatus(routeId: string, state: CursorAcpSessionState): void {
    if (state.lastStatusSignature === null) return;
    state.lastStatusSignature = null;
    for (const cb of this.statusCallbacks) cb(routeId, { status: null, label: null });
  }

  private emitUsage(
    routeId: string,
    state: CursorAcpSessionState,
    usage: NonNullable<ProviderUsageUpdate['usage']>,
    finalized: boolean,
    messageId?: string,
  ): void {
    for (const cb of this.usageCallbacks) {
      cb(routeId, {
        messageId: messageId ?? state.currentMessageId ?? undefined,
        finalized,
        usage,
        ...(state.model ? { model: state.model } : {}),
      });
    }
  }

  private async teardownChild(): Promise<void> {
    const child = this.child;
    this.child = null;
    this.connection = null;
    for (const state of this.sessions.values()) {
      state.loaded = false;
      state.replaying = false;
      state.confirmedModel = undefined;
      state.attemptedModel = undefined;
    }
    if (child && !child.killed) {
      try {
        child.stdin?.end?.();
      } catch {
        // ignore closed stdin
      }
      await killProcessTree(child as unknown as ChildProcess, {
        gracefulMs: CANCEL_ESCALATION_MS,
        ownsProcessGroup: true,
      });
    }
  }

  private async resolveDirectExecutableWithStagedPromote(config: ProviderConfig): Promise<ResolvedExecutable> {
    const explicit = isTruthyString(config.binaryPath) ? config.binaryPath.trim() : undefined;
    const binaryPath = explicit ?? resolveCursorPathForSdk(CURSOR_BIN);
    let plan = resolveCursorLaunchPlan(binaryPath);
    let promoteError: unknown = null;
    if (hasPendingCursorStagedUpdate(plan) && plan.promoteStep) {
      try {
        await this.runExecFile(plan.promoteStep.executable, [...plan.promoteStep.prependArgs, '--version'], {
          windowsHide: true,
          timeout: CONNECT_PROBE_TIMEOUT_MS,
          env: {
            ...process.env,
            ...((config.env && typeof config.env === 'object' ? config.env : {}) as NodeJS.ProcessEnv),
          },
        });
      } catch (err) {
        promoteError = err;
        logger.debug({ err }, 'Cursor staged launcher promote check failed; checking for active entrypoint');
      }
      plan = resolveCursorLaunchPlan(binaryPath);
    }
    if (plan.direct) return plan.direct;
    const message = promoteError
      ? `Cursor staged update promotion failed and no active executable is available: ${formatErrorMessage(promoteError)}`
      : 'Cursor staged update did not activate an executable entrypoint; no active non-.new version is available';
    throw this.makeError(PROVIDER_ERROR_CODES.CONFIG_ERROR, message, false, promoteError ?? undefined);
  }

  private async runExecFile(
    executable: string,
    args: string[],
    options: { windowsHide?: boolean; timeout?: number; env?: NodeJS.ProcessEnv },
  ): Promise<{ stdout: string; stderr: string }> {
    const { execFile } = await cursorAcpRuntimeHooks.loadChildProcess();
    return await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
      const child = execFile(executable, args, options, (error, stdout, stderr) => {
        if (error) {
          reject(error);
          return;
        }
        resolve({
          stdout: typeof stdout === 'string' ? stdout : String(stdout ?? ''),
          stderr: typeof stderr === 'string' ? stderr : String(stderr ?? ''),
        });
      });
      child?.stdin?.end?.();
    });
  }

  private resolveDefaultModel(): string | undefined {
    return normalizeCursorModelId(this.config?.agentId);
  }

  private findSessionByRouteId(routeId: string): [string, CursorAcpSessionState] | undefined {
    const direct = this.sessions.get(routeId);
    if (direct) return [routeId, direct];
    for (const entry of this.sessions.entries()) {
      if (entry[1].routeId === routeId) return entry;
    }
    return undefined;
  }

  private findSessionByAnyId(sessionId: string): [string, CursorAcpSessionState] | undefined {
    const direct = this.sessions.get(sessionId);
    if (direct) return [sessionId, direct];
    const mapped = this.acpToRoute.get(sessionId);
    if (mapped && this.sessions.has(mapped)) return [mapped, this.sessions.get(mapped)!];
    return [...this.sessions.entries()].find(([, state]) => state.acpSessionId === sessionId);
  }

  private isCancelledOrTimeout(err: unknown): boolean {
    if (isRecord(err) && err.code === PROVIDER_ERROR_CODES.CANCELLED) return true;
    const msg = formatErrorMessage(err);
    return /timed out after \d+ms/i.test(msg);
  }

  private normalizeConnectError(err: unknown, fallbackMessage: string): ProviderError {
    if (isRecord(err) && 'code' in err && 'message' in err && 'recoverable' in err) {
      return err as unknown as ProviderError;
    }
    const msg = formatErrorMessage(err);
    if (/ENOENT|not found|spawn .*(?:cursor-agent|agent)/i.test(msg)) {
      return this.makeError(PROVIDER_ERROR_CODES.PROVIDER_NOT_FOUND, `Cursor binary not found: ${msg}`, false, err);
    }
    if (isAuthErrorLike(err)) {
      return this.makeError(PROVIDER_ERROR_CODES.AUTH_FAILED, AUTH_ACTION_HINT, false, err);
    }
    return this.makeError(PROVIDER_ERROR_CODES.CONFIG_ERROR, `${fallbackMessage}: ${msg}`, false, err);
  }

  private normalizeError(err: unknown): ProviderError {
    if (isRecord(err) && 'code' in err && 'message' in err && 'recoverable' in err) {
      return err as unknown as ProviderError;
    }
    if (isAuthErrorLike(err)) {
      return this.makeError(PROVIDER_ERROR_CODES.AUTH_FAILED, AUTH_ACTION_HINT, false, err);
    }
    const msg = formatErrorMessage(err);
    if (/ENOENT|not found|spawn .*(?:cursor-agent|agent)/i.test(msg)) {
      return this.makeError(PROVIDER_ERROR_CODES.PROVIDER_NOT_FOUND, `Cursor binary not found: ${msg}`, false, err);
    }
    if (/closed|epipe|econnreset|broken pipe|stream (?:closed|ended)|server exited|process exited|channel closed|connection lost/i.test(msg)) {
      return this.makeError(PROVIDER_ERROR_CODES.CONNECTION_LOST, msg, true, err);
    }
    return this.makeError(PROVIDER_ERROR_CODES.PROVIDER_ERROR, msg, false, err);
  }

  private makeError(code: string, message: string, recoverable: boolean, details?: unknown): ProviderError {
    return { code, message, recoverable, ...(details !== undefined ? { details } : {}) };
  }
}
