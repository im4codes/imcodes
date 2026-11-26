import { describe, it, expect } from 'vitest';
import { toolFromItem } from '../../src/agent/providers/codex-sdk.js';

/**
 * Regression: newer Codex drives shell/JS work through a CUSTOM tool (the
 * unified `exec` tool, rollout `custom_tool_call{name:"exec",input,call_id}`),
 * not the classic `commandExecution` item. That item type hit toolFromItem's
 * `default: return null` and was silently dropped, so a turn doing all its work
 * via `exec` produced NO tool cards in the UI ("Agent working" with no updates)
 * even while it was genuinely editing files. toolFromItem must now surface it.
 */
describe('codex-sdk toolFromItem — custom tools (exec)', () => {
  // Real shape observed in the rollout / app-server item.
  const execStarted = {
    id: 'item-1',
    type: 'custom_tool_call',
    status: 'inProgress',
    call_id: 'call_51OQGJ7uM0PMQrl9Slueevwa',
    name: 'exec',
    input: 'const r = await tools.write_stdin({session_id:88588, chars:""});',
  };

  it('surfaces a running exec custom tool card on item/started', () => {
    const tool = toolFromItem('codex-sess', execStarted, 'started');
    expect(tool).not.toBeNull();
    expect(tool).toMatchObject({
      id: 'call_51OQGJ7uM0PMQrl9Slueevwa',
      name: 'exec',
      status: 'running',
      input: { command: execStarted.input },
    });
    expect(tool?.detail?.kind).toBe('customToolCall');
  });

  it('surfaces a completed exec card (same id, with output) on item/completed', () => {
    const done = { ...execStarted, status: 'completed', output: 'session 88588 ready' };
    const tool = toolFromItem('codex-sess', done, 'completed');
    expect(tool).toMatchObject({
      id: 'call_51OQGJ7uM0PMQrl9Slueevwa',
      name: 'exec',
      status: 'complete',
      output: 'session 88588 ready',
    });
  });

  it('marks failed status as error', () => {
    const failed = { ...execStarted, status: 'failed', output: 'boom' };
    expect(toolFromItem('codex-sess', failed, 'completed')?.status).toBe('error');
  });

  it('also catches a not-yet-enumerated custom tool type via the tool-shaped fallback', () => {
    const unknown = { id: 'x1', type: 'someFutureToolCall', name: 'weird_tool', call_id: 'c1', arguments: { a: 1 }, status: 'inProgress' };
    const tool = toolFromItem('codex-sess', unknown, 'started');
    expect(tool).toMatchObject({ id: 'c1', name: 'weird_tool', status: 'running', input: { a: 1 } });
  });

  it('does NOT fabricate a tool card for non-tool items (no name / no call payload)', () => {
    // agentMessage-like item (has text, no name/call payload) → handled elsewhere, null here.
    expect(toolFromItem('codex-sess', { id: 'm1', type: 'agentMessage', text: 'hi' }, 'completed')).toBeNull();
    // token-count-like structural item → not a tool.
    expect(toolFromItem('codex-sess', { id: 'tc', type: 'tokenCount', total: 5 }, 'started')).toBeNull();
    // A name but no call payload → not a tool call.
    expect(toolFromItem('codex-sess', { id: 'n', type: 'whatever', name: 'nope' }, 'started')).toBeNull();
  });
});
