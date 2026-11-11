import { AgyTranscriptBridge, agyTranscriptFile, type AgyTranscriptRow } from '../agy-transcript-bridge.js';
import { AgySubagentTracker } from '../agy-subagents.js';
import { AgyCompactionWatermark } from '../agy-compaction-watermark.js';
import { AGY_SDK_PROVIDER_ID } from '../../../shared/agy-agent.js';
import { AgyContextUsage } from '../agy-context-usage.js';
import { confirmPromiseStop } from '../provider-stop-confirmation.js';
/**
 * KimiSdkProvider — TransportProvider that drives `kimi acp` over the
 * Agent Client Protocol (ACP, https://agentclientprotocol.com/).
 *
 * Architecture
 * ------------
 * ACP is a JSON-RPC 2.0 protocol over stdio. We use the canonical TypeScript
 * client from `@agentclientprotocol/sdk` so we don't have to reimplement
 * request/response correlation, ndjson framing, or bidirectional RPC routing.
 *
 * One `kimi acp` child is spawned per daemon on connect() and held for
 * the lifetime of the provider. Multiple ACP sessions are multiplexed over the
 * single stdio connection — the SDK routes each notification/request by
 * `sessionId`, we just maintain a `sessionId → route` map.
 *
 * Unlike QwenProvider (which spawns per-turn `qwen -p` processes and parses
 * Anthropic-shaped stream-json lines), this provider:
 *   - Holds a single long-lived process (like CodexSdkProvider).
 *   - Emits completion when `agent.prompt()` resolves with `{ stopReason }`,
 *     not on a final line event.
 *   - Routes tool_call / tool_call_update events by ACP `toolCallId`.
 *
 * Session persistence
 * -------------------
 * Kimi CLI persists session history in its own session store, so
 * `session/load` works across process restarts. We call `newSession` on first
 * send and `loadSession` when a `resumeId` is present.
 *
 * Limitations (intentional for MVP)
 * ---------------------------------
 * - Reasoning effort: ACP has no per-session effort knob; Kimi bakes thinking
 *   budget into the model choice. capabilities.reasoningEffort = false.
 * - Attachments: ACP supports image/audio ContentBlocks, but we currently
 *   accept text only to match other SDK providers.
 * - Filesystem reverse-RPC: we advertise fs capabilities = false so the agent
 *   uses its own fs access. Wiring client-side fs through the daemon would
 *   require a permission-broker integration we don't need yet.
 * - Auth: the Kimi CLI caches OAuth credentials under ~/.kimi/. We do NOT
 *   call `authenticate()` and rely on the user having logged in once. API-key
 *   auth can be added later by wiring the `AUTHENTICATE` path.
 */

import { gateChildStream } from '../../util/event-loop-backpressure.js';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  ClientSideConnection,
  ndJsonStream,
  RequestError,
  type Agent as AcpAgent,
  type Client as AcpClient,
  type ContentBlock,
  type LoadSessionResponse,
  type NewSessionResponse,
  type PromptResponse,
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
  type ReadTextFileRequest,
  type ReadTextFileResponse,
} from '@agentclientprotocol/sdk';
import { killProcessTree } from '../../util/kill-process-tree.js';
import { filterAcpJsonLines } from './acp-json-filter.js';
import { acpPlanEntriesToInput } from './acp-plan.js';
import {
  SESSION_CONTROL_METADATA_COMMAND_FIELD,
  isSessionControlCommandText,
} from '../../../shared/session-control-commands.js';
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
  ApprovalRequest,
  ProviderCompactCapability,
  ProviderDelegationNotification,
  RemoteSessionInfo,
  RemoteSessionListOptions,
} from '../transport-provider.js';
import {
  BACKGROUND_SUBAGENT_WAKE_MODES,
  CONNECTION_MODES,
  normalizeProviderPayload,
  SESSION_OWNERSHIP,
  PROVIDER_ERROR_CODES,
} from '../transport-provider.js';
import {
  AGENT_DELEGATION_NOTIFICATION_RESULTS,
  type AgentDelegationNotificationResult,
} from '../../../shared/agent-delegation.js';
import type { AgentMessage, MessageDelta } from '../../../shared/agent-message.js';
import type { ProviderContextPayload } from '../../../shared/context-types.js';
import type { TransportAttachment } from '../../../shared/transport-attachments.js';
import { MEMORY_MCP_STATUS, type MemoryMcpProviderStatusView } from '../../../shared/memory-ws.js';
import logger from '../../util/logger.js';
import type { TransportEffortLevel } from '../../../shared/effort-levels.js';
import type { ProviderActiveWorkSnapshot } from '../../../shared/session-activity-types.js';
import { composeMessageSideProviderPrompt, getProviderSystemTextParts } from '../provider-context-routing.js';
import { sessionSystemContractKey, shouldInjectSessionSystemContract } from '../session-system-contract.js';
import {
  canonicalizeTransportCwd,
  normalizeTransportCwd,
  resolveExecutableForSpawn,
} from '../transport-paths.js';
import { getDefaultAcpMcpServers } from './getDefaultMcpServers.js';
import {
  buildGenericRuntimeSubagentTool,
  isSdkRuntimeSubagentEventName,
  parseSdkRuntimeSubagentTag,
  startsWithSdkRuntimeSubagentTag,
  type SdkSubagentProvider,
  type SdkSubagentProviderKind,
} from '../../../shared/sdk-subagent-status.js';
import { NATIVE_AGENT_ADMISSION_MODES } from '../../../shared/native-collaboration-policy.js';

import { SESSION_MODEL_APPLIED, SESSION_MODEL_APPLY_TIMEOUT_MS, type SessionModelApplied } from '../../../shared/session-model-control.js';
import { withTimeoutOutcome } from '../../util/timeout-outcome.js';

const KIMI_BIN = 'kimi';
/** Kimi ACP currently advertises one mode named `default`. */
const KIMI_DEFAULT_MODE = 'default';

function stableAcpMessageId(notificationId: string): string {
  const hex = createHash('sha256')
    .update('imcodes-acp-active-prompt\0')
    .update(notificationId)
    .digest('hex')
    .slice(0, 32)
    .split('');
  // Canonical deterministic UUIDv5 shape. The input remains private to the
  // local daemon; only this non-secret correlation id crosses ACP.
  hex[12] = '5';
  hex[16] = ((Number.parseInt(hex[16] ?? '0', 16) & 0x3) | 0x8).toString(16);
  const compact = hex.join('');
  return `${compact.slice(0, 8)}-${compact.slice(8, 12)}-${compact.slice(12, 16)}-${compact.slice(16, 20)}-${compact.slice(20)}`;
}

export interface AcpCliProviderProfile {
  id: string;
  displayName: string;
  binary: string;
  args: string[];
  defaultMode?: string;
  compact: ProviderCompactCapability;
  approval: 'auto-allow' | 'bridge';
  loadFailure: 'fresh' | 'error';
  probeOnConnect?: boolean;
  privacySafeErrors?: boolean;
  /** How listModels discovers a catalogue before the first real session.
   *  Most ACP agents can safely create and close a probe session. Agents such
   *  as Hermes persist session/new but do not implement session/close, so
   *  their catalogue must come only from real session metadata. */
  modelDiscovery?: 'session-probe' | 'session-metadata-only';
  /** Forward daemon-local attachments as ACP resource links. This is opt-in
   *  because an ACP agent must explicitly support reading local file URIs. */
  resourceLinkAttachments?: boolean;
  /** Prefix applied to verified active-turn ACP prompts. Some agents expose a
   *  provider-native steering command rather than treating a second prompt as
   *  an implicit queue entry. Omitted for agents whose busy-prompt contract
   *  accepts the text directly. */
  activePromptPrefix?: `/${string} `;
  /** Another prompt steers the SAME run. Superseded RPC replies are not turns. */
  steeringPrompts?: boolean;
  /** Prefer session/resume (no history replay) over session/load. */
  resumeWithoutReplay?: boolean;
  /** Defer model selection until idle, and fail rather than run a wrong model. */
  strictModelSelection?: boolean;
  runtimeSubagent?: {
    provider: SdkSubagentProvider;
    providerKind: SdkSubagentProviderKind;
    action: string;
  };
}

const KIMI_PROFILE: AcpCliProviderProfile = {
  id: 'kimi-sdk',
  displayName: 'Kimi',
  binary: KIMI_BIN,
  args: ['acp'],
  defaultMode: KIMI_DEFAULT_MODE,
  approval: 'auto-allow',
  loadFailure: 'fresh',
  compact: {
    execution: 'slash-command',
    providerCommand: '/compact',
    verified: true,
    completion: 'command-result',
    cancellation: 'provider-cancel',
    reason: 'Verified from MoonshotAI/kimi-cli source: `kimi acp` exposes the soul slash command registry, including /compact.',
    // Clears its injected-system-text marker on every compaction (refreshSessionSystemText), so the next turn re-sends it.
    reassertsSessionSystemText: true,
  },
};

interface KimiSdkSessionState {
  routeId: string;
  sessionName?: string;
  projectName?: string;
  serverId?: string;
  cwd: string;
  env?: Record<string, string>;
  contextNamespace?: SessionConfig['contextNamespace'];
  model?: string;
  confirmedModel?: string;
  modelRevision: number;
  modelControlIntent?: { previous?: string };
  modelApplyTail?: Promise<void>;
  modelApplyRequest?: { model: string; revision: number; promise: Promise<void> };
  /** Model captured by the current native executor; steering keeps this turn. */
  turnModel?: string;
  beforeNativeSessionStart?: SessionConfig['beforeNativeSessionStart'];
  /** Highest steering RPC's terminal wins even if replies arrive out of order. */
  steeringTerminal?: { generation: number; stopReason: StopReason };
  steeringFailure?: unknown;
  steeringUsage?: Record<string, number>;
  /** ACP-level session identifier returned by `newSession` or supplied for
   *  resume. Undefined until the first send actually creates/loads a session. */
  acpSessionId?: string;
  /** True once newSession or loadSession has returned successfully. */
  loaded: boolean;
  /** True once setSessionMode(default) has been accepted for this session. */
  modeApplied: boolean;
  /** Set while a `prompt` RPC is in flight. */
  promptInFlight: boolean;
  /** Generation whose original prompt RPC has actually been submitted. */
  promptSubmittedGeneration: number | null;
  /** Stable-id admission authority for verified busy prompts. Pending entries
   *  survive the original turn settling so a timed-out caller cannot replay a
   *  write that is still capable of reaching ACP. Delivered entries are kept
   *  as bounded tombstones for durable retry idempotency. */
  activePromptAdmissions: Map<string, ActivePromptAdmission>;
  /** Monotonic local turn generation used to suppress duplicate terminals. */
  turnGeneration: number;
  /** Most recent generation that emitted a terminal completion/error. */
  settledGeneration: number;
  /** Active and queued prompt generations currently in flight on the ACP session. */
  activePromptGenerations?: Set<number>;
  /** Generation allocated for an autonomous provider-initiated wakeup turn. */
  autonomousTurnGeneration?: number;
  /** True after user cancel or turn failure until the next send(). */
  stoppedByCancel?: boolean;
  /** Set while `loadSession` is actively streaming history replay updates.
   *  During this window we drop `agent_message_chunk` / `tool_call` events so
   *  prior-turn content doesn't leak into the current turn's delta stream. */
  replaying: boolean;
  /** Set when the client called cancel(); used to rewrite the turn terminal
   *  condition so stopReason='cancelled' surfaces as a PROVIDER cancel. */
  cancelled: boolean;
  currentMessageId: string | null;
  currentText: string;
  /** Map<toolCallId, accumulated ToolCall state> so ToolCallUpdate can merge
   *  onto the original ToolCall (ACP spec: each update is a partial merge). */
  toolCalls: Map<string, MergedToolCall>;
  /** Track last emitted signature per tool to deduplicate identical updates. */
  emittedToolSignatures: Map<string, string>;
  lastStatusSignature: string | null;
  /** Stable IM.codes context already injected into this ACP history. */
  sessionSystemTextInjected?: string;
  /** Most recent ACP `usage_update.tokens` for this session — captured here so
   *  the onComplete `metadata.usage` can carry per-turn token counts to the
   *  daemon's transport-relay. */
  lastTurnUsage?: Record<string, unknown>;
  agyContextUsage?: AgyContextUsage;
  agyCompactionWatermark?: AgyCompactionWatermark;
  agySubagents?: AgySubagentTracker;
  agyBridges?: Map<string, AgyTranscriptBridge>;
  agyPendingLaunches?: string[];
  agyReactive?: boolean;
  agySuppressBridgeResponses?: boolean;
}

interface ActivePromptAdmission {
  promise: Promise<AgentDelegationNotificationResult>;
  status: 'pending' | 'delivered';
}

const MAX_ACTIVE_PROMPT_ADMISSION_TOMBSTONES = 512;

interface MergedToolCall {
  toolCallId: string;
  title: string;
  kind?: string;
  status: string;
  content: ToolCallContent[];
  rawInput?: unknown;
  rawOutput?: unknown;
}

export class KimiSdkProvider implements TransportProvider {
  readonly id: string;
  readonly connectionMode = CONNECTION_MODES.LOCAL_SDK;
  readonly sessionOwnership = SESSION_OWNERSHIP.SHARED;
  readonly capabilities: ProviderCapabilities;

  protected readonly profile: AcpCliProviderProfile;

  private config: ProviderConfig | null = null;
  private sessions = new Map<string, KimiSdkSessionState>();
  /** Reverse lookup so `sessionUpdate` notifications can find the right state
   *  by ACP sessionId (which we only learn after newSession/loadSession). */
  private acpToRoute = new Map<string, string>();
  private acpRouteOrder = new Map<string, string[]>();
  private deltaCallbacks: Array<(sessionId: string, delta: MessageDelta) => void> = [];
  private completeCallbacks: Array<(sessionId: string, message: AgentMessage) => void> = [];
  private errorCallbacks: Array<(sessionId: string, error: ProviderError) => void> = [];
  private toolCallCallbacks: Array<(sessionId: string, tool: ToolCallEvent) => void> = [];
  private sessionInfoCallbacks: Array<(sessionId: string, info: SessionInfoUpdate) => void> = [];
  private statusCallbacks: Array<(sessionId: string, status: ProviderStatusUpdate) => void> = [];
  private usageCallbacks = new Set<(sessionId: string, usage: ProviderUsageUpdate) => void>();
  private approvalCallbacks: Array<(sessionId: string, request: ApprovalRequest) => void> = [];
  private pendingApprovals = new Map<string, {
    routeId: string;
    options: RequestPermissionRequest['options'];
    resolve: (response: RequestPermissionResponse) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();

  private child: ChildProcessWithoutNullStreams | null = null;
  protected connection: ClientSideConnection | null = null;
  /** Resolves once `initialize` has completed so subsequent RPCs can proceed. */
  private initPromise: Promise<void> | null = null;
  /** Models returned by the first ACP `newSession` call, cached for the
   *  lifetime of this provider connection. Populated on first session create. */
  private cachedModels: Array<{ id: string; name?: string }> | null = null;
  private cachedDefaultModel: string | null = null;
  /** Negotiated ACP support for durable `session/list` discovery. */
  private sessionListSupported = false;
  private isDisconnecting = false;

  constructor(profile: AcpCliProviderProfile = KIMI_PROFILE) {
    this.profile = profile;
    this.id = profile.id;
    this.capabilities = {
      streaming: true,
      toolCalling: true,
      approval: profile.approval === 'bridge',
      sessionRestore: true,
      multiTurn: true,
      attachments: profile.resourceLinkAttachments === true,
      reasoningEffort: false,
      contextSupport: 'degraded-message-side-context-mapping',
      backgroundSubagentWake: profile.id === AGY_SDK_PROVIDER_ID ? BACKGROUND_SUBAGENT_WAKE_MODES.NATIVE : profile.runtimeSubagent
        ? BACKGROUND_SUBAGENT_WAKE_MODES.RUNTIME
        : BACKGROUND_SUBAGENT_WAKE_MODES.UNSUPPORTED,
      // ACP exposes no per-call veto and no per-session disable for the
      // agent's native sub-agents (Kimi, Hermes, Grok, CodeBuddy): these
      // runtimes cannot send or receive supervised work.
      nativeAgentAdmission: NATIVE_AGENT_ADMISSION_MODES.UNENFORCEABLE,
      compact: profile.compact,
    };
  }

  getCachedModels(): ProviderModelList | null {
    return this.cachedModels?.length ? {
      models: this.cachedModels,
      ...(this.cachedDefaultModel ? { defaultModel: this.cachedDefaultModel } : {}),
      isAuthenticated: true,
    } : null;
  }

  async connect(config: ProviderConfig): Promise<void> {
    await this.startAcpServer(config);
    this.config = config;
    logger.info({ provider: this.id }, `${this.profile.displayName} SDK provider connected via ACP`);
  }

  getMemoryMcpStatus(): MemoryMcpProviderStatusView {
    return {
      providerId: this.id,
      status: this.config && this.connection ? MEMORY_MCP_STATUS.READY : MEMORY_MCP_STATUS.UNKNOWN,
      connected: Boolean(this.config && this.connection),
      degradedReasons: [],
    };
  }

  getSessionDiagnostics(sessionId: string): Record<string, unknown> | null {
    const state = this.sessions.get(sessionId);
    if (!state) return null;
    const activeReason = state.promptInFlight
      ? 'prompt'
      : state.replaying
        ? 'history-replay'
        : null;
    return {
      provider: this.id,
      routeId: state.routeId,
      active: activeReason !== null,
      activeReason,
      acpSessionId: state.acpSessionId ?? null,
      loaded: state.loaded,
      modeApplied: state.modeApplied,
      promptInFlight: state.promptInFlight,
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

  getActiveWorkSnapshot(sessionId: string): ProviderActiveWorkSnapshot | null {
    const state = this.sessions.get(sessionId);
    if (!state) return null;
    const pendingApprovalCount = [...this.pendingApprovals.values()]
      .filter((approval) => approval.routeId === sessionId).length;
    const activeToolCount = [...state.toolCalls.values()]
      .filter((tool) => tool.status === 'pending' || tool.status === 'in_progress').length;
    const activeWorkCount = Number(state.promptInFlight) + Number(state.replaying) + pendingApprovalCount;
    const busyReasons: ProviderActiveWorkSnapshot['busyReasons'] = [];
    if (state.promptInFlight || pendingApprovalCount > 0) busyReasons.push('provider_wait');
    if (state.replaying) busyReasons.push('provider_session_binding');
    if (activeToolCount > 0) busyReasons.push('open_tool_call');
    return {
      status: 'current',
      activeWorkCount,
      activeToolCount,
      busyReasons,
      providerDiagnosticGeneration: state.acpSessionId ?? null,
      updatedAt: Date.now(),
    };
  }

  async disconnect(): Promise<void> {
    this.isDisconnecting = true;
    try {
      this.cancelPendingApprovals();
      await this.teardownChild();
      this.acpToRoute.clear();
      this.acpRouteOrder.clear();
      for (const state of this.sessions.values()) this.closeAgyBridges(state);
      this.sessions.clear();
      this.config = null;
      this.initPromise = null;
      this.cachedModels = null;
      this.cachedDefaultModel = null;
      this.sessionListSupported = false;
    } finally {
      this.isDisconnecting = false;
    }
  }

  async createSession(config: SessionConfig): Promise<string> {
    const routeId = config.bindExistingKey ?? config.sessionKey;
    const prior = this.sessions.get(routeId);
    if (prior) this.closeAgyBridges(prior);
    const existing = config.fresh ? undefined : prior;
    const state: KimiSdkSessionState = {
      routeId,
      sessionName: config.sessionName ?? existing?.sessionName,
      projectName: config.projectName ?? existing?.projectName,
      serverId: config.serverId ?? existing?.serverId,
      cwd: normalizeTransportCwd(config.cwd) ?? existing?.cwd ?? normalizeTransportCwd(process.cwd())!,
      env: config.env ?? existing?.env,
      contextNamespace: config.contextNamespace ?? existing?.contextNamespace,
      model: typeof config.agentId === 'string' ? config.agentId : existing?.model,
      confirmedModel: existing?.confirmedModel,
      modelRevision: 0,
      beforeNativeSessionStart: config.beforeNativeSessionStart ?? existing?.beforeNativeSessionStart,
      acpSessionId: config.resumeId ?? existing?.acpSessionId,
      loaded: false,
      modeApplied: false,
      promptInFlight: false,
      promptSubmittedGeneration: null,
      activePromptAdmissions: existing?.activePromptAdmissions ?? new Map(),
      turnGeneration: existing?.turnGeneration ?? 0,
      settledGeneration: existing?.settledGeneration ?? 0,
      // A new initializer is a new authority even for the same route. Do not
      // inherit the old owner's unresolved RPC generations into its successor.
      activePromptGenerations: this.profile.steeringPrompts ? new Set() : existing?.activePromptGenerations ?? new Set(),
      replaying: false,
      cancelled: false,
      currentMessageId: null,
      currentText: '',
      toolCalls: new Map(),
      emittedToolSignatures: new Map(),
      lastStatusSignature: null,
      sessionSystemTextInjected: existing?.sessionSystemTextInjected,
    };
    if (prior?.acpSessionId && prior.acpSessionId !== state.acpSessionId) {
      this.releaseAcpRoute(prior.acpSessionId, routeId);
    }
    this.sessions.set(routeId, state);
    if (state.acpSessionId) {
      this.registerAcpRoute(state.acpSessionId, routeId);
      this.emitSessionInfo(routeId, { resumeId: state.acpSessionId });
    }
    return routeId;
  }

  async endSession(sessionId: string): Promise<void> {
    const state = this.sessions.get(sessionId);
    if (!state) return;
    this.cancelPendingApprovals(sessionId);
    this.closeAgyBridges(state);
    this.sessions.delete(state.routeId);
    const removedSoleAcpRoute = state.acpSessionId
      ? this.releaseAcpRoute(state.acpSessionId, state.routeId)
      : false;
    // ACP has a session/close RPC (optional capability). We call it best-effort
    // so the agent can free state; if it fails, the session is still gone on
    // our side. closeSession is optional on the Agent interface so we have to
    // feature-detect.
    if (state.acpSessionId && state.loaded && this.connection && removedSoleAcpRoute) {
      const closer = (this.connection as AcpAgent).closeSession;
      if (typeof closer === 'function') {
        await closer.call(this.connection, { sessionId: state.acpSessionId }).catch(() => {});
      }
    }
  }

  async detachSession(sessionId: string): Promise<void> {
    const state = this.sessions.get(sessionId);
    if (!state) return;
    this.cancelPendingApprovals(sessionId);
    this.closeAgyBridges(state);
    this.sessions.delete(state.routeId);
    if (state.acpSessionId) this.releaseAcpRoute(state.acpSessionId, state.routeId);
  }

  async restoreSession(sessionId: string): Promise<boolean> {
    const state = this.sessions.get(sessionId)
      ?? [...this.sessions.values()].find((candidate) => candidate.acpSessionId === sessionId);
    if (!state) return false;
    if (state.loaded) return true;
    try {
      await this.ensureSessionReady(state.routeId, state);
      if (this.profile.strictModelSelection && !state.promptInFlight && state.confirmedModel) {
        this.emitSessionInfo(state.routeId, { model: state.confirmedModel });
      }
      return true;
    } catch {
      return false;
    }
  }

  async listSessions(options: RemoteSessionListOptions = {}): Promise<RemoteSessionInfo[]> {
    const directoryRequested = options.directory !== undefined;
    const queryDirectory = normalizeTransportCwd(options.directory);
    const expectedDirectory = canonicalizeTransportCwd(options.directory);
    if (
      (directoryRequested && (!queryDirectory || !expectedDirectory))
      || !this.connection
      || !this.sessionListSupported
    ) {
      return [];
    }

    const sessions: RemoteSessionInfo[] = [];
    const seenCursors = new Set<string>();
    let cursor: string | undefined;
    do {
      const result = await this.connection.listSessions({
        ...(queryDirectory ? { cwd: queryDirectory } : {}),
        ...(cursor ? { cursor } : {}),
      });
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
      const nextCursor = typeof result.nextCursor === 'string' && result.nextCursor
        ? result.nextCursor
        : undefined;
      if (!nextCursor || seenCursors.has(nextCursor)) break;
      seenCursors.add(nextCursor);
      cursor = nextCursor;
    } while (cursor);
    return sessions;
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

  private closeAgyBridges(state: KimiSdkSessionState): void {
    for (const bridge of state.agyBridges?.values() ?? []) bridge.close();
    state.agyBridges?.clear(); state.agyReactive = false;
  }

  private async startAgyBridge(sessionId: string, state: KimiSdkSessionState, childId?: string): Promise<void> {
    if (this.id !== AGY_SDK_PROVIDER_ID || !state.acpSessionId) return;
    const id = childId ?? state.acpSessionId;
    const bridges = state.agyBridges ??= new Map();
    if (bridges.has(id)) return;
    const env = { ...process.env, ...(this.config?.env as Record<string,string> | undefined), ...state.env };
    const file = agyTranscriptFile(env.HOME || env.USERPROFILE || '', id);
    if (!file) return;
    const bridge = new AgyTranscriptBridge(file, row => {
      if (this.sessions.get(sessionId) !== state || state.cancelled || state.stoppedByCancel) return;
      this.handleAgyTranscriptRow(sessionId, state, id, row);
    });
    bridges.set(id, bridge);
    await bridge.start(!!childId);
    if (this.sessions.get(sessionId) !== state || state.cancelled) bridge.close();
  }

  private handleAgyTranscriptRow(sessionId: string, state: KimiSdkSessionState, nativeId: string, row: AgyTranscriptRow): void {
    const tracker = state.agySubagents ??= new AgySubagentTracker(state.acpSessionId ?? sessionId);
    const publish = (events: ToolCallEvent[]) => { for (const event of events) for (const cb of this.toolCallCallbacks) cb(sessionId, event); };
    if (nativeId !== state.acpSessionId) {
      if (row.type === 'PLANNER_RESPONSE' && row.content?.trim() && !row.tool_calls?.length) {
        publish(tracker.snapshot({conversationId:nativeId,status:'completed',stateDetail:row.content}, 'native_completion'));
        state.agyBridges?.get(nativeId)?.close(); state.agyBridges?.delete(nativeId);
      }
      return;
    }
    if (row.type === 'GENERIC' && row.content?.includes('Created the following subagent:')) {
      // Real AG ACP omits rawOutput; this native tool-result supplies the id.
      for (const match of row.content.matchAll(/\{[^{}]*"conversationId"[^{}]*\}/g)) {
        try {
          const child = JSON.parse(match[0]) as {conversationId?:string};
          if (!child.conversationId || !agyTranscriptFile('/scoped',child.conversationId)) continue;
          const toolId = state.agyPendingLaunches?.shift();
          if (!toolId) continue; // Never replay another launch/history as ours.
          publish(tracker.snapshot({...child,status:'running'}, 'native_launch', toolId));
          void this.startAgyBridge(sessionId,state,child.conversationId);
        } catch { /* not a native child creation result */ }
      }
    }
    if (row.type === 'SYSTEM_MESSAGE' && /\[Message\].*sender=/.test(row.content ?? '')) state.agyReactive = true;
    if (row.type !== 'PLANNER_RESPONSE' || !row.content?.trim() || row.tool_calls?.length || !state.agyReactive) return;
    state.agyReactive = false;
    // Native stdout already owns an active turn. Its boundary flush above
    // consumes these same steps without replaying a second completion.
    if (state.promptInFlight || state.agySuppressBridgeResponses) return;
    this.startAutonomousTurn(sessionId,state);
    const generation = state.autonomousTurnGeneration!;
    state.currentMessageId = `${nativeId}:step:${row.step_index}`; state.currentText = row.content;
    state.lastTurnUsage = {input_tokens:row.input_tokens,output_tokens:row.output_tokens,cache_read_input_tokens:row.cache_read_tokens};
    this.emitStatus(sessionId,state,{status:'streaming',label:null});
    for (const cb of this.deltaCallbacks) cb(sessionId,{messageId:state.currentMessageId,type:'text',delta:row.content,role:'assistant'});
    (state.activePromptGenerations ??= new Set()).add(generation);
    this.settleTurn(sessionId,state,generation,'end_turn');
  }

  async checkSessionCompaction(sessionId: string): Promise<boolean> {
    if (this.id !== AGY_SDK_PROVIDER_ID) return false;
    const state = this.sessions.get(sessionId);
    if (!state || !state.acpSessionId) return false;
    const env = { ...process.env, ...(this.config?.env as Record<string, string> | undefined), ...state.env };
    const watermark = state.agyCompactionWatermark ??= new AgyCompactionWatermark();
    const changed = await watermark.check(env.HOME || env.USERPROFILE, state.acpSessionId);
    if (this.sessions.get(sessionId) !== state || state.cancelled) return false;
    if (changed) {
      state.sessionSystemTextInjected = undefined;
      (state.agyContextUsage ??= new AgyContextUsage()).resetToSummary(watermark.summaryTokens);
    }
    return changed;
  }

  onUsage(cb: (sessionId: string, usage: ProviderUsageUpdate) => void): () => void {
    this.usageCallbacks.add(cb);
    return () => { this.usageCallbacks.delete(cb); };
  }

  private emitAgyUsage(sessionId: string, state: KimiSdkSessionState, raw: Record<string, unknown> = {}, finalized = false): void {
    if (this.id !== AGY_SDK_PROVIDER_ID) return;
    const usage = (state.agyContextUsage ??= new AgyContextUsage()).normalize(raw);
    for (const cb of this.usageCallbacks) cb(sessionId, {
      messageId: state.currentMessageId ?? undefined, finalized, usage,
      model: this.profile.strictModelSelection ? (state.turnModel ?? state.confirmedModel) : state.model,
    });
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

  setSessionAgentId(sessionId: string, agentId: string): void {
    const state = this.sessions.get(sessionId);
    if (!state) return;
    if (state.model !== agentId) { state.model = agentId; state.modelRevision++; state.modelControlIntent = undefined; }
    if (this.profile.strictModelSelection) return;
    // If session already loaded, best-effort push the model change via the
    // experimental RPC. Swallow errors: if the CLI version predates it,
    // subsequent prompts still use the original model — still correct, just
    // not the requested one.
    if (state.acpSessionId && state.loaded && this.connection) {
      const setter = (this.connection as AcpAgent).unstable_setSessionModel;
      if (typeof setter === 'function') {
        void setter.call(this.connection, {
          sessionId: state.acpSessionId,
          modelId: agentId,
        }).catch((err: unknown) => {
          logger.debug({
            provider: this.id,
            agentId,
            ...this.errorLogFields(err, 'err'),
          }, 'unstable_setSessionModel failed (non-fatal)');
        });
      }
    }
  }

  /** Only AG exposes this confirmed selection contract. Other ACP profiles
   * retain their existing best-effort setSessionAgentId behavior. */
  protected async applyStrictSessionModel(sessionId: string, model: string): Promise<SessionModelApplied> {
    const state = this.sessions.get(sessionId);
    if (!state) throw this.makeError(PROVIDER_ERROR_CODES.SESSION_NOT_FOUND, 'ACP model session not found', false);
    const previous = state.modelControlIntent ? state.modelControlIntent.previous : state.model;
    this.setSessionAgentId(sessionId, model);
    if (!state.loaded || !state.acpSessionId || !this.connection || state.cancelled) return SESSION_MODEL_APPLIED.NEXT_START;
    const intent = { previous };
    state.modelControlIntent = intent;
    try {
      await this.confirmStrictSessionModel(sessionId, state);
      // Native AG updates its session selection immediately, but an existing
      // executor keeps its captured model until the next ordinary turn.
      const pending = state.promptInFlight && state.turnModel !== model;
      if (!pending) this.emitSessionInfo(sessionId, { model });
      return pending ? SESSION_MODEL_APPLIED.NEXT_START : SESSION_MODEL_APPLIED.LIVE;
    } catch (error) {
      if (this.sessions.get(sessionId) === state && state.modelControlIntent === intent) {
        state.model = previous;
        state.modelRevision++;
        // Explicit RPC rejection retains the last confirmed model. A timeout
        // has already invalidated it below: that uncertain write needs a
        // reconfirmation before another prompt.
      }
      throw this.normalizeError(error);
    } finally {
      if (state.modelControlIntent === intent) state.modelControlIntent = undefined;
    }
  }

  private async confirmStrictSessionModel(sessionId: string, state: KimiSdkSessionState): Promise<void> {
    const model = state.model;
    if (!model) return;
    const revision = state.modelRevision;
    const connection = this.connection;
    const nativeId = state.acpSessionId;
    const assertOwner = () => {
      this.assertCurrentSession(sessionId, state, connection);
      if (state.acpSessionId !== nativeId || state.modelRevision !== revision || state.model !== model) {
        throw this.makeError(PROVIDER_ERROR_CODES.CANCELLED, 'ACP model selection superseded', true);
      }
    };
    assertOwner();
    let request = state.modelApplyRequest;
    if (!request || request.revision !== revision || request.model !== model) {
      // Order native writes, not merely their callbacks. A late B ACK must not
      // run after/publish over C; obsolete queued operations retire unwritten.
      const promise = (state.modelApplyTail ?? Promise.resolve()).catch(() => {}).then(async () => {
        assertOwner();
        if (state.confirmedModel !== model) {
          const setter = connection?.unstable_setSessionModel;
          if (!setter || !nativeId) throw this.makeError(PROVIDER_ERROR_CODES.CONFIG_ERROR, 'ACP model selection unsupported', false);
          try {
            await setter.call(connection, { sessionId: nativeId, modelId: model });
          } catch (error) {
            // Report only our own bounded model guidance, never raw ACP diagnostics.
            if (error instanceof RequestError && /unknown model|unsupported model|model.*not supported/i.test(error.message)) {
              throw this.makeError(PROVIDER_ERROR_CODES.CONFIG_ERROR,
                `Selected ${this.profile.displayName} model is unavailable; choose a supported model and retry.`, false);
            }
            throw error;
          }
          // Even a superseded successful RPC changed native state. Invalidate
          // the old cached model before the intent check (A→B→A must reapply A).
          if (this.sessions.get(sessionId) === state && this.connection === connection && state.acpSessionId === nativeId) {
            state.confirmedModel = undefined;
          }
          assertOwner();
          state.confirmedModel = model;
          state.sessionSystemTextInjected = undefined;
        }
      });
      request = { model, revision, promise };
      state.modelApplyRequest = request;
      state.modelApplyTail = promise.catch(() => {});
    }
    let outcome;
    try {
      outcome = await withTimeoutOutcome(request.promise, SESSION_MODEL_APPLY_TIMEOUT_MS);
    } catch (error) {
      // Share an in-flight confirmation, not a permanently rejected Promise.
      // A transient first-turn RPC failure must permit the same model to retry.
      if (state.modelApplyRequest === request) state.modelApplyRequest = undefined;
      throw error;
    }
    if (outcome.timedOut) {
      if (state.modelRevision === revision) { state.modelRevision++; state.confirmedModel = undefined; }
      throw this.makeError(PROVIDER_ERROR_CODES.PROVIDER_ERROR, 'ACP model selection was not confirmed before its deadline', true);
    }
    assertOwner();
  }

  refreshSessionSystemText(sessionId: string): void {
    const state = this.sessions.get(sessionId);
    if (!state) return;
    state.sessionSystemTextInjected = undefined;
  }

  async send(
    sessionId: string,
    payloadOrMessage: string | ProviderContextPayload,
    attachments?: TransportAttachment[],
    extraSystemPrompt?: string,
  ): Promise<void> {
    if (!this.config || !this.connection) {
      throw this.makeError(PROVIDER_ERROR_CODES.CONNECTION_LOST, `${this.profile.displayName} ACP server not connected`, false);
    }
    const state = this.sessions.get(sessionId);
    if (!state) {
      throw this.makeError(PROVIDER_ERROR_CODES.SESSION_NOT_FOUND, `Unknown ${this.profile.displayName} SDK session: ${sessionId}`, false);
    }
    if (state.promptInFlight) {
      throw this.makeError(PROVIDER_ERROR_CODES.PROVIDER_ERROR, `${this.profile.displayName} SDK session is already busy`, true);
    }

    state.cancelled = false;
    state.stoppedByCancel = false;
    state.autonomousTurnGeneration = undefined;
    state.steeringUsage = undefined;
    state.lastTurnUsage = undefined;
    // NOTE: currentText/currentMessageId are cleared AFTER ensureSessionReady
    // inside startTurn — not here. `loadSession` replays the full conversation
    // history as `agent_message_chunk` notifications, and if we cleared before
    // resume those replay chunks would accumulate into currentText and be
    // re-emitted as the new turn's content.
    state.toolCalls.clear();
    state.emittedToolSignatures.clear();
    state.lastStatusSignature = null;

    const payload = normalizeProviderPayload(payloadOrMessage, attachments, extraSystemPrompt);
    // TransportProvider.send is a send-start/admission contract: resolve only
    // after the original ACP prompt RPC has actually been invoked, but never
    // wait for that long-lived RPC to finish the whole model turn.  The runtime
    // uses this boundary to guarantee B/C cannot overtake A.
    const generation = ++state.turnGeneration;
    await this.startTurn(sessionId, state, payload, generation);
  }

  private readonly promptTerminals = new WeakMap<KimiSdkSessionState, Promise<unknown>>();
  // A steering RPC can retire before the native run ends (or reject while A
  // keeps running). Stop proof belongs to the captured aggregate, not that RPC.
  private readonly steeringRunTerminals = new WeakMap<KimiSdkSessionState, {
    terminal: Promise<void>; complete: () => void;
  }>();

  cancelAndWait(sessionId: string): Promise<void> {
    const state = this.sessions.get(sessionId);
    const run = state && this.steeringRunTerminals.get(state);
    if (this.profile.steeringPrompts && state && run) {
      const isCurrent = () => this.sessions.get(sessionId) === state && this.steeringRunTerminals.get(state) === run;
      return confirmPromiseStop(run, run.terminal, () => {
        if (!isCurrent()) return Promise.reject(new Error('ACP session owner changed during Stop'));
        return this.cancel(sessionId);
      }, isCurrent);
    }
    const terminal = state && this.promptTerminals.get(state);
    if (!state || !terminal) return Promise.reject(new Error('ACP prompt terminal unavailable'));
    const generation = state.turnGeneration;
    return confirmPromiseStop(terminal, terminal, () => this.cancel(sessionId),
      () => this.sessions.get(sessionId) === state && state.turnGeneration === generation);
  }

  async cancel(sessionId: string): Promise<void> {
    const state = this.sessions.get(sessionId);
    if (!state) return;
    if (state.modelControlIntent) {
      state.model = state.modelControlIntent.previous;
      state.confirmedModel = undefined;
      state.modelControlIntent = undefined;
    }
    state.modelRevision++;
    state.stoppedByCancel = true;
    this.closeAgyBridges(state);
    if (!state.promptInFlight) return;
    state.cancelled = true;
    if (!state.acpSessionId || !this.connection) return;
    this.cancelPendingApprovals(sessionId);
    // `cancel` is a one-shot notification; the pending prompt() Promise or
    // autonomous `turn_completed` terminal will settle the captured run when
    // native work actually stops. Never fabricate physical stop proof locally.
    await this.connection.cancel({ sessionId: state.acpSessionId }).catch((err: unknown) => {
      logger.debug({
        provider: this.id,
        sessionId,
        ...this.errorLogFields(err, 'err'),
      }, 'ACP cancel notification failed (non-fatal)');
    });
  }

  /**
   * Queue text through an ACP agent that explicitly supports receiving another
   * `session/prompt` while its current run is active. Provider profiles may
   * either accept the text directly through a verified busy-session queue or
   * translate it to a native steering command. This never calls
   * `session/cancel` and never starts a competing IM.codes runtime turn.
   *
   * Keep this protected and opt-in. Plain Kimi ACP has not advertised the same
   * contract, so only a provider with verified busy-prompt semantics may expose
   * it as `activeDelegationNotification: native`.
   */
  protected async queueActiveAcpPrompt(
    sessionId: string,
    notification: ProviderDelegationNotification,
  ): Promise<AgentDelegationNotificationResult> {
    const state = this.sessions.get(sessionId);
    if (!state) return AGENT_DELEGATION_NOTIFICATION_RESULTS.STALE;
    const existing = state.activePromptAdmissions.get(notification.notificationId);
    if (existing) return existing.promise;
    if (!state.promptInFlight
      || state.promptSubmittedGeneration === null
      || state.cancelled
      || !state.loaded
      || !state.acpSessionId
      || !this.connection) {
      return AGENT_DELEGATION_NOTIFICATION_RESULTS.STALE;
    }

    const admission = this.deliverActiveAcpPrompt(sessionId, state, notification);
    const tracked: ActivePromptAdmission = { promise: admission, status: 'pending' };
    state.activePromptAdmissions.set(notification.notificationId, tracked);
    try {
      const result = await admission;
      if (result === AGENT_DELEGATION_NOTIFICATION_RESULTS.DELIVERED) {
        tracked.status = 'delivered';
        this.pruneActivePromptAdmissionTombstones(state);
      } else if (state.activePromptAdmissions.get(notification.notificationId) === tracked) {
        state.activePromptAdmissions.delete(notification.notificationId);
      }
      return result;
    } catch (error) {
      if (state.activePromptAdmissions.get(notification.notificationId) === tracked) {
        state.activePromptAdmissions.delete(notification.notificationId);
      }
      logger.debug({
        provider: this.id,
        sessionId,
        ...this.errorLogFields(error),
      }, 'ACP active-turn prompt admission failed');
      return AGENT_DELEGATION_NOTIFICATION_RESULTS.STALE;
    }
  }

  private pruneActivePromptAdmissionTombstones(state: KimiSdkSessionState): void {
    if (state.activePromptAdmissions.size <= MAX_ACTIVE_PROMPT_ADMISSION_TOMBSTONES) return;
    for (const [notificationId, admission] of state.activePromptAdmissions) {
      if (state.activePromptAdmissions.size <= MAX_ACTIVE_PROMPT_ADMISSION_TOMBSTONES) break;
      // Never evict an unresolved write: that would allow the same durable
      // notification to start a second provider admission after a timeout.
      if (admission.status === 'delivered') state.activePromptAdmissions.delete(notificationId);
    }
  }

  private async deliverActiveAcpPrompt(
    sessionId: string,
    state: KimiSdkSessionState,
    notification: ProviderDelegationNotification,
  ): Promise<AgentDelegationNotificationResult> {
    const connection = this.connection;
    if (!connection) return AGENT_DELEGATION_NOTIFICATION_RESULTS.STALE;
    let queuedGeneration: number | undefined;
    try {
      // ACP's response is the queued prompt's *turn completion*, not a short
      // admission ACK.  Calling prompt() submits the request to the live ACP
      // connection; observe its eventual settlement in the background so the
      // runtime can enqueue B then C immediately instead of timing out and
      // replaying already-admitted text through the idle FIFO.
      const activePromptText = this.profile.activePromptPrefix
        ? `${this.profile.activePromptPrefix}${notification.text}`
        : notification.text;
      // Preserve native steering semantics: the runtime supplies current policy
      // for ordinary turns; never synthesize a second provider turn here.
      state.agyContextUsage?.addText(activePromptText);
      const generation = ++state.turnGeneration;
      queuedGeneration = generation;
      (state.activePromptGenerations ??= new Set()).add(generation);
      const queuedPrompt = connection.prompt({
        sessionId: state.acpSessionId,
        prompt: [{ type: 'text', text: activePromptText }],
        // ACP's canonical unstable messageId is the only provider-visible
        // correlation key available for a queued prompt. Derive a valid stable
        // UUID from IM.codes' durable notification id; the generation-scoped
        // admission map handles local retries, while capable ACP agents may use
        // this id to correlate a replay across their own history.
        messageId: stableAcpMessageId(notification.notificationId),
      });
      this.promptTerminals.set(state, queuedPrompt);
      void queuedPrompt.then((result) => {
        if (this.profile.steeringPrompts && !state.activePromptGenerations?.has(generation)) return;
        this.capturePromptUsage(state, result);
        if (result.stopReason === 'cancelled') {
          logger.debug({ provider: this.id, sessionId }, 'ACP active-turn queued prompt later settled as cancelled');
        }
        this.settleTurn(
          sessionId,
          state,
          generation,
          result.stopReason,
        );
      }).catch((error: unknown) => {
        logger.warn({
          provider: this.id,
          sessionId,
          ...this.errorLogFields(error),
        }, 'ACP active-turn queued prompt failed after submission');
        this.failTurn(sessionId, state, generation, error);
      });
      // ClientSideConnection.prompt() resolves at the end of the queued turn,
      // while sendRequest() writes through an internal serialized writeQueue.
      // Wait for that exact write to flush, not for the model turn, before
      // committing the durable IM.codes row. If the writable failed, ACP closes
      // the connection and the abort signal is authoritative.
      const writeOk = await this.waitForAcpWrite(connection, true);
      if (!writeOk) {
        if (this.profile.steeringPrompts) {
          this.failTurn(sessionId, state, generation, this.makeError(
            PROVIDER_ERROR_CODES.CONNECTION_LOST, 'ACP active prompt write failed', true,
          ));
        } else {
          state.activePromptGenerations?.delete(generation);
          if ((state.activePromptGenerations?.size ?? 0) === 0) {
            state.promptInFlight = false;
            state.promptSubmittedGeneration = null;
          }
        }
        return AGENT_DELEGATION_NOTIFICATION_RESULTS.STALE;
      }
      if (this.sessions.get(sessionId) !== state || state.cancelled || this.connection !== connection) {
        // The write is already native-visible: never return STALE and replay it.
        return AGENT_DELEGATION_NOTIFICATION_RESULTS.DELIVERED;
      }
      if (state.promptInFlight) state.promptSubmittedGeneration = generation;
      return AGENT_DELEGATION_NOTIFICATION_RESULTS.DELIVERED;
    } catch (error) {
      if (this.profile.steeringPrompts && queuedGeneration !== undefined) this.failTurn(sessionId, state, queuedGeneration, error);
      logger.debug({
        provider: this.id,
        sessionId,
        ...this.errorLogFields(error),
      }, 'ACP active-turn prompt write failed');
      return AGENT_DELEGATION_NOTIFICATION_RESULTS.STALE;
    }
  }

  private async waitForAcpWrite(connection: ClientSideConnection, requireTracker: boolean): Promise<boolean> {
    const tracker = (connection as unknown as {
      connection?: {
        writeQueue?: Promise<void>;
        abortController?: { signal?: AbortSignal };
      };
    }).connection;
    if (!tracker?.writeQueue) return !requireTracker;
    await tracker.writeQueue;
    return tracker.abortController?.signal?.aborted !== true;
  }

  // ── ACP client-side glue ────────────────────────────────────────────────

  /** Process arguments for the ACP agent. Override to adapt them to `config`. */
  protected buildAcpArgs(_config: ProviderConfig): string[] {
    return [...this.profile.args];
  }

  private async startAcpServer(config: ProviderConfig): Promise<void> {
    await this.teardownChild();

    const resolved = this.resolveAcpExecutable(config);
    const args = [...resolved.prependArgs, ...this.buildAcpArgs(config)];
    const child = spawn(resolved.executable, args, {
      // Own process group and session on POSIX. A reparented descendant keeps
      // its PGID but loses its PPID, so after the agent parent dies this is the
      // only ownership token teardown still has. Without it the eight vitest
      // workers of the incident were unreachable on PPID=1.
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...((config.env as Record<string, string> | undefined) ?? {}) },
      windowsHide: true,
    });
    this.child = child;
    const spawnFailure = new Promise<never>((_resolve, reject) => {
      child.once('error', reject);
    });

    child.stderr.on('data', (chunk: Buffer | string) => {
      const text = chunk.toString().trim();
      if (!text) return;
      // Kimi CLI writes verbose startup noise to stderr. Keep it at debug to
      // avoid polluting normal daemon logs.
      logger.debug({ provider: this.id, stderrBytes: Buffer.byteLength(text) }, `${this.profile.displayName} ACP stderr`);
    });

    child.on('exit', (code, signal) => {
      if (this.isDisconnecting || this.child !== child) return;
      const err = new Error(`${this.profile.displayName} ACP server exited with code=${code} signal=${signal}`);
      this.cancelPendingApprovals();
      const sessions = [...this.sessions.keys()];
      for (const sid of sessions) {
        const state = this.sessions.get(sid);
        if (state) state.sessionSystemTextInjected = undefined;
        if (this.clearSessionWorkAfterFailure(sid)) {
          this.emitError(sid, this.makeError(PROVIDER_ERROR_CODES.CONNECTION_LOST, err.message, true));
        }
      }
      this.child = null;
      this.connection = null;
      this.initPromise = null;
      this.sessionListSupported = false;
    });
    child.on('error', (err) => {
      if (this.isDisconnecting || this.child !== child) return;
      logger.error(
        { provider: this.id, errorCode: (err as NodeJS.ErrnoException).code ?? 'spawn_failed' },
        `${this.profile.displayName} ACP spawn error`,
      );
      this.cancelPendingApprovals();
      const sessions = [...this.sessions.keys()];
      for (const sid of sessions) {
        const state = this.sessions.get(sid);
        if (state) state.sessionSystemTextInjected = undefined;
        if (this.clearSessionWorkAfterFailure(sid)) {
          this.emitError(sid, this.makeError(PROVIDER_ERROR_CODES.CONNECTION_LOST, err.message, true));
        }
      }
      this.child = null;
      this.connection = null;
      this.initPromise = null;
      this.sessionListSupported = false;
    });

    // `ndJsonStream` wants Web streams; convert the Node stdio streams. Filter
    // non-JSON lines out of the agent's stdout first so a chatty CLI can't make
    // the SDK's ndjson reader console.error-spam on every unparseable line.
    const writable = Writable.toWeb(child.stdin) as WritableStream<Uint8Array>;
    const readable = Readable.toWeb(
      filterAcpJsonLines(gateChildStream(child.stdout), (line, n) => {
        if (n === 1 || n % 200 === 0) {
          logger.debug(
            {
              provider: this.id,
              droppedCount: n,
              ...(this.profile.privacySafeErrors ? {} : { sample: line.slice(0, 200) }),
            },
            `${this.profile.displayName} ACP: dropped non-JSON stdout line`,
          );
        }
      }),
    ) as ReadableStream<Uint8Array>;
    const rawStream = ndJsonStream(writable, readable);
    // `@agentclientprotocol/sdk` validates `session/update` against a strict
    // Zod union that rejects non-standard `sessionUpdate` types (`turn_completed`,
    // runtime subagent events) and strips `usage_update.tokens`. Route
    // `session/update` notifications through `extNotification` so custom ACP
    // update payloads reach `handleSessionUpdate` intact.
    const stream = {
      writable: rawStream.writable,
      readable: rawStream.readable.pipeThrough(new TransformStream({
        transform(message, controller) {
          if (message && typeof message === 'object' && !('id' in message) && (message as { method?: unknown }).method === 'session/update') {
            controller.enqueue({ ...(message as Record<string, unknown>), method: '_imcodes/session/update' });
            return;
          }
          controller.enqueue(message);
        },
      })),
    };

    // Construct the ACP connection. The callback receives the Agent handle we
    // can use to call RPC methods; we return a Client impl that handles
    // reverse RPC (requestPermission + session notifications).
    this.connection = new ClientSideConnection(() => this.createClientImpl(child), stream);

    // Kick off initialize once; all subsequent calls await the same promise.
    this.initPromise = (async () => {
      const result = await this.connection!.initialize({
        // Protocol version number. 1 is the current major; the agent tells us
        // what it supports in the response but for now we only talk 1.
        protocolVersion: 1,
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          // `terminal` is a boolean in current ACP schema. Leave off — we don't
          // provide a client-side terminal.
          terminal: false,
        },
      });
      logger.info(
        { provider: this.id, agentInfo: result.agentInfo, caps: result.agentCapabilities },
        `${this.profile.displayName} ACP initialized`,
      );
      this.sessionListSupported = result.agentCapabilities.sessionCapabilities?.list != null;
      await this.validateConnectedAgent(result as unknown as Record<string, unknown>, config);
    })().catch((err: unknown) => {
      logger.error(
        { provider: this.id, errorCode: getPrivacySafeErrorCode(err) },
        `${this.profile.displayName} ACP initialize failed`,
      );
      throw err;
    });

    let initTimer: ReturnType<typeof setTimeout> | undefined;
    const initTimeout = new Promise<never>((_resolve, reject) => {
      initTimer = setTimeout(
        () => reject(new Error(`${this.profile.displayName} ACP initialization timed out`)),
        15_000,
      );
      initTimer.unref?.();
    });
    try {
      await Promise.race([this.initPromise, spawnFailure, initTimeout]);
    } catch (error) {
      await this.teardownChild();
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
        throw this.makeError(
          PROVIDER_ERROR_CODES.CONFIG_ERROR,
          `${this.profile.displayName} CLI is unavailable. Install the official CLI and authenticate before starting a session.`,
          false,
        );
      }
      throw error;
    } finally {
      if (initTimer) clearTimeout(initTimer);
    }
  }

  /** Build the Client impl passed to ClientSideConnection. The SDK invokes
   *  these methods when the agent sends us requests/notifications. */
  private createClientImpl(child?: ChildProcessWithoutNullStreams): AcpClient {
    return {
      requestPermission: async (
        params: RequestPermissionRequest,
      ): Promise<RequestPermissionResponse> => {
        if (child && this.child !== child) return { outcome: { outcome: 'cancelled' } };
        if (this.profile.approval === 'bridge') {
          return this.bridgePermissionRequest(params);
        }
        // Preserve Kimi's existing behavior for compatibility.
        const selected = params.options.find((opt) => opt.optionId === 'approve_for_session')
          ?? params.options.find((opt) => opt.kind === 'allow_always')
          ?? params.options.find((opt) => opt.optionId === 'approve')
          ?? params.options.find((opt) => opt.kind === 'allow_once');
        if (selected) {
          logger.info(
            { provider: this.id, sessionId: params.sessionId, optionId: selected.optionId, toolCall: params.toolCall?.title },
            'Kimi ACP permission auto-approved',
          );
          return { outcome: { outcome: 'selected', optionId: selected.optionId } };
        }
        logger.warn(
          { provider: this.id, sessionId: params.sessionId, toolCall: params.toolCall?.title },
          'Kimi ACP requestPermission had no allow option; cancelling',
        );
        return { outcome: { outcome: 'cancelled' } };
      },
      sessionUpdate: async (params: SessionNotification): Promise<void> => {
        if (!child || this.child === child) this.handleSessionUpdate(params);
      },
      extNotification: async (method: string, _params: Record<string, unknown>): Promise<void> => {
        if (method === '_x.ai/models/update' && _params && typeof _params === 'object') {
          this.cacheModelsFromSessionResponse({ models: _params as any } as NewSessionResponse);
          return;
        }
        if ((method === '_x.ai/session/update' || method === '_imcodes/session/update') && _params && typeof _params === 'object') {
          if (!child || this.child === child) this.handleSessionUpdate(_params as unknown as SessionNotification);
          return;
        }
        // Grok publishes MCP catalog refreshes through an xAI extension. The
        // provider does not need the payload because managed MCP state is
        // already owned by the session configuration, but registering the
        // extension handler prevents spurious JSON-RPC method-not-found noise.
        if (method !== '_x.ai/mcp/servers_updated') {
          logger.debug({ provider: this.id, method }, 'Ignored ACP extension notification');
        }
      },
      // Provide `readTextFile`/`writeTextFile` stubs so that if the agent ever
      // tries to call them despite our caps advertising false, we fail loudly
      // instead of hanging. These throw RequestError so the JSON-RPC layer
      // reports a proper error code to the agent.
      readTextFile: async (_params: ReadTextFileRequest): Promise<ReadTextFileResponse> => {
        throw new RequestError(-32601, 'Method not available — client fs capability disabled');
      },
      writeTextFile: async (_params: WriteTextFileRequest): Promise<WriteTextFileResponse> => {
        throw new RequestError(-32601, 'Method not available — client fs capability disabled');
      },
    };
  }

  // ── Prompt turn orchestration ───────────────────────────────────────────

  private async startTurn(
    sessionId: string,
    state: KimiSdkSessionState,
    payload: ProviderContextPayload,
    generation: number,
  ): Promise<void> {
    if (this.profile.steeringPrompts) {
      let complete!: () => void;
      const terminal = new Promise<void>(resolve => { complete = resolve; });
      this.steeringRunTerminals.set(state, { terminal, complete });
    }
    state.promptInFlight = true;
    state.promptSubmittedGeneration = null;
    (state.activePromptGenerations ??= new Set()).add(generation);
    try {
      await this.ensureSessionReady(sessionId, state);
      this.assertCurrentSession(sessionId, state);
      await this.startAgyBridge(sessionId, state);
      await this.checkSessionCompaction(sessionId);
      this.assertCurrentSession(sessionId, state);
      // Start the turn's delta buffer clean. (During loadSession the replay
      // flag already suppresses accumulation; this belt-and-suspenders reset
      // also catches any stray state left by a prior turn that errored out
      // before settleTurn ran.)
      state.currentText = '';
      state.currentMessageId = null;
      state.turnModel = this.profile.strictModelSelection ? state.confirmedModel : undefined;
      const sessionSystemText = getProviderSystemTextParts(payload).sessionSystemText;
      const sessionContractKey = sessionSystemContractKey(sessionSystemText);
      const includeSessionSystemText = shouldInjectSessionSystemContract(
        state.sessionSystemTextInjected,
        sessionSystemText,
      );
      const compactControl = isSessionControlCommandText(payload.userMessage, 'compact');
      const promptBlocks = this.buildPromptContent(payload, includeSessionSystemText);
      if (this.id === AGY_SDK_PROVIDER_ID) {
        const meter = state.agyContextUsage ??= new AgyContextUsage();
        meter.beginPrompt(composeMessageSideProviderPrompt(payload, { includeSessionSystemText }));
      }

      // Long-lived call — invoking it submits A; its Promise resolves only
      // when the turn ends.  Publish the generation-scoped admission boundary
      // before returning from send(), then settle asynchronously.
      const connection = this.connection!;
      const turn = connection.prompt({
        sessionId: state.acpSessionId!,
        prompt: promptBlocks,
        messageId: randomUUID(),
      });
      this.promptTerminals.set(state, turn);
      void turn.then((result: PromptResponse) => {
        if (this.profile.steeringPrompts && !state.activePromptGenerations?.has(generation)) return;
        this.capturePromptUsage(state, result);
        this.settleTurn(
          sessionId,
          state,
          generation,
          result.stopReason,
          includeSessionSystemText ? sessionContractKey : undefined,
          compactControl,
        );
      }).catch((err: unknown) => {
        this.failTurn(sessionId, state, generation, err);
      });
      if (!await this.waitForAcpWrite(connection, true)) {
        if (!this.profile.steeringPrompts) state.activePromptGenerations?.delete(generation);
        throw this.makeError(
          PROVIDER_ERROR_CODES.CONNECTION_LOST,
          `${this.profile.displayName} ACP prompt write failed`,
          true,
        );
      }
      if (state.turnGeneration === generation
        && state.settledGeneration !== generation
        && state.promptInFlight) {
        state.promptSubmittedGeneration = generation;
        if (this.profile.strictModelSelection && state.turnModel) {
          this.emitSessionInfo(sessionId, { model: state.turnModel });
        }
      }
    } catch (err) {
      this.failTurn(sessionId, state, generation, err);
      throw this.normalizeError(err);
    }
  }

  private capturePromptUsage(state: KimiSdkSessionState, result: PromptResponse): void {
    if (!this.profile.steeringPrompts || !result.usage) return;
    const usage = result.usage as unknown as Record<string, unknown>;
    const total = state.steeringUsage ??= {};
    // Superseded AG RPCs can carry the tokens spent BEFORE steering. The
    // latest RPC accounts only its continuation, not the entire run.
    for (const field of ['inputTokens', 'outputTokens', 'cachedReadTokens', 'cachedWriteTokens', 'thoughtTokens', 'totalTokens']) {
      const value = usage[field];
      if (typeof value === 'number' && Number.isFinite(value) && value >= 0) total[field] = (total[field] ?? 0) + value;
    }
    state.lastTurnUsage = total;
  }

  private failTurn(
    sessionId: string,
    state: KimiSdkSessionState,
    generation: number,
    error: unknown,
  ): void {
    if (this.sessions.get(sessionId) !== state) return;
    const run = this.steeringRunTerminals.get(state);
    if (this.profile.steeringPrompts) {
      if (!state.activePromptGenerations?.delete(generation)) return;
      state.steeringFailure ??= error;
      // A rejected steering request is NOT proof that the original task or
      // another admitted prompt stopped. Retain busy/text/tools until all
      // native RPCs settle (connection death rejects them all as well).
      if (state.activePromptGenerations.size > 0 || state.autonomousTurnGeneration !== undefined) return;
      error = state.steeringFailure;
      state.steeringFailure = undefined;
      state.steeringTerminal = undefined;
    } else if (state.settledGeneration >= generation) return;
    state.settledGeneration = state.turnGeneration;
    state.activePromptGenerations?.clear();
    state.autonomousTurnGeneration = undefined;
    state.promptInFlight = false;
    state.promptSubmittedGeneration = null;
    state.cancelled = false;
    state.stoppedByCancel = true;
    state.toolCalls.clear();
    state.emittedToolSignatures.clear();
    state.sessionSystemTextInjected = undefined;
    this.cancelPendingApprovals(sessionId);
    this.clearStatus(sessionId, state);
    run?.complete();
    if (this.isDisconnecting) return;
    this.emitError(sessionId, this.normalizeError(error));
  }

  private assertCurrentSession(sessionId: string, state: KimiSdkSessionState, connection = this.connection): void {
    if (this.sessions.get(sessionId) !== state || state.cancelled || !connection || this.connection !== connection) {
      throw this.makeError(PROVIDER_ERROR_CODES.CANCELLED, 'ACP session owner changed or stopped', true);
    }
  }

  /** Create the session on the agent if it doesn't exist yet, otherwise
   *  resume it. Applies Kimi's `default` mode once per session. */
  private async ensureSessionReady(
    sessionId: string,
    state: KimiSdkSessionState,
  ): Promise<void> {
    const connection = this.connection;
    if (!connection) {
      throw this.makeError(PROVIDER_ERROR_CODES.CONNECTION_LOST, `${this.profile.displayName} ACP connection not ready`, false);
    }
    await this.initPromise;
    this.assertCurrentSession(sessionId, state, connection);

    if (!state.loaded) {
      await state.beforeNativeSessionStart?.();
      this.assertCurrentSession(sessionId, state, connection);
      if (state.acpSessionId) {
        // Resume an existing session (survives across CLI restarts via
        // ~/.kimi/tmp/<project>/chats/<id>.json).
        try {
          const loader = this.profile.resumeWithoutReplay
            ? (this.connection as AcpAgent).resumeSession
            : (this.connection as AcpAgent).loadSession;
          if (typeof loader !== 'function') {
            throw new Error('Agent does not implement loadSession (capability mismatch)');
          }
          // `loadSession` streams the full message history back as
          // session/update notifications *before* the RPC resolves. Set the
          // replay flag so handleSessionUpdate drops those history chunks
          // instead of forwarding them to the current-turn delta listeners.
          state.replaying = true;
          let loadResult: LoadSessionResponse | undefined;
          try {
            loadResult = await loader.call(this.connection, {
              sessionId: state.acpSessionId,
              cwd: state.cwd,
              mcpServers: this.mcpServersForState(state),
            });
          } finally {
            state.replaying = false;
          }
          this.assertCurrentSession(sessionId, state, connection);
          state.loaded = true;
          this.cacheModelsFromSessionResponse(loadResult);
          this.applySessionMetadata(sessionId, state, loadResult);
        } catch (err) {
          if (this.profile.loadFailure === 'error') throw err;
          logger.info(
            {
              provider: this.id,
              sessionId,
              acpSessionId: state.acpSessionId,
              ...this.errorLogFields(err, 'err'),
            },
            `${this.profile.displayName} ACP loadSession failed; falling back to newSession`,
          );
          this.releaseAcpRoute(state.acpSessionId, state.routeId);
          state.acpSessionId = undefined;
          await this.createFreshAcpSession(sessionId, state);
        }
      } else {
        await this.createFreshAcpSession(sessionId, state);
      }
    }

    if (!state.modeApplied && this.profile.defaultMode && state.acpSessionId && this.connection) {
      const modeSetter = (this.connection as AcpAgent).setSessionMode;
      if (typeof modeSetter === 'function') {
        await modeSetter.call(this.connection, {
          sessionId: state.acpSessionId,
          modeId: this.profile.defaultMode,
        }).catch((err: unknown) => {
          // Not fatal — Kimi's server already defaults to this mode.
          logger.debug({
            provider: this.id,
            sessionId,
            ...this.errorLogFields(err, 'err'),
          }, 'setSessionMode(default) failed (non-fatal)');
        });
      }
      this.assertCurrentSession(sessionId, state, connection);
      state.modeApplied = true;
    }

    if (this.profile.strictModelSelection) {
      await this.confirmStrictSessionModel(sessionId, state);
    } else if (state.model && state.acpSessionId && this.connection) {
      const modelSetter = (this.connection as AcpAgent).unstable_setSessionModel;
      if (typeof modelSetter === 'function') {
        await modelSetter.call(this.connection, {
          sessionId: state.acpSessionId,
          modelId: state.model,
        }).catch((err: unknown) => {
          logger.debug({ provider: this.id, sessionId, ...this.errorLogFields(err, 'err') },
            'unstable_setSessionModel pre-turn failed (non-fatal)');
        });
      }
    }
    this.assertCurrentSession(sessionId, state, connection);
  }

  private async createFreshAcpSession(sessionId: string, state: KimiSdkSessionState): Promise<void> {
    this.assertCurrentSession(sessionId, state);
    const connection = this.connection!;
    const result: NewSessionResponse = await connection.newSession({
      cwd: state.cwd,
      mcpServers: this.mcpServersForState(state),
    });
    if (this.sessions.get(sessionId) !== state || state.cancelled || this.connection !== connection) {
      // session/new crossed the native boundary before Stop/rebind. Release
      // only this newly created worker, never publish its ID to a newer owner.
      void connection.closeSession({ sessionId: result.sessionId }).catch(() => {});
      throw this.makeError(PROVIDER_ERROR_CODES.CANCELLED, 'ACP new session owner changed or stopped', true);
    }
    state.acpSessionId = result.sessionId;
    state.loaded = true;
    state.modeApplied = false;
    state.sessionSystemTextInjected = undefined;
    this.registerAcpRoute(state.acpSessionId, sessionId);
    this.cacheModelsFromSessionResponse(result);
    this.applySessionMetadata(sessionId, state, result);
    this.emitSessionInfo(sessionId, { resumeId: state.acpSessionId });
  }

  private registerAcpRoute(acpSessionId: string, routeId: string): void {
    const routes = (this.acpRouteOrder.get(acpSessionId) ?? [])
      .filter((candidate) => candidate !== routeId && this.sessions.has(candidate));
    routes.push(routeId);
    this.acpRouteOrder.set(acpSessionId, routes);
    this.acpToRoute.set(acpSessionId, routeId);
  }

  private releaseAcpRoute(acpSessionId: string, routeId: string): boolean {
    const ownsCurrentRoute = this.acpToRoute.get(acpSessionId) === routeId;
    const remainingRoutes = (this.acpRouteOrder.get(acpSessionId) ?? [])
      .filter((candidate) => (
        candidate !== routeId
        && this.sessions.get(candidate)?.acpSessionId === acpSessionId
      ));
    if (remainingRoutes.length > 0) this.acpRouteOrder.set(acpSessionId, remainingRoutes);
    else this.acpRouteOrder.delete(acpSessionId);
    if (!ownsCurrentRoute) return false;
    if (remainingRoutes.length > 0) {
      this.acpToRoute.set(acpSessionId, remainingRoutes[remainingRoutes.length - 1]!);
      return false;
    }
    this.acpToRoute.delete(acpSessionId);
    return true;
  }

  protected cacheModelsFromSessionResponse(result: NewSessionResponse | import('@agentclientprotocol/sdk').LoadSessionResponse | undefined): void {
    if (this.cachedModels && this.profile.modelDiscovery !== 'session-metadata-only') return;
    if (!result) return;
    const models = (result as NewSessionResponse).models;
    if (!models) return;
    const available = models.availableModels;
    if (!Array.isArray(available)) return;
    if (available.length === 0) {
      if (this.profile.modelDiscovery === 'session-metadata-only') {
        this.cachedModels = [];
        this.cachedDefaultModel = null;
      }
      return;
    }
    this.cachedModels = available.map((m: Record<string, unknown>) => ({
      id: String(m.modelId ?? m.id ?? ''),
      ...(m.name ? { name: String(m.name) } : {}),
    })).filter((m) => m.id);
    this.cachedDefaultModel = typeof models.currentModelId === 'string' ? models.currentModelId : null;
    logger.debug({ provider: this.id, count: this.cachedModels.length, default: this.cachedDefaultModel }, `${this.profile.displayName} models cached`);
  }

  private mcpServersForState(state: KimiSdkSessionState): ReturnType<typeof getDefaultAcpMcpServers> {
    return getDefaultAcpMcpServers({
      sessionKey: state.routeId,
      sessionName: state.sessionName,
      projectName: state.projectName,
      serverId: state.serverId,
      cwd: state.cwd,
      env: state.env,
      contextNamespace: state.contextNamespace,
    });
  }

  async listModels(force?: boolean): Promise<ProviderModelList> {
    if (force && this.profile.modelDiscovery !== 'session-metadata-only') {
      this.cachedModels = null;
      this.cachedDefaultModel = null;
    }
    if (!this.cachedModels && this.profile.modelDiscovery !== 'session-metadata-only') {
      if (this.connection) {
        await this.initPromise;
        try {
          const result: NewSessionResponse = await this.connection.newSession({
            cwd: normalizeTransportCwd(process.cwd()) ?? process.cwd(),
            mcpServers: [],
          });
          this.cacheModelsFromSessionResponse(result);
          // Close the probe session best-effort so it doesn't accumulate
          const closer = (this.connection as AcpAgent).closeSession;
          if (typeof closer === 'function') {
            void closer.call(this.connection, { sessionId: result.sessionId }).catch(() => {});
          }
        } catch (err) {
          logger.debug({
            provider: this.id,
            ...this.errorLogFields(err, 'err'),
          }, `${this.profile.displayName} model probe failed (non-fatal)`);
        }
      }
    }
    return {
      models: this.cachedModels ?? [],
      ...(this.cachedDefaultModel ? { defaultModel: this.cachedDefaultModel } : {}),
      isAuthenticated: (this.cachedModels?.length ?? 0) > 0,
    };
  }

  private applySessionMetadata(
    sessionId: string,
    state: KimiSdkSessionState,
    info: NewSessionResponse | LoadSessionResponse | undefined,
  ): void {
    if (!info) return;
    const currentModel = info.models?.currentModelId;
    if (this.profile.strictModelSelection && typeof currentModel === 'string') {
      state.confirmedModel = currentModel;
    }
    if (typeof currentModel === 'string' && !state.model) {
      state.model = currentModel;
      this.emitSessionInfo(sessionId, { model: currentModel });
    }
  }

  private buildPromptContent(payload: ProviderContextPayload, includeSessionSystemText: boolean): ContentBlock[] {
    // ACP has no separate system-prompt slot. Inject stable IM.codes context
    // once per ACP history, then only per-turn authored context thereafter.
    const content: ContentBlock[] = [{
      type: 'text',
      text: composeMessageSideProviderPrompt(payload, { includeSessionSystemText }),
    }];
    if (!this.profile.resourceLinkAttachments) return content;
    for (const attachment of payload.attachments ?? []) {
      const daemonPath = attachment.daemonPath.trim();
      if (!path.isAbsolute(daemonPath)) continue;
      const originalName = attachment.originalName?.trim();
      content.push({
        type: 'resource_link',
        name: originalName || path.basename(daemonPath),
        uri: pathToFileURL(daemonPath).href,
        ...(originalName ? { title: originalName } : {}),
        ...(attachment.mime?.trim() ? { mimeType: attachment.mime.trim() } : {}),
        ...(typeof attachment.size === 'number' && Number.isFinite(attachment.size) && attachment.size >= 0
          ? { size: attachment.size }
          : {}),
      });
    }
    return content;
  }

  private settleTurn(
    sessionId: string,
    state: KimiSdkSessionState,
    generation: number,
    stopReason: StopReason,
    sessionSystemTextToCommit?: string,
    compactControl = false,
  ): void {
    if (this.sessions.get(sessionId) !== state) return;
    const run = this.steeringRunTerminals.get(state);
    let steeringFailure: unknown;
    if (this.profile.steeringPrompts) {
      if (!state.activePromptGenerations?.delete(generation)) return;
      if (!state.steeringTerminal || generation > state.steeringTerminal.generation) {
        state.steeringTerminal = { generation, stopReason };
      }
      state.settledGeneration = Math.max(state.settledGeneration, generation);
      if (sessionSystemTextToCommit) state.sessionSystemTextInjected = sessionSystemTextToCommit;
      // AG retires superseded prompt RPCs immediately. They are NOT assistant
      // completions and must not clear streamed text/tools or drain the FIFO.
      if (state.activePromptGenerations.size > 0) return;
      stopReason = state.steeringTerminal.stopReason;
      state.steeringTerminal = undefined;
      steeringFailure = state.steeringFailure;
      state.steeringFailure = undefined;
      state.autonomousTurnGeneration = undefined;
      state.promptInFlight = false;
      state.promptSubmittedGeneration = null;
    } else {
      if (state.settledGeneration >= generation) return;
      state.settledGeneration = generation;
      state.activePromptGenerations?.delete(generation);
      const hasRemainingPrompts = (state.activePromptGenerations?.size ?? 0) > 0;
      if (!hasRemainingPrompts) {
        state.autonomousTurnGeneration = undefined;
        state.promptInFlight = false;
        state.promptSubmittedGeneration = null;
      } else {
        state.promptSubmittedGeneration = state.turnGeneration;
      }
    }
    this.clearStatus(sessionId, state);
    if (this.id === AGY_SDK_PROVIDER_ID && state.agyBridges?.size) {
      state.agySuppressBridgeResponses = true;
      const bridge = state.agyBridges.get(state.acpSessionId!);
      void bridge?.flush().finally(() => {
        if (this.sessions.get(sessionId) === state) { state.agyReactive = false; state.agySuppressBridgeResponses = false; }
      });
    }
    const text = state.currentText;
    const messageId = state.currentMessageId ?? `${sessionId}:${randomUUID()}`;
    state.currentText = '';
    state.currentMessageId = null;
    state.toolCalls.clear();
    state.emittedToolSignatures.clear();
    this.cancelPendingApprovals(sessionId);
    // All native RPCs are now terminal and busy/text/tools are cleared. Resolve
    // only this captured run; callbacks may already have started a successor.
    run?.complete();

    if (steeringFailure !== undefined) {
      state.cancelled = false;
      state.stoppedByCancel = true;
      this.emitError(sessionId, this.normalizeError(steeringFailure));
      return;
    }
    if (stopReason === 'cancelled' || state.cancelled) {
      this.closeAgyBridges(state);
      for (const event of state.agySubagents?.interrupt() ?? []) {
        for (const cb of this.toolCallCallbacks) cb(sessionId, event);
      }
      state.cancelled = false;
      state.stoppedByCancel = true;
      state.activePromptGenerations?.clear();
      state.autonomousTurnGeneration = undefined;
      state.promptInFlight = false;
      state.promptSubmittedGeneration = null;
      state.settledGeneration = state.turnGeneration;
      this.emitError(
        sessionId,
        this.makeError(PROVIDER_ERROR_CODES.CANCELLED, `${this.profile.displayName} turn cancelled`, true),
      );
      return;
    }
    if (stopReason === 'refusal') {
      this.emitError(
        sessionId,
        this.makeError(PROVIDER_ERROR_CODES.PROVIDER_ERROR, `${this.profile.displayName} refused the request`, false),
      );
      return;
    }
    // Snapshot + clear the per-turn ACP usage so each onComplete carries its
    // OWN token counts (not the previous turn's). Transport-relay's
    // normalizeUsageUpdatePayload reads `metadata.usage` to emit usage.update
    // → recorded in context_turn_usage with the turn's eventId.
    const turnUsage = this.id === AGY_SDK_PROVIDER_ID
      ? { ...state.lastTurnUsage, ...(state.agyContextUsage ??= new AgyContextUsage()).normalize(state.lastTurnUsage) }
      : state.lastTurnUsage;
    state.lastTurnUsage = undefined;
    this.emitAgyUsage(sessionId, state, turnUsage, true);
    if (sessionSystemTextToCommit) state.sessionSystemTextInjected = sessionSystemTextToCommit;

    if (stopReason === 'max_tokens' || stopReason === 'max_turn_requests') {
      // Still emit whatever text we accumulated — it's a partial but useful
      // response — and mark metadata so the UI can show the truncation cause.
      const msg: AgentMessage = {
        id: messageId,
        sessionId,
        kind: 'text',
        role: 'assistant',
        content: text,
        timestamp: Date.now(),
        status: 'complete',
        metadata: {
          stopReason,
          ...((this.profile.strictModelSelection ? state.turnModel : state.model)
            ? { model: this.profile.strictModelSelection ? state.turnModel : state.model } : {}),
          ...(state.acpSessionId ? { resumeId: state.acpSessionId } : {}),
          ...(turnUsage ? { usage: turnUsage } : {}),
        },
      };
      for (const cb of this.completeCallbacks) cb(sessionId, msg);
      return;
    }

    // stopReason === 'end_turn' (happy path).
    if (compactControl) state.sessionSystemTextInjected = undefined;
    const msg: AgentMessage = {
      id: messageId,
      sessionId,
      kind: 'text',
      role: 'assistant',
      content: text,
      timestamp: Date.now(),
      status: 'complete',
      metadata: {
        ...(compactControl ? { [SESSION_CONTROL_METADATA_COMMAND_FIELD]: 'compact' } : {}),
        ...((this.profile.strictModelSelection ? state.turnModel : state.model)
            ? { model: this.profile.strictModelSelection ? state.turnModel : state.model } : {}),
        ...(state.acpSessionId ? { resumeId: state.acpSessionId } : {}),
        ...(turnUsage ? { usage: turnUsage } : {}),
      },
    };
    for (const cb of this.completeCallbacks) cb(sessionId, msg);
  }

  // ── sessionUpdate dispatch ──────────────────────────────────────────────

  private handleSessionUpdate(params: SessionNotification): void {
    if (!params || typeof params !== 'object' || typeof params.sessionId !== 'string' || !params.update || typeof params.update !== 'object') return;
    const routeId = this.acpToRoute.get(params.sessionId);
    if (!routeId) return;
    const state = this.sessions.get(routeId);
    if (!state || state.acpSessionId !== params.sessionId) return;

    const update = params.update as SessionUpdate;
    // While loadSession is replaying history, drop every turn-scoped event.
    // We only resurface the persisted agent text/tools when the user actually
    // asks a new question; replay is purely a server-side side-effect of
    // session/load and must not be confused with the current-turn stream.
    if (state.replaying) {
      return;
    }
    const updateRecord = update as unknown as Record<string, unknown>;
    if (this.id === AGY_SDK_PROVIDER_ID && isSdkRuntimeSubagentEventName(updateRecord.sessionUpdate)) {
      for (const event of (state.agySubagents ??= new AgySubagentTracker(state.acpSessionId ?? routeId)).snapshot(updateRecord)) {
        for (const cb of this.toolCallCallbacks) cb(routeId, event);
      }
      return;
    }
    if (this.profile.runtimeSubagent && isSdkRuntimeSubagentEventName(updateRecord.sessionUpdate)) {
      this.emitRuntimeSubagentNotification(routeId, state, updateRecord);
      return;
    }
    if (updateRecord.sessionUpdate === 'turn_completed') {
      if (this.profile.steeringPrompts && state.autonomousTurnGeneration !== undefined) {
        this.capturePromptUsage(state, updateRecord as unknown as PromptResponse);
        const autoGen = state.autonomousTurnGeneration;
        state.autonomousTurnGeneration = undefined;
        if ((state.activePromptGenerations?.size ?? 0) === 0) {
          (state.activePromptGenerations ??= new Set()).add(autoGen);
          this.settleTurn(routeId, state, autoGen, state.cancelled ? 'cancelled' : 'end_turn');
        }
      }
      return;
    }
    const turnScopedUpdate = update.sessionUpdate === 'agent_message_chunk'
      || update.sessionUpdate === 'agent_thought_chunk'
      || update.sessionUpdate === 'tool_call'
      || update.sessionUpdate === 'tool_call_update'
      || update.sessionUpdate === 'usage_update'
      || update.sessionUpdate === 'plan';
    if (turnScopedUpdate
      && this.profile.steeringPrompts
      && !state.promptInFlight
      && state.loaded
      && !state.replaying
      && !state.cancelled
      && !state.stoppedByCancel) {
      this.startAutonomousTurn(routeId, state);
    }
    if (turnScopedUpdate && (!state.promptInFlight || state.cancelled)) {
      return;
    }
    switch (update.sessionUpdate) {
      case 'agent_message_chunk':
        this.handleAgentChunk(routeId, state, update);
        return;
      case 'agent_thought_chunk':
        // ACP thought chunks map to our transient "thinking" status. We
        // intentionally do NOT append the thought text to the main content
        // stream — it's reasoning, not the assistant message.
        this.emitStatus(routeId, state, { status: 'thinking', label: 'Thinking...' });
        return;
      case 'tool_call':
        this.handleToolCall(routeId, state, update);
        return;
      case 'tool_call_update':
        this.handleToolCallUpdate(routeId, state, update);
        return;
      case 'current_mode_update':
        // Just informational — the user may have switched mode through the
        // agent's own command vocabulary. Treat as metadata.
        logger.debug(
          { provider: this.id, sessionId: routeId, modeId: update.currentModeId },
          `${this.profile.displayName} ACP mode changed`,
        );
        return;
      case 'usage_update': {
        // Map ACP's usage update onto our generic quota/session-info signal.
        // ACP's `UsageUpdate` is experimental; guard every field.
        const u = update as Record<string, unknown>;
        if (this.id === AGY_SDK_PROVIDER_ID) {
          const meter = state.agyContextUsage ??= new AgyContextUsage();
          const snapshot = meter.normalize(u);
          this.emitAgyUsage(routeId, state, u);
          state.lastTurnUsage = { ...state.lastTurnUsage, ...snapshot };
        }
        const tokens = (typeof u.tokens === 'object' && u.tokens)
          ? (u.tokens as Record<string, unknown>)
          : undefined;
        // Cache for the next onComplete so transport-relay can normalize it
        // into a `usage.update` timeline event with input/output token data.
        // ACP token field names vary across Kimi ACP versions; pass the
        // raw map through and let transport-relay's normalizeUsageUpdatePayload
        // pick up `input_tokens`/`output_tokens`/`cache_*` whichever form
        // Kimi emitted.
        if (tokens) {
          const sessionState = this.sessions.get(routeId);
          if (sessionState) sessionState.lastTurnUsage = tokens;
        }
        return;
      }
      case 'plan':
        this.handlePlan(routeId, state, update);
        return;
      case 'available_commands_update':
      case 'user_message_chunk':
      case 'config_option_update':
      case 'session_info_update':
        // Ignore for now. `user_message_chunk` arrives during history replay
        // and would double-inject prior user turns into the delta stream.
        return;
      default:
        logger.debug(
          { provider: this.id, sessionId: routeId, sessionUpdate: (update as { sessionUpdate: string }).sessionUpdate },
          'Unhandled ACP session update',
        );
        return;
    }
  }

  private startAutonomousTurn(sessionId: string, state: KimiSdkSessionState): void {
    const generation = ++state.turnGeneration;
    state.autonomousTurnGeneration = generation;
    state.promptInFlight = true;
    state.promptSubmittedGeneration = generation;
    state.cancelled = false;
    state.stoppedByCancel = false;
    state.steeringUsage = undefined;
    state.lastTurnUsage = undefined;
    state.steeringTerminal = undefined;
    state.steeringFailure = undefined;
    state.currentText = '';
    state.currentMessageId = null;
    state.toolCalls.clear();
    state.emittedToolSignatures.clear();
    state.lastStatusSignature = null;
    state.turnModel = this.profile.strictModelSelection ? (state.confirmedModel ?? state.model) : undefined;
    (state.activePromptGenerations ??= new Set()).clear();
    let completeRun!: () => void;
    const run = {
      terminal: new Promise<void>((r) => { completeRun = r; }),
      complete: () => completeRun(),
    };
    this.steeringRunTerminals.set(state, run);
    if (this.profile.strictModelSelection && state.turnModel) {
      this.emitSessionInfo(sessionId, { model: state.turnModel });
    }
  }

  private handleAgentChunk(
    sessionId: string,
    state: KimiSdkSessionState,
    update: Extract<SessionUpdate, { sessionUpdate: 'agent_message_chunk' }>,
  ): void {
    const chunkText = extractTextFromContent(update.content);
    if (!chunkText) return;
    if (this.id === AGY_SDK_PROVIDER_ID) {
      const child = parseSdkRuntimeSubagentTag(chunkText);
      if (child) {
        for (const event of (state.agySubagents ??= new AgySubagentTracker(state.acpSessionId ?? sessionId)).snapshot(child)) {
          for (const cb of this.toolCallCallbacks) cb(sessionId, event);
        }
        return;
      }
      if (startsWithSdkRuntimeSubagentTag(chunkText)) return;
    }
    const runtimeSubagentPayload = this.profile.runtimeSubagent
      ? parseSdkRuntimeSubagentTag(chunkText)
      : null;
    if (runtimeSubagentPayload) {
      this.emitRuntimeSubagentNotification(sessionId, state, runtimeSubagentPayload);
      return;
    }
    if (this.profile.runtimeSubagent && startsWithSdkRuntimeSubagentTag(chunkText)) return;
    this.clearStatus(sessionId, state);

    // ACP has a `messageId` field on each chunk. When it changes we start a
    // new assistant message. Fall back to our own UUID if the agent doesn't
    // populate it (older CLI versions).
    const incomingId = (update as unknown as { messageId?: string | null }).messageId ?? null;
    if (incomingId && incomingId !== state.currentMessageId) {
      state.currentMessageId = incomingId;
      state.currentText = '';
    } else if (!state.currentMessageId) {
      state.currentMessageId = randomUUID();
    }

    state.currentText += chunkText;
    state.agyContextUsage?.addText(chunkText);
    this.emitAgyUsage(sessionId, state);
    const delta: MessageDelta = {
      messageId: state.currentMessageId,
      type: 'text',
      delta: state.currentText,
      role: 'assistant',
    };
    for (const cb of this.deltaCallbacks) cb(sessionId, delta);
  }

  private emitRuntimeSubagentNotification(
    sessionId: string,
    state: KimiSdkSessionState,
    payload: Record<string, unknown>,
  ): void {
    const runtimeSubagent = this.profile.runtimeSubagent;
    if (!runtimeSubagent) return;
    const tool = buildGenericRuntimeSubagentTool({
      sessionId,
      provider: runtimeSubagent.provider,
      providerKind: runtimeSubagent.providerKind,
      providerLabel: this.profile.displayName,
      action: runtimeSubagent.action,
      payload,
      fallbackModel: state.model,
    });
    if (!tool) return;
    for (const cb of this.toolCallCallbacks) cb(sessionId, tool);
  }

  private handleToolCall(
    sessionId: string,
    state: KimiSdkSessionState,
    update: Extract<SessionUpdate, { sessionUpdate: 'tool_call' }> & ToolCall,
  ): void {
    this.clearStatus(sessionId, state);
    const merged: MergedToolCall = {
      toolCallId: update.toolCallId,
      title: update.title ?? update.toolCallId,
      kind: update.kind ?? undefined,
      status: update.status ?? 'pending',
      content: Array.isArray(update.content) ? update.content : [],
      rawInput: update.rawInput,
      rawOutput: update.rawOutput,
    };
    state.toolCalls.set(update.toolCallId, merged);
    this.emitMergedToolCall(sessionId, state, merged);
  }

  private handleToolCallUpdate(
    sessionId: string,
    state: KimiSdkSessionState,
    update: Extract<SessionUpdate, { sessionUpdate: 'tool_call_update' }> & ToolCallUpdate,
  ): void {
    const existing = state.toolCalls.get(update.toolCallId);
    // ACP spec: every field on ToolCallUpdate is optional and replaces the
    // corresponding field on the original tool_call. We synthesize a stub if
    // the agent updates a tool we never saw start (shouldn't happen, but
    // defensive).
    const merged: MergedToolCall = existing ?? {
      toolCallId: update.toolCallId,
      title: update.title ?? update.toolCallId,
      kind: update.kind ?? undefined,
      status: update.status ?? 'pending',
      content: [],
    };
    if (typeof update.title === 'string') merged.title = update.title;
    if (typeof update.kind === 'string') merged.kind = update.kind;
    if (typeof update.status === 'string') merged.status = update.status;
    if (Array.isArray(update.content)) merged.content = update.content;
    if ('rawInput' in update) merged.rawInput = update.rawInput;
    if ('rawOutput' in update) merged.rawOutput = update.rawOutput;
    state.toolCalls.set(update.toolCallId, merged);
    this.emitMergedToolCall(sessionId, state, merged);
  }

  private handlePlan(
    sessionId: string,
    state: KimiSdkSessionState,
    update: SessionUpdate,
  ): void {
    const input = acpPlanEntriesToInput((update as unknown as { entries?: unknown }).entries);
    if (!input) return;
    this.clearStatus(sessionId, state);
    const plan: MergedToolCall = {
      toolCallId: `${this.id}-plan:${sessionId}`,
      title: 'plan',
      kind: 'plan',
      status: 'in_progress',
      content: [],
      rawInput: input,
    };
    state.toolCalls.set(plan.toolCallId, plan);
    this.emitMergedToolCall(sessionId, state, plan);
  }

  private emitMergedToolCall(
    sessionId: string,
    state: KimiSdkSessionState,
    merged: MergedToolCall,
  ): void {
    const normalizedStatus = mapToolStatus(merged.status);
    const output = normalizedStatus === 'running' ? undefined : flattenToolContent(merged.content);
    const evt: ToolCallEvent = {
      id: merged.toolCallId,
      name: merged.title,
      status: normalizedStatus,
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
    if (this.id === AGY_SDK_PROVIDER_ID) {
      const tracker = state.agySubagents ??= new AgySubagentTracker(state.acpSessionId ?? sessionId);
      const outputValue = merged.rawOutput !== undefined ? (typeof merged.rawOutput === 'string' ? merged.rawOutput : JSON.stringify(merged.rawOutput)) : evt.output;
      const nativeName = merged.title.toLowerCase().replace(/^run\s+/, '').replace(/[-_\s]/g, '');
      if (evt.status === 'running' && /^(invokesubagent|browsersubagent)$/.test(nativeName)) {
        const pending = state.agyPendingLaunches ??= [];
        if (!pending.includes(evt.id)) pending.push(evt.id);
      }
      const children = tracker.tool({ ...evt, ...(outputValue !== undefined ? { output: outputValue } : {}) });
      if (children.some(child => child.detail?.meta?.agentPath !== evt.id)) state.agyPendingLaunches = state.agyPendingLaunches?.filter(id => id !== evt.id);
      if (children.length) {
        for (const child of children) for (const cb of this.toolCallCallbacks) cb(sessionId, child);
        return;
      }
    }
    const signature = JSON.stringify({
      status: evt.status,
      name: evt.name,
      input: evt.input ?? null,
      output: evt.output ?? null,
    });
    if (state.emittedToolSignatures.get(merged.toolCallId) === signature) return;
    state.emittedToolSignatures.set(merged.toolCallId, signature);
    for (const cb of this.toolCallCallbacks) cb(sessionId, evt);
  }

  // ── Helpers ─────────────────────────────────────────────────────────────

  // Async on purpose: teardown must be awaitable, or shutdown resolves while
  // the SIGTERM->SIGKILL window is still open and the SIGKILL never lands.
  private async teardownChild(): Promise<void> {
    // Closing the ACP connection is implicit when we close stdin. The SDK's
    // internal readers finish when stdout ends. tree-kill the CLI so its
    // node wrapper doesn't leave grandchildren behind.
    if (this.child && !this.child.killed) {
      try { this.child.stdin.end(); } catch { /* noop */ }
      await killProcessTree(this.child, { ownsProcessGroup: true });
    }
    this.child = null;
    this.connection = null;
    this.sessionListSupported = false;
  }

  private emitSessionInfo(sessionId: string, info: SessionInfoUpdate): void {
    for (const cb of this.sessionInfoCallbacks) cb(sessionId, info);
  }

  private emitStatus(
    sessionId: string,
    state: KimiSdkSessionState,
    status: ProviderStatusUpdate,
  ): void {
    const signature = JSON.stringify({ status: status.status, label: status.label ?? null });
    if (state.lastStatusSignature === signature) return;
    state.lastStatusSignature = signature;
    for (const cb of this.statusCallbacks) cb(sessionId, status);
  }

  private clearStatus(sessionId: string, state: KimiSdkSessionState): void {
    this.emitStatus(sessionId, state, { status: null, label: null });
  }

  private emitError(sessionId: string, error: ProviderError): void {
    for (const cb of this.errorCallbacks) cb(sessionId, error);
  }

  protected resolveAcpExecutable(config: ProviderConfig): ReturnType<typeof resolveExecutableForSpawn> {
    return resolveExecutableForSpawn(this.resolveBinaryPath(config));
  }

  protected resolveBinaryPath(config: ProviderConfig | null): string {
    return typeof config?.binaryPath === 'string' && config.binaryPath.trim()
      ? config.binaryPath
      : this.profile.binary;
  }

  private makeError(code: string, message: string, recoverable: boolean, details?: unknown): ProviderError {
    return { code, message, recoverable, ...(details !== undefined ? { details } : {}) };
  }

  /**
   * Build the only error-bearing fields permitted in ACP logs. Providers that
   * opt into privacySafeErrors (Hermes, CodeBuddy, Grok) never persist the
   * provider's message, stack, paths, environment material, or enumerable
   * custom fields. Other profiles keep their existing raw diagnostic field.
   */
  private errorLogFields(error: unknown, rawField: 'err' | 'error' = 'error'): Record<string, unknown> {
    if (this.profile.privacySafeErrors) {
      return { errorCode: getPrivacySafeErrorCode(error) };
    }
    return { [rawField]: error };
  }

  private normalizeError(err: unknown): ProviderError {
    if (err && typeof err === 'object' && 'code' in err && 'message' in err && 'recoverable' in err) {
      // Already a ProviderError.
      return err as ProviderError;
    }
    const message = err instanceof Error ? err.message : String(err);
    const isConnectionLost = /closed|epipe|econnreset|broken pipe|stream (?:closed|ended)|socket closed|server exited|process exited|channel closed|connection (?:lost|closed|ended|reset)|premature close|unexpected end of json/i.test(message);
    if (isConnectionLost || this.isDisconnecting) {
      return this.makeError(
        PROVIDER_ERROR_CODES.CONNECTION_LOST,
        this.profile.privacySafeErrors ? `${this.profile.displayName} connection was lost.` : message,
        true,
        this.profile.privacySafeErrors ? undefined : err,
      );
    }
    if (this.profile.privacySafeErrors) {
      if (/auth|login|credential|unauthorized|forbidden/i.test(message)) {
        return this.makeError(
          PROVIDER_ERROR_CODES.AUTH_FAILED,
          `${this.profile.displayName} authentication is required. Complete the official CLI login and retry.`,
          false,
        );
      }
      if (/rate|429|quota/i.test(message)) {
        return this.makeError(
          PROVIDER_ERROR_CODES.RATE_LIMITED,
          `${this.profile.displayName} temporarily rate limited the request.`,
          true,
        );
      }
      return this.makeError(
        PROVIDER_ERROR_CODES.PROVIDER_ERROR,
        `${this.profile.displayName} ACP request failed.`,
        false,
      );
    }
    if (err instanceof RequestError) {
      // Map ACP auth_required (code -32000 in Kimi CLI today, but spec
      // reserves this code) onto our AUTH_FAILED so the UI surfaces a
      // login-needed card instead of a generic error.
      if (/auth/i.test(message)) {
        return this.makeError(PROVIDER_ERROR_CODES.AUTH_FAILED, message, false, err);
      }
      return this.makeError(PROVIDER_ERROR_CODES.PROVIDER_ERROR, message, false, err);
    }
    if (/ENOENT|not found/i.test(message)) {
      return this.makeError(
        PROVIDER_ERROR_CODES.CONFIG_ERROR,
        `${this.profile.displayName} CLI is unavailable. Install the official CLI and authenticate before starting a session.`,
        false,
      );
    }
    if (/auth/i.test(message)) {
      return this.makeError(PROVIDER_ERROR_CODES.AUTH_FAILED, message, false, err);
    }
    return this.makeError(PROVIDER_ERROR_CODES.PROVIDER_ERROR, message, false, err);
  }

  /** Hook used by setSessionEffort in the TransportProvider interface — we
   *  declare reasoningEffort:false so this should never be called, but other
   *  providers define the method so we mirror the shape. */
  setSessionEffort(_sessionId: string, _effort: TransportEffortLevel): void {
    // no-op — effort is baked into the model choice.
  }

  onApprovalRequest(cb: (sessionId: string, request: ApprovalRequest) => void): void {
    this.approvalCallbacks.push(cb);
  }

  async respondApproval(sessionId: string, requestId: string, approved: boolean): Promise<void> {
    const pending = this.pendingApprovals.get(requestId);
    if (!pending || pending.routeId !== sessionId) return;
    this.pendingApprovals.delete(requestId);
    clearTimeout(pending.timer);
    const selected = pending.options.find((option) => approved
      ? option.kind === 'allow_once' || option.kind === 'allow_always'
      : option.kind === 'reject_once' || option.kind === 'reject_always');
    pending.resolve(selected
      ? { outcome: { outcome: 'selected', optionId: selected.optionId } }
      : { outcome: { outcome: 'cancelled' } });
  }

  protected async validateConnectedAgent(
    _initializeResult: Record<string, unknown>,
    _config: ProviderConfig,
  ): Promise<void> {
    // Kimi preserves its existing lazy authentication/session behavior.
  }

  private bridgePermissionRequest(params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    const routeId = this.acpToRoute.get(params.sessionId);
    if (!routeId || this.approvalCallbacks.length === 0) {
      return Promise.resolve({ outcome: { outcome: 'cancelled' } });
    }
    const requestId = randomUUID();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pendingApprovals.delete(requestId);
        resolve({ outcome: { outcome: 'cancelled' } });
      }, 120_000);
      this.pendingApprovals.set(requestId, { routeId, options: params.options, resolve, timer });
      const request: ApprovalRequest = {
        id: requestId,
        description: params.toolCall?.title ?? `${this.profile.displayName} requested permission to use a tool`,
        ...(params.toolCall?.title ? { tool: params.toolCall.title } : {}),
        provider: this.id,
        ...(params.toolCall?.toolCallId ? { providerToolUseId: params.toolCall.toolCallId } : {}),
      };
      for (const callback of this.approvalCallbacks) callback(routeId, request);
    });
  }

  private cancelPendingApprovals(routeId?: string): void {
    for (const [requestId, pending] of this.pendingApprovals) {
      if (routeId && pending.routeId !== routeId) continue;
      this.pendingApprovals.delete(requestId);
      clearTimeout(pending.timer);
      pending.resolve({ outcome: { outcome: 'cancelled' } });
    }
  }

  private clearSessionWorkAfterFailure(routeId: string): boolean {
    const state = this.sessions.get(routeId);
    if (!state) return false;
    this.closeAgyBridges(state);
    const run = this.steeringRunTerminals.get(state);
    const hadActiveWork = state.promptInFlight || state.replaying || state.toolCalls.size > 0;
    if (hadActiveWork) state.settledGeneration = state.turnGeneration;
    state.activePromptGenerations?.clear();
    state.autonomousTurnGeneration = undefined;
    state.promptInFlight = false;
    state.promptSubmittedGeneration = null;
    if (!this.profile.steeringPrompts) state.activePromptAdmissions.clear();
    state.loaded = false;
    state.modeApplied = false;
    state.steeringTerminal = undefined;
    state.steeringFailure = undefined;
    state.replaying = false;
    state.cancelled = false;
    state.stoppedByCancel = true;
    state.currentMessageId = null;
    state.currentText = '';
    state.toolCalls.clear();
    state.emittedToolSignatures.clear();
    this.clearStatus(routeId, state);
    run?.complete();
    return hadActiveWork;
  }
}

// ── Module-scope pure helpers ─────────────────────────────────────────────

/** Extract a text string from a ContentBlock if it's a textual variant.
 *  Kimi's agent_message_chunk and agent_thought_chunk carry TextContent;
 *  image/audio/resource variants are silently dropped. */
function extractTextFromContent(block: ContentBlock): string {
  if (!block || typeof block !== 'object') return '';
  if (block.type === 'text' && typeof block.text === 'string') return block.text;
  return '';
}

/** Join the content array of a completed tool call into a single human-readable
 *  string. ACP allows `content` to mix `{type:'content', content:TextContent}`
 *  and `{type:'diff',...}` entries. For the brief UI summary we only unwrap
 *  textual content; the full structured detail stays in `detail.raw`. */
function flattenToolContent(content: ToolCallContent[]): string | undefined {
  if (!Array.isArray(content) || content.length === 0) return undefined;
  const parts: string[] = [];
  for (const item of content) {
    if (!item || typeof item !== 'object') continue;
    if (item.type === 'content' && item.content?.type === 'text' && typeof item.content.text === 'string') {
      parts.push(item.content.text);
    } else if (item.type === 'diff') {
      const newText = typeof item.newText === 'string' ? item.newText : '';
      parts.push(newText);
    }
  }
  return parts.length > 0 ? parts.join('\n') : undefined;
}

/** Map ACP's ToolCallStatus enum onto our ToolCallEvent status union. */
function mapToolStatus(status: string): 'running' | 'complete' | 'error' {
  switch (status) {
    case 'completed':
      return 'complete';
    case 'failed':
    case 'cancelled':
      return 'error';
    case 'pending':
    case 'in_progress':
    default:
      return 'running';
  }
}

const PRIVACY_SAFE_ACP_ERROR_CODES = new Set<string>([
  ...Object.values(PROVIDER_ERROR_CODES),
  'ENOENT',
  'EACCES',
  'EPIPE',
  'ETIMEDOUT',
  'ECONNRESET',
  'ECONNREFUSED',
]);

function getPrivacySafeErrorCode(error: unknown): string {
  if (error && typeof error === 'object' && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'number' && Number.isFinite(code)) return String(Math.trunc(code));
    if (typeof code === 'string' && PRIVACY_SAFE_ACP_ERROR_CODES.has(code)) return code;
  }
  return error instanceof RequestError ? 'acp_request_error' : 'unknown';
}
