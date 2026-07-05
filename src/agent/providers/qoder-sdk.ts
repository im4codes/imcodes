import { randomUUID } from 'node:crypto';

import type {
  AuthOptions as QoderAuthOptions,
  McpServerStatus as QoderMcpServerStatus,
  Options as QoderOptions,
  Query as QoderQuery,
  SDKMessage as QoderSdkMessage,
} from '@qoder-ai/qoder-agent-sdk';

import type {
  ApprovalRequest,
  ProviderCapabilities,
  ProviderConfig,
  ProviderError,
  ProviderModelList,
  ProviderStatusUpdate,
  SessionConfig,
  SessionInfoUpdate,
  ToolCallEvent,
  TransportProvider,
} from '../transport-provider.js';
import {
  CONNECTION_MODES,
  normalizeProviderPayload,
  PROVIDER_ERROR_CODES,
  SESSION_OWNERSHIP,
} from '../transport-provider.js';
import type { AgentMessage, MessageDelta } from '../../../shared/agent-message.js';
import type { ProviderContextPayload } from '../../../shared/context-types.js';
import type { TransportAttachment } from '../../../shared/transport-attachments.js';
import { MEMORY_MCP_DEGRADED_REASON, MEMORY_MCP_STATUS, type MemoryMcpProviderStatusView } from '../../../shared/memory-ws.js';
import { IMCODES_MEMORY_MCP_SERVER_NAME } from '../../../shared/memory-mcp-server-name.js';
import { SESSION_CONTROL_METADATA_COMMAND_FIELD, isSessionControlCommandText } from '../../../shared/session-control-commands.js';
import {
  QODER_PROVIDER_ID,
  QODER_READINESS_REASON,
  type QoderTransportConfig,
  inspectQoderSdkPackage,
  normalizeQoderTransportConfig,
  pathExistsExecutable,
  previewQoderValue,
  redactQoderDiagnostic,
  sanitizeQoderValue,
} from '../qoder-sdk-config.js';
import { normalizeTransportCwd } from '../transport-paths.js';
import { getDefaultMcpServers } from './getDefaultMcpServers.js';
import { composeProviderSystemText } from '../provider-context-routing.js';
import { IMCODES_SESSION_ENV, IMCODES_SESSION_LABEL_ENV } from '../../../shared/imcodes-send.js';
import logger from '../../util/logger.js';

type QoderSdkModule = typeof import('@qoder-ai/qoder-agent-sdk');
type QoderSdkPackageMetadata = Awaited<ReturnType<typeof inspectQoderSdkPackage>>;

type QoderReadinessValue = 'ready' | 'degraded' | 'missing' | 'unknown';

interface QoderLayeredReadiness {
  connected: boolean;
  runtimeReady: QoderReadinessValue;
  sendReady: QoderReadinessValue;
  mcpStatus: MemoryMcpProviderStatusView['status'];
  modelStatus: 'static' | 'unproven' | 'unavailable';
  reasons: string[];
}

interface PendingApproval {
  id: string;
  generation: number;
  toolUseId: string;
  resolve: (approved: boolean) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface ActiveToolBlock {
  id: string;
  name: string;
  inputText: string;
  input?: unknown;
}

interface QoderSessionState {
  routeId: string;
  sessionName?: string;
  projectName?: string;
  serverId?: string;
  cwd: string;
  env?: Record<string, string>;
  selectedModel?: string;
  effectiveModel?: string;
  qoderSessionId?: string;
  activeQuery?: QoderQuery;
  activeGeneration: number;
  inFlight: boolean;
  cancelled: boolean;
  completedGeneration: number | null;
  currentMessageId: string | null;
  currentText: string;
  activeTools: Map<string, ActiveToolBlock>;
  toolBlocksByIndex: Map<number, ActiveToolBlock>;
  pendingApprovals: Map<string, PendingApproval>;
  mcpStatus: MemoryMcpProviderStatusView;
  readiness: QoderLayeredReadiness;
  config: QoderTransportConfig;
  lastUnknownMessages: string[];
}

interface QoderSendOptions {
  prompt: string;
  options: QoderOptions;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function safeJson(value: unknown): unknown {
  return sanitizeQoderValue(value);
}

function normalizeUsage(usage: unknown): AgentMessage['metadata'] {
  if (!isRecord(usage)) return undefined;
  const metadata: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(usage)) {
    if (typeof value === 'number' || typeof value === 'string' || typeof value === 'boolean') {
      metadata[key] = value;
    }
  }
  return Object.keys(metadata).length ? { usage: metadata } : undefined;
}

function mcpStatusFromQoder(statuses: QoderMcpServerStatus[] | undefined): MemoryMcpProviderStatusView {
  const memory = statuses?.find((status) => status.name === IMCODES_MEMORY_MCP_SERVER_NAME);
  if (!memory) {
    return {
      providerId: QODER_PROVIDER_ID,
      status: MEMORY_MCP_STATUS.DEGRADED,
      connected: false,
      degradedReasons: [QODER_READINESS_REASON.MCP_STATUS_UNAVAILABLE],
    };
  }
  if (memory.status === 'connected') {
    return {
      providerId: QODER_PROVIDER_ID,
      status: MEMORY_MCP_STATUS.READY,
      connected: true,
      degradedReasons: [],
    };
  }
  if (memory.status === 'disabled') {
    return {
      providerId: QODER_PROVIDER_ID,
      status: MEMORY_MCP_STATUS.DISABLED,
      connected: false,
      degradedReasons: [memory.error ? redactQoderDiagnostic(memory.error) : MEMORY_MCP_DEGRADED_REASON.FEATURE_DISABLED],
    };
  }
  return {
    providerId: QODER_PROVIDER_ID,
    status: MEMORY_MCP_STATUS.DEGRADED,
    connected: false,
    degradedReasons: [memory.status, ...(memory.error ? [redactQoderDiagnostic(memory.error)] : [])],
  };
}

function missingIdentity(config: SessionConfig): string[] {
  const missing: string[] = [];
  if (!config.sessionName?.trim()) missing.push('sessionName');
  if (!config.projectName?.trim()) missing.push('projectName');
  if (!config.serverId?.trim()) missing.push('serverId');
  return missing;
}

function createDefaultReadiness(connected: boolean): QoderLayeredReadiness {
  return {
    connected,
    runtimeReady: 'unknown',
    sendReady: 'unknown',
    mcpStatus: MEMORY_MCP_STATUS.UNKNOWN,
    modelStatus: 'unproven',
    reasons: [],
  };
}

export class QoderSdkProvider implements TransportProvider {
  readonly id = QODER_PROVIDER_ID;
  readonly connectionMode = CONNECTION_MODES.LOCAL_SDK;
  readonly sessionOwnership = SESSION_OWNERSHIP.SHARED;
  readonly capabilities: ProviderCapabilities = {
    streaming: true,
    toolCalling: true,
    approval: true,
    sessionRestore: false,
    multiTurn: true,
    attachments: false,
    reasoningEffort: false,
    contextSupport: 'degraded-message-side-context-mapping',
    compact: {
      execution: 'slash-command',
      providerCommand: '/compact',
      verified: false,
      completion: 'provider-event',
      cancellation: 'local-cancel',
      reason: 'Qoder native compact support is not proven; IM.codes forwards /compact as Qoder-native slash/text input.',
    },
  };

  private config: ProviderConfig = {};
  private sdk: QoderSdkModule | null = null;
  private sdkImportError: ProviderError | null = null;
  private packageMetadata: QoderSdkPackageMetadata | null = null;
  private sessions = new Map<string, QoderSessionState>();
  private providerReadiness: QoderLayeredReadiness = createDefaultReadiness(false);
  private deltaCallbacks: Array<(sessionId: string, delta: MessageDelta) => void> = [];
  private completeCallbacks: Array<(sessionId: string, message: AgentMessage) => void> = [];
  private errorCallbacks: Array<(sessionId: string, error: ProviderError) => void> = [];
  private toolCallCallbacks: Array<(sessionId: string, tool: ToolCallEvent) => void> = [];
  private approvalCallbacks: Array<(sessionId: string, req: ApprovalRequest) => void> = [];
  private sessionInfoCallbacks: Array<(sessionId: string, info: SessionInfoUpdate) => void> = [];
  private statusCallbacks: Array<(sessionId: string, status: ProviderStatusUpdate) => void> = [];

  async connect(config: ProviderConfig): Promise<void> {
    this.config = config;
    this.providerReadiness = {
      ...createDefaultReadiness(true),
      runtimeReady: 'degraded',
      sendReady: 'degraded',
      reasons: [QODER_READINESS_REASON.AUTH_MISSING],
    };
    try {
      this.sdk = await import('@qoder-ai/qoder-agent-sdk');
      this.sdkImportError = null;
      const metadata = await inspectQoderSdkPackage().catch((err) => {
        logger.warn({ err }, 'Qoder SDK package metadata audit failed');
        return null;
      });
      this.packageMetadata = metadata;
      const workerAvailable = this.sdk.hasResolvableQoderWorkerRuntime?.() === true;
      const processRuntimeAvailable = metadata?.bundledQoderCliPresent === true || await pathExistsExecutable(process.env.QODERCLI_PATH);
      this.providerReadiness.runtimeReady = processRuntimeAvailable || workerAvailable ? 'ready' : 'degraded';
      this.providerReadiness.sendReady = 'degraded';
      this.providerReadiness.reasons = processRuntimeAvailable || workerAvailable
        ? [QODER_READINESS_REASON.AUTH_MISSING]
        : [QODER_READINESS_REASON.RUNTIME_MISSING, QODER_READINESS_REASON.AUTH_MISSING];
      logger.info({
        provider: this.id,
        sdkVersion: metadata?.version,
        qoderCliVersion: metadata?.qoderCliVersion,
        hasInstallScript: metadata?.hasInstallScript,
        bundledQoderCliPresent: metadata?.bundledQoderCliPresent,
        workerAvailable,
      }, 'Qoder SDK provider connected');
    } catch (err) {
      this.sdk = null;
      this.packageMetadata = null;
      this.sdkImportError = this.makeError(
        PROVIDER_ERROR_CODES.CONFIG_ERROR,
        `Qoder SDK import failed: ${redactQoderDiagnostic(err)}`,
        false,
        { reason: QODER_READINESS_REASON.SUPPLY_CHAIN_PRECHECK_FAILED },
      );
      this.providerReadiness.runtimeReady = 'missing';
      this.providerReadiness.sendReady = 'missing';
      this.providerReadiness.reasons = [QODER_READINESS_REASON.SUPPLY_CHAIN_PRECHECK_FAILED];
      logger.warn({ err }, 'Qoder SDK import failed; provider connected in degraded state');
    }
  }

  async disconnect(): Promise<void> {
    for (const state of this.sessions.values()) {
      await this.cleanupState(state, 'provider_disconnect');
    }
    this.sessions.clear();
    this.providerReadiness = createDefaultReadiness(false);
    this.sdk = null;
    this.sdkImportError = null;
  }

  async createSession(config: SessionConfig): Promise<string> {
    const routeId = config.bindExistingKey ?? config.sessionKey;
    const normalized = normalizeQoderTransportConfig(this.config, config.settings);
    if (!normalized.ok) throw normalized.error;
    const cwd = normalizeTransportCwd(config.cwd) ?? normalizeTransportCwd(process.cwd())!;
    const identityMissing = missingIdentity(config);
    const mcpStatus: MemoryMcpProviderStatusView = identityMissing.length > 0
      ? {
          providerId: this.id,
          status: MEMORY_MCP_STATUS.DEGRADED,
          connected: false,
          degradedReasons: [QODER_READINESS_REASON.MCP_IDENTITY_MISSING, ...identityMissing],
        }
      : {
          providerId: this.id,
          status: MEMORY_MCP_STATUS.UNKNOWN,
          connected: false,
          degradedReasons: [MEMORY_MCP_DEGRADED_REASON.QODER_MCP_STATUS_UNPROVEN],
        };
    const authReady = this.resolveAuthReady(normalized.config);
    const runtimeReadiness = await this.resolveRuntimeReadiness(normalized.config);
    const readiness: QoderLayeredReadiness = {
      connected: true,
      runtimeReady: runtimeReadiness.value,
      sendReady: runtimeReadiness.ready && authReady.ready ? 'ready' : 'degraded',
      mcpStatus: mcpStatus.status,
      modelStatus: config.agentId || normalized.config.model ? 'static' : 'unproven',
      reasons: [
        ...runtimeReadiness.reasons,
        ...(authReady.ready ? [] : [authReady.reason]),
        ...(identityMissing.length > 0 ? [QODER_READINESS_REASON.MCP_IDENTITY_MISSING] : []),
      ],
    };
    const state: QoderSessionState = {
      routeId,
      sessionName: config.sessionName,
      projectName: config.projectName,
      serverId: config.serverId,
      cwd,
      env: config.env,
      selectedModel: config.agentId ?? normalized.config.model,
      effectiveModel: config.agentId ?? normalized.config.model,
      activeGeneration: 0,
      inFlight: false,
      cancelled: false,
      completedGeneration: null,
      currentMessageId: null,
      currentText: '',
      activeTools: new Map(),
      toolBlocksByIndex: new Map(),
      pendingApprovals: new Map(),
      mcpStatus,
      readiness,
      config: normalized.config,
      lastUnknownMessages: [],
    };
    this.sessions.set(routeId, state);
    if (state.effectiveModel) this.emitSessionInfo(routeId, { model: state.effectiveModel });
    return routeId;
  }

  async endSession(sessionId: string): Promise<void> {
    const state = this.sessions.get(sessionId);
    if (!state) return;
    await this.cleanupState(state, 'session_stop');
    this.sessions.delete(sessionId);
  }

  async send(
    sessionId: string,
    payloadOrMessage: string | ProviderContextPayload,
    attachments?: TransportAttachment[],
    extraSystemPrompt?: string,
  ): Promise<void> {
    const state = this.sessions.get(sessionId);
    if (!state) throw this.makeError(PROVIDER_ERROR_CODES.SESSION_NOT_FOUND, `Qoder session not found: ${sessionId}`, false);
    if (!this.sdk) throw this.sdkImportError ?? this.makeError(PROVIDER_ERROR_CODES.CONFIG_ERROR, 'Qoder SDK is unavailable', false);
    if (attachments?.length) {
      throw this.makeError(PROVIDER_ERROR_CODES.CONFIG_ERROR, 'Qoder SDK attachments are not supported in IM.codes v1', false, {
        reason: QODER_READINESS_REASON.UNPROVEN_CAPABILITY,
      });
    }
    if (state.inFlight) {
      throw this.makeError(PROVIDER_ERROR_CODES.PROVIDER_ERROR, 'Qoder session is already busy', true);
    }
    await this.assertSendReady(state);
    const payload = normalizeProviderPayload(payloadOrMessage, attachments, extraSystemPrompt);
    const generation = state.activeGeneration + 1;
    state.activeGeneration = generation;
    state.inFlight = true;
    state.cancelled = false;
    state.completedGeneration = null;
    state.currentMessageId = null;
    state.currentText = '';
    state.activeTools.clear();
    state.toolBlocksByIndex.clear();
    const queryOptions = this.buildSendOptions(state, payload);
    this.emitStatus(sessionId, { status: 'qoder_running', label: 'Qoder running...' });
    const query = this.sdk.query(queryOptions);
    state.activeQuery = query;
    void this.consumeQuery(sessionId, state, generation, query).catch((err) => {
      if (state.activeGeneration !== generation || state.cancelled) return;
      this.finishWithError(sessionId, state, generation, this.normalizeQoderError(err));
    });
  }

  async cancel(sessionId: string): Promise<void> {
    const state = this.sessions.get(sessionId);
    if (!state) return;
    const generation = state.activeGeneration;
    state.cancelled = true;
    this.denyPendingApprovals(state, 'Qoder turn cancelled');
    try {
      await state.activeQuery?.interrupt?.();
    } catch (err) {
      logger.debug({ err, sessionId }, 'Qoder interrupt failed; using local abandon');
    } finally {
      await state.activeQuery?.close?.().catch(() => {});
      if (state.activeGeneration === generation) {
        this.finishWithError(sessionId, state, generation, this.makeError(PROVIDER_ERROR_CODES.CANCELLED, 'Qoder turn cancelled', true));
      }
    }
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
    this.toolCallCallbacks.push(cb);
  }

  onApprovalRequest(cb: (sessionId: string, req: ApprovalRequest) => void): void {
    this.approvalCallbacks.push(cb);
  }

  onSessionInfo(cb: (sessionId: string, info: SessionInfoUpdate) => void): () => void {
    this.sessionInfoCallbacks.push(cb);
    return () => { this.sessionInfoCallbacks = this.sessionInfoCallbacks.filter((entry) => entry !== cb); };
  }

  onStatus(cb: (sessionId: string, status: ProviderStatusUpdate) => void): () => void {
    this.statusCallbacks.push(cb);
    return () => { this.statusCallbacks = this.statusCallbacks.filter((entry) => entry !== cb); };
  }

  async respondApproval(sessionId: string, requestId: string, approved: boolean): Promise<void> {
    const state = this.sessions.get(sessionId);
    if (!state) throw this.makeError(PROVIDER_ERROR_CODES.SESSION_NOT_FOUND, 'Qoder approval session not found', false);
    const parsed = this.parseApprovalRequestId(requestId);
    if (!parsed || parsed.routeId !== state.routeId || parsed.generation !== state.activeGeneration) {
      throw this.makeError(PROVIDER_ERROR_CODES.PROVIDER_ERROR, 'Qoder approval request id is malformed or stale', false);
    }
    const pending = state.pendingApprovals.get(requestId);
    if (!pending || pending.generation !== parsed.generation || pending.toolUseId !== parsed.toolUseId) {
      throw this.makeError(PROVIDER_ERROR_CODES.PROVIDER_ERROR, 'Qoder approval request is stale or unknown', false);
    }
    clearTimeout(pending.timer);
    state.pendingApprovals.delete(requestId);
    pending.resolve(approved);
  }

  setSessionAgentId(sessionId: string, agentId: string): void {
    const state = this.sessions.get(sessionId);
    if (!state) return;
    state.selectedModel = agentId;
    state.effectiveModel = agentId;
    this.emitSessionInfo(sessionId, { model: agentId });
  }

  async listModels(_force?: boolean): Promise<ProviderModelList> {
    return {
      models: [],
      isAuthenticated: false,
      error: 'Qoder dynamic model listing is proof-gated and disabled in IM.codes v1.',
    };
  }

  getMemoryMcpStatus(): MemoryMcpProviderStatusView {
    const states = [...this.sessions.values()];
    if (states.length === 0) {
      return {
        providerId: this.id,
        status: MEMORY_MCP_STATUS.UNKNOWN,
        connected: this.providerReadiness.connected,
        degradedReasons: [MEMORY_MCP_DEGRADED_REASON.STATUS_NOT_REPORTED],
      };
    }
    if (states.some((state) => state.mcpStatus.status === MEMORY_MCP_STATUS.READY)) {
      return {
        providerId: this.id,
        status: MEMORY_MCP_STATUS.READY,
        connected: true,
        degradedReasons: [],
      };
    }
    const reasons = [...new Set(states.flatMap((state) => state.mcpStatus.degradedReasons ?? []))];
    return {
      providerId: this.id,
      status: states.some((state) => state.mcpStatus.status === MEMORY_MCP_STATUS.DEGRADED)
        ? MEMORY_MCP_STATUS.DEGRADED
        : MEMORY_MCP_STATUS.UNKNOWN,
      connected: this.providerReadiness.connected,
      degradedReasons: reasons.length ? reasons : [MEMORY_MCP_DEGRADED_REASON.STATUS_NOT_REPORTED],
    };
  }

  getSessionDiagnostics(sessionId: string): Record<string, unknown> | null {
    const state = this.sessions.get(sessionId);
    if (!state) return null;
    return {
      provider: this.id,
      routeId: state.routeId,
      qoderSessionIdKnown: Boolean(state.qoderSessionId),
      active: state.inFlight,
      activeGeneration: state.activeGeneration,
      cancelled: state.cancelled,
      selectedModel: state.selectedModel ?? null,
      effectiveModel: state.effectiveModel ?? null,
      readiness: state.readiness,
      mcpStatus: state.mcpStatus,
      pendingApprovalCount: state.pendingApprovals.size,
      activeToolCount: state.activeTools.size,
      unknownMessageCount: state.lastUnknownMessages.length,
      authMode: state.config.authMode,
      authEnvVar: state.config.authMode === 'pat-env' ? state.config.accessTokenEnvVar : null,
      dangerousPermissionBypass: state.config.allowDangerousPermissionBypass,
    };
  }

  private resolveAuthReady(config: QoderTransportConfig): { ready: boolean; reason: string; message: string } {
    if (config.authMode === 'qodercli') {
      return {
        ready: false,
        reason: QODER_READINESS_REASON.UNPROVEN_CAPABILITY,
        message: 'Qoder qodercli auth reuse is proof-gated in IM.codes v1; configure PAT env auth instead.',
      };
    }
    if (process.env[config.accessTokenEnvVar]?.trim()) {
      return { ready: true, reason: '', message: '' };
    }
    return {
      ready: false,
      reason: QODER_READINESS_REASON.AUTH_MISSING,
      message: `Qoder PAT env var ${config.accessTokenEnvVar} is not configured in the daemon environment.`,
    };
  }

  private parseApprovalRequestId(requestId: string): { routeId: string; generation: number; toolUseId: string } | null {
    const match = /^qoder:([^:]+):(\d+):(.+)$/.exec(requestId);
    if (!match) return null;
    const generation = Number.parseInt(match[2], 10);
    if (!Number.isSafeInteger(generation) || generation < 1) return null;
    return {
      routeId: match[1],
      generation,
      toolUseId: match[3],
    };
  }

  private async resolveRuntimeReadiness(config: QoderTransportConfig): Promise<{ ready: boolean; value: QoderReadinessValue; reasons: string[] }> {
    if (!this.sdk) {
      return {
        ready: false,
        value: 'missing',
        reasons: [QODER_READINESS_REASON.SUPPLY_CHAIN_PRECHECK_FAILED],
      };
    }
    if (config.useWorkerRuntime) {
      const workerReady = this.sdk.hasResolvableQoderWorkerRuntime?.(config.pathToQoderWorkerRuntime) === true;
      return workerReady
        ? { ready: true, value: 'ready', reasons: [] }
        : { ready: false, value: 'degraded', reasons: [QODER_READINESS_REASON.RUNTIME_MISSING] };
    }
    if (config.pathToQoderCLIExecutable) {
      const executableReady = await pathExistsExecutable(config.pathToQoderCLIExecutable);
      return executableReady
        ? { ready: true, value: 'ready', reasons: [] }
        : { ready: false, value: 'degraded', reasons: [QODER_READINESS_REASON.RUNTIME_MISSING] };
    }
    if (process.env.QODERCLI_PATH && await pathExistsExecutable(process.env.QODERCLI_PATH)) {
      return { ready: true, value: 'ready', reasons: [] };
    }
    if (this.packageMetadata?.bundledQoderCliPresent === true) {
      return { ready: true, value: 'ready', reasons: [] };
    }
    return {
      ready: false,
      value: 'degraded',
      reasons: [QODER_READINESS_REASON.RUNTIME_MISSING],
    };
  }

  private async assertSendReady(state: QoderSessionState): Promise<void> {
    if (this.sdkImportError) throw this.sdkImportError;
    const runtimeReadiness = await this.resolveRuntimeReadiness(state.config);
    const authReadiness = this.resolveAuthReady(state.config);
    state.readiness.runtimeReady = runtimeReadiness.value;
    state.readiness.sendReady = runtimeReadiness.ready && authReadiness.ready ? 'ready' : 'degraded';
    state.readiness.reasons = [
      ...runtimeReadiness.reasons,
      ...(authReadiness.ready ? [] : [authReadiness.reason]),
    ];
    if (!runtimeReadiness.ready) {
      throw this.makeError(PROVIDER_ERROR_CODES.CONFIG_ERROR, 'Qoder runtime is not ready', true, {
        reason: QODER_READINESS_REASON.RUNTIME_MISSING,
        readiness: state.readiness,
      });
    }
    if (!authReadiness.ready) {
      const code = authReadiness.reason === QODER_READINESS_REASON.UNPROVEN_CAPABILITY
        ? PROVIDER_ERROR_CODES.CONFIG_ERROR
        : PROVIDER_ERROR_CODES.AUTH_FAILED;
      throw this.makeError(code, authReadiness.message, false, {
        reason: authReadiness.reason,
        authMode: state.config.authMode,
        accessTokenEnvVar: state.config.authMode === 'pat-env' ? state.config.accessTokenEnvVar : undefined,
      });
    }
  }

  private buildSendOptions(state: QoderSessionState, payload: ProviderContextPayload): QoderSendOptions {
    const options: QoderOptions = {
      auth: this.buildAuthOptions(state),
      cwd: state.cwd,
      includePartialMessages: true,
      includeHookEvents: false,
      maxTurns: 1,
      permissionMode: state.config.permissionMode,
      allowDangerouslySkipPermissions: state.config.allowDangerousPermissionBypass,
      canUseTool: (toolName, input, opts) => this.handleCanUseTool(state, toolName, input, opts),
      controlRequestTimeoutMs: state.config.controlRequestTimeoutMs,
      closeGraceMs: state.config.closeGraceMs,
      strictMcpConfig: true,
      allowedMcpServerNames: [IMCODES_MEMORY_MCP_SERVER_NAME],
      onAuthExpired: () => {
        state.readiness.sendReady = 'degraded';
        state.readiness.reasons = [...new Set([...state.readiness.reasons, QODER_READINESS_REASON.AUTH_FAILED])];
      },
      stderr: (data: string) => {
        logger.debug({ provider: this.id, sessionId: state.routeId, stderr: redactQoderDiagnostic(data) }, 'Qoder SDK stderr');
      },
    };
    if (state.config.pathToQoderCLIExecutable) options.pathToQoderCLIExecutable = state.config.pathToQoderCLIExecutable;
    if (state.config.useWorkerRuntime && this.sdk) {
      options.transport = new this.sdk.WorkerTransport({
        ...(state.config.pathToQoderWorkerRuntime ? { pathToQoderWorkerRuntime: state.config.pathToQoderWorkerRuntime } : {}),
        closeGraceMs: state.config.closeGraceMs,
      });
    }
    const qoderEnv = this.buildQoderProcessEnv(state);
    if (Object.keys(qoderEnv).length > 0) options.env = qoderEnv;
    if (state.config.debug) options.debug = true;
    if (state.config.model || state.selectedModel) options.model = state.selectedModel ?? state.config.model;
    if (state.qoderSessionId) {
      options.sessionId = state.qoderSessionId;
      options.continue = true;
    }
    const systemPrompt = composeProviderSystemText(payload);
    if (systemPrompt) options.systemPrompt = systemPrompt;
    const mcpServers = this.buildMcpServers(state);
    if (mcpServers) options.mcpServers = mcpServers;
    return {
      prompt: payload.assembledMessage,
      options,
    };
  }

  private buildAuthOptions(state: QoderSessionState): QoderAuthOptions {
    if (!this.sdk) throw new Error('Qoder SDK not loaded');
    if (state.config.authMode === 'qodercli') return this.sdk.qodercliAuth();
    return this.sdk.accessTokenFromEnv(state.config.accessTokenEnvVar);
  }

  private buildQoderProcessEnv(state: QoderSessionState): Record<string, string> {
    const env: Record<string, string> = {};
    const copyFromProcess = (key: string): void => {
      const value = process.env[key];
      if (typeof value === 'string' && value.length > 0) env[key] = value;
    };
    const copyIdentityFromSession = (key: string): void => {
      const value = state.env?.[key];
      if (typeof value === 'string' && value.length > 0) env[key] = value;
    };
    for (const key of [
      'PATH',
      'HOME',
      'SHELL',
      'USER',
      'LANG',
      'LC_ALL',
      'TMPDIR',
      'QODER_CLI_HOME',
      'QODER_CONFIG_DIR',
    ]) {
      copyFromProcess(key);
    }
    copyIdentityFromSession(IMCODES_SESSION_ENV);
    copyIdentityFromSession(IMCODES_SESSION_LABEL_ENV);
    if (state.config.authMode === 'pat-env') {
      copyFromProcess(state.config.accessTokenEnvVar);
    }
    return env;
  }

  private buildMcpServers(state: QoderSessionState): QoderOptions['mcpServers'] | undefined {
    if (state.mcpStatus.status === MEMORY_MCP_STATUS.DEGRADED
      && state.mcpStatus.degradedReasons?.includes(QODER_READINESS_REASON.MCP_IDENTITY_MISSING)) {
      return undefined;
    }
    const server = getDefaultMcpServers({
      sessionKey: state.routeId,
      sessionName: state.sessionName,
      projectName: state.projectName,
      serverId: state.serverId,
      cwd: state.cwd,
      env: state.env,
    })[IMCODES_MEMORY_MCP_SERVER_NAME];
    return {
      [IMCODES_MEMORY_MCP_SERVER_NAME]: {
        type: 'stdio',
        command: server.command,
        args: [...server.args],
        env: server.env,
      },
    };
  }

  private async handleCanUseTool(
    state: QoderSessionState,
    toolName: string,
    input: Record<string, unknown>,
    options: { toolUseID?: string; signal?: AbortSignal; title?: string; description?: string },
  ): Promise<{ behavior: 'allow' } | { behavior: 'deny'; message: string; interrupt?: boolean }> {
    if (state.cancelled) return { behavior: 'deny', message: 'Qoder turn is cancelling', interrupt: true };
    const toolUseId = readString(options.toolUseID) ?? randomUUID();
    const approvalId = `qoder:${state.routeId}:${state.activeGeneration}:${toolUseId}`;
    const description = options.description
      ?? options.title
      ?? `${toolName} wants to run`;
    this.emitApproval(state.routeId, {
      id: approvalId,
      tool: toolName,
      description,
      provider: this.id,
      providerGeneration: state.activeGeneration,
      providerToolUseId: toolUseId,
      inputPreview: previewQoderValue(input),
    });
    const approved = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        state.pendingApprovals.delete(approvalId);
        resolve(false);
      }, state.config.approvalBridgeTimeoutMs);
      timer.unref?.();
      const pending: PendingApproval = {
        id: approvalId,
        generation: state.activeGeneration,
        toolUseId,
        resolve,
        timer,
      };
      state.pendingApprovals.set(approvalId, pending);
      options.signal?.addEventListener('abort', () => {
        if (!state.pendingApprovals.has(approvalId)) return;
        clearTimeout(timer);
        state.pendingApprovals.delete(approvalId);
        resolve(false);
      }, { once: true });
    });
    if (!approved) return { behavior: 'deny', message: 'Denied by IM.codes approval policy', interrupt: false };
    return { behavior: 'allow' };
  }

  private async consumeQuery(sessionId: string, state: QoderSessionState, generation: number, query: QoderQuery): Promise<void> {
    let streamError: unknown;
    try {
      for await (const message of query) {
        if (this.isStale(state, generation)) continue;
        this.handleMessage(sessionId, state, generation, message);
      }
    } catch (err) {
      streamError = err;
      throw err;
    } finally {
      if (state.activeQuery === query) state.activeQuery = undefined;
      if (streamError === undefined && !this.isStale(state, generation) && state.completedGeneration !== generation) {
        this.finishWithError(sessionId, state, generation, this.makeError(
          PROVIDER_ERROR_CODES.PROVIDER_ERROR,
          'Qoder SDK stream ended without a terminal result.',
          true,
          { reason: QODER_READINESS_REASON.RUNTIME_INCOMPATIBLE },
        ));
      }
    }
  }

  private handleMessage(sessionId: string, state: QoderSessionState, generation: number, msg: QoderSdkMessage): void {
    if (!isRecord(msg)) return;
    const qoderSessionId = readString(msg.session_id);
    if (qoderSessionId && !state.qoderSessionId) {
      state.qoderSessionId = qoderSessionId;
      this.emitSessionInfo(sessionId, { resumeId: undefined, model: state.effectiveModel });
    }
    switch (msg.type) {
      case 'system':
        this.handleSystemMessage(sessionId, state, msg);
        return;
      case 'stream_event':
        this.handleStreamEvent(sessionId, state, generation, msg.event);
        return;
      case 'assistant':
        this.handleAssistantMessage(sessionId, state, msg);
        return;
      case 'result':
        this.handleResultMessage(sessionId, state, generation, msg);
        return;
      case 'prompt_suggestion':
      case 'user':
        return;
      default:
        this.recordUnknown(state, `message:${String(msg.type)}`);
    }
  }

  private handleSystemMessage(sessionId: string, state: QoderSessionState, msg: Record<string, unknown>): void {
    if (msg.subtype === 'init') {
      const model = readString(msg.model);
      if (model) {
        state.effectiveModel = model;
        this.emitSessionInfo(sessionId, { model });
      }
      const mcpStatuses = Array.isArray(msg.mcp_servers)
        ? msg.mcp_servers.filter(isRecord).map((entry) => ({
            name: String(entry.name ?? ''),
            status: String(entry.status ?? 'pending') as QoderMcpServerStatus['status'],
          }))
        : undefined;
      state.mcpStatus = mcpStatusFromQoder(mcpStatuses as QoderMcpServerStatus[] | undefined);
      state.readiness.mcpStatus = state.mcpStatus.status;
      state.readiness.sendReady = 'ready';
      return;
    }
    if (msg.subtype === 'status') {
      const statusRecord = isRecord(msg.status) ? msg.status : undefined;
      const status = readString(statusRecord?.status) ?? readString(statusRecord?.type) ?? 'qoder_status';
      this.emitStatus(sessionId, { status, label: status.replace(/_/g, ' ') });
      return;
    }
    if (msg.subtype === 'compact_boundary') {
      this.emitStatus(sessionId, {
        status: 'qoder_compact_boundary',
        label: 'Qoder context compacted.',
      });
      return;
    }
    if (msg.subtype === 'task_started' || msg.subtype === 'task_progress' || msg.subtype === 'task_notification') {
      this.emitStatus(sessionId, {
        status: `qoder_${String(msg.subtype)}`,
        label: readString(msg.summary) ?? readString(msg.description) ?? 'Qoder task update',
      });
      return;
    }
    if (msg.subtype === 'permission_denied') {
      this.emitStatus(sessionId, { status: 'qoder_permission_denied', label: 'Qoder permission denied' });
      return;
    }
    this.recordUnknown(state, `system:${String(msg.subtype)}`);
  }

  private handleStreamEvent(sessionId: string, state: QoderSessionState, generation: number, event: unknown): void {
    if (!isRecord(event)) return;
    const type = readString(event.type);
    if (type === 'message_start') {
      const message = isRecord(event.message) ? event.message : undefined;
      state.currentMessageId = readString(message?.id) ?? `${sessionId}:qoder:${generation}`;
      state.currentText = '';
      return;
    }
    if (type === 'content_block_start') {
      const index = readNumber(event.index) ?? state.toolBlocksByIndex.size;
      const block = isRecord(event.content_block) ? event.content_block : undefined;
      if (block?.type === 'tool_use') {
        const tool: ActiveToolBlock = {
          id: readString(block.id) ?? randomUUID(),
          name: readString(block.name) ?? 'tool',
          inputText: '',
          input: isRecord(block.input) ? safeJson(block.input) : undefined,
        };
        state.activeTools.set(tool.id, tool);
        state.toolBlocksByIndex.set(index, tool);
        this.emitTool(sessionId, {
          id: tool.id,
          name: tool.name,
          status: 'running',
          input: tool.input,
          detail: { kind: 'qoderTool', input: tool.input },
        });
      }
      return;
    }
    if (type === 'content_block_delta') {
      const delta = isRecord(event.delta) ? event.delta : {};
      const deltaType = readString(delta.type);
      if (deltaType === 'text_delta') {
        const text = readString(delta.text) ?? '';
        state.currentText += text;
        const messageId = state.currentMessageId ?? `${sessionId}:qoder:${generation}`;
        state.currentMessageId = messageId;
        this.emitDelta(sessionId, {
          messageId,
          type: 'text',
          delta: text,
          role: 'assistant',
        });
        return;
      }
      if (deltaType === 'thinking_delta') {
        this.emitStatus(sessionId, { status: 'thinking', label: 'Thinking...' });
        return;
      }
      if (deltaType === 'input_json_delta') {
        const index = readNumber(event.index);
        const tool = index === undefined ? undefined : state.toolBlocksByIndex.get(index);
        if (!tool) return;
        tool.inputText += readString(delta.partial_json) ?? '';
        try {
          tool.input = JSON.parse(tool.inputText);
        } catch {
          tool.input = tool.inputText.slice(0, 4096);
        }
        this.emitDelta(sessionId, {
          messageId: state.currentMessageId ?? `${sessionId}:qoder:${generation}`,
          type: 'tool_use',
          delta: '',
          role: 'assistant',
          toolUse: {
            id: tool.id,
            name: tool.name,
            status: 'running',
            input: safeJson(tool.input),
            detail: { kind: 'qoderTool', input: safeJson(tool.input) },
          },
        });
        return;
      }
    }
    if (type === 'content_block_stop') {
      const index = readNumber(event.index);
      const tool = index === undefined ? undefined : state.toolBlocksByIndex.get(index);
      if (tool) {
        this.emitTool(sessionId, {
          id: tool.id,
          name: tool.name,
          status: 'complete',
          input: safeJson(tool.input),
          detail: { kind: 'qoderTool', input: safeJson(tool.input) },
        });
      }
      return;
    }
    this.recordUnknown(state, `stream_event:${type ?? 'unknown'}`);
  }

  private handleAssistantMessage(sessionId: string, state: QoderSessionState, msg: Record<string, unknown>): void {
    const message = isRecord(msg.message) ? msg.message : undefined;
    const content = Array.isArray(message?.content) ? message.content : [];
    for (const block of content) {
      if (!isRecord(block)) continue;
      if (block.type === 'text') {
        const text = readString(block.text) ?? '';
        if (!text || text === state.currentText) continue;
        state.currentText = text;
        this.emitDelta(sessionId, {
          messageId: state.currentMessageId ?? readString(msg.uuid) ?? `${sessionId}:qoder:${state.activeGeneration}`,
          type: 'text',
          delta: state.currentText,
          role: 'assistant',
        });
      }
      if (block.type === 'tool_use') {
        const tool: ActiveToolBlock = {
          id: readString(block.id) ?? randomUUID(),
          name: readString(block.name) ?? 'tool',
          inputText: '',
          input: isRecord(block.input) ? safeJson(block.input) : undefined,
        };
        this.emitTool(sessionId, {
          id: tool.id,
          name: tool.name,
          status: 'running',
          input: tool.input,
          detail: { kind: 'qoderTool', input: tool.input },
        });
      }
    }
    const usage = isRecord(message?.usage) ? message.usage : undefined;
    if (usage) {
      this.emitSessionInfo(sessionId, {
        model: state.effectiveModel,
      });
    }
  }

  private handleResultMessage(sessionId: string, state: QoderSessionState, generation: number, msg: Record<string, unknown>): void {
    if (state.completedGeneration === generation) return;
    if (msg.subtype === 'success') {
      const content = readString(msg.result) ?? state.currentText;
      this.finishWithComplete(sessionId, state, generation, {
        id: readString(msg.uuid) ?? state.currentMessageId ?? `${sessionId}:qoder-result:${generation}`,
        sessionId,
        kind: 'text',
        role: 'assistant',
        content,
        timestamp: Date.now(),
        status: 'complete',
        metadata: {
          provider: this.id,
          ...(state.effectiveModel ? { model: state.effectiveModel } : {}),
          ...normalizeUsage(msg.usage),
          ...(isSessionControlCommandText(content, 'compact') ? { [SESSION_CONTROL_METADATA_COMMAND_FIELD]: 'compact' } : {}),
        },
      });
      return;
    }
    const errors = Array.isArray(msg.errors) ? msg.errors.map(redactQoderDiagnostic) : [];
    this.finishWithError(sessionId, state, generation, this.makeError(
      PROVIDER_ERROR_CODES.PROVIDER_ERROR,
      errors[0] ?? 'Qoder turn failed',
      false,
      { errors },
    ));
  }

  private finishWithComplete(sessionId: string, state: QoderSessionState, generation: number, message: AgentMessage): void {
    if (this.isStale(state, generation) || state.completedGeneration === generation) return;
    state.completedGeneration = generation;
    state.inFlight = false;
    state.cancelled = false;
    state.activeQuery = undefined;
    this.denyPendingApprovals(state, 'Qoder turn completed');
    this.emitComplete(sessionId, message);
    this.emitStatus(sessionId, { status: null, label: null });
  }

  private finishWithError(sessionId: string, state: QoderSessionState, generation: number, error: ProviderError): void {
    if (state.activeGeneration !== generation || state.completedGeneration === generation) return;
    state.completedGeneration = generation;
    state.inFlight = false;
    state.activeQuery = undefined;
    this.denyPendingApprovals(state, error.message);
    this.emitError(sessionId, error);
    this.emitStatus(sessionId, { status: null, label: null });
  }

  private async cleanupState(state: QoderSessionState, reason: string): Promise<void> {
    state.cancelled = true;
    state.activeGeneration += 1;
    this.denyPendingApprovals(state, `Qoder session cleanup: ${reason}`);
    await state.activeQuery?.close?.().catch(() => {});
    state.activeQuery = undefined;
    state.inFlight = false;
    state.activeTools.clear();
    state.toolBlocksByIndex.clear();
  }

  private denyPendingApprovals(state: QoderSessionState, _reason: string): void {
    for (const pending of state.pendingApprovals.values()) {
      clearTimeout(pending.timer);
      pending.resolve(false);
    }
    state.pendingApprovals.clear();
  }

  private isStale(state: QoderSessionState, generation: number): boolean {
    return state.activeGeneration !== generation || state.cancelled;
  }

  private normalizeQoderError(err: unknown): ProviderError {
    if (isRecord(err)) {
      const name = readString(err.name);
      const code = readString(err.code);
      if (name === 'AbortError' || code === 'ABORT_ERR') {
        return this.makeError(PROVIDER_ERROR_CODES.CANCELLED, 'Qoder turn cancelled', true);
      }
      if (name === 'ProtocolVersionMismatchError') {
        return this.makeError(PROVIDER_ERROR_CODES.CONFIG_ERROR, 'Qoder protocol version mismatch', false, {
          reason: QODER_READINESS_REASON.RUNTIME_INCOMPATIBLE,
        });
      }
      if (/auth/i.test(`${code ?? ''} ${String(err.message ?? '')}`)) {
        return this.makeError(PROVIDER_ERROR_CODES.AUTH_FAILED, 'Qoder authentication failed', false, {
          reason: QODER_READINESS_REASON.AUTH_FAILED,
        });
      }
    }
    return this.makeError(PROVIDER_ERROR_CODES.PROVIDER_ERROR, redactQoderDiagnostic(err), false);
  }

  private makeError(code: string, message: string, recoverable: boolean, details?: unknown): ProviderError {
    return {
      code,
      message,
      recoverable,
      ...(details !== undefined ? { details } : {}),
    };
  }

  private recordUnknown(state: QoderSessionState, reason: string): void {
    state.lastUnknownMessages.push(reason);
    if (state.lastUnknownMessages.length > 16) state.lastUnknownMessages.shift();
  }

  private emitDelta(sessionId: string, delta: MessageDelta): void {
    for (const cb of this.deltaCallbacks) cb(sessionId, delta);
  }

  private emitComplete(sessionId: string, message: AgentMessage): void {
    for (const cb of this.completeCallbacks) cb(sessionId, message);
  }

  private emitError(sessionId: string, error: ProviderError): void {
    for (const cb of this.errorCallbacks) cb(sessionId, error);
  }

  private emitTool(sessionId: string, tool: ToolCallEvent): void {
    for (const cb of this.toolCallCallbacks) cb(sessionId, tool);
  }

  private emitApproval(sessionId: string, req: ApprovalRequest): void {
    for (const cb of this.approvalCallbacks) cb(sessionId, req);
  }

  private emitSessionInfo(sessionId: string, info: SessionInfoUpdate): void {
    for (const cb of this.sessionInfoCallbacks) cb(sessionId, info);
  }

  private emitStatus(sessionId: string, status: ProviderStatusUpdate): void {
    for (const cb of this.statusCallbacks) cb(sessionId, status);
  }
}
