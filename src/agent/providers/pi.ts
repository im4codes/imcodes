import { ProviderStopConfirmation, preserveProviderStopProof } from '../provider-stop-confirmation.js';
/**
 * Pi coding-agent transport.
 *
 * Pi's supported RPC mode gives IM.codes an exact process boundary: strict
 * LF-delimited JSONL, durable session ids, token streaming, tool lifecycle,
 * steering, cancellation, model selection, and settled-run notification. One
 * child is retained per IM.codes session so uploads, tools, prompt cache and
 * conversation state all remain warm across turns.
 */
import { gateChildStream } from '../../util/event-loop-backpressure.js';
import { spawn, type ChildProcess } from 'node:child_process';
import {
  agentResourceOwner,
  bindAgentProcessResource,
  type AgentProcessResource,
} from './agent-process-resource.js';
import type { SessionResourceOwner } from '../../daemon/session-resource-registry.js';
import { randomUUID } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { extname } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import type {
  ProviderCapabilities,
  ProviderConfig,
  ProviderDelegationNotification,
  ProviderError,
  ProviderModelInfo,
  ProviderModelList,
  ProviderStatusUpdate,
  ProviderUsageUpdate,
  SessionConfig,
  SessionInfoUpdate,
  TransportProvider,
} from '../transport-provider.js';
import {
  CONNECTION_MODES,
  PROVIDER_ERROR_CODES,
  SESSION_OWNERSHIP,
  normalizeProviderPayload,
} from '../transport-provider.js';
import { PendingQuestionRegistry, type InteractiveQuestionAnswerer } from '../pending-question-registry.js';
import {
  AGENT_DELEGATION_ACTIVE_NOTIFICATION_MODES,
  AGENT_DELEGATION_NOTIFICATION_RESULTS,
  type AgentDelegationNotificationResult,
} from '../../../shared/agent-delegation.js';
import type { AgentMessage, MessageDelta, ToolCallEvent } from '../../../shared/agent-message.js';
import type { TransportAttachment } from '../../../shared/transport-attachments.js';
import type { ProviderContextPayload } from '../../../shared/context-types.js';
import { INTERACTIVE_QUESTION_TOOL_NAME } from '../../../shared/codex-user-input.js';
import { parseAskQuestionAnswers, type AskQuestionItem } from '../../../shared/ask-question-normalize.js';
import {
  SESSION_CONTROL_METADATA_COMMAND_FIELD,
  isSessionControlCommandText,
} from '../../../shared/session-control-commands.js';
import {
  PI_ASSISTANT_EVENT,
  PI_MCP_CONFIG_ENV,
  PI_PROVIDER_API_KEY_ENV,
  PI_PROVIDER_CONFIG_ENV,
  PI_RPC_COMMAND,
  PI_RPC_FRAME,
  isPiRpcResponse,
  type PiLlmConfig,
  type PiRpcCommand,
  type PiRpcResponse,
} from '../../../shared/pi-agent.js';
import {
  PI_EFFORT_LEVELS,
  clampTransportEffort,
  isTransportEffortLevel,
  normalizeSupportedEffortLevels,
  type TransportEffortLevel,
} from '../../../shared/effort-levels.js';
import {
  MEMORY_MCP_PROVIDER_ID,
  MEMORY_MCP_STATUS,
  type MemoryMcpProviderStatusView,
} from '../../../shared/memory-ws.js';
import { IMCODES_MEMORY_MCP_SERVER_NAME } from '../../../shared/memory-mcp-server-name.js';
import { composeMessageSideProviderPrompt, getProviderSystemTextParts } from '../provider-context-routing.js';
import { getDefaultMcpServers } from './getDefaultMcpServers.js';
import { MCP_TOOL_CATALOG_MODES } from '../../../shared/mcp-tool-discovery.js';
import { normalizeTransportCwd, resolveExecutableForSpawn } from '../transport-paths.js';
import { killProcessTree } from '../../util/kill-process-tree.js';
import {
  buildPiRpcArgs,
  formatPiLaunchError,
  resolvePiBinary,
} from './pi/runtime.js';
import logger from '../../util/logger.js';
import { NATIVE_AGENT_ADMISSION_MODES } from '../../../shared/native-collaboration-policy.js';
import { setSessionIncognito, withSessionPrivacy } from '../../../shared/session-incognito-context.js';

const RPC_TIMEOUT_MS = 30_000;
const SHUTDOWN_GRACE_MS = 3_000;
const MODEL_CACHE_TTL_MS = 30_000;
const DEFAULT_EXTENSION_UI_TIMEOUT_MS = 5 * 60 * 1_000;
const MAX_PI_IMAGE_BYTES = 20 * 1024 * 1024;
const SUPPORTED_PI_IMAGE_MIMES = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
]);
const IMAGE_MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};

interface PiImagePayload {
  type: 'image';
  data: string;
  mimeType: string;
}

type PiQuestionOutcome =
  | { cancelled: true }
  | { cancelled: false; answer: string };

interface PiPendingQuestionMeta {
  id: string;
  method: 'select' | 'confirm' | 'input' | 'editor';
  hasHeader?: boolean;
}

interface PendingRpc {
  resolve: (response: PiRpcResponse) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface PiSessionState {
  routeId: string;
  piSessionId: string;
  sessionName?: string;
  projectName?: string;
  cwd: string;
  env?: Record<string, string>;
  requestedModel?: string;
  model?: string;
  provider?: string;
  effort?: TransportEffortLevel;
  llmConfig?: PiLlmConfig;
  child: ChildProcess | null;
  /** Owner identity for the registry lease on the spawned agent CLI. */
  resourceOwner?: SessionResourceOwner | null;
  /** Registry lease for `child`; released when the child exits or is reaped. */
  agentResource?: AgentProcessResource;
  decoder: StringDecoder;
  outputBuffer: string;
  startPromise: Promise<void> | null;
  pending: Map<string, PendingRpc>;
  currentText: string;
  currentMessageId: string | null;
  committedSegments: string[];
  turnActive: boolean;
  turnGeneration: number;
  cancelled: boolean;
  terminalError: string | null;
  terminalAborted: boolean;
  lastUsage?: ProviderUsageUpdate['usage'];
  modelContextWindow?: { provider: string; modelId: string; contextWindow: number };
  catalogContextWindows?: Map<string, number>;
  sessionSystemTextInjected?: string;
  pendingSessionSystemText?: string;
  toolNames: Map<string, string>;
  lastStatusSignature: string | null;
  compacting?: boolean;
  disposed: boolean;
  incognito?: boolean;
  hasStartedChild?: boolean;
  memoryMcp?: { command: string; args: readonly string[]; env: Record<string, string> };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function numeric(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function extractTextContent(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  return value
    .map((item) => {
      const block = asRecord(item);
      return block?.type === 'text' && typeof block.text === 'string' ? block.text : '';
    })
    .join('');
}

function stringifyToolResult(value: unknown): string | undefined {
  const record = asRecord(value);
  const text = extractTextContent(record?.content);
  if (text) return text;
  if (value === undefined) return undefined;
  try { return JSON.stringify(value); } catch { return String(value); }
}

function modelInfo(value: unknown): { id?: string; name?: string; provider?: string; contextWindow?: number } {
  const model = asRecord(value);
  const contextWindow = numeric(model?.contextWindow);
  return {
    id: typeof model?.id === 'string' ? model.id : undefined,
    name: typeof model?.name === 'string' ? model.name : undefined,
    provider: typeof model?.provider === 'string' ? model.provider : undefined,
    ...(contextWindow !== undefined && contextWindow > 0 ? { contextWindow } : {}),
  };
}

function modelWindowKey(provider: string | undefined, modelId: string): string {
  return JSON.stringify([provider?.trim() ?? '', modelId.trim()]);
}

function resolveAttachmentImageMime(attachment: TransportAttachment): string | null {
  const rawMime = attachment.mime?.trim().toLowerCase();
  if (rawMime) {
    const normalized = rawMime === 'image/jpg' ? 'image/jpeg' : rawMime;
    return SUPPORTED_PI_IMAGE_MIMES.has(normalized) ? normalized : null;
  }
  if (attachment.type !== 'image') return null;
  const ext = extname(attachment.originalName?.trim() || attachment.daemonPath).toLowerCase();
  return IMAGE_MIME_BY_EXT[ext] ?? null;
}

async function readPiImageAttachments(attachments: readonly TransportAttachment[] | undefined): Promise<PiImagePayload[]> {
  if (!attachments?.length) return [];
  const images: PiImagePayload[] = [];
  for (const attachment of attachments) {
    const daemonPath = typeof attachment.daemonPath === 'string' ? attachment.daemonPath.trim() : '';
    if (!daemonPath) continue;
    const mimeType = resolveAttachmentImageMime(attachment);
    if (!mimeType) continue;
    try {
      const info = await stat(daemonPath);
      if (!info.isFile() || info.size <= 0 || info.size > MAX_PI_IMAGE_BYTES) continue;
      const bytes = await readFile(daemonPath);
      if (bytes.length <= 0 || bytes.length > MAX_PI_IMAGE_BYTES) continue;
      images.push({
        type: 'image',
        data: bytes.toString('base64'),
        mimeType,
      });
    } catch (error) {
      logger.debug({ daemonPath, error }, 'Pi skipped unreadable image attachment');
    }
  }
  return images;
}

function normalizeSelectOptions(raw: unknown): Array<{ label: string; description?: string }> {
  if (!Array.isArray(raw)) return [];
  const options: Array<{ label: string; description?: string }> = [];
  for (const entry of raw) {
    if (typeof entry === 'string') {
      const label = entry.trim();
      if (label) options.push({ label });
      continue;
    }
    const obj = asRecord(entry);
    if (!obj) continue;
    const rawLabel = typeof obj.label === 'string' ? obj.label : (typeof obj.value === 'string' ? obj.value : '');
    const label = rawLabel.trim();
    if (!label) continue;
    const desc = typeof obj.description === 'string' && obj.description.trim() ? obj.description.trim() : undefined;
    options.push(desc ? { label, description: desc } : { label });
  }
  return options;
}

function isConfirmApproved(answer: string): boolean {
  const normalized = answer.trim().toLowerCase();
  return normalized === 'yes'
    || normalized === 'y'
    || normalized === 'true'
    || normalized === '1'
    || normalized === 'ok'
    || normalized === 'confirm';
}

export class PiProvider implements TransportProvider, InteractiveQuestionAnswerer {
  readonly id = MEMORY_MCP_PROVIDER_ID.PI;
  readonly connectionMode = CONNECTION_MODES.LOCAL_SDK;
  readonly sessionOwnership = SESSION_OWNERSHIP.SHARED;
  readonly capabilities: ProviderCapabilities = {
    streaming: true,
    toolCalling: true,
    approval: false,
    sessionRestore: true,
    multiTurn: true,
    attachments: true,
    reasoningEffort: true,
    supportedEffortLevels: PI_EFFORT_LEVELS,
    contextSupport: 'degraded-message-side-context-mapping',
    activeDelegationNotification: AGENT_DELEGATION_ACTIVE_NOTIFICATION_MODES.NATIVE,
    // Pi has no provider-native agent tool.
    nativeAgentAdmission: NATIVE_AGENT_ADMISSION_MODES.NO_NATIVE_AGENT_TOOLS,
    compact: {
      execution: 'sdk-rpc',
      verified: true,
      completion: 'rpc-result-or-provider-event',
      cancellation: 'provider-cancel',
      reassertsSessionSystemText: true,
    },
  };

  private config: ProviderConfig | null = null;
  private sessions = new Map<string, PiSessionState>();
  private readonly questions = new PendingQuestionRegistry<PiQuestionOutcome>();
  private readonly pendingQuestionMeta = new Map<string, PiPendingQuestionMeta>();
  private modelCache: { at: number; value: ProviderModelList } | null = null;
  private deltaCallbacks: Array<(sessionId: string, delta: MessageDelta) => void> = [];
  private completeCallbacks: Array<(sessionId: string, message: AgentMessage) => void> = [];
  private errorCallbacks: Array<(sessionId: string, error: ProviderError) => void> = [];
  private toolCallbacks: Array<(sessionId: string, tool: ToolCallEvent) => void> = [];
  private statusCallbacks: Array<(sessionId: string, status: ProviderStatusUpdate) => void> = [];
  private infoCallbacks: Array<(sessionId: string, info: SessionInfoUpdate) => void> = [];
  private usageCallbacks: Array<(sessionId: string, update: ProviderUsageUpdate) => void> = [];

  async connect(config: ProviderConfig): Promise<void> {
    this.config = config;
    logger.info({ provider: this.id, binary: resolvePiBinary() }, 'Pi provider connected');
  }

  async disconnect(): Promise<void> {
    await Promise.all([...this.sessions.keys()].map((id) => this.endSession(id)));
    this.questions.releaseAll();
    this.pendingQuestionMeta.clear();
    this.modelCache = null;
    this.config = null;
    logger.info({ provider: this.id }, 'Pi provider disconnected');
  }

  async createSession(config: SessionConfig): Promise<string> {
    const routeId = config.bindExistingKey ?? config.sessionKey;
    const previous = this.sessions.get(routeId);
    if (previous) await this.stopChild(previous);
    const existing = config.fresh ? undefined : previous;
    const incognito = config.incognito === true || existing?.incognito === true;
    if (incognito && !config.fresh && (config.resumeId?.trim() || config.skipCreate)) {
      throw new Error('Incognito conversation cannot be resumed; start a new session instead.');
    }
    setSessionIncognito(routeId, incognito);
    if (config.sessionName) setSessionIncognito(config.sessionName, incognito);
    const requestedModel = config.agentId?.trim() || existing?.requestedModel;
    const effort = config.effort ?? existing?.effort;
    const piSessionId = incognito
      ? ''
      : (config.fresh
        ? randomUUID()
        : (config.resumeId?.trim() || existing?.piSessionId || randomUUID()));
    const state: PiSessionState = {
      routeId,
      piSessionId,
      incognito,
      hasStartedChild: false,
      sessionName: config.sessionName ?? existing?.sessionName,
      resourceOwner: agentResourceOwner(config) ?? existing?.resourceOwner ?? null,
      projectName: config.projectName ?? existing?.projectName,
      cwd: normalizeTransportCwd(config.cwd) ?? existing?.cwd ?? normalizeTransportCwd(process.cwd())!,
      env: config.env ?? existing?.env,
      ...(requestedModel ? { requestedModel } : {}),
      ...(effort ? { effort } : {}),
      llmConfig: config.piLlm,
      child: null,
      decoder: new StringDecoder('utf8'),
      outputBuffer: '',
      startPromise: null,
      pending: new Map(),
      currentText: '',
      currentMessageId: null,
      committedSegments: [],
      turnActive: false,
      turnGeneration: 0,
      cancelled: false,
      terminalError: null,
      terminalAborted: false,
      sessionSystemTextInjected: existing?.sessionSystemTextInjected,
      toolNames: new Map(),
      lastStatusSignature: null,
      disposed: false,
      memoryMcp: this.buildMemoryMcp(config),
    };
    this.sessions.set(routeId, state);
    this.emitInfo(routeId, {
      ...(incognito ? {} : { resumeId: piSessionId }),
      ...(requestedModel ? { model: requestedModel } : {}),
      ...(effort ? { effort } : {}),
    });
    return routeId;
  }

  async endSession(sessionId: string): Promise<void> {
    const state = this.sessions.get(sessionId);
    if (!state) return;
    state.disposed = true;
    this.releasePendingQuestions(state, true);
    await this.stopChild(state);
    this.sessions.delete(sessionId);
  }

  answerPendingQuestion(sessionName: string, answer: string): boolean {
    for (const [routeId, state] of this.sessions) {
      if ((state.sessionName ?? routeId) !== sessionName) continue;
      if (!this.questions.has(routeId)) return false;
      return this.questions.resolve(routeId, { cancelled: false, answer });
    }
    return false;
  }

  refreshSessionSystemText(sessionId: string): void {
    const state = this.sessions.get(sessionId);
    if (!state) return;
    state.sessionSystemTextInjected = undefined;
    state.pendingSessionSystemText = undefined;
  }

  onDelta(cb: (sessionId: string, delta: MessageDelta) => void): () => void {
    this.deltaCallbacks.push(cb);
    return () => { this.deltaCallbacks = this.deltaCallbacks.filter((entry) => entry !== cb); };
  }

  onComplete(cb: (sessionId: string, message: AgentMessage) => void): () => void {
    this.completeCallbacks.push(cb);
    return () => { this.completeCallbacks = this.completeCallbacks.filter((entry) => entry !== cb); };
  }

  onError(cb: (sessionId: string, error: ProviderError) => void): () => void {
    this.errorCallbacks.push(cb);
    return () => { this.errorCallbacks = this.errorCallbacks.filter((entry) => entry !== cb); };
  }

  onToolCall(cb: (sessionId: string, tool: ToolCallEvent) => void): void {
    this.toolCallbacks.push(cb);
  }

  onStatus(cb: (sessionId: string, status: ProviderStatusUpdate) => void): () => void {
    this.statusCallbacks.push(cb);
    return () => { this.statusCallbacks = this.statusCallbacks.filter((entry) => entry !== cb); };
  }

  onSessionInfo(cb: (sessionId: string, info: SessionInfoUpdate) => void): () => void {
    this.infoCallbacks.push(cb);
    return () => { this.infoCallbacks = this.infoCallbacks.filter((entry) => entry !== cb); };
  }

  onUsage(cb: (sessionId: string, update: ProviderUsageUpdate) => void): () => void {
    this.usageCallbacks.push(cb);
    return () => { this.usageCallbacks = this.usageCallbacks.filter((entry) => entry !== cb); };
  }

  async send(
    sessionId: string,
    payloadOrMessage: string | ProviderContextPayload,
    attachments?: TransportAttachment[],
    extraSystemPrompt?: string,
  ): Promise<void> {
    const state = this.sessions.get(sessionId);
    if (!state) throw this.makeError(PROVIDER_ERROR_CODES.SESSION_NOT_FOUND, `Unknown session ${sessionId}`, false);
    const payload = normalizeProviderPayload(payloadOrMessage, attachments, extraSystemPrompt);
    if (isSessionControlCommandText(payload.userMessage, 'compact')) {
      if (state.incognito && state.hasStartedChild && !state.child) {
        throw new Error('Incognito conversation ended; start a new session instead of resuming history.');
      }
      await this.compactSession(state);
      return;
    }
    const isSlashControl = payload.userMessage?.trim().startsWith('/') === true;
    const sessionSystemText = getProviderSystemTextParts(payload).sessionSystemText;
    const includeSessionSystemText = !isSlashControl && !!sessionSystemText && state.sessionSystemTextInjected !== sessionSystemText;
    const message = isSlashControl
      ? (payload.assembledMessage || payload.userMessage)
      : composeMessageSideProviderPrompt(payload, { includeSessionSystemText });
    const images = isSlashControl ? [] : await readPiImageAttachments(payload.attachments);
    if (!message.trim() && images.length === 0) return;
    if (state.incognito && state.hasStartedChild && !state.child) {
      throw new Error('Incognito conversation ended; start a new session instead of resuming history.');
    }

    return withSessionPrivacy(state.sessionName ?? state.routeId, state.incognito === true, async () => {
      this.emitStatus(sessionId, state, { status: 'working', label: null });
      state.turnGeneration++;
      await this.ensureChild(state);
      this.resetTurn(state);
      state.currentMessageId = `${state.routeId}:${randomUUID()}`;
      state.turnActive = true;
      state.cancelled = false;
      state.pendingSessionSystemText = includeSessionSystemText ? sessionSystemText : undefined;
      try {
        const response = await this.request(state, {
          type: PI_RPC_COMMAND.PROMPT,
          message,
          ...(images.length > 0 ? { images } : {}),
        });
        const data = asRecord(response.data);
        if (data?.disposition === 'handled') {
          this.finishTurn(state);
        }
      } catch (error) {
        state.turnActive = false;
        this.clearStatus(sessionId, state);
        this.resetTurn(state);
        throw this.makeError(
          PROVIDER_ERROR_CODES.PROVIDER_ERROR,
          error instanceof Error ? error.message : String(error),
          true,
        );
      }
    });
  }

  private async compactSession(state: PiSessionState): Promise<void> {
    const sessionId = state.routeId;
    return withSessionPrivacy(state.sessionName ?? sessionId, state.incognito === true, async () => {
      this.emitStatus(sessionId, state, { status: 'working', label: 'Compacting...' });
      state.turnGeneration++;
      await this.ensureChild(state);
      this.resetTurn(state);
      state.turnActive = true;
      state.compacting = true;
      state.cancelled = false;
      try {
        const response = await this.request(state, { type: PI_RPC_COMMAND.COMPACT });
        state.turnActive = false;
        state.compacting = false;
        this.clearStatus(sessionId, state);
        if (state.cancelled) {
          this.resetTurn(state);
          return;
        }
        this.refreshSessionSystemText(sessionId);
        const data = asRecord(response.data);
        const completion: AgentMessage = {
          id: `${state.routeId}:context-compaction:${Date.now()}`,
          sessionId,
          kind: 'system',
          role: 'system',
          content: 'Pi context compacted.',
          timestamp: Date.now(),
          status: 'complete',
          metadata: {
            provider: this.id,
            event: PI_RPC_FRAME.COMPACTION_END,
            [SESSION_CONTROL_METADATA_COMMAND_FIELD]: 'compact',
            ...(!state.incognito && state.piSessionId ? { resumeId: state.piSessionId } : {}),
            ...(typeof data?.summary === 'string' ? { summary: data.summary } : {}),
            ...(typeof data?.firstKeptEntryId === 'string' ? { firstKeptEntryId: data.firstKeptEntryId } : {}),
          },
        };
        this.resetTurn(state);
        for (const cb of this.completeCallbacks) cb(sessionId, completion);
      } catch (error) {
        state.turnActive = false;
        state.compacting = false;
        this.clearStatus(sessionId, state);
        const wasCancelled = state.cancelled;
        this.resetTurn(state);
        if (wasCancelled) return;
        const providerError = this.makeError(
          PROVIDER_ERROR_CODES.PROVIDER_ERROR,
          `Pi compact failed: ${error instanceof Error ? error.message : String(error)}`,
          true,
        );
        this.emitError(sessionId, providerError);
        throw providerError;
      }
    });
  }

  async notifyActiveDelegation(
    sessionId: string,
    notification: ProviderDelegationNotification,
  ): Promise<AgentDelegationNotificationResult> {
    const state = this.sessions.get(sessionId);
    if (!state?.turnActive || state.cancelled || !state.child) {
      return AGENT_DELEGATION_NOTIFICATION_RESULTS.STALE;
    }
    try {
      await this.request(state, { type: PI_RPC_COMMAND.STEER, message: notification.text });
      return AGENT_DELEGATION_NOTIFICATION_RESULTS.DELIVERED;
    } catch {
      return AGENT_DELEGATION_NOTIFICATION_RESULTS.STALE;
    }
  }

  private readonly stopConfirmations = new ProviderStopConfirmation();

  cancelAndWait(sessionId: string): Promise<void> {
    const state = this.sessions.get(sessionId);
    const capturedChild = state?.child;
    if (!state || !capturedChild) return Promise.reject(new Error('Provider child unavailable for Stop'));
    const onExit = () => this.stopConfirmations.complete(capturedChild);
    capturedChild.once('exit', onExit);
    const generation = state.turnGeneration;
    const operation = this.stopConfirmations.confirm(capturedChild, () => this.cancel(sessionId),
      () => this.sessions.get(sessionId) === state && state.turnGeneration === generation);
    return preserveProviderStopProof(operation, operation.finally(() => capturedChild.removeListener('exit', onExit)));
  }

  async cancel(sessionId: string): Promise<void> {
    const state = this.sessions.get(sessionId);
    if (!state) return;
    this.releasePendingQuestions(state, true);
    if (!state.child) return;
    state.cancelled = true;
    await this.request(state, { type: PI_RPC_COMMAND.CLEAR_QUEUE }).catch(() => {});
    await this.request(state, { type: PI_RPC_COMMAND.ABORT }).catch(() => {});
  }

  async restoreSession(sessionId: string): Promise<boolean> {
    const state = this.sessions.get(sessionId);
    if (!state || state.incognito) return false;
    return true;
  }

  setSessionAgentId(sessionId: string, agentId: string): void {
    const state = this.sessions.get(sessionId);
    const model = agentId.trim();
    if (!state || !model || state.requestedModel === model) return;
    state.requestedModel = model;
    const child = state.child;
    if (child && !state.turnActive) {
      const slash = model.indexOf('/');
      const provider = slash > 0 ? model.slice(0, slash) : (state.provider ?? state.llmConfig?.provider);
      const modelId = slash > 0 ? model.slice(slash + 1) : model;
      if (provider && modelId) {
        void this.request(state, { type: PI_RPC_COMMAND.SET_MODEL, provider, modelId })
          .then((response) => {
            const switched = modelInfo(response.data);
            state.model = switched.id ?? modelId;
            state.provider = switched.provider ?? provider;
            this.setSessionModelContextWindow(state, state.provider, state.model, switched.contextWindow);
            this.emitInfo(sessionId, { model: state.model });
            void this.syncAvailableThinkingLevels(state);
          })
          .catch(() => {
            if (!state.incognito && state.child === child && !state.disposed) {
              state.modelContextWindow = undefined;
              state.catalogContextWindows = undefined;
              this.detachChild(state);
              void this.stopChild(state, child);
            }
          });
        return;
      }
    }
    if (state.incognito) return;
    if (child) {
      state.modelContextWindow = undefined;
      state.catalogContextWindows = undefined;
      this.detachChild(state);
      void this.stopChild(state, child);
    }
  }

  setSessionEffort(sessionId: string, effort: TransportEffortLevel): void {
    const state = this.sessions.get(sessionId);
    if (!state || state.effort === effort) return;
    state.effort = effort;
    if (state.child && !state.turnActive) {
      void this.request(state, { type: PI_RPC_COMMAND.SET_THINKING_LEVEL, level: effort })
        .then(() => this.emitInfo(sessionId, { effort }))
        .catch(() => {});
    }
  }

  async listModels(force = false): Promise<ProviderModelList> {
    if (!force && this.modelCache && Date.now() - this.modelCache.at < MODEL_CACHE_TTL_MS) {
      return this.modelCache.value;
    }
    const probeState = this.findLiveModelProbeSession();
    if (!probeState) {
      return this.modelCache?.value ?? { models: [] };
    }
    try {
      if (!probeState.hasStartedChild && probeState.startPromise) {
        await probeState.startPromise.catch(() => {});
      }
      if (!probeState.child || probeState.disposed) {
        return this.modelCache?.value ?? { models: [] };
      }
      const response = await this.request(probeState, { type: PI_RPC_COMMAND.GET_AVAILABLE_MODELS });
      const data = asRecord(response.data);
      const rawModels = Array.isArray(data?.models)
        ? data.models
        : (Array.isArray(response.data) ? response.data : null);
      if (!rawModels) {
        return this.modelCache?.value ?? { models: [] };
      }
      const models: ProviderModelInfo[] = [];
      const seen = new Set<string>();
      const catalogContextWindows = new Map<string, number>();
      for (const entry of rawModels) {
        const record = asRecord(entry);
        const rawId = typeof record?.id === 'string' ? record.id.trim() : '';
        if (!rawId) continue;
        const provider = typeof record?.provider === 'string' ? record.provider.trim() : '';
        const contextWindow = numeric(record?.contextWindow);
        if (contextWindow !== undefined && contextWindow > 0) {
          catalogContextWindows.set(modelWindowKey(provider, rawId), contextWindow);
        }
        const id = provider && !rawId.includes('/') ? `${provider}/${rawId}` : rawId;
        if (seen.has(id)) continue;
        seen.add(id);
        const rawName = typeof record?.name === 'string' && record.name.trim() ? record.name.trim() : rawId;
        const name = provider && !rawName.startsWith(provider) ? `${provider} · ${rawName}` : rawName;
        models.push({
          id,
          name,
          ...(record?.reasoning === true ? { supportsReasoningEffort: true } : {}),
        });
      }
      probeState.catalogContextWindows = catalogContextWindows;
      const list: ProviderModelList = {
        models,
        ...(models.length > 0 ? { isAuthenticated: true } : {}),
      };
      this.modelCache = { at: Date.now(), value: list };
      return list;
    } catch {
      return this.modelCache?.value ?? { models: [] };
    }
  }

  getMemoryMcpStatus(): MemoryMcpProviderStatusView {
    return {
      providerId: this.id,
      status: this.config ? MEMORY_MCP_STATUS.READY : MEMORY_MCP_STATUS.UNKNOWN,
      connected: Boolean(this.config),
      degradedReasons: [],
    };
  }

  getSessionDiagnostics(sessionId: string): Record<string, unknown> | null {
    const state = this.sessions.get(sessionId);
    if (!state) return null;
    return {
      provider: this.id,
      binary: resolvePiBinary(),
      cwd: state.cwd,
      model: state.model,
      ...(state.incognito ? {} : { piSessionId: state.piSessionId }),
      incognito: Boolean(state.incognito),
      childRunning: !!state.child,
      turnActive: state.turnActive,
      memoryMcpMounted: !!state.memoryMcp,
    };
  }

  private buildMemoryMcp(config: SessionConfig): PiSessionState['memoryMcp'] {
    if (config.incognito) return undefined;
    const server = getDefaultMcpServers(config, {
      // Pi owns the complete paginated refresh + generation proof and can
      // therefore consume standard tools/list_changed without stale schemas.
      toolCatalogMode: MCP_TOOL_CATALOG_MODES.DYNAMIC,
    })[IMCODES_MEMORY_MCP_SERVER_NAME];
    return server ? { command: server.command, args: server.args, env: server.env } : undefined;
  }

  private async ensureChild(state: PiSessionState): Promise<void> {
    if (state.incognito && state.hasStartedChild && !state.child) {
      throw new Error('Incognito conversation ended; start a new session instead of resuming history.');
    }
    if (state.child && state.startPromise) {
      await state.startPromise;
      return;
    }
    const privacyKey = state.sessionName ?? state.routeId;
    const isPrivate = state.incognito === true;
    const executable = resolveExecutableForSpawn(resolvePiBinary());
    const childEnv: Record<string, string | undefined> = {
      ...process.env,
      ...(state.env ?? {}),
      ...(state.llmConfig ? { [PI_PROVIDER_CONFIG_ENV]: JSON.stringify(state.llmConfig) } : {}),
      ...(state.llmConfig?.apiKey ? { [PI_PROVIDER_API_KEY_ENV]: state.llmConfig.apiKey } : {}),
    };
    if (state.incognito) {
      delete childEnv[PI_MCP_CONFIG_ENV];
    } else if (state.memoryMcp) {
      childEnv[PI_MCP_CONFIG_ENV] = JSON.stringify(state.memoryMcp);
    }
    const child = withSessionPrivacy(privacyKey, isPrivate, () => spawn(
      executable.executable,
      [...executable.prependArgs, ...buildPiRpcArgs({
        sessionId: state.piSessionId,
        sessionName: state.sessionName,
        requestedModel: state.requestedModel,
        effort: state.effort,
        llm: state.llmConfig,
        incognito: state.incognito,
      })],
      {
        cwd: state.cwd,
        env: childEnv,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        // Own process group and session on POSIX. A reparented descendant keeps
        // its PGID but loses its PPID, so after the agent parent dies this is the
        // only ownership token teardown still has. Without it the eight vitest
        // workers of the incident were unreachable on PPID=1.
        detached: process.platform !== 'win32',
      },
    ));
    state.child = child;
    state.modelContextWindow = undefined;
    state.catalogContextWindows = undefined;
    // Crash coverage: if the daemon dies without running teardown, the startup
    // sweep reaps this group using the registry's process-start fingerprint.
    state.agentResource = bindAgentProcessResource(state.resourceOwner ?? null, child);
    state.decoder = new StringDecoder('utf8');
    state.outputBuffer = '';
    child.stdin?.on('error', (error) => withSessionPrivacy(privacyKey, isPrivate, () => {
      logger.debug({ provider: this.id, session: state.sessionName, error }, 'Pi stdin error');
    }));
    gateChildStream(child.stdout)?.on('data', (chunk: Buffer) => withSessionPrivacy(privacyKey, isPrivate, () => {
      this.handleChunk(state, chunk);
    }));
    child.stderr?.on('data', (chunk: Buffer) => withSessionPrivacy(privacyKey, isPrivate, () => {
      const line = chunk.toString('utf8').trim();
      if (line) logger.debug({ provider: this.id, session: state.sessionName, line: line.slice(0, 500) }, 'Pi stderr');
    }));
    child.on('error', (error) => withSessionPrivacy(privacyKey, isPrivate, () => {
      this.handleGone(state, child, formatPiLaunchError(error));
    }));
    child.on('exit', (code, signal) => withSessionPrivacy(privacyKey, isPrivate, () => {
      this.stopConfirmations.complete(child);
      this.handleGone(state, child, `Pi exited (code=${code ?? 'null'} signal=${signal ?? 'null'})`);
    }));
    child.on('close', (code, signal) => withSessionPrivacy(privacyKey, isPrivate, () => {
      this.stopConfirmations.complete(child);
      this.handleGone(state, child, `Pi closed (code=${code ?? 'null'} signal=${signal ?? 'null'})`);
    }));

    const startPromise = this.request(state, { type: PI_RPC_COMMAND.GET_STATE })
      .then((response) => {
        state.hasStartedChild = true;
        this.applyStateResponse(state, response.data);
        void this.syncAvailableThinkingLevels(state);
      })
      .catch(async (error) => {
        if (state.child === child) this.detachChild(state);
        // Awaited, not discarded: `startPromise` below is awaited, so the full
        // SIGTERM->SIGKILL window completes before this failure propagates.
        await killProcessTree(child, { ownsProcessGroup: true }).catch(() => {});
        throw error;
      });
    state.startPromise = startPromise;
    await startPromise;
  }

  private async stopChild(state: PiSessionState, explicit?: ChildProcess | null): Promise<void> {
    const child = explicit ?? state.child;
    if (!child) return;
    if (state.child === child) this.detachChild(state);
    await killProcessTree(child, { gracefulMs: SHUTDOWN_GRACE_MS, ownsProcessGroup: true }).catch(() => {});
  }

  private detachChild(state: PiSessionState): void {
    this.releasePendingQuestions(state, true);
    state.child = null;
    state.startPromise = null;
    const error = new Error('Pi RPC process disconnected');
    for (const pending of state.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    state.pending.clear();
  }

  private handleGone(state: PiSessionState, child: ChildProcess, message: string): void {
    if (state.child !== child) return;
    const wasActive = state.turnActive;
    this.detachChild(state);
    if (state.disposed || !wasActive) return;
    state.turnActive = false;
    state.compacting = false;
    this.clearStatus(state.routeId, state);
    this.resetTurn(state);
    this.emitError(state.routeId, this.makeError(PROVIDER_ERROR_CODES.CONNECTION_LOST, message, true));
  }

  private findLiveModelProbeSession(): PiSessionState | null {
    let pending: PiSessionState | null = null;
    for (const state of this.sessions.values()) {
      if (state.disposed || !state.child || state.child.killed || !state.child.stdin || state.child.stdin.destroyed) {
        continue;
      }
      if (state.hasStartedChild) return state;
      if (!pending) pending = state;
    }
    return pending;
  }

  private async syncAvailableThinkingLevels(state: PiSessionState): Promise<void> {
    if (state.disposed || !state.child) return;
    try {
      const response = await this.request(state, { type: PI_RPC_COMMAND.GET_AVAILABLE_THINKING_LEVELS });
      if (state.disposed || !state.child) return;
      const data = asRecord(response.data);
      const supported = normalizeSupportedEffortLevels(data?.levels ?? response.data);
      if (!supported?.length) return;
      if (state.effort && !supported.includes(state.effort)) {
        const clamped = clampTransportEffort(state.effort, supported);
        if (clamped) {
          state.effort = clamped;
          this.emitInfo(state.routeId, { effort: clamped });
          if (!state.turnActive) {
            void this.request(state, { type: PI_RPC_COMMAND.SET_THINKING_LEVEL, level: clamped }).catch(() => {});
          }
        }
      }
    } catch {
      // Older Pi releases (< 1.6.0) do not implement get_available_thinking_levels; ignore cleanly.
    }
  }

  private writeExtensionUiResponse(state: PiSessionState, payload: Record<string, unknown>): void {
    const stdin = state.child?.stdin;
    if (!stdin || stdin.destroyed) return;
    try {
      stdin.write(`${JSON.stringify({ type: PI_RPC_FRAME.EXTENSION_UI_RESPONSE, ...payload })}\n`);
    } catch (error) {
      logger.debug({ provider: this.id, session: state.sessionName, error }, 'Pi failed writing extension_ui_response');
    }
  }

  private releasePendingQuestions(state: PiSessionState, sendCancelToChild: boolean): void {
    const meta = this.pendingQuestionMeta.get(state.routeId);
    if (meta) {
      this.pendingQuestionMeta.delete(state.routeId);
      if (sendCancelToChild) {
        this.writeExtensionUiResponse(state, { id: meta.id, cancelled: true });
      }
    }
    this.questions.release(state.routeId);
  }

  private handleExtensionUiRequest(state: PiSessionState, event: Record<string, unknown>): void {
    const sessionId = state.routeId;
    const method = typeof event.method === 'string' ? event.method.trim() : '';
    if (method === 'notify') {
      logger.info({
        provider: this.id,
        session: state.sessionName,
        notifyType: event.notifyType,
        message: event.message,
      }, 'Pi extension notify');
      return;
    }
    if (method === 'setStatus') {
      const statusText = typeof event.statusText === 'string' ? event.statusText.trim() : '';
      if (state.turnActive) {
        this.emitStatus(sessionId, state, { status: 'working', label: statusText || null });
      } else {
        logger.debug({
          provider: this.id,
          session: state.sessionName,
          statusKey: event.statusKey,
          statusText,
        }, 'Pi extension status');
      }
      return;
    }
    if (method !== 'select' && method !== 'confirm' && method !== 'input' && method !== 'editor') {
      return;
    }
    const requestId = typeof event.id === 'string' && event.id.trim() ? event.id.trim() : '';
    if (!requestId) return;

    this.releasePendingQuestions(state, true);

    let questionItem: AskQuestionItem;
    if (method === 'select') {
      const options = normalizeSelectOptions(event.options);
      const question = (typeof event.title === 'string' && event.title.trim()) || 'Select an option';
      questionItem = {
        question,
        ...(options.length > 0 ? { options } : {}),
      };
    } else if (method === 'confirm') {
      const title = typeof event.title === 'string' ? event.title.trim() : '';
      const message = typeof event.message === 'string' ? event.message.trim() : '';
      const question = [title, message].filter(Boolean).join('\n') || 'Confirm?';
      questionItem = {
        question,
        options: [{ label: 'Yes' }, { label: 'No' }],
      };
    } else {
      const title = typeof event.title === 'string' ? event.title.trim() : '';
      const placeholder = typeof event.placeholder === 'string' ? event.placeholder.trim() : '';
      const question = [title, placeholder].filter(Boolean).join('\n')
        || (method === 'editor' ? 'Enter text' : 'Enter input');
      questionItem = { question };
    }

    const meta: PiPendingQuestionMeta = { id: requestId, method };
    this.pendingQuestionMeta.set(sessionId, meta);

    this.emitTool(sessionId, {
      id: requestId,
      name: INTERACTIVE_QUESTION_TOOL_NAME,
      status: 'complete',
      input: { questions: [questionItem] },
    });

    const rawTimeout = numeric(event.timeout);
    const timeoutMs = rawTimeout !== undefined && rawTimeout > 0 ? rawTimeout : DEFAULT_EXTENSION_UI_TIMEOUT_MS;
    void this.questions.wait(sessionId, {
      timeoutMs,
      fallback: { cancelled: true },
    }).then((outcome) => {
      if (this.pendingQuestionMeta.get(sessionId) !== meta) return;
      this.pendingQuestionMeta.delete(sessionId);
      if (outcome.cancelled) {
        this.writeExtensionUiResponse(state, { id: meta.id, cancelled: true });
        return;
      }
      const trimmed = outcome.answer.trim();
      const parsed = parseAskQuestionAnswers([questionItem], outcome.answer)[0]?.[0];
      if (!parsed || !trimmed || trimmed === 'skip') {
        this.writeExtensionUiResponse(state, { id: meta.id, cancelled: true });
        return;
      }
      if (meta.method === 'confirm') {
        this.writeExtensionUiResponse(state, { id: meta.id, confirmed: isConfirmApproved(parsed) });
        return;
      }
      if (meta.method === 'select') {
        this.writeExtensionUiResponse(state, { id: meta.id, value: parsed });
        return;
      }
      this.writeExtensionUiResponse(state, { id: meta.id, value: outcome.answer });
    });
  }

  private request(state: PiSessionState, command: PiRpcCommand): Promise<PiRpcResponse> {
    const stdin = state.child?.stdin;
    if (!stdin || stdin.destroyed) return Promise.reject(new Error('Pi RPC process is unavailable'));
    const id = command.id ?? randomUUID();
    return new Promise<PiRpcResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        state.pending.delete(id);
        reject(new Error(`Pi RPC ${command.type} timed out after ${RPC_TIMEOUT_MS}ms`));
      }, RPC_TIMEOUT_MS);
      timer.unref?.();
      state.pending.set(id, { resolve, reject, timer });
      try {
        stdin.write(`${JSON.stringify({ ...command, id })}\n`);
      } catch (error) {
        clearTimeout(timer);
        state.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  /** Strict LF-only decoder: Pi permits U+2028/U+2029 inside JSON strings. */
  private handleChunk(state: PiSessionState, chunk: Buffer): void {
    state.outputBuffer += state.decoder.write(chunk);
    while (true) {
      const index = state.outputBuffer.indexOf('\n');
      if (index < 0) break;
      let line = state.outputBuffer.slice(0, index);
      state.outputBuffer = state.outputBuffer.slice(index + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      this.handleLine(state, line);
    }
  }

  private handleLine(state: PiSessionState, line: string): void {
    if (!line.trim()) return;
    let frame: unknown;
    try { frame = JSON.parse(line); } catch {
      logger.debug({ provider: this.id, line: line.slice(0, 500) }, 'Pi non-protocol stdout');
      return;
    }
    if (isPiRpcResponse(frame)) {
      const pending = frame.id ? state.pending.get(frame.id) : undefined;
      if (!pending) return;
      clearTimeout(pending.timer);
      state.pending.delete(frame.id!);
      if (frame.success) pending.resolve(frame);
      else pending.reject(new Error(frame.error || `Pi RPC ${frame.command} failed`));
      return;
    }
    const event = asRecord(frame);
    if (event) this.dispatch(state, event);
  }

  private dispatch(state: PiSessionState, event: Record<string, unknown>): void {
    const sessionId = state.routeId;
    switch (event.type) {
      case PI_RPC_FRAME.AGENT_START:
        state.turnActive = true;
        this.emitStatus(sessionId, state, { status: 'working', label: null });
        return;
      case PI_RPC_FRAME.MESSAGE_UPDATE: {
        const update = asRecord(event.assistantMessageEvent);
        if (update?.type === PI_ASSISTANT_EVENT.TEXT_DELTA && typeof update.delta === 'string') {
          state.currentText += update.delta;
          const messageId = state.currentMessageId ?? `${state.routeId}:${randomUUID()}`;
          state.currentMessageId = messageId;
          for (const cb of this.deltaCallbacks) {
            cb(sessionId, { messageId, type: 'text', delta: state.currentText, role: 'assistant' });
          }
        } else if (update?.type === PI_ASSISTANT_EVENT.THINKING_DELTA) {
          this.emitStatus(sessionId, state, { status: 'thinking', label: 'Thinking...' });
        }
        this.captureUsage(state, event.usage);
        return;
      }
      case PI_RPC_FRAME.MESSAGE_END:
        this.captureMessageEnd(state, event.message);
        return;
      case PI_RPC_FRAME.TOOL_EXECUTION_START: {
        const id = typeof event.toolCallId === 'string' ? event.toolCallId : randomUUID();
        const name = typeof event.toolName === 'string' ? event.toolName : 'tool';
        state.toolNames.set(id, name);
        this.emitTool(sessionId, { id, name, status: 'running', input: event.args });
        return;
      }
      case PI_RPC_FRAME.TOOL_EXECUTION_UPDATE: {
        const id = typeof event.toolCallId === 'string' ? event.toolCallId : randomUUID();
        const name = typeof event.toolName === 'string' ? event.toolName : (state.toolNames.get(id) ?? 'tool');
        this.emitTool(sessionId, {
          id,
          name,
          status: 'running',
          input: event.args,
          output: stringifyToolResult(event.partialResult),
        });
        return;
      }
      case PI_RPC_FRAME.TOOL_EXECUTION_END: {
        const id = typeof event.toolCallId === 'string' ? event.toolCallId : randomUUID();
        const name = typeof event.toolName === 'string' ? event.toolName : (state.toolNames.get(id) ?? 'tool');
        this.emitTool(sessionId, {
          id,
          name,
          status: event.isError === true ? 'error' : 'complete',
          output: stringifyToolResult(event.result),
        });
        return;
      }
      case PI_RPC_FRAME.COMPACTION_START:
        this.emitStatus(sessionId, state, { status: 'working', label: 'Compacting...' });
        return;
      case PI_RPC_FRAME.COMPACTION_END:
        this.refreshSessionSystemText(sessionId);
        if (!state.compacting) {
          if (state.turnActive) {
            this.emitStatus(sessionId, state, { status: 'working', label: null });
          } else {
            this.clearStatus(sessionId, state);
          }
        }
        return;
      case PI_RPC_FRAME.EXTENSION_UI_REQUEST:
        this.handleExtensionUiRequest(state, event);
        return;
      case PI_RPC_FRAME.EXTENSION_ERROR:
        logger.warn({
          provider: this.id,
          session: state.sessionName,
          error: event.error,
          extensionPath: event.extensionPath,
        }, 'Pi extension error');
        return;
      case PI_RPC_FRAME.AUTO_RETRY_START:
        this.emitStatus(sessionId, state, { status: 'working', label: 'Retrying...' });
        return;
      case PI_RPC_FRAME.AGENT_SETTLED:
        if (state.child) this.stopConfirmations.complete(state.child);
        this.finishTurn(state);
        return;
      default:
        return;
    }
  }

  private captureMessageEnd(state: PiSessionState, value: unknown): void {
    const message = asRecord(value);
    if (message?.role !== 'assistant') return;
    const text = extractTextContent(message.content);
    if (text) state.committedSegments.push(text);
    const info = modelInfo(message);
    const prevProvider = state.provider?.trim() ?? '';
    const prevModel = state.model?.trim() ?? '';
    // Pi assistant messages carry `model` as the model id string, whereas
    // get_state returns the full model object. Accept both authoritative shapes
    // so usage/final metadata follows provider switches made by Pi itself.
    const messageModel = typeof message.model === 'string' ? message.model : info.id;
    if (messageModel) state.model = messageModel;
    if (info.provider) state.provider = info.provider;
    const nextProvider = state.provider?.trim() ?? '';
    const nextModel = state.model?.trim() ?? '';
    if (info.contextWindow !== undefined) {
      this.setSessionModelContextWindow(state, nextProvider, nextModel, info.contextWindow);
    } else if (nextProvider !== prevProvider || nextModel !== prevModel) {
      state.modelContextWindow = undefined;
    }
    this.captureUsage(state, message.usage);
    if (message.stopReason === 'error') state.terminalError = typeof message.errorMessage === 'string' ? message.errorMessage : 'Pi turn failed';
    if (message.stopReason === 'aborted') state.terminalAborted = true;
  }

  private captureUsage(state: PiSessionState, value: unknown): void {
    const usage = asRecord(value);
    if (!usage) return;
    const contextWindow = this.resolveSessionModelContextWindow(state);
    const normalized = {
      ...(numeric(usage.input) !== undefined ? { input_tokens: numeric(usage.input) } : {}),
      ...(numeric(usage.output) !== undefined ? { output_tokens: numeric(usage.output) } : {}),
      ...(numeric(usage.cacheRead) !== undefined ? { cache_read_input_tokens: numeric(usage.cacheRead) } : {}),
      ...(numeric(usage.cacheWrite) !== undefined ? { cache_creation_input_tokens: numeric(usage.cacheWrite) } : {}),
      ...(contextWindow !== undefined ? { model_context_window: contextWindow } : {}),
    };
    if (Object.keys(normalized).length === 0) return;
    state.lastUsage = normalized;
    for (const cb of this.usageCallbacks) {
      cb(state.routeId, {
        usage: normalized,
        ...(state.model ? { model: state.model } : {}),
        ...(state.currentMessageId ? { messageId: state.currentMessageId } : {}),
      });
    }
  }

  private finishTurn(state: PiSessionState): void {
    if (!state.turnActive) return;
    state.turnActive = false;
    this.clearStatus(state.routeId, state);
    if (state.terminalError || state.terminalAborted || state.cancelled) {
      const cancelled = state.terminalAborted || state.cancelled;
      const message = state.terminalError || (cancelled ? 'Turn cancelled' : 'Pi turn failed');
      this.resetTurn(state);
      this.emitError(state.routeId, this.makeError(
        cancelled ? PROVIDER_ERROR_CODES.CANCELLED : PROVIDER_ERROR_CODES.PROVIDER_ERROR,
        message,
        true,
      ));
      return;
    }
    if (state.pendingSessionSystemText) state.sessionSystemTextInjected = state.pendingSessionSystemText;
    const content = state.committedSegments.length > 0 ? state.committedSegments.join('') : state.currentText;
    const completion: AgentMessage = {
      id: state.currentMessageId ?? `${state.routeId}:${randomUUID()}`,
      sessionId: state.routeId,
      kind: 'text',
      role: 'assistant',
      content,
      timestamp: Date.now(),
      status: 'complete',
      metadata: {
        ...(state.model ? { model: state.model } : {}),
        ...(state.lastUsage ? { usage: state.lastUsage } : {}),
      },
    };
    this.resetTurn(state);
    for (const cb of this.completeCallbacks) cb(state.routeId, completion);
  }

  private setSessionModelContextWindow(
    state: PiSessionState,
    provider: string | undefined,
    modelId: string | undefined,
    contextWindow: number | undefined,
  ): void {
    const rawId = modelId?.trim();
    if (!rawId || contextWindow === undefined || !Number.isFinite(contextWindow) || contextWindow <= 0) {
      state.modelContextWindow = undefined;
      return;
    }
    state.modelContextWindow = {
      provider: provider?.trim() ?? '',
      modelId: rawId,
      contextWindow,
    };
  }

  private resolveSessionModelContextWindow(state: PiSessionState): number | undefined {
    const rawId = state.model?.trim();
    if (!rawId) return undefined;
    const provider = state.provider?.trim() ?? '';
    const snapshot = state.modelContextWindow;
    if (snapshot && snapshot.provider === provider && snapshot.modelId === rawId) {
      return snapshot.contextWindow;
    }
    return state.catalogContextWindows?.get(modelWindowKey(provider, rawId));
  }

  private applyStateResponse(state: PiSessionState, value: unknown): void {
    const data = asRecord(value);
    const model = modelInfo(data?.model);
    if (model.id) state.model = model.id;
    if (model.provider) state.provider = model.provider;
    this.setSessionModelContextWindow(state, state.provider, state.model, model.contextWindow);
    const effort = data?.thinkingLevel;
    if (isTransportEffortLevel(effort)) state.effort = effort;
    this.emitInfo(state.routeId, {
      ...(state.incognito ? {} : { resumeId: typeof data?.sessionId === 'string' ? data.sessionId : state.piSessionId }),
      ...(model.id ? { model: model.id } : {}),
      ...(isTransportEffortLevel(effort) ? { effort } : {}),
    });
  }

  private resetTurn(state: PiSessionState): void {
    state.currentText = '';
    state.currentMessageId = null;
    state.committedSegments = [];
    state.cancelled = false;
    state.compacting = false;
    state.terminalError = null;
    state.terminalAborted = false;
    state.lastUsage = undefined;
    state.pendingSessionSystemText = undefined;
    state.toolNames.clear();
  }

  private emitTool(sessionId: string, tool: ToolCallEvent): void {
    for (const cb of this.toolCallbacks) cb(sessionId, tool);
  }

  private emitError(sessionId: string, error: ProviderError): void {
    for (const cb of this.errorCallbacks) cb(sessionId, error);
  }

  private emitInfo(sessionId: string, info: SessionInfoUpdate): void {
    for (const cb of this.infoCallbacks) cb(sessionId, info);
  }

  private emitStatus(sessionId: string, state: PiSessionState, status: ProviderStatusUpdate): void {
    const signature = JSON.stringify({ status: status.status, label: status.label ?? null });
    if (state.lastStatusSignature === signature) return;
    state.lastStatusSignature = signature;
    for (const cb of this.statusCallbacks) cb(sessionId, status);
  }

  private clearStatus(sessionId: string, state: PiSessionState): void {
    this.emitStatus(sessionId, state, { status: null, label: null });
  }

  private makeError(code: string, message: string, recoverable: boolean): ProviderError {
    return { code, message, recoverable };
  }
}
