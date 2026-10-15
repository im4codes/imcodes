/** @vitest-environment jsdom */
import { act, cleanup, render } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TaskPairStatusPanel } from '../../src/components/TaskPairStatusPanel.js';
import { projectPairScheduling, type TaskPairScheduling } from '@shared/task-pair-suspension.js';
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
type W = Window & { __imcodesTaskPairSnapshot?: unknown };
afterEach(() => { cleanup(); delete (window as W).__imcodesTaskPairSnapshot; window.localStorage.clear(); });
const scheduling: TaskPairScheduling = { epoch: 1, manual: true, dependsOn: [], since: 10, writer: 'brain', note: '待确认' };
const row = (s?: TaskPairScheduling, status = 'working', updatedAt = 20) => ({ taskId: 'paused-task', title: '暂停任务', updatedAt, pair: { status, createdAt: 5, updatedAt, ...(s ? { scheduling: projectPairScheduling(s) } : {}) } });
describe('durable Pair wait presentation', () => {
  it.each([['paused', scheduling], ['waiting_dependencies', { ...scheduling, manual: false, dependsOn: ['upstream'] }], ['resuming', { ...scheduling, manual: false, resumePending: true }]] as const)('shows %s instead of an active-working label', (kind, s) => {
    (window as W).__imcodesTaskPairSnapshot = { tasks: [row(s)] };
    const view = render(<TaskPairStatusPanel events={[]} serverId="source" />);
    expect(view.getAllByText(`taskPair.status.${kind}`).length).toBeGreaterThan(0);
    expect(view.queryByText('taskPair.status.working')).toBeNull();
  });
  it('a fresh snapshot clears the old wait and restores the original stage', () => {
    (window as W).__imcodesTaskPairSnapshot = { tasks: [row(scheduling)] };
    const view = render(<TaskPairStatusPanel events={[]} serverId="source" />);
    act(() => window.dispatchEvent(new CustomEvent('supervision:task-pairs', { detail: { tasks: [row(undefined, 'working', 30)] } })));
    expect(view.getByText('taskPair.status.working')).toBeTruthy(); expect(view.queryByText('taskPair.status.paused')).toBeNull();
  });
  it('terminal lifecycle wins over retained suspension metadata', () => {
    (window as W).__imcodesTaskPairSnapshot = { tasks: [row(scheduling, 'done')] };
    const view = render(<TaskPairStatusPanel events={[]} serverId="source" />);
    expect(view.getByText('taskPair.status.done')).toBeTruthy(); expect(view.queryByText('taskPair.status.paused')).toBeNull();
  });
  it('new browser still shows the dependency wait when an older server removes private brief envelopes', () => {
    const projected = projectPairScheduling({ ...scheduling, manual: false, dependsOn: ['private-upstream'] });
    const old = JSON.parse(JSON.stringify(projected, (key, value) => key === 'brief' ? undefined : value));
    expect(JSON.stringify(old)).not.toContain('private-upstream'); expect(JSON.stringify(old)).not.toContain('待确认');
    (window as W).__imcodesTaskPairSnapshot = { tasks: [{ ...row(), pair: { ...row().pair, scheduling: old } }] };
    const view = render(<TaskPairStatusPanel events={[]} serverId="source" />); expect(view.getAllByText('taskPair.status.waiting_dependencies').length).toBeGreaterThan(0);
  });
});
