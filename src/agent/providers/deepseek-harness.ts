/**
 * DeepSeek Harness (`dsh`) transport provider.
 *
 * The harness is a Cordis plugin runtime rather than a callable SDK, so this
 * provider drives it as a long-lived child process: one `dsh` per IM.codes
 * session, with our bridge plugin mounted inside it (see
 * `deepseek-harness/bridge.ts`) republishing the harness session-event stream
 * as NDJSON over stdio.
 *
 * Why not the harness's own automation surfaces: the `headless` profile answers
 * exactly one task and prints only the final text, and `@deepseek-ai/dsh-acp`
 * deliberately emits one chunk per COMMITTED assistant message with no session
 * resume and no MCP. Neither can produce token-level streaming, which is the
 * whole point of a chat transport.
 *
 * The child stays alive across turns — `agent.followup()` appends to the live
 * agent, so prompt-cache prefixes survive and a turn costs one round trip
 * instead of a process start.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface, type Interface as ReadlineInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import type {
  TransportProvider,
  ProviderConfig,
  ProviderCapabilities,
  ProviderError,
  ProviderModelList,
  ProviderStatusUpdate,
  ProviderUsageUpdate,
  ProviderDelegationNotification,
  SessionConfig,
  SessionInfoUpdate,
} from '../transport-provider.js';
import {
  AGENT_DELEGATION_ACTIVE_NOTIFICATION_MODES,
  AGENT_DELEGATION_NOTIFICATION_RESULTS,
  type AgentDelegationNotificationResult,
} from '../../../shared/agent-delegation.js';
import {
  CONNECTION_MODES,
  SESSION_OWNERSHIP,
  PROVIDER_ERROR_CODES,
  normalizeProviderPayload,
} from '../transport-provider.js';
import { composeMessageSideProviderPrompt, getProviderSystemTextParts } from '../provider-context-routing.js';
import type { ProviderContextPayload } from '../../../shared/context-types.js';
import type { AgentMessage, MessageDelta, ToolCallEvent } from '../../../shared/agent-message.js';
import type { TransportAttachment } from '../../../shared/transport-attachments.js';
import {
  DSH_BRIDGE_COMMAND,
  DSH_BRIDGE_CWD_ENV,
  DSH_BRIDGE_MODEL_ENV,
  DSH_BRIDGE_EVENT,
  DSH_BRIDGE_RESUME_ENV,
  DSH_BRIDGE_TURN_REASON,
  DSH_PROVIDER_API_KEY_ENV,
  parseDshBridgeEvent,
  type DshBridgeCommand,
  type DshBridgeEvent,
  type DshBridgeTurnReason,
  type DshLlmConfig,
} from '../../../shared/deepseek-harness.js';
import {
  buildDshArgs,
  formatDshLaunchError,
  removeDshOverlay,
  resolveDshBinary,
  writeDshOverlay,
} from './deepseek-harness/runtime.js';
import { normalizeTransportCwd, resolveExecutableForSpawn } from '../transport-paths.js';
import { killProcessTree } from '../../util/kill-process-tree.js';
import { getDefaultMcpServers } from './getDefaultMcpServers.js';
import { IMCODES_MEMORY_MCP_SERVER_NAME } from '../../../shared/memory-mcp-server-name.js';
import {
  MEMORY_MCP_PROVIDER_ID,
  MEMORY_MCP_STATUS,
  type MemoryMcpProviderStatusView,
} from '../../../shared/memory-ws.js';
import logger from '../../util/logger.js';

/** Grace period before a shutdown request escalates to SIGKILL. */
const SHUTDOWN_GRACE_MS = 3_000;

/**
 * Cap on the wait for the bridge's ready frame. Generous because the harness
 * bootstraps its own dependency tree on first use, but bounded so a wedged
 * start fails loudly instead of holding the runtime's dispatch lock forever.
 */
const READY_TIMEOUT_MS = 180_000;

interface DeepseekHarnessSessionState {
  routeId: string;
  sessionName?: string;
  projectName?: string;
  cwd: string;
  env?: Record<string, string>;
  /** Model the harness reported for the live agent. */
  model?: string;
  /** Model IM.codes asked for; pinned across respawns until the user changes it. */
  requestedModel?: string;
  provider?: string;
  /**
   * LLM config materialized from a ccPreset. Public route metadata is written
   * into the dsh overlay; the credential value is child-env-only.
   */
  llmConfig?: DshLlmConfig;
  /** Durable harness session id, used to resume after a restart. */
  harnessSessionId?: string;
  child: ChildProcess | null;
  reader: ReadlineInterface | null;
  /** Resolves when the bridge has published its ready frame. */
  readyPromise: Promise<void> | null;
  /** True once the ready frame settled; a failed start must not be cached. */
  readySettled: boolean;
  resolveReady: (() => void) | null;
  rejectReady: ((err: Error) => void) | null;
  /** Cumulative assistant text for the in-flight turn. */
  currentText: string;
  currentMessageId: string | null;
  /**
   * Committed assistant messages for this turn, in order. A tool-using turn
   * commits one per model step, so these must accumulate — keeping only the
   * last one would drop everything the model said before its first tool call.
   */
  committedSegments: string[];
  turnActive: boolean;
  cancelled: boolean;
  /** Tool names captured on tool/call, replayed onto the matching tool/result. */
  toolNames: Map<string, string>;
  /** Stored in the ProviderUsageUpdate shape so it is mapped exactly once. */
  lastUsage?: ProviderUsageUpdate['usage'];
  /** Session-scoped context already folded into this harness conversation. */
  sessionSystemTextInjected?: string;
  /** Session context sent this turn, promoted to `injected` only once it settles. */
  pendingSessionSystemText?: string;
  lastStatusSignature: string | null;
  disposed: boolean;
  /** IM.codes memory MCP server mounted into this harness session. */
  memoryMcp?: { command: string; args: readonly string[]; env: Record<string, string> };
}

export class DeepseekHarnessProvider implements TransportProvider {
  // The id IS the agent type the registry routes by; take it from the shared
  // vocabulary rather than re-spelling the literal a third time.
  readonly id = MEMORY_MCP_PROVIDER_ID.DEEPSEEK_HARNESS;
  readonly connectionMode = CONNECTION_MODES.LOCAL_SDK;
  readonly sessionOwnership = SESSION_OWNERSHIP.SHARED;
  readonly capabilities: ProviderCapabilities = {
    streaming: true,
    toolCalling: true,
    // The harness owns approval through its own `approval`/`permission` rows;
    // the bridge does not surface them yet, so turns run under the profile's
    // configured policy rather than asking IM.codes.
    approval: false,
    sessionRestore: true,
    multiTurn: true,
    attachments: false,
    // The harness composes its own persona and tool prompts, so IM.codes
    // context rides in the message body rather than a system slot.
    contextSupport: 'degraded-message-side-context-mapping',
    activeDelegationNotification: AGENT_DELEGATION_ACTIVE_NOTIFICATION_MODES.NATIVE,
  };

  private config: ProviderConfig | null = null;
  private sessions = new Map<string, DeepseekHarnessSessionState>();
  private deltaCallbacks: Array<(sessionId: string, delta: MessageDelta) => void> = [];
  private completeCallbacks: Array<(sessionId: string, message: AgentMessage) => void> = [];
  private errorCallbacks: Array<(sessionId: string, error: ProviderError) => void> = [];
  private toolCallCallbacks: Array<(sessionId: string, tool: ToolCallEvent) => void> = [];
  private statusCallbacks: Array<(sessionId: string, status: ProviderStatusUpdate) => void> = [];
  private sessionInfoCallbacks: Array<(sessionId: string, info: SessionInfoUpdate) => void> = [];
  private usageCallbacks: Array<(sessionId: string, update: ProviderUsageUpdate) => void> = [];

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  async connect(config: ProviderConfig): Promise<void> {
    // The harness is a local CLI; there is nothing to dial. Record the config
    // and let the first spawn surface a missing binary as a session error, the
    // same way a broken CLI install behaves for other local-SDK providers.
    this.config = config;
    logger.info({ provider: this.id, binary: resolveDshBinary() }, 'DeepSeek Harness provider connected');
  }

  async disconnect(): Promise<void> {
    // Independent waits: serial teardown would multiply the per-child grace
    // period by the number of live sessions on every daemon shutdown.
    await Promise.all([...this.sessions.keys()].map((sessionId) => this.endSession(sessionId)));
    this.config = null;
    logger.info({ provider: this.id }, 'DeepSeek Harness provider disconnected');
  }

  async createSession(config: SessionConfig): Promise<string> {
    const routeId = config.bindExistingKey ?? config.sessionKey;
    // Stop any live child for this route even on a fresh create: the map entry
    // is replaced below, so skipping this would drop the only handle to a
    // running dsh (and its tool subprocesses) and leak it for the host's life.
    const previous = this.sessions.get(routeId);
    if (previous) await this.stopChild(previous);
    const existing = config.fresh ? undefined : previous;

    const resumeId = config.fresh ? undefined : (config.resumeId ?? existing?.harnessSessionId);
    const requestedModel = typeof config.agentId === 'string' && config.agentId.trim()
      ? config.agentId.trim()
      : existing?.requestedModel;
    this.sessions.set(routeId, {
      routeId,
      sessionName: config.sessionName ?? existing?.sessionName,
      projectName: config.projectName ?? existing?.projectName,
      cwd: normalizeTransportCwd(config.cwd) ?? existing?.cwd ?? normalizeTransportCwd(process.cwd())!,
      env: config.env ?? existing?.env,
      model: existing?.model,
      ...(requestedModel ? { requestedModel } : {}),
      provider: existing?.provider,
      harnessSessionId: resumeId,
      child: null,
      reader: null,
      readyPromise: null,
      readySettled: false,
      resolveReady: null,
      rejectReady: null,
      currentText: '',
      currentMessageId: null,
      committedSegments: [],
      turnActive: false,
      cancelled: false,
      toolNames: new Map(),
      sessionSystemTextInjected: existing?.sessionSystemTextInjected,
      lastStatusSignature: null,
      disposed: false,
      memoryMcp: this.buildMemoryMcp(config),
      llmConfig: config.llm,
    });
    return routeId;
  }

  async endSession(sessionId: string): Promise<void> {
    const state = this.sessions.get(sessionId);
    if (!state) return;
    state.disposed = true;
    await this.stopChild(state);
    this.sessions.delete(sessionId);
    await removeDshOverlay(state.routeId);
  }

  // ── Callback registration ──────────────────────────────────────────────────

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

  onStatus(cb: (sessionId: string, status: ProviderStatusUpdate) => void): () => void {
    this.statusCallbacks.push(cb);
    return () => { this.statusCallbacks = this.statusCallbacks.filter((entry) => entry !== cb); };
  }

  onSessionInfo(cb: (sessionId: string, info: SessionInfoUpdate) => void): () => void {
    this.sessionInfoCallbacks.push(cb);
    return () => { this.sessionInfoCallbacks = this.sessionInfoCallbacks.filter((entry) => entry !== cb); };
  }

  onUsage(cb: (sessionId: string, update: ProviderUsageUpdate) => void): () => void {
    this.usageCallbacks.push(cb);
    return () => { this.usageCallbacks = this.usageCallbacks.filter((entry) => entry !== cb); };
  }

  setSessionAgentId(sessionId: string, agentId: string): void {
    const state = this.sessions.get(sessionId);
    const model = agentId.trim();
    if (!state || !model || state.requestedModel === model) return;
    state.requestedModel = model;
    // The model is chosen when the agent is created, so it only takes effect on
    // the next spawn. Detach the child refs BEFORE the async teardown: leaving
    // them set lets a send() arriving inside the shutdown grace take
    // ensureChild's fast path and write the prompt into a dying stdin, which
    // silently loses the message. Clearing them first makes that send respawn.
    const child = state.child;
    this.detachChild(state);
    void this.stopChild(state, child);
  }

  // ── Sending ────────────────────────────────────────────────────────────────

  async send(
    sessionId: string,
    payloadOrMessage: string | ProviderContextPayload,
    attachments?: TransportAttachment[],
    extraSystemPrompt?: string,
  ): Promise<void> {
    const state = this.sessions.get(sessionId);
    if (!state) {
      throw this.makeError(PROVIDER_ERROR_CODES.SESSION_NOT_FOUND, `Unknown session ${sessionId}`, false);
    }
    const payload = normalizeProviderPayload(payloadOrMessage, attachments, extraSystemPrompt);
    const systemParts = getProviderSystemTextParts(payload);
    const sessionSystemText = systemParts.sessionSystemText;
    // Stable session instructions are re-sent only when they change; the harness
    // keeps full history, so repeating them every turn would grow the prefix
    // without adding information.
    const includeSessionSystemText = !!sessionSystemText
      && state.sessionSystemTextInjected !== sessionSystemText;
    const text = composeMessageSideProviderPrompt(payload, { includeSessionSystemText });
    if (!text.trim()) return;

    // Announce work BEFORE the child is up: a first turn pays the harness's
    // own dependency bootstrap, and the session should not look idle for it.
    this.emitStatus(sessionId, state, { status: 'working', label: null });
    await this.ensureChild(state);
    state.currentText = '';
    state.committedSegments = [];
    state.currentMessageId = `${state.routeId}:${randomUUID()}`;
    state.turnActive = true;
    state.cancelled = false;
    state.toolNames.clear();
    // Stale counters would otherwise be stamped onto a turn that reports none.
    state.lastUsage = undefined;
    if (!this.write(state, { type: DSH_BRIDGE_COMMAND.PROMPT, text })) {
      state.turnActive = false;
      throw this.makeError(PROVIDER_ERROR_CODES.CONNECTION_LOST, 'dsh bridge stdin is unavailable', true);
    }
    // Only claim the session text landed once the turn actually settles: `write`
    // is a silent no-op on a closed stdin, and committing here would leave a
    // retried turn permanently stripped of its session instructions.
    state.pendingSessionSystemText = includeSessionSystemText ? sessionSystemText : undefined;
  }

  async notifyActiveDelegation(
    sessionId: string,
    notification: ProviderDelegationNotification,
  ): Promise<AgentDelegationNotificationResult> {
    const state = this.sessions.get(sessionId);
    if (!state?.turnActive || state.cancelled || !state.child) {
      return AGENT_DELEGATION_NOTIFICATION_RESULTS.STALE;
    }
    // Both delegation replies and explicit queue appends are next-boundary
    // steering messages in dsh. `followup()` would defer them until idle and
    // defeat the product's Append/now contract; `steer()` keeps the current
    // tool batch alive and inserts the text before the next model step.
    return this.write(state, { type: DSH_BRIDGE_COMMAND.STEER, text: notification.text })
      ? AGENT_DELEGATION_NOTIFICATION_RESULTS.DELIVERED
      : AGENT_DELEGATION_NOTIFICATION_RESULTS.STALE;
  }

  async cancel(sessionId: string): Promise<void> {
    const state = this.sessions.get(sessionId);
    if (!state || !state.child) return;
    state.cancelled = true;
    this.write(state, { type: DSH_BRIDGE_COMMAND.CANCEL });
  }

  async restoreSession(sessionId: string): Promise<boolean> {
    return this.sessions.has(sessionId);
  }

  /**
   * IM.codes' managed memory/send/cron MCP, described for the harness's own MCP
   * client row. Built per session because its env carries the session identity.
   */
  private buildMemoryMcp(config: SessionConfig): DeepseekHarnessSessionState['memoryMcp'] {
    const server = getDefaultMcpServers(config)[IMCODES_MEMORY_MCP_SERVER_NAME];
    if (!server) return undefined;
    return { command: server.command, args: server.args, env: server.env };
  }

  /**
   * The harness resolves provider routes and model catalogues from its own
   * `~/.dsh` configuration, so IM.codes advertises none. This must still be
   * implemented: once the provider is connected the daemon stops consulting the
   * passive list and would otherwise report `Unsupported agentType` in the
   * model picker.
   */
  async listModels(): Promise<ProviderModelList> {
    return { models: [] };
  }

  getMemoryMcpStatus(): MemoryMcpProviderStatusView {
    return {
      providerId: this.id,
      status: this.config ? MEMORY_MCP_STATUS.READY : MEMORY_MCP_STATUS.UNKNOWN,
      connected: Boolean(this.config),
      degradedReasons: [],
    };
  }

  getSessionDiagnostics(sessionId: string): Record<string, unknown> | null {
    const state = this.sessions.get(sessionId);
    if (!state) return null;
    return {
      provider: this.id,
      binary: resolveDshBinary(),
      cwd: state.cwd,
      model: state.model,
      harnessSessionId: state.harnessSessionId,
      childRunning: !!state.child,
      turnActive: state.turnActive,
      memoryMcpMounted: !!state.memoryMcp,
    };
  }

  // ── Child process ──────────────────────────────────────────────────────────

  private async ensureChild(state: DeepseekHarnessSessionState): Promise<void> {
    // Only a SETTLED-OK start may be reused. A rejected readyPromise must never
    // be cached: `dsh` missing from PATH emits 'error'+'close' and never 'exit',
    // so without this the first ENOENT would be replayed by every later send()
    // for the life of the session, even after the user installs it.
    if (state.child && state.readyPromise && state.readySettled) {
      await state.readyPromise;
      return;
    }
    if (state.child) this.detachChild(state);

    const overlayPath = await writeDshOverlay({
      sessionKey: state.routeId,
      ...(state.memoryMcp ? { memoryMcp: state.memoryMcp } : {}),
      ...(state.llmConfig ? { llm: state.llmConfig } : {}),
    });
    const resumeId = state.harnessSessionId;
    // On Windows `dsh` is an npm .cmd shim, which bare spawn() cannot execute;
    // this resolves it to `node <script>` the same way every other local-SDK
    // provider does.
    const executable = resolveExecutableForSpawn(resolveDshBinary());
    const child = spawn(executable.executable, [...executable.prependArgs, ...buildDshArgs(overlayPath)], {
      cwd: state.cwd,
      env: {
        ...process.env,
        ...(state.env ?? {}),
        [DSH_BRIDGE_CWD_ENV]: state.cwd,
        ...(resumeId ? { [DSH_BRIDGE_RESUME_ENV]: resumeId } : {}),
        // The harness picks the model when it creates the agent, so IM.codes
        // pins it here too. A ccPreset's route metadata rides the overlay while
        // its credential stays out of that file and enters only this child.
        ...(state.requestedModel ? { [DSH_BRIDGE_MODEL_ENV]: state.requestedModel } : {}),
        ...(state.llmConfig?.apiKey
          ? { [DSH_PROVIDER_API_KEY_ENV]: state.llmConfig.apiKey }
          : {}),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    state.child = child;
    state.readySettled = false;
    let readyTimer: ReturnType<typeof setTimeout> | null = null;
    const readyPromise = new Promise<void>((resolve, reject) => {
      state.resolveReady = () => { state.readySettled = true; resolve(); };
      state.rejectReady = (err) => { state.readySettled = false; reject(err); };
    });
    state.readyPromise = readyPromise;
    // Never await an unbounded start. Without this a harness that hangs during
    // its first-run dependency bootstrap would pend forever, holding the
    // runtime's dispatch lock with no error to show the user.
    readyTimer = setTimeout(() => {
      if (state.child === child && !state.readySettled) {
        this.failStartup(state, child, `dsh did not become ready within ${READY_TIMEOUT_MS}ms`);
      }
    }, READY_TIMEOUT_MS);
    readyTimer.unref?.();
    const clearReadyTimer = (): void => {
      if (readyTimer) { clearTimeout(readyTimer); readyTimer = null; }
    };
    void readyPromise.then(clearReadyTimer, clearReadyTimer);

    child.on('error', (err) => {
      // spawn failures (ENOENT) surface here and never produce an 'exit'.
      this.failStartup(state, child, formatDshLaunchError(err));
    });
    // stdin errors are asynchronous: an EPIPE from writing to an exiting child
    // arrives as an 'error' event, which is an uncaught exception without a
    // listener. Siblings (codex-sdk, qwen) install one for the same reason.
    child.stdin?.on('error', (err) => {
      logger.debug({ provider: this.id, session: state.sessionName, err }, 'dsh stdin error');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      const line = chunk.toString('utf8').trim();
      if (line) logger.debug({ provider: this.id, session: state.sessionName, line: line.slice(0, 500) }, 'dsh stderr');
    });
    const onGone = (reason: string): void => {
      // A predecessor killed by stopChild can emit its terminal event AFTER a
      // replacement is live; without this guard it would close the new child's
      // reader and drop its readyPromise, orphaning a running process.
      if (state.child !== child) return;
      const wasActive = state.turnActive;
      const wasStarting = !state.readySettled;
      this.detachChild(state);
      if (state.disposed) return;
      if (wasStarting) {
        // Exit before ready is a startup failure, not a turn failure: reject so
        // the awaiting send() fails loudly instead of pending forever.
        this.failStartup(state, child, reason);
        return;
      }
      if (wasActive) this.failSession(state, reason);
    };
    child.on('exit', (code, signal) => {
      onGone(`dsh exited (code=${code ?? 'null'} signal=${signal ?? 'null'})`);
    });
    child.on('close', (code, signal) => {
      onGone(`dsh closed (code=${code ?? 'null'} signal=${signal ?? 'null'})`);
    });

    if (child.stdout) {
      const reader = createInterface({ input: child.stdout });
      state.reader = reader;
      reader.on('line', (line) => this.handleLine(state, line));
    }

    await readyPromise;
  }

  /** Drop this session's references to its child without terminating it. */
  private detachChild(state: DeepseekHarnessSessionState): void {
    state.child = null;
    state.reader?.close();
    state.reader = null;
    state.readyPromise = null;
    state.readySettled = false;
  }

  /**
   * Fail a start that never reached ready. Rejecting `readyPromise` is what
   * unblocks the awaiting `send()`; the child is also killed so a bridge that
   * reported an error but stayed alive (its stdin reader is never installed on
   * that path) cannot linger holding the harness session lock.
   */
  private failStartup(state: DeepseekHarnessSessionState, child: ChildProcess, message: string): void {
    const reject = state.rejectReady;
    state.rejectReady = null;
    state.resolveReady = null;
    if (state.child === child) this.detachChild(state);
    state.turnActive = false;
    void killProcessTree(child).catch(() => {});
    if (reject) {
      reject(new Error(message));
      return;
    }
    if (!state.disposed) {
      this.emitError(state.routeId, {
        code: PROVIDER_ERROR_CODES.PROVIDER_ERROR,
        message,
        recoverable: true,
      });
    }
  }

  /**
   * Terminate a child, giving the bridge a chance to flush its session log
   * first — a hard kill would lose the tail of the conversation and break the
   * next resume. `explicitChild` lets callers detach the state up front and
   * still stop the process they detached.
   */
  private async stopChild(
    state: DeepseekHarnessSessionState,
    explicitChild?: ChildProcess | null,
  ): Promise<void> {
    const child = explicitChild ?? state.child;
    if (!child) return;
    if (state.child === child) {
      try {
        this.write(state, { type: DSH_BRIDGE_COMMAND.SHUTDOWN });
      } catch {
        // stdin may already be closed; fall through to the timed kill.
      }
    } else if (child.stdin && !child.stdin.destroyed) {
      try {
        child.stdin.write(`${JSON.stringify({ type: DSH_BRIDGE_COMMAND.SHUTDOWN })}\n`);
      } catch {
        // Detached child already gone.
      }
    }
    if (state.child === child) this.detachChild(state);
    // killProcessTree owns the graceful-then-SIGKILL escalation and no-ops when
    // the child already exited; the harness spawns its own tool subprocesses,
    // which a bare kill would orphan (Windows has no process group to signal).
    await killProcessTree(child, { gracefulMs: SHUTDOWN_GRACE_MS }).catch(() => {});
  }

  private write(state: DeepseekHarnessSessionState, command: DshBridgeCommand): boolean {
    const stdin = state.child?.stdin;
    if (!stdin || stdin.destroyed) return false;
    try {
      // A false Writable.write() result is backpressure, not rejection: the
      // bytes are already accepted into Node's buffer. Only absence,
      // destruction, or a synchronous write error means no admission.
      stdin.write(`${JSON.stringify(command)}\n`);
      return true;
    } catch {
      return false;
    }
  }

  // ── Bridge event handling ──────────────────────────────────────────────────

  private handleLine(state: DeepseekHarnessSessionState, line: string): void {
    const event = parseDshBridgeEvent(line);
    if (!event) {
      // Anything non-protocol on stdout means a harness row is printing where it
      // should not; keep it for diagnosis rather than silently dropping it.
      if (line.trim()) logger.debug({ provider: this.id, line: line.slice(0, 500) }, 'dsh non-protocol stdout');
      return;
    }
    this.dispatch(state, event);
  }

  private dispatch(state: DeepseekHarnessSessionState, event: DshBridgeEvent): void {
    const sessionId = state.routeId;
    switch (event.type) {
      case DSH_BRIDGE_EVENT.READY: {
        state.harnessSessionId = event.sessionId;
        if (event.provider) state.provider = event.provider;
        // The harness reports what it actually runs. Record it, but never let
        // it overwrite `requestedModel` — that is IM.codes' pin, re-applied on
        // every spawn through DSH_BRIDGE_MODEL_ENV.
        if (event.model) state.model = event.model;
        // A fresh agent means the harness lost the old conversation, so the
        // folded session context has to be re-sent on the next turn.
        if (!event.resumed) state.sessionSystemTextInjected = undefined;
        // `model` is the SessionInfoUpdate field session-manager reads for
        // activeModel/modelDisplay; there is no `agentId` on that contract.
        this.emitSessionInfo(sessionId, {
          resumeId: event.sessionId,
          ...(event.model ? { model: event.model } : {}),
        });
        state.resolveReady?.();
        state.resolveReady = null;
        state.rejectReady = null;
        return;
      }
      case DSH_BRIDGE_EVENT.DELTA: {
        state.currentText += event.text;
        const messageId = state.currentMessageId ?? `${state.routeId}:${randomUUID()}`;
        state.currentMessageId = messageId;
        for (const cb of this.deltaCallbacks) {
          cb(sessionId, {
            messageId,
            type: 'text',
            delta: state.currentText,
            role: 'assistant',
          });
        }
        return;
      }
      case DSH_BRIDGE_EVENT.REASONING:
        this.emitStatus(sessionId, state, { status: 'thinking', label: 'Thinking...' });
        return;
      case DSH_BRIDGE_EVENT.MESSAGE:
        // Committed messages are authoritative (a retried request can replay
        // deltas that never joined the conversation) but a tool-using turn
        // commits one per model step, so they must ACCUMULATE — keeping only
        // the last would delete everything said before the first tool call.
        state.committedSegments.push(event.text);
        return;
      case DSH_BRIDGE_EVENT.TOOL: {
        const name = event.name || state.toolNames.get(event.id) || 'tool';
        if (event.name) state.toolNames.set(event.id, event.name);
        for (const cb of this.toolCallCallbacks) {
          cb(sessionId, {
            id: event.id,
            name,
            status: event.status,
            ...(event.input !== undefined ? { input: event.input } : {}),
            ...(event.output !== undefined ? { output: event.output } : {}),
          });
        }
        return;
      }
      case DSH_BRIDGE_EVENT.USAGE: {
        const usage = {
          ...(event.inputTokens !== undefined ? { input_tokens: event.inputTokens } : {}),
          ...(event.outputTokens !== undefined ? { output_tokens: event.outputTokens } : {}),
          ...(event.cacheReadTokens !== undefined ? { cache_read_input_tokens: event.cacheReadTokens } : {}),
        };
        state.lastUsage = usage;
        for (const cb of this.usageCallbacks) {
          cb(sessionId, {
            usage,
            ...(state.model ? { model: state.model } : {}),
            ...(state.currentMessageId ? { messageId: state.currentMessageId } : {}),
          });
        }
        return;
      }
      case DSH_BRIDGE_EVENT.TURN_END:
        this.finishTurn(state, event.reason, event.message, event.code);
        return;
      case DSH_BRIDGE_EVENT.ERROR: {
        const message = event.message || 'DeepSeek Harness bridge error';
        state.rejectReady?.(new Error(message));
        state.rejectReady = null;
        state.resolveReady = null;
        this.emitError(sessionId, {
          code: PROVIDER_ERROR_CODES.PROVIDER_ERROR,
          message,
          recoverable: true,
        });
        return;
      }
      default:
        return;
    }
  }

  private finishTurn(
    state: DeepseekHarnessSessionState,
    reason: DshBridgeTurnReason,
    message?: string,
    code?: string,
  ): void {
    const sessionId = state.routeId;
    state.turnActive = false;
    // Every exit clears the transient status. Without this the dedupe signature
    // stays pinned to the last value, so the NEXT turn's identical status is
    // swallowed and the session shows nothing at all.
    this.clearStatus(sessionId, state);

    if (reason === DSH_BRIDGE_TURN_REASON.ERROR) {
      this.resetTurn(state);
      this.emitError(sessionId, {
        code: PROVIDER_ERROR_CODES.PROVIDER_ERROR,
        message: message || 'DeepSeek Harness turn failed',
        recoverable: true,
        ...(code ? { details: { code } } : {}),
      });
      return;
    }
    if (reason === DSH_BRIDGE_TURN_REASON.CANCELLED) {
      state.cancelled = false;
      this.resetTurn(state);
      this.emitError(sessionId, {
        code: PROVIDER_ERROR_CODES.CANCELLED,
        message: 'Turn cancelled',
        recoverable: true,
      });
      return;
    }

    // A cancel that lost the race against a completing turn must NOT discard the
    // finished answer — the harness told us the turn completed, so publish it.
    state.cancelled = false;
    // The session text reached the harness only because the turn ran.
    if (state.pendingSessionSystemText) {
      state.sessionSystemTextInjected = state.pendingSessionSystemText;
    }
    const finalText = state.committedSegments.length
      ? state.committedSegments.join('')
      : state.currentText;
    const completion: AgentMessage = {
      id: state.currentMessageId ?? `${state.routeId}:${randomUUID()}`,
      sessionId,
      kind: 'text',
      role: 'assistant',
      // A tool-only turn commits no text. The completion is still emitted:
      // TransportSessionRuntime settles a dispatch ONLY from onComplete/onError,
      // so returning early here would hold the turn open until the multi-minute
      // stale-turn watchdog and queue every following message behind it.
      content: finalText,
      timestamp: Date.now(),
      status: 'complete',
      metadata: {
        ...(state.model ? { model: state.model } : {}),
        ...(state.lastUsage ? { usage: state.lastUsage } : {}),
      },
    };
    this.resetTurn(state);
    for (const cb of this.completeCallbacks) cb(sessionId, completion);
  }

  /** Drop per-turn accumulators so the next turn cannot inherit them. */
  private resetTurn(state: DeepseekHarnessSessionState): void {
    state.currentText = '';
    state.committedSegments = [];
    state.currentMessageId = null;
    state.pendingSessionSystemText = undefined;
  }

  private clearStatus(sessionId: string, state: DeepseekHarnessSessionState): void {
    this.emitStatus(sessionId, state, { status: null, label: null });
  }

  private failSession(state: DeepseekHarnessSessionState, message: string): void {
    state.rejectReady?.(new Error(message));
    state.rejectReady = null;
    state.resolveReady = null;
    state.turnActive = false;
    this.clearStatus(state.routeId, state);
    this.resetTurn(state);
    this.emitError(state.routeId, {
      code: PROVIDER_ERROR_CODES.PROVIDER_ERROR,
      message,
      recoverable: true,
    });
  }

  // ── Emit helpers ───────────────────────────────────────────────────────────

  private emitError(sessionId: string, error: ProviderError): void {
    for (const cb of this.errorCallbacks) cb(sessionId, error);
  }

  private emitSessionInfo(sessionId: string, info: SessionInfoUpdate): void {
    for (const cb of this.sessionInfoCallbacks) cb(sessionId, info);
  }

  private emitStatus(
    sessionId: string,
    state: DeepseekHarnessSessionState,
    status: ProviderStatusUpdate,
  ): void {
    const signature = JSON.stringify({ status: status.status, label: status.label ?? null });
    if (state.lastStatusSignature === signature) return;
    state.lastStatusSignature = signature;
    for (const cb of this.statusCallbacks) cb(sessionId, status);
  }

  private makeError(code: string, message: string, recoverable: boolean): ProviderError {
    return { code, message, recoverable };
  }
}
