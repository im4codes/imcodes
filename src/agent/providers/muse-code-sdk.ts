import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
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
} from '../transport-provider.js';
import {
  BACKGROUND_SUBAGENT_WAKE_MODES,
  CONNECTION_MODES,
  normalizeProviderPayload,
  PROVIDER_ERROR_CODES,
  SESSION_OWNERSHIP,
} from '../transport-provider.js';
import type { AgentMessage, MessageDelta } from '../../../shared/agent-message.js';
import type { ProviderContextPayload } from '../../../shared/context-types.js';
import type { TransportAttachment } from '../../../shared/transport-attachments.js';
import { MEMORY_MCP_STATUS, type MemoryMcpProviderStatusView } from '../../../shared/memory-ws.js';
import {
  MUSE_SDK_EFFORT_LEVELS,
  type TransportEffortLevel,
} from '../../../shared/effort-levels.js';
import { NATIVE_AGENT_ADMISSION_MODES } from '../../../shared/native-collaboration-policy.js';
import { composeMessageSideProviderPrompt } from '../provider-context-routing.js';
import { normalizeTransportCwd, resolveExecutableForSpawn, resolveMuseCodePathForSdk } from '../transport-paths.js';
import logger from '../../util/logger.js';

export const MUSE_CODE_SDK_PROVIDER_ID = 'muse-code-sdk';

export const DEFAULT_MUSE_MODELS: ProviderModelInfo[] = [
  {
    id: 'muse-spark',
    name: 'Muse Spark',
    supportsReasoningEffort: true,
    supportedEffortLevels: MUSE_SDK_EFFORT_LEVELS,
  },
  {
    id: 'muse-wonder',
    name: 'Muse Wonder',
    supportsReasoningEffort: true,
    supportedEffortLevels: MUSE_SDK_EFFORT_LEVELS,
  },
  {
    id: 'muse-fast',
    name: 'Muse Fast',
    supportsReasoningEffort: true,
    supportedEffortLevels: MUSE_SDK_EFFORT_LEVELS,
  },
];

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
  };

  private config: ProviderConfig | null = null;
  private client: MuseClient | null = null;
  private spawned: SpawnedMspConnection | null = null;
  private sessions = new Map<string, MuseSessionState>();

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

    try {
      const handshake = spawnMspConnection({
        command: resolved.executable,
        args: [...resolved.prependArgs, ...args],
        cwd: typeof config.cwd === 'string' ? config.cwd : process.cwd(),
        env: {
          ...process.env,
          ...(config.env as Record<string, string> | undefined),
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
    const requestedModel = typeof config.agentId === 'string' && config.agentId.trim()
      ? config.agentId.trim()
      : (typeof (config as any).model === 'string' && (config as any).model.trim()
        ? (config as any).model.trim()
        : undefined);
    let session: Session;

    try {
      if (config.resumeId) {
        session = await this.client.resumeSession({
          sessionId: config.resumeId,
        });
      } else {
        session = await this.client.startSession({
          workspaceRoot,
          ...(requestedModel ? { modelId: requestedModel } : {}),
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
              const toolStatus: 'running' | 'complete' | 'error' =
                folded.status === 'inProgress' ? 'running' : folded.status === 'failed' ? 'error' : 'complete';
              const toolEvent: ToolCallEvent = {
                id: toolId,
                name: folded.tool,
                status: toolStatus,
                input: parseJsonSafe(folded.args),
                output: folded.visibleOutput,
              };
              state.toolCalls.set(toolId, toolEvent);
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
          models?: Array<{ id: string; name?: string; supportsReasoningEffort?: boolean }>;
        };
        if (Array.isArray(raw?.models) && raw.models.length > 0) {
          const models: ProviderModelInfo[] = raw.models.map((m) => ({
            id: m.id,
            name: m.name || m.id,
            supportsReasoningEffort: m.supportsReasoningEffort ?? true,
            supportedEffortLevels: MUSE_SDK_EFFORT_LEVELS,
          }));
          const list: ProviderModelList = {
            models,
            defaultModel: models[0]?.id,
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
      state.model = agentId;
      this.emitSessionInfo(sessionId, { model: agentId });
    }
  }

  setSessionEffort(sessionId: string, effort: TransportEffortLevel): void {
    const state = this.sessions.get(sessionId);
    if (state) {
      state.reasoningEffort = effort;
    }
  }

  getMemoryMcpStatus(): MemoryMcpProviderStatusView {
    return {
      providerId: this.id,
      status: this.client ? MEMORY_MCP_STATUS.READY : MEMORY_MCP_STATUS.UNKNOWN,
      connected: Boolean(this.client),
      degradedReasons: [],
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
