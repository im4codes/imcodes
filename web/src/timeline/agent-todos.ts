/**
 * agent-todos — derive a single, current task/todo list from timeline events.
 *
 * CC (TodoWrite), Qwen/Gemini (todo_write / write_todos) and Codex (update_plan)
 * all surface their progress checklist as a `tool.call` timeline event whose
 * `input` carries the list. Each update is a fresh tool.call with the full list,
 * so the LATEST matching event is the current state. This module detects those
 * events by known checklist tool names and normalizes the differing schemas
 * into one shape the UI can render.
 *
 *   TodoWrite   { todos: [{ content, status, activeForm }] }
 *   todo_write  { todos: [{ id, content, status }] }
 *   write_todos { todos: [{ title, status }] }
 *   update_plan { plan:  [{ step, status }] } or [{ content, status }]
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
  'writetodos',
  'update_plan',
  'updateplan',
  'update_todo_list',
  'updatetodolist',
  'set_plan',
  'setplan',
]);

/** Array fields that, when present, identify a checklist payload. */
const LIST_KEYS = ['todos', 'plan', 'tasks', 'steps'] as const;

/** Item fields that may hold the human-readable task text, in priority order. */
const TEXT_KEYS = ['content', 'step', 'text', 'title', 'task', 'description', 'name'] as const;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function eventToolName(event: TimelineEvent): string {
  const payload = asRecord(event.payload);
  const direct = payload && typeof payload.tool === 'string' ? payload.tool : '';
  if (direct) return direct.toLowerCase();
  const detail = asRecord(payload?.detail);
  const summary = detail && typeof detail.summary === 'string' ? detail.summary : '';
  return summary.toLowerCase();
}

function todoInputCandidates(event: TimelineEvent): unknown[] {
  const payload = asRecord(event.payload);
  const detail = asRecord(payload?.detail);
  return [payload?.input, detail?.input].filter((value) => value !== undefined);
}

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
  if (Array.isArray(input)) return input;
  const obj = asRecord(input);
  if (!obj) return null;
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

function todoItemsFromToolCall(event: TimelineEvent): AgentTodoItem[] | null {
  if (event.type !== 'tool.call') return null;
  if (!TODO_TOOL_NAMES.has(eventToolName(event))) return null;
  for (const input of todoInputCandidates(event)) {
    const items = normalizeTodoInput(input);
    if (items !== null) return items;
  }
  return null;
}

/**
 * Array-style checklist (CC TodoWrite, Qwen/Gemini todo_write, Codex/Gemini
 * plan): scan newest-first and return the most recent checklist tool.call. A
 * most recent call with an explicitly empty list clears the panel (null).
 */
function deriveArrayTodoList(events: readonly TimelineEvent[]): AgentTodoList | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    const items = todoItemsFromToolCall(event);
    if (items === null) continue;
    if (items.length === 0) return null; // cleared by the latest update
    return { items, eventId: event.eventId, ts: event.ts };
  }
  return null;
}

// Claude Code (this harness) has no TodoWrite array tool — it tracks tasks with
// per-task TaskCreate + TaskUpdate calls (global ids, status in the result).
// We reconstruct the list by replaying those events.
const TASK_CREATE_RESULT_LINE_RE = /^\s*Task #(\d+) created successfully:\s*(.+?)\s*$/;
// TaskList result lines: "#6 [completed] subject text"
const TASK_LIST_LINE_RE = /^\s*#(\d+)\s+\[([a-z_]+)\]\s+(.+?)\s*$/;

interface TaskAgg { text: string; status: AgentTodoStatus; order: number; deleted: boolean; }

/**
 * Parse a TaskList tool result (full snapshot, one "#id [status] subject" line
 * per task) into ordered tasks, or null when the output isn't a task list.
 * This is the authoritative recent snapshot — preferred over reconstructing
 * from older TaskCreate/TaskUpdate events that may have aged out of the window.
 */
function parseTaskListSnapshot(output: string): Array<{ id: string; text: string; status: AgentTodoStatus }> | null {
  const tasks: Array<{ id: string; text: string; status: AgentTodoStatus }> = [];
  let sawTaskLine = false;
  for (const line of output.split('\n')) {
    if (!line.trim()) continue;
    const match = line.match(TASK_LIST_LINE_RE);
    if (!match) return null;
    sawTaskLine = true;
    if (match[2] === 'deleted') continue;
    tasks.push({ id: match[1], text: match[3].trim(), status: normalizeTodoStatus(match[2]) });
  }
  return sawTaskLine ? tasks : null;
}

function parseTaskCreateResult(output: string): { id: string; text: string } | null {
  const lines = output.split('\n').map((line) => line.trim()).filter(Boolean);
  if (lines.length !== 1) return null;
  const match = lines[0].match(TASK_CREATE_RESULT_LINE_RE);
  if (!match) return null;
  return { id: match[1], text: match[2].trim() };
}

/**
 * Accumulation-style checklist (CC TaskCreate/TaskUpdate). The web reliably has
 * tool.CALL events but NOT always the tool.RESULT, so this reconstructs from
 * calls and enriches with results when present:
 *   - TaskCreate tool.call input { subject } → a task in creation order (the
 *     subject; the real id arrives only in the result).
 *   - TaskCreate tool.result "Task #<id> created successfully: <subject>" →
 *     attaches the real id (and authoritative subject) to that create.
 *   - TaskUpdate tool.call { taskId, status, subject? } → applied by real id
 *     when known, else by creation position (taskId as 1-based index — true for
 *     sessions whose tasks were created fresh), else a stub. status incl. deleted.
 *   - TaskList tool.result snapshot ("#id [status] subject" lines) → an
 *     authoritative rebuild when available.
 */
function deriveTaskToolList(events: readonly TimelineEvent[]): AgentTodoList | null {
  const order: TaskAgg[] = [];                 // tasks in creation order
  const byRealId = new Map<string, TaskAgg>(); // real ids learned from results
  const pendingCreates: TaskAgg[] = [];        // TaskCreate calls awaiting result ids
  let awaitingResult: 'taskcreate' | 'tasklist' | null = null;
  let lastTs = 0;
  let lastEventId = '';
  let touched = false;

  const mark = (event: TimelineEvent): void => { touched = true; lastTs = event.ts; lastEventId = event.eventId; };

  for (const event of events) {
    if (event.type === 'tool.call') {
      const payload = asRecord(event.payload);
      const name = eventToolName(event);
      const input = asRecord(payload?.input) ?? {};
      if (name === 'taskcreate') {
        const subject = ['subject', 'content', 'title', 'task', 'description']
          .map((k) => (typeof input[k] === 'string' ? (input[k] as string).trim() : ''))
          .find(Boolean) ?? '';
        if (!subject) continue;
        const task: TaskAgg = { text: subject, status: 'pending', order: order.length, deleted: false };
        order.push(task);
        pendingCreates.push(task);
        awaitingResult = 'taskcreate';
        mark(event);
      } else if (name === 'tasklist') {
        awaitingResult = 'tasklist';
      } else if (name === 'taskupdate') {
        awaitingResult = null;
        const id = input.taskId != null ? String(input.taskId) : '';
        if (!id) continue;
        const subject = typeof input.subject === 'string' ? input.subject.trim() : '';
        let task = byRealId.get(id);
        if (!task) {
          const pos = parseInt(id, 10); // fallback: taskId as 1-based creation index
          if (Number.isFinite(pos) && pos >= 1 && pos <= order.length) task = order[pos - 1];
        }
        if (!task) {
          task = { text: subject || `Task #${id}`, status: 'pending', order: order.length, deleted: false };
          order.push(task);
          byRealId.set(id, task);
        }
        if (subject) task.text = subject;
        if (input.status === 'deleted') task.deleted = true;
        else if (typeof input.status === 'string') task.status = normalizeTodoStatus(input.status);
        mark(event);
      } else {
        awaitingResult = null;
      }
    } else if (event.type === 'tool.result') {
      const payload = asRecord(event.payload);
      const output = payload?.output;
      const resultName = eventToolName(event);
      const expectedResult = awaitingResult;
      awaitingResult = null;
      if (typeof output !== 'string') continue;
      const snapshot = parseTaskListSnapshot(output);
      if (snapshot && (expectedResult === 'tasklist' || resultName === 'tasklist')) {
        order.length = 0;
        byRealId.clear();
        pendingCreates.length = 0;
        for (const task of snapshot) {
          const agg: TaskAgg = { text: task.text, status: task.status, order: order.length, deleted: false };
          order.push(agg);
          byRealId.set(task.id, agg);
        }
        mark(event);
        continue;
      }
      const createResult = expectedResult === 'taskcreate' || resultName === 'taskcreate'
        ? parseTaskCreateResult(output)
        : null;
      if (!createResult) continue;
      const { id, text } = createResult;
      if (byRealId.has(id)) { mark(event); continue; }
      const task = pendingCreates.shift();
      if (task && text) task.text = text;
      if (task) byRealId.set(id, task);
      awaitingResult = pendingCreates.length > 0 ? 'taskcreate' : null;
      mark(event);
    }
  }

  if (!touched) return null;
  const items = order
    .filter((task) => !task.deleted && task.text)
    .map((task) => ({ text: task.text, status: task.status }));
  return items.length > 0 ? { items, eventId: lastEventId, ts: lastTs } : null;
}

/**
 * Derive the current checklist for a session, supporting both the array-style
 * tools and CC's TaskCreate/TaskUpdate model. When both are present (rare), the
 * one with the more recent activity wins.
 */
export function deriveLatestTodoList(events: readonly TimelineEvent[]): AgentTodoList | null {
  const arrayList = deriveArrayTodoList(events);
  const taskList = deriveTaskToolList(events);
  if (arrayList && taskList) return taskList.ts > arrayList.ts ? taskList : arrayList;
  return arrayList ?? taskList;
}

export function countCompleted(items: readonly AgentTodoItem[]): number {
  return items.reduce((n, item) => (item.status === 'completed' ? n + 1 : n), 0);
}
