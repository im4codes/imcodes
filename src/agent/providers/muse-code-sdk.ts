import { existsSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { homedir } from 'node:os';
import {
  MuseClient,
  readSessionDurability,
  spawnMspConnection,
  type ApprovalDecisionInput,
  type ApprovalHandler,
  type FoldedItem,
  type Session,
  type SpawnedMspConnection,
  type Turn,
} from '@muse-code/sdk';
import type {
  ApprovalRequest,
  ProviderCancelOptions,
  ProviderCapabilities,
  ProviderConfig,
  ProviderError,
  ProviderModelInfo,
  ProviderModelList,
  ProviderStatusUpdate,
  SessionConfig,
  SessionInfoUpdate,
  ToolCallEvent,
  TransportProvider,
  ProviderDelegationNotification,
} from '../transport-provider.js';
import {
  BACKGROUND_SUBAGENT_WAKE_MODES,
  CONNECTION_MODES,
  normalizeProviderPayload,
  PROVIDER_ERROR_CODES,
  SESSION_OWNERSHIP,
} from '../transport-provider.js';
import {
  AGENT_DELEGATION_ACTIVE_NOTIFICATION_MODES,
  AGENT_DELEGATION_NOTIFICATION_RESULTS,
  type AgentDelegationNotificationResult,
} from '../../../shared/agent-delegation.js';
import type { AgentMessage, MessageDelta } from '../../../shared/agent-message.js';
import type { ProviderContextPayload } from '../../../shared/context-types.js';
import type { TransportAttachment } from '../../../shared/transport-attachments.js';
import {
  MEMORY_MCP_PROVIDER_STATUS_REASON,
  MEMORY_MCP_STATUS,
  type MemoryMcpProviderStatusView,
} from '../../../shared/memory-ws.js';
import {
  MUSE_SDK_EFFORT_LEVELS,
  type TransportEffortLevel,
} from '../../../shared/effort-levels.js';
import { NATIVE_AGENT_ADMISSION_MODES } from '../../../shared/native-collaboration-policy.js';
import { composeMessageSideProviderPrompt, getProviderSystemTextParts } from '../provider-context-routing.js';
import { sessionSystemContractKey, shouldInjectSessionSystemContract } from '../session-system-contract.js';
import {
  canonicalizeTransportCwd,
  normalizeTransportCwd,
  resolveExecutableForSpawn,
  resolveMuseCodePathForSdk,
} from '../transport-paths.js';
import {
  prepareMuseSessionMcp,
  museMcpEnsureOptionsFromConfig,
  type MuseMcpEnsureResult,
} from '../../daemon/muse-mcp-config.js';
import {
  SDK_SUBAGENT_DETAIL_KIND,
  SDK_SUBAGENT_PROVIDERS,
  SDK_SUBAGENT_PROVIDER_KINDS,
  SDK_SUBAGENT_SCHEMA_VERSION,
  SDK_SUBAGENT_STATUS,
  buildSdkSubagentSafeDetail,
  makeMuseSubagentCanonicalKey,
  type SdkSubagentDetail,
  type SdkSubagentNormalizedStatus,
} from '../../../shared/sdk-subagent-status.js';
import type { ProviderActiveWorkSnapshot, SessionActivityBusyReason } from '../../../shared/session-activity-types.js';
import logger from '../../util/logger.js';
import { createMuseSessionMcpScope } from './muse-session-mcp.js';
import { MUSE_SESSION_MCP_CAPABILITY } from '../../../shared/muse-mcp.js';
import { IMCODES_MEMORY_MCP_SERVER_NAME } from '../../../shared/memory-mcp-server-name.js';
import {
  recordMuseQuotaActivity,
  refreshMuseQuotaMetadata,
  registerMuseUsageReader,
  updateMuseUsageQuota,
  peekMuseUsageQuotaCached,
  type MuseSubscriptionUsage,
} from '../muse-usage-quota.js';

export const MUSE_CODE_SDK_PROVIDER_ID = 'muse-code-sdk';

export const DEFAULT_MUSE_MODELS: ProviderModelInfo[] = [
  {
    id: 'muse-wonder-full-1.0',
    name: 'Muse Wonder Full 1.0',
    supportsReasoningEffort: true,
    supportedEffortLevels: MUSE_SDK_EFFORT_LEVELS,
  },
  {
    id: 'muse-wonder-1.0',
    name: 'Muse Wonder 1.0',
    supportsReasoningEffort: true,
    supportedEffortLevels: MUSE_SDK_EFFORT_LEVELS,
  },
  {
    id: 'muse-spark-1.3',
    name: 'Muse Spark 1.3',
    supportsReasoningEffort: true,
    supportedEffortLevels: MUSE_SDK_EFFORT_LEVELS,
  },
  {
    id: 'muse-spark-1.2',
    name: 'Muse Spark 1.2',
    supportsReasoningEffort: true,
    supportedEffortLevels: MUSE_SDK_EFFORT_LEVELS,
  },
];

export function normalizeMuseModelId(model: string | undefined): string {
  const trimmed = model?.trim();
  if (!trimmed) return 'muse-wonder-full-1.0';
  if (
    trimmed === 'wonder' ||
    trimmed === 'wander' ||
    trimmed === 'wander-pro' ||
    trimmed === 'wander-code' ||
    trimmed === 'wander-fast' ||
    trimmed === 'fast' ||
    trimmed === 'muse-wonder' ||
    trimmed === 'muse-fast'
  ) {
    return 'muse-wonder-full-1.0';
  }
  if (trimmed === 'spark' || trimmed === 'muse-spark') return 'muse-spark-1.3';
  return trimmed;
}


type MuseApprovalRequest = Parameters<ApprovalHandler>[0];
type MuseItemDelta = ReturnType<Turn['deltas']> extends AsyncIterableIterator<infer D> ? D : { delta: string; field?: string };

interface PendingApprovalEntry {
  requestId: string;
  request: MuseApprovalRequest;
  resolve: (decision: ApprovalDecisionInput) => void;
}

interface MuseSessionState {
  routeId: string;
  cwd: string;
  env?: Record<string, string>;
  model?: string;
  museSessionId?: string;
  session?: Session;
  activeTurn?: Turn | null;
  activeTurnId?: string | null;
  inFlight: boolean;
  cancelled: boolean;
  currentMessageId: string | null;
  currentText: string;
  reasoningEffort?: TransportEffortLevel;
  pendingApprovals: Map<string, PendingApprovalEntry>;
  /** Versioned key for the stable contract delivered to this Muse session. */
  sessionSystemTextInjected?: string;
  toolCalls: Map<string, ToolCallEvent>;
  runtimeSubagentStartedAtByKey?: Map<string, number>;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/**
 * Resume failures are only recoverable when the server explicitly says that
 * the requested session no longer exists.  Do not treat arbitrary "not
 * found"/transport errors as an expired session: doing so can silently start
 * a different conversation and hide a real outage.
 */
function isMuseSessionNotFoundError(error: unknown): boolean {
  const record = asRecord(error);
  const code = String(record.code ?? record.errorCode ?? record.type ?? '').toLowerCase();
  const message = error instanceof Error
    ? error.message
    : typeof error === 'string'
      ? error
      : String(record.message ?? record.error ?? '');
  const detail = `${code} ${message}`.toLowerCase();
  return /(?:session[\s\S]{0,120}(?:not[\s_-]*found|does[\s_-]*not[\s_-]+exist|unknown|不存在)|(?:not[\s_-]*found|does[\s_-]*not[\s_-]+exist|unknown)[\s\S]{0,120}session|sessionnotfound)/.test(detail);
}

function isMuseSubagentTool(name?: string): boolean {
  if (!name) return false;
  const normalized = name.toLowerCase().replace(/[-_]/g, '');
  return normalized === 'subagent'
    || normalized === 'agent'
    || normalized === 'spawnsubagent'
    || normalized === 'invokesubagent';
}

function mapMuseSubagentStatus(
  status?: string,
  controlStatus?: string,
): {
  toolStatus: 'running' | 'complete' | 'error';
  normalizedStatus: SdkSubagentNormalizedStatus;
  active: boolean;
  terminal: boolean;
} {
  const normStatus = (status || '').toLowerCase();
  const normControl = (controlStatus || '').toLowerCase();

  if (normStatus === 'inprogress' || normStatus === 'in_progress') {
    if (normControl === 'accepted' || normControl === 'starting') {
      return { toolStatus: 'running', normalizedStatus: SDK_SUBAGENT_STATUS.PENDING, active: true, terminal: false };
    }
    return { toolStatus: 'running', normalizedStatus: SDK_SUBAGENT_STATUS.RUNNING, active: true, terminal: false };
  }
  if (normStatus === 'completed' || normStatus === 'complete' || normStatus === 'done' || normStatus === 'success' || normControl === 'closed' || normControl === 'resultready') {
    return { toolStatus: 'complete', normalizedStatus: SDK_SUBAGENT_STATUS.COMPLETE, active: false, terminal: true };
  }
  if (normStatus === 'failed' || normStatus === 'failure' || normStatus === 'error') {
    return { toolStatus: 'error', normalizedStatus: SDK_SUBAGENT_STATUS.ERROR, active: false, terminal: true };
  }
  if (normStatus === 'cancelled' || normStatus === 'canceled' || normStatus === 'interrupted' || normStatus === 'stopped') {
    return { toolStatus: 'error', normalizedStatus: SDK_SUBAGENT_STATUS.INTERRUPTED, active: false, terminal: true };
  }
  return { toolStatus: 'running', normalizedStatus: SDK_SUBAGENT_STATUS.RUNNING, active: true, terminal: false };
}

function parseJsonSafe(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

/**
 * How long a turn may produce NO agent-side activity (no text delta, no
 * non-user item) before it is treated as a stalled upstream stream.
 *
 * Measured on a healthy host: slow-but-healthy first-token latency reaches
 * ~46s on muse-wonder-full-1.0, while stalled turns sit at `opening_stream`
 * with no event for 90-100s+ until interrupted. Override for tests or tuning
 * with IMCODES_MUSE_FIRST_ACTIVITY_TIMEOUT_MS.
 */
export const MUSE_FIRST_ACTIVITY_TIMEOUT_DEFAULT_MS = 180_000;
/** After the watchdog interrupts, how long to wait for the host to settle the turn before giving up on it. */
const MUSE_STALL_INTERRUPT_GRACE_MS = 10_000;
function museFirstActivityTimeoutMs(): number {
  const raw = Number(process.env.IMCODES_MUSE_FIRST_ACTIVITY_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : MUSE_FIRST_ACTIVITY_TIMEOUT_DEFAULT_MS;
}

/** Muse's closed approval-mode vocabulary (`ApprovalMode` in the MSP schema). */
export const MUSE_APPROVAL_MODES = ['allowAll', 'promptUnmatched', 'onRequest', 'denyUnmatched'] as const;
export type MuseApprovalMode = typeof MUSE_APPROVAL_MODES[number];

/**
 * Highest-permission posture: no approval prompts and no shell sandbox. This
 * is Muse's equivalent of claude's `bypassPermissions` / codex's
 * `approvalPolicy: never` + `danger-full-access` / gemini's `yolo`, and is the
 * default like those providers. Two independent layers, both required:
 *  - host process: `--disable-sandbox` (fixed for the host's lifetime; the
 *    default bubblewrap sandbox also fails outright on hosts that forbid user
 *    namespaces, which made every shell command error out);
 *  - session: approval mode `allowAll` (selected on the wire; Muse has no
 *    approval flag on `serve`).
 * Opt out with `dangerouslySkipPermissions: false` in the provider config, and
 * pick a specific mode with `approvalMode`.
 */
export function resolveMusePermissionPosture(config: Record<string, unknown> | null | undefined): {
  maxPermissions: boolean;
  approvalMode: MuseApprovalMode | undefined;
} {
  const maxPermissions = config?.dangerouslySkipPermissions !== false;
  const requested = typeof config?.approvalMode === 'string' ? config.approvalMode : undefined;
  const explicit = (MUSE_APPROVAL_MODES as readonly string[]).includes(requested ?? '')
    ? (requested as MuseApprovalMode)
    : undefined;
  return { maxPermissions, approvalMode: explicit ?? (maxPermissions ? 'allowAll' : undefined) };
}

/** Argv for `muse serve` (without the executable's own prepend args). */
export function buildMuseServeArgs(config: Record<string, unknown>, defaultModel?: string): string[] {
  const args = ['serve', ...(Array.isArray(config.args) ? (config.args as string[]) : ['--trust-workspace'])];
  if (resolveMusePermissionPosture(config).maxPermissions && !args.includes('--disable-sandbox')) {
    args.push('--disable-sandbox');
  }
  if (!args.includes('--provider')) {
    const provider = typeof config.provider === 'string' && config.provider.trim() ? config.provider.trim() : 'meta';
    args.push('--provider', provider);
  }
  if (!args.includes('--model') && defaultModel) {
    args.push('--model', defaultModel);
  }
  return args;
}

type MuseUsageRelayShape = {
  input_tokens: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  model_context_window?: number;
};

function finiteNonNegative(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/**
 * Context-window usage for a completed Muse turn, in the snake_case shape
 * transport-relay consumes. The relay's meter is `input + cache`, where
 * `input_tokens` is the NON-cached part and `cache_read_input_tokens` the
 * cached part; Muse's prompt count includes the cached tokens.
 *
 * Source preference:
 *  1. the host's session state (`session/contextUsage` = counted-once
 *     occupancy + the real window; `session/tokenUsage` = latest completion's
 *     cache split). Both are folded by the SDK before `turn/completed`
 *     resolves, and they describe the LATEST model call (the meter), not the
 *     turn's summed cumulative counters.
 *  2. the turn's own `usage` counters, when the host supplied them.
 * Returns undefined when neither is available, so nothing is invented.
 */
export function buildMuseUsage(session: unknown, turnUsage?: unknown): MuseUsageRelayShape | undefined {
  let context: Record<string, unknown> | null | undefined;
  let token: Record<string, unknown> | null | undefined;
  try {
    const sessionState = (session as { fold?: { sessionState?: { get?: (family: string) => unknown } } } | null | undefined)
      ?.fold?.sessionState;
    if (sessionState && typeof sessionState.get === 'function') {
      context = sessionState.get('session/contextUsage') as Record<string, unknown> | null | undefined;
      token = sessionState.get('session/tokenUsage') as Record<string, unknown> | null | undefined;
    }
  } catch {
    // A fold that cannot be read must never fail the turn; fall through.
  }

  const raw = (token?.usage ?? undefined) as Record<string, unknown> | undefined;
  const latestOutput = finiteNonNegative(raw?.outputTokens);
  const aggregate = (turnUsage ?? undefined) as Record<string, unknown> | undefined;
  const outputTokens = finiteNonNegative(aggregate?.outputTokens) ?? latestOutput;

  let occupancy = finiteNonNegative(context?.usedTokens);
  if (occupancy === undefined) {
    const prompt = finiteNonNegative(token?.promptTokens);
    if (prompt !== undefined) occupancy = prompt + (latestOutput ?? 0);
  }
  let cacheSource = raw;
  if (occupancy === undefined && aggregate) {
    const input = finiteNonNegative(aggregate.inputTokens);
    if (input !== undefined) occupancy = input + (finiteNonNegative(aggregate.outputTokens) ?? 0);
    cacheSource = aggregate;
  }
  if (occupancy === undefined) return undefined;

  const cached = Math.min(
    finiteNonNegative(cacheSource?.cacheReadTokens) ?? finiteNonNegative(cacheSource?.cachedTokens) ?? 0,
    occupancy,
  );
  const windowTokens = finiteNonNegative(context?.windowTokens);
  return {
    input_tokens: occupancy - cached,
    ...(cached > 0 ? { cache_read_input_tokens: cached } : {}),
    ...(outputTokens !== undefined ? { output_tokens: outputTokens } : {}),
    ...(windowTokens ? { model_context_window: windowTokens } : {}),
  };
}

function mapEffortLevel(effort?: TransportEffortLevel): 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra' | undefined {
  if (!effort) return undefined;
  if (effort === 'off') return 'none';
  if (['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(effort)) {
    return effort as 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra';
  }
  return undefined;
}

export class MuseCodeSdkProvider implements TransportProvider {
  readonly id = MUSE_CODE_SDK_PROVIDER_ID;
  readonly connectionMode = CONNECTION_MODES.LOCAL_SDK;
  readonly sessionOwnership = SESSION_OWNERSHIP.SHARED;
  readonly capabilities: ProviderCapabilities = {
    streaming: true,
    toolCalling: true,
    approval: true,
    sessionRestore: true,
    multiTurn: true,
    attachments: false,
    reasoningEffort: true,
    supportedEffortLevels: MUSE_SDK_EFFORT_LEVELS,
    contextSupport: 'full-normalized-context-injection',
    backgroundSubagentWake: BACKGROUND_SUBAGENT_WAKE_MODES.RUNTIME,
    nativeAgentAdmission: NATIVE_AGENT_ADMISSION_MODES.SESSION_FENCE,
    activeDelegationNotification: AGENT_DELEGATION_ACTIVE_NOTIFICATION_MODES.NATIVE,
  };

  private config: ProviderConfig | null = null;
  private client: MuseClient | null = null;
  private sessionMcpScope: ReturnType<typeof createMuseSessionMcpScope> | null = null;
  private spawned: SpawnedMspConnection | null = null;
  private sessions = new Map<string, MuseSessionState>();
  private mcpRegistration: MuseMcpEnsureResult | null = null;
  private unregisterUsageReader: (() => void) | null = null;

  private deltaCallbacks = new Set<(sessionId: string, delta: MessageDelta) => void>();
  private completeCallbacks = new Set<(sessionId: string, message: AgentMessage) => void>();
  private errorCallbacks = new Set<(sessionId: string, error: ProviderError) => void>();
  private toolCallCallbacks = new Set<(sessionId: string, tool: ToolCallEvent) => void>();
  private approvalCallbacks = new Set<(sessionId: string, req: ApprovalRequest) => void>();
  private sessionInfoCallbacks = new Set<(sessionId: string, info: SessionInfoUpdate) => void>();
  private statusCallbacks = new Set<(sessionId: string, status: ProviderStatusUpdate) => void>();
  private modelCache: { at: number; list: ProviderModelList } | null = null;

  async connect(config: ProviderConfig): Promise<void> {
    if (this.client) {
      await this.disconnect();
    }
    this.config = config;

    this.mcpRegistration = await prepareMuseSessionMcp(museMcpEnsureOptionsFromConfig(config)).catch((err) => {
      logger.warn({ err }, 'Failed to ensure Muse MCP configuration');
      return null;
    });

    const rawPath = typeof config.cliPath === 'string' && config.cliPath.trim()
      ? config.cliPath.trim()
      : (typeof config.binaryPath === 'string' && config.binaryPath.trim()
        ? config.binaryPath.trim()
        : resolveMuseCodePathForSdk());
    const resolved = resolveExecutableForSpawn(rawPath);
    if (!resolved.executable || !existsSync(resolved.executable)) {
      throw {
        code: PROVIDER_ERROR_CODES.CONFIG_ERROR,
        message: `Muse Code CLI binary could not be found (${resolved.executable || 'not installed'}). Install the official CLI via 'curl -fsSL https://muse.meta.com/install.sh | bash' or configure cliPath.`,
        recoverable: false,
      } satisfies ProviderError;
    }

    const defaultModel = normalizeMuseModelId(
      typeof config.agentId === 'string' && config.agentId.trim()
        ? config.agentId.trim()
        : (typeof (config as any).model === 'string' && (config as any).model.trim()
          ? (config as any).model.trim()
          : 'muse-spark-1.3'),
    );
    const args = buildMuseServeArgs(config as Record<string, unknown>, defaultModel);

    const explicitApiKey = typeof config.apiKey === 'string' && config.apiKey.trim()
      ? config.apiKey.trim()
      : ((config.env as Record<string, string> | undefined)?.META_API_KEY
        || process.env.META_API_KEY);

    try {
      const handshake = spawnMspConnection({
        command: resolved.executable,
        args: [...resolved.prependArgs, ...args],
        cwd: typeof config.cwd === 'string' ? config.cwd : process.cwd(),
        env: {
          ...process.env,
          ...(config.env as Record<string, string> | undefined),
          ...(explicitApiKey ? { META_API_KEY: explicitApiKey } : {}),
        },
        onStderr: (chunk: string) => {
          logger.debug({ chunk }, 'muse serve stderr');
        },
      });

      this.spawned = await handshake.initialize({
        clientInfo: { name: 'imcodes', version: '1.0.0' },
        capabilities: { experimentalApi: true, requestedCapabilities: [MUSE_SESSION_MCP_CAPABILITY] },
      });

      this.sessionMcpScope = createMuseSessionMcpScope(this.spawned.connection, this.spawned.initializeResult.grantedCapabilities ?? []);
      this.client = new MuseClient(this.sessionMcpScope.connection, {
        host: this.spawned,
        durability: readSessionDurability(this.spawned.initializeResult),
      });

      // MuseClient owns Connection's single notification handler. Registering a
      // quota observer here replaces its inbound pump, dropping every turn/item/
      // approval notification. Use usage/read below and after completion instead.
      this.unregisterUsageReader?.();
      this.unregisterUsageReader = registerMuseUsageReader(async () => {
        if (!this.spawned?.connection) return null;
        try {
          const res = await this.spawned.connection.request('usage/read', {});
          return (res?.usage as MuseSubscriptionUsage) ?? null;
        } catch {
          return null;
        }
      });

      logger.info(
        {
          provider: this.id,
          serverInfo: this.spawned.initializeResult.serverInfo,
          durability: this.client.durability,
        },
        'Muse Code SDK connection initialized',
      );
    } catch (err) {
      logger.error({ err, provider: this.id }, 'Failed to spawn Muse Code MSP connection');
      this.client = null;
      this.spawned = null;
      throw {
        code: PROVIDER_ERROR_CODES.PROVIDER_NOT_FOUND,
        message: err instanceof Error ? err.message : String(err),
        recoverable: false,
      } satisfies ProviderError;
    }
  }

  async disconnect(): Promise<void> {
    const activeStates = [...this.sessions.values()];
    for (const state of activeStates) {
      if (state.inFlight) {
        state.cancelled = true;
      }
    }
    this.sessions.clear();

    if (this.client) {
      try {
        await this.client.close();
      } catch (err) {
        logger.debug({ err, provider: this.id }, 'Error closing Muse client');
      }
      this.client = null;
    }
    this.unregisterUsageReader?.();
    this.unregisterUsageReader = null;
    this.spawned = null;
    this.sessionMcpScope = null;
    this.config = null;
  }

  async createSession(config: SessionConfig): Promise<string> {
    const routeId = config.bindExistingKey ?? config.sessionKey ?? randomUUID();
    const existing = config.fresh ? undefined : this.sessions.get(routeId);
    if (existing && existing.session) {
      return routeId;
    }

    if (!this.client) {
      throw {
        code: PROVIDER_ERROR_CODES.PROVIDER_NOT_FOUND,
        message: 'Muse Code provider is not connected',
        recoverable: false,
      } satisfies ProviderError;
    }

    // Muse's Agent Definitions loader rejects a symlink/reparse-point source
    // root.  Canonicalize existing directories before handing them to the SDK;
    // canonicalizeTransportCwd retains the normalized absolute spelling when
    // the project directory is temporarily unavailable.
    const workspaceRoot = canonicalizeTransportCwd(config.cwd) ?? process.cwd();
    const requestedModel = normalizeMuseModelId(
      typeof config.agentId === 'string' && config.agentId.trim()
        ? config.agentId.trim()
        : (typeof (config as any).model === 'string' && (config as any).model.trim()
          ? (config as any).model.trim()
          : 'muse-spark-1.3'),
    );
    let session: Session;
    let resumedSession = false;
    const posture = resolveMusePermissionPosture(this.config as Record<string, unknown> | null);

    try {
      if (config.resumeId) {
        const resumeId = config.resumeId;
        try {
          session = await this.withSessionMcp(config, () => this.client!.resumeSession({
            sessionId: resumeId,
          }));
          resumedSession = true;
        } catch (err) {
          if (!isMuseSessionNotFoundError(err)) throw err;
          logger.info({ routeId }, 'Muse resume session is stale; starting a new session');
          session = await this.withSessionMcp(config, () => this.client!.startSession({
            workspaceRoot,
            modelId: requestedModel,
            providerId: 'meta',
            ...(posture.approvalMode ? { approvalMode: posture.approvalMode } : {}),
          }));
        }
        if (resumedSession && posture.approvalMode && this.spawned) {
          // `session/resume` has no approvalMode member; select it explicitly.
          await this.spawned.connection
            .command('session/setApprovalMode', {
              commandId: randomUUID(),
              sessionId: session.sessionId,
              mode: posture.approvalMode,
            })
            .catch((err) => {
              logger.warn({ err, mode: posture.approvalMode }, 'Failed to set approval mode on resumed Muse session');
            });
        }
        if (resumedSession && requestedModel && this.spawned) {
          void this.spawned.connection
            .command('session/setModel', {
              commandId: randomUUID(),
              sessionId: session.sessionId,
              model: { modelId: requestedModel },
            })
            .catch((err) => {
              logger.debug({ err, requestedModel }, 'Failed to set model on resumed Muse session');
            });
        }
      } else {
        session = await this.withSessionMcp(config, () => this.client!.startSession({
          workspaceRoot,
          modelId: requestedModel,
          providerId: 'meta',
          ...(posture.approvalMode ? { approvalMode: posture.approvalMode } : {}),
        }));
      }
    } catch (err) {
      logger.error({ err, routeId, resumeId: config.resumeId }, 'Failed to open Muse Code session');
      throw {
        code: PROVIDER_ERROR_CODES.PROVIDER_ERROR,
        message: `Failed to open Muse session: ${err instanceof Error ? err.message : String(err)}`,
        recoverable: true,
      } satisfies ProviderError;
    }

    const state: MuseSessionState = {
      routeId,
      cwd: workspaceRoot,
      env: config.env,
      model: requestedModel || existing?.model,
      museSessionId: session.sessionId,
      session,
      activeTurn: null,
      activeTurnId: null,
      inFlight: false,
      cancelled: false,
      currentMessageId: null,
      currentText: '',
      reasoningEffort: config.effort ?? existing?.reasoningEffort,
      pendingApprovals: new Map(),
      sessionSystemTextInjected: undefined,
      toolCalls: new Map(),
    };

    session.onApproval((request) => this.handleApprovalRequest(routeId, request));

    this.sessions.set(routeId, state);
    const cachedQuota = peekMuseUsageQuotaCached();
    this.emitSessionInfo(routeId, {
      resumeId: session.sessionId,
      ...(state.model ? { model: state.model } : {}),
      ...(cachedQuota?.quotaLabel ? { quotaLabel: cachedQuota.quotaLabel } : {}),
      ...(cachedQuota?.quotaMeta ? { quotaMeta: cachedQuota.quotaMeta } : {}),
    });

    return routeId;
  }

  private withSessionMcp<T>(config: SessionConfig, operation: () => Promise<T>): Promise<T> {
    return this.sessionMcpScope
      ? this.sessionMcpScope.run(config, this.mcpRegistration?.serverName ?? IMCODES_MEMORY_MCP_SERVER_NAME, operation)
      : operation();
  }

  async endSession(sessionId: string): Promise<void> {
    const state = this.sessions.get(sessionId);
    if (!state) return;
    if (state.inFlight) {
      await this.cancel(sessionId);
    }
    this.sessions.delete(sessionId);
  }

  async detachSession(sessionId: string): Promise<void> {
    await this.endSession(sessionId);
  }

  async restoreSession(sessionId: string): Promise<boolean> {
    const state = this.sessions.get(sessionId);
    return Boolean(state?.museSessionId && state.session);
  }

  async send(
    sessionId: string,
    payload: string | ProviderContextPayload,
    attachments?: TransportAttachment[],
    extraSystemPrompt?: string,
  ): Promise<void> {
    const state = this.sessions.get(sessionId);
    if (!state) {
      throw {
        code: PROVIDER_ERROR_CODES.SESSION_NOT_FOUND,
        message: `Session ${sessionId} not found`,
        recoverable: false,
      } satisfies ProviderError;
    }
    if (!state.session) {
      throw {
        code: PROVIDER_ERROR_CODES.PROVIDER_ERROR,
        message: `Session ${sessionId} has no active Muse session`,
        recoverable: false,
      } satisfies ProviderError;
    }

    if (state.inFlight) {
      throw {
        code: PROVIDER_ERROR_CODES.RATE_LIMITED,
        message: `Session ${sessionId} is currently executing a turn`,
        recoverable: true,
      } satisfies ProviderError;
    }

    state.inFlight = true;
    state.cancelled = false;
    state.currentMessageId = randomUUID();
    state.currentText = '';

    const normalized = normalizeProviderPayload(payload, attachments, extraSystemPrompt);
    const sessionSystemText = getProviderSystemTextParts(normalized).sessionSystemText;
    const sessionContractKey = sessionSystemContractKey(sessionSystemText);
    const includeSessionSystemText = shouldInjectSessionSystemContract(
      state.sessionSystemTextInjected,
      sessionSystemText,
    );
    const prompt = composeMessageSideProviderPrompt(normalized, { includeSessionSystemText });
    const effort = mapEffortLevel(state.reasoningEffort);

    let turn: Turn;
    try {
      turn = await state.session.sendUserTurn({
        input: [{ type: 'text', text: prompt }],
        ...(effort ? { reasoningEffort: effort } : {}),
      });
    } catch (err) {
      state.inFlight = false;
      throw {
        code: PROVIDER_ERROR_CODES.PROVIDER_ERROR,
        message: err instanceof Error ? err.message : String(err),
        recoverable: true,
      } satisfies ProviderError;
    }
    if (includeSessionSystemText) state.sessionSystemTextInjected = sessionContractKey;
    state.activeTurn = turn;
    state.activeTurnId = turn.turnId;
    // send() confirms native admission, not terminal completion. The runtime
    // owns a separate callback-driven completion waiter and admission deadline.
    // Keeping this promise pending for a whole model turn caused false timeouts
    // (and hid genuinely delivered work from the durable delivery ledger).
    void this.consumeTurn(sessionId, state, turn);
  }

  private async consumeTurn(sessionId: string, state: MuseSessionState, turn: Turn): Promise<void> {
    // The runtime re-checks provider busy state synchronously inside the
    // complete/error callbacks (to flip the session idle and drain queued
    // messages). In-flight state must therefore be cleared BEFORE emitting,
    // not in `finally`; otherwise the daemon sees `provider_wait`, defers the
    // idle transition, and nothing ever re-triggers it. The once-only guard
    // keeps the trailing `finally` from clobbering a follow-up turn that was
    // started from inside one of those callbacks.
    let turnSettled = false;
    // First-activity watchdog state (see museFirstActivityTimeoutMs).
    let sawAgentActivity = false;
    let stalled = false;
    let stallTimer: ReturnType<typeof setTimeout> | null = null;
    let stallEscapeTimer: ReturnType<typeof setTimeout> | null = null;
    let abandonStalledWait: () => void = () => {};
    const stallEscape = new Promise<{ kind: 'stallAbandoned' }>((resolve) => {
      abandonStalledWait = () => resolve({ kind: 'stallAbandoned' });
    });
    const settleTurn = (): void => {
      if (turnSettled) return;
      turnSettled = true;
      if (stallTimer) {
        clearTimeout(stallTimer);
        stallTimer = null;
      }
      if (stallEscapeTimer) {
        clearTimeout(stallEscapeTimer);
        stallEscapeTimer = null;
      }
      state.inFlight = false;
      state.activeTurn = null;
      state.activeTurnId = null;
    };

    try {
      // An upstream stream that never opens shows no event at all and would
      // otherwise leave the session "working" until the user presses stop.
      stallTimer = setTimeout(() => {
        stallTimer = null;
        if (turnSettled || sawAgentActivity || state.cancelled) return;
        stalled = true;
        logger.warn(
          { sessionId, turnId: turn.turnId, timeoutMs: museFirstActivityTimeoutMs() },
          'Muse turn produced no agent activity; interrupting stalled turn',
        );
        void this.cancel(sessionId);
        stallEscapeTimer = setTimeout(() => {
          stallEscapeTimer = null;
          abandonStalledWait();
        }, MUSE_STALL_INTERRUPT_GRACE_MS);
        stallEscapeTimer.unref?.();
      }, museFirstActivityTimeoutMs());
      stallTimer.unref?.();

      const deltasTask = (async () => {
        try {
          for await (const delta of turn.deltas()) {
            sawAgentActivity = true;
            if (state.cancelled) break;
            const deltaItem = delta as MuseItemDelta;
            if (!deltaItem.field || deltaItem.field === 'text') {
              state.currentText += deltaItem.delta;
              // Contract with transport-relay: `delta` carries the cumulative
              // text so far (same as codex/claude). The relay replaces the
              // streaming event text with each frame and coalesces to the
              // latest, so a raw fragment would show only the newest chunk.
              this.emitDelta(sessionId, {
                messageId: state.currentMessageId!,
                type: 'text',
                delta: state.currentText,
                role: 'assistant',
              });
            }
          }
        } catch (err) {
          logger.debug({ err, sessionId }, 'Muse delta stream exited');
        }
      })();

      const itemsTask = (async () => {
        try {
          for await (const item of turn.items()) {
            if ((item as FoldedItem).kind !== 'userMessage') sawAgentActivity = true;
            if (state.cancelled) break;
            const folded = item as FoldedItem;
            if (folded.kind === 'toolCall' && folded.tool) {
              const toolId = folded.callId || folded.itemId;
              const isSubagent = isMuseSubagentTool(folded.tool) || Boolean((folded as Record<string, unknown>).subagentId);
              const toolStatus: 'running' | 'complete' | 'error' =
                folded.status === 'inProgress' ? 'running' : folded.status === 'failed' ? 'error' : 'complete';
              const argsParsed = parseJsonSafe(folded.args);
              let detail: SdkSubagentDetail | undefined;

              if (isSubagent) {
                const subagentId = asString((folded as Record<string, unknown>).subagentId) || toolId;
                const canonicalKey = makeMuseSubagentCanonicalKey(sessionId, subagentId);
                const rec = asRecord(argsParsed);
                const prompt = asString(rec.prompt) ?? asString(rec.description) ?? asString(rec.task) ?? asString((folded as Record<string, unknown>).objective);
                const agentName = asString(rec.name) ?? asString(rec.role) ?? asString((folded as Record<string, unknown>).role) ?? asString((folded as Record<string, unknown>).agentPath) ?? folded.tool;
                const rawItemStatus = String(folded.status ?? '');
                const statusMapping = mapMuseSubagentStatus(rawItemStatus, asString((folded as Record<string, unknown>).controlStatus));
                const startedAtByKey = state.runtimeSubagentStartedAtByKey ??= new Map<string, number>();
                const startedAtMs = startedAtByKey.get(canonicalKey) ?? Date.now();
                if (statusMapping.active && !statusMapping.terminal) {
                  startedAtByKey.set(canonicalKey, startedAtMs);
                }
                const output = folded.visibleOutput || asString((folded as Record<string, unknown>).failureReason);
                detail = buildSdkSubagentSafeDetail({
                  kind: SDK_SUBAGENT_DETAIL_KIND,
                  summary: agentName ? `Muse sub-agent ${agentName}` : 'Muse sub-agent',
                  input: {
                    action: folded.tool,
                    ...(prompt ? { description: prompt } : {}),
                  },
                  ...(output ? { output } : {}),
                  meta: {
                    isSdkSubagent: true,
                    schemaVersion: SDK_SUBAGENT_SCHEMA_VERSION,
                    provider: SDK_SUBAGENT_PROVIDERS.MUSE_CODE_SDK,
                    providerKind: SDK_SUBAGENT_PROVIDER_KINDS.MUSE_RUNTIME_AGENT,
                    canonicalKey,
                    normalizedStatus: statusMapping.normalizedStatus,
                    rawStatus: asString((folded as Record<string, unknown>).controlStatus) || rawItemStatus,
                    active: statusMapping.active,
                    terminal: statusMapping.terminal,
                    parentSessionId: sessionId,
                    parentToolUseId: toolId,
                    parentItemId: folded.itemId,
                    ...(asString((folded as Record<string, unknown>).agentPath) ? { agentPath: asString((folded as Record<string, unknown>).agentPath) } : {}),
                    ...(agentName ? { agentName } : {}),
                    ...(subagentId ? { taskId: subagentId } : {}),
                    startedAtMs,
                    backgrounded: true,
                  },
                }, { allowRaw: false });
              }

              const toolEvent: ToolCallEvent = {
                id: isSubagent && detail ? detail.meta.canonicalKey : toolId,
                name: isSubagent ? 'Agent' : folded.tool,
                status: isSubagent && detail
                  ? (detail.meta.terminal ? (detail.meta.normalizedStatus === SDK_SUBAGENT_STATUS.COMPLETE ? 'complete' : 'error') : 'running')
                  : toolStatus,
                input: argsParsed,
                output: folded.visibleOutput,
                ...(detail ? { detail } : {}),
              };
              state.toolCalls.set(toolEvent.id, toolEvent);
              this.emitToolCall(sessionId, toolEvent);
            } else if (folded.kind === 'subagent') {
              const subagentRecord = folded as Record<string, unknown>;
              const subagentKey = asString(subagentRecord.subagentId) || folded.itemId;
              const canonicalKey = makeMuseSubagentCanonicalKey(sessionId, subagentKey);
              const rawItemStatus = String(folded.status ?? '');
              const statusMapping = mapMuseSubagentStatus(rawItemStatus, asString(subagentRecord.controlStatus));
              const prompt = asString(subagentRecord.objective) || asString(subagentRecord.text);
              const agentName = asString(subagentRecord.role) || asString(subagentRecord.agentPath) || 'Muse Agent';
              const resultObj = asRecord(subagentRecord.result);
              const output = asString(resultObj.text) || asString(resultObj.summary) || folded.visibleOutput || asString(subagentRecord.failureReason);

              const startedAtByKey = state.runtimeSubagentStartedAtByKey ??= new Map<string, number>();
              const startedAtMs = startedAtByKey.get(canonicalKey) ?? Date.now();
              if (statusMapping.active && !statusMapping.terminal) {
                startedAtByKey.set(canonicalKey, startedAtMs);
              }

              const usageObj = asRecord(subagentRecord.usage);
              const totalTokens = typeof usageObj.totalTokens === 'number' ? usageObj.totalTokens : undefined;
              const durationMs = typeof subagentRecord.durationMs === 'number' ? subagentRecord.durationMs : undefined;

              const detail = buildSdkSubagentSafeDetail({
                kind: SDK_SUBAGENT_DETAIL_KIND,
                summary: `Muse sub-agent ${agentName}`,
                input: {
                  action: 'muse-runtime-subagent',
                  ...(prompt ? { description: prompt } : {}),
                },
                ...(output ? { output } : {}),
                meta: {
                  isSdkSubagent: true,
                  schemaVersion: SDK_SUBAGENT_SCHEMA_VERSION,
                  provider: SDK_SUBAGENT_PROVIDERS.MUSE_CODE_SDK,
                  providerKind: SDK_SUBAGENT_PROVIDER_KINDS.MUSE_RUNTIME_AGENT,
                  canonicalKey,
                  normalizedStatus: statusMapping.normalizedStatus,
                  rawStatus: asString(subagentRecord.controlStatus) || rawItemStatus,
                  active: statusMapping.active,
                  terminal: statusMapping.terminal,
                  parentSessionId: sessionId,
                  parentItemId: folded.itemId,
                  ...(asString(subagentRecord.agentPath) ? { agentPath: asString(subagentRecord.agentPath) } : {}),
                  ...(agentName ? { agentName } : {}),
                  ...(subagentKey ? { taskId: subagentKey } : {}),
                  startedAtMs,
                  backgrounded: true,
                  ...(totalTokens ? { usageTotalTokens: totalTokens } : {}),
                  ...(durationMs ? { usageDurationMs: durationMs } : {}),
                },
              }, { allowRaw: false });

              const toolEvent: ToolCallEvent = {
                id: canonicalKey,
                name: 'Agent',
                status: statusMapping.terminal ? (statusMapping.normalizedStatus === SDK_SUBAGENT_STATUS.COMPLETE ? 'complete' : 'error') : 'running',
                ...(detail.input ? { input: detail.input } : {}),
                ...(detail.output ? { output: detail.output } : {}),
                detail,
              };
              state.toolCalls.set(canonicalKey, toolEvent);
              this.emitToolCall(sessionId, toolEvent);
            } else if (folded.kind === 'agentMessage' && folded.text) {
              if (!state.currentText) {
                state.currentText = folded.text;
              }
            }
          }
        } catch (err) {
          logger.debug({ err, sessionId }, 'Muse items stream exited');
        }
      })();

      const outcome = await Promise.race([turn.completed, stallEscape]);
      // When the wait was abandoned the streams may never end; do not block on them.
      if (outcome.kind === 'stallAbandoned') {
        stalled = true;
      } else {
        await Promise.allSettled([deltasTask, itemsTask]);
      }

      // Snapshot before settling: a queued follow-up may start (and reset
      // `cancelled`) as soon as the runtime sees us idle.
      const wasStalled = stalled;
      const wasCancelled = state.cancelled;
      const finalText = state.currentText;
      const finalMessageId = state.currentMessageId!;
      settleTurn();

      if (wasStalled) {
        this.emitError(sessionId, {
          code: PROVIDER_ERROR_CODES.PROVIDER_ERROR,
          message: `Muse model produced no response within ${Math.round(museFirstActivityTimeoutMs() / 1000)}s (upstream stream stalled). The turn was interrupted; please send the message again.`,
          recoverable: true,
        });
        return;
      }

      if (wasCancelled) {
        logger.info({ sessionId }, 'Muse turn completed after cancellation');
        return;
      }

      if (outcome.kind === 'completed') {
        const terminal = outcome.params.terminal;
        if (terminal === 'failed') {
          const err = outcome.params.error;
          const rawMessage = err?.message || outcome.params.reason || 'Muse turn failed';
          const isAuthError = /lack access|not logged in|unauthorized|not exist/i.test(rawMessage);
          const message = isAuthError
            ? `${rawMessage} (Run \`muse login\` in terminal to authenticate your Meta account)`
            : rawMessage;
          this.emitError(sessionId, {
            code: PROVIDER_ERROR_CODES.PROVIDER_ERROR,
            message,
            recoverable: err?.retryable ?? true,
          });
          return;
        }

        const museUsage = buildMuseUsage(state.session, outcome.params.usage);
        const agentMessage: AgentMessage = {
          id: finalMessageId,
          sessionId,
          kind: 'text',
          role: 'assistant',
          content: finalText,
          timestamp: Date.now(),
          status: 'complete',
          metadata: {
            turnId: outcome.params.turnId,
            durationMs: outcome.params.durationMs,
            ...(state.model ? { model: state.model } : {}),
            ...(museUsage ? { usage: museUsage } : {}),
          },
        };
        this.emitComplete(sessionId, agentMessage);
        recordMuseQuotaActivity();
        if (this.spawned?.connection) {
          try {
            const res = await this.spawned.connection.request('usage/read', {});
            if (res?.usage) {
              updateMuseUsageQuota(res.usage as any);
              this.emitQuotaUpdate();
            }
          } catch (err) {
            logger.debug({ err }, 'Failed to read usage from Muse connection');
          }
        }
        void refreshMuseQuotaMetadata().catch(() => {});
      } else if (outcome.kind === 'unqueued') {
        this.emitError(sessionId, {
          code: PROVIDER_ERROR_CODES.PROVIDER_ERROR,
          message: 'Turn unqueued by host',
          recoverable: true,
        });
      } else if (outcome.kind === 'terminalUnknown') {
        this.emitError(sessionId, {
          code: PROVIDER_ERROR_CODES.CONNECTION_LOST,
          message: 'Host exited abnormally during turn',
          recoverable: false,
        });
      }
    } catch (err) {
      logger.error({ err, sessionId }, 'Failed during Muse turn execution');
      settleTurn();
      this.emitError(sessionId, {
        code: PROVIDER_ERROR_CODES.PROVIDER_ERROR,
        message: err instanceof Error ? err.message : String(err),
        recoverable: true,
      });
    } finally {
      // No-op when the turn was already settled before emitting.
      settleTurn();
    }
  }

  async cancel(sessionId: string, _options?: ProviderCancelOptions): Promise<void> {
    const state = this.sessions.get(sessionId);
    if (!state || !state.inFlight) return;
    state.cancelled = true;

    if (state.museSessionId && this.spawned) {
      try {
        await this.spawned.connection.command('turn/interrupt', {
          sessionId: state.museSessionId,
          ...(state.activeTurnId ? { turnId: state.activeTurnId } : {}),
        });
      } catch (err) {
        logger.debug({ err, sessionId }, 'Failed to issue turn/interrupt to Muse');
      }
    }
  }

  async cancelAndWait(sessionId: string): Promise<void> {
    await this.cancel(sessionId);
    const state = this.sessions.get(sessionId);
    if (!state || !state.inFlight) return;

    const start = Date.now();
    while (state.inFlight && Date.now() - start < 5000) {
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  async notifyActiveDelegation(
    sessionId: string,
    notification: ProviderDelegationNotification,
  ): Promise<AgentDelegationNotificationResult> {
    const state = this.sessions.get(sessionId);
    const turnId = state?.activeTurnId;
    if (!state?.inFlight || !turnId || state.cancelled || !state.museSessionId || !this.spawned) {
      return AGENT_DELEGATION_NOTIFICATION_RESULTS.STALE;
    }
    try {
      await this.spawned.connection.command('turn/steer', {
        commandId: randomUUID(),
        sessionId: state.museSessionId,
        expectedTurnId: turnId,
        input: [{ type: 'text', text: notification.text }],
      });
      return AGENT_DELEGATION_NOTIFICATION_RESULTS.DELIVERED;
    } catch (error) {
      logger.warn({ error, sessionId, turnId }, 'Failed to steer active Muse turn');
      const latest = this.sessions.get(sessionId);
      if (!latest || latest.activeTurnId !== turnId || latest.cancelled || !latest.inFlight) {
        return AGENT_DELEGATION_NOTIFICATION_RESULTS.STALE;
      }
      return AGENT_DELEGATION_NOTIFICATION_RESULTS.UNSUPPORTED;
    }
  }

  private handleApprovalRequest(routeId: string, request: MuseApprovalRequest): Promise<ApprovalDecisionInput> {
    return new Promise<ApprovalDecisionInput>((resolve) => {
      const state = this.sessions.get(routeId);
      if (!state) {
        resolve({ choiceId: request.availableChoices[0]?.choiceId ?? '' });
        return;
      }

      const approvalId = request.approvalId;
      const approvalReq: ApprovalRequest = {
        id: approvalId,
        description: `${request.toolName} ${request.rawArgs || ''}`.trim(),
        tool: request.toolName,
        provider: this.id,
        providerToolUseId: request.toolCallId || approvalId,
        inputPreview: request.rawArgs,
      };

      state.pendingApprovals.set(approvalId, {
        requestId: approvalId,
        request,
        resolve,
      });

      this.emitApprovalRequest(routeId, approvalReq);
    });
  }

  async respondApproval(sessionId: string, requestId: string, approved: boolean): Promise<void> {
    const state = this.sessions.get(sessionId);
    if (!state) return;

    const entry = state.pendingApprovals.get(requestId);
    if (!entry) return;

    const choices = entry.request.availableChoices;
    let targetChoice = approved
      ? choices.find((c: { decision?: string }) => c.decision === 'approved' || c.decision === 'approvedForSession')
      : choices.find((c: { decision?: string }) => c.decision === 'denied' || c.decision === 'deniedPolicyAmendment');

    if (!targetChoice) {
      targetChoice = choices[0];
    }

    state.pendingApprovals.delete(requestId);
    entry.resolve({ choiceId: targetChoice ? targetChoice.choiceId : '' });
  }

  async listModels(force = false): Promise<ProviderModelList> {
    const now = Date.now();
    if (!force && this.modelCache && now - this.modelCache.at < 60_000) {
      return this.modelCache.list;
    }

    try {
      if (this.spawned) {
        const raw = (await this.spawned.connection.command('model/list', {})) as {
          models?: Array<{ id?: string; modelId?: string; name?: string; displayLabel?: string; supportsReasoningEffort?: boolean }>;
        };
        if (Array.isArray(raw?.models) && raw.models.length > 0) {
          const models: ProviderModelInfo[] = raw.models.map((m) => {
            const id = m.modelId || m.id || 'muse-spark-1.3';
            return {
              id,
              name: m.displayLabel || m.name || id,
              supportsReasoningEffort: m.supportsReasoningEffort ?? true,
              supportedEffortLevels: MUSE_SDK_EFFORT_LEVELS,
            };
          });
          const list: ProviderModelList = {
            models,
            defaultModel: models.some((m) => m.id === 'muse-spark-1.3') ? 'muse-spark-1.3' : (models[0]?.id || 'muse-spark-1.3'),
            isAuthenticated: true,
          };
          this.modelCache = { at: now, list };
          return list;
        }
      }
    } catch (err) {
      logger.debug({ err }, 'Failed to query live Muse models via model/list');
    }

    const fallbackList: ProviderModelList = {
      models: DEFAULT_MUSE_MODELS,
      defaultModel: DEFAULT_MUSE_MODELS[0].id,
      isAuthenticated: true,
    };
    this.modelCache = { at: now, list: fallbackList };
    return fallbackList;
  }

  setSessionAgentId(sessionId: string, agentId: string): void {
    const state = this.sessions.get(sessionId);
    if (state) {
      const normalizedModel = normalizeMuseModelId(agentId);
      state.model = normalizedModel;
      this.emitSessionInfo(sessionId, { model: normalizedModel });
      if (this.spawned && state.museSessionId) {
        void this.spawned.connection
          .command('session/setModel', {
            commandId: randomUUID(),
            sessionId: state.museSessionId,
            model: { modelId: normalizedModel },
          })
          .catch((err) => {
            logger.warn({ err, sessionId, agentId: normalizedModel }, 'Failed to propagate session/setModel to Muse');
          });
      }
    }
  }

  refreshSessionSystemText(sessionId: string): void {
    const state = this.sessions.get(sessionId);
    if (!state) return;
    state.sessionSystemTextInjected = undefined;
  }

  setSessionEffort(sessionId: string, effort: TransportEffortLevel): void {
    const state = this.sessions.get(sessionId);
    if (state) {
      state.reasoningEffort = effort;
      this.emitSessionInfo(sessionId, { effort });
      if (this.spawned && state.museSessionId) {
        void this.spawned.connection
          .command('session/setReasoningEffort', {
            commandId: randomUUID(),
            sessionId: state.museSessionId,
            reasoningEffort: effort,
          })
          .catch((err) => {
            logger.warn({ err, sessionId, effort }, 'Failed to propagate session/setReasoningEffort to Muse');
          });
      }
    }
  }

  getMemoryMcpStatus(): MemoryMcpProviderStatusView {
    if (this.mcpRegistration?.degraded) {
      return {
        providerId: this.id,
        status: MEMORY_MCP_STATUS.DEGRADED,
        connected: Boolean(this.client),
        degradedReasons: [
          this.mcpRegistration.reason ?? MEMORY_MCP_PROVIDER_STATUS_REASON.MCP_REGISTRATION_FAILED,
        ],
      };
    }
    return {
      providerId: this.id,
      status: this.client ? MEMORY_MCP_STATUS.READY : MEMORY_MCP_STATUS.UNKNOWN,
      connected: Boolean(this.client),
      degradedReasons: [],
    };
  }

  getActiveWorkSnapshot(sessionId: string): ProviderActiveWorkSnapshot | null {
    const state = this.sessions.get(sessionId);
    if (!state) return null;
    const pendingApprovalCount = state.pendingApprovals.size;
    const activeToolCount = [...state.toolCalls.values()]
      .filter((tool) => tool.status === 'running').length;
    const activeWorkCount = (state.inFlight ? 1 : 0) + pendingApprovalCount + activeToolCount;
    const busyReasons: SessionActivityBusyReason[] = [];
    if (state.inFlight || pendingApprovalCount > 0) busyReasons.push('provider_wait');
    if (activeToolCount > 0) busyReasons.push('open_tool_call');
    return {
      status: 'current',
      activeWorkCount,
      activeToolCount,
      busyReasons,
      providerDiagnosticGeneration: state.activeTurnId ?? null,
      updatedAt: Date.now(),
    };
  }

  getSessionDiagnostics(sessionId: string): Record<string, unknown> | null {
    const state = this.sessions.get(sessionId);
    if (!state) return null;
    return {
      routeId: state.routeId,
      cwd: state.cwd,
      museSessionId: state.museSessionId,
      model: state.model,
      inFlight: state.inFlight,
      activeTurnId: state.activeTurnId,
      cancelled: state.cancelled,
      toolCallsCount: state.toolCalls.size,
      pendingApprovalsCount: state.pendingApprovals.size,
    };
  }

  // ── Callbacks ─────────────────────────────────────────────────────────────

  onDelta(cb: (sessionId: string, delta: MessageDelta) => void): () => void {
    this.deltaCallbacks.add(cb);
    return () => this.deltaCallbacks.delete(cb);
  }

  onComplete(cb: (sessionId: string, message: AgentMessage) => void): () => void {
    this.completeCallbacks.add(cb);
    return () => this.completeCallbacks.delete(cb);
  }

  onError(cb: (sessionId: string, error: ProviderError) => void): () => void {
    this.errorCallbacks.add(cb);
    return () => this.errorCallbacks.delete(cb);
  }

  onToolCall(cb: (sessionId: string, tool: ToolCallEvent) => void): void {
    this.toolCallCallbacks.add(cb);
  }

  onApprovalRequest(cb: (sessionId: string, req: ApprovalRequest) => void): void {
    this.approvalCallbacks.add(cb);
  }

  onSessionInfo(cb: (sessionId: string, info: SessionInfoUpdate) => void): () => void {
    this.sessionInfoCallbacks.add(cb);
    return () => this.sessionInfoCallbacks.delete(cb);
  }

  onStatus(cb: (sessionId: string, status: ProviderStatusUpdate) => void): () => void {
    this.statusCallbacks.add(cb);
    return () => this.statusCallbacks.delete(cb);
  }

  private emitDelta(sessionId: string, delta: MessageDelta): void {
    for (const cb of this.deltaCallbacks) {
      try {
        cb(sessionId, delta);
      } catch (err) {
        logger.error({ err }, 'Error in onDelta callback');
      }
    }
  }

  private emitComplete(sessionId: string, message: AgentMessage): void {
    for (const cb of this.completeCallbacks) {
      try {
        cb(sessionId, message);
      } catch (err) {
        logger.error({ err }, 'Error in onComplete callback');
      }
    }
  }

  private emitError(sessionId: string, error: ProviderError): void {
    for (const cb of this.errorCallbacks) {
      try {
        cb(sessionId, error);
      } catch (err) {
        logger.error({ err }, 'Error in onError callback');
      }
    }
  }

  private emitToolCall(sessionId: string, tool: ToolCallEvent): void {
    for (const cb of this.toolCallCallbacks) {
      try {
        cb(sessionId, tool);
      } catch (err) {
        logger.error({ err }, 'Error in onToolCall callback');
      }
    }
  }

  private emitApprovalRequest(sessionId: string, req: ApprovalRequest): void {
    for (const cb of this.approvalCallbacks) {
      try {
        cb(sessionId, req);
      } catch (err) {
        logger.error({ err }, 'Error in onApprovalRequest callback');
      }
    }
  }

  private emitSessionInfo(sessionId: string, info: SessionInfoUpdate): void {
    for (const cb of this.sessionInfoCallbacks) {
      try {
        cb(sessionId, info);
      } catch (err) {
        logger.error({ err }, 'Error in onSessionInfo callback');
      }
    }
  }

  private emitQuotaUpdate(): void {
    const quota = peekMuseUsageQuotaCached();
    if (!quota) return;
    for (const [routeId] of this.sessions) {
      this.emitSessionInfo(routeId, {
        ...(quota.quotaLabel ? { quotaLabel: quota.quotaLabel } : {}),
        ...(quota.quotaMeta ? { quotaMeta: quota.quotaMeta } : {}),
      });
    }
  }
}
