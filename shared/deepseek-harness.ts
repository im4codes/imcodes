/**
 * Wire protocol between the IM.codes daemon and the DeepSeek Harness bridge
 * plugin.
 *
 * DeepSeek Harness (`dsh`) is a Cordis plugin runtime, not a callable SDK: the
 * only way to observe token-level output is to mount a plugin inside its
 * process and subscribe to `session/event`. Its own automation surfaces are
 * both unusable here — the `headless` profile answers exactly one task and
 * prints only the final text, and `@deepseek-ai/dsh-acp` deliberately emits one
 * chunk per COMMITTED assistant message ("trades token-by-token latency for a
 * clean automation result") with no session resume and no MCP.
 *
 * So the daemon boots the stock `headless` profile with one generated overlay
 * that mounts our bridge, and the two halves speak newline-delimited JSON over
 * the child's stdio:
 * stdout carries bridge → daemon events, stdin carries daemon → bridge
 * commands. Stdout is protocol-only; the bridge must never print anything else
 * there. Both directions are defined here so neither side can drift.
 */

/** Commands the daemon writes to the bridge's stdin. */
export const DSH_BRIDGE_COMMAND = {
  /** Submit user text as a new turn on the live agent. */
  PROMPT: 'prompt',
  /** Cancel the in-flight turn without tearing the agent down. */
  CANCEL: 'cancel',
  /** Tear the agent down and exit the process. */
  SHUTDOWN: 'shutdown',
} as const;

/** Events the bridge writes to its stdout. */
export const DSH_BRIDGE_EVENT = {
  /** Agent created or resumed; carries the durable session id used for resume. */
  READY: 'ready',
  /** Incremental assistant text (`assistant/chunk` → `text-delta`). */
  DELTA: 'delta',
  /** Model is reasoning (`assistant/chunk` → `reasoning-delta`); carries no content. */
  REASONING: 'reasoning',
  /** A committed assistant message — the authoritative text for the turn. */
  MESSAGE: 'message',
  /** Tool lifecycle, from `tool/call` and `tool/result`. */
  TOOL: 'tool',
  /** Token accounting (`assistant/chunk` → `usage`). */
  USAGE: 'usage',
  /** The agent returned to idle; `reason` mirrors the harness turn outcome. */
  TURN_END: 'turnEnd',
  /** A failure the bridge could not attribute to a turn. */
  ERROR: 'error',
} as const;

/** Tool states the bridge reports, mapped onto IM.codes tool-call statuses. */
export const DSH_BRIDGE_TOOL_STATUS = {
  RUNNING: 'running',
  COMPLETE: 'complete',
  ERROR: 'error',
} as const;

export type DshBridgeToolStatus = (typeof DSH_BRIDGE_TOOL_STATUS)[keyof typeof DSH_BRIDGE_TOOL_STATUS];

/** Turn outcomes the harness reports through `turn/end`. */
export const DSH_BRIDGE_TURN_REASON = {
  COMPLETED: 'completed',
  CANCELLED: 'cancelled',
  ERROR: 'error',
} as const;

export type DshBridgeTurnReason = (typeof DSH_BRIDGE_TURN_REASON)[keyof typeof DSH_BRIDGE_TURN_REASON];

export interface DshBridgePromptCommand {
  type: typeof DSH_BRIDGE_COMMAND.PROMPT;
  text: string;
}

export interface DshBridgeCancelCommand {
  type: typeof DSH_BRIDGE_COMMAND.CANCEL;
}

export interface DshBridgeShutdownCommand {
  type: typeof DSH_BRIDGE_COMMAND.SHUTDOWN;
}

export type DshBridgeCommand =
  | DshBridgePromptCommand
  | DshBridgeCancelCommand
  | DshBridgeShutdownCommand;

export interface DshBridgeReadyEvent {
  type: typeof DSH_BRIDGE_EVENT.READY;
  sessionId: string;
  provider?: string;
  model?: string;
  /** True when the agent was restored from a persisted session rather than created. */
  resumed: boolean;
}

export interface DshBridgeDeltaEvent {
  type: typeof DSH_BRIDGE_EVENT.DELTA;
  text: string;
}

export interface DshBridgeReasoningEvent {
  type: typeof DSH_BRIDGE_EVENT.REASONING;
}

export interface DshBridgeMessageEvent {
  type: typeof DSH_BRIDGE_EVENT.MESSAGE;
  text: string;
}

export interface DshBridgeToolEvent {
  type: typeof DSH_BRIDGE_EVENT.TOOL;
  id: string;
  name: string;
  status: DshBridgeToolStatus;
  input?: unknown;
  output?: string;
}

export interface DshBridgeUsageEvent {
  type: typeof DSH_BRIDGE_EVENT.USAGE;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
}

export interface DshBridgeTurnEndEvent {
  type: typeof DSH_BRIDGE_EVENT.TURN_END;
  reason: DshBridgeTurnReason;
  /** Present when `reason` is `error`. */
  message?: string;
  code?: string;
}

export interface DshBridgeErrorEvent {
  type: typeof DSH_BRIDGE_EVENT.ERROR;
  message: string;
  code?: string;
}

export type DshBridgeEvent =
  | DshBridgeReadyEvent
  | DshBridgeDeltaEvent
  | DshBridgeReasoningEvent
  | DshBridgeMessageEvent
  | DshBridgeToolEvent
  | DshBridgeUsageEvent
  | DshBridgeTurnEndEvent
  | DshBridgeErrorEvent;

/**
 * Harness `session/event` names the bridge consumes. These are internal to
 * DeepSeek Harness (developer preview) rather than a declared public API, so
 * they are pinned in one place: if a harness release renames one, the bridge
 * stops emitting and this constant is the single edit.
 */
export const DSH_SESSION_EVENT = {
  ASSISTANT_CHUNK: 'assistant/chunk',
  ASSISTANT_MESSAGE: 'assistant/message',
  TOOL_CALL: 'tool/call',
  TOOL_RESULT: 'tool/result',
  TURN_END: 'turn/end',
} as const;

/** `assistant/chunk` payload discriminators the bridge reads. */
export const DSH_CHUNK_TYPE = {
  TEXT_DELTA: 'text-delta',
  REASONING_DELTA: 'reasoning-delta',
  USAGE: 'usage',
} as const;

/** Cordis plugin id of the bridge row the daemon inserts into the overlay. */
export const DSH_BRIDGE_PLUGIN_ID = 'imcodes-dsh-bridge';

/** Cordis loader row id of the agent's default model selection. */
export const DSH_AGENT_DEFAULT_MODEL_ROW_ID = 'agent-default-model';

/**
 * LLM config the daemon writes into the overlay so dsh talks to the
 * ccPreset's endpoint on the first turn (settings-based, not env).
 */
export interface DshLlmConfig {
  /** Registered provider route key (e.g. the normalized preset name 'minimax'). */
  provider: string;
  /** Provider-owned model id. */
  model: string;
  /** Endpoint / base URL of the provider. */
  baseUrl?: string;
  /** API key / auth token for the provider. */
  apiKey?: string;
}

/** Environment variable carrying the session id the bridge should resume. */
export const DSH_BRIDGE_RESUME_ENV = 'IMCODES_DSH_RESUME_SESSION_ID';

/** Environment variable carrying the working directory for a fresh agent. */
export const DSH_BRIDGE_CWD_ENV = 'IMCODES_DSH_CWD';

/**
 * Environment variable pinning the model for the agent the bridge creates.
 *
 * The model rides here rather than in the loader overlay because the harness's
 * `agent-default-model` row needs a provider ROUTE as well, and that route is
 * only knowable after a first boot. `agents.create()` takes the model directly,
 * so the bridge can honour IM.codes' choice on the very first turn while the
 * route still comes from the user's own `~/.dsh` selection.
 */
export const DSH_BRIDGE_MODEL_ENV = 'IMCODES_DSH_MODEL';

/** Hoisted: this is consulted once per streamed token, so it must not allocate. */
const KNOWN_DSH_BRIDGE_EVENTS = new Set<string>(Object.values(DSH_BRIDGE_EVENT));

/** Parse one NDJSON line into a bridge event, or null when it is not one. */
export function parseDshBridgeEvent(line: string): DshBridgeEvent | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed[0] !== '{') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const type = (parsed as { type?: unknown }).type;
  if (typeof type !== 'string') return null;
  return KNOWN_DSH_BRIDGE_EVENTS.has(type) ? (parsed as DshBridgeEvent) : null;
}
