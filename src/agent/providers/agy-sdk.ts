import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import readline from 'node:readline';
import type {
  ProviderCapabilities,
  ProviderConfig,
  ProviderError,
  ProviderModelList,
  ProviderUsageUpdate,
  SessionConfig,
  SessionInfoUpdate,
  TransportProvider,
} from '../transport-provider.js';
import {
  CONNECTION_MODES,
  normalizeProviderPayload,
  PROVIDER_ERROR_CODES,
  SESSION_OWNERSHIP,
} from '../transport-provider.js';
import type { AgentMessage, MessageDelta, ToolCallEvent } from '../../../shared/agent-message.js';
import type { ProviderContextPayload } from '../../../shared/context-types.js';
import type { TransportAttachment } from '../../../shared/transport-attachments.js';
import { NATIVE_AGENT_ADMISSION_MODES } from '../../../shared/native-collaboration-policy.js';
import {
  AGY_CLI_BINARY,
  AGY_CLI_FLAG,
  AGY_CLI_PATH_ENV,
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
import { composeMessageSideProviderPrompt } from '../provider-context-routing.js';
import { normalizeTransportCwd, resolveExecutableForSpawn } from '../transport-paths.js';
import {
  ensureAgyMcpConfigHasImcodesEntry,
  agyMcpEnsureOptionsFromConfig,
  type AgyMcpEnsureResult,
} from '../../daemon/agy-mcp-config.js';
import { IMCODES_MEMORY_MCP_SERVER_NAME } from '../../../shared/memory-mcp-server-name.js';
import { getDefaultMcpServers } from './getDefaultMcpServers.js';
import {
  MEMORY_MCP_PROVIDER_STATUS_REASON,
  MEMORY_MCP_STATUS,
  type MemoryMcpProviderStatusView,
} from '../../../shared/memory-ws.js';
import { recordAgyQuotaActivity, refreshAgyQuotaMetadata } from '../agy-usage-quota.js';

const MODEL_CACHE_TTL_MS = 60_000;
const MODEL_PROBE_TIMEOUT_MS = 30_000;
const KILL_GRACE_MS = 2_000;
const STDERR_TAIL_BYTES = 2_048;
const AUTH_FAILURE_PATTERN = /auth|log ?in|credential|unauthori[sz]ed|license|permission denied|401\b|403\b/i;
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
  /** The stable session system text is sent once per conversation; agy persists it in history. */
  sessionSystemTextSent: boolean;
  stderrTail: string;
  toolSteps: Map<number, string>;
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
    ...(opts.model ? [AGY_CLI_FLAG.MODEL, opts.model] : []),
    // Must stay last: `-p`/`--print` without `=` would swallow the next argv as its prompt.
    AGY_CLI_FLAG.PRINT_STDIN,
  ];
}

/** Parse `agy models` output: `<id> <display name>` per line (tab- or multi-space separated). */
export function parseAgyModelList(stdout: string): ProviderModelList['models'] {
  const models: ProviderModelList['models'] = [];
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
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

/** Resolve the `agy` executable to spawn, honoring `config.binaryPath`, `AGY_CLI_PATH`, and PATH. */
export function resolveAgyBinary(config?: ProviderConfig | { binaryPath?: string } | null): { executable: string; prependArgs: string[] } {
  const direct = typeof config?.binaryPath === 'string' ? config.binaryPath.trim() : '';
  const name = direct || process.env[AGY_CLI_PATH_ENV]?.trim() || AGY_CLI_BINARY;
  return resolveExecutableForSpawn(name);
}

/**
 * Google Antigravity (`agy`) transport. One long-lived
 * `agy --input-format stream-json --output-format stream-json` process per
 * IM.codes session: user turns are appended to stdin (agy runs them in order),
 * `step_update` events stream text/tool progress and `result` ends each turn.
 * Authentication is agy's own login; no API key is handled here.
 */
export class AgySdkProvider implements TransportProvider {
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
  private modelCache: { at: number; list: ProviderModelList } | null = null;

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
    await Promise.all(states.map((state) => this.terminateChild(state)));
    this.config = null;
  }

  async createSession(config: SessionConfig): Promise<string> {
    const routeId = config.bindExistingKey ?? config.sessionKey;
    const existing = config.fresh ? undefined : this.sessions.get(routeId);
    const state: AgySessionState = {
      routeId,
      cwd: normalizeTransportCwd(config.cwd) ?? existing?.cwd ?? normalizeTransportCwd(process.cwd())!,
      env: config.env ?? existing?.env,
      mcpEnv: buildAgyMemoryMcpEnv(config) ?? existing?.mcpEnv,
      model: typeof config.agentId === 'string' && config.agentId ? config.agentId : existing?.model,
      conversationId: config.resumeId ?? existing?.conversationId,
      child: existing?.child ?? null,
      inflightTurns: existing?.inflightTurns ?? 0,
      cancelled: false,
      currentMessageId: null,
      currentText: '',
      sawToolCall: false,
      // A resumed conversation already carries the system text in agy's own history.
      sessionSystemTextSent: !!(config.resumeId ?? existing?.conversationId) && !config.fresh,
      stderrTail: '',
      toolSteps: new Map(),
    };
    if (existing?.child && existing.conversationId !== state.conversationId) {
      await this.terminateChild(existing);
      state.child = null;
      state.inflightTurns = 0;
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
    const prompt = composeMessageSideProviderPrompt(normalized, {
      includeSessionSystemText: !state.sessionSystemTextSent,
    });
    if (!prompt.trim()) {
      throw this.makeError(PROVIDER_ERROR_CODES.PROVIDER_ERROR, 'Cannot send an empty message to agy', false);
    }

    const child = this.ensureChild(sessionId, state);
    if (!child.stdin || child.stdin.destroyed || !child.stdin.writable) {
      state.child = null;
      throw this.makeError(PROVIDER_ERROR_CODES.CONNECTION_LOST, 'agy process is not accepting input', true);
    }
    state.cancelled = false;
    state.sessionSystemTextSent = true;
    state.inflightTurns += 1;
    // Appending while a turn is running is intentional: agy queues user events and runs them in order.
    child.stdin.write(encodeAgyUserLine(prompt), (err) => {
      if (!err) return;
      state.inflightTurns = Math.max(0, state.inflightTurns - 1);
      this.emitError(sessionId, PROVIDER_ERROR_CODES.CONNECTION_LOST, 'Failed to write to the agy process', true);
    });
  }

  async cancel(sessionId: string): Promise<void> {
    const state = this.sessions.get(sessionId);
    if (!state?.child || state.child.killed) return;
    state.cancelled = true;
    await this.terminateChild(state);
    // The next send resumes the same conversation via --conversation; agy persisted it.
    this.emitError(sessionId, PROVIDER_ERROR_CODES.CANCELLED, 'Turn cancelled', true);
  }

  setSessionAgentId(sessionId: string, agentId: string): void {
    const state = this.sessions.get(sessionId);
    if (!state || !agentId || state.model === agentId) return;
    state.model = agentId;
    // --model is a launch flag: drop an idle process so the next send resumes with the new model.
    if (state.child && state.inflightTurns === 0) void this.terminateChild(state);
    if (state.conversationId) this.emitSessionInfo(sessionId, { resumeId: state.conversationId, model: agentId });
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
        ? { models, defaultModel: models[0]?.id, isAuthenticated: true }
        : { models: [], isAuthenticated: false, error: 'agy returned no models. Run `agy` once to sign in.' };
      if (models.length > 0) this.modelCache = { at: now, list };
      return list;
    } catch (err) {
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
    return { ...process.env, ...(this.config?.env as Record<string, string> | undefined), ...mergedExtra };
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

    child.stderr?.on('data', (chunk: Buffer) => {
      state.stderrTail = (state.stderrTail + chunk.toString('utf8')).slice(-STDERR_TAIL_BYTES);
    });
    child.stdin?.on('error', () => { /* surfaced through the exit handler */ });
    const rl = readline.createInterface({ input: gateChildStream(child.stdout!) });
    rl.on('line', (line) => {
      if (state.child !== child) return;
      this.handleLine(sessionId, state, line);
    });
    child.once('error', (err) => {
      if (state.child !== child) return;
      state.child = null;
      state.inflightTurns = 0;
      const code = (err as NodeJS.ErrnoException).code;
      this.emitError(
        sessionId,
        code === 'ENOENT' ? PROVIDER_ERROR_CODES.CONFIG_ERROR : PROVIDER_ERROR_CODES.PROVIDER_ERROR,
        code === 'ENOENT' ? `The Antigravity CLI (\`${AGY_CLI_BINARY}\`) was not found.` : 'Failed to start the agy process',
        code !== 'ENOENT',
      );
    });
    child.once('exit', (code, signal) => {
      rl.close();
      if (state.child !== child) return;
      state.child = null;
      const hadTurns = state.inflightTurns > 0;
      state.inflightTurns = 0;
      if (state.cancelled || !hadTurns) return;
      logger.warn({ sessionId, code, signal }, 'agy process exited with turns in flight');
      const tail = state.stderrTail.trim();
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

  private async terminateChild(state: AgySessionState): Promise<void> {
    const child = state.child;
    state.child = null;
    state.inflightTurns = 0;
    if (!child) return;
    try { child.stdin?.end(); } catch { /* already closed */ }
    await killProcessTree(child, { gracefulMs: KILL_GRACE_MS, ownsProcessGroup: process.platform !== 'win32' });
  }

  // ── Stream parsing ─────────────────────────────────────────────────────────

  private handleLine(sessionId: string, state: AgySessionState, line: string): void {
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
        this.handleResult(sessionId, state, asRecord(event.result));
        return;
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

  private handleStep(sessionId: string, state: AgySessionState, step: Record<string, unknown>): void {
    this.noteConversationId(sessionId, state, asString(step.conversation_id));
    if (state.cancelled) return;
    const stepType = asString(step.step_type);
    const stepState = asString(step.state);

    if (stepType === AGY_STEP_TYPE.AGENT_RESPONSE) {
      const text = asString(step.text_delta);
      // The DONE frame carries a trailing "\n" separator, not user-visible text.
      if (!text || stepState === AGY_STEP_STATE.DONE) return;
      const stepIndex = asNumber(step.step_index);
      const targetMessageId = stepIndex !== undefined
        ? `${state.conversationId ?? state.routeId}:step:${stepIndex}`
        : (state.currentMessageId ?? randomUUID());
      if (state.currentMessageId !== targetMessageId) {
        state.currentMessageId = targetMessageId;
        state.currentText = '';
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
      for (const cb of this.toolCallCallbacks) cb(sessionId, tool);
      if (done) state.toolSteps.delete(stepIndex);
    }
  }

  private handleResult(sessionId: string, state: AgySessionState, result: Record<string, unknown>): void {
    this.noteConversationId(sessionId, state, asString(result.conversation_id));
    state.inflightTurns = Math.max(0, state.inflightTurns - 1);
    const messageId = state.currentMessageId ?? randomUUID();
    const streamed = state.currentText;
    const sawTool = state.sawToolCall;
    state.currentMessageId = null;
    state.currentText = '';
    state.sawToolCall = false;
    state.toolSteps.clear();
    if (state.cancelled) return;

    const usage = asRecord(result.usage) as AgyUsage;
    this.emitUsage(sessionId, state, messageId, usage);

    if (result.status !== AGY_RESULT_STATUS.SUCCESS) {
      const message = asString(result.error) ?? 'agy turn failed';
      const code = AUTH_FAILURE_PATTERN.test(message)
        ? PROVIDER_ERROR_CODES.AUTH_FAILED
        : RATE_LIMIT_PATTERN.test(message)
          ? PROVIDER_ERROR_CODES.RATE_LIMITED
          : PROVIDER_ERROR_CODES.PROVIDER_ERROR;
      this.emitError(sessionId, code, message, code !== PROVIDER_ERROR_CODES.AUTH_FAILED);
      return;
    }

    const response = asString(result.response);
    const content = (streamed && streamed.trim() ? streamed : (response && response.trim() ? response : streamed)).trimEnd();
    if (!content && !sawTool) {
      this.emitError(sessionId, PROVIDER_ERROR_CODES.PROVIDER_ERROR, 'agy finished without producing a response', true);
      return;
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
          input_tokens: usage.input_tokens,
          output_tokens: usage.output_tokens,
          cache_read_input_tokens: usage.cache_read_tokens,
        },
      },
    };
    for (const cb of this.completeCallbacks) cb(sessionId, message);
    recordAgyQuotaActivity();
    void refreshAgyQuotaMetadata().catch(() => {});
  }

  // ── Emit helpers ───────────────────────────────────────────────────────────

  private emitUsage(sessionId: string, state: AgySessionState, messageId: string, usage: AgyUsage): void {
    if (this.usageCallbacks.size === 0) return;
    if (usage.input_tokens === undefined && usage.output_tokens === undefined) return;
    const update: ProviderUsageUpdate = {
      messageId,
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

  private emitError(sessionId: string, code: string, message: string, recoverable: boolean): void {
    const error = this.makeError(code, message, recoverable);
    for (const cb of this.errorCallbacks) cb(sessionId, error);
  }

  private makeError(code: string, message: string, recoverable: boolean): ProviderError {
    return { code, message, recoverable };
  }
}
