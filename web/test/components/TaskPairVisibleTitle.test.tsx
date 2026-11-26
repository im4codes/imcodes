/** @vitest-environment jsdom */
import { act, cleanup, render } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TASK_PAIR_TIMELINE_EVENT } from '@shared/task-pair.js';
import { TaskPairStatusPanel } from '../../src/components/TaskPairStatusPanel.js';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

type SnapshotWindow = Window & { __imcodesTaskPairSnapshot?: unknown };
afterEach(() => {
  cleanup();
  delete (window as SnapshotWindow).__imcodesTaskPairSnapshot;
  window.localStorage.clear();
});

describe('admitted shared task names need no browser-side title grant', () => {
  it('renders legacy names in the task bar and accepts a title-only snapshot update', () => {
    const tasks = [
      { taskId: 'legacy-release', title: '测试站升级1.18.15与上线验收', updatedAt: 20, pair: { status: 'working', createdAt: 10, updatedAt: 20 } },
      { taskId: 'legacy-bi', title: '主站BI发布准备', updatedAt: 20, pair: { status: 'working', createdAt: 10, updatedAt: 20 } },
    ];
    (window as SnapshotWindow).__imcodesTaskPairSnapshot = { tasks };
    const view = render(<TaskPairStatusPanel events={[]} serverId="shared-source" />);
    for (const task of tasks) expect(view.getByText(task.title)).toBeTruthy();
    expect(view.queryByText('taskPair.panel_untitled')).toBeNull();
    act(() => window.dispatchEvent(new CustomEvent('supervision:task-pairs', {
      detail: { tasks: tasks.map((task) => ({ ...task, title: `${task.title}（更新）`, updatedAt: 21, pair: { ...task.pair, updatedAt: 21 } })) },
    })));
    for (const task of tasks) {
      expect(view.getByText(`${task.title}（更新）`)).toBeTruthy();
      expect(view.queryByText(task.title)).toBeNull();
    }
  });

  it('renders admitted timeline names before a console snapshot arrives', () => {
    const title = '迁移补齐测试站商城发布权限';
    const events = [{ eventId: 'legacy-event', type: TASK_PAIR_TIMELINE_EVENT, ts: 20, payload: { taskId: 'legacy-migration', title, toStatus: 'working' } }] as never[];
    const view = render(<TaskPairStatusPanel events={events} serverId="shared-source" />);
    expect(view.getByText(title)).toBeTruthy();
  });
});
