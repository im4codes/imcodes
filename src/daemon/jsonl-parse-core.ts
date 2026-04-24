/**
 * Pure Claude-Code JSONL parser — no direct access to timelineEmitter or
 * module-level state. Designed to be shared between:
 *
 *   1) the main process (fallback when the parse worker is disabled/crashed)
 *   2) the parse worker thread (`jsonl-parse-worker.ts`)
 *
 * Given a batch of raw JSONL lines + a per-session parse context (which holds
 * the pending tool-call correlation map), the parser returns an ordered list
 * of `EmitInstruction`s that the caller passes to `timelineEmitter.emit(...)`.
 *
 * Keeping this logic pure lets us run the heavy JSON.parse / regex / normalise
 * work off the main event loop without diverging from the main-thread
 * fallback semantics.
 */

import type { TimelineEventType, TimelineSource, TimelineConfidence } from '../shared/timeline/types.js';
import { TIMELINE_EVENT_FILE_CHANGE, type FileChangeBatch } from '../../shared/file-change.js';
import { normalizeClaudeFileChange } from './file-change-normalizer.js';
import { resolveContextWindow } from '../shared/models/context.js';

// ── Types reproduced locally (structurally identical to jsonl-watcher) ──────

interface ContentBlock {
  type: string;
  id?: string;
  text?: string;
  thinking?: string;
  name?: string;
  input?: Record<string, unknown>;
  content?: unknown;
  is_error?: boolean;
  tool_use_id?: string;
  toolUseResult?: Record<string, unknown>;
}

interface PendingClaudeToolCall {
  id: string;
  name: string;
  input?: Record<string, unknown>;
  ts?: number;
}

/**
 * Per-parser state. The worker keeps one instance per daemon lifetime;
 * the main-thread fallback keeps its own module-level instance. All mutable
 * state flows through this object — no module globals in this file.
 */
export interface ParseContext {
  /** sessionName -> toolUseId -> pending metadata. */
  readonly pendingToolCalls: Map<string, Map<string, PendingClaudeToolCall>>;
}

export function createParseContext(): ParseContext {
  return { pendingToolCalls: new Map() };
}

/**
 * Emit instruction — structured equivalent of calling
 * `timelineEmitter.emit(sessionName, type, payload, metadata)`.
 *
 * The `sessionName` is carried in every instruction so that the transport can
 * batch multiple sessions' emits in a single worker response if ever needed,
 * though in practice one `parseLines` request = one `sessionName`.
 */
export interface EmitInstruction {
  sessionName: string;
  type: TimelineEventType;
  payload: Record<string, unknown>;
  metadata: EmitMetadata;
}

export interface EmitMetadata {
  source: TimelineSource;
  confidence: TimelineConfidence;
  eventId?: string;
  ts?: number;
  hidden?: boolean;
}

export interface ParseLineInput {
  /** Raw JSONL line (without trailing `\n`). */
  line: string;
  /** Byte offset of this line within its source file (used for stable eventIds). */
  lineByteOffset?: number;
}

export interface ParseLinesRequest {
  sessionName: string;
  items: ParseLineInput[];
  /** CC session UUID, used to pick the preset context window override. */
  ccSessionId?: string;
  /** Optional preset-provided context window (snapshotted on main before dispatch). */
  presetContextWindow?: number;
}

export interface ParseLinesResult {
  emits: EmitInstruction[];
}

// ── Helpers (ports of jsonl-watcher's private helpers, made pure) ────────────

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function extractToolInput(name: string, input?: Record<string, unknown>): string {
  if (!input) return '';
  if (name === 'Grep') {
    const pattern = input.pattern ?? input.query ?? input.text;
    const path = input.path ?? input.file_path ?? input.filePath;
    if (pattern && path) return `${String(pattern).split('\n')[0]} in ${String(path).split('\n')[0]}`;
  }
  const val = input.command
    ?? input.path
    ?? input.file_path
    ?? input.pattern
    ?? input.description
    ?? input.query
    ?? input.objective
    ?? input.text
    ?? '';
  const text = String(val);
  return text.split('\n')[0] ?? '';
}

function extractToolResultOutput(block: ContentBlock): string | undefined {
  const raw = block.content;
  if (!raw) return undefined;
  let text: string;
  if (typeof raw === 'string') {
    text = raw;
  } else if (Array.isArray(raw)) {
    text = (raw as Array<{ text?: string }>).map((b) => b.text ?? '').join('\n');
  } else {
    return undefined;
  }
  text = text.trim();
  if (!text) return undefined;
  return text.length > 200 ? text.slice(0, 197) + '...' : text;
}

function isClaudeFileChangeTool(name?: string): boolean {
  return name === 'Edit' || name === 'MultiEdit' || name === 'Write' || name === 'NotebookEdit';
}

function buildClaudeToolEventId(sessionName: string, toolUseId: string, phase: 'call' | 'result'): string {
  return `cc-tool:${sessionName}:${toolUseId}:${phase}`;
}

/** Patterns for system-injected messages that should not display as user messages. */
const SYSTEM_INJECT_RE = /<task-notification|<system-reminder|<command-name>|<command-message>|<local-command-|<bash-input>|<bash-stdout>|<bash-stderr>/;

// ── Pending tool-call map helpers (scoped to ctx) ────────────────────────────

function rememberClaudeToolCall(ctx: ParseContext, sessionName: string, pending: PendingClaudeToolCall): void {
  let map = ctx.pendingToolCalls.get(sessionName);
  if (!map) {
    map = new Map();
    ctx.pendingToolCalls.set(sessionName, map);
  }
  map.set(pending.id, pending);
}

function takeClaudeToolCall(ctx: ParseContext, sessionName: string, toolUseId?: string): PendingClaudeToolCall | undefined {
  if (!toolUseId) return undefined;
  const pending = ctx.pendingToolCalls.get(sessionName);
  if (!pending) return undefined;
  const tool = pending.get(toolUseId);
  if (tool) pending.delete(toolUseId);
  if (pending.size === 0) ctx.pendingToolCalls.delete(sessionName);
  return tool;
}

/** Drop all pending state for a session — called by caller when the watcher stops. */
export function forgetSession(ctx: ParseContext, sessionName: string): void {
  ctx.pendingToolCalls.delete(sessionName);
}

// ── Emit-collection helpers ──────────────────────────────────────────────────

function pushEmit(out: EmitInstruction[], sessionName: string, type: TimelineEventType, payload: Record<string, unknown>, metadata: EmitMetadata): void {
  out.push({ sessionName, type, payload, metadata });
}

function emitUserStringContent(
  out: EmitInstruction[],
  sessionName: string,
  text: string,
  stableId?: (suffix: string) => string,
  ts?: number,
): void {
  if (!text.trim()) return;
  if (SYSTEM_INJECT_RE.test(text)) {
    pushEmit(out, sessionName, 'agent.status', {
      status: 'processing',
      label: 'Processing system event...',
    }, { source: 'daemon', confidence: 'high' });
    return;
  }
  pushEmit(out, sessionName, 'user.message', { text }, {
    source: 'daemon',
    confidence: 'high',
    ...(stableId ? { eventId: stableId('um') } : {}),
    ...(ts ? { ts } : {}),
  });
}

function emitAssistantStringContent(
  out: EmitInstruction[],
  sessionName: string,
  text: string,
  stableId?: (suffix: string) => string,
  ts?: number,
): void {
  if (!text.trim()) return;
  pushEmit(out, sessionName, 'assistant.text', { text, streaming: false }, {
    source: 'daemon',
    confidence: 'high',
    ...(stableId ? { eventId: stableId('at') } : {}),
    ...(ts ? { ts } : {}),
  });
}

function emitClaudeFileChange(
  out: EmitInstruction[],
  sessionName: string,
  batch: FileChangeBatch,
  eventId: string,
  ts?: number,
): void {
  pushEmit(out, sessionName, TIMELINE_EVENT_FILE_CHANGE, { batch }, {
    source: 'daemon',
    confidence: 'high',
    eventId,
    ...(ts ? { ts } : {}),
  });
}

function emitClaudeToolCallBlock(
  ctx: ParseContext,
  out: EmitInstruction[],
  sessionName: string,
  block: ContentBlock,
  stableId?: (suffix: string) => string,
  ts?: number,
): void {
  if (!block.name) return;
  if (block.name === 'AskUserQuestion') {
    const inp = block.input as Record<string, unknown> | undefined;
    pushEmit(out, sessionName, 'ask.question', {
      toolUseId: block.id,
      questions: inp?.['questions'] ?? [],
    }, {
      source: 'daemon',
      confidence: 'high',
      ...(stableId ? { eventId: stableId('aq') } : {}),
      ...(ts ? { ts } : {}),
    });
    return;
  }

  const input = block.input as Record<string, unknown> | undefined;
  const toolUseId = block.id;
  const isDeferredFileTool = isClaudeFileChangeTool(block.name) && !!toolUseId;

  if (toolUseId) {
    rememberClaudeToolCall(ctx, sessionName, {
      id: toolUseId,
      name: block.name,
      input,
      ...(ts ? { ts } : {}),
    });
  }

  if (isDeferredFileTool) return;

  const callEventId = toolUseId ? buildClaudeToolEventId(sessionName, toolUseId, 'call') : (stableId ? stableId('tc') : undefined);
  const summaryInput = extractToolInput(block.name, input);
  pushEmit(out, sessionName, 'tool.call', {
    tool: block.name,
    ...(summaryInput ? { input: summaryInput } : (input ? { input } : {})),
  }, {
    source: 'daemon',
    confidence: 'high',
    ...(callEventId ? { eventId: callEventId } : {}),
    ...(ts ? { ts } : {}),
  });
}

function emitClaudeToolResultBlock(
  ctx: ParseContext,
  out: EmitInstruction[],
  sessionName: string,
  block: ContentBlock,
  stableId?: (suffix: string) => string,
  ts?: number,
): void {
  const toolUseId = block.tool_use_id;
  const pending = takeClaudeToolCall(ctx, sessionName, toolUseId);
  const toolUseResult = asRecord(block.toolUseResult);
  const contentResult = asRecord(block.content);
  const normalized = pending
    && !block.is_error
    ? normalizeClaudeFileChange({
      toolName: pending.name,
      toolCallId: pending.id,
      input: pending.input,
      toolResult: toolUseResult ?? contentResult ?? undefined,
    })
    : null;

  if (pending && isClaudeFileChangeTool(pending.name)) {
    const summaryInput = extractToolInput(pending.name, pending.input);
    pushEmit(out, sessionName, 'tool.call', {
      tool: pending.name,
      ...(summaryInput ? { input: summaryInput } : (pending.input ? { input: pending.input } : {})),
    }, {
      source: 'daemon',
      confidence: 'high',
      eventId: buildClaudeToolEventId(sessionName, pending.id, 'call'),
      ...(pending.ts ? { ts: pending.ts } : {}),
      ...(normalized ? { hidden: true } : {}),
    });
  }

  if (normalized && pending) {
    pushEmit(out, sessionName, 'tool.result', {
      ...(block.is_error ? { error: String(block.content ?? 'error') } : {}),
      ...(toolUseResult?.content ? { output: toolUseResult.content } : {}),
    }, {
      source: 'daemon',
      confidence: 'high',
      eventId: buildClaudeToolEventId(sessionName, pending.id, 'result'),
      ...(ts ? { ts } : {}),
      hidden: true,
    });
    emitClaudeFileChange(out, sessionName, normalized, `cc-file-change:${sessionName}:${pending.id}`, ts);
    return;
  }

  const error = block.is_error ? String(block.content ?? 'error') : undefined;
  const output = !error ? extractToolResultOutput(block) : undefined;
  pushEmit(out, sessionName, 'tool.result', {
    ...(error ? { error } : {}),
    ...(output ? { output } : {}),
  }, {
    source: 'daemon',
    confidence: 'high',
    ...(toolUseId ? { eventId: buildClaudeToolEventId(sessionName, toolUseId, 'result') } : stableId ? { eventId: stableId('tr') } : {}),
    ...(ts ? { ts } : {}),
  });
}

// ── Main entry points ────────────────────────────────────────────────────────

function parseOneLine(
  ctx: ParseContext,
  out: EmitInstruction[],
  sessionName: string,
  line: string,
  lineByteOffset: number | undefined,
  presetContextWindow: number | undefined,
): void {
  if (!line.trim()) return;

  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return;
  }

  const lineTs = raw['timestamp'] ? new Date(raw['timestamp'] as string).getTime() : undefined;
  const ts = lineTs && isFinite(lineTs) ? lineTs : undefined;

  let blockIdx = 0;
  const stableId = lineByteOffset !== undefined
    ? (suffix: string) => `cc:${sessionName}:${lineByteOffset}:${suffix}:${blockIdx++}`
    : undefined;

  if (raw['type'] === 'progress') {
    const data = raw['data'] as Record<string, unknown> | undefined;
    if (!data) return;
    const progressType = String(data['type'] ?? '');
    switch (progressType) {
      case 'bash_progress': {
        const elapsed = data['elapsedTimeSeconds'] as number | undefined;
        pushEmit(out, sessionName, 'agent.status', {
          status: 'bash_running',
          label: `Bash running${elapsed ? ` (${Math.round(elapsed)}s)` : ''}...`,
        }, { source: 'daemon', confidence: 'high' });
        break;
      }
      case 'agent_progress': {
        const inner = data['message'];
        let msg = 'working';
        if (typeof inner === 'string') {
          msg = inner;
        } else if (inner && typeof inner === 'object') {
          const role = (inner as Record<string, unknown>).type ?? (inner as Record<string, unknown>).role ?? '';
          msg = String(role) || 'working';
        }
        pushEmit(out, sessionName, 'agent.status', {
          status: 'agent_working',
          label: `Sub-agent: ${msg}`,
        }, { source: 'daemon', confidence: 'high' });
        break;
      }
      case 'mcp_progress': {
        const toolName = String(data['toolName'] ?? 'tool');
        const server = String(data['serverName'] ?? '');
        const mStatus = String(data['status'] ?? 'started');
        if (mStatus === 'started') {
          pushEmit(out, sessionName, 'agent.status', {
            status: 'mcp_running',
            label: `MCP: ${server ? server + '/' : ''}${toolName}...`,
          }, { source: 'daemon', confidence: 'high' });
        }
        break;
      }
      case 'waiting_for_task': {
        const desc = String(data['taskDescription'] ?? 'task');
        pushEmit(out, sessionName, 'agent.status', {
          status: 'waiting',
          label: `Waiting: ${desc}`,
        }, { source: 'daemon', confidence: 'high' });
        break;
      }
    }
    return;
  }

  if (raw['type'] === 'result') {
    const costUsd = raw['total_cost_usd'] as number | undefined;
    if (typeof costUsd === 'number' && costUsd > 0) {
      pushEmit(out, sessionName, 'usage.update', { costUsd }, { source: 'daemon', confidence: 'high' });
    }
    return;
  }

  if (raw['type'] === 'system') {
    const subtype = String(raw['subtype'] ?? '');
    if (subtype === 'compact_boundary') {
      pushEmit(out, sessionName, 'agent.status', {
        status: 'compacting',
        label: 'Compacting conversation...',
      }, { source: 'daemon', confidence: 'high' });
    }
    return;
  }

  const msg = raw['message'] as Record<string, unknown> | undefined;
  if (!msg) return;
  const content = msg['content'];

  if (raw['type'] === 'assistant') {
    if (typeof content === 'string') {
      emitAssistantStringContent(out, sessionName, content, stableId, ts);
      return;
    }
    if (!Array.isArray(content)) return;
    for (const block of content as ContentBlock[]) {
      if (block.type === 'text' && block.text) {
        pushEmit(out, sessionName, 'assistant.text', {
          text: block.text,
          streaming: false,
        }, {
          source: 'daemon',
          confidence: 'high',
          ...(stableId ? { eventId: stableId('at') } : {}),
          ...(ts ? { ts } : {}),
        });
      } else if (block.type === 'thinking') {
        pushEmit(out, sessionName, 'assistant.thinking', {
          text: block.thinking,
        }, {
          source: 'daemon',
          confidence: 'high',
          ...(stableId ? { eventId: stableId('th') } : {}),
          ...(ts ? { ts } : {}),
        });
      } else if (block.type === 'tool_use' && block.name) {
        emitClaudeToolCallBlock(ctx, out, sessionName, block, stableId, ts);
      } else if (block.type === 'tool_result') {
        emitClaudeToolResultBlock(ctx, out, sessionName, block, stableId, ts);
      }
    }
    const usage = msg['usage'] as { input_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number } | undefined;
    const model = msg['model'] as string | undefined;
    if (usage && typeof usage.input_tokens === 'number') {
      pushEmit(out, sessionName, 'usage.update', {
        inputTokens: usage.input_tokens + (usage.cache_creation_input_tokens ?? 0),
        cacheTokens: usage.cache_read_input_tokens ?? 0,
        contextWindow: resolveContextWindow(presetContextWindow, model),
        ...(model ? { model } : {}),
      }, { source: 'daemon', confidence: 'high' });
    }
    return;
  }

  if (raw['type'] === 'user') {
    if (typeof content === 'string') {
      emitUserStringContent(out, sessionName, content, stableId, ts);
      return;
    }
    if (!Array.isArray(content)) return;
    for (const block of content as ContentBlock[]) {
      if (block.type === 'text' && block.text?.trim()) {
        emitUserStringContent(out, sessionName, block.text, stableId, ts);
      } else if (block.type === 'tool_result') {
        emitClaudeToolResultBlock(ctx, out, sessionName, block, stableId, ts);
      }
    }
  }
}

/**
 * Parse a batch of JSONL lines and return the emit instructions (in order).
 * Mutates `ctx.pendingToolCalls` to track in-flight Claude tool invocations.
 */
export function parseLines(ctx: ParseContext, req: ParseLinesRequest): ParseLinesResult {
  const out: EmitInstruction[] = [];
  for (const item of req.items) {
    parseOneLine(ctx, out, req.sessionName, item.line, item.lineByteOffset, req.presetContextWindow);
  }
  return { emits: out };
}
