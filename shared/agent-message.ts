/**
 * Transport-backed session message model — shared between daemon, server, and web.
 *
 * Process-backed (tmux) sessions continue to use binary terminal frames.
 * These types are ONLY for transport sessions (e.g. Claude Code SDK, API-backed agents)
 * that produce structured message streams instead of raw terminal output.
 */

// ── String constant unions ────────────────────────────────────────────────────

/** Discriminant for AgentMessage.kind — what kind of content this message carries. */
export type AgentMessageKind = 'text' | 'tool_use' | 'tool_result' | 'system' | 'approval';

/** Discriminant for AgentMessage.role — who sent this message. */
export type AgentMessageRole = 'user' | 'assistant' | 'system';

/** Lifecycle status of a streamed message. */
export type AgentMessageStatus = 'streaming' | 'complete' | 'error';

/** Type of incremental delta in a MessageDelta event. */
export type MessageDeltaType = 'text' | 'tool_use' | 'tool_result';

// ── Runtime sets (useful for validation) ─────────────────────────────────────

/** All valid AgentMessageKind values. */
export const AGENT_MESSAGE_KINDS = new Set<AgentMessageKind>([
  'text', 'tool_use', 'tool_result', 'system', 'approval',
]);

/** All valid AgentMessageRole values. */
export const AGENT_MESSAGE_ROLES = new Set<AgentMessageRole>([
  'user', 'assistant', 'system',
]);

/** All valid AgentMessageStatus values. */
export const AGENT_MESSAGE_STATUSES = new Set<AgentMessageStatus>([
  'streaming', 'complete', 'error',
]);

/** All valid MessageDeltaType values. */
export const MESSAGE_DELTA_TYPES = new Set<MessageDeltaType>([
  'text', 'tool_use', 'tool_result',
]);

// ── Terminal status groups ────────────────────────────────────────────────────

/** Message statuses that indicate the message will receive no further updates. */
export const AGENT_MESSAGE_TERMINAL_STATUSES = new Set<AgentMessageStatus>([
  'complete', 'error',
]);

// ── Object model ──────────────────────────────────────────────────────────────

/**
 * A single message in a transport-backed agent session.
 * Stored in the session message log and relayed to browser clients.
 */
export interface AgentMessage {
  /** Unique message identifier (e.g. nanoid). */
  id: string;
  /** ID of the session this message belongs to. */
  sessionId: string;
  /** What kind of content this message carries. */
  kind: AgentMessageKind;
  /** Who sent this message. */
  role: AgentMessageRole;
  /** Serialised text content (for tool_use/tool_result, JSON-encoded). */
  content: string;
  /** Unix epoch milliseconds when the message was created. */
  timestamp: number;
  /** Lifecycle status of this message. */
  status: AgentMessageStatus;
  /** Optional opaque metadata (tool name, model, token counts, etc.). */
  metadata?: Record<string, unknown>;
}

// ── Streaming delta ───────────────────────────────────────────────────────────

/**
 * Incremental update streamed while a message is being generated.
 * Sent as part of a TransportEvent and applied on the client to build
 * up the final AgentMessage content.
 */
export interface MessageDelta {
  /** ID of the AgentMessage this delta belongs to. */
  messageId: string;
  /** What kind of content this delta carries. */
  type: MessageDeltaType;
  /** Incremental text fragment (empty string when no text content for this delta). */
  delta: string;
  /** Always 'assistant' — only the assistant streams deltas. */
  role: 'assistant';
  /** Present when type is 'tool_use' or 'tool_result'. */
  toolUse?: ToolUseDelta;
}

/**
 * Inline tool-call metadata attached to a MessageDelta.
 * Describes a single tool invocation and its running state.
 */
export interface ToolUseDelta {
  /** Unique tool-call identifier assigned by the agent. */
  id: string;
  /** Tool name (e.g. 'Bash', 'Read', 'Edit'). */
  name: string;
  /** Whether the tool is still running, finished, or errored. */
  status: 'running' | 'complete' | 'error';
  /** Structured input passed to the tool (present once fully streamed). */
  input?: unknown;
  /** Raw text output from the tool (present after completion). */
  output?: string;
  /** Structured detail payload for richer UI rendering and future provider parity. */
  detail?: ToolCallDetail;
}

/**
 * Provider-neutral structured tool details.
 * Providers should populate this with the richest stable shape they have.
 */
export interface ToolCallDetail {
  /** Provider/tool-specific kind (e.g. commandExecution, webSearch, tool_use). */
  kind?: string;
  /** Human-readable subtitle or short summary. */
  summary?: string;
  /** Full structured input payload. */
  input?: unknown;
  /** Full structured output payload. */
  output?: unknown;
  /** Extra machine-readable metadata. */
  meta?: Record<string, unknown>;
  /** Raw provider item/block for debugging and future UI expansion. */
  raw?: unknown;
}

// ── Tool call event (standalone, used in TransportEvent) ─────────────────────

/**
 * A snapshot of a single tool call, emitted as a discrete event.
 * Unlike ToolUseDelta (which is a streaming fragment), this represents
 * the full state of a tool call at the moment of the event.
 */
export interface ToolCallEvent {
  /** Unique tool-call identifier assigned by the agent. */
  id: string;
  /** Tool name (e.g. 'Bash', 'Read', 'Edit'). */
  name: string;
  /** Current execution status. */
  status: 'running' | 'complete' | 'error';
  /** Structured input passed to the tool. */
  input?: unknown;
  /** Raw text output from the tool (present after completion). */
  output?: string;
  /** Structured detail payload for richer UI rendering and future provider parity. */
  detail?: ToolCallDetail;
}
