import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import readline from 'node:readline';
import type {
  ProviderCapabilities,
  ProviderConfig,
  ProviderError,
  ProviderModelList,
  ProviderStatusUpdate,
  ProviderUsageUpdate,
  SessionConfig,
  SessionInfoUpdate,
  TransportProvider,
} from '../transport-provider.js';
import type { ProviderActiveWorkSnapshot, SessionActivityBusyReason } from '../../../shared/session-activity-types.js';
import {
  BACKGROUND_SUBAGENT_WAKE_MODES,
  CONNECTION_MODES,
  normalizeProviderPayload,
  PROVIDER_ERROR_CODES,
  SESSION_OWNERSHIP,
} from '../transport-provider.js';
import {
  SDK_SUBAGENT_DETAIL_KIND,
  SDK_SUBAGENT_PROVIDERS,
  SDK_SUBAGENT_PROVIDER_KINDS,
  SDK_SUBAGENT_SCHEMA_VERSION,
  SDK_SUBAGENT_STATUS,
  buildSdkSubagentSafeDetail,
  makeAgySubagentCanonicalKey,
  type SdkSubagentDetail,
  type SdkSubagentNormalizedStatus,
} from '../../../shared/sdk-subagent-status.js';
import type { AgentMessage, MessageDelta, ToolCallEvent } from '../../../shared/agent-message.js';
import type { ProviderContextPayload } from '../../../shared/context-types.js';
import type { TransportAttachment } from '../../../shared/transport-attachments.js';
import { NATIVE_AGENT_ADMISSION_MODES } from '../../../shared/native-collaboration-policy.js';
import {
  AGY_CLI_BINARY,
  AGY_CLI_FLAG,
  AGY_CLI_PATH_ENV,
  AGY_DEFAULT_MODEL_ID,
  AGY_INDIVIDUAL_QUOTA_ERROR_PREFIX,
  AGY_RESULT_STATUS,
  AGY_SDK_PROVIDER_ID,
  AGY_STEP_STATE,
  AGY_STEP_TYPE,
  AGY_STREAM_EVENT,
} from '../../../shared/agy-agent.js';
import logger from '../../util/logger.js';
import { killProcessTree } from '../../util/kill-process-tree.js';
import { execFileOffMain as execFileAsync } from '../../util/exec-helper.js';
import { gateChildStream } from '../../util/event-loop-backpressure.js';
import { composeMessageSideProviderPrompt, getProviderSystemTextParts } from '../provider-context-routing.js';
import { normalizeTransportCwd, resolveAgyPathForSdk, resolveExecutableForSpawn } from '../transport-paths.js';
import {
  ensureAgyMcpConfigHasImcodesEntry,
  agyMcpEnsureOptionsFromConfig,
  type AgyMcpEnsureResult,
} from '../../daemon/agy-mcp-config.js';
import { confirmChildStop, confirmCapturedChildExit } from '../provider-stop-confirmation.js';
import { IMCODES_MEMORY_MCP_SERVER_NAME } from '../../../shared/memory-mcp-server-name.js';
import { getDefaultMcpServers } from './getDefaultMcpServers.js';
import {
  MEMORY_MCP_PROVIDER_STATUS_REASON,
  MEMORY_MCP_STATUS,
  type MemoryMcpProviderStatusView,
} from '../../../shared/memory-ws.js';
import { recordAgyQuotaActivity, refreshAgyQuotaMetadata } from '../agy-usage-quota.js';
import { AgyHistoryReader, hashAgyPrompt } from '../agy-native-history.js';
import { sessionSystemContractKey, shouldInjectSessionSystemContract } from '../session-system-contract.js';

const MODEL_CACHE_TTL_MS = 10 * 60_000;
const MODEL_PROBE_TIMEOUT_MS = 30_000;
const KILL_GRACE_MS = 2_000;
const STDERR_TAIL_BYTES = 2_048;
const AUTH_FAILURE_PATTERN = /auth|log(?:ged)?\s*in|credential|unauthori[sz]ed|license|permission denied|401\b|403\b/i;
const RATE_LIMIT_PATTERN = /quota|rate.?limit|too many requests|resource.?exhausted|429\b/i;

interface AgyUsage {
  input_tokens?: number;
  output_tokens?: number;
  thinking_tokens?: number;
  cache_read_tokens?: number;
  total_tokens?: number;
}

interface AgySessionState {
  routeId: string;
  cwd: string;
  env?: Record<string, string>;
  mcpEnv?: Record<string, string>;
  model?: string;
  /** agy conversation id; durable resume handle (persisted by the daemon as providerResumeId). */
  conversationId?: string;
  child: ChildProcess | null;
  /** User turns written to stdin that have not produced a `result` yet. */
  inflightTurns: number;
  cancelled: boolean;
  currentMessageId: string | null;
  currentText: string;
  sawToolCall: boolean;
  /** Versioned key for the stable contract delivered to the current agy process. */
  sessionSystemTextInjected?: string;
  stderrTail: string;
  toolSteps: Map<number, string>;
  mayHaveHistoricalQuota: boolean;
  /** A quota result is being checked against durable history; cancellation wins over this read. */
  historyReadInFlight: boolean;
  pendingInputs: Array<{ promptHash: string; sentAt: number }>;
  /** Evidence is reset by the streamed user_input boundary, not send(): inputs can queue. */
  turnEvidence?: {
    conversationId?: string;
    userStepIndex: number;
    latestStepIndex: number;
    completedResponseStepIndex?: number;
    sawError: boolean;
    responseText: string;
  };
  lastStatusSignature?: string;
  latestStepUsage?: AgyUsage;
  turnOutputTokens?: number;
  runtimeSubagentStartedAtByKey?: Map<string, number>;
  runtimeSubagentToolCalls?: Map<string, {
    canonicalKey: string;
    agentName?: string;
    agentPath?: string;
    model?: string;
    prompt?: string;
    startedAtMs: number;
  }>;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function buildAgyMemoryMcpEnv(config: SessionConfig): Record<string, string> | undefined {
  const env = getDefaultMcpServers(config)[IMCODES_MEMORY_MCP_SERVER_NAME]?.env;
  return env && Object.keys(env).length > 0 ? env : undefined;
}

function isAgySubagentTool(name: string): boolean {
  const normalized = name.toLowerCase().replace(/[-_]/g, '');
  return normalized === 'invokesubagent'
    || normalized === 'browsersubagent'
    || normalized === 'managesubagents'
    || normalized === 'subagent'
    || normalized === 'agent';
}

function parseAgySubagentInput(input: unknown): {
  agentName?: string;
  agentPath?: string;
  model?: string;
  prompt?: string;
} {
  const rec = asRecord(input);
  if (Array.isArray(rec.Subagents) && rec.Subagents.length > 0) {
    const first = asRecord(rec.Subagents[0]);
    const role = asString(first.Role) ?? asString(first.role);
    const typeName = asString(first.TypeName) ?? asString(first.type);
    const prompt = asString(first.Prompt) ?? asString(first.prompt);
    const model = asString(first.Model) ?? asString(first.model);
    const names = rec.Subagents.map((s) => {
      const item = asRecord(s);
      return asString(item.Role) ?? asString(item.TypeName) ?? asString(item.role) ?? asString(item.type);
    }).filter(Boolean);
    return {
      agentName: names.length > 1 ? `(${names.length}) ${names.join(', ')}` : (role ?? typeName ?? 'Subagent'),
      agentPath: typeName ?? role,
      model,
      prompt,
    };
  }
  const role = asString(rec.Role) ?? asString(rec.role);
  const typeName = asString(rec.TypeName) ?? asString(rec.type) ?? asString(rec.subagent_type);
  const name = asString(rec.name) ?? asString(rec.Name);
  const prompt = asString(rec.Prompt) ?? asString(rec.prompt) ?? asString(rec.description);
  const model = asString(rec.Model) ?? asString(rec.model);
  return {
    agentName: role ?? typeName ?? name,
    agentPath: typeName ?? role ?? name,
    model,
    prompt,
  };
}

/**
 * Pure builder for the argv of one long-lived `agy` stream-json process.
 * `--dangerously-skip-permissions` is mandatory: stream-json mode has no
 * approval channel, so without it every write tool would stall the turn.
 */
export function buildAgyArgs(opts: { conversationId?: string; model?: string }): string[] {
  return [
    AGY_CLI_FLAG.INPUT_FORMAT, AGY_CLI_FLAG.STREAM_JSON,
    AGY_CLI_FLAG.OUTPUT_FORMAT, AGY_CLI_FLAG.STREAM_JSON,
    AGY_CLI_FLAG.SKIP_PERMISSIONS,
    ...(opts.conversationId ? [AGY_CLI_FLAG.CONVERSATION, opts.conversationId] : []),
    AGY_CLI_FLAG.MODEL, opts.model || AGY_DEFAULT_MODEL_ID,
    // Must stay last: `-p`/`--print` without `=` would swallow the next argv as its prompt.
    AGY_CLI_FLAG.PRINT_STDIN,
  ];
}

/** Parse `agy models` output: `<id> <display name>` per line (tab- or multi-space separated). */
export function parseAgyModelList(stdout: string): ProviderModelList['models'] {
  const models: ProviderModelList['models'] = [];
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = (rawLine.includes('\r') ? (rawLine.split('\r').pop() ?? '') : rawLine).trim();
    if (!line) continue;
    const parts = line.includes('\t') ? line.split('\t') : line.split(/\s{2,}/);
    if (parts.length === 0) continue;
    const modelId = parts[0].trim();
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(modelId)) continue;
    if (modelId.toLowerCase() === 'fetching' || modelId.toLowerCase() === 'models') continue;
    const name = parts.slice(1).join(' ').trim();
    models.push({ id: modelId, ...(name ? { name } : {}) });
  }
  return models;
}

/** Encode one user turn as an `agy` stream-json input line. */
export function encodeAgyUserLine(text: string): string {
  return `${JSON.stringify({ event: AGY_STREAM_EVENT.USER, message: { content: text } })}\n`;
}

/** Resolve the `agy` executable to spawn, honoring `config.binaryPath`, `AGY_CLI_PATH`, candidates, and PATH. */
export function resolveAgyBinary(config?: ProviderConfig | { binaryPath?: string } | null): { executable: string; prependArgs: string[] } {
  const direct = typeof config?.binaryPath === 'string' ? config.binaryPath.trim() : '';
  const raw = direct || process.env[AGY_CLI_PATH_ENV]?.trim() || AGY_CLI_BINARY;
  const resolved = resolveAgyPathForSdk(raw);
  return resolveExecutableForSpawn(resolved);
}

/**
 * Google Antigravity (`agy`) transport. One long-lived
 * `agy --input-format stream-json --output-format stream-json` process per
 * IM.codes session: user turns are appended to stdin (agy runs them in order),
 * `step_update` events stream text/tool progress and `result` ends each turn.
 * Authentication is agy's own login; no API key is handled here.
 */
export class AgySdkProvider implements TransportProvider {
  private readonly historyReader = new AgyHistoryReader();
  readonly id = AGY_SDK_PROVIDER_ID;
  readonly connectionMode = CONNECTION_MODES.LOCAL_SDK;
  readonly sessionOwnership = SESSION_OWNERSHIP.SHARED;

  readonly capabilities: ProviderCapabilities = {
    streaming: true,
    toolCalling: true,
    // Always runs with --dangerously-skip-permissions: there is no approval round-trip.
    approval: false,
    sessionRestore: true,
    multiTurn: true,
    attachments: false,
    // Reasoning effort is part of the model id (`…-high|medium|low`), not a separate knob.
    reasoningEffort: false,
    contextSupport: 'degraded-message-side-context-mapping',
    backgroundSubagentWake: BACKGROUND_SUBAGENT_WAKE_MODES.RUNTIME,
    nativeAgentAdmission: NATIVE_AGENT_ADMISSION_MODES.SESSION_FENCE,
    compact: {
      execution: 'unsupported',
      verified: true,
      completion: 'none',
      cancellation: 'none',
      reason: 'agy stream-json mode exposes no compact command; agy compacts its own context automatically.',
    },
  };

  private config: ProviderConfig | null = null;
  private mcpRegistration: AgyMcpEnsureResult | null = null;
  private readonly sessions = new Map<string, AgySessionState>();
  private readonly deltaCallbacks = new Set<(sessionId: string, delta: MessageDelta) => void>();
  private readonly completeCallbacks = new Set<(sessionId: string, message: AgentMessage) => void>();
  private readonly errorCallbacks = new Set<(sessionId: string, error: ProviderError) => void>();
  private readonly toolCallCallbacks = new Set<(sessionId: string, tool: ToolCallEvent) => void>();
  private readonly sessionInfoCallbacks = new Set<(sessionId: string, info: SessionInfoUpdate) => void>();
  private readonly usageCallbacks = new Set<(sessionId: string, update: ProviderUsageUpdate) => void>();
  private readonly statusCallbacks = new Set<(sessionId: string, status: ProviderStatusUpdate) => void>();
  private modelCache: { at: number; list: ProviderModelList } | null = null;

  getCachedModels(): ProviderModelList | null {
    return this.modelCache?.list ?? null;
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  async connect(config: ProviderConfig): Promise<void> {
    this.config = config;
    this.mcpRegistration = await ensureAgyMcpConfigHasImcodesEntry(agyMcpEnsureOptionsFromConfig(config)).catch((err) => {
      logger.warn({ err }, 'Failed to ensure Antigravity MCP configuration');
      return null;
    });
    const { executable, prependArgs } = this.resolveBinary();
    try {
      await execFileAsync(executable, [...prependArgs, '--help'], { timeout: 15_000, env: this.spawnEnv() });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      // `--help` may exit non-zero on some builds; only a missing/non-executable binary is fatal.
      if (code === 'ENOENT' || code === 'EACCES') {
        throw this.makeError(
          PROVIDER_ERROR_CODES.CONFIG_ERROR,
          `The Antigravity CLI (\`${AGY_CLI_BINARY}\`) was not found. Install it, or set ${AGY_CLI_PATH_ENV}.`,
          false,
        );
      }
    }
  }

  async disconnect(): Promise<void> {
    const states = [...this.sessions.values()];
    this.sessions.clear();
    await Promise.all([this.historyReader.dispose(), ...states.map((state) => this.terminateChild(state))]);
    this.config = null;
  }

  async createSession(config: SessionConfig): Promise<string> {
    const routeId = config.bindExistingKey ?? config.sessionKey;
    const prior = this.sessions.get(routeId);
    const existing = config.fresh ? undefined : prior;
    const state: AgySessionState = {
      routeId,
      cwd: normalizeTransportCwd(config.cwd) ?? existing?.cwd ?? normalizeTransportCwd(process.cwd())!,
      env: config.env ?? existing?.env,
      mcpEnv: buildAgyMemoryMcpEnv(config) ?? existing?.mcpEnv,
      model: (typeof config.agentId === 'string' && config.agentId)
        || (typeof (config as { model?: string }).model === 'string' && (config as { model?: string }).model)
        || existing?.model || AGY_DEFAULT_MODEL_ID,
      conversationId: config.resumeId ?? existing?.conversationId,
      child: existing?.child ?? null,
      inflightTurns: existing?.inflightTurns ?? 0,
      cancelled: false,
      currentMessageId: null,
      currentText: '',
      sawToolCall: false,
      // A resumed conversation may have an old or missing contract. Keep no
      // optimistic marker: the first turn must compare the current payload and
      // re-seed the contract when needed.
      sessionSystemTextInjected: existing?.sessionSystemTextInjected,
      stderrTail: '',
      toolSteps: new Map(),
      mayHaveHistoricalQuota: !!(config.resumeId ?? existing?.conversationId) && !config.fresh,
      historyReadInFlight: existing?.historyReadInFlight ?? false,
      pendingInputs: [],
    };
    if (prior?.child && (config.fresh || prior.conversationId !== state.conversationId)) {
      await this.terminateChild(prior);
      state.child = null;
      state.inflightTurns = 0;
    }
    if (existing?.child && existing.child === state.child) {
      existing.cwd = state.cwd;
      existing.env = state.env;
      existing.mcpEnv = state.mcpEnv;
      existing.model = state.model;
      return routeId;
    }
    this.sessions.set(routeId, state);
    if (state.conversationId) {
      this.emitSessionInfo(routeId, { resumeId: state.conversationId, ...(state.model ? { model: state.model } : {}) });
    }
    return routeId;
  }

  async endSession(sessionId: string): Promise<void> {
    const state = this.sessions.get(sessionId);
    this.sessions.delete(sessionId);
    if (state) await this.terminateChild(state);
  }

  async detachSession(sessionId: string): Promise<void> {
    // Keep agy's durable conversation; only drop local routing and the process.
    await this.endSession(sessionId);
  }

  async restoreSession(sessionId: string): Promise<boolean> {
    const state = this.sessions.get(sessionId);
    return !!state?.conversationId;
  }

  // ── Messaging ──────────────────────────────────────────────────────────────

  async send(
    sessionId: string,
    payload: string | ProviderContextPayload,
    attachments?: TransportAttachment[],
    extraSystemPrompt?: string,
  ): Promise<void> {
    recordAgyQuotaActivity();
    const state = this.sessions.get(sessionId);
    if (!state) throw this.makeError(PROVIDER_ERROR_CODES.SESSION_NOT_FOUND, `Session ${sessionId} not found`, false);
    const normalized = normalizeProviderPayload(payload, attachments, extraSystemPrompt);
    const sessionSystemText = getProviderSystemTextParts(normalized).sessionSystemText;
    const sessionContractKey = sessionSystemContractKey(sessionSystemText);
    const includeSessionSystemText = shouldInjectSessionSystemContract(
      state.sessionSystemTextInjected,
      sessionSystemText,
    );
    const prompt = composeMessageSideProviderPrompt(normalized, { includeSessionSystemText });
    if (!prompt.trim()) {
      throw this.makeError(PROVIDER_ERROR_CODES.PROVIDER_ERROR, 'Cannot send an empty message to agy', false);
    }

    const child = this.ensureChild(sessionId, state);
    if (!child.stdin || child.stdin.destroyed || !child.stdin.writable) {
      state.child = null;
      throw this.makeError(PROVIDER_ERROR_CODES.CONNECTION_LOST, 'agy process is not accepting input', true);
    }
    state.cancelled = false;
    if (includeSessionSystemText) state.sessionSystemTextInjected = sessionContractKey;
    state.inflightTurns += 1;
    const input = { promptHash: hashAgyPrompt(prompt), sentAt: Date.now() };
    state.pendingInputs.push(input);
    this.emitStatus(sessionId, state, { status: 'thinking', label: 'Thinking...' });
    // Appending while a turn is running is intentional: agy queues user events and runs them in order.
    child.stdin.write(encodeAgyUserLine(prompt), (err) => {
      if (!err || state.child !== child || state.cancelled || this.sessions.get(sessionId) !== state) return;
      const index = state.pendingInputs.indexOf(input);
      if (index >= 0) state.pendingInputs.splice(index, 1);
      state.inflightTurns = Math.max(0, state.inflightTurns - 1);
      this.emitStatus(sessionId, state, { status: null, label: null });
      this.emitError(sessionId, PROVIDER_ERROR_CODES.CONNECTION_LOST, 'Failed to write to the agy process', true);
    });
  }

  async cancel(sessionId: string): Promise<void> {
    const state = this.sessions.get(sessionId);
    if (!state) return;
    state.cancelled = true;
    if (!state.child || state.child.killed) return;
    this.emitStatus(sessionId, state, { status: null, label: null });
    await this.terminateChild(state);
    // The next send resumes the same conversation via --conversation; agy persisted it.
    this.emitError(sessionId, PROVIDER_ERROR_CODES.CANCELLED, 'Turn cancelled', true);
  }

  cancelAndWait(sessionId: string): Promise<void> {
    const state = this.sessions.get(sessionId);
    if (!state) return Promise.reject(new Error(`Session ${sessionId} not found`));
    const capturedChild = state.child;
    if (!capturedChild || capturedChild.exitCode != null) {
      // A physical exit does not authorize a late asynchronous history result.
      state.cancelled = true;
      state.child = null;
      this.resetTurnState(state);
      this.emitStatus(sessionId, state, { status: null, label: null });
      return Promise.resolve();
    }
    return confirmChildStop(capturedChild, () => this.cancel(sessionId), () => this.sessions.get(sessionId) === state);
  }

  setSessionAgentId(sessionId: string, agentId: string): void {
    const state = this.sessions.get(sessionId);
    if (!state || !agentId || state.model === agentId) return;
    state.model = agentId;
    // --model is a launch flag: drop an idle process so the next send resumes with the new model.
    if (state.child && state.inflightTurns === 0) void this.terminateChild(state);
    if (state.conversationId) this.emitSessionInfo(sessionId, { resumeId: state.conversationId, model: agentId });
  }

  refreshSessionSystemText(sessionId: string): void {
    const state = this.sessions.get(sessionId);
    if (!state) return;
    state.sessionSystemTextInjected = undefined;
  }

  // ── Callbacks ──────────────────────────────────────────────────────────────

  onDelta(cb: (sessionId: string, delta: MessageDelta) => void): () => void {
    this.deltaCallbacks.add(cb);
    return () => { this.deltaCallbacks.delete(cb); };
  }

  onComplete(cb: (sessionId: string, message: AgentMessage) => void): () => void {
    this.completeCallbacks.add(cb);
    return () => { this.completeCallbacks.delete(cb); };
  }

  onError(cb: (sessionId: string, error: ProviderError) => void): () => void {
    this.errorCallbacks.add(cb);
    return () => { this.errorCallbacks.delete(cb); };
  }

  onToolCall(cb: (sessionId: string, tool: ToolCallEvent) => void): void {
    this.toolCallCallbacks.add(cb);
  }

  onSessionInfo(cb: (sessionId: string, info: SessionInfoUpdate) => void): () => void {
    this.sessionInfoCallbacks.add(cb);
    return () => { this.sessionInfoCallbacks.delete(cb); };
  }

  onUsage(cb: (sessionId: string, update: ProviderUsageUpdate) => void): () => void {
    this.usageCallbacks.add(cb);
    return () => { this.usageCallbacks.delete(cb); };
  }

  onStatus(cb: (sessionId: string, status: ProviderStatusUpdate) => void): () => void {
    this.statusCallbacks.add(cb);
    return () => { this.statusCallbacks.delete(cb); };
  }

  getActiveWorkSnapshot(sessionId: string): ProviderActiveWorkSnapshot | null {
    const state = this.sessions.get(sessionId);
    if (!state) return null;
    const activeToolCount = state.toolSteps.size;
    const inflight = state.inflightTurns > 0;
    const activeWorkCount = (inflight ? 1 : 0) + activeToolCount;
    const busyReasons: SessionActivityBusyReason[] = [];
    if (inflight) busyReasons.push('provider_wait');
    if (activeToolCount > 0) busyReasons.push('open_tool_call');
    return {
      status: 'current',
      activeWorkCount,
      activeToolCount,
      busyReasons,
      providerDiagnosticGeneration: state.conversationId ?? null,
      updatedAt: Date.now(),
    };
  }

  // ── Models ─────────────────────────────────────────────────────────────────

  async listModels(force = false): Promise<ProviderModelList> {
    const now = Date.now();
    if (!force && this.modelCache && now - this.modelCache.at < MODEL_CACHE_TTL_MS) return this.modelCache.list;
    const { executable, prependArgs } = this.resolveBinary();
    try {
      const { stdout } = await execFileAsync(executable, [...prependArgs, 'models'], {
        timeout: MODEL_PROBE_TIMEOUT_MS,
        env: this.spawnEnv(),
        maxBuffer: 1024 * 1024,
      });
      const models = parseAgyModelList(stdout);
      const list: ProviderModelList = models.length > 0
        ? { models, defaultModel: models.some((model) => model.id === AGY_DEFAULT_MODEL_ID) ? AGY_DEFAULT_MODEL_ID : models[0]?.id, isAuthenticated: true }
        : (this.modelCache?.list?.models?.length
          ? this.modelCache.list
          : { models: [], isAuthenticated: false, error: 'agy returned no models. Run `agy` once to sign in.' });
      if (models.length > 0) this.modelCache = { at: now, list };
      return list;
    } catch (err) {
      if (this.modelCache?.list?.models?.length) {
        return this.modelCache.list;
      }
      const code = (err as NodeJS.ErrnoException).code;
      const error = code === 'ENOENT'
        ? `The Antigravity CLI (\`${AGY_CLI_BINARY}\`) was not found.`
        : 'Could not list Antigravity models. Run `agy` once to sign in.';
      return { models: [], isAuthenticated: false, error };
    }
  }

  getMemoryMcpStatus(): MemoryMcpProviderStatusView {
    if (this.mcpRegistration?.degraded) {
      return {
        providerId: this.id,
        status: MEMORY_MCP_STATUS.DEGRADED,
        connected: true,
        degradedReasons: [
          this.mcpRegistration.reason ?? MEMORY_MCP_PROVIDER_STATUS_REASON.MCP_REGISTRATION_FAILED,
        ],
      };
    }
    return {
      providerId: this.id,
      status: MEMORY_MCP_STATUS.READY,
      connected: true,
      degradedReasons: [],
    };
  }

  getSessionDiagnostics(sessionId: string): Record<string, unknown> | null {
    const state = this.sessions.get(sessionId);
    if (!state) return null;
    return {
      alive: !!state.child && !state.child.killed,
      inflightTurns: state.inflightTurns,
      hasConversation: !!state.conversationId,
      model: state.model ?? null,
    };
  }
  // ── Process management ─────────────────────────────────────────────────────

  private resolveBinary(): { executable: string; prependArgs: string[] } {
    return resolveAgyBinary(this.config);
  }

  private spawnEnv(...extra: (Record<string, string> | undefined)[]): NodeJS.ProcessEnv {
    const mergedExtra: Record<string, string> = {};
    for (const e of extra) {
      if (e) Object.assign(mergedExtra, e);
    }
    const env = { ...process.env, ...(this.config?.env as Record<string, string> | undefined), ...mergedExtra };
    const pathKey = process.platform === 'win32'
      ? Object.keys(env).find((k) => k.toUpperCase() === 'PATH') ?? 'Path'
      : 'PATH';
    const currentPath = env[pathKey] || '';
    const delimiter = process.platform === 'win32' ? ';' : ':';
    const home = process.env.HOME;
    const additionalDirs = [
      home ? path.join(home, '.local', 'bin') : undefined,
      home ? path.join(home, '.gemini', 'antigravity-cli', 'bin') : undefined,
      home ? path.join(home, '.npm-global', 'bin') : undefined,
      '/usr/local/bin',
      '/opt/homebrew/bin',
      '/usr/bin',
      '/bin',
    ].filter((dir): dir is string => !!dir && !currentPath.split(delimiter).includes(dir));
    if (additionalDirs.length > 0) {
      env[pathKey] = [...additionalDirs, currentPath].filter(Boolean).join(delimiter);
    }
    return env;
  }

  private ensureChild(sessionId: string, state: AgySessionState): ChildProcess {
    if (state.child && !state.child.killed && state.child.exitCode === null) return state.child;
    const { executable, prependArgs } = this.resolveBinary();
    const args = [...prependArgs, ...buildAgyArgs({ conversationId: state.conversationId, model: state.model })];
    const child = spawn(executable, args, {
      cwd: state.cwd,
      env: this.spawnEnv(state.env, state.mcpEnv),
      stdio: ['pipe', 'pipe', 'pipe'],
      // Own process group so killProcessTree can reap agy's tool subprocesses.
      detached: process.platform !== 'win32',
    });
    state.child = child;
    state.stderrTail = '';
    // A restarted agy process cannot be assumed to retain the contract marker;
    // force the next turn to carry the current session-level instructions.
    state.sessionSystemTextInjected = undefined;

    child.stderr?.on('data', (chunk: Buffer) => {
      state.stderrTail = (state.stderrTail + chunk.toString('utf8')).slice(-STDERR_TAIL_BYTES);
    });
    child.stdin?.on('error', () => { /* surfaced through the exit handler */ });
    const rl = readline.createInterface({ input: gateChildStream(child.stdout!) });
    // A read-only recovery may await IPC. Keep frames/results in wire order so
    // the next turn cannot overwrite the evidence of the one being recovered.
    let output = Promise.resolve();
    rl.on('line', (line) => {
      output = output.then(async () => {
        if (state.child !== child || child.exitCode !== null || this.sessions.get(sessionId) !== state) return;
        await this.handleLine(sessionId, state, line);
      }).catch(() => {
        // Callback exceptions must not leave the output chain permanently rejected.
        logger.warn({ sessionId }, 'Failed to handle agy output');
      });
    });
    child.once('error', (err) => {
      if (state.child !== child) return;
      const detail = `${(err as Error)?.message ?? ''} ${state.stderrTail}`.trim();
      const authFailure = AUTH_FAILURE_PATTERN.test(detail);
      state.child = null;
      state.sessionSystemTextInjected = undefined;
      this.resetTurnState(state);
      this.emitStatus(sessionId, state, { status: null, label: null });
      const code = (err as NodeJS.ErrnoException).code;
      this.emitError(
        sessionId,
        authFailure
          ? PROVIDER_ERROR_CODES.AUTH_FAILED
          : code === 'ENOENT' ? PROVIDER_ERROR_CODES.CONFIG_ERROR : PROVIDER_ERROR_CODES.PROVIDER_ERROR,
        authFailure
          ? 'Antigravity authentication is required. Run `agy` once to sign in.'
          : code === 'ENOENT' ? `The Antigravity CLI (\`${AGY_CLI_BINARY}\`) was not found.` : 'Failed to start the agy process',
        !authFailure && code !== 'ENOENT',
      );
    });
    child.once('exit', (code, signal) => {
      confirmCapturedChildExit(child);
      rl.close();
      if (state.child !== child || this.sessions.get(sessionId) !== state) return;
      const hadTurns = state.inflightTurns > 0;
      const historyReadInFlight = state.historyReadInFlight;
      const tail = state.stderrTail.trim();
      state.sessionSystemTextInjected = undefined;
      this.resetTurnState(state);
      this.emitStatus(sessionId, state, { status: null, label: null });
      if (state.cancelled || !hadTurns || historyReadInFlight) return;
      logger.warn({ sessionId, code, signal }, 'agy process exited with turns in flight');
      const authFailure = AUTH_FAILURE_PATTERN.test(tail);
      this.emitError(
        sessionId,
        authFailure ? PROVIDER_ERROR_CODES.AUTH_FAILED : PROVIDER_ERROR_CODES.CONNECTION_LOST,
        authFailure
          ? 'Antigravity authentication is required. Run `agy` once to sign in.'
          : 'The agy process exited before finishing the turn',
        !authFailure,
      );
    });
    return child;
  }

  private clearOpenToolSteps(sessionId: string, state: AgySessionState): void {
    if (state.toolSteps.size === 0) return;
    for (const [, id] of state.toolSteps) {
      const subagentInfo = state.runtimeSubagentToolCalls?.get(id);
      let detail: SdkSubagentDetail | undefined;
      if (subagentInfo) {
        detail = buildSdkSubagentSafeDetail({
          kind: SDK_SUBAGENT_DETAIL_KIND,
          summary: subagentInfo.agentName ? `Antigravity sub-agent ${subagentInfo.agentName}` : 'Antigravity sub-agent',
          input: {
            action: 'invoke_subagent',
            ...(subagentInfo.prompt ? { description: subagentInfo.prompt } : {}),
          },
          meta: {
            isSdkSubagent: true,
            schemaVersion: SDK_SUBAGENT_SCHEMA_VERSION,
            provider: SDK_SUBAGENT_PROVIDERS.AGY_SDK,
            providerKind: SDK_SUBAGENT_PROVIDER_KINDS.AGY_RUNTIME_AGENT,
            canonicalKey: subagentInfo.canonicalKey,
            normalizedStatus: SDK_SUBAGENT_STATUS.COMPLETE,
            rawStatus: 'complete',
            active: false,
            terminal: true,
            parentSessionId: state.conversationId ?? sessionId,
            parentToolUseId: id,
            parentItemId: id,
            agentPath: subagentInfo.agentPath ?? id,
            ...(subagentInfo.agentName ? { agentName: subagentInfo.agentName } : {}),
            ...(subagentInfo.model ? { model: subagentInfo.model } : {}),
            startedAtMs: subagentInfo.startedAtMs,
            backgrounded: true,
          },
        }, { allowRaw: false });
        state.runtimeSubagentToolCalls?.delete(id);
      }
      const tool: ToolCallEvent = {
        id,
        name: subagentInfo ? 'Agent' : 'tool',
        status: 'complete',
        ...(detail ? { detail } : {}),
      };
      for (const cb of this.toolCallCallbacks) cb(sessionId, tool);
    }
    state.toolSteps.clear();
  }

  private resetTurnState(state: AgySessionState): void {
    state.inflightTurns = 0;
    state.pendingInputs = [];
    state.historyReadInFlight = false;
    state.turnEvidence = undefined;
    state.currentMessageId = null;
    state.currentText = '';
    state.sawToolCall = false;
    state.latestStepUsage = undefined;
    state.turnOutputTokens = undefined;
    this.clearOpenToolSteps(state.routeId, state);
  }

  private async terminateChild(state: AgySessionState): Promise<void> {
    const child = state.child;
    state.child = null;
    this.resetTurnState(state);
    this.emitStatus(state.routeId, state, { status: null, label: null });
    if (!child) return;
    try { child.stdin?.end(); } catch { /* already closed */ }
    await killProcessTree(child, { gracefulMs: KILL_GRACE_MS, ownsProcessGroup: process.platform !== 'win32' });
  }

  // ── Stream parsing ─────────────────────────────────────────────────────────

  private handleLine(sessionId: string, state: AgySessionState, line: string): void | Promise<void> {
    const trimmed = line.trim();
    if (!trimmed) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return; // agy prints non-JSON diagnostics (e.g. `error: …`) on the same stream
    }
    const event = asRecord(parsed);
    switch (event.event) {
      case AGY_STREAM_EVENT.INIT:
        this.handleInit(sessionId, state, asRecord(event));
        return;
      case AGY_STREAM_EVENT.STEP_UPDATE:
        this.handleStep(sessionId, state, asRecord(event.step_update));
        return;
      case AGY_STREAM_EVENT.RESULT:
        return this.handleResult(sessionId, state, asRecord(event.result));
      default:
        return;
    }
  }

  private noteConversationId(sessionId: string, state: AgySessionState, id: string | undefined): void {
    if (!id || state.conversationId === id) return;
    state.conversationId = id;
    this.emitSessionInfo(sessionId, { resumeId: id, ...(state.model ? { model: state.model } : {}) });
  }

  private handleInit(sessionId: string, state: AgySessionState, event: Record<string, unknown>): void {
    this.noteConversationId(sessionId, state, asString(event.conversation_id));
  }

  private syncAgyManagedSubagents(sessionId: string, state: AgySessionState, output: string): void {
    try {
      const parsed = JSON.parse(output);
      const items = Array.isArray(parsed) ? parsed : (Array.isArray((parsed as Record<string, unknown>)?.subagents) ? (parsed as Record<string, unknown>).subagents : null);
      if (!Array.isArray(items)) return;
      for (const item of items) {
        if (!item || typeof item !== 'object') continue;
        const subagent = item as Record<string, unknown>;
        const conversationId = asString(subagent.conversationId)
          ?? asString(subagent.conversation_id)
          ?? asString(subagent.id);
        if (!conversationId) continue;
        const role = asString(subagent.role) ?? asString(subagent.Role);
        const type = asString(subagent.type) ?? asString(subagent.TypeName);
        const agentName = role ?? type ?? 'Subagent';
        const rawState = (asString(subagent.state) ?? 'running').toLowerCase();
        const stateDetail = asString(subagent.stateDetail) ?? asString(subagent.state_detail);
        const canonicalKey = makeAgySubagentCanonicalKey(state.conversationId ?? state.routeId, conversationId);

        const normalizedStatus: SdkSubagentNormalizedStatus =
          /^(completed|complete|idle|done|success)$/.test(rawState)
            ? SDK_SUBAGENT_STATUS.COMPLETE
            : /^(failed|error|errored)$/.test(rawState)
              ? SDK_SUBAGENT_STATUS.ERROR
              : /^(canceling|canceled|cancelled|interrupted|stopped)$/.test(rawState)
                ? SDK_SUBAGENT_STATUS.INTERRUPTED
                : SDK_SUBAGENT_STATUS.RUNNING;
        const terminal = normalizedStatus === SDK_SUBAGENT_STATUS.COMPLETE
          || normalizedStatus === SDK_SUBAGENT_STATUS.ERROR
          || normalizedStatus === SDK_SUBAGENT_STATUS.INTERRUPTED;

        const startedAtByKey = state.runtimeSubagentStartedAtByKey ??= new Map<string, number>();
        const startedAtMs = startedAtByKey.get(canonicalKey) ?? Date.now();
        if (!terminal) startedAtByKey.set(canonicalKey, startedAtMs);

        const detail = buildSdkSubagentSafeDetail({
          kind: SDK_SUBAGENT_DETAIL_KIND,
          summary: `Antigravity sub-agent ${agentName}`,
          input: {
            action: 'agy-manage-subagents',
            ...(stateDetail ? { description: stateDetail } : {}),
          },
          ...(stateDetail ? { output: stateDetail } : {}),
          meta: {
            isSdkSubagent: true,
            schemaVersion: SDK_SUBAGENT_SCHEMA_VERSION,
            provider: SDK_SUBAGENT_PROVIDERS.AGY_SDK,
            providerKind: SDK_SUBAGENT_PROVIDER_KINDS.AGY_RUNTIME_AGENT,
            canonicalKey,
            normalizedStatus,
            rawStatus: rawState,
            active: !terminal,
            terminal,
            parentSessionId: state.conversationId ?? sessionId,
            parentItemId: conversationId,
            agentPath: conversationId,
            agentName,
            startedAtMs,
            backgrounded: true,
          },
        }, { allowRaw: false });

        const subagentTool: ToolCallEvent = {
          id: canonicalKey,
          name: 'Agent',
          status: terminal ? (normalizedStatus === SDK_SUBAGENT_STATUS.COMPLETE ? 'complete' : 'error') : 'running',
          ...(detail.input ? { input: detail.input } : {}),
          ...(detail.output ? { output: detail.output } : {}),
          detail,
        };
        for (const cb of this.toolCallCallbacks) cb(sessionId, subagentTool);
      }
    } catch {
      // Ignore non-JSON output
    }
  }

  private handleStep(sessionId: string, state: AgySessionState, step: Record<string, unknown>): void {
    this.noteConversationId(sessionId, state, asString(step.conversation_id));
    if (state.cancelled) return;
    const stepType = asString(step.step_type);
    const stepState = asString(step.state);

    const stepIndex = asNumber(step.step_index);
    const prefix = state.conversationId ?? state.routeId;
    const targetMessageId = stepIndex !== undefined
      ? `${prefix}:step:${stepIndex}`
      : (state.currentMessageId ?? randomUUID());

    if (stepType === AGY_STEP_TYPE.USER_INPUT) {
      // An old DONE response (or result.response alone) is not evidence for this turn.
      state.turnEvidence = stepIndex !== undefined && Number.isInteger(stepIndex) && stepIndex >= 0
        ? { conversationId: state.conversationId, userStepIndex: stepIndex, latestStepIndex: stepIndex, sawError: false, responseText: '' }
        : undefined;
    }
    const evidence = state.turnEvidence;
    if (evidence) {
      if (stepType === AGY_STEP_TYPE.AGENT_RESPONSE && stepIndex !== undefined && stepIndex > evidence.userStepIndex) {
        // result.response may be the final response or all assistant steps in a tool turn.
        evidence.responseText += asString(step.text_delta) ?? '';
      }
      const errorDetails = step.error_details;
      const hasErrorDetails = typeof errorDetails === 'string'
        ? !!errorDetails.trim()
        : !!errorDetails && typeof errorDetails === 'object' && Object.keys(errorDetails).length > 0;
      if (stepType === AGY_STEP_TYPE.SYSTEM_ERROR || /^(ERROR|FAILED|CANCELLED)$/i.test(stepState ?? '') || hasErrorDetails) {
        evidence.sawError = true;
      }
      if (stepIndex === undefined || !Number.isInteger(stepIndex) || stepIndex <= evidence.userStepIndex) {
        evidence.completedResponseStepIndex = undefined;
      } else if (stepIndex >= evidence.latestStepIndex) {
        evidence.latestStepIndex = stepIndex;
        evidence.completedResponseStepIndex = stepType === AGY_STEP_TYPE.AGENT_RESPONSE && stepState === AGY_STEP_STATE.DONE
          ? stepIndex
          : undefined;
      }
    }

    const stepUsageRecord = asRecord(step.usage);
    const inputTokens = asNumber(stepUsageRecord.input_tokens);
    const outputTokens = asNumber(stepUsageRecord.output_tokens);
    const cacheTokens = asNumber(stepUsageRecord.cache_read_tokens);
    if (inputTokens !== undefined || outputTokens !== undefined) {
      const stepUsage: AgyUsage = {
        ...(inputTokens !== undefined ? { input_tokens: inputTokens } : {}),
        ...(outputTokens !== undefined ? { output_tokens: outputTokens } : {}),
        ...(cacheTokens !== undefined ? { cache_read_tokens: cacheTokens } : {}),
      };
      state.latestStepUsage = stepUsage;
      if (outputTokens !== undefined) {
        state.turnOutputTokens = (state.turnOutputTokens ?? 0) + outputTokens;
      }
      const usageMessageId = state.currentMessageId ?? targetMessageId;
      this.emitUsage(sessionId, state, usageMessageId, stepUsage, false);
    }

    if (stepType === AGY_STEP_TYPE.AGENT_RESPONSE) {
      const text = asString(step.text_delta);
      // The DONE frame carries a trailing "\n" separator, not user-visible text,
      // but only skip if the delta is actually empty/whitespace-only.
      if (!text || (stepState === AGY_STEP_STATE.DONE && !text.trim())) return;
      this.emitStatus(sessionId, state, { status: 'streaming', label: null });
      if (state.currentMessageId !== targetMessageId) {
        // If the ID changed only because conversationId was learned mid-turn,
        // preserve the accumulated text so the streaming prefix does not flicker/reset.
        const onlyPrefixChanged = Boolean(
          state.currentMessageId
          && stepIndex !== undefined
          && state.currentMessageId.endsWith(`:step:${stepIndex}`)
        );
        state.currentMessageId = targetMessageId;
        if (!onlyPrefixChanged) {
          state.currentText = '';
        }
      }
      state.currentText += text;
      // Transport relay and web ChatView render delta.delta directly as the display
      // text for this messageId, so delta.delta MUST be the cumulative running total.
      const delta: MessageDelta = {
        messageId: state.currentMessageId,
        type: 'text',
        delta: state.currentText,
        role: 'assistant',
      };
      for (const cb of this.deltaCallbacks) cb(sessionId, delta);
      return;
    }

    if (stepType === AGY_STEP_TYPE.TOOL) {
      const stepIndex = asNumber(step.step_index) ?? -1;
      const info = asRecord(step.tool_info);
      const name = asString(step.tool_name) ?? asString(info.name) ?? 'tool';
      let id = state.toolSteps.get(stepIndex);
      if (!id) {
        id = `${state.conversationId ?? state.routeId}:${stepIndex}`;
        state.toolSteps.set(stepIndex, id);
      }
      state.sawToolCall = true;
      const done = stepState === AGY_STEP_STATE.DONE;
      const output = asString(info.output);
      const tool: ToolCallEvent = {
        id,
        name,
        status: done ? 'complete' : 'running',
        input: info.parameters,
        ...(done && output !== undefined ? { output } : {}),
      };

      if (isAgySubagentTool(name)) {
        const inputParsed = parseAgySubagentInput(info.parameters);
        const existing = state.runtimeSubagentToolCalls?.get(id);
        const agentName = existing?.agentName ?? inputParsed.agentName;
        const agentPath = existing?.agentPath ?? inputParsed.agentPath ?? id;
        const model = existing?.model ?? inputParsed.model ?? state.model;
        const prompt = existing?.prompt ?? inputParsed.prompt;
        const canonicalKey = existing?.canonicalKey
          ?? makeAgySubagentCanonicalKey(state.conversationId ?? state.routeId, id);

        const startedAtByKey = state.runtimeSubagentStartedAtByKey ??= new Map<string, number>();
        const startedAtMs = existing?.startedAtMs ?? startedAtByKey.get(canonicalKey) ?? Date.now();
        if (!done && !existing) {
          startedAtByKey.set(canonicalKey, startedAtMs);
          const toolCalls = state.runtimeSubagentToolCalls ??= new Map();
          toolCalls.set(id, {
            canonicalKey,
            agentName,
            agentPath,
            model,
            prompt,
            startedAtMs,
          });
        }
        const isError = Boolean(
          done && output && (
            output.toLowerCase().includes('error:')
            || output.toLowerCase().startsWith('error')
            || output.toLowerCase().includes('failed')
          )
        );
        const normalizedStatus: SdkSubagentNormalizedStatus = !done
          ? SDK_SUBAGENT_STATUS.RUNNING
          : isError
            ? SDK_SUBAGENT_STATUS.ERROR
            : SDK_SUBAGENT_STATUS.COMPLETE;

        const detail = buildSdkSubagentSafeDetail({
          kind: SDK_SUBAGENT_DETAIL_KIND,
          summary: agentName ? `Antigravity sub-agent ${agentName}` : 'Antigravity sub-agent',
          input: {
            action: name,
            ...(prompt ? { description: prompt } : {}),
          },
          ...(done && output !== undefined ? { output } : {}),
          meta: {
            isSdkSubagent: true,
            schemaVersion: SDK_SUBAGENT_SCHEMA_VERSION,
            provider: SDK_SUBAGENT_PROVIDERS.AGY_SDK,
            providerKind: SDK_SUBAGENT_PROVIDER_KINDS.AGY_RUNTIME_AGENT,
            canonicalKey,
            normalizedStatus,
            rawStatus: !done ? 'running' : isError ? 'error' : 'complete',
            active: !done,
            terminal: done,
            parentSessionId: state.conversationId ?? sessionId,
            parentToolUseId: id,
            parentItemId: id,
            agentPath,
            ...(agentName ? { agentName } : {}),
            ...(model ? { model } : {}),
            startedAtMs,
            backgrounded: true,
          },
        }, { allowRaw: false });
        tool.detail = detail;
      }

      for (const cb of this.toolCallCallbacks) cb(sessionId, tool);

      if (done && name === 'manage_subagents' && output) {
        this.syncAgyManagedSubagents(sessionId, state, output);
      }

      if (done) {
        state.toolSteps.delete(stepIndex);
        this.emitStatus(sessionId, state, {
          status: state.toolSteps.size > 0 ? 'tool_running' : 'thinking',
          label: state.toolSteps.size > 0 ? 'Running tool...' : 'Thinking...',
        });
      } else {
        this.emitStatus(sessionId, state, {
          status: 'tool_running',
          label: `Running ${name}...`,
        });
      }
    }
  }

  private async handleResult(sessionId: string, state: AgySessionState, result: Record<string, unknown>): Promise<void> {
    const input = state.pendingInputs.shift();
    const child = state.child;
    let recovered = false;
    const error = asString(result.error) ?? '';
    if (input && !state.cancelled && result.status === AGY_RESULT_STATUS.ERROR
      && error.startsWith(AGY_INDIVIDUAL_QUOTA_ERROR_PREFIX) && !asString(result.response)?.trim()
      && state.conversationId && state.conversationId === asString(result.conversation_id)
      && !state.turnEvidence?.sawError && state.toolSteps.size === 0) {
      const env = this.spawnEnv(state.env, state.mcpEnv);
      const home = env.HOME || env.USERPROFILE;
      state.historyReadInFlight = true;
      let response: { userStepIndex: number; responseStepIndex: number; text: string } | undefined;
      try {
        response = home ? await this.historyReader.read({
          home, conversationId: state.conversationId, ...input, resultAt: Date.now(), error,
        }) : undefined;
      } finally {
        state.historyReadInFlight = false;
      }
      // Stop/end/rebind wins over a late reader result. Never complete another instance.
      if (state.cancelled || this.sessions.get(sessionId) !== state || state.child !== child) return;
      if (response && (!state.turnEvidence || state.turnEvidence.userStepIndex === response.userStepIndex)) {
        recovered = true;
        state.currentMessageId = `${state.conversationId}:step:${response.responseStepIndex}`;
        result = { ...result, response: response.text };
      }
    }
    this.noteConversationId(sessionId, state, asString(result.conversation_id));
    state.inflightTurns = Math.max(0, state.inflightTurns - 1);
    const messageId = state.currentMessageId ?? randomUUID();
    const streamed = state.currentText;
    const response = asString(result.response)?.trimEnd();
    const evidence = state.turnEvidence;
    // AG can aggregate a quota error from an older conversation step into the
    // terminal result of a later successful turn (upstream #1048). Do not trust
    // nonempty response text alone: partial output on a real failure is common.
    // Require a new user boundary, a matching final DONE response, no subsequent
    // step/open tool or current error, and the same conversation. No replay,
    // conversation reset, quota probe or suppression of an unproven error.
    const historicalQuotaResult = recovered || result.status === AGY_RESULT_STATUS.ERROR
      && state.mayHaveHistoricalQuota
      && (asString(result.error) ?? '').startsWith(AGY_INDIVIDUAL_QUOTA_ERROR_PREFIX)
      && !!response?.trim()
      && !!evidence
      && (response === streamed.trimEnd() || response === evidence.responseText.trimEnd())
      && !!evidence.conversationId
      && evidence.conversationId === asString(result.conversation_id)
      && evidence.completedResponseStepIndex !== undefined
      && evidence.completedResponseStepIndex === evidence.latestStepIndex
      && !evidence.sawError
      && state.toolSteps.size === 0;
    state.turnEvidence = undefined;
    const sawTool = state.sawToolCall;
    state.currentMessageId = null;
    state.currentText = '';
    state.sawToolCall = false;
    this.clearOpenToolSteps(sessionId, state);
    this.emitStatus(sessionId, state, { status: null, label: null });
    if (state.cancelled) return;

    const resultUsage = asRecord(result.usage) as AgyUsage;
    const turnUsage: AgyUsage = {
      ...(state.latestStepUsage?.input_tokens !== undefined || asNumber(resultUsage.input_tokens) !== undefined
        ? { input_tokens: state.latestStepUsage?.input_tokens ?? asNumber(resultUsage.input_tokens) }
        : {}),
      ...(state.turnOutputTokens !== undefined || state.latestStepUsage?.output_tokens !== undefined || asNumber(resultUsage.output_tokens) !== undefined
        ? { output_tokens: state.turnOutputTokens ?? state.latestStepUsage?.output_tokens ?? asNumber(resultUsage.output_tokens) }
        : {}),
      ...(state.latestStepUsage?.cache_read_tokens !== undefined || asNumber(resultUsage.cache_read_tokens) !== undefined
        ? { cache_read_tokens: state.latestStepUsage?.cache_read_tokens ?? asNumber(resultUsage.cache_read_tokens) }
        : {}),
    };
    state.latestStepUsage = undefined;
    state.turnOutputTokens = undefined;

    this.emitUsage(sessionId, state, messageId, turnUsage, true);

    if (result.status !== AGY_RESULT_STATUS.SUCCESS && !historicalQuotaResult) {
      const message = asString(result.error) ?? 'agy turn failed';
      if (message.startsWith(AGY_INDIVIDUAL_QUOTA_ERROR_PREFIX)) state.mayHaveHistoricalQuota = true;
      const code = AUTH_FAILURE_PATTERN.test(message)
        ? PROVIDER_ERROR_CODES.AUTH_FAILED
        : RATE_LIMIT_PATTERN.test(message)
          ? PROVIDER_ERROR_CODES.RATE_LIMITED
          : PROVIDER_ERROR_CODES.PROVIDER_ERROR;
      this.emitError(sessionId, code, message, code !== PROVIDER_ERROR_CODES.AUTH_FAILED);
      return;
    }

    // Authoritative complete response from agy. If no tool was called, response is
    // the single complete turn response. Prefer it over potentially truncated streaming text.
    // When tools were called (multi-step), preserve the streamed step text unless empty.
    const content = ((recovered || !sawTool) && response && response.trim()
      ? response
      : (streamed && streamed.trim() ? streamed : (response && response.trim() ? response : streamed))
    ).trimEnd();
    if (!content && !sawTool) {
      this.emitError(sessionId, PROVIDER_ERROR_CODES.PROVIDER_ERROR, 'agy finished without producing a response', true);
      return;
    }
    // If final content has text that was not fully streamed, emit a catch-up delta before complete
    if (content && content !== streamed) {
      const catchupDelta: MessageDelta = {
        messageId,
        type: 'text',
        delta: content,
        role: 'assistant',
      };
      for (const cb of this.deltaCallbacks) cb(sessionId, catchupDelta);
    }
    const message: AgentMessage = {
      id: messageId,
      sessionId,
      kind: 'text',
      role: 'assistant',
      content,
      timestamp: Date.now(),
      status: 'complete',
      metadata: {
        ...(state.model ? { model: state.model } : {}),
        ...(state.conversationId ? { conversationId: state.conversationId } : {}),
        usage: {
          input_tokens: turnUsage.input_tokens,
          output_tokens: turnUsage.output_tokens,
          cache_read_input_tokens: turnUsage.cache_read_tokens,
        },
      },
    };
    for (const cb of this.completeCallbacks) cb(sessionId, message);
    recordAgyQuotaActivity();
    void refreshAgyQuotaMetadata().catch(() => {});
  }

  // ── Emit helpers ───────────────────────────────────────────────────────────

  private emitUsage(
    sessionId: string,
    state: AgySessionState,
    messageId: string,
    usage: AgyUsage,
    finalized?: boolean,
  ): void {
    if (this.usageCallbacks.size === 0) return;
    if (usage.input_tokens === undefined && usage.output_tokens === undefined) return;
    const update: ProviderUsageUpdate = {
      messageId,
      finalized: Boolean(finalized),
      usage: {
        input_tokens: usage.input_tokens,
        output_tokens: usage.output_tokens,
        cache_read_input_tokens: usage.cache_read_tokens,
      },
      ...(state.model ? { model: state.model } : {}),
    };
    for (const cb of this.usageCallbacks) cb(sessionId, update);
  }

  private emitSessionInfo(sessionId: string, info: SessionInfoUpdate): void {
    for (const cb of this.sessionInfoCallbacks) cb(sessionId, info);
  }

  private emitStatus(sessionId: string, state: AgySessionState, status: ProviderStatusUpdate): void {
    const signature = JSON.stringify({ status: status.status, label: status.label ?? null });
    if (state.lastStatusSignature === signature) return;
    state.lastStatusSignature = signature;
    for (const cb of this.statusCallbacks) cb(sessionId, status);
  }

  private emitError(sessionId: string, code: string, message: string, recoverable: boolean): void {
    const error = this.makeError(code, message, recoverable);
    for (const cb of this.errorCallbacks) cb(sessionId, error);
  }

  private makeError(code: string, message: string, recoverable: boolean, details?: unknown): ProviderError {
    const err = new Error(message) as Error & ProviderError;
    err.name = 'ProviderError';
    (err as any).code = code;
    (err as any).recoverable = recoverable;
    if (details !== undefined) (err as any).details = details;
    return err;
  }
}
