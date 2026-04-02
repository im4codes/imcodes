/**
 * TransportProvider — second-layer abstraction between IM.codes and external agent services.
 *
 * Each provider (OpenClaw, MiniMax, CC SDK, etc.) implements the TransportProvider interface.
 * The connection mode determines how the daemon manages sessions and message history.
 *
 * Three connection modes:
 *   - persistent  (OpenClaw):        Long-lived WS, provider owns sessions.
 *   - per-request (MiniMax/DeepSeek): HTTP per request, daemon self-manages history.
 *   - local-sdk   (CC SDK/Codex SDK): Local SDK calls, shared session ownership.
 */

import type { AgentMessage, MessageDelta, ToolCallEvent } from '../../shared/agent-message.js';

// Re-export shared types used by consumers of this module so they can import from one place.
export type { AgentMessage, MessageDelta, ToolCallEvent };

// ── String constants ────────────────────────────────────────────────────────

/** All valid connection mode values — import instead of hardcoding the string. */
export const CONNECTION_MODES = {
  PERSISTENT:  'persistent',
  PER_REQUEST: 'per-request',
  LOCAL_SDK:   'local-sdk',
} as const;

/** All valid session ownership values — import instead of hardcoding the string. */
export const SESSION_OWNERSHIP = {
  PROVIDER: 'provider',
  LOCAL:    'local',
  SHARED:   'shared',
} as const;

/** Common provider error codes. Import instead of hardcoding. */
export const PROVIDER_ERROR_CODES = {
  AUTH_FAILED:      'AUTH_FAILED',
  CONFIG_ERROR:     'CONFIG_ERROR',
  CONNECTION_LOST:  'CONNECTION_LOST',
  SESSION_NOT_FOUND:'SESSION_NOT_FOUND',
  RATE_LIMITED:     'RATE_LIMITED',
  PROVIDER_ERROR:   'PROVIDER_ERROR',
} as const;

// ── Derived types ───────────────────────────────────────────────────────────

/** Connection mode determines how the transport manages the agent lifecycle. */
export type ConnectionMode = typeof CONNECTION_MODES[keyof typeof CONNECTION_MODES];

/** Who owns the session state and is responsible for history management. */
export type SessionOwnership = typeof SESSION_OWNERSHIP[keyof typeof SESSION_OWNERSHIP];

/** Error code from a provider operation. */
export type ProviderErrorCode = typeof PROVIDER_ERROR_CODES[keyof typeof PROVIDER_ERROR_CODES];

// ── Supporting types ────────────────────────────────────────────────────────

/**
 * Provider capability flags.
 * Consumers MUST check the relevant flag before calling optional interface methods.
 */
export interface ProviderCapabilities {
  /** Provider can stream partial output via onDelta. */
  streaming: boolean;
  /** Provider supports tool-call events (onToolCall). */
  toolCalling: boolean;
  /** Provider can request human approval (onApprovalRequest / respondApproval). */
  approval: boolean;
  /** Provider supports reconnecting to an existing remote session (restoreSession). */
  sessionRestore: boolean;
  /** Provider maintains conversation history across multiple turns. */
  multiTurn: boolean;
  /** Provider can accept file/image attachments in send(). */
  attachments: boolean;
}

/**
 * Provider-specific connection configuration.
 * Additional keys are allowed for provider-specific options.
 */
export interface ProviderConfig {
  /** Base URL for the provider's API or WebSocket endpoint. */
  url?: string;
  /** API key for authentication. */
  apiKey?: string;
  /** Auth token (alternative to apiKey for token-based auth). */
  token?: string;
  /** Identifier of the agent/model to use on the provider side. */
  agentId?: string;
  /** Allow arbitrary provider-specific options. */
  [key: string]: unknown;
}

/** Parameters for creating a new session on the provider. */
export interface SessionConfig {
  /** Local session key used by the daemon to identify this session. */
  sessionKey: string;
  /** Working directory for providers that need local project context. */
  cwd?: string;
  /** Provider-side agent/model identifier (overrides ProviderConfig.agentId). */
  agentId?: string;
  /** Human-readable label for this session. */
  label?: string;
  /** Persona/system prompt injection — used for session description/role. */
  description?: string;
  /** Parent session key for sub-sessions. */
  parentSessionKey?: string;
  /** If binding to an already-existing remote session, use this key directly. */
  bindExistingKey?: string;
  /** Skip the sessions.create RPC — session already exists on provider (auto-sync bind). */
  skipCreate?: boolean;
}

/** Structured error emitted by a provider. */
export interface ProviderError {
  /** Machine-readable error code. Use values from PROVIDER_ERROR_CODES. */
  code: string;
  /** Human-readable description. */
  message: string;
  /** Whether the caller may retry after this error without reconnecting. */
  recoverable: boolean;
  /** Optional raw details from the provider (for logging/debugging). */
  details?: unknown;
}

/** Info about a remote session returned by listSessions(). */
export interface RemoteSessionInfo {
  /** Provider-side session key or identifier. */
  key: string;
  /** Human-readable session name. */
  displayName?: string;
  /** Agent/model the session is associated with. */
  agentId?: string;
  /** Unix epoch milliseconds of the last update. */
  updatedAt?: number;
  /** Context window usage as a percentage (0–100), if available. */
  percentUsed?: number;
}

/** Approval request emitted when the agent needs human permission to proceed. */
export interface ApprovalRequest {
  /** Unique identifier for this approval request. */
  id: string;
  /** Human-readable description of what the agent wants to do. */
  description: string;
  /** Name of the tool requesting approval, if applicable. */
  tool?: string;
}

// ── TransportProvider interface ─────────────────────────────────────────────

/**
 * TransportProvider is the adapter interface between IM.codes and an external agent service.
 *
 * Implement this interface for each provider (e.g. OpenClaw, MiniMax, CC SDK).
 * The session-manager selects the appropriate provider based on the agent type and
 * routes messages through it instead of through a tmux process.
 *
 * Lifecycle:
 *   1. connect(config)  — initialise and validate; not necessarily a physical connection.
 *   2. createSession()  — obtain a session ID from the provider.
 *   3. send()           — send user messages; receive deltas/completions via callbacks.
 *   4. endSession()     — clean up a single session.
 *   5. disconnect()     — release all provider resources and stop background activity.
 */
export interface TransportProvider {
  /** Unique stable identifier for this provider implementation (e.g. 'openclaw', 'minimax'). */
  readonly id: string;

  /** How this provider manages its connection. See CONNECTION_MODES. */
  readonly connectionMode: ConnectionMode;

  /** Who is responsible for session state and history. See SESSION_OWNERSHIP. */
  readonly sessionOwnership: SessionOwnership;

  /** Declare which optional capabilities this provider supports. */
  readonly capabilities: ProviderCapabilities;

  // ── Core methods — all providers must implement ──────────────────────────

  /**
   * Initialise the provider with the given configuration.
   * For persistent providers this may open a WebSocket; for per-request providers
   * this typically just validates config and sets internal state.
   * @throws {ProviderError} if configuration is invalid or the initial handshake fails.
   */
  connect(config: ProviderConfig): Promise<void>;

  /**
   * Release all resources held by this provider and stop any background activity
   * (keep-alive timers, background reconnect loops, etc.).
   * Safe to call multiple times.
   */
  disconnect(): Promise<void>;

  /**
   * Send a user message to the given session.
   * @param sessionId  - The session ID returned by createSession().
   * @param message    - The user's text message.
   * @param attachments - Optional file/image attachments (only when capabilities.attachments is true).
   */
  send(sessionId: string, message: string, attachments?: unknown[], extraSystemPrompt?: string): Promise<void>;

  /**
   * Register a callback to receive incremental output deltas while the agent is streaming.
   * Only meaningful when capabilities.streaming is true.
   * @returns Unsubscribe function that removes the callback.
   */
  onDelta(cb: (sessionId: string, delta: MessageDelta) => void): () => void;

  /**
   * Register a callback to receive the final completed message after the agent finishes a turn.
   * @returns Unsubscribe function that removes the callback.
   */
  onComplete(cb: (sessionId: string, message: AgentMessage) => void): () => void;

  /**
   * Register a callback to receive provider errors scoped to a session.
   * @returns Unsubscribe function that removes the callback.
   */
  onError(cb: (sessionId: string, error: ProviderError) => void): () => void;

  /**
   * Create a new session on the provider.
   * @param config - Session creation parameters.
   * @returns The provider-assigned session ID to pass to subsequent calls.
   */
  createSession(config: SessionConfig): Promise<string>;

  /**
   * End a session and release any provider-side resources associated with it.
   * @param sessionId - The session ID returned by createSession().
   */
  endSession(sessionId: string): Promise<void>;

  // ── Optional methods — gated by capabilities ─────────────────────────────

  /**
   * Register a callback for discrete tool-call events.
   * Only call when capabilities.toolCalling is true.
   */
  onToolCall?(cb: (sessionId: string, tool: ToolCallEvent) => void): void;

  /**
   * Register a callback for approval requests from the agent.
   * Only call when capabilities.approval is true.
   */
  onApprovalRequest?(cb: (sessionId: string, req: ApprovalRequest) => void): void;

  /**
   * Respond to a pending approval request.
   * Only call when capabilities.approval is true.
   * @param sessionId - The session the approval belongs to.
   * @param requestId - The ApprovalRequest.id to respond to.
   * @param approved  - Whether the user granted or denied the request.
   */
  respondApproval?(sessionId: string, requestId: string, approved: boolean): Promise<void>;

  /**
   * Attempt to reconnect to an existing remote session by its provider-side ID.
   * Only call when capabilities.sessionRestore is true.
   * @returns true if the session was successfully restored, false if not found or expired.
   */
  restoreSession?(sessionId: string): Promise<boolean>;

  /**
   * Enumerate all remote sessions visible to this provider.
   * Useful for session-picker UIs and resuming orphaned sessions.
   * Only call when capabilities.sessionRestore is true.
   */
  listSessions?(): Promise<RemoteSessionInfo[]>;
}
