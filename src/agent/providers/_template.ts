/**
 * Provider template — copy this file to implement a new TransportProvider.
 *
 * Steps:
 * 1. Copy to `src/agent/providers/your-provider.ts`
 * 2. Implement all required methods (search for TODO).
 * 3. Register in `src/agent/provider-registry.ts` → createProvider().
 * 4. Add your agent type to `src/agent/detect.ts` → TransportAgent union.
 * 5. Add connect/disconnect handling if needed in `src/agent/session-manager.ts`.
 *
 * Connection modes:
 * - persistent:   Long-lived connection (WebSocket). Example: OpenClaw.
 *                 connect() establishes and maintains the connection; the provider
 *                 tracks session state server-side (sessionOwnership: 'provider').
 * - per-request:  New HTTP request per message. Example: MiniMax, DeepSeek.
 *                 connect() only validates config (no persistent connection).
 *                 send() creates a new HTTP request each time.
 *                 History must be managed locally (sessionOwnership: 'local').
 * - local-sdk:    In-process SDK calls. Example: Claude Code SDK.
 *                 connect() loads/validates the SDK; session ownership is 'shared'.
 */

import type {
  TransportProvider,
  ProviderConfig,
  ProviderCapabilities,
  SessionConfig,
  ProviderError,
} from '../transport-provider.js';
import {
  CONNECTION_MODES,
  SESSION_OWNERSHIP,
  PROVIDER_ERROR_CODES,
} from '../transport-provider.js';
import type { AgentMessage, MessageDelta } from '../../../shared/agent-message.js';
import logger from '../../util/logger.js';

// TODO: Replace 'your-provider' with the unique stable id for your provider.
const PROVIDER_ID = 'your-provider';

export class YourProvider implements TransportProvider {
  // ── Identity & mode ────────────────────────────────────────────────────────

  readonly id = PROVIDER_ID;

  // TODO: Set the appropriate connection mode.
  //   CONNECTION_MODES.PERSISTENT  — long-lived WebSocket
  //   CONNECTION_MODES.PER_REQUEST — HTTP per message
  //   CONNECTION_MODES.LOCAL_SDK   — in-process SDK
  readonly connectionMode = CONNECTION_MODES.PER_REQUEST;

  // TODO: Set who owns session state.
  //   SESSION_OWNERSHIP.PROVIDER — provider tracks history (persistent)
  //   SESSION_OWNERSHIP.LOCAL    — daemon must manage history (per-request)
  //   SESSION_OWNERSHIP.SHARED   — both sides participate (local-sdk)
  readonly sessionOwnership = SESSION_OWNERSHIP.LOCAL;

  readonly capabilities: ProviderCapabilities = {
    // TODO: Set capabilities to match what your provider actually supports.
    streaming:      false,
    toolCalling:    false,
    approval:       false,
    sessionRestore: false,
    multiTurn:      true,
    attachments:    false,
  };

  // ── Private state ──────────────────────────────────────────────────────────

  private config: ProviderConfig | null = null;

  /** Registered callbacks (initialise each array even if you don't use streaming). */
  private deltaCallbacks:    Array<(sessionId: string, delta: MessageDelta) => void> = [];
  private completeCallbacks: Array<(sessionId: string, message: AgentMessage) => void> = [];
  private errorCallbacks:    Array<(sessionId: string, error: ProviderError) => void> = [];

  // ── Core methods ───────────────────────────────────────────────────────────

  /**
   * Initialise the provider with user-supplied config.
   *
   * For persistent providers: open the WebSocket / SDK connection here.
   * For per-request providers: validate required fields (apiKey, url, …) and
   *   store them — no network call needed.
   *
   * Throw a ProviderError (use makeError below) if config is missing or invalid.
   */
  async connect(config: ProviderConfig): Promise<void> {
    // TODO: validate required config fields.
    if (!config.apiKey) {
      throw this.makeError(PROVIDER_ERROR_CODES.CONFIG_ERROR, 'apiKey is required', false);
    }
    this.config = config;
    logger.info({ provider: this.id }, 'Provider connected');
  }

  /**
   * Release all resources (timers, sockets, SDK handles).
   * Must be safe to call multiple times.
   */
  async disconnect(): Promise<void> {
    // TODO: tear down any persistent connections / cancel timers.
    this.config = null;
    logger.info({ provider: this.id }, 'Provider disconnected');
  }

  /**
   * Send a user message to the given session.
   *
   * For persistent providers: forward the message over the existing connection.
   * For per-request providers: build and fire an HTTP request; call completeCallbacks
   *   (and deltaCallbacks if streaming) with the result before returning.
   *
   * @param sessionId   - The session ID returned by createSession().
   * @param message     - The user's text content.
   * @param attachments - Only present when capabilities.attachments is true.
   */
  async send(sessionId: string, _message: string, _attachments?: unknown[]): Promise<void> {
    if (!this.config) {
      throw this.makeError(PROVIDER_ERROR_CODES.CONNECTION_LOST, 'Not connected', false);
    }

    // TODO: implement message sending.
    // For per-request providers, fire the HTTP call here, then emit:
    //
    //   const reply = await callProviderApi(this.config, sessionId, message);
    //   const agentMessage: AgentMessage = {
    //     id: randomUUID(),
    //     sessionId,
    //     kind: 'text',
    //     role: 'assistant',
    //     content: reply,
    //     timestamp: Date.now(),
    //     status: 'complete',
    //   };
    //   this.completeCallbacks.forEach((cb) => cb(sessionId, agentMessage));

    logger.debug({ provider: this.id, sessionId }, 'send() — not yet implemented');
  }

  /** Register a callback for streaming deltas. Returns unsubscribe function. */
  onDelta(cb: (sessionId: string, delta: MessageDelta) => void): () => void {
    this.deltaCallbacks.push(cb);
    return () => { const i = this.deltaCallbacks.indexOf(cb); if (i >= 0) this.deltaCallbacks.splice(i, 1); };
  }

  /** Register a callback for the final completed message. Returns unsubscribe function. */
  onComplete(cb: (sessionId: string, message: AgentMessage) => void): () => void {
    this.completeCallbacks.push(cb);
    return () => { const i = this.completeCallbacks.indexOf(cb); if (i >= 0) this.completeCallbacks.splice(i, 1); };
  }

  /** Register a callback for provider errors. Returns unsubscribe function. */
  onError(cb: (sessionId: string, error: ProviderError) => void): () => void {
    this.errorCallbacks.push(cb);
    return () => { const i = this.errorCallbacks.indexOf(cb); if (i >= 0) this.errorCallbacks.splice(i, 1); };
  }

  /**
   * Create a new session on the provider.
   * Return the provider-assigned session ID that will be passed to send() and endSession().
   *
   * For per-request providers with sessionOwnership 'local', this can simply return
   * config.sessionKey (the daemon uses it as the key locally).
   */
  async createSession(config: SessionConfig): Promise<string> {
    // TODO: create a remote session if required, or just return the local key.
    return config.sessionKey;
  }

  /**
   * End a session and release any provider-side resources.
   * For per-request providers with no remote session state, this is a no-op.
   */
  async endSession(_sessionId: string): Promise<void> {
    // TODO: delete remote session if the provider supports it.
  }

  // ── Optional capability methods — implement only if the capability is true ──

  // onToolCall?(cb: (sessionId: string, tool: ToolCallEvent) => void): () => void { ... }
  // onApprovalRequest?(cb: (sessionId: string, req: ApprovalRequest) => void): void { ... }
  // respondApproval?(sessionId: string, requestId: string, approved: boolean): Promise<void> { ... }
  // restoreSession?(sessionId: string): Promise<boolean> { ... }
  // listSessions?(): Promise<RemoteSessionInfo[]> { ... }

  // ── Helpers ────────────────────────────────────────────────────────────────

  private makeError(code: string, message: string, recoverable: boolean, details?: unknown): ProviderError {
    return { code, message, recoverable, details };
  }
}
