type CursorRecord = Record<string, unknown>;

export interface CursorSessionInitEvent {
  kind: 'session.init';
  raw: CursorRecord;
  sessionId?: string;
  model?: string;
  permissionMode?: string;
}

export interface CursorAssistantDeltaEvent {
  kind: 'assistant.delta';
  raw: CursorRecord;
  sessionId?: string;
  messageId?: string;
  text: string;
}

export interface CursorAssistantFinalEvent {
  kind: 'assistant.final';
  raw: CursorRecord;
  sessionId?: string;
  messageId?: string;
  text: string;
}

export interface CursorToolStartedEvent {
  kind: 'tool.started';
  raw: CursorRecord;
  sessionId?: string;
  id: string;
  name: string;
  input?: unknown;
}

export interface CursorToolCompletedEvent {
  kind: 'tool.completed';
  raw: CursorRecord;
  sessionId?: string;
  id: string;
  name: string;
  input?: unknown;
  output?: unknown;
}

export interface CursorResultSuccessEvent {
  kind: 'result.success';
  raw: CursorRecord;
  sessionId?: string;
  model?: string;
  text?: string;
  usage?: Record<string, unknown>;
}

export interface CursorResultErrorEvent {
  kind: 'result.error';
  raw: CursorRecord;
  sessionId?: string;
  message: string;
}

export interface CursorUnknownEvent {
  kind: 'unknown';
  raw: unknown;
}

export type CursorParsedEvent =
  | CursorSessionInitEvent
  | CursorAssistantDeltaEvent
  | CursorAssistantFinalEvent
  | CursorToolStartedEvent
  | CursorToolCompletedEvent
  | CursorResultSuccessEvent
  | CursorResultErrorEvent
  | CursorUnknownEvent;

function isRecord(value: unknown): value is CursorRecord {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function pickString(record: CursorRecord, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

function pickRecord(value: unknown): CursorRecord | undefined {
  return isRecord(value) ? value : undefined;
}

function extractTextFromContent(content: unknown): string | undefined {
  if (typeof content === 'string' && content.trim()) return content;
  if (!Array.isArray(content)) return undefined;
  const parts = content
    .map((block) => {
      if (!isRecord(block)) return '';
      if (block.type === 'text' && typeof block.text === 'string') return block.text;
      if (typeof block.text === 'string') return block.text;
      return '';
    })
    .filter(Boolean);
  return parts.length > 0 ? parts.join('') : undefined;
}

function extractToolPayload(record: CursorRecord): { id?: string; name?: string; input?: unknown; output?: unknown } {
  const id = pickString(record, 'id', 'tool_call_id', 'toolCallId', 'toolId');
  const name = pickString(record, 'name', 'tool', 'tool_name', 'toolName');
  const input = record.input ?? record.arguments ?? record.params ?? record.payload;
  const output = record.output ?? record.result ?? record.stdout ?? record.aggregated_output ?? record.aggregatedOutput;
  return { id, name, input, output };
}

function extractMessageId(record: CursorRecord): string | undefined {
  return pickString(record, 'message_id', 'messageId', 'id');
}

function extractSessionId(record: CursorRecord, fallback?: string): string | undefined {
  return pickString(record, 'session_id', 'sessionId') ?? fallback;
}

function extractModel(record: CursorRecord): string | undefined {
  return pickString(record, 'model', 'agent');
}

function extractPermissionMode(record: CursorRecord): string | undefined {
  return pickString(record, 'permissionMode', 'permission_mode');
}

function isSuccessResult(record: CursorRecord): boolean {
  if (record.is_error === true) return false;
  if (typeof record.status === 'string' && /success|completed|done|ok/i.test(record.status)) return true;
  if (typeof record.subtype === 'string' && /success/i.test(record.subtype)) return true;
  return typeof record.type === 'string' && /result(\.success)?$/i.test(record.type);
}

function isErrorResult(record: CursorRecord): boolean {
  if (record.is_error === true) return true;
  if (typeof record.status === 'string' && /error|failed|cancel/i.test(record.status)) return true;
  if (typeof record.subtype === 'string' && /error|failed/i.test(record.subtype)) return true;
  return typeof record.type === 'string' && /result\.(error|failed)$/i.test(record.type);
}

function parseCursorRecord(record: unknown, fallbackSessionId?: string): CursorParsedEvent | null {
  if (!isRecord(record)) return null;
  const sessionId = extractSessionId(record, fallbackSessionId);
  const model = extractModel(record);
  const permissionMode = extractPermissionMode(record);
  const streamEvent = pickRecord(record.event);

  const type = typeof record.type === 'string' ? record.type : '';
  const subtype = typeof record.subtype === 'string' ? record.subtype : '';

  if (type === 'system.init' || (type === 'system' && subtype === 'init')) {
    return {
      kind: 'session.init',
      raw: record,
      sessionId,
      model,
      permissionMode,
    };
  }

  if (type === 'assistant') {
    const message = pickRecord(record.message);
    const text = extractTextFromContent(message?.content ?? record.text ?? record.content);
    if (!text) return null;
    return {
      kind: 'assistant.final',
      raw: record,
      sessionId,
      messageId: extractMessageId(message ?? record),
      text,
    };
  }

  if (type === 'user') {
    return null;
  }

  if (
    type === 'tool_call.started'
    || type === 'tool.started'
    || (type === 'tool_call' && subtype === 'started')
  ) {
    const tool = extractToolPayload(record);
    if (!tool.id || !tool.name) return null;
    return {
      kind: 'tool.started',
      raw: record,
      sessionId,
      id: tool.id,
      name: tool.name,
      ...(tool.input !== undefined ? { input: tool.input } : {}),
    };
  }

  if (
    type === 'tool_call.completed'
    || type === 'tool.completed'
    || (type === 'tool_call' && subtype === 'completed')
  ) {
    const tool = extractToolPayload(record);
    if (!tool.id || !tool.name) return null;
    return {
      kind: 'tool.completed',
      raw: record,
      sessionId,
      id: tool.id,
      name: tool.name,
      ...(tool.input !== undefined ? { input: tool.input } : {}),
      ...(tool.output !== undefined ? { output: tool.output } : {}),
    };
  }

  if (type === 'assistant.delta') {
    const text = extractTextFromContent(record.delta ?? record.text ?? record.content);
    if (!text) return null;
    return {
      kind: 'assistant.delta',
      raw: record,
      sessionId,
      messageId: extractMessageId(record),
      text,
    };
  }

  if (type === 'assistant.final') {
    const message = pickRecord(record.message);
    const text = extractTextFromContent(record.text ?? record.content ?? message?.content);
    if (!text) return null;
    return {
      kind: 'assistant.final',
      raw: record,
      sessionId,
      messageId: extractMessageId(record) ?? extractMessageId(message ?? {}),
      text,
    };
  }

  if (type === 'result.success' || (type === 'result' && isSuccessResult(record))) {
    const resultText =
      extractTextFromContent(record.result)
      ?? extractTextFromContent(record.text)
      ?? extractTextFromContent(pickRecord(record.message)?.content)
      ?? (typeof record.result === 'string' ? record.result : undefined);
    const usage = pickRecord(record.usage) ?? pickRecord(pickRecord(record.message)?.usage);
    return {
      kind: 'result.success',
      raw: record,
      sessionId,
      model,
      ...(resultText ? { text: resultText } : {}),
      ...(usage ? { usage } : {}),
    };
  }

  if (type === 'result.error' || (type === 'result' && isErrorResult(record))) {
    const message =
      pickString(record, 'message', 'error')
      ?? (pickRecord(record.error)?.message as string | undefined)
      ?? 'Cursor execution failed';
    return {
      kind: 'result.error',
      raw: record,
      sessionId,
      message,
    };
  }

  if (
    type === 'stream_event'
    && streamEvent
  ) {
    const event = streamEvent;
    if (
      event
      && typeof event.type === 'string'
      && event.type === 'content_block_delta'
    ) {
      const delta = pickRecord(event.delta);
      if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
        return {
          kind: 'assistant.delta',
          raw: record,
          sessionId,
          text: delta.text,
        };
      }
    }

    if (
      event
      && typeof event.type === 'string'
      && event.type === 'content_block_start'
    ) {
      const contentBlock = pickRecord(event.content_block);
      if (contentBlock?.type === 'tool_use') {
        const tool = extractToolPayload(contentBlock);
        if (!tool.id || !tool.name) return null;
        return {
          kind: 'tool.started',
          raw: record,
          sessionId,
          id: tool.id,
          name: tool.name,
          ...(tool.input !== undefined ? { input: tool.input } : {}),
        };
      }
    }
  }

  return null;
}

export function parseCursorStreamLine(line: string): CursorParsedEvent | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed) as unknown;
  } catch {
    return null;
  }
  return parseCursorRecord(parsed);
}
