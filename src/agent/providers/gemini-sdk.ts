/**
 * GeminiSdkProvider — TransportProvider that drives `gemini --acp` over the
 * Agent Client Protocol (ACP, https://agentclientprotocol.com/).
 *
 * Architecture
 * ------------
 * ACP is a JSON-RPC 2.0 protocol over stdio. We use the canonical TypeScript
 * client from `@agentclientprotocol/sdk` (the same library the Gemini CLI
 * itself implements on the agent side, see
 * gemini-cli/packages/cli/src/acp/acpClient.ts) so we don't have to reimplement
 * request/response correlation, ndjson framing, or bidirectional RPC routing.
 *
 * One `gemini --acp` child is spawned per daemon on connect() and held for
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
 * Gemini CLI persists session history to
 * `~/.gemini/tmp/<project>/chats/<sessionId>.json`, so `session/load` works
 * across process restarts. We call `newSession` on first send and `loadSession`
 * when a `resumeId` is present.
 *
 * Limitations (intentional for MVP)
 * ---------------------------------
 * - Reasoning effort: ACP has no per-session effort knob; Gemini bakes thinking
 *   budget into the model choice. capabilities.reasoningEffort = false.
 * - Attachments: ACP supports image/audio ContentBlocks, but we currently
 *   accept text only to match other SDK providers.
 * - Filesystem reverse-RPC: we advertise fs capabilities = false so the agent
 *   uses its own fs access. Wiring client-side fs through the daemon would
 *   require a permission-broker integration we don't need yet.
 * - Auth: the Gemini CLI caches OAuth credentials under ~/.gemini/. We do NOT
 *   call `authenticate()` and rely on the user having logged in once. API-key
 *   auth can be added later by wiring the `AUTHENTICATE` path.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import { randomUUID } from 'node:crypto';
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
import logger from '../../util/logger.js';
import type { TransportEffortLevel } from '../../../shared/effort-levels.js';
import { normalizeTransportCwd, resolveExecutableForSpawn } from '../transport-paths.js';

const GEMINI_BIN = 'gemini';
/** ACP mode id we request once per session. Matches the `yolo` mode advertised
 *  by the Gemini CLI (see packages/core/src/policy/types.ts ApprovalMode). */
const GEMINI_YOLO_MODE = 'yolo';

interface GeminiSdkSessionState {
  routeId: string;
  cwd: string;
  model?: string;
  /** ACP-level session identifier returned by `newSession` or supplied for
   *  resume. Undefined until the first send actually creates/loads a session. */
  acpSessionId?: string;
  /** True once newSession or loadSession has returned successfully. */
  loaded: boolean;
  /** True once setSessionMode(yolo) has been accepted for this session. */
  modeApplied: boolean;
  /** Set while a `prompt` RPC is in flight. */
  promptInFlight: boolean;
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
  lastStatusSignature: string | null;
}

interface MergedToolCall {
  toolCallId: string;
  title: string;
  kind?: string;
  status: string;
  content: ToolCallContent[];
  rawInput?: unknown;
  rawOutput?: unknown;
}

export class GeminiSdkProvider implements TransportProvider {
  readonly id = 'gemini-sdk';
  readonly connectionMode = CONNECTION_MODES.LOCAL_SDK;
  readonly sessionOwnership = SESSION_OWNERSHIP.SHARED;
  readonly capabilities: ProviderCapabilities = {
    streaming: true,
    toolCalling: true,
    approval: false,
    sessionRestore: true,
    multiTurn: true,
    attachments: false,
    reasoningEffort: false,
    contextSupport: 'degraded-message-side-context-mapping',
  };

  private config: ProviderConfig | null = null;
  private sessions = new Map<string, GeminiSdkSessionState>();
  /** Reverse lookup so `sessionUpdate` notifications can find the right state
   *  by ACP sessionId (which we only learn after newSession/loadSession). */
  private acpToRoute = new Map<string, string>();
  private deltaCallbacks: Array<(sessionId: string, delta: MessageDelta) => void> = [];
  private completeCallbacks: Array<(sessionId: string, message: AgentMessage) => void> = [];
  private errorCallbacks: Array<(sessionId: string, error: ProviderError) => void> = [];
  private toolCallCallbacks: Array<(sessionId: string, tool: ToolCallEvent) => void> = [];
  private sessionInfoCallbacks: Array<(sessionId: string, info: SessionInfoUpdate) => void> = [];
  private statusCallbacks: Array<(sessionId: string, status: ProviderStatusUpdate) => void> = [];

  private child: ChildProcessWithoutNullStreams | null = null;
  private connection: ClientSideConnection | null = null;
  /** Resolves once `initialize` has completed so subsequent RPCs can proceed. */
  private initPromise: Promise<void> | null = null;
  /** Models returned by the first ACP `newSession` call, cached for the
   *  lifetime of this provider connection. Populated on first session create. */
  private cachedModels: Array<{ id: string; name?: string }> | null = null;
  private cachedDefaultModel: string | null = null;

  async connect(config: ProviderConfig): Promise<void> {
    await this.startAcpServer(config);
    this.config = config;
    logger.info({ provider: this.id }, 'Gemini SDK provider connected via --acp');
  }

  async disconnect(): Promise<void> {
    this.teardownChild();
    this.acpToRoute.clear();
    this.sessions.clear();
    this.config = null;
    this.initPromise = null;
    this.cachedModels = null;
    this.cachedDefaultModel = null;
  }

  async createSession(config: SessionConfig): Promise<string> {
    const routeId = config.bindExistingKey ?? config.sessionKey;
    const existing = config.fresh ? undefined : this.sessions.get(routeId);
    const state: GeminiSdkSessionState = {
      routeId,
      cwd: normalizeTransportCwd(config.cwd) ?? existing?.cwd ?? normalizeTransportCwd(process.cwd())!,
      model: typeof config.agentId === 'string' ? config.agentId : existing?.model,
      acpSessionId: config.resumeId ?? existing?.acpSessionId,
      loaded: false,
      modeApplied: false,
      promptInFlight: false,
      replaying: false,
      cancelled: false,
      currentMessageId: null,
      currentText: '',
      toolCalls: new Map(),
      emittedToolSignatures: new Map(),
      lastStatusSignature: null,
    };
    this.sessions.set(routeId, state);
    if (state.acpSessionId) {
      this.acpToRoute.set(state.acpSessionId, routeId);
      this.emitSessionInfo(routeId, { resumeId: state.acpSessionId });
    }
    return routeId;
  }

  async endSession(sessionId: string): Promise<void> {
    const state = this.sessions.get(sessionId);
    if (!state) return;
    // ACP has a session/close RPC (optional capability). We call it best-effort
    // so the agent can free state; if it fails, the session is still gone on
    // our side. closeSession is optional on the Agent interface so we have to
    // feature-detect.
    if (state.acpSessionId && state.loaded && this.connection) {
      const closer = (this.connection as AcpAgent).closeSession;
      if (typeof closer === 'function') {
        await closer.call(this.connection, { sessionId: state.acpSessionId }).catch(() => {});
      }
      this.acpToRoute.delete(state.acpSessionId);
    }
    this.sessions.delete(sessionId);
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
    // If session already loaded, best-effort push the model change via the
    // experimental RPC. Swallow errors: if the CLI version predates it,
    // subsequent prompts still use the original model — still correct, just
    // not the requested one.
    if (state.acpSessionId && state.loaded && this.connection) {
      const setter = (this.connection as AcpAgent).unstable_setSessionModel;
      if (typeof setter === 'function') {
        void setter.call(this.connection, {
          sessionId: state.acpSessionId,
          modelId: agentId,
        }).catch((err: unknown) => {
          logger.debug({ provider: this.id, err, agentId }, 'unstable_setSessionModel failed (non-fatal)');
        });
      }
    }
  }

  async send(
    sessionId: string,
    payloadOrMessage: string | ProviderContextPayload,
    attachments?: TransportAttachment[],
    extraSystemPrompt?: string,
  ): Promise<void> {
    if (!this.config || !this.connection) {
      throw this.makeError(PROVIDER_ERROR_CODES.CONNECTION_LOST, 'Gemini ACP server not connected', false);
    }
    const state = this.sessions.get(sessionId);
    if (!state) {
      throw this.makeError(PROVIDER_ERROR_CODES.SESSION_NOT_FOUND, `Unknown Gemini SDK session: ${sessionId}`, false);
    }
    if (state.promptInFlight) {
      throw this.makeError(PROVIDER_ERROR_CODES.PROVIDER_ERROR, 'Gemini SDK session is already busy', true);
    }

    state.cancelled = false;
    // NOTE: currentText/currentMessageId are cleared AFTER ensureSessionReady
    // inside startTurn — not here. `loadSession` replays the full conversation
    // history as `agent_message_chunk` notifications, and if we cleared before
    // resume those replay chunks would accumulate into currentText and be
    // re-emitted as the new turn's content.
    state.toolCalls.clear();
    state.emittedToolSignatures.clear();
    state.lastStatusSignature = null;

    const payload = normalizeProviderPayload(payloadOrMessage, attachments, extraSystemPrompt);
    await this.startTurn(sessionId, state, payload);
  }

  async cancel(sessionId: string): Promise<void> {
    const state = this.sessions.get(sessionId);
    if (!state?.acpSessionId || !state.promptInFlight || !this.connection) return;
    state.cancelled = true;
    // `cancel` is a one-shot notification; the pending prompt() Promise will
    // then resolve with stopReason='cancelled' (or occasionally the agent
    // settles with the partial turn — we handle both in startTurn).
    await this.connection.cancel({ sessionId: state.acpSessionId }).catch((err: unknown) => {
      logger.debug({ provider: this.id, sessionId, err }, 'ACP cancel notification failed (non-fatal)');
    });
  }

  // ── ACP client-side glue ────────────────────────────────────────────────

  private async startAcpServer(config: ProviderConfig): Promise<void> {
    this.teardownChild();

    const binaryPath = this.resolveBinaryPath(config);
    const resolved = resolveExecutableForSpawn(binaryPath);
    const args = [...resolved.prependArgs, '--acp'];
    const child = spawn(resolved.executable, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...((config.env as Record<string, string> | undefined) ?? {}) },
      windowsHide: true,
    });
    this.child = child;

    child.stderr.on('data', (chunk: Buffer | string) => {
      const text = chunk.toString().trim();
      if (!text) return;
      // Gemini CLI writes verbose startup noise to stderr. Keep it at debug to
      // avoid polluting normal daemon logs.
      logger.debug({ provider: this.id, stderr: text }, 'Gemini ACP stderr');
    });

    child.on('exit', (code, signal) => {
      const err = new Error(`Gemini ACP server exited with code=${code} signal=${signal}`);
      const sessions = [...this.sessions.keys()];
      for (const sid of sessions) {
        this.emitError(sid, this.makeError(PROVIDER_ERROR_CODES.CONNECTION_LOST, err.message, false));
      }
      this.child = null;
      this.connection = null;
      this.initPromise = null;
    });
    child.on('error', (err) => {
      logger.error({ provider: this.id, err }, 'Gemini ACP spawn error');
      const sessions = [...this.sessions.keys()];
      for (const sid of sessions) {
        this.emitError(sid, this.makeError(PROVIDER_ERROR_CODES.CONNECTION_LOST, err.message, false));
      }
      this.child = null;
      this.connection = null;
      this.initPromise = null;
    });

    // `ndJsonStream` wants Web streams; convert the Node stdio streams.
    const writable = Writable.toWeb(child.stdin) as WritableStream<Uint8Array>;
    const readable = Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>;
    const stream = ndJsonStream(writable, readable);

    // Construct the ACP connection. The callback receives the Agent handle we
    // can use to call RPC methods; we return a Client impl that handles
    // reverse RPC (requestPermission + session notifications).
    this.connection = new ClientSideConnection(() => this.createClientImpl(), stream);

    // Kick off initialize once; all subsequent calls await the same promise.
    this.initPromise = (async () => {
      const result = await this.connection!.initialize({
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
        'Gemini ACP initialized',
      );
    })().catch((err: unknown) => {
      logger.error({ provider: this.id, err }, 'Gemini ACP initialize failed');
      throw err;
    });

    await this.initPromise;
  }

  /** Build the Client impl passed to ClientSideConnection. The SDK invokes
   *  these methods when the agent sends us requests/notifications. */
  private createClientImpl(): AcpClient {
    return {
      requestPermission: async (
        params: RequestPermissionRequest,
      ): Promise<RequestPermissionResponse> => {
        // We operate exclusively in `yolo` mode after setSessionMode, so this
        // path should never fire — but guard against an agent that ignores the
        // mode for particularly dangerous ops. Respond "cancelled" so the
        // agent aborts the tool call rather than hanging forever. A future
        // revision can plumb this to a real UI approval flow.
        logger.warn(
          { provider: this.id, sessionId: params.sessionId, toolCall: params.toolCall?.title },
          'Gemini ACP requestPermission received in yolo mode; auto-denying',
        );
        return { outcome: { outcome: 'cancelled' } };
      },
      sessionUpdate: async (params: SessionNotification): Promise<void> => {
        this.handleSessionUpdate(params);
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
    state: GeminiSdkSessionState,
    payload: ProviderContextPayload,
  ): Promise<void> {
    state.promptInFlight = true;
    try {
      await this.ensureSessionReady(sessionId, state);
      // Start the turn's delta buffer clean. (During loadSession the replay
      // flag already suppresses accumulation; this belt-and-suspenders reset
      // also catches any stray state left by a prior turn that errored out
      // before settleTurn ran.)
      state.currentText = '';
      state.currentMessageId = null;
      const promptBlocks = this.buildPromptContent(payload);

      // Long-lived call — agent streams sessionUpdate notifications until this
      // resolves with { stopReason }.
      const result: PromptResponse = await this.connection!.prompt({
        sessionId: state.acpSessionId!,
        prompt: promptBlocks,
      });
      this.settleTurn(sessionId, state, result.stopReason);
    } catch (err) {
      state.promptInFlight = false;
      this.clearStatus(sessionId, state);
      this.emitError(sessionId, this.normalizeError(err));
    }
  }

  /** Create the session on the agent if it doesn't exist yet, otherwise
   *  resume it. Applies `yolo` mode once per session. */
  private async ensureSessionReady(
    sessionId: string,
    state: GeminiSdkSessionState,
  ): Promise<void> {
    if (!this.connection) {
      throw this.makeError(PROVIDER_ERROR_CODES.CONNECTION_LOST, 'Gemini ACP connection not ready', false);
    }
    await this.initPromise;

    if (!state.loaded) {
      if (state.acpSessionId) {
        // Resume an existing session (survives across CLI restarts via
        // ~/.gemini/tmp/<project>/chats/<id>.json).
        try {
          const loader = (this.connection as AcpAgent).loadSession;
          if (typeof loader !== 'function') {
            throw new Error('Agent does not implement loadSession (capability mismatch)');
          }
          // `loadSession` streams the full message history back as
          // session/update notifications *before* the RPC resolves. Set the
          // replay flag so handleSessionUpdate drops those history chunks
          // instead of forwarding them to the current-turn delta listeners.
          state.replaying = true;
          let loadResult: LoadSessionResponse;
          try {
            loadResult = await loader.call(this.connection, {
              sessionId: state.acpSessionId,
              cwd: state.cwd,
              mcpServers: [],
            });
          } finally {
            state.replaying = false;
          }
          state.loaded = true;
          this.cacheModelsFromSessionResponse(loadResult);
          this.applySessionMetadata(sessionId, state, loadResult);
        } catch (err) {
          logger.info(
            { provider: this.id, sessionId, acpSessionId: state.acpSessionId, err },
            'Gemini ACP loadSession failed; falling back to newSession',
          );
          this.acpToRoute.delete(state.acpSessionId);
          state.acpSessionId = undefined;
          await this.createFreshAcpSession(sessionId, state);
        }
      } else {
        await this.createFreshAcpSession(sessionId, state);
      }
    }

    if (!state.modeApplied && state.acpSessionId && this.connection) {
      const modeSetter = (this.connection as AcpAgent).setSessionMode;
      if (typeof modeSetter === 'function') {
        await modeSetter.call(this.connection, {
          sessionId: state.acpSessionId,
          modeId: GEMINI_YOLO_MODE,
        }).catch((err: unknown) => {
          // Not fatal — default mode just means the agent will issue
          // requestPermission callbacks that we auto-deny. Worth a log.
          logger.warn({ provider: this.id, sessionId, err }, 'setSessionMode(yolo) failed; tools may be denied');
        });
      }
      state.modeApplied = true;
    }

    // If the caller specified a model, push it once per turn so we follow
    // setSessionAgentId calls that happened before the session was loaded.
    if (state.model && state.acpSessionId && this.connection) {
      const modelSetter = (this.connection as AcpAgent).unstable_setSessionModel;
      if (typeof modelSetter === 'function') {
        await modelSetter.call(this.connection, {
          sessionId: state.acpSessionId,
          modelId: state.model,
        }).catch((err: unknown) => {
          logger.debug({ provider: this.id, sessionId, err }, 'unstable_setSessionModel pre-turn failed (non-fatal)');
        });
      }
    }
  }

  private async createFreshAcpSession(sessionId: string, state: GeminiSdkSessionState): Promise<void> {
    const result: NewSessionResponse = await this.connection!.newSession({
      cwd: state.cwd,
      mcpServers: [],
    });
    state.acpSessionId = result.sessionId;
    state.loaded = true;
    state.modeApplied = false;
    this.acpToRoute.set(state.acpSessionId, sessionId);
    this.cacheModelsFromSessionResponse(result);
    this.applySessionMetadata(sessionId, state, result);
    this.emitSessionInfo(sessionId, { resumeId: state.acpSessionId });
  }

  private cacheModelsFromSessionResponse(result: NewSessionResponse | import('@agentclientprotocol/sdk').LoadSessionResponse): void {
    if (this.cachedModels) return; // already cached
    const models = (result as NewSessionResponse).models;
    if (!models) return;
    const available = models.availableModels;
    if (!Array.isArray(available) || available.length === 0) return;
    this.cachedModels = available.map((m: Record<string, unknown>) => ({
      id: String(m.modelId ?? m.id ?? ''),
      ...(m.name ? { name: String(m.name) } : {}),
    })).filter((m) => m.id);
    this.cachedDefaultModel = typeof models.currentModelId === 'string' ? models.currentModelId : null;
    logger.debug({ provider: this.id, count: this.cachedModels.length, default: this.cachedDefaultModel }, 'Gemini models cached');
  }

  async listModels(force?: boolean): Promise<ProviderModelList> {
    if (force) {
      this.cachedModels = null;
      this.cachedDefaultModel = null;
    }
    if (!this.cachedModels) {
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
          logger.debug({ provider: this.id, err }, 'Gemini model probe failed (non-fatal)');
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
    state: GeminiSdkSessionState,
    info: NewSessionResponse | LoadSessionResponse,
  ): void {
    const currentModel = info.models?.currentModelId;
    if (typeof currentModel === 'string' && !state.model) {
      state.model = currentModel;
      this.emitSessionInfo(sessionId, { model: currentModel });
    }
  }

  private buildPromptContent(payload: ProviderContextPayload): ContentBlock[] {
    // ACP has no separate system-prompt slot. Follow the CodexSdkProvider
    // convention and prepend the resolved systemText as a context preamble so
    // the agent sees the persona/description alongside the user turn.
    const userText = payload.systemText
      ? `Context instructions:\n${payload.systemText}\n\n${payload.assembledMessage}`
      : payload.assembledMessage;
    return [{ type: 'text', text: userText }];
  }

  private settleTurn(
    sessionId: string,
    state: GeminiSdkSessionState,
    stopReason: StopReason,
  ): void {
    state.promptInFlight = false;
    this.clearStatus(sessionId, state);
    const text = state.currentText;
    const messageId = state.currentMessageId ?? `${sessionId}:${randomUUID()}`;
    state.currentText = '';
    state.currentMessageId = null;

    if (stopReason === 'cancelled' || state.cancelled) {
      state.cancelled = false;
      this.emitError(
        sessionId,
        this.makeError(PROVIDER_ERROR_CODES.CANCELLED, 'Gemini turn cancelled', true),
      );
      return;
    }
    if (stopReason === 'refusal') {
      this.emitError(
        sessionId,
        this.makeError(PROVIDER_ERROR_CODES.PROVIDER_ERROR, 'Gemini refused the request', false),
      );
      return;
    }
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
          ...(state.model ? { model: state.model } : {}),
          ...(state.acpSessionId ? { resumeId: state.acpSessionId } : {}),
        },
      };
      for (const cb of this.completeCallbacks) cb(sessionId, msg);
      return;
    }

    // stopReason === 'end_turn' (happy path).
    const msg: AgentMessage = {
      id: messageId,
      sessionId,
      kind: 'text',
      role: 'assistant',
      content: text,
      timestamp: Date.now(),
      status: 'complete',
      metadata: {
        ...(state.model ? { model: state.model } : {}),
        ...(state.acpSessionId ? { resumeId: state.acpSessionId } : {}),
      },
    };
    for (const cb of this.completeCallbacks) cb(sessionId, msg);
  }

  // ── sessionUpdate dispatch ──────────────────────────────────────────────

  private handleSessionUpdate(params: SessionNotification): void {
    const routeId = this.acpToRoute.get(params.sessionId);
    if (!routeId) return;
    const state = this.sessions.get(routeId);
    if (!state) return;

    const update = params.update as SessionUpdate;
    // While loadSession is replaying history, drop every turn-scoped event.
    // We only resurface the persisted agent text/tools when the user actually
    // asks a new question; replay is purely a server-side side-effect of
    // session/load and must not be confused with the current-turn stream.
    if (state.replaying) {
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
          'Gemini ACP mode changed',
        );
        return;
      case 'usage_update': {
        // Map ACP's usage update onto our generic quota/session-info signal.
        // ACP's `UsageUpdate` is experimental; guard every field.
        const u = update as Record<string, unknown>;
        this.emitSessionInfo(routeId, {
          ...(typeof u.tokens === 'object' && u.tokens
            ? { quotaMeta: u.tokens as Record<string, unknown> as never }
            : {}),
        });
        return;
      }
      case 'available_commands_update':
      case 'user_message_chunk':
      case 'plan':
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

  private handleAgentChunk(
    sessionId: string,
    state: GeminiSdkSessionState,
    update: Extract<SessionUpdate, { sessionUpdate: 'agent_message_chunk' }>,
  ): void {
    const chunkText = extractTextFromContent(update.content);
    if (!chunkText) return;
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
    const delta: MessageDelta = {
      messageId: state.currentMessageId,
      type: 'text',
      delta: state.currentText,
      role: 'assistant',
    };
    for (const cb of this.deltaCallbacks) cb(sessionId, delta);
  }

  private handleToolCall(
    sessionId: string,
    state: GeminiSdkSessionState,
    update: Extract<SessionUpdate, { sessionUpdate: 'tool_call' }> & ToolCall,
  ): void {
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
    state: GeminiSdkSessionState,
    update: Extract<SessionUpdate, { sessionUpdate: 'tool_call_update' }> & ToolCallUpdate,
  ): void {
    const existing = state.toolCalls.get(update.toolCallId);
    // ACP spec: every field on ToolCallUpdate is optional and replaces the
    // corresponding field on the original tool_call. We synthesize a stub if
    // the agent updates a tool we never saw start (shouldn't happen, but
    // defensive).
    const merged: MergedToolCall = existing ?? {
      toolCallId: update.toolCallId,
      title: update.title ?? update.toolCallId,
      kind: update.kind ?? undefined,
      status: update.status ?? 'pending',
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

  private emitMergedToolCall(
    sessionId: string,
    state: GeminiSdkSessionState,
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

  private teardownChild(): void {
    // Closing the ACP connection is implicit when we close stdin. The SDK's
    // internal readers finish when stdout ends. tree-kill the CLI so its
    // node wrapper doesn't leave grandchildren behind.
    if (this.child && !this.child.killed) {
      try { this.child.stdin.end(); } catch { /* noop */ }
      void killProcessTree(this.child);
    }
    this.child = null;
    this.connection = null;
  }

  private emitSessionInfo(sessionId: string, info: SessionInfoUpdate): void {
    for (const cb of this.sessionInfoCallbacks) cb(sessionId, info);
  }

  private emitStatus(
    sessionId: string,
    state: GeminiSdkSessionState,
    status: ProviderStatusUpdate,
  ): void {
    const signature = JSON.stringify({ status: status.status, label: status.label ?? null });
    if (state.lastStatusSignature === signature) return;
    state.lastStatusSignature = signature;
    for (const cb of this.statusCallbacks) cb(sessionId, status);
  }

  private clearStatus(sessionId: string, state: GeminiSdkSessionState): void {
    this.emitStatus(sessionId, state, { status: null, label: null });
  }

  private emitError(sessionId: string, error: ProviderError): void {
    for (const cb of this.errorCallbacks) cb(sessionId, error);
  }

  private resolveBinaryPath(config: ProviderConfig | null): string {
    return typeof config?.binaryPath === 'string' && config.binaryPath.trim()
      ? config.binaryPath
      : GEMINI_BIN;
  }

  private makeError(code: string, message: string, recoverable: boolean, details?: unknown): ProviderError {
    return { code, message, recoverable, ...(details !== undefined ? { details } : {}) };
  }

  private normalizeError(err: unknown): ProviderError {
    if (err && typeof err === 'object' && 'code' in err && 'message' in err && 'recoverable' in err) {
      // Already a ProviderError.
      return err as ProviderError;
    }
    const message = err instanceof Error ? err.message : String(err);
    if (err instanceof RequestError) {
      // Map ACP auth_required (code -32000 in Gemini CLI today, but spec
      // reserves this code) onto our AUTH_FAILED so the UI surfaces a
      // login-needed card instead of a generic error.
      if (/auth/i.test(message)) {
        return this.makeError(PROVIDER_ERROR_CODES.AUTH_FAILED, message, false, err);
      }
      return this.makeError(PROVIDER_ERROR_CODES.PROVIDER_ERROR, message, false, err);
    }
    if (/ENOENT|not found|spawn .*gemini/i.test(message)) {
      return this.makeError(PROVIDER_ERROR_CODES.PROVIDER_NOT_FOUND, `Gemini CLI not found: ${message}`, false, err);
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
}

// ── Module-scope pure helpers ─────────────────────────────────────────────

/** Extract a text string from a ContentBlock if it's a textual variant.
 *  Gemini's agent_message_chunk and agent_thought_chunk carry TextContent;
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
