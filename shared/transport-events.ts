/**
 * WsBridge transport events — shared between daemon, server, and web.
 *
 * These events flow over the structured JSON channel of WsBridge:
 *   Daemon → Server bridge → Browser
 *
 * They are NOT mixed with the terminal binary frame channel used by
 * process-backed (tmux) sessions.  Each event carries a `type` string
 * that uniquely identifies the message kind.
 */

import type { ToolCallEvent } from "./agent-message.js";

// ── Agent status ──────────────────────────────────────────────────────────────

/**
 * Observable status of a transport-backed agent.
 *
 * Mirrors `AgentStatus` from `src/agent/detect.ts` but is defined here
 * independently so that `shared/` has no dependency on daemon internals.
 * Keep the two in sync when adding new statuses.
 *
 * - `idle`        — waiting for user input
 * - `streaming`   — receiving token output
 * - `thinking`    — reasoning / extended thinking phase
 * - `tool_running`— executing a tool call
 * - `permission`  — paused, waiting for user approval
 * - `unknown`     — status cannot be determined
 */
export type TransportAgentStatus =
  | "idle"
  | "streaming"
  | "thinking"
  | "tool_running"
  | "permission"
  | "error"
  | "unknown";

/** All valid TransportAgentStatus values for runtime validation. */
export const TRANSPORT_AGENT_STATUSES = new Set<TransportAgentStatus>([
  "idle",
  "streaming",
  "thinking",
  "tool_running",
  "permission",
  "error",
  "unknown",
]);

/** Statuses that indicate the agent is actively doing work. */
export const TRANSPORT_ACTIVE_STATUSES = new Set<TransportAgentStatus>([
  "streaming",
  "thinking",
  "tool_running",
]);

// ── Event type constant object ────────────────────────────────────────────────

/**
 * All transport event `type` strings — single source of truth.
 * Use these constants instead of raw string literals everywhere.
 *
 * @example
 *   if (event.type === TRANSPORT_EVENT.CHAT_DELTA) { ... }
 */
export const TRANSPORT_EVENT = {
  /** Incremental token/tool delta from the agent. */
  CHAT_DELTA: "chat.delta",
  /** A message has finished streaming (no more deltas). */
  CHAT_COMPLETE: "chat.complete",
  /** A non-recoverable error occurred for a message. */
  CHAT_ERROR: "chat.error",
  /** Agent status changed (idle / streaming / tool_running / …). */
  CHAT_STATUS: "chat.status",
  /** A tool call started or completed. */
  CHAT_TOOL: "chat.tool",
  /** Agent is requesting user approval before proceeding. */
  CHAT_APPROVAL: "chat.approval",
} as const;

/** Union of all TRANSPORT_EVENT values (for exhaustive type checks). */
export type TransportEventType =
  (typeof TRANSPORT_EVENT)[keyof typeof TRANSPORT_EVENT];

// ── Browser relay message name constant object ────────────────────────────────

/**
 * Browser relay WebSocket message names — used for subscribe / unsubscribe
 * handshakes and provider-status broadcasts between browser and server bridge.
 *
 * @example
 *   ws.send(JSON.stringify({ type: TRANSPORT_MSG.CHAT_SUBSCRIBE, sessionId }))
 */
export const TRANSPORT_MSG = {
  /** Browser → Bridge: subscribe to transport events for a session. */
  CHAT_SUBSCRIBE: "chat.subscribe",
  /** Browser → Bridge: stop receiving transport events for a session. */
  CHAT_UNSUBSCRIBE: "chat.unsubscribe",
  /** Daemon → Browser: provisional transport chat history replay for an already-running session. */
  CHAT_HISTORY: "chat.history",
  /** Bridge → Browser: agent is requesting approval before continuing. */
  CHAT_APPROVAL: "chat.approval",
  /** Browser → Daemon: answer a pending transport approval request. */
  APPROVAL_RESPONSE: "chat.approval_response",
  /** Bridge → Browser: broadcast of agent/provider availability status. */
  PROVIDER_STATUS: "provider.status",
  /** Browser → Daemon: request list of remote sessions from a provider. */
  LIST_SESSIONS: "provider.list_sessions",
  /** Daemon → Browser: response with remote sessions list. */
  SESSIONS_RESPONSE: "provider.sessions_response",
} as const;

/** Union of all TRANSPORT_MSG values. */
export type TransportMsgType =
  (typeof TRANSPORT_MSG)[keyof typeof TRANSPORT_MSG];

/** All relay message types that should be forwarded from bridge to browser. */
export const TRANSPORT_RELAY_TYPES = new Set([
  TRANSPORT_EVENT.CHAT_DELTA,
  TRANSPORT_EVENT.CHAT_COMPLETE,
  TRANSPORT_EVENT.CHAT_ERROR,
  TRANSPORT_EVENT.CHAT_STATUS,
  TRANSPORT_EVENT.CHAT_TOOL,
  TRANSPORT_EVENT.CHAT_APPROVAL,
  TRANSPORT_MSG.CHAT_HISTORY,
  TRANSPORT_MSG.APPROVAL_RESPONSE,
  TRANSPORT_MSG.PROVIDER_STATUS,
]);

// ── Event union type ──────────────────────────────────────────────────────────

/**
 * Discriminated union of all transport events that flow over the bridge.
 * Each member's `type` field matches the corresponding TRANSPORT_EVENT constant.
 */
export type TransportEvent =
  | {
      /** Incremental token or tool-input delta from the agent. */
      type: typeof TRANSPORT_EVENT.CHAT_DELTA;
      sessionId: string;
      messageId: string;
      /** The incremental text fragment. */
      delta: string;
      /** Whether this delta is a plain text fragment or tool-use input fragment. */
      deltaType?: "text" | "tool_use";
    }
  | {
      /** The message has finished — no more deltas will follow. */
      type: typeof TRANSPORT_EVENT.CHAT_COMPLETE;
      sessionId: string;
      messageId: string;
    }
  | {
      /** A non-recoverable error occurred for this message. */
      type: typeof TRANSPORT_EVENT.CHAT_ERROR;
      sessionId: string;
      /** Human-readable error description. */
      error: string;
      /** Optional machine-readable error code. */
      code?: string;
    }
  | {
      /** Agent status changed. */
      type: typeof TRANSPORT_EVENT.CHAT_STATUS;
      sessionId: string;
      status: TransportAgentStatus;
    }
  | {
      /** A tool call started or completed. */
      type: typeof TRANSPORT_EVENT.CHAT_TOOL;
      sessionId: string;
      messageId: string;
      tool: ToolCallEvent;
    }
  | {
      /** Agent is paused and requires explicit user approval before continuing. */
      type: typeof TRANSPORT_EVENT.CHAT_APPROVAL;
      sessionId: string;
      /** Unique ID for this approval request (echoed back in the approval response). */
      requestId: string;
      /** Human-readable description of what the agent is asking permission to do. */
      description: string;
      /** Tool name that triggered the approval request, if available. */
      tool?: string;
    }
  | {
      /** Browser-originated approval response broadcast back to transport subscribers. */
      type: typeof TRANSPORT_MSG.APPROVAL_RESPONSE;
      sessionId: string;
      requestId: string;
      approved: boolean;
    };
