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
import { composeMessageSideProviderPrompt } from '../provider-context-routing.js';
import { normalizeTransportCwd, resolveExecutableForSpawn, resolveMuseCodePathForSdk } from '../transport-paths.js';
import {
  ensureMuseMcpConfigHasImcodesEntry,
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

export const MUSE_CODE_SDK_PROVIDER_ID = 'muse-code-sdk';

export const DEFAULT_MUSE_MODELS: ProviderModelInfo[] = [
  {
    id: 'wander',
    name: 'Wander',
    supportsReasoningEffort: true,
    supportedEffortLevels: MUSE_SDK_EFFORT_LEVELS,
  },
  {
    id: 'wander-code',
    name: 'Wander Code',
    supportsReasoningEffort: true,
    supportedEffortLevels: MUSE_SDK_EFFORT_LEVELS,
  },
  {
    id: 'wander-fast',
    name: 'Wander Fast',
    supportsReasoningEffort: true,
    supportedEffortLevels: MUSE_SDK_EFFORT_LEVELS,
  },
  {
    id: 'wander-pro',
    name: 'Wander Pro',
    supportsReasoningEffort: true,
    supportedEffortLevels: MUSE_SDK_EFFORT_LEVELS,
  },
];

export function normalizeMuseModelId(model: string | undefined): string {
  const trimmed = model?.trim();
  if (!trimmed) return 'wander';
  if (trimmed === 'wonder' || trimmed === 'muse-wonder' || trimmed === 'muse-spark' || trimmed === 'muse-spark-1.3') {
    return 'wander';
  }
  if (trimmed === 'muse-fast') {
    return 'wander-fast';
  }
  return trimmed;
}

function readStoredMuseApiKey(): string | undefined {
  try {
    const credPath = process.env.MUSE_AUTH_PATH?.trim()
      || (process.env.XDG_CONFIG_HOME?.trim()
        ? join(process.env.XDG_CONFIG_HOME.trim(), 'muse', 'auth.json')
        : join(homedir(), '.config', 'muse', 'auth.json'));
    if (existsSync(credPath)) {
      const parsed = JSON.parse(readFileSync(credPath, 'utf8'));
      const key = parsed?.providers?.meta?.api_key || parsed?.providers?.meta?.access_token;
      if (typeof key === 'string' && key.trim()) {
        return key.trim();
      }
    }
  } catch {
    // Ignore read errors
  }
  return undefined;
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
  sessionSystemTextSent: boolean;
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
  private spawned: SpawnedMspConnection | null = null;
  private sessions = new Map<string, MuseSessionState>();
  private mcpRegistration: MuseMcpEnsureResult | null = null;

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

    this.mcpRegistration = await ensureMuseMcpConfigHasImcodesEntry(museMcpEnsureOptionsFromConfig(config)).catch((err) => {
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

    const args = ['serve', ...(Array.isArray(config.args) ? (config.args as string[]) : ['--trust-workspace'])];
    if (typeof config.provider === 'string' && config.provider.trim() && !args.includes('--provider')) {
      args.push('--provider', config.provider.trim());
    }

    const apiKey = typeof config.apiKey === 'string' && config.apiKey.trim()
      ? config.apiKey.trim()
      : ((config.env as Record<string, string> | undefined)?.META_API_KEY
        || process.env.META_API_KEY
        || readStoredMuseApiKey());

    try {
      const handshake = spawnMspConnection({
        command: resolved.executable,
        args: [...resolved.prependArgs, ...args],
        cwd: typeof config.cwd === 'string' ? config.cwd : process.cwd(),
        env: {
          ...process.env,
          ...(config.env as Record<string, string> | undefined),
          ...(apiKey ? { META_API_KEY: apiKey } : {}),
        },
        onStderr: (chunk: string) => {
          logger.debug({ chunk }, 'muse serve stderr');
        },
      });

      this.spawned = await handshake.initialize({
        clientInfo: { name: 'imcodes', version: '1.0.0' },
      });

      this.client = new MuseClient(this.spawned.connection, {
        host: this.spawned,
        durability: readSessionDurability(this.spawned.initializeResult),
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
    this.spawned = null;
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

    const workspaceRoot = normalizeTransportCwd(config.cwd) ?? process.cwd();
    const requestedModel = normalizeMuseModelId(
      typeof config.agentId === 'string' && config.agentId.trim()
        ? config.agentId.trim()
        : (typeof (config as any).model === 'string' && (config as any).model.trim()
          ? (config as any).model.trim()
          : 'wander'),
    );
    let session: Session;

    try {
      if (config.resumeId) {
        session = await this.client.resumeSession({
          sessionId: config.resumeId,
        });
        if (requestedModel && this.spawned) {
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
        session = await this.client.startSession({
          workspaceRoot,
          modelId: requestedModel,
          providerId: 'meta',
        });
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
      sessionSystemTextSent: !!config.resumeId && !config.fresh,
      toolCalls: new Map(),
    };

    session.onApproval((request) => this.handleApprovalRequest(routeId, request));

    this.sessions.set(routeId, state);
    this.emitSessionInfo(routeId, {
      resumeId: session.sessionId,
      ...(state.model ? { model: state.model } : {}),
    });

    return routeId;
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
    const prompt = composeMessageSideProviderPrompt(normalized, {
      includeSessionSystemText: !state.sessionSystemTextSent,
    });
    state.sessionSystemTextSent = true;

    const effort = mapEffortLevel(state.reasoningEffort);

    try {
      const turn = await state.session.sendUserTurn({
        input: [{ type: 'text', text: prompt }],
        ...(effort ? { reasoningEffort: effort } : {}),
      });

      state.activeTurn = turn;
      state.activeTurnId = turn.turnId;

      const deltasTask = (async () => {
        try {
          for await (const delta of turn.deltas()) {
            if (state.cancelled) break;
            const deltaItem = delta as MuseItemDelta;
            if (!deltaItem.field || deltaItem.field === 'text') {
              state.currentText += deltaItem.delta;
              this.emitDelta(sessionId, {
                messageId: state.currentMessageId!,
                type: 'text',
                delta: deltaItem.delta,
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

      const outcome = await turn.completed;
      await Promise.allSettled([deltasTask, itemsTask]);

      if (state.cancelled) {
        logger.info({ sessionId }, 'Muse turn completed after cancellation');
        return;
      }

      if (outcome.kind === 'completed') {
        const terminal = outcome.params.terminal;
        if (terminal === 'failed') {
          const err = outcome.params.error;
          this.emitError(sessionId, {
            code: PROVIDER_ERROR_CODES.PROVIDER_ERROR,
            message: err?.message || outcome.params.reason || 'Muse turn failed',
            recoverable: err?.retryable ?? true,
          });
          return;
        }

        const agentMessage: AgentMessage = {
          id: state.currentMessageId!,
          sessionId,
          kind: 'text',
          role: 'assistant',
          content: state.currentText,
          timestamp: Date.now(),
          status: 'complete',
          metadata: {
            turnId: outcome.params.turnId,
            durationMs: outcome.params.durationMs,
            ...(state.model ? { model: state.model } : {}),
            ...(outcome.params.usage ? { usage: outcome.params.usage } : {}),
          },
        };
        this.emitComplete(sessionId, agentMessage);
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
      this.emitError(sessionId, {
        code: PROVIDER_ERROR_CODES.PROVIDER_ERROR,
        message: err instanceof Error ? err.message : String(err),
        recoverable: true,
      });
    } finally {
      state.inFlight = false;
      state.activeTurn = null;
      state.activeTurnId = null;
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
            const id = m.modelId || m.id || 'wander';
            return {
              id,
              name: m.displayLabel || m.name || id,
              supportsReasoningEffort: m.supportsReasoningEffort ?? true,
              supportedEffortLevels: MUSE_SDK_EFFORT_LEVELS,
            };
          });
          const list: ProviderModelList = {
            models,
            defaultModel: models.some((m) => m.id === 'wander') ? 'wander' : models[0]?.id,
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
}
