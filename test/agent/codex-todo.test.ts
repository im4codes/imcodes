import { describe, expect, it } from 'vitest';
import { toolFromItem } from '../../src/agent/providers/codex-sdk.js';

describe('codex-sdk toolFromItem — todo_list', () => {
  const item = {
    id: 'todo-1',
    type: 'todo_list',
    items: [
      { text: '梳理登录需求', completed: true },
      { text: '实现登录表单', completed: false },
      { text: '接入认证接口', completed: false },
    ],
  };

  it('maps a completed todo_list item to an update_plan checklist tool.call', () => {
    const tool = toolFromItem('codex-sess', item, 'completed');
    expect(tool).not.toBeNull();
    expect(tool!.name).toBe('update_plan');
    expect(tool!.status).toBe('complete');
    expect(tool!.input).toEqual({
      plan: [
        { content: '梳理登录需求', status: 'completed' },
        { content: '实现登录表单', status: 'pending' },
        { content: '接入认证接口', status: 'pending' },
      ],
    });
  });

  it('emits a running tool.call on the started lifecycle (so the relay tracks it)', () => {
    const tool = toolFromItem('codex-sess', item, 'started');
    expect(tool!.status).toBe('running');
    expect(tool!.id).toBe('todo-1');
  });

  it('drops items without text', () => {
    const tool = toolFromItem('codex-sess', { id: 't', type: 'todo_list', items: [{ completed: true }, { text: 'real', completed: false }] }, 'completed');
    expect(tool!.input).toEqual({ plan: [{ content: 'real', status: 'pending' }] });
  });
});
