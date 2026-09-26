import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { McpServer, RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  MESSAGE_PIN_EVENT_TYPES,
  MESSAGE_PIN_LIMITS,
  MESSAGE_PIN_MCP_TOOLS,
  type MessagePin,
  type MessagePinEventType,
  type MessagePinMcpToolName,
} from '../../shared/message-pins.js';
import { MCP_ERROR_REASONS } from '../../shared/memory-mcp-errors.js';
import { sanitizeMcpErrorMessage } from '../../shared/mcp-error-sanitize.js';
import type { McpRuntimeCaller } from './memory-mcp-caller.js';
import {
  messagePinMcpDelete,
  messagePinMcpGet,
  messagePinMcpList,
  messagePinMcpSave,
  type MessagePinMcpClientOptions,
} from './message-pin-mcp-client.js';

type ToolResult = Record<string, unknown>;
type ToolHandler = (input?: unknown) => Promise<ToolResult>;

export interface MessagePinMcpToolDeps {
  clientOptions?: MessagePinMcpClientOptions;
  listPins?: typeof messagePinMcpList;
  getPin?: typeof messagePinMcpGet;
  savePin?: typeof messagePinMcpSave;
  deletePin?: typeof messagePinMcpDelete;
}

export const MESSAGE_PIN_MCP_TOOL_NAME_LIST: readonly MessagePinMcpToolName[] = [
  MESSAGE_PIN_MCP_TOOLS.LIST,
  MESSAGE_PIN_MCP_TOOLS.GET,
  MESSAGE_PIN_MCP_TOOLS.SAVE,
  MESSAGE_PIN_MCP_TOOLS.DELETE,
] as const;

const descriptions: Readonly<Record<MessagePinMcpToolName, string>> = {
  [MESSAGE_PIN_MCP_TOOLS.LIST]:
    'List or search pinned messages accessible to the current user on this server. Defaults to the current session; scope=all searches all still-authorized sessions. Returns bounded previews; use get_message_pin for full text.',
  [MESSAGE_PIN_MCP_TOOLS.GET]:
    'Get one pinned message, including its full saved text, by pin id. The server re-authorizes the pin original session.',
  [MESSAGE_PIN_MCP_TOOLS.SAVE]:
    'Pin a user or assistant message in the current MCP session. Session/user/server identity is runtime-bound and cannot be supplied by the caller.',
  [MESSAGE_PIN_MCP_TOOLS.DELETE]:
    'Delete a pinned message by pin id. The server re-authorizes the original session before deletion; missing pins return deleted:false.',
};

const schemas: Record<MessagePinMcpToolName, z.ZodTypeAny> = {
  [MESSAGE_PIN_MCP_TOOLS.LIST]: z.strictObject({
    scope: z.enum(['current', 'all']).optional().describe('Defaults to current; all spans authorized sessions on this server.'),
    query: z.string().max(MESSAGE_PIN_LIMITS.QUERY_CHARS).optional().describe('Literal case-insensitive text or session-name substring.'),
    eventType: z.enum([MESSAGE_PIN_EVENT_TYPES.USER, MESSAGE_PIN_EVENT_TYPES.ASSISTANT]).optional(),
    limit: z.number().int().min(1).max(MESSAGE_PIN_LIMITS.MCP_LIST_RESULTS).optional(),
  }),
  [MESSAGE_PIN_MCP_TOOLS.GET]: z.strictObject({
    id: z.string().min(1).max(MESSAGE_PIN_LIMITS.ID_CHARS),
  }),
  [MESSAGE_PIN_MCP_TOOLS.SAVE]: z.strictObject({
    eventId: z.string().min(1).max(MESSAGE_PIN_LIMITS.EVENT_ID_CHARS),
    eventTs: z.number().int().safe().nonnegative(),
    eventType: z.enum([MESSAGE_PIN_EVENT_TYPES.USER, MESSAGE_PIN_EVENT_TYPES.ASSISTANT]),
    text: z.string().min(1).max(MESSAGE_PIN_LIMITS.TEXT_CHARS),
  }),
  [MESSAGE_PIN_MCP_TOOLS.DELETE]: z.strictObject({
    id: z.string().min(1).max(MESSAGE_PIN_LIMITS.ID_CHARS),
  }),
};

function validation(message: string): ToolResult {
  return { status: 'error', reason: MCP_ERROR_REASONS.VALIDATION_FAILED, message };
}

function summarizePin(pin: MessagePin): Record<string, unknown> {
  const truncated = pin.text.length > MESSAGE_PIN_LIMITS.MCP_TEXT_PREVIEW_CHARS;
  return {
    id: pin.id,
    sessionName: pin.sessionName,
    eventId: pin.eventId,
    eventTs: pin.eventTs,
    eventType: pin.eventType,
    textPreview: truncated ? pin.text.slice(0, MESSAGE_PIN_LIMITS.MCP_TEXT_PREVIEW_CHARS) : pin.text,
    textTruncated: truncated,
    createdAt: pin.createdAt,
    updatedAt: pin.updatedAt,
  };
}

function record(input: unknown): Record<string, unknown> {
  return input && typeof input === 'object' && !Array.isArray(input) ? input as Record<string, unknown> : {};
}

function textArg(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export function createMessagePinMcpToolHandlers(
  caller: McpRuntimeCaller,
  deps: MessagePinMcpToolDeps = {},
): Record<MessagePinMcpToolName, ToolHandler> {
  const options = deps.clientOptions ?? {};
  const listPins = deps.listPins ?? messagePinMcpList;
  const getPin = deps.getPin ?? messagePinMcpGet;
  const savePin = deps.savePin ?? messagePinMcpSave;
  const deletePin = deps.deletePin ?? messagePinMcpDelete;

  const handlers: Record<MessagePinMcpToolName, ToolHandler> = {
    [MESSAGE_PIN_MCP_TOOLS.LIST]: async (input) => {
      const args = record(input);
      const scope = args.scope === 'all' ? 'all' : 'current';
      if (scope === 'current' && !caller.sessionName) return validation('current-session pin listing requires a scoped MCP caller');
      const eventType = args.eventType === MESSAGE_PIN_EVENT_TYPES.USER || args.eventType === MESSAGE_PIN_EVENT_TYPES.ASSISTANT
        ? args.eventType as MessagePinEventType
        : undefined;
      const result = await listPins({
        ...(scope === 'current' && caller.sessionName ? { sessionName: caller.sessionName } : {}),
        ...(textArg(args, 'query') ? { query: textArg(args, 'query') } : {}),
        ...(eventType ? { eventType } : {}),
        ...(typeof args.limit === 'number' ? { limit: args.limit } : {}),
      }, options);
      if (result.status !== 'ok') return result as unknown as ToolResult;
      return { status: 'ok', scope, pins: result.pins.map(summarizePin) };
    },
    [MESSAGE_PIN_MCP_TOOLS.GET]: async (input) => {
      const id = textArg(record(input), 'id');
      if (!id) return validation('id is required');
      return await getPin(id, options) as unknown as ToolResult;
    },
    [MESSAGE_PIN_MCP_TOOLS.SAVE]: async (input) => {
      if (!caller.sessionName) return validation('pin_message requires a scoped MCP caller');
      const args = record(input);
      const eventId = textArg(args, 'eventId');
      const text = textArg(args, 'text');
      if (!eventId || !text || typeof args.eventTs !== 'number' || !Number.isSafeInteger(args.eventTs)) {
        return validation('eventId, eventTs, eventType, and text are required');
      }
      if (args.eventType !== MESSAGE_PIN_EVENT_TYPES.USER && args.eventType !== MESSAGE_PIN_EVENT_TYPES.ASSISTANT) {
        return validation('eventType is invalid');
      }
      return await savePin(caller.sessionName, {
        eventId,
        eventTs: args.eventTs,
        eventType: args.eventType,
        text,
      }, options) as unknown as ToolResult;
    },
    [MESSAGE_PIN_MCP_TOOLS.DELETE]: async (input) => {
      const id = textArg(record(input), 'id');
      if (!id) return validation('id is required');
      return await deletePin(id, options) as unknown as ToolResult;
    },
  };

  const wrapped = {} as Record<MessagePinMcpToolName, ToolHandler>;
  for (const name of MESSAGE_PIN_MCP_TOOL_NAME_LIST) {
    wrapped[name] = async (input) => {
      try {
        return await handlers[name](input);
      } catch (err) {
        return {
          status: 'error',
          reason: MCP_ERROR_REASONS.INTERNAL_ERROR,
          message: sanitizeMcpErrorMessage(err instanceof Error ? err.message : String(err)),
        };
      }
    };
  }
  return wrapped;
}

function toolResult(result: ToolResult): CallToolResult {
  return {
    structuredContent: result,
    content: [{ type: 'text', text: JSON.stringify(result) }],
    isError: result.status === 'error',
  };
}

export function registerMessagePinMcpTools(
  server: McpServer,
  caller: McpRuntimeCaller,
  deps: MessagePinMcpToolDeps = {},
): ReadonlyMap<string, RegisteredTool> {
  const handlers = createMessagePinMcpToolHandlers(caller, deps);
  const registered = new Map<string, RegisteredTool>();
  for (const name of MESSAGE_PIN_MCP_TOOL_NAME_LIST) {
    registered.set(name, server.registerTool(name, {
      description: descriptions[name],
      inputSchema: schemas[name],
    }, async (args: unknown) => toolResult(await handlers[name](args))));
  }
  return registered;
}
