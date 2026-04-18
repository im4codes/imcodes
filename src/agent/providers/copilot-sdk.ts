import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type {
  TransportProvider,
  ProviderCapabilities,
  ProviderConfig,
  ProviderError,
  SessionConfig,
  SessionInfoUpdate,
  ProviderStatusUpdate,
  ToolCallEvent,
  ApprovalRequest,
  RemoteSessionInfo,
} from '../transport-provider.js';
import {
  CONNECTION_MODES,
  normalizeProviderPayload,
  SESSION_OWNERSHIP,
  PROVIDER_ERROR_CODES,
} from '../transport-provider.js';
import type { AgentMessage, MessageDelta } from '../../../shared/agent-message.js';
import type { ProviderContextPayload } from '../../../shared/context-types.js';
import type { TransportAttachment } from '../../../shared/transport-attachments.js';
import logger from '../../util/logger.js';
import { resolveBinaryWithWindowsFallbacks } from '../transport-paths.js';
import { type TransportEffortLevel } from '../../../shared/effort-levels.js';

const COPILOT_BIN = 'copilot';
const MIN_PROTOCOL_VERSION = 3;
const COMPATIBLE_CLI_RANGE = '^1.0.31';
const DEFAULT_APPROVAL_TIMEOUT_MS = 30_000;

export interface CopilotSdkRuntimeHooks {
  loadSdk(): Promise<typeof import('@github/copilot-sdk')>;
}

export const copilotSdkRuntimeHooks: CopilotSdkRuntimeHooks = {
  loadSdk: async () => import('@github/copilot-sdk'),
};

type CopilotSessionLike = {
  sessionId: string;
  send(options: Record<string, unknown>): Promise<void>;
  abort(): Promise<void>;
  setModel(model: string, options?: Record<string, unknown>): Promise<void>;
  on(handler: (event: Record<string, any>) => void): () => void;
  disconnect?(): Promise<void>;
};

type CopilotClientLike = {
  start(): Promise<void>;
  stop(): Promise<void>;
  getStatus(): Promise<{ version: string; protocolVersion: number }>;
  getAuthStatus(): Promise<{ isAuthenticated: boolean; statusMessage?: string }>;
  createSession(config: Record<string, unknown>): Promise<CopilotSessionLike>;
  resumeSession(sessionId: string, config: Record<string, unknown>): Promise<CopilotSessionLike>;
  listSessions(filter?: Record<string, unknown>): Promise<Array<{ sessionId: string; summary?: string; modifiedTime?: Date | string | number }>>;
  deleteSession(sessionId: string): Promise<void>;
  listModels(): Promise<Array<{ id: string; capabilities?: { supports?: { reasoningEffort?: boolean } } }>>;
};

interface PendingApproval {
  routeId: string;
  requestId: string;
  generation: number;
  timer: ReturnType<typeof setTimeout> | null;
  resolve: (result: Record<string, unknown>) => void;
}

interface CopilotSessionState {
  routeId: string;
  sessionId: string;
  session: CopilotSessionLike;
  cwd: string;
  model?: string;
  effort?: TransportEffortLevel;
  currentMessageId: string | null;
  currentText: string;
  completionEmittedForCurrentTurn: boolean;
  currentOutputTokens?: number;
  currentInteractionId?: string;
  busy: boolean;
  backgroundTainted: boolean;
  cancelRequested: boolean;
  cancelErrorEmitted: boolean;
  rotationInProgress: boolean;
  generation: number;
  lastStatusSignature: string | null;
  pendingApprovals: Map<string, PendingApproval>;
  unsubscribes: Array<() => void>;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function mapEffortToCopilot(effort: TransportEffortLevel | undefined): 'low' | 'medium' | 'high' | 'xhigh' | undefined {
  switch (effort) {
    case 'low': return 'low';
    case 'medium': return 'medium';
    case 'high': return 'high';
    case 'max': return 'xhigh';
    default: return undefined;
  }
}

function isCompatibleCopilotCliVersion(version: string | undefined): boolean {
  if (!isNonEmptyString(version)) return false;
  const match = version.trim().match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  if (major !== 1) return false;
  return minor > 0 || patch >= 31;
}

function stringifyUnknown(value: unknown): string | undefined {
  if (value == null) return undefined;
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function toAttachmentPayload(attachments: TransportAttachment[] | undefined): Array<Record<string, unknown>> | undefined {
  if (!attachments?.length) return undefined;
  return attachments.map((attachment) => ({
    type: 'file',
    path: attachment.daemonPath,
    ...(attachment.originalName ? { displayName: attachment.originalName } : {}),
  }));
}

function buildApprovalDescription(request: Record<string, unknown>): string {
  const kind = isNonEmptyString(request.kind) ? request.kind : 'tool';
  switch (kind) {
    case 'shell': {
      const command = isNonEmptyString(request.fullCommandText)
        ? request.fullCommandText
        : isNonEmptyString(request.command)
          ? request.command
          : stringifyUnknown(request);
      return command ? `Allow shell command: ${command}` : 'Allow shell command';
    }
    case 'write': {
      const filePath = isNonEmptyString(request.filePath) ? request.filePath : undefined;
      return filePath ? `Allow file write: ${filePath}` : 'Allow file write';
    }
    case 'url': {
      const url = isNonEmptyString(request.url) ? request.url : undefined;
      return url ? `Allow URL access: ${url}` : 'Allow URL access';
    }
    case 'mcp': {
      const serverName = isNonEmptyString(request.serverName) ? request.serverName : 'mcp';
      const toolName = isNonEmptyString(request.toolName) ? request.toolName : 'tool';
      return `Allow MCP tool ${serverName}:${toolName}`;
    }
    case 'custom-tool': {
      const toolName = isNonEmptyString(request.toolName) ? request.toolName : 'custom-tool';
      return `Allow custom tool ${toolName}`;
    }
    case 'read': {
      const filePath = isNonEmptyString(request.filePath) ? request.filePath : undefined;
      return filePath ? `Allow file read: ${filePath}` : 'Allow file read';
    }
    default:
      return `Allow ${kind} permission request`;
  }
}

function toolFromEvent(event: Record<string, any>): ToolCallEvent | null {
  if (event.type === 'tool.execution_start') {
    return {
      id: String(event.data?.toolCallId ?? randomUUID()),
      name: String(event.data?.toolName ?? 'tool'),
      status: 'running',
      ...(event.data?.arguments !== undefined ? { input: event.data.arguments } : {}),
      detail: {
        kind: 'tool.execution_start',
        summary: String(event.data?.toolName ?? 'tool'),
        input: event.data?.arguments,
        meta: {
          ...(event.data?.mcpServerName ? { mcpServerName: event.data.mcpServerName } : {}),
          ...(event.data?.mcpToolName ? { mcpToolName: event.data.mcpToolName } : {}),
        },
        raw: event,
      },
    };
  }
  if (event.type === 'tool.execution_complete') {
    return {
      id: String(event.data?.toolCallId ?? randomUUID()),
      name: String(event.data?.toolName ?? 'tool'),
      status: event.data?.success === false ? 'error' : 'complete',
      ...(event.data?.result ? { output: stringifyUnknown(event.data.result.detailedContent ?? event.data.result.content ?? event.data.result.contents) } : {}),
      detail: {
        kind: 'tool.execution_complete',
        summary: String(event.data?.toolName ?? 'tool'),
        output: event.data?.result?.detailedContent ?? event.data?.result?.content ?? event.data?.result?.contents,
        meta: {
          success: event.data?.success,
          model: event.data?.model,
          interactionId: event.data?.interactionId,
          isUserRequested: event.data?.isUserRequested,
        },
        raw: event,
      },
    };
  }
  return null;
}

export class CopilotSdkProvider implements TransportProvider {
  readonly id = 'copilot-sdk';
  readonly connectionMode = CONNECTION_MODES.LOCAL_SDK;
  readonly sessionOwnership = SESSION_OWNERSHIP.SHARED;
  readonly capabilities: ProviderCapabilities = {
    streaming: true,
    toolCalling: true,
    approval: true,
    sessionRestore: true,
    multiTurn: true,
    attachments: true,
    reasoningEffort: true,
    supportedEffortLevels: ['low', 'medium', 'high', 'max'],
    contextSupport: 'degraded-message-side-context-mapping',
  };

  private config: ProviderConfig | null = null;
  private approvalTimeoutMs = DEFAULT_APPROVAL_TIMEOUT_MS;
  private sdk: typeof import('@github/copilot-sdk') | null = null;
  private client: CopilotClientLike | null = null;
  private sessions = new Map<string, CopilotSessionState>();
  private poisonedSessionIds = new Set<string>();
  private deltaCallbacks: Array<(sessionId: string, delta: MessageDelta) => void> = [];
  private completeCallbacks: Array<(sessionId: string, message: AgentMessage) => void> = [];
  private errorCallbacks: Array<(sessionId: string, error: ProviderError) => void> = [];
  private toolCallCallbacks: Array<(sessionId: string, tool: ToolCallEvent) => void> = [];
  private sessionInfoCallbacks: Array<(sessionId: string, info: SessionInfoUpdate) => void> = [];
  private statusCallbacks: Array<(sessionId: string, status: ProviderStatusUpdate) => void> = [];
  private approvalCallbacks: Array<(sessionId: string, req: ApprovalRequest) => void> = [];

  async connect(config: ProviderConfig): Promise<void> {
    const sdk = await copilotSdkRuntimeHooks.loadSdk();
    const resolvedBinary = this.resolveBinaryPath(config);
    const client = new sdk.CopilotClient({
      ...(resolvedBinary ? { cliPath: resolvedBinary } : {}),
      autoStart: false,
    }) as unknown as CopilotClientLike;
    try {
      await client.start();
      const status = await client.getStatus();
      if (!isCompatibleCopilotCliVersion(status.version)) {
        throw this.makeError(
          PROVIDER_ERROR_CODES.CONFIG_ERROR,
          `Copilot CLI ${status.version ?? 'unknown'} is outside supported range ${COMPATIBLE_CLI_RANGE}`,
          false,
          status,
        );
      }
      if (typeof status.protocolVersion !== 'number' || status.protocolVersion < MIN_PROTOCOL_VERSION) {
        throw this.makeError(
          PROVIDER_ERROR_CODES.CONFIG_ERROR,
          `Copilot SDK protocol ${status.protocolVersion ?? 'unknown'} is below required ${MIN_PROTOCOL_VERSION} (tested with CLI ${COMPATIBLE_CLI_RANGE})`,
          false,
          status,
        );
      }
      const auth = await client.getAuthStatus();
      if (!auth.isAuthenticated) {
        throw this.makeError(
          PROVIDER_ERROR_CODES.AUTH_FAILED,
          auth.statusMessage || 'Copilot is not authenticated',
          false,
          auth,
        );
      }
      try {
        await client.listModels();
      } catch (error) {
        logger.warn({ provider: this.id, error }, 'Copilot listModels probe failed — continuing with connect');
      }
      this.sdk = sdk;
      this.client = client;
      this.config = config;
      this.approvalTimeoutMs = this.resolveApprovalTimeoutMs(config);
      logger.info({ provider: this.id, binary: resolvedBinary ?? 'default' }, 'Copilot SDK provider connected');
    } catch (error) {
      try { await client.stop(); } catch {}
      if (this.isProviderError(error)) throw error;
      throw this.normalizeConnectError(error);
    }
  }

  async disconnect(): Promise<void> {
    for (const state of this.sessions.values()) {
      state.unsubscribes.forEach((fn) => fn());
      try { await state.session.disconnect?.(); } catch {}
      for (const pending of state.pendingApprovals.values()) {
        if (pending.timer) clearTimeout(pending.timer);
        pending.resolve({ kind: 'denied-no-approval-rule-and-could-not-request-from-user' });
      }
      state.pendingApprovals.clear();
    }
    this.sessions.clear();
    this.poisonedSessionIds.clear();
    if (this.client) {
      try { await this.client.stop(); } catch {}
    }
    this.client = null;
    this.sdk = null;
    this.config = null;
  }

  async createSession(config: SessionConfig): Promise<string> {
    this.assertConnected();
    const routeId = config.bindExistingKey ?? config.sessionKey;
    const existing = this.sessions.get(routeId);
    if (existing && !config.fresh) {
      if (isNonEmptyString(config.agentId)) existing.model = config.agentId;
      if (isNonEmptyString(config.resumeId) && config.resumeId !== existing.sessionId) {
        await this.replaceSession(existing, config.resumeId);
      }
      this.emitSessionInfo(routeId, {
        resumeId: existing.sessionId,
        ...(existing.model ? { model: existing.model } : {}),
        ...(existing.effort ? { effort: existing.effort } : {}),
      });
      return routeId;
    }
    if (existing && config.fresh) {
      await this.endSession(routeId);
    }

    const model = isNonEmptyString(config.agentId) ? config.agentId : this.resolveDefaultModel();
    const effort = config.effort;
    const session = config.skipCreate && isNonEmptyString(config.resumeId)
      ? await this.resumeSdkSession(config.resumeId, config, model, effort)
      : await this.createSdkSession(config, model, effort);
    const state: CopilotSessionState = {
      routeId,
      sessionId: session.sessionId,
      session,
      cwd: isNonEmptyString(config.cwd) ? config.cwd : process.cwd(),
      model,
      effort,
      currentMessageId: null,
      currentText: '',
      completionEmittedForCurrentTurn: false,
      currentOutputTokens: undefined,
      currentInteractionId: undefined,
      busy: false,
      backgroundTainted: false,
      cancelRequested: false,
      cancelErrorEmitted: false,
      rotationInProgress: false,
      generation: 0,
      lastStatusSignature: null,
      pendingApprovals: new Map(),
      unsubscribes: [],
    };
    this.sessions.set(routeId, state);
    this.attachSession(state);
    this.emitSessionInfo(routeId, {
      resumeId: session.sessionId,
      ...(model ? { model } : {}),
      ...(effort ? { effort } : {}),
    });
    return routeId;
  }

  async endSession(sessionId: string): Promise<void> {
    const state = this.getSessionState(sessionId);
    if (!state) return;
    state.unsubscribes.forEach((fn) => fn());
    state.unsubscribes = [];
    for (const pending of state.pendingApprovals.values()) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.resolve({ kind: 'denied-no-approval-rule-and-could-not-request-from-user' });
    }
    state.pendingApprovals.clear();
    try { await state.session.disconnect?.(); } catch {}
    this.sessions.delete(state.routeId);
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

  onApprovalRequest(cb: (sessionId: string, req: ApprovalRequest) => void): void {
    this.approvalCallbacks.push(cb);
  }

  async respondApproval(sessionId: string, requestId: string, approved: boolean): Promise<void> {
    const state = this.getSessionState(sessionId);
    if (!state) {
      throw this.makeError(PROVIDER_ERROR_CODES.SESSION_NOT_FOUND, `Unknown Copilot session: ${sessionId}`, false);
    }
    const pending = state.pendingApprovals.get(requestId);
    if (!pending) {
      throw this.makeError(PROVIDER_ERROR_CODES.PROVIDER_ERROR, `Unknown approval request: ${requestId}`, true);
    }
    state.pendingApprovals.delete(requestId);
    if (pending.timer) clearTimeout(pending.timer);
    pending.resolve(approved
      ? { kind: 'approved' }
      : { kind: 'denied-interactively-by-user' });
    this.emitStatus(state.routeId, { status: null, label: null });
  }

  setSessionAgentId(sessionId: string, agentId: string): void {
    const state = this.getSessionState(sessionId);
    if (!state) return;
    state.model = agentId;
    this.emitSessionInfo(state.routeId, { resumeId: state.sessionId, model: agentId });
    void state.session.setModel(agentId, {
      ...(mapEffortToCopilot(state.effort) ? { reasoningEffort: mapEffortToCopilot(state.effort) } : {}),
    }).catch((error) => {
      logger.warn({ err: error, provider: this.id, sessionId: state.routeId }, 'Failed to update Copilot session model');
    });
  }

  setSessionEffort(sessionId: string, effort: TransportEffortLevel): void {
    const state = this.getSessionState(sessionId);
    if (!state) return;
    state.effort = effort;
    this.emitSessionInfo(state.routeId, { resumeId: state.sessionId, effort });
    if (!state.model) return;
    void state.session.setModel(state.model, {
      ...(mapEffortToCopilot(effort) ? { reasoningEffort: mapEffortToCopilot(effort) } : {}),
    }).catch((error) => {
      logger.warn({ err: error, provider: this.id, sessionId: state.routeId }, 'Failed to update Copilot session effort');
    });
  }

  async send(sessionId: string, payloadOrMessage: string | ProviderContextPayload, attachments?: TransportAttachment[], extraSystemPrompt?: string): Promise<void> {
    const state = this.getSessionState(sessionId);
    if (!state) {
      throw this.makeError(PROVIDER_ERROR_CODES.SESSION_NOT_FOUND, `Unknown Copilot session: ${sessionId}`, false);
    }
    if (state.busy) {
      throw this.makeError(PROVIDER_ERROR_CODES.PROVIDER_ERROR, 'Copilot session is already busy', true);
    }
    const payload = normalizeProviderPayload(payloadOrMessage, attachments, extraSystemPrompt);
    const prompt = [payload.systemText?.trim(), payload.assembledMessage?.trim()].filter(Boolean).join('\n\n');
    const sdkAttachments = toAttachmentPayload(payload.attachments);
    state.currentMessageId = null;
    state.currentText = '';
    state.completionEmittedForCurrentTurn = false;
    state.currentOutputTokens = undefined;
    state.currentInteractionId = undefined;
    state.backgroundTainted = false;
    state.cancelRequested = false;
    state.cancelErrorEmitted = false;
    state.rotationInProgress = false;
    state.busy = true;
    try {
      if (state.model) {
        await state.session.setModel(state.model, {
          ...(mapEffortToCopilot(state.effort) ? { reasoningEffort: mapEffortToCopilot(state.effort) } : {}),
        });
      }
      await state.session.send({
        prompt,
        ...(sdkAttachments ? { attachments: sdkAttachments } : {}),
        mode: 'immediate',
      });
    } catch (error) {
      state.busy = false;
      throw error;
    }
  }

  async cancel(sessionId: string): Promise<void> {
    const state = this.getSessionState(sessionId);
    if (!state) return;
    state.cancelRequested = true;
    try {
      await state.session.abort();
    } finally {
      state.busy = false;
      if (!state.cancelErrorEmitted) {
        state.cancelErrorEmitted = true;
        this.emitError(state.routeId, this.makeError(PROVIDER_ERROR_CODES.CANCELLED, 'Copilot turn cancelled', true));
      }
    }
    if (!state.backgroundTainted) return;
    await this.rotatePoisonedSession(state);
  }

  async restoreSession(sessionId: string): Promise<boolean> {
    if (this.poisonedSessionIds.has(sessionId)) return false;
    if (this.getSessionState(sessionId)) return true;
    const sessions = await this.listSessions();
    return sessions.some((session) => session.key === sessionId);
  }

  async listSessions(): Promise<RemoteSessionInfo[]> {
    const client = this.assertConnected();
    const sessions = await client.listSessions();
    return sessions
      .filter((session) => !this.poisonedSessionIds.has(session.sessionId))
      .map((session) => ({
        key: session.sessionId,
        ...(session.summary ? { displayName: session.summary } : {}),
        ...(session.modifiedTime ? { updatedAt: new Date(session.modifiedTime).getTime() } : {}),
      }));
  }

  private async createSdkSession(config: SessionConfig, model?: string, effort?: TransportEffortLevel): Promise<CopilotSessionLike> {
    const client = this.assertConnected();
    return client.createSession(this.buildSessionConfig(config, model, effort));
  }

  private async resumeSdkSession(sessionId: string, config: SessionConfig, model?: string, effort?: TransportEffortLevel): Promise<CopilotSessionLike> {
    const client = this.assertConnected();
    return client.resumeSession(sessionId, this.buildSessionConfig(config, model, effort));
  }

  private buildSessionConfig(config: SessionConfig, model?: string, effort?: TransportEffortLevel): Record<string, unknown> {
    return {
      workingDirectory: config.cwd,
      ...(model ? { model } : {}),
      ...(mapEffortToCopilot(effort) ? { reasoningEffort: mapEffortToCopilot(effort) } : {}),
      onPermissionRequest: (request: Record<string, unknown>) => this.handlePermissionRequest(config.bindExistingKey ?? config.sessionKey, request),
    };
  }

  private attachSession(state: CopilotSessionState): void {
    state.unsubscribes.forEach((fn) => fn());
    state.unsubscribes = [];
    const generation = ++state.generation;
    const unsubscribe = state.session.on((event: Record<string, any>) => {
      if (!this.isCurrentGeneration(state, generation)) return;
      this.handleSessionEvent(state, generation, event);
    });
    state.unsubscribes.push(unsubscribe);
  }

  private handleSessionEvent(state: CopilotSessionState, generation: number, event: Record<string, any>): void {
    if (!this.isCurrentGeneration(state, generation)) return;
    const routeId = state.routeId;
    if (state.cancelRequested && this.shouldIgnoreCancelledEvent(event.type)) {
      return;
    }
    switch (event.type) {
      case 'assistant.message_delta': {
        const chunk = String(event.data?.deltaContent ?? '');
        if (!chunk) return;
        state.currentMessageId = String(event.data?.messageId ?? state.currentMessageId ?? randomUUID());
        state.currentText += chunk;
        const delta: MessageDelta = {
          messageId: state.currentMessageId,
          type: 'text',
          delta: state.currentText,
          role: 'assistant',
        };
        for (const cb of this.deltaCallbacks) cb(routeId, delta);
        return;
      }
      case 'assistant.message': {
        state.currentMessageId = String(event.data?.messageId ?? state.currentMessageId ?? randomUUID());
        const toolRequests = Array.isArray(event.data?.toolRequests) ? event.data.toolRequests : [];
        const content = String(event.data?.content ?? state.currentText ?? '');
        if (content && (!state.currentText || content.length >= state.currentText.length || content.startsWith(state.currentText))) {
          state.currentText = content;
        }
        if (!state.currentText && toolRequests.length === 0) {
          state.currentText = content;
        }
        if (typeof event.data?.outputTokens === 'number') {
          state.currentOutputTokens = event.data.outputTokens;
        }
        if (isNonEmptyString(event.data?.interactionId)) {
          state.currentInteractionId = event.data.interactionId;
        }
        return;
      }
      case 'assistant.usage': {
        if (typeof event.data?.outputTokens === 'number') {
          state.currentOutputTokens = event.data.outputTokens;
        }
        if (isNonEmptyString(event.data?.interactionId)) {
          state.currentInteractionId = event.data.interactionId;
        }
        return;
      }
      case 'tool.execution_start': {
        const tool = toolFromEvent(event);
        if (tool) {
          const args = event.data?.arguments;
          const toolName = String(event.data?.toolName ?? '').toLowerCase();
          if ((toolName === 'bash' || toolName === 'shell' || toolName === 'terminal') && this.looksBackgroundTainted(args)) {
            this.markBackgroundTainted(state);
          }
          for (const cb of this.toolCallCallbacks) cb(routeId, tool);
        }
        return;
      }
      case 'tool.execution_complete': {
        const tool = toolFromEvent(event);
        if (tool) {
          for (const cb of this.toolCallCallbacks) cb(routeId, tool);
        }
        return;
      }
      case 'session.background_tasks_changed': {
        this.markBackgroundTainted(state);
        return;
      }
      case 'system.notification': {
        const kindType = String(event.data?.kind?.type ?? '');
        if (kindType === 'shell_detached_completed') {
          this.markBackgroundTainted(state);
        }
        return;
      }
      case 'session.idle': {
        state.busy = false;
        if (state.cancelRequested && !state.cancelErrorEmitted) {
          state.cancelErrorEmitted = true;
          this.emitError(routeId, this.makeError(PROVIDER_ERROR_CODES.CANCELLED, 'Copilot turn cancelled', true));
          return;
        }
        if (!state.completionEmittedForCurrentTurn && state.currentMessageId && state.currentText) {
          state.completionEmittedForCurrentTurn = true;
          const message: AgentMessage = {
            id: state.currentMessageId,
            sessionId: routeId,
            kind: 'text',
            role: 'assistant',
            content: state.currentText,
            timestamp: Date.now(),
            status: 'complete',
            metadata: {
              ...(state.model ? { model: state.model } : {}),
              ...(typeof state.currentOutputTokens === 'number'
                ? { usage: { output_tokens: state.currentOutputTokens } }
                : {}),
              ...(state.currentInteractionId ? { interactionId: state.currentInteractionId } : {}),
              resumeId: state.sessionId,
            },
          };
          for (const cb of this.completeCallbacks) cb(routeId, message);
        }
        return;
      }
      case 'session.error': {
        state.busy = false;
        const error = this.makeError(
          PROVIDER_ERROR_CODES.PROVIDER_ERROR,
          String(event.data?.message ?? 'Copilot session error'),
          false,
          event,
        );
        for (const cb of this.errorCallbacks) cb(routeId, error);
        return;
      }
      default:
        return;
    }
  }

  private async handlePermissionRequest(
    routeId: string,
    request: Record<string, unknown>,
    generationOverride?: number,
  ): Promise<Record<string, unknown>> {
    const state = this.getSessionState(routeId);
    if (!state) {
      return { kind: 'denied-no-approval-rule-and-could-not-request-from-user' };
    }
    if (state.cancelRequested) {
      return { kind: 'denied-interactively-by-user', feedback: 'Session is cancelling' };
    }
    const requestId = randomUUID();
    const generation = generationOverride ?? state.generation;
    if (!this.approvalCallbacks.length) {
      return { kind: 'denied-no-approval-rule-and-could-not-request-from-user' };
    }
    this.emitStatus(routeId, { status: 'permission', label: 'Waiting for approval' });
    return await new Promise<Record<string, unknown>>((resolve) => {
      const timer = setTimeout(() => {
        const pending = state.pendingApprovals.get(requestId);
        if (!pending || pending.generation !== generation) return;
        state.pendingApprovals.delete(requestId);
        pending.resolve({ kind: 'denied-no-approval-rule-and-could-not-request-from-user' });
        this.emitStatus(routeId, { status: null, label: null });
      }, this.approvalTimeoutMs);
      state.pendingApprovals.set(requestId, { routeId, requestId, generation, timer, resolve });
      const approvalRequest: ApprovalRequest = {
        id: requestId,
        description: buildApprovalDescription(request),
        ...(isNonEmptyString(request.kind) ? { tool: request.kind } : {}),
      };
      for (const cb of this.approvalCallbacks) cb(routeId, approvalRequest);
    });
  }

  private async rotatePoisonedSession(state: CopilotSessionState): Promise<void> {
    if (state.rotationInProgress || this.poisonedSessionIds.has(state.sessionId)) return;
    state.rotationInProgress = true;
    const oldSessionId = state.sessionId;
    const oldSession = state.session;
    this.poisonedSessionIds.add(oldSessionId);
    state.unsubscribes.forEach((fn) => fn());
    state.unsubscribes = [];
    for (const pending of state.pendingApprovals.values()) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.resolve({ kind: 'denied-no-approval-rule-and-could-not-request-from-user' });
    }
    state.pendingApprovals.clear();
    try {
      const freshSession = await this.createSdkSession({
        sessionKey: state.routeId,
        cwd: state.cwd,
        agentId: state.model,
        effort: state.effort,
      }, state.model, state.effort);
      state.session = freshSession;
      state.sessionId = freshSession.sessionId;
      state.currentMessageId = null;
      state.currentText = '';
      state.completionEmittedForCurrentTurn = false;
      state.currentOutputTokens = undefined;
      state.currentInteractionId = undefined;
      state.busy = false;
      state.backgroundTainted = false;
      state.cancelRequested = false;
      state.cancelErrorEmitted = false;
      this.attachSession(state);
      this.emitSessionInfo(state.routeId, {
        resumeId: state.sessionId,
        ...(state.model ? { model: state.model } : {}),
        ...(state.effort ? { effort: state.effort } : {}),
      });
    } finally {
      state.rotationInProgress = false;
    }
    try {
      await oldSession.disconnect?.();
    } catch {}
    try {
      await this.assertConnected().deleteSession(oldSessionId);
    } catch (error) {
      this.emitStatus(state.routeId, {
        status: 'warning',
        label: 'Previous Copilot session could not be deleted',
      });
      logger.warn({ err: error, provider: this.id, sessionId: oldSessionId }, 'Failed to delete poisoned Copilot session');
    }
  }

  private async replaceSession(state: CopilotSessionState, resumeId: string): Promise<void> {
    const oldSessionId = state.sessionId;
    const oldSession = state.session;
    const resumed = await this.resumeSdkSession(resumeId, {
      sessionKey: state.routeId,
      cwd: state.cwd,
      agentId: state.model,
      effort: state.effort,
      resumeId,
      skipCreate: true,
    }, state.model, state.effort);
    for (const pending of state.pendingApprovals.values()) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.resolve({ kind: 'denied-no-approval-rule-and-could-not-request-from-user' });
    }
    state.pendingApprovals.clear();
    state.unsubscribes.forEach((fn) => fn());
    state.unsubscribes = [];
    state.session = resumed;
    state.sessionId = resumed.sessionId;
    state.currentMessageId = null;
    state.currentText = '';
    state.completionEmittedForCurrentTurn = false;
    state.currentOutputTokens = undefined;
    state.currentInteractionId = undefined;
    state.busy = false;
    state.backgroundTainted = false;
    state.cancelRequested = false;
    state.cancelErrorEmitted = false;
    state.rotationInProgress = false;
    this.attachSession(state);
    try {
      await oldSession.disconnect?.();
    } catch {}
    if (oldSessionId !== state.sessionId) {
      this.poisonedSessionIds.add(oldSessionId);
      try {
        await this.assertConnected().deleteSession(oldSessionId);
      } catch (error) {
        this.emitStatus(state.routeId, {
          status: 'warning',
          label: 'Previous Copilot session could not be deleted',
        });
        logger.warn({ err: error, provider: this.id, sessionId: oldSessionId }, 'Failed to delete replaced Copilot session');
      }
    }
  }

  private getSessionState(sessionId: string): CopilotSessionState | undefined {
    const direct = this.sessions.get(sessionId);
    if (direct) return direct;
    for (const state of this.sessions.values()) {
      if (state.sessionId === sessionId) return state;
    }
    return undefined;
  }

  private isCurrentGeneration(state: CopilotSessionState, generation: number): boolean {
    return state.generation === generation && !this.poisonedSessionIds.has(state.sessionId);
  }

  private emitSessionInfo(sessionId: string, info: SessionInfoUpdate): void {
    for (const cb of this.sessionInfoCallbacks) cb(sessionId, info);
  }

  private emitStatus(sessionId: string, status: ProviderStatusUpdate): void {
    const signature = JSON.stringify(status);
    const state = this.sessions.get(sessionId);
    if (state && state.lastStatusSignature === signature) return;
    if (state) state.lastStatusSignature = signature;
    for (const cb of this.statusCallbacks) cb(sessionId, status);
  }

  private emitError(sessionId: string, error: ProviderError): void {
    for (const cb of this.errorCallbacks) cb(sessionId, error);
  }

  private resolveBinaryPath(config: ProviderConfig): string | undefined {
    // The Copilot SDK requires `cliPath` to be an absolute path to an existing
    // file (it runs `existsSync` before spawning). Passing just the name
    // `"copilot"` makes the SDK fail with "Copilot CLI not found at copilot."
    //
    // We only override the SDK's bundled CLI when:
    //   1. The caller explicitly passed an absolute binaryPath that exists, OR
    //   2. On Windows, the PATH-resolved binary is an absolute existing file.
    // Otherwise we return `undefined` so the SDK falls back to its bundled
    // `@github/copilot/index.js` (installed as a dependency of the SDK).
    if (isNonEmptyString(config.binaryPath)) {
      const candidate = config.binaryPath.trim();
      if (path.isAbsolute(candidate) && existsSync(candidate)) return candidate;
      logger.warn(
        { provider: this.id, candidate },
        'Ignoring Copilot binaryPath override (not an absolute file path) — falling back to bundled CLI',
      );
      return undefined;
    }
    if (process.platform === 'win32') {
      const resolved = resolveBinaryWithWindowsFallbacks(COPILOT_BIN, []);
      if (resolved && path.isAbsolute(resolved) && existsSync(resolved)) return resolved;
    }
    return undefined;
  }

  private resolveDefaultModel(): string | undefined {
    return this.config && isNonEmptyString(this.config.agentId) ? this.config.agentId : undefined;
  }

  private resolveApprovalTimeoutMs(config: ProviderConfig): number {
    const candidate = config.approvalTimeoutMs;
    if (typeof candidate === 'number' && Number.isFinite(candidate) && candidate > 0) {
      return Math.floor(candidate);
    }
    return DEFAULT_APPROVAL_TIMEOUT_MS;
  }

  private looksBackgroundTainted(args: unknown): boolean {
    if (!args || typeof args !== 'object') return false;
    const record = args as Record<string, unknown>;
    const command = isNonEmptyString(record.command) ? record.command.toLowerCase() : '';
    return record.mode === 'async'
      || record.background === true
      || record.detached === true
      || record.runInBackground === true
      || record.isBackground === true
      || /(^|\s)nohup(\s|$)/.test(command)
      || /(^|\s)disown(\s|$)/.test(command)
      || /(^|\s)start\s+\/b(\s|$)/.test(command)
      || /(^|\s)start-process(\s|$)/.test(command)
      || /(^|[^&])&(\s|$)/.test(command);
  }

  private shouldIgnoreCancelledEvent(type: string): boolean {
    return type !== 'session.idle'
      && type !== 'session.background_tasks_changed'
      && type !== 'system.notification'
      && type !== 'tool.execution_start';
  }

  private markBackgroundTainted(state: CopilotSessionState): void {
    state.backgroundTainted = true;
    if (state.cancelRequested && !state.rotationInProgress && !this.poisonedSessionIds.has(state.sessionId)) {
      void this.rotatePoisonedSession(state).catch((error) => {
        logger.error({ err: error, provider: this.id, sessionId: state.routeId }, 'Failed to rotate poisoned Copilot session');
        this.emitError(state.routeId, this.makeError(
          PROVIDER_ERROR_CODES.PROVIDER_ERROR,
          'Failed to rotate poisoned Copilot session after cancel',
          false,
          error,
        ));
      });
    }
  }

  private assertConnected(): CopilotClientLike {
    if (!this.client) {
      throw this.makeError(PROVIDER_ERROR_CODES.CONNECTION_LOST, 'Copilot SDK provider not connected', false);
    }
    return this.client;
  }

  private normalizeConnectError(error: unknown): ProviderError {
    const message = error instanceof Error ? error.message : String(error);
    if (/not authenticated|login|log in|sign in/i.test(message)) {
      return this.makeError(PROVIDER_ERROR_CODES.AUTH_FAILED, message, false, error);
    }
    return this.makeError(PROVIDER_ERROR_CODES.CONFIG_ERROR, message, false, error);
  }

  private isProviderError(error: unknown): error is ProviderError {
    return !!error && typeof error === 'object' && 'code' in error && 'message' in error && 'recoverable' in error;
  }

  private makeError(code: string, message: string, recoverable: boolean, details?: unknown): ProviderError {
    return { code, message, recoverable, ...(details !== undefined ? { details } : {}) };
  }
}
