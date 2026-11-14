import { AgyForegroundOwnership } from '../agy-foreground-ownership.js';
import { AgyTranscriptBridge, agyTranscriptFile, type AgyTranscriptCursor, type AgyTranscriptRow } from '../agy-transcript-bridge.js';
import { AgySubagentTracker, extractAgySubagentEvidenceChildIds, isAgySubagentTool, normalizeAgyToolName, stableJson } from '../agy-subagents.js';
import { AgyCompactionWatermark } from '../agy-compaction-watermark.js';
import { AGY_SDK_PROVIDER_ID, AGY_NATIVE_START_RECOVERY_HINT } from '../../../shared/agy-agent.js';
import { ACP_ERROR_PHASE, type AcpErrorPhase } from '../../../shared/provider-error-codes.js';
import { AgyContextUsage } from '../agy-context-usage.js';
import {
  createAgyIncognitoEnvSync,
  reclaimOrphanedAgyIncognitoHomes,
  resolveAgySourceHome,
  type AgyIncognitoEnv,
} from '../agy-incognito-isolation.js';
import { inIncognitoContext, setSessionIncognito } from '../../../shared/session-incognito-context.js';
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
import { realpathSync, statSync } from 'node:fs';
import { once } from 'node:events';
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
import type { ProviderActiveWorkSnapshot, ToolTerminalReason, ToolTerminalStatus } from '../../../shared/session-activity-types.js';
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
  /** Spawn one dedicated ACP process per session instead of one shared front server. */
  perSessionTransport?: boolean;
  /** Defer model selection until idle, and fail rather than run a wrong model. */
  strictModelSelection?: boolean;
  /** Preferred default model for brand-new sessions when supported by the catalogue. */
  defaultModel?: string;
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
  modelIsDefault?: boolean;
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
  /** Single per-session FIFO tail ensuring prompt settlements and `session/update`
   *  notifications execute in exact stdout wire order. */
  wireOrderTail?: Promise<void>;
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
  /** Bounded set of retired/settled ACP toolCallIds whose late updates must not reopen tool tracking. */
  retiredToolCallIds?: Set<string>;
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
  agyBackgroundTasks?: Set<string>;
  agyBridges?: Map<string, AgyTranscriptBridge>;
  agyPendingNativeTools?: Map<string, ToolCallEvent>;
  agyConsumedNativeTools?: Set<string>;
  agyNativeToolOrder?: Array<{name:string;input:unknown;step:number;index:number}>;
  agyRecentAcpOutputs?: Array<{normalizedName:string;output:string}>;
  agyReactive?: boolean;
  agyPendingResponses?: Map<number, AgyTranscriptRow>;
  // Receipts for pre-async ACP autonomous completions; native authority
  // clears them when a subagent/peer interaction is observed.
  agyNativeAcks?: Array<{generation:number;text:string}>;
  agyForeground?: AgyForegroundOwnership;
  agyProvisionalAutoMessageId?: string;
  agyBridging?: boolean;
  agyNativeTurnGeneration?: number;
  incognito?: boolean;
  disposed?: boolean;
  lastActivityAt?: number;
  isolatedTransport?: IsolatedAcpTransport;
  isolatedDisposeInFlight?: Promise<void>;
}

interface AcpFileFingerprint {
  realpath: string | null;
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
}

interface AcpExecutableFingerprint {
  executable: string;
  primary: AcpFileFingerprint;
  scriptPath?: string;
  script?: AcpFileFingerprint | null;
}

interface AcpTransportSlot {
  child: ChildProcessWithoutNullStreams | null;
  connection: ClientSideConnection | null;
  initPromise: Promise<void> | null;
  sessionListSupported: boolean;
}

interface IsolatedAcpTransport extends AcpTransportSlot {
  incognitoEnv?: AgyIncognitoEnv;
  sourceHome?: string;
  executableFingerprint?: AcpExecutableFingerprint | null;
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
  private readonly acpErrorPhases = new WeakMap<object, AcpErrorPhase>();
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
  private promptWriteQueues = new WeakMap<ClientSideConnection, Map<string, Array<{
    onResponseArrived: () => void;
    clearPending: () => void;
  }>> & {
    reserveSlot: (state: KimiSdkSessionState) => { waitForPrior?: Promise<void>; release: () => void };
  }>();
  private pendingUpdateSlots = new WeakMap<object, { waitForPrior?: Promise<void>; release: () => void }>();
  /** Resolves once `initialize` has completed so subsequent RPCs can proceed. */
  private initPromise: Promise<void> | null = null;
  /** Models returned by the first ACP `newSession` call, cached for the
   *  lifetime of this provider connection. Populated on first session create. */
  private cachedModels: Array<{ id: string; name?: string }> | null = null;
  private cachedDefaultModel: string | null = null;
  /** Negotiated ACP support for durable `session/list` discovery. */
  private sessionListSupported = false;
  private isDisconnecting = false;
  private sharedConnectInFlight: Promise<void> | null = null;
  private sharedRecycleInFlight: Promise<void> | null = null;
  private pendingSharedRecycle = false;
  private sharedExecutableFingerprint: AcpExecutableFingerprint | null = null;
  private sharedHasStartedOnce = false;
  private readonly sharedSessionReadyInFlight = new Set<string>();
  private idleHibernateTimer: ReturnType<typeof setTimeout> | null = null;
  private idleSweepInFlight: Promise<void> | null = null;

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
    if (this.profile.perSessionTransport) {
      this.config = config;
      logger.info({ provider: this.id }, `${this.profile.displayName} SDK provider connected lazily (per-session ACP)`);
      return;
    }
    if (this.id === AGY_SDK_PROVIDER_ID && inIncognitoContext()) {
      // Never spawn a shared process against real HOME while launching an incognito session.
      this.config = config;
      logger.info({ provider: this.id }, `${this.profile.displayName} SDK provider connected lazily for incognito session`);
      return;
    }
    await this.startAcpServer(config);
    this.config = config;
    logger.info({ provider: this.id }, `${this.profile.displayName} SDK provider connected via ACP`);
  }

  private async ensureSharedAcpConnected(): Promise<void> {
    if (this.profile.perSessionTransport) return;
    if (this.sharedRecycleInFlight) {
      await this.sharedRecycleInFlight.catch(() => {});
    }
    if (this.connection || !this.config || this.isDisconnecting) return;
    const inflight = this.sharedConnectInFlight ??= this.startAcpServer(this.config, undefined, {
      refreshExecutable: this.sharedHasStartedOnce,
    }).finally(() => {
      if (this.sharedConnectInFlight === inflight) this.sharedConnectInFlight = null;
    });
    await inflight;
  }

  private usesIsolatedTransport(state: KimiSdkSessionState): boolean {
    return Boolean(state.incognito || this.profile.perSessionTransport);
  }

  private connectionForState(state: KimiSdkSessionState): ClientSideConnection | null {
    return this.usesIsolatedTransport(state) ? (state.isolatedTransport?.connection ?? null) : this.connection;
  }

  private initPromiseForState(state: KimiSdkSessionState): Promise<void> | null {
    return this.usesIsolatedTransport(state) ? (state.isolatedTransport?.initPromise ?? null) : this.initPromise;
  }

  private async disposeIsolatedSession(
    state: KimiSdkSessionState,
    opts?: { removeSession?: boolean; bestEffortCloseSession?: boolean; preserveResumeId?: boolean },
  ): Promise<void> {
    if (state.isolatedDisposeInFlight) {
      await state.isolatedDisposeInFlight;
      if (opts?.removeSession && this.sessions.get(state.routeId) === state) {
        this.sessions.delete(state.routeId);
      }
      return;
    }
    const run = (async () => {
      this.closeAgyBridges(state);
      if (state.incognito) state.disposed = true;
      const transport = state.isolatedTransport;
      const acpSessionId = state.acpSessionId;
      const connection = transport?.connection ?? null;
      const activeChild = transport?.child ?? null;

      if (
        opts?.bestEffortCloseSession
        && acpSessionId
        && state.loaded
        && connection
        && activeChild
        && activeChild.exitCode === null
        && !activeChild.killed
      ) {
        const closer = (connection as AcpAgent).closeSession;
        if (typeof closer === 'function') {
          await Promise.race([
            closer.call(connection, { sessionId: acpSessionId }).catch(() => {}),
            new Promise<void>((resolve) => setTimeout(resolve, 500)),
          ]);
        }
      }

      if (!opts?.preserveResumeId) {
        if (acpSessionId) this.releaseAcpRoute(acpSessionId, state.routeId);
        state.acpSessionId = undefined;
      }
      state.loaded = false;
      state.modeApplied = false;
      state.confirmedModel = undefined;
      state.sessionSystemTextInjected = undefined;
      if (opts?.removeSession && this.sessions.get(state.routeId) === state) {
        this.sessions.delete(state.routeId);
      }

      if (!transport) return;
      const isolatedChild = transport.child;
      state.isolatedTransport = undefined;
      transport.child = null;
      transport.connection = null;
      transport.initPromise = null;
      transport.sessionListSupported = false;

      if (isolatedChild) {
        // Call killProcessTree even when the root ACP child already exited: same-group
        // descendants/native workers can outlive the exited leader and must be reaped
        // before deleting incognitoEnv.homeDir or hibernating a per-session process.
        const alive = isolatedChild.exitCode === null && isolatedChild.signalCode === null;
        const exitPromise = alive ? once(isolatedChild, 'exit').catch(() => {}) : null;
        if (alive) {
          try { isolatedChild.stdin?.end(); } catch { /* noop */ }
        }
        await killProcessTree(isolatedChild, { ownsProcessGroup: true, gracefulMs: 200 });
        if (exitPromise && isolatedChild.exitCode === null && isolatedChild.signalCode === null) {
          await Promise.race([
            exitPromise,
            new Promise<void>((resolve) => setTimeout(resolve, 500)),
          ]);
        }
      }
      if (transport.incognitoEnv) {
        await transport.incognitoEnv.cleanup();
        transport.incognitoEnv = undefined;
      }
    })();
    state.isolatedDisposeInFlight = run;
    try {
      await run;
    } finally {
      if (state.isolatedDisposeInFlight === run) {
        state.isolatedDisposeInFlight = undefined;
      }
    }
  }

  getMemoryMcpStatus(): MemoryMcpProviderStatusView {
    const hasIsolated = [...this.sessions.values()].some((s) => Boolean(this.usesIsolatedTransport(s) && s.isolatedTransport?.connection));
    const ready = Boolean(this.config && (this.profile.perSessionTransport || this.connection || hasIsolated));
    return {
      providerId: this.id,
      status: ready ? MEMORY_MCP_STATUS.READY : MEMORY_MCP_STATUS.UNKNOWN,
      connected: ready,
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
    const backgroundTaskCount = this.id === AGY_SDK_PROVIDER_ID
      ? (state.agyBackgroundTasks?.size ?? 0)
      : 0;
    const activeToolCount = [...state.toolCalls.values()]
      .filter((tool) => tool.status === 'pending' || tool.status === 'in_progress').length;
    const orphanToolCount = !state.promptInFlight && !state.replaying && pendingApprovalCount === 0
      ? activeToolCount
      : 0;
    const activeWorkCount = Number(state.promptInFlight) + Number(state.replaying) + pendingApprovalCount + backgroundTaskCount + orphanToolCount;
    const busyReasons: ProviderActiveWorkSnapshot['busyReasons'] = [];
    if (state.promptInFlight || pendingApprovalCount > 0) busyReasons.push('provider_wait');
    if (state.replaying) busyReasons.push('provider_session_binding');
    if (activeToolCount > 0) busyReasons.push('open_tool_call');
    if (backgroundTaskCount > 0) busyReasons.push('background_monitor');
    return {
      status: 'current',
      activeWorkCount,
      ...(this.id === AGY_SDK_PROVIDER_ID ? { backgroundWorkCount: backgroundTaskCount } : {}),
      activeToolCount,
      busyReasons,
      providerDiagnosticGeneration: state.acpSessionId ?? null,
      updatedAt: Date.now(),
    };
  }

  async disconnect(): Promise<void> {
    this.isDisconnecting = true;
    if (this.idleHibernateTimer) {
      clearTimeout(this.idleHibernateTimer);
      this.idleHibernateTimer = null;
    }
    try {
      await this.idleSweepInFlight?.catch(() => {});
      await this.sharedRecycleInFlight?.catch(() => {});
      await this.sharedConnectInFlight?.catch(() => {});
      this.cancelPendingApprovals();
      const states = [...this.sessions.values()];
      for (const state of states) this.closeAgyBridges(state);
      await Promise.all([
        this.teardownChild(),
        ...states.map((state) => this.disposeIsolatedSession(state, { removeSession: true })),
      ]);
      this.acpToRoute.clear();
      this.acpRouteOrder.clear();
      this.sessions.clear();
      this.config = null;
      this.initPromise = null;
      this.sharedConnectInFlight = null;
      this.sharedRecycleInFlight = null;
      this.pendingSharedRecycle = false;
      this.sharedExecutableFingerprint = null;
      this.sharedHasStartedOnce = false;
      this.sharedSessionReadyInFlight.clear();
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
    const existing = config.fresh ? undefined : prior;
    const incognito = config.incognito === true || existing?.incognito === true;
    if (incognito && this.id !== AGY_SDK_PROVIDER_ID) {
      throw this.makeError(PROVIDER_ERROR_CODES.CONFIG_ERROR, `${this.profile.displayName} does not support incognito sessions.`, false);
    }
    if (incognito && config.resumeId) {
      throw this.makeError(PROVIDER_ERROR_CODES.PROVIDER_ERROR, 'Incognito conversation cannot be resumed; start a fresh session.', false);
    }
    if (incognito && !config.fresh && (prior?.acpSessionId || prior?.disposed)) {
      throw this.makeError(PROVIDER_ERROR_CODES.PROVIDER_ERROR, 'Incognito conversation ended; start a new session instead of resuming history.', false);
    }
    const shouldDisposePrior = Boolean(
      prior && (
        (prior.incognito && (config.fresh || !incognito || prior.disposed))
        || (this.profile.perSessionTransport && config.fresh && prior.isolatedTransport)
      ),
    );
    if (prior) {
      this.closeAgyBridges(prior);
      if (shouldDisposePrior) prior.cancelled = true;
    }
    setSessionIncognito(routeId, incognito);
    if (config.sessionName && config.sessionName !== routeId) {
      setSessionIncognito(config.sessionName, incognito);
    }
    const explicitAgentId = typeof config.agentId === 'string' && config.agentId.trim()
      ? config.agentId.trim()
      : undefined;
    const inheritedModel = existing?.model;
    const profileDefaultModel = !explicitAgentId && !inheritedModel && !config.resumeId
      ? this.profile.defaultModel
      : undefined;
    const baseSourceHome = incognito
      ? (existing?.isolatedTransport?.sourceHome ?? resolveAgySourceHome(config.env, this.config?.env as Record<string, string> | undefined))
      : undefined;
    const state: KimiSdkSessionState = {
      routeId,
      sessionName: config.sessionName ?? existing?.sessionName,
      projectName: config.projectName ?? existing?.projectName,
      serverId: config.serverId ?? existing?.serverId,
      cwd: normalizeTransportCwd(config.cwd) ?? existing?.cwd ?? normalizeTransportCwd(process.cwd())!,
      env: config.env ?? existing?.env,
      contextNamespace: config.contextNamespace ?? existing?.contextNamespace,
      model: explicitAgentId ?? inheritedModel ?? profileDefaultModel,
      modelIsDefault: !explicitAgentId && (inheritedModel ? existing?.modelIsDefault : !!profileDefaultModel),
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
      lastActivityAt: Date.now(),
      sessionSystemTextInjected: existing?.sessionSystemTextInjected,
      agyForeground: this.id === AGY_SDK_PROVIDER_ID && existing?.acpSessionId === (config.resumeId ?? existing?.acpSessionId) && existing?.agyForeground?.authoritative
        ? Object.assign(new AgyForegroundOwnership(),{authoritative:true}) : undefined,
      ...(incognito ? {
        incognito: true,
        isolatedTransport: existing?.isolatedTransport ?? {
          child: null,
          connection: null,
          initPromise: null,
          sessionListSupported: false,
          sourceHome: baseSourceHome,
        },
      } : this.profile.perSessionTransport && !config.fresh && existing?.isolatedTransport ? {
        isolatedTransport: existing.isolatedTransport,
      } : {}),
    };
    if (prior?.acpSessionId && prior.acpSessionId !== state.acpSessionId) {
      this.releaseAcpRoute(prior.acpSessionId, routeId);
    }
    this.sessions.set(routeId, state);
    if (state.acpSessionId) {
      this.registerAcpRoute(state.acpSessionId, routeId);
      this.emitSessionInfo(routeId, { resumeId: state.acpSessionId });
    }
    if (shouldDisposePrior && prior) {
      await this.disposeIsolatedSession(prior, prior.incognito ? undefined : { bestEffortCloseSession: true });
    }
    return routeId;
  }

  async endSession(sessionId: string): Promise<void> {
    const state = this.sessions.get(sessionId);
    if (!state) return;
    this.cancelPendingApprovals(sessionId);
    if (this.usesIsolatedTransport(state)) {
      await this.disposeIsolatedSession(state, { removeSession: true, bestEffortCloseSession: true });
      this.refreshIdleHibernateTimer();
      return;
    }
    this.closeAgyBridges(state);
    this.sessions.delete(state.routeId);
    const removedSoleAcpRoute = state.acpSessionId
      ? this.releaseAcpRoute(state.acpSessionId, state.routeId)
      : false;
    const connection = this.connectionForState(state);
    // ACP has a session/close RPC (optional capability). We call it best-effort
    // so the agent can free state; if it fails, the session is still gone on
    // our side. closeSession is optional on the Agent interface so we have to
    // feature-detect.
    if (state.acpSessionId && state.loaded && connection && removedSoleAcpRoute) {
      const closer = (connection as AcpAgent).closeSession;
      if (typeof closer === 'function') {
        await closer.call(connection, { sessionId: state.acpSessionId }).catch(() => {});
      }
    }
    this.scheduleDeferredSharedRecycleIfDrained();
  }

  async detachSession(sessionId: string): Promise<void> {
    const state = this.sessions.get(sessionId);
    if (!state) return;
    this.cancelPendingApprovals(sessionId);
    if (this.usesIsolatedTransport(state)) {
      await this.disposeIsolatedSession(state, { removeSession: true });
      this.refreshIdleHibernateTimer();
      return;
    }
    this.closeAgyBridges(state);
    this.sessions.delete(state.routeId);
    if (state.acpSessionId) this.releaseAcpRoute(state.acpSessionId, state.routeId);
    this.scheduleDeferredSharedRecycleIfDrained();
  }

  async restoreSession(sessionId: string): Promise<boolean> {
    const state = this.sessions.get(sessionId)
      ?? [...this.sessions.values()].find((candidate) => candidate.acpSessionId === sessionId);
    if (!state || state.incognito) return false;
    if (state.loaded) return true;
    try {
      if (!this.profile.perSessionTransport) {
        await this.ensureSharedAcpConnected();
      }
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
    if (!this.profile.perSessionTransport) {
      await this.ensureSharedAcpConnected().catch(() => {});
    }
    const directoryRequested = options.directory !== undefined;
    const queryDirectory = normalizeTransportCwd(options.directory);
    const expectedDirectory = canonicalizeTransportCwd(options.directory);
    const slot = this.profile.perSessionTransport
      ? [...this.sessions.values()].find((s) => !s.incognito && s.isolatedTransport?.connection)?.isolatedTransport
      : null;
    if (slot?.initPromise) {
      await slot.initPromise.catch(() => {});
    }
    const connection = this.profile.perSessionTransport ? (slot?.connection ?? null) : this.connection;
    const supported = this.profile.perSessionTransport ? Boolean(slot?.sessionListSupported) : this.sessionListSupported;
    if (
      (directoryRequested && (!queryDirectory || !expectedDirectory))
      || !connection
      || !supported
    ) {
      return [];
    }

    const sessions: RemoteSessionInfo[] = [];
    const seenCursors = new Set<string>();
    let cursor: string | undefined;
    do {
      const result = await connection.listSessions({
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
    state.agyBridges?.clear(); state.agyBackgroundTasks?.clear(); state.agyReactive = false;
    state.agyPendingResponses?.clear(); state.agyNativeAcks = [];
    const nativeAuthority = state.agyForeground?.authoritative;
    state.agyForeground?.clear();
    if (state.agyForeground) state.agyForeground.authoritative = !!nativeAuthority;
    state.agyProvisionalAutoMessageId = undefined;
    state.agyPendingNativeTools?.clear(); state.agyConsumedNativeTools?.clear(); state.agyNativeToolOrder = [];
    state.agyRecentAcpOutputs = [];
  }

  /**
   * Track AG native background tasks (e.g. `run_command` exceeding
   * WaitMsBeforeAsync or one-shot `schedule` timers) across prompt boundaries
   * so `end_turn` while a background command is still executing does not
   * falsely mark the session idle or trigger Task Pair both-idle nudges.
   */
  private updateAgyBackgroundTasks(
    sessionId: string,
    state: KimiSdkSessionState,
    opts: { text?: string; isSystemMessage?: boolean; toolName?: string; toolInput?: unknown; toolStatus?: string },
  ): void {
    if (this.id !== AGY_SDK_PROVIDER_ID) return;
    const tasks = state.agyBackgroundTasks ??= new Set<string>();
    const prevSize = tasks.size;
    const text = opts.text ?? '';

    if (opts.isSystemMessage && AGY_BACKGROUND_TASKS_RESTART_RE.test(text)) {
      tasks.clear();
    } else {
      if (!isAgySubagentTool(opts.toolName ?? '') && !isRecurringAgyScheduleTool(opts.toolName, opts.toolInput)) {
        for (const id of extractAgyBackgroundTaskStartIds(text)) tasks.add(id);
      }
      for (const id of extractAgyBackgroundTaskTerminalIds(text, opts)) tasks.delete(id);
    }

    const nextSize = tasks.size;
    if (state.promptInFlight) return;
    if (prevSize === 0 && nextSize > 0) {
      this.emitStatus(sessionId, state, { status: 'waiting', label: 'Running background task' });
    } else if (prevSize > 0 && nextSize === 0 && !state.agyReactive) {
      // Force-clear status even when settleTurn already recorded a null status
      // signature, allowing TransportSessionRuntime to transition tool_running -> idle.
      state.lastStatusSignature = null;
      this.clearStatus(sessionId, state);
      this.scheduleDeferredSharedRecycleIfDrained();
    }
  }

  private recordRetiredToolCallIds(state: KimiSdkSessionState, ids: Iterable<string>): void {
    const retired = (state.retiredToolCallIds ??= new Set());
    for (const id of ids) {
      retired.delete(id);
      retired.add(id);
    }
    while (retired.size > 512) {
      const oldest = retired.values().next().value;
      if (oldest === undefined) break;
      retired.delete(oldest);
    }
  }

  private retireOpenToolCalls(
    sessionId: string,
    state: KimiSdkSessionState,
    opts: {
      terminalStatus: ToolTerminalStatus;
      terminalReason: ToolTerminalReason;
      decisionReason: string;
      excludeToolId?: string;
    },
  ): void {
    const retiredIds: string[] = [];
    const retiredEvents: ToolCallEvent[] = [];
    const preserved = new Map<string, MergedToolCall>();
    const preservedSignatures = new Map<string, string>();
    for (const [toolCallId, merged] of state.toolCalls.entries()) {
      if (opts.excludeToolId !== undefined && toolCallId === opts.excludeToolId) {
        preserved.set(toolCallId, merged);
        const sig = state.emittedToolSignatures.get(toolCallId);
        if (sig !== undefined) preservedSignatures.set(toolCallId, sig);
        continue;
      }
      retiredIds.push(toolCallId);
      if (mapToolStatus(merged.status) === 'running') {
        retiredEvents.push({
          id: toolCallId,
          name: merged.title,
          status: opts.terminalStatus === 'errored' ? 'error' : 'complete',
          ...(merged.rawInput !== undefined ? { input: merged.rawInput } : {}),
          terminalStatus: opts.terminalStatus,
          terminalReason: opts.terminalReason,
          terminalSynthetic: true,
          terminalSource: 'provider_snapshot',
          terminalDecisionReason: opts.decisionReason,
          terminalIdempotencyKey: `acp-retire:${sessionId}:${toolCallId}:${opts.terminalReason}`,
        });
      }
    }
    this.recordRetiredToolCallIds(state, retiredIds);
    state.toolCalls.clear();
    state.emittedToolSignatures.clear();
    for (const [id, merged] of preserved) state.toolCalls.set(id, merged);
    for (const [id, sig] of preservedSignatures) state.emittedToolSignatures.set(id, sig);
    for (const evt of retiredEvents) {
      for (const cb of this.toolCallCallbacks) cb(sessionId, evt);
    }
  }

  private shouldIgnoreRetiredOrOrphanToolUpdate(
    state: KimiSdkSessionState,
    update: Extract<SessionUpdate, { sessionUpdate: 'tool_call' | 'tool_call_update' }> & {
      toolCallId: string;
      status?: string | null;
    },
  ): boolean {
    if (state.toolCalls.has(update.toolCallId)) return false;
    if (state.retiredToolCallIds?.has(update.toolCallId)) return true;
    if (update.sessionUpdate === 'tool_call_update' && !state.promptInFlight) {
      return mapToolStatus(update.status ?? 'completed') === 'running';
    }
    return false;
  }

  private useAgyNativeOutput(state: KimiSdkSessionState, excludeToolId?: string): void {
    if (this.id !== AGY_SDK_PROVIDER_ID) return;
    (state.agyForeground ??= new AgyForegroundOwnership()).authoritative = true;
    state.agyNativeAcks = [];
    // A provisional ACP autonomous stream has no RPC owner. Its native step
    // will settle it; do not leave an unowned active generation blocking it.
    if (state.autonomousTurnGeneration !== undefined && !state.agyBridging) {
      state.agyProvisionalAutoMessageId = state.currentMessageId ?? undefined;
      state.activePromptGenerations?.delete(state.autonomousTurnGeneration);
      state.autonomousTurnGeneration = undefined;
      if ((state.activePromptGenerations?.size ?? 0) === 0) {
        state.promptInFlight = false;
        state.promptSubmittedGeneration = null;
        this.clearStatus(state.routeId, state);
        this.retireOpenToolCalls(state.routeId, state, {
          terminalStatus: 'abandoned',
          terminalReason: 'generation_rollover',
          decisionReason: 'provisional_native_handoff',
          excludeToolId,
        });
      }
      state.currentText = ''; state.currentMessageId = null;
      this.steeringRunTerminals.get(state)?.complete();
    }
  }

  private async startAgyBridge(sessionId: string, state: KimiSdkSessionState, childId?: string): Promise<void> {
    if (this.id !== AGY_SDK_PROVIDER_ID || !state.acpSessionId
      || this.sessions.get(sessionId) !== state || state.cancelled || state.stoppedByCancel) return;
    const id = childId ?? state.acpSessionId;
    const bridges = state.agyBridges ??= new Map();
    const existing = bridges.get(id);
    if (existing) { if (childId && existing.isClosed) await existing.resume(); return; }
    const env = { ...process.env, ...(this.config?.env as Record<string,string> | undefined), ...state.env };
    const file = agyTranscriptFile(env.HOME || env.USERPROFILE || '', id);
    if (!file) return;
    const bridge = new AgyTranscriptBridge(file, (row, cursor) => {
      if (this.sessions.get(sessionId) !== state || state.cancelled || state.stoppedByCancel) return;
      this.handleAgyTranscriptRow(sessionId, state, id, row, cursor);
    });
    bridges.set(id, bridge);
    await bridge.start(!!childId);
    if (this.sessions.get(sessionId) !== state || state.cancelled) bridge.close();
  }

  private publishAgySubagents(sessionId: string, state: KimiSdkSessionState, events: ToolCallEvent[]): void {
    for (const event of events) {
      for (const cb of this.toolCallCallbacks) cb(sessionId, event);
      const id = event.detail?.meta?.agentPath;
      // A native result/snapshot, not a caller-supplied send_message target,
      // authorizes observing a child's transcript. Retain cursors on reuse.
      if (typeof id !== 'string' || id === state.acpSessionId || !state.agySubagents?.isNativeChild(id)) continue;
      if (event.detail?.meta?.active) void this.startAgyBridge(sessionId, state, id);
      else state.agyBridges?.get(id)?.close();
    }
  }

  private handleAgyTranscriptRow(sessionId: string, state: KimiSdkSessionState, nativeId: string, row: AgyTranscriptRow, cursor?: AgyTranscriptCursor): void {
    const tracker = state.agySubagents ??= new AgySubagentTracker(state.acpSessionId ?? sessionId);
    const publish = (events: ToolCallEvent[]) => this.publishAgySubagents(sessionId, state, events);
    if (nativeId !== state.acpSessionId) {
      if (row.type === 'PLANNER_RESPONSE' && row.content?.trim() && !row.tool_calls?.length) {
        publish(tracker.snapshot({conversationId:nativeId,status:'completed',stateDetail:row.content}, 'native_completion'));
        state.agyBridges?.get(nativeId)?.close(); // Retain cursor for an explicit send_message reuse, never replay its old completion.
      }
      return;
    }
    const claimedByForeground = state.agyForeground?.observe(row, cursor) === true;
    if (row.type === 'SYSTEM_MESSAGE' && /\[Message\].*sender=/.test(row.content ?? '')) this.useAgyNativeOutput(state);
    if (row.type === 'USER_INPUT') {
      state.agyNativeToolOrder = [];
    }
    if (row.type === 'PLANNER_RESPONSE') {
      if (row.tool_calls?.length) {
        if (row.tool_calls.some(call => /^(invokesubagent|browsersubagent|sendmessage|swarm)$/.test(normalizeAgyToolName(call.name ?? '')))) this.useAgyNativeOutput(state);
        for (const [index,call] of row.tool_calls.entries()) (state.agyNativeToolOrder ??= []).push({name:call.name ?? '',input:call.args,step:row.step_index,index});
      } else {
        // Final response without tool_calls closes the tool batch so skipped/errored
        // tool calls from an earlier step cannot misalign future GENERIC rows.
        state.agyNativeToolOrder = [];
      }
    }
    if (row.type === 'GENERIC' && row.content) {
      const matched = matchAgyGenericRowToNativeTool(state, row);
      this.updateAgyBackgroundTasks(sessionId, state, {
        text: row.content,
        toolName: matched?.orderEntry.name,
        toolInput: matched?.orderEntry.input,
      });
      if (matched && isAgySubagentTool(matched.orderEntry.name)) {
        const { orderEntry: nativeTool, pending } = matched;
        const toolId = pending?.id ?? `${state.acpSessionId}:native-tool:${nativeTool.step}:${nativeTool.index}`;
        state.agyPendingNativeTools?.delete(toolId);
        (state.agyConsumedNativeTools ??= new Set()).add(toolId);
        const pendingOutput = pending && pending.status !== 'running' && pending.output?.trim()
          ? pending.output
          : undefined;
        const pendingIds = pendingOutput ? extractAgySubagentEvidenceChildIds(pendingOutput) : [];
        const rowIds = extractAgySubagentEvidenceChildIds(row.content);
        const rowAddsChildId = rowIds.some((childId) => !pendingIds.includes(childId));
        // If ACP already delivered non-empty terminal output and this transcript row
        // reveals no new child ID, emitMergedToolCall already published it; avoid
        // duplicating emissions or letting transcript prose replace ACP rawOutput.
        if (!pendingOutput || rowAddsChildId) {
          const output = rowAddsChildId ? row.content : (pendingOutput ?? row.content);
          const events = tracker.tool({
            id: toolId,
            name: nativeTool.name,
            input: pending?.input ?? nativeTool.input,
            status: pending?.status === 'error' ? 'error' : 'complete',
            output,
          });
          publish(events);
        }
      }
    }
    if (row.type === 'USER_INPUT' || claimedByForeground) state.agyReactive = false;
    if (row.type === 'SYSTEM_MESSAGE' && /\[Message\].*sender=/.test(row.content ?? '') && !state.agyForeground?.hasActiveLane()) state.agyReactive = true;
    if (row.type === 'SYSTEM_MESSAGE' && row.content) {
      this.updateAgyBackgroundTasks(sessionId, state, { text: row.content, isSystemMessage: true });
    }
    if (claimedByForeground || row.type !== 'PLANNER_RESPONSE' || !row.content?.trim() || row.tool_calls?.length || !state.agyReactive) return;
    state.agyReactive = false;
    (state.agyPendingResponses ??= new Map()).set(row.step_index, row);
    this.deliverAgyPendingResponses(sessionId,state);
  }

  private deliverAgyPendingResponses(sessionId: string, state: KimiSdkSessionState): void {
    if (this.sessions.get(sessionId) !== state || state.cancelled || state.stoppedByCancel || state.promptInFlight) return;
    for (const [step, row] of state.agyPendingResponses ?? []) {
      if (state.promptInFlight || this.sessions.get(sessionId) !== state) return;
      state.agyPendingResponses!.delete(step);
      // A native ACP autonomous completion acknowledges one ordered reactive
      // response, not every row read while a foreground RPC was pending. This
      // preserves a new child wakeup that beats the PREVIOUS RPC's delayed ack.
      const ack = state.agyNativeAcks?.[0];
      if (ack !== undefined && ack.text === row.content!.trimEnd()) { state.agyNativeAcks!.shift(); continue; }
      state.agyBridging = true;
      try {
        this.startAutonomousTurn(sessionId,state);
        const generation = state.autonomousTurnGeneration!;
        state.currentMessageId = state.agyProvisionalAutoMessageId ?? `${state.acpSessionId}:step:${row.step_index}`; state.agyProvisionalAutoMessageId = undefined; state.currentText = row.content!;
        state.lastTurnUsage = {input_tokens:row.input_tokens,output_tokens:row.output_tokens,cache_read_input_tokens:row.cache_read_tokens};
        this.emitStatus(sessionId,state,{status:'streaming',label:null});
        for (const cb of this.deltaCallbacks) cb(sessionId,{messageId:state.currentMessageId,type:'text',delta:row.content!,role:'assistant'});
        (state.activePromptGenerations ??= new Set()).add(generation);
        this.settleTurn(sessionId,state,generation,'end_turn');
      } finally { state.agyBridging = false; }
    }
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
    state.modelIsDefault = false;
    if (state.model !== agentId) { state.model = agentId; state.modelRevision++; state.modelControlIntent = undefined; }
    if (this.profile.strictModelSelection) return;
    // If session already loaded, best-effort push the model change via the
    // experimental RPC. Swallow errors: if the CLI version predates it,
    // subsequent prompts still use the original model — still correct, just
    // not the requested one.
    const connection = this.connectionForState(state);
    if (state.acpSessionId && state.loaded && connection) {
      const setter = (connection as AcpAgent).unstable_setSessionModel;
      if (typeof setter === 'function') {
        void setter.call(connection, {
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
    const connection = this.connectionForState(state);
    if (!state.loaded || !state.acpSessionId || !connection || state.cancelled) return SESSION_MODEL_APPLIED.NEXT_START;
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
    const connection = this.connectionForState(state);
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
            this.logAcpFailure(error, ACP_ERROR_PHASE.CONFIRM_MODEL);
            // Report only our own bounded model guidance, never raw ACP diagnostics.
            if (error instanceof RequestError && /unknown model|unsupported model|model.*not supported/i.test(error.message)) {
              throw this.makeError(PROVIDER_ERROR_CODES.CONFIG_ERROR,
                `Selected ${this.profile.displayName} model is unavailable; choose a supported model and retry.`, false);
            }
            throw error;
          }
          // Even a superseded successful RPC changed native state. Invalidate
          // the old cached model before the intent check (A→B→A must reapply A).
          if (this.sessions.get(sessionId) === state && this.connectionForState(state) === connection && state.acpSessionId === nativeId) {
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
      if (!this.acpDiagnosticFields(error).acpPhase) this.logAcpFailure(error, ACP_ERROR_PHASE.CONFIRM_MODEL);
      throw error;
    }
    if (outcome.timedOut) {
      if (state.modelRevision === revision) { state.modelRevision++; state.confirmedModel = undefined; }
      const error = this.makeError(PROVIDER_ERROR_CODES.PROVIDER_ERROR, 'ACP model selection was not confirmed before its deadline', true);
      this.logAcpFailure(error, ACP_ERROR_PHASE.CONFIRM_MODEL);
      throw error;
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
    if (!this.config) {
      throw this.makeError(PROVIDER_ERROR_CODES.CONNECTION_LOST, `${this.profile.displayName} ACP server not connected`, false);
    }
    const state = this.sessions.get(sessionId);
    if (!state) {
      if (!this.profile.perSessionTransport && !this.connection) {
        throw this.makeError(PROVIDER_ERROR_CODES.CONNECTION_LOST, `${this.profile.displayName} ACP server not connected`, false);
      }
      throw this.makeError(PROVIDER_ERROR_CODES.SESSION_NOT_FOUND, `Unknown ${this.profile.displayName} SDK session: ${sessionId}`, false);
    }
    if (state.incognito && state.disposed) {
      throw this.makeError(PROVIDER_ERROR_CODES.SESSION_NOT_FOUND, 'Incognito session has been terminated; start a fresh session.', false);
    }
    if (!this.usesIsolatedTransport(state)) {
      if (this.sharedRecycleInFlight) {
        await this.sharedRecycleInFlight.catch(() => {});
      }
      if (!this.connection) {
        await this.ensureSharedAcpConnected();
        if (!this.connection) {
          throw this.makeError(PROVIDER_ERROR_CODES.CONNECTION_LOST, `${this.profile.displayName} ACP server not connected`, false);
        }
      }
    }
    if (state.promptInFlight) {
      throw this.makeError(PROVIDER_ERROR_CODES.PROVIDER_ERROR, `${this.profile.displayName} SDK session is already busy`, true);
    }
    state.lastActivityAt = Date.now();

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
    this.retireOpenToolCalls(sessionId, state, {
      terminalStatus: 'abandoned',
      terminalReason: 'generation_rollover',
      decisionReason: 'new_turn_started',
    });
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
    const hadBackgroundOrOpenTools = (state.agyBackgroundTasks?.size ?? 0) > 0
      || state.toolCalls.size > 0
      || [...this.pendingApprovals.values()].some((approval) => approval.routeId === sessionId);
    this.closeAgyBridges(state);
    this.cancelPendingApprovals(sessionId);
    for (const event of state.agySubagents?.interrupt() ?? []) {
      for (const cb of this.toolCallCallbacks) cb(sessionId, event);
    }
    this.retireOpenToolCalls(sessionId, state, {
      terminalStatus: 'cancelled',
      terminalReason: 'user_cancelled',
      decisionReason: state.promptInFlight ? 'session_cancelled' : 'session_cancelled_idle',
    });
    if (!state.promptInFlight) {
      if (hadBackgroundOrOpenTools) {
        state.lastStatusSignature = null;
        this.clearStatus(sessionId, state);
      }
      this.scheduleDeferredSharedRecycleIfDrained();
      return;
    }
    state.cancelled = true;
    const connection = this.connectionForState(state);
    if (!state.acpSessionId || !connection) return;
    // `cancel` is a one-shot notification; the pending prompt() Promise or
    // autonomous `turn_completed` terminal will settle the captured run when
    // native work actually stops. Never fabricate physical stop proof locally.
    await connection.cancel({ sessionId: state.acpSessionId }).catch((err: unknown) => {
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
      || !this.connectionForState(state)) {
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
    const connection = this.connectionForState(state);
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
      if (this.id === AGY_SDK_PROVIDER_ID) {
        const continuationCursor = state.acpSessionId
          ? state.agyBridges?.get(state.acpSessionId)?.currentCursor()
          : undefined;
        (state.agyForeground ??= new AgyForegroundOwnership()).register(
          generation,
          activePromptText,
          true,
          continuationCursor,
        );
      }
      const queuedPrompt = this.withAcpDiagnostics(ACP_ERROR_PHASE.PROMPT, () => connection.prompt({
        sessionId: state.acpSessionId,
        prompt: [{ type: 'text', text: activePromptText }],
        // ACP's canonical unstable messageId is the only provider-visible
        // correlation key available for a queued prompt. Derive a valid stable
        // UUID from IM.codes' durable notification id; the generation-scoped
        // admission map handles local retries, while capable ACP agents may use
        // this id to correlate a replay across their own history.
        messageId: stableAcpMessageId(notification.notificationId),
      }));
      this.promptTerminals.set(state, queuedPrompt);
      this.trackPromptSettlement(
        connection,
        state.acpSessionId,
        state,
        queuedPrompt,
        (result) => {
          if (this.profile.steeringPrompts && !state.activePromptGenerations?.has(generation)) return;
          return this.settleOwnedAcpPrompt(sessionId, state, generation, result);
        },
        (error: unknown) => {
          logger.warn({
            provider: this.id,
            sessionId,
            ...this.errorLogFields(error),
          }, 'ACP active-turn queued prompt failed after submission');
          this.failTurn(sessionId, state, generation, error);
        },
      );
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
      if (this.sessions.get(sessionId) !== state || state.cancelled || this.connectionForState(state) !== connection) {
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
  protected buildAcpArgs(_config: ProviderConfig, extraFlags: readonly string[] = []): string[] {
    return [...this.profile.args, ...extraFlags];
  }

  private async startPerSessionAcpServer(sessionId: string, state: KimiSdkSessionState): Promise<void> {
    if (!this.config) {
      throw this.makeError(PROVIDER_ERROR_CODES.CONNECTION_LOST, `${this.profile.displayName} ACP server not connected`, false);
    }
    if (state.isolatedTransport) {
      await this.disposeIsolatedSession(state, { bestEffortCloseSession: true, preserveResumeId: true });
    }
    await this.evictWarmPerSessionsIfNeeded(sessionId);
    const transport: IsolatedAcpTransport = {
      child: null,
      connection: null,
      initPromise: null,
      sessionListSupported: false,
    };
    state.isolatedTransport = transport;
    try {
      await this.startAcpServer(this.config, { sessionId, state, transport }, { refreshExecutable: true });
    } catch (error) {
      await this.disposeIsolatedSession(state, { preserveResumeId: true });
      throw error;
    }
  }

  private async startIsolatedAcpServer(sessionId: string, state: KimiSdkSessionState): Promise<void> {
    if (!this.config) {
      throw this.makeError(PROVIDER_ERROR_CODES.CONNECTION_LOST, `${this.profile.displayName} ACP server not connected`, false);
    }
    if (state.disposed) {
      throw this.makeError(PROVIDER_ERROR_CODES.SESSION_NOT_FOUND, 'Incognito session has been terminated; start a fresh session.', false);
    }
    const sourceHome = state.isolatedTransport?.sourceHome
      ?? resolveAgySourceHome(state.env, this.config.env as Record<string, string> | undefined);
    if (state.isolatedTransport) {
      await this.disposeIsolatedSession(state);
      state.disposed = false;
    }
    await reclaimOrphanedAgyIncognitoHomes().catch(() => 0);
    const incognitoEnv = createAgyIncognitoEnvSync(sourceHome, { skipReclaim: true });
    state.env = { ...(state.env ?? {}), ...incognitoEnv.env };
    const transport: IsolatedAcpTransport = {
      child: null,
      connection: null,
      initPromise: null,
      sessionListSupported: false,
      incognitoEnv,
      sourceHome,
    };
    state.isolatedTransport = transport;
    try {
      await this.startAcpServer(this.config, { sessionId, state, transport, incognitoEnv });
    } catch (error) {
      await this.disposeIsolatedSession(state);
      throw error;
    }
  }

  private async startAcpServer(
    config: ProviderConfig,
    isolatedFor?: {
      sessionId: string;
      state: KimiSdkSessionState;
      transport: IsolatedAcpTransport;
      incognitoEnv?: AgyIncognitoEnv;
    },
    options?: { refreshExecutable?: boolean },
  ): Promise<void> {
    if (!isolatedFor) {
      await this.teardownChild();
    }

    const createSharedTransportSlot = (): AcpTransportSlot => {
      const getChild = () => this.child;
      const setChild = (value: ChildProcessWithoutNullStreams | null) => { this.child = value; };
      const getConnection = () => this.connection;
      const setConnection = (value: ClientSideConnection | null) => { this.connection = value; };
      const getInitPromise = () => this.initPromise;
      const setInitPromise = (value: Promise<void> | null) => { this.initPromise = value; };
      const getSessionListSupported = () => this.sessionListSupported;
      const setSessionListSupported = (value: boolean) => { this.sessionListSupported = value; };
      return {
        get child() { return getChild(); },
        set child(value) { setChild(value); },
        get connection() { return getConnection(); },
        set connection(value) { setConnection(value); },
        get initPromise() { return getInitPromise(); },
        set initPromise(value) { setInitPromise(value); },
        get sessionListSupported() { return getSessionListSupported(); },
        set sessionListSupported(value) { setSessionListSupported(value); },
      };
    };
    const transport: AcpTransportSlot = isolatedFor
      ? isolatedFor.transport
      : createSharedTransportSlot();

    const resolved = this.resolveAcpExecutable(
      config,
      (!isolatedFor || this.profile.perSessionTransport) && options?.refreshExecutable
        ? { refresh: true }
        : undefined,
    );
    const fingerprint = captureExecutableFingerprint(resolved.executable, resolved.prependArgs[0]);
    if (!isolatedFor) {
      this.sharedHasStartedOnce = true;
      this.sharedExecutableFingerprint = fingerprint;
      this.pendingSharedRecycle = false;
    } else {
      isolatedFor.transport.executableFingerprint = fingerprint;
    }
    const args = [
      ...resolved.prependArgs,
      ...this.buildAcpArgs(config, isolatedFor?.incognitoEnv?.acpFlags),
    ];
    const env = isolatedFor
      ? {
        ...process.env,
        ...((config.env as Record<string, string> | undefined) ?? {}),
        ...(isolatedFor.state.env ?? {}),
        ...(isolatedFor.incognitoEnv?.env ?? {}),
      }
      : { ...process.env, ...((config.env as Record<string, string> | undefined) ?? {}) };
    const child = spawn(resolved.executable, args, {
      // Own process group and session on POSIX. A reparented descendant keeps
      // its PGID but loses its PPID, so after the agent parent dies this is the
      // only ownership token teardown still has. Without it the eight vitest
      // workers of the incident were unreachable on PPID=1.
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
      windowsHide: true,
    });
    transport.child = child;
    const childMetaWrite = isolatedFor?.incognitoEnv && typeof child.pid === 'number' && child.pid > 0
      ? isolatedFor.incognitoEnv.registerChildProcess(child.pid, process.platform !== 'win32')
      : Promise.resolve();
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

    const handleChildFailure = (err: Error, isSpawnError: boolean, errorCode?: string): void => {
      if (this.isDisconnecting || transport.child !== child) return;
      if (isSpawnError) {
        logger.error(
          { provider: this.id, errorCode: errorCode ?? 'spawn_failed' },
          `${this.profile.displayName} ACP spawn error`,
        );
      }
      if (isolatedFor) {
        const sid = isolatedFor.sessionId;
        if (this.sessions.get(sid) === isolatedFor.state) {
          this.cancelPendingApprovals(sid);
          if (this.clearSessionWorkAfterFailure(sid)) {
            this.emitError(sid, this.makeError(PROVIDER_ERROR_CODES.CONNECTION_LOST, err.message, true));
          }
        }
        void this.disposeIsolatedSession(isolatedFor.state, {
          preserveResumeId: !isolatedFor.state.incognito,
        });
        return;
      }
      this.cancelPendingApprovals();
      const sessions = [...this.sessions.keys()];
      for (const sid of sessions) {
        const state = this.sessions.get(sid);
        if (state?.incognito) continue;
        if (state) state.sessionSystemTextInjected = undefined;
        if (this.clearSessionWorkAfterFailure(sid)) {
          this.emitError(sid, this.makeError(PROVIDER_ERROR_CODES.CONNECTION_LOST, err.message, true));
        }
      }
      transport.child = null;
      transport.connection = null;
      transport.initPromise = null;
      transport.sessionListSupported = false;
    };

    child.on('exit', (code, signal) => {
      const err = new Error(`${this.profile.displayName} ACP server exited with code=${code} signal=${signal}`);
      handleChildFailure(err, false);
    });
    child.on('error', (err) => {
      handleChildFailure(err, true, (err as NodeJS.ErrnoException).code);
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
    type PendingPromptWrite = { onResponseArrived: () => void; clearPending: () => void };
    const pendingPromptWrites = new Map<string, PendingPromptWrite[]>();
    const inFlightPromptWrites = new Map<string | number, PendingPromptWrite>();
    const activeSlotReleasers = new Set<() => void>();
    const reserveSlot = (state: KimiSdkSessionState): { waitForPrior?: Promise<void>; release: () => void } => {
      const waitForPrior = state.wireOrderTail;
      let resolveSlot!: () => void;
      const slot = new Promise<void>((r) => { resolveSlot = r; });
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
    child.once('exit', releaseAllSlots);
    child.once('error', releaseAllSlots);

    const rawWriter = rawStream.writable.getWriter();
    const interceptedWritable = new WritableStream({
      write: (message) => {
        if (
          message
          && typeof message === 'object'
          && 'id' in message
          && message.id !== undefined
          && message.id !== null
          && (message as { method?: unknown }).method === 'session/prompt'
        ) {
          const sid = (message as { params?: { sessionId?: unknown } }).params?.sessionId;
          if (typeof sid === 'string') {
            const q = pendingPromptWrites.get(sid);
            const entry = q?.shift();
            if (q && q.length === 0) pendingPromptWrites.delete(sid);
            if (entry) {
              const reqId = message.id as string | number;
              inFlightPromptWrites.set(reqId, entry);
              entry.clearPending = () => { inFlightPromptWrites.delete(reqId); };
            }
          }
        }
        return rawWriter.write(message);
      },
      close: () => rawWriter.close(),
      abort: (reason) => rawWriter.abort(reason),
    }) as typeof rawStream.writable;

    // `@agentclientprotocol/sdk` validates `session/update` against a strict
    // Zod union that rejects non-standard `sessionUpdate` types (`turn_completed`,
    // runtime subagent events) and strips `usage_update.tokens`. Route
    // `session/update` notifications through `extNotification` so custom ACP
    // update payloads reach `handleSessionUpdate` intact.
    const stream = {
      writable: interceptedWritable,
      readable: rawStream.readable.pipeThrough(new TransformStream({
        transform: (message, controller) => {
          // Reserve per-session wire slots here in exact stream order BEFORE
          // downstream `ClientSideConnection.receive()` pulls/reorders microtasks
          // between `async prompt()` responses and synchronous notifications.
          if (
            message
            && typeof message === 'object'
            && 'id' in message
            && message.id !== undefined
            && message.id !== null
            && !('method' in message)
          ) {
            const entry = inFlightPromptWrites.get(message.id as string | number);
            if (entry) {
              inFlightPromptWrites.delete(message.id as string | number);
              entry.onResponseArrived();
            }
          } else if (message && typeof message === 'object' && !('id' in message)) {
            const method = (message as { method?: unknown }).method;
            const rawParams = (message as { params?: unknown }).params;
            if ((method === 'session/update' || method === '_x.ai/session/update') && rawParams && typeof rawParams === 'object') {
              const sid = (rawParams as { sessionId?: unknown }).sessionId;
              const routeId = typeof sid === 'string' ? this.acpToRoute.get(sid) : undefined;
              const state = routeId ? this.sessions.get(routeId) : undefined;
              if (state && state.acpSessionId === sid && state.wireOrderTail) {
                this.pendingUpdateSlots.set(rawParams, reserveSlot(state));
              }
            }
            if (method === 'session/update') {
              controller.enqueue({ ...(message as Record<string, unknown>), method: '_imcodes/session/update' });
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

    // Construct the ACP connection. The callback receives the Agent handle we
    // can use to call RPC methods; we return a Client impl that handles
    // reverse RPC (requestPermission + session notifications).
    const connection = new ClientSideConnection(() => this.createClientImpl(child, isolatedFor?.transport), stream);
    transport.connection = connection;
    this.promptWriteQueues.set(connection, Object.assign(pendingPromptWrites, { reserveSlot }));

    // Kick off initialize once; all subsequent calls await the same promise.
    const initPromise = (async () => {
      const result = await connection.initialize({
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
      transport.sessionListSupported = result.agentCapabilities.sessionCapabilities?.list != null;
      await this.validateConnectedAgent(result as unknown as Record<string, unknown>, config);
    })().catch((err: unknown) => {
      logger.error(
        { provider: this.id, errorCode: getPrivacySafeErrorCode(err) },
        `${this.profile.displayName} ACP initialize failed`,
      );
      throw err;
    });
    transport.initPromise = initPromise;

    let initTimer: ReturnType<typeof setTimeout> | undefined;
    const initTimeout = new Promise<never>((_resolve, reject) => {
      initTimer = setTimeout(
        () => reject(new Error(`${this.profile.displayName} ACP initialization timed out`)),
        15_000,
      );
      initTimer.unref?.();
    });
    try {
      await Promise.race([initPromise, spawnFailure, initTimeout]);
      await childMetaWrite;
    } catch (error) {
      if (isolatedFor) {
        await this.disposeIsolatedSession(isolatedFor.state, {
          preserveResumeId: !isolatedFor.state.incognito,
        });
      } else {
        await this.teardownChild();
      }
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
  private createClientImpl(child?: ChildProcessWithoutNullStreams, isolatedTransport?: AcpTransportSlot): AcpClient {
    const isCurrentChild = () => !child || (isolatedTransport ? isolatedTransport.child === child : this.child === child);
    return {
      requestPermission: async (
        params: RequestPermissionRequest,
      ): Promise<RequestPermissionResponse> => {
        if (!isCurrentChild()) return { outcome: { outcome: 'cancelled' } };
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
        if (isCurrentChild()) this.enqueueSessionUpdate(params);
      },
      extNotification: async (method: string, _params: Record<string, unknown>): Promise<void> => {
        if (method === '_x.ai/models/update' && _params && typeof _params === 'object') {
          this.cacheModelsFromSessionResponse({ models: _params as any } as NewSessionResponse);
          return;
        }
        if ((method === '_x.ai/session/update' || method === '_imcodes/session/update') && _params && typeof _params === 'object') {
          if (isCurrentChild()) this.enqueueSessionUpdate(_params as unknown as SessionNotification);
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
    if (this.id === AGY_SDK_PROVIDER_ID) (state.agyForeground ??= new AgyForegroundOwnership()).beginTurn();
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
      const connection = this.connectionForState(state)!;
      if (this.id === AGY_SDK_PROVIDER_ID) {
        const promptText = promptBlocks.map(b => b.type === 'text' ? b.text : '').join('');
        const rawAlias = payload.assembledMessage.trim();
        const companionAliases = rawAlias && rawAlias !== promptText.trim() ? [payload.assembledMessage] : undefined;
        (state.agyForeground ??= new AgyForegroundOwnership()).register(
          generation,
          promptText,
          false,
          undefined,
          companionAliases,
        );
      }
      const turn = this.withAcpDiagnostics(ACP_ERROR_PHASE.PROMPT, () => connection.prompt({
        sessionId: state.acpSessionId!,
        prompt: promptBlocks,
        messageId: randomUUID(),
      }));
      this.promptTerminals.set(state, turn);
      this.trackPromptSettlement(
        connection,
        state.acpSessionId!,
        state,
        turn,
        (result: PromptResponse) => {
          if (this.profile.steeringPrompts && !state.activePromptGenerations?.has(generation)) return;
          return this.settleOwnedAcpPrompt(sessionId, state, generation, result,
            includeSessionSystemText ? sessionContractKey : undefined, compactControl);
        },
        (err: unknown) => {
          this.failTurn(sessionId, state, generation, err);
        },
      );
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

  private async settleOwnedAcpPrompt(sessionId: string, state: KimiSdkSessionState, generation: number,
    result: PromptResponse, contractKey?: string, compactControl = false): Promise<void> {
    const owner = state.agyForeground;
    try {
      if (this.id === AGY_SDK_PROVIDER_ID) await state.agyBridges?.get(state.acpSessionId!)?.flush();
      this.assertCurrentSession(sessionId,state);
      if (!state.activePromptGenerations?.has(generation)) return;
      let attributedRow: AgyTranscriptRow | undefined;
      if (owner?.authoritative
        && state.activePromptGenerations.size === 1
        && result.stopReason !== 'cancelled'
        && !compactControl) {
        let targetGeneration = owner.resolveAggregateGeneration(generation);
        while (true) {
          owner.settle(targetGeneration);
          const output = await owner.output(targetGeneration);
          this.assertCurrentSession(sessionId,state);
          if (!state.activePromptGenerations?.has(generation)) return;
          if (state.activePromptGenerations.size > 1) break;
          if (owner.hasBoundSuccessor(targetGeneration)) {
            targetGeneration = owner.resolveAggregateGeneration(targetGeneration);
            continue;
          }
          if (!output) throw this.makeError(PROVIDER_ERROR_CODES.PROVIDER_ERROR,
            'AG native foreground output could not be attributed before its deadline',true);
          attributedRow = output;
          break;
        }
      }
      if (owner?.authoritative && state.activePromptGenerations.size === 1) {
        const row = attributedRow ?? owner.latest?.row;
        const text = compactControl ? '' : row?.content ?? '';
        // In async mode every published parent byte comes from the associated
        // native lane. Late ACP text/usage/turn_completed never enter here.
        const prior = state.currentText;
        state.currentText = text;
        state.currentMessageId ??= row ? `${state.acpSessionId}:step:${row.step_index}` : null;
        const delta = prior && text.startsWith(prior) ? text.slice(prior.length) : text;
        if (delta) for (const cb of this.deltaCallbacks) cb(sessionId,{
          messageId:state.currentMessageId!,type:'text',delta,role:'assistant'});
      }
      this.capturePromptUsage(state,result);
      this.settleTurn(sessionId,state,generation,result.stopReason,contractKey,compactControl);
    } finally {
      if ((state.activePromptGenerations?.size ?? 0) === 0) owner?.releaseTurn();
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
      if (state.agyForeground && !state.agyForeground.hasBoundInput(generation)) {
        state.agyForeground.release(generation);
      }
      // A rejected steering request is NOT proof that the original task or
      // another admitted prompt stopped. Retain busy/text/tools until all
      // native RPCs settle (connection death rejects them all as well).
      if (state.activePromptGenerations.size > 0 || state.autonomousTurnGeneration !== undefined) return;
      error = state.steeringFailure;
      state.steeringFailure = undefined;
      state.steeringTerminal = undefined;
    } else if (state.settledGeneration >= generation) return;
    if (this.id === AGY_SDK_PROVIDER_ID) this.closeAgyBridges(state);
    state.settledGeneration = state.turnGeneration;
    state.activePromptGenerations?.clear();
    state.autonomousTurnGeneration = undefined;
    state.promptInFlight = false;
    state.promptSubmittedGeneration = null;
    state.cancelled = false;
    state.stoppedByCancel = true;
    this.retireOpenToolCalls(sessionId, state, {
      terminalStatus: 'errored',
      terminalReason: 'provider_error',
      decisionReason: 'turn_failed',
    });
    state.sessionSystemTextInjected = undefined;
    this.cancelPendingApprovals(sessionId);
    this.clearStatus(sessionId, state);
    run?.complete();
    state.lastActivityAt = Date.now();
    this.refreshIdleHibernateTimer();
    if (this.isDisconnecting) return;
    this.emitError(sessionId, this.normalizeError(error));
    this.scheduleDeferredSharedRecycleIfDrained();
  }

  private assertCurrentSession(sessionId: string, state: KimiSdkSessionState, connection = this.connectionForState(state)): void {
    if (this.sessions.get(sessionId) !== state || state.cancelled || !connection || this.connectionForState(state) !== connection) {
      throw this.makeError(PROVIDER_ERROR_CODES.CANCELLED, 'ACP session owner changed or stopped', true);
    }
  }

  /** Create the session on the agent if it doesn't exist yet, otherwise
   *  resume it. Applies Kimi's `default` mode once per session. */
  private async ensureSessionReady(
    sessionId: string,
    state: KimiSdkSessionState,
  ): Promise<void> {
    if (state.incognito) {
      if (state.disposed) {
        throw this.makeError(PROVIDER_ERROR_CODES.SESSION_NOT_FOUND, 'Incognito session has been terminated; start a fresh session.', false);
      }
      if (state.acpSessionId && !state.loaded) {
        throw this.makeError(PROVIDER_ERROR_CODES.PROVIDER_ERROR, 'Incognito conversation cannot be resumed; start a new session.', false);
      }
    }

    let beforeNativeStartRan = false;
    let sharedRecycleRetried = false;

    while (true) {
      if (state.incognito) {
        const existingTransport = state.isolatedTransport;
        if (!existingTransport?.connection || !existingTransport.child || existingTransport.child.killed || existingTransport.child.exitCode !== null) {
          await this.startIsolatedAcpServer(sessionId, state);
        }
      } else if (this.profile.perSessionTransport) {
        this.sharedSessionReadyInFlight.add(sessionId);
        const existingTransport = state.isolatedTransport;
        const alive = Boolean(
          existingTransport?.connection
          && existingTransport.child
          && !existingTransport.child.killed
          && existingTransport.child.exitCode === null,
        );
        if (alive && this.hasExecutableFingerprintChanged(existingTransport?.executableFingerprint)) {
          await this.disposeIsolatedSession(state, { bestEffortCloseSession: true, preserveResumeId: true });
        }
        if (
          !state.isolatedTransport?.connection
          || !state.isolatedTransport.child
          || state.isolatedTransport.child.killed
          || state.isolatedTransport.child.exitCode !== null
        ) {
          await this.startPerSessionAcpServer(sessionId, state);
        }
      } else {
        if (!state.loaded && (this.pendingSharedRecycle || this.hasSharedExecutableChanged())) {
          if (this.hasActiveSharedSessionWork(sessionId)) {
            this.pendingSharedRecycle = true;
          } else {
            await this.recycleSharedAcpServer(this.pendingSharedRecycle ? 'deferred_drain' : 'binary_changed', sessionId);
          }
        }
        if (!this.connection && this.config) {
          await this.ensureSharedAcpConnected();
        }
      }
      const connection = this.connectionForState(state);
      if (!connection) {
        if (!state.incognito) this.sharedSessionReadyInFlight.delete(sessionId);
        throw this.makeError(
          PROVIDER_ERROR_CODES.CONNECTION_LOST,
          `${this.profile.displayName} ACP connection not ready`,
          false,
        );
      }
      if (!state.incognito) this.sharedSessionReadyInFlight.add(sessionId);
      try {
        await this.initPromiseForState(state);
        this.assertCurrentSession(sessionId, state, connection);

        if (!state.loaded) {
          if (!beforeNativeStartRan) {
            beforeNativeStartRan = true;
            await state.beforeNativeSessionStart?.();
            this.assertCurrentSession(sessionId, state, connection);
          }
          if (state.acpSessionId) {
            if (state.incognito) {
              throw this.makeError(PROVIDER_ERROR_CODES.PROVIDER_ERROR, 'Incognito conversation cannot be resumed; start a new session.', false);
            }
            // Resume an existing session (survives across CLI restarts via
            // ~/.kimi/tmp/<project>/chats/<id>.json).
            try {
              const loader = this.profile.resumeWithoutReplay
                ? (connection as AcpAgent).resumeSession
                : (connection as AcpAgent).loadSession;
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
                loadResult = await this.withAcpDiagnostics(this.profile.resumeWithoutReplay
                  ? ACP_ERROR_PHASE.RESUME_SESSION : ACP_ERROR_PHASE.LOAD_SESSION, () => loader.call(connection, {
                  sessionId: state.acpSessionId,
                  cwd: state.cwd,
                  mcpServers: this.mcpServersForState(state),
                }));
                if (state.wireOrderTail) await state.wireOrderTail;
              } finally {
                state.replaying = false;
              }
              this.assertCurrentSession(sessionId, state, connection);
              state.loaded = true;
              this.cacheModelsFromSessionResponse(loadResult);
              this.applySessionMetadata(sessionId, state, loadResult);
            } catch (err) {
              if (isWorkerSpawnMissingExecutableError(err)) throw err;
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

        if (!state.modeApplied && this.profile.defaultMode && state.acpSessionId && connection) {
          const modeSetter = (connection as AcpAgent).setSessionMode;
          if (typeof modeSetter === 'function') {
            await modeSetter.call(connection, {
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
        } else if (state.model && state.acpSessionId && connection) {
          const modelSetter = (connection as AcpAgent).unstable_setSessionModel;
          if (typeof modelSetter === 'function') {
            await modelSetter.call(connection, {
              sessionId: state.acpSessionId,
              modelId: state.model,
            }).catch((err: unknown) => {
              logger.debug({ provider: this.id, sessionId, ...this.errorLogFields(err, 'err') },
                'unstable_setSessionModel pre-turn failed (non-fatal)');
            });
          }
        }
        this.assertCurrentSession(sessionId, state, connection);
        return;
      } catch (err) {
        if (!state.incognito && !state.loaded && this.profile.perSessionTransport) {
          if (this.sessions.get(sessionId) === state) {
            await this.disposeIsolatedSession(state, { preserveResumeId: true });
          }
          if (!sharedRecycleRetried && isWorkerSpawnMissingExecutableError(err) && this.sessions.get(sessionId) === state && !state.cancelled) {
            sharedRecycleRetried = true;
            this.sharedSessionReadyInFlight.delete(sessionId);
            continue;
          }
        } else if (!state.incognito && !state.loaded && isWorkerSpawnMissingExecutableError(err)) {
          if (this.hasActiveSharedSessionWork(sessionId)) {
            this.pendingSharedRecycle = true;
            throw err;
          }
          if (!sharedRecycleRetried) {
            sharedRecycleRetried = true;
            this.sharedSessionReadyInFlight.delete(sessionId);
            await this.recycleSharedAcpServer('worker_spawn_enoent', sessionId);
            this.assertCurrentSession(sessionId, state);
            continue;
          }
        }
        if (state.incognito && !state.loaded && this.sessions.get(sessionId) === state) {
          await this.disposeIsolatedSession(state);
        }
        throw err;
      } finally {
        if (!state.incognito && this.sessions.get(sessionId) === state) {
          this.sharedSessionReadyInFlight.delete(sessionId);
        }
        if (this.profile.perSessionTransport && !state.incognito) {
          state.lastActivityAt = Date.now();
          this.refreshIdleHibernateTimer();
        }
      }
    }
  }

  private async createFreshAcpSession(sessionId: string, state: KimiSdkSessionState): Promise<void> {
    this.assertCurrentSession(sessionId, state);
    const connection = this.connectionForState(state)!;
    let result: NewSessionResponse;
    try {
      result = await this.withAcpDiagnostics(ACP_ERROR_PHASE.NEW_SESSION, () => connection.newSession({
        cwd: state.cwd,
        mcpServers: this.mcpServersForState(state),
      }));
    } catch (error) {
      // Even a clean RPC rejection need not mean the upstream did not persist
      // a conversation. Never undo the durable start proof or retry fresh.
      // Worker-spawn missing-executable errors fail before any native session
      // starts and must reach ensureSessionReady un-wrapped for recycle/retry.
      if (this.id !== AGY_SDK_PROVIDER_ID || state.incognito || isWorkerSpawnMissingExecutableError(error)) {
        throw error;
      }
      const normalized = this.normalizeError(error);
      throw { ...normalized, message: `${normalized.message} ${AGY_NATIVE_START_RECOVERY_HINT}` };
    }
    if (this.sessions.get(sessionId) !== state || state.cancelled || this.connectionForState(state) !== connection) {
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
    const catalogDefault = typeof models.currentModelId === 'string' ? models.currentModelId : null;
    const preferredDefault = this.profile.defaultModel;
    this.cachedDefaultModel = preferredDefault && this.cachedModels.some((m) => m.id === preferredDefault)
      ? preferredDefault
      : catalogDefault;
    logger.debug({ provider: this.id, count: this.cachedModels.length, default: this.cachedDefaultModel }, `${this.profile.displayName} models cached`);
  }

  private mcpServersForState(state: KimiSdkSessionState): ReturnType<typeof getDefaultAcpMcpServers> {
    if (state.incognito) return [];
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
    if (!this.cachedModels && this.profile.modelDiscovery !== 'session-metadata-only' && !this.profile.perSessionTransport) {
      await this.ensureSharedAcpConnected().catch(() => {});
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
    const available = Array.isArray(info.models?.availableModels) ? info.models.availableModels : [];
    if (state.modelIsDefault && state.model && available.length > 0) {
      const supported = available.some((m: Record<string, unknown>) => String((m as Record<string, unknown>).modelId ?? (m as Record<string, unknown>).id ?? '') === state.model);
      if (!supported) {
        state.model = typeof currentModel === 'string' ? currentModel : undefined;
        state.modelIsDefault = false;
      }
    }
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
    const nativeAutonomous = state.agyNativeTurnGeneration === generation && !state.agyBridging;
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
      if (nativeAutonomous && state.currentText.trim()) (state.agyNativeAcks ??= []).push({generation,text:state.currentText.trimEnd()});
      const bridge = state.agyBridges.get(state.acpSessionId!);
      void bridge?.flush().finally(() => this.deliverAgyPendingResponses(sessionId,state));
    }
    const text = state.currentText;
    const messageId = state.currentMessageId ?? `${sessionId}:${randomUUID()}`;
    state.currentText = '';
    state.currentMessageId = null;
    const settleTerminalStatus: ToolTerminalStatus = steeringFailure !== undefined || stopReason === 'refusal'
      ? 'errored'
      : (stopReason === 'cancelled' || state.cancelled)
        ? 'cancelled'
        : 'abandoned';
    const settleTerminalReason: ToolTerminalReason = steeringFailure !== undefined || stopReason === 'refusal'
      ? 'provider_error'
      : (stopReason === 'cancelled' || state.cancelled)
        ? 'provider_cancelled'
        : 'provider_result';
    this.retireOpenToolCalls(sessionId, state, {
      terminalStatus: settleTerminalStatus,
      terminalReason: settleTerminalReason,
      decisionReason: settleTerminalStatus === 'errored'
        ? 'turn_failed'
        : settleTerminalStatus === 'cancelled'
          ? 'turn_cancelled'
          : 'turn_completed_open_tool',
    });
    this.cancelPendingApprovals(sessionId);
    // All native RPCs are now terminal and busy/text/tools are cleared. Resolve
    // only this captured run; callbacks may already have started a successor.
    run?.complete();

    try {
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
    } finally {
      state.lastActivityAt = Date.now();
      this.refreshIdleHibernateTimer();
      this.scheduleDeferredSharedRecycleIfDrained();
    }
  }

  // ── sessionUpdate dispatch ──────────────────────────────────────────────

  private trackPromptSettlement(
    connection: ClientSideConnection,
    acpSessionId: string | undefined,
    state: KimiSdkSessionState,
    turn: Promise<PromptResponse>,
    onFulfilled: (result: PromptResponse) => Promise<void> | void,
    onRejected: (err: unknown) => void,
  ): void {
    const pendingWrites = this.promptWriteQueues.get(connection);
    let slot: { waitForPrior?: Promise<void>; release: () => void } | undefined;
    const entry: { onResponseArrived: () => void; clearPending: () => void } = {
      onResponseArrived: () => {
        if (!slot && pendingWrites) {
          slot = pendingWrites.reserveSlot(state);
        }
      },
      clearPending: () => {},
    };
    if (pendingWrites && acpSessionId) {
      let q = pendingWrites.get(acpSessionId);
      if (!q) {
        q = [];
        pendingWrites.set(acpSessionId, q);
      }
      q.push(entry);
    }
    void turn
      .then(async (result) => {
        if (slot?.waitForPrior) await slot.waitForPrior;
        return await onFulfilled(result);
      })
      .catch(async (err) => {
        if (slot?.waitForPrior) await slot.waitForPrior;
        onRejected(err);
      })
      .finally(() => {
        entry.clearPending();
        const q = acpSessionId ? pendingWrites?.get(acpSessionId) : undefined;
        if (q) {
          const idx = q.indexOf(entry);
          if (idx >= 0) q.splice(idx, 1);
          if (q.length === 0 && acpSessionId) pendingWrites?.delete(acpSessionId);
        }
        slot?.release();
      });
  }

  private enqueueSessionUpdate(params: SessionNotification): void {
    if (!params || typeof params !== 'object' || typeof params.sessionId !== 'string' || !params.update || typeof params.update !== 'object') return;
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
    if (!params || typeof params !== 'object' || typeof params.sessionId !== 'string' || !params.update || typeof params.update !== 'object') return;
    const routeId = this.acpToRoute.get(params.sessionId);
    if (!routeId) return;
    const state = this.sessions.get(routeId);
    if (!state || state.acpSessionId !== params.sessionId) return;
    state.lastActivityAt = Date.now();

    const update = params.update as SessionUpdate;
    // While loadSession is replaying history, drop every turn-scoped event.
    // We only resurface the persisted agent text/tools when the user actually
    // asks a new question; replay is purely a server-side side-effect of
    // session/load and must not be confused with the current-turn stream.
    if (state.replaying) {
      return;
    }
    if ((update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update')
      && this.shouldIgnoreRetiredOrOrphanToolUpdate(state, update)) {
      return;
    }
    if (this.id === AGY_SDK_PROVIDER_ID && state.agyForeground?.authoritative) {
      if (update.sessionUpdate === 'agent_message_chunk') {
        const text = extractTextFromContent(update.content);
        if (parseSdkRuntimeSubagentTag(text)) this.handleAgentChunk(routeId,state,update);
        return;
      }
      if (['agent_thought_chunk','usage_update','plan','turn_completed'].includes(update.sessionUpdate)) return;
      if (!state.promptInFlight && (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update')) {
        // Tool IDs remain attributable, but an unowned delayed tool update
        // must not create an ACP autonomous generation waiting for a terminal
        // that is intentionally owned by the native lane.
        if (update.sessionUpdate === 'tool_call') this.handleToolCall(routeId,state,update);
        else this.handleToolCallUpdate(routeId,state,update);
        return;
      }
    }
    const updateRecord = update as unknown as Record<string, unknown>;
    if (this.id === AGY_SDK_PROVIDER_ID && isSdkRuntimeSubagentEventName(updateRecord.sessionUpdate)) {
      this.publishAgySubagents(routeId, state,
        (state.agySubagents ??= new AgySubagentTracker(state.acpSessionId ?? routeId)).snapshot(updateRecord));
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
    if (this.id === AGY_SDK_PROVIDER_ID) state.agyNativeTurnGeneration = generation;
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
    this.retireOpenToolCalls(sessionId, state, {
      terminalStatus: 'abandoned',
      terminalReason: 'generation_rollover',
      decisionReason: 'new_turn_started',
    });
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
        this.publishAgySubagents(sessionId, state,
          (state.agySubagents ??= new AgySubagentTracker(state.acpSessionId ?? sessionId)).snapshot(child));
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
    if (this.shouldIgnoreRetiredOrOrphanToolUpdate(state, update)) return;
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
    if (this.shouldIgnoreRetiredOrOrphanToolUpdate(state, update)) return;
    const existing = state.toolCalls.get(update.toolCallId);
    // ACP spec: every field on ToolCallUpdate is optional and replaces the
    // corresponding field on the original tool_call. We synthesize a stub if
    // the agent updates a tool we never saw start (shouldn't happen, but
    // defensive).
    const merged: MergedToolCall = existing ?? {
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
      if (/^(invokesubagent|browsersubagent|sendmessage|swarm)$/.test(normalizeAgyToolName(merged.title))) this.useAgyNativeOutput(state, merged.toolCallId);
      const tracker = state.agySubagents ??= new AgySubagentTracker(state.acpSessionId ?? sessionId);
      const outputValue = normalizedStatus === 'running'
        ? undefined
        : (merged.rawOutput !== undefined
          ? (typeof merged.rawOutput === 'string' ? merged.rawOutput : JSON.stringify(merged.rawOutput))
          : evt.output);
      const agEvt: ToolCallEvent = outputValue === evt.output
        ? evt
        : {
            ...evt,
            ...(outputValue !== undefined ? { output: outputValue } : {}),
            detail: evt.detail
              ? { ...evt.detail, ...(outputValue !== undefined ? { output: outputValue } : {}) }
              : evt.detail,
          };
      this.updateAgyBackgroundTasks(sessionId, state, {
        text: outputValue,
        toolName: merged.title,
        toolInput: merged.rawInput,
        toolStatus: agEvt.status,
      });
      if (normalizedStatus !== 'running' && outputValue !== undefined && !isAgySubagentTool(merged.title)) {
        const recent = state.agyRecentAcpOutputs ??= [];
        recent.push({ normalizedName: normalizeAgyToolName(merged.title), output: outputValue });
        if (recent.length > 32) recent.splice(0, recent.length - 32);
      }
      if (isAgySubagentTool(merged.title) && !state.agyConsumedNativeTools?.has(agEvt.id)) {
        (state.agyPendingNativeTools ??= new Map()).set(agEvt.id, agEvt);
      }
      const children = tracker.tool(agEvt);
      if (children.length) {
        this.publishAgySubagents(sessionId, state, children);
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
    // node wrapper doesn't leave grandchildren behind. Clear shared transport
    // handles before killing so the child 'exit' handler never emits spurious
    // CONNECTION_LOST errors during an intentional teardown or recycle.
    const child = this.child;
    this.child = null;
    this.connection = null;
    this.initPromise = null;
    this.sessionListSupported = false;
    if (child && !child.killed) {
      try { child.stdin.end(); } catch { /* noop */ }
      await killProcessTree(child, { ownsProcessGroup: true });
    }
  }

  private getIdleHibernateMs(): number {
    const raw = Number(process.env.IMCODES_AGY_IDLE_HIBERNATE_MS);
    return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 5 * 60_000;
  }

  private getMaxWarmSessions(): number {
    const raw = Number(process.env.IMCODES_AGY_MAX_WARM_SESSIONS);
    return Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : 8;
  }

  private isSessionBusy(routeId: string, state: KimiSdkSessionState): boolean {
    return (
      state.promptInFlight
      || state.replaying
      || this.sharedSessionReadyInFlight.has(routeId)
      || (state.activePromptGenerations?.size ?? 0) > 0
      || state.autonomousTurnGeneration !== undefined
      || (state.agyBackgroundTasks?.size ?? 0) > 0
      || [...state.toolCalls.values()].some((tool) => tool.status === 'pending' || tool.status === 'in_progress')
      || [...this.pendingApprovals.values()].some((approval) => approval.routeId === routeId)
    );
  }

  private canHibernateSession(routeId: string, state: KimiSdkSessionState): boolean {
    return (
      this.profile.perSessionTransport === true
      && !state.incognito
      && !state.disposed
      && state.loaded
      && Boolean(state.acpSessionId)
      && Boolean(state.isolatedTransport?.connection || state.isolatedTransport?.child)
      && !this.isSessionBusy(routeId, state)
    );
  }

  private async hibernatePerSession(routeId: string, state: KimiSdkSessionState, reason: string): Promise<boolean> {
    if (!this.canHibernateSession(routeId, state)) return false;
    logger.debug({ provider: this.id, sessionId: routeId, reason }, `${this.profile.displayName} hibernating idle ACP session`);
    await this.disposeIsolatedSession(state, {
      bestEffortCloseSession: true,
      preserveResumeId: true,
    });
    return true;
  }

  private async evictWarmPerSessionsIfNeeded(excludeSessionId: string): Promise<void> {
    if (!this.profile.perSessionTransport) return;
    const cap = this.getMaxWarmSessions();
    const isWarm = (routeId: string, s: KimiSdkSessionState): boolean => (
      !s.incognito
      && routeId !== excludeSessionId
      && Boolean(s.isolatedTransport?.child || s.isolatedTransport?.connection || this.sharedSessionReadyInFlight.has(routeId))
    );
    let liveCount = 0;
    for (const [routeId, state] of this.sessions) {
      if (isWarm(routeId, state)) liveCount += 1;
    }
    if (liveCount < cap) return;
    const candidates = [...this.sessions.entries()]
      .filter(([routeId, state]) => routeId !== excludeSessionId && this.canHibernateSession(routeId, state))
      .sort(([aId, aState], [bId, bState]) => {
        const aIsSub = (aState.sessionName ?? aId).startsWith('deck_sub_');
        const bIsSub = (bState.sessionName ?? bId).startsWith('deck_sub_');
        if (aIsSub !== bIsSub) return aIsSub ? -1 : 1;
        return (aState.lastActivityAt ?? 0) - (bState.lastActivityAt ?? 0);
      });
    for (const [victimId, victimState] of candidates) {
      if (liveCount < cap) break;
      if (await this.hibernatePerSession(victimId, victimState, 'warm_cap_lru')) {
        liveCount -= 1;
      }
    }
  }

  private refreshIdleHibernateTimer(): void {
    if (this.idleHibernateTimer) {
      clearTimeout(this.idleHibernateTimer);
      this.idleHibernateTimer = null;
    }
    if (this.isDisconnecting || !this.profile.perSessionTransport) return;
    const ttlMs = this.getIdleHibernateMs();
    let earliestDueAt: number | null = null;
    for (const [routeId, state] of this.sessions) {
      if (!this.canHibernateSession(routeId, state)) continue;
      const dueAt = (state.lastActivityAt ?? Date.now()) + ttlMs;
      if (earliestDueAt === null || dueAt < earliestDueAt) {
        earliestDueAt = dueAt;
      }
    }
    if (earliestDueAt === null) return;
    const delayMs = Math.max(1, earliestDueAt - Date.now());
    const timer = setTimeout(() => {
      this.idleHibernateTimer = null;
      void this.sweepIdlePerSessions();
    }, delayMs);
    timer.unref?.();
    this.idleHibernateTimer = timer;
  }

  private async sweepIdlePerSessions(): Promise<void> {
    if (this.idleSweepInFlight) {
      await this.idleSweepInFlight;
      return;
    }
    const run = (async () => {
      if (this.isDisconnecting || !this.profile.perSessionTransport) return;
      const ttlMs = this.getIdleHibernateMs();
      const now = Date.now();
      for (const [routeId, state] of [...this.sessions.entries()]) {
        if (!this.canHibernateSession(routeId, state)) continue;
        if (now - (state.lastActivityAt ?? 0) >= ttlMs) {
          await this.hibernatePerSession(routeId, state, 'idle_ttl');
        }
      }
    })().finally(() => {
      if (this.idleSweepInFlight === run) this.idleSweepInFlight = null;
      this.refreshIdleHibernateTimer();
    });
    this.idleSweepInFlight = run;
    await run;
  }

  private hasActiveSharedSessionWork(excludeSessionId?: string): boolean {
    for (const [routeId, state] of this.sessions) {
      if (state.incognito || routeId === excludeSessionId) continue;
      if (this.isSessionBusy(routeId, state)) {
        return true;
      }
    }
    return false;
  }

  private hasExecutableFingerprintChanged(prev: AcpExecutableFingerprint | null | undefined): boolean {
    if (!prev || !this.config) return false;
    const fresh = this.resolveAcpExecutable(this.config, { refresh: true });
    if (fresh.executable !== prev.executable) {
      const freshPrimary = captureFileFingerprint(fresh.executable);
      return freshPrimary !== null;
    }
    const currentPrimary = captureFileFingerprint(prev.executable);
    if (currentPrimary && hasFileFingerprintChanged(prev.primary, currentPrimary)) {
      return true;
    }
    if (prev.scriptPath && prev.script) {
      const nextScriptPath = fresh.prependArgs[0] ?? prev.scriptPath;
      if (nextScriptPath !== prev.scriptPath) {
        return captureFileFingerprint(nextScriptPath) !== null;
      }
      const currentScript = captureFileFingerprint(prev.scriptPath);
      if (currentScript && hasFileFingerprintChanged(prev.script, currentScript)) {
        return true;
      }
    }
    return false;
  }

  private hasSharedExecutableChanged(): boolean {
    return this.hasExecutableFingerprintChanged(this.sharedExecutableFingerprint);
  }

  private scheduleDeferredSharedRecycleIfDrained(): void {
    if (!this.pendingSharedRecycle || this.isDisconnecting || !this.config) return;
    if (this.hasActiveSharedSessionWork()) return;
    void this.recycleSharedAcpServer('deferred_drain').catch((err) => {
      logger.warn({ provider: this.id, ...this.errorLogFields(err) }, `${this.profile.displayName} deferred shared ACP recycle failed`);
    });
  }

  private async recycleSharedAcpServer(
    reason: 'binary_changed' | 'worker_spawn_enoent' | 'deferred_drain',
    excludeSessionId?: string,
  ): Promise<void> {
    if (this.isDisconnecting || !this.config) return;
    if (this.sharedRecycleInFlight) {
      await this.sharedRecycleInFlight;
      return;
    }
    const recyclePromise = (async () => {
      if (this.sharedConnectInFlight) {
        await this.sharedConnectInFlight.catch(() => {});
      }
      if (this.isDisconnecting || !this.config) return;
      if (this.hasActiveSharedSessionWork(excludeSessionId)) {
        this.pendingSharedRecycle = true;
        return;
      }
      this.pendingSharedRecycle = false;
      for (const state of this.sessions.values()) {
        if (state.incognito) continue;
        this.closeAgyBridges(state);
        state.loaded = false;
        state.modeApplied = false;
        state.sessionSystemTextInjected = undefined;
      }
      this.cachedModels = null;
      this.cachedDefaultModel = null;
      logger.info({ provider: this.id, reason }, `${this.profile.displayName} recycling shared ACP server`);
      await this.teardownChild();
      if (this.isDisconnecting || !this.config) return;
      const connectPromise = (this.sharedConnectInFlight = this.startAcpServer(
        this.config,
        undefined,
        { refreshExecutable: true },
      ).finally(() => {
        if (this.sharedConnectInFlight === connectPromise) this.sharedConnectInFlight = null;
      }));
      await connectPromise;
    })().finally(() => {
      if (this.sharedRecycleInFlight === recyclePromise) this.sharedRecycleInFlight = null;
    });
    this.sharedRecycleInFlight = recyclePromise;
    await recyclePromise;
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

  protected resolveAcpExecutable(
    config: ProviderConfig,
    _options?: { refresh?: boolean },
  ): ReturnType<typeof resolveExecutableForSpawn> {
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
      return { errorCode: getPrivacySafeErrorCode(error), ...this.acpDiagnosticFields(error) };
    }
    return { [rawField]: error };
  }

  private normalizeError(err: unknown): ProviderError {
    const normalized = this.normalizeErrorCore(err);
    const diagnostics = this.acpDiagnosticFields(err);
    return this.profile.privacySafeErrors && diagnostics.acpPhase
      ? { ...normalized, details: { ...diagnostics, errorCode: getPrivacySafeErrorCode(err) } }
      : normalized;
  }

  private acpDiagnosticFields(error: unknown): { acpPhase?: AcpErrorPhase; rpcCode?: number } {
    if (this.id !== AGY_SDK_PROVIDER_ID) return {};
    const phase = error && typeof error === 'object' ? this.acpErrorPhases.get(error) : undefined;
    const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
    return { ...(phase ? { acpPhase: phase } : {}),
      ...(typeof code === 'number' && Number.isSafeInteger(code) ? { rpcCode: code } : {}) };
  }

  private logAcpFailure(error: unknown, phase: AcpErrorPhase): void {
    if (this.id !== AGY_SDK_PROVIDER_ID) return;
    if (error && typeof error === 'object') this.acpErrorPhases.set(error, phase);
    logger.warn({ provider: this.id, acpPhase: phase, ...this.errorLogFields(error) },
      `${this.profile.displayName} ACP request failed`);
  }

  private withAcpDiagnostics<T>(phase: AcpErrorPhase, request: () => Promise<T>): Promise<T> {
    // Preserve the original Promise and timing for every other ACP profile.
    if (this.id !== AGY_SDK_PROVIDER_ID) return request();
    try {
      return request().catch(error => { this.logAcpFailure(error, phase); throw error; });
    } catch (error) {
      this.logAcpFailure(error, phase);
      throw error;
    }
  }

  private normalizeErrorCore(err: unknown): ProviderError {
    if (err && typeof err === 'object' && 'code' in err && 'message' in err && 'recoverable' in err) {
      // Already a ProviderError.
      return err as ProviderError;
    }
    const message = extractErrorMessage(err);
    const isConnectionLost = /closed|epipe|econnreset|broken pipe|stream (?:closed|ended)|socket closed|server exited|process exited|channel closed|connection (?:lost|closed|ended|reset)|premature close|unexpected end of json/i.test(message);
    if (isConnectionLost || isWorkerSpawnMissingExecutableError(err) || this.isDisconnecting) {
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
        this.id === AGY_SDK_PROVIDER_ID
          ? `${this.profile.displayName} ACP request failed${this.acpDiagnosticFields(err).acpPhase
            ? ` during ${this.acpDiagnosticFields(err).acpPhase}` : ''}. Check the official CLI login, model and connection settings before retrying.`
          : `${this.profile.displayName} ACP request failed.`,
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
    const hadActiveWork = state.promptInFlight
      || state.replaying
      || state.toolCalls.size > 0
      || (state.agyBackgroundTasks?.size ?? 0) > 0;
    this.closeAgyBridges(state);
    const run = this.steeringRunTerminals.get(state);
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
    this.retireOpenToolCalls(routeId, state, {
      terminalStatus: 'abandoned',
      terminalReason: 'no_current_work_disconnect',
      decisionReason: 'session_work_cleared_after_failure',
    });
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

const AGY_BACKGROUND_TASKS_RESTART_RE = /All your subagents and background tasks have been stopped due to server restart\./i;
const AGY_BACKGROUND_TASK_START_RE = /Tool is running as a background task with task id:\s*([A-Za-z0-9._:/-]+)/gi;
const AGY_BACKGROUND_TASK_FINISHED_RE = /Task id "([^"]+)" finished/gi;
const AGY_BACKGROUND_TASK_SENDER_RE = /\bsender=([^\s]+)/gi;
const AGY_MANAGE_TASK_TERMINAL_RE = /\bTask:\s*([A-Za-z0-9._:/-]+)\b[\s\S]*?\bStatus:\s*(?:DONE|KILLED|FAILED|CANCELLED|ERROR|STOPPED)\b/gi;

function isRecurringAgyScheduleTool(toolName?: string, toolInput?: unknown): boolean {
  if (normalizeAgyToolName(toolName ?? '') !== 'schedule') return false;
  if (!toolInput || typeof toolInput !== 'object') return false;
  const record = toolInput as Record<string, unknown>;
  return Boolean(record.CronExpression || record.cronExpression);
}

function extractAgyBackgroundTaskStartIds(text: string): string[] {
  const ids: string[] = [];
  for (const match of text.matchAll(AGY_BACKGROUND_TASK_START_RE)) {
    if (match[1]) ids.push(match[1]);
  }
  return ids;
}

function extractAgyBackgroundTaskTerminalIds(
  text: string,
  opts: { isSystemMessage?: boolean; toolName?: string; toolInput?: unknown; toolStatus?: string },
): string[] {
  const ids: string[] = [];
  if (opts.isSystemMessage) {
    for (const match of text.matchAll(AGY_BACKGROUND_TASK_FINISHED_RE)) {
      if (match[1]) ids.push(match[1]);
    }
    for (const match of text.matchAll(AGY_BACKGROUND_TASK_SENDER_RE)) {
      if (match[1]) ids.push(match[1]);
    }
  }
  if (normalizeAgyToolName(opts.toolName ?? '') === 'managetask') {
    const input = opts.toolInput && typeof opts.toolInput === 'object' ? opts.toolInput as Record<string, unknown> : null;
    if (input?.Action === 'kill' && typeof input.TaskId === 'string' && opts.toolStatus !== 'error') {
      ids.push(input.TaskId);
    }
    for (const match of text.matchAll(AGY_MANAGE_TASK_TERMINAL_RE)) {
      if (match[1]) ids.push(match[1]);
    }
  }
  return ids;
}

interface AgyNativeOrderEntry {
  name: string;
  input: unknown;
  step: number;
  index: number;
}

function findMatchingPendingSubagent(
  state: KimiSdkSessionState,
  entry: AgyNativeOrderEntry,
  evidenceChildIds?: string[],
): { pending?: ToolCallEvent; conflicts: boolean } {
  const normalized = normalizeAgyToolName(entry.name);
  const candidates = [...(state.agyPendingNativeTools?.values() ?? [])]
    .filter((tool) => normalizeAgyToolName(tool.name) === normalized);
  if (!candidates.length) return { conflicts: false };
  const entryInputJson = stableJson(entry.input);
  const byInput = entryInputJson
    ? candidates.filter((tool) => stableJson(tool.input) === entryInputJson)
    : candidates;
  const pool = byInput.length ? byInput : candidates;
  if (evidenceChildIds?.length) {
    const exactChild = pool.find((tool) => {
      if (!tool.output?.trim()) return false;
      const toolIds = extractAgySubagentEvidenceChildIds(tool.output);
      return evidenceChildIds.some((id) => toolIds.includes(id));
    });
    if (exactChild) return { pending: exactChild, conflicts: false };
    const compatible = pool.find((tool) => {
      if (tool.status === 'running' || !tool.output?.trim()) return true;
      const toolIds = extractAgySubagentEvidenceChildIds(tool.output);
      return toolIds.length === 0 || evidenceChildIds.some((id) => toolIds.includes(id));
    });
    if (compatible) return { pending: compatible, conflicts: false };
    return { pending: pool[0], conflicts: true };
  }
  return { pending: pool[0], conflicts: false };
}

function matchAgyGenericRowToNativeTool(
  state: KimiSdkSessionState,
  row: AgyTranscriptRow,
): { orderEntry: AgyNativeOrderEntry; pending?: ToolCallEvent } | undefined {
  const order = state.agyNativeToolOrder;
  if (!order?.length) return undefined;
  const content = row.content ?? '';

  // 1. Exact non-subagent ACP output match.
  const recent = state.agyRecentAcpOutputs;
  if (recent?.length) {
    const recentIdx = recent.findIndex((item) => item.output === content);
    if (recentIdx >= 0) {
      const matched = recent.splice(recentIdx, 1)[0];
      const orderIdx = order.findIndex((entry) => normalizeAgyToolName(entry.name) === matched.normalizedName);
      if (orderIdx >= 0) return { orderEntry: order.splice(orderIdx, 1)[0] };
    }
  }

  // 2. Background task notice belongs to non-subagent tools, never sub-agents.
  if (row.status === 'RUNNING' || extractAgyBackgroundTaskStartIds(content).length > 0) {
    const bgIdx = order.findIndex((entry) => {
      const n = normalizeAgyToolName(entry.name);
      return !isAgySubagentTool(entry.name) && (n === 'runcommand' || n === 'schedule');
    });
    if (bgIdx >= 0) return { orderEntry: order.splice(bgIdx, 1)[0] };
    const nonSubagentIdx = order.findIndex((entry) => !isAgySubagentTool(entry.name));
    return nonSubagentIdx >= 0 ? { orderEntry: order.splice(nonSubagentIdx, 1)[0] } : undefined;
  }

  // 3. Exact ACP pending subagent match (identical output or shared child ID).
  const evidenceChildIds = extractAgySubagentEvidenceChildIds(content);
  for (const [orderIdx, entry] of order.entries()) {
    if (!isAgySubagentTool(entry.name)) continue;
    const { pending } = findMatchingPendingSubagent(state, entry, evidenceChildIds);
    if (!pending || pending.status === 'running' || !pending.output?.trim()) continue;
    const pendingIds = extractAgySubagentEvidenceChildIds(pending.output);
    const matchesOutput = pending.output === content;
    const sharesChildId = evidenceChildIds.length > 0 && evidenceChildIds.some((id) => pendingIds.includes(id));
    if (matchesOutput || sharesChildId) {
      return { orderEntry: order.splice(orderIdx, 1)[0], pending };
    }
  }

  // 4. Transcript row has explicit subagent snapshot/launch evidence.
  if (evidenceChildIds.length > 0) {
    let matchedPending: ToolCallEvent | undefined;
    const eligibleIdx = order.findIndex((entry) => {
      if (!isAgySubagentTool(entry.name)) return false;
      const match = findMatchingPendingSubagent(state, entry, evidenceChildIds);
      if (match.conflicts) return false;
      matchedPending = match.pending;
      return true;
    });
    if (eligibleIdx >= 0) {
      const orderEntry = order[eligibleIdx];
      order.splice(eligibleIdx, 1);
      return { orderEntry, pending: matchedPending };
    }
  }

  // 5. No subagent evidence in row.content: prefer resolving an unconsumed
  // non-subagent tool in the batch so parallel MCP/bash outputs never shift
  // onto an unresolved or ACP-completed subagent call.
  const nonSubagentIdx = order.findIndex((entry) => !isAgySubagentTool(entry.name));
  if (nonSubagentIdx >= 0) {
    return { orderEntry: order.splice(nonSubagentIdx, 1)[0] };
  }

  // 6. Only subagent entries remain and content has no snapshot evidence.
  // Never consume/overwrite an ACP-completed subagent (already has output),
  // an actively running ACP subagent, or a subagent launch call with plain prose;
  // allow only single non-launch updates (e.g. send_message 'Message sent') or error rows.
  const first = order[0];
  const { pending } = findMatchingPendingSubagent(state, first);
  if (pending?.status === 'running') return undefined;
  if (pending?.output?.trim()) return undefined;
  const normalized = normalizeAgyToolName(first.name);
  const isLaunchTool = /^(invokesubagent|browsersubagent|swarm|subagent|agent)$/.test(normalized);
  if (isLaunchTool && row.status !== 'ERROR') return undefined;
  if (order.length > 1) return undefined;
  return { orderEntry: order.splice(0, 1)[0], pending };
}

const WORKER_SPAWN_MISSING_EXEC_RE = /(?:starting worker:.*(?:no such file or directory|enoent|executable file not found)|fork\/exec .*: (?:no such file or directory|executable file not found))/i;

function extractErrorMessage(err: unknown): string {
  if (err instanceof Error) {
    const data = (err as { data?: unknown }).data;
    if (typeof data === 'string' && data.trim()) return `${err.message} ${data}`;
    if (data && typeof data === 'object' && 'details' in data && typeof (data as { details?: unknown }).details === 'string') {
      return `${err.message} ${(data as { details: string }).details}`;
    }
    return err.message;
  }
  if (err && typeof err === 'object') {
    const record = err as { message?: unknown; data?: unknown };
    const msg = typeof record.message === 'string' ? record.message : '';
    const data = typeof record.data === 'string'
      ? record.data
      : (record.data && typeof record.data === 'object' && 'details' in record.data && typeof (record.data as { details?: unknown }).details === 'string')
        ? (record.data as { details: string }).details
        : '';
    const combined = [msg, data].filter(Boolean).join(' ').trim();
    if (combined) return combined;
  }
  return String(err);
}

function isWorkerSpawnMissingExecutableError(err: unknown): boolean {
  if (!err) return false;
  return WORKER_SPAWN_MISSING_EXEC_RE.test(extractErrorMessage(err));
}

function captureFileFingerprint(filePath: string): AcpFileFingerprint | null {
  try {
    let resolvedPath: string | null = null;
    try {
      resolvedPath = realpathSync(filePath);
    } catch {
      resolvedPath = null;
    }
    const st = statSync(resolvedPath ?? filePath);
    if (!st.isFile()) return null;
    return {
      realpath: resolvedPath,
      dev: st.dev,
      ino: st.ino,
      size: st.size,
      mtimeMs: st.mtimeMs,
    };
  } catch {
    return null;
  }
}

function captureExecutableFingerprint(executable: string, firstArg?: string): AcpExecutableFingerprint | null {
  const primary = captureFileFingerprint(executable);
  if (!primary) return null;
  const scriptPath = firstArg && !firstArg.startsWith('-') ? firstArg : undefined;
  const script = scriptPath ? captureFileFingerprint(scriptPath) : undefined;
  return {
    executable,
    primary,
    ...(script ? { scriptPath, script } : {}),
  };
}

function hasFileFingerprintChanged(prev: AcpFileFingerprint, next: AcpFileFingerprint): boolean {
  return prev.realpath !== next.realpath
    || prev.dev !== next.dev
    || prev.ino !== next.ino
    || prev.size !== next.size
    || prev.mtimeMs !== next.mtimeMs;
}
