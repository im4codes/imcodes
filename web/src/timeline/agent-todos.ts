/**
 * agent-todos — derive a single, current task/todo list from timeline events.
 *
 * CC (TodoWrite), Qwen/Gemini (todo_write / write_todos) and Codex (update_plan)
 * all surface their progress checklist as a `tool.call` timeline event whose
 * `input` carries the list. Each update is a fresh tool.call with the full list,
 * so the LATEST matching event is the current state. This module detects those
 * events (by tool name OR input shape) and normalizes the differing schemas
 * into one shape the UI can render.
 *
 *   TodoWrite   { todos: [{ content, status, activeForm }] }
 *   todo_write  { todos: [{ id, content, status }] }
 *   write_todos { todos: [{ title, status }] }
 *   update_plan { plan:  [{ step, status }] }
 *
 * Pure + framework-free so it is trivially unit-testable.
 */
import type { TimelineEvent } from '../ws-client.js';

/** Hide a checklist this long after its session goes idle (turn ended) — an
 *  unfinished list shouldn't linger forever once the agent stops working. */
export const TODO_LIST_IDLE_GRACE_MS = 3 * 60_000;
/** Absolute cap: hide a checklist this long after its last update regardless of
 *  session state, so a wedged/stuck "running" turn can't pin it indefinitely. */
export const TODO_LIST_HARD_MAX_MS = 60 * 60_000;

export type AgentTodoStatus = 'pending' | 'in_progress' | 'completed';

export interface AgentTodoItem {
  text: string;
  status: AgentTodoStatus;
}

export interface AgentTodoList {
  items: AgentTodoItem[];
  /** eventId of the source tool.call (stable key for the latest list). */
  eventId: string;
  ts: number;
}

/** Known checklist tool names across the supported agents (lower-cased). */
const TODO_TOOL_NAMES: ReadonlySet<string> = new Set([
  'todowrite',
  'todo_write',
  'write_todos',
  'update_plan',
  'update_todo_list',
  'set_plan',
]);

/** Array fields that, when present, identify a checklist payload. */
const LIST_KEYS = ['todos', 'plan', 'tasks', 'steps'] as const;

/** Item fields that may hold the human-readable task text, in priority order. */
const TEXT_KEYS = ['content', 'step', 'text', 'title', 'task', 'description', 'name'] as const;

export function normalizeTodoStatus(raw: unknown): AgentTodoStatus {
  const value = String(raw ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (value === 'in_progress' || value === 'inprogress' || value === 'active' || value === 'doing' || value === 'running' || value === 'started') {
    return 'in_progress';
  }
  if (value === 'completed' || value === 'complete' || value === 'done' || value === 'finished' || value === 'checked') {
    return 'completed';
  }
  return 'pending';
}

function extractRawItems(input: unknown): unknown[] | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const obj = input as Record<string, unknown>;
  for (const key of LIST_KEYS) {
    if (Array.isArray(obj[key])) return obj[key] as unknown[];
  }
  return null;
}

function itemText(item: unknown): string {
  if (typeof item === 'string') return item.trim();
  if (item && typeof item === 'object') {
    const obj = item as Record<string, unknown>;
    for (const key of TEXT_KEYS) {
      const value = obj[key];
      if (typeof value === 'string' && value.trim()) return value.trim();
    }
  }
  return '';
}

/**
 * Normalize a tool.call `input` into checklist items, or null when the input is
 * not a (non-empty) checklist. Returns an empty array when the list field is
 * present but empty (an explicit "cleared" signal), distinct from null.
 */
export function normalizeTodoInput(input: unknown): AgentTodoItem[] | null {
  const raw = extractRawItems(input);
  if (!raw) return null;
  const items: AgentTodoItem[] = [];
  for (const entry of raw) {
    const text = itemText(entry);
    if (!text) continue;
    const status = entry && typeof entry === 'object'
      ? normalizeTodoStatus((entry as Record<string, unknown>).status)
      : 'pending';
    items.push({ text, status });
  }
  return items;
}

function isTodoToolCall(event: TimelineEvent): boolean {
  if (event.type !== 'tool.call') return false;
  const payload = event.payload as { tool?: unknown; input?: unknown };
  const name = typeof payload.tool === 'string' ? payload.tool.toLowerCase() : '';
  if (TODO_TOOL_NAMES.has(name)) return true;
  // Shape fallback: any tool.call whose input carries a known checklist array,
  // so agent/tool-name variants still surface without a code change.
  return extractRawItems(payload.input) !== null;
}

/**
 * Derive the current checklist for a session from its ordered timeline events.
 * Scans newest-first and returns the most recent checklist tool.call. A most
 * recent call with an explicitly empty list clears the panel (returns null).
 */
export function deriveLatestTodoList(events: readonly TimelineEvent[]): AgentTodoList | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (!isTodoToolCall(event)) continue;
    const items = normalizeTodoInput((event.payload as { input?: unknown }).input);
    if (items === null) continue;
    if (items.length === 0) return null; // cleared by the latest update
    return { items, eventId: event.eventId, ts: event.ts };
  }
  return null;
}

export function countCompleted(items: readonly AgentTodoItem[]): number {
  return items.reduce((n, item) => (item.status === 'completed' ? n + 1 : n), 0);
}
