import { randomUUID } from 'node:crypto';
import { access } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { spawn, type ChildProcess } from 'node:child_process';
import { query, type PermissionMode, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { killProcessTree } from '../../util/kill-process-tree.js';
import type {
  TransportProvider,
  ProviderCapabilities,
  ProviderConfig,
  ProviderError,
  ProviderModelList,
  SessionConfig,
  SessionInfoUpdate,
  ProviderStatusUpdate,
  ToolCallEvent,
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
import type { ActivityGeneration, ProviderActiveWorkSnapshot, SessionActivityBusyReason } from '../../../shared/session-activity-types.js';
import { ASK_QUESTION_WAIT_MS } from '../../../shared/ask-question-timing.js';
import { PendingQuestionRegistry, type InteractiveQuestionAnswerer } from '../pending-question-registry.js';
import { MEMORY_MCP_STATUS, type MemoryMcpProviderStatusView } from '../../../shared/memory-ws.js';
import logger from '../../util/logger.js';
import { CLAUDE_SDK_EFFORT_LEVELS, type TransportEffortLevel } from '../../../shared/effort-levels.js';
import { normalizeTransportCwd, resolveClaudeCodePathForSdk, resolveExecutableForSpawn } from '../transport-paths.js';
import { composeMessageSideProviderPrompt, getProviderSystemTextParts } from '../provider-context-routing.js';
import { getDefaultMcpServers } from './getDefaultMcpServers.js';
import { claudeRateLimitsToQuotaMeta, type ClaudeRateLimitInfo } from '../claude-rate-limit.js';
import { formatProviderQuotaLabel } from '../../../shared/provider-quota.js';
import { IMCODES_MEMORY_MCP_SERVER_NAME } from '../../../shared/memory-mcp-server-name.js';
import {
  SDK_SUBAGENT_DETAIL_KIND,
  SDK_SUBAGENT_DIAGNOSTIC,
  SDK_SUBAGENT_PROVIDERS,
  SDK_SUBAGENT_PROVIDER_KINDS,
  SDK_SUBAGENT_SCHEMA_VERSION,
  SDK_SUBAGENT_STATUS,
  buildSdkSubagentSafeDetail,
  makeClaudeSubagentCanonicalKey,
  sanitizeSdkSubagentText,
  sdkSubagentDedupSignature,
  type SdkSubagentDetail,
  type SdkSubagentDiagnosticCode,
  type SdkSubagentNormalizedStatus,
} from '../../../shared/sdk-subagent-status.js';

const CLAUDE_BIN = 'claude';
const DEFAULT_PERMISSION_MODE: PermissionMode = 'bypassPermissions';
const CANCEL_INTERRUPT_TIMEOUT_MS = 1_500;
const FORCE_KILL_TIMEOUT_MS = 500;
const RESULT_COMPLETION_FALLBACK_MS = 5_000;
const DEFAULT_SUBAGENT_STALE_WITHOUT_TERMINAL_MS = 15 * 60 * 1000;

// Claude Code ships native scheduling tools (RemoteTrigger creates a claude.ai
// routine; the Cron* tools manage them) that bypass IM.codes entirely. We
// provide our own scheduling via the imcodes-memory MCP cron_* tools, so disable
// the native ones to force the agent through our cron (one source of truth,
// pod-routed, visible in our cron UI).
const DISALLOWED_NATIVE_TOOLS = ['RemoteTrigger', 'CronCreate', 'CronList', 'CronUpdate', 'CronDelete'];
const CLAUDE_TASK_SYSTEM_SUBTYPES = new Set([
  'task_started',
  'task_progress',
  'task_updated',
  'task_notification',
]);

function getClaudeMcpServers(config: SessionConfig): Record<string, unknown> {
  const servers = getDefaultMcpServers(config);
  const memoryServer = servers[IMCODES_MEMORY_MCP_SERVER_NAME];
  if (!memoryServer) return servers;
  return {
    ...servers,
    [IMCODES_MEMORY_MCP_SERVER_NAME]: {
      ...memoryServer,
      // Claude Agent SDK >=0.3 starts MCP servers in the background by default.
      // IM.codes' managed memory/send/cron MCP is part of the turn-1 contract,
      // so require it to be connected and included in the initial tool set.
      alwaysLoad: true,
    },
  };
}
const CLAUDE_RUNTIME_SUBAGENT_SYSTEM_SUBTYPES = new Set([
  'subagent_notification',
  'subagent_status',
  'subagent/status',
  'agent_subagent_notification',
  'agent_subagent_status',
  'runtime_subagent_notification',
  'runtime_subagent_status',
]);
const CLAUDE_CHECKLIST_TOOL_NAMES = new Set([
  'todowrite',
  'todo_write',
  'write_todos',
  'writetodos',
  'update_plan',
  'updateplan',
  'update_todo_list',
  'updatetodolist',
  'set_plan',
  'setplan',
]);
const CLAUDE_CHECKLIST_LIST_KEYS = ['todos', 'plan', 'tasks', 'steps'] as const;
const CLAUDE_CHECKLIST_TEXT_KEYS = ['content', 'step', 'text', 'title', 'task', 'description', 'name'] as const;

type ClaudeChecklistInput = {
  plan: Array<{ content: string; status: 'pending' | 'in_progress' | 'completed' }>;
};

interface ClaudeSdkSessionState {
  routeId: string;
  sessionName?: string;
  projectName?: string;
  serverId?: string;
  cwd: string;
  env?: Record<string, string>;
  contextNamespace?: SessionConfig['contextNamespace'];
  model?: string;
  settings?: string | Record<string, unknown>;
  description?: string;
  systemPrompt?: string;
  permissionMode: PermissionMode;
  effort?: TransportEffortLevel;
  started: boolean;
  resumeId: string;
  currentMessageId: string | null;
  currentText: string;
  currentQuery: ReturnType<typeof query> | null;
  currentChild: ChildProcess | null;
  completed: boolean;
  cancelled: boolean;
  finalMetadata?: Record<string, unknown>;
  lastAssistantUsage?: ClaudeUsageSnapshot;
  /** Cached per-type Claude rate-limit snapshots (five_hour / seven_day*). Each
   *  `rate_limit_event` carries ONE window; accumulate across the session so the
   *  weekly window — which only surfaces near a limit — is retained once seen. */
  rateLimits?: Record<string, ClaudeRateLimitInfo>;
  pendingComplete?: AgentMessage;
  pendingError?: ProviderError;
  turnGeneration: number;
  runtimeActivityGeneration?: ActivityGeneration;
  resultCompletionTimer: ReturnType<typeof setTimeout> | null;
  resultCompletionGeneration?: number;
  toolCalls: Map<number, ToolCallEvent & { partialInputJson?: string }>;
  runtimeAgentToolCalls: Map<string, { canonicalKey: string; agentPath: string; agentName?: string; model?: string; prompt?: string }>;
  emittedToolStates: Map<string, string>;
  subagentTasks: Map<string, ClaudeTaskState>;
  emittedSubagentStates: Map<string, string>;
  lastStatusSignature: string | null;
}

interface ClaudeUsageSnapshot {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

interface ClaudeTaskUsageSnapshot {
  total_tokens?: number;
  tool_uses?: number;
  duration_ms?: number;
}

interface ClaudeTaskState {
  taskId: string;
  canonicalKey: string;
  toolUseId?: string;
  description?: string;
  model?: string;
  taskType?: string;
  workflowName?: string;
  rawStatus?: string;
  normalizedStatus: SdkSubagentNormalizedStatus;
  summary?: string;
  usage?: ClaudeTaskUsageSnapshot;
  lastToolName?: string;
  outputFile?: string;
  error?: string;
  backgrounded?: boolean;
  diagnosticCode?: SdkSubagentDiagnosticCode;
  terminal: boolean;
  active: boolean;
  lastUpdatedAt: number;
}

type ClaudeToolBlock = {
  type: 'tool_use' | 'server_tool_use' | 'mcp_tool_use';
  id?: string;
  name?: string;
  input?: unknown;
};

type ClaudeTaskLifecycleMessage = SDKMessage & {
  type: 'system';
  subtype: string;
  [key: string]: unknown;
};

type ClaudeThinkingTokensMessage = {
  type: 'system';
  subtype: 'thinking_tokens';
  estimated_tokens?: number;
};

function collectAssistantText(message: SDKMessage): string {
  if (message.type !== 'assistant' || !Array.isArray(message.message.content)) return '';
  return message.message.content
    .map((block) => {
      if (!block || typeof block !== 'object' || block.type !== 'text' || typeof block.text !== 'string') return '';
      return block.text;
    })
    .filter(Boolean)
    .join('');
}

function makeMessageId(state: ClaudeSdkSessionState): string {
  return state.currentMessageId ?? `${state.resumeId}:${randomUUID()}`;
}

function normalizeStatusName(status: string | undefined): string {
  return (status ?? '').replace(/[_\s-]+/g, '').toLowerCase();
}

function getSubagentStaleWithoutTerminalMs(): number {
  const raw = process.env.IMCODES_CLAUDE_SUBAGENT_STALE_MS;
  if (!raw) return DEFAULT_SUBAGENT_STALE_WITHOUT_TERMINAL_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 1_000 ? parsed : DEFAULT_SUBAGENT_STALE_WITHOUT_TERMINAL_MS;
}

function parseRuntimeSubagentTag(line: string): Record<string, unknown> | null {
  const match = /^<subagent_notification>([\s\S]+)<\/subagent_notification>$/.exec(line.trim());
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[1]!);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return { type: 'subagent_notification', ...(parsed as Record<string, unknown>) };
  } catch {
    return null;
  }
}

type SdkPermissionResult =
  | { behavior: 'allow'; updatedInput?: Record<string, unknown> }
  | { behavior: 'deny'; message: string; interrupt?: boolean };

export class ClaudeCodeSdkProvider implements TransportProvider, InteractiveQuestionAnswerer {
  readonly id = 'claude-code-sdk';
  readonly connectionMode = CONNECTION_MODES.LOCAL_SDK;
  readonly sessionOwnership = SESSION_OWNERSHIP.SHARED;
  readonly capabilities: ProviderCapabilities = {
    streaming: true,
    toolCalling: true,
    approval: false,
    sessionRestore: true,
    multiTurn: true,
    attachments: false,
    reasoningEffort: true,
    supportedEffortLevels: CLAUDE_SDK_EFFORT_LEVELS,
    contextSupport: 'full-normalized-context-injection',
    compact: {
      execution: 'slash-command',
      providerCommand: '/compact',
      verified: true,
      completion: 'status-only',
      cancellation: 'provider-cancel',
      reason: 'Verified with Claude Agent SDK 0.2.119 supportedCommands(): compact is a provider slash command, not an active RPC.',
    },
  };

  private config: ProviderConfig | null = null;
  private sessions = new Map<string, ClaudeSdkSessionState>();
  private deltaCallbacks: Array<(sessionId: string, delta: MessageDelta) => void> = [];
  private completeCallbacks: Array<(sessionId: string, message: AgentMessage) => void> = [];
  private errorCallbacks: Array<(sessionId: string, error: ProviderError) => void> = [];
  private toolCallCallbacks: Array<(sessionId: string, tool: ToolCallEvent) => void> = [];
  private sessionInfoCallbacks: Array<(sessionId: string, info: SessionInfoUpdate) => void> = [];
  private statusCallbacks: Array<(sessionId: string, status: ProviderStatusUpdate) => void> = [];
  // AskUserQuestion pause/answer lifecycle — generic, provider-agnostic.
  private readonly questions = new PendingQuestionRegistry<SdkPermissionResult>();

  /**
   * {@link InteractiveQuestionAnswerer}. The user's choice is conveyed to the
   * model as a `deny` message it reads as the answer, so it continues in the
   * SAME turn. Returns false when nothing was pending (timed out / self-
   * continued) — the daemon then delivers the answer as a normal message.
   */
  answerPendingQuestion(sessionName: string, answer: string): boolean {
    return this.questions.resolve(sessionName, { behavior: 'deny', message: answer, interrupt: false });
  }

  async connect(config: ProviderConfig): Promise<void> {
    const binaryPath = this.getConfiguredBinaryPath(config);
    const resolved = resolveExecutableForSpawn(binaryPath);
    await access(resolved.executable, fsConstants.X_OK).catch(async () => {
      const { execFile } = await import('node:child_process');
      await new Promise<void>((resolve, reject) => {
        execFile(resolved.executable, [...resolved.prependArgs, '--version'], { windowsHide: true }, (err) => (err ? reject(err) : resolve()));
      });
    });
    this.config = config;
    logger.info({ provider: this.id, resolved: resolved.executable }, 'Claude Code SDK provider connected');
  }

  getMemoryMcpStatus(): MemoryMcpProviderStatusView {
    return {
      providerId: this.id,
      status: this.config ? MEMORY_MCP_STATUS.READY : MEMORY_MCP_STATUS.UNKNOWN,
      connected: Boolean(this.config),
      degradedReasons: [],
    };
  }

  async listModels(_force?: boolean): Promise<ProviderModelList> {
    const { getClaudeSdkAvailableModels } = await import('../sdk-runtime-config.js');
    const { getClaudeSdkRuntimeConfig } = await import('../sdk-runtime-config.js');
    const [models, cfg] = await Promise.all([
      Promise.resolve(getClaudeSdkAvailableModels()),
      getClaudeSdkRuntimeConfig(false),
    ]);
    return {
      models: models.map((id) => ({ id })),
      defaultModel: models[0],
      isAuthenticated: true,
      ...(cfg.planLabel ? {} : {}), // planLabel lives in session-info, not model list
    };
  }

  async disconnect(): Promise<void> {
    this.questions.releaseAll();
    for (const state of this.sessions.values()) {
      this.clearResultCompletionFallback(state);
      try { state.currentQuery?.close(); } catch {}
      this.terminateChild(state);
    }
    this.sessions.clear();
    this.config = null;
  }

  async createSession(config: SessionConfig): Promise<string> {
    const routeId = config.bindExistingKey ?? config.sessionKey;
    const existing = config.fresh ? undefined : this.sessions.get(routeId);
    const resumeId = config.resumeId ?? existing?.resumeId ?? routeId;
    this.sessions.set(routeId, {
      routeId,
      sessionName: config.sessionName ?? existing?.sessionName,
      projectName: config.projectName ?? existing?.projectName,
      serverId: config.serverId ?? existing?.serverId,
      cwd: normalizeTransportCwd(config.cwd) ?? existing?.cwd ?? normalizeTransportCwd(process.cwd())!,
      env: config.env ?? existing?.env,
      contextNamespace: config.contextNamespace ?? existing?.contextNamespace,
      model: typeof config.agentId === 'string' ? config.agentId : existing?.model,
      settings: config.settings ?? existing?.settings,
      description: config.description ?? existing?.description,
      systemPrompt: config.systemPrompt ?? existing?.systemPrompt,
      permissionMode: this.resolvePermissionMode(),
      effort: config.effort ?? existing?.effort,
      started: !!(config.resumeId && config.skipCreate),
      resumeId,
      currentMessageId: existing?.currentMessageId ?? null,
      currentText: existing?.currentText ?? '',
      currentQuery: null,
      currentChild: null,
      completed: false,
      cancelled: false,
      finalMetadata: existing?.finalMetadata,
      lastAssistantUsage: existing?.lastAssistantUsage,
      rateLimits: existing?.rateLimits,
      pendingComplete: undefined,
      turnGeneration: existing?.turnGeneration ?? 0,
      resultCompletionTimer: null,
      resultCompletionGeneration: undefined,
      toolCalls: new Map(),
      runtimeAgentToolCalls: new Map(),
      emittedToolStates: new Map(),
      subagentTasks: existing?.subagentTasks ?? new Map(),
      emittedSubagentStates: new Map(),
      lastStatusSignature: null,
    });
    this.emitSessionInfo(routeId, { resumeId, ...(config.effort ? { effort: config.effort } : {}) });
    return routeId;
  }

  getSessionDiagnostics(sessionId: string): Record<string, unknown> | null {
    const state = this.sessions.get(sessionId);
    if (!state) return null;
    const activeReason = state.currentQuery
      ? 'query'
      : state.currentChild
        ? 'child'
        : state.pendingComplete
          ? 'pending-complete'
          : state.resultCompletionTimer
            ? 'completion-fallback'
            : null;
    return {
      provider: this.id,
      routeId: state.routeId,
      active: activeReason !== null,
      activeReason,
      started: state.started,
      resumeId: state.resumeId,
      currentMessageId: state.currentMessageId,
      currentTextLength: state.currentText.length,
      currentQueryActive: Boolean(state.currentQuery),
      currentChildActive: Boolean(state.currentChild && !state.currentChild.killed),
      completed: state.completed,
      cancelled: state.cancelled,
      pendingComplete: Boolean(state.pendingComplete),
      pendingError: Boolean(state.pendingError),
      resultCompletionFallbackArmed: Boolean(state.resultCompletionTimer),
      resultCompletionGeneration: state.resultCompletionGeneration ?? null,
      turnGeneration: state.turnGeneration,
      toolCallCount: state.toolCalls.size,
      runtimeAgentToolCallCount: state.runtimeAgentToolCalls.size,
      subagentTaskCount: state.subagentTasks.size,
    };
  }

  getActiveWorkSnapshot(sessionId: string): ProviderActiveWorkSnapshot | null {
    const state = this.sessions.get(sessionId);
    if (!state) return null;
    this.expireStaleClaudeSubagentTasks(sessionId, state);
    const activeToolCount = state.toolCalls.size + Array.from(state.runtimeAgentToolCalls.values()).length;
    const activeSubagentCount = this.activeClaudeSubagentTasks(state).length;
    const waitingForTaskNotification = state.completed && !state.pendingComplete && activeSubagentCount > 0;
    const backgroundActive = Boolean(
      state.resultCompletionTimer
      || (state.currentQuery && !waitingForTaskNotification)
      || (state.currentChild && !state.currentChild.killed && !waitingForTaskNotification),
    );
    const busyReasons: SessionActivityBusyReason[] = [];
    if (activeToolCount > 0) busyReasons.push('provider_tool_item');
    if (activeSubagentCount > 0 || backgroundActive) busyReasons.push('background_monitor');
    return {
      status: 'current',
      activeWorkCount: activeToolCount + activeSubagentCount + (backgroundActive ? 1 : 0),
      activeToolCount,
      busyReasons,
      activityGeneration: state.runtimeActivityGeneration,
      providerDiagnosticGeneration: state.turnGeneration,
      updatedAt: Date.now(),
    };
  }

  async endSession(sessionId: string): Promise<void> {
    // Release any paused AskUserQuestion so a torn-down session never leaks a
    // pending timer / unresolved canUseTool promise. Keyed by sessionName.
    const state = this.sessions.get(sessionId);
    this.questions.release(state?.sessionName ?? sessionId);
    if (state) {
      this.clearResultCompletionFallback(state);
      try { state.currentQuery?.close(); } catch {}
      this.terminateChild(state);
      this.sessions.delete(sessionId);
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

  setSessionAgentId(sessionId: string, agentId: string): void {
    const state = this.sessions.get(sessionId);
    if (!state) return;
    state.model = agentId;
  }

  setSessionEffort(sessionId: string, effort: TransportEffortLevel): void {
    const state = this.sessions.get(sessionId);
    if (!state) return;
    state.effort = effort;
    this.emitSessionInfo(sessionId, { effort });
  }

  async send(sessionId: string, payloadOrMessage: string | ProviderContextPayload, _attachments?: TransportAttachment[], extraSystemPrompt?: string): Promise<void> {
    if (!this.config) {
      throw this.makeError(PROVIDER_ERROR_CODES.CONNECTION_LOST, 'Claude Code SDK provider not connected', false);
    }
    const state = this.sessions.get(sessionId);
    if (!state) {
      throw this.makeError(PROVIDER_ERROR_CODES.SESSION_NOT_FOUND, `Unknown Claude SDK session: ${sessionId}`, false);
    }
    if (state.currentQuery) {
      throw this.makeError(PROVIDER_ERROR_CODES.PROVIDER_ERROR, 'Claude SDK session is already busy', true);
    }
    const payload = normalizeProviderPayload(payloadOrMessage, _attachments, extraSystemPrompt);
    state.runtimeActivityGeneration = payload.activityGeneration;
    await this.startQuery(sessionId, state, payload, true);
  }

  async cancel(sessionId: string): Promise<void> {
    const state = this.sessions.get(sessionId);
    if (!state) return;
    await this.cancelActiveClaudeSubagentTasks(sessionId, state);
    if (!state.currentQuery) return;
    state.cancelled = true;
    this.clearResultCompletionFallback(state);
    try {
      await Promise.race([
        state.currentQuery.interrupt(),
        new Promise<void>((resolve) => setTimeout(resolve, CANCEL_INTERRUPT_TIMEOUT_MS)),
      ]);
    } catch {}
    try {
      state.currentQuery.close();
    } catch {}
    this.terminateChild(state);
  }

  private async startQuery(
    sessionId: string,
    state: ClaudeSdkSessionState,
    payload: ProviderContextPayload,
    allowResumeFallback: boolean,
  ): Promise<void> {
    state.currentText = '';
    state.currentMessageId = null;
    state.completed = false;
    state.cancelled = false;
    state.finalMetadata = undefined;
    state.lastAssistantUsage = undefined;
    state.pendingComplete = undefined;
    state.pendingError = undefined;
    this.clearResultCompletionFallback(state);
    state.toolCalls.clear();
    state.runtimeAgentToolCalls.clear();
    state.emittedToolStates.clear();
    state.emittedSubagentStates.clear();
    state.lastStatusSignature = null;

    const resolvedBinary = this.resolveBinaryPath(this.config);
    const systemParts = getProviderSystemTextParts(payload);
    const fallbackSystemPrompt = [state.description, state.systemPrompt].filter(Boolean).join('\n\n') || undefined;
    const baseSystemPrompt = systemParts.hasSplitSystemText
      ? systemParts.sessionSystemText
      : (systemParts.combinedSystemText ?? fallbackSystemPrompt);
    const prompt = systemParts.hasSplitSystemText
      ? composeMessageSideProviderPrompt(payload, { includeSessionSystemText: false })
      : payload.assembledMessage;
    const options: Record<string, unknown> = {
      cwd: state.cwd,
      ...(state.env ? { env: { ...process.env, ...state.env } } : {}),
      permissionMode: state.permissionMode,
      disallowedTools: DISALLOWED_NATIVE_TOOLS,
      pathToClaudeCodeExecutable: resolvedBinary,
      includePartialMessages: true,
      agentProgressSummaries: false,
      forwardSubagentText: false,
      ...(state.started ? { resume: state.resumeId } : { sessionId: state.resumeId }),
      ...(state.model ? { model: state.model } : {}),
      ...(state.settings ? { settings: state.settings } : {}),
      ...(state.effort ? { effort: state.effort } : {}),
      mcpServers: getClaudeMcpServers({
        sessionKey: state.routeId,
        sessionName: state.sessionName,
        projectName: state.projectName,
        serverId: state.serverId,
        cwd: state.cwd,
        env: state.env,
        contextNamespace: state.contextNamespace,
      }),
      ...(baseSystemPrompt ? {
        appendSystemPrompt: baseSystemPrompt,
      } : {}),
    };
    options.spawnClaudeCodeProcess = (req: { command: string; args: string[]; cwd?: string; env?: Record<string, string>; signal?: AbortSignal }) => {
      const child = spawn(req.command, req.args, {
        cwd: req.cwd,
        env: req.env,
        signal: req.signal,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
      state.currentChild = child;
      child.once('exit', () => {
        if (state.currentChild === child) state.currentChild = null;
      });
      child.on('error', (err) => {
        logger.error({ provider: this.id, err }, 'Claude SDK spawn error (suppressed)');
      });
      return child;
    };

    // ── Interactive AskUserQuestion: PAUSE the turn until answered ────────────
    // The SDK awaits canUseTool before running a tool. For AskUserQuestion we
    // return a promise that resolves only when the user answers (delivered as a
    // deny-message the model reads as their choice → same-turn continue) or the
    // wait window elapses (allow → the model self-continues / picks its own).
    // Every other tool is allowed unchanged.
    options.canUseTool = (toolName: string, input: Record<string, unknown>, opts: { signal?: AbortSignal }) => {
      if (toolName !== 'AskUserQuestion') {
        return Promise.resolve({ behavior: 'allow' as const, updatedInput: input });
      }
      // Key by the daemon-facing sessionName (NOT the internal routeId
      // `sessionId`) so handleAskAnswer — which answers by sessionName — resolves
      // the right pending question. Pause until answered (answerPendingQuestion)
      // or the wait window elapses (fallback allow → the model self-continues).
      return this.questions.wait(state.sessionName ?? sessionId, {
        timeoutMs: ASK_QUESTION_WAIT_MS,
        fallback: { behavior: 'allow', updatedInput: input },
        signal: opts.signal,
      });
    };

    const q = query({ prompt, options: options as any });
    const turnGeneration = ++state.turnGeneration;
    state.currentQuery = q;
    void this.consumeQuery(sessionId, state, q, payload, allowResumeFallback, turnGeneration);
  }

  private async consumeQuery(
    sessionId: string,
    state: ClaudeSdkSessionState,
    q: ReturnType<typeof query>,
    payload: ProviderContextPayload,
    allowResumeFallback: boolean,
    turnGeneration: number,
  ): Promise<void> {
    let pendingError: ProviderError | null = null;
    try {
      for await (const msg of q) {
        this.handleMessage(sessionId, state, msg);
      }
      if (!pendingError && state.pendingError) {
        pendingError = state.pendingError;
      }
      if (!state.completed && state.cancelled) {
        pendingError = this.makeError(PROVIDER_ERROR_CODES.CANCELLED, 'Claude turn cancelled', true);
      }
    } catch (err) {
      pendingError = state.cancelled
        ? this.makeError(PROVIDER_ERROR_CODES.CANCELLED, 'Claude turn cancelled', true, err)
        : this.normalizeError(err);
    } finally {
      if (state.turnGeneration === turnGeneration) {
        this.clearResultCompletionFallback(state);
      }
      state.currentQuery = null;
      state.currentChild = null;
      const pendingComplete = state.pendingComplete;
      state.pendingComplete = undefined;
      state.pendingError = undefined;
      state.currentMessageId = null;
      state.currentText = '';
      if (!pendingComplete && pendingError && allowResumeFallback && state.started && this.isMissingResumeError(pendingError.message)) {
        state.started = false;
        logger.info({ provider: this.id, sessionId, resumeId: state.resumeId }, 'Claude SDK resume failed; retrying with sessionId');
        await this.startQuery(sessionId, state, payload, false);
        return;
      }
      if (pendingComplete) {
        for (const cb of this.completeCallbacks) cb(sessionId, pendingComplete);
      } else if (pendingError) {
        this.emitError(sessionId, pendingError);
      }
    }
  }

  private handleMessage(sessionId: string, state: ClaudeSdkSessionState, msg: SDKMessage): void {
    if ('session_id' in msg && typeof msg.session_id === 'string' && msg.session_id) {
      state.resumeId = msg.session_id;
      this.emitSessionInfo(sessionId, {
        resumeId: msg.session_id,
        ...(state.model ? { model: state.model } : {}),
      });
    }

    if (msg.type === 'system' && msg.subtype === 'init') {
      state.model = msg.model;
      state.started = true;
      this.emitSessionInfo(sessionId, { resumeId: msg.session_id, model: msg.model });
      return;
    }

    if (this.isClaudeTaskLifecycleMessage(msg)) {
      this.handleClaudeTaskLifecycleMessage(sessionId, state, msg);
      return;
    }

    if (this.isClaudeRuntimeSubagentMessage(msg)) {
      this.emitClaudeRuntimeSubagentSnapshot(sessionId, state, msg);
      return;
    }

    if (msg.type === 'system' && msg.subtype === 'compact_boundary') {
      this.emitStatus(sessionId, state, {
        status: 'compacting',
        label: 'Compacting conversation...',
      });
      return;
    }

    if (msg.type === 'system' && msg.subtype === 'status') {
      if (msg.status === 'compacting') {
        this.emitStatus(sessionId, state, {
          status: 'compacting',
          label: 'Compacting conversation...',
        });
      } else {
        this.emitStatus(sessionId, state, {
          status: msg.status,
          label: null,
        });
      }
      return;
    }

    if (this.isClaudeThinkingTokensMessage(msg)) {
      // Live thinking-token progress (claude-agent-sdk >= 0.3.x). During the
      // redacted-thinking phase the model emits no visible output — only this
      // running estimate — so surface it as a `thinking` status to drive the
      // footer/pill spinner. Approximate (not the billed output_tokens);
      // emitStatus dedups by label so only meaningful changes propagate.
      const thinkingTokensMessage = msg as unknown as ClaudeThinkingTokensMessage;
      const estimated = typeof thinkingTokensMessage.estimated_tokens === 'number' && thinkingTokensMessage.estimated_tokens > 0
        ? thinkingTokensMessage.estimated_tokens
        : 0;
      const compact = estimated >= 1000 ? `${Math.round(estimated / 100) / 10}k` : `${estimated}`;
      this.emitStatus(sessionId, state, {
        status: 'thinking',
        label: estimated > 0 ? `Thinking (${compact} tokens)` : 'Thinking…',
      });
      return;
    }

    if (msg.type === 'rate_limit_event') {
      // claude.ai subscription rate-limit info (5h + weekly windows, with reset
      // times). Each event carries one `rateLimitType`; cache per type and push
      // a quotaMeta so the existing provider→record→session_list display
      // surfaces it (resetsAt is epoch seconds — passed through unchanged).
      const info = (msg as { rate_limit_info?: ClaudeRateLimitInfo }).rate_limit_info;
      if (info?.rateLimitType) {
        state.rateLimits = { ...(state.rateLimits ?? {}), [info.rateLimitType]: info };
        const quotaMeta = claudeRateLimitsToQuotaMeta(state.rateLimits);
        if (quotaMeta) {
          const quotaLabel = formatProviderQuotaLabel(quotaMeta);
          this.emitSessionInfo(sessionId, { ...(quotaLabel ? { quotaLabel } : {}), quotaMeta });
        }
      }
      return;
    }

    if (msg.type === 'stream_event') {
      const event = msg.event;
      if (event.type === 'message_start') {
        // New assistant message within the turn (the model's continuation after
        // a tool result starts a fresh message_start with a new id). Reset the
        // streaming accumulator so this message's deltas don't render prefixed
        // with the previous message's full text. Without this, the new bubble
        // briefly shows "<prev message text><new delta>" and only snaps to the
        // correct text when the message completes — visible flicker/bleed.
        state.currentText = '';
        state.currentMessageId = event.message?.id ? String(event.message.id) : null;
        return;
      }
      if (event.type === 'content_block_start' && this.isToolBlock(event.content_block)) {
        const tool = this.normalizeToolCall(event.content_block);
        state.toolCalls.set(event.index, { ...tool, partialInputJson: undefined });
        this.emitToolCall(sessionId, state, tool);
        this.emitClaudeRuntimeSubagentFromAgentTool(sessionId, state, tool, 'running');
        return;
      }
      if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta' && typeof event.delta.text === 'string') {
        const runtimeSubagentPayload = parseRuntimeSubagentTag(event.delta.text);
        if (runtimeSubagentPayload) {
          this.emitClaudeRuntimeSubagentSnapshot(sessionId, state, runtimeSubagentPayload);
          return;
        }
        state.currentText += event.delta.text;
        const messageId = makeMessageId(state);
        state.currentMessageId = messageId;
        const delta: MessageDelta = {
          messageId,
          type: 'text',
          delta: state.currentText,
          role: 'assistant',
        };
        for (const cb of this.deltaCallbacks) cb(sessionId, delta);
        return;
      }
      if (event.type === 'content_block_delta' && event.delta?.type === 'input_json_delta' && typeof event.delta.partial_json === 'string') {
        const tool = state.toolCalls.get(event.index);
        if (!tool) return;
        tool.partialInputJson = (tool.partialInputJson ?? '') + event.delta.partial_json;
        const parsed = this.tryParsePartialJson(tool.partialInputJson);
        if (parsed !== undefined) tool.input = parsed;
        return;
      }
      if (event.type === 'content_block_stop') {
        const tool = state.toolCalls.get(event.index);
        if (!tool) return;
        if (tool.partialInputJson && tool.input === undefined) {
          const parsed = this.tryParsePartialJson(tool.partialInputJson);
          if (parsed !== undefined) tool.input = parsed;
        }
        this.emitToolCall(sessionId, state, {
          id: tool.id,
          name: tool.name,
          status: 'complete',
          ...(tool.input !== undefined ? { input: tool.input } : {}),
          detail: {
            kind: 'tool_use_complete',
            summary: tool.name,
            input: tool.input,
            raw: tool,
          },
        });
        state.toolCalls.delete(event.index);
      }
      return;
    }

    if (msg.type === 'assistant') {
      const assistantUsage = msg.message?.usage as ClaudeUsageSnapshot | undefined;
      if (assistantUsage && typeof assistantUsage === 'object') {
        state.lastAssistantUsage = {
          ...(typeof assistantUsage.input_tokens === 'number' ? { input_tokens: assistantUsage.input_tokens } : {}),
          ...(typeof assistantUsage.output_tokens === 'number' ? { output_tokens: assistantUsage.output_tokens } : {}),
          ...(typeof assistantUsage.cache_read_input_tokens === 'number' ? { cache_read_input_tokens: assistantUsage.cache_read_input_tokens } : {}),
          ...(typeof assistantUsage.cache_creation_input_tokens === 'number' ? { cache_creation_input_tokens: assistantUsage.cache_creation_input_tokens } : {}),
        };
      }
      const text = collectAssistantText(msg);
      const runtimeSubagentPayload = parseRuntimeSubagentTag(text);
      if (runtimeSubagentPayload) {
        this.emitClaudeRuntimeSubagentSnapshot(sessionId, state, runtimeSubagentPayload);
        return;
      }
      if (Array.isArray(msg.message.content)) {
        for (const block of msg.message.content) {
          if (this.isToolBlock(block)) {
            const tool = this.normalizeToolCall(block);
            this.emitToolCall(sessionId, state, tool);
            this.emitClaudeRuntimeSubagentFromAgentTool(sessionId, state, tool, 'running');
          }
        }
      }
      if (text) {
        if (text !== state.currentText) {
          const messageId = makeMessageId(state);
          state.currentMessageId = messageId;
          state.currentText = text;
          const delta: MessageDelta = {
            messageId,
            type: 'text',
            delta: text,
            role: 'assistant',
          };
          for (const cb of this.deltaCallbacks) cb(sessionId, delta);
        } else {
          state.currentText = text;
        }
      } else {
        state.currentText = text;
      }
      return;
    }

    if (msg.type === 'user' && Array.isArray(msg.message?.content)) {
      for (const block of msg.message.content) {
        if (!block || typeof block !== 'object' || block.type !== 'tool_result' || typeof block.tool_use_id !== 'string') continue;
        const output = Array.isArray(block.content)
          ? block.content
            .map((entry) => {
              if (!entry || typeof entry !== 'object') return '';
              if ('text' in entry && typeof (entry as { text?: unknown }).text === 'string') {
                return (entry as { text: string }).text;
              }
              return '';
            })
            .filter(Boolean)
            .join('\n')
          : typeof block.content === 'string'
            ? block.content
            : undefined;
        this.emitClaudeRuntimeSubagentFromAgentTool(
          sessionId,
          state,
          {
            id: block.tool_use_id,
            name: 'Agent',
            ...(output ? { output } : {}),
          },
          block.is_error ? 'error' : 'complete',
        );
        this.emitToolCall(sessionId, state, {
          id: block.tool_use_id,
          name: 'tool',
          status: block.is_error ? 'error' : 'complete',
          ...(output ? { output } : {}),
          detail: {
            kind: 'tool_result',
            output,
            raw: block,
          },
        });
      }
      return;
    }

    if (msg.type === 'result') {
      if ((msg as { origin?: { kind?: string } }).origin?.kind === 'task-notification') {
        state.started = true;
        return;
      }
      if (msg.is_error) {
        const details = Array.isArray((msg as any).errors) ? (msg as any).errors.join('; ') : 'Claude execution failed';
        state.pendingError = this.makeError(PROVIDER_ERROR_CODES.PROVIDER_ERROR, details, false, msg);
        return;
      }
      state.started = true;
      state.completed = true;
      const messageId = makeMessageId(state);
      const success = msg as any;
      state.pendingComplete = {
        id: messageId,
        sessionId,
        kind: 'text',
        role: 'assistant',
        content: success.result,
        timestamp: Date.now(),
        status: 'complete',
        metadata: {
          ...(state.model ? { model: state.model } : {}),
          usage: state.lastAssistantUsage ?? msg.usage,
          ...(state.lastAssistantUsage && state.lastAssistantUsage !== msg.usage ? { totalUsage: msg.usage } : {}),
          resultSubtype: msg.subtype,
          resumeId: state.resumeId,
        },
      };
      this.armResultCompletionFallback(sessionId, state);
      return;
    }
  }

  private armResultCompletionFallback(sessionId: string, state: ClaudeSdkSessionState): void {
    if (!state.currentQuery || !state.pendingComplete) return;
    this.clearResultCompletionFallback(state);
    const turnGeneration = state.turnGeneration;
    state.resultCompletionGeneration = turnGeneration;
    state.resultCompletionTimer = setTimeout(() => {
      state.resultCompletionTimer = null;
      if (!this.sessions.has(sessionId)) return;
      if (state.turnGeneration !== turnGeneration || state.resultCompletionGeneration !== turnGeneration) return;
      if (!state.currentQuery || !state.pendingComplete) return;

      const pendingComplete = state.pendingComplete;
      const q = state.currentQuery;
      state.pendingComplete = undefined;
      state.pendingError = undefined;
      state.resultCompletionGeneration = undefined;
      state.currentMessageId = null;
      state.currentText = '';
      pendingComplete.metadata = {
        ...(pendingComplete.metadata ?? {}),
        completionFallback: 'result-timeout',
      };
      if (this.activeClaudeSubagentTasks(state).length > 0) {
        // The Claude Code SDK keeps the Query open while background tasks can
        // later inject task-notification follow-up messages. Do not close it
        // here: deliver the foreground result to IM.codes, but keep listening
        // so task_notification can terminalize the background row.
        for (const cb of this.completeCallbacks) cb(sessionId, pendingComplete);
        return;
      }
      try { q.close(); } catch {}
      this.terminateChild(state);
      state.currentQuery = null;
      state.currentChild = null;
      for (const cb of this.completeCallbacks) cb(sessionId, pendingComplete);
    }, RESULT_COMPLETION_FALLBACK_MS);
    state.resultCompletionTimer.unref?.();
  }

  private clearResultCompletionFallback(state: ClaudeSdkSessionState): void {
    if (state.resultCompletionTimer) {
      clearTimeout(state.resultCompletionTimer);
      state.resultCompletionTimer = null;
    }
    state.resultCompletionGeneration = undefined;
  }

  private resolvePermissionMode(): PermissionMode {
    const configured = this.config?.permissionMode;
    if (configured === 'default' || configured === 'acceptEdits' || configured === 'bypassPermissions' || configured === 'plan' || configured === 'dontAsk' || configured === 'auto') {
      return configured;
    }
    return DEFAULT_PERMISSION_MODE;
  }

  private getConfiguredBinaryPath(config: ProviderConfig | null): string {
    return typeof config?.binaryPath === 'string' && config.binaryPath.trim() ? config.binaryPath : CLAUDE_BIN;
  }

  private resolveBinaryPath(config: ProviderConfig | null): string {
    return resolveClaudeCodePathForSdk(this.getConfiguredBinaryPath(config));
  }

  private emitSessionInfo(sessionId: string, info: SessionInfoUpdate): void {
    for (const cb of this.sessionInfoCallbacks) cb(sessionId, info);
  }

  private emitStatus(sessionId: string, state: ClaudeSdkSessionState, status: ProviderStatusUpdate): void {
    const signature = JSON.stringify({
      status: status.status,
      label: status.label ?? null,
    });
    if (state.lastStatusSignature === signature) return;
    state.lastStatusSignature = signature;
    for (const cb of this.statusCallbacks) cb(sessionId, status);
  }

  private emitError(sessionId: string, error: ProviderError): void {
    if (this.sessions.get(sessionId)?.completed && error.code === PROVIDER_ERROR_CODES.CANCELLED) return;
    for (const cb of this.errorCallbacks) cb(sessionId, error);
  }

  private handleClaudeTaskLifecycleMessage(
    sessionId: string,
    state: ClaudeSdkSessionState,
    msg: ClaudeTaskLifecycleMessage,
  ): void {
    const taskId = this.pickString(msg.task_id);
    if (!taskId) {
      this.emitClaudeSubagentDiagnostic(
        sessionId,
        state,
        msg,
        SDK_SUBAGENT_DIAGNOSTIC.MISSING_ID,
        `Claude ${msg.subtype} message was missing task_id`,
      );
      return;
    }

    const existing = state.subagentTasks.get(taskId);
    const task = existing ?? this.createClaudeTaskState(sessionId, state, taskId);
    if (!existing) state.subagentTasks.set(taskId, task);
    task.lastUpdatedAt = Date.now();

    const toolUseId = this.pickString(msg.tool_use_id);
    if (toolUseId) task.toolUseId = toolUseId;

    if (msg.subtype === 'task_started') {
      task.description = this.pickShortString(msg.description) ?? task.description;
      task.model = this.readRuntimeSubagentModel(msg) ?? task.model;
      task.taskType = this.pickShortString(msg.task_type) ?? task.taskType;
      task.workflowName = this.pickShortString(msg.workflow_name) ?? task.workflowName;
      this.applyClaudeTaskStatus(task, 'running');
    } else if (msg.subtype === 'task_progress') {
      task.description = this.pickShortString(msg.description) ?? task.description;
      task.model = this.readRuntimeSubagentModel(msg) ?? task.model;
      task.summary = this.pickShortString(msg.summary) ?? task.summary;
      task.lastToolName = this.pickShortString(msg.last_tool_name) ?? task.lastToolName;
      task.usage = this.normalizeClaudeTaskUsage(msg.usage) ?? task.usage;
      this.applyClaudeTaskStatus(task, 'running');
    } else if (msg.subtype === 'task_updated') {
      const patch = this.asRecord(msg.patch);
      task.description = this.pickShortString(patch?.description) ?? task.description;
      task.model = this.readRuntimeSubagentModel(patch ?? {}) ?? task.model;
      task.error = this.pickShortString(patch?.error) ?? task.error;
      if (typeof patch?.is_backgrounded === 'boolean') task.backgrounded = patch.is_backgrounded;
      this.applyClaudeTaskStatus(task, this.pickString(patch?.status));
    } else if (msg.subtype === 'task_notification') {
      task.summary = this.pickShortString(msg.summary) ?? task.summary;
      task.model = this.readRuntimeSubagentModel(msg) ?? task.model;
      task.outputFile = this.pickShortString(msg.output_file) ?? task.outputFile;
      task.usage = this.normalizeClaudeTaskUsage(msg.usage) ?? task.usage;
      this.applyClaudeTaskStatus(task, this.pickString(msg.status));
    }

    this.emitClaudeSubagentSnapshot(sessionId, state, task);
  }

  private emitClaudeRuntimeSubagentSnapshot(
    sessionId: string,
    state: ClaudeSdkSessionState,
    payload: Record<string, unknown>,
  ): void {
    const record = this.readNestedRuntimeSubagentRecord(payload) ?? payload;
    const rawAgentPath = this.readRuntimeSubagentId(record);
    const fallbackId = this.pickString(payload.subtype) ?? this.pickString(payload.type) ?? 'notification-missing-id';
    const agentPath = rawAgentPath ?? fallbackId;
    const statusInfo = this.readRuntimeSubagentStatusInfo(record);
    const rawStatus = statusInfo.status ?? 'unknown';
    const missingIdDiagnostic = rawAgentPath ? undefined : SDK_SUBAGENT_DIAGNOSTIC.MISSING_ID;
    const statusMapping = this.normalizeClaudeRuntimeSubagentStatus(rawStatus, missingIdDiagnostic);
    const canonicalKey = makeClaudeSubagentCanonicalKey(this.subagentSessionKey(sessionId, state), `runtime:${agentPath}`);
    const agentName = this.readRuntimeSubagentName(record);
    const model = this.readRuntimeSubagentModel(record);
    const prompt = this.readRuntimeSubagentPrompt(record);
    const summary = agentName ? `Claude sub-agent ${agentName}` : rawAgentPath ? `Claude sub-agent ${rawAgentPath}` : 'Claude sub-agent';
    const detail = buildSdkSubagentSafeDetail({
      kind: SDK_SUBAGENT_DETAIL_KIND,
      summary,
      ...(prompt ? { input: { action: 'claude-runtime-subagent', description: prompt } } : {}),
      ...(statusMapping.terminal ? { output: statusInfo.message ?? rawStatus } : {}),
      meta: {
        isSdkSubagent: true,
        schemaVersion: SDK_SUBAGENT_SCHEMA_VERSION,
        provider: SDK_SUBAGENT_PROVIDERS.CLAUDE_CODE_SDK,
        providerKind: SDK_SUBAGENT_PROVIDER_KINDS.CLAUDE_RUNTIME_AGENT,
        canonicalKey,
        normalizedStatus: statusMapping.normalizedStatus,
        rawStatus,
        active: statusMapping.active,
        terminal: statusMapping.terminal,
        parentSessionId: state.resumeId,
        parentItemId: canonicalKey,
        ...(rawAgentPath ? { agentPath: rawAgentPath } : {}),
        ...(agentName ? { agentName } : {}),
        ...(model ? { model } : {}),
        diagnosticCode: statusMapping.diagnosticCode,
      },
    } satisfies SdkSubagentDetail, { allowRaw: false });
    this.emitSubagentToolCall(sessionId, state, {
      id: canonicalKey,
      name: 'Agent',
      status: statusMapping.toolStatus,
      ...(detail.input ? { input: detail.input } : {}),
      ...(detail.output ? { output: detail.output } : {}),
      detail,
    });
  }

  private readNestedRuntimeSubagentRecord(value: unknown): Record<string, unknown> | undefined {
    const record = this.asRecord(value);
    if (!record) return undefined;
    for (const key of ['subagent', 'subAgent', 'agent', 'notification', 'data', 'event']) {
      const nested = this.readNestedRuntimeSubagentRecord(record[key]);
      if (nested) return nested;
    }
    const subtype = this.pickString(record.subtype);
    const hasRuntimeShape = Boolean(
      this.pickString(record.agent_path)
      ?? this.pickString(record.agentPath)
      ?? this.pickString(record.agent_id)
      ?? this.pickString(record.agentId)
      ?? this.pickString(record.path)
      ?? this.pickString(record.status)
      ?? this.pickString(record.state)
      ?? (subtype && CLAUDE_RUNTIME_SUBAGENT_SYSTEM_SUBTYPES.has(subtype)),
    );
    if (hasRuntimeShape) return record;
    return undefined;
  }

  private readRuntimeSubagentId(record: Record<string, unknown>): string | undefined {
    return this.pickString(record.agent_path)
      ?? this.pickString(record.agentPath)
      ?? this.pickString(record.agent_id)
      ?? this.pickString(record.agentId)
      ?? this.pickString(record.path)
      ?? this.pickString(record.id);
  }

  private readRuntimeSubagentName(record: Record<string, unknown>): string | undefined {
    return this.pickShortString(record.name)
      ?? this.pickShortString(record.nickname)
      ?? this.pickShortString(record.displayName)
      ?? this.pickShortString(record.display_name)
      ?? this.pickShortString(record.label);
  }

  private readRuntimeSubagentModel(record: Record<string, unknown>): string | undefined {
    return this.pickShortString(record.model)
      ?? this.pickShortString(record.agentModel)
      ?? this.pickShortString(record.agent_model)
      ?? this.pickShortString(record.modelId)
      ?? this.pickShortString(record.model_id);
  }

  private readRuntimeSubagentStatus(record: Record<string, unknown>): string | undefined {
    return this.pickString(record.status)
      ?? this.pickString(record.state)
      ?? this.pickString(record.lifecycleStatus)
      ?? this.pickString(record.lifecycle_status);
  }

  private readRuntimeSubagentStatusInfo(record: Record<string, unknown>): { status?: string; message?: string } {
    const direct = this.readRuntimeSubagentStatus(record);
    if (direct) return { status: direct };
    const statusRecord = this.asRecord(record.status) ?? this.asRecord(record.state);
    if (!statusRecord) return {};
    const nested = this.pickString(statusRecord.status)
      ?? this.pickString(statusRecord.state)
      ?? this.pickString(statusRecord.lifecycleStatus)
      ?? this.pickString(statusRecord.lifecycle_status);
    if (nested) return { status: nested };
    for (const key of ['completed', 'complete', 'shutdown', 'running', 'pending', 'failed', 'error', 'interrupted', 'cancelled', 'canceled', 'stopped', 'killed']) {
      if (key in statusRecord) {
        return { status: key, message: this.pickShortString(statusRecord[key]) };
      }
    }
    return {};
  }

  private readRuntimeSubagentPrompt(record: Record<string, unknown>): string | undefined {
    return this.pickShortString(record.prompt)
      ?? this.pickShortString(record.description)
      ?? this.pickShortString(record.instruction)
      ?? this.pickShortString(record.instructions)
      ?? this.pickShortString(record.message);
  }

  private normalizeClaudeRuntimeSubagentStatus(
    rawStatus: string,
    diagnosticCode: SdkSubagentDiagnosticCode | undefined,
  ): {
    toolStatus: ToolCallEvent['status'];
    normalizedStatus: SdkSubagentNormalizedStatus;
    active: boolean;
    terminal: boolean;
    diagnosticCode?: SdkSubagentDiagnosticCode;
  } {
    if (diagnosticCode) {
      return {
        toolStatus: 'error',
        normalizedStatus: SDK_SUBAGENT_STATUS.UNKNOWN,
        active: false,
        terminal: true,
        diagnosticCode,
      };
    }

    const normalized = normalizeStatusName(rawStatus);
    if (
      normalized === 'pending'
      || normalized === 'queued'
      || normalized === 'starting'
      || normalized === 'created'
      || normalized === 'spawned'
    ) {
      return {
        toolStatus: 'running',
        normalizedStatus: SDK_SUBAGENT_STATUS.PENDING,
        active: true,
        terminal: false,
      };
    }
    if (
      normalized === 'running'
      || normalized === 'active'
      || normalized === 'started'
      || normalized === 'working'
      || normalized === 'inprogress'
    ) {
      return {
        toolStatus: 'running',
        normalizedStatus: SDK_SUBAGENT_STATUS.RUNNING,
        active: true,
        terminal: false,
      };
    }
    if (
      normalized === 'shutdown'
      || normalized === 'complete'
      || normalized === 'completed'
      || normalized === 'done'
      || normalized === 'success'
      || normalized === 'succeeded'
      || normalized === 'finished'
    ) {
      return {
        toolStatus: 'complete',
        normalizedStatus: SDK_SUBAGENT_STATUS.COMPLETE,
        active: false,
        terminal: true,
      };
    }
    if (
      normalized === 'failed'
      || normalized === 'failure'
      || normalized === 'error'
      || normalized === 'errored'
      || normalized === 'crashed'
    ) {
      return {
        toolStatus: 'error',
        normalizedStatus: SDK_SUBAGENT_STATUS.ERROR,
        active: false,
        terminal: true,
      };
    }
    if (
      normalized === 'interrupted'
      || normalized === 'cancelled'
      || normalized === 'canceled'
      || normalized === 'stopped'
      || normalized === 'killed'
    ) {
      return {
        toolStatus: 'error',
        normalizedStatus: SDK_SUBAGENT_STATUS.INTERRUPTED,
        active: false,
        terminal: true,
      };
    }

    return {
      toolStatus: 'error',
      normalizedStatus: SDK_SUBAGENT_STATUS.UNKNOWN,
      active: false,
      terminal: true,
      diagnosticCode: SDK_SUBAGENT_DIAGNOSTIC.UNKNOWN_STATE,
    };
  }

  private createClaudeTaskState(sessionId: string, state: ClaudeSdkSessionState, taskId: string): ClaudeTaskState {
    const canonicalKey = makeClaudeSubagentCanonicalKey(this.subagentSessionKey(sessionId, state), taskId);
    return {
      taskId,
      canonicalKey,
      rawStatus: 'running',
      normalizedStatus: SDK_SUBAGENT_STATUS.RUNNING,
      terminal: false,
      active: true,
      lastUpdatedAt: Date.now(),
    };
  }

  private expireStaleClaudeSubagentTasks(sessionId: string, state: ClaudeSdkSessionState, now = Date.now()): number {
    const staleMs = getSubagentStaleWithoutTerminalMs();
    let expired = 0;
    for (const task of state.subagentTasks.values()) {
      if (!task.active || task.terminal) continue;
      if (now - task.lastUpdatedAt < staleMs) continue;
      task.rawStatus = 'stale';
      task.normalizedStatus = SDK_SUBAGENT_STATUS.STALE;
      task.diagnosticCode = SDK_SUBAGENT_DIAGNOSTIC.STALE_WITHOUT_TERMINAL;
      task.summary = task.summary ?? 'Claude task did not report a terminal update';
      task.error = `Claude task marked stale after ${Math.round((now - task.lastUpdatedAt) / 1000)}s without a terminal update`;
      task.terminal = true;
      task.active = false;
      task.lastUpdatedAt = now;
      this.emitClaudeSubagentSnapshot(sessionId, state, task);
      expired += 1;
    }
    if (expired > 0) {
      logger.warn({
        provider: this.id,
        sessionId,
        expired,
        staleMs,
      }, 'Claude SDK subagent task(s) stale without terminal update; closing provider active-work evidence');
    }
    return expired;
  }

  private activeClaudeSubagentTasks(state: ClaudeSdkSessionState): ClaudeTaskState[] {
    return Array.from(state.subagentTasks.values()).filter((task) => task.active && !task.terminal);
  }

  private async cancelActiveClaudeSubagentTasks(sessionId: string, state: ClaudeSdkSessionState, now = Date.now()): Promise<number> {
    let cancelled = 0;
    const queryWithTaskStop = state.currentQuery as (ReturnType<typeof query> & { stopTask?: (taskId: string) => Promise<void> }) | null;
    for (const task of this.activeClaudeSubagentTasks(state)) {
      if (typeof queryWithTaskStop?.stopTask === 'function') {
        try {
          await Promise.race([
            queryWithTaskStop.stopTask(task.taskId),
            new Promise<void>((resolve) => setTimeout(resolve, CANCEL_INTERRUPT_TIMEOUT_MS)),
          ]);
        } catch (err) {
          logger.warn({ err, provider: this.id, sessionId, taskId: task.taskId }, 'Claude SDK stopTask failed; marking task cancelled locally');
        }
      }
      task.rawStatus = 'interrupted';
      task.normalizedStatus = SDK_SUBAGENT_STATUS.INTERRUPTED;
      task.summary = task.summary ?? 'Claude task cancelled';
      task.error = 'Claude task cancelled by user stop';
      task.terminal = true;
      task.active = false;
      task.lastUpdatedAt = now;
      this.emitClaudeSubagentSnapshot(sessionId, state, task);
      cancelled += 1;
    }
    if (cancelled > 0) {
      logger.info({
        provider: this.id,
        sessionId,
        cancelled,
      }, 'Claude SDK subagent task(s) cancelled by user stop');
    }
    return cancelled;
  }

  private emitClaudeRuntimeSubagentFromAgentTool(
    sessionId: string,
    state: ClaudeSdkSessionState,
    tool: Pick<ToolCallEvent, 'id' | 'name' | 'input' | 'output'>,
    status: 'running' | 'complete' | 'error',
  ): void {
    if (tool.name !== 'Agent' && tool.name !== 'Task') return;
    const input = this.asRecord(tool.input);
    const existing = state.runtimeAgentToolCalls.get(tool.id);
    if (!existing && status !== 'running') return;
    const agentPath = existing?.agentPath ?? tool.id;
    const prompt = existing?.prompt ?? this.readRuntimeSubagentPrompt(input ?? {});
    const agentName = existing?.agentName
      ?? this.pickShortString(input?.subagent_type)
      ?? this.pickShortString(input?.agent_type)
      ?? this.pickShortString(input?.type)
      ?? this.pickShortString(input?.name);
    const model = existing?.model ?? this.readRuntimeSubagentModel(input ?? {});
    const canonicalKey = existing?.canonicalKey
      ?? makeClaudeSubagentCanonicalKey(this.subagentSessionKey(sessionId, state), `runtime:${agentPath}`);
    if (status === 'running' && !existing) {
      state.runtimeAgentToolCalls.set(tool.id, {
        canonicalKey,
        agentPath,
        ...(agentName ? { agentName } : {}),
        ...(model ? { model } : {}),
        ...(prompt ? { prompt } : {}),
      });
    }
    const rawStatus = status === 'running' ? 'running' : status === 'complete' ? 'completed' : 'failed';
    const output = status === 'running' ? undefined : sanitizeSdkSubagentText(tool.output) ?? rawStatus;
    const detail = buildSdkSubagentSafeDetail({
      kind: SDK_SUBAGENT_DETAIL_KIND,
      summary: agentName ? `Claude sub-agent ${agentName}` : `Claude sub-agent ${agentPath}`,
      ...(prompt ? { input: { action: 'claude-agent-tool', description: prompt } } : {}),
      ...(output ? { output } : {}),
      meta: {
        isSdkSubagent: true,
        schemaVersion: SDK_SUBAGENT_SCHEMA_VERSION,
        provider: SDK_SUBAGENT_PROVIDERS.CLAUDE_CODE_SDK,
        providerKind: SDK_SUBAGENT_PROVIDER_KINDS.CLAUDE_RUNTIME_AGENT,
        canonicalKey,
        normalizedStatus: status === 'running'
          ? SDK_SUBAGENT_STATUS.RUNNING
          : status === 'complete'
            ? SDK_SUBAGENT_STATUS.COMPLETE
            : SDK_SUBAGENT_STATUS.ERROR,
        rawStatus,
        active: status === 'running',
        terminal: status !== 'running',
        parentSessionId: state.resumeId,
        parentToolUseId: tool.id,
        parentItemId: tool.id,
        agentPath,
        ...(agentName ? { agentName } : {}),
        ...(model ? { model } : {}),
      },
    } satisfies SdkSubagentDetail, { allowRaw: false });
    this.emitSubagentToolCall(sessionId, state, {
      id: canonicalKey,
      name: 'Agent',
      status: status === 'running' ? 'running' : status === 'complete' ? 'complete' : 'error',
      ...(detail.input ? { input: detail.input } : {}),
      ...(detail.output ? { output: detail.output } : {}),
      detail,
    });
    if (status !== 'running') state.runtimeAgentToolCalls.delete(tool.id);
  }

  private applyClaudeTaskStatus(task: ClaudeTaskState, rawStatus: string | undefined): void {
    if (!rawStatus) return;
    const { normalizedStatus, terminal, diagnosticCode } = this.normalizeClaudeTaskStatus(rawStatus);
    if (task.terminal && (normalizedStatus === SDK_SUBAGENT_STATUS.RUNNING || normalizedStatus === SDK_SUBAGENT_STATUS.PENDING)) {
      return;
    }
    if (
      task.terminal
      && task.normalizedStatus !== SDK_SUBAGENT_STATUS.UNKNOWN
      && terminal
      && normalizedStatus === SDK_SUBAGENT_STATUS.UNKNOWN
    ) {
      return;
    }
    if (
      task.terminal
      && task.normalizedStatus !== SDK_SUBAGENT_STATUS.UNKNOWN
      && terminal
      && normalizedStatus !== task.normalizedStatus
    ) {
      return;
    }

    task.rawStatus = rawStatus;
    if (diagnosticCode) task.diagnosticCode = diagnosticCode;
    else delete task.diagnosticCode;
    task.normalizedStatus = normalizedStatus;
    task.terminal = terminal;
    task.active = this.isClaudeSubagentActive(normalizedStatus) && !terminal;
  }

  private normalizeClaudeTaskStatus(rawStatus: string): {
    normalizedStatus: SdkSubagentNormalizedStatus;
    terminal: boolean;
    diagnosticCode?: SdkSubagentDiagnosticCode;
  } {
    switch (rawStatus) {
      case 'pending':
        return { normalizedStatus: SDK_SUBAGENT_STATUS.PENDING, terminal: false };
      case 'running':
        return { normalizedStatus: SDK_SUBAGENT_STATUS.RUNNING, terminal: false };
      case 'completed':
        return { normalizedStatus: SDK_SUBAGENT_STATUS.COMPLETE, terminal: true };
      case 'failed':
      case 'killed':
      case 'stopped':
        return { normalizedStatus: SDK_SUBAGENT_STATUS.ERROR, terminal: true };
      case 'interrupted':
        return { normalizedStatus: SDK_SUBAGENT_STATUS.INTERRUPTED, terminal: true };
      case 'stale':
        return {
          normalizedStatus: SDK_SUBAGENT_STATUS.STALE,
          terminal: true,
          diagnosticCode: SDK_SUBAGENT_DIAGNOSTIC.STALE_WITHOUT_TERMINAL,
        };
      default:
        return {
          normalizedStatus: SDK_SUBAGENT_STATUS.UNKNOWN,
          terminal: true,
          diagnosticCode: SDK_SUBAGENT_DIAGNOSTIC.UNKNOWN_STATE,
        };
    }
  }

  private isClaudeSubagentActive(status: SdkSubagentNormalizedStatus): boolean {
    return status === SDK_SUBAGENT_STATUS.PENDING || status === SDK_SUBAGENT_STATUS.RUNNING;
  }

  private emitClaudeSubagentSnapshot(
    sessionId: string,
    state: ClaudeSdkSessionState,
    task: ClaudeTaskState,
  ): void {
    const summary = sanitizeSdkSubagentText(task.summary) ?? 'Claude task';
    const meta = this.buildClaudeSubagentMeta(state, task);
    const detail = buildSdkSubagentSafeDetail({
      kind: SDK_SUBAGENT_DETAIL_KIND,
      summary,
      ...(task.description ? { input: { action: 'claude-task', description: task.description } } : {}),
      ...(task.terminal ? { output: task.error ?? task.summary } : {}),
      meta,
    }, { allowRaw: false });
    const tool: ToolCallEvent = {
      id: task.canonicalKey,
      name: 'Agent',
      status: task.normalizedStatus === SDK_SUBAGENT_STATUS.ERROR
        || task.normalizedStatus === SDK_SUBAGENT_STATUS.INTERRUPTED
        || task.normalizedStatus === SDK_SUBAGENT_STATUS.UNKNOWN
        || task.normalizedStatus === SDK_SUBAGENT_STATUS.STALE
        ? 'error'
        : task.normalizedStatus === SDK_SUBAGENT_STATUS.COMPLETE
          ? 'complete'
          : 'running',
      ...(detail.input ? { input: detail.input } : {}),
      ...(task.terminal && detail.output ? { output: detail.output } : {}),
      detail,
    };
    this.emitSubagentToolCall(sessionId, state, tool);
  }

  private emitClaudeSubagentDiagnostic(
    sessionId: string,
    state: ClaudeSdkSessionState,
    rawMessage: ClaudeTaskLifecycleMessage,
    diagnosticCode: SdkSubagentDiagnosticCode,
    summary: string,
  ): void {
    const idPart = this.pickString(rawMessage.uuid) ?? randomUUID();
    const canonicalKey = makeClaudeSubagentCanonicalKey(
      this.subagentSessionKey(sessionId, state),
      `diagnostic:${rawMessage.subtype}:${idPart}`,
    );
    const detail = buildSdkSubagentSafeDetail({
      kind: SDK_SUBAGENT_DETAIL_KIND,
      summary,
      input: { action: 'diagnostic', description: summary },
      meta: {
        isSdkSubagent: true,
        schemaVersion: SDK_SUBAGENT_SCHEMA_VERSION,
        provider: SDK_SUBAGENT_PROVIDERS.CLAUDE_CODE_SDK,
        providerKind: SDK_SUBAGENT_PROVIDER_KINDS.CLAUDE_TASK,
        canonicalKey,
        normalizedStatus: SDK_SUBAGENT_STATUS.UNKNOWN,
        rawStatus: rawMessage.subtype,
        active: false,
        terminal: true,
        parentSessionId: state.resumeId,
        diagnosticCode,
      },
      raw: rawMessage,
    }, { allowRaw: true });
    this.emitSubagentToolCall(sessionId, state, {
      id: canonicalKey,
      name: 'Agent',
      status: 'error',
      ...(detail.input ? { input: detail.input } : {}),
      output: detail.output ?? summary,
      detail,
    });
  }

  private buildClaudeSubagentMeta(
    state: ClaudeSdkSessionState,
    task: ClaudeTaskState,
  ): SdkSubagentDetail['meta'] {
    return {
      isSdkSubagent: true,
      schemaVersion: SDK_SUBAGENT_SCHEMA_VERSION,
      provider: SDK_SUBAGENT_PROVIDERS.CLAUDE_CODE_SDK,
      providerKind: SDK_SUBAGENT_PROVIDER_KINDS.CLAUDE_TASK,
      canonicalKey: task.canonicalKey,
      normalizedStatus: task.normalizedStatus,
      ...(task.rawStatus ? { rawStatus: task.rawStatus } : {}),
      active: task.active,
      terminal: task.terminal,
      parentSessionId: state.resumeId,
      ...(task.toolUseId ? { parentToolUseId: task.toolUseId } : {}),
      taskId: task.taskId,
      ...(task.lastToolName ? { lastToolName: task.lastToolName } : {}),
      ...(task.taskType ? { taskType: task.taskType } : {}),
      ...(task.workflowName ? { workflowName: task.workflowName } : {}),
      ...(task.model ? { model: task.model } : {}),
      ...(typeof task.backgrounded === 'boolean' ? { backgrounded: task.backgrounded } : {}),
      ...(task.usage?.total_tokens !== undefined ? { usageTotalTokens: task.usage.total_tokens } : {}),
      ...(task.usage?.tool_uses !== undefined ? { usageToolUses: task.usage.tool_uses } : {}),
      ...(task.usage?.duration_ms !== undefined ? { usageDurationMs: task.usage.duration_ms } : {}),
      ...(task.diagnosticCode ? { diagnosticCode: task.diagnosticCode } : {}),
    } as SdkSubagentDetail['meta'];
  }

  private emitSubagentToolCall(sessionId: string, state: ClaudeSdkSessionState, tool: ToolCallEvent): void {
    const signature = sdkSubagentDedupSignature(tool);
    if (state.emittedSubagentStates.get(tool.id) === signature) return;
    state.emittedSubagentStates.set(tool.id, signature);
    for (const cb of this.toolCallCallbacks) cb(sessionId, tool);
  }

  private emitToolCall(sessionId: string, state: ClaudeSdkSessionState, tool: ToolCallEvent): void {
    const normalizedTool = this.normalizeChecklistToolCall(tool);
    const signature = JSON.stringify({
      status: normalizedTool.status,
      name: normalizedTool.name,
      input: normalizedTool.input ?? null,
      output: normalizedTool.output ?? null,
    });
    if (state.emittedToolStates.get(normalizedTool.id) === signature) return;
    state.emittedToolStates.set(normalizedTool.id, signature);
    for (const cb of this.toolCallCallbacks) cb(sessionId, normalizedTool);
  }

  private isClaudeTaskLifecycleMessage(msg: SDKMessage): msg is ClaudeTaskLifecycleMessage {
    if (msg.type !== 'system') return false;
    const subtype = (msg as { subtype?: unknown }).subtype;
    return typeof subtype === 'string' && CLAUDE_TASK_SYSTEM_SUBTYPES.has(subtype);
  }

  private isClaudeRuntimeSubagentMessage(msg: SDKMessage): msg is ClaudeTaskLifecycleMessage {
    if (msg.type !== 'system') return false;
    const subtype = (msg as { subtype?: unknown }).subtype;
    return typeof subtype === 'string' && CLAUDE_RUNTIME_SUBAGENT_SYSTEM_SUBTYPES.has(subtype);
  }

  private isClaudeThinkingTokensMessage(msg: SDKMessage): boolean {
    return msg.type === 'system'
      && (msg as { subtype?: unknown }).subtype === 'thinking_tokens';
  }

  private isToolBlock(block: unknown): block is ClaudeToolBlock {
    if (!block || typeof block !== 'object') return false;
    const type = (block as { type?: unknown }).type;
    return type === 'tool_use' || type === 'server_tool_use' || type === 'mcp_tool_use';
  }

  private normalizeToolCall(block: ClaudeToolBlock): ToolCallEvent {
    const name = typeof block.name === 'string' && block.name ? block.name : 'tool';
    return {
      id: typeof block.id === 'string' && block.id ? block.id : randomUUID(),
      name,
      status: 'running',
      ...(block.input !== undefined ? { input: block.input } : {}),
      detail: {
        kind: block.type,
        summary: name,
        input: block.input,
        raw: block,
      },
    };
  }

  private normalizeChecklistToolCall(tool: ToolCallEvent): ToolCallEvent {
    const normalizedName = normalizeStatusName(tool.name);
    if (!CLAUDE_CHECKLIST_TOOL_NAMES.has(normalizedName)) return tool;
    const input = this.normalizeClaudeChecklistInput(tool.input)
      ?? this.normalizeClaudeChecklistInput(tool.detail?.input);
    if (!input) return tool;
    return {
      ...tool,
      input,
      detail: {
        ...(tool.detail ?? {}),
        kind: 'plan',
        summary: 'Plan',
        input,
        raw: tool.detail?.raw ?? tool.input,
      },
    };
  }

  private normalizeClaudeChecklistInput(value: unknown): ClaudeChecklistInput | null {
    const rawItems = Array.isArray(value) ? value : this.rawChecklistItemsFromRecord(value);
    if (!rawItems) return null;
    const plan: ClaudeChecklistInput['plan'] = [];
    for (const rawItem of rawItems) {
      const content = this.claudeChecklistText(rawItem);
      if (!content) continue;
      const record = this.asRecord(rawItem);
      const status = record
        ? this.normalizeClaudeChecklistStatus(record.status)
        : 'pending';
      plan.push({ content, status });
    }
    return { plan };
  }

  private rawChecklistItemsFromRecord(value: unknown): unknown[] | null {
    const record = this.asRecord(value);
    if (!record) return null;
    for (const key of CLAUDE_CHECKLIST_LIST_KEYS) {
      if (Array.isArray(record[key])) return record[key] as unknown[];
    }
    return null;
  }

  private claudeChecklistText(value: unknown): string {
    if (typeof value === 'string') return value.trim();
    const record = this.asRecord(value);
    if (!record) return '';
    for (const key of CLAUDE_CHECKLIST_TEXT_KEYS) {
      const text = record[key];
      if (typeof text === 'string' && text.trim()) return text.trim();
    }
    return '';
  }

  private normalizeClaudeChecklistStatus(value: unknown): 'pending' | 'in_progress' | 'completed' {
    const normalized = normalizeStatusName(typeof value === 'string' ? value : undefined);
    if (normalized === 'completed' || normalized === 'complete' || normalized === 'done' || normalized === 'finished' || normalized === 'checked') {
      return 'completed';
    }
    if (normalized === 'inprogress' || normalized === 'active' || normalized === 'doing' || normalized === 'running' || normalized === 'started') {
      return 'in_progress';
    }
    return 'pending';
  }

  private tryParsePartialJson(value: string): unknown {
    try {
      return JSON.parse(value);
    } catch {
      return undefined;
    }
  }

  private normalizeClaudeTaskUsage(value: unknown): ClaudeTaskUsageSnapshot | undefined {
    const record = this.asRecord(value);
    if (!record) return undefined;
    const usage: ClaudeTaskUsageSnapshot = {
      ...(typeof record.total_tokens === 'number' ? { total_tokens: record.total_tokens } : {}),
      ...(typeof record.tool_uses === 'number' ? { tool_uses: record.tool_uses } : {}),
      ...(typeof record.duration_ms === 'number' ? { duration_ms: record.duration_ms } : {}),
    };
    return Object.keys(usage).length > 0 ? usage : undefined;
  }

  private asRecord(value: unknown): Record<string, unknown> | undefined {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    return value as Record<string, unknown>;
  }

  private pickString(value: unknown): string | undefined {
    return typeof value === 'string' && value.length > 0 ? value : undefined;
  }

  private pickShortString(value: unknown): string | undefined {
    return sanitizeSdkSubagentText(this.pickString(value));
  }

  private subagentSessionKey(sessionId: string, state: ClaudeSdkSessionState): string {
    return state.sessionName ?? sessionId;
  }

  private normalizeError(err: unknown): ProviderError {
    const message = err instanceof Error ? err.message : String(err);
    if (/ENOENT|not found|spawn .*claude/i.test(message)) {
      return this.makeError(PROVIDER_ERROR_CODES.PROVIDER_NOT_FOUND, `Claude binary not found: ${message}`, false, err);
    }
    if (/resume|session/i.test(message) && /not found|invalid|unknown/i.test(message)) {
      return this.makeError(PROVIDER_ERROR_CODES.SESSION_NOT_FOUND, message, true, err);
    }
    return this.makeError(PROVIDER_ERROR_CODES.PROVIDER_ERROR, message, false, err);
  }

  private isMissingResumeError(message: string): boolean {
    return /no conversation found|session .* not found|unknown session|invalid session/i.test(message);
  }

  private makeError(code: string, message: string, recoverable: boolean, details?: unknown): ProviderError {
    return { code, message, recoverable, ...(details !== undefined ? { details } : {}) };
  }

  private terminateChild(state: ClaudeSdkSessionState): void {
    const child = state.currentChild;
    if (!child || child.killed) return;
    // Tree-kill instead of single SIGTERM: the claude-code wrapper may spawn
    // native descendants that survive a wrapper-only kill. killProcessTree
    // walks the descendant tree via `ps` and SIGKILLs stragglers after
    // FORCE_KILL_TIMEOUT_MS. Fire-and-forget so callers stay synchronous.
    void killProcessTree(child, { gracefulMs: FORCE_KILL_TIMEOUT_MS });
  }
}
