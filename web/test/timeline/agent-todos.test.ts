import { describe, expect, it } from 'vitest';
import type { TimelineEvent } from '../../src/ws-client.js';
import {
  deriveLatestTodoList,
  normalizeTodoInput,
  normalizeTodoStatus,
  countCompleted,
} from '../../src/timeline/agent-todos.js';

let seq = 0;
function toolCall(input: unknown, tool = 'TodoWrite', overrides: Partial<TimelineEvent> = {}): TimelineEvent {
  seq += 1;
  return {
    eventId: `e${seq}`,
    sessionId: 'deck_main_brain',
    ts: 1000 + seq,
    seq,
    epoch: 1,
    source: 'daemon',
    confidence: 'high',
    type: 'tool.call',
    payload: { tool, input },
    ...overrides,
  };
}

function toolResult(output: string, overrides: Partial<TimelineEvent> = {}): TimelineEvent {
  seq += 1;
  return {
    eventId: `e${seq}`,
    sessionId: 'deck_main_brain',
    ts: 1000 + seq,
    seq,
    epoch: 1,
    source: 'daemon',
    confidence: 'high',
    type: 'tool.result',
    payload: { output },
    ...overrides,
  };
}

const TODOWRITE = [
  { content: 'Analyze requirements', status: 'completed', activeForm: 'Analyzing' },
  { content: 'Design schema', status: 'in_progress', activeForm: 'Designing' },
  { content: 'Build UI', status: 'pending' },
];

describe('normalizeTodoStatus', () => {
  it('maps synonyms and casing/separators to the three canonical states', () => {
    expect(normalizeTodoStatus('in_progress')).toBe('in_progress');
    expect(normalizeTodoStatus('in-progress')).toBe('in_progress');
    expect(normalizeTodoStatus('In Progress')).toBe('in_progress');
    expect(normalizeTodoStatus('active')).toBe('in_progress');
    expect(normalizeTodoStatus('done')).toBe('completed');
    expect(normalizeTodoStatus('COMPLETE')).toBe('completed');
    expect(normalizeTodoStatus('pending')).toBe('pending');
    expect(normalizeTodoStatus(undefined)).toBe('pending');
    expect(normalizeTodoStatus('weird')).toBe('pending');
  });
});

describe('normalizeTodoInput', () => {
  it('normalizes CC TodoWrite ({todos:[{content,status}]})', () => {
    expect(normalizeTodoInput({ todos: TODOWRITE })).toEqual([
      { text: 'Analyze requirements', status: 'completed' },
      { text: 'Design schema', status: 'in_progress' },
      { text: 'Build UI', status: 'pending' },
    ]);
  });

  it('normalizes Qwen/Gemini todo_write ({todos:[{id,content|title,status}]})', () => {
    const items = normalizeTodoInput({
      todos: [
        { id: '1', content: 'A', status: 'completed' },
        { id: '2', title: 'B', status: 'in_progress' },
      ],
    });
    expect(items).toEqual([
      { text: 'A', status: 'completed' },
      { text: 'B', status: 'in_progress' },
    ]);
  });

  it('normalizes Codex update_plan ({plan:[{step,status}]})', () => {
    expect(normalizeTodoInput({ plan: [{ step: 'Write tests', status: 'pending' }] })).toEqual([
      { text: 'Write tests', status: 'pending' },
    ]);
  });

  it('returns null for non-checklist input and empty array for a cleared list', () => {
    expect(normalizeTodoInput({ file_path: '/x', content: 'hi' })).toBeNull();
    expect(normalizeTodoInput(undefined)).toBeNull();
    expect(normalizeTodoInput('nope')).toBeNull();
    expect(normalizeTodoInput({ todos: [] })).toEqual([]);
  });

  it('drops items without any usable text', () => {
    expect(normalizeTodoInput({ todos: [{ status: 'pending' }, { content: 'real', status: 'pending' }] })).toEqual([
      { text: 'real', status: 'pending' },
    ]);
  });
});

describe('deriveLatestTodoList', () => {
  it('returns the most recent checklist tool.call', () => {
    const events = [
      toolCall({ todos: [{ content: 'old', status: 'pending' }] }),
      toolCall({ command: 'ls' }, 'Bash'),
      toolCall({ todos: TODOWRITE }),
    ];
    const list = deriveLatestTodoList(events);
    expect(list?.items).toHaveLength(3);
    expect(list?.items[0]).toEqual({ text: 'Analyze requirements', status: 'completed' });
    expect(list?.eventId).toBe(events[2].eventId);
  });

  it('detects update_plan by name and by input shape', () => {
    const byName = deriveLatestTodoList([toolCall({ plan: [{ step: 'X', status: 'pending' }] }, 'update_plan')]);
    expect(byName?.items).toEqual([{ text: 'X', status: 'pending' }]);
    // unknown tool name but checklist-shaped input still surfaces
    const byShape = deriveLatestTodoList([toolCall({ todos: [{ content: 'Y', status: 'done' }] }, 'mystery_tool')]);
    expect(byShape?.items).toEqual([{ text: 'Y', status: 'completed' }]);
  });

  it('ignores unrelated tool.calls and non-tool events', () => {
    expect(deriveLatestTodoList([
      toolCall({ command: 'ls' }, 'Bash'),
      toolCall({ file_path: '/a', content: 'x' }, 'Write'),
    ])).toBeNull();
  });

  it('treats the latest empty list as a clear (returns null)', () => {
    const list = deriveLatestTodoList([
      toolCall({ todos: TODOWRITE }),
      toolCall({ todos: [] }),
    ]);
    expect(list).toBeNull();
  });

  it('returns null for an empty timeline', () => {
    expect(deriveLatestTodoList([])).toBeNull();
  });
});

describe('deriveLatestTodoList — CC TaskCreate/TaskUpdate', () => {
  it('aggregates TaskCreate results + TaskUpdate into a checklist (creation order)', () => {
    const events = [
      toolResult('Task #6 created successfully: Analyze requirements'),
      toolResult('Task #7 created successfully: Design schema'),
      toolResult('Task #8 created successfully: Build UI'),
      toolCall({ taskId: '6', status: 'completed' }, 'TaskUpdate'),
      toolCall({ taskId: '7', status: 'in_progress' }, 'TaskUpdate'),
    ];
    expect(deriveLatestTodoList(events)?.items).toEqual([
      { text: 'Analyze requirements', status: 'completed' },
      { text: 'Design schema', status: 'in_progress' },
      { text: 'Build UI', status: 'pending' },
    ]);
  });

  it('removes a task on TaskUpdate status=deleted', () => {
    const events = [
      toolResult('Task #1 created successfully: A'),
      toolResult('Task #2 created successfully: B'),
      toolCall({ taskId: '1', status: 'deleted' }, 'TaskUpdate'),
    ];
    expect(deriveLatestTodoList(events)?.items).toEqual([{ text: 'B', status: 'pending' }]);
  });

  it('applies a TaskUpdate subject rename', () => {
    const events = [
      toolResult('Task #3 created successfully: old name'),
      toolCall({ taskId: '3', status: 'in_progress', subject: 'new name' }, 'TaskUpdate'),
    ];
    expect(deriveLatestTodoList(events)?.items).toEqual([{ text: 'new name', status: 'in_progress' }]);
  });

  it('ignores unrelated tool.result output', () => {
    expect(deriveLatestTodoList([toolResult('ran 3 tests, all passed')])).toBeNull();
  });

  it('renders a TaskList snapshot result (authoritative; survives aged-out creates)', () => {
    const events = [
      toolResult('Task #1 created successfully: stale create that aged out'),
      toolResult('#1 [completed] 设计登录数据库表\n#2 [in_progress] 实现登录 API\n#3 [pending] 实现前端页面'),
    ];
    expect(deriveLatestTodoList(events)?.items).toEqual([
      { text: '设计登录数据库表', status: 'completed' },
      { text: '实现登录 API', status: 'in_progress' },
      { text: '实现前端页面', status: 'pending' },
    ]);
  });

  it('excludes deleted tasks from a TaskList snapshot', () => {
    const events = [toolResult('#1 [completed] A\n#2 [deleted] B\n#3 [pending] C')];
    expect(deriveLatestTodoList(events)?.items).toEqual([
      { text: 'A', status: 'completed' },
      { text: 'C', status: 'pending' },
    ]);
  });

  it('builds the list from tool.call only when tool.result never reaches the web', () => {
    // The web reliably gets tool.call but not always tool.result, so TaskCreate
    // subjects must come from the call input and TaskUpdate links by position.
    const events = [
      toolCall({ subject: '设计数据库' }, 'TaskCreate'),
      toolCall({ subject: '后端 API' }, 'TaskCreate'),
      toolCall({ subject: '前端页面' }, 'TaskCreate'),
      toolCall({ subject: '测试' }, 'TaskCreate'),
      toolCall({ taskId: '1', status: 'completed' }, 'TaskUpdate'),
      toolCall({ taskId: '2', status: 'in_progress' }, 'TaskUpdate'),
    ];
    expect(deriveLatestTodoList(events)?.items).toEqual([
      { text: '设计数据库', status: 'completed' },
      { text: '后端 API', status: 'in_progress' },
      { text: '前端页面', status: 'pending' },
      { text: '测试', status: 'pending' },
    ]);
  });

  it('does not duplicate a task when both the create call and its result are present', () => {
    const events = [
      toolCall({ subject: 'A' }, 'TaskCreate'),
      toolCall({ subject: 'B' }, 'TaskCreate'),
      toolResult('Task #1 created successfully: A'),
      toolResult('Task #2 created successfully: B'),
      toolCall({ taskId: '1', status: 'completed' }, 'TaskUpdate'),
    ];
    expect(deriveLatestTodoList(events)?.items).toEqual([
      { text: 'A', status: 'completed' },
      { text: 'B', status: 'pending' },
    ]);
  });

  it('applies a TaskUpdate after a TaskList snapshot', () => {
    const events = [
      toolResult('#1 [pending] A\n#2 [pending] B'),
      toolCall({ taskId: '2', status: 'completed' }, 'TaskUpdate'),
    ];
    expect(deriveLatestTodoList(events)?.items).toEqual([
      { text: 'A', status: 'pending' },
      { text: 'B', status: 'completed' },
    ]);
  });
});

describe('countCompleted', () => {
  it('counts completed items', () => {
    expect(countCompleted(normalizeTodoInput({ todos: TODOWRITE }) ?? [])).toBe(1);
  });
});
