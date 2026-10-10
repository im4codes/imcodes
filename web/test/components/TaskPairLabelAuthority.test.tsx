/** @vitest-environment jsdom */
import { cleanup, fireEvent, render } from '@testing-library/preact';
import { afterEach, expect, it, vi } from 'vitest';
import { TaskPairStatusPanel } from '../../src/components/TaskPairStatusPanel.js';
import { TaskPairEventChip } from '../../src/components/TaskPairEventChip.js';
import { watchProjectionStore } from '../../src/watch-projection.js';
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
const id = 'deck_sub_current';
const payload = { taskId: 'current-task', title: 'Current task', toStatus: 'working', executor: id, executorLabel: 'Current payload label' };
const events = [{ eventId: 'current', type: 'task_pair.event', ts: Date.now(), payload }] as never;
afterEach(() => { cleanup(); watchProjectionStore.setSnapshotStatus('switching'); window.localStorage.clear(); });
it('does not replace an explicit payload label with a stale or other-server watch fallback', () => {
  watchProjectionStore.updateFromSessionList(
    { id: 'other-server', name: 'Other', baseUrl: 'http://test' },
    [{ name: id, project: 'p', role: 'w1', agentType: 'codex', state: 'running', label: 'Older cached label' }],
  );
  watchProjectionStore.setSnapshotStatus('stale');
  const { container } = render(<TaskPairStatusPanel events={events} />);
  expect(container.querySelector('.task-pair-status-session-label')?.textContent).toBe('Current payload label');
});
it.each(['', null])('does not revive a historical panel label when the current label is explicitly cleared: %s', (label) => {
  const { container } = render(<TaskPairStatusPanel events={events} sessions={[{ name: id, label }] as never} />);
  const role = container.querySelector('.task-pair-status-row-roles')!;
  expect(role.textContent).not.toContain('Current payload label');
  expect(role.textContent).toContain(id);
});
it.each(['', null])('does not revive a historical event label or diagnostic name when explicitly cleared: %s', (label) => {
  const { container } = render(<TaskPairEventChip eventId="current" payload={payload} sessions={[{ name: id, label }]} />);
  fireEvent.click(container.querySelector('.task-pair-card-toggle')!);
  expect(container.querySelector('.task-pair-card-role')?.textContent).not.toContain('Current payload label');
  expect(container.querySelector('.task-pair-card-payload pre')?.textContent).not.toContain('Current payload label');
  expect(container.querySelector('.task-pair-card-role')?.textContent).toContain(id);
});
it('retains the payload fallback for old peers that omit the label field', () => {
  const { container } = render(<TaskPairStatusPanel events={events} sessions={[{ name: id }]} />);
  expect(container.querySelector('.task-pair-status-session-label')?.textContent).toBe('Current payload label');
});
