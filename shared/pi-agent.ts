/** Shared vocabulary for the Pi coding-agent RPC adapter. */

export const PI_RPC_COMMAND = {
  PROMPT: 'prompt',
  STEER: 'steer',
  FOLLOW_UP: 'follow_up',
  ABORT: 'abort',
  GET_STATE: 'get_state',
  GET_AVAILABLE_MODELS: 'get_available_models',
  SET_MODEL: 'set_model',
  SET_THINKING_LEVEL: 'set_thinking_level',
} as const;

export const PI_RPC_FRAME = {
  RESPONSE: 'response',
  AGENT_START: 'agent_start',
  AGENT_END: 'agent_end',
  AGENT_SETTLED: 'agent_settled',
  TURN_START: 'turn_start',
  TURN_END: 'turn_end',
  MESSAGE_START: 'message_start',
  MESSAGE_UPDATE: 'message_update',
  MESSAGE_END: 'message_end',
  TOOL_EXECUTION_START: 'tool_execution_start',
  TOOL_EXECUTION_UPDATE: 'tool_execution_update',
  TOOL_EXECUTION_END: 'tool_execution_end',
  QUEUE_UPDATE: 'queue_update',
  COMPACTION_START: 'compaction_start',
  COMPACTION_END: 'compaction_end',
  AUTO_RETRY_START: 'auto_retry_start',
  AUTO_RETRY_END: 'auto_retry_end',
} as const;

export const PI_ASSISTANT_EVENT = {
  TEXT_DELTA: 'text_delta',
  THINKING_DELTA: 'thinking_delta',
  DONE: 'done',
  ERROR: 'error',
} as const;

export const PI_STREAMING_BEHAVIOR = {
  STEER: 'steer',
  FOLLOW_UP: 'followUp',
} as const;

export const PI_PROVIDER_API_KEY_ENV = 'IMCODES_PI_PROVIDER_API_KEY';
export const PI_PROVIDER_CONFIG_ENV = 'IMCODES_PI_PROVIDER_CONFIG';
export const PI_MCP_CONFIG_ENV = 'IMCODES_PI_MCP_CONFIG';

/** Third-party model route registered by the IM.codes Pi extension. */
export interface PiLlmConfig {
  provider: string;
  model: string;
  baseUrl?: string;
  apiKey?: string;
  contextWindow?: number;
  maxTokens?: number;
}

export interface PiRpcCommand {
  id?: string;
  type: string;
  [key: string]: unknown;
}

export interface PiRpcResponse {
  id?: string;
  type: typeof PI_RPC_FRAME.RESPONSE;
  command: string;
  success: boolean;
  data?: unknown;
  error?: string;
}

export function isPiRpcResponse(value: unknown): value is PiRpcResponse {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return record.type === PI_RPC_FRAME.RESPONSE
    && typeof record.command === 'string'
    && typeof record.success === 'boolean';
}
