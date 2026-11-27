/**
 * KimiV2Provider — standalone TransportProvider for Kimi Code CLI (`kimi acp`).
 *
 * Aligns `kimi-sdk` with Kimi Code CLI v2 (`@moonshot-ai/kimi-code` 2.8.x)
 * while maintaining backward compatibility with legacy Python `kimi-cli` 1.x.
 * Intentionally standalone from `kimi-sdk.ts` so sibling subclasses
 * (`agy-acp`, `grok-sdk`, `codebuddy`, `hermes-acp`) remain 100% untouched.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';
import { pathToFileURL } from 'node:url';
import {
  ndJsonStream,
  RequestError,
  type ContentBlock,
  type InitializeResponse,
  type LoadSessionResponse,
  type NewSessionResponse,
  type PromptResponse,
  type ReadTextFileRequest,
  type ReadTextFileResponse,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification,
  type SessionUpdate,
  type StopReason,
  type ToolCall,
  type ToolCallContent,
  type ToolCallUpdate,
  type WriteTextFileRequest,
  type WriteTextFileResponse,
} from '@agentclientprotocol/sdk/unstable';
import {
  CONNECTION_MODES,
  normalizeProviderPayload,
  PROVIDER_CANCEL_ORIGINS,
  PROVIDER_ERROR_CODES,
  SESSION_OWNERSHIP,
  type ApprovalRequest,
  type ConnectionMode,
  type ProviderCancelOptions,
  type ProviderCapabilities,
  type ProviderConfig,
  type ProviderError,
  type ProviderModelInfo,
  type ProviderModelList,
  type ProviderStatusUpdate,
  type ProviderUsageUpdate,
  type RemoteSessionInfo,
  type RemoteSessionListOptions,
  type SessionConfig,
  type SessionInfoUpdate,
  type SessionOwnership,
  type TransportProvider,
} from '../transport-provider.js';
import type { AgentMessage, MessageDelta, ToolCallEvent } from '../../../shared/agent-message.js';
import type { ProviderContextPayload } from '../../../shared/context-types.js';
import type { ProviderActiveWorkSnapshot, SessionActivityBusyReason } from '../../../shared/session-activity-types.js';
import type { TransportAttachment } from '../../../shared/transport-attachments.js';
import { NATIVE_AGENT_ADMISSION_MODES } from '../../../shared/native-collaboration-policy.js';
import { isSessionControlCommandText } from '../../../shared/session-control-commands.js';
import { SESSION_MODEL_APPLIED, SESSION_MODEL_APPLY_TIMEOUT_MS, type SessionModelApplied } from '../../../shared/session-model-control.js';
import { MEMORY_MCP_PROVIDER_STATUS_REASON, MEMORY_MCP_STATUS, type MemoryMcpProviderStatusView } from '../../../shared/memory-ws.js';
import { createAcpClientConnection, type AcpClientConnection } from './acp-client-adapter.js';
import { filterAcpJsonLines } from './acp-json-filter.js';
import { acpPlanEntriesToInput } from './acp-plan.js';
import { getDefaultAcpMcpServers, type AcpMcpServerConfig } from './getDefaultMcpServers.js';
import { composeMessageSideProviderPrompt, getProviderSystemTextParts } from '../provider-context-routing.js';
import { confirmPromiseStop } from '../provider-stop-confirmation.js';
import { sessionSystemContractKey, shouldInjectSessionSystemContract } from '../session-system-contract.js';
import {
  canonicalizeTransportCwd,
  normalizeTransportCwd,
  resolveExecutableForSpawn,
  resolveKimiPathForSdk,
  type ResolvedExecutable,
} from '../transport-paths.js';
import { gateChildStream } from '../../util/event-loop-backpressure.js';
import { killProcessTree } from '../../util/kill-process-tree.js';
import { withTimeoutOutcome } from '../../util/timeout-outcome.js';
import logger from '../../util/logger.js';

const INIT_TIMEOUT_MS = 20_000;
const SESSION_TIMEOUT_MS = 30_000;
const MODE_MODEL_TIMEOUT_MS = SESSION_MODEL_APPLY_TIMEOUT_MS;
const CLOSE_TIMEOUT_MS = 5_000;
const MODEL_PROBE_TTL_MS = 30_000;
const CANCEL_GRACE_MS = 10_000;
const MAX_INLINE_IMAGE_BYTES = 10 * 1024 * 1024;
const STDERR_TAIL_LIMIT = 40;
const MAX_TRACKED_TERMINAL_COMPACTIONS = 256;

const IMAGE_MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
};

type JsonRecord = Record<string, unknown>;

export interface KimiV2ProviderOptions {
  initTimeoutMs?: number;
  sessionTimeoutMs?: number;
  modeModelTimeoutMs?: number;
  closeTimeoutMs?: number;
  cancelGraceMs?: number;
  modelProbeTtlMs?: number;
}

interface PendingTurn {
  generation: number;
  messageId: string;
  accumulated: string;
  assistantTextClosed: boolean;
  cancelled: boolean;
  isCompact?: boolean;
  sawCompactionEvent?: boolean;
  compactedInTurn?: boolean;
  compactionOutcome?: 'committed' | 'failed';
  compactionOutcomeEmitted?: boolean;
  turnContextUsage?: ProviderUsageUpdate['usage'];
  cancelGraceTimer: ReturnType<typeof setTimeout> | null;
  terminalTarget: object;
  physicalTerminal: Promise<void>;
  resolvePhysicalTerminal: () => void;
  settled: boolean;
  wireSlot: Promise<void>;
}

interface PendingApproval {
  requestId: string;
  resolve: (res: RequestPermissionResponse) => void;
  reject: (err: Error) => void;
  options: RequestPermissionRequest['options'];
}

interface ActiveToolState {
  id: string;
  name: string;
  kind?: string;
  input?: unknown;
  status: 'running' | 'complete' | 'error';
}

interface KimiSessionState {
  sessionKey: string;
  providerSessionId: string;
  reportedResumeId?: string;
  boundConnectionGeneration: number;
  cwd: string;
  model?: string;
  pendingModel?: string;
  mode?: string;
  lastContextWindow?: number;
  sessionUsesConfigOptions: boolean;
  modelConfigId: string | null;
  systemText?: string;
  lastInjectedSessionSystemKey?: string;
  systemTextInjected: boolean;
  replaying: boolean;
  promptInFlight: boolean;
  turnGeneration: number;
  pendingTurn: PendingTurn | null;
  lastStopTurn: PendingTurn | null;
  lastStatusSignature: string | null;
  compactionTrackerGeneration: number;
  activeCompactionIds: Set<string>;
  terminalCompactionIds: Set<string>;
  activeTools: Map<string, ActiveToolState>;
  pendingApprovals: Map<string, PendingApproval>;
  mcpServers: AcpMcpServerConfig[];
  env?: Record<string, string>;
}

interface ExtractedModelCatalog {
  models: ProviderModelInfo[];
  defaultModel?: string;
  hasConfigOption: boolean;
  configId: string | null;
}

interface ConnectionCapabilities {
  agentInfo: { name?: string; version?: string } | null;
  promptImageSupported: boolean;
  promptEmbeddedContextSupported: boolean;
  sessionResumeSupported: boolean;
  sessionListSupported: boolean;
  sessionCloseSupported: boolean;
  loadSessionSupported: boolean;
  modelSwitchMode: 'configOption' | 'unstableModel' | null;
}

function defaultConnectionCapabilities(): ConnectionCapabilities {
  return {
    agentInfo: null,
    promptImageSupported: false,
    promptEmbeddedContextSupported: false,
    sessionResumeSupported: false,
    sessionListSupported: false,
    sessionCloseSupported: false,
    loadSessionSupported: false,
    modelSwitchMode: null,
  };
}

function asRecord(value: unknown): JsonRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonRecord) : null;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isAbortLikeError(err: unknown): boolean {
  if (!err) return false;
  if (err instanceof RequestError) {
    return err.code === -32800 || /cancel|abort/i.test(err.message);
  }
  const msg = err instanceof Error ? err.message : String(err);
  return /abort|cancel/i.test(msg);
}

function isAuthLikeError(err: unknown): boolean {
  if (!err) return false;
  if (err instanceof RequestError) {
    if (err.code === -32000) return true;
    const dataMsg = typeof err.data === 'string' ? err.data : JSON.stringify(err.data ?? '');
    return /auth|unauthorized|api.?key|login|token/i.test(`${err.message} ${dataMsg}`);
  }
  const msg = err instanceof Error ? err.message : String(err);
  return /auth(?:entication)?\s+required|unauthorized|api.?key|not\s+logged\s+in|-32000/i.test(msg);
}

function isSessionNotFoundError(err: unknown): boolean {
  if (!err) return false;
  if (err instanceof RequestError) {
    if (err.code === -32002 || err.code === -32004) return true;
    const dataMsg = typeof err.data === 'string' ? err.data : JSON.stringify(err.data ?? '');
    if (/not\s*found|unknown\s+session|no\s+such\s+session|session\s+does\s+not\s+exist/i.test(`${err.message} ${dataMsg}`)) {
      return true;
    }
  }
  const msg = err instanceof Error ? err.message : String(err);
  return /session\s+(?:not\s+found|does\s+not\s+exist|expired|unknown)|not\s+found/i.test(msg);
}

function isMethodNotFoundError(err: unknown): boolean {
  if (!err) return false;
  if (err instanceof RequestError && err.code === -32601) return true;
  const msg = err instanceof Error ? err.message : String(err);
  return /method\s+not\s+found|-32601/i.test(msg);
}

function inferErrorCode(err: unknown): string {
  if (isAuthLikeError(err)) return PROVIDER_ERROR_CODES.AUTH_FAILED;
  const code = asRecord(err)?.code;
  if (code === 'ENOENT') return PROVIDER_ERROR_CODES.CONFIG_ERROR;
  if (isSessionNotFoundError(err)) return PROVIDER_ERROR_CODES.SESSION_NOT_FOUND;
  if (isAbortLikeError(err)) return PROVIDER_ERROR_CODES.CANCELLED;
  return PROVIDER_ERROR_CODES.PROVIDER_ERROR;
}

function extractTextFromContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((part) => extractTextFromContent(part)).filter(Boolean).join('');
  }
  const rec = asRecord(content);
  if (!rec) return '';
  if (typeof rec.text === 'string') return rec.text;
  if (rec.content !== undefined) return extractTextFromContent(rec.content);
  return '';
}

function extractToolOutputText(content: ToolCallContent[] | null | undefined, rawOutput: unknown): string | undefined {
  const chunks: string[] = [];
  if (Array.isArray(content)) {
    for (const block of content) {
      const rec = asRecord(block);
      if (!rec) continue;
      if (rec.type === 'content') {
        const text = extractTextFromContent(rec.content);
        if (text) chunks.push(text);
      } else if (rec.type === 'diff') {
        const filePath = isNonEmptyString(rec.path) ? rec.path : 'diff';
        chunks.push(`[diff: ${filePath}]`);
      } else if (rec.type === 'terminal' && isNonEmptyString(rec.terminalId)) {
        chunks.push(`[terminal: ${rec.terminalId}]`);
      }
    }
  }
  if (chunks.length > 0) return chunks.join('\n');
  if (typeof rawOutput === 'string') return rawOutput;
  if (rawOutput !== undefined && rawOutput !== null) {
    try {
      return JSON.stringify(rawOutput);
    } catch {
      return String(rawOutput);
    }
  }
  return undefined;
}

function extractModelCatalog(resp: unknown): ExtractedModelCatalog {
  const rec = asRecord(resp);
  if (!rec) return { models: [], hasConfigOption: false, configId: null };

  if (Array.isArray(rec.configOptions)) {
    for (const rawOpt of rec.configOptions) {
      const opt = asRecord(rawOpt);
      if (!opt) continue;
      if (opt.category !== 'model' && opt.id !== 'model') continue;
      const models: ProviderModelInfo[] = [];
      const seen = new Set<string>();
      const pushOption = (entry: unknown) => {
        const item = asRecord(entry);
        if (!item) return;
        if (Array.isArray(item.options)) {
          for (const nested of item.options) pushOption(nested);
          return;
        }
        const value = isNonEmptyString(item.value) ? item.value.trim() : isNonEmptyString(item.id) ? item.id.trim() : '';
        if (!value || seen.has(value)) return;
        seen.add(value);
        models.push({
          id: value,
          name: isNonEmptyString(item.name) ? item.name.trim() : value,
        });
      };
      if (Array.isArray(opt.options)) {
        for (const entry of opt.options) pushOption(entry);
      }
      const currentValue = isNonEmptyString(opt.currentValue) ? opt.currentValue.trim() : undefined;
      const configId = isNonEmptyString(opt.id) ? opt.id.trim() : 'model';
      if (models.length > 0 || currentValue) {
        if (currentValue && !seen.has(currentValue)) {
          models.unshift({ id: currentValue, name: currentValue });
        }
        return {
          models,
          defaultModel: currentValue ?? models[0]?.id,
          hasConfigOption: true,
          configId,
        };
      }
    }
  }

  const legacyModels = asRecord(rec.models);
  if (legacyModels && Array.isArray(legacyModels.availableModels)) {
    const models: ProviderModelInfo[] = [];
    const seen = new Set<string>();
    for (const item of legacyModels.availableModels) {
      const m = asRecord(item);
      if (!m) continue;
      const id = isNonEmptyString(m.modelId) ? m.modelId.trim() : isNonEmptyString(m.id) ? m.id.trim() : '';
      if (!id || seen.has(id)) continue;
      seen.add(id);
      models.push({
        id,
        name: isNonEmptyString(m.name) ? m.name.trim() : id,
      });
    }
    const currentModelId = isNonEmptyString(legacyModels.currentModelId) ? legacyModels.currentModelId.trim() : undefined;
    if (currentModelId && !seen.has(currentModelId)) {
      models.unshift({ id: currentModelId, name: currentModelId });
    }
    return {
      models,
      defaultModel: currentModelId ?? models[0]?.id,
      hasConfigOption: false,
      configId: null,
    };
  }

  return { models: [], hasConfigOption: false, configId: null };
}

function inferImageMime(filePath: string): string | null {
  const ext = path.extname(filePath).toLowerCase();
  return IMAGE_MIME_BY_EXT[ext] ?? null;
}

function nonNegativeFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function positiveFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

/** Extract cumulative session-wide `PromptResponse.usage` separately from current-context occupancy. */
function extractCumulativePromptUsage(response: PromptResponse | null | undefined): Record<string, number> | undefined {
  const usage = asRecord(response?.usage);
  if (!usage) return undefined;
  const totalTokens = nonNegativeFiniteNumber(usage.totalTokens);
  const inputTokens = nonNegativeFiniteNumber(usage.inputTokens);
  const outputTokens = nonNegativeFiniteNumber(usage.outputTokens);
  const thoughtTokens = nonNegativeFiniteNumber(usage.thoughtTokens);
  const cachedReadTokens = nonNegativeFiniteNumber(usage.cachedReadTokens);
  const cachedWriteTokens = nonNegativeFiniteNumber(usage.cachedWriteTokens);
  if (
    totalTokens === undefined
    && inputTokens === undefined
    && outputTokens === undefined
    && thoughtTokens === undefined
    && cachedReadTokens === undefined
    && cachedWriteTokens === undefined
  ) {
    return undefined;
  }
  return {
    ...(totalTokens !== undefined ? { totalTokens } : {}),
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(thoughtTokens !== undefined ? { thoughtTokens } : {}),
    ...(cachedReadTokens !== undefined ? { cachedReadTokens } : {}),
    ...(cachedWriteTokens !== undefined ? { cachedWriteTokens } : {}),
  };
}

function extractMetaContextWindow(meta: JsonRecord | null | undefined): number | undefined {
  if (!meta) return undefined;
  const limit = asRecord(meta.limit);
  const tokens = asRecord(meta.tokens);
  return (
    positiveFiniteNumber(meta.model_context_window)
    ?? positiveFiniteNumber(meta.contextWindow)
    ?? positiveFiniteNumber(meta.context_window)
    ?? positiveFiniteNumber(meta.contextWindowSize)
    ?? positiveFiniteNumber(meta.maxContextTokens)
    ?? positiveFiniteNumber(meta.max_context_tokens)
    ?? positiveFiniteNumber(meta.size)
    ?? positiveFiniteNumber(tokens?.limit)
    ?? positiveFiniteNumber(limit?.context)
    ?? positiveFiniteNumber(limit?.contextWindow)
  );
}

/**
 * Normalize an atomic current-context occupancy snapshot (`session/update` `usage_update` or
 * explicit `PromptResponse._meta` snapshot, never cumulative `PromptResponse.usage`).
 * When `used` is supplied, ACP defines it as total tokens currently in context, so same-frame
 * cache read/write counts are subtracted only when consistent (`read + write <= used`) to avoid
 * double counting downstream in transport relay; inconsistent breakdowns omit cache fields.
 */
function normalizeKimiContextUsageSnapshot(
  raw: JsonRecord | null | undefined,
  fallbackWindow?: number,
  options: { requireOccupancyInput?: boolean } = {},
): ProviderUsageUpdate['usage'] | undefined {
  if (!raw) return undefined;
  const tokens = asRecord(raw.tokens);
  const totalUsed = nonNegativeFiniteNumber(raw.used);
  const explicitInput =
    nonNegativeFiniteNumber(raw.input_tokens)
    ?? nonNegativeFiniteNumber(raw.inputTokens)
    ?? nonNegativeFiniteNumber(raw.input)
    ?? nonNegativeFiniteNumber(tokens?.input);
  const outputTokens =
    nonNegativeFiniteNumber(raw.output_tokens)
    ?? nonNegativeFiniteNumber(raw.outputTokens)
    ?? nonNegativeFiniteNumber(tokens?.output);
  const cachedReadTokens =
    nonNegativeFiniteNumber(raw.cache_read_input_tokens)
    ?? nonNegativeFiniteNumber(raw.cached_input_tokens)
    ?? nonNegativeFiniteNumber(raw.cachedReadTokens)
    ?? nonNegativeFiniteNumber(raw.cacheReadTokens)
    ?? nonNegativeFiniteNumber(raw.cached)
    ?? nonNegativeFiniteNumber(tokens?.cached)
    ?? nonNegativeFiniteNumber(tokens?.cachedRead)
    ?? nonNegativeFiniteNumber(tokens?.cacheRead);
  const cachedWriteTokens =
    nonNegativeFiniteNumber(raw.cache_creation_input_tokens)
    ?? nonNegativeFiniteNumber(raw.cachedWriteTokens)
    ?? nonNegativeFiniteNumber(raw.cacheCreationInputTokens)
    ?? nonNegativeFiniteNumber(raw.cacheWriteTokens)
    ?? nonNegativeFiniteNumber(tokens?.cachedWrite)
    ?? nonNegativeFiniteNumber(tokens?.cacheWrite);
  const resolvedWindow = extractMetaContextWindow(raw) ?? positiveFiniteNumber(fallbackWindow);

  let inputTokens: number | undefined;
  let finalCachedRead = cachedReadTokens;
  let finalCachedWrite = cachedWriteTokens;
  if (totalUsed !== undefined) {
    const readVal = cachedReadTokens ?? 0;
    const writeVal = cachedWriteTokens ?? 0;
    if (readVal + writeVal <= totalUsed) {
      inputTokens = totalUsed - readVal - writeVal;
    } else {
      inputTokens = totalUsed;
      finalCachedRead = undefined;
      finalCachedWrite = undefined;
    }
  } else {
    inputTokens = explicitInput;
  }

  if (options.requireOccupancyInput && inputTokens === undefined) {
    return undefined;
  }
  if (
    inputTokens === undefined
    && outputTokens === undefined
    && finalCachedRead === undefined
    && finalCachedWrite === undefined
  ) {
    return undefined;
  }

  return {
    ...(inputTokens !== undefined ? { input_tokens: inputTokens } : {}),
    ...(outputTokens !== undefined ? { output_tokens: outputTokens } : {}),
    ...(finalCachedRead !== undefined ? { cached_input_tokens: finalCachedRead, cache_read_input_tokens: finalCachedRead } : {}),
    ...(finalCachedWrite !== undefined ? { cache_creation_input_tokens: finalCachedWrite } : {}),
    ...(resolvedWindow !== undefined ? { model_context_window: resolvedWindow } : {}),
  };
}

/** Extract an explicit Kimi `_meta` current-context occupancy snapshot (never PromptResponse.usage). */
function extractMetaContextUsage(
  meta: JsonRecord | null | undefined,
  fallbackWindow?: number,
): ProviderUsageUpdate['usage'] | undefined {
  return normalizeKimiContextUsageSnapshot(meta, fallbackWindow, { requireOccupancyInput: true });
}

function computeExecutableFingerprint(bin: ResolvedExecutable): string {
  const target = bin.prependArgs[0] ?? bin.executable;
  try {
    const stat = statSync(target);
    return `${bin.executable}:${target}:${stat.size}:${Math.trunc(stat.mtimeMs)}`;
  } catch {
    return `${bin.executable}:${target}`;
  }
}

export class KimiV2Provider implements TransportProvider {
  readonly id = 'kimi-sdk';
  readonly connectionMode: ConnectionMode = CONNECTION_MODES.LOCAL_SDK;
  readonly sessionOwnership: SessionOwnership = SESSION_OWNERSHIP.SHARED;
  readonly capabilities: ProviderCapabilities = {
    streaming: true,
    toolCalling: true,
    approval: true,
    sessionRestore: true,
    multiTurn: true,
    attachments: true,
    reasoningEffort: false,
    compact: {
      execution: 'slash-command',
      providerCommand: '/compact',
      verified: true,
      completion: 'rpc-result-or-provider-event',
      cancellation: 'provider-cancel',
      reassertsSessionSystemText: false,
    },
    nativeAgentAdmission: NATIVE_AGENT_ADMISSION_MODES.NO_NATIVE_AGENT_TOOLS,
  };

  private readonly initTimeoutMs: number;
  private readonly sessionTimeoutMs: number;
  private readonly modeModelTimeoutMs: number;
  private readonly closeTimeoutMs: number;
  private readonly cancelGraceMs: number;
  private readonly modelProbeTtlMs: number;

  private providerConfig: ProviderConfig | null = null;
  private child: ChildProcess | null = null;
  private connection: AcpClientConnection | null = null;
  private lifecycleEpoch = 0;
  private connectionGeneration = 0;
  private connectingState: {
    generation: number;
    promise: Promise<AcpClientConnection>;
    envKey: string;
    fingerprint: string;
  } | null = null;
  private connectedFingerprint: string | null = null;
  private connectedEnvKey: string | null = null;
  private connCaps: ConnectionCapabilities = defaultConnectionCapabilities();
  private stderrTail: string[] = [];

  private readonly sessions = new Map<string, KimiSessionState>();
  private readonly acpToRoute = new Map<string, string>();

  private cachedModels: ProviderModelList | null = null;
  private cachedModelsAt = 0;
  private lastErrorCode: string | null = null;

  private wireOrderTail: Promise<void> = Promise.resolve();

  private readonly deltaHandlers = new Set<(sessionId: string, delta: MessageDelta) => void>();
  private readonly completeHandlers = new Set<(sessionId: string, message: AgentMessage) => void>();
  private readonly errorHandlers = new Set<(sessionId: string, error: ProviderError) => void>();
  private readonly sessionInfoHandlers = new Set<(sessionId: string, info: SessionInfoUpdate) => void>();
  private readonly statusHandlers = new Set<(sessionId: string, status: ProviderStatusUpdate) => void>();
  private readonly usageHandlers = new Set<(sessionId: string, update: ProviderUsageUpdate) => void>();
  private readonly toolCallHandlers = new Set<(sessionId: string, tool: ToolCallEvent) => void>();
  private readonly approvalHandlers = new Set<(sessionId: string, req: ApprovalRequest) => void>();

  constructor(options: KimiV2ProviderOptions = {}) {
    this.initTimeoutMs = options.initTimeoutMs ?? INIT_TIMEOUT_MS;
    this.sessionTimeoutMs = options.sessionTimeoutMs ?? SESSION_TIMEOUT_MS;
    this.modeModelTimeoutMs = options.modeModelTimeoutMs ?? MODE_MODEL_TIMEOUT_MS;
    this.closeTimeoutMs = options.closeTimeoutMs ?? CLOSE_TIMEOUT_MS;
    this.cancelGraceMs = options.cancelGraceMs ?? CANCEL_GRACE_MS;
    this.modelProbeTtlMs = options.modelProbeTtlMs ?? MODEL_PROBE_TTL_MS;
  }

  onDelta(cb: (sessionId: string, delta: MessageDelta) => void): () => void {
    this.deltaHandlers.add(cb);
    return () => { this.deltaHandlers.delete(cb); };
  }

  onComplete(cb: (sessionId: string, message: AgentMessage) => void): () => void {
    this.completeHandlers.add(cb);
    return () => { this.completeHandlers.delete(cb); };
  }

  onError(cb: (sessionId: string, error: ProviderError) => void): () => void {
    this.errorHandlers.add(cb);
    return () => { this.errorHandlers.delete(cb); };
  }

  onSessionInfo(cb: (sessionId: string, info: SessionInfoUpdate) => void): () => void {
    this.sessionInfoHandlers.add(cb);
    return () => { this.sessionInfoHandlers.delete(cb); };
  }

  onStatus(cb: (sessionId: string, status: ProviderStatusUpdate) => void): () => void {
    this.statusHandlers.add(cb);
    return () => { this.statusHandlers.delete(cb); };
  }

  onUsage(cb: (sessionId: string, update: ProviderUsageUpdate) => void): () => void {
    this.usageHandlers.add(cb);
    return () => { this.usageHandlers.delete(cb); };
  }

  onToolCall(cb: (sessionId: string, tool: ToolCallEvent) => void): void {
    this.toolCallHandlers.add(cb);
  }

  onApprovalRequest(cb: (sessionId: string, req: ApprovalRequest) => void): void {
    this.approvalHandlers.add(cb);
  }

  async connect(config: ProviderConfig): Promise<void> {
    this.providerConfig = config;
  }

  async disconnect(): Promise<void> {
    this.lifecycleEpoch++;
    this.connectionGeneration++;
    const childToKill = this.child;
    this.child = null;
    this.connection = null;
    this.connectingState = null;
    this.connectedFingerprint = null;
    this.connectedEnvKey = null;
    this.connCaps = defaultConnectionCapabilities();

    const states = Array.from(this.sessions.values());
    this.sessions.clear();
    this.acpToRoute.clear();
    for (const state of states) {
      this.rejectPendingApprovals(state, new Error('Provider disconnected'));
      if (state.pendingTurn) {
        this.failTurn(state, state.pendingTurn, new Error('Provider disconnected'), PROVIDER_ERROR_CODES.CONNECTION_LOST, true);
      }
      this.resetSessionCompactionTracking(state);
      this.clearStatus(state.sessionKey, state);
    }

    if (childToKill) {
      await killProcessTree(childToKill, { ownsProcessGroup: true });
    }
  }

  private resolveBinaryCommand(env: NodeJS.ProcessEnv): ResolvedExecutable {
    const explicit = typeof this.providerConfig?.binaryPath === 'string'
      ? this.providerConfig.binaryPath.trim()
      : '';
    const raw = explicit || resolveKimiPathForSdk('kimi', env);
    return resolveExecutableForSpawn(raw);
  }

  private buildSpawnEnv(sessionConfig?: SessionConfig): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env };
    if (this.providerConfig?.apiKey && typeof this.providerConfig.apiKey === 'string') {
      env.KIMI_API_KEY = this.providerConfig.apiKey;
    }
    if (sessionConfig?.authContext?.env) {
      for (const [k, v] of Object.entries(sessionConfig.authContext.env)) {
        if (typeof v === 'string') env[k] = v;
      }
    }
    if (sessionConfig?.env) {
      for (const [k, v] of Object.entries(sessionConfig.env)) {
        if (typeof v === 'string') env[k] = v;
      }
    }
    return env;
  }

  private isChildAlive(): boolean {
    return Boolean(this.child && this.child.exitCode === null && this.child.signalCode === null && !this.child.killed);
  }

  private async teardownChildProcess(expectedChild?: ChildProcess | null, expectedGeneration?: number): Promise<void> {
    if (expectedChild && this.child !== expectedChild) {
      await killProcessTree(expectedChild, { ownsProcessGroup: true });
      return;
    }
    if (expectedGeneration !== undefined && this.connectionGeneration !== expectedGeneration) {
      if (expectedChild) {
        await killProcessTree(expectedChild, { ownsProcessGroup: true });
      }
      return;
    }
    const child = this.child;
    this.child = null;
    this.connection = null;
    this.connectedFingerprint = null;
    this.connectedEnvKey = null;
    this.connCaps = defaultConnectionCapabilities();
    if (child) {
      await killProcessTree(child, { ownsProcessGroup: true });
    }
  }

  private async ensureConnected(sessionConfig?: SessionConfig): Promise<AcpClientConnection> {
    const env = this.buildSpawnEnv(sessionConfig);
    const bin = this.resolveBinaryCommand(env);
    const fingerprint = computeExecutableFingerprint(bin);
    const envKey = `${env.KIMI_API_KEY ?? ''}\0${env.KIMI_CODE_HOME ?? ''}\0${env.KIMI_CLI_PATH ?? ''}`;

    // Never hand out a partially-initialized or recycling connection.
    if (this.connectingState) {
      return this.connectingState.promise;
    }

    if (
      this.connection
      && this.isChildAlive()
      && (!this.connectedFingerprint || this.connectedFingerprint === fingerprint)
      && (this.sessions.size > 0 || this.connectedEnvKey === envKey)
    ) {
      return this.connection;
    }

    const epoch = this.lifecycleEpoch;
    const generation = ++this.connectionGeneration;
    let spawnedChild: ChildProcess | null = null;
    const isActiveConnect = () => this.lifecycleEpoch === epoch && this.connectionGeneration === generation;

    // Publish the in-flight connection transaction synchronously BEFORE awaiting teardown,
    // so concurrent createSession/send callers share this exact recycle + initialize pass.
    const connectPromise = (async (): Promise<AcpClientConnection> => {
      const hasActiveTurns = Array.from(this.sessions.values()).some((s) => s.promptInFlight);
      if (this.child && !hasActiveTurns) {
        await this.teardownChildProcess();
      }

      if (!isActiveConnect()) {
        throw new Error('Provider disconnected or connection superseded before spawn');
      }

      const cwd = normalizeTransportCwd(canonicalizeTransportCwd(sessionConfig?.cwd)) || process.cwd();
      this.stderrTail = [];
      this.connCaps = defaultConnectionCapabilities();

      const child = spawn(bin.executable, [...bin.prependArgs, 'acp'], {
        cwd,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
        windowsHide: true,
      });
      spawnedChild = child;
      this.child = child;
      this.connectedFingerprint = fingerprint;
      this.connectedEnvKey = envKey;

      const spawnErrorPromise = new Promise<never>((_, reject) => {
        child.once('error', (err) => reject(err));
      });

      child.stderr?.on('data', (chunk: Buffer | string) => {
        if (this.child !== child || !isActiveConnect()) return;
        const text = chunk.toString('utf8');
        for (const line of text.split(/\r?\n/)) {
          if (!line.trim()) continue;
          this.stderrTail.push(line);
          if (this.stderrTail.length > STDERR_TAIL_LIMIT) this.stderrTail.shift();
        }
      });

      child.once('exit', (code, signal) => {
        for (const state of this.sessions.values()) {
          if (state.pendingTurn && state.boundConnectionGeneration === generation) {
            state.pendingTurn.resolvePhysicalTerminal();
          }
          if (state.lastStopTurn && state.boundConnectionGeneration === generation) {
            state.lastStopTurn.resolvePhysicalTerminal();
          }
        }
        if (this.child !== child || !isActiveConnect()) return;
        this.child = null;
        this.connection = null;
        this.connectedFingerprint = null;
        this.connectedEnvKey = null;
        this.connCaps = defaultConnectionCapabilities();
        const exitMsg = `kimi acp exited unexpectedly (code=${code ?? 'null'}, signal=${signal ?? 'null'})`;
        for (const state of this.sessions.values()) {
          this.rejectPendingApprovals(state, new Error(exitMsg));
          if (state.boundConnectionGeneration === generation) {
            if (state.pendingTurn) {
              this.failTurn(state, state.pendingTurn, new Error(exitMsg), PROVIDER_ERROR_CODES.CONNECTION_LOST, true);
            } else {
              this.clearStatus(state.sessionKey, state);
            }
            this.resetSessionCompactionTracking(state);
          }
        }
      });

      if (!child.stdout || !child.stdin) {
        await this.teardownChildProcess(child, generation);
        throw new Error('Failed to open stdio pipes for kimi acp');
      }

      const filteredStdout = filterAcpJsonLines(gateChildStream(child.stdout), (line, count) => {
        if (count <= 5 || count % 50 === 0) {
          logger.debug({ provider: this.id, count, line: line.slice(0, 200) }, 'kimi-v2 dropped non-JSON ACP line');
        }
      });

      const readable = Readable.toWeb(filteredStdout) as ReadableStream<Uint8Array>;
      const writable = Writable.toWeb(child.stdin) as WritableStream<Uint8Array>;
      const stream = ndJsonStream(writable, readable);

      const isCurrentGeneration = () => isActiveConnect() && this.child === child;
      const candidateConnection = createAcpClientConnection(
        {
          sessionUpdate: async (notification: SessionNotification) => {
            if (!isCurrentGeneration()) return;
            await this.enqueueWireOrder(() => {
              if (!isCurrentGeneration()) return;
              this.handleSessionUpdate(notification);
            });
          },
          requestPermission: async (params: RequestPermissionRequest) => {
            if (!isCurrentGeneration()) return { outcome: { outcome: 'cancelled' } };
            return this.handleRequestPermission(params);
          },
          readTextFile: async (params: ReadTextFileRequest) => this.handleReadTextFile(params),
          writeTextFile: async (params: WriteTextFileRequest) => this.handleWriteTextFile(params),
        },
        stream,
      );

      const initRace = Promise.race([
        candidateConnection.initialize({
          protocolVersion: 1,
          clientCapabilities: {
            fs: {
              readTextFile: true,
              writeTextFile: true,
            },
            session: {
              compaction: {},
            },
          },
          clientInfo: { name: 'imcodes', version: '1.0.0' },
        }),
        spawnErrorPromise,
      ]);

      const initOutcome = await withTimeoutOutcome(initRace, this.initTimeoutMs);
      if (initOutcome.timedOut) {
        await this.teardownChildProcess(child, generation);
        throw new Error(`kimi acp initialize timed out after ${this.initTimeoutMs}ms`);
      }

      if (!isCurrentGeneration()) {
        await killProcessTree(child, { ownsProcessGroup: true });
        throw new Error('kimi acp connection superseded before initialization completed');
      }

      this.applyInitializeResult(initOutcome.value);
      this.connection = candidateConnection;
      return candidateConnection;
    })();

    this.connectingState = { generation, promise: connectPromise, envKey, fingerprint };
    try {
      return await connectPromise;
    } catch (err) {
      if (spawnedChild) {
        await this.teardownChildProcess(spawnedChild, generation);
      }
      throw this.normalizeProviderException(err);
    } finally {
      if (this.connectingState?.promise === connectPromise) {
        this.connectingState = null;
      }
    }
  }

  private applyInitializeResult(result: InitializeResponse): void {
    const rec = asRecord(result);
    const agentInfo = asRecord(rec?.agentInfo);
    const caps = asRecord(rec?.agentCapabilities);
    const promptCaps = asRecord(caps?.promptCapabilities);
    const sessionCaps = asRecord(caps?.sessionCapabilities);

    this.connCaps = {
      agentInfo: agentInfo
        ? {
            name: isNonEmptyString(agentInfo.name) ? agentInfo.name : undefined,
            version: isNonEmptyString(agentInfo.version) ? agentInfo.version : undefined,
          }
        : null,
      promptImageSupported: promptCaps?.image === true,
      promptEmbeddedContextSupported: promptCaps?.embeddedContext === true,
      loadSessionSupported: caps?.loadSession === true,
      sessionResumeSupported: sessionCaps?.resume != null && sessionCaps.resume !== false,
      sessionListSupported: sessionCaps?.list != null && sessionCaps.list !== false,
      sessionCloseSupported: sessionCaps?.close != null && sessionCaps.close !== false,
      modelSwitchMode: null,
    };
  }

  private normalizeProviderException(err: unknown): Error & { code?: string } {
    const code = inferErrorCode(err);
    this.lastErrorCode = code;
    if (code === PROVIDER_ERROR_CODES.CONFIG_ERROR) {
      const wrapped = new Error(
        `Kimi CLI binary not found or failed to launch (${err instanceof Error ? err.message : String(err)}). Install @moonshot-ai/kimi-code or set KIMI_CLI_PATH.`,
      ) as Error & { code?: string };
      wrapped.code = code;
      return wrapped;
    }
    if (code === PROVIDER_ERROR_CODES.AUTH_FAILED) {
      const wrapped = new Error(
        'Kimi CLI authentication required. Run `kimi` and complete `/login` (or `kimi acp --login`), or set KIMI_API_KEY.',
      ) as Error & { code?: string };
      wrapped.code = code;
      return wrapped;
    }
    if (err instanceof Error) {
      const enriched = err as Error & { code?: string };
      if (!enriched.code) enriched.code = code;
      return enriched;
    }
    const wrapped = new Error(String(err)) as Error & { code?: string };
    wrapped.code = code;
    return wrapped;
  }

  private enqueueWireOrder(fn: () => Promise<void> | void): Promise<void> {
    const next = this.wireOrderTail.then(() => fn()).catch((err) => {
      logger.warn({ provider: this.id, err: err instanceof Error ? err.message : String(err) }, 'kimi-v2 wire handler error');
    });
    this.wireOrderTail = next;
    return next;
  }

  private reserveWireSlot(): Promise<void> {
    return this.wireOrderTail;
  }

  private resolveState(sessionKeyOrProviderId: string): KimiSessionState | undefined {
    const direct = this.sessions.get(sessionKeyOrProviderId);
    if (direct) return direct;
    const mappedRouteId = this.acpToRoute.get(sessionKeyOrProviderId);
    return mappedRouteId ? this.sessions.get(mappedRouteId) : undefined;
  }

  private resetSessionCompactionTracking(state: KimiSessionState, generation?: number): void {
    state.activeCompactionIds.clear();
    state.terminalCompactionIds.clear();
    if (generation !== undefined) {
      state.compactionTrackerGeneration = generation;
    }
  }

  private recordTerminalCompactionId(state: KimiSessionState, compactionId: string): void {
    state.activeCompactionIds.delete(compactionId);
    if (!state.terminalCompactionIds.has(compactionId)) {
      state.terminalCompactionIds.add(compactionId);
      if (state.terminalCompactionIds.size > MAX_TRACKED_TERMINAL_COMPACTIONS) {
        const oldest = state.terminalCompactionIds.values().next().value;
        if (oldest !== undefined) state.terminalCompactionIds.delete(oldest);
      }
    }
  }

  private retireActiveCompactionsForTurn(state: KimiSessionState): void {
    if (state.activeCompactionIds.size === 0) return;
    for (const id of state.activeCompactionIds) {
      this.recordTerminalCompactionId(state, id);
    }
    state.activeCompactionIds.clear();
  }

  private bindNativeSession(providerSessionId: string, state: KimiSessionState): void {
    if (this.sessions.get(state.sessionKey) !== state) return;
    const prevProviderId = state.providerSessionId;
    if (prevProviderId && prevProviderId !== providerSessionId && this.acpToRoute.get(prevProviderId) === state.sessionKey) {
      this.acpToRoute.delete(prevProviderId);
    }
    if (prevProviderId !== providerSessionId) {
      this.resetSessionCompactionTracking(state);
    }
    state.providerSessionId = providerSessionId;
    this.sessions.set(state.sessionKey, state);
    this.acpToRoute.set(providerSessionId, state.sessionKey);
  }

  private unbindSession(sessionKey: string): KimiSessionState | null {
    const state = this.sessions.get(sessionKey);
    if (!state) return null;
    this.sessions.delete(sessionKey);
    if (state.providerSessionId && this.acpToRoute.get(state.providerSessionId) === sessionKey) {
      this.acpToRoute.delete(state.providerSessionId);
    }
    return state;
  }

  private cacheModelsFromResponse(resp: unknown, state?: KimiSessionState): ExtractedModelCatalog {
    const catalog = extractModelCatalog(resp);
    if (catalog.hasConfigOption) {
      this.connCaps.modelSwitchMode = 'configOption';
      if (state) {
        state.sessionUsesConfigOptions = true;
        state.modelConfigId = catalog.configId ?? 'model';
      }
    } else if (catalog.models.length > 0 && this.connCaps.modelSwitchMode === null) {
      this.connCaps.modelSwitchMode = 'unstableModel';
      if (state) {
        state.sessionUsesConfigOptions = false;
      }
    }
    if (catalog.models.length > 0 || catalog.defaultModel) {
      this.cachedModels = {
        models: catalog.models,
        defaultModel: catalog.defaultModel,
        isAuthenticated: true,
        modelCatalogSource: 'live',
      };
      this.cachedModelsAt = Date.now();
    }
    return catalog;
  }

  private async switchProviderModel(
    connection: AcpClientConnection,
    state: KimiSessionState,
    modelId: string,
  ): Promise<void> {
    const useConfigOption = state.sessionUsesConfigOptions || this.connCaps.modelSwitchMode === 'configOption';
    if (useConfigOption) {
      if (typeof connection.setSessionConfigOption !== 'function') {
        throw new Error('Provider does not implement setSessionConfigOption');
      }
      const outcome = await withTimeoutOutcome(
        connection.setSessionConfigOption({
          sessionId: state.providerSessionId,
          configId: state.modelConfigId ?? 'model',
          value: modelId,
        }),
        this.modeModelTimeoutMs,
      );
      if (outcome.timedOut) {
        throw new Error(`setSessionConfigOption timed out after ${this.modeModelTimeoutMs}ms`);
      }
      return;
    }

    if (typeof connection.unstable_setSessionModel === 'function') {
      try {
        const outcome = await withTimeoutOutcome(
          connection.unstable_setSessionModel({
            sessionId: state.providerSessionId,
            modelId,
          }),
          this.modeModelTimeoutMs,
        );
        if (outcome.timedOut) {
          throw new Error(`unstable_setSessionModel timed out after ${this.modeModelTimeoutMs}ms`);
        }
        return;
      } catch (err) {
        if (!isMethodNotFoundError(err)) throw err;
        state.sessionUsesConfigOptions = true;
        state.modelConfigId = state.modelConfigId ?? 'model';
        this.connCaps.modelSwitchMode = 'configOption';
      }
    }

    if (typeof connection.setSessionConfigOption !== 'function') {
      throw new Error('Provider supports neither unstable_setSessionModel nor setSessionConfigOption');
    }
    const fallbackOutcome = await withTimeoutOutcome(
      connection.setSessionConfigOption({
        sessionId: state.providerSessionId,
        configId: state.modelConfigId ?? 'model',
        value: modelId,
      }),
      this.modeModelTimeoutMs,
    );
    if (fallbackOutcome.timedOut) {
      throw new Error(`setSessionConfigOption timed out after ${this.modeModelTimeoutMs}ms`);
    }
  }

  /**
   * Ensure the native ACP session is bound for this connection generation and
   * any pending model selection is confirmed before prompts run.
   */
  private async ensureSessionReady(
    state: KimiSessionState,
    connection: AcpClientConnection,
    options: { allowFresh?: boolean } = {},
  ): Promise<void> {
    const allowFresh = options.allowFresh ?? true;
    const epoch = this.lifecycleEpoch;
    const targetConnGen = this.connectionGeneration;
    const assertOwned = () => {
      if (this.lifecycleEpoch !== epoch || this.sessions.get(state.sessionKey) !== state) {
        throw Object.assign(new Error('Session ended or provider disconnected during setup'), { code: PROVIDER_ERROR_CODES.CANCELLED });
      }
      if (this.connection !== connection || this.connectionGeneration !== targetConnGen) {
        throw Object.assign(new Error('Connection superseded during session setup'), { code: PROVIDER_ERROR_CODES.CONNECTION_LOST });
      }
    };

    assertOwned();
    const needsNativeBind = state.boundConnectionGeneration !== targetConnGen || !state.providerSessionId;

    if (!needsNativeBind && !state.pendingModel) {
      return;
    }

    if (needsNativeBind) {
      // Reset per-connection session negotiation before binding on this connection.
      state.sessionUsesConfigOptions = false;
      state.modelConfigId = null;

      let response: NewSessionResponse | LoadSessionResponse | null = null;
      let boundId = '';

      if (state.providerSessionId) {
        const candidateId = state.providerSessionId;
        if (this.connCaps.sessionResumeSupported && typeof connection.resumeSession === 'function') {
          this.bindNativeSession(candidateId, state);
          try {
            const outcome = await withTimeoutOutcome(
              connection.resumeSession({ sessionId: candidateId, cwd: state.cwd, mcpServers: state.mcpServers }),
              this.sessionTimeoutMs,
            );
            assertOwned();
            if (outcome.timedOut) throw new Error(`kimi acp resumeSession timed out after ${this.sessionTimeoutMs}ms`);
            response = outcome.value;
            boundId = candidateId;
          } catch (err) {
            assertOwned();
            if (!allowFresh || !isSessionNotFoundError(err)) {
              throw this.normalizeProviderException(err);
            }
          }
        } else if (this.connCaps.loadSessionSupported && typeof connection.loadSession === 'function') {
          this.bindNativeSession(candidateId, state);
          state.replaying = true;
          try {
            const outcome = await withTimeoutOutcome(
              connection.loadSession({ sessionId: candidateId, cwd: state.cwd, mcpServers: state.mcpServers }),
              this.sessionTimeoutMs,
            );
            assertOwned();
            if (outcome.timedOut) throw new Error(`kimi acp loadSession timed out after ${this.sessionTimeoutMs}ms`);
            response = (outcome.value as LoadSessionResponse | undefined) ?? null;
            boundId = candidateId;
          } catch (err) {
            assertOwned();
            if (!allowFresh || !isSessionNotFoundError(err)) {
              throw this.normalizeProviderException(err);
            }
          } finally {
            state.replaying = false;
          }
        } else if (!allowFresh) {
          const missingErr = new Error(`Cannot restore session ${candidateId}: agent lacks resumeSession and loadSession capabilities`);
          throw Object.assign(missingErr, { code: PROVIDER_ERROR_CODES.SESSION_NOT_FOUND });
        }
      }

      if (!boundId) {
        if (!allowFresh) {
          const missingErr = new Error('Session not found on provider');
          throw Object.assign(missingErr, { code: PROVIDER_ERROR_CODES.SESSION_NOT_FOUND });
        }
        try {
          const outcome = await withTimeoutOutcome(
            connection.newSession({ cwd: state.cwd, mcpServers: state.mcpServers }),
            this.sessionTimeoutMs,
          );
          if (this.lifecycleEpoch !== epoch || this.sessions.get(state.sessionKey) !== state || this.connection !== connection || this.connectionGeneration !== targetConnGen) {
            if (!outcome.timedOut && outcome.value?.sessionId && typeof connection.closeSession === 'function') {
              void connection.closeSession({ sessionId: outcome.value.sessionId }).catch(() => {});
            }
            assertOwned();
          }
          if (outcome.timedOut) {
            throw new Error(`kimi acp newSession timed out after ${this.sessionTimeoutMs}ms`);
          }
          const created = outcome.value;
          boundId = created.sessionId;
          response = created;
          this.bindNativeSession(boundId, state);
        } catch (err) {
          throw this.normalizeProviderException(err);
        }
      }

      assertOwned();
      state.boundConnectionGeneration = targetConnGen;
      if (state.compactionTrackerGeneration !== targetConnGen) {
        this.resetSessionCompactionTracking(state, targetConnGen);
      }

      const catalog = this.cacheModelsFromResponse(response, state);
      const desiredModel = state.pendingModel ?? state.model;
      if (state.model !== catalog.defaultModel) {
        state.lastContextWindow = undefined;
      }
      state.model = catalog.defaultModel;
      state.pendingModel = desiredModel && (!catalog.defaultModel || desiredModel !== catalog.defaultModel)
        ? desiredModel
        : undefined;

      const modes = asRecord(asRecord(response)?.modes);
      if (isNonEmptyString(modes?.currentModeId)) {
        state.mode = modes.currentModeId;
      }

      if (state.providerSessionId && state.providerSessionId !== state.reportedResumeId) {
        state.reportedResumeId = state.providerSessionId;
        this.emitSessionInfo(state.sessionKey, {
          resumeId: state.providerSessionId,
          ...(state.model ? { model: state.model } : {}),
        });
      }
    }

    if (state.pendingModel) {
      const requested = state.pendingModel;
      try {
        await this.switchProviderModel(connection, state, requested);
        assertOwned();
        state.model = requested;
        state.pendingModel = undefined;
        this.emitSessionInfo(state.sessionKey, { model: requested });
      } catch (err) {
        throw this.normalizeProviderException(err);
      }
    }
  }

  async createSession(config: SessionConfig): Promise<string> {
    const epoch = this.lifecycleEpoch;
    await config.beforeNativeSessionStart?.();
    if (this.lifecycleEpoch !== epoch) {
      throw new Error('Provider disconnected during session initialization');
    }

    const routeId = config.bindExistingKey ?? config.sessionKey;
    const prior = this.sessions.get(routeId);
    const existing = config.fresh ? undefined : prior;

    if (config.skipCreate && existing) {
      return routeId;
    }

    const connection = await this.ensureConnected(config);
    if (this.lifecycleEpoch !== epoch) {
      throw new Error('Provider disconnected during session initialization');
    }
    const cwd = normalizeTransportCwd(canonicalizeTransportCwd(config.cwd)) || process.cwd();
    const mcpServers = getDefaultAcpMcpServers(config);
    const systemParts = getProviderSystemTextParts({
      userMessage: '',
      assembledMessage: '',
      sessionSystemText: config.identityPrompt ?? config.systemPrompt,
      systemText: config.systemPrompt ?? config.description,
      context: {
        sessionSystemText: config.identityPrompt ?? config.systemPrompt,
        systemText: config.systemPrompt ?? config.description,
        requiredAuthoredContext: [],
        advisoryAuthoredContext: [],
        appliedDocumentVersionIds: [],
        diagnostics: [],
      },
      authority: {
        namespace: config.contextNamespace ?? { scope: 'personal', projectId: 'default' },
        authoritySource: 'none',
        freshness: 'missing',
        fallbackAllowed: true,
        retryScheduled: false,
        providerPolicyOutcome: 'allowed',
        diagnostics: [],
      },
      supportClass: 'full-normalized-context-injection',
      diagnostics: [],
    });

    // Keep local route key (bindExistingKey) strictly separate from remote ACP session id (resumeId).
    const initialResumeId = config.fresh
      ? undefined
      : (isNonEmptyString(config.resumeId) ? config.resumeId.trim() : existing?.providerSessionId || undefined);

    const requestedModel = isNonEmptyString(config.model)
      ? config.model.trim()
      : isNonEmptyString(config.agentId)
        ? config.agentId.trim()
        : existing?.model;

    const state: KimiSessionState = {
      sessionKey: routeId,
      providerSessionId: initialResumeId ?? '',
      reportedResumeId: undefined,
      boundConnectionGeneration: 0,
      cwd,
      model: undefined,
      pendingModel: requestedModel,
      mode: 'default',
      lastContextWindow: undefined,
      sessionUsesConfigOptions: false,
      modelConfigId: null,
      systemText: systemParts.sessionSystemText,
      systemTextInjected: Boolean(config.startupMemoryAlreadyInjected ?? existing?.systemTextInjected),
      lastInjectedSessionSystemKey: config.startupMemoryAlreadyInjected
        ? sessionSystemContractKey(systemParts.sessionSystemText)
        : existing?.lastInjectedSessionSystemKey,
      replaying: false,
      promptInFlight: false,
      turnGeneration: existing?.turnGeneration ?? 0,
      pendingTurn: null,
      lastStopTurn: null,
      lastStatusSignature: null,
      compactionTrackerGeneration: 0,
      activeCompactionIds: new Set(),
      terminalCompactionIds: new Set(),
      activeTools: new Map(),
      pendingApprovals: new Map(),
      mcpServers,
      env: config.env ?? existing?.env,
    };
    this.sessions.set(routeId, state);

    try {
      await this.ensureSessionReady(state, connection, { allowFresh: true });
    } catch (err) {
      if (!prior && !state.providerSessionId) {
        this.sessions.delete(routeId);
      }
      throw err;
    }

    return routeId;
  }

  async restoreSession(sessionId: string): Promise<boolean> {
    const state = this.resolveState(sessionId);
    if (!state) return false;
    try {
      const connection = await this.ensureConnected({
        sessionKey: state.sessionKey,
        cwd: state.cwd,
        env: state.env,
      });
      await this.ensureSessionReady(state, connection, { allowFresh: false });
      return true;
    } catch (err) {
      if (isSessionNotFoundError(err)) return false;
      throw this.normalizeProviderException(err);
    }
  }

  async listSessions(options: RemoteSessionListOptions = {}): Promise<RemoteSessionInfo[]> {
    try {
      await this.ensureConnected();
    } catch {
      return [];
    }
    const directoryRequested = options.directory !== undefined;
    const queryDirectory = normalizeTransportCwd(options.directory);
    const expectedDirectory = canonicalizeTransportCwd(options.directory);
    if (
      (directoryRequested && (!queryDirectory || !expectedDirectory))
      || !this.connection
      || !this.connCaps.sessionListSupported
      || typeof this.connection.listSessions !== 'function'
    ) {
      return [];
    }

    const sessions: RemoteSessionInfo[] = [];
    const seenCursors = new Set<string>();
    let cursor: string | undefined;
    do {
      const outcome = await withTimeoutOutcome(
        this.connection.listSessions({
          ...(queryDirectory ? { cwd: queryDirectory } : {}),
          ...(cursor ? { cursor } : {}),
        }),
        this.sessionTimeoutMs,
      );
      if (outcome.timedOut) {
        throw new Error(`kimi acp listSessions timed out after ${this.sessionTimeoutMs}ms`);
      }
      const result = outcome.value;
      for (const entry of result.sessions ?? []) {
        const directory = canonicalizeTransportCwd(entry.cwd);
        if (!directory || (expectedDirectory && directory !== expectedDirectory)) continue;
        const updatedAt = entry.updatedAt ? Date.parse(entry.updatedAt) : Number.NaN;
        sessions.push({
          key: entry.sessionId,
          ...(entry.title ? { displayName: entry.title } : {}),
          directory: entry.cwd.trim(),
          ...(Number.isFinite(updatedAt) ? { updatedAt } : {}),
        });
      }
      const nextCursor = typeof result.nextCursor === 'string' && result.nextCursor
        ? result.nextCursor
        : undefined;
      if (!nextCursor || seenCursors.has(nextCursor)) break;
      seenCursors.add(nextCursor);
      cursor = nextCursor;
    } while (cursor);

    return sessions;
  }

  async detachSession(sessionId: string): Promise<void> {
    const state = this.resolveState(sessionId);
    if (!state) return;
    this.unbindSession(state.sessionKey);
    if (state.pendingTurn) {
      this.rejectPendingApprovals(state, new Error('Session detached'));
      this.failTurn(state, state.pendingTurn, new Error('Session detached'), PROVIDER_ERROR_CODES.CANCELLED, true);
    }
    this.resetSessionCompactionTracking(state);
    this.clearStatus(state.sessionKey, state);
  }

  async endSession(sessionId: string): Promise<void> {
    const state = this.resolveState(sessionId);
    if (!state) return;
    this.unbindSession(state.sessionKey);

    this.rejectPendingApprovals(state, new Error('Session ended'));
    if (state.pendingTurn) {
      this.failTurn(state, state.pendingTurn, new Error('Session ended'), PROVIDER_ERROR_CODES.CANCELLED, true);
    }
    this.resetSessionCompactionTracking(state);
    this.clearStatus(state.sessionKey, state);

    const stillOwnedElsewhere = Boolean(state.providerSessionId && this.acpToRoute.has(state.providerSessionId));
    if (!stillOwnedElsewhere && state.providerSessionId && this.connCaps.sessionCloseSupported && this.connection?.closeSession && this.isChildAlive()) {
      await withTimeoutOutcome(
        this.connection.closeSession({ sessionId: state.providerSessionId }),
        this.closeTimeoutMs,
      ).catch(() => {});
    }

    if (this.sessions.size === 0) {
      await this.teardownChildProcess();
    }
  }

  setSessionAgentId(sessionId: string, agentId: string): void {
    const state = this.resolveState(sessionId);
    if (!state) return;
    state.pendingModel = agentId;
    if (!state.promptInFlight && (!this.connection || !this.isChildAlive())) {
      state.model = agentId;
    }
  }

  /** Clear injected system-text tracking after compaction or identity changes. */
  refreshSessionSystemText(sessionId: string): void {
    const state = this.resolveState(sessionId);
    if (!state) return;
    state.lastInjectedSessionSystemKey = undefined;
    state.systemTextInjected = false;
  }

  async applySessionModel(sessionId: string, agentId: string): Promise<SessionModelApplied> {
    const state = this.resolveState(sessionId);
    if (!state) {
      throw new Error(`Unknown session: ${sessionId}`);
    }
    if (!this.connection || !this.isChildAlive() || state.boundConnectionGeneration !== this.connectionGeneration) {
      state.pendingModel = agentId;
      return SESSION_MODEL_APPLIED.NEXT_START;
    }

    await this.switchProviderModel(this.connection, state, agentId);
    if (state.model !== agentId) {
      state.lastContextWindow = undefined;
    }
    state.model = agentId;
    state.pendingModel = undefined;
    this.emitSessionInfo(state.sessionKey, { model: agentId });
    return state.promptInFlight ? SESSION_MODEL_APPLIED.NEXT_START : SESSION_MODEL_APPLIED.LIVE;
  }

  async listModels(force = false): Promise<ProviderModelList> {
    const now = Date.now();
    if (!force && this.cachedModels && now - this.cachedModelsAt < this.modelProbeTtlMs) {
      return this.cachedModels;
    }

    const anySession = this.sessions.values().next().value as KimiSessionState | undefined;
    if (!force && anySession && this.cachedModels?.models.length) {
      return this.cachedModels;
    }

    try {
      const connection = await this.ensureConnected();
      const probe = await withTimeoutOutcome(
        connection.newSession({ cwd: process.cwd(), mcpServers: [] }),
        this.sessionTimeoutMs,
      );
      if (probe.timedOut) {
        return { models: [], isAuthenticated: false, error: 'Model discovery timed out' };
      }
      const catalog = this.cacheModelsFromResponse(probe.value);
      if (this.connCaps.sessionCloseSupported && probe.value.sessionId && connection.closeSession) {
        void withTimeoutOutcome(
          connection.closeSession({ sessionId: probe.value.sessionId }),
          this.closeTimeoutMs,
        ).catch(() => {});
      }
      return {
        models: catalog.models,
        defaultModel: catalog.defaultModel,
        isAuthenticated: true,
        modelCatalogSource: 'live',
      };
    } catch (err) {
      if (this.sessions.size === 0) {
        await this.teardownChildProcess();
      }
      const normalized = this.normalizeProviderException(err);
      return {
        models: [],
        isAuthenticated: false,
        error: normalized.message,
      };
    }
  }

  /**
   * Send-start admission boundary: ensures connection and session readiness,
   * invokes ACP `session/prompt`, then resolves once `prompt` is submitted while
   * tracking the native prompt completion asynchronously.
   */
  async send(
    sessionId: string,
    payload: string | ProviderContextPayload,
    attachments?: TransportAttachment[],
    extraSystemPrompt?: string,
  ): Promise<void> {
    const state = this.resolveState(sessionId);
    if (!state) {
      throw new Error(`Unknown session: ${sessionId}`);
    }
    if (state.promptInFlight) {
      throw new Error(`Session ${sessionId} already has an in-flight turn`);
    }

    const normalized = normalizeProviderPayload(payload, attachments, extraSystemPrompt);
    const isCompact = typeof normalized.userMessage === 'string'
      && isSessionControlCommandText(normalized.userMessage, 'compact');
    const generation = ++state.turnGeneration;
    let resolvePhysicalTerminal!: () => void;
    const physicalTerminal = new Promise<void>((resolve) => {
      resolvePhysicalTerminal = resolve;
    });

    const turn: PendingTurn = {
      generation,
      messageId: `kimi-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      accumulated: '',
      assistantTextClosed: false,
      cancelled: false,
      isCompact,
      cancelGraceTimer: null,
      terminalTarget: {},
      physicalTerminal,
      resolvePhysicalTerminal,
      settled: false,
      wireSlot: this.reserveWireSlot(),
    };

    state.promptInFlight = true;
    state.pendingTurn = turn;
    state.lastStopTurn = turn;
    state.lastStatusSignature = null;
    if (isCompact) {
      this.emitStatus(state.sessionKey, state, { status: 'compacting', label: 'Compacting conversation...' });
    }

    try {
      const connection = await this.ensureConnected({
        sessionKey: state.sessionKey,
        cwd: state.cwd,
        env: state.env,
      });
      if (turn.cancelled || state.turnGeneration !== generation || this.sessions.get(state.sessionKey) !== state) {
        throw Object.assign(new Error('Turn cancelled before prompt submission'), { code: PROVIDER_ERROR_CODES.CANCELLED });
      }

      await this.ensureSessionReady(state, connection, { allowFresh: true });
      if (turn.cancelled || state.turnGeneration !== generation || this.sessions.get(state.sessionKey) !== state) {
        throw Object.assign(new Error('Turn cancelled before prompt submission'), { code: PROVIDER_ERROR_CODES.CANCELLED });
      }

      const contentBlocks = this.prepareTurnPromptBlocks(state, normalized, attachments, isCompact);
      const capturedChild = this.child;
      if (!capturedChild) {
        throw new Error('kimi acp child process unavailable at prompt boundary');
      }

      const boundGeneration = this.connectionGeneration;
      const promptRpc = connection.prompt({
        sessionId: state.providerSessionId,
        prompt: contentBlocks,
      });

      // Only captured child exit or native ACP prompt response/RequestError counts as physical stop proof.
      const onCapturedExit = () => {
        capturedChild.removeListener('exit', onCapturedExit);
        capturedChild.removeListener('close', onCapturedExit);
        turn.resolvePhysicalTerminal();
      };
      capturedChild.once('exit', onCapturedExit);
      capturedChild.once('close', onCapturedExit);

      void this.trackPromptSettlement(promptRpc, capturedChild, boundGeneration, onCapturedExit, state, turn);
    } catch (err) {
      const normalizedErr = this.normalizeProviderException(err);
      const code = (normalizedErr as { code?: string }).code ?? inferErrorCode(err);
      this.failTurn(state, turn, normalizedErr, code, code === PROVIDER_ERROR_CODES.CANCELLED);
      turn.resolvePhysicalTerminal();
      throw normalizedErr;
    }
  }

  private prepareTurnPromptBlocks(
    state: KimiSessionState,
    normalized: ProviderContextPayload,
    attachments?: TransportAttachment[],
    isCompact = typeof normalized.userMessage === 'string' && isSessionControlCommandText(normalized.userMessage, 'compact'),
  ): ContentBlock[] {
    let promptText: string;
    if (isCompact) {
      promptText = '/compact';
    } else {
      const systemParts = getProviderSystemTextParts(normalized);
      const injectSessionSystem = shouldInjectSessionSystemContract(
        state.lastInjectedSessionSystemKey,
        systemParts.sessionSystemText,
      ) || !state.systemTextInjected;
      promptText = composeMessageSideProviderPrompt(normalized, {
        includeSessionSystemText: injectSessionSystem,
        labelContextInstructions: true,
      });
      if (injectSessionSystem && systemParts.sessionSystemText) {
        state.lastInjectedSessionSystemKey = sessionSystemContractKey(systemParts.sessionSystemText);
        state.systemTextInjected = true;
      }
    }

    return this.buildPromptContentBlocks(
      promptText,
      normalized.attachments ?? attachments,
    );
  }

  private buildPromptContentBlocks(
    text: string,
    attachments?: TransportAttachment[],
  ): ContentBlock[] {
    const blocks: ContentBlock[] = [{ type: 'text', text }];
    if (!attachments?.length) return blocks;

    for (const att of attachments) {
      if (!att.daemonPath) continue;
      const mime = att.mime ?? inferImageMime(att.daemonPath) ?? undefined;
      const isImage = att.type === 'image' || Boolean(mime && mime.startsWith('image/'));
      if (isImage && this.connCaps.promptImageSupported) {
        try {
          const st = statSync(att.daemonPath);
          if (st.isFile() && st.size > 0 && st.size <= MAX_INLINE_IMAGE_BYTES) {
            const data = readFileSync(att.daemonPath).toString('base64');
            blocks.push({
              type: 'image',
              data,
              mimeType: mime ?? 'image/png',
            });
            continue;
          }
        } catch {
          /* fall through to resource_link */
        }
      }
      blocks.push({
        type: 'resource_link',
        name: att.originalName || path.basename(att.daemonPath),
        uri: pathToFileURL(att.daemonPath).href,
        ...(mime ? { mimeType: mime } : {}),
        ...(typeof att.size === 'number' ? { size: att.size } : {}),
      });
    }
    return blocks;
  }

  private async trackPromptSettlement(
    promptRpc: Promise<PromptResponse>,
    capturedChild: ChildProcess,
    capturedGeneration: number,
    onCapturedExit: () => void,
    state: KimiSessionState,
    turn: PendingTurn,
  ): Promise<void> {
    let providerResponded = false;
    try {
      const response = await promptRpc;
      providerResponded = true;
      await turn.wireSlot;
      if (turn.settled || state.turnGeneration !== turn.generation) return;
      const stopReason: StopReason | undefined = response?.stopReason;
      if (stopReason === 'cancelled' || turn.cancelled) {
        this.failTurn(state, turn, new Error('Turn cancelled'), PROVIDER_ERROR_CODES.CANCELLED, true);
        return;
      }
      if (stopReason === 'refusal') {
        this.failTurn(state, turn, new Error('Kimi ACP refused the request'), PROVIDER_ERROR_CODES.PROVIDER_ERROR, false);
        return;
      }
      if (turn.isCompact && !turn.compactedInTurn && (turn.sawCompactionEvent || stopReason !== 'end_turn')) {
        const reasonMsg = stopReason && stopReason !== 'end_turn'
          ? `Kimi ACP compaction stopped without committing (${stopReason})`
          : 'Kimi ACP compaction did not commit';
        this.failTurn(state, turn, new Error(reasonMsg), PROVIDER_ERROR_CODES.PROVIDER_ERROR, true);
        return;
      }
      // Never merge cumulative PromptResponse.usage.inputTokens into current-context occupancy.
      // Only use session `usage_update` or an explicit Kimi `_meta` occupancy/window snapshot.
      const metaRec = asRecord(response?._meta);
      const metaContextUsage = extractMetaContextUsage(metaRec, state.lastContextWindow);
      const metaWindowOnly = !metaContextUsage ? extractMetaContextWindow(metaRec) : undefined;
      const resolvedMetaWindow = metaContextUsage?.model_context_window ?? metaWindowOnly;
      if (resolvedMetaWindow !== undefined) {
        state.lastContextWindow = resolvedMetaWindow;
      }
      if (metaContextUsage) {
        turn.turnContextUsage = metaContextUsage;
        this.emitUsage(state.sessionKey, {
          messageId: turn.messageId,
          finalized: true,
          model: state.model,
          usage: metaContextUsage,
        });
      } else if (metaWindowOnly !== undefined && turn.turnContextUsage) {
        const patchedUsage: ProviderUsageUpdate['usage'] = {
          ...turn.turnContextUsage,
          model_context_window: metaWindowOnly,
        };
        turn.turnContextUsage = patchedUsage;
        this.emitUsage(state.sessionKey, {
          messageId: turn.messageId,
          finalized: true,
          model: state.model,
          usage: patchedUsage,
        });
      }
      const cumulativeUsage = extractCumulativePromptUsage(response);
      this.settleTurn(state, turn, cumulativeUsage, stopReason);
    } catch (err) {
      if (err instanceof RequestError) {
        providerResponded = true;
      }
      await turn.wireSlot;
      if (!providerResponded) {
        this.reclaimDeadAcpTransport(capturedChild, capturedGeneration, state, err);
      }
      if (turn.settled || state.turnGeneration !== turn.generation) return;
      const normalized = this.normalizeProviderException(err);
      const code = turn.cancelled ? PROVIDER_ERROR_CODES.CANCELLED : (normalized as { code?: string }).code ?? inferErrorCode(err);
      this.failTurn(state, turn, normalized, code, code === PROVIDER_ERROR_CODES.CANCELLED);
    } finally {
      const childExited = capturedChild.exitCode !== null || capturedChild.signalCode !== null;
      if (providerResponded || childExited) {
        capturedChild.removeListener('exit', onCapturedExit);
        capturedChild.removeListener('close', onCapturedExit);
        turn.resolvePhysicalTerminal();
      }
    }
  }

  /**
   * When the ACP stream/pipe fails while the OS child process is still alive:
   * 1) Invalidate the broken connection so future sends never reuse it.
   * 2) Fail sibling turns sharing that dead connection.
   * 3) Trigger bounded physical reclaim (`killProcessTree`) without clearing
   *    physical stop proof until the captured child actually exits.
   */
  private reclaimDeadAcpTransport(
    brokenChild: ChildProcess,
    brokenGeneration: number,
    originState: KimiSessionState,
    cause: unknown,
  ): void {
    const childStillAlive = brokenChild.exitCode === null && brokenChild.signalCode === null;
    if (this.child === brokenChild && this.connectionGeneration === brokenGeneration) {
      this.connectionGeneration++;
      this.child = null;
      this.connection = null;
      this.connectingState = null;
      this.connectedFingerprint = null;
      this.connectedEnvKey = null;
      this.connCaps = defaultConnectionCapabilities();
    }

    const msg = cause instanceof Error ? cause.message : 'ACP transport stream closed';
    for (const session of this.sessions.values()) {
      if (session.boundConnectionGeneration !== brokenGeneration) continue;
      this.rejectPendingApprovals(session, new Error(msg));
      if (session === originState) continue;
      if (session.pendingTurn && !session.pendingTurn.settled) {
        this.failTurn(session, session.pendingTurn, new Error(msg), PROVIDER_ERROR_CODES.CONNECTION_LOST, true);
      } else {
        this.clearStatus(session.sessionKey, session);
      }
      this.resetSessionCompactionTracking(session);
    }

    if (childStillAlive) {
      void withTimeoutOutcome(
        killProcessTree(brokenChild, { ownsProcessGroup: true }),
        this.closeTimeoutMs,
      ).catch(() => {});
    }
  }

  private settleTurn(
    state: KimiSessionState,
    turn: PendingTurn,
    cumulativeUsage?: Record<string, number>,
    stopReason?: StopReason,
  ): void {
    if (turn.settled) return;
    turn.settled = true;
    this.clearTurnTimersAndState(state, turn);
    this.clearActiveTools(state);
    this.retireActiveCompactionsForTurn(state);
    const didCompact = Boolean(turn.compactedInTurn || (turn.isCompact && !turn.sawCompactionEvent && stopReason === 'end_turn'));
    if (didCompact) {
      this.refreshSessionSystemText(state.sessionKey);
      const outcomeToEmit = !turn.compactionOutcomeEmitted ? 'committed' : undefined;
      if (outcomeToEmit) turn.compactionOutcomeEmitted = true;
      this.clearStatus(state.sessionKey, state, outcomeToEmit);
    } else if (turn.sawCompactionEvent && !turn.compactionOutcomeEmitted) {
      turn.compactionOutcomeEmitted = true;
      this.clearStatus(state.sessionKey, state, 'failed');
    } else {
      this.clearStatus(state.sessionKey, state);
    }
    const metadata: Record<string, unknown> = {
      ...(state.model ? { model: state.model } : {}),
      ...(stopReason === 'max_tokens' || stopReason === 'max_turn_requests' ? { stopReason } : {}),
      ...(turn.turnContextUsage ? { usage: turn.turnContextUsage } : {}),
      ...(cumulativeUsage ? { cumulativeUsage } : {}),
      ...(didCompact ? { compacted: true } : {}),
    };
    this.emitComplete(state.sessionKey, {
      id: turn.messageId,
      sessionId: state.sessionKey,
      kind: 'text',
      role: 'assistant',
      content: turn.accumulated,
      timestamp: Date.now(),
      status: 'complete',
      ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
    });
  }

  private failTurn(state: KimiSessionState, turn: PendingTurn, err: Error, code: string, recoverable: boolean): void {
    if (turn.settled) return;
    turn.settled = true;
    this.rejectPendingApprovals(state, err);
    this.clearTurnTimersAndState(state, turn);
    this.clearActiveTools(state);
    this.retireActiveCompactionsForTurn(state);
    const outcomeToEmit = turn.compactedInTurn && !turn.compactionOutcomeEmitted
      ? 'committed'
      : (!turn.compactedInTurn && !turn.compactionOutcomeEmitted && turn.isCompact ? 'failed' : undefined);
    if (outcomeToEmit) {
      turn.compactionOutcomeEmitted = true;
    }
    this.clearStatus(state.sessionKey, state, outcomeToEmit);
    this.lastErrorCode = code;
    this.emitError(state.sessionKey, {
      code,
      message: err.message,
      recoverable,
    });
  }

  private clearTurnTimersAndState(state: KimiSessionState, turn: PendingTurn): void {
    if (turn.cancelGraceTimer) {
      clearTimeout(turn.cancelGraceTimer);
      turn.cancelGraceTimer = null;
    }
    if (state.pendingTurn === turn) {
      state.pendingTurn = null;
      state.promptInFlight = false;
    }
  }

  private clearActiveTools(state: KimiSessionState): void {
    if (state.activeTools.size === 0) return;
    for (const tool of state.activeTools.values()) {
      if (tool.status === 'running') {
        this.emitToolCall(state.sessionKey, {
          id: tool.id,
          name: tool.name,
          status: 'complete',
          input: tool.input,
        });
      }
    }
    state.activeTools.clear();
  }

  private emitStatus(sessionId: string, state: KimiSessionState, status: ProviderStatusUpdate): void {
    const sig = `${status.status ?? ''}\0${status.label ?? ''}\0${status.compactionOutcome ?? ''}`;
    if (state.lastStatusSignature === sig) return;
    state.lastStatusSignature = sig;
    for (const cb of this.statusHandlers) cb(sessionId, status);
  }

  private clearStatus(
    sessionId: string,
    state: KimiSessionState,
    compactionOutcome?: 'committed' | 'failed',
  ): void {
    if (state.lastStatusSignature === null && !compactionOutcome) return;
    state.lastStatusSignature = null;
    for (const cb of this.statusHandlers) {
      cb(sessionId, {
        status: null,
        label: null,
        ...(compactionOutcome ? { compactionOutcome } : {}),
      });
    }
  }

  async cancel(sessionId: string, options?: ProviderCancelOptions): Promise<void> {
    const state = this.resolveState(sessionId);
    if (!state) return;
    this.rejectPendingApprovals(state, new Error('Session cancelled'));
    const turn = state.pendingTurn;
    if (!turn || !state.promptInFlight) {
      this.clearActiveTools(state);
      this.clearStatus(state.sessionKey, state);
      return;
    }

    turn.cancelled = true;
    const generation = turn.generation;
    const isStaleWatchdog = options?.origin === PROVIDER_CANCEL_ORIGINS.STALE_WATCHDOG;

    if (!turn.cancelGraceTimer) {
      turn.cancelGraceTimer = setTimeout(() => {
        void this.handleCancelGraceExpired(state, turn, generation);
      }, isStaleWatchdog ? Math.min(2_000, this.cancelGraceMs) : this.cancelGraceMs);
      turn.cancelGraceTimer.unref?.();
    }

    if (this.connection && this.isChildAlive() && state.providerSessionId) {
      try {
        await Promise.race([
          this.connection.cancel({ sessionId: state.providerSessionId }),
          new Promise<void>((resolve) => {
            const t = setTimeout(resolve, Math.min(2_000, this.cancelGraceMs));
            t.unref?.();
          }),
        ]);
      } catch {
        /* ignore cancel RPC failure if child already exited */
      }
    }
  }

  private async handleCancelGraceExpired(
    state: KimiSessionState,
    turn: PendingTurn,
    generation: number,
  ): Promise<void> {
    if (this.sessions.get(state.sessionKey) !== state) return;
    if (!state.promptInFlight || state.turnGeneration !== generation || state.pendingTurn !== turn) return;

    this.failTurn(
      state,
      turn,
      new Error('kimi acp turn cancelled after cancel grace window'),
      PROVIDER_ERROR_CODES.CANCELLED,
      true,
    );
    // Physically recycle the wedged process rather than faking a terminal for confirmPromiseStop.
    await this.teardownChildProcess();
  }

  /**
   * Direct return of `confirmPromiseStop` so `onConfirmedProviderStop` keys on the
   * exact returned Promise object for late proof-backed queue release.
   */
  cancelAndWait(sessionId: string): Promise<void> {
    const state = this.resolveState(sessionId);
    const turn = state ? (state.pendingTurn ?? state.lastStopTurn) : null;
    if (!state || !turn) {
      return Promise.reject(new Error('ACP prompt terminal unavailable'));
    }
    const generation = turn.generation;
    const isCurrent = () =>
      this.sessions.get(state.sessionKey) === state
      && state.turnGeneration === generation;

    return confirmPromiseStop(
      turn.terminalTarget,
      turn.physicalTerminal,
      () => {
        if (!isCurrent()) return Promise.reject(new Error('ACP session owner changed during Stop'));
        return this.cancel(sessionId);
      },
      isCurrent,
    );
  }

  private handleSessionUpdate(notification: SessionNotification): void {
    const routeId = this.acpToRoute.get(notification.sessionId);
    const state = routeId ? this.sessions.get(routeId) : undefined;
    if (!state) return;
    if (state.replaying) return;

    const update: SessionUpdate = notification.update;
    const u = asRecord(update);
    if (!u || !isNonEmptyString(u.sessionUpdate)) return;

    switch (u.sessionUpdate) {
      case 'agent_message_chunk': {
        const text = extractTextFromContent(u.content);
        if (!text) break;
        const turn = state.pendingTurn;
        if (turn) {
          if (turn.assistantTextClosed) {
            turn.messageId = `kimi-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
            turn.accumulated = '';
            turn.assistantTextClosed = false;
          }
          turn.accumulated += text;
        }
        const messageId = turn?.messageId ?? `kimi-stream-${state.providerSessionId}`;
        this.emitDelta(state.sessionKey, {
          messageId,
          type: 'text',
          delta: text,
          role: 'assistant',
        });
        break;
      }

      case 'agent_thought_chunk': {
        if (state.promptInFlight && !state.pendingTurn?.cancelled && state.lastStatusSignature?.startsWith('compacting\0') !== true) {
          this.emitStatus(state.sessionKey, state, { status: 'thinking', label: 'Thinking...' });
        }
        break;
      }

      case 'compaction_summary_chunk':
      case 'compaction_update': {
        this.handleCompactionSessionUpdate(state, u, u.sessionUpdate);
        break;
      }

      case 'tool_call': {
        const tc = update as ToolCall & { sessionUpdate: 'tool_call' };
        if (state.pendingTurn && state.pendingTurn.accumulated.length > 0) {
          state.pendingTurn.assistantTextClosed = true;
        }
        const status = mapToolCallStatus(tc.status);
        const toolName = tc.title || tc.kind || 'tool';
        if (status === 'running') {
          state.activeTools.set(tc.toolCallId, {
            id: tc.toolCallId,
            name: toolName,
            kind: tc.kind,
            input: tc.rawInput,
            status,
          });
        } else {
          state.activeTools.delete(tc.toolCallId);
        }
        this.emitToolCall(state.sessionKey, {
          id: tc.toolCallId,
          name: toolName,
          status,
          input: tc.rawInput,
          output: extractToolOutputText(tc.content, tc.rawOutput),
          detail: {
            kind: tc.kind,
            input: tc.rawInput,
            output: tc.rawOutput,
          },
        });
        break;
      }

      case 'tool_call_update': {
        const tu = update as ToolCallUpdate & { sessionUpdate: 'tool_call_update' };
        const prev = state.activeTools.get(tu.toolCallId);
        const status = mapToolCallStatus(tu.status ?? (prev ? prev.status : 'in_progress'));
        const name = tu.title || prev?.name || tu.kind || 'tool';
        const input = tu.rawInput ?? prev?.input;
        if (status === 'running') {
          state.activeTools.set(tu.toolCallId, {
            id: tu.toolCallId,
            name,
            kind: tu.kind ?? prev?.kind,
            input,
            status,
          });
        } else {
          state.activeTools.delete(tu.toolCallId);
        }
        this.emitToolCall(state.sessionKey, {
          id: tu.toolCallId,
          name,
          status,
          input,
          output: extractToolOutputText(tu.content, tu.rawOutput),
          detail: {
            kind: tu.kind ?? prev?.kind,
            input,
            output: tu.rawOutput,
          },
        });
        break;
      }

      case 'plan': {
        if (!Array.isArray(u.entries)) break;
        const planInput = acpPlanEntriesToInput(u.entries as Parameters<typeof acpPlanEntriesToInput>[0]);
        this.emitToolCall(state.sessionKey, {
          id: `plan-${state.providerSessionId}`,
          name: 'plan',
          status: 'complete',
          input: planInput,
          detail: { kind: 'plan', input: planInput },
        });
        break;
      }

      case 'current_mode_update': {
        if (isNonEmptyString(u.currentModeId)) {
          state.mode = u.currentModeId;
        }
        break;
      }

      case 'config_option_update': {
        const catalog = this.cacheModelsFromResponse({ configOptions: u.configOptions }, state);
        if (catalog.defaultModel && catalog.defaultModel !== state.model) {
          state.lastContextWindow = undefined;
          state.model = catalog.defaultModel;
          this.emitSessionInfo(state.sessionKey, { model: catalog.defaultModel });
        }
        break;
      }

      case 'usage_update': {
        const updateWindow = extractMetaContextWindow(u);
        if (updateWindow !== undefined) {
          state.lastContextWindow = updateWindow;
        }
        const usagePayload = normalizeKimiContextUsageSnapshot(u, state.lastContextWindow);
        const effectiveWindow = updateWindow ?? state.lastContextWindow;

        if (usagePayload) {
          if (state.pendingTurn) {
            state.pendingTurn.turnContextUsage = usagePayload;
          }
          this.emitUsage(state.sessionKey, {
            messageId: state.pendingTurn?.messageId,
            model: state.model,
            usage: usagePayload,
          });
        } else if (effectiveWindow !== undefined && state.pendingTurn?.turnContextUsage) {
          const patchedUsage: NonNullable<ProviderUsageUpdate['usage']> = {
            ...state.pendingTurn.turnContextUsage,
            model_context_window: effectiveWindow,
          };
          state.pendingTurn.turnContextUsage = patchedUsage;
          this.emitUsage(state.sessionKey, {
            messageId: state.pendingTurn.messageId,
            model: state.model,
            usage: patchedUsage,
          });
        }
        break;
      }

      default:
        break;
    }
  }

  private handleCompactionSessionUpdate(
    state: KimiSessionState,
    u: JsonRecord,
    kind: 'compaction_summary_chunk' | 'compaction_update',
  ): void {
    const turn = state.pendingTurn;
    if (
      !turn
      || !state.promptInFlight
      || turn.settled
      || state.boundConnectionGeneration !== this.connectionGeneration
    ) {
      return;
    }

    const compactionId = isNonEmptyString(u.compactionId)
      ? u.compactionId.trim()
      : `__turn_${turn.generation}_compaction__`;
    if (state.terminalCompactionIds.has(compactionId)) {
      return;
    }

    if (kind === 'compaction_summary_chunk') {
      if (turn.cancelled) return;
      turn.sawCompactionEvent = true;
      state.activeCompactionIds.add(compactionId);
      this.emitStatus(state.sessionKey, state, { status: 'compacting', label: 'Compacting conversation...' });
      return;
    }

    const rawStatus = isNonEmptyString(u.status) ? u.status.trim().toLowerCase() : 'in_progress';
    const isCompleted = rawStatus === 'completed' || rawStatus === 'complete' || rawStatus === 'done' || rawStatus === 'finished';
    const isFailed = rawStatus === 'failed' || rawStatus === 'cancelled' || rawStatus === 'canceled' || rawStatus === 'error';

    if (turn.cancelled) {
      // During cancellation: reject new compaction IDs and progress updates,
      // while accepting terminal outcomes for already-tracked active IDs.
      if ((!isCompleted && !isFailed) || !state.activeCompactionIds.has(compactionId)) {
        return;
      }
    }

    turn.sawCompactionEvent = true;
    if (isCompleted) {
      this.recordTerminalCompactionId(state, compactionId);
      this.refreshSessionSystemText(state.sessionKey);
      turn.compactedInTurn = true;
      turn.compactionOutcome = 'committed';
      if (state.activeCompactionIds.size === 0) {
        turn.compactionOutcomeEmitted = true;
        this.clearStatus(state.sessionKey, state, 'committed');
      }
      return;
    }

    if (isFailed) {
      this.recordTerminalCompactionId(state, compactionId);
      if (!turn.compactedInTurn) {
        turn.compactionOutcome = 'failed';
      }
      if (state.activeCompactionIds.size === 0) {
        const outcome = turn.compactedInTurn ? 'committed' : 'failed';
        turn.compactionOutcomeEmitted = true;
        this.clearStatus(state.sessionKey, state, outcome);
      }
      return;
    }

    state.activeCompactionIds.add(compactionId);
    this.emitStatus(state.sessionKey, state, { status: 'compacting', label: 'Compacting conversation...' });
  }

  private async handleRequestPermission(params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    const routeId = this.acpToRoute.get(params.sessionId);
    const state = routeId ? this.sessions.get(routeId) : undefined;
    if (!state) {
      return { outcome: { outcome: 'cancelled' } };
    }
    const options = params.options ?? [];

    if (this.approvalHandlers.size === 0) {
      const allowOpt = options.find((o) => o.kind === 'allow_once' || o.kind === 'allow_always') ?? options[0];
      return allowOpt
        ? { outcome: { outcome: 'selected', optionId: allowOpt.optionId } }
        : { outcome: { outcome: 'cancelled' } };
    }

    const reqId = `perm-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const toolName = params.toolCall.title || params.toolCall.kind || 'tool';
    const preview = params.toolCall.rawInput !== undefined ? JSON.stringify(params.toolCall.rawInput).slice(0, 300) : undefined;

    return new Promise<RequestPermissionResponse>((resolve, reject) => {
      state.pendingApprovals.set(reqId, { requestId: reqId, resolve, reject, options });
      const approval: ApprovalRequest = {
        id: reqId,
        description: toolName,
        tool: toolName,
        provider: this.id,
        providerToolUseId: params.toolCall.toolCallId,
        inputPreview: preview,
      };
      for (const cb of this.approvalHandlers) {
        cb(state.sessionKey, approval);
      }
    });
  }

  async respondApproval(sessionId: string, requestId: string, approved: boolean): Promise<void> {
    const state = this.resolveState(sessionId);
    if (!state) return;
    const pending = state.pendingApprovals.get(requestId);
    if (!pending) return;
    state.pendingApprovals.delete(requestId);

    const chosen = approved
      ? pending.options.find((o) => o.kind === 'allow_once') ?? pending.options.find((o) => o.kind === 'allow_always') ?? pending.options[0]
      : pending.options.find((o) => o.kind === 'reject_once') ?? pending.options.find((o) => o.kind === 'reject_always');

    if (chosen) {
      pending.resolve({ outcome: { outcome: 'selected', optionId: chosen.optionId } });
    } else {
      pending.resolve({ outcome: { outcome: 'cancelled' } });
    }
  }

  private rejectPendingApprovals(state: KimiSessionState, err: Error): void {
    for (const pending of state.pendingApprovals.values()) {
      pending.reject(err);
    }
    state.pendingApprovals.clear();
  }

  private async handleReadTextFile(params: ReadTextFileRequest): Promise<ReadTextFileResponse> {
    const raw = await readFile(params.path, 'utf8');
    if (params.line == null && params.limit == null) {
      return { content: raw };
    }
    const lines = raw.split(/\r?\n/);
    const startIdx = Math.max(0, (params.line ?? 1) - 1);
    const endIdx = params.limit != null ? startIdx + Math.max(0, params.limit) : lines.length;
    return { content: lines.slice(startIdx, endIdx).join('\n') };
  }

  private async handleWriteTextFile(params: WriteTextFileRequest): Promise<WriteTextFileResponse> {
    await writeFile(params.path, params.content, 'utf8');
    return {};
  }

  getActiveWorkSnapshot(sessionId: string): ProviderActiveWorkSnapshot | null {
    const state = this.resolveState(sessionId);
    if (!state) return null;
    const activeToolCount = state.activeTools.size;
    const activeWorkCount = (state.promptInFlight ? 1 : 0) + activeToolCount + state.pendingApprovals.size;
    const busyReasons: SessionActivityBusyReason[] = [];
    if (state.promptInFlight) busyReasons.push('runtime_dispatch');
    if (activeToolCount > 0) busyReasons.push('open_tool_call');
    if (state.pendingApprovals.size > 0) busyReasons.push('provider_wait');
    return {
      status: 'current',
      activeWorkCount,
      activeToolCount,
      busyReasons,
    };
  }

  getMemoryMcpStatus(): MemoryMcpProviderStatusView {
    if (!this.connection || !this.isChildAlive()) {
      return {
        providerId: this.id,
        status: MEMORY_MCP_STATUS.UNKNOWN,
        connected: false,
        degradedReasons: [MEMORY_MCP_PROVIDER_STATUS_REASON.PROVIDER_NOT_CONNECTED],
      };
    }
    return {
      providerId: this.id,
      status: MEMORY_MCP_STATUS.READY,
      connected: true,
    };
  }

  getSessionDiagnostics(sessionId: string): Record<string, unknown> | null {
    const state = this.resolveState(sessionId);
    if (!state) return null;
    return {
      provider: this.id,
      implementation: 'kimi-v2',
      connected: Boolean(this.connection && this.isChildAlive()),
      pid: this.child?.pid ?? null,
      providerSessionId: state.providerSessionId,
      connectionGeneration: state.boundConnectionGeneration,
      agentInfo: this.connCaps.agentInfo,
      capabilities: {
        resume: this.connCaps.sessionResumeSupported,
        list: this.connCaps.sessionListSupported,
        close: this.connCaps.sessionCloseSupported,
        loadSession: this.connCaps.loadSessionSupported,
        image: this.connCaps.promptImageSupported,
        embeddedContext: this.connCaps.promptEmbeddedContextSupported,
      },
      model: state.model ?? null,
      mode: state.mode ?? null,
      inFlightTurn: state.promptInFlight,
      activeToolCount: state.activeTools.size,
      pendingApprovalCount: state.pendingApprovals.size,
      mcpServerCount: state.mcpServers.length,
      lastErrorCode: this.lastErrorCode,
      stderrLineCount: this.stderrTail.length,
    };
  }

  private emitDelta(sessionId: string, delta: MessageDelta): void {
    for (const cb of this.deltaHandlers) cb(sessionId, delta);
  }

  private emitComplete(sessionId: string, message: AgentMessage): void {
    for (const cb of this.completeHandlers) cb(sessionId, message);
  }

  private emitError(sessionId: string, error: ProviderError): void {
    for (const cb of this.errorHandlers) cb(sessionId, error);
  }

  private emitSessionInfo(sessionId: string, info: SessionInfoUpdate): void {
    for (const cb of this.sessionInfoHandlers) cb(sessionId, info);
  }

  private emitUsage(sessionId: string, update: ProviderUsageUpdate): void {
    for (const cb of this.usageHandlers) cb(sessionId, update);
  }

  private emitToolCall(sessionId: string, tool: ToolCallEvent): void {
    for (const cb of this.toolCallHandlers) cb(sessionId, tool);
  }
}

function mapToolCallStatus(status: string | null | undefined): 'running' | 'complete' | 'error' {
  if (status === 'completed') return 'complete';
  if (status === 'failed' || status === 'error') return 'error';
  return 'running';
}
