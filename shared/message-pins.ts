export const MESSAGE_PINS_API_PATH = '/api/message-pins' as const;

export const MESSAGE_PIN_EVENT_TYPES = {
  USER: 'user.message',
  ASSISTANT: 'assistant.text',
} as const;

export type MessagePinEventType = typeof MESSAGE_PIN_EVENT_TYPES[keyof typeof MESSAGE_PIN_EVENT_TYPES];

export const MESSAGE_PIN_LIMITS = {
  PER_SESSION: 200,
  ID_CHARS: 128,
  EVENT_ID_CHARS: 512,
  SESSION_NAME_CHARS: 255,
  TEXT_CHARS: 20_000,
  QUERY_CHARS: 200,
  MCP_LIST_RESULTS: 200,
  MCP_TEXT_PREVIEW_CHARS: 500,
  CONTEXT_EVENTS_BEFORE: 40,
  CONTEXT_EVENTS_AFTER: 20,
} as const;

export const MESSAGE_PIN_MCP_TOOLS = {
  LIST: 'list_message_pins',
  GET: 'get_message_pin',
  SAVE: 'pin_message',
  DELETE: 'delete_message_pin',
} as const;

export type MessagePinMcpToolName = typeof MESSAGE_PIN_MCP_TOOLS[keyof typeof MESSAGE_PIN_MCP_TOOLS];

export const MESSAGE_PIN_ERRORS = {
  SCOPE_REQUIRED: 'message_pin_scope_required',
  INVALID_PAYLOAD: 'message_pin_invalid_payload',
  LIMIT_REACHED: 'message_pin_limit_reached',
  NOT_FOUND: 'message_pin_not_found',
} as const;

export interface MessagePin {
  id: string;
  serverId: string;
  sessionName: string;
  eventId: string;
  eventTs: number;
  eventType: MessagePinEventType;
  text: string;
  createdAt: number;
  updatedAt: number;
}

export interface CreateMessagePinInput {
  eventId: string;
  eventTs: number;
  eventType: MessagePinEventType;
  text: string;
}

export function isMessagePinEventType(value: unknown): value is MessagePinEventType {
  return value === MESSAGE_PIN_EVENT_TYPES.USER || value === MESSAGE_PIN_EVENT_TYPES.ASSISTANT;
}
