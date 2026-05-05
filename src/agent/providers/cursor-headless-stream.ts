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

/**
 * cursor-agent CLI emits per-turn usage in **camelCase** (verified against
 * 2026.05.04-08e5280 by piping `echo "what is 1+1" | cursor-agent --print
 * --output-format stream-json --force`):
 *   {"usage":{"inputTokens":1227,"outputTokens":13,"cacheReadTokens":10624,"cacheWriteTokens":0}}
 *
 * Everything downstream — `transport-relay.normalizeUsageUpdatePayload`,
 * `ProviderUsageUpdate.usage`, the SQLite write path — expects
 * `ProviderUsageUpdate.usage` shape (snake_case `input_tokens` /
 * `output_tokens` / `cache_read_input_tokens` / `cache_creation_input_tokens`).
 *
 * Without translation every cursor turn produced `undefined` token fields:
 * the chat header context bar showed "0 / 1M (0.0%)", and `context_turn_usage`
 * had zero rows for `cursor-headless` sessions even after the May 5 telemetry
 * commit. Translate cursor's camelCase into the canonical snake_case here so
 * the rest of the pipeline can treat cursor like every other provider.
 */
function normalizeCursorUsage(raw: CursorRecord | undefined): CursorRecord | undefined {
  if (!raw) return undefined;
  const result: CursorRecord = {};
  // Pass through any already-snake_case fields (defensive — cursor-agent could
  // change shape in a future release without warning).
  for (const k of Object.keys(raw)) result[k] = raw[k];
  // camelCase → snake_case mapping. Each mapping only fires when the
  // canonical field is absent so a future cursor-agent emitting native
  // snake_case won't be double-overwritten.
  const map: Array<[string, string]> = [
    ['inputTokens', 'input_tokens'],
    ['outputTokens', 'output_tokens'],
    ['cacheReadTokens', 'cache_read_input_tokens'],
    // cacheWriteTokens semantically maps to "creation" tokens (input tokens
    // that build the cache) — transport-relay folds these into input_tokens
    // via `(usage.input_tokens + (usage.cache_creation_input_tokens ?? 0))`.
    ['cacheWriteTokens', 'cache_creation_input_tokens'],
    ['contextWindow', 'model_context_window'],
  ];
  for (const [from, to] of map) {
    if (typeof raw[from] === 'number' && typeof result[to] !== 'number') {
      result[to] = raw[from];
    }
  }
  return result;
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
    const rawUsage = pickRecord(record.usage) ?? pickRecord(pickRecord(record.message)?.usage);
    const usage = normalizeCursorUsage(rawUsage);
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
